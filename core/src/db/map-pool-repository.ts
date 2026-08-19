// ============================================================
//  map-pool-repository.ts  -  a FILA DE MAPAS (migração 024).
//
//  Qual mundo entra no próximo wipe, e no seguinte, e no
//  seguinte. O admin acha uma seed no rustmaps.com, cola aqui, e
//  ela espera a vez.
//
//  As regras que dão para decidir só olhando os valores (seed
//  válida, tamanho de mundo, URL de `.map`, sorteio) moram em
//  wipe/map-pool.ts. Aqui é o banco, e só ele.
//
//  ------------------------------------------------------------
//  ####  A FILA É DE UM SERVIDOR  ####
//
//  Cada servidor joga o seu próprio mundo, e a mesma seed pode
//  estar na fila de dois — são dois mundos, para gente diferente.
//  Por isso `serverId` abre TODA assinatura daqui, e o índice
//  único é `(server_id, seed, world_size)`.
//
//  ------------------------------------------------------------
//  ####  FILA VAZIA NUNCA BLOQUEIA WIPE  ####
//
//  `takeForWipe` sorteia quando não há entrada pronta, REGISTRA o
//  que sorteou e diz que sorteou. Um wipe que não acontece porque
//  ninguém curou a fila é o pior desfecho possível: o servidor
//  fica no ar com o mundo velho e todo mundo achando que zerou.
//
//  ------------------------------------------------------------
//  ####  O QUE ESTE ARQUIVO NÃO FAZ  ####
//
//  Não sai na rede. O `HEAD` na URL do mapa custom acontece na
//  borda HTTP (routes/wipe-maps.ts), que chama o checker de
//  wipe/map-pool.ts e só então grava. Um repositório que faz IO
//  de rede é um repositório que não dá para testar sem servidor.
// ============================================================

import {
  CUSTOM_IN_FORCED_REASON,
  DEFAULT_WORLD_SIZE,
  MAX_SEED,
  MAX_WORLD_SIZE,
  MIN_WORLD_SIZE,
  RECENT_WIPES_WINDOW,
  blockedInForced,
  drawSeed,
  isValidWorldSize,
  normalizeSeed,
} from '../wipe/map-pool.js';
import type { MapKind, MapPoolEntry, MapPoolStatus } from '../types/wipe.js';
import type { AgentDatabase } from './database.js';

/**
 * A entrada da fila com o que só o painel usa.
 *
 * ESTENDE o `MapPoolEntry` do contrato (types/wipe.ts), e não o
 * substitui: quem compila contra o contrato — a execução do wipe,
 * o RustMaps, a tela do jogo — continua enxergando exatamente os
 * campos publicados. Os dois daqui são de operação, e não de
 * contrato.
 *
 * `versionOk` MUDOU DE LADO e hoje está no contrato: quem decide
 * qual mundo entra no próximo wipe precisa dela para não prometer
 * um `.map` da versão de ontem a um wipe forçado. Ver
 * `usableForWipe`, em wipe/map-pool.ts.
 */
export interface MapPoolRecord extends MapPoolEntry {
  /** O recado de quem colou a seed. */
  readonly note: string | null;
  readonly updatedAt: number;
}

export interface MapPoolInput {
  readonly kind?: MapKind | undefined;
  /**
   * `null` (ou ausente) = **sorteia**.
   *
   * O sorteio evita o que já está na fila e o que os últimos
   * wipes usaram — ver `#takenSeeds`.
   */
  readonly seed?: string | null | undefined;
  /** Ignorado em `custom`: o `.map` traz o tamanho dentro dele. */
  readonly worldSize?: number | undefined;
  readonly level?: string | undefined;
  /** Obrigatório em `custom`, e já validado por quem chamou. */
  readonly levelUrl?: string | null | undefined;
  readonly versionOk?: boolean | undefined;
  readonly note?: string | null | undefined;
}

/**
 * O que veio junto do que foi criado, e que NÃO é erro.
 *
 * Hoje só um caso: a seed já apareceu num wipe recente. Isso não
 * impede nada — reprisar um mapa querido é escolha legítima — mas
 * quase sempre é engano, e um 201 mudo faria o admin descobrir a
 * repetição no dia do wipe.
 */
export interface MapPoolWarning {
  readonly code: 'SEED_ALREADY_PLAYED';
  readonly message: string;
}

export interface MapPoolCreated {
  readonly entry: MapPoolRecord;
  readonly warnings: readonly MapPoolWarning[];
  /** A seed não veio de ninguém: o agente sorteou. */
  readonly drawn: boolean;
}

/**
 * A entrada que o wipe VAI consumir, e as que ele pula no caminho
 * — antes de consumir coisa nenhuma.
 *
 * `entry: null` = a fila não tem nada utilizável, e quem sorteia é
 * o `takeForWipe`.
 */
export interface MapPoolPick {
  readonly entry: MapPoolRecord | null;
  /**
   * As entradas que estavam na frente e foram puladas, com o
   * motivo. Vazio no caso comum.
   */
  readonly skipped: readonly { readonly id: number; readonly reason: string }[];
}

/**
 * O mundo que o SORTEIO escolheu, antes de existir linha dele.
 *
 * Ele é o par do `MapPoolPick` para a fila vazia: a seed já está
 * decidida e nada foi gravado ainda. Ver `drawForWipe`.
 */
