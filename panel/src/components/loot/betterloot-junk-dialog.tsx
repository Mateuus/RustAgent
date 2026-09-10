'use client';

// ============================================================
//  betterloot-junk-dialog.tsx  -  o que é "lixo" neste servidor.
//
//  ####  ESTA LISTA NÃO VAI PARA O DISCO DO SERVIDOR  ####
//
//  O BetterLoot não conhece a palavra "junk" — medido no fonte
//  v4.4.0: zero ocorrências. A lista é curadoria NOSSA, mora no
//  banco do agente e serve a uma coisa só: o botão "Remover lixo"
//  do editor de caixa, que tira do RASCUNHO os itens marcados aqui.
//
//  O que chega ao jogo é a caixa já sem eles, gravada pelo mesmo
//  "Gravar" de sempre — com backup, revisão e "Descartar".
//
//  ####  DOIS TIPOS DE LINHA, E TIRAR CADA UMA É DIFERENTE  ####
//
//  Os 31 padrões vieram da curadoria do Looty e moram no CÓDIGO do
//  agente. Tirar um deles não o apaga: ele fica desligado, visível
//  e apagado, para poder voltar. O que o admin acrescentou some de
//  vez — porque ele é só do admin.
//
//  Ver Docs/CustomItem/08-ESTUDO-DO-LOOTY.md §3.
// ============================================================

import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { BetterLootJunkItem } from '@/lib/api';

interface BetterLootJunkDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly serverId: string;
  readonly items: readonly BetterLootJunkItem[];
  readonly busy: boolean;
  readonly onAdd: (shortname: string) => void;
  readonly onRemove: (shortname: string) => void;
}

export function BetterLootJunkDialog({
  open,
  onClose,
  serverId,
  items,
  busy,
  onAdd,
  onRemove,
}: BetterLootJunkDialogProps) {
  const [shortname, setShortname] = useState('');

  const trimmed = shortname.trim();
  const active = items.filter((item) => item.active);
  const off = items.filter((item) => !item.active);

  const submit = (): void => {
    if (trimmed === '' || busy) {
      return;
    }

    onAdd(trimmed);
    setShortname('');
  };

  return (
    <Dialog open={open} title="O que é lixo neste servidor" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-2xs text-muted">
          Esta lista é do agente, e não do BetterLoot — ela não vai para o disco do servidor. Ela
          serve ao botão <strong>Remover lixo</strong> do editor de caixa, que tira estes itens da
          caixa aberta. Nada acontece com o loot enquanto você não gravar a caixa.
        </p>

        <div className="space-y-1">
          <Label htmlFor="junk-item">Acrescentar item</Label>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <ItemCombobox
                inputId="junk-item"
                value={shortname}
                onValueChange={setShortname}
                serverId={serverId}
                disabled={busy}
                placeholder="nome do item (rug, table, mailbox…)"
              />
            </div>
            <Button
              size="sm"
              disabled={trimmed === '' || busy}
              onClick={submit}
              className="flex items-center gap-1"
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              Acrescentar
            </Button>
          </div>
        </div>

        <section className="space-y-1">
          <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">
            Marcados como lixo ({active.length})
          </h3>

          {active.length === 0 ? (
            <p className="text-2xs text-muted">
              Nenhum. Com a lista vazia, o botão de remover lixo não tem o que tirar.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
              {active.map((item) => (
                <li
                  key={item.shortname}
                  className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-2 py-1"
                >
                  <span className="min-w-0 truncate font-mono text-2xs">{item.shortname}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {!item.isDefault && (
                      <span className="text-2xs uppercase tracking-wide text-muted">seu</span>
                    )}
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => onRemove(item.shortname)}
                      // O padrão fica desligado e volta a aparecer
                      // abaixo; o acrescentado some. São ações
                      // diferentes, e o título diz qual é qual.
                      title={
                        item.isDefault
                          ? 'Desligar este item da lista (ele continua disponível para religar)'
                          : 'Tirar este item da lista'
                      }
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {off.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">
              Padrões desligados ({off.length})
            </h3>
            <p className="text-2xs text-muted">
              Vieram de fábrica e você os tirou. Eles continuam aqui para poder voltar.
            </p>
            <ul className="flex flex-wrap gap-1">
              {off.map((item) => (
                <li key={item.shortname}>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onAdd(item.shortname)}
                    className="flex items-center gap-1 opacity-70"
                    title="Voltar a considerar este item como lixo"
                  >
                    <RotateCcw aria-hidden="true" className="h-3 w-3" />
                    <span className="font-mono text-2xs">{item.shortname}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex justify-end">
          <Button variant="confirm" size="sm" onClick={onClose}>
            Pronto
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
