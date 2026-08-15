// ============================================================
//  ####  O TRANSPORTE DA INTERFACE ATÉ O JOGO  ####
//
//  Contrato entre o agente e o plugin `OrigemZUI`. A outra ponta é
//  `Plugins\OrigemZUI.cs` — os campos aqui são os que o
//  `BuildDocument` e o `BuildScreen` dele leem, pelo nome.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O PLUGIN JUNTO.
//
//  ------------------------------------------------------------
//  ####  POR QUE NÃO MANDAR O DOCUMENTO INTEIRO  ####
//
//  MEDIDO no projeto anterior: o menu principal (7 telas, 142
//  elementos) dá 52.280 bytes, ou 69.708 em base64. O teto do
//  WebRCON é ~50.000. Ou seja, o PRIMEIRO menu real já não cabe.
//
//  A causa está na forma: trocar de tela no CUI redesenha tudo,
//  então cada tela carrega sua própria cópia do cabeçalho. Sete
//  telas, sete cabeçalhos — e o cliente recebe um.
//
//  Mandar UMA TELA POR VEZ desfaz essa multiplicação: a carga
//  inicial fica em ~8 KB e cada tela em ~7,5 KB, contra os ~50 KB
//  disponíveis. O problema de tamanho deixa de existir em vez de
//  ser administrado a cada menu novo.
//
//  ------------------------------------------------------------
//  ####  OS DOIS SENTIDOS  ####
//
//  agente -> plugin : comando de console, como todo o resto
//  plugin -> agente : linha marcada no console, lida no stream do
//                     RCON — o mesmo mecanismo de
//                     servers/console-buffer.ts
//
//  O segundo é assíncrono, então o pedido leva um `requestId` e a
//  resposta o devolve.
// ============================================================

import { z } from 'zod';

import {
  collectScreenActions,
  documentUsesShell,
  screenContentToCui,
  screenToCui,
  screenUpdatesToCui,
  shellToCui,
  type CuiElement,
  type UiActionEntry,
} from '../game/ui-cui.js';
import type { UiDocument } from './ui-document.js';

// ------------------------------------------------------------
//  Os comandos de console que o plugin expõe.
// ------------------------------------------------------------
export const UI_PLUGIN_COMMANDS = {
  /**
   * `origemz.ui.doc <base64>`
   *
   * A carga inicial: metadados de TODOS os documentos daquele
   * servidor, mais a tela de ENTRADA de cada um, já convertida.
   * É o que faz `/menu` abrir sem ida à rede.
   *
   * EMPURRADO pelo agente: o plugin não pode depender de rede no
   * caminho de um jogador digitando um comando.
   */
  doc: 'origemz.ui.doc',

  /**
   * `origemz.ui.screen <base64>`
   *
   * UMA tela, em resposta a um pedido do plugin. Carrega o
   * `requestId` do pedido — é assim que o plugin sabe a qual
   * clique aquela tela pertence.
   */
  screen: 'origemz.ui.screen',

  /**
   * `origemz.ui.open <steamId> <documentId>`
   *
   * Abre a interface para um jogador a partir do painel. Existe
   * para conferir o desenho sem entrar no jogo e digitar.
   */
  open: 'origemz.ui.open',

  /**
   * `origemz.ui.close [steamId]`
   *
   * A saída de emergência. Sem argumento, fecha de TODO MUNDO —
   * uma interface presa com o cursor liberado impede de jogar.
   */
  close: 'origemz.ui.close',
} as const;

// ------------------------------------------------------------
//  ####  O MARCADOR DO SENTIDO PLUGIN -> AGENTE  ####
//
//  Feio de propósito: um prefixo bonito seria ambíguo com o que
//  outro plugin imprime.
//
//  ####  CONTROLE DE ORIGEM NÃO É OPCIONAL  ####
//
//  O agente lê o console INTEIRO, e isso inclui o chat dos
//  jogadores. Sem exigir que a linha tenha vindo do plugin, alguém
//  digitando o marcador no chat forjaria um pedido.
//
//  Aqui o estrago de uma forja é pequeno (o agente devolveria uma
//  tela que o jogador já pode ver de qualquer jeito), mas a regra
//  vale para a família inteira de marcadores — e o mesmo caminho
//  move dinheiro na loja.
// ------------------------------------------------------------
export const UI_REQUEST_MARKER = '#OZUIREQ#';

