// ============================================================
//  O MODELO DE DOCUMENTO DE INTERFACE
//
//  ####  ELE VIVE NOS DOIS LADOS, E ISSO É DELIBERADO  ####
//
//  Aqui em TypeScript, porque é o que o EDITOR edita; e em
//  `core/src/types/ui-document.ts` como schema zod, porque aquele
//  é o lado que RECEBE — e "o cliente já validou" nunca foi
//  garantia de nada.
//
//  MUDAR O MODELO EXIGE MUDAR OS DOIS ARQUIVOS. Não há tipo
//  compartilhado entre os pacotes: o painel é bundle de navegador
//  e o core é ESM de Node, compilados separadamente.
//
//  ------------------------------------------------------------
//  ####  POR QUE A AÇÃO TEM id PRÓPRIO  ####
//
//  No CUI, o `command` de um botão NÃO é chamada de função: ele
//  faz o CLIENTE mandar aquele texto como comando de console.
//  Qualquer jogador abre o F1 e digita o mesmo comando, com os
//  argumentos que quiser.
//
//  Por isso o botão nunca carrega a intenção. Ele carrega um
//  ENDEREÇO — `origemz.ui.act <token> <actionId>` — e quem decide
//  o que fazer é o servidor, lendo o documento que o admin salvou.
//  Um `UiAction` com identidade própria é o que torna isso
//  possível.
//
//  ####  A CONVERSÃO PARA CUI NÃO MORA AQUI  ####
//
//  Ela é do core, onde tem teste. O editor a consulta pelo
//  `POST /api/ui/documents/:id/preview` — e é essa a resposta que
//  vale, porque é a que o cliente do jogo recebe.
// ============================================================

/**
 * Vetor de dois eixos.
 *
 * Objeto `{x, y}`, e não tupla `[x, y]`: o workspace liga
 * `noUncheckedIndexedAccess`, então `t[0]` teria tipo
 * `number | undefined` e cada leitura de coordenada exigiria uma
 * checagem que não corresponde a risco nenhum.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * Posição e tamanho, do jeito que o CUI entende.
 *
 * A ÂNCORA é normalizada (0..1) e relativa ao ELEMENTO PAI. O
 * OFFSET é em pixels e desloca a partir da âncora já resolvida —
 * não do pai.
 *
 * Um elemento com `anchorMin === anchorMax` tem tamanho definido
 * SÓ pelos offsets: é o modo "centralizado com tamanho fixo", que
 * é como se faz uma janela que não estica junto com a tela.
 *
 * A conversão para pixels de tela vive em geometry.ts, que é onde
 * o eixo Y invertido do Unity é tratado.
 */
export interface UiRect {
  readonly anchorMin: Vec2;
  readonly anchorMax: Vec2;
  readonly offsetMin: Vec2;
  readonly offsetMax: Vec2;
}

/**
 * As camadas do jogo onde uma interface pode ser pendurada.
 *
 * O jogo tem outras (Inventory, Crafting, Map…), mas elas só
 * existem enquanto aquela tela está aberta — pendurar um menu nelas
 * o faria sumir quando o jogador fechasse o inventário.
 */
export const UI_LAYERS = ['Overall', 'Overlay', 'Hud.Menu', 'Hud', 'Under'] as const;
export type UiLayer = (typeof UI_LAYERS)[number];

/**
 * As fontes do Rust. São quatro, e só quatro.
 *
 * O nome é o do arquivo, porque é o que o CUI espera no campo
 * `font`. RobotoCondensed-Bold é o padrão do jogo.
 */
export const UI_FONTS = [
  'RobotoCondensed-Bold.ttf',
  'RobotoCondensed-Regular.ttf',
  'DroidSansMono.ttf',
  'PermanentMarker.ttf',
] as const;
export type UiFont = (typeof UI_FONTS)[number];

export const DEFAULT_FONT: UiFont = 'RobotoCondensed-Bold.ttf';

/** Os nove valores do `TextAnchor` do Unity. */
export const UI_TEXT_ALIGNS = [
  'UpperLeft',
  'UpperCenter',
  'UpperRight',
  'MiddleLeft',
  'MiddleCenter',
  'MiddleRight',
  'LowerLeft',
  'LowerCenter',
  'LowerRight',
] as const;
export type UiTextAlign = (typeof UI_TEXT_ALIGNS)[number];

/**
 * Como uma imagem preenche o retângulo.
 *
 * `Sliced` é o que faz uma borda arredondada não deformar ao
 * esticar, e por isso é o modo certo para painel com moldura.
 */
