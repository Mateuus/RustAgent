// ============================================================
//  Testes do CACHE DE IMAGENS das propagandas.
//
//  O que estes testes protegem, e não é óbvio:
//
//    - a recusa por FORMATO vem do conteúdo do arquivo, e não do
//      Content-Type. Um servidor que jura ser PNG e manda outra
//      coisa produziria um retângulo vazio no jogo, sem erro
//      nenhum em lugar nenhum;
//    - o corte em pedaços é feito nos BYTES. Cortado no base64,
//      cada pedaço deixaria de decodificar sozinho e o plugin
//      teria de saber remontar antes de decodificar;
//    - a chave sai do CONTEÚDO. É o que faz a mesma imagem em
//      duas propagandas ocupar uma entrada só.
// ============================================================

import { describe, expect, it, vi } from 'vitest';

import {
  AdImageError,
  buildImageBeginCommand,
  buildImagePartCommand,
  chunkImage,
  fetchAdImage,
  imageKeyOf,
  probeImage,
} from '../src/game/ads-images.js';

/** PNG mínimo válido: assinatura + IHDR com largura e altura. */
function fakePng(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.alloc(24 + padding);

  header.writeUInt8(0x89, 0);
  header.write('PNG', 1, 'ascii');
  header.writeUInt8(0x0d, 4);
  header.writeUInt8(0x0a, 5);
  header.writeUInt8(0x1a, 6);
  header.writeUInt8(0x0a, 7);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);

  return header;
}

/** JPEG mínimo: SOI, um segmento qualquer, e um SOF0 com tamanho. */
function fakeJpeg(width: number, height: number): Buffer {
  const parts: number[] = [0xff, 0xd8, 0xff];

  // APP0 de 16 bytes, só para o SOF não ser o primeiro segmento —
  // é essa varredura que o parser precisa fazer certo.
  parts.push(0xe0, 0x00, 0x10);
  for (let i = 0; i < 14; i += 1) parts.push(0x00);

  // SOF0: marcador, tamanho, precisão, altura, largura.
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  for (let i = 0; i < 8; i += 1) parts.push(0x00);

  return Buffer.from(parts);
}

function respondWith(bytes: Buffer, ok = true): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      arrayBuffer: async () =>
        Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
    } as unknown as Response),
  ) as unknown as typeof fetch;
}

describe('probeImage', () => {
  it('lê largura e altura de um PNG', () => {
    expect(probeImage(fakePng(600, 200))).toEqual({
      mime: 'image/png',
      width: 600,
      height: 200,
    });
  });

  it('lê largura e altura de um JPEG, pulando os metadados', () => {
    expect(probeImage(fakeJpeg(800, 250))).toEqual({
      mime: 'image/jpeg',
      width: 800,
      height: 250,
    });
  });

  it('devolve null para o que não é PNG nem JPEG', () => {
    // Cabeçalho de GIF: o cliente do Rust não monta.
    expect(probeImage(Buffer.from('GIF89a....', 'ascii'))).toBeNull();
    expect(probeImage(Buffer.from([0x00, 0x01, 0x02]))).toBeNull();
    expect(probeImage(Buffer.alloc(0))).toBeNull();
  });

  it('PNG truncado no meio do cabeçalho não estoura', () => {
    expect(probeImage(fakePng(600, 200).subarray(0, 12))).toBeNull();
  });

  it('JPEG corrompido termina a varredura em vez de girar para sempre', () => {
    // Bytes que parecem JPEG mas cujo primeiro "segmento" tem
    // tamanho zero: sem o teto de voltas, o offset nunca avança.
    const lixo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(probeImage(lixo)).toBeNull();
  });
});

