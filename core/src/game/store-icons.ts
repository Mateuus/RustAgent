// ============================================================
//  store-icons.ts  -  a arte própria das ofertas indo para o jogo.
//
//  ####  DUAS FORMAS DE DESENHAR UM CARD  ####
//
//  O padrão é o ícone do JOGO (`itemid`/`skinid`): o cliente já o
//  tem, não custa download nenhum, e o jogador reconhece a arte. É o
//  certo para uma oferta que É um item.
//
//  O outro caso é o que não é item nenhum — um VIP de 30 dias, um
//  pacote, um kit — e que antes pegava emprestado o ícone de alguma
//  coisa (a caixa de madeira, quase sempre). Para esses, o admin
//  manda um PNG pelo painel, e é ele que este módulo leva ao jogo.
//
//  O caminho é o mesmo de todas as outras imagens nossas: os bytes
//  vão ao OrigemZImages, que devolve um CRC, e a tela sai daqui com
//  `{img:store.<id>}` no lugar dele — ver game/image-library.ts.
// ============================================================

import type { Logger } from '../logger.js';
import type { StoreOffer } from '../db/store-repository.js';
import { imageAsset, type ImageAsset } from './image-library.js';

/**
 * A chave da arte de uma oferta no OrigemZImages.
 *
 * O id da oferta é um UUID, e o alfabeto dele (hex e hífen) cabe na
 * régua da chave sem tradução.
 */
export function storeIconKey(offerId: string): string {
  return `store.${offerId}`;
}

/**
 * As artes das ofertas que têm uma, prontas para a biblioteca.
 *
 * ####  SÓ A OFERTA LIGADA  ####
 *
 * A desligada não aparece na vitrine, e mandar a arte dela seria
 * gastar o duto com o que ninguém vai ver. Quando alguém a religa, a
 * sincronização seguinte manda — e é a mesma rodada que já reenvia a
 * carga da interface.
 *
 * Arquivo que sumiu do disco vira um aviso e nada mais: o card cai no
 * ícone do jogo, que é o padrão, e o resto da loja continua de pé.
 */
export function loadStoreIcons(
  offers: readonly StoreOffer[],
  read: (file: string) => Buffer | null,
  logger?: Logger,
): readonly ImageAsset[] {
  const assets: ImageAsset[] = [];

  for (const offer of offers) {
    if (!offer.enabled || offer.icon.file === null) {
      continue;
    }

    const bytes = read(offer.icon.file);

    if (bytes === null) {
      logger?.warn(
        { offer: offer.id, icon: offer.icon.file },
        'a arte da oferta não está em Assets\\store; o card fica com o ícone do jogo',
      );
      continue;
    }

    assets.push(imageAsset(storeIconKey(offer.id), bytes));
  }

  return assets;
}
