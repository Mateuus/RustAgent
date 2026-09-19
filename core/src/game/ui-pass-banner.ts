// ============================================================
//  O BANNER DO PASSE NUM MENU JÁ GRAVADO
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  O cartão de boas-vindas da home tinha o lado direito vazio, e
//  agora ele tem a propaganda do passe — uma arte que, clicada, roda
//  `/passe`. Menu NOVO já nasce com ela: o preset chama
//  `buildHomeScreen`, que a desenha.
//
//  O problema é o menu que já está gravado. O gerador usa a tela
//  dele como MODELO, e `fillTemplate` preenche o que existe e NÃO
//  CRIA o que falta (ui-template.ts). Sem esta passagem, quem já
//  tinha menu nunca veria o banner.
//
//  Roda a cada boot, como os outros upgrades de documento
//  (`withSkinsTab`, `withTeamTab`, `withPassCard`), e por isso tem de
//  ser idempotente: a segunda passada devolve `null`.
//
//  ####  ELA VEM DEPOIS DO `withPassCard`, E NÃO NO LUGAR DELE  ####
//
//  São dois degraus, e o menu antigo sobe os dois no mesmo boot:
//
//    quatro cartões, sem banner   ->  withPassCard   ->
//    cinco cartões, sem banner    ->  withPassBanner ->
//    cinco cartões, com banner
//
//  É por isso que `buildHomeScreen` aceita `passBanner: false`: sem
//  essa chave não haveria como DESCREVER o degrau do meio, e o
//  `withPassCard` pararia de reconhecer a home que ele mesmo grava.
//
//  ####  E POR QUE ELA É TÃO CONSERVADORA  ####
//
//  O banner não é só um elemento a mais: para caber nos 50.000 bytes
//  da carga de entrada, a linha "Use o menu acima para navegar pelo
//  servidor." e a barra de acento saíram do mesmo cartão. Num menu
//  que o admin editou, apagar duas coisas que ele pode ter mexido
//  seria desfazer o trabalho dele para caber uma novidade.
//
//  Então a passagem só acontece quando a home está EXATAMENTE como o
//  preset a gravou, byte a byte. É para isso que `emptyHomeView()` é
//  determinística (sem `Date.now()`): ela permite perguntar "alguém
//  mexeu aqui?" com uma comparação de strings.
//
//  O preço é o mesmo registrado no `withPassCard`: quem editou a home
//  não ganha o banner, e a saída para ele é pôr o botão à mão no
//  editor ou resetar o preset (que descarta a edição).
// ============================================================

import type { UiDocument, UiElement } from '../types/ui-document.js';

import {
  buildHomeScreen,
  emptyHomeView,
  HOME_SCREEN_ID,
  HOME_SLOTS,
} from './ui-home-screen.js';
// A comparação de desenho mora no cartão porque ela nasceu lá, e
// porque as duas passagens precisam responder à MESMA pergunta: "a
// home é a que o preset gravou?". Duas cópias divergiriam, e uma
// delas passaria a tocar documento que a outra recusa.
import { sameDrawing } from './ui-pass-card.js';

/**
 * Há um elemento com este id em alguma tela do documento?
 */
function hasElement(document: UiDocument, id: string): boolean {
  const seek = (elements: readonly UiElement[]): boolean =>
    elements.some((element) => element.id === id || seek(element.children));

  return document.screens.some((screen) => seek(screen.elements));
}

/**
 * O documento com o banner do passe, ou `null` se não há o que fazer.
 *
 * `null` quando o banner já está lá, quando o documento não tem home,
 * ou quando a home foi editada — ver o cabeçalho.
 */
export function withPassBanner(document: UiDocument): UiDocument | null {
  const home = document.screens.find((screen) => screen.id === HOME_SCREEN_ID);

  if (home === undefined) {
    return null;
  }

  // O marcador da passagem é o próprio banner, como no `withPassCard`:
  // o documento não tem campo onde anotar "esta migração já rodou", e
  // criar um só para isto seria migração de banco por um botão.
  //
  // E o admin que apagar o banner no editor o vê voltar no boot
  // seguinte, porque a home volta a bater com o preset sem ele. Quem
  // quiser escondê-lo de verdade muda qualquer outra coisa na home: a
  // partir daí esta passagem não toca mais no documento.
  if (hasElement(document, HOME_SLOTS.passBanner)) {
    return null;
  }

  const before = buildHomeScreen({ view: emptyHomeView(), passBanner: false });

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
