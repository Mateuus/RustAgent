'use client';

// ============================================================
//  betterloot-profiles.tsx  -  os perfis de loot, a segunda aba.
//
//  ####  UM PERFIL É UM GRUPO DE ITENS COM PESO PRÓPRIO  ####
//
//  É o que o Looty chama de "Loot Profile", e não é invenção de
//  tela: cada perfil é uma entrada do `LootGroups.json`, OUTRO
//  arquivo do BetterLoot. A diferença para os itens soltos de uma
//  caixa é o sorteio — solto sai por raridade do jogo, e dentro de
//  um perfil sai pelo peso que o admin escreveu.
//
//  ####  O PERFIL NÃO SABE EM QUE CAIXA ELE ENTRA  ####
//
//  A associação mora na CAIXA (o bloco "Perfis desta caixa", no
//  editor ao lado). Por isso esta tela mostra "em uso em N caixas"
//  mas não deixa ligar nada daqui: quem liga é a caixa.
//
//  ####  A SOMA TEM DE DAR 100  ####
//
//  Se não der, o BetterLoot REBALANCEIA sozinho no próximo
//  carregamento (`BetterLoot.cs:600`) e o admin vê números
//  diferentes dos que digitou. A barra avisa antes; gravar com a
//  soma errada continua permitido, porque o meio de uma edição é um
//  lugar legítimo para ela estar errada.
//
//  ####  E APAGAR PERGUNTA ANTES — É ONDE SOMOS MELHORES  ####
//
//  O Looty apaga com um "cannot be undone" genérico e desfaz as
//  associações em silêncio. Nós lemos o `LootTables.json` inteiro:
//  sabemos dizer QUAIS caixas perdem o ajuste, e dizemos.
// ============================================================

