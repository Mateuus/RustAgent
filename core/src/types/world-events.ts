// ============================================================
//  world-events.ts  -  O CONTRATO DO GUARDA-CHUVA.
//
//  O vocabulário e a RÉGUA de tudo que NASCE no mapa: quando
//  nasce, onde pode nascer, o que fala, quem entra, quanto dura.
//
//  ####  UMA RÉGUA SÓ, E ELA É IMPORTADA  ####
//
//  A rota valida com estes schemas; o repositório grava o que eles
//  produziram; o agendador lê o mesmo tipo. Ninguém redigita um
//  `z.object` equivalente — a lição está em `site/appliers/store.ts`:
//  "uma segunda régua para a mesma tabela é uma régua que vai
//  divergir, e a que ficar mais frouxa é a que grava".
//
//  ------------------------------------------------------------
//  ####  `world` PORQUE `events` JÁ É O CALENDÁRIO  ####
//
//  A migração 027 criou `events` para "Raid Night, sábado às 20h" —
//  uma DATA que alguém anunciou. Estas são coisas que NASCEM no
//  mapa, com posição, dono e destroços. As duas são "evento" em
//  português e não têm nada em comum.
//
//  ------------------------------------------------------------
//  ####  NADA AQUI DECIDE NADA  ####
//
//  "Está na hora?", "tem gente o bastante?", "esse ponto está livre?"
//  são todos do agendador. Este arquivo diz o que um evento É; o
//  agendador diz o que ele FAZ.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §2 e §6.
// ============================================================

import { z } from 'zod';

// ------------------------------------------------------------
//  §1  VOCABULÁRIO
// ------------------------------------------------------------

/**
 * Como o evento nasce.
 *
 *   schedule   o agendador sorteia dentro da janela
 *   manual     só por comando ou botão do painel
 *   permanent  plantado à mão, fica até o wipe
 */
export const SPAWN_MODES = ['schedule', 'manual', 'permanent'] as const;
export type SpawnMode = (typeof SPAWN_MODES)[number];

/**
 * Quem entra.
 *
 * No modo permanente isto vale `anyone` na leitura, sempre: uma
 * masmorra fixa em que só o primeiro entra é uma masmorra que
 * ninguém visita.
 */
export const EVENT_ACCESS = ['anyone', 'owner', 'team'] as const;
export type EventAccess = (typeof EVENT_ACCESS)[number];

/** O estado de um nascimento. */
export const RUN_STATUS = [
  'scheduled',
  'spawning',
  'active',
  'closing',
  'ended',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/**
 * Por que não nasceu.
 *
 * ####  OS MESMOS NOMES DOS DOIS LADOS DO FIO  ####
 *
 * O plugin manda `{"kind":"failed","reason":"no_hatch"}` e a coluna
 * `failure_reason` guarda a mesma palavra. Um evento que falha e
 * diz "erro" obriga alguém a abrir o log do servidor — que é
 * exatamente a hora em que ninguém quer fazer isso.
 */
export const FAILURE_REASONS = [
  /** O sorteio não achou lugar livre. */
  'no_position',
  /** Construiu, e o par de alçapões não apareceu. */
  'no_hatch',
  /** O arquivo da planta não estava no disco daquele servidor. */
  'blueprint_missing',
  /** O JSON estava lá e não é uma planta. */
  'blueprint_invalid',
  /** Menos gente online que `minOnline`. */
  'too_few_online',
  /** Já tem evento no ar e este não divide o palco. */
  'already_active',
  /** O wipe está em curso, ou perto demais. */
  'wipe_window',
  /** Passou do teto de construção e desistiu. */
  'build_timeout',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** A frase que o painel mostra, por motivo. */
export const FAILURE_MESSAGE: Record<FailureReason, string> = {
  no_position: 'Não achei lugar livre no mapa: todas as tentativas caíram em zona proibida, na água ou perto de base de jogador.',
  no_hatch: 'A construção subiu, mas o par de alçapões não apareceu. Sem eles não há masmorra.',
  blueprint_missing: 'A planta não estava no disco daquele servidor.',
  blueprint_invalid: 'O arquivo da planta está lá, e não é uma planta.',
  too_few_online: 'Tinha menos gente online que o mínimo do evento.',
  already_active: 'Já havia um evento no ar naquele servidor.',
  wipe_window: 'O wipe estava em curso, ou perto demais.',
  build_timeout: 'A construção passou do tempo máximo e foi desfeita.',
};

// ------------------------------------------------------------
//  §2  A RÉGUA DA ESCRITA
// ------------------------------------------------------------

/**
 * O slug.
 *
 * Ele viaja num comando de console, e o parser do Rust corta em
 * espaço. Minúsculas, dígitos e hífen — a mesma régua do id de
 * servidor, pelo mesmo motivo: ele vira nome de arquivo e o
 * Windows não distingue `Pvp1` de `pvp1`.
 */
export const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'use minúsculas, dígitos e hífen');

/**
 * A cor do marcador, em hexa.
 *
 * Texto e não três floats porque quem edita é um seletor de cor no
 * painel, e converter nas duas pontas é onde o valor se perde.
 */
const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'use o formato #rrggbb');

