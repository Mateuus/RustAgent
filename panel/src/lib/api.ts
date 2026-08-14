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
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
  /** O jogo sobe com janela de console própria? */
  consoleWindow: boolean;
  map: string;
  worldSize: number;
  seed: number;
  maxPlayers: number;
  saveInterval: number;
  description: string;
  url: string;
  headerImage: string;
  steam: { appId: string; login: string; branch: string };
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

/**
 * Um plugin do acervo do agente.
 *
 * Os metadados vêm do `[Info(...)]` do próprio `.cs` — por isso são
 * anuláveis: nem todo plugin de uso interno declara autor e versão,
 * e a tela mostra travessão em vez de inventar.
 */
export interface LibraryPlugin {
  /** A chave. O NOME não é único entre biblioteca e customs. */
  id: number;
  /** `OrigemZPlayer` — é o que o `oxide.reload` recebe. */
  name: string;
  /** `OrigemZPlayer.cs`. */
  file: string;
  /** `null` = da biblioteca; um id = custom DAQUELE servidor. */
  serverId: string | null;
  title: string | null;
  author: string | null;
  version: string | null;
  description: string | null;
  bytes: number;
  sha256: string;
  /** `// Requires: X` — de quem ele não carrega sem. */
  requires: string[];
  /** `[PluginReference]` — de quem ele usa, mas sobrevive sem. */
  references: string[];
  addedAt: string;
  updatedAt: string;
  /** Os ids dos servidores em que ele está ATIVO. */
  servers: string[];
}

/** O mesmo plugin, visto de dentro de um servidor. */
export interface ServerPlugin extends LibraryPlugin {
  enabled: boolean;
  appliedSha: string | null;
  appliedAt: string | null;
  /** Ligado, mas com arquivo diferente do do acervo. */
  updateAvailable: boolean;
  /**
   * Um homônimo já ocupa o lugar dele naquele servidor.
   *
   * Os dois gravariam o mesmo `.cs` e o Oxide carrega um só, então
   * ligar o segundo é recusado. `null` = livre.
   */
  blockedBy: 'biblioteca' | 'custom' | null;
  /**
   * Dependências duras que NÃO estão ligadas neste servidor.
   *
   * Ligar assim mesmo funciona — o Oxide segura o plugin até elas
   * aparecerem. Mas a tela precisa dizer, senão é "liguei e não
   * aconteceu nada".
   */
  missingRequires: string[];
  /**
   * Quem, ligado aqui, depende deste plugin.
   *
   * `hard` sai do ar junto se este for tirado; `soft` continua no ar
   * sem a parte que usava este.
   */
  dependents: { hard: string[]; soft: string[] };
}

/**
 * A resposta dos dois uploads — biblioteca e custom.
 *
 * `pendingServers` é quem já usa o plugin e ficou na versão
 * anterior: enviar não aplica, de propósito.
 */
export interface PluginUploadResponse {
  ok: true;
  plugin: LibraryPlugin;
  pendingServers: string[];
  message: string;
}

/** Uma linha da sub-aba Plugins de Configurações. */
export interface PluginConfigSummary {
  /** `OrigemZVip` — o nome do arquivo, sem o `.json`. */
  plugin: string;
  file: string;
  bytes: number;
  modifiedAt: string;
  /** O `[Info]` do `.cs`, quando o plugin está no acervo. */
  title: string | null;
  /**
   * O plugin existe no acervo deste servidor?
   *
   * `false` é a config órfã: o `.json` de um plugin que saiu. Ela
   * aparece na lista de propósito — é a que alguém vai procurar para
   * recuperar horas de ajuste.
   */
  inStore: boolean;
  /** Ligado aqui? Só então gravar recarrega alguma coisa. */
  enabled: boolean;
}

export interface PluginConfigFile {
  plugin: string;
  file: string;
  bytes: number;
  modifiedAt: string;
  /** O JSON, como está em disco. */
  text: string;
}

/** O desfecho de gravar ou restaurar. */
export interface PluginConfigWriteResponse {
  ok: true;
  plugin: string;
  /** Como o arquivo ficou DEPOIS do reload. `null` = não existe. */
  config: PluginConfigFile | null;
  /** Onde foi parar a versão anterior. `null` = não havia arquivo. */
  backup: string | null;
  reload: { sent: boolean; output: string | null };
  message: string;
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

