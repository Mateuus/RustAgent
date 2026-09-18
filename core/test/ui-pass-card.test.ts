// ============================================================
//  O CARTÃO DO PASSE NA HOME.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O cartão é a única parte do passe que o agente DESENHA (a tela em
//  si é do OrigemZBattlePass), e ele entra numa tela que já estava
//  cheia. Os casos abaixo são os que quebram em silêncio:
//
//    a carga estourar o teto   a home é a tela de ENTRADA: passar de
//                              `UI_DOC_MAX_BYTES` faz o envio ser
//                              RECUSADO INTEIRO, e o menu do
//                              servidor para de atualizar sem nada
//                              no jogo dizendo por quê
//    o upgrade pisar no admin  reposicionar os cartões de quem
//                              editou a home desfaz o trabalho dele,
//                              e ninguém percebe até abrir o jogo
//    o upgrade rodar duas vezes  ele roda a CADA boot
//    "não sei" virando "não tem"  cartão dizendo NÍVEL 1 para quem o
//                              agente não conseguiu ler
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  buildHomeScreen,
  cardsOf,
  emptyHomeView,
  HOME_SCREEN_ID,
  PASS_CARD_COMMAND,
  readHomeView,
  type HomePassReader,
  type HomeScreenDeps,
} from '../src/game/ui-home-screen.js';
import { withPassCard } from '../src/game/ui-pass-card.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import type { PlayerTrack, TrackCellView } from '../src/types/battlepass.js';
import type { UiDocument, UiElement, UiScreen } from '../src/types/ui-document.js';
import {
  encodeUiDocPayload,
  toDocumentPayload,
  UI_DOC_MAX_BYTES,
} from '../src/types/ui-transport.js';
import { questRewardSchema } from '../src/types/quests.js';

const SERVER = 'pvp1';
const PLAYER = '76561190000000001';

/** A trava do arquivo de bytes da home. Ver o comentário lá. */
const HOME_BYTES_LIMIT = 47_800;

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function find(screen: UiScreen, id: string): UiElement | undefined {
  return walk(screen.elements).find((element) => element.id === id);
}

function bytesOf(document: UiDocument): number {
  return encodeUiDocPayload({ documents: [toDocumentPayload(document)] }).length;
}

const AK = questRewardSchema.parse({ kind: 'item', shortname: 'rifle.ak', amount: 1 });

function cell(level: number, state: TrackCellView['state']): TrackCellView {
  return {
    seasonId: 1,
    level,
    lane: 'free',
    rewards: [AK],
    milestone: false,
    updatedAt: 0,
    state,
    reason: null,
  };
}

/** Uma trilha pronta, como o `trackOf` a devolve. */
function track(overrides: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    serverId: SERVER,
    steamId: PLAYER,
    season: {
      id: 1,
      period: '2026-10',
      label: 'Temporada de outubro de 2026',
      levels: 30,
      xpCurve: { kind: 'flat', perLevel: 1000 },
      freeLane: true,
      paidLane: true,
      retroactive: true,
      description: null,
      servers: [SERVER],
      state: 'active',
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
    },
    progress: { level: 17, xp: 16_400, intoLevel: 400, neededForNext: 1000, completed: false },
    paid: false,
    cells: [cell(1, 'claimed'), cell(2, 'available'), cell(3, 'available')],
    pending: [],
    unseen: false,
    ...overrides,
  };
}

function readerOf(value: PlayerTrack | (() => never)): HomePassReader {
  return {
    trackOf: () => (typeof value === 'function' ? value() : value),
  };
}

/**
 * A linha viva que a home mostraria com aquele leitor.
 *
 * Passa pelo `readHomeView` de verdade — é lá que mora o bloco com
 * `try` próprio — e não por um recorte montado no teste.
 */
async function noteOf(pass: HomeScreenDeps['pass'], semJogador = false): Promise<string> {
  const view = await readHomeView({
    deps: {
      rankings: { metrics: () => [], read: () => ({ rows: [], nextCursor: null }) } as never,
      store: { catalog: () => [] },
      quests: { liveFor: () => [] },
      wipe: null,
      pass,
    },
    serverId: SERVER,
    // `undefined` e a carga inicial: ela vai ao servidor sem jogador
    // nenhum, e o cartao nao pode inventar um nivel.
    steamId: semJogador ? undefined : PLAYER,
    now: 1_700_000_000_000,
  });

  return view.passNote;
}

// ------------------------------------------------------------
//  O DESENHO
// ------------------------------------------------------------

