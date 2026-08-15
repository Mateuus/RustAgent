'use client';

// ============================================================
//  kit-dialog.tsx  -  criar e editar um kit da loja.
//
//  ####  UM KIT É UM LOADOUT COM REGRAS DE ENTREGA  ####
//
//  Por isso os itens saem do MESMO componente do loadout
//  (`LoadoutEditor`): dois editores de item divergiriam no primeiro
//  ajuste, e o de skin é o que ninguém repara até o jogador receber
//  a arma sem pintura.
//
//  O que este formulário acrescenta é só a REGRA:
//
//      compra     preço em centavos, e o jogador leva quantas
//                 vezes quiser
//      resgate    uma vez por jogador, para sempre
//      cooldown   de N em N horas
//
//  ####  O PREÇO É EM CENTAVOS, E A TELA MOSTRA EM REAIS  ####
//
//  Dinheiro em float é o erro que aparece no extrato do cliente. O
//  campo aceita "19,90" e manda 1990 — a conversão é de UM lado só,
//  e é aqui.
//
//  ####  E O AGENTE NÃO COBRA  ####
//
//  Ele entrega. Quem cobra é quem chama a rota (o site, a loja); o
//  preço viaja com o kit para a interface do jogo poder mostrá-lo.
//  A tela diz isso, para ninguém esperar uma carteira que não
//  existe.
// ============================================================

import { useEffect, useState } from 'react';

import { itemsProblem, LoadoutEditor } from '@/components/loadout-editor';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { agent, type Kit, type KitKind, type LoadoutItem, type VipTier } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const KINDS: readonly { value: KitKind; label: string; hint: string }[] = [
  { value: 'compra', label: 'Compra', hint: 'o jogador paga e leva, quantas vezes quiser' },
  { value: 'resgate', label: 'Resgate único', hint: 'uma vez por jogador, para sempre' },
  { value: 'cooldown', label: 'Cooldown', hint: 'de tempos em tempos' },
];

