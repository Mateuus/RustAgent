// ============================================================
//  ui-team-screen.test.ts  -  a aba EQUIPE do menu.
//
//  ####  O QUE PRECISA DE TESTE AQUI, E POR QUÊ  ####
//
//  Esta tela mexe na equipe de gente de verdade: ela expulsa, ela
//  passa liderança, ela renomeia. O CUI só o cliente resolve —
//  não dá para ver a tela daqui —, então o que se pode provar sem
//  o jogo é justamente o que mais importa:
//
//    1. QUEM PODE O QUÊ. A tabela do §5 é a mesma que desenha o
//       botão e a que cobra o clique; se as duas divergirem, o
//       defeito só aparece quando alguém clica;
//    2. O ENDEREÇO. Ele é digitável no F1 — `tela-equipe:kick:X`
//       com qualquer X — e precisa cair de pé;
//    3. A GEOMETRIA. Nada pode ser desenhado fora da moldura: um
//       membro desenhado do lado de fora não aparece, sem erro
//       nenhum, e vem com um botão de expulsar junto;
//    4. O ORÇAMENTO. O documento inteiro viaja num frame de RCON.
//
//  Ver Docs/OrigemZTeam/01-A-ABA-EQUIPE-DO-MENU.md.
// ============================================================

import { describe, expect, it } from 'vitest';

import { resolveRect, type Size } from '../src/game/ui-geometry.js';
import {
  buildTeamScreen,
  parseTeamScreenId,
  TEAM_ACTION_PREFIX,
  TEAM_COMMANDS,
  TEAM_SCREEN_ID,
  withTeamTab,
} from '../src/game/ui-team-screen.js';
import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import { rankCan, rankOutranks, type Team, type TeamMember } from '../src/types/teams.js';
import type { UiElement } from '../src/types/ui-document.js';

// ------------------------------------------------------------
//  FIXTURES
//
//  ####  ELAS TÊM A FORMA QUE O JOGO RESPONDE  ####
//
//  `teamId` é TEXTO porque é um ulong e passa de 2^53;
//  `ageSeconds` conta do boot do servidor e não é data; e `name`
//  nasce vazio, que é o estado real de toda equipe que ninguém
//  batizou — medido no server01 em 15/09/2026.
// ------------------------------------------------------------

function member(over: Partial<TeamMember> & { steamId: string }): TeamMember {
  return {
    name: `Jogador ${over.steamId.slice(-2)}`,
    online: true,
    leader: false,
    rank: 'member',
    ...over,
  };
}

const LEADER = '76561198000000001';
const OFFICER = '76561198000000002';
const PLAIN = '76561198000000003';
const OTHER = '76561198000000004';

function team(over: Partial<Team> = {}): Team {
  const members = over.members ?? [
    member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
    member({ steamId: OFFICER, name: 'Bia', rank: 'officer' }),
    member({ steamId: PLAIN, name: 'Caio' }),
    member({ steamId: OTHER, name: 'Dani', online: false }),
  ];

  return {
    teamId: '18446744073709551615',
    name: '',
    leader: LEADER,
    leaderName: 'Mateuus',
    ageSeconds: 3600,
    invites: [],
    officers: members.filter((entry) => entry.rank === 'officer').length,
    ...over,
    members,
  };
}

function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

/** Os textos de todos os botões da tela. */
function buttonsOf(elements: readonly UiElement[]): string[] {
  return walk(elements)
    .filter((element) => element.type === 'button')
    .map((element) => (element.type === 'button' ? element.text : ''));
}

/** As ações de compra — as que chegam ao agente. */
function offersOf(elements: readonly UiElement[]): string[] {
  return walk(elements).flatMap((element) => {
    if (element.type === 'button' && element.action.kind === 'store.buy') {
      return [element.action.offerId];
    }

    if (element.type === 'input') {
      return [element.action.offerId];
    }

    return [];
  });
}

function screenFor(steamId: string, over: Partial<Team> = {}): readonly UiElement[] {
  return buildTeamScreen({ steamId, team: team(over), maxSize: 8 }).elements;
}

