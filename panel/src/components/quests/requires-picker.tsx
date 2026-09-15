'use client';

// ============================================================
//  requires-picker.tsx  -  quem pode VER a missão.
//
//  ####  ERA UM CAMPO DE TEXTO, E O FORMATO MORAVA NA DICA  ####
//
//  `vip:ouro`, dizia a dica embaixo. Quem não soubesse o nome exato
//  do nível digitava o que parecia certo — e uma quest com um
//  requisito que não casa com nada não dá erro: ela simplesmente
//  não aparece para ninguém, para sempre. É o mesmo desenho do
//  `quest.completed` da recompensa, com outro campo.
//
//  Agora os níveis vêm do cadastro de VIP, e escolher é clicar.
//
//  ####  VÁRIOS, E QUALQUER UM BASTA  ####
//
//  Pedido do dono em 14/09/2026: "vai selecionando e ativando", e,
//  perguntado, foi explícito — quem tiver QUALQUER um dos
//  escolhidos vê. Nada escolhido = todo mundo vê, que é o estado
//  normal da maioria das missões.
//
//  O valor sai daqui no formato que a coluna guarda:
//  `vip:ouro,vip:bronze`. Quem o lê do outro lado é
//  `core/src/quests/requires.ts`.
// ============================================================

import { useEffect, useState } from 'react';

import { agent, type VipTier } from '@/lib/api';
import { cn } from '@/lib/utils';

import { parseRequires, formatRequires, vipRequirement } from './requires-choice';

export interface RequiresPickerProps {
  /** O campo como está gravado. `null` = todo mundo vê. */
  readonly value: string | null;
  readonly onChange: (requires: string | null) => void;
}

export function RequiresPicker({ value, onChange }: RequiresPickerProps) {
  const [tiers, setTiers] = useState<readonly VipTier[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;

    agent
      .vipTiers()
      .then((response) => {
        if (alive) {
          setTiers(response.tiers);
        }
      })
      // ####  A LISTA SOME; O QUE JÁ FOI ESCOLHIDO FICA  ####
      //
      // Os níveis vêm do `OrigemZVip.json` de cada servidor, e um
      // agente que nunca falou com nenhum servidor não tem lista
      // nenhuma para dar. O que está gravado continua aparecendo
      // como chip, e continua salvando igual.
      .catch(() => {
        if (alive) {
          setFailed(true);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  const chosen = parseRequires(value);
  const known = new Set(tiers.map((tier) => vipRequirement(tier.tier)));

  // O que está gravado e não está na lista: nível apagado, servidor
  // que não subiu, ou o texto que alguém digitou à mão antes deste
  // seletor existir. Ele continua clicável — para poder SAIR.
  const extras = chosen.filter((requirement) => !known.has(requirement));

  function toggle(requirement: string): void {
    onChange(
      formatRequires(
        chosen.includes(requirement)
          ? chosen.filter((item) => item !== requirement)
          : [...chosen, requirement],
      ),
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5 rounded border border-border bg-background p-2">
        {tiers.map((tier) => {
          const requirement = vipRequirement(tier.tier);
          const active = chosen.includes(requirement);

          return (
            <button
              key={tier.tier}
              type="button"
              aria-pressed={active}
              title={tier.group}
              onClick={() => toggle(requirement)}
              className={cn(
                'rounded border px-2 py-1 text-2xs uppercase tracking-wide',
                active
                  ? 'border-rust bg-rust/15 text-foreground'
                  : 'border-border text-muted hover:text-foreground',
              )}
            >
              {tier.title ?? tier.tier}
            </button>
          );
        })}

        {extras.map((requirement) => (
          <button
            key={requirement}
            type="button"
            aria-pressed
            title="Este requisito não está na lista de níveis deste agente"
            onClick={() => toggle(requirement)}
            className="rounded border border-amber/60 bg-amber/10 px-2 py-1 font-mono text-2xs text-foreground"
          >
            {requirement}
          </button>
        ))}

        {/* O vazio precisa DIZER que é vazio: uma caixa em branco
            deixa a dúvida entre "todo mundo vê" e "a lista não
            carregou". */}
        {tiers.length === 0 && extras.length === 0 && (
          <span className="text-2xs text-muted">
            {failed
              ? 'Não deu para ler os níveis de VIP agora.'
              : 'Nenhum nível de VIP cadastrado — a missão aparece para todos.'}
          </span>
        )}
      </div>

      <p className="text-2xs text-muted">
        {chosen.length === 0
          ? 'Nada marcado: todo mundo vê esta missão.'
          : 'Quem tiver QUALQUER um dos marcados vê esta missão.'}
      </p>
    </div>
  );
}
