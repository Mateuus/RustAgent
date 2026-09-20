// ============================================================
//  ui-kits-grade.test.ts  -  a lista de kits: a coluna, a rolagem
//  e o card.
//
//  ####  OS TRÊS DEFEITOS QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  1. AS CATEGORIAS SAÍAM PELA BORDA. Elas eram uma fileira
//     horizontal de abas sob o título, cada uma com a largura do
//     próprio nome. Com três cabia; com sete, a última era desenhada
//     além da borda da tela — e desenhada em silêncio: sem seta, sem
//     reticências, sem nada dizendo que existia mais. Viraram uma
//     COLUNA, que cresce para baixo, e o que não couber é CONTADO.
//
//  2. O VIP FICAVA ATRÁS DO BOTÃO. "EXCLUSIVO VIP OURO" era uma
//     linha do card entre 194 e 210 px do topo; o botão de resgate
//     ia de 200 a 230. No jogo o texto aparecia cortado ao meio, e
//     foi assim que o dono o encontrou — numa captura de tela, não
//     num teste. Agora o card é medido contra ele mesmo.
//
//  3. A TELA PODE NÃO CABER NO FRAME DO RCON. Ela vai ao plugin num
//     comando de console, e o teto são 50.000 bytes em base64.
//     Estourar não dá erro: o frame é cortado, o JSON chega
//     truncado e o menu não abre — no servidor com vinte kits,
//     nunca na máquina de quem escreveu o código com três.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { KitOfferView } from '../src/kits/service.js';
import { CANVAS, resolveRect, screenViewport, type Box } from '../src/game/ui-geometry.js';
import { buildKitsScreen, KITS_SCREEN_ID } from '../src/game/ui-kits-screen.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import {
  encodeUiScreenParts,
  toGeneratedScreenBundle,
  UI_DOC_MAX_BYTES,
} from '../src/types/ui-transport.js';
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

function textsOf(elements: readonly UiElement[]): string[] {
  return walk(elements)
    .filter((element) => element.type === 'label')
    .map((element) => (element.type === 'label' ? element.text : ''));
}

/**
 * A área em que esta tela é desenhada, MEDIDA no preset.
 *
 * Ela era uma conta escrita à mão aqui dentro (`720 - 76 - 60`), e
 * a tela tinha a sua ("516 px"). Duas estimativas do mesmo número, e
 * nenhuma batia com o slot de verdade: 1064,4 x 493,6.
 */
const CONTENT = ((): { readonly width: number; readonly height: number } => {
  const document = buildMainMenu();
  const screen = document.screens.find((item) => item.id === KITS_SCREEN_ID);

  if (screen === undefined) {
    throw new Error('o preset perdeu a tela de kits');
  }

  return screenViewport(document, screen);
})();

/**
 * A caixa de um elemento, medida na cadeia inteira.
 *
 * O pai é o SLOT de conteúdo do shell, e não a tela: uma página do
 * menu é desenhada dentro da moldura, sob o cabeçalho.
 *
 * Dentro de uma área ROLÁVEL o pai deixa de ser o retângulo visível
 * e passa a ser o do conteúdo — mais alto, e é justamente por isso
 * que ele rola.
 */
function boxOf(elements: readonly UiElement[], id: string, parent = CONTENT): Box | null {
  for (const element of elements) {
    const box = resolveRect(element.rect, parent);

    if (element.id === id) {
      return box;
    }

    const inside = boxOf(element.children, id, {
      width: box.width,
      height: element.type === 'scroll' ? box.height * element.contentScale : box.height,
    });

    if (inside !== null) {
      return inside;
    }
  }

  return null;
}

/**
 * Como esta tela sai para o plugin: um comando, ou vários.
 *
 * Ela já coube num comando só e hoje não cabe mais — é o preço da
 * rolagem. Quem corta é `encodeUiScreenParts`, e o que se mede aqui
 * é o que chega ao RCON: nenhum comando acima do frame, e nenhum
 * elemento deixado para trás.
 */
