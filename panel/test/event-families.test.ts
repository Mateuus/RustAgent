// ============================================================
//  As famílias de evento, e o espelho com o agente.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O painel carregou por semanas um "o agente ainda não sabe erguer
//  esta família — nada vai nascer" embaixo do KOTH agendado. O
//  agendador do KOTH já existia; quem não sabia era a tela.
//
//  É a pior classe de erro que uma tela comete: ela não quebra, não
//  reclama, e MENTE com confiança para quem está configurando. O
//  admin lê aquilo e conclui que não adianta cadastrar.
//
//  Por isso o teste lê o ARQUIVO do agente em vez de repetir a
//  lista aqui. Uma cópia à mão só adia a divergência — foi
//  exatamente uma cópia à mão que produziu o aviso mentiroso.
// ============================================================

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EVENT_FAMILIES, familyLabel, familyOf } from '@/lib/events/families';

/** O que o agente diz que sabe erguer hoje. */
function runnableInTheAgent(): readonly string[] {
  const source = readFileSync(
    new URL('../../core/src/types/world-events.ts', import.meta.url),
    'utf8',
  );

  const line = /RUNNABLE_EVENT_KINDS[^=]*=\s*\[([^\]]*)\]/.exec(source);

  if (line === null) {
    throw new Error(
      'não achei RUNNABLE_EVENT_KINDS em core/src/types/world-events.ts — se ela mudou de nome, este teste precisa saber',
    );
  }

  return quoted(line[1] ?? '');
}

/** As famílias que o agente conhece, erguendo ou não. */
function kindsInTheAgent(): readonly string[] {
  const source = readFileSync(
    new URL('../../core/src/types/world-events.ts', import.meta.url),
    'utf8',
  );

  const line = /EVENT_KINDS\s*=\s*\[([^\]]*)\]/.exec(source);

  if (line === null) throw new Error('não achei EVENT_KINDS no agente');

  return quoted(line[1] ?? '');
}

/** Os textos entre aspas simples de um trecho. */
function quoted(fragment: string): readonly string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('o espelho com o agente', () => {
  it('toda família do agente tem tela no painel', () => {
    const painel = EVENT_FAMILIES.map((family) => family.kind);

    expect([...kindsInTheAgent()].sort()).toEqual([...painel].sort());
  });

  it('"pronta" na tela é o que o agente REALMENTE ergue', () => {
    const prontas = EVENT_FAMILIES.filter((family) => family.ready).map((family) => family.kind);

    // Divergir para MENOS faz a tela avisar que nada nasce enquanto
    // nasce; para MAIS, faz o admin esperar um evento que nunca vem.
    expect([...prontas].sort()).toEqual([...runnableInTheAgent()].sort());
  });
});

describe('o catálogo', () => {
  it('cada família tem rota própria, e nenhuma repete', () => {
    const rotas = EVENT_FAMILIES.map((family) => family.href);

    expect(new Set(rotas).size).toBe(rotas.length);

    for (const family of EVENT_FAMILIES) {
      expect(family.href.startsWith('/eventos/')).toBe(true);
      expect(family.href.endsWith('/')).toBe(true);
    }
  });

  it('um kind desconhecido não some da tela: ele aparece cru', () => {
    // A coluna é texto livre, e um agente mais novo que o painel
    // devolve família que este build nunca viu. Sumir com a linha
    // esconderia justamente o evento que ninguém entendeu.
    expect(familyOf('supermassivo')).toBeNull();
    expect(familyLabel('supermassivo')).toBe('supermassivo');
  });
});
