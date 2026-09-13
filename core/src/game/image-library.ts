// ============================================================
//  image-library.ts  -  o lado de cá do OrigemZImages.
//
//  Um caminho só para toda imagem nossa chegar ao jogo: as do
//  menu (`Assets\ui`), as das propagandas e os ícones de item
//  custom (`Assets\items`). O plugin guarda os bytes no FileStorage
//  do servidor e entrega o CRC a quem desenha.
//
//  Contrato do outro lado: Plugins\OrigemZImages.cs.
//  MUDAR UM COMANDO AQUI EXIGE MUDAR O PLUGIN JUNTO.
//
//  ------------------------------------------------------------
//  ####  POR QUE UM MÓDULO SÓ  ####
//
//  Eram três cópias — `origemz.ui.image`, `origemz.ads.image.*` e
//  `origemz.item.icon*` — com três tetos e dois fatiamentos. A do
//  ícone de item nem tinha quem a chamasse: o PNG ficava em
//  `Assets\items` e o jogo nunca o recebia.
//
//  ------------------------------------------------------------
//  ####  O MANIFESTO DECIDE O QUE SOBE  ####
//
//  Antes de mandar qualquer byte, a biblioteca pergunta ao plugin o
//  que ele já tem (`origemz.image.list` → chave → sha256). Sobe só o
//  que falta ou mudou. Três consequências boas:
//
//    - a sincronização periódica deixa de reenviar as imagens do
//      menu a cada cinco minutos;
//    - um `oxide.reload` do plugin não custa nada: ele relê a tabela
//      do disco, e o manifesto diz que está tudo lá;
//    - um reinício do AGENTE também não: os bytes só são lidos (ou
//      rebaixados) quando o plugin não tem aquela versão — ver
//      `ImageAsset.load`.
//
//  É o `HasImage` do ImageLibrary, virado protocolo.
//
//  ------------------------------------------------------------
//  ####  POR QUE OS BYTES VÃO EM PEDAÇOS  ####
//
//  O frame do WebRCON aguenta ~50.000 bytes (medido neste projeto),
//  e base64 infla o arquivo em 4/3. Cada imagem vai em pedaços
//  numerados; o plugin só guarda depois do `end`, conferindo a
//  contagem e o tamanho. Meio arquivo nunca vira imagem.
//
//  ------------------------------------------------------------
//  ####  UM ENVIO POR VEZ, POR SERVIDOR  ####
//
//  O menu, as propagandas e os itens sincronizam em relógios
//  independentes, e dois deles podem mandar a MESMA chave ao mesmo
//  tempo (o logo do overlay pode ser uma imagem do menu). Um `begin`
//  no meio dos pedaços de outro recomeçaria o envio do lado de lá.
//  Por isso `sync` enfileira por servidor.
//
//  ------------------------------------------------------------
//  ####  ELE NUNCA LANÇA  ####
//
//  Roda dentro dos três sincronizadores, que rodam em timer. Falha
//  vira desfecho: uma imagem que não subiu é um quadrado vazio, e
//  não pode derrubar o menu nem a propaganda.
// ============================================================

import { createHash } from 'node:crypto';

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

/** `origemz.image.begin <chave> <partes> <bytes> <sha>` */
export const IMAGE_BEGIN_COMMAND = 'origemz.image.begin';
/** `origemz.image.part <chave> <índice> <base64>` */
export const IMAGE_PART_COMMAND = 'origemz.image.part';
/** `origemz.image.end <chave>` */
export const IMAGE_END_COMMAND = 'origemz.image.end';
/** `origemz.image.list` — o manifesto. */
export const IMAGE_LIST_COMMAND = 'origemz.image.list';
/** `origemz.image.forget <chave>` — esquece o mapa, não os bytes. */
export const IMAGE_FORGET_COMMAND = 'origemz.image.forget';

