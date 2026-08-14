// ============================================================
//  plugin-config.ts  -  o `oxide\config\<Nome>.json` de cada
//  plugin, pela tela.
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  Sem esta tela, configurar um plugin é abrir
//  `Servers\<id>\oxide\config\OrigemZVip.json` num editor de texto,
//  na máquina onde o servidor mora. O painel existe justamente para
//  não precisar disso — e um plugin que não se configura pelo painel
//  é meio plugin.
//
//  ------------------------------------------------------------
//  ####  O ARQUIVO NÃO É NOSSO  ####
//
//  Quem o cria é o plugin, no primeiro carregamento, com os padrões
//  dele. Quem o reescreve, muitas vezes, também é ele: vários
//  chamam `SaveConfig()` ao carregar, normalizando o que leram. Três
//  consequências, e todas moram aqui:
//
//    1. gravar e recarregar andam juntos. Mexer no arquivo com o
//       plugin carregado não tem efeito nenhum até o
//       `oxide.reload <Nome>`;
//
//    2. depois do reload, o conteúdo é LIDO DE NOVO do disco. O que
//       o plugin gravou por cima é o que vale — mostrar o texto que
//       o operador enviou faria a tela afirmar uma coisa que o
//       arquivo não diz mais;
//
//    3. JSON quebrado derruba o plugin. O Oxide não carrega com
//       config inválida, e a mensagem some no console do jogo. Por
//       isso nada é gravado sem passar pelo `JSON.parse` antes.
//
//  ------------------------------------------------------------
//  ####  BACKUP ANTES DE TODA ESCRITA  ####
//
//  Não existe Ctrl+Z numa tela. Um JSON gravado errado num plugin de
//  VIP é uma noite de trabalho perdida, e o "voltar ao padrão" apaga
//  o arquivo inteiro de propósito. A cópia em
//  `Backups\<id>\oxide-config\` é o que torna as duas coisas
//  reversíveis.
// ============================================================

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ApiError } from '../http/error-response.js';
import { toError } from '../util.js';

/**
 * Nome de plugin aceito na URL.
 *
 * O mesmo alfabeto do nome do `.cs`, sem a extensão: é o mesmo nome
 * — `OrigemZVip.cs` configura-se em `OrigemZVip.json`, e é isso que
 * o `oxide.reload OrigemZVip` recebe.
 */
export const CONFIG_PLUGIN_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Teto do arquivo de config.
 *
 * ####  ELE PRECISA CABER NO CORPO DA REQUISIÇÃO  ####
 *
 * O texto viaja dentro de um JSON (`{"text": "..."}`), onde cada
 * aspa e cada quebra de linha viram dois caracteres — e o Fastify
 * corta o corpo em 1 MB (`bodyLimit`, em http/server.ts). Um teto
 * maior que este não seria recusado por nós, com a frase que explica
 * o que fazer: seria recusado pelo servidor, com um 413 em inglês.
 *
 * 256 KB é folgado para o que existe: config de plugin cresce com
 * dado — a lista de itens da loja, as permissões por nível — e
 * mesmo as grandes ficam em dezenas de KB.
 */
export const MAX_CONFIG_BYTES = 256 * 1024;

