// ============================================================
//  operator.ts  -  o login de PESSOA na Fase 1.
//
//  Um operador, uma senha, sessão em memória. O login por Steam
//  com nível por servidor volta numa fase seguinte (ver
//  Docs\03-DECISOES.md, D5) — quando voltar, ele acrescenta um
//  jeito de provar quem você é, e não muda o resto.
//
//  ------------------------------------------------------------
//  ####  A SENHA NUNCA É GUARDADA  ####
//
//  O `.env` guarda `scrypt:<salt>:<hash>`, os dois em base64url.
//  Quem gera é `npm run panel:senha -w core`, que pergunta a
//  senha, imprime a linha e não escreve nada em disco.
//
//  scrypt e não SHA: o custo de memória é o que torna um ataque
//  de dicionário caro mesmo com o `.env` na mão de alguém.
//
//  ------------------------------------------------------------
//  ####  A SESSÃO VIVE EM MEMÓRIA, E ISSO É DELIBERADO  ####
//
//  Reiniciar o agente derruba as sessões. É aceitável: são
//  poucas, o `pm2 restart` é raro, e persistir sessão exigiria
//  uma tabela e um trabalho de limpeza para resolver um problema
//  que ninguém tem. Quem entra de novo entra em cinco segundos.
//
//  ####  A TENTATIVA ERRADA CUSTA TEMPO CRESCENTE  ####
//
//  Não há bloqueio permanente — trancar o único operador para
//  fora do painel é pior que o ataque que isso evita, ainda mais
//  com a API em 127.0.0.1. O que existe é atraso progressivo: a
//  décima tentativa espera segundos, e um ataque de dicionário
//  deixa de caber numa noite.
// ============================================================

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/** Custo do scrypt. 32 bytes de saída, parâmetros padrão do Node. */
const KEY_LENGTH = 32;

/** Quanto tempo uma sessão vale sem nenhuma requisição. */
export const IDLE_TIMEOUT_MS = 30 * 60_000;

/** O nome do cookie. `__Host-` exigiria HTTPS, e o agente fala HTTP puro. */
export const SESSION_COOKIE = 'rustagent_sid';

export interface OperatorSession {
  readonly id: string;
  readonly user: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  lastSeenAt: number;
}

/** `scrypt:<salt>:<hash>`, base64url nos dois. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;

  return `scrypt:${salt.toString('base64url')}:${derived.toString('base64url')}`;
}

/**
 * A senha confere?
 *
 * Comparação em tempo constante: comparar com `===` permitiria
 * descobrir o hash byte a byte medindo o tempo de resposta.
 * Formato inválido devolve `false` em vez de estourar — um `.env`
 * editado à mão não deve derrubar a rota de login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');

  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  try {
    const salt = Buffer.from(parts[1] ?? '', 'base64url');
    const expected = Buffer.from(parts[2] ?? '', 'base64url');
    const derived = (await scrypt(password, salt, expected.length)) as Buffer;

    return expected.length > 0 && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export interface OperatorAuthOptions {
  readonly user: string;
  readonly passwordHash: string;
  /** Teto absoluto da sessão. */
  readonly sessionTtlMs: number;
  /** Injetável para o teste não depender do relógio. */
  readonly now?: () => number;
}

/**
 * Quem entra, quem continua dentro, e quem sai.
 *
 * As rotas (`http/routes/auth.ts`) só traduzem HTTP; toda decisão
 * mora aqui.
 */
export class OperatorAuth {
  readonly #user: string;
  readonly #passwordHash: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, OperatorSession>();

  /** Quantas falhas seguidas — vira o atraso da próxima tentativa. */
  #failures = 0;

  constructor(options: OperatorAuthOptions) {
    this.#user = options.user;
    this.#passwordHash = options.passwordHash;
    this.#ttlMs = options.sessionTtlMs;
    this.#now = options.now ?? Date.now;
  }

  /** Sem hash configurado, o painel não deixa ninguém entrar. */
  get configured(): boolean {
    return this.#passwordHash !== '';
  }

  /**
   * Confere usuário e senha e abre a sessão.
   *
   * Devolve `null` para credencial errada — sem dizer QUAL das
   * duas errou. "Usuário não existe" é meia senha entregue.
   */
  async login(user: string, password: string): Promise<OperatorSession | null> {
    if (!this.configured) {
      return null;
    }

    await this.#throttle();

    // O scrypt roda mesmo com o usuário errado: sair antes faria
    // a resposta voltar rápido, e essa diferença de tempo diz que
    // aquele nome de usuário não é o certo.
    const passwordOk = await verifyPassword(password, this.#passwordHash);
    const userOk = user === this.#user;

    if (!passwordOk || !userOk) {
      this.#failures += 1;
      return null;
    }

    this.#failures = 0;

    const now = this.#now();
    const session: OperatorSession = {
      id: randomBytes(32).toString('base64url'),
      user: this.#user,
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
    };

    this.#sessions.set(session.id, session);

    return session;
  }

  /**
   * A sessão daquele cookie, se ainda vale.
   *
   * Toca em `lastSeenAt` — é o que faz a ociosidade contar do
   * último uso, e não do login.
   */
  touch(sessionId: string | undefined): OperatorSession | null {
    if (sessionId === undefined) {
      return null;
    }

    const session = this.#sessions.get(sessionId);

    if (session === undefined) {
      return null;
    }

    const now = this.#now();
    const expired =
      now - session.createdAt > this.#ttlMs || now - session.lastSeenAt > IDLE_TIMEOUT_MS;

    if (expired) {
      this.#sessions.delete(sessionId);
      return null;
    }

    session.lastSeenAt = now;

    return session;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId !== undefined) {
      this.#sessions.delete(sessionId);
    }
  }

  /** Só para o `/health` e para o teste. */
  get activeSessions(): number {
    return this.#sessions.size;
  }

  /**
   * Atraso progressivo: 0, 0, 0, 200 ms, 400 ms… até 5 s.
   *
   * Ele atrasa a RESPOSTA, e por isso não serializa nada — não é
   * um limite de tentativas simultâneas. Com o painel em
   * 127.0.0.1 isso basta: o que ele encarece é o dicionário
   * rodando a noite inteira.
   */
  async #throttle(): Promise<void> {
    if (this.#failures < 3) {
      return;
    }

    const delay = Math.min(5_000, 100 * 2 ** (this.#failures - 3));

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
