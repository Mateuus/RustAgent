// ============================================================
//  service.ts  -  a BanList, e os servidores como espelho dela.
//
//  O Rust não tem banlist remota: cada servidor tem o `bans.cfg`
//  dele, e nada os liga. Este arquivo é o que os liga — a tabela
//  `bans` é a fonte, e cada servidor recebe o que a fonte diz.
//
//  ------------------------------------------------------------
//  ####  A RECONCILIAÇÃO TEM TRÊS SITUAÇÕES, E SÓ UMA DELAS É
//        ÓBVIA  ####
//
//    na tabela, não no servidor       `banid`
//    no servidor, não na tabela       ADOTAR — nunca apagar
//    revogado na tabela, no servidor  `unban`
//
//  A do meio é a que decide se este desenho serve. Um servidor que
//  já tinha banidos quando o agente chegou não é um servidor
//  "sujo": aquilo foi decisão de alguém. Tratar a tabela como
//  verdade absoluta no primeiro boot soltaria todo mundo de uma
//  vez — e o sintoma seria os banidos voltando ao jogo, sem nada
//  explicando por quê.
//
//  ####  ELA ACONTECE EM TRÊS MOMENTOS  ####
//
//  Quando o agente sobe, quando um servidor é ligado e quando o
//  RCON reconecta. Os três têm a mesma causa: é quando o agente
//  volta a poder falar com aquele servidor, e portanto quando os
//  dois lados podem ter divergido sem ninguém ver.
//
//  ####  E ELA NUNCA AGE SOBRE UM PALPITE  ####
//
//  `readServerBans` devolve `null` quando não deu para perguntar ou
//  para entender a resposta — diferente de `[]`, que é "não há
//  ninguém banido ali". Com `null` a rodada é ADIADA. Confundir os
//  dois faria o agente reaplicar a lista inteira a cada rodada, ou
//  pior, adotar nada e concluir que o servidor está em dia.
// ============================================================

import {
  appliesTo,
  isActive,
  type BanRecord,
  type BanScope,
  type BansRepository,
} from '../db/bans-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import {
  buildBanCommand,
  buildUnbanCommand,
  readServerBans,
  STEAM_ID_PATTERN,
  writeServerConfig,
} from './rust-bans.js';

/**
 * O que a BanList precisa saber dos servidores.
 *
 * Interface mínima pelo mesmo motivo do `PluginServers`: o
 * `ServerSupervisor` a satisfaz por estrutura, e um teste a
 * satisfaz com duas funções e um RCON de mentira — sem `.ini`, sem
 * processo, sem socket.
 */
export interface BanServers {
  /** Os ids que este agente conhece. */
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface BanListDeps {
  readonly repository: BansRepository;
  readonly servers: BanServers;
  readonly logger: Logger;
}

/** Um banimento como a API o mostra. Datas em ISO. */
export interface BanView {
  readonly id: number;
  readonly steamId: string;
  readonly name: string | null;
  readonly reason: string;
  readonly scope: BanScope;
  /** Vazio num `network` — ali ele quer dizer "todos". */
  readonly servers: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly origin: 'panel' | 'adopted';
  /** Vale AGORA: não revogado e não vencido. */
  readonly active: boolean;
  /**
   * Passou da data e ainda não foi revogado.
   *
   * É um estado de verdade, e curto: o relógio do agente passa por
   * ele e manda o `unban`. A tela precisa poder dizer "vencido,
   * saindo" em vez de "ativo" — senão parece que o prazo não
   * funciona.
   */
  readonly expired: boolean;
}

/** O mesmo ban, visto de dentro de UM servidor. */
export interface ServerBanView extends BanView {
  /**
   * De onde ele vem, do ponto de vista deste servidor.
   *
   *   `rede`        vale em todos, inclusive nos que ainda vão nascer
   *   `especifico`  alguém o aplicou a este servidor
   *   `adotado`     estava no `bans.cfg` daqui quando o agente chegou
   */
  readonly source: 'rede' | 'especifico' | 'adotado';
}

export interface CreateBanInput {
  readonly steamId: string;
  readonly name: string | null;
  readonly reason: string;
  readonly scope: BanScope;
  readonly servers: readonly string[];
  /** Epoch ms. `null` = permanente. */
  readonly expiresAt: number | null;
  readonly createdBy: string | null;
}

/** O que uma rodada de reconciliação fez naquele servidor. */
export interface ReconcileResult {
  readonly serverId: string;
  /** Estavam na tabela e faltavam no servidor. */
  readonly applied: readonly string[];
  /** Estavam no servidor e a tabela mandou soltar. */
  readonly removed: readonly string[];
  /** Estavam no servidor e o agente não conhecia. */
  readonly adopted: readonly string[];
  /** Já tinham ban ativo alhures, e ele passou a valer aqui. */
  readonly extended: readonly string[];
  /**
   * Por que a rodada não aconteceu. `null` = ela aconteceu.
   *
   * Não é erro: servidor parado é o estado normal de metade da
   * lista. O que não pode é ficar calado — "sincronizado" sem ter
   * sincronizado é a mentira mais cara desta tela.
   */
  readonly skipped: string | null;
}

export class BanList {
  readonly #deps: BanListDeps;

