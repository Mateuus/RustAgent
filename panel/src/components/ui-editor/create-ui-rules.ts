// ============================================================
//  O que o formulário de "Criar interface" decide sozinho.
//
//  ####  UMA DAS PORTAS FECHA EM SILÊNCIO  ####
//
//  Identificador repetido dá erro em qualquer caminho: o banco tem
//  a coluna única e o core responde 409. O COMANDO repetido não
//  dava nada. O plugin resolve `/menu` para UM documento
//  (`_byCommand`, em Plugins/OrigemZUI.cs) e registra cada palavra
//  uma vez no Oxide — a segunda interface fica viva no banco, na
//  lista do painel, com revisão e tudo, e sem porta de entrada no
//  jogo.
//
//  O core passou a recusar isso em 06/09/2026. O que está aqui é a
//  mesma regra, dita ANTES: quem preencheu o formulário inteiro
//  merece descobrir no campo, e não num toast depois de enviar.
//
//  ####  E É SÓ AVISO: QUEM RECUSA É O AGENTE  ####
//
//  Ele conhece o banco, e entre a lista que a tela recebeu e o
//  INSERT cabe outra aba criando a mesma interface. Divergir daqui
//  não é bug — é a corrida acontecendo, e o 409 é quem a resolve.
// ============================================================

import type { UiDocumentSummary, UiPreset } from '@/lib/api';

/** De onde o desenho da interface nova vem. */
export type Origin = 'blank' | 'preset' | 'copy';

/**
 * As mesmas réguas do schema do agente.
 *
 * Ver `idSchema` e o `command` em core/src/types/ui-document.ts. A
 * do comando é mais estreita de propósito: ele é o que o jogador
 * DIGITA, e o Rust não normaliza maiúscula.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Nome digitado -> identificador provável.
 *
 * Conveniência, e só: o campo continua editável. Sem isto, o
 * identificador vira o lugar onde a pessoa para para pensar num
 * formulário de três campos.
 */
export function toSlug(value: string): string {
  // O intervalo vai ESCAPADO, como em `loot/containers.ts`: escrever
  // U+0300..U+036F literalmente deixaria um acento solto no
  // código-fonte, invisível na revisão.
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export interface CreateUiDraft {
  readonly origin: Origin;
  readonly slug: string;
  readonly name: string;
  readonly command: string;
  /** O modelo escolhido, já resolvido. `null` = nenhum. */
  readonly preset: UiPreset | null;
  /** A interface a copiar. Vazio = nenhuma. */
  readonly sourceId: string;
}

/**
 * O que impede de criar, na frase que a pessoa precisa ler.
 *
 * `null` = pode. A ordem importa: campo vazio antes de formato,
 * formato antes de colisão — é a ordem em que a pessoa preenche, e
 * apontar a colisão de um campo ainda em branco seria falar de um
 * problema que ela não tem.
 */
export function whyNotReady(
  draft: CreateUiDraft,
  documents: readonly UiDocumentSummary[],
): string | null {
  if (draft.origin === 'preset') {
    const preset = draft.preset;

    if (preset === null) {
      return 'Escolha um modelo.';
    }

    // O modelo traz identificador e comando PRÓPRIOS — não há campo
    // para a pessoa corrigir, então a frase precisa dizer o que
    // fazer em vez de só apontar o choque.
    if (documents.some((item) => item.slug === preset.id)) {
      return (
        `Já existe uma interface com o identificador "${preset.id}". Para trazer o desenho novo ` +
        'do modelo para ela, use "Restaurar do modelo" na lista — isso preserva os servidores que ' +
        'já a escolheram.'
      );
    }

    const conflict = whoAnswers(documents, preset.command);

    if (conflict !== null) {
      return `Já existe uma interface respondendo a /${preset.command}, e este modelo nasce com esse comando.`;
    }

    return null;
  }

  if (draft.origin === 'copy' && draft.sourceId === '') {
    return 'Escolha qual interface copiar.';
  }

  if (draft.name.trim() === '') return 'Dê um nome à interface.';
  if (draft.slug.trim() === '') return 'O identificador não pode ficar vazio.';
  if (draft.command.trim() === '') return 'Escolha o comando de chat que abre esta interface.';

  if (!SLUG_PATTERN.test(draft.slug)) {
    return 'O identificador aceita minúsculas, números, hífen e sublinhado, e começa por letra ou número.';
  }

  if (!COMMAND_PATTERN.test(draft.command)) {
    return 'O comando aceita minúsculas, números, ponto, hífen e sublinhado, e começa por letra ou número.';
  }

  if (documents.some((item) => item.slug === draft.slug)) {
    return `Já existe uma interface com o identificador "${draft.slug}".`;
  }

  // ####  ESTE É O QUE FALHA CALADO  ####
  //
  // Ver o cabeçalho: a segunda interface com o mesmo comando fica
  // inalcançável no jogo, e nada em lugar nenhum diz isso.
  const taken = whoAnswers(documents, draft.command);

  if (taken !== null) {
    return `A interface "${taken.name}" já responde a /${draft.command}. O jogo abre só uma delas — escolha outro comando.`;
  }

  return null;
}

/**
 * Quem já responde a este comando. `null` = ninguém.
 *
 * ####  OS ATALHOS CONTAM  ####
 *
 * `/quest` não é o `command` de documento nenhum: é um ATALHO do
 * Menu Principal, e o plugin o põe no mesmo mapa `_byCommand`. Uma
 * interface nova pedindo `quest` ficaria inalcançável do mesmo
 * jeito — e olhar só o `command` deixaria essa colisão passar até
 * o 409 do agente.
 */
function whoAnswers(
  documents: readonly UiDocumentSummary[],
  command: string,
): UiDocumentSummary | null {
  return (
    documents.find(
      (item) => item.command === command || item.shortcuts.includes(command),
    ) ?? null
  );
}
