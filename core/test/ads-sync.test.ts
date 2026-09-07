// ============================================================
//  Testes da SINCRONIZAÇÃO do overlay com o jogo.
//
//  O que estes testes protegem, e não é óbvio:
//
//  1. DESLIGADO PRECISA SER DITO. Parar de mandar deixa o overlay
//     congelado na tela de quem já estava vendo — e nada o tira
//     até o servidor reiniciar.
//
//  2. OS BYTES VÊM ANTES DA CARGA. Invertido, o primeiro ciclo
//     desenha um retângulo vazio no lugar da propaganda.
//
//  3. O QUE ESTÁ FORA DA JANELA NÃO ENTRA. O calendário é
//     resolvido AQUI, no agente — o plugin não sabe que horas
//     são para efeito de campanha.
//
//  4. RECUSA, NUNCA CORTA. Meia carga substituiria uma
//     configuração boa por uma incompleta, e o defeito apareceria
//     como um overlay travado no meio da animação.
// ============================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdsRepository } from '../src/db/ads-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { AdsSync, type AdsSyncRcon, isAdsRequest } from '../src/game/ads-sync.js';
import { ADS_REQUEST_MARKER, type AdsPayload } from '../src/types/ads-transport.js';

/** O servidor destes testes. */
const SERVER = 'devserver';

/**
 * Um banco em memória com um servidor dentro.
 *
 * A linha em `servers` não é decoração: `ads` e `ads_settings`
 * apontam para lá, e o pragma de chave estrangeira está ligado.
 */
function createTestDatabase(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);
  registerTestServer(db, SERVER);

  return db;
}

let nextPort = 28_015;

function registerTestServer(db: AgentDatabase, id: string): void {
  const base = nextPort;
  nextPort += 10;

  new ServersRepository(db).create({
    id,
    name: id,
    identity: id,
    gamePort: base,
    rconPort: base + 1,
    queryPort: base + 2,
    appPort: base + 3,
    installDir: `F:\\Servers\\${id}`,
  });
}

/**
 * O `servers` que o `AdsSync` pede, com UM servidor de mentira.
 *
 * `contextOf` devolve `null` para qualquer outro id — que é o que
 * o supervisor de verdade faz com um servidor não montado, e o
 * que faz o teste de "sem RCON" ser o mesmo caminho do de "o jogo
 * está parado".
 */
function fakeServers(
  id: string,
  rcon: AdsSyncRcon,
): { ids(): readonly string[]; contextOf(other: string): { readonly rcon: AdsSyncRcon } | null } {
  return {
    ids: () => [id],
    contextOf: (other: string) => (other === id ? { rcon } : null),
  };
}

interface Harness {
  readonly db: AgentDatabase;
  readonly ads: AdsRepository;
  readonly sync: AdsSync;
  readonly sent: string[];
}

let harness: Harness | null = null;

function buildHarness(options: { connected?: boolean; now?: number } = {}): Harness {
  const db = createTestDatabase();
  const ads = new AdsRepository(db);
  const sent: string[] = [];

  const sync = new AdsSync({
    ads,
    servers: fakeServers(SERVER, {
      isConnected: options.connected ?? true,
      send: async (command: string) => {
        sent.push(command);
        return Promise.resolve('{"ok":true}');
      },
    }),
    // Um `fetch` que recusa na hora. Sem ele, o serviço tentaria
    // alcançar `exemplo.com` de verdade e cada teste esperaria o
    // DNS estourar — segundos de espera para provar nada.
    fetchImpl: (async () => Promise.reject(new Error('sem rede no teste'))) as unknown as typeof fetch,
    ...(options.now === undefined ? {} : { now: () => options.now! }),
  });

  harness = { db, ads, sync, sent };
  return harness;
}

afterEach(() => {
  if (harness !== null) {
    harness.sync.stop();
    harness.db.close();
    harness = null;
  }
});

