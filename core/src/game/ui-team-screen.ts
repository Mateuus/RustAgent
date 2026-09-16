// ============================================================
//  ui-team-screen.ts  -  a aba EQUIPE do menu.
//
//  Pedido do dono em 15/09/2026: "no jogo, na aba Equipe do /menu
//  — editar o nome da equipe, remover um jogador, passar a
//  liderança, e promover alguém a um cargo acima de membro".
//
//  A especificação inteira está em
//  Docs/OrigemZTeam/01-A-ABA-EQUIPE-DO-MENU.md, e o que foi medido
//  no jogo, em 00-LEVANTAMENTO.md.
//
//  ------------------------------------------------------------
//  ####  METADE DESTA TELA NÃO É NOSSA  ####
//
//  A equipe é do Rust. Quem está dentro, quem é líder e quantos
//  cabem vêm do `RelationshipManager` e voltam A CADA ABERTURA —
//  nada disso é guardado. O que é nosso é o CARGO, que o jogo não
//  tem.
//
//  Por isso ela não tem convite: o convite é do menu nativo do
//  jogo, e um segundo sistema de convite ao lado do primeiro seria
//  duas filas para a mesma porta.
//
//  ------------------------------------------------------------
//  ####  ELA É GERADA, E NUNCA VAI PARA O CACHE  ####
//
//  Ela mostra quem está ONLINE agora. O plugin guarda tela por
//  cinco minutos, e em cache ela mentiria — diria que o amigo está
//  no servidor depois de ele ter saído, e o jogador esperaria por
//  ele. O pacote sai `volatile`, como o da loja.
//
//  ------------------------------------------------------------
//  ####  O BOTÃO DIZ ONDE FICA; O AGENTE DECIDE O QUE FAZ  ####
//
//  Nenhuma ação daqui carrega "qual equipe" nem "qual jogador
//  expulsar" como intenção: ela carrega um ENDEREÇO, e quem clicou
//  sai da CONEXÃO. Um pacote forjado com o SteamID de outro não
//  expulsa ninguém porque o SteamID do pacote nunca é lido.
//
//  A conferência de cargo é feita DUAS vezes, de propósito: uma
//  para decidir que botão desenhar, outra antes de agir. As duas
//  perguntam à mesma tabela (`rankCan`, em types/teams.ts), porque
//  um botão desenhado por uma regra e recusado por outra é um
//  defeito que só aparece no clique.
//
//  ------------------------------------------------------------
//  ####  A LEITURA LANÇA, E ISSO É UMA FEATURE  ####
//
//  `teamOf` pergunta ao jogo por RCON. Com o servidor fora do ar
//  não há a quem perguntar — e "não consegui perguntar" é coisa
//  diferente de "você não está em equipe". Dizer a segunda porque
//  a primeira aconteceu seria mentir com cara de dado, e o jogador
//  sairia procurando por que perdeu a equipe.
// ============================================================

import {
  MAX_SCREENS_PER_DOCUMENT,
  MAX_SHORTCUTS_PER_DOCUMENT,
  type UiDocument,
  type UiElement,
  type UiScreen,
} from '../types/ui-document.js';
import { toGeneratedScreenBundle, type UiScreenBundle } from '../types/ui-transport.js';
import {
  TEAM_NAME_MAX,
  TEAM_RANK_LABEL,
  rankCan,
  rankOutranks,
  type Team,
  type TeamMember,
} from '../types/teams.js';

import {
  C,
  button,
  fill,
  input,
  label,
  panel,
  textWidth,
  titleBar,
  type Rect,
} from './ui-widgets.js';

/** O endereço desta tela no documento. */
export const TEAM_SCREEN_ID = 'tela-equipe';

/** O botão da barra que leva até aqui. */
export const TEAM_TAB_ID = 'nav-equipe';

export const TEAM_TAB_LABEL = 'EQUIPE';

/**
 * Os comandos de chat que abrem o menu JÁ nesta aba.
 *
 * Dois nomes de propósito: `/equipe` é o do servidor, que fala
 * português; `/team` é o que a pessoa traz de outro servidor. Eles
 * são ATALHOS do próprio documento — não um segundo menu —, então
 * custam uma linha e nenhum byte de carga. Pedido do dono em
 * 15/09/2026.
 */
export const TEAM_COMMANDS = ['equipe', 'team'] as const;

/**
 * O prefixo de toda ação desta tela.
 *
 * Elas viajam pelo canal da loja (`store.buy`), como as das
 * missões: é o único que leva um clique ao agente e traz resposta.
 * O prefixo é o que separa um `team:kick:…` de uma compra de
 * verdade no `fallback` do index.
 */
export const TEAM_ACTION_PREFIX = 'team:';

// ------------------------------------------------------------
//  AS MEDIDAS — as do ranking, das regras e do modo streamer
// ------------------------------------------------------------

const Y = {
  title: 30,
  body: 40,
} as const;

const COLUMN = {
  width: 210,
  gap: 16,
  item: 34,
  textLeft: 12,
  accent: 3,
} as const;

const CONTENT_LEFT = COLUMN.width + COLUMN.gap;

