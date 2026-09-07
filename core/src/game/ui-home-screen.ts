// ============================================================
//  ui-home-screen.ts  -  a HOME deixa de ser um cartaz.
//
//  ####  O QUE ELA ERA  ####
//
//  Um banner e três cartões com frases escritas à mão: "O próximo
//  wipe e o que ele leva", "O que está acontecendo agora no
//  servidor". Nenhuma delas dizia QUANDO é o wipe, QUEM está em
//  primeiro, ou O QUE entrou na loja. Era a primeira tela do menu,
//  e a única sem um número dentro.
//
//  Agora ela responde as quatro perguntas que levam alguém a abrir
//  o menu, cada uma num cartão:
//
//    TOP RANKING     quem lidera, e onde ELE está
//    NOVO NA LOJA    a oferta em destaque, com o botão de comprar
//    PRÓXIMO WIPE    a data, a contagem, e o que o wipe leva
//    SUAS MISSÕES    o que está em andamento, com o progresso
//
//  ------------------------------------------------------------
//  ####  ELA É MONTADA A CADA ABERTURA, E ISSO TEM UM CUSTO  ####
//
//  A tela de ENTRADA é a única que viaja na carga inicial do
//  documento (ver types/ui-transport.ts) — e é justamente ela que
//  agora depende de quem está olhando. A saída é a mesma das
//  missões: a tela gravada vai marcada com `generated: true`, o
//  plugin desenha o REPOUSO no instante da abertura e pede a de
//  verdade no mesmo movimento.
//
//  Sem a marca, o plugin desenharia o repouso e nunca pediria — o
//  jogador ficaria com "Carregando…" para sempre. Isso foi MEDIDO
//  no jogo com a tela de missões, em 06/09/2026.
//
//  ------------------------------------------------------------
//  ####  QUATRO LEITURAS, QUATRO REDES DE PROTEÇÃO  ####
//
//  A home lê o ranking, a loja, a agenda de wipes e as missões. Um
//  `try` em volta das quatro faria o banco de missões derrubar o
//  cartão do wipe — e o jogador veria a tela inteira dizendo que
//  não deu, por causa de uma coisa que ele nem estava olhando.
//
//  Cada bloco tem o seu, e a falha vira a FRASE daquele cartão. É
//  a mesma escolha do calendário, aplicada quatro vezes.
//
//  ------------------------------------------------------------
//  ####  O DESENHO É DO ADMIN; O DADO É NOSSO  ####
//
//  Ela nasce pelo mecanismo de ui-template.ts: a tela gravada no
//  documento é o MODELO, e o agente derrama o dado nos lugares que
//  o admin desenhou. Mover um cartão, trocar a cor do título ou
//  reescrever "TOP RANKING" é edição no painel, sem deploy.
//
//  E as AÇÕES nunca vêm do documento: o botão de comprar carrega o
//  `offerId`, e o endereço do modal tem `:`, que o `uiDocumentSchema`
//  recusa em ação gravada. Ver o cabeçalho de ui-template.ts.
// ============================================================

