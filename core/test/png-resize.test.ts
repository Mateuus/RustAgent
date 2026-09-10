// ============================================================
//  Testes do ENCOLHEDOR DE PNG.
//
//  O que estes testes protegem, e não é óbvio:
//
//    - o formato de saída é PNG DE VERDADE. Um arquivo que só o
//      nosso decodificador entende passaria em qualquer teste de
//      ida e volta e apareceria como retângulo vazio no jogo, sem
//      erro em lugar nenhum — por isso o `zlib` confere o CRC de
//      cada chunk aqui;
//    - a cor de um pixel invisível NÃO entra na média. É o que
//      separa uma borda limpa do halo escuro clássico;
//    - o que não sabemos encolher devolve `null`, e não uma
//      exceção: quem chama trata `null` como recusa e continua.
// ============================================================

import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  decodePng,
  encodePng,
  resizeRgba,
  shrinkPngToFit,
  type RasterImage,
} from '../src/game/png-resize.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Uma imagem em RGBA, pintada por uma função. */
function paint(
  width: number,
  height: number,
  color: (x: number, y: number) => readonly [number, number, number, number],
): RasterImage {
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = color(x, y);
      const at = (y * width + x) * 4;

      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = a;
    }
  }

  return { width, height, pixels };
}

function pixelAt(image: RasterImage, x: number, y: number): readonly number[] {
  const at = (y * image.width + x) * 4;
  return [...image.pixels.subarray(at, at + 4)];
}

/**
 * Monta um PNG à mão, chunk a chunk.
 *
 * Existe para produzir o que o NOSSO codificador nunca produz —
 * paleta, cinza de 4 bits, entrelaçado — que é justamente o que
 * o decodificador precisa aguentar.
 */
function buildPng(
  header: {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace?: number;
  },
  rows: readonly (readonly number[])[],
  extra: readonly { type: string; data: Buffer }[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(header.width, 0);
  ihdr.writeUInt32BE(header.height, 4);
  ihdr.writeUInt8(header.bitDepth, 8);
  ihdr.writeUInt8(header.colorType, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(header.interlace ?? 0, 12);

  // Filtro 0 (nenhum) em cada linha: o teste quer conferir a
  // leitura das amostras, não a dos filtros.
  const raw = Buffer.concat(rows.map((row) => Buffer.from([0, ...row])));

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...extra.map((one) => chunk(one.type, one.data)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);

  return Buffer.concat([length, typed, crc]);
}

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;

  for (const byte of bytes) {
    c ^= byte;

    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }

  return (c ^ 0xffffffff) >>> 0;
}

/** Lê os chunks do arquivo conferindo o CRC de cada um. */
function chunksOf(bytes: Buffer): { type: string; ok: boolean }[] {
  const found: { type: string; ok: boolean }[] = [];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    const declared = bytes.readUInt32BE(offset + 8 + length);

    found.push({ type, ok: crc32(body) === declared });

    offset += 12 + length;

    if (type === 'IEND') {
      break;
    }
  }

  return found;
}

describe('encodePng', () => {
  it('escreve um arquivo com assinatura, chunks na ordem e CRC válido', () => {
    const file = encodePng(paint(4, 3, () => [10, 20, 30, 255]));

    expect(file.subarray(0, 8)).toEqual(SIGNATURE);
    expect(chunksOf(file)).toEqual([
      { type: 'IHDR', ok: true },
      { type: 'IDAT', ok: true },
      { type: 'IEND', ok: true },
    ]);
  });

  it('imagem sem transparência sai sem canal alfa', () => {
    const opaca = encodePng(paint(8, 8, (x) => [x * 30, 0, 0, 255]));
    const comAlfa = encodePng(paint(8, 8, (x) => [x * 30, 0, 0, 128]));

    // O tipo de cor mora no byte 9 do IHDR: 2 = RGB, 6 = RGBA.
    expect(opaca[25]).toBe(2);
    expect(comAlfa[25]).toBe(6);
  });

  it('ida e volta devolve os mesmos pixels', () => {
    const original = paint(17, 5, (x, y) => [x * 10, y * 40, 255 - x * 5, x % 3 === 0 ? 128 : 255]);
    const voltou = decodePng(encodePng(original));

    expect(voltou?.width).toBe(17);
    expect(voltou?.height).toBe(5);
    expect(voltou?.pixels).toEqual(original.pixels);
  });
});

