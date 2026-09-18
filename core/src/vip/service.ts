// ============================================================
//  service.ts  -  a VipList: quem é VIP, ONDE, e os dois lugares
//  onde isso vira efeito dentro do jogo.
//
//  ------------------------------------------------------------
//  ####  O VIP É DO SERVIDOR ONDE FOI COMPRADO  ####
//
//  Decisão do dono em 17/09/2026, que desfaz a do briefing
//  (Docs\15: "o VIP é de REDE"). Quem compra no `pvp1` é VIP no
//  `pvp1`; o VIP de REDE continua existindo, mas agora é uma escolha
//  de quem vende (`serverId: null`), e não o que acontece sozinho.
//
//  Na prática isto quer dizer que TODA pergunta feita aqui tem um
//  servidor junto: o payload de cada um leva só quem vale nele, a
//  reconciliação compara o grupo do Oxide com esse recorte, e a
//  adoção carimba o servidor em que o jogador foi encontrado. Ver
//  db/vips-repository.ts.
//
//  ------------------------------------------------------------
//  A fonte é a tabela `vips`. Cada servidor recebe o estado DELE
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
//
//  ####  E ELA NÃO É A ÚNICA MEXENDO NOS GRUPOS  ####
//
//  A reconciliação tira um retrato do banco e depois passa segundos
//  no RCON, um `oxide.show group` por nível. Nesse meio-tempo a
//  fila do site entrega VIP, o painel concede e o relógio expira —
//  e a decisão que ela tomar com o retrato velho vira comando de
//  console mesmo assim.
//
//  MEDIDO em 04/09/2026, no boot: uma entrega coube entre a
//  primeira e a terceira leitura de grupo, e a reconciliação tirou
//  do grupo o VIP que o `origemz.vip.apply` acabara de dar. Por
//  isso as duas decisões que MEXEM no grupo releem o estado antes
//  de agir (`#topGroupNow`), e por isso duas passadas do mesmo
//  servidor não rodam juntas (`#reconciling`).
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
  /**
   * A tabela mudou: o espelho do site tem o que contar.
   *
   * ####  ELE É LATÊNCIA, E NUNCA CORRETUDE  ####
   *
   * O `VipSiteMirror` recalcula o estado a cada volta do relógio e
   * só empurra quando o hash muda — ou seja, ele descobre TUDO
   * sozinho, inclusive um caminho novo que esqueça de avisar aqui.
   * Este gancho existe para o site saber em dois segundos, e não em
   * um minuto, que alguém concedeu VIP pelo painel.
   *
   * Por isso ele não lança e ninguém o espera: uma falha de push
   * não pode desfazer uma concessão já gravada.
   */
  readonly onChanged?: (() => void) | undefined;
}

/** Uma concessão como a API a mostra. Datas em ISO. */
export interface VipView {
  readonly id: number;
  readonly steamId: string;
  readonly tier: string;
  /** Onde ele vale. `null` = a REDE inteira. */
  readonly serverId: string | null;
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
  /**
   * Onde o VIP vale. `null` = a REDE inteira.
   *
   * Obrigatório, sem default: quem concede responde onde. Ver
   * `VipGrantInput`, em db/vips-repository.ts.
   */
  readonly serverId: string | null;
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

