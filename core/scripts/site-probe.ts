// ============================================================
//  site-probe.ts  -  o cliente REAL contra o site REAL.
//
//      npm run site:probe -w core             só o que LÊ
//      npm run site:probe -w core -- --write  manda o retrato e os ACKs
//
//  ####  POR QUE ELE EXISTE  ####
//
//  Todo teste deste repositório fala com um dublê que devolve o que
//  o manual diz que o site responde. É o risco número um do
//  `Docs/21`: se as rotas nascerem com outro contrato, os testes
//  daqui passam e a integração falha. Esta sonda é o único jeito de
//  saber — ela usa o `SiteClient` de produção, com os mesmos
//  headers, o mesmo timeout e o mesmo parsing, e grava o que passou
//  no fio dos DOIS lados.
//
//  ####  O QUE ELA NÃO FAZ, COM FLAG NENHUMA  ####
//
//  Débito e crédito NUNCA: é dinheiro de gente de verdade, e uma
//  sonda que cobra é uma sonda que se explica depois.
//  `deliveries/ack` e `shop/mirror` também ficam de fora — o
//  primeiro fecha entrega alheia, o segundo sobrescreve o espelho.
//
//  O `claim` roda sempre, e é o único que TIRA algo do lugar: a
//  linha sai da fila do site com um `leaseToken` carimbado. Por isso
//  o que vier é ACKado na hora com `refused` + `AGENT_BUSY`, que é a
//  verdade (esta sonda não executa nada) e devolve o comando ao
//  admin em vez de deixá-lo pendurado.
//
//  A saída crua vai para um JSON — é dele que sai a fixture
//  compartilhada do `Docs/21` §7.
// ============================================================

import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';

import Database from 'better-sqlite3';

import { SiteClient } from '../src/site/client.js';

/** Uma ida à rede, dos dois lados, como ela saiu. */
interface Exchange {
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody: unknown;
  readonly status: number | null;
  readonly responseHeaders: Record<string, string>;
  readonly responseBody: unknown;
  readonly error?: string;
}

const ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * O segredo NÃO viaja para o relatório.
 *
 * O bearer daquele servidor debita e credita OzCoin de qualquer
 * conta do site. Um JSON de diagnóstico é a coisa mais fácil de
 * colar num chat.
 */
function maskHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const masked: Record<string, string> = {};

  for (const [key, value] of entries) {
    masked[key.toLowerCase()] =
      key.toLowerCase() === 'authorization' ? 'Bearer <SITE_TOKEN>' : String(value);
  }

  return masked;
}

/** O pareamento daquele servidor, lido do `.ini` como o agente lê. */
function pairingOf(serverId: string): { readonly siteServerId: string; readonly token: string } {
  const text = readFileSync(resolve(ROOT, 'Configs', `${serverId}.ini`), 'utf8');
  const valueOf = (key: string): string => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);

    return match?.[1]?.trim() ?? '';
  };

  return { siteServerId: valueOf('SITE_SERVER_ID'), token: valueOf('SITE_TOKEN') };
}

