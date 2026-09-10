// ============================================================
//  png-resize.ts  -  encolher um PNG sem depender de ninguém.
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  A logo do site tem 4048x1735 e o overlay a desenha em, no
//  máximo, 400x400 (ver `logoWidth`/`logoHeight` em types/ads).
//  Mandar o arquivo inteiro pelo RCON custava 667 KB em ~25
//  comandos para pintar um quadrado de 90 pixels — e o cliente
//  ainda montava uma textura de 28 MB na memória de vídeo de cada
//  jogador.
//
//  Antes daqui, o agente RECUSAVA: "a imagem tem 4048x1735 e o
//  limite é 1920x1080". A recusa dizia o número certo, mas
//  empurrava o dono a abrir editor de imagem para uma conta que a
//  máquina faz melhor.
//
//  ####  POR QUE SEM BIBLIOTECA  ####
//
//  `sharp` é binário nativo — e este agente é copiado para outra
//  máquina, onde um binário compilado para a errada quebra o
//  boot inteiro por causa de um logo. `jimp` traz megabytes de
//  JavaScript e um decodificador de tudo.
//
//  PNG de 8 bits, que é o caso, é zlib mais cinco filtros por
//  linha. O `node:zlib` já vem no Node, e o resto é o que está
//  neste arquivo.
//
//  ####  O QUE ELE NAO FAZ  ####
//
//    - JPEG. Decodificar JPEG é DCT, Huffman e subamostragem de
//      croma: outra ordem de grandeza de código, e a logo é PNG.
//      JPEG grande demais continua sendo recusado com o número.
//    - PNG entrelaçado (Adam7). São sete passadas com geometria
//      própria, e quase ninguém os gera.
//    - AUMENTAR. A conta aqui é média de área, que só faz sentido
//      encolhendo — e esticar um logo pequeno não conserta nada.
//
//  Nos três casos a resposta é `null`, e quem chama recusa como
//  recusava antes.
// ============================================================

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Teto de pixels que aceitamos descomprimir.
 *
 * ####  O CABECALHO E DE QUEM MANDOU A IMAGEM  ####
 *
 * Um IHDR dizendo 30000x30000 custa 13 bytes de arquivo e 3,6 GB
 * de RAM aqui dentro — o agente morreria de OOM ao preparar um
 * logo. 16 megapixels (uns 64 MB em RGBA) cobre com folga
 * qualquer coisa que alguém use de propaganda, e o que passa
 * disso vira recusa em vez de vira o processo.
 */
const MAX_DECODED_PIXELS = 16_000_000;

/** Uma imagem já descomprimida: RGBA, 8 bits por canal. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, linha a linha, sem padding. */
  readonly pixels: Buffer;
}

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
}

export interface ShrunkPng {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Encolhe o PNG até caber em `maxWidth` x `maxHeight`.
 *
 * A PROPORÇÃO é mantida: o overlay estica a imagem no retângulo
 * que o admin configurou, e chegar lá já distorcido seria
 * distorcer duas vezes.
 *
 * `null` quando não dá para encolher — não é PNG, é entrelaçado,
 * é grande demais para descomprimir, ou já cabe. Quem chama
 * decide o que dizer.
 */
export function shrinkPngToFit(
  bytes: Buffer,
  maxWidth: number,
  maxHeight: number,
): ShrunkPng | null {
  const image = decodePng(bytes);

  if (image === null) {
    return null;
  }

  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);

  if (scale >= 1) {
    return null;
  }

  // `floor` e não `round`: arredondar para cima devolveria 1921
  // de um alvo de 1920, e a conferência de quem chamou recusaria
  // a imagem que acabamos de consertar.
  const width = Math.max(1, Math.min(maxWidth, Math.floor(image.width * scale)));
  const height = Math.max(1, Math.min(maxHeight, Math.floor(image.height * scale)));

  const resized = resizeRgba(image, width, height);

  return { bytes: encodePng(resized), width, height };
}

/**
 * Descomprime um PNG para RGBA de 8 bits.
 *
 * Aceita profundidade de 1, 2, 4, 8 e 16 bits e os cinco tipos de
 * cor (cinza, RGB, paleta, cinza+alfa, RGBA) — o que um editor
 * qualquer produz. `null` para o resto.
 */
