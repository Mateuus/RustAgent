// ============================================================
//  ui-discord-screen.test.ts  -  o botão que respondia
//  "Unknown command: discord".
//
//  O que este arquivo guarda:
//
//    1. o convite aparece como o jogador vai DIGITAR — sem
//       `https://`, sem barra no fim e sem rich text;
//    2. servidor sem Discord tem uma tela que DIZ isso, e não uma
//       tela vazia;
//    3. o menu do modelo não roda mais comando de chat nenhum no
//       botão, e `/discord` é um atalho de verdade;
//    4. o menu que já estava GRAVADO é religado uma vez — e um
//       segundo boot não mexe nele de novo.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  buildDiscordScreen,
  createDiscordScreenProvider,
  DISCORD_SCREEN_ID,
  formatInvite,
  withDiscordScreen,
} from '../src/game/ui-discord-screen.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import {
  findDocumentProblems,
  uiDocumentSchema,
  walkElements,
  type UiDocument,
  type UiElement,
} from '../src/types/ui-document.js';

/** Todo texto desenhado na tela, para perguntar o que ela diz. */
function textsOf(elements: readonly UiElement[]): string[] {
  const texts: string[] = [];

  for (const { element } of walkElements(elements)) {
    if (element.type === 'label') {
      texts.push(element.text);
    }
  }

  return texts;
}

function buttonById(document: UiDocument, id: string): UiElement {
  for (const { element } of walkElements(document.shell)) {
    if (element.id === id) {
      return element;
    }
  }

  throw new Error(`O botão "${id}" não está no cabeçalho.`);
}

describe('o convite, como o jogador vai digitar', () => {
  it('tira o esquema, a barra do fim e o rich text', () => {
    // O admin cola o que o navegador dele copiou.
    expect(formatInvite('https://discord.gg/origemz/')).toBe('discord.gg/origemz');
    expect(formatInvite('  HTTP://discord.gg/OrigemZ  ')).toBe('discord.gg/OrigemZ');
    // `<color=` no meio do endereço pintaria o resto da tela.
    expect(formatInvite('discord.gg/<color=red>x')).toBe('discord.gg/color=redx');
  });

  it('mostra o convite em UM lugar, e grande', () => {
    const screen = buildDiscordScreen({ view: { invite: 'discord.gg/origemz' } });
    const texts = textsOf(screen.elements);

    expect(texts).toContain('discord.gg/origemz');

    const convite = [...walkElements(screen.elements)].find(
      ({ element }) => element.id === 'dc-convite',
    )?.element;

    expect(convite?.type).toBe('label');
    // Ele é lido de um monitor e digitado em outro: tamanho de
    // título, e não de rodapé.
    expect(convite?.type === 'label' ? convite.fontSize : 0).toBeGreaterThanOrEqual(24);
  });

  it('sem convite, a tela DIZ que não há — e não fica vazia', () => {
    const screen = buildDiscordScreen({ view: { invite: '' } });
    const texts = textsOf(screen.elements).join(' ');

    expect(texts).toContain('ainda não divulgou');
    // Uma tela em branco faria o jogador achar que o menu quebrou,
    // que é o que o `Unknown command` já fazia.
    expect(textsOf(screen.elements).length).toBeGreaterThan(1);
  });
});

describe('a página montada por servidor', () => {
  const menu = buildMainMenu();

  it('lê o convite do servidor que pediu', async () => {
    const provider = createDiscordScreenProvider({
      inviteOf: (serverId) => (serverId === 'pvp1' ? 'https://discord.gg/origemz' : ''),
    });

    const bundle = await provider({
      serverId: 'pvp1',
      document: menu,
      screenId: DISCORD_SCREEN_ID,
    });

    expect(bundle).not.toBeNull();
    expect(JSON.stringify(bundle)).toContain('discord.gg/origemz');
    // Nunca fica em cache: trocar o link no painel muda o que o
    // próximo clique desenha.
    expect(bundle?.volatile).toBe(true);
  });

  it('devolve null para o endereço que não é dela', async () => {
    const provider = createDiscordScreenProvider({ inviteOf: () => 'discord.gg/origemz' });

    expect(
      await provider({ serverId: 'pvp1', document: menu, screenId: 'tela-loja' }),
    ).toBeNull();
  });
});

