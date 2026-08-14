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

/**
 * O endereço completo de um caminho do agente.
 *
 * Existe para o que NÃO passa por `api()`: a imagem do mapa é
 * baixada como binário, e precisa do mesmo prefixo que as chamadas
 * de JSON usam — vazio em produção, `NEXT_PUBLIC_AGENT_URL` no
 * desenvolvimento.
 */
export function agentUrl(path: string): string {
  return `${BASE}${path}`;
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
  /**
   * Quem, na BIBLIOTECA, depende deste.
   *
   * Na tela de rede a pergunta é sobre o acervo inteiro: remover
   * daqui remove de todos os servidores de uma vez. Dentro de um
   * servidor, o mesmo campo fala só de quem está ligado ali.
   */
  dependents: PluginDependents;
}

/** O mesmo plugin, visto de dentro de um servidor. */
/**
 * Quem depende de um plugin.
 *
 * `hard` (`// Requires:`) sai do ar junto; `soft`
 * (`[PluginReference]`) continua no ar sem a parte que usava o
 * outro — que é pior de descobrir, porque nada aparece no log.
 */
export interface PluginDependents {
  hard: string[];
  soft: string[];
}

/** O desfecho do último `oxide.reload` daquele plugin, ali. */
export interface LastReload {
  at: string;
  /**
   * Erro de COMPILAÇÃO — o plugin está no servidor e não roda.
   *
   * O agente decide isto pelo texto que o Oxide respondeu; o que ele
   * não reconhece vira `false`, porque alarme falso na linha faria
   * ninguém acreditar no verdadeiro.
   */
  failed: boolean;
  output: string | null;
}

export interface ServerPlugin extends LibraryPlugin {
  /** `null` = nenhum reload desde que o agente subiu. */
  lastReload: LastReload | null;
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

// ------------------------------------------------------------
//  Administração e banimentos
// ------------------------------------------------------------

/**
 * Um jogador conectado, venha ele do plugin ou do `playerlist`.
 *
 * Quase tudo é anulável porque as duas fontes não dão as mesmas
 * coisas: sem o `OrigemZAgent`, `position`, `isAlive` e
 * `isSleeping` vêm `null`. Ausente vira travessão, nunca zero — um
 * "morto" inventado é pior que um campo vazio.
 */
export interface GamePlayer {
  steamId: string;
  name: string;
  health: number | null;
  isAlive: boolean | null;
  isSleeping: boolean | null;
  ping: number | null;
  connectedSeconds: number | null;
  position: { x: number; y: number; z: number } | null;
  /**
   * A célula do mapa: `G12`.
   *
   * Calculada pelo AGENTE, e não aqui: a constante da grade tem um
   * dono só. `null` sem posição — ou seja, sempre que a fonte for o
   * `playerlist` nativo.
   */
  grid: string | null;
}

/**
 * O mundo daquele servidor, e a grade dele.
 *
 * Vem do agente porque o Map View precisa dos dois para desenhar: a
 * projeção depende do `size`, e as letras/números das células do
 * `cellSize`.
 */
export interface WorldGrid {
  size: number;
  cellSize: number;
  cols: number;
  rows: number;
}

export interface PlayersSnapshot {
  /** De onde veio esta lista. A tela diz isso em voz alta. */
  source: 'plugin' | 'nativo';
  total: number;
  players: GamePlayer[];
  /**
   * O plugin que daria a posição, e o estado dele aqui.
   *
   * `id` nulo = ele não está no acervo deste servidor, e aí o
   * caminho é a aba Plugins. Com id e desligado, a tela oferece
   * ligar sem sair daqui.
   */
  plugin: { name: string; id: number | null; enabled: boolean };
  /** Os campos que a fonte atual não fornece. */
  missing: string[];
  /** O tamanho do mundo e a grade — o que o Map View desenha. */
  world: WorldGrid;
}

/**
 * Uma mensagem do histórico de chat do SERVIDOR.
 *
 * Não é um buffer do agente: vem do `chat.tail`, que o jogo mantém
 * e que sobrevive ao reinício do agente. É também o único lugar
 * onde a mensagem existe quando há um plugin de chat formatando —
 * ele cancela a original, e com ela some o frame de chat do RCON.
 */
export interface ChatLine {
  at: string;
  steamId: string | null;
  name: string;
  /** `[VIP OURO]`, `[ADMIN]` — a tag do grupo. `null` = sem tag. */
  tag: string | null;
  text: string;
  channel: 'global' | 'equipe' | 'servidor' | 'cartas' | 'local' | null;
  /** A cor do nome naquele grupo, já conferida pelo agente. */
  color: string | null;
}

export type AdminLevel = 'owner' | 'moderator';

export interface AdminEntry {
  steamId: string;
  level: AdminLevel;
  name: string | null;
  note: string | null;
}

export type BanScope = 'network' | 'servers';

/**
 * Um banimento da lista do agente.
 *
 * `steamId` é STRING — e é assim que ele atravessa a tela inteira.
 * Em número, um SteamID64 passa de 2^53 e perde precisão: o ban
 * iria para a conta errada.
 */
export interface Ban {
  id: number;
  steamId: string;
  name: string | null;
  reason: string;
  scope: BanScope;
  /** Vazio num `network` — ali ele quer dizer "todos". */
  servers: string[];
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  origin: 'panel' | 'adopted';
  active: boolean;
  /** Passou da data e o relógio ainda não o soltou. */
  expired: boolean;
}

/** O mesmo ban, visto de dentro de um servidor. */
export interface ServerBan extends Ban {
  source: 'rede' | 'especifico' | 'adotado';
}

export interface BanSyncResult {
  serverId: string;
  applied: string[];
  removed: string[];
  adopted: string[];
  extended: string[];
  /** Preenchido = a rodada não aconteceu, e este é o motivo. */
  skipped: string | null;
  message: string;
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

