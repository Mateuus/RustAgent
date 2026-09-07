// ============================================================
//  ads-images.ts  -  a imagem da propaganda, de URL até o jogo.
//
//  ####  A CONFIGURACAO E POR URL; O TRANSPORTE, NAO  ####
//
//  O admin cadastra `https://meuservidor.com/ads/vip.jpg` e é só
//  isso que ele precisa saber. O que acontece depois depende do
//  `imageMode`:
//
//    url      o CLIENTE baixa do endereço. Zero trabalho aqui, e
//             o peso da imagem deixa de importar — mas o endereço
//             precisa ser público e o cliente precisa alcançá-lo.
//
//    stored   o AGENTE baixa, confere, e manda os bytes ao plugin;
//             o plugin os guarda no FileStorage do servidor e o
//             cliente pede a imagem pelo canal do jogo. É o
//             padrão, porque não depende de nada fora da nossa
//             máquina.
//
//  ------------------------------------------------------------
//  ####  POR QUE OS BYTES VAO EM PEDACOS  ####
//
//  O frame do WebRCON aguenta ~50.000 bytes (medido neste
//  projeto), e base64 infla o arquivo em 4/3. Uma propaganda de
//  600x200 passa disso com facilidade — o `origemz.ui.image`
//  existente, de um comando só, serve para o ícone de 17 KB do
//  OZCoin e não para isto.
//
//  Então a imagem vai em pedaços numerados, o plugin os junta e
//  só então chama o FileStorage. Meio arquivo nunca vira imagem:
//  o `end` confere a contagem antes de guardar.
//
//  ------------------------------------------------------------
//  ####  A CHAVE SAI DO CONTEUDO  ####
//
//  `ad` + os 12 primeiros dígitos do sha256. Duas consequências,
//  e as duas boas:
//
//    - a mesma imagem em duas propagandas ocupa UMA entrada;
//    - reenviar conteúdo idêntico devolve o mesmo CRC do
//      FileStorage e não acumula lixo no servidor.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO NAO REDIMENSIONA  ####
//
//  Fazê-lo exigiria uma dependência de processamento de imagem
//  (sharp é binário nativo; jimp é lento e pesado) para um
//  problema que o admin resolve uma vez, no editor de imagem
//  dele. O que existe aqui é RECUSA com número: "sua imagem tem
//  2 MB e o limite é 1,5 MB" diz o que fazer.
// ============================================================

import { createHash } from 'node:crypto';

import {
  ADS_CHUNK_BYTES,
  ADS_MAX_HEIGHT,
  ADS_MAX_WIDTH,
  ADS_STORED_MAX_BYTES,
} from '../types/ads.js';

/** `origemz.ads.image.begin <chave> <partes>` */
export const ADS_IMAGE_BEGIN_COMMAND = 'origemz.ads.image.begin';
/** `origemz.ads.image.part <chave> <indice> <base64>` */
export const ADS_IMAGE_PART_COMMAND = 'origemz.ads.image.part';
/** `origemz.ads.image.end <chave>` */
export const ADS_IMAGE_END_COMMAND = 'origemz.ads.image.end';

/**
 * O lugar reservado que o plugin troca pelo CRC (ou pela URL).
 *
 * MUDAR ISTO EXIGE MUDAR O PLUGIN JUNTO — ver `PersonalizeAd` em
 * OrigemZUI.cs. Mesmo mecanismo do `{token}` e do `{img:...}`: o
 * valor só existe em tempo de execução, do outro lado.
 */
export const AD_IMAGE_PLACEHOLDER = '{adimage}';

/**
 * Formatos que o cliente do Rust consegue montar.
 *
 * São dois, e só dois: o `ImageConversion.LoadImage` do Unity lê
 * PNG e JPEG. GIF e WebP não aparecem — e não aparecem em
 * SILÊNCIO, como um retângulo vazio, que é por que a recusa aqui
 * precisa dizer isso em letras.
 */
export type SupportedMime = 'image/png' | 'image/jpeg';

export interface ImageProbe {
  readonly mime: SupportedMime;
  readonly width: number;
  readonly height: number;
}

export interface FetchedImage {
  readonly bytes: Buffer;
  readonly sha: string;
  /** Chave estável, derivada do conteúdo. */
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly mime: string;
}

/**
 * Falha ao preparar uma imagem, com a frase que a tela mostra.
 *
 * A mensagem é em português e diz o NÚMERO: o admin precisa saber
 * o que corrigir, e "falha ao carregar" não é isso.
 */
export class AdImageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdImageError';
    this.code = code;
  }
}

/**
 * Formato e dimensões, lidos do CABEÇALHO do arquivo.
 *
 * ####  POR QUE NAO CONFIAR NO Content-Type  ####
 *
 * Ele é escolhido pelo servidor de onde a imagem veio, e um
 * `image/png` mentiroso viraria bytes que o cliente não monta —
 * um retângulo vazio no jogo, sem erro nenhum. Os primeiros bytes
 * do arquivo não mentem.
 *
 * `null` quando não é PNG nem JPEG.
 */
