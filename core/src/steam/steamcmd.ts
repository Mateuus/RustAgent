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
import { mkdir } from 'node:fs/promises';
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

/**
 * `+app_update <appId> validate` naquela pasta.
 *
 * `validate` sempre: ele confere o hash de cada arquivo e
 * rebaixa o que estiver corrompido. Custa I/O e evita a classe de
 * defeito mais cara que existe aqui — um servidor que sobe com um
 * assembly meio gravado e cai minutos depois, com jogadores
 * dentro.
 */
export async function appUpdate(options: AppUpdateOptions): Promise<void> {
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

  options.onLine(
    `[SteamCMD] baixando/validando o app ${options.appId} ` +
      `(branch ${options.branch || 'public'}) em ${options.installDir}`,
  );

  const result = await run({
    command: exe,
    args,
    cwd: options.dir,
    onLine: (line) => {
      const percent = progressOf(line);

      if (percent !== null) {
        options.onProgress?.(percent);
      }

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

  // ####  O CÓDIGO DE SAÍDA DO STEAMCMD NÃO É CONFIÁVEL  ####
  //
  // Ele sai 0 em falhas de rede e sai 7/8 em execuções que deram
  // certo, dependendo da versão. Quem decide se funcionou é o
  // EXECUTÁVEL DO JOGO estar em disco, e essa conferência é de
  // quem chamou (ops/service.ts) — que também sabe o nome do
  // arquivo a procurar.
  if (result.code !== 0) {
    options.onLine(`[SteamCMD] terminou com código ${String(result.code)}`);
  }
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
