// ============================================================
//  ads-sync.ts  -  levar as propagandas até o jogo.
//
//  Três trabalhos, na ordem em que precisam acontecer:
//
//    1. CACHE   baixar as imagens que ainda não foram baixadas,
//               conferir formato e tamanho, e gravar o resultado
//               na propaganda (inclusive o erro, que a tela
//               mostra);
//    2. BYTES   garantir que o OrigemZImages tem as imagens da
//               vez — ver game/image-library.ts;
//    3. CARGA   mandar a configuração: os quadros da animação e
//               a lista do ciclo já resolvida.
//
//  A ordem importa: uma carga que chega antes dos bytes desenha
//  um retângulo vazio no lugar da propaganda. É a mesma razão
//  pela qual as imagens do menu vão antes dos documentos (ver
//  game/ui-sync.ts).
//
//  ------------------------------------------------------------
//  ####  UM SERVICO, N SERVIDORES  ####
//
//  No agente antigo era uma instância por servidor, criada dentro
//  do contexto dele. Aqui o contexto de servidor guarda config,
//  RCON e operações, e nada mais — quem fala com o jogo é um
//  serviço só, que recebe o `serverId` em cada chamada. É o
//  desenho do `UiSync`, e segui-lo é o que faz o `index.ts` ter
//  um lugar só para ligar console e reconexão.
//
//  O ESTADO, porém, continua sendo por servidor: última carga e
//  cache de imagem moram num `#stateOf(serverId)`. O que cada
//  plugin JÁ TEM não mora aqui — quem responde isso é o manifesto
//  do OrigemZImages daquele servidor, perguntado a cada envio.
//
//  ------------------------------------------------------------
//  ####  ELE NUNCA LANCA  ####
//
//  Roda em timer e em handler de linha de console. Uma exceção
//  sem dono mataria o laço, e as propagandas parariam em
//  silêncio — o pior desfecho para algo cuja única evidência de
//  funcionamento é aparecer na tela de outra pessoa.
// ============================================================

import type { AdsRepository } from '../db/ads-repository.js';
import type { Logger } from '../logger.js';
import { toError } from '../util.js';
import {
  ADS_IMAGE_MAX_BYTES,
  ADS_LOGO_MAX_HEIGHT,
  ADS_LOGO_MAX_WIDTH,
  ADS_PAYLOAD_MAX_BYTES,
  ADS_STORED_MAX_BYTES,
  isPlayable,
  isWithinSchedule,
  type Advertisement,
  type AdsSettings,
} from '../types/ads.js';
import {
  ADS_REQUEST_MARKER,
  buildAdsConfigCommand,
  encodeAdsPayload,
  type AdsPayload,
  type AdsPayloadItem,
} from '../types/ads-transport.js';
import { AdImageError, fetchAdImage } from './ads-images.js';
import { ADS_ROOT, adBackground, buildTimeline, imageAnchors } from './ads-timeline.js';
import { IMAGE_FAMILIES, ImageLibrary, sha256Hex, type ImageAsset } from './image-library.js';

/** O que o transporte precisa de um RCON. E nada além disso. */
export interface AdsSyncRcon {
  readonly isConnected: boolean;
  send(command: string): Promise<string>;
}

/** O que ele precisa saber dos servidores. Mesma escolha do `UiSync`. */
export interface AdsSyncServers {
  ids(): readonly string[];
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: AdsSyncRcon } | null;
}

export type AdsSyncTrigger =
  | 'startup'
  | 'rcon-connected'
  | 'ads-saved'
  | 'ads-imported'
  | 'settings-saved'
  | 'plugin-requested'
  | 'periodic'
  | 'manual';

export type AdsSyncOutcome =
  | { readonly status: 'sent'; readonly ads: number; readonly bytes: number }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: Error };

export interface AdsSyncDeps {
  readonly ads: AdsRepository;
  readonly servers: AdsSyncServers;
  readonly logger?: Logger | undefined;
  /** Injetável no teste. */
  readonly now?: () => number;
  /** Injetável no teste — o `fetch` global por padrão. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Quem leva os bytes ao jogo.
   *
   * O `index.ts` passa a MESMA instância do menu e dos itens: é ela
   * que enfileira os envios por servidor, e duas instâncias poderiam
   * mandar a mesma chave ao mesmo tempo. Ausente = uma própria, que
   * é o que os testes usam.
   */
  readonly images?: ImageLibrary;
}

