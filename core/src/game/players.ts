// ============================================================
//  players.ts  -  quem está online, agora.
//
//  Duas fontes, e a escolha entre elas NÃO é do operador:
//
//    origemz.players   com o OrigemZAgent ligado naquele servidor.
//                      Dá posição, vivo/dormindo, vida, ping e
//                      tempo de conexão
//    playerlist        o nativo do Rust. Dá SteamID, nome, ping,
//                      tempo e vida — e nada de posição
//
//  O agente sabe se o plugin está ligado ali (o acervo responde
//  isso) e usa o que há. A tela DIZ qual fonte está em uso e
//  oferece ligar o plugin quando ele estiver disponível e
//  desligado — mas ninguém precisa escolher uma fonte para ver a
//  lista.
//
//  ------------------------------------------------------------
//  ####  RESPOSTA FORA DO CONTRATO O AGENTE RECUSA  ####
//
//  O plugin promete um JSON de uma linha. Vindo outra coisa, isto
//  aqui levanta `PLUGIN_INVALID_RESPONSE` — e não um `catch`
//  silencioso que devolve lista vazia.
//
//  "Zero jogadores" e "não consegui perguntar" são respostas
//  diferentes, e a segunda não pode se disfarçar da primeira: um
//  servidor cheio apareceria vazio, e ninguém iria procurar
//  defeito num número que parece plausível.
//
//  ####  O QUE FALTA É DITO, E NÃO INVENTADO  ####
//
//  Sem o plugin, `position`, `isAlive` e `isSleeping` vêm `null` —
//  nunca `0` nem `false`. Ver Docs\07-PAINEL.md: ausente vira
//  travessão, e um "vivo" inventado é pior que um campo vazio.
// ============================================================

import { sanitizeArgument } from '../bans/rust-bans.js';
import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';
import { gridLabel, worldGrid, type WorldGrid } from './grid.js';
import {
  buildPlayersCommand,
  firstJsonLine,
  PLAYERS_DEFAULT_LIMIT,
  PLAYERS_PLUGIN,
  playersResponseSchema,
  type Position,
} from './plugin-contract.js';

/** Um jogador, venha ele de onde vier. */
export interface PlayerView {
  readonly steamId: string;
  readonly name: string;
  /** `null` = a fonte atual não sabe. Ver o cabeçalho. */
  readonly health: number | null;
  readonly isAlive: boolean | null;
  readonly isSleeping: boolean | null;
  readonly ping: number | null;
  readonly connectedSeconds: number | null;
  readonly position: Position | null;
  /**
   * A célula do mapa: `G12`.
   *
   * Calculada AQUI, e não na tela, por dois motivos: a constante da
   * grade tem um dono só (game/grid.ts), e é assim que a lista de
   * jogadores mostra "onde ele está" numa coluna — `G12` responde a
   * pergunta que `(120.5, -840.2)` obriga a traduzir.
   *
   * `null` sem posição, ou seja, sempre que a fonte for o
   * `playerlist` nativo.
   */
  readonly grid: string | null;
}

/** O estado de um plugin no acervo daquele servidor. */
export interface PluginState {
  /** `null` = ele nem está no acervo daquele servidor. */
  readonly id: number | null;
  readonly enabled: boolean;
}

/**
 * O que o leitor precisa saber sobre plugins.
 *
 * Interface mínima, e de propósito: quem a satisfaz em produção é
 * o `PluginLibrary` (pelo `serverList`), e um teste a satisfaz com
 * uma função. Ler a tabela `plugins` daqui seria um segundo
 * caminho para a mesma pergunta — e o segundo é o que diverge no
 * primeiro ajuste.
 */
export interface PluginPresence {
  stateOf(serverId: string, pluginName: string): Promise<PluginState>;
}

export interface PlayersSnapshot {
  /** De onde vieram os dados desta lista. */
  readonly source: 'plugin' | 'nativo';
  /** Quantos estão conectados no total. */
  readonly total: number;
  readonly players: readonly PlayerView[];
  /**
   * O tamanho do mundo e a grade dele.
   *
   * Vai junto porque é o que o Map View precisa para desenhar: a
   * projeção depende do `size`, e as letras/números das células
   * dependem do `cellSize`. Mandá-los daqui é o que impede a
   * constante da grade de existir uma segunda vez no navegador —
   * e de as duas divergirem no dia em que o jogo mudar a dela.
   */
  readonly world: WorldGrid;
  /**
   * O plugin que daria a posição, e o estado dele aqui.
   *
   * É o que permite a tela oferecer "ligar" em vez de só informar
   * que a posição não está disponível. `id` nulo = ele não está no
   * acervo deste servidor, e aí o caminho é a aba Plugins.
   */
  readonly plugin: {
    readonly name: string;
    readonly id: number | null;
    readonly enabled: boolean;
  };
  /**
   * Os campos que a fonte atual NÃO fornece.
   *
   * A tela usa para explicar o travessão antes de alguém concluir
   * que o dado sumiu.
   */
  readonly missing: readonly string[];
}