import type { OfferBadge } from '../db/store-repository.js';
import type { Logger } from '../logger.js';
import {
  describeBpPolicy,
  describeNextWipeMap,
  formatWipeCountdown,
  formatWipeMoment,
} from '../messages/providers/wipe.js';
import type { UiAction, UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import { toError } from '../util.js';
import { nextWipe, type NextWipeDeps } from '../wipe/next-wipe.js';

import { CALENDAR_SCREEN_ID } from './ui-calendar-screen.js';
import { screenViewport, type Size } from './ui-geometry.js';
import {
  formatRankingValue,
  RANKING_SCREEN_ID,
  readRankingView,
  type RankingScreenReader,
} from './ui-ranking-screen.js';
import { QUESTS_SCREEN_ID } from './ui-quests-screen.js';
// O endereço do modal de compra vem de quem o CONSTRÓI. Repetir
// `ozitem:<id>:1` aqui criaria um segundo lugar de onde ele sai — e
// o plugin descarta a resposta cujo id não bate com o pedido, então
// a divergência apareceria como um botão que não faz nada.
import { itemScreenId, STORE_SCREEN_ID } from './ui-store-screens.js';
import { fillTemplate, findTemplate, measureSlot, type SlotValue } from './ui-template.js';
import {
  button,
  C,
  fill,
  formatNumber,
  itemImage,
  label,
  LIST_LINE,
  panel,
  topBar,
  type Rect,
} from './ui-widgets.js';

/**
 * O id da tela no documento.
 *
 * FIXO, e não sorteado: é o `entryScreenId` do menu e o destino do
 * botão HOME. Precisa bater com o preset — ver
 * game/ui-preset-main-menu.ts.
 */
export const HOME_SCREEN_ID = 'tela-home';

/** O endereço é dela? Um id exato, como o do calendário. */
export function isHomeScreenId(screenId: string): boolean {
  return screenId === HOME_SCREEN_ID;
}

/**
 * Os lugares que o agente preenche na tela DESENHADA.
 *
 * Casam pelo FIM do id (ver `slotOf` em ui-template.ts), e é isso
 * que permite ao admin renomear o elemento no editor para
 * `banner-hm-ola` sem quebrar nada. O contrário — apagar o sufixo —
 * quebra em SILÊNCIO: o rótulo fica com o texto de exemplo.
 */
export const HOME_SLOTS = {
  /** A métrica que a lista está mostrando. */
  rankMetric: 'hm-rk-sub',
  /** A caixa das linhas do pódio. O agente derrama dentro. */
  rankList: 'hm-rk-lista',
  /** Onde ELE está. */
  rankSelf: 'hm-rk-voce',
  rankButton: 'hm-rk-btn',

  offerIcon: 'hm-loja-icone',
  offerName: 'hm-loja-nome',
  offerPrice: 'hm-loja-preco',
  /** O preço riscado, quando há promoção. */
  offerOld: 'hm-loja-antes',
  /** A etiqueta (PROMO, NOVO, DESTAQUE): o painel colorido… */
  offerBadge: 'hm-loja-tag',
  /** …e o texto dentro dele. */
  offerBadgeText: 'hm-loja-tagl',
  offerButton: 'hm-loja-btn',

  wipeWhen: 'hm-wipe-data',
  wipeCountdown: 'hm-wipe-falta',
  wipeNote: 'hm-wipe-nota',
  wipeButton: 'hm-wipe-btn',

  /** A caixa das missões em andamento. */
  questList: 'hm-quest-lista',
  questNote: 'hm-quest-nota',
  questButton: 'hm-quest-btn',
} as const;

/**
 * O nome de quem abriu, dentro do texto do ADMIN.
 *
 * ####  POR QUE UMA VARIÁVEL, E NÃO UM RÓTULO NOSSO  ####
 *
 * A primeira versão punha "Olá, Fulano" num rótulo próprio, à
 * direita do banner. Funcionava, e ficava ao lado de um título
 * "BEM-VINDO" que não sabia com quem estava falando — duas
 * saudações na mesma faixa, uma delas escrita pelo agente num
 * lugar que o admin não escolheu.
 *
 * Com a variável, quem decide onde o nome aparece é quem escreve o
 * texto: `BEM-VINDO, {jogador}` no título, ou no subtítulo, ou nos
 * dois. É o mesmo desenho do `{wipe.faltam}` do chat.
 *
 * ####  SEM NOME, A PONTUAÇÃO VAI JUNTO  ####
 *
 * A carga inicial vai ao servidor sem jogador nenhum, e plugin
 * antigo não manda o `steamId`. Trocar por vazio deixaria
 * "BEM-VINDO," com a vírgula pendurada — então o separador
 * grudado no lugar do nome sai com ele.
 */
export const PLAYER_VARIABLE = '{jogador}';

/**
 * Troca `{jogador}` pelo nome, ou o apaga junto do separador.
 *
 * Roda no texto FINAL — depois do preenchimento —, e por isso vale
 * igual para o layout embutido e para o desenho do editor.
 */
export function applyPlayerName(text: string, name: string): string {
  if (!text.includes(PLAYER_VARIABLE)) {
    return text;
  }

  if (name !== '') {
    return text.split(PLAYER_VARIABLE).join(name);
  }

  // O separador imediatamente ANTES (`BEM-VINDO, {jogador}`) ou
  // DEPOIS (`{jogador}, bem-vindo`) some com a variável; o resto do
  // texto do admin fica como ele escreveu.
  return text
    .replace(/\s*[,;:·—–-]?\s*\{jogador\}\s*[,;:·—–-]?\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A tela inteira com o nome já aplicado nos textos. */
function withPlayerName(elements: readonly UiElement[], name: string): UiElement[] {
  return elements.map((element) => {
    const children = withPlayerName(element.children, name);

    if (element.type === 'label' || element.type === 'button') {
      return { ...element, text: applyPlayerName(element.text, name), children };
    }

    return { ...element, children };
  });
}

/**
 * Quantas linhas cada lista mostra, no máximo.
 *
 * Três, e não "o que couber": a home é um RESUMO, e a tela inteira
 * de cada assunto está a um clique. Uma lista de dez colocados aqui
 * competiria com a página de ranking sem substituí-la.
 */
const MAX_LINES = 3;

// ------------------------------------------------------------
//  §1  O QUE A TELA MOSTRA
//
//  Tudo já recortado e já FORMATADO: o desenho não faz conta nem
//  vai ao banco. É o que permite testar a tela com um objeto
//  literal, e o que mantém o relógio fora do desenho.
// ------------------------------------------------------------

export interface HomeRankLine {
  readonly position: number;
  /** Vazio = o jogador saiu da base; o número continua valendo. */
  readonly name: string;
  /** Já formatado por `formatRankingValue`. */
  readonly value: string;
  /** É a linha de quem está olhando? */
  readonly mine: boolean;
}

export interface HomeRankView {
  /** O nome do ranking mostrado. `null` = não há o que mostrar. */
  readonly metric: string | null;
  readonly top: readonly HomeRankLine[];
  /** A frase sobre quem está olhando, ou o que impediu a lista. */
  readonly self: string;
}

export interface HomeOfferView {
  readonly offerId: string;
  readonly name: string;
  readonly price: number;
  /** O preço riscado. `null` = não há promoção. */
  readonly oldPrice: number | null;
  readonly icon: { readonly itemId: number; readonly skinId: string };
  readonly badge: OfferBadge | null;
}

export interface HomeWipeView {
  /** `quinta, 03/09 às 16:00`, no fuso do servidor. */
  readonly when: string;
  /** `faltam 3 dias e 4 horas`. */
  readonly countdown: string;
  /** O que o wipe leva: blueprints e mundo. */
  readonly note: string;
}

export interface HomeQuestLine {
  readonly title: string;
  /** `3/10`, ou `2 de 4 objetivos`. */
  readonly progress: string;
  /** Todos os objetivos fecharam: falta resgatar. */
  readonly done: boolean;
}

/** A tela inteira, já recortada. O desenho não busca mais nada. */
export interface HomeView {
  /**
   * O NOME de quem abriu, e não uma frase pronta: quem escreve a
   * saudação é o admin, com o `{jogador}` dele. Vazio = ninguém
   * identificado, e aí a variável some do texto.
   */
  readonly player: string;
  readonly rank: HomeRankView;
  /** `null` = não há oferta a destacar, e aí vale `offerNote`. */
  readonly offer: HomeOfferView | null;
  readonly offerNote: string;
  /** `null` = não há wipe à vista, e aí vale `wipeNote`. */
  readonly wipe: HomeWipeView | null;
  readonly wipeNote: string;
  readonly quests: readonly HomeQuestLine[];
  readonly questNote: string;
}

/**
 * A home em REPOUSO: o que fica gravado no documento.
 *
 * ####  ELA DIZ "CARREGANDO", E ISSO É SEGURO AQUI  ####
 *
 * Numa tela que o plugin desenhasse e parasse, "carregando" seria
 * uma mentira permanente — foi o que aconteceu com as missões. Esta
 * vai marcada com `generated: true`, então o pedido sai no mesmo
 * instante do desenho, e o provedor NUNCA devolve `null` para o
 * endereço dela (ver `createHomeScreenProvider`).
 *
 * DETERMINÍSTICA — nada de `Date.now()` aqui dentro — porque o
 * preset é comparado byte a byte com o que está gravado.
 */
export function emptyHomeView(): HomeView {
  return {
    player: '',
    rank: { metric: null, top: [], self: 'Carregando o ranking…' },
    offer: null,
    offerNote: 'Carregando a loja…',
    wipe: null,
    wipeNote: 'Carregando a agenda…',
    quests: [],
    questNote: 'Carregando as suas missões…',
  };
}

// ------------------------------------------------------------
//  §2  A LEITURA
// ------------------------------------------------------------

/**
 * O que esta tela precisa da LOJA. E nada além.
 *
 * Uma interface mínima, como a `RankingScreenReader`: o
 * `StoreService.catalog()` a satisfaz estruturalmente, sem esta
 * tela conhecer a classe nem o repositório.
 */
export interface HomeStoreOffer {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly oldPrice: number | null;
  readonly badge: OfferBadge | null;
  readonly icon: { readonly itemId: number; readonly skinId: string };
  /** Epoch ms. É por ele que "a novidade" é escolhida. */
  readonly createdAt: number;
}

export interface HomeStoreReader {
  catalog(): readonly { readonly offers: readonly HomeStoreOffer[] }[];
}

/** O que esta tela precisa das MISSÕES. */
export interface HomeQuestsReader {
  liveFor(input: { readonly serverId: string; readonly steamId: string }): readonly {
    readonly title: string;
    readonly complete: boolean;
    readonly objectives: readonly {
      readonly label: string;
      readonly have: number;
      readonly need: number;
      readonly done: boolean;
    }[];
  }[];
}

export interface HomeScreenDeps {
  readonly rankings: RankingScreenReader;
  readonly store: HomeStoreReader;
  /** `null` = as missões não estão de pé nesta subida. */
  readonly quests: HomeQuestsReader | null;
  /** `null` = a agenda ainda não foi montada. Ver o index.ts. */
  readonly wipe: NextWipeDeps | null;
  /** O nome de quem está olhando. Ausente = sem saudação. */
  readonly nameOf?: (steamId: string) => string | null;
  readonly logger?: Logger;
}

export interface ReadHomeViewInput {
  readonly deps: HomeScreenDeps;
  readonly serverId: string;
  /** Quem está olhando. `undefined` = ninguém (a carga inicial). */
  readonly steamId: string | undefined;
  readonly now: number;
}

/**
 * Lê as quatro fontes e devolve SÓ o que vai ser desenhado.
 *
 * Cada bloco tem o seu `try`: ver o cabeçalho. O que uma falha
 * produz é a frase daquele cartão — e como a tela é `volatile`, o
 * clique seguinte tenta de novo.
 */
export async function readHomeView(input: ReadHomeViewInput): Promise<HomeView> {
  const { deps } = input;

  return {
    player: playerNameOf(deps, input.steamId),
    rank: await readRank(input),
    ...readOffer(input),
    ...readWipe(input),
    ...readQuests(input),
  };
}

function playerNameOf(deps: HomeScreenDeps, steamId: string | undefined): string {
  if (steamId === undefined) {
    return '';
  }

  // O SteamID cru não serve de nome: "BEM-VINDO, 7656119…" é pior
  // que a saudação sem nome nenhum.
  return deps.nameOf?.(steamId) ?? '';
}

/**
 * O pódio, do ranking que abre por padrão.
 *
 * Reusa `readRankingView` — a MESMA leitura da página de RANKING —
 * em vez de perguntar ao serviço por conta própria. É o que garante
 * que o "1º Fulano" da home seja o mesmo "1º Fulano" da página: uma
 * segunda consulta com outro critério de métrica padrão daria duas
 * respostas para a mesma pergunta.
 */
async function readRank(input: ReadHomeViewInput): Promise<HomeRankView> {
  try {
    const view = await readRankingView({
      rankings: input.deps.rankings,
      serverId: input.serverId,
      steamId: input.steamId,
      target: { metric: null, page: 0, columnPage: null },
    });

    if (view.active === null) {
      return { metric: null, top: [], self: troubleWord(view.trouble) };
    }

    const active = view.active;

    return {
      metric: active.label,
      top: view.entries.slice(0, MAX_LINES).map((entry) => ({
        position: entry.position,
        name: entry.name ?? '',
        value: formatRankingValue(entry.value, active),
        mine: entry.mine,
      })),
      self: selfWord(view.self, view.total, active.label),
    };
  } catch (error) {
    input.deps.logger?.error(
      { server: input.serverId, err: toError(error) },
      'não consegui ler o ranking para a HOME; o cartão sai com o aviso',
    );

    return { metric: null, top: [], self: 'Não consegui ler o ranking agora.' };
  }
}

function troubleWord(trouble: HomeRankTrouble): string {
  switch (trouble) {
    case 'sem-rankings':
      return 'Nenhum ranking está ligado neste servidor.';

    case 'falhou':
      return 'Não consegui ler o ranking agora.';

    default:
      return 'Ainda não há nada medido por aqui.';
  }
}

/** O que `readRankingView` devolve em `trouble`. */
type HomeRankTrouble = 'sem-rankings' | 'nao-medido' | 'falhou' | null;

/**
 * A frase de quem está olhando.
 *
 * "em último" e "não pontuou" são coisas diferentes, e dizer a
 * primeira para quem nem jogou ofende — a mesma distinção que a
 * página de ranking faz.
 */
function selfWord(
  self: { readonly kind: 'ranked'; readonly entry: { readonly position: number } } | { readonly kind: 'unranked' } | null,
  total: number,
  metric: string,
): string {
  if (self === null) {
    return `${metric} · ${String(total)} na disputa`;
  }

  if (self.kind === 'unranked') {
    return 'Você ainda não pontuou aqui.';
  }

  return `Você está em ${String(self.entry.position)}º de ${String(total)}`;
}

/**
 * A oferta em destaque.
 *
 * ####  A ETIQUETA MANDA MAIS QUE A DATA  ####
 *
 * "Novidade" é o que o ADMIN diz que é: uma oferta marcada como
 * DESTAQUE existe justamente para aparecer na frente, e ordenar só
 * por data a enterraria no dia seguinte. A data é o desempate — e o
 * critério inteiro quando ninguém marcou nada.
 */
function readOffer(input: ReadHomeViewInput): Pick<HomeView, 'offer' | 'offerNote'> {
  try {
    const offers = input.deps.store.catalog().flatMap((entry) => entry.offers);

    if (offers.length === 0) {
      return { offer: null, offerNote: 'A loja ainda não tem oferta ligada.' };
    }

    const best = [...offers].sort(
      (a, b) => badgeWeight(b.badge) - badgeWeight(a.badge) || b.createdAt - a.createdAt,
    )[0];

    if (best === undefined) {
      return { offer: null, offerNote: 'A loja ainda não tem oferta ligada.' };
    }

    return {
      offer: {
        offerId: best.id,
        name: best.name,
        price: best.price,
        oldPrice: best.oldPrice,
        icon: best.icon,
        badge: best.badge,
      },
      offerNote: '',
    };
  } catch (error) {
    input.deps.logger?.error(
      { server: input.serverId, err: toError(error) },
      'não consegui ler a loja para a HOME; o cartão sai com o aviso',
    );

    return { offer: null, offerNote: 'Não consegui ler a loja agora.' };
  }
}

function badgeWeight(badge: OfferBadge | null): number {
  switch (badge) {
    case 'destaque':
      return 3;

    case 'novo':
      return 2;

    case 'promo':
      return 1;

    default:
      return 0;
  }
}

/**
 * O próximo wipe — a MESMA decisão que responde `{wipe.faltam}` no
 * chat e que monta o cartão grande do calendário.
 *
 * Três superfícies, uma função: sem isso, a home diria "faltam 7
 * dias" enquanto o chat contava as horas de um wipe forçado que
 * ninguém pôs na agenda.
 */
function readWipe(input: ReadHomeViewInput): Pick<HomeView, 'wipe' | 'wipeNote'> {
  if (input.deps.wipe === null) {
    return { wipe: null, wipeNote: 'Não consegui ler a agenda agora.' };
  }

  try {
    const next = nextWipe(input.serverId, input.deps.wipe, input.now);

    if (next === null) {
      return { wipe: null, wipeNote: 'Ninguém marcou o próximo wipe deste servidor.' };
    }

    const remaining = formatWipeCountdown(next.wipeAt - input.now);
    const map = describeNextWipeMap(next.map);

    return {
      wipe: {
        when: formatWipeMoment(next.wipeAt, next.timeZone),
        // O wipe que já começou continua contando: a hora marcada é
        // a do MUNDO zerando, e os avisos saem antes dela.
        countdown:
          remaining === 'agora'
            ? 'o mundo está zerando agora'
            : `${next.running ? 'já começou · ' : ''}faltam ${remaining}`,
        note: [
          `Blueprints ${describeBpPolicy(next.bpPolicy)}.`,
          map === null ? 'O mundo ainda não foi anunciado.' : `Mundo: ${map}.`,
        ].join('\n'),
      },
      wipeNote: '',
    };
  } catch (error) {
    input.deps.logger?.error(
      { server: input.serverId, err: toError(error) },
      'não consegui ler a agenda para a HOME; o cartão sai com o aviso',
    );

    return { wipe: null, wipeNote: 'Não consegui ler a agenda agora.' };
  }
}

/**
 * As missões em andamento, as completas na frente.
 *
 * Quem tem uma missão pronta para resgatar precisa ver isso ANTES
 * de qualquer outra — é a única linha desta tela que pede uma ação
 * do jogador em vez de informar.
 */
function readQuests(input: ReadHomeViewInput): Pick<HomeView, 'quests' | 'questNote'> {
  if (input.deps.quests === null || input.steamId === undefined) {
    return { quests: [], questNote: 'Abra o menu no jogo para ver as suas missões.' };
  }

  const steamId = input.steamId;

  try {
    const live = [...input.deps.quests.liveFor({ serverId: input.serverId, steamId })].sort(
      (a, b) => Number(b.complete) - Number(a.complete),
    );

    if (live.length === 0) {
      return { quests: [], questNote: 'Você ainda não aceitou nenhuma missão.' };
    }

    const done = live.filter((quest) => quest.complete).length;

    return {
      quests: live.slice(0, MAX_LINES).map((quest) => ({
        title: quest.title,
        progress: progressOf(quest.objectives),
        done: quest.complete,
      })),
      questNote:
        done > 0
          ? `${plural(done, 'missão pronta', 'missões prontas')} para resgatar`
          : `${plural(live.length, 'missão', 'missões')} em andamento`,
    };
  } catch (error) {
    input.deps.logger?.error(
      { server: input.serverId, err: toError(error) },
      'não consegui ler as missões para a HOME; o cartão sai com o aviso',
    );

    return { quests: [], questNote: 'Não consegui ler as suas missões agora.' };
  }
}

/**
 * O progresso, na forma mais curta que ainda diz alguma coisa.
 *
 * Com UM objetivo, o número dele: `3/10` é mais informativo que
 * "0 de 1 objetivo". Com vários, quantos fecharam — os números de
 * quatro objetivos não cabem numa linha de cartão.
 */
function progressOf(
  objectives: readonly { readonly have: number; readonly need: number; readonly done: boolean }[],
): string {
  const only = objectives.length === 1 ? objectives[0] : undefined;

  if (only !== undefined) {
    return `${String(Math.min(only.have, only.need))}/${String(only.need)}`;
  }

  const done = objectives.filter((objective) => objective.done).length;

  return `${String(done)}/${String(objectives.length)} objetivos`;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

// ------------------------------------------------------------
//  §3  O DESENHO
//
//  As medidas são da base 1280x720 do CUI, e relativas ao SLOT de
//  conteúdo do shell — não à tela do jogo. Ver `screenViewport`.
// ------------------------------------------------------------

/**
 * Um cartão: painel em `--surface` sobre o fundo do conteúdo.
 *
 * ####  SEM A MOLDURA DE 1px, E DE PROPÓSITO  ####
 *
 * O menu desenha borda com dois painéis (um na cor da borda, outro
 * 1px menor por cima) — o CUI não tem borda. São CINCO cartões
 * aqui, ou dez elementos só de moldura, e esta tela é a de ENTRADA:
 * ela viaja inteira na carga inicial, que tem teto de 50.000 bytes
 * (ver types/ui-transport.ts).
 *
 * A grade da loja já resolve assim — `offerCard`, em
 * ui-store-screens.ts, é um painel só. O contraste entre
 * `--surface` e o `--bg` do conteúdo separa os cartões sem gastar
 * um elemento por linha.
 */
function card(id: string, rect: Rect, children: readonly UiElement[]): UiElement {
  return panel(id, rect, C.surface, children);
}

/** Faixa horizontal com a margem interna do cartão. */
function band(top: number, height: number, pad = PAD): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: pad, y: -(top + height) },
    offsetMax: { x: -pad, y: -top },
  };
}

/** Faixa colada no PÉ do cartão. */
function footer(height: number, bottom = PAD, pad = PAD): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: pad, y: bottom },
    offsetMax: { x: -pad, y: bottom + height },
  };
}

