// ============================================================
//  ui-sync.ts  -  levar as interfaces até o jogo.
//
//  Duas metades, e elas funcionam ao contrário uma da outra:
//
//    EMPURRADA  o agente manda a carga inicial (metadados + a tela
//               de entrada) quando algo muda. É o que faz `/menu`
//               abrir sem ida à rede.
//
//    PUXADA     o plugin pede UMA tela quando o jogador navega
//               até ela, e o agente responde. É o que mantém tudo
//               abaixo do teto do RCON.
//
//  O porquê da divisão está em types/ui-transport.ts: o menu
//  inteiro não cabe num frame de WebRCON, e a causa é a forma do
//  CUI — cada tela carrega sua cópia do cabeçalho.
//
//  ------------------------------------------------------------
//  ####  A METADE PUXADA RODA NO STREAM DE LOG  ####
//
//  O pedido do plugin chega como uma linha do console, no mesmo
//  handler que recebe TODA linha do servidor. Duas consequências
//  que mandam no código:
//
//    - nada aqui pode lançar. Uma exceção subiria por um caminho
//      que ninguém trata e levaria junto o processamento do resto
//      do stream;
//    - a resposta é assíncrona e o jogador está com um aviso de
//      carregando na tela. Falha PRECISA virar resposta de erro —
//      silêncio o deixa girando até o timeout do plugin.
//
//  ------------------------------------------------------------
//  ####  O QUE CADA SERVIDOR RECEBE É DIFERENTE  ####
//
//  O documento é da REDE, mas `hidden` é do servidor. Por isso a
//  carga é montada POR SERVIDOR, com a poda já aplicada — ver
//  `applyHidden` em types/ui-document.ts. Mandar o documento cru e
//  deixar o plugin esconder seria pôr a decisão do lado que não
//  tem teste.
// ============================================================

import type { UiDocumentsRepository } from '../db/ui-documents-repository.js';
import type { Logger } from '../logger.js';
import { applyHidden } from '../types/ui-document.js';
import {
  buildUiDocCommand,
  buildUiScreenCommand,
  encodeUiDocPayload,
  encodeUiScreenError,
  encodeUiScreenPayload,
  toDocumentPayload,
  toScreenBundle,
  uiDocRequestSchema,
  uiScreenRequestSchema,
  UI_DOC_MAX_BYTES,
  UI_REQUEST_MARKER,
  type UiDocumentPayload,
} from '../types/ui-transport.js';
import { toError } from '../util.js';
import { buildUiImageCommand, type UiImageAsset } from './ui-images.js';

/** O que o transporte precisa de um RCON. E nada além disso. */
export interface UiSyncRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

/** O que ele precisa saber dos servidores. Mesma escolha da presença. */
export interface UiSyncServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: UiSyncRcon } | null;
}

export type UiSyncTrigger =
  | 'boot'
  | 'rcon-connected'
  | 'documento-salvo'
  | 'documento-removido'
  | 'configuração'
  | 'plugin-pediu'
  | 'periódico'
  | 'manual';

export type UiSyncOutcome =
  /** Nem dava para mandar. Não é erro: servidor parado é normal. */
  | { readonly status: 'skipped'; readonly reason: string }
  /** Mandou. `documents` é quantos foram. */
  | { readonly status: 'sent'; readonly documents: number; readonly bytes: number }
  /** Passou do teto do RCON. Ver `push`. */
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Junta edições em rajada num envio só.
 *
 * Arrastar um elemento no editor grava várias vezes em poucos
 * segundos; sem isto, cada gravação viraria um comando de RCON.
 */
const DEBOUNCE_MS = 250;

/**
 * Rede de segurança periódica.
 *
 * Um `oxide.reload` esvazia o cache do plugin SEM derrubar o RCON
 * — para o agente, nada aconteceu, e ele não reenvia. Sem isto o
 * menu ficaria sumido até a próxima edição. O plugin também pede
 * de volta por conta própria (ver `uiDocRequestSchema`); os dois
 * caminhos existem porque o pedido dele pode sair antes de o
 * agente estar ouvindo.
 */
const PERIODIC_MS = 300_000;

/**
 * O prefixo que o Oxide põe na saída do plugin.
 *
 * ####  ISTO É CONTROLE DE ORIGEM  ####
 *
 * O agente lê o console INTEIRO, e isso inclui o chat dos
 * jogadores. Sem exigir a origem, alguém digitando o marcador no
 * chat forjaria um pedido.
 */
const PLUGIN_PREFIX = '[OrigemZUI]';

export interface UiSyncDeps {
  readonly repository: UiDocumentsRepository;
  readonly servers: UiSyncServers;
  readonly logger: Logger;
  /**
   * As imagens próprias do menu.
   *
   * Vão ANTES dos documentos em cada envio: o plugin precisa ter o
   * CRC guardado quando for desenhar a tela que a usa. Sem isso, o
   * primeiro desenho sai com um quadrado vazio.
   *
   * Reenviadas a cada carga porque o mapa chave->CRC vive na
   * MEMÓRIA do plugin, e um `oxide.reload` o esvazia. Os bytes
   * continuam no FileStorage do servidor — o que se perde é só a
   * tabela.
   */
  readonly images?: readonly UiImageAsset[];
}

