'use client';

// ============================================================
//  crate-fields.tsx  -  as caixas de uma cor de sala (ou do
//  corredor), e o que cada uma carrega.
//
//  ####  ERA UMA LISTA DE CAMINHOS DIGITADOS  ####
//
//  O admin escrevia
//  `assets/bundled/prefabs/radtown/crate_normal.prefab` num campo
//  de texto, e o loot de TODAS elas vinha de uma tabela só, a da
//  cor. Duas consequências, as duas apontadas pelo dono em
//  13/09/2026:
//
//    · errar uma letra não avisa ninguém — o prefab é pulado com um
//      aviso no console do servidor, e a sala nasce vazia;
//    · "a caixa de elite desta sala tem a AK, e as comuns têm
//      sucata" não era escrevível.
//
//  Agora a caixa se escolhe por NOME (`PrefabCombobox`) e cada uma
//  pode ter o conteúdo dela.
//
//  ####  TRÊS CAMADAS, E É ISSO QUE A TELA MOSTRA  ####
//
//      a tabela do SERVIDOR      o BetterLoot continua valendo
//         ↑ (mode: server)
//      a tabela da COR           "toda caixa desta sala tem…"
//         ↑ (table: null)
//      a tabela da CAIXA         "mas a de elite tem…"
//
//  O padrão é herdar: caixa nova nasce sem tabela própria, e o que
//  já existia continua se comportando igual.
//
//  ####  O OZCOIN NÃO É UM ITEM DENTRO DA CAIXA  ####
//
//  Ele é SALDO, e mora na carteira. A caixa sorteia o valor ao
//  nascer; quando alguém a abre, o plugin avisa o agente, que
//  credita e manda o recibo no chat. É o mesmo caminho da
//  recompensa de missão — e é por isso que o campo fica aqui, e não
//  na tabela de itens: um item chamado "OZCoin" seria um papel na
//  mão do jogador, sem saldo nenhum atrás.
// ============================================================

