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
  DUNGEON_SYNC_MAX_BYTES,
  parseDungeonPush,
  parseDungeonReady,
  type DungeonPayload,
  type DungeonSyncPayload,
} from '../game/dungeon-contract.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import type { BlueprintMaterializer } from './materializer.js';

/** O mínimo que o sync precisa de um servidor. */
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
      dungeons: this.#deps.dungeons.list().map((summary) => this.#dungeonPayload(summary.id)),
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
      size: dungeon.size,
      weights: dungeon.weights,
      corridor: dungeon.corridor,
      grid: dungeon.grid,
      npc: dungeon.npc,
      timeOfDay: dungeon.timeOfDay,
      rooms: dungeon.rooms.map((room) => ({
        key: room.key,
        color: room.color,
        npc: room.npc,
        loot: room.loot,
        crates: room.crates,
        door: room.door,
        locked: room.locked,
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
