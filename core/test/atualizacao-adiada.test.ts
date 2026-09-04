// ============================================================
//  atualizacao-adiada.test.ts  -  "adiada" tem que CHEGAR à tela.
//
//  ####  O DEFEITO QUE ISTO TRAVA  ####
//
//  O core já sabia a diferença desde 04/09/2026: a atualização que
//  desiste porque o Oxide ainda não lançou a versão do build novo
//  não quebrou nada — não derrubou ninguém, não tocou em disco, e
//  o vigia devolve a tentativa para tentar de novo em quinze
//  minutos (ver oxide/compat.ts e steam/update-watcher.ts).
//
//  A TELA não sabia. O retrato do vigia copiava a tentativa campo
//  a campo e deixava o `deferred` para trás, então a faixa do
//  painel dizia "a última tentativa automática FALHOU" e mandava
//  forçar por "Atualizar avisando" — que é a MESMA conferência e
//  recusa igual. O caminho todo estava certo menos o último passo,
//  que é justamente o único que alguém lê.
//
//  Por isso os testes daqui olham a JUNTA: o que a operação diz
//  sobre si mesma, e o que sobra dela no retrato.
// ============================================================

import { describe, expect, it } from 'vitest';

import { Operation } from '../src/ops/operations.js';
import { attemptFrom } from '../src/steam/update-watcher.js';

const MOTIVO =
  'o Oxide ainda não lançou a versão do build 25129933 do Rust. A última é a 2.0.7676, de ' +
  '2026-09-03 17:32, e o build saiu em 2026-09-04 18:45.';

/** Uma operação já terminada, do jeito que o `ops/service.ts` a deixa. */
function encerrada(options: { readonly deferred: boolean }): Operation {
  const operation = new Operation('server-auto-update', 'server01');

  operation.deferred = options.deferred;
  operation.finish('failed', MOTIVO);

  return operation;
}

describe('a operação adiada', () => {
  it('continua `failed` — a atualização não aconteceu', () => {
    // Fingir `succeeded` esconderia da tela que o build em disco
    // continua o velho, e é isso que faz o servidor recusar quem
    // já atualizou o cliente.
    expect(encerrada({ deferred: true }).view().status).toBe('failed');
  });

  it('carrega o `deferred` no retrato que a tela lê', () => {
    expect(encerrada({ deferred: true }).view().deferred).toBe(true);
  });

  it('não contamina a falha de verdade', () => {
    // O SteamCMD que morre no meio do download tem que continuar
    // vermelho, com o aviso que não some sozinho.
    expect(encerrada({ deferred: false }).view().deferred).toBe(false);
  });
});

describe('a tentativa, como o vigia a guarda', () => {
  it('preserva o adiamento junto com o motivo', () => {
    const attempt = attemptFrom(encerrada({ deferred: true }).view());

    expect(attempt.status).toBe('failed');
    expect(attempt.deferred).toBe(true);
    // A frase inteira viaja: é ela que a faixa mostra, e o número
    // do build e a data da release são o que resolve a dúvida de
    // quem está olhando.
    expect(attempt.message).toBe(MOTIVO);
  });

  it('a falha de verdade chega como falha', () => {
    expect(attemptFrom(encerrada({ deferred: false }).view()).deferred).toBe(false);
  });

  it('a tentativa em curso não é adiada nem falha', () => {
    const running = new Operation('server-auto-update', 'server01');
    const attempt = attemptFrom(running.view());

    expect(attempt.status).toBe('running');
    expect(attempt.finishedAt).toBeNull();
    // `false`, e não `undefined`: a tela decide a cor com isto, e
    // um campo ausente vira "não sei" em toda comparação estrita.
    expect(attempt.deferred).toBe(false);
  });
});
