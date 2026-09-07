// ============================================================
//  ui-quests-screen.ts  -  a página de missões, montada do banco.
//
//  ####  ELA É UMA PÁGINA DO MENU, COMO AS OUTRAS  ####
//
//  MISSÕES fica ao lado de RANKING, EVENTOS e CALENDÁRIO no mesmo
//  documento, e `/quest` é um ATALHO que abre o menu já nela — ver
//  `shortcuts` em types/ui-document.ts.
//
//  Ela já teve um documento PRÓPRIO (`menu-quests`), que era o
//  menu inteiro clonado com outro comando. O dono viu o resultado
//  na tela de Interface — dois "Menu" de onze telas cada — e
//  mandou apagar. Estava certo: o servidor recebia duas cópias do
//  mesmo shell pelo RCON e todo ajuste de estilo tinha dois
//  lugares para acontecer.
//
//  ------------------------------------------------------------
//  ####  NADA GUARDA ESTADO: TUDO É ENDEREÇO  ####
//
//  A regra de ouro do projeto (ui-ranking-screen.ts:37-51). Trocar
//  de lista, virar página e abrir o detalhe não são eventos, são
//  ENDEREÇOS:
//
//      tela-missoes[:<lista>[:<página>]]
//      tela-missoes:det:<pq>       o detalhe de uma tentativa
//      tela-missoes:info:<questId> o detalhe de uma oferta
//      tela-missoes:npc:<npcId>[:<página>]
//
//  A alternativa seria o plugin lembrar em que lista cada jogador
//  está. Mais código nos dois lados, para um valor que já cabe no
//  id da tela.
//
//  ####  E O ID DA TELA RESPONDIDA TEM DE SER O ID PEDIDO  ####
//
//  ISTO CUSTOU UMA SESSÃO INTEIRA. O plugin guarda o endereço que
//  pediu em `session.PendingScreenId` e, ao receber a resposta,
//  faz:
//
//      if (session.PendingScreenId != screen.Id) return;
//
//  — porque o jogador pode ter navegado para outro lugar enquanto
//  a tela vinha. Enquanto esta função carimbava `tela-missoes` em
//  TODAS as respostas, o clique em DISPONÍVEIS pedia
//  `tela-missoes:disponiveis`, recebia `tela-missoes`, e o
//  DESCARTAVA em silêncio. Nenhum botão desta tela funcionava, sem
//  erro em lugar nenhum. O ranking escapou por acidente: ele já
//  devolvia `options.screenId`.
//
//  ------------------------------------------------------------
//  ####  ELA NUNCA É GUARDADA EM CACHE  ####
//
//  `volatile: true`, que o `toGeneratedScreenBundle` carimba. A
//  tela diz "você tem 3.240 de 5.000"; em cache, ela diria isso
//  para o servidor inteiro e por até cinco minutos.
//
//  ------------------------------------------------------------
//  ####  O RECORTE ACONTECE ANTES DO DESENHO  ####
//
//  A lição mais cara do projeto (ui-calendar-screen.ts:24-36): o
//  que o jogador não pode ver NÃO ATRAVESSA O RCON. Por isso são
//  duas funções, e não uma:
//
//    readQuestsView()    pergunta ao serviço e devolve SÓ a página
//                        pedida, já sem SteamID de ninguém;
//    buildQuestsScreen() desenha o que recebeu, e nada além.
//
//  É também o que protege o detalhe: o endereço `det:8412` vem do
//  CLIENTE, e um número forjado apontaria para a tentativa de
//  outra pessoa. A leitura nunca busca pelo id — ela procura o id
//  DENTRO da lista de quem pediu. Quem não é dono não acha.
//
//  ####  SEIS POR PÁGINA, E O TESTE DE TAMANHO MANDA  ####
//
//  O teto do comando é 50 000 bytes de base64
//  (types/ui-transport.ts:534). Uma tela estourada NÃO DÁ ERRO no
//  jogo: ela simplesmente não abre. Ver o teste do pior caso em
//  `core/test/quests-screen.test.ts`.
//
//  Seis, e não dez como o ranking, porque cada linha aqui é um
//  bloco: título, frase do objetivo, barra e dois botões. O
//  ranking cabe dez porque cada linha dele é uma linha mesmo.
//
//  A conta: o slot tem 495 px, o título come os 40 do topo e o
//  controle de página, 28 do rodapé. Sobram 427 para blocos de 64
//  — seis dão 378, e o sétimo (442) não entraria.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §13.
// ============================================================

import type { Logger } from '../logger.js';
import type { QuestOffer, QuestProgressView, QuestsService } from '../quests/service.js';
import type { QuestObjective, QuestReward } from '../types/quests.js';
import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import { toError } from '../util.js';

import {
  button,
  C,
  clamp,
  fill,
  itemImage,
  label,
  panel,
  rowsPager,
  type Rect,
} from './ui-widgets.js';

/**
 * O id da tela.
 *
 * FIXO, e não sorteado: é por ele que o agente reconhece a tela
 * cujo conteúdo ele mesmo monta.
 *
 * ####  E ELE SEGUE O PADRÃO DAS OUTRAS PÁGINAS  ####
 *
 * `tela-missoes`, ao lado de `tela-ranking`, `tela-eventos` e
 * `tela-calendario`. Já foi `tela-quest`, e o nome inglês no meio
 * de sete portugueses era o tipo de detalhe que faz alguém
 * procurar a página errada na tela de Interface.
 */
export const QUESTS_SCREEN_ID = 'tela-missoes';

/**
 * A chave do PNG da moeda, entregue ao servidor pelo agente.
 *
 * Repetida aqui, e não importada de `ui-store-screens`: aquele
 * módulo carrega a loja inteira e o modelo dos modais dela, e uma
 * string de seis letras não paga esse acoplamento. Se ela mudar,
 * muda em `game/ui-images.ts` — que é quem lê a pasta.
 */
const COIN_IMAGE_KEY = 'ozcoin';

/** Quantas quests cabem numa página. Ver o cabeçalho. */
export const QUESTS_PAGE_SIZE = 6;

/**
 * O teto da página que um endereço pode pedir.
 *
 * O id vem do plugin, e um `tela-missoes:ativas:99999999` viraria um
 * índice absurdo. O teto o apara antes; a página que não existe é
 * aparada de novo contra o total real.
 */
const MAX_PAGE = 9_999;

/** A altura de um bloco de quest, e o respiro entre dois. */
const CARD = 58;
const CARD_GAP = 6;

// ####  A COLUNA É A DO RANKING, MEDIDA POR MEDIDA  ####
//
// Decisão do dono em 06/09/2026, duas vezes: primeiro "as três
// listas viram uma coluna à esquerda", depois "usa a sidebar do
// ranking, que é design bonito".
//
// Então estes números NÃO são escolhas novas: são os de
// ui-ranking-screen.ts (`Y` e `COLUMN`), copiados. Ter as duas
// telas com colunas parecidas mas não iguais é pior que ter uma
// só — o olho nota a diferença de 4 px e ninguém sabe qual é a
// certa.
//
// O desenho que vem junto:
//
//   - a coluna é um painel PINTADO (`surface-2`), e é ele que faz
//     a divisória: um elemento a menos que uma régua de 1 px;
//   - o item da vez é mais ESCURO que a coluna, não mais claro —
//     sobre fundo escuro, o buraco lê como "aberto";
//   - a barra vermelha de 3 px à esquerda dele diz qual é à
//     distância de um olhar;
//   - o hover ESCURECE, na direção do item aberto: passar o mouse
//     prenuncia o que o clique faz.
const Y = {
  /** A faixa do título. */
  title: 30,
  /** Onde a coluna e o conteúdo começam. */
  body: 40,
} as const;

