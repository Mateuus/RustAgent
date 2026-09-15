'use client';

// ============================================================
//  streamer-card.tsx  -  o modo streamer, na ficha do jogador.
//
//  Pedido do dono em 14/09/2026: quem faz live e grava vídeo
//  precisa poder tirar a marca do servidor da própria tela — a
//  logo, a propaganda e os avisos automáticos do chat.
//
//  ------------------------------------------------------------
//  ####  DUAS CHAVES, E ELAS TEM DONOS DIFERENTES  ####
//
//  Esta tela mexe na PRIMEIRA: o admin libera o jogador e escolhe
//  o que some quando ele ligar. A segunda é do jogador, com
//  `/streamer` dentro do jogo — aqui ela aparece como estado, e o
//  botão que a alterna existe para o suporte (desligar a live de
//  quem saiu do ar e esqueceu, ou ligar para conferir o desenho
//  sem entrar no jogo).
//
//  ####  AS TRES CHAVES DO MEIO SO EXISTEM COM A LIBERACAO  ####
//
//  Sem `allowed`, o comando responde que ele não tem acesso e nada
//  do resto tem efeito. Mostrá-las ligadas ali daria a entender
//  que já está valendo — por isso elas só aparecem depois.
// ============================================================

import { Radio } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Toggle } from '@/components/ui/toggle';
import { agent, type StreamerProfile } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';

/** O que cada chave do "o que some" diz na tela. */
const SWITCHES = [
  {
    key: 'hideLogo',
    label: 'Esconder a logo do servidor',
    hint: 'A marca que fica na tela em repouso, do overlay de propaganda.',
  },
  {
    key: 'hideAds',
    label: 'Esconder a propaganda',
    hint: 'O painel que abre e gira as campanhas. A logo pode ficar, se a chave acima estiver desligada.',
  },
  {
    key: 'hideMessages',
    label: 'Silenciar os avisos do chat',
    hint: 'Os anúncios automáticos do servidor (loja, site, wipe). Recado dirigido a ele — compra entregue, VIP vencendo — continua chegando.',
  },
] as const;

export interface StreamerCardProps {
  readonly steamId: string;
}

export function StreamerCard({ steamId }: StreamerCardProps) {
  const [profile, setProfile] = useState<StreamerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.playerStreamer(steamId);
      setProfile(response.streamer);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [steamId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Salva UMA chave.
   *
   * O PUT é parcial de propósito (ver a rota): mandar o perfil
   * inteiro faria dois cliques rápidos gravarem o estado velho de
   * quem não mudou.
   */
  const save = async (patch: Partial<Record<string, boolean>>, done: string) => {
    setBusy(true);

    try {
      const response = await agent.saveStreamer(steamId, patch);
      setProfile(response.streamer);
      toast.success(done);
    } catch (cause) {
      toast.error('Não consegui salvar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  if (error !== null) {
    return (
      <Section title="Modo streamer">
        <StateBlock variant="error" title="Não consegui ler o modo streamer" detail={error} />
      </Section>
    );
  }

  if (profile === null) {
    return (
      <Section title="Modo streamer">
        <p className="text-sm text-muted">Carregando…</p>
      </Section>
    );
  }

  return (
    <Section
      title="Modo streamer"
      aside={
        profile.allowed && profile.active ? (
          <span className="flex items-center gap-1.5 font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
            <Radio aria-hidden="true" className="h-3.5 w-3.5" />
            no ar agora
          </span>
        ) : null
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">Pode usar o modo streamer</p>
            <p className="text-xs text-muted">
              Liberado, ele liga e desliga sozinho com <code className="font-mono">/streamer</code>{' '}
              no chat do jogo. Vale em todos os servidores da rede.
            </p>
          </div>

          <Toggle
            on={profile.allowed}
            busy={busy}
            label="Pode usar o modo streamer"
            labels={['Liberado', 'Bloqueado']}
            onChange={(value) => {
              void save(
                { allowed: value },
                value ? 'Modo streamer liberado' : 'Liberação retirada',
              );
            }}
          />
        </div>

        {profile.allowed && (
          <>
            <div className="border-t border-border pt-3">
              <p className="mb-2 font-condensed text-2xs font-bold uppercase tracking-wide text-muted">
                O que some da tela dele
              </p>

              <div className="space-y-3">
                {SWITCHES.map((item) => (
                  <div key={item.key} className="flex flex-wrap items-center justify-between gap-3">
                    <div className="max-w-md">
                      <p className="font-medium">{item.label}</p>
                      <p className="text-xs text-muted">{item.hint}</p>
                    </div>

                    <Toggle
                      on={profile[item.key]}
                      busy={busy}
                      label={item.label}
                      labels={['Some', 'Fica']}
                      onChange={(value) => {
                        void save({ [item.key]: value }, 'Salvo');
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <div className="max-w-md">
                <p className="font-medium">A live dele, agora</p>
                <p className="text-xs text-muted">
                  {profile.active
                    ? `Ligada${
                        profile.activatedAt === null
                          ? ''
                          : ` desde ${formatDateTime(profile.activatedAt)}`
                      }. Quem liga e desliga é ele, no jogo — daqui é para o suporte.`
                    : 'Desligada. Ele vê a logo e a propaganda como qualquer jogador.'}
                </p>
              </div>

              <Toggle
                on={profile.active}
                busy={busy}
                label="A live dele, agora"
                labels={['No ar', 'Fora do ar']}
                onChange={(value) => {
                  void save(
                    { active: value },
                    value ? 'Modo streamer ligado para ele' : 'Modo streamer desligado',
                  );
                }}
              />
            </div>
          </>
        )}

        {profile.grantedBy !== null && profile.allowed && (
          <p className="border-t border-border pt-3 text-xs text-muted">
            Liberado por {profile.grantedBy}.
          </p>
        )}
      </div>
    </Section>
  );
}