  // ---- Administração: jogadores, chat e admins -------------
  //
  // A escolha da FONTE de `players` não é da tela: o agente sabe se
  // o OrigemZAgent está ligado naquele servidor e usa o que há. O
  // que vem na resposta é qual fonte foi usada e o que falta nela.

  players: (id: string) =>
    api<{ ok: true } & PlayersSnapshot>(`/api/servers/${encodeURIComponent(id)}/players`),

  kickPlayer: (id: string, steamId: string, reason?: string) =>
    api<{ ok: true; steamId: string; output: string; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/players/${encodeURIComponent(steamId)}/kick`,
      { method: 'POST', body: reason === undefined ? {} : { reason } },
    ),

  /**
   * As últimas mensagens do histórico do servidor.
   *
   * Sem cursor de propósito: a lista é uma JANELA das últimas N, e
   * é substituída inteira a cada leitura. Um cursor incremental
   * pressuporia que o agente é dono do histórico — e ele não é: o
   * dono é o jogo, que guarda as mensagens de antes de o agente
   * subir.
   */
  chat: (id: string, limit = 100) =>
    api<{
      ok: true;
      connected: boolean;
      lines: ChatLine[];
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/chat?limit=${String(limit)}`),

  say: (id: string, message: string) =>
    api<{ ok: true; message: string }>(`/api/servers/${encodeURIComponent(id)}/chat`, {
      method: 'POST',
      body: { message },
    }),

