// ============================================================
//  plugins.ts  -  os .cs de um servidor.
//
//  ####  O AGENTE NÃO CONHECE PLUGIN NENHUM  ####
//
//  Ele sabe onde eles moram (`Servers\<id>\oxide\plugins`) e como
//  pedir ao Oxide que recarregue. Nada aqui sabe o que um plugin
//  faz — e é isso que faz esta tela servir para os nossos plugins,
//  para os reformulados de amanhã e para qualquer um baixado do
//  uMod.
//
//  ------------------------------------------------------------
//  ####  AS DUAS TRAVAS SÃO DE SEGURANÇA, NÃO DE ZELO  ####
//
//  1. O NOME passa por regex estrito E o caminho final é
//     conferido contra a pasta de plugins daquele servidor. Um
//     `..\..\RustDedicated_Data\Managed\Oxide.Core.dll` no nome do
//     upload substituiria um assembly do loader — o servidor
//     deixaria de subir, e ninguém ligaria isso a um upload.
//
//  2. O CONTEÚDO precisa parecer C# e caber no limite. Não é
//     antivírus: é o que impede um upload errado (um .zip
//     renomeado, um PDF) de virar um arquivo que o Oxide tenta
//     compilar em laço, enchendo o log do servidor.
// ============================================================

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

/** Nome de arquivo aceito. Sem barra, sem `..`, sempre `.cs`. */
export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}\.cs$/;

/** Teto do arquivo. O maior plugin conhecido tem ~180 KB. */
export const MAX_PLUGIN_BYTES = 256 * 1024;

export interface PluginInfo {
  /** `MeuPlugin.cs`. */
  readonly name: string;
  /** `MeuPlugin` — o que o `oxide.reload` recebe. */
  readonly plugin: string;
  readonly bytes: number;
  readonly modifiedAt: string;
}

/**
 * O caminho daquele plugin, conferido.
 *
 * @throws {ApiError} 400 quando o nome não passa, ou quando o
 * caminho resolvido sai da pasta de plugins.
 */
export function pluginPath(pluginsDir: string, name: string): string {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new ApiError(
      'INVALID_PLUGIN_NAME',
      `"${name}" não é um nome de plugin aceito. Use letras, dígitos, ponto, hífen ou ` +
        'sublinhado, terminando em .cs — por exemplo, MeuPlugin.cs.',
      400,
    );
  }

  const dir = resolve(pluginsDir);
  const target = resolve(dir, name);

  // A segunda barreira. O regex acima já recusa `..`, mas esta
  // conferência é a que continua valendo se alguém afrouxar o
  // regex um dia.
  if (!target.startsWith(dir)) {
    throw new ApiError(
      'INVALID_PLUGIN_NAME',
      `O caminho de "${name}" sai da pasta de plugins do servidor. Recusado.`,
      400,
    );
  }

  return target;
}

/** O que o painel lista. Pasta ausente = lista vazia, não erro. */
export async function listPlugins(pluginsDir: string): Promise<readonly PluginInfo[]> {
  let names: string[];

  try {
    names = await readdir(pluginsDir);
  } catch {
    // A pasta `oxide\` só nasce no primeiro boot do servidor (ou
    // na instalação do Oxide). Antes disso, "nenhum plugin" é a
    // resposta certa — e não um erro na tela.
    return [];
  }

  const plugins: PluginInfo[] = [];

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.cs')) {
      continue;
    }

    try {
      const info = await stat(join(pluginsDir, name));

      plugins.push({
        name,
        plugin: name.slice(0, -3),
        bytes: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      });
    } catch {
      // Sumiu entre o readdir e o stat: alguém apagou à mão.
    }
  }

  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

export interface InstallPluginOptions {
  readonly pluginsDir: string;
  readonly name: string;
  readonly content: Buffer;
  readonly rcon: OpsRcon;
}

export interface PluginReloadResult {
  /** O comando chegou ao servidor? `false` com o jogo parado. */
  readonly sent: boolean;
  /** O que o Oxide respondeu — inclusive o erro de compilação. */
  readonly output: string | null;
}

export interface InstallPluginResult {
  readonly name: string;
  readonly bytes: number;
  readonly reload: PluginReloadResult;
}

/**
 * O arquivo parece C#?
 *
 * Heurística deliberadamente frouxa: qualquer coisa que tenha
 * `using`, `namespace`, `class` ou o atributo `[Info(...)]` do
 * Oxide passa. O que ela pega é o engano grosseiro — zip, PDF,
 * imagem —, e para isso os primeiros bytes bastam.
 */
