// ============================================================
//  teams.ts  -  a equipe do jogo, do lado do agente.
//
//  ####  ELE NÃO GUARDA EQUIPE  ####
//
//  Toda leitura pergunta ao jogo, pelo RCON, e casa a resposta com
//  os cargos do banco. É mais caro que um cache e é a única coisa
//  honesta: a equipe muda no jogo a cada convite aceito, e um cache
//  aqui mostraria no painel uma equipe que não existe mais.
//
//  O que ele guarda é o CARGO, que o Rust não tem — e só isso.
//
//  ####  O QUE ELE ESCUTA  ####
//
//  `#OZTEAM#{…}` no console. Dois eventos mexem no banco:
//
//    disbanded   apaga os cargos daquela equipe (regra do dono)
//    left/kicked apaga o cargo de quem saiu
//
//  Os outros são informativos: o painel relê quando quiser.
//
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO  ####
//
//  A lição medida do `agent-requests.ts`: um comando mandado de
//  dentro do `onConsoleLine` imprime no console, a linha volta pelo
//  mesmo caminho e dispara de novo. Aqui o `handleLine` só grava e,
//  no caso do `ready`, ARMA um relógio — o envio sai dele.
//
//  Ver Docs/OrigemZTeam/00-LEVANTAMENTO.md.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { TeamRanksRepository } from '../db/team-ranks-repository.js';
import type { Logger } from '../logger.js';
import {
  TEAM_RANK_WEIGHT,
  type GameTeam,
  type GrantableRank,
  type Team,
  type TeamMember,
  type TeamPush,
  type TeamRank,
  type TeamsSnapshot,
} from '../types/teams.js';
import { toError } from '../util.js';

/** O marcador do aviso. O mesmo `Marker` do OrigemZTeam.cs. */
export const TEAM_MARKER = '#OZTEAM#';

/**
 * A âncora da linha.
 *
 * O marcador tem de estar no COMEÇO, depois de no máximo dois
 * prefixos entre colchetes (`[OrigemZ Team] `). A linha de chat traz
 * o nome de quem falou antes do texto e não passa — é a mesma
 * defesa do `stat-events.ts`, e ela vem ANTES da conferência do
 * segredo porque é a que custa nada.
 */
/** Quebra de linha do console, nos dois sabores. */
const SPLIT_LINES = /\r?\n/;

const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZTEAM#/;

export interface TeamsRcon {
  readonly isConnected: boolean;
  send: (command: string) => Promise<string>;
}

export interface TeamsServers {
  readonly ids: () => readonly string[];
  readonly contextOf: (serverId: string) => { readonly rcon: TeamsRcon } | null;
}

export interface TeamsDeps {
  readonly ranks: TeamRanksRepository;
  readonly servers: TeamsServers;
  readonly logger: Logger;
}

/** O que o comando do plugin devolveu, quando deu errado. */
export class TeamCommandError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'TeamCommandError';
    this.reason = reason;
  }
}

export class TeamsService {
  readonly #deps: TeamsDeps;
  /** O segredo desta sessão, como no OrigemZDungeon. */
  readonly #secret = randomUUID();
  #stopped = false;

  constructor(deps: TeamsDeps) {
    this.#deps = deps;
  }

  stop(): void {
    this.#stopped = true;
  }

  // ------------------------------------------------------------
  //  §1  PERGUNTAR
  // ------------------------------------------------------------

  /**
   * Todas as equipes daquele servidor, com os cargos colados.
   *
   * ####  A VARREDURA ACONTECE AQUI  ####
   *
   * Esta é a única leitura que vê a lista COMPLETA de equipes — e
   * por isso é a única que pode apagar cargo órfão com segurança.
   * Ver `forgetMissing`: com uma lista parcial ele apagaria cargo de
   * equipe viva.
   */
  async snapshot(serverId: string): Promise<TeamsSnapshot> {
    const reply = await this.#command(serverId, 'origemz.team list');
    const maxSize = typeof reply['maxSize'] === 'number' ? reply['maxSize'] : 0;
    const raw = Array.isArray(reply['teams']) ? (reply['teams'] as GameTeam[]) : [];

    const teams = raw.map((team) => this.#withRanks(serverId, team));

    const removed = this.#deps.ranks.forgetMissing(
      serverId,
      raw.map((team) => team.teamId),
    );

    if (removed > 0) {
      this.#deps.logger.info(
        { server: serverId, removed },
        'cargos de equipes que não existem mais foram apagados',
      );
    }