export function decodePng(bytes: Buffer): RasterImage | null {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  let header: PngHeader | null = null;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const data: Buffer[] = [];

  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;

    // +4 do CRC. Arquivo cortado no meio de um chunk não é
    // imagem: melhor `null` aqui do que uma exceção de leitura
    // fora do buffer três funções adiante.
    if (end + 4 > bytes.length) {
      return null;
    }

    if (type === 'IHDR') {
      if (length < 13) {
        return null;
      }

      header = {
        width: bytes.readUInt32BE(start),
        height: bytes.readUInt32BE(start + 4),
        bitDepth: bytes[start + 8] ?? 0,
        colorType: bytes[start + 9] ?? 0,
        interlace: bytes[start + 12] ?? 0,
      };
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = bytes.subarray(start, end);
    } else if (type === 'IDAT') {
      // Os dados podem vir partidos em vários IDAT, e o fluxo
      // zlib só existe depois de juntá-los na ordem.
      data.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }

    offset = end + 4;
  }

  if (header === null || data.length === 0) {
    return null;
  }

  if (header.interlace !== 0 || header.width <= 0 || header.height <= 0) {
    return null;
  }

  if (header.width * header.height > MAX_DECODED_PIXELS) {
    return null;
  }

  const channels = channelsOf(header.colorType);

  if (channels === null || !isValidDepth(header.colorType, header.bitDepth)) {
    return null;
  }

  let inflated: Buffer;

  try {
    inflated = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }

  const rows = unfilter(inflated, header, channels);

  if (rows === null) {
    return null;
  }

  return toRgba(rows, header, channels, palette, transparency);
}

/**
 * Média de área, que é o filtro certo para ENCOLHER.
 *
 * Pegar o pixel mais próximo (o barato) descarta a maior parte da
 * imagem: numa redução de 8x, 63 de cada 64 pixels sumiriam, e o
 * texto de uma logo viraria serrilhado. Aqui cada pixel de saída
 * é a média do retângulo de entrada que ele cobre.
 *
 * ####  A MEDIA E PONDERADA PELO ALFA  ####
 *
 * Pixel transparente costuma carregar cor qualquer por baixo
 * (preto, na maioria dos exportadores). Entrar na média como
 * cor faria a borda de um logo recortado escurecer — o "halo"
 * clássico. Ponderando por alfa, quem é invisível não vota na
 * cor, só na transparência.
 */
export function resizeRgba(image: RasterImage, width: number, height: number): RasterImage {
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceTop = Math.floor((y * image.height) / height);
    const sourceBottom = Math.max(sourceTop + 1, Math.ceil(((y + 1) * image.height) / height));

    for (let x = 0; x < width; x += 1) {
      const sourceLeft = Math.floor((x * image.width) / width);
      const sourceRight = Math.max(sourceLeft + 1, Math.ceil(((x + 1) * image.width) / width));

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;

      for (let sy = sourceTop; sy < Math.min(sourceBottom, image.height); sy += 1) {
        for (let sx = sourceLeft; sx < Math.min(sourceRight, image.width); sx += 1) {
          const at = (sy * image.width + sx) * 4;
          const a = image.pixels[at + 3] ?? 0;

          red += (image.pixels[at] ?? 0) * a;
          green += (image.pixels[at + 1] ?? 0) * a;
          blue += (image.pixels[at + 2] ?? 0) * a;
          alpha += a;
          count += 1;
        }
      }

      const to = (y * width + x) * 4;

      if (alpha === 0) {
        // Tudo invisível: a cor não importa, e dividir por zero
        // importaria muito.
        pixels[to + 3] = 0;
        continue;
      }

      pixels[to] = Math.round(red / alpha);
      pixels[to + 1] = Math.round(green / alpha);
      pixels[to + 2] = Math.round(blue / alpha);
      pixels[to + 3] = Math.round(alpha / count);
    }
  }

  return { width, height, pixels };
}

/**
 * Escreve o PNG de volta.
 *
 * ####  DUAS ESCOLHAS QUE VALEM BYTES  ####
 *
 *  - imagem sem nenhum pixel transparente sai em RGB, sem o canal
 *    alfa. É um quarto a menos de dado bruto, e o alfa constante
 *    não diz nada;
 *  - cada linha vai filtrada em Paeth. O filtro guarda a
 *    DIFERENÇA para os vizinhos em vez do valor, e é o que faz o
 *    zlib ter o que comprimir num degradê.
 */
