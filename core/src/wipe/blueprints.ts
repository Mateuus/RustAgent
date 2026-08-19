// ============================================================
//  blueprints.ts  -  o que o jogador SABE atravessa o wipe.
//
//  Três peças, nesta ordem:
//
//      1. a RÉGUA         quanto cada nível de VIP leva de volta
//      2. o SNAPSHOT      o que cada jogador sabia ANTES de apagar
//      3. a DEVOLUÇÃO     no login, contra o VIP VIGENTE
//
//  ####  O SNAPSHOT É DE TODO MUNDO  ####
//
//  E não só de quem é VIP. Salvar só de VIP criaria o caso em que
//  alguém compra VIP no dia seguinte ao wipe e não tem o que
//  restaurar — o snapshot é barato (uma lista de inteiros por
//  jogador), e o direito é conferido na DEVOLUÇÃO, contra o VIP
//  daquele instante.
//
//  ####  E ELE VALE PARA O WIPE SEGUINTE, E SÓ ELE  ####
//
//  Cada snapshot novo expira o anterior (ver bp-repository.ts).
//  Restaurar o BP de três wipes atrás é ressuscitar vantagem que
//  ninguém lembra ter dado.
//
//  ------------------------------------------------------------
//  ####  A DEVOLUÇÃO ACONTECE NO LOGIN, E NÃO NO BOOT  ####
//
//  `PlayerBlueprints.UnlockList` mexe no `PersistantPlayerInfo` de
//  um `BasePlayer` carregado: sem o jogador no mundo não há o que
//  chamar. Por isso o relógio daqui só manda para quem está
//  ONLINE, e o plugin ainda mantém uma fila própria para quem
//  desconectar entre a leitura e o comando.
//
//  ####  FALHAR O SNAPSHOT NÃO CANCELA O WIPE  ####
//
//  Quem decide isso é wipe/run.ts, e a decisão está lá: um wipe
//  travado porque o export não respondeu é pior que um wipe sem
//  devolução. O que este arquivo garante é que a falha é RUIDOSA —
//  ela lança, com a frase pronta para o log da execução.
//
//  ####  E O AGENTE É QUEM DECIDE  ####
//
//  O plugin não sabe o que é VIP, nem bancada, nem atraso. Ele
//  responde "o que este jogador sabe" e aplica "esta lista". Toda
//  a política mora aqui.
// ============================================================

import { z } from 'zod';

import type { BpRestoreRecord, BpRepository, BpSnapshotEntry } from '../db/bp-repository.js';
import { firstJsonLine } from '../game/plugin-contract.js';
import { MAX_PUSH_BYTES, encodePushPayload, pushState } from '../game/plugin-push.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

// ------------------------------------------------------------
//  §1  A RÉGUA
// ------------------------------------------------------------

/**
 * Quanto um nível leva de volta.
 *
 *   none   nada — ele recomeça do zero como todo mundo
 *   bench  tudo o que o jogo libera até aquela bancada
 *   all    tudo o que ele sabia
 */
export const BP_RULE_MODES = ['none', 'bench', 'all'] as const;

/** Uma das três formas de recortar o que volta. */
export type BpRuleMode = (typeof BP_RULE_MODES)[number];

/** A bancada mais alta do jogo. Acima dela, `all` é a resposta. */
export const MAX_BENCH = 3;

export interface BpTierRule {
  readonly mode: BpRuleMode;
  /** 1, 2 ou 3. Só vale com `mode: 'bench'`. */
  readonly bench: number;
}

export interface BpSettings {
  /** A régua, por nível de VIP. A chave é o `tier` minúsculo. */
  readonly tiers: Readonly<Record<string, BpTierRule>>;
  /**
   * Quantas horas DEPOIS do wipe a devolução é liberada.
   *
   * `0` = assim que o jogador entrar. Com atraso, a corrida
   * inicial acontece sem a vantagem — é a manopla que separa
   * "vantagem" de "servidor decidido no primeiro dia".
   */
  readonly delayHours: number;
}

/**
 * O padrão de Docs\16 §14: bronze até a bancada 1, silver até a 2,
 * gold tudo, sem atraso. Editável na sub-aba Blueprints.
 */
