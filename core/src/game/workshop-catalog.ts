// ============================================================
//  workshop-catalog.ts  -  as regras do cadastro e da posse, num
//  lugar só.
//
//  ####  O PAINEL, O JOGO E O SITE PASSAM POR AQUI  ####
//
//  O pedido do dono é que "os cadastros feitos pelo jogo e pelo
//  painel utilizem os mesmos dados". Mesma tabela não basta: se o
//  painel conferisse a Steam e o jogo não, as duas portas
//  produziriam linhas de qualidade diferente. Por isso a rota HTTP
//  e o aviso `add` do plugin chamam os MESMOS métodos abaixo.
//
//  A posse vale o mesmo: o painel, a entrega do site (frente C) e o
//  `/skin give` do jogo chamam `grantOwnership`/`revokeOwnership`
//  DAQUI — que chamam a função única do repositório e registram.
//
//  ####  TODA MUDANÇA É REGISTRADA E AVISADA  ####
//
//  Cada método que escreve grava uma linha no registro
//  (`workshop_audit`) e avisa: `onChange` reenvia o catálogo para os
//  servidores; `onOwnershipChange` reenvia a posse DAQUELE jogador,
//  onde ele estiver online. Esquecer o aviso é a skin que aparece na
//  tela e não existe no jogo.
//
//  As recusas saem como `ApiError`, com a frase pronta: a rota as
//  repassa, e o jogo mostra a mesma frase no chat do admin.
// ============================================================

import type { ItemsRepository } from '../db/items-repository.js';
import {
  FavoritesFullError,
  isOwnedLive,
  type FavoriteResult,
  type WorkshopOwnedRepository,
} from '../db/workshop-owned-repository.js';
import type { WorkshopSkinsRepository } from '../db/workshop-repository.js';
import { ApiError } from '../http/error-response.js';
import {
  grantOwnershipInputSchema,
  MAX_FAVORITES_PER_PLAYER,
  revokeOwnershipInputSchema,
  type GrantOwnershipInput,
  type OwnedSkin,
  type OwnedSource,
  type RevokeOwnershipInput,
  type WorkshopAuditSource,
  type WorkshopSkin,
  type WorkshopSkinBody,
  type WorkshopSkinInput,
} from '../types/workshop.js';
import { judgeWorkshopFile, type WorkshopFileDetails, type WorkshopLookupFn } from './steam-workshop.js';

/** Quem está mexendo. Vai para o registro. */
export interface WorkshopActor {
  /** Usuário do painel, `jogo:<steamId>`, `site:<ref>` ou `sistema`. */
  readonly name: string;
  readonly source: WorkshopAuditSource;
  /** O servidor de onde veio, quando veio do jogo. */
  readonly serverId?: string | null;
}

export interface WorkshopCatalogDeps {
  readonly skins: WorkshopSkinsRepository;
  readonly owned: WorkshopOwnedRepository;
  readonly items: Pick<ItemsRepository, 'get' | 'state' | 'shortnamesByDisplayName'>;
  readonly serverIds: () => readonly string[];
  readonly lookup: WorkshopLookupFn;
  /** O catálogo mudou: reenviar a carga. */
  readonly onChange: () => void;
  /**
   * A posse DESTE jogador mudou: reenviar a dele, onde ele estiver.
   * Opcional para o teste que só mexe no cadastro.
   */
  readonly onOwnershipChange?: (steamId: string) => void;
}

export interface SavedSkin {
  readonly skin: WorkshopSkin;
  /** A Steam não respondeu, ou algo parecido. A tela mostra. */
  readonly warning: string | null;
}

/**
 * O pedido de `WorkshopCatalog.grantOwnership`.
 *
 * É o que a frente C (entrega do site) chama:
 *
 *     catalog.grantOwnership({
 *       steamId, skinRef: skin.id, days,          // days null = permanente
 *       source: 'site', sourceRef: 'DLV-…',
 *       createdBy: 'site:order:1234',
 *     })
 *
 * `serverId` só entra no registro (o `/skin give` do jogo).
 */
export type GrantOwnershipRequest = GrantOwnershipInput & { readonly serverId?: string | null };

/** O pedido de `WorkshopCatalog.revokeOwnership`. Ver `GrantOwnershipRequest`. */
export type RevokeOwnershipRequest = RevokeOwnershipInput & { readonly serverId?: string | null };

