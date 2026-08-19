// ============================================================
//  announce.ts  -  O LOCUTOR DO WIPE. Um offset vira uma fala.
//
//  É a metade "escrita" da ponte do Docs/16 §11. A metade
//  "leitura" é messages/providers/wipe.ts, e as duas se encontram
//  no `VariableRegistry`: o texto do aviso é um TEMPLATE do admin,
//  e `{wipe.faltam}` dentro dele é resolvido pelo mesmo provedor
//  que atende a mensagem editorial da barra lateral.
//
//  ------------------------------------------------------------
//  ####  O QUE ESTE ARQUIVO NÃO FAZ  ####
//
//  Ele não tem relógio, não escolhe offset, não decide se um aviso
//  já saiu e não sabe se o wipe vai acontecer. Tudo isso é do
//  passo `avisar` de wipe/run.ts, e é de propósito: com o relógio
//  lá, a marca do que já saiu cabe em `wipe_run_steps` — que é o
//  que impede o agente de, ao reiniciar entre dois offsets,
//  reenviar o aviso de 24 h quando faltam dez minutos.
//
//  E ele não monta comando de RCON. O `Broadcaster` (Frente E) é o
//  único caminho até o chat: três maneiras de mandar texto ao jogo
//  dariam três formatos de aviso e três lugares para consertar
//  quando o plugin mudasse de comando (Docs/17 §10).
//
//  ------------------------------------------------------------
//  ####  A FORMATAÇÃO É DO PLUGIN  ####
//
//  O agente manda o TEXTO CRU mais a aparência escolhida na tela —
//  tag, cor da tag, cor do texto, tamanho — e o `OrigemZChat`
//  monta o `<color>` e o `<size>`. Nada aqui concatena a tag no
//  começo da frase nem escreve marcação: formatar dos dois lados
//  criaria duas verdades sobre como um aviso se parece, e a do
//  agente apareceria só no fallback do `say`.
//
//  ------------------------------------------------------------
//  ####  UM AVISO PERDIDO NÃO DERRUBA O WIPE  ####
//
//  Avisar é melhor-esforço; apagar não é. Mas a decisão de seguir
//  em frente é de quem CHAMA, e não daqui: este arquivo deixa a
//  exceção subir, e o passo `avisar` a transforma numa linha de
//  log. Engolir a falha aqui faria "o RCON estava caído" e "o
//  aviso saiu" terem exatamente a mesma aparência no histórico.
// ============================================================

import type { Broadcaster } from '../game/broadcast.js';
import type { Logger } from '../logger.js';
import type { VariableContext } from '../messages/variables.js';
import type { WipeAnnouncer } from './run.js';

/** O recorte do `VariableRegistry` que o locutor usa: só resolver. */
export interface WipeVariableResolver {
  resolve(text: string, context: VariableContext): Promise<string>;
}

export interface WipeAnnouncerDeps {
  /** A ÚNICA maneira de mandar texto ao chat. Ver o cabeçalho. */
  readonly broadcaster: Broadcaster;
  /** Onde `{wipe.faltam}` e `{servidor}` viram texto. */
  readonly variables: WipeVariableResolver;
  readonly logger?: Logger | undefined;
}

/**
 * O locutor de verdade: resolve o template do admin e fala.
 *
 * Sem estado nenhum de propósito — o que precisa sobreviver a um
 * `pm2 restart` está em `wipe_run_steps`, e não na memória deste
 * objeto.
 */
export class WipeBroadcastAnnouncer implements WipeAnnouncer {
  readonly #deps: WipeAnnouncerDeps;

  constructor(deps: WipeAnnouncerDeps) {
    this.#deps = deps;
  }

  async announceOffset(input: Parameters<WipeAnnouncer['announceOffset']>[0]): Promise<void> {
    const { serverId, settings } = input;
    const template = settings.text.trim();

    if (template === '') {
      // Texto em branco é o admin dizendo "não quero fala nenhuma".
      // Mandar um aviso vazio seria pior: o plugin recusaria, o
      // passo registraria um erro, e o histórico acusaria uma falha
      // que ninguém cometeu.
      this.#deps.logger?.debug(
        { server: serverId, offset: input.offsetMinutes },
        'o texto do aviso de wipe está em branco; nada foi dito',
      );

      return;
    }

    // ####  UMA PASSADA SÓ, E ELA É DO REGISTRO  ####
    //
    // `{wipe.faltam}` não é resolvido aqui com o `offsetMinutes`
    // que veio no argumento: ele é resolvido pelo provedor, que lê
    // a execução em curso e faz a MESMA conta que a aba Geral. O
    // offset diz quando falar; quanto falta é uma pergunta ao
    // relógio, e ela tem uma resposta só neste agente.
    const text = await this.#deps.variables.resolve(template, { serverId });

    const result = await this.#deps.broadcaster.send({
      serverId,
      text,
      tag: settings.tag,
      tagColor: settings.tagColor,
      color: settings.color,
      size: settings.size,
    });

    this.#deps.logger?.info(
      {
        server: serverId,
        run: input.runId,
        offset: input.offsetMinutes,
        sent: result.sent,
        via: result.via,
      },
      'aviso de wipe entregue',
    );
  }
}