const ROW = {
  /** O cartão de cima: o nome da equipe e a contagem. */
  head: 56,
  /** O cartão do campo de texto. */
  rename: 54,
  /** O rótulo "MEMBROS". */
  caption: 18,
  /** Uma linha de membro. */
  member: 34,
  gap: 8,
  /** Entre duas linhas de membro — mais apertado que entre blocos. */
  memberGap: 4,
  pad: 12,
} as const;

/**
 * A altura que sobra para o corpo, em pixels de tela.
 *
 * ####  ELA É MEDIDA, E NÃO ESCOLHIDA  ####
 *
 * O menu ocupa 88% de 720 (= 633), o cabeçalho come 78, e o
 * `contentPadding` do preset come 30 em cima e 30 embaixo. Sobram
 * 495, menos os 40 da faixa de título: 455.
 *
 * Ela existe para a lista saber QUANTOS membros cabem. Sem essa
 * conta, uma equipe de doze (o admin pode subir o `maxTeamSize`)
 * desenharia as últimas linhas do lado de fora da moldura — e elas
 * não apareceriam, sem erro nenhum.
 */
const BODY_HEIGHT = 455;

/** O botão de sair, parado no rodapé. */
const FOOTER = { height: 30, width: 150 } as const;

// ------------------------------------------------------------
//  O ENDEREÇO
// ------------------------------------------------------------

/**
 * O que a tela está mostrando.
 *
 * ####  A CONFIRMAÇÃO É UMA TELA, E NÃO UM SEGUNDO CLIQUE  ####
 *
 * Expulsar e passar a liderança não se desfazem: quem foi expulso
 * precisa de convite novo, e quem deixou de ser líder depende da
 * boa vontade do novo para voltar. Um botão que faz isso no
 * primeiro toque é um acidente esperando a mão errada.
 *
 * A confirmação é uma tela porque o menu já sabe navegar — ela
 * nasce do mesmo caminho de toda página, e o VOLTAR é uma
 * navegação comum.
 */
export type TeamScreenTarget =
  | { readonly kind: 'home' }
  | { readonly kind: 'confirm'; readonly verb: 'kick' | 'leader'; readonly steamId: string }
  | { readonly kind: 'confirm'; readonly verb: 'leave'; readonly steamId: null };

/**
 * O endereço é desta tela? O que ele pede?
 *
 * `tela-equipe`                          a lista
 * `tela-equipe:kick:76561198…`           confirma expulsar
 * `tela-equipe:leader:76561198…`         confirma passar a liderança
 * `tela-equipe:leave`                    confirma sair
 *
 * Os endereços com `:` NUNCA vão para o documento — o
 * `uiDocumentSchema` os recusa, e o menu sumiria do jogo. Eles só
 * existem na tela que o agente monta no clique.
 */
export function parseTeamScreenId(screenId: string): TeamScreenTarget | null {
  const parts = screenId.split(':');

  if (parts[0] !== TEAM_SCREEN_ID) {
    return null;
  }

  if (parts.length === 1) {
    return { kind: 'home' };
  }

  const verb = parts[1];

  if (verb === 'leave' && parts.length === 2) {
    return { kind: 'confirm', verb: 'leave', steamId: null };
  }

  if ((verb === 'kick' || verb === 'leader') && parts.length === 3) {
    const steamId = parts[2] ?? '';

    // A régua é a mesma do resto do agente. Um endereço com lixo no
    // lugar do SteamID volta à lista em vez de montar uma
    // confirmação sobre ninguém.
    return /^\d{17}$/.test(steamId) ? { kind: 'confirm', verb, steamId } : { kind: 'home' };
  }

  return { kind: 'home' };
}

// ------------------------------------------------------------
//  OS RETÂNGULOS
// ------------------------------------------------------------

/** Uma faixa do conteúdo, medida a partir do topo do corpo. */
function row(top: number, height: number): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: CONTENT_LEFT, y: -(Y.body + top + height) },
    offsetMax: { x: 0, y: -(Y.body + top) },
  };
}

/** Uma linha de texto DENTRO de um bloco, recuada do canto. */
function line(top: number, height: number, right = 0): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: ROW.pad, y: -(top + height) },
    offsetMax: { x: -right, y: -top },
  };
}

/** Um botão no canto direito de um bloco, com os anteriores à direita dele. */
function actionRect(width: number, offset = 0): Rect {
  return {
    anchorMin: { x: 1, y: 0.5 },
    anchorMax: { x: 1, y: 0.5 },
    offsetMin: { x: -(width + ROW.pad + offset), y: -11 },
    offsetMax: { x: -(ROW.pad + offset), y: 11 },
  };
}

/** O rodapé: parado embaixo, fora do fluxo da lista. */
function footerRect(): Rect {
  return {
    anchorMin: { x: 1, y: 0 },
    anchorMax: { x: 1, y: 0 },
    offsetMin: { x: -FOOTER.width, y: 0 },
    offsetMax: { x: 0, y: FOOTER.height },
  };
}

function columnTitle(): Rect {
  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: -Y.title },
    offsetMax: { x: COLUMN.width, y: 0 },
  };
}

function columnRect(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 0 },
    offsetMax: { x: COLUMN.width, y: -Y.body },
  };
}

