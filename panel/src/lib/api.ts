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

/** Como terminou a última atualização que o agente disparou sozinho. */
export interface AutoUpdateAttempt {
  operationId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** O motivo, quando falhou. */
  message: string | null;
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
  maxAttempts: number;
  lastAttempt: AutoUpdateAttempt | null;
  nextAttemptAt: string | null;
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

/**
 * Um monumento do mundo.
 *
 * Sem `y`: altura não entra num mapa 2D. Eles são a referência fixa
 * do mapa — foi com o Harbor, que fica na costa, que a escala da
 * imagem foi conferida.
 */
export interface MapMonument {
  type: string;
  name: string;
  x: number;
  z: number;
  grid: string | null;
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

// ------------------------------------------------------------
//  O Oxide daquele servidor
//
//  Grupo é o que dá poder no Rust modado: um VIP é um jogador
//  dentro de `origemz.vip.gold`, que herda de `silver`, que herda
//  de `bronze`. Tudo isto vive DENTRO do servidor (protobuf que o
//  próprio Oxide reescreve), então a fonte é o console — e é por
//  isso que a tela precisa do servidor no ar para mudar qualquer
//  coisa.
// ------------------------------------------------------------

export interface OxideMember {
  steamId: string;
  /** O nome de quando o Oxide o viu. `null` = ele não trouxe. */
  name: string | null;
}

export interface OxideGroup {
  name: string;
  members: OxideMember[];
  /** O que foi concedido DIRETAMENTE a ele. */
  permissions: string[];
  /** A cadeia de pais, do mais próximo ao mais distante. */
  parents: string[];
  /** O que ele ganha de cada pai. */
  inherited: { group: string; permissions: string[] }[];
}

/** Um plugin que o Oxide diz estar rodando AGORA. */
export interface OxideLoadedPlugin {
  name: string;
  version: string | null;
  author: string | null;
  file: string | null;
}

export interface OxideFrameworkConfig {
  path: string;
  /** `null` = o arquivo ainda não existe (o servidor nunca subiu). */
  text: string | null;
  modifiedAt: string | null;
}

// ------------------------------------------------------------
//  Os jogadores da REDE
//
//  Não confundir com `GamePlayer`, acima: aquele é quem está
//  conectado AGORA naquele servidor, lido do RCON; estes vêm da
//  base do agente e sobrevivem ao wipe e ao reinício.
//
//  `steamId` é STRING em toda parte — em número, um SteamID64
//  passa de 2^53 e a ficha vira de outra pessoa.
// ------------------------------------------------------------

/** Uma linha da tela de rede. */
export interface NetworkPlayer {
  steamId: string;
  name: string;
  /** Na REDE, e nunca muda: é o "jogador desde". */
  firstSeen: string;
  lastSeen: string;
  online: boolean;
  /** Onde ele está AGORA. Vazio quando está offline. */
  onlineOn: string[];
  /** O último servidor em que foi visto. `null` = nenhum. */
  lastServerId: string | null;
  /** Está banido agora? Vem da BanList, e não de uma cópia. */
  banned: boolean;
}

/** O que ele fez em UM servidor. */
export interface PlayerServer {
  serverId: string;
  firstSeen: string;
  lastSeen: string;
  online: boolean;
  joinedAt: string | null;
  leftAt: string | null;
  /** Por que a última sessão fechou. `null` = o jogo não disse. */
  leaveReason: string | null;
  sessions: number;
  /** Somado no fechamento de cada sessão. */
  playedSeconds: number;
}

export interface PlayerIdentity {
  steamId: string;
  name: string;
  /** `null` = o agente nunca o viu jogar. Ver `known`. */
  firstSeen: string | null;
  lastSeen: string | null;
  lastIp: string | null;
  online: boolean;
  /**
   * O agente já o viu jogar?
   *
   * `false` é a ficha de quem existe só na lista de banidos — e ela
   * é justamente a que se procura depois de banir um SteamID que
   * nunca entrou.
   */
  known: boolean;
}

export type PlayerEventKind =
  | 'join'
  | 'leave'
  | 'kick'
  | 'teleport'
  | 'ban'
  | 'unban'
  // Os dois entraram com a migração 014: ganhar VIP e resgatar kit
  // são acontecimentos, e a ficha mostra UMA linha do tempo.
  | 'vip'
  | 'kit';

export interface PlayerEvent {
  at: string;
  kind: PlayerEventKind;
  /** `null` num ban de rede: ele não é de servidor nenhum. */
  serverId: string | null;
  actor: string | null;
  detail: string | null;
}

/**
 * A estrutura do que ainda NÃO é medido.
 *
 * Kill e morte não existem hoje — nem no RCON nem no plugin. O
 * agente manda o exemplo num campo separado, com `measured: false`
 * e a frase que explica: a tela desenha isso rotulado, e nunca
 * junto dos eventos de verdade.
 */
export interface PlayerEventSample {
  measured: false;
  label: string;
  note: string;
  events: { at: string; kind: 'kill' | 'death'; serverId: string; detail: string }[];
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

// ------------------------------------------------------------
//  O VIP, os loadouts e a loja
//
//  Ver Docs\15-BRIEFING-VIP-LOADOUTS-KITS.md. Três assuntos com o
//  mesmo caminho até o jogo: o agente é a fonte, e o plugin recebe
//  o estado COMPLETO a cada mudança.
//
//  `steamId` e `skinId` são STRING em toda parte — os dois passam
//  de 2^53 e voltariam arredondados de um `number`. Dinheiro é
//  inteiro em CENTAVOS, pelo mesmo motivo ao contrário: float é o
//  erro que aparece no extrato.
// ------------------------------------------------------------

export type VipOrigin = 'loja' | 'painel' | 'adotado';

/** Uma concessão de VIP. Ela é da REDE, não de um servidor. */
export interface Vip {
  id: number;
  steamId: string;
  /** `bronze` | `silver` | `gold` — o Tier do OrigemZVip.json. */
  tier: string;
  /** ISO-8601. `null` = vitalício. */
  expiresAt: string | null;
  origin: VipOrigin;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  /** `null` COM `revokedAt` preenchido = foi o relógio. */
  revokedBy: string | null;
  /** Vale AGORA: não revogado e não vencido. */
  active: boolean;
  /** Passou da data e o relógio ainda não o revogou. */
  expired: boolean;
  /** `null` = o agente nunca viu este jogador. */
  playerName?: string | null;
}

/**
 * Um nível de VIP, como o servidor o declara.
 *
 * Vem do `OrigemZVip.json` de cada servidor — nunca de uma lista
 * do painel. É o que permite oferecer um seletor em vez de um
 * campo de texto: digitar um nível que não existe é o jeito mais
 * rápido de vender um VIP que não vira efeito nenhum.
 */
export interface VipTier {
  tier: string;
  group: string;
  title: string | null;
  rank: number | null;
  parentGroup: string | null;
  /** Em quais servidores este nível existe. */
  servers: string[];
}

/** O que uma sincronização fez naquele servidor. */
export interface VipSyncResult {
  serverId: string;
  players: number;
  added: string[];
  removed: string[];
  adopted: string[];
  /** Preenchido = a rodada não aconteceu, e este é o motivo. */
  skipped: string | null;
}

/** Os contêineres do jogador. Ver core/src/loadouts/items.ts. */
export type LoadoutSlot = 'wear' | 'belt' | 'main';

export interface LoadoutItem {
  slot: LoadoutSlot;
  shortname: string;
  amount: number;
  /** String, sempre: skin do workshop passa de 2^53. */
  skinId: string;
  position: number;
}

/**
 * Um grupo daquele servidor, com o loadout dele.
 *
 * A lista é DERIVADA dos grupos do Oxide: grupo novo aparece
 * vazio, e um loadout cujo grupo sumiu aparece com `exists: false`
 * — órfão, em vez de apagado sozinho.
 *
 * `exists: null` = o servidor está fora do ar e ninguém pôde
 * perguntar. É diferente de "o grupo não existe".
 */
export interface ServerLoadout {
  name: string;
  exists: boolean | null;
  members: number | null;
  items: LoadoutItem[];
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface LoadoutSyncResult {
  serverId: string;
  tiers: number;
  items: number;
  cachedTiers: number;
  cachedItems: number;
  skipped: string | null;
}

/**
 * Em que ESTADO o jogador daquele grupo acorda.
 *
 * Mesma lista de grupos do loadout, e as mesmas regras de órfão e
 * de servidor fora do ar — ver `ServerLoadout`.
 *
 * `null` num atributo é resposta, e não ausência: quer dizer "o
 * jogo decide este". É diferente de 0, que para fome e sede é
 * nascer morrendo.
 */
export interface ServerSpawnStatus {
  name: string;
  exists: boolean | null;
  members: number | null;
  health: number | null;
  calories: number | null;
  hydration: number | null;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SpawnStatusSyncResult {
  serverId: string;
  tiers: number;
  cachedTiers: number;
  skipped: string | null;
}

/** O que o formulário grava. Ver core/src/loadouts/status.ts. */
export interface SpawnStatusInput {
  health: number | null;
  calories: number | null;
  hydration: number | null;
  enabled: boolean;
}

export type KitKind = 'compra' | 'resgate' | 'cooldown';

export interface Kit {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  /** A aba em que ele aparece no menu do jogo. `null` = sem aba. */
  category: string | null;
  kind: KitKind;
  /** Em CENTAVOS. `null` fora de `compra`. */
  priceCents: number | null;
  /** Em SEGUNDOS. `null` fora de `cooldown`. */
  cooldownSeconds: number | null;
  /**
   * Só libera este tanto de segundos DEPOIS do wipe.
   *
   * `null` = sem bloqueio. Quem sabe a hora do wipe é o servidor
   * (`SaveCreatedTime` do `serverinfo`).
   */
  wipeDelaySeconds: number | null;
  /** `null` = qualquer um. */
  requiredTier: string | null;
  items: LoadoutItem[];
  enabled: boolean;
  /** Em quais servidores ele é oferecido. */
  servers: string[];
  /** Quantas entregas deram certo. As que falharam não contam. */
  claimCount: number;
  createdAt: string;
  updatedAt: string;
}

/** O mesmo kit, do ponto de vista de um jogador. */
export interface KitOffer extends Kit {
  available: boolean;
  /** Por que não. `null` quando pode. */
  reason: string | null;
  /** Quando ele poderá de novo, num kit de cooldown. */
  nextAt: string | null;
  /** A última vez que ELE pegou. `null` = nunca. */
  lastClaimedAt: string | null;
  /** Quantas vezes ELE pegou — diferente de `claimCount`, da rede. */
  myClaims: number;
}

export interface KitClaim {
  id: number;
  steamId: string;
  playerName: string | null;
  serverId: string;
  claimedAt: string;
  status: 'entregue' | 'falhou';
  detail: string | null;
}

// ------------------------------------------------------------
//  A LOJA
//
//  ####  ELA NÃO É A LISTA DE KITS  ####
//
//  Um kit é entrega com REGRA (uma vez por jogador, de N em N
//  horas); uma oferta é entrega com PREÇO. Só a segunda move
//  dinheiro — e é por isso que ela tem carteira, estorno e extrato,
//  e o kit não.
// ------------------------------------------------------------

export interface StoreCategory {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * O formato da oferta. A diferença não é cosmética:
 *
 *   item     um item do jogo, com quantidade por compra
 *   bundle   um kit: vários itens, e o modal LISTA o que vem dentro
 *   vip      um nível com prazo, mais as vantagens em texto
 *   vehicle  um veículo que nasce no mundo
 */
export type OfferKind = 'item' | 'bundle' | 'vip' | 'vehicle';

/** A etiqueta no canto do card, no jogo. Cada uma tem cor própria. */
export type OfferBadge = 'promo' | 'novo' | 'destaque';

export interface OfferItem {
  shortname: string;
  itemId: number;
  /** String: id de workshop passa de 2^53. `'0'` = sem skin. */
  skinId: string;
  amount: number;
}

export interface StoreOffer {
  id: string;
  categoryId: string;
  kind: OfferKind;
  name: string;
  /** Em OZCoin INTEIRO. A moeda não tem centavo. */
  price: number;
  /** O preço riscado ao lado. `null` = sem promoção. */
  oldPrice: number | null;
  position: number;
  enabled: boolean;
  badge: OfferBadge | null;
  /** O desenho da oferta. De campo próprio: um kit não tem "o item". */
  icon: { shortname: string; itemId: number; skinId: string };
  items: OfferItem[];
  /** As vantagens listadas, só em `vip`. */
  perks: string[];
  /** `null` fora de `vip`. `days: null` = vitalício. */
  vip: { tier: string; days: number | null } | null;
  /** `null` fora de `vehicle`. */
  vehicle: { prefab: string; fuel: number } | null;
  createdAt: string;
  updatedAt: string;
}

/** O que a tela de criação manda. Sem id nem datas. */
export type StoreOfferInput = Omit<StoreOffer, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Em que estado a compra parou.
 *
 *   pending    nasceu; nada foi movido
 *   debited    o dinheiro saiu
 *   delivered  o item chegou. Fim feliz.
 *   refunded   a entrega falhou e o valor voltou
 *   failed     debitou, não entregou E não estornou — precisa de gente
 */
export type PurchaseState = 'pending' | 'debited' | 'delivered' | 'refunded' | 'failed';

export interface StorePurchase {
  id: string;
  serverId: string;
  steamId: string;
  offerId: string;
  /** Uma CÓPIA do que a oferta era: ela pode ter mudado depois. */
  offerName: string;
  shortname: string;
  skinId: string;
  amount: number;
  unitPrice: number;
  totalPrice: number;
  state: PurchaseState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Uma linha do extrato. `amount` negativo é débito. */
export interface WalletEntry {
  id: number;
  amount: number;
  /** O saldo DEPOIS deste lançamento. */
  balance: number;
  reason: string;
  reference: string | null;
  createdAt: string;
}

/** Uma mexida na loja: quem, quando e o quê. */
export interface StoreAuditEntry {
  id: number;
  at: string;
  /** `null` = veio pelo token de integração, e não de uma sessão. */
  actor: string | null;
  action: string;
  target: string;
  detail: string | null;
}

/** Os números da primeira tela da loja. */
export interface StoreStats {
  offers: number;
  categories: number;
  /** Só o ENTREGUE conta: estornado não é venda. */
  revenue: number;
  delivered: number;
  refunded: number;
  /** Pagou, não recebeu e não estornou. Fora da janela de dias. */
  stuck: number;
  buyers: number;
  top: { name: string; count: number; total: number }[];
}

export interface WalletView {
  steamId: string;
  balance: number;
  /**
   * De onde o saldo veio.
   *
   * `remote` = o site externo é o dono, e lançamentos à mão são
   * recusados aqui. O extrato local vira história.
   */
  source: 'local' | 'remote';
  entries: WalletEntry[];
}

/**
 * O que a tela chama, com nome de verbo.
 *
 * Concentrado aqui para a página não montar caminho na mão: um
 * `/api/servers/${id}` escrito em cinco lugares é o que fica para
 * trás no dia em que a rota mudar.
 */
// ------------------------------------------------------------
//  ITENS E INTERFACE
// ------------------------------------------------------------

/** Um item do catálogo do agente. Ver `GET /api/items`. */
export interface CatalogItem {
  /** `rifle.ak`. É o que todo comando do jogo recebe. */
  shortname: string;
  /** `Assault Rifle`. É por ele que a busca acha. */
  displayName: string;
  itemId: number;
  category: string;
  maxStack: number;
  hasCondition: boolean;
  firstSeen: string;
  lastSeen: string;
  /**
   * O jogo não lista mais este item.
   *
   * A linha continua no agente de propósito: um kit do mês passado
   * aponta para ela.
   */
  removed: boolean;
}

/**
 * De quando é o catálogo, e de onde ele veio.
 *
 * Vai em TODA resposta de leitura de item. Uma tela que mostra
 * 1252 itens sem dizer que eles são de três versões atrás é uma
 * tela que mente.
 */
export interface ItemCatalogInfo {
  /** O `Protocol` do jogo que gerou o catálogo. */
  protocol: string | null;
  updatedAt: string | null;
  total: number;
  /** `servidor` = há um servidor no ar conferindo isto agora. */
  source: 'servidor' | 'banco';
  /** A frase que explica o estado, quando ele precisa. */
  note: string | null;
}

export interface ItemsPage {
  count: number;
  total: number;
  items: CatalogItem[];
  catalog: ItemCatalogInfo;
}

/** O que um servidor faz com uma interface. */
export interface ServerUiBinding {
  serverId: string;
  documentId: number;
  enabled: boolean;
  /** Os ids que ESTE servidor esconde. */
  hidden: string[];
  /** A revisão que está no jogo. `null` = nunca foi aplicada. */
  appliedRevision: number | null;
  appliedAt: string | null;
}

export interface UiDocumentSummary {
  id: number;
  slug: string;
  name: string;
  command: string;
  revision: number;
  screens: number;
  createdAt: string;
  updatedAt: string;
  servers: ServerUiBinding[];
}

/** O documento inteiro. `document` é o modelo de `lib/ui-doc`. */
export interface UiDocumentDetail {
  id: number;
  slug: string;
  name: string;
  revision: number;
  document: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * A conversão para CUI, feita pelo AGENTE.
 *
 * `payload` responde à pergunta que o editor precisa fazer antes de
 * o menu chegar ao jogo: a carga inicial cabe no frame do RCON?
 * Passando do teto, o envio é recusado inteiro.
 */
export interface UiPreview {
  screen: { id: string; name: string; kind: 'page' | 'modal' };
  cui: { name: string; parent: string; components: Record<string, unknown>[] }[];
  payload: { bytes: number; limit: number; fits: boolean };
}

// ------------------------------------------------------------
//  AS MENSAGENS
//
//  ####  ELAS SÃO DE REDE, COMO VIP, KIT E LOJA  ####
//
//  Escreve-se uma vez e escolhe-se em quais servidores a mensagem
//  sai. Por isso não há `serverId` aqui: há uma LISTA de alvos, e
//  lista VAZIA quer dizer TODOS.
//
//  ####  E CADA UMA TEM O SEU RITMO  ####
//
//  Não é um intervalo único com rodízio de frases: o convite do
//  Discord de meia em meia hora convive com o aviso de manutenção
//  de uma vez só, na terça de madrugada.
// ------------------------------------------------------------

/**
 * Os quatro ritmos.
 *
 *   interval  de N em N segundos
 *   daily     todo dia no mesmo horário
 *   weekly    nos dias da semana escolhidos
 *   once      uma vez só, num instante marcado
 */
export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'once';

export interface Message {
  id: number;
  /** O nome na lista. É de quem administra; o jogador nunca o vê. */
  name: string;
  /** O texto com as variáveis ainda por resolver: `{servidor}`, `{online}`. */
  text: string;
  enabled: boolean;
  /** A ordem na tela, de 10 em 10. */
  position: number;
  scheduleKind: ScheduleKind;
  /** Em SEGUNDOS, no ritmo `interval`. `null` nos outros. */
  everySeconds: number | null;
  /** `HH:MM` local do `daily` e do `weekly`. */
  timeOfDay: string | null;
  /** 0 = domingo. Vazio fora do `weekly`. */
  weekdays: number[];
  /** O instante do `once`, em ISO. */
  runAt: string | null;
  /** A zona IANA em que os horários acima são lidos. */
  timeZone: string;
  /** Só sai entre estas horas. `null` nos dois = a qualquer hora. */
  windowFrom: string | null;
  windowTo: string | null;
  onlyWithPlayers: boolean;
  minPlayers: number;
  tag: string | null;
  tagColor: string | null;
  color: string | null;
  size: number | null;
  lastSentAt: string | null;
  /** Quando ela sai de novo. `null` = não há próxima. */
  nextAt: string | null;
  sentCount: number;
  /** Em quais servidores ela sai. VAZIO = em TODOS. */
  targets: string[];
  /** A frase pronta da coluna REPETE, escrita pelo agente. */
  schedule: string;
  createdAt: string;
  updatedAt: string;
}

/** O que o formulário grava. Ver core/src/http/routes/messages.ts. */
export interface MessageInput {
  name: string;
  text: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  everySeconds: number | null;
  timeOfDay: string | null;
  weekdays: number[];
  /** ISO com fuso, como o `expiresAt` do VIP. */
  runAt: string | null;
  timeZone: string;
  windowFrom: string | null;
  windowTo: string | null;
  onlyWithPlayers: boolean;
  minPlayers: number;
  tag: string | null;
  tagColor: string | null;
  color: string | null;
  size: number | null;
  targets: string[];
}

/** Uma linha do log: aquela mensagem, naquele servidor, naquele dia. */
export interface MessageLogEntry {
  id: number;
  serverId: string;
  at: string;
  /** Quantos receberam. Pelo `say` é 0, e ali 0 = DESCONHECIDO. */
  players: number;
  ok: boolean;
  error: string | null;
}

/** O desfecho de "testar agora", por servidor. */
export interface MessageSendReport {
  serverId: string;
  ok: boolean;
  players: number;
  /** Por onde saiu: o plugin (com cor) ou o `say` do jogo. */
  via: 'plugin' | 'say' | null;
  /** O texto JÁ com as variáveis resolvidas. */
  text: string;
  error: string | null;
}

/** Os nomes que o agente sabe trocar. Vem do REGISTRO, não do painel. */
export interface MessageVariables {
  names: string[];
  namespaces: string[];
}

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
  /**
   * Move o jogador para um ponto do mundo.
   *
   * `y` é omitido de propósito: quem arrasta o boneco no mapa
   * escolhe X e Z, e quem sabe a altura do chão ali é o servidor. A
   * resposta traz a posição FINAL — é ela que a tela usa para
   * redesenhar o ponto, em vez de supor que ele chegou onde foi
   * solto.
   */
  teleportPlayer: (id: string, steamId: string, target: { x: number; z: number; y?: number }) =>
    api<{
      ok: true;
      steamId: string;
      position: { x: number; y: number; z: number };
      heightAdjusted: boolean;
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/players/${encodeURIComponent(steamId)}/teleport`, {
      method: 'POST',
      body: target,
    }),

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

  /**
   * Os monumentos daquele mundo.
   *
   * Nativo do jogo, e guardado pelo agente por tamanho+seed: eles
   * nascem com a seed e só mudam no wipe.
   */
  monuments: (id: string) =>
    api<{ ok: true; monuments: MapMonument[] }>(
      `/api/servers/${encodeURIComponent(id)}/monuments`,
    ),

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

  // ---- O Oxide daquele servidor ----------------------------
  //
  // Ler responde 200 mesmo com o servidor parado (`connected:
  // false` e uma frase); AGIR exige o RCON de pé — não existe
  // enfileirar uma concessão de permissão.

  oxide: (id: string) =>
    api<{
      ok: true;
      connected: boolean;
      oxide: { version: string | null; branch: string | null };
      plugins: OxideLoadedPlugin[];
      config: OxideFrameworkConfig;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/oxide`),

  oxidePermissions: (id: string) =>
    api<{
      ok: true;
      connected: boolean;
      groups: OxideGroup[];
      /** Tudo o que os plugins registraram naquele servidor. */
      permissions: string[];
      /** Grupos que ficaram sem detalhe. `0` é o normal. */
      truncated: number;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/oxide/permissions`),

  createOxideGroup: (
    id: string,
    input: { name: string; title?: string; rank?: number; parent?: string },
  ) =>
    api<{ ok: true; message: string }>(`/api/servers/${encodeURIComponent(id)}/oxide/groups`, {
      method: 'POST',
      body: input,
    }),

  /** `parent: ''` DESLIGA a herança; ausente não mexe nela. */
  patchOxideGroup: (
    id: string,
    group: string,
    patch: { title?: string; rank?: number; parent?: string },
  ) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/oxide/groups/${encodeURIComponent(group)}`,
      { method: 'PATCH', body: patch },
    ),

  removeOxideGroup: (id: string, group: string) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/oxide/groups/${encodeURIComponent(group)}`,
      { method: 'DELETE' },
    ),

