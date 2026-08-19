// ============================================================
//  wipe-types.test.ts  -  a trava do commit zero.
//
//  Os tipos de types/wipe.ts e types/messages.ts são o único
//  ponto em que nove frentes se encontram antes do merge, e a
//  regra do Docs/17 §0.3 é que eles NÃO MUDAM depois de
//  publicados. Só que "não mudam" escrito num documento não
//  impede ninguém de renomear um valor — e o estrago dessa
//  renomeação não aparece no compilador de quem renomeou: aparece
//  no banco de quem já gravou a palavra antiga.
//
//  Por isso o que este arquivo guarda não são os TIPOS (o
//  TypeScript já faz isso, e um teste que repete o compilador não
//  guarda nada). São os VALORES LITERAIS que atravessam a
//  fronteira: eles viram texto em coluna de SQLite, campo de JSON
//  de rota e argumento de comando de RCON, e nesses três lugares
//  ninguém avisa quando a palavra muda.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  BP_POLICIES,
  COLLISION_POLICIES,
  MAP_SOURCES,
  WIPE_PLAN_KINDS,
  WIPE_PLAN_STATUSES,
  WIPE_RUN_STATUSES,
  WIPE_RUN_STEPS,
  WIPE_STEP_STATUSES,
} from '../src/types/wipe.js';
import { BROADCAST_VIAS, SCHEDULE_KINDS } from '../src/types/messages.js';

describe('os valores que vão para o banco', () => {
  it('as três políticas de blueprint são as do Docs/16 §7', () => {
    expect(BP_POLICIES).toEqual(['keep', 'wipe', 'wipe_except_vip']);
  });

  it('as três políticas de colisão são as do Docs/16 §5', () => {
    expect(COLLISION_POLICIES).toEqual(['reanchor', 'absorb', 'ignore']);
  });

  it('um wipe da agenda vem da cadência, da Facepunch ou de uma pessoa', () => {
    expect(WIPE_PLAN_KINDS).toEqual(['cadence', 'forced', 'manual']);
  });

  it('`absorbed` é um status de plano, e não o sumiço dele', () => {
    // O wipe absorvido continua na lista, marcado: uma agenda com
    // um buraco não explica por que terça não vai ter wipe.
    expect(WIPE_PLAN_STATUSES).toContain('absorbed');
    expect(WIPE_PLAN_STATUSES).toEqual([
      'planned',
      'running',
      'done',
      'skipped',
      'failed',
      'absorbed',
    ]);
  });

  it('as quatro origens do mapa do próximo wipe', () => {
    expect(MAP_SOURCES).toEqual(['pool', 'random', 'fixed', 'keep']);
  });

  it('os quatro ritmos de uma mensagem', () => {
    expect(SCHEDULE_KINDS).toEqual(['interval', 'daily', 'weekly', 'once']);
  });
});

describe('os passos de um wipe', () => {
  it('são oito, e a ordem é a execução', () => {
    // A ordem não é enfeite: a tela de Execução desenha os passos
    // nela, e o `resume` retoma do primeiro que não terminou.
    expect(WIPE_RUN_STEPS).toEqual([
      'avisar',
      'esvaziar',
      'parar',
      'backup',
      'apagar',
      'configurar',
      'subir',
      'pos-wipe',
    ]);
  });

  it('nenhum passo tem acento nem espaço', () => {
    // Eles viram chave primária de `wipe_run_steps` e nome de
    // passo no log. Um acento ali é encoding para conferir em três
    // camadas; um espaço quebra qualquer coisa que os passe pelo
    // console do jogo.
    for (const step of WIPE_RUN_STEPS) {
      expect(step).toMatch(/^[a-z-]+$/);
    }
  });

  it('um passo pulado é desfecho normal, e por isso existe `skipped`', () => {
    // Apagar num diretório já limpo é sucesso. Sem esse valor, a
    // retomada precisaria escolher entre mentir `done` ou falhar.
    expect(WIPE_STEP_STATUSES).toEqual(['pending', 'running', 'done', 'failed', 'skipped']);
  });

  it('a execução inteira usa `cancelled`, a grafia do OperationStatus', () => {
    // ops/operations.ts já escreve 'cancelled'. Duas grafias para
    // o mesmo desfecho é o que só aparece num `switch` esquecido.
    expect(WIPE_RUN_STATUSES).toEqual(['running', 'done', 'failed', 'cancelled']);
  });
});

describe('o transporte da fala', () => {
  it('são dois caminhos: o plugin e o `say` do jogo', () => {
    // O `via` da resposta é o que diz se o `sent` vale alguma
    // coisa — pelo `say` o jogo não devolve número nenhum.
    expect(BROADCAST_VIAS).toEqual(['plugin', 'say']);
  });
});