const COLUMN = {
  width: 210,
  /** O respiro entre a coluna e o conteúdo. */
  gap: 16,
  /** A altura de um item. */
  item: 34,
  /** O recuo do texto, dentro do item. */
  textLeft: 12,
} as const;

/**
 * A faixa do número, à direita do item.
 *
 * Ela é SUBTRAÍDA do botão: um rótulo por cima dele engole o
 * clique. Ver `badge`.
 */
const BADGE = 34;

const CONTENT_LEFT = COLUMN.width + COLUMN.gap;

// ------------------------------------------------------------
//  §1  O ENDEREÇO
// ------------------------------------------------------------

export type QuestsTab = 'ativas' | 'disponiveis' | 'feitas';

/**
 * O que o detalhe está mostrando.
 *
 * `live` é uma TENTATIVA — ela tem contador, e pode ser
 * abandonada. `offer` é uma quest do catálogo que ele ainda não
 * pegou: ela tem o que pede e o que dá, e nada de progresso.
 */
export type QuestDetailKind = 'live' | 'offer';

export interface QuestsScreenTarget {
  readonly tab: QuestsTab;
  readonly page: number;
  /** O detalhe pedido. `null` = a lista. */
  readonly detail: { readonly kind: QuestDetailKind; readonly id: string } | null;
  /** A tela daquele NPC. `null` = o menu. */
  readonly npcId: string | null;
}

const TABS: readonly QuestsTab[] = ['ativas', 'disponiveis', 'feitas'];

/** O que cada lista se chama na barra lateral. */
const TAB_LABELS: Readonly<Record<QuestsTab, string>> = {
  ativas: 'EM ANDAMENTO',
  disponiveis: 'DISPONÍVEIS',
  feitas: 'RESGATAR',
};

/**
 * Lê o id da tela. `null` = não é uma tela de quest.
 *
 *     tela-missoes                  as ativas, primeira página
 *     tela-missoes:disponiveis      a lista das disponíveis
 *     tela-missoes:disponiveis:2    ...na terceira página
 *     tela-missoes:det:8412         o detalhe de uma tentativa
 *     tela-missoes:info:minerador   o detalhe de uma oferta
 *     tela-missoes:npc:velho        as quests daquele NPC
 *
 * ####  TUDO O QUE VEM TORTO É APARADO, NUNCA RECUSADO  ####
 *
 * O pedido veio do plugin e o jogador está com um aviso de
 * carregando na tela. Uma lista desconhecida vira `ativas`; uma
 * página que não é número vira zero. Recusar deixaria alguém
 * girando até o timeout.
 */
export function parseQuestsScreenId(screenId: string): QuestsScreenTarget | null {
  const parts = screenId.split(':');

  if (parts[0] !== QUESTS_SCREEN_ID) {
    return null;
  }

  const rest = parts.slice(1);
  const empty: QuestsScreenTarget = { tab: 'ativas', page: 0, detail: null, npcId: null };

  if (rest.length === 0) {
    return empty;
  }

  if (rest[0] === 'det' || rest[0] === 'info') {
    // O id pode ter `:` dentro? Não pode — a régua do slug o
    // proíbe (types/quests.ts) —, mas juntar o resto é o que
    // mantém isto correto se a régua um dia afrouxar.
    const id = rest.slice(1).join(':');
    const kind: QuestDetailKind = rest[0] === 'det' ? 'live' : 'offer';

    return id === '' ? empty : { ...empty, detail: { kind, id } };
  }

  if (rest[0] === 'npc') {
    const page = Number(rest[rest.length - 1]);
    const hasPage = rest.length > 2 && Number.isInteger(page);
    const npcId = (hasPage ? rest.slice(1, -1) : rest.slice(1)).join(':');

    return npcId === ''
      ? empty
      : { ...empty, npcId, page: hasPage ? clamp(page, 0, MAX_PAGE) : 0 };
  }

  const tab = TABS.find((item) => item === rest[0]) ?? 'ativas';
  const page = Number(rest[1]);

  return { ...empty, tab, page: Number.isInteger(page) ? clamp(page, 0, MAX_PAGE) : 0 };
}

/** O endereço de uma lista, para os botões. */
export function questsScreenId(target: {
  readonly tab?: QuestsTab;
  readonly page?: number;
  readonly npcId?: string | null;
}): string {
  if (target.npcId !== undefined && target.npcId !== null) {
    const page = target.page ?? 0;

    return page === 0
      ? `${QUESTS_SCREEN_ID}:npc:${target.npcId}`
      : `${QUESTS_SCREEN_ID}:npc:${target.npcId}:${String(page)}`;
  }

  const tab = target.tab ?? 'ativas';
  const page = target.page ?? 0;

  return page === 0
    ? `${QUESTS_SCREEN_ID}:${tab}`
    : `${QUESTS_SCREEN_ID}:${tab}:${String(page)}`;
}

/** O endereço do detalhe, que é um MODAL por cima da lista. */
export function questDetailScreenId(kind: QuestDetailKind, id: string): string {
  return `${QUESTS_SCREEN_ID}:${kind === 'live' ? 'det' : 'info'}:${id}`;
}

// ------------------------------------------------------------
//  §2  O QUE A TELA MOSTRA
// ------------------------------------------------------------

/** Uma linha da lista, já recortada e sem SteamID de ninguém. */
export interface QuestCard {
  /** `quest:accept:<id>` ou `quest:claim:<pq>`. Ver §13.4 do plano. */
  readonly actionId: string | null;
  readonly actionLabel: string | null;
  readonly title: string;
  /** A frase do primeiro objetivo, ou o motivo do bloqueio. */
  readonly line: string;
  /** 0 a 1. `null` = sem barra (uma quest disponível não tem). */
  readonly progress: number | null;
  /** Para onde o botão DETALHES abre o modal. */
  readonly detailScreenId: string | null;
  /** O que ela dá, em uma linha. */
  readonly reward: string;
}

/** Um objetivo, na tela de detalhe. */
export interface QuestDetailObjective {
  readonly text: string;
  /** `null` numa oferta: ela ainda não tem contador. */
  readonly have: number | null;
  readonly need: number;
  readonly done: boolean;
}

/**
 * Uma recompensa na tela de detalhe.
 *
 * O ícone é o que o dono pediu em 06/09/2026: "o certo é mostrar o
 * ícone do item quando é item, e o do OZCoin quando é moeda".
 *
 * `null` para kit, VIP e pontos: nenhum dos três é um item do jogo,
 * e não há imagem a mostrar. Pontos ganham o NOME DO RANKING no
 * lugar — "2 pontos em Bleik Store" diz o que `trophy.bleik` não
 * dizia.
 */
export interface QuestRewardLine {
  readonly text: string;
  readonly icon:
    | { readonly kind: 'item'; readonly itemId: number; readonly skinId: string }
    | { readonly kind: 'coin' }
    | null;
}

/** O modal de uma quest. */
export interface QuestDetail {
  readonly title: string;
  readonly description: string;
  readonly objectives: readonly QuestDetailObjective[];
  /** Uma linha por recompensa, com o ícone quando houver. */
  readonly rewards: readonly QuestRewardLine[];
  /** O motivo do bloqueio, ou o aviso de que está pronta. */
  readonly note: string | null;
  /** `quest:accept:<id>` ou `quest:claim:<pq>`. */
  readonly actionId: string | null;
  readonly actionLabel: string | null;
  /** `quest:cancel:<pq>`. Só existe numa tentativa em andamento. */
  readonly abandonId: string | null;
}

