// ============================================================
//  config.ts  -  de onde vem TODA configuração do agente.
//
//  Duas fontes, e elas respondem perguntas diferentes:
//
//      .env                 o AGENTE      porta da API, senha do
//                                         painel, se o vigia da
//                                         Steam atualiza sozinho
//
//      Configs\<id>.ini     um SERVIDOR   hostname, mapa, as
//                                         quatro portas, a senha
//                                         do RCON daquele servidor
//
//  ------------------------------------------------------------
//  ####  A PASTA Configs\ É QUEM DIZ QUANTOS SERVIDORES EXISTEM  ####
//
//  Todo arquivo `Configs\<slug>.ini` é UM servidor, e o nome do
//  arquivo é o id dele — o mesmo id que dá nome a `Servers\<id>\`,
//  `Logs\<id>\` e `Backups\<id>\`, e o mesmo que aparece na API em
//  `/api/servers/<id>/...`.
//
//  Nomes com ponto (`server.example.ini`) NÃO contam: o modelo
//  versionado mora ali, e ele não é servidor de ninguém.
//
//  ------------------------------------------------------------
//  ####  O AGENTE NÃO SOBE COM CONFIGURAÇÃO INVÁLIDA  ####
//
//  Faltou variável obrigatória, senha de RCON com caractere que o
//  WebRCON não transporta, duas configurações pedindo a mesma
//  porta: o processo imprime o que está errado e sai com código 1.
//
//  Um agente no ar com metade da configuração é pior que um
//  agente parado — ele parece funcionar até a hora em que alguém
//  precisa dele.
// ============================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { FORBIDDEN_RCON_PASSWORD_CHARS } from './servers/create-server.js';

/**
 * A raiz do projeto: a pasta que tem `core\`, `panel\`, o `.env`
 * e — em tempo de execução — `Configs\`, `Servers\` e `SteamCMD\`.
 *
 * Deduzida da localização deste módulo, e a conta é a mesma nos
 * dois modos porque os dois estão no mesmo nível:
 *
 *      core\src\config.ts   (tsx, desenvolvimento)
 *      core\dist\config.js  (node, produção)
 *
 * Sem `RUSTAGENT_HOME`, sem `releases\`, sem camada de
 * compatibilidade: quem copia a pasta leva o projeto inteiro.
 */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** O executável que prova que o jogo está em disco. */
export const RUST_DEDICATED_EXE = 'RustDedicated.exe';

/** O modelo de onde todo `.ini` novo nasce. */
export const SERVER_INI_TEMPLATE = 'server.example.ini';

/**
 * O que pode ser id de servidor NA DESCOBERTA.
 *
 * Mais frouxo que o `NEW_SERVER_ID_PATTERN` de create-server.ts:
 * este aceita o que já existe em `Configs\` (inclusive id
 * começando por dígito), aquele decide o que passa a existir.
 * Recusar aqui um arquivo que alguém criou à mão esconderia o
 * servidor da lista sem dizer por quê.
 */
export const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

// ============================================================
//  O .ini
// ============================================================

/**
 * `CHAVE=valor` por linha, `;` e `[Secao]` ignorados.
 *
 * Chave repetida fica com a ÚLTIMA — é o mesmo critério de quem
 * edita o arquivo esperando que a linha de baixo mande.
 */
export function parseIni(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) {
      continue;
    }

    const separator = line.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return values;
}

