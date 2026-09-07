// ============================================================
//  icon-image.test.ts  -  o resize que o painel faz sozinho.
//
//  ####  O QUE ESTE ARQUIVO GUARDA  ####
//
//    1. o TAMANHO escolhido — e, principalmente, que ele nunca
//       AUMENTA: uma arte de 64 px esticada para 96 não ganha
//       detalhe, ganha peso;
//    2. a TRANSPARÊNCIA. A medalha é redonda sobre fundo
//       transparente e a arte inteira tem alfa: um caminho que o
//       achatasse entregaria um quadrado preto no slot do
//       inventário, sem erro nenhum pelo caminho;
//    3. que um arquivo que NÃO É PNG é recusado antes de qualquer
//       processamento — nem o decodificador chega a ser chamado;
//    4. a FRASE que a tela mostra ("2,9 MB → 96×96, 25 KB"), porque
//       quem cadastra precisa saber que o arquivo que ele escolheu
//       não é o que subiu.
//
//  ####  POR QUE UM CANVAS DE MENTIRA  ####
//
//  O vitest do painel roda em node puro, sem DOM — e é de propósito
//  (ver vitest.config.mts). O duplo daqui não desenha pixel nenhum:
//  ele registra o que o módulo PEDIU ao canvas, que é onde as três
//  decisões que preservam o alfa moram — contexto sem `alpha:
//  false`, nenhum preenchimento de fundo, e `toBlob` em PNG.
//
//  O resultado visual foi MEDIDO à parte, no Chrome 152, com a arte
//  real do Troféu Bleik: 96×96 saiu com 25.060 bytes, 1.917 pixels
//  totalmente transparentes e ZERO pixels de borda escurecidos. Os
//  números deste arquivo vêm dessa medição.
// ============================================================

import { afterEach, describe, expect, it } from 'vitest';

import {
  ICON_SIZE,
  MAX_ICON_BYTES,
  MIN_ICON_SIZE,
  describeIconResize,
  formatBytes,
  iconSizeLadder,
  isPngBytes,
  planIconSize,
  toIconFile,
} from '@/lib/icon-image';

// ------------------------------------------------------------
//  A arte do dono, como ela é
// ------------------------------------------------------------

/** `Docs/TrofeuBleik/trofeu_bleik_store.png`, medido em 06/09/2026. */
const TROPHY = { width: 1254, height: 1254, bytes: 2_949_869 };

/** Os oito bytes que abrem todo PNG. */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Os três primeiros de um JPEG — o disfarce mais provável. */
const JPEG_HEAD = [0xff, 0xd8, 0xff];

// ------------------------------------------------------------
//  O canvas de mentira
// ------------------------------------------------------------

interface DrawnCanvas {
  /** O lado que o módulo pediu. */
  readonly size: number;
  /** O que foi passado ao `getContext` — `undefined` é o certo. */
  readonly contextOptions: unknown;
  /** O tipo pedido ao `toBlob`. */
  mime: string | undefined;
  /** Quantas vezes alguém pintou o fundo. Tem de ficar em zero. */
  fills: number;
}

interface FakeCanvasWorld {
  /** Um por chamada de `drawToPng`, na ordem em que aconteceram. */
  readonly canvases: DrawnCanvas[];
  /** Quantas vezes a imagem foi decodificada. */
  readonly decoded: { count: number };
}

/**
 * Instala `document` e `createImageBitmap` no ambiente do teste.
 *
 * @param bytesForSize quantos bytes o PNG daquele lado teria. É o
 * que faz o laço de redução ser exercitado de verdade: o módulo só
 * sabe se coube DEPOIS de comprimir.
 */
