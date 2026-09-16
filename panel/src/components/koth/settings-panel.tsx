'use client';

// ============================================================
//  settings-panel.tsx  -  as configurações do KOTH.
//
//  ####  POR QUE UMA ABA SÓ PARA ISTO  ####
//
//  Pedido do dono: "Vagas tem que ficar na tab configurações...
//  então vamos ter várias configuração lá".
//
//  Vagas nasceu no "Ao vivo", ao lado dos cards — e ali ela era um
//  campo de digitar no meio de uma tela de ACOMPANHAR. As duas
//  coisas têm ritmos diferentes: o ao vivo se olha o dia inteiro e
//  não se toca; configuração se mexe uma vez e se esquece.
//
//  ####  SEÇÕES, E NÃO UM FORMULÁRIO SÓ  ####
//
//  Cada assunto é uma seção com título e explicação própria, e cada
//  uma salva sozinha. Um "Salvar" único no rodapé obrigaria a tela
//  inteira a carregar antes de mexer em qualquer coisa — e faria
//  quem mexeu nas vagas esperar por um campo de outro assunto que
//  nem abriu.
//
//  É a mesma forma da tela de Configurações do servidor, e é ela
//  que deixa a próxima configuração entrar sem reescrever nada.
// ============================================================

import { Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent } from '@/lib/api';
import { toast } from '@/lib/toast';

export interface SettingsPanelProps {
  readonly serverId: string;
}

export function SettingsPanel({ serverId }: SettingsPanelProps) {
  const [vagas, setVagas] = useState<number | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  /** Quantos estão de pé agora — só para dizer se o corte dói. */
  const [live, setLive] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const response = await agent.kothSettings(serverId);

        if (!alive) return;

        setVagas(response.settings.maxConcurrent);
        setDraft(response.settings.maxConcurrent);
        setLive(response.live);
        setError(null);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      alive = false;
    };
  }, [serverId]);

  async function saveVagas(value: number): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.saveKothSettings(serverId, value);

      setVagas(response.settings.maxConcurrent);
      setDraft(response.settings.maxConcurrent);

      toast.success('Vagas salvas', {
        description: `Até ${String(response.settings.maxConcurrent)} KOTH ao mesmo tempo.`,
      });
    } catch (cause) {
      toast.error('Não consegui salvar as vagas', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  if (error !== null) {
    return <StateBlock variant="error" title="Não consegui ler as configurações" detail={error} />;
  }

  if (vagas === null || draft === null) {
    return <StateBlock variant="loading" title="Lendo as configurações…" />;
  }

  // Cortar as vagas abaixo do que já está no mapa não derruba nada:
  // o relógio só para de erguer até sobrar vaga. Vale dizer, senão
  // parece que salvar vai matar evento.
  const apertado = live !== null && draft < live;

  return (
    <div className="space-y-4">
      <Section
        title="Vagas"
        detail="Quantos KOTH podem existir ao mesmo tempo neste servidor. Com todas ocupadas, o relógio ADIA o próximo em vez de cancelá-lo — e uma masmorra de pé continua bloqueando os dois, porque dois eventos dividem a população e os dois ficam vazios."
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="block font-condensed text-2xs uppercase tracking-wide text-muted">
              Máximo ao mesmo tempo
            </span>
            <Input
              type="number"
              min={1}
              max={10}
              value={String(draft)}
              className="mt-1 h-9 w-24"
              onChange={(event) => {
                const parsed = Number(event.target.value);

                if (Number.isFinite(parsed)) {
                  setDraft(Math.max(1, Math.min(10, Math.round(parsed))));
                }
              }}
            />
          </label>

          <Button
            size="sm"
            variant="primary"
            className="mb-0.5"
            disabled={busy || draft === vagas}
            onClick={() => void saveVagas(draft)}
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Salvar
          </Button>

          {live !== null && (
            <span className="mb-2 font-condensed text-2xs uppercase tracking-wide text-muted">
              {live} de pé agora
            </span>
          )}
        </div>

        {apertado && (
          <p className="mt-2 border-l-2 border-amber pl-2 text-2xs text-foreground">
            Há {live} de pé, mais que o máximo novo. Nenhum será derrubado: o relógio só volta a
            erguer quando sobrar vaga.
          </p>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="border border-border bg-surface p-3">
      <h3 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
        <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
        {title}
      </h3>
      <p className="mt-1 max-w-2xl text-2xs text-muted">{detail}</p>

      <div className="mt-3">{children}</div>
    </section>
  );
}
