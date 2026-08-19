// ============================================================
//  broadcast.ts  -  A ÚNICA MANEIRA DE O SERVIDOR FALAR.
//
//  Aqui está só o CONTRATO. A implementação — o base64, o
//  fallback para `say`, a leitura da resposta do plugin — é da
//  Frente E, e entra neste mesmo arquivo depois (Docs/17,
//  "Frente E"). Ver o desenho no Docs/16 §10, "O transporte".
//
//  ------------------------------------------------------------
//  ####  UMA IMPLEMENTAÇÃO SÓ, E ELA É ESTA  ####
//
//  Três coisas diferentes precisam falar no chat: as mensagens
//  agendadas do admin (Frente E), os avisos de wipe (Frente F) e
//  o anúncio do mundo novo depois que o servidor sobe (Frente D).
//  Se cada uma escrever o seu "mandar texto ao jogo", o servidor
//  passa a ter três formatos de aviso, três jeitos de tratar o
//  RCON caído e três lugares para consertar quando o plugin mudar
//  de comando.
//
//  Por isso o `Broadcaster` é contrato PÚBLICO: ele não muda
//  depois de publicado, e quem precisa falar recebe um por
//  injeção em vez de montar o comando por conta própria.
//
//  ------------------------------------------------------------
//  ####  E ELE NÃO SABE O QUE É UM WIPE  ####
//
//  O transporte leva texto, tag, cor e tamanho. Quem decide o que
//  a frase diz é quem chamou. Um `Broadcaster` que soubesse de
//  wipe amarraria o módulo de mensagens ao de wipe, e as duas
//  frentes deixariam de poder ser construídas em paralelo — que é
//  exatamente o que o Docs/16 §11 proíbe.
// ============================================================

import type { BroadcastInput, BroadcastResult, BroadcastVia } from '../types/messages.js';

export type { BroadcastInput, BroadcastResult, BroadcastVia };

/** Quem sabe fazer o servidor falar no chat do jogo. */
export interface Broadcaster {
  /**
   * Manda a fala, e devolve para quantos ela foi e por onde.
   *
   * ####  O RESULTADO SÓ DESCREVE ENTREGA  ####
   *
   * Não há campo de erro em `BroadcastResult`, e isso é
   * deliberado: não entregou é EXCEÇÃO. Quem chama é que sabe o
   * que fazer com ela, e as duas respostas certas são diferentes
   * — o motor de mensagens não consome o horário (a fala tenta de
   * novo quando o servidor voltar), e o passo `avisar` do wipe
   * segue em frente (avisar é melhor-esforço; apagar não é).
   *
   * Um resultado com `ok: false` faria o caminho fácil ser
   * ignorar a falha, e uma mensagem que nunca sai é justamente a
   * que ninguém percebe.
   */
  send(input: BroadcastInput): Promise<BroadcastResult>;
}
