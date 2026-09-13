// ============================================================
//  ads.ts  -  O MODELO DAS PROPAGANDAS DO OVERLAY.
//
//  O widget do canto superior direito: um logo que fica balançando
//  de leve e, de tempos em tempos, vira um painel que mostra
//  propagandas e se recolhe de volta.
//
//  Aqui mora só o FORMATO — o que o admin configura e o que a
//  borda HTTP aceita. Quem transforma isso em animação é
//  game/ads-timeline.ts; quem leva ao jogo é game/ads-sync.ts.
//
//  ------------------------------------------------------------
//  ####  O QUE O CUI NAO FAZ, E O QUE FOI POSTO NO LUGAR  ####
//
//  Medido na Oxide.Rust.dll deste servidor (a tabela de strings
//  dos componentes) e confirmado contra o que o cliente aceita:
//
//    rotacao 2D/3D    NAO EXISTE. Nao ha transform em CUI. Onde o
//                     pedido dizia "gira 90 graus", o que existe
//                     e COMPRESSAO HORIZONTAL — a largura vai a
//                     quase zero, a imagem troca, e a largura
//                     volta. E o mesmo que o olho le como carta
//                     virando.
//
//  ------------------------------------------------------------
//  ####  O BALANCO CONTINUO DO LOGO FOI REMOVIDO  ####
//
//  Ele existiu: o logo subia, descia e "respirava" na escala, a 5
//  quadros por segundo. MEDIDO no servidor real, custava FPS no
//  cliente — e nao por causa da rede.
//
//  A causa e o Unity: cada AddUi forca um rebuild do canvas do
//  HUD, e cinco por segundo, para sempre, e um preco alto por um
//  movimento de dois pixels que ninguem repara.
//
//  A licao que fica, e que vale para o proximo enfeite: no CUI,
//  animacao CONTINUA nao e como animacao de transicao. A segunda
//  dura 600 ms e some; a primeira e um custo que nao termina
//  nunca. As animacoes do painel (abrir, trocar, fechar)
//  continuam — elas sao curtas e tem comeco e fim.
//    blur de movimento NAO EXISTE.
//    keyframes         NAO EXISTEM. Toda animacao e uma sequencia
//                     de `update: true` enviada pelo servidor.
//    mascara/recorte   `CuiMaskComponent` existe no Oxide mas NAO
//                     foi encontrado no assembly do servidor, e a
//                     licao do ScrollView (que DESCONECTOU
//                     jogador — ver game/ui-cui.ts) manda nao
//                     apostar. Por isso `cover` aqui PREENCHE sem
//                     recortar, e `contain` usa ancora
//                     proporcional em vez de mascara.
//    sombra            NAO EXISTE. Vira uma moldura de 1px, que e
//                     como o preset do menu ja faz borda.
//
//  O que EXISTE e sustenta o resto: `fadeIn` ao criar, `fadeOut`
//  ao destruir, e a atualizacao de RectTransform/cor no lugar.
// ============================================================

import { z } from 'zod';

/**
 * As camadas do jogo onde o overlay pode ser pendurado.
 *
 * As cinco primeiras são as SEMPRE VISÍVEIS, e são as mesmas de
 * `UI_LAYERS` (types/ui-document.ts). São dois enums porque são
 * dois contratos: um documento de interface e o overlay não mudam
 * juntos.
 *
 * ####  AS TRES ULTIMAS SO EXISTEM COM AQUELA TELA ABERTA  ####
 *
 * `Inventory`, `Crafting` e `Map` são containers que o cliente
 * monta quando o jogador abre a tela correspondente e destrói
 * quando ele a fecha. Pendurar o overlay ali é o jeito de fazer
 * "a propaganda só aparece no inventário" — sem hook nenhum, sem
 * o servidor precisar saber o que o jogador está olhando.
 *
 * `UI_LAYERS` as exclui de propósito, e o comentário de lá explica:
 * um MENU pendurado nelas sumiria quando o jogador fechasse o
 * inventário, "que não é comportamento que alguém queira por
 * engano". Aqui é de propósito, e por isso o enum é outro.
 *
 * ####  ELAS FALHAM EM SILENCIO SE O NOME MUDAR  ####
 *
 * Quem resolve o `parent` é o CLIENTE, por nome, na hierarquia de
 * UI do jogo. O servidor nunca vê esses objetos — nenhum comando
 * de plugin consegue listá-los, e um nome que o Rust renomeie num
 * update não dá erro: o overlay simplesmente não desenha. É por
 * isso que a tela avisa, e é por isso que voltar para `Hud` tem
 * de ser um clique.
 *
 * `Hud.Menu` NÃO é uma delas: apesar do nome, ela continua na
 * tela com o inventário fechado. Medido em 07/09/2026, no jogo.
 */
