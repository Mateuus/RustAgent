// ============================================================
//  sync.ts  -  o agente e o plugin, nos dois sentidos.
//
//    EMPURRADO   `origemz.dungeon.sync` leva o estado completo:
//                que masmorra existe, como ela é por dentro, onde
//                nada pode nascer.
//
//    ESCUTADO    `#OZDUNGEON#{…}` no stream do console: construiu,
//                falhou, entrou, saiu, acabou.
//
//  As plantas NÃO passam por aqui — elas vão pelo disco
//  (`materializer.ts`), porque 512 KB não atravessam um frame de
//  WebRCON. Este canal leva só o que é pequeno.
//
//  ------------------------------------------------------------
//  ####  NENHUM COMANDO SAI DE DENTRO DO GANCHO  ####
//
//  MEDIDO neste projeto: um comando de RCON mandado de dentro do
//  `onConsoleLine` imprime no console, a linha volta pelo mesmo
//  caminho e dispara de novo — o console do jogo virou um paredão
//  de `loadout.sync` repetido no dia em que isso aconteceu.
//
//  Então o `handleLine` aqui só ESCREVE NO SQLITE, que não fala com
//  o jogo. Quando é preciso responder ao plugin (o `ready`), a
//  resposta sai por um relógio, um tick depois. Mesmo desenho do
//  `ui-sync.ts`, do `stat-events.ts` e do `quests/events.ts`.
//
//  ####  E NADA AQUI PODE LANÇAR  ####
//
//  O gancho roda no handler que recebe TODA linha do servidor. Uma
//  exceção subiria por um caminho que ninguém trata e levaria junto
//  o processamento do resto do stream — o console inteiro do
//  agente pararia por causa de um JSON torto.
//
//  Ver Docs/OrigemZDurgeon/01-PLANO-E-CONTRATOS.md §7.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { DungeonsRepository } from '../db/dungeons-repository.js';
import type { WorldEventsRepository } from '../db/world-events-repository.js';
import {
  buildDungeonSyncCommand,
  DUNGEON_COMMANDS,
  DUNGEON_SYNC_MAX_BYTES,
  groundReportSchema,
  parseDungeonPush,
  parseDungeonReady,
  type AiPayload,
  type DungeonPayload,
  type DungeonSyncPayload,
  type GradePayload,
  type GroundReport,
  type LootTablePayload,
} from '../game/dungeon-contract.js';
import type { Logger } from '../logger.js';
import type {
  AiSpecInput,
  Dungeon,
  GradeSetInput,
  LootTableInput,
} from '../types/dungeons.js';
import { toError } from '../util.js';
import type { BlueprintMaterializer } from './materializer.js';

/** O mínimo que o sync precisa de um servidor. */
/** Onde e para que lado a masmorra deve nascer. */
export interface DungeonBuildInput {
  readonly slug: string;
  readonly x: number;
  readonly z: number;
  /** Para onde ela cresce, em graus. É o que o admin olhava. */
  readonly yaw: number;
}

/**
 * O que aconteceu com o pedido de construir.
 *
 * ####  `sent` NÃO É "A MASMORRA EXISTE"  ####
 *
 * É "o comando chegou ao servidor". A construção leva segundos e
 * quem confirma é o `built` do stream, com as peças e a grade.
 * Confundir os dois é como o painel passou a afirmar que tinha
 * derrubado uma masmorra que continuava de pé.
 */
export interface DungeonBuildAttempt {
  readonly sent: boolean;
  /**
   *   `offline`   servidor fora do fio
   *   `water`     o chão ali é água, e a entrada nasceria submersa
   *   `occupied`  já há uma masmorra de pé naquele servidor
   *   `error`     o RCON estourou; `reply` traz a mensagem
   */
  readonly refused?: 'offline' | 'water' | 'occupied' | 'error';
  /** A resposta casada do comando, inteira. É o que explica. */
  readonly reply: string;
  /** Como é o chão ali. `null` = não deu para perguntar. */
  readonly ground: GroundReport | null;
}

export interface DungeonSyncServers {
  readonly ids: () => readonly string[];
  readonly contextOf: (
    serverId: string,
  ) => { readonly rcon: { readonly isConnected: boolean; send: (command: string) => Promise<string> } } | null;
}

