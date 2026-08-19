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
//  ####  O QUE DERRUBA O WIPE É O RISCO, E NÃO A LEITURA  ####
//
//  Um arquivo que SUMIU entre a listagem e a leitura é inofensivo:
//  ele não existe mais, e o zip sem ele guarda tudo o que havia.
//  Um arquivo que EXISTE e não se deixa ler é o oposto — o zip sai
//  incompleto e o passo SEGUINTE apaga o original, então o
//  conteúdo não fica no zip nem no disco. Os dois casos chegam
//  aqui como uma exceção do `readFile`, e só o `code` os separa.
//
//  Só que "o passo seguinte apaga" não vale para a pasta inteira.
//  MEDIDO na pasta de verdade: 12 dos 23 arquivos são `keep` por
//  save-files.ts — `Log.EAC.txt`, `companion.id`, os `player.*`,
//  os `clans.*`, os `relationship.*` e os `-wal`/`-shm` deles —, e
//  o passo `apagar` não encosta em nenhum. Um deles fora do zip
//  NÃO é conteúdo em risco: ele continua inteiro em disco depois
//  do wipe.
//
//  E o caso não é hipotético. O EAC segura o próprio `Log.EAC.txt`
//  depois de um RustDedicated morto à força — que é exatamente o
//  caminho "o servidor travou, force o wipe". Enquanto QUALQUER
//  leitura recusada era fatal, esse log travado parava o wipe da
//  madrugada com o servidor FORA DO AR e sem mapa novo, para
//  proteger um arquivo que ninguém ia apagar.
//
//  Quem decide a fatalidade, então, é `deletes`: o passo `apagar`
//  vai levar ESTE arquivo? Vai, e o wipe para aqui; não vai, e ele
//  segue com o aviso — que sobe para a tela em `skipped`, e não só
//  para o log. Quem não informa nada é tratado como se apagasse
//  tudo: a recusa é o padrão seguro.
//
//  ------------------------------------------------------------
//  ####  E O ZIP COBRE TAMBÉM O QUE O FULL WIPE LEVA  ####
//
//  Este cabeçalho dizia "o que o backup guarda é exatamente o que
//  o wipe pode apagar", e era verdade só para o wipe de mapa/BP.
//  O FULL WIPE leva os `.json` de `oxide\data` — a carteira, o
//  VIP, a economia —, e eles não moram na pasta do save.
//
//  MEDIDO: full wipe com backup LIGADO e `OrigemZStore.json`
//  marcado. Depois, o arquivo não estava em disco NEM no zip de 23
//  entradas, e nenhuma linha da tela avisou — `BACKUP_DISABLED` só
//  aparece quando o backup está DESLIGADO. O par `.db`/`-wal` do
//  mesmo wipe voltava do zip, porque mora na pasta do save; a
//  carteira não voltava de lugar nenhum.
//
//  Por isso `extras`: o passo `backup` resolve os alvos do full
//  wipe pela MESMA função que o `apagar` consome, e o que estiver
//  fora da pasta do save entra no zip com o caminho relativo à
//  pasta do servidor.
//
//  Nome SOLTO dentro do zip = pasta do save; nome COM BARRA =
//  relativo à pasta do servidor. É a regra inteira, e ela cabe
//  numa linha porque o backup do save não tem subpasta.
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

import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, statfs, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
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

/**
 * As esperas entre as tentativas de ler um arquivo travado.
 *
 * ####  A TRAVA DO ANTIVÍRUS É PASSAGEIRA  ####
 *
 * O caso medido é o antivírus escaneando o `.sav` que o servidor
 * acabou de fechar: o handle dele impede a leitura por um ou dois
 * segundos e some sozinho. Desistir na primeira negativa
 * transformaria essa espera num wipe abortado — e insistir para
 * sempre deixaria o servidor fora do ar sem fim.
 *
 * Quatro esperas, ~3,7 s no total por arquivo, e só no caminho da
 * falha: a leitura que dá certo de primeira não espera nada.
 */
export const BACKUP_READ_RETRY_DELAYS_MS: readonly number[] = [200, 500, 1000, 2000];

/**
 * Os erros de "o arquivo existe, mas agora não dá".
 *
 * No Windows é o que sai de um handle sem `FILE_SHARE_READ`
 * (antivírus, backup em nuvem, um RustDedicated que não morreu de
 * verdade). Nenhum deles significa que o conteúdo acabou — só que
 * ele não está disponível NESTE instante.
 */
