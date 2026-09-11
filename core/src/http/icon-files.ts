// ============================================================
//  icon-files.ts  -  o PNG que alguém envia pelo painel, conferido
//  e gravado em disco.
//
//  Dois lugares mandam arte por aqui, e eles são o mesmo trabalho
//  com pastas diferentes:
//
//      Assets\items\   o ícone do item custom, no slot do inventário
//      Assets\store\   o ícone da oferta, no card da loja
//
//  Os dois ficam ao lado de `Assets\ui\`, onde as imagens do menu já
//  moram — mesma natureza, mesmo lugar: arquivos que quem administra
//  a rede troca, e não código.
//
//  ####  O BANCO GUARDA SÓ O NOME  ####
//
//  Os bytes vão para o jogo pelo OrigemZImages (game/image-library.ts)
//  e quem devolve o CRC é o plugin. Guardar o CRC no banco seria uma
//  segunda verdade sobre a mesma imagem.
//
//  ####  E A RECUSA DIZ O QUE FAZER  ####
//
//  O painel reduz a imagem sozinho, no navegador, antes de enviar. Um
//  upload por script ou `curl` não passa por lá — para esse caminho,
//  a frase da recusa é toda a orientação que existe, e por isso ela
//  leva o tamanho recomendado dentro.
// ============================================================

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyRequest } from 'fastify';

import { ApiError } from './error-response.js';

/**
 * Teto do PNG, em bytes.
 *
 * ####  ELE NASCEU DO RCON, E FICOU POR OUTRO MOTIVO  ####
 *
 * Nasceu quando o ícone ia numa linha só de console: o frame do
 * WebRCON aguenta ~50 KB, o base64 infla 4/3, e 33 KB de PNG davam
 * ~45.000 caracteres. Desde 11/09/2026 ele vai em pedaços, pelo
 * OrigemZImages (game/image-library.ts), e esse limite deixou de
 * existir — o do transporte agora é 3 MiB.
 *
 * Ficou porque continua certo para o que ele é: um ícone é desenhado
 * com menos de 100 pixels, e CADA jogador baixa o arquivo na primeira
 * vez que o vê. MEDIDO com a arte real do Troféu Bleik: 96×96 sai com
 * 25 KB, que é o que o painel já produz sozinho.
 */
export const MAX_ICON_BYTES = 33_000;

/**
 * O lado que a recusa RECOMENDA, e que o painel já aplica sozinho.
 *
 * MEDIDO no Chrome 152 com a arte real do Troféu Bleik (1254×1254,
 * 2,9 MB): 96×96 sai com 25.060 bytes e sobra um quarto do teto;
 * 112×112 sai com 33.478 e estoura por 478. Dizer o número na frase
 * é a diferença entre "não coube" e "faça assim".
 */
export const RECOMMENDED_ICON_SIZE = 96;

/**
 * Quanto o agente LÊ antes de decidir.
 *
 * ####  ELE É MAIOR QUE O TETO DE PROPÓSITO  ####
 *
 * Parar de ler exatamente no teto custava o tamanho do arquivo: o
 * multipart corta a leitura e lança sem dizer quanto o PNG tinha, e
 * a recusa virava "passou do teto" para 34 KB e para 3 MB do mesmo
 * jeito. Quatro vezes o teto são 132 KB de memória no pior caso — e
 * cobrem a imagem QUASE certa, que é a que mais aparece: alguém
 * exportou em 128×128 e passou por 10 KB.
 */
const ICON_READ_LIMIT = MAX_ICON_BYTES * 4;

/**
 * A régua do nome de arquivo.
 *
 * Ela protege duas coisas: o nome viaja num comando de console (onde
 * espaço separa argumentos) e vem do BANCO na hora de ler o arquivo —
 * sem a régua, `../../.env` seria um caminho válido.
 */
export const ICON_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.png$/i;

/**
 * Bytes na unidade em que uma pessoa lê.
 *
 * ####  KB DECIMAL AQUI, E KiB NOS OUTROS TETOS  ####
 *
 * Cada teto é escrito na base em que ele é REDONDO: o do plugin é
 * `2 * 1024 * 1024` e aparece em MiB; este é 33.000, e em KiB
 * viraria "32,2 KB" — a frase passaria a dizer um número que não
 * está em lugar nenhum do código.
 */
function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${String(Math.round(bytes / 1_000))} KB`
    : `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/**
 * A recusa por tamanho, com o que fazer depois dela.
 *
 * @param measured os bytes que chegaram, ou `null` quando o
 * multipart cortou a leitura antes de saber o tamanho.
 */
