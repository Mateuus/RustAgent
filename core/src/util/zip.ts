// ============================================================
//  zip.ts  -  abrir o pacote do release, sem dependência nova.
//
//  ------------------------------------------------------------
//  ####  POR QUE UM LEITOR DE ZIP À MÃO  ####
//
//  O pacote publicado pelo release.yml é um .zip, e o Node não
//  traz extrator nenhum na biblioteca padrão — só o `zlib`, que
//  descomprime UM fluxo e não conhece o formato do contêiner.
//
//  As três saídas eram: acrescentar uma dependência de PRODUÇÃO ao
//  agente que se atualiza sozinho (mais código de terceiro no
//  caminho que troca os arquivos do próprio agente), chamar o
//  `tar.exe`/`Expand-Archive` do Windows (um processo externo cujo
//  desfecho é texto, e que só dá para exercitar na máquina certa),
//  ou ler o formato aqui.
//
//  O formato é público e pequeno para o que precisamos (APPNOTE
//  4.3): diretório central no fim, um cabeçalho local por arquivo,
//  dois métodos de compressão em uso real. Ler aqui dá três coisas
//  que as outras duas opções não dão:
//
//    1. o caminho de CADA entrada passa pela mesma peneira antes de
//       virar arquivo — nada escapa de `releases\<versão>.tmp\`
//       (ver `safeEntryPath`, e "zip slip");
//    2. o CRC de cada arquivo é conferido na saída;
//    3. tudo isso se testa com um zip montado no próprio teste.
//
//  ------------------------------------------------------------
//  ####  O QUE ELE NÃO FAZ, DE PROPÓSITO  ####
//
//  Sem criptografia, sem os métodos exóticos (bzip2, lzma, zstd),
//  sem link simbólico e sem permissão de arquivo. O produtor é UM
//  — o `release.yml`, que grava entradas `deflate`/`store` com
//  barra normal — e um leitor mais esperto que o produtor só
//  criaria caminho não exercitado. Tudo que foge disso é RECUSA
//  com a razão escrita, nunca uma tentativa de adivinhar.
// ============================================================

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ------------------------------------------------------------
//  As assinaturas do formato (APPNOTE 4.3.6 em diante)
// ------------------------------------------------------------
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** Tamanho fixo do "end of central directory", sem comentário. */
const EOCD_SIZE = 22;

/** O comentário do fim do arquivo cabe em 16 bits — logo, 64 KiB. */
const MAX_COMMENT_BYTES = 0xffff;

/** Marca de "o valor de verdade está no campo extra do zip64". */
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;

/** Id do campo extra que carrega os valores de 64 bits. */
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Bit 0 dos flags: a entrada está cifrada. */
const FLAG_ENCRYPTED = 0x0001;

/**
 * Tetos de sanidade.
 *
 * O pacote do agente tem hoje ~15 mil arquivos e algumas centenas
 * de MB descompactados. Os números abaixo são folgados o bastante
 * para não incomodar e apertados o bastante para um arquivo
 * malformado — ou uma "zip bomb" — parar aqui em vez de encher o
 * disco da máquina que hospeda o servidor.
 */
const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** Uma entrada do diretório central, já interpretada. */
export interface ZipEntry {
  /** Caminho dentro do zip, sempre com barra normal. */
  readonly path: string;
  /** Tamanho descompactado. */
  readonly bytes: number;
  readonly compressedBytes: number;
  readonly method: number;
  readonly crc32: number;
  /** Deslocamento do cabeçalho LOCAL desta entrada. */
  readonly headerOffset: number;
  /** Entrada de diretório (nome terminado em `/`) não vira arquivo. */
  readonly directory: boolean;
}

export interface ExtractResult {
  readonly files: number;
  readonly bytes: number;
  /** A pasta raiz que foi descartada, quando havia uma. */
  readonly strippedRoot: string | null;
}