/** A URL do site mora na tabela `meta`, não no `.env`. Ver `site/settings.ts`. */
function baseUrlOf(): string {
  const db = new Database(resolve(ROOT, 'data', 'rustagent.db'), { readonly: true });

  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'site.base_url'").get() as
      | { readonly value: string }
      | undefined;

    return row?.value ?? '';
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const write = argv.includes('--write');
  const localServerId = argv.find((arg) => arg.startsWith('--server='))?.slice(9) ?? 'server01';
  const { siteServerId, token } = pairingOf(localServerId);
  const baseUrl = baseUrlOf();

  if (baseUrl === '' || siteServerId === '' || token === '') {
    console.log('sem pareamento: confira site.base_url na tabela meta e o SITE_* do .ini');
    exit(1);
  }

  console.log(`sonda contra ${baseUrl} como ${siteServerId} (local: ${localServerId})`);
  console.log(write ? 'modo --write: o retrato e os ACKs SAEM' : 'modo leitura');
  console.log('');

  const exchanges: Exchange[] = [];
  let current = 'desconhecida';

  // O `fetch` real, com um gravador em volta: é o que permite ver o
  // corpo CRU, antes de o cliente traduzi-lo.
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    const requestHeaders = maskHeaders((init?.headers ?? {}) as Record<string, string>);
    const requestBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;

    try {
      const response = await globalThis.fetch(url as string, init);
      const text = await response.text();
      let parsed: unknown = text;

      try {
        parsed = text === '' ? null : (JSON.parse(text) as unknown);
      } catch {
        // Corpo que não é JSON é informação: o 403 da borda vem em
        // texto, e é assim que o agente o reconhece.
        parsed = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      }

      exchanges.push({
        name: current,
        method,
        url: href,
        requestHeaders,
        requestBody,
        status: response.status,
        responseHeaders: maskHeaders(response.headers),
        responseBody: parsed,
      });

      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      exchanges.push({
        name: current,
        method,
        url: href,
        requestHeaders,
        requestBody,
        status: null,
        responseHeaders: {},
        responseBody: null,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }) as unknown as typeof globalThis.fetch;

  const client = new SiteClient({
    baseUrl,
    token,
    serverId: siteServerId,
    userAgent: 'OrigemZ-Rust-Agent/1.0.0',
    timeoutMs: 15_000,
    fetchImpl,
  });

  const run = async (name: string, call: () => Promise<unknown>): Promise<unknown> => {
    current = name;

    try {
      const result = await call();

      console.log(`— ${name}: ${JSON.stringify(result).slice(0, 400)}`);

      return result;
    } catch (error) {
      console.log(`— ${name}: LANÇOU ${error instanceof Error ? error.message : String(error)}`);

      return null;
    }
  };

  // ---- a config desejada: as três voltas que importam ----
  const first = (await run('server/config (sem ETag)', () => client.serverConfig(null))) as {
    readonly ok: boolean;
    readonly etag?: string | null;
    readonly body?: {
      readonly version: number | null;
      readonly desired: Record<string, unknown> | null;
    };
  } | null;

  const etag = first?.ok === true ? (first.etag ?? null) : null;

  if (etag !== null && etag !== '') {
    await run('server/config (com o ETag devolvido)', () => client.serverConfig(etag));
  }

  await run('server/config (ETag inventado)', () => client.serverConfig('"nao-existe"'));

  // ---- os assuntos de rede (rotas 15 e 16) ----
  for (const domain of ['store', 'kits', 'vips']) {
    await run(`config/${domain}`, () => client.domainConfig(domain, null));
  }

  // ---- a fila de comandos ----
  const claim = (await run('commands/claim', () => client.claimCommands(1))) as {
    readonly ok: boolean;
    readonly body?: { readonly commands?: readonly Record<string, unknown>[] };
  } | null;

  const claimed = claim?.ok === true ? (claim.body?.commands ?? []) : [];

  if (claimed.length > 0) {
    // Devolver o que a sonda tirou da fila: ela não executa nada, e
    // `AGENT_BUSY` é exatamente isso, no vocabulário fechado.
    await run('commands/ack (o que o claim trouxe)', () =>
      client.ackCommands(
        claimed.map((command) => ({
          id: String(command.id),
          leaseToken: String(command.leaseToken),
          status: 'refused' as const,
          reason: 'AGENT_BUSY',
          at: new Date().toISOString(),
        })),
      ),
    );
  } else {
    // Um id que o site não conhece: ele revela o formato da recusa
    // sem mexer em linha nenhuma.
    await run('commands/ack (id desconhecido)', () =>
      client.ackCommands([
        {
          id: 'CMD-000000000000',
          leaseToken: 'sonda',
          status: 'refused',
          reason: 'AGENT_BUSY',
          at: new Date().toISOString(),
        },
      ]),
    );
  }

  // ---- as rotas antigas que só LEEM ----
  await run('shop/mirror/version', () => client.mirrorVersion());
  await run('deliveries/pending', () => client.pendingDeliveries(1));
  // O `INVALID_CURSOR` tem dono neste lado: o laço joga o cursor
  // fora e recomeça do topo. Sem ele, o 400 cairia na regra do 4xx
  // desconhecido e o mesmo cursor voltaria a cada 15 s, para sempre.
  await run('deliveries/pending (cursor inventado)', () =>
    client.pendingDeliveries(1, 'sonda-de-contrato'),
  );
  await run('ozcoins/balance (steamId inexistente)', () => client.balance('76561190000000000'));
  await run('ozcoins/transaction (referência inexistente)', () =>
    client.transaction('rust:SONDA:loja:naoexiste', '76561190000000000'),
  );

  if (write) {
    // O batimento: ele é a única rota SEM bearer e SEM `X-Server-Id`
    // — o `serverId` vai no corpo. A assinatura sai sempre que há
    // token, mesmo que o site ainda não a exija.
    const timestamp = Math.floor(Date.now() / 1000);

    await run('beacon (assinado)', () =>
      client.beacon({
        port: 8787,
        version: '1.0.0',
        mac: '00:00:00:00:00:00',
        capabilities: ['ozcoins', 'shop', 'deliver_item', 'players_online', 'pull_delivery'],
        signature: {
          timestamp,
          value: createHmac('sha256', token).update(`${siteServerId}|${timestamp}`).digest('hex'),
        },
      }),
    );

    // Uma versão que não existe: ela revela o vocabulário de erro do
    // ACK sem fechar linha nenhuma.
    await run('server/config/ack (versão inexistente)', () =>
      client.ackServerConfig({
        version: 999_999_999,
        applied: false,
        requiresRestart: [],
        errors: [{ field: 'sonda', code: 'AGENT_PROBE' }],
      }),
    );

    // O retrato: telemetria, e o agente manda um a cada 30 s.
    await run('server/status', () =>
      client.pushServerStatus({
        at: new Date().toISOString(),
        agent: { version: '1.0.0', uptimeSeconds: 1, health: 'ok' },
        server: {
          running: false,
          pid: null,
          installed: true,
          hostname: 'sonda de contrato',
          map: 'Procedural Map',
          worldSize: 3500,
          seed: 1,
          maxPlayers: 100,
          rcon: null,
        },
        players: { online: 0, max: 100, source: 'unavailable' },
        build: {
          installed: null,
          published: null,
          updateAvailable: false,
          checkedAt: null,
          autoUpdate: false,
        },
        machine: { cpu: null, memory: null, disk: null },
        operation: null,
        kinds: [],
      }),
    );

    const version = first?.ok === true ? (first.body?.version ?? null) : null;

    if (version !== null) {
      // O ACK com a versão que o GET trouxe. `applied: false` é a
      // verdade: a sonda não escreve `.ini` nenhum.
      await run('server/config/ack', () =>
        client.ackServerConfig({
          version,
          applied: false,
          requiresRestart: [],
          errors: [{ field: 'sonda', code: 'AGENT_PROBE' }],
        }),
      );
    }
  }

  const out =
    argv.find((arg) => arg.startsWith('--out='))?.slice(6) ??
    resolve(ROOT, 'dumps', 'site-probe.json');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ baseUrl, siteServerId, exchanges }, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`${exchanges.length} idas à rede gravadas em ${out}`);
}

await main();
