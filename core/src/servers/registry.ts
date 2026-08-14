// ============================================================
//  registry.ts  -  quem são os servidores, em memória.
//
//  Um mapa `serverId -> contexto` e as quatro perguntas que o
//  resto do agente faz sobre ele: qual é este, quais existem,
//  quais estão ligados, e quem responde quando ninguém disse.
//
//  ------------------------------------------------------------
//  ####  POR QUE ISTO NÃO É UM `Map` SOLTO  ####
//
//  Porque as duas respostas erradas de um `Map` custam caro aqui:
//
//    `map.get(id)` devolve `undefined` para um id que não existe,
//    e `undefined` atravessa uma rota HTTP inteira até virar
//    "cannot read property of undefined" cinquenta linhas depois,
//    sem dizer qual id foi pedido;
//
//    `map.values()` devolve os DESLIGADOS junto, e um laço que
//    esqueça de filtrar manda comando de RCON para um servidor que
//    alguém desligou de propósito no meio de uma migração.
//
//  Daí `require()` (que estoura com o id na mensagem e a lista do
//  que existe) e `listEnabled()` serem métodos, e não hábitos que
//  cada chamador precisa lembrar.
//
//  ------------------------------------------------------------
//  ####  ELE MUDA EM TEMPO DE EXECUÇÃO — E SÓ POR UM LUGAR  ####
//
//  Ele já foi imutável depois de montado, e a razão era boa: um
//  contexto que some debaixo de quem está no meio de um envio de
//  RCON é um erro difícil de enxergar. O preço, porém, era pior —
//  criar um servidor pelo painel exigia REINICIAR o agente, e um
//  servidor recém-criado nem aparecia na lista até lá.
//
//  Então `register` e `unregister` existem, com duas cercas:
//
//    - quem os chama é o SUPERVISOR (servers/supervisor.ts), e
//      ninguém mais. É ele que garante a ordem certa — o `stop()`
//      do contexto ANTES do `unregister`, para os relógios e o
//      socket já estarem fechados quando o contexto sair do mapa;
//
//    - `list()` devolve uma CÓPIA. Quem estiver iterando quando
//      alguém registrar um servidor termina o laço que começou,
//      em vez de ver a lista mudar no meio.
//
//  O contexto que saiu continua existindo na mão de quem já o
//  tinha; o que ele não faz mais é responder a `get`/`require`, e
//  os relógios dele já estão parados. Ver `unregister`.
// ============================================================

/**
 * O id do servidor que existia antes de haver mais de um.
 *
 * Duas coisas dependem dele, e as duas precisam concordar:
 *
 *   - ele é o ÚNICO que ganha o fallback para o layout antigo de
 *     pastas (`Server\`, `Logs\`, `Backups\`) quando é LÁ que a
 *     instalação está — ver `resolveServerPaths` em config.ts. A
 *     queda é permanente, e serve às instalações anteriores ao
 *     layout; numa máquina limpa ele nasce em `Servers\devserver\`
 *     como qualquer outro;
 *   - ele é o servidor PADRÃO quando existe — ver `defaultServerOf`.
 *
 * Mora aqui, e não em `config.ts`, porque `config.ts` carrega o
 * `.env` como efeito de import: quem quisesse só a regra do padrão
 * arrastaria o dotenv junto. É o mesmo motivo pelo qual
 * `servers/ports.ts` não importa a configuração. A seta aponta de
 * `config.ts` para cá, e ele reexporta os dois.
 */
export const LEGACY_SERVER_ID = 'devserver';

/**
 * Quem responde quando ninguém disse de qual servidor se fala.
 *
 * ####  ELE NÃO É "O PRIMEIRO DA LISTA"  ####
 *
 * É o `devserver` quando ele existe — o servidor que já estava
 * aqui antes de haver mais de um, e o único cuja identidade não
 * pode mudar debaixo de quem já usa o agente. Só na ausência dele
 * é que o primeiro configurado assume.
 *
 * A diferença importa: a lista sai de `Configs\` em ordem
 * ALFABÉTICA, então "o primeiro" mudaria de dono no dia em que
 * alguém criasse `Configs\alpha.ini` — e com ele mudariam o alvo
 * do `pnpm rcon`, a pasta que o vigia da Steam observa e o
 * servidor que o painel mostra por omissão.
 *
 * Uma função só, usada pela configuração em disco E pelo registry
 * em memória: duas regras "equivalentes" divergiriam no dia em que
 * uma das duas ganhasse um caso novo, e o sintoma seria o log
 * falando de um servidor e a tela de outro.
 *
 * `undefined` só quando não há servidor nenhum.
 */
