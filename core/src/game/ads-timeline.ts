// ============================================================
//  ads-timeline.ts  -  A ANIMACAO, QUADRO A QUADRO.
//
//  ####  O PLUGIN NAO SABE ANIMAR, E ISSO E DE PROPOSITO  ####
//
//  O CUI não tem keyframes, não tem transform e não tem rotação.
//  Toda animação é, literalmente, o servidor mandando o mesmo
//  elemento de novo com um RectTransform diferente.
//
//  Quem calcula esses retângulos é ESTE arquivo, pelo mesmo motivo
//  que a conversão de CUI mora no agente (ver ui-cui.ts): a
//  matemática erra fácil, o erro é invisível fora do jogo, e aqui
//  ela tem teste. Em C# não teria — não há servidor de Rust no CI.
//
//  O plugin recebe uma lista de quadros com `at` (milissegundo) e
//  o CUI já pronto, e faz uma coisa só: no instante `at`, manda o
//  que está no quadro. Ele é um TOCA-DISCOS.
//
//  ------------------------------------------------------------
//  ####  O QUE CADA ANIMACAO SIMULA, E COM O QUE  ####
//
//  pedido            o que existe             como
//  ----------------  -----------------------  ---------------------
//  girar como carta  nada                     largura -> 0, troca a
//                                             imagem, largura -> 1
//  máscara/clip      nada confiável           o painel CRESCE a
//                                             partir da direita, e
//                                             nada precisa ser
//                                             recortado
//  sombra            nada                     moldura de 1 px
//  blur de movimento nada                     -
//
//  ------------------------------------------------------------
//  ####  CADA QUADRO CUSTA UM REBUILD DE CANVAS NO CLIENTE  ####
//
//  Por isso os quadros só existem enquanto algo se MOVE: entre a
//  abertura e a troca, o painel fica parado e não sai nada.
//
//  E por isso NÃO existe animação contínua aqui. Houve uma — o
//  logo balançando a 5 fps — e ela foi removida depois de custar
//  FPS no cliente: no Unity, cada AddUi força um rebuild do canvas
//  do HUD, e cinco por segundo, para sempre, é caro. Transição
//  dura 600 ms e acaba; enfeite contínuo é um custo que não
//  termina nunca.
// ============================================================

import {
  AD_IMAGE_PLACEHOLDER,
  type FetchedImage,
} from './ads-images.js';
import { imagePlaceholder } from './ui-images.js';
import { cuiColor, type CuiElement } from './ui-cui.js';
import type { AdsAnchor, AdsFit, AdsLogoAnchor, AdsSettings } from '../types/ads.js';

/** A raiz do overlay. O plugin destrói tudo por este nome. */
export const ADS_ROOT = 'OrigemZAds';

export const ADS_LOGO = `${ADS_ROOT}.logo`;
export const ADS_PANEL = `${ADS_ROOT}.panel`;
export const ADS_INNER = `${ADS_PANEL}.inner`;
/** O que COMPRIME na troca de carta. */
export const ADS_SLOT = `${ADS_PANEL}.slot`;
export const ADS_IMG = `${ADS_PANEL}.img`;

/**
 * Lugares reservados que o plugin troca por propaganda.
 *
 * MUDAR QUALQUER UM EXIGE MUDAR O PLUGIN JUNTO. São textuais, e
 * não campos, pelo mesmo motivo do `{token}`: o valor muda a cada
 * propaganda e o quadro é montado uma vez só, aqui.
 */
export const AD_ANCHOR_MIN_PLACEHOLDER = '{adanchormin}';
export const AD_ANCHOR_MAX_PLACEHOLDER = '{adanchormax}';
export const AD_BACKGROUND_PLACEHOLDER = '{adbg}';

export interface AdsFrame {
  /** Milissegundos desde o começo da animação. */
  readonly at: number;
  /** Nomes a destruir ANTES de desenhar este quadro. */
  readonly destroy?: readonly string[];
  readonly cui: readonly CuiElement[];
}

export interface AdsAnimation {
  readonly durationMs: number;
  readonly frames: readonly AdsFrame[];
}

export interface AdsTimeline {
  /** O que é desenhado ao ligar o overlay para um jogador. */
  readonly root: readonly CuiElement[];
  /** Logo some, painel abre a partir da direita. */
  readonly opening: AdsAnimation;
  /** A propaganda entra: largura de 0 até cheia. */
  readonly adEnter: AdsAnimation;
  /** A propaganda sai: largura de cheia até quase 0. */
  readonly adExit: AdsAnimation;
  /** Painel recolhe, logo volta. */
  readonly closing: AdsAnimation;
}

