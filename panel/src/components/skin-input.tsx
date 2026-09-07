'use client';

// ============================================================
//  skin-input.tsx  -  o campo Skin, e a trava que ele ganha.
//
//  ####  POR QUE ELE FICA SOMENTE-LEITURA  ####
//
//  Um item nosso É o par `(shortname, skinId)`. Os dois campos
//  formam a marca; sozinho, o shortname é um item do jogo comum.
//
//  Apagar a skin com o Troféu escolhido entrega um `discord.trophy`
//  cru — e o estrago é justamente o tipo que não aparece: o item
//  chega ao inventário, tem o nome errado, e nunca converte em
//  ponto. Ninguém é avisado, nem o admin nem o jogador.
//
//  Então, enquanto um item nosso estiver escolhido, o campo é
//  SOMENTE-LEITURA. A saída existe e é a natural: mudar o item lá
//  em cima desfaz a escolha, e o campo volta a aceitar digitação.
//  Trancar sem saída seria pior do que não trancar.
//
//  ####  `readOnly`, E NÃO `disabled`  ####
//
//  `disabled` tiraria o campo da ordem de tabulação, apagaria o
//  valor para o leitor de tela e o deixaria cinza — três formas de
//  esconder justamente o número que a pessoa precisa CONFERIR.
//  `readOnly` mantém tudo legível, focável e copiável, e só recusa
//  a digitação.
// ============================================================

import { Lock } from 'lucide-react';

import { Input } from '@/components/ui/input';
import type { CustomItem } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SkinInputProps {
  readonly value: string;
  readonly onChange: (skinId: string) => void;
  /** O item nosso que fixou esta skin. `null` = campo livre. */
  readonly lockedBy: CustomItem | null;
  readonly disabled?: boolean;
  /** Quando há um `<Label htmlFor>` ao lado. */
  readonly id?: string;
  /** Quando NÃO há rótulo visível — a linha de itens de um kit. */
  readonly label?: string;
  readonly placeholder?: string;
  readonly className?: string;
  /**
   * Mostrar a linha que explica a trava.
   *
   * Sai em telas apertadas (a linha de itens de um kit, onde o
   * campo tem 7rem): lá o cadeado e o `title` dizem o mesmo, e uma
   * frase quebraria o alinhamento de todas as linhas.
   */
  readonly showHint?: boolean;
}

export function SkinInput({
  value,
  onChange,
  lockedBy,
  disabled = false,
  id,
  label,
  placeholder = '0',
  className,
  showHint = true,
}: SkinInputProps) {
  const locked = lockedBy !== null;

  const title = locked
    ? `Esta skin é a marca de "${lockedBy.displayName}". Sem ela, o jogo entrega um ` +
      `${lockedBy.baseShortname} comum. Para digitar outra, troque o item.`
    : undefined;

  return (
    <div className="relative">
      <Input
        {...(id === undefined ? {} : { id })}
        {...(label === undefined ? {} : { 'aria-label': label })}
        {...(title === undefined ? {} : { title })}
        // type="text", e não "number": a skin passa de 2^53 e um
        // campo numérico a devolveria arredondada.
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={locked}
        aria-readonly={locked}
        onChange={(event) => {
          onChange(event.target.value.replace(/\D/g, ''));
        }}
        className={cn('font-mono', locked && 'border-amber pr-7 text-amber', className)}
      />

      {locked && (
        <Lock
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-amber"
        />
      )}

      {locked && showHint && (
        <p className="mt-1 text-2xs leading-relaxed text-muted">
          É a marca de <strong className="text-foreground">{lockedBy.displayName}</strong>. Troque o
          item acima para liberar o campo.
        </p>
      )}
    </div>
  );
}
