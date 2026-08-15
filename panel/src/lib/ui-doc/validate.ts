// ============================================================
//  validate.ts  -  o que o modelo não expressa sozinho.
//
//  ####  ISTO NÃO SUBSTITUI A VALIDAÇÃO DO AGENTE  ####
//
//  O core recusa o documento na gravação (`findDocumentProblems`
//  em core/src/types/ui-document.ts), e é ele quem manda. Isto
//  aqui existe para AVISAR quem desenha, ENQUANTO desenha — a
//  diferença entre ver "este botão leva a uma tela apagada"
//  enquanto o botão está selecionado e descobrir isso num 400
//  depois de meia hora de trabalho.
//
//  MUDAR UMA REGRA EXIGE MUDAR OS DOIS ARQUIVOS. Quando eles
//  divergem, quem ganha é o core: o editor pode deixar passar, o
//  agente não.
// ============================================================

import {
  countElements,
  maxDepth,
  walkElements,
  MAX_ELEMENTS_PER_SCREEN,
  MAX_ELEMENT_DEPTH,
  type UiDocument,
  type UiElement,
} from './model';

export interface DocumentProblem {
  readonly message: string;
  /**
   * Onde clicar para chegar ao problema.
   *
   * É o que separa um aviso útil de uma lista de reclamações: sem
   * o id, "há um botão quebrado" obriga a caçar qual.
   */
  readonly screenId?: string;
  readonly elementId?: string;
}

/**
 * Todos os problemas do documento, e não o primeiro.
 *
 * Quem está desenhando quer a lista inteira à vista, para decidir
 * o que consertar primeiro — parar no primeiro erro faria a
 * mensagem mudar a cada correção.
 */
export function findDocumentProblems(document: UiDocument): readonly DocumentProblem[] {
  const problems: DocumentProblem[] = [];
  const screenIds = new Set(document.screens.map((screen) => screen.id));

  if (!screenIds.has(document.entryScreenId)) {
    problems.push({ message: 'A tela de entrada não existe. Sem ela o menu não abre no jogo.' });
  }

  if (screenIds.size !== document.screens.length) {
    problems.push({ message: 'Há telas com o mesmo identificador.' });
  }

  const slotIds = new Set<string>();

  for (const { element } of walkElements(document.shell)) {
    slotIds.add(element.id);
  }

  if (document.contentSlotId !== null && !slotIds.has(document.contentSlotId)) {
    problems.push({
      message:
        'O slot de conteúdo não é um elemento do cabeçalho. Sem ele, as telas seriam desenhadas ' +
        'na raiz e apareceriam por cima da moldura.',
    });
  }

  // Ao contrário do de conteúdo — ver o mesmo comentário no core.
  // Um painel transparente de tela cheia no cabeçalho engole todos
  // os cliques, e o menu abre sem nenhum botão responder.
  if (document.modalSlotId !== null && slotIds.has(document.modalSlotId)) {
    problems.push({
      message:
        'O slot de modal NÃO pode ser um elemento do cabeçalho: um painel transparente por cima ' +
        'da tela engole todos os cliques. Quem o cria é o plugin, só enquanto há um modal aberto.',
    });
  }

  // Elementos e ações dividem o espaço de nomes: um id repetido
  // entre os dois faria o plugin resolver a ação errada.
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  const note = (id: string): void => {
    if (seen.has(id)) {
      duplicated.add(id);
    }

    seen.add(id);
  };

  const checkButton = (element: UiElement, screenId?: string): void => {
    if (element.type !== 'button') {
      return;
    }

    note(element.action.id);

    if (
      (element.action.kind === 'navigate' || element.action.kind === 'modal.open') &&
      !screenIds.has(element.action.screenId)
    ) {
      problems.push({
        message: `O botão "${element.name}" leva a uma tela que não existe.`,
        ...(screenId === undefined ? {} : { screenId }),
        elementId: element.id,
      });
    }

    if (element.action.kind === 'chat' && element.action.command.trim() === '') {
      problems.push({
        message: `O botão "${element.name}" roda um comando de chat vazio.`,
        ...(screenId === undefined ? {} : { screenId }),
        elementId: element.id,
      });
    }
  };

  for (const { element } of walkElements(document.shell)) {
    note(element.id);
    checkButton(element);
  }

  for (const screen of document.screens) {
    note(screen.id);

    for (const { element } of walkElements(screen.elements)) {
      note(element.id);
      checkButton(element, screen.id);
    }

    const count = countElements(screen.elements);

    if (count > MAX_ELEMENTS_PER_SCREEN) {
      problems.push({
        message:
          `A tela "${screen.name}" tem ${String(count)} elementos (o limite é ` +
          `${String(MAX_ELEMENTS_PER_SCREEN)}).`,
        screenId: screen.id,
      });
    }

    const deepest = maxDepth(screen.elements);

    if (deepest > MAX_ELEMENT_DEPTH) {
      problems.push({
        message:
          `A tela "${screen.name}" aninha ${String(deepest)} níveis (o limite é ` +
          `${String(MAX_ELEMENT_DEPTH)}).`,
        screenId: screen.id,
      });
    }
  }

  for (const id of duplicated) {
    problems.push({ message: `Identificador repetido: "${id}".` });
  }

  return problems;
}
