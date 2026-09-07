// ============================================================
//  data-files.ts  -  os arquivos que o plugin GUARDA, em
//  `oxide\data`.
//
//  ####  ELE É O GÊMEO DO plugin-config.ts, DO OUTRO LADO  ####
//
//  Aquele cuida de `oxide\config\<Nome>.json` — o que o admin
//  ajusta. Este cuida de `oxide\data\<Nome>\<arquivo>.json` — o
//  que o plugin escreve sozinho e relê no próximo boot: a tabela
//  de loot que o BetterLoot gerou do mundo, o `pending.json` do
//  nosso `OrigemZItems`.
//
//  Até 06/09/2026 o único módulo do agente que enxergava
//  `oxide\data` era o do wipe (`wipe/plugin-data.ts`), e ele só
//  APAGA — nunca precisou abrir um arquivo. O editor de loot é o
//  primeiro caso que lê e escreve, e por isso o caminho passou a
//  ter um dono em vez de um `join` solto.
//
//  ------------------------------------------------------------
//  ####  A TRAVA DE `..` É A MESMA, E PELA MESMA RAZÃO  ####
//
//  Nome de plugin e nome de arquivo chegam da URL. Sem a trava, um
//  `..` escreveria fora da pasta — e o alvo mais próximo daqui é
//  `oxide\plugins`, onde um `.cs` gravado por engano é código que
//  o servidor executa.
//
//  ####  BACKUP ANTES DE TODA ESCRITA, TAMBÉM AQUI  ####
//
//  E aqui ele importa MAIS que na config: um `LootTables.json` é a
//  tabela de loot inteira de um servidor de produção — 2,5 MB que
//  o plugin levou um boot inteiro para gerar do mundo. Uma escrita
//  errada a substitui por completo, porque o plugin serializa o
//  dicionário todo e não existe merge.
//
//  A cópia vai para `Backups\<id>\oxide-data\`, e NÃO para o
//  `oxide-config\` do vizinho: são naturezas diferentes, e quem
//  for procurar a tabela de ontem procura onde ela mora.
// ============================================================

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ApiError } from '../http/error-response.js';
import { toError } from '../util.js';

/**
 * Nome aceito de plugin e de arquivo.
 *
 * O mesmo alfabeto do `CONFIG_PLUGIN_PATTERN` — é o mesmo tipo de
 * nome, e duas réguas diferentes para a mesma coisa divergiriam no
 * primeiro ajuste.
 */
export const DATA_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** O que um arquivo de dados tem além do texto. */
export interface PluginDataFile {
  /** `BetterLoot` — a subpasta. */
  readonly plugin: string;
  /** `LootTables` — o nome do arquivo, sem o `.json`. */
  readonly file: string;
  readonly text: string;
  readonly bytes: number;
  /** ISO. Quando o disco diz que o arquivo mudou pela última vez. */
  readonly modifiedAt: string;
}

/**
 * `oxide\data\<Plugin>\<arquivo>.json`, conferido.
 *
 * @throws {ApiError} 400 quando um dos dois nomes sai da pasta.
 */
export function pluginDataPath(dataDir: string, plugin: string, file: string): string {
  for (const [name, what] of [
    [plugin, 'plugin'],
    [file, 'arquivo'],
  ] as const) {
    if (!DATA_NAME_PATTERN.test(name)) {
      throw new ApiError(
        'INVALID_DATA_NAME',
        `"${name}" não é um nome de ${what} aceito. Use letras, dígitos, ponto, hífen ou ` +
          'sublinhado.',
        400,
      );
    }
  }

  const dir = resolve(dataDir);
  const target = resolve(dir, plugin, `${file}.json`);

  // A segunda barreira, como no `pluginConfigPath`: é ela que
  // continua valendo se alguém afrouxar o padrão acima um dia.
  if (!target.startsWith(dir)) {
    throw new ApiError(
      'INVALID_DATA_NAME',
      `O caminho de "${plugin}/${file}" sai da pasta de dados do servidor. Recusado.`,
      400,
    );
  }

  return target;
}

/**
 * O conteúdo de hoje, ou `null` se o plugin ainda não o criou.
 *
 * Ausente NÃO é erro: o arquivo só nasce quando o plugin carrega
 * pela primeira vez naquele servidor. Um 404 aqui faria a tela
 * dizer "deu problema" sobre um estado que é normal — o plugin
 * nunca esteve no ar ali.
 */
export async function readPluginDataFile(
  dataDir: string,
  plugin: string,
  file: string,
): Promise<PluginDataFile | null> {
  const target = pluginDataPath(dataDir, plugin, file);

  try {
    const [text, info] = await Promise.all([readFile(target, 'utf8'), stat(target)]);

    return {
      plugin,
      file,
      text,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new ApiError(
      'PLUGIN_DATA_READ_FAILED',
      `Não consegui ler ${target}: ${toError(error).message}.`,
      500,
    );
  }
}

/**
 * A cópia do que estava lá ANTES de gravar.
 *
 * Devolve o caminho gravado, ou `null` quando não havia arquivo.
 * Mesmo desenho do `backupPluginConfig`, incluindo o epoch no nome
 * — um contador exigiria listar a pasta antes, e é isso que duas
 * telas gravando juntas atropelam.
 *
 * @throws {ApiError} 500 quando a cópia falha. **Sem backup, não
 * grava**: escrever por cima sem ter conseguido copiar é
 * exatamente o caso em que o operador perde a configuração, e é o
 * caso em que ele mais precisaria dela de volta.
 */
export async function backupPluginDataFile(
  dataDir: string,
  backupsDir: string,
  plugin: string,
  file: string,
  at: number,
): Promise<string | null> {
  const source = pluginDataPath(dataDir, plugin, file);

  let content: Buffer;

  try {
    content = await readFile(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new ApiError(
      'PLUGIN_DATA_READ_FAILED',
      `Não consegui ler ${source} para fazer a cópia de segurança: ${toError(error).message}.`,
      500,
    );
  }

  const dir = join(backupsDir, 'oxide-data');
  const target = join(dir, `${plugin}-${file}-${String(at)}.json`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(target, content);
  } catch (error) {
    throw new ApiError(
      'PLUGIN_DATA_BACKUP_FAILED',
      `Não consegui gravar a cópia de segurança em ${target}: ${toError(error).message}. ` +
        'O arquivo NÃO foi alterado.',
      500,
    );
  }

  return target;
}

/** Grava o texto. A subpasta do plugin nasce se não existir. */
export async function writePluginDataFile(
  dataDir: string,
  plugin: string,
  file: string,
  text: string,
): Promise<void> {
  const target = pluginDataPath(dataDir, plugin, file);

  try {
    await mkdir(join(resolve(dataDir), plugin), { recursive: true });
    await writeFile(target, text, 'utf8');
  } catch (error) {
    throw new ApiError(
      'PLUGIN_DATA_WRITE_FAILED',
      `Não consegui gravar ${target}: ${toError(error).message}.`,
      500,
    );
  }
}
