// ============================================================
//  variables.ts  -  `{servidor}`, `{online}`, `{wipe.faltam}`.
//
//  As variáveis são resolvidas NO AGENTE, no instante do envio, por
//  provedores REGISTRADOS. Não há uma lista fechada aqui dentro: o
//  módulo de mensagens não pode saber o que é um wipe (Docs/16
//  §11), então quem entende de `{wipe.*}` é a Frente F, e ela se
//  registra neste mesmo registro na subida.
//
//  ------------------------------------------------------------
//  ####  VARIÁVEL DESCONHECIDA FICA LITERAL  ####
//
//  `{wipe.faltan}` sai no chat exatamente assim. É feio, e é de
//  propósito: o admin conserta em dez segundos, porque VÊ. Uma
//  frase que perde metade em silêncio ele descobre semanas depois —
//  ou nunca.
//
//  A mesma regra vale para o provedor que existe e não tem resposta
//  agora: ele devolve uma frase ("sem wipe agendado"), e não vazio.
//  Vazio é a única resposta que nunca ajuda ninguém.
//
//  ------------------------------------------------------------
//  ####  O QUE JÁ FOI RESOLVIDO NÃO É RELIDO  ####
//
//  Um texto de jogador que contivesse `{online}` viraria número se
//  a resolução fosse recursiva; pior, um provedor que devolvesse
//  `{servidor}` entraria em laço. Uma passada só, da esquerda para
//  a direita, e o resultado é texto morto.
//
//  ------------------------------------------------------------
//  ####  UM PROVEDOR QUE LANÇA NÃO DERRUBA A FRASE  ####
//
//  Ele é código de outra frente, chamado de dentro de um relógio.
//  A exceção vira a variável literal e uma linha de log — perder o
//  aviso inteiro porque a agenda de wipe não respondeu seria trocar
//  um defeito pequeno e visível por um grande e mudo.
// ============================================================

import type { Logger } from '../logger.js';
import { toError } from '../util.js';

/** De quem, e para quem, é esta fala. */
export interface VariableContext {
  readonly serverId: string;
  /** Preenchido só na fala dirigida a UM jogador. */
  readonly steamId?: string | undefined;
}

/**
 * Resolve uma variável. `null` = "não sei", e aí ela fica literal.
 *
 * Pode devolver promessa: `{online}` pergunta ao servidor, e
 * `{wipe.quando}` lê o banco.
 */
export type VariableResolver = (
  context: VariableContext,
) => string | null | Promise<string | null>;

/**
 * Resolve uma FAMÍLIA de variáveis: recebe o que vem depois do
 * ponto (`faltam`, em `{wipe.faltam}`).
 *
 * É por aqui que a Frente F entra sem este arquivo precisar
 * conhecer nenhum nome de wipe.
 */
export type NamespaceResolver = (
  rest: string,
  context: VariableContext,
) => string | null | Promise<string | null>;

/**
 * O que é um nome de variável.
 *
 * Letras, dígitos, ponto, hífen e sublinhado. Sem espaço de
 * propósito: `{ }` e `{ isso não é variável }` ficam intocados, e é
 * o que salva um texto que só usa chaves como pontuação.
 */
const VARIABLE_PATTERN = /\{([A-Za-z][A-Za-z0-9_.-]*)\}/g;

/** Os nomes que o núcleo resolve sozinho, para a tela listar. */
export const CORE_VARIABLES = ['servidor', 'online', 'max'] as const;

/** O que o registro do núcleo precisa saber do servidor. */
export interface VariableServers {
  /** O nome do servidor, como ele aparece na lista da Steam. */
  nameOf(serverId: string): string | null;
  /** Quantas vagas ele tem. `null` = não deu para saber. */
  slotsOf(serverId: string): number | null;
  /** Quantos estão online AGORA. `null` = não deu para perguntar. */
  onlineOf(serverId: string): Promise<number | null>;
}

export interface VariableRegistryDeps {
  readonly logger?: Logger | undefined;
}

/**
 * Quem sabe trocar `{isto}` pelo valor de agora.
 *
 * Uma instância por processo: ela é o ponto em que as frentes se
 * encontram, e duas instâncias fariam o `{wipe.faltam}` funcionar
 * na rota e não funcionar no relógio.
 */
export class VariableRegistry {
  readonly #names = new Map<string, VariableResolver>();
  readonly #namespaces = new Map<string, NamespaceResolver>();
  readonly #logger: Logger | undefined;

