// ============================================================
//  backup.ts  -  a cópia do save que se tira ANTES de apagar.
//
//  ####  UM WIPE SEM BACKUP É UMA OPERAÇÃO SEM VOLTA  ####
//
//  Ele existe para o desfecho que ninguém planeja: a política
//  estava errada, o mapa era o errado, alguém clicou no servidor
//  errado. Com o zip, isso custa uma restauração; sem ele, custa o
//  servidor.
//
//  ------------------------------------------------------------
//  ####  O ESPAÇO É CONFERIDO COM O SERVIDOR AINDA NO AR  ####
//
//  É a regra que dá forma a este arquivo. `checkBackupSpace` é
//  chamada na PRÉ-CONDIÇÃO do `POST /wipe/runs` — antes do 202,
//  antes do passo `parar`. Falhar o backup com o servidor já
//  parado é o pior desfecho possível: o mundo continua lá, os
//  jogadores não, e o operador está no meio de uma operação que
//  não pode ser abandonada nem concluída.
//
//  ------------------------------------------------------------
//  ####  ZIP ESCRITO À MÃO, E POR QUÊ  ####
//
//  O agente não tem dependência de compactação, e util/zip.ts só
//  LÊ (ele existe para conferir o pacote de atualização). Trazer
//  uma biblioteca para escrever um arquivo por wipe seria uma
//  dependência a mais na superfície de um agente que roda como
//  serviço na máquina do dono.
//
//  O que se escreve aqui é o subconjunto do formato que interessa:
//  entradas DEFLATE, diretório central, sem zip64. O teto de 4 GB
//  do formato de 32 bits é conferido e VIRA RECUSA — escrever um
//  zip que não abre é pior que não escrever nenhum.
// ============================================================

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../util/zip.js';

/**
 * A folga exigida além do tamanho da pasta.
 *
 * O zip sai menor que a pasta quase sempre, mas "quase sempre" não
 * serve para uma conferência cujo objetivo é nunca falhar com o
 * servidor parado. Então a régua é o tamanho CRU mais isto — e,
 * se sobrar, sobrou.
 */
export const BACKUP_HEADROOM_BYTES = 512 * 1024 * 1024;

/** Quantos zips ficam, quando ninguém escolheu. */
export const DEFAULT_BACKUP_KEEP = 3;

/**
 * O teto do formato sem zip64.
 *
 * Um save que passe disto existe em teoria; o que não pode existir
 * é o zip silenciosamente truncado que sairia daqui.
 */
const ZIP32_LIMIT = 0xffffffff;

/**
 * Nível de compressão 1, e não 6.
 *
 * O backup roda com o servidor PARADO — cada segundo aqui é um
 * segundo de servidor fora do ar. O grosso da pasta é o `.map` e
 * os `.sav`, que são densos: entre o nível 1 e o 6 a diferença de
 * tamanho é pequena e a de tempo não é.
 */
const DEFLATE_LEVEL = 1;

export interface BackupSpace {
  /** O que a pasta do save ocupa hoje, em bytes. */
  readonly needBytes: number;
  /** O que o disco de destino tem livre. `null` = não deu para perguntar. */
  readonly freeBytes: number | null;
  /** Dá para fazer o backup sem risco? */
  readonly ok: boolean;
  /** A frase da recusa, pronta para a tela. `null` quando `ok`. */
  readonly reason: string | null;
}

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly files: number;
  /** Os zips antigos que a poda removeu. */
  readonly pruned: readonly string[];
}

/**
 * O tamanho da pasta, sem descer em subpasta.
 *
 * Sem recursão pelo mesmo motivo de save-files.ts: o que o backup
 * copia é o nível de cima, que é onde mora o mundo. `cfg\` e
 * `command_history\` não são o save.
 */
export async function saveFolderBytes(path: string): Promise<number> {
  let total = 0;

  for (const name of await filesIn(path)) {
    try {
      total += (await stat(join(path, name))).size;
    } catch {
      // Sumiu no caminho. Ignorar um arquivo é melhor que recusar
      // o wipe por causa de um save que rotacionou.
    }
  }

  return total;
}

/**
 * Dá para fazer o backup? Chamada ANTES de parar o servidor.
 *
 * ####  NÃO CONSEGUIR PERGUNTAR NÃO É REPROVAR  ####
 *
 * `statfs` falha em disco de rede e em alguns pontos de montagem.
 * Reprovar aí bloquearia o wipe de quem está com tudo certo, e a
 * conferência existe para evitar UM desfecho específico — não para
 * ser um segundo dono da decisão. Sem o número, passa, e o campo
 * `freeBytes: null` diz na tela que ninguém mediu.
 */
