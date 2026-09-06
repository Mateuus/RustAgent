// ============================================================
//  schema-banco-antigo.test.ts  -  o banco VELHO chega ao mesmo
//                                  schema do banco NOVO.
//
//  ####  O DEFEITO QUE ISTO EXISTE PARA PEGAR  ####
//
//  Uma migração roda UMA vez por banco: `runMigrations` pula todo
//  id que já está em `schema_migrations`. Isso quer dizer que
//  EDITAR uma migração já aplicada não conserta banco nenhum que
//  já a tenha rodado — o texto novo vale só para quem vier depois.
//
//  O sintoma é o pior possível: o `git diff` fica limpo, o teste
//  de sempre passa (ele roda em banco novo, que aplica o texto de
//  hoje), e quem já estava de pé sobe com uma coluna a menos até
//  o dia em que uma consulta a pede. Foi exatamente o que
//  aconteceu com `wipe_runs.wipe_at`: a 025 foi aplicada num
//  banco às 23:38 e ganhou a coluna às 00:12, no commit seguinte.
//  Aquele banco ficou com a 025 marcada como aplicada e sem a
//  coluna. O agente parou de subir em `wipeRuns.running()`.
//  Docs\17 §0.1 já avisava desta classe.
//
//  ####  COMO O TESTE PEGA  ####
//
//  Ele RECONSTRÓI um banco antigo — as migrações de hoje, menos
//  as que naquele banco rodaram com outro texto, que ficam
//  gravadas em fixtures/schema-antigo/ — e depois manda
//  `runMigrations` fazer o que faria na máquina de quem já está
//  de pé. O schema resultante tem de bater com o de um banco
//  nascido agora.
//
//  Sem a migração de conserto este teste falha: falta a coluna.
//
//  ####  O QUE FAZER QUANDO ELE FALHAR  ####
//
//  Não edite a migração antiga: guarde aqui como ela ERA (mais um
//  arquivo em fixtures/schema-antigo/, mais uma entrada em
//  BANCOS_ANTIGOS) e escreva uma migração NOVA que leve o banco
//  velho ao schema de hoje.
// ============================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { applyMigration, MIGRATIONS, runMigrations } from '../src/db/migrations.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schema-antigo');

/** O texto que uma migração REALMENTE aplicou, algum dia. */
function comoEra(arquivo: string): string {
  return readFileSync(join(FIXTURES, arquivo), 'utf8');
}

/** Um schema que existe por aí, e do qual este agente tem de partir. */
interface BancoAntigo {
  readonly nome: string;
  /** O maior id que aquele banco tem em `schema_migrations`. */
  readonly ate: number;
  /**
   * Por id, o SQL que rodou LÁ — só onde ele difere do de hoje.
   * O que não estiver aqui rodou com o texto atual.
   */
  readonly textos: Readonly<Record<number, string>>;
}

const SEM_WIPE_AT: BancoAntigo = {
  nome: '025 aplicada antes de a coluna wipe_at existir',
  ate: 29,
  textos: { 25: comoEra('025-wipe-runs-sem-wipe-at.sql') },
};

const SEM_WINDOW: BancoAntigo = {
  nome: '034 aplicada antes de a janela por ranking existir',
  ate: 42,
  textos: { 34: comoEra('034-rankings-catalog-sem-window.sql') },
};

/**
 * O banco de quem já rodou tudo até a 043.
 *
 * Sem texto diferente nenhum: aqui não houve migração editada
 * depois de aplicada — este é o caso de sempre, o de um banco em
 * dia que precisa receber a migração seguinte. Ele entra na lista
 * pelo mesmo motivo dos outros dois: provar que a 044 leva o banco
 * que já existe ao schema do banco que nasce agora.
 */
const SEM_NOME_CURTO: BancoAntigo = {
  nome: '043 aplicada antes do nome curto e do "mostrar no jogo"',
  ate: 43,
  textos: {},
};

const BANCOS_ANTIGOS: readonly BancoAntigo[] = [SEM_WIPE_AT, SEM_WINDOW, SEM_NOME_CURTO];

