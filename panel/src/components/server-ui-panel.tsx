'use client';

// ============================================================
//  server-ui-panel.tsx  -  Configurações → Interface.
//
//  ####  AQUI NÃO SE DESENHA NADA  ####
//
//  O desenho é da REDE e mora em /interface. Esta aba responde a
//  três perguntas que são DESTE servidor:
//
//      qual menu ele usa
//      o que ele esconde do menu
//      a versão que está no jogo bate com a do agente?
//
//  Uma interface por servidor faria seis cópias do mesmo menu; um
//  documento só, sem escolha por servidor, faria o PVE anunciar a
//  loja que ele não tem. `hidden` é o meio-termo, e ele é o que
//  esta tela edita.
//
//  ####  APLICAR É SÍNCRONO, E DIZ O QUE ACONTECEU  ####
//
//  Quem clicou está olhando: a diferença entre "servidor parado",
//  "carga acima do teto do RCON" e "o servidor recusou" é
//  exatamente o que ele precisa ler — e as três frases nascem no
//  agente, que conhece a regra.
// ============================================================

import { Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, ApiError, type ServerUiBinding } from '@/lib/api';
import { formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { walkElements, type UiDocument, type UiElement } from '@/lib/ui-doc/model';
import { cn } from '@/lib/utils';

interface DocumentOption {
  id: number;
  slug: string;
  name: string;
  command: string;
  revision: number;
  screens: number;
}

export function ServerUiPanel({ serverId }: { readonly serverId: string }) {
  const [binding, setBinding] = useState<ServerUiBinding | null>(null);
  const [documents, setDocuments] = useState<DocumentOption[] | null>(null);
  /** O documento escolhido, para listar o que dá para esconder. */
  const [document, setDocument] = useState<UiDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.serverUi(serverId);

      setBinding(response.binding);
      setDocuments(response.documents);
      setError(null);

      if (response.binding === null) {
        setDocument(null);
        return;
      }

      // O documento inteiro só é lido quando há um escolhido: é ele
      // que dá os NOMES dos pedaços, e uma lista de ids crus não
      // diria a ninguém o que está desligando.
      const detail = await agent.uiDocument(response.binding.documentId);

      setDocument(detail.document.document as UiDocument);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const escolher = async (documentId: number | null): Promise<void> => {
    try {
      // Trocar de menu zera o que estava escondido: os ids são de
      // OUTRO desenho, e mantê-los esconderia elementos por
      // coincidência de nome.
      await agent.setServerUi(serverId, { documentId, enabled: true, hidden: [] });
      await load();

      toast.success(documentId === null ? 'Este servidor ficou sem menu.' : 'Menu escolhido.');
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const alternar = async (id: string): Promise<void> => {
    if (binding === null) {
      return;
    }

    const hidden = binding.hidden.includes(id)
      ? binding.hidden.filter((entry) => entry !== id)
      : [...binding.hidden, id];

    try {
      await agent.setServerUi(serverId, {
        documentId: binding.documentId,
        enabled: binding.enabled,
        hidden,
      });

      await load();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const ligar = async (enabled: boolean): Promise<void> => {
    if (binding === null) {
      return;
    }

    try {
      await agent.setServerUi(serverId, {
        documentId: binding.documentId,
        enabled,
        hidden: [...binding.hidden],
      });

      await load();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    }
  };

  const aplicar = async (): Promise<void> => {
    setEnviando(true);

    try {
      const response = await agent.pushServerUi(serverId);

      toast.success(
        `Interface aplicada: ${String(response.documents)} documento(s), ` +
          `${String(response.bytes)} bytes.`,
      );

      await load();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setEnviando(false);
    }
  };

  if (error !== null) {
    return (
      <StateBlock
        variant="error"
        title="Não consegui ler a interface deste servidor"
        detail={error}
      />
    );
  }

  if (documents === null) {
    return <StateBlock variant="loading" title="Lendo…" />;
  }

  if (documents.length === 0) {
    return (
      <StateBlock
        variant="empty"
        title="Nenhuma interface existe ainda"
        detail="O desenho é da rede: crie o Menu Principal em Interface, na barra lateral, e volte aqui para escolhê-lo neste servidor."
      />
    );
  }

  const chosen = documents.find((item) => item.id === binding?.documentId) ?? null;
  const atrasado =
    binding !== null &&
    chosen !== null &&
    (binding.appliedRevision === null || binding.appliedRevision < chosen.revision);

  return (
    <div className="space-y-4">
      <Section title="Qual menu este servidor usa">
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="block font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
              Interface
            </span>
            <select
              value={binding === null ? '' : String(binding.documentId)}
              onChange={(event) =>
                void escolher(event.target.value === '' ? null : Number(event.target.value))
              }
              className="w-full border border-border bg-surface-2 px-2 py-2 text-sm text-foreground"
            >
              <option value="">nenhum menu neste servidor</option>
              {documents.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name} (/{item.command}) — {String(item.screens)} telas
                </option>
              ))}
            </select>
          </label>

          {binding !== null && chosen !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface-2 px-3 py-2">
              <div className="text-2xs">
                <p className="text-muted">
                  No agente:{' '}
                  <span className="text-foreground">revisão {String(chosen.revision)}</span>
                  {' · '}
                  No jogo:{' '}
                  <span className={cn(atrasado ? 'text-rust' : 'text-foreground')}>
                    {binding.appliedRevision === null
                      ? 'nunca aplicada'
                      : `revisão ${String(binding.appliedRevision)}`}
                  </span>
                  {binding.appliedAt !== null && ` (${formatWhen(binding.appliedAt)})`}
                </p>

                {atrasado && (
                  <p className="mt-1 text-rust">
                    O que está no jogo é mais antigo que o desenho do agente. Aplique para igualar.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void ligar(!binding.enabled)}
                  title={
                    binding.enabled
                      ? 'Desligar mantém a escolha e o que está escondido — ele só deixa de ser empurrado.'
                      : 'Voltar a empurrar este menu para o servidor.'
                  }
                >
                  {binding.enabled ? 'Desligar' : 'Ligar'}
                </Button>

                <Button size="sm" disabled={enviando} onClick={() => void aplicar()}>
                  <Send aria-hidden="true" className="h-4 w-4" />
                  Aplicar agora
                </Button>
              </div>
            </div>
          )}
        </div>
      </Section>

      {document !== null && binding !== null && (
        <Section title="O que este servidor esconde">
          <div className="space-y-3">
            <p className="text-2xs leading-relaxed text-muted">
              O desenho é o mesmo para a rede inteira; o que muda aqui é o que ESTE servidor mostra
              dele. Um PVE sem loja esconde o botão e a tela — sem uma segunda cópia do menu para
              manter em dia.
            </p>

            <div>
              <p className="mb-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                Telas
              </p>
              <div className="flex flex-wrap gap-1">
                {document.screens.map((screen) => (
                  <Toggle
                    key={screen.id}
                    id={screen.id}
                    label={screen.name}
                    hidden={binding.hidden.includes(screen.id)}
                    // A tela de entrada não some nem se marcada: o
                    // menu ficaria sem o que abrir. O agente a
                    // preserva, e desabilitar aqui é dizer isso
                    // antes de alguém tentar.
                    locked={screen.id === document.entryScreenId}
                    onToggle={() => void alternar(screen.id)}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                Botões do cabeçalho
              </p>
              <div className="flex flex-wrap gap-1">
                {shellButtons(document.shell).map((element) => (
                  <Toggle
                    key={element.id}
                    id={element.id}
                    label={element.name}
                    hidden={binding.hidden.includes(element.id)}
                    locked={false}
                    onToggle={() => void alternar(element.id)}
                  />
                ))}
              </div>
            </div>

            <p className="text-2xs leading-relaxed text-muted">
              Esconder uma tela NÃO esconde o botão que leva a ela — esconda os dois. O plugin
              recusa navegar para uma tela que não conhece, então o clique não faria nada.
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}

/** Os botões do shell, que são o que faz sentido esconder. */
function shellButtons(shell: readonly UiElement[]): readonly UiElement[] {
  const buttons: UiElement[] = [];

  for (const { element } of walkElements(shell)) {
    if (element.type === 'button') {
      buttons.push(element);
    }
  }

  return buttons;
}

function Toggle({
  id,
  label,
  hidden,
  locked,
  onToggle,
}: {
  id: string;
  label: string;
  hidden: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={locked}
      aria-pressed={!hidden}
      onClick={onToggle}
      title={
        locked
          ? 'É a tela de entrada: sem ela o menu não abriria. Ela continua visível mesmo escondida.'
          : hidden
            ? `${id} — escondido neste servidor. Clique para mostrar.`
            : `${id} — visível. Clique para esconder neste servidor.`
      }
      className={cn(
        'border px-2 py-1 font-condensed text-2xs font-bold uppercase tracking-wide',
        locked
          ? 'cursor-not-allowed border-border text-muted opacity-50'
          : hidden
            ? 'border-border text-muted line-through hover:text-foreground'
            : 'border-olive bg-surface-2 text-foreground',
      )}
    >
      {label}
    </button>
  );
}