/** Quantas quests há em cada lista, para a barra lateral. */
export interface QuestCounts {
  readonly ativas: number;
  readonly disponiveis: number;
  readonly feitas: number;
}

export interface QuestsView {
  readonly tab: QuestsTab;
  readonly page: number;
  readonly pages: number;
  readonly cards: readonly QuestCard[];
  /** O nome do NPC, quando a tela é dele. */
  readonly npcName: string | null;
  readonly npcId: string | null;
  /** A frase de quando não há nada. */
  readonly emptyMessage: string;
  /** O aviso de que a leitura falhou. Ver o provedor. */
  readonly trouble: string | null;
  /** `null` = não foram contadas (a tela em repouso). */
  readonly counts: QuestCounts | null;
  /** Preenchido = a tela É o modal, e a lista nem é montada. */
  readonly detail: QuestDetail | null;
}

export function emptyQuestsView(): QuestsView {
  return {
    tab: 'ativas',
    page: 0,
    pages: 1,
    cards: [],
    npcName: null,
    npcId: null,
    emptyMessage: 'Nenhuma missão por aqui ainda.',
    trouble: null,
    counts: null,
    detail: null,
  };
}

// ------------------------------------------------------------
//  §3  A LEITURA
// ------------------------------------------------------------

/**
 * O que a tela precisa saber sobre o mundo, fora das missoes.
 *
 * ####  O CATALOGO NAO MORA NO CADASTRO DA MISSAO  ####
 *
 * A recompensa guarda `metal.refined` e `trophy.bleik` — o que o
 * admin digitou. Quem sabe que aquilo se chama "High Quality Metal"
 * e desenha com que icone e o catalogo do JOGO, que muda a cada
 * update do Rust; e quem sabe que `trophy.bleik` se chama "Bleik
 * Store" e o catalogo de rankings, que o admin edita.
 *
 * Gravar essas duas coisas no cadastro deixaria o nome velho na
 * tela para sempre.
 */
export interface QuestsCatalog {
  /** O item do jogo, pelo shortname. `null` = nao existe (mais). */
  readonly itemOf?: (shortname: string) => {
    readonly itemId: number;
    readonly displayName: string;
  } | null;
  /** O nome do ranking daquela metrica. `null` = nao esta no catalogo. */
  readonly rankingLabelOf?: (metric: string) => string | null;
}

export interface QuestsScreenReader {
  offersFor(input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly npcId?: string;
  }): Promise<readonly QuestOffer[]>;
  liveFor(input: {
    readonly serverId: string;
    readonly steamId: string;
  }): readonly QuestProgressView[];
  /** A frase de um objetivo, montada com o nome bonito do item. */
  describeObjective(objective: QuestObjective): string;
}

/**
 * Lê o banco e devolve SÓ a página pedida.
 *
 * ####  A PAGINAÇÃO É EM MEMÓRIA AQUI, E ISSO É DELIBERADO  ####
 *
 * O ranking pagina no SQL porque a lista dele tem 900 jogadores. A
 * lista daqui é do que UM jogador pode fazer: o teto de quests
 * ativas costuma ser menos de dez, e o catálogo de disponíveis é o
 * número de quests do servidor — dezenas, não milhares. Uma
 * consulta paginada custaria mais complexidade do que economiza.
 */
export async function readQuestsView(input: {
  readonly reader: QuestsScreenReader;
  readonly serverId: string;
  readonly steamId: string | undefined;
  readonly target: QuestsScreenTarget;
  /** O nome do NPC, quando a tela é dele. */
  readonly npcName?: string | null;
  /** O nome bonito e o ícone das recompensas. Ver `QuestsCatalog`. */
  readonly catalog?: QuestsCatalog;
}): Promise<QuestsView> {
  const base = emptyQuestsView();

  if (input.steamId === undefined) {
    // ####  SEM SABER QUEM PEDIU, NÃO HÁ O QUE MOSTRAR  ####
    //
    // Toda linha desta tela é sobre ELE. Mostrar o catálogo sem o
    // progresso seria pior que a frase: pareceria que ele não tem
    // nenhuma quest.
    return { ...base, trouble: 'Não consegui identificar você. Feche e abra o menu de novo.' };
  }

  const { reader, serverId, steamId } = input;
  const catalog = input.catalog ?? {};
  const npcId = input.target.npcId;

  // ------------------------------------------------------------
  //  O DETALHE — a tela vira um MODAL, e a lista nem é montada
  // ------------------------------------------------------------
  if (input.target.detail !== null) {
    return {
      ...base,
      detail: await readDetail({ reader, serverId, steamId, catalog, ...input.target.detail }),
    };
  }

  // A tela do NPC só tem uma lista: o que ELE oferece. As listas de
  // ativas e feitas são do menu — o NPC não é um lugar para
  // conferir progresso, e por isso ela também não tem barra
  // lateral.
  if (npcId !== null) {
    const offers = await reader.offersFor({ serverId, steamId, npcId });

    return {
      ...base,
      ...pageOf(offers.map((offer) => offerCard(offer, catalog)), input.target.page),
      tab: 'disponiveis',
      npcId,
      npcName: input.npcName ?? null,
      emptyMessage: 'Este NPC não tem missões para você agora.',
    };
  }

  // ####  AS TRÊS CONTAGENS SAEM DE DUAS LEITURAS  ####
  //
  // `liveFor` é síncrono e traz ativas e concluídas de uma vez;
  // `offersFor` traz o catálogo elegível. As duas já eram feitas —
  // só que uma de cada vez, conforme a lista aberta. Fazer as duas
  // sempre é o que permite a barra lateral dizer QUANTAS há em
  // cada uma sem o jogador ter de entrar para descobrir.
  const live = reader.liveFor({ serverId, steamId });
  const offers = await reader.offersFor({ serverId, steamId });

  const active = live.filter((item) => item.status === 'active');
  // "Feitas" é o que está pronto para resgatar. O histórico inteiro
  // mora no site: uma lista de trinta diárias no CUI estouraria o
  // frame e ninguém a leria no jogo.
  const done = live.filter((item) => item.status === 'completed');

  const counts: QuestCounts = {
    ativas: active.length,
    disponiveis: offers.length,
    feitas: done.length,
  };

  if (input.target.tab === 'disponiveis') {
    return {
      ...base,
      ...pageOf(offers.map((offer) => offerCard(offer, catalog)), input.target.page),
      tab: 'disponiveis',
      counts,
      emptyMessage: 'Nenhuma missão nova por enquanto. Volte depois.',
    };
  }

  if (input.target.tab === 'feitas') {
    return {
      ...base,
      ...pageOf(done.map((item) => progressCard(item, catalog)), input.target.page),
      tab: 'feitas',
      counts,
      emptyMessage: 'Nada para resgatar agora.',
    };
  }

  return {
    ...base,
    ...pageOf(active.map((item) => progressCard(item, catalog)), input.target.page),
    tab: 'ativas',
    counts,
    emptyMessage: 'Você não está fazendo nenhuma missão. Veja as disponíveis.',
  };
}

/**
 * O conteúdo do modal.
 *
 * ####  O ID VEM DO CLIENTE, ENTÃO NÃO SE BUSCA POR ELE  ####
 *
 * `tela-missoes:det:8412` chega pelo `origemz.ui.act`, e qualquer um
 * pode digitar aquele comando com o número que quiser. Buscar a
 * tentativa 8412 no banco entregaria a missão de outra pessoa.
 *
 * Por isso a procura é DENTRO da lista de quem pediu: o que não é
 * dele não está lá, e o modal diz que a missão não existe mais —
 * que é, do ponto de vista dele, a verdade.
 */
