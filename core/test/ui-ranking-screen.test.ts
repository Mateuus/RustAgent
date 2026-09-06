// ============================================================
//  ui-ranking-screen.test.ts  -  a página RANKING do menu do jogo.
//
//  ####  O TESTE QUE MAIS IMPORTA DESTE ARQUIVO  ####
//
//  É o do §3: a coluna cheia de rankings, dez nomes no limite do
//  que a Steam permite, com acento e símbolo (que valem 2 e 3
//  bytes cada em UTF-8), e o documento inteiro medido em base64
//  contra os 50.000 do frame do WebRCON. É o teste que impede o
//  incidente — uma tela que estoura o teto não dá erro no jogo:
//  ela simplesmente não abre.
//
//  O resto guarda as decisões do redesenho de 06/09/2026:
//
//    1. o endereço: a coluna NAVEGA, e leva a página dela junto;
//    2. a coluna pagina em vez de truncar, e o item aberto não é
//       um botão;
//    3. o teto do RCON;
//    4. a linha do próprio jogador aparece no rodapé da lista;
//    5. lista vazia é uma FRASE, e nunca uma tabela sem linhas;
//    6. o aviso da coleta aparece UMA VEZ, e `never` não é
//       apresentado como defeito.
// ============================================================

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RankingRecord } from '../src/db/rankings-repository.js';
import { ApiError } from '../src/http/error-response.js';
import {
  buildRankingScreen,
  columnLabel,
  createRankingScreenProvider,
  emptyRankingView,
  formatPlaytime,
  formatRankingValue,
  parseRankingScreenId,
  RANKING_COLUMN_PAGE_SIZE,
  RANKING_PAGE_SIZE,
  RANKING_SCREEN_ID,
  rankingScreenId,
  readRankingView,
  type RankingScreenEntry,
  type RankingScreenReader,
  type RankingScreenView,
} from '../src/game/ui-ranking-screen.js';
import { screenContentToCui } from '../src/game/ui-cui.js';
import { buildMainMenu, MAIN_MENU_SLUG } from '../src/game/ui-preset-main-menu.js';
import { createLogger } from '../src/logger.js';
import {
  COVERAGE_MESSAGES,
  gameLabelOf,
  type CoverageStatus,
  type LeaderboardResult,
} from '../src/rankings/service.js';
import {
  findDocumentProblems,
  uiDocumentSchema,
  walkElements,
  type UiElement,
  type UiScreen,
} from '../src/types/ui-document.js';
import {
  encodeUiScreenPayload,
  toGeneratedScreenBundle,
  UI_DOC_MAX_BYTES,
} from '../src/types/ui-transport.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

const SERVER = 'pvp1';
/** Um SteamID64 de verdade tem 17 dígitos, e o plugin exige isso. */
const PLAYER = '76561198000000001';

/** Um instante fixo: "medido desde" só é conferível contra um. */
const MEASURED_SINCE = Date.UTC(2026, 8, 1, 12, 0, 0);

// ------------------------------------------------------------
//  Fábricas
// ------------------------------------------------------------

