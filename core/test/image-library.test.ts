// ============================================================
//  Testes da BIBLIOTECA DE IMAGENS — o lado de cá do OrigemZImages.
//
//  O que estes testes protegem, e não é óbvio:
//
//    - SOBE SÓ O QUE FALTA. O manifesto do plugin decide; sem ele,
//      a sincronização periódica reenviaria as imagens do menu de
//      cinco em cinco minutos, e um reinício do agente rebaixaria
//      todas as propagandas;
//    - OS BYTES SÃO PREGUIÇOSOS. Imagem que o plugin já tem não é
//      lida nem rebaixada — é isso que torna o reinício barato;
//    - O SHA QUE VIAJA É O DOS BYTES QUE VIAJAM. Um rebaixamento que
//      devolve outro conteúdo não pode subir com o sha antigo: o
//      manifesto mentiria para sempre;
//    - UM ENVIO POR VEZ, POR SERVIDOR. O menu e o overlay podem
//      mandar a mesma chave juntos, e um `begin` no meio dos pedaços
//      do outro recomeçaria o envio do lado de lá;
//    - PLUGIN AUSENTE É DITO UMA VEZ. Três sincronizadores de cinco
//      em cinco minutos repetindo a mesma frase ensinam a ignorar o
//      log.
// ============================================================

import { describe, expect, it, vi } from 'vitest';

import {
  buildImageBeginCommand,
  buildImagePartCommand,
  chunkImage,
  IMAGE_FAMILIES,
  IMAGE_MAX_BYTES,
  imageAsset,
  ImageLibrary,
  isReservedImageKey,
  isValidImageKey,
  parseManifest,
  sha256Hex,
  type ImageAsset,
  type ImageRcon,
} from '../src/game/image-library.js';
import type { Logger } from '../src/logger.js';

const SERVER = 'devserver';

/** Um PNG de mentira: só a assinatura importa para quem transporta. */
function png(size: number, seed = 0): Buffer {
  const bytes = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

/**
 * Um OrigemZImages de mentira, falando pelo RCON.
 *
 * Responde o manifesto com o que recebeu, e junta os pedaços do
 * jeito que o plugin junta — é o que deixa o teste conferir que o
 * que chegou é, byte a byte, o que saiu.
 */
function fakePlugin(options: {
  readonly manifest?: Record<string, string>;
  readonly ready?: boolean;
  readonly listReply?: string;
  readonly refuseBegin?: string;
  readonly delayMs?: number;
} = {}): ImageRcon & { readonly sent: string[]; readonly stored: Map<string, Buffer> } {
  const sent: string[] = [];
  const stored = new Map<string, Buffer>();
  const parts = new Map<string, Buffer[]>();

  return {
    isConnected: true,
    sent,
    stored,
    send: async (command: string) => {
      sent.push(command);

      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      const [name, key = '', ...rest] = command.split(' ');

      if (name === 'origemz.image.list') {
        return (
          options.listReply ??
          JSON.stringify({ ok: true, ready: options.ready ?? true, images: options.manifest ?? {} })
        );
      }

      if (name === 'origemz.image.begin') {
        if (options.refuseBegin !== undefined) {
          return `{"ok":false,"error":"${options.refuseBegin}"}`;
        }

        parts.set(key, []);
        return '{"ok":true}';
      }

      if (name === 'origemz.image.part') {
        parts.get(key)?.push(Buffer.from(rest[1] ?? '', 'base64'));
        return '{"ok":true}';
      }

      if (name === 'origemz.image.end') {
        stored.set(key, Buffer.concat(parts.get(key) ?? []));
        return '{"ok":true,"crc":123}';
      }

      if (name === 'origemz.image.forget') {
        return '{"ok":true,"forgotten":1}';
      }

      return `Command '${String(name)}' not found`;
    },
  };
}

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
    const begin = buildImageBeginCommand('item.trofeu-bleik', 3, 70_000, 'ab12');
    expect(begin.split(' ')).toHaveLength(5);

    const part = buildImagePartCommand('item.trofeu-bleik', 0, 'AAAA');
    expect(part.split(' ')).toHaveLength(4);
  });
});

describe('a chave', () => {
  it('aceita as três famílias que existem', () => {
    // Menu, propaganda e ícone de item.
    expect(isValidImageKey('ozcoin')).toBe(true);
    expect(isValidImageKey('ad0123456789ab')).toBe(true);
    expect(isValidImageKey('item.trofeu-bleik-store')).toBe(true);
  });

  it('recusa o que quebraria o comando ou o lugar reservado', () => {
    expect(isValidImageKey('logo do site')).toBe(false);
    expect(isValidImageKey('a}b')).toBe(false);
    expect(isValidImageKey('Maiuscula')).toBe(false);
    expect(isValidImageKey('.escondido')).toBe(false);
    expect(isValidImageKey('')).toBe(false);
  });
});

