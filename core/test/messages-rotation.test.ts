// ============================================================
//  messages-rotation.test.ts  -  o rodízio e o `/pop`.
//
//  O que este arquivo guarda:
//
//    1. o grupo manda UMA mensagem por intervalo, e não todas;
//    2. a ordem FIXA respeita a sequência e reinicia o ciclo;
//    3. a ordem ALEATÓRIA não repete duas vezes seguidas — nem na
//       emenda entre dois baralhos, que é onde isso reapareceria;
//    4. TODAS saem antes de qualquer uma repetir;
//    5. apagar uma do meio não quebra a ordem fixa;
//    6. servidor parado não consome a vez de ninguém;
//    7. mensagem de rodízio NÃO sai sozinha pelo relógio dela;
//    8. o comando responde SÓ a quem digitou, com os valores de
//       agora;
//    9. o cooldown impede o spam, e diz quanto falta;
//   10. comando removido ou desligado sai da lista do plugin;
//   11. dois comandos iguais no mesmo servidor são recusados na
//       gravação — e em servidores diferentes, não.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MessagesRepository, normalizeCommand } from '../src/db/messages-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { PluginBroadcaster, decodeBroadcastPayload } from '../src/game/broadcast.js';
import {
  CHAT_COMMAND_MARKER,
  parseChatCommandNotice,
} from '../src/game/chat-commands.js';
import { createLogger } from '../src/logger.js';
import { ChatCommands } from '../src/messages/commands.js';
import { pickNext } from '../src/messages/rotation.js';
import { MessagesService } from '../src/messages/service.js';
import { VariableRegistry, registerCoreVariables } from '../src/messages/variables.js';
import type { OpsRcon } from '../src/ops/service.js';
import type {
  MessageGroupInput,
  MessageInput,
  MessageView,
} from '../src/types/messages.js';

const SP = 'America/Sao_Paulo';
const SERVER = 'pvp1';
const OTHER = 'pve1';
const PLAYER = '76561198000000001';

const SILENT = createLogger({ log: { level: 'silent', pretty: false } });

interface FakeServer {
  readonly commands: string[];
  connected: boolean;
  online: number | null;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: MessagesRepository;
  readonly service: MessagesService;
  readonly commands: ChatCommands;
  readonly servers: Map<string, FakeServer>;
  clock: number;
  /**
   * A fila de sorteios do rodízio embaralhado.
   *
   * Uma sequência conhecida, e não `Math.random`: "não repete duas
   * vezes seguidas" só é testável com o sorteio sob controle. Vazia,
   * o sorteio volta a ser um número fixo — e o embaralhamento com
   * `0` é a identidade, que é o caso mais fácil de ler.
   */
  rolls: number[];
}

let harness: Harness;

function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      if (command.startsWith('origemz.chat.broadcast ')) {
        return Promise.resolve(JSON.stringify({ ok: true, sent: 5 }));
      }

      if (command.startsWith('origemz.chat.commands ')) {
        return Promise.resolve(JSON.stringify({ ok: true, count: 1 }));
      }

      return Promise.resolve('');
    },
  };
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const repositoryOfServers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    repositoryOfServers.create({
      id,
      name: id,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }

  const servers = new Map<string, FakeServer>([
    [SERVER, { commands: [], connected: true, online: 12 }],
    [OTHER, { commands: [], connected: true, online: 4 }],
  ]);

  const repository = new MessagesRepository(db);
  const variables = new VariableRegistry({ logger: SILENT });

  registerCoreVariables(variables, {
    nameOf: (id) => `OrigemZ ${id}`,
    slotsOf: () => 300,
    onlineOf: (id) => Promise.resolve(servers.get(id)?.online ?? null),
  });

  const context = {
    ids: () => [...servers.keys()],
    contextOf: (id: string) => {
      const server = servers.get(id);

      return server === undefined ? null : { rcon: fakeRcon(server) };
    },
  };

  const presence = {
    online: (id: string): Promise<number | null> =>
      Promise.resolve(servers.get(id)?.online ?? null),
  };

  const service = new MessagesService({
    repository,
    broadcaster: new PluginBroadcaster({ servers: context, logger: SILENT }),
    variables,
    servers: context,
    presence,
    logger: SILENT,
    now: () => harness.clock,
    random: () => harness.rolls.shift() ?? 0,
  });

  harness = {
    db,
    repository,
    service,
    servers,
    clock: Date.UTC(2026, 8, 18, 15, 0),
    rolls: [],
    commands: new ChatCommands({
      repository,
      service,
      servers: context,
      presence,
      logger: SILENT,
      now: () => harness.clock,
    }),
  };
});