export interface ExtractOptions {
  /**
   * Descartar a pasta raiz única do arquivo.
   *
   * O zip do release embrulha tudo em
   * `rustagent-<versão>-win-x64-node22/` (ver release.yml), e o que
   * precisa aparecer em `releases\<versão>\` é o CONTEÚDO desse
   * embrulho — `core\dist\index.js`, e não
   * `rustagent-...\core\dist\index.js`. Um nível a mais aqui
   * significa um agente que "instalou" e não sobe.
   *
   * Só descarta quando TODAS as entradas partem da mesma pasta;
   * um arquivo solto na raiz desliga o corte, porque aí o zip já
   * está na forma final.
   */
  readonly stripRoot?: boolean;
}

// ============================================================
//  LEITURA
// ============================================================

/**
 * O diretório central do arquivo, entrada a entrada.
 *
 * A leitura é pelo FIM: é assim que o formato foi feito (o
 * diretório central é o índice, e o cabeçalho local de cada
 * arquivo pode mentir os tamanhos quando há "data descriptor").
 *
 * Lança com o motivo por extenso — quem chama transforma isso em
 * recusa da atualização, e a frase acaba no log da operação.
 */
export function readZipEntries(archive: Buffer): readonly ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);

  let entryCount = archive.readUInt16LE(eocd + 10);
  let centralOffset = archive.readUInt32LE(eocd + 16);

  // ####  ZIP64  ####
  //
  // Acima de 65.535 entradas (ou 4 GiB), os campos de 16/32 bits
  // saturam e o valor de verdade vai para um registro à parte. O
  // pacote de hoje não chega lá, mas o node_modules só cresce — e
  // a falha, sem isto, seria um extrator lendo o diretório central
  // no deslocamento errado.
  if (entryCount === ZIP64_MARKER_16 || centralOffset === ZIP64_MARKER_32) {
    const zip64 = findZip64EndOfCentralDirectory(archive, eocd);

    // Os dois campos são de 64 bits; `readBigUInt64LE` devolve
    // BigInt, e converter é seguro porque o teto de sanidade lá
    // embaixo recusa qualquer coisa dessa ordem de grandeza.
    entryCount = Number(archive.readBigUInt64LE(zip64 + 32));
    centralOffset = Number(archive.readBigUInt64LE(zip64 + 48));
  }

  if (entryCount > MAX_ENTRIES) {
    throw new Error(
      `o pacote diz ter ${String(entryCount)} arquivos, acima do teto de ` +
        `${String(MAX_ENTRIES)} que este agente aceita descompactar`,
    );
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length) {
      throw new Error('o diretório central do pacote termina no meio de uma entrada');
    }

    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(
        `a entrada ${String(index + 1)} do diretório central do pacote não tem a ` +
          'assinatura esperada — o arquivo está corrompido',
      );
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);

    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const extra = archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);

    // Os três podem estar saturados e continuarem no campo extra.
    const zip64 = readZip64Extra(extra);

    const bytes = zip64.uncompressed ?? archive.readUInt32LE(cursor + 24);
    const compressedBytes = zip64.compressed ?? archive.readUInt32LE(cursor + 20);
    const headerOffset = zip64.offset ?? archive.readUInt32LE(cursor + 42);

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error(`a entrada "${name}" do pacote está cifrada, e o agente não abre zip com senha`);
    }

    entries.push({
      path: name,
      bytes,
      compressedBytes,
      method,
      crc32: crc,
      headerOffset,
      directory: name.endsWith('/'),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Os bytes de UMA entrada, já descomprimidos e conferidos.
 *
 * O tamanho e o CRC vêm do diretório central; conferir os dois na
 * saída é o que separa "descomprimiu" de "descomprimiu certo" — e
 * é o único ponto capaz de pegar um erro do descompressor daqui,
 * já que o sha256 do zip inteiro é conferido antes e só prova que
 * os bytes que chegaram são os que foram publicados.
 */
export function readZipEntryData(archive: Buffer, entry: ZipEntry): Buffer {
  const header = entry.headerOffset;

  if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`a entrada "${entry.path}" aponta para um cabeçalho que não existe no pacote`);
  }

  // ####  OS TAMANHOS DO CABEÇALHO LOCAL SÃO IGNORADOS  ####
  //
  // Com o bit 3 dos flags eles vêm ZERADOS aqui e só aparecem
  // depois dos dados, num "data descriptor". O diretório central
  // sempre tem os valores certos, então é dele que eles saem.
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedBytes;

  if (end > archive.length) {
    throw new Error(`os dados da entrada "${entry.path}" passam do fim do pacote`);
  }

  const raw = archive.subarray(start, end);

  let data: Buffer;

  if (entry.method === METHOD_STORE) {
    data = Buffer.from(raw);
  } else if (entry.method === METHOD_DEFLATE) {
    data = inflateRawSync(raw);
  } else {
    throw new Error(
      `a entrada "${entry.path}" usa o método de compressão ${String(entry.method)}, e o ` +
        'agente só abre "store" (0) e "deflate" (8)',
    );
  }

  if (data.length !== entry.bytes) {
    throw new Error(
      `a entrada "${entry.path}" deveria ter ${String(entry.bytes)} bytes e saiu com ` +
        `${String(data.length)} — o pacote está corrompido`,
    );
  }

  if (crc32(data) !== entry.crc32) {
    throw new Error(`a entrada "${entry.path}" não bate com o CRC declarado no pacote`);
  }

  return data;
}

