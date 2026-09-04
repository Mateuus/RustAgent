// ============================================================
//  compat.ts  -  a release do Oxide serve para o build do Rust
//  que está em disco?
//
//  ####  O DEFEITO QUE ISTO EXISTE PARA IMPEDIR  ####
//
//  Em 03/09/2026, no relógio da Steam:
//
//      17:29:23  a Facepunch publica o build 25083359
//      17:32:32  o SteamCMD do agente termina de baixá-lo
//      17:32:33  o agente baixa o Oxide "latest" — 2.0.7638,
//                de 28/08, feita para o build ANTERIOR
//      17:32:41  o OxideMod publica a 2.0.7676, a do build novo
//
//  Nove segundos. O `Assembly-CSharp.dll` que a 2.0.7638 traz é o
//  do Rust de agosto e chama um método que a Facepunch removeu em
//  setembro (`Facepunch.ExceptionReporter.InitializeFromUrl`). O
//  boot morre com `MissingMethodException`, e o processo fica VIVO
//  sem nunca abrir o RCON — o pior formato possível de falha.
//
//  E não foi azar: o `server-auto-update` dispara justamente
//  quando a Steam anuncia o build, que é a janela em que a
//  "latest" do Oxide ainda é a do build velho. É onde ele SEMPRE
//  cai.
//
//  ------------------------------------------------------------
//  ####  A RÉGUA É A DATA, E NÃO O NÚMERO  ####
//
//  A tag do Oxide (`2.0.7676`) não diz nada sobre o build do Rust,
//  e o corpo da release é texto livre — a 2.0.7676 diz "Patch for
//  September 3rd Rust update", mas a 2.0.7638 veio com o corpo
//  VAZIO. Nada ali dá para automatizar.
//
//  O que sempre existe são duas datas: quando a Facepunch mudou o
//  branch (`timeupdated`, que `steam/builds.ts` já lê) e quando o
//  OxideMod publicou (`published_at`, da API do GitHub). Uma
//  release publicada ANTES do build não pode conhecê-lo.
//
//  A comparação erra para um lado só, e é o lado certo: o Oxide
//  publica MINUTOS depois da Facepunch, então uma release
//  posterior ao build é a release daquele build. O erro possível
//  é adiar uma atualização por alguns minutos a mais — nunca
//  aplicar a incompatível.
// ============================================================

/** A release do Oxide, como o GitHub a descreve. */
export interface OxideRelease {
  /** `2.0.7676`, ou `latest` quando a API não respondeu. */
  readonly tag: string;
  /** Quando o OxideMod publicou. Epoch ms, `null` se não veio. */
  readonly publishedAt: number | null;
  /** De onde baixar o `Oxide.Rust.zip`. */
  readonly zipUrl: string;
}

const RELEASE_API = 'https://api.github.com/repos/OxideMod/Oxide.Rust/releases/latest';

/**
 * A URL que não passa pela API, e por isso nunca esbarra no
 * limite de 60 requisições por hora por IP.
 *
 * O preço de usá-la é não saber o número da versão nem a data —
 * daí `tag: 'latest'` e `publishedAt: null`.
 */
export const FALLBACK_ZIP =
  'https://github.com/OxideMod/Oxide.Rust/releases/latest/download/Oxide.Rust.zip';

export const FALLBACK_RELEASE: OxideRelease = {
  tag: 'latest',
  publishedAt: null,
  zipUrl: FALLBACK_ZIP,
};

export interface FetchReleaseOptions {
  readonly signal?: AbortSignal;
  /** Uma linha para o log da operação quando a API não colabora. */
  readonly onLine?: (line: string) => void;
}

/**
 * A última release, pela API do GitHub.
 *
 * Nunca lança: sem a API ainda dá para baixar o zip pela URL
 * direta, e "não sei a versão" é um desfecho com o qual o resto
 * do arquivo sabe lidar (ver `oxideServesRustBuild`).
 */