  constructor(deps: BanListDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  list(options: { active?: boolean; query?: string } = {}): readonly BanView[] {
    const now = Date.now();

    return this.#deps.repository.list(options).map((ban) => toBanView(ban, now));
  }

  /** O que vale NAQUELE servidor, com a origem de cada linha. */
  serverBans(serverId: string): readonly ServerBanView[] {
    const now = Date.now();

    return this.#deps.repository.activeFor(serverId, now).map((ban) => ({
      ...toBanView(ban, now),
      source: ban.scope === 'network' ? 'rede' : ban.origin === 'adopted' ? 'adotado' : 'especifico',
    }));
  }

  // ------------------------------------------------------
  //  Banir e revogar
  // ------------------------------------------------------

  /**
   * Bane, e aplica em quem estiver no ar.
   *
   * O banco primeiro, o jogo depois: um `banid` que sai sem a linha
   * gravada é um banimento que some no próximo boot do agente e que
   * ninguém consegue revogar pela tela. O contrário — linha gravada
   * e servidor fora do ar — é o caso NORMAL, e a reconciliação do
   * próximo start resolve.
   *
   * @throws {ApiError} 400 no SteamID fora de formato, 404 no
   * servidor desconhecido, 409 quando já há ban ativo.
   */
  async create(input: CreateBanInput): Promise<{
    readonly ban: BanView;
    readonly applied: readonly string[];
    readonly pending: readonly string[];
  }> {
    assertSteamId(input.steamId);

    const existing = this.#deps.repository.activeOf(input.steamId);

    if (existing !== null) {
      throw new ApiError(
        'BAN_ALREADY_ACTIVE',
        `${input.steamId} já está banido desde ` +
          `${new Date(existing.createdAt).toLocaleDateString('pt-BR')} (${existing.reason}). ` +
          'Revogue o banimento atual antes de aplicar outro — dois ativos para o mesmo jogador ' +
          'não teriam resposta para "qual motivo vale?".',
        409,
      );
    }

    if (input.expiresAt !== null && input.expiresAt <= Date.now()) {
      throw new ApiError(
        'BAN_ALREADY_EXPIRED',
        'A data de vencimento já passou. Um banimento que nasce vencido seria removido pelo ' +
          'relógio na rodada seguinte, e a tela mostraria um ban que some sozinho.',
        400,
      );
    }

    const servers = this.#targetsOf(input.scope, input.servers);

    const ban = this.#deps.repository.create({
      steamId: input.steamId,
      name: input.name,
      reason: input.reason,
      scope: input.scope,
      servers,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      origin: 'panel',
    });

    // ####  BANIR É COMANDO DESTRUTIVO, E FICA REGISTRADO  ####
    //
    // "Quem baniu este jogador?" é a primeira pergunta de toda
    // discussão sobre banimento. A resposta está na linha
    // (`created_by`) E aqui, no log do processo, com o horário.
    this.#deps.logger.warn(
      {
        steamId: ban.steamId,
        scope: ban.scope,
        servers: ban.servers,
        by: ban.createdBy,
        expiresAt: ban.expiresAt,
      },
      `banimento aplicado: ${ban.reason}`,
    );

    const applied: string[] = [];
    const pending: string[] = [];

    for (const serverId of this.#reachOf(ban)) {
      const sent = await this.#send(serverId, buildBanCommand(ban), true);

      (sent ? applied : pending).push(serverId);
    }

    if (applied.length > 0) {
      await this.#writeConfigOn(applied);
    }

    return { ban: toBanView(ban, Date.now()), applied, pending };
  }

  /**
   * Revoga e manda o `unban` para onde o ban valia.
   *
   * A linha fica, com `revoked_at` e `revoked_by` — ver a migração
   * 005. Apagar responderia "quem está banido?" e destruiria "quem
   * já esteve, por quê, e quem o soltou".
   *
   * @throws {ApiError} 404 quando não há ban ativo.
   */
  async revoke(
    steamId: string,
    revokedBy: string | null,
  ): Promise<{
    readonly ban: BanView;
    readonly removed: readonly string[];
    readonly pending: readonly string[];
  }> {
    assertSteamId(steamId);

    const active = this.#deps.repository.activeOf(steamId);

    if (active === null) {
      throw new ApiError(
        'BAN_NOT_FOUND',
        `Não há banimento ativo para ${steamId} neste agente. Ele pode ter sido revogado em ` +
          'outra aba — recarregue a tela.',
        404,
      );
    }

    // O alcance é lido ANTES da revogação: depois dela o ban não se
    // aplica a servidor nenhum, e o `unban` não sairia para lugar
    // algum.
    const reach = this.#reachOf(active);
    const ban = this.#deps.repository.revoke(steamId, revokedBy);

    if (ban === null) {
      throw new ApiError(
        'BAN_NOT_FOUND',
        `O banimento de ${steamId} sumiu durante a revogação.`,
        404,
      );
    }

    this.#deps.logger.warn({ steamId, by: revokedBy, servers: reach }, 'banimento revogado');

    const removed: string[] = [];
    const pending: string[] = [];

    for (const serverId of reach) {
      const sent = await this.#send(serverId, buildUnbanCommand(steamId), true);

      (sent ? removed : pending).push(serverId);
    }

    if (removed.length > 0) {
      await this.#writeConfigOn(removed);
    }

    return { ban: toBanView(ban, Date.now()), removed, pending };
  }

  // ------------------------------------------------------
  //  Reconciliação
  // ------------------------------------------------------

  /**
   * Deixa o `bans.cfg` daquele servidor igual à tabela.
   *
   * As três situações estão no cabeçalho deste arquivo. O que vale
   * repetir aqui é o que ela NÃO faz: não apaga do servidor o que
   * não conhece, e não age quando não conseguiu ler.
   */
  async reconcile(serverId: string): Promise<ReconcileResult> {
    const rcon = this.#rconOf(serverId);

    if (!rcon.isConnected) {
      return skipped(
        serverId,
        `O agente não está falando com o RCON de "${serverId}" — a lista dele será conferida ` +
          'quando ele voltar.',
      );
    }

    const onServer = await readServerBans(rcon);

    if (onServer === null) {
      return skipped(
        serverId,
        `Não consegui ler a lista de banidos de "${serverId}" (o banlist não respondeu, ou ` +
          'respondeu num formato que não reconheço). Nada foi alterado — supor lista vazia aqui ' +
          'reaplicaria todos os banimentos a cada rodada.',
      );
    }

    const now = Date.now();
    const expected = new Map(
      this.#deps.repository.activeFor(serverId, now).map((ban) => [ban.steamId, ban]),
    );
    const present = new Set(onServer.map((ban) => ban.steamId));

    const applied: string[] = [];
    const removed: string[] = [];
    const adopted: string[] = [];
    const extended: string[] = [];

    // ---- na tabela, não no servidor -> banid ----
    for (const [steamId, ban] of expected) {
      if (present.has(steamId)) {
        continue;
      }

      if (await this.#send(serverId, buildBanCommand(ban), false)) {
        applied.push(steamId);
      }
    }

    // ---- o que o servidor tem ----
    for (const found of onServer) {
      if (expected.has(found.steamId)) {
        continue;
      }

      // A linha mais recente daquele SteamID, REVOGADA OU NÃO. Ver
      // `latestOf`: com `activeOf` sozinho, revogar um ban com o
      // servidor fora do ar faria a reconexão adotá-lo de volta.
      const known = this.#deps.repository.latestOf(found.steamId);

      // Ativo em outro lugar: o alcance dele passa a incluir este
      // servidor. Ver `addServer` — criar um segundo ban seria
      // recusado pelo índice, e apagar este seria desfazer a
      // decisão de quem o aplicou à mão.
      if (known !== null && isActive(known, now)) {
        this.#deps.repository.addServer(known.id, serverId);
        extended.push(found.steamId);
        continue;
      }

      // Conhecido e sem valer mais (revogado ou vencido): a tabela
      // mandou soltar, e o servidor ainda não soube.
      //
      // ####  ISTO DESFAZ UM BAN FEITO À MÃO DEPOIS DA REVOGAÇÃO  ####
      //
      // E é deliberado. A tabela é a fonte: sem esta regra, revogar
      // pela tela não teria efeito nenhum sobre um servidor que
      // estava fora do ar na hora — a revogação ficaria eterna na
      // lista do agente e nunca chegaria ao jogo. Quem banir de
      // novo pelo console deve banir pelo painel, que é onde a
      // decisão sobrevive.
      if (known !== null) {
        if (await this.#send(serverId, buildUnbanCommand(found.steamId), false)) {
          removed.push(found.steamId);
        }

        continue;
      }

      // Desconhecido: ADOTAR. Nunca apagar — ver o cabeçalho.
      if (!STEAM_ID_PATTERN.test(found.steamId)) {
        continue;
      }

      this.#deps.repository.create(
        {
          steamId: found.steamId,
          name: found.name,
          reason: found.reason ?? `adotado do bans.cfg de ${serverId}`,
          scope: 'servers',
          servers: [serverId],
          expiresAt: null,
          createdBy: null,
          origin: 'adopted',
        },
        now,
      );

      adopted.push(found.steamId);
    }

    const changed = applied.length + removed.length;

    // O `server.writecfg` só depois do LOTE, e só se houve lote:
    // sem ele o `bans.cfg` fica na memória do servidor até ele
    // decidir gravar, e um crash perde tudo.
    if (changed > 0) {
      await this.#writeConfigOn([serverId]);
    }

    if (changed + adopted.length + extended.length > 0) {
      this.#deps.logger.info(
        { server: serverId, applied, removed, adopted, extended },
        'lista de banidos reconciliada',
      );
    }

    return { serverId, applied, removed, adopted, extended, skipped: null };
  }

  /**
   * A rodada do boot: todos os servidores.
   *
   * Um servidor que falha não segura os outros — a lista dele fica
   * para a próxima, e o motivo vai para o log.
   */
  async reconcileAll(): Promise<readonly ReconcileResult[]> {
    const results: ReconcileResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      try {
        results.push(await this.reconcile(serverId));
      } catch (error) {
        this.#deps.logger.warn(
          { server: serverId, err: toError(error) },
          'não consegui reconciliar a lista de banidos deste servidor',
        );
      }
    }

    return results;
  }

  /**
   * Os que venceram: revoga e manda o `unban`.
   *
   * É o que o relógio chama. Um ban vencido que ninguém removeu é
   * pior que não ter prazo: a pessoa cumpriu a pena e continua
   * fora, enquanto a tela do agente diz que ela está livre.
   */
  async sweepExpired(now: number = Date.now()): Promise<readonly string[]> {
    const expired = this.#deps.repository.expired(now);
    const released: string[] = [];
    const touched = new Set<string>();

    for (const ban of expired) {
      const reach = this.#reachOf(ban);

      // `revoked_by` nulo com `revoked_at` preenchido é a
      // assinatura do relógio: ninguém revogou, o prazo acabou.
      this.#deps.repository.revoke(ban.steamId, null, now);

      for (const serverId of reach) {
        if (await this.#send(serverId, buildUnbanCommand(ban.steamId), true)) {
          touched.add(serverId);
        }
      }

      released.push(ban.steamId);

      this.#deps.logger.info(
        { steamId: ban.steamId, servers: reach },
        'banimento vencido: prazo cumprido, jogador liberado',
      );
    }

    if (touched.size > 0) {
      await this.#writeConfigOn([...touched]);
    }

    return released;
  }

  // ------------------------------------------------------
  //  Ajudantes
  // ------------------------------------------------------

  /**
   * Em que servidores este ban vale, hoje.
   *
   * Um `network` alcança TODOS os cadastrados — inclusive os que
   * não existiam quando ele foi aplicado. É a propriedade inteira
   * do escopo, e ela mora nesta função.
   */
  #reachOf(ban: BanRecord): readonly string[] {
    if (ban.scope === 'network') {
      return this.#deps.servers.ids();
    }

    return this.#deps.servers.ids().filter((id) => appliesTo(ban, id));
  }

  /**
   * Valida os servidores de um ban específico.
   *
   * @throws {ApiError} 400 quando a lista está vazia (um ban que
   * não vale em lugar nenhum não é um ban), 404 quando um dos ids
   * não existe.
   */
  #targetsOf(scope: BanScope, servers: readonly string[]): readonly string[] {
    if (scope === 'network') {
      // De propósito: o `network` não enumera ninguém. Ver a
      // migração 005.
      return [];
    }

    const known = new Set(this.#deps.servers.ids());
    const unique = [...new Set(servers)];

    if (unique.length === 0) {
      throw new ApiError(
        'BAN_WITHOUT_SERVERS',
        'Um banimento de escopo "servers" precisa dizer em quais. Para valer em todos — ' +
          'inclusive nos que ainda vão ser criados — use o escopo "network".',
        400,
      );
    }

    const missing = unique.filter((id) => !known.has(id));

    if (missing.length > 0) {
      throw new ApiError(
        'UNKNOWN_SERVER',
        `Não existe servidor com o id "${missing.join('", "')}" neste agente. Os que existem: ` +
          `${this.#deps.servers.ids().join(', ') || '(nenhum)'}.`,
        404,
      );
    }

    return unique;
  }

  /**
   * Manda um comando para aquele servidor.
   *
   * `false` = não deu (servidor parado, RCON fora, comando
   * recusado). NÃO é erro: metade da lista costuma estar parada, e
   * a reconciliação do próximo start é quem fecha a diferença.
   *
   * `loud` separa o que alguém pediu AGORA — e portanto está
   * olhando para a tela — do que a rotina faz sozinha. Um `warn`
   * por servidor parado, a cada rodada, enterraria o log.
   */
  async #send(serverId: string, command: string, loud: boolean): Promise<boolean> {
    const rcon = this.#rconOf(serverId);

    if (!rcon.isConnected) {
      return false;
    }

    try {
      await rcon.send(command);
      return true;
    } catch (error) {
      const details = { server: serverId, command, err: toError(error) };
      const message = 'o comando de banimento não foi aceito por este servidor';

      if (loud) {
        this.#deps.logger.warn(details, message);
      } else {
        this.#deps.logger.debug(details, message);
      }

      return false;
    }
  }

  /** `server.writecfg` nos servidores que receberam o lote. */
  async #writeConfigOn(serverIds: readonly string[]): Promise<void> {
    for (const serverId of serverIds) {
      try {
        await writeServerConfig(this.#rconOf(serverId));
      } catch (error) {
        // A lista já está valendo na memória do servidor; o que se
        // perde sem o writecfg é a gravação em disco, e só num
        // crash. Não é motivo para desfazer o lote.
        this.#deps.logger.warn(
          { server: serverId, err: toError(error) },
          'apliquei os banimentos, mas o server.writecfg falhou — eles valem agora e podem se ' +
            'perder se o servidor cair antes do próximo save',
        );
      }
    }
  }

  #rconOf(serverId: string): OpsRcon {
    return this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);
  }
}

