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

import { shellNavStates } from '../src/game/ui-cui.js';
import { CANVAS, resolveRect, type Box } from '../src/game/ui-geometry.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import type { UiElement } from '../src/types/ui-document.js';
import {
  toGeneratedScreenBundle,
  toScreenBundle,
} from '../src/types/ui-transport.js';

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
    const vip = requireBox(shell, 'vip-word');
    const logo = requireBox(shell, 'marca-logo');

    expect(logo.left).toBeGreaterThan(0);
    expect(logo.left + logo.width).toBeLessThan(vip.left);
  });

  it('o logo é desenhado na proporção da arte, e não num quadrado', () => {
    // A arte da rede tem 4048x1735. Num quadrado ela chegaria
    // achatada ao jogo — e achatamento de logo é a primeira coisa
    // que quem fez a marca enxerga.
    const logo = requireBox(shell, 'marca-logo');

    expect(logo.width / logo.height).toBeGreaterThan(2);
    expect(logo.width / logo.height).toBeLessThan(3);
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

// ============================================================
//  O "VOCÊ ESTÁ AQUI" DA BARRA
//
//  ####  POR QUE ISTO GANHOU TESTE EM 15/09/2026  ####
//
//  Até aqui, o destaque viajava como dois elementos CUI completos
//  por botão de navegação, repetidos em CADA tela servida: 4.795
//  bytes para dizer qual botão está aceso. A conta só ficou
//  visível quando a aba EQUIPE não coube no frame do RCON.
//
//  Agora o agente manda uma tabela (uma vez, no documento) e o
//  endereço da tela atual; quem pinta é o plugin, com o shell que
//  ele já desenhou.
//
//  O risco da troca é silencioso e total: se a tabela sair errada,
//  NENHUMA aba acende — e isso não derruba nada, não aparece em
//  log, e só se vê abrindo o jogo.
// ============================================================

describe('a tabela de destaque da barra', () => {
  const menu = buildMainMenu();

  it('tem uma linha para cada botão que acende', () => {
    const acendem = walk(menu.shell).filter(
      (element) => element.type === 'button' && element.activeOnScreenId !== null,
    );

    expect(shellNavStates(menu)).toHaveLength(acendem.length);
    // E são as onze abas da barra, não um punhado delas.
    expect(shellNavStates(menu).length).toBeGreaterThanOrEqual(10);
  });

  it('cada linha aponta para uma tela que EXISTE no documento', () => {
    // Um `on` que não casa com tela nenhuma é uma aba que nunca
    // acende — e o sintoma é invisível.
    const telas = new Set(menu.screens.map((screen) => screen.id));

    for (const state of shellNavStates(menu)) {
      expect(telas.has(state.on)).toBe(true);
    }
  });

  it('as cores saem no formato do CUI, e não em hex', () => {
    // O cliente lê "r g b a" em 0..1. Um `#C43F2CFF` aqui seria um
    // botão que nunca muda de cor, sem erro nenhum.
    for (const state of shellNavStates(menu)) {
      expect(state.color).toMatch(/^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/);
      expect(state.textColor).toMatch(/^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/);
    }
  });

  it('a tela leva o endereço que o SHELL conhece, e não o id cru', () => {
    // A tela de entrada acende a aba dela.
    const entrada = toScreenBundle(menu, menu.entryScreenId);

    expect(entrada?.activeId).toBe(menu.entryScreenId);

    // E uma tela GERADA com parâmetro acende a aba-base: sem isto,
    // o destaque de EQUIPE sumiria ao abrir a confirmação de
    // expulsar, que é `tela-equipe:kick:765…`.
    const gerada = toGeneratedScreenBundle(
      menu,
      { id: 'tela-equipe:kick:76561198000000001', name: 'x', kind: 'page', elements: [] },
      'tela-equipe',
    );

    expect(gerada.activeId).toBe('tela-equipe');
    expect(gerada.id).toBe('tela-equipe:kick:76561198000000001');
  });

  it('o bloco CARO não viaja mais em tela nenhuma', () => {
    // É esta linha que guarda os 4.795 bytes. Se `updates` voltar a
    // ter conteúdo, os dois mecanismos estarão ligados ao mesmo
    // tempo — e o frame volta a encher.
    expect(toScreenBundle(menu, menu.entryScreenId)?.updates).toEqual([]);

    for (const screen of menu.screens) {
      expect(toScreenBundle(menu, screen.id)?.updates).toEqual([]);
    }
  });
});