export async function checkBackupSpace(
  saveDir: string,
  backupsDir: string,
): Promise<BackupSpace> {
  const needBytes = await saveFolderBytes(saveDir);
  const freeBytes = await freeSpaceOf(backupsDir);

  if (freeBytes === null) {
    return { needBytes, freeBytes: null, ok: true, reason: null };
  }

  if (freeBytes >= needBytes + BACKUP_HEADROOM_BYTES) {
    return { needBytes, freeBytes, ok: true, reason: null };
  }

  return {
    needBytes,
    freeBytes,
    ok: false,
    reason:
      `Não há espaço para o backup: a pasta do save ocupa ${mb(needBytes)} e o disco de ` +
      `${backupsDir} tem ${mb(freeBytes)} livres (o agente exige a folga de ` +
      `${mb(BACKUP_HEADROOM_BYTES)} por cima). Libere espaço, ou apague um backup antigo — o ` +
      'servidor continua no ar, e nada foi apagado.',
  };
}

/**
 * Zipa a pasta do save.
 *
 * ####  SÓ ARQUIVO, SÓ O NÍVEL DE CIMA  ####
 *
 * O mesmo recorte de save-files.ts, e de propósito: o que o backup
 * guarda é exatamente o que o wipe pode apagar. Um zip com mais
 * coisa dentro prometeria restaurar o que ele não é responsável
 * por preservar.
 *
 * Pasta inexistente devolve `null`: é o servidor que nunca subiu,
 * e o passo `backup` trata isso como `skipped` — não há o que
 * copiar, e isso não é falha.
 */
export async function backupSaveFolder(options: {
  readonly saveDir: string;
  readonly backupsDir: string;
  readonly at?: number;
  readonly keep?: number;
  readonly onLine?: (line: string) => void;
}): Promise<BackupResult | null> {
  const names = await filesIn(options.saveDir);

  if (names.length === 0) {
    return null;
  }

  const at = options.at ?? Date.now();
  const target = join(options.backupsDir, `wipe-${stamp(at)}.zip`);

  await mkdir(options.backupsDir, { recursive: true });

  const written = await writeZip(options.saveDir, names, target, options.onLine);
  const pruned = await pruneBackups(options.backupsDir, options.keep ?? DEFAULT_BACKUP_KEEP);

  return { ...written, pruned };
}

/**
 * Apaga os zips de wipe mais antigos, mantendo os `keep` últimos.
 *
 * Só o que ESTE módulo escreveu (`wipe-*.zip`): a pasta
 * `Backups\<id>\` também recebe o backup do Oxide (ver
 * oxide/install.ts), e podar o que não é nosso seria apagar a
 * salvaguarda de outra operação.
 */
export async function pruneBackups(dir: string, keep: number): Promise<readonly string[]> {
  if (keep < 1) {
    return [];
  }

  const zips: { readonly path: string; readonly at: number }[] = [];

  for (const name of await filesIn(dir)) {
    if (!/^wipe-.+\.zip$/i.test(name)) {
      continue;
    }

    const path = join(dir, name);

    try {
      zips.push({ path, at: (await stat(path)).mtimeMs });
    } catch {
      // Sumiu. Nada a podar.
    }
  }

  zips.sort((a, b) => b.at - a.at);

  const removed: string[] = [];

  for (const old of zips.slice(keep)) {
    try {
      await rm(old.path, { force: true });
      removed.push(basename(old.path));
    } catch {
      // Um zip que não some (arquivo aberto, permissão) não pode
      // derrubar o wipe: o backup NOVO já está gravado, que é o
      // que a operação prometeu.
    }
  }

  return removed;
}

// ------------------------------------------------------------
//  O escritor de zip
// ------------------------------------------------------------

interface CentralEntry {
  readonly name: string;
  readonly crc: number;
  readonly compressed: number;
  readonly raw: number;
  readonly offset: number;
  readonly dosTime: number;
  readonly dosDate: number;
}

