// ============================================================
//  messages-repository.ts  -  o que o servidor fala sozinho.
//
//  Três tabelas (migração 026), e cada uma responde a uma
//  pergunta:
//
//      messages         o que sai, e em que ritmo
//      message_targets  em quais servidores  (VAZIO = todos)
//      message_log      saiu mesmo?
//
//  ------------------------------------------------------------
//  ####  A MENSAGEM É DE REDE, COMO VIP, KIT E LOJA  ####
//
//  Escreve-se uma vez e escolhe-se em quais servidores ela sai.
//  Por isso não há `server_id` na mensagem: há uma LISTA de alvos,
//  e lista VAZIA quer dizer TODOS. Cinco cópias do mesmo aviso é
//  como a sexta correção entra em quatro delas.
//
//  Vazio querer dizer "todos" é o que o admin espera de um aviso de
//  rede recém-criado — e a alternativa seria marcar servidor por
//  servidor toda vez que um entra na frota.
//
//  ------------------------------------------------------------
//  ####  `next_at` É ESTADO, E NÃO CONFIGURAÇÃO  ####
//
//  Ele é gravado pelo relógio, e não pelo formulário. Por isso o
//  `create` e o `update` o CALCULAM em vez de aceitá-lo do corpo da
//  requisição: uma tela que mandasse `next_at` poderia empurrar uma
//  mensagem para daqui a um ano sem ninguém entender por quê.
//
//  E editar o ritmo REFAZ o `next_at`: trocar "a cada 2 h" por "a
//  cada 10 min" e continuar esperando duas horas é o defeito que
//  faz o admin salvar de novo, três vezes, achando que não gravou.
//
//  ------------------------------------------------------------
//  ####  `sent_count` SÓ CONTA O QUE SAIU  ####
//
//  Como o `claimCount` dos kits. A pergunta da tela é "isso está
//  funcionando?", e uma tentativa que o RCON recusou não é uma
//  mensagem que apareceu no chat. O detalhe das falhas está no
//  `message_log`, com o motivo.
// ============================================================

import type { MessageInput, MessageView, ScheduleKind } from '../types/messages.js';
import type { AgentDatabase } from './database.js';

/** Uma linha do `message_log`: aquela mensagem, naquele servidor. */
export interface MessageLogEntry {
  readonly id: number;
  readonly messageId: number;
  readonly serverId: string;
  /** Epoch ms. */
  readonly at: number;
  /**
   * Quantos jogadores receberam, segundo o plugin.
   *
   * Pelo `say` é sempre `0`, e ali `0` quer dizer DESCONHECIDO — o
   * jogo não devolve esse número. Ver types/messages.ts.
   */
  readonly players: number;
  readonly ok: boolean;
  /** Por que não saiu. `null` quando saiu. */
  readonly error: string | null;
}

interface MessageRow {
  readonly id: number;
  readonly name: string;
  readonly text: string;
  readonly enabled: number;
  readonly position: number;
  readonly schedule_kind: string;
  readonly every_seconds: number | null;
  readonly time_of_day: string | null;
  readonly weekdays: string | null;
  readonly run_at: number | null;
  readonly time_zone: string;
  readonly window_from: string | null;
  readonly window_to: string | null;
  readonly only_with_players: number;
  readonly min_players: number;
  readonly tag: string | null;
  readonly tag_color: string | null;
  readonly color: string | null;
  readonly size: number | null;
  readonly last_sent_at: number | null;
  readonly next_at: number | null;
  readonly sent_count: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface MessageLogRow {
  readonly id: number;
  readonly message_id: number;
  readonly server_id: string;
  readonly at: number;
  readonly players: number;
  readonly ok: number;
  readonly error: string | null;
}

/** O passo da coluna `position`, para caber alguém no meio. */
export const POSITION_STEP = 10;

export class MessagesRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * Todas as mensagens da rede, na ordem da tela.
   *
   * ####  DUAS CONSULTAS, E NÃO UMA POR MENSAGEM  ####
   *
   * Os alvos de TODAS vêm juntos. Perguntar "onde esta sai?" por
   * linha seria o N+1 clássico desta tela — que é justamente a que
   * lista tudo de uma vez.
   */
  list(): readonly MessageView[] {
    const rows = this.#db
      .prepare('SELECT * FROM messages ORDER BY position ASC, id ASC')
      .all() as MessageRow[];

    return this.#withTargets(rows);
  }

