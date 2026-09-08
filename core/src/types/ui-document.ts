// ============================================================
//  ####  O MODELO DE INTERFACE, DO LADO QUE RECEBE  ####
//
//  O espelho dele mora em `panel/src/lib/ui-doc/model.ts`, em
//  TypeScript, porque é o que o editor edita. Aqui ele é schema
//  zod, porque este é o lado que RECEBE: a rota é autenticada, mas
//  a entrada pode não vir do editor — um script, um curl, um JSON
//  importado à mão — e "o cliente já validou" nunca foi garantia
//  de nada.
//
//  MUDAR O MODELO EXIGE MUDAR OS DOIS ARQUIVOS. Não há tipo
//  compartilhado entre os pacotes: o painel é bundle de navegador
//  e o core é ESM de Node, compilados separadamente.
//
//  ------------------------------------------------------------
//  ####  POR QUE VALIDAR AQUI SE O EDITOR JÁ VALIDA  ####
//
//  Porque são coisas diferentes. O editor valida para AVISAR quem
//  desenha, enquanto ele desenha. Isto valida porque um documento
//  malformado gravado no banco vira interface quebrada no jogo de
//  todo mundo que abrir o menu — e o defeito aparece longe daqui.
//
//  ####  NÃO EXISTE ÁREA ROLÁVEL, E ISSO É MEDIDO  ####
//
//  O projeto anterior tentou emitir `UnityEngine.UI.ScrollView`
//  com `contentTransform` e barra vertical. O resultado foi
//
//      RPC Error in AddUI: Object reference not set to an
//      instance of an object
//
//  e o jogador DESCONECTADO. Os nomes dos campos existem (vieram
//  da tabela de strings do Oxide.Rust.dll); o que não se sabe é o
//  que o CLIENTE exige junto. Até isso ser lido no código do
//  cliente — e não deduzido —, o modelo não oferece o tipo. Uma
//  lista longa se resolve com paginação por telas, que ninguém
//  derruba.
// ============================================================

import { z } from 'zod';

// ------------------------------------------------------------
//  Limites. Os MESMOS números do painel (ui-doc/model.ts).
//
//  Interface é dado que o cliente de OUTRA PESSOA vai montar: sem
//  teto, um documento com dez mil elementos trava o jogo de quem
//  abrir o menu. O lugar de recusar é onde o dado entra.
// ------------------------------------------------------------
export const MAX_ELEMENT_DEPTH = 12;
export const MAX_ELEMENTS_PER_SCREEN = 400;
export const MAX_SCREENS_PER_DOCUMENT = 40;

/**
 * Quantos comandos de chat extras um documento pode ter.
 *
 * Oito é folga: cada um ocupa um nome GLOBAL no servidor, e um
 * documento que precise de mais que isso está querendo ser vários.
 */
export const MAX_SHORTCUTS_PER_DOCUMENT = 8;

/**
 * Teto do documento serializado, em bytes.
 *
 * NÃO é o limite do RCON — esse é do transporte, e vale por TELA
 * (ver types/ui-transport.ts). Este aqui protege o banco e a
 * memória do processo: sem teto, um PUT de 50 MB é aceito e
 * gravado.
 *
 * 256 KB comporta com folga um menu de sete telas cheias, medido
 * pelo tamanho do JSON que o editor gera.
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/**
 * As camadas do jogo onde uma interface pode ser pendurada.
 *
 * São o `parent` do elemento raiz. O jogo tem outras (Inventory,
 * Crafting, Map…), mas elas só existem enquanto aquela tela está
 * aberta — pendurar um menu nelas o faria sumir quando o jogador
 * fechasse o inventário, que não é comportamento que alguém queira
 * por engano.
 */
export const UI_LAYERS = ['Overall', 'Overlay', 'Hud.Menu', 'Hud', 'Under'] as const;

/** As fontes do Rust. São quatro, e só quatro. */
export const UI_FONTS = [
  'RobotoCondensed-Bold.ttf',
  'RobotoCondensed-Regular.ttf',
  'DroidSansMono.ttf',
  'PermanentMarker.ttf',
] as const;

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

/**
 * Como uma imagem preenche o retângulo.
 *
 * `Sliced` é o que faz uma borda arredondada não deformar ao
 * esticar, e por isso é o modo certo para painel com moldura.
 */
