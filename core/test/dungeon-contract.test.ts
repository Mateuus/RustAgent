// ============================================================
//  O contrato com o OrigemZDungeon.cs.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O `onConsoleLine` do agente recebe o CHAT dos jogadores junto
//  com o resto do console. Sem o segredo, alguém digitando
//
//      #OZDUNGEON#{"kind":"built","slug":"x",…}
//
//  inventaria um nascimento no histórico — e faria o assistente do
//  painel declarar sucesso sobre uma masmorra que não existe.
//
//  Os testes abaixo são a régua disso. Se alguém afrouxar o parse
//  um dia, é aqui que estoura.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  buildDungeonSyncCommand,
  DUNGEON_SYNC_MAX_BYTES,
  parseDungeonPush,
  parseDungeonReady,
  type DungeonPayload,
} from '../src/game/dungeon-contract.js';

const SECRET = 'eb5d3bc8-3072-4434-afea-a01ec311532d';

/**
 * A linha REAL que o plugin produziu no `server01`, em 09/09/2026.
 *
 * ####  CAPTURADA, NÃO INVENTADA  ####
 *
 * Ela tem o prefixo `[OrigemZ Dungeon]` que o `Puts` do Oxide
 * acrescenta, e é por isso que o parse procura o marcador no meio
 * da linha em vez de exigir que ela comece com ele. Uma fixture
 * escrita à mão começaria com `#OZDUNGEON#` e passaria num parse
 * que quebraria no servidor.
 */
const REAL_BUILT_LINE =
  '[OrigemZ Dungeon] #OZDUNGEON#{"slug":"bunker","x":-1500.0,"z":-1500.0,"grid":"D23",' +
  '"entities":327,"ms":1089,"kind":"built","secret":"' +
  SECRET +
  '"}';

describe('parseDungeonPush', () => {
  it('lê a linha que o servidor produziu de verdade', () => {
    const event = parseDungeonPush(REAL_BUILT_LINE, SECRET);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe('built');

    if (event?.kind !== 'built') throw new Error('devia ser built');

    expect(event.slug).toBe('bunker');
    expect(event.grid).toBe('D23');
    expect(event.entities).toBe(327);
    expect(event.x).toBe(-1500);
  });

  it('RECUSA a mesma linha com o segredo errado', () => {
    // É este que impede o chat de forjar um nascimento.
    expect(parseDungeonPush(REAL_BUILT_LINE, 'outro-segredo')).toBeNull();
  });

  it('RECUSA a linha sem segredo nenhum', () => {
    const semSegredo = REAL_BUILT_LINE.replace(`,"secret":"${SECRET}"`, '');

    expect(parseDungeonPush(semSegredo, SECRET)).toBeNull();
  });

  it('ignora em silêncio tudo que não é nosso', () => {
    // Este método roda em TODA linha de um servidor cheio: centenas
    // por minuto. Nenhuma delas pode virar exceção nem log.
    for (const line of [
      'Bradley APC Spawned at :(-852.12, 36.72, -826.99)',
      '[OrigemZUI] #OZADSREQ#{}',
      '',
      '#OZDUNGEON#',
      '#OZDUNGEON#{isto não é json}',
      '#OZDUNGEON#{"kind":"inventado","secret":"' + SECRET + '"}',
    ]) {
      expect(parseDungeonPush(line, SECRET), line).toBeNull();
    }
  });

  it('lê o motivo da falha com o mesmo nome dos dois lados', () => {
    const line = `#OZDUNGEON#{"kind":"failed","slug":"bunker","reason":"no_hatch","secret":"${SECRET}"}`;
    const event = parseDungeonPush(line, SECRET);

    if (event?.kind !== 'failed') throw new Error('devia ser failed');

    expect(event.reason).toBe('no_hatch');
  });

  it('recusa um motivo de falha que não existe no contrato', () => {
    // Um motivo novo do plugin sem o agente saber dele viraria
    // `failure_reason` que o painel não sabe traduzir.
    const line = `#OZDUNGEON#{"kind":"failed","slug":"x","reason":"deu_ruim","secret":"${SECRET}"}`;

    expect(parseDungeonPush(line, SECRET)).toBeNull();
  });
});

describe('parseDungeonReady', () => {
  it('lê o grito do plugin recém-carregado', () => {
    const line = '[OrigemZ Dungeon] #OZDUNGEON#{"kind":"ready","version":"0.1.0"}';

    expect(parseDungeonReady(line)?.version).toBe('0.1.0');
  });

  it('não exige segredo — é justamente ele que o plugin não tem', () => {
    // E forjá-lo pelo chat não faz dano: o agente responde
    // reenviando o estado que já era para estar lá.
    expect(parseDungeonReady('#OZDUNGEON#{"kind":"ready"}')).not.toBeNull();
  });

  it('não confunde um `built` com um `ready`', () => {
    expect(parseDungeonReady(REAL_BUILT_LINE)).toBeNull();
  });
});