export const UI_IMAGE_TYPES = ['Simple', 'Sliced', 'Tiled', 'Filled'] as const;
export type UiImageType = (typeof UI_IMAGE_TYPES)[number];

// ============================================================
//  AÇÕES
// ============================================================

interface UiActionBase {
  /**
   * Identidade da ação DENTRO do documento.
   *
   * É o que viaja no comando do botão, e é a única coisa que o
   * cliente pode influenciar. O servidor resolve o resto lendo o
   * documento — ver o cabeçalho deste arquivo.
   */
  readonly id: string;
}

/** Troca o conteúdo da tela SEM fechar a interface. */
export interface UiNavigateAction extends UiActionBase {
  readonly kind: 'navigate';
  readonly screenId: string;
}

/** Fecha a interface inteira e invalida a sessão. */
export interface UiCloseAction extends UiActionBase {
  readonly kind: 'close';
}

/** Roda um comando COMO O JOGADOR (ex.: `/tpa`). */
export interface UiChatAction extends UiActionBase {
  readonly kind: 'chat';
  readonly command: string;
}

/**
 * Roda um comando com autoridade do SERVIDOR.
 *
 * O comando vem do documento salvo pelo admin, nunca do que o
 * cliente mandou. É a ação mais perigosa do modelo e a razão de o
 * plugin validar sessão, tela e permissão antes de executar.
 */
export interface UiConsoleAction extends UiActionBase {
  readonly kind: 'console';
  readonly command: string;
}

/**
 * Abre uma tela COMO MODAL, por cima do conteúdo.
 *
 * ####  MODAL NÃO É NAVEGAÇÃO  ####
 *
 * `navigate` substitui o conteúdo; `modal.open` o mantém e desenha
 * por cima, num slot próprio. É a diferença entre "fui para a
 * loja" e "abri os detalhes deste item" — no segundo, a grade
 * continua atrás, e fechar volta exatamente para onde estava.
 */
export interface UiModalOpenAction extends UiActionBase {
  readonly kind: 'modal.open';
  readonly screenId: string;
}

/** Fecha o modal, deixando o conteúdo intacto. */
export interface UiModalCloseAction extends UiActionBase {
  readonly kind: 'modal.close';
}

/**
 * A compra da loja.
 *
 * Quem a SERVE é outra frente do projeto; o modelo a reconhece
 * porque o plugin a implementa, e um documento montado por lá
 * precisa continuar válido aqui.
 */
export interface UiStoreBuyAction extends UiActionBase {
  readonly kind: 'store.buy';
  readonly offerId: string;
  readonly quantity: number;
}

export type UiAction =
  | UiNavigateAction
  | UiCloseAction
  | UiChatAction
  | UiConsoleAction
  | UiModalOpenAction
  | UiModalCloseAction
  | UiStoreBuyAction;

export const UI_ACTION_KINDS = [
  'navigate',
  'close',
  'chat',
  'console',
  'modal.open',
  'modal.close',
  'store.buy',
] as const satisfies readonly UiAction['kind'][];

// ============================================================
//  ELEMENTOS
// ============================================================

export const UI_ELEMENT_TYPES = ['panel', 'label', 'button', 'image'] as const;
export type UiElementType = (typeof UI_ELEMENT_TYPES)[number];

interface UiElementBase {
  readonly id: string;
  /** Nome de exibição na árvore. Não vai para o jogo. */
  readonly name: string;
  readonly rect: UiRect;
  readonly children: readonly UiElement[];
}

/**
 * Retângulo colorido, e o contêiner de todo o resto.
 *
 * `color` é hex `#RRGGBBAA` — ver color.ts para por que o modelo
 * guarda hex e não o formato do jogo.
 */
export interface UiPanelElement extends UiElementBase {
  readonly type: 'panel';
  readonly color: string;
  readonly sprite: string | null;
  readonly imageType: UiImageType;
  /**
   * Material do Unity. `null` = o padrão.
   *
   * O uso real é o DESFOQUE (`uibackgroundblur.mat`): ele borra o
   * que está ATRÁS do elemento, que é como se faz o vidro fosco das
   * janelas do jogo.
   *
   * Exige alfa < 1 na cor para aparecer — um painel opaco por cima
   * do desfoque anula o efeito, e é o engano mais comum com este
   * campo.
   */
  readonly material: string | null;
}

export interface UiLabelElement extends UiElementBase {
  readonly type: 'label';
  readonly text: string;
  readonly fontSize: number;
  readonly font: UiFont;
  readonly color: string;
  readonly align: UiTextAlign;
}

