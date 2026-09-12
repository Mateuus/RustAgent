'use client';

// ============================================================
//  loot-table-fields.tsx  -  o que cai dentro da caixa.
//
//  ####  TRÊS MODOS, E O PADRÃO É NÃO MEXER  ####
//
//    servidor   o Rust enche a caixa e o BetterLoot vale. É o de
//               hoje, e o que 90% das masmorras querem
//    acrescenta o Rust enche, e a nossa tabela vem POR CIMA
//    substitui  limpamos e só a nossa tabela vale
//
//  Enquanto o modo é "servidor" a tela não mostra tabela nenhuma:
//  seriam sessenta linhas em branco pedindo para serem preenchidas,
//  numa tela em que quase ninguém precisa delas.
//
//  ####  PESO E "SEMPRE" SÃO AS DUAS MANEIRAS DE CAIR  ####
//
//  A mesa mais comum que existe precisa das duas: "toda caixa
//  vermelha tem 100 de scrap" (sempre) "e mais dois itens desta
//  lista" (sorteio por peso). Com só uma delas, essa frase não é
//  escrevível.
//
//  ####  O ITEM É ESCOLHIDO, E NÃO DIGITADO  ####
//
//  Esta tela pedia o shortname na unha, e com isso o item que a
//  casa mais quer pôr na masmorra era o único que ela não sabia
//  cadastrar: um item NOSSO é o par `(shortname, skin)` — a moeda
//  da Bleik Store é um `researchpaper` com a marca
//  `1704237532379132` —, e acertar dezesseis dígitos de cabeça não
//  é um pedido razoável. Errar um deles não avisa ninguém: a caixa
//  enche de papel de pesquisa comum.
//
//  Então o campo é o mesmo seletor das outras quatro telas
//  (`ItemCombobox`), que busca pelo NOME, mostra os itens nossos em
//  cima dos do jogo e devolve os dois campos JUNTOS. O campo Skin
//  fica travado enquanto a marca for de um item nosso, como no kit
//  e na loja.
//
//  O nome e o ícone o plugin põe sozinho: `OrigemZItems` roda no
//  `OnItemAddedToContainer` e reconhece o item pela marca quando
//  ele entra na caixa. Daqui sai só o par.
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { findOurItem, NO_SKIN, type ItemChoice } from '@/components/item-choice';
import { SkinInput } from '@/components/skin-input';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/help-tip';
import { Input } from '@/components/ui/input';
import {
  LOOT_MODES,
  type CustomItem,
  type LootEntry,
  type LootMode,
  type LootTable,
} from '@/lib/api';
import { DUNGEON_HELP } from '@/lib/help/dungeons';
import { useCustomItems } from '@/lib/hooks/use-custom-items';

const MODE_LABEL: Readonly<Record<LootMode, string>> = {
  server: 'A do servidor',
  add: 'Acrescenta',
  replace: 'Substitui',
};

const MODE_DETAIL: Readonly<Record<LootMode, string>> = {
  server: 'O Rust enche a caixa. O BetterLoot continua valendo.',
  add: 'O Rust enche, e os itens abaixo entram por cima.',
  replace: 'Só os itens abaixo. O papel do código nunca é apagado.',
};

/** O teto do schema. Passar disso a rota recusa. */
const MAX_ENTRIES = 60;

/**
 * O teto da skin — o mesmo do `lootEntrySchema`.
 *
 * ####  DEZ DÍGITOS NÃO BASTAM  ####
 *
 * O teto daqui era 4 bilhões, na conta de que skin é coisa do
 * Steam Workshop: dez dígitos, `2973264769`. Só que as skins que
 * este painel mais usa NÃO são do Workshop — são as nossas, e o
 * `custom-item-dialog` as sorteia acima de 10^15 justamente para
 * ficar numa faixa aonde o Steam não chega. Toda moeda e todo
 * troféu custom tem dezesseis dígitos, e o teto velho os
 * silenciava em 4000000000 na hora de digitar.
 *
 * O limite real é o do JavaScript, não o do jogo: a skin é um
 * UInt64 no Rust, mas ela viaja neste campo como `number`, e
 * acima de 2^53 o dígito se perde sem avisar. O schema do agente
 * para no mesmo lugar.
 */
const MAX_SKIN = Number.MAX_SAFE_INTEGER;

const EMPTY_ENTRY: LootEntry = {
  shortname: '',
  amount: { min: 1, max: 1 },
  weight: 10,
  guaranteed: false,
  skin: 0,
  blueprint: false,
  condition: 0,
};

export interface LootTableFieldsProps {
  readonly value: LootTable;
  readonly onChange: (value: LootTable) => void;
  /** Some no rótulo: "Caixas desta cor", "O corpo do inimigo"… */
  readonly title: string;
}