  get(id: number): MessageView | null {
    const row = this.#db.prepare('SELECT * FROM messages WHERE id = @id').get({ id }) as
      | MessageRow
      | undefined;

    return row === undefined ? null : (this.#withTargets([row])[0] ?? null);
  }

  /**
   * As que já venceram: ligadas, com `next_at` no passado.
   *
   * É a única consulta do relógio, e é por isso que o índice da
   * migração 026 é `(enabled, next_at)`: ela roda de 30 em 30
   * segundos, para sempre.
   *
   * `next_at IS NULL` fica de fora de propósito — é "não há
   * próxima", e não "está na hora". É o que faz a `once` já enviada
   * parar de aparecer aqui.
   */
  due(now: number): readonly MessageView[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM messages
          WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= @now
          ORDER BY next_at ASC, position ASC, id ASC`,
      )
      .all({ now }) as MessageRow[];

    return this.#withTargets(rows);
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Cria a mensagem e liga aos servidores, numa transação.
   *
   * `nextAt` vem calculado por quem chamou (o motor sabe de fuso;
   * o banco não). `null` = não há próxima, e a mensagem fica na
   * lista sem sair — que é o desfecho certo de um `once` marcado
   * para uma data já passada.
   */
  create(input: MessageInput, nextAt: number | null, now: number = Date.now()): MessageView {
    const run = this.#db.transaction((): number => {
      const result = this.#db
        .prepare(
          `INSERT INTO messages
             (name, text, enabled, position, schedule_kind, every_seconds, time_of_day, weekdays,
              run_at, time_zone, window_from, window_to, only_with_players, min_players,
              tag, tag_color, color, size, last_sent_at, next_at, sent_count, created_at, updated_at)
           VALUES
             (@name, @text, @enabled, @position, @schedule_kind, @every_seconds, @time_of_day, @weekdays,
              @run_at, @time_zone, @window_from, @window_to, @only_with_players, @min_players,
              @tag, @tag_color, @color, @size, NULL, @next_at, 0, @created_at, @updated_at)`,
        )
        .run({
          ...toColumns(input),
          position: this.#nextPosition(),
          next_at: nextAt,
          created_at: now,
          updated_at: now,
        });

      const id = Number(result.lastInsertRowid);

      this.#replaceTargets(id, input.targets);

      return id;
    });

    const id = run();
    const saved = this.get(id);

    if (saved === null) {
      throw new Error(`a mensagem "${input.name}" sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  /**
   * Reescreve a mensagem inteira.
   *
   * O histórico (`last_sent_at`, `sent_count`) NÃO é tocado: ele é
   * o que aconteceu, e editar o texto não desfaz os envios de
   * ontem. O `next_at`, sim — ver o cabeçalho.
   *
   * @returns `null` quando o id não existe.
   */
  update(
    id: number,
    input: MessageInput,
    nextAt: number | null,
    now: number = Date.now(),
  ): MessageView | null {
    const run = this.#db.transaction((): boolean => {
      const result = this.#db
        .prepare(
          `UPDATE messages
              SET name = @name, text = @text, enabled = @enabled,
                  schedule_kind = @schedule_kind, every_seconds = @every_seconds,
                  time_of_day = @time_of_day, weekdays = @weekdays, run_at = @run_at,
                  time_zone = @time_zone, window_from = @window_from, window_to = @window_to,
                  only_with_players = @only_with_players, min_players = @min_players,
                  tag = @tag, tag_color = @tag_color, color = @color, size = @size,
                  next_at = @next_at, updated_at = @updated_at
            WHERE id = @id`,
        )
        .run({ ...toColumns(input), id, next_at: nextAt, updated_at: now });

      if (result.changes === 0) {
        return false;
      }

      this.#replaceTargets(id, input.targets);

      return true;
    });

    return run() ? this.get(id) : null;
  }

