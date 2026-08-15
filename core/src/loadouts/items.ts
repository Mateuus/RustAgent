// ============================================================
//  items.ts  -  o item de um kit, do jeito que o plugin o espera.
//
//  ####  CONTRATO COMPARTILHADO COM O PLUGIN OXIDE  ####
//
//  Este formato NÃO é escolha nossa: é o `LoadoutItemPayload` do
//  `OrigemZAgent.cs`, e ele atravessa daqui até o inventário do
//  jogador sem ninguém remontá-lo pelo caminho —
//  `origemz.loadout.sync` guarda o JSON JÁ SERIALIZADO no cache, e
//  o `OrigemZPlayer` o lê pelo hook `GetLoadout`. Mudar um nome de
//  campo aqui exige mudar os dois plugins junto.
//
//      { "slot": "belt", "shortname": "rifle.ak",
//        "amount": 1, "skinId": "0", "position": 0 }
//
//  ####  O skinId É STRING  ####
//
//  Pelo mesmo motivo do SteamID: skin do workshop passa de 2^53, e
//  em `number` ela volta arredondada — o jogador receberia a arma
//  com OUTRA skin, ou com nenhuma, sem erro em lugar nenhum. O
//  próprio DTO do plugin a declara como `string` por isso.
//
//  ####  OS TRÊS SLOTS SÃO OS DO JOGO  ####
//
//  `wear`, `belt` e `main` são os contêineres do `BasePlayer`
//  (roupa, barra rápida, mochila). O `OrigemZPlayer` recusa
//  qualquer outro com um aviso no console e IGNORA o item — então
//  um slot inventado aqui vira um item que some no caminho, que é o
//  pior desfecho. Quem recusa antes é a borda HTTP, com o zod
//  abaixo.
// ============================================================

import { z } from 'zod';

/** Os contêineres do jogador. Ver o cabeçalho. */
export const LOADOUT_SLOTS = ['wear', 'belt', 'main'] as const;

export type LoadoutSlot = (typeof LOADOUT_SLOTS)[number];

export interface LoadoutItem {
  readonly slot: LoadoutSlot;
  /** `rifle.ak`. É o que o jogo conhece; o nome bonito é do catálogo. */
  readonly shortname: string;
  readonly amount: number;
  /** String, sempre. Ver o cabeçalho. `"0"` = sem skin. */
  readonly skinId: string;
  /** A posição dentro do slot. Repetida = o jogo decide. */
  readonly position: number;
}

/**
 * Teto de itens por kit.
 *
 * Não é limite de produto: é o que impede um erro de digitação na
 * tela (ou um POST malformado) de virar um payload que o WebRCON
 * trunca. O teto de BYTES continua valendo por cima deste, na
 * sincronização — este só faz a recusa acontecer cedo, com uma
 * frase que diz o que fazer.
 */
export const MAX_LOADOUT_ITEMS = 60;

/**
 * O que a borda HTTP aceita.
 *
 * `skinId` é `z.string()` com regex de dígitos, e não `z.number()`:
 * ver o cabeçalho. A string vazia vira `"0"` porque o plugin trata
 * ausente e `"0"` do mesmo jeito, e um campo em branco na tela é o
 * caso comum.
 */
export const loadoutItemSchema = z.object({
  slot: z.enum(LOADOUT_SLOTS),
  shortname: z
    .string()
    .trim()
    .min(1)
    .max(64)
    // O shortname vai para a LINHA DE COMANDO do console
    // (`origemz.give`), então ele não pode ter espaço nem aspa: o
    // parser do Rust fatiaria o comando e a entrega faria outra
    // coisa, em silêncio. O alfabeto real dos itens do jogo é
    // `letras.numeros`, com ponto, hífen e sublinhado.
    .regex(
      /^[A-Za-z0-9._-]+$/,
      'o shortname do item usa letras, dígitos, ponto, hífen ou sublinhado — por exemplo, rifle.ak',
    ),
  amount: z.number().int().min(1).max(100_000),
  skinId: z
    .string()
    .trim()
    .regex(/^\d*$/, 'o skinId é uma sequência de dígitos (0 = sem skin)')
    .max(20)
    .default('0'),
  position: z.number().int().min(0).max(47),
});

export const loadoutItemsSchema = z.array(loadoutItemSchema).max(MAX_LOADOUT_ITEMS);

/**
 * Os itens guardados na coluna `items`.
 *
 * ####  JSON ILEGÍVEL VIRA LISTA VAZIA, E NÃO EXCEÇÃO  ####
 *
 * A coluna é escrita só por aqui, então "ilegível" quer dizer que
 * alguém editou o banco à mão. Derrubar a LISTAGEM inteira por
 * causa de uma linha estragada esconderia as outras trinta que
 * estão boas — e a linha ruim aparece na tela como um kit vazio,
 * que é visível e consertável.
 *
 * Item fora de formato é descartado individualmente, pela mesma
 * razão: o resto do kit continua entregável.
 */
export function parseLoadoutItems(raw: string): readonly LoadoutItem[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const items: LoadoutItem[] = [];

  for (const candidate of parsed) {
    const item = loadoutItemSchema.safeParse(candidate);

    if (item.success) {
      items.push(item.data);
    }
  }

  return items;
}

/** Os itens como a coluna os guarda. */
export function serializeLoadoutItems(items: readonly LoadoutItem[]): string {
  return JSON.stringify(items);
}

/**
 * A ordem em que o jogo monta o inventário: por slot, e dentro
 * dele por posição.
 *
 * Ela é a MESMA na tela e no payload de propósito — duas ordens
 * para o mesmo dado fariam a configuração e o kit recebido no jogo
 * discordarem sem ninguém entender por quê.
 */
export function sortLoadoutItems(items: readonly LoadoutItem[]): readonly LoadoutItem[] {
  return [...items].sort((left, right) => {
    const bySlot = LOADOUT_SLOTS.indexOf(left.slot) - LOADOUT_SLOTS.indexOf(right.slot);

    return bySlot === 0 ? left.position - right.position : bySlot;
  });
}
