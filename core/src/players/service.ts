// ============================================================
//  service.ts  -  a lista de jogadores da rede e a ficha de cada
//  um, como a API as mostra.
//
//  ####  ELE JUNTA, E NÃO COPIA  ####
//
//  Três fontes, cada uma dona do que sabe:
//
//      players / player_servers   quem é, onde jogou, desde quando
//      bans                       está banido? por quê? por quem?
//      player_events              o que aconteceu com ele
//
//  O banimento é LIDO da BanList a cada resposta. Uma coluna
//  `banned` aqui responderia mais rápido e estaria errada no
//  primeiro `DELETE /api/bans/:steamId` que passasse pelo caminho
//  que não a atualizasse — e o sintoma seria a ficha dizendo
//  "banido" para quem já voltou a jogar.
//
//  ------------------------------------------------------------
//  ####  A PAGINAÇÃO NÃO É OTIMIZAÇÃO  ####
//
//  Uma rede com meses de vida tem dezenas de milhares de
//  jogadores. Uma rota que devolve todos é uma rota que um dia
//  derruba o agente, e o dia é justamente o de mais movimento. O
//  `total` vai junto porque sem ele a tela não sabe se há página
//  seguinte — e sem saber, ou ela esconde gente ou ela oferece uma
//  página que não existe.
//
//  ####  AUSENTE É `null`, E NUNCA ZERO  ####
//
//  Quem nunca jogou num servidor não tem linha lá, e "0 horas
//  jogadas" e "não sei quantas" são respostas diferentes. Quem
//  transforma `null` em travessão é a tela
//  (panel/src/lib/format.ts); o que o agente não pode é inventar o
//  zero.
// ============================================================

import type { BanView } from '../bans/service.js';
import type {
  PlayerEventInput,
  PlayerEventKind,
  PlayerRecord,
  PlayerServerRecord,
  PlayersRepository,
} from '../db/players-repository.js';
import { isOnline } from '../db/players-repository.js';

/** Tamanho de página: o padrão e o teto. */
export const DEFAULT_PLAYERS_LIMIT = 50;
export const MAX_PLAYERS_LIMIT = 200;

/** Quantos eventos a ficha traz por padrão, e no máximo. */
export const DEFAULT_EVENTS_LIMIT = 50;
export const MAX_EVENTS_LIMIT = 200;

/**
 * O que o diretório precisa da BanList.
 *
 * Interface mínima pelo mesmo motivo das outras: a `BanList` a
 * satisfaz por estrutura, e um teste a satisfaz com três funções —
 * sem servidor de Rust, sem RCON.
 */
export interface PlayerBans {
  list(options?: { active?: boolean; query?: string }): readonly BanView[];
  activeOf(steamId: string): BanView | null;
  historyOf(steamId: string): readonly BanView[];
}

/** Uma linha da tela de rede. Datas em ISO. */
export interface PlayerListItem {
  readonly steamId: string;
  readonly name: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Tem sessão aberta em ALGUM servidor. */
  readonly online: boolean;
  /**
   * Onde ele está AGORA. Vazio quando está offline.
   *
   * É uma lista porque a mesma pessoa pode estar em dois
   * servidores ao mesmo tempo — raro, mas é o que a separação em
   * `player_servers` existe para permitir dizer.
   */
  readonly onlineOn: readonly string[];
  /**
   * O último servidor em que ele foi visto. `null` = nenhum.
   *
   * A tela mostra "onde está agora, ou o último servidor": com
   * `onlineOn` vazio, é este que responde.
   */
  readonly lastServerId: string | null;
  /** Está banido AGORA? O sinal da linha. Vem da BanList. */
  readonly banned: boolean;
}

