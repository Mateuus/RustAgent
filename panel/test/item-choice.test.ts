// ============================================================
//  O que o seletor de itens decide sozinho.
//
//  ####  É AQUI QUE O DEFEITO DO DONO MORAVA  ####
//
//  Ele abriu Jogadores → Dar item, digitou "blei" e não veio
//  nada. O Troféu Bleik Store existe, está cadastrado e funciona —
//  só que o seletor procurava no catálogo do JOGO, e o item nosso
//  mora noutra tabela.
//
//  O resto destes testes guarda as portas que fecham em SILÊNCIO,
//  que são as que ninguém vê quebrar: um item desligado que
//  aparece na lista vira uma entrega recusada lá na frente; um
//  item que não vale naquele servidor vira um item mudo no
//  inventário do jogador; e uma escolha que devolvesse o shortname
//  sem a skin entregaria um `discord.trophy` comum com cara de
//  troféu.
//
//  Componente React não é montado aqui: o vitest do painel roda em
//  node puro, e tudo o que estes testes cobrem é função pura.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  buildItemOptions,
  catalogChoice,
  choiceKey,
  customChoice,
  excludedCustomItems,
  findOurItem,
  findOurItemById,
  selectableCustomItems,
} from '@/components/item-choice';
import type { CatalogItem, CustomItem } from '@/lib/api';

/**
 * O Troféu como ele está no agente HOJE.
 *
 * Os valores foram lidos de `GET /api/custom-items` na máquina de
 * desenvolvimento — inclusive a skin, que é o número que o plugin
 * procura para reconhecer a marca.
 */
function ourItem(patch: Partial<CustomItem> = {}): CustomItem {
  return {
    id: 'trofeu-bleik-store',
    displayName: 'Troféu Bleik Store',
    baseShortname: 'discord.trophy',
    baseItemId: 1_494_014_226,
    baseMissing: false,
    skinId: '1552602728526292',
    category: 'Troféu Bleik Store',
    description: null,
    iconFile: null,
    maxStack: null,
    deployable: false,
    consumeOnPickup: true,
    action: { kind: 'points', metric: 'trophy.bleik', perUnit: 1, onPickup: true },
    message: null,
    enabled: true,
    servers: ['server01'],
    createdAt: '2026-09-06T01:38:35.797Z',
    updatedAt: '2026-09-06T18:11:30.674Z',
    ...patch,
  };
}

/** Um item do jogo, com o resto do contrato em valores neutros. */
function gameItem(patch: Partial<CatalogItem> & { shortname: string }): CatalogItem {
  return {
    displayName: patch.shortname,
    itemId: 1,
    category: 'Misc',
    maxStack: 1,
    hasCondition: false,
    consumable: null,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    removed: false,
    ...patch,
  };
}

const TROPHY_BODY = gameItem({
  shortname: 'discord.trophy',
  displayName: 'Discord Trophy',
  itemId: 1_494_014_226,
});

const idsOf = (items: readonly CustomItem[]): string[] => items.map((item) => item.id);

