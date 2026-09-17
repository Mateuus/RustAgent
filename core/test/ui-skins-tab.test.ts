// ============================================================
//  ui-skins-tab.test.ts  -  a aba SKINS do menu principal.
//
//  O que se prova sem o jogo:
//
//    1. o menu NOVO tem a aba, logo depois de KITS, rodando `/skins`
//       como o jogador;
//    2. o menu GRAVADO antes dela a ganha no boot, e fica igual ao
//       novo — byte a byte no shell;
//    3. o upgrade é idempotente, e respeita a aba que o admin
//       renomeou;
//    4. a carga inicial continua abaixo da trava.
//
//  Ver Docs/OrigemZWorkshop/05-PLANO-E-FRENTES.md §7.
// ============================================================

import { describe, expect, it } from 'vitest';

import { collectScreenActions, shellNavStates } from '../src/game/ui-cui.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import {
  SKINS_ACTION_ID,
  SKINS_COMMAND,
  SKINS_TAB_ID,
  skinsTabWidth,
  withSkinsTab,
} from '../src/game/ui-skins-tab.js';
import {
  findDocumentProblems,
  uiDocumentSchema,
  type UiDocument,
  type UiElement,
} from '../src/types/ui-document.js';
import { encodeUiDocPayload, toDocumentPayload } from '../src/types/ui-transport.js';

const NAV_GAP = 6;

type ButtonElement = Extract<UiElement, { type: 'button' }>;

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function navButtons(document: UiDocument): ButtonElement[] {
  return walk(document.shell)
    .filter(
      (element): element is ButtonElement =>
        element.type === 'button' && element.id.startsWith('nav-'),
    )
    .sort((a, b) => a.rect.offsetMin.x - b.rect.offsetMin.x);
}

function byId(document: UiDocument, id: string): ButtonElement {
  const found = navButtons(document).find((element) => element.id === id);

  if (found === undefined) throw new Error(`sem ${id} na barra`);

  return found;
}

/** Tira um botão da barra e puxa de volta quem estava à direita. */
function removeTab(document: UiDocument, id: string): UiDocument {
  const target = byId(document, id);
  const by = -(target.rect.offsetMax.x - target.rect.offsetMin.x + NAV_GAP);

  const go = (elements: readonly UiElement[]): UiElement[] =>
    elements
      .filter((element) => element.id !== id)
      .map((element) => {
        const moved =
          element.type === 'button' &&
          element.id.startsWith('nav-') &&
          element.rect.offsetMin.x >= target.rect.offsetMin.x
            ? {
                ...element,
                rect: {
                  ...element.rect,
                  offsetMin: { ...element.rect.offsetMin, x: element.rect.offsetMin.x + by },
                  offsetMax: { ...element.rect.offsetMax, x: element.rect.offsetMax.x + by },
                },
              }
            : element;

        return { ...moved, children: go(moved.children) } as UiElement;
      });

  return { ...document, shell: go(document.shell) };
}

/** O menu como estava gravado antes desta frente. */
function menuWithoutSkins(): UiDocument {
  return removeTab(buildMainMenu(), SKINS_TAB_ID);
}