/**
 * Um retrato do schema, feito para COMPARAR dois bancos.
 *
 * Entra o que o agente lê: nome, tipo, `NOT NULL` e chave de cada
 * coluna, as chaves estrangeiras e os índices.
 *
 * Ficam DE FORA duas coisas, e de propósito:
 *
 *   - a POSIÇÃO da coluna na tabela (as colunas são ordenadas por
 *     nome). O SQLite só acrescenta coluna no fim, então uma
 *     coluna que chegou por `ALTER TABLE` num banco velho nunca
 *     cairia no mesmo lugar em que o `CREATE TABLE` a põe num
 *     banco novo. Nenhuma consulta deste projeto lê coluna por
 *     posição — nem uma usa `SELECT *` em tabela de escrita;
 *   - o DEFAULT. O SQLite recusa `ADD COLUMN ... NOT NULL` sem
 *     default, e o default que isso obriga a inventar não existe
 *     no `CREATE TABLE` do banco novo. Ver o teste "o preço de
 *     acrescentar a coluna depois", logo abaixo, que fixa essa
 *     diferença em vez de deixá-la invisível.
 *
 * O que o defeito desta classe produz — coluna que FALTA, tabela
 * que falta, tipo ou `NOT NULL` diferente, índice perdido — está
 * todo dentro do retrato.
 */
function retratoDoSchema(db: AgentDatabase): string {
  const objetos = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all() as readonly { type: string; name: string; sql: string | null }[];

  const linhas: string[] = [];

  for (const objeto of objetos) {
    if (objeto.type !== 'table') {
      // Índice, gatilho, visão: o próprio texto, com o espaço em
      // branco normalizado — indentação não é schema.
      linhas.push(`${objeto.type} ${objeto.name}: ${(objeto.sql ?? '').replace(/\s+/g, ' ').trim()}`);
      continue;
    }

    linhas.push(`tabela ${objeto.name}`);

    const colunas = db
      .prepare('SELECT name, type, "notnull" AS naoNulo, pk FROM pragma_table_info(?)')
      .all(objeto.name) as readonly {
      name: string;
      type: string;
      naoNulo: number;
      pk: number;
    }[];

    linhas.push(
      ...colunas
        .map(
          (coluna) =>
            `  coluna ${coluna.name} ${coluna.type} notnull=${String(coluna.naoNulo)} ` +
            `pk=${String(coluna.pk)}`,
        )
        .sort(),
    );

    const estrangeiras = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(objeto.name) as
      | readonly {
          from: string;
          table: string;
          to: string | null;
          on_delete: string;
          on_update: string;
        }[];

    linhas.push(
      ...estrangeiras
        .map(
          (fk) =>
            `  fk ${fk.from} -> ${fk.table}.${fk.to ?? '(pk)'} ` +
            `del=${fk.on_delete} upd=${fk.on_update}`,
        )
        .sort(),
    );

    const indices = db.prepare('SELECT * FROM pragma_index_list(?)').all(objeto.name) as readonly {
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }[];

    linhas.push(
      ...indices
        .map((indice) => {
          const colunasDoIndice = (
            db.prepare('SELECT name FROM pragma_index_info(?)').all(indice.name) as readonly {
              name: string | null;
            }[]
          )
            .map((coluna) => coluna.name ?? '(expressão)')
            .join(', ');

          return (
            `  indice ${indice.name} unique=${String(indice.unique)} ` +
            `origem=${indice.origin} parcial=${String(indice.partial)} (${colunasDoIndice})`
          );
        })
        .sort(),
    );
  }

  return linhas.join('\n');
}

/** A tabela de controle, igualzinha à que `runMigrations` cria. */
function criarControle(db: AgentDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

/**
 * O banco daquela máquina, como ele está HOJE: com o texto que
 * rodou lá, e com todos os ids registrados — é esse registro que
 * faz `runMigrations` pular o que já foi.
 */
function montar(antigo: BancoAntigo): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  criarControle(db);

  for (const migracao of MIGRATIONS.filter((item) => item.id <= antigo.ate)) {
    const texto = antigo.textos[migracao.id];

    if (texto === undefined) {
      applyMigration(db, migracao);
    } else {
      db.exec(texto);
    }

    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (@id, @name, @applied_at)',
    ).run({ id: migracao.id, name: migracao.name, applied_at: 1_760_000_000_000 });
  }

  return db;
}

/** Um banco nascido agora, com o schema que este binário produz. */
function bancoNovo(): AgentDatabase {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  return db;
}

describe('um banco antigo chega ao schema de um banco novo', () => {
  it.each(BANCOS_ANTIGOS)('$nome', (antigo) => {
    const velho = montar(antigo);
    const novo = bancoNovo();

    // Antes de migrar ele é DIFERENTE — sem isto o teste passaria
    // por não estar reconstruindo nada.
    expect(retratoDoSchema(velho)).not.toBe(retratoDoSchema(novo));

    runMigrations(velho);

    expect(retratoDoSchema(velho)).toBe(retratoDoSchema(novo));

    velho.close();
    novo.close();
  });
});

