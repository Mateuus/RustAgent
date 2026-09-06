// ============================================================
//  ui-ranking-screen.ts  -  a página RANKING, montada do banco.
//
//  ####  POR QUE ESTA TELA NÃO É DESENHADA NO EDITOR  ####
//
//  Até aqui ela era um retângulo dizendo "O ranking de jogadores
//  entra aqui". O que ela precisa mostrar — quem está na frente,
//  com quanto, e EM QUE LUGAR ESTÁ QUEM OLHA — muda a cada lote da
//  coleta e depende de quem pediu. É o mesmo caso das páginas de
//  KITS e do CALENDÁRIO, e o padrão é o delas: o documento guarda
//  o ENDEREÇO e o agente monta o conteúdo na hora do clique.
//
//  O plugin não muda. O `OrigemZUI.cs` é genérico: guarda o
//  documento, pede com `#OZUIREQ#` a tela que não tem em cache e
//  desenha o que voltar. Uma tela nova é um PROVEDOR no agente.
//
//  ####  ELA NUNCA É GUARDADA EM CACHE  ####
//
//  `volatile: true` no pacote — quem o marca é o
//  `toGeneratedScreenBundle`. A tela diz "você está em 47º"; em
//  cache, ela diria isso para o servidor inteiro e para sempre.
//
//  ------------------------------------------------------------
//  ####  A LISTA DE RANKINGS É UMA COLUNA, E NÃO UMA FILEIRA  ####
//
//  Ela já foi uma fileira horizontal de abas de 78 px. Com doze
//  rankings, "Tiro mais l…" e "Poder de ra…" truncavam, e cada
//  ranking novo que o admin criasse empurrava a fileira para fora
//  da tela — um limite que só aparece DEPOIS de o servidor estar
//  rodando.
//
//  A coluna vertical inverte a conta: a largura vira constante
//  (uma só, larga o bastante para o nome inteiro) e o que cresce é
//  a ALTURA, que a tela tem de sobra. E o que não cabe na altura
//  não é cortado nem contado: ele PAGINA, no rodapé da própria
//  coluna.
//
//  ####  NADA GUARDA ESTADO: TUDO É ENDEREÇO  ####
//
//  Trocar de ranking e virar a página da coluna não são eventos,
//  são ENDEREÇOS:
//
//      tela-ranking:<métrica>[:<página da lista>[:<página da coluna>]]
//
//  Por isso a página da coluna VIAJA nos dois cliques: o item da
//  coluna leva a página dela junto (`tela-ranking:x:0:1`), e a
//  seta da coluna leva a página da lista junto. Sem isso, quem
//  estivesse na segunda página da coluna voltaria à primeira toda
//  vez que trocasse de ranking — e perderia de vista o item que
//  acabou de clicar.
//
//  O item ATIVO vira `panel`: um botão que navega para onde já se
//  está parece defeito. Ver a regra de ouro em ui-widgets.ts:284-293.
//
//  ------------------------------------------------------------
//  ####  O RECORTE ACONTECE ANTES DO DESENHO  ####
//
//  A lição mais cara do projeto (ui-calendar-screen.ts:24-36): o
//  que o jogador não pode ver NÃO ATRAVESSA O RCON. Por isso são
//  duas funções, e não uma:
//
//    readRankingView()    lê o banco e devolve SÓ a página pedida,
//                         já sem SteamID de ninguém — e SÓ os
//                         rankings da página da coluna;
//    buildRankingScreen() desenha o que recebeu, e nada além.
//
//  A paginação é feita pelo SQL (`limit`/`offset` do
//  `RankingsService`), e não em memória com `paginateRows`: uma
//  lista de 900 jogadores lida inteira para mostrar dez seria
//  carregar 890 nomes que ninguém vai ver — e num banco que a
//  coleta escreve a cada 60 s.
//
//  ####  DEZ POR PÁGINA, E NÃO CEM DE UMA VEZ  ####
//
//  O teto do comando é 50 000 bytes de base64
//  (types/ui-transport.ts:534). MEDIDO em 06/09/2026 (ver o teste
//  §3): o pior caso — a página da coluna cheia com rótulos no
//  limite, dez nomes de 32 caracteres com acento e símbolo, os
//  dois pagers, a faixa dele e o aviso — dá 40 512 bytes, com 19%
//  de folga. Uma tela estourada não dá erro no jogo: ela
//  simplesmente não abre.
//
//  A conta vale nos DOIS sentidos: são as duas páginas — a da
//  lista e a da coluna — que a seguram. Sem paginar a coluna, um
//  servidor com vinte rankings ligados passaria de 47 KB só com
//  eles.
//
//  ####  A LINHA DELE APARECE SEMPRE  ####
//
//  É a única informação que ele foi ver. O top é o contexto; o
//  lugar DELE é a resposta — e ela não pode depender de o jogador
//  virar quatro páginas para se achar. Por isso ela fica colada no
//  RODAPÉ da lista, alinhada com as colunas dela: o olho compara
//  o número dele com os de cima sem precisar procurar.
// ============================================================

