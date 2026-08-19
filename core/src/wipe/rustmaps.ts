// ============================================================
//  rustmaps.ts  -  o CLIENTE do rustmaps.com: pedir a prévia,
//  guardar o mapId, ler as URLs.
//
//  Aqui não há banco, não há relógio e não há rota: só HTTP e a
//  leitura honesta do que voltou. Quem grava é
//  wipe/rustmaps-poll.ts; quem responde ao painel é
//  http/routes/rustmaps.ts.
//
//  ------------------------------------------------------------
//  ####  A PRÉVIA É ENFEITE  ####
//
//  Nenhuma função deste arquivo lança por causa da rede. Toda
//  falha vira um desfecho NOMEADO (`offline`, `throttled`), e
//  quem chamou decide o que dizer. A regra existe por um defeito
//  concreto: um servidor que não zerou de madrugada porque um
//  site estava fora do ar. Num mundo procedural a seed É o mapa —
//  a imagem é o que o admin e o VIP olham antes, e nada mais.
//
//  ------------------------------------------------------------
//  ####  O CONTRATO, E DE ONDE ELE VEIO  ####
//
//      POST /v4/maps              { size, seed, staging }
//        200  o mapa já existe, e vem com as URLs
//        201  entrou na fila:  data.mapId, data.state, data.queuePosition
//        409  existe, mas ainda não está pronto: só o id
//        401  chave inválida
//        403  chave sem plano para o que foi pedido
//        429  passou do limite de requisições
//
//      GET  /v4/maps/{mapId}      o retrato de um mapa pelo id
//
//      cabeçalhos:  X-API-Key
//      cota:        x-rate-limit-limit / -remaining / -reset
//
//  `api.rustmaps.com/docs` responde 403 sem chave, então o
//  contrato acima foi montado a partir da implementação de
//  referência (RustServerManager/RustMaps-API) e das fontes
//  listadas no Docs\16. **Ele não foi conferido contra a API real
//  com uma chave em mãos** — por isso a leitura da resposta é
//  DEFENSIVA: cada campo é procurado por mais de um nome, e o que
//  não vier vira `null` em vez de estourar. Uma prévia que não
//  aparece é um enfeite ausente; um parser que lança é um relógio
//  morto.
//
//  ------------------------------------------------------------
//  ####  A CHAVE NÃO SAI DAQUI  ####
//
//  Ela entra pelo `.env` (`RUSTMAPS_API_KEY`), vive dentro deste
//  objeto e só aparece no cabeçalho da requisição. Nada em
//  `status()` a devolve, e nenhum log a imprime — a rota de status
//  responde válida/inválida, o plano e a cota, e mais nada.
// ============================================================

import { toError } from '../util.js';

/** A casa da API. Sem barra no fim: quem monta o caminho põe a dele. */
export const RUSTMAPS_BASE_URL = 'https://api.rustmaps.com';

/**
 * O teto de requisições por minuto.
 *
 * ####  ESTE NÚMERO NÃO FOI MEDIDO  ####
 *
 * Ele veio de um CLI NÃO-OFICIAL (maintc/rustmaps-cli), e não da
 * documentação — `api.rustmaps.com/docs` responde 403 sem chave.
 * Meça com a chave em mãos antes de encostar no intervalo do
 * poll. Enquanto ninguém mediu, o agente trabalha MUITO abaixo
 * disto (ver `RUSTMAPS_MAX_CALLS_PER_TICK`): estourar a cota de
 * um enfeite não vale o risco.
 */
export const RUSTMAPS_REQUESTS_PER_MINUTE = 60;

/** Teto de uma chamada. O RustMaps responde em menos de um segundo. */
export const RUSTMAPS_TIMEOUT_MS = 20_000;

/** O que o agente sabe sobre um mapa depois de perguntar. */
export interface RustMapsPreview {
  /** O id do mapa no RustMaps. É a chave do poll. */
  readonly mapId: string;
  /** A página do mapa no site, para o "[abrir ↗]" da tela. */
  readonly pageUrl: string | null;
  /** A imagem grande. `null` = ainda não tem. */
  readonly imageUrl: string | null;
  /** A miniatura, para a lista da fila. */
  readonly thumbUrl: string | null;
  /**
   * Os monumentos pelo nome. `null` = **não sabemos**, que é
   * diferente de "nenhum": uma lista vazia é uma afirmação sobre
   * o mundo, e uma resposta sem o campo não afirma nada.
   */
  readonly monuments: readonly string[] | null;
  /** Este retrato foi gerado no branch STAGING? */
  readonly staging: boolean;
}

