// ============================================================
//  monuments.ts  -  o que existe no mapa, e onde.
//
//  `world.monuments` é um comando NATIVO do Rust: ele imprime uma
//  tabela com tipo, nome, prefab e posição de cada monumento do
//  mundo carregado. Nenhum plugin envolvido.
//
//  ------------------------------------------------------------
//  ####  ELES NÃO MUDAM ENQUANTO O MAPA É O MESMO  ####
//
//  Monumento é geração de mundo: nasce com a seed e só some no
//  wipe. Por isso a leitura é guardada em memória, com o TAMANHO e
//  a SEED na chave — a mesma ideia do nome do arquivo da imagem do
//  mapa. Wipe muda a seed, a chave deixa de casar, e a lista é
//  relida sozinha.
//
//  Sem o cache, cada abertura do mapa mandaria um comando que
//  imprime ~40 linhas para devolver sempre a mesma coisa.
//
//  ####  E ELES SÃO A ÚNICA REFERÊNCIA FIXA DO MAPA  ####
//
//  Foi com eles que a escala da imagem foi corrigida: o Harbor fica
//  na costa, e projetá-lo em mar aberto provou que a cobertura
//  estava errada. Um ponto de referência que não anda vale mais que
//  dez jogadores que andam.
// ============================================================

import { ApiError } from '../http/error-response.js';
import type { OpsRcon } from '../ops/service.js';
import { gridLabel } from './grid.js';

export interface Monument {
  /** `Town`, `Radtown`, `Airport`… como o jogo classifica. */
  readonly type: string;
  /** `Launch Site`, `Harbor`. */
  readonly name: string;
  readonly x: number;
  readonly z: number;
  /** A célula do mapa, para a lista e a busca. */
  readonly grid: string | null;
}

/**
 * Uma linha da tabela do `world.monuments`.
 *
 * O parser se apoia no FIM da linha: a posição vem entre parênteses
 * no final, o prefab é o campo que começa com `assets/`, e o que
 * sobra entre o tipo e o prefab é o nome — que pode ter espaços
 * (`Large Fishing Village`). Partir a linha por espaço quebraria
 * justamente nesses.
 */
const LINE = /^(\S+)\s+(.+?)\s+(assets\/\S+)\s+\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)\s*$/;

export function parseMonuments(response: string, worldSize: number): readonly Monument[] {
  const monuments: Monument[] = [];

  for (const rawLine of response.split(/\r?\n/)) {
    const match = LINE.exec(rawLine.trim());

    if (match === null) {
      continue;
    }

    const x = Number(match[4]);
    const z = Number(match[6]);

    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      continue;
    }

    monuments.push({
      type: match[1] ?? '',
      name: match[2] ?? '',
      x,
      // O `y` (match[5]) é ALTURA e não entra: mapa é 2D.
      z,
      grid: gridLabel(x, z, worldSize),
    });
  }

  return monuments;
}

interface CacheEntry {
  readonly key: string;
  readonly monuments: readonly Monument[];
}

/**
 * A lista de monumentos de cada servidor, guardada.
 *
 * Ver o cabeçalho: a chave carrega tamanho e seed, então o wipe a
 * invalida sozinho.
 */
export class MonumentReader {
  readonly #cache = new Map<string, CacheEntry>();

  /**
   * @throws {ApiError} 503 sem RCON.
   */
  async list(
    serverId: string,
    rcon: OpsRcon,
    world: { readonly worldSize: number; readonly seed: number },
  ): Promise<readonly Monument[]> {
    const key = `${String(world.worldSize)}:${String(world.seed)}`;
    const cached = this.#cache.get(serverId);

    if (cached !== undefined && cached.key === key) {
      return cached.monuments;
    }

    if (!rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `Sem conexão com o RCON do servidor "${serverId}". Os monumentos são do mundo ` +
          'carregado — só o servidor no ar sabe quais são.',
        503,
      );
    }

    const monuments = parseMonuments(await rcon.send('world.monuments'), world.worldSize);

    // Lista vazia NÃO entra no cache: ela é o sintoma de uma
    // resposta que não deu para ler, e guardá-la deixaria o mapa sem
    // monumentos até o agente reiniciar.
    if (monuments.length > 0) {
      this.#cache.set(serverId, { key, monuments });
    }

    return monuments;
  }
}