describe('fetchAdImage', () => {
  it('devolve bytes, dimensões e uma chave derivada do conteúdo', async () => {
    const bytes = fakePng(600, 200);
    const image = await fetchAdImage('https://exemplo.com/a.png', {
      fetchImpl: respondWith(bytes),
    });

    expect(image.width).toBe(600);
    expect(image.height).toBe(200);
    expect(image.mime).toBe('image/png');
    expect(image.key).toBe(imageKeyOf(image.sha));
    // A chave viaja num comando de console separado por espaço.
    expect(image.key).toMatch(/^ad[0-9a-f]{12}$/);
  });

  it('o mesmo conteúdo em dois endereços dá a MESMA chave', async () => {
    const bytes = fakePng(600, 200);

    const a = await fetchAdImage('https://um.com/a.png', { fetchImpl: respondWith(bytes) });
    const b = await fetchAdImage('https://outro.com/b.png', { fetchImpl: respondWith(bytes) });

    expect(a.key).toBe(b.key);
  });

  it('recusa o que não é PNG nem JPEG, dizendo o porquê', async () => {
    await expect(
      fetchAdImage('https://exemplo.com/a.gif', {
        fetchImpl: respondWith(Buffer.from('GIF89a....', 'ascii')),
      }),
    ).rejects.toThrow(AdImageError);

    await fetchAdImage('https://exemplo.com/a.gif', {
      fetchImpl: respondWith(Buffer.from('GIF89a....', 'ascii')),
    }).catch((error: unknown) => {
      // A mensagem é o que a tela mostra ao admin: ela precisa
      // dizer o que fazer, e não só que falhou.
      expect((error as Error).message).toContain('PNG');
    });
  });

  it('recusa por tamanho dizendo o número', async () => {
    const grande = fakePng(600, 200, 100_000);

    await fetchAdImage('https://exemplo.com/a.png', {
      fetchImpl: respondWith(grande),
      maxBytes: 1000,
    }).then(
      () => expect.unreachable('deveria ter recusado'),
      (error: unknown) => {
        expect((error as AdImageError).code).toBe('TOO_LARGE');
        expect((error as Error).message).toMatch(/KB/);
      },
    );
  });

  it('recusa por dimensão', async () => {
    await fetchAdImage('https://exemplo.com/a.png', {
      fetchImpl: respondWith(fakePng(4000, 3000)),
    }).then(
      () => expect.unreachable('deveria ter recusado'),
      (error: unknown) => {
        expect((error as AdImageError).code).toBe('TOO_BIG');
        expect((error as Error).message).toContain('4000x3000');
      },
    );
  });

  it('resposta HTTP de erro vira recusa com o status', async () => {
    await fetchAdImage('https://exemplo.com/nao-existe.png', {
      fetchImpl: respondWith(Buffer.alloc(10), false),
    }).then(
      () => expect.unreachable('deveria ter recusado'),
      (error: unknown) => {
        expect((error as Error).message).toContain('404');
      },
    );
  });

  it('arquivo vazio é recusado antes de qualquer análise', async () => {
    await fetchAdImage('https://exemplo.com/vazio.png', {
      fetchImpl: respondWith(Buffer.alloc(0)),
    }).then(
      () => expect.unreachable('deveria ter recusado'),
      (error: unknown) => {
        expect((error as AdImageError).code).toBe('EMPTY');
      },
    );
  });

  it('endereço inalcançável vira recusa, e não exceção crua', async () => {
    const falha = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')));

    await fetchAdImage('https://exemplo.com/a.png', {
      fetchImpl: falha as unknown as typeof fetch,
    }).then(
      () => expect.unreachable('deveria ter recusado'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(AdImageError);
        expect((error as AdImageError).code).toBe('FETCH_FAILED');
      },
    );
  });
});

describe('o corte em pedaços', () => {
  it('cada pedaço decodifica SOZINHO', () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const parts = chunkImage(bytes, 300);

    expect(parts).toHaveLength(4);

    // É esta propriedade que permite ao plugin decodificar pedaço
    // a pedaço em vez de juntar strings antes.
    const remontado = Buffer.concat(parts.map((part) => Buffer.from(part, 'base64')));
    expect(remontado.equals(bytes)).toBe(true);
  });

  it('imagem menor que um pedaço vira um pedaço só', () => {
    expect(chunkImage(Buffer.alloc(10), 300)).toHaveLength(1);
  });

  it('os comandos não têm espaço fora dos separadores', () => {
    const begin = buildImageBeginCommand('adabc123', 3);
    expect(begin.split(' ')).toHaveLength(3);

    const part = buildImagePartCommand('adabc123', 0, 'AAAA');
    expect(part.split(' ')).toHaveLength(4);
  });
});
