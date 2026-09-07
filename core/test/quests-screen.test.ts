// ============================================================
//  quests-screen.test.ts  -  a tela `/quest`.
//
//  O que este arquivo guarda:
//
//    1. O TESTE DE TAMANHO. Uma tela estourada NÃO DÁ ERRO no
//       jogo: ela simplesmente não abre. É o defeito que só
//       aparece em produção, no servidor cheio, com o jogador que
//       tem seis quests de nome comprido;
//    2. o endereço é a única memória: trocar de aba e virar página
//       não guardam estado em lugar nenhum, e um endereço torto é
//       APARADO em vez de recusado — o jogador está com um aviso
//       de carregando na tela;
//    3. o recorte acontece antes do desenho: nenhum SteamID
//       atravessa o RCON;
//    4. a aba ativa é um PAINEL, e não um botão — clicar para onde
//       já se está parece defeito;
//    5. o botão reusa `store.buy` com `offerId` prefixado: zero
//       mudança no schema e zero no plugin;
//    6. a falha da leitura vira A TELA com o aviso, e nunca
//       silêncio.
// ============================================================

import { describe, expect, it } from 'vitest';

import { buildMainMenu } from '../src/game/ui-preset-main-menu.js';
import {
  buildQuestsScreen,
  createQuestsScreenProvider,
  emptyQuestsView,
  parseQuestsScreenId,
  QUESTS_PAGE_SIZE,
  QUESTS_SCREEN_ID,
  questsScreenId,
  readQuestsView,
  type QuestCard,
  type QuestDetail,
  type QuestsScreenReader,
  type QuestsView,
} from '../src/game/ui-quests-screen.js';
import { createLogger } from '../src/logger.js';
import type { QuestOffer, QuestProgressView } from '../src/quests/service.js';
import { uiDocumentSchema, type UiElement } from '../src/types/ui-document.js';
import { toGeneratedScreenBundle, UI_DOC_MAX_BYTES } from '../src/types/ui-transport.js';

const logger = createLogger({ log: { level: 'silent', pretty: false } });
// ####  O DOCUMENTO É O MENU, E SÓ ELE  ####
//
// As missões já tiveram um documento próprio (`menu-quests`), que
// era este mesmo menu clonado para responder a `/quest`. Hoje o
// `/quest` é um ATALHO deste documento — ver `shortcuts` em
// types/ui-document.ts.
const DOCUMENT = buildMainMenu();

/** Percorre a árvore de elementos. */
function walk(elements: readonly UiElement[]): UiElement[] {
  return elements.flatMap((element) => [element, ...walk(element.children)]);
}

function view(overrides: Partial<QuestsView> = {}): QuestsView {
  return { ...emptyQuestsView(), ...overrides };
}

function card(overrides: Partial<QuestCard> = {}): QuestCard {
  return {
    actionId: 'quest:accept:minerador',
    actionLabel: 'ACEITAR',
    title: 'Minerador',
    line: 'Coletar 5.000 de Minério de Enxofre — 3.240 / 5.000',
    progress: 0.648,
    detailScreenId: null,
    reward: '500 OZCoin',
    ...overrides,
  };
}

// ------------------------------------------------------------
//  O ENDEREÇO
// ------------------------------------------------------------

describe('o endereço', () => {
  it('lê as três formas', () => {
    expect(parseQuestsScreenId('tela-missoes')).toMatchObject({ tab: 'ativas', page: 0 });
    expect(parseQuestsScreenId('tela-missoes:disponiveis')).toMatchObject({ tab: 'disponiveis' });
    expect(parseQuestsScreenId('tela-missoes:disponiveis:2')).toMatchObject({
      tab: 'disponiveis',
      page: 2,
    });
    expect(parseQuestsScreenId('tela-missoes:det:8412')).toMatchObject({
      detail: { kind: 'live', id: '8412' },
    });
    expect(parseQuestsScreenId('tela-missoes:info:minerador')).toMatchObject({
      detail: { kind: 'offer', id: 'minerador' },
    });
    expect(parseQuestsScreenId('tela-missoes:npc:velho')).toMatchObject({ npcId: 'velho', page: 0 });
    expect(parseQuestsScreenId('tela-missoes:npc:velho:3')).toMatchObject({
      npcId: 'velho',
      page: 3,
    });
  });

  it('devolve `null` para o que não é dele', () => {
    // O provedor precisa recusar rápido: ele é perguntado antes de
    // quem casa um id exato.
    expect(parseQuestsScreenId('tela-ranking:pvp.kills')).toBeNull();
    expect(parseQuestsScreenId('tela-kits')).toBeNull();
  });

  it('apara o que vem torto em vez de recusar', () => {
    // O pedido veio do plugin e o jogador está com um aviso de
    // carregando. Recusar o deixaria girando até o timeout.
    expect(parseQuestsScreenId('tela-missoes:inventada')).toMatchObject({ tab: 'ativas' });
    expect(parseQuestsScreenId('tela-missoes:ativas:abc')).toMatchObject({ page: 0 });
    expect(parseQuestsScreenId('tela-missoes:ativas:-5')).toMatchObject({ page: 0 });
    // Um `OFFSET` absurdo não pode chegar ao banco.
    expect(parseQuestsScreenId('tela-missoes:ativas:99999999')?.page).toBe(9_999);
    expect(parseQuestsScreenId('tela-missoes:npc:')).toMatchObject({ npcId: null });
  });

  it('ida e volta: o que se escreve é o que se lê', () => {
    for (const target of [
      { tab: 'ativas' as const, page: 0 },
      { tab: 'feitas' as const, page: 3 },
      { npcId: 'velho-do-outpost', page: 2 },
    ]) {
      const parsed = parseQuestsScreenId(questsScreenId(target));

      expect(parsed).not.toBeNull();
      expect(parsed?.page).toBe(target.page);
    }
  });
});

