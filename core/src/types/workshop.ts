// ============================================================
//  workshop.ts  -  O CONTRATO DAS SKINS DO WORKSHOP.
//
//  ####  O JOGADOR ESCOLHE; NADA NASCE PINTADO  ####
//
//  Correção do dono em 16/09/2026, revogando a decisão da manhã do
//  mesmo dia ("o item já nasce com a skin"). O módulo agora tem
//  dois setores:
//
//    CADASTRO   o catálogo de skins e de coleções. Entra pelo
//               painel OU pelo jogo (`/skin add "item" "id"`), e os
//               dois caminhos gravam na MESMA tabela deste agente.
//    APLICAÇÃO  o jogador pinta o que já tem: pela caixa virtual
//               (`/skin`) ou por coleção (`/skin neve`). O item é
//               o MESMO objeto antes e depois — só o número muda.
//
//  Ver Docs/OrigemZWorkshop/01-CAIXA-E-COLECOES.md.
//
//  ####  QUEM PODE USAR UMA SKIN  ####
//
//  Qualquer um dos caminhos abaixo libera — é um OU, nunca um E:
//
//    - a skin (ou a coleção dela) está marcada "para todos";
//    - o jogador tem a permissão da skin, ou a da coleção dela;
//    - existe um acesso vivo (não vencido) para o jogador, ou para
//      um grupo Oxide dele, na skin ou na coleção dela;
//    - o jogador tem `origemzworkshop.admin`.
//
//  Quem decide é o PLUGIN, na hora: grupo e permissão do Oxide só
//  existem lá. Este arquivo descreve o que desce para ele.
//
//  ####  `skinId` É TEXTO, E ISSO NÃO É PREGUIÇA  ####
//
//  Ele é um `UInt64` do jogo. Não cabe no inteiro com sinal do
//  SQLite e não cabe no `number` do JS sem perder precisão — um
//  arredondamento silencioso aqui daria uma skin que não existe, e
//  o jogo não reclama: desenha o item vanilla e segue.
// ============================================================

import { z } from 'zod';

/** O prefixo obrigatório de toda permissão desta feature. */
export const WORKSHOP_PERMISSION_PREFIX = 'origemzworkshop.';

