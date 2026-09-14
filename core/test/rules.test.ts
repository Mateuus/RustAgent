// ============================================================
//  rules.test.ts  -  a aba REGRAS, do banco até a tela.
//
//  ####  O QUE ESTE ARQUIVO PROTEGE  ####
//
//  Quatro coisas que quebram em SILÊNCIO — nenhuma delas dá erro
//  no jogo, e as quatro só apareceriam para o jogador:
//
//    1. a herança. Um servidor que herda precisa ler as regras da
//       REDE; um que tem as próprias não pode ver as duas listas
//       misturadas;
//    2. a paginação por altura. Ela existe porque o CUI não tem
//       rolagem: o que passa da caixa SOME, sem aviso;
//    3. a marca `generated` no preset. Sem ela o plugin desenha o
//       esqueleto — a coluna transparente e vazia — e nunca pede o
//       texto. Já aconteceu com as missões, MEDIDO no jogo;
//    4. o `:` numa ação gravada. O `uiDocumentSchema` recusa o
//       documento inteiro, e o menu sumiria do jogo.
// ============================================================

import { describe, expect, it } from 'vitest';

import { MEMORY_DATABASE, openDatabase, type AgentDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { RulesRepository } from '../src/db/rules-repository.js';
import { ServersRepository } from '../src/db/servers-repository.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import {
  buildRulesScreen,
  createRulesScreenProvider,
  emptyRulesView,
  paginateRules,
  parseRulesScreenId,
  readRulesView,
  ruleLineCount,
  RULES_SCREEN_ID,
  RULES_SLOTS,
  rulesScreenId,
  type RulesLine,
  type RulesScreenView,
} from '../src/game/ui-rules-screen.js';
import { RULES_TEMPLATE, type RulesView } from '../src/types/rules.js';
import { uiDocumentSchema, type UiElement, type UiScreen } from '../src/types/ui-document.js';

function open(): { readonly db: AgentDatabase; readonly rules: RulesRepository } {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  new ServersRepository(db).create({
    id: 'pvp1',
    name: 'pvp1',
    identity: 'pvp1',
    gamePort: 28_015,
    rconPort: 28_016,
    queryPort: 28_017,
    appPort: 28_082,
    installDir: 'F:\\Servers\\pvp1',
  });

  return { db, rules: new RulesRepository(db) };
}

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function find(screen: UiScreen, suffix: string): UiElement | undefined {
  return walk(screen.elements).find((element) => element.id.endsWith(suffix));
}

function viewOf(lines: readonly RulesLine[], page = 0): RulesScreenView {
  return {
    ...emptyRulesView(),
    sections: [{ id: 1, title: 'Equipes', count: lines.length }],
    activeId: 1,
    lines,
    page,
    emptyMessage: lines.length === 0 ? 'Esta seção ainda não tem regras.' : null,
  };
}

// ------------------------------------------------------------
//  §1  O BANCO
// ------------------------------------------------------------