const LOCKED_CODES: ReadonlySet<string> = new Set([
  'EBUSY',
  'EACCES',
  'EPERM',
  'EMFILE',
  'ENFILE',
]);

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
  /** O tamanho do zip. */
  readonly bytes: number;
  /**
   * O tamanho CRU do que entrou no zip.
   *
   * Existe para a frase do histórico: o passo `apagar` conta bytes
   * crus, e um `backup` que só soubesse dizer o tamanho comprimido
   * deixava duas medidas da MESMA pasta se contradizendo na tela,
   * sem nada explicando que a diferença era a compressão.
   */
  readonly rawBytes: number;
  readonly files: number;
  /** Quantas entradas vieram de FORA da pasta do save. Ver `extras`. */
  readonly extras: number;
  /**
   * Os arquivos que não se deixaram ler e ficaram de fora do zip.
   *
   * Só entra aqui o que o passo `apagar` NÃO vai levar: o que ele
   * leva não fica de fora, derruba o backup. Existe para a tela —
   * uma linha que sumiu do zip em silêncio é a diferença entre um
   * backup completo e um que alguém ACHA que é.
   */
  readonly skipped: readonly string[];
  /** Os zips antigos que a poda removeu. */
  readonly pruned: readonly string[];
}

/**
 * Um arquivo de fora da pasta do save que entra no zip.
 *
 * São os alvos do full wipe que moram em `oxide\data`. Quem os
 * resolve é o passo `backup` (ver run.ts), pela MESMA
 * `resolvePluginDataTargets` que o `apagar` consome — duas contas
 * diferentes sobre o que vai sumir seriam duas verdades, e a
 * divergência só apareceria no dia da restauração.
 */
export interface BackupExtra {
  /** Onde ele está em disco, caminho absoluto. */
  readonly absolute: string;
  /** O nome da entrada no zip: relativo à pasta do servidor, com `/`. */
  readonly name: string;
}

