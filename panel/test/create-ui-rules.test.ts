// ============================================================
//  O que o formulário de "Criar interface" recusa, e por quê.
//
//  ####  UMA DAS PORTAS FECHA EM SILÊNCIO  ####
//
//  Identificador repetido dá erro em qualquer caminho. O COMANDO
//  repetido não dava: o plugin resolve `/menu` para UM documento e
//  a segunda interface fica viva no banco, na lista do painel, com
//  revisão e tudo — e sem porta de entrada no jogo.
//
//  O core passou a recusar isso em 06/09/2026. O que este arquivo
//  guarda é a mesma regra dita ANTES, no campo, para quem preencheu
//  o formulário não descobrir num toast depois de enviar.
// ============================================================

import { describe, expect, it } from 'vitest';

import { toSlug, whyNotReady, type CreateUiDraft } from '@/components/ui-editor/create-ui-rules';
import type { UiDocumentSummary, UiPreset } from '@/lib/api';

const menu: UiDocumentSummary = {
  id: 1,
  slug: 'menu-principal',
  name: 'Menu Principal',
  command: 'menu',
  // `/quest` abre este mesmo menu direto nas missoes. Ele ocupa um
  // nome de comando no servidor como qualquer outro.
  shortcuts: ['quest'],
  revision: 3,
  screens: 11,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
  servers: [],
};

const draft = (over: Partial<CreateUiDraft> = {}): CreateUiDraft => ({
  origin: 'blank',
  slug: 'menu-vip',
  name: 'Menu VIP',
  command: 'vip',
  preset: null,
  sourceId: '',
  ...over,
});

const preset = (over: Partial<UiPreset> = {}): UiPreset => ({
  preset: 'menu-principal',
  id: 'menu-principal',
  name: 'Menu Principal',
  command: 'menu',
  screens: 11,
  ...over,
});

describe('o identificador sugerido a partir do nome', () => {
  it('tira acento, espaço e maiúscula', () => {
    expect(toSlug('Menu de Missões')).toBe('menu-de-missoes');
    expect(toSlug('  VIP  ')).toBe('vip');
  });

  it('não deixa hífen sobrando nas pontas', () => {
    expect(toSlug('!!! eventos !!!')).toBe('eventos');
  });

  it('devolve vazio quando não sobra nada, em vez de um hífen solto', () => {
    expect(toSlug('!!!')).toBe('');
  });
});

describe('o que impede de criar', () => {
  it('deixa criar quando está tudo preenchido e nada colide', () => {
    expect(whyNotReady(draft(), [menu])).toBe(null);
  });

  // ####  ESTE É O QUE FALHA CALADO  ####
  //
  // Ver o cabeçalho: a segunda interface com o mesmo comando fica
  // inalcançável no jogo, e nada em lugar nenhum diz isso.
  it('recusa o comando que outra interface já usa, dizendo qual é ela', () => {
    const problem = whyNotReady(draft({ command: 'menu' }), [menu]);

    expect(problem).toContain('Menu Principal');
    expect(problem).toContain('/menu');
  });

  // ####  O ATALHO OCUPA O MESMO NOME GLOBAL  ####
  //
  // `/quest` nao e o `command` de documento nenhum, e mesmo assim
  // uma interface nova pedindo `quest` ficaria inalcancavel no
  // jogo. Olhar so o `command` deixaria isso passar ate o 409.
  it('recusa o comando que e ATALHO de outra interface', () => {
    const problem = whyNotReady(draft({ command: 'quest' }), [menu]);

    expect(problem).toContain('Menu Principal');
    expect(problem).toContain('/quest');
  });

  it('recusa o identificador repetido', () => {
    expect(whyNotReady(draft({ slug: 'menu-principal' }), [menu])).toContain('menu-principal');
  });

  it('recusa formato inválido antes de falar de colisão', () => {
    // Começar por hífen é o erro que sai de colar um nome.
    expect(whyNotReady(draft({ slug: '-vip' }), [menu])).toContain('identificador aceita');
    expect(whyNotReady(draft({ command: 'VIP' }), [menu])).toContain('comando aceita');
  });

  // A ordem importa: apontar colisão de um campo em branco seria
  // falar de um problema que a pessoa ainda não tem.
  it('pede o campo vazio antes de qualquer outra coisa', () => {
    expect(whyNotReady(draft({ name: '', slug: 'menu-principal' }), [menu])).toBe(
      'Dê um nome à interface.',
    );
  });

  it('a lista vazia não inventa colisão', () => {
    expect(whyNotReady(draft({ command: 'menu' }), [])).toBe(null);
  });
});

describe('quando a origem é um modelo', () => {
  it('manda usar Restaurar do modelo se o identificador dele já existe', () => {
    const problem = whyNotReady(draft({ origin: 'preset', preset: preset() }), [menu]);

    // A frase precisa dizer O QUE FAZER: não há campo para
    // corrigir, porque o identificador é do modelo.
    expect(problem).toContain('Restaurar do modelo');
  });

  it('recusa o modelo cujo comando já está tomado, mesmo com outro identificador', () => {
    const outro = preset({ preset: 'menu-vip', id: 'menu-vip' });

    expect(whyNotReady(draft({ origin: 'preset', preset: outro }), [menu])).toContain('/menu');
  });

  it('não olha os campos de identidade: eles não existem nesta origem', () => {
    const livre = preset({ preset: 'menu-vip', id: 'menu-vip', command: 'vip' });

    expect(
      whyNotReady(draft({ origin: 'preset', preset: livre, name: '', slug: '', command: '' }), [
        menu,
      ]),
    ).toBe(null);
  });
});

describe('quando a origem é uma cópia', () => {
  it('pede a interface de origem antes de tudo', () => {
    expect(whyNotReady(draft({ origin: 'copy' }), [menu])).toBe('Escolha qual interface copiar.');
  });

  it('com a origem escolhida, vale a mesma régua de identidade', () => {
    expect(whyNotReady(draft({ origin: 'copy', sourceId: '1' }), [menu])).toBe(null);
    expect(whyNotReady(draft({ origin: 'copy', sourceId: '1', command: 'menu' }), [menu])).toContain(
      '/menu',
    );
  });
});
