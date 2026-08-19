// ============================================================
//  plugin-data.ts  -  O FULL WIPE, e por que ele é uma LISTA LIDA
//  DO DISCO.
//
//  ####  NUNCA `del *.json`  ####
//
//  O `OrigemZVip.json` é o VIP que alguém pagou; o
//  `OrigemZStore.json` é a carteira. Um full wipe indiscriminado
//  não devolve servidor novo: devolve chargeback. Por isso nada
//  aqui apaga por curinga, e NADA VEM MARCADO por padrão — este
//  módulo só LISTA o que existe, com tamanho e data, e a escolha
//  é do admin, item a item.
//
//  ------------------------------------------------------------
//  ####  A ESCOLHA FICA SALVA; O QUE SUMIU DO DISCO TAMBÉM  ####
//
//  A lista salva é de PADRÕES (globs), não de arquivos achados
//  naquele dia. Se `Economics.json` não estava lá quando o admin
//  abriu a tela, ele volta a aparecer no mês em que o plugin for
//  reinstalado — e continua marcado. O caminho contrário (apagar a
//  escolha porque o arquivo não estava lá) é como se perde uma
//  configuração em silêncio, e só se descobre depois do wipe que
//  não levou o que devia.
//
//  Por isso `listPluginData` devolve TRÊS coisas: o que existe, o
//  que está marcado, e os padrões marcados que hoje não casam com
//  nada (`missing`).
//
//  ------------------------------------------------------------
//  ####  A TELA E O PURGE FAZEM PERGUNTAS DIFERENTES  ####
//
//  `listPluginData` responde O QUE MOSTRAR: ela ordena, corta em
//  `MAX_FILES` e diz que cortou (`truncated`, `total`).
//  `resolvePluginDataTargets` responde O QUE APAGAR, e não passa
//  pelo corte.
//
//  As duas leem o disco pela MESMA varredura (`scanPluginData`),
//  porque duas varreduras seriam duas verdades sobre a mesma pasta.
//  O que elas não compartilham é o teto — um limite que existe para
//  a tela caber virava, do outro lado, arquivo não apagado em
//  silêncio.
//
//  E o que a varredura NÃO olhou também sai escrito: as pastas
//  fundas demais voltam em `notScanned`.
//
//  ------------------------------------------------------------
//  ####  O SATÉLITE NÃO É UMA ESCOLHA  ####
//
//  `clans.287.db` e `clans.287.db-wal` são UMA linha, a do banco,
//  com o satélite em `companions`. Marcar a linha leva o par; um
//  padrão que casa só com o satélite marca a linha do banco.
//
//  Solto, o par se quebrava nos dois sentidos: levar só o `.db`
//  deixa um WAL órfão, e levar só o `-wal` deixa um banco que
//  reabre SEM ERRO NENHUM trazendo apenas o que já tinha sido
//  checkpointado — perda silenciosa num arquivo que o wipe tinha a
//  obrigação de preservar. Ver SIDECAR em save-files.ts.
//
//  ------------------------------------------------------------
//  ####  DOIS LUGARES, E SÓ ELES  ####
//
//      Servers\<id>\server\<identity>\*.db     o que o wipe de
//                                              mapa/BP não leva
//      Servers\<id>\oxide\data\**\*.json       o estado dos plugins
//
//  O primeiro pega `clans.287.db`, `player.states.287.db` e
//  companhia: arquivos que save-files.ts classifica como "fica" e
//  que, num full wipe, o admin pode querer levar. O que já vai
//  sumir pela política NÃO aparece aqui — oferecer duas vezes o
//  mesmo arquivo faria a tela sugerir que desmarcá-lo o salvaria.
//
//  ####  E OS `.data` DO OXIDE FICAM DE FORA  ####
//
//  `oxide.groups.data`, `oxide.users.data` e `oxide.covalence.data`
//  não são estado de plugin: são as PERMISSÕES do servidor — os
//  grupos de VIP, os admins. Apagá-los tira o VIP de todo mundo
//  sem que uma linha da tela diga isso. Quem quiser mexer neles
//  mexe pelo Oxide, não por um efeito colateral de wipe.
// ============================================================

