// ============================================================
//  ranking/labels.ts  -  o vocabulário do ranking, em português.
//
//  ####  POR QUE UM ARQUIVO SÓ PARA RÓTULO  ####
//
//  Cinco telas falam das mesmas coisas — a janela, a fonte, o modo
//  da temporada, o estado da coleta. Repetir o mapa em cada uma
//  daria "de sempre" numa tela e "vitalício" na outra para o mesmo
//  `lifetime`, e quem administra passaria a achar que são dois
//  conceitos.
//
//  ####  E A FORMATAÇÃO DO VALOR MORA AQUI PELO MESMO MOTIVO  ####
//
//  O número do ranking não é sempre um inteiro: tempo online é
//  duração, tiro longo é medida com casas, K/D é razão. A tabela
//  da lista, o pódio congelado do histórico e a ficha do servidor
//  precisam mostrar o MESMO número do mesmo jeito.
// ============================================================

import { EM_DASH, formatDuration, formatInteger } from '@/lib/format';
import type {
  RankingCoverageServer,
  RankingCoverageStatus,
  RankingDefinition,
  RankingPeriodKind,
  RankingSeasonMode,
  RankingSource,
  RankingValueKind,
} from '@/lib/api';

/** A janela em que o ranking DISPUTA. Ver Docs/Ranking/20 §3.1. */
export const WINDOW_LABELS: Record<RankingPeriodKind, string> = {
  wipe: 'Wipe',
  season: 'Temporada',
  lifetime: 'De sempre',
};

/** O que a virada daquela janela faz com o ranking. */
export const WINDOW_HINTS: Record<RankingPeriodKind, string> = {
  wipe: 'zera quando o mundo zera',
  season: 'atravessa os wipes e só zera quando a temporada fecha',
  lifetime: 'nunca zera',
};

export const SOURCE_LABELS: Record<RankingSource, string> = {
  plugin: 'Plugin (hook do jogo)',
  agent: 'Agente (calculado aqui)',
  item: 'Item custom (ação de pontos)',
  computed: 'Derivado de outras métricas',
};

export const VALUE_KIND_LABELS: Record<RankingValueKind, string> = {
  counter: 'Contador (soma)',
  record: 'Recorde (o melhor, com testemunho)',
  ratio: 'Razão (calculada na leitura)',
};

export const SEASON_MODE_LABELS: Record<RankingSeasonMode, string> = {
  wipe: 'A cada wipe',
  biweekly: 'A cada 15 dias',
  monthly: 'Mensal (vira no dia 1)',
  quarterly: 'Trimestral (jan, abr, jul, out)',
  days: 'A cada N dias',
  manual: 'Só na mão',
};

/**
 * O estado da coleta, e é ele que separa "zero" de "sem dados".
 *
 * Um servidor em `not-loaded` que virasse lista vazia diria que
 * ninguém pontuou ali — uma afirmação sobre os jogadores, quando a
 * verdade é sobre a coleta.
 *
 * ####  SÃO QUATRO, E `never` NÃO É DEFEITO  ####
 *
 * `never` é o servidor que está aí e ainda não recebeu lote
 * nenhum daquele ranking. Ele existia escondido dentro do
 * `no-answer`, e a tela dizia "a coleta não responde há um tempo"
 * de uma coleta que nunca aconteceu — mandando o admin caçar uma
 * falha inexistente.
 *
 * Estes rótulos são a ETIQUETA CURTA do chip, e não a explicação:
 * a explicação vem pronta da API, no campo `message`. Ver
 * `coverageSentence`.
 */
export const COVERAGE_LABELS: Record<RankingCoverageStatus, string> = {
  ok: 'medindo',
  never: 'ainda não mediu',
  'not-loaded': 'não estava medindo',
  'no-answer': 'não respondeu',
};

/**
 * Este estado é um PROBLEMA, ou só uma informação?
 *
 * `never` é informativo: nada quebrou, a primeira coleta ainda
 * não chegou. Os outros dois são falha de verdade — e é essa
 * separação que decide se a tela mostra um aviso de coleta
 * parada ou uma linha discreta.
 */
