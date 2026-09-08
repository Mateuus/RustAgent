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
import { VERSION } from './version.js';

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
 * Prende um número entre dois limites.
 *
 * O `SITE_BEACON_INTERVAL_MS` precisa dele por dois motivos com
 * número: acima de 5 min o site considera o agente OFFLINE entre uma
 * batida e outra, e abaixo de 5 s o canal do agente — que não tem
 * rate-limit do lado de lá — vira carga.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `STORE_MAX_OZ_PER_PURCHASE` precisa de leitura PRÓPRIA.
 *
 * `intFromEnv` recusa `0` ("precisa ser um inteiro positivo"), e `0`
 * é documentado como SEM TETO. Passar por ele derrubaria o boot de
 * quem escreveu a linha que o próprio `.env.example` sugere.
 */
function limitFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `STORE_MAX_OZ_PER_PURCHASE precisa ser 0 ou um inteiro positivo (recebi "${raw}")`,
    );
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
  /**
   * `Plugins\` — a BIBLIOTECA de plugins do agente.
   *
   * ####  UM LUGAR SÓ PARA O .cs, E NÃO UM POR SERVIDOR  ####
   *
   * Aqui mora a cópia de referência de cada plugin; a de cada
   * servidor, em `Servers\<id>\oxide\plugins`, é derivada desta.
   * Sem a biblioteca, atualizar um plugin em cinco servidores é
   * subir o mesmo arquivo cinco vezes — e ninguém consegue dizer
   * se as cinco cópias são iguais.
   */
  readonly pluginLibraryDir: string;
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
  /**
   * De onde vem o saldo de OZCoin.
   *
   * ####  DUAS CARTEIRAS, E A ESCOLHA É UMA SÓ  ####
   *
   *     url vazio      -> carteira LOCAL (o banco do agente)
   *     url preenchido -> carteira REMOTA (o site é o dono)
   *
   * A virada é preencher a variável e reiniciar. O saldo local NÃO
   * é migrado: são carteiras diferentes, e somar uma na outra sem
   * alguém mandar seria inventar dinheiro.
   *
   * Ver store/wallet.ts para o contrato que o site precisa cumprir.
   */
  readonly store: {
    /** Base da API do site, sem barra no fim. Vazio = local. */
    readonly walletUrl: string;
    readonly walletToken: string;
    /**
     * Teto de OZ por compra, aplicado NO AGENTE.
     *
     * O site não impõe teto nenhum: ele só recusa o que passa do
     * saldo. Quem impõe é quem tem o teto — e num painel irmão a
     * falta desta linha debitou 60 milhões de OZ numa requisição.
     *
     * `0` = sem teto.
     */
    readonly maxOzPerPurchase: number;
  };
  /**
   * A integração com o site OrigemZ.
   *
   * ####  `baseUrl` VAZIA DESLIGA TUDO  ####
   *
   * Sem ela: carteira LOCAL, sem beacon, sem fila de entregas, sem
   * espelho de catálogo. É o interruptor único da virada, e o botão
   * de rollback.
   *
   * ####  O QUE É GLOBAL E O QUE É DE CADA SERVIDOR  ####
   *
   * Aqui mora o que vale para o AGENTE inteiro: qual site, com que
   * cadência, com que timeout. Quem é cada servidor LÁ — o
   * `SITE_SERVER_ID` e o bearer — mora em `Configs\<id>.ini`, junto
   * da senha de RCON, porque o site modela um `Server` por linha de
   * `agents` e um RustAgent administra N servidores.
   *
   * Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md.
   */
  readonly site: {
    /** A ORIGEM do site, sem caminho e sem barra no fim. */
    readonly baseUrl: string;
    /**
     * O bearer padrão.
     *
     * Só é usado por um servidor cujo `.ini` não traga o próprio, e
     * com UM servidor em `Configs\` — que é o caso de quem segue o
     * `.env.example` à risca. Com dois ou mais, cada um traz o seu.
     */
    readonly token: string;
    /** O `SITE_SERVER_ID` padrão. Mesma regra do `token`. */
    readonly serverId: string;
    readonly timeoutMs: number;
    readonly beaconIntervalMs: number;
    readonly deliveryPollMs: number;
    readonly settleIntervalMs: number;
    /**
     * A cadência do retrato de servidor (`site/status.ts`).
     *
     * 30 s é o que o contrato pede. O piso de 10 s é do canal — o
     * retrato é telemetria, e telemetria não disputa o rate limit
     * com a fila de entregas.
     */
    readonly statusIntervalMs: number;
    /** `false` desliga o retrato periódico, e só ele. */
    readonly statusPushEnabled: boolean;
    readonly catalogPushEnabled: boolean;
    /**
     * A cadência da fila de comandos (`site/commands.ts`).
     *
     * 10 s é o teto do critério de aceite — "de enfileirado a
     * executando em ≤10 s". Mais rápido gasta cota por nada; mais
     * devagar faz o admin clicar duas vezes.
     */
    readonly commandPollMs: number;
    /**
     * `false` desliga a fila de comandos, e só ela.
     *
     * O painel LOCAL continua mandando em tudo: o que some é o botão
     * do site, não o daqui.
     */
    readonly commandsEnabled: boolean;
    /** A cadência da config desejada (`site/config.ts`). */
    readonly configIntervalMs: number;
    /** `false` desliga a convergência de config, e só ela. */
    readonly configPullEnabled: boolean;
    /**
     * A cadência da config de REDE — loja, kits e VIP
     * (`site/domains.ts`).
     *
     * Um minuto, e não os 30 s da config de servidor: catálogo muda
     * muito menos que hostname.
     */
    readonly domainIntervalMs: number;
    /**
     * `false` desliga a loja/kits/VIP vindos do site, e só isso.
     *
     * ####  ELE É O INTERRUPTOR DE "QUEM MANDA NA LOJA"  ####
     *
     * Ligado, o snapshot do site SUBSTITUI o catálogo local a cada
     * versão nova — inclusive apagando o que foi criado no painel
     * daqui. Desligado, o site continua VENDO a loja pelo espelho e
     * não escreve nada.
     */
    readonly domainPullEnabled: boolean;
    /**
     * Quais assuntos o site pode escrever.
     *
     * Vazio = todos os que este agente conhece. Serve para adotar um
     * de cada vez: `SITE_DOMAINS=store` deixa o site mandar na loja
     * e nos kits continua mandando o painel local.
     */
    readonly domains: readonly string[];
    readonly userAgent: string;
    /**
     * Fecha uma compra indeterminada REPETINDO o débito, quando a
     * rota de prova do site não existe.
     *
     * É seguro para o dinheiro NA CHAVE e CARO para o jogador: se
     * nada tinha sido cobrado, cobra agora — possivelmente de quem
     * já fechou o jogo e desistiu. Deixe `false`.
     */
    readonly settleFallbackRedebit: boolean;
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
  /**
   * `Servers\<id>\oxide\config` — o `.json` de cada plugin.
   *
   * ####  ELE NÃO É NOSSO, E SOBREVIVE A TUDO  ####
   *
   * Quem cria o arquivo é o PLUGIN, no primeiro carregamento, com os
   * padrões dele. Desligar o plugin não apaga a config, tirar o
   * plugin do acervo não apaga, reinstalar o Oxide não apaga — porque
   * ali moram horas de ajuste fino, e perdê-las por um clique faria
   * ninguém mais mexer em nada.
   */
  readonly oxideConfigDir: string;
  /**
   * `Servers\<id>\oxide\data` — o que os plugins GUARDAM.
   *
   * ####  NÃO É A MESMA COISA QUE O `oxideConfigDir`  ####
   *
   * Ali mora o que o admin ajusta; aqui, o que o plugin escreve
   * sozinho e relê no próximo boot — a tabela de loot que o
   * BetterLoot gerou do mundo, o `pending.json` do nosso
   * `OrigemZItems`. Um é decisão, o outro é estado, e por isso o
   * wipe apaga um e não o outro (ver wipe/plugin-data.ts).
   *
   * Cada plugin ganha uma SUBPASTA com o nome dele quando escreve
   * mais de um arquivo — `oxide\data\BetterLoot\LootTables.json`.
   * Quem monta esse caminho é o `oxide/data-files.ts`, com a mesma
   * trava de `..` do `pluginConfigPath`.
   */
  readonly oxideDataDir: string;
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
  /**
   * `SERVER_DISCORD`: o convite que o menu mostra.
   *
   * ####  ELE NÃO VAI PARA A LINHA DE COMANDO  ####
   *
   * O jogo não tem convar de Discord, e inventar `+server.discord`
   * cairia na armadilha do `+server.password` logo abaixo: o Rust
   * aceita qualquer `+x.y` e ignora em silêncio o que não conhece.
   * Quem lê esta chave é o AGENTE, ao montar a tela do menu.
   *
   * Vazio = aquele servidor não tem Discord, e a tela diz isso em
   * vez de mostrar um endereço inventado.
   */
  readonly discord: string;
  // ####  NÃO EXISTE SENHA DE SERVIDOR NO RUST  ####
  //
  // Houve aqui um campo `password`, que virava `+server.password` na
  // linha de comando. Ele NÃO FUNCIONA, e a checagem que faltou é de
  // um comando só:
  //
  //     find password   ->  só convars de rcon.*
  //     server.password ->  o mesmo erro de um nome inventado
  //
  // O jogo aceita qualquer `+x.y` na linha de comando sem reclamar;
  // o que não existe é simplesmente ignorado. O servidor entrou
  // direto, e nada no log disse por quê.
  //
  // Trancar um servidor de Rust é trabalho de PLUGIN (whitelist por
  // SteamID, ou senha digitada no chat depois de entrar), e não de
  // configuração.
  readonly level: string;
  readonly seed: number;
  readonly worldSize: number;
  /**
   * `SERVER_LEVELURL`: o link de um arquivo `.map` de fora.
   *
   * ####  VAZIO É O NORMAL, E SIGNIFICA PROCEDURAL  ####
   *
   * Com a chave vazia o servidor gera o mundo a partir de `seed` e
   * `worldSize`, e a linha de comando sai EXATAMENTE como sempre
   * saiu — `+server.levelurl` não entra nela. Isso não é economia
   * de bytes: é a lição do `+server.password`, logo acima. O jogo
   * aceita qualquer `+x.y` sem reclamar e ignora em silêncio o que
   * não faz sentido, então um parâmetro vazio na linha de comando
   * não dá erro nenhum — ele só muda (ou deixa de mudar) o
   * comportamento sem nada no log dizendo por quê.
   *
   * Preenchido, o servidor BAIXA o arquivo no boot e a seed deixa
   * de valer.
   */
  readonly levelUrl: string;
  readonly maxPlayers: number;
  readonly saveInterval: number;
  /** `SERVER_ENABLED`: o agente cuida deste servidor? */
  readonly enabled: boolean;
  /**
   * `SERVER_CONSOLE_WINDOW`: abrir a janela de console do jogo?
   *
   * ####  ISTO NÃO MUDA O QUE O SERVIDOR FAZ  ####
   *
   * Muda quem consegue olhar para ele sem o painel. Com janela, o
   * processo aparece na barra de tarefas e dá para acompanhá-lo
   * na máquina — que é como se administrava antes do agente.
   *
   * O padrão é 0 num serviço 24/7: uma janela por servidor num
   * dedicado com cinco deles é bagunça, e — pior — o "Modo de
   * Edição Rápida" do console do Windows CONGELA o processo se
   * alguém clicar dentro da janela sem querer. O servidor trava
   * com os jogadores dentro e só volta quando alguém aperta
   * Enter.
   */
  readonly consoleWindow: boolean;
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
  /**
   * O pareamento DESTE servidor com o site OrigemZ.
   *
   * `null` = este servidor não está pareado, e a loja dele continua
   * cobrando na carteira LOCAL. Um agente pode ter uns pareados e
   * outros não — e isso é uma configuração legítima, não um erro:
   * derrubar o agente inteiro porque um servidor novo ainda não foi
   * cadastrado no site tiraria do ar os que já funcionavam.
   *
   * O bearer mora aqui, e não no `.env`, pela mesma razão da senha
   * de RCON: ele é segredo DAQUELE servidor. `Configs\*.ini` já está
   * no `.gitignore` por causa disso.
   */
  readonly site: {
    /**
     * O id NO SITE. Casa por string EXATA, maiúsculas incluídas:
     * `rust01` e `RUST01` são dois servidores diferentes para ele.
     */
    readonly serverId: string;
    /** O bearer que o site gerou ao ativar o agente. */
    readonly token: string;
  } | null;
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
    oxideConfigDir: join(installDir, 'oxide', 'config'),
    oxideDataDir: join(installDir, 'oxide', 'data'),
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

  // O pareamento com o site mora aqui, junto da senha de RCON,
  // porque ele é segredo DAQUELE servidor: o site modela um
  // `Server` por linha de `agents`, com um bearer cada.
  const siteServerId = (values.SITE_SERVER_ID ?? '').trim();
  const siteToken = (values.SITE_TOKEN ?? '').trim();

  if (siteServerId.length > 50) {
    throw new Error(
      `Configs\${id}.ini: SITE_SERVER_ID passa de 50 chars, que é o limite do site.`,
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
    // Opcional, como o `levelUrl`: um `.ini` escrito antes desta
    // chave existir continua valendo, e o menu daquele servidor só
    // não mostra o convite.
    discord: (values.SERVER_DISCORD ?? '').trim(),
    level: (values.SERVER_LEVEL ?? '').trim() || 'Procedural Map',
    seed: requiredInt(values, 'SERVER_SEED', id, 0, 2_147_483_647),
    worldSize: requiredInt(values, 'SERVER_WORLDSIZE', id, 1_000, 6_000),
    // Opcional, e vazio por padrão: um `.ini` escrito antes desta
    // chave existir continua valendo, e continua subindo o
    // servidor com os mesmos argumentos de sempre.
    levelUrl: (values.SERVER_LEVELURL ?? '').trim(),
    maxPlayers: requiredInt(values, 'SERVER_MAXPLAYERS', id, 1, 1_000),
    saveInterval: requiredInt(values, 'SERVER_SAVEINTERVAL', id, 30, 86_400),
    enabled: (values.SERVER_ENABLED ?? '1').trim() === '1',
    consoleWindow: (values.SERVER_CONSOLE_WINDOW ?? '0').trim() === '1',
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
    /**
     * O pareamento com o site, quando ele existe no `.ini`.
     *
     * Vazio aqui não é erro: quem tem UM servidor põe tudo no `.env`,
     * e `resolveSitePairings` completa depois — ela precisa da LISTA
     * inteira para saber se o padrão do `.env` é atribuível a alguém
     * sem ambiguidade.
     */
    site:
      siteServerId === '' && siteToken === ''
        ? null
        : { serverId: siteServerId, token: siteToken },
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

  // `quiet` é do dotenv 17: sem ele o pacote escreve no stdout um
  // resumo do que carregou, ANTES de o logger existir. Isso sujaria
  // a primeira linha do log com um texto que não é JSON — e quem
  // consome o log do agente por pipe espera uma linha por evento.
  loadDotenv({ path: join(root, '.env'), quiet: true });

  const merged = { ...process.env, ...env };

  const paths: AgentPaths = {
    root,
    configsDir: pathFromEnv(merged.CONFIGS_DIR, root, join(root, 'Configs')),
    serversDir: pathFromEnv(merged.SERVERS_DIR, root, join(root, 'Servers')),
    steamCmdDir: pathFromEnv(merged.STEAMCMD_DIR, root, join(root, 'SteamCMD')),
    logsDir: pathFromEnv(merged.LOGS_DIR, root, join(root, 'Logs')),
    backupsDir: pathFromEnv(merged.BACKUPS_DIR, root, join(root, 'Backups')),
    pluginLibraryDir: pathFromEnv(merged.PLUGIN_LIBRARY_DIR, root, join(root, 'Plugins')),
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
      store: {
        // A barra final sai aqui, e não em quem monta a URL: assim
        // `.../api` e `.../api/` viram a mesma coisa, e ninguém
        // depura uma barra dupla no meio de um endereço.
        walletUrl: (merged.STORE_WALLET_URL ?? '').trim().replace(/\/+$/, ''),
        walletToken: (merged.STORE_WALLET_TOKEN ?? '').trim(),
        maxOzPerPurchase: limitFromEnv(merged.STORE_MAX_OZ_PER_PURCHASE, 100_000),
      },
      site: (() => {
        // A barra final sai AQUI, e não em quem monta a URL — a mesma
        // razão do bloco `store` logo acima.
        const legacy = (merged.STORE_WALLET_URL ?? '').trim().replace(/\/+$/, '');
        const baseUrl = ((merged.SITE_BASE_URL ?? '').trim() || legacy).replace(/\/+$/, '');

        // ####  O VALOR ANTIGO TINHA OUTRA SEMÂNTICA  ####
        //
        // `STORE_WALLET_URL` era a base à qual a carteira antiga
        // acrescentava `/wallet/...`, e quem a preencheu com um
        // `/api` no fim montaria agora `.../api/api/agent/...`. O
        // sintoma seria 404 em tudo, quer dizer, "a loja parou" — e
        // ninguém procura uma barra a mais quando a loja para.
        if (baseUrl !== '' && /\/api\/?$/i.test(baseUrl)) {
          throw new Error(
            'SITE_BASE_URL é a ORIGEM do site (https://exemplo.com), sem o /api no fim — ' +
              'o agente acrescenta /api/agent/... sozinho.',
          );
        }

        const serverId = (merged.SITE_SERVER_ID ?? '').trim();

        if (serverId.length > 50) {
          throw new Error('SITE_SERVER_ID passa de 50 chars, que é o limite do site');
        }

        return {
          baseUrl,
          token: (merged.SITE_TOKEN ?? '').trim() || (merged.STORE_WALLET_TOKEN ?? '').trim(),
          serverId,
          timeoutMs: intFromEnv(merged.SITE_TIMEOUT_MS, 5_000, 'SITE_TIMEOUT_MS'),
          // O teto de 5 min é do site: acima dele o agente parece
          // morto entre uma batida e outra. O piso de 5 s é do canal.
          beaconIntervalMs: clamp(
            intFromEnv(merged.SITE_BEACON_INTERVAL_MS, 10_000, 'SITE_BEACON_INTERVAL_MS'),
            5_000,
            300_000,
          ),
          deliveryPollMs: Math.max(
            5_000,
            intFromEnv(merged.SITE_DELIVERY_POLL_MS, 15_000, 'SITE_DELIVERY_POLL_MS'),
          ),
          settleIntervalMs: intFromEnv(
            merged.SITE_SETTLE_INTERVAL_MS,
            60_000,
            'SITE_SETTLE_INTERVAL_MS',
          ),
          // O piso e o teto são os mesmos do beacon, e pela mesma
          // razão: abaixo de 10 s o retrato vira ruído no rate
          // limit do site; acima de 5 min ele deixa de ser retrato.
          statusIntervalMs: clamp(
            intFromEnv(merged.SITE_STATUS_INTERVAL_MS, 30_000, 'SITE_STATUS_INTERVAL_MS'),
            10_000,
            300_000,
          ),
          statusPushEnabled: boolFromEnv(merged.SITE_STATUS_PUSH_ENABLED, true),
          catalogPushEnabled: boolFromEnv(merged.SITE_CATALOG_PUSH_ENABLED, true),
          // O piso de 5 s é o do canal, o mesmo da fila de entregas.
          // O teto de 60 s é o ponto em que o botão do site deixa de
          // parecer um botão: acima disso o admin clica de novo.
          commandPollMs: clamp(
            intFromEnv(merged.SITE_COMMAND_POLL_MS, 10_000, 'SITE_COMMAND_POLL_MS'),
            5_000,
            60_000,
          ),
          commandsEnabled: boolFromEnv(merged.SITE_COMMANDS_ENABLED, true),
          // Os mesmos piso e teto do retrato, e pela mesma razão:
          // abaixo de 10 s vira ruído no rate limit; acima de 5 min
          // a config do site demora demais a valer.
          configIntervalMs: clamp(
            intFromEnv(merged.SITE_CONFIG_INTERVAL_MS, 30_000, 'SITE_CONFIG_INTERVAL_MS'),
            10_000,
            300_000,
          ),
          configPullEnabled: boolFromEnv(merged.SITE_CONFIG_PULL_ENABLED, true),
          // O piso de 15 s e o teto de 10 min são maiores que os da
          // config de servidor: catálogo é o corpo mais pesado que
          // atravessa este canal, e ninguém está esperando na frente
          // da tela por ele.
          domainIntervalMs: clamp(
            intFromEnv(merged.SITE_DOMAIN_INTERVAL_MS, 60_000, 'SITE_DOMAIN_INTERVAL_MS'),
            15_000,
            600_000,
          ),
          // ####  ELE NASCE DESLIGADO, E É O ÚNICO ASSIM  ####
          //
          // Todo o resto da integração ADICIONA coisa; este canal
          // SUBSTITUI o que já existe: ligá-lo por padrão faria a
          // primeira versão do site apagar a loja de quem atualizou
          // o agente sem ler nada.
          domainPullEnabled: boolFromEnv(merged.SITE_DOMAIN_PULL_ENABLED, false),
          domains: (merged.SITE_DOMAINS ?? '')
            .split(',')
            .map((domain) => domain.trim())
            .filter((domain) => domain !== ''),
          // A borda do site recusa famílias genéricas de cliente HTTP
          // com um 403 que se parece com um ban e não é.
          userAgent: (merged.SITE_USER_AGENT ?? '').trim() || `OrigemZ-Rust-Agent/${VERSION}`,
          settleFallbackRedebit: boolFromEnv(merged.SITE_SETTLE_FALLBACK_REDEBIT, false),
        };
      })(),
      paths,
    };
  } catch (error) {
    const detail = error instanceof z.ZodError ? (error.issues[0]?.message ?? '') : String(error);

    throw new ConfigError(`Configuração do agente inválida (.env): ${detail}`);
  }

  assertSafeExposure(agent);

  const { servers, rejected } = loadServers(paths);

  // A ordem importa: ela precisa da LISTA de servidores, e a
  // lista só existe a partir daqui.
  resolveSitePairings(agent, servers);

  return { agent, servers, rejected };
}

/**
 * Fecha o pareamento de cada servidor com o site.
 *
 * ####  O QUE ELA COMPLETA  ####
 *
 * Com UM servidor em `Configs\`, o `SITE_SERVER_ID` e o `SITE_TOKEN`
 * do `.env` valem para ele — é o caminho que o `.env.example` ensina,
 * e obrigar a duplicá-los no `.ini` seria cerimônia sem ganho. Com
 * dois ou mais, o padrão do `.env` NÃO é atribuído a ninguém: não há
 * como escolher por conta própria de quem é aquele bearer.
 *
 * ####  O QUE ELA RECUSA, E POR QUÊ ELA DERRUBA O BOOT  ####
 *
 * Dois servidores com o MESMO `SITE_SERVER_ID`. Eles mandariam as
 * duas lojas para o mesmo `Server` do site, e — pior — as duas filas
 * de entrega puxariam as MESMAS tarefas: o item que o jogador
 * resgatou para o PVP nasceria no PVE, ou nos dois. Não há desfecho
 * bom, e nenhum log deixaria isso óbvio depois.
 *
 * ####  O QUE ELA NÃO RECUSA  ####
 *
 * Servidor sem pareamento nenhum. Ele fica com a carteira LOCAL, e o
 * agente sobe: derrubar tudo porque um servidor novo ainda não foi
 * cadastrado no site tiraria do ar os que já funcionavam.
 */
function resolveSitePairings(agent: AgentConfig, servers: ServerConfig[]): void {
  if (agent.site.baseUrl === '') {
    return;
  }

  // O padrão do `.env` só é atribuível quando não há dúvida de quem
  // é o dono dele.
  if (servers.length === 1 && servers[0] !== undefined && servers[0].site === null) {
    const only = servers[0];

    if (agent.site.serverId !== '') {
      servers[0] = { ...only, site: { serverId: agent.site.serverId, token: agent.site.token } };
    }
  }

  const seen = new Map<string, string>();

  for (const server of servers) {
    if (server.site === null) {
      continue;
    }

    const holder = seen.get(server.site.serverId);

    if (holder !== undefined) {
      throw new ConfigError(
        `SITE_SERVER_ID="${server.site.serverId}" está em dois servidores: ` +
          `"${holder}" e "${server.id}". Cada servidor de Rust é um Server diferente no site, ` +
          'com bearer próprio — dois apontando para o mesmo id fariam as duas filas de entrega ' +
          'puxarem as mesmas tarefas, e o item resgatado num servidor nasceria no outro.',
      );
    }

    seen.set(server.site.serverId, server.id);
  }
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
