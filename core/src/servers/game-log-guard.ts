// ============================================================
//  game-log-guard.ts  -  o teto do `-logfile` do jogo.
//
//  ####  O CASO QUE O CRIOU  ####
//
//  Em 11/09/2026 o `server-oz-vanilla.log` tinha 46,7 GB e o dono
//  teve de apagá-lo à mão. Era UMA execução só do jogo: um
//  `ScarecrowNPC` sem navmesh por perto lançava NullReferenceException
//  a cada "think", com a pilha inteira, dezenas de vezes por
//  segundo, durante dias.
//
//  Quem escreve o arquivo é o PRÓPRIO RustDedicated (o Unity, pelo
//  `-logfile` que server-process.ts passa). O agente não está no
//  caminho de nenhuma linha — então não dá para filtrar, só para
//  limitar o que fica em disco.
//
//  ####  POR QUE NÃO TRUNCAR  ####
//
//  Medido no server01 em 11/09/2026: o Unity abre o arquivo
//  compartilhando escrita (truncar com o jogo vivo é aceito), mas
//  ESCREVE POR POSIÇÃO, não em modo append. Truncado para zero, a
//  linha seguinte caiu no MESMO offset de antes — e o começo virou
//  2,2 MB de bytes nulos. Em produção, truncar devolveria um
//  arquivo do mesmo tamanho, feito de zeros.
//
//  E rotacionar no boot também não resolve: o Unity SOBRESCREVE o
//  arquivo a cada subida. Os 46 GB cresceram entre um boot e outro.
//
//  ####  O QUE FUNCIONA: DEVOLVER O COMEÇO AO DISCO  ####
//
//  O arquivo vira ESPARSO (FSCTL_SET_SPARSE) e o trecho antigo é
//  desalocado (FSCTL_SET_ZERO_DATA). O jogo continua escrevendo no
//  offset dele, sem saber de nada; o NTFS só deixa de guardar o que
//  ficou para trás. Medido com o jogo vivo: a escrita seguinte
//  entrou normalmente no fim, e o trecho liberado continuou livre.
//
//  O efeito que o admin vê: no Explorer o "Tamanho" continua
//  grande, e o "Tamanho em disco" cai para o que foi mantido. O
//  começo, lido, vem como zeros. Quem abre o arquivo para ler o
//  FIM — a rota `/console/file`, um `Get-Content -Tail` — não nota
//  diferença.
//
//  ####  QUEM DECIDE É O ESPAÇO ALOCADO, NÃO O TAMANHO  ####
//
//  Depois da primeira desalocação o tamanho lógico nunca mais cai
//  abaixo do teto, e decidir por ele desalocaria a cada rodada. O
//  `stat` do Node devolve os blocos alocados de verdade no Windows
//  (o libuv lê o AllocationSize), e é por eles que o vigia olha —
//  sem guardar estado entre rodadas nem entre reinícios do agente.
//
//  O `fsutil sparse setrange` faria o mesmo e NÃO serve: ele pede
//  o arquivo sem compartilhamento e falha com "arquivo em uso"
//  enquanto o jogo roda. Daí o PowerShell com a IOCTL chamada à
//  mão, num handle que compartilha leitura, escrita e exclusão.
// ============================================================

import { stat } from 'node:fs/promises';