describe('decodePng', () => {
  it('lê RGB de 8 bits', () => {
    const file = buildPng({ width: 2, height: 1, bitDepth: 8, colorType: 2 }, [
      [255, 0, 0, 0, 0, 255],
    ]);

    const image = decodePng(file);

    expect(pixelAt(image!, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(image!, 1, 0)).toEqual([0, 0, 255, 255]);
  });

  it('lê paleta com transparência por cor', () => {
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const file = buildPng(
      { width: 3, height: 1, bitDepth: 8, colorType: 3 },
      [[0, 1, 2]],
      [
        { type: 'PLTE', data: palette },
        // Só a primeira cor tem alfa declarado; o resto é opaco.
        { type: 'tRNS', data: Buffer.from([0]) },
      ],
    );

    const image = decodePng(file);

    expect(pixelAt(image!, 0, 0)).toEqual([255, 0, 0, 0]);
    expect(pixelAt(image!, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(image!, 2, 0)).toEqual([0, 0, 255, 255]);
  });

  it('lê cinza de 4 bits levando as amostras para 0..255', () => {
    // Duas amostras por byte: 0x0f = 0 e 15, os dois extremos.
    const file = buildPng({ width: 2, height: 1, bitDepth: 4, colorType: 0 }, [[0x0f]]);

    const image = decodePng(file);

    expect(pixelAt(image!, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(image!, 1, 0)).toEqual([255, 255, 255, 255]);
  });

  it('lê 16 bits ficando com o byte alto', () => {
    const file = buildPng({ width: 1, height: 1, bitDepth: 16, colorType: 2 }, [
      [0xab, 0xcd, 0x00, 0x11, 0xff, 0xff],
    ]);

    expect(pixelAt(decodePng(file)!, 0, 0)).toEqual([0xab, 0x00, 0xff, 255]);
  });

  it('recusa entrelaçado, formato desconhecido e arquivo cortado', () => {
    const entrelacado = buildPng(
      { width: 2, height: 1, bitDepth: 8, colorType: 2, interlace: 1 },
      [[1, 2, 3, 4, 5, 6]],
    );

    expect(decodePng(entrelacado)).toBeNull();
    expect(decodePng(Buffer.from('GIF89a', 'ascii'))).toBeNull();
    expect(decodePng(Buffer.alloc(0))).toBeNull();

    const inteiro = encodePng(paint(4, 4, () => [1, 2, 3, 255]));
    expect(decodePng(inteiro.subarray(0, inteiro.length - 20))).toBeNull();
  });

  it('cabeçalho que promete pixels demais é recusado antes de alocar', () => {
    // 30000x30000 custa 13 bytes de arquivo e gigabytes de RAM.
    const mentiroso = buildPng({ width: 30_000, height: 30_000, bitDepth: 8, colorType: 2 }, [
      [0, 0, 0],
    ]);

    expect(decodePng(mentiroso)).toBeNull();
  });

  it('IDAT que não descomprime é recusado, e não estoura', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(2, 9);

    const quebrado = Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', Buffer.from([0x00, 0x01, 0x02, 0x03])),
      chunk('IEND', Buffer.alloc(0)),
    ]);

    expect(decodePng(quebrado)).toBeNull();
  });
});

describe('resizeRgba', () => {
  it('a média é de ÁREA, e não do pixel mais próximo', () => {
    // Tabuleiro preto e branco: a média de qualquer quadrado é
    // cinza. Quem pega o vizinho mais próximo devolveria 0 ou 255.
    const tabuleiro = paint(8, 8, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

    const menor = resizeRgba(tabuleiro, 2, 2);

    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      expect(pixelAt(menor, x, y)[0]).toBeCloseTo(128, -1);
    }
  });

  it('pixel invisível não empurra a cor da média', () => {
    // Metade branca opaca, metade PRETA invisível. Sem a
    // ponderação por alfa isto viraria cinza — o halo.
    const meioInvisivel = paint(2, 1, (x) =>
      x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0],
    );

    const menor = resizeRgba(meioInvisivel, 1, 1);

    expect(pixelAt(menor, 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it('tudo invisível não divide por zero', () => {
    const nada = paint(4, 4, () => [90, 90, 90, 0]);

    expect(pixelAt(resizeRgba(nada, 2, 2), 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('shrinkPngToFit', () => {
  it('encolhe mantendo a proporção e cabendo no teto', () => {
    const grande = encodePng(paint(1000, 400, (x, y) => [x % 256, y % 256, 128, 255]));

    const menor = shrinkPngToFit(grande, 100, 100);

    // 1000x400 dentro de 100x100 é limitado pela LARGURA.
    expect(menor?.width).toBe(100);
    expect(menor?.height).toBe(40);
    expect(menor!.bytes.length).toBeLessThan(grande.length);

    const lido = decodePng(menor!.bytes);
    expect(lido?.width).toBe(100);
    expect(lido?.height).toBe(40);
  });

  it('nunca devolve um pixel a mais que o teto', () => {
    // 999 e 501 são os arredondamentos que estouram o alvo se a
    // conta usar `round` em vez de `floor`.
    const grande = encodePng(paint(999, 501, () => [1, 2, 3, 255]));
    const menor = shrinkPngToFit(grande, 500, 500);

    expect(menor!.width).toBeLessThanOrEqual(500);
    expect(menor!.height).toBeLessThanOrEqual(500);
  });

  it('o que já cabe devolve null — encolher seria só perder pixel', () => {
    const pequeno = encodePng(paint(50, 50, () => [1, 2, 3, 255]));

    expect(shrinkPngToFit(pequeno, 500, 500)).toBeNull();
  });

  it('o que não é PNG devolve null', () => {
    expect(shrinkPngToFit(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 100, 100)).toBeNull();
  });

  it('imagem de uma linha não vira zero', () => {
    const fita = encodePng(paint(400, 1, () => [255, 0, 0, 255]));
    const menor = shrinkPngToFit(fita, 40, 40);

    expect(menor?.height).toBe(1);
    expect(menor?.width).toBe(40);
  });
});