export function isCoverageFault(status: RankingCoverageStatus): boolean {
  return status === 'no-answer' || status === 'not-loaded';
}

/**
 * A frase daquele servidor: o id dele, e o aviso que a API mandou.
 *
 * ####  O TEXTO NÃO É ESCRITO AQUI  ####
 *
 * `message` vem do core (`rankings/service.ts`), que é o mesmo
 * lugar de onde a tela do JOGO tira a dela. Escrever a segunda
 * versão aqui faria o admin e o jogador lerem histórias
 * diferentes sobre o mesmo defeito no primeiro ajuste de texto.
 *
 * O que esta função acrescenta é só DE QUEM se está falando: a
 * frase do core vale para um servidor, e a tela lista vários.
 *
 * `null` quando não há o que avisar — é o caso do `ok`.
 */
export function coverageSentence(server: RankingCoverageServer): string | null {
  if (server.status === 'ok') {
    return null;
  }

  // Agente antigo, sem o campo: sobra a etiqueta curta. Ela diz
  // menos, mas não inventa uma explicação que talvez esteja errada.
  const message = server.message ?? COVERAGE_LABELS[server.status];

  return `${server.serverId}: ${message}`;
}

/**
 * O ranking conta tempo? Aí o número é duração, e não unidade.
 *
 * Quem mostra a coluna precisa saber: "Tempo online (segundos)" no
 * cabeçalho, com "3d 4h" nas linhas, é um cabeçalho que desmente a
 * tabela.
 */
export function isDurationRanking(ranking: RankingDefinition): boolean {
  return ranking.metric === 'time.played' || ranking.unit === 'segundos';
}

/**
 * O valor de uma linha, do jeito daquele ranking.
 *
 * Ausente vira travessão, nunca zero — a regra da casa
 * (`lib/format.ts`).
 */
export function formatRankingValue(
  ranking: RankingDefinition,
  value: number | null | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EM_DASH;
  }

  if (isDurationRanking(ranking)) {
    return formatDuration(value);
  }

  if (ranking.valueKind === 'ratio') {
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  if (ranking.valueKind === 'record') {
    const number = value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

    return ranking.unit === null ? number : `${number} ${ranking.unit}`;
  }

  const number = formatInteger(value);

  return ranking.unit === null ? number : `${number} ${ranking.unit}`;
}

/**
 * Quanto FALTA: "em 12 dias", "em 3 h", "em 40 min".
 *
 * ####  POR QUE NÃO DÁ PARA USAR `formatWhen` AQUI  ####
 *
 * Ele é para o PASSADO: uma data futura cai no ramo "menos de um
 * minuto" e vira "agora" — uma temporada que vence daqui a três
 * semanas apareceria como se estivesse virando neste segundo.
 */
export function formatUntil(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return EM_DASH;
  }

  const at = Date.parse(value);

  if (!Number.isFinite(at)) {
    return EM_DASH;
  }

  const seconds = Math.round((at - Date.now()) / 1000);

  // Vencida e ainda aberta: quem vira é o sweep do coletor, na
  // próxima rodada de 60 s.
  if (seconds <= 0) {
    return 'a qualquer momento';
  }

  if (seconds < 3_600) {
    return `em ${String(Math.max(1, Math.floor(seconds / 60)))} min`;
  }

  if (seconds < 86_400) {
    return `em ${String(Math.floor(seconds / 3_600))} h`;
  }

  return `em ${String(Math.floor(seconds / 86_400))} dias`;
}

/** "Temporada de setembro" — ou, sem rótulo, o id e o tipo. */
export function periodTitle(period: {
  readonly id: number;
  readonly kind: RankingPeriodKind;
  readonly label: string | null;
}): string {
  return period.label ?? `${WINDOW_LABELS[period.kind]} #${String(period.id)}`;
}
