// ============================================================
//  map-levels.ts  -  os mapas que um servidor pode ter, e as
//  faixas de seed e de tamanho de mundo.
//
//  Módulo próprio, e não constantes soltas dentro da criação de
//  servidor, porque três lugares fazem a MESMA pergunta: o
//  formulário do painel, a validação de `POST /api/servers` e a
//  edição de configuração. Uma lista copiada é a que fica para
//  trás no dia em que a Facepunch publicar um mapa novo.
// ============================================================

/**
 * Os níveis aceitos.
 *
 * ####  MAPA POR URL NÃO ENTRA  ####
 *
 * `server.level` aceita a URL de um mapa customizado, e é
 * tentador liberar. O problema é que nada aqui verifica se aquele
 * arquivo existe e se ele bate com a versão do jogo — e o sintoma
 * de errar é um servidor que **não sobe no primeiro boot**,
 * depois de já ter baixado 6 GB.
 *
 * Quando entrar, entra com verificação junto, não como um campo
 * de texto livre.
 */
export const MAP_LEVELS = [
  'Procedural Map',
  'Barren',
  'HapisIsland',
  'Craggy Island',
] as const;

export type MapLevel = (typeof MAP_LEVELS)[number];

/** Faixa do `server.worldsize`. Menor = geração e boot mais rápidos. */
export const MIN_WORLD_SIZE = 1_000;
export const MAX_WORLD_SIZE = 6_000;

/** Faixa do `server.seed`: inteiro de 32 bits com sinal, positivo. */
export const MAX_SEED = 2_147_483_647;

export function isMapLevel(value: string): value is MapLevel {
  return (MAP_LEVELS as readonly string[]).includes(value);
}
