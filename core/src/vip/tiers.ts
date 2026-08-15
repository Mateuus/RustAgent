// ============================================================
//  tiers.ts  -  qual GRUPO do Oxide corresponde a cada nível de
//  VIP, naquele servidor.
//
//  ####  O NOME DO GRUPO NÃO É ADIVINHADO  ####
//
//  Ele está no `OrigemZVip.json` daquele servidor
//  (`Niveis[].Grupo`), que o agente já sabe ler pela mesma função
//  que serve a tela de configuração de plugin. Montar
//  `origemz.vip.${tier}` na mão seria inventar um contrato que o
//  dono do servidor pode mudar num arquivo — e o sintoma seria o
//  VIP comprado sem efeito nenhum, sem erro em lugar nenhum.
//
//  MEDIDO no `server01`: o config traz os três níveis, e os três
//  grupos existem no Oxide (`origemz.vip.bronze` →
//  `origemz.vip.silver` → `origemz.vip.gold`), criados pelo próprio
//  plugin ao carregar.
//
//  ------------------------------------------------------------
//  ####  ARQUIVO AUSENTE É LISTA VAZIA, E NÃO ERRO  ####
//
//  O `OrigemZVip.json` só nasce quando o plugin carrega pela
//  primeira vez. Antes disso — servidor recém-instalado, plugin
//  desligado — a resposta certa para "quais níveis existem aqui?" é
//  "nenhum que eu saiba", e quem chama DIZ isso em vez de fingir
//  que sincronizou.
//
//  Um nível sem `Tier` ou sem `Grupo` é DESCARTADO pelo próprio
//  plugin (ver `BuildLevels`, no OrigemZVip.cs), e é descartado
//  aqui pelo mesmo motivo: completar com um padrão criaria um grupo
//  que ninguém pediu e concederia benefício por acidente.
// ============================================================

import { z } from 'zod';

import { readPluginConfig } from '../oxide/plugin-config.js';

/** O plugin dono da hierarquia de VIP. */
export const VIP_PLUGIN = 'OrigemZVip';

/** Um nível, como o config daquele servidor o descreve. */
export interface VipTierLevel {
  /** `bronze` | `silver` | `gold` — sempre minúsculo. */
  readonly tier: string;
  /** O grupo do Oxide: `origemz.vip.gold`. */
  readonly group: string;
  /** O rótulo que o chat e a fila mostram. `null` = não declarado. */
  readonly title: string | null;
  /** A ordem entre níveis. Maior é mais alto. `null` = não declarado. */
  readonly rank: number | null;
  /** De quem ele herda. `null` = de ninguém. */
  readonly parentGroup: string | null;
}

/**
 * O config do plugin, na parte que nos interessa.
 *
 * `passthrough` de propósito: o arquivo é do PLUGIN, e ele ganha
 * chaves novas a cada versão dele. Recusar o que não conhecemos
 * faria o agente parar de enxergar os níveis por causa de um campo
 * que não é nosso.
 */