// ============================================================
//  EXTRAÇÃO
// ============================================================

/**
 * Escreve o conteúdo do zip em `targetDir`.
 *
 * A pasta é criada aqui; ela NÃO pode ser a de uma versão
 * instalada — quem chama extrai para `<versão>.tmp` e só renomeia
 * no fim, para que uma extração pela metade nunca se pareça com
 * uma versão pronta.
 */
export async function extractZip(
  archive: Buffer,
  targetDir: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const entries = readZipEntries(archive);
  const strippedRoot = options.stripRoot === true ? singleRootOf(entries) : null;

  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      `o pacote tem ${String(total)} bytes descompactados, acima do teto que este agente aceita`,
    );
  }

  // As pastas já criadas. Sem isto seria um `mkdir` por arquivo —
  // quinze mil chamadas ao sistema para criar as mesmas pastas.
  const created = new Set<string>();
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (entry.directory) {
      continue;
    }

    // A peneira roda sobre o nome INTEIRO, e o corte da raiz vem
    // depois: validar o que sobrou deixaria passar um `..` que
    // estivesse justamente no primeiro segmento.
    const segments = safeEntryPath(entry.path);
    const relative = strippedRoot === null ? segments : segments.slice(1);

    if (relative.length === 0) {
      continue;
    }

    const destination = join(targetDir, ...relative);
    const folder = dirname(destination);

    if (!created.has(folder)) {
      await mkdir(folder, { recursive: true });
      created.add(folder);
    }

    await writeFile(destination, readZipEntryData(archive, entry));

    files += 1;
    bytes += entry.bytes;
  }

  if (files === 0) {
    throw new Error('o pacote não tem nenhum arquivo dentro');
  }

  return { files, bytes, strippedRoot };
}

/**
 * O caminho de uma entrada, quebrado em segmentos SEGUROS.
 *
 * ####  ISTO É O QUE FECHA O "ZIP SLIP"  ####
 *
 * Um nome como `..\..\..\Configs\server.ini` dentro do zip faria a
 * extração escrever FORA da pasta de destino — por cima da
 * configuração, do banco, ou de qualquer coisa que o processo
 * alcance. O agente roda como serviço na máquina do dono, então o
 * alcance é grande.
 *
 * A peneira é por SEGMENTO e recusa em vez de sanear: um nome
 * estranho num pacote nosso é motivo para parar a atualização, não
 * para consertá-lo e seguir.
 */