import type { RankingRecord, RankingValueKind } from '../db/rankings-repository.js';
import { isApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import {
  coverageMessageOf,
  gameLabelOf,
  type CoverageStatus,
  type LeaderboardQuery,
  type LeaderboardResult,
  type PlayerRankingRow,
  type RankingScope,
} from '../rankings/service.js';
import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import { toError } from '../util.js';

import {
  button,
  C,
  clamp,
  fill,
  formatNumber,
  formatWhen,
  label,
  panel,
  rowsPager,
  textWidth,
  topBar,
  type Rect,
} from './ui-widgets.js';

/**
 * O id da tela no documento.
 *
 * FIXO, e não sorteado: é por ele que o agente reconhece a tela
 * cujo conteúdo ele mesmo monta. Precisa bater com o preset — a
 * nav `ranking` de game/ui-preset-main-menu.ts já navega para cá.
 */
export const RANKING_SCREEN_ID = 'tela-ranking';

/** Quantos colocados cabem numa página. Ver o cabeçalho. */
export const RANKING_PAGE_SIZE = 10;

/**
 * O teto da página que um endereço pode pedir.
 *
 * O id da tela vem do plugin, e um `tela-ranking:pvp.kills:99999999`
 * viraria um `OFFSET` absurdo no SQL. O teto o apara antes de a
 * pergunta chegar ao banco; a página que não existe é aparada de
 * novo, depois, contra o total real.
 */
const MAX_PAGE = 9_999;

// ------------------------------------------------------------
//  O ENDEREÇO
// ------------------------------------------------------------

export interface RankingScreenTarget {
  /** A métrica ativa. `null` = a primeira habilitada. */
  readonly metric: string | null;
  /** A página da LISTA de colocados. */
  readonly page: number;
  /**
   * A página da COLUNA de rankings.
   *
   * `null` = o endereço não disse nada, e aí quem decide é a
   * leitura: a coluna abre na página em que o ranking ativo está.
   * É a diferença entre "o jogador virou a coluna e ficou na
   * primeira página" e "ninguém virou nada ainda" — sem ela, quem
   * chegasse pelo botão RANKING com o ranking ativo na segunda
   * página da coluna veria uma coluna sem nada destacado.
   */
  readonly columnPage?: number | null;
}

/**
 * Lê o id da tela. `null` = não é uma tela de ranking.
 *
 *     tela-ranking                 o primeiro ranking, primeira página
 *     tela-ranking:pvp.kills       aquele ranking
 *     tela-ranking:pvp.kills:2     a terceira página da lista dele
 *     tela-ranking:pvp.kills:2:1   ...com a coluna na segunda página
 *
 * ####  AS PARTES FINAIS SÓ SÃO PÁGINA SE FOREM NÚMERO  ####
 *
 * A métrica é texto livre do catálogo (`ore.sulfur`, e amanhã o
 * que o admin criar no painel). Cortar sempre no primeiro `:`
 * quebraria no dia em que alguém puser `:` no nome — então o que
 * se procura são os SUFIXOS NUMÉRICOS (no máximo dois), e o resto,
 * inteiro, é a métrica. A última parte que sobra nunca é
 * consumida: um ranking chamado "2" continua sendo um ranking.
 *
 * Tudo o que vier fora do esperado é APARADO para algo válido em
 * vez de recusado: o pedido veio do plugin, e o jogador está com
 * um aviso de carregando na tela.
 */
export function parseRankingScreenId(screenId: string): RankingScreenTarget | null {
  const parts = screenId.split(':');

  if (parts[0] !== RANKING_SCREEN_ID) {
    return null;
  }

  const rest = parts.slice(1);
  const pages: number[] = [];

  // Colhidos do FIM para o começo e devolvidos na ordem em que
  // foram escritos: o primeiro número é a página da lista, o
  // segundo é a da coluna. `rest.length - pages.length > 1` é o
  // que preserva a métrica de nome numérico.
  while (pages.length < 2 && rest.length - pages.length > 1) {
    const candidate = rest[rest.length - 1 - pages.length] ?? '';

    if (!/^\d+$/.test(candidate)) {
      break;
    }

    pages.unshift(clamp(Number.parseInt(candidate, 10), 0, MAX_PAGE));
  }

  const metric = rest
    .slice(0, rest.length - pages.length)
    .join(':')
    .trim();

  return {
    metric: metric === '' ? null : metric,
    page: pages[0] ?? 0,
    columnPage: pages[1] ?? null,
  };
}

/**
 * O endereço de uma página de um ranking.
 *
 * O que está no padrão não vai no id: `tela-ranking:pvp.kills`
 * continua sendo o mesmo endereço de sempre, e só quem virou
 * alguma página carrega número. A página da coluna, quando existe,
 * obriga a da lista a aparecer mesmo em zero — as duas são
 * POSICIONAIS, e um `tela-ranking:x:1` sem a do meio seria lido
 * como página da lista.
 */
export function rankingScreenId(metric: string | null, page = 0, columnPage = 0): string {
  if (metric === null) {
    return RANKING_SCREEN_ID;
  }

  if (columnPage > 0) {
    return `${RANKING_SCREEN_ID}:${metric}:${String(page)}:${String(columnPage)}`;
  }

  return page > 0
    ? `${RANKING_SCREEN_ID}:${metric}:${String(page)}`
    : `${RANKING_SCREEN_ID}:${metric}`;
}

// ============================================================
//  §1  O RECORTE — o que atravessa o RCON
// ============================================================

/** Um ranking, do jeito que a tela precisa dele. */
export interface RankingScreenRanking {
  readonly metric: string;
  readonly label: string;
  /** "abates", "segundos", "metros". `null` = número puro. */
  readonly unit: string | null;
  readonly valueKind: RankingValueKind;
}

/**
 * Uma linha da lista.
 *
 * Sem SteamID: ele não é desenhado em lugar nenhum, e o que não é
 * desenhado não precisa atravessar o RCON. Quem é o jogador que
 * está olhando já vem decidido em `mine`.
 */
export interface RankingScreenEntry {
  readonly position: number;
  /** `null` = o jogador saiu da base; o número continua valendo. */
  readonly name: string | null;
  readonly value: number;
  /** É a linha de quem está olhando? */
  readonly mine: boolean;
}

/**
 * Onde ELE está.
 *
 * `null` = ninguém está olhando (a carga que vai ao servidor sem
 * jogador nenhum). `unranked` é diferente de "em último": ele não
 * pontuou, e dizer que ele é o último ofende quem nem jogou.
 */
export type RankingScreenSelf =
  | { readonly kind: 'ranked'; readonly entry: RankingScreenEntry }
  | { readonly kind: 'unranked' };

/**
 * O que impediu a lista de existir.
 *
 * Cada um vira uma FRASE diferente na tela, e é essa a razão de
 * eles serem três em vez de um booleano: "nenhum ranking ligado",
 * "nada medido ainda" e "não consegui ler" mandam consertar coisas
 * diferentes.
 */
export type RankingScreenTrouble = 'sem-rankings' | 'nao-medido' | 'falhou';

/** A tela inteira, já recortada. O desenho não busca mais nada. */
export interface RankingScreenView {
  /**
   * A coluna: só os rankings DAQUELA PÁGINA dela, na `sortOrder`.
   *
   * Recortada aqui, e não no desenho: com trinta rankings ligados,
   * mandar os trinta ao jogo para desenhar quinze seria pagar o
   * RCON por metade de uma tela que ninguém vê.
   */
  readonly rankings: readonly RankingScreenRanking[];
  readonly active: RankingScreenRanking | null;
  readonly page: number;
  readonly pages: number;
  /** Em que página da coluna a tela está, e quantas ela tem. */
  readonly columnPage: number;
  readonly columnPages: number;
  readonly entries: readonly RankingScreenEntry[];
  /** Quantos têm número naquele ranking. */
  readonly total: number;
  readonly self: RankingScreenSelf | null;
  /** Desde quando aquilo é medido. `null` = não dá para dizer. */
  readonly measuredSince: number | null;
  /** Como a coleta DESTE servidor estava. `null` = não perguntei. */
  readonly coverage: CoverageStatus | null;
  readonly trouble: RankingScreenTrouble | null;
}

/**
 * A tela em repouso: sem ranking, sem número, sem promessa.
 *
 * É o que o preset grava no documento (ver
 * game/ui-preset-main-menu.ts). Ela precisa ser DETERMINÍSTICA —
 * nada de `Date.now()` aqui dentro — porque o documento é
 * comparado byte a byte com o que está gravado.
 */
export function emptyRankingView(): RankingScreenView {
  return {
    rankings: [],
    active: null,
    page: 0,
    pages: 1,
    columnPage: 0,
    columnPages: 1,
    entries: [],
    total: 0,
    self: null,
    measuredSince: null,
    coverage: null,
    trouble: 'nao-medido',
  };
}

/**
 * O que esta tela precisa do `RankingsService`. E nada além.
 *
 * Uma interface mínima, como a `RankingCoverage` do serviço: um
 * teste a satisfaz com três funções, e o `RankingsService` a
 * satisfaz de verdade, sem esta tela conhecer a classe.
 */
export interface RankingScreenReader {
  metrics(options?: {
    readonly enabledOnly?: boolean;
    readonly inGameOnly?: boolean;
  }): readonly RankingRecord[];
  leaderboard(query: LeaderboardQuery): Promise<LeaderboardResult>;
  playerRankings(
    steamId: string,
    options?: { readonly serverId?: string | undefined; readonly scope?: RankingScope },
  ): readonly PlayerRankingRow[];
}

export interface ReadRankingViewInput {
  readonly rankings: RankingScreenReader;
  readonly serverId: string;
  /** Quem está olhando. `undefined` = ninguém (a carga inicial). */
  readonly steamId: string | undefined;
  readonly target: RankingScreenTarget;
}

/**
 * Lê o banco e devolve SÓ o que vai ser desenhado.
 *
 * ####  O ESCOPO É O SERVIDOR EM QUE ELE ESTÁ  ####
 *
 * E não a rede: o jogador abriu o menu DENTRO de um servidor, e é
 * o ranking daquele mundo que ele foi ver. O escopo de rede
 * também recusaria minério e explosivo (`globalEligible = 0`), que
 * são metade do catálogo semeado.
 */
export async function readRankingView(input: ReadRankingViewInput): Promise<RankingScreenView> {
  const empty = emptyRankingView();
  // ####  DOIS FILTROS, E CADA UM DIZ UMA COISA  ####
  //
  // `enabledOnly` tira o ranking desligado, que sumiu de todo
  // lugar. `inGameOnly` tira o que o admin escondeu DESTE menu —
  // ele continua ligado, continua contando e continua no painel e
  // no site.
  const catalog = input.rankings
    .metrics({ enabledOnly: true, inGameOnly: true })
    .map(toScreenRanking);

  if (catalog.length === 0) {
    return { ...empty, trouble: 'sem-rankings' };
  }

  // Uma métrica que não está mais no catálogo cai no primeiro
  // ranking, em vez de virar erro: o endereço pode ser de antes de
  // o admin desligar aquele ranking, e o jogador só clicou num
  // botão.
  const active = catalog.find((entry) => entry.metric === input.target.metric) ?? catalog[0];

  if (active === undefined) {
    return { ...empty, trouble: 'sem-rankings' };
  }

  const column = sliceColumn(catalog, active, input.target.columnPage);
  const base = { ...empty, ...column, active };

  const ask = async (page: number): Promise<LeaderboardResult> =>
    await input.rankings.leaderboard({
      metric: active.metric,
      scope: 'server',
      serverId: input.serverId,
      limit: RANKING_PAGE_SIZE,
      offset: page * RANKING_PAGE_SIZE,
    });

  let board: LeaderboardResult;

  try {
    board = await ask(input.target.page);
  } catch (error) {
    // ####  "AINDA NÃO MEDI" NÃO É UM DEFEITO  ####
    //
    // `RANKING_NOT_MEASURED` é a resposta honesta de um servidor
    // que nunca teve janela aberta — um wipe recém-feito, um
    // agente recém-subido. Vira frase na tela. Qualquer outro erro
    // sobe: quem trata é o provedor, e ele diz outra coisa.
    if (isApiError(error) && error.code === 'RANKING_NOT_MEASURED') {
      return { ...base, trouble: 'nao-medido' };
    }

    throw error;
  }

  const pages = Math.max(1, Math.ceil(board.total / RANKING_PAGE_SIZE));

  // ####  UMA PÁGINA QUE NÃO EXISTE MOSTRA A ÚLTIMA  ####
  //
  // O endereço pode apontar para além do fim: a temporada virou
  // depois que o jogador abriu o menu, e a lista encolheu. A
  // última é a resposta certa; uma tela vazia parece defeito. A
  // segunda consulta só acontece nesse caso.
  const page = clamp(input.target.page, 0, pages - 1);

  if (page !== input.target.page && board.entries.length === 0 && board.total > 0) {
    board = await ask(page);
  }

  const entries = board.entries.map(
    (entry): RankingScreenEntry => ({
      position: entry.position,
      name: entry.name,
      value: entry.value,
      mine: input.steamId !== undefined && entry.steamId === input.steamId,
    }),
  );

  return {
    ...base,
    page,
    pages,
    entries,
    total: board.total,
    self: selfOf(input, active.metric, entries),
    measuredSince: board.measuredSince,
    coverage:
      board.coverage.servers.find((server) => server.serverId === input.serverId)?.status ?? null,
    trouble: null,
  };
}

/**
 * A fatia do catálogo que a coluna mostra.
 *
 * ####  SEM ENDEREÇO, A COLUNA ABRE ONDE O ATIVO ESTÁ  ####
 *
 * O jogador que clica em RANKING no cabeçalho chega sem página de
 * coluna nenhuma. Se ela abrisse sempre na primeira, um servidor
 * com vinte rankings mostraria uma coluna inteira sem nada
 * destacado e a lista de um ranking que não está ali — que é a
 * cara de um menu quebrado. Com endereço, manda o endereço: ali
 * foi o jogador quem virou.
 */
function sliceColumn(
  catalog: readonly RankingScreenRanking[],
  active: RankingScreenRanking,
  asked: number | null | undefined,
): Pick<RankingScreenView, 'rankings' | 'columnPage' | 'columnPages'> {
  const columnPages = Math.max(1, Math.ceil(catalog.length / RANKING_COLUMN_PAGE_SIZE));
  const activeIndex = Math.max(
    0,
    catalog.findIndex((entry) => entry.metric === active.metric),
  );

  const columnPage = clamp(
    asked ?? Math.floor(activeIndex / RANKING_COLUMN_PAGE_SIZE),
    0,
    columnPages - 1,
  );

  const from = columnPage * RANKING_COLUMN_PAGE_SIZE;

  return {
    rankings: catalog.slice(from, from + RANKING_COLUMN_PAGE_SIZE),
    columnPage,
    columnPages,
  };
}

/**
 * A linha DELE — a única informação que ele foi ver.
 *
 * ####  A CONSULTA CARA SÓ ACONTECE QUANDO PRECISA  ####
 *
 * Se ele está na página que já veio, a posição está na mão e não
 * custa nada. Fora dela é que se pergunta ao serviço — e essa
 * pergunta percorre TODOS os rankings habilitados
 * (`playerRankings` não filtra por métrica), o que no K/D
 * significa somar a janela inteira. É o preço de não alterar o
 * `RankingsService`, que já está fechado e testado; se um dia
 * doer, o que falta lá é um `positionOf(metric, steamId)`.
 */
function selfOf(
  input: ReadRankingViewInput,
  metric: string,
  entries: readonly RankingScreenEntry[],
): RankingScreenSelf | null {
  const steamId = input.steamId;

  if (steamId === undefined) {
    return null;
  }

  const here = entries.find((entry) => entry.mine);

  if (here !== undefined) {
    return { kind: 'ranked', entry: here };
  }

  const row = input.rankings
    .playerRankings(steamId, { serverId: input.serverId, scope: 'server' })
    .find((entry) => entry.ranking.metric === metric);

  if (row === undefined || row.position === null || row.value === null) {
    return { kind: 'unranked' };
  }

  return {
    kind: 'ranked',
    // Sem nome: `playerRankings` não devolve um, e a faixa dele
    // escreve "VOCÊ" — que é mais claro do que o próprio nick.
    entry: { position: row.position, name: null, value: row.value, mine: true },
  };
}

function toScreenRanking(ranking: RankingRecord): RankingScreenRanking {
  return {
    metric: ranking.metric,
    // A coluna usa o nome CURTO quando existe, e o inteiro quando
    // não: a regra mora em `gameLabelOf` (rankings/service.ts), e
    // duplicá-la aqui daria duas versões dela. Ver a migração 044.
    label: gameLabelOf(ranking),
    unit: ranking.unit,
    valueKind: ranking.valueKind,
  };
}

// ============================================================
//  §2  O VALOR, PELA NATUREZA DO RANKING
// ============================================================

/**
 * A unidade que quer virar duração em vez de número.
 *
 * É a do `time.played` semeado (Docs/Ranking/20 §4), e a
 * comparação é pela UNIDADE e não pela métrica de propósito: um
 * ranking dinâmico que o admin criar contando segundos merece a
 * mesma leitura.
 */
const TIME_UNIT = 'segundos';

/**
 * O valor como o jogador lê.
 *
 *   contador   1.284           (milhar com ponto, como no painel)
 *   segundos   13 d 4 h        (duração, e não 1.140.523)
 *   recorde    412,5 metros    (uma casa, e a unidade junto)
 *   razão      1,32            (o K/D, com as duas casas do doc)
 *
 * ####  A UNIDADE SÓ ENTRA ONDE ELA É A INFORMAÇÃO  ####
 *
 * "412,5" sem "metros" não diz nada — o recorde é uma medida. Já
 * "1.284 abates" repete, em cada uma das dez linhas, a palavra que
 * está escrita no cabeçalho da coluna logo acima.
 */
export function formatRankingValue(value: number, ranking: RankingScreenRanking): string {
  if (ranking.valueKind === 'ratio') {
    return value.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (ranking.valueKind === 'record') {
    const number = value.toLocaleString('pt-BR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });

    return ranking.unit === null ? number : `${number} ${ranking.unit}`;
  }

  if (ranking.unit !== null && ranking.unit.toLowerCase() === TIME_UNIT) {
    return formatPlaytime(value);
  }

  return formatNumber(Math.round(value));
}

/**
 * "13 d 4 h", "5 h 12 min", "45 min", "30 s" — tempo ACUMULADO.
 *
 * ####  POR QUE NÃO É O `describeWait`  ####
 *
 * Aquele responde QUANTO FALTA, e arredonda para cima: 3.599
 * segundos viram "60 min", porque numa espera errar para mais é
 * ser conservador. Num total medido, arredondar para cima é
 * inventar tempo que o jogador não jogou — e num ranking premiado
 * isso é contestável.
 *
 * E ele para em "13 dias". Aqui a hora fica: entre 13 d 1 h e
 * 13 d 20 h há a diferença que decide o pódio.
 */
export function formatPlaytime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));

  if (total < 60) {
    return `${String(total)} s`;
  }

  const minutes = Math.floor(total / 60);

  if (minutes < 60) {
    return `${String(minutes)} min`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const rest = minutes % 60;

    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;

  return rest === 0 ? `${formatNumber(days)} d` : `${formatNumber(days)} d ${String(rest)} h`;
}

// ============================================================
//  §3  A GEOMETRIA
//
//  ####  MEDIDA, E NÃO CHUTADA  ####
//
//  O canvas do Rust é escalado para 1280x720. A moldura do menu
//  ocupa 88% dele (ui-preset-main-menu.ts), e o slot de conteúdo
//  ainda tira o cabeçalho, a barra de acento e 30 px de margem de
//  cada lado. Sobram, em números redondos:
//
//      largura   0,88 x 1280 - 2 x 30            = 1066
//      altura    0,88 x  720 - (76 + 2 + 30) - 30 =  495
//
//  Estes dois números NÃO posicionam nada — quem posiciona são as
//  âncoras, e por isso a tela continua certa se o admin mover o
//  slot no editor. Eles servem para uma coisa só: CONTAR quantos
//  rankings cabem numa página da coluna. Errar para menos deixa
//  uma folga; errar para mais esconderia o último item.
// ============================================================

const CONTENT_HEIGHT = 495;

/** O que fica onde, medido do topo do slot de conteúdo. */
const Y = {
  /** A faixa do título. */
  title: 30,
  /** Onde a coluna e a área de conteúdo começam. */
  body: 40,
} as const;

/** A coluna de rankings, à esquerda. */
const COLUMN = {
  /**
   * Larga o bastante para o nome INTEIRO.
   *
   * É o ponto do redesenho: com 210 px cabem 28 caracteres no
   * corpo 12, contra os doze que a aba de 78 px comportava. Um
   * nome maior que isso ainda é cortado — mas aí ele já não cabia
   * no painel também.
   */
  width: 210,
  /** O respiro entre a coluna e o conteúdo. */
  gap: 16,
  /**
   * A altura de um item.
   *
   * ####  ELA É O QUE DECIDE QUANTOS CABEM, E ISSO CUSTA BYTES  ####
   *
   * Cada item da coluna são DOIS elementos no CUI (o botão e o
   * texto dele), e o frame do RCON é finito: item baixo demais
   * enche a página e empurra a tela contra o teto de 50 000 bytes.
   * 34 px é o ponto em que o catálogo de hoje — doze rankings —
   * cabe numa página só, com um alvo de clique confortável e a
   * medição do §3 ainda com folga.
   */
  item: 34,
  /** O espaço entre o último item e o pager. */
  pagerGap: 6,
} as const;

/** A altura da faixa "‹ 1 / 4 ›". A mesma nos dois pagers da tela. */
const PAGER_HEIGHT = 22;

/**
 * Quantos rankings cabem numa página da coluna.
 *
 * Derivado, e não escrito à mão: o dia em que a altura do item ou
 * a do pager mudar, este número acompanha — e ninguém precisa
 * ligar uma coisa à outra. MEDIDO em 06/09/2026: 12.
 */
export const RANKING_COLUMN_PAGE_SIZE = Math.max(
  1,
  Math.floor((CONTENT_HEIGHT - Y.body - PAGER_HEIGHT - COLUMN.pagerGap) / COLUMN.item),
);

/** Onde a área de conteúdo começa, com e sem a coluna. */
const CONTENT_LEFT = COLUMN.width + COLUMN.gap;

/** O que fica onde dentro da área de conteúdo, do topo dela. */
const CONTENT = {
  subtitle: 0,
  notice: 22,
  /** O topo da caixa da lista. */
  list: 46,
} as const;

/** A margem de dentro da caixa da lista. */
const PAD = 10;

/** O cabeçalho da coluna de valor, dentro da caixa. */
const LIST_HEADER = 22;

/** O respiro entre a régua do cabeçalho e a primeira linha. */
const LIST_GAP = 4;

/** A altura da faixa do jogador. */
const SELF_HEIGHT = 38;

/**
 * O rodapé da caixa, contado do FUNDO dela.
 *
 * ####  ELE É ANCORADO EMBAIXO, E POR ISSO NÃO SE MEXE  ####
 *
 * A faixa do jogador fica no mesmo lugar com dez linhas ou com
 * três: quem foi ver o próprio lugar sabe onde olhar antes de a
 * tela abrir. Ancorá-la depois da última linha a faria subir e
 * descer conforme a página — e a última página de toda lista tem
 * menos linhas.
 */
const FOOT = {
  self: PAD,
  selfHeight: SELF_HEIGHT,
  /** A régua que separa o top da faixa dele. */
  rule: PAD + SELF_HEIGHT + 6,
  pager: PAD + SELF_HEIGHT + 11,
} as const;

/** Quanto o rodapé inteiro ocupa, do fundo da caixa para cima. */
const FOOT_HEIGHT = FOOT.pager + PAGER_HEIGHT;

/** A altura da caixa da lista, na régua estimada de §3. */
const LIST_HEIGHT = CONTENT_HEIGHT - Y.body - CONTENT.list;

/**
 * A altura de uma linha da lista.
 *
 * ####  ELA É O QUE SOBRA, E NÃO UM NÚMERO ESCOLHIDO  ####
 *
 * As linhas descem do topo e o rodapé sobe do fundo; escrita à
 * mão, a altura da linha seria o lugar onde os dois se
 * encontrariam sem ninguém perceber — e a décima linha ficaria
 * escondida atrás da faixa do jogador, sem erro nenhum no jogo.
 * Dividindo o que sobra, ela também usa a área INTEIRA em vez de
 * deixar um vão no meio da tela. MEDIDA em 06/09/2026: 29 px.
 */
const ROW = Math.floor(
  (LIST_HEIGHT - PAD - LIST_HEADER - LIST_GAP - FOOT_HEIGHT) / RANKING_PAGE_SIZE,
);

/**
 * Onde cada coluna da lista começa e acaba, dentro de uma linha.
 *
 * A faixa do jogador usa as MESMAS medidas: é o que faz o número
 * dele cair debaixo dos números de cima em vez de flutuar.
 */
const CELL = {
  positionLeft: 12,
  positionRight: 58,
  nameLeft: 70,
  valueWidth: 200,
  valueRight: 14,
} as const;

// ============================================================
//  §4  O DESENHO
// ============================================================

export interface BuildRankingScreenOptions {
  readonly view: RankingScreenView;
  /**
   * O id EXATO que foi pedido.
   *
   * Volta idêntico porque o plugin DESCARTA a resposta cujo id não
   * bate com o que ele pediu — e aí o "carregando" fica preso na
   * tela até o timeout: a seta pareceria não funcionar.
   */
  readonly screenId?: string;
}

export function buildRankingScreen(options: BuildRankingScreenOptions): UiScreen {
  const { view } = options;
  // Sem ranking nenhum não há coluna, e a frase ocupa a largura
  // toda: uma barra lateral vazia à esquerda de um aviso é ruído
  // com aparência de defeito. É também o caso da tela em REPOUSO,
  // a que fica gravada no documento.
  const hasColumn = view.rankings.length > 0;
  const left = hasColumn ? CONTENT_LEFT : 0;

  const elements: UiElement[] = [
    label('rk-titulo', 'RANKING', topBar(Y.title), {
      size: 20,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];

  if (hasColumn) {
    elements.push(...rankingColumn(view));
  }

  elements.push(
    label('rk-sub', subtitleOf(view), band(left, Y.body + CONTENT.subtitle, 18), {
      size: 11,
      align: 'MiddleLeft',
      color: C.textMuted,
    }),
  );

  const warning = coverageMessageOf(view.coverage);

  if (warning !== null) {
    // ####  O AVISO DA COLETA MORA AQUI, E SÓ AQUI  ####
    //
    // Ele já foi desenhado em dois lugares — nesta faixa e no meio
    // da lista vazia —, e com a lista vazia E a coleta parada o
    // jogador lia a mesma frase duas vezes na mesma tela.
    //
    // Ficou o de cima porque é o único que serve aos DOIS casos: o
    // aviso é sobre a IDADE dos números, não sobre a ausência
    // deles, e ele precisa aparecer também com a lista cheia — uma
    // lista completa de números velhos é justamente o caso em que
    // ninguém desconfiaria sozinho. O de dentro da lista só existia
    // quando não havia linha nenhuma.
    //
    // E aqui ele fica colado no subtítulo, que é onde a tela diz de
    // onde os números vêm.
    elements.push(
      label('rk-aviso', warning, band(left, Y.body + CONTENT.notice, 18), {
        size: 11,
        align: 'MiddleLeft',
        color: coverageTone(view.coverage),
      }),
    );
  }

  elements.push(listBox(view, left));

  return {
    id: options.screenId ?? RANKING_SCREEN_ID,
    name: 'RANKING',
    kind: 'page',
    elements,
  };
}

/**
 * A cor do aviso — e é aqui que `never` deixa de parecer defeito.
 *
 * ####  "AINDA NÃO COLETOU" NÃO É "A COLETA QUEBROU"  ####
 *
 * As quatro frases vêm prontas do serviço, e `never` já diz o que
 * tem de dizer. O que sobrava era a COR: em âmbar, um ranking
 * criado hoje pedia socorro na primeira vez que alguém o abrisse.
 * Âmbar é a cor de "vá olhar isso"; um ranking que ainda não
 * recebeu a primeira coleta não precisa de ninguém — ele precisa
 * de sessenta segundos.
 */
function coverageTone(coverage: CoverageStatus | null): string {
  return coverage === 'never' ? C.textMuted : C.amber;
}

// ------------------------------------------------------------
//  A coluna
// ------------------------------------------------------------

/**
 * Um ranking por linha, o ativo destacado, e o pager no rodapé.
 *
 * ####  O ATIVO É `panel`, OS OUTROS SÃO `button`  ####
 *
 * Clicar no item aberto navegaria para onde já se está — um
 * clique que não faz nada, que é o que parece defeito. A regra é
 * a mesma das abas dos modais (ui-widgets.ts:284-293).
 *
 * ####  E ELES `navigate`, E NÃO `modal.open`  ####
 *
 * Esta é uma PÁGINA. `modal.open` abriria a tela de ranking POR
 * CIMA da tela de ranking, empilhando um modal a cada troca de
 * ranking (ver `Execute` em Plugins/OrigemZUI.cs). O pager já
 * usava `navigate`; a fileira de abas usava `modal.open` porque
 * herdava o `tabsRow`, que é o widget dos MODAIS.
 */
function rankingColumn(view: RankingScreenView): UiElement[] {
  const active = view.active;
  const items: UiElement[] = [];

  for (const [index, entry] of view.rankings.entries()) {
    const id = `rkc${String(index)}`;
    const text = columnLabel(entry.label);

    if (active !== null && entry.metric === active.metric) {
      items.push(
        // Mais ESCURO que a coluna, e não mais claro: sobre um
        // fundo escuro, o buraco lê como "aberto" e a barra
        // vermelha diz qual é. Clarear seria o mesmo efeito do
        // hover, e aí o item aberto e o item sob o cursor
        // pareceriam a mesma coisa.
        panel(id, columnItem(index), C.bg, [
          // A barra vermelha é o acento do painel, virado de lado:
          // é ela que diz "é este" à distância de um olhar.
          panel(`${id}b`, columnAccent(), C.rust),
          label(`${id}l`, text, fill(CELL.positionLeft, 0, 10, 0), {
            size: 12,
            align: 'MiddleLeft',
            color: C.text,
            font: 'RobotoCondensed-Bold.ttf',
          }),
        ]),
      );

      continue;
    }

    items.push(
      button(
        id,
        text,
        // ####  O BOTÃO COMEÇA ONDE O TEXTO DO ATIVO COMEÇA  ####
        //
        // O texto de um `CuiButton` preenche o botão inteiro (ver
        // game/ui-cui.ts:280) — não há margem para dar dentro
        // dele. Quem dá a margem é o RETÂNGULO: recuado, o texto
        // alinhado à esquerda cai exatamente sob o do item ativo,
        // que é recuado pelo `fill` do rótulo dele.
        columnItem(index, CELL.positionLeft),
        {
          id: `a${id}`,
          kind: 'navigate',
          // ####  A PÁGINA DA COLUNA VIAJA; A DA LISTA, NÃO  ####
          //
          // Trocar de ranking volta a lista ao primeiro colocado —
          // a página 4 do ranking anterior não quer dizer nada
          // neste. Já a página da COLUNA é onde o dedo do jogador
          // está: perdê-la jogaria a coluna de volta ao começo no
          // mesmo clique em que ele escolheu um item do fim.
          screenId: rankingScreenId(entry.metric, 0, view.columnPage),
        },
        {
          color: C.none,
          textColor: C.textMuted,
          // O hover ESCURECE, na direção do item aberto: passar o
          // mouse prenuncia o que o clique faz. Clarear apontaria
          // para o lado contrário, e num menu escuro os dois
          // estados ficariam parecidos demais para valerem de
          // resposta.
          hoverColor: C.surface,
          fontSize: 12,
          align: 'MiddleLeft',
        },
      ),
    );
  }

  if (view.columnPages > 1) {
    items.push(
      rowsPager({
        prefix: 'rkc',
        rect: {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: 0, y: 0 },
          offsetMax: { x: 0, y: PAGER_HEIGHT },
        },
        page: view.columnPage,
        pages: view.columnPages,
        // A página da LISTA vai junto: virar a coluna não é sair do
        // ranking que se está lendo.
        screenIdOf: (next) => rankingScreenId(view.active?.metric ?? null, view.page, next),
        kind: 'navigate',
      }),
    );
  }

  // ####  O FUNDO DA COLUNA É A DIVISÓRIA  ####
  //
  // Ela já teve um fundo transparente e uma régua de 1 px ao lado.
  // Pintar a coluna faz o mesmo trabalho com UM elemento a menos —
  // e num documento cujo teto é o frame do RCON, cada elemento a
  // menos é espaço para uma linha a mais da lista.
  return [panel('rk-col', columnRect(), C.surface2, items)];
}

/**
 * O rótulo que cabe na largura da coluna.
 *
 * ####  CORTAR AQUI É O ÚLTIMO RECURSO, E NÃO O NORMAL  ####
 *
 * A coluna existe justamente para o nome caber inteiro, e o
 * `shortLabel` já resolve o caso comum. Isto é a defesa contra o
 * nome que ninguém previu: sem ela, "Tiro mais longo do servidor
 * inteiro" desenharia por cima da primeira coluna da lista.
 */
export function columnLabel(text: string): string {
  const room = COLUMN.width - CELL.positionLeft - 10;
  const upper = text.toUpperCase();

  if (textWidth(upper, 12) <= room) {
    return upper;
  }

  // `textWidth` é 0,55 do corpo por caractere — a média da
  // RobotoCondensed. Invertida, ela diz quantos cabem.
  const fits = Math.max(1, Math.floor(room / (12 * 0.55)) - 1);

  return `${upper.slice(0, fits)}…`;
}

// ------------------------------------------------------------
//  O subtítulo
// ------------------------------------------------------------

/**
 * "Abates · medido desde 01/09/2026 14:00 · 37 jogadores".
 *
 * ####  "MEDIDO DESDE" NÃO É ENFEITE  ####
 *
 * Um ranking premiado que não diz desde quando mede é um ranking
 * que vai ser contestado — e a janela deste projeto vira sozinha
 * (por wipe, por temporada). Sem a data, quem entrou depois da
 * virada lê a lista como se ela fosse de sempre.
 */
function subtitleOf(view: RankingScreenView): string {
  const parts: string[] = [view.active?.label ?? 'Ranking'];

  if (view.measuredSince !== null) {
    parts.push(`medido desde ${formatWhen(view.measuredSince)}`);
  }

  if (view.total > 0) {
    parts.push(`${formatNumber(view.total)} ${view.total === 1 ? 'jogador' : 'jogadores'}`);
  }

  return parts.join('  ·  ');
}

// ------------------------------------------------------------
//  A lista
// ------------------------------------------------------------

/**
 * A caixa que ocupa a área central inteira.
 *
 * ####  ELA ESTICA ATÉ O FUNDO DE PROPÓSITO  ####
 *
 * A tela antiga reservava uma caixa de altura fixa e deixava o
 * resto do slot vazio — metade da área central era um retângulo
 * sem nada. Esticada, o cabeçalho fica no alto, as linhas descem
 * do alto, e a faixa do jogador e o pager ficam ANCORADOS
 * EMBAIXO: a área é usada inteira sem ninguém precisar acertar
 * uma altura à mão.
 */
function listBox(view: RankingScreenView, left: number): UiElement {
  return panel('rk-lista', stretch(left, Y.body + CONTENT.list), C.none, listBody(view));
}

function listBody(view: RankingScreenView): UiElement[] {
  const active = view.active;
  const message = emptyMessage(view);

  if (message !== null || active === null) {
    return [
      label(
        'rk-vazio',
        // O `??` é defesa: com `active` nulo, `emptyMessage` já
        // devolveu uma frase. Um rótulo vazio no meio da tela
        // seria o desfecho pior de todos.
        message ?? 'Nenhum ranking está ligado neste servidor.',
        fill(20, 20, 20, 20),
        { size: 13, color: C.textMuted },
      ),
    ];
  }

  const elements: UiElement[] = [
    // ####  UM CABEÇALHO SÓ, E É O DA DIREITA  ####
    //
    // "#" rotularia uma coluna que diz "1º 2º 3º" e "JOGADOR" uma
    // coluna de nomes de gente: os dois explicam o que já se vê, e
    // cada rótulo desses é um elemento a mais num frame de RCON
    // que tem teto. O da direita é o único que diz o que o número
    // NÃO diz — é ele que faz "1.284" ser abates e não mortes.
    label('rk-c3', active.label.toUpperCase(), valueCell(PAD, LIST_HEADER), {
      size: 10,
      align: 'MiddleRight',
      color: C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),
    panel('rk-cl', rule(PAD + LIST_HEADER + 1), C.border),
  ];

  for (const [index, entry] of view.entries.entries()) {
    elements.push(
      ...row(`rk-r${String(index)}`, entry, PAD + LIST_HEADER + LIST_GAP + index * ROW, active),
    );
  }

  if (view.pages > 1) {
    const metric = active.metric;

    elements.push(
      rowsPager({
        prefix: 'rk',
        rect: bottom(FOOT.pager, PAGER_HEIGHT),
        page: view.page,
        pages: view.pages,
        // A página da coluna vai junto: virar a lista não pode
        // fazer a coluna esquecer onde estava.
        screenIdOf: (next) => rankingScreenId(metric, next, view.columnPage),
        // `navigate` porque isto é uma PÁGINA: o `modal.open` dos
        // kits existe para não fechar o modal em que a lista mora.
        kind: 'navigate',
      }),
    );
  }

  elements.push(...selfBand(view));

  return elements;
}

/**
 * A frase do lugar da lista, quando não há lista.
 *
 * ####  UMA TABELA VAZIA É A PIOR RESPOSTA  ####
 *
 * Ela afirma, sem dizer, que ninguém pontuou — e as razões para
 * ela estar vazia são bem diferentes entre si.
 */
function emptyMessage(view: RankingScreenView): string | null {
  if (view.trouble === 'falhou') {
    return 'Não consegui montar o ranking agora. Tente de novo em alguns segundos.';
  }

  // Vem antes do "nenhum ranking ligado" por causa da tela em
  // REPOUSO, a que fica gravada no documento: ela não tem ranking
  // nenhum e mesmo assim a frase certa para ela é a do nada
  // medido — dizer que o servidor não tem ranking seria uma
  // afirmação que ela não tem como fazer.
  if (view.trouble === 'nao-medido') {
    return 'Ainda não há nada medido neste ranking.';
  }

  if (view.trouble === 'sem-rankings' || view.active === null) {
    return 'Nenhum ranking está ligado neste servidor.';
  }

  if (view.entries.length > 0) {
    return null;
  }

  // ####  COM AVISO NO TOPO, AQUI NÃO SE REPETE A EXPLICAÇÃO  ####
  //
  // O porquê já está escrito na faixa lá em cima — repeti-lo aqui
  // era o defeito que este redesenho veio corrigir. O que falta
  // dizer é só o que se vê: não há colocados. E a frase é NEUTRA
  // de propósito: "não há nada medido" seria uma afirmação sobre
  // os jogadores num momento em que a verdade é sobre a coleta.
  if (coverageMessageOf(view.coverage) !== null) {
    return 'Sem colocados para mostrar por enquanto.';
  }

  return 'Ainda não há nada medido neste ranking.';
}

/** Uma linha: a posição, o nome e o valor. */
function row(
  id: string,
  entry: RankingScreenEntry,
  top: number,
  ranking: RankingScreenRanking,
): UiElement[] {
  // A linha dele fica em vermelho no meio das outras: é o que
  // permite achar-se sem ler os dez nomes.
  const color = entry.mine ? C.rust : C.text;

  return [
    label(`${id}p`, positionText(entry.position), cell(CELL.positionLeft, CELL.positionRight, top, ROW), {
      size: 12,
      align: 'MiddleRight',
      color: entry.mine ? C.rust : C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),
    label(`${id}n`, entry.name ?? 'jogador sem nome', nameCell(top, ROW), {
      size: 12,
      align: 'MiddleLeft',
      color,
    }),
    label(`${id}v`, formatRankingValue(entry.value, ranking), valueCell(top, ROW), {
      size: 12,
      align: 'MiddleRight',
      color,
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];
}

/** "1º", "12º" — o lugar, e não um número solto. */
function positionText(position: number): string {
  return `${formatNumber(position)}º`;
}

// ------------------------------------------------------------
//  A faixa dele
// ------------------------------------------------------------

/**
 * A linha do próprio jogador, no rodapé da lista.
 *
 * ####  ELA APARECE SEMPRE, INCLUSIVE QUANDO ELE ESTÁ NO TOP  ####
 *
 * É a única informação que ele foi ver, e ela não pode depender de
 * ele se achar entre dez nomes. No top, a faixa repete o que a
 * lista já diz — e repetir é barato perto de o jogador virar
 * quatro páginas para descobrir que está em 37º.
 *
 * ####  E ELA USA AS COLUNAS DA LISTA  ####
 *
 * Posição sob as posições, nome sob os nomes, valor sob os
 * valores. É o que permite a única comparação que interessa —
 * "quanto falta para o décimo" — sem ninguém precisar procurar
 * qual número é qual.
 */
function selfBand(view: RankingScreenView): UiElement[] {
  const self = view.self;
  const active = view.active;

  // Sem jogador (a carga que vai ao servidor sem ninguém) não há
  // "você": um texto fixo aqui seria lido como o estado de quem
  // abriu o menu.
  if (self === null || active === null || view.trouble !== null) {
    return [];
  }

  const inner: UiElement[] = [
    label(
      'rk-eup',
      self.kind === 'unranked' ? '—' : positionText(self.entry.position),
      cell(CELL.positionLeft, CELL.positionRight, 0, FOOT.selfHeight),
      { size: 14, align: 'MiddleRight', color: C.rust, font: 'RobotoCondensed-Bold.ttf' },
    ),
    label(
      'rk-eun',
      self.kind === 'unranked' ? 'VOCÊ  ·  ainda não pontuou neste ranking' : 'VOCÊ',
      nameCell(0, FOOT.selfHeight),
      { size: 12, align: 'MiddleLeft', color: C.textMuted, font: 'RobotoCondensed-Bold.ttf' },
    ),
  ];

  if (self.kind === 'ranked') {
    inner.push(
      label(
        'rk-euv',
        formatRankingValue(self.entry.value, active),
        valueCell(0, FOOT.selfHeight),
        { size: 14, align: 'MiddleRight', color: C.text, font: 'RobotoCondensed-Bold.ttf' },
      ),
    );
  }

  return [
    panel('rk-eur', rule(FOOT.rule, true), C.border),
    panel('rk-eu', bottom(FOOT.self, FOOT.selfHeight), C.surface2, inner),
  ];
}

// ------------------------------------------------------------
//  Retângulos
//
//  Tudo aqui é ÂNCORA, e não pixel absoluto: a tela continua
//  inteira se o admin redimensionar o slot de conteúdo no editor.
//  As medidas de §3 só contam quantos itens cabem.
// ------------------------------------------------------------

/** Uma faixa da largura do pai a partir de `left`, medida do topo. */
function band(left: number, top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -(top + height) },
    offsetMax: { x: 0, y: -top },
  };
}

/** Uma área que começa em `top` e ESTICA até o fundo do pai. */
function stretch(left: number, top: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: 0 },
    offsetMax: { x: 0, y: -top },
  };
}

/** A coluna: largura fixa à esquerda, esticada até o fundo. */
function columnRect(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: COLUMN.width, y: -Y.body },
  };
}