/** O desfecho de `WorkshopCatalog.removeSeasonOwnership`. */
export interface SeasonCleared {
  /** Quantas LINHAS de posse saíram. */
  readonly removed: number;
  /** Os SteamIDs afetados, sem repetir. */
  readonly players: readonly string[];
}

export interface GrantedOwnership {
  readonly owned: OwnedSkin;
  /** `true` quando não havia posse viva antes. */
  readonly created: boolean;
  readonly skin: WorkshopSkin;
}

/** O índice único do SQLite, que chega como texto. */
function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message);
}

function describeSkin(skin: Pick<WorkshopSkin, 'id' | 'label' | 'shortname'>): string {
  return `skin #${String(skin.id)} "${skin.label}" (${skin.shortname})`;
}

/** A origem da posse vista pelo registro, que tem menos categorias. */
function auditSourceOf(source: OwnedSource): WorkshopAuditSource {
  switch (source) {
    case 'site':
      return 'site';
    case 'panel':
      return 'panel';
    case 'game':
      return 'game';
    default:
      return 'system';
  }
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

    // A posse desce filtrada pelo catálogo do servidor: ligar a skin
    // ou pô-la num servidor muda a carga de posse de quem já a tem.
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

    // As posses caem na cascata; o registro diz de quem eram. Sem
    // isso, "comprei e sumiu" não teria resposta.
    const owners = this.#deps.owned
      .listOwned({ skinRef: id, limit: 1000 })
      .owned.map((owned) => ({ steamId: owned.steamId, expiresAt: owned.expiresAt, source: owned.source }));

    this.#deps.skins.remove(id);
    this.#log(actor, 'skin.delete', describeSkin(current), {
      workshopId: current.skinId,
      ownersRemoved: owners,
    });
    this.#deps.onChange();
  }

  /**
   * A skin pela chave natural `(shortname, workshopId)`.
   *
   * É como a entrega do site (04 §3) e o `/skin give` do jogo acham a
   * skin: o `id` interno não viaja para fora do agente.
   */
  findSkinByMark(shortname: string, workshopId: string): WorkshopSkin | null {
    return this.#deps.skins.findByMark(shortname.trim().toLowerCase(), workshopId.trim());
  }

  // ======================================================
  //  POSSE
  // ======================================================

  /**
   * Dá a skin ao jogador — ou renova. A regra do prazo está em
   * `renewedExpiry` (db/workshop-owned-repository.ts).
   *
   * NÃO exige a skin ligada nem num servidor: o jogador pagou, e
   * desligar é decisão de operação (04 §3). A posse passa a valer
   * quando a skin voltar.
   *
   * @throws ApiError `WORKSHOP_SKIN_NOT_FOUND` (404) quando a skin não
   *         existe; `OWNED_ALREADY_EXPIRED` (400) quando a data pedida
   *         já passou; `INVALID_OWNERSHIP` (400) quando a entrada não
   *         passa na régua.
   */
  grantOwnership(request: GrantOwnershipRequest, now: number = Date.now()): GrantedOwnership {
    const parsed = grantOwnershipInputSchema.safeParse(request);

    if (!parsed.success) {
      throw new ApiError(
        'INVALID_OWNERSHIP',
        parsed.error.issues[0]?.message ?? 'Pedido de posse inválido.',
        400,
      );
    }

    const value = parsed.data;
    const skin = this.#mustGetSkin(value.skinRef);

    if (value.expiresAt !== null && value.expiresAt !== undefined && value.expiresAt <= now) {
      throw new ApiError(
        'OWNED_ALREADY_EXPIRED',
        'O prazo escolhido já passou: essa posse nasceria vencida e não liberaria nada.',
        400,
      );
    }

    const { owned, created, previous } = this.#deps.owned.grantOwnership(value, now);

    this.#deps.owned.log(
      {
        actor: value.createdBy,
        source: auditSourceOf(value.source),
        action: 'owned.grant',
        target: describeSkin(skin),
        serverId: request.serverId ?? null,
        steamId: value.steamId,
        detail: {
          ownedId: owned.id,
          workshopId: skin.skinId,
          source: value.source,
          ...(value.sourceRef === null || value.sourceRef === undefined ? {} : { sourceRef: value.sourceRef }),
          days: value.days ?? null,
          requestedExpiresAt: value.expiresAt ?? null,
          before: previous === null ? null : { expiresAt: previous.expiresAt, live: isOwnedLive(previous, now) },
          expiresAt: owned.expiresAt,
          created,
          ...(value.note === null ? {} : { note: value.note }),
        },
      },
      now,
    );

    this.#deps.onOwnershipChange?.(value.steamId);

    return { owned, created, skin };
  }

  /**
   * Tira a posse daquele par, qualquer que seja a origem.
   *
   * Sem posse para tirar NÃO é erro (04 §3: o `skin_revoke` pode ser
   * reexecutado): devolve `null`, e o registro diz `removed: false`.
   *
   * @throws ApiError `INVALID_OWNERSHIP` (400) quando a entrada não
   *         passa na régua.
   */
  revokeOwnership(request: RevokeOwnershipRequest, now: number = Date.now()): OwnedSkin | null {
    const parsed = revokeOwnershipInputSchema.safeParse(request);

    if (!parsed.success) {
      throw new ApiError(
        'INVALID_OWNERSHIP',
        parsed.error.issues[0]?.message ?? 'Pedido de remoção de posse inválido.',
        400,
      );
    }

    const value = parsed.data;
    const removed = this.#deps.owned.revokeOwnership(value);

    this.#logRevoke(value, removed, request.serverId ?? null, now);

    if (removed !== null) this.#deps.onOwnershipChange?.(value.steamId);

    return removed;
  }

  /**
   * Tira pelo id da linha — o botão Remover do painel.
   *
   * @throws ApiError `OWNED_NOT_FOUND` (404).
   */
  revokeOwnershipById(id: number, actor: WorkshopActor, now: number = Date.now()): OwnedSkin {
    const removed = this.#deps.owned.removeById(id);

    if (removed === null) {
      throw new ApiError('OWNED_NOT_FOUND', `Nenhuma posse com o id ${String(id)}.`, 404);
    }

    this.#logRevoke(
      {
        steamId: removed.steamId,
        skinRef: removed.skinRef,
        source: actor.source === 'site' ? 'site' : actor.source === 'game' ? 'game' : 'panel',
        sourceRef: null,
        createdBy: actor.name,
      },
      removed,
      actor.serverId ?? null,
      now,
    );
    this.#deps.onOwnershipChange?.(removed.steamId);

    return removed;
  }

  #logRevoke(
    value: {
      readonly steamId: string;
      readonly skinRef: number;
      readonly source: OwnedSource;
      readonly sourceRef?: string | null | undefined;
      readonly createdBy: string;
    },
    removed: OwnedSkin | null,
    serverId: string | null,
    now: number,
  ): void {
    const skin = this.#deps.skins.get(value.skinRef);

    this.#deps.owned.log(
      {
        actor: value.createdBy,
        source: auditSourceOf(value.source),
        action: 'owned.revoke',
        target: skin === null ? `skin #${String(value.skinRef)}` : describeSkin(skin),
        serverId,
        steamId: value.steamId,
        detail: {
          removed: removed !== null,
          ...(removed === null
            ? {}
            : {
                ownedId: removed.id,
                expiresAt: removed.expiresAt,
                grantedBy: removed.createdBy,
                grantedSource: removed.source,
              }),
          ...(value.sourceRef === null || value.sourceRef === undefined ? {} : { sourceRef: value.sourceRef }),
        },
      },
      now,
    );
  }

  // ======================================================
  //  FAVORITAS (02 §5.4)
  // ======================================================

  /**
   * Põe a favorita no estado pedido, e reenvia a carga do jogador.
   *
   * ####  NÃO VAI PARA O REGISTRO  ####
   *
   * Favoritar é preferência de tela, e o jogador pode clicar dez vezes
   * em dez segundos. O 02 §6.2 já deixou "aplicar" fora da auditoria
   * pelo mesmo motivo: é uso, não configuração.
   *
   * @throws ApiError `WORKSHOP_SKIN_NOT_FOUND` (404) quando a skin não
   *         existe; `FAVORITES_FULL` (409) no teto de
   *         {@link MAX_FAVORITES_PER_PLAYER}.
   */
  setFavorite(steamId: string, skinRef: number, on: boolean, now: number = Date.now()): FavoriteResult {
    this.#mustGetSkin(skinRef);

    let result: FavoriteResult;

    try {
      result = this.#deps.owned.setFavorite(steamId, skinRef, on, now);
    } catch (cause) {
      if (cause instanceof FavoritesFullError) {
        throw new ApiError(
          'FAVORITES_FULL',
          `Você já tem ${String(MAX_FAVORITES_PER_PLAYER)} skins favoritas. ` +
            'Desfavorite uma antes de marcar outra.',
          409,
        );
      }

      throw cause;
    }

    // A favorita desce na carga da posse: sem o aviso, a estrela some
    // no próximo redesenho do menu (o plugin troca o conjunto inteiro
    // quando a carga chega).
    if (result.changed) this.#deps.onOwnershipChange?.(steamId);

    return result;
  }

  /** Inverte a favorita. Ver `setFavorite` para as recusas. */
  toggleFavorite(steamId: string, skinRef: number, now: number = Date.now()): FavoriteResult {
    return this.setFavorite(steamId, skinRef, !this.#deps.owned.isFavorite(steamId, skinRef), now);
  }

  // ======================================================
  //  A TEMPORADA (02 §4.6)
  // ======================================================

  /**
   * Apaga a posse de TODA skin marcada "Skin de temporada".
   *
   * ####  É A FRENTE DO WIPE QUEM CHAMA, E SÓ QUANDO ELE MANDAR  ####
   *
   * A marca `season` não faz nada sozinha: "por padrão não é
   * removida" (decisão do dono, 17/09/2026). Este método é o gatilho,
   * e ele não decide nada — quem decide é quem o chama.
   *
   * `serverId` só entra no REGISTRO, como no `grantOwnership`: a posse
   * é da rede inteira (02 §4.2) e sai inteira. Passar o servidor do
   * wipe é o que deixa o registro dizer de onde veio a ordem.
   *
   * Uma linha de auditoria só (`owned.season-cleared`), com a
   * contagem — e não uma por jogador: um wipe com 3.000 posses de
   * temporada encheria a tela do registro e esconderia tudo o mais que
   * aconteceu naquele dia. Quem tinha o quê está em cada
   * `owned.grant`, que continua lá.
   *
   * @returns quantas linhas saíram e de quem — a lista é para quem
   *          quiser avisar o jogador; o reenvio da posse deste método
   *          já foi feito.
   */
  removeSeasonOwnership(serverId?: string | null, now: number = Date.now()): SeasonCleared {
    const removed = this.#deps.owned.deleteSeasonOwned();
    const players = [...new Set(removed.map((owned) => owned.steamId))];
    const skins = [...new Set(removed.map((owned) => owned.skinRef))].sort((a, b) => a - b);

    this.#deps.owned.log(
      {
        actor: 'sistema',
        source: 'system',
        action: 'owned.season-cleared',
        target: 'posse de skins de temporada',
        serverId: serverId ?? null,
        steamId: null,
        detail: { removed: removed.length, players: players.length, skins },
      },
      now,
    );

    // Quem estiver online perde a skin da carga agora; quem está fora
    // recebe a carga nova quando entrar.
    for (const steamId of players) {
      this.#deps.onOwnershipChange?.(steamId);
    }

    return { removed: removed.length, players };
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
   * limite é do menu do jogador — ele é cortado, não recusado.
   */
  #labelFor(body: WorkshopSkinBody, details: WorkshopFileDetails | null): string {
    if (body.label !== '') return body.label;

    const title = details?.title.trim() ?? '';

    if (title !== '') return title.slice(0, 60);

    const item = this.#deps.items.get(body.shortname);

    return `${item?.displayName ?? body.shortname} ${body.skinId}`.slice(0, 60);
  }

  #mustGetSkin(id: number): WorkshopSkin {
    const skin = this.#deps.skins.get(id);

    if (skin === null) throw this.#skinNotFound(id);

    return skin;
  }

  #skinNotFound(id: number): ApiError {
    return new ApiError('WORKSHOP_SKIN_NOT_FOUND', `Nenhuma skin com o id ${String(id)}.`, 404);
  }

  #log(
    actor: WorkshopActor,
    action: string,
    target: string,
    detail: Record<string, unknown>,
    steamId: string | null = null,
  ): void {
    this.#deps.owned.log({
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
    if (key === 'updatedAt' || key === 'createdAt') continue;

    const from = before[key];
    const to = after[key];

    if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
  }

  return changed;
}
