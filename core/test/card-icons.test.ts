// ============================================================
//  Testes da ARTE PRÓPRIA dos cards: oferta da loja e kit.
//
//  O que estes testes protegem, e não é óbvio:
//
//    - O ÍCONE DO JOGO CONTINUA SENDO O PADRÃO. Ele não custa
//      download ao jogador, e toda oferta gravada antes disto vem
//      sem arte: o card dela não pode mudar;
//    - OMITIDO NÃO É `null`. O site aplica a loja pelo mesmo schema e
//      não conhece o campo — tratá-los igual faria uma sincronização
//      do site apagar a arte escolhida no painel;
//    - O CARD PRECISA DE UM DESENHO. Sem ícone e sem arte, ele sai
//      como um quadrado vazio na tela do jogador;
//    - A OFERTA DESLIGADA NÃO GASTA O DUTO. A arte dela não aparece
//      para ninguém.
// ============================================================

import { describe, expect, it, vi } from 'vitest';

import type { StoreOffer } from '../src/db/store-repository.js';
import { kitIconKey, loadKitIcons, loadStoreIcons } from '../src/game/card-icons.js';
import { buildStoreScreen } from '../src/game/ui-store-screens.js';
import { kitBody, toKitInput } from '../src/http/routes/kits.js';
import { storeOfferBody, toOfferInput } from '../src/http/routes/store.js';
import type { Logger } from '../src/logger.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function offer(overrides: Partial<StoreOffer> = {}): StoreOffer {
  return {
    id: 'vip-ouro',
    categoryId: 'vips',
    kind: 'vip',
    name: 'VIP Ouro 30 dias',
    price: 5000,
    oldPrice: null,
    position: 0,
    enabled: true,
    badge: null,
    icon: { shortname: 'box.wooden.large', itemId: 833533164, skinId: '0', file: null },
    items: [],
    perks: [],
    vip: { tier: 'gold', days: 30 },
    vehicle: null,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  } as StoreOffer;
}

function quietLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/** O `source` da imagem do card daquela oferta. */
function cardImageSource(one: StoreOffer): unknown {
  const screen = buildStoreScreen({
    catalog: [{ category: { id: 'vips', name: 'VIPS' }, offers: [one] }],
    target: { kind: 'catalog', categoryId: 'vips', page: 1 },
  });

  // O card guarda a imagem num elemento `i<id>` — procurar pelo id
  // evita depender da forma da árvore, que muda com o layout.
  return findElement(screen.elements as readonly UiNode[], `i${one.id}`)?.source;
}

interface UiNode {
  readonly id?: string;
  readonly source?: unknown;
  readonly children?: readonly UiNode[];
}

function findElement(nodes: readonly UiNode[], id: string): UiNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }

    const inside = findElement(node.children ?? [], id);

    if (inside !== null) {
      return inside;
    }
  }

  return null;
}

describe('o desenho do card', () => {
  it('sem arte, continua vindo do ícone do JOGO', () => {
    const source = cardImageSource(offer());

    // Ele não custa download nenhum: o cliente já o tem.
    expect(source).toEqual({ kind: 'item', itemId: 833533164, skinId: '0' });
  });

  it('com arte, vira o lugar reservado da biblioteca de imagens', () => {
    const source = cardImageSource(offer({ icon: { ...offer().icon, file: 'vip.png' } }));

    expect(source).toEqual({ kind: 'stored', key: 'store.vip-ouro' });
  });
});