/**
 * Bytes de arquivo por pedaço.
 *
 * 27.000 viram 36.000 caracteres de base64, mais o comando e a
 * chave — abaixo dos ~50.000 do frame, com folga para a chave mais
 * longa que o plugin aceita.
 */
export const IMAGE_CHUNK_BYTES = 27_000;

/**
 * Maior imagem aceita, em bytes de arquivo.
 *
 * O MESMO número do plugin (`MaxBytes`): é o teto de transferência
 * de arquivo do FileStorage para o cliente. Recusar aqui poupa
 * mandar 117 pedaços que o `begin` recusaria.
 */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * A régua da chave. A MESMA do plugin (`IsValidKey`).
 *
 * A chave viaja num comando de console separado por ESPAÇO, e dentro
 * do lugar reservado `{img:chave}` do OrigemZUI — onde `}` fecharia o
 * lugar no meio dela.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function isValidImageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * As famílias de chave que têm DONO, e por isso podem ser podadas.
 *
 * ####  POR QUE PODAR  ####
 *
 * A tabela do OrigemZImages sobrevive a reload e a restart. Sem
 * poda, um ícone tirado de um item no painel continuaria sendo
 * aplicado no jogo para sempre, e cada propaganda trocada deixaria
 * uma chave velha — o manifesto cresceria até não caber no frame do
 * RCON.
 *
 * ####  POR QUE AS FAMÍLIAS SÃO RESERVADAS  ####
 *
 * Quem poda só pode tocar no que é seu. As imagens do menu têm o
 * nome do arquivo como chave, e um `item.moeda.png` em `Assets\ui`
 * seria podado pelos itens e reenviado pelo menu, a cada rodada.
 * Por isso `loadUiImages` recusa nome que caia numa destas.
 */
export const IMAGE_FAMILIES = {
  /** `ad` + os 12 primeiros dígitos do sha. Ver `imageKeyOf`. */
  ad: (key: string): boolean => /^ad[0-9a-f]{12}$/.test(key),
  /** `item.<id>`. Ver `itemIconKey`. */
  item: (key: string): boolean => key.startsWith('item.'),
  /** `store.<id da oferta>`. Ver `storeIconKey`. */
  store: (key: string): boolean => key.startsWith('store.'),
  /** `kit.<slug>`. Ver `kitIconKey`. */
  kit: (key: string): boolean => key.startsWith('kit.'),
} as const;

export function isReservedImageKey(key: string): boolean {
  return (
    IMAGE_FAMILIES.ad(key) ||
    IMAGE_FAMILIES.item(key) ||
    IMAGE_FAMILIES.store(key) ||
    IMAGE_FAMILIES.kit(key)
  );
}

/**
 * O que um sincronizador pode apagar.
 *
 * `owns` diz quais chaves são dele; `keep`, quais continuam valendo
 * além das que ele acabou de mandar (a propaganda fora da janela de
 * horário não sobe agora, mas não pode ser esquecida — senão subiria
 * inteira de novo quando a janela abrisse).
 */
export interface ImagePrune {
  readonly owns: (key: string) => boolean;
  readonly keep?: ReadonlySet<string>;
}

/**
 * Uma imagem a garantir no servidor.
 *
 * ####  OS BYTES SÃO PREGUIÇOSOS, DE PROPÓSITO  ####
 *
 * A chave e o sha bastam para comparar com o manifesto. Os bytes só
 * são pedidos quando o plugin NÃO tem esta versão — e é isso que faz
 * uma propaganda cujo cache em memória se perdeu (o agente
 * reiniciou) não ser rebaixada à toa: o sha está no banco, e o
 * plugin já tem o arquivo.
 */
export interface ImageAsset {
  readonly key: string;
  /** sha256 do conteúdo, em hex minúsculo. */
  readonly sha: string;
  /** Os bytes. `null` = não deu para obtê-los (e a imagem fica de fora). */
  readonly load: () => Buffer | null | Promise<Buffer | null>;
}

