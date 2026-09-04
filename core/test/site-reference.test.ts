// ============================================================
//  site-reference.test.ts  -  a chave que o site vê.
//
//  O teste mais barato desta frente: uma função pura, sem banco e
//  sem rede. Ele guarda quatro coisas, e cada uma custou dinheiro
//  em algum lugar:
//
//    1. o prefixo `rust:<serverId>:` existe, e é o que impede uma
//       colisão com DayZ ou Conan de entregar o item de graça;
//    2. o que não cabe vira HASH, nunca um corte de cauda;
//    3. o hash é determinístico — sem isso a idempotência morre
//       justamente nas chaves compridas;
//    4. a compra cabe em 113 para o `:refund` sempre caber em 120.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  PURCHASE_REFERENCE_MAX_CHARS,
  REFERENCE_MAX_CHARS,
  buildReference,
  refundReferenceOf,
} from '../src/store/reference.js';

describe('a referência de uma compra', () => {
  it('leva o jogo e o servidor no prefixo', () => {
    // Sem `rust:pvp1:`, um `p1` do Conan e um `p1` nosso são a MESMA
    // linha no ledger do site — e a segunda cobrança nunca acontece.
    expect(buildReference('pvp1', 'loja', 'p1')).toBe('rust:pvp1:loja:p1');
  });

  it('quando a chave não cabe, ela vira hash — e o prefixo continua inteiro', () => {
    const long = 'x'.repeat(200);
    const reference = buildReference('RUST01', 'loja', long);

    expect(reference.length).toBeLessThanOrEqual(PURCHASE_REFERENCE_MAX_CHARS);
    // O prefixo é a única parte que NÃO pode ser perdida: é ele que
    // separa o nosso espaço de nomes do dos outros jogos.
    expect(reference.startsWith('rust:RUST01:loja:')).toBe(true);
    // sha256 truncado em 32 chars — e nada do `xxx…` original.
    expect(reference).toMatch(/^rust:RUST01:loja:[0-9a-f]{32}$/);
    expect(reference).not.toContain('xxxx');
  });

  it('o hash é determinístico', () => {
    // Se não fosse, uma retentativa geraria outra chave, o site
    // trataria como cobrança nova, e o jogador pagaria duas vezes
    // pela mesma compra — exatamente o que a idempotência evita.
    const long = 'y'.repeat(300);

    expect(buildReference('RUST01', 'loja', long)).toBe(buildReference('RUST01', 'loja', long));
  });

  it('o estorno é a chave da compra mais ":refund"', () => {
    const purchase = buildReference('RUST01', 'loja', 'p2n8x4q9zk1a');

    expect(refundReferenceOf(purchase)).toBe('rust:RUST01:loja:p2n8x4q9zk1a:refund');
  });

  it('uma compra no limite mais ":refund" dá exatamente 120', () => {
    // ####  É POR ISTO QUE O TETO DA COMPRA É 113  ####
    //
    // Uma referência de 115 chars PASSA na compra e faz o estorno
    // tomar 400 — no único caminho em que o jogador já pagou e não
    // recebeu nada.
    const key = 'k'.repeat(PURCHASE_REFERENCE_MAX_CHARS - 'rust:RUST01:loja:'.length);
    const purchase = buildReference('RUST01', 'loja', key);

    expect(purchase).toHaveLength(PURCHASE_REFERENCE_MAX_CHARS);
    expect(refundReferenceOf(purchase)).toHaveLength(REFERENCE_MAX_CHARS);
  });

  it('o hash cabe mesmo com o serverId no tamanho máximo do site', () => {
    // 50 chars é o teto que o site impõe ao `serverId`, e o boot do
    // agente recusa mais que isso. Com o escopo mais longo previsto,
    // o pior caso ainda tem folga.
    const reference = buildReference('s'.repeat(50), 'entrega', 'z'.repeat(500));

    expect(reference.length).toBeLessThanOrEqual(PURCHASE_REFERENCE_MAX_CHARS);
  });
});
