// ============================================================
//  messages-service.test.ts  -  o relógio, o transporte e o log.
//
//  O que este arquivo guarda:
//
//    1. o `tick` NUNCA LANÇA — nem quando o banco quebra por
//       dentro. Um `setInterval` com exceção sem dono para as
//       mensagens EM SILÊNCIO;
//    2. com o RCON desligado, NADA é marcado como enviado e o
//       `next_at` não anda; ao voltar, a mensagem sai;
//    3. `last_sent_at` só depois da entrega;
//    4. servidor vazio não consome o horário (`only_with_players`);
//    5. o comando sai em BASE64, com a cor e a tag escolhidas;
//    6. sem o plugin, cai no `say` — e o `via` diz qual caminho foi;
//    7. a fala DIRIGIDA a um jogador NÃO cai no `say` (viraria um
//       anúncio para o servidor inteiro);
//    8. variável desconhecida fica LITERAL, nunca vazia;
//    9. "testar agora" sai no chat SEM mexer no `next_at`;
//   10. o `message_log` guarda o que saiu E o que falhou;
//   11. a `once` se desliga sozinha depois de sair.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { MessagesRepository } from '../src/db/messages-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { PluginBroadcaster, decodeBroadcastPayload } from '../src/game/broadcast.js';
import { isApiError } from '../src/http/error-response.js';
import { keepsNextAt } from '../src/http/routes/messages.js';
import { createLogger } from '../src/logger.js';
import { MessagesService } from '../src/messages/service.js';
import { zonedTimeToUtc } from '../src/messages/timezone-bridge.js';
import { VariableRegistry, registerCoreVariables } from '../src/messages/variables.js';
import type { OpsRcon } from '../src/ops/service.js';
import type { MessageInput, MessageView as Message } from '../src/types/messages.js';

const SP = 'America/Sao_Paulo';
const SERVER = 'pvp1';

interface FakeServer {
  readonly commands: string[];
  connected: boolean;
  /** O `OrigemZChat` está carregado? Sem ele, o caminho é o `say`. */
  hasChatPlugin: boolean;
  /**
   * O plugin ESTÁ lá, mas responde a linha de log no lugar do JSON.
   *
   * É o servidor com o `.cs` antigo: o `Puts` de dentro do comando
   * herda o Identifier do pedido e chega antes da resposta. Ver o
   * comentário em `#sendByPlugin`.
   */
  pluginRespondeLog: boolean;
  /** O RCON estoura ao mandar qualquer coisa. */
  broken: boolean;
  /** Quantos online. `null` = não deu para perguntar. */
  online: number | null;
}

interface Harness {
  readonly db: AgentDatabase;
  readonly repository: MessagesRepository;
  readonly service: MessagesService;
  readonly variables: VariableRegistry;
  readonly server: FakeServer;
  /** O "agora" injetado. Mexer aqui é atravessar semanas. */
  clock: number;
}

let harness: Harness;

const SILENT = createLogger({ log: { level: 'silent', pretty: false } });

function fakeRcon(server: FakeServer): OpsRcon {
  return {
    get isConnected(): boolean {
      return server.connected;
    },
    send: (command: string): Promise<string> => {
      server.commands.push(command);

      if (server.broken) {
        return Promise.reject(new Error('o RCON caiu no meio'));
      }

      if (command.startsWith('origemz.chat.broadcast ')) {
        if (!server.hasChatPlugin) {
          // O console de um servidor sem o plugin devolve o eco do
          // comando desconhecido, e não JSON.
          return Promise.resolve(`Command 'origemz.chat.broadcast' not found`);
        }

        if (server.pluginRespondeLog) {
          return Promise.resolve('[OrigemZChat] [anuncio] [AVISO] Agora tem 2/300');
        }

        return Promise.resolve(JSON.stringify({ ok: true, sent: 7 }));
      }

      return Promise.resolve('');
    },
  };
}

/** O instante UTC de uma hora local em São Paulo. */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return zonedTimeToUtc({ year, month, day }, hour, minute, SP);
}

