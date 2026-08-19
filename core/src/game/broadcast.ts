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
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import { firstJsonLine } from './plugin-contract.js';

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

// ============================================================
//  A IMPLEMENTAÇÃO  (Frente E)
//
//  Daqui para baixo é o que faz a fala chegar ao chat. A interface
//  acima não mudou, e não muda: as Frentes D e F compilam contra
//  ela.
//
//  ------------------------------------------------------------
//  ####  DOIS CAMINHOS, E O SEGUNDO É PIOR DE PROPÓSITO  ####
//
//      plugin  origemz.chat.broadcast <base64>  ->  {"ok":true,"sent":N}
//      say     say "<texto sem cor>"            ->  sent desconhecido
//
//  O `say` existe porque nem todo servidor terá o `OrigemZChat`
//  carregado, e uma mensagem sem cor é melhor que silêncio. O `via`
//  da resposta diz qual dos dois foi usado — sem ele, o `sent: 0`
//  do `say` pareceria "não chegou a ninguém".
//
//  ------------------------------------------------------------
//  ####  BASE64 NÃO É ENFEITE  ####
//
//  MEDIDO neste ecossistema e documentado no próprio plugin
//  (`DecodeBase64`, em Plugins/OrigemZChat.cs): o parser de console
//  do Rust trata token entre aspas como argumento citado e COME AS
//  ASPAS. Mandando
//
//      origemz.chat.broadcast {"text":"oi"}
//
//  o plugin recebe o JSON sem as aspas e o parse quebra. Remontar
//  com `string.Join` não desfaz isso: a informação se perdeu antes
//  de chegar lá. Base64 não tem aspa, espaço nem chave.
//
//  ------------------------------------------------------------
//  ####  A FALA DIRIGIDA NÃO CAI NO `say`  ####
//
//  Com `steamId`, a fala é para UM jogador ("sua compra caiu", "seu
//  VIP vence amanhã"). O `say` do jogo não sabe endereçar: o
//  fallback transformaria um recado privado num anúncio para o
//  servidor inteiro. Sem o plugin, essa fala FALHA — e falhar é o
//  desfecho certo, porque quem chamou pode tentar de novo.
// ============================================================

/** O comando do `OrigemZChat`. Uma constante, e não texto solto. */
export const CHAT_BROADCAST_COMMAND = 'origemz.chat.broadcast';

/** O que o transporte precisa saber dos servidores. */
export interface BroadcastServers {
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface PluginBroadcasterDeps {
  readonly servers: BroadcastServers;
  readonly logger?: Logger | undefined;
}

/**
 * O payload do `origemz.chat.broadcast`, no formato do
 * `BroadcastPayload` do plugin.
 *
 * Os nomes são em inglês e minúsculos porque este é um PROTOCOLO
 * com o plugin — mudar um deles aqui exige mudar o `.cs` junto.
 */
interface ChatBroadcastPayload {
  readonly text: string;
  readonly tag: string;
  readonly tagColor: string;
  readonly color: string;
  readonly size: number;
  readonly steamId: string;
}

/**
 * O `Broadcaster` de verdade: plugin, com fallback para `say`.
 *
 * ####  ELE LANÇA, E ISSO É O CONTRATO  ####
 *
 * `BroadcastResult` não tem campo de erro (ver a interface acima).
 * Não entregou é exceção, porque as duas respostas certas são
 * diferentes: o motor de mensagens NÃO consome o horário (a fala
 * tenta de novo quando o servidor voltar) e o passo `avisar` do
 * wipe segue em frente (avisar é melhor-esforço; apagar não é).
 */
export class PluginBroadcaster implements Broadcaster {
  readonly #deps: PluginBroadcasterDeps;

  constructor(deps: PluginBroadcasterDeps) {
    this.#deps = deps;
  }

  async send(input: BroadcastInput): Promise<BroadcastResult> {
    const text = input.text.trim();

    if (text === '') {
      throw new ApiError(
        'BROADCAST_EMPTY',
        'A fala está vazia. O jogo não mostra nada, e o plugin recusaria o comando.',
        400,
      );
    }

    const rcon = this.#deps.servers.contextOf(input.serverId)?.rcon ?? null;

    if (rcon === null || !rcon.isConnected) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `Sem conexão com o RCON do servidor "${input.serverId}": ele está fora do ar ou ainda ` +
          'subindo. Nada foi dito no chat.',
        503,
      );
    }

    const viaPlugin = await this.#sendByPlugin(rcon, input, text);

    if (viaPlugin !== null) {
      return viaPlugin;
    }

