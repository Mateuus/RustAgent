// ============================================================
//  wallet.ts  -  de onde vem o saldo de OZCoin.
//
//  ####  DUAS FONTES, UMA INTERFACE  ####
//
//  O saldo mora no banco do agente ou no site externo, e quem chama
//  não sabe qual das duas está no ar: as duas implementam `Wallet`,
//  e a escolha acontece uma vez, na inicialização, olhando a
//  configuração. Sem isso, cada ponto que mexe em saldo precisaria
//  de um `if` — e o dia da virada seria uma caçada a todos eles.
//
//  ####  QUAL DELAS ESTÁ VALENDO  ####
//
//  `SITE_BASE_URL` no `.env` mais o `SITE_SERVER_ID` de cada
//  `Configs\<id>.ini` decidem, POR SERVIDOR (ver config.ts):
//
//      sem pareamento -> carteira LOCAL (banco do agente)
//      com pareamento -> carteira do SITE (o site é o dono)
//
//  A virada é preencher e reiniciar. O saldo local NÃO é migrado:
//  são carteiras diferentes, e somar uma na outra sem alguém mandar
//  seria inventar dinheiro.
//
//  ------------------------------------------------------------
//  ####  "NÃO TEM" E "NÃO CONSEGUI PERGUNTAR" SÃO DIFERENTES  ####
//
//  É a distinção que este arquivo existe para preservar. A primeira
//  é resposta ao jogador ("faltam 200"); a segunda é retentável, e
//  tratá-las igual faria a loja dizer "saldo insuficiente" a quem
//  tem dinheiro só porque o site demorou a responder.
//
//  Por isso `WalletBalance.balance` é `number | null`: `null` é
//  "não perguntei", e ZERO é uma afirmação sobre o dinheiro de
//  alguém.
//
//  ####  CINCO DESFECHOS, E NÃO TRÊS  ####
//
//  O site tem cinco famílias de resposta, e colapsá-las produz erro
//  caro. `insufficient` é resposta ao jogador; `rejected` é defeito
//  nosso; `unavailable` é retentável; e `unknown` é o único que NÃO
//  fecha a compra — ele significa "pode ter cobrado", e só a prova
//  do `ChargeProver` o resolve.
//
//  ####  INTEIRO, SEMPRE  ####
//
//  OZCoin não tem centavo. Saldo em float é como um débito de 10
//  vira 9,999999 e o jogador fica com 0,000001 de troco que a tela
//  arredonda para zero.
// ============================================================

export interface WalletBalance {
  readonly steamId: string;
  /**
   * `null` = NÃO CONSEGUI PERGUNTAR, e isso é diferente de zero.
   *
   * O modal já sabe lidar com `null`: `affordable = balance === null
   * || balance >= total` (ui-store-screens.ts:718) deixa o botão de
   * comprar no lugar. Com zero ele o esconde e diz SALDO
   * INSUFICIENTE a quem tem dinheiro — que é o oposto do que
   * ui-store-bridge.ts:110-118 mandou fazer.
   */
  readonly balance: number | null;
  /** De onde veio, para a tela poder dizer. */
  readonly source: 'local' | 'remote';
}

/**
 * A entrada de um movimento de saldo.
 *
 * ####  OBJETO, E NÃO UM QUINTO PARÂMETRO POSICIONAL  ####
 *
 * O débito passa a carregar `productId`, e
 * `debit(steamId, total, reference, reason, offer.id)` é uma chamada
 * que ninguém lê. A casa já prefere objeto quando a chamada tem mais
 * de três coisas — `createPurchase({...}, now)`, `vips.grant({...})`,
 * `recordAction({...})`.
 *
 * A alternativa descartada foi manter os quatro posicionais e
 * acrescentar um quinto opcional: custa menos hoje e cobra depois,
 * no dia em que aparecer o sexto.
 */
