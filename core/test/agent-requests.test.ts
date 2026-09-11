// ============================================================
//  agent-requests.test.ts  -  o OrigemZAgent pedindo o estado de
//  volta, e o agente finalmente respondendo.
//
//  O que este arquivo guarda:
//
//    1. o pedido do hub é reconhecido no formato que o plugin
//       imprime (`[OrigemZAgent] #OZAREQ#{"want":"timers"}`);
//    2. a mesma frase dita no CHAT não é pedido nenhum — a âncora é
//       a do stat-events.ts;
//    3. os pedidos de outros donos (`#OZAREQ#items`, `quests`) não
//       são respondidos daqui;
//    4. NENHUM comando sai de dentro do gancho: o reenvio sai de um
//       relógio — foi um comando mandado do gancho que um dia encheu
//       o console de `loadout.sync` repetido;
//    5. o boot do plugin pede tudo de uma vez, e o pedido repetido
//       vira um envio só.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRequests,
  parseAgentRequest,
  type AgentRequestTopic,
} from '../src/game/agent-requests.js';
import { createLogger } from '../src/logger.js';

describe('o formato do pedido', () => {
  it('reconhece a linha como o hub a imprime', () => {
    expect(parseAgentRequest('[OrigemZAgent] #OZAREQ#{"want":"timers"}')).toBe('timers');
    expect(parseAgentRequest('[OrigemZAgent] #OZAREQ#{"want":"loadouts"}')).toBe('loadouts');
    expect(parseAgentRequest('#OZAREQ#{"want":"vips"}')).toBe('vips');
  });

  it('a mesma frase no CHAT não é pedido: o marcador tem de estar no começo', () => {
    expect(parseAgentRequest('[CHAT] Fulano : #OZAREQ#{"want":"loadouts"}')).toBeNull();
  });

  it('não responde por outro dono, nem por JSON que não é o do contrato', () => {
    // O dos itens custom (custom-items-sync.ts) e o das missões
    // (quests/collector.ts) têm dono próprio.
    expect(parseAgentRequest('[OrigemZ Items] #OZAREQ#items')).toBeNull();
    expect(parseAgentRequest('[OrigemZAgent] #OZAREQ#{"want":"quests"}')).toBeNull();

    expect(parseAgentRequest('[OrigemZAgent] #OZAREQ#{"want":"timers","extra":1}')).toBeNull();
    expect(parseAgentRequest('[OrigemZAgent] #OZAREQ#{"want":7}')).toBeNull();
    expect(parseAgentRequest('[OrigemZAgent] #OZAREQ#["timers"]')).toBeNull();
    expect(parseAgentRequest('origemz.timers.sync eyJ0aWVycyI6e319')).toBeNull();
  });
});

describe('a resposta', () => {
  let calls: { topic: AgentRequestTopic; serverId: string }[];
  let requests: AgentRequests;

  beforeEach(() => {
    vi.useFakeTimers();

    calls = [];

    const record =
      (topic: AgentRequestTopic) =>
      (serverId: string): Promise<void> => {
        calls.push({ topic, serverId });
        return Promise.resolve();
      };

    requests = new AgentRequests({
      resend: {
        vips: record('vips'),
        loadouts: record('loadouts'),
        status: record('status'),
        timers: record('timers'),
      },
      logger: createLogger({ log: { level: 'silent', pretty: false } }),
    });
  });

  afterEach(() => {
    requests.stop();
    vi.useRealTimers();
  });

  it('não manda nada de dentro do gancho: o reenvio sai do relógio', () => {
    expect(requests.handleLine('pvp1', '[OrigemZAgent] #OZAREQ#{"want":"timers"}')).toBe(true);

    // O que importa: nada saiu ainda. Um comando mandado daqui
    // imprimiria no console, voltaria por este mesmo gancho — e o
    // laço estaria fechado.
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(250);

    expect(calls).toEqual([{ topic: 'timers', serverId: 'pvp1' }]);
  });

  it('o boot do plugin pede tudo, e o pedido repetido vira um envio só', () => {
    for (const want of ['vips', 'loadouts', 'status', 'timers', 'timers']) {
      requests.handleLine('pvp1', `[OrigemZAgent] #OZAREQ#{"want":"${want}"}`);
    }

    // O mesmo assunto em OUTRO servidor é outro envio.
    requests.handleLine('pve1', '[OrigemZAgent] #OZAREQ#{"want":"timers"}');

    vi.advanceTimersByTime(250);

    expect(calls).toEqual([
      { topic: 'vips', serverId: 'pvp1' },
      { topic: 'loadouts', serverId: 'pvp1' },
      { topic: 'status', serverId: 'pvp1' },
      { topic: 'timers', serverId: 'pvp1' },
      { topic: 'timers', serverId: 'pve1' },
    ]);
  });

  it('um segundo reload DEPOIS do envio é atendido de novo', () => {
    requests.handleLine('pvp1', '[OrigemZAgent] #OZAREQ#{"want":"loadouts"}');
    vi.advanceTimersByTime(250);

    // O cache esvaziou de novo: recusar este pedido deixaria o hub
    // sem kit até a próxima queda do RCON.
    requests.handleLine('pvp1', '[OrigemZAgent] #OZAREQ#{"want":"loadouts"}');
    vi.advanceTimersByTime(250);

    expect(calls).toHaveLength(2);
  });

  it('linha que não é pedido passa reto, sem relógio', () => {
    expect(requests.handleLine('pvp1', '[CHAT] Fulano : #OZAREQ#{"want":"vips"}')).toBe(false);
    expect(requests.handleLine('pvp1', 'Saving 1234 entities')).toBe(false);

    vi.advanceTimersByTime(1000);

    expect(calls).toEqual([]);
  });
});