export function defaultServerOf<T extends { readonly id: string }>(
  servers: readonly T[],
): T | undefined {
  return servers.find((server) => server.id === LEGACY_SERVER_ID) ?? servers[0];
}

/**
 * O mínimo que o registry precisa saber de uma entrada.
 *
 * Declarado assim, e não como `ServerContext`, por dois motivos:
 * o registry não usa nada além destes dois campos, e um teste dele
 * não deveria precisar levantar um RconClient e um GameService
 * para perguntar quem é o padrão.
 */
export interface ServerScoped {
  readonly id: string;
  /** Desligado, ele existe e o agente não cuida dele. */
  readonly enabled: boolean;
}

/**
 * Pediram um servidor que não existe.
 *
 * Classe própria porque o tratamento é único: isto vira 404 numa
 * rota (`/api/servers/typo/...`) e é erro de programação em
 * qualquer outro lugar. A mensagem leva a lista do que existe —
 * quem digitou `pvp-2` em vez de `pvp2` descobre na primeira
 * leitura, e não depois de conferir o `Configs\`.
 */
export class UnknownServerError extends Error {
  readonly serverId: string;

  constructor(serverId: string, known: readonly string[]) {
    super(
      `Não existe servidor "${serverId}" neste agente. ` +
        (known.length === 0
          ? 'Nenhum servidor está registrado.'
          : `Os configurados são: ${known.join(', ')}.`),
    );
    this.name = 'UnknownServerError';
    this.serverId = serverId;
  }
}

export class ServerRegistry<T extends ServerScoped> {
  readonly #byId: Map<string, T>;
  #order: T[];
  #defaultId: string;

  /**
   * @param entries os servidores, na ordem em que devem aparecer.
   * Pode ser VAZIA — ver abaixo.
   *
   * ####  POR QUE A LISTA VAZIA É ACEITA  ####
   *
   * Ela já foi recusada aqui, e a regra estava certa: um agente
   * sem servidor nenhum não tem o que fazer. O que estava errado
   * era o LUGAR. Desde que o supervisor monta os contextos (ver
   * servers/supervisor.ts), o registry nasce vazio e recebe cada
   * servidor pelo mesmo `register` que o painel usa em tempo de
   * execução — um construtor exigente obrigaria a existir uma
   * segunda montagem, só para o boot, e é justamente a divergência
   * entre as duas que produz "funciona depois de reiniciar".
   *
   * A regra continua valendo, nos dois pontos em que ela pode ser
   * aplicada olhando o agente inteiro: o boot recusa subir sem
   * nenhum servidor ligado (index.ts) e o supervisor recusa
   * desligar o último.
   *
   * @throws {Error} dois servidores de mesmo id. Isso não é
   * recuperável: significa duas instalações apontando para a mesma
   * pasta de saves, e o segundo silenciaria o primeiro no mapa sem
   * ninguém ver.
   */
  constructor(entries: Iterable<T> = []) {
    const order = [...entries];

    const byId = new Map<string, T>();

    for (const entry of order) {
      if (byId.has(entry.id)) {
        throw new Error(`ServerRegistry recebeu dois servidores com o id "${entry.id}".`);
      }
      byId.set(entry.id, entry);
    }

    this.#byId = byId;
    this.#order = order;
    this.#defaultId = '';
    this.#chooseDefault();
  }

