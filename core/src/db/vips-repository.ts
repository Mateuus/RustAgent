// ============================================================
//  vips-repository.ts  -  quem é VIP, de que nível, até quando.
//
//  Uma tabela só (migração 010), e ela é a FONTE: o cache do
//  `OrigemZAgent` e o grupo do Oxide são reflexos dela, repovoados
//  a cada sincronização. Ver vip/service.ts.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NÃO FALA COM O JOGO  ####
//
//  Mandar `origemz.vip.sync` e `oxide.usergroup` é trabalho de
//  vip/service.ts. Aqui só entra e sai linha — e essa separação é o
//  que permite testar as regras que importam ("renovar soma sobre o
//  vencimento", "dois ativos do mesmo nível não existem") com um
//  banco em memória, sem servidor de Rust nenhum.
//
//  ####  NENHUM MÉTODO DAQUI APAGA LINHA  ####
//
//  Revogar preenche `revoked_at`; vencer é a mesma coisa com
//  `revoked_by` nulo. A concessão original continua no banco com
//  quem concedeu, quando e de onde ela veio — que é exatamente o
//  que o suporte precisa quando o jogador diz "paguei e sumiu".
//
//  ####  O steamId É STRING EM TODA PARTE  ####
//
//  No banco, aqui, no zod e no JSON. Um SteamID64 tem 17 dígitos e
//  passa de 2^53: convertido para número, ele volta arredondado — e
//  o VIP iria para a CONTA ERRADA, sem erro nenhum no caminho.
//
//  ####  E AS DATAS SÃO INTEGER EPOCH MS  ####
//
//  Como no resto deste projeto, e ao contrário do anterior (que
//  guardava TEXT ISO). É o que `Date.now()` produz e o que ordena
//  sem conversão; quem formata para ISO é a borda HTTP.
// ============================================================

import type { AgentDatabase } from './database.js';

/**
 * De onde a concessão veio.
 *
 *   `loja`     comprada
 *   `painel`   um admin concedeu
 *   `adotado`  o jogador JÁ ESTAVA no grupo do Oxide quando o
 *              agente chegou. Ver `VipList.reconcile`.
 */
export type VipOrigin = 'loja' | 'painel' | 'adotado';

/** Uma concessão, como ela está no banco. Datas em epoch ms. */
export interface VipRecord {
  readonly id: number;
  /** SteamID64, string. Ver o cabeçalho. */
  readonly steamId: string;
  /** O `Tier` do OrigemZVip.json: `bronze`, `silver`, `gold`. */
  readonly tier: string;
  /** `null` = vitalício. */
  readonly expiresAt: number | null;
  readonly origin: VipOrigin;
  readonly createdAt: number;
  readonly createdBy: string | null;
  /** `null` = ainda vale. */
  readonly revokedAt: number | null;
  /** `null` COM `revokedAt` preenchido = foi o relógio. */
  readonly revokedBy: string | null;
}

/** A concessão mais o nome do jogador, para a listagem. */
export interface VipListRecord extends VipRecord {
  /**
   * `null` = este SteamID nunca foi visto por este agente.
   *
   * E isso não é dado faltando: quem compra VIP no site e nunca
   * entrou não tem linha em `players`. É a resposta certa.
   */
  readonly playerName: string | null;
}

export interface VipGrantInput {
  readonly steamId: string;
  readonly tier: string;
  /** Epoch ms. `null` = vitalício. */
  readonly expiresAt: number | null;
  readonly origin: VipOrigin;
  readonly createdBy: string | null;
}

/**
 * O desfecho de um `grant`.
 *
 * `created` e `extended` são respostas diferentes para quem chamou:
 * a segunda quer dizer "o jogador já tinha este nível, e o tempo
 * comprado foi somado ao que faltava".
 */
export type VipGrantResult =
  | { readonly outcome: 'created'; readonly vip: VipRecord }
  | { readonly outcome: 'extended'; readonly vip: VipRecord };

