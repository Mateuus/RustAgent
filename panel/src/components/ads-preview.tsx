'use client';

// ============================================================
//  A PRE-VISUALIZACAO DO OVERLAY.
//
//  ####  ELA TOCA OS QUADROS DO JOGO, E NAO UMA IMITACAO  ####
//
//  O agente manda os mesmos quadros que descem ao servidor de
//  Rust, e este componente os APLICA — na ordem, nos mesmos
//  milissegundos, com a mesma geometria. Não há uma segunda
//  implementação da animação aqui.
//
//  É a regra do preview do editor de interfaces, e pelo mesmo
//  motivo: duas renderizações divergem no primeiro campo que uma
//  trata e a outra não, e a divergência aparece DENTRO DO JOGO,
//  que é o pior lugar para descobrir.
//
//  ------------------------------------------------------------
//  ####  O QUE ESTE ARQUIVO PRECISA SABER DE CUI  ####
//
//  Só três coisas, e todas de leitura:
//
//    - a geometria (âncora normalizada + offset em pixels, com o
//      eixo Y crescendo para CIMA, ao contrário do CSS);
//    - a cor ("R G B A" com floats de 0 a 1);
//    - de onde vem a imagem (`url` ou `png`).
//
//  `update: true` MESCLA no elemento existente; sem ele, cria ou
//  substitui. `destroy` remove o elemento e os filhos dele. É
//  exatamente o que o cliente do Rust faz.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Advertisement, AdsFrame, AdsSettings, AdsTimeline } from '@/lib/api';
import { cn } from '@/lib/utils';

/** A base em que o CUI mede tudo. Ver Docs/OrigemZUI/PLANO.md §3. */
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;

interface Rect {
  readonly anchorMin: readonly [number, number];
  readonly anchorMax: readonly [number, number];
  readonly offsetMin: readonly [number, number];
  readonly offsetMax: readonly [number, number];
}

interface Element {
  readonly name: string;
  readonly parent: string;
  readonly rect: Rect;
  readonly color: string;
  readonly image: string | null;
  /** Ordem de criação: no CUI, a lista é a profundidade. */
  readonly order: number;
}

const DEFAULT_RECT: Rect = {
  anchorMin: [0, 0],
  anchorMax: [1, 1],
  offsetMin: [0, 0],
  offsetMax: [0, 0],
};

function pair(value: unknown, fallback: readonly [number, number]): readonly [number, number] {
  if (typeof value !== 'string') return fallback;

  const parts = value.trim().split(/\s+/);
  const x = Number(parts[0]);
  const y = Number(parts[1]);

  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : fallback;
}

/** `"R G B A"` com floats -> `rgba()` do CSS. */
function cssColor(value: unknown): string {
  if (typeof value !== 'string') return 'transparent';

  const parts = value.trim().split(/\s+/).map(Number);

  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return 'transparent';
  }

  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return `rgba(${String(Math.round(r * 255))}, ${String(Math.round(g * 255))}, ${String(
    Math.round(b * 255),
  )}, ${String(a)})`;
}

/**
 * Aplica um quadro ao estado dos elementos.
 *
 * Puro: recebe o mapa e devolve outro. É o que permite o React
 * redesenhar sem o motor precisar saber que existe React.
 */
/**
 * Exportada para o TESTE, e nao porque alguem de fora a use.
 *
 * O defeito que ela ja teve nao aparecia em nenhuma chamada de API
 * nem em nenhum tipo: dependia da FORMA de um quadro. Um teste que
 * a chama direto e o unico lugar onde isso e barato de guardar.
 */