  /**
   * Os servidores com uma reconciliação em andamento.
   *
   * Ver `reconcile`: duas passadas ao mesmo tempo decidem com
   * retratos diferentes e escrevem uma por cima da outra.
   */
  readonly #reconciling = new Set<string>();

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
    /** Só os que valem naquele servidor. Ausente = todos. */
    readonly where?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  }): { readonly vips: readonly VipView[]; readonly total: number } {
    const now = Date.now();
    const page = this.#deps.repository.list(options, now);

    return { vips: page.vips.map((vip) => toVipView(vip, now)), total: page.total };
  }

  /**
   * Os níveis que este jogador tem AGORA valendo em `where`.
   *
   * `where` é o id de um servidor — e a resposta inclui o VIP de
   * rede. `ANY_SERVER` só para a FICHA, que mostra o que a pessoa
   * tem sem decidir nada com isso.
   */
  activeOf(steamId: string, where: string): readonly VipView[] {
    const now = Date.now();

    return this.#deps.repository.activeOf(steamId, where, now).map((vip) => toVipView(vip, now));
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

    this.#assertKnownServer(input.serverId);
    await this.#assertKnownTier(tier, input.serverId);

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
        // `null` no log é a REDE. Sai explícito porque é a primeira
        // pergunta de quem investiga "ele diz que comprou e não
        // tem": comprou onde?
        serverId: vip.serverId,
        expiresAt: vip.expiresAt,
        origin: vip.origin,
        by: vip.createdBy,
        outcome,
      },
      outcome === 'created' ? 'VIP concedido' : 'VIP renovado',
    );

    this.#record(vip, outcome === 'created' ? 'ganhou' : 'renovou');
    this.#deps.onChanged?.();

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
   * ####  O ESCOPO FAZ PARTE DA IDENTIDADE  ####
   *
   * Revogar o `gold` do `pvp1` não toca no `gold` de REDE do mesmo
   * jogador: são duas concessões, provavelmente pagas à parte. Quem
   * quer tirar as duas chama duas vezes — e é bom que precise
   * dizer isso em voz alta.
   *
   * @throws {ApiError} 404 quando não há concessão aberta NAQUELE
   * escopo.
   */
  async revoke(
    steamId: string,
    tier: string,
    serverId: string | null,
    revokedBy: string | null,
  ): Promise<{ readonly vip: VipView; readonly results: readonly VipSyncResult[] }> {
    assertSteamId(steamId);

    const normalized = tier.trim().toLowerCase();
    const vip = this.#deps.repository.revoke(steamId, normalized, serverId, revokedBy);

    if (vip === null) {
      throw new ApiError(
        'VIP_NOT_FOUND',
        `${steamId} não tem VIP "${normalized}" ativo ${whereLabel(serverId)}. Ele pode ter sido ` +
          'revogado em outra aba, ou vencido — recarregue a tela.',
        404,
      );
    }

    this.#deps.logger.warn({ steamId, tier: normalized, serverId, by: revokedBy }, 'VIP revogado');
    this.#record(vip, 'perdeu');
    this.#deps.onChanged?.();

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
      // O `revokedBy` nulo é a assinatura do relógio; o `vip.serverId`
      // é o escopo daquela linha, e passá-lo é o que impede o
      // vencimento do VIP de um servidor de fechar o de rede.
      this.#deps.repository.revoke(vip.steamId, vip.tier, vip.serverId, null, now);
      touched.add(vip.steamId);

      this.#deps.logger.info(
        { steamId: vip.steamId, tier: vip.tier, serverId: vip.serverId },
        'VIP vencido: prazo acabou, benefício retirado',
      );

      this.#record(vip, 'venceu');
    }

    this.#deps.onChanged?.();

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
   *
   * ####  UMA POR SERVIDOR, DE CADA VEZ  ####
   *
   * O boot e o gancho `onRconConnected` a chamam sem `await`, e uma
   * reconexão no meio do boot dispara as duas. Duas passadas
   * simultâneas leem os mesmos grupos, decidem com retratos
   * diferentes e mandam `usergroup add`/`remove` uma por cima da
   * outra — o estado final vira quem chegou por último.
   *
   * A segunda chamada não enfileira: ela devolve `skipped`. Quem
   * ressincroniza depois de um wipe ou de um reload não precisa de
   * duas passadas, precisa de uma que termine.
   */
  async reconcile(serverId: string): Promise<VipSyncResult> {
    if (this.#reconciling.has(serverId)) {
      return skipped(
        serverId,
        `Já há uma reconciliação de VIP em andamento em "${serverId}". Esta rodada foi dispensada ` +
          '— duas ao mesmo tempo decidiriam com retratos diferentes.',
      );
    }

    this.#reconciling.add(serverId);

    try {
      return await this.#reconcileOnce(serverId);
    } finally {
      this.#reconciling.delete(serverId);
    }
  }

  async #reconcileOnce(serverId: string): Promise<VipSyncResult> {
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
    // Só quem vale NESTE servidor: os VIPs dele mais os de rede. Com
    // a lista inteira, o `pve` poria no grupo quem comprou no `pvp1`.
    const active = this.#deps.repository.activeIn(serverId, now);

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

        // A linha mais recente daquele par AQUI, revogada ou não. Ver
        // `latestOf`: sem ela, revogar um VIP com o servidor fora
        // do ar faria a reconexão ADOTÁ-LO de volta.
        const known = this.#deps.repository.latestOf(steamId, level.tier, serverId);

        if (hasOther || known !== null) {
          // ####  O RETRATO É VELHO, E TIRAR É IRREVERSÍVEL  ####
          //
          // `want` veio de um `active()` lido ANTES das idas ao
          // RCON, e entre ele e agora cabe uma concessão inteira:
          // MEDIDO em 04/09/2026, a fila do site entregou um VIP no
          // boot e esta linha o tirou do grupo que o
          // `origemz.vip.apply` acabara de dar. O jogador ficou com
          // a tag e a fila (que vêm do payload) e sem as permissões
          // — e só a reconciliação seguinte, dias depois, o
          // consertaria.
          //
          // Reler custa uma consulta local contra um round-trip de
          // RCON que já foi pago. E repare que só ela é ao vivo no
          // laço: era o `latestOf` decidindo com dado novo em cima
          // de um retrato velho que produzia a remoção.
          if (this.#topGroupNow(serverId, steamId, levels) === level.group) {
            continue;
          }

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
            // ####  A ADOÇÃO É DESTE SERVIDOR, NUNCA DA REDE  ####
            //
            // O grupo do Oxide em que ele foi encontrado é de UM
            // servidor: foi ali que alguém tomou a decisão. Adotar
            // como VIP de rede ALARGARIA, sozinho, um benefício que
            // ninguém concedeu nos outros — e o agente faria isso
            // toda vez que alguém mexesse num grupo à mão.
            serverId,
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

        // O simétrico da remoção, e pelo mesmo motivo: uma
        // revogação feita no meio da passada seria DESFEITA aqui,
        // devolvendo o grupo a quem acabou de perdê-lo.
        if (this.#topGroupNow(serverId, steamId, levels) !== level.group) {
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

    // Só a ADOÇÃO muda a tabela — `added` e `removed` mexem no grupo
    // do Oxide para casar com o que a tabela já dizia, e o retrato
    // do site sairia idêntico.
    if (adopted.length > 0) {
      this.#deps.onChanged?.();
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

  /**
   * O estado COMPLETO **daquele servidor**, no formato que o plugin
   * espera.
   *
   * ####  ESTE RECORTE É A MUDANÇA INTEIRA  ####
   *
   * O cache do `OrigemZAgent` é por servidor (cada um tem o seu), e é
   * dele que a fila, o chat e o `origemz.vip.apply` leem. Mandar a
   * tabela toda para todos era o que fazia o VIP comprado no `pvp1`
   * valer no `pve` — e o plugin não muda nada para isso ser
   * corrigido: ele continua recebendo "quem é VIP aqui".
   *
   * ####  DUAS LINHAS DO MESMO NÍVEL VIRAM UMA  ####
   *
   * Quem tem `gold` de rede e `gold` deste servidor aparece uma vez
   * só, com o vencimento que dura MAIS (vitalício ganha de todos).
   * Duas entradas do mesmo tier deixariam o plugin escolher, e a
   * escolha dele é a ordem do array — ou seja, sorte.
   */
  #payload(serverId: string, now: number = Date.now()): {
    readonly players: Record<string, unknown[]>;
  } {
    const players: Record<string, { tier: string; expiresAt: string | null }[]> = {};

    for (const vip of this.#deps.repository.activeIn(serverId, now)) {
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
        continue;
      }

      const same = grants.find((entry) => entry.tier === grant.tier);

      if (same === undefined) {
        grants.push(grant);
        continue;
      }

      // `null` é vitalício e ganha de qualquer data. Entre duas datas
      // vence a maior — e a comparação de texto serve porque as duas
      // saem do mesmo `toISOString()`: UTC, com o mesmo formato e o
      // mesmo comprimento, a ordem alfabética é a cronológica.
      if (same.expiresAt !== null && (grant.expiresAt === null || grant.expiresAt > same.expiresAt)) {
        same.expiresAt = grant.expiresAt;
      }
    }

    return { players };
  }

  async #push(serverId: string, trigger: string): Promise<PushOutcome> {
    return pushState({
      rcon: this.#rconOf(serverId),
      command: VIP_SYNC_COMMAND,
      payload: this.#payload(serverId),
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

      if (applyAccepted(raw)) {
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

    const tiers = this.#deps.repository.activeOf(steamId, serverId).map((vip) => vip.tier);
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
  /**
   * Em que grupo este jogador deve estar AGORA. `null` = nenhum.
   *
   * A pergunta é a mesma do retrato do `reconcile` — o nível mais
   * alto entre os VIPs ativos —, só que respondida no instante em
   * que a decisão vai virar comando de console. Ver a remoção, no
   * `#reconcileOnce`.
   */
  #topGroupNow(
    serverId: string,
    steamId: string,
    levels: readonly VipTierLevel[],
  ): string | null {
    const tiers = this.#deps.repository.activeOf(steamId, serverId).map((vip) => vip.tier);

    return highestLevel(levels, tiers)?.group ?? null;
  }

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
   * @throws {ApiError} 404 quando o servidor pedido não existe aqui.
   *
   * Um id errado (um `pvp01` onde o certo é `pvp1`) gravaria uma
   * concessão que NENHUM servidor lê: ela ficaria na tela como ativa,
   * o jogador pagaria, e nada no caminho acusaria o engano. `null` é
   * a rede, e passa.
   */
  #assertKnownServer(serverId: string | null): void {
    if (serverId === null || this.#deps.servers.ids().includes(serverId)) {
      return;
    }

    throw new ApiError(
      'UNKNOWN_SERVER',
      `Não existe servidor com o id "${serverId}" neste agente. Os que existem: ` +
        `${this.#deps.servers.ids().join(', ') || '(nenhum)'}. Para um VIP que vale em todos, ` +
        'não mande servidor nenhum.',
      404,
    );
  }

  /**
   * @throws {ApiError} 400 quando o nível não existe ONDE o VIP vai
   * valer.
   *
   * Recusar é melhor que aceitar: um VIP de um nível que aquele
   * servidor não declara é dinheiro cobrado por um benefício que
   * nunca chega — e ele ficaria na tela como ativo, sem nada
   * acusando o problema.
   *
   * ####  A PERGUNTA MUDOU JUNTO COM O ESCOPO  ####
   *
   * Antes bastava que ALGUM servidor conhecesse o nível, porque o VIP
   * valia em todos. Agora, um `gold` que só o `pvp1` declara é um
   * `gold` que não vira nada no `pve` — e vender ali é o mesmo
   * dinheiro cobrado por nada. O VIP de REDE mantém a regra antiga:
   * ele vale onde existir, e recusá-lo porque um servidor não declara
   * o nível tiraria do ar a venda que funciona nos outros.
   */
  async #assertKnownTier(tier: string, serverId: string | null): Promise<void> {
    const known = await this.knownTiers();
    const level = known.get(tier);

    if (level !== undefined && (serverId === null || level.servers.includes(serverId))) {
      return;
    }

    const names = [...known.keys()];

    if (level !== undefined && serverId !== null) {
      throw new ApiError(
        'UNKNOWN_VIP_TIER',
        `O servidor "${serverId}" não conhece o nível "${tier}" — ele existe em ` +
          `${level.servers.join(', ')}. Um VIP desse nível ali não viraria efeito nenhum.`,
        400,
      );
    }

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
   * O evento vai para o servidor DA CONCESSÃO. O VIP de rede não tem
   * um, e aí cai no primeiro conhecido: a tabela `player_events`
   * exige um `server_id` (chave estrangeira) e nenhum deles é mais
   * certo que o outro. Sem servidor nenhum cadastrado, o evento
   * simplesmente não entra — perder uma linha de histórico é melhor
   * que derrubar uma concessão que já valeu.
   */
  #record(vip: VipRecord, what: 'ganhou' | 'renovou' | 'perdeu' | 'venceu'): void {
    const serverId = vip.serverId ?? this.#deps.servers.ids()[0];

    if (this.#deps.history === undefined || serverId === undefined) {
      return;
    }

    const when =
      vip.expiresAt === null
        ? 'vitalício'
        : `até ${new Date(vip.expiresAt).toLocaleDateString('pt-BR')}`;

    // O escopo entra na frase: a ficha é lida por quem atende o
    // jogador, e "comprei VIP e não tenho" quase sempre é "comprou
    // no outro servidor".
    const scope = vip.serverId === null ? ' na rede' : ` em ${vip.serverId}`;

    const detail =
      what === 'perdeu'
        ? `VIP ${vip.tier}${scope} revogado`
        : what === 'venceu'
          ? `VIP ${vip.tier}${scope} venceu`
          : `VIP ${vip.tier}${scope} ${what} (${when})`;

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

/**
 * O `origemz.vip.apply` deu certo?
 *
 * ####  A RESPOSTA DELE CHEGA COMO LINHA DE LOG  ####
 *
 * MEDIDO no `server01`. Mandando `origemz.vip.apply 7656…`, o que
 * volta pelo RCON é
 *
 *     [OrigemZVip] origemz.vip.apply 7656…: nivel gold, 1 grupo(s)
 *     concedido(s) e 0 retirado(s).
 *
 * e NÃO o `{"ok":true,…}` que o cabeçalho do comando promete. A
 * causa está documentada no próprio `OrigemZAgent.cs`: um `Puts`
 * dentro de um `ConsoleCommand` sai com o MESMO Identifier do
 * pedido e ANTES do `arg.ReplyWith` — o agente casa a primeira
 * mensagem não-diagnóstica com o identifier, então a linha de log
 * chega no lugar da resposta. O `OrigemZAgent` resolveu isso
 * adiando o `Puts` um frame; o `OrigemZVip` ainda não.
 *
 * Reconhecer as duas formas é o que evita o agente concluir que o
 * plugin não respondeu e refazer o trabalho inteiro pelo
 * `oxide.usergroup` — o desfecho seria o mesmo, mas com o dobro de
 * comandos e um aviso no log a cada concessão.
 */
function applyAccepted(raw: string): boolean {
  const line = firstJsonLine(raw);

  if (line !== null && (line as { ok?: unknown }).ok === true) {
    return true;
  }

  // A linha de log do plugin. `nivel` sem acento porque o fonte
  // dele é ASCII puro de propósito (ver o cabeçalho do lang).
  return new RegExp(`${VIP_APPLY_COMMAND}\\s+\\d{17}:\\s*nivel`, 'i').test(raw);
}

/** Epoch ms -> ISO, com o `null` sobrevivendo. */
function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** "no pvp1" / "na rede" — o pedaço de frase que diz ONDE. */
function whereLabel(serverId: string | null): string {
  return serverId === null ? 'na rede' : `em "${serverId}"`;
}

function toVipView(vip: VipRecord | VipListRecord, now: number): VipView {
  return {
    id: vip.id,
    steamId: vip.steamId,
    tier: vip.tier,
    serverId: vip.serverId,
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