describe('o manifesto', () => {
  it('lê chave -> sha', () => {
    const manifest = parseManifest('{"ok":true,"ready":true,"images":{"ozcoin":"ab"}}');

    expect(manifest?.ready).toBe(true);
    expect(manifest?.images.get('ozcoin')).toBe('ab');
  });

  it('plugin ausente não é manifesto', () => {
    // É o que o console responde quando o OrigemZImages não carregou.
    expect(parseManifest("Command 'origemz.image.list' not found")).toBeNull();
    expect(parseManifest('')).toBeNull();
    expect(parseManifest('{"ok":true}')).toBeNull();
  });
});

describe('a sincronização', () => {
  it('sobe SÓ o que falta ou mudou', async () => {
    const igual = png(500, 1);
    const trocada = png(500, 2);
    const nova = png(500, 3);

    const rcon = fakePlugin({
      manifest: { igual: sha256Hex(igual), trocada: sha256Hex(png(500, 9)) },
    });

    const outcome = await new ImageLibrary().sync(SERVER, rcon, [
      imageAsset('igual', igual),
      imageAsset('trocada', trocada),
      imageAsset('nova', nova),
    ]);

    expect(outcome).toEqual({
      status: 'synced',
      sent: ['trocada', 'nova'],
      unchanged: 1,
      failed: [],
      pruned: [],
    });
    expect(rcon.sent.some((line) => line.startsWith('origemz.image.begin igual '))).toBe(false);
    expect(rcon.stored.get('trocada')?.equals(trocada)).toBe(true);
    expect(rcon.stored.get('nova')?.equals(nova)).toBe(true);
  });

  it('o `begin` promete o tamanho e o sha dos bytes que vão', async () => {
    const bytes = png(70_000);
    const rcon = fakePlugin();

    await new ImageLibrary().sync(SERVER, rcon, [imageAsset('grande', bytes)]);

    const begin = rcon.sent.find((line) => line.startsWith('origemz.image.begin '));
    // 70.000 bytes em pedaços de 27.000 = 3.
    expect(begin).toBe(`origemz.image.begin grande 3 70000 ${sha256Hex(bytes)}`);
    expect(rcon.stored.get('grande')?.equals(bytes)).toBe(true);
  });

  it('imagem que o plugin JÁ TEM não é nem lida', async () => {
    const bytes = png(500);
    const load = vi.fn(() => bytes);
    const rcon = fakePlugin({ manifest: { ozcoin: sha256Hex(bytes) } });

    const asset: ImageAsset = { key: 'ozcoin', sha: sha256Hex(bytes), load };
    const outcome = await new ImageLibrary().sync(SERVER, rcon, [asset]);

    // É o caso do agente que reiniciou: o sha está no banco, e rebaixar
    // a propaganda seria trabalho jogado fora.
    expect(load).not.toHaveBeenCalled();
    expect(outcome.status === 'synced' && outcome.unchanged).toBe(1);
  });

  it('conteúdo que mudou desde a chave NÃO sobe com o sha antigo', async () => {
    const rcon = fakePlugin();
    const asset: ImageAsset = { key: 'adabc', sha: sha256Hex(png(500, 1)), load: () => png(500, 2) };

    const outcome = await new ImageLibrary().sync(SERVER, rcon, [asset]);

    expect(outcome.status === 'synced' && outcome.failed.map((f) => f.key)).toEqual(['adabc']);
    expect(rcon.sent.some((line) => line.startsWith('origemz.image.begin'))).toBe(false);
  });

  it('bytes que não vieram viram falha, e as outras imagens seguem', async () => {
    const rcon = fakePlugin();

    const outcome = await new ImageLibrary().sync(SERVER, rcon, [
      { key: 'sumiu', sha: 'ab', load: () => null },
      imageAsset('boa', png(100)),
    ]);

    expect(outcome.status === 'synced' && outcome.sent).toEqual(['boa']);
    expect(outcome.status === 'synced' && outcome.failed[0]?.key).toBe('sumiu');
  });

  it('recusa do plugin no `begin` para aquela imagem, sem mandar pedaço', async () => {
    const rcon = fakePlugin({ refuseBegin: 'SERVER_NOT_READY' });

    const outcome = await new ImageLibrary().sync(SERVER, rcon, [imageAsset('ozcoin', png(100))]);

    expect(outcome.status === 'synced' && outcome.failed[0]?.reason).toContain('SERVER_NOT_READY');
    expect(rcon.sent.some((line) => line.startsWith('origemz.image.part'))).toBe(false);
  });

  it('chave inválida e arquivo grande demais são recusados sem ir ao RCON', async () => {
    const rcon = fakePlugin();

    const outcome = await new ImageLibrary().sync(SERVER, rcon, [
      imageAsset('logo do site', png(100)),
      imageAsset('enorme', png(IMAGE_MAX_BYTES + 1)),
    ]);

    expect(outcome.status === 'synced' && outcome.failed.map((f) => f.key)).toEqual([
      'logo do site',
      'enorme',
    ]);
    expect(rcon.sent).toEqual(['origemz.image.list']);
  });

  it('a mesma chave duas vezes sobe uma vez só', async () => {
    const rcon = fakePlugin();
    const bytes = png(100);

    await new ImageLibrary().sync(SERVER, rcon, [imageAsset('logo', bytes), imageAsset('logo', bytes)]);

    expect(rcon.sent.filter((line) => line.startsWith('origemz.image.begin'))).toHaveLength(1);
  });

  it('lista vazia não vai nem ao RCON', async () => {
    const rcon = fakePlugin();

    await new ImageLibrary().sync(SERVER, rcon, []);

    expect(rcon.sent).toHaveLength(0);
  });
});