/**
 * Botão: um retângulo clicável com texto próprio.
 *
 * `action` é obrigatória. Botão sem ação é painel — e deixar a ação
 * opcional produziria botões que não fazem nada sem ninguém
 * perceber até testar no jogo.
 */
export interface UiButtonElement extends UiElementBase {
  readonly type: 'button';
  readonly color: string;
  readonly sprite: string | null;
  readonly text: string;
  readonly fontSize: number;
  readonly font: UiFont;
  readonly textColor: string;
  readonly align: UiTextAlign;
  readonly action: UiAction;

  // ----------------------------------------------------------
  //  ESTADOS DO BOTÃO
  //
  //  ####  COR É O ÚNICO ESTADO QUE O CUI TEM  ####
  //
  //  Não existe transform em hover: um botão não cresce, não
  //  encolhe e não desliza. O `ColorBlock` do Unity é toda a
  //  interação disponível.
  // ----------------------------------------------------------
  /** Cor sob o cursor. */
  readonly hoverColor: string | null;
  /** Cor enquanto pressionado. */
  readonly pressedColor: string | null;

  // ----------------------------------------------------------
  //  ESTADO ATIVO — "você está AQUI"
  //
  //  ####  SÓ FAZ SENTIDO NO SHELL  ####
  //
  //  Um botão do shell (a barra de navegação) precisa mostrar em
  //  que tela o jogador está. Como o shell NÃO é redesenhado ao
  //  navegar — esse é o ponto dele —, a cor não pode vir de o
  //  elemento ser recriado: ela é ATUALIZADA no lugar.
  // ----------------------------------------------------------
  /** Cor quando a tela de `activeOnScreenId` estiver aberta. */
  readonly activeColor: string | null;
  /** Cor do TEXTO no estado ativo. `null` = mantém a normal. */
  readonly activeTextColor: string | null;
  /** Em qual tela este botão aparece como ativo. */
  readonly activeOnScreenId: string | null;
}

/**
 * De onde a imagem vem.
 *
 * São origens diferentes no CUI, com componentes diferentes:
 * sprite e item viram `UnityEngine.UI.Image`, URL e imagem própria
 * viram `UnityEngine.UI.RawImage`. Distingui-las aqui evita um
 * campo `url` preenchido que o conversor ignora em silêncio.
 */
export type UiImageSource =
  | { readonly kind: 'sprite'; readonly sprite: string }
  | { readonly kind: 'url'; readonly url: string }
  /** `skinId` é string: skin de workshop passa de 2^53. */
  | { readonly kind: 'item'; readonly itemId: number; readonly skinId: string }
  /**
   * Uma imagem NOSSA, guardada no servidor de Rust.
   *
   * O CUI só desenha imagem própria por `png`, que é um número do
   * FileStorage — e esse número só existe depois de o plugin
   * guardar os bytes. Por isso aqui fica só a CHAVE: o nome do
   * arquivo em `Assets\ui`, sem a extensão.
   */
  | { readonly kind: 'stored'; readonly key: string };

export interface UiImageElement extends UiElementBase {
  readonly type: 'image';
  readonly source: UiImageSource;
  /** Tinge a imagem. Branco opaco = cor original. */
  readonly color: string;
}

export type UiElement = UiPanelElement | UiLabelElement | UiButtonElement | UiImageElement;

// ============================================================
//  TELA E DOCUMENTO
// ============================================================

export const UI_SCREEN_KINDS = ['page', 'modal'] as const;
export type UiScreenKind = (typeof UI_SCREEN_KINDS)[number];

/**
 * Uma tela do documento.
 *
 * `elements` é uma ÁRVORE, não uma lista: o CUI posiciona por
 * âncora relativa ao pai, então aninhar é o que permite mover um
 * grupo inteiro mexendo só no contêiner.
 */
export interface UiScreen {
  readonly id: string;
  readonly name: string;
  /**
   * Onde esta tela é desenhada.
   *
   *   page  -> no slot de conteúdo; substitui a página atual.
   *   modal -> no slot de modal; fica POR CIMA, e o conteúdo
   *            continua embaixo, intacto.
   *
   * É propriedade da TELA, e não da ação que a abre, porque o lugar
   * onde ela cabe é característica dela.
   */
  readonly kind: UiScreenKind;
  readonly elements: readonly UiElement[];
}

export interface UiDocument {
  readonly id: string;
  readonly name: string;