async function readDetail(input: {
  readonly reader: QuestsScreenReader;
  readonly serverId: string;
  readonly steamId: string;
  readonly kind: QuestDetailKind;
  readonly id: string;
  readonly catalog: QuestsCatalog;
}): Promise<QuestDetail> {
  const gone: QuestDetail = {
    title: 'Missão indisponível',
    description: 'Ela não está mais na sua lista. Feche e abra o menu de novo.',
    objectives: [],
    rewards: [],
    note: null,
    actionId: null,
    actionLabel: null,
    abandonId: null,
  };

  if (input.kind === 'offer') {
    const offers = await input.reader.offersFor({
      serverId: input.serverId,
      steamId: input.steamId,
    });
    const offer = offers.find((item) => item.quest.id === input.id);

    if (offer === undefined) {
      return gone;
    }

    const blocked = offer.block !== null;

    return {
      title: offer.quest.title,
      description: offer.quest.description ?? '',
      objectives: offer.quest.objectives.map((objective) => ({
        text: input.reader.describeObjective(objective),
        have: null,
        need: objective.amount,
        done: false,
      })),
      rewards: offer.quest.rewards.map((reward) => rewardLineOf(reward, input.catalog)),
      note: offer.block?.reason ?? null,
      actionId: blocked ? null : `quest:accept:${offer.quest.id}`,
      actionLabel: blocked ? null : 'ACEITAR',
      abandonId: null,
    };
  }

  const live = input.reader.liveFor({ serverId: input.serverId, steamId: input.steamId });
  const attempt = live.find((item) => String(item.playerQuestId) === input.id);

  if (attempt === undefined) {
    return gone;
  }

  return {
    title: attempt.title,
    description: '',
    objectives: attempt.objectives.map((objective) => ({
      text: objective.label,
      have: objective.have,
      need: objective.need,
      done: objective.done,
    })),
    rewards: attempt.rewards.map((reward) => rewardLineOf(reward, input.catalog)),
    note: attempt.complete ? 'Concluída. Toque em RESGATAR para receber.' : null,
    actionId: attempt.complete ? `quest:claim:${String(attempt.playerQuestId)}` : null,
    actionLabel: attempt.complete ? 'RESGATAR' : null,
    // ####  ABANDONAR SÓ EXISTE ENQUANTO ELA ESTÁ EM ANDAMENTO  ####
    //
    // Abandonar uma concluída seria jogar fora o prêmio já ganho
    // com um clique — e o botão fica ao lado do RESGATAR.
    abandonId: attempt.complete ? null : `quest:cancel:${String(attempt.playerQuestId)}`,
  };
}

function pageOf(
  cards: readonly QuestCard[],
  page: number,
): Pick<QuestsView, 'cards' | 'page' | 'pages'> {
  const pages = Math.max(1, Math.ceil(cards.length / QUESTS_PAGE_SIZE));
  // O endereço pode apontar para uma página que não existe mais —
  // ele resgatou a última quest da página 2. A última é a resposta
  // certa; uma tela vazia parece defeito.
  const current = clamp(page, 0, pages - 1);

  return {
    cards: cards.slice(current * QUESTS_PAGE_SIZE, current * QUESTS_PAGE_SIZE + QUESTS_PAGE_SIZE),
    page: current,
    pages,
  };
}

function offerCard(offer: QuestOffer, catalog: QuestsCatalog): QuestCard {
  const blocked = offer.block !== null;

  return {
    // ####  O BOTÃO REUSA `store.buy`  ####
    //
    // `offerId` prefixado, e o `fallback` do `onBuy` no index.ts
    // reconhece o prefixo. Zero mudança no `uiDocumentSchema` e
    // zero no plugin — é o mesmo caminho que os kits percorrem.
    actionId: blocked ? null : `quest:accept:${offer.quest.id}`,
    actionLabel: blocked ? null : 'ACEITAR',
    title: offer.quest.title,
    // O motivo do bloqueio no lugar da descrição: é a informação
    // que ele foi buscar. "Volta em 4h" é mais útil que o texto de
    // sabor da quest.
    line: offer.block?.reason ?? offer.quest.description ?? 'Toque em ACEITAR para começar.',
    progress: null,
    detailScreenId: questDetailScreenId('offer', offer.quest.id),
    reward: rewardLine(offer.quest.rewards, catalog),
  };
}

function progressCard(view: QuestProgressView, catalog: QuestsCatalog): QuestCard {
  const done = view.complete;
  const total = view.objectives.reduce((sum, item) => sum + item.need, 0);
  const have = view.objectives.reduce((sum, item) => sum + Math.min(item.have, item.need), 0);

  return {
    actionId: done ? `quest:claim:${String(view.playerQuestId)}` : null,
    actionLabel: done ? 'RESGATAR' : null,
    title: view.title,
    line: lineOf(view),
    // A barra soma TODOS os objetivos, e não só o primeiro: numa
    // quest de dois passos, mostrar só o primeiro faria a barra
    // encher pela metade e parar.
    progress: total === 0 ? 0 : have / total,
    detailScreenId: questDetailScreenId('live', String(view.playerQuestId)),
    reward: rewardLine(view.rewards, catalog),
  };
}

/**
 * A linha de baixo de uma quest em andamento.
 *
 * Um objetivo: a frase dele com o contador. Vários: o que falta,
 * porque listar três frases não cabe num bloco de 58 px — e é
 * justamente para isso que existe o modal de detalhe.
 */
function lineOf(view: QuestProgressView): string {
  const pending = view.objectives.filter((item) => !item.done);

  if (view.complete) {
    return 'Concluída — toque em RESGATAR.';
  }

  const first = pending[0];

  if (first === undefined) {
    return 'Concluída.';
  }

  const counter = `${first.have.toLocaleString('pt-BR')} / ${first.need.toLocaleString('pt-BR')}`;

  return pending.length === 1
    ? `${first.label} — ${counter}`
    : `${first.label} — ${counter}  (+${String(pending.length - 1)})`;
}

/**
 * Uma recompensa, com o nome que quem joga entende.
 *
 * ####  ELA É LIDA POR QUEM JOGA, E NÃO POR QUEM CONFIGURA  ####
 *
 * O cadastro guarda `metal.refined` e `trophy.bleik`. Nenhum dos
 * dois é o nome de nada para quem está no jogo: o primeiro é a
 * chave do item no Rust, o segundo é a métrica de um ranking. Os
 * dois viram nome de gente aqui, com o catálogo — e voltam a ser a
 * chave crua quando o catálogo não conhece, que é melhor que um
 * espaço em branco.
 *
 * "1 pts" também esteve na tela até o dono apontar. O plural sai da
 * quantidade e a palavra é inteira.
 */