export interface ListVipsOptions {
  /**
   * `true` = só as que valem AGORA (não revogadas e não vencidas);
   * `false` = só as revogadas ou vencidas; ausente = todas.
   */
  readonly active?: boolean | undefined;
  /** Trecho de SteamID ou de nome do jogador. */
  readonly query?: string | undefined;
  readonly tier?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ListVipsResult {
  readonly vips: readonly VipListRecord[];
  /** Quantas casaram com o filtro, ANTES da paginação. */
  readonly total: number;
}

interface VipRow {
  readonly id: number;
  readonly steam_id: string;
  readonly tier: string;
  readonly expires_at: number | null;
  readonly origin: string;
  readonly created_at: number;
  readonly created_by: string | null;
  readonly revoked_at: number | null;
  readonly revoked_by: string | null;
}

/**
 * "Vale AGORA" = não revogada E não vencida.
 *
 * O mesmo trecho aparece em quatro consultas, e ele PRECISA ser o
 * mesmo nas quatro: uma listagem que considerasse ativo o que a
 * sincronização considera vencido faria o painel e o jogo
 * discordarem sobre quem é VIP.
 */
const IS_ACTIVE_SQL = '(revoked_at IS NULL AND (expires_at IS NULL OR expires_at > @now))';

/**
 * O MESMO critério, com as colunas qualificadas.
 *
 * A listagem faz LEFT JOIN com `players`, e ali `steam_id` fica
 * ambíguo. Deriva do original em vez de ser escrito de novo: são
 * duas cópias do mesmo critério, e é exatamente isso que não pode
 * divergir.
 */
const IS_ACTIVE_SQL_V = IS_ACTIVE_SQL.replace(/\b(revoked_at|expires_at)\b/g, 'v.$1');

export class VipsRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  get(id: number): VipRecord | null {
    const row = this.#db.prepare('SELECT * FROM vips WHERE id = @id').get({ id }) as
      | VipRow
      | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * Os níveis que este jogador tem AGORA, do mais recente ao mais
   * antigo.
   *
   * Na REDE inteira: o VIP não é de servidor (ver a migração 010).
   */
  activeOf(steamId: string, now: number = Date.now()): readonly VipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM vips
          WHERE steam_id = @steam_id AND ${IS_ACTIVE_SQL}
          ORDER BY created_at DESC, id DESC`,
      )
      .all({ steam_id: steamId, now }) as VipRow[];

    return rows.map(toRecord);
  }

  /**
   * A linha NÃO REVOGADA daquele par (jogador, nível), se houver.
   *
   * "Não revogada" aqui é só `revoked_at IS NULL` — sem olhar
   * vencimento. É a definição do `idx_vips_active`, e é ela que
   * importa para saber se dá para inserir outra linha: uma
   * concessão vencida que o relógio ainda não fechou continua
   * ocupando o índice, e o `grant` precisa ESTENDÊ-LA em vez de
   * estourar num 500.
   */
  openOf(steamId: string, tier: string): VipRecord | null {
    const row = this.#db
      .prepare(
        'SELECT * FROM vips WHERE steam_id = @steam_id AND tier = @tier AND revoked_at IS NULL',
      )
      .get({ steam_id: steamId, tier }) as VipRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * A linha MAIS RECENTE daquele par, revogada ou não.
   *
   * ####  ELA RESPONDE O QUE `openOf` NÃO RESPONDE  ####
   *
   * "O agente já conheceu este VIP?". A reconciliação precisa
   * separar três coisas ao encontrar um jogador dentro do grupo do
   * Oxide:
   *
   *     ativo aqui              nada a fazer
   *     conhecido, sem valer    tirar do grupo — a tabela mandou
   *     nunca visto             adotar
   *
   * Com `openOf` sozinho, o segundo caso seria indistinguível do
   * terceiro: revogar um VIP com o servidor fora do ar faria a
   * reconexão ADOTAR de volta o mesmo VIP que acabou de ser
   * revogado. Mesma lição do `latestOf` da BanList.
   */
  latestOf(steamId: string, tier: string): VipRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM vips
          WHERE steam_id = @steam_id AND tier = @tier
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get({ steam_id: steamId, tier }) as VipRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /** Tudo o que já houve com aquele jogador, do mais novo ao mais antigo. */
  historyOf(steamId: string): readonly VipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM vips
          WHERE steam_id = @steam_id
          ORDER BY created_at DESC, id DESC`,
      )
      .all({ steam_id: steamId }) as VipRow[];

