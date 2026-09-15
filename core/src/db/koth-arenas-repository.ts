// ============================================================
//  koth-arenas-repository.ts  -  onde o território acontece.
//
//  ####  NÃO CONFUNDIR COM O dungeon_spawn_points  ####
//
//  Lá o ponto é só um lugar, e o que nasce ali vem da masmorra
//  escolhida. Aqui o lugar É a disputa: o raio, a altura e o tempo
//  de captura são dele.
//
//  ####  O SORTEIO NÃO REPETE O ÚLTIMO  ####
//
//  `pickFor` evita o território usado por último quando há mais de
//  um elegível. Sem isso, o mesmo lugar sai três vezes seguidas e o
//  servidor inteiro passa a acampar lá — foi a lição do sorteio dos
//  pontos de masmorra.
//
//  Ver a migração 089.
// ============================================================

import {
  kothArenaInputSchema,
  kothRewardSchema,
  type KothArena,
  type KothArenaInput,
  type KothReward,
} from '../types/koth.js';
import type { AgentDatabase } from './database.js';

interface Row {
  readonly id: number;
  readonly server_id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly y: number | null;
  readonly radius: number;
  readonly height: number;
  readonly capture_seconds: number;
  readonly duration_seconds: number;
  readonly decay_per_second: number;
  readonly color: string;
  readonly enabled: number;
  readonly world_key: string | null;
  readonly grid: string | null;
  readonly reward: string | null;
  readonly last_used_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * O prêmio, do texto do banco para o objeto.
 *
 * ####  JSON QUEBRADO NÃO PODE DERRUBAR A TELA  ####
 *
 * A coluna é texto, e texto no banco pode ter vindo de uma versão
 * anterior, de uma edição à mão, ou de um schema que mudou. Se ele
 * não casar, vale o PADRÃO — um território sem prêmio configurado é
 * um problema menor que uma lista de territórios que não abre.
 */
function toReward(raw: string | null): KothReward {
  if (raw === null || raw.trim() === '') return kothRewardSchema.parse({});

  try {
    return kothRewardSchema.parse(JSON.parse(raw));
  } catch {
    return kothRewardSchema.parse({});
  }
}

function toArena(row: Row): KothArena {
  return {
    id: row.id,
    serverId: row.server_id,
    label: row.label,
    x: row.x,
    z: row.z,
    y: row.y,
    radius: row.radius,
    height: row.height,
    captureSeconds: row.capture_seconds,
    durationSeconds: row.duration_seconds,
    decayPerSecond: row.decay_per_second,
    color: row.color,
    enabled: row.enabled === 1,
    worldKey: row.world_key,
    grid: row.grid,
    reward: toReward(row.reward),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class KothArenasRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  list(serverId: string): readonly KothArena[] {
    const rows = this.#db
      .prepare('SELECT * FROM koth_arenas WHERE server_id = ? ORDER BY id')
      .all(serverId) as Row[];

    return rows.map(toArena);
  }

  get(serverId: string, id: number): KothArena | null {
    const row = this.#db
      .prepare('SELECT * FROM koth_arenas WHERE server_id = ? AND id = ?')
      .get(serverId, id) as Row | undefined;

    return row === undefined ? null : toArena(row);
  }

  add(
    serverId: string,
    input: KothArenaInput,
    extra: { readonly worldKey?: string | null; readonly grid?: string | null } = {},
  ): KothArena {
    const value = kothArenaInputSchema.parse(input);
    const now = Date.now();

    const result = this.#db
      .prepare(
        `INSERT INTO koth_arenas
           (server_id, label, x, z, y, radius, height, capture_seconds, duration_seconds,
            decay_per_second, color, enabled, reward, world_key, grid, created_at, updated_at)
         VALUES
           (@serverId, @label, @x, @z, @y, @radius, @height, @captureSeconds, @durationSeconds,
            @decayPerSecond, @color, @enabled, @reward, @worldKey, @grid, @now, @now)`,
      )
      .run({
        serverId,
        label: value.label,
        x: value.x,
        z: value.z,
        y: value.y,
        radius: value.radius,
        height: value.height,
        captureSeconds: value.captureSeconds,
        durationSeconds: value.durationSeconds,
        decayPerSecond: value.decayPerSecond,
        color: value.color,
        enabled: value.enabled ? 1 : 0,
        reward: JSON.stringify(value.reward),
        worldKey: extra.worldKey ?? null,
        grid: extra.grid ?? null,
        now,
      });

    const created = this.get(serverId, Number(result.lastInsertRowid));

    if (created === null) throw new Error('o território não pôde ser lido logo após a escrita');

    return created;
  }

  update(serverId: string, id: number, input: KothArenaInput): KothArena | null {
    const value = kothArenaInputSchema.parse(input);

    const result = this.#db
      .prepare(
        `UPDATE koth_arenas
            SET label = @label, x = @x, z = @z, y = @y, radius = @radius, height = @height,
                capture_seconds = @captureSeconds, duration_seconds = @durationSeconds,
                decay_per_second = @decayPerSecond, color = @color, enabled = @enabled,
                reward = @reward, updated_at = @now
          WHERE server_id = @serverId AND id = @id`,
      )
      .run({
        serverId,
        id,
        label: value.label,
        x: value.x,
        z: value.z,
        y: value.y,
        radius: value.radius,
        height: value.height,
        captureSeconds: value.captureSeconds,
        durationSeconds: value.durationSeconds,
        decayPerSecond: value.decayPerSecond,
        color: value.color,
        enabled: value.enabled ? 1 : 0,
        reward: JSON.stringify(value.reward),
        now: Date.now(),
      });

    return result.changes === 0 ? null : this.get(serverId, id);
  }

  remove(serverId: string, id: number): boolean {
    const result = this.#db
      .prepare('DELETE FROM koth_arenas WHERE server_id = ? AND id = ?')
      .run(serverId, id);

    return result.changes > 0;
  }

  markUsed(serverId: string, id: number, at: number = Date.now()): void {
    this.#db
      .prepare('UPDATE koth_arenas SET last_used_at = ? WHERE server_id = ? AND id = ?')
      .run(at, serverId, id);
  }

  /**
   * Guarda a que mundo aquele ponto pertence.
   *
   * Chamado quando o território é conferido contra o servidor. Um
   * território sem `worldKey` é um que nunca foi conferido — e a
   * tela mostra isso, em vez de fingir que está tudo certo.
   */
  markChecked(
    serverId: string,
    id: number,
    data: { readonly worldKey: string | null; readonly grid: string | null },
  ): void {
    this.#db
      .prepare('UPDATE koth_arenas SET world_key = ?, grid = ?, updated_at = ? WHERE server_id = ? AND id = ?')
      .run(data.worldKey, data.grid, Date.now(), serverId, id);
  }

  /**
   * Os territórios de OUTRO mundo.
   *
   * Eles não somem no wipe — apagar sozinho é o tipo de coisa que
   * ninguém relaciona com o botão que apertou. Ficam, e a tela cobra
   * a revalidação, que custa um clique.
   */
  staleFor(serverId: string, worldKey: string): readonly KothArena[] {
    return this.list(serverId).filter(
      (arena) => arena.worldKey !== null && arena.worldKey !== worldKey,
    );
  }

  /**
   * Sorteia um território para a próxima execução.
   *
   * `null` = não há nenhum elegível, e quem chama ADIA em vez de
   * erguer em (0,0) — que é quase sempre oceano.
   */
  pickFor(
    serverId: string,
    options: { readonly worldKey?: string | null; readonly random?: () => number } = {},
  ): KothArena | null {
    const usable = this.list(serverId).filter((arena) => {
      if (!arena.enabled) return false;

      // Um território marcado em outro mapa não vale: aquele x/z é
      // outro lugar agora, e pode ser fundo de lago.
      if (
        options.worldKey !== undefined &&
        options.worldKey !== null &&
        arena.worldKey !== null &&
        arena.worldKey !== options.worldKey
      ) {
        return false;
      }

      return true;
    });

    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0] ?? null;

    // Evita o último usado. Com dois territórios isso alterna; com
    // muitos, apenas tira o repetido da mesa.
    const last = usable.reduce<KothArena | null>(
      (winner, arena) =>
        arena.lastUsedAt !== null && (winner === null || arena.lastUsedAt > (winner.lastUsedAt ?? 0))
          ? arena
          : winner,
      null,
    );

    const pool = last === null ? usable : usable.filter((arena) => arena.id !== last.id);
    const random = options.random ?? Math.random;
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));

    return pool[index] ?? null;
  }
}
