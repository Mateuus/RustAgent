'use client';

// ============================================================
//  give-item-dialog.tsx  -  pôr um item na mão de um jogador.
//
//  ####  ELE ENTREGA PELO MESMO CAMINHO DA LOJA  ####
//
//  `origemz.give`, e não o `inventory.give` nativo. O nativo cria
//  UMA pilha com o total pedido — MEDIDO: 3500 de madeira viram um
//  slot com 3500, cinco AKs viram uma pilha de cinco. O plugin
//  fatia em pilhas de verdade, e é o que o kit e a loja já
//  entregam. Duas entregas diferentes para a mesma coisa só
//  apareceriam no inventário do jogador.
//
//  ------------------------------------------------------------
//  ####  AS DUAS RECUSAS QUE A TELA SABE PREVER  ####
//
//  1. PILHAS DEMAIS. O plugin fatia a quantidade em pilhas e
//     recusa acima de 100 pedaços — o limite real por chamada é
//     `min(100000, 100 × pilha máxima)`. Como o catálogo diz a
//     pilha máxima do item escolhido, a conta é feita aqui e o
//     botão trava ANTES de gastar um comando de RCON. Sem isso, o
//     admin descobre o teto pelo código `TOO_MANY_STACKS`.
//
//  2. JOGADOR MORTO OU DORMINDO. Aí a tela AVISA e deixa enviar:
//     a lista é relida a cada cinco segundos, e ele pode ter
//     renascido no meio do preenchimento. Travar por um estado que
//     envelhece seria impedir uma entrega que funcionaria.
//
//  ####  O QUE NÃO COUBE FOI PARA O CHÃO  ####
//
//  E isso precisa ser dito na hora, não descoberto depois: item no
//  chão de uma base cheia de gente é item de quem chegar primeiro.
//  É por isso que o modo fica visível, com `auto` no padrão — o
//  mesmo da loja — e `inventory` ali do lado para quem prefere não
//  entregar a arriscar.
// ============================================================

import { useState } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { ItemCombobox } from '@/components/item-combobox';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  agent,
  MAX_GIVE_AMOUNT,
  MAX_GIVE_STACK_PIECES,
  type CatalogItem,
  type GamePlayer,
  type GiveMode,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Os três modos, com o que cada um faz quando o inventário está
 * cheio — que é a única hora em que eles diferem.
 */
const MODES: readonly { value: GiveMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Automático',
    hint: 'O que não couber cai no chão. É o modo da loja.',
  },
  {
    value: 'inventory',
    label: 'Só inventário',
    hint: 'Não coube, não entrega — nada vai para o chão.',
  },
  { value: 'drop', label: 'No chão', hint: 'Larga tudo aos pés dele, sem tentar o inventário.' },
];