/**
 * Uma frase que o servidor fala.
 *
 * `null` = usa a frase padrão do agente. String vazia é tratada
 * como `null` na normalização: um campo que o admin esvaziou
 * quer dizer "volte ao padrão", e não "não fale nada".
 */
const messageSchema = z.string().max(500).nullable().optional();

/**
 * Uma janela de dois números.
 *
 * O `superRefine` existe porque `min > max` é o erro que produz o
 * sintoma mais confuso: o sorteio devolve `NaN` ou fica preso, e o
 * evento simplesmente nunca nasce, sem nada no log.
 */
function windowSchema(field: string, min: number, max: number) {
  return z
    .object({
      min: z.number().int().min(min).max(max),
      max: z.number().int().min(min).max(max),
    })
    .superRefine((value, ctx) => {
      if (value.min > value.max) {
        ctx.addIssue({
          code: 'custom',
          message: `o mínimo de ${field} não pode ser maior que o máximo`,
        });
      }
    });
}

export const worldEventInputSchema = z.object({
  id: slugSchema,
  kind: z.string().min(2).max(32).default('dungeon'),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).nullable().optional(),

  enabled: z.boolean().default(true),
  sort: z.number().int().min(0).max(9999).default(0),

  spawnMode: z.enum(SPAWN_MODES).default('schedule'),

  // Um minuto é o piso do intervalo: abaixo disso o agendador
  // dispara mais rápido do que uma masmorra leva para ser
  // construída e derrubada.
  interval: windowSchema('intervalo', 60, 86_400).default({ min: 3600, max: 7200 }),
  duration: windowSchema('duração', 60, 86_400).default({ min: 2000, max: 3000 }),

  minOnline: z.number().int().min(0).max(500).default(1),
  countAfterEnd: z.boolean().default(false),

  access: z.enum(EVENT_ACCESS).default('team'),
  ownerGraceSeconds: z.number().int().min(0).max(3600).default(300),

  marker: z
    .object({
      enabled: z.boolean().default(true),
      label: z.string().min(1).max(40).default('Masmorra'),
      color: hexColorSchema.default('#ff0000'),
      alpha: z.number().min(0).max(1).default(0.55),
      radius: z.number().min(0.1).max(10).default(0.5),
      showOwner: z.boolean().default(true),
      showTime: z.boolean().default(true),
    })
    .prefault({}),

  messages: z
    .object({
      start: messageSchema,
      location: messageSchema,
      warning: messageSchema,
      end: messageSchema,
      denied: messageSchema,
    })
    .prefault({}),

  warnBefore: z.number().int().min(0).max(3600).default(300),
  radiationBefore: z.number().int().min(0).max(3600).default(180),
  destroyAfter: z.number().int().min(0).max(3600).default(60),

  // 0 = o loot não volta. Só vale no modo permanente.
  respawnSeconds: z.number().int().min(0).max(86_400).default(3600),

  /** Vazio = não roda em servidor nenhum, que é o estado de um evento novo. */
  servers: z.array(z.string().min(1)).default([]),
});

export type WorldEventInput = z.infer<typeof worldEventInputSchema>;

/** A edição não muda o slug: ele é a identidade. */
export const worldEventUpdateSchema = worldEventInputSchema.omit({ id: true });
export type WorldEventUpdate = z.infer<typeof worldEventUpdateSchema>;

/**
 * Uma zona onde nenhum evento nasce.
 *
 * É por SERVIDOR, e não da rede: uma zona é um lugar no mapa, e
 * cada servidor tem o seu. Guardá-la na rede faria a proibição de
 * um mundo cair no meio de outro.
 */
export const eventZoneInputSchema = z.object({
  label: z.string().max(80).default(''),
  x: z.number(),
  z: z.number(),
  // Um raio menor que dez metros não protege nada; maior que dois
  // mil engole um mapa de 4.000.
  radius: z.number().min(10).max(2000).default(100),
});

export type EventZoneInput = z.infer<typeof eventZoneInputSchema>;

// ------------------------------------------------------------
//  §3  O QUE SAI DAQUI PARA O PAINEL
// ------------------------------------------------------------

/** Um evento, como o painel o vê. Datas em epoch ms. */
export interface WorldEvent extends WorldEventInput {
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Um nascimento. */
export interface EventRun {
  readonly id: number;
  readonly eventId: string;
  readonly serverId: string;
  readonly dungeonId: string | null;
  readonly status: RunStatus;
  readonly failureReason: FailureReason | null;
  readonly x: number | null;
  readonly z: number | null;
  readonly grid: string | null;
  readonly seed: number | null;
  readonly ownerSteamId: string | null;
  readonly enteredCount: number;
  readonly scheduledFor: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** Quem entrou numa run. */
export interface EventRunPlayer {
  readonly steamId: string;
  readonly enteredAt: number;
  readonly leftAt: number | null;
  readonly died: boolean;
}

export interface EventZone extends EventZoneInput {
  readonly id: number;
  readonly serverId: string;
  readonly createdAt: number;
}
