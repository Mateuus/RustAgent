// ============================================================
//  game-log-guard.test.ts  -  o log do jogo tem teto?
//
//  ####  O DEFEITO QUE ISTO TRAVA  ####
//
//  Em 11/09/2026 o `server-oz-vanilla.log` chegou a 46,7 GB numa
//  execução só — um ScarecrowNPC sem navmesh despejando a mesma
//  pilha de NullReferenceException por dias — e o dono teve de
//  apagá-lo à mão.
//
//  ####  E O QUE ELE NÃO PODE QUEBRAR  ####
//
//  O jogo continua com o arquivo aberto e escreve POR POSIÇÃO. O
//  teste de verdade (só no Windows) segura um descritor aberto,
//  como o jogo, e confere que depois da desalocação a escrita
//  seguinte entra no lugar e o fim do arquivo continua legível.
// ============================================================

import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { gameLogPath } from '../src/ops/server-process.js';
import { GameLogGuard, releaseBoundary, releaseLogHead } from '../src/servers/game-log-guard.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

const KB = 1024;
const MB = 1024 * KB;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'game-log-guard-'));
  dirs.push(dir);
  return dir;
}

/** Só o que o vigia lê do `.ini`: onde mora o log. */
function fakeServer(id: string, logsDir: string): ServerConfig {
  return { id, identity: id, paths: { logsDir } } as unknown as ServerConfig;
}

function serversOf(configs: readonly ServerConfig[]) {
  return {
    ids: () => configs.map((config) => config.id),
    configOf: (id: string) => configs.find((config) => config.id === id) ?? null,
  };
}

describe('releaseBoundary', () => {
  it('abaixo do teto em disco, não mexe', () => {
    expect(releaseBoundary(900 * MB, 900 * MB, 1024 * MB, 64 * MB)).toBeNull();
  });

  it('acima do teto, devolve tudo menos o fim, alinhado a 64 KB', () => {
    const size = 2 * 1024 * MB + 12_345;
    const end = releaseBoundary(size, size, 1024 * MB, 64 * MB);

    expect(end).not.toBeNull();
    expect((end ?? 0) % (64 * KB)).toBe(0);
    // O fim guardado nunca é MENOR que o pedido: o alinhamento
    // arredonda a fronteira para trás, nunca para a frente.
    expect(size - (end ?? 0)).toBeGreaterThanOrEqual(64 * MB);
    expect(size - (end ?? 0)).toBeLessThan(64 * MB + 64 * KB);
  });

  it('decide pelo ALOCADO: o arquivo já esparso não é desalocado de novo a cada rodada', () => {
    // 46 GB lógicos, 70 MB de verdade em disco — o estado logo
    // depois de uma desalocação.
    expect(releaseBoundary(46 * 1024 * MB, 70 * MB, 1024 * MB, 64 * MB)).toBeNull();
  });

  it('um arquivo menor que o trecho a guardar não tem o que devolver', () => {
    expect(releaseBoundary(32 * MB, 2048 * MB, 1024 * MB, 64 * MB)).toBeNull();
  });
});

describe('GameLogGuard', () => {
  it('passou do teto: pede a desalocação do começo daquele arquivo', async () => {
    const logsDir = await tempDir();
    const server = fakeServer('oz-vanilla', logsDir);

    await writeFile(gameLogPath(server), Buffer.alloc(1 * MB, 'x'));

    const calls: Array<{ path: string; end: number }> = [];
    const guard = new GameLogGuard({
      servers: serversOf([server]),
      logger: silent,
      maxBytes: 256 * KB,
      release: async (path, end) => {
        calls.push({ path, end });
      },
    });

    await guard.sweep();

    // O que fica é metade do teto (128 KB): guardar mais que o teto
    // faria o vigia bater para sempre sem liberar nada.
    expect(calls).toEqual([{ path: gameLogPath(server), end: 1 * MB - 128 * KB }]);
  });

  it('abaixo do teto, ou sem arquivo, não faz nada', async () => {
    const logsDir = await tempDir();
    const small = fakeServer('pequeno', logsDir);
    const never = fakeServer('nunca-subiu', logsDir);

    await writeFile(gameLogPath(small), Buffer.alloc(100 * KB, 'x'));

    const calls: string[] = [];
    const guard = new GameLogGuard({
      servers: serversOf([small, never]),
      logger: silent,
      maxBytes: 256 * KB,
      release: async (path) => {
        calls.push(path);
      },
    });

    await guard.sweep();

    expect(calls).toEqual([]);
  });

  it('um servidor que falha não deixa os outros sem teto', async () => {
    const logsDir = await tempDir();
    const broken = fakeServer('a-quebrado', logsDir);
    const healthy = fakeServer('b-saudavel', logsDir);

    await writeFile(gameLogPath(broken), Buffer.alloc(1 * MB, 'x'));
    await writeFile(gameLogPath(healthy), Buffer.alloc(1 * MB, 'x'));

    const calls: string[] = [];
    const guard = new GameLogGuard({
      servers: serversOf([broken, healthy]),
      logger: silent,
      maxBytes: 256 * KB,
      release: async (path) => {
        if (path === gameLogPath(broken)) {
          throw new Error('Acesso negado');
        }

        calls.push(path);
      },
    });

    await expect(guard.sweep()).resolves.toBeUndefined();
    expect(calls).toEqual([gameLogPath(healthy)]);
  });
});

describe.runIf(process.platform === 'win32')('releaseLogHead, no NTFS de verdade', () => {
  it(
    'devolve o começo ao disco com o arquivo aberto, e o escritor continua no lugar',
    async () => {
      const dir = await tempDir();
      const path = join(dir, 'server-teste.log');
      const size = 4 * MB;

      await writeFile(path, Buffer.alloc(size, 'a'));

      // O "jogo": um descritor aberto para escrita, que continua
      // escrevendo na posição em que estava.
      const writer = openSync(path, 'r+');

      try {
        const end = releaseBoundary(size, size, 1 * MB, 512 * KB);

        expect(end).not.toBeNull();

        await releaseLogHead(path, end ?? 0);

        const after = await stat(path);

        expect(after.size).toBe(size);
        // Em disco ficou só o fim (mais um cluster de folga).
        expect(after.blocks * 512).toBeLessThan(size - (end ?? 0) + 128 * KB);

        const line = Buffer.from('Saved 69,194 ents\r\n');

        writeSync(writer, line, 0, line.length, size);
      } finally {
        closeSync(writer);
      }

      const content = await readFile(path);

      expect(content.length).toBe(size + 'Saved 69,194 ents\r\n'.length);
      expect(content.subarray(0, 16).every((byte) => byte === 0)).toBe(true);
      expect(content.subarray(-19).toString()).toBe('Saved 69,194 ents\r\n');
      expect(content.subarray(-19 - 16, -19).toString()).toBe('a'.repeat(16));
    },
    60_000,
  );
});
