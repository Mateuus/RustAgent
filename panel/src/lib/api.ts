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
 * Quem avisar aqui é chamado quando o agente responde 401.
 *
 * ####  POR QUE ISTO EXISTE  ####
 *
 * A sessão mora na MEMÓRIA do agente: um `pm2 restart` — ou um
 * `tsx watch` recarregando no desenvolvimento — derruba todas as
 * sessões abertas. Sem este aviso, cada tela recebia o 401 por
 * conta própria, mostrava o texto de erro num canto e seguia
 * achando que continuava logada. A tela de Operações era a pior:
 * ela ficava batendo de segundo em segundo numa operação que não
 * podia mais ler, presa em "running" para sempre.
 *
 * Quem escuta é o `SessionProvider`, que derruba a sessão e manda
 * para `/entrar`.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
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
  /**
   * Cabeçalhos a mais.
   *
   * Existe por causa da `Idempotency-Key` do wipe: ela precisa ser a
   * MESMA em duas requisições que são a mesma intenção, e por isso
   * não pode ser gerada aqui dentro — quem a escolhe é a tela, que
   * sabe quando o clique é novo. Ver `startWipeRun`.
   */
  readonly headers?: Readonly<Record<string, string>>;
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

  // Por último: o que quem chamou pediu explicitamente vence o que
  // este arquivo montou sozinho.
  Object.assign(headers, options.headers ?? {});

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

    // A sessão caiu no meio do uso. Avisa UMA vez, e quem escuta
    // decide — este arquivo não conhece rota nem componente.
    if (response.status === 401) {
      onUnauthorized?.();
    }

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
  /**
   * O pareamento com o site OrigemZ.
   *
   * `hasToken` responde SE há bearer, nunca QUAL — a mesma
   * disciplina da senha de RCON. O `serverId` volta porque não é
   * segredo, e é a primeira coisa que alguém confere quando o
   * pareamento não sobe.
   */
  site: { serverId: string; hasToken: boolean };
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
  /** O convite do Discord que a tela DISCORD do menu mostra. */
  discord: string;
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
  /**
   * A operação parou porque AINDA NÃO DAVA, e não porque quebrou.
   *
   * Hoje só o `server-auto-update` que desiste porque o Oxide não
   * lançou a versão do build novo do Rust. Nada foi tocado e
   * ninguém foi desconectado — o agente tenta de novo sozinho.
   * Conta como `failed`, porque a atualização não aconteceu.
   */
  deferred?: boolean;
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
  /**
   * O que o Oxide respondeu sobre este plugin agora há pouco.
   *
   * É a diferença entre "ligado" (o arquivo está na pasta) e
   * "rodando" (o Oxide carregou). O agente confere sozinho, de
   * minuto em minuto — é o que faz aparecer aqui um plugin que
   * parou de compilar sem ninguém ter mexido nele, depois de uma
   * atualização do Rust.
   *
   * `null` = não deu para perguntar (servidor parado, ou o agente
   * acabou de subir). É "não sei", e não "está tudo bem".
   */
  runtime: { loaded: boolean; failure: string | null } | null;
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
   * Dependências MOLES que estão no acervo e não estão ligadas aqui.
   *
   * O plugin carrega assim mesmo, e a parte que usa o outro fica
   * morta sem erro nenhum — o OrigemZUI sem o OrigemZImages abre o
   * menu, mas sem as imagens próprias.
   *
   * Opcional porque um agente anterior a este campo não o manda, e
   * ler `.length` de `undefined` derrubaria a tela inteira.
   */
  missingReferences?: string[];
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
  /**
   * Falhou por ESPERA: nada foi tocado e o agente tenta sozinho.
   *
   * Hoje só o Oxide que ainda não lançou a versão do build novo do
   * Rust. Forçar pelo botão cai na mesma recusa — é a mesma
   * conferência —, e por isso a faixa muda de conselho quando isto
   * é verdade. Ver `core/src/oxide/compat.ts`.
   */
  deferred?: boolean;
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
  plugin: {
    name: string;
    id: number | null;
    enabled: boolean;
    /**
     * Por que a lista não veio do plugin, mesmo ele ligado.
     *
     * `not-loaded`  o Oxide não carregou o plugin — quase sempre
     *               erro de compilação depois de um update do
     *               Rust. NÃO passa sozinho, e o que resolve não
     *               é o interruptor: é a aba Plugins.
     * `no-answer`   o comando não voltou a tempo com o plugin de
     *               pé. É o servidor ocupado, comum nos primeiros
     *               minutos depois de subir. Passa sozinho.
     * `null`        a lista veio do plugin, ou ele está desligado.
     */
    fallback: 'not-loaded' | 'no-answer' | null;
  };
  /** Os campos que a fonte atual não fornece. */
  missing: string[];
  /** O tamanho do mundo e a grade — o que o Map View desenha. */
  world: WorldGrid;
}

/**
 * Onde o item entregue deve parar.
 *
 * `auto` é o que a loja e os kits usam: tenta o inventário e larga
 * no chão o que não couber. `inventory` prefere NÃO entregar a ver
 * o item no chão de uma base cheia de gente — ele recusa com
 * `INVENTORY_FULL`. `drop` larga direto, que é o modo de entregar
 * um veículo... e de entregar uma armadilha.
 */
export type GiveMode = 'auto' | 'inventory' | 'drop';

/** O teto por chamada do `origemz.give`. Igual ao do plugin. */
export const MAX_GIVE_AMOUNT = 100_000;

/**
 * Quantas pilhas uma entrega pode criar, no plugin.
 *
 * O limite real por chamada é `min(MAX_GIVE_AMOUNT, 100 × pilha
 * máxima do item)`: flecha (pilha 64) para em 6400, AK (pilha 1)
 * para em 100. O catálogo sabe a pilha máxima, então a tela avisa
 * ANTES de gastar um comando de RCON — quem recusa de verdade
 * continua sendo o plugin, com `TOO_MANY_STACKS`.
 */
export const MAX_GIVE_STACK_PIECES = 100;

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

/**
 * A versão do Oxide que o agente instalou, carimbada no disco.
 *
 * O console do jogo só responde com o servidor NO AR, e atualizar o
 * Oxide exige ele PARADO — sem este carimbo a tela ficava sem saber
 * o que tinha justamente na hora de trocar.
 */
export interface InstalledOxide {
  tag: string;
  installedAt: string;
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
  | 'kit'
  // A compra veio com a 017 e demorou a chegar aqui; o item, com a
  // 040. Os dois são o que o suporte procura quando alguém aparece
  // com o que não devia ter.
  | 'compra'
  | 'item';

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
  /**
   * O TETO da faixa. `null` = o valor acima é exato.
   *
   * Com os dois preenchidos, quem sorteia é o plugin, a cada
   * nascimento — ver core/src/loadouts/status.ts.
   */
  healthMax: number | null;
  caloriesMax: number | null;
  hydrationMax: number | null;
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
  healthMax: number | null;
  caloriesMax: number | null;
  hydrationMax: number | null;
  enabled: boolean;
}

/**
 * Quão RÁPIDO as coisas andam para quem está naquele grupo.
 *
 * Mesma lista de grupos do loadout e do status, e as mesmas regras de
 * órfão e de servidor fora do ar. A diferença: a lista vem na ordem
 * da HIERARQUIA (normal, os VIPs, admin, e por fim quem não é nível),
 * porque é nessa ordem que o plugin desce quando um campo está em
 * branco.
 *
 * Cada timer é um multiplicador de velocidade (×2 = metade do tempo).
 * `null` NÃO é ×1: é "este grupo não decide", e quem é dele cai para o
 * nível de baixo — ver core/src/loadouts/timers.ts.
 */
export interface ServerPlayerTimers {
  name: string;
  exists: boolean | null;
  members: number | null;
  /**
   * O nível que o grupo é para o plugin: `normal`, o tier do VIP,
   * `admin` — ou `null`, quando o plugin nunca o consulta.
   */
  tier: string | null;
  smelt: number | null;
  craft: number | null;
  research: number | null;
  recycle: number | null;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlayerTimersSyncResult {
  serverId: string;
  tiers: number;
  cachedTiers: number;
  skipped: string | null;
}

/** O que o formulário grava. O 1 vira `null` do lado do agente. */
export interface PlayerTimersInput {
  smelt: number | null;
  craft: number | null;
  research: number | null;
  recycle: number | null;
  enabled: boolean;
}

export type KitKind = 'resgate' | 'cooldown';

/**
 * Quando a conta de usos de um kit volta a zero.
 *
 *   `never`       nunca: o que ele gastou, gastou.
 *   `wipe`        a cada wipe daquele servidor.
 *   `full-wipe`   só no full wipe (o que leva blueprints junto).
 */
export type KitUseReset = 'never' | 'wipe' | 'full-wipe';

export interface Kit {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  /**
   * A arte própria do card, em `Assets/kits/`.
   *
   * `null` = o desenho padrão: o ícone do PRIMEIRO item do kit.
   * Opcional porque um agente anterior a este campo não o manda.
   */
  iconFile?: string | null;
  /** A aba em que ele aparece no menu do jogo. `null` = sem aba. */
  category: string | null;
  kind: KitKind;
  /** Em SEGUNDOS. `null` fora de `cooldown`. */
  cooldownSeconds: number | null;
  /**
   * Quantas vezes cada jogador pode levar. `null` em `cooldown`.
   *
   * "Resgate único" é este campo valendo 1.
   */
  useLimit: number | null;
  /** Quando a conta de usos zera. */
  useResetOn: KitUseReset;
  /**
   * Só libera este tanto de segundos DEPOIS do wipe.
   *
   * `null` = sem bloqueio. Quem sabe a hora do wipe é o servidor
   * (`SaveCreatedTime` do `serverinfo`).
   */
  wipeDelaySeconds: number | null;
  /** `null` = qualquer um. */
  requiredTier: string | null;
  /** `true` = SÓ aquele nível; um mais alto não serve. */
  requiredTierExact: boolean;
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
  /**
   * Quantos usos ainda restam a ELE, já com o reset do wipe
   * aplicado. `null` = este kit não conta usos (é o de cooldown).
   */
  usesLeft: number | null;
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
  /**
   * O desenho da oferta. De campo próprio: um kit não tem "o item".
   *
   * `file` é a arte própria, em `Assets/store/`. `null` = usa o ícone
   * do jogo, que é o padrão e não custa download ao jogador.
   */
  icon: { shortname: string; itemId: number; skinId: string; file?: string | null };
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
  /**
   * `null` = a carteira não respondeu. NÃO é zero.
   *
   * Zero é uma afirmação sobre o dinheiro de alguém, e a tela
   * mostra travessão — a regra da casa: ausente vira traço, nunca 0.
   */
  balance: number | null;
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
  /**
   * O item tem `ItemModConsumable` — ou seja, dá para USÁ-LO.
   *
   * `null` é "ninguém perguntou ainda": o catálogo foi lido por um
   * agente anterior a este campo. É diferente de `false`, e a
   * diferença importa — o cadastro de item custom só desabilita a
   * conversão "ao usar" quando o jogo respondeu que NÃO.
   */
  consumable: boolean | null;
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

// ----------------------------------------------------------
//  OS ITENS QUE NÓS CRIAMOS
//
//  Eles são o oposto do `CatalogItem` acima: aquele é o que o jogo
//  tem, lido e espelhado; este é o que nós decidimos, e nada o
//  apaga sozinho.
//
//  ####  UM ITEM CUSTOM NÃO É UM ITEM NOVO  ####
//
//  É um item do jogo com uma MARCA nossa — o par
//  `(baseShortname, skinId)`. Foi medido no binário que um itemid
//  que o cliente não conhece é descartado; a skin, não. Ver
//  Docs\CustomItem\01-PESQUISA-ITEM-CUSTOM.md §3.
// ----------------------------------------------------------

/** Os oito tipos de efeito, e são os do JOGO. */
export const EFFECT_TYPES = [
  'Health',
  'HealthOverTime',
  'Bleeding',
  'Calories',
  'Hydration',
  'Poison',
  'Radiation',
  'Heartrate',
] as const;

export type EffectType = (typeof EFFECT_TYPES)[number];

export interface CustomItemEffect {
  type: EffectType;
  amount: number;
  /** Só age abaixo desta vida. Ausente = sempre. */
  onlyIfHealthBelow?: number;
}

export type CustomItemAction =
  | { kind: 'none' }
  | {
      kind: 'consume';
      /** O gesto que dispara: `use`, `drop`, `unwrap`… */
      trigger: string;
      consumes: number;
      effects: CustomItemEffect[];
    }
  | {
      /**
       * O item vira ponto de ranking.
       *
       * É o desenho do Troféu Bleik: o item não é para guardar, é
       * um RECIBO — nasce, é visto e morre, deixando um número que
       * só cresce.
       */
      kind: 'points';
      /** Qual ranking recebe. A lista vem de `GET /api/rankings/metrics`. */
      metric: string;
      perUnit: number;
      /**
       * Converter assim que o item cai no inventário?
       *
       * `true` é o padrão do troféu: some na hora, e com isso as
       * três proibições do briefing (guardar, dropar, transferir)
       * se resolvem sozinhas — não há o que dropar.
       */
      onPickup: boolean;
    };

export interface CustomItem {
  /** Gerado do nome (`trofeu-bleik-store`), e não muda depois. */
  id: string;
  displayName: string;
  /** O item do jogo que empresta o corpo. */
  baseShortname: string;
  /** Do catálogo. `null` quando o item base sumiu do jogo. */
  baseItemId: number | null;
  /** O item base não existe mais nesta versão do Rust. */
  baseMissing: boolean;
  /** UInt64 em texto. Nunca `'0'`. */
  skinId: string;
  category: string;
  description: string | null;
  iconFile: string | null;
  /** `null` herda o do item base. Só sabe DIMINUIR. */
  maxStack: number | null;
  deployable: boolean;
  /** O item se gasta assim que cai no inventario, e a acao roda. */
  consumeOnPickup: boolean;
  action: CustomItemAction;
  message: string | null;
  enabled: boolean;
  /** Vazio = em nenhum servidor, e o item não é entregue. */
  servers: string[];
  createdAt: string;
  updatedAt: string;
}

/** O corpo que cria ou reescreve um item custom. */
/**
 * A URL do PNG de um icone, para a tela poder mostra-lo.
 *
 * O arquivo mora em `Assets/items/` na maquina do agente, e o que o
 * jogo tem e um CRC dentro do servidor de Rust — sem esta rota, a
 * tela mostraria o nome do arquivo e pediria fe.
 */
export function iconUrl(name: string): string {
  return agentUrl('/api/custom-items/icons/' + encodeURIComponent(name));
}

/**
 * A URL da arte de uma oferta da loja.
 *
 * Mesma ideia do `iconUrl`, outro acervo: a arte do card mora em
 * `Assets/store/`, separada da dos itens — a lista de uma não deve
 * encher da outra.
 */
export function storeIconUrl(name: string): string {
  return agentUrl('/api/store/icons/' + encodeURIComponent(name));
}

/** A URL da arte de um kit. Mesma ideia, outro acervo. */
export function kitIconUrl(name: string): string {
  return agentUrl('/api/kits/icons/' + encodeURIComponent(name));
}

export interface CustomItemInput {
  displayName: string;
  baseShortname: string;
  skinId: string;
  category: string;
  description: string | null;
  iconFile: string | null;
  maxStack: number | null;
  deployable: boolean;
  /** O item se gasta assim que cai no inventario, e a acao roda. */
  consumeOnPickup: boolean;
  action: CustomItemAction;
  message: string | null;
  enabled: boolean;
  servers: string[];
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
  /**
   * Os comandos EXTRAS que abrem este menu.
   *
   * `/quest` abre o Menu Principal direto nas missões sem ser um
   * documento à parte. Eles ocupam o mesmo nome global no servidor
   * que o `command`, e é por isso que a lista os mostra: sem eles,
   * a recusa "Menu Principal já responde a /quest" apontaria para
   * uma linha da tabela que diz só `/menu`.
   */
  shortcuts: string[];
  revision: number;
  screens: number;
  createdAt: string;
  updatedAt: string;
  servers: ServerUiBinding[];
}

/**
 * Um modelo de interface, do jeito que o agente o anuncia.
 *
 * `preset` é a chave que volta no POST; `id` é o identificador que
 * o documento vai NASCER com — e é ele que colide com uma interface
 * já criada, e não a chave.
 */
export interface UiPreset {
  preset: string;
  id: string;
  name: string;
  command: string;
  screens: number;
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
//  O OVERLAY DE PROPAGANDAS (/api/servers/:id/ads)
//
//  ####  ELE NAO E UMA INTERFACE, E POR ISSO ESTA A PARTE  ####
//
//  Um documento de interface abre por comando, tem sessão e telas
//  que trocam sob clique. O overlay aparece sozinho, para todo
//  mundo, e o que ele faz é se MEXER — ver o cabeçalho do bloco
//  do overlay em Plugins/OrigemZUI.cs.
//
//  Ele fica AQUI, ao lado das interfaces, por vizinhança de
//  assunto: as duas coisas desenham na tela de quem joga.
// ------------------------------------------------------------

export const AD_FITS = ['cover', 'contain'] as const;
export type AdFit = (typeof AD_FITS)[number];

export const AD_IMAGE_STATUSES = ['pending', 'ready', 'error'] as const;
export type AdImageStatus = (typeof AD_IMAGE_STATUSES)[number];

export const AD_IMAGE_MODES = ['stored', 'url'] as const;
export type AdImageMode = (typeof AD_IMAGE_MODES)[number];

/**
 * As camadas do jogo onde o overlay pode ser pendurado.
 *
 * As cinco primeiras ficam SEMPRE na tela. As três últimas só
 * existem enquanto aquela tela do jogo está aberta — é assim que
 * "a propaganda só no inventário" funciona, sem hook nenhum.
 *
 * `Hud.Menu` NÃO é uma delas: apesar do nome, ela continua visível
 * com o inventário fechado (medido no jogo em 07/09/2026).
 *
 * Espelha `ADS_LAYERS` de core/src/types/ads.ts.
 */
export const AD_ALWAYS_LAYERS = ['Overall', 'Overlay', 'Hud.Menu', 'Hud', 'Under'] as const;
export const AD_SCREEN_LAYERS = ['Inventory', 'Crafting', 'Map'] as const;
export const AD_LAYERS = [...AD_ALWAYS_LAYERS, ...AD_SCREEN_LAYERS] as const;
export type AdLayer = (typeof AD_LAYERS)[number];

export const AD_ANCHORS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;
export type AdAnchor = (typeof AD_ANCHORS)[number];

/**
 * Os nove pontos onde o LOGO pode ficar quando é solto do painel.
 *
 * O painel ABRE — e crescer a partir do meio da tela não se lê
 * como "um painel abrindo". O logo só FICA, então ele pode estar
 * em qualquer lugar, e "no alto e ao centro" é o pedido comum.
 */
export const AD_LOGO_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
export type AdLogoAnchor = (typeof AD_LOGO_ANCHORS)[number];

export interface Advertisement {
  id: string;
  name: string;
  enabled: boolean;
  imageUrl: string;
  /** `null` = usa o padrão do ajuste. */
  displayDuration: number | null;
  position: number;
  priority: number;
  weight: number;
  fit: AdFit;
  backgroundColor: string;
  borderColor: string;

