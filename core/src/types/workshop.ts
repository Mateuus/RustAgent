// ============================================================
//  workshop.ts  -  O CONTRATO DAS SKINS DO WORKSHOP.
//
//  ####  A SKIN É POSSE DO JOGADOR  ####
//
//  Decisão do dono em 17/09/2026 (Docs/OrigemZWorkshop/02). O
//  módulo tem dois setores:
//
//    CADASTRO   o catálogo de skins. Entra pelo painel OU pelo jogo
//               (`/skin add "item" "id"`), e os dois caminhos gravam
//               na MESMA tabela deste agente.
//    POSSE      quem tem qual skin. Entra pelo painel, pelo site
//               (venda e caixa) e pelo `/skin give` de admin — os
//               três pelo MESMO `grantOwnership`.
//
//  Coleções, permissão por skin e acesso por grupo do Oxide SAÍRAM
//  (migração 097).
//
//  ####  QUEM PODE APLICAR UMA SKIN  ####
//
//  Qualquer um dos caminhos abaixo libera — é um OU:
//
//    - a skin está "liberada para todos" (skin da casa);
//    - o jogador tem uma posse VIVA dela (sem prazo, ou prazo no
//      futuro);
//    - o jogador tem `origemzworkshop.admin`.
//
//  Em todos os casos a skin precisa estar ligada e vinculada ao
//  servidor. Quem decide é o PLUGIN, na hora; este arquivo descreve o
//  que desce para ele.
//
//  ####  `skinId` É TEXTO, E ISSO NÃO É PREGUIÇA  ####
//
//  Ele é um `UInt64` do jogo. Não cabe no inteiro com sinal do
//  SQLite e não cabe no `number` do JS sem perder precisão — um
//  arredondamento silencioso aqui daria uma skin que não existe, e
//  o jogo não reclama: desenha o item vanilla e segue.
// ============================================================

import { z } from 'zod';

/**
 * Quem vê e aplica todas as skins, e quem pode usar `/skin add` e
 * `/skin give`. Registrada pelo plugin no boot.
 */
export const WORKSHOP_ADMIN_PERMISSION = 'origemzworkshop.admin';

/** O app do Rust na Steam. Skin de outro jogo não desenha nada aqui. */
export const RUST_APP_ID = 252490;

/**
 * O teto do `UInt64` do jogo.
 *
 * `BigInt` porque este número não cabe em `number`: comparar como
 * ponto flutuante aceitaria valores acima do teto por
 * arredondamento, que é exatamente o erro que esta régua existe
 * para pegar.
 */
export const MAX_SKIN_ID = 18_446_744_073_709_551_615n;

/**
 * A marca, e a régua mais importante deste arquivo.
 *
 * Nunca zero, nunca com zero à esquerda (dois textos diferentes
 * para o mesmo número furariam o índice único da tabela), e nunca
 * acima do teto do `UInt64`.
 */
export const workshopSkinIdSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{0,19}$/, 'O Workshop ID é um número inteiro positivo, sem zero à esquerda.')
  .refine(
    (value) => BigInt(value) <= MAX_SKIN_ID,
    'O Workshop ID passa do teto de UInt64 do jogo (18446744073709551615).',
  );

/**
 * O shortname do item base, na régua do próprio jogo.
 *
 * NÃO é conferido contra o catálogo aqui: quem faz isso é a rota,
 * que tem a tabela `items` na mão.
 */
export const workshopShortnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'O shortname é o do jogo: minúsculas, dígitos, ponto e hífen.');

/** SteamID64 de conta de usuário: 17 dígitos começando por 7656. */
export const steamIdSchema = z
  .string()
  .trim()
  .regex(/^7656\d{13}$/, 'SteamID64 tem 17 dígitos e começa com 7656.');

/** De onde veio o cadastro. */
export const WORKSHOP_SKIN_SOURCES = ['panel', 'game'] as const;
export type WorkshopSkinSource = (typeof WORKSHOP_SKIN_SOURCES)[number];

/** A raridade: a cor da borda e o rótulo no menu (03). */
export const WORKSHOP_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type WorkshopRarity = (typeof WORKSHOP_RARITIES)[number];

/** O teto da descrição. A coluna só recusa o vazio. */
export const WORKSHOP_DESCRIPTION_MAX = 280;