import { Coins, Package, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import type { CoinsDrop, CrateSpec, LootTable } from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { cn } from '@/lib/utils';

import { DUNGEON_CRATE_GROUPS, DUNGEON_CRATES, dungeonPrefabLabel } from './crate-catalog';
import { LootTableFields } from './loot-table-fields';
import { PrefabCombobox } from './prefab-combobox';

/** O teto do schema (`crateListSchema`). Passar disso a rota recusa. */
const MAX_CRATES = 20;

/**
 * A tabela que uma caixa ganha ao ligar "loot próprio".
 *
 * `add` e não `server`: quem liga o botão quer pôr algo ali, e
 * `server` seria uma tabela que não faz nada — o estado que o
 * `lootTableSchema` recusa por ser quase sempre um campo pela
 * metade.
 */
const OWN_TABLE: LootTable = { mode: 'add', rolls: { min: 1, max: 1 }, entries: [] };

/** O prêmio que uma caixa ganha ao ligar OZCoin. Ver `coinsDropSchema`. */
const OWN_COINS: CoinsDrop = { amount: { min: 50, max: 200 }, chance: 100 };

export interface CrateFieldsProps {
  readonly crates: readonly CrateSpec[];
  readonly onChange: (crates: CrateSpec[]) => void;
  /** "desta cor", "do corredor" — entra nas frases. */
  readonly scope: string;
  readonly className?: string;
}

export function CrateFields({ crates, onChange, scope, className }: CrateFieldsProps) {
  /** Qual caixa está aberta para edição. `null` = nenhuma. */
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  function update(index: number, change: Partial<CrateSpec>): void {
    onChange(crates.map((crate, at) => (at === index ? { ...crate, ...change } : crate)));
  }

  function add(): void {
    if (draft === '' || crates.length >= MAX_CRATES) return;

    // O prefab repetido é recusado pelo schema, com a frase dele. A
    // tela não deixa chegar lá: ela diz o motivo no lugar em que o
    // clique aconteceu.
    if (crates.some((crate) => crate.prefab === draft)) {
      setDraft('');
      return;
    }

    onChange([...crates, { prefab: draft, table: null, coins: null }]);
    setDraft('');
  }

  const duplicate = draft !== '' && crates.some((crate) => crate.prefab === draft);

  return (
    <div className={className}>
      <FieldLabel topic={DUNGEON_HELP.caixas}>Caixas {scope}</FieldLabel>

      {crates.length === 0 ? (
        <p className="mt-1 border-l-2 border-border pl-2 text-2xs leading-relaxed text-muted">
          Nenhuma escolhida: o construtor usa a caixa comum. Escolha abaixo para trocar, ou para
          sortear entre várias.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {crates.map((crate, index) => {
            const isOpen = open === index;
            const label = dungeonPrefabLabel(crate.prefab);

            return (
              <li key={crate.prefab} className="border border-border bg-surface-2">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Package aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted" />

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-foreground">{label}</span>
                    <span className="block truncate font-mono text-2xs text-muted">
                      {crate.prefab}
                    </span>
                  </span>

                  {/* Os dois selos dizem, sem abrir, o que aquela
                      linha tem de diferente. Sem eles, "esta caixa
                      paga OZCoin" só se descobre clicando em cada
                      uma. */}
                  {crate.table !== null && (
                    <span className="shrink-0 border border-border px-1 py-0.5 text-2xs text-muted">
                      loot próprio
                    </span>
                  )}

                  {crate.coins !== null && (
                    <span className="flex shrink-0 items-center gap-1 border border-amber/50 px-1 py-0.5 text-2xs text-amber">
                      <Coins aria-hidden="true" className="h-3 w-3" />
                      {crate.coins.amount.min === crate.coins.amount.max
                        ? crate.coins.amount.min.toLocaleString('pt-BR')
                        : `${crate.coins.amount.min.toLocaleString('pt-BR')}–${crate.coins.amount.max.toLocaleString('pt-BR')}`}
                      {crate.coins.chance < 100 && ` · ${String(crate.coins.chance)}%`}
                    </span>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : index)}
                  >
                    {isOpen ? 'Fechar' : 'Conteúdo'}
                  </Button>

                  <button
                    type="button"
                    onClick={() => {
                      onChange(crates.filter((_unused, at) => at !== index));
                      setOpen(null);
                    }}
                    aria-label={`Remover ${label}`}
                    className="shrink-0 text-muted hover:text-foreground"
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                </div>

                {isOpen && (
                  <div className="border-t border-border px-2 py-2">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <FieldLabel topic={DUNGEON_HELP.caixaLootProprio}>
                          Loot só desta caixa
                        </FieldLabel>
                        <div className="mt-1.5">
                          <Toggle
                            on={crate.table !== null}
                            busy={false}
                            onChange={(on) => update(index, { table: on ? { ...OWN_TABLE } : null })}
                            labels={['Próprio', `A ${scope}`]}
                            label={`Loot próprio da ${label}`}
                          />
                        </div>
                      </div>

                      <div>
                        <FieldLabel topic={DUNGEON_HELP.caixaOzcoin}>OZCoin nesta caixa</FieldLabel>
                        <div className="mt-1.5">
                          <Toggle
                            on={crate.coins !== null}
                            busy={false}
                            onChange={(on) => update(index, { coins: on ? { ...OWN_COINS } : null })}
                            labels={['Paga', 'Não paga']}
                            label={`OZCoin da ${label}`}
                          />
                        </div>
                      </div>
                    </div>

                    {crate.coins !== null && (
                      <CoinsRow
                        value={crate.coins}
                        onChange={(coins) => update(index, { coins })}
                        className="mt-3"
                      />
                    )}

                    {crate.table !== null && (
                      <div className="mt-3">
                        <LootTableFields
                          title={`O que cai só nesta ${label.toLowerCase()}`}
                          value={crate.table}
                          onChange={(table) => update(index, { table })}
                        />
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <PrefabCombobox
            value={draft}
            onChange={setDraft}
            entries={DUNGEON_CRATES}
            groups={DUNGEON_CRATE_GROUPS}
            ariaLabel={`Caixa ${scope}`}
          />
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={add}
          disabled={draft === '' || duplicate || crates.length >= MAX_CRATES}
        >
          <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Caixa
        </Button>
      </div>

      {duplicate && (
        <p className="mt-1 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-foreground">
          Esta caixa já está na lista. Quantas nascem é a faixa de caixas da sala — a lista é de
          TIPOS, e repetir um não dobraria nada.
        </p>
      )}

      {crates.length >= MAX_CRATES && (
        <p className="mt-1 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-foreground">
          Vinte tipos é o teto: o estado inteiro das masmorras viaja num comando de console de
          50 KB.
        </p>
      )}
    </div>
  );
}

/** Quanto OZCoin, e com que chance. */
function CoinsRow({
  value,
  onChange,
  className,
}: {
  readonly value: CoinsDrop;
  readonly onChange: (value: CoinsDrop) => void;
  readonly className?: string;
}) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-3', className)}>
      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Mínimo</span>
        <Input
          type="number"
          min={0}
          max={1_000_000}
          className="mt-1"
          value={value.amount.min}
          onChange={(event) =>
            onChange({
              ...value,
              amount: { ...value.amount, min: clamp(event.target.value, 0, 1_000_000) },
            })
          }
        />
      </label>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Máximo</span>
        <Input
          type="number"
          min={0}
          max={1_000_000}
          className="mt-1"
          value={value.amount.max}
          onChange={(event) =>
            onChange({
              ...value,
              amount: { ...value.amount, max: clamp(event.target.value, 0, 1_000_000) },
            })
          }
        />
      </label>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Chance (%)
        </span>
        <Input
          type="number"
          min={1}
          max={100}
          className="mt-1"
          value={value.chance}
          onChange={(event) => onChange({ ...value, chance: clamp(event.target.value, 1, 100) })}
        />
      </label>

      <p className="border-l-2 border-border pl-2 text-2xs leading-relaxed text-muted sm:col-span-3">
        {value.chance === 100 ? (
          <>
            Toda caixa deste tipo paga. O sorteio do valor é por caixa, no nascimento dela — quem
            abre primeiro leva, como o loot.
          </>
        ) : (
          <>
            {String(value.chance)} de cada 100 caixas deste tipo pagam. O sorteio é no nascimento da
            caixa, e o respawn sorteia de novo.
          </>
        )}{' '}
        O saldo entra na carteira do jogador e ele recebe o recibo no chat.
      </p>
    </div>
  );
}

function clamp(raw: string, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed)) return min;

  return Math.min(max, Math.max(min, parsed));
}
