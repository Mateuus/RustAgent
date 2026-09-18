// ============================================================
//  battlepass.ts  -  O CONTRATO DO PASSE DE BATALHA.
//
//  ####  ESTE ARQUIVO EXISTE PARA QUE TRÊS TELAS CONCORDEM  ####
//
//  O painel monta a temporada, o plugin desenha a trilha e o site
//  vende o passe. As três perguntam a mesma coisa — "posso resgatar
//  isto?" — e a resposta precisa ser UMA função, escrita uma vez.
//  Sem este arquivo ela vira três opiniões: uma no agente, uma no
//  `.cs` e uma no navegador, divergindo no primeiro campo novo.
//
//  O vocabulário é o do Docs/BattlePass/01 §9, e ele não é livre:
//
//    season       um mês de passe (a temporada)
//    track        a sequência de níveis dela
//    level        uma casa da trilha, de 1 a N
//    lane         `free` | `paid` — a faixa
//    xp           o que faz subir de nível
//    xpRule       fonte + valor + teto diário
//    entitlement  o registro de que o jogador comprou aquele mês
//    claim        o ato de levar, e a linha que prova que levou
//    progress     o XP e o nível do jogador na temporada
//
//  Duas palavras estão OCUPADAS neste repositório e por isso não
//  aparecem aqui: `tier` é do VIP (`vip/tiers.ts`) — a faixa do
//  passe é `lane` —, e `points` é a recompensa de ranking das
//  missões — a do passe é `xp`, e os dois não se misturam.
//
//  ####  O CATÁLOGO É DA REDE; O PROGRESSO É POR SERVIDOR  ####
//
//  Decisão do dono, 17/09/2026. A temporada, a trilha e as regras
//  de XP são globais, com uma junção dizendo em que servidores
//  valem — como o catálogo de skins. O XP, o nível, o direito
//  comprado e o resgate são POR SERVIDOR: quem joga no `pvp1` e no
//  `pvp2` tem duas trilhas, e comprar num não destrava o outro.
//
//  ####  O NÍVEL COMEÇA EM 1, E O DOCUMENTO NÃO DIZIA  ####
//
//  O 01 §2 diz que a trilha tem N níveis numerados de 1 a N e que
//  o card mostra "NÍVEL 17 — 2.400/3.000 XP", com a recompensa do
//  17 já disponível. Isso só fecha de um jeito: alcançar o nível 1
//  é de graça (`levelCost(curve, 1) === 0`), o XP compra o degrau
//  para o 2 em diante, e "nível alcançado" quer dizer
//  `progress.level >= level`.
//
//  A alternativa — nível 0 para quem nasce — daria um "NÍVEL 0" na
//  tela do jogador novo e uma trilha cuja primeira casa ninguém
//  alcança sem jogar, o que contraria o card desenhado. Ver
//  `levelAt` e `trackProgress`, que são a régua única disso.
// ============================================================

import { z } from 'zod';

import { questRewardSchema, type QuestReward } from './quests.js';
// A MESMA régua de SteamID64 do Workshop, de propósito: duas
// expressões para "17 dígitos começando por 7656" divergiriam no
// primeiro ajuste, e a coluna do banco confere a mesma coisa.
import { steamIdSchema } from './workshop.js';

export { steamIdSchema };

// ------------------------------------------------------------
//  §1  A TEMPORADA
// ------------------------------------------------------------

/**
 * O estado da temporada (01 §1.1).
 *
 *   draft      o admin ainda está montando; o jogador não vê nada
 *   scheduled  pronta e publicada, mas o mês não chegou
 *   active     é o mês corrente e ela está publicada: a trilha
 *   closed     o mês passou
 *
 * Publicar é BOTÃO, e não efeito do calendário: uma temporada
 * esquecida em `draft` no dia 1 não deve entrar no ar meio montada.
 */
export const BATTLEPASS_SEASON_STATES = ['draft', 'scheduled', 'active', 'closed'] as const;
export type BattlePassSeasonState = (typeof BATTLEPASS_SEASON_STATES)[number];

/** A faixa. `tier` é do VIP; aqui é `lane`. */
export const BATTLEPASS_LANES = ['free', 'paid'] as const;
export type BattlePassLane = (typeof BATTLEPASS_LANES)[number];

/** Quantos níveis uma temporada pode ter. O teto é do desenho da tela. */
export const MAX_SEASON_LEVELS = 200;

/** Quantas recompensas cabem numa faixa de um nível. O mesmo teto das missões. */
export const MAX_LANE_REWARDS = 8;

/**
 * A temporada é identificada por ano e mês, nunca por "a atual"
 * (01 §1): `2026-10` é um nome estável, e "a atual" muda de
 * significado à meia-noite do dia 1 — transformando todo registro
 * histórico em mentira.
 */
export const seasonPeriodSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A temporada é identificada por ano e mês, no formato 2026-10.');

/** O dia local, na forma que `rankings/periods.ts` produz. */
export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * O `period` daquele dia: `2026-10`.
 *
 * Recebe o dia já resolvido (`localDayOf(now, timeZone)`) em vez de
 * um epoch: a conta de fuso deste projeto é UMA, e ela mora em
 * `rankings/periods.ts`. Um segundo relógio de virada aqui seria
 * dívida garantida — dois "dia 1" diferentes na mesma tela.
 */