export interface DungeonSyncDeps {
  readonly dungeons: DungeonsRepository;
  readonly events: WorldEventsRepository;
  readonly servers: DungeonSyncServers;
  readonly materializer: BlueprintMaterializer;
  readonly logger: Logger;
}

/**
 * Quanto tempo esperar antes de responder ao `ready`.
 *
 * Um tick já bastaria para sair do gancho; um segundo dá margem
 * para o plugin terminar de carregar antes de receber o estado —
 * e o custo de um segundo aqui é invisível.
 */
const READY_DELAY_MS = 1_000;

export class DungeonSync {
  readonly #deps: DungeonSyncDeps;

  /**
   * O segredo desta subida do agente.
   *
   * Sorteado uma vez e mandado no `sync`. É ele que separa o grito
   * do plugin de alguém digitando o marcador no chat — ver o
   * cabeçalho de `game/dungeon-contract.ts`.
   */
  readonly #secret = randomUUID();

  /** A run de pé em cada servidor, para casar `entered` e `ended`. */
  readonly #activeRun = new Map<string, number>();

  /** Relógios do `ready`, para não empilhar dois. */
  readonly #pending = new Map<string, NodeJS.Timeout>();

  #stopped = false;

  constructor(deps: DungeonSyncDeps) {
    this.#deps = deps;
  }

  /** Solta os relógios. Chamado no desligamento. */
  stop(): void {
    this.#stopped = true;

    for (const timer of this.#pending.values()) clearTimeout(timer);

    this.#pending.clear();
  }

  // ------------------------------------------------------
  //  EMPURRAR
  // ------------------------------------------------------

  /**
   * Manda o estado completo para um servidor.
   *
   * Escreve as plantas no disco ANTES do comando: o plugin recebe
   * "a masmorra bunker usa a planta entrance2" e vai procurar o
   * arquivo. Na ordem inversa, ele procuraria um arquivo que o
   * agente ainda não gravou — e responderia `blueprint_missing`
   * sobre algo que está a caminho.
   */
  async push(serverId: string, reason: string): Promise<boolean> {
    if (this.#stopped) return false;

    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) return false;

    try {
      await this.#deps.materializer.syncServer(serverId);

      const payload = this.#payloadFor(serverId);
      const command = buildDungeonSyncCommand(payload);

      if (command.length > DUNGEON_SYNC_MAX_BYTES) {
        // Meio estado é pior que estado nenhum: o plugin
        // substituiria um cache bom por um incompleto que ele
        // acredita ser completo.
        this.#deps.logger.error(
          { server: serverId, bytes: command.length, limit: DUNGEON_SYNC_MAX_BYTES },
          'o estado das masmorras passou do teto do RCON: envio RECUSADO, o cache anterior fica de pé',
        );

        return false;
      }

      await context.rcon.send(command);

      this.#deps.logger.debug(
        { server: serverId, dungeons: payload.dungeons.length, zones: payload.zones.length, reason },
        'estado das masmorras empurrado',
      );

      return true;
    } catch (cause) {
      this.#deps.logger.warn(
        { server: serverId, reason, error: toError(cause).message },
        'não consegui empurrar o estado das masmorras',
      );