function frames(
  offers: readonly KitOfferView[],
  category: string | null = null,
): { readonly maior: number; readonly partes: number; readonly perdidos: number } {
  const document = buildMainMenu();
  const screen = buildKitsScreen({
    offers,
    target: { kind: 'grid', category, page: 0 },
    itemOf: () => ({ itemId: -1, displayName: 'Assault Rifle' }),
  });

  const { commands, dropped } = encodeUiScreenParts({
    requestId: 'x'.repeat(16),
    documentId: document.id,
    screen: toGeneratedScreenBundle(document, screen, KITS_SCREEN_ID),
  });

  return {
    maior: Math.max(...commands.map((command) => command.length)),
    partes: commands.length,
    perdidos: dropped,
  };
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
    const cards = boxOf(elements, 'kg');

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
    const elements = grid(categorized(3), 'categoria-1');
    const items = walk(elements);

    // A ordem da coluna é a de aparição dos kits, então `kc1` é a
    // segunda categoria — a que o endereço pediu.
    expect(items.find((element) => element.id === 'kc1')?.type).toBe('panel');
    expect(items.find((element) => element.id === 'kc0')?.type).toBe('button');
  });

  it('cada categoria diz quantos kits tem', () => {
    // Sem o número, escolher uma categoria é abrir para descobrir —
    // e a contagem cabe no mesmo rótulo, sem um elemento a mais.
    const offers = [
      offer({ id: 1, slug: 'a', category: 'VIP' }),
      offer({ id: 2, slug: 'b', category: 'VIP' }),
      offer({ id: 3, slug: 'c', category: 'GERAL' }),
    ];

    const texts = walk(grid(offers))
      .filter((element) => element.id.startsWith('kc'))
      .flatMap((element) =>
        element.type === 'button' ? [element.text] : textsOf(element.children),
      );

    expect(texts).toContain('VIP · 2');
    expect(texts).toContain('GERAL · 1');
  });

  // ####  A MEDIDA QUE A FILEIRA NÃO TINHA  ####

  it('mantém todas as categorias dentro da tela', () => {
    const elements = grid(categorized(12));

    for (const element of walk(elements)) {
      if (!element.id.startsWith('kc') || element.id === 'kcmais') {
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

  it('o item aberto encosta na borda quando não há barra de rolagem', () => {
    // ####  O DEFEITO DA CAPTURA DE 20/09/2026  ####
    //
    // Os itens param antes da borda direita para a barra não cair
    // sobre o nome da categoria. Só que a barra some quando a
    // coluna não rola — e o recuo ficava lá, deixando uma tira
    // cinza entre o fundo preto do item ABERTO e a borda da coluna.
    const poucas = walk(grid(categorized(4))).find((element) => element.id === 'kc0');
    const muitas = walk(grid(categorized(30))).find((element) => element.id === 'kc0');

    expect(poucas?.rect.offsetMax.x).toBe(0);
    // Com a coluna rolando, o recuo volta: a barra precisa do lugar.
    expect(muitas?.rect.offsetMax.x).toBeLessThan(0);
  });

  it('com muitas categorias, a coluna rola em vez de cortar', () => {
    // Ela contava o que não coubesse ("e mais 4..."), e o excedente
    // ficava inalcançável: quem tivesse dezessete categorias não
    // tinha como abrir as quatro últimas.
    const area = walk(grid(categorized(40))).find((element) => element.id === 'kcs');

    expect(area?.type).toBe('scroll');
    expect(area?.type === 'scroll' ? area.contentScale : 0).toBeGreaterThan(1);
    expect(textsOf(grid(categorized(40))).some((text) => text.startsWith('e mais '))).toBe(false);
  });

  it('mas continua havendo teto, para a coluna não comer a grade', () => {
    // Cada linha custa ~930 bytes no desenho. Sem limite, uma coluna
    // de duzentas categorias gastaria a página inteira e a grade
    // ficaria sem o que mostrar — e o excedente volta a ser DITO.
    expect(textsOf(grid(categorized(200))).some((text) => text.startsWith('e mais '))).toBe(true);
  });

  it('a categoria navega, e não abre modal', () => {
    // `modal.open` abriria a tela de kits POR CIMA da tela de kits,
    // empilhando um modal a cada troca de categoria.
    const buttons = walk(grid(categorized(3))).filter(
      (element) => element.type === 'button' && element.id.startsWith('kc'),
    );

    expect(buttons.length).toBeGreaterThan(0);

    for (const element of buttons) {
      expect(element.type === 'button' && element.action.kind).toBe('navigate');
    }
  });
});

// ============================================================
//  O CABEÇALHO
// ============================================================

describe('a faixa de título', () => {
  it('diz quantos kits há e quantos dão para pegar agora', () => {
    // É a única coisa nesta faixa que muda de servidor para servidor
    // e de jogador para jogador — o resto a aba acesa já dizia.
    const offers = [
      offer({ id: 1, slug: 'a', available: true }),
      offer({ id: 2, slug: 'b', available: true }),
      offer({ id: 3, slug: 'c', available: false, reason: 'Já pegou.' }),
    ];

    expect(textsOf(grid(offers))).toContain('3 kits · 2 disponíveis agora');
  });

  it('no singular, escreve no singular', () => {
    expect(textsOf(grid([offer()]))).toContain('1 kit · 1 disponível agora');
  });

  it('a frase de antes virou a dica do "?"', () => {
    // Ela ocupava uma linha inteira da tela para explicar uma vez o
    // que quem já viu a tela não precisa reler a cada abertura.
    const mark = walk(grid([offer()])).find((element) => element.id === 'kh-i');

    expect(mark?.type).toBe('label');
    expect(mark?.tooltip ?? '').toContain('O que a rede entrega');
  });
});

// ============================================================
//  A ROLAGEM
// ============================================================

describe('a grade rola', () => {
  it('é uma área rolável, e não uma página de oito', () => {
    const area = walk(grid(Array.from({ length: 12 }, (_u, i) => offer({ id: i, slug: `k${String(i)}` }))))
      .find((element) => element.id === 'kg');

    expect(area?.type).toBe('scroll');
  });

  it('com poucos kits, a área não rola', () => {
    // `contentScale` 1 = o conteúdo cabe. A área continua existindo
    // para a tela não mudar de forma entre um servidor com três kits
    // e outro com trinta.
    const area = walk(grid([offer()])).find((element) => element.id === 'kg');

    expect(area?.type === 'scroll' ? area.contentScale : 0).toBe(1);
  });

  it('com muitos, o conteúdo fica mais alto que a área', () => {
    const offers = Array.from({ length: 12 }, (_u, i) => offer({ id: i, slug: `k${String(i)}` }));
    const area = walk(grid(offers)).find((element) => element.id === 'kg');

    expect(area?.type === 'scroll' ? area.contentScale : 0).toBeGreaterThan(1.3);
  });

  it('o último card de cada fileira para ANTES da barra de rolagem', () => {
    // ####  O DEFEITO DA CAPTURA DE 20/09/2026  ####
    //
    // A barra é desenhada POR DENTRO da área, nos últimos pixels
    // dela: o `ScrollRect` não encolhe o conteúdo para abrir
    // espaço. Encolher a ÁREA não adianta — o card acompanha, e a
    // barra continua em cima dele. Quem tem de parar antes é o
    // CONTEÚDO.
    const quatro = Array.from({ length: 4 }, (_u, index) =>
      offer({ id: index, slug: `kit-${String(index)}` }),
    );

    const area = boxOf(grid(quatro), 'kg');
    const ultimo = boxOf(grid(quatro), 'k3c');

    expect(area).not.toBeNull();
    expect(ultimo).not.toBeNull();

    if (area !== null && ultimo !== null) {
      const sobra = area.left + area.width - (ultimo.left + ultimo.width);

      expect(sobra).toBeGreaterThanOrEqual(10);
    }
  });

  it('só volta a paginar quando o frame do RCON não dá conta', () => {
    const poucos = Array.from({ length: 12 }, (_u, i) => offer({ id: i, slug: `k${String(i)}` }));
    const muitos = Array.from({ length: 60 }, (_u, i) => offer({ id: i, slug: `k${String(i)}` }));

    expect(idsOf(grid(poucos))).not.toContain('kits-pgn');
    expect(idsOf(grid(muitos))).toContain('kits-pgn');
  });
});

// ============================================================
//  O FRAME DO RCON
//
//  ####  O TETO QUE NÃO SE VÊ NA TELA  ####
//
//  Esta tela pode ficar grande sem ninguém mexer em código: basta o
//  admin cadastrar kits, dar nomes longos a eles e escrever
//  descrições. O `fitCards` corta a página por BYTES, e é aqui que
//  se confere que a conta dele ainda bate com o que a tela pesa de
//  verdade.
// ============================================================

describe('a tela cabe no que o RCON sabe mandar', () => {
  function many(count: number, over: Partial<KitOfferView> = {}): KitOfferView[] {
    return Array.from({ length: count }, (_u, index) =>
      offer({ id: index, slug: `kit-numero-${String(index)}`, ...over }),
    );
  }

  it('com sessenta kits simples, em comandos que cabem no frame', () => {
    const { maior, perdidos } = frames(many(60));

    expect(maior).toBeLessThan(UI_DOC_MAX_BYTES);
    expect(perdidos).toBe(0);
  });

  it('com sessenta kits no pior caso que o cadastro permite', () => {
    // Nome de 64 caracteres e descrição de 400 são os tetos do
    // `kitBody` (http/routes/kits.ts). O VIP acrescenta um elemento
    // e uma dica; o motivo de não dar para pegar acrescenta outra.
    const { maior, perdidos } = frames(
      many(60, {
        name: 'KIT DE SOBREVIVENCIA AVANCADA PARA O WIPE DE SEXTA A NOITE OK!!!',
        description: 'D'.repeat(400),
        requiredTier: 'gold',
        requiredTierExact: true,
        available: false,
        nextAt: '2099-01-01T00:00:00.000Z',
        reason: 'R'.repeat(300),
      }),
    );

    expect(maior).toBeLessThan(UI_DOC_MAX_BYTES);
    expect(perdidos).toBe(0);
  });

  it('com a coluna de categorias cheia', () => {
    const offers = Array.from({ length: 60 }, (_u, index) =>
      offer({
        id: index,
        slug: `kit-numero-${String(index)}`,
        name: `KIT NUMERO ${String(index)} DE NOME LONGO`,
        category: `CATEGORIA DE NOME LONGO ${String(index % 13)}`,
      }),
    );

    const { maior, perdidos } = frames(offers, 'categoria-de-nome-longo-0');

    expect(maior).toBeLessThan(UI_DOC_MAX_BYTES);
    expect(perdidos).toBe(0);
  });

  it('e a rolagem passou a valer a pena: mais de três fileiras numa página', () => {
    // ####  A OUTRA METADE DO RISCO  ####
    //
    // Uma régua conservadora devolve doze cards, a grade mostra três
    // fileiras — e a rolagem não serve para nada, porque tudo o que
    // cabe na página cabe também na tela.
    const elements = grid(
      Array.from({ length: 60 }, (_u, index) =>
        offer({ id: index, slug: `kit-numero-${String(index)}` }),
      ),
    );

    const cards = idsOf(elements).filter((id) => /^k\d+c$/.test(id)).length;

    expect(cards).toBeGreaterThan(16);
  });

  it('a tela grande sai partida, e não num comando gigante', () => {
    const { partes } = frames(
      Array.from({ length: 60 }, (_u, index) =>
        offer({ id: index, slug: `kit-numero-${String(index)}` }),
      ),
    );

    expect(partes).toBeGreaterThan(1);
  });
});

// ============================================================
//  O CARD, MEDIDO CONTRA ELE MESMO
//
//  ####  A MESMA LIÇÃO DO MODAL DO VIP  ####
//
//  Lá, a lista era ancorada no topo e o TOTAL no fundo, e ninguém
//  obrigava os dois a concordarem — o resultado foi uma palavra
//  escrita por cima de outra, visível só a partir da quarta linha.
//
//  O card tem a mesma forma de risco: faixa do nome, arte e meta
//  contados do TOPO, e o botão do FUNDO. Uma mudança de altura mexe
//  nos dois lados de uma vez, e foi exatamente assim que o
//  "EXCLUSIVO VIP OURO" acabou atrás do botão.
// ============================================================

describe('o card de um kit', () => {
  const elements = grid([offer({ slug: 'kit-x', name: 'Kit X' })]);

  /** A caixa de uma peça do card. */
  function pieceOf(id: string, from: readonly UiElement[] = elements): Box {
    const found = boxOf(from, id);

    if (found === null) {
      throw new Error(`a peça "${id}" sumiu do card`);
    }

    return found;
  }

  it('empilha nome, arte e meta sem um invadir o outro', () => {
    const faixa = pieceOf('k0n');
    const arte = pieceOf('k0i');
    const meta = pieceOf('k0m');

    expect(faixa.top + faixa.height).toBeLessThanOrEqual(arte.top);
    expect(arte.top + arte.height).toBeLessThanOrEqual(meta.top);
  });

  it('não deixa a meta acabar embaixo do botão', () => {
    // ####  ESTE É O DEFEITO DA CAPTURA DE 19/09/2026  ####
    //
    // O botão é ancorado no FUNDO e a meta no topo: um card mais
    // baixo aproxima os dois sem ninguém perceber, e o que aparece
    // no jogo é texto cortado ao meio por um retângulo.
    const meta = pieceOf('k0m');
    const acao = pieceOf('k0b');

    expect(meta.top + meta.height).toBeLessThanOrEqual(acao.top);
  });

  it('a arte do kit é grande, porque é ela que o identifica', () => {
    // O admin sobe um PNG por kit. Reduzida a um selo de canto, ela
    // deixa de ser a figura do kit.
    expect(pieceOf('k0i').height).toBeGreaterThanOrEqual(90);
  });

  it('o card inteiro abre o detalhe, sem um botão "VER" no rodapé', () => {
    // O "VER" de 50 px que dividia o rodapé com a ação dizia
    // "mostre o que já está escrito aqui, só que completo" — e
    // custava dois elementos do frame por card.
    const area = walk(elements).find((element) => element.id === 'k0o');

    expect(area?.type).toBe('button');
    expect(area?.type === 'button' ? area.action.kind : '').toBe('modal.open');
    // Invisível: quem desenha o card são os outros elementos.
    expect(area?.type === 'button' ? area.color : '').toBe('#00000000');
    expect(idsOf(elements)).not.toContain('k0info');
  });

  it('a área clicável deixa o botão de ação de fora', () => {
    // ####  DOIS BOTÕES NO MESMO PONTO: O DE BAIXO NUNCA RESPONDE  ####
    //
    // No Unity quem recebe o clique é o elemento da frente. Se a
    // área do card cobrisse o rodapé, o RESGATAR abriria o detalhe
    // em vez de pedir o kit — e pareceria que o botão não funciona.
    const area = pieceOf('k0o');
    const acao = pieceOf('k0b');

    expect(area.top + area.height).toBeLessThanOrEqual(acao.top);
  });

  it('o card é um painel, e não um botão', () => {
    // ####  O CLIENTE NÃO PINTA UM BOTÃO COMO PINTA UM PAINEL  ####
    //
    // O card já foi um `button`, para ser clicável inteiro. No jogo
    // ele apareceu PRETO: a cor de um `CuiButton` passa pelo
    // `ColorBlock` antes de virar pixel, e #262626 acabou em quase
    // #000000. Está aqui porque o defeito só aparece no jogo — no
    // modelo as duas formas são igualmente válidas.
    const card = walk(elements).find((element) => element.id === 'k0c');

    expect(card?.type).toBe('panel');
    // A moldura do menu é `--surface`. Um card da mesma cor não tem
    // borda contra ela — e o CUI não tem borda de verdade para dar.
    expect(card?.type === 'panel' ? card.color : '').not.toBe('#1B1B1B');
  });

  it('a barra de estado diz o que o rodapé diz', () => {
    // Verde quando dá para pegar, vermelho quando não vai
    // acontecer, âmbar quando é só esperar. Sem isso, saber o que
    // está disponível exige ler doze rodapés.
    //
    // Ela chegou a ser a faixa INTEIRA do nome, tingida: o dono
    // olhou a captura e recusou — uma faixa colorida atrás do nome
    // briga com a arte logo abaixo.
    const corDa = (kit: KitOfferView): string => {
      const found = walk(grid([kit])).find((element) => element.id === 'k0a');

      return found !== undefined && found.type === 'panel' ? found.color : '';
    };

    const livre = corDa(offer({ slug: 'a', available: true }));
    const preso = corDa(offer({ slug: 'b', available: false, reason: 'Ja pegou este kit.' }));
    const espera = corDa(
      offer({ slug: 'c', available: false, nextAt: '2099-01-01T00:00:00.000Z' }),
    );

    expect(new Set([livre, preso, espera]).size).toBe(3);

    // E a faixa do nome continua escura, para o nome se ler nela.
    const faixa = walk(elements).find((element) => element.id === 'k0n');

    expect(faixa?.type === 'panel' ? faixa.color : '').toBe('#0F0F0F');
  });

  it('a exigência de VIP é um ícone com dica, e não uma linha de texto', () => {
    // ####  POR QUE ELA SAIU DO CORPO DO CARD  ####
    //
    // Escrita, ela custava uma linha inteira — e foi essa linha que
    // acabou atrás do botão. Como ícone em âmbar na ponta da faixa
    // do nome, ela se lê à distância e a frase inteira fica no
    // tooltip, para quem parar o mouse.
    const comVip = grid([offer({ slug: 'v', requiredTier: 'ouro', requiredTierExact: true })]);
    const semVip = grid([offer({ slug: 'w', requiredTier: null })]);

    const mark = walk(comVip).find((element) => element.id === 'k0v');

    expect(mark?.type).toBe('image');
    expect(mark?.tooltip).toBe('EXCLUSIVO VIP OURO');
    expect(textsOf(comVip)).not.toContain('EXCLUSIVO VIP OURO');

    // Sem exigência, nada ocupando o lugar.
    expect(idsOf(semVip)).not.toContain('k0v');
  });

  it('"exclusivo" e "exige" não são a mesma frase', () => {
    // `requiredTierExact` recusa quem está ACIMA do nível também, e
    // é justamente ele quem clica achando que o nível melhor dá
    // acesso a tudo.
    const tipOf = (kit: KitOfferView): string | null | undefined =>
      walk(grid([kit])).find((element) => element.id === 'k0v')?.tooltip;

    expect(tipOf(offer({ slug: 'a', requiredTier: 'prata', requiredTierExact: true }))).toBe(
      'EXCLUSIVO VIP PRATA',
    );
    expect(tipOf(offer({ slug: 'b', requiredTier: 'prata', requiredTierExact: false }))).toBe(
      'EXIGE VIP PRATA',
    );
  });

  it('o nome não passa por baixo do ícone de VIP', () => {
    const comVip = grid([offer({ slug: 'v', name: 'KIT DE NOME BEM LONGO', requiredTier: 'ouro' })]);

    const nome = pieceOf('k0t', comVip);
    const mark = pieceOf('k0v', comVip);

    expect(nome.left + nome.width).toBeLessThanOrEqual(mark.left);
  });

  it('quem não pode pegar vê o motivo curto, e o longo na dica', () => {
    const preso = grid([
      offer({
        slug: 'b',
        available: false,
        nextAt: '2099-01-01T00:00:00.000Z',
        reason: 'O kit Kit Inicial ainda nao esta disponivel para 76561198000000000.',
      }),
    ]);

    const morto = walk(preso).find((element) => element.id === 'k0b');

    expect(morto?.type).toBe('panel');
    expect(textsOf(preso).some((text) => text.startsWith('EM '))).toBe(true);
    expect(morto?.tooltip).toContain('Você já pegou');
  });

  it('a dica NUNCA mostra o SteamID de quem está lendo', () => {
    // ####  O `reason` DO `KitStore` É A FRASE DO PAINEL  ####
    //
    // "O kit Kit Avançado é de resgate único, e 76561198065694695 já
    // o pegou em 06/09/2026." Ela nomeia o kit e o número da conta
    // porque quem a lê está no suporte, olhando o registro de outra
    // pessoa.
    //
    // Dentro do jogo quem lê é o dono daquele número, com o nome do
    // kit escrito dois centímetros acima. O dono encontrou o próprio
    // SteamID numa dica e pediu "Você já pegou".
    const preso = grid([
      offer({
        slug: 'b',
        available: false,
        usesLeft: 0,
        reason: 'O kit Kit Inicial e de resgate unico, e 76561198000000000 ja o pegou.',
      }),
    ]);

    for (const element of walk(preso)) {
      expect(element.tooltip ?? '').not.toContain('76561198000000000');
    }

    expect(walk(preso).find((element) => element.id === 'k0b')?.tooltip).toBe(
      'Você já pegou este kit, e ele é de uma vez só.',
    );
  });

  it('a dica do card leva a descrição que o admin escreveu', () => {
    // Ela não aparecia em lugar nenhum da grade — só dentro do
    // modal, depois de um clique que ninguém dá sem motivo.
    const area = walk(
      grid([offer({ slug: 'd', description: 'Tudo para o primeiro dia de wipe.' })]),
    ).find((element) => element.id === 'k0o');

    expect(area?.tooltip).toContain('Tudo para o primeiro dia de wipe.');
  });

  it('corta uma descrição comprida na dica, em vez de deixá-la sair da tela', () => {
    // O cadastro aceita 400 caracteres, e o tooltip é UMA linha.
    const area = walk(grid([offer({ slug: 'd', description: 'D'.repeat(400) })])).find(
      (element) => element.id === 'k0o',
    );

    expect((area?.tooltip ?? '').length).toBeLessThan(220);
    expect(area?.tooltip).toContain('...');
  });

  it('mantém tudo dentro do card', () => {
    const card = boxOf(elements, 'k0c');

    expect(card).not.toBeNull();

    if (card === null) {
      return;
    }

    for (const id of ['k0n', 'k0i', 'k0m', 'k0b']) {
      const piece = boxOf(elements, id);

      expect(piece).not.toBeNull();

      if (piece !== null) {
        // As peças resolvem DENTRO do card, então a origem é o card:
        // o que se compara é o fundo de cada uma com a altura dele.
        expect(piece.top).toBeGreaterThanOrEqual(0);
        expect(piece.top + piece.height).toBeLessThanOrEqual(card.height);
      }
    }
  });

  it('a primeira fileira cabe na área visível', () => {
    // O resto rola; a primeira não pode nascer cortada.
    const card = boxOf(grid(categorized(1).concat(offer({ id: 9, slug: 'z' }))), 'k0c');

    expect(card).not.toBeNull();

    if (card !== null) {
      expect(card.top).toBeGreaterThanOrEqual(0);
      expect(card.height).toBeLessThanOrEqual(CANVAS.height);
    }
  });
});
