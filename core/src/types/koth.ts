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
//  ####  E A RECOMPENSA FÍSICA TAMBÉM  ####
//
//  A caixa que nasce no fim é do território pela mesma razão: "a
//  colina difícil rende a caixa boa" é a frase que o admin quer
//  escrever, e ela não cabe num prêmio único para todos os lugares.
//
//  O que NÃO está aqui é a recompensa em ECONOMIA — OZCoin, troféu,
//  kit, VIP. Essa é do agente, e entra quando o ledger de entregas
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
/**
 * O que nasce quando alguém vence.
 *
 * ####  PESO, E NÃO PORCENTAGEM  ####
 *
 * Cada tipo de caixa tem um peso, e o sorteio é entre eles. Somar
 * 100 à mão é a conta que ninguém acerta na terceira edição — e um
 * tipo novo não pode obrigar a refazer os outros.
 *
 * Lista vazia = a caixa padrão do plugin. É o que acontece num
 * território que o admin criou e ainda não configurou, e é melhor
 * que não nascer nada.
 */
export const kothCrateSchema = z.object({
  /** O caminho do prefab. O painel oferece o catálogo; o campo aceita qualquer um. */
  prefab: z.string().min(1).max(200),
  /** O peso no sorteio. Zero = cadastrada e fora do sorteio. */
  weight: z.number().min(0).max(1000).default(1),
});

export type KothCrate = z.infer<typeof kothCrateSchema>;

export const kothRewardSchema = z.object({
  /** A fumaça do jogo: 45 s, e apaga sozinha. */
  smoke: z.boolean().default(true),
  /** O morteiro vermelho, que sobe e estoura. */
  flare: z.boolean().default(true),

  crates: z.array(kothCrateSchema).max(20).default([]),
  /** Quantas caixas nascem. Zero = o evento não deixa prêmio físico. */
  count: z.number().int().min(0).max(10).default(1),

  /**
   * Quantos segundos a caixa fica no mapa.
   *
   * Zero = fica até alguém abrir. NÃO é o padrão: caixa de evento
   * que não some é mapa sujo, e num servidor com KOTH de hora em
   * hora seriam dezenas até o wipe.
   *
   * A caixa VAZIA some sozinha de qualquer jeito — `destroyOnEmpty`
   * é padrão do LootContainer do jogo.
   */
  crateSeconds: z.number().int().min(0).max(86_400).default(600),
});

export type KothReward = z.infer<typeof kothRewardSchema>;

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
   * ZERO é o padrão do KOTH normal, por decisão do dono: "a
   * porcentagem conquistada permanece salva". A barra é do EVENTO e
   * não do grupo — quem chega continua de onde o outro parou, e nem
   * o tempo nem a morte devolvem o progresso ao zero.
   *
   * Quem fecha um evento que ninguém terminou é o teto de duração.
   * O campo fica para o admin que quiser o contrário.
   *
   * Ver Docs/KOTH/DECISOES-DO-DONO.md §7.
   */
  decayPerSecond: z.number().min(0).max(60).default(0),

  /** A cor do círculo no mapa do jogo. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use o formato #rrggbb').default('#c4b454'),

  enabled: z.boolean().default(true),

  /** O que nasce no fim. Ver `kothRewardSchema`. */
  reward: kothRewardSchema.prefault({}),
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

/**
 * Um território de pé, como o plugin o descreve.
 *
 * É o que a tela do jogador e o painel mostram: o card de uma vaga.
 */
export interface KothLiveEvent {
  readonly runId: string;
  readonly name: string;
  readonly grid: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly percent: number;
  readonly progress: number;
  readonly captureSeconds: number;
  /** `"0"` = ninguém está capturando agora. */
  readonly holder: string;
  readonly holderName: string;
  /** Dois ou mais lados dentro: ninguém avança. */
  readonly contested: boolean;
  readonly elapsed: number;
  readonly durationSeconds: number;
  readonly inside: number;
}

/**
 * O que o plugin responde quando se pergunta o estado.
 *
 * ####  UMA LISTA, MESMO COM UM SÓ  ####
 *
 * `active` continua para quem só quer saber se há algo acontecendo,
 * mas o que importa é `events`. Uma resposta que mudasse de forma
 * conforme a quantidade obrigaria quem lê a tratar dois casos.
 */
export interface KothStatus {
  readonly active: boolean;
  readonly count?: number;
  readonly events?: readonly KothLiveEvent[];
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