export function LootTableFields({ value, onChange, title }: LootTableFieldsProps) {
  const [draft, setDraft] = useState('');
  // A escolha inteira, e não só o shortname: é ela que carrega a
  // marca do item nosso até a linha nova.
  const [choice, setChoice] = useState<ItemChoice | null>(null);

  // A masmorra não é de UM servidor — ela é marcada para vários na
  // aba de cima —, então o seletor não filtra por servidor, e a
  // dica embaixo do campo diz isso. É o mesmo caso da loja.
  const { items: customItems } = useCustomItems();

  function update(change: Partial<LootTable>) {
    onChange({ ...value, ...change });
  }

  function updateEntry(index: number, change: Partial<LootEntry>) {
    update({
      entries: value.entries.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
    });
  }

  function add() {
    const shortname = draft.trim();

    if (shortname === '' || value.entries.length >= MAX_ENTRIES) {
      setDraft('');
      setChoice(null);
      return;
    }

    // A marca entra JUNTO com o nome. Acrescentar o item nosso e
    // deixar a skin para um segundo passo é como se esquece dela.
    update({
      entries: [
        ...value.entries,
        { ...EMPTY_ENTRY, shortname, skin: choiceSkin(choice, shortname) },
      ],
    });
    setDraft('');
    setChoice(null);
  }

  return (
    <div>
      <FieldLabel topic={DUNGEON_HELP.tabelaDeLoot}>{title}</FieldLabel>

      <div className="mt-1 grid gap-2 sm:grid-cols-3">
        {LOOT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={value.mode === mode}
            onClick={() => update({ mode })}
            className={
              value.mode === mode
                ? 'border border-rust bg-rust/10 p-2 text-left'
                : 'border border-border bg-surface-2 p-2 text-left hover:border-muted'
            }
          >
            <span className="block font-condensed text-2xs font-bold uppercase tracking-wide">
              {MODE_LABEL[mode]}
            </span>
            <span className="mt-0.5 block text-2xs text-muted">{MODE_DETAIL[mode]}</span>
          </button>
        ))}
      </div>

      {value.mode !== 'server' && (
        <div className="mt-3 border border-border bg-surface-2 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <FieldLabel topic={DUNGEON_HELP.sorteios}>Sorteios por caixa</FieldLabel>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={30}
                  className="w-16"
                  value={value.rolls.min}
                  onChange={(event) => {
                    const min = clampInt(event.target.value, 0, 30);

                    update({ rolls: { min, max: Math.max(min, value.rolls.max) } });
                  }}
                />
                <span className="text-2xs text-muted">a</span>
                <Input
                  type="number"
                  min={0}
                  max={30}
                  className="w-16"
                  value={value.rolls.max}
                  onChange={(event) => {
                    const max = clampInt(event.target.value, 0, 30);

                    update({ rolls: { min: Math.min(max, value.rolls.min), max } });
                  }}
                />
              </div>
            </div>

            <p className="min-w-0 flex-1 text-2xs text-muted">
              Os itens marcados <strong className="text-foreground">Sempre</strong> caem além destes
              sorteios, e não gastam nenhum deles.
            </p>
          </div>

          {value.entries.length === 0 && (
            <p className="mt-3 border-l-2 border-amber pl-2 text-2xs text-foreground">
              Uma tabela sem itens não muda nada — e o painel recusa salvar assim. Acrescente pelo
              menos um, ou volte para &ldquo;a do servidor&rdquo;.
            </p>
          )}

          {value.entries.length > 0 && (
            <div className="mt-3 space-y-2">
              {value.entries.map((entry, index) => (
                <EntryRow
                  // A chave é a POSIÇÃO, e não o shortname: com o
                  // nome na chave, cada tecla digitada no seletor
                  // trocaria a chave, o React remontaria a linha e o
                  // foco sairia do campo na primeira letra.
                  key={index}
                  entry={entry}
                  customItems={customItems}
                  onChange={(change) => updateEntry(index, change)}
                  onRemove={() =>
                    update({ entries: value.entries.filter((_unused, at) => at !== index) })
                  }
                />
              ))}
            </div>
          )}

          <div className="mt-3 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <ItemCombobox
                value={draft}
                onValueChange={setDraft}
                onChoiceChange={setChoice}
                placeholder="nome do item (moeda, troféu, assault) ou shortname"
              />
            </div>
            <Button size="sm" variant="outline" onClick={add}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Item
            </Button>
          </div>

          {choice !== null && choice.skinId !== NO_SKIN && (
            <p className="mt-2 border border-amber/40 bg-amber/10 px-2 py-1.5 text-2xs leading-relaxed text-foreground">
              Item nosso: entra na caixa com a marca{' '}
              <span className="font-mono">{choice.skinId}</span>, e é ela que faz o plugin da casa
              pôr o nome <strong>{choice.displayName}</strong> no item.
            </p>
          )}

          <p className="mt-1 text-2xs text-muted">
            Busque pelo nome, ou escreva o nome curto (<code>rifle.ak</code>, <code>sulfur</code>).
            Os itens que <strong className="text-foreground">nós criamos</strong> aparecem em cima e
            já trazem a marca junto. Um nome que o jogo não conhece é pulado com aviso no console —
            a tabela inteira não cai por causa dele.
          </p>
        </div>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  customItems,
  onChange,
  onRemove,
}: {
  readonly entry: LootEntry;
  readonly customItems: readonly CustomItem[];
  readonly onChange: (change: Partial<LootEntry>) => void;
  readonly onRemove: () => void;
}) {
  // Reconhecido a cada render, e não lembrado da escolha: uma
  // masmorra reaberta não viu ninguém escolher nada — ela tem só o
  // par que está no banco. Ver `findOurItem`.
  const ours = findOurItem(customItems, entry.shortname, String(entry.skin));

  return (
    <div className="border border-border bg-background p-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Item</span>
          <div className="mt-0.5">
            <ItemCombobox
              value={entry.shortname}
              onValueChange={(shortname) => onChange({ shortname })}
              onChoiceChange={(choice) => {
                // Só uma ESCOLHA mexe na skin. Digitação solta não:
                // quem está corrigindo uma letra do shortname não
                // pediu para apagar a marca que já estava na linha.
                if (choice !== null) {
                  onChange({ shortname: choice.shortname, skin: skinOf(choice.skinId) });
                }
              }}
            />
          </div>
        </div>

        <div>
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
            Quantidade
          </span>
          <div className="mt-0.5 flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={10_000}
              className="w-16"
              value={entry.amount.min}
              onChange={(event) => {
                const min = clampInt(event.target.value, 0, 10_000);

                onChange({ amount: { min, max: Math.max(min, entry.amount.max) } });
              }}
            />
            <span className="text-2xs text-muted">a</span>
            <Input
              type="number"
              min={0}
              max={10_000}
              className="w-16"
              value={entry.amount.max}
              onChange={(event) => {
                const max = clampInt(event.target.value, 0, 10_000);

                onChange({ amount: { min: Math.min(max, entry.amount.min), max } });
              }}
            />
          </div>
        </div>

        <div>
          <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Peso</span>
          <Input
            type="number"
            min={1}
            max={1000}
            className="mt-0.5 w-16"
            value={entry.weight}
            onChange={(event) => onChange({ weight: clampInt(event.target.value, 1, 1000) })}
          />
        </div>

        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover ${entry.shortname}`}
          className="flex h-9 w-9 shrink-0 items-center justify-center border border-border text-muted hover:border-muted hover:text-foreground"
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-2xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={entry.guaranteed}
            onChange={(event) => onChange({ guaranteed: event.target.checked })}
            className="accent-[var(--rust-red)]"
          />
          Sempre (não gasta sorteio)
        </label>

        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={entry.blueprint}
            onChange={(event) => onChange({ blueprint: event.target.checked })}
            className="accent-[var(--rust-red)]"
          />
          Cai como projeto
        </label>

        <span className="flex items-center gap-1.5">
          Skin
          <SkinInput
            value={String(entry.skin)}
            label="Skin"
            showHint={false}
            lockedBy={ours}
            className="h-7 w-40 text-2xs"
            onChange={(raw) => onChange({ skin: skinOf(raw) })}
          />
        </span>

        <label className="flex items-center gap-1.5">
          Durabilidade
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            className="h-7 w-20"
            value={entry.condition}
            onChange={(event) => {
              const parsed = Number(event.target.value);

              onChange({ condition: Number.isNaN(parsed) ? 0 : clamp(parsed, 0, 1) });
            }}
          />
          <span className="text-muted">(0 = a do jogo)</span>
        </label>
      </div>

      {ours !== null && (
        <p className="mt-1.5 text-2xs text-muted">
          Esta linha é <strong className="text-foreground">{ours.displayName}</strong>: o item nasce
          como <code>{ours.baseShortname}</code> e é a marca que faz o plugin da casa reconhecê-lo.
        </p>
      )}
    </div>
  );
}

/**
 * O texto do campo Skin virando o número que a tabela guarda.
 *
 * Sem dígito nenhum é 0, que é "item do jogo, sem marca" — o
 * mesmo que o schema entende. O teto é o do `MAX_SKIN`, e ele
 * aparece no campo quando morde: um número que sumisse calado é
 * como o defeito do 4000000000 começou.
 */
function skinOf(raw: string): number {
  const digits = raw.replace(/\D/g, '');

  if (digits === '') return 0;

  return clamp(Number(digits), 0, MAX_SKIN);
}

/**
 * A marca que a linha nova recebe.
 *
 * A escolha só vale enquanto o campo ainda mostra o shortname
 * dela: quem escolheu o Troféu e depois apagou o texto para
 * escrever `sulfur` à mão está acrescentando enxofre, e não um
 * enxofre com a marca do troféu.
 */
function choiceSkin(choice: ItemChoice | null, shortname: string): number {
  if (choice === null || choice.shortname !== shortname) return 0;

  return skinOf(choice.skinId);
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);

  if (Number.isNaN(value)) return min;

  return clamp(value, min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