export function applyFrame(
  current: ReadonlyMap<string, Element>,
  // ####  O TIPO DO CONTRATO, E NAO UMA COPIA LOCAL  ####
  //
  // `AdsFrame` traz `destroy` e `cui` OPCIONAIS porque o agente
  // realmente os omite quando estao vazios — sao bytes que nao
  // precisam atravessar o RCON, e o plugin ja trata isso
  // (`destroy != null`, em OrigemZUI.cs).
  //
  // Havia aqui uma copia local que os declarava obrigatorios, e
  // ela mentia: iterar um `undefined` derrubava a ARVORE INTEIRA
  // do React — a tela virava "This page couldn't load" e o motivo
  // ficava so no console. Duas declaracoes do mesmo dado divergem;
  // esta passou a ser uma so.
  frame: AdsFrame,
  counter: { value: number },
): Map<string, Element> {
  const next = new Map(current);

  for (const name of frame.destroy ?? []) {
    // Destruir leva os FILHOS junto — é o que o CUI faz, e é a
    // razão de o slot ser recriado antes do conteúdo no jogo.
    for (const key of [...next.keys()]) {
      if (key === name || key.startsWith(`${name}.`)) {
        next.delete(key);
      }
    }
  }

  for (const raw of frame.cui ?? []) {
    const name = typeof raw.name === 'string' ? raw.name : null;
    if (name === null) continue;

    const components = Array.isArray(raw.components) ? raw.components : [];
    const previous = next.get(name);
    const isUpdate = raw.update === true && previous !== undefined;

    let rect = isUpdate ? previous.rect : DEFAULT_RECT;
    let color = isUpdate ? previous.color : 'transparent';
    let image = isUpdate ? previous.image : null;

    for (const componentRaw of components) {
      if (typeof componentRaw !== 'object' || componentRaw === null) continue;
      const component = componentRaw as Record<string, unknown>;

      if (component.type === 'RectTransform') {
        rect = {
          anchorMin: pair(component.anchormin, rect.anchorMin),
          anchorMax: pair(component.anchormax, rect.anchorMax),
          offsetMin: pair(component.offsetmin, rect.offsetMin),
          offsetMax: pair(component.offsetmax, rect.offsetMax),
        };
        continue;
      }

      if (typeof component.color === 'string') {
        color = cssColor(component.color);
      }

      if (typeof component.url === 'string') {
        image = component.url;
      } else if (typeof component.png === 'string') {
        // No jogo isto vira um CRC do FileStorage. Aqui não há
        // FileStorage — quem resolve o endereço é `resolveImage`,
        // que sabe qual URL originou aquela chave.
        image = component.png;
      }
    }

    next.set(name, {
      name,
      parent: typeof raw.parent === 'string' ? raw.parent : '',
      rect,
      color,
      image,
      order: previous?.order ?? counter.value++,
    });
  }

  return next;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Retângulo do CUI -> caixa em pixels de tela.
 *
 * ####  O EIXO Y E INVERTIDO  ####
 *
 * No Unity, Y cresce para CIMA; em CSS, `top` cresce para baixo.
 * Errar isso espelha o layout inteiro na vertical — e como
 * layouts costumam ser simétricos, o erro passa despercebido até
 * alguém ancorar algo embaixo.
 */
function resolve(rect: Rect, parent: Box): Box {
  const left = parent.left + rect.anchorMin[0] * parent.width + rect.offsetMin[0];
  const right = parent.left + rect.anchorMax[0] * parent.width + rect.offsetMax[0];

  const bottom = rect.anchorMin[1] * parent.height + rect.offsetMin[1];
  const top = rect.anchorMax[1] * parent.height + rect.offsetMax[1];

  return {
    left,
    top: parent.top + (parent.height - top),
    width: Math.max(0, right - left),
    height: Math.max(0, top - bottom),
  };
}

// ------------------------------------------------------------
//  O ROTEIRO
// ------------------------------------------------------------

export type PreviewScene =
  | 'idle'
  | 'cycle'
  | 'opening'
  | 'swap'
  | 'closing'
  | 'single'
  /**
   * O painel ABERTO E PARADO, sem tocar nada.
   *
   * ####  ELA EXISTE PARA ENCAIXAR A POSICAO  ####
   *
   * As outras cenas TOCAM e voltam ao repouso: para ajustar uma
   * margem era preciso clicar, olhar depressa e clicar de novo.
   * Esta desenha o estado final e fica, e e nela que se arrasta o
   * painel ate o lugar certo.
   *
   * E, nao por acaso, e exatamente o que o modo estatico desenha
   * no jogo: o ultimo quadro da abertura mais o da entrada da
   * propaganda. Ver AdsDrawStatic, em Plugins/OrigemZUI.cs.
   */
  | 'parado';

/**
 * Quanto tempo a cena "parado" fica parada. Uma hora.
 *
 * Nao ha "para sempre" num `setTimeout`, e um numero enorme
 * transborda para 1ms em alguns navegadores. Uma hora e mais do
 * que qualquer sessao de ajuste de margem, e ao fim dela a previa
 * so volta ao repouso — nada quebra.
 */
const PARADO_MS = 3_600_000;

/**
 * Os nomes que o agente da a raiz e ao logo.
 *
 * ####  ELES SAO CONTRATO, E QUEBRAM EM SILENCIO  ####
 *
 * `ADS_ROOT` e `ADS_LOGO` em core/src/game/ads-timeline.ts, e o
 * `AdsRoot`/`AdsLogoName` do plugin. Se um deles mudar de nome, o
 * arrasto simplesmente para de aparecer — nao ha erro nenhum.
 */
const ROOT_NAME = 'OrigemZAds';
const LOGO_NAME = 'OrigemZAds.logo';

/**
 * Para que lado cada margem cresce, por canto do PAINEL.
 *
 * ####  A MESMA TABELA DO AGENTE, E ELA PRECISA CONTINUAR SENDO  ####
 *
 * `cornerOf`, em core/src/game/ads-timeline.ts, tem estes mesmos
 * sinais. `x: 1` = a margem mede a partir da ESQUERDA, entao
 * arrastar para a direita a aumenta; `x: -1` = ela mede da direita
 * e arrastar para a direita a diminui.
 *
 * O eixo Y e invertido de proposito: no CSS `dy` cresce para
 * baixo, e `marginTop` num canto de baixo mede a distancia ate o
 * FUNDO. Por isso o `-` na conta, e nao aqui.
 */
const MARGIN_SIGNS: Record<string, { readonly x: number; readonly y: number }> = {
  'top-left': { x: 1, y: -1 },
  'top-right': { x: -1, y: -1 },
  'bottom-left': { x: 1, y: 1 },
  'bottom-right': { x: -1, y: 1 },
};

/**
 * O mesmo, para o LOGO solto — que tem nove pontos, e nao quatro.
 *
 * Espelha `detachedOffsets` do agente. No centro o numero e
 * deslocamento livre e cresce como a borda de baixo/esquerda:
 * para a direita e para cima.
 */
function logoSigns(anchor: string): { readonly x: number; readonly y: number } {
  const [vertical = 'top', horizontal = 'center'] = anchor.split('-');

  return {
    x: horizontal === 'right' ? -1 : 1,
    y: vertical === 'top' ? -1 : 1,
  };
}

/**
 * Os tetos, copiados do schema do agente.
 *
 * `adsSettingsSchema`, em core/src/types/ads.ts, recusa fora
 * disto. Arrastar alem do limite gravaria um ajuste que o agente
 * devolve 400 — e o erro apareceria depois, num toast, sem
 * ligacao com o arrasto que o causou.
 */
const MARGIN_LIMIT = 400;
const LOGO_LIMIT_X = 640;
const LOGO_LIMIT_Y = 360;

/** Nao deixa o arrasto jogar o elemento para fora do mundo. */
function clampMargin(value: number, limit: number): number {
  return Math.round(Math.min(limit, Math.max(-limit, value)));
}

/**
 * Arrasto do PAINEL -> as margens novas.
 *
 * ####  ISTO E UMA FUNCAO PURA PORQUE O SINAL ERRA CALADO  ####
 *
 * Um sinal trocado nao quebra nada: o painel so anda para o lado
 * contrario do dedo. Quem esta ajustando acha que errou a mao,
 * corrige na direcao errada, e o defeito vira "essa tela e
 * estranha". Um teste por canto e o que separa isso de uma
 * suspeita.
 *
 * `dx`/`dy` vem em pixels da BASE 1280x720, ja convertidos pela
 * alca. `dy` cresce para baixo (CSS), e por isso ele entra
 * subtraindo: num canto de baixo, `marginTop` mede ate o FUNDO.
 */
export function panPanel(
  settings: Pick<AdsSettings, 'anchor' | 'marginRight' | 'marginTop'>,
  dx: number,
  dy: number,
): { marginRight: number; marginTop: number } {
  const sinal = MARGIN_SIGNS[settings.anchor] ?? { x: 1, y: 1 };

  return {
    marginRight: clampMargin(settings.marginRight + sinal.x * dx, MARGIN_LIMIT),
    marginTop: clampMargin(settings.marginTop - sinal.y * dy, MARGIN_LIMIT),
  };
}

/** O mesmo, para o LOGO solto. Ver `logoSigns`. */
export function panLogo(
  settings: Pick<AdsSettings, 'logoAnchor' | 'logoMarginX' | 'logoMarginY'>,
  dx: number,
  dy: number,
): { logoMarginX: number; logoMarginY: number } {
  const sinal = logoSigns(settings.logoAnchor);

  return {
    logoMarginX: clampMargin(settings.logoMarginX + sinal.x * dx, LOGO_LIMIT_X),
    logoMarginY: clampMargin(settings.logoMarginY - sinal.y * dy, LOGO_LIMIT_Y),
  };
}

interface Step {
  readonly frames: readonly AdsFrame[];
  /** Qual propaganda substitui os lugares reservados. */
  readonly ad: Advertisement | null;
  /** Pausa DEPOIS do último quadro. */
  readonly holdMs: number;
}

interface AdsPreviewProps {
  readonly settings: AdsSettings;
  readonly timeline: AdsTimeline;
  readonly ads: readonly Advertisement[];
  readonly scene: PreviewScene;
  /** Para a cena `single` e para o começo do ciclo. */
  readonly selected: Advertisement | null;
  /** Avisa quando o roteiro termina, para a tela soltar o botão. */
  readonly onFinished?: () => void;

  /**
   * Arrastar o painel (ou o logo) DENTRO da previa.
   *
   * ####  POR QUE ISTO NAO E ENFEITE  ####
   *
   * Encaixar uma margem digitando numero e um laco de tentativa e
   * erro: escreve 220, olha, apaga, escreve 180. Arrastar fecha o
   * laco — a pessoa ve onde esta pondo enquanto poe.
   *
   * O que sai daqui e um pedaco de ajuste ja no sentido certo de
   * cada canto (ver `MARGIN_SIGNS`), e nao um delta cru: quem
   * conhece a geometria e este arquivo, e traduzir isso na pagina
   * espalharia a regra por dois lugares.
   *
   * Ausente = a previa nao arrasta. E o caso da aba do logo
   * enquanto ele estiver preso ao painel.
   */
  readonly onMove?: (patch: Partial<AdsSettings>) => void;
}

export function AdsPreview({
  settings,
  timeline,
  ads,
  scene,
  selected,
  onFinished,
  onMove,
}: AdsPreviewProps) {
  const [elements, setElements] = useState<ReadonlyMap<string, Element>>(new Map());
  /** Qual propaganda está no ar neste instante do roteiro. */
  const [currentAd, setCurrentAd] = useState<Advertisement | null>(null);
  const counter = useRef({ value: 0 });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /** As propagandas que o ciclo mostraria, na ordem. */
  const queue = useMemo(() => {
    const playable = ads.filter((ad) => ad.enabled && ad.inSchedule);

    if (playable.length === 0) return [];

    const limit = settings.adsPerCycle > 0 ? settings.adsPerCycle : playable.length;
    return playable.slice(0, Math.min(limit, playable.length));
  }, [ads, settings.adsPerCycle]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  /**
   * O roteiro da cena escolhida.
   *
   * Ele é uma LISTA de passos, e não uma cadeia de callbacks: o
   * botão "testar troca" precisa tocar dois passos e parar, e uma
   * cadeia teria de saber onde interromper.
   */
  const script = useMemo((): readonly Step[] => {
    const enter = (ad: Advertisement | null, hold: number): Step => ({
      frames: timeline.adEnter.frames,
      ad,
      holdMs: hold,
    });

    const exit = (ad: Advertisement | null): Step => ({
      frames: timeline.adExit.frames,
      ad,
      holdMs: 0,
    });

    const first = selected ?? queue[0] ?? null;

    switch (scene) {
      case 'opening':
        return [{ frames: timeline.opening.frames, ad: null, holdMs: 600 }];

      case 'closing':
        return [
          { frames: timeline.opening.frames, ad: null, holdMs: 200 },
          enter(first, 500),
          { frames: timeline.closing.frames, ad: null, holdMs: 0 },
        ];

      case 'swap':
        return [
          { frames: timeline.opening.frames, ad: null, holdMs: 200 },
          enter(first, 900),
          exit(first),
          enter(queue[1] ?? first, 900),
        ];

      case 'single':
        return first === null
          ? []
          : [
              { frames: timeline.opening.frames, ad: null, holdMs: 100 },
              enter(first, 4000),
              { frames: timeline.closing.frames, ad: null, holdMs: 0 },
            ];

      case 'cycle': {
        if (queue.length === 0) return [];

        const steps: Step[] = [{ frames: timeline.opening.frames, ad: null, holdMs: 150 }];

        for (const ad of queue) {
          const seconds = ad.displayDuration ?? settings.defaultDisplayDuration;
          steps.push(enter(ad, seconds * 1000));
          steps.push(exit(ad));
        }

        steps.push({ frames: timeline.closing.frames, ad: null, holdMs: 0 });
        return steps;
      }

      case 'parado': {
        // So o ULTIMO quadro de cada animacao, com `at` zerado: o
        // estado final, sem os quadros do meio. O mesmo atalho que
        // o plugin usa (AdsApplyLastFrame).
        const ultimo = (frames: readonly AdsFrame[]): readonly AdsFrame[] =>
          frames.length === 0 ? [] : [{ ...frames[frames.length - 1]!, at: 0 }];

        return [
          { frames: ultimo(timeline.opening.frames), ad: null, holdMs: 0 },
          { frames: ultimo(timeline.adEnter.frames), ad: first, holdMs: PARADO_MS },
        ];
      }

      case 'idle':
      default:
        return [];
    }
  }, [scene, timeline, queue, selected, settings.defaultDisplayDuration]);

  /**
   * O endereço real da imagem.
   *
   * Os quadros carregam lugares reservados (`{adimage}`) ou uma
   * chave do FileStorage (`ad<sha>`), e nenhum dos dois é uma URL
   * que o navegador saiba buscar. Este mapa desfaz isso —
   * inclusive para o logo, que segue o mesmo caminho.
   */
  const resolveImage = useCallback(
    (raw: string | null, ad: Advertisement | null): string | null => {
      if (raw === null || raw === '') return null;

      if (raw.startsWith('{img:') || raw.startsWith('ad')) {
        // Chave do FileStorage: pode ser o logo ou uma propaganda.
        if (ad !== null && (raw === ad.imageKey || raw.includes(ad.imageKey ?? ' '))) {
          return ad.imageUrl;
        }
        return settings.logoImageUrl;
      }

      if (raw.includes('{adimage}')) {
        return ad?.imageUrl ?? null;
      }

      return raw;
    },
    [settings.logoImageUrl],
  );

  // ----------------------------------------------------------
  //  O MOTOR
  // ----------------------------------------------------------
  useEffect(() => {
    clearTimers();
    counter.current = { value: 0 };

    // A raiz e o logo, sempre. É o estado de repouso.
    let state = applyFrame(
      new Map<string, Element>(),
      // Quadro sintetico: o estado de repouso nao vem do agente,
      // e montado aqui a partir da raiz. O `at` e zero porque ele
      // nao espera nada.
      { at: 0, destroy: [], cui: timeline.root },
      counter.current,
    );

    setElements(state);

    const schedule = (delay: number, run: () => void): void => {
      timers.current.push(setTimeout(run, delay));
    };

    // O logo em repouso já foi desenhado acima (ele vem em
    // `timeline.root`). Não há animação contínua nenhuma: o
    // balanço existiu e foi removido por custar FPS no cliente.
    if (script.length === 0) {
      return clearTimers;
    }

    // Um passo por vez, com o relógio do próprio quadro. É o
    // mesmo desenho do plugin: um timer vivo de cada vez, e não
    // quinze agendados que ninguém consegue cancelar.
    const playStep = (stepIndex: number): void => {
      const step = script[stepIndex];

      if (step === undefined) {
        onFinished?.();
        return;
      }

      // ####  QUAL PROPAGANDA ESTA NO AR, AGORA  ####
      //
      // Sem isto, o ciclo inteiro desenhava a MESMA imagem: os
      // quadros trocam o retângulo, mas quem resolve o `{adimage}`
      // é este estado — e ele ficava parado na primeira da fila.
      //
      // Só nos passos que TÊM propaganda: a abertura e o
      // fechamento vêm com `ad: null`, e zerar aqui faria a imagem
      // sumir no meio do recolhimento.
      if (step.ad !== null) {
        setCurrentAd(step.ad);
      }

      const playFrame = (frameIndex: number): void => {
        const frame = step.frames[frameIndex];

        if (frame === undefined) {
          schedule(step.holdMs, () => {
            playStep(stepIndex + 1);
          });
          return;
        }

        state = applyFrame(state, frame, counter.current);
        setElements(state);

        const next = step.frames[frameIndex + 1];
        const delay = next === undefined ? 0 : Math.max(0, next.at - frame.at);

        schedule(delay, () => {
          playFrame(frameIndex + 1);
        });
      };

      playFrame(0);
    };

    playStep(0);
    return clearTimers;
    // `onFinished` fica de fora: a tela o recria a cada render, e
    // incluí-lo reiniciaria a animação a cada quadro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, script, timeline, clearTimers]);

  useEffect(() => {
    setCurrentAd(selected ?? queue[0] ?? null);
  }, [selected, queue]);

  /**
   * Por que não há nada se mexendo — quando é o caso.
   *
   * ####  QUADRO VAZIO NAO E RESPOSTA  ####
   *
   * Sem logo e sem propaganda elegível, a prévia desenha um
   * retângulo transparente sobre o gradiente: exatamente igual a
   * "quebrou". Dizer o motivo em uma linha é a diferença entre
   * ajustar um campo e abrir o console do navegador.
   */
  const nothingToShow = useMemo((): string | null => {
    if (scene === 'idle') {
      if (!settings.logoEnabled || settings.logoImageUrl === null) {
        return 'Sem logo em repouso: preencha a URL do logo, ou use os botões de cena para ver o painel.';
      }
      return null;
    }

    if (queue.length === 0 && selected === null) {
      return 'Nenhuma propaganda elegível: ligue ao menos uma e confira se ela está dentro da janela de exibição.';
    }

    return null;
  }, [scene, settings.logoEnabled, settings.logoImageUrl, queue, selected]);

  // ----------------------------------------------------------
  //  O DESENHO
  // ----------------------------------------------------------
  return (
    <div
      // A alca mede ESTE elemento para saber a escala. Ver DragHandle.
      data-ads-stage=""
      className="relative w-full overflow-hidden border border-border bg-[#101418]"
      style={{ aspectRatio: `${String(BASE_WIDTH)} / ${String(BASE_HEIGHT)}` }}
    >
      {/* O "jogo" atrás: um gradiente que só existe para o
          overlay não flutuar sobre um vazio. Sem ele, não dá para
          julgar se a cor do painel está legível. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-br from-[#1d242b] via-[#141a20] to-[#0b0f13]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, #fff 0 2px, transparent 2px 14px)',
        }}
      />

      <PreviewStage
        elements={elements}
        ad={currentAd}
        resolveImage={resolveImage}
        settings={settings}
        onMove={onMove}
      />

      {nothingToShow !== null && (
        <p className="absolute inset-x-0 bottom-0 border-t border-border bg-surface/95 px-3 py-2 text-xs text-muted">
          {nothingToShow}
        </p>
      )}
    </div>
  );
}

/**
 * Desenha a árvore, do pai para os filhos.
 *
 * O `parent` de um elemento de topo é a CAMADA do jogo (`Hud`,
 * `Overlay`), que aqui vale como "a tela inteira".
 */
function PreviewStage({
  elements,
  ad,
  resolveImage,
  settings,
  onMove,
}: {
  readonly elements: ReadonlyMap<string, Element>;
  readonly ad: Advertisement | null;
  readonly resolveImage: (raw: string | null, ad: Advertisement | null) => string | null;
  readonly settings: AdsSettings;
  readonly onMove?: ((patch: Partial<AdsSettings>) => void) | undefined;
}) {
  const boxes = useMemo(() => {
    const result = new Map<string, Box>();
    const ordered = [...elements.values()].sort((a, b) => a.order - b.order);

    // Percentual, e não pixels: o palco é responsivo, e resolver
    // em pixels exigiria medir o contêiner a cada redimensionamento.
    const stage: Box = { left: 0, top: 0, width: BASE_WIDTH, height: BASE_HEIGHT };

    for (const element of ordered) {
      const parent = result.get(element.parent) ?? stage;
      result.set(element.name, resolve(element.rect, parent));
    }

    return result;
  }, [elements]);

  const ordered = [...elements.values()].sort((a, b) => a.order - b.order);

  return (
    <>
      {ordered.map((element) => {
        const box = boxes.get(element.name);
        if (box === undefined || box.width <= 0 || box.height <= 0) return null;

        const src = resolveImage(element.image, ad);

        return (
          <div
            key={element.name}
            className={cn('absolute overflow-hidden')}
            style={{
              left: `${String((box.left / BASE_WIDTH) * 100)}%`,
              top: `${String((box.top / BASE_HEIGHT) * 100)}%`,
              width: `${String((box.width / BASE_WIDTH) * 100)}%`,
              height: `${String((box.height / BASE_HEIGHT) * 100)}%`,
              // ####  NUM ELEMENTO COM IMAGEM, A COR E TINTE  ####
              //
              // No CUI, a cor de uma RawImage MULTIPLICA a textura —
              // `1 1 1 1` significa "sem alterar", e não "branco".
              // Pintá-la como fundo aqui produzia um retângulo
              // BRANCO no lugar da propaganda toda vez que a imagem
              // não carregava, que é o oposto do que o jogo mostra
              // (lá o fundo é o painel, atrás).
              backgroundColor: element.image === null ? element.color : 'transparent',
            }}
          >
            {/* ####  SO A RAIZ E O LOGO SE ARRASTAM  ####

                Sao os dois que tem MARGEM propria no ajuste. Os
                filhos (painel, borda, slot) sao desenhados em
                relacao a raiz — arrastar um deles nao teria onde
                ser gravado.

                O logo so quando estiver SOLTO: preso ao painel,
                ele acompanha o canto e nao tem margem que se
                possa mexer. */}
            {onMove !== undefined && element.name === ROOT_NAME && (
              <DragHandle
                label="Arraste para posicionar a propaganda"
                onDrag={(dx, dy) => {
                  onMove(panPanel(settings, dx, dy));
                }}
              />
            )}

            {onMove !== undefined && element.name === LOGO_NAME && settings.logoDetached && (
              <DragHandle
                label="Arraste para posicionar o logo"
                onDrag={(dx, dy) => {
                  onMove(panLogo(settings, dx, dy));
                }}
              />
            )}

            {src !== null && (
              // `object-fill` e não `cover`: é o que o CUI faz com
              // uma RawImage — ela ESTICA para o retângulo. O
              // enquadramento `contain` do modelo é obtido pelas
              // âncoras, e já veio resolvido no retângulo acima.
              //
              // `<img>` cru, e não `next/image`: o painel é export
              // estático e a URL vem de fora (o servidor de quem
              // hospeda a propaganda), sem passar pelo otimizador.
              <img
                src={src}
                alt=""
                className="h-full w-full object-fill"
                onError={(event) => {
                  // ####  DIZER QUE NAO CARREGOU  ####
                  //
                  // Esconder e pronto deixava um retângulo vazio,
                  // indistinguível de "a animação quebrou". Quem
                  // está montando a campanha precisa saber que o
                  // problema é o ENDEREÇO — hotlink bloqueado, 404,
                  // ou uma página em vez de uma imagem.
                  const img = event.currentTarget;
                  img.style.display = 'none';

                  const parent = img.parentElement;
                  if (parent !== null && parent.dataset.failed !== '1') {
                    parent.dataset.failed = '1';
                    parent.style.outline = '1px dashed rgba(196,63,44,0.9)';
                    parent.style.outlineOffset = '-1px';
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}


/**
 * A alca invisivel que se arrasta.
 *
 * ####  ELA NAO MOVE NADA SOZINHA  ####
 *
 * O elemento continua sendo posicionado pelo mesmo caminho de
 * sempre: ajuste -> agente -> quadros -> previa. A alca so
 * traduz o arrasto em MARGEM e devolve pela `onMove`; quem
 * redesenha e o ciclo inteiro, e por isso o que se ve arrastando
 * e exatamente o que vai ao jogo.
 *
 * A alternativa — mover o div localmente e "sincronizar depois" —
 * daria uma previa que mente enquanto o dedo esta na tela.
 *
 * ####  O PONTEIRO E CAPTURADO  ####
 *
 * `setPointerCapture` faz o arrasto continuar mesmo com o cursor
 * fora do palco. Sem ele, puxar o painel para a borda soltava a
 * alca no meio do caminho.
 */
function DragHandle({
  label,
  onDrag,
}: {
  readonly label: string;
  readonly onDrag: (deltaBaseX: number, deltaBaseY: number) => void;
}) {
  const origin = useRef<{ x: number; y: number; width: number } | null>(null);

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      // ####  A DICA PRECISA EXISTIR, E SO NO HOVER  ####
      //
      // Uma alca invisivel e uma alca que ninguem descobre. Um
      // contorno permanente, por outro lado, mentiria sobre o que
      // o jogo desenha — a previa existe para mostrar o jogo, e
      // nao a ferramenta.
      //
      // O meio-termo e aparecer sob o cursor: quem passa o mouse
      // ve que aquilo se move; a captura de tela continua limpa.
      className="absolute inset-0 cursor-move outline-2 -outline-offset-2 outline-transparent transition-colors hover:outline-dashed hover:outline-rust/70"
      onPointerDown={(event) => {
        // A largura do PALCO, e nao a da alca: o palco e que
        // representa os 1280 de base, e e a razao dele que
        // converte pixel de tela em pixel de jogo.
        const stage = event.currentTarget.closest('[data-ads-stage]');
        const width = stage?.getBoundingClientRect().width ?? 0;

        if (width <= 0) return;

        origin.current = { x: event.clientX, y: event.clientY, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (start === null) return;

        const scale = BASE_WIDTH / start.width;

        onDrag((event.clientX - start.x) * scale, (event.clientY - start.y) * scale);

        // O ponto de partida anda junto: sem isto o delta seria
        // sempre contado desde o clique, e um arrasto longo
        // aplicaria a mesma distancia varias vezes.
        origin.current = { ...start, x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        origin.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        origin.current = null;
      }}
    />
  );
}