  startDate: string | null;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  daysOfWeek: number[];
  permission: string | null;

  imageStatus: AdImageStatus;
  imageKey: string | null;
  imageBytes: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageError: string | null;
  imageFetchedAt: string | null;

  shownCount: number;
  lastShownAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;

  // ----------------------------------------------------------
  //  DERIVADOS — calculados pelo AGENTE, e não aqui.
  //
  //  A regra de calendário (janela que vira a meia-noite, fuso
  //  do servidor) mora no agente. Repeti-la no navegador daria
  //  duas verdades que divergem no primeiro fuso horário.
  // ----------------------------------------------------------
  /** Passa no calendário NESTE instante? */
  inSchedule: boolean;
  /** Ligada, com imagem pronta e dentro da janela? */
  live: boolean;
  /** O enquadramento que o jogo vai usar. O preview usa o mesmo. */
  anchors: { min: string; max: string };
}

export interface AdsSettings {
  enabled: boolean;
  layer: AdLayer;
  permission: string | null;

  /**
   * O painel fica parado, com UMA propaganda?
   *
   * Ligado, não há ciclo: o painel é desenhado junto com o logo e
   * fica. É independente da `layer` de propósito — dá para ter um
   * banner fixo sempre visível, e o rodízio animado só dentro do
   * inventário.
   */
  staticMode: boolean;

  anchor: AdAnchor;
  marginTop: number;
  marginRight: number;

  logoEnabled: boolean;
  logoImageUrl: string | null;
  logoWidth: number;
  logoHeight: number;
  logoOpacity: number;
  logoAnimationEnabled: boolean;
  logoSwayPixels: number;
  logoScaleAmount: number;
  logoDurationSeconds: number;
  logoFps: number;
  /** Solta o logo do canto do painel: âncora e posição próprias. */
  logoDetached: boolean;
  /**
   * A camada do LOGO. `null` = a mesma do painel.
   *
   * É o campo que separa os dois: sem ele, pôr o painel em
   * `Hud.Menu` levaria o logo junto, e o servidor ficaria sem
   * marca na tela fora do inventário. Só vale com `logoDetached`.
   */
  logoLayer: AdLayer | null;
  logoAnchor: AdLogoAnchor;
  /** Num canto é margem; no centro, deslocamento (pode ser negativo). */
  logoMarginX: number;
  logoMarginY: number;

  panelWidth: number;
  panelHeight: number;
  panelColor: string;
  panelBorderColor: string;
  panelBorderEnabled: boolean;

  intervalSeconds: number;
  defaultDisplayDuration: number;
  openingMs: number;
  closingMs: number;
  transitionMs: number;
  orderMode: 'sequential' | 'random';
  /** 0 = todas as elegíveis. */
  adsPerCycle: number;
  animationFps: number;

