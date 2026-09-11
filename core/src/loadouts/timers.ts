// ============================================================
//  timers.ts  -  leva os TIMERS de cada grupo até o jogo.
//
//  Quarto membro da família empurrada, ao lado do `origemz.vip.sync`,
//  do `origemz.loadout.sync` e do `origemz.status.sync`, e com o
//  mesmo desenho: base64, estado COMPLETO, cache trocado inteiro, e
//  a (re)conexão do RCON manda tudo de novo, porque recarregar o
//  plugin ESVAZIA o cache dele.
//
//  ------------------------------------------------------------
//  ####  O QUE É UM TIMER  ####
//
//  Um multiplicador de VELOCIDADE. ×2 é duas vezes mais rápido —
//  metade do tempo; ×1 é o jogo, e o mínimo. Quatro por grupo:
//
//      smelt     fornalha, fornalha grande, elétrica e refinaria
//      craft     a fila de fabricação do jogador
//      research  a mesa de pesquisa
//      recycle   o reciclador
//
//  Quem aplica é o `OrigemZPlayer` (seção OS TIMERS), sem reescrever
//  nada do jogo: a fornalha roda o `Cook()` do próprio Rust mais
//  vezes, o craft encurta a duração antes de ela chegar ao cliente.
//
//  ####  A CHAVE É A MESMA DO LOADOUT E DO STATUS  ####
//
//  O plugin pergunta por NÍVEL (`GetTimers("gold")`) e a configuração
//  daqui é por GRUPO DO OXIDE. Vão as duas chaves para o mesmo
//  conteúdo, e o `default` vira `normal` — o mapa é o `aliasesOf` de
//  sync.ts, e não uma cópia.
//
//  ####  NULL É "ESTE GRUPO NÃO DECIDE", E O PLUGIN DESCE UM NÍVEL  ####
//
//  Diferente do kit (onde o nível troca o kit inteiro), aqui a
//  resolução é CAMPO A CAMPO: admin, depois VIP, depois normal, e o
//  primeiro que define o timer ganha. Sem isso, "normal: craft ×2" e
//  "gold: fornalha ×3" deixariam o VIP craftando mais devagar que o
//  jogador comum.
//
//  Daí a regra que este arquivo impõe: o 1 nunca é gravado — vira
//  `null`. Um ×1 explícito no VIP travaria a queda para o `default`,
//  e é a única configuração que ninguém faz querendo.
// ============================================================

import { z } from 'zod';

import type {
  PlayerTimersRecord,
  PlayerTimersRepository,
  PlayerTimersValues,
} from '../db/player-timers-repository.js';
import { pushState, type PushOutcome } from '../game/plugin-push.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon } from '../ops/service.js';
import { readVipTiers, type VipTierLevel } from '../vip/tiers.js';
import { aliasesOf, NORMAL_TIER, type LoadoutServers } from './sync.js';

/** O comando que leva os timers ao `OrigemZAgent`. */
export const TIMERS_SYNC_COMMAND = 'origemz.timers.sync';

/** O nível de quem tem auth level no Rust. Ver `ResolveTier` no OrigemZPlayer. */
export const ADMIN_TIER = 'admin';

/**
 * A faixa de cada timer.
 *
 * O mínimo é o jogo: o plugin não desacelera nada. O teto é o do
 * plugin (`MaxTimerSpeed`), e existe pelo custo da fornalha — acima
 * de ×9 ela passa a cozinhar em passos maiores, e ×20 é onde isso
 * ainda sai barato num servidor cheio. O plugin trava de novo do
 * lado dele; esta cópia existe para a recusa sair com frase, e não
 * como um número cortado em silêncio.
 */
export const TIMER_LIMITS = { min: 1, max: 20 } as const;

/** Os quatro, na ordem em que a tela os mostra. */
export const TIMER_KEYS = ['smelt', 'craft', 'research', 'recycle'] as const;

export type TimerKey = (typeof TIMER_KEYS)[number];

/** Como as mensagens chamam cada um. */
export const TIMER_LABEL: Record<TimerKey, string> = {
  smelt: 'fornalha',
  craft: 'craft',
  research: 'pesquisa',
  recycle: 'reciclador',
};

const speedSchema = z.number().finite().min(TIMER_LIMITS.min).max(TIMER_LIMITS.max).nullable();

/**
 * Os quatro timers, como a rota os recebe.
 *
 * `null` é aceito explicitamente, como no status de nascimento: um
 * `undefined` vindo de um corpo mal montado viraria "não mexi" — e
 * aqui não mexer e "este grupo não decide" parecem a mesma coisa sem
 * ser.
 */
