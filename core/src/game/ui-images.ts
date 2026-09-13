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
//  manda os BYTES ao OrigemZImages (ver game/image-library.ts) e ele
//  guarda. O CRC nasce lá — o agente nunca o conhece.
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
import {
  imageAsset,
  isReservedImageKey,
  isValidImageKey,
  type ImageAsset,
} from './image-library.js';

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

/**
 * As imagens de `Assets\ui`, prontas para a biblioteca.
 *
 * A chave é o nome do arquivo sem extensão, e é assim que o
 * documento se refere a ela (`source: { kind: 'stored', key:
 * 'ozcoin' }`).
 *
 * ####  LIDA A CADA ENVIO, E NÃO NO BOOT  ####
 *
 * Um PNG novo na pasta fica disponível no próximo envio, sem
 * reiniciar o agente. Ler a pasta de novo é barato — são poucos
 * arquivos pequenos — e o manifesto do OrigemZImages garante que
 * o que não mudou não sobe.
 *
 * Não há mais teto de 45 KB por imagem: ela vai em pedaços, e o
 * teto que vale é o da biblioteca (`IMAGE_MAX_BYTES`).
 */
export function loadUiImages(root: string, logger?: Logger): readonly ImageAsset[] {
  const dir = join(root, UI_ASSETS_DIR);

  let files: readonly string[];

  try {
    files = readdirSync(dir).filter((file) => /\.png$/i.test(file));
  } catch {
    // Pasta ausente é o normal. Ver o cabeçalho.
    return [];
  }

  const images: ImageAsset[] = [];

  for (const file of files) {
    const path = join(dir, file);
    const key = file.replace(/\.png$/i, '').toLowerCase();

    if (!isValidImageKey(key)) {
      // `logo do site.png` viraria dois argumentos no comando de
      // console. Dizer o nome é o que permite consertar.
      logger?.warn(
        { path, key },
        'imagem de interface deixada de fora: o nome do arquivo não serve como chave (use ' +
          'minúsculas, dígitos, ponto, hífen ou sublinhado)',
      );
      continue;
    }

    if (isReservedImageKey(key)) {
      // `item.moeda.png` seria podado pelos itens e reenviado por
      // aqui, a cada rodada. Ver `IMAGE_FAMILIES`.
      logger?.warn(
        { path, key },
        'imagem de interface deixada de fora: o nome cai numa família reservada (`item.` ou ' +
          '`ad` + 12 dígitos hex). Renomeie o arquivo.',
      );
      continue;
    }

    try {
      images.push(imageAsset(key, readFileSync(path)));
    } catch (error) {
      // Uma imagem ilegível não derruba o menu: ela vira um espaço
      // vazio, e o resto funciona.
      logger?.warn({ err: toError(error), path }, 'não consegui ler uma imagem de interface');
    }
  }

  return images;
}