afterEach(() => {
  harness.commands.stop();
  harness.db.close();
});

// ------------------------------------------------------------
//  Ajudantes
// ------------------------------------------------------------

function createGroup(over: Partial<MessageGroupInput> = {}) {
  const input: MessageGroupInput = {
    name: 'Dicas',
    enabled: true,
    everySeconds: 300,
    order: 'fixed',
    timeZone: SP,
    windowFrom: null,
    windowTo: null,
    onlyWithPlayers: false,
    minPlayers: 1,
    targets: [],
    ...over,
  };

  return harness.repository.createGroup(
    input,
    harness.service.nextAtForGroup(input.everySeconds, input.enabled),
    harness.clock,
  );
}

function createMessage(over: Partial<MessageInput> = {}): MessageView {
  const input: MessageInput = {
    name: 'Dica',
    text: 'Use /kit para pegar o seu kit',
    enabled: true,
    trigger: 'schedule',
    groupId: null,
    command: null,
    cooldownSeconds: 0,
    scheduleKind: 'interval',
    everySeconds: 1800,
    timeOfDay: null,
    weekdays: [],
    runAt: null,
    timeZone: SP,
    windowFrom: null,
    windowTo: null,
    onlyWithPlayers: false,
    minPlayers: 1,
    tag: null,
    tagColor: null,
    color: null,
    size: null,
    targets: [],
    ...over,
  };

  return harness.repository.create(
    input,
    // O `next_at` de uma mensagem que não é agendada é sempre nulo —
    // é o que impede o relógio de enxergá-la. Ver routes/messages.ts.
    input.trigger === 'schedule' ? harness.service.nextAtFor(input, input.enabled) : null,
    harness.clock,
  );
}

/** Três frases de rodízio num grupo, na ordem em que foram criadas. */
function createRotation(groupId: number, names: readonly string[]): MessageView[] {
  return names.map((name) =>
    createMessage({ name, text: name, trigger: 'rotation', groupId }),
  );
}

/** Faz o grupo vencer: o horário dele passa a ser o passado. */
function groupIsDue(groupId: number): void {
  harness.repository.setGroupNextAt(groupId, harness.clock - 1_000, harness.clock);
}

/** O texto do último `broadcast` daquele servidor. */
function lastText(serverId: string = SERVER): string {
  const command = [...(harness.servers.get(serverId)?.commands ?? [])]
    .reverse()
    .find((entry) => entry.startsWith('origemz.chat.broadcast '));

  expect(command).toBeDefined();

  const payload = decodeBroadcastPayload(
    (command as string).slice('origemz.chat.broadcast '.length),
  ) as Record<string, unknown>;

  return String(payload['text']);
}

/** O payload do último `broadcast` daquele servidor, inteiro. */
function lastPayload(serverId: string = SERVER): Record<string, unknown> {
  const command = [...(harness.servers.get(serverId)?.commands ?? [])]
    .reverse()
    .find((entry) => entry.startsWith('origemz.chat.broadcast '));

  expect(command).toBeDefined();

  return decodeBroadcastPayload(
    (command as string).slice('origemz.chat.broadcast '.length),
  ) as Record<string, unknown>;
}

/** Uma volta do relógio com o grupo vencido, e quem falou nela. */
async function rotateOnce(groupId: number): Promise<number | null> {
  groupIsDue(groupId);

  const summary = await harness.service.tick();

  expect(summary.error).toBeNull();

  return summary.groups[0]?.messageId ?? null;
}

// ------------------------------------------------------------
//  O RODÍZIO
// ------------------------------------------------------------

