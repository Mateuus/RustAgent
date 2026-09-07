// ============================================================
//  O quadro que chega SEM o campo `destroy`.
//
//  ####  ISTO DERRUBOU A PAGINA INTEIRA  ####
//
//  Em 07/09/2026, clicar em qualquer cena da previa — "Ciclo
//  completo", "Abertura", "Troca", "Fechamento" — trocava a tela
//  por "This page couldn't load".
//
//  A causa: o agente OMITE `destroy` quando nao ha nada a
//  destruir (sao bytes que nao precisam atravessar o RCON, e o
//  plugin ja trata isso com `destroy != null`). O painel antigo
//  normalizava o campo num `parse.ts`; este painel foi portado
//  sem parsers, confiando nos tipos — e um tipo nao valida nada
//  em tempo de execucao.
//
//  `for (const x of undefined)` lanca TypeError DENTRO do render,
//  e o React derruba a arvore toda. O erro real ficava so no
//  console do navegador; a tela nao dizia nada.
//
//  ####  POR QUE UM TESTE, E NAO SO O `?? []`  ####
//
//  Porque a correcao e invisivel: nenhum tipo, nenhuma chamada de
//  API e nenhuma rota mudam de forma. O que a guarda e a FORMA de
//  um quadro, e este e o unico lugar barato de dize-la.
// ============================================================

import { describe, expect, it } from 'vitest';

import { applyFrame } from '../src/components/ads-preview';

/** Um contador de ordem novo, como o componente monta o dele. */
function counter() {
  return { value: 0 };
}

const RECT = {
  type: 'RectTransform',
  anchormin: '0.5 1',
  anchormax: '0.5 1',
  offsetmin: '-45 -114',
  offsetmax: '45 -24',
};

describe('um quadro sem `destroy`', () => {
  it('e aceito, e nao lanca', () => {
    // Exatamente a forma que o agente produz na abertura: so `at`
    // e `cui`. Antes do conserto, esta chamada lancava TypeError.
    const quadro = {
      at: 0,
      cui: [{ name: 'OrigemZAds.panel', parent: 'OrigemZAds', components: [RECT] }],
    };

    expect(() => applyFrame(new Map(), quadro, counter())).not.toThrow();
  });

  it('desenha o elemento assim mesmo', () => {
    const estado = applyFrame(
      new Map(),
      { at: 0, cui: [{ name: 'OrigemZAds.panel', parent: 'OrigemZAds', components: [RECT] }] },
      counter(),
    );

    expect(estado.get('OrigemZAds.panel')?.parent).toBe('OrigemZAds');
  });
});

describe('um quadro sem `cui`', () => {
  it('tambem e aceito — so destroi', () => {
    const antes = applyFrame(
      new Map(),
      { at: 0, cui: [{ name: 'OrigemZAds.panel', parent: 'OrigemZAds', components: [RECT] }] },
      counter(),
    );

    const depois = applyFrame(antes, { at: 600, destroy: ['OrigemZAds.panel'] }, counter());

    expect(depois.has('OrigemZAds.panel')).toBe(false);
  });
});

describe('`destroy` leva os filhos junto', () => {
  it('e o que o CUI faz', () => {
    const c = counter();

    let estado = applyFrame(
      new Map(),
      { at: 0, cui: [{ name: 'OrigemZAds.panel', parent: 'OrigemZAds', components: [RECT] }] },
      c,
    );
    estado = applyFrame(
      estado,
      { at: 1, cui: [{ name: 'OrigemZAds.panel.slot', parent: 'OrigemZAds.panel', components: [RECT] }] },
      c,
    );

    expect(estado.size).toBe(2);

    // Destruir o pai leva `OrigemZAds.panel.slot` junto: e por isso
    // que a comparacao e por prefixo com ponto, e nao por igualdade.
    const limpo = applyFrame(estado, { at: 2, destroy: ['OrigemZAds.panel'] }, c);

    expect(limpo.size).toBe(0);
  });
});