import { stat, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

import { classifyFile, sidecarOwner } from './save-files.js';
import type { BpPolicy } from '../types/wipe.js';

/** Onde o arquivo mora, para a tela agrupar e o texto explicar. */
export type PluginDataArea = 'save' | 'oxide';

/** Um candidato do full wipe: existe em disco, e o admin decide. */
export interface PluginDataFile {
  /**
   * O caminho RELATIVO à pasta do servidor, com `/` — é ele que
   * vai para a lista salva, e é ele que o purge casa.
   *
   * Barra normal mesmo no Windows: a lista salva atravessa JSON,
   * banco e tela, e uma contrabarra em JSON é uma escapada a mais
   * para alguém errar.
   */
  readonly path: string;
  readonly area: PluginDataArea;
  /** O tamanho da LINHA: o arquivo mais os satélites dele. */
  readonly bytes: number;
  /** Epoch ms (inteiro) da última alteração. Responde "isso ainda é usado?". */
  readonly modifiedAt: number;
  /**
   * Os satélites que somem JUNTO com este arquivo — `-wal`, `-shm`,
   * `-journal` —, em caminho relativo, como `path`.
   *
   * Eles não são linha própria na tela: ver SIDECAR, lá embaixo.
   * Marcar esta linha marca o conjunto, e o purge leva o conjunto.
   */
  readonly companions: readonly string[];
  /** O admin marcou este padrão. */
  readonly selected: boolean;
  /**
   * Os padrões DA LISTA SALVA que marcam esta linha.
   *
   * ####  SEM ELES A TELA NÃO TEM COMO DESMARCAR  ####
   *
   * A linha é um arquivo; a lista salva é de PADRÕES. Enquanto a
   * tela tirava `file.path` da lista, ela só sabia desmarcar o que
   * tivesse sido marcado por um padrão IGUAL ao caminho — e a
   * marca também vem do satélite (`...db-wal`, salvo antes de o par
   * andar junto) e de um glob.
   *
   * MEDIDO com a lista `['server/server01/clans.287.db-wal']`: a
   * tela abria com a linha do BANCO marcada, o clique de desmarcar
   * devolvia a lista idêntica, a tela recarregava marcada, e o
   * purge levava o par. A única caixa que removia aquele padrão —
   * a do próprio `-wal` — tinha deixado de existir.
   *
   * Com isto, o clique tira da lista exatamente o que marcou a
   * linha, e a tela pode DIZER o que vai remover antes do clique.
   */
  readonly selectedBy: readonly string[];
}

/** O que o full wipe levaria, e o que ele não acha mais. */
export interface PluginDataListing {
  /**
   * O que a TELA mostra — no máximo `MAX_FILES` linhas.
   *
   * ####  ISTO NÃO É O QUE O WIPE APAGA  ####
   *
   * Quem apaga é `resolvePluginDataTargets`, e ele varre o disco de
   * novo, inteiro, sem teto. Ver o comentário de `MAX_FILES`.
   */
  readonly files: readonly PluginDataFile[];
  /**
   * Padrões marcados que hoje não casam com arquivo nenhum, E que
   * a varredura teria visto se existissem.
   *
   * Eles CONTINUAM na lista salva. Ver o cabeçalho.
   *
   * O "teria visto" é a metade que faltava: sem ele, um padrão
   * apontando para dentro de uma pasta funda demais entrava aqui, e
   * a tela dizia que o arquivo não existe mais em disco. Ele
   * existe, e continua existindo depois do wipe. Ver `maybeTooDeep`.
   */
  readonly missing: readonly string[];
  /**
   * Padrões marcados que não casaram com nada VISTO, e que podem
   * estar dentro de uma pasta que a varredura não desceu.
   *
   * Não é `missing` e não é achado: é "não olhei". O full wipe não
   * vai levar o que estiver ali, e é isso que a tela precisa dizer
   * — o contrário, "apagar num arquivo que não está lá é sucesso",
   * é um tranquilizador sobre um arquivo que está lá.
   */
  readonly maybeTooDeep: readonly string[];
  /** Quantas linhas existem de verdade, antes do corte da tela. */
  readonly total: number;
  /** `true` quando `files` é um pedaço de `total`. A tela precisa DIZER. */
  readonly truncated: boolean;
  /**
   * As pastas de `oxide\data` que a varredura NÃO desceu, por causa
   * de `MAX_OXIDE_DEPTH`.
   *
   * Vazio é a resposta normal. Não-vazio quer dizer "existe coisa
   * mais funda que eu não olhei" — e um full wipe que cala isso
   * deixa arquivo para trás sem ninguém saber.
   */
  readonly notScanned: readonly string[];
}

export interface PluginDataOptions {
  /** `ServerConfig.paths.installDir`. */
  readonly installDir: string;
  /** `SERVER_IDENTITY` — a pasta do save chama-se assim. */
  readonly identity: string;
  /** Os padrões que o admin marcou, como vieram de `wipe_settings`. */
  readonly selected?: readonly string[];
  /**
   * A política do wipe que está sendo montado.
   *
   * Ela é a peneira: o que a política já apaga não é oferecido
   * aqui. Ver o cabeçalho.
   */
  readonly bpPolicy?: BpPolicy;
}

/** Quantos níveis de subpasta o `oxide\data` é varrido. */
const MAX_OXIDE_DEPTH = 3;

/**
 * Teto de linhas que a TELA recebe — e SÓ a tela.
 *
 * ####  UM TETO DE APRESENTAÇÃO NUNCA DECIDE O QUE SOME  ####
 *
 * `oxide\data` de um servidor antigo tem milhares de `.json` por
 * jogador (um por plugin, por SteamID). Devolver todos derrubaria a
 * tela e não ajudaria ninguém a escolher.
 *
 * MEDIDO, quando este corte valia também para o purge: 600 arquivos
 * casando com o padrão marcado, a lista devolveu 500, o passo
 * `apagar` gravou "500 de plugin" e 100 arquivos que o admin mandou
 * apagar continuaram lá. Sem `missing`, sem impedimento, sem aviso
 * — porque o padrão CASOU, e o que faltou foi o corte da tela.
 *
 * Por isso `resolvePluginDataTargets` não passa por aqui: ele varre
 * o disco de novo e leva tudo o que casa. E quando o corte acontece,
 * `truncated` e `total` obrigam a tela a dizer que cortou.
 */
const MAX_FILES = 500;

/**
 * O que existe de VERDADE, hoje, nos dois lugares.
 *
 * Só leitura: nada aqui apaga, e por isso ela é segura de chamar a
 * cada abertura de tela, com o servidor no ar e cheio de gente.
 */
export async function listPluginData(options: PluginDataOptions): Promise<PluginDataListing> {
  const selected = options.selected ?? [];
  const scan = await scanPluginData(options);

  // O marcado primeiro (é o que o admin veio conferir), depois o
  // maior — o que ocupa disco é o que motiva um full wipe.
  const files = [...scan.files].sort((a, b) => {
    if (a.selected !== b.selected) {
      return a.selected ? -1 : 1;
    }

    return b.bytes - a.bytes;
  });

  const shown = files.slice(0, MAX_FILES);

  // Um padrão que só casa com o satélite de alguém NÃO está
  // faltando: a linha dele existe, com o nome do banco.
  const unmatched = selected.filter(
    (pattern) => !files.some((file) => matchesFile(file, [pattern])),
  );

  // ####  "NÃO ACHEI" E "NÃO OLHEI" NÃO SÃO A MESMA COISA  ####
  //
  // O que pode estar dentro de uma pasta funda demais sai de
  // `missing`: dizer que ele "não existe mais em disco" é o oposto
  // da verdade. Ver `couldMatchUnder`.
  const maybeTooDeep = unmatched.filter((pattern) =>
    scan.notScanned.some((dir) => couldMatchUnder(dir, pattern)),
  );

  return {
    files: shown,
    missing: unmatched.filter((pattern) => !maybeTooDeep.includes(pattern)),
    maybeTooDeep,
    total: files.length,
    truncated: files.length > shown.length,
    notScanned: scan.notScanned,
  };
}

/**
 * Os caminhos que o passo `apagar` deve levar, já resolvidos
 * contra o disco.
 *
 * ####  SEM TETO, DE PROPÓSITO  ####
 *
 * Esta função NÃO chama `listPluginData`: aquela corta em
 * `MAX_FILES` para a tela caber, e um limite de apresentação que
 * chega até aqui vira arquivo não apagado em silêncio. Ver
 * `MAX_FILES`.
 *
 * O purge só apaga o que casa com a lista salva: um padrão que
 * casa com nada some da resposta em silêncio, e é o certo — o
 * arquivo não estar lá é o desfecho que o full wipe queria.
 */
export async function resolvePluginDataTargets(options: PluginDataOptions): Promise<readonly string[]> {
  const scan = await scanPluginData(options);
  const targets: string[] = [];

  for (const file of scan.files) {
    if (!file.selected) {
      continue;
    }

    // O satélite vai junto, sempre: o `-wal` sozinho ao lado de um
    // banco recriado ressuscita parte do mundo apagado, e o banco
    // sozinho sem o `-wal` reabre sem erro nenhum trazendo só o que
    // já tinha sido checkpointado. Ver SIDECAR em save-files.ts.
    for (const path of [file.path, ...file.companions]) {
      targets.push(join(options.installDir, ...path.split('/')));
    }
  }

  return targets;
}

/** A varredura crua: TUDO o que existe, sem corte e sem ordem. */
interface PluginDataScan {
  readonly files: readonly PluginDataFile[];
  readonly notScanned: readonly string[];
}

/**
 * Lê os dois lugares e devolve o conjunto INTEIRO de candidatos.
 *
 * É a única leitura de disco do módulo: a tela corta o resultado
 * dela, o purge não corta. Duas varreduras diferentes seriam duas
 * verdades sobre a mesma pasta, e a divergência só apareceria
 * depois do estrago.
 */
async function scanPluginData(options: PluginDataOptions): Promise<PluginDataScan> {
  const selected = options.selected ?? [];
  const bpPolicy = options.bpPolicy ?? 'keep';
  const files: PluginDataFile[] = [];

  const saveDir = join(options.installDir, 'server', options.identity);
  const oxideDir = join(options.installDir, 'oxide', 'data');

  // ---- 1. os `.db` da pasta do save que a política NÃO leva ----
  const names = await filesIn(saveDir);
  const present = new Set(names.map((name) => name.toLowerCase()));

  for (const name of names) {
    if (!/\.db(-(wal|shm|journal))?$/i.test(name)) {
      continue;
    }

    // ####  O SATÉLITE NÃO É UMA LINHA  ####
    //
    // `clans.287.db-wal` some junto com `clans.287.db`, e por isso
    // ele não vira uma escolha separada. Enquanto virava, a
    // ordenação por tamanho o punha ONZE posições acima do banco:
    // quem procurava "clans" achava o `-wal` primeiro, marcava só
    // ele, e o wipe levava o WAL deixando o banco de pé — que
    // reabre sem um erro sequer, com as transações confirmadas
    // sumidas.
    //
    // Um satélite ÓRFÃO (o banco já não está lá) continua sendo
    // linha: ele é lixo que só o full wipe pode remover.
    const owner = sidecarOwner(name);

    if (owner !== null && present.has(owner.toLowerCase())) {
      continue;
    }

    // O que já some pela política não é oferecido: ver o cabeçalho.
    if (classifyFile(name, bpPolicy).fate === 'delete') {
      continue;
    }

    const found = await describe(join(saveDir, name), options.installDir, 'save');

    if (found === null) {
      continue;
    }

    const companions: string[] = [];
    let bytes = found.bytes;
    let modifiedAt = found.modifiedAt;

    for (const other of names) {
      if (sidecarOwner(other)?.toLowerCase() !== name.toLowerCase()) {
        continue;
      }

      const satellite = await describe(join(saveDir, other), options.installDir, 'save');

      if (satellite === null) {
        continue;
      }

      companions.push(satellite.path);
      bytes += satellite.bytes;
      modifiedAt = Math.max(modifiedAt, satellite.modifiedAt);
    }

    files.push(withSelection({ ...found, bytes, modifiedAt, companions }, selected));
  }

  // ---- 2. os `.json` do oxide\data --------------------------
  const scan = await jsonFilesIn(oxideDir, MAX_OXIDE_DEPTH);

  for (const path of scan.files) {
    const found = await describe(path, options.installDir, 'oxide');

    if (found !== null) {
      files.push(withSelection({ ...found, companions: [] }, selected));
    }
  }

  return {
    files,
    notScanned: scan.notScanned.map((path) => normalize(relative(options.installDir, path))),
  };
}

/** O padrão do admin casa com esta linha — ou com um satélite dela. */
function matchesFile(
  file: Omit<PluginDataFile, 'selected' | 'selectedBy'>,
  patterns: readonly string[],
): boolean {
  return (
    matchesAny(file.path, patterns) ||
    file.companions.some((companion) => matchesAny(companion, patterns))
  );
}

/**
 * Marca a linha se o padrão casar com ela OU com um satélite dela.
 *
 * O segundo caso não é teoria: uma lista salva antes de o par andar
 * junto guarda `...db-wal` como padrão. Ignorá-lo apagaria só o
 * satélite — ou, pior, nada, com o item indo parar em `missing`.
 */
function withSelection(
  file: Omit<PluginDataFile, 'selected' | 'selectedBy'>,
  patterns: readonly string[],
): PluginDataFile {
  const selectedBy = patterns.filter((pattern) => matchesFile(file, [pattern]));

  return { ...file, selected: selectedBy.length > 0, selectedBy };
}

/**
 * Um padrão casa com um caminho?
 *
 * Suporta `*` (dentro de um segmento) e `**` (qualquer número de
 * segmentos). Sem biblioteca: a alternativa seria trazer um
 * matcher inteiro para comparar dois formatos de nome de arquivo,
 * e o que este projeto usa cabe em quinze linhas.
 *
 * A comparação é SEM diferenciar maiúscula de minúscula, porque o
 * disco onde isto roda é o do Windows — `OrigemZVip.json` e
 * `origemzvip.json` são o mesmo arquivo lá, e um padrão que
 * distinguisse os dois deixaria de casar por causa de uma letra.
 *
 * ####  `**` INCLUI A PRÓPRIA PASTA  ####
 *
 * `oxide/data/**\/*.json` casa `oxide/data/OrigemZStore.json`, e
 * não só o que está numa subpasta. É a pegadinha clássica do
 * globstar: traduzir `**` para `.*` deixando a barra seguinte
 * literal exige pelo menos uma pasta no meio.
 *
 * MEDIDO: com a barra literal, `OrigemZStore.json` — a carteira —
 * ficava de fora de um full wipe que o admin achou ter marcado, e
 * em silêncio, porque o padrão casava com os OUTROS arquivos.
 *
 * ####  E `a**b` ATRAVESSA PASTA, COMO SEMPRE ATRAVESSOU  ####
 *
 * Colado a texto, `**` não tem segmento próprio para representar,
 * e continua sendo o "qualquer coisa, barra inclusive" de sempre.
 * Encolhê-lo para `[^/]*` seria a mesma reinterpretação, só que
 * na outra direção: `oxide/data/***\/*.json` — um `*` a mais, erro
 * de digitação plausível — deixaria de casar
 * `oxide/data/a/b/c.json` sem entrar em `missing`, porque o padrão
 * continua casando com outra coisa. A ordem do admin encolheria
 * calada.
 *
 * ####  E NADA DISTO VALE PARA TRÁS  ####
 *
 * O conserto do globstar mudou, RETROATIVAMENTE e em silêncio, o
 * que uma lista JÁ GRAVADA quer dizer — e na direção que apaga
 * mais. `['oxide/data/**\/*.json']`, salvo num dia em que aquilo
 * queria dizer "os json das subpastas", passou a levar
 * `OrigemZStore.json` e `OrigemZVip.json`: a carteira e o VIP que
 * alguém pagou.
 *
 * MEDIDO com o WipeRunner de verdade, mesma árvore e mesma lista
 * salva: "apagar: 9 arquivo(s) + 1 de plugin" virou "+ 3 de
 * plugin". Um wipe de cadência roda de madrugada — não existe tela
 * aberta para alguém ver a marca nova.
 *
 * Por isso a regra desta função é maior que ela: NENHUMA mudança
 * no casamento pode alargar o que uma lista já salva apaga. Quem
 * segura isso é `rewriteLegacyPattern`, que reescreve as listas
 * gravadas antes desta linha para padrões que dizem o que elas
 * sempre quiseram dizer (migração 032), e o teste que compara os
 * dois dialetos par a par.
 */
export function matches(path: string, pattern: string): boolean {
  const normalized = normalize(pattern);

  if (normalized === '') {
    return false;
  }

  // Segmento a segmento: é a única forma de o `**` decidir sobre a
  // BARRA que vem com ele, e é a barra que estava sobrando.
  const segments = normalized.split('/');
  let expression = '';
  let separator = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';

    if (isGlobstar(segment)) {
      expression +=
        index === segments.length - 1
          ? // `a/**`: a pasta e tudo o que está abaixo dela.
            (separator ? '(?:/.*)?' : '.*')
          : // `a/**/b`: com pastas no meio, ou sem nenhuma.
            (separator ? '(?:/.*)?/' : '(?:.*/)?');
      separator = false;
      continue;
    }

    if (separator) {
      expression += '/';
    }

    expression += segmentExpression(segment);
    separator = true;
  }

  return new RegExp(`^${expression}$`, 'i').test(normalize(path));
}

