// ============================================================
//  client.ts  -  o transporte até o site OrigemZ.
//
//  ####  ESTE É O ÚNICO ARQUIVO QUE FALA `moedas` E `observacao` ####
//
//  Os dois nomes são do CONTRATO DO SITE — ele os expõe assim, e
//  renomeá-los quebraria a integração. Daqui para dentro do
//  RustAgent eles viram `balance` e `reason`, e nenhum outro
//  arquivo precisa saber que a outra grafia existe. Um segundo
//  lugar que traduzisse os mesmos campos seria o começo de um
//  arquivo bilíngue, e a partir daí ninguém sabe qual usar.
//
//  ------------------------------------------------------------
//  ####  NADA AQUI LANÇA POR CAUSA DA REDE  ####
//
//  Toda falha vira um `SiteResult` com `ok: false`. Quem chama roda
//  dentro de um relógio ou no caminho de um jogador que clicou, e um
//  `throw` nos dois lugares é um laço morto ou um menu travado. É a
//  mesma disciplina do RustMapsClient.
//
//  ####  O CORPO NUNCA CARREGA `balance`, `ozBalance` NEM `epBalance` ####
//
//  O site tem um middleware GLOBAL (`validateBalanceChange`) que
//  responde 403 `{error:'Operação não permitida'}` SEM `error_code`
//  quando um desses três nomes aparece no corpo como valor
//  primitivo. Quem for acrescentar campo aqui: nenhum deles.
//
//  ####  O User-Agent NÃO É ENFEITE  ####
//
//  A borda do site recusa famílias genéricas de cliente HTTP com um
//  403 de corpo em TEXTO PURO contendo `error code: 1010`. Ele se
//  parece com um ban e não é um — no painel do Conan isso custou
//  horas procurando ban numa tabela vazia.
//
//  ####  UM CLIENTE POR PAREAMENTO  ####
//
//  `serverId` e `token` são do SERVIDOR, não do agente: o site
//  modela um `Server` por linha de `agents`, com um bearer cada. Um
//  RustAgent com três servidores de Rust constrói três destes, e é
//  por isso que eles vêm no construtor.
//
//  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §5 e §14.2.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

export const SITE_DEFAULT_TIMEOUT_MS = 5_000;

/** O desfecho de UMA conversa com o site. Ver Docs\20 §4.2. */
export type SiteResult<T> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: T;
      /**
       * O `ETag` da resposta, quando o site carimbou um.
       *
       * Só a config o usa — ela é ESTADO, e a volta que não mudou
       * nada custa um 304 sem corpo. Opcional porque nenhuma outra
       * rota manda `If-None-Match`, e um campo obrigatório aqui
       * obrigaria as outras seis a inventar um valor.
       */
      readonly etag?: string | null;
    }
  | {
      readonly ok: false;
      /** `null` = não chegou no site (timeout, DNS, TLS, cabo). */
      readonly status: number | null;
      /** O `error_code` do site, quando ele veio. */
      readonly code: string | null;
      /** A frase do site, ou a do erro de rede. Vai para log e tela. */
      readonly reason: string;
      /** O corpo, quando deu para ler. Carrega `charged` nos 409. */
      readonly body: Record<string, unknown> | null;
    };

export interface SiteClientOptions {
  /** A ORIGEM do site, sem caminho e sem barra no fim. */
  readonly baseUrl: string;
  /** Vazio = o agente ainda não foi ativado; só o beacon sai. */
  readonly token: string;
  /** O id NO SITE (`RUST01`), e não o de `Configs\`. */
  readonly serverId: string;
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger | undefined;
  /** Injetável para o teste não sair na rede. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export class SiteClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #serverId: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #logger: Logger | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: SiteClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#serverId = options.serverId;
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs ?? SITE_DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** Há token? Sem ele, só o beacon fala com o site. */
  get authenticated(): boolean {
    return this.#token !== '';
  }

  get serverId(): string {
    return this.#serverId;
  }

  /** Para quem quiser registrar o que passou por aqui. */
  get logger(): Logger | undefined {
    return this.#logger;
  }