export interface PluginConfigInfo {
  /** `OrigemZVip` — o que o `oxide.reload` recebe. */
  readonly plugin: string;
  /** `OrigemZVip.json`. */
  readonly file: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

export interface PluginConfigContent extends PluginConfigInfo {
  readonly text: string;
}

/**
 * O caminho daquela config, conferido.
 *
 * A MESMA trava do `pluginPath`, e pela mesma razão: um nome com
 * `..` escreveria fora da pasta. Aqui o alvo seria
 * `oxide\config\..\..\..\Configs\server01.ini` — o arquivo que
 * decide em que porta o servidor sobe.
 *
 * @throws {ApiError} 400.
 */
export function pluginConfigPath(configDir: string, plugin: string): string {
  if (!CONFIG_PLUGIN_PATTERN.test(plugin)) {
    throw new ApiError(
      'INVALID_PLUGIN_NAME',
      `"${plugin}" não é um nome de plugin aceito. Use letras, dígitos, ponto, hífen ou ` +
        'sublinhado — por exemplo, OrigemZVip.',
      400,
    );
  }

  const dir = resolve(configDir);
  const target = resolve(dir, `${plugin}.json`);

  // A segunda barreira, como no `pluginPath`: é ela que continua
  // valendo se alguém afrouxar o padrão acima um dia.
  if (!target.startsWith(dir)) {
    throw new ApiError(
      'INVALID_PLUGIN_NAME',
      `O caminho de "${plugin}" sai da pasta de configuração do servidor. Recusado.`,
      400,
    );
  }

  return target;
}

/** O que a tela lista. Pasta ausente = lista vazia, não erro. */
export async function listPluginConfigs(configDir: string): Promise<readonly PluginConfigInfo[]> {
  let names: string[];

  try {
    names = await readdir(configDir);
  } catch {
    // A pasta `oxide\config` só nasce no primeiro boot do servidor
    // com o Oxide instalado. Antes disso, "nenhuma configuração" é a
    // resposta certa — e não um erro na tela.
    return [];
  }

  const configs: PluginConfigInfo[] = [];

  for (const file of names) {
    if (!file.toLowerCase().endsWith('.json')) {
      continue;
    }

    const plugin = file.slice(0, -5);

    // ####  O QUE FICA DE FORA  ####
    //
    // Só o que o padrão do nome não aceita. O `oxide.config.json` e o
    // `Compiler.json`, que são do loader e não de plugin nenhum,
    // PASSAM — e é de propósito: quem abre esta tela quer ver a
    // pasta, e esconder um arquivo que está lá faria o agente
    // parecer que o perdeu.
    if (!CONFIG_PLUGIN_PATTERN.test(plugin)) {
      continue;
    }

    try {
      const info = await stat(join(configDir, file));

      configs.push({
        plugin,
        file,
        bytes: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      });
    } catch {
      // Sumiu entre o readdir e o stat: alguém apagou à mão.
    }
  }

  return configs.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

/** O conteúdo de hoje, ou `null` se o plugin ainda não o criou. */
export async function readPluginConfig(
  configDir: string,
  plugin: string,
): Promise<PluginConfigContent | null> {
  const target = pluginConfigPath(configDir, plugin);

  try {
    const [text, info] = await Promise.all([readFile(target, 'utf8'), stat(target)]);

    return {
      plugin,
      file: `${plugin}.json`,
      text,
      bytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config ausente NÃO é erro: o plugin só a cria quando carrega
      // pela primeira vez. Dizer isso é melhor que um 404 seco, que
      // a tela traduziria como "deu problema".
      return null;
    }

    throw new ApiError(
      'PLUGIN_CONFIG_READ_FAILED',
      `Não consegui ler ${target}: ${toError(error).message}.`,
      500,
    );
  }
}

/**
 * O texto é JSON válido?
 *
 * ####  A POSIÇÃO É A PARTE ÚTIL DA MENSAGEM  ####
 *
 * O `JSON.parse` diz onde quebrou, e é a única coisa que permite a
 * quem está olhando para 200 linhas de config achar a vírgula
 * sobrando. "JSON inválido", sozinho, manda procurar no escuro.
 *
 * @throws {ApiError} 400.
 */
export function assertValidJson(text: string): void {
  if (text.trim() === '') {
    throw new ApiError(
      'INVALID_PLUGIN_CONFIG',
      'A configuração está vazia. Para voltar ao padrão do plugin, use o botão de restaurar — ' +
        'ele apaga o arquivo e deixa o plugin criá-lo de novo.',
      400,
    );
  }

  try {
    JSON.parse(text);
  } catch (error) {
    throw new ApiError(
      'INVALID_PLUGIN_CONFIG',
      `Isto não é um JSON válido: ${toError(error).message}. O arquivo NÃO foi gravado — o ` +
        'Oxide não carrega um plugin com a configuração quebrada, e o erro dele só apareceria ' +
        'no console do jogo.',
      400,
    );
  }
}

/**
 * A cópia de segurança do que estava lá ANTES.
 *
 * Devolve o caminho gravado, ou `null` quando não havia arquivo — o
 * primeiro `PUT` de uma config que o plugin ainda não criou não tem
 * o que preservar.
 *
 * O epoch no nome, e não um contador: dois backups no mesmo
 * milissegundo são raros, e um nome que depende de listar a pasta
 * antes é o que se atropela quando duas telas gravam juntas.
 */
export async function backupPluginConfig(
  configDir: string,
  backupsDir: string,
  plugin: string,
  at: number,
): Promise<string | null> {
  const source = pluginConfigPath(configDir, plugin);

  let content: Buffer;

  try {
    content = await readFile(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new ApiError(
      'PLUGIN_CONFIG_READ_FAILED',
      `Não consegui ler ${source} para fazer a cópia de segurança: ${toError(error).message}.`,
      500,
    );
  }

  const dir = join(backupsDir, 'oxide-config');
  const target = join(dir, `${plugin}-${String(at)}.json`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(target, content);
  } catch (error) {
    // ####  SEM BACKUP, NÃO GRAVA  ####
    //
    // Falhar aqui interrompe a escrita de propósito. Gravar por cima
    // do arquivo antigo sem ter conseguido copiá-lo é exatamente o
    // caso em que o operador perde a configuração — e é o caso em
    // que ele mais precisaria dela de volta.
    throw new ApiError(
      'PLUGIN_CONFIG_BACKUP_FAILED',
      `Não consegui gravar a cópia de segurança em ${target}: ${toError(error).message}. ` +
        'A configuração NÃO foi alterada.',
      500,
    );
  }

  return target;
}

/** Grava o texto conferido. A pasta nasce se não existir. */
export async function writePluginConfig(
  configDir: string,
  plugin: string,
  text: string,
): Promise<void> {
  const target = pluginConfigPath(configDir, plugin);

  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(target, text, 'utf8');
  } catch (error) {
    throw new ApiError(
      'PLUGIN_CONFIG_WRITE_FAILED',
      `Não consegui gravar ${target}: ${toError(error).message}.`,
      500,
    );
  }
}

/** Apaga a config. O plugin a recria com os padrões no próximo load. */
export async function removePluginConfig(configDir: string, plugin: string): Promise<void> {
  const target = pluginConfigPath(configDir, plugin);

  try {
    await rm(target, { force: true });
  } catch (error) {
    throw new ApiError(
      'PLUGIN_CONFIG_REMOVE_FAILED',
      `Não consegui apagar ${target}: ${toError(error).message}.`,
      500,
    );
  }
}