export const ADS_ALWAYS_LAYERS = ['Overall', 'Overlay', 'Hud.Menu', 'Hud', 'Under'] as const;

/** As que só existem enquanto aquela tela do jogo está aberta. */
export const ADS_SCREEN_LAYERS = ['Inventory', 'Crafting', 'Map'] as const;

export const ADS_LAYERS = [...ADS_ALWAYS_LAYERS, ...ADS_SCREEN_LAYERS] as const;
export type AdsLayer = (typeof ADS_LAYERS)[number];

export const ADS_ANCHORS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;
export type AdsAnchor = (typeof ADS_ANCHORS)[number];

/**
 * Os nove pontos onde o LOGO pode ficar quando é solto do painel.
 *
 * ####  POR QUE O LOGO TEM MAIS OPCOES QUE O PAINEL  ####
 *
 * O painel ABRE: ele cresce para um lado, e crescer a partir do
 * meio da tela não é um movimento que se leia como "um painel
 * abrindo" — é uma caixa aparecendo no meio do jogo. Por isso ele
 * fica nos quatro cantos.
 *
 * O logo só FICA. Ele pode estar em qualquer lugar sem que nada
 * disso se aplique, e "no alto e ao centro" é um pedido comum.
 */
export const ADS_LOGO_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
export type AdsLogoAnchor = (typeof ADS_LOGO_ANCHORS)[number];

export const ADS_ORDER_MODES = ['sequential', 'random'] as const;
export type AdsOrderMode = (typeof ADS_ORDER_MODES)[number];

/**
 * Como a imagem preenche o painel.
 *
 * ####  `cover` AQUI NAO RECORTA  ####
 *
 * Sem mascara no CUI, nao ha como esconder o que passa da borda.
 * Entao `cover` estica a imagem ate preencher o painel inteiro —
 * uma foto com proporcao muito diferente sai deformada. `contain`
 * cabe inteira, com faixas da cor de fundo nas sobras.
 *
 * O nome foi mantido igual ao do CSS de proposito: e o que o
 * admin espera ler. A tela explica a diferenca.
 */
export const ADS_FITS = ['cover', 'contain'] as const;
export type AdsFit = (typeof ADS_FITS)[number];

/**
 * De onde o CLIENTE tira os bytes da imagem.
 *
 *   stored  o agente baixa, valida e manda os bytes ao plugin,
 *           que os guarda no FileStorage do servidor. O cliente
 *           pede pelo canal do jogo. NAO depende de o jogador
 *           alcancar a nossa rede, e e o caminho padrao.
 *   url     o CLIENTE baixa direto do endereco. Sem teto de
 *           tamanho e sem RCON no meio, mas depende de o
 *           endereco ser publico e de o cliente conseguir baixar.
 *
 * Em `stored` a configuracao continua sendo por URL — quem baixa
 * e o agente. Ver game/ads-images.ts.
 */
export const ADS_IMAGE_MODES = ['stored', 'url'] as const;
export type AdsImageMode = (typeof ADS_IMAGE_MODES)[number];

/** Estado do cache de uma imagem, do lado do agente. */
export const ADS_IMAGE_STATUSES = ['pending', 'ready', 'error'] as const;
export type AdsImageStatus = (typeof ADS_IMAGE_STATUSES)[number];

// ------------------------------------------------------------
//  LIMITES
//
//  Interface e dado que o cliente de OUTRA PESSOA vai montar, e
//  imagem e dado que ATRAVESSA o RCON. Os dois pedem teto, e o
//  lugar de recusar e onde o dado entra.
// ------------------------------------------------------------

/**
 * Teto de bytes de uma imagem baixada.
 *
 * 2 MB e o que o pedido pediu, e vale para o modo `url` (em que o
 * peso e problema do cliente). No modo `stored` o teto REAL e
 * outro e bem menor — ver ADS_STORED_MAX_BYTES.
 */