beforeEach(() => {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: SERVER,
    name: SERVER,
    identity: SERVER,
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  const server: FakeServer = {
    commands: [],
    connected: true,
    hasChatPlugin: true,
    pluginRespondeLog: false,
    broken: false,
    online: 3,
  };

  const repository = new MessagesRepository(db);
  const variables = new VariableRegistry({ logger: SILENT });

  registerCoreVariables(variables, {
    nameOf: () => 'OrigemZ PVP',
    slotsOf: () => 100,
    onlineOf: () => Promise.resolve(server.online),
  });

  const servers = {
    ids: () => [SERVER],
    contextOf: (id: string) => (id === SERVER ? { rcon: fakeRcon(server) } : null),
  };

  harness = {
    db,
    repository,
    variables,
    server,
    clock: at(2026, 8, 18, 12, 0),
    service: new MessagesService({
      repository,
      broadcaster: new PluginBroadcaster({ servers, logger: SILENT }),
      variables,
      servers,
      presence: { online: () => Promise.resolve(server.online) },
      logger: SILENT,
      now: () => harness.clock,
    }),
  };
});

afterEach(() => {
  harness.db.close();
});

/** Uma mensagem qualquer, com o que o teste pedir por cima. */
function createMessage(over: Partial<MessageInput> = {}) {
  const input: MessageInput = {
    name: 'Discord',
    text: 'Entre no nosso Discord',
    enabled: true,
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
    harness.service.nextAtFor(input, input.enabled),
    harness.clock,
  );
}

/** Faz a mensagem vencer: o horário dela passa a ser o passado. */
function makeDue(id: number): void {
  harness.repository.setNextAt(id, harness.clock - 1_000, harness.clock);
}

/** O payload decodificado do último `origemz.chat.broadcast`. */
function lastPayload(): Record<string, unknown> {
  const command = [...harness.server.commands]
    .reverse()
    .find((entry) => entry.startsWith('origemz.chat.broadcast '));

  expect(command).toBeDefined();

  return decodeBroadcastPayload((command as string).slice('origemz.chat.broadcast '.length)) as Record<
    string,
    unknown
  >;
}

