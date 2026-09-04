// ============================================================
//  steam-auto-update.test.ts  -  ligar e desligar a atualização
//  automática pelo site, sem reiniciar o agente.
//
//  ####  O DEFEITO QUE ISTO TRAVA  ####
//
//  `STEAM_AUTO_UPDATE` é uma flag da MÁQUINA, lida do env no boot.
//  O `desired` do site é POR SERVIDOR. Casar os dois sem separar
//  produz o pior desfecho: dois servidores do mesmo agente mandando
//  opiniões diferentes, e o último a chegar ganhando — em silêncio,
//  a cada 30 segundos.
//
//  E há três estados, não dois: chave ausente é "ninguém opinou", e
//  colapsá-la com `false` desliga a atualização de quem nunca pediu
//  isso. O sintoma aparece semanas depois, quando a Facepunch
//  publica e o servidor passa a recusar todo mundo com "versão
//  incompatível" — a essa altura ninguém liga uma coisa à outra.
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { createLogger } from '../src/logger.js';
import type { OperationLock } from '../src/ops/operations.js';
import type { ServerSupervisor } from '../src/servers/supervisor.js';
import { AUTO_UPDATE_KEY, SteamUpdateWatcher } from '../src/steam/update-watcher.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

/**
 * O vigia com o mínimo em volta.
 *
 * Nada aqui chama a Steam nem toca disco: os testes são sobre a
 * OPINIÃO, e ela é decidida antes de qualquer ida ao SteamCMD.
 */
function watcher(options: { readonly autoUpdate: boolean }): {
  readonly watcher: SteamUpdateWatcher;
  readonly meta: MetaRepository;
} {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const meta = new MetaRepository(db);

  return {
    meta,
    watcher: new SteamUpdateWatcher({
      supervisor: { ids: () => [], configOf: () => null } as unknown as ServerSupervisor,
      paths: { steamCmdDir: 'C:\\nao-existe' } as never,
      lock: { holderOf: () => null } as unknown as OperationLock,
      logger: silent,
      intervalMs: 900_000,
      autoUpdate: options.autoUpdate,
      meta,
    }),
  };
}

describe('a atualização automática por servidor', () => {
  it('sem opinião gravada, vale o padrão da máquina', () => {
    expect(watcher({ autoUpdate: true }).watcher.autoUpdateFor('pvp1')).toBe(true);
    expect(watcher({ autoUpdate: false }).watcher.autoUpdateFor('pvp1')).toBe(false);
  });

  it('o valor gravado vence o padrão, nos dois sentidos', () => {
    const ligado = watcher({ autoUpdate: true });

    ligado.watcher.setAutoUpdate('pvp1', false);
    expect(ligado.watcher.autoUpdateFor('pvp1')).toBe(false);

    const desligado = watcher({ autoUpdate: false });

    desligado.watcher.setAutoUpdate('pvp1', true);
    expect(desligado.watcher.autoUpdateFor('pvp1')).toBe(true);
  });

  it('a opinião é DAQUELE servidor, e não vaza para o vizinho', () => {
    const test = watcher({ autoUpdate: true });

    test.watcher.setAutoUpdate('pvp1', false);

    expect(test.watcher.autoUpdateFor('pvp1')).toBe(false);
    expect(test.watcher.autoUpdateFor('pvp2')).toBe(true);
  });

  it('`null` devolve o servidor ao padrão — não é "desligue"', () => {
    const test = watcher({ autoUpdate: true });

    test.watcher.setAutoUpdate('pvp1', false);
    test.watcher.setAutoUpdate('pvp1', null);

    expect(test.meta.read(`${AUTO_UPDATE_KEY}.pvp1`)).toBeNull();
    expect(test.watcher.autoUpdateFor('pvp1')).toBe(true);
  });

  it('a escolha sobrevive ao restart do agente', () => {
    // O `pm2 restart` apaga memória. Sem persistir, o site mostraria
    // "desligado" para um agente que voltou a atualizar sozinho.
    const db = openDatabase({ file: MEMORY_DATABASE });

    runMigrations(db);

    const meta = new MetaRepository(db);
    const build = (): SteamUpdateWatcher =>
      new SteamUpdateWatcher({
        supervisor: { ids: () => [], configOf: () => null } as unknown as ServerSupervisor,
        paths: { steamCmdDir: 'C:\\nao-existe' } as never,
        lock: { holderOf: () => null } as unknown as OperationLock,
        logger: silent,
        intervalMs: 900_000,
        autoUpdate: true,
        meta,
      });

    build().setAutoUpdate('pvp1', false);

    expect(build().autoUpdateFor('pvp1')).toBe(false);
  });

  it('o retrato leva o valor EFETIVO daquele servidor', () => {
    // É o `build.autoUpdate` do retrato de 30 s: o site já o lê, e
    // ele é a única confirmação de que a opinião pegou.
    const test = watcher({ autoUpdate: true });

    test.watcher.setAutoUpdate('pvp1', false);

    expect(test.watcher.stateOf('pvp1').autoUpdate).toBe(false);
    expect(test.watcher.stateOf('pvp2').autoUpdate).toBe(true);
  });
});
