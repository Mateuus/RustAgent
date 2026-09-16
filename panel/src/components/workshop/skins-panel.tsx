'use client';

// ============================================================
//  skins-panel.tsx  -  o catálogo de skins, e o que se faz nele.
//
//  ####  TABELA, E NÃO CARTÃO  ####
//
//  Pela mesma razão da lista de itens nossos: é uma tela de
//  COMPARAÇÃO. A pergunta que se faz aqui é "qual item já tem skin,
//  e em que servidores?" — e ela se responde varrendo uma coluna de
//  cima a baixo, não lendo cartão por cartão.
//
//  ####  O CATÁLOGO É DA REDE  ####
//
//  Não há seletor de servidor no topo desta tela, e isso é
//  deliberado: a skin é cadastrada uma vez para a rede inteira. A
//  coluna "Servidores" é a única coisa que varia — e por isso ela é
//  editável ali mesmo, pela rota que troca só a lista, sem reenviar
//  o formulário inteiro.
//
//  ####  O QUE O AGENTE MANDA, A TELA NÃO CONFERE  ####
//
//  Um campo que o agente omitir vira TypeError no render e derruba
//  a página inteira com "This page couldn't load". É por isso que
//  toda resposta passa pelo `safeSkin` antes de chegar ao JSX.
// ============================================================

import { Plus, Trash2, Video } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ItemIcon } from '@/components/item-icon';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Toggle } from '@/components/ui/toggle';
import { ServerPicker, type WorkshopServerOption } from '@/components/workshop/server-picker';
import { SkinForm, blankSkin } from '@/components/workshop/skin-form';
import { agent, ApiError, type WorkshopSkin, type WorkshopSkinInput } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface SkinsPanelProps {
  readonly servers: readonly WorkshopServerOption[];
  /** Para o cabeçalho da página dizer quantas são. */
  readonly onCount?: (total: number) => void;
}

/** A skin que está sendo criada ou editada. `null` = nenhuma. */
interface Editing {
  readonly value: WorkshopSkinInput;
  /** Ausente = é uma skin nova. */
  readonly skin?: WorkshopSkin;
}

/**
 * A resposta do agente, com todo campo com um padrão pronto.
 *
 * Nenhum destes `??` é decoração: eles são a diferença entre uma
 * célula vazia e a página inteira caindo. E o `skinId` passa por
 * `String` porque ele é o UInt64 do jogo — se algum dia chegar como
 * número, ele já veio errado, mas pelo menos a tela não o
 * arredonda de novo.
 */
function safeSkin(skin: WorkshopSkin): WorkshopSkin {
  return {
    id: Number(skin.id),
    label: skin.label ?? '',
    shortname: skin.shortname ?? '',
    skinId: String(skin.skinId ?? ''),
    permission: skin.permission ?? '',
    hideInStreamer: skin.hideInStreamer === true,
    enabled: skin.enabled === true,
    servers: Array.isArray(skin.servers) ? [...skin.servers] : [],
    createdAt: skin.createdAt ?? '',
    updatedAt: skin.updatedAt ?? '',
  };
}

/** O que o formulário recebe quando se abre uma skin já gravada. */
function toInput(skin: WorkshopSkin): WorkshopSkinInput {
  return {
    label: skin.label,
    shortname: skin.shortname,
    skinId: skin.skinId,
    permission: skin.permission,
    hideInStreamer: skin.hideInStreamer,
    enabled: skin.enabled,
    servers: [...skin.servers],
  };
}

