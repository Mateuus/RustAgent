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
  shellNavStates,
  shellToCui,
  type CuiElement,
  type NavState,
  type UiActionEntry,
} from '../game/ui-cui.js';
import type { UiDocument, UiScreen } from './ui-document.js';

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
  /**
   * Este pedido é o RELÓGIO da tela, e não um clique.
   *
   * ####  ELE MUDA DUAS COISAS NO ATENDIMENTO  ####
   *
   * 1. a tela IDÊNTICA à última servida volta como `unchanged`, e
   *    o plugin não redesenha nada — sem isto, um menu aberto na
   *    frente de um jogador custaria 50 KB de RCON a cada volta
   *    para trocar um desenho pelo mesmo desenho;
   * 2. o que for CARO de apurar pode ser pulado. A tela de missões
   *    vai ao RCON buscar o contador quentinho quando alguém a
   *    abre; fazer isso dez vezes por minuto, por jogador, seria
   *    pagar o preço de abrir a tela sem ninguém ter aberto nada.
   *
   * Ausente = pedido normal, que sempre traz a tela inteira.
   */
  refresh: z.boolean().optional(),
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
  /** O agente monta esta tela? Ver `generated` em ui-document.ts. */
  readonly generated?: boolean;
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
  /**
   * O "você está aqui" da barra, do jeito CARO.
   *
   * ####  ELE VAI VAZIO DESDE 15/09/2026  ####
   *
   * Eram dois elementos CUI completos por botão de navegação —
   * 4.795 bytes na carga inicial, e o mesmo bloco de novo em cada
   * tela servida, para dizer qual botão está aceso. Quem diz isso
   * agora é o `activeId`, com a tabela `navStates` do documento.
   *
   * O campo fica porque é PROTOCOLO: um plugin anterior à mudança
   * ainda o lê, e um array vazio é o que faz ele não destacar nada
   * em vez de quebrar. Ver `NavStates` em OrigemZUI.cs.
   */
  readonly updates: readonly CuiElement[];
  /**
   * Que endereço conta como "você está aqui" nesta tela.
   *
   * É a versão barata do `updates`: o plugin cruza isto com a
   * tabela do documento e pinta os botões sozinho. Ausente = nada
   * acende (tela sem shell).
   */
  readonly activeId?: string;
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
  /**
   * De quantos em quantos segundos esta tela se PEDE DE NOVO.
   *
   * ####  A BARRA TEM DE ANDAR COM O MENU ABERTO  ####
   *
   * Uma tela é desenhada quando o jogador chega nela e fica
   * parada até ele clicar em outra coisa. Numa que mostra
   * contador — "47/90 minutos online" — isso quer dizer um número
   * congelado na frente de quem está justamente esperando ele
   * andar. Pedido do dono em 14/09/2026: "o progress bar tem que
   * correr".
   *
   * Quem repete é o PLUGIN, e não o agente: só ele sabe se o
   * jogador ainda está naquela tela, se o menu continua aberto e
   * se não há um modal por cima. Um empurrão do agente chegaria
   * para quem fechou o menu há dez minutos.
   *
   * Ausente/`0` = tela parada, que é o caso de quase todas.
   */
  readonly refreshSeconds?: number;
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
    // ####  A MARCA VIAJA COM A TELA DE ENTRADA  ####
    //
    // A carga inicial manda só ELA; o resto é pedido. Se a de
    // entrada for montada pelo agente, o plugin precisa saber —
    // senão desenha a de repouso e nunca pede. MEDIDO no jogo.
    generated: screen.generated,
    cui: shell ? screenContentToCui(document, screen) : screenToCui(document, screen),
    // Vazio: quem acende a barra agora é o `activeId` com a tabela
    // do documento. Ver o campo, lá em cima.
    updates: [],
    ...(shell ? { activeId: screen.id } : {}),
    actions: collectScreenActions(screen, document.shell),
  };
}

/**
 * Uma tela GERADA pelo agente, empacotada como as outras.
 *
 * O plugin não vê diferença: recebe CUI pronto e a tabela de
 * ações, igual a uma tela do editor. A única marca é `volatile`,
 * que o impede de guardar — a lista de kits mostra "daqui a 2h" e
 * quem já pegou o quê, e em cache ela mostraria isso para sempre.
 *
 * ####  SEM FADE  ####
 *
 * O fade existe para a interface ENTRAR na tela. Numa tela que o
 * agente remonta a cada clique, ele re-anima tudo do zero e o que
 * o jogador vê é a lista sumindo e voltando.
 *
 * `activeScreenId` é o endereço que o SHELL conhece: sem ele, o
 * destaque do botão KITS sumiria justamente ao entrar em KITS.
 */
