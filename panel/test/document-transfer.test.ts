// ============================================================
//  O que sobrevive à colagem de um desenho vindo de outro agente.
//
//  ####  DUAS COISAS NAO ATRAVESSAM, E AS DUAS FALHARIAM CALADAS  ####
//
//  O `id` é o endereço que o plugin guarda: um documento que chega
//  trazendo o id de origem apontaria os botões para uma interface
//  que não existe do lado de cá.
//
//  Os atalhos ocupam uma palavra global no servidor. Colar os de
//  outra interface faria duas disputarem o mesmo `/quest`, e uma
//  delas ficaria inalcançável no jogo — sem erro em lugar nenhum.
// ============================================================

import { describe, expect, it } from 'vitest';

import { preparePastedDocument } from '@/components/ui-editor/document-transfer';
import type { UiDocument } from '@/lib/ui-doc/model';

/** O documento ABERTO no editor — o destino da colagem. */
const target: UiDocument = {
  id: 'ozads',
  name: 'Overlay de Propagandas',
  command: 'propagandas',
  permission: null,
  layer: 'Hud',
  cursor: false,
  shell: [],
  contentSlotId: null,
  modalSlotId: null,
  entryScreenId: 'inicio',
  fadeIn: 0,
  shortcuts: [{ command: 'ads', screenId: 'inicio' }],
  screens: [{ id: 'inicio', name: 'Início', kind: 'page', elements: [] }],
};

/** O texto que chega, copiado do outro agente. */
const incoming = JSON.stringify({
  id: 'ozads-do-dev',
  name: 'Overlay de Propagandas',
  command: 'propagandas',
  permission: null,
  layer: 'Hud',
  cursor: false,
  shell: [],
  contentSlotId: null,
  modalSlotId: null,
  entryScreenId: 'overlay',
  fadeIn: 0,
  shortcuts: [{ command: 'quest', screenId: 'overlay' }],
  screens: [{ id: 'overlay', name: 'Overlay', kind: 'page', elements: [] }],
});

describe('preparePastedDocument', () => {
  it('o desenho vem do texto, e a tela de entrada junto', () => {
    const result = preparePastedDocument(incoming, target);

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.document.entryScreenId).toBe('overlay');
    expect(result.document.screens.map((screen) => screen.name)).toEqual(['Overlay']);
  });

  it('o identificador continua sendo o do documento aberto', () => {
    const result = preparePastedDocument(incoming, target);

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    // Trazer o `ozads-do-dev` faria o agente recusar o PUT — e, se
    // não recusasse, apontaria para uma interface inexistente aqui.
    expect(result.document.id).toBe('ozads');
  });

  it('os atalhos são os do destino, e não os que vieram', () => {
    const result = preparePastedDocument(incoming, target);

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.document.shortcuts).toEqual([{ command: 'ads', screenId: 'inicio' }]);
  });

  it('texto vazio é recusado com a frase que ensina o que fazer', () => {
    const result = preparePastedDocument('   ', target);

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.message).toContain('Cole aqui');
  });

  it('metade do JSON colado não vira documento', () => {
    const result = preparePastedDocument(incoming.slice(0, 40), target);

    expect(result.ok).toBe(false);

    if (result.ok) return;

    // A frase diz o que conferir, porque colar cortado é o erro
    // mais comum de quem seleciona à mão.
    expect(result.message).toContain('do primeiro { ao último }');
  });

  it('um JSON sem telas é recusado ANTES de o editor tentar desenhar', () => {
    const result = preparePastedDocument(JSON.stringify({ id: 'x', screens: [] }), target);

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.message).toContain('não tem telas');
  });

  it('um array não é documento', () => {
    const result = preparePastedDocument('[]', target);

    expect(result.ok).toBe(false);
  });

  it('sem tela de entrada é recusado', () => {
    const result = preparePastedDocument(
      JSON.stringify({ screens: [{ id: 'a', name: 'A', kind: 'page', elements: [] }] }),
      target,
    );

    expect(result.ok).toBe(false);

    if (result.ok) return;

    expect(result.message).toContain('tela de entrada');
  });
});