describe('a poda', () => {
  // A tabela do plugin sobrevive a reload e a restart. Sem poda, um
  // ícone tirado no painel continuaria no jogo para sempre.

  it('esquece a chave do dono que ninguém mais usa', async () => {
    const rcon = fakePlugin({
      manifest: { 'item.velho': 'aa', 'item.atual': sha256Hex(png(10)) },
    });

    const outcome = await new ImageLibrary().sync(
      SERVER,
      rcon,
      [imageAsset('item.atual', png(10))],
      { owns: IMAGE_FAMILIES.item },
    );

    expect(outcome.status === 'synced' && outcome.pruned).toEqual(['item.velho']);
    expect(rcon.sent).toContain('origemz.image.forget item.velho');
    expect(rcon.sent).not.toContain('origemz.image.forget item.atual');
  });

  it('não toca no que é de outro dono', async () => {
    const rcon = fakePlugin({
      manifest: { ozcoin: 'aa', ad0123456789ab: 'bb', 'item.velho': 'cc' },
    });

    await new ImageLibrary().sync(SERVER, rcon, [], { owns: IMAGE_FAMILIES.item });

    // O menu e as propagandas continuam lá: quem poda é o dono.
    expect(rcon.sent.filter((line) => line.startsWith('origemz.image.forget'))).toEqual([
      'origemz.image.forget item.velho',
    ]);
  });

  it('o que está em `keep` fica, mesmo sem subir agora', async () => {
    const rcon = fakePlugin({ manifest: { ad0123456789ab: 'aa', adffffffffffff: 'bb' } });

    // A propaganda fora da janela de horário não sobe agora — e não
    // pode ser esquecida, senão os megabytes dela subiriam de novo.
    await new ImageLibrary().sync(SERVER, rcon, [], {
      owns: IMAGE_FAMILIES.ad,
      keep: new Set(['ad0123456789ab']),
    });

    expect(rcon.sent.filter((line) => line.startsWith('origemz.image.forget'))).toEqual([
      'origemz.image.forget adffffffffffff',
    ]);
  });

  it('as famílias reservadas são reconhecidas, e o nome comum não', () => {
    expect(isReservedImageKey('item.trofeu')).toBe(true);
    expect(isReservedImageKey('ad0123456789ab')).toBe(true);
    // `adorno` e `admin` são nomes de arquivo possíveis no menu.
    expect(isReservedImageKey('adorno')).toBe(false);
    expect(isReservedImageKey('ad0123')).toBe(false);
    expect(isReservedImageKey('ozcoin')).toBe(false);
  });
});