describe('o conjunto da rede e o do servidor', () => {
  it('um servidor novo HERDA as regras da rede', () => {
    const { rules } = open();
    const section = rules.createSection(null, { title: 'Equipes', enabled: true });

    rules.createItem(section, { text: 'Máximo de 4 por equipe.', tone: 'normal' });

    const view = rules.viewFor('pvp1');

    expect(view.mode).toBe('inherit');
    expect(view.sections.map((item) => item.title)).toEqual(['Equipes']);
    expect(view.sections[0]?.items[0]?.text).toBe('Máximo de 4 por equipe.');
  });

  it('ter seção própria NÃO tira o servidor da herança', () => {
    // ####  A REGRA MAIS IMPORTANTE DESTE ARQUIVO  ####
    //
    // Se o escopo fosse deduzido da existência de linhas, criar a
    // primeira seção de um servidor apagaria as da rede da tela
    // dele no mesmo instante — um efeito que o admin não pediu e
    // que só apareceria no jogo.
    const { rules } = open();

    rules.createSection(null, { title: 'Da rede', enabled: true });
    rules.createSection('pvp1', { title: 'Só do pvp1', enabled: true });

    expect(rules.viewFor('pvp1').sections.map((item) => item.title)).toEqual(['Da rede']);

    rules.setMode('pvp1', 'own');

    expect(rules.viewFor('pvp1').sections.map((item) => item.title)).toEqual(['Só do pvp1']);
  });

  it('`own` sem seção nenhuma é uma página vazia, e isso é legítimo', () => {
    const { rules } = open();

    rules.createSection(null, { title: 'Da rede', enabled: true });
    rules.setMode('pvp1', 'own');

    expect(rules.viewFor('pvp1').sections).toEqual([]);
  });

  it('a seção desligada some do jogo e fica no painel', () => {
    const { rules } = open();
    const section = rules.createSection(null, { title: 'Rascunho', enabled: false });

    rules.createItem(section, { text: 'Ainda escrevendo.', tone: 'normal' });

    expect(rules.sections(null)).toHaveLength(1);
    expect(rules.sections(null, { onlyEnabled: true })).toHaveLength(0);
  });

  it('copiar da rede acrescenta ao que o servidor já tem, com as regras dentro', () => {
    const { rules } = open();
    const section = rules.createSection(null, { title: 'Equipes', enabled: true });

    rules.createItem(section, { text: 'Máximo de 4.', tone: 'normal' });
    rules.createSection('pvp1', { title: 'Só daqui', enabled: true });

    expect(rules.copySections(null, 'pvp1')).toBe(1);

    const own = rules.sections('pvp1');

    expect(own.map((item) => item.title)).toEqual(['Só daqui', 'Equipes']);
    expect(own[1]?.items.map((item) => item.text)).toEqual(['Máximo de 4.']);
  });

  it('o modelo de fábrica entra inteiro, com as quatro seções do desenho', () => {
    const { rules } = open();

    expect(rules.seedTemplate(null)).toBe(RULES_TEMPLATE.length);
    expect(rules.sections(null).map((item) => item.title)).toEqual(
      RULES_TEMPLATE.map((item) => item.title),
    );
  });

  it('reordenar a rede não mexe nas seções de um servidor', () => {
    const { rules } = open();
    const primeira = rules.createSection(null, { title: 'A', enabled: true });
    const segunda = rules.createSection(null, { title: 'B', enabled: true });
    const doServidor = rules.createSection('pvp1', { title: 'C', enabled: true });

    rules.reorderSections(null, [segunda, primeira]);

    expect(rules.sections(null).map((item) => item.title)).toEqual(['B', 'A']);
    expect(rules.sections('pvp1').map((item) => item.id)).toEqual([doServidor]);
  });

  it('apagar a seção leva as regras dela junto', () => {
    const { db, rules } = open();
    const section = rules.createSection(null, { title: 'Equipes', enabled: true });

    rules.createItem(section, { text: 'Máximo de 4.', tone: 'normal' });

    expect(rules.deleteSection(section)).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS total FROM rules_items').get() as { total: number }).total,
    ).toBe(0);
  });
});

// ------------------------------------------------------------
//  §2  O ENDEREÇO
// ------------------------------------------------------------

describe('o endereço da tela', () => {
  it('lê a seção e a página, e devolve `null` para o que não é dele', () => {
    expect(parseRulesScreenId('tela-regras')).toEqual({ sectionId: null, page: 0 });
    expect(parseRulesScreenId('tela-regras:12')).toEqual({ sectionId: 12, page: 0 });
    expect(parseRulesScreenId('tela-regras:12:3')).toEqual({ sectionId: 12, page: 3 });
    expect(parseRulesScreenId('tela-kits')).toBeNull();
  });

  it('o que vem torto é APARADO, nunca recusado', () => {
    // O pedido veio do plugin e o jogador está com um "carregando"
    // na tela: recusar o deixaria girando até o timeout.
    expect(parseRulesScreenId('tela-regras:abc:xyz')).toEqual({ sectionId: null, page: 0 });
    expect(parseRulesScreenId('tela-regras:12:99999999')?.page).toBe(9_999);
    expect(parseRulesScreenId('tela-regras:-4')?.sectionId).toBeNull();
  });

  it('a primeira página não carrega o número no endereço', () => {
    expect(rulesScreenId(12)).toBe('tela-regras:12');
    expect(rulesScreenId(12, 2)).toBe('tela-regras:12:2');
    expect(rulesScreenId(null)).toBe(RULES_SCREEN_ID);
  });
});