export interface PlayerListPage {
  readonly players: readonly PlayerListItem[];
  /** Quantos casaram com o filtro, antes da paginação. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** O que ele fez em UM servidor, como a ficha mostra. */
export interface PlayerServerView {
  readonly serverId: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly online: boolean;
  readonly joinedAt: string | null;
  readonly leftAt: string | null;
  readonly leaveReason: string | null;
  readonly sessions: number;
  /** Somado no fechamento de cada sessão. Ver players/presence.ts. */
  readonly playedSeconds: number;
}

export interface PlayerIdentity {
  readonly steamId: string;
  /** Vazio quando o SteamID só é conhecido por um banimento. */
  readonly name: string;
  /** `null` = o agente nunca o viu jogar. */
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  readonly lastIp: string | null;
  readonly online: boolean;
  /**
   * O agente já o viu jogar?
   *
   * `false` é a ficha de quem existe só na lista de banidos — o
   * ban por SteamID de alguém offline, ou o adotado de um
   * `bans.cfg`. Ela é justamente a que quem administra procura, e
   * devolver 404 ali deixaria a tela de banidos sem para onde
   * apontar.
   */
  readonly known: boolean;
}

export interface PlayerProfile {
  readonly player: PlayerIdentity;
  /** O ban ATIVO, vindo da BanList. `null` se não há. */
  readonly ban: BanView | null;
  readonly servers: readonly PlayerServerView[];
}

/** Um item da linha do tempo. */
export interface TimelineEntry {
  readonly at: string;
  readonly kind: PlayerEventKind | 'ban' | 'unban';
  /** `null` num banimento de rede: ele não é de servidor nenhum. */
  readonly serverId: string | null;
  /** Quem pediu. `null` no que o jogo fez sozinho. */
  readonly actor: string | null;
  readonly detail: string | null;
}

/**
 * O que ainda NÃO é medido, com a estrutura de como vai ficar.
 *
 * ####  POR QUE O EXEMPLO VEM DO AGENTE  ####
 *
 * Kill e morte não existem hoje — nem no RCON (perguntamos ao
 * servidor: há `server.combatlog` do jogador chamador e
 * `player.printstats` de quem digitou, e nada que reporte as
 * mortes de todo mundo) nem no plugin. A aba precisa mostrar a
 * estrutura para que se veja o que vem por aí, e precisa DIZER que
 * aquilo é exemplo.
 *
 * Ele sai daqui, e não do navegador, por duas razões: o formato do
 * evento futuro tem um dono só (este arquivo), e a frase que
 * explica nasce no módulo que conhece a regra — a tela não
 * reescreve mensagem do agente.
 *
 * O que o agente NÃO faz é misturar isto com `events`: mock
 * disfarçado de dado é a única coisa pior que não ter o dado.
 */
export interface TimelineSample {
  /** Sempre `false`. Existe para a tela não ter de deduzir. */
  readonly measured: false;
  readonly label: string;
  readonly note: string;
  readonly events: readonly {
    readonly at: string;
    readonly kind: 'kill' | 'death';
    readonly serverId: string;
    readonly detail: string;
  }[];
}

export interface PlayerTimeline {
  /** O que aconteceu de verdade. */
  readonly events: readonly TimelineEntry[];
  readonly sample: TimelineSample;
}

export interface PlayerDirectoryDeps {
  readonly repository: PlayersRepository;
  readonly bans: PlayerBans;
}

export class PlayerDirectory {
  readonly #deps: PlayerDirectoryDeps;

  constructor(deps: PlayerDirectoryDeps) {
    this.#deps = deps;
  }

  /**
   * Uma página da rede.
   *
   * ####  TRÊS CONSULTAS, INDEPENDENTE DO TAMANHO DA PÁGINA  ####
   *
   * A página, as linhas de servidor de todos os jogadores dela, e
   * os banimentos ativos. Perguntar "onde este está?" e "este está
   * banido?" por linha seriam 100 idas ao banco para desenhar 50
   * linhas — o N+1 que só aparece quando a base cresce.
   */
  list(options: {
    readonly query?: string | undefined;
    readonly online?: boolean;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  }): PlayerListPage {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PLAYERS_LIMIT, 1), MAX_PLAYERS_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);

