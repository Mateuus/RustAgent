// ============================================================
//  ui-kits-screen.ts  -  a página KITS, montada do banco.
//
//  ####  POR QUE ESTA TELA NÃO É DESENHADA NO EDITOR  ####
//
//  As outras páginas do menu são desenho: o que está lá é o que
//  alguém pôs. Esta é uma LISTA que muda sem ninguém abrir o
//  editor — o admin cria um kit no painel e ele precisa aparecer
//  no jogo, e o botão precisa saber se AQUELE jogador já pegou.
//
//  Então o documento guarda só o ENDEREÇO (a tela `tela-kits`, com
//  o aviso de que o conteúdo entra ali) e o agente monta o
//  conteúdo na hora do clique.
//
//  ####  ELA NUNCA É GUARDADA EM CACHE  ####
//
//  `volatile: true` no pacote. Um kit de cooldown mostra "daqui a
//  2h" — em cache, ele mostraria as duas horas para sempre, e o
//  jogador clicaria confiando naquilo.
//
//  ------------------------------------------------------------
//  ####  O BOTÃO CARREGA O SLUG, E NADA MAIS  ####
//
//  A ação é `store.buy` com `offerId` = o slug do kit. Ela chega
//  ao agente pelo `#OZBUY#`, com o SteamID vindo da conexão que
//  clicou — nunca de um argumento. Quem decide se aquele jogador
//  pode pegar é o `KitStore`, lendo o banco: o clique não carrega
//  preço, quantidade nem permissão.
// ============================================================

import type { KitOfferView } from '../kits/service.js';
import type { UiElement, UiScreen } from '../types/ui-document.js';

/**
 * O id da tela de kits no documento.
 *
 * FIXO, e não sorteado: é por ele que o agente reconhece a tela
 * cujo conteúdo ele mesmo monta. Precisa bater com o preset — ver
 * game/ui-preset-main-menu.ts.
 */
export const KITS_SCREEN_ID = 'tela-kits';

// As cores são as do preset, pelo mesmo motivo de elas estarem lá:
// os tokens de panel/src/app/globals.css.
const C = {
  surface: '#1B1B1B',
  border: '#2E2E2E',
  text: '#E8E8E8',
  textMuted: '#9A9A9A',
  rust: '#C43F2C',
  white: '#FFFFFF',
} as const;

/** Altura de cada linha da lista, na base 1280x720. */
const ROW_HEIGHT = 64;
const ROW_GAP = 8;

/**
 * Quantos kits cabem na página.
 *
 * A área de conteúdo tem ~470 px de altura; com 72 px por linha,
 * seis entram sem cortar. Passando disso, a lista é TRUNCADA e a
 * tela DIZ que truncou — uma lista que some sem avisar é pior que
 * uma lista curta (a mesma regra do `truncated` dos grupos do
 * Oxide).
 */
const MAX_ROWS = 6;

type Rect = UiElement['rect'];

function rowRect(index: number): Rect {
  const top = 42 + index * (ROW_HEIGHT + ROW_GAP);

  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(top + ROW_HEIGHT) },
    offsetMax: { x: 0, y: -top },
  };
}

function panel(
  id: string,
  name: string,
  rect: Rect,
  color: string,
  children: UiElement[] = [],
): UiElement {
  return {
    id,
    name,
    type: 'panel',
    rect,
    children,
    color,
    sprite: null,
    imageType: 'Simple',
    material: null,
  };
}

function label(
  id: string,
  rect: Rect,
  text: string,
  options: {
    size?: number;
    color?: string;
    align?: Extract<UiElement, { type: 'label' }>['align'];
  } = {},
): UiElement {
  return {
    id,
    name: 'Texto',
    type: 'label',
    rect,
    children: [],
    text,
    fontSize: options.size ?? 12,
    font: 'RobotoCondensed-Bold.ttf',
    color: options.color ?? C.text,
    align: options.align ?? 'MiddleLeft',
  };
}

/**
 * O que este kit exige, em uma linha.
 *
 * É a informação que decide se vale a pena clicar — e ela precisa
 * estar na LISTA, não escondida atrás do clique.
 */
function conditionOf(kit: KitOfferView): string {
  const tier = kit.requiredTier === null ? '' : ` · exige ${kit.requiredTier}`;

  if (kit.kind === 'resgate') {
    return `uma vez por jogador${tier}`;
  }

  if (kit.kind === 'cooldown') {
    const seconds = kit.cooldownSeconds ?? 0;
    const hours = Math.round(seconds / 3600);
    const every = hours >= 1 ? `${String(hours)}h` : `${String(Math.round(seconds / 60))}min`;

    return `a cada ${every}${tier}`;
  }

  return `compra${tier}`;
}

