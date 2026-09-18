// ============================================================
//  O CARTÃO DO PASSE NUM MENU JÁ GRAVADO
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  A home tem quatro cartões, e o passe é o quinto. Menu NOVO nasce
//  com ele — o preset chama `buildHomeScreen`, que monta os cinco. O
//  problema é o menu que já está gravado: o gerador usa a tela dele
//  como MODELO, e `fillTemplate` preenche o que existe e NÃO CRIA o
//  que falta (ui-template.ts). Sem esta passagem, quem já tinha menu
//  nunca veria o cartão.
//
//  Roda a cada boot, como os outros upgrades de documento
//  (`withSkinsTab`, `withTeamTab`), e por isso tem de ser
//  idempotente: a segunda passada devolve `null`.
//
//  ####  E POR QUE ELE É TÃO CONSERVADOR  ####
//
//  Acrescentar um cartão não é acrescentar um elemento: os outros
//  quatro dividem a largura entre si (`columnRect`), então todos os
//  cinco mudam de lugar. Num menu que o admin editou — moveu um
//  cartão, trocou a cor, reescreveu um título — reposicionar tudo
//  seria desfazer o trabalho dele para caber uma novidade.
//
//  Então a passagem só acontece quando a home está EXATAMENTE como o
//  preset a gravou, byte a byte. É para isso que `emptyHomeView()` é
//  determinística (sem `Date.now()`): ela permite perguntar "alguém
//  mexeu aqui?" com uma comparação de strings.
//
//  O preço, registrado em 17/09/2026: quem editou a home não ganha o
//  cartão, e a única saída para ele é pôr o botão à mão no editor ou
//  resetar o preset (que descarta a edição). O caminho contrário —
//  reposicionar os cartões do admin — foi recusado porque a perda é
//  silenciosa: ninguém percebe que o desenho mudou até abrir o jogo.
//
//  ####  E O ADMIN QUE APAGAR O CARTÃO  ####
//
//  Ele o vê voltar no boot seguinte, como acontece com a aba SKINS —
//  porque depois de apagá-lo a home deixa de bater com o preset de
//  cinco cartões e volta a bater com o de quatro. Quem quiser
//  escondê-lo de verdade desliga o cartão movendo-o para fora, ou
//  muda qualquer outra coisa na home: a partir daí esta passagem não
//  toca mais no documento.
// ============================================================

import type { UiDocument, UiScreen } from '../types/ui-document.js';

import {
  buildHomeScreen,
  cardsOf,
  emptyHomeView,
  HOME_SCREEN_ID,
} from './ui-home-screen.js';

/** A home de ANTES do passe: os quatro cartões, sem o quinto. */
const CARDS_BEFORE_PASS = {
  rank: true,
  offer: true,
  wipe: true,
  quest: true,
  pass: false,
} as const;

/**
 * As duas telas são a mesma coisa?
 *
 * Compara o DESENHO, e não o objeto: `id`, `name` e `generated` são
 * do documento, e o que interessa aqui é se os elementos são os
 * mesmos. `JSON.stringify` serve porque os dois lados nascem do
 * mesmo gerador, na mesma ordem de chaves.
 */
function sameDrawing(screen: UiScreen, expected: UiScreen): boolean {
  return JSON.stringify(screen.elements) === JSON.stringify(expected.elements);
}

/**
 * O documento com o cartão do passe, ou `null` se não há o que fazer.
 *
 * `null` quando o cartão já está lá, quando o documento não tem home,
 * ou quando a home foi editada — ver o cabeçalho.
 */
export function withPassCard(document: UiDocument): UiDocument | null {
  const home = document.screens.find((screen) => screen.id === HOME_SCREEN_ID);

  if (home === undefined) {
    return null;
  }

  // O marcador da passagem é o próprio cartão, como no `withSkinsTab`:
  // o documento não tem campo onde anotar "esta migração já rodou", e
  // criar um só para isto seria migração de banco por um botão.
  if (cardsOf(document).pass) {
    return null;
  }

  const before = buildHomeScreen({ view: emptyHomeView(), cards: CARDS_BEFORE_PASS });

  if (!sameDrawing(home, before)) {
    return null;
  }

  const after = buildHomeScreen({ view: emptyHomeView() });

  return {
    ...document,
    screens: document.screens.map((screen) =>
      // Só os ELEMENTOS trocam: `generated`, nome e o resto do que o
      // admin possa ter mudado na tela continuam dele.
      screen.id === HOME_SCREEN_ID ? { ...screen, elements: after.elements } : screen,
    ),
  };
}
