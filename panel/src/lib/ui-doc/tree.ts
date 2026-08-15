// ============================================================
//  tree.ts  -  mexer na árvore de elementos, sem mutar nada.
//
//  ####  TODA FUNÇÃO AQUI DEVOLVE UMA CÓPIA  ####
//
//  O editor guarda o documento em estado do React, e o React só
//  redesenha quando a referência muda. Uma edição no lugar
//  (`element.color = '#fff'`) funcionaria em memória e NÃO
//  apareceria na tela — o pior tipo de defeito, porque parece que
//  o clique não funcionou.
//
//  Copiar a árvore inteira a cada tecla parece caro e não é: são
//  algumas centenas de objetos rasos, e só o CAMINHO até o
//  elemento editado é de fato recriado.
// ============================================================

import type { UiDocument, UiElement, UiScreen } from './model';

/**
 * Substitui um elemento pela versão devolvida por `edit`.
 *
 * `edit` recebe o elemento e devolve o novo. Devolver o MESMO
 * objeto é legítimo e não custa nada — a árvore acima dele ainda é
 * recriada, e é isso que o React precisa.
 */
export function updateElement(
  elements: readonly UiElement[],
  id: string,
  edit: (element: UiElement) => UiElement,
): readonly UiElement[] {
  return elements.map((element) => {
    if (element.id === id) {
      return edit(element);
    }

    const children = updateElement(element.children, id, edit);

    return children === element.children ? element : { ...element, children };
  });
}

export function removeElement(elements: readonly UiElement[], id: string): readonly UiElement[] {
  return elements
    .filter((element) => element.id !== id)
    .map((element) => ({ ...element, children: removeElement(element.children, id) }));
}

/**
 * Insere `element` dentro de `parentId`, no fim.
 *
 * `parentId` nulo põe na raiz. No fim, e não no começo, porque no
 * CUI a ordem da lista é a PROFUNDIDADE: o que vem depois é
 * desenhado por cima, e quem acabou de criar um elemento espera
 * vê-lo, não encontrá-lo atrás de outro.
 */
export function insertElement(
  elements: readonly UiElement[],
  parentId: string | null,
  element: UiElement,
): readonly UiElement[] {
  if (parentId === null) {
    return [...elements, element];
  }

  return updateElement(elements, parentId, (parent) => ({
    ...parent,
    children: [...parent.children, element],
  }));
}

/**
 * Quem é o pai deste elemento?
 *
 * `undefined` = não achei nesta árvore; `null` = achei, e ele está
 * na raiz. Os dois são respostas diferentes, e confundi-los faria
 * um elemento da raiz parecer inexistente.
 */
export function findParent(
  elements: readonly UiElement[],
  id: string,
  parent: UiElement | null = null,
): UiElement | null | undefined {
  for (const element of elements) {
    if (element.id === id) {
      return parent;
    }

    const found = findParent(element.children, id, element);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * Sobe ou desce um elemento entre os irmãos.
 *
 * ####  ISTO MUDA A PROFUNDIDADE, E NÃO A POSIÇÃO  ####
 *
 * No CUI a ordem da lista é o que decide o que fica por cima. Quem
 * move um elemento na árvore está mudando quem cobre quem — e é
 * por isso que a operação existe separada de arrastar no canvas.
 */
export function moveElement(
  elements: readonly UiElement[],
  id: string,
  direction: -1 | 1,
): readonly UiElement[] {
  const index = elements.findIndex((element) => element.id === id);

  if (index >= 0) {
    const target = index + direction;

    if (target < 0 || target >= elements.length) {
      return elements;
    }

    const copy = [...elements];
    const [moved] = copy.splice(index, 1);

    if (moved !== undefined) {
      copy.splice(target, 0, moved);
    }

    return copy;
  }

  return elements.map((element) => {
    const children = moveElement(element.children, id, direction);

    return children === element.children ? element : { ...element, children };
  });
}

/** Substitui uma tela do documento. */
export function updateScreen(
  document: UiDocument,
  screenId: string,
  edit: (screen: UiScreen) => UiScreen,
): UiDocument {
  return {
    ...document,
    screens: document.screens.map((screen) => (screen.id === screenId ? edit(screen) : screen)),
  };
}

/** Substitui o shell inteiro. */
export function updateShell(
  document: UiDocument,
  edit: (shell: readonly UiElement[]) => readonly UiElement[],
): UiDocument {
  return { ...document, shell: edit(document.shell) };
}

/**
 * O caminho da raiz até o elemento, para a árvore abrir os pais
 * dele.
 *
 * Lista vazia = não está nesta árvore.
 */
export function pathTo(elements: readonly UiElement[], id: string): readonly string[] {
  for (const element of elements) {
    if (element.id === id) {
      return [element.id];
    }

    const below = pathTo(element.children, id);

    if (below.length > 0) {
      return [element.id, ...below];
    }
  }

  return [];
}
