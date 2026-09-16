// ============================================================
//  schedule-summary.ts  -  o que a agenda diz de cada linha.
//
//  ####  A FRASE DEPENDE DA FAMÍLIA, E ISSO NÃO ERA VERDADE  ####
//
//  A agenda nasceu com uma família só, e a linha dela dizia sempre a
//  mesma coisa: qual masmorra, a cada quanto, e quanto tempo fica de
//  pé. Com o KOTH, duas dessas três passaram a ser mentira.
//
//    qual masmorra   o KOTH não tem masmorra. A linha avisava "sem
//                    masmorra escolhida — não vai nascer" embaixo de
//                    um evento que nasce perfeitamente.
//
//    quanto fica     a duração do KOTH é do TERRITÓRIO, não do
//                    horário. O campo existe na tabela, viaja no
//                    payload, e o agente o ignora — quem manda é o
//                    `durationSeconds` da arena.
//
//  ####  POR QUE ISTO NÃO MORA NO JSX  ####
//
//  Porque é uma cadeia de "se", e é a cadeia que erra. Uma frase
//  errada aqui não quebra a tela: ela informa ao contrário, com
//  confiança, para quem está configurando — e o admin desliga um
//  evento que funcionava ou espera um que nunca vem.
// ============================================================

import { familyOf } from '@/lib/events/families';

/** O mínimo que esta leitura precisa de um horário. */
export interface ScheduleLike {
  readonly kind: string;
  readonly dungeonId: string | null;
  readonly interval: { readonly min: number; readonly max: number };
  readonly duration: { readonly min: number; readonly max: number };
  readonly minOnline: number;
  readonly servers: readonly string[];
}

export interface ScheduleSummary {
  /**
   * O que impede este horário de acontecer.
   *
   * `null` = nada impede. Quando há aviso, ele SUBSTITUI o resumo:
   * de que adianta dizer a cadência de um evento que não nasce?
   */
  readonly warning: string | null;
  /** As partes do resumo, na ordem, já em português. */
  readonly parts: readonly string[];
}

/**
 * O resumo de um horário.
 *
 * `dungeonName` devolve o nome de uma masmorra pelo id, ou `null`
 * quando ela não existe mais — uma masmorra apagada deixa horários
 * apontando para o vazio, e mostrar o id cru é melhor que sumir.
 */
export function describeSchedule(
  event: ScheduleLike,
  dungeonName: (id: string) => string | null,
): ScheduleSummary {
  const family = familyOf(event.kind);

  if (family === null || !family.ready) {
    return {
      warning: 'o agente ainda não sabe erguer esta família — nada vai nascer',
      parts: [],
    };
  }

  const parts: string[] = [];

  // ####  A MASMORRA É DA MASMORRA  ####
  if (event.kind === 'dungeon') {
    if (event.dungeonId === null) {
      return { warning: 'sem masmorra escolhida — não vai nascer', parts: [] };
    }

    parts.push(dungeonName(event.dungeonId) ?? event.dungeonId);
  }

  parts.push(`a cada ${windowLabel(event.interval)}`);

  // O KOTH fica de pé pelo que o TERRITÓRIO diz; o horário só
  // escolhe a hora de começar.
  if (event.kind === 'dungeon') {
    parts.push(`dura ${windowLabel(event.duration)}`);
  } else if (event.kind === 'koth') {
    parts.push('dura o que o território disser');
  }

  if (event.minOnline > 0) parts.push(`mínimo ${String(event.minOnline)} online`);

  if (event.servers.length > 0) parts.push(event.servers.join(', '));

  return { warning: null, parts };
}

/**
 * Uma janela de segundos, em minutos.
 *
 * Janela fechada (min = max) vira um número só: "a cada 60–60 min"
 * é o tipo de frase que faz quem lê procurar o erro.
 *
 * Ela morava no `schedule-panel`; veio para cá junto do resumo, que
 * é quem mais a usa.
 */
export function windowLabel(window: { readonly min: number; readonly max: number }): string {
  const min = Math.round(window.min / 60);
  const max = Math.round(window.max / 60);

  return min === max ? `${String(min)} min` : `${String(min)}–${String(max)} min`;
}
