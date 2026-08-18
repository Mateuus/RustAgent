// ============================================================
//  steamcmd.ts  -  o cliente da Steam: garantir que ele existe, e
//  usá-lo para instalar/atualizar um servidor.
//
//  ####  UM SÓ, PARA A MÁQUINA INTEIRA  ####
//
//  `SteamCMD\steamcmd.exe`, na raiz do projeto. O que muda por
//  servidor é o `+force_install_dir`. Duplicar o cliente por
//  servidor gastaria disco para criar o problema de dois
//  processos disputando o mesmo lock do Steam.
//
//  ####  INSTALAR É A MESMA OPERAÇÃO QUE ATUALIZAR  ####
//
//  `+app_update` baixa os ~6 GB na primeira vez e aplica a
//  diferença nas seguintes. Por isso não existe uma função
//  "instalar" e outra "atualizar" — existe esta.
// ============================================================

import { existsSync } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { run } from '../ops/run.js';
import { extractZip } from '../util/zip.js';

/** De onde o cliente é baixado. É a URL oficial da Valve. */
const STEAMCMD_ZIP_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

/** O AppID do RUST DEDICATED SERVER (não é o do jogo). */
export const RUST_APP_ID = '258550';

export interface SteamCmdOptions {
  /** `SteamCMD\` — a pasta do cliente. */
  readonly dir: string;
  readonly onLine: (line: string) => void;
  readonly signal?: AbortSignal;
}

export function steamCmdExe(dir: string): string {
  return join(dir, 'steamcmd.exe');
}

/**
 * Garante que o `steamcmd.exe` existe e está atualizado.
 *
 * Idempotente: com o cliente já em disco, custa só o auto-update
 * dele.
 *
 * ####  A PRIMEIRA EXECUÇÃO DEMORA, E ISSO PRECISA APARECER  ####
 *
 * `steamcmd.exe +quit` baixa o resto do cliente na primeira vez —
 * são alguns minutos sem nada de interessante no log. Sem uma
 * linha dizendo isso, a tela parece travada e alguém cancela.
 */
