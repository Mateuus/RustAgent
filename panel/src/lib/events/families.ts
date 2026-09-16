// ============================================================
//  families.ts  -  QUAIS EVENTOS EXISTEM, E ONDE CADA UM MORA.
//
//  ####  O GUARDA-CHUVA GANHOU UM SEGUNDO INQUILINO  ####
//
//  A migração 057 já dizia por que `world_events` nasceu antes de
//  haver dois eventos: "o que justifica é o SEGUNDO — agenda,
//  marcador, anúncio, dono, time e zona proibida são os mesmos para
//  qualquer coisa que nasça no mundo e morra depois".
//
//  O segundo chegou: o KOTH. E com ele a tela precisou da mesma
//  separação que o banco já tinha — o que é DE TODOS (a agenda, o
//  histórico, o que está no ar) e o que é DE UM SÓ (a planta da
//  masmorra, o volume de captura do KOTH).
//
//  ####  ESTA LISTA É A FONTE DA NAVEGAÇÃO  ####
//
//  Os cartões do hub, o rótulo da família no histórico e o nome que
//  a agenda mostra saem todos daqui. Uma família nova é uma linha
//  nesta lista mais a rota dela — e nada mais na tela precisa saber
//  que ela apareceu.
//
//  Espelha `EVENT_KINDS` em `core/src/types/world-events.ts`.
// ============================================================

import { Flag, Swords, type LucideIcon } from 'lucide-react';

export interface EventFamily {
  /** O `kind` da linha em `world_events`. */
  readonly kind: string;
  readonly one: string;
  readonly many: string;
  /** A rota da tela dela. */
  readonly href: string;
  readonly hint: string;
  readonly Icon: LucideIcon;
  /**
   * O agente sabe erguer esta família HOJE?
   *
   * `false` = a tela existe para dizer o que vem, e a agenda avisa
   * que nada vai nascer. Espelha `RUNNABLE_EVENT_KINDS` no agente —
   * e é o mesmo não que o agendador dá, dito antes, na tela.
   */
  readonly ready: boolean;
}

export const EVENT_FAMILIES: readonly EventFamily[] = [
  {
    kind: 'dungeon',
    one: 'Masmorra',
    many: 'Masmorras',
    href: '/eventos/masmorras/',
    hint: 'Uma casinha com alçapão, e noventa metros abaixo do mundo os corredores que ninguém vê de fora',
    Icon: Swords,
    ready: true,
  },
  {
    kind: 'koth',
    one: 'KOTH',
    many: 'KOTH',
    href: '/eventos/koth/',
    hint: 'Um território no mapa aberto: quem fica dentro dele o bastante, e defende, leva o prêmio',
    Icon: Flag,
    // O relógio do KOTH existe desde as VAGAS: ele sorteia um
    // território ligado, respeita o máximo do servidor e adia
    // enquanto houver masmorra de pé.
    ready: true,
  },
];

/**
 * A família de um `kind`.
 *
 * `null` quando a coluna traz um valor que a tela não conhece — a
 * coluna é TEXTO LIVRE de propósito, e um agente mais novo que o
 * painel pode devolver uma família que este build nunca viu. Quem
 * chama mostra o próprio `kind` cru nesse caso, em vez de sumir com
 * a linha.
 */
export function familyOf(kind: string): EventFamily | null {
  return EVENT_FAMILIES.find((family) => family.kind === kind) ?? null;
}

/** O nome da família na tela. Cai no `kind` cru quando não a conhece. */
export function familyLabel(kind: string): string {
  return familyOf(kind)?.one ?? kind;
}