function rewardLineOf(reward: QuestReward, catalog: QuestsCatalog): QuestRewardLine {
  const plural = (amount: number, one: string, many: string): string =>
    `${amount.toLocaleString('pt-BR')} ${amount === 1 ? one : many}`;

  switch (reward.kind) {
    case 'coins':
      return {
        // ####  A MOEDA TEM NOME, E ELE NAO E "MOEDA"  ####
        //
        // "750 moedas" podia ser qualquer coisa; a moeda da rede se
        // chama OZCoin, e e assim que ela aparece no cabecalho do
        // menu, na loja e no site. Nome proprio nao pluraliza — sao
        // "750 OZCoin", como "750 reais" nao vira "750 realis".
        //
        // `null` = o valor sai de uma conta que so o resgate conhece
        // (a entrega por metro). Prometer um numero seria mentir.
        text:
          reward.amount === null
            ? 'OZCoin'
            : `${reward.amount.toLocaleString('pt-BR')} OZCoin`,
        icon: { kind: 'coin' },
      };

    case 'item': {
      const item = catalog.itemOf?.(reward.shortname) ?? null;

      return {
        text: `${String(reward.amount)}x ${item?.displayName ?? reward.shortname}`,
        // O ícone é resolvido pelo CLIENTE, a partir do `itemId` — o
        // agente não manda imagem nenhuma. Ver `itemImage`.
        icon:
          item === null
            ? null
            : { kind: 'item', itemId: item.itemId, skinId: reward.skinId },
      };
    }

    case 'kit':
      return { text: `kit ${reward.slug}`, icon: null };

    case 'points': {
      // ####  "2 PONTOS" SOZINHO NAO DIZ NADA  ####
      //
      // Foi a pergunta do dono, olhando a tela: "2 pontos de que?".
      // Sem o nome do ranking a linha promete um numero e esconde
      // de onde ele sai — e quando a metrica NAO esta no catalogo,
      // esconde tambem que ela nao existe.
      //
      // A metrica crua no lugar do nome e feia de proposito: ela e
      // o sinal de que aquele ranking precisa ser criado.
      const label = catalog.rankingLabelOf?.(reward.metric) ?? reward.metric;

      return { text: `${plural(reward.amount, 'ponto', 'pontos')} em ${label}`, icon: null };
    }

    case 'vip':
      return { text: `VIP ${reward.tier}`, icon: null };
  }
}

/**
 * O que a quest dá, em uma linha curta — a do card.
 *
 * Sem ícone, de propósito: a faixa tem 12 px e divide o bloco com a
 * barra de progresso. E com duas recompensas, um ícone só diria
 * respeito a qual? Os ícones ficam no detalhe, onde há uma linha
 * para cada.
 */
function rewardLine(rewards: readonly QuestReward[], catalog: QuestsCatalog): string {
  if (rewards.length === 0) {
    return '';
  }

  const parts = rewards.map((reward) => rewardLineOf(reward, catalog).text);

  // Duas, e o resto vira "+N": a linha tem 260 px e o nome de um
  // item já come metade dela.
  return parts.length <= 2
    ? parts.join(' + ')
    : `${parts.slice(0, 2).join(' + ')} +${String(parts.length - 2)}`;
}

// ------------------------------------------------------------
//  §4  O DESENHO
// ------------------------------------------------------------

export function buildQuestsScreen(input: {
  readonly view: QuestsView;
  readonly screenId: string;
  /**
   * A barra lateral entra?
   *
   * ####  A TELA GRAVADA NÃO PODE TÊ-LA  ####
   *
   * O `uiDocumentSchema` NÃO aceita `:` em `screenId` de ação
   * (types/ui-document.ts), e o item da barra navega para
   * `tela-missoes:disponiveis`. Um documento com ela seria RECUSADO
   * NA GRAVAÇÃO, e o menu sumiria do jogo.
   *
   * A tela que o AGENTE monta a cada clique não passa pelo schema —
   * é por isso que ela pode tê-la. É a mesma pegadinha que o
   * `buildMainMenu` documenta sobre a tela de ranking em repouso,
   * e aqui ela foi pega por teste.
   */
  readonly withNav?: boolean;
}): UiScreen {
  const { view } = input;

  // ####  O DETALHE É UM MODAL, E NÃO UMA PÁGINA  ####
  //
  // `kind: 'modal'` é o que faz o plugin desenhá-lo no slot de
  // modal, POR CIMA da lista, sem destruí-la. Fechar volta para a
  // lista sem ir à rede — ver `Draw` em OrigemZUI.cs.
  if (view.detail !== null) {
    return {
      id: input.screenId,
      name: 'Missão',
      kind: 'modal',
      elements: detailElements(view.detail),
    };
  }

  const elements: UiElement[] = [];
  // A tela do NPC não tem barra lateral: ela é uma lista só. Pôr a
  // barra ali levaria o jogador para o menu geral por dentro da
  // tela do NPC, e ele não teria como voltar.
  const nav = (input.withNav ?? true) && view.npcId === null;
  const left = nav ? CONTENT_LEFT : 0;

  if (nav) {
    elements.push(
      ...sidebar(view),
      // O título do CONTEÚDO é o nome da lista aberta, na mesma
      // faixa do título da coluna. É o desenho do ranking: à
      // esquerda o nome da tela, à direita o do que está aberto.
      label('qct', TAB_LABELS[view.tab], rectOf(left, 0, Y.title), {
        size: 20,
        color: C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
    );
  } else {
    // Sem a coluna, o título volta para o alto do conteúdo — é o
    // que a tela do NPC e a tela em repouso mostram.
    elements.push(
      label(
        'qh',
        view.npcName === null ? 'MISSÕES' : view.npcName.toUpperCase(),
        rectOf(left, 0, 26),
        { size: 20, color: C.text, align: 'MiddleLeft', font: 'RobotoCondensed-Bold.ttf' },
      ),
    );
  }

  const top = nav ? Y.body : 34;

  if (view.trouble !== null) {
    elements.push(
      label('qt', view.trouble, rectOf(left, top, top + 40), {
        size: 13,
        color: C.textMuted,
        align: 'MiddleCenter',
      }),
    );

    return screenOf(input.screenId, elements);
  }

  if (view.cards.length === 0) {
    elements.push(
      label('qe', view.emptyMessage, rectOf(left, top, top + 40), {
        size: 13,
        color: C.textMuted,
        align: 'MiddleCenter',
      }),
    );

    return screenOf(input.screenId, elements);
  }

  view.cards.forEach((card, index) => {
    elements.push(...cardElements(card, `q${String(index)}`, left, top + index * (CARD + CARD_GAP)));
  });

  if (view.pages > 1) {
    // ####  O CONTROLE DE PÁGINA FICA NO RODAPÉ  ####
    //
    // Ancorado embaixo, e não logo depois do último card: com seis
    // quests ele nasce num lugar e com duas, noutro — e o jogador
    // precisa procurá-lo a cada tela. No rodapé ele está sempre no
    // mesmo ponto.
    elements.push(
      rowsPager({
        prefix: 'qp',
        rect: {
          anchorMin: { x: 0, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: left, y: 2 },
          offsetMax: { x: 0, y: 28 },
        },
        page: view.page,
        pages: view.pages,
        screenIdOf: (page) =>
          questsScreenId({ tab: view.tab, page, npcId: view.npcId ?? undefined }),
        kind: 'navigate',
      }),
    );
  }

  return screenOf(input.screenId, elements);
}

/**
 * A tela, com o id que foi PEDIDO.
 *
 * Ver o cabeçalho: um id diferente do pedido faz o plugin
 * descartar a resposta em silêncio.
 */
function screenOf(screenId: string, elements: readonly UiElement[]): UiScreen {
  // ####  O NOME EM MAIÚSCULAS, COMO AS IRMÃS  ####
  //
  // É o que a tela de Interface lista: ao lado de RANKING, KITS e
  // EVENTOS, um "Missões" capitalizado lia como se fosse de outra
  // categoria — e foi assim que o dono o encontrou, agrupado com
  // os modais.
  return { id: screenId, name: 'MISSÕES', kind: 'page', elements: [...elements] };
}

/**
 * Um retângulo colado no topo do slot, do `left` até a borda
 * direita.
 *
 * Não há margem externa: o slot do shell já dá os 30 px dele, e o
 * ranking desenha assim — a coluna e o título dele começam no x=0
 * do slot. Somar mais 22 aqui deixaria as duas telas desalinhadas
 * por exatamente esses 22 px.
 */
function rectOf(left: number, top: number, bottom: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -bottom },
    offsetMax: { x: 0, y: -top },
  };
}