/**
 * Este padrão PODERIA casar com alguma coisa DENTRO desta pasta?
 *
 * ####  A PERGUNTA QUE SEPARA "NÃO EXISTE" DE "NÃO OLHEI"  ####
 *
 * `MAX_OXIDE_DEPTH` faz a varredura parar, e o que está mais fundo
 * não entra em `files`. Um padrão marcado apontando para lá não
 * casava com nada e ia parar em `missing` — que a tela lê como
 * "não existe mais em disco, e apagar num arquivo ausente é
 * sucesso". MEDIDO: o arquivo estava lá, a prévia nomeava a pasta
 * em `PLUGIN_DATA_TOO_DEEP` logo acima, e o tranquilizador era o
 * último aviso da lista.
 *
 * A resposta é por SEGMENTO, e é a única que dá para dar sem
 * descer a árvore que a varredura recusou descer: se as pastas
 * casam com o COMEÇO do padrão e ainda SOBRA padrão para casar o
 * que está dentro, pode haver algo ali. É um "pode", e a frase da
 * tela diz "pode".
 *
 * `oxide/data/n1/n2/n3/n4` com `oxide/data/**\/*.json` responde
 * `true`; com `oxide/data/OrigemZStore.json`, `false` — aquele
 * padrão é um caminho exato, e ele não está lá dentro.
 */