export interface DrawnWorld {
  readonly seed: string;
  readonly worldSize: number;
  readonly level: string;
}

/** O que a execução do wipe recebe quando pede o próximo mundo. */
export interface MapPoolTaken {
  readonly entry: MapPoolRecord;
  /**
   * A fila não tinha entrada utilizável e o agente SORTEOU.
   *
   * Quem consome precisa saber para poder registrar: "o mapa
   * deste wipe não foi escolhido por ninguém" é informação, e não
   * detalhe.
   */
  readonly drawn: boolean;
  readonly skipped: MapPoolPick['skipped'];
}

/** Erro de regra da fila, com código e status já escolhidos. */
export class MapPoolError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'MapPoolError';
    this.code = code;
    this.status = status;
  }
}

export function isMapPoolError(error: unknown): error is MapPoolError {
  return error instanceof MapPoolError;
}

interface MapPoolRow {
  readonly id: number;
  readonly server_id: string;
  readonly position: number;
  readonly kind: string;
  readonly seed: string | null;
  readonly world_size: number | null;
  readonly level: string | null;
  readonly level_url: string | null;
  readonly rustmaps_id: string | null;
  readonly staging: number;
  readonly preview_url: string | null;
  readonly thumb_url: string | null;
  readonly monuments: string | null;
  readonly status: string;
  readonly last_error: string | null;
  readonly version_ok: number;
  readonly note: string | null;
  readonly used_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export class MapPoolRepository {
  readonly #db: AgentDatabase;
  readonly #random: () => number;

  /**
   * `random` é injetável para o teste poder fixar o sorteio. Em
   * produção é o `Math.random` de sempre: seed de mapa não é
   * segredo nem precisa de aleatoriedade criptográfica — ela vai
   * aparecer na tela do jogador de qualquer jeito.
   */
  constructor(db: AgentDatabase, random: () => number = Math.random) {
    this.#db = db;
    this.#random = random;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * A fila inteira, em ordem, INCLUINDO as já usadas.
   *
   * As usadas são o histórico de "que mapa foi cada wipe", e a
   * tela as mostra apagadas no fim. Filtrá-las aqui obrigaria a
   * tela a fazer uma segunda chamada para a mesma tabela.
   */
  list(serverId: string): readonly MapPoolRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id
          ORDER BY (status = 'used') ASC, position ASC, id ASC`,
      )
      .all({ server_id: serverId }) as MapPoolRow[];

    return rows.map(toRecord);
  }

  get(serverId: string, id: number): MapPoolRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM map_pool WHERE server_id = @server_id AND id = @id')
      .get({ server_id: serverId, id }) as MapPoolRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * A entrada que tem ESTE `.map`. `null` = nenhuma.
   *
   * ####  ELA RESPONDE PELO MUNDO QUE JÁ ESTÁ NO AR  ####
   *
   * O `.ini` guarda o endereço do arquivo, e mais nada: a marca de
   * "compatível com a versão nova" mora AQUI, na linha que virou
   * aquele mundo. É ela que decide se um wipe FORÇADO pode MANTER
   * o mapa custom de agora — ver `keepBlockedInForced`, em
   * wipe/map-pool.ts.
   *
   * Com mais de uma linha para o mesmo arquivo (a fila guarda as
   * usadas), ganha a MARCADA: a marca é do `.map`, e não da linha,
   * e quem a pôs numa delas garantiu aquele arquivo.
   */
  byLevelUrl(serverId: string, levelUrl: string): MapPoolRecord | null {
    const url = levelUrl.trim();

    if (url === '') {
      return null;
    }

    const row = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id AND level_url = @url
          ORDER BY version_ok DESC, id DESC
          LIMIT 1`,
      )
      .get({ server_id: serverId, url }) as MapPoolRow | undefined;

    return row === undefined ? null : toRecord(row);
  }