import type { ServerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { run } from '../ops/run.js';
import { gameLogPath } from '../ops/server-process.js';
import { toError } from '../util.js';

const MB = 1024 * 1024;

/** Acima disto EM DISCO, o começo do log é devolvido. */
export const DEFAULT_GAME_LOG_MAX_BYTES = 1024 * MB;

/**
 * Quanto do FIM fica guardado depois de uma desalocação.
 *
 * Folga de sobra para a rota `/console/file`, que lê só os
 * últimos 512 KB, e para quem precisa olhar as últimas horas de um
 * servidor que está inundando o log.
 */
export const DEFAULT_GAME_LOG_KEEP_BYTES = 64 * MB;

export const DEFAULT_GAME_LOG_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * A fronteira da desalocação cai num múltiplo disto.
 *
 * O NTFS só devolve CLUSTERS inteiros — o pedaço de um cluster
 * cortado ao meio é zerado e continua alocado. 64 KB é o maior
 * cluster que o NTFS usa por padrão, então alinhar aqui nunca
 * deixa meia fatia para trás.
 */
const RELEASE_ALIGNMENT = 64 * 1024;

/**
 * Até onde desalocar, ou `null` quando não é hora.
 *
 * Pura e exportada por causa do teste: é a conta que, errando para
 * o lado de lá, apagaria o fim do log que alguém está lendo.
 */
export function releaseBoundary(
  sizeBytes: number,
  allocatedBytes: number,
  maxBytes: number,
  keepBytes: number,
): number | null {
  if (allocatedBytes <= maxBytes) {
    return null;
  }

  const end = sizeBytes - keepBytes;
  const aligned = end - (end % RELEASE_ALIGNMENT);

  return aligned > 0 ? aligned : null;
}

/** Aspas simples do PowerShell: a única coisa a escapar é a própria aspa. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// O `'@` que fecha o here-string PRECISA estar na coluna zero —
// indentado, o PowerShell recusa o script inteiro.
//
// As duas primeiras linhas limpam a mensagem de erro que volta ao
// log do agente: sem o `ProgressPreference`, o "Preparando módulos"
// do primeiro uso chega serializado em CLIXML no stderr; sem o
// UTF-8, "não" chega como "n?o".
function releaseScript(path: string, endBytes: number): string {
  return `$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RustAgentSparseLog {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);

  const uint GENERIC_WRITE = 0x40000000;
  const uint SHARE_ALL = 7;
  const uint OPEN_EXISTING = 3;
  const uint FSCTL_SET_SPARSE = 0x000900C4;
  const uint FSCTL_SET_ZERO_DATA = 0x000980C8;

  public static void Release(string path, long end) {
    using (SafeFileHandle handle = CreateFileW(path, GENERIC_WRITE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      int returned;
      if (!DeviceIoControl(handle, FSCTL_SET_SPARSE, null, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] range = new byte[16];
      BitConverter.GetBytes(0L).CopyTo(range, 0);
      BitConverter.GetBytes(end).CopyTo(range, 8);
      if (!DeviceIoControl(handle, FSCTL_SET_ZERO_DATA, range, 16, IntPtr.Zero, 0, out returned, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
[RustAgentSparseLog]::Release(${psLiteral(path)}, ${String(endBytes)})
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
}

/**
 * Desaloca `[0, endBytes)` do arquivo, com o jogo escrevendo nele.
 *
 * @throws quando o PowerShell não roda ou a IOCTL é recusada — com
 * a mensagem do Windows junto.
 */
export async function releaseLogHead(path: string, endBytes: number): Promise<void> {
  if (!Number.isSafeInteger(endBytes) || endBytes <= 0) {
    throw new Error(`fronteira de desalocação inválida: ${String(endBytes)}`);
  }

  const lines: string[] = [];

  // `-EncodedCommand` e não `-Command`: o script tem aspas, `@'`
  // e quebras de linha, e em base64 nada disso passa pelas regras
  // de citação da linha de comando do Windows.
  const { code, killed } = await run({
    command: 'powershell',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(releaseScript(path, endBytes), 'utf16le').toString('base64'),
    ],
    onLine: (line) => lines.push(line),
    timeoutMs: 60_000,
  });

  if (code !== 0 || killed) {
    const detail = lines.join(' ').trim();

    throw new Error(
      killed
        ? 'o PowerShell não terminou em 60 s ao desalocar o log do jogo'
        : `o PowerShell saiu com ${String(code)} ao desalocar o log do jogo` +
            (detail === '' ? '' : `: ${detail}`),
    );
  }
}

export interface GameLogServers {
  ids(): readonly string[];
  configOf(id: string): ServerConfig | null;
}

export interface GameLogGuardOptions {
  readonly servers: GameLogServers;
  readonly logger: Logger;
  readonly maxBytes?: number;
  readonly keepBytes?: number;
  readonly intervalMs?: number;
  /** A desalocação em si. Trocável no teste; o padrão é `releaseLogHead`. */
  readonly release?: (path: string, endBytes: number) => Promise<void>;
}