export async function fetchLatestOxideRelease(
  options: FetchReleaseOptions = {},
): Promise<OxideRelease> {
  try {
    const response = await fetch(RELEASE_API, {
      signal: options.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RustAgent' },
    });

    if (!response.ok) {
      options.onLine?.(
        `[Oxide] a API do GitHub respondeu ${String(response.status)} — usando a URL direta.`,
      );

      return FALLBACK_RELEASE;
    }

    return parseRelease((await response.json()) as unknown);
  } catch (error) {
    options.onLine?.(
      '[Oxide] não consegui consultar a API do GitHub ' +
        `(${error instanceof Error ? error.message : String(error)}) — usando a URL direta.`,
    );

    return FALLBACK_RELEASE;
  }
}

/**
 * O JSON da release, separado da rede para o teste inspecioná-lo.
 *
 * Campo que falta cai no `FALLBACK_RELEASE`: um asset sem URL ou
 * uma data ilegível valem tanto quanto não ter perguntado.
 */
export function parseRelease(payload: unknown): OxideRelease {
  const release = payload as {
    tag_name?: unknown;
    published_at?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };

  const asset = release.assets?.find((candidate) => candidate.name === 'Oxide.Rust.zip');
  const zipUrl =
    typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : FALLBACK_ZIP;

  const publishedAt =
    typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN;

  return {
    tag: typeof release.tag_name === 'string' ? release.tag_name : 'latest',
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
    zipUrl,
  };
}

/**
 * Esta release conhece aquele build do Rust?
 *
 * ####  NÃO SABER RESPONDE `true`  ####
 *
 * Sem a data do Oxide (a API do GitHub fora do ar) ou sem a do
 * build (a Steam fora do ar), a única resposta honesta é "não dá
 * para dizer" — e recusar por isso pararia toda instalação do
 * agente sempre que um dos dois serviços piscasse. Uma
 * indisponibilidade do GitHub viraria um servidor que não sobe.
 *
 * Quem chama decide o que faz com o `true` incerto; o que este
 * arquivo garante é o `false`, que só sai com as DUAS datas na
 * mão e a do Oxide anterior à do build.
 */
export function oxideServesRustBuild(
  oxidePublishedAt: number | null,
  rustBuildPublishedAt: number | null,
): boolean {
  if (oxidePublishedAt === null || rustBuildPublishedAt === null) {
    return true;
  }

  return oxidePublishedAt >= rustBuildPublishedAt;
}

export interface OxideBehindDetails {
  readonly tag: string;
  readonly oxidePublishedAt: number | null;
  readonly rustBuildId: string;
  readonly rustBuildPublishedAt: number | null;
}

/**
 * Erro dedicado porque o tratamento é único: isto NÃO é uma
 * atualização que deu errado, é uma que ainda não pode começar.
 *
 * Quem trata: o `server-auto-update`, que desiste ANTES de
 * derrubar o servidor, e o vigia da Steam, que não gasta uma das
 * três tentativas do build com isto (ver update-watcher.ts).
 */
export class OxideBehindRustError extends Error {
  readonly details: OxideBehindDetails;

  constructor(details: OxideBehindDetails) {
    super(explainOxideBehind(details));
    this.name = 'OxideBehindRustError';
    this.details = details;
  }
}

/** A frase pronta para o log da operação e para a tela. */
export function explainOxideBehind(details: OxideBehindDetails): string {
  const when = (at: number | null): string =>
    at === null ? 'data desconhecida' : new Date(at).toISOString().replace('T', ' ').slice(0, 16);

  return (
    `o Oxide ainda não lançou a versão do build ${details.rustBuildId} do Rust. A última é a ` +
    `${details.tag}, de ${when(details.oxidePublishedAt)}, e o build saiu em ` +
    `${when(details.rustBuildPublishedAt)} — ou seja, ela foi feita para o build ANTERIOR. ` +
    'Aplicá-la deixaria o servidor subindo e travando no boot (MissingMethodException), com o ' +
    'processo vivo e o RCON mudo. O agente reconfere a cada rodada do vigia e atualiza sozinho ' +
    'assim que o OxideMod publicar — costuma levar de minutos a poucas horas.'
  );
}