export async function ensureSteamCmd(options: SteamCmdOptions): Promise<string> {
  const exe = steamCmdExe(options.dir);

  if (!existsSync(exe)) {
    options.onLine('[SteamCMD] cliente não encontrado — baixando...');

    await mkdir(options.dir, { recursive: true });

    let archive: Buffer;

    try {
      const response = await fetch(STEAMCMD_ZIP_URL, { signal: options.signal });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }

      archive = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new Error(
        `não consegui baixar o SteamCMD de ${STEAMCMD_ZIP_URL} ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          'Confira a conexão desta máquina com a internet.',
      );
    }

    options.onLine('[SteamCMD] extraindo...');
    await extractZip(archive, options.dir);

    if (!existsSync(exe)) {
      throw new Error(
        `o zip do SteamCMD foi baixado e extraído, mas ${exe} não apareceu. ` +
          'Apague a pasta SteamCMD\\ e tente de novo.',
      );
    }
  }

  options.onLine('[SteamCMD] atualizando o cliente (na primeira vez isso leva alguns minutos)...');

  // `+quit` sozinho é o auto-update do próprio cliente. O código
  // de saída aqui não é confiável entre versões — o que vale é o
  // `app_update` seguinte funcionar.
  await run({
    command: exe,
    args: ['+quit'],
    cwd: options.dir,
    onLine: options.onLine,
    timeoutMs: 20 * 60_000,
    signal: options.signal,
  });

  return exe;
}

export interface AppUpdateOptions extends SteamCmdOptions {
  /** `Servers\<id>\` — o `+force_install_dir`. */
  readonly installDir: string;
  readonly appId: string;
  readonly login: string;
  /** `public`, `staging`… Vazio ou `public` não passa `-beta`. */
  readonly branch: string;
  /** Chamado com 0–100 conforme o download anda. */
  readonly onProgress?: (percent: number) => void;
}

/** Quantas execuções do `app_update` antes de desistir. */
const MAX_APP_UPDATE_ATTEMPTS = 3;

/** Respiro entre uma tentativa e a seguinte. */
const RETRY_DELAY_MS = 15_000;

export interface AppUpdateResult {
  /** Quantas execuções do `app_update` foram necessárias. */
  readonly attempts: number;
}

/**
 * `+app_update <appId> validate` naquela pasta.
 *
 * `validate` sempre: ele confere o hash de cada arquivo e
 * rebaixa o que estiver corrompido. Custa I/O e evita a classe de
 * defeito mais cara que existe aqui — um servidor que sobe com um
 * assembly meio gravado e cai minutos depois, com jogadores
 * dentro.
 *
 * ------------------------------------------------------------
 * ####  O CÓDIGO DE SAÍDA NÃO SERVE. A SAÍDA SERVE.  ####
 *
 * O SteamCMD sai 0 em falhas de rede e sai 7/8 em execuções que
 * deram certo, dependendo da versão — por isso o código é só
 * registrado. O que NÃO é ambíguo é a linha de erro dele:
 *
 *     Error! App '258550' state is 0x486 after update job.
 *
 * Essa linha significa que o job terminou e o app continua fora
 * de ordem. Antes, ela passava batida e o agente seguia para o
 * Oxide, subia o servidor e anunciava "jogo instalado" com o
 * build VELHO em disco — que é a pior saída possível, porque o
 * servidor desatualizado recusa todo mundo em silêncio.
 *
 * ####  TENTAR DE NOVO ANTES DE DESISTIR  ####
 *
 * Boa parte desses erros é conteúdo parcial estragado em
 * `steamapps\downloading` e some na execução seguinte. Então são
 * três tentativas, apagando o download parcial entre elas. O que
 * NÃO se apaga é o `appmanifest` nem os arquivos do jogo: isso
 * transformaria uma atualização de 300 MB numa reinstalação de
 * 25 GB sem ninguém pedir.
 */
export async function appUpdate(options: AppUpdateOptions): Promise<AppUpdateResult> {
  const exe = await ensureSteamCmd(options);

  await mkdir(options.installDir, { recursive: true });

  const args = [
    '+force_install_dir',
    options.installDir,
    '+login',
    options.login,
    '+app_update',
    options.appId,
  ];

  if (options.branch !== '' && options.branch !== 'public') {
    args.push('-beta', options.branch);
  }

  args.push('validate', '+quit');

  let failure: string | null = null;

  for (let attempt = 1; attempt <= MAX_APP_UPDATE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await clearPartialDownload(options);
      await delay(RETRY_DELAY_MS, options.signal);

      if (options.signal?.aborted === true) {
        throw new Error('o SteamCMD foi cancelado entre as tentativas.');
      }
    }

    options.onLine(
      `[SteamCMD] baixando/validando o app ${options.appId} ` +
        `(branch ${options.branch || 'public'}) em ${options.installDir}` +
        (attempt > 1 ? ` — tentativa ${String(attempt)} de ${String(MAX_APP_UPDATE_ATTEMPTS)}` : ''),
    );

    failure = null;

    const result = await run({
      command: exe,
      args,
      cwd: options.dir,
      onLine: (line) => {
        const percent = progressOf(line);

        if (percent !== null) {
          options.onProgress?.(percent);
        }

        // O PRIMEIRO erro é o que vale: os seguintes costumam ser
        // consequência dele.
        failure ??= steamCmdFailure(line);

        options.onLine(line);
      },
      // Três horas: uma primeira instalação de 6 GB numa conexão
      // ruim passa de uma hora, e o timeout existe só para não
      // deixar um processo travado segurando a trava para sempre.
      timeoutMs: 3 * 60 * 60_000,
      signal: options.signal,
    });

    if (result.killed) {
      throw new Error(
        'o SteamCMD foi interrompido (cancelamento ou tempo esgotado). A instalação ficou ' +
          'incompleta — rode a operação de novo: ele continua de onde parou.',
      );
    }

    if (result.code !== 0) {
      options.onLine(`[SteamCMD] terminou com código ${String(result.code)}`);
    }

    if (failure === null) {
      return { attempts: attempt };
    }

    options.onLine(`[SteamCMD] esta execução NÃO deu certo: ${failure}`);
  }

  throw new Error(await appUpdateFailureMessage(options, failure));
}

/**
 * O download parcial, que é o suspeito nº 1 de um job que morre
 * sem baixar nada.
 *
 * Apagar isto é seguro: são pedaços do próximo build, não o jogo
 * instalado. Falha em apagar não interrompe nada — a tentativa
 * seguinte pode dar certo mesmo assim.
 */
async function clearPartialDownload(options: AppUpdateOptions): Promise<void> {
  const partial = join(options.installDir, 'steamapps', 'downloading', options.appId);

  if (!existsSync(partial)) {
    return;
  }

  options.onLine(`[SteamCMD] apagando o download parcial em ${partial}...`);

  try {
    await rm(partial, { recursive: true, force: true });
  } catch (error) {
    options.onLine(
      `[SteamCMD] não consegui apagar o download parcial ` +
        `(${error instanceof Error ? error.message : String(error)}) — seguindo assim mesmo.`,
    );
  }
}

/** A recusa final: o que falhou, e o que olhar por causa disso. */
async function appUpdateFailureMessage(
  options: AppUpdateOptions,
  failure: string | null,
): Promise<string> {
  const free = await freeSpaceGb(options.installDir);
  const disk =
    free === null
      ? 'não consegui medir o espaço livre nesse disco'
      : `livre no disco de ${options.installDir}: ${free.toFixed(1)} GB`;

  return (
    `o SteamCMD não conseguiu atualizar o app ${options.appId} em ` +
    `${String(MAX_APP_UPDATE_ATTEMPTS)} tentativas — ${failure ?? 'motivo não identificado'}. ` +
    'O build ANTIGO continua em disco: nada foi trocado. As causas, na ordem em que valem ' +
    `a pena conferir: (1) espaço — uma atualização do Rust precisa de folga de dezenas de GB, e ${disk}; ` +
    '(2) arquivo em uso — veja se sobrou um RustDedicated.exe rodando, e tire a pasta do servidor ' +
    'do caminho do antivírus e do backup; (3) permissão de escrita na pasta do servidor. ' +
    'Depois de resolver, mande a operação de novo.'
  );
}

/** Espaço livre em GB no disco daquele caminho. `null` se não der. */
async function freeSpaceGb(path: string): Promise<number | null> {
  try {
    const stat = await statfs(path);

    return (stat.bsize * stat.bavail) / 1024 ** 3;
  } catch {
    return null;
  }
}

/**
 * A linha é um erro do SteamCMD? Devolve a frase que explica.
 *
 * `null` para a esmagadora maioria das linhas — inclusive as que
 * têm a palavra "error" e não são falha do job (o SteamCMD
 * redireciona o stderr e anuncia isso em toda execução).
 */
export function steamCmdFailure(line: string): string | null {
  const state = /Error!\s*App\s*'([^']+)'\s*state is\s*(0x[0-9a-f]+)/i.exec(line);

  if (state?.[2] !== undefined) {
    return (
      `o job terminou com o app no estado ${state[2]} (${explainAppState(state[2])}) — ` +
      'ou seja, a atualização NÃO foi aplicada'
    );
  }

  const failedInstall = /(?:ERROR!?)\s*Failed to install app\s*'?([^'\s]+)'?\s*(?:\(([^)]+)\))?/i.exec(
    line,
  );

  if (failedInstall !== null) {
    return `o SteamCMD recusou instalar o app${
      failedInstall[2] === undefined ? '' : `: ${failedInstall[2]}`
    }`;
  }

  if (/Disk write failure|No space left|not enough (?:free )?disk space/i.test(line)) {
    return 'faltou espaço em disco (ou a escrita foi recusada)';
  }

  if (/Login Failure|FAILED \(Invalid Password\)|Invalid Platform/i.test(line)) {
    return 'o login na Steam falhou';
  }

  if (/Timeout downloading|Connection to Steam servers lost/i.test(line)) {
    return 'a conexão com a Steam caiu no meio do download';
  }

  return null;
}

/**
 * `StateFlags` em português.
 *
 * É um CAMPO DE BITS, e vários acendem juntos: `0x486` é
 * "instalado por completo + atualização pendente + arquivos
 * corrompidos + atualização começada e não terminada" — o retrato
 * exato de um job que abortou no meio.
 */
export function explainAppState(hex: string): string {
  const value = Number.parseInt(hex, 16);

  if (!Number.isFinite(value)) {
    return 'estado desconhecido';
  }

  const names: ReadonlyArray<readonly [number, string]> = [
    [1, 'não instalado'],
    [2, 'atualização pendente'],
    [4, 'instalado por completo'],
    [8, 'criptografado'],
    [16, 'travado'],
    [32, 'arquivos faltando'],
    [64, 'jogo em execução'],
    [128, 'arquivos corrompidos'],
    [256, 'atualização em curso'],
    [512, 'atualização pausada'],
    [1024, 'atualização começada e não terminada'],
    [2048, 'desinstalando'],
    [4096, 'backup em curso'],
  ];

  const parts = names.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);

  return parts.length === 0 ? 'estado desconhecido' : parts.join(' + ');
}

/** Espera que desiste junto com o cancelamento da operação. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * O percentual de uma linha de progresso do SteamCMD.
 *
 *     Update state (0x61) downloading, progress: 42.15 (2695091 / 6394838)
 *
 * `null` quando a linha não é de progresso — que é a maioria.
 */
export function progressOf(line: string): number | null {
  const match = /progress:\s*([\d.]+)/i.exec(line);

  if (match?.[1] === undefined) {
    return null;
  }

  const value = Number(match[1]);

  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}