// ============================================================
//  §1  QUEM PODE O QUÊ
// ============================================================

describe('a tabela de cargos', () => {
  it('dá ao líder as quatro coisas, e ao membro nenhuma', () => {
    expect(rankCan('leader', 'rename')).toBe(true);
    expect(rankCan('leader', 'rank')).toBe(true);
    expect(rankCan('leader', 'leader')).toBe(true);
    expect(rankCan('leader', 'kick')).toBe(true);

    expect(rankCan('member', 'rename')).toBe(false);
    expect(rankCan('member', 'rank')).toBe(false);
    expect(rankCan('member', 'leader')).toBe(false);
    expect(rankCan('member', 'kick')).toBe(false);
  });

  it('dá ao oficial só o expulsar — a decisão do dono de 15/09', () => {
    expect(rankCan('officer', 'kick')).toBe(true);

    // O nome é a identidade da equipe: ele aparece no KOTH, para o
    // servidor inteiro. Não é operação do dia a dia.
    expect(rankCan('officer', 'rename')).toBe(false);
    expect(rankCan('officer', 'rank')).toBe(false);
    expect(rankCan('officer', 'leader')).toBe(false);
  });

  it('só age para BAIXO: oficial não alcança oficial nem líder', () => {
    expect(rankOutranks('officer', 'member')).toBe(true);
    expect(rankOutranks('officer', 'officer')).toBe(false);
    expect(rankOutranks('officer', 'leader')).toBe(false);

    expect(rankOutranks('leader', 'officer')).toBe(true);
    expect(rankOutranks('leader', 'member')).toBe(true);
    // E nem o líder age sobre outro líder: só há um, e é ele.
    expect(rankOutranks('leader', 'leader')).toBe(false);
  });
});

// ============================================================
//  §2  O QUE CADA UM VÊ
// ============================================================

describe('a tela, por quem a abre', () => {
  it('o líder vê promover, dar liderança e expulsar', () => {
    const botoes = buttonsOf(screenFor(LEADER));

    expect(botoes).toContain('PROMOVER');
    expect(botoes).toContain('DAR LIDERANÇA');
    expect(botoes).toContain('EXPULSAR');
  });

  it('o líder vê REBAIXAR no oficial, e PROMOVER no membro', () => {
    const botoes = buttonsOf(screenFor(LEADER));

    // Um botão só, que diz para onde VAI — o cargo já está escrito
    // ao lado.
    expect(botoes.filter((texto) => texto === 'REBAIXAR')).toHaveLength(1);
    expect(botoes.filter((texto) => texto === 'PROMOVER')).toHaveLength(2);
  });

  it('o oficial vê expulsar, e só sobre membro', () => {
    const elementos = screenFor(OFFICER);
    const botoes = buttonsOf(elementos);

    expect(botoes).toContain('EXPULSAR');
    expect(botoes).not.toContain('PROMOVER');
    expect(botoes).not.toContain('DAR LIDERANÇA');

    // Dois membros comuns, e nem o líder nem ele mesmo.
    const alvos = offersOf(elementos).filter((id) => id.startsWith(`${TEAM_ACTION_PREFIX}kick`));

    expect(alvos).toHaveLength(0); // expulsar passa pela confirmação, que é navegação
    expect(botoes.filter((texto) => texto === 'EXPULSAR')).toHaveLength(2);
  });

  it('o membro comum não vê botão nenhum sobre os outros', () => {
    const botoes = buttonsOf(screenFor(PLAIN));

    expect(botoes).not.toContain('EXPULSAR');
    expect(botoes).not.toContain('PROMOVER');
    expect(botoes).not.toContain('DAR LIDERANÇA');

    // Mas sair é dele, e ele vê.
    expect(botoes).toContain('SAIR DA EQUIPE');
  });

  it('ninguém age sobre si mesmo', () => {
    // O líder tem botões, e nenhum deles aponta para ele.
    const enderecos = walk(screenFor(LEADER))
      .filter((element) => element.type === 'button' && element.action.kind === 'navigate')
      .map((element) => (element.type === 'button' && element.action.kind === 'navigate' ? element.action.screenId : ''));

    expect(enderecos.some((endereco) => endereco.includes(LEADER))).toBe(false);
  });
});

