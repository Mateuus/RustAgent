// ============================================================
//  ui-discord-screen.ts  -  a página DISCORD, montada do convite
//  que aquele servidor configurou.
//
//  ####  O BOTÃO DISCORD NÃO FAZIA NADA  ####
//
//  Ele rodava `/discord` COMO O JOGADOR — a ação `chat` do
//  documento —, e nenhum plugin registra esse comando neste
//  ecossistema. O que o jogador via era o erro do jogo:
//
//      Unknown command: discord
//
//  O menu não caía; ele só mentia. E o custo é maior que o de um
//  botão morto: quem clica no DISCORD está pedindo o endereço da
//  comunidade, e a resposta era uma linha vermelha de erro.
//
//  ####  POR QUE UMA TELA, E NÃO UMA MENSAGEM NO CHAT  ####
//
//  O CUI não abre navegador — não há ação de link no Rust a partir
//  de um botão de interface. Sobram duas saídas: imprimir o
//  convite no chat ou MOSTRÁ-LO numa tela.
//
//  A tela ganhou porque não depende do plugin: o `OrigemZUI.cs`
//  fica intocado, e o conserto chega a quem já tem instalada a
//  versão que está no ar. O chat exigiria uma ação nova no C#,
//  recompilada e reinstalada em cada servidor.
//
//  ####  E O COMANDO /discord PASSA A EXISTIR DE VERDADE  ####
//
//  O documento declara um ATALHO (`shortcuts`) apontando para esta
//  tela, e o plugin registra no Oxide todo comando de atalho que
//  chega na carga — ver `RegisterChatCommand` em OrigemZUI.cs.
//
//  Então `/discord` deixa de ser desconhecido nos dois caminhos: o
//  do botão, que roda o comando, e o do jogador que digita no chat
//  sem nunca ter aberto o menu.
//
//  ####  O CONVITE É DO SERVIDOR, A TELA É DA REDE  ####
//
//  O desenho é um só, do documento da rede; o endereço sai de
//  `SERVER_DISCORD`, do `.ini` daquele servidor. É por isso que a
//  tela é MONTADA aqui, e não desenhada no editor: um documento
//  com o convite escrito dentro obrigaria um menu por servidor.
//
//  Vazio é um estado legítimo — servidor sem Discord —, e a tela
//  diz isso. Ela nunca inventa um endereço.
// ============================================================

import {
  MAX_SCREENS_PER_DOCUMENT,
  MAX_SHORTCUTS_PER_DOCUMENT,
  type UiDocument,
  type UiElement,
  type UiScreen,
} from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';

import { C, fill, label, panel, topBar, type Rect } from './ui-widgets.js';

/** O endereço desta tela no documento. */
export const DISCORD_SCREEN_ID = 'tela-discord';

/** O comando de chat que abre nela. Sem barra: quem a põe é o jogo. */
export const DISCORD_COMMAND = 'discord';

export function isDiscordScreenId(screenId: string): boolean {
  return screenId === DISCORD_SCREEN_ID;
}

/**
 * O convite como o jogador vai digitar.
 *
 * ####  O QUE ELE LÊ É O QUE ELE VAI DIGITAR  ####
 *
 * O admin cola `https://discord.gg/origemz` — é o que o navegador
 * dele copiou —, e o jogador teria de datilografar os oito
 * caracteres do esquema para chegar ao mesmo lugar. Eles saem
 * daqui: `discord.gg/origemz` abre igual, e é o formato em que
 * todo servidor divulga o convite.
 *
 * O `<` some junto. O rótulo do CUI interpreta rich text, e um
 * `<color=` no meio do endereço pintaria o resto da tela. Não é
 * ataque de ninguém — quem escreve isto é o dono do servidor —, é
 * um colar torto que ficaria difícil de entender no jogo.
 */
export function formatInvite(invite: string): string {
  return invite
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[<>]/g, '')
    .replace(/\/+$/, '');
}

export interface DiscordView {
  /** O convite já formatado. Vazio = este servidor não tem. */
  readonly invite: string;
}

/** Uma faixa centrada na vertical do pai, medida a partir do meio. */
function centerBand(offsetY: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 0.5 },
    anchorMax: { x: 1, y: 0.5 },
    offsetMin: { x: 0, y: offsetY },
    offsetMax: { x: 0, y: offsetY + height },
  };
}

