'use client';

// ============================================================
//  kit-dialog.tsx  -  criar e editar um kit.
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
//      resgate    uma vez por jogador, para sempre
//      uso        N vezes por jogador, e elas podem voltar no wipe
//      cooldown   de N em N horas
//
//  As duas primeiras são o MESMO tipo no agente, com o limite
//  valendo 1 ou N. Ver `KitMode`.
//
//  ####  KIT NÃO SE COMPRA  ####
//
//  Existiu um terceiro tipo, com preço em centavos. Ele saiu: o que
//  se vende na rede está na LOJA, com vitrine, categoria e carteira.
//  Duas vitrines — uma delas escondida num formulário — discordam no
//  primeiro ajuste de preço.
//
//  ####  O NÍVEL DE VIP TEM DOIS SENTIDOS  ####
//
//  Por padrão ele é um PISO: aquele nível, ou um mais alto. Marcado
//  como exclusivo, ele vira igualdade — e aí o kit é a recompensa
//  daquele nível, que ninguém acima leva junto.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { itemsProblem, LoadoutEditor } from '@/components/loadout-editor';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  kitIconUrl,
  type Kit,
  type KitKind,
  type KitUseReset,
  type LoadoutItem,
  type VipTier,
} from '@/lib/api';
import { toIconFile } from '@/lib/icon-image';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * As três abas da tela.
 *
 * ####  E SÓ DUAS DELAS SÃO UM `kind`  ####
 *
 * "Resgate único" e "Uso" são o MESMO tipo no agente (`resgate`):
 * um limite de 1 e um limite de N. A aba separa as duas porque a
 * pergunta de quem configura é outra — "uma vez e pronto" não é a
 * mesma decisão que "dez usos, que voltam no wipe".
 */
type KitMode = 'resgate' | 'uso' | 'cooldown';

const MODES: readonly { value: KitMode; label: string; hint: string }[] = [
  { value: 'resgate', label: 'Resgate único', hint: 'uma vez por jogador, para sempre' },
  {
    value: 'uso',
    label: 'Uso',
    hint: 'um número de vezes por jogador — e eles podem voltar no wipe',
  },
  { value: 'cooldown', label: 'Cooldown', hint: 'de tempos em tempos' },
];

/** Quando a conta de usos zera. Os valores são os do agente. */
const USE_RESETS: readonly { value: KitUseReset; label: string; hint: string }[] = [
  { value: 'never', label: 'Nunca', hint: 'o que ele gastou, gastou — vale para sempre' },
  {
    value: 'wipe',
    label: 'A cada wipe',
    hint: 'a conta zera no wipe do servidor. A hora vem do servidor — se ele não responder, a conta NÃO zera',
  },
  {
    value: 'full-wipe',
    label: 'Só no full wipe',
    hint: 'zera só no wipe que leva os blueprints. O agente conhece os full wipes que ELE conduziu — nenhum registrado, nada zera',
  },
];