export const ADS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Teto de uma imagem que vai pelo RCON, em bytes de ARQUIVO.
 *
 * ####  DE ONDE SAI ESTE NUMERO  ####
 *
 * O frame do WebRCON aguenta ~50.000 bytes (medido neste
 * projeto). A imagem viaja em base64, que infla 4/3, e cada
 * pedaco leva ainda o nome do comando e a chave.
 *
 * Com 27 KB de arquivo por pedaco (IMAGE_CHUNK_BYTES, em
 * game/image-library.ts), 1,5 MB dá ~57 comandos. Cada um leva
 * alguns milissegundos, e isso acontece UMA vez por imagem — o
 * resultado fica no FileStorage do servidor, e o manifesto do
 * OrigemZImages impede o reenvio.
 *
 * ####  POR QUE ELE SUBIU DE 420 KB  ####
 *
 * Porque 420 KB empurrava quem tem uma propaganda de 900 KB para
 * o modo `url`, e ali o CLIENTE baixa a cada troca — e mostra o
 * quadrado de "carregando" do Rust no meio da animação. O teto
 * apertado, que existia para proteger o RCON, estava piorando o
 * que o jogador vê.
 */
export const ADS_STORED_MAX_BYTES = 1_536 * 1024;

export const ADS_MAX_WIDTH = 1920;
export const ADS_MAX_HEIGHT = 1080;

/**
 * Teto do LOGO, que e outro e bem menor.
 *
 * ####  ELE NUNCA E DESENHADO GRANDE  ####
 *
 * `logoWidth` e `logoHeight` param em 400 (ver o schema mais
 * abaixo), e o padrao e 90x90. Guardar 4048 pixels de largura
 * para pintar 90 custa 25 comandos de RCON no envio e uma
 * textura de dezenas de MB na memoria de video de cada jogador —
 * e nada disso aparece na tela.
 *
 * 512 da nitidez de sobra no maior tamanho possivel, inclusive em
 * tela grande, e cabe num punhado de comandos.
 */
export const ADS_LOGO_MAX_WIDTH = 512;
export const ADS_LOGO_MAX_HEIGHT = 512;

/**
 * Teto do DOWNLOAD, quando a imagem ainda vai ser reduzida.
 *
 * O teto do modo (`ADS_STORED_MAX_BYTES`) vale para o que
 * ATRAVESSA o RCON, e uma imagem grande demais para o duto pode
 * caber nele depois de encolhida — recusa-la antes de tentar
 * seria recusar o que temos como consertar.
 *
 * Este numero existe para o outro lado: o arquivo precisa caber
 * na memoria do agente antes que alguem possa medi-lo.
 */
export const ADS_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024;

/** Propagandas ativas ao mesmo tempo. */
export const ADS_MAX_ACTIVE = 50;

/**
 * Teto do payload que desce ao plugin, em base64.
 *
 * Mesmo numero do UI_DOC_MAX_BYTES, e pelo mesmo motivo: e o
 * mesmo duto. Passando disso o envio e RECUSADO inteiro — meia
 * configuracao deixaria o widget num estado que ninguem desenhou.
 */
export const ADS_PAYLOAD_MAX_BYTES = 50_000;

// ------------------------------------------------------------
//  A PROPAGANDA
// ------------------------------------------------------------

/**
 * Uma propaganda cadastrada.
 *
 * `imageKey`, `imageStatus` e companhia NAO sao configuracao: sao
 * o resultado de o agente ter (ou nao) conseguido baixar a
 * imagem. Ficam no mesmo objeto porque e o que a tela precisa
 * mostrar ao lado do endereco — "essa aqui nao carregou" e a
 * pergunta que o admin faz.
 */
export interface Advertisement {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly imageUrl: string;
  /** Segundos na tela. `null` = usa o padrão do ajuste. */
  readonly displayDuration: number | null;
  /** Ordem no rodízio. Anda de 10 em 10 — ver o repositório. */
  readonly position: number;
  /** Desempata no modo sequencial: maior primeiro. */
  readonly priority: number;
  /** Peso no sorteio do modo aleatório. */
  readonly weight: number;
  readonly fit: AdsFit;
  /** Fundo sob a imagem — aparece nas sobras do `contain`. */
  readonly backgroundColor: string;
  readonly borderColor: string;