/** O sha256 que o manifesto usa. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Uma imagem cujos bytes já estão na mão. */
export function imageAsset(key: string, bytes: Buffer): ImageAsset {
  return { key, sha: sha256Hex(bytes), load: () => bytes };
}

/** O que a biblioteca precisa de um RCON. E nada além disso. */
export interface ImageRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

export interface ImageFailure {
  readonly key: string;
  readonly reason: string;
}

export type ImageSyncOutcome =
  | {
      readonly status: 'synced';
      /** As chaves que subiram nesta rodada. */
      readonly sent: readonly string[];
      /** Quantas o plugin já tinha, na mesma versão. */
      readonly unchanged: number;
      readonly failed: readonly ImageFailure[];
      /** As chaves esquecidas pela poda. Ver `ImagePrune`. */
      readonly pruned: readonly string[];
    }
  /**
   * Não deu para nem perguntar. Dois casos, e os dois se resolvem
   * sozinhos na próxima rodada: o OrigemZImages não está carregado,
   * ou o servidor ainda está subindo (`ready:false`).
   */
  | { readonly status: 'unavailable'; readonly reason: string };

/** O que o manifesto respondeu. `null` = não é o OrigemZImages respondendo. */
export interface ImageManifest {
  readonly ready: boolean;
  readonly images: ReadonlyMap<string, string>;
}

/**
 * Lê a resposta do `origemz.image.list`.
 *
 * `null` para tudo que não é o JSON do plugin — e o caso comum disso
 * é o plugin não estar carregado, quando o console responde que o
 * comando não existe.
 */
export function parseManifest(response: string): ImageManifest | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(response.trim());
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const body = parsed as { ok?: unknown; ready?: unknown; images?: unknown };

  if (body.ok !== true || typeof body.images !== 'object' || body.images === null) {
    return null;
  }

  const images = new Map<string, string>();

  for (const [key, sha] of Object.entries(body.images as Record<string, unknown>)) {
    if (typeof sha === 'string') {
      images.set(key, sha);
    }
  }

  return { ready: body.ready === true, images };
}

/**
 * Os bytes em pedaços de base64, prontos para o RCON.
 *
 * O corte é feito nos BYTES e não no base64: cortar base64 no meio
 * de um grupo de quatro produziria pedaços que não decodificam
 * sozinhos. Assim cada pedaço é um base64 válido por si.
 */
export function chunkImage(bytes: Buffer, chunkBytes: number = IMAGE_CHUNK_BYTES): readonly string[] {
  const parts: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    parts.push(bytes.subarray(offset, offset + chunkBytes).toString('base64'));
  }

  return parts;
}

export function buildImageBeginCommand(
  key: string,
  parts: number,
  bytes: number,
  sha: string,
): string {
  return `${IMAGE_BEGIN_COMMAND} ${key} ${String(parts)} ${String(bytes)} ${sha}`;
}

export function buildImagePartCommand(key: string, index: number, part: string): string {
  return `${IMAGE_PART_COMMAND} ${key} ${String(index)} ${part}`;
}

export function buildImageEndCommand(key: string): string {
  return `${IMAGE_END_COMMAND} ${key}`;
}

/** O código de erro de uma resposta do plugin, para o log. */
function refusalOf(response: string): string | null {
  if (response.includes('"ok":true')) {
    return null;
  }

  const match = /"error":"([A-Z_]+)"/.exec(response);
  return match?.[1] ?? (response.trim().slice(0, 120) || 'sem resposta');
}

export interface ImageLibraryDeps {
  readonly logger?: Logger | undefined;
  /** Injetável no teste. Ver `RETRY_DELAY_MS`. */
  readonly retryDelayMs?: number;
}