    return { serverId, maxSize, teams, readAt: Date.now() };
  }

  /** Uma equipe, pelo id dela ou pelo SteamID de quem está dentro. */
  async team(serverId: string, key: string): Promise<Team | null> {
    const reply = await this.#command(serverId, `origemz.team get ${key}`, {
      allow: ['not_found'],
    });

    if (reply['ok'] !== true) return null;

    return this.#withRanks(serverId, reply['team'] as GameTeam);
  }

  /**
   * A equipe de um jogador, ou `null`.
   *
   * É a pergunta da ficha do jogador, e ela tem uma resposta a mais
   * que as outras: com o servidor PARADO, não há a quem perguntar —
   * e aí ela lança, em vez de dizer "sem equipe". Dizer que alguém
   * não tem equipe porque o servidor caiu seria mentir com cara de
   * dado.
   */
  async teamOf(serverId: string, steamId: string): Promise<Team | null> {
    return this.team(serverId, steamId);
  }

  // ------------------------------------------------------------
  //  §2  MANDAR
  // ------------------------------------------------------------

  async rename(serverId: string, teamId: string, name: string): Promise<Team> {
    const reply = await this.#command(serverId, `origemz.team rename ${teamId} ${name}`);

    return this.#withRanks(serverId, reply['team'] as GameTeam);
  }

  /**
   * Tira alguém da equipe.
   *
   * O cargo dele some junto, e não por arrumação: quem sai e volta
   * volta como membro. Se ele era o ÚLTIMO, o jogo desfaz a equipe
   * sozinho e o `OnTeamDisbanded` limpa o resto.
   */
  async kick(serverId: string, teamId: string, steamId: string): Promise<Team | null> {
    const reply = await this.#command(serverId, `origemz.team kick ${teamId} ${steamId}`);

    this.#deps.ranks.clear(serverId, teamId, steamId);

    if (reply['disbanded'] === true) {
      this.#deps.ranks.forgetTeam(serverId, teamId);
      return null;
    }

    return this.#withRanks(serverId, reply['team'] as GameTeam);
  }

  /**
   * Passa a liderança.
   *
   * O cargo do novo líder é apagado: ele virou líder, e liderança é
   * do JOGO. Deixar um `officer` gravado embaixo faria a tela
   * mostrar dois cargos para a mesma pessoa no dia em que ela
   * passasse a liderança adiante.
   */
  async setLeader(serverId: string, teamId: string, steamId: string): Promise<Team> {
    const reply = await this.#command(serverId, `origemz.team leader ${teamId} ${steamId}`);

    this.#deps.ranks.clear(serverId, teamId, steamId);

    return this.#withRanks(serverId, reply['team'] as GameTeam);
  }

  async disband(serverId: string, teamId: string): Promise<void> {
    await this.#command(serverId, `origemz.team disband ${teamId}`);

    // O hook faria isso sozinho; fazer aqui também é barato e cobre
    // o caso em que o aviso se perde (o console entupido, o RCON
    // caindo no meio). Apagar duas vezes não custa nada.
    this.#deps.ranks.forgetTeam(serverId, teamId);
  }

  /**
   * Promove ou rebaixa.
   *
   * Recusa promover quem não está na equipe, e recusa mexer no
   * líder: o cargo dele não é nosso. As duas recusas moram AQUI, e
   * não na rota, porque quem chama pode ser a tela do jogo amanhã.
   */
  async setRank(input: {
    readonly serverId: string;
    readonly teamId: string;
    readonly steamId: string;
    readonly rank: GrantableRank;
    readonly grantedBy?: string;
  }): Promise<Team> {
    const team = await this.team(input.serverId, input.teamId);

    if (team === null) throw new TeamCommandError('not_found', 'Essa equipe não existe mais.');

    const member = team.members.find((entry) => entry.steamId === input.steamId);

    if (member === undefined) {
      throw new TeamCommandError('not_a_member', 'Esse jogador não está na equipe.');
    }

    if (member.leader) {
      throw new TeamCommandError(
        'is_leader',
        'O líder não tem cargo: a liderança é do jogo. Passe a liderança primeiro.',
      );
    }

    this.#deps.ranks.set(input);

    return this.#withRanks(input.serverId, this.#strip(team));
  }

  // ------------------------------------------------------------
  //  §3  ESCUTAR
  // ------------------------------------------------------------

  /**
   * Uma linha do console.
   *
   * Recusa em UMA comparação de string a linha que não é nossa — e
   * "não é nossa" é a maioria absoluta das que passam por aqui.
   */
  handleLine(serverId: string, line: string): void {
    if (this.#stopped || !line.includes(TEAM_MARKER)) return;

    try {
      this.#handle(serverId, line);
    } catch (cause) {
      // Nada aqui pode lançar: uma exceção levaria o resto do stream
      // junto. Mesma regra do dungeon-sync.
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'linha do OrigemZTeam não pôde ser tratada',
      );
    }
  }

  #handle(serverId: string, line: string): void {
    if (!PLUGIN_LINE.test(line.trimStart())) return;

    const start = line.indexOf(TEAM_MARKER) + TEAM_MARKER.length;
    const body = line.slice(start).trim();

    if (body === '') return;

    const parsed: unknown = JSON.parse(body);

    if (typeof parsed !== 'object' || parsed === null) return;

    const push = parsed as TeamPush & { readonly secret?: string };

    // O `ready` é o único sem segredo — é justamente ele que o
    // plugin ainda não tem.
    if (push.kind === 'ready') {
      this.#deps.logger.info({ server: serverId }, 'o OrigemZTeam subiu e pediu o segredo');
      void this.#syncSoon(serverId);
      return;
    }

    if (push.secret !== this.#secret) {
      this.#deps.logger.warn(
        { server: serverId, kind: push.kind },
        'aviso de equipe com segredo errado: ignorado',
      );

      return;
    }

    this.#apply(serverId, push);
  }

  #apply(serverId: string, push: TeamPush): void {
    switch (push.kind) {
      case 'disbanded': {
        if (push.teamId === undefined) return;

        const removed = this.#deps.ranks.forgetTeam(serverId, push.teamId);

        this.#deps.logger.info(
          { server: serverId, team: push.teamId, removed },
          'equipe desfeita: os cargos dela foram apagados',
        );

        return;
      }

      case 'left':
      case 'kicked': {
        if (push.teamId === undefined || push.steamId === undefined) return;

        this.#deps.ranks.clear(serverId, push.teamId, push.steamId);

        return;
      }

      case 'leader': {
        // Quem virou líder não guarda cargo nosso embaixo.
        if (push.teamId === undefined || push.steamId === undefined) return;

        this.#deps.ranks.clear(serverId, push.teamId, push.steamId);

        return;
      }

      default:
        // created / joined / renamed: o painel relê quando quiser.
        return;
    }
  }

  /**
   * Manda o segredo ao plugin.
   *
   * Fora do gancho, sempre — ver o cabeçalho. O atraso de um segundo
   * é o mesmo do dungeon-sync: dá margem para o plugin terminar de
   * carregar antes de receber o estado.
   */
  async sync(serverId: string): Promise<void> {
    if (this.#stopped) return;

    try {
      await this.#command(serverId, `origemz.team sync {"secret":"${this.#secret}"}`);

      this.#deps.logger.info({ server: serverId }, 'o OrigemZTeam recebeu o segredo');
    } catch (cause) {
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'não consegui sincronizar o OrigemZTeam',
      );
    }
  }

  #syncSoon(serverId: string): void {
    setTimeout(() => {
      void this.sync(serverId);
    }, 1000).unref();
  }

  // ------------------------------------------------------------
  //  §4  FERRAMENTA
  // ------------------------------------------------------------

  /**
   * Um comando, e a resposta CASADA.
   *
   * O `Reply` do Covalence volta no POST do RCON e some do buffer —
   * procurá-lo no console faria o comando parecer mudo. Medido neste
   * projeto, e é por isso que o retorno daqui é o corpo do comando,
   * e não uma promessa de que ele saiu.
   */
  async #command(
    serverId: string,
    command: string,
    options: { readonly allow?: readonly string[] } = {},
  ): Promise<Record<string, unknown>> {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      throw new TeamCommandError('offline', 'O servidor não está com o RCON de pé.');
    }

    const reply = await context.rcon.send(command);
    const body = cleanReply(reply);

    if (body === '') {
      // O comando não existe, ou o plugin não está carregado. O
      // sintoma é o mesmo, e a causa costuma ser a segunda.
      throw new TeamCommandError(
        'no_plugin',
        'O servidor não respondeu: o OrigemZTeam pode não estar carregado.',
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TeamCommandError('bad_reply', `O plugin respondeu algo que não é JSON: ${body}`);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new TeamCommandError('bad_reply', 'O plugin respondeu um JSON que não é objeto.');
    }

    const payload = parsed as Record<string, unknown>;

    if (payload['ok'] !== true) {
      const reason = typeof payload['error'] === 'string' ? payload['error'] : 'unknown';

      if (options.allow?.includes(reason) === true) return payload;

      const message =
        typeof payload['message'] === 'string' ? payload['message'] : 'O plugin recusou.';

      throw new TeamCommandError(reason, message);
    }

    return payload;
  }

  /** Cola os cargos do banco na equipe que o jogo respondeu. */
  #withRanks(serverId: string, game: GameTeam): Team {
    const stored = new Map(
      this.#deps.ranks.ofTeam(serverId, game.teamId).map((row) => [row.steamId, row.rank]),
    );

    const members: TeamMember[] = game.members.map((member) => ({
      ...member,
      rank: rankOf(member, stored.get(member.steamId)),
    }));

    // Líder primeiro, oficial depois, e o resto por nome — a ordem
    // que a tela mostra, feita aqui para não ser refeita em cada uma.
    members.sort((left, right) => {
      const weight = TEAM_RANK_WEIGHT[right.rank] - TEAM_RANK_WEIGHT[left.rank];

      return weight === 0 ? left.name.localeCompare(right.name) : weight;
    });

    return {
      ...game,
      members,
      officers: members.filter((member) => member.rank === 'officer').length,
    };
  }

  /** O caminho de volta: a equipe com cargo vira a equipe do jogo. */
  #strip(team: Team): GameTeam {
    return {
      ...team,
      members: team.members.map(({ steamId, name, online, leader }) => ({
        steamId,
        name,
        online,
        leader,
      })),
    };
  }
}