interface KitDialogProps {
  readonly open: boolean;
  /** `null` = criar. Preenchido = editar aquele kit. */
  readonly kit: Kit | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function KitDialog({ open, kit, onClose, onDone }: KitDialogProps) {
  const [servers, setServers] = useState<string[]>([]);
  const [tiers, setTiers] = useState<VipTier[]>([]);

  const [slug, setSlug] = useState(kit?.slug ?? '');
  const [name, setName] = useState(kit?.name ?? '');
  const [description, setDescription] = useState(kit?.description ?? '');
  const [category, setCategory] = useState(kit?.category ?? '');
  // Em HORAS na tela, em segundos no banco: quem administra pensa em
  // "duas horas depois do wipe", não em 7200.
  const [wipeHours, setWipeHours] = useState(
    kit?.wipeDelaySeconds === null || kit?.wipeDelaySeconds === undefined
      ? ''
      : String(Math.round(kit.wipeDelaySeconds / 3600)),
  );
  const [kind, setKind] = useState<KitKind>(kit?.kind ?? 'resgate');
  const [price, setPrice] = useState(centsToInput(kit?.priceCents));
  const [hours, setHours] = useState(
    kit?.cooldownSeconds === null || kit?.cooldownSeconds === undefined
      ? 24
      : Math.max(1, Math.round(kit.cooldownSeconds / 3600)),
  );
  const [requiredTier, setRequiredTier] = useState(kit?.requiredTier ?? '');
  const [items, setItems] = useState<LoadoutItem[]>(kit === null ? [] : [...kit.items]);
  const [enabled, setEnabled] = useState(kit?.enabled ?? true);
  const [chosen, setChosen] = useState<string[]>(kit === null ? [] : [...kit.servers]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await agent.servers();

        setServers(response.servers.map((server) => server.id));
      } catch {
        // Sem a lista, os checkboxes ficam vazios e o agente recusa
        // um servidor inventado. Não é motivo para fechar o
        // formulário.
      }

      try {
        setTiers((await agent.vipTiers()).tiers);
      } catch {
        // O nível exigido vira opcional sem a lista: o campo fica
        // com "qualquer um" e nada se perde.
      }
    })();
  }, []);

  async function submit(): Promise<void> {
    const problem = itemsProblem(items);

    if (problem !== null) {
      toast.error('Confira os itens', { description: problem });
      return;
    }

    const body = {
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      category: category.trim() === '' ? null : category.trim(),
      wipeDelaySeconds:
        wipeHours.trim() === '' ? null : Math.max(1, Math.round(Number(wipeHours) * 3600)),
      kind,
      priceCents: kind === 'compra' ? inputToCents(price) : null,
      cooldownSeconds: kind === 'cooldown' ? hours * 3600 : null,
      requiredTier: requiredTier === '' ? null : requiredTier,
      items,
      enabled,
      servers: chosen,
    };

    setBusy(true);

    try {
      const response =
        kit === null ? await agent.createKit(body) : await agent.updateKit(kit.id, body);

      toast.success(kit === null ? 'Kit criado' : 'Kit gravado', { description: response.message });

      onDone();
      onClose();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={kit === null ? 'Novo kit' : `Kit ${kit.name}`}
      busy={busy}
      onClose={onClose}
      className="w-[min(52rem,94vw)]"
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Nome</Label>
            <Input
              value={name}
              placeholder="Kit inicial"
              disabled={busy}
              onChange={(event) => {
                // O slug acompanha o nome enquanto ninguém o editou
                // à mão — e nunca depois de o kit existir, porque
                // ele é o identificador estável para o site e para a
                // interface do jogo.
                if (kit === null && slug === slugify(name)) {
                  setSlug(slugify(event.target.value));
                }

                setName(event.target.value);
              }}
            />
          </div>

          <div>
            <Label>Slug</Label>
            <Input
              value={slug}
              placeholder="kit-inicial"
              disabled={busy}
              onChange={(event) => setSlug(slugify(event.target.value))}
              className="font-mono"
            />
            <p className="mt-1 text-2xs text-muted">
              O identificador estável: é por ele que o site e a interface do jogo apontam para este
              kit.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <div>
            <Label>Descrição</Label>
            <textarea
              value={description}
              rows={2}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full border border-border bg-surface-2 px-3 py-2 text-sm text-foreground"
            />
            <p className="mt-1 text-2xs text-muted">
              Aparece na aba <strong>Geral</strong> do kit, dentro do jogo.
            </p>
          </div>

          <div>
            <Label>Categoria</Label>
            <Input
              value={category}
              placeholder="Iniciante"
              disabled={busy}
              onChange={(event) => setCategory(event.target.value)}
            />
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              A aba da página KITS no jogo. Em branco, o kit cai em <strong>GERAL</strong> — e com
              uma categoria só a barra de abas nem aparece.
            </p>
          </div>
        </div>

        <div>
          <Label>Como o jogador recebe</Label>
          <div className="flex flex-wrap items-stretch border border-border">
            {KINDS.map((option, index) => (
              <div key={option.value} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={kind === option.value}
                  disabled={busy}
                  onClick={() => setKind(option.value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    kind === option.value
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              </div>
            ))}
          </div>

          <p className="mt-1 text-2xs text-muted">
            {KINDS.find((option) => option.value === kind)?.hint}
          </p>
        </div>

        {kind === 'compra' && (
          <div>
            <Label>Preço</Label>
            <Input
              value={price}
              placeholder="19,90"
              disabled={busy}
              onChange={(event) => setPrice(event.target.value)}
              className="font-mono"
            />
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Em reais; o agente guarda em centavos. <strong>O agente não cobra</strong> — ele
              entrega. Quem cobra é a loja que chama a rota; o preço viaja junto para a interface do
              jogo poder mostrá-lo.
            </p>
          </div>
        )}

        {kind === 'cooldown' && (
          <div>
            <Label>De quantas em quantas horas</Label>
            <Input
              type="number"
              min={1}
              max={8760}
              value={hours}
              disabled={busy}
              onChange={(event) => setHours(Math.max(1, Number(event.target.value)))}
            />
            <p className="mt-1 text-2xs text-muted">
              A conta é feita na hora do resgate, a partir da última entrega que deu certo — uma
              tentativa que falhou não começa a contagem.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Só libera depois do wipe</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={720}
                value={wipeHours}
                placeholder="—"
                disabled={busy}
                onChange={(event) => setWipeHours(event.target.value)}
                className="w-24"
              />
              <span className="text-2xs text-muted">horas após o wipe</span>
            </div>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Em branco = libera sempre. Um kit avançado entregue na primeira hora apaga a corrida
              inicial do wipe. A hora do wipe vem do <strong>servidor</strong> — se ele não
              responder, o kit libera.
            </p>
          </div>

          <div>
            <Label>Nível de VIP exigido</Label>
            <select
              value={requiredTier}
              disabled={busy}
              onChange={(event) => setRequiredTier(event.target.value)}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              <option value="">Qualquer um</option>
              {tiers.map((tier) => (
                <option key={tier.tier} value={tier.tier}>
                  {tier.title ?? tier.tier}
                </option>
              ))}
            </select>
            <p className="mt-1 text-2xs text-muted">Quem tem um nível MAIS ALTO também pode.</p>
          </div>

          <div>
            <Label>Em quais servidores</Label>
            <div className="flex flex-wrap gap-3 border border-border bg-surface-2 p-2">
              {servers.length === 0 && (
                <span className="text-2xs text-muted">nenhum cadastrado</span>
              )}

              {servers.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chosen.includes(id)}
                    disabled={busy}
                    onChange={(event) =>
                      setChosen(
                        event.target.checked
                          ? [...chosen, id]
                          : chosen.filter((server) => server !== id),
                      )
                    }
                  />
                  {id}
                </label>
              ))}
            </div>
            {chosen.length === 0 && (
              <p className="mt-1 text-2xs text-amber">
                Sem servidor nenhum, o kit não aparece em lugar algum.
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <Label>Itens</Label>
          {/* O slot é guardado, mas não vale para a entrega da loja:
              o comando que entrega a um jogador conectado põe tudo
              no inventário. O editor diz isso. */}
          <LoadoutEditor items={items} onChange={setItems} disabled={busy} slotApplies={false} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-3">
            <Toggle
              on={enabled}
              busy={busy}
              labels={['No ar', 'Fora do ar']}
              onChange={setEnabled}
            />
            <span className="max-w-72 text-2xs leading-relaxed text-muted">
              Fora do ar, o kit some da loja e o histórico de resgates fica.
            </span>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancelar
            </Button>

            <Button
              variant="primary"
              disabled={busy || slug.trim() === '' || name.trim() === ''}
              onClick={() => void submit()}
            >
              {busy ? 'Gravando…' : 'Gravar'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** "Kit Inicial" -> "kit-inicial". */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** 1990 -> "19,90". */
function centsToInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * "19,90" -> 1990.
 *
 * O arredondamento é no FIM, e não durante: `19.9 * 100` dá
 * 1989.9999… em ponto flutuante, e um centavo perdido por kit é o
 * tipo de erro que só aparece na conciliação do mês.
 */
function inputToCents(value: string): number {
  const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));

  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}