export function periodOf(day: CalendarDay): string {
  return `${String(day.year)}-${pad(day.month)}`;
}

/** A chave do teto diário: `2026-10-07`. Mesma régua de fuso do `periodOf`. */
export function dayKeyOf(day: CalendarDay): string {
  return `${String(day.year)}-${pad(day.month)}-${pad(day.day)}`;
}

// ------------------------------------------------------------
//  §2  A CURVA DE XP
// ------------------------------------------------------------

/**
 * Quanto custa cada degrau da trilha.
 *
 * ####  TRÊS FORMAS, E NÃO UMA LISTA CRUA  ####
 *
 * O dono pediu que o admin configure a curva "nem que seja todo
 * nível custa 1.000" (01 §2). Uma lista de N números atenderia,
 * mas obrigaria o painel a escrever 200 células para dizer isso —
 * e a reescrevê-las todas ao mudar o número de níveis.
 *
 *   flat    todo degrau custa o mesmo
 *   linear  o primeiro custa `base`, e cada seguinte soma `step`
 *   table   um número por degrau, para quem quer desenhar à mão
 *
 * `table` tem EXATAMENTE `levels - 1` entradas (ver
 * `seasonInputSchema`): um degrau por nível a partir do segundo.
 * Aceitar uma lista curta faria o nível 40 de uma temporada de 40
 * custar um valor que ninguém escolheu.
 */
export const xpCurveSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('flat'),
    perLevel: z.number().int().min(1).max(10_000_000),
  }),
  z.object({
    kind: z.literal('linear'),
    /** O custo do primeiro degrau (do nível 1 para o 2). */
    base: z.number().int().min(1).max(10_000_000),
    /** O que cada degrau seguinte soma ao anterior. Pode ser 0. */
    step: z.number().int().min(0).max(10_000_000),
  }),
  z.object({
    kind: z.literal('table'),
    steps: z.array(z.number().int().min(0).max(10_000_000)).min(0).max(MAX_SEASON_LEVELS),
  }),
]);

export type XpCurve = z.infer<typeof xpCurveSchema>;

/** A curva de quem não escolheu nenhuma. Ver o card do 01 §2. */
export const DEFAULT_XP_CURVE: XpCurve = { kind: 'flat', perLevel: 1000 };

/**
 * O custo do degrau `step` (1 = sair do nível 1 e chegar ao 2).
 *
 * Fora da faixa devolve 0: um degrau que não existe não custa nada,
 * e é isso que faz `xpToReach(curve, 1)` ser zero sem caso especial.
 */
function stepCost(curve: XpCurve, step: number): number {
  if (step < 1) return 0;

  switch (curve.kind) {
    case 'flat':
      return curve.perLevel;

    case 'linear':
      return curve.base + curve.step * (step - 1);

    default:
      return curve.steps[step - 1] ?? 0;
  }
}

/**
 * O XP para alcançar `level` vindo do anterior.
 *
 * O nível 1 custa ZERO — ver o cabeçalho. Quem nasce já está nele.
 */
export function levelCost(curve: XpCurve, level: number): number {
  return level <= 1 ? 0 : stepCost(curve, level - 1);
}

/** O XP acumulado que o nível `level` exige desde o começo da temporada. */
export function xpToReach(curve: XpCurve, level: number): number {
  let total = 0;

  for (let current = 2; current <= level; current += 1) {
    total += levelCost(curve, current);
  }

  return total;
}

/**
 * Em que nível está quem tem `xp`, numa trilha de `levels` níveis.
 *
 * Nunca passa do último: "passar do último nível não é erro" (01
 * §2), e o excedente simplesmente não compra nada. Fingir um nível
 * 41 numa trilha de 40 quebraria a tela e a tabela de recompensas.
 */
export function levelAt(curve: XpCurve, levels: number, xp: number): number {
  let level = 1;
  let spent = 0;

  while (level < levels) {
    const cost = levelCost(curve, level + 1);

    if (spent + cost > xp) break;

    spent += cost;
    level += 1;
  }

  return level;
}

/** A barra do card: onde ele está, e quanto falta para o próximo. */
export interface TrackProgress {
  readonly level: number;
  /** O XP acumulado da temporada. */
  readonly xp: number;
  /** Quanto dele já entrou no nível atual — o numerador de "2.400 / 3.000". */
  readonly intoLevel: number;
  /** O denominador. `null` no último nível: não há próximo para comprar. */
  readonly neededForNext: number | null;
  /** `true` quando ele terminou a trilha. A tela diz "trilha concluída". */
  readonly completed: boolean;
}

/**
 * O estado da barra, calculado num lugar só.
 *
 * O plugin, o painel e o site mostram o mesmo número porque todos
 * chamam esta função — e não porque três pessoas fizeram a mesma
 * subtração.
 */
