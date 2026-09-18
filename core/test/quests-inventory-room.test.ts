// ============================================================
//  quests-inventory-room.test.ts  -  "cabe tudo?", do lado do agente.
//
//  A conta de pilhas e slots é do plugin (`HandleGiveCheck`), que é
//  quem vê a mochila. O que se prova aqui é a conversa: o que vai no
//  comando, como a resposta é lida, e que NÃO SABER nunca vira
//  "cabe" — é o "cabe" errado que perde o prêmio (17/09/2026).
// ============================================================

import { describe, expect, it } from 'vitest';

import type { OpsRcon } from '../src/ops/service.js';
import {
  buildGiveCheckCommand,
  checkInventoryRoom,
  inventoryFullMessage,
  roomItemsOf,
} from '../src/quests/inventory-room.js';

const FULANO = '76561198000000001';

function rcon(reply: string, connected = true): OpsRcon & { sent: string[] } {
  const sent: string[] = [];

  return {
    sent,
    isConnected: connected,
    send: (command: string) => {
      sent.push(command);

      return Promise.resolve(reply);
    },
  } as unknown as OpsRcon & { sent: string[] };
}

describe('o comando', () => {
  it('leva os itens em base64, sem aspas no console', () => {
    const command = buildGiveCheckCommand(FULANO, [
      { shortname: 'wood', amount: 500, skinId: '0' },
    ]);
    const [name, steamId, payload] = command.split(' ');

    expect(name).toBe('origemz.give.check');
    expect(steamId).toBe(FULANO);
    expect(command).not.toContain('"');
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64').toString('utf8'))).toEqual({
      items: [{ shortname: 'wood', amount: 500, skinId: '0' }],
    });
  });
});

describe('a resposta', () => {
  it('lê quantos slots faltam', async () => {
    const result = await checkInventoryRoom(
      rcon('{"ok":true,"fits":false,"slotsNeeded":3,"freeSlots":1,"missingSlots":2}'),
      FULANO,
      [{ shortname: 'wood', amount: 3000, skinId: '0' }],
    );

    expect(result).toMatchObject({ fits: false, missingSlots: 2 });
  });

  it('acha o JSON no meio de linhas de log', async () => {
    const result = await checkInventoryRoom(
      rcon('[Oxide] algo\n{"ok":true,"fits":true,"slotsNeeded":1,"freeSlots":4,"missingSlots":0}\n'),
      FULANO,
      [{ shortname: 'rifle.ak', amount: 1, skinId: '0' }],
    );

    expect(result.fits).toBe(true);
  });

  it('plugin velho, que se cala, é "não sei" — e não "cabe"', async () => {
    await expect(
      checkInventoryRoom(rcon(''), FULANO, [{ shortname: 'wood', amount: 1, skinId: '0' }]),
    ).rejects.toMatchObject({ code: 'QUEST_INVENTORY_UNCHECKED', status: 503 });
  });

  it('sem RCON, nem pergunta', async () => {
    const off = rcon('{"ok":true}', false);

    await expect(
      checkInventoryRoom(off, FULANO, [{ shortname: 'wood', amount: 1, skinId: '0' }]),
    ).rejects.toMatchObject({ code: 'QUEST_INVENTORY_UNCHECKED' });
    expect(off.sent).toEqual([]);
  });

  it('o morto lê o que fazer', async () => {
    await expect(
      checkInventoryRoom(rcon('{"ok":false,"error":"PLAYER_DEAD"}'), FULANO, [
        { shortname: 'wood', amount: 1, skinId: '0' },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('Renasça'), reason: 'PLAYER_DEAD' });
  });
});

describe('o que entra na conta', () => {
  it('item e kit ocupam slot; moeda, ponto e VIP não', () => {
    const items = roomItemsOf(
      [
        { kind: 'coins', amount: 50, perMeter: null, min: null, max: null },
        { kind: 'item', shortname: 'rifle.ak', amount: 1, skinId: '123' },
        { kind: 'kit', slug: 'starter' },
        { kind: 'points', metric: 'trophy.bleik', amount: 5 },
      ],
      (slug) =>
        slug === 'starter'
          ? [
              { shortname: 'stones', amount: 1000, skinId: '0' },
              { shortname: 'hatchet', amount: 1, skinId: '0' },
            ]
          : null,
    );

    expect(items.map((item) => item.shortname)).toEqual(['rifle.ak', 'stones', 'hatchet']);
  });
});

describe('a frase', () => {
  it('diz quantos slots liberar', () => {
    expect(inventoryFullMessage(2)).toBe(
      'Inventário sem espaço para receber a recompensa. Libere 2 slots e tente resgatar novamente.',
    );
    expect(inventoryFullMessage(1)).toContain('Libere 1 slot e');
  });
});
