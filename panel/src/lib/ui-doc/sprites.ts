// ============================================================
//  SPRITES E MATERIAIS NATIVOS DO RUST
//
//  ####  LISTA CURADA, E CURTA DE PROPÓSITO  ####
//
//  Cada nome aqui saiu de uma fonte que o mostra em uso (ver
//  Docs/OrigemZUI/PLANO.md, seção Fontes). **Não é uma lista
//  completa** — os assets vivem dentro dos bundles do jogo
//  (Rust\Bundles\shared\content.bundle) e a lista exaustiva só
//  sai extraindo o bundle.
//
//  Por que não aceitar texto livre e pronto: um sprite que não
//  existe NÃO dá erro. O elemento simplesmente aparece sem
//  imagem, e quem desenhou vai procurar o problema no tamanho,
//  na cor e na âncora antes de desconfiar do nome. Uma lista
//  curta de nomes que funcionam vale mais que um campo livre que
//  falha em silêncio.
//
//  O campo livre existe assim mesmo, no inspetor, para quem já
//  extraiu o bundle e sabe o que está fazendo. O que não existe
//  é ele ser o CAMINHO PADRÃO.
// ============================================================

export interface SpriteOption {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

/**
 * Sprites confirmados em uso.
 *
 * `ui.background.tile.psd` é o padrão do próprio
 * `CuiImageComponent`, então é o mais seguro de todos.
 */
export const SPRITE_OPTIONS: readonly SpriteOption[] = [
  {
    value: 'assets/content/ui/ui.background.tile.psd',
    label: 'Fundo (padrão)',
    hint: 'O sprite padrão do CuiImageComponent. Fundo neutro, funciona esticado.',
  },
  {
    value: 'assets/content/ui/ui.background.transparent.radial.psd',
    label: 'Degradê radial',
    hint: 'Transparente com degradê do centro para as bordas.',
  },
  {
    value: 'assets/content/ui/ui.background.transparent.linearltr.tga',
    label: 'Degradê horizontal',
    hint: 'Transparente com degradê da esquerda para a direita.',
  },
];

/**
 * Materiais — mudam COMO o sprite é desenhado, não o quê.
 *
 * O de desfoque é o que produz o vidro fosco das janelas do
 * jogo. Ele só tem efeito sobre o que está ATRÁS do elemento,
 * então um painel opaco por cima anula o efeito — motivo pelo
 * qual quem usa desfoque desce o alfa da cor.
 *
 * #### NÃO IMPLEMENTADO AINDA ####
 * O modelo não tem campo `material`. Esta lista está aqui porque
 * ela é o próximo passo natural do inspetor de painel, e porque
 * a pesquisa que a levantou já foi feita — não porque algo a
 * consuma hoje.
 */
export const MATERIAL_OPTIONS: readonly SpriteOption[] = [
  {
    value: 'assets/content/ui/uibackgroundblur.mat',
    label: 'Desfoque',
    hint: 'Desfoca o que está atrás. Exige alfa < 1 na cor para aparecer.',
  },
  {
    value: 'assets/content/ui/uibackgroundblur-ingamemenu.mat',
    label: 'Desfoque (menu)',
    hint: 'A variação usada pelo menu do próprio jogo.',
  },
  {
    value: 'assets/icons/iconmaterial.mat',
    label: 'Ícone',
    hint: 'O material padrão de ícones.',
  },
];