export function encodePng(image: RasterImage): Buffer {
  const hasAlpha = hasTransparency(image);
  const channels = hasAlpha ? 4 : 3;
  const stride = image.width * channels;

  // +1 por linha: o byte que diz qual filtro ela usou.
  const raw = Buffer.alloc((stride + 1) * image.height);

  let previous = Buffer.alloc(stride);

  for (let y = 0; y < image.height; y += 1) {
    const line = Buffer.alloc(stride);

    for (let x = 0; x < image.width; x += 1) {
      const from = (y * image.width + x) * 4;
      const to = x * channels;

      line[to] = image.pixels[from] ?? 0;
      line[to + 1] = image.pixels[from + 1] ?? 0;
      line[to + 2] = image.pixels[from + 2] ?? 0;

      if (hasAlpha) {
        line[to + 3] = image.pixels[from + 3] ?? 0;
      }
    }

    const at = y * (stride + 1);
    raw[at] = 4;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (line[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;

      raw[at + 1 + i] = ((line[i] ?? 0) - paeth(a, b, c)) & 0xff;
    }

    previous = line;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(hasAlpha ? 6 : 2, 9);
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeUInt8(0, 12);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------
//  O MIUDO
// ------------------------------------------------------------

function channelsOf(colorType: number): number | null {
  switch (colorType) {
    case 0:
      return 1; // cinza
    case 2:
      return 3; // RGB
    case 3:
      return 1; // índice de paleta
    case 4:
      return 2; // cinza + alfa
    case 6:
      return 4; // RGBA
    default:
      return null;
  }
}

/**
 * As combinações que a especificação permite.
 *
 * Não é preciosismo: RGB de 4 bits não existe, e aceitá-lo faria
 * a leitura de amostras andar com um passo que não é o do
 * arquivo — lixo em vez de imagem, sem erro nenhum.
 */
function isValidDepth(colorType: number, bitDepth: number): boolean {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case 3:
      return [1, 2, 4, 8].includes(bitDepth);
    default:
      return bitDepth === 8 || bitDepth === 16;
  }
}

/**
 * Desfaz os filtros de linha e devolve as linhas cruas.
 *
 * Cada linha do PNG é guardada como a diferença para os vizinhos
 * de cima e da esquerda — e o vizinho da esquerda é o pixel JÁ
 * desfiltrado, não o do arquivo. Por isso isto é sequencial e
 * escreve no mesmo buffer que lê.
 */
function unfilter(inflated: Buffer, header: PngHeader, channels: number): Buffer | null {
  const bitsPerPixel = channels * header.bitDepth;

  // Abaixo de 8 bits por pixel, o "pixel anterior" do filtro é o
  // BYTE anterior — é o que a especificação manda.
  const pixelBytes = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((bitsPerPixel * header.width) / 8);

  if (inflated.length < (stride + 1) * header.height) {
    return null;
  }

  const rows = Buffer.alloc(stride * header.height);
  let at = 0;

  for (let y = 0; y < header.height; y += 1) {
    const filter = inflated[at] ?? 0;
    at += 1;

    const target = y * stride;
    const above = target - stride;

    for (let i = 0; i < stride; i += 1) {
      const value = inflated[at + i] ?? 0;
      const a = i >= pixelBytes ? (rows[target + i - pixelBytes] ?? 0) : 0;
      const b = y > 0 ? (rows[above + i] ?? 0) : 0;
      const c = i >= pixelBytes && y > 0 ? (rows[above + i - pixelBytes] ?? 0) : 0;

      let restored: number;

      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4:
          restored = value + paeth(a, b, c);
          break;
        default:
          // Filtro que não existe: o arquivo não é o que diz ser.
          return null;
      }

      rows[target + i] = restored & 0xff;
    }

    at += stride;
  }

  return rows;
}

/** Converte as linhas cruas para RGBA de 8 bits. */
function toRgba(
  rows: Buffer,
  header: PngHeader,
  channels: number,
  palette: Buffer | null,
  transparency: Buffer | null,
): RasterImage | null {
  if (header.colorType === 3 && palette === null) {
    return null;
  }

  const stride = Math.ceil((channels * header.bitDepth * header.width) / 8);
  const pixels = Buffer.alloc(header.width * header.height * 4);
  const max = (1 << header.bitDepth) - 1;

  // A cor declarada transparente em imagens SEM canal alfa
  // (tRNS de cinza ou de RGB). Vem sempre em 16 bits, mesmo
  // quando a imagem é de 8.
  const keyed = colorKeyOf(header, transparency);

  for (let y = 0; y < header.height; y += 1) {
    const line = rows.subarray(y * stride, (y + 1) * stride);

    for (let x = 0; x < header.width; x += 1) {
      const to = (y * header.width + x) * 4;
      // Sem valor inicial: os ramos abaixo cobrem todos os tipos
      // de cor, e um zero aqui só esconderia o que faltasse.
      let red: number;
      let green: number;
      let blue: number;
      let alpha = 255;

      if (header.colorType === 3) {
        const index = sampleOf(line, x, header.bitDepth);
        const from = index * 3;

        if (from + 2 >= (palette?.length ?? 0)) {
          return null;
        }

        red = palette?.[from] ?? 0;
        green = palette?.[from + 1] ?? 0;
        blue = palette?.[from + 2] ?? 0;
        // tRNS de paleta é uma lista de alfas na ordem das cores;
        // o que ela não cobre é opaco.
        alpha = transparency?.[index] ?? 255;
      } else if (header.colorType === 0 || header.colorType === 4) {
        const raw = sampleOf(line, x * channels, header.bitDepth);
        const gray = scale(raw, max, header.bitDepth);

        red = gray;
        green = gray;
        blue = gray;

        if (header.colorType === 4) {
          alpha = scale(sampleOf(line, x * channels + 1, header.bitDepth), max, header.bitDepth);
        } else if (keyed !== null && raw === keyed[0]) {
          alpha = 0;
        }
      } else {
        const rawRed = sampleOf(line, x * channels, header.bitDepth);
        const rawGreen = sampleOf(line, x * channels + 1, header.bitDepth);
        const rawBlue = sampleOf(line, x * channels + 2, header.bitDepth);

        red = scale(rawRed, max, header.bitDepth);
        green = scale(rawGreen, max, header.bitDepth);
        blue = scale(rawBlue, max, header.bitDepth);

        if (header.colorType === 6) {
          alpha = scale(sampleOf(line, x * channels + 3, header.bitDepth), max, header.bitDepth);
        } else if (keyed !== null && rawRed === keyed[0] && rawGreen === keyed[1] && rawBlue === keyed[2]) {
          alpha = 0;
        }
      }

      pixels[to] = red;
      pixels[to + 1] = green;
      pixels[to + 2] = blue;
      pixels[to + 3] = alpha;
    }
  }

  return { width: header.width, height: header.height, pixels };
}

/**
 * A cor que o tRNS declara invisível, em imagens sem canal alfa.
 *
 * `null` quando não há tRNS ou quando a imagem tem alfa próprio
 * (aí o chunk trata de paleta, não de cor).
 */
function colorKeyOf(header: PngHeader, transparency: Buffer | null): readonly number[] | null {
  if (transparency === null) {
    return null;
  }

  if (header.colorType === 0 && transparency.length >= 2) {
    return [transparency.readUInt16BE(0)];
  }

  if (header.colorType === 2 && transparency.length >= 6) {
    return [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)];
  }

  return null;
}

