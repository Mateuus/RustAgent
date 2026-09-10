'use client';

// ============================================================
//  betterloot-table-profiles.tsx  -  os perfis DESTA caixa.
//
//  ####  A ASSOCIAÇÃO MORA NA CAIXA, E NÃO NO PERFIL  ####
//
//  O perfil é uma entrada do `LootGroups.json` e não sabe onde é
//  sorteado. Quem sabe é o prefab, no campo `Loot Profiles` do
//  `LootTables.json` — que é o que este bloco edita. Por isso o
//  "Gravar" que vale aqui é o da CAIXA, e não o da aba de perfis.
//
//  ####  A PORCENTAGEM É "DE ONDE VEM O ITEM"  ####
//
//  Ela não é a chance de um item; é a chance de aquele SLOT da
//  caixa ser sorteado deste perfil em vez da lista solta. O que
//  sobra depois de somar os perfis ligados vai para os itens
//  soltos — é a barra que este bloco mostra em cima.
//
//  30% é o padrão que o próprio plugin usa no exemplo dele
//  (`BetterLoot.cs:647`), e é com ele que uma associação nasce.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BetterLootProfileSummary, BetterLootTable } from '@/lib/api';

/** O que uma associação nova recebe. Ver o cabeçalho. */
const DEFAULT_PROBABILITY = 30;

interface BetterLootTableProfilesProps {
  readonly table: BetterLootTable;
  readonly onChange: (next: BetterLootTable) => void;
  /** Todos os perfis do servidor — os que podem ser ligados aqui. */
  readonly available: readonly BetterLootProfileSummary[];
  readonly busy: boolean;
}

export function BetterLootTableProfiles({
  table,
  onChange,
  available,
  busy,
}: BetterLootTableProfilesProps) {
  const [picked, setPicked] = useState('');

  const linked = table.profiles;
  const linkedNames = new Set(linked.map((link) => link.name));
  const free = available.filter((profile) => !linkedNames.has(profile.name));

  /** Quanto dos sorteios vem de perfil. O resto vem dos itens soltos. */
  const fromProfiles = Math.min(
    100,
    linked.filter((link) => link.enabled).reduce((total, link) => total + link.probability, 0),
  );

  const patch = (name: string, next: Partial<(typeof linked)[number]>): void => {
    onChange({
      ...table,
      profiles: linked.map((link) => (link.name === name ? { ...link, ...next } : link)),
    });
  };

  const add = (): void => {
    if (picked === '' || linkedNames.has(picked)) {
      return;
    }

    onChange({
      ...table,
      profiles: [
        ...linked,
        { name: picked, enabled: true, probability: DEFAULT_PROBABILITY, maxItems: 0 },
      ],
      profileCount: linked.length + 1,
    });

    setPicked('');
  };

  return (
    <section className="space-y-2 border border-border bg-surface p-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">
          Perfis desta caixa
        </h3>
        <span className="text-2xs text-muted">
          {fromProfiles}% dos sorteios vêm de perfil · {100 - fromProfiles}% dos itens soltos
        </span>
      </div>

      {/* A barra existe porque o número sozinho não diz que os dois
          disputam o MESMO sorteio — e é essa a parte que se erra. */}
      <div className="flex h-1.5 overflow-hidden rounded bg-surface-2">
        <div className="bg-accent" style={{ width: `${String(fromProfiles)}%` }} />
        <div className="bg-border" style={{ width: `${String(100 - fromProfiles)}%` }} />
      </div>

      {linked.length === 0 ? (
        <p className="text-2xs text-muted">
          Nenhum perfil ligado: esta caixa sorteia só os itens soltos da lista abaixo, por raridade
          do jogo.
        </p>
      ) : (
        <ul className="space-y-1">
          {linked.map((link) => {
            const profile = available.find((item) => item.name === link.name) ?? null;

            return (
              <li
                key={link.name}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-2 border border-border px-2 py-1"
              >
                <span className="min-w-0">
                  <span className="block truncate text-2xs font-medium">{link.name}</span>
                  {/* ####  O PERFIL PODE NÃO EXISTIR MAIS  ####
                      O BetterLoot ignora o import órfão e só resmunga
                      no log; sem este aviso o admin acharia que a
                      caixa está sorteando algo que ela não sorteia. */}
                  {profile === null ? (
                    <span className="block text-2xs text-danger">
                      Este perfil não existe mais — o BetterLoot ignora esta linha.
                    </span>
                  ) : (
                    !profile.enabled && (
                      <span className="block text-2xs text-amber">
                        O perfil está desligado na aba Perfis: nada sai dele.
                      </span>
                    )
                  )}
                </span>

                <label className="flex items-center gap-1 text-2xs text-muted">
                  <span>Chance</span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={String(link.probability)}
                    disabled={busy}
                    onChange={(event) =>
                      patch(link.name, { probability: Number(event.target.value) })
                    }
                    className="h-7 w-16 text-right text-2xs"
                  />
                  <span>%</span>
                </label>

                <label className="flex items-center gap-1 text-2xs text-muted">
                  {/* 0 = sem limite, e é o padrão do plugin. */}
                  <span title="Máximo de itens vindos deste perfil por caixa. 0 = sem limite.">
                    Teto
                  </span>
                  <Input
                    type="number"
                    min={0}
                    value={String(link.maxItems)}
                    disabled={busy}
                    onChange={(event) => patch(link.name, { maxItems: Number(event.target.value) })}
                    className="h-7 w-14 text-right text-2xs"
                  />
                </label>

                <label className="flex items-center gap-1 text-2xs text-muted">
                  <input
                    type="checkbox"
                    checked={link.enabled}
                    disabled={busy}
                    onChange={(event) => patch(link.name, { enabled: event.target.checked })}
                  />
                  Ligado
                </label>

                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      ...table,
                      profiles: linked.filter((other) => other.name !== link.name),
                      profileCount: linked.length - 1,
                    })
                  }
                  title="Tirar este perfil da caixa"
                >
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {free.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Label htmlFor="link-profile">Ligar um perfil a esta caixa</Label>
            <select
              id="link-profile"
              value={picked}
              disabled={busy}
              onChange={(event) => setPicked(event.target.value)}
              className="h-8 w-full border border-border bg-surface-2 px-2 text-2xs"
            >
              <option value="">Escolha um perfil…</option>
              {free.map((profile) => (
                <option key={profile.name} value={profile.name}>
                  {profile.name} ({profile.itemCount} itens)
                  {profile.enabled ? '' : ' — desligado'}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            disabled={picked === '' || busy}
            onClick={add}
            className="flex items-center gap-1"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Ligar
          </Button>
        </div>
      )}

      {available.length === 0 && (
        <p className="text-2xs text-muted">
          Ainda não há perfis neste servidor. Crie um na aba <strong>Perfis</strong> para poder
          ligá-lo aqui.
        </p>
      )}
    </section>
  );
}