describe('a coluna wipe_at que faltava', () => {
  const antigo = SEM_WIPE_AT;

  it('a execução que já estava gravada ganha o horário do wipe', () => {
    const velho = montar(antigo);

    velho
      .prepare(
        `INSERT INTO servers
           (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
            rcon_host, rcon_password, install_dir, created_at, updated_at)
         VALUES
           ('server01', 'Craggy', 'server01', 1, 28015, 28016, 28017, 28082,
            '127.0.0.1', '', 'F:\\Servers\\server01', 1760000000000, 1760000000000)`,
      )
      .run();

    velho
      .prepare(
        `INSERT INTO wipe_runs
           (server_id, kind, bp_policy, full_wipe, started_at, status, created_at, updated_at)
         VALUES
           ('server01', 'manual', 'keep', 0, 1760000500000, 'done', 1760000500000,
            1760000900000)`,
      )
      .run();

    runMigrations(velho);

    const linha = velho.prepare('SELECT started_at, wipe_at FROM wipe_runs').get() as {
      started_at: number;
      wipe_at: number;
    };

    // `started_at`, e não zero nem "agora": a 025 define `wipe_at`
    // como a hora em que o mundo zera, igual ao início da execução
    // quando não houve aviso nenhum. Uma execução que é anterior à
    // coluna não tem outro horário para contar.
    expect(linha.wipe_at).toBe(1_760_000_500_000);
    expect(linha.wipe_at).toBe(linha.started_at);

    velho.close();
  });

  it('a coluna recusa nulo, no banco velho como no novo', () => {
    for (const db of [(() => {
      const velho = montar(antigo);
      runMigrations(velho);
      return velho;
    })(), bancoNovo()]) {
      const coluna = (
        db.prepare('SELECT name, "notnull" AS naoNulo FROM pragma_table_info(?)').all('wipe_runs') as
          readonly { name: string; naoNulo: number }[]
      ).find((item) => item.name === 'wipe_at');

      expect(coluna?.naoNulo).toBe(1);

      db.close();
    }
  });

  it('o preço de acrescentar a coluna depois: DEFAULT 0 e posição fora do lugar', () => {
    // Esta é a ÚNICA diferença que sobra entre os dois bancos, e
    // ela está aqui escrita para ninguém precisar descobri-la de
    // novo: o SQLite não aceita `ADD COLUMN ... NOT NULL` sem
    // default, e não sabe inserir coluna no meio da tabela.
    //
    // Nenhuma das duas é lida pelo agente: todo `INSERT` em
    // `wipe_runs` nomeia `wipe_at` (ver db/wipe-runs-repository.ts),
    // então o default nunca entra em jogo, e nenhuma consulta lê
    // coluna por posição.
    //
    // Trocar o conserto por uma reconstrução da tabela zeraria as
    // duas diferenças — e apagaria, junto, o histórico de passos:
    // `wipe_run_steps` referencia `wipe_runs(id)` com ON DELETE
    // CASCADE, e com `foreign_keys = ON` o DROP da tabela pai
    // dispara a cascata.
    //
    // ####  A RÉGUA É `updated_at`, E NÃO "A ÚLTIMA COLUNA"  ####
    //
    // Ela já foi "a última", e deixou de ser quando a migração 034
    // acrescentou `open_ranking_season` — outro ALTER, que entra
    // depois. O que este teste guarda não é a última posição: é
    // que a coluna acrescentada por ALTER cai FORA do lugar em que
    // o DDL a declara, ou seja, depois de `updated_at`, que fecha
    // o CREATE TABLE original. Amarrar a asserção ao fim da tabela
    // a faria quebrar a cada coluna nova sem que nada tivesse
    // mudado no que ela mede.
    const velho = montar(antigo);
    runMigrations(velho);
    const novo = bancoNovo();

    const wipeAt = (db: AgentDatabase): { cid: number; dflt: string | null } => {
      const coluna = (
        db.prepare('SELECT cid, name, dflt_value AS dflt FROM pragma_table_info(?)').all(
          'wipe_runs',
        ) as readonly { cid: number; name: string; dflt: string | null }[]
      ).find((item) => item.name === 'wipe_at');

      if (coluna === undefined) {
        throw new Error('wipe_at não existe');
      }

      return { cid: coluna.cid, dflt: coluna.dflt };
    };

    const posicaoDe = (db: AgentDatabase, nome: string): number => {
      const coluna = (
        db.prepare('SELECT cid, name FROM pragma_table_info(?)').all('wipe_runs') as readonly {
          cid: number;
          name: string;
        }[]
      ).find((item) => item.name === nome);

      if (coluna === undefined) {
        throw new Error(`${nome} não existe`);
      }

      return coluna.cid;
    };

    // No banco velho ela entrou por ALTER, e por isso está depois
    // de `updated_at` — que é a última coluna do CREATE TABLE.
    expect(wipeAt(velho).dflt).toBe('0');
    expect(wipeAt(velho).cid).toBeGreaterThan(posicaoDe(velho, 'updated_at'));

    // No banco novo ela está onde o DDL a declara: no meio.
    expect(wipeAt(novo).dflt).toBeNull();
    expect(wipeAt(novo).cid).toBeLessThan(posicaoDe(novo, 'updated_at'));

    velho.close();
    novo.close();
  });
});