function installFakeCanvas(bytesForSize: (size: number) => number): FakeCanvasWorld {
  const world: FakeCanvasWorld = { canvases: [], decoded: { count: 0 } };

  const createElement = (tag: string): unknown => {
    if (tag !== 'canvas') {
      throw new Error(`o módulo pediu um <${tag}>, e só devia pedir <canvas>`);
    }

    const record: DrawnCanvas = { size: 0, contextOptions: undefined, mime: undefined, fills: 0 };
    const canvas = {
      width: 0,
      height: 0,
      getContext(_type: string, options?: unknown) {
        // O lado é lido AQUI porque o módulo escreve width/height
        // antes de pedir o contexto.
        Object.assign(record, { size: canvas.width, contextOptions: options });
        world.canvases.push(record);

        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage() {
            /* o desenho em si não é o que este teste mede */
          },
          // Existem para serem CONTADOS: pintar o fundo é o gesto
          // que achata a transparência.
          fillRect() {
            record.fills += 1;
          },
          set fillStyle(_value: string) {
            record.fills += 1;
          },
        };
      },
      toBlob(callback: (blob: Blob | null) => void, mime?: string) {
        record.mime = mime;

        const bytes = new Uint8Array(bytesForSize(canvas.width));

        PNG_HEAD.forEach((byte, index) => (bytes[index] = byte));
        callback(new Blob([bytes], { type: mime }));
      },
    };

    return canvas;
  };

  globalThis.document = { createElement } as unknown as Document;
  globalThis.createImageBitmap = (async (source: Blob) => {
    world.decoded.count += 1;

    const measured = SIZES.get(source);

    return {
      width: measured?.width ?? TROPHY.width,
      height: measured?.height ?? TROPHY.height,
      close() {
        /* nada a soltar num bitmap de mentira */
      },
    };
  }) as unknown as typeof createImageBitmap;

  return world;
}

/** As dimensões de cada arquivo de teste, já que ninguém decodifica nada. */
const SIZES = new Map<Blob, { width: number; height: number }>();

/** Um arquivo com o cabeçalho pedido e o peso pedido. */
function fileOf(
  name: string,
  head: readonly number[],
  bytes: number,
  measure?: { width: number; height: number },
): File {
  const content = new Uint8Array(Math.max(bytes, head.length));

  head.forEach((byte, index) => (content[index] = byte));

  const file = new File([content], name, { type: 'image/png' });

  if (measure !== undefined) {
    SIZES.set(file, measure);
  }

  return file;
}

/** A arte da medalha, com os bytes que o Chrome 152 mediu por lado. */
const MEASURED_PNG_BYTES = new Map([
  [96, 25_060],
  [80, 17_649],
  [72, 14_600],
  [64, 11_600],
  [54, 8_400],
  [48, 6_800],
  [40, 4_900],
  [36, 4_000],
  [32, 3_300],
]);

function trophyBytes(size: number): number {
  return MEASURED_PNG_BYTES.get(size) ?? size * size * 3;
}

afterEach(() => {
  SIZES.clear();
  // O ambiente do vitest é node: deixar um `document` de mentira
  // para trás mudaria o teste seguinte sem ninguém perceber.
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});

// ------------------------------------------------------------
//  O tamanho
// ------------------------------------------------------------

describe('o tamanho do ícone', () => {
  it('leva a arte do dono (1254×1254) para 96×96', () => {
    // O maior lado que CABE COM FOLGA: 112×112 desta mesma arte dá
    // 33.478 bytes e estoura o teto por 478.
    expect(planIconSize(TROPHY)).toBe(ICON_SIZE);
  });

  it('NÃO aumenta a arte que já é menor', () => {
    // Esticar 64 para 96 não inventa detalhe nenhum — inventa
    // pixels, e o PNG passa a gravá-los.
    expect(planIconSize({ width: 64, height: 64 })).toBe(64);
    expect(planIconSize({ width: 32, height: 48 })).toBe(48);
    expect(planIconSize({ width: 1, height: 1 })).toBe(1);
  });

  it('decide pelo MAIOR lado numa arte retangular', () => {
    // Uma faixa de 200×50 precisa encolher (o 200 não cabe); uma
    // etiqueta de 50×20 não precisa.
    expect(planIconSize({ width: 200, height: 50 })).toBe(ICON_SIZE);
    expect(planIconSize({ width: 50, height: 200 })).toBe(ICON_SIZE);
    expect(planIconSize({ width: 50, height: 20 })).toBe(50);
  });

  it('aceita dimensão fracionária sem devolver lado quebrado', () => {
    expect(planIconSize({ width: 60.7, height: 30 })).toBe(60);
  });
});

