// ============================================================
//  Testes da ESPERA PELAS PORTAS depois de parar o servidor.
//
//  O que estes testes protegem: o `server-restart` com force matava
//  o processo e subia de novo antes de o Windows soltar as portas —
//  "a porta 28082 (app) já está ocupada", medido duas vezes em
//  11/09/2026. Parar agora só termina quando as portas voltam.
// ============================================================

import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { waitForPortsFree } from '../src/ops/server-process.js';

let holder: Server | null = null;

/** Segura uma porta livre qualquer, como o processo que está morrendo. */
async function holdPort(): Promise<number> {
  const server = createServer();
  holder = server;

  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('sem porta');
  }

  return address.port;
}

function release(): Promise<void> {
  const server = holder;
  holder = null;

  return server === null ? Promise.resolve() : new Promise((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await release();
});

describe('a espera pelas portas', () => {
  it('termina assim que a porta presa é solta', async () => {
    const port = await holdPort();

    // O processo "termina de morrer" logo depois.
    setTimeout(() => void release(), 300);

    const started = Date.now();
    const busy = await waitForPortsFree([port], 10_000);

    expect(busy).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('desiste no teto e diz qual porta ficou presa', async () => {
    const port = await holdPort();

    // Outro programa de verdade: ela nunca volta.
    const busy = await waitForPortsFree([port], 600);

    expect(busy).toEqual([port]);
  });
});