/**
 * Quem vê e aplica todas as skins, e quem pode usar `/skin add`.
 *
 * Registrada pelo plugin no boot, e não pelo catálogo: ela precisa
 * existir antes de o agente mandar a primeira carga, senão o admin
 * não consegue cadastrar a primeira skin pelo jogo.
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

/** Tira acento, baixa a caixa e troca o resto por hífen. */
export function slugify(value: string, max: number): string {
  return value
    .normalize('NFD')
    // U+0300–U+036F são os diacríticos que o NFD separou da letra.
    // Escritos como escape: um acento solto no código-fonte é
    // invisível no editor e vira outra coisa numa conversão.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

/**
 * A permissão, sempre no prefixo da feature.
 *
 * Quem digita "vip" no painel quer dizer `origemzworkshop.vip`;
 * quem digita o nome inteiro também está certo. É IDEMPOTENTE: o
 * repositório revalida o que já gravou, e uma segunda passada não
 * pode dobrar o prefixo.
 *
 * Diferente da versão anterior, a permissão NÃO é mais única por
 * skin: `origemzworkshop.vip` liberando vinte skins é justamente o
 * caso que o dono pediu.
 */
export function normalizePermission(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const suffix = trimmed.startsWith(WORKSHOP_PERMISSION_PREFIX)
    ? trimmed.slice(WORKSHOP_PERMISSION_PREFIX.length)
    : trimmed;
  const slug = slugify(suffix, 40);

  // Nome só de símbolos deixaria a permissão igual ao prefixo.
  return `${WORKSHOP_PERMISSION_PREFIX}${slug === '' ? 'skin' : slug}`;
}

/**
 * Permissão opcional: vazio vira `null`, o resto é normalizado.
 *
 * `null` quer dizer "esta linha não tem permissão própria" — e NÃO
 * "é de todo mundo". Quem abre para todos é o `openToAll`.
 */
export const optionalPermissionSchema = z
  .string()
  .trim()
  .max(80)
  .nullish()
  .transform((value) => (value === null || value === undefined || value === '' ? null : normalizePermission(value)));

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

/** De onde veio o cadastro. */
export const WORKSHOP_SKIN_SOURCES = ['panel', 'game'] as const;
export type WorkshopSkinSource = (typeof WORKSHOP_SKIN_SOURCES)[number];

// ------------------------------------------------------------
//  SKINS
// ------------------------------------------------------------

/** Uma skin, como o admin a cadastra. */
export const workshopSkinInputSchema = z.object({
  /** "Máscara OrigemZ". É por ele que o jogador escolhe na caixa. */
  label: z.string().trim().min(1, 'dê um nome à skin').max(60),

  /** O item do jogo que recebe a aparência: `metal.facemask`. */
  shortname: workshopShortnameSchema,

  /** O id publicado no Steam Workshop. Ver `workshopSkinIdSchema`. */
  skinId: workshopSkinIdSchema,

  /** Permissão própria, opcional. Ver `optionalPermissionSchema`. */
  permission: optionalPermissionSchema.default(null),

  /**
   * A coleção a que ela pertence, se alguma.
   *
   * Uma skin mora em UMA coleção. É o que deixa a coleção ser um
   * mapa `shortname → skin` sem ambiguidade: o índice único
   * `(collection_id, shortname)` recusa duas máscaras na "neve".
   */
  collectionId: z.number().int().positive().nullable().default(null),

  /** Qualquer jogador pode aplicar, sem permissão nem acesso. */
  openToAll: z.boolean().default(false),

  /**
   * A skin sai do item de quem está em modo streamer escondendo a
   * logo, e volta quando ele sai do ar.
   *
   * A proteção é do PORTADOR: o `skinID` viaja no item, e todo
   * mundo que olha o mesmo item vê a mesma coisa.
   */
  hideInStreamer: z.boolean().default(true),

  /** Desligada some da caixa e das coleções, sem perder o cadastro. */
  enabled: z.boolean().default(true),

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
//  COLEÇÕES
// ------------------------------------------------------------

/**
 * Palavras que o `/skin` já usa. Uma coleção com um destes nomes
 * nunca seria alcançada pelo jogador.
 */
export const RESERVED_COLLECTION_SLUGS: readonly string[] = [
  'add',
  'adicionar',
  'ajuda',
  'help',
  'lista',
  'list',
  'caixa',
  'box',
];

/**
 * O nome do comando: `/skin <slug>`.
 *
 * Minúsculo e sem acento porque o jogador digita no chat, e o
 * teclado de cada um é diferente.
 */
export const collectionSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,23}$/,
    'O comando tem até 24 letras minúsculas, dígitos, "-" ou "_", sem espaço e sem acento.',
  )
  .refine((value) => !RESERVED_COLLECTION_SLUGS.includes(value), {
    message: `Este nome já é um subcomando do /skin (${RESERVED_COLLECTION_SLUGS.join(', ')}).`,
  });

export const workshopCollectionInputSchema = z.object({
  /** `neve` → `/skin neve`. */
  slug: collectionSlugSchema,
  /** "Inverno 2026". É o que o jogador lê na resposta do comando. */
  label: z.string().trim().min(1, 'dê um nome à coleção').max(60),
  permission: optionalPermissionSchema.default(null),
  openToAll: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export type WorkshopCollectionInput = z.infer<typeof workshopCollectionInputSchema>;

export interface WorkshopCollection extends WorkshopCollectionInput {
  readonly id: number;
  /** Quantas skins do catálogo apontam para ela. */
  readonly skinCount: number;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A troca das skins de uma coleção, de uma vez. */
export const collectionSkinsBodySchema = z.object({
  skinIds: z.array(z.number().int().positive()).max(200),
});

// ------------------------------------------------------------
//  ACESSOS
// ------------------------------------------------------------

export const GRANT_SUBJECT_TYPES = ['player', 'group'] as const;
export type GrantSubjectType = (typeof GRANT_SUBJECT_TYPES)[number];

export const GRANT_TARGET_TYPES = ['skin', 'collection'] as const;
export type GrantTargetType = (typeof GRANT_TARGET_TYPES)[number];

/** SteamID64 de conta de usuário: 17 dígitos começando por 7656. */
export const steamIdSchema = z
  .string()
  .trim()
  .regex(/^7656\d{13}$/, 'SteamID64 tem 17 dígitos e começa com 7656.');

/** Grupo do Oxide: o nome como o `oxide.group add` o gravou. */
export const oxideGroupSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{1,64}$/, 'Grupo do Oxide: letras, dígitos, ".", "-" ou "_".');

/**
 * Um acesso, como o painel o pede.
 *
 * `expiresAt` nulo é PERMANENTE. Um prazo no passado é recusado:
 * gravar um acesso já vencido não faz nada no jogo, e o admin
 * acharia que liberou.
 */
export const workshopGrantBodySchema = z
  .object({
    subjectType: z.enum(GRANT_SUBJECT_TYPES),
    subject: z.string().trim().min(1),
    targetType: z.enum(GRANT_TARGET_TYPES),
    targetId: z.number().int().positive(),
    expiresAt: z
      .union([z.string().datetime({ offset: true }), z.number().int().positive(), z.null()])
      .default(null)
      .transform((value) => (value === null ? null : new Date(value).getTime())),
    note: z.string().trim().max(200).default(''),
  })
  .superRefine((value, ctx) => {
    const check = value.subjectType === 'player' ? steamIdSchema : oxideGroupSchema;
    const parsed = check.safeParse(value.subject);

    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: parsed.error.issues[0]?.message ?? 'quem recebe o acesso é inválido',
      });
    }
  })
  .transform((value) => ({
    ...value,
    subject: value.subjectType === 'group' ? value.subject.trim().toLowerCase() : value.subject.trim(),
  }));

