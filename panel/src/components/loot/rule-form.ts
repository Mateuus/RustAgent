// ============================================================
//  rule-form.ts  -  o que uma regra de loot é, antes da tela.
//
//  ####  AS FRASES DE TETO E CARÊNCIA MORAM AQUI  ####
//
//  "dailyCap: 3" não diz nada a quem administra um servidor; "no
//  máximo 3 por dia neste servidor" diz. A tradução fica num
//  lugar só porque a lista e o formulário precisam dizer a MESMA
//  coisa — duas frases diferentes para o mesmo campo fazem o
//  admin achar que são dois campos.
//
//  ####  PURO DE PROPÓSITO  ####
//
//  Nada de React: é o que `panel/test/loot-rule-form.test.ts`
//  alcança. O que se guarda aqui é o que erra em silêncio — uma
//  regra que sai do formulário sem container nenhum é aceita pelo
//  agente e não dispara nunca.
// ============================================================

import type { LootRule, LootRuleInput } from '@/lib/api';

/** O que uma regra nova é, antes de alguém digitar nada. */
export const EMPTY_RULE: LootRuleInput = {
  id: '',
  label: '',
  customItemId: '',
  containers: [],
  // ####  UMA EM DEZ MIL, E NÃO UMA EM DUAS  ####
  //
  // O padrão de um campo de chance é o que o admin apressado
  // salva sem ler. Começar em 0,5 encheria o mapa de troféus no
  // primeiro wipe; começar raro erra para MENOS, que é o erro
  // seguro (05 §10.1). O valor é o de partida que o 04 §6.4
  // recomendou para o troféu, uma ordem de grandeza mais raro.
  chance: 0.0001,
  amountMin: 1,
  amountMax: 1,
  // ####  E ELA NASCE MEDINDO  ####
  //
  // Uma regra recém-criada não sabe quantas caixas daquelas o
  // mapa popula por dia — ninguém sabe, o denominador não é
  // medido (05 §9.6). Nascer em medição faz a primeira semana
  // responder isso sem soltar item nenhum.
  mode: 'measuring',
  dailyCap: null,
  playerCooldownHours: null,
  enabled: true,
  servers: [],
};

/**
 * O rótulo vira id: "Troféu na caixa de elite" → "trofeu-na-caixa-de-elite".
 *
 * Mesmo desenho do cadastro de ranking: o id nasce do nome e para
 * de acompanhá-lo depois do primeiro salvamento — renomear uma
 * regra não pode trocar a chave que a contagem de `stats` usa.
 */
export function toSlug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** A regra, na forma que o PUT quer de volta. O PUT é total. */
export function ruleToInput(rule: LootRule): LootRuleInput {
  return {
    id: rule.id,
    label: rule.label,
    customItemId: rule.customItemId,
    containers: [...rule.containers],
    chance: rule.chance,
    amountMin: rule.amountMin,
    amountMax: rule.amountMax,
    mode: rule.mode,
    dailyCap: rule.dailyCap,
    playerCooldownHours: rule.playerCooldownHours,
    enabled: rule.enabled,
    servers: [...rule.servers],
  };
}

/** Por que o botão de salvar está travado. `null` = pode salvar. */
export function whyNotReady(form: LootRuleInput): string | null {
  if (form.label.trim() === '') {
    return 'Falta o nome da regra.';
  }

  if (form.id.trim() === '') {
    return 'Falta o identificador.';
  }

  if (form.customItemId.trim() === '') {
    return 'Falta escolher o item — e ele precisa ser um item nosso.';
  }

  if (form.containers.length === 0) {
    // Uma regra sem container é aceita pelo banco e não dispara
    // nunca. O sintoma seria "cadastrei e não caiu nada", que é
    // indistinguível de chance baixa demais.
    return 'Escolha pelo menos um contêiner: sem nenhum, a regra nunca dispara.';
  }

  if (form.servers.length === 0) {
    // O molde é o de `custom_item_servers`: sem linha nenhuma, o
    // cadastro existe e não vale em lugar algum.
    return 'Escolha ao menos um servidor — sem isso a regra não vale em lugar nenhum.';
  }

  if (!Number.isFinite(form.chance) || form.chance <= 0 || form.chance > 1) {
    return 'A chance precisa ser maior que zero.';
  }

  if (form.amountMin < 1 || form.amountMax < form.amountMin) {
    return 'A quantidade precisa começar em 1 e o máximo não pode ser menor que o mínimo.';
  }

  return null;
}

/** "1" ou "1 a 3". */
export function describeAmount(min: number, max: number): string {
  return min === max ? String(min) : `${String(min)} a ${String(max)}`;
}

/**
 * Teto e carência, ditos pelo EFEITO.
 *
 * O admin não precisa saber que o campo se chama `dailyCap`; ele
 * precisa saber que, ligando isso, o servidor para de soltar no
 * terceiro do dia.
 */
export function describeLimits(rule: {
  readonly dailyCap: number | null;
  readonly playerCooldownHours: number | null;
}): string[] {
  const lines: string[] = [];

  if (rule.dailyCap !== null && rule.dailyCap > 0) {
    lines.push(`No máximo ${String(rule.dailyCap)} por dia neste servidor.`);
  }

  if (rule.playerCooldownHours !== null && rule.playerCooldownHours > 0) {
    lines.push(
      `O mesmo jogador não acha outro nas próximas ${String(rule.playerCooldownHours)} h.`,
    );
  }

  return lines;
}
