// ============================================================
//  custom-item-icon-upload.test.ts  -  a porta do ícone.
//
//  ####  POR QUE ESTE ARQUIVO EXISTE  ####
//
//  Porque o painel passou a reduzir a imagem sozinho, no navegador,
//  e isso é uma CONVENIÊNCIA — não uma garantia. Quem manda o PNG
//  por `curl`, por script ou por um painel antigo não passa pelo
//  canvas, e é este arquivo que guarda o que acontece então:
//
//    1. o que estoura o teto continua sendo RECUSADO — a validação
//       de borda não pode sumir só porque o cliente ficou esperto;
//    2. a recusa diz o tamanho, o teto e O QUE FAZER. Para quem não
//       usa o painel, essa frase é toda a orientação que existe;
//    3. a arte ORIGINAL (2,9 MB) não devolve mais o erro em inglês
//       do @fastify/multipart, que falava de "multipart config" —
//       um assunto que não é o de quem mandou uma imagem grande;
//    4. o que não é PNG morre antes de virar arquivo em disco.
//
//  O teto sai do frame do WebRCON: o PNG viaja até o servidor
//  dentro de uma linha de console, em base64, e acima de 33.000
//  bytes a linha não passa.
// ============================================================

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectRoot } from '../src/config.js';
import { CustomItemsRepository } from '../src/db/custom-items-repository.js';
import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { ItemsRepository } from '../src/db/items-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { apiErrorToResponse, isApiError } from '../src/http/error-response.js';
import {
  ITEM_ASSETS_DIR,
  MAX_ICON_BYTES,
  RECOMMENDED_ICON_SIZE,
  registerCustomItemRoutes,
} from '../src/http/routes/custom-items.js';

/** O teto do upload de plugin, que é o do multipart do servidor real. */
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;

/** Os oito bytes que abrem todo PNG. */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Os três primeiros de um JPEG — o disfarce mais provável. */
const JPEG_HEAD = [0xff, 0xd8, 0xff];

/** O único arquivo que estes testes têm licença para gravar. */
const WRITTEN_ICON = 'teste_upload_icone.png';

let db: AgentDatabase;
let app: FastifyInstance;

/** Um arquivo com o cabeçalho pedido e o peso pedido. */
function fileOf(head: readonly number[], bytes: number): Buffer {
  const content = Buffer.alloc(Math.max(bytes, head.length));

  head.forEach((byte, index) => content.writeUInt8(byte, index));

  return content;
}

/**
 * O corpo multipart, montado na mão.
 *
 * É o que um `curl -F` produz — e é justamente esse caminho, o que
 * não passa pelo navegador, que este arquivo existe para cobrir.
 */
