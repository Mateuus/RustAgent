// ============================================================
//  workshop-catalog.ts  -  as regras do cadastro, num lugar só.
//
//  ####  O PAINEL E O `/skin add` PASSAM POR AQUI  ####
//
//  O pedido do dono é que "os cadastros feitos pelo jogo e pelo
//  painel utilizem os mesmos dados". Mesma tabela não basta: se o
//  painel conferisse a Steam e o jogo não, as duas portas
//  produziriam linhas de qualidade diferente. Por isso a rota HTTP
//  e o aviso `add` do plugin chamam os MESMOS métodos abaixo.
//
//  ####  TODA MUDANÇA É REGISTRADA E AVISADA  ####
//
//  Cada método que escreve grava uma linha no registro
//  (`workshop_audit`) e chama `onChange`, que é o reenvio da carga
//  para os servidores. Esquecer o segundo é a skin que aparece na
//  tela e não existe no jogo.
//
//  As recusas saem como `ApiError`, com a frase pronta: a rota as
//  repassa, e o jogo mostra a mesma frase no chat do admin.
// ============================================================

import type { ItemsRepository } from '../db/items-repository.js';
import type { WorkshopAccessRepository } from '../db/workshop-access-repository.js';
import type { WorkshopSkinsRepository } from '../db/workshop-repository.js';
import { ApiError } from '../http/error-response.js';
import {
  type WorkshopAuditSource,
  type WorkshopCollection,
  type WorkshopCollectionInput,
  type WorkshopGrant,
  type WorkshopGrantInput,
  type WorkshopSkin,
  type WorkshopSkinBody,
  type WorkshopSkinInput,
} from '../types/workshop.js';
import { judgeWorkshopFile, type WorkshopFileDetails, type WorkshopLookupFn } from './steam-workshop.js';

/** Quem está mexendo. Vai para o registro. */
export interface WorkshopActor {
  /** Usuário do painel, `jogo:<steamId>` ou `sistema`. */
  readonly name: string;
  readonly source: WorkshopAuditSource;
  /** O servidor de onde veio, quando veio do jogo. */
  readonly serverId?: string | null;
}

export interface WorkshopCatalogDeps {
  readonly skins: WorkshopSkinsRepository;
  readonly access: WorkshopAccessRepository;
  readonly items: Pick<ItemsRepository, 'get' | 'state' | 'shortnamesByDisplayName'>;
  readonly serverIds: () => readonly string[];
  readonly lookup: WorkshopLookupFn;
  /** O catálogo mudou: reenviar a carga. */
  readonly onChange: () => void;
}

export interface SavedSkin {
  readonly skin: WorkshopSkin;
  /** A Steam não respondeu, ou algo parecido. A tela mostra. */
  readonly warning: string | null;
}

/** O índice único do SQLite, que chega como texto. */
function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message);
}

function describeSkin(skin: Pick<WorkshopSkin, 'id' | 'label' | 'shortname'>): string {
  return `skin #${String(skin.id)} "${skin.label}" (${skin.shortname})`;
}

export class WorkshopCatalog {
  readonly #deps: WorkshopCatalogDeps;

  constructor(deps: WorkshopCatalogDeps) {
    this.#deps = deps;
  }

  // ======================================================
  //  SKINS
  // ======================================================

  async createSkin(body: WorkshopSkinBody, actor: WorkshopActor): Promise<SavedSkin> {
    this.#assertItem(body.shortname, actor);
    this.#assertFreeMark(body.shortname, body.skinId, null);
    this.#assertCollectionSlot(body.collectionId, body.shortname, null);
    this.#assertKnownServers(body.servers);

    const steam = await this.#checkSteam(body.skinId, body.shortname);
    const input: WorkshopSkinInput = { ...body, label: this.#labelFor(body, steam.details) };

    let skin: WorkshopSkin;

    try {
      skin = this.#deps.skins.add(input, {
        source: actor.source === 'game' ? 'game' : 'panel',
        createdBy: actor.name,
        workshopTitle: steam.details?.title ?? null,
        previewUrl: steam.details?.previewUrl ?? null,
      });
    } catch (cause) {
      // Dois cadastros da mesma marca ao mesmo tempo (o admin no jogo
      // e outro no painel): a conferência acima passou nos dois, e o
      // índice único segurou o segundo.
      if (isUniqueViolation(cause)) this.#assertFreeMark(body.shortname, body.skinId, null);
      throw cause;
    }