export function probeImage(bytes: Buffer): ImageProbe | null {
  if (isPng(bytes)) {
    // IHDR é sempre o primeiro chunk, e largura/altura vivem em
    // 16..23 como inteiros de 32 bits big-endian.
    if (bytes.length < 24) {
      return null;
    }

    return {
      mime: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (isJpeg(bytes)) {
    const size = readJpegSize(bytes);
    return size === null ? null : { mime: 'image/jpeg', ...size };
  }

  return null;
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Largura e altura de um JPEG.
 *
 * O tamanho não está no cabeçalho: ele mora num marcador SOF que
 * pode estar depois de metadados de tamanho arbitrário (EXIF,
 * perfil de cor, miniatura). Por isso a varredura de segmento em
 * segmento — e por isso ela tem um teto de voltas, para um
 * arquivo corrompido não virar laço infinito.
 */
function readJpegSize(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;

  for (let guard = 0; guard < 1024 && offset + 9 < bytes.length; guard += 1) {
    if (bytes[offset] !== 0xff) {
      return null;
    }

    const marker = bytes[offset + 1];
    if (marker === undefined) {
      return null;
    }

    // SOF0..SOF15, menos os que não carregam tamanho de imagem
    // (DHT=C4, JPG=C8, DAC=CC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }

    offset += 2 + bytes.readUInt16BE(offset + 2);
  }

  return null;
}

export interface FetchImageOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Injetável nos testes — o `fetch` global por padrão. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Baixa, confere e devolve os bytes prontos para o plugin.
 *
 * LANÇA `AdImageError` em toda recusa, com a frase pronta: quem
 * chama grava a mensagem no cache da propaganda, e a tela a
 * mostra sem ter de traduzir código de erro.
 */
export async function fetchAdImage(
  url: string,
  options: FetchImageOptions = {},
): Promise<FetchedImage> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? ADS_STORED_MAX_BYTES;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;

  try {
    // ####  TIMEOUT NAO E OPCIONAL  ####
    //
    // Isto roda no boot do agente e ao salvar no painel. Um
    // endereço que aceita a conexão e nunca responde deixaria a
    // requisição pendurada — e, no boot, o agente subindo pela
    // metade.
    response = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `o endereço não respondeu em ${String(timeoutMs)} ms`
      : 'não consegui alcançar o endereço';

    throw new AdImageError('FETCH_FAILED', `${reason}: ${url}`);
  }

  if (!response.ok) {
    throw new AdImageError(
      'FETCH_FAILED',
      `o endereço respondeu ${String(response.status)}: ${url}`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length === 0) {
    throw new AdImageError('EMPTY', 'o endereço respondeu, mas o arquivo veio vazio');
  }

  if (bytes.length > maxBytes) {
    throw new AdImageError(
      'TOO_LARGE',
      `a imagem tem ${formatBytes(bytes.length)} e o limite é ${formatBytes(maxBytes)}. ` +
        'Reduza a imagem antes de subir. O modo "o cliente baixa" aguenta mais, mas nele o ' +
        'cliente busca o endereço e a primeira exibição pisca.',
    );
  }

  const probe = probeImage(bytes);

  if (probe === null) {
    throw new AdImageError(
      'UNSUPPORTED_FORMAT',
      'o arquivo não é PNG nem JPEG. O cliente do Rust só monta esses dois formatos ' +
        '(GIF e WebP não aparecem).',
    );
  }

  if (probe.width > ADS_MAX_WIDTH || probe.height > ADS_MAX_HEIGHT) {
    throw new AdImageError(
      'TOO_BIG',
      `a imagem tem ${String(probe.width)}x${String(probe.height)} e o limite é ` +
        `${String(ADS_MAX_WIDTH)}x${String(ADS_MAX_HEIGHT)}.`,
    );
  }

  const sha = createHash('sha256').update(bytes).digest('hex');

  return {
    bytes,
    sha,
    key: imageKeyOf(sha),
    width: probe.width,
    height: probe.height,
    mime: probe.mime,
  };
}

/**
 * A chave da imagem, derivada do conteúdo.
 *
 * Minúsculas e dígitos porque ela viaja num comando de console
 * separado por ESPAÇO — o mesmo alfabeto restrito das outras
 * chaves do projeto.
 */
export function imageKeyOf(sha: string): string {
  return `ad${sha.slice(0, 12)}`;
}

/**
 * Os bytes em pedaços de base64, prontos para o RCON.
 *
 * O corte é feito nos BYTES e não no base64: cortar base64 no
 * meio de um grupo de quatro produziria pedaços que não decodificam
 * sozinhos, e o plugin teria de saber remontar antes de decodificar.
 * Assim cada pedaço é um base64 válido por si.
 */
export function chunkImage(
  bytes: Buffer,
  chunkBytes: number = ADS_CHUNK_BYTES,
): readonly string[] {
  const parts: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    parts.push(bytes.subarray(offset, offset + chunkBytes).toString('base64'));
  }

  return parts;
}

export function buildImageBeginCommand(key: string, parts: number): string {
  return `${ADS_IMAGE_BEGIN_COMMAND} ${key} ${String(parts)}`;
}

export function buildImagePartCommand(key: string, index: number, part: string): string {
  return `${ADS_IMAGE_PART_COMMAND} ${key} ${String(index)} ${part}`;
}

export function buildImageEndCommand(key: string): string {
  return `${ADS_IMAGE_END_COMMAND} ${key}`;
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : `${String(Math.round(value / 1024))} KB`;
}