  imageMode: AdImageMode;
  updatedAt: string | null;
}

/**
 * Um quadro da animação, como o agente o gerou.
 *
 * O painel NÃO recalcula nada a partir dele: o preview toca
 * exatamente os mesmos quadros que descem ao jogo. Duas
 * renderizações divergiriam no primeiro campo que uma implementa
 * e a outra não — e a divergência apareceria dentro do jogo, que
 * é o pior lugar para descobrir.
 */
export interface AdsFrame {
  at: number;
  /**
   * O que sai da tela neste quadro.
   *
   * ####  OPCIONAL, E O AGENTE REALMENTE O OMITE  ####
   *
   * Quando nao ha nada a destruir o campo nao vem — sao bytes que
   * nao precisam atravessar o RCON. Declara-lo obrigatorio aqui
   * fez o preview iterar um `undefined` e derrubar a pagina
   * inteira. Ver `destroy?:` em core/src/game/ads-timeline.ts.
   */
  destroy?: string[];
  /** CUI cru: o preview lê o RectTransform e a cor daqui. */
  cui?: Record<string, unknown>[];
}

export interface AdsAnimation {
  durationMs: number;
  frames: AdsFrame[];
}

export interface AdsTimeline {
  root: Record<string, unknown>[];
  opening: AdsAnimation;
  adEnter: AdsAnimation;
  adExit: AdsAnimation;
  closing: AdsAnimation;
}

/** O que `GET /ads` devolve: as três coisas de que a tela precisa. */
export interface AdsView {
  ok: true;
  settings: AdsSettings;
  ads: Advertisement[];
  timeline: AdsTimeline;
}

/**
 * O overlay inteiro como texto, para levar de um servidor a outro.
 *
 * O tipo é frouxo de propósito: quem confere é o agente, com o
 * mesmo schema nas duas pontas. Espelhar aqui os trinta e poucos
 * campos do ajuste criaria uma segunda régua que só divergiria da
 * primeira — e o navegador não tem nada a decidir sobre o
 * conteúdo, só a transportá-lo.
 */
export interface AdsPackage {
  kind: string;
  version: number;
  exportedFrom?: string;
  exportedAt?: string;
  settings: Record<string, unknown>;
  ads: Record<string, unknown>[];
}

/** O que `POST /ads/import` devolve: a vista já refeita. */
export interface AdsImportResult extends AdsView {
  /** Quantas foram apagadas. Sempre 0 no modo que acrescenta. */
  removed: number;
  created: number;
}

/** O desfecho de um `POST /ads/sync`. */
export interface AdsSyncResult {
  ok: boolean;
  status: 'sent' | 'skipped' | 'refused' | 'failed';
  ads?: number;
  bytes?: number;
  reason?: string;
  message?: string;
}

/** Os grupos e permissões do Oxide daquele servidor. */
export interface AdsAudience {
  ok: true;
  /** `false` = sem RCON ou plugin antigo. A tela cai no campo livre. */
  available: boolean;
  groups: string[];
  permissions: string[];
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

// ----------------------------------------------------------
//  O RANKING
//
//  ####  ELES ESPELHAM `core/src/http/routes/rankings.ts`  ####
//
//  O painel duplica à mão os tipos do core, de propósito — não há
//  pacote compartilhado. O que atravessa a borda é o que as funções
//  `toRankingBody`, `toPeriodBody`, `toPeriodViewBody`,
//  `toCoverageBody`, `toEntryBody` e `toSnapshotBody` de lá
//  produzem: instante em ISO, e `null` sobrevivendo como `null`.
//
//  Ver Docs\Ranking\20-PLANO-E-CONTRATOS.md §9.
// ----------------------------------------------------------

/** De onde o número vem. */
export type RankingSource = 'plugin' | 'agent' | 'item' | 'computed';

/** Como o valor se forma: soma, melhor marca, ou divisão. */
export type RankingValueKind = 'counter' | 'record' | 'ratio';

export type RankingDirection = 'desc' | 'asc';

/** O papel de uma janela — e, num ranking, a janela em que ele disputa. */
export type RankingPeriodKind = 'wipe' | 'season' | 'lifetime';

export type RankingScope = 'server' | 'global';

export type RankingSeasonMode = 'wipe' | 'biweekly' | 'monthly' | 'quarterly' | 'days' | 'manual';

/**
 * Como a coleta daquele servidor estava.
 *
 * NÃO é um booleano, e é essa a razão de o campo existir: um
 * servidor em `not-loaded` que virasse lista vazia diria que
 * ninguém pontuou ali — uma afirmação sobre os jogadores, quando a
 * verdade é sobre a coleta.
 */
export type RankingCoverageStatus = 'ok' | 'never' | 'not-loaded' | 'no-answer';

/** A definição de um ranking. Fixo e dinâmico são a mesma linha. */
export interface RankingDefinition {
  /** Slug estável: é o que a URL do painel e o site guardam. */
  id: string;
  /** A chave em `player_stats`. Única entre os rankings. */
  metric: string;
  label: string;
  /**
   * O nome que cabe na aba do JOGO, onde a coluna é estreita.
   *
   * `null` = não tem, e vale o `label`. Quem resolve isso é o
   * `gameLabelOf` do core, num lugar só — o painel edita o campo
   * e mostra o `label` como espelho.
   */
  shortLabel: string | null;
  /** "abates", "troféus", "metros". `null` quando o número não tem unidade. */
  unit: string | null;
  description: string | null;
  source: RankingSource;
  valueKind: RankingValueKind;
  direction: RankingDirection;
  /** Em que janela ele DISPUTA — a que a tela abre, e a única cuja virada o zera. */
  window: RankingPeriodKind;
  /** Entra na soma da rede? `false` para minério e explosivo. */
  globalEligible: boolean;
  /** Veio semeado com o agente: o painel some com o botão de apagar. */
  builtin: boolean;
  enabled: boolean;
  /**
   * Aparece no menu do jogo? NÃO é o mesmo que `enabled`.
   *
   * Desligado, o ranking some de todo lugar; com isto em `false`
   * ele sai só do menu do jogo e continua no painel, no site e na
   * contagem.
   */
  showInGame: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** O corpo que cria ou reescreve um ranking. `builtin` não se digita. */
export interface RankingDefinitionInput {
  id: string;
  metric: string;
  label: string;
  /** Vazio vira `null` na escrita, e a API recusa acima de 24. */
  shortLabel: string | null;
  unit: string | null;
  description: string | null;
  source: RankingSource;
  valueKind: RankingValueKind;
  direction: RankingDirection;
  window: RankingPeriodKind;
  globalEligible: boolean;
  enabled: boolean;
  showInGame: boolean;
  /**
   * Opcional, e sem valor padrão na tela.
   *
   * A ordem se muda arrastando (`reorderRankings`). Mandá-la num
   * PUT de edição desfaria um arrasto feito entre o carregamento
   * do formulário e o clique em salvar. Ausente na criação = o
   * agente põe no fim da lista.
   */
  sortOrder?: number;
}

/** Uma janela do banco: (servidor, papel, começo). */
export interface RankingPeriod {
  id: number;
  serverId: string;
  kind: RankingPeriodKind;
  /** A linha de `wipes` que abriu esta janela, quando houve uma. */
  wipeId: number | null;
  label: string | null;
  /** Como o modo estava configurado QUANDO ela abriu. */
  seasonMode: RankingSeasonMode | null;
  startedAt: string;
  /** `null` = ainda aberta. */
  endedAt: string | null;
}

/**
 * A janela em que a lista foi lida.
 *
 * No escopo de rede ela não tem `id`: são várias janelas somadas, e
 * eleger uma delas como "a" janela seria mentira.
 */
export interface RankingPeriodView {
  id: number | null;
  kind: RankingPeriodKind;
  serverId: string | null;
  label: string | null;
  seasonMode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Quando ela vira, se ninguém mexer. `null` = não tem data. */
  turnsAt: string | null;
}

export interface RankingCoverageServer {
  serverId: string;
  status: RankingCoverageStatus;
  /**
   * O aviso pronto, do MESMO módulo que a tela do jogo lê.
   *
   * O painel não escreve a sua versão: as duas divergiriam no
   * primeiro ajuste de texto, e o admin e o jogador passariam a
   * ler histórias diferentes sobre o mesmo defeito. `null` em
   * `ok` — não há aviso quando não há o que avisar.
   */
  message: string | null;
  lastBatchAt: string | null;
}

export interface RankingCoverage {
  servers: RankingCoverageServer[];
}

/** Uma linha da lista, com a colocação já calculada. */
export interface RankingEntry {
  position: number;
  steamId: string;
  /** `null` quando o jogador saiu da base. */
  name: string | null;
  value: number;
  updatedAt: string;
}

/** Uma linha do pódio CONGELADO: ela não muda mais. */
export interface RankingSnapshotEntry {
  position: number;
  steamId: string;
  /** O nome de quando ele ganhou, copiado no fechamento. */
  name: string | null;
  value: number;
  frozenAt: string;
}

/** A janela configurada de um servidor. */
export interface RankingSettings {
  seasonMode: RankingSeasonMode;
  seasonDays: number | null;
  seasonAnchorAt: string | null;
  /** A temporada TAMBÉM vira quando o mundo vira? */
  seasonOnWipe: boolean;
  /** Quantas posições o pódio congela ao fechar. */
  snapshotSize: number;
  /** `null` = o servidor nunca foi configurado; valem os padrões. */
  updatedAt: string | null;
}

export interface RankingSettingsInput {
  seasonMode: RankingSeasonMode;
  seasonDays: number | null;
  /** ISO, ou epoch em ms. `null` = a abertura do período serve de âncora. */
  seasonAnchorAt: string | null;
  seasonOnWipe: boolean;
  snapshotSize: number;
}

export interface RankingMetricsResponse {
  ok: true;
  count: number;
  rankings: RankingDefinition[];
}

export interface RankingListResponse {
  ok: true;
  /** O que veio nesta página. */
  count: number;
  /** A lista inteira, antes da paginação. */
  total: number;
  limit: number;
  offset: number;
  ranking: RankingDefinition;
  scope: RankingScope;
  period: RankingPeriodView;
  /** Veio do pódio congelado? Aí ela não muda mais. */
  frozen: boolean;
  measuredSince: string | null;
  updatedAt: string | null;
  coverage: RankingCoverage;
  entries: RankingEntry[];
}

export interface RankingPeriodsResponse {
  ok: true;
  count: number;
  total: number;
  limit: number;
  offset: number;
  periods: RankingPeriod[];
}

export interface RankingPeriodDetailResponse {
  ok: true;
  period: RankingPeriod;
  podium: { metric: string; label: string; entries: RankingSnapshotEntry[] }[];
}

export interface RankingSettingsResponse {
  ok: true;
  serverId: string;
  settings: RankingSettings;
  /** A temporada mais recente daquele servidor. `null` = nenhuma ainda. */
  season: RankingPeriod | null;
}

/** O que a virada devolve: a que fechou, a que abriu, e quantas linhas congelaram. */
export interface RankingSeasonTurnResponse {
  ok: true;
  closed: RankingPeriod;
  opened: RankingPeriod;
  frozen: number;
}

// ------------------------------------------------------------
//  O LOOT
//
//  ####  UMA REGRA ACRESCENTA; ELA NÃO REESCREVE A TABELA  ####
//
//  A configuração do jogo continua sendo do jogo — o plugin deixa
//  o container nascer cheio e SÓ ACRESCENTA por cima. É a decisão
//  do Docs/CustomItem/05 §4, e ela é o que faz a configuração
//  sobreviver a um update do Rust: o que ninguém tocou continua
//  acompanhando a Facepunch.
//
//  ####  E O ITEM É SEMPRE NOSSO  ####
//
//  Um item do jogo puro nasceria do loot com skin 0 — sem marca,
//  o plugin não o reconhece e ele não vira ponto (05 §3.4). Por
//  isso a regra aponta para um `custom_items`, e não para um
//  shortname.
// ------------------------------------------------------------

/**
 * Medindo ou valendo.
 *
 * `measuring` NÃO CRIA ITEM NENHUM: a regra é sorteada, o
 * resultado é contado, e nada cai na caixa. É como se descobre
 * quantas vezes por dia aquela chance dispararia antes de soltá-la
 * no servidor — o denominador real (containers populados por dia)
 * não é medido em lugar nenhum (05 §9.6).
 */
export type LootRuleMode = 'measuring' | 'live';

export interface LootRule {
  /** Nasce do nome e não muda depois: é o que a URL e o stats usam. */
  id: string;
  /** O que o admin lê na lista. */
  label: string;
  /** O id em `custom_items`. Item nosso, sempre — ver o cabeçalho. */
  customItemId: string;
  /** `ShortPrefabName` de cada container em que a regra vale. */
  containers: string[];
  /** 0 a 1, por container populado. `0.0001` é uma em dez mil. */
  chance: number;
  amountMin: number;
  amountMax: number;
  mode: LootRuleMode;
  /** Teto por servidor e por dia. `null` = sem teto. */
  dailyCap: number | null;
  /** O mesmo jogador não acha outro nessas horas. `null` = sem carência. */
  playerCooldownHours: number | null;
  enabled: boolean;
  /** Vazio = em nenhum servidor, como em `custom_item_servers`. */
  servers: string[];
}

/** O corpo que cria ou reescreve uma regra. O PUT é total, não PATCH. */
export type LootRuleInput = LootRule;

/**
 * Um container que o plugin aceita.
 *
 * `label` e `group` são do AGENTE quando ele os manda; o painel
 * tem os dele para quando não vierem (ver `components/loot/containers.ts`).
 */
export interface LootContainerInfo {
  /** `ShortPrefabName` — é o que o plugin casa, e é a identidade. */
  name: string;
  /** Nome que o admin reconhece. `null` = o painel resolve. */
  label: string | null;
  /** A natureza (barril, caixa de risco, evento…). `null` = idem. */
  group: string | null;
  /**
   * De quantos em quantos segundos o container refaz o loot.
   *
   * `null` é "não sei", e não "nunca": 71 dos 105 têm refresh
   * finito (05 §2.6), e é ele que faz a regra valer de novo sem
   * ninguém abrir nada.
   */
  refreshSeconds: number | null;
}

/** Um dia de contagem de uma regra. */
export interface LootRuleStatsDay {
  /** `AAAA-MM-DD`, no fuso do agente. */
  day: string;
  /** Quantas vezes a regra disparou — ou TERIA disparado, em medição. */
  rolls: number | null;
  /** Quantos itens saíram de verdade. Zero enquanto o modo é medição. */
  emitted: number | null;
  /** Quantos containers a regra viu naquele dia. `null` = o agente não conta. */
  containers: number | null;
}

export interface LootRulesResponse {
  ok: true;
  count: number;
  rules: LootRule[];
}

export interface LootContainersResponse {
  ok: true;
  count: number;
  containers: LootContainerInfo[];
}

export interface LootRuleStatsResponse {
  ok: true;
  ruleId: string;
  mode: LootRuleMode;
  /** Do dia mais velho para o mais novo. Vazio = ainda não contou nada. */
  days: LootRuleStatsDay[];
}

// ------------------------------------------------------------
//  O EDITOR DE LOOT: a configuração do BetterLoot
//
//  ####  ESTA FATIA EDITA O ARQUIVO DE UM PLUGIN DE TERCEIRO  ####
//
//  A decisão do dono (Docs/CustomItem/06 §0) é que o painel
//  configura TODO o loot do jogo editando os JSONs do BetterLoot,
//  em vez de construirmos motor de loot. É o papel que o Looty
//  cumpre por fora; nós o cumprimos de dentro do servidor.
//
//  Isso convive com as `loot_rules` acima, e as duas NÃO são a
//  mesma coisa: a regra é do nosso plugin e sabe teto por dia,
//  carência por jogador e medição; a tabela é do BetterLoot e sabe
//  encher a caixa inteira. O §3.5 daquele documento tem a divisão
//  linha a linha.
//
//  ####  A IDENTIDADE É O CAMINHO INTEIRO DO PREFAB  ####
//
//  `assets/bundled/prefabs/radtown/crate_elite.prefab`, e não
//  `crate_elite`. Ele tem barra e às vezes espaço (`dmloot/dm
//  ammo.prefab`), e por isso viaja em QUERY STRING, nunca em
//  pedaço de caminho.
//
//  ####  O ARQUIVO NÃO CABE NUMA RESPOSTA  ####
//
//  Medido: 2,53 MB, 111 prefabs, 6.824 entradas. A lista devolve
//  RESUMO por prefab; o conteúdo de uma caixa é uma segunda
//  chamada. Mandar tudo junto seria uma resposta de megabytes para
//  uma tela que mostra uma caixa por vez.
//
//  ####  SALVAR SUBSTITUI O ARQUIVO INTEIRO  ####
//
//  O plugin serializa o dicionário todo — não há merge. Duas telas
//  abertas na mesma caixa fariam a segunda apagar a primeira em
//  silêncio, e é por isso que existe a `revision` abaixo.
// ------------------------------------------------------------

/**
 * Um item que sai JUNTO com outro (`Bonus Items`).
 *
 * Ele não conta como sorteio: quem o traz é a entrada dona. É o
 * "rifle com munição" que o mercado vende como recurso avançado.
 */
export interface BetterLootBonusItem {
  /** A chave do arquivo, com o sufixo `{n}` quando existe. */
  key: string;
  shortname: string;
  /** `'0'` = a skin do jogo. String porque é `ulong` — ver §818. */
  skinId: string;
  /** O nome que o plugin carimba. `null` = nenhum. */
  customName: string | null;
  min: number;
  max: number;
}

/** Um item que sai SEMPRE, sem sorteio (`Guaranteed Items`). */
export interface BetterLootGuaranteedEntry {
  key: string;
  shortname: string;
  /** O nome do item no catálogo do agente. `null` = ele não o conhece. */
  displayName: string | null;
  skinId: string;
  customName: string | null;
  min: number;
  max: number;
}

/** Uma entrada de `Ungrouped Items` — o corpo da tabela de uma caixa. */
export interface BetterLootEntry {
  /**
   * A CHAVE do arquivo. É a identidade, e pode ter sufixo `{n}`.
   *
   * O plugin remove `{\d+}` antes de resolver o item, o que deixa o
   * mesmo shortname entrar várias vezes com skins diferentes. É o
   * que faz um catálogo de itens nossos caber numa caixa só.
   */
  key: string;
  /** A chave sem o sufixo — o item que o jogo conhece. */
  shortname: string;
  /** O nome do item no catálogo do agente. `null` = ele não o conhece. */
  displayName: string | null;
  skinId: string;
  customName: string | null;
  min: number;
  max: number;
  allowDuplicates: boolean;
  /** `null` = o plugin decide sozinho (o item não é pesquisável). */
  canConvertToBlueprint: boolean | null;
  /** Em PORCENTAGEM da condição, não em pontos. `null` = o item não tem. */
  durability: { min: number; max: number } | null;
  /**
   * A raridade do item NO JOGO, 0 a 4.
   *
   * ####  É ELA QUE DECIDE A CHANCE, E O ARQUIVO NÃO A TEM  ####
   *
   * Uma entrada de `Ungrouped Items` não carrega probabilidade: o
   * plugin lê `ItemDefinition.rarity` do jogo e pesa por ela. Sem
   * este campo a tela NÃO CONSEGUE mostrar porcentagem nenhuma — e
   * a saída certa é o travessão, nunca um zero.
   *
   * `null` = o agente não soube dizer.
   */
  rarity: number | null;
  bonusItems: BetterLootBonusItem[];
  /**
   * O item tem `Item Properties` (munição e acessórios de arma).
   *
   * A tela não edita isso e diz que não edita: o plugin reescreve
   * esse bloco sozinho ao validar, removendo acessório incompatível
   * (`scanEntry`, BetterLoot.cs:2140). Prometer edição aqui seria
   * prometer o que o plugin desfaz.
   */
  hasWeaponProperties: boolean;
}

/** Quanto sai de cada coisa numa caixa (`Item Settings`). */
export interface BetterLootItemSettings {
  /** O jogo limita o total a 36, e a 1 no piso (BetterLoot.cs:2349). */
  minItems: number;
  maxItems: number;
  minScrap: number;
  maxScrap: number;
  minBlueprints: number;
  maxBlueprints: number;
  bonusItemsCountToTotal: boolean;
  guaranteedItemsCountToTotal: boolean;
}

/** Um grupo de `LootGroups.json` associado a uma caixa (`Loot Profiles`). */
export interface BetterLootProfileLink {
  /** Aponta para uma chave de `LootGroups.json`. */
  name: string;
  enabled: boolean;
  /** 1 a 100. É cumulativa entre os perfis, e não absoluta. */
  probability: number;
  /** `0` = sem limite. */
  maxItems: number;
}

/** A linha da lista de caixas: o que cabe sem abrir a tabela. */
export interface BetterLootTableSummary {
  /** O caminho inteiro do prefab. É a identidade — ver o cabeçalho. */
  prefab: string;
  /** Desligado devolve a caixa ao loot NATIVO, e não a caixa vazia. */
  enabled: boolean;
  itemCount: number;
  guaranteedCount: number;
  profileCount: number;
  itemSettings: BetterLootItemSettings;
}

/** A tabela de uma caixa, inteira. */
export interface BetterLootTable extends BetterLootTableSummary {
  /** Trava o sorteio num perfil só por caixa. */
  poolLocking: boolean;
  /** Sorteio uniforme em vez de enviesado por raridade — ver `rarity`. */
  ignoreRarityBias: boolean;
  profiles: BetterLootProfileLink[];
  guaranteed: BetterLootGuaranteedEntry[];
  items: BetterLootEntry[];
}

/**
 * O que vale para o SERVIDOR INTEIRO (`BetterLoot.json`).
 *
 * ####  OS MULTIPLICADORES SÃO GLOBAIS E INTEIROS  ####
 *
 * Não existe 2x só nos barris, e não existe 1,5x. Quem quer
 * multiplicar uma caixa só mexe no `Item Minimum`/`Item Maximum`
 * das entradas dela. E eles multiplicam a QUANTIDADE, não a
 * chance: 5x não dá cinco vezes mais itens, dá os mesmos itens com
 * quantidade cinco vezes maior.
 */
export interface BetterLootGlobals {
  lootMultiplier: number;
  scrapMultiplier: number;
  /** 0 a 1. Quanto do sorteio vira projeto em vez de item. */
  blueprintWeight: number;
  blueprintConversion: boolean;
  allowDuplicates: boolean;
  poolLocking: boolean;
}

/**
 * O que a tela pode MUDAR nos globais.
 *
 * ####  QUATRO CAMPOS, E NÃO OS SEIS QUE SE LEEM  ####
 *
 * `allowDuplicates` e `poolLocking` são lidos e mostrados, mas não
 * são editáveis aqui: eles mudam o SORTEIO (se o mesmo item pode
 * sair duas vezes, se a caixa trava num perfil), e não a escala do
 * loot. O pedido é o multiplicador; levar os outros dois de carona
 * seria mexer no que ninguém pediu.
 */
export interface BetterLootGlobalsInput {
  /** Inteiro ≥ 1 — é `int` no plugin, e zero zeraria o servidor. */
  lootMultiplier: number;
  scrapMultiplier: number;
  /** 0 a 1, como o arquivo guarda. A tela é que fala em %. */
  blueprintWeight: number;
  blueprintConversion: boolean;
}

/** O corpo do PUT dos globais. A revisão é a do `BetterLoot.json`. */
export interface BetterLootGlobalsSaveInput {
  baseRevision: string | null;
  globals: BetterLootGlobalsInput;
}

/** `PUT /api/servers/:id/betterloot/globals` — a resposta, relida do disco. */
export interface BetterLootGlobalsResponse {
  ok: true;
  serverId: string;
  /** A revisão NOVA do `BetterLoot.json`. */
  revision: string;
  /** `null` = o arquivo ficou ilegível. A tela mostra travessão. */
  globals: BetterLootGlobals | null;
  /** Onde ficou a cópia anterior. `null` = não havia arquivo. */
  backup: string | null;
  reloaded: boolean;
  reloadOutput: string | null;
}

/** `GET /api/servers/:id/betterloot` — a lista, e o estado do plugin ali. */
export interface BetterLootStatusResponse {
  ok: true;
  serverId: string;
  /** O plugin está carregado naquele servidor? `null` = não deu para perguntar. */
  loaded: boolean | null;
  version: string | null;
  /** Quando o agente leu o disco. `null` = nunca leu. */
  readAt: string | null;
  /**
   * A impressão do `LootTables.json` no disco.
   *
   * A tela devolve a mesma no PUT; o agente recusa quando ela não
   * bate. É o que impede duas telas abertas de uma apagar a outra —
   * o mesmo papel do `appliedSha` da biblioteca de plugins.
   */
  revision: string | null;
  /**
   * A impressão do `BetterLoot.json` — a revisão dos GLOBAIS.
   *
   * ####  DOIS ARQUIVOS, DUAS REVISÕES  ####
   *
   * A `revision` acima é da tabela; esta é da configuração. Uma só
   * faria gravar o multiplicador recusar o próximo salvamento de
   * caixa, porque recarregar o plugin reescreve o `LootTables.json`
   * sozinho.
   */
  configRevision: string | null;
  globals: BetterLootGlobals | null;
  /** Os shortnames banidos (`Blacklist.json`). É global, não por caixa. */
  blacklist: string[];
  count: number;
  tables: BetterLootTableSummary[];
}

/** `GET /api/servers/:id/betterloot/table?prefab=…` — uma caixa. */
export interface BetterLootTableResponse {
  ok: true;
  serverId: string;
  /**
   * A impressão DESTA CAIXA. É ela que o PUT quer de volta.
   *
   * ####  ELA NÃO É A DO ARQUIVO, E A DIFERENÇA IMPORTA  ####
   *
   * O agente grava fazendo merge por caixa: as outras 110 saem do
   * disco na hora da gravação. Só a caixa aberta pode entrar em
   * conflito de verdade — e usar a impressão do arquivo inteiro
   * fazia toda SEGUNDA gravação ser recusada, porque recarregar o
   * plugin reescreve o arquivo sozinho.
   */
  tableRevision: string;
  /** Só no PUT: a do arquivo inteiro, para a lista. */
  revision?: string | null;
  table: BetterLootTable;
}

/**
 * O corpo do PUT de uma caixa.
 *
 * A resposta vem RELIDA DO DISCO depois do `oxide.reload`, e não é
 * o que foi enviado: o plugin preenche durabilidade, propriedades e
 * "pode virar blueprint" sozinho ao validar (`scanEntry`). O que se
 * escreve não é o que fica.
 */
export interface BetterLootSaveInput {
  /**
   * O `tableRevision` com que a tela abriu ESTA CAIXA. `null` = a
   * tela não viu nenhuma, e grava por cima do que houver.
   */
  baseRevision: string | null;
  table: BetterLootTable;
}


// ------------------------------------------------------------
//  OS PERFIS DE LOOT — o `LootGroups.json`
// ------------------------------------------------------------
//
//  ####  É O QUE O LOOTY CHAMA DE "LOOT PROFILE"  ####
//
//  Não é abstração de tela: um perfil é uma entrada do
//  `LootGroups.json`, OUTRO arquivo do BetterLoot. Ele agrupa itens
//  com PESO próprio — ao contrário dos itens soltos de uma caixa,
//  que saem por raridade do jogo.
//
//  ####  E O PERFIL NÃO SABE EM QUE CAIXA ELE ENTRA  ####
//
//  Quem sabe é a caixa, no campo `profiles` da tabela dela. São dois
//  arquivos, e por isso duas telas: a lista de perfis, e o bloco
//  "perfis desta caixa" dentro do editor de caixa.

/** Um item dentro de um perfil: uma entrada de caixa, com peso. */
export interface BetterLootProfileItem extends BetterLootEntry {
  /**
   * O peso dentro do perfil, de 0 a 100.
   *
   * A SOMA dos itens deve dar 100. Se não der, o BetterLoot
   * rebalanceia sozinho no próximo carregamento — e o admin vê
   * números diferentes dos que digitou. A tela avisa antes.
   */
  probability: number;
}

/** A linha da lista de perfis. */
export interface BetterLootProfileSummary {
  name: string;
  enabled: boolean;
  itemCount: number;
  guaranteedCount: number;
  /** A soma dos pesos. Diferente de 100, o plugin rebalanceia. */
  probabilitySum: number;
  /**
   * Os prefabs das caixas que pedem este perfil.
   *
   * É o que a tela mostra antes de apagar — o Looty não diz isto,
   * ele apaga e desfaz a associação em silêncio.
   */
  usedBy: string[];
  /** A impressão DESTE perfil. É o que o PUT quer de volta. */
  revision: string;
}

/** Um perfil inteiro. */
export interface BetterLootProfile {
  name: string;
  enabled: boolean;
  guaranteed: BetterLootGuaranteedEntry[];
  items: BetterLootProfileItem[];
}

/** `GET /api/servers/:id/betterloot/profiles` */
export interface BetterLootProfilesResponse {
  ok: true;
  serverId: string;
  /** `false` = não existe LootGroups.json ali. NÃO é erro. */
  configured: boolean;
  revision: string | null;
  count: number;
  profiles: BetterLootProfileSummary[];
}

/** `GET`/`PUT /api/servers/:id/betterloot/profile` */
export interface BetterLootProfileResponse {
  ok: true;
  serverId: string;
  revision: string;
  profile: BetterLootProfile;
  backup?: string | null;
  reloaded?: boolean;
  reloadOutput?: string | null;
}

/** O corpo do PUT de um perfil. `baseRevision: null` = criando. */
export interface BetterLootProfileSaveInput {
  baseRevision: string | null;
  profile: BetterLootProfile;
}

/** O corpo do rename. A revisão é a do perfil que está mudando de nome. */
export interface BetterLootProfileRenameInput {
  from: string;
  to: string;
  baseRevision: string | null;
}

/** `POST /api/servers/:id/betterloot/profile/rename` */
export interface BetterLootProfileRenameResponse {
  ok: true;
  serverId: string;
  revision: string;
  profile: BetterLootProfile;
  /** As caixas cuja citação foi reescrita. */
  retargeted: string[];
  backup: string | null;
  reloaded: boolean;
  reloadOutput: string | null;
}

/** `DELETE /api/servers/:id/betterloot/profile` */
export interface BetterLootProfileDeleteResponse {
  ok: true;
  serverId: string;
  /** As caixas de onde a associação saiu junto. */
  detached: string[];
  backup: string | null;
  reloaded: boolean;
  reloadOutput: string | null;
}

// ------------------------------------------------------------
//  O LIXO — a lista de curadoria
// ------------------------------------------------------------
//
//  ####  ELA NÃO É DO BETTERLOOT  ####
//
//  O plugin não conhece a palavra "junk": a lista é NOSSA, mora no
//  banco do agente e é por servidor. O que chega ao jogo é a caixa
//  já sem esses itens — e quem os tira é esta tela, montando o
//  rascunho sem eles. O "Gravar" da caixa é que leva ao servidor,
//  com o mesmo backup e o mesmo "descartar" de sempre.

/** Uma linha da lista de lixo. */
export interface BetterLootJunkItem {
  shortname: string;
  /**
   * Veio da lista de fábrica?
   *
   * A tela separa os dois: o padrão desligado pode voltar; o que o
   * admin acrescentou some de vez.
   */
  isDefault: boolean;
  active: boolean;
}

/** `GET`/`POST`/`DELETE /api/servers/:id/betterloot/junk` */
export interface BetterLootJunkResponse {
  ok: true;
  serverId: string;
  /** Quantos estão ATIVOS. O `items` traz os desligados também. */
  count?: number;
  items: BetterLootJunkItem[];
}

// ============================================================
//  AS MISSOES
//
//  ####  A DEFINICAO E DE REDE; O PROGRESSO E DE SERVIDOR  ####
//
//  Uma quest e escrita uma vez e vale em todos os servidores - como
//  VIP, kit e loja. O que conta separado em cada mundo e o
//  PROGRESSO, e e por isso que toda linha de progresso carrega o
//  serverId enquanto a quest nao carrega.
//
//  ####  AS DATAS AQUI SAO EPOCH, E NAO ISO  ####
//
//  Ao contrario do ranking. A razao e esta tela: ela faz contas de
//  tempo (quanto falta do cooldown, quanto durou a tentativa), e ISO
//  a obrigaria a reconverter tudo.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §11 e §12.
// ============================================================

export type QuestRepeatMode = 'once' | 'cooldown' | 'daily' | 'weekly';

export type QuestObjectiveKind =
  | 'kill'
  | 'gather'
  | 'craft'
  | 'loot'
  | 'deliver'
  | 'playtime'
  | 'metric';

export type QuestRewardKind = 'item' | 'coins' | 'kit' | 'points' | 'vip';

export type PlayerQuestStatus = 'active' | 'completed' | 'claimed' | 'abandoned';

export interface QuestObjective {
  seq: number;
  kind: QuestObjectiveKind;
  /** Shortname, nome de criatura ou id de NPC. `null` em playtime/metric. */
  target: string | null;
  /** So em `metric`. */
  metric: string | null;
  amount: number;
  /** Sobrescreve a frase montada pelo agente. */
  label: string | null;
  /** Tira os itens do inventario no resgate. So em loot/gather. */
  consume: boolean;
}

/**
 * A recompensa, achatada.
 *
 * O `kind` decide quais campos existem - e o mesmo formato que a
 * API recebe, e o formulario monta um objeto por vez.
 */
export type QuestReward =
  | { kind: 'item'; shortname: string; amount: number; skinId: string }
  | {
      kind: 'coins';
      amount: number | null;
      perMeter: number | null;
      min: number | null;
      max: number | null;
    }
  | { kind: 'kit'; slug: string }
  | { kind: 'points'; metric: string; amount: number }
  | { kind: 'vip'; tier: string; days: number };

export interface QuestDefinition {
  id: string;
  title: string;
  description: string | null;
  category: string;
  enabled: boolean;
  sort: number;
  /** `vip:ouro`, ou uma permissao do Oxide. `null` = todo mundo. */
  requires: string | null;
  /** `null` = aparece no menu; preenchido = so perto daquele NPC. */
  npcId: string | null;
  repeatMode: QuestRepeatMode;
  cooldownSeconds: number;
  requiresQuest: string | null;
  availableFrom: number | null;
  availableTo: number | null;
  autoAccept: boolean;
  wipePolicy: 'reset' | 'keep';
  /** Vazia = vale em TODOS os servidores. */
  servers: string[];
  objectives: QuestObjective[];
  rewards: QuestReward[];
  createdAt: number;
  updatedAt: number;
}

/** O corpo que a API recebe: a quest sem os campos que ela gera. */
export type QuestInput = Omit<QuestDefinition, 'id' | 'createdAt' | 'updatedAt'>;

export interface QuestObjectiveView {
  seq: number;
  /** A frase ja montada pelo agente, com o nome bonito do item. */
  label: string;
  have: number;
  need: number;
  done: boolean;
}

/**
 * Uma tentativa.
 *
 * E o MESMO corpo que a tela do jogo recebe, mais os campos de
 * quem/onde - duas formas para a mesma tentativa dariam duas
 * contagens de progresso.
 */
export interface QuestProgressRow {
  playerQuestId: number;
  questId: string;
  title: string;
  status: PlayerQuestStatus;
  objectives: QuestObjectiveView[];
  rewards: QuestReward[];
  complete: boolean;
  acceptedAt: number;
  completedAt: number | null;
  claimedAt: number | null;
  cooldownUntil: number | null;
  serverId: string;
  steamId: string;
  attempt: number;
}

export interface QuestNpc {
  id: string;
  serverId: string;
  name: string;
  kind: 'quest' | 'delivery';
  x: number;
  y: number;
  z: number;
  rotation: number;
  prefab: string;
  mapMarker: boolean;
  useRadius: number;
  enabled: boolean;
  wipePolicy: 'keep' | 'remove';
  /** As quests que apontam para ele. E o aviso do botao de apagar. */
  quests: string[];
  createdAt: number;
  updatedAt: number;
}

export interface QuestSettingsRow {
  serverId: string;
  maxActive: number;
  enabled: boolean;
  flushSeconds: number;
  lootEnabled: boolean;
  resetAtMinute: number;
  updatedAt: number | null;
}

export interface QuestEvent {
  id: number;
  eventId: string | null;
  serverId: string;
  steamId: string;
  questId: string;
  attempt: number;
  kind: 'accept' | 'progress' | 'complete' | 'claim' | 'abandon' | 'reset' | 'reward_failed';
  detail: unknown;
  source: 'plugin' | 'agent' | 'panel' | 'wipe';
  actor: string | null;
  at: number;
}

export interface QuestRewardOutcome {
  kind: QuestRewardKind;
  ok: boolean;
  message: string;
  code: string | null;
}

export interface QuestClaimResult {
  playerQuestId: number;
  questId: string;
  outcomes: QuestRewardOutcome[];
  pending: boolean;
}

export const agent = {
  // ---- as missoes ----

  quests: (options: { category?: string; serverId?: string } = {}) => {
    const query = new URLSearchParams();

    if (options.category !== undefined) {
      query.set('category', options.category);
    }

    if (options.serverId !== undefined) {
      query.set('serverId', options.serverId);
    }

    const suffix = query.toString();

    return api<{ quests: QuestDefinition[] }>(`/api/quests${suffix === '' ? '' : `?${suffix}`}`);
  },

  questCategories: () =>
    api<{ categories: { category: string; total: number }[] }>('/api/quests/categories'),

  // ####  NÃO HÁ `quest(id)` NEM `questOffers()` AQUI  ####
  //
  // As duas rotas existem na API — `GET /quests/:id` e
  // `GET /quests/offers` —, e quem as consome é o SITE e a tela do
  // jogo, não este painel: ele lê a lista inteira de uma vez, e o
  // `liveCount` chega na recusa do DELETE, que é onde ele importa.
  //
  // Um método de cliente que ninguém chama é uma promessa de que
  // alguma tela o usa. Ver §11.4 do plano.

  createQuest: (body: QuestInput) =>
    api<{ quest: QuestDefinition }>('/api/quests', { method: 'POST', body }),

  updateQuest: (id: string, body: QuestInput) =>
    api<{ quest: QuestDefinition }>(`/api/quests/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body,
    }),

  /** A ordem vai INTEIRA: uma lista parcial e recusada pela API. */
  reorderQuests: (ids: string[]) =>
    api<{ quests: QuestDefinition[] }>('/api/quests/order', { method: 'PUT', body: { ids } }),

  duplicateQuest: (id: string, title?: string) =>
    api<{ quest: QuestDefinition }>(`/api/quests/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      body: title === undefined ? {} : { title },
    }),

