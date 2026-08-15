// ============================================================
//  service.ts  -  a VipList: o direito de rede, e os dois lugares
//  onde ele vira efeito dentro do jogo.
//
//  A fonte é a tabela `vips`. Cada servidor recebe o MESMO estado
//  por dois caminhos, e os dois precisam existir:
//
//    1. o GRUPO DO OXIDE — é o que faz a fila, o chat e os plugins
//       de terceiros enxergarem o VIP;
//    2. o `origemz.vip.sync` — é o que o `OrigemZAgent` guarda para
//       responder ao `GetVipInfo` de quem perguntar (o OrigemZVip,
//       o OrigemZQueue).
//
//  Isso NÃO é duplicar fonte: a fonte é a tabela, e ela é
//  reempurrada inteira. Deixar só um dos dois faria metade dos
//  plugins não enxergar o VIP.
//
//  ------------------------------------------------------------
//  ####  QUEM PÕE O JOGADOR NO GRUPO É O PLUGIN, QUANDO ELE ESTÁ
//        LÁ  ####
//
//  MEDIDO no `server01` (`find origemz`): existe um
//  `origemz.vip.apply <steamId>`, e o cabeçalho dele diz o desenho
//  inteiro — ele lê o nível do AGENTE (pelo `GetVipInfo`, ou seja,
//  do cache que acabamos de empurrar), põe o jogador no grupo
//  daquele nível e TIRA dos outros. Funciona com o jogador offline,
//  porque permissão do Oxide é por SteamID.
//
//  Preferi esse caminho ao `oxide.usergroup` por um motivo só: quem
//  sabe o nome do grupo é o config DELE, e pedir ao plugin que
//  aplique elimina a chance de o agente e ele discordarem. Quando o
//  OrigemZVip não está no servidor, o agente faz o mesmo trabalho
//  pelo módulo do Oxide (oxide/permissions.ts) — lendo o nome do
//  grupo no `OrigemZVip.json`, nunca montando `origemz.vip.${tier}`
//  na mão.
//
//  ####  E SÓ O NÍVEL MAIS ALTO GANHA GRUPO  ####
//
//  `origemz.vip.gold` HERDA de `silver`, que herda de `bronze`
//  (MEDIDO: o `oxide.show group` lista as permissões do pai numa
//  seção própria). Pôr o jogador nos três daria o mesmo poder por
//  três caminhos — e o `SyncPlayer` do plugin desfaria isso no
//  primeiro `apply`, tirando os outros dois. Dois donos discordando
//  sobre o mesmo estado é o que produz "concedi e sumiu sozinho".
//
//  ------------------------------------------------------------
//  ####  A RECONCILIAÇÃO TEM TRÊS SITUAÇÕES, E SÓ UMA É ÓBVIA  ####
//
//    na tabela, fora do grupo      põe no grupo
//    no grupo, fora da tabela      ADOTAR — nunca tirar
//    revogado na tabela, no grupo  tira do grupo
//
//  A do meio é a que decide se este desenho serve. Um jogador que
//  alguém pôs no `origemz.vip.gold` à mão não é sujeira: aquilo foi
//  decisão de alguém. Tratar a tabela como verdade absoluta no
//  primeiro boot tiraria o VIP de todo mundo de uma vez — e o
//  sintoma seria descoberto pelos jogadores. Mesma lição da BanList
//  (bans/service.ts).
//
//  Ela acontece nos MESMOS TRÊS MOMENTOS: boot, servidor ligado e
//  `onRconConnected`. Um servidor que ficou fora do ar durante a
//  compra precisa receber o estado quando voltar.
// ============================================================

import { STEAM_ID_PATTERN } from '../bans/rust-bans.js';
import { assertSteamId } from '../bans/service.js';
import type { PlayerEventInput } from '../db/players-repository.js';
import {
  isActive,
  type VipListRecord,
  type VipOrigin,
  type VipRecord,
  type VipsRepository,
} from '../db/vips-repository.js';
import { firstJsonLine } from '../game/plugin-contract.js';
import { pushState, type PushOutcome } from '../game/plugin-push.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { parseGroup, setUserGroup } from '../oxide/permissions.js';
import { toError } from '../util.js';
import { highestLevel, readVipTiers, type VipTierLevel } from './tiers.js';