      return false;
    }
  }

  /** Todos os servidores. É o caminho do "salvei no painel". */
  async pushAll(reason: string): Promise<void> {
    for (const serverId of this.#deps.servers.ids()) await this.push(serverId, reason);
  }

  /**
   * Pergunta ao servidor se aquele chão serve para uma masmorra.
   *
   * ####  ELA EXISTE PORQUE O AGENTE NÃO ENXERGA O TERRENO  ####
   *
   * O painel escolhe pontos olhando um mapa desenhado; o relevo, a
   * água e a altura estão do outro lado do fio. Perguntar custa um
   * comando e evita a entrada dentro de um rio — que em 09/09/2026
   * matou o dono no instante do teleporte.
   *
   * `null` = não deu para perguntar (servidor fora, resposta
   * ilegível). Quem chama decide, e o plugin ainda recusa água por
   * conta própria: esta é a checagem que EXPLICA antes, não a que
   * protege.
   */
  async groundAt(serverId: string, x: number, z: number): Promise<GroundReport | null> {
    if (this.#stopped) return null;

    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) return null;

    try {
      // A resposta do comando vem CASADA, no retorno do POST /rcon —
      // ela não aparece no buffer do console. Procurá-la lá faria o
      // comando parecer mudo.
      const reply = await context.rcon.send(
        `${DUNGEON_COMMANDS.ground} ${String(Math.round(x))} ${String(Math.round(z))} json`,
      );

      const start = reply.indexOf('{');
      const end = reply.lastIndexOf('}');

      if (start < 0 || end <= start) return null;

      const parsed = groundReportSchema.safeParse(JSON.parse(reply.slice(start, end + 1)));

      return parsed.success ? parsed.data : null;
    } catch (cause) {
      this.#deps.logger.debug(
        { server: serverId, x, z, error: toError(cause).message },
        'não consegui perguntar como é o chão ali',
      );

      return null;
    }
  }

  /**
   * Manda erguer uma masmorra naquele ponto.
   *
   * ####  O PAINEL DEIXA DE SER UM COPIADOR DE COMANDO  ####
   *
   * Até aqui, a única maneira de uma masmorra nascer era o admin
   * entrar no jogo e colar `/ozdungeon build <slug>` — o painel
   * sabia tudo sobre ela menos como fazê-la existir.
   *
   * O caminho já estava pronto do outro lado: o console aceita
   * `ozdungeon build <slug> <x> <z> [graus]` desde que a frente C
   * nasceu, e é a forma que se testa sem um cliente de Rust aberto.
   *
   * ####  E ELE NÃO INVENTA SUCESSO  ####
   *
   * `sent` é "o comando chegou ao servidor", e nada mais. Quem diz
   * que a masmorra existe é o `built` que volta pelo stream, com as
   * peças e a grade — a construção leva segundos, e a resposta do
   * comando sai antes dela terminar.
   *
   * É a mesma disciplina do `demolish`: o painel já afirmou uma vez
   * ter derrubado uma masmorra que continuava de pé, e o defeito
   * que AFIRMA é o que ninguém desconfia.
   */
  async build(serverId: string, input: DungeonBuildInput): Promise<DungeonBuildAttempt> {
    if (this.#stopped) {
      return { sent: false, refused: 'offline', reply: '', ground: null };
    }

    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      return { sent: false, refused: 'offline', reply: '', ground: null };
    }

    // A pergunta vem ANTES do comando, e não depois: depois seria
    // uma explicação para uma casinha que já está de pé na água.
    const ground = await this.groundAt(serverId, input.x, input.z);

    if (ground !== null && !ground.serves) {
      return { sent: false, refused: 'water', reply: '', ground };
    }

    const yaw = Math.round(((input.yaw % 360) + 360) % 360);

    const command =
      `${DUNGEON_COMMANDS.build} ${input.slug}` +
      ` ${String(Math.round(input.x))} ${String(Math.round(input.z))} ${String(yaw)}`;

    try {
      const reply = await context.rcon.send(command);

      // O plugin recusa a segunda masmorra em prosa: ele responde
      // "Já existe uma masmorra de pé ('x')". Não há código de erro
      // para ler, e inventar um exigiria mudar o comando que o admin
      // também usa dentro do jogo — então a rota lê a frase e o
      // painel mostra a frase inteira, que é o que explica.
      const occupied = reply.toLowerCase().includes('já existe uma masmorra');

      if (occupied) {
        return { sent: false, refused: 'occupied', reply: reply.trim(), ground };
      }

      this.#deps.logger.info(
        { server: serverId, dungeon: input.slug, x: input.x, z: input.z, yaw },
        'mandei erguer a masmorra pelo painel',
      );

      return { sent: true, reply: reply.trim(), ground };
    } catch (cause) {
      const message = toError(cause).message;

      this.#deps.logger.warn(
        { server: serverId, dungeon: input.slug, error: message },
        'não consegui mandar erguer a masmorra',
      );

      return { sent: false, refused: 'error', reply: message, ground };
    }
  }

  /**
   * Manda derrubar a masmorra que está de pé naquele servidor.
   *
   * ####  ELA EXISTE PORQUE O PAINEL MENTIA  ####
   *
   * MEDIDO em 09/09/2026, apontado pelo dono: ele parou uma masmorra
   * pelo painel, a tela disse que acabou — e a masmorra continuou no
   * chão do jogo.
   *
   * A rota fechava a run no banco e devolvia
   * `{ pendingCommand: 'ozdungeon stop' }`. Ninguém mandava esse
   * comando a lugar nenhum: o nome do campo já dizia que ele estava
   * pendente, e ficava pendente para sempre.
   *
   * É o pior tipo de defeito de painel — não o que falha, o que
   * AFIRMA ter feito. O admin só descobre voltando ao lugar.
   *
   * Devolve `false` quando o comando não chegou ao servidor. Quem
   * chama decide o que fazer com isso; aqui não se inventa sucesso.
   */
  async demolish(serverId: string, reason: string): Promise<boolean> {
    if (this.#stopped) return false;

    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) return false;

    try {
      await context.rcon.send('ozdungeon stop');

      this.#deps.logger.info({ server: serverId, reason }, 'masmorra derrubada pelo painel');

      // O `ended` NÃO é reportado aqui: o plugin o emite pelo stream
      // quando termina de derrubar, e é ele quem sabe quantos
      // jogadores estavam dentro. Fechar a run em dois lugares
      // contaria o mesmo desfecho duas vezes no histórico.
      return true;
    } catch (cause) {
      this.#deps.logger.warn(
        { server: serverId, reason, error: toError(cause).message },
        'não consegui derrubar a masmorra',
      );

      return false;
    }
  }

  /**
   * Agenda um push para daqui a pouco.
   *
   * Existe para ser chamado de dentro do gancho de console sem
   * fechar o laço descrito no cabeçalho, e para juntar várias
   * mudanças seguidas do painel num envio só.
   */
  pushSoon(serverId: string, reason: string, delayMs = READY_DELAY_MS): void {
    if (this.#stopped) return;

    const existing = this.#pending.get(serverId);

    if (existing !== undefined) clearTimeout(existing);

    this.#pending.set(
      serverId,
      setTimeout(() => {
        this.#pending.delete(serverId);
        void this.push(serverId, reason);
      }, delayMs),
    );
  }

  #payloadFor(serverId: string): DungeonSyncPayload {
    return {
      secret: this.#secret,
      // ####  SÓ AS MASMORRAS DAQUELE SERVIDOR  ####
      //
      // Até 09/09/2026 aqui era `list()`: o catálogo inteiro ia para
      // cada servidor da rede, e a masmorra desenhada para o PvE
      // nascia no comando do hardcore. Quem apontou foi o dono —
      // "na hora de subir masmorra tem que separar por servidor".
      //
      // Uma masmorra sem servidor marcado vale em TODOS, que é o que
      // faz este corte não apagar nada de quem nunca escolheu. Ver a
      // migração 072.
      dungeons: this.#deps.dungeons
        .listFor(serverId)
        .map((summary) => this.#dungeonPayload(summary.id)),
      zones: this.#deps.events
        .zonesOf(serverId)
        .map((zone) => ({ x: zone.x, z: zone.z, radius: zone.radius })),
    };
  }

  #dungeonPayload(id: string): DungeonPayload {
    const dungeon = this.#deps.dungeons.get(id);

    if (dungeon === null) throw new Error(`a masmorra "${id}" sumiu entre a lista e a leitura`);

    return {
      id: dungeon.id,
      mode: dungeon.mode,
      entrance: dungeon.entranceBlueprint,
      // `none` é o padrão dos dois lados do fio, então não viaja:
      // é o mesmo corte do `leanAccess`.
      entranceItems: dungeon.entranceItems === 'none' ? undefined : dungeon.entranceItems,
      // Zero é não girar, dos dois lados do fio: não viaja.
      entranceRotation: dungeon.entranceRotation === 0 ? undefined : dungeon.entranceRotation,
      // `null` é o automático dos dois lados: não viaja.
      entranceFacing: dungeon.entranceFacing ?? undefined,
      size: dungeon.size,
      weights: dungeon.weights,
      corridor: {
        npcDensity: dungeon.corridor.npcDensity,
        lootDensity: dungeon.corridor.lootDensity,
        crates: dungeon.corridor.crates,
        table: leanTable(dungeon.corridor.table),
        ai: leanAi(dungeon.corridor.ai),
      },
      grid: dungeon.grid,
      npc: {
        health: dungeon.npc.health,
        damageScale: dungeon.npc.damageScale,
        weapons: dungeon.npc.weapons,
        names: dungeon.npc.names,
        loot: leanTable(dungeon.npc.loot),
        ai: leanAi(dungeon.npc.ai),
      },
      timeOfDay: dungeon.timeOfDay,
      structure: leanStructure(dungeon.structure),
      lock: leanLock(dungeon.lock),
      access: leanAccess(dungeon.access),
      protection: leanProtection(dungeon.protection),
      marker: leanMarker(dungeon.marker),
      announce: leanAnnounce(dungeon.announce),
      respawn: leanRespawn(dungeon.respawn),
      rooms: dungeon.rooms.map((room) => ({
        key: room.key,
        color: room.color,
        npc: room.npc,
        loot: room.loot,
        crates: room.crates,
        door: room.door,
        locked: room.locked,
        wideDoor: room.wideDoor ?? undefined,

        // ####  A SALA MANDA O GRADE INTEIRO, OU NÃO MANDA NADA  ####
        //
        // Aqui NÃO cabe o corte do `leanStructure`: uma sala que
        // pediu pedra numa masmorra de metal precisa dizer "pedra".
        // Omitir por ser o padrão do PLUGIN faria essa sala herdar o
        // metal da masmorra — o oposto do que o admin escolheu.
        grade: room.grade ?? undefined,

        wideDoorCellsPerDoor:
          room.wideDoorCellsPerDoor === DEFAULT_WIDE_DOOR_CELLS
            ? undefined
            : room.wideDoorCellsPerDoor,
        table: leanTable(room.table),
        ai: leanAi(room.ai),
      })),
    };
  }

  // ------------------------------------------------------
  //  ESCUTAR
  // ------------------------------------------------------

  /**
   * Uma linha do console.
   *
   * Recusa em UMA comparação de string a linha que não é nossa — e
   * "não é nossa" é a maioria absoluta das centenas por minuto que
   * passam por aqui.
   */
  handleLine(serverId: string, line: string): void {
    if (this.#stopped || !line.includes('#OZDUNGEON#')) return;

    try {
      this.#handle(serverId, line);
    } catch (cause) {
      // Ver o cabeçalho: nada aqui pode lançar. Uma exceção levaria
      // o processamento do resto do stream junto.
      this.#deps.logger.warn(
        { server: serverId, error: toError(cause).message },
        'linha do OrigemZDungeon não pôde ser tratada',
      );
    }
  }

  #handle(serverId: string, line: string): void {
    // O `ready` vem primeiro porque é o único sem segredo — é
    // justamente ele que o plugin ainda não tem.
    const ready = parseDungeonReady(line);

    if (ready !== null) {
      this.#deps.logger.info({ server: serverId }, 'o OrigemZDungeon subiu e pediu o estado');
      this.pushSoon(serverId, 'plugin-ready');
      return;
    }

    const event = parseDungeonPush(line, this.#secret);

    if (event === null) return;

    switch (event.kind) {
      case 'built': {
        // ####  A RUN NASCE AQUI, E É ISSO QUE O PAINEL VÊ  ####
        //
        // O assistente do editor (§12.1.1) pergunta a cada dois
        // segundos "nasceu alguma coisa desta masmorra depois que
        // eu abri o passo?". Esta linha é a resposta.
        //
        // `eventId` é 'manual' porque o admin construiu à mão: o
        // caminho agendado abre a run ANTES, e ali ela já tem
        // evento. Ver o agendador, na frente G.
        const run = this.#deps.events.startRun({
          eventId: 'manual',
          serverId,
          dungeonId: event.slug,
          x: event.x,
          z: event.z,
          grid: event.grid,
          seed: event.seed ?? null,
        });

        this.#activeRun.set(serverId, run.id);

        this.#deps.logger.info(
          { server: serverId, dungeon: event.slug, grid: event.grid, entities: event.entities },
          'masmorra de pé',
        );

        return;
      }

      case 'failed': {
        this.#deps.events.failRun({
          eventId: 'manual',
          serverId,
          dungeonId: event.slug,
          reason: event.reason,
        });

        this.#activeRun.delete(serverId);

        this.#deps.logger.warn(
          { server: serverId, dungeon: event.slug, reason: event.reason },
          'a masmorra não nasceu',
        );

        return;
      }

      case 'entered': {
        const runId = this.#runIdOf(serverId);

        if (runId !== null) this.#deps.events.playerEntered(runId, event.steamId);

        return;
      }

      case 'left': {
        const runId = this.#runIdOf(serverId);

        if (runId !== null) this.#deps.events.playerLeft(runId, event.steamId, event.died);

        return;
      }

      case 'ended': {
        const runId = this.#runIdOf(serverId);

        if (runId !== null) {
          this.#deps.events.endRun(runId, event.reason === 'command' ? 'cancelled' : 'ended');
          this.#activeRun.delete(serverId);
        }

        this.#deps.logger.info(
          { server: serverId, reason: event.reason, entered: event.entered },
          'masmorra encerrada',
        );

        return;
      }
    }
  }

  /**
   * A run daquele servidor.
   *
   * O cache em memória é o caminho normal; o banco é o resgate
   * depois de um reinício do agente com masmorra de pé — sem ele,
   * quem entrasse depois do restart não seria contado, e o admin
   * veria "0 dentro" com quatro jogadores lá.
   */
  #runIdOf(serverId: string): number | null {
    const cached = this.#activeRun.get(serverId);

    if (cached !== undefined) return cached;

    const run = this.#deps.events.activeRun(serverId);

    if (run === null) return null;

    this.#activeRun.set(serverId, run.id);

    return run.id;
  }
}