/**
 * De quanto em quanto tempo tentar de novo quem esperou o boot.
 *
 * ####  O RCON ABRE ANTES DE O SERVIDOR ESTAR PRONTO  ####
 *
 * MEDIDO em 11/09/2026 no server01: `WebSocket RCON Started` sai
 * antes de o mundo ser gerado, e o "Server startup complete" vem
 * quase um minuto depois. É exatamente nessa janela que o agente
 * reconecta e sincroniza tudo — e o manifesto responde
 * `ready:false`. O menu e o overlay têm relógio periódico e se
 * recuperariam em cinco minutos; os ícones de item não têm relógio
 * nenhum, e ficariam de fora até a próxima edição.
 *
 * Então a biblioteca guarda o que esperou e tenta de novo SOZINHA,
 * sem segurar quem chamou: a carga do menu desce na hora, e as
 * imagens chegam quando o servidor fica pronto.
 */
const RETRY_DELAY_MS = 15_000;

/**
 * Quantas vezes insistir. 16 × 15 s = 4 minutos, bem acima do boot
 * medido. Passando disso o servidor não está "subindo", está
 * quebrado — e a próxima sincronização normal tenta de novo.
 */
const MAX_RETRIES = 16;

interface WaitingImages {
  readonly rcon: ImageRcon;
  /** Chave -> imagem. Juntas as de todos os sincronizadores que esperaram. */
  readonly assets: Map<string, ImageAsset>;
  attempts: number;
  timer: NodeJS.Timeout | null;
}

export class ImageLibrary {
  readonly #logger: Logger | undefined;
  readonly #retryDelayMs: number;

  /** id do servidor -> a rodada em curso. Ver o cabeçalho. */
  readonly #queues = new Map<string, Promise<unknown>>();

  /** id do servidor -> o que esperou o boot. Ver `RETRY_DELAY_MS`. */
  readonly #waiting = new Map<string, WaitingImages>();

  /**
   * O último "não deu para perguntar", por servidor.
   *
   * O aviso sai quando o estado MUDA, e não a cada rodada: são três
   * sincronizadores de cinco em cinco minutos, e a mesma frase
   * repetida o dia inteiro só ensinaria a ignorar o log.
   */
  readonly #unavailable = new Map<string, string>();

