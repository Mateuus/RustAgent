// ============================================================
//  boot-watch.ts  -  ler o log do jogo ENQUANTO o servidor sobe.
//
//  ####  O DEFEITO QUE ISTO EXISTE PARA IMPEDIR  ####
//
//  O `#start` esperava o RCON olhando UMA coisa: `isConnected`.
//  Quando o boot morria — um Oxide defasado, um assembly trocado
//  —, o processo continuava vivo e o RCON nunca abria. O agente
//  ficava quinze minutos calado e terminava dizendo:
//
//      "pode ser um mapa grande ainda gerando"
//
//  ...enquanto a causa estava em disco, na terceira linha do fim
//  do log do jogo, desde o segundo 40. A frase não só era inútil:
//  mandava quem a lia procurar no lugar errado.
//
//  ------------------------------------------------------------
//  ####  QUAIS EXCEÇÕES CONTAM, E POR QUE TÃO POUCAS  ####
//
//  Um boot SAUDÁVEL do Rust é cheio de linha assustadora. Medido
//  num boot que terminou bem, com o servidor no ar e 399 linhas:
//
//      Shader '...': fallback shader '...' not found
//      Missing shader in Main Camera (TOD_Scattering)
//      Missing EnvSync - creating
//      SocketException: ...cancelamento de uma conexão existente
//      Rethrow as IOException: Unable to read data...
//
//  Nenhuma delas impede nada. `SocketException` em especial é
//  rotina (a Steam fecha conexões), e `NullReferenceException` é
//  o pão de cada dia de plugin mal escrito — que também não
//  derruba o servidor.
//
//  Por isso a lista aqui é curta e específica: só as exceções de
//  CARGA DE ASSEMBLY. Elas têm uma propriedade que as outras não
//  têm — significam que os `.dll` em `Managed\` não combinam entre
//  si, e disso o boot não se recupera nunca. É o defeito do Oxide
//  defasado (ver oxide/compat.ts) e o de qualquer DLL trocada à
//  mão.
//
//  Falso positivo aqui custa caro: mataria a operação de um
//  servidor que ia subir. Por isso a régua é "não se recupera
//  nunca", e não "parece grave".
// ============================================================

import { open, stat } from 'node:fs/promises';

/**
 * As exceções que provam `Managed\` inconsistente.
 *
 * Todas dizem a mesma coisa por caminhos diferentes: o código
 * compilado procurou algo que o assembly ao lado não tem.
 */
const FATAL_PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  {
    re: /\bMissingMethodException\b/,
    what: 'um assembly chama um método que não existe mais nos outros',
  },
  {
    re: /\bMissingFieldException\b/,
    what: 'um assembly usa um campo que não existe mais nos outros',
  },
  {
    re: /\bTypeLoadException\b/,
    what: 'um tipo não pôde ser carregado — assemblies de versões diferentes',
  },
  {
    re: /\bReflectionTypeLoadException\b/,
    what: 'os tipos de um assembly não carregaram',
  },
  {
    re: /\bBadImageFormatException\b/,
    what: 'um assembly está corrompido ou é de outra arquitetura',
  },
  {
    re: /Could not load file or assembly/i,
    what: 'falta um assembly em RustDedicated_Data\\Managed',
  },
];

export interface FatalBootError {
  /** A linha do log, como está lá. */
  readonly line: string;
  /** O que ela significa, em português. */
  readonly what: string;
}

/**
 * Esta linha é uma exceção que mata o boot?
 *
 * Pura de propósito: é a regra que decide matar uma operação, e
 * ela precisa ser testável contra um log de verdade sem subir
 * servidor nenhum.
 */
export function fatalBootError(line: string): FatalBootError | null {
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.re.test(line)) {
      return { line: line.trim(), what: pattern.what };
    }
  }

  return null;
}

/**
 * Acompanha o log de um boot, de leitura em leitura.
 *
 * ####  POR OFFSET, E NÃO RELENDO O ARQUIVO  ####
 *
 * O log do jogo passa de 100 KB antes do mundo carregar, e a
 * espera consulta a cada poucos segundos. Reler tudo toda vez
 * seria trabalho crescente para responder sempre a mesma coisa;
 * pior, uma exceção já vista voltaria a ser "nova" a cada volta.
 *
 * O offset também resolve o arquivo TRUNCADO: um start novo
 * reabre o mesmo caminho do zero, e ler a partir de um offset
 * maior que o tamanho atual devolveria lixo. Ver `read`.
 */
export class BootLogWatcher {
  readonly #path: string;
  #offset = 0;
  /** As últimas linhas vistas, para a mensagem de quem desistir. */
  #tail: string[] = [];
  #carry = '';

  constructor(path: string, options: { readonly fromStart?: boolean } = {}) {
    this.#path = path;

    if (options.fromStart === true) {
      this.#offset = 0;
    }
  }

  /** O caminho vigiado, para a mensagem de erro citá-lo. */
  get path(): string {
    return this.#path;
  }

  /**
   * O que o log ganhou desde a última chamada.
   *
   * Devolve `[]` — e não lança — quando o arquivo ainda não
   * existe: entre subir o processo e o Unity criar o `-logfile`
   * passam alguns segundos, e isso é o normal, não uma falha.
   */
  async read(): Promise<readonly string[]> {
    let size: number;

    try {
      size = (await stat(this.#path)).size;
    } catch {
      return [];
    }

    // Encolheu = outro processo recriou o arquivo. Recomeçar do
    // zero é a única leitura que não devolve texto cortado ao
    // meio de duas execuções diferentes.
    if (size < this.#offset) {
      this.#offset = 0;
      this.#carry = '';
      this.#tail = [];
    }

    if (size === this.#offset) {
      return [];
    }

    const handle = await open(this.#path, 'r');

    try {
      const length = size - this.#offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);

      this.#offset += bytesRead;

      // O pedaço lido quase sempre termina no meio de uma linha —
      // a última fica guardada até a quebra chegar, senão uma
      // exceção partida em duas leituras não casaria com padrão
      // nenhum.
      const text = this.#carry + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split(/\r\n|\r|\n/);

      this.#carry = lines.pop() ?? '';

      const fresh = lines.filter((line) => line.trim() !== '');

      this.#tail = [...this.#tail, ...fresh].slice(-TAIL_LINES);

      return fresh;
    } finally {
      await handle.close();
    }
  }

  /**
   * A primeira exceção fatal no que o log ganhou agora.
   *
   * Consome a leitura: chamar duas vezes seguidas não repete as
   * mesmas linhas.
   */
  async findFatal(): Promise<FatalBootError | null> {
    for (const line of await this.read()) {
      const fatal = fatalBootError(line);

      if (fatal !== null) {
        return fatal;
      }
    }

    return null;
  }

  /**
   * As últimas linhas vistas.
   *
   * É o que a mensagem de "desisti de esperar" mostra. Um boot
   * que está gerando mapa termina em `Height Map`/`Lakes`; um que
   * morreu termina no rastro da exceção. As duas coisas dizem
   * mais do que qualquer frase que o agente pudesse inventar.
   */
  tail(): readonly string[] {
    return this.#tail;
  }
}

/** Quantas linhas do fim guardar. */
const TAIL_LINES = 12;