/** Faixa vertical colada à esquerda — a barra de acento. */
function leftBar(width: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: width, y: 0 },
  };
}

const PAD = 12;
const BANNER_HEIGHT = 116;
const CARD_GAP = 12;
/** A altura do botão do pé, e a faixa que ele reserva. */
const BUTTON_HEIGHT = 26;
const FOOTER_ROOM = BUTTON_HEIGHT + PAD + 22;

function columnRect(index: number, total: number): Rect {
  const width = 1 / total;
  const half = CARD_GAP / 2;

  return {
    anchorMin: { x: width * index, y: 0 },
    anchorMax: { x: width * (index + 1), y: 1 },
    offsetMin: { x: index === 0 ? 0 : half, y: 0 },
    offsetMax: {
      x: index === total - 1 ? 0 : -half,
      y: -(BANNER_HEIGHT + CARD_GAP),
    },
  };
}

/**
 * Quais cartões este servidor mostra.
 *
 * ####  UM CARTÃO SÓ EXISTE SE A TELA DELE EXISTIR  ####
 *
 * O documento é da REDE, mas cada servidor esconde pedaços dele (o
 * `hidden` do vínculo — ver `applyHidden`). Num servidor sem loja,
 * um cartão "NOVO NA LOJA" prometeria uma seção que não existe, e o
 * botão dele levaria a uma tela que o plugin nem conhece.
 *
 * A regra é uma só, e por isso é previsível: o cartão aparece
 * quando a tela que ele ABRE está no documento daquele servidor.
 * Esconder `tela-loja` esconde o cartão da loja, sem uma segunda
 * lista de ids para manter em dia.
 */
