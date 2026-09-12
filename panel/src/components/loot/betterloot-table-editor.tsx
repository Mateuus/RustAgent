'use client';

// ============================================================
//  betterloot-table-editor.tsx  -  a coluna do meio: a caixa aberta.
//
//  ####  A PORCENTAGEM AO VIVO É O PONTO DA TELA  ####
//
//  Uma entrada de `Ungrouped Items` não tem campo de chance: o peso
//  dela é a RARIDADE DO ITEM NO JOGO, e o denominador é a soma dos
//  pesos da caixa inteira (ver `betterloot-chance.ts`).
//
//  A consequência é a menos visível que existe aqui: ACRESCENTAR UM
//  ITEM DIMINUI A CHANCE DE TODOS OS OUTROS. Sem a coluna de
//  porcentagem recalculando na hora, o admin acrescenta cinco itens
//  numa caixa e desregula as outras 145 entradas sem nada avisar —
//  e só descobre semanas depois, como "o servidor está estranho".
//
//  ####  A TELA NÃO EDITA O QUE O PLUGIN REESCREVE  ####
//
//  `Item Durability`, `Item Properties` e `Can Convert To Blueprint`
//  são preenchidos pelo `scanEntry` do plugin ao validar o arquivo
//  (BetterLoot.cs:2076-2145). A tela MOSTRA os três e não os edita:
//  oferecer um campo que o servidor sobrescreve na volta é prometer
//  o que não se cumpre.
//
//  ####  O MULTIPLICADOR DAQUI NÃO É O DA FAIXA DE CIMA  ####
//
//  `Loot Multiplier` e `Scrap Multipler` são do SERVIDOR INTEIRO e
//  são inteiros: um campo de "2x nesta caixa" que gravasse neles
//  mentiria sobre o alcance. Eles moram na faixa de cima.
//
//  O que existe aqui é outra operação, com outro efeito e outro
//  risco: multiplicar o `Item Minimum`/`Item Maximum` de CADA
//  entrada desta caixa, de uma vez. É o `Apply Multiplier to All
//  Items` do Looty — edição em massa, local, e sem "voltar a 1x"
//  depois de gravada, porque o valor antigo não fica guardado em
//  lugar nenhum.
//
//  Por isso ela tem um passo a mais que todo o resto desta tela: o
//  que vai acontecer é escrito por extenso ANTES de o rascunho
//  mudar. Depois de aplicado, o "Descartar" ainda desfaz — até o
//  "Gravar".
// ============================================================

import { AlertTriangle, Ban, Trash2 } from 'lucide-react';

import { BetterLootGuaranteed } from '@/components/loot/betterloot-guaranteed';
import { useMemo, useState, type ReactNode } from 'react';

import {
  MAX_ITEMS_PER_CONTAINER,
  chancesOf,
  flatShareOf,
  formatChance,
  rarityLabel,
  ungroupedRollsOf,
} from '@/components/loot/betterloot-chance';
import {
  BULK_SHORTCUTS,
  MAX_BULK_FACTOR,
  MIN_BULK_FACTOR,
  formatFactor,
  formatRange,
  multiplyAmounts,
  type BulkMultiplyOutcome,
} from '@/components/loot/betterloot-bulk';
import { BetterLootMultiplierMenu } from '@/components/loot/betterloot-multiplier-menu';
import { labelOfPrefab } from '@/components/loot/betterloot';
import {
  compareWithNative,
  importNative,
  isAdopted,
  switchesDisagree,
  type EntryOrigin,
  type NativeComparison,
  type NativeImportMode,
  type NativeImportOutcome,
} from '@/components/loot/betterloot-native';
import { ItemIcon } from '@/components/item-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import type {
  BetterLootEntry,
  BetterLootItemSettings,
  BetterLootNativeTable,
  BetterLootTable,
} from '@/lib/api';