export function SkinsPanel({ servers, onCount }: SkinsPanelProps) {
  const [skins, setSkins] = useState<readonly WorkshopSkin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  /** A recusa da última gravação. Mostrada DENTRO do formulário. */
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  /** A skin cuja lista de servidores está aberta na tabela. */
  const [openServers, setOpenServers] = useState<number | null>(null);
  const [serversDraft, setServersDraft] = useState<readonly string[]>([]);
  const [serversBusy, setServersBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.workshopSkins();
      const list = (response.skins ?? []).map(safeSkin);

      setSkins(list);
      onCount?.(list.length);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSkins([]);
    }
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(value: WorkshopSkinInput): Promise<void> {
    if (editing === null) return;

    setSaving(true);
    setSaveError(null);

    try {
      if (editing.skin === undefined) {
        await agent.createWorkshopSkin(value);
        toast.success('Skin cadastrada', { description: value.label });
      } else {
        await agent.updateWorkshopSkin(editing.skin.id, value);
        toast.success('Skin salva', { description: value.label });
      }

      setEditing(null);
      await load();
    } catch (cause) {
      // A recusa fica NO FORMULÁRIO: ela é um conflito com outra
      // linha do catálogo, e a saída exige mexer num campo. Um
      // toast some antes de a pessoa terminar de ler.
      setSaveError(
        cause instanceof ApiError
          ? cause
          : new ApiError('', cause instanceof Error ? cause.message : String(cause), 0),
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove(skin: WorkshopSkin): Promise<void> {
    try {
      await agent.removeWorkshopSkin(skin.id);
      toast.success(`"${skin.label}" apagada.`);
      await load();
    } catch (cause) {
      toast.error('Não consegui apagar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function toggleEnabled(skin: WorkshopSkin): Promise<void> {
    try {
      await agent.updateWorkshopSkin(skin.id, { ...toInput(skin), enabled: !skin.enabled });
      await load();
    } catch (cause) {
      // Ligar uma skin pode ser RECUSADO: o item já pode ter outra
      // ligada nos mesmos servidores. A frase do agente diz qual, e
      // a nossa não saberia.
      toast.error('Não consegui mudar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function saveServers(skin: WorkshopSkin): Promise<void> {
    setServersBusy(true);

    try {
      await agent.setWorkshopSkinServers(skin.id, serversDraft);
      toast.success('Servidores salvos', { description: skin.label });
      setOpenServers(null);
      await load();
    } catch (cause) {
      toast.error('Não consegui salvar os servidores', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setServersBusy(false);
    }
  }

  function openForm(skin: WorkshopSkin | null): void {
    setSaveError(null);
    setOpenServers(null);
    setEditing(
      skin === null ? { value: blankSkin() } : { value: toInput(skin), skin },
    );
  }

  const serverName = (id: string): string =>
    servers.find((server) => server.id === id)?.name ?? id;

  if (error !== null && skins !== null && skins.length === 0) {
    return <StateBlock variant="error" title="Não consegui ler o catálogo de skins" detail={error} />;
  }

  if (skins === null) return <StateBlock variant="loading" title="Lendo as skins…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-2xs leading-relaxed text-muted">
          Uma skin <strong>não é um item novo</strong>: é a aparência de um item que o Rust já tem.
          O jogador não aplica nada e não há menu — <strong>o item já nasce com ela</strong> na mão
          de quem tiver a permissão.
        </p>

        <Button size="sm" onClick={() => openForm(null)}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Nova skin
        </Button>
      </div>

      {editing !== null && (
        <SkinForm
          key={editing.skin?.id ?? 'nova'}
          value={editing.value}
          {...(editing.skin === undefined ? {} : { skin: editing.skin })}
          servers={servers}
          busy={saving}
          error={saveError}
          onSave={(value) => void save(value)}
          onCancel={() => {
            setEditing(null);
            setSaveError(null);
          }}
        />
      )}

      {skins.length === 0 ? (
        <StateBlock
          variant="empty"
          title="Nenhuma skin cadastrada"
          detail="Comece por Nova skin: escolha o item do jogo, cole o número da arte publicada no Workshop e diga em quais servidores ela vale."
        />
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <HeaderCell className="w-12">
                  <span className="sr-only">Ícone</span>
                </HeaderCell>
                <HeaderCell>Nome</HeaderCell>
                <HeaderCell>Item do jogo</HeaderCell>
                <HeaderCell>Número da skin</HeaderCell>
                <HeaderCell>Permissão</HeaderCell>
                <HeaderCell>Streamer</HeaderCell>
                <HeaderCell>Servidores</HeaderCell>
                <HeaderCell className="text-right">
                  <span className="sr-only">Ações</span>
                </HeaderCell>
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              {skins.map((skin) => (
                <SkinRows
                  key={skin.id}
                  skin={skin}
                  servers={servers}
                  serverName={serverName}
                  open={openServers === skin.id}
                  draft={serversDraft}
                  busy={serversBusy}
                  onOpenServers={() => {
                    setOpenServers(skin.id);
                    setServersDraft([...skin.servers]);
                  }}
                  onCloseServers={() => setOpenServers(null)}
                  onDraftChange={setServersDraft}
                  onSaveServers={() => void saveServers(skin)}
                  onEdit={() => openForm(skin)}
                  onToggle={() => void toggleEnabled(skin)}
                  onRemove={() => void remove(skin)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ####  AS DUAS COISAS QUE MORDEM DEPOIS  ####
          Nenhuma das duas aparece no cadastro, e as duas viram
          chamado de jogador. */}
      <div className="space-y-2 border border-border bg-surface-2 p-3 text-2xs leading-relaxed text-muted">
        <p>
          <strong className="text-foreground">Skin diferente não empilha.</strong> Um item com skin
          não junta com o mesmo item sem skin: quem tem a permissão pode acabar com duas pilhas de
          pedra na mochila, e isso é normal — é o jogo, não o cadastro.
        </p>
        <p>
          <strong className="text-foreground">
            A arte precisa estar publicada no Steam Workshop.
          </strong>{' '}
          O servidor guarda só o número e nunca vê o modelo: quem baixa a arte é o cliente de cada
          jogador. Número que não corresponde a nada publicado não dá erro em lugar nenhum — o item
          nasce com a cara normal e ninguém é avisado.
        </p>
      </div>
    </div>
  );
}

interface SkinRowsProps {
  readonly skin: WorkshopSkin;
  readonly servers: readonly WorkshopServerOption[];
  readonly serverName: (id: string) => string;
  readonly open: boolean;
  readonly draft: readonly string[];
  readonly busy: boolean;
  readonly onOpenServers: () => void;
  readonly onCloseServers: () => void;
  readonly onDraftChange: (servers: string[]) => void;
  readonly onSaveServers: () => void;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}

function SkinRows({
  skin,
  servers,
  serverName,
  open,
  draft,
  busy,
  onOpenServers,
  onCloseServers,
  onDraftChange,
  onSaveServers,
  onEdit,
  onToggle,
  onRemove,
}: SkinRowsProps) {
  return (
    <>
      <tr className={cn('hover:bg-surface-2', !skin.enabled && 'opacity-60')}>
        <td className="py-1 pl-3 pr-0">
          {/* O ícone é o do item BASE: a nossa arte só existe no
              Workshop do Steam, e o painel não tem como desenhá-la. */}
          <ItemIcon shortname={skin.shortname} />
        </td>

        <td className="px-3 py-2">
          <span className="text-foreground">{skin.label}</span>

          {!skin.enabled && (
            <span
              className="ml-2 border border-muted px-1.5 py-0.5 font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
              title="Desligada: o item volta a nascer normal. O cadastro e o número continuam aqui."
            >
              desligada
            </span>
          )}
        </td>

        <td className="px-3 py-2">
          <span className="font-mono text-2xs text-muted">{skin.shortname}</span>
        </td>

        <td className="px-3 py-2">
          {/* Texto, e nada de formatação de milhar: são vinte
              dígitos que precisam ser conferidos contra a URL da
              oficina, um a um. */}
          <span className="font-mono text-2xs text-foreground">{skin.skinId}</span>
        </td>

        <td className="px-3 py-2">
          <span className="font-mono text-2xs text-muted">{skin.permission}</span>
        </td>

        <td className="px-3 py-2 text-2xs text-muted">
          {skin.hideInStreamer ? (
            <span
              className="flex items-center gap-1"
              title="Quem está em modo streamer recebe o item SEM a skin. Ela continua aparecendo nos itens dos outros jogadores."
            >
              <Video aria-hidden="true" className="h-3.5 w-3.5" />
              esconde
            </span>
          ) : (
            'mostra'
          )}
        </td>

        <td className="px-3 py-2 text-2xs">
          <button
            type="button"
            onClick={open ? onCloseServers : onOpenServers}
            className="text-left underline decoration-dotted underline-offset-2 hover:text-foreground"
            title="Trocar só em quais servidores esta skin vale"
          >
            {skin.servers.length === 0 ? (
              <span className="text-rust">nenhum</span>
            ) : (
              <span className="text-muted">{skin.servers.map(serverName).join(', ')}</span>
            )}
          </button>
        </td>

        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-2">
            <Toggle
              on={skin.enabled}
              busy={false}
              onChange={onToggle}
              labels={['valendo', 'desligada']}
              label="Esta skin está valendo?"
            />

            <Button size="sm" variant="outline" onClick={onEdit}>
              Editar
            </Button>

            {/* Apagar é diferente de desligar, e o `hint` é onde
                essa diferença aparece na hora em que ela importa. */}
            <ConfirmButton
              variant="danger"
              disabled={false}
              icon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
              label="Apagar"
              confirmLabel="Apagar mesmo"
              hint="Some do catálogo. O que já nasceu no mundo continua com o número carimbado. Para só tirar de circulação, desligue."
              onConfirm={onRemove}
            />
          </div>
        </td>
      </tr>

      {open && (
        <tr className="bg-surface-2">
          <td colSpan={8} className="px-3 py-3">
            <p className="mb-2 font-condensed text-2xs uppercase tracking-wide text-muted">
              Em quais servidores “{skin.label}” vale
            </p>

            <ServerPicker
              value={draft}
              servers={servers}
              busy={busy}
              onChange={onDraftChange}
            />

            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={onSaveServers}>
                Salvar servidores
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onCloseServers}>
                Cancelar
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function HeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted',
        className,
      )}
    >
      {children}
    </th>
  );
}