/** O último `origemz.ads.config` enviado, já decodificado. */
function lastConfig(sent: readonly string[]): AdsPayload {
  const command = [...sent].reverse().find((line) => line.startsWith('origemz.ads.config '));

  if (command === undefined) {
    throw new Error('nenhuma configuração foi enviada');
  }

  return JSON.parse(
    Buffer.from(command.slice('origemz.ads.config '.length), 'base64').toString('utf8'),
  ) as AdsPayload;
}

/** Uma propaganda com a imagem já em cache. */
function readyAd(
  ads: AdsRepository,
  name: string,
  extra: Record<string, unknown> = {},
  serverId: string = SERVER,
): string {
  const ad = ads.create(serverId, {
    name,
    imageUrl: `https://exemplo.com/${name}.png`,
    ...extra,
  } as never);

  ads.markImage(serverId, ad.id, {
    status: 'ready',
    key: `ad${name.padEnd(12, '0').slice(0, 12)}`,
    sha: name,
    bytes: 1234,
    width: 600,
    height: 200,
  });

  return ad.id;
}

describe('o envio', () => {
  it('desligado, MANDA a carga vazia para o plugin limpar a tela', async () => {
    const { sync, sent } = buildHarness();

    const outcome = await sync.push(SERVER, 'manual');

    expect(outcome.status).toBe('sent');
    // Não basta calar: quem estava vendo ficaria com o overlay
    // congelado para sempre.
    expect(lastConfig(sent).enabled).toBe(false);
  });

  it('sem RCON, não tenta nada', async () => {
    const { sync, sent } = buildHarness({ connected: false });

    const outcome = await sync.push(SERVER, 'manual');

    expect(outcome.status).toBe('skipped');
    expect(sent).toHaveLength(0);
  });

  it('ligado, manda a linha do tempo e as propagandas prontas', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');
    readyAd(ads, 'discord');

    await sync.push(SERVER, 'manual');
    const payload = lastConfig(sent);

    expect(payload.enabled).toBe(true);
    expect(payload.ads).toHaveLength(2);
    expect(payload.animations.opening.frames.length).toBeGreaterThan(0);
    expect(payload.root_name).toBe('OrigemZAds');
  });

  it('os BYTES vão antes da carga', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');

    // Sem bytes em memória, o serviço tenta rebaixar e falha (sem
    // rede no teste) — o que ele NÃO pode fazer é mandar a carga
    // antes de tentar.
    await sync.push(SERVER, 'manual');

    const config = sent.findIndex((line) => line.startsWith('origemz.ads.config'));
    const imagem = sent.findIndex((line) => line.startsWith('origemz.ads.image'));

    if (imagem !== -1) {
      expect(imagem).toBeLessThan(config);
    }
  });

  it('propaganda sem imagem pronta NÃO entra na carga', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');
    // Esta fica em `pending`: nunca foi baixada.
    ads.create(SERVER, { name: 'quebrada', imageUrl: 'https://exemplo.com/x.png' } as never);

    await sync.push(SERVER, 'manual');

    expect(lastConfig(sent).ads).toHaveLength(1);
  });

  it('desligada não entra, mesmo com imagem pronta', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'vip');
    ads.update(SERVER, id, { enabled: false });

    await sync.push(SERVER, 'manual');
    expect(lastConfig(sent).ads).toHaveLength(0);
  });

  it('no modo url, a imagem vai como endereço e o cache não importa', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true, imageMode: 'url' });
    ads.create(SERVER, { name: 'vip', imageUrl: 'https://exemplo.com/vip.png' } as never);

    await sync.push(SERVER, 'manual');
    const payload = lastConfig(sent);

    // Sem download nenhum: quem baixa é o cliente.
    expect(payload.ads).toHaveLength(1);
    expect(payload.ads[0]?.image).toBe('https://exemplo.com/vip.png');
    expect(sent.some((line) => line.startsWith('origemz.ads.image'))).toBe(false);
  });

  it('a permissão viaja com cada item — é o plugin que filtra por jogador', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'vip');
    ads.update(SERVER, id, { permission: 'origemz.vip' });

    await sync.push(SERVER, 'manual');

    // O agente monta UMA carga para todo mundo; a permissão é por
    // jogador e só o plugin sabe quem tem qual.
    expect(lastConfig(sent).ads[0]?.permission).toBe('origemz.vip');
  });

  it('a duração de cada uma cai para o padrão quando não foi escolhida', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true, defaultDisplayDuration: 7 });
    const curto = readyAd(ads, 'curta');
    ads.update(SERVER, curto, { displayDuration: 3 });
    readyAd(ads, 'padrao');

    await sync.push(SERVER, 'manual');
    const payload = lastConfig(sent);

    const duracoes = payload.ads.map((ad) => ad.displayMs).sort((a, b) => a - b);
    expect(duracoes).toEqual([3000, 7000]);
  });
});

