// ============================================================
//  ui-menu-shell.test.ts  -  o cabeçalho do menu, medido.
//
//  ####  POR QUE ISTO PRECISA DE TESTE  ####
//
//  O cabeçalho é a única parte do menu que NÃO é redesenhada ao
//  navegar: ele é montado uma vez e fica. Um erro de geometria
//  aqui não derruba nada e não aparece em log nenhum — ele aparece
//  no jogo, como uma aba por baixo do saldo ou como a última aba
//  cortada pela borda.
//
//  São quatro coisas, e as quatro vieram do redesign de
//  14/09/2026, quando o cabeçalho virou duas faixas:
//
//    1. as abas cabem na moldura, todas;
//    2. a marca não encosta no que é do jogador;
//    3. a soma das faixas é a altura declarada — dela sai onde o
//       conteúdo começa, e daí quantas linhas cabem nas páginas do
//       ranking e das regras;
//    4. o botão de uma aba cabe na faixa dela.
// ============================================================

import { describe, expect, it } from 'vitest';

import { CANVAS, resolveRect, type Box } from '../src/game/ui-geometry.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import type { UiElement } from '../src/types/ui-document.js';

/**
 * A caixa de um elemento do shell, medida na cadeia inteira.
 *
 * A âncora resolve dentro do PAI, e não da tela: medir um botão de
 * aba sem passar pela moldura e pela barra daria um número que não
 * existe em lugar nenhum.
 */
function boxOf(elements: readonly UiElement[], id: string, parent = CANVAS): Box | null {
  for (const element of elements) {
    const box = resolveRect(element.rect, parent);

    if (element.id === id) {
      return box;
    }

    const inside = boxOf(element.children, id, { width: box.width, height: box.height });

    if (inside !== null) {
      return inside;
    }
  }

  return null;
}

function requireBox(elements: readonly UiElement[], id: string): Box {
  const box = boxOf(elements, id);

  if (box === null) {
    throw new Error(`o elemento "${id}" sumiu do shell`);
  }

  return box;
}

/** Todos os elementos, achatados. */
function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

describe('o cabeçalho do Menu Principal', () => {
  const shell = buildMainMenu().shell;

  it('todas as abas cabem dentro da barra, sem encostar na borda', () => {
    const barra = requireBox(shell, 'nav-barra');
    const abas = walk(shell).filter((element) => element.id.startsWith('nav-') && element.id !== 'nav-barra');

    expect(abas.length).toBeGreaterThan(8);

    for (const aba of abas) {
      const box = requireBox(shell, aba.id);

      expect(box.left).toBeGreaterThanOrEqual(0);
      // A última aba é a que corre risco: cada rótulo empurra a
      // seguinte, e uma aba renomeada no editor empurra todas.
      expect(box.left + box.width).toBeLessThan(barra.width - 8);
    }
  });

  it('cada aba tem largura suficiente para o rótulo dela', () => {
    for (const aba of walk(shell).filter((element) => element.type === 'button' && element.id.startsWith('nav-'))) {
      const box = requireBox(shell, aba.id);
      const text = aba.type === 'button' ? aba.text : '';

      // A régua estimada é 0,55 do corpo por caractere; o teste usa
      // a mesma conta com folga, porque o que importa aqui é não
      // CORTAR letra.
      expect(box.width).toBeGreaterThan(text.length * 12 * 0.55);
    }
  });

  it('a marca não invade o que é do jogador', () => {
    const nome = requireBox(shell, 'marca-nome');
    const vip = requireBox(shell, 'vip-word');
    const logo = requireBox(shell, 'marca-logo');

    expect(logo.left + logo.width).toBeLessThanOrEqual(nome.left);
    // O nome tem largura de sobra reservada — o que não pode é a
    // faixa dele COMEÇAR depois do VIP.
    expect(nome.left).toBeLessThan(vip.left);
  });

  it('as duas faixas somam a altura do cabeçalho', () => {
    // ####  ISTO NÃO É ESTÉTICA  ####
    //
    // A altura do cabeçalho decide onde o slot de conteúdo começa,
    // e o slot decide quantas linhas cabem numa página do ranking e
    // das regras. Uma faixa 2 px mais alta repagina cinco telas.
    const cabecalho = requireBox(shell, 'cabecalho');
    const marca = requireBox(shell, 'marca');
    const barra = requireBox(shell, 'nav-barra');

    expect(marca.height + barra.height).toBe(cabecalho.height);
    expect(cabecalho.height).toBe(76);
  });

  it('o botão de aba cabe na faixa de navegação', () => {
    const barra = requireBox(shell, 'nav-barra');
    const home = requireBox(shell, 'nav-home');

    expect(home.height).toBeLessThanOrEqual(barra.height);
    expect(home.top).toBeGreaterThanOrEqual(0);
  });

  it('o slot de conteúdo continua abaixo do cabeçalho e do acento', () => {
    const conteudo = requireBox(shell, 'conteudo');
    const cabecalho = requireBox(shell, 'cabecalho');
    const acento = requireBox(shell, 'cabecalho-acento');

    expect(conteudo.top).toBeGreaterThanOrEqual(cabecalho.height + acento.height);
  });
});
