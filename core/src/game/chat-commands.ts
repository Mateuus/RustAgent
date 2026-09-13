// ============================================================
//  chat-commands.ts  -  o contrato do `/pop`.
//
//  Duas metades, e as duas atravessam a fronteira com o plugin:
//
//      origemz.chat.commands <base64>   o agente EMPURRA a lista
//      #OZCHATCMD#{"cmd":"pop",…}       o plugin AVISA quem digitou
//
//  ------------------------------------------------------------
//  ####  POR QUE O PLUGIN PRECISA DA LISTA  ####
//
//  MEDIDO no Oxide deste servidor (Oxide.Rust.dll,
//  `RustCore.IOnPlayerChat`): uma frase começada por `/` NUNCA
//  chega ao `OnPlayerChat`. Ela vira `OnPlayerCommand`, e se
//  ninguém a trata o Oxide responde "Unknown command: pop" ao
//  jogador. Ou seja: não há como o agente descobrir o comando
//  lendo o chat do console — a linha não existe.
//
//  Então o plugin intercepta. E para interceptar SÓ o que é nosso,
//  ele precisa saber quais comandos o admin cadastrou — daí a
//  lista empurrada. Um plugin que engolisse todo comando quebraria
//  o `/kit`, o `/remove` e o resto do servidor.
//
//  ------------------------------------------------------------
//  ####  A RESPOSTA É DO AGENTE, E NÃO DO PLUGIN  ####
//
//  O plugin não sabe o texto. Ele não poderia saber: `{online}`,
//  `{max}` e `{wipe.faltam}` são resolvidos no agente, no instante
//  do envio, por provedores registrados (messages/variables.ts).
//  Mandar o texto pronto ao plugin faria `/pop` responder a
//  lotação de quando a lista foi empurrada.
//
//  O caminho é: o plugin avisa, o agente resolve e fala pelo mesmo
//  `Broadcaster` de sempre, dirigido ao jogador que digitou.
//
//  ------------------------------------------------------------
//  ####  E O AVISO É UMA LINHA DE CONSOLE  ####
//
//  Mesmo cano do `#OZSTAT#`, do `#OZQUEST#` e do `#OZDUNGEON#`: o
//  plugin imprime, o `onConsoleLine` recebe. A âncora é a mesma —
//  o marcador no COMEÇO da linha, depois de no máximo dois
//  prefixos entre colchetes (`[OrigemZChat] `). Sem essa âncora, o
//  próprio chat dos jogadores poderia forjar o marcador: basta
//  alguém digitar o texto dele no chat para a linha aparecer no
//  console com o nome do jogador na frente.
// ============================================================

import { z } from 'zod';

/** O comando de console que empurra a lista ao plugin. */
export const CHAT_COMMANDS_PUSH = 'origemz.chat.commands';

/** O marcador do aviso que o plugin imprime. */
export const CHAT_COMMAND_MARKER = '#OZCHATCMD#';

/**
 * O pedido que o plugin grita quando um `oxide.reload` esvazia o
 * cache dele. Mesmo desenho do `#OZAREQ#items`.
 */
export const CHAT_COMMANDS_REQUEST = '#OZAREQ#chatcommands';

/**
 * A âncora: o marcador no começo da linha, depois de no máximo
 * dois prefixos entre colchetes. Ver o cabeçalho.
 */
const PLUGIN_LINE = /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZCHATCMD#/;

/**
 * Quem digitou o quê.
 *
 * Os nomes são PROTOCOLO com o `.cs`: mudar um lado sem o outro é
 * o comando parar de responder, em silêncio.
 */
const noticeSchema = z.object({
  /** O comando digitado, sem barra. */
  cmd: z.string().trim().min(1).max(32),
  /** Quem digitou. */
  steamId: z.string().trim().min(1).max(32),
  /** O nome dele, para o log. Ausente em jogador sem nome. */
  name: z.string().trim().max(64).optional(),
});

/** Um jogador digitou um comando cadastrado. */
export interface ChatCommandNotice {
  readonly command: string;
  readonly steamId: string;
  readonly name: string | null;
}

/**
 * A linha vira o aviso, ou `null` quando ela não é um.
 *
 * Recusa em UMA comparação de string no caso comum: este código
 * roda em toda linha do console de todos os servidores, centenas
 * por minuto num servidor cheio.
 */
export function parseChatCommandNotice(line: string): ChatCommandNotice | null {
  if (!line.includes(CHAT_COMMAND_MARKER) || !PLUGIN_LINE.test(line)) {
    return null;
  }

  const raw = line.slice(line.indexOf(CHAT_COMMAND_MARKER) + CHAT_COMMAND_MARKER.length).trim();

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
    // Minúsculas e sem barra, como o banco grava. O plugin já manda
    // assim; normalizar de novo aqui é barato e fecha a porta para
    // um plugin antigo que não normalizasse.
    command: notice.data.cmd.replace(/^[/\\]+/, '').toLowerCase(),
    steamId: notice.data.steamId,
    name: notice.data.name ?? null,
  };
}

/** A linha é o pedido de reenvio da lista? */
export function isChatCommandsRequest(line: string): boolean {
  return (
    line.includes(CHAT_COMMANDS_REQUEST) &&
    /^(?:\[[^\]\r\n]{1,60}\]\s*){0,2}#OZAREQ#chatcommands/.test(line)
  );
}

/**
 * O payload do `origemz.chat.commands`.
 *
 * ESTADO COMPLETO, nunca um delta — a mesma regra do
 * game/plugin-push.ts. O plugin troca o conjunto inteiro, e é
 * assim que "apaguei a mensagem" chega ao jogo: o comando some da
 * lista e volta a ser desconhecido.
 */
export interface ChatCommandsPayload {
  readonly commands: readonly string[];
}
