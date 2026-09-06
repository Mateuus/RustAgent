// ============================================================
//  ranking/reorder.ts  -  mover uma linha de lugar.
//
//  ####  POR QUE ISTO NÃO MORA DENTRO DO COMPONENTE  ####
//
//  Reordenar é a única parte do arrasto que pode estar ERRADA sem
//  aparecer: soltar na terceira posição e a linha ir para a
//  segunda é um defeito que o olho não pega numa lista de sete, e
//  a rota `PUT /rankings/metrics/order` recusa a lista inteira com
//  um erro que não diz "você trocou os índices". Aqui a conta é
//  pura, e o teste do painel roda em node puro — sem DOM, sem
//  simular mouse.
//
//  O resto do arrasto (o `dragstart`, o realce da linha alvo) é
//  desenho, e vive no componente.
// ============================================================

/**
 * A lista com o item de `from` levado para `to`.
 *
 * Índice fora da lista, ou origem igual ao destino, devolve o
 * MESMO array: quem chama compara por identidade para saber se
 * vale a pena gravar, e uma cópia nova a cada `dragover` faria a
 * tela pedir uma gravação que não muda nada.
 */
export function moveInOrder<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length) return items;
  if (to < 0 || to >= items.length) return items;

  const next = [...items];
  const [moved] = next.splice(from, 1);

  // `moved` só é `undefined` se `from` estivesse fora da lista, e
  // isso já foi recusado acima. O `if` existe para o compilador,
  // que não acompanha o `splice`.
  if (moved === undefined) return items;

  next.splice(to, 0, moved);

  return next;
}

/**
 * A ordem é a MESMA nos dois arrays?
 *
 * Serve para não gastar uma gravação com um arrasto que soltou a
 * linha de volta no lugar de onde saiu.
 */
export function sameOrder(a: readonly { readonly id: string }[], b: readonly { readonly id: string }[]): boolean {
  return a.length === b.length && a.every((item, index) => item.id === b[index]?.id);
}