// ------------------------------------------------------------
//  EASING
//
//  Os dois que o desenho precisa, e nada além. Curva a mais é
//  campo a mais na tela para uma diferença que ninguém enxerga em
//  600 ms.
// ------------------------------------------------------------

/** Rápido no começo, assentando no fim. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * O mesmo, com um empurrãozinho a mais no fim.
 *
 * É o "elástico muito discreto" do pedido: o painel passa ~2% do
 * tamanho final e volta. Mais que isso vira brinquedo, e o
 * elemento está no canto da tela de quem está jogando.
 */
function easeOutBack(t: number): number {
  const c = 1.15;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

/**
 * Quantos quadros cabem numa duração, no fps pedido.
 *
 * Mínimo de dois: um quadro só não é animação, é um salto — e o
 * estado final PRECISA ser enviado, senão o painel fica parado
 * onde a conta o deixou.
 */
function frameCount(durationMs: number, fps: number): number {
  return Math.max(2, Math.round((durationMs / 1000) * fps));
}

// ------------------------------------------------------------
//  GEOMETRIA
//
//  Tudo em pixels da base 1280x720 do CUI, ancorado no CANTO
//  escolhido. Um elemento com anchorMin == anchorMax tem tamanho
//  definido só pelos offsets — é o modo "colado no canto com
//  tamanho fixo", e é o que impede o widget de esticar junto com
//  a tela.
// ------------------------------------------------------------

interface Corner {
  /** A âncora, igual nos dois cantos. */
  readonly anchor: string;
  /** Sinal horizontal: -1 cresce para a esquerda. */
  readonly sx: number;
  /** Sinal vertical: -1 cresce para baixo. */
  readonly sy: number;
}

function cornerOf(anchor: AdsAnchor): Corner {
  switch (anchor) {
    case 'top-left':
      return { anchor: '0 1', sx: 1, sy: -1 };
    case 'bottom-right':
      return { anchor: '1 0', sx: -1, sy: 1 };
    case 'bottom-left':
      return { anchor: '0 0', sx: 1, sy: 1 };
    case 'top-right':
    default:
      return { anchor: '1 1', sx: -1, sy: -1 };
  }
}

function num(value: number): string {
  return Number.parseFloat(value.toFixed(3)).toString();
}

function vec(x: number, y: number): string {
  return `${num(x)} ${num(y)}`;
}

/**
 * Um retângulo colado no canto, com largura e altura em pixels.
 *
 * O `inset` desloca a partir do canto (as margens). Os sinais
 * vêm do canto escolhido — é o que faz o mesmo cálculo servir aos
 * quatro cantos sem quatro cópias.
 */
function cornerOffsets(
  corner: Corner,
  insetX: number,
  insetY: number,
  width: number,
  height: number,
): { offsetMin: string; offsetMax: string } {
  const x1 = corner.sx * insetX;
  const x2 = x1 + corner.sx * width;
  const y1 = corner.sy * insetY;
  const y2 = y1 + corner.sy * height;

  return {
    offsetMin: vec(Math.min(x1, x2), Math.min(y1, y2)),
    offsetMax: vec(Math.max(x1, x2), Math.max(y1, y2)),
  };
}

function rect(anchorMin: string, anchorMax: string, offsetMin: string, offsetMax: string) {
  return {
    type: 'RectTransform',
    anchormin: anchorMin,
    anchormax: anchorMax,
    offsetmin: offsetMin,
    offsetmax: offsetMax,
  } as const;
}

// ------------------------------------------------------------
//  A ÁRVORE FIXA
// ------------------------------------------------------------

/**
 * A raiz e o logo — o que existe quando nada está acontecendo.
 *
 * ####  A RAIZ NAO PEGA CLIQUE  ####
 *
 * Cor totalmente transparente e camada `Hud` por padrão. No
 * Unity, alfa 0 NÃO desliga o raycast — mas sem `NeedsCursor` o
 * cursor continua preso na mira, e sem cursor não há clique. É a
 * mesma lição que o modal do menu já custou uma vez (ver Draw no
 * OrigemZUI.cs).
 */
function buildRoot(settings: AdsSettings, logoKey: string | null): readonly CuiElement[] {
  const corner = cornerOf(settings.anchor);
  const areaWidth = Math.max(settings.panelWidth, settings.logoWidth);
  const areaHeight = Math.max(settings.panelHeight, settings.logoHeight);

  const area = cornerOffsets(
    corner,
    settings.marginRight,
    settings.marginTop,
    areaWidth,
    areaHeight,
  );

  const elements: CuiElement[] = [
    {
      name: ADS_ROOT,
      parent: settings.layer,
      destroyUi: ADS_ROOT,
      components: [
        { type: 'UnityEngine.UI.Image', color: '0 0 0 0' },
        rect(corner.anchor, corner.anchor, area.offsetMin, area.offsetMax),
      ],
    },
  ];

  if (settings.logoEnabled && settings.logoImageUrl !== null) {
    elements.push(logoElement(settings, logoKey));
  }

  return elements;
}

/**
 * O logo, parado.
 *
 * ####  ELE JA BALANCOU, E O BALANCO FOI REMOVIDO  ####
 *
 * Havia um movimento contínuo aqui — sobe, desce e respira na
 * escala, a 5 quadros por segundo. MEDIDO no servidor real, ele
 * custava FPS no cliente: no Unity, cada AddUi força um rebuild
 * do canvas do HUD, e cinco por segundo, para sempre, é caro
 * demais por um movimento de dois pixels.
 *
 * O `create` distingue o primeiro desenho (que cria o elemento,
 * com fade) de um eventual reenvio.
 */
function logoElement(
  settings: AdsSettings,
  /**
   * A chave do logo no FileStorage, quando o agente conseguiu
   * baixá-lo.
   *
   * ####  O LOGO SEGUE O MESMO MODO DAS PROPAGANDAS  ####
   *
   * Deixá-lo sempre em `url` seria uma inconsistência cara: num
   * servidor onde o cliente não consegue baixar de fora (que é
   * justamente por que o modo `stored` existe), as propagandas
   * apareceriam e o logo — o que fica na tela o tempo todo —
   * não.
   *
   * `null` = cai para `url`, que é o que acontece quando o
   * download do logo falhou.
   */
  logoKey: string | null = null,
  create = true,
): CuiElement {
  const corner = cornerOf(settings.anchor);

  const width = settings.logoWidth;
  const height = settings.logoHeight;

  const offsets = settings.logoDetached
    ? detachedOffsets(settings, width, height)
    : cornerOffsets(corner, 0, 0, width, height);

  const alpha = clamp01(settings.logoOpacity);

  const image: Record<string, unknown> = {
    type: 'UnityEngine.UI.RawImage',
    color: `1 1 1 ${num(alpha)}`,
    // `{img:chave}` é o mesmo lugar reservado das imagens do
    // menu: o plugin já sabe trocá-lo pelo CRC do FileStorage.
    ...(logoKey === null
      ? { url: settings.logoImageUrl ?? '' }
      : { png: imagePlaceholder(logoKey) }),
  };

  if (create) {
    // O fade só na criação: num reenvio ele faria o logo renascer
    // na cara de quem já estava olhando para ele.
    image.fadeIn = 0.35;
  }

  // ####  SOLTO, ELE SAI DE DENTRO DO PAINEL  ####
  //
  // A raiz é o retângulo do PAINEL, no canto. Um logo no alto e
  // ao centro não cabe ali — ficaria recortado pelo pai, ou
  // preso a ele. Solto, ele é pendurado direto na camada do jogo
  // e tem a tela inteira como referência.
  //
  // O NOME não muda, e isso importa: os quadros da animação
  // (balanço, abertura, fechamento) o procuram por ele, e mudá-lo
  // faria a animação parar de encontrá-lo — em silêncio.
  const anchor = settings.logoDetached ? logoAnchorOf(settings.logoAnchor) : corner.anchor;

  return {
    name: ADS_LOGO,
    // ####  A CAMADA DO LOGO PODE NAO SER A DO PAINEL  ####
    //
    // Com lugar próprio, o logo é pendurado direto numa camada do
    // jogo — e `logoLayer` deixa escolher QUAL. É o que permite a
    // marca do servidor ficar sempre na tela enquanto a propaganda
    // aparece só com o inventário aberto (`Hud.Menu`).
    //
    // `null` herda a do painel, que é o que sempre aconteceu.
    // Preso ao painel, o logo é filho dele e a camada não se
    // aplica.
    parent: settings.logoDetached ? (settings.logoLayer ?? settings.layer) : ADS_ROOT,
    ...(create ? {} : { update: true }),
    components: [
      image as CuiElement['components'][number],
      rect(anchor, anchor, offsets.offsetMin, offsets.offsetMax),
    ],
  };
}

/** `top-center` -> a âncora normalizada `"0.5 1"`. */
function logoAnchorOf(anchor: AdsLogoAnchor): string {
  const [vertical = 'top', horizontal = 'center'] = anchor.split('-');

  const x = horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : 0.5;
  const y = vertical === 'bottom' ? 0 : vertical === 'top' ? 1 : 0.5;

  return vec(x, y);
}

/**
 * O retângulo do logo SOLTO, em qualquer um dos nove pontos.
 *
 * ####  NO CENTRO, MARGEM VIRA DESLOCAMENTO  ####
 *
 * Num canto, "24" é a distância até a borda: o elemento cresce
 * para dentro da tela. No meio de um eixo não há borda de onde
 * medir, e o mesmo número passa a significar "24 px para o lado"
 * — inclusive negativo, que ali é um pedido legítimo.
 *
 * Tratar os dois casos com a mesma conta poria o logo centralizado
 * 24 px fora do lugar sem ninguém entender por quê.
 */
function detachedOffsets(
  settings: AdsSettings,
  width: number,
  height: number,
): { offsetMin: string; offsetMax: string } {
  const [vertical = 'top', horizontal = 'center'] = settings.logoAnchor.split('-');

  const axis = (
    side: string,
    margin: number,
    size: number,
    lowSide: string,
  ): { min: number; max: number } => {
    if (side === 'center') {
      return { min: margin - size / 2, max: margin + size / 2 };
    }

    // `lowSide` é a ponta em que a âncora vale 0 (esquerda/baixo):
    // ali o elemento cresce no sentido positivo.
    return side === lowSide
      ? { min: margin, max: margin + size }
      : { min: -(margin + size), max: -margin };
  };

  const x = axis(horizontal, settings.logoMarginX, width, 'left');
  const y = axis(vertical, settings.logoMarginY, height, 'bottom');

  return {
    offsetMin: vec(x.min, y.min),
    offsetMax: vec(x.max, y.max),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * O painel num instante da abertura.
 *
 * `t` de 0 (fechado) a 1 (aberto). Ele cresce a partir do canto
 * escolhido, com a borda oposta parada — é isso que dá a leitura
 * de "barra sendo revelada" em vez de "caixa aparecendo".
 */
function panelElements(settings: AdsSettings, t: number, create: boolean): readonly CuiElement[] {
  const corner = cornerOf(settings.anchor);
  const width = Math.max(1, settings.panelWidth * t);

  const offsets = cornerOffsets(corner, 0, 0, width, settings.panelHeight);
  const border = settings.panelBorderEnabled ? 1 : 0;

  const elements: CuiElement[] = [
    {
      name: ADS_PANEL,
      parent: ADS_ROOT,
      ...(create ? {} : { update: true }),
      components: [
        {
          type: 'UnityEngine.UI.Image',
          color: cuiColor(
            settings.panelBorderEnabled ? settings.panelBorderColor : settings.panelColor,
          ),
          ...(create ? { fadeIn: 0.15 } : {}),
        },
        rect(corner.anchor, corner.anchor, offsets.offsetMin, offsets.offsetMax),
      ],
    },
  ];

  // A moldura é DOIS painéis: um na cor da borda e outro 1 px
  // menor por cima. O CUI não tem borda em elemento — é o mesmo
  // truque do preset do menu.
  if (create) {
    elements.push({
      name: ADS_INNER,
      parent: ADS_PANEL,
      components: [
        {
          type: 'UnityEngine.UI.Image',
          color: cuiColor(settings.panelColor),
        },
        rect('0 0', '1 1', vec(border, border), vec(-border, -border)),
      ],
    });
  }

  return elements;
}

/**
 * O slot e a imagem, com a largura em `t`.
 *
 * ####  E AQUI QUE A CARTA GIRA  ####
 *
 * O slot é ancorado no CENTRO horizontal (0.5 ± t/2), então
 * reduzir `t` o comprime para o meio e aumentá-lo o abre a partir
 * do meio. A imagem, ancorada 0..1 dentro dele, acompanha — e é
 * essa compressão que o olho lê como uma carta virando no eixo
 * vertical.
 *
 * A imagem, a cor de fundo e as âncoras do enquadramento entram
 * como LUGARES RESERVADOS: o quadro é montado uma vez e serve a
 * todas as propagandas, e é o plugin que troca os três na hora de
 * desenhar.
 */
function slotElements(
  t: number,
  create: boolean,
  /**
   * Decide o CAMPO da imagem, e não o valor.
   *
   * `png` recebe um número do FileStorage e `url` um endereço —
   * são componentes com contratos diferentes, e mandar o campo
   * errado faz o cliente desenhar um quadrado vazio SEM erro
   * nenhum. Como o modo é global, ele já é resolvido aqui, na
   * montagem do quadro.
   */
  imageMode: 'stored' | 'url' = 'stored',
): readonly CuiElement[] {
  const half = Math.max(0.002, t / 2);

  const slot: CuiElement = {
    name: ADS_SLOT,
    parent: ADS_INNER,
    ...(create ? {} : { update: true }),
    components: [
      {
        type: 'UnityEngine.UI.Image',
        color: AD_BACKGROUND_PLACEHOLDER,
      },
      rect(vec(0.5 - half, 0), vec(0.5 + half, 1), '0 0', '0 0'),
    ],
  };

  if (!create) {
    return [slot];
  }

  return [
    slot,
    {
      name: ADS_IMG,
      parent: ADS_SLOT,
      components: [
        {
          type: 'UnityEngine.UI.RawImage',
          color: '1 1 1 1',
          ...(imageMode === 'url'
            ? { url: AD_IMAGE_PLACEHOLDER }
            : { png: AD_IMAGE_PLACEHOLDER }),
        },
        rect(AD_ANCHOR_MIN_PLACEHOLDER, AD_ANCHOR_MAX_PLACEHOLDER, '0 0', '0 0'),
      ],
    },
  ];
}

// ------------------------------------------------------------
//  AS ANIMAÇÕES
// ------------------------------------------------------------

/**
 * Monta a linha do tempo inteira a partir do ajuste.
 *
 * Função PURA: mesmo ajuste, mesmos quadros. É o que permite o
 * teste comparar números em vez de abrir o jogo, e é o que
 * permite o painel gerar o preview com o mesmo código.
 */
export function buildTimeline(
  settings: AdsSettings,
  /** A chave do logo no FileStorage — ver `logoElement`. */
  logoKey: string | null = null,
): AdsTimeline {
  return {
    root: buildRoot(settings, logoKey),
    opening: buildOpening(settings),
    adEnter: buildAdEnter(settings),
    adExit: buildAdExit(settings),
    closing: buildClosing(settings, logoKey),
  };
}

/**
 * O logo sai, o painel entra.
 *
 * O logo não some de uma vez: ele encolhe e some junto com o
 * começo da abertura, para os dois movimentos parecerem UM. Uma
 * troca dura (destruir e criar) leria como um pisco.
 */
function buildOpening(settings: AdsSettings): AdsAnimation {
  const durationMs = settings.openingMs;
  const total = frameCount(durationMs, settings.animationFps);
  const frames: AdsFrame[] = [];

  // ####  O LOGO SO SAI SE ELE FOR O PAINEL RECOLHIDO  ####
  //
  // No lugar padrão eles ocupam o MESMO canto: o painel abrindo
  // por cima do logo seria dois desenhos empilhados, e por isso o
  // logo sai (com fadeOut, que o CUI aplica ao destruir).
  //
  // Com lugar próprio, são duas coisas independentes — o logo no
  // alto e ao centro, o painel no canto. Fazê-lo sumir ali seria
  // apagar da tela algo que não tem nada a ver com o que está
  // acontecendo.
  frames.push({
    at: 0,
    ...(settings.logoDetached ? {} : { destroy: [ADS_LOGO] }),
    cui: panelElements(settings, 0.001, true),
  });

  for (let index = 1; index <= total; index += 1) {
    const t = index / total;
    frames.push({
      at: Math.round((durationMs * index) / total),
      cui: panelElements(settings, easeOutBack(t), false),
    });
  }

  return { durationMs, frames };
}

/**
 * A propaganda entra como carta.
 *
 * O primeiro quadro CRIA o slot e a imagem já comprimidos; os
 * seguintes só abrem a largura. Criar e abrir no mesmo quadro
 * faria a imagem aparecer inteira por um instante antes de
 * comprimir — o contrário do efeito.
 */
function buildAdEnter(settings: AdsSettings): AdsAnimation {
  const durationMs = settings.transitionMs;
  const total = frameCount(durationMs, settings.animationFps);
  const frames: AdsFrame[] = [];

  frames.push({
    at: 0,
    destroy: [ADS_SLOT],
    cui: slotElements(0.004, true, settings.imageMode),
  });

  for (let index = 1; index <= total; index += 1) {
    frames.push({
      at: Math.round((durationMs * index) / total),
      cui: slotElements(easeOutCubic(index / total), false, settings.imageMode),
    });
  }

  return { durationMs, frames };
}

/**
 * A propaganda sai comprimindo.
 *
 * Não vai a zero: um retângulo de largura zero some do cliente e
 * o quadro seguinte teria de recriá-lo. Parar em ~0,4% mantém o
 * elemento vivo e é indistinguível de zero na tela.
 */
function buildAdExit(settings: AdsSettings): AdsAnimation {
  const durationMs = settings.transitionMs;
  const total = frameCount(durationMs, settings.animationFps);
  const frames: AdsFrame[] = [];

  for (let index = 0; index <= total; index += 1) {
    const t = index / total;
    frames.push({
      at: Math.round((durationMs * index) / total),
      cui: slotElements(Math.max(0.004, 1 - easeOutCubic(t)), false, settings.imageMode),
    });
  }

  return { durationMs, frames };
}

/**
 * O painel recolhe e o logo volta.
 *
 * O logo é recriado no ÚLTIMO quadro, e não no primeiro: durante
 * o recolhimento ele apareceria por baixo do painel que ainda
 * está encolhendo, e os dois se sobreporiam por meio segundo.
 */
function buildClosing(settings: AdsSettings, logoKey: string | null): AdsAnimation {
  const durationMs = settings.closingMs;
  const total = frameCount(durationMs, settings.animationFps);
  const frames: AdsFrame[] = [];

  for (let index = 0; index <= total; index += 1) {
    const t = index / total;
    frames.push({
      at: Math.round((durationMs * index) / total),
      cui: panelElements(settings, Math.max(0.002, 1 - easeOutCubic(t)), false),
    });
  }

  // Ele só VOLTA se tiver saído. Com lugar próprio o logo nunca
  // saiu — recriá-lo aqui seria desenhar por cima de um elemento
  // que já está na tela, e o cliente rebaixaria a textura à toa.
  const back: CuiElement[] =
    !settings.logoDetached && settings.logoEnabled && settings.logoImageUrl !== null
      ? [logoElement(settings, logoKey)]
      : [];

  frames.push({ at: durationMs, destroy: [ADS_PANEL], cui: back });

  return { durationMs, frames };
}

// ------------------------------------------------------------
//  O ENQUADRAMENTO DA IMAGEM
// ------------------------------------------------------------

/**
 * As âncoras da imagem dentro do slot, conforme o enquadramento.
 *
 * ####  ANCORA, E NAO OFFSET EM PIXELS  ####
 *
 * A imagem precisa COMPRIMIR junto com o slot. Com offsets em
 * pixels, ela manteria o tamanho enquanto o slot encolhe e
 * vazaria para fora dele — e, sem máscara no CUI, o que vaza
 * aparece por cima do resto da tela.
 *
 * Com âncora normalizada, ela é sempre uma fração do slot: encolhe
 * junto, e nada escapa.
 *
 * `cover` PREENCHE sem recortar, porque recortar exigiria a
 * máscara que não temos — uma imagem de proporção muito diferente
 * do painel sai esticada, e é por isso que a tela avisa a
 * proporção recomendada.
 */
export function imageAnchors(
  fit: AdsFit,
  panelWidth: number,
  panelHeight: number,
  image: { readonly width: number | null; readonly height: number | null },
): { readonly min: string; readonly max: string } {
  const full = { min: '0 0', max: '1 1' };

  if (fit === 'cover' || image.width === null || image.height === null) {
    return full;
  }

  if (image.width <= 0 || image.height <= 0 || panelWidth <= 0 || panelHeight <= 0) {
    return full;
  }

  const panelRatio = panelWidth / panelHeight;
  const imageRatio = image.width / image.height;

  if (Math.abs(panelRatio - imageRatio) < 0.005) {
    return full;
  }

  if (imageRatio > panelRatio) {
    // Mais larga que o painel: sobra em cima e embaixo.
    const height = panelRatio / imageRatio;
    const margin = (1 - height) / 2;
    return { min: vec(0, margin), max: vec(1, 1 - margin) };
  }

  // Mais alta: sobra dos lados.
  const width = imageRatio / panelRatio;
  const margin = (1 - width) / 2;
  return { min: vec(margin, 0), max: vec(1 - margin, 1) };
}

/** Cor de fundo da propaganda -> o formato do CUI. */
export function adBackground(hex: string): string {
  return cuiColor(hex);
}

/** Só para o teste e para o preview: a imagem que o cache produziu. */
export type { FetchedImage };