/** O comando que leva o estado de VIP ao `OrigemZAgent`. */
export const VIP_SYNC_COMMAND = 'origemz.vip.sync';

/** E o que pede ao `OrigemZVip` que aplique os grupos de um jogador. */
export const VIP_APPLY_COMMAND = 'origemz.vip.apply';

/**
 * O que a VipList precisa saber dos servidores.
 *
 * Interface mínima pelo mesmo motivo do `BanServers`: o
 * `ServerSupervisor` a satisfaz por estrutura, e um teste a
 * satisfaz com três funções e um RCON de mentira — sem `.ini`, sem
 * processo, sem socket.
 */
export interface VipServers {
  /** Os ids que este agente conhece. */
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
  /** Onde mora o `oxide\config` daquele servidor. */
  configOf(id: string): { readonly paths: { readonly oxideConfigDir: string } } | null;
}

/**
 * O que a VipList precisa da ficha do jogador. E nada além.
 *
 * "Ganhou VIP" é um ACONTECIMENTO, e a ficha mostra uma linha do
 * tempo só — ver a migração 014.
 */
export interface VipHistory {
  recordAction(event: PlayerEventInput): void;
}

export interface VipListDeps {
  readonly repository: VipsRepository;
  readonly servers: VipServers;
  readonly logger: Logger;
  readonly history?: VipHistory | undefined;
}

/** Uma concessão como a API a mostra. Datas em ISO. */
export interface VipView {
  readonly id: number;
  readonly steamId: string;
  readonly tier: string;
  readonly expiresAt: string | null;
  readonly origin: VipOrigin;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  /** Vale AGORA: não revogado e não vencido. */
  readonly active: boolean;
  /**
   * Passou da data e o relógio ainda não passou por ele.
   *
   * Estado real e curto. A tela precisa poder dizer "vencido,
   * saindo" em vez de "ativo" — senão parece que o prazo não
   * funciona.
   */
  readonly expired: boolean;
  /** O nome do jogador, quando o agente já o viu. */
  readonly playerName?: string | null;
}

export interface GrantVipInput {
  readonly steamId: string;
  readonly tier: string;
  /** Epoch ms. `null` = vitalício. */
  readonly expiresAt: number | null;
  readonly origin: VipOrigin;
  readonly createdBy: string | null;
}

/** O que uma rodada de sincronização fez naquele servidor. */
export interface VipSyncResult {
  readonly serverId: string;
  /** Quantos jogadores foram no payload. */
  readonly players: number;
  /** Entraram no grupo do Oxide agora. */
  readonly added: readonly string[];
  /** Saíram do grupo agora. */
  readonly removed: readonly string[];
  /** Estavam no grupo e o agente não conhecia. */
  readonly adopted: readonly string[];
  /**
   * Por que a rodada não aconteceu (ou aconteceu pela metade).
   * `null` = ela aconteceu inteira.
   *
   * Não é erro: servidor parado é o estado normal de metade da
   * lista. O que não pode é ficar calado — "sincronizado" sem ter
   * sincronizado é a mentira mais cara desta tela.
   */
  readonly skipped: string | null;
}

export class VipList {
  readonly #deps: VipListDeps;