export function GiveItemDialog({
  open,
  serverId,
  player,
  onClose,
  onDone,
}: {
  readonly open: boolean;
  readonly serverId: string;
  /** Quem recebe. O nome é repetido na caixa: ver `ConfirmDialog`. */
  readonly player: GamePlayer;
  readonly onClose: () => void;
  /** Recarrega a lista de quem chamou. */
  readonly onDone: () => void;
}) {
  const [shortname, setShortname] = useState('');
  // O item do catálogo, quando ele veio da lista. `null` = o
  // shortname foi digitado à mão, e aí a pilha máxima é
  // desconhecida — a tela não adivinha, e deixa o plugin decidir.
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [amount, setAmount] = useState(1);
  const [skinId, setSkinId] = useState('');
  const [mode, setMode] = useState<GiveMode>('auto');
  const [busy, setBusy] = useState(false);

  // Ver o cabeçalho, recusa 1. `null` = sem catálogo para o item
  // escolhido, então não há conta a fazer.
  const pieces = item === null ? null : Math.ceil(amount / Math.max(1, item.maxStack));
  const stacksExceeded = pieces !== null && pieces > MAX_GIVE_STACK_PIECES;
  const perCallLimit = item === null ? null : MAX_GIVE_STACK_PIECES * Math.max(1, item.maxStack);

  const canSend =
    !busy && shortname.trim() !== '' && amount >= 1 && amount <= MAX_GIVE_AMOUNT && !stacksExceeded;

  async function submit(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.givePlayerItem(serverId, player.steamId, {
        shortname: shortname.trim(),
        amount,
        // O campo em branco é o caso comum, e o plugin trata
        // ausente e "0" do mesmo jeito.
        skinId: skinId.trim() === '' ? '0' : skinId.trim(),
        mode,
      });

      toast.success(`${player.name} recebeu ${String(amount)}x ${shortname.trim()}`, {
        description: response.message,
      });
      onDone();
      onClose();
    } catch (cause) {
      toast.error('Não consegui entregar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Dar item" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Para <strong className="text-foreground">{player.name}</strong>{' '}
          <span className="font-mono text-2xs">{player.steamId}</span>
        </p>

        {/* Ver o cabeçalho, recusa 2: avisa e deixa enviar. */}
        {player.isAlive === false && (
          <StateBlock
            variant="empty"
            title="Ele está morto."
            detail={
              'O jogo cria o item no inventário de um jogador vivo — morto, a entrega volta ' +
              'recusada e nada é perdido. Ele precisa renascer.'
            }
          />
        )}

        <div>
          <Label htmlFor="give-item">Item</Label>
          <ItemCombobox
            inputId="give-item"
            value={shortname}
            disabled={busy}
            onValueChange={setShortname}
            onItemChange={setItem}
          />
          {item !== null && (
            <p className="mt-2 flex items-center gap-2 text-2xs text-muted">
              <ItemIcon shortname={item.shortname} size="sm" />
              <span>
                <strong className="text-foreground">{item.displayName}</strong> · empilha em{' '}
                {String(item.maxStack)}
                {perCallLimit === null
                  ? ''
                  : ` · até ${String(Math.min(perCallLimit, MAX_GIVE_AMOUNT))} por entrega`}
              </span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="give-amount">Quantidade</Label>
            <Input
              id="give-amount"
              type="number"
              min={1}
              max={MAX_GIVE_AMOUNT}
              value={amount}
              disabled={busy}
              onChange={(event) => setAmount(Math.max(1, Math.trunc(Number(event.target.value))))}
            />
          </div>

          <div>
            <Label htmlFor="give-skin">Skin</Label>
            {/* type="text", e não "number": a skin passa de 2^53 e
                um campo numérico a devolveria arredondada. */}
            <Input
              id="give-skin"
              type="text"
              inputMode="numeric"
              value={skinId}
              placeholder="0"
              disabled={busy}
              onChange={(event) => setSkinId(event.target.value.replace(/\D/g, ''))}
              className="font-mono"
            />
          </div>
        </div>

        {stacksExceeded && pieces !== null && perCallLimit !== null && (
          <p className="border border-amber bg-surface-2 px-3 py-2 text-2xs leading-relaxed">
            {String(amount)} desse item daria <strong>{String(pieces)} pilhas</strong>, e o plugin
            recusa acima de {String(MAX_GIVE_STACK_PIECES)} — sem entregar nada. O máximo por
            entrega aqui é <strong>{String(Math.min(perCallLimit, MAX_GIVE_AMOUNT))}</strong>; para
            mais que isso, entregue duas vezes.
          </p>
        )}

        <fieldset>
          <legend className="mb-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Se o inventário estiver cheio
          </legend>

          <div className="flex flex-wrap gap-2">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                title={option.hint}
                disabled={busy}
                onClick={() => setMode(option.value)}
                className={cn(
                  'border px-3 py-1.5 text-left text-2xs transition',
                  mode === option.value
                    ? 'border-amber bg-surface-2 text-foreground'
                    : 'border-border text-muted hover:border-muted hover:text-foreground',
                  busy && 'cursor-not-allowed opacity-50',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <p className="mt-1 text-2xs text-muted">
            {MODES.find((option) => option.value === mode)?.hint}
          </p>
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>

          <Button variant="primary" disabled={!canSend} onClick={() => void submit()}>
            Entregar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