describe('o relógio', () => {
  it('manda a mensagem vencida e marca o horário DEPOIS da entrega', async () => {
    const message = createMessage();

    makeDue(message.id);

    const summary = await harness.service.tick();

    expect(summary.error).toBeNull();
    expect(summary.results[0]?.delivered).toEqual([SERVER]);
    expect(summary.results[0]?.consumed).toBe(true);

    const saved = harness.repository.get(message.id);

    expect(saved?.lastSentAt).toBe(harness.clock);
    expect(saved?.sentCount).toBe(1);
    expect(saved?.nextAt).toBe(harness.clock - 1_000 + 1800 * 1_000);
  });

  it('NUNCA LANÇA: banco quebrado vira campo do retorno, e o laço vive', async () => {
    // Um `setInterval` com exceção sem dono para as mensagens em
    // silêncio — o pior desfecho para algo cuja única evidência de
    // funcionamento é aparecer no chat.
    harness.db.exec('DROP TABLE messages');

    const summary = await harness.service.tick();

    expect(summary.error).not.toBeNull();
    expect(summary.results).toEqual([]);
  });

  it('com o RCON desligado nada é marcado, e ao voltar a mensagem sai', async () => {
    const message = createMessage();

    makeDue(message.id);
    harness.server.connected = false;

    const parado = await harness.service.tick();

    expect(parado.results[0]?.consumed).toBe(false);
    expect(parado.results[0]?.skipped).toEqual([{ serverId: SERVER, reason: 'rcon-offline' }]);

    const durante = harness.repository.get(message.id);

    expect(durante?.lastSentAt).toBeNull();
    expect(durante?.sentCount).toBe(0);
    // O horário ficou EXATAMENTE como estava: é o que faz a
    // mensagem sair assim que o servidor voltar, em vez de sumir
    // até a semana que vem.
    expect(durante?.nextAt).toBe(harness.clock - 1_000);

    // E nada foi para o log: um servidor parado há uma semana
    // geraria 20 160 linhas de "RCON offline", e o log existe para
    // responder "essa mensagem está aparecendo?".
    expect(harness.service.logOf(message.id, 10)).toHaveLength(0);

    harness.server.connected = true;

    const voltou = await harness.service.tick();

    expect(voltou.results[0]?.delivered).toEqual([SERVER]);
    expect(harness.repository.get(message.id)?.sentCount).toBe(1);
  });

  it('servidor vazio não consome o horário', async () => {
    const message = createMessage({ onlyWithPlayers: true, minPlayers: 1 });

    makeDue(message.id);
    harness.server.online = 0;

    const vazio = await harness.service.tick();

    expect(vazio.results[0]?.consumed).toBe(false);
    expect(vazio.results[0]?.skipped).toEqual([{ serverId: SERVER, reason: 'servidor-vazio' }]);
    expect(harness.repository.get(message.id)?.nextAt).toBe(harness.clock - 1_000);

    // O primeiro jogador que entra recebe a mensagem LOGO, em vez
    // de esperar meia hora porque o contador correu sozinho.
    harness.server.online = 1;

    expect((await harness.service.tick()).results[0]?.delivered).toEqual([SERVER]);
  });

  it('"não consegui contar" não é zero, e também não é permissão', async () => {
    const message = createMessage({ onlyWithPlayers: true });

    makeDue(message.id);
    harness.server.online = null;

    const summary = await harness.service.tick();

    expect(summary.results[0]?.skipped).toEqual([
      { serverId: SERVER, reason: 'nao-consegui-contar' },
    ]);
    expect(summary.results[0]?.consumed).toBe(false);
  });

  it('fora da janela nada sai, e o horário fica de pé', async () => {
    // Meio-dia, com janela das 22:00 às 02:00.
    const message = createMessage({ windowFrom: '22:00', windowTo: '02:00' });

    makeDue(message.id);

    const dia = await harness.service.tick();

    expect(dia.results[0]?.consumed).toBe(false);
    expect(dia.results[0]?.skipped).toEqual([{ serverId: '*', reason: 'fora-da-janela' }]);

    // 23:30: dentro da janela que vira a meia-noite.
    harness.clock = at(2026, 8, 18, 23, 30);
    makeDue(message.id);

    expect((await harness.service.tick()).results[0]?.delivered).toEqual([SERVER]);
  });

  it('a `once` sai uma vez e se desliga sozinha', async () => {
    const message = createMessage({
      scheduleKind: 'once',
      everySeconds: null,
      runAt: at(2026, 8, 25, 2, 0),
    });

    expect(message.nextAt).toBe(at(2026, 8, 25, 2, 0));

    harness.clock = at(2026, 8, 25, 2, 0) + 5_000;

    const summary = await harness.service.tick();

    expect(summary.results[0]?.delivered).toEqual([SERVER]);

    const saved = harness.repository.get(message.id);

    // Uma "manutenção às 03:00" que continuasse ligada reapareceria
    // no mês seguinte, sozinha, sem manutenção nenhuma.
    expect(saved?.enabled).toBe(false);
    expect(saved?.nextAt).toBeNull();
    expect(saved?.sentCount).toBe(1);

    // E a volta seguinte não a pega mais.
    expect((await harness.service.tick()).due).toBe(0);
  });
});