  constructor(deps: VipListDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  list(options: {
    readonly active?: boolean | undefined;
    readonly query?: string | undefined;
    readonly tier?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  }): { readonly vips: readonly VipView[]; readonly total: number } {
    const now = Date.now();
    const page = this.#deps.repository.list(options, now);

    return { vips: page.vips.map((vip) => toVipView(vip, now)), total: page.total };
  }

  /** Os níveis que este jogador tem AGORA. */
  activeOf(steamId: string): readonly VipView[] {
    const now = Date.now();

    return this.#deps.repository.activeOf(steamId, now).map((vip) => toVipView(vip, now));
  }

  /** Tudo o que já houve com ele, do mais novo ao mais antigo. */
  historyOf(steamId: string): readonly VipView[] {
    const now = Date.now();

    return this.#deps.repository.historyOf(steamId).map((vip) => toVipView(vip, now));
  }

  /**
   * Os níveis que os servidores deste agente conhecem.
   *
   * A resposta vem dos `OrigemZVip.json`, e é por servidor: o mesmo
   * `gold` pode existir no `pvp1` e não existir no `pve`. É o que a
   * tela usa para oferecer os níveis em vez de um campo de texto —
   * e é o que o `grant` usa para recusar um nível que não vira
   * efeito em lugar nenhum.
   */
  async knownTiers(): Promise<Map<string, VipTierLevel & { readonly servers: string[] }>> {
    const byTier = new Map<string, VipTierLevel & { servers: string[] }>();

    for (const serverId of this.#deps.servers.ids()) {
      for (const level of await this.#levelsOf(serverId)) {
        const found = byTier.get(level.tier);

        if (found === undefined) {
          byTier.set(level.tier, { ...level, servers: [serverId] });
        } else {
          found.servers.push(serverId);
        }
      }
    }

    return byTier;
  }

  // ------------------------------------------------------
  //  Conceder e revogar
  // ------------------------------------------------------

  /**
   * Concede ou RENOVA, e aplica em quem estiver no ar.
   *
   * O banco primeiro, o jogo depois: um grupo concedido sem a linha
   * gravada é um VIP que some no próximo boot do agente e que
   * ninguém consegue revogar pela tela. O contrário — linha gravada
   * e servidor fora do ar — é o caso NORMAL, e a reconciliação da
   * próxima conexão resolve.
   *
   * @throws {ApiError} 400 no SteamID fora de formato, no nível que
   * nenhum servidor conhece e na data que já passou.
   */
  async grant(input: GrantVipInput): Promise<{
    readonly vip: VipView;
    readonly outcome: 'created' | 'extended';
    readonly results: readonly VipSyncResult[];
  }> {
    assertSteamId(input.steamId);

    const tier = input.tier.trim().toLowerCase();

    await this.#assertKnownTier(tier);

    if (input.expiresAt !== null && input.expiresAt <= Date.now()) {
      throw new ApiError(
        'VIP_ALREADY_EXPIRED',
        'A data de vencimento já passou. Um VIP que nasce vencido seria revogado pelo relógio na ' +
          'rodada seguinte, e a tela mostraria um benefício que some sozinho.',
        400,
      );
    }

    const { outcome, vip } = this.#deps.repository.grant({ ...input, tier });

    this.#deps.logger.info(
      {
        steamId: vip.steamId,
        tier: vip.tier,
        expiresAt: vip.expiresAt,
        origin: vip.origin,
        by: vip.createdBy,
        outcome,
      },
      outcome === 'created' ? 'VIP concedido' : 'VIP renovado',
    );

    this.#record(vip, outcome === 'created' ? 'ganhou' : 'renovou');

    return {
      vip: toVipView(vip, Date.now()),
      outcome,
      results: await this.syncAll(vip.steamId),
    };
  }

  /**
   * Revoga e tira o jogador do grupo.
   *
   * A linha FICA, com `revoked_at` e `revoked_by` — ver a migração
   * 010. Apagar responderia "quem é VIP?" e destruiria "quem JÁ
   * foi, de onde veio, e quem tirou".
   *
   * @throws {ApiError} 404 quando não há concessão aberta.
   */
  async revoke(
    steamId: string,
    tier: string,
    revokedBy: string | null,
  ): Promise<{ readonly vip: VipView; readonly results: readonly VipSyncResult[] }> {
    assertSteamId(steamId);

    const normalized = tier.trim().toLowerCase();
    const vip = this.#deps.repository.revoke(steamId, normalized, revokedBy);

    if (vip === null) {
      throw new ApiError(
        'VIP_NOT_FOUND',
        `${steamId} não tem VIP "${normalized}" ativo neste agente. Ele pode ter sido revogado em ` +
          'outra aba, ou vencido — recarregue a tela.',
        404,
      );
    }

    this.#deps.logger.warn({ steamId, tier: normalized, by: revokedBy }, 'VIP revogado');
    this.#record(vip, 'perdeu');

    return { vip: toVipView(vip, Date.now()), results: await this.syncAll(steamId) };
  }

