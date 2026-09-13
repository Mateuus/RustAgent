'use client';

// ============================================================
//  message-group-dialog.tsx  -  criar e editar um rodízio.
//
//  ####  O GRUPO É O RITMO; A MENSAGEM É O TEXTO  ####
//
//  Tudo que decide QUANDO, ONDE e COM QUANTA gente está nesta
//  caixa. O que sai — texto, tag, cor — está na caixa da mensagem.
//  Repetir o intervalo em cada uma das cinco frases faria a sexta
//  correção entrar em quatro delas.
//
//  ####  A ORDEM É A ÚNICA ESCOLHA QUE RECOMEÇA O CICLO  ####
//
//  Mexer no nome ou na janela não pode repetir as três frases que
//  acabaram de sair. Trocar de "embaralhado" para "em ordem", sim:
//  a ordem fixa continua depois da ÚLTIMA que saiu, e continuar de
//  uma frase sorteada é começar no meio. A caixa avisa isso na
//  hora de escolher, e não depois.
// ============================================================

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  type MessageGroup,
  type MessageGroupInput,
  type RotationOrder,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** O fuso padrão do projeto. Ver Docs/16 §14, decisão 7. */
const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** O piso do agente, em segundos. Ver core/src/http/routes/messages.ts. */
const MIN_SECONDS = 60;

const ORDERS: readonly { value: RotationOrder; label: string; hint: string }[] = [
  {
    value: 'fixed',
    label: 'Em ordem',
    hint: 'Na ordem da lista, de cima para baixo. Chegando na última, o ciclo recomeça.',
  },
  {
    value: 'random',
    label: 'Embaralhado',
    hint: 'Todas saem antes de qualquer uma repetir, e nunca a mesma duas vezes seguidas — nem na virada do ciclo.',
  },
];

type Unit = 'minutos' | 'horas';

const UNIT_SECONDS: Readonly<Record<Unit, number>> = { minutos: 60, horas: 3600 };