    return rows.map(toRecord);
  }

  /**
   * TODAS as concessões que valem agora, na rede.
   *
   * ####  SEM PAGINAÇÃO, E DE PROPÓSITO  ####
   *
   * É o que monta o payload do `origemz.vip.sync`, e esse payload é
   * UM comando de console: ele precisa caber inteiro em memória
   * antes de sair, e o teto de tamanho (ver vip/sync.ts) morde bem
   * antes de a lista pesar. Paginar aqui daria a ilusão de um
   * limite que o transporte já impõe.
   */
  active(now: number = Date.now()): readonly VipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM vips
          WHERE ${IS_ACTIVE_SQL}
          ORDER BY steam_id ASC, tier ASC`,
      )
      .all({ now }) as VipRow[];

    return rows.map(toRecord);
  }

  /**
   * As que passaram da data e ninguém revogou ainda.
   *
   * É o que o relógio consome. Um VIP vencido que ninguém tirou é
   * pior que não ter prazo: o jogador parou de pagar e continua com
   * o benefício, e quem administra descobre pelo Discord.
   */
  expired(now: number = Date.now()): readonly VipRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM vips
          WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= @now
          ORDER BY expires_at ASC, id ASC`,
      )
      .all({ now }) as VipRow[];

    return rows.map(toRecord);
  }

  /**
   * Uma página da lista, da concessão mais recente para a mais
   * antiga, com o nome do jogador quando ele existe na base.
   *
   * ####  O NOME VEM DE UM JOIN, E NÃO DE UMA SEGUNDA CONSULTA  ####
   *
   * Porque a BUSCA precisa dele. A listagem é paginada NO SERVIDOR:
   * se o nome fosse anexado depois, procurar "Fulano" devolveria
   * vazio com `total: 0` mesmo com o Fulano na primeira linha.
   *
   * O JOIN é `LEFT` porque a concessão manda: quem comprou VIP no
   * site e nunca entrou não tem linha em `players`, e um INNER o
   * esconderia da lista — justamente o jogador sobre quem alguém
   * abriria um chamado.
   *
   * O SQL é ESTÁTICO e os filtros são parâmetros que podem vir
   * nulos: montar o WHERE por concatenação seria mais um ponto em
   * que texto de query string encosta no SQL.
   */
  list(options: ListVipsOptions, now: number = Date.now()): ListVipsResult {
    const filters = {
      // 0/1/null: o better-sqlite3 recusa boolean como parâmetro.
      active: options.active === undefined ? null : options.active ? 1 : 0,
      q:
        options.query === undefined || options.query.trim() === ''
          ? null
          : `%${escapeLike(options.query.trim())}%`,
      tier: options.tier ?? null,
      now,
    };

    const from = 'FROM vips v LEFT JOIN players p ON p.steam_id = v.steam_id';

    const where = `
      WHERE (@tier IS NULL OR v.tier = @tier)
        AND (@q IS NULL OR v.steam_id LIKE @q ESCAPE '\\' OR p.name LIKE @q ESCAPE '\\')
        AND (@active IS NULL OR @active = (CASE WHEN ${IS_ACTIVE_SQL_V} THEN 1 ELSE 0 END))
    `;

    const total = (
      this.#db.prepare(`SELECT count(*) AS total ${from} ${where}`).get(filters) as {
        readonly total: number;
      }
    ).total;

    // Desempate por id: `created_at` tem resolução de milissegundos
    // e duas concessões no mesmo milissegundo não são impossíveis
    // (uma importação em lote). Sem ele, a ordem entre elas mudaria
    // de uma requisição para a outra e a paginação repetiria ou
    // pularia linha.
    const rows = this.#db
      .prepare(
        `SELECT v.*, p.name AS player_name
           ${from}
           ${where}
          ORDER BY v.created_at DESC, v.id DESC
          LIMIT @limit OFFSET @offset`,
      )
      .all({ ...filters, limit: options.limit, offset: options.offset }) as (VipRow & {
      readonly player_name: string | null;
    })[];

    return {
      vips: rows.map((row) => ({ ...toRecord(row), playerName: row.player_name })),
      total,
    };
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Concede — ou ESTENDE, se o jogador já tiver o nível.
   *
   * ####  RENOVAR SOMA SOBRE O VENCIMENTO, NUNCA SOBRE HOJE  ####
   *
   * Quem compra 30 dias faltando 20 fica com 50. A conta é
   * `max(agora, vencimento) + prazo`, e o `max` é o que faz uma
   * renovação de quem já venceu recomeçar de hoje em vez de nascer
   * no passado.
   *
   * As três regras do vitalício:
   *
   *   já é vitalício        continua vitalício — uma compra de 30
   *                         dias por cima não REBAIXA o que o
   *                         jogador tem;
   *   a compra é vitalícia  vira vitalício. Aí sim é promoção;
   *   os dois têm data      soma a duração comprada ao que faltava.
   *
   * A leitura e a escrita acontecem na MESMA transação: sem isso,
   * duas concessões simultâneas do mesmo nível poderiam ler "não
   * existe" as duas, e a segunda estouraria no índice único — um
   * 500 para quem só queria estender.
   *
   * `origin` e `createdBy` da linha continuam sendo os da PRIMEIRA
   * concessão: eles identificam de onde aquele direito nasceu, e
   * sobrescrevê-los apagaria a única pista da compra que o criou.
   */
  grant(input: VipGrantInput, now: number = Date.now()): VipGrantResult {
    const run = this.#db.transaction((): VipGrantResult => {
      const existing = this.openOf(input.steamId, input.tier);

      if (existing === null) {
        const result = this.#db
          .prepare(
            `INSERT INTO vips (steam_id, tier, expires_at, origin, created_at, created_by)
             VALUES (@steam_id, @tier, @expires_at, @origin, @created_at, @created_by)`,
          )
          .run({
            steam_id: input.steamId,
            tier: input.tier,
            expires_at: input.expiresAt,
            origin: input.origin,
            created_at: now,
            created_by: input.createdBy,
          });

        const created = this.get(Number(result.lastInsertRowid));

        if (created === null) {
          throw new Error(`o VIP de ${input.steamId} sumiu logo depois de ser gravado`);
        }

        return { outcome: 'created', vip: created };
      }

      const extended = extendExpiry(existing.expiresAt, input.expiresAt, now);

      this.#db
        .prepare('UPDATE vips SET expires_at = @expires_at WHERE id = @id')
        .run({ id: existing.id, expires_at: extended });

      return { outcome: 'extended', vip: { ...existing, expiresAt: extended } };
    });

    return run();
  }

  /**
   * Marca como revogada a concessão aberta daquele par.
   *
   * A linha FICA (ver a migração 010). `null` = não havia nada
   * aberto, e quem chamou decide se isso é 404 ou silêncio.
   *
   * Uma concessão VENCIDA e ainda não fechada pelo relógio também é
   * revogável: ela continua ocupando o índice único, e recusar aqui
   * deixaria quem administra sem como limpar o registro entre o
   * vencimento e a próxima batida.
   */
  revoke(
    steamId: string,
    tier: string,
    revokedBy: string | null,
    now: number = Date.now(),
  ): VipRecord | null {
    const run = this.#db.transaction((): VipRecord | null => {
      const existing = this.openOf(steamId, tier);

      if (existing === null) {
        return null;
      }

      this.#db
        .prepare(
          `UPDATE vips
              SET revoked_at = @now, revoked_by = @revoked_by
            WHERE id = @id AND revoked_at IS NULL`,
        )
        .run({ id: existing.id, now, revoked_by: revokedBy });

      return { ...existing, revokedAt: now, revokedBy };
    });

    return run();
  }
}