// ============================================================
//  §3  O CAMPO DE TEXTO
// ============================================================

describe('o nome da equipe', () => {
  it('só o líder ganha o campo', () => {
    const doLider = walk(screenFor(LEADER)).filter((element) => element.type === 'input');
    const doOficial = walk(screenFor(OFFICER)).filter((element) => element.type === 'input');
    const doMembro = walk(screenFor(PLAIN)).filter((element) => element.type === 'input');

    expect(doLider).toHaveLength(1);
    expect(doOficial).toHaveLength(0);
    expect(doMembro).toHaveLength(0);
  });

  it('o campo já vem com o nome de agora, e corta no mesmo teto do plugin', () => {
    const campo = walk(screenFor(LEADER, { name: 'Alcateia do Norte' })).find(
      (element) => element.type === 'input',
    );

    expect(campo?.type).toBe('input');

    if (campo?.type !== 'input') return;

    expect(campo.text).toBe('Alcateia do Norte');
    expect(campo.charLimit).toBe(24);
    expect(campo.action.offerId).toBe(`${TEAM_ACTION_PREFIX}name`);
  });

  it('o líder tem um botão SALVAR ao lado do campo', () => {
    // Pedido do dono em 16/09: o Enter funciona, mas não é o que se
    // oferece — o botão é. Ele carrega a MESMA ação do campo: quem
    // manda o texto é o campo ao perder o foco, e o clique que
    // chegar depois é engolido pela trava do plugin.
    const elementos = screenFor(LEADER);
    const salvar = walk(elementos).find((element) => element.id === 'eq-nome-b');

    expect(salvar?.type).toBe('button');

    if (salvar?.type !== 'button') return;

    expect(salvar.text).toBe('SALVAR');
    expect(salvar.action.kind).toBe('store.buy');

    const campo = walk(elementos).find((element) => element.id === 'eq-nome-i');

    if (campo?.type !== 'input') throw new Error('o campo sumiu');

    // A mesma ação nos dois: um id só para o plugin validar.
    expect(salvar.action).toEqual(campo.action);
  });

  it('o botão SALVAR não fica por cima do campo', () => {
    const elementos = screenFor(LEADER);
    const caixa = walk(elementos).find((element) => element.id === 'eq-nome-c');
    const salvar = walk(elementos).find((element) => element.id === 'eq-nome-b');

    if (caixa === undefined || salvar === undefined) throw new Error('o bloco do nome mudou');

    expect(salvar.rect.offsetMin.x).toBeGreaterThan(caixa.rect.offsetMax.x);
  });

  it('a equipe sem nome mostra SEM NOME, e não uma linha vazia', () => {
    const textos = walk(screenFor(PLAIN)).flatMap((element) =>
      element.type === 'label' ? [element.text] : [],
    );

    expect(textos).toContain('SEM NOME');
  });
});

// ============================================================
//  §4  O ENDEREÇO
// ============================================================

describe('o endereço da tela', () => {
  it('reconhece a lista e as três confirmações', () => {
    expect(parseTeamScreenId(TEAM_SCREEN_ID)).toEqual({ kind: 'home' });
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:leave`)).toEqual({
      kind: 'confirm',
      verb: 'leave',
      steamId: null,
    });
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:kick:${PLAIN}`)).toEqual({
      kind: 'confirm',
      verb: 'kick',
      steamId: PLAIN,
    });
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:leader:${PLAIN}`)).toEqual({
      kind: 'confirm',
      verb: 'leader',
      steamId: PLAIN,
    });
  });

  it('devolve null para o que não é dele', () => {
    expect(parseTeamScreenId('tela-home')).toBeNull();
    expect(parseTeamScreenId('tela-equipes')).toBeNull();
    expect(parseTeamScreenId('')).toBeNull();
  });

  it('um SteamID forjado cai na lista, e não numa confirmação sobre ninguém', () => {
    // A linha é digitável no F1: qualquer coisa pode chegar aqui.
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:kick:abc`)).toEqual({ kind: 'home' });
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:kick:1`)).toEqual({ kind: 'home' });
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:kick:`)).toEqual({ kind: 'home' });
    expect(parseTeamScreenId(`${TEAM_SCREEN_ID}:naoexiste:${PLAIN}`)).toEqual({ kind: 'home' });
  });
});