// ------------------------------------------------------------
//  A BARRA LATERAL
// ------------------------------------------------------------

/**
 * As três listas, em coluna.
 *
 * ####  A DA VEZ É UM PAINEL, E NÃO UM BOTÃO  ####
 *
 * Clicar nela navegaria para onde já se está — um clique que não
 * faz nada, que é o que parece defeito. Ver ui-widgets.ts:284.
 *
 * O número ao lado é o que essa lista tem AGORA. Sem ele o jogador
 * precisa entrar em cada uma para descobrir se há algo a resgatar.
 */
function sidebar(view: QuestsView): UiElement[] {
  const items: UiElement[] = [];

  for (const [index, tab] of TABS.entries()) {
    const id = `qt${tab.slice(0, 3)}`;
    const count = view.counts === null ? null : view.counts[tab];
    const active = tab === view.tab;

    // ####  O NÚMERO NÃO PODE ENCOSTAR NO BOTÃO  ####
    //
    // ISTO ACONTECEU, e o log do servidor provou: enquanto o
    // rótulo da contagem cobria o item inteiro — irmão do botão e
    // declarado DEPOIS dele, portanto POR CIMA —, clicar em
    // DISPONÍVEIS não gerava pedido nenhum. No Unity o texto tem
    // `raycastTarget` ligado por padrão, e no CUI a ordem da lista
    // é a profundidade: o rótulo transparente engolia o clique
    // inteiro.
    //
    // A saída não é pendurá-lo NO botão (daria no mesmo: filho por
    // cima também intercepta), e sim os dois não se tocarem. O
    // botão termina onde o número começa.
    const badge = (color: string): UiElement[] =>
      count === null
        ? []
        : [
            label(`${id}n`, String(count), columnItem(index, COLUMN.width - BADGE, 12), {
              size: 12,
              color,
              align: 'MiddleRight',
              font: 'RobotoCondensed-Bold.ttf',
            }),
          ];

    if (active) {
      items.push(
        // Mais ESCURO que a coluna, e não mais claro: sobre um
        // fundo escuro, o buraco lê como "aberto" e a barra
        // vermelha diz qual é. Clarear seria o mesmo efeito do
        // hover, e aí o item aberto e o item sob o cursor
        // pareceriam a mesma coisa.
        panel(id, columnItem(index), C.bg, [
          // A barra vermelha é o acento do painel, virado de lado.
          panel(`${id}b`, columnAccent(), C.rust),
          label(`${id}l`, TAB_LABELS[tab], fill(COLUMN.textLeft, 0, BADGE, 0), {
            size: 12,
            color: C.text,
            align: 'MiddleLeft',
            font: 'RobotoCondensed-Bold.ttf',
          }),
        ]),
        ...badge(C.text),
      );

      continue;
    }

    items.push(
      button(
        id,
        TAB_LABELS[tab],
        // ####  O BOTÃO COMEÇA ONDE O TEXTO DO ATIVO COMEÇA  ####
        //
        // O texto de um `CuiButton` preenche o botão inteiro (ver
        // game/ui-cui.ts:280) — não há margem para dar dentro
        // dele. Quem dá a margem é o RETÂNGULO: recuado, o texto
        // alinhado à esquerda cai exatamente sob o do item ativo,
        // que é recuado pelo `fill` do rótulo dele.
        // A direita é aparada quando há número: ver `badge`.
        columnItem(index, COLUMN.textLeft, count === null ? 0 : BADGE),
        { id: `a${id}`, kind: 'navigate', screenId: questsScreenId({ tab }) },
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
      ...badge(C.textMuted),
    );
  }

  return [
    label('qh', 'MISSÕES', columnTitle(), {
      size: 20,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    // ####  O FUNDO DA COLUNA É A DIVISÓRIA  ####
    //
    // Pintá-la faz o mesmo trabalho de uma régua de 1 px ao lado,
    // com UM elemento a menos — e num documento cujo teto é o frame
    // do RCON, cada elemento a menos é espaço para uma linha a mais
    // da lista.
    panel('qcol', columnRect(), C.surface2, items),
  ];
}

/** A faixa do título, acima da coluna. */
function columnTitle(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: -Y.title },
    offsetMax: { x: COLUMN.width, y: 0 },
  };
}

/** A coluna inteira: largura fixa, do corpo até o fundo. */
function columnRect(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: COLUMN.width, y: -Y.body },
  };
}

/**
 * Um item da coluna, contado do topo DELA.
 *
 * As âncoras em x vão de 0 a 1 porque o pai já é a coluna — é o
 * que faz o item acompanhar a largura dela sem repetir o número.
 */
function columnItem(index: number, left = 0, right = 0): Rect {
  const top = index * COLUMN.item;

  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -(top + COLUMN.item) },
    offsetMax: { x: -right, y: -top },
  };
}

/** A barra de acento do item da vez, colada na borda esquerda. */
function columnAccent(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 3 },
    offsetMax: { x: 3, y: -3 },
  };
}

/**
 * Um bloco de quest.
 *
 * Título em cima, frase embaixo, barra de progresso no rodapé do
 * bloco e os botões à direita. O bloco inteiro NÃO é clicável: o
 * clique precisa ser no botão, senão tocar para ler o texto
 * aceitaria a quest sem querer.
 */