  grantOxidePermission: (id: string, group: string, permission: string) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/oxide/groups/${encodeURIComponent(group)}/permissions`,
      { method: 'POST', body: { permission } },
    ),

  revokeOxidePermission: (id: string, group: string, permission: string) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/oxide/groups/${encodeURIComponent(
        group,
      )}/permissions/${encodeURIComponent(permission)}`,
      { method: 'DELETE' },
    ),

  addOxideMember: (id: string, group: string, steamId: string) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/oxide/groups/${encodeURIComponent(group)}/members`,
      { method: 'POST', body: { steamId } },
    ),

  removeOxideMember: (id: string, group: string, steamId: string) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/oxide/groups/${encodeURIComponent(
        group,
      )}/members/${encodeURIComponent(steamId)}`,
      { method: 'DELETE' },
    ),

  // ---- Os jogadores da rede --------------------------------
  //
  // A listagem é PAGINADA desde a primeira versão: uma rede com
  // meses de vida tem dezenas de milhares de jogadores, e uma
  // chamada que devolvesse todos travaria o navegador antes de
  // derrubar o agente.

  networkPlayers: (options: {
    query?: string;
    online?: boolean;
    limit: number;
    offset: number;
  }) => {
    const params = new URLSearchParams();

    if (options.query !== undefined && options.query.trim() !== '') {
      params.set('q', options.query.trim());
    }

    if (options.online === true) {
      params.set('online', '1');
    }

    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset));

