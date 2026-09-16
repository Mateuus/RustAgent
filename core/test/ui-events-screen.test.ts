// ============================================================
//  A aba EVENTOS do menu.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Esta tela responde uma pergunta com consequência: "vale a pena
//  largar o que estou fazendo e ir até lá?". Ela erra de três
//  jeitos, e nenhum deles quebra nada:
//
//    silêncio      servidor sem resposta virando "não tem evento",
//                  e o jogador fecha o menu achando que a noite
//                  está parada;
//    vaga vazia    o último resultado sumindo, e quem perdeu o
//                  evento por dez minutos não sabendo que ele
//                  existiu;
//    endereço      um `screenId` forjado abrindo o evento errado.
// ============================================================

import { describe, expect, it } from 'vitest';

import type { UiDocument, UiElement } from '../src/types/ui-document.js';
import {
  CARDS_PER_PAGE,
  EVENTS_SCREEN_ID,
  ago,
  buildEventsScreen,
  clock,
  createEventsScreenProvider,
  eventsScreenId,
  parseEventsScreenId,
  phaseOf,
  stateLine,
  withEventsScreen,
  type KothCard,
} from '../src/game/ui-events-screen.js';

const NOW = Date.UTC(2026, 8, 17, 21, 0, 0);

function live(patch: Partial<KothCard> = {}): KothCard {
  return {
    runId: '52',
    name: 'Colina do Norte',
    grid: 'N14',
    radius: 30,
    live: true,
    percent: 40,
    holderId: '7',
    holderName: 'Os Bravos',
    contested: false,
    inside: 3,
    remaining: 900,
    captureSeconds: 900,
    ...patch,
  };
}

function ended(patch: Partial<KothCard> = {}): KothCard {
  return {
    runId: '51',
    name: 'Vale do Rio',
    grid: 'P15',
    radius: 30,
    live: false,
    outcome: 'captured',
    winnerName: 'Lobos do Sul',
    endedAt: NOW - 12 * 60_000,
    ...patch,
  };
}

/** Todo texto da tela, para procurar sem saber o caminho. */
function texts(elements: readonly UiElement[]): string[] {
  const out: string[] = [];

  const visit = (list: readonly UiElement[]): void => {
    for (const element of list) {
      if (element.type === 'label') out.push(element.text);

      if (element.type === 'button') out.push(element.text);

      visit(element.children);
    }
  };

  visit(elements);

  return out;
}

/** Todo `screenId` de ação da tela. */
function targets(elements: readonly UiElement[]): string[] {
  const out: string[] = [];

  const visit = (list: readonly UiElement[]): void => {
    for (const element of list) {
      if (element.type === 'button' && 'screenId' in element.action) {
        const screenId = element.action.screenId;

        if (typeof screenId === 'string') out.push(screenId);
      }

      visit(element.children);
    }
  };

  visit(elements);

  return out;
}

describe('o endereço', () => {
  it('a aba nua é KOTH na primeira página', () => {
    expect(parseEventsScreenId(EVENTS_SCREEN_ID)).toEqual({
      tab: 'koth',
      page: 0,
      detail: null,
    });
  });

  it('vai e volta', () => {
    const id = eventsScreenId('masmorra', 2);

    expect(parseEventsScreenId(id)).toEqual({ tab: 'masmorra', page: 2, detail: null });
  });

  it('o que está no padrão não entra no id', () => {
    // `tela-eventos` continua sendo o endereço que o botão da barra
    // aponta: um id diferente para a mesma tela tiraria o destaque
    // do botão.
    expect(eventsScreenId('koth', 0)).toBe(EVENTS_SCREEN_ID);
  });

  it('o detalhe leva o id da run', () => {
    expect(parseEventsScreenId(eventsScreenId('koth', 1, '52'))).toEqual({
      tab: 'koth',
      page: 1,
      detail: '52',
    });
  });

  it('id de run não vira página por engano', () => {
    // O `:r:` existe para isto: sem o marcador, uma run chamada "3"
    // seria lida como a página 3.
    expect(parseEventsScreenId(`${EVENTS_SCREEN_ID}:koth:0:r:3`)?.detail).toBe('3');
  });

  it('endereço de outra tela não é meu', () => {
    expect(parseEventsScreenId('tela-equipe')).toBeNull();
  });

  it('família inventada cai no KOTH, em vez de quebrar', () => {
    expect(parseEventsScreenId(`${EVENTS_SCREEN_ID}:supermassivo:0`)?.tab).toBe('koth');
  });

  it('página absurda é limitada', () => {
    const target = parseEventsScreenId(`${EVENTS_SCREEN_ID}:koth:999999999`);

    expect(target?.page).toBeLessThanOrEqual(99);
  });
});