function assertLooksLikeCSharp(content: Buffer): void {
  const head = content.subarray(0, 4_096).toString('utf8');

  if (/\b(using|namespace|class)\b/.test(head) || head.includes('[Info(')) {
    return;
  }

  throw new ApiError(
    'INVALID_PLUGIN_CONTENT',
    'O arquivo enviado não parece um plugin em C#: não achei "using", "namespace", "class" ' +
      'nem o atributo [Info(...)] no começo dele. Envie o .cs do plugin, não o zip.',
    400,
  );
}

/**
 * As três recusas de CONTEÚDO, num lugar só.
 *
 * Exportada porque a biblioteca (oxide/library.ts) grava o mesmo
 * `.cs` numa pasta diferente e precisa exatamente destas travas.
 * Uma segunda cópia delas lá seria a que um dia deixaria de
 * conferir o tamanho — e o Oxide passaria a tentar compilar um zip
 * em laço, enchendo o log do servidor.
 *
 * @throws {ApiError} 400.
 */
export function assertPluginContent(content: Buffer): void {
  if (content.length === 0) {
    throw new ApiError('EMPTY_PLUGIN', 'O arquivo enviado está vazio.', 400);
  }

  if (content.length > MAX_PLUGIN_BYTES) {
    throw new ApiError(
      'PLUGIN_TOO_LARGE',
      `O arquivo tem ${String(Math.round(content.length / 1024))} KB e o limite é ` +
        `${String(MAX_PLUGIN_BYTES / 1024)} KB. Um plugin de Rust não chega perto disso — ` +
        'confira se você não enviou um zip por engano.',
      400,
    );
  }

  assertLooksLikeCSharp(content);
}

async function sendPluginCommand(rcon: OpsRcon, command: string): Promise<PluginReloadResult> {
  if (!rcon.isConnected) {
    // Servidor parado NÃO é erro aqui: o arquivo está no lugar, e
    // o Oxide o carrega no próximo start. Dizer isso é melhor que
    // recusar o upload.
    return { sent: false, output: null };
  }

  try {
    return { sent: true, output: await rcon.send(command) };
  } catch (error) {
    return { sent: false, output: toError(error).message };
  }
}

export function reloadPlugin(rcon: OpsRcon, plugin: string): Promise<PluginReloadResult> {
  return sendPluginCommand(rcon, `oxide.reload ${plugin}`);
}

/**
 * Grava o `.cs` e manda o Oxide recarregar.
 *
 * ####  GRAVAR E CARREGAR SÃO COISAS DIFERENTES  ####
 *
 * O arquivo pode ser gravado com sucesso e o plugin não compilar.
 * Por isso o resultado tem os dois campos: quem chamou responde
 * `ok: true` (o upload funcionou) e mostra `reload.output` — que
 * é onde está o erro de compilação. Misturar os dois faria o
 * operador achar que o envio falhou, e reenviar o mesmo arquivo.
 */
export async function installPlugin(options: InstallPluginOptions): Promise<InstallPluginResult> {
  const target = pluginPath(options.pluginsDir, options.name);

  assertPluginContent(options.content);

  await mkdir(options.pluginsDir, { recursive: true });

  try {
    await writeFile(target, options.content);
  } catch (error) {
    throw new ApiError(
      'PLUGIN_WRITE_FAILED',
      `Não consegui gravar ${target}: ${toError(error).message}.`,
      500,
    );
  }

  const reload = await reloadPlugin(options.rcon, options.name.slice(0, -3));

  return { name: options.name, bytes: options.content.length, reload };
}

/** Apaga o `.cs` e descarrega o plugin. */
export async function removePlugin(
  pluginsDir: string,
  name: string,
  rcon: OpsRcon,
): Promise<PluginReloadResult> {
  const target = pluginPath(pluginsDir, name);

  // Descarregar ANTES de apagar: o Oxide vigia a pasta e, ao ver
  // o arquivo sumir, descarrega sozinho — mas com o servidor
  // parado essa vigia não existe, e a ordem inversa deixaria o
  // plugin carregado até o próximo restart.
  const unload = await sendPluginCommand(rcon, `oxide.unload ${name.slice(0, -3)}`);

  try {
    await rm(target, { force: true });
  } catch (error) {
    throw new ApiError(
      'PLUGIN_REMOVE_FAILED',
      `Não consegui apagar ${target}: ${toError(error).message}.`,
      500,
    );
  }

  return unload;
}