  /**
   * Comando de chat que abre, SEM a barra: `menu` vira `/menu`.
   *
   * O Oxide registra UMA palavra, e a barra é adicionada pelo jogo
   * — `/menu` viraria `//menu`.
   */
  readonly command: string;

  /** Permissão do Oxide. `null` = todo mundo abre. */
  readonly permission: string | null;

  readonly layer: UiLayer;

  /**
   * Libera o cursor do mouse enquanto a interface está aberta.
   *
   * Praticamente sempre `true`: sem cursor não há como clicar em
   * botão. Fica configurável porque um HUD (camada `Hud`) mostra
   * informação sem receber clique, e roubar o mouse ali seria tirar
   * o jogador do jogo.
   */
  readonly cursor: boolean;

  // ----------------------------------------------------------
  //  O SHELL — o que NÃO se redesenha ao trocar de tela
  //
  //  ####  É O QUE TIRA O PISCAR  ####
  //
  //  No CUI, trocar de tela redesenhando tudo destrói e recria a
  //  interface inteira: o jogador vê o menu fechar e reabrir a
  //  cada clique. Com o shell separado, o cabeçalho e a moldura
  //  são desenhados UMA vez, na abertura.
  //
  //  O ganho secundário é de tamanho, e é ele que faz o menu caber
  //  no RCON: sem shell, cada tela carregava sua própria cópia do
  //  cabeçalho. Sete telas, sete cópias.
  // ----------------------------------------------------------
  readonly shell: readonly UiElement[];

  /**
   * Qual elemento do shell recebe o conteúdo das telas.
   *
   * `null` desliga a separação: tudo volta a ser redesenhado por
   * tela.
   */
  readonly contentSlotId: string | null;

  /**
   * Onde os MODAIS são desenhados.
   *
   * Precisa vir DEPOIS do slot de conteúdo na ordem do shell: no
   * CUI a ordem da lista é a profundidade, e um modal declarado
   * antes apareceria atrás da página que ele deveria cobrir.
   */
  readonly modalSlotId: string | null;

  /** A tela mostrada ao abrir. Precisa existir em `screens`. */
  readonly entryScreenId: string;

  /**
   * Duração do fade de entrada, em SEGUNDOS. 0 = sem fade.
   *
   * Em segundos porque é a unidade do CUI — quem pensa em "200ms"
   * escreve `0.2`.
   */
  readonly fadeIn: number;

  readonly screens: readonly UiScreen[];
}

// ============================================================
//  LIMITES
//
//  Interface é dado que o cliente de OUTRA PESSOA vai montar. Sem
//  teto, um documento com dez mil elementos trava o jogo de quem
//  abrir — e o lugar de recusar é onde o dado entra, tanto aqui
//  quanto na borda HTTP do agente, que repete estes números.
// ============================================================

/** Profundidade máxima de aninhamento de elementos. */
export const MAX_ELEMENT_DEPTH = 12;

/** Elementos por tela, somando a árvore inteira. */
export const MAX_ELEMENTS_PER_SCREEN = 400;

export const MAX_SCREENS_PER_DOCUMENT = 40;

// ============================================================
//  NAVEGAÇÃO NA ÁRVORE
//
//  Funções puras usadas pelo editor e pela validação. Ficam aqui,
//  junto do modelo, porque todas dependem do formato de
//  `children` — mudá-lo sem mexer nestas quebraria em silêncio.
// ============================================================

/** Percorre a árvore em profundidade, pais antes dos filhos. */
export function* walkElements(
  elements: readonly UiElement[],
): Generator<{ readonly element: UiElement; readonly depth: number }> {
  for (const element of elements) {
    yield { element, depth: 0 };

    for (const nested of walkElements(element.children)) {
      yield { element: nested.element, depth: nested.depth + 1 };
    }
  }
}

export function countElements(elements: readonly UiElement[]): number {
  let total = 0;

  for (const _ of walkElements(elements)) {
    total += 1;
  }

  return total;
}

/** Profundidade máxima alcançada. Árvore vazia é 0. */
export function maxDepth(elements: readonly UiElement[]): number {
  let deepest = 0;

  for (const { depth } of walkElements(elements)) {
    // +1 porque `depth` conta a partir de 0 na raiz, e o que
    // interessa é quantos níveis existem.
    deepest = Math.max(deepest, depth + 1);
  }

  return deepest;
}

export function findElement(elements: readonly UiElement[], id: string): UiElement | null {
  for (const { element } of walkElements(elements)) {
    if (element.id === id) {
      return element;
    }
  }

  return null;
}