export interface HomeCards {
  readonly rank: boolean;
  readonly offer: boolean;
  readonly wipe: boolean;
  readonly quest: boolean;
}

/** A tela que cada cartão abre. */
export const HOME_CARD_TARGET: Readonly<Record<keyof HomeCards, string>> = {
  rank: RANKING_SCREEN_ID,
  offer: STORE_SCREEN_ID,
  wipe: CALENDAR_SCREEN_ID,
  quest: QUESTS_SCREEN_ID,
};

const ALL_CARDS: HomeCards = { rank: true, offer: true, wipe: true, quest: true };

/** O id do cartão de cada assunto, para escondê-lo no modelo. */
const CARD_ID: Readonly<Record<keyof HomeCards, string>> = {
  rank: 'hm-rk',
  offer: 'hm-loja',
  wipe: 'hm-wipe',
  quest: 'hm-quest',
};

/**
 * Quais cartões cabem NESTE documento.
 *
 * O documento chega ao provedor já podado pelo `hidden` daquele
 * servidor (ver `UiSync`), então perguntar quais telas ele tem é a
 * mesma coisa que perguntar o que aquele servidor mostra.
 */
export function cardsOf(document: UiDocument): HomeCards {
  const has = (screenId: string): boolean =>
    document.screens.some((screen) => screen.id === screenId);

  return {
    rank: has(HOME_CARD_TARGET.rank),
    offer: has(HOME_CARD_TARGET.offer),
    wipe: has(HOME_CARD_TARGET.wipe),
    quest: has(HOME_CARD_TARGET.quest),
  };
}

