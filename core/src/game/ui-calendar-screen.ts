// ============================================================
//  ui-calendar-screen.ts  -  a página CALENDÁRIO, montada da
//  agenda do wipe.
//
//  ####  POR QUE ESTA TELA NÃO É DESENHADA NO EDITOR  ####
//
//  Até aqui ela era um retângulo dizendo "Wipes e eventos
//  programados entram aqui". O que ela precisa mostrar — a data do
//  próximo wipe e QUANTO FALTA para ele — muda a cada minuto e vem
//  do banco, não do desenho de ninguém. É o mesmo caso da página
//  de KITS, e o padrão é o dela, linha por linha: o documento
//  guarda só o ENDEREÇO (`tela-calendario`) e o agente monta o
//  conteúdo na hora do clique.
//
//  ####  ELA NUNCA É GUARDADA EM CACHE  ####
//
//  `volatile: true` no pacote — quem o marca é o
//  `toGeneratedScreenBundle`. A tela diz "faltam 6 dias e 4
//  horas"; em cache ela mostraria as mesmas seis horas para
//  sempre, e o jogador decidiria se sobe a base hoje confiando
//  naquilo.
//
//  ------------------------------------------------------------
//  ####  O RECORTE POR NÍVEL ACONTECE ANTES DO DESENHO  ####
//
//  É a regra que manda neste arquivo, e é por ela que existem DUAS
//  funções em vez de uma:
//
//    buildPlayerCalendar()   corta pelo nível de VIP e devolve só
//                            o que AQUELE jogador pode ver;
//    buildCalendarScreen()   desenha o que recebeu, e nada além.
//
//  Recortar só na hora de desenhar deixaria a seed do próximo mapa
//  viajar na payload do RCON — escondida atrás de um widget que
//  ninguém desenhou, mas presente no JSON que o cliente recebe. O
//  que o jogador não pode ver NÃO ATRAVESSA O RCON.
//
//  E a seed não atravessa para ninguém: `CalendarMapView` não tem
//  campo para ela. Mostrar a IMAGEM é uma chave; mostrar a SEED é
//  outra, e ela não é desta frente (Docs\16 §9.3) — com a seed o
//  jogador abre o RustMaps e estuda cada monumento dias antes.
//
//  ------------------------------------------------------------
//  ####  A RÉGUA DO VIP, E POR QUE ELA VEM DE GRAÇA  ####
//
//    sem VIP / bronze   a data e a política de blueprint
//    silver             + 1 mundo do futuro (tamanho e imagem)
//    gold               + 3 mundos do futuro
//
//  A régua conta MUNDOS, e não posições da fila: o do cartão é o
//  primeiro deles QUANDO ele vem descrito por extenso — a entrada
//  que vai ser consumida, ou o mundo que o `configurar` já gravou
//  na execução. Com um plano `keep` o cartão responde "o mesmo mapa
//  de agora" e não descreve mundo nenhum, e aí os três do ouro são
//  os três primeiros da fila.
//
//  O dado já existe: a fila de mapas é do admin e o RustMaps já
//  preencheu as imagens. "VIP vê o futuro" é produto que não custa
//  uma tabela nova.
//
//  ------------------------------------------------------------
//  ####  A DECISÃO É A MESMA DO CHAT, E NÃO SÓ AS FRASES  ####
//
//  `formatWipeCountdown`, `formatWipeMoment`, `describeBpPolicy` e
//  `describeMapEntry` vêm de messages/providers/wipe.ts, que é
//  quem responde `{wipe.faltam}`. Mas reusar só o TEXTO não basta,
//  e a primeira versão desta tela provou: ela reimplementou QUAL
//  plano é o próximo e QUAL mapa é o dele, e às 14:00 de quarta,
//  com wipe quinta às 10:00, o chat anunciava "WIPE em 20 horas"
//  enquanto o menu dizia "faltam 7 dias e 20 horas". As frases
//  eram idênticas; as respostas, não.
//
//  Por isso o `next` chega aqui PRONTO, de `nextWipe`
//  (wipe/next-wipe.ts) — a mesma função que o provedor do chat
//  chama. Esta tela desenha a decisão; ela não a toma.
//
//  Os construtores de tela vêm de ui-widgets.ts, compartilhados
//  com a loja e os kits: duas cópias divergem no primeiro ajuste.
// ============================================================

import type { WipeScheduleReader } from '../db/wipe-schedule-repository.js';
import type { Logger } from '../logger.js';
import {
  describeBpPolicy,
  describeMapEntry,
  describeNextWipeMap,
  formatWipeCountdown,
  formatWipeMoment,
  MAP_DRAWN_ON_THE_SPOT,
  NO_WIPE_SCHEDULED,
} from '../messages/providers/wipe.js';
import type { UiDocument, UiElement, UiScreen } from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import type { BpPolicy, MapKind, MapPoolEntry, WipePlan, WipePlanKind } from '../types/wipe.js';
import { toError } from '../util.js';
import type { VipTierLevel } from '../vip/tiers.js';
import {
  nextWipe,
  type NextWipe,
  type NextWipeMap,
  type WipeCurrentWorldReader,
  type WipeMapPoolReader,
  type WipeRunsReader,
} from '../wipe/next-wipe.js';

import {
  C,
  fill,
  itemRows,
  label,
  panel,
  topBar,
  urlImage,
  type ContentRow,
  type Rect,
} from './ui-widgets.js';

/**
 * O id da tela no documento.
 *
 * FIXO, e não sorteado: é por ele que o agente reconhece a tela
 * cujo conteúdo ele mesmo monta. Precisa bater com o preset — a
 * nav `calendario` de game/ui-preset-main-menu.ts já navega para
 * cá.
 */
export const CALENDAR_SCREEN_ID = 'tela-calendario';

/**
 * O pedido é DESTA tela?
 *
 * Id exato, sem família de endereços: o calendário não tem
 * categoria, página nem modal — ele é uma leitura só. Quem
 * reconhece um prefixo é a loja (`tela-loja:vip:2`), e é por isso
 * que ela é perguntada antes.
 */
export function isCalendarScreenId(screenId: string): boolean {
  return screenId === CALENDAR_SCREEN_ID;
}

// ============================================================
//  §1  O RECORTE — o que aquele jogador pode ver
// ============================================================

/**
 * A régua, do nível mais alto para o mais baixo.
 *
 * Lida NESTA ordem: quem tem `gold` para no primeiro degrau.
 * Acrescentar um nível é acrescentar uma linha.
 */
