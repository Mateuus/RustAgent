'use client';

// ============================================================
//  reward-item-field.tsx  -  o item que a missão dá, com cara de
//  item.
//
//  ####  O CAMPO MOSTRAVA A BUSCA, E NUNCA A ESCOLHA  ####
//
//  Pedido do dono em 14/09/2026, com o print do editor: escolhido o
//  item, o campo continuava sendo a caixa de busca com `bleik`
//  escrito dentro. Para conferir o que a missão ia dar, ele tinha
//  de confiar no texto que ele mesmo digitou — e um `discord.trophy`
//  sem a skin é uma taça qualquer, não o Troféu.
//
//  Agora, escolhido o item, o campo vira o ITEM: ícone, nome, e o
//  shortname embaixo. Trocar é um botão, e não o estado normal do
//  campo.
//
//  ####  O NOME DE UM ITEM NOSSO É O NOSSO  ####
//
//  Um item nosso é o par `(shortname, skinId)`. Pelo shortname
//  sozinho, esta tela mostraria "Trophy" para o Troféu Bleik Store
//  — o corpo emprestado, e não o item. Por isso o par é procurado
//  primeiro na lista dos nossos, e só depois no catálogo do jogo.
//
//  Ver `item-choice.ts`, que já resolve esse par para o combobox.
// ============================================================

import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { findOurItem, type ItemChoice } from '@/components/item-choice';
import { CustomItemIcon, ItemIcon } from '@/components/item-icon';
import { Button } from '@/components/ui/button';
import { agent } from '@/lib/api';
import { useCustomItems } from '@/lib/hooks/use-custom-items';

export interface RewardItemFieldProps {
  readonly shortname: string;
  /** A marca do item nosso. `'0'` num item do jogo. */
  readonly skinId: string;
  readonly onChange: (choice: { readonly shortname: string; readonly skinId: string }) => void;
}

export function RewardItemField({ shortname, skinId, onChange }: RewardItemFieldProps) {
  // Nasce em modo de busca quando não há nada escolhido, e vira o
  // cartão assim que houver. Trocar volta para a busca.
  const [searching, setSearching] = useState(shortname === '');
  const [gameName, setGameName] = useState<string | null>(null);

  const { items: customItems } = useCustomItems();
  const ours = findOurItem(customItems, shortname, skinId);

  // ####  O NOME DO ITEM DO JOGO VEM DO AGENTE  ####
  //
  // A tela carregou um cadastro, e não um clique: ninguém passou
  // por aqui escolhendo nada, então o nome não está em memória. É
  // exatamente o caso que a rota `GET /api/items/:shortname`
  // documenta atender.
  useEffect(() => {
    let alive = true;

    if (shortname === '' || ours !== null) {
      setGameName(null);

      return () => {
        alive = false;
      };
    }

    agent
      .item(shortname)
      .then((response) => {
        if (alive) {
          setGameName(response.item.displayName);
        }
      })
      // Shortname que não existe mais nesta versão do jogo, ou
      // catálogo nunca lido. O cartão mostra o shortname cru, que é
      // o que está gravado — e é essa a informação que importa.
      .catch(() => {
        if (alive) {
          setGameName(null);
        }
      });

    return () => {
      alive = false;
    };
  }, [shortname, ours]);

  if (searching || shortname === '') {
    return (
      <ItemCombobox
        value={shortname}
        onValueChange={(picked) => onChange({ shortname: picked, skinId })}
        onChoiceChange={(choice: ItemChoice | null) => {
          if (choice === null) {
            return;
          }

          // ####  A SKIN VIAJA JUNTO COM O ITEM  ####
          //
          // Entregar o shortname sem a marca dá o item comum, sem
          // nome e sem ação — e nada avisa.
          onChange({ shortname: choice.shortname, skinId: choice.skinId });
          setSearching(false);
        }}
      />
    );
  }

  return (
    <div className="flex items-center gap-3 border border-border bg-surface-2 p-2">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-border bg-surface">
        {ours === null ? (
          <ItemIcon shortname={shortname} className="h-10 w-10" />
        ) : (
          <CustomItemIcon
            iconFile={ours.iconFile}
            baseShortname={ours.baseShortname}
            className="h-10 w-10"
          />
        )}
      </div>

      <div className="min-w-0 flex-1 text-2xs leading-relaxed">
        <p className="truncate font-condensed font-bold uppercase tracking-wide text-foreground">
          {ours?.displayName ?? gameName ?? shortname}
        </p>

        <p className="truncate font-mono text-muted">
          {shortname}
          {/* A skin só aparece quando existe: num item do jogo ela é
              `0`, e mostrar "skin 0" seria ruído em todo cadastro. */}
          {ours === null ? '' : ` · skin ${ours.skinId}`}
        </p>
      </div>

      <Button
        size="sm"
        variant="outline"
        type="button"
        title="Escolher outro item"
        onClick={() => setSearching(true)}
      >
        <Pencil className="mr-1 h-3 w-3" />
        Trocar
      </Button>
    </div>
  );
}