export const playerTimersValuesSchema = z
  .object({
    smelt: speedSchema,
    craft: speedSchema,
    research: speedSchema,
    recycle: speedSchema,
  })
  .strict();

/**
 * O que de fato vai para o banco: o 1 vira `null`, e o resto perde o
 * que passa de duas casas.
 *
 * As duas casas não são capricho: 1.4999999 vindo de uma conta no
 * navegador apareceria na tela como ×1.4999999, e ninguém escreveu
 * isso.
 */
export function normalizePlayerTimers<T extends PlayerTimersValues>(values: T): T {
  const normalized = { ...values };

  for (const key of TIMER_KEYS) {
    const value = values[key];

    if (value === null) {
      continue;
    }

    const rounded = Math.round(value * 100) / 100;

    (normalized as Record<TimerKey, number | null>)[key] =
      rounded <= TIMER_LIMITS.min ? null : rounded;
  }

  return normalized;
}

/**
 * O nível que um grupo representa para o plugin, ou `null` quando ele
 * não é nível nenhum.
 *
 * É o que a TELA mostra ao lado do nome do grupo: o plugin só pergunta
 * por admin, pelos níveis de VIP e por normal, e um timer gravado num
 * grupo de evento vai no payload e nunca é consultado. Dizer isso na
 * tela é mais honesto do que deixar a pessoa descobrir no jogo.
 */
export function timerTierOf(groupName: string, levels: readonly VipTierLevel[]): string | null {
  const lower = groupName.toLowerCase();
  const alias = aliasesOf(levels).get(lower);

  if (alias !== undefined) {
    return alias;
  }

  // Um grupo que se CHAMA como um nível é aquele nível: o payload
  // leva o nome do grupo como chave, e o cache do plugin compara sem
  // diferenciar maiúsculas.
  const tiers = new Set([ADMIN_TIER, NORMAL_TIER, ...levels.map((level) => level.tier)]);

  return tiers.has(lower) ? lower : null;
}

/**
 * A posição de um nível na hierarquia, para ORDENAR a lista da tela:
 * normal, os VIPs pelo `Rank` do OrigemZVip, admin, e por fim quem não
 * é nível nenhum.
 *
 * É a ordem em que o plugin DESCE quando um campo está em branco — na
 * ordem do Oxide (alfabética), o `default` cairia no meio dos VIPs e a
 * tela esconderia de onde vem o valor que um VIP herda.
 */
export function timerTierOrder(tier: string | null, levels: readonly VipTierLevel[]): number {
  if (tier === NORMAL_TIER) {
    return 0;
  }

  if (tier === null) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (tier === ADMIN_TIER) {
    return Number.MAX_SAFE_INTEGER - 1;
  }

  const index = levels.findIndex((level) => level.tier === tier);

  // Um tier que não está no OrigemZVip.json (grupo com nome de nível
  // que o config não declara) fica logo antes do admin.
  if (index < 0) {
    return Number.MAX_SAFE_INTEGER - 2;
  }

  // Sem `Rank`, a ordem do arquivo — a mesma regra do `highestLevel`.
  // O piso em zero mantém o `normal` na frente mesmo com Rank negativo.
  return 1 + Math.max(0, levels[index]?.rank ?? index);
}

export interface PlayerTimersSyncDeps {
  readonly repository: PlayerTimersRepository;
  readonly servers: LoadoutServers;
  readonly logger: Logger;
}

export interface PlayerTimersSyncResult {
  readonly serverId: string;
  /** Quantas CHAVES foram (grupos + apelidos). */
  readonly tiers: number;
  /** Quantas o plugin guardou. Menor que `tiers` = ele descartou. */
  readonly cachedTiers: number;
  /** `null` = o envio aconteceu. */
  readonly skipped: string | null;
}

/** Uma entrada do payload, no formato do `TimersPayload` do plugin. */
export type PlayerTimersEntry = Partial<Record<TimerKey, number>>;

/** O payload, no formato do `TimersSyncPayload` do plugin. */
export interface PlayerTimersSyncPayload {
  readonly tiers: Record<string, PlayerTimersEntry>;
}

/**
 * Só o que o grupo DECIDE entra no JSON.
 *
 * O campo ausente é o que faz o plugin descer um nível — mandá-lo
 * como 1 seria o ×1 explícito que o cabeçalho explica por que não
 * existe.
 */
function entryOf(timers: PlayerTimersRecord): PlayerTimersEntry {
  const entry: PlayerTimersEntry = {};

  for (const key of TIMER_KEYS) {
    const value = timers[key];

    if (value !== null && value > TIMER_LIMITS.min) {
      entry[key] = value;
    }
  }

  return entry;
}