  /**
   * A primeira entrada PRONTA da fila. `null` = fila vazia.
   *
   * `used` e `failed` ficam de fora; `draft` e `generating`
   * também, porque um mapa que ainda não está pronto não pode ser
   * prometido ao jogador como "o mapa do próximo wipe".
   *
   * Com `forced`, entradas `custom` sem a marca de versão são
   * puladas — ver `takeForWipe`.
   */
  next(serverId: string, forced = false): MapPoolRecord | null {
    const ready = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id AND status = 'ready'
          ORDER BY position ASC, id ASC`,
      )
      .all({ server_id: serverId }) as MapPoolRow[];

    for (const row of ready) {
      const entry = toRecord(row);

      if (!blockedInForced(entry, forced)) {
        return entry;
      }
    }

    return null;
  }

  /** As seeds dos últimos wipes deste servidor. Ver `#takenSeeds`. */
  recentSeeds(serverId: string, limit: number = RECENT_WIPES_WINDOW): readonly string[] {
    const seeds: string[] = [];

    const used = this.#db
      .prepare(
        `SELECT seed FROM map_pool
          WHERE server_id = @server_id AND seed IS NOT NULL AND status = 'used'
          ORDER BY used_at DESC, id DESC
          LIMIT @limit`,
      )
      .all({ server_id: serverId, limit }) as { readonly seed: string }[];

    for (const row of used) {
      seeds.push(row.seed);
    }

    // ####  A TABELA `wipes` PODE AINDA NÃO EXISTIR  ####
    //
    // Ela é da migração 025, de outra frente desta mesma onda, e
    // guarda os mundos DETECTADOS — inclusive os que o agente não
    // escolheu (uma seed trocada à mão no `.ini`, um servidor
    // adotado com mundo antigo). Quando ela chegar, entra na
    // conta sozinha; enquanto não chega, a fila já usada responde
    // a mesma pergunta.
    //
    // A conferência é da tabela E das colunas, e não só do nome:
    // perguntar ao catálogo do SQLite é leitura de memória, e é o
    // que impede este arquivo de estourar em produção por causa da
    // ordem em que as frentes forem mergeadas. Um `catch` mudo
    // aqui esconderia exatamente esse tipo de desencontro.
    if (this.#canReadWipes()) {
      const detected = this.#db
        .prepare(
          `SELECT seed FROM wipes
            WHERE server_id = @server_id AND seed IS NOT NULL
            ORDER BY detected_at DESC, id DESC
            LIMIT @limit`,
        )
        .all({ server_id: serverId, limit }) as { readonly seed: string | number }[];

      for (const row of detected) {
        seeds.push(String(row.seed));
      }
    }

    return seeds;
  }

  // ------------------------------------------------------
  //  Escrita
  // ------------------------------------------------------

  /**
   * Põe um mundo no fim da fila.
   *
   * Sem `seed`, sorteia — e o `drawn` da resposta diz isso, para
   * a tela não anunciar como escolha do admin um número que o
   * agente tirou sozinho.
   *
   * @throws {MapPoolError} seed inválida, tamanho fora da faixa,
   * a mesma seed já esperando, ou `custom` sem URL.
   */
  add(serverId: string, input: MapPoolInput, now: number = Date.now()): MapPoolCreated {
    const kind: MapKind = input.kind ?? 'procedural';

    if (kind === 'custom') {
      return this.#addCustom(serverId, input, now);
    }

    const worldSize = input.worldSize ?? DEFAULT_WORLD_SIZE;

    if (!isValidWorldSize(worldSize)) {
      throw new MapPoolError(
        'INVALID_WORLD_SIZE',
        `O tamanho do mundo precisa ser um inteiro entre ${String(MIN_WORLD_SIZE)} e ` +
          `${String(MAX_WORLD_SIZE)}. Mundo menor gera e sobe muito mais rápido; mundo maior ` +
          'espalha os jogadores.',
        400,
      );
    }

    const level = (input.level ?? 'Procedural Map').trim() || 'Procedural Map';
    const asked = input.seed ?? null;
    const drawn = asked === null;

    const seed = drawn ? this.#drawFreeSeed(serverId, worldSize) : normalizeSeed(asked);

    if (seed === null) {
      throw new MapPoolError(
        'INVALID_SEED',
        `A seed precisa ser um número inteiro entre 0 e ${String(MAX_SEED)}. É o que o ` +
          'rustmaps.com mostra no endereço do mapa, e é o que o jogo aceita em server.seed.',
        400,
      );
    }

    const entry = this.#insert(serverId, {
      kind: 'procedural',
      seed,
      world_size: worldSize,
      level,
      level_url: null,
      version_ok: 0,
      note: input.note ?? null,
      now,
    });

    return { entry, warnings: this.#warningsFor(serverId, entry), drawn };
  }

  /**
   * Tira da fila. Entrada já usada não sai.
   *
   * ####  ELA DEIXOU DE SER FILA E VIROU HISTÓRICO  ####
   *
   * É a linha que responde "que mapa foi o wipe passado". Apagá-la
   * para "limpar a tela" perderia isso em silêncio, e é a única
   * memória de qual mundo cada wipe gerou.
   *
   * @throws {MapPoolError} 404 se não existe, 409 se já foi usada.
   */
  remove(serverId: string, id: number): MapPoolRecord {
    const current = this.get(serverId, id);

    if (current === null) {
      throw new MapPoolError('MAP_NOT_FOUND', `O mapa ${String(id)} não está na fila.`, 404);
    }

    if (current.status === 'used') {
      throw new MapPoolError(
        'MAP_ALREADY_USED',
        'Este mapa já foi usado num wipe e faz parte do histórico — é ele que responde qual ' +
          'mundo cada wipe gerou.',
        409,
      );
    }

    this.#db
      .prepare('DELETE FROM map_pool WHERE server_id = @server_id AND id = @id')
      .run({ server_id: serverId, id });

    return current;
  }

