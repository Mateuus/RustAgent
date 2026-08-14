'use client';

// ============================================================
//  /  -  Dashboard.
//
//  A primeira pergunta de quem administra um dedicado não é sobre
//  um servidor: é "esta máquina aguenta mais um?". Por isso o
//  painel abre em NÚCLEOS, MEMÓRIA E DISCO — e só depois nos
//  servidores.
//
//  ####  OS INDICADORES SÃO GRADE DE 1px, NÃO CARTÕES  ####
//
//  `gap-px` sobre `bg-border` desenha as divisórias com o próprio
//  fundo: cada bloco é `bg-surface` e o vão de 1px vira a linha.
//  É o padrão de KPI do design system — sem sombra, sem canto
//  arredondado, sem borda por bloco.
// ============================================================

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { Section } from '@/components/section';
import { ServerStateBadge } from '@/components/server-state';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { agent, type ServerView, type SystemInfo } from '@/lib/api';
import { EM_DASH, formatBytes, formatDuration, formatInteger, usedPercent } from '@/lib/format';

/** A máquina não muda de núcleo a cada segundo. 10 s basta. */
const POLL_MS = 10_000;

interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | undefined;
  /** 0–100. Desenha a barrinha de uso embaixo. */
  readonly meter?: number | null;
  readonly loading: boolean;
}

function Kpi({ label, value, hint, meter, loading }: KpiProps) {
  return (
    <div className="bg-surface px-3 py-2">
      <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">{label}</p>

      {loading ? (
        <div aria-hidden className="mt-1 h-6 w-16 animate-pulse bg-surface-2" />
      ) : (
        // `tabular-nums`: sem largura fixa de dígito, o número
        // muda de largura a cada leitura e a linha inteira treme.
        <p className="font-condensed text-2xl font-bold leading-tight tabular-nums text-foreground">
          {value}
        </p>
      )}

      {hint !== undefined && <p className="truncate text-2xs text-muted">{hint}</p>}

      {meter != null && (
        <div className="mt-1 h-1 w-full bg-surface-2">
          <div
            className={meter > 90 ? 'h-1 bg-rust' : meter > 75 ? 'h-1 bg-amber' : 'h-1 bg-olive'}
            style={{ width: `${String(meter)}%` }}
          />
        </div>
      )}

      {loading && <span className="sr-only">Carregando {label}</span>}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RequireSession>
      <Dashboard />
    </RequireSession>
  );
}

function Dashboard() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [servers, setServers] = useState<readonly ServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [info, list] = await Promise.all([agent.system(), agent.servers()]);

      setSystem(info);
      setServers(list.servers);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não consegui falar com o agente.');
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = setInterval(() => void load(), POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  const machine = system?.machine ?? null;
  const loading = system === null && error === null;
  const ramUsed = usedPercent(machine?.memory.total, machine?.memory.free);
  const diskUsed = usedPercent(machine?.disk?.total, machine?.disk?.free);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={
          machine === null
            ? 'Carregando a máquina…'
            : `${machine.hostname} · ${machine.platform} ${machine.release} · ${machine.arch}`
        }
        aside={
          <Link href="/servidores/">
            <Button variant="primary">Servidores</Button>
          </Link>
        }
      />

      {error !== null && (
        <StateBlock variant="offline" title="O agente não respondeu" detail={error} />
      )}

      {/* ---- a máquina ---- */}
      <section aria-label="A máquina" className="space-y-2">
        <h2 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Máquina
        </h2>

        <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 xl:grid-cols-6">
          <Kpi
            label="Núcleos"
            value={machine === null ? EM_DASH : formatInteger(machine.cpu.cores)}
            hint={machine?.cpu.model ?? undefined}
            loading={loading}
          />
          <Kpi
            label="Clock"
            value={
              machine?.cpu.speedMhz == null
                ? EM_DASH
                : `${(machine.cpu.speedMhz / 1000).toFixed(1)} GHz`
            }
            loading={loading}
          />
          <Kpi
            label="Memória livre"
            value={formatBytes(machine?.memory.free)}
            hint={machine === null ? undefined : `de ${formatBytes(machine.memory.total)}`}
            meter={ramUsed}
            loading={loading}
          />
          <Kpi
            label="Disco livre"
            value={formatBytes(machine?.disk?.free)}
            hint={
              machine?.disk == null
                ? 'o sistema não informou'
                : `de ${formatBytes(machine.disk.total)}`
            }
            meter={diskUsed}
            loading={loading}
          />
          <Kpi
            label="Máquina de pé"
            value={formatDuration(machine?.uptimeSeconds)}
            loading={loading}
          />
          <Kpi
            label="Agente de pé"
            value={formatDuration(system?.agent.uptimeSeconds)}
            hint={
              system === null
                ? undefined
                : `v${system.agent.version} · pid ${String(system.agent.pid)}`
            }
            loading={loading}
          />
        </div>

        {/* Um servidor de Rust ocupa ~20 GB. Avisar ANTES de a
            pessoa clicar em Instalar é a diferença entre um aviso
            e um download que morre pela metade. */}
        {machine?.disk != null && machine.disk.free < 25 * 1024 ** 3 && (
          <StateBlock
            variant="error"
            title="Disco quase cheio"
            detail={`Restam ${formatBytes(machine.disk.free)} em ${
              system?.agent.paths.servers ?? 'na pasta dos servidores'
            }. Uma instalação do Rust ocupa cerca de 20 GB — libere espaço, ou aponte SERVERS_DIR para outro disco no .env.`}
          />
        )}
      </section>

      {/* ---- os servidores, em número ---- */}
      <section aria-label="Os servidores" className="space-y-2">
        <h2 className="font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
          Servidores
        </h2>

        <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-5">
          <Kpi label="Cadastrados" value={formatInteger(system?.servers.total)} loading={loading} />
          <Kpi label="Instalados" value={formatInteger(system?.servers.installed)} loading={loading} />
          <Kpi
            label="Cuidados"
            value={formatInteger(system?.servers.enabled)}
            hint="o agente mantém o RCON"
            loading={loading}
          />
          <Kpi label="No ar" value={formatInteger(system?.servers.online)} loading={loading} />
          <Kpi
            label="Vagas"
            value={formatInteger(system?.servers.maxPlayers)}
            hint="somando os slots"
            loading={loading}
          />
        </div>
      </section>

      {/* ---- e um por um ---- */}
      <Section
        title="Cada servidor"
        aside={
          <Link
            href="/servidores/"
            className="text-2xs uppercase tracking-wider text-muted hover:text-foreground"
          >
            abrir a lista
          </Link>
        }
        contentClassName="p-0"
      >
        {servers !== null && servers.length === 0 ? (
          <div className="p-4">
            <StateBlock
              variant="empty"
              title="Nenhum servidor ainda"
              detail="Crie o primeiro na tela de Servidores. Ele nasce desligado, e o passo seguinte é Instalar."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {servers?.map((server) => (
              <li key={server.id}>
                <Link
                  href={`/servidor/?id=${encodeURIComponent(server.id)}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-condensed text-sm font-bold uppercase tracking-wide">
                      {server.name}
                    </span>
                    <span className="block truncate text-2xs text-muted">
                      {server.map} · {String(server.worldSize)} · até {String(server.maxPlayers)}{' '}
                      jogadores · portas {String(server.ports.game)}/{String(server.ports.rcon)}
                    </span>
                  </span>

                  <ServerStateBadge server={server} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
