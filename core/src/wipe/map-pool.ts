// ============================================================
//  map-pool.ts  -  as REGRAS da fila de mapas, sem banco e sem
//  rota.
//
//  Aqui mora o que dá para decidir só olhando os valores: uma
//  seed é válida? um tamanho de mundo cabe? uma URL de `.map`
//  tem cara de `.map`? qual seed sortear evitando as que já
//  estão prometidas?
//
//  O repositório (db/map-pool-repository.ts) usa este arquivo e
//  acrescenta o banco; a rota (http/routes/wipe-maps.ts) usa os
//  dois e acrescenta o HTTP.
//
//  ------------------------------------------------------------
//  ####  A FILA GUARDA A DECISÃO, E NÃO O MUNDO  ####
//
//  Num mapa procedural o arquivo do terreno nem existe antes de
//  o servidor subir: quem o gera é o próprio Rust, no boot, a
//  partir da seed. "Seed 18422, tamanho 4000" É o mapa.
//
//  É por isso que a fila pode ser preenchida com meses de
//  antecedência sem risco nenhum: a frase continua valendo depois
//  da atualização mensal do jogo, enquanto um `.map` gerado hoje
//  pode não carregar no binário de amanhã. Ver Docs\16 §9.1.
//
//  ------------------------------------------------------------
//  ####  SEED É TEXTO  ####
//
//  Ela é transportada, comparada e exibida — nunca somada. Como
//  texto ela atravessa o `.ini`, o RCON e a URL do RustMaps sem
//  ganhar um `.0` no caminho. `normalizeSeed` existe para "007" e
//  "7" não virarem duas linhas do que é a mesma seed: o índice
//  único do banco compara TEXTO.
// ============================================================

import { MAP_LEVELS, type MapLevel } from '../types/wipe.js';

/** Faixa aceita pelo `server.worldsize`. Ver Configs\server.example.ini. */
export const MIN_WORLD_SIZE = 1_000;
export const MAX_WORLD_SIZE = 6_000;

/** Faixa do `server.seed`: inteiro de 32 bits com sinal, positivo. */
export const MAX_SEED = 2_147_483_647;

/**
 * O tamanho de mundo de uma entrada sorteada, quando ninguém
 * disse qual.
 *
 * Quatro mil é o tamanho que a maioria dos servidores de PVP usa,
 * e é o que aparece nas telas do Docs\16. Quem sabe o tamanho de
 * verdade é quem conhece o servidor — por isso todo caminho que
 * sorteia aceita um `worldSize` explícito, e este número só vale
 * quando nenhum veio.
 */
export const DEFAULT_WORLD_SIZE = 4_000;

/**
 * Quantos wipes para trás o aviso de "já jogamos esta seed" olha.
 *
 * Seis é meio ano de wipe mensal, ou um mês e meio de semanal —
 * tempo em que a base ainda lembra do mapa. Mais que isso, o
 * aviso viraria ruído sobre um mundo que ninguém reconheceria.
 */
export const RECENT_WIPES_WINDOW = 6;

/**
 * Teto do `.map` que o agente aceita na fila.
 *
 * Um mapa custom de Rust fica na casa das dezenas de megabytes;
 * meio giga é arquivo errado (ou um servidor de download que
 * respondeu uma página de erro com `Content-Length` gigante). O
 * limite não é sobre disco: é sobre descobrir o engano ANTES do
 * wipe, e não com o mundo velho já apagado.
 */
export const MAX_MAP_BYTES = 512 * 1024 * 1024;

/** Quanto tempo o `HEAD` da URL do mapa espera, em ms. */
export const MAP_URL_TIMEOUT_MS = 10_000;

/**
 * Texto -> seed válida, ou `null`.
 *
 * Reescrita a partir do número: "007" e "7" são a mesma seed, e
 * duas linhas com as duas grafias passariam pelo índice único
 * como se fossem mundos diferentes.
 */
export function normalizeSeed(value: string): string | null {
  const trimmed = value.trim();

  // O teto de dígitos evita transformar uma string de 400
  // caracteres num `Number` só para descobrir que ela não serve.
  if (!/^\d{1,10}$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SEED) {
    return null;
  }

  return String(parsed);
}

/** O tamanho do mundo cabe no que o jogo aceita? */
export function isValidWorldSize(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_WORLD_SIZE && value <= MAX_WORLD_SIZE;
}

/** É um dos quatro mundos que o jogo já traz? */
export function isKnownLevel(value: string): value is MapLevel {
  return (MAP_LEVELS as readonly string[]).includes(value);
}

/**
 * Sorteia uma seed que ninguém está esperando jogar.
 *
 * `taken` traz o que já está na fila e o que os últimos wipes
 * usaram — as duas coisas juntas, porque sortear o mapa da semana
 * passada é tão ruim quanto sortear o que já está prometido para
 * a que vem.
 *
 * Vinte tentativas: com 2^31 seeds possíveis, a chance de vinte
 * colisões seguidas é indistinguível de zero — e o laço limitado
 * garante que um banco em estado estranho não trave o processo
 * que atende HTTP. Esgotou, devolve `null`, e quem chamou decide
 * o que dizer.
 */