describe('a aba SKINS no menu novo', () => {
  it('fica logo depois de KITS e roda /skins como o jogador', () => {
    const menu = buildMainMenu();
    const order = navButtons(menu).map((element) => element.id);

    expect(order.indexOf(SKINS_TAB_ID)).toBe(order.indexOf('nav-kits') + 1);

    const tab = byId(menu, SKINS_TAB_ID);

    expect(tab.action).toEqual({ id: SKINS_ACTION_ID, kind: 'chat', command: SKINS_COMMAND });
    // Com a barra: o plugin manda `chat.say`, e sem ela a palavra
    // sairia no chat como mensagem.
    expect(SKINS_COMMAND).toBe('/skins');
    expect(tab.rect.offsetMin.x).toBe(byId(menu, 'nav-kits').rect.offsetMax.x + NAV_GAP);
  });

  it('não acende, e por isso não viaja no navStates', () => {
    const menu = buildMainMenu();

    expect(shellNavStates(menu).some((state) => state.id === SKINS_TAB_ID)).toBe(false);
  });

  it('o clique é aceito pelo plugin em qualquer tela', () => {
    // A tabela de ações de cada tela inclui o shell: é ela que o
    // `FindAction` do OrigemZUI consulta antes de executar.
    const menu = buildMainMenu();
    const entry = menu.screens.find((screen) => screen.id === menu.entryScreenId);

    if (entry === undefined) throw new Error('sem tela de entrada');

    expect(collectScreenActions(entry, menu.shell)[SKINS_ACTION_ID]).toEqual({
      kind: 'chat',
      command: SKINS_COMMAND,
    });
  });

  it('não vira atalho do documento — /skins é do OrigemZWorkshop', () => {
    expect(buildMainMenu().shortcuts.some((entry) => entry.command === 'skins')).toBe(false);
  });

  it('o documento continua válido e a carga abaixo da trava', () => {
    const menu = buildMainMenu();

    expect(() => uiDocumentSchema.parse(menu)).not.toThrow();
    expect(findDocumentProblems(menu)).toEqual([]);

    // Medido em 17/09/2026: 44.508 sem a aba, 45.532 com ela. A
    // trava geral mora em ui-home-screen.test.ts.
    const bytes = encodeUiDocPayload({ documents: [toDocumentPayload(menu)] }).length;
    const without = encodeUiDocPayload({
      documents: [toDocumentPayload(menuWithoutSkins())],
    }).length;

    expect(bytes).toBeLessThan(47_800);
    expect(bytes - without).toBeLessThan(1_200);
  });
});

describe('o menu gravado antes da aba', () => {
  it('ganha a aba no boot e fica igual ao menu novo', () => {
    const upgraded = withSkinsTab(menuWithoutSkins());

    expect(upgraded).not.toBeNull();
    expect(upgraded?.shell).toEqual(buildMainMenu().shell);
  });

  it('não ganha a aba duas vezes', () => {
    const once = withSkinsTab(menuWithoutSkins());

    expect(once).not.toBeNull();
    expect(withSkinsTab(once as UiDocument)).toBeNull();
    expect(withSkinsTab(buildMainMenu())).toBeNull();
  });

  it('respeita a aba que o admin renomeou: o comando basta', () => {
    const menu = buildMainMenu();
    const renamed = (elements: readonly UiElement[]): UiElement[] =>
      elements.map(
        (element) =>
          ({
            ...(element.id === SKINS_TAB_ID
              ? { ...element, id: 'aba-visual', text: 'VISUAL' }
              : element),
            children: renamed(element.children),
          }) as UiElement,
      );

    expect(withSkinsTab({ ...menu, shell: renamed(menu.shell) })).toBeNull();
  });

  it('sem KITS, entra antes do DISCORD e empurra quem vem depois', () => {
    const old = removeTab(menuWithoutSkins(), 'nav-kits');
    const discord = byId(old, 'nav-discord');
    const config = byId(old, 'nav-config');
    const upgraded = withSkinsTab(old);

    if (upgraded === null) throw new Error('não entrou');

    const tab = byId(upgraded, SKINS_TAB_ID);
    const shift = skinsTabWidth(tab.fontSize) + NAV_GAP;

    expect(tab.rect.offsetMin.x).toBe(discord.rect.offsetMin.x);
    expect(byId(upgraded, 'nav-discord').rect.offsetMin.x).toBe(discord.rect.offsetMin.x + shift);
    expect(byId(upgraded, 'nav-config').rect.offsetMin.x).toBe(config.rect.offsetMin.x + shift);
    expect(findDocumentProblems(upgraded)).toEqual([]);
  });

  it('um menu sem barra fica como está', () => {
    const menu = buildMainMenu();
    const bare = walk(menu.shell).filter(
      (element) => !(element.type === 'button' && element.id.startsWith('nav-')),
    );
    const strip = (elements: readonly UiElement[]): UiElement[] =>
      elements
        .filter((element) => bare.some((kept) => kept.id === element.id))
        .map((element) => ({ ...element, children: strip(element.children) }) as UiElement);

    expect(withSkinsTab({ ...menu, shell: strip(menu.shell) })).toBeNull();
  });

  it('as abas entre as duas pontas mantêm o mesmo vão', () => {
    const upgraded = withSkinsTab(menuWithoutSkins());

    if (upgraded === null) throw new Error('não entrou');

    const buttons = navButtons(upgraded);
    const gaps = buttons
      .slice(1)
      .map((element, index) => element.rect.offsetMin.x - (buttons[index]?.rect.offsetMax.x ?? 0));

    expect(new Set(gaps)).toEqual(new Set([NAV_GAP]));
  });
});