describe('o cartão do passe', () => {
  it('é o cartão INTEIRO que abre o passe, e por um comando de chat', () => {
    const screen = buildHomeScreen({ view: emptyHomeView() });
    const card = find(screen, 'hm-passe');

    // O OrigemZUI não sabe navegar até uma tela que não é do
    // documento: a do passe é desenhada pelo plugin. O caminho é o
    // mesmo da aba SKINS — rodar o comando COMO O JOGADOR.
    expect(card?.type).toBe('button');
    expect(card?.type === 'button' ? card.action : null).toEqual({
      id: 'hm-passe-a',
      kind: 'chat',
      command: PASS_CARD_COMMAND,
    });
    // COM a barra: sem ela a palavra sairia no chat como mensagem.
    expect(PASS_CARD_COMMAND.startsWith('/')).toBe(true);
  });

  it('o repouso é determinístico: duas chamadas dão o MESMO desenho', () => {
    // É o que permite ao upgrade perguntar "alguém mexeu aqui?" com
    // uma comparação de strings. Um `Date.now()` aqui dentro faria
    // todo boot achar que o admin editou a home.
    const primeira = buildHomeScreen({ view: emptyHomeView() });
    const segunda = buildHomeScreen({ view: emptyHomeView() });

    expect(JSON.stringify(primeira)).toBe(JSON.stringify(segunda));
  });

  it('as cinco colunas dividem a largura inteira, sem buraco', () => {
    const screen = buildHomeScreen({ view: emptyHomeView() });
    const cards = screen.elements.filter(
      (element) => element.id.startsWith('hm-') && element.id !== 'hm-banner',
    );

    expect(cards).toHaveLength(5);
    expect(cards.at(0)?.rect.anchorMin.x).toBe(0);
    expect(cards.at(-1)?.rect.anchorMax.x).toBe(1);
    // O quinto aperta: 1064,4 px de área útil / 5 = 212,9 por
    // coluna, contra 266,1 com quatro. MEDIDO em 17/09/2026.
    expect(cards.at(0)?.rect.anchorMax.x).toBeCloseTo(0.2, 5);
  });

  it('o servidor que não mostra o passe não ganha a ação de volta', () => {
    const menu = buildMainMenu();
    const template = menu.screens.find((screen) => screen.id === HOME_SCREEN_ID);
    const screen = buildHomeScreen({
      view: emptyHomeView(),
      template,
      cards: { rank: true, offer: true, wipe: true, quest: true, pass: false },
    });
    const card = find(screen, 'hm-passe');

    // O cartão e o botão dele são o MESMO elemento, então as duas
    // chaves do `slotsOf` são a mesma string — e repor a ação
    // desfaria o `hide`. Ver o comentário lá.
    expect(card).toBeUndefined();
  });
});

// ------------------------------------------------------------
//  O QUE ELE DIZ
// ------------------------------------------------------------