    return api<{
      ok: true;
      players: NetworkPlayer[];
      /** O que veio nesta página. */
      count: number;
      /** O que casou com o filtro, antes da paginação. */
      total: number;
      limit: number;
      offset: number;
    }>(`/api/players?${params.toString()}`);
  },

  /**
   * A ficha.
   *
   * `ban` vem da BanList — a mesma linha que a tela de Banidos
   * mostra, e não uma cópia guardada do lado do jogador.
   */
  networkPlayer: (steamId: string) =>
    api<{
      ok: true;
      player: PlayerIdentity;
      ban: Ban | null;
      servers: PlayerServer[];
    }>(`/api/players/${encodeURIComponent(steamId)}`),

  playerServers: (steamId: string) =>
    api<{ ok: true; servers: PlayerServer[] }>(
      `/api/players/${encodeURIComponent(steamId)}/servers`,
    ),

  /** O histórico. Ver `PlayerEventSample` para o que é exemplo. */
  playerEvents: (steamId: string, limit = 50) =>
    api<{ ok: true; events: PlayerEvent[]; sample: PlayerEventSample }>(
      `/api/players/${encodeURIComponent(steamId)}/events?limit=${String(limit)}`,
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

  // ----------------------------------------------------------
  //  ITENS
  //
  //  Nenhuma destas fala com o jogo: o catálogo mora no agente, e
  //  é por isso que a tela responde com todos os servidores
  //  parados. A exceção é o `refreshItems`, que é justamente o
  //  pedido explícito de ir lá.
  // ----------------------------------------------------------

  items: (params: {
    query?: string;
    category?: string;
    /** `true` = só o que sumiu do jogo; `false` = só o que existe. */
    removed?: boolean | undefined;
    limit?: number;
    offset?: number;
    /**
     * Cancela a busca anterior.
     *
     * O autocomplete dispara uma por tecla. Sem isto, a resposta de
     * "wo" pode chegar DEPOIS da de "wood" e sobrescrever a lista
     * certa — a tela mostraria o resultado de um texto que já não
     * está no campo.
     */
    signal?: AbortSignal;
  }) => {
    const search = new URLSearchParams();

    if (params.query !== undefined && params.query.trim() !== '') {
      search.set('q', params.query.trim());
    }

    if (params.category !== undefined && params.category !== '') {
      search.set('category', params.category);
    }

    if (params.removed !== undefined) {
      search.set('removed', params.removed ? '1' : '0');
    }

    if (params.limit !== undefined) {
      search.set('limit', String(params.limit));
    }

    if (params.offset !== undefined && params.offset > 0) {
      search.set('offset', String(params.offset));
    }

    const query = search.toString();

    return api<ItemsPage & { ok: true }>(`/api/items${query === '' ? '' : `?${query}`}`, {
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
  },

  itemCategories: () =>
    api<{ ok: true; categories: { category: string; total: number }[]; catalog: ItemCatalogInfo }>(
      '/api/items/categories',
    ),

  /** Relê o catálogo do jogo. Precisa de um servidor no ar. */
  refreshItems: () =>
    api<{
      ok: true;
      scan: { added: number; present: number; removed: number; protocol: string | null };
      catalog: ItemCatalogInfo;
    }>('/api/items/refresh', { method: 'POST' }),

  // ----------------------------------------------------------
  //  INTERFACE
  //
  //  O DESENHO é da rede (`/ui/documents`); o que APARECE é do
  //  servidor (`/servers/:id/ui`). São duas famílias de rota
  //  porque são duas decisões diferentes.
  // ----------------------------------------------------------

  uiDocuments: () => api<{ ok: true; documents: UiDocumentSummary[] }>('/api/ui/documents'),

  uiDocument: (id: number) =>
    api<{ ok: true; document: UiDocumentDetail }>(`/api/ui/documents/${String(id)}`),

  /** Os modelos que o botão "Criar a partir do modelo" oferece. */
  uiPresets: () => api<{ ok: true; presets: string[] }>('/api/ui/presets'),

  /**
   * Cria a partir de um MODELO.
   *
   * O desenho do modelo mora no agente, e não aqui: é o mesmo
   * documento que ele cria sozinho no primeiro boot, e tê-lo num
   * lugar só é o que impede os dois caminhos de darem menus
   * diferentes.
   */
  createUiFromPreset: (preset: string) =>
    api<{ ok: true; document: UiDocumentDetail }>('/api/ui/documents', {
      method: 'POST',
      body: { preset },
    }),

  createUiDocument: (document: unknown) =>
    api<{ ok: true; document: UiDocumentDetail }>('/api/ui/documents', {
      method: 'POST',
      body: { document },
    }),

  /**
   * Reescreve a interface pelo MODELO, mantendo id e vínculos.
   *
   * ####  É DESTRUTIVO, E É POR ISSO QUE ELE EXISTE  ####
   *
   * O menu nasce no primeiro boot e nunca mais muda sozinho. Quando
   * o modelo ganha algo novo — o saldo no cabeçalho, os modais da
   * loja —, quem já estava de pé fica com o desenho antigo. Este é o
   * caminho de volta, e ele preserva justamente o que reconfigurar
   * custaria caro: o id que o plugin guarda e a escolha de cada
   * servidor.
   */
  resetUiDocument: (id: number, preset: string) =>
    api<{ ok: true; document: UiDocumentDetail; message: string }>(
      `/api/ui/documents/${String(id)}/reset`,
      { method: 'POST', body: { preset } },
    ),

  /** Grava o documento INTEIRO e sobe a revisão. */
  saveUiDocument: (id: number, document: unknown) =>
    api<{ ok: true; document: UiDocumentDetail }>(`/api/ui/documents/${String(id)}`, {
      method: 'PUT',
      body: { document },
    }),

  deleteUiDocument: (id: number) =>
    api<{ ok: true }>(`/api/ui/documents/${String(id)}`, { method: 'DELETE' }),

  /**
   * Modelo -> CUI, pelo agente, sem tocar em servidor nenhum.
   *
   * `document` opcional: mandando o que está sendo editado, dá para
   * conferir a conversão ANTES de gravar — que é quando o erro é
   * barato de corrigir.
   */
  previewUiDocument: (
    id: number,
    body: { screenId?: string; serverId?: string; document?: unknown } = {},
  ) => api<UiPreview & { ok: true }>(`/api/ui/documents/${String(id)}/preview`, {
    method: 'POST',
    body,
  }),

  /** O que ESTE servidor usa, e as interfaces que existem. */
  serverUi: (id: string) =>
    api<{
      ok: true;
      binding: ServerUiBinding | null;
      documents: {
        id: number;
        slug: string;
        name: string;
        command: string;
        revision: number;
        screens: number;
      }[];
    }>(`/api/servers/${encodeURIComponent(id)}/ui`),

  /** Escolhe o menu deste servidor e o que ele esconde. */
  setServerUi: (
    id: string,
    body: { documentId: number | null; enabled?: boolean; hidden?: string[] },
  ) =>
    api<{ ok: true; binding: ServerUiBinding | null }>(
      `/api/servers/${encodeURIComponent(id)}/ui`,
      { method: 'PUT', body },
    ),

  /** Empurra agora. Síncrono: quem clicou está olhando. */
  pushServerUi: (id: string) =>
    api<{ ok: true; documents: number; bytes: number }>(
      `/api/servers/${encodeURIComponent(id)}/ui/push`,
      { method: 'POST' },
    ),
  // ---- O VIP da rede ---------------------------------------
  //
  // PAGINADO desde a primeira versão, como a lista de jogadores:
  // uma rede com meses de vida acumula concessões, e uma chamada
  // que devolvesse todas travaria o navegador.

  vips: (options: {
    active?: boolean;
    query?: string;
    tier?: string;
    limit: number;
    offset: number;
  }) => {
    const params = new URLSearchParams();

    if (options.active !== undefined) {
      params.set('active', options.active ? '1' : '0');
    }

    if (options.query !== undefined && options.query.trim() !== '') {
      params.set('q', options.query.trim());
    }

    if (options.tier !== undefined && options.tier !== '') {
      params.set('tier', options.tier);
    }

    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset));

    return api<{ ok: true; vips: Vip[]; count: number; total: number }>(
      `/api/vips?${params.toString()}`,
    );
  },

  /** Os níveis que os servidores declaram. Ver `VipTier`. */
  vipTiers: () => api<{ ok: true; tiers: VipTier[]; message?: string }>('/api/vips/tiers'),

  /**
   * Concede ou RENOVA.
   *
   * `expiresAt: null` é VITALÍCIO, e o campo é obrigatório de
   * propósito: um prazo esquecido viraria VIP eterno de graça, e
   * ninguém repara num benefício que sobra.
   */
  grantVip: (input: {
    steamId: string;
    tier: string;
    expiresAt: string | null;
    origin?: 'loja' | 'painel';
  }) =>
    api<{
      ok: true;
      vip: Vip;
      outcome: 'created' | 'extended';
      results: VipSyncResult[];
      message: string;
    }>('/api/vips', { method: 'POST', body: input }),

  /** Revoga. A linha continua no histórico, com quem revogou. */
  revokeVip: (steamId: string, tier: string) =>
    api<{ ok: true; vip: Vip; results: VipSyncResult[]; message: string }>(
      `/api/vips/${encodeURIComponent(steamId)}/${encodeURIComponent(tier)}`,
      { method: 'DELETE' },
    ),

  /** O que este jogador tem agora, e o que ele já teve. */
  playerVips: (steamId: string) =>
    api<{ ok: true; active: Vip[]; history: Vip[] }>(
      `/api/players/${encodeURIComponent(steamId)}/vips`,
    ),

  /** Reempurra o estado e reconcilia os grupos daquele servidor. */
  syncServerVips: (id: string) =>
    api<{ ok: true } & VipSyncResult & { message: string }>(
      `/api/servers/${encodeURIComponent(id)}/vips/sync`,
      { method: 'POST' },
    ),

  // ---- Os loadouts daquele servidor ------------------------
  //
  // A lista vem dos GRUPOS do Oxide, e não de uma tabela nossa.

  loadouts: (id: string) =>
    api<{
      ok: true;
      connected: boolean;
      groups: ServerLoadout[];
      truncated: number;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/loadouts`),

  saveLoadout: (id: string, group: string, input: { items: LoadoutItem[]; enabled: boolean }) =>
    api<{
      ok: true;
      loadout: ServerLoadout;
      sync: LoadoutSyncResult;
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/loadouts/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: input,
    }),

  /** Apaga. O payload seguinte não tem o grupo — e é assim que some do jogo. */
  removeLoadout: (id: string, group: string) =>
    api<{ ok: true; sync: LoadoutSyncResult; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/loadouts/${encodeURIComponent(group)}`,
      { method: 'DELETE' },
    ),

  syncLoadouts: (id: string) =>
    api<{ ok: true } & LoadoutSyncResult & { message: string }>(
      `/api/servers/${encodeURIComponent(id)}/loadouts/sync`,
      { method: 'POST' },
    ),

  // ---- O status de nascimento daquele servidor -------------
  //
  // A outra metade da mesma pergunta: o loadout é o que o jogador
  // GANHA, isto é o estado em que ele ACORDA. Mesma lista de
  // grupos; comandos diferentes no jogo.

  spawnStatus: (id: string) =>
    api<{
      ok: true;
      connected: boolean;
      groups: ServerSpawnStatus[];
      truncated: number;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/spawn-status`),

  saveSpawnStatus: (id: string, group: string, input: SpawnStatusInput) =>
    api<{
      ok: true;
      status: ServerSpawnStatus;
      sync: SpawnStatusSyncResult;
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/spawn-status/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: input,
    }),

  /** Apaga. Quem nascer nesse grupo volta ao padrão do Rust. */
  removeSpawnStatus: (id: string, group: string) =>
    api<{ ok: true; sync: SpawnStatusSyncResult; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/spawn-status/${encodeURIComponent(group)}`,
      { method: 'DELETE' },
    ),

  syncSpawnStatus: (id: string) =>
    api<{ ok: true } & SpawnStatusSyncResult & { message: string }>(
      `/api/servers/${encodeURIComponent(id)}/spawn-status/sync`,
      { method: 'POST' },
    ),

  // ---- A loja de kits --------------------------------------

  kits: () => api<{ ok: true; kits: Kit[] }>('/api/kits'),

  createKit: (input: Omit<Kit, 'id' | 'claimCount' | 'createdAt' | 'updatedAt'>) =>
    api<{ ok: true; kit: Kit; message: string }>('/api/kits', { method: 'POST', body: input }),

  /** PUT, e não PATCH: a tela manda o kit inteiro. */
  updateKit: (id: number, input: Omit<Kit, 'id' | 'claimCount' | 'createdAt' | 'updatedAt'>) =>
    api<{ ok: true; kit: Kit; message: string }>(`/api/kits/${String(id)}`, {
      method: 'PUT',
      body: input,
    }),

  removeKit: (id: number) =>
    api<{ ok: true; message: string }>(`/api/kits/${String(id)}`, { method: 'DELETE' }),

  kitClaims: (id: number, options: { limit: number; offset: number }) =>
    api<{ ok: true; claims: KitClaim[]; count: number; total: number }>(
      `/api/kits/${String(id)}/claims?limit=${String(options.limit)}&offset=${String(options.offset)}`,
    ),

  /** Os kits daquele servidor. Com `steamId`, diz se ele pode pegar. */
  serverKits: (id: string, steamId?: string) =>
    api<{ ok: true; kits: KitOffer[] }>(
      `/api/servers/${encodeURIComponent(id)}/kits` +
        (steamId === undefined ? '' : `?steamId=${encodeURIComponent(steamId)}`),
    ),

  /**
   * Entrega o kit AGORA.
   *
   * Exige o jogador dentro do servidor: item entra em inventário, e
   * inventário só existe para quem está conectado.
   */
  claimKit: (id: string, kitId: number, steamId: string) =>
    api<{
      ok: true;
      status: 'entregue' | 'falhou';
      delivered: number;
      total: number;
      detail: string | null;
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/kits/${String(kitId)}/claim`, {
      method: 'POST',
      body: { steamId },
    }),

  // ---- A LOJA ----------------------------------------------

  storeCategories: () =>
    api<{ ok: true; categories: StoreCategory[] }>('/api/store/categories'),

  createStoreCategory: (input: { name: string; position: number; enabled: boolean }) =>
    api<{ ok: true; category: StoreCategory }>('/api/store/categories', {
      method: 'POST',
      body: input,
    }),

  updateStoreCategory: (id: string, input: { name: string; position: number; enabled: boolean }) =>
    api<{ ok: true; category: StoreCategory }>(`/api/store/categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input,
    }),