/**
 * O novo vencimento de uma concessão que já existia.
 *
 * Ver `grant`. Exportada porque é a regra que o teste do briefing
 * cobre ("renovar um VIP que ainda tem 20 dias soma sobre o
 * VENCIMENTO, e não sobre hoje") e porque ela cabe inteira numa
 * função pura.
 */
export function extendExpiry(
  currentExpiresAt: number | null,
  grantedExpiresAt: number | null,
  now: number,
): number | null {
  if (currentExpiresAt === null || grantedExpiresAt === null) {
    return null;
  }

  // A DURAÇÃO comprada, e não a data: quem pede "até daqui a 30
  // dias" está comprando 30 dias, e é isso que se soma ao que
  // faltava.
  const durationMs = Math.max(0, grantedExpiresAt - now);

  // O `max` cobre a concessão já vencida que o relógio ainda não
  // fechou: a contagem recomeça de hoje, porque dar ao jogador os
  // dias em que ele ficou SEM o benefício seria devolver tempo que
  // ele não usou.
  return Math.max(currentExpiresAt, now) + durationMs;
}

/** Vale AGORA: não revogada e não vencida. */
export function isActive(vip: VipRecord, now: number = Date.now()): boolean {
  return vip.revokedAt === null && (vip.expiresAt === null || vip.expiresAt > now);
}

/**
 * Neutraliza os curingas do LIKE.
 *
 * Sem isto, buscar por "%" no painel casaria com a base inteira e
 * um "_" casaria com qualquer caractere — a busca mentiria sobre o
 * que encontrou.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * A linha crua vira registro.
 *
 * `origin` chega como `string` do SQLite. Quem garante os valores é
 * o `CHECK` da tabela — o estreitamento aqui só reconhece isso para
 * o TypeScript, e não substitui a trava. Valor estranho vira
 * `painel`, que é o desfecho que não inventa uma compra.
 */
function toRecord(row: VipRow): VipRecord {
  return {
    id: row.id,
    steamId: row.steam_id,
    tier: row.tier,
    expiresAt: row.expires_at,
    origin: row.origin === 'loja' || row.origin === 'adotado' ? row.origin : 'painel',
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}