// ============================================================
//  O ENXUGAMENTO DO PAYLOAD
//
//  ####  O TETO DO SYNC É 50 KB, E A TABELA DE LOOT COME ISSO  ####
//
//  MEDIDO em 09/09/2026: uma masmorra de três salas sem tabela pesa
//  ~1,0 KB em base64; com tabelas de oito itens por cor e mais uma
//  no corredor, ~6,7 KB. É a diferença entre caber 36 e caber 7 no
//  mesmo comando — e um payload que estoura não falha alto, ele é
//  RECUSADO e deixa o plugin com o estado velho.
//
//  ####  UNDEFINED SOME SOZINHO NA SERIALIZAÇÃO  ####
//
//  `JSON.stringify` não escreve chave cujo valor é `undefined`.
//  Então devolver `undefined` aqui é o mesmo que não mandar o
//  campo, sem um único `delete` nem objeto montado por spread.
//
//  ####  E CADA CORTE FOI CONFERIDO CONTRA O C#  ####
//
//  Omitir só é seguro quando o plugin, sem o campo, faz EXATAMENTE
//  o que o valor omitido faria:
//
//    · `structure` ausente → `DefaultGrade`, que é `Stone`
//    · `lock` ausente → `new LockSpec()`, com os mesmos padrões
//    · `access` ausente → `new AccessSpec()`, que é `everyone`
//    · `protection` ausente → `new ProtectionSpec()`, os três ligados
//    · `table` ausente → `ModeOf` devolve "server"
//    · `weight` ausente numa linha → o `LootEntrySpec` do plugin
//      trata 0 como "peso 1"; por isso ele só é omitido quando é 10,
//      e o 10 é reposto do lado de lá pelo mesmo inicializador
//
//  O `respawn` é a exceção que prova a regra, e por isso ele viaja
//  sempre — ver `leanRespawn`.
// ============================================================