// ------------------------------------------------------------
//  §3  A PAGINAÇÃO, QUE É POR ALTURA
// ------------------------------------------------------------

describe('a paginação das regras', () => {
  const box = { width: 600, height: 100 };

  it('uma regra longa ocupa mais linhas que uma curta', () => {
    const curta = ruleLineCount('Máximo de 4.', 600);
    const longa = ruleLineCount('Máximo de 4 por equipe. '.repeat(8), 600);

    expect(curta).toBe(1);
    expect(longa).toBeGreaterThan(curta);
  });

  it('a página fecha quando a próxima regra não cabe', () => {
    const lines: RulesLine[] = Array.from({ length: 8 }, (_, index) => ({
      text: `Regra ${String(index + 1)}.`,
      tone: 'normal' as const,
    }));

    const primeira = paginateRules(lines, box, 0);

    expect(primeira.pages).toBeGreaterThan(1);
    expect(primeira.lines.length).toBeLessThan(lines.length);
    expect(primeira.firstIndex).toBe(0);

    const segunda = paginateRules(lines, box, 1);

    expect(segunda.firstIndex).toBe(primeira.lines.length);
  });

  it('nenhuma regra se perde entre as páginas', () => {
    // O CUI não tem rolagem: uma regra que não entrou em página
    // nenhuma não existe para o jogador, e ninguém seria avisado.
    const lines: RulesLine[] = Array.from({ length: 25 }, (_, index) => ({
      text: `Regra número ${String(index + 1)}, com um texto de tamanho médio para quebrar.`,
      tone: 'normal' as const,
    }));

    const total = paginateRules(lines, box, 0).pages;
    const vistas: string[] = [];

    for (let page = 0; page < total; page += 1) {
      vistas.push(...paginateRules(lines, box, page).lines.map((line) => line.text));
    }

    expect(vistas).toEqual(lines.map((line) => line.text));
  });

  it('uma regra mais alta que a caixa inteira ainda aparece, sozinha', () => {
    const gigante: RulesLine = { text: 'palavra '.repeat(60), tone: 'normal' };
    const page = paginateRules([gigante], { width: 300, height: 20 }, 0);

    expect(page.lines).toHaveLength(1);
  });

  it('a página pedida é aparada contra o que existe', () => {
    const page = paginateRules([{ text: 'Só uma.', tone: 'normal' }], box, 9_000);

    expect(page.page).toBe(0);
    expect(page.lines).toHaveLength(1);
  });
});

// ------------------------------------------------------------
//  §4  O DESENHO
// ------------------------------------------------------------