/** Pedido de tela, como o plugin o imprime. */
export const uiScreenRequestSchema = z.object({
  /** Correlaciona o pedido com a resposta. */
  requestId: z.string().min(1).max(64),
  documentId: z.string().min(1).max(64),
  screenId: z.string().min(1).max(64),
  /** Só para o log — o agente não decide nada com isto. */
  steamId: z
    .string()
    .regex(/^\d{17}$/)
    .optional(),
});

export type UiScreenRequest = z.infer<typeof uiScreenRequestSchema>;

/**
 * O plugin pedindo a CARGA INICIAL de volta.
 *
 * ####  POR QUE ISTO EXISTE  ####
 *
 * Um `oxide.reload` esvazia o cache do plugin SEM derrubar o RCON
 * — para o agente, nada aconteceu, e ele não reenvia. O menu
 * ficaria morto até a rede de segurança periódica, e nesse
 * meio-tempo `/menu` responde "Unknown command", porque o comando
 * de chat só é registrado quando a carga chega.
 *
 * A solução é o próprio plugin avisar que esqueceu.
 */
export const uiDocRequestSchema = z.object({
  want: z.literal('documents'),
});

// ------------------------------------------------------------
//  A CARGA INICIAL
//
//  `screens` traz SÓ a tela de entrada, completa. As outras
//  aparecem em `screenIndex`, apenas com id e nome.
//
//  ####  POR QUE O ÍNDICE DAS OUTRAS TELAS  ####
//
//  Sem ele, o plugin não saberia que a tela existe até tentar
//  buscá-la, e não teria como distinguir "ainda não baixei" de
//  "essa tela não existe" — que é a diferença entre mostrar um
//  aviso de carregando e recusar o clique.
// ------------------------------------------------------------
export interface UiScreenRef {
  readonly id: string;
  readonly name: string;
}

/**
 * Uma tela, PRONTA PARA DESENHAR.
 *
 * ####  O PLUGIN NÃO CONVERTE NADA  ####
 *
 * Ele recebe `cui` (a lista de `CuiElement` que o cliente
 * entende), troca o lugar reservado do token e chama `AddUi`. A
 * conversão mora no agente — ver game/ui-cui.ts para o porquê.
 *
 * `actions` é o que sobra do modelo e o CUI não carrega: o que
 * cada botão FAZ. O CUI leva só o id da ação, e é com esta tabela
 * que o plugin valida o clique.
 */
export interface UiScreenBundle {
  readonly id: string;
  readonly name: string;
  /** `modal` é desenhado por cima, sem apagar a página. */
  readonly kind: 'page' | 'modal';
  /**
   * O CONTEÚDO da tela, pendurado no slot do shell.
   *
   * Quando o documento tem shell, isto NÃO inclui a moldura nem o
   * cabeçalho: trocar de tela substitui só o que está aqui, e é
   * isso que impede a interface de piscar a cada clique.
   */
  readonly cui: readonly CuiElement[];
  /**
   * Elementos do shell a ATUALIZAR ao entrar nesta tela.
   *
   * Hoje: a cor do botão de navegação ativo. Vêm com
   * `update: true`, então o cliente troca os componentes no lugar
   * em vez de recriar o elemento — recriar faria piscar, que é o
   * defeito que o shell corrige.
   */
  readonly updates: readonly CuiElement[];
  readonly actions: Readonly<Record<string, UiActionEntry>>;
  /**
   * NÃO GUARDE ESTA TELA.
   *
   * Uma tela montada na hora (a loja, que vem do banco a cada
   * pedido) mostraria um preço que não vale mais se ficasse em
   * cache — e o jogador clicaria em comprar confiando nele.
   *
   * Ausente/`false` = tela de documento, que só muda quando o
   * admin edita, e o cache é o que faz navegar ser instantâneo.
   */
  readonly volatile?: boolean;
}

/** Modelo -> o pacote que o jogo consome. `null` = tela não existe. */
export function toScreenBundle(document: UiDocument, screenId: string): UiScreenBundle | null {
  const screen = document.screens.find((item) => item.id === screenId);

  if (screen === undefined) {
    return null;
  }

  // Com shell, a tela manda só o conteúdo; sem ele, manda tudo.
  const shell = documentUsesShell(document);

  return {
    id: screen.id,
    name: screen.name,
    kind: screen.kind,
    cui: shell ? screenContentToCui(document, screen) : screenToCui(document, screen),
    updates: shell ? screenUpdatesToCui(document, screen) : [],
    actions: collectScreenActions(screen, document.shell),
  };
}