export function couldMatchUnder(dir: string, pattern: string): boolean {
  const folders = normalize(dir).split('/');
  const segments = normalize(pattern).split('/');

  // Os índices do padrão em que a leitura pode estar. Começa no
  // primeiro, já com o `**` que casa zero pasta empurrado adiante.
  let states = withEmptyGlobstars(new Set([0]), segments);

  for (const folder of folders) {
    const next = new Set<number>();

    for (const index of states) {
      const segment = segments[index];

      if (segment === undefined) {
        continue;
      }

      if (isGlobstar(segment)) {
        // Ele engole esta pasta e continua valendo para a próxima.
        next.add(index);
        continue;
      }

      if (segmentMatches(segment, folder)) {
        next.add(index + 1);
      }
    }

    states = withEmptyGlobstars(next, segments);

    if (states.size === 0) {
      return false;
    }
  }

  // Sobrou padrão depois da pasta? É ele que casaria com o que está
  // DENTRO dela. Sem sobra, o padrão termina na própria pasta — e
  // pasta não é arquivo.
  return [...states].some((index) => index < segments.length);
}

/** `**` casa ZERO pasta: o índice anda sem consumir nada. */
function withEmptyGlobstars(
  states: ReadonlySet<number>,
  segments: readonly string[],
): Set<number> {
  const reachable = new Set(states);

  // O `for..of` de um `Set` enxerga o que for acrescentado durante
  // a volta, e aqui só se acrescenta para a frente: uma fila de
  // `**` seguidos anda até o fim sozinha.
  for (const index of reachable) {
    if (isGlobstar(segments[index] ?? '')) {
      reachable.add(index + 1);
    }
  }

  return reachable;
}