export const DEFAULT_BP_SETTINGS: BpSettings = {
  tiers: {
    bronze: { mode: 'bench', bench: 1 },
    silver: { mode: 'bench', bench: 2 },
    gold: { mode: 'all', bench: MAX_BENCH },
  },
  delayHours: 0,
};

/** O teto do atraso: uma semana. Acima disso o snapshot já expirou. */
export const MAX_BP_DELAY_HOURS = 168;

/**
 * Quão generosa é uma regra, para comparar duas.
 *
 * ####  O JOGADOR LEVA O MELHOR DOS NÍVEIS QUE TEM  ####
 *
 * Quem tem `bronze` e `gold` ao mesmo tempo (comprou os dois, ou
 * ganhou um de brinde) leva o do `gold`. A alternativa seria
 * escolher pela ordem do `Rank` do OrigemZVip.json, e ela mentiria
 * no dia em que alguém desse um nível alto sem rank declarado.
 */
export function ruleScore(rule: BpTierRule): number {
  if (rule.mode === 'all') {
    return 1_000;
  }

  if (rule.mode === 'none') {
    return 0;
  }

  return Math.max(1, Math.min(MAX_BENCH, Math.round(rule.bench)));
}

/** A regra que vale para quem tem estes níveis. `null` = nenhuma. */
export function bestRuleOf(
  settings: BpSettings,
  tiers: readonly string[],
): { readonly tier: string; readonly rule: BpTierRule } | null {
  let best: { readonly tier: string; readonly rule: BpTierRule } | null = null;

  for (const raw of tiers) {
    const tier = raw.trim().toLowerCase();
    const rule = settings.tiers[tier];

    if (rule === undefined || rule.mode === 'none') {
      continue;
    }

    if (best === null || ruleScore(rule) > ruleScore(best.rule)) {
      best = { tier, rule };
    }
  }

  return best;
}

/**
 * O recorte de uma lista de blueprints por uma regra.
 *
 * `benchOf` devolve a bancada que o JOGO exige para aquele item —
 * ela vem do plugin, no `origemz.bp.export`, e é a única fonte
 * dela: o catálogo de itens do agente não a carrega. Item que o
 * mapa não conhece vale 0 (não exige bancada), que é o que a
 * ausência significa no protocolo.
 */
export function itemsForRule(
  rule: BpTierRule,
  items: readonly number[],
  benchOf: (itemId: number) => number,
): readonly number[] {
  if (rule.mode === 'none') {
    return [];
  }

  if (rule.mode === 'all') {
    return [...items];
  }

  const ceiling = Math.max(1, Math.min(MAX_BENCH, Math.round(rule.bench)));

  return items.filter((itemId) => benchOf(itemId) <= ceiling);
}

// ------------------------------------------------------------
//  §2  O CONTRATO COM O PLUGIN
// ------------------------------------------------------------

/** Os dois comandos novos do `OrigemZAgent`. */
export const BP_COMMANDS = {
  export: 'origemz.bp.export',
  restore: 'origemz.bp.restore',
} as const;

/** Padrão e teto do `limit`, iguais aos do plugin. */
export const BP_EXPORT_DEFAULT_LIMIT = 25;
export const BP_EXPORT_MAX_LIMIT = 100;

/**
 * O código que o plugin devolve quando a PÁGINA não coube no frame
 * do RCON.
 *
 * Ele recusa a página inteira em vez de cortá-la — resposta
 * truncada chega aqui como JSON inválido, e um BP pela metade
 * *parece* ter funcionado. Quem recebe este código diminui o
 * `limit` e pede de novo.
 */
export const BP_TOO_LARGE = 'PAYLOAD_TOO_LARGE';

const bpExportOkSchema = z.object({
  ok: z.literal(true),
  /** O TOTAL de jogadores conhecidos, e não o tamanho da página. */
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  players: z.array(
    z.object({
      steamId: z.string().regex(/^\d{17}$/),
      items: z.array(z.number().int()),
    }),
  ),
  /** `{ "<itemId>": bancada }`. Ausente = 0, e é o caso comum. */
  benches: z.record(z.string(), z.number().int().nonnegative()),
});

const bpErrorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

const bpExportResponseSchema = z.discriminatedUnion('ok', [bpExportOkSchema, bpErrorSchema]);

