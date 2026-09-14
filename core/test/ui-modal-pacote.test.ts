// ============================================================
//  ui-modal-pacote.test.ts  -  o modal de kit, VIP e veículo,
//  medido.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  O modal do preset tinha 340 px de altura. O slot da lista ia de
//  172 a 304 contados do topo — 36 px de folga até o fundo. E o
//  "TOTAL", como todo o rodapé, é ancorado no FUNDO: 78 px acima
//  dele.
//
//  78 é maior que 36. A lista e o TOTAL ocupavam o mesmo lugar.
//
//  No jogo isso se via como duas frases escritas uma sobre a outra
//  — "RECICLADORA MAIS RÁPIDA" atravessada pela palavra TOTAL — e
//  só a partir da QUARTA linha da lista. Um kit de três itens
//  desenhava certo, e foi por isso que ninguém viu antes: o bug
//  dependia do conteúdo, e o conteúdo é do admin.
//
//  Nenhum teste pegava isso porque nenhum media o desenho contra
//  ele mesmo. O documento estava válido, o schema aceitava, o
//  preset cabia no RCON. O que estava errado era a RELAÇÃO entre
//  dois números que ninguém obrigava a concordar.
//
//  É essa relação que se mede aqui.
// ============================================================

import { describe, expect, it } from 'vitest';

import { CANVAS, resolveRect, type Box } from '../src/game/ui-geometry.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import { buildStoreScreen } from '../src/game/ui-store-screens.js';
import type { StoreCatalogEntry } from '../src/store/service.js';
import { LIST_LINE } from '../src/game/ui-widgets.js';
import { BUNDLE_TEMPLATE_ID, SLOTS } from '../src/game/ui-store-template.js';
import type { UiElement, UiScreen } from '../src/types/ui-document.js';

/**
 * A caixa de um elemento, medida na cadeia inteira.
 *
 * A âncora resolve dentro do PAI: medir o slot da lista sem passar
 * pelo véu e pela caixa do modal daria um número que não existe em
 * lugar nenhum.
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

function requireBox(screen: UiScreen, id: string): Box {
  const box = boxOf(screen.elements, id);

  if (box === null) {
    throw new Error(`o elemento "${id}" sumiu do modal de pacote`);
  }

  return box;
}

/** O fundo de uma caixa, contado do topo da tela. */
function bottomOf(box: Box): number {
  return box.top + box.height;
}

describe('o modal de kit, VIP e veículo', () => {
  const menu = buildMainMenu();
  const modal = menu.screens.find((screen) => screen.id === BUNDLE_TEMPLATE_ID);

  it('existe no preset', () => {
    expect(modal).toBeDefined();
  });

  if (modal === undefined) {
    return;
  }

  const list = requireBox(modal, SLOTS.pacoteLista);

  // ####  A MEDIDA QUE FALTAVA  ####
  //
  // Cada peça do rodapé é ancorada no fundo, e a lista no topo. A
  // única pergunta que importa é se elas se cruzam.
  for (const [name, id] of [
    ['o rótulo TOTAL', 'mb-rotulo-total'],
    ['o valor total', SLOTS.pacoteTotal],
    ['o saldo', SLOTS.pacoteSaldo],
    ['o botão de cancelar', SLOTS.pacoteCancelar],
    ['o botão de comprar', SLOTS.pacoteComprar],
  ] as const) {
    it(`não deixa a lista invadir ${name}`, () => {
      const footer = requireBox(modal, id);

      expect(bottomOf(list)).toBeLessThanOrEqual(footer.top);
    });
  }

  it('não deixa o cabeçalho invadir a lista', () => {
    // O ícone é a peça mais baixa do cabeçalho: 80 px a partir de
    // 60 do topo. O título da lista já esteve por cima dele.
    const icon = requireBox(modal, SLOTS.pacoteIcone);
    const title = requireBox(modal, SLOTS.pacoteTitulo);

    expect(bottomOf(icon)).toBeLessThanOrEqual(title.top);
    expect(bottomOf(title)).toBeLessThanOrEqual(list.top);
  });

  it('mantém a lista dentro da caixa', () => {
    const box = requireBox(modal, 'mb-caixa');

    // Medidas na mesma origem: o slot resolve DENTRO da caixa, então
    // o que se compara é a altura dele com a dela.
    const inner = boxOf(modal.elements, SLOTS.pacoteLista);

    expect(inner).not.toBeNull();
    expect(box.height).toBeGreaterThan(list.height);
  });

  // ####  CABER NÃO BASTA: PRECISA CABER GENTE  ####
  //
  // Um slot de 24 px não cruza com nada e não serve para nada. O VIP
  // mais vendido da rede tem cinco vantagens, e o modal precisa
  // mostrá-las SEM paginar — paginar cinco linhas é pedir um clique
  // para ler meia frase.
  it('comporta pelo menos seis linhas sem paginar', () => {
    expect(Math.floor(list.height / LIST_LINE)).toBeGreaterThanOrEqual(6);
  });

  it('é largo o bastante para uma vantagem de VIP', () => {
    // "FORNALHA DIVIDE OS ITENS AUTOMÁTICO." é a mais longa em uso, e
    // ela cabia por poucos pixels na largura antiga.
    expect(list.width).toBeGreaterThanOrEqual(400);
  });
});