describe('o reenvio periódico', () => {
  it('NÃO reenvia quando nada mudou', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');
    const primeiro = sent.length;

    const outcome = await sync.push(SERVER, 'periodic');

    // ####  ISTO ACONTECEU DE VERDADE  ####
    //
    // O relógio periódico (5 min) e o ciclo do plugin (5 min por
    // padrão) ficaram em cadências parecidas, e cada reenvio
    // reiniciava a contagem do lado de lá: a propaganda NUNCA
    // aparecia sozinha, só pelo botão "Mostrar no jogo".
    //
    // O plugin foi consertado para retomar a contagem; este
    // dedup é a outra metade.
    expect(outcome.status).toBe('skipped');
    expect(sent.length).toBe(primeiro);
  });

  it('reenvia quando algo muda', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');
    const primeiro = sent.length;

    readyAd(ads, 'discord');
    await sync.push(SERVER, 'periodic');

    expect(sent.length).toBeGreaterThan(primeiro);
  });

  it('reenvia SEMPRE quando o plugin pede ou o RCON reconecta', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');
    const primeiro = sent.length;

    // Nos dois, o outro lado perdeu o que tinha — e é justamente
    // aí que reenviar é obrigatório, mudança ou não.
    await sync.push(SERVER, 'plugin-requested');
    expect(sent.length).toBeGreaterThan(primeiro);

    const segundo = sent.length;
    await sync.push(SERVER, 'rcon-connected');
    expect(sent.length).toBeGreaterThan(segundo);
  });

  it('limpar o cache faz a próxima carga sair de novo', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');
    const primeiro = sent.length;

    sync.clearCache(SERVER);
    await sync.push(SERVER, 'manual');

    // Sem zerar o `#lastPayload` junto, "limpar o cache" não
    // faria carga nenhuma sair: ela seria idêntica à anterior.
    expect(sent.length).toBeGreaterThan(primeiro);
  });
});

describe('o teto de tamanho da imagem', () => {
  it('no modo `url` o teto é o grande — o RCON não entra na história', async () => {
    const db = createTestDatabase();
    const ads = new AdsRepository(db);

    // 1,8 MB: passa do teto do RCON (1,5 MB) e cabe nos 2 MB do
    // modo `url`. É a versão extrema do caso que aparecia como
    // erro FALSO na tela — o teto do duto sendo cobrado de quem
    // não passa por ele.
    const grande = Buffer.alloc(1_800 * 1024);
    grande.writeUInt8(0x89, 0);
    grande.write('PNG', 1, 'ascii');
    grande.writeUInt32BE(600, 16);
    grande.writeUInt32BE(200, 20);

    const sync = new AdsSync({
      ads,
      servers: fakeServers(SERVER, {
        isConnected: true,
        send: async () => Promise.resolve(''),
      }),
      fetchImpl: (async () =>
        Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            Promise.resolve(
              grande.buffer.slice(grande.byteOffset, grande.byteOffset + grande.length),
            ),
        } as unknown as Response)) as unknown as typeof fetch,
    });

    ads.saveSettings(SERVER, { enabled: true, imageMode: 'url' });
    ads.create(SERVER, { name: 'grande', imageUrl: 'https://exemplo.com/g.png' } as never);

    const result = await sync.refreshImages(SERVER);
    expect(result.ready).toBe(1);
    expect(result.failed).toBe(0);

    // E no modo `stored`, a MESMA imagem é recusada: ali ela
    // passaria pelo RCON.
    ads.saveSettings(SERVER, { imageMode: 'stored' });
    ads.clearImageCache(SERVER);

    const stored = await sync.refreshImages(SERVER);
    expect(stored.failed).toBe(1);

    sync.stop();
    db.close();
  });
});

