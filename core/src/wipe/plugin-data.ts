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

import { classifyFile } from './save-files.js';
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
  readonly bytes: number;
  /** Epoch ms da última alteração. É o que responde "isso ainda é usado?". */
  readonly modifiedAt: number;
  /** O admin marcou este padrão. */
  readonly selected: boolean;
}

/** O que o full wipe levaria, e o que ele não acha mais. */
export interface PluginDataListing {
  readonly files: readonly PluginDataFile[];
  /**
   * Padrões marcados que hoje não casam com arquivo nenhum.
   *
   * Eles CONTINUAM na lista salva. Ver o cabeçalho.
   */
  readonly missing: readonly string[];
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
 * Teto de arquivos varridos.
 *
 * `oxide\data` de um servidor antigo tem milhares de `.json` por
 * jogador (um por plugin, por SteamID). Devolver todos eles
 * derrubaria a tela e não ajudaria ninguém a escolher; o teto vira
 * um aviso na resposta, e a lista continua útil.
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
  const bpPolicy = options.bpPolicy ?? 'keep';
  const files: PluginDataFile[] = [];

  const saveDir = join(options.installDir, 'server', options.identity);
  const oxideDir = join(options.installDir, 'oxide', 'data');

  // ---- 1. os `.db` da pasta do save que a política NÃO leva ----
  for (const name of await filesIn(saveDir)) {
    if (!/\.db(-(wal|shm|journal))?$/i.test(name)) {
      continue;
    }

    // O que já some pela política não é oferecido: ver o cabeçalho.
    if (classifyFile(name, bpPolicy).fate === 'delete') {
      continue;
    }

    const found = await describe(join(saveDir, name), options.installDir, 'save');

    if (found !== null) {
      files.push({ ...found, selected: matchesAny(found.path, selected) });
    }
  }

  // ---- 2. os `.json` do oxide\data --------------------------
  for (const path of await jsonFilesIn(oxideDir, MAX_OXIDE_DEPTH)) {
    const found = await describe(path, options.installDir, 'oxide');

    if (found !== null) {
      files.push({ ...found, selected: matchesAny(found.path, selected) });
    }
  }

  // O marcado primeiro (é o que o admin veio conferir), depois o
  // maior — o que ocupa disco é o que motiva um full wipe.
  files.sort((a, b) => {
    if (a.selected !== b.selected) {
      return a.selected ? -1 : 1;
    }

    return b.bytes - a.bytes;
  });

  const shown = files.slice(0, MAX_FILES);
  const missing = selected.filter((pattern) => !files.some((file) => matches(file.path, pattern)));

  return { files: shown, missing };
}

/**
 * Os caminhos que o passo `apagar` deve levar, já resolvidos
 * contra o disco.
 *
 * O purge só apaga o que casa com a lista salva: um padrão que
 * casa com nada some da resposta em silêncio, e é o certo — o
 * arquivo não estar lá é o desfecho que o full wipe queria.
 */
export async function resolvePluginDataTargets(options: PluginDataOptions): Promise<readonly string[]> {
  const listing = await listPluginData(options);

  return listing.files
    .filter((file) => file.selected)
    .map((file) => join(options.installDir, ...file.path.split('/')));
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
 */
export function matches(path: string, pattern: string): boolean {
  const normalized = normalize(pattern);

  if (normalized === '') {
    return false;
  }

  let expression = '';
  let at = 0;

  while (at < normalized.length) {
    const character = normalized[at] ?? '';

    if (character === '*') {
      // `**` é lido ANTES do `*` sozinho: ele engole segmentos
      // inteiros, inclusive a barra. Traduzir o `*` primeiro faria
      // o `**` virar dois `[^/]*`, que nunca atravessa uma pasta.
      if (normalized[at + 1] === '*') {
        expression += '.*';
        at += 2;
        continue;
      }

      expression += '[^/]*';
      at += 1;
      continue;
    }

    // O que não é curinga é LITERAL, inclusive o ponto: sem a
    // escapada, o padrão `abc.json` casaria com `abcXjson`.
    expression += REGEX_SPECIAL.test(character) ? `\\${character}` : character;
    at += 1;
  }

  return new RegExp(`^${expression}$`, 'i').test(normalize(path));
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
): Promise<Omit<PluginDataFile, 'selected'> | null> {
  try {
    const info = await stat(absolute);

    if (!info.isFile()) {
      return null;
    }

    return {
      path: normalize(relative(installDir, absolute)),
      area,
      bytes: info.size,
      modifiedAt: info.mtimeMs,
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

/**
 * Os `.json` da pasta e das subpastas, até `depth` níveis.
 *
 * O teto de profundidade existe porque `oxide\data` é escrito por
 * plugin de terceiro: um deles que crie uma árvore funda (ou um
 * link circular) travaria a rota que a tela chama a cada
 * recarregada.
 */
async function jsonFilesIn(dir: string, depth: number): Promise<readonly string[]> {
  if (depth < 0) {
    return [];
  }

  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await jsonFilesIn(full, depth - 1)));
      continue;
    }

    if (entry.isFile() && posix.extname(entry.name.split(sep).join('/')).toLowerCase() === '.json') {
      found.push(full);
    }
  }

  return found;
}