  /**
   * Apaga.
   *
   * Sem `force`, a API recusa com `QUEST_IN_USE` e a contagem de
   * quem esta no meio dela - e o que a tela mostra antes do segundo
   * clique.
   */
  removeQuest: (id: string, force = false) =>
    api<{ removed: boolean; live: number }>(
      `/api/quests/${encodeURIComponent(id)}${force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    ),

  /** Exige `steamId` OU `questId`: sem recorte a API recusa. */
  questProgress: (options: {
    steamId?: string;
    questId?: string;
    serverId?: string;
    status?: PlayerQuestStatus;
    limit?: number;
  }) => {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    }

    return api<{ progress: QuestProgressRow[] }>(`/api/quests/progress?${query.toString()}`);
  },

  playerQuests: (steamId: string, options: { serverId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();

    if (options.serverId !== undefined) {
      query.set('serverId', options.serverId);
    }

    if (options.limit !== undefined) {
      query.set('limit', String(options.limit));
    }

    const suffix = query.toString();

    return api<{ quests: QuestProgressRow[] }>(
      `/api/players/${steamId}/quests${suffix === '' ? '' : `?${suffix}`}`,
    );
  },

  questEvents: (options: { steamId?: string; questId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    }

    const suffix = query.toString();

    return api<{ events: QuestEvent[] }>(`/api/quests/events${suffix === '' ? '' : `?${suffix}`}`);
  },

  questPendingRewards: () =>
    api<{ pending: (QuestEvent & { attempt: QuestProgressRow | null })[] }>(
      '/api/quests/rewards/pending',
    ),

  grantQuest: (id: string, body: { serverId: string; steamId: string; actor?: string }) =>
    api<{ quest: QuestProgressRow }>(`/api/quests/${encodeURIComponent(id)}/grant`, {
      method: 'POST',
      body,
    }),

  setQuestProgress: (
    playerQuestId: number,
    body: { objectiveSeq: number; value: number; actor?: string; reason?: string },
  ) =>
    api<{ quest: QuestProgressRow }>(`/api/quests/progress/${String(playerQuestId)}/set`, {
      method: 'POST',
      body,
    }),

  claimQuest: (playerQuestId: number, actor?: string) =>
    api<{ result: QuestClaimResult }>(`/api/quests/progress/${String(playerQuestId)}/claim`, {
      method: 'POST',
      body: { actor },
    }),

  cancelQuest: (playerQuestId: number, body: { actor?: string; reason?: string } = {}) =>
    api<{ cancelled: boolean }>(`/api/quests/progress/${String(playerQuestId)}/cancel`, {
      method: 'POST',
      body,
    }),

  retryQuestReward: (playerQuestId: number, actor?: string) =>
    api<{ result: QuestClaimResult }>(`/api/quests/rewards/${String(playerQuestId)}/retry`, {
      method: 'POST',
      body: { actor },
    }),

  /** O recorte e obrigatorio, e o motivo tambem. */
  wipeQuests: (body: {
    serverId?: string;
    questId?: string;
    steamId?: string;
    actor: string;
    reason: string;
  }) => api<{ wiped: number }>('/api/quests/wipe', { method: 'POST', body }),

  questSettings: (serverId?: string) =>
    api<{ settings: QuestSettingsRow[] }>(
      `/api/quests/settings${
        serverId === undefined ? '' : `?serverId=${encodeURIComponent(serverId)}`
      }`,
    ),

  saveQuestSettings: (serverId: string, body: Omit<QuestSettingsRow, 'serverId' | 'updatedAt'>) =>
    api<{ settings: QuestSettingsRow }>(`/api/quests/settings/${encodeURIComponent(serverId)}`, {
      method: 'PUT',
      body,
    }),

  questNpcs: (serverId?: string) =>
    api<{ npcs: QuestNpc[] }>(
      `/api/quests/npcs${
        serverId === undefined ? '' : `?serverId=${encodeURIComponent(serverId)}`
      }`,
    ),

  updateQuestNpc: (id: string, body: Omit<QuestNpc, 'id' | 'quests' | 'createdAt' | 'updatedAt'>) =>
    api<{ npc: QuestNpc }>(`/api/quests/npcs/${encodeURIComponent(id)}`, { method: 'PUT', body }),

  removeQuestNpc: (id: string) =>
    api<{ removed: boolean; orphaned: string[] }>(`/api/quests/npcs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

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
  // ---- o site OrigemZ -------------------------------------
  siteConfig: () => api<SiteConfig>('/api/site/config'),
  saveSiteConfig: (baseUrl: string) =>
    api<{ ok: true; baseUrl: string; message: string }>('/api/site/config', {
      method: 'PUT',
      body: { baseUrl },
    }),
  siteStatus: () => api<SiteStatus>('/api/site/status'),
  /**
   * Gera o bearer DESTE servidor.
   *
   * A resposta é o ÚNICO lugar onde ele aparece em claro: nenhum
   * GET o devolve, nem agora nem depois.
   */
  generateSiteToken: (id: string) =>
    api<{ ok: true; token: string; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/site/token`,
      { method: 'POST' },
    ),
  forceSiteBeacon: (serverId: string) =>
    api<{ ok: true; servers: { serverId: string; status: string; message: string | null }[] }>(
      `/api/site/beacon?serverId=${encodeURIComponent(serverId)}`,
      { method: 'POST' },
    ),

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
   * Põe um item na mão de um jogador CONECTADO.
   *
   * `skinId` é string de dígitos, e não número: um id de skin passa
   * de 2^53 e não sobrevive a um `number` — o mesmo motivo do
   * SteamID. `"0"` é sem skin.
   *
   * A resposta separa `given` de `dropped` porque a diferença
   * importa: o que não coube foi para o CHÃO, onde qualquer um
   * pega, e quem entregou precisa saber disso na hora.
   */
  givePlayerItem: (
    id: string,
    steamId: string,
    item: { shortname: string; amount: number; skinId: string; mode: GiveMode },
  ) =>
    api<{
      ok: true;
      steamId: string;
      delivered: 'inventory' | 'drop' | 'mixed';
      given: number;
      dropped: number;
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/players/${encodeURIComponent(steamId)}/give`, {
      method: 'POST',
      body: item,
    }),

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
      /** O que o AGENTE instalou, lido do disco. Vale com o servidor parado. */
      installed: InstalledOxide | null;
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

  /**
   * Um item do catálogo do jogo, pelo shortname.
   *
   * Existe para a tela mostrar o nome e o empilhamento de um item
   * base que ela carregou de um cadastro — e não de um clique.
   */
  item: (shortname: string) =>
    api<{ ok: true; item: CatalogItem; catalog: ItemCatalogInfo }>(
      `/api/items/${encodeURIComponent(shortname)}`,
    ),

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
  //  OS ITENS QUE NÓS CRIAMOS
  //
  //  Todas respondem com os servidores parados, como as de cima e
  //  pelo mesmo motivo: cadastrar item é trabalho de madrugada.
  //  Quem leva o cadastro ao jogo é a sincronização, quando o
  //  servidor sobe.
  // ----------------------------------------------------------

  customItems: () => api<{ ok: true; count: number; items: CustomItem[] }>('/api/custom-items'),

  customItemCategories: () =>
    api<{ ok: true; categories: { category: string; total: number }[] }>(
      '/api/custom-items/categories',
    ),

  createCustomItem: (input: CustomItemInput) =>
    api<{ ok: true; item: CustomItem }>('/api/custom-items', {
      method: 'POST',
      body: input,
    }),

  /** Reescreve o item INTEIRO. Não é PATCH — ver a rota. */
  updateCustomItem: (id: string, input: CustomItemInput) =>
    api<{ ok: true; item: CustomItem }>(`/api/custom-items/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input,
    }),

  removeCustomItem: (id: string) =>
    api<{ ok: true }>(`/api/custom-items/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Os PNGs que já estão em `Assets\items\`. */
  customItemIcons: () =>
    api<{ ok: true; icons: { name: string; bytes: number }[] }>('/api/custom-items/icons'),

  /**
   * Envia um PNG e devolve o NOME dele.
   *
   * O nome é o que vai para o cadastro; os bytes só chegam ao jogo
   * depois, pela sincronização. O teto é ~33 KB — acima disso o PNG
   * não cabe na linha de console que o leva até o servidor.
   */
  uploadCustomItemIcon: (file: File) => {
    const form = new FormData();

    form.append('file', file);

    return api<{ ok: true; icon: { name: string; bytes: number } }>('/api/custom-items/icons', {
      method: 'POST',
      form,
    });
  },

  /** As artes de kit que já estão em `Assets\kits\`. */
  kitIcons: () => api<{ ok: true; icons: { name: string; bytes: number }[] }>('/api/kits/icons'),

  /**
   * Envia a arte de um kit e devolve o NOME dela.
   *
   * O nome é o que vai para `iconFile` do kit; os bytes só chegam ao
   * jogo depois, pela sincronização da interface.
   */
  uploadKitIcon: (file: File) => {
    const form = new FormData();

    form.append('file', file);

    return api<{ ok: true; icon: { name: string; bytes: number } }>('/api/kits/icons', {
      method: 'POST',
      form,
    });
  },

  /** As artes que já estão em `Assets\store\`. */
  storeIcons: () =>
    api<{ ok: true; icons: { name: string; bytes: number }[] }>('/api/store/icons'),

  /**
   * Envia a arte de um card e devolve o NOME dela.
   *
   * O nome é o que vai para `icon.file` da oferta; os bytes só chegam
   * ao jogo depois, pela sincronização da interface. O teto é o mesmo
   * do ícone de item (~33 KB), e o painel reduz a imagem antes de
   * enviar.
   */
  uploadStoreIcon: (file: File) => {
    const form = new FormData();

    form.append('file', file);

    return api<{ ok: true; icon: { name: string; bytes: number } }>('/api/store/icons', {
      method: 'POST',
      form,
    });
  },

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

  /**
   * Os modelos que o botão "Criar a partir do modelo" oferece.
   *
   * Vem montado do agente — nome, comando e número de telas do
   * documento que o modelo DE FATO produz. O painel não inventa
   * nenhum desses campos, porque quem os inventa erra no dia em que
   * o modelo ganhar uma tela.
   */
  uiPresets: () => api<{ ok: true; presets: UiPreset[] }>('/api/ui/presets'),

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

  // ---- o overlay de propagandas -------------------------
  //
  // ####  TUDO AQUI LEVA O SERVIDOR  ####
  //
  // O overlay do PVP anuncia o Discord do PVP. Diferente das
  // interfaces, onde o DESENHO é da rede e só a escolha é do
  // servidor, aqui não há nada compartilhado: a lista e o ajuste
  // são daquele mundo.

  /** `GET /ads` — a lista, o ajuste e a prévia, numa chamada só. */
  ads: (serverId: string, signal?: AbortSignal) =>
    api<AdsView>(`/api/servers/${encodeURIComponent(serverId)}/ads`, { signal }),

  /** `POST /ads` — cadastra. A imagem é baixada DEPOIS, pelo agente. */
  createAd: (serverId: string, input: Record<string, unknown>) =>
    api<{ ok: true; ad: Advertisement }>(`/api/servers/${encodeURIComponent(serverId)}/ads`, {
      method: 'POST',
      body: input,
    }),

  /**
   * `PUT /ads/:id` — parcial.
   *
   * ####  `null` NAO E "NAO MANDEI"  ####
   *
   * Apagar a data de fim é mandar `null`; omitir o campo é
   * mantê-la. Quem monta o corpo aqui precisa saber a diferença —
   * confundi-las deixaria a campanha de Natal no ar em janeiro.
   */
  updateAd: (serverId: string, id: string, patch: Record<string, unknown>) =>
    api<{ ok: true; ad: Advertisement }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/${encodeURIComponent(id)}`,
      { method: 'PUT', body: patch },
    ),

  deleteAd: (serverId: string, id: string) =>
    api<{ ok: true; deleted: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  /** `POST /ads/:id/duplicate` — a cópia nasce DESLIGADA. */
  duplicateAd: (serverId: string, id: string) =>
    api<{ ok: true; ad: Advertisement }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/${encodeURIComponent(id)}/duplicate`,
      { method: 'POST' },
    ),

  /** `PUT /ads/reorder` — a lista inteira, na ordem nova. */
  reorderAds: (serverId: string, ids: string[]) =>
    api<{ ok: true; ads: Advertisement[] }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/reorder`,
      { method: 'PUT', body: { ids } },
    ),

  /** `PUT /ads/settings` — o ajuste. A prévia volta junto. */
  saveAdsSettings: (serverId: string, patch: Record<string, unknown>) =>
    api<{ ok: true; settings: AdsSettings; timeline: AdsTimeline }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/settings`,
      { method: 'PUT', body: patch },
    ),

  /**
   * `POST /ads/preview` — os quadros de um ajuste NÃO salvo.
   *
   * Ela não grava nada. Existe para o preview acompanhar os
   * controles deslizantes sem que o navegador precise de uma
   * segunda implementação do gerador de animação — que divergiria
   * da do agente no primeiro campo que uma trata e a outra não.
   */
  previewAdsSettings: (serverId: string, patch: Record<string, unknown>) =>
    api<{ ok: true; settings: AdsSettings; timeline: AdsTimeline }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/preview`,
      { method: 'POST', body: patch },
    ),