export function drawSeed(
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
  attempts = 20,
): string | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = String(Math.floor(random() * (MAX_SEED + 1)));

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ------------------------------------------------------------
//  O mapa custom, e a trava dele
// ------------------------------------------------------------

/**
 * O que o `HEAD` na URL do `.map` descobriu.
 *
 * `ok: false` NÃO é uma falha do agente: é a resposta honesta de
 * "este arquivo não serve", e ela precisa chegar à tela antes de
 * a entrada existir na fila. Ver Docs\16 §9.1: aceitar a URL sem
 * conferir faria o admin achar que o próximo wipe está resolvido,
 * e o servidor não subiria na madrugada.
 */
export type MapUrlCheck =
  | {
      readonly ok: true;
      /** A URL normalizada, que é a que vai para o `.ini`. */
      readonly url: string;
      /** `Content-Length`, quando o servidor mandou. `null` = não disse. */
      readonly bytes: number | null;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'MAP_URL_INVALID'
        | 'MAP_URL_NOT_A_MAP'
        | 'MAP_URL_UNREACHABLE'
        | 'MAP_URL_TOO_BIG';
      readonly message: string;
    };

/** Quem confere uma URL de mapa. Injetável para o teste não sair na rede. */
export type MapUrlChecker = (url: string) => Promise<MapUrlCheck>;

/**
 * A conferência que dá para fazer sem sair da máquina: a URL é
 * http(s)? o caminho termina em `.map`?
 *
 * Separada do `HEAD` de propósito — ela é síncrona, é a que a
 * tela pode repetir enquanto a pessoa digita, e é a que o teste
 * exercita sem rede nenhuma.
 */
export function validateMapUrl(raw: string): MapUrlCheck {
  const trimmed = raw.trim();

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: 'MAP_URL_INVALID',
      message:
        `"${trimmed}" não é um endereço. O mapa custom entra por um link http:// ou ` +
        'https:// que aponte direto para o arquivo .map.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'MAP_URL_INVALID',
      message:
        `O endereço precisa ser http:// ou https:// — "${parsed.protocol}" o servidor de Rust ` +
        'não sabe baixar.',
    };
  }

  if (!parsed.pathname.toLowerCase().endsWith('.map')) {
    return {
      ok: false,
      code: 'MAP_URL_NOT_A_MAP',
      message:
        'O link precisa terminar em .map — é o arquivo do mundo. Uma página do RustMaps ou ' +
        'um link de compartilhamento não servem: o jogo baixa o arquivo, e não a página.',
    };
  }

  return { ok: true, url: parsed.toString(), bytes: null };
}

/**
 * A conferência de verdade: pergunta ao servidor do arquivo.
 *
 * ####  `HEAD` ANTES, E NÃO DEPOIS  ####
 *
 * O passo `apagar` do wipe é irreversível. Descobrir que a URL do
 * mapa não responde DEPOIS dele é ficar com o mundo velho apagado
 * e o novo inexistente — por isso a validação acontece na hora de
 * entrar na fila, com semanas de folga para consertar.
 *
 * Uma resposta sem `Content-Length` não é recusa: há servidor de
 * arquivo que não manda o cabeçalho, e recusar por isso barraria
 * um mapa bom. O tamanho é conferido quando ele vem.
 */
export function createMapUrlChecker(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = MAP_URL_TIMEOUT_MS,
): MapUrlChecker {
  return async (raw: string): Promise<MapUrlCheck> => {
    const shape = validateMapUrl(raw);

    if (!shape.ok) {
      return shape;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(shape.url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          code: 'MAP_URL_UNREACHABLE',
          message:
            `O endereço respondeu ${String(response.status)}. O servidor de Rust baixa esse ` +
            'arquivo no boot — se ele não estiver lá na hora do wipe, o servidor não sobe.',
        };
      }

      const header = response.headers.get('content-length');
      const bytes = header === null ? null : Number(header);
      const size = bytes !== null && Number.isFinite(bytes) ? bytes : null;

      if (size !== null && size > MAX_MAP_BYTES) {
        return {
          ok: false,
          code: 'MAP_URL_TOO_BIG',
          message:
            `O arquivo tem ${String(Math.round(size / 1024 / 1024))} MB, acima do teto de ` +
            `${String(MAX_MAP_BYTES / 1024 / 1024)} MB. Confira se o link aponta mesmo para o ` +
            '.map do mundo.',
        };
      }

      return { ok: true, url: shape.url, bytes: size };
    } catch (error) {
      return {
        ok: false,
        code: 'MAP_URL_UNREACHABLE',
        message:
          `Não consegui alcançar o endereço: ${error instanceof Error ? error.message : String(error)}. ` +
          'O servidor de Rust baixa esse arquivo no boot — sem ele o mundo não carrega.',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * A frase que explica por que um mapa custom não entra num wipe
 * FORÇADO sem a marca do admin.
 *
 * Mora aqui, e não na rota, porque quem consome a fila na hora do
 * wipe (a execução, Frente D) precisa dizer a mesma coisa no log.
 */
export const CUSTOM_IN_FORCED_REASON =
  'mapa custom sem a marca "compatível com a versão nova": o wipe forçado troca o binário do ' +
  'jogo, e um .map gerado na versão de ontem pode não carregar na de hoje';
