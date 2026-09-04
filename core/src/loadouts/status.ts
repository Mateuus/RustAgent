// ============================================================
//  status.ts  -  leva o STATUS DE NASCIMENTO até o jogo.
//
//  Terceiro membro da família empurrada, ao lado do
//  `origemz.vip.sync` e do `origemz.loadout.sync`, e com o mesmo
//  desenho: base64, estado COMPLETO, cache trocado inteiro, e a
//  (re)conexão do RCON manda tudo de novo porque recarregar o
//  plugin ESVAZIA o cache dele.
//
//  Nível que sumiu do payload volta ao padrão do Rust — é assim que
//  "desconfigurei este grupo" chega ao jogo.
//
//  ------------------------------------------------------------
//  ####  A CHAVE É A MESMA DO LOADOUT, E PELO MESMO MOTIVO  ####
//
//  Quem consome é o `OrigemZPlayer`, no caminho do respawn, e ele
//  pergunta por NÍVEL (`GetSpawnStatus("gold")`) — enquanto a
//  configuração daqui é por GRUPO DO OXIDE. Então vão as duas
//  chaves para o mesmo conteúdo, e o `default` vira `normal`. O
//  mapa é o de sync.ts (`aliasesOf`), e não uma cópia: um dia
//  alguém conserta um dos dois, e o outro ficaria para trás.
//
//  ####  NULL É "O JOGO DECIDE", E NÃO ZERO  ####
//
//  Está dito no plugin em voz alta (`float?` no
//  `SpawnStatusPayload`) e atravessa daqui até lá: zero de fome é
//  nascer morrendo, e não configurar nada é não encostar no
//  jogador. Por isso os campos nulos são OMITIDOS do JSON, em vez
//  de irem como 0.
//
//  ####  UM VALOR, OU UMA FAIXA  ####
//
//  Cada atributo viaja como um número (`health`) e, quando é
//  faixa, com o teto ao lado (`healthMax`). Quem SORTEIA é o
//  plugin, a cada nascimento: sortear aqui congelaria o número até
//  o próximo push, e trinta pessoas do mesmo nível nasceriam com o
//  mesmo valor — que é exatamente o que a faixa existe para
//  evitar.
//
//  O campo do teto é ADITIVO de propósito. Um plugin antigo, que
//  não o conhece, lê só o `health` e aplica o piso: perde o
//  sorteio e não perde o benefício.
//
//  ####  O QUE ISTO NÃO É  ####
//
//  Não é teto permanente. O plugin aplica UMA VEZ, no nascimento —
//  um VIP que nasce de barriga cheia passa fome no mesmo ritmo de
//  todo mundo no segundo seguinte. Reaplicar de tempos em tempos
//  disputaria com tudo que o jogo reseta sozinho, e o primeiro
//  lugar onde isso vaza é uma barra de vida mudando no meio de um
//  tiroteio.
// ============================================================

import { z } from 'zod';

import type { SpawnStatusRecord, SpawnStatusRepository } from '../db/spawn-status-repository.js';
import { pushState, type PushOutcome } from '../game/plugin-push.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon } from '../ops/service.js';
import { readVipTiers, type VipTierLevel } from '../vip/tiers.js';
import { aliasesOf, type LoadoutServers } from './sync.js';

/** O comando que leva o status ao `OrigemZAgent`. */
export const SPAWN_STATUS_SYNC_COMMAND = 'origemz.status.sync';

/**
 * O que cada atributo aceita, e o que o jogo faz sem configuração
 * nenhuma.
 *
 * Os padrões são os do Rust (vida 100, comida até 500, água até
 * 250) e servem à TELA — é o que ela mostra como "o jogo decide".
 *
 * Os tetos são nossos, e generosos de propósito: o plugin LEVANTA o
 * máximo do atributo quando o valor pedido não caberia, então pedir
 * 150 de vida é configuração legítima, e não engano a recusar. O
 * que o teto impede é o dedo escorregando no teclado e um servidor
 * inteiro nascendo com 10000 de vida.
 *
 * A vida mínima é 1: zero seria nascer morto, e ninguém configura
 * isso de propósito.
 */
export const SPAWN_LIMITS = {
  health: { min: 1, max: 1000, gameDefault: 100 },
  calories: { min: 0, max: 1000, gameDefault: 500 },
  hydration: { min: 0, max: 1000, gameDefault: 250 },
} as const;

/**
 * Os três atributos, como a rota os recebe.
 *
 * `null` é valor legítimo e SIGNIFICA alguma coisa ("o jogo
 * decide"), por isso ele é aceito explicitamente em vez de o campo
 * ser opcional: um `undefined` vindo de um corpo mal montado
 * viraria "não mexi neste atributo" — ambíguo justamente onde a
 * diferença importa.
 */