/** O título de um cartão, no estilo dos títulos do painel. */
function cardTitle(id: string, text: string): UiElement[] {
  return [
    panel(`${id}-acento`, topBar(2), C.rust),
    label(id, text, band(14, 22), {
      size: 14,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];
}

/** O botão do pé de cartão: leva à tela inteira daquele assunto. */
function cardButton(id: string, text: string, action: UiAction, accent = false): UiElement {
  return button(id, text, footer(BUTTON_HEIGHT), action, {
    color: accent ? C.rust : C.surface2,
    textColor: accent ? C.white : C.text,
    hoverColor: accent ? '#D4553FFF' : C.rust,
    fontSize: 11,
  });
}

export interface BuildHomeScreenOptions {
  readonly view: HomeView;
  /**
   * O id EXATO que foi pedido.
   *
   * Volta idêntico porque o plugin DESCARTA a resposta cujo id não
   * bate com o que ele pediu.
   */
  readonly screenId?: string;
  /**
   * O desenho gravado, para preencher em vez de montar.
   *
   * `null` ou ausente = o layout embutido. É o que mantém de pé o
   * documento gravado antes desta frente — a home antiga, de três
   * cartões mudos, não tem os slots e cai aqui inteira.
   */
  readonly template?: UiScreen | null;
  /** O tamanho de onde a tela é desenhada. Só importa com modelo. */
  readonly viewport?: Size;
  /**
   * Quais cartões este servidor mostra. Ausente = os quatro.
   *
   * Sai de `cardsOf(document)`: o cartão só existe se a tela que ele
   * abre existir. Ver `HomeCards`.
   */
  readonly cards?: HomeCards;
}

/**
 * A HOME, montada ou preenchida.
 *
 * O esqueleto — o que fica gravado no documento — é esta mesma
 * função com a `emptyHomeView()`: os elementos precisam EXISTIR no
 * desenho para o agente ter onde derramar, porque `fillTemplate`
 * preenche o que existe e não cria o que falta.
 */
export function buildHomeScreen(options: BuildHomeScreenOptions): UiScreen {
  if (options.template != null && isHomeTemplate(options.template)) {
    const filled = fillTemplate(
      options.template,
      options.screenId ?? HOME_SCREEN_ID,
      slotsOf(options),
    );

    // O `{jogador}` mora no texto do ADMIN, então ele é trocado
    // DEPOIS do preenchimento — e no desenho inteiro, não só no
    // banner: quem escrever a variável no título de um cartão ganha
    // o nome ali também.
    return { ...filled, elements: withPlayerName(filled.elements, options.view.player) };
  }

  const { view } = options;
  const cards = options.cards ?? ALL_CARDS;

  // Os cartões que sobraram dividem a largura entre si: com a loja
  // escondida, três cartões ocupam a tela inteira em vez de deixarem
  // um buraco de 25% onde ela estava. É o que o layout de código
  // pode fazer e o modelo desenhado não — lá a posição é do admin.
  const shown = (['rank', 'offer', 'wipe', 'quest'] as const).filter((key) => cards[key]);
  const rectOf = (key: (typeof shown)[number]): Rect =>
    columnRect(shown.indexOf(key), shown.length);

  const body: UiElement[] = [];

  if (cards.rank) {
    body.push(card('hm-rk', rectOf('rank'), rankCard(view.rank)));
  }

  if (cards.offer) {
    body.push(card('hm-loja', rectOf('offer'), offerCard(view)));
  }

  if (cards.wipe) {
    body.push(card('hm-wipe', rectOf('wipe'), wipeCard(view)));
  }

  if (cards.quest) {
    body.push(card('hm-quest', rectOf('quest'), questCard(view)));
  }

  return {
    id: options.screenId ?? HOME_SCREEN_ID,
    name: 'HOME',
    kind: 'page',
    elements: withPlayerName(
      [
      // ---- o banner, que é do admin ----
      //
      // O nome de quem abriu entra pelo `{jogador}` do texto DELE,
      // e não por um rótulo nosso ao lado. Ver `applyVariables`.
      card('hm-banner', topBar(BANNER_HEIGHT), [
        panel('hm-banner-acento', leftBar(3), C.rust),
        label('hm-titulo', `BEM-VINDO, ${PLAYER_VARIABLE}`, band(26, 34, 20), {
          size: 24,
          align: 'MiddleLeft',
          font: 'RobotoCondensed-Bold.ttf',
        }),
        label('hm-sub', 'Use o menu acima para navegar pelo servidor.', band(62, 22, 20), {
          size: 13,
          color: C.textMuted,
          align: 'MiddleLeft',
        }),
        ]),

        ...body,
      ],
      view.player,
    ),
  };
}

function rankCard(rank: HomeRankView): UiElement[] {
  return [
    ...cardTitle('hm-rk-titulo', 'TOP RANKING'),
    label('hm-rk-sub', rank.metric ?? '', band(40, 16), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
    }),
    panel('hm-rk-lista', fill(PAD, 62, PAD, FOOTER_ROOM), C.none, rankRows(rank.top, MAX_LINES)),
    label('hm-rk-voce', rank.self, footer(18, BUTTON_HEIGHT + PAD + 2), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
    }),
    cardButton('hm-rk-btn', 'VER RANKING', {
      id: 'hm-rk-a',
      kind: 'navigate',
      screenId: RANKING_SCREEN_ID,
    }),
  ];
}

