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

import type { QuestNpcRecord, QuestRecord, QuestsRepository } from '../db/quests-repository.js';
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

/** Uma missão daquele NPC, como o boneco a apresenta. */
export interface QuestNpcOffer {
  readonly id: string;
  readonly title: string;
  /** A fala. `null` = o plugin monta uma a partir do objetivo. */
  readonly description: string | null;
  /** "Colete 100 wood", já em português. */
  readonly goal: string;
  /** "100 scrap", já em português. `''` = a missão não dá nada. */
  readonly reward: string;
}

export interface QuestNpcSyncDeps {
  readonly repository: QuestsRepository;
  readonly servers: NpcSyncServers;
  readonly logger: Logger;
  /** O mesmo segredo do `#OZQUEST#`. Ver `parseQuestPush`. */
  readonly secret: string;
  /**
   * As frases da missão, prontas.
   *
   * ####  ELAS NÃO PODEM NASCER NO PLUGIN  ####
   *
   * "Colete 100 wood" e "100 scrap" precisam do catálogo do JOGO
   * (que sabe que `wood` se chama Madeira) e do de rankings. Nada
   * disso mora no plugin, e mandá-lo montar texto seria a segunda
   * versão da mesma frase — a pobre.
   *
   * `undefined` = ninguém ligou, e a caixa do NPC mostra só o
   * título da missão.
   */
  readonly describeQuest?: (quest: QuestRecord) => {
    readonly goal: string;
    readonly reward: string;
  };
  /**
   * O jogador clicou em aceitar dentro da caixa do NPC.
   *
   * O plugin já conferiu que ele está perto do boneco — a distância
   * é medida no jogo, que é o único lugar onde ela existe. Quem
   * decide se a missão pode ser aceita continua sendo o agente.
   */
  readonly onAccept?: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly npcId: string;
    readonly questId: string;
  }) => void;
  /**
   * O jogador falou com aquele NPC.
   *
   * É a única testemunha que o agente tem de que alguém esteve no
   * balcão — e é ela que libera o botão de aceitar da missão
   * daquele NPC. Ver `#npcTalks` no serviço.
   */
  readonly onTalk?: (input: {
    readonly serverId: string;
    readonly steamId: string;
    readonly npcId: string;
  }) => void;
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
  /**
   * O admin foi até o lugar novo e chamou o NPC para lá.
   *
   * Mover é TRAZER, e por isso não pede coordenada: quem quer o
   * boneco em outro lugar já está nele. Sem este empurrão o painel
   * mandava usar o `add` de novo — e o admin terminava com dois
   * bonecos, "mateus" e "mateus-2".
   */
  | {
      readonly kind: 'move';
      readonly npcId: string;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly rotation: number;
    }
  /** O admin apagou o NPC de dentro do jogo. */
  | { readonly kind: 'remove'; readonly npcId: string }
  /** Um jogador apertou USE (ou TALK) perto de um NPC. */
  | { readonly kind: 'use'; readonly steamId: string; readonly npcId: string }
  /**
   * Ele clicou em aceitar dentro da caixa do NPC.
   *
   * A caixa é desenhada pelo plugin, e o clique nasce no CLIENTE —
   * mas quem o reporta é o plugin, que antes confere a distância
   * até o boneco. O agente decide o resto.
   */
  | {
      readonly kind: 'accept';
      readonly steamId: string;
      readonly npcId: string;
      readonly questId: string;
    };

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
    const payloads = npcs.map((npc) => this.#payloadOf(npc));
    const fingerprint = JSON.stringify(payloads);

    if (this.#sent.get(serverId) === fingerprint) {
      return;
    }

    await rcon.send(NPC_CLEAR_COMMAND);

    for (const payload of payloads) {
      await rcon.send(`${NPC_SET_COMMAND} ${encodeQuestPayload(payload)}`);
    }

    this.#sent.set(serverId, fingerprint);

    this.#deps.logger.info({ server: serverId, npcs: npcs.length }, 'NPCs de missão enviados');
  }

  /**
   * O NPC, como o plugin o recebe — com as missões dele dentro.
   *
   * ####  POR QUE AS OFERTAS DESCEM JUNTO  ####
   *
   * A caixa que o jogador vê ao apertar TALK é desenhada PELO
   * PLUGIN, na hora, sem ida à rede. Para isso ele precisa ter em
   * mãos o que aquele boneco oferece — título, fala, objetivo e
   * prêmio — antes de alguém chegar perto.
   *
   * O que NÃO desce é o estado do jogador: se ele já pegou, se está
   * em cooldown, se a cadeia permite. Isso é do agente, e continua
   * sendo respondido no clique — ver `onAccept`.
   *
   * Elas entram no payload do `npc.set` em vez de num comando
   * próprio porque assim a impressão digital do `push` já as cobre:
   * mudar o título de uma missão reenvia o NPC dela sozinho.
   */
  #payloadOf(npc: QuestNpcRecord) {
    return { ...toPayload(npc), offers: this.#offersOf(npc) };
  }

  #offersOf(npc: QuestNpcRecord): readonly QuestNpcOffer[] {
    // Um NPC de entrega não tem vitrine: ele existe para RECEBER o
    // pacote. É a mesma regra do serviço.
    if (npc.kind === 'delivery') {
      return [];
    }

    const offers: QuestNpcOffer[] = [];

    for (const quest of this.#deps.repository.listForServer(npc.serverId)) {
      if (quest.npcId !== npc.id || !quest.enabled) {
        continue;
      }

      const described = this.#deps.describeQuest?.(quest);

      offers.push({
        id: quest.id,
        title: quest.title,
        description: quest.description,
        goal: described?.goal ?? '',
        reward: described?.reward ?? '',
      });
    }

    return offers;
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
      } else if (push.kind === 'move') {
        this.#move(serverId, push);
      } else if (push.kind === 'remove') {
        this.#remove(serverId, push.npcId);
      } else if (push.kind === 'accept') {
        this.#accept(serverId, push);
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

  #move(serverId: string, push: Extract<NpcPush, { kind: 'move' }>): void {
    const npc = this.#deps.repository.getNpc(push.npcId);

    // A mesma conferência do `#use`, e pelo mesmo motivo: o id veio
    // do jogo, e um NPC de outro servidor não se move daqui.
    if (npc === null || npc.serverId !== serverId) {
      return;
    }

    this.#deps.repository.updateNpc(push.npcId, {
      ...npc,
      x: push.x,
      y: push.y,
      z: push.z,
      rotation: push.rotation,
    });

    this.forget(serverId);

    this.#deps.logger.info(
      { server: serverId, npc: push.npcId, x: push.x, z: push.z },
      'NPC de missão mudou de lugar',
    );
  }

  #remove(serverId: string, npcId: string): void {
    const npc = this.#deps.repository.getNpc(npcId);

    if (npc === null || npc.serverId !== serverId) {
      return;
    }

    // ####  APAGAR O NPC NÃO APAGA A QUEST DELE  ####
    //
    // É a mesma regra da rota do painel: o progresso de quem estava
    // fazendo não pode ir junto. A quest órfã volta ao menu — ver
    // `listOffers` no serviço.
    const orphaned = this.#deps.repository.questsOfNpc(npcId);

    this.#deps.repository.removeNpc(npcId);
    this.forget(serverId);

    this.#deps.logger.info(
      { server: serverId, npc: npcId, orphaned: orphaned.length },
      'NPC de missão apagado de dentro do jogo',
    );
  }

  #accept(serverId: string, push: Extract<NpcPush, { kind: 'accept' }>): void {
    const npc = this.#deps.repository.getNpc(push.npcId);

    // A mesma conferência do `#use`: um NPC de outro servidor não
    // entrega missão neste.
    if (npc === null || npc.serverId !== serverId || !npc.enabled) {
      return;
    }

    const quest = this.#deps.repository.get(push.questId);

    // ####  A MISSÃO TEM DE SER DAQUELE BONECO  ####
    //
    // Sem isto, um cliente adulterado pediria no NPC do lado de
    // casa a missão que só se pega do outro lado do mapa — e o
    // `accept` a concederia, porque o serviço confia no balcão.
    if (quest === null || quest.npcId !== npc.id) {
      this.#deps.logger.warn(
        { server: serverId, npc: npc.id, quest: push.questId },
        'o aceite pedia uma missão que não é deste NPC',
      );

      return;
    }

    this.#deps.logger.info(
      { server: serverId, npc: npc.id, quest: quest.id, steamId: push.steamId },
      'aceite pedido no balcão do NPC',
    );

    // O plugin mediu a distância no jogo, e é isso que a testemunha
    // significa. O que pode ou não ser aceito continua sendo do
    // serviço — ver `#whyNot`.
    this.#deps.onTalk?.({ serverId, steamId: push.steamId, npcId: npc.id });
    this.#deps.onAccept?.({
      serverId,
      steamId: push.steamId,
      npcId: npc.id,
      questId: quest.id,
    });
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

    // ####  ESTA LINHA É O QUE SE PROCURA NO CONSOLE  ####
    //
    // O TALK atravessa três pontos — o plugin grita, o agente lê, o
    // agente manda abrir — e, quando o jogador vê "não consegui
    // carregar essa página", só um deles falhou. Sem este registro,
    // descobrir qual exige instrumentar o servidor de produção.
    //
    // Se ela aparece, o grito chegou: o que falhou está adiante.
    // Se não aparece, o agente não está lendo o console daquele
    // servidor — e isso acontece quando o agente reinicia sem que o
    // servidor do jogo reinicie junto.
    this.#deps.logger.info(
      { server: serverId, npc: npc.id, steamId: push.steamId },
      'um jogador falou com o NPC de missão',
    );

    // ####  A TESTEMUNHA, E NADA MAIS  ####
    //
    // Ela é o que diferencia "chegou no boneco" de "pode pegar a
    // missão dele" — ver `#npcTalks` no serviço.
    //
    // Até 12/09/2026 este ponto também mandava o jogo ABRIR a tela
    // de missões daquele NPC. Não manda mais: a caixa de conversa é
    // desenhada pelo próprio plugin, com o que desceu no `npc.set`,
    // e por isso ela aparece no quadro seguinte ao TALK em vez de
    // depender de uma ida e uma volta pelo console.
    this.#deps.onTalk?.({ serverId, steamId: push.steamId, npcId: npc.id });
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

    const npcId = typeof body.npcId === 'string' && body.npcId !== '' ? body.npcId : null;

    if (body.kind === 'use') {
      return npcId !== null && typeof body.steamId === 'string' && /^\d{17}$/.test(body.steamId)
        ? { kind: 'use', steamId: body.steamId, npcId }
        : null;
    }

    if (body.kind === 'remove') {
      return npcId === null ? null : { kind: 'remove', npcId };
    }

    if (body.kind === 'accept') {
      return npcId !== null &&
        typeof body.steamId === 'string' &&
        /^\d{17}$/.test(body.steamId) &&
        typeof body.questId === 'string' &&
        body.questId !== ''
        ? { kind: 'accept', steamId: body.steamId, npcId, questId: body.questId }
        : null;
    }

    if (body.kind !== 'add' && body.kind !== 'move') {
      return null;
    }

    const numbers = ['x', 'y', 'z', 'rotation'] as const;

    for (const key of numbers) {
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
        return null;
      }
    }

    const place = {
      x: body.x as number,
      y: body.y as number,
      z: body.z as number,
      rotation: body.rotation as number,
    };

    if (body.kind === 'move') {
      return npcId === null ? null : { kind: 'move', npcId, ...place };
    }

    return typeof body.name === 'string' && body.name.trim() !== ''
      ? { kind: 'add', name: body.name.trim().slice(0, 60), ...place }
      : null;
  } catch {
    return null;
  }
}
