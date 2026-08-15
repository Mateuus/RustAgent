// ============================================================
//  plugin-push.ts  -  empurrar ESTADO para o plugin, pelo console.
//
//  Dois comandos usam este caminho, e os dois têm o mesmo desenho:
//
//      origemz.vip.sync      quem é VIP, de que nível, até quando
//      origemz.loadout.sync  o que cada grupo recebe ao nascer
//
//  ####  O PAYLOAD É O ESTADO COMPLETO, NUNCA UM DELTA  ####
//
//  O cabeçalho do `OrigemZAgent.cs` diz isso em voz alta, e o
//  código dele faz: `ApplyVipCache` e `ApplyLoadoutCache` montam um
//  dicionário NOVO e trocam o campo inteiro na última linha. Quem
//  sumiu do JSON perde o benefício assim que o comando é aplicado —
//  e é exatamente isso que faz "apaguei o loadout" chegar ao jogo.
//
//  A consequência de desenho: nunca corte o payload. Meio estado é
//  pior que estado nenhum, porque o plugin substitui um cache bom
//  por um incompleto que ele acredita ser completo — jogadores
//  perdendo benefício pago, sem nada no log dizendo por quê.
//  Passou do teto, o envio é RECUSADO inteiro e o cache ANTERIOR
//  continua de pé (velho, mas íntegro).
//
//  ------------------------------------------------------------
//  ####  BASE64 NÃO É CAPRICHO  ####
//
//  MEDIDO no servidor, e documentado no próprio plugin
//  (`DecodeBase64Payload`): o parser de console do Rust trata token
//  entre aspas como argumento citado e COME AS ASPAS. Mandando
//
//      origemz.vip.sync {"players":{"7656…":[{"tier":"gold"}]}}
//
//  o plugin recebe `gold` sem aspas e o parse quebra com
//  "Unexpected character encountered while parsing value: g".
//  Remontar com `string.Join` não desfaz isso — a informação já se
//  perdeu antes de chegar lá.
//
//  Base64 não tem aspa, espaço nem chave: atravessa qualquer parser
//  de console sem perder byte. O custo é 33% a mais de tamanho, que
//  importa pouco perto de a alternativa simplesmente não funcionar.
//
//  ####  E A RESPOSTA PODE VIR MISTURADA COM LOG  ####
//
//  Por isso ela passa por `firstJsonLine` (game/plugin-contract.ts)
//  antes do zod. O plugin ainda adia o `Puts` um frame — sem isso o
//  log sairia ANTES da resposta e seria casado no lugar dela.
// ============================================================

import { z } from 'zod';

import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import { firstJsonLine } from './plugin-contract.js';

/**
 * Teto do comando, em bytes.
 *
 * O WebRCON não negocia tamanho de frame. O que foi MEDIDO
 * atravessando íntegro no projeto anterior é ~70 KB; 50 KB deixa
 * margem para a linha de comando e para o servidor sob carga.
 *
 * Esbarrar nisso não é crescimento normal: um loadout com centenas
 * de itens é erro de digitação na tela, e uma base de VIP que passa
 * daqui pede um protocolo de lote do lado do plugin — que ele não
 * tem. Nos dois casos a resposta certa é recusar com uma frase, e
 * não mandar um comando truncado que o plugin devolve como
 * `INVALID_ARGS` — erro longe da causa.
 */
export const MAX_PUSH_BYTES = 50_000;

/** A resposta de sucesso é sempre `{"ok":true, …}`. */
export const pushOkSchema = z.object({ ok: z.literal(true) }).passthrough();

/** E a de erro, `{"ok":false,"error":"INVALID_ARGS"}`. */
export const pushErrorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

export type PushOutcome =
  /** O plugin recebeu e trocou o cache. */
  | { readonly status: 'sent'; readonly bytes: number; readonly response: Record<string, unknown> }
  /**
   * Sem RCON. NÃO é erro: metade da lista costuma estar parada, e a
   * reconexão repassa o estado inteiro.
   */
  | { readonly status: 'skipped'; readonly reason: string }
  /** Grande demais. Nada foi cortado: nada foi enviado. */
  | { readonly status: 'refused'; readonly bytes: number; readonly limitBytes: number }
  /** Falhou. O plugin fica com o cache anterior. */
  | { readonly status: 'failed'; readonly error: Error };