  // ----------------------------------------------------------
  //  A JANELA DE EXIBIÇÃO
  //
  //  Tudo opcional, e tudo AND: uma propaganda com data e hora
  //  precisa passar nas duas. Vazio = sem restrição.
  // ----------------------------------------------------------
  /** `YYYY-MM-DD`, no fuso do servidor. */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** `HH:MM`, no fuso do servidor. */
  readonly startTime: string | null;
  readonly endTime: string | null;
  /** 0 = domingo. Vazio = todos os dias. */
  readonly daysOfWeek: readonly number[];
  /** Permissão do Oxide que o jogador precisa ter. */
  readonly permission: string | null;

  // ----------------------------------------------------------
  //  O CACHE DA IMAGEM — resultado, não configuração.
  // ----------------------------------------------------------
  readonly imageStatus: AdsImageStatus;
  /** A chave no FileStorage do servidor, quando `ready`. */
  readonly imageKey: string | null;
  readonly imageBytes: number | null;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  /** Por que falhou, em português, para a tela mostrar. */
  readonly imageError: string | null;
  readonly imageFetchedAt: string | null;

  readonly shownCount: number;
  readonly lastShownAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ------------------------------------------------------------
//  O AJUSTE GERAL
// ------------------------------------------------------------

export interface AdsSettings {
  readonly enabled: boolean;
  /**
   * A camada do jogo.
   *
   * `Hud` de propósito: é a camada que fica visível enquanto se
   * joga e que NÃO recebe clique. `Overlay` também funciona, e
   * aparece por cima de mais coisas.
   */
  readonly layer: string;
  /** Quem VÊ o overlay. `null` = todo mundo. */
  readonly permission: string | null;

  readonly anchor: AdsAnchor;
  readonly marginTop: number;
  readonly marginRight: number;

  // O logo
  readonly logoEnabled: boolean;
  readonly logoImageUrl: string | null;
  readonly logoWidth: number;
  readonly logoHeight: number;
  /** 0 a 1. */
  readonly logoOpacity: number;

  // ----------------------------------------------------------
  //  O LOGO COM LUGAR PRÓPRIO
  //
  //  Desligado, o logo mora no mesmo canto do painel — ele é a
  //  versão recolhida dele. Ligado, ele se solta e ganha âncora e
  //  deslocamento próprios.
  // ----------------------------------------------------------
  readonly logoDetached: boolean;

  /**
   * A camada do LOGO, quando ele tem lugar próprio.
   *
   * ####  ELA EXISTE PARA OS DOIS SE SEPARAREM  ####
   *
   * `null` = herda a do painel, que é o que sempre aconteceu.
   *
   * Com um valor, o logo é pendurado em outro lugar do jogo — e é
   * isso que permite "a marca do servidor sempre na tela, e a
   * propaganda só quando o inventário abre". Sem este campo, pôr
   * o painel em `Hud.Menu` levaria o logo junto.
   *
   * Só vale com `logoDetached` ligado: preso ao painel, o logo é
   * filho dele e não tem camada para chamar de sua.
   */
  readonly logoLayer: AdsLayer | null;
  readonly logoAnchor: AdsLogoAnchor;
  /**
   * Deslocamento horizontal, em pixels.
   *
   * Num canto é a distância até a borda; no CENTRO não há borda
   * de onde medir, e o número vira "tantos pixels para o lado" —
   * inclusive negativo.
   */
  readonly logoMarginX: number;
  readonly logoMarginY: number;
  // O painel
  readonly panelWidth: number;
  readonly panelHeight: number;
  readonly panelColor: string;
  readonly panelBorderColor: string;
  readonly panelBorderEnabled: boolean;

  // O ciclo
  // ----------------------------------------------------------
  //  A PROPAGANDA QUE FICA PARADA
  //
  //  Ligado, o painel é desenhado UMA vez, com UMA propaganda — a
  //  de maior prioridade entre as que aquele jogador pode ver — e
  //  fica. Sem abrir, sem girar, sem fechar: depois do primeiro
  //  desenho, ZERO tráfego.
  //
  //  ####  ISTO NAO E "ONDE APARECE"  ####
  //
  //  Onde é a `layer`, lá em cima: `Hud.Menu` é a camada do
  //  inventário. Os dois são independentes de propósito — dá para
  //  ter um banner fixo sempre na tela, e dá para ter o rodízio
  //  animado só dentro do inventário.
  //
  //  Com ele ligado, `intervalSeconds`, `openingMs`, `closingMs`,
  //  `transitionMs`, `orderMode`, `adsPerCycle` e `animationFps`
  //  param de ter efeito: não há ciclo para medir.
  // ----------------------------------------------------------
  readonly staticMode: boolean;