/** O `DefaultWideDoorCellsPerDoor` do plugin. */
const DEFAULT_WIDE_DOOR_CELLS = 4;

/** O peso que o plugin repõe quando a linha não traz nenhum. */
const DEFAULT_ENTRY_WEIGHT = 10;

/**
 * O título que o plugin usa quando o `noteTitle` chega vazio.
 *
 * Declarado AQUI, e não ao lado da função que o lê: o arquivo de
 * contrato desta frente já derrubou o boot do agente uma vez por
 * uma constante lida antes de declarada, e o typecheck não vê isso.
 */
const DEFAULT_NOTE_TITLE = 'Código da porta';

/**
 * O `new MarkerSpec()` do plugin, campo a campo.
 *
 * Eles são a régua do corte acima: mudá-los de um lado só é o jeito
 * de quebrar isto em silêncio — o admin escolhe uma coisa, o sync
 * não manda, e o jogo faz outra.
 */
const DEFAULT_MARKER_LABEL = 'Masmorra';
const DEFAULT_MARKER_COLOR = '#ff0000';
const DEFAULT_MARKER_ALPHA = 0.55;
const DEFAULT_MARKER_RADIUS = 0.5;

/**
 * A tabela, sem o que já é o padrão.
 *
 * `mode: 'server'` não viaja: é o que o plugin faz sem tabela
 * nenhuma, e é o caso de quase toda masmorra. Dentro das linhas,
 * cada campo em valor padrão também fica de fora — são ~55 bytes
 * por linha, e uma masmorra com quatro tabelas de oito tem 32
 * delas.
 */