// ------------------------------------------------------------
//  SKINS
// ------------------------------------------------------------

/**
 * Texto opcional: em branco vira `null`.
 *
 * A coluna recusa `''` (CHECK), e "sem descrição" tem UMA forma só —
 * senão o painel teria de tratar as duas.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === null || value === undefined || value === '' ? null : value));

/** Uma skin, como o admin a cadastra. */
export const workshopSkinInputSchema = z.object({
  /** "AK Brasa". É o nome que o jogador lê no menu. */
  label: z.string().trim().min(1, 'dê um nome à skin').max(60),

  /** O item do jogo que recebe a aparência: `rifle.ak`. */
  shortname: workshopShortnameSchema,

  /** O id publicado no Steam Workshop. Ver `workshopSkinIdSchema`. */
  skinId: workshopSkinIdSchema,

  /** O texto do painel de detalhe do menu. */
  description: optionalText(WORKSHOP_DESCRIPTION_MAX).default(null),

  /** `null` = sem raridade: o menu desenha a borda neutra. */
  rarity: z.enum(WORKSHOP_RARITIES).nullish().transform((value) => value ?? null).default(null),

  /** A ordem na grade do menu: menor primeiro; empate pelo nome. */
  sort: z.number().int().min(-1_000_000).max(1_000_000).default(0),

  /** Skin da casa: qualquer jogador aplica, sem posse. */
  openToAll: z.boolean().default(false),

  /**
   * A skin sai do item de quem está em modo streamer escondendo a
   * logo, e volta quando ele sai do ar.
   *
   * A proteção é do PORTADOR: o `skinID` viaja no item, e todo
   * mundo que olha o mesmo item vê a mesma coisa.
   */
  hideInStreamer: z.boolean().default(true),

  /** Desligada some do menu, sem perder o cadastro nem a posse. */
  enabled: z.boolean().default(true),

  /**
   * **Skin de temporada**: a posse dela PODE sair num wipe.
   *
   * É uma MARCA, e só. Nada no jogo muda por causa dela: o menu de
   * skins apenas informa (03 §3.5), e quem de fato apaga é o wipe,
   * chamando `WorkshopCatalog.removeSeasonOwnership`. `false` por
   * padrão — "por padrão não é removida" (decisão do dono, 17/09/2026).
   */
  season: z.boolean().default(false),

  /** Em que servidores ela vale. Vazio = em nenhum. */
  servers: z.array(z.string().min(1)).max(50).default([]),
});

export type WorkshopSkinInput = z.infer<typeof workshopSkinInputSchema>;

/**
 * O mesmo cadastro na borda HTTP, com o NOME opcional.
 *
 * Em branco, a rota o preenche com o título publicado no Workshop —
 * é o mesmo que o `/skin add` do jogo faz, e é o que mantém os dois
 * caminhos de cadastro produzindo a mesma linha.
 */
export const workshopSkinBodySchema = workshopSkinInputSchema.extend({
  label: z.string().trim().max(60).default(''),
});

export type WorkshopSkinBody = z.infer<typeof workshopSkinBodySchema>;

/** O que o repositório grava além do formulário. */
export interface WorkshopSkinMeta {
  readonly source: WorkshopSkinSource;
  /** Usuário do painel, ou `jogo:<steamId>`. */
  readonly createdBy: string | null;
  /** O título publicado no Workshop, quando a Steam respondeu. */
  readonly workshopTitle: string | null;
  readonly previewUrl: string | null;
}