  /**
   * Os que venceram: revoga e tira do grupo.
   *
   * É o que o relógio chama. `revoked_by` nulo com `revoked_at`
   * preenchido é a assinatura dele: ninguém revogou, o prazo
   * acabou.
   *
   * Rodar duas vezes seguidas não faz nada demais: a segunda não
   * encontra concessão vencida nenhuma, porque a primeira já as
   * fechou.
   */
  async sweepExpired(now: number = Date.now()): Promise<readonly VipRecord[]> {
    const expired = this.#deps.repository.expired(now);

    if (expired.length === 0) {
      return [];
    }

    const touched = new Set<string>();

    for (const vip of expired) {
      this.#deps.repository.revoke(vip.steamId, vip.tier, null, now);
      touched.add(vip.steamId);

      this.#deps.logger.info(
        { steamId: vip.steamId, tier: vip.tier },
        'VIP vencido: prazo acabou, benefício retirado',
      );

      this.#record(vip, 'venceu');
    }

    // O estado inteiro vai de novo para CADA servidor, e depois
    // cada jogador afetado é reaplicado: o payload tira o VIP do
    // cache do plugin, e o `apply` tira o jogador do grupo. Sem o
    // segundo, ele continuaria com a tag e a fila do VIP até
    // reconectar.
    for (const serverId of this.#deps.servers.ids()) {
      await this.#push(serverId, 'vip-expired');

      for (const steamId of touched) {
        await this.#applyPlayer(serverId, steamId);
      }
    }