describe('selectableCustomItems — quem entra na lista', () => {
  it('acha pelo pedaço do nome que o dono digitou', () => {
    expect(idsOf(selectableCustomItems([ourItem()], { query: 'blei' }))).toEqual([
      'trofeu-bleik-store',
    ]);
  });

  it('acha sem acento, porque é assim que se digita com pressa', () => {
    expect(idsOf(selectableCustomItems([ourItem()], { query: 'trofeu' }))).toEqual([
      'trofeu-bleik-store',
    ]);
  });

  it('acha pelo corpo emprestado: quem procura o corpo quer ver quem o usa', () => {
    expect(idsOf(selectableCustomItems([ourItem()], { query: 'discord.trophy' }))).toEqual([
      'trofeu-bleik-store',
    ]);
  });

  it('não acha nada com o campo vazio — a lista só abre com busca', () => {
    expect(selectableCustomItems([ourItem()], { query: '   ' })).toEqual([]);
  });

  it('item DESLIGADO não aparece: ele não é entregue, e oferecê-lo é prometer o que o plugin recusa', () => {
    expect(selectableCustomItems([ourItem({ enabled: false })], { query: 'blei' })).toEqual([]);
  });

  it('item sem servidor nenhum não aparece nem quando a tela não sabe o servidor', () => {
    expect(selectableCustomItems([ourItem({ servers: [] })], { query: 'blei' })).toEqual([]);
  });

  it('item que não vale NAQUELE servidor some quando o servidor é conhecido', () => {
    const items = [ourItem()];

    expect(selectableCustomItems(items, { query: 'blei', serverId: 'server02' })).toEqual([]);
    expect(idsOf(selectableCustomItems(items, { query: 'blei', serverId: 'server01' }))).toEqual([
      'trofeu-bleik-store',
    ]);
  });

  it('sem servidor conhecido, os de todos os servidores passam', () => {
    const items = [
      ourItem(),
      ourItem({ id: 'outro', displayName: 'Troféu Bleik do 02', servers: ['server02'] }),
    ];

    // A ordem é a do nome; o que este teste guarda é que NENHUM dos
    // dois foi filtrado por servidor quando a tela não sabe qual é.
    expect(idsOf(selectableCustomItems(items, { query: 'blei' })).sort()).toEqual([
      'outro',
      'trofeu-bleik-store',
    ]);
  });

  it('o corpo ter sumido do jogo NÃO esconde a linha — ela só vem marcada', () => {
    expect(idsOf(selectableCustomItems([ourItem({ baseMissing: true })], { query: 'blei' }))).toEqual(
      ['trofeu-bleik-store'],
    );
  });

  it('quem começa com o que foi digitado vem antes de quem só tem a palavra no meio', () => {
    const items = [
      ourItem({ id: 'meio', displayName: 'Prêmio Bleik' }),
      ourItem({ id: 'comeco', displayName: 'Bleik de Ouro' }),
    ];

    expect(idsOf(selectableCustomItems(items, { query: 'bleik' }))).toEqual(['comeco', 'meio']);
  });

  it('respeita o teto de linhas pedido', () => {
    const items = [
      ourItem({ id: 'a', displayName: 'Bleik A' }),
      ourItem({ id: 'b', displayName: 'Bleik B' }),
      ourItem({ id: 'c', displayName: 'Bleik C' }),
    ];

    expect(idsOf(selectableCustomItems(items, { query: 'bleik', limit: 2 }))).toEqual(['a', 'b']);
  });
});

describe('a escolha carrega o par que forma a marca', () => {
  it('escolher o item nosso devolve o shortname do corpo E a skin, juntos', () => {
    const choice = customChoice(ourItem());

    expect(choice.shortname).toBe('discord.trophy');
    expect(choice.skinId).toBe('1552602728526292');
    // O nome é o NOSSO: é ele que a tela mostra depois de escolher.
    expect(choice.displayName).toBe('Troféu Bleik Store');
    expect(choice.itemId).toBe(1_494_014_226);
    expect(choice.customItem?.id).toBe('trofeu-bleik-store');
  });

  it('um item nosso que herda a pilha do corpo sai com maxStack nulo, e não 1', () => {
    // Ausente vira travessão, nunca zero: a tela que trava o botão
    // pela contagem de pilhas precisa saber a diferença entre "cabe
    // uma" e "ninguém sabe".
    expect(customChoice(ourItem()).maxStack).toBeNull();
    expect(customChoice(ourItem({ maxStack: 5 })).maxStack).toBe(5);
  });

  it('o corpo emprestado sumido deixa o itemId nulo em vez de zero', () => {
    expect(customChoice(ourItem({ baseItemId: null })).itemId).toBeNull();
  });

  it('um item do jogo sai com skin zerada, que é o que o plugin lê como "sem skin"', () => {
    const choice = catalogChoice(TROPHY_BODY);

    expect(choice.skinId).toBe('0');
    expect(choice.customItem).toBeNull();
    expect(choice.catalogItem?.shortname).toBe('discord.trophy');
  });
});

