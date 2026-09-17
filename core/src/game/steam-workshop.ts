// ============================================================
//  steam-workshop.ts  -  o que a Steam diz de um Workshop ID.
//
//  ####  É A ÚNICA CONFERÊNCIA DE VERDADE QUE EXISTE  ####
//
//  O servidor do Rust aceita QUALQUER `ulong` em `item.skin` e
//  nunca reclama (MEDIDO, Docs/OrigemZWorkshop/00-LEVANTAMENTO.md
//  §2.2). Quem sabe se o número é uma skin publicada é a Steam — e
//  ela responde sem chave de API:
//
//      POST ISteamRemoteStorage/GetPublishedFileDetails/v1
//        itemcount=1&publishedfileids[0]=<id>
//
//  MEDIDO em 16/09/2026 com o 3802433262: `result: 1`,
//  `consumer_app_id: 252490`, `title: "MetalFacemaskOrigemZ"` e as
//  tags `Skin`, `Version3`, `Metal Facemask`. Um id inexistente
//  volta com `result: 9`.
//
//  ####  A TAG DIZ DE QUE ITEM É A SKIN  ####
//
//  A Steam marca cada skin com o nome do item em INGLÊS — o mesmo
//  `display_name` da tabela `items`. É assim que o cadastro
//  descobre que o id da máscara foi colado no machado: a tag casa
//  com OUTRO item e não com o escolhido.
//
//  ####  STEAM FORA DO AR NÃO BARRA O CADASTRO  ####
//
//  `unavailable` é "não sei", e não "não existe". Recusar por falta
//  de rede faria o `/skin add` do jogo parar junto com a Steam; a
//  linha entra, e o motivo fica no registro.
// ============================================================

import { z } from 'zod';

import { RUST_APP_ID } from '../types/workshop.js';

const DETAILS_URL =
  'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

/** A Steam costuma responder em ~300 ms; 8 s é o teto de "fora do ar". */
const DEFAULT_TIMEOUT_MS = 8_000;

/** `EResult.OK` da Steam. */
const RESULT_OK = 1;

const detailsSchema = z.object({
  response: z.object({
    publishedfiledetails: z
      .array(
        z
          .object({
            publishedfileid: z.string(),
            result: z.number(),
            consumer_app_id: z.number().optional(),
            title: z.string().optional(),
            preview_url: z.string().optional(),
            banned: z.union([z.number(), z.boolean()]).optional(),
            tags: z.array(z.object({ tag: z.string() })).optional(),
          })
          .passthrough(),
      )
      .default([]),
  }),
});

export interface WorkshopFileDetails {
  readonly workshopId: string;
  readonly title: string;
  readonly previewUrl: string | null;
  readonly appId: number | null;
  readonly banned: boolean;
  /** Sem as tags de sistema (`Skin`, `Version3`…). */
  readonly tags: readonly string[];
}

export type WorkshopLookup =
  | { readonly status: 'found'; readonly details: WorkshopFileDetails }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: string };

/** A consulta, isolada para o teste trocar por uma de mentira. */
export type WorkshopLookupFn = (workshopId: string) => Promise<WorkshopLookup>;

/** Tags que a Steam põe em toda skin e que não nomeiam item. */
const SYSTEM_TAGS = new Set(['skin', 'version2', 'version3', 'version4', 'version5']);

export function createWorkshopLookup(
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): WorkshopLookupFn {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (workshopId) => {
    const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': workshopId });

    let raw: unknown;

    try {
      const response = await doFetch(DETAILS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return { status: 'unavailable', reason: `a Steam respondeu HTTP ${String(response.status)}` };
      }

      raw = await response.json();
    } catch (cause) {
      return {
        status: 'unavailable',
        reason: `a Steam não respondeu: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    const parsed = detailsSchema.safeParse(raw);

    if (!parsed.success) {
      return { status: 'unavailable', reason: 'a resposta da Steam mudou de formato' };
    }

    const file = parsed.data.response.publishedfiledetails.find(
      (entry) => entry.publishedfileid === workshopId,
    );

    if (file === undefined || file.result !== RESULT_OK) return { status: 'not_found' };

    return {
      status: 'found',
      details: {
        workshopId,
        title: (file.title ?? '').trim(),
        previewUrl: file.preview_url === undefined || file.preview_url === '' ? null : file.preview_url,
        appId: file.consumer_app_id ?? null,
        banned: file.banned === true || file.banned === 1,
        tags: (file.tags ?? [])
          .map((entry) => entry.tag.trim())
          .filter((tag) => tag !== '' && !SYSTEM_TAGS.has(tag.toLowerCase())),
      },
    };
  };
}

/** O veredito do cadastro sobre um id, em frase. */
export type WorkshopVerdict =
  | { readonly ok: true; readonly details: WorkshopFileDetails | null; readonly warning: string | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Confere o id contra o item escolhido.
 *
 * @param itemsNamed devolve os shortnames cujo nome em inglês é a
 *        tag. É o `ItemsRepository.shortnamesByDisplayName`.
 */
export function judgeWorkshopFile(
  lookup: WorkshopLookup,
  shortname: string,
  itemsNamed: (displayName: string) => readonly string[],
): WorkshopVerdict {
  if (lookup.status === 'unavailable') {
    return {
      ok: true,
      details: null,
      warning: `Não deu para conferir o ID na Steam (${lookup.reason}). O cadastro entrou sem a conferência.`,
    };
  }

  if (lookup.status === 'not_found') {
    return {
      ok: false,
      code: 'WORKSHOP_NOT_FOUND',
      message:
        'A Steam não conhece este Workshop ID (ou ele é privado). Confira o número na URL da ' +
        'página da oficina: ...filedetails/?id=<este número>.',
    };
  }

  const { details } = lookup;

  if (details.appId !== null && details.appId !== RUST_APP_ID) {
    return {
      ok: false,
      code: 'WORKSHOP_WRONG_GAME',
      message: `Este Workshop ID é de outro jogo (app ${String(details.appId)}), e não do Rust.`,
    };
  }

  if (details.banned) {
    return {
      ok: false,
      code: 'WORKSHOP_BANNED',
      message: 'A Steam marcou este item como banido: o cliente dos jogadores não vai baixá-lo.',
    };
  }

  // ####  A TAG QUE APONTA PARA OUTRO ITEM  ####
  //
  // Só recusa quando a tag casa com um item e NENHUMA casa com o
  // escolhido. Tag que não é nome de item nenhum é ignorada: o
  // autor da skin escreve o que quiser ali.
  const named = details.tags.map((tag) => ({ tag, items: itemsNamed(tag) }));
  const matchesChosen = named.some((entry) => entry.items.includes(shortname));
  const other = named.find((entry) => entry.items.length > 0);

  if (!matchesChosen && other !== undefined) {
    return {
      ok: false,
      code: 'WORKSHOP_OTHER_ITEM',
      message:
        `Esta skin foi publicada para "${other.tag}" (${other.items.join(', ')}), e não para ` +
        `"${shortname}". No item errado ela não desenha nada.`,
    };
  }

  return { ok: true, details, warning: null };
}