  /**
   * Reescreve a ordem da fila.
   *
   * ####  RECEBE A FILA INTEIRA, E NÃO "MOVA PARA CIMA"  ####
   *
   * Com movimento relativo, duas telas abertas ao mesmo tempo
   * produzem uma ordem que nenhuma das duas pediu: a segunda
   * aplica "sobe o #3" sobre uma lista que já não é a que ela viu.
   * Com a lista inteira, o último a salvar vence — e o que ele vê
   * na tela é exatamente o que fica gravado.
   *
   * As já usadas não participam: elas são histórico.
   *
   * @throws {MapPoolError} id de fora da fila, lista incompleta ou
   * com repetição.
   */
  reorder(
    serverId: string,
    ids: readonly number[],
    now: number = Date.now(),
  ): readonly MapPoolRecord[] {
    const run = this.#db.transaction((): void => {
      const queued = this.list(serverId).filter((entry) => entry.status !== 'used');
      const known = new Set(queued.map((entry) => entry.id));

      for (const id of ids) {
        if (!known.has(id)) {
          throw new MapPoolError(
            'MAP_NOT_FOUND',
            `O mapa ${String(id)} não está na fila deste servidor.`,
            404,
          );
        }
      }

      if (new Set(ids).size !== ids.length) {
        throw new MapPoolError(
          'DUPLICATED_ID',
          'A ordem tem o mesmo mapa duas vezes. Ela precisa ser a fila inteira, cada mapa uma ' +
            'vez só.',
          400,
        );
      }

      if (ids.length !== known.size) {
        throw new MapPoolError(
          'INCOMPLETE_ORDER',
          `A ordem precisa trazer todos os ${String(known.size)} mapas da fila, e veio com ` +
            `${String(ids.length)}. Mandar a fila inteira é o que impede duas telas abertas de ` +
            'produzirem uma ordem que ninguém pediu.',
          400,
        );
      }

      const update = this.#db.prepare(
        `UPDATE map_pool SET position = @position, updated_at = @now
          WHERE server_id = @server_id AND id = @id`,
      );

