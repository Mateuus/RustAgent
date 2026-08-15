// ============================================================
//  ####  IMAGEM PRÓPRIA DENTRO DO JOGO  ####
//
//  O CUI desenha imagem de três jeitos, e dois não servem:
//
//    sprite   asset do jogo. Só o que a Facepunch já pôs lá — não
//             há como registrar um PNG nosso.
//    url      o CLIENTE baixa. Exigiria a imagem publicada num
//             endereço que todo jogador alcance, e o agente
//             escuta em 127.0.0.1.
//    png      um CRC do FileStorage do SERVIDOR. É este.
//
//  O FileStorage guarda bytes no próprio servidor de Rust e
//  devolve um número; o cliente pede a imagem por esse número,
//  pelo canal do jogo. Sem host externo, sem porta aberta, sem
//  depender de o jogador alcançar a nossa rede.
//
//  ------------------------------------------------------------
//  ####  QUEM GUARDA É O PLUGIN, E O CRC SÓ EXISTE LÁ  ####
//
//  Só o servidor de Rust pode chamar o FileStorage, então o agente
//  manda os BYTES e o plugin guarda. O CRC nasce lá — o agente
//  nunca o conhece.
//
//  Por isso a tela sai daqui com um lugar reservado
//  (`{img:ozcoin}`) e o plugin o troca pelo CRC na hora de
//  desenhar, exatamente como já faz com o token da sessão. É o
//  mesmo mecanismo, pelo mesmo motivo: o valor só existe em tempo
//  de execução, do outro lado.
//
//  MUDAR O FORMATO DO LUGAR RESERVADO EXIGE MUDAR O PLUGIN JUNTO.
//
//  ------------------------------------------------------------
//  ####  A PASTA PODE NEM EXISTIR  ####
//
//  E não existir é o estado normal de quem não usa imagem própria
//  nenhuma. Lista vazia, sem aviso: um `warn` por boot para dizer
//  que ninguém pediu nada é ruído que ensina a ignorar o log.
// ============================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

/** `origemz.ui.image <chave> <base64>` */
export const UI_IMAGE_COMMAND = 'origemz.ui.image';

/**
 * Onde as imagens do menu moram, dentro da raiz do projeto.
 *
 * Fora do `core/`, e de propósito: são arquivos que quem administra
 * a rede troca (o logo, a moeda), e não código. `Assets\ui\` fica
 * ao lado de `Plugins\` e `Configs\`, que são as outras pastas de
 * conteúdo editável.
 */
export const UI_ASSETS_DIR = join('Assets', 'ui');

/**
 * O lugar reservado que o plugin troca pelo CRC.
 *
 * Ver o cabeçalho: MUDAR ISTO EXIGE MUDAR O PLUGIN JUNTO.
 */
export function imagePlaceholder(key: string): string {
  return `{img:${key}}`;
}

export interface UiImageAsset {
  /** O nome do arquivo sem a extensão: `ozcoin.png` → `ozcoin`. */
  readonly key: string;
  readonly base64: string;
  readonly bytes: number;
}

/**
 * Teto por imagem, com a mesma folga dos outros comandos.
 *
 * Passando disso a imagem é DESCARTADA, e não cortada: meio PNG
 * chega ao plugin como arquivo inválido, e o sintoma seria um
 * quadrado vazio no menu sem nada dizendo por quê.
 *
 * 45.000 caracteres de base64 são ~33 KB de PNG. Um ícone de
 * 128x128 pesa 17 KB — o teto tem folga de sobra, e quem passar
 * dele está mandando uma foto onde cabia um ícone.
 */
export const UI_IMAGE_MAX_BYTES = 45_000;

/**
 * As imagens de `Assets\ui`, prontas para o comando.
 *
 * A chave é o nome do arquivo sem extensão, e é assim que o
 * documento se refere a ela (`source: { kind: 'stored', key:
 * 'ozcoin' }`). Um PNG novo na pasta fica disponível no próximo
 * envio, sem recompilar nada.
 */
export function loadUiImages(root: string, logger?: Logger): readonly UiImageAsset[] {
  const dir = join(root, UI_ASSETS_DIR);

  let files: readonly string[];

  try {
    files = readdirSync(dir).filter((file) => /\.png$/i.test(file));
  } catch {
    // Pasta ausente é o normal. Ver o cabeçalho.
    return [];
  }

  const images: UiImageAsset[] = [];

  for (const file of files) {
    const path = join(dir, file);

    try {
      const base64 = readFileSync(path).toString('base64');

      if (base64.length > UI_IMAGE_MAX_BYTES) {
        logger?.error(
          { path, bytes: base64.length, limit: UI_IMAGE_MAX_BYTES },
          'imagem de interface grande demais para o RCON; ela foi deixada de fora',
        );
        continue;
      }

      images.push({ key: file.replace(/\.png$/i, '').toLowerCase(), base64, bytes: base64.length });
    } catch (error) {
      // Uma imagem ilegível não derruba o menu: ela vira um espaço
      // vazio, e o resto funciona.
      logger?.warn({ err: toError(error), path }, 'não consegui ler uma imagem de interface');
    }
  }

  return images;
}

export function buildUiImageCommand(asset: UiImageAsset): string {
  return `${UI_IMAGE_COMMAND} ${asset.key} ${asset.base64}`;
}