export const UI_IMAGE_TYPES = ['Simple', 'Sliced', 'Tiled', 'Filled'] as const;

// ------------------------------------------------------------
//  Identificadores.
//
//  ####  ELE VIAJA NUM COMANDO DE CONSOLE  ####
//
//  O id de uma ação vai dentro de `origemz.ui.act <token> <id>`, e
//  o Rust separa argumentos por ESPAÇO. Um id com espaço deslocaria
//  os argumentos e o plugin leria outra coisa — por isso o alfabeto
//  é restrito, e por isso isto é validado e não só documentado.
// ------------------------------------------------------------
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'id aceita apenas letras, números, hífen e sublinhado');

/** Cor em hex `#RRGGBB` ou `#RRGGBBAA`. */
const colorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i, 'cor precisa ser #RRGGBB ou #RRGGBBAA');

const vec2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

/**
 * Posição e tamanho, do jeito que o CUI entende.
 *
 * A ÂNCORA é normalizada (0..1) e relativa ao ELEMENTO PAI; o
 * OFFSET é em pixels e desloca a partir da âncora já resolvida —
 * não do pai. A conversão para pixels de tela mora no painel
 * (`ui-doc/geometry.ts`), que é onde o eixo Y invertido do Unity é
 * tratado.
 */
const rectSchema = z.object({
  anchorMin: vec2Schema,
  anchorMax: vec2Schema,
  offsetMin: vec2Schema,
  offsetMax: vec2Schema,
});

// ------------------------------------------------------------
//  A AÇÃO — a parte de segurança do modelo.
//
//  O botão do CUI carrega um ENDEREÇO (o `id` daqui), nunca a
//  intenção: o `command` de um botão é executado pelo CLIENTE, e
//  qualquer jogador pode digitá-lo no F1 com os argumentos que
//  quiser.
//
//  É por isso que `console` — a ação que roda com autoridade do
//  SERVIDOR — só existe DENTRO do documento salvo pelo admin. O
//  que chega do cliente é o id, e o resto o servidor resolve.
//
//  ####  `store.buy` ESTÁ AQUI PORQUE O PLUGIN A IMPLEMENTA  ####
//
//  Quem serve a loja é outra frente do projeto. O modelo a
//  reconhece mesmo assim porque ele espelha o `Execute` do
//  `OrigemZUI` — omiti-la faria um documento legítimo, montado por
//  lá, ser recusado na leitura e o menu sumir do jogo.
// ------------------------------------------------------------
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ id: idSchema, kind: z.literal('navigate'), screenId: idSchema }),
  z.object({ id: idSchema, kind: z.literal('close') }),
  /** Roda COMO O JOGADOR. É o que `/tpa` significa. */
  z.object({ id: idSchema, kind: z.literal('chat'), command: z.string().min(1).max(256) }),
  /** Roda com autoridade do SERVIDOR. A ação mais perigosa daqui. */
  z.object({ id: idSchema, kind: z.literal('console'), command: z.string().min(1).max(256) }),
  z.object({ id: idSchema, kind: z.literal('modal.open'), screenId: idSchema }),
  z.object({ id: idSchema, kind: z.literal('modal.close') }),
  z.object({
    id: idSchema,
    kind: z.literal('store.buy'),
    offerId: z.string().max(64),
    // `.default(1)` mantém válido o que foi gravado antes deste
    // campo. Sem ele, um documento antigo seria descartado na
    // leitura e o menu sumiria do jogo.
    quantity: z.number().int().min(1).max(1000).default(1),
  }),
]);

export type UiAction = z.infer<typeof actionSchema>;

// ------------------------------------------------------------
//  O ELEMENTO — recursivo.
//
//  `z.lazy` com o tipo declarado à mão: o zod não infere um schema
//  que se referencia, e sem a anotação o tipo resultante vira `any`
//  em silêncio — o pior desfecho possível num arquivo cujo trabalho
//  é justamente tipar a entrada.
// ------------------------------------------------------------
interface UiElementBase {
  readonly id: string;
  readonly name: string;
  readonly rect: z.infer<typeof rectSchema>;
  readonly children: readonly UiElement[];
}