export class UiSync {
  readonly #deps: UiSyncDeps;

  /** id do servidor -> o timer de debounce dele. */
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** id do servidor -> há um envio em voo? Um por vez. */
  readonly #running = new Set<string>();

  #periodic: NodeJS.Timeout | null = null;

  constructor(deps: UiSyncDeps) {
    this.#deps = deps;
  }

  /**
   * O relógio da rede de segurança. Ver `PERIODIC_MS`.
   *
   * `unref()` no timer para não segurar o processo vivo, como todo
   * relógio deste projeto.
   */
  start(): void {
    if (this.#periodic !== null) {
      return;
    }

    this.#periodic = setInterval(() => {
      this.pushAllSoon('periódico');
    }, PERIODIC_MS);

    this.#periodic.unref();
  }

  stop(): void {
    if (this.#periodic !== null) {
      clearInterval(this.#periodic);
      this.#periodic = null;
    }

    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
  }

  /** Empurra daqui a pouco, juntando as edições em rajada. */
  pushSoon(serverId: string, trigger: UiSyncTrigger): void {
    if (this.#timers.has(serverId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#timers.delete(serverId);

      void this.push(serverId, trigger).catch((error: unknown) => {
        // Não deveria acontecer: `push` traduz falha em desfecho. O
        // catch existe porque isto roda dentro de um timer, onde
        // uma Promise rejeitada não teria quem a pegasse.
        this.#deps.logger.error({ err: toError(error) }, 'o envio da interface lançou');
      });
    }, DEBOUNCE_MS);

    timer.unref();
    this.#timers.set(serverId, timer);
  }

  /** O mesmo, em todos os servidores. É o que uma edição dispara. */
  pushAllSoon(trigger: UiSyncTrigger): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.pushSoon(serverId, trigger);
    }
  }

  /**
   * Monta e envia a carga inicial daquele servidor. NUNCA lança.
   *
   * ####  RECUSA, NUNCA CORTA  ####
   *
   * Passando do teto, o envio é recusado INTEIRO. Mandar metade
   * dos documentos substituiria um cache bom por um incompleto, e
   * o menu que sumiu não daria erro nenhum — ele simplesmente não
   * abriria.
   */
  async push(serverId: string, trigger: UiSyncTrigger): Promise<UiSyncOutcome> {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null) {
      return { status: 'skipped', reason: `O agente não está cuidando de "${serverId}".` };
    }

    if (!context.rcon.isConnected) {
      return {
        status: 'skipped',
        reason: `O RCON de "${serverId}" está fora do ar. A interface vai quando ele voltar.`,
      };
    }

    if (this.#running.has(serverId)) {
      return { status: 'skipped', reason: 'Já há um envio em andamento para este servidor.' };
    }

    this.#running.add(serverId);

    try {
      const bound = this.#deps.repository.documentsFor(serverId);
      const documents: UiDocumentPayload[] = [];

      for (const { stored, binding } of bound) {
        // A poda é POR SERVIDOR — ver o cabeçalho.
        documents.push(toDocumentPayload(applyHidden(stored.document, binding.hidden)));
      }

      const encoded = encodeUiDocPayload({ documents });

      if (encoded.length > UI_DOC_MAX_BYTES) {
        const reason =
          `A carga da interface tem ${String(encoded.length)} bytes em base64, acima do teto de ` +
          `${String(UI_DOC_MAX_BYTES)} do RCON. Nada foi enviado: meia carga trocaria o menu que ` +
          'está funcionando por um incompleto. Só a tela de ENTRADA viaja aqui — mover conteúdo ' +
          'dela para outras telas é o que faz a carga caber.';

        this.#deps.logger.error(
          { server: serverId, trigger, bytes: encoded.length, limit: UI_DOC_MAX_BYTES },
          'envio da interface recusado: carga acima do teto do RCON',
        );

        return { status: 'refused', reason };
      }

      // As imagens PRIMEIRO — ver `images`. Falhar ao mandar uma
      // não aborta a carga: menu com ícone faltando é melhor que
      // menu nenhum.
      for (const image of this.#deps.images ?? []) {
        try {
          await context.rcon.send(buildUiImageCommand(image));
        } catch (error) {
          this.#deps.logger.warn(
            { server: serverId, key: image.key, err: toError(error) },
            'não consegui mandar uma imagem da interface',
          );
        }
      }

      await context.rcon.send(buildUiDocCommand(encoded));

      // A revisão aplicada só é carimbada DEPOIS de o envio dar
      // certo: ela responde "o que está no jogo", e escrevê-la
      // antes faria a tela dizer que está tudo em dia num servidor
      // que não recebeu nada.
      for (const { stored } of bound) {
        this.#deps.repository.markApplied(serverId, stored.id, stored.revision);
      }

      this.#deps.logger.info(
        { server: serverId, trigger, documents: documents.length, bytes: encoded.length },
        'interface enviada ao servidor',
      );

      return { status: 'sent', documents: documents.length, bytes: encoded.length };
    } catch (error) {
      this.#deps.logger.warn(
        { server: serverId, trigger, err: toError(error) },
        'o envio da interface falhou; a próxima rodada tenta de novo',
      );

      return { status: 'failed', reason: toError(error).message };
    } finally {
      this.#running.delete(serverId);
    }
  }

  // ==========================================================
  //  A METADE PUXADA: o plugin pedindo uma tela.
  // ==========================================================

  /**
   * Uma linha do console daquele servidor. NUNCA lança.
   *
   * Ver o cabeçalho: isto roda dentro do ouvinte que recebe TODA
   * linha do servidor. Uma exceção aqui levaria o stream junto.
   */
  handleLine(serverId: string, line: string): void {
    if (!line.includes(PLUGIN_PREFIX) || !line.includes(UI_REQUEST_MARKER)) {
      return;
    }

    const payload = jsonAfterMarker(line);

    if (payload === null) {
      return;
    }

    // O plugin perdeu o cache e quer tudo de novo. Vem no mesmo
    // marcador porque é o mesmo canal e a mesma origem.
    if (uiDocRequestSchema.safeParse(payload).success) {
      this.#deps.logger.info({ server: serverId }, 'o plugin da interface pediu a carga de volta');
      this.pushSoon(serverId, 'plugin-pediu');
      return;
    }

    const request = uiScreenRequestSchema.safeParse(payload);

    if (!request.success) {
      return;
    }

    // Assíncrono a partir daqui: o ouvinte de log é síncrono e não
    // pode esperar o RCON.
    void this.#serve(serverId, request.data).catch((error: unknown) => {
      this.#deps.logger.warn(
        { server: serverId, err: toError(error) },
        'o atendimento de um pedido de tela lançou',
      );
    });
  }

  async #serve(
    serverId: string,
    request: { readonly requestId: string; readonly documentId: string; readonly screenId: string },
  ): Promise<void> {
    const context = this.#deps.servers.contextOf(serverId);

    const fail = async (reason: string): Promise<void> => {
      // O jogador está com um aviso de carregando na tela. Sem
      // resposta, ele fica lá até o timeout do plugin — por isso o
      // erro é ENVIADO, e não só registrado.
      this.#deps.logger.warn(
        { server: serverId, requestId: request.requestId, screen: request.screenId, reason },
        'pedido de tela recusado',
      );

      if (context !== null && context.rcon.isConnected) {
        await context.rcon.send(
          buildUiScreenCommand(encodeUiScreenError({ requestId: request.requestId, error: reason })),
        );
      }
    };

    // O `documentId` que chega na linha é o `slug`: é ele que o
    // plugin guarda, porque é ele que viaja na carga inicial.
    //
    // ####  O SERVIDOR NÃO VEM DA LINHA  ####
    //
    // Ele vem da CONEXÃO por onde ela chegou. Um campo no JSON
    // seria escrito do outro lado do RCON e chegaria pelo mesmo
    // cano que o chat dos jogadores — um `documentId` de outro
    // servidor seria uma tela servida a pedido de qualquer um.
    const bound = this.#deps.repository
      .documentsFor(serverId)
      .find((entry) => entry.stored.slug === request.documentId);

    if (bound === undefined) {
      await fail('DOCUMENT_NOT_FOUND');
      return;
    }

    const document = applyHidden(bound.stored.document, bound.binding.hidden);
    // Converte AQUI, no agente: o plugin recebe CUI pronto e não
    // sabe nada sobre o modelo — ver game/ui-cui.ts.
    const screen = toScreenBundle(document, request.screenId);

    if (screen === null) {
      await fail('SCREEN_NOT_FOUND');
      return;
    }

    if (context === null || !context.rcon.isConnected) {
      // Sem RCON não há como responder. O plugin tem timeout
      // próprio para este caso.
      this.#deps.logger.warn(
        { server: serverId, requestId: request.requestId },
        'pedido de tela sem RCON para responder',
      );
      return;
    }

    await context.rcon.send(
      buildUiScreenCommand(
        encodeUiScreenPayload({
          requestId: request.requestId,
          documentId: request.documentId,
          screen,
        }),
      ),
    );

    this.#deps.logger.debug(
      { server: serverId, requestId: request.requestId, screen: request.screenId },
      'tela servida',
    );
  }
}

/**
 * O JSON depois do marcador, se houver um.
 *
 * `null` para qualquer linha que não traga um objeto legível —
 * incluindo as que têm o marcador e vieram truncadas.
 */
function jsonAfterMarker(line: string): unknown {
  const at = line.indexOf(UI_REQUEST_MARKER);

  if (at < 0) {
    return null;
  }

  try {
    return JSON.parse(line.slice(at + UI_REQUEST_MARKER.length).trim());
  } catch {
    return null;
  }
}