/**
 * A página de kits daquele servidor, para aquele jogador.
 *
 * `offers` vem de `KitStore.listForServer(serverId, steamId)` — é
 * ele que sabe quem já pegou o quê, e é por isso que a tela é
 * montada por jogador em vez de uma só para todos.
 */
export function buildKitsScreen(offers: readonly KitOfferView[]): UiScreen {
  const elements: UiElement[] = [
    label(
      'kits-titulo',
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -30 },
        offsetMax: { x: 0, y: 0 },
      },
      'KITS',
      { size: 20 },
    ),
  ];

  const visible = offers.slice(0, MAX_ROWS);

  if (visible.length === 0) {
    elements.push(
      panel(
        'kits-vazio',
        'Vazio',
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: 0, y: 0 },
          offsetMax: { x: 0, y: -42 },
        },
        C.surface,
        [
          label(
            'kits-vazio-texto',
            {
              anchorMin: { x: 0, y: 0 },
              anchorMax: { x: 1, y: 1 },
              offsetMin: { x: 20, y: 20 },
              offsetMax: { x: -20, y: -20 },
            },
            'Nenhum kit disponível neste servidor.',
            { color: C.textMuted, align: 'MiddleCenter' },
          ),
        ],
      ),
    );

    return { id: KITS_SCREEN_ID, name: 'KITS', kind: 'page', elements };
  }

  visible.forEach((kit, index) => {
    const id = `kit-${kit.slug}`;

    elements.push(
      panel(id, kit.name, rowRect(index), C.border, [
        panel(
          `${id}-i`,
          'Interior',
          {
            anchorMin: { x: 0, y: 0 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 1, y: 1 },
            offsetMax: { x: -1, y: -1 },
          },
          C.surface,
          [
            label(
              `${id}-nome`,
              {
                anchorMin: { x: 0, y: 1 },
                anchorMax: { x: 1, y: 1 },
                offsetMin: { x: 14, y: -30 },
                offsetMax: { x: -180, y: -8 },
              },
              kit.name,
              { size: 15 },
            ),
            label(
              `${id}-cond`,
              {
                anchorMin: { x: 0, y: 1 },
                anchorMax: { x: 1, y: 1 },
                offsetMin: { x: 14, y: -52 },
                offsetMax: { x: -180, y: -32 },
              },
              `${String(kit.items.length)} ${kit.items.length === 1 ? 'item' : 'itens'} · ${conditionOf(kit)}`,
              { size: 11, color: C.textMuted },
            ),
            // ####  QUEM NÃO PODE PEGAR VÊ O MOTIVO, NÃO UM BOTÃO
            //       MORTO  ####
            //
            // Um botão que recusa depois do clique faz o jogador
            // clicar três vezes antes de desconfiar. O motivo vem
            // do `KitStore`, que é quem conhece a regra.
            kit.available
              ? {
                  id: `${id}-btn`,
                  name: 'Resgatar',
                  type: 'button',
                  rect: {
                    anchorMin: { x: 1, y: 0.5 },
                    anchorMax: { x: 1, y: 0.5 },
                    offsetMin: { x: -160, y: -16 },
                    offsetMax: { x: -14, y: 16 },
                  },
                  children: [],
                  color: C.rust,
                  sprite: null,
                  text: 'RESGATAR',
                  fontSize: 12,
                  font: 'RobotoCondensed-Bold.ttf',
                  textColor: C.white,
                  align: 'MiddleCenter',
                  // O slug, e nada mais. Ver o cabeçalho.
                  action: {
                    id: `pegar-${kit.slug}`,
                    kind: 'store.buy',
                    offerId: kit.slug,
                    quantity: 1,
                  },
                  hoverColor: '#D4553FFF',
                  pressedColor: '#A83525FF',
                  activeColor: null,
                  activeTextColor: null,
                  activeOnScreenId: null,
                }
              : label(
                  `${id}-motivo`,
                  {
                    anchorMin: { x: 1, y: 0.5 },
                    anchorMax: { x: 1, y: 0.5 },
                    offsetMin: { x: -200, y: -16 },
                    offsetMax: { x: -14, y: 16 },
                  },
                  kit.reason ?? 'indisponível',
                  { size: 11, color: C.textMuted, align: 'MiddleRight' },
                ),
          ],
        ),
      ]),
    );
  });

  if (offers.length > visible.length) {
    // Ver `MAX_ROWS`: lista truncada AVISA que truncou.
    elements.push(
      label(
        'kits-mais',
        {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 0, y: 0 },
          offsetMax: { x: 0, y: 18 },
        },
        `e mais ${String(offers.length - visible.length)} kit(s) que não couberam nesta página`,
        { size: 10, color: C.textMuted, align: 'MiddleCenter' },
      ),
    );
  }

  return { id: KITS_SCREEN_ID, name: 'KITS', kind: 'page', elements };
}