  constructor(deps: ImageLibraryDeps = {}) {
    this.#logger = deps.logger;
    this.#retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** Cancela as novas tentativas pendentes. Só o desligamento chama. */
  stop(): void {
    for (const waiting of this.#waiting.values()) {
      if (waiting.timer !== null) {
        clearTimeout(waiting.timer);
      }
    }

    this.#waiting.clear();
  }

  /**
   * Garante que o plugin daquele servidor tem estas imagens, nesta
   * versão. NUNCA lança.
   */
  sync(
    serverId: string,
    rcon: ImageRcon,
    assets: readonly ImageAsset[],
    prune?: ImagePrune,
  ): Promise<ImageSyncOutcome> {
    const previous = this.#queues.get(serverId) ?? Promise.resolve();
    const run = previous.then(() => this.#sync(serverId, rcon, assets, prune));
    // A fila guarda a versão que nunca rejeita: `#sync` não lança, mas
    // um defeito nele não pode travar as rodadas seguintes.
    const settled = run.catch(() => undefined);

    this.#queues.set(serverId, settled);

    void settled.then(() => {
      if (this.#queues.get(serverId) === settled) {
        this.#queues.delete(serverId);
      }
    });

    return run;
  }

  async #sync(
    serverId: string,
    rcon: ImageRcon,
    assets: readonly ImageAsset[],
    prune?: ImagePrune,
  ): Promise<ImageSyncOutcome> {
    if (assets.length === 0 && prune === undefined) {
      // Nada a garantir e nada a podar: nem vale a ida ao RCON.
      return { status: 'synced', sent: [], unchanged: 0, failed: [], pruned: [] };
    }

    let manifest: ImageManifest | null;

    try {
      manifest = parseManifest(await rcon.send(IMAGE_LIST_COMMAND));
    } catch (error) {
      return this.#markUnavailable(serverId, `o RCON falhou: ${toError(error).message}`);
    }

    if (manifest === null) {
      return this.#markUnavailable(
        serverId,
        'o OrigemZImages não respondeu — ele está ligado neste servidor? Sem ele, as imagens ' +
          'próprias do menu, das propagandas e dos itens não aparecem.',
      );
    }

    if (!manifest.ready) {
      this.#waitForBoot(serverId, rcon, assets);
      return this.#markUnavailable(serverId, 'o servidor ainda está subindo');
    }

    if (this.#unavailable.delete(serverId)) {
      this.#logger?.info({ server: serverId }, 'o OrigemZImages voltou a responder');
    }

    const sent: string[] = [];
    const failed: ImageFailure[] = [];
    const seen = new Set<string>();
    let unchanged = 0;

    for (const asset of assets) {
      // A mesma chave duas vezes na lista: a primeira vale. O logo do
      // overlay e uma imagem do menu podem ser o mesmo arquivo.
      if (seen.has(asset.key)) {
        continue;
      }

      seen.add(asset.key);

      if (!isValidImageKey(asset.key)) {
        failed.push({
          key: asset.key,
          reason:
            'a chave não serve: use minúsculas, dígitos, ponto, hífen ou sublinhado (ela viaja ' +
            'num comando de console)',
        });
        continue;
      }

      if (manifest.images.get(asset.key) === asset.sha) {
        unchanged += 1;
        continue;
      }

      const reason = await this.#push(rcon, asset);

      if (reason === null) {
        sent.push(asset.key);
      } else {
        failed.push({ key: asset.key, reason });
      }
    }

    const pruned = prune === undefined ? [] : await this.#prune(rcon, manifest, seen, prune);

    if (sent.length > 0 || pruned.length > 0) {
      this.#logger?.info(
        { server: serverId, sent, unchanged, pruned },
        'imagens sincronizadas com o OrigemZImages',
      );
    }