export interface WorkshopSkin extends WorkshopSkinInput, WorkshopSkinMeta {
  readonly id: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  POSSE
// ------------------------------------------------------------

/**
 * De onde veio a ÚLTIMA escrita da posse.
 *
 *   site       venda ou caixa do site (entrega `skin`)
 *   panel      a ficha do jogador ou a aba Posse
 *   game       o `/skin give` de admin
 *   system     o próprio agente
 *   migration  a 097, a partir dos acessos da 096
 */
export const OWNED_SOURCES = ['site', 'panel', 'game', 'system', 'migration'] as const;
export type OwnedSource = (typeof OWNED_SOURCES)[number];

/** O teto do prazo em dias. O mesmo do contrato com o site (04 §3). */
export const OWNED_MAX_DAYS = 3650;

/** Uma posse, como ela está no banco. */
export interface OwnedSkin {
  readonly id: number;
  readonly steamId: string;
  /** O `id` da skin NESTE agente (`workshop_skins.id`). */
  readonly skinRef: number;
  /** Epoch ms, ou `null` para permanente. */
  readonly expiresAt: number | null;
  readonly source: OwnedSource;
  /** O `DLV-…` da entrega do site; `null` nas outras origens. */
  readonly sourceRef: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * O pedido de dar uma skin — a entrada ÚNICA do `grantOwnership`.
 *
 * `days` e `expiresAt` são exclusivos; sem nenhum dos dois, a posse é
 * permanente. A tabela de renovação está no 02 §4.2 e no repositório
 * (`db/workshop-owned-repository.ts`).
 */
export const grantOwnershipInputSchema = z
  .object({
    steamId: steamIdSchema,
    skinRef: z.number().int().positive(),
    /** Soma ao prazo vivo (ou conta de agora). `null` = permanente. */
    days: z.number().int().min(1).max(OWNED_MAX_DAYS).nullish(),
    /** Data absoluta, epoch ms. Nunca encurta um prazo maior. */
    expiresAt: z.number().int().positive().nullish(),
    source: z.enum(OWNED_SOURCES),
    sourceRef: z.string().trim().min(1).max(120).nullish(),
    note: optionalText(200),
    /** Quem deu: usuário do painel, `site:<ref>`, `jogo:<nome>`. */
    createdBy: z.string().trim().min(1).max(120),
  })
  .refine((value) => !(isSet(value.days) && isSet(value.expiresAt)), {
    message: 'Mande dias OU data de vencimento, não os dois.',
    path: ['days'],
  });

export type GrantOwnershipInput = z.input<typeof grantOwnershipInputSchema>;
export type GrantOwnershipValue = z.output<typeof grantOwnershipInputSchema>;

function isSet(value: number | null | undefined): boolean {
  return value !== null && value !== undefined;
}

/** O pedido de tirar uma skin. Tira a linha inteira, qualquer origem. */
export const revokeOwnershipInputSchema = z.object({
  steamId: steamIdSchema,
  skinRef: z.number().int().positive(),
  source: z.enum(OWNED_SOURCES),
  sourceRef: z.string().trim().min(1).max(120).nullish(),
  createdBy: z.string().trim().min(1).max(120),
});

export type RevokeOwnershipInput = z.input<typeof revokeOwnershipInputSchema>;

/**
 * `POST /workshop/owned`, como o painel o manda.
 *
 * `skinId` aqui é o NOSSO id (o mesmo do `:skinId` das rotas de
 * skin), e não o do Workshop. `expiresAt` aceita ISO ou epoch ms.
 */
export const ownedGrantBodySchema = z
  .object({
    steamId: steamIdSchema,
    skinId: z.number().int().positive(),
    days: z.number().int().min(1).max(OWNED_MAX_DAYS).nullish(),
    expiresAt: z
      .union([z.string().datetime({ offset: true }), z.number().int().positive(), z.null()])
      .optional()
      .transform((value) => (value === null || value === undefined ? null : new Date(value).getTime())),
    note: optionalText(200),
  })
  .refine((value) => !(isSet(value.days) && value.expiresAt !== null), {
    message: 'Mande dias OU data de vencimento, não os dois.',
    path: ['days'],
  });

export type OwnedGrantBody = z.infer<typeof ownedGrantBodySchema>;

/**
 * `GET /workshop/owned`. Uma das duas chaves é obrigatória: a lista
 * da rede inteira não é uma tela, é uma exportação.
 */
export const ownedListQuerySchema = z
  .object({
    steamId: steamIdSchema.optional(),
    skinId: z.coerce.number().int().positive().optional(),
    /** O `id` da última linha da página anterior. */
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    includeExpired: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  })
  .refine((value) => value.steamId !== undefined || value.skinId !== undefined, {
    message: 'Informe steamId ou skinId.',
    path: ['steamId'],
  });

export type OwnedListQuery = z.infer<typeof ownedListQuerySchema>;

// ------------------------------------------------------------
//  FAVORITAS
// ------------------------------------------------------------

/**
 * O teto de favoritas por jogador.
 *
 * O MESMO número do `MaxFavoritesPerPlayer` do plugin: a tela recusa
 * o 201º clique e o agente também. Sem teto, um script de console
 * marcaria o catálogo inteiro e a carga da posse cresceria sem fim.
 */
export const MAX_FAVORITES_PER_PLAYER = 200;

/**
 * A favorita que o jogador marcou no menu, como o plugin a manda
 * (02 §5.4).
 *
 * ####  É `on`, E NÃO "alterna"  ####
 *
 * O plugin diz o estado que ele quer, e não "inverta". O console
 * repete linha em reconexão, e um "alterne" repetido desfaria o
 * clique do jogador em silêncio. Com `on`, mandar duas vezes é o
 * mesmo que mandar uma.
 *
 * Não tem `requestId`: não há resposta a entregar. A confirmação é a
 * própria carga da posse, que volta com as favoritas dentro.
 */
export const workshopFavoriteRequestSchema = z.object({
  kind: z.literal('fav'),
  secret: z.string().min(1),
  steamId: steamIdSchema,
  /** O `id` da skin NESTE agente (o mesmo `id` do `sync`). */
  skinId: z.number().int().positive(),
  on: z.boolean(),
});

export type WorkshopFavoriteRequest = z.infer<typeof workshopFavoriteRequestSchema>;

// ------------------------------------------------------------
//  REGISTRO
// ------------------------------------------------------------

/** `site` entrou na 097: a entrega do site grava aqui. */
export const WORKSHOP_AUDIT_SOURCES = ['panel', 'game', 'system', 'site'] as const;
export type WorkshopAuditSource = (typeof WORKSHOP_AUDIT_SOURCES)[number];

export interface WorkshopAuditInput {
  /** Quem fez: usuário do painel, `jogo:<steamId>`, `site:<ref>` ou `sistema`. */
  readonly actor: string;
  readonly source: WorkshopAuditSource;
  /** `skin.create`, `owned.grant`, `owned.expired`, `site.delivered`… */
  readonly action: string;
  /** "skin #12 AK Brasa (rifle.ak)"… */
  readonly target: string;
  readonly serverId?: string | null;
  /** O jogador AFETADO, quando há um. É por ele que a busca filtra. */
  readonly steamId?: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface WorkshopAuditEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly source: WorkshopAuditSource;
  readonly action: string;
  readonly target: string;
  readonly serverId: string | null;
  readonly steamId: string | null;
  readonly detail: Record<string, unknown>;
}

// ------------------------------------------------------------
//  O QUE ATRAVESSA O CONSOLE (02 §5)
// ------------------------------------------------------------

/**
 * Uma skin dentro do `origemz.workshop.sync`.
 *
 * Os nomes são PROTOCOLO com o `OrigemZWorkshop.cs`: mudar um lado
 * sem o outro é o modo parar de funcionar em silêncio.
 *
 * `description` e `rarity` FALTAM (e não vão como `null`) quando não
 * há valor — o 02 §5.1 diz "pode faltar".
 */
export interface WorkshopPayloadSkin {
  readonly id: number;
  readonly label: string;
  readonly shortname: string;
  /** Texto, sempre. Ver o cabeçalho. */
  readonly skinId: string;
  readonly description?: string;
  readonly rarity?: WorkshopRarity;
  readonly sort: number;
  readonly openToAll: boolean;
  readonly hideInStreamer: boolean;
  /**
   * "Skin de temporada" (02 §4.6).
   *
   * Vai SEMPRE, como os outros dois booleanos — e não "pode faltar"
   * como a descrição: o menu desenha uma linha por causa dela, e um
   * campo ausente viraria "não é de temporada" num plugin velho, que
   * é justamente a leitura errada que custa caro.
   */
  readonly season: boolean;
}

/**
 * O catálogo daquele servidor. NUNCA um delta, e sem posse: a posse
 * desce por jogador, no `origemz.workshop.owned`.
 */
export interface WorkshopPayload {
  /** O segredo desta sessão do agente. Ver game/workshop.ts. */
  readonly secret: string;
  readonly skins: readonly WorkshopPayloadSkin[];
  /**
   * Quem está escondendo a LOGO neste instante. SteamIDs em texto:
   * 17 dígitos passam de 2^53.
   */
  readonly streamers: readonly string[];
  /** O texto do cadeado (03 §5). Falta quando não configurado. */
  readonly storeUrl?: string;
}

/** Uma posse dentro do `origemz.workshop.owned`. */
export interface WorkshopOwnedPayloadSkin {
  /** O `id` da skin no catálogo (o mesmo `id` do sync). */
  readonly id: number;
  /** Epoch ms; **0 = permanente**. */
  readonly expiresAt: number;
}

/**
 * A posse de UM jogador naquele servidor. Inteira, nunca delta; a
 * lista vazia é informação ("não tem nada") e é mandada.
 *
 * O `steamId` vai também no argumento do comando; aqui dentro ele é
 * a conferência de que os pedaços remontados são de quem o argumento
 * diz.
 */
export interface WorkshopOwnedPayload {
  readonly secret: string;
  readonly steamId: string;
  readonly skins: readonly WorkshopOwnedPayloadSkin[];
  /**
   * As favoritas dele, por `id` de skin do catálogo (02 §5.2).
   *
   * Vêm na MESMA carga da posse porque são a mesma pergunta ("o que é
   * deste jogador?") e porque o plugin troca os dois conjuntos de uma
   * vez: uma carga separada abriria a janela em que a posse é nova e a
   * favorita é velha.
   *
   * Inteira, nunca delta; ordenada por `id`; filtrada pelo catálogo
   * daquele servidor, como `skins`. **Pode vir vazia, e a lista vazia
   * é mandada.**
   */
  readonly favorites: readonly number[];
}

/** O que o `origemz.workshop.status` responde (plugin 0.3.0). */
export interface WorkshopStatus {
  readonly skins: number;
  /** Quantos jogadores têm posse carregada na memória do plugin. */
  readonly ownedPlayers: number;
  readonly streamers: number;
}

/**
 * O que o plugin grita no console.
 *
 *   ready    subiu e quer a carga. O ÚNICO sem segredo.
 *   applied  aplicou o catálogo; confirma quantas skins ficaram.
 *   add      um admin digitou `/skin add` no jogo.
 *   give     um admin digitou `/skin give` no jogo.
 *   fav      um jogador favoritou (ou desfavoritou) no menu.
 */
export const WORKSHOP_PUSH_KINDS = ['ready', 'applied', 'add', 'give', 'fav'] as const;
export type WorkshopPushKind = (typeof WORKSHOP_PUSH_KINDS)[number];

export interface WorkshopPush {
  readonly kind: string;
  /** Ausente só no `ready`. */
  readonly secret?: string;
  readonly count?: number;
  readonly message?: string;
}

/** O `/skin add` do jogo, como o plugin o manda. */
export const workshopAddRequestSchema = z.object({
  kind: z.literal('add'),
  secret: z.string().min(1),
  requestId: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
  steamId: steamIdSchema,
  playerName: z.string().max(64).default(''),
  shortname: z.string().max(120),
  skinId: z.string().max(40),
});

export type WorkshopAddRequest = z.infer<typeof workshopAddRequestSchema>;

/**
 * O `/skin give` do jogo (02 §7), como o plugin o manda.
 *
 * O plugin resolve o nome digitado para um SteamID antes de gritar:
 * `targetSteamId` é sempre o SteamID64. `steamId`/`playerName` são do
 * ADMIN que digitou, e é para ele que a resposta volta.
 */
export const workshopGiveRequestSchema = z.object({
  kind: z.literal('give'),
  secret: z.string().min(1),
  requestId: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
  steamId: steamIdSchema,
  playerName: z.string().max(64).default(''),
  targetSteamId: steamIdSchema,
  targetName: z.string().max(64).default(''),
  shortname: z.string().max(120),
  skinId: z.string().max(40),
  /** `null`/ausente = permanente. */
  days: z.number().int().min(1).max(OWNED_MAX_DAYS).nullish(),
});

export type WorkshopGiveRequest = z.infer<typeof workshopGiveRequestSchema>;

/** A resposta ao `/skin add` e ao `/skin give`, pelo `origemz.workshop.reply`. */
export interface WorkshopAddReply {
  readonly requestId: string;
  readonly steamId: string;
  readonly ok: boolean;
  readonly message: string;
}