export type UiElement = UiElementBase &
  (
    | {
        readonly type: 'panel';
        readonly color: string;
        readonly sprite: string | null;
        readonly imageType: (typeof UI_IMAGE_TYPES)[number];
        /** Material do Unity — o uso real é o desfoque. */
        readonly material: string | null;
      }
    | {
        readonly type: 'label';
        readonly text: string;
        readonly fontSize: number;
        readonly font: (typeof UI_FONTS)[number];
        readonly color: string;
        readonly align: (typeof UI_TEXT_ALIGNS)[number];
      }
    | {
        readonly type: 'button';
        readonly color: string;
        readonly sprite: string | null;
        readonly text: string;
        readonly fontSize: number;
        readonly font: (typeof UI_FONTS)[number];
        readonly textColor: string;
        readonly align: (typeof UI_TEXT_ALIGNS)[number];
        readonly action: UiAction;
        /** Cor sob o cursor. Cor é o ÚNICO estado que o CUI tem. */
        readonly hoverColor: string | null;
        readonly pressedColor: string | null;
        /**
         * Estado ATIVO — "você está aqui" na navegação.
         *
         * Só faz sentido num botão do SHELL: como ele não é
         * redesenhado ao navegar, a cor é atualizada no lugar
         * (`update: true`) em vez de o elemento ser recriado.
         */
        readonly activeColor: string | null;
        readonly activeTextColor: string | null;
        readonly activeOnScreenId: string | null;
      }
    | {
        readonly type: 'image';
        readonly source:
          | { readonly kind: 'sprite'; readonly sprite: string }
          | { readonly kind: 'url'; readonly url: string }
          | { readonly kind: 'item'; readonly itemId: number; readonly skinId: string }
          | { readonly kind: 'stored'; readonly key: string };
        readonly color: string;
      }
  );

const baseFields = {
  id: idSchema,
  name: z.string().max(64),
  rect: rectSchema,
};

const elementSchema: z.ZodType<UiElement> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      ...baseFields,
      type: z.literal('panel'),
      color: colorSchema,
      sprite: z.string().max(256).nullable(),
      imageType: z.enum(UI_IMAGE_TYPES),
      // `.default(null)` é o que mantém válidos os documentos
      // GRAVADOS ANTES deste campo. Sem ele, a leitura os descarta
      // em silêncio e o menu some do jogo.
      material: z.string().max(256).nullable().default(null),
      children: z.array(elementSchema),
    }),
    z.object({
      ...baseFields,
      type: z.literal('label'),
      text: z.string().max(2048),
      fontSize: z.number().int().min(1).max(256),
      font: z.enum(UI_FONTS),
      color: colorSchema,
      align: z.enum(UI_TEXT_ALIGNS),
      children: z.array(elementSchema),
    }),
    z.object({
      ...baseFields,
      type: z.literal('button'),
      color: colorSchema,
      sprite: z.string().max(256).nullable(),
      text: z.string().max(512),
      fontSize: z.number().int().min(1).max(256),
      font: z.enum(UI_FONTS),
      textColor: colorSchema,
      align: z.enum(UI_TEXT_ALIGNS),
      action: actionSchema,
      hoverColor: colorSchema.nullable().default(null),
      pressedColor: colorSchema.nullable().default(null),
      activeColor: colorSchema.nullable().default(null),
      activeTextColor: colorSchema.nullable().default(null),
      activeOnScreenId: idSchema.nullable().default(null),
      children: z.array(elementSchema),
    }),
    z.object({
      ...baseFields,
      type: z.literal('image'),
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('sprite'), sprite: z.string().min(1).max(256) }),
        z.object({ kind: z.literal('url'), url: z.string().url().max(1024) }),
        z.object({
          kind: z.literal('item'),
          /** Pode ser negativo — `hat.wolf` é `-1478212975`. */
          itemId: z.number().int(),
          // String, e não número: skin de workshop passa de 2^53.
          skinId: z
            .string()
            .regex(/^\d+$/)
            .max(24),
        }),
        // ####  IMAGEM NOSSA, GUARDADA NO SERVIDOR  ####
        //
        // O PNG vive no FileStorage do servidor de Rust, e a tela
        // guarda só a CHAVE dele. O número que o cliente usa (o
        // CRC) só existe depois de o plugin guardar o arquivo, e é
        // ele quem o preenche — ver game/ui-images.ts.
        //
        // Alfabeto restrito porque a chave viaja num comando de
        // console, separada por espaço.
        z.object({
          kind: z.literal('stored'),
          key: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]*$/)
            .max(32),
        }),
      ]),
      /** Tinge a imagem. Branco opaco = cor original. */
      color: colorSchema,
      children: z.array(elementSchema),
    }),
  ]),
) as z.ZodType<UiElement>;