/** Junta edições em rajada num envio só. */
const DEBOUNCE_MS = 400;

/**
 * Rede de segurança periódica, e mais do que isso.
 *
 * Além de cobrir o `oxide.reload` (que esvazia o cache do plugin
 * SEM derrubar o RCON), é este relógio que faz o AGENDAMENTO
 * andar: uma propaganda que começa às 20h entra na carga na
 * primeira volta depois das 20h. Daí o intervalo curto — cinco
 * minutos é o atraso máximo entre a janela abrir e a propaganda
 * aparecer.
 */
const PERIODIC_MS = 300_000;

/**
 * O prefixo que o Oxide põe na saída do plugin.
 *
 * ####  ISTO E CONTROLE DE ORIGEM  ####
 *
 * O agente lê o console INTEIRO, e isso inclui o chat dos
 * jogadores. Sem exigir a origem, alguém digitando o marcador no
 * chat forjaria o pedido. Ver game/ui-sync.ts.
 */
const PLUGIN_PREFIX = '[OrigemZUI]';

/**
 * O que cada servidor carrega entre um envio e o outro.
 *
 * ####  "O QUE O PLUGIN JÁ TEM" NÃO MORA AQUI  ####
 *
 * Morava: um `sentImages` que espelhava, de memória, o mapa do
 * plugin — e que errava nos dois sentidos. Um `oxide.reload` o
 * deixava achando que o plugin tinha o que perdeu; um reinício do
 * agente o deixava achando que o plugin não tinha nada, e tudo era
 * rebaixado e reenviado. Quem responde agora é o manifesto do
 * OrigemZImages, perguntado a cada envio.
 *
 * O preço que ficou é conhecido: dois servidores com a mesma
 * imagem a baixam uma vez cada.
 */
interface ServerAdsState {
  /**
   * A ultima carga enviada, em base64.
   *
   * E o que impede o reenvio periodico de reiniciar o relogio do
   * ciclo do lado do plugin — ver o comentario em `push`.
   */
  lastPayload: string | null;

  /**
   * Os bytes baixados, por chave.
   *
   * ####  POR QUE NAO GRAVAR EM DISCO  ####
   *
   * Porque o dono dos bytes é o servidor de Rust: depois do
   * `FileStorage.Store`, o PNG vive lá e o cliente o pede por
   * CRC. O que este mapa evita é rebaixar a mesma URL quando o
   * plugin reinicia — e para isso a memória do processo basta.
   *
   * Perder o mapa (reinício do agente) custa um download por
   * imagem, uma vez.
   */
  cache: Map<string, Buffer>;

  /** URL do logo -> a chave dele. Uma entrada, na prática. */
  logoCache: Map<string, string>;
}

export class AdsSync {
  readonly #deps: AdsSyncDeps;
  readonly #now: () => number;
  readonly #images: ImageLibrary;

  /** id do servidor -> o estado dele. Ver `ServerAdsState`. */
  readonly #states = new Map<string, ServerAdsState>();

  /** id do servidor -> o timer de debounce dele. */
  readonly #timers = new Map<string, NodeJS.Timeout>();

  /** id do servidor -> há um envio em voo? Um por vez. */
  readonly #running = new Set<string>();

  /**
   * O motivo do envio que está esperando o debounce.
   *
   * Guardado por servidor porque `rcon-connected` e
   * `plugin-requested` FORÇAM o reenvio (ver o dedup em `push`), e
   * perder esse motivo para um `periodic` que chegou junto faria a
   * carga ser engolida logo depois de o outro lado perder tudo.
   */
  readonly #pending = new Map<string, AdsSyncTrigger>();

  #periodic: NodeJS.Timeout | null = null;

  constructor(deps: AdsSyncDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#images = deps.images ?? new ImageLibrary({ logger: deps.logger });
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
      this.pushAllSoon('periodic');
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
    this.#pending.clear();
  }