const bpRestoreOkSchema = z.object({
  ok: z.literal(true),
  players: z.number().int().nonnegative(),
  /** Quantos receberam AGORA (o BasePlayer estava carregado). */
  applied: z.number().int().nonnegative(),
  /** Quantos ficaram na fila do plugin, para o próximo login. */
  queued: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  pending: z.array(z.string()),
});

export type BpExportPage = z.infer<typeof bpExportOkSchema>;
export type BpRestoreReply = z.infer<typeof bpRestoreOkSchema>;

export function buildBpExportCommand(offset: number, limit: number): string {
  return `${BP_COMMANDS.export} ${String(offset)} ${String(limit)}`;
}

/**
 * Uma página do export, já conferida contra o contrato.
 *
 * `null` quer dizer "esta página não coube" (`PAYLOAD_TOO_LARGE`),
 * e quem chama reduz o `limit`. Qualquer outra recusa LANÇA: um
 * snapshot vazio que se disfarça de sucesso é o pior desfecho
 * possível — o wipe apagaria os blueprints de todo mundo com o
 * agente achando que guardou uma cópia.
 */
export async function fetchBpPage(
  rcon: OpsRcon,
  offset: number,
  limit: number,
): Promise<BpExportPage | null> {
  const raw = await rcon.send(buildBpExportCommand(offset, limit));
  const line = firstJsonLine(raw);

  if (line === null) {
    throw new Error(
      `o servidor respondeu ao ${BP_COMMANDS.export} sem nenhuma linha de JSON (veio: ` +
        `${raw.trim().slice(0, 200)}). O OrigemZAgent está carregado neste servidor?`,
    );
  }

  const parsed = bpExportResponseSchema.safeParse(line);

  if (!parsed.success) {
    throw new Error(
      `a resposta do ${BP_COMMANDS.export} não bate com o contrato do plugin: ` +
        JSON.stringify(line).slice(0, 200),
    );
  }

  if (!parsed.data.ok) {
    if (parsed.data.error === BP_TOO_LARGE) {
      return null;
    }

    throw new Error(`o plugin recusou o ${BP_COMMANDS.export}: ${parsed.data.error}`);
  }

  return parsed.data;
}

// ------------------------------------------------------------
//  §3  O SERVIÇO
// ------------------------------------------------------------

/** O que o serviço precisa saber sobre VIP. Ver db/vips-repository.ts. */
export interface BpVips {
  activeOf(steamId: string, now?: number): readonly { readonly tier: string }[];
}

/** O recorte do supervisor que a devolução usa. */
export interface BpServers {
  ids(): readonly string[];
  /** `null` = o agente não está cuidando deste servidor. */
  rconOf(serverId: string): OpsRcon | null;
}

export interface BlueprintServiceDeps {
  readonly repository: BpRepository;
  readonly vips: BpVips;
  readonly servers: BpServers;
  /**
   * Quem está online AGORA, por SteamID.
   *
   * `null` = não deu para perguntar, e isso é DIFERENTE de "não há
   * ninguém": com `null` a rodada não faz nada e tenta de novo,
   * em vez de concluir que o servidor está vazio.
   */
  readonly online: (serverId: string) => Promise<readonly string[] | null>;
  readonly logger?: Logger | undefined;
}

/** De quanto em quanto tempo o relógio procura devolução vencida. */
export const DEFAULT_BP_SWEEP_INTERVAL_MS = 30_000;

/** Quantas devoluções cabem numa rodada, por servidor. */
const MAX_DELIVERIES_PER_SWEEP = 100;

/**
 * Depois de tantas tentativas sem sucesso, a devolução vira
 * `failed`.
 *
 * Sem teto, um jogador com um payload que o plugin sempre recusa
 * seria retentado a cada trinta segundos até o wipe seguinte — e o
 * log da rodada viraria ruído que esconde o resto.
 */
export const MAX_RESTORE_ATTEMPTS = 5;

export interface BpSnapshotResult {
  readonly players: number;
  readonly items: number;
  /** Páginas que o plugin recusou por tamanho e foram refeitas menores. */
  readonly shrunkPages: number;
}

export class BlueprintService {
  readonly #deps: BlueprintServiceDeps;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  /** Uma rodada por vez. Ver o relógio dos VIPs. */
  #running = false;