    return expired;
  }

  // ------------------------------------------------------
  //  Sincronização
  // ------------------------------------------------------

  /**
   * Empurra o estado a todos os servidores e reaplica UM jogador.
   *
   * É o que roda depois de conceder e de revogar: o payload é
   * sempre o estado completo (ele não sabe quem mudou), e o `apply`
   * é pontual porque só um jogador mudou de situação.
   */
  async syncAll(steamId?: string): Promise<readonly VipSyncResult[]> {
    const results: VipSyncResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      const pushed = await this.#push(serverId, 'vip-changed');

      if (pushed.status !== 'sent') {
        results.push({
          serverId,
          players: 0,
          added: [],
          removed: [],
          adopted: [],
          skipped: describePush(serverId, pushed),
        });

        continue;
      }

      const added: string[] = [];

      if (steamId !== undefined && (await this.#applyPlayer(serverId, steamId))) {
        added.push(steamId);
      }

      results.push({
        serverId,
        players: Number(pushed.response.players ?? 0),
        added,
        removed: [],
        adopted: [],
        skipped: null,
      });
    }

    return results;
  }

  /**
   * Deixa os grupos daquele servidor iguais à tabela.
   *
   * As três situações estão no cabeçalho deste arquivo. O que vale
   * repetir aqui é o que ela NÃO faz: não tira do grupo quem o
   * agente não conhece (adota), e não age sobre um nível cujo grupo
   * ela não conseguiu ler.
   */
  async reconcile(serverId: string): Promise<VipSyncResult> {
    const rcon = this.#rconOf(serverId);

    if (!rcon.isConnected) {
      return skipped(
        serverId,
        `O agente não está falando com o RCON de "${serverId}" — o VIP dele será conferido ` +
          'quando ele voltar.',
      );
    }

    const levels = await this.#levelsOf(serverId);

    if (levels.length === 0) {
      // Sem níveis não há grupo para conferir. O payload ainda vai:
      // o `OrigemZAgent` guarda o VIP mesmo sem o OrigemZVip, e é
      // dele que a fila e o chat leem.
      const pushed = await this.#push(serverId, 'reconcile');

      return skipped(
        serverId,
        `Não sei quais grupos de VIP existem em "${serverId}": ${
          (await this.#tiersProblem(serverId)) ?? 'o OrigemZVip.json não declara nível nenhum.'
        }` +
          (pushed.status === 'sent'
            ? ' O estado foi empurrado ao OrigemZAgent mesmo assim.'
            : ' E o estado não pôde ser empurrado.'),
      );
    }

    const now = Date.now();
    const active = this.#deps.repository.active(now);

    // Quem deveria estar em CADA grupo: só o nível mais alto de
    // cada jogador. Ver o cabeçalho.
    const byPlayer = new Map<string, string[]>();

    for (const vip of active) {
      const tiers = byPlayer.get(vip.steamId);

      if (tiers === undefined) {
        byPlayer.set(vip.steamId, [vip.tier]);
      } else {
        tiers.push(vip.tier);
      }
    }

    const expected = new Map<string, Set<string>>(levels.map((level) => [level.group, new Set()]));

    for (const [steamId, tiers] of byPlayer) {
      const level = highestLevel(levels, tiers);

      if (level !== null) {
        expected.get(level.group)?.add(steamId);
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    const adopted: string[] = [];

    for (const level of levels) {
      let members: readonly string[];

      try {
        const raw = await rcon.send(`oxide.show group ${level.group}`);

        members = parseGroup(level.group, raw).members.map((member) => member.steamId);
      } catch (error) {
        // Não conseguir LER o grupo adia aquele nível, e não o
        // esvazia: supor "não tem ninguém" tiraria todo mundo do
        // grupo na próxima passada.
        this.#deps.logger.warn(
          { server: serverId, group: level.group, err: toError(error) },
          'não consegui ler os membros deste grupo; o nível fica para a próxima rodada',
        );

        continue;
      }

      const want = expected.get(level.group) ?? new Set<string>();

      // ---- no grupo, e o agente não sabe por quê ----
      for (const steamId of members) {
        if (want.has(steamId)) {
          continue;
        }

        // Ele tem VIP ativo de OUTRO nível? Então este grupo é
        // resíduo — o nível mais alto é que manda, e o plugin faria
        // a mesma limpeza no próximo `apply`.
        const hasOther = (byPlayer.get(steamId) ?? []).length > 0;

        // A linha mais recente daquele par, revogada ou não. Ver
        // `latestOf`: sem ela, revogar um VIP com o servidor fora
        // do ar faria a reconexão ADOTÁ-LO de volta.
        const known = this.#deps.repository.latestOf(steamId, level.tier);

        if (hasOther || known !== null) {
          if (await this.#setGroup(serverId, steamId, level.group, false)) {
            removed.push(steamId);
          }

          continue;
        }

        // Desconhecido: ADOTAR. Nunca tirar — ver o cabeçalho.
        if (!STEAM_ID_PATTERN.test(steamId)) {
          continue;
        }

        this.#deps.repository.grant(
          {
            steamId,
            tier: level.tier,
            // Vitalício: o agente não tem como saber que prazo
            // alguém combinou por fora, e inventar uma data faria o
            // relógio tirar, sozinho, um benefício que ele não deu.
            expiresAt: null,
            origin: 'adotado',
            createdBy: null,
          },
          now,
        );

        adopted.push(steamId);
      }

      // ---- na tabela, e fora do grupo ----
      const present = new Set(members);

      for (const steamId of want) {
        if (present.has(steamId)) {
          continue;
        }

        if (await this.#setGroup(serverId, steamId, level.group, true)) {
          added.push(steamId);
        }
      }
    }

    // O payload sai DEPOIS das adoções: elas mudam o estado, e
    // empurrar antes deixaria o plugin um passo atrás até a próxima
    // rodada.
    const pushed = await this.#push(serverId, 'reconcile');

    if (added.length + removed.length + adopted.length > 0) {
      this.#deps.logger.info(
        { server: serverId, added, removed, adopted },
        'VIP reconciliado com os grupos do Oxide',
      );
    }

    return {
      serverId,
      players: pushed.status === 'sent' ? Number(pushed.response.players ?? 0) : 0,
      added,
      removed,
      adopted,
      skipped: pushed.status === 'sent' ? null : describePush(serverId, pushed),
    };
  }

  /**
   * A rodada do boot: todos os servidores.
   *
   * Um servidor que falha não segura os outros — o dele fica para a
   * próxima, e o motivo vai para o log.
   */
  async reconcileAll(): Promise<readonly VipSyncResult[]> {
    const results: VipSyncResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      try {
        results.push(await this.reconcile(serverId));
      } catch (error) {
        this.#deps.logger.warn(
          { server: serverId, err: toError(error) },
          'não consegui reconciliar o VIP deste servidor',
        );
      }
    }

    return results;
  }

  // ------------------------------------------------------
  //  Ajudantes
  // ------------------------------------------------------

  /** O estado COMPLETO, no formato que o plugin espera. */
  #payload(now: number = Date.now()): { readonly players: Record<string, unknown[]> } {
    const players: Record<string, { tier: string; expiresAt: string | null }[]> = {};

    for (const vip of this.#deps.repository.active(now)) {
      const grants = players[vip.steamId];

      const grant = {
        tier: vip.tier,
        // `null` = VITALÍCIO. O plugin lê ausente, nulo e vazio da
        // mesma forma, mas mandar o campo explícito deixa o payload
        // legível para quem for depurar no console.
        expiresAt: vip.expiresAt === null ? null : new Date(vip.expiresAt).toISOString(),
      };

      if (grants === undefined) {
        players[vip.steamId] = [grant];
      } else {
        grants.push(grant);
      }
    }

    return { players };
  }

  async #push(serverId: string, trigger: string): Promise<PushOutcome> {
    return pushState({
      rcon: this.#rconOf(serverId),
      command: VIP_SYNC_COMMAND,
      payload: this.#payload(),
      logger: this.#deps.logger,
      trigger,
    });
  }

  /**
   * Pede que o servidor aplique os grupos daquele jogador.
   *
   * Primeiro pelo `origemz.vip.apply`, que é o próprio OrigemZVip
   * resolvendo o nome do grupo pelo config dele. Se o plugin não
   * estiver ali (o comando não existe, ou responde fora do
   * contrato), o agente faz o mesmo trabalho pelo módulo do Oxide —
   * com o nome do grupo lido do `OrigemZVip.json`.
   *
   * `false` = não deu. NÃO é erro: metade da lista costuma estar
   * parada, e a reconciliação da próxima conexão fecha a diferença.
   */
  async #applyPlayer(serverId: string, steamId: string): Promise<boolean> {
    const rcon = this.#rconOf(serverId);

    if (!rcon.isConnected) {
      return false;
    }

    try {
      const raw = await rcon.send(`${VIP_APPLY_COMMAND} ${steamId}`);
      const line = firstJsonLine(raw);

      if (line !== null && (line as { ok?: unknown }).ok === true) {
        return true;
      }
    } catch (error) {
      this.#deps.logger.debug(
        { server: serverId, steamId, err: toError(error) },
        `o ${VIP_APPLY_COMMAND} não respondeu; tentando pelos grupos do Oxide`,
      );
    }

    return this.#applyByOxide(serverId, steamId);
  }

  /**
   * O caminho de reserva: o agente mesmo mexe nos grupos.
   *
   * Só o nível MAIS ALTO recebe grupo, e os outros níveis são
   * retirados — a mesma regra do `SyncPlayer` do plugin. Fazer
   * diferente aqui faria os dois caminhos deixarem o servidor em
   * estados distintos, dependendo de qual rodou por último.
   */
  async #applyByOxide(serverId: string, steamId: string): Promise<boolean> {
    const levels = await this.#levelsOf(serverId);

    if (levels.length === 0) {
      return false;
    }

    const tiers = this.#deps.repository.activeOf(steamId).map((vip) => vip.tier);
    const wanted = highestLevel(levels, tiers);
    let changed = false;

    for (const level of levels) {
      const member = wanted !== null && level.group === wanted.group;

      if (await this.#setGroup(serverId, steamId, level.group, member)) {
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Põe ou tira alguém de um grupo, pelo módulo do Oxide.
   *
   * `false` quando não deu — e o motivo vai para o log em `debug`:
   * o Oxide recusa quem ele nunca viu ("Player 'x' not found"), e
   * isso é rotina num VIP comprado por quem ainda não entrou.
   */
  async #setGroup(
    serverId: string,
    steamId: string,
    group: string,
    member: boolean,
  ): Promise<boolean> {
    try {
      await setUserGroup(this.#rconOf(serverId), steamId, group, member);
      return true;
    } catch (error) {
      this.#deps.logger.debug(
        { server: serverId, steamId, group, member, err: toError(error) },
        'o Oxide não aceitou a mudança de grupo',
      );

      return false;
    }
  }

  /** Os níveis daquele servidor, lidos do `OrigemZVip.json`. */
  async #levelsOf(serverId: string): Promise<readonly VipTierLevel[]> {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      return [];
    }

    return (await readVipTiers(config.paths.oxideConfigDir)).levels;
  }

  async #tiersProblem(serverId: string): Promise<string | null> {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      return `o servidor "${serverId}" não existe neste agente.`;
    }

    return (await readVipTiers(config.paths.oxideConfigDir)).problem;
  }

  /**
   * @throws {ApiError} 400 quando nenhum servidor conhece o nível.
   *
   * Recusar é melhor que aceitar: um VIP de um nível que não existe
   * em servidor nenhum é dinheiro cobrado por um benefício que
   * nunca chega — e ele ficaria na tela como ativo, sem nada
   * acusando o problema.
   */
  async #assertKnownTier(tier: string): Promise<void> {
    const known = await this.knownTiers();

    if (known.has(tier)) {
      return;
    }

    const names = [...known.keys()];

    throw new ApiError(
      'UNKNOWN_VIP_TIER',
      `Nenhum servidor deste agente conhece o nível "${tier}". ` +
        (names.length === 0
          ? 'Nenhum servidor declarou níveis ainda: eles vêm do OrigemZVip.json de cada um, ' +
            'criado no primeiro carregamento do plugin.'
          : `Os que existem: ${names.join(', ')}.`),
      400,
    );
  }

  #rconOf(serverId: string): OpsRcon {
    return this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);
  }

  /**
   * A linha do tempo da ficha do jogador.
   *
   * O evento é gravado no PRIMEIRO servidor conhecido: a tabela
   * `player_events` exige um `server_id` (chave estrangeira), e o
   * VIP é de rede — não há um servidor certo. Sem servidor nenhum
   * cadastrado, o evento simplesmente não entra: perder uma linha
   * de histórico é melhor que derrubar uma concessão que já valeu.
   */
  #record(vip: VipRecord, what: 'ganhou' | 'renovou' | 'perdeu' | 'venceu'): void {
    const serverId = this.#deps.servers.ids()[0];

    if (this.#deps.history === undefined || serverId === undefined) {
      return;
    }

    const when =
      vip.expiresAt === null
        ? 'vitalício'
        : `até ${new Date(vip.expiresAt).toLocaleDateString('pt-BR')}`;

    const detail =
      what === 'perdeu'
        ? `VIP ${vip.tier} revogado`
        : what === 'venceu'
          ? `VIP ${vip.tier} venceu`
          : `VIP ${vip.tier} ${what} (${when})`;

    try {
      this.#deps.history.recordAction({
        steamId: vip.steamId,
        serverId,
        kind: 'vip',
        actor: what === 'venceu' ? null : (vip.createdBy ?? vip.revokedBy),
        detail,
      });
    } catch (error) {
      // Uma falha ao gravar histórico não pode desfazer uma
      // concessão que JÁ valeu.
      this.#deps.logger.debug(
        { steamId: vip.steamId, err: toError(error) },
        'não consegui registrar o VIP na ficha do jogador',
      );
    }
  }
}