export interface WalletMoveInput {
  readonly steamId: string;
  /** Sempre POSITIVO. O sentido é do MÉTODO, nunca do sinal. */
  readonly amount: number;
  /** A referência da compra, já no formato de `reference.ts`. */
  readonly reference: string;
  /**
   * O texto que o JOGADOR lê no extrato. Português, sem jargão.
   *
   * Na carteira do site ele vira `observacao` na fronteira — o nome
   * é do contrato deles.
   */
  readonly reason: string;
  /**
   * O que foi comprado. Ausente = não é venda de catálogo.
   *
   * Ele é o que faz o site conseguir dizer O QUE aquele débito
   * pagou, e o que habilita o guard de replay por produto. O estorno
   * NÃO manda.
   */
  readonly productId?: string | undefined;
}

/**
 * O resultado de mexer no saldo.
 *
 * `insufficient` é um desfecho NORMAL, e não um erro: o jogador
 * tentou comprar sem ter. Ver o cabeçalho.
 */
export type WalletChange =
  /** Cobrou (ou já tinha cobrado, no replay). `balance` é o saldo DEPOIS. */
  | {
      readonly status: 'ok';
      readonly balance: number;
      /** O id da linha no ledger do site. `null` na carteira local e no replay. */
      readonly transactionId: string | null;
      /**
       * `true` quando o dono do saldo respondeu "já tinha cobrado".
       *
       * Significa **já foi cobrado**, NUNCA "já foi entregue" — o
       * site não tem como saber da entrega.
       */
      readonly replayed: boolean;
    }
  /** Não tem. NADA foi cobrado. `message` é a frase do DONO DO SALDO. */
  | {
      readonly status: 'insufficient';
      /** `null` quando o dono do saldo não disse quanto era. NUNCA zero. */
      readonly balance: number | null;
      readonly message: string;
    }
  /**
   * O dono do saldo recusou o PEDIDO. Nada foi cobrado AGORA — mas
   * se `charged` vier preenchido, o dinheiro saiu numa cobrança
   * anterior com esta mesma referência.
   *
   * NUNCA repetir com o mesmo corpo, e NUNCA gerar id novo.
   */
  | {
      readonly status: 'rejected';
      readonly code: string;
      readonly reason: string;
      readonly charged: number | null;
    }
  /** Não deu para falar com o dono do saldo. NADA foi cobrado. */
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      /** `pairing` para de tentar e volta a beaconar. */
      readonly cause: 'pairing' | 'throttled' | 'network';
    }
  /**
   * PODE TER COBRADO. Não entrega, não estorna, não fecha.
   *
   * Nasce de timeout, de erro de rede, de 5xx e de um 200 que não
   * deu para entender. Sem ele, uma resposta perdida no caminho
   * deixa o jogador cobrado e sem item, e nada volta a conferir.
   */
  | { readonly status: 'unknown'; readonly reason: string };

export interface Wallet {
  readonly source: 'local' | 'remote';
  getBalance(steamId: string): Promise<WalletBalance>;
  /**
   * Tira do saldo.
   *
   * `reference` identifica a compra, e é o que torna o débito
   * rastreável e — na carteira do site — idempotente.
   */
  debit(input: WalletMoveInput): Promise<WalletChange>;
  /** Devolve ao saldo. Usado no estorno e pelo admin. */
  credit(input: WalletMoveInput): Promise<WalletChange>;
}

// ============================================================
//  A PROVA DE QUE UMA COBRANÇA ACONTECEU
//
//  ####  ELA MORA AQUI, E NÃO NA CARTEIRA DO SITE  ####
//
//  `StoreService` precisa DESTE TIPO para declarar a dependência da
//  reconciliação. Se ele morasse em `site-wallet.ts`, `service.ts`
//  teria de importar o arquivo do site — e a loja passaria a saber
//  que existe um site, que é justamente o que esta fronteira evita.
//
//  Interface própria, e não um método a mais em `Wallet`, porque a
//  `LocalWallet` não tem o que provar: ela É o ledger.
// ============================================================