  /** Quanto tempo o logo fica sozinho entre um ciclo e o outro. */
  readonly intervalSeconds: number;
  readonly defaultDisplayDuration: number;
  readonly openingMs: number;
  readonly closingMs: number;
  readonly transitionMs: number;
  readonly orderMode: AdsOrderMode;
  /** Quantas propagandas por ciclo. 0 = todas as elegíveis. */
  readonly adsPerCycle: number;
  /** Quadros por segundo das transições (abrir, trocar, fechar). */
  readonly animationFps: number;

  readonly imageMode: AdsImageMode;
  readonly updatedAt: string;
}

/** Tudo opcional: a tela salva um campo sem reenviar os outros. */
export type AdsSettingsInput = Partial<Omit<AdsSettings, 'updatedAt'>>;

// ============================================================
//  SCHEMAS DA BORDA HTTP
//
//  Estritos, como o resto da API: campo a mais é 400, e não algo
//  ignorado em silêncio.
// ============================================================

/** Cor em hex `#RRGGBB` ou `#RRGGBBAA`, como no modelo de UI. */
const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i, 'cor precisa ser #RRGGBB ou #RRGGBBAA');

/**
 * O endereço da imagem.
 *
 * ####  SO http(s), E ISSO E SEGURANCA  ####
 *
 * O agente BAIXA este endereço no modo `stored`. Aceitar
 * `file://` deixaria alguém com o token ler arquivo do disco da
 * máquina do servidor pela API — e `ftp://`/`data:` não têm
 * nenhum uso legítimo aqui.
 */
export const adsImageUrlSchema = z
  .string()
  .trim()
  .url('precisa ser uma URL')
  .max(1024)
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'a URL precisa começar com http:// ou https://',
  );

const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24 horas)');

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');

const permissionSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'permissão precisa ser minúscula');

export const adCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    imageUrl: adsImageUrlSchema,
    enabled: z.boolean().optional(),
    displayDuration: z.number().int().min(1).max(120).nullable().optional(),
    position: z.number().int().min(0).max(1_000_000).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    fit: z.enum(ADS_FITS).optional(),
    backgroundColor: colorSchema.optional(),
    borderColor: colorSchema.optional(),
    startDate: dateSchema.nullable().optional(),
    endDate: dateSchema.nullable().optional(),
    startTime: timeSchema.nullable().optional(),
    endTime: timeSchema.nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    permission: permissionSchema.nullable().optional(),
  })
  .strict();

export type AdCreateInput = z.infer<typeof adCreateSchema>;

/** O mesmo, com tudo opcional: o PUT é parcial. */
export const adUpdateSchema = adCreateSchema.partial().strict();

export type AdUpdateInput = z.infer<typeof adUpdateSchema>;