describe('buildItemOptions — as duas naturezas na mesma lista', () => {
  it('o item do jogo com o mesmo corpo NÃO some: os dois convivem, e os nossos vêm primeiro', () => {
    const options = buildItemOptions({
      customItems: [ourItem()],
      catalogItems: [TROPHY_BODY],
      query: 'trophy',
    });

    expect(options.map((option) => option.displayName)).toEqual([
      'Troféu Bleik Store',
      'Discord Trophy',
    ]);
    expect(options.map((option) => option.skinId)).toEqual(['1552602728526292', '0']);
  });

  it('a busca do dono que não achava nada agora acha — e só o item nosso', () => {
    const options = buildItemOptions({
      customItems: [ourItem()],
      // "blei" não casa com nome nenhum do jogo: é o que a rota
      // `/api/items` devolveu quando ele digitou isso.
      catalogItems: [],
      query: 'blei',
      serverId: 'server01',
    });

    expect(options).toHaveLength(1);
    expect(options[0]?.shortname).toBe('discord.trophy');
    expect(options[0]?.skinId).toBe('1552602728526292');
  });

  it('os itens do jogo passam inteiros: quem filtra a busca deles é o agente', () => {
    const options = buildItemOptions({
      customItems: [],
      catalogItems: [TROPHY_BODY, gameItem({ shortname: 'rifle.ak' })],
      query: 'qualquer coisa',
    });

    expect(options).toHaveLength(2);
  });

  it('a chave de React separa o item nosso do corpo que ele empresta', () => {
    const options = buildItemOptions({
      customItems: [ourItem()],
      catalogItems: [TROPHY_BODY],
      query: 'trophy',
    });

    const keys = options.map(choiceKey);

    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(['custom:trofeu-bleik-store', 'game:discord.trophy']);
  });
});

describe('excludedCustomItems — dizer qual porta fechou', () => {
  it('o desligado é apontado como desligado', () => {
    expect(
      excludedCustomItems([ourItem({ enabled: false })], { query: 'blei' }).map(
        (entry) => entry.reason,
      ),
    ).toEqual(['disabled']);
  });

  it('o que não vale naquele servidor é apontado como tal', () => {
    expect(
      excludedCustomItems([ourItem()], { query: 'blei', serverId: 'server02' }).map(
        (entry) => entry.reason,
      ),
    ).toEqual(['other-server']);
  });

  it('o sem servidor nenhum é outro caso, e manda consertar outra coisa', () => {
    expect(
      excludedCustomItems([ourItem({ servers: [] })], { query: 'blei' }).map(
        (entry) => entry.reason,
      ),
    ).toEqual(['no-server']);
  });

  it('desligado E fora do servidor conta como desligado: é o que se conserta primeiro', () => {
    expect(
      excludedCustomItems([ourItem({ enabled: false })], { query: 'blei', serverId: 'server02' })[0]
        ?.reason,
    ).toBe('disabled');
  });

  it('o que ESTÁ na lista não entra na explicação', () => {
    expect(excludedCustomItems([ourItem()], { query: 'blei', serverId: 'server01' })).toEqual([]);
  });
});

describe('findOurItem — reconhecer a marca que já está gravada', () => {
  const items = [ourItem()];

  it('acha o item nosso pelo par (corpo, skin)', () => {
    expect(findOurItem(items, 'discord.trophy', '1552602728526292')?.id).toBe(
      'trofeu-bleik-store',
    );
  });

  it('skin certa com corpo errado não é o nosso item — é uma skin órfã', () => {
    expect(findOurItem(items, 'rifle.ak', '1552602728526292')).toBeNull();
  });

  it('sem skin não há marca nenhuma para reconhecer', () => {
    expect(findOurItem(items, 'discord.trophy', '0')).toBeNull();
    expect(findOurItem(items, 'discord.trophy', '')).toBeNull();
  });

  it('acha pelo NÚMERO, para quem guarda o item como itemId', () => {
    expect(findOurItemById(items, 1_494_014_226, '1552602728526292')?.id).toBe(
      'trofeu-bleik-store',
    );
    expect(findOurItemById(items, 0, '1552602728526292')).toBeNull();
    expect(findOurItemById(items, 1_494_014_226, '0')).toBeNull();
  });
});
