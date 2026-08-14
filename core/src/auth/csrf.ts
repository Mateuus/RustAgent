// ============================================================
//  csrf.ts  -  o token que o cookie obriga a existir.
//
//  ####  POR QUE ISTO NÃO EXISTIA ANTES  ####
//
//  Com bearer, CSRF não é um problema: o navegador não anexa
//  `Authorization` sozinho, então uma página de terceiro não
//  consegue fazer uma chamada autenticada em nome de ninguém.
//
//  O cookie inverte isso. A partir do momento em que a sessão
//  vive num cookie, QUALQUER página aberta no mesmo navegador
//  pode disparar `POST http://192.168.0.10:8080/api/operations`
//  e o navegador anexa o cookie por conta própria. Sem CSRF, um
//  link no Discord derruba o servidor de Rust.
//
//  `sameSite: 'lax'` já barra a maior parte disso, mas ele é uma
//  política do NAVEGADOR: vale no que está atualizado, não vale
//  em cliente antigo, e não é o tipo de coisa em que se apoia a
//  única tranca.
//
//  ------------------------------------------------------------
//  ####  DOUBLE SUBMIT, E O TOKEN É DERIVADO  ####
//
//  A sessão guarda um `csrf_secret`. O que sai para o painel é
//  um HMAC dele — nunca ele.
//
//  Duas consequências boas: o segredo do banco não circula, e
//  não existe uma segunda tabela de tokens de CSRF para expirar,
//  limpar e sincronizar com a sessão. O token vale exatamente
//  enquanto a sessão valer, porque ele é uma função dela.
//
//  A proteção não vem de o token ser imprevisível para quem tem
//  o cookie — vem de a página do atacante NÃO CONSEGUIR LÊ-LO: a
//  mesma origem que entrega o token é a que o navegador protege.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * O rótulo do HMAC.
 *
 * Existe para o dia em que o mesmo `csrf_secret` for usado para
 * derivar outra coisa: dois usos com rótulos diferentes não
 * produzem o mesmo valor, e um vazamento de um não vira o outro.
 */
const CSRF_LABEL = 'panel-csrf-v1';

/** O cabeçalho em que o painel manda o token. */
export const CSRF_HEADER = 'x-csrf-token';

/** O token que `GET /api/auth/session` entrega. */
export function csrfTokenFor(csrfSecret: string): string {
  return createHmac('sha256', csrfSecret).update(CSRF_LABEL).digest('hex');
}

/**
 * Confere o que veio no cabeçalho.
 *
 * A comparação é em tempo constante pelo mesmo motivo do token
 * de API (ver http/auth.ts): a comparação de strings do
 * JavaScript para no primeiro byte diferente, e isso é um
 * oráculo mensurável.
 */
export function csrfTokenMatches(csrfSecret: string, received: unknown): boolean {
  if (typeof received !== 'string' || received === '') {
    return false;
  }

  const expected = Buffer.from(csrfTokenFor(csrfSecret), 'utf8');
  const given = Buffer.from(received, 'utf8');

  // Tamanhos diferentes: `timingSafeEqual` lançaria, e o throw
  // seria um caminho rápido — ou seja, um oráculo de tamanho.
  if (expected.length !== given.length) {
    return false;
  }

  return timingSafeEqual(expected, given);
}

/**
 * O método muda estado?
 *
 * GET e HEAD não; OPTIONS também não (o preflight não carrega
 * cabeçalho de CSRF por definição). O resto exige.
 */
export function isMutation(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD' && upper !== 'OPTIONS';
}

/**
 * `http://192.168.0.10:8080/painel?x=1` -> `http://192.168.0.10:8080`.
 *
 * `null` quando não é URL absoluta — inclusive o `Origin: null`
 * que o navegador manda de um iframe sandbox ou de um `file://`,
 * que é exatamente o caso que NÃO deve passar.
 */
export function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * O `Origin` da requisição é aceitável?
 *
 * ####  DUAS ORIGENS VALEM, E ISSO NÃO AFROUXA NADA  ####
 *
 * A configurada (`PANEL_BASE_URL`) é a resposta óbvia. A do
 * PRÓPRIO `Host` da requisição entra junto porque, sem ela,
 * quem configurou `http://192.168.0.10:8080` e abre o painel por
 * `http://localhost:8080` — a coisa mais normal do mundo na
 * máquina do servidor — teria toda mutação recusada.
 *
 * Aceitar o próprio Host é a checagem clássica de mesma origem, e
 * ela só é segura porque o cabeçalho `Host` JÁ passou pelo
 * guarda de rebinding (ver http/network-guard.ts): um
 * `evil.com` apontado para 127.0.0.1 é recusado com 403 antes de
 * chegar aqui, então não existe caminho em que Origin e Host
 * combinem sendo os dois do atacante.
 *
 * `Origin` ausente passa: clientes não-navegador (curl, um
 * script) não mandam o cabeçalho, e para eles a defesa é o token
 * de CSRF, que continua sendo exigido.
 */
export function isOriginAcceptable(
  origin: string | undefined,
  panelBaseUrl: string,
  hostHeader: string | undefined,
): boolean {
  if (origin === undefined || origin === '') {
    return true;
  }

  const received = originOf(origin);
  if (received === null) {
    return false;
  }

  if (received === originOf(panelBaseUrl)) {
    return true;
  }

  if (hostHeader === undefined || hostHeader === '') {
    return false;
  }

  // O esquema não entra na comparação com o Host: o agente fala
  // HTTP puro hoje e pode estar atrás de um proxy TLS amanhã, e
  // nos dois casos o `Host` chega igual. O que importa aqui é o
  // AUTORIDADE (nome + porta) ser a mesma que o navegador usou.
  return received.replace(/^https?:\/\//, '') === hostHeader.trim().toLowerCase();
}
