// ============================================================
//  ads-repository.ts  -  as propagandas do overlay.
//
//  Duas coisas, e elas mudam por motivos diferentes:
//
//    ads            a LISTA — o que aparece, em que ordem e
//                   quando. Muda quando alguém cadastra uma
//                   campanha.
//    ads_settings   o AJUSTE — tamanho, posição, relógio e
//                   animação. Muda quando alguém mexe no
//                   desenho do widget.
//
//  ------------------------------------------------------------
//  ####  A ORDEM E UM NUMERO ESPACADO  ####
//
//  `position` anda de 10 em 10, igual aos avisos do chat.
//  Arrastar uma linha para o meio grava 15 — e não reescreve a
//  lista inteira, que é o que uma numeração 1,2,3 exigiria a cada
//  arrasto.
//
//  ------------------------------------------------------------
//  ####  O CACHE DA IMAGEM E ESCRITO A PARTE  ####
//
//  `markImage*` não passa pelo `update`, e isso é de propósito: o
//  download acontece FORA da edição (num job, ao salvar, ao subir
//  o agente) e escrever pelo mesmo caminho faria uma atualização
//  de cache carimbar `updated_at` como se um humano tivesse
//  editado a propaganda.
// ============================================================

import { randomUUID } from 'node:crypto';

import { ADS_LOGO_ANCHORS } from '../types/ads.js';
import type {
  AdCreateInput,
  AdUpdateInput,
  Advertisement,
  AdsFit,
  AdsImageMode,
  AdsImageStatus,
  AdsLogoAnchor,
  AdsOrderMode,
  AdsSettings,
  AdsSettingsInput,
} from '../types/ads.js';

import type { AgentDatabase } from './database.js';

const GAP = 10;

interface AdRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: number;
  readonly image_url: string;
  readonly display_duration: number | null;
  readonly position: number;
  readonly priority: number;
  readonly weight: number;
  readonly fit: string;
  readonly background_color: string;
  readonly border_color: string;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly days_of_week: string;
  readonly permission: string | null;
  readonly image_status: string;
  readonly image_key: string | null;
  readonly image_sha: string | null;
  readonly image_bytes: number | null;
  readonly image_width: number | null;
  readonly image_height: number | null;
  readonly image_error: string | null;
  readonly image_fetched_at: number | null;
  readonly shown_count: number;
  readonly last_shown_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SettingsRow {
  readonly enabled: number;
  readonly layer: string;
  readonly permission: string | null;
  readonly anchor: string;
  readonly margin_top: number;
  readonly margin_right: number;
  readonly logo_enabled: number;
  readonly logo_image_url: string | null;
  readonly logo_width: number;
  readonly logo_height: number;
  readonly logo_opacity: number;
  readonly logo_detached: number;
  readonly ads_static: number;
  readonly logo_layer: string | null;
  readonly logo_anchor: string;
  readonly logo_margin_x: number;
  readonly logo_margin_y: number;
  readonly panel_width: number;
  readonly panel_height: number;
  readonly panel_color: string;
  readonly panel_border_color: string;
  readonly panel_border_enabled: number;
  readonly interval_seconds: number;
  readonly default_display_duration: number;
  readonly opening_ms: number;
  readonly closing_ms: number;
  readonly transition_ms: number;
  readonly order_mode: string;
  readonly ads_per_cycle: number;
  readonly animation_fps: number;
  readonly image_mode: string;
  readonly updated_at: number;
}

const AD_COLUMNS = `id, name, enabled, image_url, display_duration, position, priority, weight,
                    fit, background_color, border_color,
                    start_date, end_date, start_time, end_time, days_of_week, permission,
                    image_status, image_key, image_sha, image_bytes, image_width, image_height,
                    image_error, image_fetched_at,
                    shown_count, last_shown_at, created_at, updated_at`;

/**
 * CSV -> lista de dias.
 *
 * Tolerante de propósito: o que não for um dia válido é
 * DESCARTADO em vez de derrubar a leitura. Uma linha editada à
 * mão com lixo na coluna vira "todos os dias", que é o
 * comportamento seguro — o contrário seria a propaganda sumir
 * sem ninguém entender.
 */
function parseDays(csv: string): readonly number[] {
  if (csv.trim() === '') {
    return [];
  }

  const days = csv
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

  return [...new Set(days)].sort((a, b) => a - b);
}