function leanTable(table: LootTableInput): LootTablePayload | undefined {
  if (table.mode === 'server') return undefined;

  return {
    mode: table.mode,
    rolls: table.rolls,
    entries: table.entries.map((entry) => ({
      shortname: entry.shortname,
      amount: entry.amount,
      weight: entry.weight === DEFAULT_ENTRY_WEIGHT ? undefined : entry.weight,
      guaranteed: entry.guaranteed ? true : undefined,
      skin: entry.skin === 0 ? undefined : entry.skin,
      blueprint: entry.blueprint ? true : undefined,
      condition: entry.condition === 0 ? undefined : entry.condition,
    })),
  };
}

/**
 * O bloco de comportamento, ou nada.
 *
 * Ele já nasce mínimo — só carrega o campo que alguém escreveu —,
 * então o único corte possível é o bloco vazio, que é o caso de
 * toda masmorra que não mexeu na IA. São 8 bytes por lugar, e os
 * lugares são cinco numa masmorra de três salas.
 */
function leanAi(ai: AiSpecInput): AiPayload | undefined {
  return Object.keys(ai).length === 0 ? undefined : ai;
}

/**
 * O nível das peças da masmorra, ou nada.
 *
 * Pedra em tudo é o `DefaultGrade` do plugin — e era o que o
 * construtor cravava antes desta frente existir.
 */
