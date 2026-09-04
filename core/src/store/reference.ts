// ============================================================
//  reference.ts  -  a chave que liga uma compra ao ledger do site.
//
//  ####  O PREFIXO NÃO É ENFEITE  ####
//
//  `reference_id` é ÚNICO na tabela INTEIRA do site, entre DayZ,
//  Conan e Rust. Sem `rust:<serverId>:`, uma colisão com uma chave
//  alheia devolve a transação DELES com `idempotent: true` — e o
//  débito desta compra nunca acontece: o jogador leva o item de
//  graça e a resposta parece um dia normal.
//
//  ####  QUANDO NÃO CABE, A CHAVE VIRA HASH — NUNCA UM CORTE  ####
//
//  Cortar a cauda foi o bug que o painel do Conan pagou: a chave de
//  uma linha de pedido TERMINA com o índice dela (`:0`, `:1`), e o
//  corte tira justamente esse índice. Todas as linhas passavam a
//  mandar a MESMA referência, o site respondia `200 idempotent`, e
//  o painel entregava de novo — dois itens, uma cobrança.
//
//  ####  113, E NÃO 120  ####
//
//  O site aceita 120 chars. Os 7 que faltam são do `:refund`: uma
//  referência de 115 chars PASSA na compra e faz o ESTORNO tomar
//  400 — no único caminho em que o jogador já pagou e não recebeu
//  nada. O teto da compra existe para que o estorno sempre caiba.
//
//  Ver Docs\20-INTEGRACAO-OZCOIN-AGENT.md §6.
// ============================================================

import { createHash } from 'node:crypto';

/** O limite do campo no site (`reference_id VARCHAR(120)`). */
export const REFERENCE_MAX_CHARS = 120;

/**
 * O sufixo do estorno.
 *
 * `:refund` e não `:credit`: é a convenção viva do agente do Conan,
 * e é sobre ela que qualquer consulta ao ledger procura. Os dois
 * têm 7 chars, então a escolha não é de tamanho — é de vocabulário.
 */
export const REFUND_SUFFIX = ':refund';

/** 120 menos os 7 do `:refund`. Ver o cabeçalho. */
export const PURCHASE_REFERENCE_MAX_CHARS = REFERENCE_MAX_CHARS - REFUND_SUFFIX.length;

/**
 * A referência de uma movimentação de OZ no site.
 *
 * `serverId` é o id NO SITE (`RUST01`), e não o de `Configs\` — são
 * campos diferentes, e o §22.10 do manual existe por causa disso.
 */
export function buildReference(serverId: string, scope: string, key: string): string {
  const prefix = `rust:${serverId}:${scope}:`;
  const full = `${prefix}${key}`;

  if (full.length <= PURCHASE_REFERENCE_MAX_CHARS) {
    return full;
  }

  // Determinístico: a mesma chave produz sempre a mesma referência,
  // e é isso que mantém a idempotência viva do outro lado do corte.
  //
  // A conta que garante que ele SEMPRE cabe: `serverId` é limitado a
  // 50 chars pelo site, o escopo mais longo previsto tem 7
  // (`entrega`), então o prefixo tem no máximo 5+50+1+7+1 = 64;
  // somados aos 32 do digest dão 96, dentro dos 113.
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);

  return `${prefix}${digest}`;
}

/**
 * A referência do estorno.
 *
 * Repetir um crédito com ela é SEGURO — o site devolve
 * `idempotent: true` e não credita duas vezes. É o oposto do
 * débito, e é o que permite o settler insistir num estorno que
 * falhou por timeout.
 */
export function refundReferenceOf(reference: string): string {
  return `${reference}${REFUND_SUFFIX}`;
}