  // ---- beacon (sem bearer e sem X-Server-Id) ----------------

  /**
   * O batimento. Ele NÃO passa pelo `#call`, e isso é deliberado.
   *
   * ####  A ÚNICA ROTA SEM `Authorization` E SEM `X-Server-Id`  ####
   *
   * O `serverId` vai no CORPO, e o site não o lê do header nesta
   * rota. Mandar o header não quebraria nada — mas o critério do
   * §21.1 fala de "toda chamada autenticada", e o beacon não é uma
   * delas: um teste escrito contra o `#call` fixaria o comportamento
   * errado.
   */
  beacon(input: {
    readonly port: number;
    readonly version: string;
    readonly mac: string;
    readonly capabilities: readonly string[];
    /** Ver §9.4. Ausente quando não há token. */
    readonly signature?: { readonly timestamp: number; readonly value: string };
  }): Promise<SiteResult<Record<string, unknown>>> {
    return this.#send('POST', '/api/agent/beacon', {
      body: {
        serverId: this.#serverId,
        port: input.port,
        version: input.version,
        mac: input.mac,
        capabilities: input.capabilities,
      },
      auth: false,
      ...(input.signature === undefined
        ? {}
        : {
            headers: {
              'X-Agent-Timestamp': String(input.signature.timestamp),
              'X-Agent-Signature': input.signature.value,
            },
          }),
    });
  }

  // ---- carteira --------------------------------------------

  async balance(steamId: string): Promise<SiteResult<BalanceBody>> {
    // `URLSearchParams` também aqui: `transaction()` já o usa, e duas
    // formas de montar a mesma query no arquivo que este documento
    // chama de "ponto único" é o começo da terceira.
    const query = new URLSearchParams({ steamId });
    const result = await this.#call('GET', `/api/agent/ozcoins/balance?${query.toString()}`);

    // ####  AQUI `moedas` VIRA `balance`, E SÓ AQUI  ####
    return result.ok
      ? { ...result, body: { balance: toInteger(result.body.moedas), exists: true } }
      : result;
  }

  /**
   * O débito e o crédito. `reason` vira `observacao` AQUI, e é o
   * único lugar onde isso acontece.
   */
  async mutate(
    direction: 'debit' | 'credit',
    input: {
      readonly steamId: string;
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      readonly productId?: string;
    },
  ): Promise<SiteResult<MutationBody>> {
    // Daqui para baixo os nomes dos campos são do contrato do site.
    const result = await this.#call('POST', `/api/agent/ozcoins/${direction}`, {
      steamId: input.steamId,
      amount: input.amount,
      referenceId: input.referenceId,
      observacao: input.reason.slice(0, 500),
      ...(input.productId === undefined ? {} : { productId: input.productId }),
    });

    return result.ok
      ? {
          ...result,
          body: {
            success: result.body.success === true,
            idempotent: result.body.idempotent === true,
            balance: toInteger(result.body.moedas),
            before: toInteger(result.body.before),
            after: toInteger(result.body.after),
            amount: toInteger(result.body.amount),
            transactionId: idOf(result.body.transactionId),
          },
        }
      : result;
  }

  async transaction(referenceId: string, steamId: string): Promise<SiteResult<TransactionBody>> {
    const query = new URLSearchParams({ referenceId, steamId });
    const result = await this.#call('GET', `/api/agent/ozcoins/transaction?${query.toString()}`);

    return result.ok
      ? {
          ...result,
          body: {
            found: result.body.found === true,
            transactionId: idOf(result.body.transactionId),
            amount: toInteger(result.body.amount),
            productId: typeof result.body.productId === 'string' ? result.body.productId : null,
          },
        }
      : result;
  }

  // ---- entregas --------------------------------------------

  /**
   * Uma PÁGINA da fila. Quem caminha por elas é o `SiteDeliveries`,
   * não este arquivo — aqui só o transporte.
   *
   * ####  `cursor` É OPACO, E O 400 DELE TEM DONO  ####
   *
   * O corpo devolve `next: string | null`. Ignorá-lo é o defeito do
   * §5.7: as 50 primeiras tarefas da fila são servidas para sempre e
   * a de nº 51 nunca aparece.
   *
   * `400 INVALID_CURSOR` chega aqui como `SiteResult` com
   * `code: 'INVALID_CURSOR'`, e QUEM O TRATA É O LAÇO: ele joga o
   * cursor fora e recomeça do topo. Se ele caísse na regra do 4xx
   * desconhecido (`unavailable`, retentável IGUAL), o agente
   * repetiria o mesmo cursor recusado a cada 15 s, para sempre.
   */
  pendingDeliveries(limit: number, cursor?: string): Promise<SiteResult<PendingBody>> {
    const query = new URLSearchParams({ limit: String(limit) });

    if (cursor !== undefined) {
      query.set('cursor', cursor);
    }

    return this.#call('GET', `/api/agent/deliveries/pending?${query.toString()}`);
  }

  ackDeliveries(acks: readonly DeliveryAck[]): Promise<SiteResult<AckBody>> {
    return this.#call('POST', '/api/agent/deliveries/ack', { deliveries: acks });
  }

  // ---- retrato do servidor ---------------------------------

  /**
   * O retrato periódico daquele servidor. Ver `site/status.ts`.
   *
   * ####  ELE É TELEMETRIA, E O CORPO É MONTADO LÁ  ####
   *
   * Aqui só o transporte: quem decide o que cabe, o que sai quando
   * o corpo estoura e o que fazer com cada resposta é o laço. Um
   * `unknown` no parâmetro é de propósito — o corpo já vem pronto
   * e tipado da origem, e um segundo tipo aqui seria uma cópia a
   * divergir da primeira.
   */
  pushServerStatus(payload: unknown): Promise<SiteResult<ServerStatusBody>> {
    return this.#call('POST', '/api/agent/server/status', payload);
  }

  // ---- catálogo --------------------------------------------

  mirrorVersion(): Promise<SiteResult<MirrorVersionBody>> {
    return this.#call('GET', '/api/agent/shop/mirror/version');
  }

  pushMirror(payload: unknown): Promise<SiteResult<MirrorBody>> {
    return this.#call('POST', '/api/agent/shop/mirror', payload);
  }

  // ---- VIP -------------------------------------------------

  /**
   * O espelho dos VIPs ATIVOS. Mesmo desenho do catálogo, e pelo
   * mesmo motivo: o site não tem como perguntar, então o agente
   * conta.
   *
   * ####  A DIREÇÃO É O CONTRÁRIO DA DO CATÁLOGO  ####
   *
   * A loja nasce no agente e o site a exibe. O VIP nasce nos DOIS
   * (o site vende, o jogador compra in-game, o admin dá à mão) e
   * quem executa o vencimento é o agente. Este espelho é o que
   * conta ao site o que de fato está valendo no jogo — sem ele o
   * `UserVipGrant` de lá é uma promessa que ninguém confere.
   *
   * Enquanto o outro lado não existir, isto responde 404 e o
   * `VipSiteMirror` recua sozinho. Ver Docs\24.
   */
  vipMirrorVersion(): Promise<SiteResult<MirrorVersionBody>> {
    return this.#call('GET', '/api/agent/vip/mirror/version');
  }

  pushVipMirror(payload: unknown): Promise<SiteResult<MirrorBody>> {
    return this.#call('POST', '/api/agent/vip/mirror', payload);
  }

  // ---- comandos --------------------------------------------

  /**
   * Puxa o que o admin enfileirou. Ver `site/commands.ts`.
   *
   * ####  ISTO NÃO É LEITURA, E O MÉTODO DIZ ISSO  ####
   *
   * É `POST` porque a linha SAI DA FILA no próprio pull, com o
   * `leaseToken` carimbado nela: puxar duas vezes não devolve o
   * mesmo comando. Um `GET` idempotente aqui faria dois laços do
   * mesmo agente — ou um retry de rede — reiniciarem o servidor
   * duas vezes, e a segunda cai em cima de gente que acabou de
   * entrar.
   *
   * `commands: []` é a resposta NORMAL: é o que 99% das rodadas
   * devolvem, e não é erro.
   */
  claimCommands(limit: number): Promise<SiteResult<ClaimBody>> {
    return this.#call('POST', '/api/agent/commands/claim', { limit });
  }

  /**
   * Diz o que aconteceu. Lote de 1 a 10 — e o teto é menor que o
   * das entregas (50) de propósito: comando é raro e caro, entrega
   * é comum e barata.
   */
  ackCommands(acks: readonly CommandAck[]): Promise<SiteResult<CommandAckBody>> {
    return this.#call('POST', '/api/agent/commands/ack', { commands: acks });
  }

  // ---- config desejada -------------------------------------

  /**
   * O que o servidor DEVERIA ser, na opinião do site.
   *
   * ####  O 304 CHEGA AQUI COMO SUCESSO  ####
   *
   * `Response.ok` é falso para 304, e sem este ramo a volta barata
   * — a que existe justamente para não gastar corpo — apareceria no
   * log como falha a cada 30 s, por servidor. O `notModified` é a
   * tradução: "nada mudou", que é o desfecho mais comum deste laço.
   */
  async serverConfig(etag: string | null): Promise<SiteResult<ServerConfigBody>> {
    const result = await this.#send('GET', '/api/agent/server/config', {
      auth: true,
      ...(etag === null || etag === '' ? {} : { headers: { 'If-None-Match': etag } }),
    });

    if (!result.ok) {
      return result.status === 304
        ? { ok: true, status: 304, body: { notModified: true, version: null, desired: null }, etag }
        : result;
    }

    return { ...result, body: readDesired(result.body) };
  }

  /** O que foi feito com AQUELA versão. Ver `site/config.ts`. */
  ackServerConfig(payload: {
    readonly version: number;
    readonly applied: boolean;
    readonly requiresRestart: readonly string[];
    readonly errors: readonly ConfigFieldError[];
  }): Promise<SiteResult<ConfigAckBody>> {
    return this.#call('POST', '/api/agent/server/config/ack', payload);
  }

  // ---- config por assunto ----------------------------------

  /**
   * O catálogo (ou os kits, ou os VIPs) que o site quer que valham.
   *
   * Mesmo desenho do `serverConfig`, e de propósito: uma `version`
   * que só cresce, `ETag` opcional, e o 304 chegando aqui como
   * SUCESSO — sem esse ramo, a volta barata apareceria no log como
   * falha a cada minuto, por assunto e por servidor.
   *
   * O `desired` de cada assunto tem forma própria, e quem a conhece
   * é o aplicador: aqui ele é só "um objeto, ou nada".
   */
  async domainConfig(domain: string, etag: string | null): Promise<SiteResult<DomainConfigBody>> {
    const result = await this.#send('GET', `/api/agent/config/${domain}`, {
      auth: true,
      ...(etag === null || etag === '' ? {} : { headers: { 'If-None-Match': etag } }),
    });

    if (!result.ok) {
      return result.status === 304
        ? { ok: true, status: 304, body: { notModified: true, version: null, desired: null }, etag }
        : result;
    }

    return { ...result, body: readDesired(result.body) };
  }

  /**
   * O que foi feito com AQUELA versão daquele assunto.
   *
   * `stats` não é enfeite: um snapshot de loja que entra inteiro e
   * um que entra pela metade produzem o mesmo `applied: true`, e a
   * contagem é o que separa os dois na tela do site.
   */
  ackDomainConfig(
    domain: string,
    payload: {
      readonly version: number;
      readonly applied: boolean;
      readonly errors: readonly ConfigFieldError[];
      readonly stats: Record<string, number>;
    },
  ): Promise<SiteResult<ConfigAckBody>> {
    return this.#call('POST', `/api/agent/config/${domain}/ack`, payload);
  }

  // ------------------------------------------------------------

  /** Uma chamada AUTENTICADA: bearer + `X-Server-Id`. */
  #call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<SiteResult<Record<string, unknown>>> {
    return this.#send(method, path, body === undefined ? { auth: true } : { body, auth: true });
  }

  async #send(
    method: 'GET' | 'POST',
    path: string,
    options: {
      readonly body?: unknown;
      /** `false` = beacon: sem `Authorization` e sem `X-Server-Id`. */
      readonly auth: boolean;
      /** A assinatura do beacon e o `If-None-Match` da config. */
      readonly headers?: Record<string, string>;
    },
  ): Promise<SiteResult<Record<string, unknown>>> {
    const { body } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.#userAgent,
          // O beacon é a exceção, e ela é explícita: sem bearer e sem
          // `X-Server-Id`, que viaja no corpo. Ver `beacon()`.
          ...(options.auth && this.#token !== '' ? { Authorization: `Bearer ${this.#token}` } : {}),
          ...(options.auth ? { 'X-Server-Id': this.#serverId } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const cause = toError(error);

      // `status: null` é o sinal de "não chegou lá", e é ele que a
      // carteira lê para devolver `unknown` em vez de `unavailable`.
      return {
        ok: false,
        status: null,
        code: null,
        reason:
          cause.name === 'AbortError'
            ? `o site não respondeu em ${String(Math.round(this.#timeoutMs / 1000))} s`
            : cause.message,
        body: null,
      };
    } finally {
      clearTimeout(timer);
    }

    // Leitura DEFENSIVA: um 403 da borda vem em texto puro, e um
    // `json()` que estoure aqui viraria exceção onde só pode haver
    // desfecho.
    const text = await response.text().catch(() => '');
    const parsed = safeJson(text);

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        body: parsed ?? {},
        etag: response.headers.get('etag'),
      };
    }

    return {
      ok: false,
      status: response.status,
      code: typeof parsed?.error_code === 'string' ? parsed.error_code : null,
      reason:
        typeof parsed?.error === 'string'
          ? parsed.error
          : `o site respondeu ${String(response.status)} ${text.slice(0, 200)}`.trim(),
      body: parsed,
    };
  }
}