/** Um segmento do padrão contra UM nome de pasta. */
function segmentMatches(segment: string, name: string): boolean {
  return new RegExp(`^${segmentExpression(segment)}$`, 'i').test(name);
}

/**
 * O segmento é SÓ estrelas, duas ou mais: o globstar de verdade.
 *
 * `***` entra junto de propósito. Ele nunca quis dizer outra coisa
 * — no casador antigo `**` e `***` davam o mesmo `.*` —, e
 * tratá-lo como segmento comum transformaria um `*` digitado a
 * mais num padrão que casa MENOS, sem uma linha de aviso.
 */
function isGlobstar(segment: string): boolean {
  return /^\*{2,}$/.test(segment);
}

/**
 * O mesmo padrão, escrito de um jeito que `matches` responde HOJE
 * o que ele respondia ANTES do conserto do globstar.
 *
 * ####  QUAL É A ÚNICA DIFERENÇA ENTRE OS DOIS  ####
 *
 * O casador de antes era textual: `**` virava `.*` e a barra ao
 * lado ficava literal. O de hoje é por segmento. Fora do caso do
 * `**` que OCUPA um segmento inteiro os dois dão a mesma resposta
 * — e nesse caso a diferença é exatamente uma: hoje ele casa
 * também com NENHUMA pasta.
 *
 * Então a reescrita é uma só: devolver a pasta que o padrão antigo
 * exigia, pondo um segmento `*` na frente do globstar.
 *
 *     oxide/data/**\/*.json   ->   oxide/data/*\/**\/*.json
 *     oxide/data/**           ->   oxide/data/*\/**
 *     **\/*.json              ->   *\/**\/*.json
 *
 * O padrão reescrito NÃO casa `oxide/data/OrigemZVip.json`, casa
 * `oxide/data/OrigemZ/historico.json` e casa
 * `oxide/data/n1/n2/fundo.json` — os três desfechos do dia em que
 * o admin marcou aquilo.
 *
 * ####  E QUANDO NÃO HÁ NADA A REESCREVER  ####
 *
 * Padrão sem globstar de segmento inteiro volta INTACTO, byte a
 * byte. É o caso de toda linha que a tela grava — elas são
 * caminhos exatos —, e reescrever o que não mudou de sentido só
 * faria a tela mostrar um texto que o admin não digitou.
 *
 * `**` sozinho também volta intacto: "tudo" era o que ele queria
 * dizer, e é o que ele quer dizer.
 *
 * ####  ELA RODA UMA VEZ, E NÃO PODE SER IDEMPOTENTE  ####
 *
 * Isto é uma TRADUÇÃO de dialeto, não uma normalização: aplicar de
 * novo é traduzir de novo, e o resultado encolhe.
 *
 * Não é descuido, é obrigação. `oxide/data/*\/**\/*.json` é um
 * padrão legado LEGÍTIMO — alguém pode tê-lo digitado —, e no
 * dialeto antigo ele exige DUAS pastas. MEDIDO: ele casa
 * `oxide/data/a/b/x.json` e não casa `oxide/data/a/x.json`. Uma
 * reescrita que reconhecesse o próprio resultado e o deixasse
 * passar faria aquele padrão passar a exigir UMA pasta — o mesmo
 * alargamento que esta função existe para impedir.
 *
 * Quem garante a vez única é `schema_migrations`, e é só isso que
 * precisa garantir: `runMigrations` num banco em dia não faz nada.
 */
