// ============================================================
//  servers-repository.ts  -  o cadastro dos servidores desta
//  máquina.
//
//  Uma linha por servidor de Rust que este agente cuida: quem ele
//  é, em que portas atende e onde está instalado. É a tabela para
//  onde aponta o `server_id` de todo o resto — histórico de
//  entregas, wipes, avisos, propagandas, compras.
//
//  ------------------------------------------------------------
//  ####  A SENHA NÃO SAI NA LEITURA NORMAL  ####
//
//  `ServerRecord` não tem `rconPassword`. Quem precisa dela chama
//  `rconPasswordOf` de propósito — que é uma linha a mais de
//  código para quem vai abrir o RCON, e uma barreira para quem
//  está montando uma resposta HTTP e ia serializar o objeto
//  inteiro sem olhar.
//
//  É o mesmo desenho do `secret` dos webhooks e do token das
//  chaves de API: o segredo existe, mas não viaja de carona.
//
//  ------------------------------------------------------------
//  ####  NÃO EXISTE "SERVIDOR ATUAL" AQUI  ####
//
//  Este repositório não guarda estado nem escolhe um padrão. Quem
//  chama diz de qual servidor está falando, sempre — é o que
//  impede o agente de voltar a ter um servidor implícito, que é
//  justamente o que a tabela `servers` existe para eliminar.
// ============================================================

import type { AgentDatabase } from './database.js';

/** Um servidor cadastrado, SEM a senha do RCON. */
export interface ServerRecord {
  /** Slug curto e estável. Vai em toda linha das outras tabelas. */
  readonly id: string;
  readonly name: string;
  /** O `server.identity` do Rust. Nomeia a pasta do save. */
  readonly identity: string;
  /** Desligado, o servidor continua cadastrado e o agente o ignora. */
  readonly enabled: boolean;
  readonly gamePort: number;
  readonly rconPort: number;
  readonly queryPort: number;
  /** A porta do app/painel deste servidor. */
  readonly appPort: number;
  readonly rconHost: string;
  /** Onde o RustDedicated.exe deste servidor mora. */
  readonly installDir: string;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** O que é preciso para cadastrar um servidor. */
export interface ServerInput {
  readonly id: string;
  readonly name: string;
  readonly identity: string;
  readonly gamePort: number;
  readonly rconPort: number;
  readonly queryPort: number;
  readonly appPort: number;
  readonly installDir: string;
  readonly enabled?: boolean | undefined;
  readonly rconHost?: string | undefined;
  /** Ausente = vazio, e a senha continua vindo do ambiente. */
  readonly rconPassword?: string | undefined;
}

/**
 * O que dá para mudar depois.
 *
 * `id` fica de fora: ele é a chave estrangeira de dezenas de
 * milhares de linhas, e trocá-lo seria reescrever o histórico
 * inteiro para renomear uma pasta.
 */
export interface ServerPatch {
  readonly name?: string | undefined;
  readonly identity?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly gamePort?: number | undefined;
  readonly rconPort?: number | undefined;
  readonly queryPort?: number | undefined;
  readonly appPort?: number | undefined;
  readonly rconHost?: string | undefined;
  readonly rconPassword?: string | undefined;
  readonly installDir?: string | undefined;
}

interface ServerRow {
  readonly id: string;
  readonly name: string;
  readonly identity: string;
  readonly enabled: number;
  readonly game_port: number;
  readonly rcon_port: number;
  readonly query_port: number;
  readonly app_port: number;
  readonly rcon_host: string;
  readonly install_dir: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Sem `rcon_password`: ver o cabeçalho. */
const SELECT_COLUMNS = `
  id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
  rcon_host, install_dir, created_at, updated_at
`;

export class ServersRepository {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  /**
   * Todos, na ordem do nome.
   *
   * Sem paginação: são os servidores de UMA máquina, e essa lista
   * cabe numa tela mesmo no dia em que crescer bastante.
   */
  list(): readonly ServerRecord[] {
    const rows = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM servers ORDER BY name COLLATE NOCASE, id`)
      .all() as ServerRow[];

    return rows.map(toRecord);
  }

  /** Só os que o agente deve cuidar. */
  listEnabled(): readonly ServerRecord[] {
    return this.list().filter((server) => server.enabled);
  }

  get(id: string): ServerRecord | null {
    const row = this.#db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM servers WHERE id = @id`)
      .get({ id }) as ServerRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * A senha do RCON, à parte do resto.
   *
   * Vazia quer dizer "não está gravada aqui" — que é o estado em
   * que a migração 025 deixa o servidor que já existia, porque a
   * senha dele vive no `.env`. Ver o cabeçalho.
   *
   * `null` = não existe servidor com este id.
   */
  rconPasswordOf(id: string): string | null {
    const row = this.#db
      .prepare('SELECT rcon_password FROM servers WHERE id = @id')
      .get({ id }) as { readonly rcon_password: string } | undefined;

    return row === undefined ? null : row.rcon_password;
  }