      ids.forEach((id, index) => {
        update.run({ server_id: serverId, id, position: index, now });
      });
    });

    run();

    return this.list(serverId);
  }

  /** Liga ou desliga a marca "compatível com a versão nova". */
  markVersionOk(
    serverId: string,
    id: number,
    versionOk: boolean,
    now: number = Date.now(),
  ): MapPoolRecord {
    const current = this.get(serverId, id);

    if (current === null) {
      throw new MapPoolError('MAP_NOT_FOUND', `O mapa ${String(id)} não está na fila.`, 404);
    }

    if (current.kind !== 'custom') {
      throw new MapPoolError(
        'MAP_NOT_CUSTOM',
        'A marca de compatibilidade só existe em mapa custom. Um mundo procedural é gerado pelo ' +
          'próprio servidor no boot, sempre na versão certa do jogo.',
        409,
      );
    }

    this.#db
      .prepare(
        `UPDATE map_pool SET version_ok = @version_ok, updated_at = @now
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({ server_id: serverId, id, version_ok: versionOk ? 1 : 0, now });

    return this.#reread(serverId, id);
  }

  /** Marca a entrada como consumida por um wipe. */
  markUsed(serverId: string, id: number, now: number = Date.now()): MapPoolRecord {
    const current = this.get(serverId, id);

    if (current === null) {
      throw new MapPoolError('MAP_NOT_FOUND', `O mapa ${String(id)} não está na fila.`, 404);
    }

    this.#db
      .prepare(
        `UPDATE map_pool SET status = 'used', used_at = @now, updated_at = @now
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({ server_id: serverId, id, now });

    return this.#reread(serverId, id);
  }

  /**
   * O mundo do wipe que está começando AGORA — e ele nunca falha
   * por falta de curadoria.
   *
   * Consome a primeira entrada pronta e a marca `used`. Se não
   * houver nenhuma utilizável, SORTEIA uma seed, grava a linha já
   * como usada e devolve `drawn: true`. Registrar o sorteio é o
   * que permite responder, semanas depois, "de onde veio o mapa
   * daquele wipe" — e é o que alimenta o aviso de seed repetida.
   *
   * Num wipe FORÇADO, entradas `custom` sem a marca de versão são
   * puladas (e continuam na fila, com o motivo em `skipped`): o
   * forçado troca o binário do jogo, e um `.map` da versão de
   * ontem pode não carregar na de hoje.
   */
  takeForWipe(
    serverId: string,
    options: {
      readonly forced?: boolean;
      readonly worldSize?: number;
      readonly level?: string;
    } = {},
    now: number = Date.now(),
  ): MapPoolTaken {
    const picked = this.pickForWipe(serverId, options);

    if (picked.entry !== null) {
      return {
        entry: this.markUsed(serverId, picked.entry.id, now),
        drawn: false,
        skipped: picked.skipped,
      };
    }

    const drawn = this.drawForWipe(serverId, options);

    return {
      entry: this.recordDrawn(serverId, drawn, now),
      drawn: true,
      skipped: picked.skipped,
    };
  }

  /**
   * A seed que o sorteio usaria — SEM gravar linha nenhuma.
   *
   * ####  ESCOLHER NÃO É QUEIMAR, TAMBÉM NO SORTEIO  ####
   *
   * `pickForWipe` já separava os dois tempos para a fila curada, e
   * o sorteio não: ele inseria a linha e a marcava `used` ANTES do
   * `.ini`. Um `updateSettings` que lança deixava para trás um
   * mundo `used` que nunca subiu, e a retomada sorteava outro —
   * medido, com o `.ini` lançando duas vezes: TRÊS linhas `used`
   * para um wipe só. Não é só sujeira: `recentSeeds` olha os seis
   * últimos wipes e alimenta o aviso de seed repetida, e três
   * fantasmas empurram metade da memória real para fora dessa
   * janela.
   *
   * Quem grava a linha é `recordDrawn`, depois de o mundo estar no
   * `.ini`.
   */
  drawForWipe(
    serverId: string,
    options: { readonly worldSize?: number; readonly level?: string } = {},
  ): DrawnWorld {
    const worldSize = options.worldSize ?? DEFAULT_WORLD_SIZE;
    const size = isValidWorldSize(worldSize) ? worldSize : DEFAULT_WORLD_SIZE;
    const level = (options.level ?? 'Procedural Map').trim() || 'Procedural Map';

    return { seed: this.#drawFreeSeed(serverId, size), worldSize: size, level };
  }

  /**
   * A linha do mundo SORTEADO, já nascida consumida.
   *
   * Ela nasce `used` porque o mundo dela é o de AGORA: nunca
   * esteve na fila esperando a vez, e deixá-la `ready` faria o
   * wipe seguinte prometer o mundo que já está no ar. Registrar o
   * sorteio é o que permite responder, semanas depois, de onde
   * veio o mapa daquele wipe.
   */
  recordDrawn(serverId: string, world: DrawnWorld, now: number = Date.now()): MapPoolRecord {
    const created = this.#insert(serverId, {
      kind: 'procedural',
      seed: world.seed,
      world_size: world.worldSize,
      level: world.level,
      level_url: null,
      version_ok: 0,
      note: 'sorteada pelo agente: a fila estava vazia na hora do wipe',
      now,
    });

    return this.markUsed(serverId, created.id, now);
  }

  /**
   * QUAL entrada este wipe consumiria — sem consumir nada.
   *
   * ####  ESCOLHER E QUEIMAR SÃO DOIS TEMPOS  ####
   *
   * Quem executa o wipe precisa do mundo ANTES de gravar o `.ini`,
   * e só pode marcar a entrada como jogada DEPOIS de o `.ini` ter
   * sido gravado — senão um erro no arquivo deixa uma entrada
   * `used` por um wipe que não trocou mundo nenhum, e a retomada
   * queima a seguinte. Ver `#configurar`, em wipe/run.ts.
   *
   * A regra de quem serve é a MESMA do `takeForWipe`, porque é
   * este método que ele chama.
   */
  pickForWipe(serverId: string, options: { readonly forced?: boolean } = {}): MapPoolPick {
    const forced = options.forced ?? false;
    const skipped: { id: number; reason: string }[] = [];

    const ready = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id AND status = 'ready'
          ORDER BY position ASC, id ASC`,
      )
      .all({ server_id: serverId }) as MapPoolRow[];

    for (const row of ready) {
      const entry = toRecord(row);

      if (blockedInForced(entry, forced)) {
        skipped.push({ id: entry.id, reason: CUSTOM_IN_FORCED_REASON });
        continue;
      }

      return { entry, skipped };
    }

    return { entry: null, skipped };
  }

  // ------------------------------------------------------
  //  Interno
  // ------------------------------------------------------

  #addCustom(serverId: string, input: MapPoolInput, now: number): MapPoolCreated {
    const levelUrl = (input.levelUrl ?? '').trim();

    if (levelUrl === '') {
      throw new MapPoolError(
        'MAP_URL_REQUIRED',
        'Um mapa custom precisa do link do arquivo .map — é o que vai para server.levelurl, e é ' +
          'de lá que o servidor baixa o mundo no boot.',
        400,
      );
    }

    const clash = this.#db
      .prepare(
        `SELECT id FROM map_pool
          WHERE server_id = @server_id AND level_url = @url AND status <> 'used'`,
      )
      .get({ server_id: serverId, url: levelUrl }) as { readonly id: number } | undefined;

    if (clash !== undefined) {
      throw new MapPoolError(
        'MAP_ALREADY_QUEUED',
        'Este mesmo arquivo .map já está esperando na fila.',
        409,
      );
    }

    const entry = this.#insert(serverId, {
      kind: 'custom',
      seed: null,
      world_size: null,
      level: (input.level ?? '').trim() || null,
      level_url: levelUrl,
      version_ok: input.versionOk === true ? 1 : 0,
      note: input.note ?? null,
      now,
    });

    return { entry, warnings: [], drawn: false };
  }

  /** O INSERT, com a posição no fim da fila. */
  #insert(
    serverId: string,
    values: {
      readonly kind: MapKind;
      readonly seed: string | null;
      readonly world_size: number | null;
      readonly level: string | null;
      readonly level_url: string | null;
      readonly version_ok: number;
      readonly note: string | null;
      readonly now: number;
    },
  ): MapPoolRecord {
    const run = this.#db.transaction((): number => {
      if (values.seed !== null) {
        const clash = this.#db
          .prepare(
            `SELECT id FROM map_pool
              WHERE server_id = @server_id AND seed = @seed AND world_size = @size
                AND status <> 'used'`,
          )
          .get({ server_id: serverId, seed: values.seed, size: values.world_size }) as
          | { readonly id: number }
          | undefined;

        if (clash !== undefined) {
          throw new MapPoolError(
            'MAP_ALREADY_QUEUED',
            `A seed ${values.seed} em ${String(values.world_size ?? 0)} já está esperando na ` +
              'fila. Mesma seed e mesmo tamanho geram exatamente o mesmo mundo — depois de ' +
              'jogada ela pode voltar, mas duas vezes na fila é sempre engano.',
            409,
          );
        }
      }

      // `MAX(position) + 1`, e não `COUNT`: apagar uma entrada do
      // meio deixa buraco, e contar linhas daria uma posição que
      // já existe.
      const last = this.#db
        .prepare('SELECT MAX(position) AS top FROM map_pool WHERE server_id = @server_id')
        .get({ server_id: serverId }) as { readonly top: number | null } | undefined;

      const result = this.#db
        .prepare(
          `INSERT INTO map_pool
             (server_id, position, kind, seed, world_size, level, level_url, status,
              version_ok, note, created_at, updated_at)
           VALUES
             (@server_id, @position, @kind, @seed, @world_size, @level, @level_url, 'ready',
              @version_ok, @note, @now, @now)`,
        )
        .run({
          server_id: serverId,
          position: (last?.top ?? -1) + 1,
          kind: values.kind,
          seed: values.seed,
          world_size: values.world_size,
          level: values.level,
          level_url: values.level_url,
          version_ok: values.version_ok,
          note: values.note,
          now: values.now,
        });

      return Number(result.lastInsertRowid);
    });

    return this.#reread(serverId, run());
  }

  #reread(serverId: string, id: number): MapPoolRecord {
    const saved = this.get(serverId, id);

    if (saved === null) {
      throw new Error(`a entrada ${String(id)} da fila de mapas sumiu logo depois de ser gravada`);
    }

    return saved;
  }

  /**
   * Sorteia uma seed que ninguém está esperando jogar.
   *
   * @throws {MapPoolError} quando o sorteio esgotou as tentativas.
   * Devolver a última colidiria com o índice único e viraria um
   * 409 sem explicação; um erro nomeado diz o que aconteceu.
   */
  #drawFreeSeed(serverId: string, worldSize: number): string {
    const seed = drawSeed(this.#takenSeeds(serverId, worldSize), this.#random);

    if (seed === null) {
      throw new MapPoolError(
        'COULD_NOT_PICK_SEED',
        'Não deu para sortear uma seed que ainda não esteja na fila nem tenha saído nos últimos ' +
          'wipes. Informe uma à mão.',
        500,
      );
    }

    return seed;
  }

  /** O que está prometido na fila MAIS o que os últimos wipes usaram. */
  #takenSeeds(serverId: string, worldSize: number): ReadonlySet<string> {
    const taken = new Set<string>();

    const queued = this.#db
      .prepare(
        `SELECT seed FROM map_pool
          WHERE server_id = @server_id AND seed IS NOT NULL AND world_size = @size
            AND status <> 'used'`,
      )
      .all({ server_id: serverId, size: worldSize }) as { readonly seed: string }[];

    for (const row of queued) {
      taken.add(row.seed);
    }

    for (const seed of this.recentSeeds(serverId)) {
      taken.add(seed);
    }

    return taken;
  }

  #warningsFor(serverId: string, entry: MapPoolRecord): readonly MapPoolWarning[] {
    if (entry.seed === null || !this.recentSeeds(serverId).includes(entry.seed)) {
      return [];
    }

    return [
      {
        code: 'SEED_ALREADY_PLAYED',
        message:
          `Esta seed já foi jogada num dos últimos ${String(RECENT_WIPES_WINDOW)} wipes. ` +
          'Continua valendo — só confirme que é de propósito, porque quem jogou vai reconhecer ' +
          'o mundo.',
      },
    ];
  }

  /**
   * Dá para ler o histórico de mundos detectados neste banco?
   *
   * Ver o comentário de `recentSeeds`: a tabela é de outra frente,
   * e o que interessa aqui são duas colunas dela.
   */
  #canReadWipes(): boolean {
    const table = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wipes'")
      .get() as { readonly name: string } | undefined;

    if (table === undefined) {
      return false;
    }

    const columns = new Set(
      (this.#db.prepare('PRAGMA table_info(wipes)').all() as { readonly name: string }[]).map(
        (column) => column.name,
      ),
    );

    return columns.has('seed') && columns.has('detected_at') && columns.has('server_id');
  }

  // ======================================================
  //  AS COLUNAS DO RUSTMAPS  (Frente H)
  // ======================================================
  //
  //  A migração 024 criou `rustmaps_id`, `staging`, `preview_url`,
  //  `thumb_url`, `monuments`, `last_error` e o status
  //  `generating` — e as deixou vazias de propósito, dizendo no
  //  cabeçalho quem as preencheria. É este bloco.
  //
  //  Ele fica AQUI, e não num repositório à parte, porque quem
  //  escreve na tabela `map_pool` é este arquivo: dois escritores
  //  na mesma tabela são dois lugares para consertar quando a
  //  regra da fila mudar, e nenhum dos dois enxergaria o outro.
  //
  //  ####  A PRÉVIA É ENFEITE, E O CÓDIGO PRECISA MOSTRAR ISSO  ####
  //
  //  Nada aqui apaga seed, mexe em `position` ou toca em `used_at`.
  //  O pior que um método deste bloco faz é gravar uma frase em
  //  `last_error` — e num mundo procedural a seed continua sendo
  //  o mapa com ou sem imagem. Ver Docs\17 §"Frente H", regra 1.

  /**
   * As entradas que ainda não têm prévia e poderiam ter.
   *
   * Procedurais prontas, sem `rustmaps_id` e sem imagem. É a fila
   * de trabalho do relógio do RustMaps: mapa custom fica de fora
   * porque a imagem dele vem do autor do arquivo, e entrada já
   * usada é história.
   */
  withoutPreview(serverId: string): readonly MapPoolRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id
            AND kind = 'procedural'
            AND status = 'ready'
            AND seed IS NOT NULL
            AND rustmaps_id IS NULL
            AND preview_url IS NULL
          ORDER BY position ASC, id ASC`,
      )
      .all({ server_id: serverId }) as MapPoolRow[];

    return rows.map(toRecord);
  }

  /** As entradas que o RustMaps aceitou e ainda está desenhando. */
  generating(serverId: string): readonly MapPoolRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id AND status = 'generating'
          ORDER BY position ASC, id ASC`,
      )
      .all({ server_id: serverId }) as MapPoolRow[];

    return rows.map(toRecord);
  }

  /**
   * O RustMaps aceitou o pedido e devolveu um id: a entrada passa
   * a `generating`, e o relógio a acompanha.
   *
   * `last_error` é limpo aqui de propósito — o que estava escrito
   * ali era sobre a tentativa anterior, e deixá-lo faria a tela
   * mostrar um erro velho ao lado de um pedido novo.
   */
  markGenerating(
    serverId: string,
    id: number,
    rustmapsId: string,
    staging: boolean,
    now: number = Date.now(),
  ): MapPoolRecord {
    this.#assertExists(serverId, id);

    this.#db
      .prepare(
        `UPDATE map_pool
            SET rustmaps_id = @rustmaps_id, staging = @staging, status = 'generating',
                last_error = NULL, updated_at = @now
          WHERE server_id = @server_id AND id = @id AND status <> 'used'`,
      )
      .run({ server_id: serverId, id, rustmaps_id: rustmapsId, staging: staging ? 1 : 0, now });

    return this.#reread(serverId, id);
  }

  /**
   * A prévia ficou pronta: as URLs entram e a entrada volta a
   * `ready`.
   *
   * `monuments` vem como lista, e `null` significa "não sabemos" —
   * uma lista vazia seria afirmar que o mundo não tem monumento
   * nenhum, e uma resposta sem o campo não autoriza a dizer isso.
   */
  markPreviewReady(
    serverId: string,
    id: number,
    preview: {
      readonly rustmapsId: string;
      readonly staging: boolean;
      readonly previewUrl: string | null;
      readonly thumbUrl: string | null;
      readonly monuments: readonly string[] | null;
    },
    now: number = Date.now(),
  ): MapPoolRecord {
    this.#assertExists(serverId, id);

    this.#db
      .prepare(
        `UPDATE map_pool
            SET rustmaps_id = @rustmaps_id, staging = @staging, preview_url = @preview_url,
                thumb_url = @thumb_url, monuments = @monuments, status = 'ready',
                last_error = NULL, updated_at = @now
          WHERE server_id = @server_id AND id = @id AND status <> 'used'`,
      )
      .run({
        server_id: serverId,
        id,
        rustmaps_id: preview.rustmapsId,
        staging: preview.staging ? 1 : 0,
        preview_url: preview.previewUrl,
        thumb_url: preview.thumbUrl,
        monuments: preview.monuments === null ? null : JSON.stringify(preview.monuments),
        now,
      });

    return this.#reread(serverId, id);
  }

  /**
   * A prévia não vai sair, e a tela precisa dizer por quê.
   *
   * ####  UM ENFEITE NÃO CONDENA UM MUNDO  ####
   *
   * A entrada só cai para `failed` quando o MUNDO depende do
   * RustMaps — isto é, num mapa `custom`, cujo arquivo ou existe
   * ou o servidor não sobe. Num procedural o terreno nasce no
   * boot a partir da seed, então ela volta para `ready` com a
   * frase gravada: marcá-la `failed` faria uma imagem que não
   * carregou tirar da fila a seed que o admin escolheu, que é
   * exatamente o defeito que a regra 1 da frente existe para
   * impedir.
   */
  markPreviewFailed(
    serverId: string,
    id: number,
    reason: string,
    now: number = Date.now(),
  ): MapPoolRecord {
    const current = this.#assertExists(serverId, id);
    const status = current.kind === 'custom' ? 'failed' : 'ready';

    this.#db
      .prepare(
        `UPDATE map_pool
            SET status = @status, last_error = @reason, updated_at = @now
          WHERE server_id = @server_id AND id = @id AND status <> 'used'`,
      )
      .run({ server_id: serverId, id, status, reason, now });

    return this.#reread(serverId, id);
  }

  /**
   * Guarda o recado sem mexer no estado.
   *
   * É o caminho do RustMaps fora do ar: a entrada continua
   * `ready`, o wipe continua usando a seed, e o cartão passa a
   * dizer "sem prévia" com o motivo em vez de um espaço em
   * branco.
   */
  noteError(serverId: string, id: number, reason: string, now: number = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE map_pool SET last_error = @reason, updated_at = @now
          WHERE server_id = @server_id AND id = @id AND status <> 'used'`,
      )
      .run({ server_id: serverId, id, reason, now });
  }

  /**
   * Esta entrada vai ser o mundo de um wipe FORÇADO?
   *
   * ####  É ELA QUE LIGA O STAGING SOZINHO  ####
   *
   * A atualização mensal muda a geração do mundo: um retrato
   * tirado na versão de hoje pode não descrever o mundo de
   * amanhã. O RustMaps resolve com o branch `staging`, gerado
   * contra a versão que VAI entrar — e por isso ele não é uma
   * caixinha que alguém marca, e sim uma consequência de para
   * onde a entrada aponta. Ver Docs\16 §9.1, "o staging".
   *
   * Duas formas de apontar, e as duas contam:
   *   1. um plano `forced` que nomeia esta entrada (`map_pool_id`);
   *   2. ela ser a próxima da fila E o próximo wipe ser forçado.
   *
   * A tabela `wipe_plans` é de outra frente (migração 023). Como
   * em `recentSeeds`, a conferência é da tabela E das colunas:
   * sem agenda no banco, a resposta é `false` — e prévia sem
   * staging continua sendo prévia.
   */
  aimedAtForcedWipe(serverId: string, id: number, now: number = Date.now()): boolean {
    if (!this.#canReadPlans()) {
      return false;
    }

    const named = this.#db
      .prepare(
        `SELECT id FROM wipe_plans
          WHERE server_id = @server_id AND map_pool_id = @id AND kind = 'forced'
            AND status IN ('planned', 'running')
          LIMIT 1`,
      )
      .get({ server_id: serverId, id }) as { readonly id: number } | undefined;

    if (named !== undefined) {
      return true;
    }

    const upcoming = this.#db
      .prepare(
        `SELECT kind FROM wipe_plans
          WHERE server_id = @server_id AND scheduled_at >= @now
            AND status IN ('planned', 'running')
          ORDER BY scheduled_at ASC
          LIMIT 1`,
      )
      .get({ server_id: serverId, now }) as { readonly kind: string } | undefined;

    if (upcoming?.kind !== 'forced') {
      return false;
    }

    // O próximo wipe é forçado: quem leva o staging é a entrada
    // que ele vai consumir — a primeira da fila, com a mesma
    // regra de `next` para mapa custom.
    //
    // ####  `generating` CONTA COMO FILA AQUI  ####
    //
    // Ela é a única diferença para o `next`, e ela existe por um
    // caso concreto: uma entrada que já está sendo desenhada sai
    // de `ready`, e sem esta linha uma segunda tentativa da mesma
    // prévia seria pedida SEM staging — trocando um retrato certo
    // por um da versão de ontem, bem no wipe em que isso importa.
    const fila = this.#db
      .prepare(
        `SELECT * FROM map_pool
          WHERE server_id = @server_id AND status IN ('ready', 'generating')
          ORDER BY position ASC, id ASC`,
      )
      .all({ server_id: serverId }) as MapPoolRow[];

    for (const row of fila) {
      const entry = toRecord(row);

      if (!blockedInForced(entry, true)) {
        return entry.id === id;
      }
    }

    return false;
  }

  /** Existe agenda de wipe neste banco? Ver `aimedAtForcedWipe`. */
  #canReadPlans(): boolean {
    const table = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wipe_plans'")
      .get() as { readonly name: string } | undefined;

    if (table === undefined) {
      return false;
    }

    const columns = new Set(
      (this.#db.prepare('PRAGMA table_info(wipe_plans)').all() as { readonly name: string }[]).map(
        (column) => column.name,
      ),
    );

    return (
      columns.has('map_pool_id') &&
      columns.has('kind') &&
      columns.has('status') &&
      columns.has('scheduled_at') &&
      columns.has('server_id')
    );
  }

  /** @throws {MapPoolError} 404 quando a entrada não é deste servidor. */
  #assertExists(serverId: string, id: number): MapPoolRecord {
    const current = this.get(serverId, id);

    if (current === null) {
      throw new MapPoolError('MAP_NOT_FOUND', `O mapa ${String(id)} não está na fila.`, 404);
    }

    return current;
  }
}

