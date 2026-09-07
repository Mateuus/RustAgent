// ============================================================
//  Testes do GERADOR DE ANIMAÇÃO do overlay de propagandas.
//
//  ####  POR QUE ESTE ARQUIVO EXISTE  ####
//
//  Esta é a única parte do recurso cujo erro é INVISÍVEL fora do
//  jogo. Um sinal trocado numa âncora não quebra nada, não lança
//  e não aparece em nenhum log — ele só faz o painel abrir para o
//  lado errado da tela de quem está jogando, e descobrir isso
//  exige entrar no servidor.
//
//  É a mesma razão pela qual a geometria do editor de interfaces
//  ganhou teste próprio antes de o editor existir.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  ADS_IMG,
  ADS_LOGO,
  ADS_PANEL,
  ADS_ROOT,
  ADS_SLOT,
  buildTimeline,
  imageAnchors,
} from '../src/game/ads-timeline.js';
import type { AdsSettings } from '../src/types/ads.js';

const BASE: AdsSettings = {
  enabled: true,
  layer: 'Hud',
  permission: null,
  anchor: 'top-right',
  marginTop: 24,
  marginRight: 24,
  logoEnabled: true,
  logoImageUrl: 'https://exemplo.com/logo.png',
  logoWidth: 90,
  logoHeight: 90,
  logoOpacity: 0.95,
  logoDetached: false,
  logoAnchor: 'top-center',
  staticMode: false,
  logoLayer: null,
  logoMarginX: 0,
  logoMarginY: 24,
  panelWidth: 360,
  panelHeight: 120,
  panelColor: '#0A0A0AEB',
  panelBorderColor: '#FFFFFF26',
  panelBorderEnabled: true,
  intervalSeconds: 300,
  defaultDisplayDuration: 8,
  openingMs: 700,
  closingMs: 600,
  transitionMs: 500,
  orderMode: 'sequential',
  adsPerCycle: 3,
  animationFps: 15,
  imageMode: 'stored',
  updatedAt: new Date(0).toISOString(),
};

/** O RectTransform de um elemento, para conferir a geometria. */
function rectOf(element: { components: readonly { type: string }[] }): Record<string, string> {
  const found = element.components.find((component) => component.type === 'RectTransform');
  return (found ?? {}) as unknown as Record<string, string>;
}

function pair(value: string): [number, number] {
  const [x, y] = value.split(' ');
  return [Number(x), Number(y)];
}

describe('a raiz', () => {
  it('fica no canto superior direito, respeitando as margens', () => {
    const { root } = buildTimeline(BASE);
    const raiz = root.find((element) => element.name === ADS_ROOT);

    expect(raiz).toBeDefined();
    expect(raiz?.parent).toBe('Hud');
    // Destroi a si mesma antes de nascer: sem isso, um segundo
    // envio empilharia duas raízes na tela do jogador.
    expect(raiz?.destroyUi).toBe(ADS_ROOT);

    const rect = rectOf(raiz!);
    expect(rect.anchormin).toBe('1 1');
    expect(rect.anchormax).toBe('1 1');

    // Canto superior direito: os dois offsets são NEGATIVOS, e o
    // max é a margem. Um sinal trocado aqui joga o widget para
    // fora da tela — e não há erro nenhum quando isso acontece.
    const [maxX, maxY] = pair(rect.offsetmax ?? '');
    expect(maxX).toBe(-24);
    expect(maxY).toBe(-24);

    const [minX, minY] = pair(rect.offsetmin ?? '');
    // A área é a MAIOR das duas (painel 360x120 x logo 90x90).
    expect(minX).toBe(-(24 + 360));
    expect(minY).toBe(-(24 + 120));
  });

  it('no canto superior esquerdo os offsets viram positivos', () => {
    const { root } = buildTimeline({ ...BASE, anchor: 'top-left' });
    const rect = rectOf(root.find((element) => element.name === ADS_ROOT)!);

    expect(rect.anchormin).toBe('0 1');
    const [minX] = pair(rect.offsetmin ?? '');
    const [maxX] = pair(rect.offsetmax ?? '');

    expect(minX).toBe(24);
    expect(maxX).toBe(24 + 360);
  });

  it('sem logo, a raiz nasce sozinha', () => {
    const { root } = buildTimeline({ ...BASE, logoEnabled: false });
    expect(root).toHaveLength(1);
  });

  it('logo ligado sem URL não desenha nada — e não quebra', () => {
    const { root } = buildTimeline({ ...BASE, logoImageUrl: null });
    expect(root.map((element) => element.name)).toEqual([ADS_ROOT]);
  });
});

