// ============================================================
//  streamer-transport.ts  -  o contrato do modo streamer com os
//  plugins.
//
//  MUDAR QUALQUER COISA AQUI EXIGE MUDAR O OrigemZUI.cs JUNTO.
//
//  Três travessias, e cada uma num sentido:
//
//      origemz.streamer.config <base64>   o agente EMPURRA quem
//                                         pode, quem está ligado e
//                                         o que cada um esconde
//      #OZSTREAMER#{"steamId":…}          o plugin AVISA que o
//                                         jogador digitou o comando
//      #OZAREQ#streamer                   o plugin PEDE o estado
//                                         depois de um reload
//
//  ------------------------------------------------------------
//  ####  POR QUE O PLUGIN PRECISA SABER QUEM PODE  ####
//
//  Porque é ele quem atende o `/streamer`. MEDIDO no Oxide deste
//  servidor e documentado em game/chat-commands.ts: uma frase
//  começada por `/` NUNCA chega ao `OnPlayerChat` — ela vira
//  `OnPlayerCommand`. Não há como o agente ver o comando lendo o
//  console; ou o plugin atende, ou ninguém atende.
//
//  E atender exige responder na hora: "modo streamer ligado" ou
//  "você não tem acesso". Perguntar ao agente e esperar deixaria o
//  jogador digitando no vazio — ele está AO VIVO.
//
//  ------------------------------------------------------------
//  ####  O ESTADO É COMPLETO, NUNCA UM DELTA  ####
//
//  Mesma regra do `origemz.vip.sync` (ver game/plugin-push.ts):
//  quem sumiu da lista perde o modo no instante em que o comando
//  é aplicado. É isso que faz "tirei a liberação deste jogador"
//  chegar ao jogo sem um comando de remoção.
//
//  Só os LIBERADOS viajam. Mandar a base inteira de jogadores por
//  causa de meia dúzia de streamers estouraria o teto do frame por
//  nada.
//
//  ------------------------------------------------------------
//  ####  E A DECISÃO FINAL É DO AGENTE  ####
//
//  O plugin alterna o estado na tela na hora (o jogador não pode
//  esperar), mas quem GRAVA é o agente, quando a linha do console
//  chega. Se o agente estiver fora do ar, o plugin já escondeu o
//  overlay e o banco fica para trás — e o reenvio seguinte, que
//  sai a cada reconexão de RCON, devolve a verdade ao plugin.
//
//  O desfecho de uma divergência é sempre o mesmo: vale o banco.
// ============================================================

import { z } from 'zod';

/** O comando de console que empurra o estado ao plugin. */
export const STREAMER_PUSH = 'origemz.streamer.config';

/**
 * O marcador do sentido plugin -> agente.
 *
 * Feio de propósito, como o `#OZADSREQ#` e o `#OZCHATCMD#`: o
 * agente lê o console INTEIRO, e isso inclui o chat dos jogadores.
 */
export const STREAMER_MARKER = '#OZSTREAMER#';

/** O pedido que o plugin grita quando um reload esvazia o cache. */
export const STREAMER_REQUEST = '#OZAREQ#streamer';

// ####  O NOME DO COMANDO NAO VIAJA NESTE CONTRATO  ####
//
// `/streamer` é literal no `[ChatCommand]` do OrigemZUI.cs, e não
// um campo do payload, porque o plugin precisa registrar o comando
// ao CARREGAR — antes de o agente ter empurrado qualquer coisa. Um
// nome vindo daqui faria o comando não existir até a primeira carga
// chegar, e "digitei e não aconteceu nada" é o pior sintoma
// possível para algo que só se usa ao vivo.

/**
 * A âncora das linhas do plugin: o marcador no começo, depois de
 * no máximo dois prefixos entre colchetes (`[OrigemZUI] `).
 *
 * Sem ela, o próprio chat dos jogadores forjaria o aviso — basta
 * alguém digitar o marcador, e a linha aparece no console com o
 * nome dele na frente. Ver o mesmo cuidado em game/chat-commands.ts.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZSTREAMER#/;
const REQUEST_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZAREQ#streamer\b/;

/**
 * Um jogador no payload.
 *
 * Nomes curtos porque este JSON viaja em base64 dentro de um frame
 * de RCON com teto — e porque eles são PROTOCOLO com o `.cs`:
 * mudar um lado sem o outro é o modo parar de funcionar em
 * silêncio.
 */
