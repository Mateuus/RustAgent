// ============================================================
//  requires-choice.ts  -  a leitura do campo "quem pode ver".
//
//  As mesmas regras de `core/src/quests/requires.ts`, do lado da
//  tela: o campo é uma LISTA separada por vírgula, e qualquer um
//  dos requisitos basta.
//
//  Separado do componente pela regra do painel — o vitest daqui
//  roda em node puro e não monta React —, e a duplicação com o core
//  é deliberada e pequena: aqui é a EDIÇÃO do valor, lá é a decisão
//  sobre quem entra. Cada lado guarda a sua com teste próprio.
// ============================================================

const SEPARATOR = ',';

/** O prefixo do único tipo de requisito que existe hoje. */
const VIP_PREFIX = 'vip:';

/**
 * Os requisitos gravados, em ordem e sem repetição.
 *
 * Vazio = todo mundo vê. `null`, string vazia e uma string só com
 * vírgulas dizem a mesma coisa: tratá-las diferente faria uma quest
 * sumir do menu por causa de um espaço.
 */
export function parseRequires(value: string | null): readonly string[] {
  if (value === null) {
    return [];
  }

  const seen = new Set<string>();

  for (const part of value.split(SEPARATOR)) {
    const trimmed = part.trim();

    if (trimmed !== '') {
      seen.add(trimmed);
    }
  }

  return [...seen];
}

/** O texto que volta para o campo. Lista vazia vira `null`. */
export function formatRequires(values: readonly string[]): string | null {
  const joined = parseRequires(values.join(SEPARATOR)).join(SEPARATOR);

  return joined === '' ? null : joined;
}

/** O requisito de um nível de VIP, na forma que o agente confere. */
export function vipRequirement(tier: string): string {
  return `${VIP_PREFIX}${tier.trim()}`;
}