function columnItem(index: number): Rect {
  const top = index * COLUMN.item;

  return {
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 1, y: 1 },
    offsetMin: { x: 0, y: -(top + COLUMN.item) },
    offsetMax: { x: 0, y: -top },
  };
}

function columnAccent(): Rect {
  return {
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 0, y: 1 },
    offsetMin: { x: 0, y: 3 },
    offsetMax: { x: COLUMN.accent, y: -3 },
  };
}

// ------------------------------------------------------------
//  A COLUNA
// ------------------------------------------------------------

/**
 * A barra lateral, com um item só — como a do modo streamer.
 *
 * Ela parece exagero e é o contrário: é onde a segunda página da
 * equipe entra sem redesenhar nada. O KOTH já prevê uma (o placar
 * por equipe), e sem a coluna ela viraria uma aba nova na barra de
 * cima, que é o espaço mais disputado do menu.
 *
 * O item ABERTO não é um botão: é um painel com o acento. Um botão
 * que navega para a tela em que já se está seria um clique que não
 * faz nada, com o hover prometendo o contrário.
 */
function sidebar(): UiElement[] {
  return [
    label('eq-coltit', 'EQUIPE', columnTitle(), {
      size: 20,
      color: C.text,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    panel('eq-col', columnRect(), C.surface2, [
      panel('eq-col-0', columnItem(0), C.bg, [
        panel('eq-col-0b', columnAccent(), C.rust),
        label('eq-col-0l', 'MINHA EQUIPE', fill(COLUMN.textLeft, 0, ROW.pad, 0), {
          size: 12,
          color: C.text,
          align: 'MiddleLeft',
          font: 'RobotoCondensed-Bold.ttf',
        }),
      ]),
    ]),
  ];
}

// ------------------------------------------------------------
//  O CORPO
// ------------------------------------------------------------

export interface BuildTeamScreenOptions {
  /** Quem abriu o menu. */
  readonly steamId: string | undefined;
  /** A equipe dele, ou `null` quando ele não está em nenhuma. */
  readonly team: Team | null;
  /** Quantos cabem, do banco do agente. */
  readonly maxSize: number;
  /**
   * O que impediu a leitura.
   *
   * Presente = não deu para perguntar ao jogo. É diferente de
   * `team: null`, que é uma resposta.
   */
  readonly failure?: string | undefined;
  /** Que página desta família desenhar. */
  readonly target?: TeamScreenTarget;
  /** O id EXATO que foi pedido: o plugin descarta o que não bate. */
  readonly screenId?: string;
  /**
   * O ESQUELETO gravado no documento.
   *
   * Gravar a tela inteira custaria ~2 KB para desenhar o que
   * ninguém vê: ela é `generated`, e o agente a remonta a cada
   * clique. O que fica é o mínimo que responde quando o agente
   * não responde.
   */
  readonly skeleton?: boolean;
}

export function buildTeamScreen(options: BuildTeamScreenOptions): UiScreen {
  const screenId = options.screenId ?? TEAM_SCREEN_ID;

  if (options.skeleton === true) {
    return {
      id: screenId,
      name: 'EQUIPE',
      kind: 'page',
      elements: [
        ...titleBar('eq', 'EQUIPE'),
        label('eq-esq', 'Carregando…', row(0, 22), {
          size: 12,
          color: C.textMuted,
          align: 'MiddleLeft',
        }),
      ],
    };
  }

  const target = options.target ?? { kind: 'home' };
  const viewer = viewerOf(options.team, options.steamId);

  return {
    id: screenId,
    name: 'EQUIPE',
    kind: 'page',
    elements: [
      ...titleBar('eq', title(options, target), {
        left: CONTENT_LEFT,
        subtitle: subtitle(options, target),
      }),
      ...sidebar(),
      ...body(options, target, viewer),
    ],
  };
}

function title(options: BuildTeamScreenOptions, target: TeamScreenTarget): string {
  if (options.failure !== undefined) return 'EQUIPE';
  if (target.kind === 'confirm') return 'TEM CERTEZA?';

  return options.team === null ? 'VOCÊ NÃO ESTÁ EM UMA EQUIPE' : 'MINHA EQUIPE';
}

function subtitle(
  options: BuildTeamScreenOptions,
  target: TeamScreenTarget,
): string | undefined {
  if (options.failure !== undefined) return undefined;
  if (target.kind === 'confirm') return 'Isto não se desfaz.';
  if (options.team === null) return 'Equipe é do jogo: entre por convite.';

  return 'Quem está dentro, e quem manda em quê.';
}

function body(
  options: BuildTeamScreenOptions,
  target: TeamScreenTarget,
  viewer: TeamMember | null,
): readonly UiElement[] {
  if (options.failure !== undefined) {
    return notice('eq-erro', 'NÃO CONSEGUI PERGUNTAR AO SERVIDOR', options.failure);
  }

  if (options.team === null || viewer === null) {
    return withoutTeam();
  }

  if (target.kind === 'confirm') {
    return confirm(options.team, viewer, target);
  }

  return withTeam(options.team, viewer, options.maxSize);
}

/**
 * Quem está olhando, como membro da própria equipe.
 *
 * `null` sem SteamID no pedido (o plugin pede sem sessão) e também
 * quando o jogador não aparece na própria equipe — que não deveria
 * acontecer, e por isso mesmo não pode virar uma tela com botões:
 * sem saber o cargo dele, a resposta certa é a tela de quem não
 * tem equipe.
 */
function viewerOf(team: Team | null, steamId: string | undefined): TeamMember | null {
  if (team === null || steamId === undefined) return null;

  return team.members.find((member) => member.steamId === steamId) ?? null;
}

// ------------------------------------------------------------
//  SEM EQUIPE
// ------------------------------------------------------------

/**
 * A tela de quem não está em equipe.
 *
 * Ela não oferece botão de criar: no Rust a equipe nasce do
 * convite, pelo menu nativo (a aba de contatos, com o jogador na
 * mira). Um botão nosso ao lado seria um segundo caminho para uma
 * porta que já existe — e o jogador que aprendesse o nosso não
 * saberia usar o do jogo, que é o que os amigos dele usam.
 */
function withoutTeam(): readonly UiElement[] {
  return [
    panel('eq-sem', row(0, ROW.head), C.surface2, [
      label('eq-sem-t', 'VOCÊ AINDA NÃO ESTÁ EM UMA EQUIPE', line(10, 18), {
        size: 13,
        color: C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(
        'eq-sem-h',
        'A equipe é do jogo. Mire um amigo, abra o menu de contatos e convide — ou aceite o convite dele.',
        line(30, 16),
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
      ),
    ]),
    label(
      'eq-sem-n',
      'Quando você entrar em uma, esta aba mostra quem está dentro, quem está online e o cargo de cada um.',
      row(ROW.head + ROW.gap, 16),
      { size: 11, color: C.textMuted, align: 'MiddleLeft' },
    ),
  ];
}

/** Um aviso de bloco só — o mesmo desenho do "sem equipe". */
function notice(id: string, title: string, hint: string): readonly UiElement[] {
  return [
    panel(id, row(0, ROW.head), C.surface2, [
      label(`${id}-t`, title, line(10, 18), {
        size: 13,
        color: C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label(`${id}-h`, hint, line(30, 16), {
        size: 11,
        color: C.textMuted,
        align: 'MiddleLeft',
      }),
    ]),
  ];
}

// ------------------------------------------------------------
//  COM EQUIPE
// ------------------------------------------------------------

function withTeam(team: Team, viewer: TeamMember, maxSize: number): readonly UiElement[] {
  const canRename = rankCan(viewer.rank, 'rename');
  const online = team.members.filter((member) => member.online).length;

  const out: UiElement[] = [
    // ----------------------------------------------------------
    //  O CARTÃO DE CIMA
    // ----------------------------------------------------------
    panel('eq-cab', row(0, ROW.head), C.surface2, [
      label('eq-cab-t', displayName(team), line(10, 20, 120), {
        size: 16,
        // Sem nome, o rótulo é uma explicação e não um nome — e o
        // tom apagado é o que diz isso antes de a frase ser lida.
        color: team.name.trim() === '' ? C.textMuted : C.text,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      label('eq-cab-h', countLine(team, online, maxSize), line(32, 16, 120), {
        size: 11,
        color: C.textMuted,
        align: 'MiddleLeft',
      }),
    ]),
  ];

  let top = ROW.head + ROW.gap;

  if (canRename) {
    out.push(...renameRow(team, top));
    top += ROW.rename + ROW.gap;
  }

  out.push(
    label('eq-lista-t', 'MEMBROS', row(top, ROW.caption), {
      size: 11,
      color: C.textMuted,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
  );

  top += ROW.caption;

  // ----------------------------------------------------------
  //  A LISTA
  //
  //  ####  ELA SABE ONDE A MOLDURA ACABA  ####
  //
  //  O `maxTeamSize` é do admin: ele pode ser 8 (o padrão) ou 16.
  //  Sem esta conta, as linhas que não coubessem seriam desenhadas
  //  fora da moldura — e não apareceriam, sem erro nenhum, deixando
  //  um membro invisível com um botão de expulsar que ninguém vê.
  // ----------------------------------------------------------
  const room = BODY_HEIGHT - top - (FOOTER.height + ROW.gap);
  const fits = Math.max(1, Math.floor(room / (ROW.member + ROW.memberGap)));
  const shown = team.members.length > fits ? fits - 1 : team.members.length;

  for (let index = 0; index < shown; index += 1) {
    const member = team.members[index];

    if (member === undefined) continue;

    out.push(...memberRow(member, viewer, top + index * (ROW.member + ROW.memberGap)));
  }

  if (shown < team.members.length) {
    out.push(
      label(
        'eq-mais',
        `e mais ${String(team.members.length - shown)} — a lista completa está no painel.`,
        row(top + shown * (ROW.member + ROW.memberGap) + 8, ROW.caption),
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
      ),
    );
  }

  out.push(
    button(
      'eq-sair',
      'SAIR DA EQUIPE',
      footerRect(),
      { id: 'eq-sair-a', kind: 'navigate', screenId: `${TEAM_SCREEN_ID}:leave` },
      { color: C.surface2, textColor: C.textMuted, fontSize: 11 },
    ),
  );

  return out;
}

/**
 * O nome que a tela mostra.
 *
 * Vazio é o normal: o jogo NÃO batiza a equipe (medido —
 * `teamName` nasce `string.Empty`), e o "Team Fulano" que o cliente
 * mostra é o nome do líder, não um nome guardado. Então o vazio
 * aqui não é falta de dado: é uma equipe que ninguém batizou.
 */
function displayName(team: Team): string {
  const name = team.name.trim();

  return name === '' ? 'SEM NOME' : name;
}

function countLine(team: Team, online: number, maxSize: number): string {
  const size = team.members.length;
  const cap = maxSize > 0 ? ` de ${String(maxSize)}` : '';

  return `${String(size)}${cap} ${size === 1 ? 'membro' : 'membros'} · ${String(online)} online`;
}

// ------------------------------------------------------------
//  O NOME
// ------------------------------------------------------------

/**
 * O campo em que o líder escreve o nome.
 *
 * ####  ELE JÁ VEM PREENCHIDO, E NÃO TEM PLACEHOLDER  ####
 *
 * O uso normal é CORRIGIR um nome, não inventar um do zero — e um
 * campo que já traz o nome atual diz, sem escrever, o que ele faz.
 * Para a equipe sem nome ele nasce vazio, e a linha de baixo é que
 * explica.
 *
 * ####  O ENTER É QUEM CONFIRMA  ####
 *
 * Não há botão OK ao lado. O `InputField` do CUI dispara o comando
 * no Enter, e um botão teria de ler o texto do campo — coisa que o
 * documento não sabe fazer: o campo vive no cliente, e o servidor
 * só o conhece quando ele é enviado. Por isso a dica está escrita
 * embaixo, em vez de inventada num botão que não funcionaria.
 */
function renameRow(team: Team, top: number): readonly UiElement[] {
  const action = {
    id: 'eq-nome-a',
    kind: 'store.buy' as const,
    offerId: `${TEAM_ACTION_PREFIX}name`,
    quantity: 1,
  };

  return [
    panel('eq-nome', row(top, ROW.rename), C.surface2, [
      label('eq-nome-t', 'NOME DA EQUIPE', line(8, 14), {
        size: 10,
        color: C.textMuted,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      }),
      // O fundo do campo. O `InputField` não pinta nada: sem este
      // painel ele seria texto solto sobre o cartão, e ninguém
      // adivinharia que dá para clicar ali.
      panel(
        'eq-nome-c',
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          offsetMin: { x: ROW.pad, y: -(24 + 22) },
          offsetMax: { x: ROW.pad + 260, y: -24 },
        },
        C.bg,
        [
          input('eq-nome-i', team.name, fill(8, 0, 8, 0), action, TEAM_NAME_MAX, {
            size: 12,
            color: C.text,
            align: 'MiddleLeft',
          }),
        ],
      ),
      label(
        'eq-nome-h',
        `Escreva e aperte ENTER. Até ${String(TEAM_NAME_MAX)} caracteres.`,
        {
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 1, y: 1 },
          offsetMin: { x: ROW.pad + 272, y: -(24 + 22) },
          offsetMax: { x: -ROW.pad, y: -24 },
        },
        { size: 11, color: C.textMuted, align: 'MiddleLeft' },
      ),
    ]),
  ];
}

// ------------------------------------------------------------
//  UMA LINHA DE MEMBRO
// ------------------------------------------------------------

/**
 * O membro, e o que quem está olhando pode fazer com ele.
 *
 * ####  OS BOTÕES SÃO DESENHADOS PELA MESMA TABELA QUE OS COBRA  ####
 *
 * `rankCan` decide o que aparece; o agente chama `rankCan` de novo
 * antes de agir. Um botão que aparece e é recusado no clique é o
 * defeito mais caro desta tela — porque só se descobre tentando.
 *
 * ####  NINGUÉM AGE SOBRE SI MESMO  ####
 *
 * O líder não se expulsa nem se promove, e o oficial não se
 * rebaixa. Para sair há o botão do rodapé, que é a ação que se faz
 * sobre si — e ela tem outro nome de propósito.
 */
function memberRow(
  member: TeamMember,
  viewer: TeamMember,
  top: number,
): readonly UiElement[] {
  const self = member.steamId === viewer.steamId;
  const children: UiElement[] = [
    label(`eq-m${member.steamId}-n`, memberName(member), line(0, ROW.member, 300), {
      size: 12,
      // Quem está offline não some da lista — ele continua da
      // equipe. O que muda é o tom, e ele é lido antes do texto.
      color: member.online ? C.text : C.textMuted,
      align: 'MiddleLeft',
      font: 'RobotoCondensed-Bold.ttf',
    }),
    label(
      `eq-m${member.steamId}-c`,
      TEAM_RANK_LABEL[member.rank].toUpperCase(),
      {
        anchorMin: { x: 0, y: 0 },
        anchorMax: { x: 0, y: 1 },
        offsetMin: { x: 190, y: 0 },
        offsetMax: { x: 280, y: 0 },
      },
      {
        size: 10,
        color: member.rank === 'leader' ? C.amber : member.rank === 'officer' ? C.olive : C.textMuted,
        align: 'MiddleLeft',
        font: 'RobotoCondensed-Bold.ttf',
      },
    ),
  ];

  // Os botões nascem da direita para a esquerda, e cada um empurra
  // o seguinte. Assim uma linha com um botão só e outra com três
  // terminam na mesma borda.
  let offset = 0;

  if (!self && rankCan(viewer.rank, 'kick') && rankOutranks(viewer.rank, member.rank)) {
    children.push(
      button(
        `eq-m${member.steamId}-k`,
        'EXPULSAR',
        actionRect(86, offset),
        {
          id: `eq-k${member.steamId}`,
          kind: 'navigate',
          screenId: `${TEAM_SCREEN_ID}:kick:${member.steamId}`,
        },
        { color: C.surface, textColor: C.rust, fontSize: 10 },
      ),
    );

    offset += 86 + 6;
  }

  if (!self && rankCan(viewer.rank, 'leader') && rankOutranks(viewer.rank, member.rank)) {
    children.push(
      button(
        `eq-m${member.steamId}-l`,
        'DAR LIDERANÇA',
        actionRect(110, offset),
        {
          id: `eq-l${member.steamId}`,
          kind: 'navigate',
          screenId: `${TEAM_SCREEN_ID}:leader:${member.steamId}`,
        },
        { color: C.surface, textColor: C.textMuted, fontSize: 10 },
      ),
    );

    offset += 110 + 6;
  }

  // ####  PROMOVER E REBAIXAR SÃO O MESMO BOTÃO  ####
  //
  // Ele diz para onde VAI, não onde está: o cargo já está escrito
  // ao lado, e dois botões (um aceso, um apagado) gastariam o dobro
  // do espaço para dizer a mesma coisa.
  //
  // Ele não pede confirmação porque se desfaz com outro clique —
  // ao contrário dos dois de cima.
  if (!self && rankCan(viewer.rank, 'rank') && rankOutranks(viewer.rank, member.rank)) {
    const promote = member.rank === 'member';

    children.push(
      button(
        `eq-m${member.steamId}-r`,
        promote ? 'PROMOVER' : 'REBAIXAR',
        actionRect(86, offset),
        {
          id: `eq-r${member.steamId}`,
          kind: 'store.buy',
          offerId: `${TEAM_ACTION_PREFIX}rank:${member.steamId}`,
          quantity: 1,
        },
        {
          color: C.surface,
          textColor: promote ? C.olive : C.textMuted,
          fontSize: 10,
        },
      ),
    );
  }

  return [panel(`eq-m${member.steamId}`, row(top, ROW.member), C.surface, children)];
}

/**
 * O nome de um membro, cortado no que cabe.
 *
 * ####  ELE É TEXTO DE JOGADOR  ####
 *
 * Vai como rótulo e nada mais: o `cuiText` do conversor já o torna
 * seguro para o caminho até o cliente. E um nome de sessenta
 * caracteres não pode empurrar o cargo para fora da linha — daí o
 * corte, feito pela largura real do texto e não por contagem de
 * letras (um "MMMM" ocupa o dobro de um "iiii").
 */
function memberName(member: TeamMember): string {
  const name = member.name.trim() === '' ? member.steamId : member.name;

  if (textWidth(name, 12) <= 180) return name;

  let cut = name;

  while (cut.length > 1 && textWidth(`${cut}…`, 12) > 180) {
    cut = cut.slice(0, -1);
  }

  return `${cut}…`;
}

// ------------------------------------------------------------
//  A CONFIRMAÇÃO
// ------------------------------------------------------------

/**
 * A pergunta antes do que não se desfaz.
 *
 * ####  ELA CONFERE O CARGO DE NOVO  ####
 *
 * O endereço desta tela é digitável: `tela-equipe:kick:765…` chega
 * aqui vindo de um clique OU de quem montou a linha à mão. Chegar
 * até a pergunta não custa nada — mas ela não pode OFERECER o botão
 * a quem não pode. O agente confere uma terceira vez antes de agir;
 * esta conferência existe para a tela não mentir.
 */
function confirm(
  team: Team,
  viewer: TeamMember,
  target: Extract<TeamScreenTarget, { kind: 'confirm' }>,
): readonly UiElement[] {
  const back = button(
    'eq-volta',
    'VOLTAR',
    {
      anchorMin: { x: 1, y: 0 },
      anchorMax: { x: 1, y: 0 },
      offsetMin: { x: -(FOOTER.width + 160), y: 0 },
      offsetMax: { x: -(FOOTER.width + 10), y: FOOTER.height },
    },
    { id: 'eq-volta-a', kind: 'navigate', screenId: TEAM_SCREEN_ID },
    { color: C.surface2, textColor: C.textMuted, fontSize: 11 },
  );

  if (target.verb === 'leave') {
    const last = team.members.length <= 1;

    return [
      ...notice(
        'eq-conf',
        'SAIR DA EQUIPE',
        last
          ? 'Você é o último: a equipe será desfeita, e os cargos dela apagados.'
          : 'Você perde o cargo e precisa de convite novo para voltar.',
      ),
      back,
      confirmButton('SAIR', `${TEAM_ACTION_PREFIX}leave`, C.rust),
    ];
  }

  const member = team.members.find((entry) => entry.steamId === target.steamId);

  if (member === undefined) {
    return [
      ...notice('eq-conf', 'ESSE JOGADOR NÃO ESTÁ MAIS NA EQUIPE', 'A lista mudou desde o clique.'),
      back,
    ];
  }

  const power = target.verb === 'kick' ? 'kick' : 'leader';

  if (!rankCan(viewer.rank, power) || !rankOutranks(viewer.rank, member.rank)) {
    return [
      ...notice(
        'eq-conf',
        'VOCÊ NÃO PODE FAZER ISSO',
        `Seu cargo é ${TEAM_RANK_LABEL[viewer.rank].toLowerCase()}.`,
      ),
      back,
    ];
  }

  const name = memberName(member);

  return target.verb === 'kick'
    ? [
        ...notice(
          'eq-conf',
          `EXPULSAR ${name.toUpperCase()}?`,
          'Ele sai da equipe na hora, perde o cargo, e só volta com um convite novo.',
        ),
        back,
        confirmButton('EXPULSAR', `${TEAM_ACTION_PREFIX}kick:${member.steamId}`, C.rust),
      ]
    : [
        ...notice(
          'eq-conf',
          `DAR A LIDERANÇA A ${name.toUpperCase()}?`,
          'Você deixa de ser líder na hora, e não há como voltar atrás sozinho.',
        ),
        back,
        confirmButton('PASSAR', `${TEAM_ACTION_PREFIX}leader:${member.steamId}`, C.amber),
      ];
}

function confirmButton(text: string, offerId: string, color: string): UiElement {
  return button(
    'eq-conf-ok',
    text,
    footerRect(),
    { id: 'eq-conf-a', kind: 'store.buy', offerId, quantity: 1 },
    { color, textColor: C.white, fontSize: 11 },
  );
}

// ============================================================
//  O PROVEDOR
// ============================================================

export interface TeamScreenProviderOptions {
  /**
   * A equipe daquele jogador, perguntada AO JOGO.
   *
   * Ela lança quando não dá para perguntar — e é por isso que o
   * provedor a embrulha: a tela precisa saber a diferença entre
   * "não tem equipe" e "não consegui perguntar".
   */
  readonly teamOf: (serverId: string, steamId: string) => Promise<Team | null>;
  /** Quantos cabem, do banco. */
  readonly maxSizeOf: (serverId: string) => number;
}

export type TeamScreenProvider = (input: {
  readonly serverId: string;
  readonly document: UiDocument;
  readonly screenId: string;
  readonly steamId: string | undefined;
}) => Promise<UiScreenBundle | null>;

export function createTeamScreenProvider(
  options: TeamScreenProviderOptions,
): TeamScreenProvider {
  return async (input) => {
    const target = parseTeamScreenId(input.screenId);

    if (target === null) {
      return null;
    }

    const common = {
      steamId: input.steamId,
      maxSize: options.maxSizeOf(input.serverId),
      target,
      screenId: input.screenId,
    };

    let team: Team | null = null;
    let failure: string | undefined;

    if (input.steamId === undefined) {
      // O plugin pediu sem sessão. A tela de "sem equipe" é a
      // resposta certa: não há de quem falar.
      team = null;
    } else {
      try {
        team = await options.teamOf(input.serverId, input.steamId);
      } catch (cause) {
        failure =
          cause instanceof Error && cause.message !== ''
            ? cause.message
            : 'O servidor não respondeu a tempo. Tente de novo em instantes.';
      }
    }

    return toGeneratedScreenBundle(
      input.document,
      buildTeamScreen({ ...common, team, failure }),
      // O SHELL conhece `tela-equipe`: sem isto, o destaque do botão
      // sumiria justamente nas telas de confirmação, que têm
      // endereço com `:`.
      TEAM_SCREEN_ID,
    );
  };
}

// ============================================================
//  O MENU QUE JÁ ESTÁ GRAVADO
//
//  O documento nasce do preset UMA vez e depois é do admin: quem
//  editou o menu antes desta frente não ganharia a aba nunca,
//  porque o modelo não é reaplicado. Então o agente ACRESCENTA a
//  aba, uma vez, no boot — igual ao que a aba CONFIG fez.
//
//  O botão é uma CÓPIA do vizinho: cor, fonte e altura saem do
//  último botão da barra, e não de constantes daqui. É o que faz a
//  aba nova nascer parecida com as outras num menu que o admin
//  recoloriu.
// ============================================================

const NAV_GAP = 6;
const NAV_PADDING = 20;

interface NavSpot {
  readonly model: Extract<UiElement, { type: 'button' }>;
  readonly parentId: string | null;
}

function findNavSpot(
  elements: readonly UiElement[],
  parentId: string | null = null,
): NavSpot | null {
  let best: NavSpot | null = null;

  for (const element of elements) {
    if (element.type === 'button' && element.id.startsWith('nav-')) {
      if (best === null || element.rect.offsetMax.x > best.model.rect.offsetMax.x) {
        best = { model: element, parentId };
      }
    }

    const deeper = findNavSpot(element.children, element.id);

    if (
      deeper !== null &&
      (best === null || deeper.model.rect.offsetMax.x > best.model.rect.offsetMax.x)
    ) {
      best = deeper;
    }
  }

  return best;
}

function tabFrom(model: Extract<UiElement, { type: 'button' }>): UiElement {
  const width = textWidth(TEAM_TAB_LABEL, model.fontSize) + NAV_PADDING;
  const left = model.rect.offsetMax.x + NAV_GAP;

  return {
    ...model,
    id: TEAM_TAB_ID,
    name: TEAM_TAB_ID,
    text: TEAM_TAB_LABEL,
    rect: {
      anchorMin: model.rect.anchorMin,
      anchorMax: model.rect.anchorMax,
      offsetMin: { x: left, y: model.rect.offsetMin.y },
      offsetMax: { x: left + width, y: model.rect.offsetMax.y },
    },
    action: { id: 'ir-equipe', kind: 'navigate', screenId: TEAM_SCREEN_ID },
    activeOnScreenId: TEAM_SCREEN_ID,
    children: [],
  };
}

function insertAfter(
  elements: readonly UiElement[],
  parentId: string | null,
  afterId: string,
  tab: UiElement,
): UiElement[] {
  if (parentId === null) {
    return spliceAfter(elements, afterId, tab);
  }

  return elements.map((element) =>
    element.id === parentId
      ? { ...element, children: spliceAfter(element.children, afterId, tab) }
      : { ...element, children: insertAfter(element.children, parentId, afterId, tab) },
  );
}

function spliceAfter(
  elements: readonly UiElement[],
  afterId: string,
  tab: UiElement,
): UiElement[] {
  const out: UiElement[] = [];

  for (const element of elements) {
    out.push(element);

    if (element.id === afterId) {
      out.push(tab);
    }
  }

  return out;
}

/**
 * O documento com a aba EQUIPE, ou `null` se não há o que fazer.
 *
 * `null` quando a tela já existe, quando o documento está no teto
 * de telas, ou quando a barra não tem botão de navegação — um menu
 * desenhado do zero, sem barra, não tem onde pendurar a aba, e
 * inventar um lugar seria desenhar por cima do trabalho de quem
 * fez.
 */
export function withTeamTab(document: UiDocument): UiDocument | null {
  const shortcuts = withTeamShortcuts(document);
  const missingShortcuts = shortcuts.length !== document.shortcuts.length;

  // ####  A ABA JÁ ENTROU, MAS O DOCUMENTO PODE ESTAR PELA METADE  ####
  //
  // ACONTECEU no server01 em 15/09/2026: o agente subiu com uma
  // versão desta frente que ainda não tinha os atalhos, gravou a
  // aba, e a versão seguinte encontrou a tela no lugar e desistiu
  // — o menu ficou com o botão EQUIPE e sem `/equipe`.
  //
  // O remendo é olhar as duas coisas separadamente, em vez de
  // tratar a tela como prova de que o resto foi feito. Vale para
  // sempre: este caminho roda a cada boot, e é ele que conserta o
  // documento que uma versão anterior deixou incompleto.
  if (document.screens.some((screen) => screen.id === TEAM_SCREEN_ID)) {
    return missingShortcuts ? { ...document, shortcuts } : null;
  }

  if (document.screens.length >= MAX_SCREENS_PER_DOCUMENT) {
    return null;
  }

  const spot = findNavSpot(document.shell);

  if (spot === null) {
    return null;
  }

  return {
    ...document,
    shell: insertAfter(document.shell, spot.parentId, spot.model.id, tabFrom(spot.model)),
    shortcuts,
    screens: [
      ...document.screens,
      {
        ...buildTeamScreen({ steamId: undefined, team: null, maxSize: 0, skeleton: true }),
        generated: true,
      },
    ],
  };
}

/**
 * Os atalhos do documento, mais `/equipe` e `/team`.
 *
 * ####  ELES SÃO UM BÔNUS, E NÃO PODEM DERRUBAR A ABA  ####
 *
 * Documento no teto de atalhos — ou que já usa `equipe` como
 * comando principal — fica só com o botão, que é o que o jogador
 * clica. Perder a aba inteira por causa de um atalho seria trocar
 * o essencial pelo acessório.
 *
 * ####  E O PLUGIN É QUEM OS REGISTRA NO OXIDE  ####
 *
 * Todo atalho que chega na carga vira um comando de chat de
 * verdade. É por isso que ele importa: sem esta linha, quem digita
 * `/equipe` lê `Unknown command: equipe` — e o comando que o dono
 * pediu existiria só no papel.
 */
function withTeamShortcuts(document: UiDocument): UiDocument['shortcuts'] {
  let shortcuts = document.shortcuts;

  for (const command of TEAM_COMMANDS) {
    const taken =
      document.command === command || shortcuts.some((entry) => entry.command === command);

    if (taken || shortcuts.length >= MAX_SHORTCUTS_PER_DOCUMENT) {
      continue;
    }

    shortcuts = [...shortcuts, { command, screenId: TEAM_SCREEN_ID }];
  }

  return shortcuts;
}