  /**
   * A configuração daquele servidor, campo a campo.
   *
   * Uma função só para o PATCH inteiro: um método por campo
   * multiplicaria a mesma chamada por vinte, e a tela de
   * configuração grava vários de uma vez.
   */
  patchServer: (id: string, patch: Record<string, unknown>) =>
    api<{ ok: true; server: ServerView; requiresRestart?: string[]; message?: string }>(
      `/api/servers/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: patch },
    ),

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

  // ---- a biblioteca (nível de rede) ------------------------

  plugins: () => api<{ ok: true; plugins: LibraryPlugin[] }>('/api/plugins'),

  uploadPlugin: (file: File) => {
    const form = new FormData();

    form.append('file', file);

    return api<PluginUploadResponse>('/api/plugins', { method: 'POST', form });
  },

  /**
   * Tira o plugin do acervo.
   *
   * Sem `force`, com servidores usando, o agente responde 409
   * dizendo QUAIS — é essa frase que a confirmação da tela mostra.
   */
  removePlugin: (pluginId: number, force = false) =>
    api<{ ok: true; name: string; removedFrom: string[]; message: string }>(
      `/api/plugins/${String(pluginId)}${force ? '?force=1' : ''}`,
      { method: 'DELETE' },
    ),

  // ---- o acervo daquele servidor ---------------------------

  serverPlugins: (id: string) =>
    api<{ ok: true; pluginsDir: string; plugins: ServerPlugin[] }>(
      `/api/servers/${encodeURIComponent(id)}/plugins`,
    ),

  /**
   * O `.cs` CUSTOM daquele servidor.
   *
   * Diferente de `uploadPlugin`: este não entra na biblioteca de
   * rede — nenhum outro servidor o enxerga.
   */
  uploadServerPlugin: (id: string, file: File) => {
    const form = new FormData();

    form.append('file', file);

    return api<PluginUploadResponse>(`/api/servers/${encodeURIComponent(id)}/plugins`, {
      method: 'POST',
      form,
    });
  },

  /**
   * Liga, desliga — e aplica a atualização.
   *
   * `true` num plugin já ligado recopia o arquivo do acervo e
   * recarrega: é assim que "há versão nova" vira "aplicada".
   *
   * Sem `force`, desligar um plugin do qual outros dependem responde
   * 409 dizendo quem cai junto — é essa frase que a confirmação da
   * tela mostra.
   */
  setServerPlugin: (id: string, pluginId: number, enabled: boolean, force = false) =>
    api<{
      ok: true;
      plugin: ServerPlugin;
      reload: { sent: boolean; output: string | null };
      message: string;
    }>(
      `/api/servers/${encodeURIComponent(id)}/plugins/${String(pluginId)}${force ? '?force=1' : ''}`,
      { method: 'PUT', body: { enabled } },
    ),

  reloadPlugin: (id: string, pluginId: number) =>
    api<{ ok: true; reload: { sent: boolean; output: string | null } }>(
      `/api/servers/${encodeURIComponent(id)}/plugins/${String(pluginId)}/reload`,
      { method: 'POST' },
    ),

  steamUpdate: (id: string) =>
    api<{ ok: true } & SteamUpdate>(`/api/servers/${encodeURIComponent(id)}/steam-update`),

  checkSteamUpdate: (id: string) =>
    api<{ ok: true } & SteamUpdate>(`/api/servers/${encodeURIComponent(id)}/steam-update/check`, {
      method: 'POST',
    }),
  // ---- a configuração de cada plugin -----------------------
  //
  // `oxide\config\<Nome>.json`, na sub-aba Plugins de Configurações.
  // A chave é o NOME do plugin, e não o id do acervo: o arquivo mora
  // do lado do jogo e sobrevive ao plugin — desligar não o apaga,
  // remover do acervo não o apaga.

  pluginConfigs: (id: string) =>
    api<{ ok: true; configDir: string; configs: PluginConfigSummary[] }>(
      `/api/servers/${encodeURIComponent(id)}/plugin-configs`,
    ),

  /** `config: null` = o plugin ainda não criou o arquivo. */
  pluginConfig: (id: string, plugin: string) =>
    api<{ ok: true; plugin: string; config: PluginConfigFile | null; message: string | null }>(
      `/api/servers/${encodeURIComponent(id)}/plugin-configs/${encodeURIComponent(plugin)}`,
    ),

  /**
   * Grava, recarrega o plugin e RELÊ o arquivo.
   *
   * O `config` da resposta é o que ficou em disco DEPOIS do reload —
   * vários plugins reescrevem a própria config ao carregar, e é esse
   * texto que a tela precisa mostrar.
   */
  savePluginConfig: (id: string, plugin: string, text: string) =>
    api<PluginConfigWriteResponse>(
      `/api/servers/${encodeURIComponent(id)}/plugin-configs/${encodeURIComponent(plugin)}`,
      { method: 'PUT', body: { text } },
    ),

  /** O "voltar ao padrão": apaga o arquivo e o plugin o recria. */
  resetPluginConfig: (id: string, plugin: string) =>
    api<PluginConfigWriteResponse>(
      `/api/servers/${encodeURIComponent(id)}/plugin-configs/${encodeURIComponent(plugin)}`,
      { method: 'DELETE' },
    ),
  /**
   * Liga o plugin E as dependências duras que faltam.
   *
   * Uma chamada só: a ordem — dependência primeiro — é regra do
   * agente. Fazer a tela chamar o PUT várias vezes poria essa regra
   * no navegador, que é onde ela não tem teste.
   */
  enableWithDeps: (id: string, pluginId: number) =>
    api<{
      ok: true;
      plugin: ServerPlugin;
      /** O que esta chamada ligou, na ordem. */
      enabled: string[];
      alreadyEnabled: string[];
      reloads: { plugin: string; sent: boolean; output: string | null }[];
      message: string;
    }>(
      `/api/servers/${encodeURIComponent(id)}/plugins/${String(pluginId)}/enable-with-deps`,
      { method: 'POST' },
    ),
};
