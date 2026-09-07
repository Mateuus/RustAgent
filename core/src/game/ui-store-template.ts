// ============================================================
//  ui-store-template.ts  -  os modais da loja, desenhados no
//  editor.
//
//  O modal de compra e o de resultado nascem no código
//  (ui-store-screens.ts). Isso funciona, mas tira do painel a única
//  parte da interface que o admin não consegue mexer: mover o
//  botão, trocar uma cor ou o texto exigiria editar TypeScript.
//
//  Este arquivo dá o meio-termo: o admin desenha o modal no editor,
//  e o agente PREENCHE os campos.
//
//  ------------------------------------------------------------
//  ####  O MECANISMO NÃO MORA MAIS AQUI  ####
//
//  `fillTemplate`, `SlotValue` e `findTemplate` nasceram neste
//  arquivo e nunca tiveram nada de loja: são de `ui-template.ts`
//  desde 06/09/2026, quando o ranking passou a precisar deles.
//  Enquanto moravam aqui, desenhar uma tela de ranking obrigava a
//  importar "o template da loja".
//
//  O que ficou é o que É da loja: quais telas ela reconhece e quais
//  sufixos ela preenche. O porquê de tudo — a ação ser sempre do
//  agente, a convenção de sufixo quebrar em silêncio, o layout
//  embutido continuar valendo sem a tela no documento — está no
//  cabeçalho de `ui-template.ts`.
// ============================================================

import { fillTemplate, findTemplate, type SlotValue } from './ui-template.js';

// ####  REEXPORTADOS PARA NÃO PARTIR A LOJA EM DOIS IMPORTS  ####
//
// `ui-store-screens.ts` pede `SLOTS` e `fillTemplate` do mesmo
// lugar, e é a leitura certa: dali se vê "os slots da loja, e o
// preenchedor". Quem escreve tela NOVA importa de `ui-template.ts`.
export { fillTemplate, findTemplate, type SlotValue };

/** A tela que serve de base para o modal de compra de ITEM. */
export const BUY_TEMPLATE_ID = 'ozmodalcompra';

/**
 * A base do modal de KIT, VIP e VEÍCULO.
 *
 * ####  ELE PRECISA DE UM SLOT, E O DE ITEM NÃO  ####
 *
 * Um modelo é um desenho FIXO. Isso basta para o modal de um item,
 * onde tudo o que muda é texto — mas a lista de um kit tem N linhas,
 * e nenhum layout estático abre espaço para três itens hoje e sete
 * amanhã.
 *
 * A saída é um elemento VAZIO marcando onde a lista mora. O admin
 * escolhe a posição e o tamanho dele; o agente derrama as linhas
 * dentro. Ver `children` em `SlotValue`.
 */
export const BUNDLE_TEMPLATE_ID = 'ozmodalpacote';

/** A tela que serve de base para o aviso de resultado. */
export const RESULT_TEMPLATE_ID = 'ozmodalresultado';

/**
 * Os sufixos que o agente reconhece.
 *
 * Mudar um destes exige regerar o preset do menu — ver
 * game/ui-preset-main-menu.ts.
 */
export const SLOTS = {
  // ---- modal de compra de item ----
  nome: 'mcnome',
  icone: 'mcicone',
  descricao: 'mcdesc',
  quantidade: 'mcqtd',
  total: 'mctotal',
  saldo: 'mcsaldo',
  menos: 'mcmenos',
  mais: 'mcmais',
  comprar: 'mccomprar',
  cancelar: 'mccancelar',

  // ---- modal de kit, VIP e veículo ----
  pacoteNome: 'mbnome',
  pacoteIcone: 'mbicone',
  pacoteResumo: 'mbdesc',
  pacoteTitulo: 'mbtitulo',
  /** O elemento VAZIO onde a lista é derramada. */
  pacoteLista: 'mblista',
  pacoteTotal: 'mbtotal',
  pacoteSaldo: 'mbsaldo',
  pacoteComprar: 'mbcomprar',
  pacoteCancelar: 'mbcancelar',

  // ---- aviso de resultado ----
  titulo: 'mrtitulo',
  mensagem: 'mrmsg',
  saldoResultado: 'mrsaldo',
  ok: 'mrok',
} as const;