    const page = this.#deps.repository.list({
      query: options.query,
      online: options.online === true,
      limit,
      offset,
    });

    const presence = this.#deps.repository.presenceOf(page.players.map((player) => player.steamId));

    const banned = new Set(
      this.#deps.bans
        .list({ active: true })
        .filter((ban) => ban.active)
        .map((ban) => ban.steamId),
    );

    return {
      players: page.players.map((player) =>
        toListItem(player, presence.get(player.steamId) ?? [], banned.has(player.steamId)),
      ),
      total: page.total,
      limit,
      offset,
    };
  }

  /**
   * A ficha.
   *
   * `null` = este SteamID nunca foi visto por este agente E nunca
   * foi banido por ele — que é o único caso em que a rota responde
   * 404. Ver `PlayerIdentity.known`.
   */
  get(steamId: string): PlayerProfile | null {
    const record = this.#deps.repository.get(steamId);
    const ban = this.#deps.bans.activeOf(steamId);

    if (record === null && ban === null) {
      return null;
    }

    const servers = this.#deps.repository.serversOf(steamId);

    return {
      player:
        record === null
          ? {
              steamId,
              // O nome de quando foi banido é o único que existe
              // para quem nunca apareceu numa lista de online.
              name: ban?.name ?? '',
              firstSeen: null,
              lastSeen: null,
              lastIp: null,
              online: false,
              known: false,
            }
          : {
              steamId: record.steamId,
              name: record.name,
              firstSeen: toIso(record.firstSeen),
              lastSeen: toIso(record.lastSeen),
              lastIp: record.lastIp,
              online: isOnline(servers),
              known: true,
            },
      ban,
      servers: servers.map(toServerView),
    };
  }

  /**
   * Registra uma ação do painel sobre um jogador.
   *
   * ####  O LOG DO PROCESSO NÃO RESPONDE ESTA PERGUNTA  ####
   *
   * Expulsar e teleportar já vão para o log com quem pediu — mas
   * ninguém abre o log do agente para responder "por que este
   * jogador foi expulso ontem?". O log é do AGENTE; isto é do
   * JOGADOR, e é o que aparece na ficha dele.
   *
   * Não lança: uma falha ao gravar o histórico não pode desfazer
   * uma expulsão que JÁ aconteceu no jogo. Quem chama trata o erro
   * (ou o ignora) sabendo disso.
   */
  recordAction(event: PlayerEventInput): void {
    this.#deps.repository.recordEvent(event);
  }

  /** Onde ele joga, e desde quando em cada lugar. */
  serversOf(steamId: string): readonly PlayerServerView[] {
    return this.#deps.repository.serversOf(steamId).map(toServerView);
  }

  /**
   * A linha do tempo: os eventos gravados MAIS os banimentos.
   *
   * Os bans não são copiados para `player_events` (ver a migração
   * 006) — eles entram aqui, na leitura, a partir da própria
   * tabela `bans`. Um ban aparece como DOIS itens quando foi
   * revogado, porque foram duas decisões, de duas pessoas, em duas
   * datas.
   *
   * O `limit` vale para os eventos gravados e para o resultado
   * final: a ficha mostra os N últimos acontecimentos, venham eles
   * de onde vierem.
   */
  timeline(steamId: string, limit: number = DEFAULT_EVENTS_LIMIT): PlayerTimeline {
    const size = Math.min(Math.max(limit, 1), MAX_EVENTS_LIMIT);

    const events: TimelineEntry[] = this.#deps.repository.events(steamId, size).map((event) => ({
      at: toIso(event.at),
      kind: event.kind,
      serverId: event.serverId,
      actor: event.actor,
      detail: event.detail,
    }));

    for (const ban of this.#deps.bans.historyOf(steamId)) {
      // Um ban de rede não é de servidor nenhum — e enumerar os de
      // hoje seria justamente o que o escopo existe para não fazer.
      // Ver a migração 005.
      const serverId = ban.scope === 'network' ? null : (ban.servers[0] ?? null);

      // A REVOGAÇÃO ENTRA ANTES DO BANIMENTO na lista, e não é
      // descuido: o `sort` do JavaScript é estável, então quando as
      // duas caem no mesmo milissegundo — banir e revogar em
      // seguida, o que acontece num teste e numa correção de engano
      // — é esta ordem que sobrevive. E a revogação é, por
      // definição, posterior ao banimento que ela desfaz.
      if (ban.revokedAt !== null) {
        events.push({
          at: ban.revokedAt,
          kind: 'unban',
          serverId,
          // Revogado sem quem: foi o relógio, cumprido o prazo.
          actor: ban.revokedBy,
          detail: ban.revokedBy === null ? 'prazo cumprido' : null,
        });
      }

      events.push({
        at: ban.createdAt,
        kind: 'ban',
        serverId,
        actor: ban.origin === 'adopted' ? 'adotado do bans.cfg' : ban.createdBy,
        detail: ban.reason,
      });
    }

    // ISO com largura fixa e sempre em UTC ordena como texto — é a
    // mesma propriedade que permitia comparar datas no banco
    // antigo, e aqui ela poupa converter tudo de volta para número.
    events.sort((a, b) => b.at.localeCompare(a.at));

    return { events: events.slice(0, size), sample: buildSample() };
  }
}

