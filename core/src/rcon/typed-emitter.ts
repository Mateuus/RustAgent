// ============================================================
//  typed-emitter.ts  -  EventEmitter mínimo e tipado.
//
//  Por que não o EventEmitter do Node:
//
//  1. Tipagem. O do Node aceita qualquer string como evento e
//     "any[]" como payload; aqui um erro de digitação em
//     on('conected') não compila.
//
//  2. O evento 'error'. O EventEmitter do Node LANÇA a exceção
//     quando 'error' é emitido sem ninguém ouvindo — ou seja,
//     um erro de RCON derrubaria o processo só porque ninguém
//     assinou. Este emitter só entrega para quem estiver
//     ouvindo, e o RconClient loga o erro de qualquer forma.
// ============================================================

type EventMap = Record<string, unknown[]>;

type Listener<Args extends unknown[]> = (...args: Args) => void;

export class TypedEmitter<Events extends EventMap> {
  readonly #listeners = new Map<string, Set<Listener<never>>>();

  /**
   * Chamado quando um listener lança — sem isso, a exceção de um
   * ouvinte interromperia a entrega para os demais.
   *
   * É propriedade mutável, e não parâmetro de construtor, por
   * uma limitação de linguagem: uma subclasse não pode tocar em
   * `this` antes de chamar super(), então ela não conseguiria
   * passar um callback que usa o próprio logger. Assim ela
   * instala o hook logo depois do super().
   */
  onListenerError: ((error: unknown, event: string) => void) | undefined;

  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as unknown as Listener<never>);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    const wrapper = ((...args: Events[K]): void => {
      this.off(event, wrapper);
      listener(...args);
    }) as Listener<Events[K]>;
    return this.on(event, wrapper);
  }

  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): this {
    this.#listeners.get(event)?.delete(listener as unknown as Listener<never>);
    return this;
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }

  listenerCount(event: keyof Events & string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }

    // Cópia antes de iterar: um listener pode chamar off() (ou
    // ser um once()) e mutar o Set durante a entrega.
    for (const listener of [...set]) {
      try {
        (listener as unknown as Listener<Events[K]>)(...args);
      } catch (error) {
        this.onListenerError?.(error, event);
      }
    }
  }
}