export interface UiDocumentPayload {
  readonly id: string;
  readonly command: string;
  readonly permission: string | null;
  readonly layer: string;
  readonly cursor: boolean;
  readonly fadeIn: number;
  readonly entryScreenId: string;
  /**
   * O SHELL, já convertido: desenhado UMA vez, na abertura.
   *
   * Vazio = o documento não usa shell, e cada tela desenha tudo.
   */
  readonly shell: readonly CuiElement[];
  /** Onde o conteúdo das telas é pendurado. */
  readonly contentSlot: string | null;
  /** Onde os modais são desenhados, por cima do conteúdo. */
  readonly modalSlot: string | null;
  /** Só a tela de entrada, já convertida. */
  readonly screens: readonly UiScreenBundle[];
  /** Todas as telas do documento, id e nome. */
  readonly screenIndex: readonly UiScreenRef[];
}

export interface UiDocPayload {
  readonly documents: readonly UiDocumentPayload[];
}

/**
 * Base64 pelo mesmo motivo MEDIDO nos outros comandos deste
 * projeto: o parser de console do Rust COME AS ASPAS de um JSON
 * cru passado como argumento, e o payload chega quebrado antes de
 * o plugin ver.
 */
export function encodeUiDocPayload(payload: UiDocPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function buildUiDocCommand(encoded: string): string {
  return `${UI_PLUGIN_COMMANDS.doc} ${encoded}`;
}

/** Documento do banco -> a forma enxuta da carga inicial. */
export function toDocumentPayload(document: UiDocument): UiDocumentPayload {
  const entry = toScreenBundle(document, document.entryScreenId);

  return {
    id: document.id,
    command: document.command,
    permission: document.permission,
    layer: document.layer,
    cursor: document.cursor,
    fadeIn: document.fadeIn,
    entryScreenId: document.entryScreenId,
    shell: documentUsesShell(document) ? shellToCui(document) : [],
    contentSlot: document.contentSlotId,
    modalSlot: document.modalSlotId,
    // Documento sem tela de entrada não deveria existir (a borda
    // HTTP recusa), mas se existir vale mandar vazio e deixar o
    // plugin recusar a abrir — melhor que mandar a tela errada.
    screens: entry === null ? [] : [entry],
    screenIndex: document.screens.map((screen) => ({ id: screen.id, name: screen.name })),
  };
}

// ------------------------------------------------------------
//  A RESPOSTA COM UMA TELA
// ------------------------------------------------------------
export interface UiScreenPayload {
  readonly requestId: string;
  readonly documentId: string;
  readonly screen: UiScreenBundle;
}

export function encodeUiScreenPayload(payload: UiScreenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function buildUiScreenCommand(encoded: string): string {
  return `${UI_PLUGIN_COMMANDS.screen} ${encoded}`;
}

/**
 * A tela pedida não existe.
 *
 * Precisa ser DITO, e não silenciado: o plugin está com um aviso
 * de carregando na tela do jogador, e sem resposta ele fica lá até
 * o timeout — que é uma espera inteira por nada.
 */
export interface UiScreenErrorPayload {
  readonly requestId: string;
  readonly error: string;
}

export function encodeUiScreenError(payload: UiScreenErrorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// ------------------------------------------------------------
//  As respostas do plugin aos comandos do agente.
// ------------------------------------------------------------
export const uiDocResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** Quantos documentos ficaram no cache depois da troca. */
    documents: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

export type UiDocResponse = z.infer<typeof uiDocResponseSchema>;

/**
 * Teto do comando, em bytes de base64.
 *
 * ####  PASSANDO DISSO, O ENVIO É RECUSADO — NUNCA CORTADO  ####
 *
 * Meia carga inicial é pior que carga nenhuma: o plugin trocaria
 * um cache bom por um incompleto, e o menu que sumiu não daria
 * erro nenhum — ele simplesmente não abriria.
 *
 * 50.000 é o teto do frame do WebRCON. A carga inicial de um menu
 * real dá ~8 KB, então há espaço para uns cinco documentos antes
 * de apertar.
 */
export const UI_DOC_MAX_BYTES = 50_000;
