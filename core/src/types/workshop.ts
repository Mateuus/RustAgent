// ============================================================
//  workshop.ts  -  O CONTRATO DO CATÁLOGO DE SKINS DO WORKSHOP.
//
//  ####  O ITEM JÁ NASCE COM A SKIN  ####
//
//  Decisão do dono em 16/09/2026: não há menu, não há comando de
//  aplicar e não há caixa de skin. Onde o jogo daria a pedra
//  vanilla, ele dá a pedra da OrigemZ — e quem decide isso é a
//  PERMISSÃO de quem vai receber o item.
//
//  Por isso o cadastro tem poucos campos: o item base, o número da
//  skin e quem tem direito. O resto — o modelo, a textura, a logo —
//  está publicado no Steam Workshop, e o servidor nunca o vê. Ver
//  Docs/OrigemZWorkshop/00-LEVANTAMENTO.md §2.1.
//
//  ####  UMA PERMISSÃO POR SKIN, E ELA NÃO É O VIP  ####
//
//  `origemzworkshop.<algo>`, registrada pelo plugin quando o
//  catálogo desce. O admin dá ao grupo de VIP, ao vencedor de um
//  evento ou a uma pessoa só — as três sem uma linha de código
//  nossa. Sem permissão, o item nasce vanilla.
//
//  ####  O CATÁLOGO É DA REDE, E A JUNÇÃO DIZ ONDE VALE  ####
//
//  Mesmo desenho do `custom_items` (migração 041): a tabela é
//  global, e `workshop_skin_servers` decide em que servidores cada
//  linha vale. Sem linha nenhuma = em nenhum servidor — uma skin
//  recém-cadastrada que já valesse em tudo entraria em produção
//  sem ninguém mandar.
//
//  ####  `skinId` É TEXTO, E ISSO NÃO É PREGUIÇA  ####
//
//  Ele é um `UInt64` do jogo. Não cabe no inteiro com sinal do
//  SQLite e não cabe no `number` do JS sem perder precisão — um
//  arredondamento silencioso aqui daria uma skin que não existe, e
//  o jogo não reclama: desenha o item vanilla e segue. Ver §2.2 do
//  levantamento.
// ============================================================

import { z } from 'zod';

/** O prefixo obrigatório de toda permissão desta feature. */
export const WORKSHOP_PERMISSION_PREFIX = 'origemzworkshop.';

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
  .regex(/^[1-9][0-9]{0,19}$/, 'A skin é um número inteiro positivo, sem zero à esquerda.')
  .refine(
    (value) => BigInt(value) <= MAX_SKIN_ID,
    'A skin passa do teto de UInt64 do jogo (18446744073709551615).',
  );

/**
 * Nome legível vira sufixo de permissão.
 *
 * Sem acento, sem maiúscula e sem símbolo: a permissão viaja num
 * comando de console do Rust, onde o espaço separa argumentos e o
 * acento depende do encoding do console. A régua é a mesma do
 * `slugify` dos itens custom.
 */
function toPermissionSlug(value: string): string {
  const ascii = value
    .normalize('NFD')
    // A faixa U+0300–U+036F são os diacríticos, já separados da
    // letra pelo NFD acima. Escrita como escape, e não com os
    // caracteres literais: um acento solto no meio do código-fonte
    // é invisível no editor e vira outra coisa em qualquer
    // conversão de encoding.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Nome só de símbolos deixaria a permissão igual ao prefixo, e
  // duas skins assim colidiriam no índice único.
  return ascii === '' ? 'skin' : ascii.slice(0, 40);
}

/**
 * A permissão, sempre no prefixo da feature.
 *
 * Quem digita "pedra" no painel quer dizer
 * `origemzworkshop.pedra`; quem digita o nome inteiro também está
 * certo. Normalizar aqui, num lugar só, é o que impede o catálogo
 * de ter metade das linhas com prefixo e metade sem — e o plugin
 * registrando permissões de duas famílias diferentes.
 *
 * É IDEMPOTENTE de propósito: o repositório revalida o que já
 * gravou, e uma segunda passada não pode dobrar o prefixo.
 */
export function normalizePermission(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const suffix = trimmed.startsWith(WORKSHOP_PERMISSION_PREFIX)
    ? trimmed.slice(WORKSHOP_PERMISSION_PREFIX.length)
    : trimmed;

  return `${WORKSHOP_PERMISSION_PREFIX}${toPermissionSlug(suffix)}`;
}

/**
 * O shortname do item base, na régua do próprio jogo.
 *
 * NÃO é conferido contra o catálogo aqui: quem faz isso é a rota,
 * que tem a tabela `items` na mão. A régua daqui só garante que o
 * texto atravessa um comando de console inteiro.
 */
export const workshopShortnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'O shortname é o do jogo: minúsculas, dígitos, ponto e hífen.');

/**
 * Uma entrada do catálogo, como o admin a cadastra.
 *
 * `servers` faz parte do cadastro, e não de uma tela à parte: uma
 * skin ligada a servidor nenhum não chega a lugar nenhum — e isso
 * não parece falha, que é o que a torna pior que uma falha.
 */