export function rewriteLegacyPattern(pattern: string): string {
  const segments = normalize(pattern).split('/');

  if (segments.length < 2 || !segments.some((segment) => isGlobstar(segment))) {
    return pattern;
  }

  return segments.flatMap((segment) => (isGlobstar(segment) ? ['*', '**'] : [segment])).join('/');
}

/** Um segmento traduzido: `*` fica DENTRO dele, e o resto é literal. */
function segmentExpression(segment: string): string {
  let expression = '';
  let at = 0;

  while (at < segment.length) {
    const character = segment[at] ?? '';

    if (character === '*') {
      // Um `*` sozinho fica dentro do segmento; dois ou mais
      // atravessam pasta. Colado a texto o `**` não tem segmento
      // próprio para virar globstar, mas encolhê-lo mudaria de
      // sentido uma lista já salva. Ver `matches`.
      const start = at;

      while (segment[at] === '*') {
        at += 1;
      }

      expression += at - start >= 2 ? '.*' : '[^/]*';
      continue;
    }

    // O que não é curinga é LITERAL, inclusive o ponto: sem a
    // escapada, o padrão `abc.json` casaria com `abcXjson`.
    expression += REGEX_SPECIAL.test(character) ? `\\${character}` : character;
    at += 1;
  }

  return expression;
}