/** Quanto tempo a resposta do acervo vale. */
const PLUGIN_STATE_TTL_MS = 5_000;

/** Teto de páginas por consulta. 500 × 10 = 5000 jogadores. */
const MAX_PAGES = 10;

export interface PlayersReaderDeps {
  readonly plugins: PluginPresence;
}

export class PlayersReader {
  readonly #plugins: PluginPresence;
  /** id -> o último estado lido do acervo, com a hora. */
  readonly #cache = new Map<string, { at: number; state: PluginState }>();

  constructor(deps: PlayersReaderDeps) {
    this.#plugins = deps.plugins;
  }

  /**
   * A lista de quem está online.
   *
   * `worldSize` vem do `.ini` daquele servidor e serve à grade: sem
   * ele não há como dizer em que célula do mapa alguém está, e o
   * Map View não teria como projetar nada.
   *
   * @throws {ApiError} 503 sem RCON, 502 quando o plugin responde
   * fora do contrato.
   */
  async list(serverId: string, rcon: OpsRcon, worldSize: number): Promise<PlayersSnapshot> {
    assertConnected(serverId, rcon);

    const plugin = await this.#stateOf(serverId);
    const world = worldGrid(worldSize);

    const read = plugin.enabled ? await readFromPlugin(rcon, world) : await readNative(rcon);

    return { ...read, world, plugin: { name: PLAYERS_PLUGIN, ...plugin } };
  }

  /**
   * O estado do plugin naquele servidor, com cache curto.
   *
   * O acervo varre pastas para responder (ele ADOTA o `.cs` que
   * alguém copiou à mão), e a tela de jogadores atualiza a cada
   * poucos segundos. Sem o cache, cada volta do polling faria um
   * `readdir` por servidor — trabalho de disco para uma resposta
   * que muda quando alguém clica em "Ligar", e não a cada segundo.
   */
  async #stateOf(serverId: string): Promise<PluginState> {
    const cached = this.#cache.get(serverId);
    const now = Date.now();

    if (cached !== undefined && now - cached.at < PLUGIN_STATE_TTL_MS) {
      return cached.state;
    }

    try {
      const state = await this.#plugins.stateOf(serverId, PLAYERS_PLUGIN);

      this.#cache.set(serverId, { at: now, state });

      return state;
    } catch {
      // Não conseguir ler o acervo NÃO pode impedir a lista de
      // jogadores: a queda para o `playerlist` nativo é justamente
      // o caminho para quando o plugin não está disponível.
      return { id: null, enabled: false };
    }
  }
}

/**
 * Expulsa o jogador.
 *
 * `kick` age sobre quem está CONECTADO — e é isso que se quer
 * aqui: expulsar é tirar da partida agora, não impedir de voltar.
 * Para impedir, o caminho é a BanList.
 *
 * @throws {ApiError} 503 sem RCON.
 */
export async function kickPlayer(
  serverId: string,
  rcon: OpsRcon,
  steamId: string,
  reason: string | null,
): Promise<string> {
  assertConnected(serverId, rcon);

  // As aspas vêm de fora (o motivo é digitado), e uma delas no
  // meio fecharia o argumento cedo. Ver `sanitizeArgument`.
  const clean = sanitizeArgument(reason, 'expulso por um administrador');

  return rcon.send(`kick ${steamId} "${clean}"`);
}

// ------------------------------------------------------------
//  As duas fontes
// ------------------------------------------------------------

/**
 * `origemz.players`, página por página.
 *
 * O laço existe porque a resposta é paginada: o frame do WebRCON
 * não negocia tamanho, e um servidor cheio numa resposta só é
 * exatamente o caminho que o trunca. `count` é o total, e é por
 * ele que se sabe quando parar.
 */
