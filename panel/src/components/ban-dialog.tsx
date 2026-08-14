'use client';

// ============================================================
//  ban-dialog.tsx  -  o formulário de banir.
//
//  ####  POR QUE ELE É UM DIÁLOGO, E NÃO UM ConfirmButton  ####
//
//  O `ConfirmButton` serve onde não há dado a repetir, só
//  consequência a avisar — parar um servidor, tirar um plugin.
//  Banir é o contrário: quem bane precisa dizer o MOTIVO, ESCOLHER
//  o alcance e decidir o PRAZO. Três decisões não cabem num botão
//  de dois cliques.
//
//  ####  E POR QUE ELE MORA NUM ARQUIVO PRÓPRIO  ####
//
//  Porque os dois lugares que banem são telas diferentes: a linha
//  de um jogador online (Administração → Jogadores) e a tela de
//  rede (Banidos). Duas cópias divergiriam no primeiro ajuste — e
//  a que divergisse seria a que esquece de mandar o escopo.
//
//  ------------------------------------------------------------
//  ####  O ESCOPO É A DECISÃO QUE ENVELHECE  ####
//
//  "Rede" vale nos servidores que ainda vão ser criados; a lista de
//  servidores marcados vale só neles. A diferença só aparece meses
//  depois, quando o `pvp3` nasce — e é por isso que o texto ao lado
//  de cada opção diz isso em voz alta, em vez de deixar a escolha
//  parecer uma preferência.
// ============================================================

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { agent, type BanScope } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Os prazos oferecidos.
 *
 * `null` é PERMANENTE, e é o primeiro de propósito: é o caso mais
 * comum e o que o jogo faz de fábrica. Os outros existem porque
 * "banir por uma semana" é o pedido mais frequente — e sem eles a
 * pessoa bane para sempre e tenta lembrar de soltar depois.
 */
const PRAZOS: readonly { label: string; hours: number | null }[] = [
  { label: 'Permanente', hours: null },
  { label: '1 dia', hours: 24 },
  { label: '3 dias', hours: 72 },
  { label: '7 dias', hours: 168 },
  { label: '30 dias', hours: 720 },
];

export interface BanDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Recarrega a lista de quem chamou. */
  readonly onDone: () => void;
  /** Os ids que o escopo "servidores escolhidos" pode marcar. */
  readonly servers: readonly string[];
  /**
   * Preenche o formulário quando o ban nasce de uma linha da lista
   * de jogadores — ali o SteamID e o nome já são conhecidos, e
   * pedir para digitar de novo é convite a errar um dígito.
   */
  readonly steamId?: string;
  readonly name?: string;
  /** O servidor de onde o diálogo foi aberto, já marcado. */
  readonly defaultServer?: string;
}