/**
 * O exemplo da aba de histórico. Ver `TimelineSample`.
 *
 * As datas são recentes de propósito: um exemplo datado de 1970
 * pareceria defeito, e um datado de hoje deixa claro que ele é
 * ilustração — o rótulo e a nota fazem o resto.
 */
function buildSample(now: number = Date.now()): TimelineSample {
  return {
    measured: false,
    label: 'exemplo — ainda não é medido',
    note:
      'Kill e morte ainda não existem: o RCON não os entrega (só há o combatlog do próprio ' +
      'jogador) e o plugin ainda não os coleta. Estas linhas mostram como o histórico vai ficar ' +
      'quando o OrigemZPlayer passar a reportar os eventos do Oxide — nenhuma delas aconteceu.',
    events: [
      {
        at: toIso(now - 3_600_000),
        kind: 'kill',
        serverId: 'server01',
        detail: 'matou Fulano com AK-47 a 82 m',
      },
      {
        at: toIso(now - 7_200_000),
        kind: 'death',
        serverId: 'server01',
        detail: 'morto por Ciclano com Bolt Action Rifle',
      },
    ],
  };
}

function toListItem(
  player: PlayerRecord,
  servers: readonly PlayerServerRecord[],
  banned: boolean,
): PlayerListItem {
  const onlineOn = servers
    .filter((server) => server.joinedAt !== null && server.leftAt === null)
    .map((server) => server.serverId);

  return {
    steamId: player.steamId,
    name: player.name,
    firstSeen: toIso(player.firstSeen),
    lastSeen: toIso(player.lastSeen),
    online: onlineOn.length > 0,
    onlineOn,
    // A lista já vem ordenada por `last_seen` decrescente (ver
    // `presenceOf`), então o primeiro é o mais recente.
    lastServerId: servers[0]?.serverId ?? null,
    banned,
  };
}

function toServerView(server: PlayerServerRecord): PlayerServerView {
  return {
    serverId: server.serverId,
    firstSeen: toIso(server.firstSeen),
    lastSeen: toIso(server.lastSeen),
    online: server.joinedAt !== null && server.leftAt === null,
    joinedAt: server.joinedAt === null ? null : toIso(server.joinedAt),
    leftAt: server.leftAt === null ? null : toIso(server.leftAt),
    leaveReason: server.leaveReason,
    sessions: server.sessions,
    playedSeconds: server.playedSeconds,
  };
}

/** Epoch ms -> ISO. A borda HTTP fala ISO; o banco guarda número. */
function toIso(value: number): string {
  return new Date(value).toISOString();
}