export function safeEntryPath(name: string): readonly string[] {
  if (name.includes('\\')) {
    // O formato exige barra normal (APPNOTE 4.4.17.1). Barra
    // invertida aqui significa zip montado por ferramenta que
    // grava caminho do Windows cru — e extrair isso produz
    // arquivos soltos com o caminho no nome.
    throw new Error(`a entrada "${name}" usa barra invertida, e o formato zip exige barra normal`);
  }

  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`a entrada "${name}" tem caminho absoluto`);
  }

  const segments = name.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    throw new Error('o pacote tem uma entrada sem nome');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`a entrada "${name}" tenta sair da pasta de destino`);
    }
  }

  return segments;
}

/**
 * A pasta raiz única do arquivo, ou `null`.
 *
 * `null` quando há arquivo na raiz ou mais de uma pasta no topo —
 * nos dois casos o zip já está na forma final e cortar um nível
 * espalharia o conteúdo.
 */
export function singleRootOf(entries: readonly ZipEntry[]): string | null {
  let root: string | null = null;

  for (const entry of entries) {
    if (entry.directory) {
      continue;
    }

    const slash = entry.path.indexOf('/');

    if (slash <= 0) {
      return null;
    }

    const first = entry.path.slice(0, slash);

    if (root === null) {
      root = first;
      continue;
    }

    if (root !== first) {
      return null;
    }
  }

  return root;
}

// ============================================================
//  Peças do formato
// ============================================================

function findEndOfCentralDirectory(archive: Buffer): number {
  if (archive.length < EOCD_SIZE) {
    throw new Error('o arquivo baixado é pequeno demais para ser um zip');
  }

  const floor = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT_BYTES);

  // De trás para a frente: o registro fica no FIM, e o comentário
  // opcional depois dele é o que impede um deslocamento fixo.
  for (let offset = archive.length - EOCD_SIZE; offset >= floor; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }

  throw new Error('o arquivo baixado não é um zip (não achei o fim do diretório central)');
}

function findZip64EndOfCentralDirectory(archive: Buffer, eocd: number): number {
  const locator = eocd - 20;

  if (locator < 0 || archive.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new Error('o pacote diz ser zip64 e não traz o localizador do diretório central');
  }

  const offset = Number(archive.readBigUInt64LE(locator + 8));

  if (offset + 56 > archive.length || archive.readUInt32LE(offset) !== ZIP64_EOCD_SIGNATURE) {
    throw new Error('o registro zip64 do pacote aponta para fora do arquivo');
  }

  return offset;
}

/** Os campos de 64 bits de UMA entrada, quando ela os tem. */
function readZip64Extra(extra: Buffer): {
  uncompressed: number | null;
  compressed: number | null;
  offset: number | null;
} {
  let cursor = 0;

  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const start = cursor + 4;

    if (id !== ZIP64_EXTRA_ID) {
      cursor = start + size;
      continue;
    }

    // A ordem é fixa (uncompressed, compressed, offset) e só os
    // campos saturados aparecem — por isso a leitura é por
    // disponibilidade, e não por posição fixa.
    const read = (index: number): number | null =>
      start + index * 8 + 8 <= extra.length && index * 8 + 8 <= size
        ? Number(extra.readBigUInt64LE(start + index * 8))
        : null;

    return { uncompressed: read(0), compressed: read(1), offset: read(2) };
  }

  return { uncompressed: null, compressed: null, offset: null };
}

// ------------------------------------------------------------
//  CRC-32 (IEEE 802.3), o mesmo que o zip guarda
//
//  Exportado para o teste montar um zip de mentira com o CRC
//  certo — e, com ele errado de propósito, provar que a
//  extração recusa.
// ------------------------------------------------------------

/** Montada uma vez, na primeira chamada. */
let crcTable: Uint32Array | null = null;

function crcTableOf(): Uint32Array {
  if (crcTable !== null) {
    return crcTable;
  }

  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  crcTable = table;
  return table;
}

export function crc32(data: Buffer): number {
  const table = crcTableOf();
  let crc = 0xffffffff;

  for (const byte of data) {
    // O `?? 0` é pelo noUncheckedIndexedAccess: o índice é sempre
    // um byte, então a entrada existe — o compilador é que não
    // tem como saber.
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