async function readFromPlugin(
  rcon: OpsRcon,
  world: WorldGrid,
): Promise<Omit<PlayersSnapshot, 'plugin' | 'world'>> {
  const players: PlayerView[] = [];
  let offset = 0;
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await rcon.send(buildPlayersCommand({ offset, limit: PLAYERS_DEFAULT_LIMIT }));
    const parsed = playersResponseSchema.safeParse(firstJsonLine(raw));

    if (!parsed.success) {
      throw new ApiError(
        'PLUGIN_INVALID_RESPONSE',
        `O ${PLAYERS_PLUGIN} está ligado neste servidor, mas respondeu ao origemz.players em um ` +
          'formato que não bate com o contrato. A versão do plugin e a do agente podem estar ' +
          `diferentes. O que ele respondeu: ${raw.trim().slice(0, 300) || '(vazio)'}`,
        502,
      );
    }

    if (!parsed.data.ok) {
      throw new ApiError(
        'PLUGIN_ERROR',
        `O ${PLAYERS_PLUGIN} recusou o origemz.players: ${parsed.data.error}.`,
        502,
      );
    }

    total = parsed.data.count;
    players.push(...parsed.data.players.map((player) => toPlayerView(player, world)));

    // Página vazia é como o plugin diz que acabou — e o `limit`
    // que volta é o JÁ NORMALIZADO, não o que pedimos.
    if (parsed.data.players.length === 0 || players.length >= total) {
      break;
    }

    offset += parsed.data.limit;
  }

  return { source: 'plugin', total, players, missing: [] };
}

/**
 * `playerlist` — o nativo.
 *
 * Ele responde um array JSON com `SteamID`, `DisplayName`, `Ping`,
 * `ConnectedSeconds` e `Health`. O que não existe ali é POSIÇÃO, e
 * é por isso que o Map View depende do plugin.
 */
async function readNative(rcon: OpsRcon): Promise<Omit<PlayersSnapshot, 'plugin' | 'world'>> {
  const raw = await rcon.send('playerlist');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw.trim() === '' ? '[]' : raw);
  } catch {
    throw new ApiError(
      'PLAYERLIST_INVALID_RESPONSE',
      'O comando playerlist respondeu algo que não é JSON. Sem o OrigemZAgent ligado, ele é a ' +
        `única fonte de quem está online. O que ele respondeu: ${raw.trim().slice(0, 300)}`,
      502,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ApiError(
      'PLAYERLIST_INVALID_RESPONSE',
      'O comando playerlist respondeu um JSON que não é uma lista de jogadores.',
      502,
    );
  }

  const players = parsed
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(toNativePlayerView)
    .filter((player): player is PlayerView => player !== null);

  return {
    source: 'nativo',
    total: players.length,
    players,
    // Dito em voz alta para a tela não precisar deduzir o que o
    // travessão significa em cada coluna.
    missing: ['position', 'isAlive', 'isSleeping'],
  };
}

function toPlayerView(
  player: {
    steamId: string;
    name: string;
    health: number;
    isAlive: boolean;
    isSleeping: boolean;
    ping: number;
    connectedSeconds: number;
    position: Position;
  },
  world: WorldGrid,
): PlayerView {
  return {
    steamId: player.steamId,
    name: player.name,
    health: player.health,
    isAlive: player.isAlive,
    isSleeping: player.isSleeping,
    ping: player.ping,
    connectedSeconds: player.connectedSeconds,
    position: player.position,
    // `x` e `z`. O `y` é ALTURA e não entra na grade — usar `(x, y)`
    // é o erro que funciona até alguém subir num prédio.
    grid: gridLabel(player.position.x, player.position.z, world.size),
  };
}

/** `null` quando a linha não tem SteamID que sirva. */
function toNativePlayerView(entry: Record<string, unknown>): PlayerView | null {
  const steamId = asString(entry.SteamID ?? entry.steamId ?? entry.steamid);

  if (steamId === null) {
    return null;
  }

  return {
    steamId,
    name: asString(entry.DisplayName ?? entry.displayName ?? entry.name) ?? steamId,
    health: asNumber(entry.Health ?? entry.health),
    // O `playerlist` não diz nem se o jogador está vivo nem se
    // está dormindo. `null` é a resposta honesta — ver o cabeçalho.
    isAlive: null,
    isSleeping: null,
    ping: asNumber(entry.Ping ?? entry.ping),
    connectedSeconds: asNumber(entry.ConnectedSeconds ?? entry.connectedSeconds),
    position: null,
    // Sem posição não há célula. Inventar uma seria mandar quem
    // procura para um lugar onde o jogador não está.
    grid: null,
  };
}

function assertConnected(serverId: string, rcon: OpsRcon): void {
  if (!rcon.isConnected) {
    throw new ApiError(
      'RCON_UNAVAILABLE',
      `Sem conexão com o RCON do servidor "${serverId}". Ele pode estar parado ou ainda ` +
        'subindo — quem está online só dá para perguntar ao servidor.',
      503,
    );
  }
}

/**
 * O SteamID às vezes vem como número no `playerlist`.
 *
 * Ele não sobrevive a isso com precisão total, mas descartar a
 * linha seria esconder um jogador que ESTÁ no servidor. Melhor
 * lê-lo e deixar quem for banir passar pela validação de 17
 * dígitos.
 */
function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