export const spawnStatusValuesSchema = z
  .object({
    health: z
      .number()
      .finite()
      .min(SPAWN_LIMITS.health.min)
      .max(SPAWN_LIMITS.health.max)
      .nullable(),
    calories: z
      .number()
      .finite()
      .min(SPAWN_LIMITS.calories.min)
      .max(SPAWN_LIMITS.calories.max)
      .nullable(),
    hydration: z
      .number()
      .finite()
      .min(SPAWN_LIMITS.hydration.min)
      .max(SPAWN_LIMITS.hydration.max)
      .nullable(),
    /**
     * O teto da faixa. Ausente e `null` dizem a mesma coisa aqui —
     * "valor exato" —, e o default deixa quem já mandava três
     * campos continuar mandando três.
     */
    healthMax: z
      .number()
      .finite()
      .min(SPAWN_LIMITS.health.min)
      .max(SPAWN_LIMITS.health.max)
      .nullable()
      .default(null),
    caloriesMax: z
      .number()
      .finite()
      .min(SPAWN_LIMITS.calories.min)
      .max(SPAWN_LIMITS.calories.max)
      .nullable()
      .default(null),
    hydrationMax: z
      .number()
      .finite()
      .min(SPAWN_LIMITS.hydration.min)
      .max(SPAWN_LIMITS.hydration.max)
      .nullable()
      .default(null),
  })
  .strict();

/** Os três atributos, na ordem em que a tela os mostra. */
export const SPAWN_ATTRIBUTES = ['health', 'calories', 'hydration'] as const;

export type SpawnAttribute = (typeof SPAWN_ATTRIBUTES)[number];

/** O nome do campo do teto daquele atributo. */
export const maxFieldOf = {
  health: 'healthMax',
  calories: 'caloriesMax',
  hydration: 'hydrationMax',
} as const;

/** Como a tela e as mensagens chamam cada atributo. */
export const SPAWN_ATTRIBUTE_LABEL: Record<SpawnAttribute, string> = {
  health: 'vida',
  calories: 'comida',
  hydration: 'água',
};

/**
 * O que impede uma faixa impossível de existir no banco.
 *
 * Duas recusas, e as duas são configuração que não quer dizer
 * nada:
 *
 *   - **teto sem piso**: "sorteie entre nada e 135". O atributo
 *     nulo é "o jogo decide", e o jogo não decide metade;
 *   - **teto abaixo do piso**: o sorteio não teria de onde tirar
 *     número, e o plugin acabaria aplicando o piso calado.
 *
 * Teto IGUAL ao piso é legítimo e vira `null` no
 * `normalizeSpawnRanges`: é o mesmo que valor exato, e guardar a
 * faixa degenerada faria a tela mostrar "de 130 a 130".
 *
 * @returns a frase do problema, ou `null` quando está tudo de pé.
 */
export function spawnRangeProblem(values: {
  readonly [K in SpawnAttribute]: number | null;
} & {
  readonly [K in keyof typeof maxFieldOf as (typeof maxFieldOf)[K]]: number | null;
}): string | null {
  for (const attribute of SPAWN_ATTRIBUTES) {
    const from = values[attribute];
    const to = values[maxFieldOf[attribute]];

    if (to === null) {
      continue;
    }

    const label = SPAWN_ATTRIBUTE_LABEL[attribute];

    if (from === null) {
      return (
        `A faixa de ${label} tem o teto (${String(to)}) e não tem o piso. Um atributo vazio é ` +
        '"o jogo decide", e o jogo não decide metade: preencha os dois, ou nenhum.'
      );
    }

    if (to < from) {
      return (
        `A faixa de ${label} vai de ${String(from)} a ${String(to)} — o teto é MENOR que o piso. ` +
        'O sorteio não teria de onde tirar um número, e quem nascesse levaria o piso calado.'
      );
    }
  }

  return null;
}

/**
 * O teto igual ao piso vira `null`.
 *
 * "De 130 a 130" é valor exato escrito de um jeito confuso — e a
 * tela mostraria uma faixa que não sorteia nada.
 */
export function normalizeSpawnRanges<T extends Record<string, unknown>>(values: T): T {
  const normalized = { ...values };

  for (const attribute of SPAWN_ATTRIBUTES) {
    const field = maxFieldOf[attribute];

    if (normalized[field] !== null && normalized[field] === normalized[attribute]) {
      (normalized as Record<string, unknown>)[field] = null;
    }
  }

  return normalized;
}

export interface SpawnStatusSyncDeps {
  readonly repository: SpawnStatusRepository;
  readonly servers: LoadoutServers;
  readonly logger: Logger;
}

export interface SpawnStatusSyncResult {
  readonly serverId: string;
  /** Quantas CHAVES foram (grupos + apelidos). */
  readonly tiers: number;
  /** Quantas o plugin guardou. Menor que `tiers` = ele descartou. */
  readonly cachedTiers: number;
  /** `null` = o envio aconteceu. */
  readonly skipped: string | null;
}

