'use client';

// ============================================================
//  /config  -  o agente, não os servidores.
//
//  O que está aqui é LEITURA. Trocar porta, token ou senha do
//  painel é editar o `.env` e reiniciar o serviço — de propósito:
//  uma tela que reescreve o próprio `.env` é uma tela que pode
//  trancar o operador do lado de fora, e a correção exigiria
//  justamente o acesso que ela tirou.
// ============================================================

import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { Section } from '@/components/section';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { api } from '@/lib/api';

interface Health {
  ok: boolean;
  status: string;
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  servers: { id: string; enabled: boolean; rcon: { connected: boolean; state: string } | null }[];
}

export default function ConfigPage() {
  return (
    <RequireSession>
      <Agente />
    </RequireSession>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 px-4 py-2">
      <dt className="w-48 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}

function Agente() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = (): void => {
      void api<Health>('/health')
        .then(setHealth)
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    };

    load();

    const timer = setInterval(load, 10_000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="max-w-3xl">
      <PageHeader title="O agente" description="O processo que cuida dos servidores." />

      {error !== null && (
        <StateBlock variant="offline" title="O agente não respondeu" detail={error} />
      )}

      {health !== null && (
        <dl className="mb-8 mt-4 divide-y divide-border border border-border bg-surface text-sm">
          <Row label="versão" value={health.version} />
          <Row
            label="estado"
            value={
              health.status === 'ok'
                ? 'tudo em ordem'
                : 'degradado — há servidor ligado cujo RCON não responde'
            }
          />
          <Row label="no ar desde" value={new Date(health.startedAt).toLocaleString('pt-BR')} />
          <Row
            label="tempo de pé"
            value={`${String(Math.floor(health.uptimeSeconds / 3600))} h ${String(
              Math.floor((health.uptimeSeconds % 3600) / 60),
            )} min`}
          />
          <Row label="servidores" value={String(health.servers.length)} />
        </dl>
      )}

      <Section title="Como mudar a configuração" contentClassName="text-sm">
        <p className="mb-3 text-muted">
          Edite o <code>.env</code> na raiz do projeto e reinicie o serviço:
        </p>
        <pre className="mb-3 overflow-x-auto bg-background p-3 text-2xs">
          {'git pull\nnpm install\nnpm run build\npm2 restart rustagent'}
        </pre>
        <p className="text-muted">
          Isso <strong>não</strong> derruba os servidores de Rust: eles rodam destacados do agente.
          Para trocar a senha do painel, rode <code>npm run panel:senha -w core</code> e ponha o
          resultado em <code>PANEL_PASSWORD_HASH</code>.
        </p>
      </Section>
    </div>
  );
}