function cardElements(card: QuestCard, id: string, left: number, top: number): UiElement[] {
  // A largura reservada aos botões, à direita: DETALHES e a ação.
  const gutter = card.actionId === null ? 106 : 202;

  // ####  AS FAIXAS SÃO MEDIDAS DO TOPO, E NÃO DOS DOIS LADOS  ####
  //
  // ISTO SE VIU NO JOGO: título e frase eram contados do topo, a
  // recompensa do FUNDO — e num card de 58 px as duas últimas se
  // encavalavam. Na tela, "1 pts" saía escrito por cima de
  // "Concluída — toque em RESGATAR".
  //
  // Com tudo medido do mesmo lado a conta fecha por construção:
  // cada faixa começa onde a anterior terminou, e mudar a altura
  // do card não desalinha nada.
  const row = (top: number, height: number): Rect => ({
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 10, y: -(top + height) },
    offsetMax: { x: -gutter, y: -top },
  });

  const children: UiElement[] = [
    label(`${id}t`, card.title, row(6, 18), {
      size: 13,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    label(`${id}l`, card.line, row(25, 14), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
    }),
  ];

  if (card.reward !== '') {
    children.push(
      label(`${id}r`, card.reward, row(40, 12), {
        size: 10,
        color: C.rust,
        align: 'MiddleLeft',
      }),
    );
  }

  if (card.progress !== null) {
    // A barra é dois painéis: o trilho e o preenchimento. Não há
    // widget de barra no CUI — e não precisa haver.
    children.push(
      panel(
        // A barra fecha o bloco: 4 px de altura logo abaixo da
        // recompensa, que termina em 52.
        `${id}bg`,
        row(52, 4),
        C.surface2,
        [
          panel(
            `${id}bf`,
            {
              anchorMin: { x: 0, y: 0 },
              // ####  NÃO USE O `clamp` DAQUI  ####
              //
              // O `clamp` de ui-widgets.ts faz `Math.trunc`: ele é
              // para PÁGINAS, que são inteiras. Passar uma fração
              // por ele zera toda barra abaixo de 100% — e a tela
              // fica com a barra vazia sem nenhum erro em lugar
              // nenhum. MEDIDO, e pego pelo teste da barra.
              anchorMax: { x: Math.min(1, Math.max(0, card.progress)), y: 1 },
              offsetMin: { x: 0, y: 0 },
              offsetMax: { x: 0, y: 0 },
            },
            C.rust,
          ),
        ],
      ),
    );
  }

  if (card.detailScreenId !== null) {
    children.push(
      button(
        `${id}i`,
        'DETALHES',
        {
          anchorMin: { x: 1, y: 0 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: -(gutter - 6), y: 10 },
          offsetMax: { x: -(gutter - 96), y: -10 },
        },
        // ####  MODAL, E NÃO NAVEGAÇÃO  ####
        //
        // `modal.open` desenha por cima e deixa a lista embaixo
        // intacta: fechar volta para ela sem ir à rede, e sem
        // perder a página em que o jogador estava.
        { id: `a${id}i`, kind: 'modal.open', screenId: card.detailScreenId },
        { color: C.surface2, textColor: C.textMuted, hoverColor: C.border, fontSize: 11 },
      ),
    );
  }

  if (card.actionId !== null && card.actionLabel !== null) {
    children.push(
      button(
        `${id}b`,
        card.actionLabel,
        { anchorMin: { x: 1, y: 0 }, anchorMax: { x: 1, y: 1 }, offsetMin: { x: -100, y: 10 }, offsetMax: { x: -10, y: -10 } },
        // O canal do clique: `store.buy` com `offerId` prefixado.
        { id: `a${id}`, kind: 'store.buy', offerId: card.actionId, quantity: 1 },
        { color: C.rust, textColor: C.text, fontSize: 12 },
      ),
    );
  }

  return [panel(id, rectOf(left, top, top + CARD), C.surface, children)];
}

// ------------------------------------------------------------
//  O MODAL DE DETALHE
// ------------------------------------------------------------

/** Quantas linhas de objetivo e de recompensa cabem na caixa. */
const DETAIL_OBJECTIVES = 5;
const DETAIL_REWARDS = 4;

/**
 * A altura de uma linha de recompensa.
 *
 * Maior que a de objetivo (18) porque ela carrega um ÍCONE: um
 * quadrado de 18 px encostaria no da linha de baixo, e abaixo disso
 * o item deixa de ser reconhecível.
 */
const REWARD_ROW = 24;

const DETAIL_WIDTH = 500;

/**
 * A caixa CRESCE com o conteúdo.
 *
 * ####  A ALTURA FIXA ERRAVA DOS DOIS LADOS  ####
 *
 * Uma missão de um objetivo e uma recompensa deixava metade da
 * caixa vazia; uma de cinco objetivos e quatro recompensas passava
 * dos 380 px e escrevia POR CIMA dos botões do rodapé. A conta:
 * 46 do título + 40 da descrição + 20 + 5x18 + 18 + 8 + 20 + 4x24
 * dá 384, e o rodapé começava em 334.
 *
 * Com a altura saindo do `cursor`, os dois casos ficam certos por
 * construção — e acrescentar uma seção nova não exige refazer
 * conta nenhuma.
 */
const DETAIL_MIN_HEIGHT = 200;
/** O que o rodapé precisa abaixo do conteúdo: margem + botão + margem. */
const DETAIL_FOOTER = 62;

/**
 * A caixa do detalhe.
 *
 * Não usa o `modalFrame` do ui-widgets porque aquele desenha o véu
 * com ids fixos (`veil`, `box`) — e aqui ele é montado à mão para
 * a caixa poder ter altura própria e o rodapé de três botões.
 */