export function BanDialog({
  open,
  onClose,
  onDone,
  servers,
  steamId: initialSteamId,
  name: initialName,
  defaultServer,
}: BanDialogProps) {
  const [steamId, setSteamId] = useState(initialSteamId ?? '');
  const [name, setName] = useState(initialName ?? '');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<BanScope>('network');
  const [marked, setMarked] = useState<readonly string[]>(
    defaultServer === undefined ? [] : [defaultServer],
  );
  const [hours, setHours] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.createBan({
        steamId: steamId.trim(),
        name: name.trim() === '' ? undefined : name.trim(),
        reason: reason.trim(),
        scope,
        servers: scope === 'servers' ? [...marked] : undefined,
        // A conta do vencimento é da tela: ela sabe o fuso de quem
        // está olhando. O agente recebe a data pronta, em ISO.
        expiresAt: hours === null ? null : new Date(Date.now() + hours * 3_600_000).toISOString(),
      });

      toast.success(`${steamId.trim()} banido`, { description: response.message });
      onDone();
      onClose();
    } catch (cause) {
      toast.error('Não consegui banir', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  const podeEnviar =
    steamId.trim().length === 17 && reason.trim() !== '' && (scope === 'network' || marked.length > 0);

  return (
    <Dialog open={open} title="Banir jogador" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ban-steamid">SteamID64</Label>
          <Input
            id="ban-steamid"
            value={steamId}
            placeholder="76561198000000000"
            inputMode="numeric"
            className="font-mono"
            onChange={(event) => setSteamId(event.target.value.trim())}
          />
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            17 dígitos, começando com 7656. É o que o botão <strong>Copiar SteamID</strong> da aba
            Jogadores põe na área de transferência.
          </p>
        </div>

        <div>
          <Label htmlFor="ban-nome">Nome (opcional)</Label>
          <Input
            id="ban-nome"
            value={name}
            placeholder="como ele aparecia no jogo"
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Guardado como está HOJE. Ele muda de nome; o banimento continua sendo do mesmo SteamID.
          </p>
        </div>

        <div>
          <Label htmlFor="ban-motivo">Motivo</Label>
          <Input
            id="ban-motivo"
            value={reason}
            placeholder="uso de cheat, insulto no chat…"
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Vai para o <code>bans.cfg</code> do servidor e para o histórico. É o que responde
            &ldquo;por que este jogador foi banido?&rdquo; daqui a três meses.
          </p>
        </div>

        {/* ####  ONDE VALE  ####

            Ver o cabeçalho: a diferença entre as duas opções só
            aparece quando um servidor NOVO é criado. */}
        <div>
          <Label>Onde vale</Label>

          <div className="mt-1 flex items-stretch border border-border">
            {(
              [
                ['network', 'Toda a rede'],
                ['servers', 'Servidores escolhidos'],
              ] as const
            ).map(([key, label], index) => (
              <div key={key} className="flex flex-1 items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={scope === key}
                  onClick={() => setScope(key)}
                  className={cn(
                    'flex-1 px-3 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    scope === key
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              </div>
            ))}
          </div>

          {scope === 'network' ? (
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Vale em todos os servidores — <strong>inclusive nos que ainda não existem</strong>. É
              o que impede um banido de aparecer no servidor novo do mês que vem.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-2">
                {servers.map((id) => {
                  const on = marked.includes(id);

                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setMarked(on ? marked.filter((item) => item !== id) : [...marked, id])
                      }
                      className={cn(
                        'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                        on
                          ? 'border-rust bg-rust text-white'
                          : 'border-border text-muted hover:text-foreground',
                      )}
                    >
                      {id}
                    </button>
                  );
                })}
              </div>

              <p className="text-2xs leading-relaxed text-muted">
                Só nestes. Um servidor criado depois <strong>não</strong> herda este banimento.
              </p>
            </div>
          )}
        </div>

        {/* ####  O PRAZO É NOSSO  ####

            O ban do Rust é permanente: não existe "por 7 dias" no
            jogo. Quem solta na data é um relógio do agente. */}
        <div>
          <Label>Prazo</Label>

          <div className="mt-1 flex flex-wrap gap-2">
            {PRAZOS.map((prazo) => (
              <button
                key={prazo.label}
                type="button"
                aria-pressed={hours === prazo.hours}
                onClick={() => setHours(prazo.hours)}
                className={cn(
                  'border px-3 py-1.5 font-condensed text-2xs font-bold uppercase tracking-wide',
                  hours === prazo.hours
                    ? 'border-amber bg-amber text-background'
                    : 'border-border text-muted hover:text-foreground',
                )}
              >
                {prazo.label}
              </button>
            ))}
          </div>

          <p className="mt-1 text-2xs leading-relaxed text-muted">
            {hours === null
              ? 'Fica até alguém revogar.'
              : 'O jogo não tem banimento com prazo: quem solta na data é o agente, e só ' +
                'enquanto ele estiver no ar.'}
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" disabled={busy || !podeEnviar} onClick={() => void submit()}>
            {busy ? 'Banindo…' : 'Banir'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