function leanStructure(structure: GradeSetInput): GradePayload | undefined {
  const untouched =
    structure.foundation === 'stone' && structure.wall === 'stone' && structure.ceiling === 'stone';

  return untouched ? undefined : structure;
}

/**
 * A fechadura, ou nada.
 *
 * O `new LockSpec()` do plugin tem exatamente estes valores, e o
 * `noteTitle` vazio vira "Código da porta" lá dentro. Quem não
 * mexeu na fechadura não gasta os ~150 bytes dela.
 */
function leanLock(lock: Dungeon['lock']): DungeonPayload['lock'] {
  const untouched =
    lock.enabled &&
    !lock.sharedCode &&
    lock.carrier === 'npc' &&
    lock.carrierScope === 'corridor' &&
    lock.onUndelivered === 'unlock' &&
    lock.noteTitle === DEFAULT_NOTE_TITLE &&
    lock.announceOpen &&
    lock.warnOnWrongCode;

  return untouched ? undefined : lock;
}

/**
 * Quem desce pelo alçapão, ou nada.
 *
 * ####  `everyone` NÃO VIAJA, E ISSO É O CASO DE QUASE TODA MASMORRA  ####
 *
 * O `new AccessSpec()` do plugin nasce `everyone` — o pedido literal
 * do dono, "a Dungeon todo o servidor pode entrar nela". Omitir o
 * bloco faz o `MayEnter` devolver `true` antes de olhar qualquer
 * permissão, que é exatamente o que este lado escolheu.
 *
 * E por isso a permissão também não viaja no modo `everyone`: ela
 * NÃO É LIDA lá. Guardá-la no banco e não mandá-la é o certo — o
 * admin que escreveu "vip.premium" e deixou aberto para todos não
 * perde o que digitou, e o jogo não recebe uma regra que ninguém
 * mandou aplicar.
 */
function leanAccess(access: Dungeon['access']): DungeonPayload['access'] {
  if (access.whoEnters !== 'permission') return undefined;

  return {
    whoEnters: access.whoEnters,
    // Vazia é o que o plugin já faz sozinho: cai em
    // `origemzdungeon.enter`. São ~30 bytes por masmorra.
    enterPermission: access.enterPermission === '' ? undefined : access.enterPermission,
  };
}