const ranking = (over: Partial<RankingRecord> = {}): RankingRecord => ({
  id: 'abates',
  metric: 'pvp.kills',
  label: 'Abates',
  shortLabel: null,
  unit: 'abates',
  description: null,
  source: 'plugin',
  valueKind: 'counter',
  direction: 'desc',
  window: 'season',
  globalEligible: true,
  builtin: true,
  enabled: true,
  showInGame: true,
  sortOrder: 10,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const screenRanking = (over: Partial<RankingRecord> = {}) => {
  const record = ranking(over);

  return {
    metric: record.metric,
    label: gameLabelOf(record),
    unit: record.unit,
    valueKind: record.valueKind,
  };
};

const entry = (position: number, over: Partial<RankingScreenEntry> = {}): RankingScreenEntry => ({
  position,
  name: `Jogador ${String(position)}`,
  value: 1000 - position,
  mine: false,
  ...over,
});

const view = (over: Partial<RankingScreenView> = {}): RankingScreenView => ({
  rankings: [screenRanking()],
  active: screenRanking(),
  page: 0,
  pages: 1,
  columnPage: 0,
  columnPages: 1,
  entries: Array.from({ length: 3 }, (_unused, index) => entry(index + 1)),
  total: 3,
  self: null,
  measuredSince: MEASURED_SINCE,
  coverage: 'ok',
  trouble: null,
  ...over,
});

/** N rankings, para medir o que a coluna faz quando eles sobram. */
const manyRankings = (count: number) =>
  Array.from({ length: count }, (_unused, index) =>
    screenRanking({ metric: `m${String(index)}`, label: `Ranking ${String(index)}` }),
  );

/** O que o jogo de fato recebe: a tela já convertida em CUI. */
const drawn = (screen: UiScreen): string =>
  JSON.stringify(screenContentToCui(buildMainMenu(), screen));

const elementsOf = (screen: UiScreen): readonly UiElement[] =>
  [...walkElements(screen.elements)].map((found) => found.element);

const byId = (screen: UiScreen, id: string): UiElement | undefined =>
  elementsOf(screen).find((element) => element.id === id);

/** Os itens da coluna, na ordem em que foram desenhados. */
const columnItems = (screen: UiScreen): readonly UiElement[] =>
  elementsOf(screen).filter((element) => /^rkc\d+$/.test(element.id));

/** O texto de um item da coluna — no botão ele é próprio, no ativo é filho. */
const columnText = (item: UiElement | undefined): string => {
  if (item?.type === 'button') {
    return item.text;
  }

  const inner = item?.children.find((child) => child.type === 'label');

  return inner?.type === 'label' ? inner.text : '';
};

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ------------------------------------------------------------
//  §1  O ENDEREÇO
// ------------------------------------------------------------

describe('o endereço da tela de ranking', () => {
  it('aceita os endereços válidos, e as partes finais só são página se forem número', () => {
    expect(parseRankingScreenId('tela-ranking')).toEqual({
      metric: null,
      page: 0,
      columnPage: null,
    });
    expect(parseRankingScreenId('tela-ranking:pvp.kills')).toEqual({
      metric: 'pvp.kills',
      page: 0,
      columnPage: null,
    });
    expect(parseRankingScreenId('tela-ranking:pvp.kills:2')).toEqual({
      metric: 'pvp.kills',
      page: 2,
      columnPage: null,
    });

    // A página da COLUNA é a terceira parte, e a da lista continua
    // sendo a segunda.
    expect(parseRankingScreenId('tela-ranking:pvp.kills:2:1')).toEqual({
      metric: 'pvp.kills',
      page: 2,
      columnPage: 1,
    });
    expect(parseRankingScreenId('tela-ranking:pvp.kills:0:3')).toEqual({
      metric: 'pvp.kills',
      page: 0,
      columnPage: 3,
    });

    // Uma parte só é a MÉTRICA, nunca a página: um ranking chamado
    // "2" continua sendo um ranking.
    expect(parseRankingScreenId('tela-ranking:2')).toEqual({
      metric: '2',
      page: 0,
      columnPage: null,
    });

    // E uma métrica com `:` no meio sobrevive: o que se procura são
    // os sufixos numéricos, e não o primeiro separador.
    expect(parseRankingScreenId('tela-ranking:troféu:bleik:3')).toEqual({
      metric: 'troféu:bleik',
      page: 3,
      columnPage: null,
    });
    expect(parseRankingScreenId('tela-ranking:troféu:bleik:3:1')).toEqual({
      metric: 'troféu:bleik',
      page: 3,
      columnPage: 1,
    });
  });

  it('recusa o que não é dele, e NUNCA lança', () => {
    // O pedido veio do plugin, e o jogador está com o aviso de
    // carregando na tela: uma exceção aqui viraria espera até o
    // timeout.
    for (const lixo of [
      '',
      'tela-kits',
      'tela-calendario',
      'ozkit:kit-inicial:itens',
      'tela-ranking-outro',
      'TELA-RANKING',
      ' tela-ranking',
    ]) {
      expect(() => parseRankingScreenId(lixo)).not.toThrow();
      expect(parseRankingScreenId(lixo)).toBeNull();
    }
  });

  it('apara a página absurda em vez de mandá-la ao banco', () => {
    // O id vem do plugin: `OFFSET 99999999990` é uma consulta que
    // ninguém pediu.
    const target = parseRankingScreenId('tela-ranking:pvp.kills:99999999999');

    expect(target?.page).toBeLessThanOrEqual(9_999);
    expect(parseRankingScreenId('tela-ranking:pvp.kills:0')?.page).toBe(0);

    // E a da coluna também: ela vira `slice` de um array.
    expect(parseRankingScreenId('tela-ranking:x:0:99999999999')?.columnPage).toBeLessThanOrEqual(
      9_999,
    );
  });

  it('o que está no padrão não carrega número no endereço', () => {
    expect(rankingScreenId('pvp.kills')).toBe('tela-ranking:pvp.kills');
    expect(rankingScreenId('pvp.kills', 2)).toBe('tela-ranking:pvp.kills:2');
    expect(rankingScreenId(null)).toBe(RANKING_SCREEN_ID);

    // A página da coluna obriga a da lista a aparecer mesmo em
    // zero: as duas são POSICIONAIS, e `:1` sozinho seria lido como
    // página da lista.
    expect(rankingScreenId('pvp.kills', 0, 1)).toBe('tela-ranking:pvp.kills:0:1');
    expect(rankingScreenId('pvp.kills', 2, 3)).toBe('tela-ranking:pvp.kills:2:3');
  });

  it('o que sai do construtor volta igual no leitor', () => {
    // O endereço é o único estado desta tela: se a volta não for
    // fiel, o jogador perde a página em que estava.
    for (const [metric, page, column] of [
      ['pvp.kills', 0, 0],
      ['pvp.kills', 4, 0],
      ['pvp.kills', 0, 2],
      ['troféu:bleik', 7, 1],
    ] satisfies [string, number, number][]) {
      const target = parseRankingScreenId(rankingScreenId(metric, page, column));

      expect(target?.metric).toBe(metric);
      expect(target?.page).toBe(page);
      expect(target?.columnPage ?? 0).toBe(column);
    }
  });
});

// ------------------------------------------------------------
//  §2  A COLUNA
// ------------------------------------------------------------

describe('a coluna de rankings', () => {
  const three = [
    screenRanking(),
    screenRanking({ metric: 'pvp.deaths', label: 'Mortes' }),
    screenRanking({ metric: 'time.played', label: 'Tempo online', unit: 'segundos' }),
  ];

  it('o item ATIVO é um painel; os outros são botões que NAVEGAM', () => {
    // ####  UM BOTÃO QUE NAVEGA PARA ONDE JÁ SE ESTÁ PARECE DEFEITO  ####
    const screen = buildRankingScreen({
      view: view({ rankings: three, active: three[1] }),
    });

    expect(byId(screen, 'rkc0')?.type).toBe('button');
    expect(byId(screen, 'rkc1')?.type).toBe('panel');
    expect(byId(screen, 'rkc2')?.type).toBe('button');

    const first = byId(screen, 'rkc0');

    // `navigate`, e não `modal.open`: isto é uma PÁGINA, e o
    // `modal.open` abriria a tela de ranking por cima da tela de
    // ranking.
    expect(first?.type === 'button' ? first.action : null).toEqual({
      id: 'arkc0',
      kind: 'navigate',
      screenId: 'tela-ranking:pvp.kills',
    });
  });

  it('mostra o nome CURTO quando ele existe, e o inteiro quando não', () => {
    const catalog = [
      screenRanking({ label: 'Poder de raid', shortLabel: 'Raid' }),
      screenRanking({ metric: 'pvp.deaths', label: 'Mortes' }),
    ];

    const screen = buildRankingScreen({ view: view({ rankings: catalog, active: catalog[0] }) });

    expect(columnText(byId(screen, 'rkc0'))).toBe('RAID');
    expect(columnText(byId(screen, 'rkc1'))).toBe('MORTES');
  });

  it('o nome inteiro cabe na coluna; só o absurdo é cortado', () => {
    // A coluna é larga JUSTAMENTE para isto: onde a aba de 78 px
    // truncava "Tiro mais l…", o nome agora entra inteiro.
    expect(columnLabel('Tiro mais longo')).toBe('TIRO MAIS LONGO');
    expect(columnLabel('Tempo online')).toBe('TEMPO ONLINE');

    const absurdo = columnLabel('Tiro mais longo do servidor inteiro, sem exceção');

    expect(absurdo.endsWith('…')).toBe(true);
    expect(absurdo.length).toBeLessThan('Tiro mais longo do servidor inteiro, sem exceção'.length);
  });

  it('com muitos rankings ela PAGINA, e não trunca', () => {
    const many = manyRankings(RANKING_COLUMN_PAGE_SIZE + 5);
    const first = many.slice(0, RANKING_COLUMN_PAGE_SIZE);

    const screen = buildRankingScreen({
      view: view({
        rankings: first,
        active: first[0],
        columnPage: 0,
        columnPages: 2,
      }),
    });

    // A página inteira é desenhada — nada de "+5" no rodapé.
    expect(columnItems(screen)).toHaveLength(RANKING_COLUMN_PAGE_SIZE);

    const acoes = elementsOf(screen)
      .filter((element) => element.type === 'button')
      .map((element) => (element.type === 'button' ? element.action : null));

    // A seta da coluna leva a página da LISTA junto: virar a coluna
    // não é sair do ranking que se está lendo.
    expect(acoes).toContainEqual({
      id: 'arkcpgx',
      kind: 'navigate',
      screenId: 'tela-ranking:m0:0:1',
    });
  });

  it('trocar de ranking PRESERVA a página da coluna', () => {
    // ####  O DEDO DO JOGADOR ESTÁ NA SEGUNDA PÁGINA  ####
    //
    // Sem isto, escolher um ranking do fim da lista jogaria a
    // coluna de volta ao começo no mesmo clique — e o item recém
    // escolhido sumiria de vista.
    const many = manyRankings(RANKING_COLUMN_PAGE_SIZE + 5);
    const second = many.slice(RANKING_COLUMN_PAGE_SIZE);

    const screen = buildRankingScreen({
      view: view({
        rankings: second,
        active: second[0],
        columnPage: 1,
        columnPages: 2,
        page: 3,
        pages: 9,
      }),
    });

    const alvos = elementsOf(screen)
      .filter((element) => /^rkc\d+$/.test(element.id) && element.type === 'button')
      .map((element) =>
        element.type === 'button' && element.action.kind === 'navigate'
          ? element.action.screenId
          : '',
      );

    expect(alvos.length).toBeGreaterThan(0);

    for (const alvo of alvos) {
      // A página da coluna viaja; a da lista volta a zero, porque a
      // página 3 do ranking anterior não quer dizer nada no novo.
      expect(alvo.endsWith(':0:1')).toBe(true);
    }
  });

  it('a paginação da coluna vem da LEITURA, e ela abre onde o ativo está', async () => {
    const catalog = Array.from({ length: RANKING_COLUMN_PAGE_SIZE + 3 }, (_unused, index) =>
      ranking({ id: `r${String(index)}`, metric: `m${String(index)}`, label: `R ${String(index)}` }),
    );

    const reader: RankingScreenReader = {
      metrics: () => catalog,
      leaderboard: async () => await Promise.reject(new ApiError('RANKING_NOT_MEASURED', 'x', 409)),
      playerRankings: () => [],
    };

    // O último ranking está na SEGUNDA página da coluna, e o
    // endereço não disse nada sobre ela.
    const last = catalog[catalog.length - 1];
    const lida = await readRankingView({
      rankings: reader,
      serverId: SERVER,
      steamId: PLAYER,
      target: { metric: last?.metric ?? '', page: 0 },
    });

    expect(lida.columnPages).toBe(2);
    expect(lida.columnPage).toBe(1);
    // E só a página dela atravessa o RCON: o resto do catálogo não
    // vai ser desenhado, então não viaja.
    expect(lida.rankings).toHaveLength(3);
    expect(lida.rankings.some((item) => item.metric === last?.metric)).toBe(true);

    // Com endereço, manda o endereço: ali foi o jogador quem virou.
    const pedida = await readRankingView({
      rankings: reader,
      serverId: SERVER,
      steamId: PLAYER,
      target: { metric: last?.metric ?? '', page: 0, columnPage: 0 },
    });

    expect(pedida.columnPage).toBe(0);
    expect(pedida.rankings).toHaveLength(RANKING_COLUMN_PAGE_SIZE);
  });

  it('o ranking escondido do jogo não aparece na coluna', async () => {
    // `showInGame` é do ADMIN: o ranking escondido continua ligado,
    // continua contando e continua no painel.
    const catalog = [
      ranking(),
      ranking({ id: 'mortes', metric: 'pvp.deaths', label: 'Mortes' }),
      ranking({ id: 'secreto', metric: 'x.secreto', label: 'Secreto', showInGame: false }),
    ];

    const provider = createRankingScreenProvider({
      rankings: {
        metrics: (options) =>
          catalog.filter((item) => options?.inGameOnly !== true || item.showInGame),
        leaderboard: async () =>
          await Promise.reject(new ApiError('RANKING_NOT_MEASURED', 'x', 409)),
        playerRankings: () => [],
      },
      logger: silent,
    });

    const json = JSON.stringify(
      (
        await provider({
          serverId: SERVER,
          document: buildMainMenu(),
          screenId: 'tela-ranking',
          steamId: PLAYER,
        })
      )?.cui,
    );

    expect(json).toContain('MORTES');
    expect(json).not.toContain('SECRETO');
  });
});

// ------------------------------------------------------------
//  §3  O TETO DO RCON — o teste que impede o incidente
// ------------------------------------------------------------

describe('o tamanho do documento gerado', () => {
  /**
   * O teto do nome de perfil da Steam, que é o que o Rust mostra.
   *
   * Os caracteres são de propósito: `☠` são TRÊS bytes em UTF-8 e
   * `Ç` são dois. Um teste com nomes ASCII mediria metade do pior
   * caso e passaria justamente onde o de produção estouraria.
   */
  const STEAM_NAME_LIMIT = 32;

  const longName = (index: number): string =>
    `☠ ÇLÃ ÖRIGEMZ ÉÇÃÕ ${String(index)} `
      .padEnd(STEAM_NAME_LIMIT, 'W')
      .slice(0, STEAM_NAME_LIMIT);

  /**
   * Um rótulo de coluna no limite: 27 caracteres, que é onde o
   * `columnLabel` corta. Com acento, para o byte contar em dobro.
   */
  const longLabel = (index: number): string =>
    `Ranking Ção Ãõ ${String(index)} `.padEnd(27, 'Ç').slice(0, 27);

  /** A tela mais pesada que este desenho consegue produzir. */
  const worstCase = () => {
    // O PIOR CASO, item por item: a página da coluna CHEIA, com
    // rótulos e métricas no limite; os DOIS pagers desenhados com
    // as duas setas (só uma página do meio tem as duas); dez nomes
    // no teto da Steam; a faixa do jogador e o aviso da coleta.
    const column = Array.from({ length: RANKING_COLUMN_PAGE_SIZE }, (_unused, index) =>
      screenRanking({
        metric: `ranking.dinamico.numero.${String(index)}`,
        label: longLabel(index),
        unit: 'metros',
        valueKind: 'record',
      }),
    );

    return buildRankingScreen({
      view: view({
        rankings: column,
        active: column[0],
        columnPage: 1,
        columnPages: 3,
        entries: Array.from({ length: RANKING_PAGE_SIZE }, (_unused, index) =>
          entry(index + 1, { name: longName(index), value: 987_654.321 }),
        ),
        total: 4_321,
        pages: 433,
        page: 12,
        self: {
          kind: 'ranked',
          entry: { position: 1_234, name: longName(99), value: 12.5, mine: true },
        },
        coverage: 'no-answer',
      }),
      screenId: 'tela-ranking:ranking.dinamico.numero.0:12:1',
    });
  };

  const encode = (screen: UiScreen): string =>
    encodeUiScreenPayload({
      requestId: 'abcdef0123456789',
      documentId: MAIN_MENU_SLUG,
      screen: toGeneratedScreenBundle(buildMainMenu(), screen, RANKING_SCREEN_ID),
    });

  it('cabe no teto do RCON no pior caso', () => {
    const screen = worstCase();
    const bundle = toGeneratedScreenBundle(buildMainMenu(), screen, RANKING_SCREEN_ID);
    const encoded = encode(screen);

    // ####  MEDIDO EM 06/09/2026: 40.512 BYTES  ####
    //
    // Contra os 50.000 do frame do WebRCON — folga de 9.488, ou
    // 19%. A trava fica em 42.000 e não no teto: ela é o AVISO,
    // não o limite, e existe para soar enquanto ainda dá tempo de
    // reagir. Quando soar, o que muda é o tamanho de uma das duas
    // páginas — `RANKING_PAGE_SIZE` ou a altura de `COLUMN.item`,
    // que é quem decide `RANKING_COLUMN_PAGE_SIZE` — e nunca o
    // teto, que é do transporte e não desta tela.
    expect(encoded.length).toBeLessThanOrEqual(UI_DOC_MAX_BYTES);
    expect(encoded.length).toBeLessThan(42_000);

    // E a tela nunca é guardada: ela diz "você está em 1.234º".
    expect(bundle.volatile).toBe(true);
    // O SHELL entra na tabela de ações: sem isso o plugin recusaria
    // o clique em HOME enquanto o jogador estivesse aqui.
    expect(Object.keys(bundle.actions)).toContain('ir-home');
  });

  it('é a PAGINAÇÃO da coluna que segura o documento no teto', () => {
    // ####  VINTE RANKINGS DE UMA VEZ ESTOURARIAM A TELA  ####
    //
    // Sem paginar, um servidor com vinte rankings ligados mandaria
    // uma coluna de vinte itens — e o frame passaria de 47 KB, a
    // 3 KB do teto, com o resto da tela ainda por cima. É por isso
    // que a coluna pagina em vez de crescer: o limite do CUI não é
    // a altura da tela, é o tamanho do comando.
    const twenty = Array.from({ length: 20 }, (_unused, index) =>
      screenRanking({
        metric: `ranking.dinamico.numero.${String(index)}`,
        label: longLabel(index),
        unit: 'metros',
        valueKind: 'record',
      }),
    );

    const semPaginar = buildRankingScreen({
      view: view({
        rankings: twenty,
        active: twenty[0],
        columnPages: 1,
        entries: Array.from({ length: RANKING_PAGE_SIZE }, (_unused, index) =>
          entry(index + 1, { name: longName(index), value: 987_654.321 }),
        ),
        total: 4_321,
        pages: 433,
        page: 12,
        self: {
          kind: 'ranked',
          entry: { position: 1_234, name: longName(99), value: 12.5, mine: true },
        },
        coverage: 'no-answer',
      }),
    });

    expect(encode(semPaginar).length).toBeGreaterThan(encode(worstCase()).length);
    // A leitura nunca deixa isso chegar ao desenho: ela recorta.
    expect(RANKING_COLUMN_PAGE_SIZE).toBeLessThan(20);
  });

  it('o id que volta é o id que foi pedido', () => {
    // O plugin DESCARTA a tela cujo id não bate com o que ele
    // pediu, e o "carregando" fica preso até o timeout.
    const screen = buildRankingScreen({
      view: view(),
      screenId: 'tela-ranking:pvp.kills:3:1',
    });

    expect(screen.id).toBe('tela-ranking:pvp.kills:3:1');
  });

  it('a seta de página é um ENDEREÇO, e não um evento', () => {
    const screen = buildRankingScreen({
      view: view({ pages: 4, page: 1, total: 40, columnPage: 2, columnPages: 4 }),
      screenId: 'tela-ranking:pvp.kills:1:2',
    });

    const acoes = elementsOf(screen)
      .filter((element) => element.type === 'button')
      .map((element) => (element.type === 'button' ? element.action : null));

    // E a página da COLUNA vai junto: virar a lista não pode fazer
    // a coluna esquecer onde estava.
    expect(acoes).toContainEqual({
      id: 'arkpgx',
      kind: 'navigate',
      screenId: 'tela-ranking:pvp.kills:2:2',
    });
    expect(acoes).toContainEqual({
      id: 'arkpgp',
      kind: 'navigate',
      screenId: 'tela-ranking:pvp.kills:0:2',
    });
  });
});

// ------------------------------------------------------------
//  §4  A LINHA DELE
// ------------------------------------------------------------

describe('a linha do próprio jogador', () => {
  it('aparece mesmo quando ele está fora do top', () => {
    // ####  É A ÚNICA INFORMAÇÃO QUE ELE FOI VER  ####
    const screen = buildRankingScreen({
      view: view({
        self: {
          kind: 'ranked',
          entry: { position: 137, name: null, value: 42, mine: true },
        },
        total: 900,
      }),
    });

    const json = drawn(screen);

    expect(json).toContain('VOCÊ');
    expect(json).toContain('137º');
    // O top continua lá: a faixa dele é separada, e não substitui a
    // lista.
    expect(json).toContain('Jogador 1');
  });

  it('fica alinhada com as colunas da lista', () => {
    // ####  O NÚMERO DELE CAI SOB OS NÚMEROS DE CIMA  ####
    //
    // É o que permite a única comparação que interessa — "quanto
    // falta para o décimo" — sem ninguém procurar qual número é
    // qual.
    const screen = buildRankingScreen({
      view: view({
        self: { kind: 'ranked', entry: { position: 42, name: null, value: 7, mine: true } },
      }),
    });

    const posicao = byId(screen, 'rk-eup');
    const valor = byId(screen, 'rk-euv');
    const linhaPosicao = byId(screen, 'rk-r0p');
    const linhaValor = byId(screen, 'rk-r0v');

    expect(posicao?.rect.offsetMin.x).toBe(linhaPosicao?.rect.offsetMin.x);
    expect(posicao?.rect.offsetMax.x).toBe(linhaPosicao?.rect.offsetMax.x);
    expect(valor?.rect.offsetMin.x).toBe(linhaValor?.rect.offsetMin.x);
    expect(valor?.rect.offsetMax.x).toBe(linhaValor?.rect.offsetMax.x);
  });

  it('quem não pontuou lê isso, e não "em último"', () => {
    const screen = buildRankingScreen({ view: view({ self: { kind: 'unranked' } }) });

    expect(drawn(screen)).toContain('ainda não pontuou');
  });

  it('sem jogador olhando não há faixa nenhuma', () => {
    // A carga que vai ao servidor sem ninguém: um "você" fixo aqui
    // seria lido como o estado de quem abriu o menu.
    const screen = buildRankingScreen({ view: view({ self: null }) });

    expect(byId(screen, 'rk-eu')).toBeUndefined();
  });
});

// ------------------------------------------------------------
//  §5  A LISTA VAZIA, E A COLETA PARADA
// ------------------------------------------------------------

describe('quando não há o que listar', () => {
  it('um ranking sem nada medido mostra a frase, e não uma tabela vazia', () => {
    const screen = buildRankingScreen({
      view: view({ entries: [], total: 0, trouble: 'nao-medido' }),
    });

    expect(drawn(screen)).toContain('não há nada medido');
    // Uma tabela sem linhas afirma, sem dizer, que ninguém pontuou:
    // nem o cabeçalho da coluna nem linha nenhuma são desenhados.
    expect(byId(screen, 'rk-c3')).toBeUndefined();
    expect(byId(screen, 'rk-r0n')).toBeUndefined();
  });

  it('sem ranking nenhum ligado, a tela diz isso — e não fica em branco', () => {
    const screen = buildRankingScreen({ view: view({ rankings: [], active: null, entries: [] }) });

    expect(drawn(screen)).toContain('Nenhum ranking está ligado');
    // E sem coluna: uma barra lateral vazia à esquerda de um aviso
    // é ruído com cara de defeito.
    expect(byId(screen, 'rk-col')).toBeUndefined();
  });

  it('coverage fora de `ok` acusa a COLETA, e não os jogadores', () => {
    // ####  "ZERO" E "NÃO PERGUNTEI" SÃO RESPOSTAS DIFERENTES  ####
    for (const status of ['not-loaded', 'no-answer'] satisfies CoverageStatus[]) {
      const vazio = buildRankingScreen({
        view: view({ entries: [], total: 0, coverage: status }),
      });

      const json = drawn(vazio);

      expect(json).toContain('coleta');
      // A lista vazia não é apresentada como um fato sobre quem joga.
      expect(json).not.toContain('não há nada medido');
      expect(byId(vazio, 'rk-c3')).toBeUndefined();
    }
  });

  it('o aviso da coleta aparece EXATAMENTE UMA VEZ no documento', () => {
    // ####  O TESTE DO DEFEITO  ####
    //
    // Ele já foi desenhado em dois lugares — a faixa do topo e o
    // meio da lista vazia —, e com a lista vazia E a coleta parada
    // o jogador lia a mesma frase duas vezes na mesma tela.
    for (const status of ['never', 'no-answer', 'not-loaded'] satisfies CoverageStatus[]) {
      const frase = COVERAGE_MESSAGES[status];

      expect(frase).not.toBeNull();

      // Com a lista VAZIA, que era o caso do defeito.
      expect(occurrences(drawn(buildRankingScreen({
        view: view({ entries: [], total: 0, coverage: status }),
      })), frase ?? '')).toBe(1);

      // E com a lista CHEIA, onde ele também precisa aparecer.
      expect(occurrences(drawn(buildRankingScreen({ view: view({ coverage: status }) })), frase ?? '')).toBe(1);
    }
  });

  it('os três estados dizem coisas DIFERENTES, e nenhuma é escrita nesta tela', () => {
    const frases = (['never', 'no-answer', 'not-loaded'] satisfies CoverageStatus[]).map(
      (status) => COVERAGE_MESSAGES[status] ?? '',
    );

    // Três frases, três textos: `never` num ranking que nasceu hoje
    // não pode dizer o que "a coleta parou" diz.
    expect(new Set(frases).size).toBe(3);

    for (const [index, status] of (
      ['never', 'no-answer', 'not-loaded'] satisfies CoverageStatus[]
    ).entries()) {
      expect(drawn(buildRankingScreen({ view: view({ coverage: status }) }))).toContain(
        frases[index] ?? '',
      );
    }

    // ####  E ELAS MORAM NO SERVIÇO, NÃO AQUI  ####
    //
    // Escritas aqui, elas divergiriam das do painel no primeiro
    // ajuste — e o jogador e o admin passariam a ler duas versões
    // da mesma história.
    const fonte = readFileSync(
      new URL('../src/game/ui-ranking-screen.ts', import.meta.url),
      'utf8',
    );

    for (const frase of frases) {
      expect(fonte).not.toContain(frase);
    }
  });

  it('`never` não é pintado como defeito', () => {
    // ####  "AINDA NÃO COLETOU" NÃO É "A COLETA QUEBROU"  ####
    //
    // Foi o que motivou este trabalho: o dono viu "a coleta não
    // responde" num ranking criado no mesmo dia.
    const novo = byId(buildRankingScreen({ view: view({ coverage: 'never' }) }), 'rk-aviso');
    const parado = byId(buildRankingScreen({ view: view({ coverage: 'no-answer' }) }), 'rk-aviso');

    expect(novo?.type === 'label' ? novo.color : null).not.toBe(
      parado?.type === 'label' ? parado.color : '',
    );
  });

  it('o aviso aparece mesmo com a lista cheia: os números podem estar atrasados', () => {
    const screen = buildRankingScreen({ view: view({ coverage: 'no-answer' }) });
    const json = drawn(screen);

    expect(json).toContain('podem estar atrasados');
    // E a lista continua: o aviso é sobre a idade dos números.
    expect(json).toContain('Jogador 1');
  });

  it('"medido desde" está na tela sempre que houver janela', () => {
    // Um ranking premiado que não diz desde quando mede é um
    // ranking que vai ser contestado.
    expect(drawn(buildRankingScreen({ view: view() }))).toContain('medido desde');
  });
});

// ------------------------------------------------------------
//  §6  O VALOR, PELA NATUREZA DO RANKING
// ------------------------------------------------------------

describe('o valor formatado', () => {
  it('contador com milhar, recorde com uma casa e a unidade, razão com duas', () => {
    expect(formatRankingValue(1_284, screenRanking())).toBe('1.284');
    expect(formatRankingValue(412.47, screenRanking({ valueKind: 'record', unit: 'metros' }))).toBe(
      '412,5 metros',
    );
    expect(formatRankingValue(1.3247, screenRanking({ valueKind: 'ratio', unit: null }))).toBe(
      '1,32',
    );
  });

  it('o tempo online vira duração, e não um milhão de segundos', () => {
    const played = screenRanking({ metric: 'time.played', unit: 'segundos' });

    expect(formatRankingValue(1_140_523, played)).toBe('13 d 4 h');
    expect(formatRankingValue(45, played)).toBe('45 s');
    expect(formatRankingValue(3_599, played)).toBe('59 min');
    expect(formatPlaytime(86_400)).toBe('1 d');
    // Arredondar para CIMA inventaria tempo que ninguém jogou.
    expect(formatPlaytime(3_599)).toBe('59 min');
  });
});

// ------------------------------------------------------------
//  §7  A LEITURA E O PROVEDOR
// ------------------------------------------------------------

describe('o provedor da tela', () => {
  const coverage = (status: CoverageStatus) => ({
    servers: [{ serverId: SERVER, status, lastBatchAt: MEASURED_SINCE }],
  });

  const board = (over: Partial<LeaderboardResult> = {}): LeaderboardResult =>
    ({
      ranking: ranking(),
      scope: 'server',
      period: {
        id: 1,
        kind: 'season',
        serverId: SERVER,
        label: 'Temporada 1',
        startedAt: MEASURED_SINCE,
        endedAt: null,
        seasonMode: 'monthly',
        turnsAt: null,
      },
      frozen: false,
      entries: [],
      total: 0,
      limit: RANKING_PAGE_SIZE,
      offset: 0,
      measuredSince: MEASURED_SINCE,
      updatedAt: MEASURED_SINCE,
      coverage: coverage('ok'),
      ...over,
    }) satisfies LeaderboardResult;

  const reader = (over: Partial<RankingScreenReader> = {}): RankingScreenReader => ({
    metrics: () => [ranking(), ranking({ id: 'mortes', metric: 'pvp.deaths', label: 'Mortes' })],
    leaderboard: async () => await Promise.resolve(board()),
    playerRankings: () => [],
    ...over,
  });

  it('a tela do jogo pede só o que aparece no jogo, e usa o nome CURTO', async () => {
    // ####  DOIS FILTROS, E ELES NÃO SÃO O MESMO  ####
    //
    // `enabledOnly` tira o que foi desligado; `inGameOnly` tira o
    // que o admin escondeu DESTE menu. O ranking escondido continua
    // contando, e continua no painel.
    let pedido: { enabledOnly?: boolean; inGameOnly?: boolean } | undefined;

    const provider = createRankingScreenProvider({
      rankings: reader({
        metrics: (options) => {
          pedido = options;

          return [ranking({ label: 'Poder de raid', shortLabel: 'Raid' })];
        },
      }),
      logger: silent,
    });

    const bundle = await provider({
      serverId: SERVER,
      document: buildMainMenu(),
      screenId: 'tela-ranking',
      steamId: PLAYER,
    });

    expect(pedido).toEqual({ enabledOnly: true, inGameOnly: true });

    // A coluna mostra o nome curto; o inteiro fica para o painel e
    // o site, que não têm a largura de uma coluna como limite.
    const json = JSON.stringify(bundle?.cui);

    expect(json).toContain('Raid');
    expect(json).not.toContain('Poder de raid');
  });

  it('devolve `null` para a tela que não é dele', async () => {
    const provider = createRankingScreenProvider({ rankings: reader(), logger: silent });

    expect(
      await provider({
        serverId: SERVER,
        document: buildMainMenu(),
        screenId: 'tela-kits',
        steamId: PLAYER,
      }),
    ).toBeNull();
  });

  it('a falha da leitura vira a TELA com o aviso, e nunca uma exceção', async () => {
    // Uma exceção aqui subiria ao `UiSync`, que serviria a tela do
    // documento — e o jogador ficaria olhando a tela em repouso sem
    // saber que houve erro.
    const provider = createRankingScreenProvider({
      rankings: reader({
        leaderboard: async () => {
          await Promise.resolve();
          throw new Error('o banco caiu');
        },
      }),
      logger: silent,
    });

    const bundle = await provider({
      serverId: SERVER,
      document: buildMainMenu(),
      screenId: 'tela-ranking',
      steamId: PLAYER,
    });

    expect(bundle).not.toBeNull();
    expect(bundle?.volatile).toBe(true);
    expect(JSON.stringify(bundle?.cui)).toContain('Não consegui montar o ranking');
  });

  it('"nunca teve janela aberta" vira frase, e não erro', async () => {
    const provider = createRankingScreenProvider({
      rankings: reader({
        leaderboard: async () => {
          await Promise.resolve();
          throw new ApiError('RANKING_NOT_MEASURED', 'sem janela', 409);
        },
      }),
      logger: silent,
    });

    const bundle = await provider({
      serverId: SERVER,
      document: buildMainMenu(),
      screenId: 'tela-ranking',
      steamId: PLAYER,
    });

    const json = JSON.stringify(bundle?.cui);

    expect(json).toContain('não há nada medido');
    // E a coluna continua: o ranking existe, só não tem número
    // ainda — sem ela o jogador não teria como sair dali.
    expect(json).toContain('ABATES');
  });

  it('busca a posição dele quando ele não está na página — e só então', async () => {
    let perguntou = 0;

    const withPlayer = reader({
      leaderboard: async () =>
        await Promise.resolve(
          board({
            total: 900,
            entries: Array.from({ length: RANKING_PAGE_SIZE }, (_unused, index) => ({
              position: index + 1,
              // Longe do `PLAYER`: um SteamID que colidisse com o
              // dele faria o teste medir o caso errado.
              steamId: `7656119877777770${String(index)}`,
              name: `Jogador ${String(index)}`,
              value: 900 - index,
              updatedAt: MEASURED_SINCE,
            })),
          }),
        ),
      playerRankings: () => {
        perguntou += 1;

        return [
          {
            ranking: ranking(),
            scope: 'server' as const,
            periodId: 1,
            position: 137,
            value: 42,
            total: 900,
          },
        ];
      },
    });

    const fora = await readRankingView({
      rankings: withPlayer,
      serverId: SERVER,
      steamId: PLAYER,
      target: { metric: 'pvp.kills', page: 0 },
    });

    expect(perguntou).toBe(1);
    expect(fora.self).toEqual({
      kind: 'ranked',
      entry: { position: 137, name: null, value: 42, mine: true },
    });

    // E quando ele ESTÁ na página, a consulta cara não acontece.
    const dentro = await readRankingView({
      rankings: withPlayer,
      serverId: SERVER,
      steamId: '76561198777777700',
      target: { metric: 'pvp.kills', page: 0 },
    });

    expect(perguntou).toBe(1);
    expect(dentro.self?.kind).toBe('ranked');
    expect(dentro.entries.filter((row) => row.mine)).toHaveLength(1);
  });

  it('pede ao banco só a página pedida, e não a lista inteira', async () => {
    // O recorte acontece ANTES do desenho: uma lista de 900 lida
    // para mostrar dez seria 890 nomes que ninguém vê.
    const asked: { limit: number; offset: number }[] = [];

    const spy = reader({
      leaderboard: async (query) => {
        asked.push({ limit: query.limit, offset: query.offset });

        return await Promise.resolve(board({ total: 900 }));
      },
    });

    await readRankingView({
      rankings: spy,
      serverId: SERVER,
      steamId: PLAYER,
      target: { metric: 'pvp.kills', page: 3 },
    });

    expect(asked).toEqual([{ limit: RANKING_PAGE_SIZE, offset: 3 * RANKING_PAGE_SIZE }]);
  });

  it('uma métrica que saiu do catálogo cai no primeiro ranking, e não em erro', async () => {
    const lida = await readRankingView({
      rankings: reader(),
      serverId: SERVER,
      steamId: undefined,
      target: { metric: 'nao.existe.mais', page: 0 },
    });

    expect(lida.active?.metric).toBe('pvp.kills');
  });

  it('sem ranking ligado, a leitura devolve a tela que diz isso', async () => {
    const lida = await readRankingView({
      rankings: reader({ metrics: () => [] }),
      serverId: SERVER,
      steamId: PLAYER,
      target: { metric: null, page: 0 },
    });

    expect(lida.trouble).toBe('sem-rankings');
  });
});

// ------------------------------------------------------------
//  §8  O PRESET
// ------------------------------------------------------------

describe('a página RANKING dentro do documento', () => {
  it('deixou de prometer o que já existe', () => {
    const document = buildMainMenu();
    const screen = document.screens.find((item) => item.id === RANKING_SCREEN_ID);

    expect(screen).toBeDefined();
    expect(JSON.stringify(screen)).not.toContain('entra aqui');
    expect(JSON.stringify(screen)).toContain('não há nada medido');
  });

  it('o botão RANKING continua onde estava', () => {
    const document = buildMainMenu();
    const botao = [...walkElements(document.shell)]
      .map((found) => found.element)
      .find((element) => element.id === 'nav-ranking');

    expect(botao?.type === 'button' ? botao.action : null).toEqual({
      id: 'ir-ranking',
      kind: 'navigate',
      screenId: RANKING_SCREEN_ID,
    });
    // A largura é a mesma: mexer nela empurraria a barra inteira.
    expect(botao?.rect.offsetMax.x).toBe((botao?.rect.offsetMin.x ?? 0) + 90);
  });

  it('a tela em repouso é gravável: sem `:` em id nenhum', () => {
    // ####  O `idSchema` DO DOCUMENTO NÃO ACEITA DOIS-PONTOS  ####
    //
    // As telas GERADAS nunca passam por ele — elas viram CUI e vão
    // direto ao plugin. Esta passa, porque está no documento: um
    // item de coluna aqui levaria a `tela-ranking:pvp.kills` e o
    // menu inteiro seria recusado na gravação.
    expect(() => uiDocumentSchema.parse(buildMainMenu())).not.toThrow();
    expect(findDocumentProblems(buildMainMenu())).toEqual([]);
  });

  it('a tela em repouso é DETERMINÍSTICA', () => {
    // O documento é comparado byte a byte com o que está gravado.
    expect(JSON.stringify(buildRankingScreen({ view: emptyRankingView() }))).toBe(
      JSON.stringify(buildRankingScreen({ view: emptyRankingView() })),
    );
  });
});