/** O que precisa de contrabarra para virar literal dentro de um regex. */
const REGEX_SPECIAL = /[.+^${}()|[\]\\?]/;

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matches(path, pattern));
}

/** Contrabarra vira barra, e o começo redundante cai. Ver `path`. */
function normalize(value: string): string {
  return value.split(sep).join('/').split('\\').join('/').replace(/^\.\//, '').trim();
}

/** Um arquivo, com tamanho e data. `null` quando ele sumiu no caminho. */
async function describe(
  absolute: string,
  installDir: string,
  area: PluginDataArea,
): Promise<Omit<PluginDataFile, 'selected' | 'selectedBy' | 'companions'> | null> {
  try {
    const info = await stat(absolute);

    if (!info.isFile()) {
      return null;
    }

    return {
      path: normalize(relative(installDir, absolute)),
      area,
      bytes: info.size,
      // `mtimeMs` é float — o disco guarda frações de milissegundo.
      // Um campo documentado como "Epoch ms" que responde
      // `1787164730777.349` vai fracionário para a tela e para o
      // JSON da rota; arredondar aqui é arredondar uma vez só.
      modifiedAt: Math.round(info.mtimeMs),
    };
  } catch {
    // Sumiu entre a varredura e o stat. Um arquivo a menos na
    // lista é melhor que uma tela que não abre.
    return null;
  }
}

/** Os nomes de arquivo do nível de cima. Vazio se a pasta não existe. */
async function filesIn(dir: string): Promise<readonly string[]> {
  try {
    const found = await readdir(dir, { withFileTypes: true });

    return found.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** O resultado de uma varredura: o que achou, e onde ela parou. */
interface JsonScan {
  readonly files: readonly string[];
  /** As pastas em que a varredura parou por ter batido no teto. */
  readonly notScanned: readonly string[];
}

/**
 * Os `.json` da pasta e das subpastas, até `depth` níveis.
 *
 * O teto de profundidade existe porque `oxide\data` é escrito por
 * plugin de terceiro: um deles que crie uma árvore funda (ou um
 * link circular) travaria a rota que a tela chama a cada
 * recarregada.
 *
 * ####  E ELE PRECISA DIZER ONDE PAROU  ####
 *
 * O limite é intencional; o silêncio era o defeito. Do 4º nível em
 * diante o arquivo simplesmente não existia para o full wipe — nem
 * na lista, nem na rota, nem num aviso. Cada pasta que a varredura
 * recusa descer volta em `notScanned`.
 */
async function jsonFilesIn(dir: string, depth: number): Promise<JsonScan> {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [], notScanned: [] };
  }

  const found: string[] = [];
  const notScanned: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (depth <= 0) {
        notScanned.push(full);
        continue;
      }

      const deeper = await jsonFilesIn(full, depth - 1);

      found.push(...deeper.files);
      notScanned.push(...deeper.notScanned);
      continue;
    }

    if (entry.isFile() && posix.extname(entry.name.split(sep).join('/')).toLowerCase() === '.json') {
      found.push(full);
    }
  }

  return { files: found, notScanned };
}