/**
 * As linhas do pódio.
 *
 * A do jogador sai em âmbar: numa lista de três, ele precisa se
 * achar sem ler os nomes — e é a mesma cor que a página de ranking
 * usa para a linha dele.
 */
function rankRows(lines: readonly HomeRankLine[], room: number): UiElement[] {
  return lines.slice(0, room).map((line, index) => {
    const top = index * LIST_LINE;
    const tone = line.mine ? C.amber : C.text;

    return panel(
      `hmrk${String(index)}`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -(top + LIST_LINE) },
        offsetMax: { x: 0, y: -top },
      },
      C.none,
      [
        label(`hmrkp${String(index)}`, `${String(line.position)}º`, colRect(0, 26), {
          size: 12,
          color: line.mine ? C.amber : C.textMuted,
          align: 'MiddleLeft',
        }),
        label(`hmrkn${String(index)}`, line.name, colRect(26, 96), {
          size: 12,
          color: tone,
          align: 'MiddleLeft',
        }),
        label(`hmrkv${String(index)}`, line.value, fill(126, 0, 0, 0), {
          size: 12,
          color: tone,
          align: 'MiddleRight',
          font: 'RobotoCondensed-Bold.ttf',
        }),
      ],
    );
  });
}

/** Uma coluna de largura fixa dentro da linha. */
function colRect(left: number, width: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: left, y: 0 },
    offsetMax: { x: left + width, y: 0 },
  };
}