const screenSchema = z.object({
  id: idSchema,
  name: z.string().max(64),
  /**
   * O AGENTE monta esta tela a cada abertura?
   *
   * ####  SEM ISTO, A TELA GRAVADA GANHA DA MONTADA  ####
   *
   * MEDIDO no jogo em 06/09/2026: o `OpenScreen` do `OrigemZUI`
   * desenha o que está no documento e SÓ pede ao agente o que não
   * tem. A tela de ENTRADA sempre viaja na carga inicial — então
   * uma entrada montada pelo agente nunca era pedida, e o jogador
   * ficava olhando o "carregando" para sempre.
   *
   * `true` faz o plugin pedir mesmo tendo. O que está gravado
   * continua servindo de REPOUSO: é o que aparece enquanto a
   * resposta não chega, e o que sobra se o agente estiver fora.
   *
   * Ausente (o normal) é toda tela desenhada no editor.
   *
   * `.optional()` e não `.default(false)`: com o default, o tipo de
   * SAÍDA passa a exigir o campo, e todo construtor de tela do
   * projeto — kits, calendário, loja, ranking — teria de informá-lo
   * para dizer "não". Ausente já quer dizer isso.
   */
  generated: z.boolean().optional(),
  /**
   * `page` ocupa o slot de conteúdo; `modal` fica POR CIMA dele.
   *
   * É propriedade da TELA, e não da ação que a abre, porque o lugar
   * onde ela cabe é característica dela: um modal de confirmação
   * desenhado no slot de página apareceria em tela cheia.
   */
  kind: z.enum(['page', 'modal']).default('page'),
  elements: z.array(elementSchema),
});

export type UiScreen = z.infer<typeof screenSchema>;

