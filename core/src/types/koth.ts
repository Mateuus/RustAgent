// ============================================================
//  koth.ts  -  O CONTRATO DO DOMÍNIO DE TERRITÓRIO.
//
//  ####  O TERRITÓRIO CARREGA A REGRA, E NÃO SÓ O LUGAR  ####
//
//  O ponto de nascimento da masmorra é só um x/z: o que nasce ali é
//  decidido pela masmorra escolhida. Aqui é diferente — "aquela
//  colina" e "o vale do rio" são disputas DIFERENTES: uma é aberta e
//  larga, a outra é fechada e rápida.
//
//  Por isso o raio, a altura, o tempo de captura e a duração moram
//  no território, e não num perfil à parte. Perfis reutilizáveis são
//  a próxima camada, quando houver territórios demais para manter um
//  a um — e não antes: a spec pede perfis, mas um perfil sozinho, com
//  um território só, é uma indireção que não paga o aluguel.
//
//  ####  O QUE NÃO ESTÁ AQUI  ####
//
//  Recompensa. Ela é do agente e não do território — o mesmo prêmio
//  vale em qualquer colina —, e entra quando o ledger de entregas
//  existir. Ver Docs/KOTH/DECISOES-DO-DONO.md.
// ============================================================

import { z } from 'zod';

/**
 * A régua de um território.
 *
 * Os limites não são chutes:
 *
 *   raio    5 m é menor que uma fundação (um evento que cabe numa
 *           sala não é território); 200 m é o tamanho de um
 *           monumento grande.
 *   altura  do chão para cima. Sem teto, quem passa de helicóptero
 *           captura; sem piso, quem está no metrô também.
 *   captura 10 s é tempo de teste; 2 h é mais que o dia de qualquer
 *           um. O padrão de 5 min veio do modelo de DayZ.
 */
export const kothArenaInputSchema = z.object({
  label: z.string().trim().min(1, 'dê um nome ao território').max(60),
  x: z.number().finite(),
  z: z.number().finite(),
  /**
   * A altura do chão naquele ponto.
   *
   * `null` = o servidor resolve na hora de erguer, lendo o terreno.
   * É o normal: o admin marca no mapa, que é plano, e uma altura
   * digitada à mão põe a bandeira enterrada ou voando.
   */
  y: z.number().finite().nullable().default(null),

  radius: z.number().min(5).max(200).default(25),
  height: z.number().min(5).max(200).default(30),

  captureSeconds: z.number().int().min(10).max(7200).default(300),
  durationSeconds: z.number().int().min(60).max(21_600).default(1800),

  /**
   * Quanto o progresso cai por segundo com a zona vazia.
   *
   * Zero = o que foi conquistado fica. Não é o padrão: sem decaimento
   * o primeiro que chegar num evento vazio volta horas depois e
   * termina a captura sozinho.
   */
  decayPerSecond: z.number().min(0).max(60).default(1),

  /** A cor do círculo no mapa do jogo. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use o formato #rrggbb').default('#c4b454'),

  enabled: z.boolean().default(true),
});

export type KothArenaInput = z.infer<typeof kothArenaInputSchema>;

export interface KothArena extends KothArenaInput {
  readonly id: number;
  readonly serverId: string;
  /** `"<worldSize>:<seed>"` do mundo em que ele foi marcado. */
  readonly worldKey: string | null;
  /** A grade do mapa, respondida pelo servidor: "E7". */
  readonly grid: string | null;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** O que o plugin responde quando se pergunta o estado. */
export interface KothStatus {
  readonly active: boolean;
  readonly runId?: string;
  readonly name?: string;
  readonly grid?: string;
  readonly percent?: number;
  readonly progress?: number;
  readonly captureSeconds?: number;
  readonly holder?: string;
  readonly holderName?: string;
  readonly elapsed?: number;
  readonly inside?: number;
}

/** O que o plugin grita no console. Ver `#OZKOTH#` em OrigemZKoth.cs. */
export const KOTH_PUSH_KINDS = ['ready', 'started', 'captured', 'expired', 'ended'] as const;
export type KothPushKind = (typeof KOTH_PUSH_KINDS)[number];

export interface KothPush {
  readonly kind: KothPushKind;
  readonly runId?: string;
  readonly reason?: string;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly members?: readonly string[];
  readonly seconds?: number;
  readonly grid?: string;
  readonly x?: number;
  readonly z?: number;
}