/**
 * A linha crua vira registro.
 *
 * `kind` e `status` chegam como `string` do SQLite. Quem garante
 * os valores é o `CHECK` da tabela — o estreitamento aqui só
 * reconhece isso para o TypeScript, e não substitui a trava.
 */
function toRecord(row: MapPoolRow): MapPoolRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    position: row.position,
    kind: row.kind === 'custom' ? 'custom' : 'procedural',
    seed: row.seed,
    worldSize: row.world_size,
    level: row.level,
    levelUrl: row.level_url,
    rustmapsId: row.rustmaps_id,
    staging: row.staging === 1,
    previewUrl: row.preview_url,
    thumbUrl: row.thumb_url,
    monuments: parseMonuments(row.monuments),
    status: toStatus(row.status),
    lastError: row.last_error,
    usedAt: row.used_at,
    createdAt: row.created_at,
    versionOk: row.version_ok === 1,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

const STATUSES: readonly MapPoolStatus[] = ['draft', 'generating', 'ready', 'used', 'failed'];

function toStatus(value: string): MapPoolStatus {
  return STATUSES.find((status) => status === value) ?? 'draft';
}

/**
 * O JSON dos monumentos vira lista.
 *
 * Coluna corrompida devolve `null` (= "não sabemos"), e não uma
 * lista vazia: "nenhum monumento" é uma afirmação sobre o mundo, e
 * um JSON quebrado não afirma nada.
 */
function parseMonuments(raw: string | null): readonly string[] | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}