describe('a leitura de um card', () => {
  it('contestado ganha de tudo: a barra parou, e não é por falta de gente', () => {
    expect(phaseOf(live({ contested: true, inside: 6 }))).toBe('contested');
    expect(stateLine(live({ contested: true }))).toContain('CONTESTADO');
  });

  it('área vazia com progresso é GUARDADO, não vazio', () => {
    // O progresso é do evento e nunca volta a zero: quem chegar
    // continua de onde o outro parou.
    expect(phaseOf(live({ inside: 0, percent: 65 }))).toBe('paused');
    expect(stateLine(live({ inside: 0, percent: 65 }))).toContain('guardado por Os Bravos');
  });

  it('a equipe de quem abriu o menu é dita como SUA', () => {
    expect(stateLine(live({ mine: true }))).toBe('sua equipe está dominando');
  });

  it('o card encerrado diz quem levou', () => {
    expect(stateLine(ended())).toBe('levou: Lobos do Sul');
  });

  it('vencedor sem nome não vira uma equipe chamada vazio', () => {
    expect(stateLine(ended({ winnerName: null }))).toBe('terminou — uma equipe levou');
  });

  it('expirado diz que ninguém levou', () => {
    expect(stateLine(ended({ outcome: 'expired', winnerName: null }))).toContain('ninguém dominou');
  });
});

describe('o relógio e o "há quanto tempo"', () => {
  it('conta em minuto e segundo', () => {
    expect(clock(754)).toBe('12:34');
  });

  it('acima de uma hora mostra a hora', () => {
    expect(clock(3723)).toBe('1:02:03');
  });

  it('agora é agora', () => {
    expect(ago(NOW - 20_000, NOW)).toBe('agora');
  });

  it('doze minutos', () => {
    expect(ago(NOW - 12 * 60_000, NOW)).toBe('há 12 min');
  });

  it('sem hora, não inventa', () => {
    expect(ago(null, NOW)).toBe('');
  });
});

describe('a tela', () => {
  it('mostra o território de pé com a grade e a porcentagem', () => {
    const screen = buildEventsScreen({
      data: { koth: [live()], dungeon: null, vagas: 2 },
      now: NOW,
    });

    const written = texts(screen.elements);

    expect(written).toContain('Colina do Norte');
    expect(written).toContain('N14');
    expect(written).toContain('40%');
  });

  it('servidor sem resposta NÃO vira "não tem evento"', () => {
    const screen = buildEventsScreen({
      data: { koth: [], dungeon: null, vagas: 2, failure: 'O RCON não respondeu.' },
      now: NOW,
    });

    const written = texts(screen.elements).join(' ');

    expect(written).toContain('Não consegui perguntar');
    expect(written).not.toContain('Nenhum território agora');
  });

  it('sem nada acontecendo, diz isso — e explica o que esperar', () => {
    const screen = buildEventsScreen({
      data: { koth: [], dungeon: null, vagas: 2 },
      now: NOW,
    });

    expect(texts(screen.elements).join(' ')).toContain('Nenhum território agora');
  });

  it('a página seguinte só existe quando há card para ela', () => {
    const poucos = buildEventsScreen({
      data: { koth: [live(), ended()], dungeon: null, vagas: 2 },
      now: NOW,
    });

    // Sem paginador: as setas de uma página só são um controle que
    // não faz nada.
    expect(targets(poucos.elements).some((id) => id.endsWith(':1'))).toBe(false);

    const muitos = buildEventsScreen({
      data: {
        koth: Array.from({ length: CARDS_PER_PAGE + 2 }, (_, index) =>
          live({ runId: String(index), name: `T${String(index)}` }),
        ),
        dungeon: null,
        vagas: 6,
      },
      now: NOW,
    });

    expect(targets(muitos.elements).some((id) => id === eventsScreenId('koth', 1))).toBe(true);
  });

  it('a segunda página mostra os cards seguintes, e não os primeiros', () => {
    const cards = Array.from({ length: CARDS_PER_PAGE + 1 }, (_, index) =>
      live({ runId: String(index), name: `T${String(index)}` }),
    );

    const screen = buildEventsScreen({
      data: { koth: cards, dungeon: null, vagas: 6 },
      target: { tab: 'koth', page: 1, detail: null },
      now: NOW,
    });

    const written = texts(screen.elements);

    expect(written).toContain('T4');
    expect(written).not.toContain('T0');
  });

  it('a sidebar não navega para a aba em que já se está', () => {
    const screen = buildEventsScreen({
      data: { koth: [live()], dungeon: null, vagas: 2 },
      now: NOW,
    });

    // Um botão que leva para onde já se está é um clique que não
    // faz nada, com o hover prometendo o contrário.
    expect(targets(screen.elements)).not.toContain(EVENTS_SCREEN_ID);
    expect(targets(screen.elements)).toContain(eventsScreenId('masmorra'));
  });

  it('a masmorra tem a aba dela, e ela diz quando não há nenhuma', () => {
    const vazia = buildEventsScreen({
      data: { koth: [], dungeon: null, vagas: 1 },
      target: { tab: 'masmorra', page: 0, detail: null },
      now: NOW,
    });

    expect(texts(vazia.elements).join(' ')).toContain('Nenhuma masmorra de pé');

    const cheia = buildEventsScreen({
      data: {
        koth: [],
        dungeon: { name: 'O Labirinto', grid: 'F6', startedAt: NOW - 600_000 },
        vagas: 1,
      },
      target: { tab: 'masmorra', page: 0, detail: null },
      now: NOW,
    });

    expect(texts(cheia.elements)).toContain('O Labirinto');
  });
});