/**
 * A amostra de índice `index` da linha, seja qual for a
 * profundidade.
 *
 * De 16 bits só o byte ALTO sobrevive: o destino tem 8, e o byte
 * baixo é ruído abaixo do que a tela mostra.
 */
function sampleOf(line: Buffer, index: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return line[index] ?? 0;
  }

  if (bitDepth === 16) {
    return line[index * 2] ?? 0;
  }

  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)] ?? 0;
  const shift = 8 - bitDepth * ((index % perByte) + 1);

  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/** Leva a amostra para 0..255 — de 16 bits ela já veio pronta. */
function scale(value: number, max: number, bitDepth: number): number {
  if (bitDepth >= 8) {
    return value;
  }

  return Math.round((value * 255) / max);
}

function hasTransparency(image: RasterImage): boolean {
  for (let at = 3; at < image.pixels.length; at += 4) {
    if (image.pixels[at] !== 255) {
      return true;
    }
  }

  return false;
}

/**
 * O preditor de Paeth: entre o vizinho da esquerda, o de cima e o
 * da diagonal, escolhe o que está mais perto da soma dos dois
 * primeiros menos o terceiro.
 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  if (pa <= pb && pa <= pc) {
    return a;
  }

  return pb <= pc ? b : c;
}

/** Um chunk do arquivo: tamanho, tipo, dado e CRC do par tipo+dado. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);

  return Buffer.concat([length, typed, crc]);
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
}

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;

  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}
