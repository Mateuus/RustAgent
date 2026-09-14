// ============================================================
//  Testes do filtro e da paginação da lista de kits.
//
//  ####  O QUE ELES PROTEGEM  ####
//
//  A tela lista a rede inteira numa tabela. Isso funciona com oito
//  kits e deixa de funcionar sem aviso: não há erro, não há corte —
//  a página só fica comprida, e achar um kit vira rolar até vê-lo.
//
//  Filtrar e paginar resolvem isso e trazem um risco próprio, que é
//  o que se mede aqui: **sumir com um kit sem dizer que sumiu**.
//  Uma busca que não bate com nada, uma página que deixou de
//  existir, um filtro de categoria que esconde o que se procura —
//  os três produzem a mesma tela vazia, e ela não pode parecer "não
//  há kits".
// ============================================================

import { describe, expect, it } from 'vitest';

import { categoriesOf, pageOf } from '../src/app/kits/page';
import type { Kit } from '../src/lib/api';

function kit(over: Partial<Kit> = {}): Kit {
  return {
    id: 1,
    slug: 'kit-inicial',
    name: 'Kit Inicial',
    description: null,
    category: null,
    kind: 'resgate',
    cooldownSeconds: null,
    useLimit: null,
    useResetOn: 'never',
    wipeDelaySeconds: null,
    requiredTier: null,
    requiredTierExact: false,
    items: [],
    enabled: true,
    servers: [],
    claimCount: 0,
    iconFile: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...over,
  } as Kit;
}

/** N kits com nome e slug previsíveis. */
function many(count: number, over: (index: number) => Partial<Kit> = () => ({})): Kit[] {
  return Array.from({ length: count }, (_unused, index) =>
    kit({
      id: index,
      slug: `kit-${String(index)}`,
      name: `Kit ${String(index)}`,
      ...over(index),
    }),
  );
}

describe('as categorias do filtro', () => {
  it('junta os sem categoria num grupo com nome', () => {
    const lista = [kit({ category: 'VIP' }), kit({ id: 2, category: null })];

    expect(categoriesOf(lista)).toContain('VIP');
    // Um grupo sem rótulo seria uma linha em branco no seletor.
    expect(categoriesOf(lista)).toContain('(sem categoria)');
  });

  it('não repete a mesma categoria', () => {
    const lista = [kit({ category: 'VIP' }), kit({ id: 2, category: 'VIP' })];

    expect(categoriesOf(lista)).toEqual(['VIP']);
  });
});

describe('a paginação', () => {
  it('não aparece quando tudo cabe', () => {
    expect(pageOf(many(20), '', '', 0).pages).toBe(1);
  });

  it('parte em duas no vigésimo primeiro', () => {
    const resultado = pageOf(many(21), '', '', 0);

    expect(resultado.pages).toBe(2);
    expect(resultado.shown).toHaveLength(20);
    expect(resultado.inicio).toBe(1);
    expect(resultado.fim).toBe(20);
  });

  it('a segunda página traz o resto, e não o começo de novo', () => {
    const resultado = pageOf(many(21), '', '', 1);

    expect(resultado.shown).toHaveLength(1);
    expect(resultado.shown[0]?.name).toBe('Kit 20');
    expect(resultado.inicio).toBe(21);
    expect(resultado.fim).toBe(21);
  });

  // ####  O RISCO PRÓPRIO DA PAGINAÇÃO  ####

  it('apara a página que deixou de existir, em vez de mostrar vazio', () => {
    // Alguém apagou kits com a página 3 aberta. Uma tela vazia
    // pareceria a lista ter sumido.
    const resultado = pageOf(many(5), '', '', 9);

    expect(resultado.current).toBe(0);
    expect(resultado.shown).toHaveLength(5);
  });

  it('página negativa também não quebra', () => {
    expect(pageOf(many(5), '', '', -3).current).toBe(0);
  });

  it('lista vazia não vira página zero de zero', () => {
    const resultado = pageOf([], '', '', 0);

    expect(resultado.pages).toBe(1);
    expect(resultado.inicio).toBe(0);
    expect(resultado.fim).toBe(0);
  });
});

describe('a busca', () => {
  const lista = [
    kit({ id: 1, slug: 'kit-inicial', name: 'Kit Inicial', category: 'Gratuitos' }),
    kit({ id: 2, slug: 'kit-bronze', name: 'Bronze', category: 'VIP' }),
    kit({ id: 3, slug: 'kit-ouro', name: 'Ouro', category: 'VIP' }),
  ];

  it('acha pelo nome', () => {
    expect(pageOf(lista, 'bronze', '', 0).filtered.map((k) => k.id)).toEqual([2]);
  });

  it('acha pelo SLUG, que é o que aparece no log e no suporte', () => {
    // Quem chega com "kit-ouro" na mão precisa achá-lo por ele.
    expect(pageOf(lista, 'kit-ouro', '', 0).filtered.map((k) => k.id)).toEqual([3]);
  });

  it('acha pela categoria', () => {
    expect(pageOf(lista, 'vip', '', 0).filtered.map((k) => k.id)).toEqual([2, 3]);
  });

  it('não distingue maiúscula de minúscula', () => {
    expect(pageOf(lista, 'BRONZE', '', 0).filtered).toHaveLength(1);
  });

  it('espaço em branco não filtra nada', () => {
    expect(pageOf(lista, '   ', '', 0).filtered).toHaveLength(3);
  });

  it('busca sem resultado devolve lista vazia — e a tela DIZ isso', () => {
    // A distinção que importa: aqui `filtered` é vazio mas `kits`
    // não. A tela usa exatamente essa diferença para não oferecer
    // "criar o primeiro kit" quando já existem três.
    const resultado = pageOf(lista, 'não existe', '', 0);

    expect(resultado.filtered).toHaveLength(0);
    expect(lista.length).toBeGreaterThan(0);
  });
});

describe('o filtro de categoria', () => {
  const lista = [
    kit({ id: 1, category: 'VIP' }),
    kit({ id: 2, category: null }),
    kit({ id: 3, category: 'VIP' }),
  ];

  it('vazio quer dizer todas', () => {
    expect(pageOf(lista, '', '', 0).filtered).toHaveLength(3);
  });

  it('escolhida, mostra só a dela', () => {
    expect(pageOf(lista, '', 'VIP', 0).filtered.map((k) => k.id)).toEqual([1, 3]);
  });

  it('o grupo "sem categoria" pega os que não têm', () => {
    expect(pageOf(lista, '', '(sem categoria)', 0).filtered.map((k) => k.id)).toEqual([2]);
  });

  it('combina com a busca, em vez de uma anular a outra', () => {
    const misto = [
      kit({ id: 1, name: 'Bronze', category: 'VIP' }),
      kit({ id: 2, name: 'Bronze', category: 'Eventos' }),
    ];

    expect(pageOf(misto, 'bronze', 'VIP', 0).filtered.map((k) => k.id)).toEqual([1]);
  });
});