/** Epoch ms -> ISO, com o `null` sobrevivendo. */
function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toVipView(vip: VipRecord | VipListRecord, now: number): VipView {
  return {
    id: vip.id,
    steamId: vip.steamId,
    tier: vip.tier,
    expiresAt: toIso(vip.expiresAt),
    origin: vip.origin,
    // `created_at` é NOT NULL: o `?? ''` é só o tipo.
    createdAt: toIso(vip.createdAt) ?? '',
    createdBy: vip.createdBy,
    revokedAt: toIso(vip.revokedAt),
    revokedBy: vip.revokedBy,
    active: isActive(vip, now),
    expired: vip.revokedAt === null && vip.expiresAt !== null && vip.expiresAt <= now,
    ...('playerName' in vip ? { playerName: vip.playerName } : {}),
  };
}

/** O desfecho de um push vira a frase que a tela mostra. */
function describePush(serverId: string, outcome: PushOutcome): string {
  switch (outcome.status) {
    case 'skipped':
      return `"${serverId}": ${outcome.reason}`;
    case 'refused':
      return (
        `O estado de VIP não coube num comando de console para "${serverId}" ` +
        `(${String(outcome.bytes)} bytes, teto de ${String(outcome.limitBytes)}). NADA foi ` +
        'enviado: meio estado faria o plugin trocar um cache íntegro por um incompleto.'
      );
    case 'failed':
      return `Não consegui empurrar o VIP para "${serverId}": ${outcome.error.message}`;
    default:
      return `"${serverId}" respondeu de um jeito que não reconheço.`;
  }
}

function skipped(serverId: string, reason: string): VipSyncResult {
  return { serverId, players: 0, added: [], removed: [], adopted: [], skipped: reason };
}
