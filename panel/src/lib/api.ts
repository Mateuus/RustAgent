// ============================================================
//  api.ts  -  a única porta de saída do painel.
//
//  O painel é EXPORT ESTÁTICO: não há servidor Next, e toda
//  chamada sai do NAVEGADOR direto para o agente. Em produção os
//  dois moram na mesma origem (o core serve `panel/out`), então a
//  base é vazia; em desenvolvimento o painel roda em :3100 e
//  precisa apontar para :8787.
//
//  ####  O CSRF NÃO É OPCIONAL  ####
//
//  A sessão é um cookie `HttpOnly` — o JavaScript não o lê, e o
//  navegador o manda sozinho. É justamente isso que permite a um
//  site qualquer forjar uma requisição para o agente. O que
//  impede é o header `X-CSRF-Token`, que só quem leu a resposta
//  do login conhece.
// ============================================================

/** Vazio em produção (mesma origem). `NEXT_PUBLIC_AGENT_URL` no dev. */
const BASE = process.env.NEXT_PUBLIC_AGENT_URL ?? '';

/** O token da sessão atual. Guardado em memória, nunca em disco. */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/**
 * Erro vindo do agente, com o código de contrato junto.
 *
 * A `message` é a frase do CORE, em português — a tela mostra ela
 * inteira. Reescrever aqui produziria duas explicações para o
 * mesmo problema, e a nossa seria a que não conhece a regra.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Upload de plugin: o corpo vai como está, sem JSON. */
  readonly form?: FormData;
  readonly signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (csrfToken !== null && method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    // O cookie da sessão só viaja com isto.
    credentials: 'include',
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal,
  });

  const text = await response.text();
  const payload: unknown = text === '' ? {} : JSON.parse(text);

  if (!response.ok) {
    const body = payload as { error?: string; message?: string };

    throw new ApiError(
      body.error ?? 'UNKNOWN',
      body.message ?? `O agente respondeu ${String(response.status)}.`,
      response.status,
    );
  }

  return payload as T;
}

// ------------------------------------------------------------
//  Os tipos que a tela usa. Espelham Docs\06-API.md.
// ------------------------------------------------------------

export interface ServerView {
  id: string;
  name: string;
  identity: string;
  hostname: string;
  enabled: boolean;
  installed: boolean;
  /** O processo está no ar? `null` = ainda não varremos. */
  running: boolean | null;
  pid: number | null;
  map: string;
  worldSize: number;
  seed: number;
  maxPlayers: number;
  ports: { game: number; rcon: number; query: number; app: number };
  rcon: { connected: boolean; state: string } | null;
  paths: { installDir: string; configPath: string; logsDir: string };
}

export interface PortBlock {
  index: number;
  gamePort: number;
  rconPort: number;
  queryPort: number;
  appPort: number;
}

export type OperationKind =
  | 'server-install'
  | 'server-update'
  | 'server-start'
  | 'server-stop'
  | 'server-restart'
  | 'server-auto-update'
  | 'oxide-install';

export interface OperationView {
  id: string;
  kind: OperationKind;
  serverId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number | null;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

export interface OperationDetail extends OperationView {
  lines: { n: number; at: string; text: string }[];
  nextLine: number;
  droppedLines: number;
}

export interface PluginInfo {
  name: string;
  plugin: string;
  bytes: number;
  modifiedAt: string;
}

export interface SteamUpdate {
  appId: string;
  branch: string;
  installed: string | null;
  published: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  lastError: string | null;
  autoUpdate: boolean;
  attempts: number;
}

/** O retrato da máquina e do agente. Ver `core/src/http/routes/system.ts`. */
export interface SystemInfo {
  machine: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    cpu: { model: string | null; cores: number; speedMhz: number | null };
    /** `null` no Windows — lá o loadavg é sempre zero. */
    load1: number | null;
    memory: { total: number; free: number };
    disk: { total: number; free: number } | null;
    uptimeSeconds: number;
  };
  agent: {
    version: string;
    startedAt: string;
    uptimeSeconds: number;
    pid: number;
    node: string;
    rssBytes: number;
    paths: { root: string; servers: string; steamCmd: string; logs: string };
  };
  servers: {
    total: number;
    installed: number;
    enabled: number;
    online: number;
    maxPlayers: number;
  };
}