export function trackProgress(curve: XpCurve, levels: number, xp: number): TrackProgress {
  const level = levelAt(curve, levels, xp);
  const spent = xpToReach(curve, level);
  const completed = level >= levels;

  return {
    level,
    xp,
    intoLevel: xp - spent,
    neededForNext: completed ? null : levelCost(curve, level + 1),
    completed,
  };
}

// ------------------------------------------------------------
//  §3  A TEMPORADA, COMO O PAINEL A MANDA
// ------------------------------------------------------------

/** Texto opcional: em branco vira `null`. A coluna recusa `''`. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === null || value === undefined || value === '' ? null : value));

export const seasonInputSchema = z
  .object({
    /** `2026-10`. Ver `seasonPeriodSchema`. */
    period: seasonPeriodSchema,

    /** "Temporada de outubro de 2026". É o que o jogador lê no cabeçalho. */
    label: z.string().trim().min(1, 'dê um nome à temporada').max(80),

    /** Quantas casas a trilha tem. */
    levels: z.number().int().min(1).max(MAX_SEASON_LEVELS).default(30),

    /** Quanto custa cada degrau. Ver `xpCurveSchema`. */
    xpCurve: xpCurveSchema.default(DEFAULT_XP_CURVE),

    /** Desligada, a trilha mostra só a faixa paga (01 §8). */
    freeLane: z.boolean().default(true),

    /** Desligada, a trilha mostra só a grátis e o produto some da loja. */
    paidLane: z.boolean().default(true),

    /**
     * A compra olha para trás (01 §5): quem compra no nível 17 leva
     * os 17. NASCE LIGADA — desligada a compra vale do nível
     * seguinte em diante, que é uma venda pior e uma escolha
     * legítima de quem opera o servidor.
     */
    retroactive: z.boolean().default(true),

    /** O texto da tela de compra e do card. */
    description: optionalText(280).default(null),

    /** Em que servidores ela vale. Vazio = em nenhum. */
    servers: z.array(z.string().min(1)).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    // A curva desenhada à mão precisa de um degrau por nível a
    // partir do segundo. Sobra ou falta é um nível custando um
    // número que ninguém escolheu.
    if (value.xpCurve.kind !== 'table') return;

    const needed = value.levels - 1;

    if (value.xpCurve.steps.length !== needed) {
      ctx.addIssue({
        code: 'custom',
        path: ['xpCurve', 'steps'],
        message:
          `A curva desenhada à mão precisa de ${String(needed)} valores para ` +
          `${String(value.levels)} níveis (o nível 1 é de graça), e vieram ` +
          `${String(value.xpCurve.steps.length)}.`,
      });
    }
  });

export type SeasonInput = z.infer<typeof seasonInputSchema>;

/** O que o repositório grava além do formulário. */
export interface SeasonMeta {
  readonly createdBy: string | null;
}

/** Uma temporada, como ela está no banco. */
export interface BattlePassSeason extends SeasonInput, SeasonMeta {
  readonly id: number;
  readonly state: BattlePassSeasonState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A troca de estado, como a rota a recebe.
 *
 * Um schema só para os quatro estados: o painel manda para onde
 * quer ir, e quem decide se PODE é o serviço — que conhece a regra
 * "só uma `active` por servidor" e a frase da recusa.
 */
export const seasonStateBodySchema = z.object({
  state: z.enum(BATTLEPASS_SEASON_STATES),
});

export type SeasonStateBody = z.infer<typeof seasonStateBodySchema>;

// ------------------------------------------------------------
//  §4  A TRILHA
// ------------------------------------------------------------

/**
 * O que uma faixa dá num nível.
 *
 * ####  É UMA LISTA, E NÃO UMA RECOMPENSA SÓ  ####
 *
 * O 02 §5 escreve `(season_id, level, lane) -> a recompensa`, no
 * singular, mas duas outras decisões do mesmo documento exigem
 * lista: o editor que o painel reusa (`RewardList`) edita listas, e
 * a pendência da caixa faz dedupe por `(claim, posição)` — posição
 * que só existe se houver mais de uma.
 *
 * Na prática é o que evita obrigar o admin a escolher entre a AK e
 * os 500 OZCoin no mesmo nível.
 */
export const trackCellInputSchema = z.object({
  /** O `QuestReward` inteiro, e não colunas por tipo (02 §5, decisão 3). */
  rewards: z.array(questRewardSchema).max(MAX_LANE_REWARDS).default([]),

  /**
   * MARCO: o card ganha destaque de tamanho no menu (03 §3.1,
   * regra 5) e um selo no painel.
   *
   * É marca de TELA e não muda regra nenhuma: um marco se resgata
   * como qualquer outro nível. Fica na linha da faixa, e não na do
   * nível, porque o desenho do painel marca as duas faixas
   * separadamente.
   */
  milestone: z.boolean().default(false),
});

export type TrackCellInput = z.infer<typeof trackCellInputSchema>;

/** Uma casa da trilha, como ela está no banco. */
export interface TrackCell extends TrackCellInput {
  readonly seasonId: number;
  readonly level: number;
  readonly lane: BattlePassLane;
  readonly updatedAt: number;
}

/**
 * O estado de uma célula para UM jogador (01 §4).
 *
 *   locked     o nível não foi alcançado, ou o passe não foi comprado
 *   available  pode levar agora
 *   claimed    já levou
 *   pending    resgatou, e a entrega ainda deve
 *
 * Note o que NÃO existe: `unavailable`. Na trilha por XP nada se
 * perde por ter deixado passar — o nível 3 continua lá quando o
 * jogador chegar no 30. Era um estado da trilha por dia, e morreu
 * com ela.
 */
export const BATTLEPASS_CELL_STATES = ['locked', 'available', 'claimed', 'pending'] as const;
export type BattlePassCellState = (typeof BATTLEPASS_CELL_STATES)[number];

/** Uma célula já resolvida para um jogador: o que a tela desenha. */
export interface TrackCellView extends TrackCell {
  readonly state: BattlePassCellState;
  /**
   * Por que está trancada, quando está. É a frase do `deadButton`:
   * cadeado que não diz o motivo faz o jogador achar que o passe
   * engoliu o prêmio.
   */
  readonly reason: string | null;
}

// ------------------------------------------------------------
//  §5  AS REGRAS DE XP
// ------------------------------------------------------------

/**
 * A fonte de XP, na forma que o agente sabe medir.
 *
 * TEXTO e não um enum fechado: o cardápio é servido pelo agente
 * (frente B) e cresce com cada métrica nova — `pvp.kills`,
 * `ore.sulfur`, `quest.completed`. Um enum aqui obrigaria uma
 * migração a cada fonte nova, e o dono foi explícito: "o que vai
 * dar XP o administrador vai administrar isso".
 */
export const xpSourceSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'A fonte é a chave da métrica: minúsculas, dígitos, ponto e hífen.');