  /**
   * Apaga a mensagem, e o log dela vai junto pela cascata.
   *
   * O log responde "ESTA mensagem está aparecendo?", e sem a
   * mensagem a pergunta deixa de existir. Quem quer calar sem
   * perder o histórico desliga (`enabled = 0`) — e é isso que a
   * tela oferece primeiro.
   */
  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM messages WHERE id = @id').run({ id }).changes > 0;
  }

  /**
   * Liga e desliga, e refaz o `next_at` junto.
   *
   * Os dois numa chamada só porque religar sem recalcular deixaria
   * a mensagem com um horário de semanas atrás — e ela sairia na
   * volta seguinte do relógio, sem ninguém pedir.
   */
  setEnabled(id: number, enabled: boolean, nextAt: number | null, now: number = Date.now()): void {
    this.#db
      .prepare(
        'UPDATE messages SET enabled = @enabled, next_at = @next_at, updated_at = @updated_at WHERE id = @id',
      )
      .run({ id, enabled: enabled ? 1 : 0, next_at: nextAt, updated_at: now });
  }

  /**
   * Só o horário. É o que o relógio usa quando o envio NÃO
   * aconteceu mas o horário mudou (a `once` que se desligou, por
   * exemplo).
   */
  setNextAt(id: number, nextAt: number | null, now: number = Date.now()): void {
    this.#db
      .prepare('UPDATE messages SET next_at = @next_at, updated_at = @updated_at WHERE id = @id')
      .run({ id, next_at: nextAt, updated_at: now });
  }

  /**
   * A mensagem SAIU: grava a hora, conta mais uma e marca a próxima.
   *
   * ####  SÓ DEPOIS DA ENTREGA  ####
   *
   * Chamar isto antes do RCON responder faria uma mensagem recusada
   * aparecer na tela como enviada — e o horário seria consumido, o
   * que é a diferença entre "sai quando o servidor voltar" e "some
   * até a semana que vem".
   */
  markSent(id: number, sentAt: number, nextAt: number | null): void {
    this.#db
      .prepare(
        `UPDATE messages
            SET last_sent_at = @sent_at, next_at = @next_at,
                sent_count = sent_count + 1, updated_at = @sent_at
          WHERE id = @id`,
      )
      .run({ id, sent_at: sentAt, next_at: nextAt });
  }

  /**
   * Troca a ordem da lista inteira.
   *
   * Recebe a fila COMPLETA, e não "suba esta": com duas telas
   * abertas, um "mova para cima" de cada uma produz uma ordem que
   * ninguém pediu. Ids que não existem são ignorados; os que não
   * vieram ficam no fim, na ordem em que estavam.
   */
  reorder(ids: readonly number[], now: number = Date.now()): void {
    const run = this.#db.transaction((): void => {
      const update = this.#db.prepare(
        'UPDATE messages SET position = @position, updated_at = @updated_at WHERE id = @id',
      );

      let position = POSITION_STEP;

      for (const id of ids) {
        update.run({ id, position, updated_at: now });
        position += POSITION_STEP;
      }

      const rest = this.#db
        .prepare(
          `SELECT id FROM messages
            WHERE id NOT IN (SELECT value FROM json_each(@ids))
            ORDER BY position ASC, id ASC`,
        )
        .all({ ids: JSON.stringify([...ids]) }) as { readonly id: number }[];

      for (const row of rest) {
        update.run({ id: row.id, position, updated_at: now });
        position += POSITION_STEP;
      }
    });

    run();
  }

  // ------------------------------------------------------
  //  O log
  // ------------------------------------------------------

  /**
   * Registra o que aconteceu com aquela fala, naquele servidor.
   *
   * ####  A FALHA ENTRA AQUI TAMBÉM  ####
   *
   * "Essa mensagem está mesmo aparecendo?" só tem resposta útil se
   * o que NÃO aconteceu também estiver escrito, com o motivo. Um
   * log só de sucessos responde "sim" sempre que a resposta é
   * "não".
   */
  log(entry: Omit<MessageLogEntry, 'id'>): number {
    const result = this.#db
      .prepare(
        `INSERT INTO message_log (message_id, server_id, at, players, ok, error)
              VALUES (@message_id, @server_id, @at, @players, @ok, @error)`,
      )
      .run({
        message_id: entry.messageId,
        server_id: entry.serverId,
        at: entry.at,
        players: entry.players,
        ok: entry.ok ? 1 : 0,
        error: entry.error,
      });

    return Number(result.lastInsertRowid);
  }

  /** As últimas linhas daquela mensagem, da mais recente para trás. */
  logOf(messageId: number, limit: number): readonly MessageLogEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM message_log
          WHERE message_id = @message_id
          ORDER BY at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ message_id: messageId, limit }) as MessageLogRow[];

    return rows.map(toLogEntry);
  }

  /**
   * Poda o log, deixando as `keep` linhas mais novas de cada
   * mensagem.
   *
   * Uma mensagem de 30 em 30 minutos em três servidores escreve 144
   * linhas por dia. Sem poda, a tabela que mais cresce depois das
   * compras seria a de um recurso que ninguém abre duas vezes por
   * mês.
   *
   * @returns quantas linhas saíram.
   */
  pruneLog(keep: number): number {
    return this.#db
      .prepare(
        `DELETE FROM message_log
          WHERE id NOT IN (
            SELECT id FROM message_log AS inner_log
             WHERE inner_log.message_id = message_log.message_id
             ORDER BY at DESC, id DESC
             LIMIT @keep
          )`,
      )
      .run({ keep }).changes;
  }

  // ------------------------------------------------------
  //  Ajudantes
  // ------------------------------------------------------

  /** A próxima posição livre, no passo de 10 em 10. */
  #nextPosition(): number {
    const row = this.#db.prepare('SELECT max(position) AS top FROM messages').get() as {
      readonly top: number | null;
    };

    return (row.top ?? 0) + POSITION_STEP;
  }

  /**
   * Troca o conjunto de servidores de uma mensagem.
   *
   * Apagar e regravar em vez de reconciliar, como nos kits: é
   * configuração, a tela manda a lista completa, e um diff só
   * criaria a chance de sobrar um servidor que alguém desmarcou.
   */
  #replaceTargets(messageId: number, targets: readonly string[]): void {
    this.#db
      .prepare('DELETE FROM message_targets WHERE message_id = @message_id')
      .run({ message_id: messageId });

    const link = this.#db.prepare(
      'INSERT OR IGNORE INTO message_targets (message_id, server_id) VALUES (@message_id, @server_id)',
    );

    for (const serverId of new Set(targets)) {
      link.run({ message_id: messageId, server_id: serverId });
    }
  }

  /** Os alvos de um lote inteiro, numa consulta só. */
  #withTargets(rows: readonly MessageRow[]): readonly MessageView[] {
    if (rows.length === 0) {
      return [];
    }

    const links = this.#db
      .prepare('SELECT message_id, server_id FROM message_targets ORDER BY message_id, server_id')
      .all() as { readonly message_id: number; readonly server_id: string }[];

    const byMessage = new Map<number, string[]>();

    for (const link of links) {
      const list = byMessage.get(link.message_id);

      if (list === undefined) {
        byMessage.set(link.message_id, [link.server_id]);
      } else {
        list.push(link.server_id);
      }
    }

    return rows.map((row) => toView(row, byMessage.get(row.id) ?? []));
  }
}