export const CALENDAR_TIER_RULER = [
  { tier: 'gold', maps: 3 },
  { tier: 'silver', maps: 1 },
] as const;

/** Quantos wipes futuros a tela lista. */
export const CALENDAR_WIPE_LIMIT = 5;

/** Um wipe da agenda, como o jogador o vê. */
export interface CalendarWipeView {
  /** Epoch ms UTC. */
  readonly scheduledAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  /**
   * Ele foi cancelado por um wipe forçado que cai perto.
   *
   * Continua na lista, marcado: uma agenda com um buraco não
   * explica por que terça não vai ter wipe.
   */
  readonly absorbed: boolean;
}

/**
 * O PRÓXIMO wipe — o do cartão grande.
 *
 * ####  ELE NÃO É `wipes[0]`  ####
 *
 * E não é por dois motivos, os dois medidos:
 *
 *   · o mais próximo da agenda pode estar `absorbed`. Com a
 *     colisão em `absorb`, o wipe de cadência de quarta é cancelado
 *     pelo forçado de quinta e continua na tabela, na frente dele.
 *     No cartão grande, ele daria ao jogador data, contagem e
 *     política de blueprint de um wipe que não vai acontecer;
 *
 *   · nas horas que antecedem a hora marcada o wipe já está
 *     `running` — o relógio dispara com a antecedência do maior
 *     aviso, 24 h no padrão. Um filtro que só aceitasse `planned`
 *     pularia justamente o wipe que o chat está anunciando.
 *
 * Quem decide é `nextWipe`, de wipe/next-wipe.ts: a MESMA função
 * que responde `{wipe.faltam}`.
 */
export interface CalendarNextWipeView {
  /** Epoch ms UTC. */
  readonly scheduledAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  /** A execução dele já começou: os avisos já estão saindo no chat. */
  readonly running: boolean;
  /**
   * O mundo que entra, na frase do chat.
   *
   * `null` = o nível deste jogador não alcança o mapa. É diferente
   * de "ninguém escolheu ainda", que tem frase própria
   * (`MAP_DRAWN_ON_THE_SPOT`) — e é o que impede a régua do VIP de
   * virar um buraco sem explicação.
   */
  readonly map: string | null;
  /**
   * A imagem daquele mundo, quando ele é uma entrada da fila — a
   * que vai ser consumida, ou a que o `configurar` já consumiu.
   */
  readonly image: CalendarMapView | null;
  /**
   * O mundo do cartão É uma entrada da fila de mapas.
   *
   * ####  E CONTINUA SENDO DEPOIS DE CONSUMIDA  ####
   *
   * Passado o `configurar`, o mundo está gravado na execução
   * (`mapFrom: 'world'`) e a entrada que virou ele está `used` — mas
   * a linha continua no banco, com a `preview_url` que o RustMaps
   * devolveu. É a MESMA imagem que o VIP prata via ontem, e ela não
   * deixa de existir porque a entrada saiu da fila.
   *
   * `false` nos dois mundos que nunca estiveram na fila: o `keep`, e
   * a seed que o agente SORTEOU porque a fila estava vazia. É o que
   * separa "a imagem ainda não veio do RustMaps" de "não existe
   * imagem deste mundo em lugar nenhum" — ver `missingImageNote`.
   *
   * `false` também para quem não alcança o mapa, como `map` e
   * `image`: o que ele não pode ver não atravessa o RCON.
   */
  readonly mapFromQueue: boolean;
  /**
   * DE ONDE aquele mundo saiu, na união de `nextWipe`.
   *
   * ####  ELE É O QUE DIZ SE A FILA FOI CONSUMIDA  ####
   *
   * Sem este campo o desenho só tinha `image === null` para se
   * guiar, e ele responde "não há imagem" — que é a mesma coisa
   * para quatro situações diferentes: o mundo é o mesmo de agora
   * (`keep`), ele já está gravado na execução (`world`), ninguém o
   * escolheu (`undecided`), ou ele é uma entrada da fila cuja
   * prévia o RustMaps ainda não devolveu. Só a última é uma prévia
   * PENDENTE, e só ela consome uma vaga da régua e uma posição da
   * numeração.
   *
   * `null` = o nível deste jogador não alcança o mapa, como em
   * `map`: o que ele não pode ver não atravessa o RCON, nem como
   * rótulo.
   */
  readonly mapFrom: NextWipeMap['source'] | null;
}

/**
 * Um mundo da fila, como o jogador o vê.
 *
 * ####  NÃO HÁ CAMPO PARA A SEED, E ISSO É O RECURSO  ####
 *
 * Não é esquecimento nem economia de bytes: é o tipo que impede a
 * seed de chegar ao desenho por acidente. Quem quiser mostrá-la um
 * dia vai precisar mexer AQUI, que é onde o comentário está.
 */
export interface CalendarMapView {
  readonly kind: MapKind;
  /** O nome do mundo, quando ele não é procedural. */
  readonly level: string | null;
  readonly worldSize: number | null;
  /** A imagem grande. `null` = ainda não veio do RustMaps. */
  readonly previewUrl: string | null;
  readonly thumbUrl: string | null;
  /**
   * Por que a imagem foi RETIRADA, quando ela existia.
   *
   * `null` = nada foi retirado (com ou sem imagem). A anulação
   * precisa deixar rastro: sem este campo, um mundo com prévia
   * pronta no banco aparecia para sempre como "ainda não ficou
   * pronta", e ninguém tinha por onde começar a procurar.
   */
  readonly imageHiddenBy: 'seed-na-url' | null;
}

/** Tudo o que a tela daquele jogador pode desenhar. E nada além. */
export interface PlayerCalendar {
  /** O relógio do AGENTE, que é de onde a contagem sai. */
  readonly now: number;
  /** A zona IANA em que as datas são escritas. */
  readonly timeZone: string;
  /** O nível que mandou no recorte. `null` = sem VIP. */
  readonly tier: string | null;
  /** Quantos mundos este nível enxerga: 0, 1 ou 3. */
  readonly mapsAllowed: number;
  /** O do cartão grande. `null` = não há wipe à vista. */
  readonly next: CalendarNextWipeView | null;
  /**
   * O RESTO da agenda, do mais próximo para o mais distante.
   *
   * Sem o `next` dentro: ele já tem cartão próprio, e repeti-lo
   * aqui faria a lista "DEPOIS" começar pelo wipe que está logo
   * acima dela.
   */
  readonly wipes: readonly CalendarWipeView[];
  /**
   * Os mundos da FILA atrás do próximo, na ordem. Sem seed.
   *
   * O mundo do próximo wipe não está aqui: ele é `next.image`, e
   * pode nem sair da fila (um plano `keep` não consome nenhuma
   * entrada). Quando o cartão não descreve mundo nenhum — `keep`,
   * `undecided`, ou não haver wipe à vista —, a régua inteira sobra
   * para esta lista: é o que mantém o total de mundos vistos igual
   * ao do nível, venha o mundo do plano ou da fila.
   */
  readonly maps: readonly CalendarMapView[];
}

