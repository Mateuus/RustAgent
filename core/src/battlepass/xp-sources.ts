// ============================================================
//  xp-sources.ts  -  O CARDÁPIO: o que o agente sabe medir, e que
//  por isso pode dar XP.
//
//  ####  POR QUE ELE MORA AQUI, E NÃO NO PAINEL  ####
//
//  "O que vai dar XP o administrador vai administrar isso" (o dono,
//  17/09/2026). Então a lista precisa ser OFERECIDA, e quem a
//  oferece tem de ser quem mede — senão o painel oferece "saquear
//  caixa", o admin liga, precifica, e nada acontece. Em silêncio.
//
//  Não é hipótese: em 16/09/2026 o ranking "Madeira" nasceu com a
//  métrica `farm.madeira`, ligado e visível, e ficou parado em zero
//  depois de uma árvore inteira — nenhum hook alimentava aquela
//  chave. A resposta do projeto foi `rankings/plugin-metrics.ts`,
//  que RECUSA ao salvar. Este arquivo é a mesma resposta para o XP.
//
//  A fonte de verdade das chaves de ação é o `FIXED_PLUGIN_METRICS`
//  daquele arquivo, importado aqui de propósito: uma segunda cópia
//  divergiria na primeira métrica nova, e a que ficasse para trás
//  seria a que o admin vê.
//
//  ####  DUAS TORNEIRAS E UM EVENTO  ####
//
//  `feed` diz de onde o XP daquela fonte chega, e as duas formas não
//  se parecem:
//
//    batch  vem do delta acumulado de 60 s do plugin, sem
//           identificador de ocorrência. Rende `amount` × unidades,
//           dentro da transação que aplica o lote.
//    event  chega uma vez, com identificador. O valor é de quem
//           concede (a missão diz quanto vale), e a regra serve para
//           desligar e para o teto.
//
//  ####  ALGUMAS DELAS FAZEM MAIS SENTIDO TIRANDO XP  ####
//
//  Desde 18/09/2026 o `amount` da regra aceita valor NEGATIVO
//  (types/battlepass.ts), e foi o dono quem pediu: "permitir não
//  ganhar xp caso matar colega de equipe, ou ganhar xp negativa".
//
//  Abater colega de equipe, se matar e morrer são justamente as
//  fontes cuja versão POSITIVA é um moedor — dois amigos em rodízio
//  rendem o dia inteiro. Com sinal negativo elas viram o contrário:
//  um custo. A `note` de cada uma diz isso, porque é a única coisa
//  que o admin lê antes de escolher o número.
//
//  O que NÃO muda: elas continuam nascendo DESLIGADAS. O cardápio
//  oferece; quem liga — e quem decide o sinal — é o administrador.
//
//  ####  O QUE FICOU DE FORA, E POR QUÊ  ####
//
//    shot.distance   é RECORDE, não contador: ele chega em
//                    `records` com a distância do tiro. Multiplicar
//                    412,73 m por XP por unidade não quer dizer
//                    nada.
//    time.played     só cresce quando a SESSÃO FECHA: quem está
//                    online há três horas tem o número de ontem
//                    (02 §9). XP por tempo pede outra fonte.
//    gather.<nome>   só é contada se existir um RANKING habilitado
//                    com ela (`plugin-metrics.ts`, `gatherShortnamesOf`).
//                    O XP de farm morreria no dia em que o admin
//                    desligasse o ranking "Madeira", sem nada
//                    acusando. Use `ore.*`, que não depende de nada.
//                    Quando o passe declarar a própria lista de
//                    vigia, ela volta — com teste.
//    quest.completed a conclusão de qualquer missão. Não há quem a
//                    credite hoje, e uma fonte no cardápio sem quem
//                    a alimente é exatamente o `farm.madeira` de
//                    novo. O que existe é `quest.reward`: a missão
//                    diz quanto vale.
// ============================================================

import { FIXED_PLUGIN_METRICS } from '../rankings/plugin-metrics.js';

/** De onde o XP daquela fonte chega ao agente. Ver o cabeçalho. */
export const XP_SOURCE_FEEDS = ['batch', 'event'] as const;
export type XpSourceFeed = (typeof XP_SOURCE_FEEDS)[number];