export class GameLogGuard {
  readonly #servers: GameLogServers;
  readonly #logger: Logger;
  readonly #maxBytes: number;
  readonly #keepBytes: number;
  readonly #intervalMs: number;
  readonly #release: (path: string, endBytes: number) => Promise<void>;

  #timer: NodeJS.Timeout | null = null;
  /** Uma rodada por vez: duas desalocando o mesmo arquivo não ajudam em nada. */
  #running = false;

  constructor(options: GameLogGuardOptions) {
    this.#servers = options.servers;
    this.#logger = options.logger;
    this.#maxBytes = options.maxBytes ?? DEFAULT_GAME_LOG_MAX_BYTES;
    // Guardar mais do que o teto faria toda rodada passar do teto
    // e desalocar nada — o vigia bateria para sempre em vão.
    this.#keepBytes = Math.min(
      options.keepBytes ?? DEFAULT_GAME_LOG_KEEP_BYTES,
      Math.floor(this.#maxBytes / 2),
    );
    this.#intervalMs = options.intervalMs ?? DEFAULT_GAME_LOG_CHECK_INTERVAL_MS;
    this.#release = options.release ?? releaseLogHead;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);

    this.#timer.unref();

    this.#logger.info(
      {
        maxMb: Math.round(this.#maxBytes / MB),
        keepMb: Math.round(this.#keepBytes / MB),
        intervalSeconds: Math.round(this.#intervalMs / 1000),
      },
      'vigia do tamanho do log do jogo ligado',
    );

    // A rodada do boot: um log que inchou com o agente parado não
    // precisa esperar cinco minutos para ser contido.
    void this.sweep();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Uma passada por todos os servidores configurados.
   *
   * Todos, e não só os ligados: "desligado" é o agente não cuidar
   * do servidor, e o processo do jogo pode continuar de pé,
   * escrevendo.
   *
   * Nunca lança: um servidor com problema não pode deixar os
   * outros sem teto.
   */
  async sweep(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;

    try {
      for (const id of this.#servers.ids()) {
        const config = this.#servers.configOf(id);

        if (config !== null) {
          await this.#checkOne(id, gameLogPath(config));
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #checkOne(serverId: string, path: string): Promise<void> {
    let sizeBytes: number;
    let allocatedBytes: number;

    try {
      const info = await stat(path);

      sizeBytes = info.size;
      // Sem `blocks` (sistema de arquivos que não informa), o tamanho
      // lógico é o palpite conservador: pode desalocar de novo o que
      // já estava livre, o que é inofensivo.
      allocatedBytes = Number.isFinite(info.blocks) && info.blocks > 0 ? info.blocks * 512 : info.size;
    } catch {
      // Sem arquivo é o estado normal de um servidor que nunca subiu.
      return;
    }

    const end = releaseBoundary(sizeBytes, allocatedBytes, this.#maxBytes, this.#keepBytes);

    if (end === null) {
      return;
    }

    try {
      await this.#release(path, end);

      // `warn` e não `info`: um log de jogo passar de 1 GB numa
      // execução só quase sempre é um erro em laço — foi assim nos
      // 46 GB do oz-vanilla. O vigia contém o disco; a causa
      // continua lá, no fim do arquivo.
      this.#logger.warn(
        {
          server: serverId,
          path,
          sizeMb: Math.round(sizeBytes / MB),
          allocatedMb: Math.round(allocatedBytes / MB),
          releasedMb: Math.round(end / MB),
          keptMb: Math.round((sizeBytes - end) / MB),
        },
        'o log do jogo passou do teto e o começo foi devolvido ao disco; veja o fim do ' +
          'arquivo — um erro em laço costuma ser o motivo',
      );
    } catch (error) {
      this.#logger.warn(
        { err: toError(error), server: serverId, path },
        'não consegui desalocar o começo do log do jogo; a próxima rodada tenta de novo',
      );
    }
  }
}