// ------------------------------------------------------------
//  O documento.
//
//  `command` sem barra e em minúsculas: o Oxide registra UMA
//  palavra, e a barra é adicionada pelo jogo — `/menu` viraria
//  `//menu`. `permission` segue o formato que o
//  `permission.RegisterPermission` aceita; com maiúscula, ela é
//  registrada e nunca confere com a que o jogador tem.
// ------------------------------------------------------------
export const uiDocumentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  command: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'comando aceita minúsculas, números, ponto e hífen'),
  permission: z
    .string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'permissão precisa ser minúscula')
    .nullable(),
  layer: z.enum(UI_LAYERS),
  /**
   * Libera o cursor do mouse enquanto a interface está aberta.
   *
   * Praticamente sempre `true`: sem cursor não há como clicar em
   * botão. Fica configurável porque um HUD (camada `Hud`) mostra
   * informação sem receber clique, e roubar o mouse ali seria tirar
   * o jogador do jogo.
   */
  cursor: z.boolean(),
  /**
   * Fade de entrada, em SEGUNDOS.
   *
   * Teto de 2s: acima disso a interface demora tanto a aparecer que
   * parece travada, e quem abriu o menu clica de novo.
   */
  fadeIn: z.number().min(0).max(2).default(0),
  /**
   * O SHELL: o que NÃO se redesenha ao trocar de tela.
   *
   * ####  É O QUE TIRA O PISCAR  ####
   *
   * Sem ele, navegar destrói e recria a interface inteira, e o
   * jogador vê o menu fechar e reabrir a cada clique. Com ele, o
   * cabeçalho e a moldura ficam, e trocar de tela mexe só no
   * conteúdo.
   *
   * O ganho secundário é de TAMANHO, e é ele que faz o menu caber
   * no RCON: sem shell, cada tela carregava sua própria cópia do
   * cabeçalho — sete telas, sete cabeçalhos.
   *
   * Lista vazia = cada tela desenha tudo, que é como um documento
   * simples funciona.
   */
  shell: z.array(elementSchema).default([]),
  /** Qual elemento do shell recebe o conteúdo das telas. */
  contentSlotId: idSchema.nullable().default(null),
  /**
   * Onde os modais são desenhados.
   *
   * Precisa vir DEPOIS do slot de conteúdo na ordem do shell: no
   * CUI a ordem da lista é a profundidade, e um modal declarado
   * antes apareceria atrás da página que ele deveria cobrir.
   */
  modalSlotId: idSchema.nullable().default(null),
  /** A tela mostrada ao abrir. Precisa existir em `screens`. */
  entryScreenId: idSchema,
  /**
   * Comandos de chat que abrem o menu JÁ NUMA TELA.
   *
   * ####  ELES EXISTEM PARA NÃO HAVER UM MENU CLONADO  ####
   *
   * `/quest` precisava abrir direto nas missões. A primeira versão
   * fez isso com um SEGUNDO DOCUMENTO — o mesmo shell, as mesmas
   * onze telas, outro `command` e outra entrada. Funcionava, e
   * estava errado: o servidor recebia duas cópias do menu inteiro
   * no RCON, o admin via dois "Menu" na tela de Interface e toda
   * mudança de estilo tinha dois lugares para ser feita.
   *
   * Aqui é uma LINHA: `{ command: 'quest', screenId: 'tela-missoes' }`.
   * O plugin registra o comando extra e abre naquela tela; o resto
   * do menu é o mesmo, porque é o mesmo.
   *
   * Cada `screenId` precisa existir em `screens` — ver
   * `findDocumentProblems`.
   */
  shortcuts: z
    .array(
      z.object({
        command: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[a-z0-9][a-z0-9._-]*$/, 'comando aceita minúsculas, números, ponto e hífen'),
        screenId: idSchema,
      }),
    )
    .max(MAX_SHORTCUTS_PER_DOCUMENT)
    .default([]),
  screens: z.array(screenSchema).min(1).max(MAX_SCREENS_PER_DOCUMENT),
});

export type UiDocument = z.infer<typeof uiDocumentSchema>;

// ============================================================
//  REGRAS QUE UM SCHEMA NÃO EXPRESSA
//
//  Referências e limites de árvore dependem do documento INTEIRO,
//  e não de um campo. Ficam aqui, ao lado do schema, porque quem
//  valida a entrada precisa das duas coisas — e esquecer a segunda
//  deixa passar exatamente o que quebra o jogo: um botão que navega
//  para uma tela apagada.
// ============================================================

export interface DocumentProblem {
  readonly message: string;
}

export function* walkElements(
  elements: readonly UiElement[],
  depth = 1,
): Generator<{ readonly element: UiElement; readonly depth: number }> {
  for (const element of elements) {
    yield { element, depth };
    yield* walkElements(element.children, depth + 1);
  }
}

/**
 * O que o schema não pega: referência quebrada, id repetido e
 * árvore grande demais.
 *
 * Devolve TODOS os problemas, e não o primeiro: quem manda um
 * documento por script quer a lista inteira de uma vez, não uma ida
 * e volta por erro.
 */