// ============================================================
//  §5  A CONFIRMAÇÃO
// ============================================================

describe('a confirmação', () => {
  it('pergunta antes de expulsar, e o OK é que carrega a ação', () => {
    const elementos = buildTeamScreen({
      steamId: LEADER,
      team: team(),
      maxSize: 8,
      target: { kind: 'confirm', verb: 'kick', steamId: PLAIN },
    }).elements;

    expect(buttonsOf(elementos)).toContain('VOLTAR');
    expect(offersOf(elementos)).toContain(`${TEAM_ACTION_PREFIX}kick:${PLAIN}`);
  });

  it('não oferece o botão a quem não pode, mesmo com o endereço na mão', () => {
    // O membro comum digitou o endereço. Ele chega — e não ganha
    // botão nenhum.
    const elementos = buildTeamScreen({
      steamId: PLAIN,
      team: team(),
      maxSize: 8,
      target: { kind: 'confirm', verb: 'kick', steamId: OTHER },
    }).elements;

    expect(offersOf(elementos)).toHaveLength(0);
    expect(buttonsOf(elementos)).toEqual(['VOLTAR']);
  });

  it('o oficial não expulsa outro oficial nem pela confirmação', () => {
    const dois = team({
      members: [
        member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
        member({ steamId: OFFICER, name: 'Bia', rank: 'officer' }),
        member({ steamId: OTHER, name: 'Dani', rank: 'officer' }),
      ],
    });

    const elementos = buildTeamScreen({
      steamId: OFFICER,
      team: dois,
      maxSize: 8,
      target: { kind: 'confirm', verb: 'kick', steamId: OTHER },
    }).elements;

    expect(offersOf(elementos)).toHaveLength(0);
  });

  it('avisa que sair desfaz a equipe quando ele é o último', () => {
    const sozinho = team({
      members: [member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' })],
    });

    const textos = walk(
      buildTeamScreen({
        steamId: LEADER,
        team: sozinho,
        maxSize: 8,
        target: { kind: 'confirm', verb: 'leave', steamId: null },
      }).elements,
    ).flatMap((element) => (element.type === 'label' ? [element.text] : []));

    expect(textos.join(' ')).toContain('desfeita');
  });
});

// ============================================================
//  §6  OS ESTADOS QUE NÃO SÃO "TEM EQUIPE"
// ============================================================

describe('quando não há equipe para mostrar', () => {
  it('sem equipe, ensina a entrar e não inventa um convite nosso', () => {
    const elementos = buildTeamScreen({ steamId: PLAIN, team: null, maxSize: 8 }).elements;
    const textos = walk(elementos)
      .flatMap((element) => (element.type === 'label' ? [element.text] : []))
      .join(' ');

    expect(textos).toContain('convide');
    expect(buttonsOf(elementos)).toHaveLength(0);
  });

  it('o servidor mudo é uma tela DIFERENTE de "você não tem equipe"', () => {
    const erro = buildTeamScreen({
      steamId: PLAIN,
      team: null,
      maxSize: 8,
      failure: 'O servidor não está com o RCON de pé.',
    }).elements;

    const textos = walk(erro)
      .flatMap((element) => (element.type === 'label' ? [element.text] : []))
      .join(' ');

    expect(textos).toContain('NÃO CONSEGUI PERGUNTAR');
    expect(textos).toContain('RCON');
    // E ele NÃO diz que a pessoa está sem equipe.
    expect(textos).not.toContain('convide');
  });
});

// ============================================================
//  §7  A GEOMETRIA
// ============================================================

describe('o desenho cabe na moldura', () => {
  /**
   * A área útil do slot de conteúdo, medida no preset.
   *
   * O menu ocupa 88% da tela e o cabeçalho come o topo — ver
   * `BODY_HEIGHT` em ui-team-screen.ts. Quem desenha fora disto
   * não aparece, e não há erro nenhum avisando.
   */
  const SLOT: Size = { width: 1126 - 60, height: 634 - 78 - 60 };

  /**
   * A borda de baixo do elemento que desce mais.
   *
   * O Y do CUI cresce para cima e o `resolveRect` já o inverte, então
   * aqui se soma `top + height` — e os filhos são medidos DENTRO do
   * pai, que é como a âncora resolve de verdade.
   */
  function deepest(elements: readonly UiElement[], parent: Size): number {
    let lowest = 0;

    for (const element of elements) {
      const box = resolveRect(element.rect, parent);

      lowest = Math.max(lowest, box.top + box.height);
      lowest = Math.max(
        lowest,
        box.top + deepest(element.children, { width: box.width, height: box.height }),
      );
    }

    return lowest;
  }

  it('a equipe cheia de oito cabe, com o botão de sair no rodapé', () => {
    const cheia = team({
      members: [
        member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
        ...Array.from({ length: 7 }, (_, index) =>
          member({ steamId: `7656119800000001${String(index)}` }),
        ),
      ],
    });

    const elementos = buildTeamScreen({ steamId: LEADER, team: cheia, maxSize: 8 }).elements;

    expect(deepest(elementos, SLOT)).toBeLessThanOrEqual(SLOT.height);
  });

  it('uma equipe maior que o espaço corta a lista em vez de desenhar fora', () => {
    // O admin pode subir o `maxTeamSize`. Dezesseis membros não
    // cabem — e a tela precisa dizer isso, não desenhar no vazio.
    const enorme = team({
      members: [
        member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
        ...Array.from({ length: 15 }, (_, index) =>
          member({ steamId: `765611980000001${String(index).padStart(2, '0')}` }),
        ),
      ],
    });

    const elementos = buildTeamScreen({ steamId: LEADER, team: enorme, maxSize: 16 }).elements;
    const textos = walk(elementos)
      .flatMap((element) => (element.type === 'label' ? [element.text] : []))
      .join(' ');

    expect(deepest(elementos, SLOT)).toBeLessThanOrEqual(SLOT.height);
    expect(textos).toContain('e mais');
  });

  it('um nome gigante não empurra o cargo para fora da linha', () => {
    const gigante = team({
      members: [
        member({ steamId: LEADER, name: 'Mateuus', leader: true, rank: 'leader' }),
        member({ steamId: PLAIN, name: 'M'.repeat(80) }),
      ],
    });

    const nome = walk(buildTeamScreen({ steamId: LEADER, team: gigante, maxSize: 8 }).elements)
      .flatMap((element) => (element.type === 'label' ? [element.text] : []))
      .find((texto) => texto.startsWith('MMM'));

    expect(nome).toBeDefined();
    expect(nome?.length).toBeLessThan(80);
    expect(nome?.endsWith('…')).toBe(true);
  });
});

// ============================================================
//  §8  A ABA NO MENU
// ============================================================

describe('a aba no documento', () => {
  it('o preset nasce com a aba, a tela e os dois comandos', () => {
    const menu = buildMainMenu();

    expect(menu.screens.some((screen) => screen.id === TEAM_SCREEN_ID)).toBe(true);
    expect(walk(menu.shell).some((element) => element.id === 'nav-equipe')).toBe(true);

    for (const comando of TEAM_COMMANDS) {
      expect(menu.shortcuts.some((atalho) => atalho.command === comando)).toBe(true);
    }
  });

  it('a tela gravada é ESQUELETO e é `generated`', () => {
    const tela = buildMainMenu().screens.find((screen) => screen.id === TEAM_SCREEN_ID);

    // Sem a marca, o plugin desenha o repouso e nunca pede a de
    // verdade — o jogador ficaria no "Carregando…" para sempre.
    expect(tela?.generated).toBe(true);

    // E ela é pequena: a de verdade é remontada a cada clique, e o
    // documento não tem bytes sobrando.
    expect(JSON.stringify(tela).length).toBeLessThan(1_200);
  });

  it('nenhuma ação GRAVADA tem `:` no destino', () => {
    // O `uiDocumentSchema` recusa, e o documento inteiro não grava:
    // o menu sumiria do jogo. Os endereços com parâmetro só existem
    // na tela que o agente monta no clique.
    for (const element of walk(buildMainMenu().screens.flatMap((screen) => screen.elements))) {
      if (element.type === 'button' && 'screenId' in element.action) {
        expect(element.action.screenId).not.toContain(':');
      }
    }
  });

  it('o menu gravado ANTES desta frente ganha a aba e os comandos', () => {
    const antigo = buildMainMenu();
    const semAba = {
      ...antigo,
      screens: antigo.screens.filter((screen) => screen.id !== TEAM_SCREEN_ID),
      shortcuts: antigo.shortcuts.filter(
        (atalho) => !TEAM_COMMANDS.includes(atalho.command as (typeof TEAM_COMMANDS)[number]),
      ),
      shell: strip(antigo.shell, 'nav-equipe'),
    };

    const novo = withTeamTab(semAba);

    expect(novo).not.toBeNull();
    expect(novo?.screens.some((screen) => screen.id === TEAM_SCREEN_ID)).toBe(true);
    expect(walk(novo?.shell ?? []).some((element) => element.id === 'nav-equipe')).toBe(true);
    expect(novo?.shortcuts.some((atalho) => atalho.command === 'equipe')).toBe(true);

    // E ela não é acrescentada duas vezes.
    expect(withTeamTab(novo ?? semAba)).toBeNull();
  });
});

function strip(elements: readonly UiElement[], id: string): UiElement[] {
  return elements
    .filter((element) => element.id !== id)
    .map((element) => ({ ...element, children: strip(element.children, id) }) as UiElement);
}

// ============================================================
//  §9  A CARGA
// ============================================================

describe('o orçamento do frame', () => {
  it('a aba cabe, e o menu continua longe do teto do RCON', () => {
    // Ver ui-home-screen.test.ts para a trava geral. Aqui o que se
    // guarda é o CUSTO DESTA ABA: ela é fixa (custa igual com uma
    // equipe ou com cem), e é por isso que ela pode ser paga uma
    // vez e esquecida.
    const menu = buildMainMenu();
    const semAba = {
      ...menu,
      screens: menu.screens.filter((screen) => screen.id !== TEAM_SCREEN_ID),
      shortcuts: menu.shortcuts.filter(
        (atalho) => !TEAM_COMMANDS.includes(atalho.command as (typeof TEAM_COMMANDS)[number]),
      ),
      shell: strip(menu.shell, 'nav-equipe'),
    };

    const custo = JSON.stringify(menu).length - JSON.stringify(semAba).length;

    // MEDIDO: 1.530 bytes de JSON cru — o botão da barra (que no
    // CUI são dois elementos), a tela no índice e os dois atalhos.
    // A trava tem folga para um rótulo mudar de tamanho e nenhuma
    // para conteúdo novo: se ela estourar, alguém pôs desenho no
    // ESQUELETO, e o esqueleto é justamente o que não cresce — a
    // tela de verdade é remontada a cada clique.
    expect(custo).toBeLessThan(1_700);
  });
});

describe('o documento que uma versão anterior deixou pela metade', () => {
  it('ganha os atalhos mesmo já tendo a aba', () => {
    // ACONTECEU no server01 em 15/09/2026: o agente gravou a aba
    // com uma versão que ainda não tinha os atalhos, e a versão
    // seguinte viu a tela no lugar e desistiu. O menu ficou com o
    // botão EQUIPE e sem `/equipe` — para sempre, porque este
    // caminho só corre uma vez por documento.
    const menu = buildMainMenu();
    const meio = {
      ...menu,
      shortcuts: menu.shortcuts.filter(
        (atalho) => !TEAM_COMMANDS.includes(atalho.command as (typeof TEAM_COMMANDS)[number]),
      ),
    };

    const consertado = withTeamTab(meio);

    expect(consertado).not.toBeNull();

    for (const comando of TEAM_COMMANDS) {
      expect(consertado?.shortcuts.some((atalho) => atalho.command === comando)).toBe(true);
    }

    // E não duplica a tela nem o botão ao consertar.
    expect(consertado?.screens.filter((screen) => screen.id === TEAM_SCREEN_ID)).toHaveLength(1);
    expect(walk(consertado?.shell ?? []).filter((element) => element.id === 'nav-equipe')).toHaveLength(1);

    // Com tudo no lugar, ele volta a não ter o que fazer.
    expect(withTeamTab(consertado ?? meio)).toBeNull();
  });
});

// ============================================================
//  §10  A ORDEM DA BARRA
//
//  ####  O CONFIG FECHA A FILEIRA  ####
//
//  Regra do dono (16/09/2026), vendo a aba no jogo: "EQUIPE fica
//  antes de Config — Config sempre será o último". CONFIG não é um
//  assunto do servidor como LOJA ou EQUIPE: é onde o jogador mexe
//  no que é DELE, e uma aba de conteúdo depois dela empurraria as
//  opções pessoais para o meio da fileira.
//
//  A primeira versão pendurava a aba no FIM da barra, e foi assim
//  que ela chegou ao server01. Por isso o boot também REPOSICIONA
//  o que já está gravado.
// ============================================================

describe('a ordem dos botões da barra', () => {
  /**
   * O vão entre cada par de botões vizinhos.
   *
   * ####  ELE PRECISA SER SEMPRE O MESMO  ####
   *
   * Os botões não se encostam: cada um tem um X escrito, contado da
   * borda esquerda. Um botão removido do meio NÃO fecha o lugar
   * dele — e o buraco não quebra nada, não aparece num teste de
   * sobreposição, e só se vê no jogo.
   */
  function vaos(shell: readonly UiElement[]): number[] {
    const botoes = walk(shell)
      .filter((element) => element.type === 'button' && element.id.startsWith('nav-'))
      .sort((a, b) => a.rect.offsetMin.x - b.rect.offsetMin.x);

    return botoes
      .slice(1)
      .map((atual, index) => atual.rect.offsetMin.x - (botoes[index]?.rect.offsetMax.x ?? 0));
  }

  /** Os botões de navegação, da esquerda para a direita. */
  function ordem(shell: readonly UiElement[]): string[] {
    return walk(shell)
      .filter((element) => element.type === 'button' && element.id.startsWith('nav-'))
      .sort((a, b) => a.rect.offsetMin.x - b.rect.offsetMin.x)
      .map((element) => element.id);
  }

  it('o preset nasce com EQUIPE antes de CONFIG', () => {
    const ids = ordem(buildMainMenu().shell);

    expect(ids.indexOf('nav-equipe')).toBeLessThan(ids.indexOf('nav-config'));
    // E o CONFIG é o último de todos.
    expect(ids[ids.length - 1]).toBe('nav-config');
  });

  it('o menu já gravado com a aba no FIM é reposicionado no boot', () => {
    // O estado real do server01 em 16/09/2026: a primeira versão
    // pendurava a aba no fim da barra, depois do CONFIG.
    const menu = buildMainMenu();
    const errado = { ...menu, shell: mandaParaOFim(menu.shell, 'nav-equipe') };

    expect(ordem(errado.shell).at(-1)).toBe('nav-equipe');
    // E a barra do fixture é consistente: o lugar antigo se fechou.
    expect(new Set(vaos(errado.shell))).toEqual(new Set([6]));

    const consertado = withTeamTab(errado);

    expect(consertado).not.toBeNull();

    const ids = ordem(consertado?.shell ?? []);

    expect(ids.indexOf('nav-equipe')).toBeLessThan(ids.indexOf('nav-config'));
    expect(ids[ids.length - 1]).toBe('nav-config');

    // E nenhum botão foi duplicado nem perdido no caminho.
    expect(ids).toHaveLength(ordem(menu.shell).length);

    // ####  E O LUGAR ANTIGO SE FECHOU  ####
    //
    // Mover o botão não basta: os botões são posicionados por
    // deslocamento acumulado, então o lugar de onde ele saiu fica
    // como um vão vazio. No server01 deu 72 px entre DISCORD e
    // CONFIG, e só se viu abrindo o jogo.
    expect(new Set(vaos(consertado?.shell ?? []))).toEqual(new Set([6]));

    // A barra volta a ser exatamente a do preset.
    expect(ids).toEqual(ordem(menu.shell));
  });

  it('com tudo no lugar, o boot não mexe em nada', () => {
    expect(withTeamTab(buildMainMenu())).toBeNull();
  });

  it('a fileira tem o mesmo respiro entre todos os botões', () => {
    const medidos = vaos(buildMainMenu().shell);

    expect(medidos.length).toBeGreaterThan(8);
    // Todos iguais: nenhum encostado, nenhum sobreposto, e nenhum
    // buraco onde um botão morava antes.
    expect(new Set(medidos).size).toBe(1);
    expect(medidos[0]).toBeGreaterThan(0);
  });


});

/**
 * Move um botão da barra para o FIM, fechando o lugar dele.
 *
 * É o estado que a primeira versão do `withTeamTab` produzia — e a
 * barra fica CONSISTENTE: sem buraco onde ele estava, e sem
 * sobreposição no destino. Um fixture com buraco testaria o
 * conserto de um defeito que nunca existiu.
 */
function mandaParaOFim(elements: readonly UiElement[], id: string): UiElement[] {
  const alvo = walkAll(elements).find((element) => element.id === id);

  if (alvo === undefined) throw new Error(`sem ${id} na barra`);

  const largura = alvo.rect.offsetMax.x - alvo.rect.offsetMin.x;

  // 1. tira o botão e puxa de volta quem estava à direita dele
  const sem = puxa(semBotao(elements, id), alvo.rect.offsetMin.x, -(largura + 6));

  // 2. põe no fim, depois do que passou a ser o último
  const ultimo = walkAll(sem)
    .filter((element) => element.type === 'button' && element.id.startsWith('nav-'))
    .sort((a, b) => b.rect.offsetMax.x - a.rect.offsetMax.x)[0];

  if (ultimo === undefined) throw new Error('barra sem botões');

  const x = ultimo.rect.offsetMax.x + 6;
  const tab: UiElement = {
    ...alvo,
    rect: {
      ...alvo.rect,
      offsetMin: { ...alvo.rect.offsetMin, x },
      offsetMax: { ...alvo.rect.offsetMax, x: x + largura },
    },
  };

  const poe = (els: readonly UiElement[]): UiElement[] =>
    els.map((element) =>
      element.children.some((child) => child.id === 'nav-config')
        ? ({ ...element, children: [...element.children, tab] } as UiElement)
        : ({ ...element, children: poe(element.children) } as UiElement),
    );

  return poe(sem);
}

function walkAll(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walkAll(element.children)]);
}

function semBotao(elements: readonly UiElement[], id: string): UiElement[] {
  return elements
    .filter((element) => element.id !== id)
    .map((element) => ({ ...element, children: semBotao(element.children, id) }) as UiElement);
}

/** Desloca em X todo botão de navegação que começa em `fromX` ou depois. */
function puxa(elements: readonly UiElement[], fromX: number, by: number): UiElement[] {
  return elements.map((element) => {
    const move =
      element.type === 'button' &&
      element.id.startsWith('nav-') &&
      element.rect.offsetMin.x >= fromX;

    const movido = move
      ? {
          ...element,
          rect: {
            ...element.rect,
            offsetMin: { ...element.rect.offsetMin, x: element.rect.offsetMin.x + by },
            offsetMax: { ...element.rect.offsetMax, x: element.rect.offsetMax.x + by },
          },
        }
      : element;

    return { ...movido, children: puxa(movido.children, fromX, by) } as UiElement;
  });
}

