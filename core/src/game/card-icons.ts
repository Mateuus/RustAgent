// ============================================================
//  card-icons.ts  -  a arte própria dos cards indo para o jogo.
//
//  Dois cards têm dono e podem trocar o desenho: a OFERTA da loja e
//  o KIT. Os dois têm um padrão que continua valendo, e que é bom:
//
//      oferta   o ícone do JOGO (`itemid`/`skinid`) — o cliente já o
//               tem, não custa download nenhum, e o jogador o
//               reconhece. É o certo para uma oferta que É um item.
//      kit      o ícone do PRIMEIRO item da lista; sem catálogo
//               lido, um retângulo vazio. É um palpite honesto (um
//               kit de sucata mostra sucata).
//
//  O que nenhum dos dois resolve é o resto: um VIP de 30 dias, um
//  pacote, o "Kit Inicial" que não é uma pedra. Para esses, o admin
//  manda um PNG pelo painel, e é ele que este módulo leva ao jogo.
//
//  O caminho é o mesmo de todas as outras imagens nossas: os bytes
//  vão ao OrigemZImages, que devolve um CRC, e a tela sai daqui com
//  `{img:<chave>}` no lugar dele — ver game/image-library.ts.
//
//  ####  POR QUE UM MODULO SO PARA OS DOIS  ####
//
//  O laço é o mesmo — ler o que o registro aponta, pular o que está
//  desligado, avisar sobre o arquivo que sumiu — e o que muda é a
//  família da chave. Duas cópias envelheceriam separadas.
// ============================================================

import type { StoreOffer } from '../db/store-repository.js';
import type { Logger } from '../logger.js';
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
 * A chave da arte de um kit.
 *
 * Pelo SLUG, e não pelo id: o slug é o identificador estável do kit
 * (é o que o site e a interface usam), e o id é um autoincrement
 * desta máquina. Um kit apagado e recriado com o mesmo slug mantém a
 * chave — e, com ela, os bytes que o cliente já baixou.
 */
export function kitIconKey(slug: string): string {
  return `kit.${slug}`;
}

/** O que um card precisa ter para a arte dele subir. */
interface ArtOwner {
  /** O que nomeia a chave: o id da oferta, o slug do kit. */
  readonly key: string;
  /** O nome do arquivo, ou `null` para o desenho padrão. */
  readonly file: string | null;
  readonly enabled: boolean;
  /** Para o aviso: o que dizer quando o arquivo sumiu. */
  readonly label: string;
}

/**
 * As artes das ofertas da loja que têm uma.
 *
 * ####  SÓ A OFERTA LIGADA  ####
 *
 * A desligada não aparece na vitrine, e mandar a arte dela seria
 * gastar o duto com o que ninguém vai ver. Quando alguém a religa, a
 * sincronização seguinte manda — e é a mesma rodada que já reenvia a
 * carga da interface.
 */
export function loadStoreIcons(
  offers: readonly StoreOffer[],
  read: (file: string) => Buffer | null,
  logger?: Logger,
): readonly ImageAsset[] {
  return loadArt(
    offers.map((offer) => ({
      key: storeIconKey(offer.id),
      file: offer.icon.file,
      enabled: offer.enabled,
      label: `a arte da oferta "${offer.name}"`,
    })),
    read,
    'Assets\\store',
    logger,
  );
}

/** As artes dos kits que têm uma. Mesma regra da loja. */
export function loadKitIcons(
  kits: readonly {
    readonly slug: string;
    readonly name: string;
    readonly iconFile: string | null;
    readonly enabled: boolean;
  }[],
  read: (file: string) => Buffer | null,
  logger?: Logger,
): readonly ImageAsset[] {
  return loadArt(
    kits.map((kit) => ({
      key: kitIconKey(kit.slug),
      file: kit.iconFile,
      enabled: kit.enabled,
      label: `a arte do kit "${kit.name}"`,
    })),
    read,
    'Assets\\kits',
    logger,
  );
}

/**
 * O laço dos dois.
 *
 * Arquivo que sumiu do disco vira um aviso e nada mais: o card cai no
 * desenho padrão, e o resto da tela continua de pé.
 */
function loadArt(
  owners: readonly ArtOwner[],
  read: (file: string) => Buffer | null,
  dir: string,
  logger?: Logger,
): readonly ImageAsset[] {
  const assets: ImageAsset[] = [];

  for (const owner of owners) {
    if (!owner.enabled || owner.file === null) {
      continue;
    }

    const bytes = read(owner.file);

    if (bytes === null) {
      logger?.warn(
        { key: owner.key, icon: owner.file },
        `${owner.label} não está em ${dir}; o card fica com o desenho padrão`,
      );
      continue;
    }

    assets.push(imageAsset(owner.key, bytes));
  }

  return assets;
}