export function findDocumentProblems(document: UiDocument): readonly DocumentProblem[] {
  const problems: DocumentProblem[] = [];

  const screenIds = new Set(document.screens.map((screen) => screen.id));

  if (!screenIds.has(document.entryScreenId)) {
    problems.push({
      message: `A tela de entrada ("${document.entryScreenId}") não existe neste documento.`,
    });
  }

  if (screenIds.size !== document.screens.length) {
    problems.push({ message: 'Há telas com o mesmo id.' });
  }

  for (const shortcut of document.shortcuts) {
    if (!screenIds.has(shortcut.screenId)) {
      problems.push({
        message:
          `O comando "/${shortcut.command}" abre numa tela ("${shortcut.screenId}") que não ` +
          'existe neste documento.',
      });
    }

    if (shortcut.command === document.command) {
      // O plugin guarda um documento por comando: o atalho
      // sobrescreveria o principal, e `/menu` passaria a abrir na
      // tela do atalho.
      problems.push({
        message: `O comando "/${shortcut.command}" é o mesmo que abre o documento inteiro.`,
      });
    }
  }

  const slotIds = new Set<string>();

  for (const { element } of walkElements(document.shell)) {
    slotIds.add(element.id);
  }

  if (document.contentSlotId !== null && !slotIds.has(document.contentSlotId)) {
    problems.push({
      message:
        `O slot de conteúdo ("${document.contentSlotId}") não é um elemento do cabeçalho. Sem ` +
        'ele, as telas seriam desenhadas na raiz e apareceriam por cima da moldura.',
    });
  }

  // ####  O SLOT DE MODAL NÃO PODE ESTAR NO CABEÇALHO  ####
  //
  // É o contrário do de conteúdo, e a diferença custou uma tarde:
  // um painel de tela cheia e transparente no shell ENGOLE TODOS
  // OS CLIQUES. No Unity, alpha 0 não desliga o raycast — o menu
  // abre bonito e nenhum botão responde, nem o de fechar.
  //
  // Quem cria esse contêiner é o PLUGIN, só enquanto há um modal
  // aberto. Aqui o campo é apenas o NOME que ele vai usar.
  if (document.modalSlotId !== null && slotIds.has(document.modalSlotId)) {
    problems.push({
      message:
        `O slot de modal ("${document.modalSlotId}") NÃO pode ser um elemento do cabeçalho: um ` +
        'painel transparente por cima da tela engole todos os cliques, e o menu abriria sem ' +
        'nenhum botão responder. Quem o cria é o plugin, e só enquanto há um modal aberto.',
    });
  }

  // Elementos e ações dividem o espaço de nomes de propósito: um id
  // repetido entre os dois faria o plugin resolver a ação errada, e
  // num botão de loja isso é entregar o item errado.
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  const note = (id: string): void => {
    if (seen.has(id)) {
      duplicated.add(id);
    }

    seen.add(id);
  };

  for (const { element } of walkElements(document.shell)) {
    note(element.id);

    if (element.type === 'button') {
      note(element.action.id);

      if (
        (element.action.kind === 'navigate' || element.action.kind === 'modal.open') &&
        !screenIds.has(element.action.screenId)
      ) {
        problems.push({
          message: `O botão "${element.name}", do cabeçalho, leva a uma tela que não existe.`,
        });
      }
    }
  }

  for (const screen of document.screens) {
    note(screen.id);

    let count = 0;
    let deepest = 0;

    for (const { element, depth } of walkElements(screen.elements)) {
      count += 1;
      deepest = Math.max(deepest, depth);

      note(element.id);

      if (element.type !== 'button') {
        continue;
      }

      note(element.action.id);

      if (
        (element.action.kind === 'navigate' || element.action.kind === 'modal.open') &&
        !screenIds.has(element.action.screenId)
      ) {
        problems.push({
          message: `O botão "${element.name}" leva a uma tela que não existe neste documento.`,
        });
      }
    }

    if (count > MAX_ELEMENTS_PER_SCREEN) {
      problems.push({
        message:
          `A tela "${screen.name}" tem ${String(count)} elementos (o limite é ` +
          `${String(MAX_ELEMENTS_PER_SCREEN)}).`,
      });
    }

    if (deepest > MAX_ELEMENT_DEPTH) {
      problems.push({
        message:
          `A tela "${screen.name}" aninha ${String(deepest)} níveis (o limite é ` +
          `${String(MAX_ELEMENT_DEPTH)}).`,
      });
    }
  }

  for (const id of duplicated) {
    problems.push({ message: `Identificador repetido: "${id}".` });
  }

  return problems;
}

// ============================================================
//  O QUE ESTE SERVIDOR ESCONDE
//
//  ####  O DESENHO É DA REDE; O QUE APARECE É DO SERVIDOR  ####
//
//  O documento é UM, editado uma vez. Cada servidor liga e desliga
//  pedaços dele — o PVE que não tem loja esconde o botão LOJA e a
//  tela dela, sem uma segunda cópia do menu para manter em dia.
//
//  A poda acontece AQUI, no modelo, e não na conversão para CUI:
//  assim ela vale igual para o que vai ao jogo, para o `preview` do
//  editor e para o cálculo de tamanho. Fazê-la só na saída deixaria
//  o preview mostrando o que o servidor não desenha.
// ============================================================

