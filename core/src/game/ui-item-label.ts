// ============================================================
//  ui-item-label.ts  -  o nome do item que o JOGADOR lê.
//
//  ####  ISTO NÃO É O NOME DO ITEM  ####
//
//  O nome do item é o `displayName`: "Assault Rifle". Ele é a
//  IDENTIDADE — casa com o shortname, é por ele que o admin procura
//  no painel, e ele é igual em toda instalação do jogo.
//
//  O que este módulo devolve é outra coisa: o RÓTULO, o texto que
//  vai desenhado na tela do jogo. Os dois são diferentes de
//  propósito, e confundi-los foi o defeito que este arquivo veio
//  corrigir — a tela de kits mostrava "Burlap Headwrap" e "Nailgun"
//  para um jogador cujo inventário dizia "Balaclava de Pano" e cujo
//  menu inteiro já estava em português.
//
//  ------------------------------------------------------------
//  ####  O CUI NÃO TRADUZ; QUEM TRADUZ É QUEM ESCREVE  ####
//
//  Uma tela de CUI não tem token de tradução: ela imprime a string
//  literal que o servidor mandou, e o cliente não tem como
//  reescrevê-la. Então a escolha do idioma acontece AQUI, no
//  agente, e em nenhum outro lugar depois.
//
//  ####  E A TRADUÇÃO NÃO É NOSSA  ####
//
//  O `displayNamePtBr` é o que a Facepunch traduziu, lido do
//  próprio servidor — ver o cabeçalho da migração 055. É isso que
//  faz o nome do menu bater LETRA POR LETRA com o do inventário do
//  jogador. Um nome inventado por nós, por melhor que fosse, diria
//  uma coisa onde o inventário diz outra, e o jogador não acharia
//  o item.
//
//  ####  E A QUEDA É PARA O INGLÊS, NUNCA PARA O VAZIO  ####
//
//  201 dos 1.259 itens do catálogo não têm tradução no jogo
//  (veículos e itens internos, na maioria) — MEDIDO. Para eles o
//  rótulo é o inglês, que é exatamente o que a tela já mostrava:
//  item sem tradução não regride, só não melhora.
// ============================================================

/** O que este módulo precisa saber de um item. */
export interface ItemLabelSource {
  readonly displayName: string;
  /** `null` = o jogo não traduz este item. Ver a migração 055. */
  readonly displayNamePtBr?: string | null | undefined;
}

/**
 * O texto que vai na tela do jogo.
 *
 * Português quando o jogo traduz; inglês quando não. Nunca vazio —
 * o `displayName` é obrigatório, e é ele que segura o piso.
 */
export function screenLabelOf(item: ItemLabelSource): string {
  const translated = item.displayNamePtBr;

  // Não é `??` sozinho: a string vazia precisa cair para o inglês
  // também. Ela não deveria chegar aqui (o plugin já a descarta, e
  // o schema exige `min(1)`), mas uma linha gravada por uma versão
  // anterior dessas duas regras deixaria a tela com um rótulo em
  // branco ao lado do ícone — e um branco na tela não tem como ser
  // diagnosticado por quem vê.
  return translated === null || translated === undefined || translated === ''
    ? item.displayName
    : translated;
}