import { Plus, Save, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { nextEntryKey } from '@/components/loot/betterloot';
import { ItemCombobox } from '@/components/item-combobox';
import { NO_SKIN, type ItemChoice } from '@/components/item-choice';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { StateBlock } from '@/components/state-block';
import { toast } from '@/lib/toast';
import {
  agent,
  type BetterLootProfile,
  type BetterLootProfileItem,
  type BetterLootProfileSummary,
} from '@/lib/api';

/** O nome curto de um prefab, para caber na frase do aviso. */
function shortPrefab(prefab: string): string {
  const last = prefab.split('/').pop() ?? prefab;

  return last.replace(/\.prefab$/, '');
}

interface BetterLootProfilesProps {
  readonly serverId: string;
  readonly busy: boolean;
}

export function BetterLootProfiles({ serverId, busy }: BetterLootProfilesProps) {
  const [profiles, setProfiles] = useState<BetterLootProfileSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  /** O que o disco tinha quando o perfil abriu. É o alvo do "descartar". */
  const [saved, setSaved] = useState<BetterLootProfile | null>(null);
  const [draft, setDraft] = useState<BetterLootProfile | null>(null);
  /** A impressão DESTE perfil — o que o "Gravar" devolve. */
  const [revision, setRevision] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<BetterLootProfileSummary | null>(null);

  const [shortname, setShortname] = useState('');
  const [choice, setChoice] = useState<ItemChoice | null>(null);

  const load = useCallback(async () => {
    if (serverId === '') {
      return;
    }

    setLoading(true);

    try {
      const response = await agent.betterLootProfiles(serverId);

      setProfiles(response.profiles);
      setListError(null);
    } catch (cause) {
      setProfiles([]);
      setListError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Trocar de servidor troca o arquivo: o perfil aberto era de outro
  // disco, e mantê-lo na tela ofereceria gravá-lo por cima do novo.
  useEffect(() => {
    setSelected(null);
    setSaved(null);
    setDraft(null);
    setRevision(null);
  }, [serverId]);

  const open = async (name: string): Promise<void> => {
    setSelected(name);

    try {
      const response = await agent.betterLootProfile(serverId, name);

      setSaved(response.profile);
      setDraft(response.profile);
      setRevision(response.revision);
    } catch (cause) {
      setSaved(null);
      setDraft(null);
      setRevision(null);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async (): Promise<void> => {
    if (draft === null) {
      return;
    }

    setSaving(true);

    try {
      const response = await agent.saveBetterLootProfile(serverId, {
        baseRevision: revision,
        profile: draft,
      });

      // A resposta manda, e não o rascunho: se o plugin rebalanceou
      // as probabilidades ao carregar, é o rebalanceado que a tela
      // mostra. Ver o editor de caixa.
      setSaved(response.profile);
      setDraft(response.profile);
      setRevision(response.revision);
      toast.success('Perfil gravado e plugin recarregado.');

      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const create = async (): Promise<void> => {
    const name = newName.trim();

    if (name === '') {
      return;
    }

    setSaving(true);

    try {
      await agent.saveBetterLootProfile(serverId, {
        // `null` diz ao agente que isto é CRIAÇÃO: se já houver um
        // perfil com este nome, ele recusa em vez de sobrescrever o
        // trabalho de outra pessoa.
        baseRevision: null,
        profile: { name, enabled: true, guaranteed: [], items: [] },
      });

      setCreating(false);
      setNewName('');
      await load();
      await open(name);
      toast.success(`Perfil "${name}" criado.`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target: BetterLootProfileSummary): Promise<void> => {
    setSaving(true);

    try {
      const response = await agent.deleteBetterLootProfile(
        serverId,
        target.name,
        // O admin já viu quais caixas perdem o ajuste — foi o que o
        // diálogo mostrou. Autorizar aqui é o que impede a caixa de
        // ficar pedindo um perfil que não existe mais.
        target.usedBy.length > 0,
      );

      setDeleting(null);

      if (selected === target.name) {
        setSelected(null);
        setSaved(null);
        setDraft(null);
        setRevision(null);
      }

      await load();

      toast.success(
        response.detached.length === 0
          ? `Perfil "${target.name}" apagado.`
          : `Perfil "${target.name}" apagado, e tirado de ${String(response.detached.length)} caixa(s).`,
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const addItem = (): void => {
    const base = shortname.trim();

    if (base === '' || draft === null) {
      return;
    }

    const key = nextEntryKey(base, draft.items.map((item) => item.key));

    const entry: BetterLootProfileItem = {
      key,
      shortname: base,
      displayName: choice?.displayName ?? null,
      skinId: choice?.skinId ?? NO_SKIN,
      customName: null,
      min: 1,
      max: 1,
      allowDuplicates: true,
      canConvertToBlueprint: null,
      durability: null,
      rarity: null,
      bonusItems: [],
      hasWeaponProperties: false,
      // Zero de propósito: o peso é a decisão do admin, e chutar um
      // número aqui mudaria a soma dos outros sem ele pedir.
      probability: 0,
    };

    setDraft({ ...draft, items: [...draft.items, entry] });
    setShortname('');
    setChoice(null);
  };

  const patchItem = (key: string, patch: Partial<BetterLootProfileItem>): void => {
    if (draft === null) {
      return;
    }

    setDraft({
      ...draft,
      items: draft.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    });
  };

  /**
   * Reparte os pesos igualmente entre os itens.
   *
   * É o "Auto Balance" do Looty, e ele existe porque a alternativa é
   * o admin fazer a divisão de cabeça toda vez que acrescenta um
   * item. O resto da divisão vai para o primeiro, para a soma fechar
   * exatamente em 100.
   */
  const balance = (): void => {
    if (draft === null || draft.items.length === 0) {
      return;
    }

    const each = Math.floor((100 / draft.items.length) * 100) / 100;
    const rest = Math.round((100 - each * draft.items.length) * 100) / 100;

    setDraft({
      ...draft,
      items: draft.items.map((item, index) => ({
        ...item,
        probability: index === 0 ? Math.round((each + rest) * 100) / 100 : each,
      })),
    });
  };

  const sum =
    draft === null ? 0 : Math.round(draft.items.reduce((total, item) => total + item.probability, 0) * 100) / 100;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="flex h-[38rem] flex-col border border-border bg-surface">
        <div className="flex items-center justify-between gap-2 border-b border-border p-2">
          <h2 className="text-2xs font-semibold uppercase tracking-wide text-muted">Perfis</h2>
          <Button
            size="sm"
            disabled={busy || saving}
            onClick={() => setCreating(true)}
            className="flex items-center gap-1"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Criar
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listError !== null && (
            <p className="p-2 text-2xs text-danger">{listError}</p>
          )}

          {listError === null && profiles.length === 0 && (
            <p className="p-2 text-2xs text-muted">
              {loading
                ? 'Lendo…'
                : 'Nenhum perfil neste servidor. Um perfil agrupa itens com peso próprio — use-o para ' +
                  '"armas T3" ou "medicamentos" e ligue-o às caixas que devem sorteá-los.'}
            </p>
          )}

          <ul>
            {profiles.map((profile) => (
              <li key={profile.name}>
                <button
                  type="button"
                  onClick={() => void open(profile.name)}
                  className={`flex w-full flex-col gap-0.5 border-b border-border px-2 py-1.5 text-left hover:bg-surface-2 ${
                    selected === profile.name ? 'bg-surface-2' : ''
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-2xs font-medium">{profile.name}</span>
                    {!profile.enabled && (
                      <span className="shrink-0 text-2xs uppercase text-muted">desligado</span>
                    )}
                  </span>
                  <span className="text-2xs text-muted">
                    {profile.itemCount} {profile.itemCount === 1 ? 'item' : 'itens'}
                    {' · '}
                    {/* A soma é a informação que decide se o plugin vai
                        mexer no perfil sozinho no próximo load. */}
                    <span className={profile.probabilitySum === 100 ? '' : 'text-amber'}>
                      soma {profile.probabilitySum}%
                    </span>
                    {profile.usedBy.length > 0 && ` · em ${profile.usedBy.length} caixa(s)`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex h-[38rem] min-w-0 flex-col gap-2">
        {draft === null ? (
          <StateBlock
            variant="empty"
            title="Nenhum perfil aberto"
            detail="Escolha um perfil à esquerda, ou crie o primeiro. Um perfil é um grupo de itens com peso próprio, que as caixas podem sortear."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto min-w-0 truncate text-sm font-semibold">{draft.name}</h2>

              <Toggle
                on={draft.enabled}
                busy={saving}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
                labels={['Ligado', 'Desligado']}
                label="O perfil está ligado?"
              />

              <Button
                variant="danger"
                size="sm"
                disabled={saving}
                onClick={() =>
                  setDeleting(profiles.find((item) => item.name === draft.name) ?? null)
                }
                className="flex items-center gap-1"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                Apagar
              </Button>

              <Button
                size="sm"
                disabled={!dirty || saving}
                onClick={() => setDraft(saved)}
                className="flex items-center gap-1"
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                Descartar
              </Button>

              <Button
                variant="confirm"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => void save()}
                className="flex items-center gap-1"
              >
                <Save aria-hidden="true" className="h-3.5 w-3.5" />
                {saving ? 'Gravando…' : 'Gravar e recarregar'}
              </Button>
            </div>

            {/* ####  A SOMA, E O QUE ACONTECE SE ELA NÃO FECHAR  ####
                O plugin rebalanceia sozinho no próximo carregamento.
                Dizer isso antes é o que evita o admin achar que a
                tela perdeu o que ele digitou. */}
            <div
              className={`flex items-center justify-between gap-2 border px-2 py-1 text-2xs ${
                sum === 100 ? 'border-border text-muted' : 'border-amber text-amber'
              }`}
            >
              <span>
                {sum === 100
                  ? `Soma dos pesos: ${sum}% — fechada.`
                  : `Soma dos pesos: ${sum}%. Fora de 100, o BetterLoot reparte sozinho ao recarregar — e os números mudam.`}
              </span>
              <Button size="sm" disabled={saving || draft.items.length === 0} onClick={balance}>
                Repartir igual
              </Button>
            </div>

            <div className="flex items-end gap-2 border border-border bg-surface p-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor="profile-item">Pôr item neste perfil</Label>
                <ItemCombobox
                  inputId="profile-item"
                  value={shortname}
                  onValueChange={setShortname}
                  onChoiceChange={setChoice}
                  serverId={serverId}
                  disabled={saving}
                  placeholder="nome do item (assault, wood, troféu…)"
                />
              </div>
              <Button
                size="sm"
                disabled={shortname.trim() === '' || saving}
                onClick={addItem}
                className="flex items-center gap-1"
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                Acrescentar
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto border border-border bg-surface">
              {draft.items.length === 0 ? (
                <p className="p-2 text-2xs text-muted">
                  Perfil vazio. Um perfil sem item não sorteia nada, e o BetterLoot o ignora.
                </p>
              ) : (
                <table className="w-full text-2xs">
                  <thead className="sticky top-0 bg-surface-2">
                    <tr>
                      <th className="p-1 text-left font-medium">Item</th>
                      <th className="p-1 text-right font-medium">Peso&nbsp;%</th>
                      <th className="p-1 text-right font-medium">Mín</th>
                      <th className="p-1 text-right font-medium">Máx</th>
                      <th className="p-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.items.map((item) => (
                      <tr key={item.key} className="border-t border-border">
                        <td className="p-1">
                          <span className="block truncate">{item.displayName ?? item.shortname}</span>
                          <span className="block truncate font-mono text-muted">
                            {item.shortname}
                          </span>
                        </td>
                        <td className="p-1 text-right">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={String(item.probability)}
                            disabled={saving}
                            onChange={(event) =>
                              patchItem(item.key, { probability: Number(event.target.value) })
                            }
                            className="h-7 w-20 text-right text-2xs"
                          />
                        </td>
                        <td className="p-1 text-right">
                          <Input
                            type="number"
                            min={0}
                            value={String(item.min)}
                            disabled={saving}
                            onChange={(event) =>
                              patchItem(item.key, { min: Number(event.target.value) })
                            }
                            className="h-7 w-16 text-right text-2xs"
                          />
                        </td>
                        <td className="p-1 text-right">
                          <Input
                            type="number"
                            min={0}
                            value={String(item.max)}
                            disabled={saving}
                            onChange={(event) =>
                              patchItem(item.key, { max: Number(event.target.value) })
                            }
                            className="h-7 w-16 text-right text-2xs"
                          />
                        </td>
                        <td className="p-1 text-right">
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={saving}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                items: draft.items.filter((other) => other.key !== item.key),
                              })
                            }
                            title="Tirar do perfil"
                          >
                            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog open={creating} title="Criar perfil de loot" onClose={() => setCreating(false)} busy={saving}>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="profile-name">Nome do perfil</Label>
            <Input
              id="profile-name"
              value={newName}
              disabled={saving}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="armas_t3"
            />
            <p className="text-2xs text-muted">
              O nome vira a chave do arquivo do BetterLoot e é ele que as caixas citam. Escolha algo
              que diga o que tem dentro.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={saving} onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button
              variant="confirm"
              size="sm"
              disabled={newName.trim() === '' || saving}
              onClick={() => void create()}
            >
              Criar
            </Button>
          </div>
        </div>
      </Dialog>

      {/* ####  O AVISO QUE O LOOTY NÃO DÁ  ####
          Ele apaga com um "cannot be undone" genérico e desfaz as
          associações em silêncio. Aqui o admin lê o nome de cada
          caixa que perde o ajuste antes de decidir. */}
      <ConfirmDialog
        open={deleting !== null}
        title={`Apagar o perfil "${deleting?.name ?? ''}"?`}
        confirmLabel="Apagar"
        busy={saving}
        onConfirm={() => {
          if (deleting !== null) {
            void remove(deleting);
          }
        }}
        onClose={() => setDeleting(null)}
      >
        {deleting !== null && deleting.usedBy.length > 0 ? (
          <div className="space-y-2">
            <p>
              Ele está sendo sorteado por <strong>{deleting.usedBy.length}</strong> caixa(s):
            </p>
            <ul className="max-h-40 list-disc overflow-y-auto pl-4 font-mono text-2xs">
              {deleting.usedBy.map((prefab) => (
                <li key={prefab}>{shortPrefab(prefab)}</li>
              ))}
            </ul>
            <p>
              Apagar tira o perfil dessas caixas junto — elas voltam a sortear só os itens soltos.
              Sem isso o BetterLoot as ignoraria em silêncio.
            </p>
          </div>
        ) : (
          <p>Ele não está em nenhuma caixa. Apagar não muda o loot de ninguém.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
