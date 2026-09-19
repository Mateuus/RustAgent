// ============================================================
//  O BANNER DO PASSE NO CARTÃO DE BOAS-VINDAS.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  O banner é uma ARTE clicável na tela de ENTRADA — o lugar mais
//  caro do menu inteiro. Os casos abaixo quebram em silêncio:
//
//    a carga estourar o teto   passar de `UI_DOC_MAX_BYTES` faz o
//                              envio ser RECUSADO INTEIRO, e o menu
//                              do servidor para de atualizar sem
//                              nada no jogo dizendo por quê
//    a chave da imagem         o `uiDocumentSchema` só aceita
//                              `[a-z0-9-]` em chave gravada: um
//                              ponto no nome do arquivo derruba o
//                              DOCUMENTO, e o menu some do jogo
//    o upgrade pisar no admin  o banner tira duas peças do cartão de
//                              boas-vindas; fazer isso num menu que
//                              alguém editou é desfazer o trabalho
//                              dele, e ninguém percebe até abrir o
//                              jogo
//    o upgrade rodar duas vezes  ele roda a CADA boot
//    a ação vinda do documento  o admin pode trocar o comando
//                              gravado sem saber que o banner deixou
//                              de levar a lugar nenhum
// ============================================================

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isReservedImageKey, isValidImageKey } from '../src/game/image-library.js';
import {
  buildHomeScreen,
  emptyHomeView,
  HOME_SCREEN_ID,
  HOME_SLOTS,
  PASS_BANNER_IMAGE_KEY,
  PASS_CARD_COMMAND,
} from '../src/game/ui-home-screen.js';
import { withPassBanner } from '../src/game/ui-pass-banner.js';
import { withPassCard } from '../src/game/ui-pass-card.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import { UI_ASSETS_DIR } from '../src/game/ui-images.js';
import {
  findDocumentProblems,
  uiDocumentSchema,
  type UiDocument,
  type UiElement,
  type UiScreen,
} from '../src/types/ui-document.js';
import {
  encodeUiDocPayload,
  toDocumentPayload,
  UI_DOC_MAX_BYTES,
} from '../src/types/ui-transport.js';

/** A trava do arquivo de bytes da home. Ver o comentário lá. */
const HOME_BYTES_LIMIT = 47_800;

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function find(screen: UiScreen, id: string): UiElement | undefined {
  return walk(screen.elements).find((element) => element.id === id);
}

function homeOf(document: UiDocument): UiScreen {
  const home = document.screens.find((screen) => screen.id === HOME_SCREEN_ID);

  if (home === undefined) {
    throw new Error('o preset precisa ter a home');
  }

  return home;
}

function bytesOf(document: UiDocument): number {
  return encodeUiDocPayload({ documents: [toDocumentPayload(document)] }).length;
}

// ------------------------------------------------------------
//  O DESENHO
// ------------------------------------------------------------