export type WorkshopGrantInput = z.infer<typeof workshopGrantBodySchema>;

export interface WorkshopGrant extends WorkshopGrantInput {
  readonly id: number;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  REGISTRO
// ------------------------------------------------------------

export const WORKSHOP_AUDIT_SOURCES = ['panel', 'game', 'system'] as const;
export type WorkshopAuditSource = (typeof WORKSHOP_AUDIT_SOURCES)[number];

export interface WorkshopAuditInput {
  /** Quem fez: usuário do painel, `jogo:<steamId>` ou `sistema`. */
  readonly actor: string;
  readonly source: WorkshopAuditSource;
  /** `skin.create`, `grant.revoke`, `game.add-refused`… */
  readonly action: string;
  /** "skin #12 Máscara OrigemZ", "coleção neve"… */
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
//  O QUE ATRAVESSA O CONSOLE
// ------------------------------------------------------------

/**
 * Uma skin dentro do `origemz.workshop.sync`.
 *
 * Os nomes são PROTOCOLO com o `OrigemZWorkshop.cs`: mudar um lado
 * sem o outro é o modo parar de funcionar em silêncio. O `label`
 * viaja agora porque a caixa do jogador o mostra.
 */
export interface WorkshopPayloadSkin {
  readonly id: number;
  readonly label: string;
  readonly shortname: string;
  /** Texto, sempre. Ver o cabeçalho. */
  readonly skinId: string;
  readonly permission: string | null;
  readonly collectionId: number | null;
  readonly openToAll: boolean;
  readonly hideInStreamer: boolean;
}

export interface WorkshopPayloadCollection {
  readonly id: number;
  readonly slug: string;
  readonly label: string;
  readonly permission: string | null;
  readonly openToAll: boolean;
}

/**
 * Um acesso vivo.
 *
 * O prazo desce junto e o plugin confere na hora: o agente também
 * reenvia quando um vence, mas o jogador não pode ganhar uma janela
 * de minutos se o RCON estiver caído nesse instante.
 */
export interface WorkshopPayloadGrant {
  readonly subjectType: GrantSubjectType;
  readonly subject: string;
  readonly targetType: GrantTargetType;
  readonly targetId: number;
  /** Epoch ms, ou `null` para permanente. */
  readonly expiresAt: number | null;
}

/**
 * A carga completa. NUNCA um delta.
 *
 * Quem sumiu da lista some do jogo no instante em que a carga é
 * aplicada. Ela desce em PEDAÇOS quando passa do frame — ver
 * game/workshop.ts —, mas o plugin só troca o que tem quando o
 * último pedaço chega.
 */
export interface WorkshopPayload {
  /** O segredo desta sessão do agente. Ver game/workshop.ts. */
  readonly secret: string;
  readonly skins: readonly WorkshopPayloadSkin[];
  readonly collections: readonly WorkshopPayloadCollection[];
  readonly grants: readonly WorkshopPayloadGrant[];
  /**
   * Quem está escondendo a LOGO neste instante. SteamIDs em texto:
   * 17 dígitos passam de 2^53.
   */
  readonly streamers: readonly string[];
}

/** O que o `origemz.workshop.status` responde. */
export interface WorkshopStatus {
  readonly skins: number;
  readonly collections: number;
  readonly grants: number;
  readonly streamers: number;
  /** Caixas abertas agora, com item dentro ou não. */
  readonly openBoxes: number;
}

/**
 * O que o plugin grita no console.
 *
 *   ready    subiu e quer a carga. O ÚNICO sem segredo.
 *   applied  aplicou a carga; confirma quantas skins ficaram de pé.
 *   add      um admin digitou `/skin add` no jogo.
 */
export const WORKSHOP_PUSH_KINDS = ['ready', 'applied', 'add'] as const;
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

/** A resposta ao `/skin add`, pelo `origemz.workshop.reply`. */
export interface WorkshopAddReply {
  readonly requestId: string;
  readonly steamId: string;
  readonly ok: boolean;
  readonly message: string;
}
