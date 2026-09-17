// ============================================================
//  A ABA SKINS DO MENU PRINCIPAL
//
//  ####  ELA NÃO TEM TELA  ####
//
//  O menu de skins é desenhado pelo OrigemZWorkshop, e não pelo
//  agente (Docs/OrigemZWorkshop/03-MENU-DE-SKINS.md §1). A aba é só
//  um botão da barra com a ação `chat` → `/skins`: o OrigemZUI roda
//  o comando COMO O JOGADOR, o Workshop abre o menu dele e, ao abrir,
//  chama o `CloseMainMenu` do OrigemZUI. O caminho inverso — o menu
//  principal abrindo por cima do de skins — é o `CloseSkinsMenu`,
//  chamado pelo OrigemZUI (03 §7.1).
//
//  Por não ter tela, ela não entra no `NAV` do preset (que cria uma
//  página para cada entrada) nem no `EXTRA_NAV` (que navega).
//
//  ####  E POR NÃO TER TELA, O MARCADOR É O PRÓPRIO BOTÃO  ####
//
//  As outras abas migradas (`withTeamTab`, `withStreamerTab`) sabem
//  que já passaram porque a TELA está no documento. Aqui a única
//  prova é o botão: qualquer botão do shell com o id da aba OU com a
//  ação `chat` para `/skins`. O segundo critério é o que respeita o
//  admin que renomeou ou recoloriu a aba no editor.
//
//  O preço, registrado em 17/09/2026: o admin que APAGAR a aba a vê
//  voltar no boot seguinte. O documento não tem campo onde marcar
//  "esta migração já rodou", e criar um só para isso seria migração
//  de banco por um botão. Quem quiser escondê-la de verdade troca o
//  comando do botão — a aba continua lá, e o boot a reconhece.
// ============================================================

import type { UiDocument, UiElement } from '../types/ui-document.js';

import { DISCORD_TAB_ID } from './ui-discord-screen.js';
import { STREAMER_TAB_ID } from './ui-streamer-screen.js';
import { textWidth } from './ui-widgets.js';

/** O botão da barra. */
export const SKINS_TAB_ID = 'nav-skins';

export const SKINS_TAB_LABEL = 'SKINS';

/** O id da ação do botão — é ele que o plugin valida no clique. */
export const SKINS_ACTION_ID = 'ir-skins';

/**
 * O comando que o botão roda como o jogador.
 *
 * COM a barra: o OrigemZUI manda `chat.say <comando>`, e sem a barra
 * a palavra sairia no chat como mensagem. É o mesmo formato do
 * `/streamer` da aba CONFIG.
 *
 * E ele NÃO pode virar atalho do documento (`shortcuts`): o plugin
 * registra no Oxide todo atalho que chega na carga, e `/skins` é do
 * OrigemZWorkshop.
 */
export const SKINS_COMMAND = '/skins';

/** A aba de conteúdo depois da qual a SKINS entra. */
const KITS_TAB_ID = 'nav-kits';

/** As mesmas medidas da barra do preset e do `withTeamTab`. */
const NAV_GAP = 6;
const NAV_PADDING = 20;

type ButtonElement = Extract<UiElement, { type: 'button' }>;

interface NavSpot {
  /** O botão cujo estilo a aba copia. */
  readonly model: ButtonElement;
  /** Onde a aba começa. */
  readonly left: number;
  /** A aba entra antes (`before`) ou depois (`after`) do modelo. */
  readonly side: 'before' | 'after';
}

/** A largura que o rótulo SKINS ocupa num botão daquela fonte. */
export function skinsTabWidth(fontSize: number): number {
  return textWidth(SKINS_TAB_LABEL, fontSize) + NAV_PADDING;
}

/** É a aba SKINS, com o id de fábrica ou com o comando dela? */
function isSkinsTab(element: UiElement): boolean {
  if (element.type !== 'button') {
    return false;
  }

  if (element.id === SKINS_TAB_ID) {
    return true;
  }

  return element.action.kind === 'chat' && normalizeCommand(element.action.command) === 'skins';
}

/** `/skins`, ` skins ` e `/SKINS` são o mesmo comando. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/^\//, '').toLowerCase();
}

function findButton(
  elements: readonly UiElement[],
  match: (element: ButtonElement) => boolean,
): ButtonElement | null {
  for (const element of elements) {
    if (element.type === 'button' && match(element)) {
      return element;
    }

    const deeper = findButton(element.children, match);

    if (deeper !== null) return deeper;
  }

  return null;
}

function hasSkinsTab(elements: readonly UiElement[]): boolean {
  return elements.some((element) => isSkinsTab(element) || hasSkinsTab(element.children));
}

/** O botão `nav-*` que satisfaz `better` contra todos os outros. */
function pickNav(
  elements: readonly UiElement[],
  accept: (element: ButtonElement) => boolean,
  better: (candidate: ButtonElement, best: ButtonElement) => boolean,
): ButtonElement | null {
  let best: ButtonElement | null = null;

  const visit = (list: readonly UiElement[]): void => {
    for (const element of list) {
      if (element.type === 'button' && element.id.startsWith('nav-') && accept(element)) {
        if (best === null || better(element, best)) {
          best = element;
        }
      }

      visit(element.children);
    }
  };

  visit(elements);

  return best;
}

