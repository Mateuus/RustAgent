'use client';

// ============================================================
//  server-menu-panel.tsx  -  a aba Menu de um servidor.
//
//  ####  ELA SÓ EXISTE COM UMA INTERFACE ESCOLHIDA  ####
//
//  E isso é o desenho, não um acidente: as páginas que ela lista
//  são as telas do documento que ESTE servidor usa. Sem documento
//  não há páginas.
//
//  ------------------------------------------------------------
//  ####  O QUE É DESENHO E O QUE É CONFIGURAÇÃO  ####
//
//  São coisas diferentes, e ficam em lugares diferentes de
//  propósito:
//
//    o DESENHO      onde o botão fica, de que cor, com que texto
//                   -> Interface, na barra lateral (vale para a
//                      rede inteira)
//
//    o QUE APARECE  quais páginas ESTE servidor mostra
//                   -> aqui
//
//    o CONTEÚDO     os itens da loja, os kits que dá para pegar
//                   -> aqui, uma seção por página
//
//  Misturar os três numa tela só faria editar a cor de um botão
//  parecer configuração de servidor — e ela vale para os seis.
// ============================================================

import { Eye, EyeOff, LayoutTemplate, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, ApiError, type ServerUiBinding } from '@/lib/api';
import { toast } from '@/lib/toast';
import { countElements, type UiDocument, type UiScreen } from '@/lib/ui-doc/model';
import { cn } from '@/lib/utils';

export function ServerMenuPanel({ serverId }: { readonly serverId: string }) {
  const [binding, setBinding] = useState<ServerUiBinding | null>(null);
  const [document, setDocument] = useState<UiDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.serverUi(serverId);

      setBinding(response.binding);
      setError(null);

      if (response.binding === null) {
        setDocument(null);
        return;
      }

      const detail = await agent.uiDocument(response.binding.documentId);

      setDocument(detail.document.document as UiDocument);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const aplicar = async (): Promise<void> => {
    setEnviando(true);

    try {
      const response = await agent.pushServerUi(serverId);

      toast.success(`Menu aplicado no jogo: ${String(response.bytes)} bytes.`);
      await load();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setEnviando(false);
    }
  };

  if (error !== null) {
    return (
      <StateBlock variant="error" title="Não consegui ler o menu deste servidor" detail={error} />
    );
  }

  if (binding === null || document === null) {
    return (
      <StateBlock
        variant="empty"
        title="Este servidor não usa nenhum menu"
        detail="Escolha a interface em Configurações → Interface. O desenho é da rede: um documento só, que todos os servidores podem usar."
      />
    );
  }

  // Só as PÁGINAS: os modais não são navegáveis pelo menu, e
  // listá-los aqui faria a aba prometer configuração para uma tela
  // que ninguém abre.
  const pages = document.screens.filter((screen) => screen.kind === 'page');
  const current = pages.find((screen) => screen.id === (screenId ?? '')) ?? pages[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface px-3 py-2">
        <span className="flex items-center gap-2 text-2xs">
          <LayoutTemplate aria-hidden="true" className="h-4 w-4 text-muted" />
          <span className="font-condensed font-bold uppercase tracking-wide text-foreground">
            {document.name}
          </span>
          <span className="font-mono text-muted">/{document.command}</span>
          <span className="text-muted">· {String(pages.length)} páginas</span>
        </span>

        <Button size="sm" disabled={enviando} onClick={() => void aplicar()}>
          <Send aria-hidden="true" className="h-4 w-4" />
          Aplicar no jogo
        </Button>
      </div>

      {/* As páginas do menu, na ordem em que aparecem no jogo. */}
      <nav className="flex flex-wrap gap-1 border-b border-border pb-2">
        {pages.map((screen) => {
          const hidden = binding.hidden.includes(screen.id);
          const active = current?.id === screen.id;

          return (
            <button
              key={screen.id}
              type="button"
              onClick={() => setScreenId(screen.id)}
              className={cn(
                'flex items-center gap-2 border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                active
                  ? 'border-rust bg-surface-2 text-foreground'
                  : 'border-border text-muted hover:text-foreground',
                hidden && 'line-through opacity-60',
              )}
              title={hidden ? 'Escondida neste servidor' : undefined}
            >
              {screen.name}
            </button>
          );
        })}
      </nav>

      {current !== null && (
        <PageConfig
          screen={current}
          isEntry={current.id === document.entryScreenId}
          hidden={binding.hidden.includes(current.id)}
          onToggle={() => void alternar(current.id)}
        />
      )}
    </div>
  );
}

/**
 * A configuração de UMA página do menu.
 *
 * ####  O QUE ENTRA AQUI, E O QUE NÃO  ####
 *
 * O que entra é o CONTEÚDO daquela página — os itens da loja, os
 * kits que dá para pegar. Cada um deles é servido por um módulo
 * próprio do agente, e cada módulo põe a seção dele aqui.
 *
 * O que NÃO entra é o desenho: mover um botão ou trocar uma cor
 * vale para a rede inteira, e o lugar disso é o editor. Repetir
 * essa edição por servidor faria seis cópias do mesmo menu.
 */
function PageConfig({
  screen,
  isEntry,
  hidden,
  onToggle,
}: {
  screen: UiScreen;
  isEntry: boolean;
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-condensed text-sm font-bold uppercase tracking-wide text-foreground">
            {screen.name}
          </p>
          <p className="text-2xs text-muted">
            <span className="font-mono">{screen.id}</span> ·{' '}
            {String(countElements(screen.elements))} elementos no desenho
          </p>
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={onToggle}
          disabled={isEntry}
          title={
            isEntry
              ? 'É a página que abre. Escondê-la deixaria o menu sem o que mostrar.'
              : hidden
                ? 'Mostrar esta página neste servidor'
                : 'Esconder esta página neste servidor. O desenho continua o mesmo para os outros.'
          }
        >
          {hidden ? (
            <>
              <EyeOff aria-hidden="true" className="h-4 w-4" />
              Escondida aqui
            </>
          ) : (
            <>
              <Eye aria-hidden="true" className="h-4 w-4" />
              Visível aqui
            </>
          )}
        </Button>
      </div>

      {/* ####  O LUGAR DA CONFIGURAÇÃO DE CADA PÁGINA  ####

          Hoje nenhuma página tem conteúdo servido pelo agente: o
          que elas mostram é o desenho, e o desenho se edita em
          Interface.

          A loja e os kits são construídos em paralelo, e é AQUI
          que a seção de cada um entra — uma por página, ao lado
          deste aviso. Deixar o lugar nomeado e vazio é melhor que
          inventar uma tela que promete o que ainda não existe. */}
      <div className="border border-border bg-surface p-4">
        <p className="text-2xs leading-relaxed text-muted">
          O <strong>conteúdo</strong> desta página vem do desenho — o que está escrito e desenhado
          nela. Para mudá-lo, abra <strong>Interface</strong> na barra lateral: o desenho vale para a
          rede inteira, e é por isso que ele não se edita por servidor.
        </p>

        <p className="mt-2 text-2xs leading-relaxed text-muted">
          Páginas que o agente PREENCHE — a loja com os itens à venda, os kits que dá para pegar —
          ganham a configuração delas aqui, nesta mesma aba, quando esses módulos existirem.
        </p>
      </div>
    </div>
  );
}