  /** `GET /ads/export` — o overlay inteiro, para copiar. */
  exportAds: (serverId: string, signal?: AbortSignal) =>
    api<{ ok: true; package: AdsPackage }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/export`,
      { signal },
    ),

  /**
   * `POST /ads/import` — cola o pacote de outro servidor.
   *
   * `mode` não tem padrão aqui pelo mesmo motivo que não tem no
   * agente: `replace` apaga as propagandas que já estavam ali, e
   * isso não pode ser o que acontece por omissão.
   */
  importAds: (serverId: string, mode: 'replace' | 'append', pack: AdsPackage) =>
    api<AdsImportResult>(`/api/servers/${encodeURIComponent(serverId)}/ads/import`, {
      method: 'POST',
      body: { mode, package: pack },
    }),

  /**
   * `GET /ads/audience` — os grupos e permissões do Oxide.
   *
   * Sem RCON responde `available: false`, e a tela volta ao campo
   * de texto livre. Um nome digitado errado (`vips` em vez de
   * `vip`) não dá erro nenhum: a propaganda simplesmente não
   * aparece — e isso é indistinguível de "ainda não é a hora dela".
   */
  adsAudience: (serverId: string, signal?: AbortSignal) =>
    api<AdsAudience>(`/api/servers/${encodeURIComponent(serverId)}/ads/audience`, { signal }),

  /** `POST /ads/refresh` — rebaixa as imagens. `force` refaz as prontas. */
  refreshAdImages: (serverId: string, force = false) =>
    api<{ ok: true; ready: number; failed: number; ads: Advertisement[] }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/refresh`,
      { method: 'POST', body: { force } },
    ),

  clearAdsCache: (serverId: string) =>
    api<{ ok: true; cleared: number }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/cache/clear`,
      { method: 'POST' },
    ),

  /** `POST /ads/sync` — empurra AGORA e espera o desfecho. */
  syncAds: (serverId: string) =>
    api<AdsSyncResult>(`/api/servers/${encodeURIComponent(serverId)}/ads/sync`, {
      method: 'POST',
    }),

  /** `POST /ads/show` e `/ads/hide` — sem `steamId`, valem para todos. */
  showAds: (serverId: string, steamId?: string) =>
    api<{ ok: true; response: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/show`,
      { method: 'POST', body: steamId === undefined ? {} : { steamId } },
    ),

  hideAds: (serverId: string, steamId?: string) =>
    api<{ ok: true; response: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/hide`,
      { method: 'POST', body: steamId === undefined ? {} : { steamId } },
    ),

  /** `POST /ads/:id/test` — mostra SÓ esta, agora, sem mexer no rodízio. */
  testAd: (serverId: string, id: string, steamId?: string) =>
    api<{ ok: true; response: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/ads/${encodeURIComponent(id)}/test`,
      { method: 'POST', body: steamId === undefined ? {} : { steamId } },
    ),

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

  // ---- Os timers daquele servidor ---------------------------
  //
  // A terceira pergunta sobre a mesma pessoa: quão RÁPIDO a
  // fornalha, o craft, a pesquisa e o reciclador andam para ela.

  playerTimers: (id: string) =>
    api<{
      ok: true;
      connected: boolean;
      groups: ServerPlayerTimers[];
      truncated: number;
      /** Por que os níveis de VIP não foram lidos. `null` = foram. */
      levelsProblem: string | null;
      message?: string;
    }>(`/api/servers/${encodeURIComponent(id)}/timers`),

  savePlayerTimers: (id: string, group: string, input: PlayerTimersInput) =>
    api<{
      ok: true;
      timers: Omit<ServerPlayerTimers, 'exists' | 'members' | 'tier'>;
      sync: PlayerTimersSyncResult;
      message: string;
    }>(`/api/servers/${encodeURIComponent(id)}/timers/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: input,
    }),

  /** Apaga. Quem é desse grupo passa a seguir o nível de baixo. */
  removePlayerTimers: (id: string, group: string) =>
    api<{ ok: true; sync: PlayerTimersSyncResult; message: string }>(
      `/api/servers/${encodeURIComponent(id)}/timers/${encodeURIComponent(group)}`,
      { method: 'DELETE' },
    ),

  syncPlayerTimers: (id: string) =>
    api<{ ok: true } & PlayerTimersSyncResult & { message: string }>(
      `/api/servers/${encodeURIComponent(id)}/timers/sync`,
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

  // ---- O WIPE: A FILA DE MAPAS -----------------------------
  //
  // Em que MUNDO o servidor volta depois de zerar. A fila é lida
  // do banco, então ela responde com o servidor parado — que é
  // exatamente quando se escolhe o mapa do próximo wipe.

  /**
   * A fila inteira, com as já usadas no fim.
   *
   * `next` é a primeira pronta; `willDraw` diz que não há nenhuma
   * e que o agente vai sortear na hora do wipe — a tela mostra
   * isso como informação, e não como problema.
   */
  wipeMaps: (serverId: string) =>
    api<{
      ok: true;
      count: number;
      maps: WipeMap[];
      next: WipeMap | null;
      willDraw: boolean;
      message: string | null;
    }>(`/api/servers/${encodeURIComponent(serverId)}/wipe/maps`),

  /** Cola uma seed (ou um link de `.map`) no fim da fila. */
  addWipeMap: (serverId: string, input: WipeMapInput) =>
    api<{
      ok: true;
      map: WipeMap;
      warnings: WipeMapWarning[];
      drawn: boolean;
      message: string;
    }>(`/api/servers/${encodeURIComponent(serverId)}/wipe/maps`, {
      method: 'POST',
      body: input,
    }),

  /** Sorteia uma seed que não está na fila nem saiu nos últimos wipes. */
  drawWipeMap: (serverId: string, input: { worldSize?: number; level?: string } = {}) =>
    api<{
      ok: true;
      map: WipeMap;
      warnings: WipeMapWarning[];
      drawn: boolean;
      message: string;
    }>(`/api/servers/${encodeURIComponent(serverId)}/wipe/maps/random`, {
      method: 'POST',
      body: input,
    }),

  /**
   * Grava a ordem da fila.
   *
   * Manda a fila INTEIRA, e não "mova para cima": com movimento
   * relativo, duas telas abertas produzem uma ordem que nenhuma
   * das duas pediu.
   */
  reorderWipeMaps: (serverId: string, ids: number[]) =>
    api<{ ok: true; count: number; maps: WipeMap[]; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/maps/reorder`,
      { method: 'POST', body: { ids } },
    ),

  /** A marca "compatível com a versão nova" de um mapa custom. */
  markWipeMapVersion: (serverId: string, mapId: number, versionOk: boolean) =>
    api<{ ok: true; map: WipeMap; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/maps/${String(mapId)}`,
      { method: 'PATCH', body: { versionOk } },
    ),

  removeWipeMap: (serverId: string, mapId: number) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/maps/${String(mapId)}`,
      { method: 'DELETE' },
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

  // ---- O WIPE: a agenda ------------------------------------

  /** A configuração de QUANDO este servidor zera. */
  wipeSettings: (serverId: string) =>
    api<WipeSettingsResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/settings`),

  /**
   * Grava a cadência, a política do forçado e a da colisão.
   *
   * O agente reconcilia a agenda depois de gravar: recalcula o que
   * a regra prevê, preserva o que foi mexido à mão e não toca no
   * passado. Por isso a tela relê as datas em seguida.
   */
  saveWipeSettings: (serverId: string, settings: WipeSettings) =>
    api<WipeSettingsResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/settings`, {
      method: 'PUT',
      body: settings,
    }),

  /** As datas materializadas na faixa pedida, em epoch ms. */
  wipePlans: (serverId: string, range: { from?: number; to?: number } = {}) => {
    const query = new URLSearchParams();

    if (range.from !== undefined) query.set('from', String(range.from));
    if (range.to !== undefined) query.set('to', String(range.to));

    const search = query.toString();

    return api<WipePlansResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/plans${search === '' ? '' : `?${search}`}`,
    );
  },

  /** Marca um wipe fora da cadência. Ele nasce `manual` e `pinned`. */
  createWipePlan: (
    serverId: string,
    input: { scheduledAt: number; bpPolicy: BpPolicy; note: string | null },
  ) =>
    api<WipePlanResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/plans`, {
      method: 'POST',
      body: input,
    }),

  /** Adia (`scheduledAt`) ou troca a política de UM wipe marcado. */
  updateWipePlan: (
    serverId: string,
    planId: number,
    patch: { scheduledAt?: number; bpPolicy?: BpPolicy; note?: string | null },
  ) =>
    api<WipePlanResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/plans/${String(planId)}`,
      { method: 'PATCH', body: patch },
    ),

  /**
   * APAGA de vez um wipe já deletado.
   *
   * Solta a data: com a cadência LIGADA, a reconciliação marca um
   * wipe novo ali na volta seguinte. A mensagem da resposta diz isso
   * quando for o caso.
   */
  purgeWipePlan: (serverId: string, planId: number) =>
    api<{ ok: true; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/plans/${String(planId)}/purge`,
      { method: 'DELETE' },
    ),

  /**
   * DESFAZ o pular.
   *
   * A linha pulada continua ocupando o instante, então sem isto um
   * clique errado apagava a data para sempre: nem marcar outro no
   * lugar resolvia, porque o POST recusa por conflito de horário.
   */
  restoreWipePlan: (serverId: string, planId: number) =>
    api<WipePlanResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/plans/${String(planId)}/restore`,
      { method: 'POST' },
    ),

  /**
   * Pula um wipe marcado.
   *
   * O agente RECUSA num plano forçado, com explicação: sem zerar,
   * o servidor não sobe com o mundo antigo depois da atualização
   * mensal. A tela nem oferece o botão nesse caso.
   */
  removeWipePlan: (serverId: string, planId: number) =>
    api<WipePlanResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/plans/${String(planId)}`,
      { method: 'DELETE' },
    ),

  // ---- O RUSTMAPS: a prévia do mapa ------------------------
  //
  // A imagem que o admin (e o VIP) vê antes de o mundo entrar. É
  // ENFEITE: sem ela o wipe usa a seed do mesmo jeito, e nenhuma
  // chamada daqui pode fazer a tela parecer quebrada.

  /**
   * A chave serve, e quanto ainda cabe nela?
   *
   * A resposta NUNCA traz a chave — nem prefixo, nem últimos
   * dígitos. Ela vive no `.env` do agente, e o que volta é
   * válida/inválida, o plano e a cota.
   */
  rustmapsStatus: (refresh = false) =>
    api<RustMapsStatus>(`/api/wipe/rustmaps/status${refresh ? '?refresh=1' : ''}`),

  /**
   * Pede a prévia de uma entrada da fila, agora.
   *
   * Responde 200 mesmo com o RustMaps fora do ar: o que muda é o
   * `outcome` e a frase. `staging` fica de fora no uso normal — o
   * agente liga sozinho quando aquele mundo vai para um wipe
   * FORÇADO.
   */
  generateWipeMapPreview: (serverId: string, mapId: number, staging?: boolean) =>
    api<{
      ok: true;
      map: WipeMap;
      outcome: RustMapsOutcome;
      message: string;
    }>(`/api/servers/${encodeURIComponent(serverId)}/wipe/maps/${String(mapId)}/generate`, {
      method: 'POST',
      body: staging === undefined ? {} : { staging },
    }),

  // ---- O WIPE: a execução  (a que apaga arquivo) -----------
  //
  // ####  ESTE BLOCO É A LINHA DIVISÓRIA DO PAINEL  ####
  //
  // Tudo acima lê e configura. Daqui em diante o painel manda o
  // agente PARAR o servidor e APAGAR o mundo. É por isso que o
  // `startWipeRun` é o único método deste arquivo que exige duas
  // confirmações — ver o comentário dele.