/**
 * @throws {ApiError} 400.
 *
 * A mensagem diz o formato porque o engano comum é mandar o
 * `steamID` de 32 bits, ou o nome do jogador — e os dois "parecem"
 * um identificador.
 */
export function assertSteamId(steamId: string): void {
  if (!STEAM_ID_PATTERN.test(steamId)) {
    throw new ApiError(
      'INVALID_STEAM_ID',
      `"${steamId}" não é um SteamID64. Ele tem exatamente 17 dígitos e começa com 7656 — é o ` +
        'que aparece na coluna SteamID da aba Jogadores, e o que o botão Copiar SteamID põe na ' +
        'área de transferência.',
      400,
    );
  }
}

/** Epoch ms -> ISO, com o `null` sobrevivendo. */
function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toBanView(ban: BanRecord, now: number): BanView {
  return {
    id: ban.id,
    steamId: ban.steamId,
    name: ban.name,
    reason: ban.reason,
    scope: ban.scope,
    servers: ban.servers,
    // `created_at` é NOT NULL: o `?? ''` é só o tipo.
    createdAt: toIso(ban.createdAt) ?? '',
    createdBy: ban.createdBy,
    expiresAt: toIso(ban.expiresAt),
    revokedAt: toIso(ban.revokedAt),
    revokedBy: ban.revokedBy,
    origin: ban.origin,
    active: isActive(ban, now),
    expired: ban.revokedAt === null && ban.expiresAt !== null && ban.expiresAt <= now,
  };
}

function skipped(serverId: string, reason: string): ReconcileResult {
  return { serverId, applied: [], removed: [], adopted: [], extended: [], skipped: reason };
}