describe('o modal de detalhes', () => {
  it('abre como modal, e traz os números do território', () => {
    const screen = buildEventsScreen({
      data: { koth: [live()], dungeon: null, vagas: 2 },
      target: { tab: 'koth', page: 0, detail: '52' },
      now: NOW,
    });

    expect(screen.kind).toBe('modal');

    const written = texts(screen.elements).join(' ');

    expect(written).toContain('Colina do Norte');
    expect(written).toContain('15 min dominando');
    expect(written).toContain('30 m');
  });

  it('evento que acabou entre a lista e o clique não abre modal vazio', () => {
    const screen = buildEventsScreen({
      data: { koth: [live()], dungeon: null, vagas: 2 },
      target: { tab: 'koth', page: 0, detail: 'nao-existe' },
      now: NOW,
    });

    expect(texts(screen.elements).join(' ')).toContain('não está mais aí');
  });

  it('o detalhe de uma vaga encerrada fala do resultado, não da disputa', () => {
    const screen = buildEventsScreen({
      data: { koth: [ended()], dungeon: null, vagas: 2 },
      target: { tab: 'koth', page: 0, detail: '51' },
      now: NOW,
    });

    const written = texts(screen.elements).join(' ');

    expect(written).toContain('Último resultado');
    expect(written).toContain('há 12 min');
    expect(written).not.toContain('Na área');
  });
});

describe('o provedor', () => {
  /**
   * O texto do PACOTE, que é CUI e não `UiElement`.
   *
   * O provedor entrega o que vai pelo fio; a leitura por
   * `UiElement` é da tela, antes da conversão.
   */
  function cuiTexts(bundle: { readonly cui: readonly { readonly components: readonly unknown[] }[] } | null): string[] {
    return (bundle?.cui ?? []).flatMap((element) =>
      element.components.map((component) => String((component as { text?: unknown }).text ?? '')),
    );
  }

  const document: UiDocument = {
    slug: 'menu',
    name: 'Menu',
    screens: [],
    shell: [],
    shortcuts: [],
    version: 1,
  } as unknown as UiDocument;

  function provider(options: {
    live?: readonly KothCard[];
    recent?: readonly KothCard[];
    vagas?: number;
    fail?: boolean;
    team?: string | null;
  }) {
    return createEventsScreenProvider({
      liveKoth: () =>
        options.fail === true
          ? Promise.reject(new Error('O RCON não respondeu.'))
          : Promise.resolve(options.live ?? []),
      recentKoth: (_serverId, limit) => (options.recent ?? []).slice(0, limit),
      vagasOf: () => options.vagas ?? 2,
      liveDungeon: () => null,
      teamIdOf: () => Promise.resolve(options.team ?? null),
    });
  }

  it('não responde por endereço que não é dele', async () => {
    const bundle = await provider({})({
      serverId: 'server01',
      document,
      screenId: 'tela-equipe',
      steamId: '1',
    });

    expect(bundle).toBeNull();
  });

  it('a vaga vazia é preenchida com o último resultado', async () => {
    const bundle = await provider({
      live: [live()],
      recent: [ended(), ended({ runId: '50' }), ended({ runId: '49' })],
      vagas: 3,
    })({ serverId: 'server01', document, screenId: EVENTS_SCREEN_ID, steamId: '1' });

    const written = cuiTexts(bundle);

    // Três vagas, um de pé: dois encerrados completam — e o
    // terceiro fica de fora, porque não há vaga para ele.
    expect(written).toContain('Colina do Norte');
    expect(written.filter((text) => text === 'Vale do Rio')).toHaveLength(2);
  });

  it('quando não dá para perguntar, não inventa histórico no lugar', async () => {
    const bundle = await provider({ fail: true, recent: [ended()], vagas: 3 })({
      serverId: 'server01',
      document,
      screenId: EVENTS_SCREEN_ID,
      steamId: '1',
    });

    const written = cuiTexts(bundle).join(' ');

    expect(written).toContain('Não consegui perguntar');
    expect(written).not.toContain('Vale do Rio');
  });

  it('a equipe de quem abriu o menu é marcada no card', async () => {
    const bundle = await provider({ live: [live({ holderId: '7' })], team: '7' })({
      serverId: 'server01',
      document,
      screenId: EVENTS_SCREEN_ID,
      steamId: '1',
    });

    expect(cuiTexts(bundle)).toContain('sua equipe está dominando');
  });

  it('a tela sai VOLÁTIL: uma barra de captura em cache manda o jogador para um evento que acabou', async () => {
    const bundle = await provider({ live: [live()] })({
      serverId: 'server01',
      document,
      screenId: EVENTS_SCREEN_ID,
      steamId: '1',
    });

    expect(bundle?.volatile).toBe(true);
  });
});