/** O que a cota da chave respondeu nos cabeçalhos da última chamada. */
export interface RustMapsQuota {
  /** Quantas requisições cabem na janela. `null` = o servidor não disse. */
  readonly limit: number | null;
  readonly remaining: number | null;
  /** Quando a janela reinicia, epoch ms. `null` = não disse. */
  readonly resetAt: number | null;
}

export const EMPTY_QUOTA: RustMapsQuota = { limit: null, remaining: null, resetAt: null };

/**
 * O desfecho de UMA conversa com o RustMaps.
 *
 * É uma união fechada de propósito: cada ramo tem um tratamento
 * diferente no banco, e um `boolean` de sucesso obrigaria quem
 * chama a adivinhar qual. Ver a tabela do Docs\17 §"Frente H".
 */
export type RustMapsOutcome =
  /** 200: o mapa existe e as URLs vieram. */
  | { readonly kind: 'ready'; readonly preview: RustMapsPreview; readonly quota: RustMapsQuota }
  /** 201 e 409: está na fila do RustMaps. O poll acompanha. */
  | {
      readonly kind: 'queued';
      readonly mapId: string;
      readonly state: string | null;
      readonly queuePosition: number | null;
      readonly staging: boolean;
      readonly quota: RustMapsQuota;
    }
  /** 401 e 403: a chave não serve. Desliga a geração automática. */
  | {
      readonly kind: 'denied';
      readonly status: number;
      readonly code: 'RUSTMAPS_KEY_INVALID' | 'RUSTMAPS_PLAN_INSUFFICIENT';
      readonly message: string;
      readonly quota: RustMapsQuota;
    }
  /** 429 e 5xx: instabilidade ou limite. Recua, e NUNCA derruba a fila. */
  | {
      readonly kind: 'throttled';
      readonly status: number;
      readonly message: string;
      /** O `Retry-After`, quando veio. `null` = decida você. */
      readonly retryAfterMs: number | null;
      readonly quota: RustMapsQuota;
    }
  /** 404: aquele id não existe (mais) lá. */
  | { readonly kind: 'missing'; readonly message: string; readonly quota: RustMapsQuota }
  /** Sem rede, DNS caído, tempo esgotado. O mundo continua valendo. */
  | { readonly kind: 'offline'; readonly message: string }
  /** Sem `RUSTMAPS_API_KEY` no `.env`. Nada foi pedido a ninguém. */
  | { readonly kind: 'unconfigured'; readonly message: string };

/** O que a rota de status devolve — e repare que a chave não está aqui. */
export interface RustMapsKeyStatus {
  /** Existe `RUSTMAPS_API_KEY` no `.env`? */
  readonly configured: boolean;
  /** `null` = ainda não perguntamos, ou a pergunta não chegou lá. */
  readonly valid: boolean | null;
  /**
   * O plano da conta, quando a resposta o traz.
   *
   * ####  NÃO EXISTE ROTA DE "QUAL É O MEU PLANO"  ####
   *
   * O que o RustMaps devolve é 403 quando o pedido passa do que o
   * plano permite. Então o plano só é afirmado quando a própria
   * resposta o nomeia; fora disso é `null`, e a tela diz que não
   * dá para saber sem tentar. Ver Docs\16 §14.
   */
  readonly plan: string | null;
  readonly quota: RustMapsQuota;
  /** Epoch ms da última pergunta. `null` = nenhuma ainda. */
  readonly checkedAt: number | null;
  /** O que dizer na tela, em português, já pronto. */
  readonly message: string;
}

export interface RustMapsClientOptions {
  /** A chave do `.env`. Vazia = o cliente não fala com ninguém. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injetável para o teste não sair na rede. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** O corpo pedido em `POST /v4/maps`. */
export interface RustMapsRequestInput {
  /** A seed, como TEXTO — ela é transportada, nunca somada. */
  readonly seed: string;
  readonly size: number;
  /**
   * Gerar contra a versão que AINDA VAI ENTRAR.
   *
   * Só serve depois do wipe forçado, e é exatamente por isso que
   * ela liga sozinha quando a entrada aponta para um plano
   * `forced`. Ver Docs\16 §9.1, "o staging".
   */
  readonly staging: boolean;
}

export class RustMapsClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  #quota: RustMapsQuota = EMPTY_QUOTA;