export interface BuildDiscordScreenOptions {
  readonly view: DiscordView;
  /**
   * O id EXATO que foi pedido.
   *
   * Volta idêntico porque o plugin DESCARTA a resposta cujo id não
   * bate com o que ele pediu.
   */
  readonly screenId?: string;
}

/**
 * A página, do jeito que o jogador a vê.
 *
 * Sem convite ela não fica vazia nem some: ela diz que este
 * servidor não tem Discord. "Não temos" é uma resposta; uma tela
 * em branco faz o jogador achar que o menu quebrou — que é
 * exatamente o que o `Unknown command` fazia.
 */
export function buildDiscordScreen(options: BuildDiscordScreenOptions): UiScreen {
  const { invite } = options.view;

  return {
    id: options.screenId ?? DISCORD_SCREEN_ID,
    name: 'DISCORD',
    kind: 'page',
    elements: [
      label('dc-titulo', 'DISCORD', topBar(30), {
        size: 20,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      panel('dc-corpo', fill(0, 42, 0, 0), C.surface, invite === '' ? empty() : withInvite(invite)),
    ],
  };
}

function withInvite(invite: string): readonly UiElement[] {
  return [
    label('dc-chamada', 'ENTRE NO NOSSO DISCORD', centerBand(46, 24), {
      size: 15,
      color: C.textMuted,
      font: 'RobotoCondensed-Bold.ttf',
    }),

    // ####  O CONVITE É O MAIOR TEXTO DA TELA  ####
    //
    // Ele existe para ser DIGITADO em outro lugar: o jogador lê
    // daqui e escreve no navegador, muitas vezes olhando de um
    // monitor para o outro. Tamanho de título e a cor de destaque
    // é o que impede que isso vire um exercício de leitura.
    label('dc-convite', invite, centerBand(4, 40), {
      size: 28,
      color: C.amber,
      font: 'RobotoCondensed-Bold.ttf',
    }),

    label(
      'dc-dica',
      'Digite este endereço no seu navegador — o jogo não abre links.',
      centerBand(-28, 20),
      { size: 12, color: C.textMuted },
    ),
    label(
      'dc-motivo',
      'Avisos de wipe, suporte, sorteios e as novidades da rede.',
      centerBand(-52, 20),
      { size: 12, color: C.textMuted },
    ),
  ];
}

function empty(): readonly UiElement[] {
  return [
    label('dc-vazio', 'Este servidor ainda não divulgou um Discord.', centerBand(0, 24), {
      size: 14,
      color: C.textMuted,
    }),
  ];
}

// ============================================================
//  O MENU QUE JÁ ESTAVA GRAVADO
//
//  ####  MUDAR O MODELO NÃO CONSERTA QUEM JÁ TEM O MENU  ####
//
//  O Menu Principal nasce do modelo UMA vez, no primeiro boot, e
//  daí em diante ele é do admin: editado no painel, com revisão
//  própria. Um documento gravado antes desta frente tem o botão
//  DISCORD com a ação de chat que ninguém atende, e nenhuma tela
//  para onde ir — e continuaria assim para sempre, porque o modelo
//  não é reaplicado.
//
//  Então o agente RELIGA o botão, uma vez, no boot: acrescenta a
//  tela, aponta o botão para ela e registra o atalho `/discord`.
//  É uma edição no documento de quem administra, e por isso ela é
//  a mais contida possível — só acontece quando o botão existe e a
//  tela não, e não toca em mais nada do desenho.
// ============================================================

/** O botão do Discord de um menu gravado antes desta frente. */
function isDiscordButton(element: UiElement): boolean {
  if (element.type !== 'button') {
    return false;
  }

  // O id é o do modelo, e sobrevive a mover e recolorir no editor.
  if (element.id === 'nav-discord') {
    return true;
  }

  // E o comando de chat, para quem renomeou o botão: `/discord`,
  // `discord` — a barra é do jogo, não do Oxide.
  return (
    element.action.kind === 'chat' &&
    element.action.command.trim().replace(/^\//, '').toLowerCase() === DISCORD_COMMAND
  );
}

/**
 * O botão religado: em vez de rodar o comando, ele NAVEGA.
 *
 * O id da AÇÃO não muda. É por ele que o plugin endereça o clique
 * — trocá-lo faria o botão parar de responder até o menu ser
 * reenviado, e o clique de quem estivesse com o menu aberto se
 * perderia no caminho.
 */
function rewireDiscordButton(elements: readonly UiElement[]): {
  // O array é mutável porque é assim que ele volta ao documento:
  // o `shell` do schema é `UiElement[]`, e um `readonly` aqui só
  // adiaria a cópia para o chamador.
  readonly elements: UiElement[];
  readonly found: boolean;
} {
  let found = false;

  const walk = (list: readonly UiElement[]): UiElement[] =>
    list.map((element) => {
      const children = walk(element.children);

      if (element.type !== 'button' || !isDiscordButton(element)) {
        return { ...element, children };
      }

      found = true;

      return {
        ...element,
        children,
        action: { id: element.action.id, kind: 'navigate', screenId: DISCORD_SCREEN_ID },
        // O "você está aqui" da barra. Sem cor ativa gravada, o
        // botão ficaria sendo o único da fila que não acende ao
        // ser aberto — as do modelo são as mesmas do resto.
        activeColor: element.activeColor ?? C.rust,
        activeTextColor: element.activeTextColor ?? C.white,
        activeOnScreenId: DISCORD_SCREEN_ID,
      };
    });

  return { elements: walk(elements), found };
}

/**
 * O documento com a tela do Discord, ou `null` se não há o que
 * fazer.
 *
 * `null` é o caso normal: menu que já tem a tela, e menu que não
 * tem botão de Discord nenhum. Devolver o documento intocado faria
 * o chamador gravá-lo e subir a revisão de todo mundo a cada boot.
 */
export function withDiscordScreen(document: UiDocument): UiDocument | null {
  if (document.screens.some((screen) => screen.id === DISCORD_SCREEN_ID)) {
    return null;
  }

  if (document.screens.length >= MAX_SCREENS_PER_DOCUMENT) {
    return null;
  }

  const shell = rewireDiscordButton(document.shell);

  if (!shell.found) {
    return null;
  }

  // O atalho é um bônus, e não pode ser o motivo de a religação
  // falhar: documento no teto dos atalhos (ou que já usa `discord`
  // como comando principal) fica só com o botão consertado, que é
  // o que o jogador clica.
  const takenByDocument = document.command === DISCORD_COMMAND;
  const alreadyThere = document.shortcuts.some(
    (shortcut) => shortcut.command === DISCORD_COMMAND,
  );
  const full = document.shortcuts.length >= MAX_SHORTCUTS_PER_DOCUMENT;

  return {
    ...document,
    shell: shell.elements,
    shortcuts:
      takenByDocument || alreadyThere || full
        ? document.shortcuts
        : [...document.shortcuts, { command: DISCORD_COMMAND, screenId: DISCORD_SCREEN_ID }],
    screens: [
      ...document.screens,
      { ...buildDiscordScreen({ view: { invite: '' } }), generated: true },
    ],
  };
}

// ------------------------------------------------------------
//  O PROVEDOR
// ------------------------------------------------------------

export interface DiscordScreenProviderOptions {
  /** O convite CRU daquele servidor — o `SERVER_DISCORD` do `.ini`. */
  readonly inviteOf: (serverId: string) => string;
}

export type DiscordScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
}) => Promise<UiScreenBundle | null>;

/**
 * A tela pronta para o `generatedScreens` do `UiSync`.
 *
 * Devolve `null` para todo endereço que não é o dela, como os
 * outros provedores — e aí o caminho normal segue e serve o que
 * estiver gravado no documento.
 */
export function createDiscordScreenProvider(
  options: DiscordScreenProviderOptions,
): DiscordScreenProvider {
  // O contrato do `generatedScreens` é assíncrono porque os outros
  // provedores vão ao banco. Este lê uma linha de configuração que
  // já está na memória, e um `async` sem `await` só esconderia
  // isso.
  return (input) => {
    if (!isDiscordScreenId(input.screenId)) {
      return Promise.resolve(null);
    }

    return Promise.resolve(
      toGeneratedScreenBundle(
        input.document,
        buildDiscordScreen({
          view: { invite: formatInvite(options.inviteOf(input.serverId)) },
          screenId: input.screenId,
        }),
        // O SHELL conhece `tela-discord`: sem isto, o destaque do
        // botão DISCORD sumiria justamente ao entrar nele.
        DISCORD_SCREEN_ID,
      ),
    );
  };
}