  /** Empurra daqui a pouco, juntando as edições em rajada. */
  pushSoon(serverId: string, trigger: AdsSyncTrigger): void {
    // O motivo mais forte vence: um `periodic` que chega no meio do
    // debounce não pode apagar o `rcon-connected` que o abriu.
    const pending = this.#pending.get(serverId);

    if (pending === undefined || !isForced(pending)) {
      this.#pending.set(serverId, trigger);
    }

    if (this.#timers.has(serverId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.#timers.delete(serverId);
      const reason = this.#pending.get(serverId) ?? 'manual';
      this.#pending.delete(serverId);

      void this.push(serverId, reason).catch((error: unknown) => {
        // Não deveria acontecer: `push` traduz falha em desfecho. O
        // catch existe porque isto roda dentro de um timer, onde
        // uma Promise rejeitada não teria quem a pegasse.
        this.#deps.logger?.error({ err: toError(error) }, 'o envio das propagandas lançou');
      });
    }, DEBOUNCE_MS);

    timer.unref();
    this.#timers.set(serverId, timer);
  }

  /** O mesmo, em todos os servidores. */
  pushAllSoon(trigger: AdsSyncTrigger): void {
    for (const serverId of this.#deps.servers.ids()) {
      this.pushSoon(serverId, trigger);
    }
  }

  /**
   * O RCON daquele servidor reconectou.
   *
   * O servidor pode ter reiniciado, e o plugin nasce sem carga. As
   * imagens não precisam de cuidado aqui: o manifesto do envio diz
   * o que o OrigemZImages ainda tem.
   */
  handleRconConnected(serverId: string): void {
    this.pushSoon(serverId, 'rcon-connected');
  }

  /**
   * Uma linha do console daquele servidor.
   *
   * NUNCA lança — ver o cabeçalho do arquivo.
   */
  handleLine(serverId: string, line: string): void {
    if (!isAdsRequest(line)) {
      return;
    }

    this.#deps.logger?.info({ serverId }, 'ads plugin asked for the config back');
    this.pushSoon(serverId, 'plugin-requested');
  }

  /** Monta e envia tudo, naquele servidor. NUNCA lança. */
  async push(serverId: string, trigger: AdsSyncTrigger): Promise<AdsSyncOutcome> {
    if (this.#running.has(serverId)) {
      return { status: 'skipped', reason: 'um envio já está em curso' };
    }

    const rcon = this.#rconOf(serverId);

    if (rcon === null) {
      return { status: 'skipped', reason: 'sem RCON' };
    }

    this.#running.add(serverId);

    const state = this.#stateOf(serverId);

    try {
      const settings = this.#deps.ads.settings(serverId);

      // ####  DESLIGADO PRECISA SER DITO  ####
      //
      // Sem esta carga, quem estivesse com o overlay na tela
      // continuaria com ele lá — congelado, e sem nada que o
      // tirasse até o servidor reiniciar.
      if (!settings.enabled) {
        const off = encodeAdsPayload(emptyPayload(settings));
        await rcon.send(buildAdsConfigCommand(off));

        this.#deps.logger?.info(
          { serverId, trigger },
          'ads overlay is off; plugin told to clear it',
        );
        return { status: 'sent', ads: 0, bytes: off.length };
      }

      // 1. O cache. Falha de UMA imagem não impede as outras de ir
      // — a propaganda quebrada simplesmente fica de fora.
      let logoKey: string | null = null;

      if (settings.imageMode === 'stored') {
        await this.refreshImages(serverId);
        logoKey = await this.#ensureLogo(serverId, settings.logoImageUrl);
      }

      const chosen = this.#chooseCycle(serverId, settings);
      const payload = this.#buildPayload(settings, chosen, logoKey);
      const encoded = encodeAdsPayload(payload);

      if (encoded.length > ADS_PAYLOAD_MAX_BYTES) {
        // RECUSA, nunca corta: meia carga substituiria uma
        // configuração boa por uma incompleta, e o defeito
        // apareceria como um overlay que trava no meio da
        // animação.
        const reason =
          `a carga tem ${String(encoded.length)} bytes em base64, acima do teto de ` +
          `${String(ADS_PAYLOAD_MAX_BYTES)}. Reduza os quadros por segundo ou o número de ` +
          'propagandas por ciclo.';

        this.#deps.logger?.error(
          { serverId, trigger, bytes: encoded.length },
          'ads sync refused: payload too large',
        );
        return { status: 'refused', reason };
      }

      // 2. Os bytes, antes da carga.
      if (settings.imageMode === 'stored') {
        await this.#pushImages(serverId, rcon, chosen, logoKey);
      }

      // ####  CARGA IGUAL NAO E REENVIADA  ####
      //
      // ISTO ACONTECEU DE VERDADE: o relógio periódico (5 min) e o
      // ciclo do plugin (5 min por padrão) ficaram em cadências
      // parecidas, e cada reenvio reiniciava a contagem do lado de
      // lá. A propaganda nunca aparecia sozinha.
      //
      // O plugin já foi consertado para RETOMAR a contagem em vez
      // de zerá-la, e este dedup é a segunda metade: sem mudança,
      // não há motivo para gastar RCON nem para mexer no estado de
      // quem está jogando.
      //
      // `rcon-connected` e `plugin-requested` passam SEMPRE — nos
      // dois, o outro lado perdeu o que tinha, e é justamente aí
      // que reenviar é obrigatório.
      if (!isForced(trigger) && encoded === state.lastPayload) {
        this.#deps.logger?.debug({ serverId, trigger }, 'ads config unchanged; nothing sent');
        return { status: 'skipped', reason: 'a configuração não mudou' };
      }

      // 3. A carga.
      await rcon.send(buildAdsConfigCommand(encoded));
      state.lastPayload = encoded;

      this.#deps.logger?.info(
        {
          serverId,
          trigger,
          ads: payload.ads.length,
          bytes: encoded.length,
          mode: settings.imageMode,
        },
        'ads config pushed',
      );

      return { status: 'sent', ads: payload.ads.length, bytes: encoded.length };
    } catch (error) {
      const err = toError(error);
      this.#deps.logger?.warn({ err, serverId, trigger }, 'ads sync failed');
      return { status: 'failed', error: err };
    } finally {
      this.#running.delete(serverId);
    }
  }

  /**
   * Baixa o que ainda não foi baixado, naquele servidor. NUNCA lança.
   *
   * ####  SO O QUE FALTA  ####
   *
   * Uma propaganda com `imageStatus: 'ready'` é pulada. Sem isso,
   * cada volta do relógio periódico rebaixaria todas as imagens —
   * cinco minutos, para sempre, para nada.
   *
   * O que FALHOU também é pulado depois da primeira tentativa: a
   * URL quebrada continua quebrada, e insistir a cada cinco
   * minutos só enche o log. Quem quiser tentar de novo limpa o
   * cache pela tela.
   */
  async refreshImages(serverId: string, force = false): Promise<{ ready: number; failed: number }> {
    let ready = 0;
    let failed = 0;

    const state = this.#stateOf(serverId);

    // ####  O TETO DEPENDE DE QUEM BAIXA  ####
    //
    // Os 420 KB existem por causa do RCON: é por ele que os bytes
    // viajam no modo `stored`. No modo `url` o RCON não entra na
    // história — quem baixa é o cliente, direto do endereço.
    //
    // Aplicar o teto do duto a quem não passa por ele produzia um
    // erro FALSO: "a imagem tem 953 KB e o limite é 420 KB" numa
    // configuração em que 953 KB está perfeitamente bem. A
    // conferência de formato e de endereço continua valendo nos
    // dois modos, porque essa serve para os dois.
    const mode = this.#deps.ads.settings(serverId).imageMode;
    const maxBytes = mode === 'url' ? ADS_IMAGE_MAX_BYTES : ADS_STORED_MAX_BYTES;

    for (const ad of this.#deps.ads.list(serverId)) {
      if (!ad.enabled) {
        continue;
      }

      if (!force && ad.imageStatus !== 'pending') {
        if (ad.imageStatus === 'ready') ready += 1;
        else failed += 1;
        continue;
      }

      try {
        const image = await fetchAdImage(ad.imageUrl, {
          maxBytes,
          // ####  SO NO MODO `stored`  ####
          //
          // É o modo em que NÓS entregamos os bytes ao jogo, e
          // portanto o único em que encolher muda o que o
          // jogador vê. No modo `url` quem baixa é o cliente, do
          // endereço original — ver ads-images.ts.
          resize: mode === 'stored',
          ...(this.#deps.fetchImpl === undefined ? {} : { fetchImpl: this.#deps.fetchImpl }),
        });

        if (image.resizedFrom !== undefined) {
          this.#deps.logger?.info(
            {
              serverId,
              ad: ad.id,
              from: `${String(image.resizedFrom.width)}x${String(image.resizedFrom.height)}`,
              to: `${String(image.width)}x${String(image.height)}`,
              bytes: image.bytes.length,
              originalBytes: image.resizedFrom.bytes,
            },
            'ad image was too big and got shrunk to fit',
          );
        }

        // Conteúdo idêntico ao que já está lá: a chave é a mesma,
        // e o plugin não precisa receber os bytes de novo.
        this.#deps.ads.markImage(
          serverId,
          ad.id,
          {
            status: 'ready',
            key: image.key,
            sha: image.sha,
            bytes: image.bytes.length,
            width: image.width,
            height: image.height,
            error: null,
          },
          this.#now(),
        );

        state.cache.set(image.key, image.bytes);
        ready += 1;
      } catch (error) {
        const message =
          error instanceof AdImageError
            ? error.message
            : `não consegui preparar a imagem: ${toError(error).message}`;

        this.#deps.ads.markImage(serverId, ad.id, { status: 'error', error: message }, this.#now());
        this.#deps.logger?.warn(
          { serverId, ad: ad.id, url: ad.imageUrl, err: message },
          'ad image failed',
        );
        failed += 1;
      }
    }

    return { ready, failed };
  }

  /** Esquece os bytes em memória daquele servidor. A tela chama isto ao limpar. */
  clearCache(serverId: string): void {
    const state = this.#stateOf(serverId);

    state.cache.clear();
    state.logoCache.clear();
    // Sem isto, "limpar o cache" não faria a próxima carga sair:
    // ela seria idêntica à anterior e o dedup a engoliria.
    state.lastPayload = null;
  }

  // ----------------------------------------------------------

  #stateOf(serverId: string): ServerAdsState {
    const known = this.#states.get(serverId);

    if (known !== undefined) {
      return known;
    }

    const fresh: ServerAdsState = {
      lastPayload: null,
      cache: new Map<string, Buffer>(),
      logoCache: new Map<string, string>(),
    };

    this.#states.set(serverId, fresh);
    return fresh;
  }

  /**
   * A conexão daquele servidor, quando ela está de pé.
   *
   * `null` cobre os dois casos que valem o mesmo para quem chama:
   * o servidor não está montado e o socket está fora do ar.
   */
  #rconOf(serverId: string): AdsSyncRcon | null {
    const context = this.#deps.servers.contextOf(serverId);

    if (context === null || !context.rcon.isConnected) {
      return null;
    }

    return context.rcon;
  }

  /**
   * Quem entra no ciclo AGORA.
   *
   * Filtra por: ligada, imagem pronta e janela de exibição. A
   * permissão NÃO entra aqui — ela é por jogador, e quem a
   * resolve é o plugin (ver types/ads-transport.ts).
   */
  #chooseCycle(serverId: string, settings: AdsSettings): readonly Advertisement[] {
    const date = new Date(this.#now());

    const eligible = this.#deps.ads
      .list(serverId)
      .filter((ad) => isPlayable(ad, settings.imageMode) && isWithinSchedule(ad, date));

    // Ordem: prioridade primeiro, posição depois. `position` é
    // arrasto na tela; `priority` é "esta é mais importante que
    // aquela" independentemente de onde ela está na lista.
    const ordered = [...eligible].sort(
      (a, b) => b.priority - a.priority || a.position - b.position,
    );

    // 0 = todas. O plugin ainda respeita `adsPerCycle` por ciclo;
    // o corte aqui é só o teto do que cabe na carga.
    return ordered;
  }

  /**
   * Baixa o LOGO e devolve a chave dele, ou `null`.
   *
   * ####  ELE SEGUE O MESMO CAMINHO DAS PROPAGANDAS  ####
   *
   * Deixá-lo sempre em `url` seria a pior inconsistência
   * possível: num servidor onde o cliente não alcança endereços
   * de fora — que é justamente por que o modo `stored` existe —
   * as propagandas apareceriam e o logo, que fica na tela o tempo
   * todo, não.
   *
   * Falhar aqui NÃO derruba a carga: o logo cai para `url`, e o
   * pior caso é ele não aparecer. Um overlay sem logo continua
   * mostrando propaganda.
   */
  async #ensureLogo(serverId: string, url: string | null): Promise<string | null> {
    if (url === null || url.trim() === '') {
      return null;
    }

    const state = this.#stateOf(serverId);
    const known = state.logoCache.get(url);

    if (known !== undefined) {
      return known;
    }

    try {
      const image = await fetchAdImage(url, {
        maxBytes: ADS_STORED_MAX_BYTES,
        // ####  O TETO DO LOGO E MENOR QUE O DAS PROPAGANDAS  ####
        //
        // Ele nunca é desenhado com mais de 400 pixels de lado, e
        // a logo do site tem 4048 de largura. Guardá-la inteira
        // custava 667 KB de RCON e uma textura enorme na memória
        // de vídeo de cada jogador para pintar um quadrado de 90.
        maxWidth: ADS_LOGO_MAX_WIDTH,
        maxHeight: ADS_LOGO_MAX_HEIGHT,
        resize: true,
        ...(this.#deps.fetchImpl === undefined ? {} : { fetchImpl: this.#deps.fetchImpl }),
      });

      if (image.resizedFrom !== undefined) {
        this.#deps.logger?.info(
          {
            serverId,
            url,
            from: `${String(image.resizedFrom.width)}x${String(image.resizedFrom.height)}`,
            to: `${String(image.width)}x${String(image.height)}`,
            bytes: image.bytes.length,
            originalBytes: image.resizedFrom.bytes,
          },
          'overlay logo was too big and got shrunk to fit',
        );
      }

      state.cache.set(image.key, image.bytes);
      state.logoCache.set(url, image.key);
      return image.key;
    } catch (error) {
      this.#deps.logger?.warn(
        { err: toError(error), serverId, url },
        'could not prepare the overlay logo; falling back to the client downloading it',
      );
      return null;
    }
  }

  #buildPayload(
    settings: AdsSettings,
    ads: readonly Advertisement[],
    logoKey: string | null = null,
  ): AdsPayload {
    const timeline = buildTimeline(settings, logoKey);

    const items: AdsPayloadItem[] = ads.map((ad) => {
      const anchors = imageAnchors(ad.fit, settings.panelWidth, settings.panelHeight, {
        width: ad.imageWidth,
        height: ad.imageHeight,
      });

      return {
        id: ad.id,
        image: settings.imageMode === 'url' ? ad.imageUrl : (ad.imageKey ?? ''),
        displayMs: (ad.displayDuration ?? settings.defaultDisplayDuration) * 1000,
        anchorMin: anchors.min,
        anchorMax: anchors.max,
        background: adBackground(ad.backgroundColor),
        weight: ad.weight,
        permission: ad.permission,
      };
    });

    return {
      enabled: true,
      layer: settings.layer,
      permission: settings.permission,
      root: timeline.root,
      animations: {
        opening: timeline.opening,
        adEnter: timeline.adEnter,
        adExit: timeline.adExit,
        closing: timeline.closing,
      },
      cycle: {
        intervalMs: settings.intervalSeconds * 1000,
        orderMode: settings.orderMode,
        adsPerCycle: settings.adsPerCycle,
      },
      ads: items,
      root_name: ADS_ROOT,
      imageMode: settings.imageMode,
      logoDetached: settings.logoDetached,
      staticMode: settings.staticMode,
    };
  }

  /**
   * Garante que o OrigemZImages tem as imagens da vez.
   *
   * Falha em UMA não aborta as outras: um retângulo vazio numa
   * propaganda é melhor que overlay nenhum. A biblioteca não lança
   * e registra o que falhou.
   *
   * ####  O SHA VEM DO BANCO, E OS BYTES SÓ SE PRECISAR  ####
   *
   * Depois de um reinício do agente o cache em memória está vazio,
   * mas a linha da propaganda guarda o sha da imagem. Com ele a
   * biblioteca pergunta ao plugin se ele já tem esta versão — e só
   * quando não tem é que `#restore` rebaixa a URL. Antes, todo
   * reinício do agente rebaixava e reenviava todas as imagens.
   */
  async #pushImages(
    serverId: string,
    rcon: AdsSyncRcon,
    ads: readonly Advertisement[],
    logoKey: string | null,
  ): Promise<void> {
    const state = this.#stateOf(serverId);
    const assets: ImageAsset[] = [];

    // O logo PRIMEIRO: é ele que fica na tela o tempo todo, e a
    // carga só desce depois de tudo isto. Os bytes dele estão na
    // mão — o `#ensureLogo` acabou de pô-los no cache.
    const logoBytes = logoKey === null ? undefined : state.cache.get(logoKey);

    if (logoKey !== null && logoBytes !== undefined) {
      assets.push({ key: logoKey, sha: sha256Hex(logoBytes), load: () => logoBytes });
    }

    for (const ad of ads) {
      const key = ad.imageKey;

      if (key === null) {
        continue;
      }

      const cached = state.cache.get(key);
      let sha = cached === undefined ? this.#deps.ads.imageSha(serverId, ad.id) : sha256Hex(cached);

      if (sha === null) {
        // Linha sem sha e sem bytes em memória: sem os bytes não há
        // como perguntar ao plugin. Rebaixar agora é o único caminho.
        const restored = await this.#restore(serverId, ad);

        if (restored === null) {
          continue;
        }

        sha = sha256Hex(restored);
      }

      assets.push({
        key,
        sha,
        load: async () => state.cache.get(key) ?? (await this.#restore(serverId, ad)),
      });
    }

    // ####  A POUPANÇA E A PODA  ####
    //
    // Cada imagem trocada deixa uma chave velha no OrigemZImages, e a
    // tabela dele sobrevive a restart: sem poda, o manifesto cresceria
    // até não caber no frame do RCON. Mas só a propaganda APAGADA sai
    // — a que está fora da janela de horário não sobe agora e fica,
    // senão os seus megabytes subiriam de novo quando a janela abrisse.
    const keep = new Set<string>();

    for (const ad of this.#deps.ads.list(serverId)) {
      if (ad.imageKey !== null) {
        keep.add(ad.imageKey);
      }
    }

    if (logoKey !== null) {
      keep.add(logoKey);
    }

    await this.#images.sync(serverId, rcon, assets, { owns: IMAGE_FAMILIES.ad, keep });
  }

  /** Rebaixa uma imagem cujo cache em memória se perdeu. */
  async #restore(serverId: string, owner: Advertisement): Promise<Buffer | null> {
    try {
      const image = await fetchAdImage(owner.imageUrl, {
        // ####  A REDUCAO PRECISA SER A MESMA DE LA  ####
        //
        // A chave sai do CONTEÚDO. Rebaixar sem encolher devolve
        // outro conteúdo, logo outra chave — e a que o plugin
        // está pedindo continuaria sem bytes, para sempre. Isto
        // só roda no modo `stored`, que é o que encolhe.
        resize: true,
        ...(this.#deps.fetchImpl === undefined ? {} : { fetchImpl: this.#deps.fetchImpl }),
      });

      this.#stateOf(serverId).cache.set(image.key, image.bytes);
      return image.bytes;
    } catch (error) {
      this.#deps.logger?.warn(
        { err: toError(error), serverId, ad: owner.id },
        'could not restore the ad image bytes',
      );
      return null;
    }
  }
}