/**
 * A resposta do comando, sem o que o plugin falou por cima.
 *
 * ####  O AVISO ENTRA NA RESPOSTA CASADA  ####
 *
 * MEDIDO no server01 em 15/09/2026: um `Puts` disparado DENTRO de um
 * comando do Covalence é anexado ao `Reply` daquele comando. O
 * agente pediu `origemz.team rename` e recebeu o JSON da resposta
 * grudado num `[OrigemZ Team] #OZTEAM#{…}` — e aí a resposta não é
 * mais JSON. O rename tinha funcionado; o agente é que não conseguiu
 * ler o que ele mesmo mandou fazer.
 *
 * O plugin foi corrigido (o aviso sai no frame seguinte), e esta
 * função fica como a segunda tranca: qualquer plugin pode falar no
 * console no meio de um comando nosso, e nada disso é resposta.
 */
export function cleanReply(reply: string): string {
  return reply
    .split(SPLIT_LINES)
    .filter((line) => !line.includes(TEAM_MARKER))
    .join('\n')
    .trim();
}

/**
 * O cargo de um membro.
 *
 * O líder vem do JOGO e ganha na frente de qualquer linha gravada:
 * uma promoção antiga não pode esconder quem manda de verdade.
 */
function rankOf(member: { readonly leader: boolean }, stored: string | undefined): TeamRank {
  if (member.leader) return 'leader';
  if (stored === 'officer') return 'officer';

  return 'member';
}