  /**
   * A imagem do mapa daquele mundo.
   *
   * Ela é desenhada pelo próprio jogo, UMA vez por wipe: o agente
   * pede o render sozinho quando o RCON conecta e não há arquivo
   * para aquele tamanho+seed. `available: false` é o estado normal
   * de um mundo recém-criado enquanto o desenho não termina.
   */
  mapImage: (id: string) =>
    api<{
      ok: true;
      available: boolean;
      path: string;
      bytes: number | null;
      generatedAt: string | null;
      worldSize: number;
      seed: number;
      /** O lado do PNG, em pixels. */
      pixels: number | null;
      /**
       * Quantas unidades do mundo a imagem cobre.
       *
       * MAIOR que o `worldSize`: o jogo desenha uma faixa de oceano
       * em volta (4000 rende 5000). Projetar sobre o worldSize põe
       * quem está na costa no meio do mar.
       */
      coverage: number | null;
      /** O caminho DA ROTA, não o do disco. `null` sem imagem. */
      url: string | null;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/map`),

  /** Força o render. O automático já cobre o caso normal. */
  renderMap: (id: string) =>
    api<{ ok: true; path: string; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/map/render`,
      { method: 'POST' },
    ),

  admins: (id: string) =>
    api<{
      ok: true;
      admins: AdminEntry[];
      source: 'servidor' | 'ausente';
      path: string;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/admins`),

  /** Promove. Vale na hora, com o jogador dentro do jogo inclusive. */
  grantAdmin: (id: string, input: { steamId: string; name?: string; level: AdminLevel }) =>
    api<{ ok: true; output: string; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/admins`,
      { method: 'POST', body: input },
    ),

  /**
   * Rebaixa.
   *
   * O `level` não é opcional de verdade: `removeowner` não tira um
   * moderador, e mandar o errado não dá erro — não faz nada.
   */
  revokeAdmin: (id: string, steamId: string, level: AdminLevel) =>
    api<{ ok: true; output: string; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/admins/${encodeURIComponent(steamId)}?level=${level}`,
      { method: 'DELETE' },
    ),

  // ---- A BanList global ------------------------------------

  bans: (options: { active?: boolean; query?: string } = {}) => {
    const params = new URLSearchParams();

    if (options.active === true) {
      params.set('active', '1');
    }

    if (options.query !== undefined && options.query.trim() !== '') {
      params.set('q', options.query.trim());
    }

    const query = params.toString();

    return api<{ ok: true; bans: Ban[]; servers: string[] }>(
      `/api/bans${query === '' ? '' : `?${query}`}`,
    );
  },

  createBan: (input: {
    steamId: string;
    name?: string;
    reason: string;
    scope: BanScope;
    servers?: string[];
    /** ISO-8601. Ausente = permanente. */
    expiresAt?: string | null;
  }) =>
    api<{ ok: true; ban: Ban; applied: string[]; pending: string[]; message: string }>('/api/bans', {
      method: 'POST',
      body: input,
    }),

  /** Revoga. A linha continua no histórico, com quem revogou. */
  revokeBan: (steamId: string) =>
    api<{ ok: true; ban: Ban; removed: string[]; pending: string[]; message: string }>(
      `/api/bans/${encodeURIComponent(steamId)}`,
      { method: 'DELETE' },
    ),

  serverBans: (id: string) =>
    api<{ ok: true; bans: ServerBan[]; connected: boolean }>(
      `/api/servers/${encodeURIComponent(id)}/bans`,
    ),

  syncServerBans: (id: string) =>
    api<{ ok: true } & BanSyncResult>(`/api/servers/${encodeURIComponent(id)}/bans/sync`, {
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
  /**
   * Deixa este servidor com os mesmos plugins de outro.
   *
   * O "conjunto" é um servidor que já funciona: uma lista salva no
   * banco envelheceria sozinha, e o servidor novo nasceria faltando
   * o plugin que entrou depois. A configuração de cada um NÃO vem
   * junto — ela é daquele servidor.
   */
  copyPluginsFrom: (id: string, from: string) =>
    api<{
      ok: true;
      from: string;
      enabled: string[];
      alreadyEnabled: string[];
      /** O que não deu para trazer, com o motivo de cada um. */
      skipped: { plugin: string; reason: string }[];
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/plugins/copy-from`, {
      method: 'POST',
      body: { from },
    }),

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