  constructor(deps: BlueprintServiceDeps, intervalMs: number = DEFAULT_BP_SWEEP_INTERVAL_MS) {
    this.#deps = deps;
    this.#intervalMs = intervalMs;
  }

  // ----------------------------------------------------------
  //  O SNAPSHOT
  // ----------------------------------------------------------

  /**
   * Lê o que TODO MUNDO sabe e grava, de uma vez.
   *
   * ####  OU GRAVA INTEIRO, OU NÃO GRAVA  ####
   *
   * As páginas são acumuladas em memória e escritas numa transação
   * só. Gravar página a página deixaria um snapshot pela metade —
   * metade dos jogadores com o que sabiam, metade sem nada, e
   * ninguém sabendo qual metade.
   *
   * @throws quando o RCON não responde, o plugin não está carregado
   * ou a resposta não bate com o contrato. Quem chama (wipe/run.ts)
   * transforma isso num passo com aviso, e NÃO num wipe cancelado.
   */
  async snapshot(input: {
    readonly serverId: string;
    readonly wipeRunId: number | null;
    readonly now?: number;
  }): Promise<BpSnapshotResult> {
    const rcon = this.#deps.servers.rconOf(input.serverId);

    if (rcon === null || !rcon.isConnected) {
      throw new Error(
        `o RCON do servidor "${input.serverId}" está fora do ar. O snapshot de blueprints só ` +
          'existe com o servidor NO AR e o OrigemZAgent carregado — é o plugin que lê o que cada ' +
          'jogador aprendeu.',
      );
    }

    const entries: BpSnapshotEntry[] = [];
    const benches = new Map<number, number>();

    let offset = 0;
    let limit = BP_EXPORT_DEFAULT_LIMIT;
    let total: number | null = null;
    let shrunkPages = 0;
    let items = 0;

    while (total === null || offset < total) {
      const page = await fetchBpPage(rcon, offset, limit);

      if (page === null) {
        // A página não coube no frame. Metade do limite, e de novo
        // — sem avançar o offset, para não pular jogador.
        if (limit <= 1) {
          throw new Error(
            `o jogador na posição ${String(offset)} não cabe sozinho numa resposta do ` +
              `${BP_COMMANDS.export}. O snapshot foi abandonado inteiro em vez de sair pela ` +
              'metade.',
          );
        }

        limit = Math.max(1, Math.floor(limit / 2));
        shrunkPages += 1;
        continue;
      }

      total = page.count;

      for (const [rawId, bench] of Object.entries(page.benches)) {
        const itemId = Number(rawId);

        if (Number.isInteger(itemId)) {
          benches.set(itemId, bench);
        }
      }

      for (const player of page.players) {
        entries.push({ steamId: player.steamId, items: player.items });
        items += player.items.length;
      }

      // O `limit` normalizado que VOLTOU, e não o pedido: quem
      // pede 5000 recebe 100, e avançar 5000 pularia jogador.
      offset += page.limit;
    }

    const now = input.now ?? Date.now();

    this.#deps.repository.replaceSnapshot(
      input.serverId,
      { wipeRunId: input.wipeRunId, entries, benches },
      now,
    );