interface MessageGroupDialogProps {
  readonly open: boolean;
  /** `null` = criar. Preenchido = editar aquele grupo. */
  readonly group: MessageGroup | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function MessageGroupDialog({ open, group, onClose, onDone }: MessageGroupDialogProps) {
  const [servers, setServers] = useState<string[]>([]);

  const [name, setName] = useState(group?.name ?? '');
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [order, setOrder] = useState<RotationOrder>(group?.order ?? 'fixed');

  const initial = splitInterval(group?.everySeconds ?? 300);

  const [every, setEvery] = useState(String(initial.amount));
  const [unit, setUnit] = useState<Unit>(initial.unit);
  const [timeZone, setTimeZone] = useState(group?.timeZone ?? DEFAULT_TIME_ZONE);

  const [windowFrom, setWindowFrom] = useState(group?.windowFrom ?? '');
  const [windowTo, setWindowTo] = useState(group?.windowTo ?? '');
  const [onlyWithPlayers, setOnlyWithPlayers] = useState(group?.onlyWithPlayers ?? false);
  const [minPlayers, setMinPlayers] = useState(String(group?.minPlayers ?? 1));

  const [allServers, setAllServers] = useState((group?.targets ?? []).length === 0);
  const [chosen, setChosen] = useState<string[]>(group === null ? [] : [...group.targets]);

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setServers((await agent.servers()).servers.map((server) => server.id));
      } catch {
        // Sem a lista, os checkboxes ficam vazios e o agente recusa
        // um servidor inventado. "Todos os servidores" continua
        // funcionando, que é o caso comum de um rodízio de rede.
      }
    })();
  }, []);

  function buildInput(): MessageGroupInput {
    return {
      name: name.trim(),
      enabled,
      everySeconds: Math.max(MIN_SECONDS, (Number(every) || 0) * UNIT_SECONDS[unit]),
      order,
      timeZone,
      // A janela é um PAR: um lado só preenchido é configuração pela
      // metade, e o agente a recusa dizendo isso.
      windowFrom: windowFrom.trim() === '' || windowTo.trim() === '' ? null : windowFrom.trim(),
      windowTo: windowFrom.trim() === '' || windowTo.trim() === '' ? null : windowTo.trim(),
      onlyWithPlayers,
      minPlayers: Math.max(0, Number(minPlayers) || 0),
      targets: allServers ? [] : chosen,
    };
  }

  async function submit(): Promise<void> {
    const input = buildInput();

    if (input.name === '') {
      toast.error('Falta o nome', { description: 'É o nome da lista, de quem administra.' });
      return;
    }

    setBusy(true);

    try {
      const response =
        group === null
          ? await agent.createMessageGroup(input)
          : await agent.updateMessageGroup(group.id, input);

      toast.success(group === null ? 'Grupo criado' : 'Grupo gravado', {
        description: response.detail,
      });

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

  /** A ordem mudou em relação ao que está gravado? */
  const orderChanged = group !== null && group.order !== order;

  return (
    <Dialog
      open={open}
      title={group === null ? 'Novo rodízio' : `Rodízio ${group.name}`}
      busy={busy}
      onClose={onClose}
      className="w-[min(44rem,94vw)]"
    >
      <div className="space-y-3">
        <div>
          <Label>Nome</Label>
          <Input
            value={name}
            placeholder="Dicas do servidor"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-1 text-2xs text-muted">
            É o nome da lista, de quem administra. O jogador nunca o vê.
          </p>
        </div>

        {/* ---- O RITMO ---- */}
        <div className="border-t border-border pt-3">
          <Label>Uma mensagem a cada</Label>

          <div className="flex flex-wrap items-end gap-3">
            <Input
              type="number"
              min={1}
              value={every}
              disabled={busy}
              onChange={(event) => setEvery(event.target.value)}
              className="w-24"
            />

            <select
              value={unit}
              disabled={busy}
              onChange={(event) => setUnit(event.target.value as Unit)}
              className="h-9 border border-border bg-surface-2 px-3 text-sm text-foreground"
            >
              <option value="minutos">minutos</option>
              <option value="horas">horas</option>
            </select>

            <p className="max-w-80 text-2xs leading-relaxed text-muted">
              <strong>Uma</strong>, e não todas: é isso que separa um rodízio de cinco mensagens com
              o mesmo intervalo — que saem as cinco juntas, no mesmo segundo. O mínimo é um minuto.
            </p>
          </div>
        </div>

        {/* ---- A ORDEM ---- */}
        <div className="border-t border-border pt-3">
          <Label>Em que ordem</Label>

          <div className="flex flex-wrap items-stretch border border-border">
            {ORDERS.map((option, index) => (
              <div key={option.value} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={order === option.value}
                  disabled={busy}
                  onClick={() => setOrder(option.value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    order === option.value
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              </div>
            ))}
          </div>

          <p className="mt-1 text-2xs leading-relaxed text-muted">
            {ORDERS.find((option) => option.value === order)?.hint}
          </p>

          {orderChanged && (
            <p className="mt-1 text-2xs leading-relaxed text-amber">
              Trocar a ordem <strong>recomeça o ciclo</strong>: o grupo esquece qual foi a última
              frase e volta ao começo da fila.
            </p>
          )}
        </div>

        {/* ---- JANELA E GENTE ---- */}
        <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
          <div>
            <Label>Só entre</Label>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                value={windowFrom}
                disabled={busy}
                onChange={(event) => setWindowFrom(event.target.value)}
                className="w-28"
              />
              <span className="text-2xs text-muted">e</span>
              <Input
                type="time"
                value={windowTo}
                disabled={busy}
                onChange={(event) => setWindowTo(event.target.value)}
                className="w-28"
              />
            </div>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Vazio = a qualquer hora. A janela <strong>pode virar a meia-noite</strong> (das 22:00
              às 02:00) — o agente entende isso.
            </p>
          </div>

          <div>
            <Label>Só com gente no servidor</Label>
            <div className="flex items-center gap-2">
              <Toggle
                on={onlyWithPlayers}
                busy={busy}
                labels={['Sim', 'Não']}
                onChange={setOnlyWithPlayers}
              />
              {onlyWithPlayers && (
                <>
                  <Input
                    type="number"
                    min={1}
                    max={1000}
                    value={minPlayers}
                    disabled={busy}
                    onChange={(event) => setMinPlayers(event.target.value)}
                    className="w-20"
                  />
                  <span className="text-2xs text-muted">online, no mínimo</span>
                </>
              )}
            </div>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Com o servidor vazio a vez <strong>não é consumida</strong>: a mesma frase continua
              sendo a próxima, em vez de o ciclo correr sozinho num servidor sem ninguém.
            </p>
          </div>
        </div>

        {/* ---- O FUSO ---- */}
        <div className="border-t border-border pt-3">
          <Label>Fuso</Label>
          <Input
            value={timeZone}
            disabled={busy}
            onChange={(event) => setTimeZone(event.target.value)}
            className="w-64"
          />
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            É nele que a janela de horário acima é lida.
          </p>
        </div>

        {/* ---- ONDE ---- */}
        <div className="border-t border-border pt-3">
          <Label>Onde ele fala</Label>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={allServers}
                disabled={busy}
                onChange={() => setAllServers(true)}
              />
              Todos os servidores
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={!allServers}
                disabled={busy}
                onChange={() => setAllServers(false)}
              />
              Escolher
            </label>
          </div>

          {!allServers && (
            <div className="mt-2 flex flex-wrap gap-3 border border-border bg-surface-2 p-2">
              {servers.length === 0 && (
                <span className="text-2xs text-muted">nenhum servidor cadastrado</span>
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
          )}

          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Vale para o rodízio inteiro. As mensagens dele não escolhem servidor: quem escolhe é o
            grupo.
          </p>
        </div>

        {/* ---- LIGADO ---- */}
        <div className="flex items-center gap-3 border-t border-border pt-3">
          <Label>Ligado</Label>
          <Toggle on={enabled} busy={busy} labels={['Sim', 'Não']} onChange={setEnabled} />
          <p className="text-2xs text-muted">
            Desligado, ele fica na lista e <strong>nenhuma</strong> mensagem dele sai.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={busy || name.trim() === ''}
            onClick={() => void submit()}
          >
            {busy ? 'Gravando…' : group === null ? 'Criar' : 'Gravar'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** `300` -> `{ amount: 5, unit: 'minutos' }`. */
function splitInterval(seconds: number): { amount: number; unit: Unit } {
  if (seconds > 0 && seconds % 3600 === 0) {
    return { amount: seconds / 3600, unit: 'horas' };
  }

  return { amount: Math.max(1, Math.round(seconds / 60)), unit: 'minutos' };
}