  constructor(options: RustMapsClientOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = (options.baseUrl ?? RUSTMAPS_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? RUSTMAPS_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** Há chave no `.env`? Sem ela nada é pedido a ninguém. */
  get configured(): boolean {
    return this.#apiKey !== '';
  }

  /** A cota lida nos cabeçalhos da ÚLTIMA chamada que chegou lá. */
  get quota(): RustMapsQuota {
    return this.#quota;
  }

  /**
   * Pede a prévia de um mundo procedural.
   *
   * O 200 já traz tudo (alguém no mundo já gerou essa seed); o
   * 201 e o 409 devolvem só o id, e daí em diante é o poll que
   * acompanha.
   */
  async request(input: RustMapsRequestInput): Promise<RustMapsOutcome> {
    return this.#call('POST', '/v4/maps', input.staging, {
      seed: Number(input.seed),
      size: input.size,
      staging: input.staging,
    });
  }

  /** O retrato de um mapa pelo id — é o que o poll pergunta. */
  async mapOf(mapId: string, staging = false): Promise<RustMapsOutcome> {
    return this.#call('GET', `/v4/maps/${encodeURIComponent(mapId)}`, staging);
  }

  /**
   * A chave serve?
   *
   * ####  A PERGUNTA É UM GET, E NUNCA UM POST  ####
   *
   * Perguntar com `POST /v4/maps` enfileiraria uma geração de
   * verdade a cada vez que alguém abrisse a tela — e a cota é
   * mensal. O GET por id é barato e responde o que interessa:
   * 401/403 é chave ruim, qualquer outra coisa é chave boa (até
   * um 404, que só diz que aquele mapa não existe).
   */
  async status(now: number = Date.now()): Promise<RustMapsKeyStatus> {
    if (!this.configured) {
      return {
        configured: false,
        valid: null,
        plan: null,
        quota: EMPTY_QUOTA,
        checkedAt: null,
        message:
          'RUSTMAPS_API_KEY está vazia no .env. Sem ela o agente não desenha prévia nenhuma — e ' +
          'isso não atrapalha wipe: num mundo procedural a seed já É o mapa. Pegue a chave em ' +
          'rustmaps.com/dashboard e reinicie o agente.',
      };
    }

    const outcome = await this.mapOf(STATUS_PROBE_MAP_ID);

    if (outcome.kind === 'denied') {
      return {
        configured: true,
        valid: false,
        plan: null,
        quota: outcome.quota,
        checkedAt: now,
        message: outcome.message,
      };
    }

    if (outcome.kind === 'offline') {
      return {
        configured: true,
        valid: null,
        plan: null,
        quota: this.#quota,
        checkedAt: now,
        message:
          `Não deu para falar com o rustmaps.com: ${outcome.message}. A chave pode estar certa — ` +
          'a fila de mapas e o wipe continuam funcionando sem prévia.',
      };
    }

    if (outcome.kind === 'unconfigured') {
      return {
        configured: false,
        valid: null,
        plan: null,
        quota: EMPTY_QUOTA,
        checkedAt: now,
        message: outcome.message,
      };
    }

    return {
      configured: true,
      valid: true,
      plan: null,
      quota: outcome.quota,
      checkedAt: now,
      message:
        outcome.kind === 'throttled'
          ? 'A chave é aceita, mas o RustMaps está pedindo calma agora (limite de requisições). ' +
            'O agente recua sozinho e tenta de novo.'
          : 'A chave é aceita pelo RustMaps. O plano só aparece quando um pedido esbarra nele: ' +
            'a API não tem rota de "qual é o meu plano".',
    };
  }

  // ------------------------------------------------------
  //  Interno
  // ------------------------------------------------------