/** Um arquivo que entra no zip, e o que se perde sem ele. */
interface BackupItem {
  readonly absolute: string;
  /** O nome da entrada no zip. Ver o cabeçalho. */
  readonly name: string;
  /** O passo `apagar` vai levar este arquivo? Ver o cabeçalho. */
  readonly atRisk: boolean;
  /** Veio de fora da pasta do save. */
  readonly extra: boolean;
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
 *
 * ####  A RÉGUA É A PASTA DO SAVE, E SÓ ELA  ####
 *
 * Os `extras` do full wipe não entram na conta: são os `.json` de
 * `oxide\data`, e a pasta inteira deles cabe muitas vezes dentro
 * da folga de meio giga que esta conferência exige por cima. Somar
 * um número irrelevante custaria uma varredura do disco na rota
 * que a tela chama a cada recarregada.
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
 * Zipa a pasta do save, mais o que o full wipe leva de fora dela.
 *
 * ####  SÓ ARQUIVO, SÓ O NÍVEL DE CIMA  ####
 *
 * Da pasta do save, o mesmo recorte de save-files.ts, e de
 * propósito: `cfg\` e `command_history\` não são o save, e um zip
 * com mais coisa dentro prometeria restaurar o que ele não é
 * responsável por preservar.
 *
 * O que vem por `extras` não obedece a esse recorte porque não
 * precisa: cada um deles é um arquivo que o `apagar` VAI remover.
 * Ver o cabeçalho.
 *
 * Pasta inexistente e sem extras devolve `null`: é o servidor que
 * nunca subiu, e o passo `backup` trata isso como `skipped` — não
 * há o que copiar, e isso não é falha.
 */
export async function backupSaveFolder(options: {
  readonly saveDir: string;
  readonly backupsDir: string;
  readonly at?: number;
  readonly keep?: number;
  readonly onLine?: (line: string) => void;
  /**
   * As esperas entre as tentativas de ler um arquivo travado.
   *
   * O padrão é `BACKUP_READ_RETRY_DELAYS_MS`. Quem passa outra
   * coisa é o teste, que precisa provar a desistência sem gastar
   * quatro segundos de relógio de verdade.
   */
  readonly readRetryDelaysMs?: readonly number[];
  /**
   * O passo `apagar` vai levar este nome da pasta do save?
   *
   * É ela que decide o que é FATAL não conseguir ler. Ausente, tudo
   * é tratado como em risco — quem não sabe o que o wipe apaga não
   * pode decidir seguir sem um arquivo. Ver o cabeçalho.
   */
  readonly deletes?: (name: string) => boolean;
  /** O que o full wipe leva de FORA da pasta do save. Ver o cabeçalho. */
  readonly extras?: readonly BackupExtra[];
}): Promise<BackupResult | null> {
  const names = await filesIn(options.saveDir);
  const extras = options.extras ?? [];

  if (names.length === 0 && extras.length === 0) {
    return null;
  }

  const deletes = options.deletes;

  const items: readonly BackupItem[] = [
    ...names.map((name) => ({
      absolute: join(options.saveDir, name),
      name,
      atRisk: deletes === undefined || deletes(name),
      extra: false,
    })),
    // O que vem de fora da pasta do save é, por construção, alvo do
    // purge: não conseguir lê-lo é sempre fatal.
    ...extras.map((extra) => ({
      absolute: extra.absolute,
      name: extra.name,
      atRisk: true,
      extra: true,
    })),
  ];

  await mkdir(options.backupsDir, { recursive: true });

  const opened = await openFreshZip(options.backupsDir, options.at ?? Date.now());

  const written = await writeZip({
    items,
    output: opened.output,
    target: opened.path,
    onLine: options.onLine,
    retryDelaysMs: options.readRetryDelaysMs ?? BACKUP_READ_RETRY_DELAYS_MS,
  });

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

async function writeZip(input: {
  readonly items: readonly BackupItem[];
  readonly output: WriteStream;
  readonly target: string;
  readonly onLine?: (line: string) => void;
  readonly retryDelaysMs: readonly number[];
}): Promise<Omit<BackupResult, 'pruned'>> {
  const { items, output, target, onLine } = input;
  const entries: CentralEntry[] = [];
  const skipped: string[] = [];
  let offset = 0;
  let rawBytes = 0;
  let extras = 0;

  const put = async (chunk: Buffer): Promise<void> => {
    if (!output.write(chunk)) {
      await new Promise<void>((resolve) => output.once('drain', resolve));
    }

    offset += chunk.length;
  };

  try {
    for (const item of items) {
      const name = item.name;
      const read = await readForBackup(item, input.retryDelaysMs, onLine);

      if (read.kind === 'gone') {
        // `ENOENT`: o arquivo sumiu entre a listagem e a leitura. Um
        // a menos no zip é melhor que um backup que não termina — e
        // não há conteúdo perdido, porque não há mais conteúdo.
        onLine?.(`[backup] ${name} sumiu antes de ser copiado — segui sem ele.`);
        continue;
      }

      if (read.kind === 'locked') {
        // Travado, e o `apagar` NÃO leva este arquivo: ele continua
        // em disco depois do wipe, e não há conteúdo em risco. A
        // linha já foi para o log; a lista sobe para a tela.
        skipped.push(name);
        continue;
      }

      const { raw, modified } = read;
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

      rawBytes += raw.length;

      if (item.extra) {
        extras += 1;
      }

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

    // Esperar o `close` antes de apagar: no Windows o `unlink` de um
    // arquivo cujo handle ainda não fechou volta `EBUSY`, e o zip
    // pela metade sobreviveria à limpeza.
    if (!output.closed) {
      await once(output, 'close').catch(() => undefined);
    }

    // O zip pela metade é removido: um arquivo com o nome certo e
    // o conteúdo incompleto é o que faria alguém confiar nele no
    // dia em que precisasse restaurar.
    await rm(target, { force: true }).catch(() => undefined);

    throw error;
  }

  return { path: target, bytes: offset, rawBytes, files: entries.length, extras, skipped };
}

/**
 * O zip novo, num caminho que NUNCA é o de um zip que já existe.
 *
 * ####  `wx`, E NÃO `w`  ####
 *
 * Enquanto o carimbo tinha resolução de segundo, dois backups no
 * mesmo segundo escreviam no MESMO caminho e o segundo comia o
 * primeiro sem uma linha de log. O milissegundo torna o encontro
 * improvável; a flag `wx` torna o estrago impossível — o sistema
 * recusa abrir um arquivo que existe, e aqui a recusa vira o
 * próximo nome livre em vez de uma sobrescrita silenciosa.
 */
async function openFreshZip(
  dir: string,
  at: number,
): Promise<{ readonly output: WriteStream; readonly path: string }> {
  const base = `wipe-${stamp(at)}`;

  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const path = join(dir, attempt === 1 ? `${base}.zip` : `${base}-${String(attempt)}.zip`);
    const output = createWriteStream(path, { flags: 'wx' });

    try {
      await once(output, 'open');

      return { output, path };
    } catch (error) {
      output.destroy();

      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error(
    `não consegui um nome livre para o backup em ${dir}: cem tentativas a partir de ${base}.zip, ` +
      'e todas já existiam.',
  );
}

/** O desfecho de uma leitura para o zip. Ver `readForBackup`. */
type BackupRead =
  | { readonly kind: 'read'; readonly raw: Buffer; readonly modified: Date }
  /** Não existe mais: não há conteúdo a perder. */
  | { readonly kind: 'gone' }
  /** Existe, não se deixou ler — e este wipe não vai apagá-lo. */
  | { readonly kind: 'locked' };

/**
 * Os bytes de um arquivo que vai para o zip.
 *
 * ####  "SUMIU" E "NÃO CONSEGUI LER" SÃO OPOSTOS  ####
 *
 * Enquanto os dois caíam no mesmo `catch`, um `.sav` travado pelo
 * antivírus virava a linha "sumiu antes de ser copiado", o passo
 * `backup` terminava `done` com 22 dos 23 arquivos dentro, e o
 * `apagar` levava o original. O mundo não ficava no zip nem no
 * disco — restaurar aquele backup devolveria o terreno sem as
 * construções.
 *
 * Então `ENOENT` passa: não há conteúdo a perder.
 *
 * ####  E "NÃO CONSEGUI LER" TEM DOIS DESFECHOS  ####
 *
 * Quem separa os dois é `item.atRisk`, e não o `code`. O arquivo
 * que o `apagar` VAI levar lança — o wipe para antes do `apagar`,
 * com o servidor parado e o mundo inteiro em disco. O arquivo que
 * o `apagar` NÃO leva volta `locked`: ele fica de fora do zip,
 * continua em disco, e a única coisa que faltava era a tela dizer
 * isso. Ver o cabeçalho.
 *
 * Antes de qualquer um dos dois, porém, ele insiste: ver
 * `BACKUP_READ_RETRY_DELAYS_MS`.
 */
async function readForBackup(
  item: BackupItem,
  delaysMs: readonly number[],
  onLine?: (line: string) => void,
): Promise<BackupRead> {
  const full = item.absolute;
  const name = basename(full);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const raw = await readFile(full);

      if (attempt > 0) {
        onLine?.(
          `[backup] ${name} liberou na tentativa ${String(attempt + 1)} — está dentro do zip.`,
        );
      }

      return { kind: 'read', raw, modified: await mtimeOf(full) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        return { kind: 'gone' };
      }

      const wait = LOCKED_CODES.has(code ?? '') ? delaysMs[attempt] : undefined;

      if (wait === undefined) {
        if (!item.atRisk) {
          onLine?.(
            `[backup] ${name} não se deixou ler (${code ?? '?'}) e ficou de fora do zip — este ` +
              'wipe NÃO apaga esse arquivo, e ele continua inteiro em disco.',
          );

          return { kind: 'locked' };
        }

        throw new Error(
          `não consegui ler ${name} para o backup: ${(error as Error).message}. ` +
            (attempt === 0
              ? ''
              : `Tentei ${String(attempt + 1)} vezes. `) +
            'Este arquivo é um dos que o passo seguinte APAGA, e o que não entra no zip a ' +
            'restauração não devolve — então este wipe para aqui. O servidor está parado e o ' +
            'mundo continua inteiro em disco. Antivírus e backup em nuvem são a causa comum e ' +
            'soltam o arquivo sozinhos: espere um pouco e retome a execução. Se você aceita ' +
            'ficar sem volta atrás, desligue o backup na Configuração antes de retomar.',
          { cause: error },
        );
      }

      onLine?.(
        `[backup] ${name} está travado por outro processo (${code ?? '?'}) — espero ` +
          `${String(wait)} ms e tento de novo.`,
      );

      await esperar(wait);
    }
  }
}

/**
 * O `mtime`, e `agora` quando não deu para perguntar.
 *
 * A data só alimenta o carimbo da entrada no zip, que é cosmético.
 * Descartar um arquivo JÁ LIDO por causa dela seria trocar
 * conteúdo por enfeite.
 */
async function mtimeOf(full: string): Promise<Date> {
  try {
    return (await stat(full)).mtime;
  } catch {
    return new Date();
  }
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

/**
 * `2026-08-18_16-00-03-472`. Ordenável, e legível por quem lê a
 * pasta.
 *
 * O milissegundo no fim não é enfeite: com resolução de segundo,
 * dois backups do mesmo segundo montavam o MESMO nome e o segundo
 * sobrescrevia o primeiro sem erro nenhum. Quem garante que isso
 * não acontece é o `wx` do `openFreshZip`; o milissegundo é o que
 * faz o segundo nome sair na primeira tentativa.
 */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` +
    `-${String(date.getMilliseconds()).padStart(3, '0')}`
  );
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