describe('a tela desenhada', () => {
  it('a seção aberta vira o título, e as outras viram botão na coluna', () => {
    const view: RulesScreenView = {
      ...emptyRulesView(),
      sections: [
        { id: 1, title: 'Equipes', count: 2 },
        { id: 2, title: 'Cheats', count: 3 },
      ],
      activeId: 2,
      lines: [{ text: 'Nada de cheat.', tone: 'proibido' }],
      emptyMessage: null,
    };

    const screen = buildRulesScreen({ view });
    const titulo = find(screen, RULES_SLOTS.title);

    expect(titulo?.type === 'label' ? titulo.text : '').toBe('CHEATS');

    const coluna = find(screen, RULES_SLOTS.column);
    const itens = walk(coluna?.children ?? []);

    // A aberta é um painel (não se navega para onde já se está); a
    // outra é um botão que leva ao endereço dela.
    expect(itens.find((item) => item.id === 'rgs2')?.type).toBe('panel');

    const outra = itens.find((item) => item.id === 'rgs1');

    expect(outra?.type).toBe('button');
    expect(outra?.type === 'button' ? outra.action.screenId : '').toBe('tela-regras:1');
  });

  it('sem regra nenhuma, a tela DIZ isso em vez de ficar vazia', () => {
    const screen = buildRulesScreen({ view: emptyRulesView() });
    const aviso = find(screen, 'rg-vazio');

    expect(aviso?.type === 'label' ? aviso.text : '').toContain('ainda não publicou');
  });

  it('as regras são numeradas continuando na página seguinte', () => {
    const lines: RulesLine[] = Array.from({ length: 12 }, (_, index) => ({
      text: `Regra ${String(index + 1)} com texto suficiente para ocupar a sua linha inteira.`,
      tone: 'normal' as const,
    }));

    const segunda = buildRulesScreen({
      view: viewOf(lines, 1),
      viewport: { width: 890, height: 200 },
    });

    const primeiraLinha = find(segunda, 'rgl0t');
    const texto = primeiraLinha?.type === 'label' ? primeiraLinha.text : '';

    expect(texto.startsWith('1.')).toBe(false);
    expect(texto).toMatch(/^\d+\.\s/u);
  });

  it('o tom da regra pinta a barra, e só ela', () => {
    const screen = buildRulesScreen({
      view: viewOf([
        { text: 'Proibido.', tone: 'proibido' },
        { text: 'Cuidado.', tone: 'alerta' },
      ]),
    });

    expect(find(screen, 'rgl0')?.color).toBe('#C43F2C');
    expect(find(screen, 'rgl1')?.color).toBe('#E6B265');
  });

  it('o desenho gravado no documento é usado como MODELO', () => {
    // O admin move a caixa e recolore a coluna no editor; o agente
    // derrama o texto dentro do que ele desenhou. Sem a coluna e a
    // caixa, o desenho não vale como modelo e o layout embutido
    // continua — que é o que todo documento antigo tem.
    const template = buildRulesScreen({ view: emptyRulesView(), skeleton: true });
    const screen = buildRulesScreen({
      view: viewOf([{ text: 'Máximo de 4.', tone: 'normal' }]),
      template,
      viewport: { width: 890, height: 500 },
    });

    expect(find(screen, 'rgl0t')).toBeDefined();
    expect(find(screen, RULES_SLOTS.column)?.color).toBe('#262626');
  });

  it('um desenho sem a coluna cai no layout embutido, inteiro', () => {
    const semColuna: UiScreen = { id: RULES_SCREEN_ID, name: 'REGRAS', kind: 'page', elements: [] };

    const screen = buildRulesScreen({
      view: viewOf([{ text: 'Máximo de 4.', tone: 'normal' }]),
      template: semColuna,
    });

    expect(find(screen, RULES_SLOTS.column)).toBeDefined();
  });
});

// ------------------------------------------------------------
//  §5  A LEITURA E O PROVEDOR
// ------------------------------------------------------------