interface BetterLootTableEditorProps {
  readonly table: BetterLootTable;
  readonly onChange: (next: BetterLootTable) => void;
  /** Trava tudo enquanto o PUT está no ar. */
  readonly busy: boolean;
  /**
   * Marca este item como lixo NO SERVIDOR INTEIRO.
   *
   * ####  É UMA AÇÃO DE OUTRO ALCANCE, E ELA DIZ ISSO  ####
   *
   * A lixeira ao lado tira o item DESTA caixa; este botão diz "isto
   * é lixo aqui", e a partir daí o "Remover lixo" o tira de
   * qualquer caixa que o admin abrir. Confundir os dois seria dar
   * ao mesmo gesto dois alcances.
   *
   * O item NÃO sai da caixa ao ser marcado — é o que o Looty também
   * faz, e é o certo: marcar é opinião, tirar é edição.
   */
  readonly onMarkJunk: (shortname: string) => void;
  /** Os shortnames já marcados. O botão some para eles. */
  readonly junk: readonly string[];
  /** De qual servidor é esta caixa. O seletor de itens precisa saber. */
  readonly serverId: string;
  /**
   * O loot que o JOGO põe nesta caixa. `null` = ninguém respondeu.
   *
   * ####  NULO É UM ESTADO, E NÃO UMA FALHA  ####
   *
   * Ele é lido do servidor NO AR, e todo o resto desta tela é
   * arquivo no disco — que é o que se edita com tudo parado. Sem
   * a resposta, a tela continua inteira: o que ela perde é a
   * marca de "do jogo" em cada linha e o botão de trazer o que
   * falta.
   */
  readonly native: BetterLootNativeTable | null;
  /** Por que não houve resposta. `null` = houve, ou nem se pediu. */
  readonly nativeError: string | null;
  readonly nativeLoading: boolean;
  /** Pede a leitura de novo — o servidor pode ter subido desde então. */
  readonly onNativeRetry: () => void;
}