/**
 * A `version` e o `desired` de qualquer canal de config.
 *
 * ####  `version: 0` É "NÃO HÁ CONFIG", E FOI MEDIDO  ####
 *
 * O dev respondeu `{"ok":true,"version":0,"desired":null}` para um
 * servidor pareado que ninguém configurou, e recusou o ACK daquela
 * mesma versão com **400 `CONFIG_INVALID_VERSION` — "version precisa
 * ser um inteiro ≥ 1"**. Ou seja: do lado de lá, zero é o sentinela
 * de vazio; se este lado o tratasse como versão, um `desired`
 * qualquer que viesse com ela seria aplicado, gravado, e o ACK dele
 * tomaria 400 a cada 30 s, para sempre.
 *
 * A régua da versão é do SITE (`Docs/21` §7 / `Docs/20` §23.1), e
 * ela diz ≥ 1. Abaixo disso, aqui, é ausência.
 *
 * `desired` só passa se for objeto: lista e escalar não são config.
 */
function readDesired(body: Record<string, unknown>): {
  readonly notModified: false;
  readonly version: number | null;
  readonly desired: Record<string, unknown> | null;
} {
  const version = body.version;
  const desired = body.desired;

  return {
    notModified: false,
    version:
      typeof version === 'number' && Number.isSafeInteger(version) && version >= 1
        ? version
        : null,
    desired:
      typeof desired === 'object' && desired !== null && !Array.isArray(desired)
        ? (desired as Record<string, unknown>)
        : null,
  };
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * O dinheiro do site chega como STRING, e comparar string com string
 * é ordem lexicográfica: `"300" > "1500"` seria verdadeiro.
 *
 * `null` = não é um inteiro. Nunca zero, que é uma afirmação sobre o
 * dinheiro de alguém.
 *
 * Ele mora AQUI, e não na carteira, porque é aqui que o dialeto do
 * site acaba.
 */
function toInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value.trim());

  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** O `transactionId` do site é BIGINT: guarde como TEXTO. */