/** Um item do cardápio, como o painel o recebe. */
export interface XpSource {
  /** A chave da métrica: é ela que vira `battlepass_xp_rules.source`. */
  readonly source: string;
  /** O que o admin lê na lista. Português. */
  readonly label: string;
  /** O agrupamento da tela: "PvP", "Minério"… */
  readonly group: string;
  readonly feed: XpSourceFeed;
  /**
   * O que a fonte conta — "abate", "unidade de minério".
   *
   * O valor da regra é POR UNIDADE, e sem esta palavra o admin não
   * sabe se está pagando por foguete ou por enxofre.
   */
  readonly unit: string;
  /**
   * Nasce ligada numa temporada nova?
   *
   * `sleeper.kills` é o caso que obrigou o campo: ele paga quem anda
   * de machado por base vazia, e a matriz de morte do plugin o
   * separa do K/D justamente por isso. O cardápio OFERECE; a
   * configuração padrão não liga.
   */
  readonly defaultEnabled: boolean;
  /** O aviso que muda a decisão do admin. `null` = não há. */
  readonly note: string | null;
}

/**
 * A fonte do XP que uma MISSÃO promete.
 *
 * O nome é `quest.reward` e não `quest.completed` porque as duas
 * coisas são diferentes: esta é "a missão pagou o que ela prometia",
 * e só existe quando a missão tem uma recompensa `kind: 'xp'`.
 */
export const QUEST_XP_SOURCE = 'quest.reward';

/**
 * O cardápio, em ordem de tela.
 *
 * Os rótulos são os dos rankings que a migração 033 já semeou
 * ("Abates", "Enxofre"): o admin lê a mesma palavra nas duas telas,
 * e não duas traduções da mesma métrica.
 */
export const XP_SOURCES: readonly XpSource[] = [
  {
    source: QUEST_XP_SOURCE,
    label: 'Missão concluída',
    group: 'Missões',
    feed: 'event',
    unit: 'missão',
    defaultEnabled: true,
    note:
      'O valor é o que cada missão promete na recompensa de XP — a regra aqui só liga, ' +
      'desliga e limita o dia. É a fonte prioritária: a única que chega como evento, uma vez.',
  },

  {
    source: 'pvp.kills',
    label: 'Abater jogador',
    group: 'PvP',
    feed: 'batch',
    unit: 'abate',
    defaultEnabled: true,
    note: null,
  },
  {
    source: 'pvp.deaths',
    label: 'Morrer para jogador',
    group: 'PvP',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'Pagar por morrer premia quem se deixa matar. Se ligar, ponha teto. ' +
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },

  {
    source: 'pve.kills',
    label: 'Abater NPC',
    group: 'PvE',
    feed: 'batch',
    unit: 'abate',
    defaultEnabled: true,
    note:
      'Só conta quem herda de BasePlayer — científico, morador. Lobo, urso, ' +
      'helicóptero e Bradley NÃO contam aqui.',
  },
  {
    source: 'pve.deaths',
    label: 'Morrer para NPC',
    group: 'PvE',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },

  {
    source: 'env.deaths',
    label: 'Morrer para o mundo',
    group: 'Morte',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },
  {
    source: 'suicides',
    label: 'Suicídio',
    group: 'Morte',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'O `kill` do console é de graça e sem espera: ligado sem teto, isto é um moedor. ' +
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },

  {
    source: 'team.kills',
    label: 'Abater colega de equipe',
    group: 'Fora do K/D',
    feed: 'batch',
    unit: 'abate',
    defaultEnabled: false,
    note:
      'Dois jogadores da mesma equipe se matando em rodízio rendem o dia inteiro — foi ' +
      'por esta fonte que o XP negativo foi pedido. Faz sentido como PENALIDADE: com ' +
      'valor negativo ela tira XP em vez de dar. O XP para em zero, e o nível não desce.',
  },
  {
    source: 'team.deaths',
    label: 'Morrer para colega de equipe',
    group: 'Fora do K/D',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },
  {
    source: 'sleeper.kills',
    label: 'Abater dorminhoco',
    group: 'Fora do K/D',
    feed: 'batch',
    unit: 'abate',
    defaultEnabled: false,
    note:
      'Isto é farm, e não PvP: paga quem anda de machado por base vazia. ' +
      'O plugin o separa do K/D justamente por isso.',
  },
  {
    source: 'sleeper.deaths',
    label: 'Morrer dormindo',
    group: 'Fora do K/D',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },
  {
    source: 'trap.kills',
    label: 'Abate por armadilha',
    group: 'Fora do K/D',
    feed: 'batch',
    unit: 'abate',
    defaultEnabled: false,
    note: null,
  },
  {
    source: 'trap.deaths',
    label: 'Morrer em armadilha',
    group: 'Fora do K/D',
    feed: 'batch',
    unit: 'morte',
    defaultEnabled: false,
    note:
      'Faz sentido como PENALIDADE: com valor negativo ela tira XP em vez de dar. ' +
      'O XP para em zero, e o nível não desce.',
  },

  {
    source: 'ore.total',
    label: 'Minério (tudo somado)',
    group: 'Minério',
    feed: 'batch',
    unit: 'unidade',
    defaultEnabled: false,
    note:
      'O plugin soma cada minério AQUI e na chave dele: ligar esta junto com enxofre, ' +
      'metal, pedra ou HQM paga a mesma pedrada duas vezes.',
  },
  {
    source: 'ore.sulfur',
    label: 'Enxofre',
    group: 'Minério',
    feed: 'batch',
    unit: 'unidade',
    defaultEnabled: true,
    note: 'Uma pedrada rende dezenas de unidades: o valor por unidade é fração, e o teto é o que segura.',
  },
  {
    source: 'ore.metal',
    label: 'Metal',
    group: 'Minério',
    feed: 'batch',
    unit: 'unidade',
    defaultEnabled: true,
    note: null,
  },
  {
    source: 'ore.stone',
    label: 'Pedra',
    group: 'Minério',
    feed: 'batch',
    unit: 'unidade',
    defaultEnabled: false,
    note: null,
  },
  {
    source: 'ore.hqm',
    label: 'Metal de alta qualidade',
    group: 'Minério',
    feed: 'batch',
    unit: 'unidade',
    defaultEnabled: true,
    note: null,
  },

  {
    source: 'explosive.seq',
    label: 'Explosivo fabricado',
    group: 'Craft',
    feed: 'batch',
    unit: 'enxofre',
    defaultEnabled: false,
    note:
      'A unidade é o ENXOFRE que o explosivo custou, e não a peça: um foguete são ' +
      'cerca de 1.400. O valor por unidade é fração, e sem teto isto é uma raid inteira em níveis.',
  },
];

