'use client';

// ============================================================
//  server-choice.tsx  -  de QUAL servidor é o que está na tela.
//
//  ####  POR QUE ESTA PEÇA EXISTE  ####
//
//  O catálogo do passe é da rede — a temporada, a trilha e as
//  regras de XP são as mesmas para todos —, mas o XP, o nível, o
//  direito comprado e o resgate são POR SERVIDOR (01 §1.4). Quem
//  joga no `pvp1` e no `pvp2` tem duas trilhas.
//
//  A tela precisa DIZER de qual servidor ela está falando, senão a
//  primeira reclamação é "meu nível sumiu". Três abas dependem
//  dessa escolha (Visão geral, Jogadores e Registro), e é por isso
//  que ela é um componente: três seletores parecidos divergiriam no
//  primeiro ajuste.
//
//  ####  NÃO É O `ServerPicker` DO WORKSHOP  ####
//
//  Aquele é de MARCAR VÁRIOS (em que servidores a skin vale). Este é
//  de escolher UM, para olhar. São perguntas diferentes, e um
//  componente que respondesse as duas teria um `multiple` que
//  ninguém consegue ler de relance.
// ============================================================

import { cn } from '@/lib/utils';

export interface BattlePassServerOption {
  readonly id: string;
  readonly name: string;
}

export function ServerChoice({
  servers,
  value,
  busy = false,
  onChange,
}: {
  readonly servers: readonly BattlePassServerOption[];
  readonly value: string;
  readonly busy?: boolean;
  readonly onChange: (serverId: string) => void;
}) {
  if (servers.length === 0) {
    return (
      <p className="text-2xs text-muted">
        Nenhum servidor cadastrado no agente. O XP e o direito comprado são de um servidor — sem
        nenhum, não há trilha de jogador para mostrar.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Servidor</span>

      {servers.map((server) => (
        <button
          key={server.id}
          type="button"
          disabled={busy}
          aria-pressed={value === server.id}
          onClick={() => onChange(server.id)}
          className={cn(
            'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
            'disabled:cursor-not-allowed disabled:opacity-50',
            value === server.id
              ? 'border-olive bg-olive/10 text-foreground'
              : 'border-border text-muted hover:border-muted',
          )}
        >
          {server.name}
        </button>
      ))}
    </div>
  );
}

/**
 * EM QUAIS servidores a temporada vale.
 *
 * A outra pergunta, e por isso o outro componente — mas no mesmo
 * arquivo, porque as duas listam a mesma coisa e uma mudança de
 * aparência tem de alcançar as duas.
 *
 * ####  NENHUM MARCADO NÃO É "TODOS"  ####
 *
 * É "em nenhum" — a mesma regra do catálogo de skins e do item
 * custom. E o problema é que isso não PARECE uma falha: a
 * temporada fica na lista, bonita, publicada, e não aparece em
 * servidor nenhum. Por isso o aviso fica visível.
 */
export function ServerMultiChoice({
  servers,
  value,
  busy = false,
  onChange,
}: {
  readonly servers: readonly BattlePassServerOption[];
  readonly value: readonly string[];
  readonly busy?: boolean;
  readonly onChange: (servers: string[]) => void;
}) {
  if (servers.length === 0) {
    return (
      <p className="text-2xs text-muted">
        Nenhum servidor cadastrado no agente. Enquanto não houver um, a temporada fica só no
        catálogo da rede.
      </p>
    );
  }

  function toggle(id: string): void {
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {servers.map((server) => (
          <button
            key={server.id}
            type="button"
            disabled={busy}
            aria-pressed={value.includes(server.id)}
            onClick={() => toggle(server.id)}
            className={cn(
              'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
              'disabled:cursor-not-allowed disabled:opacity-50',
              value.includes(server.id)
                ? 'border-olive bg-olive/10 text-foreground'
                : 'border-border text-muted hover:border-muted',
            )}
          >
            {server.name}
          </button>
        ))}
      </div>

      {value.length === 0 && (
        <p className="border-l-2 border-rust bg-surface-2 px-3 py-2 text-2xs text-foreground">
          Sem nenhum servidor marcado esta temporada não vale em lugar nenhum: ela não entra no ar
          no dia 1, e ninguém vai relacionar as duas coisas.
        </p>
      )}
    </div>
  );
}