export function toGeneratedScreenBundle(
  document: UiDocument,
  screen: UiScreen,
  activeScreenId: string,
  refreshSeconds?: number,
): UiScreenBundle {
  const shell = documentUsesShell(document);

  return {
    id: screen.id,
    name: screen.name,
    kind: screen.kind,
    cui: shell ? screenContentToCui(document, screen, 0) : screenToCui(document, screen),
    // Vazio pelo mesmo motivo do `toScreenBundle`: o destaque agora
    // é uma string, e não um bloco de CUI.
    updates: [],
    // Aqui ele NÃO é o id da tela: uma tela gerada tem endereço com
    // parâmetro (`tela-equipe:kick:765…`), e o shell só conhece o
    // endereço-base. Mandar o id cru apagaria o destaque justamente
    // nas telas internas de cada aba.
    ...(shell ? { activeId: activeScreenId } : {}),
    // O SHELL entra junto: os botões do cabeçalho são os mesmos, e
    // sem eles o plugin recusaria o clique em HOME enquanto o
    // jogador estivesse na lista de kits.
    actions: collectScreenActions(screen, document.shell),
    volatile: true,
    // Só quem pede aparece: uma tela parada não carrega a chave, e
    // o plugin antigo ignora a que não conhece.
    ...(refreshSeconds === undefined || refreshSeconds <= 0 ? {} : { refreshSeconds }),
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
  /** Comandos de chat extras, cada um abrindo numa tela. */
  readonly shortcuts: readonly { readonly command: string; readonly screenId: string }[];
  /**
   * O SHELL, já convertido: desenhado UMA vez, na abertura.
   *
   * Vazio = o documento não usa shell, e cada tela desenha tudo.
   */
  readonly shell: readonly CuiElement[];
  /**
   * Qual botão do shell acende em que tela.
   *
   * Uma linha por botão de navegação, e não um bloco de CUI por
   * tela: é o que tirou 4.795 bytes da carga inicial em
   * 15/09/2026. Ver `shellNavStates` em game/ui-cui.ts.
   *
   * Vazio = documento sem shell, ou sem botão que acenda.
   */
  readonly navStates: readonly NavState[];
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
  /**
   * O segredo que autentica os pedidos de RESGATE.
   *
   * ####  SÓ O PREFIXO DO PLUGIN NÃO BASTA  ####
   *
   * O agente lê o console INTEIRO, e o chat dos jogadores entra
   * por ele. Uma mensagem de chat com "[OrigemZUI] #OZBUY# …"
   * chegaria com o prefixo presente — e entregaria um kit a quem
   * digitou.
   *
   * O segredo muda a cada reinício do agente e só existe na
   * memória dos dois lados e numa linha de RCON que o jogador não
   * vê. Ausente = resgate desligado, e o plugin AVISA o jogador em
   * vez de deixar um botão que não faz nada.
   */
  readonly secret?: string;
}

/** O marcador do pedido de resgate. Ver `UiDocPayload.secret`. */
export const UI_BUY_MARKER = '#OZBUY#';

/**
 * O pedido de resgate, como o plugin o imprime.
 *
 * `steamId` vem da CONEXÃO que clicou, do outro lado — nunca de um
 * argumento do comando. `offerId` é o slug do kit, e é a única
 * coisa que o botão carrega.
 */
export const uiBuyRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  secret: z.string().min(1).max(128),
  steamId: z.string().regex(/^\d{17}$/),
  offerId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(1000),
  documentId: z.string().min(1).max(64),
  /**
   * A PÁGINA em que ele estava quando clicou.
   *
   * ####  ELA EXISTE POR UM DEFEITO VISÍVEL  ####
   *
   * Depois de pegar um kit, o card continuava dizendo RESGATAR: o
   * modal é desenhado por cima, e a página atrás — a que mudou — não
   * é redesenhada.
   *
   * Com ela, o botão OK do aviso vira uma NAVEGAÇÃO de volta, e a
   * lista chega do banco de agora. Sem ela (plugin antigo), o OK só
   * fecha o aviso, como antes.
   *
   * `:` é permitido porque endereços gerados o usam
   * (`tela-kits:recursos:1`) — ele nunca é gravado como id.
   */
  screenId: z
    .string()
    .min(1)
    .max(96)
    .optional(),
  /**
   * O que o jogador ESCREVEU, quando o pedido veio de um campo de
   * texto em vez de um botão.
   *
   * ####  ELE É TEXTO DE JOGADOR, E CHEGA CRU  ####
   *
   * Não passou por validação nenhuma no caminho: o cliente anexa o
   * que foi digitado ao comando, e o plugin remonta a linha. Quem
   * decide se ele serve é quem trata a ação — o teto de 24 do nome
   * de equipe mora em `teamNameSchema`, não aqui.
   *
   * O teto daqui é só o do TRANSPORTE: uma linha de console tem
   * limite, e um texto de 4 KB colado no campo não pode derrubar o
   * parse do pedido inteiro.
   *
   * `optional` porque o botão comum não manda nada — e porque um
   * plugin anterior a este campo continua valendo.
   */
  value: z.string().max(512).optional(),
});