/**
 * A proteção, ou nada.
 *
 * Os três ligados são o `new ProtectionSpec()` do plugin, e é o que
 * o dono pediu: "impedir que jogadores com martelo remover objetos
 * da entrada". Quem não mexeu não paga os ~95 bytes do bloco
 * (MEDIDO em 09/09/2026, no comando em base64).
 *
 * ####  E DESLIGAR NÃO É O MESMO QUE OMITIR  ####
 *
 * `enabled: false` VIAJA, porque abre dez caminhos de perder a
 * entrada — martelo, melhorar, girar, demolir, reparar, os dois
 * modos da ferramenta de remoção, o pickup e a fechadura. Só o
 * decay fica de fora dos dois lados: ele obedece à marca
 * `#ozdung#`, nunca a este bloco.
 */
function leanProtection(protection: Dungeon['protection']): DungeonPayload['protection'] {
  const untouched = protection.enabled && protection.allowAdmin && protection.warnOnAttempt;

  return untouched ? undefined : protection;
}

/**
 * O círculo no mapa, sem o que já é o padrão.
 *
 * O corte é o mesmo do `leanAccess`: os padrões daqui e os do
 * `new MarkerSpec()` do plugin são os mesmos, então uma masmorra
 * que ninguém reeditou não paga byte nenhum do teto de 50 KB.
 *
 * Desligado viaja sozinho: os outros quatro campos não são lidos
 * quando não há marcador para configurar.
 */
function leanMarker(marker: Dungeon['marker']): DungeonPayload['marker'] {
  if (!marker.enabled) return { enabled: false };

  const untouched =
    marker.label === DEFAULT_MARKER_LABEL &&
    marker.color === DEFAULT_MARKER_COLOR &&
    marker.alpha === DEFAULT_MARKER_ALPHA &&
    marker.radius === DEFAULT_MARKER_RADIUS;

  if (untouched) return undefined;

  return {
    enabled: true,
    ...(marker.label === DEFAULT_MARKER_LABEL ? {} : { label: marker.label }),
    ...(marker.color === DEFAULT_MARKER_COLOR ? {} : { color: marker.color }),
    ...(marker.alpha === DEFAULT_MARKER_ALPHA ? {} : { alpha: marker.alpha }),
    ...(marker.radius === DEFAULT_MARKER_RADIUS ? {} : { radius: marker.radius }),
  };
}

/**
 * O anúncio, sem o que já é o padrão.
 *
 * ####  TEXTO VAZIO NÃO VIAJA  ####
 *
 * Vazio quer dizer "use a frase padrão", e a frase padrão mora no
 * plugin. Mandar uma string vazia pelo fio faria o plugin ter de
 * distinguir "vazio" de "ausente" para chegar à mesma conclusão.
 */
function leanAnnounce(announce: Dungeon['announce']): DungeonPayload['announce'] {
  if (!announce.enabled) return { enabled: false };

  const untouched = announce.onBuild === '' && announce.onEnd === '' && announce.showGrid;

  if (untouched) return undefined;

  return {
    enabled: true,
    ...(announce.onBuild === '' ? {} : { onBuild: announce.onBuild }),
    ...(announce.onEnd === '' ? {} : { onEnd: announce.onEnd }),
    ...(announce.showGrid ? {} : { showGrid: false }),
  };
}

/**
 * O ciclo do loot — e ele NÃO é omitido nunca.
 *
 * ####  AUSENTE E `enabled: false` SÃO COISAS DIFERENTES  ####
 *
 * MEDIDO no plugin: sem o bloco, ele não toca no `LootContainer` e
 * o refresh do PREFAB fica de pé — a caixa de radtown se repõe
 * sozinha em uma hora. Com `enabled: false`, ele zera esse refresh.
 *
 * O contrato promete que desligado é desligado, então o bloco
 * viaja. O que dá para cortar são os outros três campos quando o
 * ciclo está desligado: eles não são lidos, e os inicializadores do
 * `RespawnSpec` repõem os mesmos valores do lado de lá.
 */
function leanRespawn(respawn: Dungeon['respawn']): DungeonPayload['respawn'] {
  if (!respawn.enabled) return { enabled: false };

  return {
    enabled: true,
    minutes: respawn.minutes,
    onlyWhenEmpty: respawn.onlyWhenEmpty,
    rebuildDestroyed: respawn.rebuildDestroyed,
  };
}