describe('o transporte', () => {
  it('o comando sai em BASE64, com a tag e as cores escolhidas', async () => {
    const message = createMessage({
      text: 'Seja VIP',
      tag: '[AVISO]',
      tagColor: '#ffcc00',
      color: '#ffffff',
      size: 14,
    });

    makeDue(message.id);
    await harness.service.tick();

    // JSON cru pelo RCON chega ao plugin com as aspas comidas — o
    // parser de console do Rust trata token entre aspas como
    // argumento citado e as remove. Ver Plugins/OrigemZChat.cs.
    expect(lastPayload()).toEqual({
      text: 'Seja VIP',
      tag: '[AVISO]',
      tagColor: '#ffcc00',
      color: '#ffffff',
      size: 14,
      steamId: '',
    });
  });

  it('sem o plugin, cai no `say` — e o `via` diz qual caminho foi', async () => {
    harness.server.hasChatPlugin = false;

    const result = await harness.service.speak({
      serverId: SERVER,
      text: 'Entre no "Discord" <b>agora</b>',
      tag: '[AVISO]',
    });

    expect(result.via).toBe('say');
    // Aspas e marcação fora: o `say` do Rust quebra com aspas no
    // meio, e `<color>` deixaria uma integração se passar por
    // mensagem de admin.
    expect(harness.server.commands.at(-1)).toBe('say "[AVISO] Entre no Discord bagora/b"');
    // Zero aqui quer dizer DESCONHECIDO: o jogo não devolve quantos
    // receberam, e é o `via` que avisa.
    expect(result.sent).toBe(0);
  });

  it('o `say` não mostra os marcadores de cor', async () => {
    harness.server.hasChatPlugin = false;

    const result = await harness.service.speak({
      serverId: SERVER,
      text: 'Agora tem [verde]3[/]/300',
    });

    // O `say` do jogo não tem cor nenhuma. Sem tirar a marcação,
    // o jogador leria `[verde]3[/]` na tela — pior que a fala sem
    // destaque nenhum.
    expect(result.via).toBe('say');
    expect(harness.server.commands.at(-1)).toBe('say "Agora tem 3/300"');
  });

  it('o plugin que responde o log no lugar do JSON NÃO faz a fala sair duas vezes', async () => {
    // A duplicata que apareceu no chat de verdade:
    //
    //     [AVISO] Agora tem 2/300
    //     SERVER "[AVISO] Agora tem 2/300"
    //
    // O plugin tinha entregue a fala; o que não chegou foi o JSON,
    // porque o `Puts` dele saiu com o Identifier do pedido e o
    // agente casou o log como resposta. Concluir "o plugin não
    // está lá" e falar de novo pelo `say` é o pior desfecho:
    // repete para o servidor inteiro.
    harness.server.pluginRespondeLog = true;

    const result = await harness.service.speak({
      serverId: SERVER,
      text: 'Agora tem 2/300',
      tag: '[AVISO]',
    });

    expect(result.via).toBe('plugin');
    expect(harness.server.commands.some((command) => command.startsWith('say '))).toBe(false);
    // Zero porque o plugin antigo não contou, e não porque ninguém
    // recebeu. O log do agente é quem pede a atualização do `.cs`.
    expect(result.sent).toBe(0);
  });

  it('a fala DIRIGIDA a um jogador não cai no `say`', async () => {
    harness.server.hasChatPlugin = false;

    // O `say` falaria para o servidor inteiro: um recado privado
    // viraria anúncio. Falhar é o desfecho certo.
    await expect(
      harness.service.speak({ serverId: SERVER, text: 'Sua compra caiu', steamId: '76561198000000001' }),
    ).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.code === 'CHAT_PLUGIN_UNAVAILABLE',
    );

    expect(harness.server.commands.some((entry) => entry.startsWith('say '))).toBe(false);
  });

  it('sem RCON o transporte recusa com 503, e não em silêncio', async () => {
    harness.server.connected = false;

    await expect(harness.service.speak({ serverId: SERVER, text: 'oi' })).rejects.toSatisfy(
      (error: unknown) => isApiError(error) && error.status === 503,
    );
  });
});