/** Um item da coluna, contado do topo dela. */
function columnItem(index: number, left = 0): Rect {
  const top = index * COLUMN.item;

  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -(top + COLUMN.item) },
    offsetMax: { x: 0, y: -top },
  };
}

/** A barra de acento do item ativo, colada na borda esquerda. */
function columnAccent(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 3 },
    offsetMax: { x: 3, y: -3 },
  };
}

/** Uma faixa contada do FUNDO do pai. */
function bottom(from: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: 0, y: from },
    offsetMax: { x: 0, y: from + height },
  };
}

/** Uma régua de 1 px, do topo ou do fundo do pai. */
function rule(at: number, fromBottom = false): Rect {
  return fromBottom
    ? {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 1, y: 0 },
        offsetMin: { x: PAD, y: at },
        offsetMax: { x: -PAD, y: at + 1 },
      }
    : {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: PAD, y: -(at + 1) },
        offsetMax: { x: -PAD, y: -at },
      };
}

/** Uma célula de largura fixa, ancorada à esquerda. */
function cell(left: number, right: number, top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: left, y: -(top + height) },
    offsetMax: { x: right, y: -top },
  };
}

/** A célula do nome: o que sobra entre a posição e o valor. */
function nameCell(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: CELL.nameLeft, y: -(top + height) },
    offsetMax: { x: -(CELL.valueWidth + CELL.valueRight), y: -top },
  };
}