export interface PlayerCalendarInput {
  readonly now: number;
  readonly timeZone: string;
  /**
   * QUAL é o próximo wipe, já decidido por `nextWipe`.
   *
   * Vem pronto de fora, e não é calculado aqui, porque a decisão é
   * do chat também: um `find` local sobre `plans` seria a segunda
   * conta que esta frente existe para não ter. `null` = nenhum.
   */
  readonly next: NextWipe | null;
  /** A agenda já lida do banco, em ordem. */
  readonly plans: readonly WipePlan[];
  /** A fila de mapas daquele servidor, em ordem. */
  readonly queue: readonly MapPoolEntry[];
  /** Os níveis que o jogador tem AGORA. Vazio = sem VIP. */
  readonly tiers: readonly string[];
  /**
   * Os níveis daquele servidor, para saber que `gold` vale mais
   * que `silver`. Vazio = config não lido, e aí a comparação vira
   * igualdade pura de nome — é o que se pode afirmar sem inventar
   * hierarquia. A mesma decisão do `#hasTier` dos kits.
   */
  readonly levels: readonly VipTierLevel[];
  readonly limit?: number;
}

/**
 * Quantos mundos aquele jogador enxerga, e por qual nível.
 *
 * A ordem entre níveis sai do `Rank` do `OrigemZVip.json` daquele
 * servidor — a mesma tabela que o plugin usa no `HasVipTier`, e a
 * mesma que os kits leem. Sem ela, só a igualdade de nome vale.
 */
export function mapAllowanceOf(
  tiers: readonly string[],
  levels: readonly VipTierLevel[],
): { readonly maps: number; readonly tier: string | null } {
  const owned = tiers.map((tier) => tier.trim().toLowerCase()).filter((tier) => tier !== '');
  const rankOf = new Map(levels.map((level, index) => [level.tier, level.rank ?? index]));

  const hasAtLeast = (wanted: string): boolean => {
    if (owned.includes(wanted)) {
      return true;
    }

    const needed = rankOf.get(wanted);

    if (needed === undefined) {
      return false;
    }

    return owned.some((tier) => (rankOf.get(tier) ?? Number.NEGATIVE_INFINITY) >= needed);
  };

  for (const step of CALENDAR_TIER_RULER) {
    if (hasAtLeast(step.tier)) {
      return { maps: step.maps, tier: step.tier };
    }
  }

  // Sem direito a mapa nenhum. O nível continua sendo dito: quem
  // tem bronze precisa ler "o seu VIP não alcança", e não "você
  // não tem VIP".
  return { maps: 0, tier: owned[0] ?? null };
}

/**
 * A agenda e a fila, RECORTADAS para quem está olhando.
 *
 * É aqui que o VIP vira ou não vira informação. Depois disto, o
 * desenho não tem como vazar o que não recebeu.
 */
export function buildPlayerCalendar(input: PlayerCalendarInput): PlayerCalendar {
  const allowance = mapAllowanceOf(input.tiers, input.levels);
  const next = input.next;

  const wipes = input.plans
    .filter((plan) => plan.scheduledAt >= input.now)
    // ####  `running` ENTRA, E É O ESTADO DO DIA DO WIPE  ####
    //
    // Nas horas que antecedem a hora marcada o plano está
    // `running` — o relógio dispara com a antecedência do maior
    // aviso (24 h no padrão). Sem ele nesta lista, o wipe que o
    // chat está anunciando some da agenda do jogador.
    //
    // `absorbed` fica, marcado, como no `/wipe/upcoming` do painel.
    // `done`, `skipped` e `failed` estão na tabela para explicar um
    // dia sem wipe, e não para serem prometidos a ninguém.
    .filter(
      (plan) =>
        plan.status === 'planned' || plan.status === 'running' || plan.status === 'absorbed',
    )
    // O próximo já tem o cartão grande: repeti-lo faria a lista
    // "DEPOIS" abrir com o wipe que está logo acima dela.
    .filter((plan) => next === null || next.planId === null || plan.id !== next.planId)
    .slice(0, input.limit ?? CALENDAR_WIPE_LIMIT)
    .map(
      (plan): CalendarWipeView => ({
        scheduledAt: plan.scheduledAt,
        kind: plan.kind,
        bpPolicy: plan.bpPolicy,
        absorbed: plan.status === 'absorbed',
      }),
    );

  // Só os mundos PRONTOS: prometer um mapa que o RustMaps ainda
  // está desenhando é prometer o que pode não entrar.
  //
  // E sem o mundo do PRÓXIMO wipe, que já é `next.image`: com
  // `mapSource: 'fixed'` ele pode estar em qualquer posição da
  // fila, e num wipe forçado a cabeça da fila pode ter sido pulada
  // por ser custom sem marca de versão.
  const chosen = next?.map.source === 'entry' ? next.map.entry : null;

  // ####  O MUNDO JÁ GRAVADO NA EXECUÇÃO TAMBÉM TEM PRÉVIA  ####
  //
  // Passado o `configurar`, o mundo do wipe está em `map_after`, e o
  // `mapPoolId` dele diz QUAL entrada virou ele. Essa linha continua
  // no banco — `used`, e com a `preview_url` de sempre. Tratar
  // `world` como "não há imagem" apagava, no dia do wipe, a prévia
  // que o VIP prata via na véspera.
  //
  // As duas exceções estão no próprio mundo: `drawn` é a seed que o
  // agente sorteou com a fila vazia (a linha nasce sem prévia), e
  // `mapPoolId` nulo é o `keep`, que não toca a fila.
  const world = next?.map.source === 'world' ? next.map.world : null;

  const worldFromQueue =
    world !== null && world.drawn !== true && (world.mapPoolId ?? null) !== null;

  // A entrada que o cartão mostra: a que vai ser consumida, ou a que
  // já foi. `undefined` quando a linha sumiu do banco.
  const card =
    chosen ??
    (worldFromQueue
      ? (input.queue.find((entry) => entry.id === world?.mapPoolId) ?? null)
      : null);

  const ready = input.queue.filter(
    (entry) => entry.status === 'ready' && (card === null || entry.id !== card.id),
  );

  // ####  A VAGA SAI QUANDO O CARTÃO DIZ UM MUNDO  ####
  //
  // A régua conta MUNDOS DO FUTURO, e o do cartão é um deles sempre
  // que ele vem descrito por extenso — tamanho e nome. São dois
  // casos: a entrada da fila que vai ser consumida (`entry`) e o
  // mundo que o `configurar` já gravou na execução (`world`).
  // Prata fica com zero atrás; ouro, com dois.
  //
  // `keep` ("o mesmo mapa de agora") e `undecided` ("sorteado na
  // hora") não dizem mundo nenhum, e aí a régua inteira sobra para a
  // fila — descontar a vaga cobrava do jogador um mundo que ele não
  // viu. Medido: VIP OURO, plano `keep` e três procedurais prontos
  // na fila; a régua dá três mundos e a tela mostrava dois.
  //
  // O `world` faltava desta conta, e ele é o pior dos dois: durante
  // a execução a PRATA lia o cartão PROCEDURAL 4000 mais "#1 na fila
  // · procedural 3500" — dois mundos do futuro num nível que compra
  // um, e o segundo é faixa do OURO.
  const cardShowsWorld =
    next !== null && (next.map.source === 'entry' || next.map.source === 'world');

  const behind = Math.max(0, allowance.maps - (cardShowsWorld ? 1 : 0));

  return {
    now: input.now,
    timeZone: input.timeZone,
    tier: allowance.tier,
    mapsAllowed: allowance.maps,
    next:
      next === null
        ? null
        : {
            scheduledAt: next.wipeAt,
            kind: next.kind,
            bpPolicy: next.bpPolicy,
            running: next.running,
            // ####  O RECORTE ACONTECE AQUI, E NÃO NO DESENHO  ####
            //
            // Sem o nível, a frase do mundo nem chega a existir — e
            // por isso não há como ela viajar escondida na payload
            // do RCON atrás de um widget que ninguém desenhou.
            map:
              allowance.maps === 0
                ? null
                : (describeNextWipeMap(next.map) ?? MAP_DRAWN_ON_THE_SPOT),
            image: allowance.maps === 0 || card === null ? null : toMapView(card),
            mapFromQueue: allowance.maps !== 0 && (chosen !== null || worldFromQueue),
            mapFrom: allowance.maps === 0 ? null : next.map.source,
          },
    wipes,
    maps: ready.slice(0, behind).map(toMapView),
  };
}