// ------------------------------------------------------------
//  044 — o nome curto da aba e o "mostrar no jogo"
// ------------------------------------------------------------

describe('as duas colunas que a 044 acrescenta', () => {
  const antigo = SEM_NOME_CURTO;

  /** O ranking dinâmico, como o painel o teria criado antes da 044. */
  function criarTrofeu(db: AgentDatabase, label: string): void {
    db.prepare(
      `INSERT INTO rankings
         (id, metric, label, unit, description, source, value_kind, direction, "window",
          global_eligible, builtin, enabled, sort_order, created_at, updated_at)
       VALUES
         ('trofeu-bleik', 'trophy.bleik', @label, 'troféus', NULL,
          'item', 'counter', 'desc', 'season', 1, 0, 1, 100, 1760000000000, 1760000000000)`,
    ).run({ label });
  }

  it('o banco que já tinha a 034 e a 043 ganha `short_label` e `show_in_game`', () => {
    const velho = montar(antigo);

    const colunas = (db: AgentDatabase): readonly { name: string; naoNulo: number }[] =>
      db.prepare('SELECT name, "notnull" AS naoNulo FROM pragma_table_info(?)').all('rankings') as
        readonly { name: string; naoNulo: number }[];

    // Antes: elas não existem, e é por isso que a migração existe.
    expect(colunas(velho).map((coluna) => coluna.name)).not.toContain('short_label');

    runMigrations(velho);

    const depois = colunas(velho);

    expect(depois.find((coluna) => coluna.name === 'short_label')).toBeDefined();
    // `show_in_game` recusa nulo: "não sei se aparece" não é um
    // estado — o padrão é aparecer.
    expect(depois.find((coluna) => coluna.name === 'show_in_game')?.naoNulo).toBe(1);

    // E o padrão é 1: um ranking que já existia continua no menu
    // do jogo, porque nada mudou para ele.
    criarTrofeu(velho, 'Bleik Store');

    const linha = velho
      .prepare(`SELECT show_in_game FROM rankings WHERE id = 'abates'`)
      .get() as { show_in_game: number };

    expect(linha.show_in_game).toBe(1);

    velho.close();
  });

  it('o troféu ganha o nome inteiro no site e o curto na aba do jogo', () => {
    const velho = montar(antigo);

    criarTrofeu(velho, 'Bleik Store');
    runMigrations(velho);

    const linha = velho
      .prepare(`SELECT label, short_label FROM rankings WHERE id = 'trofeu-bleik'`)
      .get() as { label: string; short_label: string | null };

    expect(linha.label).toBe('Troféu Bleik Store');
    expect(linha.short_label).toBe('Bleik Store');

    // E os dois semeados que não cabiam na aba.
    const curto = (metric: string): string | null =>
      (
        velho.prepare('SELECT short_label FROM rankings WHERE metric = ?').get(metric) as {
          short_label: string | null;
        }
      ).short_label;

    expect(curto('shot.distance')).toBe('Tiro longo');
    expect(curto('explosive.seq')).toBe('Raid');
    // Quem já cabia não ganha nome curto: `NULL` quer dizer "use o
    // `label`", e inventar um segundo nome igual ao primeiro só
    // daria dois lugares para editar a mesma coisa.
    expect(curto('pvp.kills')).toBeNull();

    velho.close();
  });

  it('o nome que o admin já tinha trocado NÃO é reescrito', () => {
    // ####  UMA CORREÇÃO DE DADO NÃO DESFAZ UMA EDIÇÃO  ####
    //
    // O `WHERE` da 044 compara com o valor antigo. Se o dono já
    // renomeou o ranking pela tela, a condição não casa — e é
    // isso que separa "corrigir o que foi semeado errado" de
    // "passar por cima da escolha de quem usa".
    const velho = montar(antigo);

    criarTrofeu(velho, 'Loja do Bleik');
    runMigrations(velho);

    const linha = velho
      .prepare(`SELECT label, short_label FROM rankings WHERE id = 'trofeu-bleik'`)
      .get() as { label: string; short_label: string | null };

    expect(linha.label).toBe('Loja do Bleik');
    expect(linha.short_label).toBeNull();

    velho.close();
  });
});
