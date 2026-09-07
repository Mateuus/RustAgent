// ============================================================
//  document-transfer.ts  -  O QUE DO TEXTO COLADO VIRA DESENHO,
//  E O QUE CONTINUA SENDO DO DOCUMENTO ABERTO.
//
//  A regra mora aqui, e não dentro do diálogo, porque é ela que
//  precisa de teste: o resto daquele arquivo é caixa de texto e
//  botão.
// ============================================================

import type { UiDocument } from '@/lib/ui-doc/model';

export type PasteResult =
  | { readonly ok: true; readonly document: UiDocument }
  | { readonly ok: false; readonly message: string };

/**
 * Lê o texto colado e o prepara para entrar no editor.
 *
 * Não valida o CONTEÚDO — quem faz isso é o agente, com o mesmo
 * schema do salvar, pela rota de preview. Aqui só se resolve o que
 * é decisão do painel: o que do documento aberto sobrevive à
 * colagem.
 *
 * ####  O IDENTIFICADOR E O DO DESTINO, SEMPRE  ####
 *
 * O `id` é o endereço que o plugin guarda e que todo botão carrega.
 * O agente RECUSA um PUT que o troque, e com razão — trocá-lo
 * quebraria toda referência a ele, em silêncio. O que se transporta
 * é o DESENHO, então ele é reescrito para o documento aberto. É
 * isso, de quebra, que deixa copiar o desenho de uma interface para
 * OUTRA.
 *
 * ####  OS ATALHOS TAMBEM NAO VEM  ####
 *
 * Cada atalho ocupa uma palavra global no servidor: o plugin põe
 * `command` e os atalhos no mesmo mapa. Duas interfaces disputando
 * a mesma palavra fazem uma delas ficar inalcançável no jogo, sem
 * erro nenhum — o mesmo motivo pelo qual copiar uma interface no
 * painel não os leva junto.
 */
export function preparePastedDocument(raw: string, target: UiDocument): PasteResult {
  const text = raw.trim();

  if (text === '') {
    return { ok: false, message: 'Cole aqui o texto copiado da outra interface.' };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message:
        'Isto não é um desenho de interface válido. Confira se você copiou tudo, do primeiro { ao último }.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'O texto colado não é um documento de interface.' };
  }

  const candidate = parsed as Record<string, unknown>;

  // Duas conferências rasas, e só elas: sem `screens` e sem
  // `entryScreenId` o editor não teria o que desenhar, e a recusa do
  // agente ("esperava um array") é mais fria do que a daqui. Todo o
  // resto é problema do schema de lá.
  if (!Array.isArray(candidate.screens) || candidate.screens.length === 0) {
    return {
      ok: false,
      message: 'O texto colado não tem telas. Confira se você copiou o desenho inteiro.',
    };
  }

  if (typeof candidate.entryScreenId !== 'string') {
    return { ok: false, message: 'O texto colado não diz qual é a tela de entrada.' };
  }

  return {
    ok: true,
    document: {
      ...candidate,
      id: target.id,
      shortcuts: target.shortcuts,
    } as UiDocument,
  };
}
