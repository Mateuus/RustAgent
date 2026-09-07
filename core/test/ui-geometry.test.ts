// ============================================================
//  ui-geometry.test.ts  -  a conta que erra em silêncio.
//
//  ####  POR QUE ELA MERECE TESTE PRÓPRIO  ####
//
//  Um engano aqui não quebra nada visível: o número sai, a tela
//  monta, e a lista aparece com quatro linhas onde cabiam dez — ou
//  com dez onde cabiam quatro, e as seis últimas atravessam o RCON
//  para ficar fora da tela do jogador.
//
//  O erro clássico é o EIXO Y. No Unity ele cresce para cima; em
//  CSS, para baixo. Quem escreve `top: yMin` acerta todo layout
//  simétrico e erra todos os outros — e menu costuma ser simétrico,
//  então o defeito só aparece quando alguém ancora algo embaixo,
//  com uma tela inteira já desenhada em cima do engano.
//
//  O que este arquivo guarda:
//
//    1. a caixa sai em pixels, com o Y já invertido;
//    2. um elemento aninhado ancora dentro do PAI, e não da tela;
//    3. o slot de conteúdo do Menu Principal é MENOR que o canvas —
//       que é a razão de a medida existir;
//    4. caixa cruzada dá tamanho negativo, e não um número
//       consertado por baixo do pano.
// ============================================================

import { describe, expect, it } from 'vitest';

import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import { CANVAS, measureElement, resolveRect, screenViewport } from '../src/game/ui-geometry.js';
import type { UiElement } from '../src/types/ui-document.js';

const V = (x: number, y: number) => ({ x, y });

/** Um painel qualquer, para a conta ter em que morder. */
function panelOf(
  id: string,
  rect: UiElement['rect'],
  children: readonly UiElement[] = [],
): UiElement {
  return {
    id,
    name: id,
    type: 'panel',
    color: '#00000000',
    sprite: null,
    imageType: 'Simple',
    material: null,
    rect,
    children,
  };
}

/** Ancorado no topo à esquerda, com tamanho fixo em pixels. */
function topLeft(left: number, top: number, width: number, height: number): UiElement['rect'] {
  return {
    anchorMin: V(0, 1),
    anchorMax: V(0, 1),
    offsetMin: V(left, -(top + height)),
    offsetMax: V(left + width, -top),
  };
}

describe('âncora + offset -> pixels', () => {
  it('resolve a caixa com o Y já virado para baixo', () => {
    const box = resolveRect(topLeft(20, 30, 200, 100), CANVAS);

    expect(box).toEqual({ left: 20, top: 30, width: 200, height: 100 });
  });

  it('a âncora esticada acompanha o tamanho do pai', () => {
    // 0..1 nos dois eixos com offset zero = o pai inteiro.
    const stretched = {
      anchorMin: V(0, 0),
      anchorMax: V(1, 1),
      offsetMin: V(0, 0),
      offsetMax: V(0, 0),
    };

    expect(resolveRect(stretched, { width: 400, height: 300 })).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    });
  });

  it('o offset desloca a partir da âncora resolvida, não do pai', () => {
    // Ancorado no canto INFERIOR direito: a conta tem de somar a
    // largura e a altura do pai antes de aplicar o offset.
    const corner = {
      anchorMin: V(1, 0),
      anchorMax: V(1, 0),
      offsetMin: V(-100, 0),
      offsetMax: V(0, 40),
    };

    expect(resolveRect(corner, { width: 500, height: 300 })).toEqual({
      left: 400,
      top: 260,
      width: 100,
      height: 40,
    });
  });

  // ####  UM ESTADO LEGÍTIMO DO MODELO  ####
  //
  // Arrastar uma borda além da oposta produz isto, e consertá-lo
  // aqui faria o editor e o jogo discordarem. Quem pagina numa
  // caixa negativa recebe zero linha, que é a leitura certa.
  it('não conserta a caixa cruzada', () => {
    const crossed = {
      anchorMin: V(0, 0),
      anchorMax: V(0, 0),
      offsetMin: V(80, 0),
      offsetMax: V(20, 30),
    };

    expect(resolveRect(crossed, CANVAS).width).toBe(-60);
  });
});

describe('medir um elemento na árvore', () => {
  it('mede o aninhado DENTRO do pai, e não da tela', () => {
    const tree = [
      panelOf('caixa', topLeft(0, 0, 400, 200), [
        // Metade da largura do PAI: 200, e não 640.
        panelOf('dentro', {
          anchorMin: V(0, 0),
          anchorMax: V(0.5, 1),
          offsetMin: V(0, 0),
          offsetMax: V(0, 0),
        }),
      ]),
    ];

    const box = measureElement(tree, (id) => id === 'dentro', CANVAS);

    expect(box?.width).toBe(200);
    expect(box?.height).toBe(200);
  });

  it('devolve null para quem não está lá', () => {
    expect(measureElement([panelOf('a', topLeft(0, 0, 10, 10))], (id) => id === 'b', CANVAS)).toBe(
      null,
    );
  });

  it('casa por sufixo, que é a convenção dos slots', () => {
    const tree = [panelOf('rk-lista', topLeft(10, 10, 300, 120))];

    expect(measureElement(tree, (id) => id.endsWith('lista'), CANVAS)?.width).toBe(300);
  });
});

describe('onde uma tela é desenhada', () => {
  // ####  ESTA É A MEDIDA QUE JUSTIFICA O ARQUIVO  ####
  //
  // Com shell, a tela não ocupa 1280x720: ela entra no slot de
  // conteúdo, que o cabeçalho e a moldura já reduziram. Paginar
  // contra o canvas mandaria pelo RCON linhas que ninguém veria.
  it('o slot de conteúdo do Menu Principal é menor que a tela do jogo', () => {
    const document = buildMainMenu();
    const entry = document.screens.find((screen) => screen.id === document.entryScreenId);

    if (entry === undefined) {
      throw new Error('o preset precisa ter a tela de entrada');
    }

    const viewport = screenViewport(document, entry);

    expect(viewport.width).toBeGreaterThan(0);
    expect(viewport.height).toBeGreaterThan(0);
    expect(viewport.width).toBeLessThan(CANVAS.width);
    expect(viewport.height).toBeLessThan(CANVAS.height);
  });

  it('sem shell, a tela inteira é o contêiner', () => {
    const document = buildMainMenu();
    const entry = document.screens[0];

    if (entry === undefined) {
      throw new Error('o preset precisa ter ao menos uma tela');
    }

    expect(screenViewport({ ...document, shell: [] }, entry)).toEqual(CANVAS);
  });
});