describe('o provedor', () => {
  const document = buildMainMenu();

  function rulesView(sections: RulesView['sections'], mode: RulesView['mode'] = 'inherit'): RulesView {
    return { mode, sections };
  }

  it('a seção apagada vira a primeira, em vez de uma tela vazia', () => {
    const view = readRulesView({
      rules: rulesView([
        { id: 1, title: 'Equipes', enabled: true, position: 10, items: [] },
        { id: 2, title: 'Cheats', enabled: true, position: 20, items: [] },
      ]),
      target: { sectionId: 99, page: 0 },
    });

    expect(view.activeId).toBe(1);
  });

  it('a seção DESLIGADA não pode ser aberta pelo endereço', () => {
    const view = readRulesView({
      rules: rulesView([
        { id: 1, title: 'Equipes', enabled: true, position: 10, items: [] },
        { id: 2, title: 'Rascunho', enabled: false, position: 20, items: [] },
      ]),
      target: { sectionId: 2, page: 0 },
    });

    expect(view.activeId).toBe(1);
    expect(view.sections.map((item) => item.id)).toEqual([1]);
  });

  it('o título da tela NÃO cai em cima do título da coluna', () => {
    // ####  ISTO ACONTECEU, E O DONO VIU NO JOGO  ####
    //
    // 14/09/2026: o título da tela nascia na largura inteira, no
    // x=0, e "APLICAÇÃO DAS REGRAS" era desenhado sobre o "REGRAS"
    // da coluna — os dois ilegíveis. É a divisão que o ranking e as
    // missões já faziam: o nome da tela à esquerda, o do que está
    // aberto à direita.
    const screen = buildRulesScreen({
      view: {
        ...emptyRulesView(),
        sections: [{ id: 1, title: 'Aplicação das Regras', count: 1 }],
        activeId: 1,
        lines: [{ text: 'A administração decide.', tone: 'normal' }],
        emptyMessage: null,
      },
    });

    const titulo = find(screen, RULES_SLOTS.title);
    const coluna = find(screen, RULES_SLOTS.column);

    expect(titulo?.rect.offsetMin.x).toBeGreaterThanOrEqual(coluna?.rect.offsetMax.x ?? 0);
  });

  it('a tela NÃO tem mais a linha de "de onde vêm as regras"', () => {
    // Pedido do dono, vendo no jogo: "isso não precisa mostrar". De
    // onde o texto vem é assunto de quem administra.
    const screen = buildRulesScreen({ view: emptyRulesView() });

    expect(find(screen, RULES_SLOTS.subtitle)).toBeUndefined();
    expect(JSON.stringify(screen)).not.toContain('rede');
  });

  it('responde com o id PEDIDO, e não com o da tela', () => {
    // Um id diferente do pedido faz o plugin descartar a resposta em
    // silêncio, e o jogador fica no "carregando".
    const provider = createRulesScreenProvider({
      viewOf: () => rulesView([{ id: 7, title: 'Equipes', enabled: true, position: 10, items: [] }]),
    });

    const bundle = provider({ serverId: 'pvp1', document, screenId: 'tela-regras:7:1' });

    expect(bundle?.id).toBe('tela-regras:7:1');
    // Volátil: o texto novo vale no clique seguinte, sem esperar o
    // cache de cinco minutos do plugin expirar.
    expect(bundle?.volatile).toBe(true);
  });

  it('não responde pelo que não é dele', () => {
    const provider = createRulesScreenProvider({ viewOf: () => rulesView([]) });

    expect(provider({ serverId: 'pvp1', document, screenId: 'tela-kits' })).toBeNull();
  });

  it('uma falha na leitura vira A TELA com o aviso, nunca silêncio', () => {
    const provider = createRulesScreenProvider({
      viewOf: () => {
        throw new Error('banco fora');
      },
    });

    const bundle = provider({ serverId: 'pvp1', document, screenId: RULES_SCREEN_ID });

    expect(bundle).not.toBeNull();
    expect(bundle?.volatile).toBe(true);
  });
});

// ------------------------------------------------------------
//  §6  O PRESET
// ------------------------------------------------------------

describe('a aba REGRAS no menu', () => {
  const document = buildMainMenu();

  it('a tela gravada é o ESQUELETO, e vai marcada como gerada', () => {
    const screen = document.screens.find((item) => item.id === RULES_SCREEN_ID);

    expect(screen?.generated).toBe(true);
    // A coluna e a caixa precisam existir no desenho: `fillTemplate`
    // preenche o que existe e não cria o que falta.
    expect(find(screen as UiScreen, RULES_SLOTS.column)).toBeDefined();
    expect(find(screen as UiScreen, RULES_SLOTS.list)).toBeDefined();
  });

  it('os atalhos de chat abrem telas que existem no documento', () => {
    const ids = new Set(document.screens.map((screen) => screen.id));

    for (const shortcut of document.shortcuts) {
      expect(ids.has(shortcut.screenId)).toBe(true);
    }

    expect(document.shortcuts.map((shortcut) => shortcut.command)).toEqual(
      expect.arrayContaining(['regras', 'info', 'kits', 'wipe', 'discord']),
    );
  });

  it('o documento com a aba nova continua gravável', () => {
    expect(() => uiDocumentSchema.parse(document)).not.toThrow();
  });
});