describe('a linha viva do cartão', () => {
  it('conta o nível e o que está esperando o clique', async () => {
    expect(await noteOf(readerOf(track()))).toBe(
      'Nível 17 de 30 — 2 prêmios prontos para resgatar',
    );
  });

  it('a casa VAZIA não entra na conta do que está pronto', async () => {
    const vazia: TrackCellView = { ...cell(2, 'available'), rewards: [] };

    // Contá-la faria o cartão prometer dois e entregar um — a mesma
    // regra do `claimAll`.
    expect(
      await noteOf(readerOf(track({ cells: [cell(1, 'claimed'), vazia, cell(3, 'available')] }))),
    ).toBe('Nível 17 de 30 — 1 prêmio pronto para resgatar');
  });

  it('sem prêmio pronto, a caixa ganha do XP', async () => {
    const comCaixa = track({
      cells: [cell(1, 'claimed')],
      pending: [
        {
          id: 1,
          claimId: 1,
          idx: 0,
          serverId: SERVER,
          steamId: PLAYER,
          origin: 'inventory',
          reward: AK,
          code: 'INVENTORY_FULL',
          attempts: 1,
          seenAt: null,
          deliveredAt: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    expect(await noteOf(readerOf(comCaixa))).toBe('Nível 17 de 30 — 1 item esperando na caixa');
  });

  it('sem nada pendente, ela mostra o XP que falta', async () => {
    expect(await noteOf(readerOf(track({ cells: [cell(1, 'claimed')] })))).toBe(
      'Nível 17 de 30 — 400 / 1.000 XP para o próximo',
    );
  });

  it('a trilha concluída não fica prometendo um próximo nível', async () => {
    const fim = track({
      cells: [cell(1, 'claimed')],
      progress: { level: 30, xp: 99_000, intoLevel: 0, neededForNext: null, completed: true },
    });

    expect(await noteOf(readerOf(fim))).toBe('Nível 30 de 30 — trilha concluída');
  });

  /**
   * ####  "AUSENTE NÃO É VAZIO"  ####
   *
   * As três frases abaixo dizem coisas DIFERENTES, e nenhuma delas
   * inventa um nível. Um cartão dizendo "NÍVEL 1" para quem o agente
   * não conseguiu ler seria uma mentira que ninguém investiga.
   */
  it('diz "não sei" de três jeitos, e nenhum deles é um nível falso', async () => {
    expect(await noteOf(readerOf(track({ season: null })))).toBe(
      'Nenhuma temporada no ar por enquanto.',
    );

    expect(await noteOf(null)).toBe('O passe de batalha não está de pé neste servidor.');

    expect(await noteOf(readerOf(track()), true)).toBe(
      'Abra o menu no jogo para ver o seu passe.',
    );

    // E o erro de leitura tem o seu próprio `try`: o passe não
    // derruba a home, que é a tela de entrada do menu.
    expect(
      await noteOf(
        readerOf(() => {
          throw new Error('o banco sumiu');
        }),
      ),
    ).toBe('Não consegui ler o seu passe agora.');
  });
});

// ------------------------------------------------------------
//  OS BYTES
// ------------------------------------------------------------

describe('o preço do quinto cartão', () => {
  /**
   * ####  ESTE É O TESTE QUE MAIS IMPORTA DO ARQUIVO  ####
   *
   * A home viaja na carga INICIAL do documento, e passar do teto faz
   * o `UiSync` recusar o envio inteiro — o menu do servidor para de
   * atualizar sem nada no jogo dizendo por quê.
   *
   * MEDIDO em 17/09/2026: o preset sem o cartão dá 45.532 bytes; com
   * ele, 47.444. O desenho completo que o Docs/BattlePass/03 §7
   * descreve (cabeçalho com ícone e régua, linha de apoio, nível,
   * barra e nota) custava 5.780 e levava a carga a 51.312 — ACIMA do
   * teto. É por isso que o cartão tem três peças.
   */
  it('cabe no teto do RCON e na trava da home', () => {
    const bytes = bytesOf(buildMainMenu());

    expect(bytes).toBeLessThanOrEqual(UI_DOC_MAX_BYTES);
    expect(bytes).toBeLessThan(HOME_BYTES_LIMIT);
  });

  it('e ele cabe em menos de 2.500 bytes', () => {
    const menu = buildMainMenu();
    const semPasse = buildHomeScreen({
      view: emptyHomeView(),
      cards: { rank: true, offer: true, wipe: true, quest: true, pass: false },
    });
    const antes = bytesOf({
      ...menu,
      screens: menu.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID ? { ...screen, elements: semPasse.elements } : screen,
      ),
    });

    // A trava é o custo DELE, e não o total: assim, quem emagrecer a
    // home em outro lugar não abre espaço para este cartão engordar
    // sem alguém decidir isso.
    expect(bytesOf(menu) - antes).toBeLessThan(2500);
  });
});

// ------------------------------------------------------------
//  O UPGRADE DO MENU JÁ GRAVADO
// ------------------------------------------------------------

describe('o cartão entrando num menu que já existe', () => {
  /** O menu como ele era antes desta frente: a home de quatro cartões. */
  function menuAntigo(): UiDocument {
    const menu = buildMainMenu();
    const quatro = buildHomeScreen({
      view: emptyHomeView(),
      cards: { rank: true, offer: true, wipe: true, quest: true, pass: false },
    });

    return {
      ...menu,
      screens: menu.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID ? { ...screen, elements: quatro.elements } : screen,
      ),
    };
  }

  it('entra na home que está como o preset a gravou', () => {
    const antigo = menuAntigo();

    expect(cardsOf(antigo).pass).toBe(false);

    const novo = withPassCard(antigo);

    expect(novo).not.toBeNull();
    expect(cardsOf(novo!).pass).toBe(true);
    // E os quatro antigos foram reposicionados para cinco colunas.
    const home = novo!.screens.find((screen) => screen.id === HOME_SCREEN_ID)!;
    const cards = home.elements.filter(
      (element) => element.id.startsWith('hm-') && element.id !== 'hm-banner',
    );

    expect(cards).toHaveLength(5);
    expect(cards.at(0)?.rect.anchorMax.x).toBeCloseTo(0.2, 5);
  });

  it('a segunda passada não faz nada: ele roda a cada boot', () => {
    const novo = withPassCard(menuAntigo());

    expect(withPassCard(novo!)).toBeNull();
    // E o menu novo, que já nasce com o cartão, também não é tocado.
    expect(withPassCard(buildMainMenu())).toBeNull();
  });

  /**
   * ####  QUEM EDITOU A HOME CONTINUA COM A EDIÇÃO DELE  ####
   *
   * Acrescentar um cartão move os outros quatro (`columnRect` divide
   * a largura pelo número deles). Num menu que o admin desenhou,
   * isso é desfazer o trabalho dele para caber uma novidade — e a
   * perda seria silenciosa: ninguém percebe até abrir o jogo.
   */
  it('não toca na home que o admin editou', () => {
    const editado = menuAntigo();
    const home = editado.screens.find((screen) => screen.id === HOME_SCREEN_ID)!;
    const mexido: UiDocument = {
      ...editado,
      screens: editado.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID
          ? {
              ...screen,
              elements: home.elements.filter((element) => element.id !== 'hm-wipe'),
            }
          : screen,
      ),
    };

    expect(withPassCard(mexido)).toBeNull();
  });

  it('documento sem home não é tocado', () => {
    const semHome = buildMainMenu();

    expect(
      withPassCard({
        ...semHome,
        screens: semHome.screens.filter((screen) => screen.id !== HOME_SCREEN_ID),
      }),
    ).toBeNull();
  });
});