  /**
   * Uma conversa, do começo ao fim, sem lançar nunca.
   *
   * O `staging` viaja até aqui só para poder aparecer no
   * `RustMapsPreview` — o RustMaps não repete o campo em toda
   * resposta, e quem grava precisa saber em que branch aquele
   * retrato foi pedido.
   */
  async #call(
    method: 'GET' | 'POST',
    path: string,
    staging: boolean,
    body?: unknown,
  ): Promise<RustMapsOutcome> {
    if (!this.configured) {
      return {
        kind: 'unconfigured',
        message:
          'RUSTMAPS_API_KEY está vazia no .env: o agente não pediu prévia nenhuma. A seed ' +
          'continua valendo, e o wipe também.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'X-API-Key': this.#apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const quota = readQuota(response.headers);

      this.#quota = quota;

      return await this.#interpret(response, quota, staging);
    } catch (error) {
      // Sem rede, DNS caído, tempo esgotado. NÃO é erro do agente
      // e não pode virar exceção: quem chama roda dentro de um
      // relógio, e um `throw` aqui pararia o laço em silêncio.
      const cause = toError(error);

      return {
        kind: 'offline',
        message:
          cause.name === 'AbortError'
            ? `o rustmaps.com não respondeu em ${String(Math.round(this.#timeoutMs / 1000))} s`
            : cause.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** O código HTTP vira desfecho. É a tabela do Docs\17, em código. */
  async #interpret(
    response: Response,
    quota: RustMapsQuota,
    staging: boolean,
  ): Promise<RustMapsOutcome> {
    const payload = await readJson(response);
    const data = dataOf(payload);

    if (response.status === 401) {
      return {
        kind: 'denied',
        status: 401,
        code: 'RUSTMAPS_KEY_INVALID',
        message:
          'O rustmaps.com recusou a chave (401). Confira RUSTMAPS_API_KEY no .env contra o que ' +
          'aparece em rustmaps.com/dashboard e reinicie o agente. Enquanto isso o agente para ' +
          'de pedir prévia — a fila de mapas e o wipe seguem normais.',
        quota,
      };
    }

    if (response.status === 403) {
      return {
        kind: 'denied',
        status: 403,
        code: 'RUSTMAPS_PLAN_INSUFFICIENT',
        message:
          'O rustmaps.com aceitou a chave mas recusou o pedido (403) — é o plano da conta que ' +
          'não cobre esta geração. Ou o plano sobe em rustmaps.com/dashboard, ou o agente fica ' +
          'só com as prévias que já existem. O wipe não depende disto.',
        quota,
      };
    }

    if (response.status === 404) {
      return {
        kind: 'missing',
        message: 'O rustmaps.com não conhece esse mapa (404). Peça a prévia de novo.',
        quota,
      };
    }

    if (response.status === 429 || response.status >= 500) {
      return {
        kind: 'throttled',
        status: response.status,
        message:
          response.status === 429
            ? 'O rustmaps.com pediu calma (429): passou do limite de requisições.'
            : `O rustmaps.com respondeu ${String(response.status)}.`,
        retryAfterMs: readRetryAfter(response.headers),
        quota,
      };
    }

    // 201 e 409 são o MESMO caminho: os dois dizem "está sendo
    // gerado, volte depois com este id". O 409 traz só o id.
    if (response.status === 201 || response.status === 409) {
      const mapId = stringField(data, 'mapId', 'mapID', 'id');

      if (mapId === null) {
        // A fila do RustMaps aceitou, mas sem id não há como
        // acompanhar. Melhor tratar como instabilidade e tentar
        // de novo do que gravar um `generating` eterno.
        return {
          kind: 'throttled',
          status: response.status,
          message:
            `O rustmaps.com respondeu ${String(response.status)} sem o id do mapa. O agente ` +
            'tenta de novo na próxima volta.',
          retryAfterMs: null,
          quota,
        };
      }

      return {
        kind: 'queued',
        mapId,
        state: stringField(data, 'state', 'status'),
        queuePosition: numberField(data, 'queuePosition', 'queue_position'),
        staging,
        quota,
      };
    }

    if (!response.ok) {
      return {
        kind: 'throttled',
        status: response.status,
        message: `O rustmaps.com respondeu ${String(response.status)}.`,
        retryAfterMs: null,
        quota,
      };
    }

    const preview = toPreview(data, staging);

    if (preview === null) {
      return {
        kind: 'throttled',
        status: response.status,
        message:
          'O rustmaps.com respondeu 200 sem o id do mapa. O agente tenta de novo na próxima volta.',
        retryAfterMs: null,
        quota,
      };
    }

    return { kind: 'ready', preview, quota };
  }
}

/**
 * O mapa que a sonda de `status()` pergunta.
 *
 * ####  ELE NÃO PRECISA EXISTIR  ####
 *
 * A pergunta aqui é sobre a CHAVE, e não sobre o mapa: 401/403
 * significa chave ruim, e qualquer outra resposta — inclusive
 * 404 — significa que a autenticação passou. Um id fixo e
 * inofensivo evita gastar cota de geração só para desenhar o
 * cadeado verde da tela.
 */
const STATUS_PROBE_MAP_ID = '00000000-0000-0000-0000-000000000000';

/** JSON, ou `null`. Corpo vazio e HTML de erro não podem lançar. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * O objeto útil da resposta.
 *
 * O RustMaps embrulha o resultado num `data`, com um `meta` ao
 * lado. Aceitar também a raiz é o que faz o parser sobreviver a
 * uma versão que mude o embrulho — e é barato.
 */
function dataOf(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const data = root['data'];

  if (data !== null && typeof data === 'object') {
    return data as Record<string, unknown>;
  }

  return root;
}

/** O primeiro dos nomes que vier como texto não vazio. */
function stringField(
  data: Record<string, unknown> | null,
  ...names: readonly string[]
): string | null {
  if (data === null) {
    return null;
  }

  for (const name of names) {
    const value = data[name];

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

/** O primeiro dos nomes que vier como número finito. */
function numberField(
  data: Record<string, unknown> | null,
  ...names: readonly string[]
): number | null {
  if (data === null) {
    return null;
  }

  for (const name of names) {
    const value = data[name];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return null;
}

/**
 * A resposta pronta vira o que o banco guarda.
 *
 * Sem `mapId` não há retrato: devolve `null`, e quem chamou trata
 * como instabilidade. Um retrato sem id não dá para acompanhar
 * nem para reabrir no site.
 */
function toPreview(data: Record<string, unknown> | null, staging: boolean): RustMapsPreview | null {
  const mapId = stringField(data, 'id', 'mapId', 'mapID');

  if (mapId === null) {
    return null;
  }

  return {
    mapId,
    pageUrl: stringField(data, 'url', 'mapUrl'),
    imageUrl: stringField(data, 'imageUrl', 'rawImageUrl', 'imageIconUrl'),
    thumbUrl: stringField(data, 'thumbnailUrl', 'thumbUrl', 'imageIconUrl'),
    monuments: readMonuments(data),
    // O campo do RustMaps manda quando ele vem; o nosso pedido é
    // o desempate. Sem isso, um retrato pedido em staging seria
    // gravado como se fosse do branch de sempre.
    staging: booleanField(data, 'isStaging', 'staging') ?? staging,
  };
}

function booleanField(
  data: Record<string, unknown> | null,
  ...names: readonly string[]
): boolean | null {
  if (data === null) {
    return null;
  }

  for (const name of names) {
    const value = data[name];

    if (typeof value === 'boolean') {
      return value;
    }
  }

  return null;
}

/**
 * Os monumentos, pelo nome.
 *
 * A lista chega ora como textos, ora como objetos com o nome
 * dentro — e às vezes não chega. `null` é "não sabemos"; uma
 * lista vazia seria afirmar que o mundo não tem monumento
 * nenhum, o que nenhuma resposta ausente autoriza a dizer.
 */
function readMonuments(data: Record<string, unknown> | null): readonly string[] | null {
  if (data === null) {
    return null;
  }

  const raw = data['monuments'];

  if (!Array.isArray(raw)) {
    return null;
  }

  const names: string[] = [];

  for (const item of raw as readonly unknown[]) {
    if (typeof item === 'string' && item.trim() !== '') {
      names.push(item.trim());
      continue;
    }

    if (item !== null && typeof item === 'object') {
      const name = stringField(item as Record<string, unknown>, 'name', 'monument', 'type');

      if (name !== null) {
        names.push(name);
      }
    }
  }

  return names;
}

/** A cota, lida dos cabeçalhos. Tudo `null` quando eles não vêm. */
function readQuota(headers: Headers): RustMapsQuota {
  const limit = headerNumber(headers, 'x-rate-limit-limit', 'x-ratelimit-limit');
  const remaining = headerNumber(headers, 'x-rate-limit-remaining', 'x-ratelimit-remaining');
  const reset = headers.get('x-rate-limit-reset') ?? headers.get('x-ratelimit-reset');

  return { limit, remaining, resetAt: parseReset(reset) };
}

function headerNumber(headers: Headers, ...names: readonly string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);

    if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }

  return null;
}

/**
 * O reset da cota, em epoch ms.
 *
 * O RustMaps manda ISO8601; outros serviços mandam segundos. Os
 * dois são aceitos porque custa três linhas, e porque uma data
 * mal lida vira "cota reinicia em 1970" na tela.
 */
function parseReset(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }

  const trimmed = raw.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);

    // Um número pequeno é "daqui a N segundos"; um número grande
    // já é epoch.
    return seconds > 10_000_000_000 ? seconds : Date.now() + seconds * 1000;
  }

  const parsed = Date.parse(trimmed);

  return Number.isNaN(parsed) ? null : parsed;
}

/** O `Retry-After`, em ms. Segundos ou data — os dois existem. */
function readRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');

  if (raw === null || raw.trim() === '') {
    return null;
  }

  const trimmed = raw.trim();

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const parsed = Date.parse(trimmed);

  return Number.isNaN(parsed) ? null : Math.max(0, parsed - Date.now());
}