    this.#log(actor, 'skin.create', describeSkin(skin), {
      workshopId: skin.skinId,
      servers: skin.servers,
      ...(steam.warning === null ? {} : { warning: steam.warning }),
    });

    this.#deps.onChange();

    return { skin, warning: steam.warning };
  }

  async updateSkin(id: number, body: WorkshopSkinBody, actor: WorkshopActor): Promise<SavedSkin> {
    const current = this.#mustGetSkin(id);

    this.#assertItem(body.shortname, actor);
    this.#assertFreeMark(body.shortname, body.skinId, id);
    this.#assertCollectionSlot(body.collectionId, body.shortname, id);
    this.#assertKnownServers(body.servers);

    // A Steam só é consultada quando a MARCA mudou: reeditar o nome
    // de uma skin não pode falhar porque a Steam está lenta.
    const markChanged = current.skinId !== body.skinId || current.shortname !== body.shortname;
    const steam = markChanged
      ? await this.#checkSteam(body.skinId, body.shortname)
      : { details: null, warning: null };

    const input: WorkshopSkinInput = {
      ...body,
      label: body.label === '' ? current.label : body.label,
    };

    const saved = this.#deps.skins.update(
      id,
      input,
      markChanged
        ? { workshopTitle: steam.details?.title ?? null, previewUrl: steam.details?.previewUrl ?? null }
        : undefined,
    );

    if (saved === null) throw this.#skinNotFound(id);

    this.#log(actor, 'skin.update', describeSkin(saved), {
      changed: changedFields(current, saved),
    });

    this.#deps.onChange();

    return { skin: saved, warning: steam.warning };
  }

  setSkinServers(id: number, servers: readonly string[], actor: WorkshopActor): readonly string[] {
    const current = this.#mustGetSkin(id);

    this.#assertKnownServers(servers);

    const saved = this.#deps.skins.setServers(id, servers);

    if (saved === null) throw this.#skinNotFound(id);

    this.#log(actor, 'skin.servers', describeSkin(current), { before: current.servers, after: saved });
    this.#deps.onChange();

    return saved;
  }

  removeSkin(id: number, actor: WorkshopActor): void {
    const current = this.#mustGetSkin(id);

    // Os acessos caem na cascata; o registro diz quantos e de quem.
    const grants = this.#deps.access.listGrants({ targetType: 'skin', targetId: id });

    this.#deps.skins.remove(id);
    this.#log(actor, 'skin.delete', describeSkin(current), {
      workshopId: current.skinId,
      grantsRemoved: grants.map((grant) => `${grant.subjectType}:${grant.subject}`),
    });
    this.#deps.onChange();
  }

  // ======================================================
  //  COLEÇÕES
  // ======================================================

  createCollection(input: WorkshopCollectionInput, actor: WorkshopActor): WorkshopCollection {
    this.#assertFreeSlug(input.slug, null);

    const collection = this.#deps.skins.addCollection(input, actor.name);

    this.#log(actor, 'collection.create', `coleção "${collection.slug}"`, {
      label: collection.label,
      permission: collection.permission,
      openToAll: collection.openToAll,
    });
    this.#deps.onChange();

    return collection;
  }

  updateCollection(
    id: number,
    input: WorkshopCollectionInput,
    actor: WorkshopActor,
  ): WorkshopCollection {
    const current = this.#mustGetCollection(id);

    this.#assertFreeSlug(input.slug, id);

    const saved = this.#deps.skins.updateCollection(id, input);

    if (saved === null) throw this.#collectionNotFound(id);

    this.#log(actor, 'collection.update', `coleção "${saved.slug}"`, {
      changed: changedFields(current, saved),
    });
    this.#deps.onChange();

    return saved;
  }

  setCollectionSkins(
    id: number,
    skinIds: readonly number[],
    actor: WorkshopActor,
  ): readonly WorkshopSkin[] {
    const collection = this.#mustGetCollection(id);
    const wanted = [...new Set(skinIds)].map((skinId) => this.#mustGetSkin(skinId));

    // ####  UMA SKIN POR ITEM, E A FRASE DIZ QUAIS  ####
    //
    // O índice único também recusa, mas com "UNIQUE constraint
    // failed" — que não diz ao admin qual das máscaras tirar.
    const byItem = new Map<string, WorkshopSkin>();

    for (const skin of wanted) {
      const clash = byItem.get(skin.shortname);

      if (clash !== undefined) {
        throw new ApiError(
          'COLLECTION_ITEM_TAKEN',
          `"${clash.label}" e "${skin.label}" são as duas de "${skin.shortname}". Numa coleção ` +
            'cabe uma skin por item — é assim que o /skin sabe qual vestir.',
          409,
        );
      }

      byItem.set(skin.shortname, skin);
    }

    const before = this.#deps.skins.skinsOfCollection(id).map((skin) => skin.id);
    const saved = this.#deps.skins.setCollectionSkins(id, [...byItem.values()].map((skin) => skin.id));

    if (saved === null) throw this.#collectionNotFound(id);

    this.#log(actor, 'collection.skins', `coleção "${collection.slug}"`, {
      before,
      after: saved.map((skin) => skin.id),
    });
    this.#deps.onChange();

    return saved;
  }

  removeCollection(id: number, actor: WorkshopActor): void {
    const current = this.#mustGetCollection(id);

    const grants = this.#deps.access.listGrants({ targetType: 'collection', targetId: id });

    this.#deps.skins.removeCollection(id);
    this.#log(actor, 'collection.delete', `coleção "${current.slug}"`, {
      skinCount: current.skinCount,
      grantsRemoved: grants.map((grant) => `${grant.subjectType}:${grant.subject}`),
    });
    this.#deps.onChange();
  }

  // ======================================================
  //  ACESSOS
  // ======================================================

  grant(input: WorkshopGrantInput, actor: WorkshopActor, now: number = Date.now()): WorkshopGrant {
    if (input.expiresAt !== null && input.expiresAt <= now) {
      throw new ApiError(
        'GRANT_ALREADY_EXPIRED',
        'O prazo escolhido já passou: esse acesso nasceria vencido e não liberaria nada.',
        400,
      );
    }

    const target = this.#describeTarget(input.targetType, input.targetId);
    const { grant, created } = this.#deps.access.upsertGrant(input, actor.name, now);

    this.#log(
      actor,
      created ? 'grant.create' : 'grant.update',
      target,
      {
        grantId: grant.id,
        subjectType: grant.subjectType,
        subject: grant.subject,
        expiresAt: grant.expiresAt,
        ...(grant.note === '' ? {} : { note: grant.note }),
      },
      grant.subjectType === 'player' ? grant.subject : null,
    );
    this.#deps.onChange();

    return grant;
  }

  revoke(id: number, actor: WorkshopActor): void {
    const grant = this.#deps.access.getGrant(id);

    if (grant === null) {
      throw new ApiError('GRANT_NOT_FOUND', `Nenhum acesso com o id ${String(id)}.`, 404);
    }

    const target = this.#describeTargetLoose(grant.targetType, grant.targetId);

    this.#deps.access.removeGrant(id);
    this.#log(
      actor,
      'grant.revoke',
      target,
      { grantId: id, subjectType: grant.subjectType, subject: grant.subject, expiresAt: grant.expiresAt },
      grant.subjectType === 'player' ? grant.subject : null,
    );
    this.#deps.onChange();
  }

  // ======================================================
  //  Conferências
  // ======================================================

  /**
   * O item base precisa existir nesta versão do jogo.
   *
   * Com o catálogo de itens VAZIO (instalação que nunca varreu o
   * jogo), a conferência do jogo é a que vale: o plugin já testou o
   * shortname no `ItemManager` antes de mandar o `/skin add`. Pelo
   * painel, sem catálogo, não há como conferir — e recusar seria
   * travar a primeira instalação.
   */
  #assertItem(shortname: string, actor: WorkshopActor): void {
    if (this.#deps.items.state().total === 0) return;
    if (this.#deps.items.get(shortname) !== null) return;

    throw new ApiError(
      'UNKNOWN_BASE_ITEM',
      `Nenhum item do jogo com o shortname "${shortname}".` +
        (actor.source === 'game'
          ? ' O catálogo de itens do agente pode estar velho: rode a varredura de itens.'
          : ' A skin é uma aparência para um item que o Rust já tem — escolha um da lista.'),
      400,
    );
  }

  #assertFreeMark(shortname: string, skinId: string, currentId: number | null): void {
    const clash = this.#deps.skins.findByMark(shortname, skinId);

    if (clash === null || clash.id === currentId) return;

    throw new ApiError(
      'DUPLICATE_MARK',
      `O Workshop ID ${skinId} em "${shortname}" já está cadastrado como "${clash.label}" ` +
        `(#${String(clash.id)}).`,
      409,
    );
  }

  #assertCollectionSlot(collectionId: number | null, shortname: string, currentId: number | null): void {
    if (collectionId === null) return;

    const collection = this.#mustGetCollection(collectionId);
    const clash = this.#deps.skins
      .skinsOfCollection(collectionId)
      .find((skin) => skin.shortname === shortname && skin.id !== currentId);

    if (clash === undefined) return;

    throw new ApiError(
      'COLLECTION_ITEM_TAKEN',
      `A coleção "${collection.slug}" já tem "${clash.label}" para "${shortname}". Numa coleção ` +
        'cabe uma skin por item.',
      409,
    );
  }

  #assertFreeSlug(slug: string, currentId: number | null): void {
    const clash = this.#deps.skins.findCollectionBySlug(slug);

    if (clash === null || clash.id === currentId) return;

    throw new ApiError('DUPLICATE_COLLECTION', `Já existe a coleção "/skin ${slug}".`, 409);
  }

  #assertKnownServers(servers: readonly string[]): void {
    const known = new Set(this.#deps.serverIds());
    const unknown = servers.filter((id) => !known.has(id));

    if (unknown.length > 0) {
      throw new ApiError('UNKNOWN_SERVER', `Estes servidores não existem: ${unknown.join(', ')}.`, 400);
    }
  }

  async #checkSteam(
    skinId: string,
    shortname: string,
  ): Promise<{ readonly details: WorkshopFileDetails | null; readonly warning: string | null }> {
    const verdict = judgeWorkshopFile(await this.#deps.lookup(skinId), shortname, (name) =>
      this.#deps.items.shortnamesByDisplayName(name),
    );

    if (!verdict.ok) throw new ApiError(verdict.code, verdict.message, 400);

    return { details: verdict.details, warning: verdict.warning };
  }

  /**
   * O nome: o digitado; senão o título do Workshop; senão o item.
   *
   * O título da Steam passa de 60 caracteres com frequência, e o
   * limite é da caixa do jogador — ele é cortado, não recusado.
   */
  #labelFor(body: WorkshopSkinBody, details: WorkshopFileDetails | null): string {
    if (body.label !== '') return body.label;

    const title = details?.title.trim() ?? '';

    if (title !== '') return title.slice(0, 60);

    const item = this.#deps.items.get(body.shortname);

    return `${item?.displayName ?? body.shortname} ${body.skinId}`.slice(0, 60);
  }

  #describeTarget(type: 'skin' | 'collection', id: number): string {
    if (type === 'skin') return describeSkin(this.#mustGetSkin(id));

    return `coleção "${this.#mustGetCollection(id).slug}"`;
  }

  /** O alvo de um acesso que já existe — cuja skin pode ter sumido. */
  #describeTargetLoose(type: 'skin' | 'collection', id: number): string {
    try {
      return this.#describeTarget(type, id);
    } catch {
      return `${type === 'skin' ? 'skin' : 'coleção'} #${String(id)}`;
    }
  }

  #mustGetSkin(id: number): WorkshopSkin {
    const skin = this.#deps.skins.get(id);

    if (skin === null) throw this.#skinNotFound(id);

    return skin;
  }

  #mustGetCollection(id: number): WorkshopCollection {
    const collection = this.#deps.skins.getCollection(id);

    if (collection === null) throw this.#collectionNotFound(id);

    return collection;
  }

  #skinNotFound(id: number): ApiError {
    return new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(id)}.`, 404);
  }

  #collectionNotFound(id: number): ApiError {
    return new ApiError('WORKSHOP_COLLECTION_NOT_FOUND', `Nenhuma coleção com o id ${String(id)}.`, 404);
  }

  #log(
    actor: WorkshopActor,
    action: string,
    target: string,
    detail: Record<string, unknown>,
    steamId: string | null = null,
  ): void {
    this.#deps.access.log({
      actor: actor.name,
      source: actor.source,
      action,
      target,
      serverId: actor.serverId ?? null,
      steamId,
      detail,
    });
  }
}

/** Os campos que mudaram, para o registro dizer o quê. */
function changedFields<T extends object>(before: T, after: T): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of Object.keys(after) as (keyof T & string)[]) {
    if (key === 'updatedAt' || key === 'createdAt' || key === 'skinCount') continue;

    const from = before[key];
    const to = after[key];

    if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
  }

  return changed;
}