/**
 * Uma entrada da fila vira o que pode ser visto.
 *
 * ####  A URL QUE CARREGA A SEED É DESCARTADA  ####
 *
 * O RustMaps devolve a imagem num endereço com UUID
 * (`.../img/287/b3c1f0a2/map.png`), e é ele que fica gravado. Mas
 * a coluna aceita qualquer texto, e a PÁGINA do mapa lá tem a
 * forma `rustmaps.com/map/4000_18422` — com a seed dentro. Se uma
 * dessas cair aqui, a imagem some e o resto continua: a prévia é
 * enfeite, e a seed não é.
 */
function toMapView(entry: MapPoolEntry): CalendarMapView {
  // Uma de cada vez: se só a prévia grande carrega a seed, a
  // miniatura continua servindo — perder as duas por causa de uma é
  // desistir de uma imagem que não vaza nada.
  const previewUrl = urlCarriesSeed(entry.previewUrl, entry.seed) ? null : entry.previewUrl;
  const thumbUrl = urlCarriesSeed(entry.thumbUrl, entry.seed) ? null : entry.thumbUrl;
  const hidden =
    (entry.previewUrl !== null && previewUrl === null) ||
    (entry.thumbUrl !== null && thumbUrl === null);

  return {
    kind: entry.kind,
    level: entry.level,
    worldSize: entry.worldSize,
    previewUrl,
    thumbUrl,
    imageHiddenBy: hidden ? 'seed-na-url' : null,
  };
}

/**
 * A URL entrega a seed deste mundo?
 *
 * ####  TOKEN INTEIRO, E NÃO SUBSTRING  ####
 *
 * `url.includes(seed)` parece a defesa óbvia e é uma armadilha:
 * seed curta é válida neste projeto (`7`, `287`), e a URL do
 * RustMaps carrega dígitos no caminho —
 * `files.rustmaps.com/img/287/b3c1f0a2/map.png`. Com `includes`, a
 * seed `7` casava com aquele `287` e o VIP lia PARA SEMPRE "a
 * imagem deste mundo ainda não ficou pronta", com a prévia pronta
 * no banco.
 *
 * Quebrar a URL em tokens alfanuméricos resolve o caso real — o
 * vazamento é `.../map/4000_18422`, em que a seed é um token
 * inteiro — sem anular a prévia de todo mundo.
 *
 * ####  O EMPATE CONTINUA CAINDO PARA O LADO SEGURO  ####
 *
 * Um segmento numérico igual à seed (`/287/` com seed `287`) é
 * indistinguível de um vazamento, e aí a imagem some MESMO ASSIM.
 * Perder uma prévia por coincidência é barato; entregar a seed
 * dias antes do wipe, não. A diferença é que agora isso deixa
 * rastro em `imageHiddenBy`, em vez de acontecer em silêncio.
 */
function urlCarriesSeed(url: string | null, seed: string | null): boolean {
  if (url === null || url === '' || seed === null || seed === '') {
    return false;
  }

  return url.split(/[^0-9A-Za-z]+/).includes(seed);
}

// ============================================================
//  §2  O DESENHO
// ============================================================

/** As colunas: a agenda à esquerda, o mundo que vem à direita. */
const COLUMN = {
  leftMin: 0,
  leftMax: 0.56,
  rightMin: 0.58,
  rightMax: 1,
} as const;

/** O que fica onde, medido do topo do slot de conteúdo. */
const Y = {
  title: 30,
  section: 42,
  sectionHeight: 18,
  nextCard: 66,
  nextCardHeight: 168,
  laterSection: 246,
  laterCard: 270,
  laterCardHeight: 148,
} as const;

/** A margem de dentro dos cartões. */
const PAD = 16;

/** O lado da imagem do mapa. */
const MAP_IMAGE = 180;

/** A altura do cartão da direita: ele acompanha os dois da esquerda. */
const MAP_CARD_HEIGHT = Y.laterCard + Y.laterCardHeight - Y.nextCard;

/** O que cada origem de wipe é, em uma palavra. */
const KIND_WORDS: Readonly<Record<WipePlanKind, string>> = {
  cadence: 'cadência',
  forced: 'FORÇADO',
  manual: 'marcado à mão',
};

