'use client';

// ============================================================
//  server-picker.tsx  -  em que servidores a skin vale.
//
//  ####  O CATÁLOGO É DA REDE; ISTO É O QUE É POR SERVIDOR  ####
//
//  A skin é cadastrada uma vez para a rede inteira. A única coisa
//  que muda de servidor para servidor é ESTA lista — e é por isso
//  que ela é um componente à parte: o formulário a usa no cadastro,
//  e a lista a usa para mexer numa skin já gravada sem reenviar o
//  resto do formulário.
//
//  ####  NENHUM MARCADO NÃO É O MESMO QUE "TODOS"  ####
//
//  É "em nenhum". A regra vem do catálogo de itens custom e existe
//  para uma skin recém-cadastrada não entrar em produção sem
//  ninguém mandar. O problema é que ela não PARECE uma falha: a
//  skin fica na tela, bonita, e o item nasce vanilla no jogo para
//  sempre. Por isso o aviso é vermelho e fica visível.
// ============================================================

import { cn } from '@/lib/utils';

export interface WorkshopServerOption {
  readonly id: string;
  readonly name: string;
}

export interface ServerPickerProps {
  /** Os ids marcados agora. */
  readonly value: readonly string[];
  readonly servers: readonly WorkshopServerOption[];
  readonly busy?: boolean;
  readonly onChange: (servers: string[]) => void;
}

export function ServerPicker({ value, servers, busy = false, onChange }: ServerPickerProps) {
  // O agente pode responder sem a lista — ver o cabeçalho de
  // api.ts. Ler um `undefined` aqui derrubaria a tela inteira.
  const chosen = value;

  function toggle(id: string): void {
    onChange(chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id]);
  }

  if (servers.length === 0) {
    return (
      <p className="text-2xs text-muted">
        Nenhum servidor cadastrado no agente. Enquanto não houver um, a skin fica só no catálogo.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {servers.map((server) => (
          <button
            key={server.id}
            type="button"
            disabled={busy}
            aria-pressed={chosen.includes(server.id)}
            onClick={() => toggle(server.id)}
            className={cn(
              'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
              'disabled:cursor-not-allowed disabled:opacity-50',
              chosen.includes(server.id)
                ? 'border-olive bg-olive/10 text-foreground'
                : 'border-border text-muted hover:border-muted',
            )}
          >
            {server.name}
          </button>
        ))}
      </div>

      {chosen.length === 0 && (
        <p className="text-2xs text-rust">
          Sem nenhum servidor marcado esta skin não chega a lugar nenhum: o item continua nascendo
          vanilla, e nada no jogo diz por quê.
        </p>
      )}
    </div>
  );
}