  /**
   * (Re)escolhe o padrão pela MESMA regra da configuração.
   *
   * ####  POR QUE ELE É RECALCULADO, E NÃO FIXO NO BOOT  ####
   *
   * Porque um padrão fixo apontando para um contexto que saiu
   * transformaria `defaultServer()` — que é o que resolve TODA
   * rota sem `:serverId` — num 500 permanente. O alias
   * `/api/deliveries` pararia de responder porque alguém desligou
   * o `devserver` pelo painel.
   *
   * A regra em si não mudou (ver `defaultServerOf`): é o
   * `devserver` quando ele está aqui, e o primeiro registrado
   * quando não. Ela é ESTÁVEL — religar o `devserver` devolve o
   * padrão a ele, e não ao primeiro que chegou.
   *
   * Registry vazio devolve `''`, que faz `defaultServer()` estourar
   * com a mensagem do `UnknownServerError`. Ficar vazio é problema
   * de quem chama: o boot recusa subir assim e o supervisor recusa
   * desligar o último servidor, justamente porque um agente sem
   * nenhum não responde mais nada.
   */
  #chooseDefault(): void {
    this.#defaultId = defaultServerOf(this.#order)?.id ?? '';
  }

  /** `null` = não existe. Para o caminho que TEM o que responder. */
  get(serverId: string): T | null {
    return this.#byId.get(serverId) ?? null;
  }

  /**
   * O mesmo `get`, para quem NÃO tem o que responder sem ele.
   *
   * @throws {UnknownServerError}
   */
  require(serverId: string): T {
    const found = this.#byId.get(serverId);

    if (found === undefined) {
      throw new UnknownServerError(serverId, [...this.#byId.keys()]);
    }

    return found;
  }

  has(serverId: string): boolean {
    return this.#byId.has(serverId);
  }

  /**
   * Acrescenta um servidor DEPOIS do boot.
   *
   * Quem chama é o supervisor, e só ele: registrar um contexto que
   * ninguém ligou deixaria as rotas daquele servidor respondendo
   * 200 com um RCON que nunca vai conectar.
   *
   * @throws {Error} id já registrado. Não é recuperável pela
   * mesma razão do construtor: dois contextos com o mesmo id são
   * dois RconClients falando com o mesmo servidor, e o segundo
   * silenciaria o primeiro no mapa.
   */
  register(entry: T): void {
    if (this.#byId.has(entry.id)) {
      throw new Error(`ServerRegistry já tem um servidor com o id "${entry.id}".`);
    }

    this.#byId.set(entry.id, entry);
    this.#order.push(entry);
    this.#chooseDefault();
  }

  /**
   * Tira um servidor do registry e o devolve. `null` = não estava.
   *
   * ####  ELE NÃO PARA NADA  ####
   *
   * Só mexe no mapa. Quem para os relógios e fecha o socket é o
   * `stop()` do contexto, e ele precisa acontecer ANTES desta
   * chamada — ver o supervisor. Invertido, sobraria uma janela em
   * que o contexto não responde mais a `get` (então ninguém mais o
   * alcança para pará-lo) e os relógios dele continuam batendo.
   */
  unregister(serverId: string): T | null {
    const found = this.#byId.get(serverId);

    if (found === undefined) {
      return null;
    }

    this.#byId.delete(serverId);
    this.#order = this.#order.filter((entry) => entry.id !== serverId);
    this.#chooseDefault();

    return found;
  }

  /**
   * Todos, ligados e desligados, na ordem de registro.
   *
   * CÓPIA, e não a lista viva: quem estiver iterando quando um
   * servidor for registrado ou removido termina o laço que
   * começou, em vez de ver o array mudar de tamanho no meio.
   */
  list(): readonly T[] {
    return [...this.#order];
  }

  /** Só os que o agente cuida. É o que os laços do boot usam. */
  listEnabled(): readonly T[] {
    return this.#order.filter((entry) => entry.enabled);
  }

  /**
   * Quem responde quando ninguém disse de qual servidor se fala.
   *
   * ####  ELE PODE ESTAR DESLIGADO  ####
   *
   * E é de propósito: o padrão é uma IDENTIDADE ("qual servidor
   * este agente considera o principal"), não um estado. Trocá-lo
   * porque alguém pôs `SERVER_ENABLED=0` no `devserver` faria o
   * `pnpm rcon` e o log do boot apontarem para outro servidor sem
   * ninguém ter pedido — que é exatamente a confusão que ter um
   * padrão estável evita.
   *
   * Quem precisa de um servidor NO AR pergunta a `listEnabled()`.
   *
   * Na prática, HOJE, isso não acontece: o supervisor só registra
   * contexto para servidor ligado (montar o de um desligado
   * abriria socket e ligaria os relógios dele). `listEnabled()` e
   * este aviso existem porque a regra é da CLASSE, e o dia em que
   * o registry passar a guardar os desligados não pode mudar quem
   * é o padrão.
   *
   * Quem lista os DESLIGADOS para o painel é a tabela `servers`, e
   * não este mapa — ver http/routes/servers.ts. O registry
   * responde uma pergunta mais estreita: "de quais servidores este
   * agente está cuidando AGORA".
   */
  defaultServer(): T {
    return this.require(this.#defaultId);
  }

  /**
   * O id do padrão, sem trazer a entrada inteira junto.
   *
   * `''` só num registry VAZIO — estado que o construtor recusa e
   * ao qual só se chega desregistrando o último servidor. Ver
   * `#chooseDefault`.
   */
  defaultServerId(): string {
    return this.#defaultId;
  }

  get size(): number {
    return this.#order.length;
  }
}