  constructor(deps: VariableRegistryDeps = {}) {
    this.#logger = deps.logger;
  }

  /**
   * Um nome exato: `{servidor}`.
   *
   * Registrar duas vezes o mesmo nome SUBSTITUI, e não acumula: o
   * caso real é a subida registrar o núcleo e um teste trocar um
   * provedor por outro. Um erro aqui obrigaria a ordem de montagem
   * a ser conhecida por quem registra.
   */
  set(name: string, resolver: VariableResolver): void {
    this.#names.set(name.toLowerCase(), resolver);
  }

  /**
   * Uma família: `wipe` atende `{wipe.faltam}`, `{wipe.quando}`, e
   * o que a Frente F inventar depois.
   *
   * O nome exato ganha do namespace na hora de resolver: quem
   * registrou `{wipe}` sozinho quis dizer aquilo.
   */
  setNamespace(prefix: string, resolver: NamespaceResolver): void {
    this.#namespaces.set(prefix.toLowerCase(), resolver);
  }

  /** Os nomes exatos registrados, para a tela e para o log. */
  names(): readonly string[] {
    return [...this.#names.keys()].sort();
  }

  /** Os prefixos de família registrados. */
  namespaces(): readonly string[] {
    return [...this.#namespaces.keys()].sort();
  }

  /**
   * Troca o que souber, e deixa o resto como está.
   *
   * NUNCA lança — ver o cabeçalho. O texto que sai daqui já pode ir
   * para o chat.
   */
  async resolve(text: string, context: VariableContext): Promise<string> {
    // Uma passada para achar, outra para montar: `replace` não
    // aceita função assíncrona, e resolver em série dentro de um
    // laço é o que permite um provedor perguntar ao servidor.
    const found = [...text.matchAll(VARIABLE_PATTERN)];

    if (found.length === 0) {
      return text;
    }

    // O mesmo nome duas vezes na frase é uma pergunta só: `{online}`
    // repetido não vale duas idas ao RCON.
    const values = new Map<string, string | null>();

    for (const match of found) {
      const name = (match[1] ?? '').toLowerCase();

      if (values.has(name)) {
        continue;
      }

      values.set(name, await this.#resolveOne(name, context));
    }

    let out = '';
    let cursor = 0;

    for (const match of found) {
      const at = match.index;
      const whole = match[0];
      const value = values.get((match[1] ?? '').toLowerCase()) ?? null;

      out += text.slice(cursor, at);
      // `null` = ninguém soube: o marcador fica LITERAL, com as
      // chaves e tudo. Ver o cabeçalho.
      out += value ?? whole;
      cursor = at + whole.length;
    }

    return out + text.slice(cursor);
  }

  async #resolveOne(name: string, context: VariableContext): Promise<string | null> {
    const exact = this.#names.get(name);
    const dot = name.indexOf('.');
    const namespaced =
      dot === -1 ? undefined : this.#namespaces.get(name.slice(0, dot));

    try {
      if (exact !== undefined) {
        return await exact(context);
      }

      if (namespaced !== undefined) {
        return await namespaced(name.slice(dot + 1), context);
      }
    } catch (error) {
      this.#logger?.warn(
        { variable: name, server: context.serverId, err: toError(error) },
        'o provedor da variável falhou; ela sai literal no chat',
      );
    }

    return null;
  }
}

/**
 * Registra `{servidor}`, `{online}` e `{max}`.
 *
 * Separada do construtor de propósito: o registro é um mecanismo, e
 * estes três são política. É o que permite um teste montar um
 * registro vazio e conferir que variável desconhecida fica literal
 * sem precisar de supervisor nenhum.
 */
export function registerCoreVariables(
  registry: VariableRegistry,
  servers: VariableServers,
): void {
  registry.set('servidor', (context) => servers.nameOf(context.serverId) ?? context.serverId);

  registry.set('online', async (context) => {
    const online = await servers.onlineOf(context.serverId);

    // Não deu para perguntar NÃO é zero: dizer "0 jogadores online"
    // num servidor cheio porque o RCON piscou é pior que a frase
    // com a variável crua. Ver game/plugin-contract.ts, a mesma
    // regra.
    return online === null ? null : String(online);
  });

  registry.set('max', (context) => {
    const slots = servers.slotsOf(context.serverId);

    return slots === null || slots <= 0 ? null : String(slots);
  });
}