describe('o menu do modelo', () => {
  const menu = buildMainMenu();

  it('não roda mais comando de chat no botão DISCORD', () => {
    const botao = buttonById(menu, 'nav-discord');

    expect(botao.type).toBe('button');
    // A ação de chat era o defeito: ela mandava `/discord` ao
    // servidor, que respondia "Unknown command: discord".
    expect(botao.type === 'button' ? botao.action.kind : null).toBe('navigate');
    expect(botao.type === 'button' && botao.action.kind === 'navigate' ? botao.action.screenId : '')
      .toBe(DISCORD_SCREEN_ID);
  });

  it('registra `/discord` como atalho, e a tela existe', () => {
    expect(menu.shortcuts).toContainEqual({ command: 'discord', screenId: DISCORD_SCREEN_ID });
    expect(menu.screens.some((screen) => screen.id === DISCORD_SCREEN_ID)).toBe(true);
    // Sem a marca, o plugin desenha o repouso gravado e NUNCA pede
    // a tela com o convite de verdade.
    expect(menu.screens.find((screen) => screen.id === DISCORD_SCREEN_ID)?.generated).toBe(true);
    expect(findDocumentProblems(menu)).toEqual([]);
  });
});

describe('o menu que já estava gravado', () => {
  /** O menu como ele era antes desta frente: botão de chat, sem tela. */
  function legacyMenu(): UiDocument {
    const menu = buildMainMenu();

    return uiDocumentSchema.parse({
      ...menu,
      shortcuts: menu.shortcuts.filter((shortcut) => shortcut.command !== 'discord'),
      screens: menu.screens.filter((screen) => screen.id !== DISCORD_SCREEN_ID),
      shell: JSON.parse(
        JSON.stringify(menu.shell).replace(
          '{"id":"ir-discord","kind":"navigate","screenId":"tela-discord"}',
          '{"id":"ir-discord","kind":"chat","command":"/discord"}',
        ),
      ) as unknown,
    });
  }

  it('ganha a tela, o atalho e o botão religado', () => {
    const before = legacyMenu();

    expect(buttonById(before, 'nav-discord').type === 'button').toBe(true);

    const upgraded = withDiscordScreen(before);

    expect(upgraded).not.toBeNull();

    const botao = buttonById(upgraded as UiDocument, 'nav-discord');

    expect(botao.type === 'button' ? botao.action.kind : null).toBe('navigate');
    // O id da AÇÃO não muda: é por ele que o plugin endereça o
    // clique de quem está com o menu aberto agora.
    expect(botao.type === 'button' ? botao.action.id : null).toBe('ir-discord');
    expect((upgraded as UiDocument).shortcuts).toContainEqual({
      command: 'discord',
      screenId: DISCORD_SCREEN_ID,
    });
    // E o resultado continua sendo um documento válido: ele vai
    // direto para o banco, sem passar por revisão de ninguém.
    expect(findDocumentProblems(upgraded as UiDocument)).toEqual([]);
    expect(() => uiDocumentSchema.parse(upgraded)).not.toThrow();
  });

  it('não mexe no menu que já tem a tela', () => {
    // É o segundo boot: sem isto, todo reinício subiria a revisão
    // de todo mundo e pediria "aplicar" de novo.
    expect(withDiscordScreen(buildMainMenu())).toBeNull();
  });

  it('não mexe no menu que não tem botão de Discord', () => {
    const menu = buildMainMenu();
    const semBotao = uiDocumentSchema.parse({
      ...menu,
      shortcuts: menu.shortcuts.filter((shortcut) => shortcut.command !== 'discord'),
      screens: menu.screens.filter((screen) => screen.id !== DISCORD_SCREEN_ID),
      shell: JSON.parse(
        JSON.stringify(menu.shell).replace(/\{"id":"nav-discord".*?\},\{"id":"vip-word"/, '{"id":"vip-word"'),
      ) as unknown,
    });

    expect(withDiscordScreen(semBotao)).toBeNull();
  });
});