function toAd(row: AdRow): Advertisement {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    imageUrl: row.image_url,
    displayDuration: row.display_duration,
    position: row.position,
    priority: row.priority,
    weight: row.weight,
    // O CHECK do banco já garante, mas a coluna é TEXT: um banco
    // mexido à mão não pode vazar um valor desconhecido para
    // dentro do gerador de animação.
    fit: row.fit === 'contain' ? 'contain' : ('cover' satisfies AdsFit),
    backgroundColor: row.background_color,
    borderColor: row.border_color,
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time,
    endTime: row.end_time,
    daysOfWeek: parseDays(row.days_of_week),
    permission: row.permission,
    imageStatus: toStatus(row.image_status),
    imageKey: row.image_key,
    imageBytes: row.image_bytes,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    imageError: row.image_error,
    imageFetchedAt:
      row.image_fetched_at === null ? null : new Date(row.image_fetched_at).toISOString(),
    shownCount: row.shown_count,
    lastShownAt: row.last_shown_at === null ? null : new Date(row.last_shown_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toStatus(raw: string): AdsImageStatus {
  return raw === 'ready' || raw === 'error' ? raw : 'pending';
}

function toSettings(row: SettingsRow): AdsSettings {
  return {
    enabled: row.enabled === 1,
    layer: row.layer,
    permission: row.permission,
    anchor:
      row.anchor === 'top-left' || row.anchor === 'bottom-right' || row.anchor === 'bottom-left'
        ? row.anchor
        : 'top-right',
    marginTop: row.margin_top,
    marginRight: row.margin_right,
    logoEnabled: row.logo_enabled === 1,
    logoImageUrl: row.logo_image_url,
    logoWidth: row.logo_width,
    logoHeight: row.logo_height,
    logoOpacity: row.logo_opacity,
    logoDetached: row.logo_detached === 1,
    staticMode: row.ads_static === 1,
    logoLayer: (row.logo_layer as AdsSettings['logoLayer']) ?? null,
    // Valor desconhecido (banco mexido à mão) vira o padrão em vez
    // de vazar para dentro do gerador de geometria.
    logoAnchor: ADS_LOGO_ANCHORS.includes(row.logo_anchor as AdsLogoAnchor)
      ? (row.logo_anchor as AdsLogoAnchor)
      : 'top-center',
    logoMarginX: row.logo_margin_x,
    logoMarginY: row.logo_margin_y,
    panelWidth: row.panel_width,
    panelHeight: row.panel_height,
    panelColor: row.panel_color,
    panelBorderColor: row.panel_border_color,
    panelBorderEnabled: row.panel_border_enabled === 1,
    intervalSeconds: row.interval_seconds,
    defaultDisplayDuration: row.default_display_duration,
    openingMs: row.opening_ms,
    closingMs: row.closing_ms,
    transitionMs: row.transition_ms,
    orderMode: (row.order_mode === 'random' ? 'random' : 'sequential') satisfies AdsOrderMode,
    adsPerCycle: row.ads_per_cycle,
    animationFps: row.animation_fps,
    imageMode: (row.image_mode === 'url' ? 'url' : 'stored') satisfies AdsImageMode,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** O que o cache da imagem grava. */
export interface AdImageResult {
  readonly status: AdsImageStatus;
  readonly key?: string | null;
  readonly sha?: string | null;
  readonly bytes?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly error?: string | null;
}

/**
 * ####  A PROPAGANDA É DE UM SERVIDOR  ####
 *
 * Desde a migração 028, tanto a lista quanto o ajuste são por
 * servidor, e `serverId` abre toda assinatura daqui. Uma campanha
 * do servidor de PvE não deveria aparecer na tela de quem está no
 * de PvP.
 *
 * O ajuste de um servidor recém-cadastrado não existe até alguém
 * salvar — por isso `saveSettings` grava com UPSERT e `settings`
 * devolve o padrão quando não acha linha.
 */
export interface AdsReader {
  list(serverId: string): readonly Advertisement[];
  get(serverId: string, id: string): Advertisement | null;
  settings(serverId: string): AdsSettings;
}

export class AdsRepository implements AdsReader {
  readonly #db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.#db = db;
  }

  // ----------------------------------------------------------
  //  A LISTA
  // ----------------------------------------------------------

  /** Todas, na ordem do rodízio — inclusive as desligadas. */
  list(serverId: string): readonly Advertisement[] {
    const rows = this.#db
      .prepare<[string], AdRow>(
        `SELECT ${AD_COLUMNS} FROM ads
          WHERE server_id = ?
          ORDER BY position ASC, created_at ASC`,
      )
      .all(serverId);

    return rows.map(toAd);
  }

  get(serverId: string, id: string): Advertisement | null {
    const row = this.#db
      .prepare<[string, string], AdRow>(
        `SELECT ${AD_COLUMNS} FROM ads WHERE server_id = ? AND id = ?`,
      )
      .get(serverId, id);

    return row === undefined ? null : toAd(row);
  }

  create(serverId: string, input: AdCreateInput, now = Date.now()): Advertisement {
    const id = randomUUID();

    this.#db
      .prepare(
        `INSERT INTO ads (id, server_id, name, enabled, image_url, display_duration, position,
                          priority, weight, fit, background_color, border_color,
                          start_date, end_date, start_time, end_time, days_of_week, permission,
                          image_status, created_at, updated_at)
         VALUES (@id, @server_id, @name, @enabled, @imageUrl, @displayDuration, @position,
                 @priority, @weight, @fit, @backgroundColor, @borderColor,
                 @startDate, @endDate, @startTime, @endTime, @daysOfWeek, @permission,
                 'pending', @now, @now)`,
      )
      .run({
        id,
        server_id: serverId,
        name: input.name,
        enabled: input.enabled === false ? 0 : 1,
        imageUrl: input.imageUrl,
        displayDuration: input.displayDuration ?? null,
        position: input.position ?? this.#nextPosition(serverId),
        priority: input.priority ?? 0,
        weight: input.weight ?? 1,
        fit: input.fit ?? 'cover',
        backgroundColor: input.backgroundColor ?? '#0A0A0AEB',
        borderColor: input.borderColor ?? '#FFFFFF26',
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        daysOfWeek: (input.daysOfWeek ?? []).join(','),
        permission: input.permission ?? null,
        now,
      });

    return this.get(serverId, id) ?? this.#unreachable(id);
  }

  /**
   * Atualiza o que veio. Campo ausente NÃO é apagado.
   *
   * ####  TROCAR A URL INVALIDA O CACHE  ####
   *
   * Sem isto, mudar o endereço deixaria a propaganda mostrando a
   * imagem ANTIGA — a chave no FileStorage continuaria válida, e
   * ninguém entenderia por que a troca não pegou.
   */
  update(
    serverId: string,
    id: string,
    input: AdUpdateInput,
    now = Date.now(),
  ): Advertisement | null {
    const atual = this.get(serverId, id);

    if (atual === null) {
      return null;
    }

    const imageUrl = input.imageUrl ?? atual.imageUrl;
    const urlChanged = imageUrl !== atual.imageUrl;

    this.#db
      .prepare(
        `UPDATE ads
            SET name = @name,
                enabled = @enabled,
                image_url = @imageUrl,
                display_duration = @displayDuration,
                position = @position,
                priority = @priority,
                weight = @weight,
                fit = @fit,
                background_color = @backgroundColor,
                border_color = @borderColor,
                start_date = @startDate,
                end_date = @endDate,
                start_time = @startTime,
                end_time = @endTime,
                days_of_week = @daysOfWeek,
                permission = @permission,
                image_status = @imageStatus,
                image_key = @imageKey,
                image_sha = @imageSha,
                image_error = @imageError,
                updated_at = @now
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({
        server_id: serverId,
        id,
        name: input.name ?? atual.name,
        enabled: (input.enabled ?? atual.enabled) ? 1 : 0,
        imageUrl,
        displayDuration:
          input.displayDuration === undefined ? atual.displayDuration : input.displayDuration,
        position: input.position ?? atual.position,
        priority: input.priority ?? atual.priority,
        weight: input.weight ?? atual.weight,
        fit: input.fit ?? atual.fit,
        backgroundColor: input.backgroundColor ?? atual.backgroundColor,
        borderColor: input.borderColor ?? atual.borderColor,
        startDate: input.startDate === undefined ? atual.startDate : input.startDate,
        endDate: input.endDate === undefined ? atual.endDate : input.endDate,
        startTime: input.startTime === undefined ? atual.startTime : input.startTime,
        endTime: input.endTime === undefined ? atual.endTime : input.endTime,
        daysOfWeek: (input.daysOfWeek ?? atual.daysOfWeek).join(','),
        permission: input.permission === undefined ? atual.permission : input.permission,
        imageStatus: urlChanged ? 'pending' : atual.imageStatus,
        imageKey: urlChanged ? null : atual.imageKey,
        imageSha: urlChanged ? null : this.#shaOf(serverId, id),
        imageError: urlChanged ? null : atual.imageError,
        now,
      });

    return this.get(serverId, id);
  }

  /** `false` quando não havia o que apagar. */
  delete(serverId: string, id: string): boolean {
    return (
      this.#db.prepare(`DELETE FROM ads WHERE server_id = ? AND id = ?`).run(serverId, id).changes >
      0
    );
  }

  /**
   * Uma cópia da propaganda, no fim da lista e DESLIGADA.
   *
   * Desligada de propósito: duplicar é o começo de uma edição, e
   * uma cópia idêntica entrando no rodízio no mesmo instante faria
   * a mesma imagem aparecer duas vezes por ciclo.
   */
  duplicate(serverId: string, id: string, now = Date.now()): Advertisement | null {
    const source = this.get(serverId, id);

    if (source === null) {
      return null;
    }

    return this.create(
      serverId,
      {
        name: `${source.name} (cópia)`,
        imageUrl: source.imageUrl,
        enabled: false,
        displayDuration: source.displayDuration,
        priority: source.priority,
        weight: source.weight,
        fit: source.fit,
        backgroundColor: source.backgroundColor,
        borderColor: source.borderColor,
        startDate: source.startDate,
        endDate: source.endDate,
        startTime: source.startTime,
        endTime: source.endTime,
        daysOfWeek: [...source.daysOfWeek],
        permission: source.permission,
      },
      now,
    );
  }

  /**
   * Reordena a lista inteira, na ordem dos ids recebidos.
   *
   * ####  POR QUE NAO UM `position` POR CHAMADA  ####
   *
   * Arrastar uma linha muda a posição RELATIVA de várias. Mandar
   * uma chamada por linha deixaria a lista num estado intermediário
   * entre elas — e um refresh no meio mostraria a ordem errada.
   *
   * Ids desconhecidos são ignorados; os que ficaram de fora
   * mantêm a posição que tinham e acabam no fim.
   */
  reorder(serverId: string, ids: readonly string[], now = Date.now()): readonly Advertisement[] {
    const statement = this.#db.prepare(
      `UPDATE ads SET position = @position, updated_at = @now
        WHERE server_id = @server_id AND id = @id`,
    );

    const apply = this.#db.transaction((): void => {
      let position = GAP;

      for (const id of ids) {
        statement.run({ server_id: serverId, id, position, now });
        position += GAP;
      }
    });

    apply();
    return this.list(serverId);
  }

  /** Marca que a propaganda apareceu. Só histórico — ver o schema. */
  markShown(serverId: string, id: string, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE ads SET last_shown_at = @now, shown_count = shown_count + 1
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({ server_id: serverId, id, now });
  }

  // ----------------------------------------------------------
  //  O CACHE DA IMAGEM
  // ----------------------------------------------------------

  /**
   * Grava o desfecho de um download.
   *
   * Não toca em `updated_at`: isto não é edição de ninguém, e
   * carimbar a hora aqui faria a tela dizer "editado agora" a cada
   * revalidação de cache.
   */
  markImage(
    serverId: string,
    id: string,
    result: AdImageResult,
    now = Date.now(),
  ): Advertisement | null {
    this.#db
      .prepare(
        `UPDATE ads
            SET image_status = @status,
                image_key = @key,
                image_sha = @sha,
                image_bytes = @bytes,
                image_width = @width,
                image_height = @height,
                image_error = @error,
                image_fetched_at = @now
          WHERE server_id = @server_id AND id = @id`,
      )
      .run({
        server_id: serverId,
        id,
        status: result.status,
        key: result.key ?? null,
        sha: result.sha ?? null,
        bytes: result.bytes ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        error: result.error ?? null,
        now,
      });

    return this.get(serverId, id);
  }

  /**
   * O sha do que está em cache, para decidir se vale rebaixar.
   *
   * `null` também quando a propaganda não existe — quem chama já
   * trata "não tenho cópia" e "não tenho propaganda" do mesmo
   * jeito: baixar de novo.
   */
  imageSha(serverId: string, id: string): string | null {
    return this.#shaOf(serverId, id);
  }

  /** Esquece o cache de todas as deste servidor (ou de uma). Força rebaixar. */
  clearImageCache(serverId: string, id?: string): number {
    const sql = `UPDATE ads
                    SET image_status = 'pending', image_key = NULL, image_sha = NULL,
                        image_bytes = NULL, image_width = NULL, image_height = NULL,
                        image_error = NULL, image_fetched_at = NULL
                  WHERE server_id = @server_id`;

    return id === undefined
      ? this.#db.prepare(sql).run({ server_id: serverId }).changes
      : this.#db.prepare(`${sql} AND id = @id`).run({ server_id: serverId, id }).changes;
  }

  // ----------------------------------------------------------
  //  O AJUSTE
  // ----------------------------------------------------------

  settings(serverId: string): AdsSettings {
    const row = this.#db
      .prepare<[string], SettingsRow>(`SELECT * FROM ads_settings WHERE server_id = ? AND id = 1`)
      .get(serverId);

    if (row === undefined) {
      // O caminho normal de um servidor recém-cadastrado: a
      // migração 020 semeou a linha do que já existia, e ninguém
      // semeia linha para servidor que ainda não foi configurado.
      // Responder o padrão (DESLIGADO) é melhor que derrubar a
      // rota.
      return {
        enabled: false,
        layer: 'Hud',
        permission: null,
        anchor: 'top-right',
        marginTop: 24,
        marginRight: 24,
        logoEnabled: true,
        logoImageUrl: null,
        logoWidth: 90,
        logoHeight: 90,
        logoOpacity: 0.95,
        logoDetached: false,
        staticMode: false,
        logoLayer: null,
        logoAnchor: 'top-center',
        logoMarginX: 0,
        logoMarginY: 24,
        panelWidth: 360,
        panelHeight: 120,
        panelColor: '#0A0A0AEB',
        panelBorderColor: '#FFFFFF26',
        panelBorderEnabled: true,
        intervalSeconds: 300,
        defaultDisplayDuration: 8,
        openingMs: 700,
        closingMs: 600,
        transitionMs: 500,
        orderMode: 'sequential',
        adsPerCycle: 3,
        animationFps: 15,
        imageMode: 'stored',
        updatedAt: new Date(0).toISOString(),
      };
    }

    return toSettings(row);
  }

  saveSettings(serverId: string, input: AdsSettingsInput, now = Date.now()): AdsSettings {
    const atual = this.settings(serverId);
    // `updatedAt` fica de fora do que se pode escolher: ele é
    // carimbado por esta gravação, e não vem de quem chamou.
    const pick = <K extends keyof AdsSettingsInput>(key: K): AdsSettings[K] =>
      (input[key] ?? atual[key]) as AdsSettings[K];

    // UPSERT, e não UPDATE: servidor novo não tem linha de ajuste,
    // e um UPDATE que não acha nada devolveria sucesso sem gravar
    // nada — a tela mostraria o valor salvo até o próximo F5.
    this.#db
      .prepare(
        `INSERT INTO ads_settings
           (server_id, id, enabled, layer, permission, anchor, margin_top, margin_right,
            logo_enabled, logo_image_url, logo_width, logo_height, logo_opacity,
            logo_detached, logo_anchor, logo_margin_x, logo_margin_y,
            ads_static, logo_layer,
            panel_width, panel_height, panel_color, panel_border_color, panel_border_enabled,
            interval_seconds, default_display_duration, opening_ms, closing_ms, transition_ms,
            order_mode, ads_per_cycle, animation_fps, image_mode, updated_at)
         VALUES
           (@server_id, 1, @enabled, @layer, @permission, @anchor, @marginTop, @marginRight,
            @logoEnabled, @logoImageUrl, @logoWidth, @logoHeight, @logoOpacity,
            @logoDetached, @logoAnchor, @logoMarginX, @logoMarginY,
            @staticMode, @logoLayer,
            @panelWidth, @panelHeight, @panelColor, @panelBorderColor, @panelBorderEnabled,
            @intervalSeconds, @defaultDisplayDuration, @openingMs, @closingMs, @transitionMs,
            @orderMode, @adsPerCycle, @animationFps, @imageMode, @now)
         ON CONFLICT (server_id, id) DO UPDATE SET
            enabled = excluded.enabled,
            layer = excluded.layer,
            permission = excluded.permission,
            anchor = excluded.anchor,
            margin_top = excluded.margin_top,
            margin_right = excluded.margin_right,
            logo_enabled = excluded.logo_enabled,
            logo_image_url = excluded.logo_image_url,
            logo_width = excluded.logo_width,
            logo_height = excluded.logo_height,
            logo_opacity = excluded.logo_opacity,
            logo_detached = excluded.logo_detached,
            ads_static = excluded.ads_static,
            logo_layer = excluded.logo_layer,
            logo_anchor = excluded.logo_anchor,
            logo_margin_x = excluded.logo_margin_x,
            logo_margin_y = excluded.logo_margin_y,
            panel_width = excluded.panel_width,
            panel_height = excluded.panel_height,
            panel_color = excluded.panel_color,
            panel_border_color = excluded.panel_border_color,
            panel_border_enabled = excluded.panel_border_enabled,
            interval_seconds = excluded.interval_seconds,
            default_display_duration = excluded.default_display_duration,
            opening_ms = excluded.opening_ms,
            closing_ms = excluded.closing_ms,
            transition_ms = excluded.transition_ms,
            order_mode = excluded.order_mode,
            ads_per_cycle = excluded.ads_per_cycle,
            animation_fps = excluded.animation_fps,
            image_mode = excluded.image_mode,
            updated_at = excluded.updated_at`,
      )
      .run({
        server_id: serverId,
        enabled: (input.enabled ?? atual.enabled) ? 1 : 0,
        layer: pick('layer'),
        // `??` não serve para o que pode ser null de propósito: a
        // tela apaga a permissão mandando `null`, e `?? atual`
        // devolveria a antiga. Por isso o teste é contra
        // `undefined`.
        permission: input.permission === undefined ? atual.permission : input.permission,
        anchor: pick('anchor'),
        marginTop: pick('marginTop'),
        marginRight: pick('marginRight'),
        logoEnabled: (input.logoEnabled ?? atual.logoEnabled) ? 1 : 0,
        logoImageUrl: input.logoImageUrl === undefined ? atual.logoImageUrl : input.logoImageUrl,
        logoWidth: pick('logoWidth'),
        logoHeight: pick('logoHeight'),
        logoOpacity: pick('logoOpacity'),
        logoDetached: (input.logoDetached ?? atual.logoDetached) ? 1 : 0,
        staticMode: (input.staticMode ?? atual.staticMode) ? 1 : 0,
        // `null` é um VALOR aqui ("herda a do painel"), e não
        // "não mandei" — por isso `??` sobre o campo, e não sobre
        // o valor. Ver `pick` logo acima.
        logoLayer: input.logoLayer === undefined ? atual.logoLayer : input.logoLayer,
        logoAnchor: pick('logoAnchor'),
        // `??` engoliria o zero, e zero é o centro exato — o valor
        // mais provável de todos neste campo.
        logoMarginX: input.logoMarginX === undefined ? atual.logoMarginX : input.logoMarginX,
        logoMarginY: input.logoMarginY === undefined ? atual.logoMarginY : input.logoMarginY,
        panelWidth: pick('panelWidth'),
        panelHeight: pick('panelHeight'),
        panelColor: pick('panelColor'),
        panelBorderColor: pick('panelBorderColor'),
        panelBorderEnabled: (input.panelBorderEnabled ?? atual.panelBorderEnabled) ? 1 : 0,
        intervalSeconds: pick('intervalSeconds'),
        defaultDisplayDuration: pick('defaultDisplayDuration'),
        openingMs: pick('openingMs'),
        closingMs: pick('closingMs'),
        transitionMs: pick('transitionMs'),
        orderMode: pick('orderMode'),
        // `adsPerCycle` aceita 0 ("todas"), e `??` engoliria o
        // zero. Mesmo motivo do `permission` acima.
        adsPerCycle: input.adsPerCycle === undefined ? atual.adsPerCycle : input.adsPerCycle,
        animationFps: pick('animationFps'),
        imageMode: pick('imageMode'),
        now,
      });

    return this.settings(serverId);
  }

  // ----------------------------------------------------------

  #shaOf(serverId: string, id: string): string | null {
    const row = this.#db
      .prepare<[string, string], { readonly image_sha: string | null }>(
        `SELECT image_sha FROM ads WHERE server_id = ? AND id = ?`,
      )
      .get(serverId, id);

    return row?.image_sha ?? null;
  }

  #nextPosition(serverId: string): number {
    const row = this.#db
      .prepare<[string], { readonly max: number | null }>(
        `SELECT MAX(position) AS max FROM ads WHERE server_id = ?`,
      )
      .get(serverId);

    return (row?.max ?? 0) + GAP;
  }

  #unreachable(id: string): never {
    throw new Error(`a propaganda ${id} sumiu logo depois de ser criada`);
  }
}