    return this.#sendBySay(rcon, input, text);
  }

  /**
   * O caminho bom. `null` = o plugin não respondeu como promete, e
   * quem chamou deve tentar o `say`.
   *
   * Repare que uma resposta FORA DO CONTRATO não vira sucesso: um
   * comando que não respondeu `{"ok":true,…}` é um comando que
   * talvez nem tenha chegado ao plugin.
   */
  async #sendByPlugin(
    rcon: OpsRcon,
    input: BroadcastInput,
    text: string,
  ): Promise<BroadcastResult | null> {
    const payload: ChatBroadcastPayload = {
      text,
      tag: input.tag ?? '',
      tagColor: input.tagColor ?? '',
      color: input.color ?? '',
      // Zero = "o padrão do plugin". Ele trata `Size > 0` como
      // escolha e o resto como ausência — mandar 15 daqui seria uma
      // segunda opinião sobre o padrão dele.
      size: input.size ?? 0,
      steamId: input.steamId ?? '',
    };

    const command = `${CHAT_BROADCAST_COMMAND} ${encodeBroadcastPayload(payload)}`;

    let raw: string;

    try {
      raw = await rcon.send(command);
    } catch (error) {
      this.#deps.logger?.warn(
        { server: input.serverId, err: toError(error) },
        'o comando de chat do plugin falhou; tentando o say do jogo',
      );

      return null;
    }

    const line = firstJsonLine(raw);

    if (line === null || typeof line !== 'object') {
      // Plugin não carregado: o console devolve o eco do comando
      // desconhecido, e não JSON. É o caso mais comum do fallback.
      return null;
    }

    const answer = line as { ok?: unknown; sent?: unknown; error?: unknown };

    if (answer.ok !== true) {
      this.#deps.logger?.warn(
        { server: input.serverId, error: answer.error },
        'o OrigemZChat recusou a fala; tentando o say do jogo',
      );

      return null;
    }

    return { sent: typeof answer.sent === 'number' ? answer.sent : 0, via: 'plugin' };
  }

  /**
   * O caminho pobre: o `say` do próprio jogo, sem cor nenhuma.
   *
   * O texto passa por uma faxina antes: aspas quebram o `say` do
   * Rust no meio, e `<color>` deixaria qualquer integração se passar
   * por mensagem de admin. A mesma regra do `#say` de
   * ops/service.ts — e ela vale mais aqui, porque este texto vem de
   * um formulário.
   */
  async #sendBySay(rcon: OpsRcon, input: BroadcastInput, text: string): Promise<BroadcastResult> {
    if (input.steamId !== undefined && input.steamId !== '') {
      throw new ApiError(
        'CHAT_PLUGIN_UNAVAILABLE',
        `O plugin OrigemZChat não respondeu em "${input.serverId}", e esta fala é dirigida a um ` +
          'jogador só. O say do jogo falaria para o servidor inteiro, então nada foi dito. ' +
          'Carregue o OrigemZChat neste servidor.',
        503,
      );
    }

    const tag = (input.tag ?? '').trim();
    const clean = sanitizeForSay(tag === '' ? text : `${tag} ${text}`);

    if (clean === '') {
      throw new ApiError(
        'BROADCAST_EMPTY',
        'Depois de tirar aspas e marcação, não sobrou texto para o say do jogo.',
        400,
      );
    }

    try {
      await rcon.send(`say "${clean}"`);
    } catch (error) {
      throw new ApiError(
        'BROADCAST_FAILED',
        `Não deu para falar no chat de "${input.serverId}": ${toError(error).message}`,
        502,
      );
    }

    this.#deps.logger?.debug(
      { server: input.serverId },
      'fala entregue pelo say do jogo (sem cor): o OrigemZChat não respondeu',
    );

    // Zero aqui quer dizer DESCONHECIDO, e é o `via` que avisa: o
    // jogo não devolve quantos receberam. Inventar um palpite faria
    // o log afirmar uma coisa que ninguém mediu.
    return { sent: 0, via: 'say' };
  }
}

/**
 * O payload como ele viaja: JSON compacto em base64.
 *
 * Exportada para o teste poder decodificar o comando e conferir o
 * que de fato saiu — é assim que se prova que a cor escolhida na
 * tela chegou ao jogo.
 */
export function encodeBroadcastPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** O caminho de volta, para o teste e para depurar no console. */
export function decodeBroadcastPayload(encoded: string): unknown {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

/** Tira o que quebra o `say` e o que forjaria marcação. */
export function sanitizeForSay(text: string): string {
  return text
    .replace(/["<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