const vipConfigSchema = z
  .object({
    Niveis: z
      .array(
        z
          .object({
            Tier: z.string().optional(),
            Grupo: z.string().optional(),
            Titulo: z.string().optional(),
            Rank: z.number().optional(),
            GrupoPai: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface VipTiersView {
  readonly levels: readonly VipTierLevel[];
  /**
   * Por que a lista está vazia. `null` = ela foi lida de verdade.
   *
   * "Não há níveis configurados" e "não consegui ler o arquivo" são
   * respostas diferentes, e a segunda não pode se disfarçar da
   * primeira: quem vê a tela precisa saber que o caminho para o
   * jogo está interrompido, e não que ninguém configurou nada.
   */
  readonly problem: string | null;
}

/**
 * Os níveis daquele servidor.
 *
 * Nunca lança: um config quebrado é problema de quem o editou, e
 * derrubar a sincronização inteira por causa dele deixaria o VIP
 * parado sem dizer por quê. O motivo sai em `problem`.
 */
export async function readVipTiers(oxideConfigDir: string): Promise<VipTiersView> {
  let raw: string;

  try {
    const config = await readPluginConfig(oxideConfigDir, VIP_PLUGIN);

    if (config === null) {
      return {
        levels: [],
        problem:
          `O ${VIP_PLUGIN}.json ainda não existe neste servidor. Ele nasce no primeiro ` +
          'carregamento do plugin — ligue o OrigemZVip e suba o servidor uma vez.',
      };
    }

    raw = config.text;
  } catch (error) {
    return {
      levels: [],
      problem: `Não consegui ler o ${VIP_PLUGIN}.json deste servidor: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      levels: [],
      problem:
        `O ${VIP_PLUGIN}.json deste servidor não é um JSON válido (${
          error instanceof Error ? error.message : String(error)
        }). O Oxide também não carrega o plugin assim — conserte o arquivo em ` +
        'Configurações → Plugins.',
    };
  }

  const config = vipConfigSchema.safeParse(parsed);

  if (!config.success || config.data.Niveis === undefined) {
    return {
      levels: [],
      problem:
        `O ${VIP_PLUGIN}.json deste servidor não tem a lista "Niveis". Sem ela o plugin não cria ` +
        'grupo nenhum, e o agente não tem como saber que grupo dar a quem compra VIP.',
    };
  }

  const levels: VipTierLevel[] = [];
  const seenTiers = new Set<string>();
  const seenGroups = new Set<string>();

  for (const entry of config.data.Niveis) {
    const tier = (entry.Tier ?? '').trim().toLowerCase();
    const group = (entry.Grupo ?? '').trim();

    // As mesmas duas recusas do `BuildLevels` do plugin, e pela
    // mesma razão: nível repetido faria o agente conceder e tirar o
    // mesmo jogador no mesmo laço, e grupo repetido faria dois
    // níveis brigarem pelo mesmo grupo do Oxide.
    if (tier === '' || group === '' || seenTiers.has(tier) || seenGroups.has(group.toLowerCase())) {
      continue;
    }

    seenTiers.add(tier);
    seenGroups.add(group.toLowerCase());

    levels.push({
      tier,
      group,
      title: entry.Titulo === undefined || entry.Titulo === '' ? null : entry.Titulo,
      rank: entry.Rank ?? null,
      parentGroup:
        entry.GrupoPai === undefined || entry.GrupoPai.trim() === '' ? null : entry.GrupoPai.trim(),
    });
  }

  if (levels.length === 0) {
    return {
      levels: [],
      problem:
        `O ${VIP_PLUGIN}.json deste servidor não declara nenhum nível utilizável (todo item ` +
        'da lista "Niveis" está sem Tier ou sem Grupo).',
    };
  }

  return { levels, problem: null };
}

/**
 * O nível daquele tier, ou `null`.
 *
 * A comparação é sobre o tier NORMALIZADO (minúsculo, sem espaço),
 * que é a única grafia que existe em toda a cadeia — site, banco,
 * agente e plugin.
 */
export function levelOf(levels: readonly VipTierLevel[], tier: string): VipTierLevel | null {
  const normalized = tier.trim().toLowerCase();

  return levels.find((level) => level.tier === normalized) ?? null;
}

/**
 * O nível MAIS ALTO entre os que o jogador tem.
 *
 * ####  POR QUE O MAIS ALTO, E NÃO TODOS  ####
 *
 * Porque é assim que o grupo funciona no jogo: `origemz.vip.gold`
 * HERDA de `silver`, que herda de `bronze` (MEDIDO no server01,
 * pelo `Parent group` do `oxide.show group`). Pôr o jogador nos
 * três daria a ele o mesmo poder por três caminhos — e o próprio
 * `SyncPlayer` do OrigemZVip desfaria isso no primeiro `apply`:
 * ele mantém SÓ o grupo do nível mais alto e remove os outros.
 *
 * Dois donos discordando sobre o mesmo estado é o que produz
 * "concedi e sumiu sozinho".
 *
 * A ordem vem do `Rank` do config; sem ele, da ordem em que os
 * níveis aparecem no arquivo — que é a ordem em que quem escreveu
 * o config os pensou.
 */
export function highestLevel(
  levels: readonly VipTierLevel[],
  tiers: readonly string[],
): VipTierLevel | null {
  let best: VipTierLevel | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;

  for (const tier of tiers) {
    const level = levelOf(levels, tier);

    if (level === null) {
      continue;
    }

    const rank = level.rank ?? levels.indexOf(level);

    if (best === null || rank > bestRank) {
      best = level;
      bestRank = rank;
    }
  }

  return best;
}
