// ============================================================
//  npc-sync.ts  -  leva os NPCs de missão até o mundo, e traz de
//  volta o que o admin cadastrou no jogo.
//
//  ####  DUAS DIREÇÕES, E ELAS SÃO DIFERENTES  ####
//
//    DESCE  o agente manda `npc.clear` e um `npc.set` por NPC.
//           O plugin spawna. É o mesmo desenho do
//           `custom-items-sync.ts`, e pelo mesmo motivo: cada NPC
//           traz nome, posição, prefab e raio, e o conjunto passa
//           do frame do RCON com poucas dezenas.
//
//    SOBE   o admin digita `/questnpc add <nome>` DE PÉ no lugar
//           onde o NPC deve ficar. O plugin grita a posição; este
//           arquivo grava.
//
//  ####  POR QUE O CADASTRO É NO JOGO  ####
//
//  Ninguém escolhe coordenada digitando número. Para posição no
//  mundo, o jogo é a melhor interface que existe — e é o único
//  pedaço do `Quests.cs` de referência que sobrevive quase igual.
//  O painel faz o resto: renomear, ligar, desligar, apagar.
//
//  ####  O `clear` PRIMEIRO, E ELE NÃO ABRE JANELA PERIGOSA  ####
//
//  Entre o `clear` e o último `set` o servidor fica sem NPC. A
//  janela é de milissegundos e o desfecho é benigno: quem estiver
//  apertando USE naquele instante não abre a tela, e tenta de novo.
//
//  O contrário (dar `set` em tudo e só então `clear`) não existe: o
//  `clear` apagaria o que acabou de subir.
//
//  Ver Docs/OrigemZQuests/01-PLANO-E-CONTRATOS.md §10.
// ============================================================

import type { QuestNpcRecord, QuestsRepository } from '../db/quests-repository.js';
import { encodeQuestPayload, QUESTS_CONTRACT } from '../game/quests-contract.js';
import { DEFAULT_NPC_PREFAB } from '../types/quests.js';
import type { Logger } from '../logger.js';
import { slugify } from '../db/custom-items-repository.js';

/** `origemz.quest.npc.clear` — o plugin esquece e despawna tudo. */
export const NPC_CLEAR_COMMAND = 'origemz.quest.npc.clear';
/** `origemz.quest.npc.set <base64>` — um NPC. */
export const NPC_SET_COMMAND = 'origemz.quest.npc.set';
/** O marcador que o plugin grita. Ver o cabeçalho. */
export const NPC_MARKER = '#OZQUESTNPC#';

export interface NpcSyncRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

export interface NpcSyncServers {
  ids(): readonly string[];
  contextOf(id: string): { readonly rcon: NpcSyncRcon } | null;
}

export interface QuestNpcSyncDeps {
  readonly repository: QuestsRepository;
  readonly servers: NpcSyncServers;
  readonly logger: Logger;
  /** O mesmo segredo do `#OZQUEST#`. Ver `parseQuestPush`. */
  readonly secret: string;
  /** Abre a tela do NPC para aquele jogador. */
  readonly openScreen?: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly screenId: string;
  }) => Promise<void>;
}

/** O que o plugin grita. Ver `parseNpcLine`. */
export type NpcPush =
  /** O admin cadastrou um NPC de pé no lugar. */
  | {
      readonly kind: 'add';
      readonly name: string;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly rotation: number;
    }
  /** Um jogador apertou USE perto de um NPC. */
  | { readonly kind: 'use'; readonly steamId: string; readonly npcId: string };

export class QuestNpcSync {
  readonly #deps: QuestNpcSyncDeps;
  /** O que cada servidor já tem, para não reenviar o igual. */
  readonly #sent = new Map<string, string>();

  constructor(deps: QuestNpcSyncDeps) {
    this.#deps = deps;
  }

  /**
   * Manda os NPCs daquele servidor.
   *
   * Só os LIGADOS: um NPC desligado continua no banco, com a
   * posição guardada, e volta com um clique.
   */
  async push(serverId: string): Promise<void> {
    const rcon = this.#deps.servers.contextOf(serverId)?.rcon;

    if (rcon === undefined || !rcon.isConnected) {
      return;
    }

    const npcs = this.#deps.repository.listNpcsToSpawn(serverId);
    const fingerprint = JSON.stringify(npcs.map(toPayload));

    if (this.#sent.get(serverId) === fingerprint) {
      return;
    }

    await rcon.send(NPC_CLEAR_COMMAND);

    for (const npc of npcs) {
      await rcon.send(`${NPC_SET_COMMAND} ${encodeQuestPayload(toPayload(npc))}`);
    }

    this.#sent.set(serverId, fingerprint);

    this.#deps.logger.info({ server: serverId, npcs: npcs.length }, 'NPCs de missão enviados');
  }

  /** Força o reenvio: a rota do painel chama isto depois de gravar. */
  forget(serverId?: string): void {
    if (serverId === undefined) {
      this.#sent.clear();
    } else {
      this.#sent.delete(serverId);
    }
  }