describe('as variáveis', () => {
  it('troca as do núcleo e deixa a desconhecida LITERAL', async () => {
    const message = createMessage({
      text: '{servidor}: {online}/{max} online, wipe em {wipe.faltan}',
    });

    makeDue(message.id);
    await harness.service.tick();

    // `{wipe.faltan}` é feio e se conserta em dez segundos; uma
    // frase que perde metade em silêncio ninguém descobre.
    expect(lastPayload().text).toBe('OrigemZ PVP: 3/100 online, wipe em {wipe.faltan}');
  });

  it('um namespace registrado por outra frente entra sem este módulo saber de wipe', async () => {
    harness.variables.setNamespace('wipe', (rest) =>
      rest === 'faltam' ? '6 dias e 4 horas' : null,
    );

    const message = createMessage({ text: 'O wipe é em {wipe.faltam} ({wipe.mapa})' });

    makeDue(message.id);
    await harness.service.tick();

    // O que o provedor não sabe continua literal, e não vira vazio.
    expect(lastPayload().text).toBe('O wipe é em 6 dias e 4 horas ({wipe.mapa})');
  });

  it('um provedor que lança não derruba a frase inteira', async () => {
    harness.variables.setNamespace('wipe', () => {
      throw new Error('a agenda não respondeu');
    });

    const message = createMessage({ text: 'Wipe em {wipe.faltam}. Entre no Discord!' });

    makeDue(message.id);
    await harness.service.tick();

    expect(lastPayload().text).toBe('Wipe em {wipe.faltam}. Entre no Discord!');
  });

  it('"não deu para contar" deixa `{online}` literal, e não escreve 0', async () => {
    harness.server.online = null;

    const message = createMessage({ text: '{online} jogando agora' });

    makeDue(message.id);
    await harness.service.tick();

    // Dizer "0 jogadores online" num servidor cheio porque o RCON
    // piscou é pior que a frase com a variável crua.
    expect(lastPayload().text).toBe('{online} jogando agora');
  });
});

describe('testar agora', () => {
  it('sai no chat SEM mexer no next_at', async () => {
    const message = createMessage();
    const antes = harness.repository.get(message.id)?.nextAt;

    const reports = await harness.service.test(message);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.ok).toBe(true);
    expect(reports[0]?.players).toBe(7);
    expect(reports[0]?.via).toBe('plugin');

    const depois = harness.repository.get(message.id);

    // Se testar consumisse o horário, conferir a mensagem seria
    // mudá-la — e dois cliques empurrariam a próxima saída.
    expect(depois?.nextAt).toBe(antes);
    expect(depois?.lastSentAt).toBeNull();
    expect(depois?.sentCount).toBe(0);
  });

  it('o teste que falha aparece no relatório, com o motivo', async () => {
    const message = createMessage();

    harness.server.connected = false;

    const reports = await harness.service.test(message);

    expect(reports[0]?.ok).toBe(false);
    expect(reports[0]?.error).toContain('RCON');
  });
});

describe('o message_log', () => {
  it('responde "essa mensagem está mesmo aparecendo?" — inclusive quando não', async () => {
    const message = createMessage();

    makeDue(message.id);
    await harness.service.tick();

    // Agora o RCON estoura no meio: a tentativa ACONTECEU, e ela
    // entra no log com o motivo.
    harness.server.broken = true;
    makeDue(message.id);
    await harness.service.tick();

    const entries = harness.service.logOf(message.id, 10);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.ok).toBe(false);
    expect(entries[0]?.error).not.toBeNull();
    expect(entries[1]?.ok).toBe(true);
    expect(entries[1]?.players).toBe(7);

    // E a falha não consumiu o horário.
    expect(harness.repository.get(message.id)?.sentCount).toBe(1);
  });

  it('a poda deixa as mais novas e leva as antigas', () => {
    const message = createMessage();

    for (let i = 0; i < 12; i += 1) {
      harness.repository.log({
        messageId: message.id,
        serverId: SERVER,
        at: harness.clock + i,
        players: 1,
        ok: true,
        error: null,
      });
    }

    expect(harness.repository.pruneLog(5)).toBe(7);
    expect(harness.service.logOf(message.id, 100)).toHaveLength(5);
  });
});

