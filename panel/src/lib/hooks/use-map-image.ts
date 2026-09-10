'use client';

// ============================================================
//  use-map-image.ts  -  a imagem do mundo, baixada uma vez.
//
//  ####  ELE ERA DO admin-panel, E AGORA TEM DOIS DONOS  ####
//
//  O segundo é a tela que marca onde a masmorra nasce: escolher um
//  ponto sem ver o mapa é escolher entre coordenadas, e ninguém
//  escolhe entre (-1330, 871) e (204, -1502).
//
//  Copiá-lo para lá daria dois lugares para consertar o mesmo
//  defeito — e o defeito aqui é sutil (ver o `blob:` abaixo).
// ============================================================

import { useCallback, useEffect, useState } from 'react';

import { agent, agentUrl } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * De quanto em quanto tempo a tela volta a perguntar pela imagem.
 *
 * O jogo leva dezenas de segundos para desenhar um mundo novo.
 */
const MAP_RETRY_MS = 15_000;

/**
 * A imagem do mundo, baixada uma vez.
 *
 * ####  POR QUE `fetch` + `blob:`, E NÃO `<image href="/api/…">`  ####
 *
 * A rota é autenticada. Em produção o painel e o agente moram na
 * mesma origem e o cookie iria sozinho — mas em desenvolvimento o
 * painel roda em :3100 e o agente em :8787, e uma imagem
 * cross-origin NÃO leva credencial: a tela quebraria só no
 * ambiente de quem a está construindo.
 *
 * Com `fetch(credentials: 'include')` os dois casos ficam iguais, e
 * o `blob:` sai do endereço — o navegador não refaz a requisição a
 * cada redesenho do SVG.
 *
 * ####  E ELA PODE AINDA NÃO EXISTIR  ####
 *
 * O agente pede o render ao jogo quando o RCON conecta num mundo
 * sem imagem, e o desenho leva dezenas de segundos. Enquanto isso,
 * `available` é falso — e a tela volta a perguntar, em vez de
 * decidir que não há mapa.
 */
export function useMapImage(serverId: string): {
  readonly url: string | null;
  /** Quantas unidades do mundo a imagem cobre. Ver `MapView`. */
  readonly coverage: number | null;
  readonly pending: boolean;
  readonly message: string | null;
  /** Pede o render agora. Ver o comentário no botão. */
  readonly render: () => void;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function load(): Promise<void> {
      try {
        const info = await agent.mapImage(serverId);

        if (cancelled) {
          return;
        }

        setMessage(info.message ?? null);

        if (info.url === null) {
          setPending(true);
          return;
        }

        const response = await fetch(agentUrl(info.url), { credentials: 'include' });

        if (!response.ok || cancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(await response.blob());

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setCoverage(info.coverage);
        setUrl(objectUrl);
        setPending(false);
      } catch {
        // Sem imagem a tela continua servindo: a grade e os pontos
        // é que respondem "onde eles estão".
        if (!cancelled) {
          setPending(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;

      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [serverId, attempt]);

  // Enquanto o jogo desenha, a tela volta a perguntar. O timer só
  // existe enquanto falta imagem — pronto, ele nunca mais roda.
  useEffect(() => {
    if (url !== null) {
      return;
    }

    const timer = setTimeout(() => setAttempt((value) => value + 1), MAP_RETRY_MS);

    return () => clearTimeout(timer);
  }, [url, attempt]);

  const render = useCallback(() => {
    void (async () => {
      try {
        const response = await agent.renderMap(serverId);

        setPending(true);
        toast.info('Desenhando o mapa', { description: response.message });
        // Volta a perguntar já: o `attempt` é o que reinicia o
        // ciclo de leitura.
        setAttempt((value) => value + 1);
      } catch (cause) {
        toast.error('Não consegui pedir o render', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
  }, [serverId]);

  return { url, coverage, pending, message, render };
}