/**
 * O payload como ele viaja: JSON compacto em base64.
 *
 * Exportada para o teste poder decodificar o comando e conferir o
 * que de fato saiu — é assim que se prova que "apaguei o loadout"
 * chega ao jogo.
 */
export function encodePushPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** O caminho de volta, para o teste e para depurar no console. */
export function decodePushPayload(encoded: string): unknown {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

export function buildPushCommand(command: string, payload: unknown): string {
  return `${command} ${encodePushPayload(payload)}`;
}

/**
 * Monta, mede, manda e confere.
 *
 * NUNCA lança: o desfecho vem no retorno. Quem empurra estado está
 * quase sempre fora do caminho de uma requisição (o relógio, a
 * reconexão do RCON), e uma exceção ali derrubaria a rotina inteira
 * por causa de um servidor que estava reiniciando.
 */
export async function pushState(options: {
  readonly rcon: OpsRcon;
  readonly command: string;
  readonly payload: unknown;
  readonly logger?: Logger | undefined;
  readonly maxBytes?: number;
  /** Para o log dizer por que o comando saiu agora. */
  readonly trigger?: string;
}): Promise<PushOutcome> {
  const limitBytes = options.maxBytes ?? MAX_PUSH_BYTES;

  if (!options.rcon.isConnected) {
    return {
      status: 'skipped',
      reason:
        'o RCON deste servidor está fora do ar. O estado inteiro é reenviado quando ele voltar.',
    };
  }

  const command = buildPushCommand(options.command, options.payload);
  const bytes = Buffer.byteLength(command, 'utf8');

  if (bytes > limitBytes) {
    // ALTO E BOM SOM, e em `error`: isto não se resolve sozinho na
    // próxima rodada. Até alguém agir, o plugin segue com o cache
    // que tinha — e nada do que for concedido a partir de agora
    // chega ao jogo.
    options.logger?.error(
      { command: options.command, bytes, limitBytes, trigger: options.trigger },
      'o payload passou do teto e NÃO foi enviado (nada foi truncado): o plugin fica com o ' +
        'cache anterior. Reduza o que está sendo empurrado.',
    );

    return { status: 'refused', bytes, limitBytes };
  }

  try {
    const raw = await options.rcon.send(command);
    const line = firstJsonLine(raw);

    if (line === null) {
      // Resposta fora do contrato NÃO vira sucesso: um comando que
      // não respondeu como o plugin promete é um comando que talvez
      // nem tenha chegado nele.
      return {
        status: 'failed',
        error: new Error(
          `o servidor respondeu ao ${options.command} sem nenhuma linha de JSON ` +
            `(veio: ${raw.trim().slice(0, 200)}). O plugin está carregado neste servidor?`,
        ),
      };
    }

    const refused = pushErrorSchema.safeParse(line);

    if (refused.success) {
      return {
        status: 'failed',
        error: new Error(`o plugin recusou o ${options.command}: ${refused.data.error}`),
      };
    }

    const accepted = pushOkSchema.safeParse(line);

    if (!accepted.success) {
      return {
        status: 'failed',
        error: new Error(
          `a resposta do ${options.command} não bate com o contrato do plugin: ` +
            JSON.stringify(line).slice(0, 200),
        ),
      };
    }

    options.logger?.debug(
      { command: options.command, bytes, trigger: options.trigger, response: accepted.data },
      'estado empurrado ao plugin',
    );

    return { status: 'sent', bytes, response: accepted.data };
  } catch (error) {
    // Warn, e não error: RCON caindo, timeout e plugin ainda
    // carregando são transitórios, e o próximo gatilho (a
    // reconexão) repassa tudo. O cache anterior continua de pé.
    const err = toError(error);

    options.logger?.warn(
      { command: options.command, err, trigger: options.trigger },
      'não consegui empurrar o estado; o plugin fica com o cache anterior',
    );

    return { status: 'failed', error: err };
  }
}
