// ============================================================
//  requires.ts  -  quem pode VER aquela quest.
//
//  ####  O CAMPO É UMA LISTA, E QUALQUER UM BASTA  ####
//
//  Pedido do dono em 14/09/2026, olhando o campo de texto livre do
//  editor: "vamos pegar os grupos que temos e aparecer ali o
//  select, aí vai selecionando e ativando" — e, perguntado, foi
//  explícito: quem tiver QUALQUER um dos escolhidos vê.
//
//      ''              todo mundo vê
//      'vip:ouro'      só quem tem ouro
//      'vip:ouro,vip:bronze'   quem tem ouro OU bronze
//
//  ####  POR QUE VÍRGULA, E NÃO UMA COLUNA NOVA  ####
//
//  Porque uma string com um requisito só continua valendo: todo
//  cadastro que existe hoje atravessa esta função sem mudar de
//  significado, e nenhuma migração precisa acontecer para isso ser
//  verdade. A coluna `requires` guarda o que o admin escolheu, e
//  quem sabe lê-la é este arquivo — um lugar só.
//
//  ####  E O VALOR CONTINUA OPACO PARA O SERVIÇO  ####
//
//  `QuestPermissions.can` recebe cada requisito inteiro
//  (`vip:ouro`) e decide. Quem sabe o que cada forma significa é
//  quem conhece o Oxide e a lista de VIP — ver `index.ts`. Aqui só
//  se separa a lista e se combina o resultado.
// ============================================================

/** O separador. Um só, e ele não aparece em nenhum tier. */
const SEPARATOR = ',';

/**
 * Os requisitos de uma quest, em ordem e sem repetição.
 *
 * Lista vazia = todo mundo vê. É o caso de `null`, de string vazia
 * e de uma string só com vírgulas e espaço — todas dizem a mesma
 * coisa, e tratá-las diferente faria uma quest sumir do menu por
 * causa de um espaço.
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

/** O texto que volta para a coluna. Vazio vira `null`. */
export function formatRequires(values: readonly string[]): string | null {
  const joined = parseRequires(values.join(SEPARATOR)).join(SEPARATOR);

  return joined === '' ? null : joined;
}