export interface StreamerPayloadPlayer {
  /** O SteamID. String, sempre: 17 dígitos passam de 2^53. */
  readonly id: string;
  /** Ligado agora? */
  readonly on: boolean;
  readonly logo: boolean;
  readonly ads: boolean;
  readonly chat: boolean;
}

export interface StreamerPayload {
  /**
   * O botão do menu que SÓ os liberados enxergam.
   *
   * O id do elemento no documento (`nav-config`), e `null` quando
   * a aba deve aparecer para todo mundo.
   *
   * ####  A REGRA MORA AQUI, E NAO NO PLUGIN  ####
   *
   * Quem monta o menu é o agente, e é ele que sabe qual botão leva
   * à tela do modo streamer. Um id escrito dentro do `.cs` faria
   * uma decisão de DESENHO viver no lado que só desenha — e o dia
   * em que a aba passasse a servir a todos (uma configuração nova,
   * para qualquer jogador) exigiria recompilar plugin em vez de
   * mandar `null` neste campo.
   */
  readonly tab: string | null;

  /**
   * Quem está liberado. Quem não está aqui não tem o comando.
   *
   * Lista vazia é uma carga legítima: significa "ninguém é
   * streamer neste servidor", e o plugin precisa recebê-la para
   * APAGAR o que sobrou de antes. Parar de mandar deixaria o
   * último estado congelado até o próximo reinício — o mesmo
   * cuidado do `enabled: false` do overlay.
   */
  readonly players: readonly StreamerPayloadPlayer[];
}

/**
 * O aviso que o plugin imprime quando o jogador mexe no modo.
 *
 * ####  ELE LEVA O ESTADO INTEIRO, E NAO O QUE MUDOU  ####
 *
 * Desde que a aba do menu existe, o jogador mexe em quatro coisas:
 * o modo em si e cada um dos três itens. Um aviso que dissesse
 * apenas "mudou o logo" obrigaria o agente a reconstruir o resto a
 * partir do que ele acha que estava valendo — e as duas pontas
 * divergiriam no primeiro clique que se perdesse.
 *
 * Mandando tudo, gravar é substituir. É a mesma escolha do payload
 * de ida (estado completo, nunca delta), e pela mesma razão.
 *
 * Os três itens são OPCIONAIS para o agente continuar entendendo
 * um `.cs` da versão anterior, que só mandava `on`.
 */
const noticeSchema = z.object({
  steamId: z.string().trim().min(1).max(32),
  /** O modo, DEPOIS do toque: `true` = ele acabou de entrar no ar. */
  on: z.boolean(),
  logo: z.boolean().optional(),
  ads: z.boolean().optional(),
  chat: z.boolean().optional(),
  /** O nome, para o log. Ausente em jogador sem nome. */
  name: z.string().trim().max(64).optional(),
});

export interface StreamerNotice {
  readonly steamId: string;
  readonly active: boolean;
  /** `null` = o plugin não disse; o agente mantém o que tem. */
  readonly hideLogo: boolean | null;
  readonly hideAds: boolean | null;
  readonly hideMessages: boolean | null;
  readonly name: string | null;
}

/**
 * A linha vira o aviso, ou `null` quando ela não é um.
 *
 * Recusa em UMA comparação de string no caso comum: isto roda em
 * toda linha do console de todos os servidores.
 */
export function parseStreamerNotice(line: string): StreamerNotice | null {
  if (!line.includes(STREAMER_MARKER) || !PLUGIN_LINE.test(line)) {
    return null;
  }

  const raw = line.slice(line.indexOf(STREAMER_MARKER) + STREAMER_MARKER.length).trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const notice = noticeSchema.safeParse(parsed);

  if (!notice.success) {
    return null;
  }

  return {
    steamId: notice.data.steamId,
    active: notice.data.on,
    hideLogo: notice.data.logo ?? null,
    hideAds: notice.data.ads ?? null,
    hideMessages: notice.data.chat ?? null,
    name: notice.data.name ?? null,
  };
}

/** A linha é o pedido de reenvio do estado? */
export function isStreamerRequest(line: string): boolean {
  return line.includes(STREAMER_REQUEST) && REQUEST_LINE.test(line);
}