const BY_SOURCE = new Map(XP_SOURCES.map((item) => [item.source, item]));

/** O item do cardápio, ou `null` quando aquela chave não é uma fonte. */
export function xpSourceOf(source: string): XpSource | null {
  return BY_SOURCE.get(source) ?? null;
}

/** As fontes que vêm do delta do plugin — as que o lote credita. */
export function isBatchXpSource(source: string): boolean {
  return BY_SOURCE.get(source)?.feed === 'batch';
}

/**
 * Por que esta chave não pode dar XP. `null` = pode.
 *
 * A frase existe para o admin, e por isso ela diz o MOTIVO de cada
 * ausência conhecida em vez de "fonte inválida": as três que ele vai
 * tentar são justamente as que o cardápio recusa de propósito.
 *
 * É o mesmo papel do `whyNotPluginMetric` no ranking, e o mesmo
 * lugar: a recusa é na porta de gravar, e não na tela.
 */
export function whyNotXpSource(source: string): string | null {
  if (BY_SOURCE.has(source)) {
    return null;
  }

  const hint = REFUSALS[source] ?? refusalOf(source);

  return (
    `"${source}" não dá XP: o agente não mede isso, e a regra ficaria parada em zero ` +
    `sem nada avisando.${hint === null ? '' : ` ${hint}`} As fontes que existem são ` +
    `${XP_SOURCES.map((item) => item.source).join(', ')}.`
  );
}

/** As ausências que têm explicação própria. Ver o cabeçalho. */
const REFUSALS: Readonly<Record<string, string>> = {
  'shot.distance':
    'O tiro mais longo é um recorde, e não um contador: não há "quantas vezes" para multiplicar.',
  'time.played':
    'O tempo online só cresce quando a sessão FECHA — quem está online há três horas tem o número de ontem.',
  'quest.completed': `Para o XP de missão a fonte é "${QUEST_XP_SOURCE}", e o valor vai na recompensa de cada missão.`,
};

function refusalOf(source: string): string | null {
  if (source.startsWith('gather.')) {
    return (
      'A coleta por shortname só é contada enquanto existir um ranking ligado com ela, ' +
      'e o XP morreria no dia em que esse ranking fosse desligado. Use as chaves "ore.*".'
    );
  }

  // Ela é métrica do plugin, mas não está no cardápio: é o caso de
  // alguém ter acrescentado uma chave nova lá e esquecido daqui. A
  // frase diz isso em vez de fingir que a métrica não existe.
  return FIXED_PLUGIN_METRICS.includes(source)
    ? 'O plugin conta essa chave, mas ela ainda não foi avaliada como fonte de XP.'
    : null;
}