/** `origemz.ui.buyresult <base64>` — o desfecho, para o jogador. */
export interface UiBuyResultPayload {
  readonly requestId: string;
  readonly message: string;
  /**
   * Deu certo?
   *
   * Não é decorativo: é ele que pinta a faixa do aviso de verde ou
   * de vermelho, e essa cor é o que se lê ANTES de qualquer palavra.
   */
  readonly ok?: boolean;
  /** O saldo depois da compra. `null` = não deu para consultar. */
  readonly balance?: number | null;
  /**
   * O cabeçalho a atualizar no lugar.
   *
   * Vêm com `update: true`: o saldo do topo muda sem o cabeçalho
   * piscar. Sem isto, o modal diria "saldo 9.700" e o topo
   * continuaria com o valor antigo, na mesma tela, ao mesmo tempo.
   */
  readonly updates?: readonly CuiElement[];
  /**
   * O aviso a desenhar, com o botão de OK.
   *
   * `null` = sem documento conhecido; aí o desfecho vai só pelo
   * chat. Ver ui-store-screens.ts para por que ele é um modal e não
   * uma linha de chat.
   */
  readonly screen?: UiScreenBundle | null;
  /**
   * Feche o modal.
   *
   * Verdadeiro em QUALQUER desfecho: com ele aberto, o jogador
   * clicaria de novo achando que não funcionou — e a segunda compra
   * seria real.
   */
  readonly closeModal?: boolean;
}

export function buildUiBuyResultCommand(payload: UiBuyResultPayload): string {
  return `origemz.ui.buyresult ${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

// ------------------------------------------------------------
//  O SALDO DO CABEÇALHO
//
//  ####  POR QUE ELE É PEDIDO, E NÃO EMPURRADO  ####
//
//  A carga inicial é montada UMA vez por servidor e vale para todo
//  mundo — não há jogador nenhum nela. Então o rótulo do saldo nasce
//  com um traço, e o plugin pergunta o número quando a interface
//  ABRE, para aquele jogador.
//
//  Um valor fixo no documento seria pior que o traço: cada um leria
//  o número do outro como se fosse o seu.
// ------------------------------------------------------------

/** O marcador do pedido de saldo. Leva segredo, como a compra. */
export const UI_BALANCE_MARKER = '#OZBAL#';

/**
 * O plugin perguntando o saldo de um jogador.
 *
 * Leva o segredo pelo mesmo motivo da compra — só que aqui o
 * estrago de uma forja seria revelar o saldo alheio, não gastá-lo.
 */
export const uiBalanceRequestSchema = z.object({
  secret: z.string().min(1).max(128),
  steamId: z.string().regex(/^\d{17}$/),
});

/**
 * `origemz.ui.balance <steamId> <base64>`
 *
 * Sem `requestId`: não há o que correlacionar. O saldo é um valor
 * só, e chegar duas vezes é inofensivo — a segunda escreve o mesmo
 * número no mesmo lugar.
 */
export function buildUiBalanceCommand(steamId: string, updates: readonly CuiElement[]): string {
  return `origemz.ui.balance ${steamId} ${Buffer.from(JSON.stringify(updates), 'utf8').toString('base64')}`;
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
    // Os comandos extras. Sem eles no pacote, `/quest` só existiria
    // como um segundo documento — ver `shortcuts` em ui-document.ts.
    shortcuts: document.shortcuts.map((shortcut) => ({
      command: shortcut.command,
      screenId: shortcut.screenId,
    })),
    shell: documentUsesShell(document) ? shellToCui(document) : [],
    // ####  QUAL BOTÃO ACENDE EM QUE TELA  ####
    //
    // Uma vez por documento, e não um bloco de CUI por tela. Ver
    // `shellNavStates` em game/ui-cui.ts para a conta que levou a
    // isto.
    navStates: documentUsesShell(document) ? shellNavStates(document) : [],
    contentSlot: document.contentSlotId,
    modalSlot: document.modalSlotId,
    // Documento sem tela de entrada não deveria existir (a borda
    // HTTP recusa), mas se existir vale mandar vazio e deixar o
    // plugin recusar a abrir — melhor que mandar a tela errada.
    screens: entry === null ? [] : [entry],
    screenIndex: document.screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      generated: screen.generated,
    })),
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

/**
 * A resposta de um REFRESH cuja tela não mudou nada.
 *
 * ####  POR QUE ELA EXISTE  ####
 *
 * A tela de missões pesa dezenas de KB em base64. Redesenhá-la de
 * dez em dez segundos para trocar um desenho por outro idêntico
 * gastaria o cano do RCON — que é o mesmo por onde passam o chat,
 * a loja e todo o resto — e faria o conteúdo do slot ser destruído
 * e recriado sem necessidade.
 *
 * O plugin, ao receber isto, só reagenda o próximo relógio. O que
 * está na tela dele continua exatamente como estava.
 *
 * Ela só é respondida a um pedido marcado com `refresh`: um pedido
 * normal (o jogador CHEGANDO na tela) sempre leva a tela inteira,
 * porque ali o plugin não tem desenho nenhum para manter.
 */
export interface UiScreenUnchangedPayload {
  readonly requestId: string;
  readonly documentId: string;
  readonly unchanged: true;
}

export function encodeUiScreenUnchanged(payload: UiScreenUnchangedPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
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