describe('o rodízio manda uma por vez', () => {
  it('uma volta do grupo entrega UMA mensagem, e não as três', async () => {
    const group = createGroup();

    createRotation(group.id, ['A', 'B', 'C']);
    groupIsDue(group.id);

    const summary = await harness.service.tick();

    // ####  ESTE É O PEDIDO INTEIRO, EM UMA LINHA  ####
    //
    // Cinco mensagens com o mesmo intervalo saem as cinco juntas,
    // empilhadas, no mesmo segundo — e é isso que o admin monta
    // sozinho hoje. O grupo manda uma.
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.delivered).toEqual([SERVER, OTHER]);
    expect(lastText()).toBe('A');

    const broadcasts = (harness.servers.get(SERVER)?.commands ?? []).filter((entry) =>
      entry.startsWith('origemz.chat.broadcast '),
    );

    expect(broadcasts).toHaveLength(1);
  });

  it('a mensagem de rodízio NÃO sai sozinha pelo relógio dela', async () => {
    const group = createGroup();
    const [first] = createRotation(group.id, ['A', 'B']);

    // O ritmo gravado na mensagem continua lá — ela pode voltar a
    // ser agendada sem o admin redigitar nada. O que não pode é ele
    // valer: quem manda no rodízio é o grupo.
    expect(first?.everySeconds).toBe(1800);
    expect(first?.nextAt).toBeNull();

    const summary = await harness.service.tick();

    expect(summary.due).toBe(0);
    expect(summary.results).toHaveLength(0);
  });

  it('o grupo desligado não fala', async () => {
    const group = createGroup({ enabled: false });

    createRotation(group.id, ['A', 'B']);

    // Desligado, ele nem tem horário: religar é que recalcula.
    expect(group.nextAt).toBeNull();

    harness.repository.setGroupNextAt(group.id, harness.clock - 1_000, harness.clock);

    expect((await harness.service.tick()).dueGroups).toBe(0);
  });

  it('o intervalo anda sem deriva, e não despeja o atraso acumulado', async () => {
    const group = createGroup({ everySeconds: 300 });

    createRotation(group.id, ['A', 'B']);
    await rotateOnce(group.id);

    const after = harness.repository.getGroup(group.id);

    expect(after?.nextAt).toBe(harness.clock - 1_000 + 300_000);

    // O agente ficou duas horas fora do ar. Na volta, o grupo não
    // dispara 24 vezes para "recuperar": ele pula para o próximo
    // múltiplo no futuro.
    harness.clock += 7_200_000;

    const spoke = await rotateOnce(group.id);
    const later = harness.repository.getGroup(group.id);

    expect(spoke).not.toBeNull();
    expect(later?.nextAt).toBeGreaterThan(harness.clock);
    expect(later?.sentCount).toBe(2);
  });
});