  /** Leva as ofertas dela junto. A mensagem diz quantas. */
  removeStoreCategory: (id: string) =>
    api<{ ok: true; message: string }>(`/api/store/categories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  storeOffers: (categoryId?: string) =>
    api<{ ok: true; offers: StoreOffer[] }>(
      '/api/store/offers' +
        (categoryId === undefined ? '' : `?categoryId=${encodeURIComponent(categoryId)}`),
    ),

  createStoreOffer: (input: StoreOfferInput) =>
    api<{ ok: true; offer: StoreOffer }>('/api/store/offers', { method: 'POST', body: input }),

  updateStoreOffer: (id: string, input: StoreOfferInput) =>
    api<{ ok: true; offer: StoreOffer }>(`/api/store/offers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input,
    }),

  removeStoreOffer: (id: string) =>
    api<{ ok: true; message: string }>(`/api/store/offers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /** O histórico. Sem filtro, é a rede inteira. */
  storePurchases: (
    options: {
      serverId?: string;
      steamId?: string;
      state?: PurchaseState;
      limit?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();

    if (options.serverId !== undefined) query.set('serverId', options.serverId);
    if (options.steamId !== undefined) query.set('steamId', options.steamId);
    if (options.state !== undefined) query.set('state', options.state);
    if (options.limit !== undefined) query.set('limit', String(options.limit));

    const search = query.toString();

    return api<{ ok: true; purchases: StorePurchase[] }>(
      `/api/store/purchases${search === '' ? '' : `?${search}`}`,
    );
  },

  /** O resumo da loja. `days` é a janela do que muda. */
  storeStats: (days = 7) =>
    api<{ ok: true; days: number; source: 'local' | 'remote'; stats: StoreStats }>(
      `/api/store/stats?days=${String(days)}`,
    ),

  /** Quem mexeu na loja, e o quê. */
  storeAudit: (limit = 100) =>
    api<{ ok: true; entries: StoreAuditEntry[] }>(`/api/store/audit?limit=${String(limit)}`),

  // ---- A CARTEIRA ------------------------------------------

  wallet: (steamId: string) =>
    api<{ ok: true } & WalletView>(`/api/players/${encodeURIComponent(steamId)}/wallet`),

  /**
   * Lançamento à mão. Negativo TIRA.
   *
   * Recusado com a carteira remota no ar: lá quem manda no saldo é o
   * site, e um crédito daqui criaria um número que ele não conhece.
   */
  moveWallet: (steamId: string, input: { amount: number; reason: string }) =>
    api<{ ok: true; steamId: string; balance: number }>(
      `/api/players/${encodeURIComponent(steamId)}/wallet`,
      { method: 'POST', body: input },
    ),

  /** Compra fora do jogo — o mesmo caminho que o site usa. */
  buyOffer: (serverId: string, input: { steamId: string; offerId: string; quantity: number }) =>
    api<{ ok: true; message: string; purchase: StorePurchase; balance: number }>(
      `/api/servers/${encodeURIComponent(serverId)}/store/buy`,
      { method: 'POST', body: input },
    ),

  // ---- AS MENSAGENS ----------------------------------------

  messages: () =>
    api<{ ok: true; messages: Message[]; variables: MessageVariables }>('/api/messages'),

  createMessage: (input: MessageInput) =>
    api<{ ok: true; message: Message; detail: string }>('/api/messages', {
      method: 'POST',
      body: input,
    }),

  /**
   * PATCH, e não PUT: a lista liga e desliga com UM clique.
   *
   * Mandar o corpo inteiro para trocar um booleano faria a tela
   * reenviar o texto e o ritmo a cada clique — com a chance de
   * sobrescrever o que outra aba acabou de gravar.
   */
  updateMessage: (id: number, patch: Partial<MessageInput>) =>
    api<{ ok: true; message: Message; detail: string }>(`/api/messages/${String(id)}`, {
      method: 'PATCH',
      body: patch,
    }),

  removeMessage: (id: number) =>
    api<{ ok: true; detail: string }>(`/api/messages/${String(id)}`, { method: 'DELETE' }),

  /** A fila INTEIRA, e não "suba esta". Ver core/src/db/messages-repository.ts. */
  reorderMessages: (ids: number[]) =>
    api<{ ok: true; messages: Message[] }>('/api/messages/reorder', {
      method: 'POST',
      body: { ids },
    }),

  /**
   * Manda AGORA, sem mexer no `next_at`.
   *
   * Se testar consumisse o horário, conferir a mensagem seria
   * mudá-la. A resposta traz o texto JÁ resolvido por servidor — é
   * o que responde "o {wipe.faltam} está pegando?" sem entrar no
   * jogo.
   */
  testMessage: (id: number, serverId?: string) =>
    api<{ ok: true; reports: MessageSendReport[]; detail: string }>(
      `/api/messages/${String(id)}/test`,
      { method: 'POST', body: serverId === undefined ? {} : { serverId } },
    ),

  /** "Essa mensagem está mesmo aparecendo?" — inclusive quando não. */
  messageLog: (id: number, limit = 100) =>
    api<{ ok: true; entries: MessageLogEntry[] }>(
      `/api/messages/${String(id)}/log?limit=${String(limit)}`,
    ),

  /** Uma fala avulsa, pelo MESMO transporte das mensagens agendadas. */
  broadcastChat: (input: {
    serverId: string;
    text: string;
    tag?: string;
    tagColor?: string;
    color?: string;
    size?: number;
    steamId?: string;
  }) =>
    api<{ ok: true; sent: number; via: 'plugin' | 'say'; text: string; detail: string }>(
      '/api/chat/broadcast',
      { method: 'POST', body: input },
    ),
};