export type ChargeProofResult =
  /** A transação existe: o dinheiro SAIU. */
  | {
      readonly status: 'charged';
      readonly amount: number;
      readonly transactionId: string | null;
      readonly productId: string | null;
    }
  /** Prova de que NADA foi cobrado. */
  | { readonly status: 'not-charged' }
  /**
   * A pergunta é inválida PARA SEMPRE, ou a linha não é desta
   * identidade. Sai do laço e vai para gente.
   *
   * Não é `unknown`: `unknown` volta no minuto seguinte, e isto
   * poria o relógio batendo para sempre num pedido que nunca passa.
   */
  | { readonly status: 'unprovable'; readonly reason: string }
  /** Não deu para perguntar. NÃO decide nada — "na dúvida, preserva". */
  | { readonly status: 'unknown'; readonly reason: string };

export interface ChargeProver {
  proveCharge(input: {
    readonly reference: string;
    readonly steamId: string;
  }): Promise<ChargeProofResult>;
}

// ============================================================
//  A CARTEIRA LOCAL
// ============================================================

/**
 * O que a carteira local precisa do banco. E nada além disso.
 *
 * Interface mínima de propósito: quem a satisfaz em produção é o
 * `WalletsRepository`, e no teste são cinco linhas em memória.
 */
export interface WalletStore {
  getBalance(steamId: string): number;
  /**
   * Aplica a variação e devolve o saldo novo.
   *
   * `null` quando não há saldo suficiente — a checagem e a escrita
   * acontecem na MESMA transação, e é isso que impede dois débitos
   * simultâneos de deixarem o saldo negativo.
   */
  change(
    steamId: string,
    amount: number,
    reference: string | null,
    reason: string,
    now?: number,
  ): number | null;
}

export class LocalWallet implements Wallet {
  readonly source = 'local' as const;
  readonly #store: WalletStore;

  constructor(store: WalletStore) {
    this.#store = store;
  }

  getBalance(steamId: string): Promise<WalletBalance> {
    // O banco local sempre responde: aqui `null` não acontece.
    return Promise.resolve({
      steamId,
      balance: this.#store.getBalance(steamId),
      source: this.source,
    });
  }

  debit(input: WalletMoveInput): Promise<WalletChange> {
    const amount = Math.abs(Math.trunc(input.amount));
    const balance = this.#store.change(input.steamId, -amount, input.reference, input.reason);

    if (balance !== null) {
      // A carteira local É o ledger: não há id de transação para
      // dar, e nunca há replay.
      return Promise.resolve({ status: 'ok', balance, transactionId: null, replayed: false });
    }

    const current = this.#store.getBalance(input.steamId);

    // A MESMA frase do site, no MESMO formato — inclusive o "Voce"
    // sem acento, que é como o site a escreve. Assim quem monta o
    // texto do jogador não precisa de um `if` para saber quem é o
    // dono do saldo, e o suporte não lê duas versões da mesma
    // história.
    return Promise.resolve({
      status: 'insufficient',
      balance: current,
      message:
        `Saldo insuficiente. Voce tem ${String(current)} OZ, o item custa ` +
        `${String(amount)} OZ (faltam ${String(amount - current)}).`,
    });
  }

  credit(input: WalletMoveInput): Promise<WalletChange> {
    const balance = this.#store.change(
      input.steamId,
      Math.abs(Math.trunc(input.amount)),
      input.reference,
      input.reason,
    );

    // Crédito não tem como faltar saldo; `null` aqui seria um
    // defeito nosso, e devolver "indisponível" é mais honesto do que
    // dizer que creditou.
    return Promise.resolve(
      balance === null
        ? { status: 'unavailable', reason: 'a carteira local recusou um crédito', cause: 'network' }
        : { status: 'ok', balance, transactionId: null, replayed: false },
    );
  }
}