export interface BuildCalendarScreenOptions {
  readonly calendar: PlayerCalendar;
  /**
   * O id EXATO que foi pedido.
   *
   * Volta idêntico porque o plugin descarta a resposta cujo id não
   * bate com o que ele pediu. Ver ui-store-screens.ts.
   */
  readonly screenId?: string;
}

export function buildCalendarScreen(options: BuildCalendarScreenOptions): UiScreen {
  const { calendar } = options;

  const elements: UiElement[] = [
    label('cal-titulo', 'CALENDÁRIO', topBar(Y.title), {
      size: 20,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),

    ...section('cal-s1', 'PRÓXIMO WIPE', COLUMN.leftMin, COLUMN.leftMax, Y.section),
    panel(
      'cal-prox',
      block(COLUMN.leftMin, COLUMN.leftMax, Y.nextCard, Y.nextCardHeight),
      C.surface,
      nextWipeBody(calendar),
    ),

    ...section('cal-s2', 'DEPOIS', COLUMN.leftMin, COLUMN.leftMax, Y.laterSection),
    panel(
      'cal-depois',
      block(COLUMN.leftMin, COLUMN.leftMax, Y.laterCard, Y.laterCardHeight),
      C.surface,
      laterBody(calendar),
    ),

    ...section('cal-s3', 'O MAPA DO PRÓXIMO WIPE', COLUMN.rightMin, COLUMN.rightMax, Y.section),
    panel(
      'cal-mapa',
      block(COLUMN.rightMin, COLUMN.rightMax, Y.nextCard, MAP_CARD_HEIGHT),
      C.surface,
      mapBody(calendar),
    ),
  ];

  return {
    id: options.screenId ?? CALENDAR_SCREEN_ID,
    name: 'CALENDÁRIO',
    kind: 'page',
    elements,
  };
}

/**
 * O título de uma seção: a barra de acento e a palavra.
 *
 * O mesmo "▌ TÍTULO" do painel — é o que amarra a tela do jogo à
 * do navegador sem uma folha de estilo compartilhada.
 */
function section(
  id: string,
  text: string,
  minX: number,
  maxX: number,
  top: number,
): readonly UiElement[] {
  const bar: Rect = {
    anchorMin: { x: minX, y: 1 },
    anchorMax: { x: minX, y: 1 },
    offsetMin: { x: 0, y: -(top + Y.sectionHeight) },
    offsetMax: { x: 3, y: -top },
  };

  return [
    panel(`${id}b`, bar, C.rust),
    label(`${id}t`, text, block(minX, maxX, top, Y.sectionHeight, 10), {
      size: 12,
      align: 'MiddleLeft',
      color: C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];
}

/** Um bloco de altura fixa, ancorado no topo, entre duas colunas. */
function block(minX: number, maxX: number, top: number, height: number, left = 0): Rect {
  return {
    anchorMin: { x: minX, y: 1 },
    anchorMax: { x: maxX, y: 1 },
    offsetMin: { x: left, y: -(top + height) },
    offsetMax: { x: 0, y: -top },
  };
}

/** Uma linha de texto dentro de um cartão, medida do topo dele. */
function line(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: PAD, y: -(top + height) },
    offsetMax: { x: -PAD, y: -top },
  };
}

/**
 * O cartão do próximo wipe.
 *
 * ####  SEM AGENDA, ELE DIZ A FRASE — E NÃO ABRE VAZIO  ####
 *
 * "sem wipe agendado" é a mesma resposta que `{wipe.faltam}` dá no
 * chat (messages/providers/wipe.ts). Um cartão em branco faria o
 * jogador achar que a tela quebrou.
 */
function nextWipeBody(calendar: PlayerCalendar): readonly UiElement[] {
  const next = calendar.next;

  if (next === null) {
    return [
      label('cal-prox-t', NO_WIPE_SCHEDULED.toUpperCase(), line(PAD, 28), {
        size: 17,
        align: 'MiddleLeft',
        color: C.textMuted,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'cal-prox-x',
        'Ninguém marcou o próximo wipe deste servidor. Quando marcarem, a data aparece aqui.',
        line(PAD + 30, 22),
        { size: 12, align: 'MiddleLeft', color: C.textMuted },
      ),
    ];
  }

  const rows: ContentRow[] = [];

  // ####  O MAPA SÓ ENTRA PARA QUEM TEM DIREITO  ####
  //
  // E ele já chegou aqui recortado: `next.map` é `null` para quem
  // não alcança a régua. Não há `if` de desenho escondendo dado que
  // veio junto na payload.
  if (next.map !== null) {
    rows.push({ text: `MAPA          ${next.map}`, item: null });
  }

  rows.push({ text: `BLUEPRINTS    ${describeBpPolicy(next.bpPolicy)}`, item: null });
  rows.push({ text: `WIPE          ${KIND_WORDS[next.kind]}`, item: null });

  return [
    label(
      'cal-prox-t',
      formatWipeMoment(next.scheduledAt, calendar.timeZone).toUpperCase(),
      line(PAD, 28),
      { size: 17, align: 'MiddleLeft', font: 'RobotoCondensed-Bold.ttf' },
    ),

    label(
      'cal-prox-c',
      // O wipe que já começou continua contando: a hora marcada é a
      // do MUNDO zerando, e os avisos saem antes dela. Dizer "em
      // curso" e esconder o número tiraria do jogador exatamente o
      // que ele abriu a tela para ver.
      countdownLine(next, calendar.now),
      line(PAD + 30, 22),
      { size: 14, align: 'MiddleLeft', color: C.amber, font: 'RobotoCondensed-Bold.ttf' },
    ),

    panel(
      'cal-prox-l',
      fill(PAD, PAD + 60, PAD, PAD),
      C.none,
      itemRows(rows, Y.nextCardHeight - (PAD + 60) - PAD, 'calp'),
    ),
  ];
}

/**
 * A contagem regressiva, com a marca de quem já está executando.
 *
 * A conta é a de `{wipe.faltam}` — a mesma função, o mesmo número.
 * O que muda é a moldura: "já começou" na janela em que o passo
 * `avisar` já está falando no chat, e a hora do mundo zerando ainda
 * não chegou.
 */
function countdownLine(next: CalendarNextWipeView, now: number): string {
  const remaining = formatWipeCountdown(next.scheduledAt - now);

  if (remaining === 'agora') {
    return 'o mundo está zerando agora';
  }

  return `${next.running ? 'já começou · ' : ''}faltam ${remaining}`;
}

/** A lista do que vem depois do próximo. */
function laterBody(calendar: PlayerCalendar): readonly UiElement[] {
  // Já vem sem o próximo: quem o tirou foi `buildPlayerCalendar`,
  // pelo id do plano — e não um `slice(1)`, que dependia de o
  // primeiro da lista ser o do cartão grande. Ele não era.
  const rest = calendar.wipes;

  const rows: ContentRow[] =
    rest.length === 0
      ? [{ text: 'Depois deste, nada marcado ainda.', item: null }]
      : rest.map((wipe) => ({
          text:
            `${formatWipeMoment(wipe.scheduledAt, calendar.timeZone)} · ` +
            `${KIND_WORDS[wipe.kind]} · BP ${describeBpPolicy(wipe.bpPolicy)}` +
            // O absorvido fica, marcado: se ele sumisse, ninguém
            // entenderia a semana sem wipe.
            (wipe.absorbed ? ' · cancelado pelo forçado' : ''),
          item: null,
        }));

  return [
    panel(
      'cal-depois-l',
      fill(PAD, PAD, PAD, PAD),
      C.none,
      itemRows(rows, Y.laterCardHeight - PAD * 2, 'call'),
    ),
  ];
}

/**
 * O cartão do mundo que vem — ou o cadeado.
 *
 * ####  O CADEADO É UMA OFERTA, E NÃO UM ERRO  ####
 *
 * Quem não tem o nível lê o que ganharia com ele. Esconder a seção
 * inteira faria a vantagem de VIP não existir para quem ainda não
 * comprou — que é exatamente quem precisa vê-la.
 */
function mapBody(calendar: PlayerCalendar): readonly UiElement[] {
  if (calendar.mapsAllowed === 0) {
    return [
      label('cal-mapa-t', 'VIP PRATA VÊ O MAPA DO PRÓXIMO WIPE', line(PAD, 26), {
        size: 15,
        align: 'MiddleLeft',
        color: C.amber,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      panel(
        'cal-mapa-l',
        fill(PAD, PAD + 34, PAD, PAD),
        C.none,
        itemRows(
          [
            { text: 'PRATA: o tamanho e a imagem do mundo do próximo wipe', item: null },
            { text: 'OURO: os três próximos mundos, na ordem da fila', item: null },
            { text: 'A seed continua sendo segredo até o wipe, para todo mundo', item: null },
          ],
          MAP_CARD_HEIGHT - (PAD + 34) - PAD,
          'calm',
        ),
      ),
    ];
  }

  // ####  O MUNDO É O DO PLANO, E NÃO A CABEÇA DA FILA  ####
  //
  // Quem o escolheu foi `mapOfPlan`, em wipe/next-wipe.ts, olhando
  // o `mapSource`: `keep` responde "o mesmo mapa de agora",
  // `fixed` busca a entrada apontada, e `pool` pede à fila — que
  // num wipe FORÇADO pula o mapa custom sem marca de versão. É esta
  // a prévia que o VIP prata comprou: a do mundo que vai subir.
  const next = calendar.next;

  if (next === null || next.map === null) {
    return [
      label('cal-mapa-t', 'SEM MUNDO ESCOLHIDO', line(PAD, 26), {
        size: 15,
        align: 'MiddleLeft',
        color: C.textMuted,
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'cal-mapa-x',
        next === null
          ? 'Quando o próximo wipe for marcado, o mundo dele aparece aqui.'
          : // Sem a FRASE do mundo e com a régua alcançando o mapa:
            // `buildPlayerCalendar` não produz isso — ele só apaga a
            // frase de quem não alcança, e esse caso já saiu no
            // cadeado acima. Quem não escolheu mundo nenhum chega
            // aqui COM frase (`sorteado na hora`), e é o cartão de
            // baixo que a explica. Fica dizendo só o que se pode
            // afirmar sem inventar.
            'O mundo do próximo wipe ainda não foi anunciado.',
        line(PAD + 30, 22),
        { size: 12, align: 'MiddleLeft', color: C.textMuted },
      ),

      // ####  A FILA CONTINUA SENDO O QUE O NÍVEL COMPROU  ####
      //
      // Sem wipe à vista nada é consumido, e `buildPlayerCalendar`
      // entrega a régua inteira em `maps` — é literalmente o corpo
      // do `GET /wipe/upcoming/me`. Voltar aqui sem listar nada
      // fazia a ROTA responder três mundos ao ouro e a TELA, zero,
      // com o Docs\06-API prometendo que as duas dizem a mesma
      // coisa. Nada foi consumido, então a numeração começa no #1.
      ...queueRows(calendar, PAD + 62, 1),
    ];
  }

  const entry = next.image;
  const image = entry?.previewUrl ?? entry?.thumbUrl ?? null;

  const imageRect: Rect = {
    anchorMin: { x: 0.5, y: 1 },
    anchorMax: { x: 0.5, y: 1 },
    offsetMin: { x: -MAP_IMAGE / 2, y: -(PAD + MAP_IMAGE) },
    offsetMax: { x: MAP_IMAGE / 2, y: -PAD },
  };

  const elements: UiElement[] = [
    // Sem imagem, um retângulo vazio é honesto: ele não finge ser um
    // mundo que ninguém desenhou. A mesma escolha do card de kit sem
    // catálogo lido. O que ele DIZ depende do caso — ver
    // `missingImageNote`.
    isDrawableUrl(image)
      ? urlImage('cal-mapa-i', image, imageRect)
      : panel('cal-mapa-i', imageRect, C.surface2, [
          label('cal-mapa-in', missingImageNote(next), fill(8, 8, 8, 8), {
            size: 11,
            color: C.textMuted,
          }),
        ]),

    label('cal-mapa-t', next.map.toUpperCase(), line(PAD + MAP_IMAGE + 10, 24), {
      size: 15,
      align: 'MiddleCenter',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  ];

  // ####  O #1 É O MUNDO DO CARTÃO, QUANDO ELE SAIU DA FILA  ####
  //
  // A numeração é a ORDEM EM QUE A FILA VAI SER CONSUMIDA, e não a
  // `position` gravada em cada linha — é a mesma conta do cabeçalho
  // deste arquivo, que conta MUNDOS. Com uma entrada ainda por
  // consumir no cartão, ela é o #1 e a lista começa no #2.
  //
  // É em `fixed` que as duas leituras se separam, e a certa é esta:
  // com o plano apontando a entrada da posição 1, ela sobe primeiro
  // e a cabeça da fila sobe depois — a cabeça é o "#2 na fila"
  // porque é o segundo mundo a entrar, ainda que hoje ela seja a
  // primeira linha da lista. Numerar pela posição prometeria ao VIP
  // que o próximo mundo é um que só vem no wipe seguinte.
  //
  // Quando o cartão não segura entrada nenhuma — `keep`, ninguém
  // ter escolhido, ou o mundo JÁ consumido pelo `configurar`, que
  // saiu da fila e virou `used` —, o primeiro desta lista é o
  // próximo a ser consumido, e aí ele é o #1. O `#2` fixo dava ao
  // VIP que paga pela fila um ordinal que não existe: com `keep` e
  // a fila 4000/3500/3000, a tela chamava o 4000 de "#2 na fila"
  // sendo ele o primeiro a entrar.
  elements.push(...queueRows(calendar, PAD + MAP_IMAGE + 40, next.mapFrom === 'entry' ? 2 : 1));

  return elements;
}

/**
 * A fila atrás do cartão, numerada.
 *
 * O OURO vê a fila; a PRATA vê só o próximo. A lista aparece quando
 * há o que listar, e não como um retângulo vazio — e ela é a MESMA
 * nos dois desenhos do cartão, com wipe à vista e sem.
 */
function queueRows(calendar: PlayerCalendar, top: number, place: number): readonly UiElement[] {
  const rest = calendar.maps;

  if (rest.length === 0) {
    return [];
  }

  return [
    panel(
      'cal-mapa-l',
      fill(PAD, top, PAD, PAD),
      C.none,
      itemRows(
        rest.map((world, index) => ({
          text: `#${String(index + place)} na fila · ${describeMapEntry(world)}`,
          item: null,
        })),
        MAP_CARD_HEIGHT - top - PAD,
        'calq',
      ),
    ),
  ];
}

/**
 * Por que não há imagem — a verdade de CADA caso.
 *
 * ####  UMA FRASE SÓ MENTIA EM TRÊS DOS QUATRO  ####
 *
 * O retângulo cinza dizia sempre "a imagem deste mundo ainda não
 * ficou pronta", e isso só é verdade quando o mundo É uma entrada
 * da fila cuja prévia o RustMaps ainda está desenhando. Nos outros
 * não há prévia pendente NENHUMA:
 *
 *   · `keep`       o mundo é o que já está no ar — só a seed muda;
 *   · `world`      ele já está gravado na execução, e aí DEPENDE:
 *                  ver abaixo;
 *   · `undecided`  não há mundo escolhido do qual ter prévia.
 *
 * Prometer "ainda não ficou pronta" nesses põe o jogador para
 * esperar uma imagem que ninguém está desenhando, e manda o admin
 * procurar defeito no RustMaps.
 *
 * ####  E O `world` MENTIA NO CAMINHO CONTRÁRIO  ####
 *
 * "este mundo não saiu da fila" é falso no caso NORMAL: o
 * `configurar` grava em `map_after` o `mapPoolId` da entrada que
 * virou o mundo, e ela saiu da fila sim — está `used`, com a prévia
 * dela no mesmo lugar de sempre. O `mapFromQueue` separa esse caso
 * dos dois em que a frase é verdade: a seed SORTEADA com a fila
 * vazia, e o `keep` gravado pelo `#manterMundo`.
 */
function missingImageNote(next: CalendarNextWipeView): string {
  // A anulação por seed vem primeiro: ela é sobre uma prévia que
  // ESTÁ pronta no banco, e um "ainda não ficou pronta" por cima
  // dela manda o admin procurar no lugar errado.
  if (next.image?.imageHiddenBy === 'seed-na-url') {
    return 'a prévia foi escondida: o endereço dela carrega a seed';
  }

  switch (next.mapFrom) {
    case 'keep':
      return 'sem prévia nova: o mundo do próximo wipe é o mesmo de agora';

    case 'world':
      // Ele saiu da fila no caso normal, e aí a prévia dele é a da
      // entrada `used` — se não há imagem aqui, é porque o RustMaps
      // não a devolveu, como em qualquer outra entrada. Só o
      // sorteio da fila vazia e o `keep` nunca estiveram lá.
      return next.mapFromQueue
        ? 'a imagem deste mundo ainda não ficou pronta'
        : 'este mundo não saiu da fila, e não há prévia dele';

    case 'undecided':
      return 'o mundo ainda não foi escolhido: ele é sorteado na hora';

    default:
      return 'a imagem deste mundo ainda não ficou pronta';
  }
}

/**
 * Só `http(s)` vira imagem.
 *
 * O CUI manda a URL para o CLIENTE baixar; qualquer outra coisa ali
 * é um pedido que nunca resolve, e o jogador fica olhando um
 * quadrado vazio sem explicação nenhuma.
 */
function isDrawableUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

// ============================================================
//  §3  A LIGAÇÃO COM O RESTO DO AGENTE
// ============================================================

/**
 * A fila de mapas, só de leitura. O recorte de `MapPoolRepository`.
 *
 * `next` e `get` vêm do `WipeMapPoolReader` porque QUAL mundo entra
 * no próximo wipe é a decisão de `mapOfPlan` — a mesma que responde
 * `{wipe.mapa}` no chat —, e ela precisa das duas: `fixed` busca
 * pelo id, `pool` pede a cabeça da fila já sabendo se o wipe é
 * forçado. `list` é a fila inteira, que é o que o OURO vê atrás.
 */
export interface CalendarMapQueueReader extends WipeMapPoolReader {
  list(serverId: string): readonly MapPoolEntry[];
}

/** Quem tem VIP agora. O recorte de `VipsRepository` e do `VipList`. */
export interface CalendarVipReader {
  activeOf(steamId: string, now?: number): readonly { readonly tier: string }[];
}

export interface CalendarScreenProviderOptions {
  readonly schedule: WipeScheduleReader;
  /**
   * As execuções em curso.
   *
   * ####  SEM ISTO A TELA MENTE NO DIA DO WIPE  ####
   *
   * O "WIPAR AGORA com hora marcada" (`POST /wipe/runs` com `at`)
   * nem plano tem: só a execução sabe dele. Enquanto o chat conta
   * três horas, uma tela que só lê `wipe_plans` diz "sem wipe
   * agendado".
   */
  readonly runs: WipeRunsReader;
  readonly mapPool: CalendarMapQueueReader;
  /**
   * O mundo em que o servidor está AGORA.
   *
   * Uma pergunta só, e ela muda o que esta tela promete: um wipe
   * FORÇADO não MANTÉM um `.map` custom sem a marca de
   * compatibilidade, e sem esta leitura a tela anunciaria "o mesmo
   * mapa de agora" para um mundo que o wipe vai trocar. Ver
   * `NextWipeDeps.world`.
   */
  readonly world?: WipeCurrentWorldReader;
  readonly vips: CalendarVipReader;
  /**
   * Os níveis daquele servidor (o `OrigemZVip.json`).
   *
   * Ausente = sem hierarquia conhecida, e a comparação vira
   * igualdade de nome. A tela continua de pé: o pior que acontece é
   * um nível ainda não declarado no config não desbloquear o mapa.
   */
  readonly levelsOf?: (serverId: string) => Promise<readonly VipTierLevel[]>;
  /** O relógio, injetável para o teste. */
  readonly now?: () => number;
  /** Para registrar o que a tela não conseguiu ler. Ver o provedor. */
  readonly logger?: Logger;
}

/**
 * A forma que o `generatedScreens` do `UiSync` espera.
 *
 * Nomeada porque o index.ts guarda uma destas numa variável que
 * nasce vazia: a tela depende da agenda e da fila de mapas, que são
 * construídas depois do `UiSync`.
 */
export type CalendarScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

/**
 * A tela do calendário, montada para quem pediu.
 *
 * Devolve `null` para tudo o que não é dela — é assim que o
 * `generatedScreens` do index.ts encadeia loja, kits e calendário
 * sem que nenhum deles saiba dos outros.
 *
 * ####  ELE NÃO LANÇA PARA O ENDEREÇO QUE É DELE  ####
 *
 * Uma exceção aqui não vira erro na tela: o `UiSync` a registra e
 * cai para a tela DESENHADA do preset ("Wipes e eventos programados
 * entram aqui"). E essa tela não é `volatile` — o plugin a guarda
 * no cache do documento, e o servidor INTEIRO fica com o retângulo
 * antigo por até cinco minutos, muito depois de o banco ter voltado
 * a responder.
 *
 * Então tudo o que pode falhar (o fuso, o VIP, a agenda, a fila, o
 * `OrigemZVip.json`) é lido com rede embaixo, e o pior desfecho é
 * uma tela `volatile` dizendo o que ela não conseguiu ler — que o
 * próximo clique refaz.
 */
export function createCalendarScreenProvider(
  options: CalendarScreenProviderOptions,
): CalendarScreenProvider {
  return async (input) => {
    if (!isCalendarScreenId(input.screenId)) {
      return null;
    }

    const now = (options.now ?? Date.now)();

    const pack = (calendar: PlayerCalendar): UiScreenBundle =>
      toGeneratedScreenBundle(
        input.document,
        buildCalendarScreen({ calendar, screenId: input.screenId }),
        // O SHELL conhece `tela-calendario`: sem isto, o destaque do
        // botão CALENDÁRIO sumiria justamente ao entrar nele.
        CALENDAR_SCREEN_ID,
      );

    try {
      // ####  O NÍVEL VEM DA CONEXÃO, NUNCA DO CLIQUE  ####
      //
      // O `steamId` chega do plugin junto do pedido, tirado de quem
      // está com o menu aberto. Sem ele — plugin antigo, ou a carga
      // inicial que vai ao servidor sem jogador nenhum —, a resposta
      // é a de quem não tem VIP: negar por falta de identidade é a
      // saída conservadora.
      const tiers =
        input.steamId === undefined
          ? []
          : options.vips.activeOf(input.steamId, now).map((vip) => vip.tier);

      // Sem VIP nenhum não há hierarquia a consultar, e ler o config
      // do plugin seria ir ao disco para confirmar um zero.
      const levels = tiers.length === 0 ? [] : ((await options.levelsOf?.(input.serverId)) ?? []);

      // A MESMA decisão que responde `{wipe.faltam}` no chat. Ver
      // wipe/next-wipe.ts.
      const next = nextWipe(input.serverId, options, now);

      const calendar = buildPlayerCalendar({
        now,
        timeZone: next?.timeZone ?? zoneOfServer(options, input.serverId),
        next,
        plans: options.schedule.listPlans(input.serverId, { from: now }),
        queue: options.mapPool.list(input.serverId),
        tiers,
        levels,
      });

      for (const map of [calendar.next?.image ?? null, ...calendar.maps]) {
        if (map?.imageHiddenBy === 'seed-na-url') {
          options.logger?.warn(
            { server: input.serverId, world: map.level, size: map.worldSize },
            'a prévia deste mundo não foi enviada: o endereço dela carrega a seed',
          );
        }
      }

      return pack(calendar);
    } catch (error) {
      options.logger?.error(
        { server: input.serverId, err: toError(error) },
        'não consegui montar a página CALENDÁRIO; mando a tela vazia, que não fica em cache',
      );

      // Vazia, mas NOSSA: `volatile`, e por isso o próximo clique
      // tenta de novo. A do documento ficaria colada por minutos.
      return pack(emptyCalendar(now));
    }
  };
}

/**
 * A página CALENDÁRIO sem nada dentro, empacotada e VOLÁTIL.
 *
 * ####  ELA EXISTE PARA NÃO CAIR NA TELA DO PRESET  ####
 *
 * O `generatedScreens` do index.ts guarda o provedor numa variável
 * que nasce vazia — a agenda e a fila de mapas são construídas
 * depois do `UiSync`. Se por qualquer motivo o pedido chegar antes
 * de ela ser preenchida, o `UiSync` serviria a tela DESENHADA do
 * preset ("Wipes e eventos programados entram aqui"), que NÃO é
 * volátil: o plugin a guarda no cache do documento e o servidor
 * inteiro fica com o retângulo antigo por até cinco minutos.
 *
 * Esta aqui some no clique seguinte.
 */
export function buildEmptyCalendarBundle(
  document: UiDocument,
  screenId: string,
  now: number = Date.now(),
): UiScreenBundle {
  return toGeneratedScreenBundle(
    document,
    buildCalendarScreen({ calendar: emptyCalendar(now), screenId }),
    CALENDAR_SCREEN_ID,
  );
}

function emptyCalendar(now: number): PlayerCalendar {
  return {
    now,
    timeZone: 'UTC',
    tier: null,
    mapsAllowed: 0,
    next: null,
    wipes: [],
    maps: [],
  };
}

/** O fuso da agenda, sem derrubar a tela quando o banco não responde. */
function zoneOfServer(options: CalendarScreenProviderOptions, serverId: string): string {
  try {
    return options.schedule.getSettings(serverId).cadence.timeZone;
  } catch {
    return 'UTC';
  }
}