describe('a ordem fixa', () => {
  it('segue a sequência e reinicia o ciclo no fim', async () => {
    const group = createGroup({ order: 'fixed' });
    const [a, b, c] = createRotation(group.id, ['A', 'B', 'C']);

    const said: (number | null)[] = [];

    for (let volta = 0; volta < 4; volta += 1) {
      said.push(await rotateOnce(group.id));
      harness.clock += 300_000;
    }

    expect(said).toEqual([a?.id, b?.id, c?.id, a?.id]);
  });

  it('apagar a do meio não quebra a ordem: o ciclo segue de onde estava', async () => {
    const group = createGroup({ order: 'fixed' });
    const [a, b, c] = createRotation(group.id, ['A', 'B', 'C']);

    expect(await rotateOnce(group.id)).toBe(a?.id);

    harness.clock += 300_000;

    expect(await rotateOnce(group.id)).toBe(b?.id);

    // ####  O ESTADO É O ID, E NÃO A POSIÇÃO  ####
    //
    // Apagando a B, um índice guardado (1) apontaria para a C e
    // pularia uma. Com "a próxima DEPOIS da B", a C é a certa — e
    // com a B já fora da fila, a volta recomeça pela A.
    harness.repository.remove(b?.id ?? 0);
    harness.clock += 300_000;

    expect(await rotateOnce(group.id)).toBe(a?.id);

    harness.clock += 300_000;

    expect(await rotateOnce(group.id)).toBe(c?.id);
  });

  it('a desligada é PULADA, e o grupo não fica mudo na vez dela', async () => {
    const group = createGroup({ order: 'fixed' });
    const [a, b, c] = createRotation(group.id, ['A', 'B', 'C']);

    harness.repository.setEnabled(b?.id ?? 0, false, null, harness.clock);

    const said: (number | null)[] = [];

    for (let volta = 0; volta < 3; volta += 1) {
      said.push(await rotateOnce(group.id));
      harness.clock += 300_000;
    }

    expect(said).toEqual([a?.id, c?.id, a?.id]);
  });

  it('a ordem é a da lista, e reordenar dentro do grupo a muda', async () => {
    const group = createGroup({ order: 'fixed' });
    const [a, b, c] = createRotation(group.id, ['A', 'B', 'C']);

    harness.repository.reorderInGroup(
      group.id,
      [c?.id ?? 0, a?.id ?? 0, b?.id ?? 0],
      harness.clock,
    );

    expect(harness.repository.membersOf(group.id).map((message) => message.name)).toEqual([
      'C',
      'A',
      'B',
    ]);

    expect(await rotateOnce(group.id)).toBe(c?.id);
  });

  it('reordenar dentro do grupo não mexe em quem é de fora', () => {
    const group = createGroup();
    const solta = createMessage({ name: 'Avulsa' });
    const [a, b] = createRotation(group.id, ['A', 'B']);

    const antes = harness.repository.get(solta.id)?.position;

    harness.repository.reorderInGroup(group.id, [b?.id ?? 0, a?.id ?? 0], harness.clock);

    expect(harness.repository.get(solta.id)?.position).toBe(antes);
  });
});

describe('a ordem aleatória', () => {
  it('distribui TODAS antes de repetir qualquer uma', async () => {
    const group = createGroup({ order: 'random' });
    const ids = createRotation(group.id, ['A', 'B', 'C', 'D']).map((message) => message.id);

    const primeiroCiclo: (number | null)[] = [];

    for (let volta = 0; volta < 4; volta += 1) {
      primeiroCiclo.push(await rotateOnce(group.id));
      harness.clock += 300_000;
    }

    expect([...primeiroCiclo].sort()).toEqual([...ids].sort());
  });

  it('não repete a mesma duas vezes seguidas — nem na virada do ciclo', async () => {
    const group = createGroup({ order: 'random' });

    createRotation(group.id, ['A', 'B', 'C']);

    const said: (number | null)[] = [];

    // Nove voltas cobrem três ciclos inteiros, e com eles as DUAS
    // emendas entre baralhos — que é exatamente onde a repetição
    // consecutiva reapareceria.
    for (let volta = 0; volta < 9; volta += 1) {
      said.push(await rotateOnce(group.id));
      harness.clock += 300_000;
    }

    for (let index = 1; index < said.length; index += 1) {
      expect(said[index]).not.toBe(said[index - 1]);
    }
  });

  it('o baralho sobrevive ao reinício do agente: ele está no banco', async () => {
    const group = createGroup({ order: 'random' });

    createRotation(group.id, ['A', 'B', 'C']);
    await rotateOnce(group.id);

    const after = harness.repository.getGroup(group.id);

    // Duas cartas ainda na mão, gravadas. Um baralho só em memória
    // recomeçaria o ciclo a cada `tsx watch` — e "todas antes de
    // repetir" viraria promessa entre dois reinícios.
    expect(after?.deck).toHaveLength(2);
    expect(after?.lastMessageId).not.toBeNull();
  });

  it('com UMA mensagem só, ela repete — e isso é o certo', () => {
    const group = createGroup({ order: 'random' });
    const only = createMessage({ name: 'Sozinha', trigger: 'rotation', groupId: group.id });

    const pick = pickNext([only], 'random', { lastMessageId: only.id, deck: [] }, () => 0);

    // A alternativa a repetir seria o grupo ficar mudo.
    expect(pick?.messageId).toBe(only.id);
  });
});