// ============================================================
//  O PLUGIN PEDINDO A CARGA DE VOLTA
// ============================================================

/**
 * A carga de "está tudo desligado".
 *
 * Fora da classe porque não depende de estado nenhum — e porque é
 * o que o teste de "desligar limpa a tela" quer montar sozinho.
 */
function emptyPayload(settings: AdsSettings): AdsPayload {
  return {
    enabled: false,
    layer: settings.layer,
    permission: settings.permission,
    root: [],
    animations: {
      opening: { durationMs: 0, frames: [] },
      adEnter: { durationMs: 0, frames: [] },
      adExit: { durationMs: 0, frames: [] },
      closing: { durationMs: 0, frames: [] },
    },
    cycle: { intervalMs: 0, orderMode: 'sequential', adsPerCycle: 0 },
    ads: [],
    root_name: ADS_ROOT,
    imageMode: settings.imageMode,
    logoDetached: settings.logoDetached,
    staticMode: settings.staticMode,
  };
}

/**
 * O outro lado perdeu o que tinha, e reenviar é obrigatório?
 *
 * É o que faz o dedup de `push` ser pulado — ver o comentário
 * grande lá. Fica numa função porque `pushSoon` precisa da mesma
 * resposta para decidir qual motivo sobrevive ao debounce.
 */
function isForced(trigger: AdsSyncTrigger): boolean {
  return trigger === 'rcon-connected' || trigger === 'plugin-requested';
}

/** A linha é um pedido legítimo de recarga? */
export function isAdsRequest(line: string, pluginPrefix = PLUGIN_PREFIX): boolean {
  if (!line.includes(pluginPrefix)) {
    return false;
  }

  const marker = line.indexOf(ADS_REQUEST_MARKER);
  if (marker === -1) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(line.slice(marker + ADS_REQUEST_MARKER.length).trim());
    return (
      typeof parsed === 'object' && parsed !== null && (parsed as { want?: unknown }).want === 'ads'
    );
  } catch {
    return false;
  }
}