describe('o menu que já está gravado', () => {
  /** O botão que faz daquele documento um MENU. */
  const navButton = {
    id: 'nav-eventos',
    name: 'nav-eventos',
    type: 'button',
    rect: {
      anchorMin: { x: 0, y: 0 },
      anchorMax: { x: 0, y: 0 },
      offsetMin: { x: 0, y: 0 },
      offsetMax: { x: 10, y: 10 },
    },
    color: '#000',
    sprite: null,
    text: 'EVENTOS',
    fontSize: 12,
    font: 'RobotoCondensed-Bold.ttf',
    textColor: '#fff',
    align: 'MiddleCenter',
    action: { id: 'a-nav-eventos', kind: 'navigate', screenId: EVENTS_SCREEN_ID },
    hoverColor: null,
    pressedColor: null,
    activeColor: null,
    activeTextColor: null,
    activeOnScreenId: null,
    children: [],
  };

  function withScreens(screens: readonly unknown[], withTab = true): UiDocument {
    return {
      slug: 'menu',
      name: 'Menu',
      screens,
      shell: withTab ? [navButton] : [],
      shortcuts: [],
      version: 1,
    } as unknown as UiDocument;
  }

  it('o cartaz vira a tela viva, e ela nasce marcada', () => {
    const upgraded = withEventsScreen(
      withScreens([{ id: EVENTS_SCREEN_ID, name: 'EVENTOS', kind: 'page', elements: [] }]),
    );

    const screen = upgraded?.screens.find((entry) => entry.id === EVENTS_SCREEN_ID);

    // Sem a marca, o plugin desenha o que está no disco e NUNCA
    // pede a tela de verdade.
    expect(screen?.generated).toBe(true);
  });

  it('menu já migrado não é reescrito a cada boot', () => {
    const once = withEventsScreen(
      withScreens([{ id: EVENTS_SCREEN_ID, name: 'EVENTOS', kind: 'page', elements: [] }]),
    );

    expect(withEventsScreen(once as UiDocument)).toBeNull();
  });

  it('menu sem a tela ganha uma, em vez de ficar com o botão mudo', () => {
    const upgraded = withEventsScreen(withScreens([]));

    expect(upgraded?.screens.some((entry) => entry.id === EVENTS_SCREEN_ID)).toBe(true);
  });

  // ####  NEM TODO DOCUMENTO É O MENU  ####
  //
  // ACONTECEU: a primeira versão desta passagem pôs a tela no
  // overlay de propaganda, que não tem aba nenhuma — e o dono edita
  // aquele documento em /propaganda.
  it('documento SEM a aba não ganha tela nenhuma', () => {
    expect(withEventsScreen(withScreens([], false))).toBeNull();
  });

  it('e o que já ganhou por engano perde no boot seguinte', () => {
    const sujo = withEventsScreen(withScreens([]));
    const limpo = withEventsScreen(withScreens(sujo?.screens ?? [], false));

    expect(limpo?.screens.some((entry) => entry.id === EVENTS_SCREEN_ID)).toBe(false);
  });

  it('mas uma tela DESENHADA por alguém não é apagada', () => {
    const minha = {
      id: EVENTS_SCREEN_ID,
      name: 'EVENTOS',
      kind: 'page',
      elements: [
        {
          id: 'meu-cartaz',
          name: 'meu-cartaz',
          type: 'label',
          rect: {
            anchorMin: { x: 0, y: 0 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: 0, y: 0 },
            offsetMax: { x: 0, y: 0 },
          },
          text: 'meu',
          fontSize: 12,
          font: 'RobotoCondensed-Regular.ttf',
          color: '#fff',
          align: 'MiddleCenter',
          children: [],
        },
      ],
      generated: true,
    };

    expect(withEventsScreen(withScreens([minha], false))).toBeNull();
  });
});