function iconTooLarge(measured: number | null): ApiError {
  const size =
    measured === null
      ? `O PNG passa do teto de ${formatBytes(MAX_ICON_BYTES)}`
      : `O PNG tem ${formatBytes(measured)} e o teto é ${formatBytes(MAX_ICON_BYTES)}`;

  return new ApiError(
    'ICON_TOO_LARGE',
    `${size} (${String(MAX_ICON_BYTES)} bytes). O ícone é desenhado pequeno, e cada jogador ` +
      'baixa o arquivo inteiro na primeira vez que o vê. Envie pelo painel, que reduz a ' +
      `imagem sozinho, ou redimensione para ${String(RECOMMENDED_ICON_SIZE)}×` +
      `${String(RECOMMENDED_ICON_SIZE)} antes de mandar — a arte da medalha, nesse tamanho, dá ` +
      '25 KB.',
    400,
  );
}

/** O erro que o multipart lança quando o arquivo passa do teto. */
function isFileTooLarge(cause: unknown): boolean {
  return cause instanceof Error && (cause as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE';
}

/** O PNG que veio no multipart, conferido. */
export async function uploadedIcon(
  request: FastifyRequest,
): Promise<{ filename: string; content: Buffer }> {
  if (!request.isMultipart()) {
    throw new ApiError(
      'INVALID_BODY',
      'Mande o PNG como multipart/form-data (campo "file").',
      400,
    );
  }

  const file = await request.file({ limits: { fileSize: ICON_READ_LIMIT } });

  if (file === undefined) {
    throw new ApiError('INVALID_BODY', 'Nenhum arquivo veio na requisição.', 400);
  }

  if (!ICON_NAME.test(file.filename)) {
    throw new ApiError(
      'INVALID_ICON_NAME',
      `"${file.filename}" não serve como nome de arquivo. Use letras, números, ponto, hífen ou ` +
        'sublinhado, e termine em .png — o nome viaja num comando de console do jogo, onde ' +
        'espaço separa argumentos.',
      400,
    );
  }

  let content: Buffer;

  try {
    content = await file.toBuffer();
  } catch (cause) {
    // ####  QUEM MANDA A ARTE ORIGINAL É CORTADO AQUI  ####
    //
    // O multipart para de ler no `fileSize` — que é o ponto: sem
    // isso o agente carregaria os 2,9 MB da medalha na memória só
    // para depois recusá-los. O preço é que o erro vem do
    // @fastify/multipart, em inglês e falando de "multipart
    // config", que não é o assunto de quem mandou uma imagem
    // grande demais. Traduzi-lo aqui é o que faz a recusa dizer o
    // tamanho recomendado.
    if (isFileTooLarge(cause)) {
      throw iconTooLarge(null);
    }

    throw cause;
  }

  // ####  PNG DE VERDADE, E NÃO SÓ COM O NOME CERTO  ####
  //
  // Os oito bytes da assinatura. Um JPG renomeado para .png
  // chegaria ao FileStorage do servidor, ganharia um CRC válido, e
  // o sintoma seria um quadrado vazio no jogo sem nada dizendo por
  // quê.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (content.length < 8 || !content.subarray(0, 8).equals(signature)) {
    throw new ApiError(
      'INVALID_ICON',
      'O arquivo não é um PNG. O ícone precisa ser PNG porque é o formato que guarda o fundo ' +
        'transparente — um JPG viraria um quadrado opaco.',
      400,
    );
  }

  if (content.length > MAX_ICON_BYTES) {
    throw iconTooLarge(content.length);
  }

  return { filename: file.filename, content };
}

/**
 * Grava o PNG na pasta daquele acervo.
 *
 * Sobrescrever é o comportamento certo: reenviar a arte corrigida com
 * o mesmo nome é exatamente o gesto de "troquei o ícone". E o CRC do
 * jogo nasce dos BYTES, então o cliente baixa a versão nova sozinho,
 * sem ninguém invalidar nada.
 */
export function saveIcon(dir: string, filename: string, content: Buffer): void {
  // A pasta não existir é o estado normal de quem nunca enviou ícone
  // nenhum — criá-la é parte do trabalho, e não um erro.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

/**
 * Os bytes de um ícone, ou `null`.
 *
 * É a porta da sincronização com o jogo, e a régua do nome protege
 * contra o que vem do banco — ver `ICON_NAME`.
 */
export function readIcon(dir: string, name: string): Buffer | null {
  if (!ICON_NAME.test(name)) {
    return null;
  }

  try {
    return readFileSync(join(dir, name));
  } catch {
    return null;
  }
}

/**
 * Os PNGs daquela pasta, com o tamanho de cada um.
 *
 * Pasta ausente devolve lista vazia, sem aviso: é o estado normal de
 * quem ainda não enviou ícone nenhum, e um `warn` por leitura seria
 * ruído que ensina a ignorar o log.
 */
export function listIcons(dir: string): readonly { readonly name: string; readonly bytes: number }[] {
  try {
    return readdirSync(dir)
      .filter((file) => /\.png$/i.test(file))
      .map((file) => ({ name: file, bytes: statSync(join(dir, file)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