describe('o logo em lugar próprio', () => {
  it('desligado, ele continua dentro da raiz — no canto do painel', () => {
    const { root } = buildTimeline(BASE);
    const logo = root.find((element) => element.name === ADS_LOGO);

    expect(logo?.parent).toBe(ADS_ROOT);
  });

  it('ligado, ele sai da raiz e vai para a CAMADA do jogo', () => {
    const { root } = buildTimeline({ ...BASE, logoDetached: true });
    const logo = root.find((element) => element.name === ADS_LOGO);

    // A raiz é o retângulo do PAINEL, no canto: um logo no alto e
    // ao centro não caberia dentro dela.
    expect(logo?.parent).toBe('Hud');
  });

  it('NÃO some quando o painel abre — são dois elementos independentes', () => {
    const solto = buildTimeline({ ...BASE, logoDetached: true });
    const junto = buildTimeline(BASE);

    // No lugar padrão eles dividem o canto: o painel abrindo por
    // cima do logo seriam dois desenhos empilhados, então o logo
    // sai.
    expect(junto.opening.frames[0]?.destroy).toEqual([ADS_LOGO]);

    // Com lugar próprio, apagá-lo seria tirar da tela algo que não
    // tem nada a ver com o que está acontecendo no canto.
    expect(solto.opening.frames[0]?.destroy).toBeUndefined();

    // E como ele nunca saiu, o fechamento não o recria: desenhar
    // por cima do que já está lá faria o cliente rebaixar a
    // textura à toa.
    expect(solto.closing.frames.at(-1)?.cui).toHaveLength(0);
    expect(junto.closing.frames.at(-1)?.cui[0]?.name).toBe(ADS_LOGO);
  });

  it('no alto e ao centro, fica centrado na horizontal', () => {
    const { root } = buildTimeline({
      ...BASE,
      logoDetached: true,
      logoAnchor: 'top-center',
      logoMarginX: 0,
      logoMarginY: 24,
    });

    const rect = rectOf(root.find((element) => element.name === ADS_LOGO)!);

    expect(rect.anchormin).toBe('0.5 1');
    expect(rect.anchormax).toBe('0.5 1');

    const [minX] = pair(rect.offsetmin ?? '');
    const [maxX] = pair(rect.offsetmax ?? '');

    // Metade da largura para cada lado do centro.
    expect(minX).toBeCloseTo(-45, 3);
    expect(maxX).toBeCloseTo(45, 3);

    // E abaixo do topo pela margem vertical.
    const [, maxY] = pair(rect.offsetmax ?? '');
    expect(maxY).toBeCloseTo(-24, 3);
  });

  it('a camada do logo pode ser OUTRA que a do painel', () => {
    // ####  A RAZAO DE O CAMPO EXISTIR  ####
    //
    // "A propaganda só no inventário" é `layer: 'Hud.Menu'`. Sem
    // uma camada própria, o logo ia junto — e o servidor ficaria
    // sem marca na tela fora do menu, que é o oposto do pedido.
    const { root } = buildTimeline({
      ...BASE,
      logoDetached: true,
      layer: 'Hud.Menu',
      logoLayer: 'Hud',
    });

    const logo = root.find((element) => element.name === ADS_LOGO);
    const raiz = root.find((element) => element.name === ADS_ROOT);

    expect(logo?.parent).toBe('Hud');
    expect(raiz?.parent).toBe('Hud.Menu');
  });

  it('sem camada propria, o logo herda a do painel', () => {
    // O que sempre aconteceu, e o que continua acontecendo para
    // quem já tinha overlay configurado.
    const { root } = buildTimeline({
      ...BASE,
      logoDetached: true,
      layer: 'Hud.Menu',
      logoLayer: null,
    });

    expect(root.find((element) => element.name === ADS_LOGO)?.parent).toBe('Hud.Menu');
  });

  it('preso ao painel, a camada do logo NAO se aplica', () => {
    // Ele é filho da raiz: pendurá-lo numa camada seria tirá-lo de
    // dentro do painel que ele deveria recolher.
    const { root } = buildTimeline({
      ...BASE,
      logoDetached: false,
      layer: 'Hud',
      logoLayer: 'Overall',
    });

    expect(root.find((element) => element.name === ADS_LOGO)?.parent).toBe(ADS_ROOT);
  });

  it('no centro, a margem vira DESLOCAMENTO — inclusive negativo', () => {
    const direita = buildTimeline({
      ...BASE,
      logoDetached: true,
      logoAnchor: 'top-center',
      logoMarginX: 100,
    });

    const esquerda = buildTimeline({
      ...BASE,
      logoDetached: true,
      logoAnchor: 'top-center',
      logoMarginX: -100,
    });

    const centroDe = (timeline: ReturnType<typeof buildTimeline>): number => {
      const rect = rectOf(timeline.root.find((element) => element.name === ADS_LOGO)!);
      return (pair(rect.offsetmin ?? '')[0] + pair(rect.offsetmax ?? '')[0]) / 2;
    };

    // Num canto isso seria "distância até a borda" e o negativo não
    // significaria nada. No centro, ele manda para o outro lado.
    expect(centroDe(direita)).toBeCloseTo(100, 3);
    expect(centroDe(esquerda)).toBeCloseTo(-100, 3);
  });

  it('nos cantos, a margem continua sendo distância até a borda', () => {
    const { root } = buildTimeline({
      ...BASE,
      logoDetached: true,
      logoAnchor: 'bottom-left',
      logoMarginX: 30,
      logoMarginY: 40,
    });

    const rect = rectOf(root.find((element) => element.name === ADS_LOGO)!);

    expect(rect.anchormin).toBe('0 0');

    const [minX, minY] = pair(rect.offsetmin ?? '');
    expect(minX).toBeCloseTo(30, 3);
    expect(minY).toBeCloseTo(40, 3);
  });

  it('os nove pontos dão nove âncoras diferentes', () => {
    const anchors = new Set<string>();

    for (const logoAnchor of [
      'top-left',
      'top-center',
      'top-right',
      'middle-left',
      'middle-center',
      'middle-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ] as const) {
      const { root } = buildTimeline({ ...BASE, logoDetached: true, logoAnchor });
      anchors.add(rectOf(root.find((element) => element.name === ADS_LOGO)!).anchormin ?? '');
    }

    expect(anchors.size).toBe(9);
  });

});

describe('a abertura', () => {
  it('mata o logo no primeiro quadro e cria o painel colapsado', () => {
    const { opening } = buildTimeline(BASE);
    const primeiro = opening.frames[0];

    expect(primeiro?.at).toBe(0);
    expect(primeiro?.destroy).toEqual([ADS_LOGO]);

    const painel = primeiro?.cui.find((element) => element.name === ADS_PANEL);
    expect(painel).toBeDefined();
    // Criado, e não atualizado: ele não existia antes.
    expect(painel?.update).toBeUndefined();

    const rect = rectOf(painel!);
    const [minX] = pair(rect.offsetmin ?? '');
    const [maxX] = pair(rect.offsetmax ?? '');
    expect(Math.abs(maxX - minX)).toBeLessThan(2);
  });

  it('cresce a partir da direita: a borda direita não se move', () => {
    const { opening } = buildTimeline(BASE);

    const direitas = opening.frames.map((frame) => {
      const painel = frame.cui.find((element) => element.name === ADS_PANEL);
      const [, ] = [0, 0];
      return pair(rectOf(painel!).offsetmax ?? '')[0];
    });

    // Todas iguais: é isso que dá a leitura de "barra sendo
    // revelada" em vez de "caixa aparecendo do nada".
    expect(new Set(direitas).size).toBe(1);
  });

  it('termina exatamente na largura do painel', () => {
    const { opening } = buildTimeline(BASE);
    const ultimo = opening.frames.at(-1);

    expect(ultimo?.at).toBe(700);

    const rect = rectOf(ultimo!.cui.find((element) => element.name === ADS_PANEL)!);
    const [minX] = pair(rect.offsetmin ?? '');
    const [maxX] = pair(rect.offsetmax ?? '');

    expect(Math.round(Math.abs(maxX - minX))).toBe(360);
  });

  it('o elástico passa do tamanho final e volta', () => {
    const { opening } = buildTimeline(BASE);

    const larguras = opening.frames.map((frame) => {
      const painel = frame.cui.find((element) => element.name === ADS_PANEL);
      const rect = rectOf(painel!);
      return Math.abs(pair(rect.offsetmax ?? '')[0] - pair(rect.offsetmin ?? '')[0]);
    });

    const maior = Math.max(...larguras);

    // Passa, mas pouco: mais que isso vira brinquedo, e o
    // elemento está no canto da tela de quem está jogando.
    expect(maior).toBeGreaterThan(360);
    expect(maior).toBeLessThan(360 * 1.06);
  });
});

describe('a troca de carta', () => {
  it('a entrada cria o slot e a imagem no primeiro quadro', () => {
    const { adEnter } = buildTimeline(BASE);
    const primeiro = adEnter.frames[0];

    expect(primeiro?.destroy).toEqual([ADS_SLOT]);
    expect(primeiro?.cui.map((element) => element.name)).toEqual([ADS_SLOT, ADS_IMG]);
  });

  it('a imagem entra com os lugares reservados, e não com valores', () => {
    const { adEnter } = buildTimeline(BASE);
    const img = adEnter.frames[0]?.cui.find((element) => element.name === ADS_IMG);

    const raw = img?.components.find((c) => c.type === 'UnityEngine.UI.RawImage') as
      | Record<string, unknown>
      | undefined;

    // Modo `stored`: o campo é `png` (o CRC), e não `url`. Mandar
    // o campo errado desenha um quadrado vazio SEM erro nenhum.
    expect(raw?.png).toBe('{adimage}');
    expect(raw?.url).toBeUndefined();

    const rect = rectOf(img!);
    expect(rect.anchormin).toBe('{adanchormin}');
    expect(rect.anchormax).toBe('{adanchormax}');
  });

  it('no modo url o campo é `url`', () => {
    const { adEnter } = buildTimeline({ ...BASE, imageMode: 'url' });
    const img = adEnter.frames[0]?.cui.find((element) => element.name === ADS_IMG);
    const raw = img?.components.find((c) => c.type === 'UnityEngine.UI.RawImage') as
      | Record<string, unknown>
      | undefined;

    expect(raw?.url).toBe('{adimage}');
    expect(raw?.png).toBeUndefined();
  });

  it('comprime para o CENTRO: é isso que parece uma carta girando', () => {
    const { adExit } = buildTimeline(BASE);

    for (const frame of adExit.frames) {
      const rect = rectOf(frame.cui[0]!);
      const [minX] = pair(rect.anchormin ?? '');
      const [maxX] = pair(rect.anchormax ?? '');

      // O meio do slot é sempre 0.5, em qualquer largura.
      //
      // Duas casas, e não cinco: as âncoras saem com três casas
      // decimais (ver `num`), então o centro pode andar até meio
      // milésimo. Num painel de 360 px isso é 0,18 px — menos que
      // o pixel que o cliente vai desenhar.
      expect((minX + maxX) / 2).toBeCloseTo(0.5, 2);
    }
  });

  it('a saída nunca chega a zero', () => {
    const { adExit } = buildTimeline(BASE);
    const ultimo = adExit.frames.at(-1);
    const rect = rectOf(ultimo!.cui[0]!);

    const [minX] = pair(rect.anchormin ?? '');
    const [maxX] = pair(rect.anchormax ?? '');

    // Largura zero SOME do cliente, e o quadro seguinte teria de
    // recriar o elemento.
    expect(maxX - minX).toBeGreaterThan(0);
  });

  it('entrada e saída são simétricas em duração', () => {
    const { adEnter, adExit } = buildTimeline(BASE);

    expect(adEnter.durationMs).toBe(500);
    expect(adExit.durationMs).toBe(500);
  });
});

describe('o fechamento', () => {
  it('só devolve o logo no último quadro, depois de destruir o painel', () => {
    const { closing } = buildTimeline(BASE);
    const ultimo = closing.frames.at(-1);

    expect(ultimo?.destroy).toEqual([ADS_PANEL]);
    expect(ultimo?.cui[0]?.name).toBe(ADS_LOGO);

    // Nenhum quadro ANTES do último pode trazer o logo: ele
    // apareceria por baixo do painel ainda encolhendo.
    const antes = closing.frames.slice(0, -1);
    for (const frame of antes) {
      expect(frame.cui.some((element) => element.name === ADS_LOGO)).toBe(false);
    }
  });

  it('sem logo configurado, o último quadro só destrói', () => {
    const { closing } = buildTimeline({ ...BASE, logoEnabled: false });
    expect(closing.frames.at(-1)?.cui).toHaveLength(0);
  });
});

describe('o enquadramento da imagem', () => {
  it('cover preenche tudo, sem recortar', () => {
    expect(imageAnchors('cover', 360, 120, { width: 100, height: 900 })).toEqual({
      min: '0 0',
      max: '1 1',
    });
  });

  it('contain deixa faixas em cima e embaixo quando a imagem é mais larga', () => {
    // 600x100 (6:1) num painel 360x120 (3:1): sobra vertical.
    const anchors = imageAnchors('contain', 360, 120, { width: 600, height: 100 });

    const [, minY] = pair(anchors.min);
    const [, maxY] = pair(anchors.max);

    expect(anchors.min.startsWith('0 ')).toBe(true);
    expect(anchors.max.startsWith('1 ')).toBe(true);
    expect(minY).toBeGreaterThan(0);
    expect(maxY).toBeLessThan(1);
    // Centralizada.
    expect(minY).toBeCloseTo(1 - maxY, 5);
  });

  it('contain deixa faixas dos lados quando a imagem é mais alta', () => {
    const anchors = imageAnchors('contain', 360, 120, { width: 100, height: 200 });

    const [minX] = pair(anchors.min);
    const [maxX] = pair(anchors.max);

    expect(minX).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(1);
    expect(anchors.min.endsWith(' 0')).toBe(true);
    expect(anchors.max.endsWith(' 1')).toBe(true);
  });

  it('sem as dimensões da imagem, preenche — e não divide por nada', () => {
    expect(imageAnchors('contain', 360, 120, { width: null, height: null })).toEqual({
      min: '0 0',
      max: '1 1',
    });

    expect(imageAnchors('contain', 360, 120, { width: 0, height: 0 })).toEqual({
      min: '0 0',
      max: '1 1',
    });
  });

  it('proporção igual à do painel não gera faixa nenhuma', () => {
    expect(imageAnchors('contain', 360, 120, { width: 720, height: 240 })).toEqual({
      min: '0 0',
      max: '1 1',
    });
  });
});

describe('o custo', () => {
  it('fps mais alto gera mais quadros, e isso é o custo de rede', () => {
    const lento = buildTimeline({ ...BASE, animationFps: 5 });
    const rapido = buildTimeline({ ...BASE, animationFps: 30 });

    expect(rapido.opening.frames.length).toBeGreaterThan(lento.opening.frames.length);
  });

  it('nenhuma animação nasce com menos de dois quadros', () => {
    // Duração mínima e fps mínimo: sem o piso, a conta daria um
    // quadro só e o painel saltaria em vez de animar.
    const curta = buildTimeline({
      ...BASE,
      openingMs: 100,
      closingMs: 100,
      transitionMs: 100,
      animationFps: 5,
    });

    expect(curta.opening.frames.length).toBeGreaterThanOrEqual(3);
    expect(curta.adEnter.frames.length).toBeGreaterThanOrEqual(3);
  });
});