/** A célula do valor, colada à DIREITA — o número alinha por ali. */
function valueCell(top: number, height: number): Rect {
  return {
    anchorMin: { x: 1, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: -(CELL.valueWidth + CELL.valueRight), y: -(top + height) },
    offsetMax: { x: -CELL.valueRight, y: -top },
  };
}

// ============================================================
//  §5  O PROVEDOR
// ============================================================

export type RankingScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

export interface RankingScreenProviderOptions {
  readonly rankings: RankingScreenReader;
  readonly logger?: Logger;
}

/**
 * O provedor que o `generatedScreens` do index.ts chama.
 *
 * ####  ELE RECONHECE UMA FAMÍLIA, E POR ISSO VEM CEDO  ####
 *
 * `tela-ranking`, `tela-ranking:pvp.kills`,
 * `tela-ranking:pvp.kills:2:1` — todos são dele. Quem reconhece
 * uma família de endereços é perguntado ANTES de quem reconhece um
 * id exato, como a loja é perguntada antes dos kits.
 *
 * ####  ELE NUNCA DEIXA O JOGADOR NO "CARREGANDO"  ####
 *
 * `null` só para o que não é dele. Qualquer falha vira a TELA com
 * o aviso — volátil, e por isso o clique seguinte tenta de novo —
 * em vez de uma exceção que sobe até o `UiSync` e cai na tela do
 * documento.
 */
export function createRankingScreenProvider(
  options: RankingScreenProviderOptions,
): RankingScreenProvider {
  return async (input) => {
    const target = parseRankingScreenId(input.screenId);

    if (target === null) {
      return null;
    }

    const pack = (view: RankingScreenView): UiScreenBundle =>
      toGeneratedScreenBundle(
        input.document,
        buildRankingScreen({ view, screenId: input.screenId }),
        // O SHELL conhece `tela-ranking`: sem isto, o destaque do
        // botão RANKING sumiria justamente ao entrar nele.
        RANKING_SCREEN_ID,
      );

    try {
      return pack(
        await readRankingView({
          rankings: options.rankings,
          serverId: input.serverId,
          steamId: input.steamId,
          target,
        }),
      );
    } catch (error) {
      options.logger?.error(
        { server: input.serverId, screen: input.screenId, err: toError(error) },
        'não consegui montar a página RANKING; mando a tela com o aviso, que não fica em cache',
      );

      return pack({ ...emptyRankingView(), trouble: 'falhou' });
    }
  };
}
