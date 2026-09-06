// ============================================================
//  item-choice.ts  -  o que sai do seletor de itens.
//
//  ####  DUAS NATUREZAS, UMA ESCOLHA SÓ  ####
//
//  A lista do seletor mistura o catálogo do JOGO com os itens que
//  NÓS criamos, e quem recebe a escolha não deveria precisar saber
//  de qual das duas ela veio: nos dois casos, entregar no jogo
//  exige o par `(shortname, skinId)`.
//
//  Um item do jogo tem skin `'0'`. Um item nosso é o contrário —
//  ele É a skin. Entregar `discord.trophy` sem a marca
//  `1552602728526292` põe na mão do jogador um troféu de mentira:
//  o plugin não reconhece, não converte em ponto, e nada avisa.
//
//  Por isso os dois campos saem JUNTOS daqui, num objeto só. Um
//  callback que devolvesse só o shortname deixaria cada uma das
//  quatro telas com a obrigação de lembrar da skin — e a que
//  esquecesse não quebraria: entregaria o item errado calada.
//
//  ------------------------------------------------------------
//  ####  ESTE ARQUIVO É PURO DE PROPÓSITO  ####
//
//  Nada de React e nada de rede: é a parte que os testes do painel
//  alcançam (`panel/test/item-choice.test.ts`), e é onde moram as
//  regras que erram em silêncio — quem entra na lista, quem fica
//  de fora, e o que a escolha carrega junto.
// ============================================================

import type { CatalogItem, CustomItem } from '@/lib/api';

/**
 * Skin nenhuma.
 *
 * O plugin trata ausente e `'0'` do mesmo jeito; escrever `'0'` é
 * o que as telas já mandam, então é o valor que sai daqui para um
 * item do jogo.
 */
export const NO_SKIN = '0';

/** Quantos itens NOSSOS a lista mostra antes dos do jogo. */
export const CUSTOM_RESULTS = 8;

/** Uma escolha do seletor, seja ela do jogo ou nossa. */
export interface ItemChoice {
  /** O que a entrega exige. De um item nosso, é o corpo emprestado. */
  readonly shortname: string;
  /** A marca. `'0'` num item do jogo; nunca `'0'` num item nosso. */
  readonly skinId: string;
  /** O nome que a tela mostra — o NOSSO, quando é nosso. */
  readonly displayName: string;
  /** `null` quando o corpo emprestado sumiu desta versão do jogo. */
  readonly itemId: number | null;
  /**
   * `null` é "ninguém sabe", e não 1.
   *
   * Um item nosso com `maxStack` em branco herda o do corpo
   * emprestado, e esse número não está nesta lista — resolvê-lo
   * custaria uma chamada por escolha. A tela que usa isto para
   * travar o botão já sabe não adivinhar quando é `null`.
   */
  readonly maxStack: number | null;
  /** O item do jogo, quando a escolha foi um deles. */
  readonly catalogItem: CatalogItem | null;
  /** O item nosso, quando a escolha foi um dos nossos. */
  readonly customItem: CustomItem | null;
}

/**
 * Minúsculas e sem acento, para a busca.
 *
 * O painel é em português e os nomes que NÓS damos aos itens
 * também: quem procura o Troféu digita "trofeu" tanto quanto
 * "troféu", e as duas grafias têm de achar a mesma linha.
 */