// ------------------------------------------------------------
//  O TESTE DE TAMANHO
// ------------------------------------------------------------

describe('o tamanho da tela', () => {
  /**
   * O pior caso realista, e ele é construído para ser ruim:
   *
   *   - a página cheia (`QUESTS_PAGE_SIZE`);
   *   - títulos no limite do que o painel aceita (120 chars);
   *   - frases de objetivo longas, com acento e número formatado;
   *   - a linha de recompensa cheia;
   *   - barra de progresso e botão em todas;
   *   - o pager, porque há mais páginas.
   */
  function worstCase(): QuestsView {
    return view({
      tab: 'ativas',
      page: 1,
      pages: 9,
      cards: Array.from({ length: QUESTS_PAGE_SIZE }, (_, index) =>
        card({
          title: `Missão ${String(index)} — ${'Ç'.repeat(100)}`,
          line: `Coletar 5.000 de Minério de Enxofre de Altíssima Qualidade — 3.240 / 5.000  (+3)`,
          reward: '2500 OZCoin + 1x rifle.ak.diamond.edition +4',
          actionId: `quest:claim:${String(84120 + index)}`,
          actionLabel: 'RESGATAR',
        }),
      ),
    });
  }

  it('a página cheia cabe no frame do RCON, com folga', () => {
    const bundle = toGeneratedScreenBundle(
      DOCUMENT,
      buildQuestsScreen({ view: worstCase(), screenId: QUESTS_SCREEN_ID }),
      QUESTS_SCREEN_ID,
    );

    const bytes = Buffer.from(JSON.stringify(bundle)).toString('base64').length;

    // Uma tela estourada não dá erro no jogo: ela simplesmente não
    // abre. É por isso que a folga é medida, e não estimada.
    expect(bytes).toBeLessThan(UI_DOC_MAX_BYTES);

    // A folga precisa ser CONFORTÁVEL: uma tela a 98% do teto passa
    // hoje e estoura no dia em que alguém acrescentar um campo.
    expect(bytes).toBeLessThan(UI_DOC_MAX_BYTES * 0.8);
  });

  it('o documento inteiro cabe na carga inicial', () => {
    const bytes = Buffer.from(JSON.stringify(DOCUMENT)).toString('base64').length;

    expect(bytes).toBeLessThan(UI_DOC_MAX_BYTES);
  });

  it('o documento passa no schema que o banco cobra', () => {
    // O `uiDocumentSchema` não aceita `:` em `screenId` de ação — é
    // o que derrubaria a gravação inteira. A tela em repouso nasce
    // sem aba nenhuma por causa disso; se alguém puser uma, este
    // teste é quem avisa.
    expect(() => uiDocumentSchema.parse(DOCUMENT)).not.toThrow();
  });

  it('é determinístico: as mesmas opções dão o mesmo documento', () => {
    // É o que torna o teste de tamanho útil e o que permite
    // recriar o preset para comparar com o que está gravado.
    expect(JSON.stringify(buildMainMenu())).toBe(JSON.stringify(buildMainMenu()));
  });
});

// ------------------------------------------------------------
//  O DESENHO
// ------------------------------------------------------------