export const adsSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    layer: z.enum(ADS_LAYERS).optional(),
    logoLayer: z.enum(ADS_LAYERS).nullable().optional(),
    permission: permissionSchema.nullable().optional(),

    anchor: z.enum(ADS_ANCHORS).optional(),
    marginTop: z.number().int().min(0).max(400).optional(),
    marginRight: z.number().int().min(0).max(400).optional(),

    logoEnabled: z.boolean().optional(),
    logoImageUrl: adsImageUrlSchema.nullable().optional(),
    logoWidth: z.number().int().min(16).max(400).optional(),
    logoHeight: z.number().int().min(16).max(400).optional(),
    logoOpacity: z.number().min(0).max(1).optional(),
    logoDetached: z.boolean().optional(),
    logoAnchor: z.enum(ADS_LOGO_ANCHORS).optional(),
    // Negativo é legítimo: no centro, o deslocamento vai para os
    // dois lados.
    logoMarginX: z.number().int().min(-640).max(640).optional(),
    logoMarginY: z.number().int().min(-360).max(360).optional(),

    /** Ver `staticMode` na interface: o painel que não gira. */
    staticMode: z.boolean().optional(),

    panelWidth: z.number().int().min(80).max(900).optional(),
    panelHeight: z.number().int().min(40).max(500).optional(),
    panelColor: colorSchema.optional(),
    panelBorderColor: colorSchema.optional(),
    panelBorderEnabled: z.boolean().optional(),

    // ####  QUINZE SEGUNDOS E O PISO, E ELE E BAIXO DE PROPOSITO  ####
    //
    // Quinze segundos é para TESTAR: com ele, quem está ajustando
    // o desenho vê o ciclo inteiro sem ficar esperando cinco
    // minutos por tentativa.
    //
    // Para valer, é agressivo — o painel abre na cara de quem está
    // jogando quatro vezes por minuto, e cada abertura é uma rajada
    // de quadros por jogador. A tela avisa isso ao lado do campo;
    // o número quem escolhe é quem administra.
    //
    // Abaixo de 15 a animação não caberia: abrir, mostrar e fechar
    // já consome mais que isso com os tempos padrão.
    intervalSeconds: z.number().int().min(15).max(86_400).optional(),
    defaultDisplayDuration: z.number().int().min(1).max(120).optional(),
    openingMs: z.number().int().min(100).max(3_000).optional(),
    closingMs: z.number().int().min(100).max(3_000).optional(),
    transitionMs: z.number().int().min(100).max(2_000).optional(),
    orderMode: z.enum(ADS_ORDER_MODES).optional(),
    adsPerCycle: z.number().int().min(0).max(ADS_MAX_ACTIVE).optional(),
    animationFps: z.number().int().min(5).max(30).optional(),

    imageMode: z.enum(ADS_IMAGE_MODES).optional(),
  })
  .strict();

// ============================================================
//  O PACOTE — LEVAR O OVERLAY DE UM SERVIDOR PARA OUTRO
//
//  Montar o overlay é trabalho de tela: dezenas de campos, cores,
//  tempos e uma propaganda por vez. Refazer isso à mão no
//  servidor de produção, depois de já ter acertado tudo no de
//  teste, é repetir o trabalho inteiro — e errar um número no meio
//  não dá erro nenhum, só um desenho diferente.
//
//  Por isso o overlay sai daqui como TEXTO, e entra de volta como
//  texto. Copiar e colar é o transporte, e ele funciona entre duas
//  máquinas que nunca vão se falar: o agente de teste e o de
//  produção não compartilham banco.
//
//  ------------------------------------------------------------
//  ####  O PACOTE LEVA CONFIGURACAO, E SO ELA  ####
//
//  Fica de fora tudo que é RESULTADO e não escolha: `imageKey`,
//  `imageSha`, `imageStatus`, `imageBytes`, `shownCount`,
//  `lastShownAt` e as datas.
//
//  A chave do FileStorage é a razão mais dura: ela é o endereço da
//  imagem DENTRO daquele servidor, e o mesmo número aponta para
//  outra coisa (ou para nada) no servidor vizinho. Colar uma chave
//  de fora faria o plugin desenhar a imagem errada — e, pior, sem
//  erro nenhum, porque para ele a chave é válida.
//
//  O que atravessa é a `imageUrl`. O agente do outro lado baixa por
//  conta própria, como faz com qualquer propaganda nova, e a chave
//  nasce lá.
//
//  ####  O `id` TAMBEM NAO VIAJA  ####
//
//  Ele é `randomUUID()` local. Preservá-lo faria o import de um
//  pacote sobre ele mesmo colidir por chave primária, e não
//  resolve nada: ninguém procura propaganda por id.
// ============================================================

/** O que o pacote diz de si mesmo, para a recusa ser específica. */
export const ADS_PACKAGE_KIND = 'origemz.ads';

/**
 * A versão do FORMATO do pacote, e não a do agente.
 *
 * Ela sobe quando um campo muda de significado — não quando um
 * campo novo aparece, porque campo novo já é tratado: o schema
 * preenche o que falta com o padrão.
 */
export const ADS_PACKAGE_VERSION = 1;

/**
 * Uma propaganda dentro do pacote.
 *
 * É o `adCreateSchema` sem o `position`: a ordem do rodízio vem da
 * ORDEM DA LISTA, que é o que a pessoa vê ao abrir o JSON. Deixar
 * os dois seria deixar duas verdades sobre a mesma coisa, e a
 * pergunta "qual vale?" não tem resposta boa.
 */