/**
 * O documento como ESTE servidor o mostra.
 *
 * `hidden` traz ids de elementos (some ele e os filhos) e de telas
 * (some a tela inteira). Lista vazia devolve o documento como está,
 * e é o caminho de quase todo servidor.
 *
 * ####  A TELA DE ENTRADA NUNCA SOME  ####
 *
 * Esconder a tela de entrada deixaria o menu sem o que abrir — e o
 * jogador com um comando que não faz nada. Ela é preservada mesmo
 * listada, porque "o menu não abre" é pior que "a tela continua aí".
 *
 * ####  O BOTÃO QUE LEVA À TELA ESCONDIDA SOME JUNTO  ####
 *
 * Ele já sobrevivia: a regra era "cabe a quem esconde a tela
 * esconder o botão junto", e o plugin recusa navegar para uma tela
 * que não conhece — o clique não fazia nada, e o menu não caía.
 *
 * Só que "não faz nada" é um defeito do ponto de vista de quem
 * joga, e a conta de esconder dois ids em vez de um nunca foi
 * explicada em lugar nenhum da tela de Configurações. Com a HOME
 * mostrando um cartão por assunto — loja, ranking, wipe, missões —,
 * o preço subiu: esquecer o segundo id deixa um cartão inteiro
 * prometendo uma seção que aquele servidor não tem.
 *
 * Então a poda passou a ser transitiva: o elemento cuja AÇÃO aponta
 * para uma tela escondida vai embora com ela, e leva os filhos.
 * Esconder a tela basta.
 */
export function applyHidden(document: UiDocument, hidden: readonly string[]): UiDocument {
  if (hidden.length === 0) {
    return document;
  }

  const hide = new Set(hidden);

  // A de entrada nunca some (ver acima), então o botão que leva a
  // ela também não pode sumir.
  const leadsToHidden = (element: UiElement): boolean => {
    if (element.type !== 'button') {
      return false;
    }

    const action = element.action;
    const target =
      action.kind === 'navigate' || action.kind === 'modal.open' ? action.screenId : null;

    return target !== null && target !== document.entryScreenId && hide.has(target);
  };

  const prune = (elements: readonly UiElement[]): UiElement[] => {
    const kept = elements.filter((element) => !hide.has(element.id) && !leadsToHidden(element));

    // O vão que a poda abriu se fecha AQUI, antes de descer nos
    // filhos: fechá-lo é mexer no retângulo do próprio elemento, e
    // a conta precisa da fila INTEIRA — inclusive de quem acabou
    // de sair dela.
    const moved = kept.length === elements.length ? kept : closeRowGaps(elements, kept);

    return moved.map((element) => ({ ...element, children: prune(element.children) }));
  };

  return {
    ...document,
    shell: prune(document.shell),
    screens: document.screens
      .filter((screen) => screen.id === document.entryScreenId || !hide.has(screen.id))
      .map((screen) => ({ ...screen, elements: prune(screen.elements) })),
  };
}

// ============================================================
//  A FILA QUE SE FECHA
//
//  ####  ESCONDER UM BOTÃO NÃO PODE DEIXAR UM BURACO  ####
//
//  A barra do cabeçalho é desenhada por deslocamento acumulado:
//  cada botão começa onde o anterior terminou. É o que a mantém
//  colada na borda em qualquer proporção de tela — e é também o
//  que fazia o servidor sem EVENTOS e sem REGRAS mostrar um vão do
//  tamanho dos dois entre CALENDÁRIO e KITS. O menu não quebrava;
//  ele só parecia quebrado, que em interface dá no mesmo.
//
//  ####  A FILA É RECONHECIDA, NÃO DECLARADA  ####
//
//  O documento não tem contêiner de fluxo: o modelo é de
//  retângulos livres, e inventar um agora obrigaria todo desenho
//  já gravado a ser remontado para ganhar o conserto.
//
//  Então a fila é reconhecida pela FORMA — irmãos de largura fixa,
//  no mesmo trilho vertical, presos à mesma âncora e sem se
//  sobrepor. Um cabeçalho é exatamente isso. Um rótulo em cima de
//  um painel não é, e fica onde o admin o pôs.
// ============================================================