describe('as artes que sobem ao jogo', () => {
  it('leva só a oferta LIGADA que tem arte', () => {
    const assets = loadStoreIcons(
      [
        offer({ id: 'com-arte', icon: { ...offer().icon, file: 'vip.png' } }),
        offer({ id: 'sem-arte' }),
        offer({ id: 'desligada', enabled: false, icon: { ...offer().icon, file: 'vip.png' } }),
      ],
      () => PNG,
    );

    expect(assets.map((asset) => asset.key)).toEqual(['store.com-arte']);
  });

  it('arquivo que sumiu do disco vira aviso, e o card cai no ícone do jogo', () => {
    const logger = quietLogger();

    const assets = loadStoreIcons(
      [offer({ icon: { ...offer().icon, file: 'sumiu.png' } })],
      () => null,
      logger,
    );

    expect(assets).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('a arte do kit', () => {
  const kit = {
    slug: 'kit-inicial',
    name: 'Kit Inicial',
    iconFile: null as string | null,
    enabled: true,
  };

  it('a chave sai do SLUG, e não do id', () => {
    // O id é um autoincrement desta máquina; o slug é o identificador
    // estável. Um kit apagado e recriado com o mesmo slug mantém a
    // chave — e, com ela, os bytes que o cliente já baixou.
    expect(kitIconKey('kit-inicial')).toBe('kit.kit-inicial');
  });

  it('leva só o kit LIGADO que tem arte', () => {
    const assets = loadKitIcons(
      [
        { ...kit, slug: 'com-arte', iconFile: 'kit.png' },
        { ...kit, slug: 'sem-arte' },
        { ...kit, slug: 'desligado', iconFile: 'kit.png', enabled: false },
      ],
      () => PNG,
    );

    expect(assets.map((asset) => asset.key)).toEqual(['kit.com-arte']);
  });

  it('arquivo que sumiu vira aviso, e o card cai no palpite de sempre', () => {
    const logger = quietLogger();

    const assets = loadKitIcons([{ ...kit, iconFile: 'sumiu.png' }], () => null, logger);

    expect(assets).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('`iconFile` OMITIDO conserva o que está gravado — é o que o site manda', () => {
    const body = kitBody.parse({
      slug: 'kit-inicial',
      name: 'Kit Inicial',
      kind: 'resgate',
      items: [],
    });

    expect(toKitInput(body, { iconFile: 'kit.png' }).iconFile).toBe('kit.png');
    // E `null` é a escolha de voltar ao ícone do primeiro item.
    expect(toKitInput({ ...body, iconFile: null }, { iconFile: 'kit.png' }).iconFile).toBeNull();
  });
});

describe('o campo `file` no corpo da oferta', () => {
  const base = {
    categoryId: 'vips',
    kind: 'vip',
    name: 'VIP Ouro',
    price: 5000,
    vip: { tier: 'gold', days: 30 },
  };

  it('OMITIDO conserva a arte gravada — é o que o site manda', () => {
    const body = storeOfferBody.parse({
      ...base,
      // SEM o campo `file`: é assim que o payload do site chega.
      icon: { shortname: 'box.wooden.large', itemId: 1, skinId: '0' },
    });

    const input = toOfferInput(body, offer({ icon: { ...offer().icon, file: 'vip.png' } }));

    // Sem isto, aplicar a loja do site apagaria a arte escolhida no
    // painel — e ninguém ligaria uma coisa à outra.
    expect(input.icon.file).toBe('vip.png');
  });

  it('`null` é a escolha de usar o ícone do jogo, e limpa', () => {
    const body = storeOfferBody.parse({
      ...base,
      icon: { shortname: 'box.wooden.large', itemId: 1, skinId: '0', file: null },
    });

    const input = toOfferInput(body, offer({ icon: { ...offer().icon, file: 'vip.png' } }));

    expect(input.icon.file).toBeNull();
  });

  it('a oferta sem ícone e sem arte é RECUSADA', () => {
    const parsed = storeOfferBody.safeParse({
      ...base,
      icon: { shortname: '', itemId: 0, skinId: '0', file: null },
    });

    expect(parsed.success).toBe(false);
  });

  it('sem ícone do jogo, mas com arte, passa', () => {
    const parsed = storeOfferBody.safeParse({
      ...base,
      icon: { shortname: '', itemId: 0, skinId: '0', file: 'vip.png' },
    });

    expect(parsed.success).toBe(true);
  });
});
