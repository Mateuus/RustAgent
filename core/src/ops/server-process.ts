// ============================================================
//  server-process.ts  -  subir, achar e derrubar o
//  RustDedicated.exe.
//
//  ####  O SERVIDOR NÃO É FILHO DO AGENTE  ####
//
//  Ele sobe DESTACADO (`detached`, `stdio: 'ignore'`). Reiniciar
//  o agente — `pm2 restart`, um `git pull` no dedicado — não pode
//  derrubar quem está jogando. Reiniciar o agente é rotina;
//  derrubar o servidor é evento.
//
//  A consequência é que o agente PRECISA REDESCOBRIR os processos
//  a cada boot, e é isso que `findServerProcess` faz: varre os
//  `RustDedicated.exe` da máquina e casa cada um com o servidor
//  dele pela LINHA DE COMANDO (`+server.identity`, `+rcon.port`).
//
//  Guardar o PID num arquivo seria mais simples e estaria errado:
//  o Windows recicla PID, e um PID reciclado aponta para OUTRO
//  processo — que o agente mataria achando que era o servidor.
// ============================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { ServerConfig } from '../config.js';
import { run } from './run.js';

export const RUST_DEDICATED_EXE = 'RustDedicated.exe';

export interface RustProcessInfo {
  readonly pid: number;
  readonly commandLine: string;
}

/**
 * Os `RustDedicated.exe` que estão rodando nesta máquina.
 *
 * Sai por `wmic`, e não pela lista de processos do Node: só o
 * `wmic` dá a LINHA DE COMANDO, que é a única coisa que liga um
 * processo ao servidor dele. Sem ela, dois servidores na mesma
 * máquina são dois processos idênticos.
 */
export async function listRustProcesses(): Promise<readonly RustProcessInfo[]> {
  const lines: string[] = [];

  try {
    await run({
      command: 'wmic',
      args: [
        'process',
        'where',
        `name='${RUST_DEDICATED_EXE}'`,
        'get',
        'ProcessId,CommandLine',
        '/format:list',
      ],
      onLine: (line) => lines.push(line),
      timeoutMs: 30_000,
    });
  } catch {
    // `wmic` foi marcado como obsoleto e pode não existir. Sem
    // ele o agente não descobre processo nenhum — o que degrada
    // para "não sei se está no ar", nunca para uma afirmação
    // errada. O PowerShell é o plano B.
    return listRustProcessesViaPowerShell();
  }

  return parseProcessList(lines);
}

async function listRustProcessesViaPowerShell(): Promise<readonly RustProcessInfo[]> {
  const lines: string[] = [];

  try {
    await run({
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "name='${RUST_DEDICATED_EXE}'" | ` +
          'ForEach-Object { "CommandLine=" + $_.CommandLine; "ProcessId=" + $_.ProcessId }',
      ],
      onLine: (line) => lines.push(line),
      timeoutMs: 30_000,
    });
  } catch {
    return [];
  }

  return parseProcessList(lines);
}

/**
 * A saída em `CHAVE=valor` do `wmic /format:list`.
 *
 * Exportada por causa do teste: casar processo com servidor é a
 * peça que, errando, faz o agente matar o servidor errado.
 */
export function parseProcessList(lines: readonly string[]): readonly RustProcessInfo[] {
  const found: RustProcessInfo[] = [];
  let commandLine = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('CommandLine=')) {
      commandLine = trimmed.slice('CommandLine='.length);
      continue;
    }

    if (trimmed.startsWith('ProcessId=')) {
      const pid = Number(trimmed.slice('ProcessId='.length));

      if (Number.isInteger(pid) && pid > 0) {
        found.push({ pid, commandLine });
      }

      commandLine = '';
    }
  }

  return found;
}

/**
 * O valor de `+chave valor` numa linha de comando.
 *
 * O Rust aceita o valor com ou sem aspas, e o `.ini` pode ter
 * hostname com espaço — daí as duas formas.
 */
export function commandLineValue(commandLine: string, key: string): string | null {
  const quoted = new RegExp(`\\+${key}\\s+"([^"]*)"`, 'i').exec(commandLine);

  if (quoted?.[1] !== undefined) {
    return quoted[1];
  }

  const bare = new RegExp(`\\+${key}\\s+(\\S+)`, 'i').exec(commandLine);

  return bare?.[1] ?? null;
}

/**
 * O processo daquele servidor, ou `null`.
 *
 * A identificação é por `+server.identity` OU `+rcon.port`: a
 * identity sozinha se repete entre instalações antigas, e a porta
 * sozinha some quando alguém sobe o servidor à mão sem ela.
 */
export async function findServerProcess(server: ServerConfig): Promise<RustProcessInfo | null> {
  const processes = await listRustProcesses();

  return (
    processes.find((process) => {
      const identity = commandLineValue(process.commandLine, 'server\\.identity');
      const rconPort = commandLineValue(process.commandLine, 'rcon\\.port');

      return identity === server.identity || rconPort === String(server.ports.rcon);
    }) ?? null
  );
}

/** A porta está livre NESTA máquina? */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();

    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });

    probe.listen(port, '0.0.0.0');
  });
}