/**
 * O trilho de uma fila, ou `null` para quem não pode estar em uma.
 *
 * Largura que ACOMPANHA o pai fica de fora: quem divide o espaço
 * dele — os cartões da HOME — já se redistribui por outra conta
 * (ver `cardsOf` em game/ui-home-screen.ts), e um empurrão daqui o
 * desalinharia.
 */
function rowKey(element: UiElement): string | null {
  const { rect } = element;

  if (rect.anchorMin.x !== rect.anchorMax.x) {
    return null;
  }

  return [rect.anchorMin.x, rect.anchorMin.y, rect.anchorMax.y, rect.offsetMin.y, rect.offsetMax.y]
    .map((value) => String(value))
    .join(':');
}

/** O mesmo elemento, deslocado na horizontal. */
function shiftX(element: UiElement, delta: number): UiElement {
  const { rect } = element;

  return {
    ...element,
    rect: {
      ...rect,
      offsetMin: { ...rect.offsetMin, x: rect.offsetMin.x + delta },
      offsetMax: { ...rect.offsetMax, x: rect.offsetMax.x + delta },
    },
  };
}

/**
 * Os sobreviventes, com o vão dos removidos fechado.
 *
 * `before` é o nível como estava; `kept` é o que sobrou dele, na
 * mesma ordem.
 *
 * ####  O VÃO FECHA EM DIREÇÃO À ÂNCORA  ####
 *
 * A fila presa à ESQUERDA puxa quem está à direita do vão; a presa
 * à DIREITA empurra quem está à esquerda. Nas duas, a ponta que
 * estava colada na borda continua colada — que é o motivo de o
 * desenho ter escolhido aquela âncora.
 */
function closeRowGaps(before: readonly UiElement[], kept: readonly UiElement[]): UiElement[] {
  const survivors = new Set(kept.map((element) => element.id));
  const rows = new Map<string, UiElement[]>();

  for (const element of before) {
    const key = rowKey(element);

    if (key === null) {
      continue;
    }

    const row = rows.get(key);

    if (row === undefined) {
      rows.set(key, [element]);
    } else {
      row.push(element);
    }
  }

  const move = new Map<string, number>();

  for (const row of rows.values()) {
    // Um elemento sozinho não é fila; e uma fila que sobreviveu
    // inteira não tem vão a fechar.
    if (row.length < 2 || row.every((element) => survivors.has(element.id))) {
      continue;
    }

    const sorted = [...row].sort((a, b) => a.rect.offsetMin.x - b.rect.offsetMin.x);
    const first = sorted[0];

    if (first === undefined) {
      continue;
    }

    // Caixas que se SOBREPÕEM são um desenho — um rótulo sobre um
    // painel, uma borda atrás de um ícone —, não uma sequência.
    const isRow = sorted.every((element, index) => {
      const previous = sorted[index - 1];

      return previous === undefined || previous.rect.offsetMax.x <= element.rect.offsetMin.x;
    });

    if (!isRow) {
      continue;
    }

    const towardsStart = first.rect.anchorMin.x < 0.5;
    const order = towardsStart ? sorted : [...sorted].reverse();

    let gap = 0;

    for (const [index, element] of order.entries()) {
      if (survivors.has(element.id)) {
        move.set(element.id, towardsStart ? -gap : gap);
        continue;
      }

      // O vão que ele deixa é a distância até o vizinho SEGUINTE na
      // mesma direção: essa medida já traz a largura e o respiro
      // juntos, sem o desenho precisar declarar qual é qual — e ela
      // continua certa num cabeçalho editado à mão, onde os
      // espaços não são todos iguais.
      //
      // Quem sai da PONTA não tem ninguém para puxar, e não abre
      // vão nenhum: a fila só ficou mais curta.
      const next = order[index + 1];

      if (next !== undefined) {
        gap += towardsStart
          ? next.rect.offsetMin.x - element.rect.offsetMin.x
          : element.rect.offsetMax.x - next.rect.offsetMax.x;
      }
    }
  }

  if (move.size === 0) {
    return [...kept];
  }

  return kept.map((element) => {
    const delta = move.get(element.id) ?? 0;

    return delta === 0 ? element : shiftX(element, delta);
  });
}