export const adsPackageAdSchema = adCreateSchema.omit({ position: true });

export const adsPackageSchema = z
  .object({
    kind: z.literal(ADS_PACKAGE_KIND),
    version: z.number().int().min(1).max(ADS_PACKAGE_VERSION),
    /**
     * De onde ele saiu. Só para quem lê o arquivo se situar — o
     * import não confere, porque o destino é justamente outro.
     */
    exportedFrom: z.string().max(64).optional(),
    exportedAt: z.string().max(40).optional(),
    settings: adsSettingsSchema,
    ads: z.array(adsPackageAdSchema).max(ADS_MAX_ACTIVE * 4),
  })
  .strict();

export type AdsPackage = z.infer<typeof adsPackageSchema>;

/**
 * Os dois modos de colar, e a diferença entre eles é destrutiva.
 *
 * `replace` apaga as propagandas que já estavam ali e põe as do
 * pacote no lugar — é o que faz o destino ficar IGUAL à origem, e
 * é o motivo de existir.
 *
 * `append` acrescenta as do pacote ao fim da lista e não toca no
 * ajuste geral. Serve para levar uma campanha de um servidor a
 * outro sem mexer no desenho do overlay que já roda lá.
 */
export const ADS_IMPORT_MODES = ['replace', 'append'] as const;
export type AdsImportMode = (typeof ADS_IMPORT_MODES)[number];

/**
 * O corpo do POST.
 *
 * `mode` é OBRIGATORIO, sem padrão, e isso é de propósito: o modo
 * que apaga não pode ser o que acontece quando alguém esquece de
 * escolher.
 */
export const adsImportSchema = z
  .object({
    mode: z.enum(ADS_IMPORT_MODES),
    package: adsPackageSchema,
  })
  .strict();

export type AdsImportInput = z.infer<typeof adsImportSchema>;

// ============================================================
//  A JANELA DE EXIBIÇÃO
//
//  Fica aqui, e não no repositório, porque as duas pontas
//  precisam: o agente para escolher o que entra no ciclo, e a
//  tela para dizer "essa está fora do horário agora".
// ============================================================

/**
 * A propaganda pode aparecer NESTE instante?
 *
 * Só olha o calendário — `enabled` e o estado da imagem são
 * checados por quem chama, porque as respostas são diferentes:
 * "desligada" é escolha do admin, "fora do horário" é temporário
 * e "imagem quebrada" é defeito.
 *
 * `date` é a hora local do servidor de propósito: quem escreve
 * "das 20h às 23h" quer o relógio da parede, não UTC.
 */
export function isWithinSchedule(ad: Advertisement, date: Date = new Date()): boolean {
  const day = date.getDay();

  if (ad.daysOfWeek.length > 0 && !ad.daysOfWeek.includes(day)) {
    return false;
  }

  const today = localDate(date);

  if (ad.startDate !== null && today < ad.startDate) {
    return false;
  }

  if (ad.endDate !== null && today > ad.endDate) {
    return false;
  }

  if (ad.startTime === null && ad.endTime === null) {
    return true;
  }

  const now = localTime(date);
  const from = ad.startTime ?? '00:00';
  const to = ad.endTime ?? '23:59';

  // ####  A JANELA PODE VIRAR A MEIA-NOITE  ####
  //
  // "das 22:00 às 02:00" é um pedido normal, e com a comparação
  // ingênua (from <= now && now <= to) ela nunca seria verdadeira
  // — o admin escreveria o horário certo e a propaganda não
  // apareceria nunca, sem nada dizer por quê.
  return from <= to ? now >= from && now <= to : now >= from || now <= to;
}

function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A propaganda está pronta para entrar no ciclo?
 *
 * `imageMode` importa: em `url` o cliente baixa sozinho e o cache
 * do agente é irrelevante; em `stored`, sem chave não há o que
 * desenhar.
 */
export function isPlayable(ad: Advertisement, imageMode: AdsImageMode): boolean {
  if (!ad.enabled) {
    return false;
  }

  return imageMode === 'url' ? true : ad.imageStatus === 'ready' && ad.imageKey !== null;
}