async function writeZip(
  dir: string,
  names: readonly string[],
  target: string,
  onLine?: (line: string) => void,
): Promise<Omit<BackupResult, 'pruned'>> {
  const output = createWriteStream(target);
  const entries: CentralEntry[] = [];
  let offset = 0;

  const put = async (chunk: Buffer): Promise<void> => {
    if (!output.write(chunk)) {
      await new Promise<void>((resolve) => output.once('drain', resolve));
    }

    offset += chunk.length;
  };

  try {
    for (const name of names) {
      let raw: Buffer;
      let modified: Date;

      try {
        const full = join(dir, name);

        raw = await readFile(full);
        modified = (await stat(full)).mtime;
      } catch {
        // O arquivo sumiu entre a listagem e a leitura. Um a menos
        // no zip é melhor que um backup que não termina.
        onLine?.(`[backup] ${name} sumiu antes de ser copiado — segui sem ele.`);
        continue;
      }

      const compressed = deflateRawSync(raw, { level: DEFLATE_LEVEL });
      const crc = crc32(raw);
      const dosTime = toDosTime(modified);
      const dosDate = toDosDate(modified);

      if (offset > ZIP32_LIMIT || raw.length > ZIP32_LIMIT) {
        throw new Error(
          `o backup passou de 4 GB no arquivo ${name}, e este escritor de zip não faz zip64. ` +
            'Desligue o backup automático desta execução e copie a pasta do save à mão antes de ' +
            'seguir — um zip truncado abriria sem reclamar e faltaria conteúdo dentro.',
        );
      }

      entries.push({
        name,
        crc,
        compressed: compressed.length,
        raw: raw.length,
        offset,
        dosTime,
        dosDate,
      });

      await put(localHeader(name, crc, compressed.length, raw.length, dosTime, dosDate));
      await put(compressed);
    }

    const centralStart = offset;

    for (const entry of entries) {
      await put(centralHeader(entry));
    }

    await put(endOfCentralDirectory(entries.length, offset - centralStart, centralStart));

    await new Promise<void>((resolve, reject) => {
      output.end((error?: Error | null) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  } catch (error) {
    output.destroy();

    // O zip pela metade é removido: um arquivo com o nome certo e
    // o conteúdo incompleto é o que faria alguém confiar nele no
    // dia em que precisasse restaurar.
    await rm(target, { force: true }).catch(() => undefined);

    throw error;
  }

  return { path: target, bytes: offset, files: entries.length };
}

function localHeader(
  name: string,
  crc: number,
  compressed: number,
  raw: number,
  dosTime: number,
  dosDate: number,
): Buffer {
  const encoded = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);

  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // versão mínima
  header.writeUInt16LE(0x0800, 6); // bit 11: o nome é UTF-8
  header.writeUInt16LE(8, 8); // método: deflate
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed, 18);
  header.writeUInt32LE(raw, 22);
  header.writeUInt16LE(encoded.length, 26);
  header.writeUInt16LE(0, 28); // sem campo extra

  return Buffer.concat([header, encoded]);
}

function centralHeader(entry: CentralEntry): Buffer {
  const encoded = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46);

  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // versão que criou
  header.writeUInt16LE(20, 6); // versão mínima
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.raw, 24);
  header.writeUInt16LE(encoded.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comentário
  header.writeUInt16LE(0, 34); // disco
  header.writeUInt16LE(0, 36); // atributos internos
  header.writeUInt32LE(0, 38); // atributos externos
  header.writeUInt32LE(entry.offset, 42);

  return Buffer.concat([header, encoded]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disco
  end.writeUInt16LE(0, 6); // disco do diretório
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // sem comentário

  return end;
}

/** As duas metades da data no formato do MS-DOS, que o zip herdou. */
function toDosTime(date: Date): number {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
}

function toDosDate(date: Date): number {
  // O ano do DOS começa em 1980, e datas anteriores não cabem no
  // campo. Um `mtime` de 1970 (relógio zerado) viraria um ano
  // negativo e um zip inválido.
  const year = Math.max(1980, date.getFullYear()) - 1980;

  return (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

// ------------------------------------------------------------
//  Auxiliares
// ------------------------------------------------------------

async function filesIn(dir: string): Promise<readonly string[]> {
  try {
    const found = await readdir(dir, { withFileTypes: true });

    return found.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Quanto o disco tem livre. `null` = não deu para perguntar.
 *
 * A pergunta é sobre a pasta dos backups, e ela pode não existir
 * ainda (primeiro wipe do servidor) — nesse caso pergunta-se à
 * pasta acima, que existe, e que está no mesmo volume.
 */
async function freeSpaceOf(dir: string): Promise<number | null> {
  for (const candidate of [dir, join(dir, '..')]) {
    try {
      const info = await statfs(candidate);

      return info.bavail * info.bsize;
    } catch {
      continue;
    }
  }

  return null;
}

/** `2026-08-18_16-00-03`. Ordenável, e legível por quem lê a pasta. */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