export const workshopSkinInputSchema = z.object({
  /** "Pedra OrigemZ". É por ele que o admin escolhe na tela. */
  label: z.string().trim().min(1, 'dê um nome à skin').max(60),

  /** O item do jogo que recebe a marca: `rock`, `stones`, `hatchet`. */
  shortname: workshopShortnameSchema,

  /** O id publicado no Steam Workshop. Ver `workshopSkinIdSchema`. */
  skinId: workshopSkinIdSchema,

  /** A permissão do Oxide. Ver `normalizePermission`. */
  permission: z.string().trim().min(1).max(80).transform(normalizePermission),

  /**
   * O item nasce SEM a skin na mão de quem está em modo streamer.
   *
   * ####  A PROTEÇÃO É DO PORTADOR, NÃO DO ESPECTADOR  ####
   *
   * MEDIDO: o `skinID` viaja no item, e todo mundo que olha o
   * mesmo item vê a mesma coisa. Dá para o streamer não ver a
   * logo nos itens DELE; não dá para escondê-la nos itens dos
   * outros jogadores no campo de visão dele. É o máximo que a
   * rede do Rust permite. Ver §3.2 do levantamento.
   */
  hideInStreamer: z.boolean().default(true),

  /**
   * Desligada NÃO é apagada.
   *
   * Uma skin desligada sai do push — o item volta a nascer vanilla
   * —, mas a linha continua no banco com a marca dela. Apagar é o
   * que tira a marca do catálogo para sempre, e a tela precisa
   * oferecer o primeiro antes do segundo.
   */
  enabled: z.boolean().default(true),

  /** Em que servidores ela vale. Vazio = em nenhum. Ver o cabeçalho. */
  servers: z.array(z.string().min(1)).max(50).default([]),
});

export type WorkshopSkinInput = z.infer<typeof workshopSkinInputSchema>;

/**
 * O mesmo cadastro, na borda HTTP, com a permissão OPCIONAL.
 *
 * Omitida, ela nasce do nome — "Pedra OrigemZ" vira
 * `origemzworkshop.pedra-origemz`. É o caso comum, e digitar a
 * permissão à mão em toda skin é como se erra uma letra e se
 * descobre semanas depois, com o jogador reclamando que não recebe
 * o item.
 */
export const workshopSkinBodySchema = workshopSkinInputSchema
  .extend({ permission: z.string().trim().max(80).optional() })
  .transform((raw) =>
    workshopSkinInputSchema.parse({
      ...raw,
      permission:
        raw.permission === undefined || raw.permission === '' ? raw.label : raw.permission,
    }),
  );

export interface WorkshopSkin extends WorkshopSkinInput {
  readonly id: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ------------------------------------------------------------
//  O QUE ATRAVESSA O CONSOLE
// ------------------------------------------------------------

/**
 * Uma skin dentro do `origemz.workshop.sync`.
 *
 * Os nomes são PROTOCOLO com o `OrigemZWorkshop.cs`: mudar um lado
 * sem o outro é o modo parar de funcionar em silêncio. O `label`
 * NÃO viaja — o plugin não desenha tela nenhuma, e um campo que
 * ninguém lê só ocupa frame.
 */
export interface WorkshopPayloadSkin {
  readonly id: number;
  readonly shortname: string;
  /** Texto, sempre. Ver o cabeçalho. */
  readonly skinId: string;
  readonly permission: string;
  readonly hideInStreamer: boolean;
  /**
   * Sempre `true` hoje: o push só leva as ligadas.
   *
   * O campo continua no contrato porque ele é o que permite, um
   * dia, mandar a desligada junto para o plugin PARAR de aplicar
   * sem perder a marca — e porque o `.cs` já está sendo escrito
   * contra ele.
   */
  readonly enabled: boolean;
}

/**
 * A carga completa. NUNCA um delta.
 *
 * Mesma regra do `origemz.vip.sync` (ver game/plugin-push.ts):
 * quem sumiu da lista perde a skin no instante em que o comando é
 * aplicado. É isso que faz "apaguei a skin" chegar ao jogo sem um
 * comando de remoção.
 */
export interface WorkshopPayload {
  /** O segredo desta sessão do agente. Ver game/workshop.ts. */
  readonly secret: string;
  readonly skins: readonly WorkshopPayloadSkin[];
  /**
   * Quem está escondendo a LOGO neste instante.
   *
   * ####  POR QUE A LISTA VIAJA JUNTO COM O CATÁLOGO  ####
   *
   * O modo streamer já existe inteiro no projeto, e a fonte da
   * verdade dele é o agente (db/streamer-repository.ts). O
   * OrigemZWorkshop precisa da mesma resposta que o
   * `StreamerHidesLogo` do OrigemZUI já dá — e DUAS cópias da
   * lista em dois plugins divergem no primeiro reload, que é a
   * pior das três opções do §3.3 do levantamento.
   *
   * Mandando a lista daqui, existe uma fonte só: o banco. O
   * plugin não pergunta a ninguém, e o reenvio sai sozinho quando
   * alguém liga ou desliga o `/streamer`.
   *
   * São SteamIDs em texto: 17 dígitos passam de 2^53.
   */
  readonly streamers: readonly string[];
}

/** O que o `origemz.workshop.status` responde. */
export interface WorkshopStatus {
  readonly skins: number;
  readonly streamers: number;
}

/**
 * O que o plugin grita no console.
 *
 *   ready    ele subiu e está sem catálogo — é o pedido de sync,
 *            e é o ÚNICO que vem sem segredo (o plugin ainda não
 *            recebeu nenhum);
 *   applied  ele aplicou a carga. Confirma quantas skins ficaram
 *            de pé do lado de lá.
 */
export const WORKSHOP_PUSH_KINDS = ['ready', 'applied'] as const;
export type WorkshopPushKind = (typeof WORKSHOP_PUSH_KINDS)[number];

export interface WorkshopPush {
  readonly kind: string;
  /** Ausente só no `ready`. Ver game/workshop.ts. */
  readonly secret?: string;
  readonly count?: number;
  readonly message?: string;
}