    for (const failure of failed) {
      this.#logger?.warn(
        { server: serverId, key: failure.key, reason: failure.reason },
        'uma imagem não chegou ao OrigemZImages',
      );
    }

    return { status: 'synced', sent, unchanged, failed, pruned };
  }

  /**
   * Esquece, no plugin, as chaves do dono que ninguém mais usa.
   *
   * Uma falha aqui só adia a poda para a próxima rodada: chave velha
   * no mapa não quebra nada até alguém a pedir.
   */
  async #prune(
    rcon: ImageRcon,
    manifest: ImageManifest,
    current: ReadonlySet<string>,
    prune: ImagePrune,
  ): Promise<readonly string[]> {
    const pruned: string[] = [];

    for (const key of manifest.images.keys()) {
      if (!prune.owns(key) || current.has(key) || prune.keep?.has(key) === true) {
        continue;
      }

      try {
        if ((await rcon.send(`${IMAGE_FORGET_COMMAND} ${key}`)).includes('"ok":true')) {
          pruned.push(key);
        }
      } catch {
        // Ver o comentário acima: a próxima rodada tenta de novo.
      }
    }

    return pruned;
  }

  /** Manda UMA imagem. Devolve `null` quando deu certo, ou o motivo. */
  async #push(rcon: ImageRcon, asset: ImageAsset): Promise<string | null> {
    let bytes: Buffer | null;

    try {
      bytes = await asset.load();
    } catch (error) {
      return `não consegui obter os bytes: ${toError(error).message}`;
    }

    if (bytes === null || bytes.length === 0) {
      return 'não consegui obter os bytes';
    }

    if (bytes.length > IMAGE_MAX_BYTES) {
      return (
        `a imagem tem ${String(bytes.length)} bytes e o teto é ${String(IMAGE_MAX_BYTES)} — o ` +
        'cliente do Rust não recebe arquivo maior que isso'
      );
    }

    // ####  O SHA QUE VIAJA É O DOS BYTES QUE VIAJAM  ####
    //
    // Um rebaixamento pode devolver outro conteúdo (a URL mudou de
    // imagem). Mandá-lo com o sha antigo faria o manifesto mentir
    // para sempre: a próxima rodada acharia que o plugin já tem a
    // versão certa.
    const sha = sha256Hex(bytes);

    if (sha !== asset.sha) {
      return 'o conteúdo mudou desde que a chave foi calculada; a próxima rodada tenta de novo';
    }

    try {
      const parts = chunkImage(bytes);

      const begun = refusalOf(
        await rcon.send(buildImageBeginCommand(asset.key, parts.length, bytes.length, sha)),
      );

      if (begun !== null) {
        return `o plugin recusou o começo: ${begun}`;
      }

      for (let index = 0; index < parts.length; index += 1) {
        // `parts[index]` é definido pelo laço, mas
        // noUncheckedIndexedAccess não sabe disso.
        const refused = refusalOf(
          await rcon.send(buildImagePartCommand(asset.key, index, parts[index] ?? '')),
        );

        if (refused !== null) {
          return `o plugin recusou o pedaço ${String(index)}: ${refused}`;
        }
      }

      const ended = refusalOf(await rcon.send(buildImageEndCommand(asset.key)));

      return ended === null ? null : `o plugin recusou o fim: ${ended}`;
    } catch (error) {
      return `o RCON falhou: ${toError(error).message}`;
    }
  }

  /**
   * Guarda o que esperou o boot e agenda uma nova tentativa.
   *
   * Um timer por servidor, com as imagens de TODOS os sincronizadores
   * que chegaram cedo — o menu, o overlay e os itens reconectam no
   * mesmo instante, e três relógios fariam três perguntas iguais.
   */
  #waitForBoot(serverId: string, rcon: ImageRcon, assets: readonly ImageAsset[]): void {
    let waiting = this.#waiting.get(serverId);

    if (waiting === undefined) {
      waiting = { rcon, assets: new Map(), attempts: 0, timer: null };
      this.#waiting.set(serverId, waiting);
    }

    for (const asset of assets) {
      waiting.assets.set(asset.key, asset);
    }

    if (waiting.timer !== null) {
      return;
    }

    if (waiting.attempts >= MAX_RETRIES) {
      this.#logger?.warn(
        { server: serverId, attempts: waiting.attempts },
        'o servidor não ficou pronto a tempo; as imagens esperam a próxima sincronização',
      );
      this.#waiting.delete(serverId);
      return;
    }

    waiting.attempts += 1;

    const timer = setTimeout(() => {
      const current = this.#waiting.get(serverId);

      if (current === undefined) {
        return;
      }

      // Sai do mapa ANTES de tentar: se o servidor ainda estiver
      // subindo, `#sync` o põe de volta com a contagem preservada.
      current.timer = null;
      const pending = [...current.assets.values()];
      current.assets.clear();

      if (!current.rcon.isConnected) {
        this.#waitForBoot(serverId, current.rcon, pending);
        return;
      }

      void this.sync(serverId, current.rcon, pending).then(() => {
        // Ainda subindo: `#sync` já reagendou, e há timer. Pronto (ou
        // sem plugin, que não se resolve esperando): a espera acabou,
        // e a contagem de tentativas vai junto.
        const left = this.#waiting.get(serverId);

        if (left !== undefined && left.timer === null && left.assets.size === 0) {
          this.#waiting.delete(serverId);
        }
      });
    }, this.#retryDelayMs);

    timer.unref();
    waiting.timer = timer;
  }

  #markUnavailable(serverId: string, reason: string): ImageSyncOutcome {
    if (this.#unavailable.get(serverId) !== reason) {
      this.#unavailable.set(serverId, reason);
      this.#logger?.warn({ server: serverId, reason }, 'não deu para sincronizar as imagens');
    }

    return { status: 'unavailable', reason };
  }
}