    return { players: entries.length, items, shrunkPages };
  }

  /**
   * Abre a fila de devolução do snapshot DAQUELA execução.
   *
   * Uma linha por jogador do snapshot — inclusive quem não é VIP
   * hoje. O direito é conferido na hora de entregar, e quem compra
   * VIP dois dias depois do wipe ainda encontra a linha dele aqui.
   *
   * `wipeRunId` nulo = o snapshot tirado na mão pelo painel. Ver o
   * porquê do filtro em db/bp-repository.ts.
   */
  enqueue(input: {
    readonly serverId: string;
    readonly wipeRunId: number | null;
    readonly wipeAt: number;
    readonly now?: number;
  }): number {
    const settings = this.#deps.repository.getSettings(input.serverId);
    const releaseAt = input.wipeAt + settings.delayHours * 60 * 60 * 1_000;

    return this.#deps.repository.enqueueRestores(
      input.serverId,
      input.wipeRunId,
      releaseAt,
      input.now ?? Date.now(),
    );
  }

  // ----------------------------------------------------------
  //  O RELÓGIO
  // ----------------------------------------------------------

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);

    // O relógio sozinho não segura o processo vivo — quem mantém o
    // event loop de pé é o servidor HTTP.
    this.#timer.unref();

    this.#deps.logger?.info(
      { intervalSeconds: Math.round(this.#intervalMs / 1_000) },
      'relógio da devolução de blueprints ligado',
    );
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma passada por todos os servidores.
   *
   * NUNCA lança: rodando num `setInterval`, uma exceção sem dono
   * mataria o laço e as devoluções parariam em silêncio — o pior
   * jeito de um relógio falhar.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.#running) {
      this.#deps.logger?.debug('devolução de blueprints: a rodada anterior ainda não terminou');
      return;
    }

    this.#running = true;

    try {
      for (const serverId of this.#deps.servers.ids()) {
        try {
          await this.deliverDue(serverId, now);
        } catch (error) {
          this.#deps.logger?.warn(
            { server: serverId, err: toError(error) },
            'a devolução de blueprints falhou neste servidor; a próxima volta tenta de novo',
          );
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /**
   * Entrega o que está vencido, para quem está ONLINE.
   *
   * ####  SÓ PARA QUEM ESTÁ ONLINE, E O PORQUÊ  ####
   *
   * `UnlockList` precisa do `BasePlayer` carregado. Mandar para
   * quem está fora deixaria a lista na fila volátil do plugin, que
   * um `oxide.reload` esvazia — e o agente marcaria como entregue
   * algo que ninguém recebeu.
   */
  async deliverDue(serverId: string, now: number = Date.now()): Promise<number> {
    const rcon = this.#deps.servers.rconOf(serverId);

    if (rcon === null || !rcon.isConnected) {
      // Sem RCON não se consome a fila: as linhas continuam
      // `pending` e a próxima volta tenta de novo.
      return 0;
    }

    const online = await this.#deps.online(serverId);

    if (online === null) {
      // "Não deu para perguntar" é diferente de "não há ninguém".
      return 0;
    }

    // Quem está online entra na CONSULTA, e não num filtro depois
    // dela: o teto da rodada é por linha lida, e gastá-lo com quem
    // não voltou mais deixaria quem está jogando sem receber. Ver
    // db/bp-repository.ts.
    const targets = this.#deps.repository.dueRestores(
      serverId,
      now,
      MAX_DELIVERIES_PER_SWEEP,
      online,
    );

    if (targets.length === 0) {
      return 0;
    }

    return await this.#deliver(serverId, targets, now);
  }

  /**
   * A devolução de UM jogador, pedida na tela.
   *
   * `force` devolve o snapshot inteiro mesmo sem VIP — é o botão do
   * suporte, para o caso em que a régua e o direito não contam a
   * mesma história.
   */
  async restoreOne(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly force?: boolean;
    readonly now?: number;
  }): Promise<{ readonly sent: number; readonly tier: string | null; readonly message: string }> {
    const now = input.now ?? Date.now();
    const snapshot = this.#deps.repository.snapshotOf(input.serverId, input.steamId);

    if (snapshot === null) {
      return {
        sent: 0,
        tier: null,
        message:
          `Não há snapshot de blueprints para ${input.steamId} neste servidor. Ou ele nunca ` +
          'jogou aqui, ou o snapshot dele já expirou (ele vale para o wipe seguinte, e só ele).',
      };
    }

    const rcon = this.#deps.servers.rconOf(input.serverId);

    if (rcon === null || !rcon.isConnected) {
      return {
        sent: 0,
        tier: null,
        message:
          'O RCON deste servidor está fora do ar. A devolução continua pendente e sai sozinha ' +
          'quando ele voltar e o jogador entrar.',
      };
    }

    const restore = this.#deps.repository.restoreOf(input.serverId, snapshot.id);
    const settings = this.#deps.repository.getSettings(input.serverId);
    const tiers = this.#deps.vips.activeOf(input.steamId, now).map((vip) => vip.tier);
    const best = bestRuleOf(settings, tiers);

    if (best === null && input.force !== true) {
      return {
        sent: 0,
        tier: null,
        message:
          `${input.steamId} não tem nível de VIP com direito a blueprint agora. O snapshot dele ` +
          'continua guardado até o wipe seguinte: se ele comprar VIP nesse meio-tempo, a ' +
          'devolução sai sozinha.',
      };
    }

    const rule: BpTierRule = best?.rule ?? { mode: 'all', bench: MAX_BENCH };
    const items = itemsForRule(rule, snapshot.items, (itemId) =>
      this.#deps.repository.benchOf(input.serverId, itemId),
    );

    if (items.length === 0) {
      return {
        sent: 0,
        tier: best?.tier ?? null,
        message:
          'A régua deste nível não devolve nenhum dos blueprints que ele tinha. Nada foi ' +
          'enviado ao jogo.',
      };
    }

    const outcome = await this.#send(input.serverId, rcon, [{ steamId: input.steamId, items }]);

    if (outcome === null) {
      if (restore !== null) {
        this.#deps.repository.markFailed(restore.id, 'o plugin recusou a devolução', now);
      }

      return {
        sent: 0,
        tier: best?.tier ?? null,
        message: 'O plugin recusou a devolução. Veja o log do agente para o motivo.',
      };
    }

    if (restore !== null) {
      this.#deps.repository.markSent(restore.id, best?.tier ?? null, items, now);

      if (outcome.applied > 0) {
        this.#deps.repository.markApplied(restore.id, now);
      }
    }

    return {
      sent: items.length,
      tier: best?.tier ?? null,
      message:
        outcome.applied > 0
          ? `${String(items.length)} blueprint(s) devolvidos agora.`
          : `${String(items.length)} blueprint(s) na fila do plugin: o jogador recebe assim que ` +
            'entrar.',
    };
  }

  // ----------------------------------------------------------
  //  Auxiliares
  // ----------------------------------------------------------

  /** Monta a régua de cada um, manda em lotes e marca o que saiu. */
  async #deliver(
    serverId: string,
    targets: readonly BpRestoreRecord[],
    now: number,
  ): Promise<number> {
    const settings = this.#deps.repository.getSettings(serverId);
    const rcon = this.#deps.servers.rconOf(serverId);

    if (rcon === null) {
      return 0;
    }

    const ready: { readonly restore: BpRestoreRecord; readonly tier: string; readonly items: readonly number[] }[] =
      [];

    for (const restore of targets) {
      // ####  O TETO DE TENTATIVAS  ####
      //
      // Uma linha que o plugin recebe e nunca confirma seria
      // reenviada a cada trinta segundos até o wipe seguinte, e o
      // log da rodada viraria ruído que esconde o resto.
      if (restore.attempts >= MAX_RESTORE_ATTEMPTS) {
        this.#deps.repository.markFailed(
          restore.id,
          `o comando saiu ${String(restore.attempts)} vezes e o jogo não confirmou a aplicação`,
          now,
        );

        continue;
      }

      const snapshot =
        restore.snapshotId === null
          ? null
          : this.#deps.repository.snapshotById(restore.snapshotId);

      if (snapshot === null) {
        this.#deps.repository.markFailed(restore.id, 'o snapshot deste jogador não existe mais', now);
        continue;
      }

      // ####  O DIREITO É CONFERIDO AQUI, E NÃO NO SNAPSHOT  ####
      //
      // Contra o VIP VIGENTE neste instante: quem venceu entre o
      // wipe e agora não recebe, e quem comprou depois recebe.
      const tiers = this.#deps.vips.activeOf(restore.steamId, now).map((vip) => vip.tier);
      const best = bestRuleOf(settings, tiers);

      if (best === null) {
        // Sem direito AGORA. A linha continua pendente: o snapshot
        // vale até o wipe seguinte, e comprar VIP amanhã ainda
        // devolve.
        continue;
      }

      const items = itemsForRule(best.rule, snapshot.items, (itemId) =>
        this.#deps.repository.benchOf(serverId, itemId),
      );

      if (items.length === 0) {
        this.#deps.repository.markSent(restore.id, best.tier, [], now);
        this.#deps.repository.markApplied(restore.id, now);
        continue;
      }

      ready.push({ restore, tier: best.tier, items });
    }

    if (ready.length === 0) {
      return 0;
    }

    let delivered = 0;

    for (const batch of batchByPayload(ready)) {
      const outcome = await this.#send(
        serverId,
        rcon,
        batch.map((entry) => ({ steamId: entry.restore.steamId, items: entry.items })),
      );

      if (outcome === null) {
        for (const entry of batch) {
          const attempts = entry.restore.attempts + 1;

          if (attempts >= MAX_RESTORE_ATTEMPTS) {
            this.#deps.repository.markFailed(
              entry.restore.id,
              `o plugin recusou a devolução ${String(attempts)} vezes`,
              now,
            );
          } else {
            this.#deps.repository.markAttempt(entry.restore.id, now);
          }
        }

        continue;
      }

      const stillPending = new Set(outcome.pending);

      for (const entry of batch) {
        this.#deps.repository.markSent(entry.restore.id, entry.tier, entry.items, now);

        // Quem o plugin NÃO listou em `pending` foi aplicado na
        // hora. Quem ficou na fila dele continua `sent`, e a
        // próxima volta tenta de novo se ele reaparecer online.
        if (!stillPending.has(entry.restore.steamId)) {
          this.#deps.repository.markApplied(entry.restore.id, now);
          delivered += 1;
        }
      }
    }

    if (delivered > 0) {
      this.#deps.logger?.info(
        { server: serverId, players: delivered },
        'blueprints devolvidos a quem tinha direito',
      );
    }

    return delivered;
  }

  /** `origemz.bp.restore <base64>`. `null` = o plugin recusou. */
  async #send(
    serverId: string,
    rcon: OpsRcon,
    players: readonly { readonly steamId: string; readonly items: readonly number[] }[],
  ): Promise<BpRestoreReply | null> {
    const payload = {
      players: Object.fromEntries(players.map((entry) => [entry.steamId, entry.items])),
    };

    const outcome = await pushState({
      rcon,
      command: BP_COMMANDS.restore,
      payload,
      logger: this.#deps.logger,
      trigger: 'wipe-blueprints',
    });

    if (outcome.status !== 'sent') {
      this.#deps.logger?.warn(
        { server: serverId, status: outcome.status },
        'a devolução de blueprints não chegou ao plugin',
      );

      return null;
    }

    const parsed = bpRestoreOkSchema.safeParse(outcome.response);

    if (!parsed.success) {
      this.#deps.logger?.warn(
        { server: serverId, response: outcome.response },
        `a resposta do ${BP_COMMANDS.restore} não bate com o contrato do plugin`,
      );

      return null;
    }

    return parsed.data;
  }
}