/**
 * O que a tela chama, com nome de verbo.
 *
 * Concentrado aqui para a página não montar caminho na mão: um
 * `/api/servers/${id}` escrito em cinco lugares é o que fica para
 * trás no dia em que a rota mudar.
 */
export const agent = {
  login: (user: string, password: string) =>
    api<{ ok: true; user: string; csrfToken: string }>('/auth/login', {
      method: 'POST',
      body: { user, password },
    }),

  logout: () => api<{ ok: true }>('/auth/logout', { method: 'POST' }),

  session: () => api<{ ok: true; user: string; csrfToken: string }>('/auth/session'),

  system: () => api<{ ok: true } & SystemInfo>('/api/system'),

  servers: () =>
    api<{ ok: true; servers: ServerView[]; suggestedPortBlock: PortBlock | null }>('/api/servers'),

  server: (id: string) =>
    api<{ ok: true; server: ServerView; kinds: OperationKind[] }>(
      `/api/servers/${encodeURIComponent(id)}`,
    ),

  createServer: (input: Record<string, unknown>) =>
    api<{ ok: true; server: ServerView; message: string }>('/api/servers', {
      method: 'POST',
      body: input,
    }),

  setEnabled: (id: string, enabled: boolean) =>
    api<{ ok: true; server: ServerView }>(`/api/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { enabled },
    }),

  operations: (id: string) =>
    api<{ ok: true; kinds: OperationKind[]; operations: OperationView[] }>(
      `/api/servers/${encodeURIComponent(id)}/operations`,
    ),

  startOperation: (id: string, kind: OperationKind, extra: Record<string, unknown> = {}) =>
    api<{ ok: true; operationId: string }>(`/api/servers/${encodeURIComponent(id)}/operations`, {
      method: 'POST',
      body: { kind, ...extra },
    }),

  operation: (opId: string, fromLine: number) =>
    api<{ ok: true; operation: OperationDetail }>(
      `/api/operations/${encodeURIComponent(opId)}?fromLine=${String(fromLine)}`,
    ),

  cancelOperation: (opId: string) =>
    api<{ ok: true }>(`/api/operations/${encodeURIComponent(opId)}/cancel`, { method: 'POST' }),

  console: (id: string, fromLine: number) =>
    api<{
      ok: true;
      connected: boolean;
      state?: string;
      lines: { n: number; at: string; text: string; type: string }[];
      nextLine: number;
      droppedLines: number;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/console?fromLine=${String(fromLine)}`),

  consoleFile: (id: string, lines = 200) =>
    api<{ ok: true; path: string; lines: string[]; message?: string }>(
      `/api/servers/${encodeURIComponent(id)}/console/file?lines=${String(lines)}`,
    ),

  rcon: (id: string, command: string) =>
    api<{ ok: true; command: string; response: string }>(
      `/api/servers/${encodeURIComponent(id)}/rcon`,
      { method: 'POST', body: { command } },
    ),

  plugins: (id: string) =>
    api<{ ok: true; pluginsDir: string; plugins: PluginInfo[] }>(
      `/api/servers/${encodeURIComponent(id)}/plugins`,
    ),

  uploadPlugin: (id: string, file: File) => {
    const form = new FormData();

    form.append('file', file);

    return api<{ ok: true; name: string; message: string; reload: { output: string | null } }>(
      `/api/servers/${encodeURIComponent(id)}/plugins`,
      { method: 'POST', form },
    );
  },

  removePlugin: (id: string, name: string) =>
    api<{ ok: true }>(`/api/servers/${encodeURIComponent(id)}/plugins/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  reloadPlugin: (id: string, name: string) =>
    api<{ ok: true; reload: { output: string | null } }>(
      `/api/servers/${encodeURIComponent(id)}/plugins/${encodeURIComponent(name)}/reload`,
      { method: 'POST' },
    ),

  steamUpdate: (id: string) =>
    api<{ ok: true } & SteamUpdate>(`/api/servers/${encodeURIComponent(id)}/steam-update`),

  checkSteamUpdate: (id: string) =>
    api<{ ok: true } & SteamUpdate>(`/api/servers/${encodeURIComponent(id)}/steam-update/check`, {
      method: 'POST',
    }),
};
