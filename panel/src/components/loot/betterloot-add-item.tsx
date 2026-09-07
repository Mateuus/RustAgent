'use client';

// ============================================================
//  betterloot-add-item.tsx  -  a coluna da direita: pôr item na caixa.
//
//  ####  É AQUI QUE O TROFÉU BLEIK ENTRA NO LOOT  ####
//
//  O `LootTables.json` do server01 tem 6.824 entradas, e TODAS com
//  `skin = 0` e `Display Name` vazio — medido. O suporte existe no
//  plugin (BetterLoot.cs:1223-1227, aplicado em cinco caminhos de
//  criação); quem nunca preencheu foi o gerador automático, que só
//  copia o loot nativo.
//
//  Preencher é o trabalho desta coluna, e ela não pede o número da
//  skin a ninguém: o seletor devolve o par `(shortname, skinId)`
//  junto, que é o que faz o item nascer COM A MARCA. Digitar
//  `1552602728526292` à mão é o caminho em que se erra um dígito e
//  não se descobre nunca.
//
//  ####  É O QUE NOS TORNA MELHORES QUE O LOOTY  ####
//
//  O Looty e o AlphaLoot Profile Editor leem os bundles do CLIENTE
//  do Rust para montar a lista de itens. O nosso catálogo vem do
//  servidor de verdade (`origemz.items`, 1.259 itens) e traz junto
//  os itens que NÓS criamos — que nenhum editor de fora tem como
//  conhecer.
//
//  ####  O SUFIXO {n} É NOSSO PROBLEMA, E NÃO DO ADMIN  ####
//
//  `Ungrouped Items` é um dicionário chaveado por shortname: pôr
//  dois troféus de skins diferentes sobrescreveria o primeiro. O
//  `nextEntryKey` resolve isso sozinho, e a tela nunca mostra o
//  sufixo — para quem edita, são duas linhas com dois ícones.
// ============================================================

import { Plus } from 'lucide-react';
import { useState } from 'react';

import { nextEntryKey } from '@/components/loot/betterloot';
import { flatShareOf, formatChance } from '@/components/loot/betterloot-chance';
import { ItemCombobox } from '@/components/item-combobox';
import { NO_SKIN, type ItemChoice } from '@/components/item-choice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BetterLootEntry, BetterLootTable } from '@/lib/api';

interface BetterLootAddItemProps {
  readonly table: BetterLootTable;
  readonly onAdd: (entry: BetterLootEntry) => void;
  readonly serverId: string;
  readonly busy: boolean;
}

export function BetterLootAddItem({ table, onAdd, serverId, busy }: BetterLootAddItemProps) {
  const [shortname, setShortname] = useState('');
  const [choice, setChoice] = useState<ItemChoice | null>(null);
  const [min, setMin] = useState('1');
  const [max, setMax] = useState('1');

  const trimmed = shortname.trim();
  const canAdd = trimmed !== '' && !busy;

  /**
   * Quanto a entrada nova valeria, se entrasse agora.
   *
   * ####  A CONTA SÓ FECHA COM A RARIDADE, E ELA NÃO ESTÁ AQUI  ####
   *
   * O peso de um item solto vem de `ItemDefinition.rarity`, que o
   * catálogo do agente não carrega hoje. Antes de salvar, portanto,
   * a única projeção honesta é a do modo parelho — e a tela diz
   * que é uma projeção de piso, em vez de fingir precisão.
   *
   * O `+ 1` é o item que ainda não entrou: numa caixa vazia a conta
   * é `1/1`, e a resposta é 100 % — não travessão.
   */
  const flatShare = flatShareOf(table.items.length + 1);

  const submit = (): void => {
    if (!canAdd) {
      return;
    }

    const parsedMin = Math.max(1, Number.parseInt(min, 10) || 1);
    const parsedMax = Math.max(parsedMin, Number.parseInt(max, 10) || parsedMin);

    onAdd({
      key: nextEntryKey(trimmed, table.items.map((entry) => entry.key)),
      shortname: trimmed,
      displayName: choice?.displayName ?? null,
      skinId: choice?.skinId ?? NO_SKIN,
      // O nome do item nosso vai junto: sem ele o jogador vê o nome
      // do corpo emprestado ("Trophy") em vez do que a casa deu.
      customName:
        choice !== null && choice.skinId !== NO_SKIN ? choice.displayName : null,
      min: parsedMin,
      max: parsedMax,
      allowDuplicates: true,
      // Os três abaixo são do PLUGIN, e não nossos: o `scanEntry`
      // os preenche ao validar. Mandar palpite seria mandar o que
      // ele apaga na volta.
      canConvertToBlueprint: null,
      durability: null,
      rarity: null,
      bonusItems: [],
      hasWeaponProperties: false,
    });

    setShortname('');
    setChoice(null);
    setMin('1');
    setMax('1');
  };

  return (
    <section className="border border-border bg-surface p-3">
      {/* h2: o h1 é o da página ("Loot"), e esta é uma seção de topo
          da coluna. Pular para h4 deixaria o leitor de tela sem os
          degraus do meio ao navegar por cabeçalhos. */}
      <h2 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
        Pôr item nesta caixa
      </h2>

      <div className="mt-2 space-y-2">
        <div>
          <Label htmlFor="betterloot-add-item">Item</Label>
          <ItemCombobox
            inputId="betterloot-add-item"
            value={shortname}
            serverId={serverId}
            disabled={busy}
            onValueChange={setShortname}
            onChoiceChange={setChoice}
          />
        </div>

        <div className="flex items-end gap-2">
          <div className="w-20">
            <Label htmlFor="betterloot-add-min">Mínimo</Label>
            <Input
              id="betterloot-add-min"
              type="number"
              min={1}
              value={min}
              disabled={busy}
              onChange={(event) => setMin(event.target.value)}
              className="h-8 text-2xs"
            />
          </div>

          <div className="w-20">
            <Label htmlFor="betterloot-add-max">Máximo</Label>
            <Input
              id="betterloot-add-max"
              type="number"
              min={1}
              value={max}
              disabled={busy}
              onChange={(event) => setMax(event.target.value)}
              className="h-8 text-2xs"
            />
          </div>

          <Button
            variant="primary"
            size="sm"
            disabled={!canAdd}
            onClick={submit}
            className="ml-auto flex items-center gap-1"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Acrescentar
          </Button>
        </div>

        {choice !== null && choice.skinId !== NO_SKIN && (
          <p className="border border-amber/40 bg-amber/10 px-2 py-1.5 text-2xs leading-relaxed text-foreground">
            Item nosso: entra com a marca <span className="font-mono">{choice.skinId}</span> e com o
            nome <strong>{choice.displayName}</strong>. É a marca que faz o plugin da casa
            reconhecê-lo quando o jogador o pegar.
          </p>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          {table.ignoreRarityBias ? (
            <>
              Esta caixa sorteia parelho: com mais um item, cada um fica com{' '}
              <strong>{formatChance(flatShare)}</strong>.
            </>
          ) : (
            <>
              Esta caixa sorteia por raridade. A chance real do item novo só aparece depois de
              salvar — quem sabe a raridade dele é o servidor.
            </>
          )}
        </p>
      </div>
    </section>
  );
}
