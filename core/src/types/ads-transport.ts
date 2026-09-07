// ============================================================
//  ads-transport.ts  -  o contrato do overlay com o plugin.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O OrigemZUI.cs JUNTO.
//
//  ------------------------------------------------------------
//  ####  O PLUGIN E UM TOCA-DISCOS  ####
//
//  Ele recebe os quadros já prontos (ver game/ads-timeline.ts) e
//  faz três coisas: espera o instante, troca os lugares
//  reservados da propaganda da vez, e chama AddUi. Não calcula
//  posição, não interpola e não sabe o que é uma propaganda.
//
//  A consequência boa é a mesma do menu: mexer na animação é
//  mexer no agente, e nenhum plugin precisa ser recompilado.
//
//  ------------------------------------------------------------
//  ####  O CICLO E MONTADO AQUI, MENOS A PERMISSAO  ####
//
//  Data, hora, dia da semana e estado da imagem já foram
//  resolvidos pelo agente quando esta carga foi montada — o
//  plugin recebe só o que pode aparecer AGORA.
//
//  A permissão é a exceção, e não dá para ser diferente: ela é
//  por JOGADOR, e o agente monta uma carga só para todos. Por
//  isso ela viaja com cada item e o plugin filtra na hora de
//  desenhar.
// ============================================================

import type { AdsAnimation } from '../game/ads-timeline.js';
import type { CuiElement } from '../game/ui-cui.js';

export const ADS_PLUGIN_COMMANDS = {
  /** `origemz.ads.config <base64>` — a carga inteira. */
  config: 'origemz.ads.config',
  /** `origemz.ads.show [steamId]` — força um ciclo agora. */
  show: 'origemz.ads.show',
  /** `origemz.ads.hide [steamId]` — tira o overlay da tela. */
  hide: 'origemz.ads.hide',
  /** `origemz.ads.test <adId> [steamId]` — só esta propaganda. */
  test: 'origemz.ads.test',
} as const;

/**
 * O marcador do sentido plugin -> agente.
 *
 * Feio de propósito, como o `#OZUIREQ#`: o agente lê o console
 * INTEIRO, e isso inclui o chat dos jogadores. Um prefixo bonito
 * seria ambíguo com o que outro plugin imprime.
 *
 * O estrago de uma linha forjada aqui é pequeno (o agente
 * reenviaria a configuração que ele já reenvia sozinho a cada 5
 * minutos), mas o controle de origem vale para a família inteira
 * de marcadores — ver game/ui-sync.ts.
 */
export const ADS_REQUEST_MARKER = '#OZADSREQ#';

export interface AdsPayloadItem {
  readonly id: string;
  /**
   * O que substitui `{adimage}`.
   *
   * Em `stored` é a CHAVE (o plugin a troca pelo CRC que só ele
   * conhece); em `url`, o endereço, que vai cru para o cliente.
   */
  readonly image: string;
  readonly displayMs: number;
  /** Enquadramento já calculado — ver `imageAnchors`. */
  readonly anchorMin: string;
  readonly anchorMax: string;
  /** Cor de fundo já no formato do CUI ("R G B A"). */
  readonly background: string;
  /** Peso no sorteio do modo aleatório. */
  readonly weight: number;
  /** Quem pode VER esta propaganda. `null` = todo mundo. */
  readonly permission: string | null;
}

export interface AdsPayload {
  /**
   * Desligado NÃO significa payload vazio.
   *
   * O plugin precisa receber `enabled: false` para APAGAR o que
   * está na tela de quem já estava vendo. Simplesmente parar de
   * mandar deixaria o overlay congelado até o próximo reinício.
   */
  readonly enabled: boolean;
  readonly layer: string;
  /** Quem vê o overlay inteiro. `null` = todo mundo. */
  readonly permission: string | null;

  /** Desenhado uma vez, ao ligar para um jogador. */
  readonly root: readonly CuiElement[];

  readonly animations: {
    readonly opening: AdsAnimation;
    readonly adEnter: AdsAnimation;
    readonly adExit: AdsAnimation;
    readonly closing: AdsAnimation;
  };

  readonly cycle: {
    /** Quanto o logo fica sozinho entre um ciclo e o outro. */
    readonly intervalMs: number;
    readonly orderMode: 'sequential' | 'random';
    /** 0 = todas as propagandas da carga. */
    readonly adsPerCycle: number;
  };

  readonly ads: readonly AdsPayloadItem[];

  /** Nome da raiz, para o plugin destruir sem adivinhar. */
  readonly root_name: string;

  /**
   * Quem baixa a imagem.
   *
   * ####  O PLUGIN PRECISA SABER PARA PRE-CARREGAR  ####
   *
   * Em `url`, o CLIENTE busca o endereço — e enquanto busca, ele
   * desenha o quadrado de "carregando" do Rust. Como o elemento
   * da imagem é recriado a cada troca, esse quadrado aparecia no
   * meio de TODA virada de carta.
   *
   * Sabendo o modo, o plugin cria as imagens do ciclo escondidas
   * na abertura: o download acontece atrás do painel que está
   * abrindo, e a troca já encontra a textura pronta.
   */
  readonly imageMode: 'stored' | 'url';

  /**
   * O logo tem lugar próprio?
   *
   * Com ele ligado, o logo NÃO some quando o painel abre: são dois
   * elementos independentes, em lugares diferentes da tela. É o
   * agente que resolve isso nos quadros; o plugin recebe a
   * bandeira só para o diagnóstico do log.
   */
  readonly logoDetached: boolean;

  /**
   * O painel fica parado, com UMA propaganda?
   *
   * ####  ESTE O PLUGIN PRECISA OBEDECER  ####
   *
   * Diferente do `logoDetached`, que ele recebe só para o log:
   * quem decide não agendar ciclo nenhum e desenhar o painel
   * junto com o logo é o PLUGIN. O agente não tem como fazê-lo do
   * lado de cá — a fila de cada jogador depende da permissão
   * dele, que só o outro lado conhece.
   *
   * O que o agente manda continua sendo o mesmo: os quadros das
   * animações. No modo estático o plugin usa só o ÚLTIMO de
   * `opening` e o último de `adEnter` — que são, respectivamente,
   * o painel já aberto e a imagem já dentro dele.
   */
  readonly staticMode: boolean;
}

/** O plugin pedindo a carga de volta depois de um reload. */
export interface AdsRequest {
  readonly want: 'ads';
}

/**
 * Base64 pelo mesmo motivo MEDIDO dos outros syncs: o parser de
 * console do Rust come as aspas de um JSON cru passado como
 * argumento, e o payload chega quebrado antes de o plugin ver.
 */
export function encodeAdsPayload(payload: AdsPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function buildAdsConfigCommand(encoded: string): string {
  return `${ADS_PLUGIN_COMMANDS.config} ${encoded}`;
}