/**
 * Monta o payload a partir dos timers e dos níveis daquele servidor.
 *
 * Pura e exportada pelo mesmo motivo do `buildLoadoutPayload`: é a
 * regra que o teste cobre — "apaguei os timers e o grupo sumiu do
 * JSON", e "o apelido do nível viaja junto com o nome do grupo".
 */
export function buildTimersPayload(
  records: readonly PlayerTimersRecord[],
  levels: readonly VipTierLevel[],
): PlayerTimersSyncPayload {
  const tiers: Record<string, PlayerTimersEntry> = {};

  const usable = records
    .map((timers) => ({ timers, entry: entryOf(timers) }))
    .filter(({ entry }) => Object.keys(entry).length > 0);

  // Os grupos primeiro: o nome deles é a identidade da configuração,
  // e apelido nenhum toma o lugar dele.
  for (const { timers, entry } of usable) {
    tiers[timers.groupName] = entry;
  }

  const aliasOf = aliasesOf(levels);

  for (const { timers, entry } of usable) {
    const alias = aliasOf.get(timers.groupName.toLowerCase());

    if (alias !== undefined && tiers[alias] === undefined) {
      tiers[alias] = entry;
    }
  }

  return { tiers };
}

export class PlayerTimersSync {
  readonly #deps: PlayerTimersSyncDeps;

  constructor(deps: PlayerTimersSyncDeps) {
    this.#deps = deps;
  }

  /**
   * Empurra o estado completo daquele servidor.
   *
   * NUNCA lança, pelo mesmo motivo do loadout: quem grava não tem o
   * que fazer com uma exceção vinda de um servidor que estava
   * reiniciando, e a linha já está no banco. O desfecho vai na
   * resposta, e a tela o mostra.
   */
  async push(serverId: string, trigger: string): Promise<PlayerTimersSyncResult> {
    const records = this.#deps.repository.enabled(serverId);
    const levels = await this.#levelsOf(serverId);
    const payload = buildTimersPayload(records, levels);

    const tiers = Object.keys(payload.tiers).length;

    const outcome = await pushState({
      rcon: this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId),
      command: TIMERS_SYNC_COMMAND,
      payload,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status !== 'sent') {
      return { serverId, tiers, cachedTiers: 0, skipped: describe(serverId, outcome) };
    }

    const cachedTiers = Number(outcome.response.tiers ?? 0);

    // Menos no cache do que o enviado significa que o plugin
    // DESCARTOU alguma entrada (nome de nível inválido, os quatro
    // vazios). É a única forma de perceber que estamos mandando algo
    // que o outro lado não aceita.
    if (cachedTiers < tiers) {
      this.#deps.logger.warn(
        { server: serverId, sentTiers: tiers, cachedTiers },
        'o plugin descartou níveis dos timers; confira os nomes dos grupos',
      );
    }

    this.#deps.logger.info(
      { server: serverId, tiers, cachedTiers, trigger },
      'timers empurrados ao plugin',
    );

    return { serverId, tiers, cachedTiers, skipped: null };
  }

  /** Todos os servidores. É o que roda no boot. */
  async pushAll(trigger: string): Promise<readonly PlayerTimersSyncResult[]> {
    const results: PlayerTimersSyncResult[] = [];

    for (const serverId of this.#deps.servers.ids()) {
      results.push(await this.push(serverId, trigger));
    }

    return results;
  }

  async #levelsOf(serverId: string): Promise<readonly VipTierLevel[]> {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      return [];
    }

    return (await readVipTiers(config.paths.oxideConfigDir)).levels;
  }
}

/** O desfecho de um push vira a frase que a tela mostra. */
function describe(serverId: string, outcome: PushOutcome): string {
  switch (outcome.status) {
    case 'skipped':
      return `"${serverId}": ${outcome.reason}`;
    case 'refused':
      return (
        `Os timers de "${serverId}" não couberam num comando de console ` +
        `(${String(outcome.bytes)} bytes, teto de ${String(outcome.limitBytes)}). NADA foi ` +
        'enviado, e o servidor continua com a configuração anterior: meio payload faria o plugin ' +
        'trocar um cache íntegro por um incompleto. Desligue os grupos que não estão em uso.'
      );
    case 'failed':
      return `Não consegui empurrar os timers para "${serverId}": ${outcome.error.message}`;
    default:
      return `"${serverId}" respondeu de um jeito que não reconheço.`;
  }
}