export function BetterLootTableEditor({
  table,
  onChange,
  busy,
  onMarkJunk,
  junk,
  serverId,
  native,
  nativeError,
  nativeLoading,
  onNativeRetry,
}: BetterLootTableEditorProps) {
  /**
   * A caixa é do BetterLoot?
   *
   * Os dois interruptores numa pergunta só — ver `isAdopted`.
   */
  const adopted = isAdopted(table);

  /**
   * O cruzamento com o loot do jogo, refeito a cada tecla.
   *
   * Sobre o RASCUNHO, e não sobre o disco: quem acabou de
   * acrescentar um item precisa vê-lo marcado como seu na hora.
   */
  const comparison = useMemo(() => compareWithNative(table, native), [table, native]);

  /**
   * A importação escolhida, ainda não aplicada.
   *
   * Mesma regra do multiplicador logo abaixo, e pelo mesmo motivo:
   * ela mexe em dezenas de linhas de uma vez, e o `reset` APAGA o
   * que não é do jogo. Guarda o modo, e não a tabela pronta, para
   * a conta ser refeita sobre o rascunho de agora.
   */
  const [pendingImport, setPendingImport] = useState<NativeImportMode | null>(null);
  const importing = useMemo<NativeImportOutcome | null>(
    () =>
      pendingImport === null || native === null
        ? null
        : importNative(table, native, pendingImport),
    [table, native, pendingImport],
  );

  const chances = useMemo(
    () => chancesOf(table.items, { flat: table.ignoreRarityBias }),
    [table.items, table.ignoreRarityBias],
  );
  const rolls = ungroupedRollsOf(table);

  /**
   * O fator escolhido, ainda não aplicado.
   *
   * ####  O RASCUNHO SÓ MUDA DEPOIS DE ELE LER O QUE VAI MUDAR  ####
   *
   * Todo o resto desta tela mexe numa linha por vez, e o efeito
   * está à vista. Isto reescreve 145 entradas de uma vez, e o valor
   * de antes não fica guardado em lugar nenhum depois de gravado.
   * O passo a mais é o que separa "cliquei em 10x sem querer" de
   * "cliquei em 10x sem querer e apliquei".
   *
   * ####  GUARDA O FATOR, E NÃO A TABELA PRONTA  ####
   *
   * Guardar o resultado congelaria a caixa no instante do clique: o
   * admin ajusta uma linha à mão com o aviso aberto, confirma, e a
   * correção dele some sem nada avisar — porque a tabela aplicada
   * seria a de antes da correção. Com o fator, a conta é refeita
   * sobre o rascunho de AGORA, e o aviso mostra os números de
   * agora.
   */
  const [pendingFactor, setPendingFactor] = useState<number | null>(null);
  const pending = useMemo<BulkMultiplyOutcome | null>(
    () => (pendingFactor === null ? null : multiplyAmounts(table, pendingFactor)),
    [table, pendingFactor],
  );

  const patchSettings = (patch: Partial<BetterLootItemSettings>): void => {
    onChange({ ...table, itemSettings: { ...table.itemSettings, ...patch } });
  };

  const settings = table.itemSettings;
  const overflow = Math.max(settings.minItems, settings.maxItems) > MAX_ITEMS_PER_CONTAINER;

  return (
    <div className="flex h-full flex-col overflow-y-auto border border-border bg-surface">
      <header className="border-b border-border px-3 py-2">
        {/* h2: o h1 é o da página ("Loot"). O nome da caixa é o
            cabeçalho desta coluna, e as seções abaixo dele são h3 —
            sem degrau pulado, que é como se navega por cabeçalhos. */}
        <h2 className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
          {labelOfPrefab(table.prefab)}
        </h2>
        <p className="truncate font-mono text-[10px] text-muted" title={table.prefab}>
          {table.prefab}
        </p>
      </header>

      <div className="space-y-4 p-3">
        {/* ####  QUEM MANDA NA CAIXA  ####

            O `label` do `Toggle` é o MESMO texto que o `Field`
            desenha ao lado, e não uma segunda redação dele: quem usa
            leitor de tela ouve o aria-label do grupo, e um rótulo
            diferente do escrito faz a pessoa responder a uma
            pergunta que não está na tela.

            ####  UM CONTROLE, DOIS INTERRUPTORES  ####

            O plugin exige os dois ligados para mexer na caixa:
            `Is Prefab Enabled?` (LootTables.json) e a lista
            `Watched Container Prefabs` (BetterLoot.json). São
            arquivos diferentes, e a tela mostrava só o primeiro —
            por isso a crate_elite ficava presa em "jogo" sem ter
            como sair por aqui.

            Um controle só porque a pergunta do admin é uma só:
            "esta caixa é minha ou é do jogo?". Oferecer os dois
            seria expor um detalhe de arquivo do plugin numa tela
            que existe para esconder exatamente isso. */}
        <section className="space-y-2">
          <Field
            label="Esta caixa é do BetterLoot"
            hint="Desligar NÃO esvazia a caixa: devolve o loot do jogo, como se o plugin não existisse ali."
          >
            <Toggle
              on={adopted}
              busy={busy}
              label="Esta caixa é do BetterLoot"
              labels={['BetterLoot', 'Jogo']}
              onChange={(on) =>
                onChange({
                  ...table,
                  enabled: on,
                  // `null` fica `null`: aquele servidor não tem
                  // BetterLoot.json, e inventar um valor faria a
                  // gravação CRIAR o arquivo de configuração por
                  // causa de um clique numa caixa.
                  watched: table.watched === null ? null : on,
                })
              }
            />
          </Field>

          {/* ####  A DIVERGÊNCIA PRECISA SER DITA  ####

              Os dois interruptores em desacordo é um estado real,
              e o mais difícil de diagnosticar de todos: o arquivo
              afirma uma coisa e o servidor faz outra. A causa
              comum não é ninguém — é o `CheckWatchedPrefabs` do
              plugin, que cadastra caixa nova como não-vigiada
              sempre que a configuração já existia e não é dia de
              wipe. */}
          {switchesDisagree(table) && (
            <p className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-2xs leading-relaxed text-muted">
              <AlertTriangle
                aria-hidden="true"
                className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500"
              />
              <span>
                Os dois arquivos do plugin discordam sobre esta caixa:{' '}
                <strong className="text-foreground">
                  {table.enabled ? 'o LootTables.json' : 'a lista de vigia'}
                </strong>{' '}
                a liga e{' '}
                <strong className="text-foreground">
                  {table.enabled ? 'a lista de vigia do BetterLoot.json' : 'o LootTables.json'}
                </strong>{' '}
                a desliga — e o servidor só usa a tabela com os dois ligados. Gravar alinha os
                dois com o que está escolhido acima.
              </span>
            </p>
          )}

          <Field
            label="Ignorar a raridade no sorteio"
            hint="Ligado, todo item da caixa tem a mesma chance. Desligado, o item comum do jogo sai muito mais que o raro."
          >
            <Toggle
              on={table.ignoreRarityBias}
              busy={busy}
              label="Ignorar a raridade no sorteio"
              labels={['Todos iguais', 'Por raridade']}
              onChange={(on) => onChange({ ...table, ignoreRarityBias: on })}
            />
          </Field>
        </section>

        {/* ####  QUANTO SAI  #### */}
        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
            Quanto sai
          </h3>

          <div className="grid grid-cols-2 gap-2">
            <Range
              label="Itens"
              min={settings.minItems}
              max={settings.maxItems}
              disabled={busy}
              onChange={(min, max) => patchSettings({ minItems: min, maxItems: max })}
            />
            <Range
              label="Scrap"
              min={settings.minScrap}
              max={settings.maxScrap}
              disabled={busy}
              onChange={(min, max) => patchSettings({ minScrap: min, maxScrap: max })}
            />
            <Range
              label="Blueprints"
              min={settings.minBlueprints}
              max={settings.maxBlueprints}
              disabled={busy}
              onChange={(min, max) => patchSettings({ minBlueprints: min, maxBlueprints: max })}
            />

            <p className="self-end text-2xs leading-relaxed text-muted">
              Sorteios de item solto por caixa: <strong>{rolls.toFixed(1)}</strong>
              {table.guaranteed.length > 0 && settings.guaranteedItemsCountToTotal && (
                <> — os {table.guaranteed.length} garantidos já entram nessa conta.</>
              )}
            </p>
          </div>

          {/* O jogo limita a 36 por caixa. Digitar 60 e receber 36
              seria o pior tipo de silêncio: o número fica na tela
              e o servidor faz outra coisa. */}
          {overflow && (
            <p className="flex items-start gap-1.5 border border-amber/40 bg-amber/10 px-2 py-1.5 text-2xs text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-amber" />
              O jogo corta em {MAX_ITEMS_PER_CONTAINER} itens por caixa. O que passar disso é
              digitado aqui e ignorado lá.
            </p>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Field label="Garantidos contam no total" hint="">
              <Toggle
                on={settings.guaranteedItemsCountToTotal}
                busy={busy}
                label="Garantidos contam no total"
                labels={['Contam', 'Somam']}
                onChange={(on) => patchSettings({ guaranteedItemsCountToTotal: on })}
              />
            </Field>
            <Field label="Itens que vêm junto contam" hint="">
              <Toggle
                on={settings.bonusItemsCountToTotal}
                busy={busy}
                label="Itens que vêm junto contam"
                labels={['Contam', 'Somam']}
                onChange={(on) => patchSettings({ bonusItemsCountToTotal: on })}
              />
            </Field>
          </div>
        </section>

        {/* ####  OS GRUPOS  #### */}
        {table.profiles.length > 0 && (
          <section className="space-y-1 border-t border-border pt-3">
            <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Grupos associados
            </h3>
            <p className="text-2xs leading-relaxed text-muted">
              Um grupo que entra rouba sorteios dos itens soltos abaixo — a porcentagem da lista não
              conta com ele.
            </p>
            <ul className="space-y-1">
              {table.profiles.map((profile) => (
                <li
                  key={profile.name}
                  className="flex items-center justify-between gap-2 border border-border bg-surface-2 px-2 py-1 text-2xs"
                >
                  <span className="font-mono text-foreground">{profile.name}</span>
                  <span className="tabular-nums text-muted">
                    {profile.probability}
                    {' · '}
                    {profile.maxItems === 0 ? 'sem limite' : `até ${String(profile.maxItems)}`}
                    {!profile.enabled && ' · desligado'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ####  OS GARANTIDOS  ####
            Eles saem toda vez que a caixa abre, sem sorteio. Esta
            lista era só leitura até 10/09/2026, e o admin tinha de
            editar o JSON à mão para mexer nela. */}
        <BetterLootGuaranteed
          entries={table.guaranteed}
          onChange={(guaranteed) =>
            onChange({ ...table, guaranteed, guaranteedCount: guaranteed.length })
          }
          serverId={serverId}
          busy={busy}
          idPrefix={`caixa-${table.prefab}`}
          hint={
            table.itemSettings.guaranteedItemsCountToTotal
              ? 'contam no teto de itens desta caixa'
              : 'somam por fora do teto de itens'
          }
        />

        {/* ####  O LOOT DO JOGO  ####

            É a única parte desta tela que precisa do servidor NO
            AR, e a razão é que a tabela nativa não está em arquivo
            nenhum: o BetterLoot a lê uma vez, no primeiro boot, e
            dali em diante só conhece o LootTables.json. Quem
            apagou a lista — ou montou a caixa só com perfis — não
            tinha como pedir o padrão de volta. */}
        <NativeSection
          table={table}
          comparison={comparison}
          loading={nativeLoading}
          error={nativeError}
          busy={busy}
          outcome={importing}
          onRetry={onNativeRetry}
          onPick={setPendingImport}
          onCancel={() => {
            setPendingImport(null);
          }}
          onConfirm={() => {
            if (importing !== null) {
              onChange(importing.table);
            }

            setPendingImport(null);
          }}
        />

        {/* ####  OS ITENS SOLTOS  #### */}
        <section className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Itens da caixa ({table.items.length})
              {/* A divisão só aparece quando alguém respondeu. Com
                  o servidor parado ela seria um "0 do jogo" que se
                  lê como "esta caixa não tem nada do jogo" — o
                  contrário do que se sabe. */}
              {comparison.native !== null && (
                <span className="ml-1.5 font-sans font-normal normal-case tracking-normal text-muted">
                  · {comparison.fromGame} do jogo · {comparison.added}{' '}
                  {comparison.added === 1 ? 'acrescentado' : 'acrescentados'}
                </span>
              )}
            </h3>

            <div className="flex items-center gap-3">
              {chances.flat ? (
                <span className="text-2xs text-muted">
                  Sorteio parelho: {formatChance(flatShareOf(table.items.length))} para cada
                </span>
              ) : (
                <span className="text-2xs text-muted">
                  Peso total{' '}
                  <strong className="tabular-nums text-foreground">
                    {chances.totalWeight === null
                      ? '—'
                      : chances.totalWeight.toLocaleString('pt-BR')}
                  </strong>
                </span>
              )}

              {/* O menu só existe se houver o que multiplicar: numa
                  caixa vazia ele abriria para não fazer nada. */}
              {table.items.length + table.guaranteed.length > 0 && (
                <BetterLootMultiplierMenu
                  text="Multiplicar itens…"
                  label={`Multiplicar as quantidades de ${labelOfPrefab(table.prefab)}`}
                  scope={`Vale só para ${labelOfPrefab(table.prefab)} — ${String(
                    table.items.length + table.guaranteed.length,
                  )} entradas.`}
                  hint="Multiplica o mínimo e o máximo de cada item DESTA caixa. Não é o multiplicador do servidor, que fica na faixa de cima. Você vê o resultado antes de aplicar."
                  shortcuts={BULK_SHORTCUTS}
                  shortcutLabel={() => 'nas quantidades desta caixa'}
                  customLabel="Outro fator (0,5 reduz pela metade)"
                  min={MIN_BULK_FACTOR}
                  max={MAX_BULK_FACTOR}
                  // O passo casa com o piso: com 0,5 a partir de
                  // 0,1 o navegador marcaria "2" como fora da
                  // escala, e o campo ficaria com cara de inválido
                  // no valor mais usado de todos.
                  step={0.1}
                  busy={busy}
                  onApply={(factor) => {
                    setPendingFactor(factor);
                  }}
                />
              )}
            </div>
          </div>

          {pending !== null && (
            <BulkConfirm
              outcome={pending}
              settings={settings}
              busy={busy}
              onCancel={() => {
                setPendingFactor(null);
              }}
              onConfirm={() => {
                onChange(pending.table);
                setPendingFactor(null);
              }}
            />
          )}

          {/* Sem a raridade não há denominador honesto: as
              porcentagens que restam ficam MAIORES do que a
              verdade, porque falta massa na soma. Dizer isso é a
              diferença entre uma tela incompleta e uma que mente. */}
          {chances.unknownRarity > 0 && (
            <p className="flex items-start gap-1.5 border border-amber/40 bg-amber/10 px-2 py-1.5 text-2xs text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-amber" />
              {chances.unknownRarity} de {table.items.length} itens vieram sem raridade. Elas ficam
              com travessão, e as porcentagens das outras estão altas demais — falta a parte delas
              na soma.
            </p>
          )}

          {table.items.length === 0 ? (
            <p className="border border-border px-3 py-6 text-center text-2xs text-muted">
              Nenhum item solto. A caixa só entrega o que estiver garantido ou vier de grupo.
            </p>
          ) : (
            <ul className="divide-y divide-border border border-border">
              {table.items.map((entry) => (
                <EntryRow
                  key={entry.key}
                  entry={entry}
                  origin={comparison.originOf(entry.key)}
                  probability={
                    chances.entries.find((candidate) => candidate.key === entry.key)?.probability ??
                    null
                  }
                  flat={chances.flat}
                  disabled={busy}
                  isJunk={junk.includes(entry.shortname)}
                  onMarkJunk={() => onMarkJunk(entry.shortname)}
                  onChange={(next) =>
                    onChange({
                      ...table,
                      items: table.items.map((candidate) =>
                        candidate.key === entry.key ? next : candidate,
                      ),
                    })
                  }
                  onRemove={() =>
                    onChange({
                      ...table,
                      items: table.items.filter((candidate) => candidate.key !== entry.key),
                      itemCount: table.items.length - 1,
                    })
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * O loot que o JOGO põe nesta caixa.
 *
 * ####  ELA EXISTE PARA RESPONDER "O QUE É MEU AQUI?"  ####
 *
 * O `LootTables.json` guarda item do jogo e item da casa no mesmo
 * dicionário, sem marca nenhuma. Antes desta seção, o admin que
 * abrisse a caixa de elite via 145 linhas e não tinha como saber
 * quais eram dele — nem como trazer de volta as que faltavam.
 *
 * ####  E ELA É A ÚNICA PARTE DA TELA QUE PRECISA DO JOGO NO AR  ####
 *
 * Por isso os três estados têm desenho próprio, e nenhum deles
 * trava o resto do editor: lendo, sem resposta (com o porquê e o
 * botão de tentar de novo) e respondido.
 */
function NativeSection({
  table,
  comparison,
  loading,
  error,
  busy,
  outcome,
  onRetry,
  onPick,
  onCancel,
  onConfirm,
}: {
  readonly table: BetterLootTable;
  readonly comparison: NativeComparison;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly outcome: NativeImportOutcome | null;
  readonly onRetry: () => void;
  readonly onPick: (mode: NativeImportMode) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { native } = comparison;

  return (
    <section className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Loot do jogo
        </h3>

        {native !== null && (
          <span className="text-2xs text-muted">
            {/* O que o JOGO entrega, e não o que esta caixa
                entrega: são números diferentes assim que alguém
                mexe no "Quanto sai", e confundi-los faria a
                referência não servir para nada. */}
            {native.items.length + native.guaranteed.length} itens ·{' '}
            {native.slotsMin === native.slotsMax
              ? `${String(native.slotsMin)} por caixa`
              : `${String(native.slotsMin)}–${String(native.slotsMax)} por caixa`}
            {native.source === 'container' && ` · ${String(native.scrap)} scrap`}
          </span>
        )}
      </div>

      {loading && (
        <p className="border border-border px-3 py-3 text-center text-2xs text-muted">
          Lendo o loot do jogo neste servidor…
        </p>
      )}

      {/* ####  SEM RESPOSTA NÃO É TELA QUEBRADA  ####

          O servidor parado é o estado normal de quem está
          configurando loot — é justamente quando se faz esse
          trabalho. A frase diz o que se perde (a separação e o
          "trazer"), e não o que falhou. */}
      {!loading && error !== null && (
        <div className="space-y-2 border border-border bg-surface-2 px-2 py-2">
          <p className="text-2xs leading-relaxed text-muted">{error}</p>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRetry}>
            Tentar de novo
          </Button>
        </div>
      )}

      {!loading && error === null && native !== null && (
        <>
          <p className="text-2xs leading-relaxed text-muted">
            {comparison.missing.length === 0 ? (
              <>
                Esta caixa já tem tudo o que o jogo põe nela.
                {comparison.added > 0 && (
                  <> Os {comparison.added} itens marcados <em>da casa</em> são acréscimos seus.</>
                )}
              </>
            ) : (
              <>
                <strong className="text-foreground">
                  {comparison.missing.length}{' '}
                  {comparison.missing.length === 1 ? 'item que o jogo põe' : 'itens que o jogo põe'}
                </strong>{' '}
                nesta caixa {comparison.missing.length === 1 ? 'não está' : 'não estão'} na tabela.
                Trazer não apaga nada do que já existe aqui.
              </>
            )}
          </p>

          {outcome === null && (
            <div className="flex flex-wrap gap-2">
              {comparison.missing.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onPick('fill')}
                >
                  Trazer os {comparison.missing.length} que faltam
                </Button>
              )}

              {/* O "voltar" só aparece quando há o que desfazer:
                  numa caixa que é exatamente o jogo ele abriria
                  para não fazer nada. */}
              {comparison.added > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onPick('reset')}
                >
                  Voltar ao loot do jogo…
                </Button>
              )}
            </div>
          )}

          {outcome !== null && (
            <ImportConfirm
              outcome={outcome}
              prefab={table.prefab}
              busy={busy}
              onCancel={onCancel}
              onConfirm={onConfirm}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * O que a importação vai fazer, escrito por extenso.
 *
 * ####  O `reset` APAGA, E ISSO PRECISA ESTAR NA FRASE  ####
 *
 * "Voltar ao loot do jogo" soa inofensivo e não é: ele tira da
 * caixa todo item que o jogo não põe ali — inclusive o troféu que
 * a casa levou semanas para montar. O número some na confirmação
 * genérica e aparece aqui.
 */
function ImportConfirm({
  outcome,
  prefab,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly outcome: NativeImportOutcome;
  readonly prefab: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Confirmar a importação do loot do jogo"
      className="space-y-2 border border-amber/40 bg-amber/10 px-2 py-2"
    >
      <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-foreground">
        <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-amber" />
        <span>
          {outcome.mode === 'fill' ? (
            <>
              <strong>Trazer o que falta em {labelOfPrefab(prefab)}:</strong> entram{' '}
              <strong>{outcome.added}</strong>{' '}
              {outcome.added === 1 ? 'item do jogo' : 'itens do jogo'}
              {outcome.guaranteedAdded > 0 && (
                <> e {outcome.guaranteedAdded} garantidos</>
              )}
              . Nada sai, e nenhuma quantidade que você ajustou muda.
            </>
          ) : (
            <>
              <strong>Voltar {labelOfPrefab(prefab)} ao loot do jogo:</strong> saem{' '}
              <strong>{outcome.removed}</strong>{' '}
              {outcome.removed === 1 ? 'item que o jogo não põe' : 'itens que o jogo não põe'} aqui
              {outcome.added > 0 && <> e entram {outcome.added} que faltavam</>}.
              {outcome.settingsChanged && <> O “quanto sai” também volta ao do jogo.</>}
              {' '}
              As quantidades dos itens que ficam <strong>não</strong> mudam — quem quiser as do
              jogo de volta tira o item e traz de novo.
            </>
          )}{' '}
          Os grupos desta caixa continuam como estão.
        </span>
      </p>

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
          {outcome.mode === 'fill' ? 'Trazer' : 'Voltar ao loot do jogo'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * O que a multiplicação vai fazer, escrito por extenso.
 *
 * ####  ISTO É O AVISO, E NÃO UMA CONFIRMAÇÃO GENÉRICA  ####
 *
 * "Tem certeza?" não informa nada: quem clicou tinha certeza. O que
 * o admin não sabe é o RESULTADO — que as 145 entradas passam a
 * sair de 2 a 8 —, e é isso que decide se ele continua.
 *
 * ####  E O TETO DE 36 É DITO AQUI, ANTES DE ELE PROCURAR  ####
 *
 * Quem aplica "10x" numa caixa espera dez vezes mais coisa. O que
 * ele recebe é a mesma quantidade de itens com dez vezes mais
 * unidades cada — porque quantos itens a caixa entrega é outro
 * campo, e o jogo o corta em 36 (`Math.Clamp`, BetterLoot.cs:2349).
 * Dizer isso aqui é o que impede o admin de aplicar de novo achando
 * que não pegou.
 */
function BulkConfirm({
  outcome,
  settings,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly outcome: BulkMultiplyOutcome;
  readonly settings: BetterLootItemSettings;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const total = outcome.items + outcome.guaranteed;
  const untouched = total - outcome.changed;
  const overflow = Math.max(settings.minItems, settings.maxItems) > MAX_ITEMS_PER_CONTAINER;

  return (
    <div
      role="group"
      aria-label="Confirmar a multiplicação das quantidades"
      className="space-y-2 border border-amber/40 bg-amber/10 px-2 py-2"
    >
      <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-foreground">
        <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-amber" />
        <span>
          <strong>{formatFactor(outcome.factor)} nesta caixa:</strong> as {total} entradas passam a
          sair de <strong>{formatRange(outcome.after)}</strong> em vez de{' '}
          <strong>{formatRange(outcome.before)}</strong>.
          {outcome.guaranteed > 0 && (
            <>
              {' '}
              Os {outcome.guaranteed} itens garantidos entram junto — eles saem em toda caixa.
            </>
          )}
          {untouched > 0 && (
            <>
              {' '}
              {untouched === 1 ? 'Uma entrada fica' : `${String(untouched)} entradas ficam`} como
              está: o valor delas não muda com este fator.
            </>
          )}
        </span>
      </p>

      <p className="text-[10px] leading-relaxed text-muted">
        Isto <strong>não</strong> muda quantos itens a caixa entrega — ela continua sorteando de{' '}
        {settings.minItems} a {settings.maxItems} por vez
        {overflow
          ? `, e o jogo corta em ${String(MAX_ITEMS_PER_CONTAINER)}: o que passa disso já é ignorado lá.`
          : ` (o jogo corta em ${String(MAX_ITEMS_PER_CONTAINER)}).`}{' '}
        O que muda é a quantidade de cada um. E nada vai para o servidor até você clicar em
        &ldquo;Gravar e recarregar&rdquo;: até lá, &ldquo;Descartar&rdquo; desfaz.
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" disabled={busy} onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>
          Aplicar {formatFactor(outcome.factor)}
        </Button>
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  origin,
  probability,
  flat,
  disabled,
  isJunk,
  onChange,
  onMarkJunk,
  onRemove,
}: {
  readonly entry: BetterLootEntry;
  /** Do jogo, acrescentado, ou não deu para saber. */
  readonly origin: EntryOrigin;
  readonly probability: number | null;
  readonly flat: boolean;
  readonly disabled: boolean;
  readonly isJunk: boolean;
  readonly onChange: (next: BetterLootEntry) => void;
  readonly onMarkJunk: () => void;
  readonly onRemove: () => void;
}) {
  const marked = entry.skinId !== '' && entry.skinId !== '0';

  return (
    <li className="flex items-center gap-2 px-2 py-1.5">
      <ItemIcon shortname={entry.shortname} size="sm" label={entry.shortname} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-2xs text-foreground">
            {entry.customName ?? entry.displayName ?? entry.shortname}
          </span>
          {/* ####  DE ONDE A LINHA VEIO  ####

              Só duas marcas, e nunca as duas juntas: "do jogo" é o
              caso comum numa caixa recém-adotada, e marcar 145
              linhas iguais não informa nada — o que se procura é o
              que DESTOA. Por isso a marca visível é a do que a
              casa acrescentou, e "do jogo" fica só no title.

              Com o servidor parado a origem é `unknown` e nenhuma
              marca aparece: a tela não afirma o que não sabe. */}
          {origin === 'added' && (
            <span
              title="Este item não está no loot que o jogo põe nesta caixa: alguém o acrescentou."
              className="shrink-0 border border-rust/50 px-1 text-[10px] uppercase text-rust"
            >
              da casa
            </span>
          )}
          {origin === 'game' && (
            <span
              aria-hidden="true"
              title="O jogo já põe este item nesta caixa."
              className="shrink-0 text-[10px] text-muted"
            >
              jogo
            </span>
          )}
          {/* A marca é o que separa o Troféu Bleik de um troféu
              qualquer. Sem ela na lista, duas linhas do mesmo
              shortname ficariam idênticas na tela. */}
          {marked && (
            <span
              title={`Skin ${entry.skinId}`}
              className="shrink-0 border border-amber/50 px-1 text-[10px] uppercase text-amber"
            >
              nosso
            </span>
          )}
          {entry.hasWeaponProperties && (
            <span
              title="Munição e acessórios são preenchidos pelo próprio plugin ao validar."
              className="shrink-0 border border-border px-1 text-[10px] uppercase text-muted"
            >
              arma
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted">{entry.shortname}</span>
      </span>

      {/* ####  PESO E PORCENTAGEM, LADO A LADO  ####
          O peso vem da raridade do item e o admin não o digita; a
          porcentagem é o que ele precisa ler. Mostrar só um dos
          dois esconde de onde o número veio. */}
      <span className="w-24 shrink-0 text-right">
        <span className="block text-2xs tabular-nums text-foreground">
          {formatChance(probability)}
        </span>
        <span className="block text-[10px] text-muted">
          {flat ? 'parelho' : rarityLabel(entry.rarity)}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1">
        <NumberInput
          value={entry.min}
          label={`Quantidade mínima de ${entry.shortname}`}
          disabled={disabled}
          onChange={(min) => onChange({ ...entry, min, max: Math.max(min, entry.max) })}
        />
        <span aria-hidden="true" className="text-2xs text-muted">
          –
        </span>
        <NumberInput
          value={entry.max}
          label={`Quantidade máxima de ${entry.shortname}`}
          disabled={disabled}
          onChange={(max) => onChange({ ...entry, max, min: Math.min(max, entry.min) })}
        />
      </span>

      {/* ####  MARCAR NÃO É TIRAR  ####
          Este botão diz "isto é lixo neste servidor" e não mexe na
          caixa; a lixeira ao lado tira o item daqui. Já marcado, ele
          vira só um selo — repetir a marca não faria nada. */}
      {isJunk ? (
        <span
          className="shrink-0 px-1 text-2xs uppercase tracking-wide text-muted"
          title="Este item está na lista de lixo deste servidor"
        >
          lixo
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          aria-label={`Marcar ${entry.shortname} como lixo neste servidor`}
          title="Marcar como lixo neste servidor (não tira da caixa)"
          onClick={onMarkJunk}
          className="shrink-0 p-1 text-muted hover:text-amber disabled:opacity-40"
        >
          <Ban aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      )}

      <button
        type="button"
        disabled={disabled}
        aria-label={`Tirar ${entry.shortname} desta caixa`}
        onClick={onRemove}
        className="shrink-0 p-1 text-muted hover:text-rust disabled:opacity-40"
      >
        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function NumberInput({
  value,
  label,
  disabled,
  onChange,
}: {
  readonly value: number;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <Input
      type="number"
      min={0}
      value={String(value)}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => {
        const parsed = Number.parseInt(event.target.value, 10);

        onChange(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
      }}
      className="h-7 w-14 px-1 text-center text-2xs"
    />
  );
}

function Range({
  label,
  min,
  max,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly onChange: (min: number, max: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-2xs text-muted">{label}</span>
      <NumberInput
        value={min}
        label={`${label} — mínimo`}
        disabled={disabled}
        // Um mínimo acima do máximo faria o plugin sortear numa
        // faixa invertida. Empurrar o outro lado junto evita o
        // estado impossível sem travar a digitação.
        onChange={(next) => onChange(next, Math.max(next, max))}
      />
      <span aria-hidden="true" className="text-2xs text-muted">
        –
      </span>
      <NumberInput
        value={max}
        label={`${label} — máximo`}
        disabled={disabled}
        onChange={(next) => onChange(Math.min(next, min), next)}
      />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-2xs text-foreground">{label}</span>
        {hint !== '' && <span className="block text-[10px] leading-snug text-muted">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