export const xpRuleInputSchema = z.object({
  source: xpSourceSchema,

  /** Desligada não conta, e não apaga o que já foi contado. */
  enabled: z.boolean().default(true),

  /** Quanto XP rende cada ocorrência. */
  amount: z.number().int().min(0).max(1_000_000).default(0),

  /**
   * O máximo que ESSA fonte rende por dia. `null` = sem teto.
   *
   * O teto é por fonte, e foi pedido assim com exemplo: "farm teto
   * de 100 XP por dia, caçar teto de 100 XP por dia". Não é um teto
   * único somando tudo — é justamente isso que deixa a missão
   * generosa e o farm contido sem escolher entre as duas coisas.
   */
  dailyCap: z.number().int().min(1).max(10_000_000).nullish().default(null),

  /** O rótulo que o jogador lê. Vazio = o do cardápio do agente. */
  label: optionalText(60).default(null),
});

export type XpRuleInput = z.infer<typeof xpRuleInputSchema>;

export interface XpRule extends XpRuleInput {
  readonly seasonId: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  §6  O PROGRESSO
// ------------------------------------------------------------

/**
 * O XP e o nível do jogador NAQUELE servidor.
 *
 * Não é `player_stats` (02 §4.1) por três motivos medidos: o painel
 * tem um botão que zera métricas, a linha de lá é por período de
 * ranking (que pode ser `wipe`) e `value` só cresce por soma. O
 * passe precisa de acumulador próprio, com a temporada dele como
 * janela.
 */
export interface PlayerProgress {
  readonly serverId: string;
  readonly steamId: string;
  readonly seasonId: number;
  readonly xp: number;
  /** O nível ALCANÇADO. Ver `levelAt`: começa em 1. */
  readonly level: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  §7  O DIREITO COMPRADO
// ------------------------------------------------------------

/**
 * De onde veio o direito.
 *
 *   loja    comprado no jogo, pela loja do agente
 *   painel  um admin concedeu
 *   site    venda ou caixa do site OrigemZ
 *
 * Os nomes são os do VIP (`vips.origin`), de propósito: quem lê o
 * registro dos dois lê a mesma palavra para a mesma coisa.
 */
export const BATTLEPASS_ENTITLEMENT_ORIGINS = ['loja', 'painel', 'site'] as const;
export type BattlePassEntitlementOrigin = (typeof BATTLEPASS_ENTITLEMENT_ORIGINS)[number];

/**
 * O pedido de dar o passe de um mês — a entrada única do `grant`.
 *
 * `period` vem do PLANO CONGELADO da compra, nunca do relógio da
 * entrega (04 §4): um débito `unknown` pode ser reconciliado horas
 * depois, atravessando a virada do mês.
 */
export const grantEntitlementSchema = z.object({
  serverId: z.string().min(1),
  steamId: steamIdSchema,
  period: seasonPeriodSchema,
  origin: z.enum(BATTLEPASS_ENTITLEMENT_ORIGINS),
  /**
   * O nível em que ele estava ao comprar.
   *
   * Só importa com o retroativo DESLIGADO (01 §5): aí a faixa paga
   * destrava do nível seguinte a este em diante. Com ele ligado —
   * que é o padrão — o número fica guardado e ninguém o lê. Quem o
   * preenche é o serviço, com o progresso daquele instante.
   */
  levelAtGrant: z.number().int().min(1).max(MAX_SEASON_LEVELS).default(1),
  /** O `DLV-…` da entrega do site, a referência da compra. */
  sourceRef: z.string().trim().min(1).max(120).nullish().default(null),
  note: optionalText(200).default(null),
  /** Quem deu: usuário do painel, `site:<ref>`, `loja:<compra>`. */
  createdBy: z.string().trim().min(1).max(120),
});

export type GrantEntitlementInput = z.input<typeof grantEntitlementSchema>;
export type GrantEntitlementValue = z.output<typeof grantEntitlementSchema>;

/** `POST /battlepass/entitlements`, como o painel o manda. */
export const entitlementBodySchema = z.object({
  serverId: z.string().min(1),
  steamId: steamIdSchema,
  /** Ausente = o mês corrente do servidor. Quem resolve é o serviço. */
  period: seasonPeriodSchema.optional(),
  note: optionalText(200).default(null),
});

export type EntitlementBody = z.infer<typeof entitlementBodySchema>;

export interface Entitlement {
  readonly id: number;
  readonly serverId: string;
  readonly steamId: string;
  readonly period: string;
  readonly origin: BattlePassEntitlementOrigin;
  /** O nível de quando comprou. Só o retroativo desligado o lê. */
  readonly levelAtGrant: number;
  readonly sourceRef: string | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly createdBy: string;
  /** `null` = vale. Revogar NÃO apaga a linha: o histórico fica. */
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
}

// ------------------------------------------------------------
//  §8  O RESGATE E A CAIXA
// ------------------------------------------------------------

/**
 * O estado da entrega de um resgate.
 *
 *   pending  o clique aconteceu e alguma parte ainda deve
 *   claimed  tudo entregue
 *
 * A marca de `claimed` vem DEPOIS da entrega, nunca antes (01 §6):
 * em 17/09/2026 um resgate de missão com a mochila cheia marcou a
 * missão como paga e não entregou nada.
 */
export const BATTLEPASS_CLAIM_STATUSES = ['pending', 'claimed'] as const;
export type BattlePassClaimStatus = (typeof BATTLEPASS_CLAIM_STATUSES)[number];

/**
 * Um resgate — e a prova do que ele prometia.
 *
 * `snapshot` é a recompensa CONGELADA, pelo mesmo princípio do
 * `player_quests.snapshot`: editar a trilha no dia 20 não pode
 * mudar o que o nível 3 prometia no dia 3.
 */
export interface BattlePassClaim {
  readonly id: number;
  readonly serverId: string;
  readonly steamId: string;
  readonly seasonId: number;
  readonly level: number;
  readonly lane: BattlePassLane;
  readonly status: BattlePassClaimStatus;
  readonly snapshot: readonly QuestReward[];
  readonly claimedAt: number;
  /** Quando a última entrega fechou. `null` enquanto houver pendência. */
  readonly settledAt: number | null;
}

/**
 * De onde veio a pendência (02 §6.4). As duas origens precisam
 * ficar distinguíveis na lista da caixa.
 *
 *   inventory  ele resgatou e não coube na mochila
 *   rollover   sobrou da temporada anterior e foi entregue no login
 */
export const BATTLEPASS_PENDING_ORIGINS = ['inventory', 'rollover'] as const;
export type BattlePassPendingOrigin = (typeof BATTLEPASS_PENDING_ORIGINS)[number];

/** Uma promessa que ainda não chegou — uma linha da caixa. */
export interface PendingDelivery {
  readonly id: number;
  readonly claimId: number;
  /**
   * A POSIÇÃO da recompensa dentro do `snapshot` do resgate.
   *
   * Renumerar quebraria o dedupe de pagamento exatamente no caminho
   * do retry (02 §6.3).
   */
  readonly idx: number;
  readonly serverId: string;
  readonly steamId: string;
  readonly origin: BattlePassPendingOrigin;
  readonly reward: QuestReward;
  /** O código cru de quem entregou: `INVENTORY_FULL`, `RCON_UNAVAILABLE`. */
  readonly code: string | null;
  readonly attempts: number;
  /** Quando o jogador ABRIU a caixa. O ponto de notificação some aqui. */
  readonly seenAt: number | null;
  readonly deliveredAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * O desfecho de UMA posição, como quem entrega o reporta.
 *
 * Uma falha não derruba as outras (02 §6.3): o item falha por
 * espaço e os 500 OZCoin da mesma linha são creditados.
 */
export interface DeliveryOutcome {
  readonly idx: number;
  readonly ok: boolean;
  /** O código cru quando deu errado. */
  readonly code?: string | null;
  /**
   * A frase ACIONÁVEL do jogador, quando existe uma.
   *
   * Só quando ele tem o que fazer a respeito — "Libere 2 slots na
   * mochila" —, e é por isso que ela não sai do código: `ITEM_UNKNOWN`
   * e `WALLET_FAILED` são problema do admin, e repeti-los no rodapé
   * daria ao jogador uma tarefa que não é dele.
   *
   * Não vai para o banco: a caixa guarda o código. Esta é a frase de
   * UMA resposta, e quem a costura no rodapé é o `BattlePassSync`.
   */
  readonly message?: string | null;
}

/** O pedido de resgate, como o jogo e o painel o mandam. */
export const claimRequestSchema = z.object({
  serverId: z.string().min(1),
  steamId: steamIdSchema,
  level: z.number().int().min(1).max(MAX_SEASON_LEVELS),
  lane: z.enum(BATTLEPASS_LANES),
});

export type ClaimRequest = z.infer<typeof claimRequestSchema>;

// ------------------------------------------------------------
//  §9  O REGISTRO
// ------------------------------------------------------------

/** Quem mexeu. As mesmas quatro origens do registro do Workshop. */
export const BATTLEPASS_AUDIT_SOURCES = ['panel', 'game', 'system', 'site'] as const;
export type BattlePassAuditSource = (typeof BATTLEPASS_AUDIT_SOURCES)[number];

export interface BattlePassAuditInput {
  /** Usuário do painel, `jogo:<steamId>`, `site:<ref>` ou `sistema`. */
  readonly actor: string;
  readonly source: BattlePassAuditSource;
  /** `season.create`, `season.state`, `entitlement.grant`, `claim`… */
  readonly action: string;
  /** "temporada #3 2026-10 (Temporada de outubro)"… */
  readonly target: string;
  readonly serverId?: string | null;
  /** O jogador AFETADO, quando há um. É por ele que a busca filtra. */
  readonly steamId?: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface BattlePassAuditEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly source: BattlePassAuditSource;
  readonly action: string;
  readonly target: string;
  readonly serverId: string | null;
  readonly steamId: string | null;
  readonly detail: Record<string, unknown>;
}

// ------------------------------------------------------------
//  §10  O QUE A TELA DO JOGADOR RECEBE
// ------------------------------------------------------------

/**
 * A trilha de um jogador num servidor, inteira.
 *
 * É a resposta única a "o que eu tenho?": o plugin desenha o card
 * com isto, o painel mostra a mesma coisa na aba Jogadores, e o
 * site não precisa de uma segunda conta.
 */
export interface PlayerTrack {
  readonly serverId: string;
  readonly steamId: string;
  /** `null` quando não há temporada ativa naquele servidor. */
  readonly season: BattlePassSeason | null;
  readonly progress: TrackProgress;
  /** `true` quando ele tem o direito VIVO daquele mês, naquele servidor. */
  readonly paid: boolean;
  readonly cells: readonly TrackCellView[];
  /** O que a caixa tem para ele, ainda não entregue. */
  readonly pending: readonly PendingDelivery[];
  /** Há pendência que ele ainda não olhou: o ponto de notificação. */
  readonly unseen: boolean;
}

// ------------------------------------------------------------
//  §11  O QUE ATRAVESSA O CONSOLE
// ------------------------------------------------------------

/**
 * O canal com o `OrigemZBattlePass.cs`.
 *
 * ####  ESTES NOMES SÃO PROTOCOLO  ####
 *
 * Eles não são escolha deste arquivo: o plugin já está escrito e
 * medido (branch `bp-d-plugin`, 17/09/2026), e mudar um lado sem o
 * outro é o modo de parar de funcionar em silêncio — o parser lê o
 * campo que falta como `false`/vazio e desenha uma tela errada sem
 * reclamar de nada.
 *
 * Quatro regras do canal que já custaram investigação neste
 * repositório e valem para quem montar a carga:
 *
 *   1. base64 obrigatório — o parser de console do Rust come as
 *      aspas de um JSON cru;
 *   2. segredo por subida em todo marcador, menos no `ready`. Sem
 *      ele, o jogador digita o marcador no chat e resgata a trilha
 *      inteira: o `onConsoleLine` recebe o chat junto com o resto;
 *   3. nenhum `Puts` no frame do comando — ele entra na resposta
 *      casada do RCON e a quebra;
 *   4. nenhum comando de RCON de dentro do gancho de console: laço
 *      garantido. Tudo por relógio.
 *
 * ####  DEPOIS DO `reply`, MANDE O `progress`  ####
 *
 * É a única coisa que o plugin exige do agente. A tela desenha o
 * clique na hora — o resgate vira "esperando" antes de qualquer
 * resposta — e é a carga de `progress` que apaga essa marca. Sem
 * ela, um resgate RECUSADO continua parecendo em andamento até o
 * jogador fechar e reabrir o menu.
 */
export const BATTLEPASS_MARKER = '#OZPASSE#';

export const BATTLEPASS_SYNC = 'origemz.passe.sync';
export const BATTLEPASS_PROGRESS = 'origemz.passe.progress';
export const BATTLEPASS_STATUS = 'origemz.passe.status';
export const BATTLEPASS_REPLY = 'origemz.passe.reply';
export const BATTLEPASS_OPEN = 'origemz.passe.open';

/**
 * A origem da pendência COMO O PLUGIN A CHAMA.
 *
 * Daqui para baixo os nomes são do contrato dele: `full` = não coube
 * na mochila; `season` = sobrou da temporada anterior. No banco e no
 * resto do agente as mesmas duas coisas se chamam `inventory` e
 * `rollover` — e é de propósito, porque `season` já significa
 * TEMPORADA em todo o módulo, e duas palavras iguais para coisas
 * diferentes é o tipo de colisão que só aparece no `grep`.
 *
 * A tradução mora em `payloadOriginOf`, e em lugar nenhum além dela.
 */
export type BattlePassPayloadOrigin = 'full' | 'season';

/** A tradução da origem, no ÚNICO ponto em que ela acontece. */
export function payloadOriginOf(origin: BattlePassPendingOrigin): BattlePassPayloadOrigin {
  return origin === 'rollover' ? 'season' : 'full';
}

/**
 * Uma faixa de um nível, dentro do `sync`.
 *
 * A faixa AUSENTE (e não um objeto vazio) é como se diz "este nível
 * não dá nada aqui".
 */
export interface BattlePassPayloadReward {
  /** `item`, `coins`, `kit`, `points`, `vip` ou `skin` — o `QuestReward`. */
  readonly kind: string;
  /** O texto que o jogador lê, em português, escrito pelo AGENTE. */
  readonly label: string;
  /**
   * O shortname do item do jogo, quando há um.
   *
   * O `itemid` é resolvido no PLUGIN, pelo `ItemManager`: o agente
   * não conhece o número, e um shortname que o Rust não reconhece
   * vira recompensa sem ícone — nunca um erro que apaga a trilha.
   */
  readonly shortname?: string;
  /** Texto, sempre: um `UInt64` não cabe no `number` do JS. `'0'` = sem skin. */
  readonly skinId?: string;
  /** O CRC de um PNG do FileStorage, para o que não é item do jogo. */
  readonly icon?: string;
  /**
   * A skin é de uma DLC da Facepunch.
   *
   * O agente manda `false` enquanto a marca não existir no cadastro
   * do Workshop: ela depende da sonda de `CheckSkinOwnership`, que
   * ninguém rodou (02 §7.1). Mandar `true` por adivinhação faria a
   * tela recusar recompensa que o jogador pode levar.
   */
  readonly dlc?: boolean;
  /** MARCO: destaque de tamanho no card (03 §3.1, regra 5). */
  readonly milestone?: boolean;
  /**
   * A quantidade.
   *
   * O plugin NÃO a lê (medido no `ReadReward` dele): o número que o
   * jogador vê está dentro do `label` ("Scrap x50"). Ela está no
   * exemplo do contrato e vai junto para quem comparar os dois lados
   * não achar que falta — mas nada na tela depende dela.
   */
  readonly amount?: number;
}

export interface BattlePassPayloadLevel {
  readonly level: number;
  /**
   * O XP ACUMULADO que alcança este nível — `xpToReach`, e não o
   * custo do degrau. O plugin só informa; quem soma é o agente.
   */
  readonly xp: number;
  readonly free?: BattlePassPayloadReward;
  readonly paid?: BattlePassPayloadReward;
}

/**
 * O catálogo daquele servidor. NUNCA um delta, e sem progresso: o
 * progresso desce por jogador, no `origemz.passe.progress`.
 *
 * É ele que destrava o resto: progresso que chega antes do catálogo
 * é recusado com `NO_SEASON`, e o agente reenvia no próximo gatilho.
 */
export interface BattlePassPayload {
  /** O segredo desta subida do agente. */
  readonly secret: string;
  readonly period: string;
  /** "SETEMBRO 2026" — o nome que o cabeçalho da tela mostra. */
  readonly name: string;
  /**
   * De qual servidor é esta trilha (01 §1.4).
   *
   * Sem isto a primeira queixa é "meu nível sumiu": o XP é por
   * servidor, e a tela precisa dizer de qual ela está falando.
   */
  readonly serverName: string;
  /** Quando a temporada fecha, epoch ms. `0` = não sei. */
  readonly endsAt: number;
  readonly freeLane: boolean;
  readonly paidLane: boolean;
  /** O passe está à venda aqui e agora. */
  readonly purchasable: boolean;
  /** "2.500 OZCOIN" — já formatado pelo agente, que é quem tem a moeda. */
  readonly priceLabel: string;
  readonly note: string;
  readonly levels: readonly BattlePassPayloadLevel[];
}

/** Uma exceção da trilha daquele jogador. Ver `BattlePassProgressPayload`. */
export interface BattlePassPayloadClaim {
  readonly level: number;
  readonly lane: BattlePassLane;
  readonly state: BattlePassCellState;
}

/** Uma linha da caixa, como o plugin a desenha. */
export interface BattlePassPayloadPending {
  /** O texto da linha, em português, escrito pelo agente. */
  readonly label: string;
  readonly origin: BattlePassPayloadOrigin;
}

/**
 * O progresso de UM jogador naquele servidor — a verdade sobre ele.
 *
 * ####  `claims` SÓ TRAZ EXCEÇÃO  ####
 *
 * Só as casas `claimed` e `pending` viajam. O resto o plugin DERIVA
 * pela tabela do 01 §4.1: nível alcançado é `available`, faixa paga
 * sem direito é `locked`, nível não alcançado é `locked`. Mandar as
 * trinta linhas de uma trilha inteira em toda carga seria pagar
 * banda para repetir o que a regra já diz — e duas fontes para a
 * mesma verdade divergem no primeiro caso de borda.
 *
 * A carga é INTEIRA (nunca delta), e a lista vazia é informação:
 * "ele não resgatou nada" é diferente de "não sei", e o plugin
 * mostra "sincronizando" para quem ele não conhece.
 */
export interface BattlePassProgressPayload {
  readonly secret: string;
  /** De que temporada é este progresso. Diferente da atual = velho. */
  readonly period: string;
  readonly level: number;
  readonly xp: number;
  /** O numerador de "2.400 / 3.000". */
  readonly xpInto: number;
  /** O denominador. **`0` = trilha concluída** — não há próximo para comprar. */
  readonly xpNeeded: number;
  readonly hasPass: boolean;
  /** O ponto de notificação já foi visto. É o `!unseen` do `PlayerTrack`. */
  readonly boxSeen: boolean;
  readonly claims: readonly BattlePassPayloadClaim[];
  readonly pending: readonly BattlePassPayloadPending[];
}

/**
 * As casas que viajam no `progress`.
 *
 * A regra do "só exceção" mora AQUI, e não em quem monta a carga:
 * ela é metade de um contrato cuja outra metade é a derivação do
 * plugin, e as duas divergindo produziriam uma tela que mostra
 * cadeado no que já foi resgatado.
 */
export function claimExceptionsOf(
  cells: readonly TrackCellView[],
): readonly BattlePassPayloadClaim[] {
  return cells
    .filter((cell) => cell.state === 'claimed' || cell.state === 'pending')
    .map((cell) => ({ level: cell.level, lane: cell.lane, state: cell.state }));
}

/** O que o `origemz.passe.status` responde. */
export interface BattlePassStatus {
  readonly period: string;
  readonly name: string;
  readonly levels: number;
  /** Quantos jogadores o plugin tem na memória. */
  readonly players: number;
  readonly menus: number;
  /** `false` = ele ainda não recebeu catálogo nenhum. */
  readonly secret: boolean;
  readonly endsAt: number;
}

/**
 * O que o plugin grita no console.
 *
 *   ready     subiu e quer a carga. O ÚNICO sem segredo.
 *   open      a tela abriu: mande o progresso fresco.
 *   claim     um nível, uma faixa.
 *   claimAll  o botão "resgatar tudo".
 *   box       ele abriu a caixa: o ponto de notificação some.
 *   retry     o "resgatar tudo" de DENTRO da caixa: entregar de novo
 *             o que ficou devendo.
 *   buy       ele clicou em ativar o passe.
 */
export const BATTLEPASS_PUSH_KINDS = [
  'ready',
  'open',
  'claim',
  'claimAll',
  'box',
  'retry',
  'buy',
] as const;
export type BattlePassPushKind = (typeof BATTLEPASS_PUSH_KINDS)[number];

/** O `requestId` do plugin: ele volta igual no `reply`. */
const requestIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,40}$/);

/**
 * O handshake. Vai SEM segredo — é ele que PEDE as cargas, e o
 * segredo só existe depois que o catálogo chega.
 */
export const battlePassReadyPushSchema = z.object({
  kind: z.literal('ready'),
});

/**
 * A tela abriu.
 *
 * Não espera resposta: ele avisa para o agente mandar o progresso
 * fresco. O XP chega ao agente em lotes de 60 s, então o que está no
 * plugin pode ter meio minuto de idade.
 */
export const battlePassOpenPushSchema = z.object({
  kind: z.literal('open'),
  secret: z.string().min(1),
  steamId: steamIdSchema,
});

/** O clique num nível. A resposta volta pelo `reply`, com o mesmo id. */
export const battlePassClaimPushSchema = z.object({
  kind: z.literal('claim'),
  secret: z.string().min(1),
  requestId: requestIdSchema,
  steamId: steamIdSchema,
  level: z.number().int().min(1).max(MAX_SEASON_LEVELS),
  lane: z.enum(BATTLEPASS_LANES),
});

/** "Resgatar tudo", "abrir a caixa", "pegar na caixa" e "ativar o passe": a mesma forma. */
export const battlePassPlayerPushSchema = z.object({
  kind: z.enum(['claimAll', 'box', 'retry', 'buy']),
  secret: z.string().min(1),
  requestId: requestIdSchema,
  steamId: steamIdSchema,
});

export type BattlePassOpenPush = z.infer<typeof battlePassOpenPushSchema>;
export type BattlePassClaimPush = z.infer<typeof battlePassClaimPushSchema>;
export type BattlePassPlayerPush = z.infer<typeof battlePassPlayerPushSchema>;

/**
 * A resposta do agente a um pedido, pelo `origemz.passe.reply`.
 *
 * A `message` é o que o jogador lê no rodapé, em português, escrita
 * pelo agente — ele é quem sabe quantos slots faltaram. Um
 * `requestId` que o plugin não conhece mais não é erro: ele responde
 * `{"ok":true,"unknown":true}`, e o agente já fez a parte dele.
 */
export interface BattlePassReply {
  readonly requestId: string;
  readonly ok: boolean;
  readonly message: string;
}