describe('o calendário', () => {
  it('fora da janela de HORÁRIO, não entra', async () => {
    // Sexta-feira, 10:00 no relógio local.
    const dezHoras = new Date(2026, 7, 7, 10, 0, 0).getTime();
    const { ads, sync, sent } = buildHarness({ now: dezHoras });

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'noturna');
    ads.update(SERVER, id, { startTime: '20:00', endTime: '23:59' });

    await sync.push(SERVER, 'manual');
    expect(lastConfig(sent).ads).toHaveLength(0);
  });

  it('dentro da janela, entra', async () => {
    const noite = new Date(2026, 7, 7, 21, 30, 0).getTime();
    const { ads, sync, sent } = buildHarness({ now: noite });

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'noturna');
    ads.update(SERVER, id, { startTime: '20:00', endTime: '23:59' });

    await sync.push(SERVER, 'manual');
    expect(lastConfig(sent).ads).toHaveLength(1);
  });

  it('a janela que VIRA A MEIA-NOITE funciona', async () => {
    // 01:00 — dentro de "das 22:00 às 02:00".
    const madrugada = new Date(2026, 7, 8, 1, 0, 0).getTime();
    const { ads, sync, sent } = buildHarness({ now: madrugada });

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'madrugada');
    ads.update(SERVER, id, { startTime: '22:00', endTime: '02:00' });

    await sync.push(SERVER, 'manual');

    // Com a comparação ingênua (from <= agora && agora <= to),
    // esta janela NUNCA seria verdadeira: o admin escreveria o
    // horário certo e a propaganda não apareceria nunca.
    expect(lastConfig(sent).ads).toHaveLength(1);
  });

  it('fora do intervalo de DATAS, não entra', async () => {
    const janeiro = new Date(2027, 0, 5, 12, 0, 0).getTime();
    const { ads, sync, sent } = buildHarness({ now: janeiro });

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'natal');
    ads.update(SERVER, id, { startDate: '2026-12-01', endDate: '2026-12-25' });

    await sync.push(SERVER, 'manual');
    expect(lastConfig(sent).ads).toHaveLength(0);
  });

  it('dia da semana errado, não entra', async () => {
    // 2026-08-07 é uma sexta-feira (dia 5).
    const sexta = new Date(2026, 7, 7, 12, 0, 0).getTime();
    const { ads, sync, sent } = buildHarness({ now: sexta });

    ads.saveSettings(SERVER, { enabled: true });
    const id = readyAd(ads, 'domingo');
    ads.update(SERVER, id, { daysOfWeek: [0] });

    await sync.push(SERVER, 'manual');
    expect(lastConfig(sent).ads).toHaveLength(0);
  });
});

describe('a ordem', () => {
  it('prioridade manda; posição desempata', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true });

    const primeira = readyAd(ads, 'aaa');
    const segunda = readyAd(ads, 'bbb');
    const terceira = readyAd(ads, 'ccc');

    // A última da lista, com prioridade alta, vai para a frente.
    ads.update(SERVER, terceira, { priority: 10 });

    await sync.push(SERVER, 'manual');
    const ids = lastConfig(sent).ads.map((ad) => ad.id);

    expect(ids[0]).toBe(terceira);
    expect(ids.slice(1)).toEqual([primeira, segunda]);
  });
});

describe('o teto da carga', () => {
  it('RECUSA em vez de cortar quando a carga não cabe', async () => {
    const { ads, sync } = buildHarness();

    // fps alto + animações longas: é assim que a carga cresce.
    ads.saveSettings(SERVER, {
      enabled: true,
      animationFps: 30,
      openingMs: 3000,
      closingMs: 3000,
      transitionMs: 2000,
    });

    for (let i = 0; i < 50; i += 1) {
      readyAd(ads, `ad${String(i)}`, { permission: 'origemz.propaganda.muito.longa.mesmo' });
    }

    const outcome = await sync.push(SERVER, 'manual');

    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') {
      // A mensagem diz O QUE FAZER, e não só que falhou.
      expect(outcome.reason).toContain('quadros por segundo');
    }
  });
});