/** O modo em que este kit abre. Ver `KitMode`. */
function modeOf(kit: Kit | null): KitMode {
  if (kit === null) {
    return 'resgate';
  }

  if (kit.kind === 'cooldown') {
    return 'cooldown';
  }

  return (kit.useLimit ?? 1) > 1 || kit.useResetOn !== 'never' ? 'uso' : 'resgate';
}

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

  /**
   * A arte propria do card. `null` = o desenho padrao.
   *
   * Sem ela o card mostra o icone do PRIMEIRO item do kit -- um
   * palpite honesto, e o que todo kit gravado antes disto faz. Mas
   * "Kit Inicial" nao e uma pedra.
   */
  const [iconFile, setIconFile] = useState<string | null>(kit?.iconFile ?? null);
  const [enviandoArte, setEnviandoArte] = useState(false);
  const [arteSummary, setArteSummary] = useState<string | null>(null);

  /** A previa do arquivo escolhido. Revogada ao trocar e ao fechar. */
  const [artePreview, setArtePreview] = useState<string | null>(null);
  const artePreviewRef = useRef<string | null>(null);

  const showArtePreview = useCallback((file: File | null): void => {
    const previous = artePreviewRef.current;
    const next = file === null ? null : URL.createObjectURL(file);

    artePreviewRef.current = next;
    setArtePreview(next);

    if (previous !== null) {
      URL.revokeObjectURL(previous);
    }
  }, []);

  useEffect(() => {
    return () => {
      showArtePreview(null);
    };
  }, [showArtePreview]);

  const arteSrc = artePreview ?? (iconFile === null ? null : kitIconUrl(iconFile));
  const [category, setCategory] = useState(kit?.category ?? '');
  // Em HORAS na tela, em segundos no banco: quem administra pensa em
  // "duas horas depois do wipe", não em 7200.
  const [wipeHours, setWipeHours] = useState(
    kit?.wipeDelaySeconds === null || kit?.wipeDelaySeconds === undefined
      ? ''
      : String(Math.round(kit.wipeDelaySeconds / 3600)),
  );
  const [mode, setMode] = useState<KitMode>(modeOf(kit));
  const [useLimit, setUseLimit] = useState(Math.max(1, kit?.useLimit ?? 10));
  const [useResetOn, setUseResetOn] = useState<KitUseReset>(kit?.useResetOn ?? 'never');
  const [hours, setHours] = useState(
    kit?.cooldownSeconds === null || kit?.cooldownSeconds === undefined
      ? 24
      : Math.max(1, Math.round(kit.cooldownSeconds / 3600)),
  );
  const [requiredTier, setRequiredTier] = useState(kit?.requiredTier ?? '');
  const [requiredTierExact, setRequiredTierExact] = useState(kit?.requiredTierExact ?? false);
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

  /**
   * Reduz a arte no navegador e a envia.
   *
   * O agente recusa acima de ~33 KB, e a arte que alguém exporta tem
   * megabytes. Quem reduz é a tela, pelo mesmo motivo do cadastro de
   * item custom e da oferta da loja — e com o mesmo `toIconFile`.
   */
  async function enviarArte(file: File): Promise<void> {
    setEnviandoArte(true);

    try {
      const resized = await toIconFile(file);

      showArtePreview(resized.file);
      setArteSummary(resized.summary);

      const response = await agent.uploadKitIcon(resized.file);

      setIconFile(response.icon.name);

      toast.success('Arte enviada', { description: response.icon.name });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      // A prévia cai junto: deixá-la na tela depois de o envio falhar
      // faria parecer que a arte está valendo.
      showArtePreview(null);
      setArteSummary(null);

      toast.error('Não consegui enviar a arte', { description: message });
    } finally {
      setEnviandoArte(false);
    }
  }

  async function submit(): Promise<void> {
    const problem = itemsProblem(items);

    if (problem !== null) {
      toast.error('Confira os itens', { description: problem });
      return;
    }

    // A aba "Uso" e a "Resgate único" são o mesmo `kind` no agente:
    // a diferença entre elas é o LIMITE. Ver `KitMode`.
    const kind: KitKind = mode === 'cooldown' ? 'cooldown' : 'resgate';

    const body = {
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      iconFile,
      category: category.trim() === '' ? null : category.trim(),
      wipeDelaySeconds:
        wipeHours.trim() === '' ? null : Math.max(1, Math.round(Number(wipeHours) * 3600)),
      kind,
      useLimit: mode === 'uso' ? Math.max(1, useLimit) : mode === 'resgate' ? 1 : null,
      useResetOn: mode === 'uso' ? useResetOn : 'never',
      cooldownSeconds: mode === 'cooldown' ? hours * 3600 : null,
      requiredTier: requiredTier === '' ? null : requiredTier,
      // Sem nível escolhido a exclusividade não quer dizer nada — e
      // o agente recusa a combinação. Aqui ela já sai zerada.
      requiredTierExact: requiredTier !== '' && requiredTierExact,
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

            {/* ####  O CARD TEM UM PALPITE, E ELE NEM SEMPRE SERVE  ####

                Sem arte, o card mostra o ícone do PRIMEIRO item do
                kit — um kit de sucata mostra sucata, e está ótimo.
                Mas "Kit Inicial" não é uma pedra, e quem monta o kit
                sabe que arte o representa. */}
            <div className="mt-3">
              <Label>Arte do card</Label>

              <div className="flex items-center gap-3 border border-border bg-surface-2 p-2">
                {arteSrc === null ? (
                  <p className="min-w-0 flex-1 text-2xs leading-relaxed text-muted">
                    Sem arte própria — o card usa o ícone do primeiro item do kit.
                  </p>
                ) : (
                  <>
                    {/* O <img> cru, e não o next/image: a imagem vem
                        do AGENTE, que não passa pelo otimizador. */}
                    <img
                      src={arteSrc}
                      alt=""
                      className="h-12 w-12 shrink-0 border border-border bg-surface object-contain"
                    />

                    <div className="min-w-0 flex-1 text-2xs leading-relaxed">
                      <p className="truncate font-mono text-foreground">{iconFile}</p>

                      {arteSummary !== null && (
                        <p className="mt-0.5 text-muted">Reduzida aqui: {arteSummary}.</p>
                      )}
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      disabled={busy || enviandoArte}
                      onClick={() => {
                        setIconFile(null);
                        showArtePreview(null);
                        setArteSummary(null);
                      }}
                    >
                      Tirar
                    </Button>
                  </>
                )}

                <label
                  className={cn(
                    'cursor-pointer border border-border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide text-foreground hover:bg-surface',
                    (busy || enviandoArte) && 'pointer-events-none opacity-60',
                  )}
                >
                  {enviandoArte ? 'Enviando…' : iconFile === null ? 'Enviar PNG' : 'Trocar'}
                  <input
                    type="file"
                    accept="image/png"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];

                      // O input é limpo sempre: sem isso, escolher o
                      // MESMO arquivo duas vezes seguidas não dispara
                      // o evento, e o segundo envio parece travado.
                      event.target.value = '';

                      if (file !== undefined) void enviarArte(file);
                    }}
                  />
                </label>
              </div>

              <p className="mt-1 text-2xs leading-relaxed text-muted">
                O painel reduz a imagem antes de enviar, e cada jogador a baixa uma vez.
              </p>
            </div>
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
            {MODES.map((option, index) => (
              <div key={option.value} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={mode === option.value}
                  disabled={busy}
                  onClick={() => setMode(option.value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    mode === option.value
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
            {MODES.find((option) => option.value === mode)?.hint}
          </p>
        </div>

        {mode === 'uso' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Quantos usos por jogador</Label>
              <Input
                type="number"
                min={1}
                max={10000}
                value={useLimit}
                disabled={busy}
                onChange={(event) => setUseLimit(Math.max(1, Number(event.target.value)))}
              />
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                Gastou os {String(Math.max(1, useLimit))}, o kit some para ele. Só as entregas que
                DERAM CERTO contam — uma tentativa que falhou não gasta uso.
              </p>
            </div>

            <div>
              <Label>Os usos voltam</Label>
              <select
                value={useResetOn}
                disabled={busy}
                onChange={(event) => setUseResetOn(event.target.value as KitUseReset)}
                className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
              >
                {USE_RESETS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                {USE_RESETS.find((option) => option.value === useResetOn)?.hint}
              </p>
            </div>
          </div>
        )}

        {mode === 'cooldown' && (
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
              onChange={(event) => {
                // Voltar para "qualquer um" desliga a exclusividade
                // junto: um checkbox marcado sem nível nenhum é uma
                // regra que não existe, e o agente recusa o corpo.
                if (event.target.value === '') {
                  setRequiredTierExact(false);
                }

                setRequiredTier(event.target.value);
              }}
              className="h-9 w-full border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              <option value="">Qualquer um</option>
              {tiers.map((tier) => (
                <option key={tier.tier} value={tier.tier}>
                  {tier.title ?? tier.tier}
                </option>
              ))}
            </select>

            <label
              className={cn(
                'mt-2 flex items-start gap-2 text-2xs leading-relaxed',
                requiredTier === '' && 'opacity-50',
              )}
            >
              <input
                type="checkbox"
                checked={requiredTierExact}
                disabled={busy || requiredTier === ''}
                onChange={(event) => setRequiredTierExact(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <strong className="text-foreground">Somente este nível</strong>
                <span className="block text-muted">
                  {requiredTier === ''
                    ? 'Escolha um nível para poder deixar o kit exclusivo dele.'
                    : requiredTierExact
                      ? `Só quem tem ${labelOf(tiers, requiredTier)} pega. Um nível MAIS ALTO não pega este kit.`
                      : 'Hoje quem tem um nível MAIS ALTO também pode.'}
                </span>
              </span>
            </label>
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

/**
 * O nome do nível como ele aparece no select.
 *
 * Sem a lista de tiers (o agente não respondeu), sobra o próprio
 * valor — que é o que está gravado no kit.
 */
function labelOf(tiers: readonly VipTier[], tier: string): string {
  return tiers.find((entry) => entry.tier === tier)?.title ?? tier;
}