/** O input vira colunas. Uma tradução só, para o create e o update. */
function toColumns(input: MessageInput): Record<string, string | number | null> {
  const kind = input.scheduleKind;

  return {
    name: input.name,
    text: input.text,
    // 0/1: o better-sqlite3 recusa boolean como parâmetro.
    enabled: input.enabled ? 1 : 0,
    schedule_kind: kind,
    // ####  O QUE NÃO SE APLICA VIRA NULL  ####
    //
    // Trocar de `interval` para `weekly` é uma gravação só, e não
    // um estado meio antigo meio novo: um `every_seconds` que
    // sobrevivesse à troca voltaria a valer no dia em que alguém
    // marcasse `interval` de novo, com um número que ninguém
    // lembra ter digitado.
    every_seconds: kind === 'interval' ? input.everySeconds : null,
    time_of_day: kind === 'daily' || kind === 'weekly' ? input.timeOfDay : null,
    weekdays: kind === 'weekly' ? serializeWeekdays(input.weekdays) : null,
    run_at: kind === 'once' ? input.runAt : null,
    time_zone: input.timeZone,
    window_from: input.windowFrom,
    window_to: input.windowTo,
    only_with_players: input.onlyWithPlayers ? 1 : 0,
    min_players: input.minPlayers,
    tag: input.tag,
    tag_color: input.tagColor,
    color: input.color,
    size: input.size,
  };
}

/**
 * `[1, 4]` -> `'1,4'`.
 *
 * Texto, e não uma tabela de ligação: são no máximo sete números
 * que só existem juntos, sempre lidos com a mensagem e sempre
 * gravados de uma vez. Uma tabela aqui seria um JOIN a mais em toda
 * leitura para nunca ser consultada sozinha.
 */
export function serializeWeekdays(weekdays: readonly number[]): string {
  return [...new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b)
    .join(',');
}

/** `'1,4'` -> `[1, 4]`. Lixo no meio é descartado, e não quebra a linha. */
export function parseWeekdays(value: string | null): readonly number[] {
  if (value === null || value.trim() === '') {
    return [];
  }

  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

/**
 * A linha crua vira a visão do contrato.
 *
 * `schedule_kind` chega como `string` do SQLite. Quem garante os
 * valores é o `CHECK` da tabela — o estreitamento aqui só reconhece
 * isso para o TypeScript, e não substitui a trava.
 */
function toView(row: MessageRow, targets: readonly string[]): MessageView {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    enabled: row.enabled === 1,
    position: row.position,
    scheduleKind: toScheduleKind(row.schedule_kind),
    everySeconds: row.every_seconds,
    timeOfDay: row.time_of_day,
    weekdays: parseWeekdays(row.weekdays),
    runAt: row.run_at,
    timeZone: row.time_zone,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    onlyWithPlayers: row.only_with_players === 1,
    minPlayers: row.min_players,
    tag: row.tag,
    tagColor: row.tag_color,
    color: row.color,
    size: row.size,
    lastSentAt: row.last_sent_at,
    nextAt: row.next_at,
    sentCount: row.sent_count,
    targets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toScheduleKind(value: string): ScheduleKind {
  return value === 'interval' || value === 'daily' || value === 'weekly' ? value : 'once';
}

function toLogEntry(row: MessageLogRow): MessageLogEntry {
  return {
    id: row.id,
    messageId: row.message_id,
    serverId: row.server_id,
    at: row.at,
    players: row.players,
    ok: row.ok === 1,
    error: row.error,
  };
}