// ============================================================
//  A LISTA PAGINA PELO SLOT QUE O ADMIN DESENHOU
//
//  ####  ELA PAGINAVA SEMPRE POR 132 PX  ####
//
//  No layout embutido, 132 é a área da lista e a conta fecha. No
//  modelo DESENHADO a área é do admin — ele pode ter dobrado o slot
//  no editor, ou reduzido pela metade.
//
//  Paginar por um número fixo dava os dois erros de uma vez:
//
//    - slot maior: cinco linhas e um "‹ 1 / 3 ›" com meia caixa
//      vazia embaixo. O jogador clica três vezes para ler o que
//      caberia de uma;
//    - slot menor: linhas mandadas pelo RCON que ninguém vê. Não
//      aparecem na tela e ocupam bytes do frame, cujo teto é
//      50 000 para a carga inteira.
// ============================================================

/** Um VIP com N vantagens, que é o que enche a lista. */
function vipWith(perks: number): readonly StoreCatalogEntry[] {
  return [
    {
      category: { id: 'cat', name: 'VIP' },
      offers: [
        {
          id: 'vip-bronze',
          categoryId: 'cat',
          kind: 'vip',
          items: [],
          perks: Array.from({ length: perks }, (_unused, index) => `VANTAGEM ${String(index)}`),
          vip: { tier: 'bronze', days: 30 },
          vehicle: null,
          icon: { shortname: 'wood', itemId: 1, skinId: '0', file: null },
          name: 'BRONZE',
          price: 1280,
          position: 0,
          enabled: true,
          badge: null,
          oldPrice: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    },
  ] as readonly StoreCatalogEntry[];
}

/** Um modelo de pacote com o slot da lista daquela altura. */
function templateWithList(height: number): UiScreen {
  return {
    id: BUNDLE_TEMPLATE_ID,
    name: 'modal',
    kind: 'modal',
    elements: [
      {
        id: SLOTS.pacoteLista,
        name: 'lista',
        type: 'panel',
        rect: {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 22, y: -(180 + height) },
          offsetMax: { x: -22, y: -180 },
        },
        color: '#00000000',
        sprite: null,
        imageType: 'Simple',
        material: null,
        children: [],
      },
    ],
  } as UiScreen;
}

function linesOf(screen: UiScreen): string[] {
  const all: UiElement[] = [];

  const visit = (list: readonly UiElement[]): void => {
    for (const element of list) {
      all.push(element);
      visit(element.children);
    }
  };

  visit(screen.elements);

  return all
    .filter((element) => element.type === 'label')
    .map((element) => (element.type === 'label' ? element.text : ''))
    .filter((text) => text.includes('VANTAGEM'));
}

describe('a lista do modal desenhado', () => {
  const VIEWPORT = { width: 1220, height: 584 };

  it('usa a altura do slot, e não uma régua fixa', () => {
    // Dez vantagens num slot de 264 px: 264 / 24 = 11 linhas. Cabem
    // todas, e não deve haver pager nenhum.
    const screen = buildStoreScreen({
      catalog: vipWith(10),
      target: { kind: 'item', offerId: 'vip-bronze', quantity: 1, tab: 'geral' },
      bundleTemplate: templateWithList(264),
      viewport: VIEWPORT,
    });

    // Pela régua antiga (132 px) seriam cinco linhas e um "1 / 2".
    expect(linesOf(screen)).toHaveLength(10);
    expect(JSON.stringify(screen)).not.toContain('1 / 2');
  });

  it('e pagina de verdade quando o slot é pequeno', () => {
    const screen = buildStoreScreen({
      catalog: vipWith(10),
      target: { kind: 'item', offerId: 'vip-bronze', quantity: 1, tab: 'geral' },
      bundleTemplate: templateWithList(72),
      viewport: VIEWPORT,
    });

    // 72 px dão três linhas; com o pager ocupando a última, duas.
    // O que não cabe é alcançável pela seta, nunca cortado.
    expect(linesOf(screen).length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(screen)).toContain('1 / 5');
  });

  it('sem viewport, vale a régua embutida', () => {
    // É o caso de quem chama isto de um teste, e o que manteve
    // funcionando todo documento gravado antes disto.
    const screen = buildStoreScreen({
      catalog: vipWith(10),
      target: { kind: 'item', offerId: 'vip-bronze', quantity: 1, tab: 'geral' },
      bundleTemplate: templateWithList(264),
    });

    expect(linesOf(screen).length).toBeLessThan(10);
  });
});