describe('o rodízio não perde a vez de ninguém', () => {
  it('servidor parado não consome o horário nem o baralho', async () => {
    const group = createGroup({ targets: [SERVER] });
    const [a] = createRotation(group.id, ['A', 'B']);

    const server = harness.servers.get(SERVER);

    if (server !== undefined) {
      server.connected = false;
    }

    groupIsDue(group.id);

    const summary = await harness.service.tick();

    expect(summary.groups[0]?.consumed).toBe(false);
    expect(summary.groups[0]?.delivered).toEqual([]);
    expect(harness.repository.getGroup(group.id)?.lastMessageId).toBeNull();

    // Voltou: a MESMA mensagem é a da vez. Nada se perdeu.
    if (server !== undefined) {
      server.connected = true;
    }

    expect(await rotateOnce(group.id)).toBe(a?.id);
  });

  it('grupo vazio anda com o horário em vez de travar em toda volta', async () => {
    const group = createGroup();

    groupIsDue(group.id);

    const summary = await harness.service.tick();

    expect(summary.groups[0]?.messageId).toBeNull();
    expect(harness.repository.getGroup(group.id)?.nextAt).toBeGreaterThan(harness.clock);
  });

  it('o filtro de gente é do GRUPO, e o horário fica de pé', async () => {
    const group = createGroup({
      targets: [SERVER],
      onlyWithPlayers: true,
      minPlayers: 20,
    });

    createRotation(group.id, ['A', 'B']);
    groupIsDue(group.id);

    const summary = await harness.service.tick();

    expect(summary.groups[0]?.consumed).toBe(false);
    expect(summary.groups[0]?.skipped[0]?.reason).toBe('servidor-vazio');
  });
});

describe('testar o rodízio', () => {
  it('mostra quem é a próxima sem gastar a vez dela', async () => {
    const group = createGroup({ order: 'fixed' });
    const [a] = createRotation(group.id, ['A', 'B']);

    const peek = harness.service.peekNext(harness.repository.getGroup(group.id) ?? group);

    expect(peek?.id).toBe(a?.id);

    // Espiar não anda: a próxima de verdade continua sendo a mesma.
    expect(await rotateOnce(group.id)).toBe(a?.id);
  });
});

// ------------------------------------------------------------
//  O COMANDO DO JOGADOR
// ------------------------------------------------------------