describe('quando não dá para perguntar', () => {
  it('plugin ausente: nada sobe, e o aviso sai UMA vez', async () => {
    const logger = spyLogger();
    const library = new ImageLibrary({ logger });
    const rcon = fakePlugin({ listReply: "Command 'origemz.image.list' not found" });

    const first = await library.sync(SERVER, rcon, [imageAsset('ozcoin', png(100))]);
    await library.sync(SERVER, rcon, [imageAsset('ozcoin', png(100))]);

    expect(first.status).toBe('unavailable');
    expect(rcon.sent.every((line) => line === 'origemz.image.list')).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('servidor subindo: espera a próxima rodada', async () => {
    const rcon = fakePlugin({ ready: false });

    const outcome = await new ImageLibrary().sync(SERVER, rcon, [imageAsset('ozcoin', png(100))]);

    expect(outcome.status).toBe('unavailable');
    expect(rcon.sent).toEqual(['origemz.image.list']);
  });

  it('quando o plugin volta, a volta também é dita', async () => {
    const logger = spyLogger();
    const library = new ImageLibrary({ logger });

    await library.sync(SERVER, fakePlugin({ listReply: 'nada' }), [imageAsset('a', png(10))]);
    await library.sync(SERVER, fakePlugin(), [imageAsset('a', png(10))]);

    expect(logger.info).toHaveBeenCalledWith({ server: SERVER }, 'o OrigemZImages voltou a responder');
  });
});

describe('o servidor que ainda está subindo', () => {
  // MEDIDO no server01: o RCON abre antes de o mundo ser gerado, e é
  // nessa janela que o agente reconecta e sincroniza tudo.

  it('tenta de novo SOZINHO, e a imagem chega quando ele fica pronto', async () => {
    const estado = { ready: false };
    const rcon = fakePlugin();
    const original = rcon.send.bind(rcon);

    // O mesmo plugin de mentira, com o `ready` mudando no meio.
    const vivo: typeof rcon = {
      ...rcon,
      send: async (command: string) =>
        command === 'origemz.image.list' && !estado.ready
          ? JSON.stringify({ ok: true, ready: false, images: {} })
          : original(command),
    };

    const library = new ImageLibrary({ retryDelayMs: 10 });
    const primeiro = await library.sync(SERVER, vivo, [imageAsset('item.trofeu', png(100))]);

    // Quem chamou não fica esperando o boot: a carga dele segue.
    expect(primeiro.status).toBe('unavailable');
    expect(rcon.stored.has('item.trofeu')).toBe(false);

    estado.ready = true;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(rcon.stored.has('item.trofeu')).toBe(true);
    library.stop();
  });

  it('as imagens de quem chegou cedo viajam juntas numa tentativa só', async () => {
    const estado = { ready: false };
    const rcon = fakePlugin();
    const original = rcon.send.bind(rcon);
    const vivo: typeof rcon = {
      ...rcon,
      send: async (command: string) =>
        command === 'origemz.image.list' && !estado.ready
          ? JSON.stringify({ ok: true, ready: false, images: {} })
          : original(command),
    };

    const library = new ImageLibrary({ retryDelayMs: 10 });

    // O menu, o overlay e os itens reconectam no mesmo instante.
    await library.sync(SERVER, vivo, [imageAsset('ozcoin', png(100, 1))]);
    await library.sync(SERVER, vivo, [imageAsset('item.trofeu', png(100, 2))]);

    estado.ready = true;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect([...rcon.stored.keys()].sort()).toEqual(['item.trofeu', 'ozcoin']);
    library.stop();
  });

  it('desiste depois do teto, e diz isso', async () => {
    const logger = spyLogger();
    const library = new ImageLibrary({ logger, retryDelayMs: 1 });
    const rcon = fakePlugin({ ready: false });

    await library.sync(SERVER, rcon, [imageAsset('ozcoin', png(100))]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const listas = rcon.sent.filter((line) => line === 'origemz.image.list').length;

    // A primeira pergunta mais 16 novas tentativas — e parou.
    expect(listas).toBe(17);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ server: SERVER }),
      'o servidor não ficou pronto a tempo; as imagens esperam a próxima sincronização',
    );
    library.stop();
  });

  it('plugin ausente não vira insistência', async () => {
    const library = new ImageLibrary({ retryDelayMs: 1 });
    const rcon = fakePlugin({ listReply: "Command 'origemz.image.list' not found" });

    await library.sync(SERVER, rcon, [imageAsset('ozcoin', png(100))]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Esperar não liga plugin nenhum. A próxima sincronização normal
    // pergunta de novo.
    expect(rcon.sent).toEqual(['origemz.image.list']);
    library.stop();
  });
});

describe('a fila por servidor', () => {
  it('duas rodadas no mesmo servidor não se intercalam', async () => {
    const rcon = fakePlugin({ delayMs: 2 });
    const library = new ImageLibrary();

    // O menu e o overlay mandando ao mesmo tempo.
    await Promise.all([
      library.sync(SERVER, rcon, [imageAsset('menu', png(100, 1))]),
      library.sync(SERVER, rcon, [imageAsset('overlay', png(100, 2))]),
    ]);

    const fimDoMenu = rcon.sent.indexOf('origemz.image.end menu');
    const segundaLista = rcon.sent.lastIndexOf('origemz.image.list');

    expect(fimDoMenu).toBeGreaterThan(-1);
    expect(segundaLista).toBeGreaterThan(fimDoMenu);
  });

  it('servidores diferentes não esperam um pelo outro', async () => {
    const lento = fakePlugin({ delayMs: 20 });
    const rapido = fakePlugin();
    const library = new ImageLibrary();

    const primeiro = library.sync('lento', lento, [imageAsset('a', png(100))]);
    await library.sync('rapido', rapido, [imageAsset('a', png(100))]);

    // O rápido terminou enquanto o lento ainda estava no meio.
    expect(rapido.stored.has('a')).toBe(true);
    expect(lento.stored.has('a')).toBe(false);

    await primeiro;
  });
});