describe('o pedido de recarga do plugin', () => {
  it('aceita a linha com o prefixo do plugin', () => {
    expect(isAdsRequest(`[OrigemZUI] ${ADS_REQUEST_MARKER}{"want":"ads"}`)).toBe(true);
  });

  it('RECUSA a mesma linha sem o prefixo — ela pode vir do chat', () => {
    // ####  CONTROLE DE ORIGEM  ####
    //
    // O agente lê o console INTEIRO, e o chat dos jogadores entra
    // por ele. Sem o prefixo, qualquer um forjaria o pedido.
    expect(isAdsRequest(`${ADS_REQUEST_MARKER}{"want":"ads"}`)).toBe(false);
    expect(isAdsRequest(`[CHAT] jogador: ${ADS_REQUEST_MARKER}{"want":"ads"}`)).toBe(false);
  });

  it('ignora linha comum e JSON quebrado', () => {
    expect(isAdsRequest('[OrigemZUI] carga recebida')).toBe(false);
    expect(isAdsRequest(`[OrigemZUI] ${ADS_REQUEST_MARKER}{quebrado`)).toBe(false);
    expect(isAdsRequest(`[OrigemZUI] ${ADS_REQUEST_MARKER}{"want":"outra"}`)).toBe(false);
  });
});

// ============================================================
//  DOIS SERVIDORES NA MESMA MÁQUINA
//
//  Com um servidor só, `ads.list()` e `ads.list(serverId)`
//  devolvem a mesma coisa — e um esquecimento do escopo passaria
//  por toda a suíte acima. O sintoma seria o overlay do PVE
//  mostrando as propagandas do PVP.
// ============================================================
// ============================================================
//  A PROPAGANDA QUE FICA PARADA
//
//  Quem OBEDECE o modo estático é o plugin: só ele conhece a
//  permissão de cada jogador, e portanto qual propaganda cada um
//  pode ver. O que se pode provar deste lado é que a bandeira
//  chega — e que ela chega junto com os quadros de que o plugin
//  vai precisar (o último de `opening` e o de `adEnter`).
// ============================================================
describe('o modo estatico', () => {
  it('a bandeira viaja na carga', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true, imageMode: 'url', staticMode: true });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');

    expect(lastConfig(sent).staticMode).toBe(true);
  });

  it('desligado por padrao — ninguem herda painel parado sem pedir', async () => {
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true, imageMode: 'url' });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');

    expect(lastConfig(sent).staticMode).toBe(false);
  });

  it('os quadros que o plugin usa continuam na carga', async () => {
    // O modo estático NÃO muda o que o agente gera: ele muda o que
    // o plugin FAZ com o que recebeu. Se a abertura viesse vazia
    // aqui, o painel estático não teria estado final para desenhar
    // — e o defeito apareceria como "não aparece nada", que é
    // indistinguível de meia dúzia de outras causas.
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, { enabled: true, imageMode: 'url', staticMode: true });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');

    const carga = lastConfig(sent);

    expect(carga.animations.opening.frames.length).toBeGreaterThan(0);
    expect(carga.animations.adEnter.frames.length).toBeGreaterThan(0);
    expect(carga.ads).toHaveLength(1);
  });

  it('a camada do inventario e so a `layer` — nada mais muda', async () => {
    // "Onde aparece" e "como se comporta" são independentes de
    // propósito: dá para ter rodízio animado dentro do inventário,
    // e banner parado sempre visível.
    const { ads, sync, sent } = buildHarness();

    ads.saveSettings(SERVER, {
      enabled: true,
      imageMode: 'url',
      layer: 'Hud.Menu',
      staticMode: false,
    });
    readyAd(ads, 'vip');

    await sync.push(SERVER, 'manual');

    const carga = lastConfig(sent);

    expect(carga.layer).toBe('Hud.Menu');
    expect(carga.staticMode).toBe(false);
  });
});