describe('o banner no cartão de boas-vindas', () => {
  it('é um botão que roda o comando do passe, com a arte dentro', () => {
    const banner = find(homeOf(buildMainMenu()), HOME_SLOTS.passBanner);

    if (banner === undefined || banner.type !== 'button') {
      throw new Error('o banner precisa ser um botão: imagem não clica');
    }

    // COM a barra: o OrigemZUI manda `chat.say <comando>`, e sem ela
    // a palavra sairia no chat como mensagem.
    expect(banner.action.kind).toBe('chat');
    expect(banner.action.kind === 'chat' ? banner.action.command : '').toBe(PASS_CARD_COMMAND);

    const art = banner.children[0];

    if (art === undefined || art.type !== 'image') {
      throw new Error('a arte é filha do botão: o clique no filho sobe para ele');
    }

    expect(art.source).toEqual({ kind: 'stored', key: PASS_BANNER_IMAGE_KEY });
  });

  /**
   * ####  CHAVE AUSENTE NÃO DÁ ERRO: DÁ UM RETÂNGULO VAZIO  ####
   *
   * Se a arte não subiu ao OrigemZImages, o `{img:…}` fica no JSON, o
   * `RawImage` não resolve e o banner sai INVISÍVEL — mas continua
   * clicável. Um alvo invisível é uma armadilha, então o botão tem
   * fundo e um rótulo por baixo da arte.
   */
  it('continua legível quando a arte não subiu', () => {
    const banner = find(homeOf(buildMainMenu()), HOME_SLOTS.passBanner);

    if (banner === undefined || banner.type !== 'button') {
      throw new Error('o banner precisa ser um botão');
    }

    expect(banner.text).toContain('PASSE');
    // E um fundo, senão o rótulo flutuaria sobre o cartão.
    expect(banner.color).not.toBe('#00000000');
  });

  /**
   * ####  A CHAVE É O NOME DO ARQUIVO, E ELE TEM DE SERVIR  ####
   *
   * Três réguas diferentes olham para esta string, e a mais estrita é
   * a do documento: um `passe.banner` passaria por `loadUiImages` e
   * faria o `uiDocumentSchema` RECUSAR O DOCUMENTO INTEIRO — o menu
   * sumiria do jogo, sem erro no console.
   */
  it('a chave da arte serve às três réguas, e o arquivo existe', () => {
    expect(isValidImageKey(PASS_BANNER_IMAGE_KEY)).toBe(true);
    // Família reservada é podada por outro dono, e o `loadUiImages`
    // recusa o arquivo: o banner nunca subiria.
    expect(isReservedImageKey(PASS_BANNER_IMAGE_KEY)).toBe(false);
    // A régua do documento, que é a mais estrita das três.
    expect(/^[a-z0-9][a-z0-9-]*$/.test(PASS_BANNER_IMAGE_KEY)).toBe(true);

    // E os bytes existem: a chave é o nome do arquivo sem o `.png`.
    const path = join(process.cwd(), '..', UI_ASSETS_DIR, `${PASS_BANNER_IMAGE_KEY}.png`);

    expect(existsSync(path)).toBe(true);
  });

  it('o documento com o banner continua gravável', () => {
    const menu = buildMainMenu();

    expect(() => uiDocumentSchema.parse(menu)).not.toThrow();
    // Id repetido, ação para tela apagada: o schema não pega nada
    // disso, e cada um quebra o menu de um jeito diferente.
    expect(findDocumentProblems(menu)).toEqual([]);
  });

  /**
   * ####  A HOME É QUEM PAGA A CARGA INICIAL  ####
   *
   * MEDIDO em 19/09/2026: o banner custa 1.324 bytes (o botão e o
   * `Text` dele, a arte e a ação no índice), e havia 356 até a
   * trava. As três trocas que o pagaram estão listadas na própria
   * trava, em test/ui-home-screen.test.ts: a carga saiu de 47.444
   * para 47.476, 32 bytes líquidos.
   */
  /**
   * ####  A AÇÃO NUNCA VEM DO DOCUMENTO  ####
   *
   * O desenho é do admin; o que o botão FAZ é nosso. Sem isto, um
   * comando trocado no editor faria o banner abrir outra coisa — ou
   * coisa nenhuma —, e o único sintoma seria o clique mudo.
   */
  it('a ação é reposta a cada abertura, e não herdada do modelo', () => {
    const preset = homeOf(buildMainMenu());
    // O admin trocou o comando no editor.
    const adulterado = JSON.parse(
      JSON.stringify(preset).replace(`"command":"${PASS_CARD_COMMAND}"`, '"command":"/loja"'),
    ) as UiScreen;

    const desenhada = buildHomeScreen({ view: emptyHomeView(), template: adulterado });
    const banner = find(desenhada, HOME_SLOTS.passBanner);

    if (banner === undefined || banner.type !== 'button') {
      throw new Error('o banner precisa sobreviver ao preenchimento');
    }

    expect(banner.action.kind === 'chat' ? banner.action.command : '').toBe(PASS_CARD_COMMAND);
  });

  it('cabe no teto do RCON e na trava da home', () => {
    const bytes = bytesOf(buildMainMenu());

    expect(bytes).toBeLessThanOrEqual(UI_DOC_MAX_BYTES);
    expect(bytes).toBeLessThan(HOME_BYTES_LIMIT);
  });
});

// ------------------------------------------------------------
//  O UPGRADE DO MENU JÁ GRAVADO
// ------------------------------------------------------------