  /**
   * Cadastra um servidor.
   *
   * Porta repetida ou identidade repetida batem no UNIQUE do banco
   * e viram exceção — de propósito. Duas portas iguais não são um
   * detalhe a corrigir depois: são um segundo processo que sobe e
   * morre sem conseguir o socket, ou um RCON respondendo pelo
   * servidor errado.
   */
  create(input: ServerInput, now: number = Date.now()): ServerRecord {
    this.#db
      .prepare(
        `INSERT INTO servers
           (id, name, identity, enabled, game_port, rcon_port, query_port, app_port,
            rcon_host, rcon_password, install_dir, created_at, updated_at)
         VALUES
           (@id, @name, @identity, @enabled, @game_port, @rcon_port, @query_port, @app_port,
            @rcon_host, @rcon_password, @install_dir, @now, @now)`,
      )
      .run({
        id: input.id,
        name: input.name,
        identity: input.identity,
        enabled: input.enabled === false ? 0 : 1,
        game_port: input.gamePort,
        rcon_port: input.rconPort,
        query_port: input.queryPort,
        app_port: input.appPort,
        rcon_host: input.rconHost ?? '127.0.0.1',
        rcon_password: input.rconPassword ?? '',
        install_dir: input.installDir,
        now,
      });

    const created = this.get(input.id);

    if (created === null) {
      throw new Error(`o servidor ${input.id} sumiu logo depois de ser criado`);
    }

    return created;
  }

  /**
   * Muda o que veio. Campo ausente NÃO é apagado.
   *
   * `null` quando o id não existe — quem chama traduz em 404, em
   * vez de criar um servidor que ninguém pediu.
   */
  update(id: string, patch: ServerPatch, now: number = Date.now()): ServerRecord | null {
    const current = this.get(id);

    if (current === null) {
      return null;
    }

    this.#db
      .prepare(
        `UPDATE servers
            SET name          = @name,
                identity      = @identity,
                enabled       = @enabled,
                game_port     = @game_port,
                rcon_port     = @rcon_port,
                query_port    = @query_port,
                app_port      = @app_port,
                rcon_host     = @rcon_host,
                -- A senha só é tocada quando veio no patch: um
                -- PATCH de nome não pode apagar a credencial do
                -- RCON por omissão.
                rcon_password = COALESCE(@rcon_password, rcon_password),
                install_dir   = @install_dir,
                updated_at    = @now
          WHERE id = @id`,
      )
      .run({
        id,
        name: patch.name ?? current.name,
        identity: patch.identity ?? current.identity,
        enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
        game_port: patch.gamePort ?? current.gamePort,
        rcon_port: patch.rconPort ?? current.rconPort,
        query_port: patch.queryPort ?? current.queryPort,
        app_port: patch.appPort ?? current.appPort,
        rcon_host: patch.rconHost ?? current.rconHost,
        rcon_password: patch.rconPassword ?? null,
        install_dir: patch.installDir ?? current.installDir,
        now,
      });

    return this.get(id);
  }
}

function toRecord(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    identity: row.identity,
    enabled: row.enabled === 1,
    gamePort: row.game_port,
    rconPort: row.rcon_port,
    queryPort: row.query_port,
    appPort: row.app_port,
    rconHost: row.rcon_host,
    installDir: row.install_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