describe('o escopo por servidor', () => {
  it('cada overlay leva as propagandas DELE', async () => {
    const db = createTestDatabase();
    registerTestServer(db, 'pvp2');

    const ads = new AdsRepository(db);
    const enviados = new Map<string, string[]>([
      [SERVER, []],
      ['pvp2', []],
    ]);

    const sync = (serverId: string): AdsSync =>
      new AdsSync({
        ads,
        servers: fakeServers(serverId, {
          isConnected: true,
          send: async (command: string) => {
            enviados.get(serverId)?.push(command);
            return Promise.resolve('{"ok":true}');
          },
        }),
        fetchImpl: (async () =>
          Promise.reject(new Error('sem rede no teste'))) as unknown as typeof fetch,
      });

    ads.saveSettings(SERVER, { enabled: true, imageMode: 'url' });
    ads.saveSettings('pvp2', { enabled: true, imageMode: 'url' });

    const doDev = readyAd(ads, 'dodev');
    const doPvp = readyAd(ads, 'dopvp', {}, 'pvp2');

    const a = sync(SERVER);
    const b = sync('pvp2');

    await a.push(SERVER, 'manual');
    await b.push('pvp2', 'manual');

    expect(lastConfig(enviados.get(SERVER) ?? []).ads.map((ad) => ad.id)).toEqual([doDev]);
    expect(lastConfig(enviados.get('pvp2') ?? []).ads.map((ad) => ad.id)).toEqual([doPvp]);

    a.stop();
    b.stop();
    db.close();
  });

  it('desligar o overlay de um NÃO apaga o do outro', async () => {
    const db = createTestDatabase();
    registerTestServer(db, 'pvp2');

    const ads = new AdsRepository(db);
    const doPvp: string[] = [];

    ads.saveSettings(SERVER, { enabled: false });
    ads.saveSettings('pvp2', { enabled: true, imageMode: 'url' });
    readyAd(ads, 'dopvp', {}, 'pvp2');

    const sync = new AdsSync({
      ads,
      servers: fakeServers('pvp2', {
        isConnected: true,
        send: async (command: string) => {
          doPvp.push(command);
          return Promise.resolve('{"ok":true}');
        },
      }),
      fetchImpl: (async () =>
        Promise.reject(new Error('sem rede no teste'))) as unknown as typeof fetch,
    });

    await sync.push('pvp2', 'manual');

    expect(lastConfig(doPvp).enabled).toBe(true);
    expect(lastConfig(doPvp).ads).toHaveLength(1);

    sync.stop();
    db.close();
  });
});

describe('o cache de imagens', () => {
  it('não rebaixa o que já está pronto', async () => {
    const db = createTestDatabase();
    const ads = new AdsRepository(db);
    const fetchImpl = vi.fn();

    const sync = new AdsSync({
      ads,
      servers: fakeServers(SERVER, { isConnected: true, send: async () => Promise.resolve('') }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    readyAd(ads, 'vip');
    const result = await sync.refreshImages(SERVER);

    // Sem esta guarda, cada volta do relógio periódico rebaixaria
    // todas as imagens — de cinco em cinco minutos, para sempre.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ready).toBe(1);

    sync.stop();
    db.close();
  });

  it('grava a MENSAGEM do erro, para a tela mostrar', async () => {
    const db = createTestDatabase();
    const ads = new AdsRepository(db);

    const sync = new AdsSync({
      ads,
      servers: fakeServers(SERVER, { isConnected: true, send: async () => Promise.resolve('') }),
      fetchImpl: (async () =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    });

    const ad = ads.create(SERVER, { name: 'x', imageUrl: 'https://exemplo.com/x.png' } as never);
    const result = await sync.refreshImages(SERVER);

    expect(result.failed).toBe(1);

    const stored = ads.get(SERVER, ad.id);
    expect(stored?.imageStatus).toBe('error');
    // "falha ao carregar" não é resposta: o admin precisa saber o
    // que corrigir.
    expect(stored?.imageError).toBeTruthy();

    sync.stop();
    db.close();
  });
});