function offerCard(view: HomeView): UiElement[] {
  const offer = view.offer;

  return [
    ...cardTitle('hm-loja-titulo', 'NOVO NA LOJA'),

    // A etiqueta, no canto — o mesmo lugar em que a loja a desenha.
    panel(
      'hm-loja-tag',
      {
        anchorMin: { x: 1, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: -70, y: -30 },
        offsetMax: { x: -PAD, y: -12 },
      },
      offer?.badge === undefined || offer.badge === null ? C.none : BADGE_STYLE[offer.badge].bg,
      [
        label(
          'hm-loja-tagl',
          offer?.badge === undefined || offer.badge === null ? '' : BADGE_LABEL[offer.badge],
          fill(),
          {
            size: 10,
            color:
              offer?.badge === undefined || offer.badge === null
                ? C.textMuted
                : BADGE_STYLE[offer.badge].text,
            font: 'RobotoCondensed-Bold.ttf',
          },
        ),
      ],
    ),

    itemImage('hm-loja-icone', offer?.icon ?? PLACEHOLDER_ICON, {
      anchorMin: { x: 0.5, y: 1 },
      anchorMax: { x: 0.5, y: 1 },
      offsetMin: { x: -44, y: -136 },
      offsetMax: { x: 44, y: -48 },
    }),

    // Sem oferta, este rótulo é quem fala: o cartão vira a frase, e
    // ícone, preço e botão somem. Um botão COMPRAR sobre nada é
    // pior que um cartão que explica o vazio.
    label('hm-loja-nome', offer?.name ?? view.offerNote, band(142, 34), {
      size: 13,
      align: 'UpperCenter',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    label(
      'hm-loja-preco',
      offer === null ? '' : `${formatNumber(offer.price)} OZ`,
      band(178, 22),
      { size: 15, color: C.amber, align: 'MiddleCenter', font: 'RobotoCondensed-Bold.ttf' },
    ),
    label(
      'hm-loja-antes',
      offer?.oldPrice === undefined || offer.oldPrice === null
        ? ''
        : `de ${formatNumber(offer.oldPrice)} OZ`,
      band(200, 16),
      { size: 11, color: C.textMuted, align: 'MiddleCenter' },
    ),

    // ####  O ENDEREÇO DO MODAL NÃO PODE FICAR GRAVADO  ####
    //
    // `ozitem:<id>:1` tem `:`, e o `uiDocumentSchema` recusa `:` em
    // `screenId` de ação: o documento inteiro seria rejeitado na
    // gravação, e o menu sumiria do jogo. No esqueleto o botão
    // aponta para a LOJA, que é um id simples, e o agente troca a
    // ação ao preencher — ver `slotsOf`.
    cardButton(
      'hm-loja-btn',
      offer === null ? 'VER A LOJA' : 'COMPRAR',
      offer === null
        ? { id: 'hm-loja-a', kind: 'navigate', screenId: STORE_SCREEN_ID }
        : { id: 'hm-loja-a', kind: 'modal.open', screenId: itemScreenId(offer.offerId, 1) },
      offer !== null,
    ),
  ];
}

/**
 * O ícone do repouso.
 *
 * `itemId: 0` não resolve item nenhum no cliente, e é o que se quer
 * enquanto não há oferta: o elemento precisa EXISTIR no desenho
 * (senão o agente não tem onde derramar), e não deve mostrar um
 * item que ninguém pôs à venda.
 */
const PLACEHOLDER_ICON = { itemId: 0, skinId: '0' } as const;

const BADGE_STYLE: Record<OfferBadge, { readonly bg: string; readonly text: string }> = {
  promo: { bg: C.rust, text: C.white },
  novo: { bg: C.olive, text: C.bg },
  destaque: { bg: C.amber, text: C.bg },
};

const BADGE_LABEL: Record<OfferBadge, string> = {
  promo: 'PROMO',
  novo: 'NOVO',
  destaque: 'DESTAQUE',
};

function wipeCard(view: HomeView): UiElement[] {
  const wipe = view.wipe;

  return [
    ...cardTitle('hm-wipe-titulo', 'PRÓXIMO WIPE'),
    label('hm-wipe-data', wipe?.when ?? '', band(44, 24), {
      size: 15,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    label('hm-wipe-falta', wipe?.countdown ?? '', band(70, 20), {
      size: 13,
      color: C.amber,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    label('hm-wipe-nota', wipe?.note ?? view.wipeNote, fill(PAD, 96, PAD, FOOTER_ROOM), {
      size: 11,
      color: C.textMuted,
      align: 'UpperLeft',
    }),
    cardButton('hm-wipe-btn', 'VER CALENDÁRIO', {
      id: 'hm-wipe-a',
      kind: 'navigate',
      screenId: CALENDAR_SCREEN_ID,
    }),
  ];
}

function questCard(view: HomeView): UiElement[] {
  return [
    ...cardTitle('hm-quest-titulo', 'SUAS MISSÕES'),
    panel(
      'hm-quest-lista',
      fill(PAD, 44, PAD, FOOTER_ROOM),
      C.none,
      questRows(view, MAX_LINES),
    ),
    label('hm-quest-nota', view.questNote, footer(18, BUTTON_HEIGHT + PAD + 2), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
    }),
    cardButton('hm-quest-btn', 'VER MISSÕES', {
      id: 'hm-quest-a',
      kind: 'navigate',
      screenId: QUESTS_SCREEN_ID,
    }),
  ];
}

/**
 * As missões, uma por linha.
 *
 * A pronta sai em oliva — a cor de "deu certo" do painel —, que é o
 * que separa "falta jogar" de "falta clicar".
 */
function questRows(view: HomeView, room: number): UiElement[] {
  return view.quests.slice(0, room).map((quest, index) => {
    const top = index * LIST_LINE;

    return panel(
      `hmq${String(index)}`,
      {
        anchorMin: { x: 0, y: 1 },
        anchorMax: { x: 1, y: 1 },
        offsetMin: { x: 0, y: -(top + LIST_LINE) },
        offsetMax: { x: 0, y: -top },
      },
      C.none,
      [
        label(`hmqt${String(index)}`, quest.title, fill(0, 0, 62, 0), {
          size: 12,
          color: quest.done ? C.olive : C.text,
          align: 'MiddleLeft',
        }),
        label(`hmqp${String(index)}`, quest.done ? 'RESGATAR' : quest.progress, colRight(60), {
          size: 11,
          color: quest.done ? C.olive : C.textMuted,
          align: 'MiddleRight',
          font: 'RobotoCondensed-Bold.ttf',
        }),
      ],
    );
  });
}

/** Uma coluna de largura fixa colada à direita da linha. */
function colRight(width: number): Rect {
  return {
    anchorMin: { x: 1, y: 0 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: -width, y: 0 },
    offsetMax: { x: 0, y: 0 },
  };
}

// ------------------------------------------------------------
//  §4  O PREENCHIMENTO DO DESENHO GRAVADO
// ------------------------------------------------------------

/**
 * Este desenho serve de modelo?
 *
 * ####  A HOME DE ONTEM NÃO TEM OS SLOTS  ####
 *
 * O documento gravado antes desta frente traz `home-banner` e três
 * `home-cartao-N` mudos. Usá-lo como modelo daria uma home com os
 * cartões antigos e nenhum dado dentro, porque `fillTemplate`
 * preenche o que existe e não cria o que falta.
 *
 * A regra é estrutural, e não uma marca de versão: vale como modelo
 * o desenho que tem as DUAS caixas de lista — elas são o que
 * estrutura a tela, e quem as tem tem o resto. Quem não tem cai no
 * layout embutido, inteiro, que é o desta mesma função.
 */
function isHomeTemplate(template: UiScreen): boolean {
  const has = (suffix: string): boolean =>
    walk(template.elements).some((element) => element.id.endsWith(suffix));

  return has(HOME_SLOTS.rankList) && has(HOME_SLOTS.questList);
}

/** A árvore inteira, achatada. Só para procurar por id. */
function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

/**
 * O dado, derramado no desenho que o admin fez.
 *
 * O que é DELE: onde cada cartão fica, de que cor, e o que está
 * escrito nos títulos. O que é NOSSO: os textos que dependem do
 * jogador, as linhas das duas listas, o ícone da oferta — e TODAS
 * as ações, porque a de comprar carrega o `offerId`.
 */
function slotsOf(options: BuildHomeScreenOptions): Record<string, SlotValue> {
  const { view } = options;
  const offer = view.offer;
  const template = options.template;
  const cards = options.cards ?? ALL_CARDS;

  // No modelo, o cartão de uma seção escondida não pode ser
  // reposicionado — a posição é do admin —, então ele SOME inteiro.
  // Um buraco é honesto; um cartão prometendo a loja de um servidor
  // sem loja, não.
  const hiddenCards = Object.fromEntries(
    (Object.keys(CARD_ID) as (keyof HomeCards)[])
      .filter((key) => !cards[key])
      .map((key) => [CARD_ID[key], { hide: true } as SlotValue]),
  );

  const room = (suffix: string): number => {
    // Quantas linhas cabem na caixa que o admin desenhou. Sem esta
    // conta, mover a caixa para metade da altura faria o agente
    // mandar pelo RCON linhas que ninguém veria.
    if (template == null || options.viewport === undefined) {
      return MAX_LINES;
    }

    const box = measureSlot(template, suffix, options.viewport);

    return box === null ? MAX_LINES : Math.max(0, Math.min(MAX_LINES, Math.floor(box.height / LIST_LINE)));
  };

  return {
    // Os cartões escondidos vêm PRIMEIRO: `slotOf` casa pelo fim do
    // id e devolve a primeira chave que bater, e `hm-rk` precisa
    // ganhar de qualquer coisa que caia dentro dele.
    ...hiddenCards,

    [HOME_SLOTS.rankMetric]: { text: view.rank.metric ?? '' },
    [HOME_SLOTS.rankList]: { children: rankRows(view.rank.top, room(HOME_SLOTS.rankList)) },
    [HOME_SLOTS.rankSelf]: { text: view.rank.self },
    [HOME_SLOTS.rankButton]: {
      action: { id: 'hm-rk-a', kind: 'navigate', screenId: RANKING_SCREEN_ID },
    },

    // O ícone só é trocado quando há oferta; sem ela o elemento
    // inteiro some, junto do preço e do botão.
    [HOME_SLOTS.offerIcon]:
      offer === null ? { hide: true } : { item: offer.icon },
    [HOME_SLOTS.offerName]: { text: offer?.name ?? view.offerNote },
    [HOME_SLOTS.offerPrice]:
      offer === null ? { hide: true } : { text: `${formatNumber(offer.price)} OZ` },
    [HOME_SLOTS.offerOld]:
      offer?.oldPrice === undefined || offer.oldPrice === null
        ? { hide: true }
        : { text: `de ${formatNumber(offer.oldPrice)} OZ` },
    [HOME_SLOTS.offerBadge]:
      offer?.badge === undefined || offer.badge === null
        ? { hide: true }
        : { color: BADGE_STYLE[offer.badge].bg },
    [HOME_SLOTS.offerBadgeText]:
      offer?.badge === undefined || offer.badge === null
        ? {}
        : { text: BADGE_LABEL[offer.badge], color: BADGE_STYLE[offer.badge].text },
    [HOME_SLOTS.offerButton]:
      offer === null
        ? { text: 'VER A LOJA', action: { id: 'hm-loja-a', kind: 'navigate', screenId: STORE_SCREEN_ID } }
        : {
            text: 'COMPRAR',
            action: { id: 'hm-loja-a', kind: 'modal.open', screenId: itemScreenId(offer.offerId, 1) },
          },

    [HOME_SLOTS.wipeWhen]: { text: view.wipe?.when ?? '' },
    [HOME_SLOTS.wipeCountdown]: { text: view.wipe?.countdown ?? '' },
    [HOME_SLOTS.wipeNote]: { text: view.wipe?.note ?? view.wipeNote },
    [HOME_SLOTS.wipeButton]: {
      action: { id: 'hm-wipe-a', kind: 'navigate', screenId: CALENDAR_SCREEN_ID },
    },

    [HOME_SLOTS.questList]: { children: questRows(view, room(HOME_SLOTS.questList)) },
    [HOME_SLOTS.questNote]: { text: view.questNote },
    [HOME_SLOTS.questButton]: {
      action: { id: 'hm-quest-a', kind: 'navigate', screenId: QUESTS_SCREEN_ID },
    },
  };
}

// ------------------------------------------------------------
//  §5  O PROVEDOR
// ------------------------------------------------------------

export type HomeScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

export interface HomeScreenProviderOptions extends HomeScreenDeps {
  readonly now?: () => number;
}

/**
 * O provedor que o `generatedScreens` do index.ts chama.
 *
 * ####  ELE NUNCA DEIXA A HOME NO "CARREGANDO"  ####
 *
 * `null` só para o endereço que não é dele. Qualquer falha já virou,
 * lá dentro, a frase daquele cartão — e o pior caso, uma exceção
 * fora dos quatro blocos, vira a tela em repouso EMPACOTADA por
 * aqui, que é `volatile` e some no clique seguinte.
 *
 * Cair para a tela do documento seria pior que um erro: ela não é
 * volátil, e o plugin a guardaria no cache por até cinco minutos —
 * com o "Carregando…" do repouso congelado dentro.
 */
export function createHomeScreenProvider(
  options: HomeScreenProviderOptions,
): HomeScreenProvider {
  const now = options.now ?? ((): number => Date.now());

  return async (input) => {
    if (!isHomeScreenId(input.screenId)) {
      return null;
    }

    const template = findTemplate(input.document.screens, HOME_SCREEN_ID);
    const viewport: Size | undefined =
      template === null ? undefined : screenViewport(input.document, template);

    // O documento chega PODADO pelo `hidden` daquele servidor, e é
    // dele que sai quais cartões existem. Ver `cardsOf`.
    const cards = cardsOf(input.document);

    const pack = (view: HomeView): UiScreenBundle =>
      toGeneratedScreenBundle(
        input.document,
        buildHomeScreen({ view, screenId: input.screenId, template, viewport, cards }),
        // O SHELL conhece `tela-home`: sem isto, o destaque do botão
        // HOME sumiria justamente na tela de entrada.
        HOME_SCREEN_ID,
      );

    try {
      return pack(
        await readHomeView({
          deps: options,
          serverId: input.serverId,
          steamId: input.steamId,
          now: now(),
        }),
      );
    } catch (error) {
      options.logger?.error(
        { server: input.serverId, err: toError(error) },
        'não consegui montar a HOME; mando a tela de repouso, que não fica em cache',
      );

      return pack(emptyHomeView());
    }
  };
}

/**
 * A HOME em repouso, empacotada e VOLÁTIL.
 *
 * Existe pela mesma razão da do calendário: o provedor nasce numa
 * variável que o index.ts preenche tarde (ela depende da agenda de
 * wipes). Um pedido que chegasse antes disso serviria a tela
 * DESENHADA do documento, que o plugin guarda por minutos — e o
 * servidor inteiro ficaria com o "Carregando…" colado.
 */
export function buildEmptyHomeBundle(document: UiDocument, screenId: string): UiScreenBundle {
  return toGeneratedScreenBundle(
    document,
    buildHomeScreen({
      view: emptyHomeView(),
      screenId,
      template: findTemplate(document.screens, HOME_SCREEN_ID),
      cards: cardsOf(document),
    }),
    HOME_SCREEN_ID,
  );
}