describe('a escada de tentativas', () => {
  it('começa no tamanho escolhido e termina no menor aceitável', () => {
    expect(iconSizeLadder(TROPHY)).toEqual([96, 72, 54, 40, MIN_ICON_SIZE]);
  });

  it('começa menor quando a arte já é pequena', () => {
    expect(iconSizeLadder({ width: 64, height: 64 })).toEqual([64, 48, 36, MIN_ICON_SIZE]);
  });

  it('não desce abaixo do menor aceitável', () => {
    expect(Math.min(...iconSizeLadder(TROPHY))).toBe(MIN_ICON_SIZE);
  });

  it('não tem escada nenhuma para a arte que já nasceu miúda', () => {
    // 20×20 fica em 20: descer mais a apagaria, e subir até 32 seria
    // exatamente o upscale que a regra do tamanho proíbe.
    expect(iconSizeLadder({ width: 20, height: 20 })).toEqual([20]);
  });
});

// ------------------------------------------------------------
//  A recusa do que não é PNG
// ------------------------------------------------------------

describe('o arquivo precisa ser PNG', () => {
  it('reconhece a assinatura', () => {
    expect(isPngBytes(new Uint8Array(PNG_HEAD))).toBe(true);
  });

  it('recusa JPEG, arquivo vazio e cabeçalho cortado', () => {
    expect(isPngBytes(new Uint8Array(JPEG_HEAD))).toBe(false);
    expect(isPngBytes(new Uint8Array(0))).toBe(false);
    expect(isPngBytes(new Uint8Array(PNG_HEAD.slice(0, 4)))).toBe(false);
  });

  it('recusa ANTES de decodificar — o JPG renomeado nem chega ao canvas', async () => {
    // Um JPG decodifica sem erro e viraria um PNG OPACO: um quadrado
    // no slot, no lugar da medalha recortada. E recusar antes evita
    // decodificar megabytes para depois jogar fora.
    const world = installFakeCanvas(trophyBytes);
    const disguised = fileOf('medalha.png', JPEG_HEAD, 800_000, TROPHY);

    await expect(toIconFile(disguised)).rejects.toThrow(/não é um PNG/i);

    expect(world.decoded.count).toBe(0);
    expect(world.canvases).toHaveLength(0);
  });
});

// ------------------------------------------------------------
//  A redução de ponta a ponta
// ------------------------------------------------------------

describe('a redução', () => {
  it('leva a arte do dono a caber, e conta o que fez', async () => {
    const world = installFakeCanvas(trophyBytes);
    const result = await toIconFile(fileOf('Troféu Bleik Store.png', PNG_HEAD, TROPHY.bytes, TROPHY));

    expect(result.icon).toEqual({ width: 96, height: 96, bytes: 25_060 });
    expect(result.icon.bytes).toBeLessThanOrEqual(MAX_ICON_BYTES);
    expect(result.source).toEqual(TROPHY);
    expect(result.summary).toBe('2,9 MB → 96×96, 25 KB');

    // O nome viaja num comando de console, onde espaço separa
    // argumentos — e o acento não sobrevive ao caminho.
    expect(result.file.name).toBe('trofeu_bleik_store.png');
    expect(result.file.size).toBe(25_060);

    // Uma volta só: a medalha cabe no primeiro degrau.
    expect(world.canvases.map((canvas) => canvas.size)).toEqual([96]);
  });

  it('desce a escada quando o primeiro degrau não cabe', async () => {
    // Uma arte fotográfica, que comprime mal: só o terceiro degrau
    // entra no teto.
    const world = installFakeCanvas((size) => (size >= 72 ? 40_000 : 20_000));
    const result = await toIconFile(fileOf('foto.png', PNG_HEAD, 5_000_000, TROPHY));

    expect(world.canvases.map((canvas) => canvas.size)).toEqual([96, 72, 54]);
    expect(result.icon.width).toBe(54);
  });

  it('recusa com frase quando nem o menor lado cabe, dizendo o tamanho', async () => {
    installFakeCanvas(() => 90_000);

    await expect(toIconFile(fileOf('impossivel.png', PNG_HEAD, 9_000_000, TROPHY))).rejects.toThrow(
      /33 KB[\s\S]*32×32[\s\S]*90 KB/,
    );
  });

  it('não aumenta a arte pequena — o canvas sai do tamanho dela', async () => {
    const world = installFakeCanvas(() => 3_000);
    const small = { width: 48, height: 48 };
    const result = await toIconFile(fileOf('pequeno.png', PNG_HEAD, 4_000, small));

    expect(world.canvases.map((canvas) => canvas.size)).toEqual([48]);
    expect(result.icon).toEqual({ width: 48, height: 48, bytes: 3_000 });
    expect(result.summary).toContain('a arte já cabia');
  });
});