describe('os alvos', () => {
  it('lista vazia quer dizer TODOS os servidores', async () => {
    const message = createMessage({ targets: [] });

    makeDue(message.id);

    expect((await harness.service.tick()).results[0]?.delivered).toEqual([SERVER]);
  });

  it('um alvo que o agente não está cuidando é IGNORADO, e não vira falha', async () => {
    // Cadastrado no banco, mas fora da frota montada — é o
    // servidor com SERVER_ENABLED=0, ou o que o agente ainda não
    // adotou. Não há a quem entregar, e isso não é o mesmo que "a
    // entrega falhou": a linha não vai para o log, e o horário não
    // anda.
    new ServersRepository(harness.db).create({
      id: 'pve01',
      name: 'pve01',
      identity: 'pve01',
      gamePort: 28_115,
      rconPort: 28_116,
      queryPort: 28_117,
      appPort: 28_182,
      installDir: 'F:\\Servers\\pve01',
    });

    const message = createMessage({ targets: ['pve01'] });

    harness.repository.setNextAt(message.id, harness.clock - 1_000, harness.clock);

    const summary = await harness.service.tick();

    expect(summary.results[0]?.delivered).toEqual([]);
    expect(summary.results[0]?.failed).toEqual([]);
    expect(summary.results[0]?.skipped).toEqual([
      { serverId: 'pve01', reason: 'servidor-desconhecido' },
    ]);
    expect(summary.results[0]?.consumed).toBe(false);
    expect(harness.service.logOf(message.id, 10)).toHaveLength(0);
  });

  it('apagar o servidor esvazia os alvos — e VAZIO quer dizer TODOS', async () => {
    const message = createMessage({ targets: [SERVER] });

    // ####  ESTE É O EFEITO COLATERAL DA CASCATA, E ELE É REAL  ####
    //
    // `message_targets.server_id` referencia `servers(id)` com ON
    // DELETE CASCADE, que é a convenção do banco (ver a migração
    // 001). Tirar da frota o ÚNICO alvo de uma mensagem deixa a
    // lista vazia — e lista vazia quer dizer TODOS. O teste existe
    // para que essa consequência esteja escrita em algum lugar, e
    // não seja descoberta no dia em que um aviso de PVE aparecer
    // no servidor de PVP.
    harness.db.prepare('DELETE FROM message_targets WHERE message_id = @id').run({ id: message.id });
    harness.repository.setNextAt(message.id, harness.clock - 1_000, harness.clock);

    expect((await harness.service.tick()).results[0]?.delivered).toEqual([SERVER]);
  });
});

describe('editar sem adiar', () => {
  it('corrigir o texto NÃO empurra a próxima saída', () => {
    const message = createMessage();
    const merged = { ...toInput(message), text: 'Entre no nosso Discord: discord.gg/origemz' };

    // Corrigindo três vezes um erro de digitação, o admin calaria a
    // mensagem por uma hora e meia — e sem entender por quê.
    expect(keepsNextAt(message, merged)).toBe(true);
  });

  it('trocar o ritmo REFAZ o horário', () => {
    const message = createMessage();

    expect(keepsNextAt(message, { ...toInput(message), everySeconds: 600 })).toBe(false);
    expect(
      keepsNextAt(message, {
        ...toInput(message),
        scheduleKind: 'daily',
        everySeconds: null,
        timeOfDay: '20:00',
      }),
    ).toBe(false);
    expect(keepsNextAt(message, { ...toInput(message), timeZone: 'UTC' })).toBe(false);
  });

  it('religar REFAZ o horário: o gravado é de semanas atrás', () => {
    const message = createMessage({ enabled: false });

    expect(keepsNextAt(message, { ...toInput(message), enabled: true })).toBe(false);
  });
});

/** A visão gravada vira o input que o PATCH produz depois da mistura. */
function toInput(message: Message): MessageInput {
  return {
    name: message.name,
    text: message.text,
    enabled: message.enabled,
    scheduleKind: message.scheduleKind,
    everySeconds: message.everySeconds,
    timeOfDay: message.timeOfDay,
    weekdays: message.weekdays,
    runAt: message.runAt,
    timeZone: message.timeZone,
    windowFrom: message.windowFrom,
    windowTo: message.windowTo,
    onlyWithPlayers: message.onlyWithPlayers,
    minPlayers: message.minPlayers,
    tag: message.tag,
    tagColor: message.tagColor,
    color: message.color,
    size: message.size,
    targets: message.targets,
  };
}
