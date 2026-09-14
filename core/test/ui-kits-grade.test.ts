// ============================================================
//  ui-kits-grade.test.ts  -  a lista de kits, e como se escolhe a
//  categoria nela.
//
//  ####  O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  As categorias eram uma FILEIRA horizontal de abas sob o título,
//  cada uma com a largura do próprio nome, empilhadas para a
//  direita a partir do zero.
//
//  Uma fileira não cresce. Com três categorias cabia; com sete, a
//  última era desenhada além da borda da tela — e desenhada em
//  silêncio: sem seta, sem reticências, sem nada dizendo que
//  existia mais. O jogador não tinha como saber que havia uma
//  categoria que ele nunca veria.
//
//  A coluna cresce para BAIXO, que é a direção em que há espaço, e
//  o que não couber nela é CONTADO. É isso que se mede aqui.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { KitOfferView } from '../src/kits/service.js';
import { CANVAS, resolveRect, type Box } from '../src/game/ui-geometry.js';
import { buildKitsScreen } from '../src/game/ui-kits-screen.js';
import type { UiElement } from '../src/types/ui-document.js';

function offer(over: Partial<KitOfferView> = {}): KitOfferView {
  return {
    id: 1,
    slug: 'kit-inicial',
    name: 'Kit Inicial',
    description: null,
    kind: 'resgate',
    useLimit: null,
    useResetOn: 'never',
    cooldownSeconds: null,
    requiredTier: null,
    requiredTierExact: false,
    items: [{ slot: 'belt', shortname: 'rifle.ak', amount: 1, skinId: '0', position: 0 }],
    enabled: true,
    servers: ['pvp1'],
    claimCount: 0,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    category: null,
    available: true,
    reason: null,
    nextAt: null,
    lastClaimedAt: null,
    myClaims: 0,
    usesLeft: 1,
    ...over,
  } as KitOfferView;
}

/** Um kit por categoria, com nomes previsíveis. */
function categorized(count: number): KitOfferView[] {
  return Array.from({ length: count }, (_unused, index) =>
    offer({
      id: index,
      slug: `kit-${String(index)}`,
      name: `Kit ${String(index)}`,
      category: `Categoria ${String(index)}`,
    }),
  );
}

function grid(offers: readonly KitOfferView[], category: string | null = null): UiElement[] {
  return buildKitsScreen({ offers, target: { kind: 'grid', category, page: 0 } }).elements;
}

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function idsOf(elements: readonly UiElement[]): string[] {
  return walk(elements).map((element) => element.id);
}

/**
 * A caixa de um elemento, medida na cadeia inteira.
 *
 * O pai é o SLOT de conteúdo do shell, e não a tela: uma página do
 * menu é desenhada dentro da moldura, sob o cabeçalho.
 */
const CONTENT = { width: CANVAS.width - 60, height: CANVAS.height - 76 - 60 };

function boxOf(elements: readonly UiElement[], id: string, parent = CONTENT): Box | null {
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

describe('a lista de kits', () => {
  it('sem categoria nenhuma, não desenha coluna', () => {
    // Uma coluna vazia à esquerda de uma grade é ruído com aparência
    // de defeito — a mesma regra do ranking.
    expect(idsOf(grid([offer()]))).not.toContain('kits-col');
  });

  it('com uma categoria só, também não: ela seria um clique para lugar nenhum', () => {
    const offers = [
      offer({ slug: 'a', category: 'VIP' }),
      offer({ id: 2, slug: 'b', category: 'VIP' }),
    ];

    expect(idsOf(grid(offers))).not.toContain('kits-col');
  });

  it('com duas ou mais, a coluna aparece e a grade abre espaço para ela', () => {
    const elements = grid(categorized(3));

    const column = boxOf(elements, 'kits-col');
    const cards = boxOf(elements, 'kits-grade');

    expect(column).not.toBeNull();
    expect(cards).not.toBeNull();

    // ####  A GRADE COMEÇA DEPOIS DA COLUNA  ####
    //
    // Sobrepostas, os cards da primeira coluna ficariam por cima dos
    // nomes das categorias — e os dois continuariam clicáveis, o que
    // é pior que feio.
    if (column !== null && cards !== null) {
      expect(cards.left).toBeGreaterThanOrEqual(column.left + column.width);
    }
  });

  it('a categoria aberta não é um botão', () => {
    // Clicar no que já está aberto navegaria para onde já se está.
    const elements = grid(categorized(3), 'categoria-0');
    const items = walk(elements);

    const active = items.find((element) => element.id === 'kcatcategoria-0');
    const other = items.find((element) => element.id === 'kcatcategoria-1');

    expect(active?.type).toBe('panel');
    expect(other?.type).toBe('button');
  });

  // ####  A MEDIDA QUE A FILEIRA NÃO TINHA  ####

  it('mantém todas as categorias dentro da tela', () => {
    const elements = grid(categorized(12));

    for (const element of walk(elements)) {
      if (!element.id.startsWith('kcat')) {
        continue;
      }

      const box = boxOf(elements, element.id);

      expect(box).not.toBeNull();

      if (box !== null) {
        // Na fileira antiga, a sétima categoria já saía pela direita.
        expect(box.left + box.width).toBeLessThanOrEqual(CONTENT.width);
        expect(box.top + box.height).toBeLessThanOrEqual(CONTENT.height);
      }
    }
  });

  it('conta as categorias que não couberem, em vez de escondê-las', () => {
    // Absurdamente muitas, de propósito: o que importa é que o
    // excedente seja DITO, e não que este número aconteça.
    const elements = grid(categorized(40));
    const texts = walk(elements)
      .filter((element) => element.type === 'label')
      .map((element) => element.text);

    expect(texts.some((text) => text.startsWith('e mais '))).toBe(true);
  });

  it('a categoria navega, e não abre modal', () => {
    // `modal.open` abriria a tela de kits POR CIMA da tela de kits,
    // empilhando um modal a cada troca de categoria.
    const buttons = walk(grid(categorized(3))).filter(
      (element) => element.type === 'button' && element.id.startsWith('kcat'),
    );

    expect(buttons.length).toBeGreaterThan(0);

    for (const element of buttons) {
      expect(element.type === 'button' && element.action?.kind).toBe('navigate');
    }
  });
});