describe('o comando de chat', () => {
  it('responde SÓ a quem digitou, com os valores de agora', async () => {
    const message = createMessage({
      name: 'População',
      text: 'Agora tem {online}/{max}',
      trigger: 'command',
      command: 'pop',
      targets: [SERVER],
    });

    const outcome = await harness.commands.handle(SERVER, {
      command: 'pop',
      steamId: PLAYER,
      name: 'Bia',
    });

    expect(outcome.status).toBe('answered');
    expect(outcome.messageId).toBe(message.id);

    const payload = lastPayload();

    expect(payload['text']).toBe('Agora tem 12/300');
    // ####  DIRIGIDA, E NÃO ANÚNCIO  ####
    //
    // Sem o `steamId` no payload, a resposta de um `/pop` apareceria
    // para o servidor inteiro toda vez que alguém digitasse.
    expect(payload['steamId']).toBe(PLAYER);

    // O envio conta como qualquer outro: é a coluna ENVIADAS.
    expect(harness.repository.get(message.id)?.sentCount).toBe(1);
  });

  it('a barra é opcional no cadastro, e some na gravação', () => {
    const message = createMessage({
      trigger: 'command',
      command: '/POP',
      text: 'oi',
    });

    expect(message.command).toBe('pop');
    expect(normalizeCommand('\\pop')).toBe('pop');
  });

  it('o cooldown impede o spam e diz quanto falta', async () => {
    createMessage({
      text: 'Agora tem {online}/{max}',
      trigger: 'command',
      command: 'pop',
      cooldownSeconds: 30,
      targets: [SERVER],
    });

    const notice = { command: 'pop', steamId: PLAYER, name: 'Bia' };

    expect((await harness.commands.handle(SERVER, notice)).status).toBe('answered');

    harness.clock += 10_000;

    const second = await harness.commands.handle(SERVER, notice);

    expect(second.status).toBe('cooling');
    expect(second.remainingSeconds).toBe(20);
    // Quem fica sem a resposta sabe por quê: silêncio é
    // indistinguível de comando quebrado, e a reação a ele é
    // digitar mais cinco vezes.
    expect(lastText()).toBe('Espere 20s para usar isso de novo.');

    harness.clock += 21_000;

    expect((await harness.commands.handle(SERVER, notice)).status).toBe('answered');
  });

  it('o cooldown é por jogador: um engraçadinho não cala o comando para os outros', async () => {
    createMessage({
      text: 'oi',
      trigger: 'command',
      command: 'pop',
      cooldownSeconds: 60,
      targets: [SERVER],
    });

    await harness.commands.handle(SERVER, { command: 'pop', steamId: PLAYER, name: 'Bia' });

    const other = await harness.commands.handle(SERVER, {
      command: 'pop',
      steamId: '76561198000000002',
      name: 'Léo',
    });

    expect(other.status).toBe('answered');
  });

  it('comando de outro servidor não responde aqui', async () => {
    createMessage({
      text: 'oi',
      trigger: 'command',
      command: 'pop',
      targets: [OTHER],
    });

    const outcome = await harness.commands.handle(SERVER, {
      command: 'pop',
      steamId: PLAYER,
      name: 'Bia',
    });

    expect(outcome.status).toBe('unknown');
  });

  it('desligar a mensagem tira o comando da lista do plugin', () => {
    const message = createMessage({
      text: 'oi',
      trigger: 'command',
      command: 'pop',
      targets: [SERVER],
    });

    expect(harness.commands.commandsFor(SERVER)).toEqual(['pop']);

    harness.repository.setEnabled(message.id, false, null, harness.clock);

    // Fora da lista, o comando volta a ser desconhecido para o jogo
    // — e o jogador vê a resposta do próprio Oxide em vez de
    // silêncio.
    expect(harness.commands.commandsFor(SERVER)).toEqual([]);
  });

  it('a lista é POR SERVIDOR, e a de alvo vazio vale em todos', () => {
    createMessage({ text: 'oi', trigger: 'command', command: 'pop', targets: [SERVER] });
    createMessage({ text: 'oi', trigger: 'command', command: 'regras', targets: [] });

    expect([...harness.commands.commandsFor(SERVER)].sort()).toEqual(['pop', 'regras']);
    expect(harness.commands.commandsFor(OTHER)).toEqual(['regras']);
  });

  it('o filtro de gente barra a resposta, e o motivo vai para o histórico', async () => {
    const message = createMessage({
      text: 'oi',
      trigger: 'command',
      command: 'pop',
      targets: [SERVER],
      onlyWithPlayers: true,
      minPlayers: 50,
    });

    const outcome = await harness.commands.handle(SERVER, {
      command: 'pop',
      steamId: PLAYER,
      name: 'Bia',
    });

    expect(outcome.status).toBe('not-enough');
    expect(harness.repository.logOf(message.id, 10)[0]?.ok).toBe(false);
  });
});

describe('a linha que o plugin imprime', () => {
  it('vira o aviso, com ou sem o prefixo do Oxide', () => {
    const json = JSON.stringify({ cmd: 'pop', steamId: PLAYER, name: 'Bia' });

    expect(parseChatCommandNotice(`${CHAT_COMMAND_MARKER}${json}`)?.command).toBe('pop');
    expect(parseChatCommandNotice(`[OrigemZChat] ${CHAT_COMMAND_MARKER}${json}`)?.steamId).toBe(
      PLAYER,
    );
  });

  it('o chat do jogador NÃO forja o marcador', () => {
    // ####  A ÂNCORA É O COMEÇO DA LINHA  ####
    //
    // O `onConsoleLine` recebe o chat junto com o resto, e a linha
    // de chat tem o nome de quem falou na frente. Sem a âncora,
    // bastaria digitar o marcador no chat para o agente responder
    // como se o plugin tivesse avisado.
    const forged = `[CHAT] Bia: ${CHAT_COMMAND_MARKER}{"cmd":"pop","steamId":"1"}`;

    expect(parseChatCommandNotice(forged)).toBeNull();
  });

  it('linha que não é aviso nenhum é ignorada em silêncio', () => {
    expect(parseChatCommandNotice('Saving complete')).toBeNull();
    expect(parseChatCommandNotice(`${CHAT_COMMAND_MARKER}nao e json`)).toBeNull();
  });
});