function multipartBody(
  filename: string,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----rustagentteste';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: image/png\r\n\r\n',
  );

  return {
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(filename: string, content: Buffer) {
  const { payload, headers } = multipartBody(filename, content);

  return app.inject({ method: 'POST', url: '/api/custom-items/icons', payload, headers });
}

beforeEach(async () => {
  db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  app = Fastify();

  app.setErrorHandler(async (error, _request, reply) => {
    if (isApiError(error)) {
      const response = apiErrorToResponse(error);
      return reply.status(response.statusCode).send(response.body);
    }

    return reply.status(500).send({ ok: false, error: 'INTERNAL_ERROR', message: String(error) });
  });

  // O MESMO registro do servidor real (http/server.ts): o limite do
  // multipart é o do PLUGIN, e o do ícone é pedido pela rota. Testar
  // com outro número mediria um servidor que não existe.
  await app.register(multipart, { limits: { fileSize: MAX_PLUGIN_BYTES, files: 1 } });

  await app.register(
    async (api) => {
      registerCustomItemRoutes(api, {
        repository: new CustomItemsRepository(db),
        items: new ItemsRepository(db),
        servers: new ServersRepository(db),
      });
    },
    { prefix: '/api' },
  );
});

afterEach(() => {
  db.close();

  // O caminho feliz grava de verdade, porque é isso que a rota faz.
  // Deixar o arquivo para trás encheria `Assets/items` de lixo de
  // teste — e ele apareceria na lista de ícones da tela.
  rmSync(join(projectRoot(), ITEM_ASSETS_DIR, WRITTEN_ICON), { force: true });
});

// ------------------------------------------------------------
//  O teto
// ------------------------------------------------------------

describe('o teto do ícone', () => {
  it('recusa o PNG que passa do teto, mesmo por um byte', async () => {
    const response = await upload('grande.png', fileOf(PNG_HEAD, MAX_ICON_BYTES + 1));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('ICON_TOO_LARGE');
  });

  it('diz o tamanho, o teto e O QUE FAZER', async () => {
    const response = await upload('grande.png', fileOf(PNG_HEAD, 40_000));
    const { message } = response.json<{ message: string }>();

    // Sem estes três pedaços a recusa é um "não" seco, e quem
    // mandou por script não tem como saber o que corrigir.
    expect(message).toContain('40 KB');
    expect(message).toContain('33 KB');
    expect(message).toContain(`${String(RECOMMENDED_ICON_SIZE)}×${String(RECOMMENDED_ICON_SIZE)}`);
  });

  it('aceita o PNG que cabe, e grava o arquivo', async () => {
    // A borda de cima: exatamente o teto ainda passa.
    const response = await upload(WRITTEN_ICON, fileOf(PNG_HEAD, MAX_ICON_BYTES));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ icon: { bytes: number } }>().icon.bytes).toBe(MAX_ICON_BYTES);

    const written = readFileSync(join(projectRoot(), ITEM_ASSETS_DIR, WRITTEN_ICON));

    expect(written.length).toBe(MAX_ICON_BYTES);
  });
});

// ------------------------------------------------------------
//  A arte original, mandada por fora do painel
// ------------------------------------------------------------

describe('a arte original, sem passar pelo navegador', () => {
  it('recusa os 2,9 MB da medalha em português, e não com o erro do multipart', async () => {
    // O `fileSize` da rota corta a leitura muito antes de chegar ao
    // fim do arquivo — de propósito, para o agente não carregar 2,9
    // MB na memória só para recusá-los. Sem a tradução, o que volta
    // é "request file too large, please check multipart config".
    const response = await upload('trofeu_bleik_store.png', fileOf(PNG_HEAD, 2_949_869));
    const body = response.json<{ error: string; message: string }>();

    expect(response.statusCode).toBe(400);
    expect(body.error).toBe('ICON_TOO_LARGE');
    expect(body.message).not.toContain('multipart config');
    expect(body.message).toContain('33 KB');
    expect(body.message).toContain(`${String(RECOMMENDED_ICON_SIZE)}×${String(RECOMMENDED_ICON_SIZE)}`);
  });
});

// ------------------------------------------------------------
//  O que não é PNG
// ------------------------------------------------------------

describe('o formato', () => {
  it('recusa o JPEG renomeado para .png', async () => {
    // Ele chegaria ao FileStorage do servidor, ganharia um CRC
    // válido, e o sintoma seria um quadrado vazio no inventário sem
    // nada dizendo por quê.
    const response = await upload('disfarce.png', fileOf(JPEG_HEAD, 5_000));
    const body = response.json<{ error: string; message: string }>();

    expect(response.statusCode).toBe(400);
    expect(body.error).toBe('INVALID_ICON');
    expect(body.message).toContain('transparente');
  });

  it('recusa nome que não serve para uma linha de console', async () => {
    const response = await upload('meu ícone.png', fileOf(PNG_HEAD, 5_000));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('INVALID_ICON_NAME');
  });

  it('recusa quem manda o PNG fora de multipart', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/custom-items/icons',
      payload: { file: 'nada disso' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('INVALID_BODY');
  });
});