function normalize(text: string): string {
  // O intervalo vai ESCAPADO: U+0300 a U+036F são os acentos que o
  // NFD solta do lado da letra, e escrevê-los literalmente aqui
  // deixaria a regex com um acento solto no meio do código-fonte —
  // invisível na revisão e apagável por qualquer editor.
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Onde a busca por um item nosso procura.
 *
 * O `baseShortname` entra na lista de propósito: quem digita
 * `discord.trophy` está atrás do corpo, e ver ali o item nosso que
 * o empresta é exatamente o que evita entregar o corpo pelado.
 */
function haystack(item: CustomItem): string {
  return normalize([item.displayName, item.id, item.baseShortname, item.category].join(' '));
}

/**
 * Os itens NOSSOS que esta tela pode oferecer.
 *
 * ####  TRÊS PORTAS, E AS TRÊS FECHAM EM SILÊNCIO  ####
 *
 * 1. DESLIGADO. O cadastro já diz o que isso significa: "não é
 *    entregue, mas continua sendo reconhecido". Mostrá-lo aqui
 *    seria oferecer uma entrega que o plugin recusa depois.
 *
 * 2. SEM SERVIDOR NENHUM. `servers` vazio é "não vale em lugar
 *    algum" — o item existe no cadastro e em mais nada. Ele fica
 *    de fora mesmo quando a tela não sabe o servidor, porque não
 *    há servidor em que ele funcionaria.
 *
 * 3. FORA DESTE SERVIDOR. Quando a tela sabe onde a entrega vai
 *    cair, um item que não vale ali chega com o nome errado e
 *    nunca converte em ponto. Quando ela NÃO sabe, todos passam —
 *    e a dica embaixo do campo diz isso.
 *
 * O corpo emprestado ter sumido do jogo (`baseMissing`) NÃO
 * fecha porta: o catálogo do jogo mostra os itens removidos com
 * uma marca em vez de escondê-los, e esconder aqui faria o item
 * parecer apagado do cadastro. A linha aparece marcada.
 */
export function selectableCustomItems(
  items: readonly CustomItem[],
  options: {
    readonly query: string;
    /** `undefined` = a tela não sabe em qual servidor isto vai valer. */
    readonly serverId?: string | undefined;
    readonly limit?: number;
  },
): CustomItem[] {
  const needle = normalize(options.query.trim());

  if (needle === '') {
    return [];
  }

  const { serverId } = options;

  const found = items.filter((item) => {
    if (!item.enabled || item.servers.length === 0) {
      return false;
    }

    if (serverId !== undefined && !item.servers.includes(serverId)) {
      return false;
    }

    return haystack(item).includes(needle);
  });

  // Quem COMEÇA com o que foi digitado vem antes: digitar "trofeu"
  // e ver "Troféu Bleik Store" em terceiro, atrás de dois itens que
  // só têm a palavra no meio, faz a busca parecer que não achou.
  found.sort((left, right) => {
    const leftStarts = normalize(left.displayName).startsWith(needle);
    const rightStarts = normalize(right.displayName).startsWith(needle);

    if (leftStarts !== rightStarts) {
      return leftStarts ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName, 'pt-BR');
  });

  return found.slice(0, options.limit ?? CUSTOM_RESULTS);
}

/** Por que um item nosso ficou de fora da lista. */
export type ExcludedReason = 'disabled' | 'no-server' | 'other-server';

export interface ExcludedCustomItem {
  readonly item: CustomItem;
  readonly reason: ExcludedReason;
}

/**
 * Os itens nossos que a busca achou e a tela NÃO pode oferecer.
 *
 * ####  SUMIR CALADO É COMO O DEFEITO COMEÇOU  ####
 *
 * O dono digitou "blei", não veio nada, e a conclusão razoável
 * foi "o seletor não conhece o item". Uma lista vazia não
 * distingue "não existe" de "existe e está fora daqui" — e as
 * duas pedem coisas opostas de quem está na frente da tela.
 *
 * Então, quando a busca termina vazia porque um filtro fechou a
 * porta, a tela diz qual porta foi. O motivo volta como código, e
 * não como frase: quem escreve o texto é a tela, que sabe se está
 * falando de entrega, de vitrine ou de ícone.
 */
export function excludedCustomItems(
  items: readonly CustomItem[],
  options: { readonly query: string; readonly serverId?: string | undefined },
): ExcludedCustomItem[] {
  const needle = normalize(options.query.trim());

  if (needle === '') {
    return [];
  }

  const { serverId } = options;
  const excluded: ExcludedCustomItem[] = [];

  for (const item of items) {
    if (!haystack(item).includes(needle)) {
      continue;
    }

    // A ordem importa: um item desligado E fora do servidor é,
    // antes de tudo, um item desligado — é o que se conserta
    // primeiro, e mandar quem lê para a aba de servidores seria
    // mandá-lo ao lugar errado.
    if (!item.enabled) {
      excluded.push({ item, reason: 'disabled' });
    } else if (item.servers.length === 0) {
      excluded.push({ item, reason: 'no-server' });
    } else if (serverId !== undefined && !item.servers.includes(serverId)) {
      excluded.push({ item, reason: 'other-server' });
    }
  }

  return excluded;
}

/** Um item do jogo, do jeito que a escolha viaja. */
export function catalogChoice(item: CatalogItem): ItemChoice {
  return {
    shortname: item.shortname,
    skinId: NO_SKIN,
    displayName: item.displayName,
    itemId: item.itemId,
    maxStack: item.maxStack,
    catalogItem: item,
    customItem: null,
  };
}

/**
 * Um item nosso, do jeito que a escolha viaja.
 *
 * O `shortname` é o do CORPO, e não o `id` do cadastro: é o corpo
 * que `origemz.give` sabe criar. O que faz dele o nosso item é a
 * skin que vai no mesmo objeto.
 */
export function customChoice(item: CustomItem): ItemChoice {
  return {
    shortname: item.baseShortname,
    skinId: item.skinId,
    displayName: item.displayName,
    itemId: item.baseItemId,
    maxStack: item.maxStack,
    catalogItem: null,
    customItem: item,
  };
}

/**
 * A lista do seletor: os nossos em cima, os do jogo embaixo.
 *
 * ####  OS NOSSOS VÊM PRIMEIRO, E ELES NÃO SUBSTITUEM NINGUÉM  ####
 *
 * Primeiro porque o item que a casa cadastrou é o que o admin mais
 * vai querer entregar — o catálogo do jogo tem 1259 linhas, e o
 * nosso item tem uma.
 *
 * E lado a lado porque as duas naturezas convivem: `discord.trophy`
 * cru continua sendo uma entrega legítima, e sumir com ele porque
 * existe um item nosso que empresta esse corpo tiraria do admin
 * uma escolha que ele tem hoje.
 *
 * Os itens do jogo chegam JÁ filtrados pela rota `/api/items` — a
 * busca deles é do agente, com 1259 linhas em SQL. O que se filtra
 * aqui são só os nossos, que são dezenas e moram na memória.
 */
export function buildItemOptions(input: {
  readonly customItems: readonly CustomItem[];
  readonly catalogItems: readonly CatalogItem[];
  readonly query: string;
  /** `undefined` = a tela não sabe em qual servidor isto vai valer. */
  readonly serverId?: string | undefined;
  readonly customLimit?: number;
}): ItemChoice[] {
  const ours = selectableCustomItems(input.customItems, {
    query: input.query,
    serverId: input.serverId,
    ...(input.customLimit === undefined ? {} : { limit: input.customLimit }),
  });

  return [...ours.map(customChoice), ...input.catalogItems.map(catalogChoice)];
}

/**
 * Qual item nosso é este par `(shortname, skinId)`.
 *
 * ####  A MARCA É RECONHECIDA, E NÃO LEMBRADA  ####
 *
 * Uma tela que reabre uma oferta já gravada não viu ninguém
 * escolher nada: ela tem só os dois números que estão no banco. Se
 * a trava do campo Skin dependesse da MEMÓRIA da escolha, reabrir
 * uma oferta que entrega o Troféu mostraria a skin destravada — e
 * o primeiro clique errado a apagaria.
 *
 * Então o par é reconhecido a cada render. Os dois campos precisam
 * bater: skin certa com o corpo errado não é o nosso item, é uma
 * skin órfã, e travar em cima disso seria afirmar algo falso.
 */
export function findOurItem(
  items: readonly CustomItem[],
  shortname: string,
  skinId: string,
): CustomItem | null {
  if (skinId === '' || skinId === NO_SKIN) {
    return null;
  }

  return (
    items.find((item) => item.skinId === skinId && item.baseShortname === shortname.trim()) ?? null
  );
}

/**
 * O mesmo, para quem guarda o item pelo NÚMERO.
 *
 * O editor de interface é esse caso: o CUI desenha por `itemId`, e
 * o documento nem guarda o shortname — ele existe na tela só
 * enquanto a busca está aberta. Sem esta variante, reabrir um
 * elemento que mostra o Troféu deixaria a skin destravada.
 */
export function findOurItemById(
  items: readonly CustomItem[],
  itemId: number,
  skinId: string,
): CustomItem | null {
  if (skinId === '' || skinId === NO_SKIN || itemId === 0) {
    return null;
  }

  return items.find((item) => item.skinId === skinId && item.baseItemId === itemId) ?? null;
}

/**
 * A chave de React de uma opção.
 *
 * Precisa de prefixo: um item nosso e o corpo que ele empresta
 * aparecem na mesma lista com o mesmo `shortname`, e duas chaves
 * iguais fazem o React embaralhar as duas linhas.
 */
export function choiceKey(choice: ItemChoice): string {
  return choice.customItem === null
    ? `game:${choice.shortname}`
    : `custom:${choice.customItem.id}`;
}