  /**
   * O que este wipe vai apagar, lido do disco AGORA.
   *
   * Leitura pura: nada é escrito, e por isso ela pode ser chamada a
   * cada abertura de tela, com o servidor no ar e cheio de gente.
   */
  wipePreview: (serverId: string) =>
    api<WipePreviewResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/preview`),

  /** O que existe DE VERDADE em `oxide\data` e nos `.db` do save. */
  wipePluginData: (serverId: string) =>
    api<WipePluginDataResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/plugin-data`),

  /** Como o agente EXECUTA: avisos, esvaziar, backup, full wipe. */
  wipeExecSettings: (serverId: string) =>
    api<WipeExecSettingsResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/exec-settings`,
    ),

  saveWipeExecSettings: (serverId: string, settings: WipeExecSettings) =>
    api<WipeExecSettingsResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/exec-settings`,
      { method: 'PUT', body: settings },
    ),

  /**
   * ####  WIPAR. É ESTE.  ####
   *
   * Duas confirmações, e as duas são obrigatórias no agente:
   *
   *   `identity`         o nome do servidor, DIGITADO por quem
   *                      clicou. É a mesma confirmação que o GitHub
   *                      pede para apagar um repositório.
   *   `Idempotency-Key`  a MESMA chave é a mesma intenção. Um
   *                      duplo-clique manda a mesma chave, e o
   *                      agente devolve a execução que já começou
   *                      em vez de começar outra.
   *
   * A chave vem de FORA deste método de propósito: gerá-la aqui
   * dentro produziria uma chave nova a cada chamada — ou seja,
   * exatamente o duplo-clique que ela existe para impedir, com a
   * aparência de estar protegido.
   */
  startWipeRun: (
    serverId: string,
    input: {
      identity: string;
      idempotencyKey: string;
      planId?: number | null;
      bpPolicy?: BpPolicy;
      fullWipe?: boolean;
      /** Epoch ms. Ausente = agora. Com hora futura, os avisos saem antes. */
      at?: number;
      /**
       * A temporada do ranking vira NESTE wipe?
       *
       * Três estados: `true` força abrir, `false` força não abrir, e
       * ausente (ou `null`) é "não decidi" — aí vale a configuração
       * do servidor. Um booleano de dois estados transformaria toda
       * execução em que ninguém tocou na caixa numa decisão explícita
       * de NÃO virar. Ver Docs\Ranking\20 §3.4.
       */
      openRankingSeason?: boolean | null;
    },
  ) => {
    const { idempotencyKey, ...body } = input;

    return api<WipeRunStartResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/runs`, {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },

  /** O histórico de execuções, e os mundos que o agente detectou. */
  wipeRuns: (serverId: string, limit?: number) =>
    api<WipeRunsResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/runs${
        limit === undefined ? '' : `?limit=${String(limit)}`
      }`,
    ),

  /**
   * Uma execução, com os passos e o log a partir do cursor.
   *
   * O log é da OPERAÇÃO, e ela vive em memória: depois de um
   * reinício do agente ele some, e o que sobra são os passos, que
   * estão no banco. O campo `live` diz qual dos dois casos é — sem
   * ele, a tela mostraria um console vazio como se fosse silêncio.
   */
  wipeRun: (serverId: string, runId: number, fromLine = 0) =>
    api<WipeRunDetailResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/runs/${String(runId)}?fromLine=${String(
        fromLine,
      )}`,
    ),

  /** Retoma do primeiro passo que não terminou. Não roda tudo de novo. */
  resumeWipeRun: (serverId: string, runId: number) =>
    api<WipeRunStartResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/runs/${String(runId)}/resume`,
      { method: 'POST' },
    ),

  /** Pede a parada. NÃO desfaz o que já foi apagado. */
  cancelWipeRun: (serverId: string, runId: number) =>
    api<{ ok: true; now: number; run: WipeRun | null; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/runs/${String(runId)}/cancel`,
      { method: 'POST' },
    ),

  // ---- O WIPE: os blueprints que sobrevivem ----------------
  //
  // ####  A ÚNICA PARTE DO WIPE QUE DEPENDE DE UM PLUGIN  ####
  //
  // O snapshot é lido pelo OrigemZAgent DENTRO do jogo, e a
  // devolução é aplicada por ele no login. Por isso as duas rotas
  // que falam com o jogo respondem 503 com o servidor fora do ar —
  // e a tela mostra a frase em vez de fingir que guardou uma cópia.

  /** A régua por nível, o último snapshot e quanto já foi devolvido. */
  wipeBlueprints: (serverId: string) =>
    api<WipeBlueprintsResponse>(`/api/servers/${encodeURIComponent(serverId)}/wipe/blueprints`),

  saveWipeBlueprints: (serverId: string, settings: BpSettings) =>
    api<WipeBlueprintsSaveResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/blueprints/settings`,
      { method: 'PUT', body: settings },
    ),

  /**
   * Tira um snapshot AGORA.
   *
   * Ele substitui o anterior inteiro — é a mesma operação que o
   * wipe faz sozinho antes de apagar, e existe para conferir que o
   * caminho funciona ANTES do dia do wipe.
   */
  takeWipeBlueprintSnapshot: (serverId: string) =>
    api<WipeBlueprintsSnapshotResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/blueprints/snapshot`,
      { method: 'POST', body: {} },
    ),

  /** A devolução na mão. `force` devolve tudo mesmo sem VIP. */
  restoreWipeBlueprints: (serverId: string, input: { steamId: string; force?: boolean }) =>
    api<WipeBlueprintsRestoreResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/wipe/blueprints/restore`,
      { method: 'POST', body: input },
    ),

  // ---- O RANKING -------------------------------------------
  //
  // A leitura responde com os servidores parados: a definição é do
  // AGENTE, e o número já está no banco dele. O que precisa do jogo
  // no ar é só o ciclo de coleta, que roda sozinho a cada 60 s.

  /** O catálogo: o que existe, e como cada um se comporta. */
  rankingMetrics: (options: { enabledOnly?: boolean } = {}) =>
    api<RankingMetricsResponse>(
      `/api/rankings/metrics${options.enabledOnly === true ? '?enabled=1' : ''}`,
    ),

  /**
   * A lista, paginada.
   *
   * `periodId` sobrepõe `period` e é como se lê uma temporada
   * FECHADA — aí a fonte é o pódio congelado, e a resposta vem com
   * `frozen: true`.
   */
  ranking: (options: {
    metric: string;
    scope?: RankingScope;
    serverId?: string | undefined;
    period?: RankingPeriodKind;
    periodId?: number | undefined;
    limit: number;
    offset: number;
  }) => {
    const params = new URLSearchParams();

    params.set('metric', options.metric);

    if (options.scope !== undefined) params.set('scope', options.scope);
    if (options.serverId !== undefined) params.set('serverId', options.serverId);
    if (options.period !== undefined) params.set('period', options.period);
    if (options.periodId !== undefined) params.set('periodId', String(options.periodId));

    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset));

    return api<RankingListResponse>(`/api/rankings?${params.toString()}`);
  },

  /** O histórico: as janelas, da mais nova para a mais velha. */
  rankingPeriods: (options: {
    serverId?: string | undefined;
    kind?: RankingPeriodKind;
    limit: number;
    offset: number;
  }) => {
    const params = new URLSearchParams();

    if (options.serverId !== undefined) params.set('serverId', options.serverId);
    if (options.kind !== undefined) params.set('kind', options.kind);

    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset));

    return api<RankingPeriodsResponse>(`/api/rankings/periods?${params.toString()}`);
  },

  /** Uma janela, e o pódio congelado dela. O valor de lá não muda mais. */
  rankingPeriod: (periodId: number) =>
    api<RankingPeriodDetailResponse>(`/api/rankings/periods/${String(periodId)}`),

  /** A janela configurada de um servidor, com a temporada de agora junto. */
  rankingSettings: (serverId: string) =>
    api<RankingSettingsResponse>(
      `/api/rankings/settings?serverId=${encodeURIComponent(serverId)}`,
    ),

  saveRankingSettings: (serverId: string, input: RankingSettingsInput) =>
    api<{ ok: true; serverId: string; settings: RankingSettings }>(
      `/api/rankings/settings/${encodeURIComponent(serverId)}`,
      { method: 'PUT', body: input },
    ),

  createRanking: (input: RankingDefinitionInput) =>
    api<{ ok: true; ranking: RankingDefinition }>('/api/rankings/metrics', {
      method: 'POST',
      body: input,
    }),

  /** Reescreve o ranking INTEIRO. Não é PATCH — ver a rota. */
  updateRanking: (id: string, input: RankingDefinitionInput) =>
    api<{ ok: true; ranking: RankingDefinition }>(
      `/api/rankings/metrics/${encodeURIComponent(id)}`,
      { method: 'PUT', body: input },
    ),

  /** Só os dinâmicos saem. O `builtin` é recusado pelo agente. */
  removeRanking: (id: string) =>
    api<{ ok: true }>(`/api/rankings/metrics/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * A ordem do catálogo INTEIRO, de uma vez.
   *
   * A lista tem de trazer todos os rankings que existem: sem os
   * ausentes a posição deles ficaria indefinida, e por isso a rota
   * recusa uma lista parcial (ou com id repetido, ou desconhecido)
   * com `RANKING_ORDER_MISMATCH` — a frase dela diz quais.
   */
  reorderRankings: (ids: readonly string[]) =>
    api<{ ok: true; count: number; rankings: RankingDefinition[] }>(
      '/api/rankings/metrics/order',
      { method: 'PUT', body: { ids } },
    ),

  /**
   * Fecha a temporada aberta e abre a seguinte, numa transação só.
   *
   * O `periodId` é a temporada que quem clicou estava vendo: com
   * ele, o segundo clique recusa em vez de abrir uma terceira.
   */
  openRankingSeason: (
    serverId: string,
    input: { label: string | null; periodId?: number; reason: string },
  ) =>
    api<RankingSeasonTurnResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/rankings/season`,
      { method: 'POST', body: input },
    ),

  // ---- O LOOT ----------------------------------------------
  //
  // A leitura responde com os servidores parados: a regra é
  // cadastro do AGENTE. O que precisa do jogo no ar é a aplicação
  // dela, que o plugin faz quando o container nasce.

  /** As regras. Com `serverId`, só as que valem naquele servidor. */
  lootRules: (options: { serverId?: string | undefined } = {}) =>
    api<LootRulesResponse>(
      `/api/loot/rules${
        options.serverId === undefined || options.serverId === ''
          ? ''
          : `?serverId=${encodeURIComponent(options.serverId)}`
      }`,
    ),

  /** Os containers que o plugin aceita. É a lista que a tela navega. */
  lootContainers: () => api<LootContainersResponse>('/api/loot/containers'),

  createLootRule: (input: LootRuleInput) =>
    api<{ ok: true; rule: LootRule }>('/api/loot/rules', { method: 'POST', body: input }),

  /** Reescreve a regra INTEIRA — é PUT, e não PATCH. */
  updateLootRule: (id: string, input: LootRuleInput) =>
    api<{ ok: true; rule: LootRule }>(`/api/loot/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input,
    }),

  removeLootRule: (id: string) =>
    api<{ ok: true }>(`/api/loot/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * O que a regra contou, por dia.
   *
   * É o que faz o modo de medição valer a pena: sem ele, uma regra
   * medindo é uma regra que não faz nada visível.
   */
  lootRuleStats: (id: string) =>
    api<LootRuleStatsResponse>(`/api/loot/rules/${encodeURIComponent(id)}/stats`),

  // ---- O EDITOR DE LOOT (BetterLoot) -----------------------
  //
  // Ao contrário das regras acima, isto NÃO responde com o
  // servidor parado: o que a tela lê é um arquivo no disco daquele
  // servidor, e quem o lê é o agente que fala com ele.
  //
  // O prefab viaja em query string porque tem barra e às vezes
  // espaço — como pedaço de caminho ele quebraria a rota.

  /** A lista de caixas de um servidor, com o estado do plugin ali. */
  betterLootStatus: (serverId: string) =>
    api<BetterLootStatusResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot`,
    ),

  /** Uma caixa inteira. É a segunda chamada — a lista só traz resumo. */
  betterLootTable: (serverId: string, prefab: string) =>
    api<BetterLootTableResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/table?prefab=${encodeURIComponent(prefab)}`,
    ),

  /**
   * Grava a caixa e manda o plugin recarregar.
   *
   * A resposta vem RELIDA DO DISCO: o plugin reescreve o que
   * recebeu. Quem ignorar o retorno mostra ao admin o que ele
   * pediu, e não o que o servidor tem.
   */
  saveBetterLootTable: (serverId: string, input: BetterLootSaveInput) =>
    api<BetterLootTableResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/table`,
      { method: 'PUT', body: input },
    ),


  // ---- os PERFIS de loot (LootGroups.json) ------------------
  //
  // Outro arquivo que a tabela, e por isso outra revisão: gravar um
  // perfil não pode recusar o próximo salvamento de caixa.

  /** A lista de perfis, com em quais caixas cada um está. */
  betterLootProfiles: (serverId: string) =>
    api<BetterLootProfilesResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/profiles`,
    ),

  /** Um perfil inteiro, com o peso de cada item. */
  betterLootProfile: (serverId: string, name: string) =>
    api<BetterLootProfileResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/profile?name=${encodeURIComponent(name)}`,
    ),

  /** Cria (`baseRevision: null`) ou grava um perfil. */
  saveBetterLootProfile: (serverId: string, input: BetterLootProfileSaveInput) =>
    api<BetterLootProfileResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/profile`,
      { method: 'PUT', body: input },
    ),

  /**
   * Renomeia um perfil, e reescreve quem o cita.
   *
   * ####  NÃO DÁ PARA FAZER ISSO PELO `PUT`  ####
   *
   * O nome é a chave do arquivo de perfis E é citado por nome
   * dentro de cada caixa. Mandar um nome novo no `PUT` criaria um
   * perfil a mais, e as caixas continuariam apontando para o
   * antigo. O agente atravessa os dois arquivos numa operação só.
   */
  renameBetterLootProfile: (serverId: string, input: BetterLootProfileRenameInput) =>
    api<BetterLootProfileRenameResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/profile/rename`,
      { method: 'POST', body: input },
    ),

  /**
   * Apaga um perfil.
   *
   * Sem `detach`, um perfil EM USO é recusado com 409 e a lista das
   * caixas — para a tela poder perguntar antes. É a pergunta que o
   * Looty não faz: lá o perfil some e as associações somem junto,
   * sem aviso.
   */
  deleteBetterLootProfile: (serverId: string, name: string, detach: boolean) =>
    api<BetterLootProfileDeleteResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/profile?name=${encodeURIComponent(name)}`,
      { method: 'DELETE', body: { detach } },
    ),

  // ---- o LIXO (lista nossa, não do plugin) ------------------

  /** A lista de lixo daquele servidor: os padrões e os do admin. */
  betterLootJunk: (serverId: string) =>
    api<BetterLootJunkResponse>(`/api/servers/${encodeURIComponent(serverId)}/betterloot/junk`),

  /** Marca um item como lixo — ou religa um padrão desligado. */
  addBetterLootJunk: (serverId: string, shortname: string) =>
    api<BetterLootJunkResponse>(`/api/servers/${encodeURIComponent(serverId)}/betterloot/junk`, {
      method: 'POST',
      body: { shortname },
    }),

  /** Tira da lista. O padrão fica desligado; o do admin some. */
  removeBetterLootJunk: (serverId: string, shortname: string) =>
    api<BetterLootJunkResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/junk?shortname=${encodeURIComponent(shortname)}`,
      { method: 'DELETE' },
    ),

  /**
   * Grava o que vale no SERVIDOR INTEIRO e manda recarregar.
   *
   * Outro arquivo e outra revisão que a de tabela: aqui é o
   * `oxide/config/BetterLoot.json`, e ele é gravado por MERGE — o
   * agente preserva as 111 chaves de contêiner vigiado que a tela
   * não vê.
   */
  saveBetterLootGlobals: (serverId: string, input: BetterLootGlobalsSaveInput) =>
    api<BetterLootGlobalsResponse>(
      `/api/servers/${encodeURIComponent(serverId)}/betterloot/globals`,
      { method: 'PUT', body: input },
    ),

  // ==========================================================
  //  AS MASMORRAS
  // ==========================================================

  dungeons: () => api<{ dungeons: DungeonSummary[] }>('/api/dungeons'),

  dungeon: (id: string) =>
    api<{ dungeon: Dungeon }>(`/api/dungeons/${encodeURIComponent(id)}`),

  /**
   * As quatro receitas de fabrica.
   *
   * Elas NAO estao no banco: sao um modelo do qual o admin parte.
   * E o que faz a tela valer alguma coisa no primeiro minuto -
   * duplicar e mexer, em vez de encarar trinta campos em branco.
   */
  dungeonFactory: () => api<{ recipes: DungeonInput[] }>('/api/dungeons/factory'),

  createDungeon: (body: DungeonInput) =>
    api<{ dungeon: Dungeon }>('/api/dungeons', { method: 'POST', body }),

  updateDungeon: (id: string, body: Omit<DungeonInput, 'id'>) =>
    api<{ dungeon: Dungeon }>(`/api/dungeons/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body,
    }),

  duplicateDungeon: (id: string, body: { id: string; name: string }) =>
    api<{ dungeon: Dungeon }>(`/api/dungeons/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      body,
    }),

  removeDungeon: (id: string) =>
    api<{ ok: true }>(`/api/dungeons/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Ergue a masmorra, daqui.
   *
   * ####  `sent` NAO E "ELA EXISTE"  ####
   *
   * E "o comando chegou ao servidor". A construcao leva segundos, e
   * quem confirma e a linha que aparece no historico — a mesma que
   * o passo (6) ja esperava quando o admin colava o comando a mao.
   *
   * `pointId` e o caminho normal: um lugar que o admin marcou uma
   * vez. `x`/`z` erguem num lugar novo sem cadastrar nada.
   */
  buildDungeon: (
    id: string,
    body: { serverId: string; pointId?: number; x?: number; z?: number; yaw?: number },
  ) =>
    api<{ sent: boolean; grid: string | null; message: string }>(
      `/api/dungeons/${encodeURIComponent(id)}/build`,
      { method: 'POST', body },
    ),

  /**
   * Aquele chao serve para uma masmorra?
   *
   * So o servidor sabe: o painel escolhe pontos num mapa desenhado,
   * sem ver o relevo nem a agua. Uma entrada dentro de um rio mata
   * quem se teleporta para ela.
   */
  dungeonGround: (serverId: string, x: number, z: number) =>
    api<{ ground: GroundReport }>(
      `/api/dungeons/ground?serverId=${encodeURIComponent(serverId)}` +
        `&x=${String(Math.round(x))}&z=${String(Math.round(z))}`,
    ),

  /**
   * Os lugares onde a masmorra pode nascer.
   *
   * `worldKey` e o mundo carregado agora: um ponto com outro
   * `worldKey` foi marcado noutro mapa, e aquela coordenada e outro
   * lugar hoje.
   */
  spawnPoints: (serverId: string) =>
    api<{ worldKey: string | null; points: SpawnPoint[] }>(
      `/api/servers/${encodeURIComponent(serverId)}/spawn-points`,
    ),

  createSpawnPoint: (serverId: string, body: SpawnPointInput) =>
    api<{ point: SpawnPoint; warning: string | null }>(
      `/api/servers/${encodeURIComponent(serverId)}/spawn-points`,
      { method: 'POST', body },
    ),

  updateSpawnPoint: (serverId: string, pointId: number, body: SpawnPointInput) =>
    api<{ point: SpawnPoint; warning: string | null }>(
      `/api/servers/${encodeURIComponent(serverId)}/spawn-points/${String(pointId)}`,
      { method: 'PUT', body },
    ),

  removeSpawnPoint: (serverId: string, pointId: number) =>
    api<{ ok: true }>(
      `/api/servers/${encodeURIComponent(serverId)}/spawn-points/${String(pointId)}`,
      { method: 'DELETE' },
    ),

  dungeonCommand: (id: string) =>
    api<{ chat: string; console: string }>(`/api/dungeons/${encodeURIComponent(id)}/command`),

  /**
   * O olho do assistente.
   *
   * `since` e o momento em que o passo abriu: sem ele, a tela
   * celebraria a construcao de ontem. Chamada a cada dois
   * segundos, SO enquanto o passo esta aberto, e para no primeiro
   * resultado.
   */
  dungeonRuns: (id: string, options: { serverId?: string; since?: number } = {}) => {
    const query = new URLSearchParams();

    if (options.serverId !== undefined) query.set('serverId', options.serverId);
    if (options.since !== undefined) query.set('since', String(options.since));

    const suffix = query.toString();

    return api<{ runs: EventRun[] }>(
      `/api/dungeons/${encodeURIComponent(id)}/runs${suffix === '' ? '' : `?${suffix}`}`,
    );
  },

  /** A lista NAO traz o `content`: as sete plantas somam 1,1 MB. */
  dungeonBlueprints: () =>
    api<{ blueprints: BlueprintSummary[] }>('/api/dungeon-blueprints'),

  /**
   * UMA planta, com o conteudo.
   *
   * So quem vai DESENHAR a construcao precisa disto - e por isso a
   * leitura e sob demanda, ao abrir a previa, e nunca na listagem.
   */
  dungeonBlueprint: (id: string) =>
    api<{ blueprint: BlueprintSummary & { content: string } }>(
      `/api/dungeon-blueprints/${encodeURIComponent(id)}`,
    ),

  uploadBlueprint: (body: {
    id: string;
    name?: string;
    kind: 'entrance' | 'base';
    content: string;
  }) => api<{ blueprint: BlueprintSummary }>('/api/dungeon-blueprints', { method: 'POST', body }),

  removeBlueprint: (id: string) =>
    api<{ ok: true }>(`/api/dungeon-blueprints/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * O acervo de tracados desenhados.
   *
   * Aqui a lista TRAZ o desenho de cada um - ver
   * `DungeonLayoutSummary`.
   */
  dungeonLayouts: () => api<{ layouts: DungeonLayoutSummary[] }>('/api/dungeon-layouts'),

  /**
   * Salva um desenho como tracado.
   *
   * A resposta traz `problems`: um desenho com defeito e GRAVADO, e
   * marcado. Recusar perderia o trabalho de quem ia consertar a
   * sala lacrada depois — mas quem salvou precisa saber.
   */
  saveDungeonLayout: (body: {
    id: string;
    name: string;
    description?: string | null;
    grid: string[];
  }) =>
    api<{ layout: DungeonLayoutSummary; problems: string[] }>('/api/dungeon-layouts', {
      method: 'POST',
      body,
    }),

  removeDungeonLayout: (id: string) =>
    api<{ ok: true }>(`/api/dungeon-layouts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** O historico de tudo que nasceu, com filtro. */
  /**
   * A agenda: os eventos que fazem a masmorra nascer sozinha.
   *
   * Não confundir com `/api/events`, que é o CALENDÁRIO do wipe —
   * "Raid Night, sábado às 20h". Estes são os que nascem no mapa.
   */
  worldEvents: () => api<{ events: WorldEvent[] }>('/api/world-events'),

  createWorldEvent: (body: WorldEventInput) =>
    api<{ event: WorldEvent }>('/api/world-events', { method: 'POST', body }),

  updateWorldEvent: (id: string, body: Omit<WorldEventInput, 'id'>) =>
    api<{ event: WorldEvent }>(`/api/world-events/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body,
    }),

  removeWorldEvent: (id: string) =>
    api<{ ok: true }>(`/api/world-events/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  worldEventRuns: (options: { serverId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();

    if (options.serverId !== undefined) query.set('serverId', options.serverId);
    if (options.limit !== undefined) query.set('limit', String(options.limit));

    const suffix = query.toString();

    return api<{ runs: EventRun[] }>(
      `/api/world-events/runs${suffix === '' ? '' : `?${suffix}`}`,
    );
  },

  stopWorldEventRun: (runId: number) =>
    api<{ pendingCommand: string }>(`/api/world-events/runs/${String(runId)}/stop`, {
      method: 'POST',
    }),
};

// ------------------------------------------------------------
//  AS MASMORRAS — os tipos
//
//  Espelham `core/src/types/dungeons.ts` e
//  `core/src/types/world-events.ts`. As duas pontas sao compiladas
//  separadamente: um campo que o agente renomear e um TypeError no
//  render, e a pagina inteira cai com "This page couldn't load".
// ------------------------------------------------------------

export type DungeonMode = 'recipe' | 'blueprint';
export type RoomColor = 'green' | 'blue' | 'red';

/**
 * As onze portas.
 *
 * As quatro primeiras tem um metro de passagem; as seis seguintes,
 * dois; `none` e o vao aberto. Ver `core/src/types/dungeons.ts`.
 */
export const ROOM_DOORS = [
  'wood',
  'metal',
  'toptier',
  'industrial',
  'double_wood',
  'double_metal',
  'double_toptier',
  'cell_gate',
  'fence_gate',
  'garage',
  'none',
] as const;
export type RoomDoor = (typeof ROOM_DOORS)[number];

export const BUILD_GRADES = ['twigs', 'wood', 'stone', 'metal', 'toptier'] as const;
export type BuildGrade = (typeof BUILD_GRADES)[number];

export interface GradeSet {
  foundation: BuildGrade;
  wall: BuildGrade;
  ceiling: BuildGrade;
}

export const LOOT_MODES = ['server', 'add', 'replace'] as const;
export type LootMode = (typeof LOOT_MODES)[number];

export interface LootEntry {
  shortname: string;
  amount: { min: number; max: number };
  weight: number;
  guaranteed: boolean;
  skin: number;
  blueprint: boolean;
  condition: number;
}

export interface LootTable {
  mode: LootMode;
  rolls: { min: number; max: number };
  entries: LootEntry[];
}

/**
 * O comportamento do inimigo.
 *
 * ####  TODO CAMPO E OPCIONAL, E ISSO E O DESENHO INTEIRO  ####
 *
 * Campo ausente nao e zero: e "nao falei disso", e o valor de cima
 * fica de pe. A heranca e `npc.ai` -> `rooms[].ai` / `corridor.ai`,
 * campo a campo.
 */
export interface AiSpec {
  visionRadius?: number;
  requireLineOfSight?: boolean;
  loseTargetAfter?: number;
  reactionDelay?: number;
  maxTargetHeightDelta?: number;
  alertOnSpot?: boolean;

  holdPosition?: boolean;
  moveSpeed?: number;
  chaseRadius?: number;
  returnHome?: boolean;
  returnSpeed?: number;
  arriveRadius?: number;
  stuckTimeout?: number;

  fireRange?: number;
  fireInterval?: number;
  standoffDistance?: number;
  aimConeScale?: number;

  senseInterval?: number;
  moveInterval?: number;
}

export interface DungeonRoom {
  key: string;
  color: RoomColor;
  npc: { min: number; max: number };
  loot: { min: number; max: number };
  crates: string[];
  door: RoomDoor;
  locked: boolean;
  /** A porta da sala grande. `null` = usa `door` sempre. */
  wideDoor: RoomDoor | null;
  wideDoorCellsPerDoor: number;
  /** `null` = herda o `structure` da masmorra. */
  grade: GradeSet | null;
  table: LootTable;
  ai: AiSpec;
}

export interface DungeonLock {
  enabled: boolean;
  sharedCode: boolean;
  carrier: 'npc' | 'crate' | 'none';
  carrierScope: 'corridor' | 'anywhere';
  onUndelivered: 'unlock' | 'keep';
  noteTitle: string;
  announceOpen: boolean;
  warnOnWrongCode: boolean;
}

export interface DungeonRespawn {
  enabled: boolean;
  minutes: number;
  onlyWhenEmpty: boolean;
  rebuildDestroyed: boolean;
}

export const ACCESS_WHO_ENTERS = ['everyone', 'permission'] as const;
export type AccessWhoEnters = (typeof ACCESS_WHO_ENTERS)[number];

/**
 * Quem desce pelo alcapao.
 *
 * `everyone` e o padrao, e e o pedido do dono: o servidor inteiro
 * entra. `enterPermission` so e lido no modo `permission`, e vazio
 * cai na permissao do proprio plugin (`origemzdungeon.enter`).
 */
export interface DungeonAccess {
  whoEnters: AccessWhoEnters;
  enterPermission: string;
}

/**
 * O que ninguem tira do lugar.
 *
 * Martelo, ferramenta de remocao e "segurar E". O decay NAO obedece
 * a este bloco: a masmorra nao apodrece nem com ele desligado.
 */
/**
 * Um evento que faz a masmorra nascer sozinha.
 *
 * Espelha `core/src/types/world-events.ts`. Os campos de marcador e
 * mensagem existem na tabela e estão INERTES: desde a migração 068
 * quem decide como a masmorra se anuncia é a masmorra.
 */
export interface WorldEventInput {
  id: string;
  kind: string;
  name: string;
  description?: string | null;
  /** Qual masmorra nasce. `null` = o agendador pula este evento. */
  dungeonId: string | null;
  enabled: boolean;
  sort: number;
  /** `schedule` = o relógio; `manual` = só pelo botão. */
  spawnMode: 'schedule' | 'manual' | 'permanent';
  /** A janela do sorteio, em segundos. */
  interval: { min: number; max: number };
  /** Quanto ela fica de pé, em segundos. */
  duration: { min: number; max: number };
  /** Abaixo disso o agendador ADIA. Evento para ninguém é loot de graça. */
  minOnline: number;
  countAfterEnd: boolean;
  access: 'anyone' | 'owner' | 'team';
  ownerGraceSeconds: number;
  marker: {
    enabled: boolean;
    label: string;
    color: string;
    alpha: number;
    radius: number;
    showOwner: boolean;
    showTime: boolean;
  };
  messages: {
    start: string | null;
    location: string | null;
    warning: string | null;
    end: string | null;
    denied: string | null;
  };
  warnBefore: number;
  radiationBefore: number;
  destroyAfter: number;
  respawnSeconds: number;
  /** Vazio = não roda em servidor nenhum. */
  servers: string[];
}

export interface WorldEvent extends WorldEventInput {
  createdAt: number;
  updatedAt: number;
}

/** O círculo no mapa do jogo. Espelha `types/dungeons.ts`. */
export interface DungeonMarker {
  enabled: boolean;
  label: string;
  /** `#rrggbb`. */
  color: string;
  alpha: number;
  radius: number;
}

/** O que o servidor inteiro ouve. Texto vazio = a frase padrão. */
export interface DungeonAnnounce {
  enabled: boolean;
  onBuild: string;
  onEnd: string;
  showGrid: boolean;
}

export interface DungeonProtection {
  enabled: boolean;
  allowAdmin: boolean;
  warnOnAttempt: boolean;
}

/**
 * O que a casinha da entrada carrega dentro.
 *
 * As plantas do acervo vieram com arma nas caixas — a `entrance2`
 * traz uma M249 —, e copia-las era acidente, nao desenho. Ver
 * `ENTRANCE_ITEM_MODES` em `core/src/types/dungeons.ts`.
 */
export type EntranceItemMode = 'none' | 'unarmed' | 'all';

/**
 * Como e o chao naquele ponto, segundo o servidor.
 *
 * Espelha `groundReportSchema` de `core/src/game/dungeon-contract.ts`.
 */
export interface GroundReport {
  x: number;
  z: number;
  /** A grade do mapa: 'E7'. E o que gente le. */
  grid: string;
  ground: number;
  water: number;
  /** Metros de agua sobre o chao. Zero e terra. */
  depth: number;
  serves: boolean;
}

/** O que se manda ao marcar ou mexer num ponto de nascimento. */
export interface SpawnPointInput {
  label: string;
  x: number;
  z: number;
  /** Para onde a masmorra cresce, em graus. Zero e o norte. */
  yaw: number;
  enabled: boolean;
}

/**
 * Um lugar onde a masmorra pode nascer.
 *
 * NAO confundir com as zonas de evento, que dizem onde nada nasce.
 * Estes sao os lugares que o admin escolheu — ver
 * `core/src/db/dungeon-spawn-points-repository.ts`.
 */
export interface SpawnPoint extends SpawnPointInput {
  id: number;
  serverId: string;
  /** `"<worldSize>:<seed>"` do mundo em que ele foi marcado. */
  worldKey: string | null;
  /** A grade, do dia em que o servidor foi consultado. */
  grid: string | null;
  waterDepth: number | null;
  checkedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DungeonInput {
  id: string;
  name: string;
  description?: string | null;
  mode: DungeonMode;
  entranceBlueprint: string | null;
  entranceItems: EntranceItemMode;
  /** O ângulo da casinha, em graus. Gira só ela. */
  entranceRotation: number;
  /**
   * Qual lado do desenho fica de frente no jogo.
   *
   * `null` = automático: a masmorra gira sozinha para o corredor
   * sair de frente para a casinha.
   */
  entranceFacing: 0 | 90 | 180 | 270 | null;
  /**
   * Em que servidores ela vale.
   *
   * Vazio = em TODOS, e nao em nenhum: a masmorra e conteudo, e
   * conteudo sem dono e de todos. Ver a migracao 072.
   */
  servers: string[];
  marker: DungeonMarker;
  announce: DungeonAnnounce;
  size: { min: number; max: number };
  weights: { green: number; blue: number; red: number };
  corridor: {
    npcDensity: number;
    lootDensity: number;
    crates: string[];
    table: LootTable;
    ai: AiSpec;
  };
  grid: string[] | null;
  npc: {
    health: { min: number; max: number };
    damageScale: number;
    weapons: string[];
    names: string[];
    loot: LootTable;
    ai: AiSpec;
  };
  timeOfDay: number;
  structure: GradeSet;
  lock: DungeonLock;
  access: DungeonAccess;
  protection: DungeonProtection;
  respawn: DungeonRespawn;
  rooms: DungeonRoom[];
}

/**
 * O que o jogo faz quando o painel nao fala nada.
 *
 * Sao os inicializadores do `AiProfile` do `OrigemZDungeon.cs`, e
 * eles vivem aqui para a TELA poder mostra-los como marca-d'agua:
 * um campo vazio de `visionRadius` e 18, e nao 0.
 *
 * `aimConeScale` fica de fora de proposito — o padrao dele mora no
 * prefab do cientista, dentro do bundle do jogo.
 */
export const AI_DEFAULTS = {
  visionRadius: 18,
  requireLineOfSight: true,
  loseTargetAfter: 6,
  reactionDelay: 0.4,
  maxTargetHeightDelta: 3,
  alertOnSpot: true,

  holdPosition: false,
  moveSpeed: 2.8,
  chaseRadius: 25,
  returnHome: true,
  returnSpeed: 2.2,
  arriveRadius: 0.6,
  stuckTimeout: 6,

  fireRange: 15,
  fireInterval: 0.35,
  standoffDistance: 2.5,

  senseInterval: 0.5,
  moveInterval: 0.2,
} as const;

export interface Dungeon extends DungeonInput {
  createdAt: number;
  updatedAt: number;
}

/** A linha da lista. Sem `grid` e sem as salas. */
export interface DungeonSummary {
  id: string;
  name: string;
  mode: DungeonMode;
  entranceBlueprint: string | null;
  /** Em que servidores ela vale. Vazio = em todos. */
  servers: string[];
  roomCount: number;
  sizeMin: number;
  sizeMax: number;
  createdAt: number;
  updatedAt: number;
}

/** Uma planta do acervo, sem o conteudo. */
export interface BlueprintSummary {
  id: string;
  name: string;
  kind: 'entrance' | 'base';
  entityCount: number;
  byteSize: number;
  /** Sem isto, a masmorra nao abre. E a coluna que importa. */
  hasHatch: boolean;
  origin: 'builtin' | 'import' | 'capture';
  createdAt: number;
  updatedAt: number;
}

/**
 * Um tracado desenhado, do acervo.
 *
 * ####  ELE TRAZ O DESENHO, E A PLANTA NAO TRAZ O CONTEUDO  ####
 *
 * Nao e incoerencia: uma planta do CopyPaste tem meio megabyte e um
 * desenho tem algumas centenas de bytes. E e o desenho que a tela
 * precisa para mostrar a miniatura — sem ele, escolher entre oito
 * tracados seria escolher entre oito nomes.
 */
export interface DungeonLayoutSummary {
  id: string;
  name: string;
  description: string | null;
  /** Uma linha por fileira de z, do maior para o menor. */
  grid: string[];
  cellCount: number;
  roomCount: number;
  byColor: { green: number; blue: number; red: number };
  hasEntrance: boolean;
  /** Quantos defeitos o verificador achou. Gravado, nao recusado. */
  problemCount: number;
  origin: 'builtin' | 'panel' | 'capture';
  createdAt: number;
  updatedAt: number;
}

export type RunStatus =
  | 'scheduled'
  | 'spawning'
  | 'active'
  | 'closing'
  | 'ended'
  | 'failed'
  | 'cancelled';

/** Um nascimento. `failureMessage` ja vem traduzido pela borda. */
export interface EventRun {
  id: number;
  eventId: string;
  serverId: string;
  dungeonId: string | null;
  status: RunStatus;
  failureReason: string | null;
  failureMessage?: string | null;
  x: number | null;
  z: number | null;
  grid: string | null;
  seed: number | null;
  ownerSteamId: string | null;
  enteredCount: number;
  scheduledFor: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

// ------------------------------------------------------------
//  O WIPE: a fila de mapas
// ------------------------------------------------------------

/** Em que pé está uma entrada da fila. Espelha core/src/types/wipe.ts. */
export type WipeMapStatus = 'draft' | 'generating' | 'ready' | 'used' | 'failed';

/**
 * Um mundo esperando a vez.
 *
 * ####  A SEED É TEXTO  ####
 *
 * Ela é transportada, comparada e exibida — nunca somada. Como
 * número ela ganharia um `.0` no caminho e viraria outra seed.
 */
export interface WipeMap {
  id: number;
  serverId: string;
  position: number;
  kind: 'procedural' | 'custom';
  seed: string | null;
  worldSize: number | null;
  level: string | null;
  levelUrl: string | null;
  /** Preenchidos pelo RustMaps. Vazios não impedem wipe nenhum. */
  rustmapsId: string | null;
  staging: boolean;
  previewUrl: string | null;
  thumbUrl: string | null;
  monuments: string[] | null;
  status: WipeMapStatus;
  lastError: string | null;
  /** Só em custom: libera o arquivo para um wipe FORÇADO. */
  versionOk: boolean;
  note: string | null;
  /** Epoch ms. `null` = ainda na fila. */
  usedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WipeMapInput {
  kind?: 'procedural' | 'custom';
  /** `null` = o agente sorteia. */
  seed?: string | null;
  worldSize?: number;
  level?: string;
  levelUrl?: string | null;
  versionOk?: boolean;
  note?: string | null;
}

/** Aviso que acompanha um 201 e NÃO impede nada. */
export interface WipeMapWarning {
  code: 'SEED_ALREADY_PLAYED';
  message: string;
}


// ------------------------------------------------------------
//  O WIPE  -  os tipos.
//
//  ####  ESTES TIPOS ESPELHAM core/src/types/wipe.ts  ####
//
//  Espelham, e não importam: o painel é um pacote separado, sem
//  dependência do core — a mesma disciplina de `ServerSpawnStatus`
//  e das outras telas. Campo trocado aqui é campo que some da
//  tela sem o typecheck dizer nada, então a regra é copiar
//  fielmente, e nunca acrescentar um campo que o contrato não
//  tem.
//
//  Toda data é epoch ms em UTC. Horário local é texto `HH:MM`
//  MAIS a zona IANA — nunca um instante com fuso embutido.
// ------------------------------------------------------------

/**
 * O que acontece com o que o jogador APRENDEU quando o mundo
 * zera.
 */
export const BP_POLICIES = ['keep', 'wipe', 'wipe_except_vip'] as const;

export type BpPolicy = (typeof BP_POLICIES)[number];

/** O que fazer quando o wipe da casa e o da Facepunch caem juntos. */
export const COLLISION_POLICIES = ['reanchor', 'absorb', 'ignore'] as const;

export type CollisionPolicy = (typeof COLLISION_POLICIES)[number];

/** De onde sai o mapa do próximo wipe. */
export const MAP_SOURCES = ['pool', 'random', 'fixed', 'keep'] as const;

export type MapSource = (typeof MAP_SOURCES)[number];

/** Quem pediu este wipe: a cadência, a Facepunch ou uma pessoa. */
export const WIPE_PLAN_KINDS = ['cadence', 'forced', 'manual'] as const;

export type WipePlanKind = (typeof WIPE_PLAN_KINDS)[number];

/** Em que pé está um wipe marcado. */
export const WIPE_PLAN_STATUSES = [
  'planned',
  'running',
  'done',
  'skipped',
  'failed',
  'absorbed',
] as const;

export type WipePlanStatus = (typeof WIPE_PLAN_STATUSES)[number];

/** De quanto em quanto tempo este servidor zera por vontade própria. */
export interface WipeCadenceSettings {
  readonly enabled: boolean;
  /** A cada quantos dias de CALENDÁRIO. 7 = semanal. */
  readonly everyDays: number;
  /** O marco zero da contagem, epoch ms. Só o dia dele importa. */
  readonly anchorAt: number;
  /** A hora local do wipe, `HH:MM`, lida no fuso abaixo. */
  readonly timeOfDay: string;
  /** A zona IANA em que aquele `HH:MM` é lido. */
  readonly timeZone: string;
  readonly bpPolicy: BpPolicy;
}

export interface WipeSettings {
  readonly cadence: WipeCadenceSettings;
  /** O forçado não tem `enabled`: ele acontece com ou sem nós. */
  readonly forced: { readonly bpPolicy: BpPolicy };
  readonly collision: {
    readonly policy: CollisionPolicy;
    /** A janela do `absorb`, em horas. Ignorada nas outras duas. */
    readonly windowHours: number;
  };
}

/** Um wipe MARCADO: a linha da agenda que o admin vê e edita. */
export interface WipePlan {
  readonly id: number;
  readonly serverId: string;
  readonly scheduledAt: number;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  readonly mapSource: MapSource;
  readonly mapPoolId: number | null;
  readonly status: WipePlanStatus;
  readonly absorbedBy: number | null;
  /** O instante que a REGRA teria gerado. É o que faz adiar ser adiar. */
  readonly generatedFor: number | null;
  /** Um humano mexeu, e a reconciliação não deve tocar. */
  readonly pinned: boolean;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * ####  `now` VEM EM TODA RESPOSTA DO WIPE  ####
 *
 * É o relógio do AGENTE, e é dele que sai a contagem regressiva.
 * Um navegador adiantado em dez minutos mostraria "faltam 3 min"
 * para um wipe que ainda tem uma hora.
 */
export interface WipeSettingsResponse {
  readonly ok: true;
  readonly now: number;
  readonly settings: WipeSettings;
  readonly message?: string;
}

export interface WipePlansResponse {
  readonly ok: true;
  readonly now: number;
  readonly plans: readonly WipePlan[];
}

/** O desfecho de mexer em UM wipe marcado. */
export interface WipePlanResponse {
  readonly ok: true;
  readonly message?: string;
  readonly plan?: WipePlan;
}

// ------------------------------------------------------------
//  O RUSTMAPS  -  a prévia
//
//  ####  A PRÉVIA É ENFEITE  ####
//
//  Nada aqui pode fazer a tela dizer que a fila está quebrada.
//  Num mundo procedural a seed É o mapa: o terreno nasce no boot,
//  com ou sem imagem, e o wipe acontece do mesmo jeito. Por isso
//  todo campo abaixo aceita "não sabemos" — e por isso `outcome`
//  existe: o `offline` é uma resposta normal, e não uma falha.
// ------------------------------------------------------------

/** O desfecho de uma conversa com o rustmaps.com. */
export type RustMapsOutcome =
  | 'ready'
  | 'queued'
  | 'denied'
  | 'throttled'
  | 'missing'
  | 'offline'
  | 'unconfigured';

/** Quanto ainda cabe na chave. `null` = o serviço não disse. */
export interface RustMapsQuota {
  readonly limit: number | null;
  readonly remaining: number | null;
  /** Epoch ms de quando a janela reinicia. */
  readonly resetAt: number | null;
}

/**
 * O bloco RUSTMAPS da sub-aba Mapas.
 *
 * Repare no que NÃO está aqui: a chave. Ela vive no `.env` do
 * agente, e uma chave que aparece na tela aparece também no print
 * que alguém cola no Discord.
 */
export interface RustMapsStatus {
  readonly ok: true;
  /** Existe `RUSTMAPS_API_KEY` no `.env` do agente? */
  readonly configured: boolean;
  /** `null` = ainda não perguntamos, ou a pergunta não chegou lá. */
  readonly valid: boolean | null;
  /** O plano, quando a resposta o nomeia. Ver a frase de `message`. */
  readonly plan: string | null;
  readonly quota: RustMapsQuota;
  readonly checkedAt: number | null;
  /** O agente pede prévia sozinho ao ver uma seed sem imagem? */
  readonly autoGenerate: boolean;
  /** Por que a geração automática está desligada. `null` = ligada. */
  readonly disabledReason: string | null;
  /** Até quando o agente está recuando por 429/5xx. Epoch ms. */
  readonly backoffUntil: number | null;
  /** O teto que a API ANUNCIA — e que ninguém mediu ainda. */
  readonly announcedRateLimit: number;
  readonly callsPerTick: number;
  readonly message: string;
}

// ------------------------------------------------------------
//  O WIPE: a execução
//
//  ####  ESTES TIPOS ESPELHAM core/src/types/wipe.ts E
//        core/src/db/wipe-runs-repository.ts  ####
//
//  O painel é export estático e não importa do `core` — os dois
//  lados são compilados separados. Um campo renomeado lá precisa
//  ser renomeado aqui, e o teste que pega a divergência é a tela
//  aberta contra o agente de verdade.
// ------------------------------------------------------------

/** Os oito passos, na ordem. Sem acento: eles são chave primária. */
export const WIPE_RUN_STEPS = [
  'avisar',
  'esvaziar',
  'parar',
  'backup',
  'apagar',
  'configurar',
  'subir',
  'pos-wipe',
] as const;

export type WipeRunStep = (typeof WIPE_RUN_STEPS)[number];

/** `skipped` não é falha: é desfecho normal de passo desligado. */
export type WipeStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** `cancelled` com dois eles, como no OperationStatus. */
export type WipeRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** O mundo de antes ou o de depois de uma execução. */
export interface WipeWorld {
  readonly level: string | null;
  readonly seed: string | null;
  readonly worldSize: number | null;
  readonly levelUrl?: string | null;
  readonly mapPoolId?: number | null;
  /** O agente sorteou a seed porque a fila estava vazia. */
  readonly drawn?: boolean;
}

export interface WipeRunStepView {
  readonly step: WipeRunStep;
  readonly position: number;
  readonly status: WipeStepStatus;
  /** A PRIMEIRA vez que o passo rodou. Uma retomada não o move. */
  readonly startedAt: number | null;
  /**
   * O começo da tentativa que está na tela — igual a `startedAt`
   * enquanto o passo não roda de novo. A DURAÇÃO sai daqui: com
   * `startedAt` ela contaria o tempo em que o agente esteve morto
   * entre o crash e a retomada.
   */
  readonly attemptStartedAt: number | null;
  readonly finishedAt: number | null;
  /** O que aquele passo fez, ou por que não fez. Vai ao lado do ✔. */
  readonly message: string | null;
}

/** Uma execução de wipe: o que aconteceu, passo a passo. */
export interface WipeRun {
  readonly id: number;
  readonly serverId: string;
  readonly planId: number | null;
  readonly operationId: string | null;
  readonly kind: WipePlanKind;
  readonly bpPolicy: BpPolicy;
  readonly fullWipe: boolean;
  readonly startedAt: number;
  /** Quando o MUNDO zera. Depois de `startedAt` quando há avisos. */
  readonly wipeAt: number;
  readonly finishedAt: number | null;
  readonly status: WipeRunStatus;
  readonly backupPath: string | null;
  readonly mapBefore: WipeWorld | null;
  readonly mapAfter: WipeWorld | null;
  readonly saveCreatedBefore: number | null;
  readonly saveCreatedAfter: number | null;
  readonly message: string | null;
  readonly steps: readonly WipeRunStepView[];
}

/** Um mundo que o agente VIU nascer, pelo SaveCreatedTime. */
export interface DetectedWipe {
  readonly id: number;
  readonly serverId: string;
  readonly saveCreatedAt: number;
  readonly level: string | null;
  readonly seed: string | null;
  readonly worldSize: number | null;
  readonly detectedAt: number;
  /** `null` = apareceu sem o agente ter mandado (wipe na mão). */
  readonly wipeRunId: number | null;
}

/** O que acontece com um arquivo neste wipe, e por quê. */
export interface WipeClassifiedFile {
  readonly name: string;
  readonly bytes: number;
  readonly fate: 'delete' | 'keep';
  readonly group: 'world' | 'uploads' | 'deaths' | 'blueprints' | 'players' | 'other';
  /** A frase que a tela mostra. Todo arquivo tem uma. */
  readonly reason: string;
}

export interface WipeSaveFolder {
  readonly path: string;
  /** `false` = o servidor nunca subiu. Não é erro. */
  readonly exists: boolean;
  readonly files: readonly WipeClassifiedFile[];
  readonly deletedCount: number;
  readonly deletedBytes: number;
  readonly keptCount: number;
  readonly keptBytes: number;
}

/** Um candidato do full wipe. NADA vem marcado por padrão. */
export interface WipePluginDataFile {
  /** Caminho relativo à pasta do servidor, com `/`. É o padrão salvo. */
  readonly path: string;
  readonly area: 'save' | 'oxide';
  /** O tamanho da linha: o arquivo mais os satélites dele. */
  readonly bytes: number;
  readonly modifiedAt: number;
  /**
   * Os `-wal`/`-shm`/`-journal` que somem JUNTO com este arquivo.
   *
   * Não são linha própria: marcar a linha marca o conjunto. O `-wal`
   * sozinho é um banco pela metade nos dois sentidos.
   */
  readonly companions: readonly string[];
  readonly selected: boolean;
  /**
   * Os padrões DA LISTA SALVA que marcam esta linha.
   *
   * A linha é um arquivo; a lista salva é de PADRÕES, e a marca
   * também vem do satélite (`...db-wal`) ou de um glob. Sem saber
   * QUEM marcou, a tela não tinha como desmarcar: tirar
   * `file.path` de uma lista que não o continha devolvia a mesma
   * lista, e a caixa voltava marcada.
   */
  readonly selectedBy: readonly string[];
}

/** A lista do full wipe: o que a tela mostra, e o que ela não mostra. */
export interface WipePluginDataListing {
  readonly files: readonly WipePluginDataFile[];
  /** Marcados que hoje não casam com nada VISTO. A escolha CONTINUA salva. */
  readonly missing: readonly string[];
  /** Marcados que podem estar numa pasta que a varredura não desceu. */
  readonly maybeTooDeep: readonly string[];
  /** Quantas linhas existem de verdade, antes do corte da tela. */
  readonly total: number;
  /** `true` quando `files` é um pedaço. O que o wipe apaga não é cortado. */
  readonly truncated: boolean;
  /** Pastas de `oxide\data` fundas demais para a varredura. */
  readonly notScanned: readonly string[];
}

export interface WipePluginDataResponse extends WipePluginDataListing {
  readonly ok: true;
  readonly now: number;
}

/**
 * Impedimento é diferente de aviso.
 *
 * `blockers` recusam o wipe, e cada um tem conserto; `warnings`
 * deixam passar, mas alguém precisa saber.
 */
export interface WipeNotice {
  readonly code: string;
  readonly message: string;
}

/** "O que este wipe vai apagar", lido do disco agora. */
export interface WipePreviewResponse {
  readonly ok: true;
  readonly now: number;
  readonly plan: WipePlan | null;
  readonly nextForcedAt: number;
  readonly bpPolicy: BpPolicy;
  readonly fullWipe: boolean;
  /**
   * A entrada da fila que ESTE wipe vai consumir — a mesma decisão
   * que a execução consome, e não a cabeça da fila.
   *
   * `null` nos dois mundos que não saem da fila, e o aviso que
   * acompanha diz qual é: `MAP_KEPT` (o plano manda manter o mapa
   * de agora) e `EMPTY_MAP_POOL` (o agente sorteia a seed).
   *
   * `KEEP_REFUSED_IN_FORCED` é o contrário dos dois: o plano manda
   * manter, o wipe é o FORÇADO e o mundo de agora é um `.map`
   * custom sem a marca de compatibilidade — o mundo sai da fila, e
   * `nextMap` traz a entrada que vai subir.
   */
  readonly nextMap: WipeMap | null;
  readonly server: {
    readonly id: string;
    readonly identity: string;
    readonly level: string | null;
    readonly seed: string | null;
    readonly worldSize: number | null;
    readonly saveFolder: string;
    /** `null` = não deu para perguntar. */
    readonly running: boolean | null;
    readonly rconConnected: boolean;
    readonly online: number | null;
  };
  readonly files: WipeSaveFolder;
  readonly pluginData: WipePluginDataListing;
  readonly backup: {
    readonly dir: string;
    readonly enabled: boolean;
    readonly needBytes: number;
    /** `null` = não deu para medir o disco. Não é reprovação. */
    readonly freeBytes: number | null;
    readonly ok: boolean;
    readonly reason: string | null;
  };
  readonly blockers: readonly WipeNotice[];
  readonly warnings: readonly WipeNotice[];
}

/** Como o agente executa. Espelha `WipeExecSettings` do core. */
export interface WipeExecSettings {
  readonly announce: {
    /** Quantos minutos ANTES cada aviso sai. Do maior para o menor. */
    readonly offsetsMinutes: readonly number[];
    readonly text: string;
    readonly tag: string;
    readonly tagColor: string;
    readonly color: string;
    readonly size: number;
  };
  readonly drain: {
    readonly enabled: boolean;
    readonly waitMinutes: number;
    /** Matar o processo sem RCON. Perde tudo desde o último save. */
    readonly force: boolean;
  };
  readonly backup: { readonly enabled: boolean; readonly keep: number };
  /** O full wipe. A lista nasce VAZIA, e é de padrões. */
  readonly pluginData: { readonly enabled: boolean; readonly patterns: readonly string[] };
  readonly post: {
    readonly resync: boolean;
    readonly announce: boolean;
    readonly announceText: string;
  };
}

export interface WipeExecSettingsResponse {
  readonly ok: true;
  readonly now: number;
  readonly settings: WipeExecSettings;
  readonly message?: string;
}

export interface WipeRunsResponse {
  readonly ok: true;
  readonly now: number;
  readonly runs: readonly WipeRun[];
  readonly worlds: readonly DetectedWipe[];
}

/** Uma linha do log da operação. O cursor é o `n`. */
export interface WipeRunLogLine {
  readonly n: number;
  readonly at: number;
  readonly text: string;
}

export interface WipeRunDetailResponse {
  readonly ok: true;
  readonly now: number;
  readonly run: WipeRun;
  /** A operação ainda está viva? `false` = só os passos, do banco. */
  readonly live: boolean;
  readonly operation: OperationView | null;
  readonly lines: readonly WipeRunLogLine[];
  readonly nextLine: number;
  readonly droppedLines: number;
}

export interface WipeRunStartResponse {
  readonly ok: true;
  readonly now: number;
  readonly run: WipeRun | null;
  readonly operationId: string | null;
  readonly message: string;
}

// ------------------------------------------------------------
//  O WIPE: os blueprints que sobrevivem
// ------------------------------------------------------------

/**
 * Quanto um nível leva de volta. Espelha core/src/wipe/blueprints.ts.
 *
 *   none   nada — ele recomeça do zero como todo mundo
 *   bench  tudo o que o jogo libera até aquela bancada
 *   all    tudo o que ele sabia
 */
export type BpRuleMode = 'none' | 'bench' | 'all';

export interface BpTierRule {
  readonly mode: BpRuleMode;
  /** 1, 2 ou 3. Só vale com `mode: 'bench'`. */
  readonly bench: number;
}

export interface BpSettings {
  /** A régua, por nível de VIP. A chave é o `tier` minúsculo. */
  readonly tiers: Readonly<Record<string, BpTierRule>>;
  /**
   * Quantas horas depois do wipe a devolução é liberada.
   *
   * `0` = assim que o jogador entrar. Com atraso, a corrida
   * inicial acontece sem a vantagem — é a manopla que separa
   * "vantagem" de "servidor decidido no primeiro dia".
   */
  readonly delayHours: number;
}

/** O retrato do último snapshot. `null` = nunca foi tirado um. */
export interface BpSnapshot {
  readonly players: number;
  readonly items: number;
  readonly createdAt: number;
  /** A execução que o tirou. `null` = foi tirado na mão. */
  readonly wipeRunId: number | null;
}

/** Quantas devoluções em cada estado, no snapshot vigente. */
export interface BpCounters {
  readonly pending: number;
  readonly sent: number;
  readonly applied: number;
  readonly expired: number;
  readonly failed: number;
}

export interface WipeBlueprintsResponse {
  readonly ok: true;
  readonly now: number;
  readonly settings: BpSettings;
  readonly snapshot: BpSnapshot | null;
  readonly counters: BpCounters;
}

export interface WipeBlueprintsSaveResponse {
  readonly ok: true;
  readonly now: number;
  readonly settings: BpSettings;
  readonly message: string;
}

export interface WipeBlueprintsSnapshotResponse {
  readonly ok: true;
  readonly now: number;
  readonly snapshot: BpSnapshot | null;
  readonly message: string;
}

export interface WipeBlueprintsRestoreResponse {
  readonly ok: true;
  readonly now: number;
  /** Quantos blueprints saíram de verdade. `0` = nada foi enviado. */
  readonly sent: number;
  /** O nível usado na régua. `null` = ele não tinha nenhum. */
  readonly tier: string | null;
  readonly counters: BpCounters;
  readonly message: string;
}

/** `GET /api/site/config` — a URL do site, e de onde ela veio. */
export interface SiteConfig {
  ok: true;
  /** A GRAVADA: o que vale no próximo restart. É a que a tela edita. */
  baseUrl: string;
  /** A EM USO: a que os clientes já construídos estão usando. */
  activeBaseUrl: string;
  /** `true` = gravado e ainda não aplicado. Falta reiniciar. */
  restartPending: boolean;
  /** `env` = o padrão da instalação; `painel` = alguém digitou. */
  source: 'env' | 'painel';
  envBaseUrl: string | null;
}

/** O pareamento de UM servidor, como a tela de estado o lê. */
export interface SitePairedServerView {
  serverId: string;
  siteServerId: string;
  hasToken: boolean;
  /**
   * `restart-pending` NÃO vem do site: é o pareamento que a tela
   * gravou e o boot ainda não carregou. Sem ele, a tela dizia
   * "não pareado" com o id gravado e visível logo acima.
   */
  status: 'unknown' | 'pending' | 'active' | 'banned' | 'orphan' | 'restart-pending';
  message: string | null;
  lastBeaconAt: string | null;
  lastBeaconError: string | null;
  /** Separa as sete causas do mesmo sintoma. Ver Docs\20 §9.6. */
  lastBeaconErrorCode: string | null;
  serverExists: boolean | null;
  currentServerId: string | null;
  wallet: {
    source: 'local' | 'remote';
    lastOkAt: string | null;
    lastError: string | null;
  };
}

/**
 * O espelho do catálogo, dentro do `GET /api/site/status`.
 *
 * `inSync` é o campo que responde "o catálogo não sai há horas; é
 * defeito?". Verdadeiro = ninguém mexeu na loja, e o silêncio é o
 * certo: o push só sai quando o conteúdo muda. Falso = há mudança
 * presa, e `reason` diz por quê.
 */
export interface SiteCatalogView {
  /** O `SITE_CATALOG_PUSH_ENABLED` do agente. */
  enabled: boolean;
  /** O espelho foi construído? Precisa de `enabled` E de carteira. */
  running: boolean;
  /** Só preenchido quando algo está parado. Em regime, `null`. */
  reason: string | null;
  version: string | null;
  inSync: boolean | null;
  lastPushAt: string | null;
  lastPushError: string | null;
  mirrored: { serverId: string; version: string | null; at: string | null }[];
}

/**
 * O espelho de VIP, dentro do `GET /api/site/status`.
 *
 * ####  ELE RESPONDE UMA PERGUNTA QUE O CATÁLOGO NÃO TEM  ####
 *
 * A loja em dia é o normal e o silêncio é bom sinal. O VIP não: ele
 * tem PRAZO, e o retrato muda sozinho quando alguém vence. Espelho
 * parado aqui não é "nada mudou" — é o site dizendo que gente sem
 * VIP tem VIP.
 *
 * `routeMissing` é o estado esperado enquanto o site não subir a
 * rota, e vem separado de `lastPushError` de propósito: ele não é
 * defeito do agente, e a tela não pode fazer parecer que é.
 */
export interface SiteVipMirrorView {
  /** O espelho foi construído? Precisa de pareamento com carteira. */
  running: boolean;
  /** Só preenchido quando algo está parado. Em regime, `null`. */
  reason: string | null;
  version: string | null;
  /** Quantos VIPs o retrato representa. `null` = não há espelho. */
  count: number | null;
  inSync: boolean | null;
  /** O site ainda não tem `/api/agent/vip/mirror`. Ver Docs/24. */
  routeMissing: boolean;
  lastPushAt: string | null;
  lastPushError: string | null;
  mirrored: { serverId: string; version: string | null; at: string | null }[];
}

/** `GET /api/site/status` — a primeira tela de "a loja parou". */
export interface SiteStatus {
  ok: true;
  paired: boolean;
  baseUrl: string | null;
  servers: SitePairedServerView[];
  catalog: SiteCatalogView;
  vipMirror: SiteVipMirrorView;
  purchases: {
    pendingOrphan: number;
    chargeUnknown: number;
    unprovable: number;
    refundRejected: number;
  };
}