// ------------------------------------------------------------
//  A transparência
// ------------------------------------------------------------

describe('a transparência', () => {
  it('não achata o alfa: contexto com alfa, sem fundo pintado, saída em PNG', async () => {
    // As três formas de perder o canal alfa sem erro nenhum:
    //
    //   1. `getContext('2d', { alpha: false })` — o canvas nasce
    //      preto opaco e a sobra do desenho contido vira moldura;
    //   2. um `fillRect` "para limpar" antes de desenhar;
    //   3. `toBlob` em JPEG, que não tem canal alfa.
    //
    // A medalha é redonda sobre fundo transparente: qualquer uma
    // das três a entrega como um quadrado no slot do inventário.
    const world = installFakeCanvas(trophyBytes);

    await toIconFile(fileOf('medalha.png', PNG_HEAD, TROPHY.bytes, TROPHY));

    expect(world.canvases).toHaveLength(1);

    for (const canvas of world.canvases) {
      expect(canvas.contextOptions).toBeUndefined();
      expect(canvas.fills).toBe(0);
      expect(canvas.mime).toBe('image/png');
    }
  });

  it('mantém a garantia em TODOS os degraus, e não só no primeiro', async () => {
    const world = installFakeCanvas((size) => (size >= 54 ? 40_000 : 10_000));

    await toIconFile(fileOf('medalha.png', PNG_HEAD, TROPHY.bytes, TROPHY));

    expect(world.canvases.length).toBeGreaterThan(1);
    expect(world.canvases.every((canvas) => canvas.mime === 'image/png')).toBe(true);
    expect(world.canvases.every((canvas) => canvas.fills === 0)).toBe(true);
    expect(world.canvases.every((canvas) => canvas.contextOptions === undefined)).toBe(true);
  });
});

// ------------------------------------------------------------
//  A frase
// ------------------------------------------------------------

describe('o que a tela conta', () => {
  it('escreve bytes na unidade em que uma pessoa lê', () => {
    // KB decimal, e não KiB: o teto é 33.000, e dizer "32,2 KB"
    // faria a tela contradizer o código.
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(25_060)).toBe('25 KB');
    expect(formatBytes(MAX_ICON_BYTES)).toBe('33 KB');
    expect(formatBytes(TROPHY.bytes)).toBe('2,9 MB');
  });

  it('conta a redução da arte do dono numa linha', () => {
    expect(describeIconResize(TROPHY, { width: 96, height: 96, bytes: 25_060 })).toBe(
      '2,9 MB → 96×96, 25 KB',
    );
  });

  it('avisa quando não houve redução, para ninguém procurar o que sumiu', () => {
    expect(
      describeIconResize({ width: 64, height: 64, bytes: 9_000 }, { width: 64, height: 64, bytes: 8_000 }),
    ).toBe('9 KB → 64×64, 8 KB (a arte já cabia; aumentar um PNG só engorda o arquivo)');
  });
});