  /**
   * Uma linha do console.
   *
   * ####  ELA NÃO PODE LANÇAR, E NÃO MANDA COMANDO  ####
   *
   * Roda no handler que recebe TODA linha do servidor. A gravação
   * (SQLite) acontece aqui; falar com o jogo espera um relógio —
   * ver o cabeçalho de `quests/events.ts`.
   *
   * @returns `true` quando a linha era nossa.
   */
  handleLine(serverId: string, line: string): boolean {
    const push = parseNpcLine(line, this.#deps.secret);

    if (push === null) {
      return false;
    }

    try {
      if (push.kind === 'add') {
        this.#add(serverId, push);
      } else {
        this.#use(serverId, push);
      }
    } catch (error) {
      this.#deps.logger.warn({ server: serverId, err: error }, 'não consegui tratar um NPC');
    }

    return true;
  }

  // ------------------------------------------------------

  #add(serverId: string, push: Extract<NpcPush, { kind: 'add' }>): void {
    const id = this.#freeId(push.name);

    this.#deps.repository.createNpc(id, {
      serverId,
      name: push.name,
      kind: 'quest',
      x: push.x,
      y: push.y,
      z: push.z,
      rotation: push.rotation,
      // Os padrões do contrato: o prefab medido, o marcador ligado e
      // o raio de 3 m. Quem quiser outro muda no painel.
      //
      // A constante, e não a string repetida: o prefab está em três
      // lugares (o schema, a migração e aqui), e duas cópias
      // divergem na primeira vez que alguém troca o boneco.
      prefab: DEFAULT_NPC_PREFAB,
      mapMarker: true,
      useRadius: 3,
      enabled: true,
      wipePolicy: 'keep',
    });

    this.forget(serverId);

    this.#deps.logger.info({ server: serverId, npc: id, name: push.name }, 'NPC de missão criado');
  }

  #use(serverId: string, push: Extract<NpcPush, { kind: 'use' }>): void {
    // ####  A CONFERÊNCIA QUE A IDA A MAIS PAGA  ####
    //
    // O plugin diz "o Fulano apertou USE no npc X". Confirmar que
    // aquele NPC existe NAQUELE servidor é o que impede uma linha
    // forjada abrir uma tela de outro mundo.
    const npc = this.#deps.repository.getNpc(push.npcId);

    if (npc === null || npc.serverId !== serverId || !npc.enabled) {
      return;
    }

    const open = this.#deps.openScreen;

    if (open === undefined) {
      return;
    }

    // O relógio: nenhum comando sai da pilha do gancho de console.
    const timer = setTimeout(() => {
      void open({
        serverId,
        steamId: push.steamId,
        screenId: `tela-quest:npc:${npc.id}`,
      }).catch((error: unknown) => {
        this.#deps.logger.debug(
          { server: serverId, npc: npc.id, err: error },
          'não deu para abrir a tela do NPC',
        );
      });
    }, 50);

    timer.unref();
  }

  /**
   * Um id livre, derivado do nome.
   *
   * Mesma função e mesma escolha do item custom: o sufixo numérico
   * avisa quem cadastrou que já existe um NPC com aquele nome.
   */
  #freeId(name: string): string {
    const base = slugify(name);

    if (this.#deps.repository.getNpc(base) === null) {
      return base;
    }

    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${String(suffix)}`;

      if (this.#deps.repository.getNpc(candidate) === null) {
        return candidate;
      }
    }

    throw new Error(`não achei um id livre para o NPC "${name}"`);
  }
}

/** O NPC, como o plugin o recebe. */
function toPayload(npc: QuestNpcRecord) {
  return {
    contract: QUESTS_CONTRACT,
    id: npc.id,
    name: npc.name,
    x: npc.x,
    y: npc.y,
    z: npc.z,
    rotation: npc.rotation,
    prefab: npc.prefab,
    mapMarker: npc.mapMarker,
    useRadius: npc.useRadius,
  };
}

/**
 * Lê a linha do console.
 *
 * `null` para tudo o que não é nosso — inclusive para um marcador
 * com segredo errado, e em SILÊNCIO: o chat dos jogadores passa
 * pelo mesmo cano, e alguém testando não pode encher o log.
 */
export function parseNpcLine(line: string, secret: string): NpcPush | null {
  const at = line.indexOf(NPC_MARKER);

  if (at < 0) {
    return null;
  }

  try {
    const raw: unknown = JSON.parse(line.slice(at + NPC_MARKER.length).trim());

    if (typeof raw !== 'object' || raw === null) {
      return null;
    }

    const body = raw as Record<string, unknown>;

    if (body.contract !== QUESTS_CONTRACT || body.secret !== secret) {
      return null;
    }

    if (body.kind === 'use') {
      return typeof body.steamId === 'string' &&
        /^\d{17}$/.test(body.steamId) &&
        typeof body.npcId === 'string' &&
        body.npcId !== ''
        ? { kind: 'use', steamId: body.steamId, npcId: body.npcId }
        : null;
    }

    if (body.kind !== 'add') {
      return null;
    }

    const numbers = ['x', 'y', 'z', 'rotation'] as const;

    for (const key of numbers) {
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
        return null;
      }
    }

    return typeof body.name === 'string' && body.name.trim() !== ''
      ? {
          kind: 'add',
          name: body.name.trim().slice(0, 60),
          x: body.x as number,
          y: body.y as number,
          z: body.z as number,
          rotation: body.rotation as number,
        }
      : null;
  } catch {
    return null;
  }
}