function detailElements(detail: QuestDetail): UiElement[] {
  const box: UiElement[] = [
    panel('qdacc', { anchorMin: { x: 0, y: 1 }, anchorMax: { x: 1, y: 1 }, offsetMin: { x: 0, y: -2 }, offsetMax: { x: 0, y: 0 } }, C.rust),

    label('qdt', detail.title, boxRect(14, 46), {
      size: 16,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];

  let cursor = 52;

  if (detail.description !== '') {
    box.push(
      label('qdd', detail.description, boxRect(cursor, cursor + 34), {
        size: 12,
        color: C.textMuted,
        align: 'UpperLeft',
      }),
    );
    cursor += 40;
  }

  if (detail.objectives.length > 0) {
    box.push(
      label('qdol', 'OBJETIVOS', boxRect(cursor, cursor + 16), {
        size: 10,
        color: C.textMuted,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
    );
    cursor += 20;

    detail.objectives.slice(0, DETAIL_OBJECTIVES).forEach((objective, index) => {
      const line = `${objective.done ? '✔' : '•'}  ${objective.text}`;
      const counter =
        objective.have === null
          ? `0 / ${objective.need.toLocaleString('pt-BR')}`
          : `${objective.have.toLocaleString('pt-BR')} / ${objective.need.toLocaleString('pt-BR')}`;

      box.push(
        label(`qdo${String(index)}`, line, boxRect(cursor, cursor + 18, 22, 130), {
          size: 12,
          // O que já fechou fica verde: numa lista de cinco, é o
          // que se lê antes de ler o texto.
          color: objective.done ? C.olive : C.text,
          align: 'MiddleLeft',
        }),
        label(
          `qdo${String(index)}c`,
          counter,
          {
            anchorMin: { x: 1, y: 1 },
            anchorMax: { x: 1, y: 1 },
            offsetMin: { x: -128, y: -(cursor + 18) },
            offsetMax: { x: -22, y: -cursor },
          },
          { size: 11, color: objective.done ? C.olive : C.textMuted, align: 'MiddleRight' },
        ),
      );

      cursor += 18;
    });

    const hidden = detail.objectives.length - DETAIL_OBJECTIVES;

    if (hidden > 0) {
      box.push(
        label('qdomais', `e mais ${String(hidden)}…`, boxRect(cursor, cursor + 16, 34), {
          size: 11,
          color: C.textMuted,
          align: 'MiddleLeft',
        }),
      );
      cursor += 18;
    }

    cursor += 8;
  }

  if (detail.rewards.length > 0) {
    box.push(
      label('qdrl', 'RECOMPENSAS', boxRect(cursor, cursor + 16), {
        size: 10,
        color: C.textMuted,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
    );
    cursor += 20;

    detail.rewards.slice(0, DETAIL_REWARDS).forEach((reward, index) => {
      const id = `qdr${String(index)}`;

      // ####  O ÍCONE NÃO É DESENHADO PELO AGENTE  ####
      //
      // Ele manda o `itemId`, e QUEM RESOLVE a imagem é o cliente —
      // é o mesmo caminho da loja e dos kits. Um item que o
      // catálogo não conhece volta sem ícone e a linha cai no
      // marcador, em vez de ficar com um quadrado vazio.
      if (reward.icon !== null) {
        box.push(
          reward.icon.kind === 'coin'
            ? {
                id: `${id}i`,
                name: `${id}i`,
                type: 'image',
                rect: iconRect(cursor),
                // O PNG vive em `Assets/ui/ozcoin.png` e é o agente
                // que o entrega ao servidor; aqui vai só a chave.
                source: { kind: 'stored', key: COIN_IMAGE_KEY },
                // Branco: `color` numa imagem TINGE.
                color: C.white,
                children: [],
              }
            : itemImage(`${id}i`, reward.icon, iconRect(cursor)),
        );
      }

      box.push(
        label(
          id,
          reward.icon === null ? `•  ${reward.text}` : reward.text,
          boxRect(cursor, cursor + 18, reward.icon === null ? 22 : 46),
          { size: 12, color: C.amber, align: 'MiddleLeft' },
        ),
      );

      cursor += REWARD_ROW;
    });
  }

  if (detail.note !== null) {
    box.push(
      label('qdn', detail.note, boxRect(cursor + 6, cursor + 40), {
        size: 12,
        color: detail.actionId === null ? C.textMuted : C.olive,
        align: 'UpperLeft',
      }),
    );

    // ####  ELA TAMBEM ANDA COM O CURSOR  ####
    //
    // ISTO APARECEU NO JOGO: a nota era a unica secao que desenhava
    // sem avancar o cursor. Como a altura da caixa sai DELE, o
    // rodape era calculado como se ela nao existisse — e o "Conclua
    // X antes desta" saia escrito atras do botao FECHAR.
    //
    // Qualquer secao nova aqui precisa fazer o mesmo. E o que o
    // teste do rodape cobra.
    cursor += 46;
  }

  // ------------------------------------------------------------
  //  O RODAPÉ
  // ------------------------------------------------------------

  box.push(
    button(
      'qdfechar',
      'FECHAR',
      footerRect(22, 110),
      { id: 'aqdfechar', kind: 'modal.close' },
      { color: C.surface2, textColor: C.textMuted, hoverColor: C.border, fontSize: 12 },
    ),
  );

  if (detail.abandonId !== null) {
    box.push(
      button(
        'qdabandonar',
        'ABANDONAR',
        footerRect(118, 232),
        // Mesmo canal do resto: `store.buy` com o prefixo `quest:`.
        // O `runQuestAction` do index.ts reconhece o verbo `cancel`.
        { id: 'aqdabandonar', kind: 'store.buy', offerId: detail.abandonId, quantity: 1 },
        // Cinza, e não vermelho: o vermelho aqui é a cor da AÇÃO
        // principal, que fica do outro lado. Duas caixas vermelhas
        // no mesmo rodapé fariam abandonar parecer o que se espera
        // que ele faça.
        { color: C.surface2, textColor: C.textMuted, hoverColor: C.rust, fontSize: 12 },
      ),
    );
  }

  if (detail.actionId !== null && detail.actionLabel !== null) {
    box.push(
      {
        ...button(
          'qdok',
          detail.actionLabel,
          footerRect(0, 0),
          { id: 'aqdok', kind: 'store.buy', offerId: detail.actionId, quantity: 1 },
          { color: C.rust, textColor: C.white, fontSize: 12 },
        ),
        // Ancorado à DIREITA: é o lado em que a ação que confirma
        // mora no modal da loja, e trocar de lado entre uma tela e
        // outra é o tipo de detalhe que faz alguém clicar errado.
        rect: {
          anchorMin: { x: 1, y: 0 },
          anchorMax: { x: 1, y: 0 },
          offsetMin: { x: -170, y: 16 },
          offsetMax: { x: -22, y: 46 },
        },
      },
    );
  }

  // O `cursor` parou onde o conteúdo terminou. A caixa é isso mais
  // o rodapé — nunca menor que o mínimo, senão uma missão sem
  // objetivo nem recompensa viraria uma tarja.
  const height = Math.max(DETAIL_MIN_HEIGHT, cursor + DETAIL_FOOTER);

  return [
    // #000000B3 é o véu do preset. Um alfa diferente aqui seria uma
    // cor "quase igual", que é o tipo de diferença que ninguém nota
    // e ninguém consegue explicar depois.
    panel('qdveu', fill(), '#000000B3', [
      panel(
        'qdcaixa',
        {
          anchorMin: { x: 0.5, y: 0.5 },
          anchorMax: { x: 0.5, y: 0.5 },
          offsetMin: { x: -DETAIL_WIDTH / 2, y: -height / 2 },
          offsetMax: { x: DETAIL_WIDTH / 2, y: height / 2 },
        },
        C.surface,
        box,
      ),
    ]),
  ];
}

/** Uma faixa dentro da caixa, medida do topo dela. */
function boxRect(top: number, bottom: number, left = 22, right = 22): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: left, y: -bottom },
    offsetMax: { x: -right, y: -top },
  };
}

/**
 * O quadrado do ícone, na margem esquerda da caixa.
 *
 * Ele é 2 px mais alto que o texto ao lado e sobe 3 px: um ícone
 * alinhado pelo topo do texto parece estar caindo, porque o
 * desenho do item não preenche o quadrado inteiro.
 */
function iconRect(top: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 22, y: -(top + 20) },
    offsetMax: { x: 42, y: -top },
  };
}

/** Um botão do rodapé da caixa, medido da esquerda. */
function footerRect(left: number, right: number): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 0 },
    offsetMin: { x: left, y: 16 },
    offsetMax: { x: right, y: 46 },
  };
}

// ------------------------------------------------------------
//  §5  O PROVEDOR
// ------------------------------------------------------------

export type QuestsScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

export interface QuestsScreenProviderOptions {
  readonly quests: QuestsService;
  /** O nome do NPC, para o título da tela dele. */
  readonly npcNameOf?: (npcId: string) => string | null;
  /**
   * O catálogo do jogo e o dos rankings.
   *
   * Ausente = a recompensa aparece com a chave crua e sem ícone.
   * Não é erro: é o que o teste usa, e é o que sobra se alguém
   * apagar o item do cadastro depois de a missão prometê-lo.
   */
  readonly catalog?: QuestsCatalog;
  readonly logger?: Logger;
}

/**
 * O provedor que o `generatedScreens` do index.ts chama.
 *
 * ####  ELE NUNCA DEIXA O JOGADOR NO "CARREGANDO"  ####
 *
 * `null` só para o que não é dele. Qualquer falha vira A TELA com
 * o aviso — volátil, e por isso o clique seguinte tenta de novo.
 * Silêncio deixaria o jogador girando até o timeout do plugin.
 */
export function createQuestsScreenProvider(
  options: QuestsScreenProviderOptions,
): QuestsScreenProvider {
  return async (input) => {
    const target = parseQuestsScreenId(input.screenId);

    if (target === null) {
      return null;
    }

    const pack = (view: QuestsView): UiScreenBundle =>
      toGeneratedScreenBundle(
        input.document,
        buildQuestsScreen({ view, screenId: input.screenId }),
        // O endereço que o SHELL conhece. Sem ele, abrir uma lista
        // ou o modal apagaria o destaque de MISSÕES no cabeçalho.
        QUESTS_SCREEN_ID,
      );

    try {
      return pack(
        await readQuestsView({
          reader: options.quests,
          serverId: input.serverId,
          steamId: input.steamId,
          target,
          npcName:
            target.npcId === null ? null : (options.npcNameOf?.(target.npcId) ?? target.npcId),
          catalog: options.catalog ?? {},
        }),
      );
    } catch (error) {
      options.logger?.error(
        { server: input.serverId, screen: input.screenId, err: toError(error) },
        'não consegui montar a tela de missões; mando a tela com o aviso, que não fica em cache',
      );

      return pack({
        ...emptyQuestsView(),
        trouble: 'Não deu para carregar as missões agora. Tente de novo em instantes.',
      });
    }
  };
}