/**
 * Quantos jogadores cabem num `origemz.bp.restore`.
 *
 * ####  ELE É IGUAL AO TETO DO CAMPO `pending` DO PLUGIN  ####
 *
 * E os dois não podem divergir. O agente marca como ENTREGUE quem
 * ficou de FORA daquele campo; se o plugin tivesse mais nomes para
 * reportar do que cabe na lista, os que sobrassem apareceriam como
 * entregues sem terem recebido nada — e ninguém descobriria. Com o
 * lote limitado aqui, a lista de lá nunca precisa ser cortada.
 *
 * Ver `MaxBpPendingReported`, em Plugins\OrigemZAgent.cs.
 */
export const BP_RESTORE_MAX_PLAYERS = 50;

/**
 * Quebra a fila em lotes que cabem num comando de console.
 *
 * ####  UM LOTE GRANDE DEMAIS É RECUSADO INTEIRO  ####
 *
 * E é por isso que ele é medido AQUI, antes de sair: o
 * `pushState` recusaria o comando inteiro, e ninguém do lote
 * receberia nada. Um jogador cujo payload sozinho não cabe fica no
 * próprio lote, e a recusa dele não leva junto os outros.
 */
export function batchByPayload<T extends { readonly items: readonly number[] }>(
  entries: readonly T[],
  maxBytes: number = MAX_PUSH_BYTES,
  maxPlayers: number = BP_RESTORE_MAX_PLAYERS,
): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = overheadBytes();

  for (const entry of entries) {
    const size = Buffer.byteLength(encodePushPayload(entry.items), 'utf8') + 32;

    if (current.length > 0 && (bytes + size > maxBytes || current.length >= maxPlayers)) {
      batches.push(current);
      current = [];
      bytes = overheadBytes();
    }

    current.push(entry);
    bytes += size;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/** O nome do comando, as chaves do JSON e a folga do base64. */
function overheadBytes(): number {
  return BP_COMMANDS.restore.length + 64;
}