export interface StartServerOptions {
  readonly server: ServerConfig;
  readonly onLine: (line: string) => void;
}

/**
 * A linha de comando do jogo, montada a partir do `.ini`.
 *
 * Exportada porque ela é o que o teste inspeciona: um argumento
 * trocado aqui é um mundo diferente do que a pessoa configurou, e
 * o sintoma só aparece minutos depois, com o mapa já gerado.
 */
export function serverArgs(server: ServerConfig, logFile: string): string[] {
  const args = [
    '-batchmode',
    '-nographics',
    '+server.hostname',
    server.hostname,
    '+server.identity',
    server.identity,
    '+server.level',
    server.level,
    '+server.seed',
    String(server.seed),
    '+server.worldsize',
    String(server.worldSize),
    '+server.maxplayers',
    String(server.maxPlayers),
    '+server.port',
    String(server.ports.game),
    '+server.queryport',
    String(server.ports.query),
    '+server.saveinterval',
    String(server.saveInterval),
    '+app.port',
    String(server.ports.app),
    '+rcon.port',
    String(server.ports.rcon),
    '+rcon.password',
    server.rcon.password,
    // Sempre 1: o agente fala WebRCON. O config.ts já recusa um
    // `.ini` com RCON_WEB=0, então isto nunca contradiz o arquivo.
    '+rcon.web',
    '1',
  ];

  // Os opcionais só entram quando preenchidos: `+server.url ""`
  // faz o jogo mostrar um botão de site que não leva a lugar
  // nenhum.
  if (server.description !== '') {
    args.push('+server.description', server.description);
  }

  if (server.url !== '') {
    args.push('+server.url', server.url);
  }

  if (server.headerImage !== '') {
    args.push('+server.headerimage', server.headerImage);
  }

  args.push('-logfile', logFile);

  return args;
}

export interface StartedServer {
  readonly pid: number;
  readonly logFile: string;
}

/**
 * Sobe o `RustDedicated.exe` daquele servidor, destacado.
 *
 * Devolve assim que o processo nasce — e isso NÃO quer dizer que
 * o servidor está no ar. Quem espera o RCON responder é
 * `ops/service.ts`: gerar um mapa procedural leva minutos, e
 * durante todo esse tempo o processo existe sem aceitar ninguém.
 *
 * @throws quando o jogo não está instalado ou uma das portas já
 * está ocupada. As duas com a frase pronta para a tela.
 */
export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  const { server } = options;

  if (!existsSync(server.paths.exePath)) {
    throw new Error(
      `${server.paths.exePath} não existe. O jogo ainda não foi instalado neste servidor — ` +
        'use a operação Instalar.',
    );
  }

  for (const [field, port] of Object.entries(server.ports)) {
    if (!(await isPortFree(port))) {
      throw new Error(
        `a porta ${String(port)} (${field}) já está ocupada nesta máquina. Outro servidor ` +
          'pode estar no ar, ou outro programa pegou a porta. Confira antes de subir.',
      );
    }
  }

  await mkdir(server.paths.logsDir, { recursive: true });

  const logFile = join(server.paths.logsDir, `server-${server.identity}.log`);

  options.onLine(`[agente] subindo ${server.paths.exePath}`);
  options.onLine(`[agente] log do jogo: ${logFile}`);

  // ####  O CAMINHO É ABSOLUTO, E O cwd É OBRIGATÓRIO  ####
  //
  // Absoluto porque, chamado pelo nome, o executável só é achado
  // quando o pai procura no diretório atual — busca que está
  // DESLIGADA em parte dos ambientes
  // (NoDefaultCurrentDirectoryInExePath, herdada sem avisar). O
  // sintoma é cruel: funciona pelo Explorer e falha pelo serviço.
  //
  // E o `cwd` porque o jogo grava saves e configuração relativos
  // ao diretório de trabalho — sem ele, o mundo do servidor iria
  // parar na pasta do agente.
  const child = spawn(server.paths.exePath, serverArgs(server, logFile), {
    cwd: server.paths.installDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  // `unref` completa o desacoplamento: sem ele, o agente não
  // consegue sair enquanto o servidor estiver de pé.
  child.unref();

  if (child.pid === undefined) {
    throw new Error('o processo do servidor não nasceu (sem PID). Veja o log do agente.');
  }

  return { pid: child.pid, logFile };
}

/**
 * Mata o processo à força, com a árvore.
 *
 * ####  ISTO É O ÚLTIMO RECURSO, NÃO O JEITO DE PARAR  ####
 *
 * O jeito de parar salvando o mundo é `quit` pelo RCON — quem faz
 * isso é `ops/service.ts`. Esta função existe para quando o RCON
 * não responde ou o processo ignorou o `quit`, e o que ela custa
 * é tudo desde o último `server.saveinterval`.
 */
export async function killServerProcess(pid: number): Promise<void> {
  await run({
    command: 'taskkill',
    args: ['/PID', String(pid), '/T', '/F'],
    onLine: () => {},
    timeoutMs: 30_000,
  });
}