describe('buildDungeonSyncCommand', () => {
  it('manda o payload em base64, sem aspa nem espaço', () => {
    // O parser de console do Rust trata token entre aspas como
    // argumento citado e COME AS ASPAS: o JSON cru chegaria com
    // `recipe` sem aspas e quebraria o parse do outro lado.
    const command = buildDungeonSyncCommand({
      secret: SECRET,
      dungeons: [],
      zones: [{ x: 100, z: 200, radius: 150 }],
    });

    const [name, payload] = command.split(' ');

    expect(name).toBe('origemz.dungeon.sync');
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);

    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64').toString('utf8')) as {
      secret: string;
      zones: unknown[];
    };

    expect(decoded.secret).toBe(SECRET);
    expect(decoded.zones).toHaveLength(1);
  });

  it('trinta masmorras simples cabem no teto do RCON, e cem não', () => {
    // MEDIDO: uma masmorra de tres salas pesa ~900 bytes de JSON,
    // ~1,2 KB em base64. Eu tinha escrito "cem cabem folgadas" e
    // este teste provou o contrario - 74 KB, acima do teto.
    //
    // As PLANTAS nao passam por aqui: elas vao pelo disco. O que
    // atravessa o console e so a receita.
    expect(
      buildDungeonSyncCommand({ secret: SECRET, dungeons: plain(30), zones: [] }).length,
    ).toBeLessThan(DUNGEON_SYNC_MAX_BYTES);

    // E o teto e para valer: o `push` RECUSA o envio inteiro e
    // deixa o cache anterior de pe - velho, mas integro.
    expect(
      buildDungeonSyncCommand({ secret: SECRET, dungeons: plain(100), zones: [] }).length,
    ).toBeGreaterThan(DUNGEON_SYNC_MAX_BYTES);
  });

  it('com tabela de loot cheia, sete cabem e oito não', () => {
    // ####  ESTE É O NÚMERO QUE MUDOU EM 09/09/2026  ####
    //
    // O comentário do `dungeon-contract.ts` prometia "cerca de 40"
    // masmorras. Com as tabelas de loot da frente `event-loot` —
    // oito itens por cor, mais uma no corredor — são SETE.
    //
    // O teste existe para que o dia em que alguém acrescentar mais
    // um campo ao payload apareça AQUI, e não num plugin que
    // recebeu meia masmorra.
    expect(
      buildDungeonSyncCommand({ secret: SECRET, dungeons: loaded(7), zones: [] }).length,
    ).toBeLessThan(DUNGEON_SYNC_MAX_BYTES);

    expect(
      buildDungeonSyncCommand({ secret: SECRET, dungeons: loaded(8), zones: [] }).length,
    ).toBeGreaterThan(DUNGEON_SYNC_MAX_BYTES);
  });
});

/** Uma masmorra sem nada de opcional: é o que o sync enxuto produz. */
function plain(count: number): DungeonPayload[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `masmorra-${String(index)}`,
    mode: 'recipe' as const,
    entrance: 'entrance2',
    size: { min: 10, max: 15 },
    weights: { green: 60, blue: 30, red: 10 },
    corridor: {
      npcDensity: 20,
      lootDensity: 10,
      crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
    },
    grid: null,
    npc: {
      health: { min: 100, max: 150 },
      damageScale: 1,
      weapons: ['rifle.ak', 'smg.mp5'],
      names: ['Guardião'],
    },
    timeOfDay: 0,
    respawn: { enabled: false },
    rooms: [
      {
        key: 'green',
        color: 'green',
        npc: { min: 0, max: 1 },
        loot: { min: 1, max: 1 },
        crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
        door: 'wood',
        locked: false,
      },
    ],
  }));
}

/** Oito itens, com os campos que NÃO são padrão — o pior caso real. */
function table(): NonNullable<DungeonPayload['rooms'][number]['table']> {
  return {
    mode: 'add',
    rolls: { min: 1, max: 3 },
    entries: Array.from({ length: 8 }, (_unused, index) => ({
      shortname: `item.exemplo.${String(index)}`,
      amount: { min: 1, max: 25 },
      weight: 25,
      guaranteed: index === 0,
    })),
  };
}

/** Três salas com tabela, mais o corredor e o corpo do inimigo. */
function loaded(count: number): DungeonPayload[] {
  return plain(count).map((dungeon) => ({
    ...dungeon,
    corridor: { ...dungeon.corridor, table: table() },
    npc: { ...dungeon.npc, loot: table() },
    rooms: (['green', 'blue', 'red'] as const).map((color) => ({
      key: color,
      color,
      npc: { min: 1, max: 3 },
      loot: { min: 1, max: 2 },
      crates: ['assets/bundled/prefabs/radtown/crate_normal.prefab'],
      door: 'wood',
      locked: false,
      table: table(),
    })),
  }));
}