/**
 * Onde a aba entra.
 *
 * 1. Logo depois de KITS — a posição do menu novo.
 * 2. Sem KITS (o admin apagou), antes da aba de fim de barra mais à
 *    esquerda (DISCORD ou CONFIG), que é a regra do dono para as
 *    abas de conteúdo (ver `TAIL_TABS` em ui-team-screen.ts).
 * 3. Sem nenhuma das duas, depois do último botão da barra.
 */
function findSpot(shell: readonly UiElement[]): NavSpot | null {
  const kits = findButton(shell, (element) => element.id === KITS_TAB_ID);

  if (kits !== null) {
    return { model: kits, left: kits.rect.offsetMax.x + NAV_GAP, side: 'after' };
  }

  const tail = pickNav(
    shell,
    (element) => element.id === DISCORD_TAB_ID || element.id === STREAMER_TAB_ID,
    (candidate, best) => candidate.rect.offsetMin.x < best.rect.offsetMin.x,
  );

  if (tail !== null) {
    return { model: tail, left: tail.rect.offsetMin.x, side: 'before' };
  }

  const last = pickNav(
    shell,
    () => true,
    (candidate, best) => candidate.rect.offsetMax.x > best.rect.offsetMax.x,
  );

  if (last !== null) {
    return { model: last, left: last.rect.offsetMax.x + NAV_GAP, side: 'after' };
  }

  return null;
}

/**
 * Empurra para a direita todo botão de navegação que começa em
 * `fromX` ou depois — o mesmo movimento do `withTeamTab`.
 */
function shiftNavFrom(elements: readonly UiElement[], fromX: number, by: number): UiElement[] {
  return elements.map((element) => {
    const moved =
      element.type === 'button' &&
      element.id.startsWith('nav-') &&
      element.rect.offsetMin.x >= fromX
        ? {
            ...element,
            rect: {
              ...element.rect,
              offsetMin: { ...element.rect.offsetMin, x: element.rect.offsetMin.x + by },
              offsetMax: { ...element.rect.offsetMax, x: element.rect.offsetMax.x + by },
            },
          }
        : element;

    return { ...moved, children: shiftNavFrom(moved.children, fromX, by) } as UiElement;
  });
}

/**
 * O botão da aba, copiado do vizinho.
 *
 * Cor, fonte e altura saem do modelo, e não de constantes daqui: é o
 * que faz a aba nascer parecida com as outras num menu que o admin
 * recoloriu. O estado aceso é desligado — não há tela para acender.
 */
function tabFrom(model: ButtonElement, left: number): ButtonElement {
  const width = skinsTabWidth(model.fontSize);

  return {
    ...model,
    id: SKINS_TAB_ID,
    name: SKINS_TAB_LABEL,
    text: SKINS_TAB_LABEL,
    rect: {
      anchorMin: model.rect.anchorMin,
      anchorMax: model.rect.anchorMax,
      offsetMin: { x: left, y: model.rect.offsetMin.y },
      offsetMax: { x: left + width, y: model.rect.offsetMax.y },
    },
    action: { id: SKINS_ACTION_ID, kind: 'chat', command: SKINS_COMMAND },
    activeColor: null,
    activeTextColor: null,
    activeOnScreenId: null,
    children: [],
  };
}

/** A aba entra ao lado do modelo, no mesmo nível dele. */
function insertBeside(
  elements: readonly UiElement[],
  modelId: string,
  side: 'before' | 'after',
  tab: UiElement,
): UiElement[] {
  const out: UiElement[] = [];

  for (const element of elements) {
    if (element.id === modelId && side === 'before') {
      out.push(tab);
    }

    out.push({
      ...element,
      children: insertBeside(element.children, modelId, side, tab),
    } as UiElement);

    if (element.id === modelId && side === 'after') {
      out.push(tab);
    }
  }

  return out;
}

/**
 * O documento com a aba SKINS, ou `null` se não há o que fazer.
 *
 * `null` quando a aba já está lá (pelo id ou pelo comando) ou quando
 * a barra não tem botão de navegação — um menu desenhado do zero não
 * tem onde pendurá-la.
 *
 * Roda a cada boot (index.ts), como os outros upgrades de documento,
 * e por isso tem de ser idempotente: a segunda passada devolve `null`.
 */
export function withSkinsTab(document: UiDocument): UiDocument | null {
  if (hasSkinsTab(document.shell)) {
    return null;
  }

  const spot = findSpot(document.shell);

  if (spot === null) {
    return null;
  }

  const tab = tabFrom(spot.model, spot.left);
  const shifted = shiftNavFrom(
    document.shell,
    spot.left,
    skinsTabWidth(spot.model.fontSize) + NAV_GAP,
  );

  return {
    ...document,
    shell: insertBeside(shifted, spot.model.id, spot.side, tab),
  };
}