function idOf(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

// ============================================================
//  OS CORPOS, POR EXTENSO
//
//  ####  TUDO OPCIONAL, DE PROPÓSITO  ####
//
//  Estes tipos descrevem o que o site MANDA, não o que ele promete.
//  Um campo obrigatório aqui viraria `undefined` em runtime no dia
//  em que o site mudasse, e o TypeScript não avisaria — ele acredita
//  no cast. Por isso o parse é defensivo em quem lê: a carteira
//  checa `success !== true` e `balance === null` antes de chamar
//  qualquer coisa de `ok`.
// ============================================================

/** `GET /ozcoins/balance` — JÁ TRADUZIDO. */
export interface BalanceBody {
  /** `null` = o site não devolveu um inteiro. NUNCA zero. */
  readonly balance: number | null;
  /** Sempre `true` no site. Nunca ramifique por ele. */
  readonly exists: boolean;
}

/** `POST /ozcoins/debit|credit` — JÁ TRADUZIDO. */
export interface MutationBody {
  readonly success: boolean;
  /** `true` = já tinha sido cobrado. NUNCA "já foi entregue". */
  readonly idempotent: boolean;
  /** O saldo DEPOIS. Num replay, o de ONTEM. */
  readonly balance: number | null;
  readonly before: number | null;
  readonly after: number | null;
  readonly amount: number | null;
  /** Ausente no replay: o site não repete o id. TEXTO (BIGINT). */
  readonly transactionId: string | null;
}

/** `GET /ozcoins/transaction` — JÁ TRADUZIDO. */
export interface TransactionBody {
  readonly found: boolean;
  readonly transactionId: string | null;
  readonly amount: number | null;
  readonly productId: string | null;
}

/** Uma tarefa da fila, como o site a manda. */
export interface PendingDeliveryBody {
  readonly id?: string;
  readonly steamId?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly sourceRef?: string | null;
  readonly attempts?: number;
  readonly createdAt?: string;
  readonly expiresAt?: string | null;
}

/** `GET /deliveries/pending`. */
export interface PendingBody {
  readonly ok?: boolean;
  readonly deliveries?: readonly PendingDeliveryBody[];
  readonly next?: string | null;
}

/** Um ACK, como o agente o manda. */
export interface DeliveryAck {
  readonly id: string;
  /**
   * TRÊS valores, e só três.
   *
   * ####  NÃO EXISTE UM QUARTO  ####
   *
   * O site responde 400 `INVALID_ACK_STATUS` PARA O LOTE INTEIRO a
   * qualquer valor fora destes: um ACK torto num lote de 50
   * derrubaria os outros 49. O indeterminado viaja como `deferred`
   * com `reason: 'AGENT_INDETERMINATE'`, que é o único `reason` que
   * o site interpreta.
   */
  readonly status: 'delivered' | 'failed' | 'deferred';
  readonly reason?: string;
  readonly at: string;
}

/** `POST /deliveries/ack`. */
export interface AckBody {
  readonly ok?: boolean;
  readonly applied?: number;
  /** NÃO significa "não aconteceu". Ver §5.8. */
  readonly unknown?: readonly string[];
}

/** `POST /server/status`. Telemetria: nada aqui muda decisão. */
export interface ServerStatusBody {
  readonly ok?: boolean;
  readonly accepted?: boolean;
  readonly receivedAt?: string;
}

/** `GET /shop/mirror/version`. `version: null` = não há espelho. */
export interface MirrorVersionBody {
  readonly ok?: boolean;
  readonly version?: string | null;
  readonly updatedAt?: string | null;
}

/** `POST /shop/mirror`. */
export interface MirrorBody {
  readonly ok?: boolean;
  readonly accepted?: boolean;
  readonly version?: string;
  readonly storedAt?: string;
}

/** Um comando, como o site o manda. Tudo opcional: ver o bloco acima. */
export interface ClaimedCommandBody {
  readonly id?: string;
  readonly kind?: string;
  readonly params?: unknown;
  readonly issuedAt?: string;
  /** ABSOLUTO, no relógio do SITE. */
  readonly expiresAt?: string;
  /** O MESMO prazo, relativo. Existe por causa do clock skew. */
  readonly ttlMs?: number;
  /** Opaco. Volta no ACK, e só ele fecha a linha. */
  readonly leaseToken?: string;
}

/** `POST /commands/claim`. Lista vazia é a resposta NORMAL. */
export interface ClaimBody {
  readonly ok?: boolean;
  readonly commands?: readonly ClaimedCommandBody[];
}

/**
 * Um ACK de comando, como o agente o manda.
 *
 * ####  QUATRO VALORES, E NÃO HÁ UM QUINTO  ####
 *
 * `reason` é OBRIGATÓRIO em `refused` e opcional em `failed`, e o
 * vocabulário dele é FECHADO (Docs\22 §2.3). Um valor fora dele é
 * 400 do lado do site, e um 400 num ACK deixa a linha pendurada —
 * por isso quem traduz erro nunca inventa um `reason`.
 */
export interface CommandAck {
  readonly id: string;
  /** Sem ele, ou com um token velho, a linha volta em `unknown`. */
  readonly leaseToken: string;
  readonly status: 'accepted' | 'executed' | 'failed' | 'refused';
  readonly reason?: string;
  /** O id da `operation` local. Liga a linha do site ao log daqui. */
  readonly operationId?: string;
  readonly at: string;
}

/** `POST /commands/ack`. */
/**
 * Uma linha da resposta do ACK, do jeito que o dev responde.
 *
 * Medido em 04/09/2026:
 *
 * ```json
 * {"ok":true,"results":[
 *   {"commandId":"CMD-…","applied":false,"status":"unknown","outcome":"invalid_lease"}]}
 * ```
 */
export interface CommandAckResult {
  readonly commandId?: string;
  readonly applied?: boolean;
  readonly status?: string;
  readonly outcome?: string;
}

export interface CommandAckBody {
  readonly ok?: boolean;
  readonly applied?: number;
  /**
   * Token velho, id desconhecido, linha já fechada.
   *
   * ####  O SITE NÃO MANDA ESTA LISTA — ELE MANDA `results[]`  ####
   *
   * A forma do manual continua aceita (é a que os dublês usam), mas
   * a que atravessa o fio hoje é `results[]`, com um `applied: false`
   * por linha. Quem junta as duas é `unknownAcks`: ler só `unknown`
   * fazia toda recusa do site chegar aqui como sucesso, e o desfecho
   * do comando sumia sem nenhuma linha de log.
   */
  readonly unknown?: readonly string[];
  readonly results?: readonly CommandAckResult[];
}

/**
 * Os ids que o site NÃO aplicou, venham eles como vierem.
 *
 * A forma do manual (`unknown: string[]`) e a medida contra o dev
 * (`results[].applied === false`) descrevem o mesmo fato.
 */
export function unknownAcks(body: CommandAckBody): ReadonlySet<string> {
  const ids = new Set<string>(body.unknown ?? []);

  for (const result of body.results ?? []) {
    if (result.applied === false && typeof result.commandId === 'string') {
      ids.add(result.commandId);
    }
  }

  return ids;
}

/** `GET /server/config` — JÁ TRADUZIDO. */
export interface ServerConfigBody {
  /** `true` = 304: nada mudou desde o `ETag` que mandamos. */
  readonly notModified: boolean;
  /** `null` = o site não mandou um inteiro. NUNCA zero. */
  readonly version: number | null;
  /** Campo AUSENTE = "o site não opina sobre ele". Não é apague. */
  readonly desired: Record<string, unknown> | null;
}

/** `GET /config/:domain`. Mesma forma da config de servidor. */
export interface DomainConfigBody {
  /** `true` = 304: nada mudou desde o `ETag` que mandamos. */
  readonly notModified: boolean;
  /** `null` = o site não mandou um inteiro. NUNCA zero. */
  readonly version: number | null;
  /** A forma de dentro é de cada assunto. Ver `site/domains.ts`. */
  readonly desired: Record<string, unknown> | null;
}

/** Um campo que não entrou, e por quê. */
export interface ConfigFieldError {
  readonly field: string;
  readonly code: string;
}

/** `POST /server/config/ack`. */
export interface ConfigAckBody {
  readonly ok?: boolean;
  readonly accepted?: boolean;
}
