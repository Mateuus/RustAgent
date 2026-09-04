// ============================================================
//  site-fixtures.test.ts  -  o contrato COMPARTILHADO, conferido
//  contra o cliente de verdade.
//
//  ####  O QUE ISTO TRAVA  ####
//
//  Todo outro teste de site deste repositório monta o dublê dentro
//  do próprio arquivo — o que ele responde é o que o autor daquele
//  teste imaginou. Este aqui é o contrário: as respostas vêm de
//  `contracts/oz-rust-fixtures.json`, o arquivo que os DOIS
//  repositórios leem, e boa parte delas foi COPIADA de uma resposta
//  real do dev (`origin: "observed"`).
//
//  É o conserto do risco número um do `Docs/21` §7: enquanto o
//  contrato morava só na prosa, `skinId` string × number e o
//  alfabeto de `prefab` podiam divergir sem nenhum teste acusar.
//
//  Uma fixture que mude sem o cliente acompanhar quebra AQUI, que é
//  onde se quer que ela quebre.
// ============================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';
import { SiteClient, unknownAcks, type CommandAck } from '../src/site/client.js';

const silent = createLogger({ log: { level: 'silent', pretty: false } });

interface AgentExpectation {
  readonly call: string;
  readonly args?: readonly unknown[];
  readonly expect?: Record<string, unknown>;
  /** Só o ACK de comando: os ids que o site NÃO aplicou. */
  readonly expectUnknown?: readonly string[];
}

interface FixtureResponse {
  readonly case: string;
  readonly origin: 'observed' | 'manual';
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly agent?: AgentExpectation;
}

interface FixtureRoute {
  readonly method: string;
  readonly path: string;
  readonly responses: readonly FixtureResponse[];
}

interface Fixtures {
  readonly contract: string;
  readonly routes: Record<string, FixtureRoute>;
}

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', '..', 'contracts', 'oz-rust-fixtures.json'), 'utf8'),
) as Fixtures;

/** Um cliente que responde SEMPRE aquela resposta da fixture. */
function clientOf(response: FixtureResponse): SiteClient {
  const fetchImpl = (() => {
    const body =
      response.status === 304 || response.body === null || response.body === undefined
        ? null
        : typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body);

    return Promise.resolve(
      new Response(body, {
        status: response.status,
        headers: {
          'content-type': typeof response.body === 'string' ? 'text/html' : 'application/json',
          ...(response.headers?.ETag === undefined ? {} : { etag: response.headers.ETag }),
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return new SiteClient({
    baseUrl: 'https://site.example',
    token: 'tok',
    serverId: 'RUST01',
    userAgent: 'OrigemZ-Rust-Agent/teste',
    logger: silent,
    fetchImpl,
  });
}

/**
 * Os métodos que uma fixture pode nomear.
 *
 * Um mapa explícito, e não `client[name]`: o índice dinâmico
 * aceitaria um nome errado no JSON e o teste passaria sem chamar
 * nada.
 */
function invoke(client: SiteClient, call: string, args: readonly unknown[]): Promise<unknown> {
  switch (call) {
    case 'balance':
      return client.balance(args[0] as string);
    case 'transaction':
      return client.transaction(args[0] as string, args[1] as string);
    case 'pendingDeliveries':
      return client.pendingDeliveries(args[0] as number, args[1] as string | undefined);
    case 'mirrorVersion':
      return client.mirrorVersion();
    case 'claimCommands':
      return client.claimCommands(args[0] as number);
    case 'ackCommands':
      return client.ackCommands(args[0] as readonly CommandAck[]);
    case 'serverConfig':
      return client.serverConfig(args[0] as string | null);
    case 'domainConfig':
      return client.domainConfig(args[0] as string, args[1] as string | null);
    default:
      throw new Error(`fixture com um método que este teste não conhece: ${call}`);
  }
}

describe(`as fixtures compartilhadas (${fixtures.contract})`, () => {
  it('a etiqueta do arquivo é a mesma dos dois manuais', () => {
    // Se ela ficar para trás, o arquivo passa a descrever um
    // contrato que já não é o que atravessa o fio.
    expect(fixtures.contract).toMatch(/^oz-rust\/\d+$/);
  });

  for (const [name, route] of Object.entries(fixtures.routes)) {
    for (const response of route.responses) {
      const expectation = response.agent;

      if (expectation === undefined) {
        continue;
      }

      it(`${name}: ${response.case} (${response.origin})`, async () => {
        const client = clientOf(response);
        const result = await invoke(client, expectation.call, expectation.args ?? []);

        if (expectation.expect !== undefined) {
          expect(result).toMatchObject(expectation.expect);
        }

        if (expectation.expectUnknown !== undefined) {
          const ack = result as { readonly ok: boolean; readonly body: Parameters<typeof unknownAcks>[0] };

          expect(ack.ok).toBe(true);
          expect([...unknownAcks(ack.body)]).toEqual([...expectation.expectUnknown]);
        }
      });
    }
  }
});
