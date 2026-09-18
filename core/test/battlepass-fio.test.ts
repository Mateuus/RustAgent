// ============================================================
//  O FIO entre o agente e o OrigemZBattlePass.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  As duas pontas do passe existiam e não se falavam: o plugin
//  esperava uma carga que ninguém enviava, e o clique do jogador não
//  chegava a lugar nenhum. Os casos abaixo são os modos de esse fio
//  se romper SEM ninguém perceber:
//
//    carga em formato errado   o plugin responde `INVALID_ARGS` e a
//                              trilha fica vazia, sem nada no log do
//                              jogo
//    push sem segredo          um jogador digita `#OZPASSE#` no chat
//                              e resgata a trilha inteira
//    `ready` ignorado          o plugin reinicia, pede a carga, e
//                              fica com a cópia do disco — sem o
//                              segredo desta subida, ele recusa
//                              TODO pedido da tela
//    reply sem progress        o resgate recusado continua
//                              "esperando" na tela até o jogador
//                              fechar e reabrir o menu
//    linha repetida            o console repete em reconexão, e o
//                              mesmo pedido vira duas escritas
//    comando de dentro do
//    gancho de console         a linha volta pelo gancho e o agente
//                              entra em laço com ele mesmo
// ============================================================

import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { BattlePassService, type BattlePassActor } from '../src/battlepass/service.js';
import { BattlePassRepository } from '../src/db/battlepass-repository.js';
import { MEMORY_DATABASE, openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import {
  BATTLEPASS_CHUNK_CHARS,
  BATTLEPASS_MARKER,
  BattlePassSync,
  cleanReply,
  endOfPeriod,
} from '../src/game/battlepass.js';
import { decodePushPayload } from '../src/game/plugin-push.js';
import {
  BATTLEPASS_PARTS_REPLY,
  BATTLEPASS_PROGRESS,
  BATTLEPASS_REPLY,
  BATTLEPASS_SYNC,
  seasonInputSchema,
  type BattlePassPartsPayload,
  type BattlePassPayload,
  type BattlePassProgressPayload,
  type SeasonInput,
} from '../src/types/battlepass.js';
import { questRewardSchema, type QuestReward } from '../src/types/quests.js';

const silent = pino({ level: 'silent' });
const SERVER = 'pvp1';
const OTHER = 'pvp2';
const PLAYER = '76561190000000001';
const PLAYER_2 = '76561190000000002';
const PANEL: BattlePassActor = { name: 'admin', source: 'panel' };
const T0 = 1_800_000_000_000;

const AK: QuestReward = questRewardSchema.parse({ kind: 'item', shortname: 'rifle.ak', amount: 1 });
const COINS: QuestReward = questRewardSchema.parse({ kind: 'coins', amount: 500 });

interface SentCommand {
  readonly server: string;
  readonly command: string;
}

interface Harness {
  readonly service: BattlePassService;
  readonly sync: BattlePassSync;
  /** Todo comando que saiu pelo RCON, na ordem, com o servidor. */
  readonly sent: SentCommand[];
  /** servidor -> quem está online. */
  readonly online: Map<string, string[]>;
  /** As compras que o botão ATIVAR O PASSE pediu à loja. */
  readonly bought: string[];
  /**
   * Os kits que o catálogo conhece AGORA.
   *
   * Mutável de propósito: apagar um é o caso que a trilha não
   * consegue evitar — o admin some com o kit depois de a temporada
   * tê-lo prometido.
   */
  readonly kits: Map<
    string,
    { name: string; items: { shortname: string; amount: number; skinId: string }[] }
  >;
  connected: boolean;
  /** A oferta de passe que a "loja" conhece. `null` = fora de venda. */
  offer: { id: string; price: number } | null;
  /** O que a loja responde à próxima compra. */
  buyOk: boolean;
  now: number;
}

function harness(): Harness {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  const servers = new ServersRepository(db);

  for (const [index, id] of [SERVER, OTHER].entries()) {
    servers.create({
      id,
      name: `Dev ${String(index + 1)}`,
      identity: id,
      gamePort: 28_015 + index * 10,
      rconPort: 28_016 + index * 10,
      queryPort: 28_017 + index * 10,
      appPort: 28_082 + index * 10,
      installDir: `F:\\Servers\\${id}`,
    });
  }

  const state = {
    sent: [] as SentCommand[],
    online: new Map<string, string[]>([
      [SERVER, [PLAYER]],
      [OTHER, []],
    ]),
    bought: [] as string[],
    kits: new Map([
      [
        'inicial',
        {
          name: 'Kit Inicial',
          items: [
            { shortname: 'rifle.ak', amount: 1, skinId: '0' },
            { shortname: 'metal.refined', amount: 250, skinId: '0' },
          ],
        },
      ],
    ]),
    connected: true,
    offer: { id: 'passe-outubro', price: 2500 } as { id: string; price: number } | null,
    buyOk: true,
    now: T0,
  } as Omit<Harness, 'service' | 'sync'> & {
    service: BattlePassService;
    sync: BattlePassSync;
  };

  // ####  O RCON DE MENTIRA  ####
  //
  // Ele responde `{"ok":true}` ao que o plugin conhece e vazio ao
  // resto — que é o que um servidor sem o plugin faz. Guardar o
  // comando cru é o que permite provar o FORMATO do que saiu, e não
  // só que "algo saiu".
  const rconOf = (server: string) => ({
    get isConnected() {
      return state.connected;
    },
    send: (command: string) => {
      state.sent.push({ server, command });

      if (
        command.startsWith(BATTLEPASS_SYNC) ||
        command.startsWith(BATTLEPASS_PROGRESS) ||
        command.startsWith(BATTLEPASS_REPLY) ||
        command.startsWith(BATTLEPASS_PARTS_REPLY)
      ) {
        return Promise.resolve(JSON.stringify({ ok: true }));
      }

      return Promise.resolve('');
    },
  });

  const rcons = new Map([
    [SERVER, rconOf(SERVER)],
    [OTHER, rconOf(OTHER)],
  ]);

  state.service = new BattlePassService({
    repository: new BattlePassRepository(db),
    serverIds: () => servers.list().map((server) => server.id),
    onChange: () => state.sync.handleSeasonChanged(),
    onPlayerChange: (serverId, steamId) => state.sync.handlePlayerChanged(serverId, steamId),
  });

  state.sync = new BattlePassSync({
    service: state.service,
    servers: {
      ids: () => servers.list().map((server) => server.id),
      contextOf: (id) => {
        const rcon = rcons.get(id);

        return rcon === undefined ? null : { rcon };
      },
      onlineOf: (id) => state.online.get(id) ?? [],
    },
    serverNameOf: (id) => servers.get(id)?.name ?? id,
    catalog: {
      itemOf: (shortname) =>
        shortname === 'rifle.ak'
          ? { itemId: 1_545_779_598, displayName: 'Assault Rifle' }
          : shortname === 'metal.refined'
            ? { itemId: 69_511_070, displayName: 'Metal Refinado' }
            : null,
    },
    kitOf: (slug) => state.kits.get(slug) ?? null,
    store: {
      passOffer: () => state.offer,
      buy: (input) => {
        state.bought.push(input.offerId);

        return Promise.resolve(
          state.buyOk
            ? { ok: true, message: 'Passe ativado!' }
            : { ok: false, message: 'Saldo insuficiente.' },
        );
      },
    },
    logger: silent,
    now: () => state.now,
  });

  return state;
}

/** Uma temporada de outubro, publicada e com duas casas cheias. */
function publish(h: Harness, overrides: Partial<SeasonInput> = {}): number {
  const input: SeasonInput = seasonInputSchema.parse({
    period: '2026-10',
    label: 'Temporada de outubro de 2026',
    levels: 5,
    xpCurve: { kind: 'flat', perLevel: 1000 },
    servers: [SERVER],
    ...overrides,
  });
  const season = h.service.createSeason(input, PANEL);

  h.service.setTrackCell(season.id, 1, 'free', { rewards: [AK], milestone: false }, PANEL);
  h.service.setTrackCell(season.id, 2, 'free', { rewards: [COINS], milestone: true }, PANEL);
  h.service.setTrackCell(season.id, 2, 'paid', { rewards: [AK, COINS], milestone: false }, PANEL);
  h.service.setSeasonState(season.id, 'active', PANEL);

  return season.id;
}

/** Os comandos que saíram com aquele prefixo. */
function commandsOf(h: Harness, prefix: string, server = SERVER): string[] {
  return h.sent
    .filter((entry) => entry.server === server)
    .map((entry) => entry.command)
    .filter((line) => line.startsWith(`${prefix} `));
}

/** Remonta o último lote de um comando, juntando os pedaços. */
function lastBatch(h: Harness, prefix: string, server = SERVER): unknown {
  const commands = commandsOf(h, prefix, server);
  const last = commands.at(-1);

  if (last === undefined) throw new Error(`nenhum ${prefix} saiu`);

  const tail = (line: string): string[] => line.slice(prefix.length + 1).split(' ');
  const [batch, , total] = tail(last);
  const parts = commands
    .filter((line) => tail(line)[0] === batch)
    .slice(-Number(total))
    .map((line) => tail(line)[3] ?? '');

  return decodePushPayload(parts.join(''));
}

function lastPayload(h: Harness, server = SERVER): BattlePassPayload {
  return lastBatch(h, BATTLEPASS_SYNC, server) as BattlePassPayload;
}

function lastProgress(h: Harness, steamId = PLAYER, server = SERVER): BattlePassProgressPayload {
  return lastBatch(h, `${BATTLEPASS_PROGRESS} ${steamId}`, server) as BattlePassProgressPayload;
}

/** O segredo desta subida, lido da carga — que é como o plugin o recebe. */
async function grabSecret(h: Harness): Promise<string> {
  await h.sync.sync(SERVER, 'manual');

  return lastPayload(h).secret;
}

/** Uma linha do console, como o `Puts` do Oxide a escreve. */
function pluginLine(payload: Record<string, unknown>): string {
  return `[OrigemZBattlePass] ${BATTLEPASS_MARKER}${JSON.stringify(payload)}`;
}

/** Deixa os relógios (1 s do sync, 0 do pedido) dispararem. */
async function settle(ms = 1400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
//  A CARGA
// ============================================================

describe('o catálogo que desce para o plugin', () => {
  it('leva a temporada, a trilha e o preço, com o segredo desta subida', async () => {
    const h = harness();

    publish(h);

    const payload = h.sync.buildPayload(SERVER);

    expect(payload).not.toBeNull();
    expect(payload?.period).toBe('2026-10');
    expect(payload?.name).toBe('Temporada de outubro de 2026');
    // O nome do SERVIDOR, e não o id: sem ele a primeira queixa é
    // "meu nível sumiu" — o XP é por servidor.
    expect(payload?.serverName).toBe('Dev 1');
    expect(payload?.secret).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload?.purchasable).toBe(true);
    expect(payload?.priceLabel).toBe('2.500 OZCOIN');
    expect(payload?.levels).toHaveLength(5);

    // O XP é o ACUMULADO que alcança o nível, e não o custo do
    // degrau: o nível 1 é de graça.
    expect(payload?.levels[0]?.xp).toBe(0);
    expect(payload?.levels[1]?.xp).toBe(1000);

    // A faixa traz o texto que o jogador lê, em português, montado
    // pelo agente — e o shortname para o plugin achar o `itemid`.
    expect(payload?.levels[0]?.free).toEqual({
      kind: 'item',
      label: '1x Assault Rifle',
      shortname: 'rifle.ak',
      skinId: '0',
    });
    // Faixa AUSENTE é como se diz "este nível não dá nada aqui".
    expect(payload?.levels[0]?.paid).toBeUndefined();
    // O marco vira destaque de tamanho no card do plugin.
    expect(payload?.levels[1]?.free?.milestone).toBe(true);
  });

  it('a célula com duas recompensas vira uma linha só, com o ícone da primeira que tem arte', () => {
    const h = harness();

    publish(h);

    // O contrato do plugin tem UMA faixa por nível, e a trilha
    // guarda uma LISTA: as duas se encontram no rótulo.
    expect(h.sync.buildPayload(SERVER)?.levels[1]?.paid).toEqual({
      kind: 'item',
      label: '1x Assault Rifle + 500 OZCoin',
      shortname: 'rifle.ak',
      skinId: '0',
    });
  });

  it('sem temporada no ar, NADA desce — nem uma carga vazia', async () => {
    const h = harness();

    expect(h.sync.buildPayload(SERVER)).toBeNull();

    const outcome = await h.sync.sync(SERVER, 'startup');

    // Uma carga vazia APAGARIA a trilha do servidor que está entre
    // duas temporadas. "Não sei" e "não tem" são respostas
    // diferentes.
    expect(outcome).toEqual({ status: 'skipped', reason: 'sem temporada ativa' });
    expect(commandsOf(h, BATTLEPASS_SYNC)).toHaveLength(0);
  });

  it('vai em pedaços, e no MESMO formato mesmo com um pedaço só', async () => {
    const h = harness();

    publish(h);
    await h.sync.sync(SERVER, 'startup');

    const commands = commandsOf(h, BATTLEPASS_SYNC);

    expect(commands).toHaveLength(1);

    // `<comando> <lote> <i> <n> <base64>` — o plugin lê os quatro
    // argumentos SEMPRE. A forma de um argumento só existe lá para o
    // teste manual no console, e ter dois caminhos no envio seria
    // duas coisas para manter em dia.
    const [lote, indice, total, pedaco] = commands[0]!.slice(BATTLEPASS_SYNC.length + 1).split(' ');

    expect(lote).toMatch(/^[0-9a-f]{12}$/);
    expect(indice).toBe('0');
    expect(total).toBe('1');
    expect(pedaco).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('a carga grande é cortada, e as partes remontam o original', async () => {
    const h = harness();
    // Uma trilha de 200 níveis com rótulo em cada faixa passa dos
    // 40 KB de um pedaço.
    const seasonId = publish(h, { levels: 200, xpCurve: { kind: 'flat', perLevel: 1000 } });

    for (let level = 1; level <= 200; level += 1) {
      h.service.setTrackCell(seasonId, level, 'free', { rewards: [AK, COINS], milestone: false }, PANEL);
      h.service.setTrackCell(seasonId, level, 'paid', { rewards: [AK, COINS], milestone: true }, PANEL);
    }

    await h.sync.sync(SERVER, 'startup');

    const commands = commandsOf(h, BATTLEPASS_SYNC);

    expect(commands.length).toBeGreaterThan(1);

    for (const [index, command] of commands.entries()) {
      const parts = command.slice(BATTLEPASS_SYNC.length + 1).split(' ');

      expect(parts[1]).toBe(String(index));
      expect(parts[2]).toBe(String(commands.length));
      expect(parts[4]).toBeUndefined();
      expect((parts[3] ?? '').length).toBeLessThanOrEqual(BATTLEPASS_CHUNK_CHARS);
    }

    // E o que chega do outro lado é o que saiu daqui.
    expect((lastPayload(h) as BattlePassPayload).levels).toHaveLength(200);
  });

  it('a mesma carga duas vezes vira um envio só; o forçado passa mesmo assim', async () => {
    const h = harness();

    publish(h);

    await h.sync.sync(SERVER, 'manual');
    expect(commandsOf(h, BATTLEPASS_SYNC)).toHaveLength(1);

    expect(await h.sync.sync(SERVER, 'manual')).toEqual({ status: 'unchanged' });
    expect(commandsOf(h, BATTLEPASS_SYNC)).toHaveLength(1);

    // O plugin que acabou de subir não tem carga nenhuma: dizer-lhe
    // "não mudou nada" seria deixá-lo com a cópia do disco, sem o
    // segredo desta subida.
    expect((await h.sync.sync(SERVER, 'rcon-connected')).status).toBe('sent');
    expect(commandsOf(h, BATTLEPASS_SYNC)).toHaveLength(2);
  });

  it('sem RCON não é erro, e o que não entrou não fica marcado como entrado', async () => {
    const h = harness();

    publish(h);
    h.connected = false;

    expect(await h.sync.sync(SERVER, 'startup')).toEqual({ status: 'skipped', reason: 'sem RCON' });

    h.connected = true;

    expect((await h.sync.sync(SERVER, 'manual')).status).toBe('sent');
  });

  it('o fim da temporada é o último instante do mês', () => {
    // `0` = não sei, e o plugin não desenha prazo nenhum — melhor
    // que uma data de 1970 dizendo que a temporada acabou.
    expect(endOfPeriod('2026-10')).toBe(Date.UTC(2026, 10, 1) - 1);
    expect(new Date(endOfPeriod('2026-12')).toISOString()).toBe('2026-12-31T23:59:59.999Z');
    expect(endOfPeriod('lixo')).toBe(0);
  });
});

// ============================================================
//  O PROGRESSO
// ============================================================

describe('o progresso de um jogador', () => {
  it('traz o nível, a barra e SÓ as exceções da trilha', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    const payload = h.sync.buildProgressPayload(SERVER, PLAYER);

    expect(payload?.period).toBe('2026-10');
    expect(payload?.level).toBe(3);
    expect(payload?.xp).toBe(2400);
    expect(payload?.xpInto).toBe(400);
    expect(payload?.xpNeeded).toBe(1000);
    expect(payload?.hasPass).toBe(false);
    // Ninguém resgatou nada ainda: a lista vazia é informação, e o
    // plugin DERIVA o resto pela regra do 01 §4.1.
    expect(payload?.claims).toEqual([]);
    expect(payload?.pending).toEqual([]);
  });

  it('a lista de claims traz só o que a regra não derivaria', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );
    h.service.claim({ serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' }, PANEL, h.now);

    const payload = h.sync.buildProgressPayload(SERVER, PLAYER);

    // Uma linha só, e não as dez casas da trilha: o resto o plugin
    // deriva, e duas fontes para a mesma verdade divergem no
    // primeiro caso de borda.
    expect(payload?.claims).toEqual([{ level: 1, lane: 'free', state: 'pending' }]);
  });

  it('a caixa desce com a origem que o plugin sabe distinguir', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    const { claim } = h.service.claim(
      { serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' },
      PANEL,
      h.now,
    );

    h.service.settle(claim.id, [{ idx: 0, ok: false, code: 'INVENTORY_FULL' }], 'inventory', h.now);

    const payload = h.sync.buildProgressPayload(SERVER, PLAYER);

    // `full` = não coube na mochila; `season` = sobrou da temporada
    // anterior. No banco elas se chamam `inventory` e `rollover`.
    expect(payload?.pending).toEqual([{ label: '1x Assault Rifle', origin: 'full' }]);
    // E o ponto de notificação está aceso: ele ainda não olhou.
    expect(payload?.boxSeen).toBe(false);
  });

  it('o progresso do jogador leva o `<steamId>` ANTES do lote', async () => {
    const h = harness();

    publish(h);
    await h.sync.syncProgress(SERVER, PLAYER, 'manual');

    const command = commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER}`).at(0) ?? '';
    const parts = command.split(' ');

    expect(parts[0]).toBe(BATTLEPASS_PROGRESS);
    expect(parts[1]).toBe(PLAYER);
    expect(parts[2]).toMatch(/^[0-9a-f]{12}$/);
    expect(parts[3]).toBe('0');
    expect(parts[4]).toBe('1');
  });

  it('o catálogo vai ANTES do progresso: o plugin recusa a ordem inversa', async () => {
    const h = harness();

    publish(h);
    await h.sync.syncAll('startup');

    const order = h.sent
      .filter((entry) => entry.server === SERVER)
      .map((entry) => entry.command.split(' ')[0]);

    expect(order[0]).toBe(BATTLEPASS_SYNC);
    expect(order[1]).toBe(BATTLEPASS_PROGRESS);
  });

  it('quem entra recebe a trilha dele, forçada', async () => {
    const h = harness();

    publish(h);
    await h.sync.syncAll('startup');

    const before = commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER}`).length;

    // O plugin NÃO guarda progresso em disco: quem entra é
    // desconhecido lá, e a digital daqui pode ser de outra sessão.
    h.sync.handlePlayersJoined(SERVER, [PLAYER]);
    await settle();

    expect(commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER}`).length).toBe(before + 1);
  });

  it('o XP creditado reenvia a trilha de quem mudou, e só dele', async () => {
    const h = harness();

    publish(h);
    h.online.set(SERVER, [PLAYER, PLAYER_2]);
    await h.sync.syncAll('startup');

    const before = commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER_2}`).length;

    // `onPlayerChange` -> `handlePlayerChanged`. É o fio que faz a
    // rodada de XP aparecer na tela sem ninguém pedir.
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 1200 },
      h.now,
    );
    await settle();

    expect(lastProgress(h).level).toBe(2);
    expect(commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER_2}`).length).toBe(before);
  });
});

// ============================================================
//  O QUE SOBE PELO CONSOLE
// ============================================================

describe('o que o plugin grita no console', () => {
  it('o `ready` provoca a carga, e ele é o ÚNICO sem segredo', async () => {
    const h = harness();

    publish(h);
    h.sync.handleLine(SERVER, pluginLine({ kind: 'ready' }));

    // NADA sai de dentro do gancho: o comando iria para o console, a
    // linha voltaria pelo mesmo gancho, e o agente entraria em laço
    // com ele mesmo.
    expect(h.sent).toHaveLength(0);

    await settle();

    expect(commandsOf(h, BATTLEPASS_SYNC)).toHaveLength(1);
    expect(commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER}`)).toHaveLength(1);
  });

  it('push sem o segredo não faz NADA', async () => {
    const h = harness();

    publish(h);
    await grabSecret(h);
    // O `publish` acima disparou o `onChange`, e ele tem um relógio
    // de 1 s. Medir antes dele assentar contaria a carga que ele
    // manda como se fosse deste pedido.
    await settle();

    const before = h.sent.length;

    // É o ataque que o segredo existe para barrar: o `onConsoleLine`
    // recebe o chat junto com o resto.
    h.sync.handleLine(
      SERVER,
      pluginLine({
        kind: 'claim',
        secret: 'nao-e-o-segredo',
        requestId: 'forjado',
        steamId: PLAYER,
        level: 1,
        lane: 'free',
      }),
    );
    await settle();

    expect(h.sent).toHaveLength(before);
    // E nada foi gravado: a trilha dele continua intocada.
    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([]);
  });

  it('a linha de CHAT não vira pedido, nem com o segredo certo', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    await settle();

    const before = h.sent.length;

    // O chat do Rust traz o nome de quem falou ANTES do texto. A
    // âncora de linha é o que separa o plugin do jogador.
    h.sync.handleLine(
      SERVER,
      `Fulano[123/76561190000000009] : ${BATTLEPASS_MARKER}${JSON.stringify({
        kind: 'claim',
        secret,
        requestId: 'pelo-chat',
        steamId: PLAYER,
        level: 1,
        lane: 'free',
      })}`,
    );
    await settle();

    expect(h.sent).toHaveLength(before);
    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([]);
  });

  it('o `claim` chama o serviço, responde pelo reply e manda o progress atrás', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    const secret = await grabSecret(h);

    h.sent.length = 0;
    h.sync.handleLine(
      SERVER,
      pluginLine({
        kind: 'claim',
        secret,
        requestId: 'req-1',
        steamId: PLAYER,
        level: 1,
        lane: 'free',
      }),
    );
    await settle();

    const reply = commandsOf(h, BATTLEPASS_REPLY).at(0);

    expect(reply).toBeDefined();
    expect(decodePushPayload(reply!.slice(BATTLEPASS_REPLY.length + 1))).toEqual({
      requestId: 'req-1',
      ok: true,
      message: 'Resgatado! O prêmio está na sua caixa.',
    });

    // ####  E O PROGRESS VEM DEPOIS DO REPLY  ####
    //
    // É a única coisa que o contrato do plugin exige deste lado: a
    // tela desenha o clique NA HORA, e é esta carga que apaga a
    // marca de "esperando".
    const order = h.sent.map((entry) => entry.command.split(' ')[0]);

    expect(order.indexOf(BATTLEPASS_REPLY)).toBeGreaterThanOrEqual(0);
    expect(order.lastIndexOf(BATTLEPASS_PROGRESS)).toBeGreaterThan(order.indexOf(BATTLEPASS_REPLY));
    expect(lastProgress(h).claims).toEqual([{ level: 1, lane: 'free', state: 'pending' }]);
  });

  it('o resgate RECUSADO também manda o progress, e com a frase da regra', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.sent.length = 0;
    // Nível 4 com 0 de XP: o serviço recusa com a frase pronta.
    h.sync.handleLine(
      SERVER,
      pluginLine({
        kind: 'claim',
        secret,
        requestId: 'req-2',
        steamId: PLAYER,
        level: 4,
        lane: 'free',
      }),
    );
    await settle();

    const reply = decodePushPayload(
      commandsOf(h, BATTLEPASS_REPLY).at(0)!.slice(BATTLEPASS_REPLY.length + 1),
    ) as { ok: boolean; message: string };

    expect(reply.ok).toBe(false);
    expect(reply.message).toContain('nível 4');

    // ####  A RECUSA É O CASO QUE MAIS PRECISA DO PROGRESS  ####
    //
    // Ela não muda NADA no banco, então a digital diria "não mudou
    // nada" — e o clique otimista ficaria na tela para sempre. Por
    // isso a carga vai FORÇADA.
    expect(commandsOf(h, BATTLEPASS_PROGRESS).length).toBeGreaterThan(0);
  });

  it('a mesma linha duas vezes vira UMA escrita', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    const secret = await grabSecret(h);
    const line = pluginLine({
      kind: 'claim',
      secret,
      requestId: 'req-3',
      steamId: PLAYER,
      level: 1,
      lane: 'free',
    });

    h.sent.length = 0;
    // O console REPETE linha em reconexão.
    h.sync.handleLine(SERVER, line);
    h.sync.handleLine(SERVER, line);
    await settle();

    expect(commandsOf(h, BATTLEPASS_REPLY)).toHaveLength(1);
  });

  it('o `claimAll` resgata o que está disponível, e diz quando não há nada', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    const secret = await grabSecret(h);

    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claimAll', secret, requestId: 'todos-1', steamId: PLAYER }),
    );
    await settle();

    // Níveis 1 e 2 na faixa grátis. A paga do 2 NÃO entra: ele não
    // comprou o passe.
    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([
      { level: 1, lane: 'free', state: 'pending' },
      { level: 2, lane: 'free', state: 'pending' },
    ]);

    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claimAll', secret, requestId: 'todos-2', steamId: PLAYER }),
    );
    await settle();

    const last = decodePushPayload(
      commandsOf(h, BATTLEPASS_REPLY).at(-1)!.slice(BATTLEPASS_REPLY.length + 1),
    ) as { ok: boolean; message: string };

    expect(last).toEqual({
      requestId: 'todos-2',
      ok: false,
      message: 'Não há nada para resgatar agora.',
    });
  });

  it('o `box` apaga o ponto de notificação', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    const { claim } = h.service.claim(
      { serverId: SERVER, steamId: PLAYER, level: 1, lane: 'free' },
      PANEL,
      h.now,
    );

    h.service.settle(claim.id, [{ idx: 0, ok: false, code: 'INVENTORY_FULL' }], 'inventory', h.now);

    const secret = await grabSecret(h);

    expect(h.sync.buildProgressPayload(SERVER, PLAYER)?.boxSeen).toBe(false);

    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'box', secret, requestId: 'caixa-1', steamId: PLAYER }),
    );
    await settle();

    // Ter pendência e SABER que tem são coisas diferentes: o item
    // continua na caixa, e o ponto some.
    const payload = h.sync.buildProgressPayload(SERVER, PLAYER);

    expect(payload?.boxSeen).toBe(true);
    expect(payload?.pending).toHaveLength(1);
  });

  it('o `buy` vai pela loja, e recusa quando ela não tem a oferta', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'buy', secret, requestId: 'compra-1', steamId: PLAYER }),
    );
    await settle();

    // A MESMA porta do botão da loja. Um segundo caminho aqui seria
    // um passe que ninguém sabe expirar.
    expect(h.bought).toEqual(['passe-outubro']);

    h.offer = null;
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'buy', secret, requestId: 'compra-2', steamId: PLAYER }),
    );
    await settle();

    const last = decodePushPayload(
      commandsOf(h, BATTLEPASS_REPLY).at(-1)!.slice(BATTLEPASS_REPLY.length + 1),
    ) as { ok: boolean; message: string };

    expect(h.bought).toHaveLength(1);
    expect(last.ok).toBe(false);
    expect(last.message).toBe('O passe não está à venda neste servidor agora.');
  });

  it('o `open` manda o progresso fresco, forçado', async () => {
    const h = harness();

    publish(h);
    await h.sync.syncAll('startup');

    const secret = await grabSecret(h);
    const before = commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER}`).length;

    // Nada mudou no banco: sem o forçado, a digital diria "não mudou
    // nada" e o jogador abriria a tela em "sincronizando".
    h.sync.handleLine(SERVER, pluginLine({ kind: 'open', secret, steamId: PLAYER }));
    await settle();

    expect(commandsOf(h, `${BATTLEPASS_PROGRESS} ${PLAYER}`).length).toBe(before + 1);
  });

  it('pedido fora do contrato é descartado, e não derruba o agente', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    await settle();

    const before = h.sent.length;

    // `level` fora da faixa, `steamId` que não é SteamID64, JSON
    // quebrado: nada disso pode virar exceção num gancho que roda
    // para TODA linha de TODOS os servidores.
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'x', steamId: 'eu', level: 1, lane: 'free' }),
    );
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'y', steamId: PLAYER, level: 0, lane: 'free' }),
    );
    h.sync.handleLine(SERVER, `[OrigemZBattlePass] ${BATTLEPASS_MARKER}{isto nao e json`);
    await settle();

    expect(h.sent).toHaveLength(before);
  });

  it('a recusa da loja chega ao jogador com a frase DELA', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.buyOk = false;
    h.sync.handleLine(
      SERVER,
      pluginLine({ kind: 'buy', secret, requestId: 'compra-3', steamId: PLAYER }),
    );
    await settle();

    const reply = decodePushPayload(
      commandsOf(h, BATTLEPASS_REPLY).at(-1)!.slice(BATTLEPASS_REPLY.length + 1),
    ) as { ok: boolean; message: string };

    // Quem sabe por que a compra não saiu é a loja — ela conhece o
    // saldo, o teto e o pareamento. Reescrever a frase aqui daria
    // duas explicações para o mesmo problema.
    expect(reply).toEqual({ requestId: 'compra-3', ok: false, message: 'Saldo insuficiente.' });
  });

  it('perguntar ao plugin que não está carregado diz isso, e não "zero"', async () => {
    const h = harness();

    // O RCON de mentira responde vazio ao que o plugin não conhece,
    // que é o que um servidor sem ele faz. "Não consegui perguntar" e
    // "não tem nada" são respostas diferentes.
    await expect(h.sync.status(SERVER)).rejects.toThrow(/OrigemZBattlePass/);

    h.connected = false;

    await expect(h.sync.openMenu(SERVER, PLAYER)).rejects.toThrow(/RCON/);
  });

  it('a resposta do comando vem limpa do que o plugin falou por cima', () => {
    // Um `Puts` disparado no frame do comando entra na resposta
    // casada do RCON e quebra o JSON. O plugin já adia o aviso; isto
    // é a segunda tranca.
    const bruto = `${BATTLEPASS_MARKER}{"kind":"ready"}\n{"ok":true,"levels":5}`;

    expect(cleanReply(bruto)).toBe('{"ok":true,"levels":5}');
  });
});

// ============================================================
//  O DETALHE DE UMA FAIXA  -  o segundo modal
//
//  ####  O QUE ESTE BLOCO PROTEGE  ####
//
//  A linha que desce no `sync` é a INTEIRA e já cortada em "+N", e um
//  kit é uma recompensa só — nada nela diz o que ele tem dentro. Os
//  modos de isso quebrar em silêncio:
//
//    lista concatenada     o segundo modal repetiria o card, e o
//                          jogador continuaria sem saber o que é o
//                          "+1"
//    kit não aberto        "kit inicial" e nada mais; a tela promete
//                          uma caixa fechada
//    kit apagado           lista vazia, que se lê como "esta faixa
//                          não dá nada" — e ela dá
//    skinId "0"            o campo que derruba o cliente no
//                          `CuiImageComponent` (armadilha 3 do plugin)
//    progresso de brinde   um clique que só LÊ arrastando a carga de
//                          escrita atrás de si
// ============================================================

/** Pede o detalhe de uma faixa, como o plugin o pede. */
async function askParts(
  h: Harness,
  secret: string,
  input: { requestId: string; level: number; lane: 'free' | 'paid' },
): Promise<void> {
  h.sync.handleLine(
    SERVER,
    pluginLine({ kind: 'parts', secret, steamId: PLAYER, ...input }),
  );

  await settle();
}

/** O último detalhe que saiu pelo RCON. */
function lastParts(h: Harness): BattlePassPartsPayload {
  const command = commandsOf(h, BATTLEPASS_PARTS_REPLY).at(-1);

  if (command === undefined) throw new Error('nenhum parts saiu');

  return decodePushPayload(
    command.slice(BATTLEPASS_PARTS_REPLY.length + 1),
  ) as unknown as BattlePassPartsPayload;
}

describe('o que uma faixa dá, item a item', () => {
  it('cada recompensa vira uma linha, e o kit vem ABERTO', async () => {
    const h = harness();
    const season = publish(h);

    h.service.setTrackCell(
      season,
      3,
      'paid',
      {
        rewards: [
          questRewardSchema.parse({ kind: 'kit', slug: 'inicial' }),
          questRewardSchema.parse({ kind: 'coins', amount: 2500 }),
        ],
        milestone: false,
      },
      PANEL,
    );

    const secret = await grabSecret(h);

    h.sent.length = 0;
    await askParts(h, secret, { requestId: 'parts-1', level: 3, lane: 'paid' });

    const parts = lastParts(h);

    expect(parts.ok).toBe(true);
    expect(parts.requestId).toBe('parts-1');
    expect(parts.note).toBe('');

    // O nome do KIT, e não o slug — e os itens dele logo abaixo,
    // marcados como de dentro. É a única coisa que o card não tinha
    // como dizer.
    expect(parts.rows).toEqual([
      { label: 'Kit Inicial', kind: 'kit' },
      { label: '1x Assault Rifle', kind: 'item', shortname: 'rifle.ak', inKit: true },
      { label: '250x Metal Refinado', kind: 'item', shortname: 'metal.refined', inKit: true },
      { label: '2.500 OZCoin', kind: 'coins' },
    ]);
  });

  it('o `skinId` NÃO viaja quando é zero', async () => {
    const h = harness();
    const season = publish(h);

    h.service.setTrackCell(season, 4, 'free', { rewards: [AK], milestone: false }, PANEL);

    const secret = await grabSecret(h);

    h.sent.length = 0;
    await askParts(h, secret, { requestId: 'parts-2', level: 4, lane: 'free' });

    const row = lastParts(h).rows[0];

    // O `'0'` explícito é o campo que derruba o jogador no
    // `CuiImageComponent`: ausente é o contrato.
    expect(row).toEqual({ label: '1x Assault Rifle', kind: 'item', shortname: 'rifle.ak' });
    expect(row && 'skinId' in row).toBe(false);
  });

  it('kit apagado vira AVISO, e não lista vazia', async () => {
    const h = harness();
    const season = publish(h);

    h.service.setTrackCell(
      season,
      3,
      'free',
      { rewards: [questRewardSchema.parse({ kind: 'kit', slug: 'inicial' })], milestone: false },
      PANEL,
    );

    const secret = await grabSecret(h);

    // O admin apaga o kit DEPOIS de a trilha tê-lo prometido. A
    // trilha congela no resgate; a tela mostra o catálogo de agora.
    h.kits.delete('inicial');

    h.sent.length = 0;
    await askParts(h, secret, { requestId: 'parts-3', level: 3, lane: 'free' });

    const parts = lastParts(h);

    expect(parts.ok).toBe(true);
    // A faixa continua dizendo que dá o kit: inventar a lista dele
    // seria prometer item por item o que ninguém vai entregar.
    expect(parts.rows).toEqual([{ label: 'kit inicial', kind: 'kit' }]);
    expect(parts.note).toContain('saiu do catálogo');
  });

  it('um clique que só LÊ não arrasta o progresso atrás de si', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    // O catálogo puxa o progresso atrás de si por relógio próprio:
    // deixa ele sair ANTES, senão o que se mede aqui é o dele.
    await settle();

    h.sent.length = 0;
    await askParts(h, secret, { requestId: 'parts-4', level: 1, lane: 'free' });

    const commands = h.sent.map((entry) => entry.command.split(' ')[0]);

    expect(commands).toContain(BATTLEPASS_PARTS_REPLY);
    // O `reply` arrasta um `progress` forçado porque ele apaga o
    // otimismo de um resgate. Aqui nada foi escrito no banco.
    expect(commands).not.toContain(BATTLEPASS_PROGRESS);
    expect(commands).not.toContain(BATTLEPASS_REPLY);
  });

  it('a mesma linha duas vezes vira UM detalhe só', async () => {
    const h = harness();

    publish(h);

    const secret = await grabSecret(h);

    h.sent.length = 0;
    await askParts(h, secret, { requestId: 'parts-5', level: 1, lane: 'free' });
    await askParts(h, secret, { requestId: 'parts-5', level: 1, lane: 'free' });

    expect(commandsOf(h, BATTLEPASS_PARTS_REPLY)).toHaveLength(1);
  });

  it('sem o segredo, o detalhe não sai', async () => {
    const h = harness();

    publish(h);
    await grabSecret(h);

    h.sent.length = 0;
    await askParts(h, 'segredo-de-mentira', { requestId: 'parts-6', level: 1, lane: 'free' });

    expect(commandsOf(h, BATTLEPASS_PARTS_REPLY)).toHaveLength(0);
  });
});

// ============================================================
//  A ENTREGA
// ============================================================

describe('o resgate com entregador ligado', () => {
  it('fecha o que entregou e manda para a caixa o que não coube', async () => {
    const h = harness();

    publish(h);
    h.service.grantXp(
      { serverId: SERVER, steamId: PLAYER, eventId: 'teste-1', source: 'quest.reward', amount: 2400 },
      h.now,
    );

    // Um entregador que falha na segunda posição: a primeira entra
    // na mochila, a segunda vira dívida com o código cru.
    const outra = new BattlePassSync({
      service: h.service,
      servers: {
        ids: () => [SERVER],
        contextOf: () => ({
          rcon: {
            isConnected: true,
            send: (command: string) => {
              h.sent.push({ server: SERVER, command });

              return Promise.resolve(JSON.stringify({ ok: true }));
            },
          },
        }),
        onlineOf: () => [PLAYER],
      },
      serverNameOf: () => 'Dev 1',
      deliver: {
        deliver: (input) =>
          Promise.resolve(
            input.rewards.map((_reward, idx) => ({
              idx,
              ok: idx === 0,
              ...(idx === 0 ? {} : { code: 'INVENTORY_FULL' }),
            })),
          ),
      },
      logger: silent,
      now: () => h.now,
    });

    const secret = (await (async () => {
      await outra.sync(SERVER, 'manual');

      return lastPayload(h).secret;
    })()) as string;

    h.sent.length = 0;
    // O nível 2 na faixa grátis tem UMA recompensa; a paga tem duas,
    // mas ele não comprou. Então o teste usa a grátis do 2, que
    // falha inteira.
    outra.handleLine(
      SERVER,
      pluginLine({ kind: 'claim', secret, requestId: 'ent-1', steamId: PLAYER, level: 2, lane: 'free' }),
    );
    await settle();

    const reply = decodePushPayload(
      commandsOf(h, BATTLEPASS_REPLY).at(-1)!.slice(BATTLEPASS_REPLY.length + 1),
    ) as { ok: boolean; message: string };

    expect(reply.ok).toBe(true);
    expect(reply.message).toBe('Resgatado! Confira a mochila.');
    // A marca de `claimed` vem DEPOIS da entrega, nunca antes: a
    // única recompensa do nível entrou na mochila, então a casa
    // fecha — e continua viajando como exceção, agora com o estado
    // que o plugin não derivaria sozinho.
    expect(outra.buildProgressPayload(SERVER, PLAYER)?.claims).toEqual([
      { level: 2, lane: 'free', state: 'claimed' },
    ]);
  });
});