describe('o banner entrando num menu que já existe', () => {
  /** O menu de 17/09/2026: cinco cartões, e o cartão de boas-vindas sem banner. */
  function menuSemBanner(): UiDocument {
    const menu = buildMainMenu();
    const antes = buildHomeScreen({ view: emptyHomeView(), passBanner: false });

    return {
      ...menu,
      screens: menu.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID ? { ...screen, elements: antes.elements } : screen,
      ),
    };
  }

  it('entra na home que está como o preset a gravou', () => {
    const antigo = menuSemBanner();

    expect(find(homeOf(antigo), HOME_SLOTS.passBanner)).toBeUndefined();

    const novo = withPassBanner(antigo);

    expect(novo).not.toBeNull();
    expect(find(homeOf(novo as UiDocument), HOME_SLOTS.passBanner)).toBeDefined();
    // E o desenho vira o do preset de hoje, byte a byte.
    expect(JSON.stringify(homeOf(novo as UiDocument).elements)).toBe(
      JSON.stringify(homeOf(buildMainMenu()).elements),
    );
  });

  it('a segunda passada não faz nada: ele roda a cada boot', () => {
    const novo = withPassBanner(menuSemBanner());

    expect(novo).not.toBeNull();
    expect(withPassBanner(novo as UiDocument)).toBeNull();
    // E o menu novo, que já nasce com o banner, também não é tocado.
    expect(withPassBanner(buildMainMenu())).toBeNull();
  });

  /**
   * ####  QUEM EDITOU A HOME CONTINUA COM A EDIÇÃO DELE  ####
   *
   * O banner não é só um elemento a mais: para caber, a linha de
   * instrução e a barra de acento saíram do mesmo cartão. Apagar
   * duas coisas que o admin pode ter mexido seria desfazer o
   * trabalho dele — e a perda é silenciosa: ninguém percebe até
   * abrir o jogo.
   */
  it('não toca na home que o admin editou', () => {
    const editado = menuSemBanner();
    const home = homeOf(editado);
    const mexido: UiDocument = {
      ...editado,
      screens: editado.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID
          ? { ...screen, elements: home.elements.filter((element) => element.id !== 'hm-wipe') }
          : screen,
      ),
    };

    expect(withPassBanner(mexido)).toBeNull();

    // E nem quando a edição foi um TEXTO: o `sameDrawing` compara o
    // desenho inteiro, e a saudação reescrita já basta.
    const reescrito: UiDocument = {
      ...editado,
      screens: editado.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID
          ? {
              ...screen,
              elements: JSON.parse(
                JSON.stringify(home.elements).replace('BEM-VINDO DE VOLTA', 'E AÍ, PARCEIRO'),
              ) as UiElement[],
            }
          : screen,
      ),
    };

    expect(withPassBanner(reescrito)).toBeNull();
  });

  it('documento sem home não é tocado', () => {
    const semHome = buildMainMenu();

    expect(
      withPassBanner({
        ...semHome,
        screens: semHome.screens.filter((screen) => screen.id !== HOME_SCREEN_ID),
      }),
    ).toBeNull();
  });

  /**
   * ####  OS DOIS DEGRAUS, NO MESMO BOOT  ####
   *
   * O menu gravado antes do cartão do passe sobe DOIS degraus:
   * `withPassCard` põe o cartão, e só então a home bate com o que o
   * `withPassBanner` reconhece. Se o `withPassCard` passasse a
   * desenhar o banner, ele deixaria de reconhecer a home antiga — e
   * quem tem menu de quatro cartões ficaria sem os dois.
   */
  it('o menu de quatro cartões sobe os dois degraus e chega ao preset', () => {
    const menu = buildMainMenu();
    const quatro = buildHomeScreen({
      view: emptyHomeView(),
      cards: { rank: true, offer: true, wipe: true, quest: true, pass: false },
      passBanner: false,
    });
    const antigo: UiDocument = {
      ...menu,
      screens: menu.screens.map((screen) =>
        screen.id === HOME_SCREEN_ID ? { ...screen, elements: quatro.elements } : screen,
      ),
    };

    // O banner sozinho não alcança a home de quatro cartões.
    expect(withPassBanner(antigo)).toBeNull();

    const comCartao = withPassCard(antigo);

    expect(comCartao).not.toBeNull();

    const comBanner = withPassBanner(comCartao as UiDocument);

    expect(comBanner).not.toBeNull();
    expect(JSON.stringify(homeOf(comBanner as UiDocument).elements)).toBe(
      JSON.stringify(homeOf(menu).elements),
    );
  });
});