/** `null` quando o arquivo não existe ou não pôde ser lido. */
export function readIni(path: string): Record<string, string> | null {
  try {
    return parseIni(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================
//  Configuração do AGENTE (.env)
// ============================================================

/** Aceita `1/true/sim/yes/on` e `0/false/nao/no/off`. */
function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = raw.trim().toLowerCase();

  if (['1', 'true', 'sim', 'yes', 'on'].includes(value)) {
    return true;
  }

  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(value)) {
    return false;
  }

  throw new Error(`valor booleano inválido: "${raw}" (use 1 ou 0)`);
}

function intFromEnv(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} precisa ser um inteiro positivo (recebi "${raw}")`);
  }

  return value;
}

/**
 * Um caminho do `.env`: vazio = o padrão dentro do projeto.
 *
 * Relativo sai da raiz do projeto, e não do diretório de trabalho
 * de quem chamou — senão `npm start` de dentro de `core\` mudaria
 * onde o banco mora.
 */
function pathFromEnv(raw: string | undefined, root: string, fallback: string): string {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = raw.trim();

  return isAbsolute(value) ? value : resolve(root, value);
}

export interface AgentPaths {
  /** A raiz do projeto. */
  readonly root: string;
  /** `Configs\` — um `.ini` por servidor. */
  readonly configsDir: string;
  /** `Servers\` — uma instalação do jogo por servidor. */
  readonly serversDir: string;
  /** `SteamCMD\` — UM cliente para a máquina inteira. */
  readonly steamCmdDir: string;
  /** `Logs\` — por servidor, dentro. */
  readonly logsDir: string;
  /** `Backups\` — cópias do `oxide\` antes de reinstalar. */
  readonly backupsDir: string;
  /** O SQLite do agente. */
  readonly dbPath: string;
}

export interface AgentConfig {
  readonly host: string;
  readonly port: number;
  /** Bearer das integrações. Vazio = só a sessão do painel entra. */
  readonly apiToken: string;
  readonly panel: {
    readonly user: string;
    /** `scrypt:<salt>:<hash>`, em base64url. Vazio = sem login. */
    readonly passwordHash: string;
    readonly sessionTtlMs: number;
  };
  readonly ops: {
    readonly enabled: boolean;
    /** Quanto esperar o RCON responder depois de subir o jogo. */
    readonly startTimeoutMs: number;
  };
  readonly steam: {
    readonly checkIntervalMs: number;
    readonly autoUpdate: boolean;
  };
  readonly log: {
    readonly level: string;
    readonly pretty: boolean;
  };
  readonly paths: AgentPaths;
}

// ============================================================
//  Configuração de UM SERVIDOR (Configs\<id>.ini)
// ============================================================

export interface ServerPorts {
  readonly game: number;
  readonly query: number;
  readonly app: number;
  readonly rcon: number;
}

export interface ServerPaths {
  /** `Configs\<id>.ini`. */
  readonly configPath: string;
  /** `Servers\<id>\` — onde o SteamCMD instala. */
  readonly installDir: string;
  /** `Servers\<id>\RustDedicated.exe`. */
  readonly exePath: string;
  /** `Servers\<id>\oxide\plugins`. */
  readonly pluginsDir: string;
  readonly logsDir: string;
  readonly backupsDir: string;
}

export interface ServerConfig {
  readonly id: string;
  /** O rótulo do painel. Ausente no `.ini`, vale o hostname. */
  readonly name: string;
  /** O que o jogador lê na lista do jogo. */
  readonly hostname: string;
  readonly identity: string;
  readonly description: string;
  readonly url: string;
  readonly headerImage: string;
  readonly level: string;
  readonly seed: number;
  readonly worldSize: number;
  readonly maxPlayers: number;
  readonly saveInterval: number;
  /** `SERVER_ENABLED`: o agente cuida deste servidor? */
  readonly enabled: boolean;
  readonly ports: ServerPorts;
  readonly rcon: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
  };
  readonly steam: {
    readonly appId: string;
    readonly login: string;
    /** Já normalizado: `public` quando o `.ini` não diz nada. */
    readonly branch: string;
  };
  readonly paths: ServerPaths;
}

export interface LoadedConfig {
  readonly agent: AgentConfig;
  readonly servers: readonly ServerConfig[];
  /** O que foi recusado, e por quê. Vira `warn` no log do boot. */
  readonly rejected: readonly { id: string; reason: string }[];
}

/**
 * Erro de configuração, com o que fazer junto.
 *
 * Classe própria porque o tratamento é único: isto NÃO vira 500
 * numa rota — ele acontece no boot, é impresso e derruba o
 * processo com código 1.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ------------------------------------------------------------
//  Leitura
// ------------------------------------------------------------

/** Os ids que existem em `Configs\`, em ordem alfabética. */
export function discoverServerIds(configsDir: string): readonly string[] {
  let entries: readonly string[];

  try {
    entries = readdirSync(configsDir);
  } catch {
    // Pasta ausente não é erro: é uma instalação nova, sem
    // servidor nenhum. Quem recusa subir sem servidor é o boot,
    // com uma mensagem que ensina a criar o primeiro.
    return [];
  }

  return entries
    .filter((name) => name.toLowerCase().endsWith('.ini'))
    .map((name) => name.slice(0, -4))
    .filter((id) => SERVER_ID_PATTERN.test(id))
    .sort();
}

/** Onde ficam as pastas daquele servidor. */
export function resolveServerPaths(paths: AgentPaths, id: string): ServerPaths {
  const installDir = join(paths.serversDir, id);

  return {
    configPath: join(paths.configsDir, `${id}.ini`),
    installDir,
    exePath: join(installDir, RUST_DEDICATED_EXE),
    pluginsDir: join(installDir, 'oxide', 'plugins'),
    logsDir: join(paths.logsDir, id),
    backupsDir: join(paths.backupsDir, id),
  };
}

/** O jogo está em disco? É a pergunta que separa cadastrado de instalado. */
export function isInstalled(serverPaths: ServerPaths): boolean {
  return existsSync(serverPaths.exePath);
}

function requiredInt(
  values: Record<string, string>,
  key: string,
  id: string,
  min: number,
  max: number,
): number {
  const raw = values[key];
  const value = Number(raw);

  if (raw === undefined || raw.trim() === '' || !Number.isInteger(value)) {
    throw new ConfigError(
      `Configs\\${id}.ini: ${key} precisa ser um número inteiro (recebi "${raw ?? ''}").`,
    );
  }

  if (value < min || value > max) {
    throw new ConfigError(
      `Configs\\${id}.ini: ${key}=${String(value)} está fora da faixa (${String(min)} a ${String(max)}).`,
    );
  }

  return value;
}

/**
 * Lê e valida `Configs\<id>.ini`.
 *
 * @throws {ConfigError} com o nome do arquivo e a chave errada na
 * mensagem. É o texto que o operador vai ler no console ou no log
 * do PM2, e ele precisa dizer o que consertar.
 */
export function readServerConfig(paths: AgentPaths, id: string): ServerConfig {
  const serverPaths = resolveServerPaths(paths, id);
  const values = readIni(serverPaths.configPath);

  if (values === null) {
    throw new ConfigError(`Não consegui ler ${serverPaths.configPath}.`);
  }

  const password = values.RCON_PASSWORD ?? '';

  if (password === '') {
    throw new ConfigError(
      `Configs\\${id}.ini: RCON_PASSWORD está vazia. Sem ela o agente não tem como ` +
        'falar com o servidor — e quem tem a senha executa qualquer comando nele, ' +
        'então ela precisa ser longa e só desta máquina.',
    );
  }

  if (FORBIDDEN_RCON_PASSWORD_CHARS.test(password)) {
    throw new ConfigError(
      `Configs\\${id}.ini: RCON_PASSWORD contém "/", "\\", "?", "#" ou espaço. ` +
        'O WebRCON transporta a senha no CAMINHO da URL (ws://host:porta/SENHA) e o ' +
        'Rust compara o caminho cru — com esses caracteres a autenticação falha para ' +
        'sempre, em laço de reconexão, sem nada dizendo por quê.',
    );
  }

  if ((values.RCON_WEB ?? '1').trim() !== '1') {
    throw new ConfigError(
      `Configs\\${id}.ini: RCON_WEB precisa ser 1. O agente fala WebRCON (WebSocket); ` +
        'o RCON binário antigo não serve.',
    );
  }

  const hostname = (values.SERVER_HOSTNAME ?? '').trim() || id;
  const rconPort = requiredInt(values, 'RCON_PORT', id, 1, 65_535);
  const gamePort = requiredInt(values, 'SERVER_PORT', id, 1, 65_535);
  const queryPort = requiredInt(values, 'SERVER_QUERYPORT', id, 1, 65_535);

  // `SERVER_APPPORT` vazio = o padrão do Rust (28082). Com mais
  // de um servidor isso deixa de servir, mas recusar aqui
  // quebraria um `.ini` escrito à mão que só tem um servidor.
  const appPortRaw = (values.SERVER_APPPORT ?? '').trim();
  const appPort = appPortRaw === '' ? 28_082 : requiredInt(values, 'SERVER_APPPORT', id, 1, 65_535);

  if (gamePort === queryPort || gamePort === rconPort || queryPort === rconPort) {
    throw new ConfigError(
      `Configs\\${id}.ini: SERVER_PORT, SERVER_QUERYPORT e RCON_PORT precisam ser ` +
        'diferentes entre si.',
    );
  }

  const branchRaw = (values.STEAM_BRANCH ?? '').trim();

  return {
    id,
    name: (values.SERVER_NAME ?? '').trim() || hostname,
    hostname,
    identity: (values.SERVER_IDENTITY ?? '').trim() || id,
    description: (values.SERVER_DESCRIPTION ?? '').trim(),
    url: (values.SERVER_URL ?? '').trim(),
    headerImage: (values.SERVER_HEADERIMAGE ?? '').trim(),
    level: (values.SERVER_LEVEL ?? '').trim() || 'Procedural Map',
    seed: requiredInt(values, 'SERVER_SEED', id, 0, 2_147_483_647),
    worldSize: requiredInt(values, 'SERVER_WORLDSIZE', id, 1_000, 6_000),
    maxPlayers: requiredInt(values, 'SERVER_MAXPLAYERS', id, 1, 1_000),
    saveInterval: requiredInt(values, 'SERVER_SAVEINTERVAL', id, 30, 86_400),
    enabled: (values.SERVER_ENABLED ?? '1').trim() === '1',
    ports: { game: gamePort, query: queryPort, app: appPort, rcon: rconPort },
    rcon: {
      host: (values.RCON_HOST ?? '').trim() || '127.0.0.1',
      port: rconPort,
      password,
    },
    steam: {
      appId: (values.STEAM_APPID ?? '').trim() || '258550',
      login: (values.STEAM_LOGIN ?? '').trim() || 'anonymous',
      // `-beta staging` -> `staging`; vazio -> `public`.
      branch: branchRaw === '' ? 'public' : (branchRaw.split(/\s+/).pop() ?? 'public'),
    },
    paths: serverPaths,
  };
}

/**
 * Todos os servidores de `Configs\`.
 *
 * Um `.ini` inválido NÃO derruba o agente: ele entra em
 * `rejected` com o motivo, e os outros servidores continuam
 * sendo atendidos. Derrubar tudo por causa de um arquivo com
 * porta repetida deixaria os quatro servidores saudáveis fora do
 * ar por causa do quinto.
 */
export function loadServers(paths: AgentPaths): {
  servers: ServerConfig[];
  rejected: { id: string; reason: string }[];
} {
  const servers: ServerConfig[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const id of discoverServerIds(paths.configsDir)) {
    try {
      servers.push(readServerConfig(paths, id));
    } catch (error) {
      rejected.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Porta repetida entre DOIS arquivos: o segundo servidor sobe,
  // carrega o mundo inteiro e fica sem aparecer na lista da Steam
  // (ou sem aceitar RCON), sem nada explicando por quê.
  const taken = new Map<number, string>();

  for (const server of [...servers]) {
    const conflict = Object.entries(server.ports).find(([, port]) => {
      const holder = taken.get(port);
      return holder !== undefined && holder !== server.id;
    });

    if (conflict !== undefined) {
      const [field, port] = conflict;
      const holder = taken.get(port) ?? '?';

      rejected.push({
        id: server.id,
        reason:
          `a porta ${String(port)} (${field}) já é do servidor "${holder}". ` +
          `Escolha outro bloco de portas em Configs\\${server.id}.ini — ` +
          'os blocos andam de 100 em 100.',
      });

      servers.splice(servers.indexOf(server), 1);
      continue;
    }

    for (const port of Object.values(server.ports)) {
      taken.set(port, server.id);
    }
  }

  return { servers, rejected };
}

// ------------------------------------------------------------
//  O boot
// ------------------------------------------------------------

const panelHashSchema = z
  .string()
  .regex(
    /^scrypt:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
    'PANEL_PASSWORD_HASH precisa estar no formato scrypt:<salt>:<hash>. ' +
      'Gere com: npm run panel:senha -w core',
  );

/**
 * Lê o `.env`, valida tudo e devolve a configuração inteira.
 *
 * @throws {ConfigError}
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const root = projectRoot();

  loadDotenv({ path: join(root, '.env') });

  const merged = { ...process.env, ...env };

  const paths: AgentPaths = {
    root,
    configsDir: pathFromEnv(merged.CONFIGS_DIR, root, join(root, 'Configs')),
    serversDir: pathFromEnv(merged.SERVERS_DIR, root, join(root, 'Servers')),
    steamCmdDir: pathFromEnv(merged.STEAMCMD_DIR, root, join(root, 'SteamCMD')),
    logsDir: pathFromEnv(merged.LOGS_DIR, root, join(root, 'Logs')),
    backupsDir: pathFromEnv(merged.BACKUPS_DIR, root, join(root, 'Backups')),
    dbPath: pathFromEnv(merged.AGENT_DB_PATH, root, join(root, 'data', 'rustagent.db')),
  };

  let agent: AgentConfig;

  try {
    const host = (merged.AGENT_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
    const passwordHash = (merged.PANEL_PASSWORD_HASH ?? '').trim();

    if (passwordHash !== '') {
      panelHashSchema.parse(passwordHash);
    }

    agent = {
      host,
      port: intFromEnv(merged.AGENT_PORT, 8787, 'AGENT_PORT'),
      apiToken: (merged.AGENT_API_TOKEN ?? '').trim(),
      panel: {
        user: (merged.PANEL_USER ?? 'admin').trim() || 'admin',
        passwordHash,
        sessionTtlMs: intFromEnv(
          merged.PANEL_SESSION_TTL_MS,
          8 * 60 * 60_000,
          'PANEL_SESSION_TTL_MS',
        ),
      },
      ops: {
        enabled: boolFromEnv(merged.OPS_ENABLED, true),
        startTimeoutMs: intFromEnv(
          merged.SERVER_START_TIMEOUT_MS,
          15 * 60_000,
          'SERVER_START_TIMEOUT_MS',
        ),
      },
      steam: {
        checkIntervalMs: intFromEnv(
          merged.STEAM_UPDATE_CHECK_INTERVAL_MS,
          15 * 60_000,
          'STEAM_UPDATE_CHECK_INTERVAL_MS',
        ),
        autoUpdate: boolFromEnv(merged.STEAM_AUTO_UPDATE, true),
      },
      log: {
        level: (merged.LOG_LEVEL ?? 'info').trim() || 'info',
        pretty: boolFromEnv(merged.LOG_PRETTY, false),
      },
      paths,
    };
  } catch (error) {
    const detail = error instanceof z.ZodError ? (error.issues[0]?.message ?? '') : String(error);

    throw new ConfigError(`Configuração do agente inválida (.env): ${detail}`);
  }

  assertSafeExposure(agent);

  const { servers, rejected } = loadServers(paths);

  return { agent, servers, rejected };
}

/**
 * As duas recusas de exposição.
 *
 * Elas moram aqui, e não numa checagem de segurança à parte,
 * porque o momento certo de recusar é ANTES de a porta abrir.
 *
 * Quem alcança esta API instala, sobe e derruba os servidores
 * desta máquina — e num `0.0.0.0` sem senha isso é qualquer
 * pessoa que saiba o endereço.
 */
function assertSafeExposure(agent: AgentConfig): void {
  const exposed = agent.host !== '127.0.0.1' && agent.host !== 'localhost' && agent.host !== '::1';

  if (!exposed) {
    return;
  }

  if (agent.panel.passwordHash === '') {
    throw new ConfigError(
      `AGENT_HOST=${agent.host} expõe a API na rede, e PANEL_PASSWORD_HASH está vazio — ` +
        'o painel entraria sem senha. Gere uma com "npm run panel:senha -w core", ou ' +
        'volte AGENT_HOST para 127.0.0.1.',
    );
  }

  if (agent.ops.enabled && agent.apiToken.length < 32) {
    throw new ConfigError(
      `AGENT_HOST=${agent.host} expõe a API na rede com OPS_ENABLED=1, e o ` +
        'AGENT_API_TOKEN está vazio ou é curto demais. Com as operações ligadas, quem ' +
        'tem o token EXECUTA PROGRAMA nesta máquina. Gere um de 32 bytes:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
}