/** Uma entrada do payload, no formato do `SpawnStatusPayload` do plugin. */
export interface SpawnStatusEntry {
  readonly health?: number;
  readonly calories?: number;
  readonly hydration?: number;
  /** Só viaja quando o atributo é FAIXA. Ver o cabeçalho. */
  readonly healthMax?: number;
  readonly caloriesMax?: number;
  readonly hydrationMax?: number;
}

/** O payload, no formato do `SpawnStatusSyncPayload` do plugin. */
export interface SpawnStatusSyncPayload {
  readonly tiers: Record<string, SpawnStatusEntry>;
}

/**
 * Só o que tem valor entra no JSON.
 *
 * `{"health":100}` e `{"health":100,"calories":null}` dizem a mesma
 * coisa ao plugin, e o primeiro é menor num comando com teto de
 * bytes.
 */
function entryOf(status: SpawnStatusRecord): SpawnStatusEntry {
  const entry: Record<string, number> = {};

  for (const attribute of SPAWN_ATTRIBUTES) {
    const from = status[attribute];

    if (from === null) {
      continue;
    }

    entry[attribute] = from;

    const to = status[maxFieldOf[attribute]];

    // O teto só viaja quando existe E é maior: um teto igual ao
    // piso faria o plugin sortear entre 130 e 130 a cada
    // nascimento, gastando bytes do comando para chegar no mesmo
    // número.
    if (to !== null && to > from) {
      entry[maxFieldOf[attribute]] = to;
    }
  }

  return entry;
}

/**
 * Monta o payload a partir do status e dos níveis daquele servidor.
 *
 * Pura e exportada pelo mesmo motivo do `buildLoadoutPayload`: é a
 * regra que o teste cobre — "apaguei o status e o grupo sumiu do
 * JSON empurrado", e "o apelido do nível viaja junto com o nome do
 * grupo".
 */
export function buildSpawnStatusPayload(
  records: readonly SpawnStatusRecord[],
  levels: readonly VipTierLevel[],
): SpawnStatusSyncPayload {
  const tiers: Record<string, SpawnStatusEntry> = {};

  const usable = records.filter((status) =>
    SPAWN_ATTRIBUTES.some((attribute) => status[attribute] !== null),
  );

  // Os grupos primeiro: o nome deles é a identidade da
  // configuração, e apelido nenhum toma o lugar dele.
  for (const status of usable) {
    tiers[status.groupName] = entryOf(status);
  }

  const aliasOf = aliasesOf(levels);

  for (const status of usable) {
    const alias = aliasOf.get(status.groupName.toLowerCase());

    if (alias !== undefined && tiers[alias] === undefined) {
      tiers[alias] = entryOf(status);
    }
  }

  return { tiers };
}

export class SpawnStatusSync {
  readonly #deps: SpawnStatusSyncDeps;

  constructor(deps: SpawnStatusSyncDeps) {
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
  async push(serverId: string, trigger: string): Promise<SpawnStatusSyncResult> {
    const records = this.#deps.repository.enabled(serverId);
    const levels = await this.#levelsOf(serverId);
    const payload = buildSpawnStatusPayload(records, levels);

    const tiers = Object.keys(payload.tiers).length;

    const outcome = await pushState({
      rcon: this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId),
      command: SPAWN_STATUS_SYNC_COMMAND,
      payload,
      logger: this.#deps.logger,
      trigger,
    });

    if (outcome.status !== 'sent') {
      return { serverId, tiers, cachedTiers: 0, skipped: describe(serverId, outcome) };
    }

    const cachedTiers = Number(outcome.response.tiers ?? 0);

    // Menos no cache do que o enviado significa que o plugin
    // DESCARTOU alguma entrada (nome de nível inválido, os três
    // atributos vazios). É a única forma de perceber que estamos
    // mandando algo que o outro lado não aceita.
    if (cachedTiers < tiers) {
      this.#deps.logger.warn(
        { server: serverId, sentTiers: tiers, cachedTiers },
        'o plugin descartou níveis do status de nascimento; confira os nomes dos grupos',
      );
    }

    this.#deps.logger.info(
      { server: serverId, tiers, cachedTiers, trigger },
      'status de nascimento empurrado ao plugin',
    );

    return { serverId, tiers, cachedTiers, skipped: null };
  }

  /** Todos os servidores. É o que roda no boot. */
  async pushAll(trigger: string): Promise<readonly SpawnStatusSyncResult[]> {
    const results: SpawnStatusSyncResult[] = [];

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
        `O status de nascimento de "${serverId}" não coube num comando de console ` +
        `(${String(outcome.bytes)} bytes, teto de ${String(outcome.limitBytes)}). NADA foi ` +
        'enviado, e o servidor continua com a configuração anterior: meio payload faria o plugin ' +
        'trocar um cache íntegro por um incompleto. Desligue os grupos que não estão em uso.'
      );
    case 'failed':
      return (
        `Não consegui empurrar o status de nascimento para "${serverId}": ` +
        `${outcome.error.message}`
      );
    default:
      return `"${serverId}" respondeu de um jeito que não reconheço.`;
  }
}