describe('o desenho', () => {
  // ####  O TESTE QUE FALTAVA, E QUE CUSTOU UMA SESSÃO  ####
  //
  // O plugin guarda o endereço que pediu e descarta a resposta cujo
  // id não bate:
  //
  //     if (session.PendingScreenId != screen.Id) return;
  //
  // Enquanto esta tela carimbava `tela-quest` em toda resposta, o
  // clique em DISPONÍVEIS pedia `tela-quest:disponiveis`, recebia
  // `tela-quest` e sumia em silêncio. NENHUM botão desta tela
  // funcionava, e nenhum teste via.
  it('a tela responde com o id que foi PEDIDO', () => {
    for (const screenId of [
      QUESTS_SCREEN_ID,
      'tela-missoes:disponiveis',
      'tela-missoes:feitas:2',
      'tela-missoes:npc:velho',
    ]) {
      expect(buildQuestsScreen({ view: view({ cards: [card()] }), screenId }).id).toBe(screenId);
    }
  });

  it('o item da vez é um painel; os outros, botões', () => {
    const screen = buildQuestsScreen({
      view: view({ tab: 'feitas', cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    const tabs = walk(screen.elements).filter((element) => element.id.startsWith('qt'));
    const active = tabs.find((element) => element.id === 'qtfei');

    // Clicar no item para navegar para onde já se está é um clique
    // que não faz nada — e é o que parece defeito.
    expect(active?.type).toBe('panel');
    expect(tabs.find((element) => element.id === 'qtati')?.type).toBe('button');
  });

  it('a barra lateral leva as três contagens', () => {
    const screen = buildQuestsScreen({
      view: view({ counts: { ativas: 2, disponiveis: 7, feitas: 1 }, cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    const numbers = walk(screen.elements)
      .filter((element) => element.type === 'label' && element.id.endsWith('n'))
      .map((element) => (element.type === 'label' ? element.text : ''));

    // Sem elas, o jogador precisa entrar em cada lista para saber
    // se há algo a resgatar.
    expect(numbers).toEqual(['2', '7', '1']);
  });

  it('sem contagem, a barra lateral não inventa zeros', () => {
    // A tela em REPOUSO não leu o banco: um "0" ali seria lido como
    // "você não tem nada", que é uma afirmação que ela não pode
    // fazer.
    const screen = buildQuestsScreen({
      view: view({ counts: null, cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    expect(
      walk(screen.elements).some((element) => element.id === 'qtatin' || element.id === 'qtdisn'),
    ).toBe(false);
  });

  it('a coluna tem largura FIXA, e os cards começam depois dela', () => {
    const screen = buildQuestsScreen({
      view: view({ tab: 'ativas', cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    // Esticada de 0 a 1 ela atravessaria a tela por baixo dos
    // cards — e o clique dela pegaria a lista inteira. É o mesmo
    // desenho do ranking: âncoras em 0, largura em pixels.
    const column = walk(screen.elements).find((element) => element.id === 'qcol');

    expect(column?.type).toBe('panel');
    expect(column?.rect.anchorMin.x).toBe(0);
    expect(column?.rect.anchorMax.x).toBe(0);
    expect(column?.rect.offsetMax.x).toBe(210);

    // Os itens são FILHOS dela: por isso eles podem esticar de 0 a
    // 1 — a largura que acompanham é a da coluna, não a da tela.
    for (const id of ['qtati', 'qtdis', 'qtfei']) {
      expect(column?.children.some((child) => child.id === id)).toBe(true);
    }

    const first = walk(screen.elements).find((element) => element.id === 'q0');

    expect(first?.rect.offsetMin.x).toBeGreaterThan(210);
  });

  it('o item da vez é mais ESCURO que a coluna, com a barra vermelha', () => {
    // Clarear seria o mesmo efeito do hover, e aí o item aberto e o
    // item sob o cursor pareceriam a mesma coisa. É a regra que a
    // coluna do ranking já seguia.
    const screen = buildQuestsScreen({
      view: view({ tab: 'ativas', cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    const active = walk(screen.elements).find((element) => element.id === 'qtati');
    const accent = walk(screen.elements).find((element) => element.id === 'qtatib');

    expect(active).toMatchObject({ type: 'panel', color: '#0F0F0F' });
    expect(accent).toMatchObject({ type: 'panel', color: '#C43F2C' });
  });

  // ####  O DEFEITO QUE O LOG DO SERVIDOR PEGOU  ####
  //
  // O rótulo da contagem cobria o item inteiro, irmão do botão e
  // declarado DEPOIS dele — portanto POR CIMA. No Unity o texto
  // tem `raycastTarget` ligado, e no CUI a ordem da lista é a
  // profundidade: clicar em DISPONÍVEIS não gerava PEDIDO NENHUM.
  // Foi assim que apareceu — `tela-missoes:disponiveis` nunca
  // constava no log, enquanto `det:1` e `claim:1` constavam.
  it('o número NÃO se sobrepõe ao botão que ele acompanha', () => {
    const screen = buildQuestsScreen({
      view: view({ tab: 'ativas', counts: { ativas: 2, disponiveis: 7, feitas: 1 } }),
      screenId: QUESTS_SCREEN_ID,
    });

    const at = (id: string): UiElement | undefined =>
      walk(screen.elements).find((element) => element.id === id);

    const button = at('qtdis');
    const badge = at('qtdisn');

    expect(button?.type).toBe('button');
    expect(badge?.type).toBe('label');

    // O botão termina onde o número começa. `offsetMax.x` do botão
    // é negativo (recuo da direita) e o `offsetMin.x` do número é a
    // distância da esquerda — as duas medidas se encontram na
    // largura da coluna.
    const buttonRight = 210 + (button?.rect.offsetMax.x ?? 0);
    const badgeLeft = badge?.rect.offsetMin.x ?? 0;

    expect(buttonRight).toBeLessThanOrEqual(badgeLeft);
  });

  it('o número da barra lateral NÃO é filho do botão', () => {
    // No Unity um rótulo por cima continua interceptando o raycast:
    // pendurado no botão, ele abriria um buraco morto bem onde o
    // jogador clica.
    const screen = buildQuestsScreen({
      view: view({ tab: 'ativas', counts: { ativas: 2, disponiveis: 7, feitas: 1 } }),
      screenId: QUESTS_SCREEN_ID,
    });

    const inactive = walk(screen.elements).find((element) => element.id === 'qtdis');

    expect(inactive?.type).toBe('button');
    expect(inactive?.children).toEqual([]);
  });

  it('a tela do NPC não tem barra lateral', () => {
    const screen = buildQuestsScreen({
      view: view({ npcId: 'velho', npcName: 'Velho do Outpost', cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    // Uma aba ali levaria o jogador para o menu geral por dentro da
    // tela do NPC, e ele não teria como voltar.
    expect(walk(screen.elements).some((element) => element.id === 'qtati')).toBe(false);
    // E o título é o nome dele.
    expect(
      walk(screen.elements).find((element) => element.id === 'qh' && element.type === 'label'),
    ).toMatchObject({ text: 'VELHO DO OUTPOST' });
  });

  it('o botão reusa `store.buy` com o prefixo `quest:`', () => {
    const screen = buildQuestsScreen({
      view: view({ cards: [card({ actionId: 'quest:accept:minerador' })] }),
      screenId: QUESTS_SCREEN_ID,
    });

    // Pelo id, e não pelo primeiro botão: o primeiro é o da ABA.
    const action = walk(screen.elements).find((element) => element.id === 'q0b');

    // Zero mudança no `uiDocumentSchema` e zero no plugin: é o
    // mesmo caminho que os kits já percorrem.
    expect(action).toMatchObject({
      action: { kind: 'store.buy', offerId: 'quest:accept:minerador' },
    });
  });

  it('a quest bloqueada não tem botão — só o motivo', () => {
    const screen = buildQuestsScreen({
      view: view({
        cards: [card({ actionId: null, actionLabel: null, line: 'Esta quest volta em 4h.' })],
      }),
      screenId: QUESTS_SCREEN_ID,
    });

    expect(walk(screen.elements).some((element) => element.type === 'button' && element.id === 'q0b')).toBe(
      false,
    );
    expect(
      walk(screen.elements).some(
        (element) => element.type === 'label' && element.text.includes('volta em 4h'),
      ),
    ).toBe(true);
  });

  it('a barra de progresso é o trilho e o preenchimento', () => {
    const screen = buildQuestsScreen({
      view: view({ cards: [card({ progress: 0.5 })] }),
      screenId: QUESTS_SCREEN_ID,
    });

    const fillBar = walk(screen.elements).find((element) => element.id === 'q0bf');

    expect(fillBar?.type).toBe('panel');
    expect(fillBar?.rect.anchorMax.x).toBe(0.5);
  });

  it('o progresso fora da faixa é aparado, e não deforma a barra', () => {
    const over = buildQuestsScreen({
      view: view({ cards: [card({ progress: 3 })] }),
      screenId: QUESTS_SCREEN_ID,
    });

    expect(walk(over.elements).find((element) => element.id === 'q0bf')?.rect.anchorMax.x).toBe(1);
  });

  it('o pager só aparece quando há mais de uma página', () => {
    const one = buildQuestsScreen({
      view: view({ cards: [card()], pages: 1 }),
      screenId: QUESTS_SCREEN_ID,
    });
    const many = buildQuestsScreen({
      view: view({ cards: [card()], pages: 4, page: 1 }),
      screenId: QUESTS_SCREEN_ID,
    });

    expect(walk(one.elements).some((element) => element.id.startsWith('qp'))).toBe(false);
    expect(walk(many.elements).some((element) => element.id.startsWith('qp'))).toBe(true);
  });

  it('a lista vazia mostra a frase, e nunca um retângulo mudo', () => {
    const screen = buildQuestsScreen({
      view: view({ cards: [], emptyMessage: 'Nada para resgatar agora.' }),
      screenId: QUESTS_SCREEN_ID,
    });

    expect(
      walk(screen.elements).some(
        (element) => element.type === 'label' && element.text === 'Nada para resgatar agora.',
      ),
    ).toBe(true);
  });

  it('o botão DETALHES abre um MODAL, e não navega', () => {
    const screen = buildQuestsScreen({
      view: view({ cards: [card({ detailScreenId: 'tela-missoes:det:8412' })] }),
      screenId: QUESTS_SCREEN_ID,
    });

    // `navigate` trocaria a página inteira: fechar o detalhe teria
    // de ir à rede de novo, e o jogador voltaria para a primeira
    // página da lista, não para onde estava.
    expect(walk(screen.elements).find((element) => element.id === 'q0i')).toMatchObject({
      action: { kind: 'modal.open', screenId: 'tela-missoes:det:8412' },
    });
  });

  it('o pager fica ancorado no RODAPÉ, e não depois do último card', () => {
    // Com seis quests ele nasceria num lugar e com duas, noutro — e
    // o jogador teria de procurá-lo a cada tela.
    const screen = buildQuestsScreen({
      view: view({ cards: [card()], pages: 3 }),
      screenId: QUESTS_SCREEN_ID,
    });

    expect(walk(screen.elements).find((element) => element.id === 'qppg')?.rect).toMatchObject({
      anchorMin: { y: 0 },
      anchorMax: { y: 0 },
    });
  });

  it('NENHUM SteamID atravessa o desenho', () => {
    const screen = buildQuestsScreen({
      view: view({ cards: [card()] }),
      screenId: QUESTS_SCREEN_ID,
    });

    // O recorte acontece antes do desenho. É a lição mais cara do
    // projeto: o que o jogador não pode ver não atravessa o RCON.
    expect(JSON.stringify(screen)).not.toMatch(/\d{17}/);
  });
});

// ------------------------------------------------------------
//  A LEITURA
// ------------------------------------------------------------

function progress(overrides: Partial<QuestProgressView> = {}): QuestProgressView {
  return {
    playerQuestId: 1,
    questId: 'minerador',
    title: 'Minerador',
    status: 'active',
    objectives: [{ seq: 0, label: 'Coletar 5.000', have: 100, need: 5000, done: false }],
    rewards: [{ kind: 'coins', amount: 500, perMeter: null, min: null, max: null }],
    complete: false,
    acceptedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

function offer(id: string, block: QuestOffer['block'] = null): QuestOffer {
  return {
    quest: {
      id,
      title: id,
      description: null,
      category: 'geral',
      enabled: true,
      sort: 0,
      requires: null,
      npcId: null,
      repeatMode: 'once',
      cooldownSeconds: 0,
      requiresQuest: null,
      availableFrom: null,
      availableTo: null,
      autoAccept: false,
      wipePolicy: 'reset',
      servers: [],
      objectives: [],
      rewards: [],
      createdAt: 0,
      updatedAt: 0,
    },
    block,
    availableAt: null,
  };
}

/** Uma oferta com as recompensas que o teste quer. */
function questWith(rewards: QuestOffer['quest']['rewards']): QuestOffer {
  const base = offer('minerador');

  return { ...base, quest: { ...base.quest, rewards } };
}

function reader(parts: Partial<QuestsScreenReader> = {}): QuestsScreenReader {
  return {
    offersFor: () => Promise.resolve([]),
    liveFor: () => [],
    describeObjective: (objective) => `fazer ${String(objective.amount)}`,
    ...parts,
  };
}

describe('a leitura', () => {
  it('sem saber quem pediu, avisa em vez de mostrar o catálogo', async () => {
    const result = await readQuestsView({
      reader: reader(),
      serverId: 'pvp1',
      steamId: undefined,
      target: { tab: 'ativas', page: 0, detail: null, npcId: null },
    });

    // Mostrar o catálogo sem o progresso seria pior que a frase:
    // pareceria que ele não tem quest nenhuma.
    expect(result.trouble).not.toBeNull();
    expect(result.cards).toEqual([]);
  });

  it('a aba das ativas traz só `active`; a de resgatar, só `completed`', async () => {
    const live = [
      progress({ playerQuestId: 1, status: 'active' }),
      progress({ playerQuestId: 2, status: 'completed', complete: true }),
    ];

    const ativas = await readQuestsView({
      reader: reader({ liveFor: () => live }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 0, detail: null, npcId: null },
    });

    const feitas = await readQuestsView({
      reader: reader({ liveFor: () => live }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'feitas', page: 0, detail: null, npcId: null },
    });

    expect(ativas.cards).toHaveLength(1);
    expect(ativas.cards[0]?.actionLabel).toBeNull();
    expect(feitas.cards).toHaveLength(1);
    expect(feitas.cards[0]?.actionLabel).toBe('RESGATAR');
    expect(feitas.cards[0]?.actionId).toBe('quest:claim:2');
  });

  it('a disponível bloqueada mostra o MOTIVO no lugar da descrição', async () => {
    const result = await readQuestsView({
      reader: reader({
        offersFor: () =>
          Promise.resolve([
            offer('travada', { code: 'QUEST_ON_COOLDOWN', reason: 'Esta quest volta em 4h.' }),
          ]),
      }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'disponiveis', page: 0, detail: null, npcId: null },
    });

    // É a informação que ele foi buscar. O texto de sabor da quest
    // não responde "por que não posso pegar?".
    expect(result.cards[0]?.line).toBe('Esta quest volta em 4h.');
    expect(result.cards[0]?.actionId).toBeNull();
  });

  it('a tela do NPC pergunta pelas quests DELE', async () => {
    let asked: string | undefined;

    const result = await readQuestsView({
      reader: reader({
        offersFor: (input) => {
          asked = input.npcId;

          return Promise.resolve([offer('entrega')]);
        },
      }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 0, detail: null, npcId: 'velho' },
      npcName: 'Velho do Outpost',
    });

    expect(asked).toBe('velho');
    expect(result.npcName).toBe('Velho do Outpost');
    expect(result.cards).toHaveLength(1);
  });

  it('a página que não existe mais vira a última, e não uma tela vazia', async () => {
    const live = Array.from({ length: 3 }, (_, index) =>
      progress({ playerQuestId: index + 1, status: 'active' }),
    );

    const result = await readQuestsView({
      reader: reader({ liveFor: () => live }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 7, detail: null, npcId: null },
    });

    // Ele resgatou a última quest da página 2 e o endereço ficou
    // apontando para o nada. Tela vazia parece defeito.
    expect(result.page).toBe(0);
    expect(result.cards).toHaveLength(3);
  });

  it('a barra soma TODOS os objetivos', async () => {
    const result = await readQuestsView({
      reader: reader({
        liveFor: () => [
          progress({
            objectives: [
              { seq: 0, label: 'A', have: 100, need: 100, done: true },
              { seq: 1, label: 'B', have: 0, need: 100, done: false },
            ],
          }),
        ],
      }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 0, detail: null, npcId: null },
    });

    // Mostrar só o primeiro faria a barra encher pela metade e
    // parar — e o jogador acharia que travou.
    expect(result.cards[0]?.progress).toBe(0.5);
    // E a frase diz quantos ainda faltam.
    expect(result.cards[0]?.line).toContain('B');
  });
});

// ------------------------------------------------------------
//  O PROVEDOR
// ------------------------------------------------------------

// ------------------------------------------------------------
//  O DETALHE
// ------------------------------------------------------------

describe('o detalhe', () => {
  const mine = progress({ playerQuestId: 8412, complete: false });

  it('é um MODAL, e a lista nem é montada', async () => {
    const result = await readQuestsView({
      reader: reader({ liveFor: () => [mine] }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 0, detail: { kind: 'live', id: '8412' }, npcId: null },
    });

    expect(result.detail?.title).toBe('Minerador');
    expect(result.cards).toEqual([]);

    // `kind: 'modal'` é o que faz o plugin desenhá-lo POR CIMA da
    // lista em vez de no lugar dela. Ver `Draw` em OrigemZUI.cs.
    const screen = buildQuestsScreen({ view: result, screenId: 'tela-missoes:det:8412' });

    expect(screen.kind).toBe('modal');
    expect(screen.id).toBe('tela-missoes:det:8412');
  });

  it('o id vem do CLIENTE, então a busca é dentro da lista de quem pediu', async () => {
    // `origemz.ui.act` pode ser digitado no F1 com o número que
    // quiser. Buscar a tentativa pelo id entregaria a missão de
    // outra pessoa.
    const result = await readQuestsView({
      reader: reader({ liveFor: () => [mine] }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 0, detail: { kind: 'live', id: '999' }, npcId: null },
    });

    expect(result.detail?.title).toBe('Missão indisponível');
    expect(result.detail?.actionId).toBeNull();
    expect(result.detail?.abandonId).toBeNull();
  });

  it('a em andamento pode ser abandonada; a concluída, não', async () => {
    const read = async (view: QuestProgressView): Promise<ReturnType<typeof readQuestsView>> =>
      readQuestsView({
        reader: reader({ liveFor: () => [view] }),
        serverId: 'pvp1',
        steamId: '76561198000000001',
        target: {
          tab: 'ativas',
          page: 0,
          detail: { kind: 'live', id: String(view.playerQuestId) },
          npcId: null,
        },
      });

    const andando = await read(mine);
    const pronta = await read(progress({ playerQuestId: 8412, complete: true }));

    expect(andando.detail?.abandonId).toBe('quest:cancel:8412');
    expect(andando.detail?.actionId).toBeNull();

    // Abandonar uma concluída seria jogar fora o prêmio já ganho
    // com um clique — e o botão fica ao lado do RESGATAR.
    expect(pronta.detail?.abandonId).toBeNull();
    expect(pronta.detail?.actionId).toBe('quest:claim:8412');
  });

  it('o da oferta mostra o que ela pede, sem contador', async () => {
    const withObjective: QuestOffer = {
      ...offer('minerador'),
      quest: {
        ...offer('minerador').quest,
        objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 100, label: null, metric: null, consume: false }],
        rewards: [{ kind: 'coins', amount: 500, perMeter: null, min: null, max: null }],
      },
    };

    const result = await readQuestsView({
      reader: reader({ offersFor: () => Promise.resolve([withObjective]) }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'disponiveis', page: 0, detail: { kind: 'offer', id: 'minerador' }, npcId: null },
    });

    expect(result.detail?.objectives).toEqual([
      { text: 'fazer 100', have: null, need: 100, done: false },
    ]);
    // A moeda leva o ícone do OZCoin; o nome do item vem do
    // catálogo do jogo, e não do cadastro da missão.
    expect(result.detail?.rewards).toEqual([{ text: '500 OZCoin', icon: { kind: 'coin' } }]);
    expect(result.detail?.actionId).toBe('quest:accept:minerador');
  });

  // ####  O NOME E O ÍCONE VÊM DO CATÁLOGO, NÃO DO CADASTRO  ####
  //
  // A missão guarda `metal.refined` e `trophy.bleik`. Nenhum dos
  // dois é nome de nada para quem está no jogo.
  it('o item ganha o nome do jogo e o ícone; a moeda, o OZCoin', async () => {
    const offer = questWith([
      { kind: 'item', shortname: 'metal.refined', amount: 25, skinId: '0' },
      { kind: 'coins', amount: 500, perMeter: null, min: null, max: null },
      { kind: 'points', metric: 'trophy.bleik', amount: 2 },
    ]);

    const result = await readQuestsView({
      reader: reader({ offersFor: () => Promise.resolve([offer]) }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'disponiveis', page: 0, detail: { kind: 'offer', id: 'minerador' }, npcId: null },
      catalog: {
        itemOf: (shortname) =>
          shortname === 'metal.refined'
            ? { itemId: 317_398_316, displayName: 'High Quality Metal' }
            : null,
        rankingLabelOf: (metric) => (metric === 'trophy.bleik' ? 'Bleik Store' : null),
      },
    });

    expect(result.detail?.rewards).toEqual([
      { text: '25x High Quality Metal', icon: { kind: 'item', itemId: 317_398_316, skinId: '0' } },
      { text: '500 OZCoin', icon: { kind: 'coin' } },
      // Pontos não são item: não há imagem. O que eles ganham é o
      // NOME do ranking, que `trophy.bleik` não dizia.
      { text: '2 pontos em Bleik Store', icon: null },
    ]);
  });

  // "2 pontos" sozinho foi a pergunta do dono olhando a tela: "2
  // pontos de quê?". A métrica crua é feia de propósito — ela é o
  // sinal de que aquele ranking precisa ser criado.
  it('a métrica que não é ranking aparece crua, e nunca some', async () => {
    const offer = questWith([{ kind: 'points', metric: 'quest.completed', amount: 2 }]);

    const result = await readQuestsView({
      reader: reader({ offersFor: () => Promise.resolve([offer]) }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'disponiveis', page: 0, detail: { kind: 'offer', id: 'minerador' }, npcId: null },
      catalog: { rankingLabelOf: () => null },
    });

    expect(result.detail?.rewards).toEqual([
      { text: '2 pontos em quest.completed', icon: null },
    ]);
  });

  it('sem catálogo, a chave crua aparece — e nunca um vazio', async () => {
    // O item pode ter saído do cadastro depois de a missão
    // prometê-lo. Melhor `metal.refined` que um espaço em branco.
    const offer = questWith([{ kind: 'item', shortname: 'metal.refined', amount: 25, skinId: '0' }]);

    const result = await readQuestsView({
      reader: reader({ offersFor: () => Promise.resolve([offer]) }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'disponiveis', page: 0, detail: { kind: 'offer', id: 'minerador' }, npcId: null },
    });

    expect(result.detail?.rewards).toEqual([{ text: '25x metal.refined', icon: null }]);
  });

  it('o ícone é desenhado, e o texto abre espaço para ele', () => {
    const screen = buildQuestsScreen({
      view: view({
        detail: {
          title: 'Minerador',
          description: '',
          objectives: [],
          rewards: [
            { text: '25x High Quality Metal', icon: { kind: 'item', itemId: 42, skinId: '0' } },
            { text: '500 OZCoin', icon: { kind: 'coin' } },
            { text: '2 pontos em Bleik Store', icon: null },
          ],
          note: null,
          actionId: null,
          actionLabel: null,
          abandonId: null,
        },
      }),
      screenId: 'tela-missoes:det:8412',
    });

    const at = (id: string): UiElement | undefined =>
      walk(screen.elements).find((element) => element.id === id);

    // O agente manda o `itemId`; quem resolve a imagem é o CLIENTE.
    expect(at('qdr0i')).toMatchObject({
      type: 'image',
      source: { kind: 'item', itemId: 42, skinId: '0' },
    });
    // A moeda é o PNG que o agente entrega ao servidor, pela chave.
    expect(at('qdr1i')).toMatchObject({ type: 'image', source: { kind: 'stored', key: 'ozcoin' } });
    // Pontos não têm imagem: nenhum elemento, e o marcador volta.
    expect(at('qdr2i')).toBeUndefined();
    expect(at('qdr2')).toMatchObject({ text: '•  2 pontos em Bleik Store' });

    // Com ícone, o texto começa DEPOIS dele; sem, na margem da caixa.
    expect(at('qdr0')?.rect.offsetMin.x).toBe(46);
    expect(at('qdr2')?.rect.offsetMin.x).toBe(22);
    // E o ícone cabe no espaço aberto, sem encostar no texto.
    expect(at('qdr0i')?.rect.offsetMax.x).toBe(42);
  });

  // ####  A ALTURA FIXA ERRAVA DOS DOIS LADOS  ####
  //
  // Uma missão curta deixava metade da caixa vazia; uma cheia
  // passava dos 380 px e escrevia POR CIMA dos botões do rodapé.
  it('a caixa do detalhe cresce com o conteúdo', () => {
    const boxOf = (detail: QuestDetail): number => {
      const screen = buildQuestsScreen({ view: view({ detail }), screenId: 'tela-missoes:det:1' });
      const box = walk(screen.elements).find((element) => element.id === 'qdcaixa');

      return (box?.rect.offsetMax.y ?? 0) - (box?.rect.offsetMin.y ?? 0);
    };

    const base: QuestDetail = {
      title: 'Curta',
      description: '',
      objectives: [],
      rewards: [],
      note: null,
      actionId: null,
      actionLabel: null,
      abandonId: null,
    };

    const cheia: QuestDetail = {
      ...base,
      description: 'Uma descrição.',
      objectives: Array.from({ length: 6 }, (_, i) => ({
        text: `Objetivo ${String(i)}`,
        have: 0,
        need: 10,
        done: false,
      })),
      rewards: Array.from({ length: 4 }, () => ({ text: '500 OZCoin', icon: { kind: 'coin' } })),
      note: 'Concluída.',
    };

    expect(boxOf(base)).toBe(200);
    expect(boxOf(cheia)).toBeGreaterThan(200);

    // E o conteúdo nunca invade o rodapé: os botões ficam entre 16 e
    // 46 do fundo, e a caixa reserva isso.
    expect(boxOf(cheia)).toBeGreaterThanOrEqual(384 + 16);
  });

  // ####  NADA DO CONTEÚDO PODE ENTRAR NA FAIXA DO RODAPÉ  ####
  //
  // ISTO APARECEU NO JOGO, com o "Conclua X antes desta" escrito
  // atrás do botão FECHAR: a nota era a única seção que desenhava
  // SEM avançar o cursor, e a altura da caixa sai dele.
  //
  // O teste não olha a nota: olha TODOS os elementos, com todas as
  // seções cheias. É o que faz a próxima seção que esquecer de
  // andar com o cursor cair aqui, e não no jogo do dono.
  it('nenhuma seção do detalhe invade os botões', () => {
    const cheia: QuestDetail = {
      title: 'Veterano',
      description: 'Só aparece depois que você resgatar a Limpeza no monumento.',
      objectives: Array.from({ length: 6 }, (_, i) => ({
        text: `Matar ${String(i)} scientist`,
        have: 0,
        need: 5,
        done: false,
      })),
      rewards: [
        { text: '750 OZCoin', icon: { kind: 'coin' } },
        { text: '2 pontos', icon: null },
      ],
      note: 'Conclua "Limpeza no monumento" antes desta.',
      actionId: null,
      actionLabel: null,
      abandonId: null,
    };

    const screen = buildQuestsScreen({ view: view({ detail: cheia }), screenId: 'tela-missoes:det:1' });
    const box = walk(screen.elements).find((element) => element.id === 'qdcaixa');
    const height = (box?.rect.offsetMax.y ?? 0) - (box?.rect.offsetMin.y ?? 0);

    // Os botões ocupam de 16 a 46 medidos do FUNDO da caixa.
    const footerTop = height - 46;

    for (const element of walk(box?.children ?? [])) {
      // O rodapé é ancorado embaixo (anchorMin.y === 0); o conteúdo,
      // no topo. Só o conteúdo é cobrado aqui.
      if (element.rect.anchorMin.y === 0) {
        continue;
      }

      // O `offsetMin.y` é negativo: é a distância do topo até o
      // fundo do elemento.
      const bottom = -element.rect.offsetMin.y;

      expect(bottom).toBeLessThanOrEqual(footerTop);
    }
  });

  it('os três botões do rodapé usam os canais certos', () => {
    const screen = buildQuestsScreen({
      view: view({
        detail: {
          title: 'Minerador',
          description: 'Junte enxofre.',
          objectives: [{ text: 'Coletar 100', have: 20, need: 100, done: false }],
          rewards: [{ text: '500 OZCoin', icon: { kind: 'coin' } }],
          note: null,
          actionId: 'quest:claim:8412',
          actionLabel: 'RESGATAR',
          abandonId: 'quest:cancel:8412',
        },
      }),
      screenId: 'tela-missoes:det:8412',
    });

    const byId = (id: string): UiElement | undefined =>
      walk(screen.elements).find((element) => element.id === id);

    // Fechar não vai à rede: a lista continua desenhada embaixo.
    expect(byId('qdfechar')).toMatchObject({ action: { kind: 'modal.close' } });
    // Abandonar e resgatar pegam carona no canal da loja, com o
    // prefixo `quest:` que o `runQuestAction` reconhece.
    expect(byId('qdabandonar')).toMatchObject({
      action: { kind: 'store.buy', offerId: 'quest:cancel:8412' },
    });
    expect(byId('qdok')).toMatchObject({
      action: { kind: 'store.buy', offerId: 'quest:claim:8412' },
    });
  });

  it('a contagem da barra lateral sai das duas leituras, e não de três', async () => {
    let offersCalls = 0;

    const result = await readQuestsView({
      reader: reader({
        liveFor: () => [
          progress({ playerQuestId: 1, status: 'active' }),
          progress({ playerQuestId: 2, status: 'active' }),
          progress({ playerQuestId: 3, status: 'completed', complete: true }),
        ],
        offersFor: () => {
          offersCalls += 1;

          return Promise.resolve([offer('a'), offer('b')]);
        },
      }),
      serverId: 'pvp1',
      steamId: '76561198000000001',
      target: { tab: 'ativas', page: 0, detail: null, npcId: null },
    });

    expect(result.counts).toEqual({ ativas: 2, disponiveis: 2, feitas: 1 });
    expect(offersCalls).toBe(1);
  });
});

describe('o provedor', () => {
  const quests = (parts: Partial<QuestsScreenReader>) =>
    createQuestsScreenProvider({ quests: reader(parts) as never, logger });

  it('devolve `null` para o que não é dele', async () => {
    const bundle = await quests({})({
      serverId: 'pvp1',
      document: DOCUMENT,
      screenId: 'tela-ranking',
      steamId: '76561198000000001',
    });

    expect(bundle).toBeNull();
  });

  it('a falha da leitura vira A TELA com o aviso, e nunca silêncio', async () => {
    const bundle = await quests({
      liveFor: () => {
        throw new Error('banco fora');
      },
    })({
      serverId: 'pvp1',
      document: DOCUMENT,
      screenId: QUESTS_SCREEN_ID,
      steamId: '76561198000000001',
    });

    // Silêncio deixaria o jogador girando até o timeout do plugin.
    expect(bundle).not.toBeNull();
    expect(JSON.stringify(bundle)).toContain('Não deu para carregar');
  });

  it('a tela nunca é guardada em cache', async () => {
    const bundle = await quests({})({
      serverId: 'pvp1',
      document: DOCUMENT,
      screenId: QUESTS_SCREEN_ID,
      steamId: '76561198000000001',
    });

    // Ela diz "você tem 3.240 de 5.000"; em cache, diria isso para
    // o servidor inteiro e por até cinco minutos.
    expect(bundle?.volatile).toBe(true);
  });
});
