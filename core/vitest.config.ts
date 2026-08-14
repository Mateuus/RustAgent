import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node puro: nada aqui roda em browser/jsdom.
    environment: 'node',
    include: ['test/**/*.test.ts'],

    // Quase nenhum teste abre socket de verdade — os de RCON usam
    // o WebSocket falso de test/helpers/fake-socket.ts. A exceção é
    // test/server-ports.test.ts, que precisa perguntar ao sistema
    // operacional se uma porta está livre e por isso faz bind de
    // verdade, sempre em 127.0.0.1 e sempre numa porta efêmera.
    // Nada aqui depende de REDE; este limite existe para o dia em
    // que algo passar a depender, e estourar em vez de travar o CI.
    testTimeout: 10_000,
  },
});
