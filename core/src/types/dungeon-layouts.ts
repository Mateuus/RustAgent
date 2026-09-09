// ============================================================
//  dungeon-layouts.ts  -  O CONTRATO DO TRAÇADO SALVO.
//
//  Um traçado é um desenho de masmorra guardado por si só, fora de
//  qualquer masmorra: o admin desenha uma vez, salva, e a partir
//  dali toda masmorra nova pode começar dali em vez do zero.
//
//  ####  POR QUE ELE NÃO É UMA `dungeon_blueprints`  ####
//
//  Aquele acervo guarda JSON do CopyPaste: uma construção literal,
//  peça por peça, que o plugin COLA. Um traçado é um esquema de
//  células, que o plugin CONSTRÓI. O materializador escreve o
//  primeiro no disco para o plugin colar — e escrever um desenho
//  ali produziria um arquivo que o CopyPaste não sabe ler.
//
//  Dois formatos, dois acervos. Na tela eles aparecem juntos,
//  porque para quem usa os dois são "plantas".
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §4.2.
// ============================================================

import { z } from 'zod';

import { dungeonGridSchema } from './dungeons.js';
import { slugSchema } from './world-events.js';

/** De onde o traçado veio. */
export const LAYOUT_ORIGINS = ['builtin', 'panel', 'capture'] as const;
export type DungeonLayoutOrigin = (typeof LAYOUT_ORIGINS)[number];

export const dungeonLayoutInputSchema = z.object({
  id: slugSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(1000).nullable().default(null),
  grid: dungeonGridSchema,
});

export type DungeonLayoutInput = z.infer<typeof dungeonLayoutInputSchema>;

/**
 * A linha da lista.
 *
 * Traz o `grid`: ao contrário de uma planta do CopyPaste, um
 * desenho inteiro cabe em algumas centenas de bytes, e a tela
 * precisa dele para mostrar a MINIATURA. Uma lista de traçados sem
 * o desenho seria uma lista de nomes — exatamente o que o dono
 * apontou que não servia.
 */
export interface DungeonLayoutSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly grid: readonly string[];
  readonly cellCount: number;
  readonly roomCount: number;
  readonly byColor: { readonly green: number; readonly blue: number; readonly red: number };
  readonly hasEntrance: boolean;
  /** Quantos defeitos o verificador achou na escrita. Ver `checkLayout`. */
  readonly problemCount: number;
  readonly origin: DungeonLayoutOrigin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  OS TRAÇADOS DE FÁBRICA
// ------------------------------------------------------------

/**
 * Quatro desenhos prontos, feitos à mão.
 *
 * ####  ELES EXISTEM PARA O PRIMEIRO MINUTO  ####
 *
 * Encarar um grid de 24×24 em branco paralisa tanto quanto trinta
 * campos vazios. Sortear ajuda, mas um sorteio sai amorfo: estes
 * quatro são formas que um humano reconhece — um corredor reto,
 * uma cruz, uma espinha, uma serpente — e das quais dá para partir
 * apagando e esticando.
 *
 * ####  E OS QUATRO PASSAM NO VERIFICADOR  ####
 *
 * Toda sala encosta em corredor, a entrada está colada nele, nada
 * fica ilhado e nada flutua. `dungeon-layout.test.ts` cobra isso —
 * um traçado de fábrica com defeito seria o pior lugar possível
 * para um: é o que o admin copia achando que é o certo.
 *
 * A primeira linha é a de MAIOR z (o norte em cima), e a letra é a
 * COR da sala: G verde, B azul, R vermelha.
 */
export const FACTORY_LAYOUTS: readonly DungeonLayoutInput[] = [
  {
    id: 'corredor-reto',
    name: 'Corredor reto',
    description: 'O mais simples: um corredor único com salas nos dois lados e a boa no fundo.',
    grid: [
      '..RR..',
      '..RR..',
      'GG##BB',
      'GG##BB',
      '..##..',
      'GG##BB',
      'GG##BB',
      '..##..',
      '..E#..',
    ],
  },
  {
    id: 'cruz',
    name: 'Cruz',
    description: 'Quatro braços a partir da entrada: o jogador escolhe por onde vai, e volta.',
    grid: [
      '....RR....',
      '....RR....',
      '....##....',
      'BB######GG',
      'BB######GG',
      '..GG##BB..',
      '..GG##BB..',
      '....E#....',
    ],
  },
  {
    id: 'espinha',
    name: 'Espinha',
    description: 'Um corredor comprido com salas alternadas dos dois lados. Rápido de limpar.',
    grid: [
      '.GG..BB..RR.',
      '.GG..BB..RR.',
      'E###########',
      '############',
      '.BB..GG..GG.',
      '.BB..GG..GG.',
    ],
  },
  {
    id: 'serpente',
    name: 'Serpente',
    description: 'O caminho dobra três vezes: ninguém vê o fim da masmorra da entrada.',
    grid: [
      'RR##......',
      'RR##......',
      '..##......',
      '..########',
      '..########',
      '..GG..BB##',
      '..GG..BB##',
      '........##',
      '......GG##',
      '......GG##',
      '........E#',
    ],
  },
];
