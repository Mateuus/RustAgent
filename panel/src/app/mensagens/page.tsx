'use client';

// ============================================================
//  /mensagens  -  o que o servidor fala sozinho.
//
//  ####  A MENSAGEM É DE REDE, COMO VIP, KIT E LOJA  ####
//
//  Escrevo uma vez e escolho em quais servidores ela sai. Por isso
//  esta tela mora na barra lateral, e não na página de um servidor
//  — e por isso a coluna ONDE mostra os NOMES: "2 servidores"
//  obrigaria a ir procurar quais.
//
//  ####  CADA UMA TEM O SEU RITMO  ####
//
//  O agente antigo tinha UM intervalo e um rodízio de frases. Aqui
//  o convite do Discord de meia em meia hora convive com o aviso de
//  manutenção de uma vez só, na terça de madrugada — e é a coluna
//  PRÓXIMA que responde "isso está funcionando?".
//
//  ####  DESLIGAR NÃO É APAGAR  ####
//
//  Desligada, a mensagem fica na lista, o histórico fica, e ela não
//  sai. Apagar leva o log junto — e a confirmação diz quantos
//  envios vão embora, porque é esse número que faz alguém mudar de
//  ideia.
//
//  ####  E O LOG RESPONDE "ELA ESTÁ MESMO APARECENDO?"  ####
//
//  Com as falhas dentro, e com o motivo. Um log só de sucessos
//  responde "sim" justamente quando a resposta é "não".
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { MessageDialog } from '@/components/message-dialog';
import { PageHeader } from '@/components/page-header';
import { RequireSession } from '@/components/session';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import {
  agent,
  type Message,
  type MessageLogEntry,
  type MessageVariables,
} from '@/lib/api';
import { EM_DASH, formatDateTime, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export default function MensagensPage() {
  return (
    <RequireSession>
      <Mensagens />
    </RequireSession>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-3 py-2 text-left font-condensed text-2xs font-bold uppercase tracking-wide text-muted"
    >
      {children}
    </th>
  );
}

function Mensagens() {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [variables, setVariables] = useState<MessageVariables | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** `undefined` = fechado; `null` = criando; uma mensagem = editando. */
  const [editing, setEditing] = useState<Message | null | undefined>(undefined);

  /** Qual mensagem teve o log aberto. */
  const [logOf, setLogOf] = useState<number | null>(null);
  const [entries, setEntries] = useState<MessageLogEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await agent.messages();

      setMessages(response.messages);
      setVariables(response.variables);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openLog(message: Message): Promise<void> {
    if (logOf === message.id) {
      setLogOf(null);
      return;
    }

    setLogOf(message.id);
    setEntries(null);

    try {
      setEntries((await agent.messageLog(message.id, 100)).entries);
    } catch (cause) {
      toast.error('Não consegui ler o histórico', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      setLogOf(null);
    }
  }

  /**
   * O clique na bolinha liga e desliga.
   *
   * Um PATCH de um campo só, e não o corpo inteiro: mandar o texto e
   * o ritmo a cada clique abriria a chance de sobrescrever o que
   * outra aba acabou de gravar.
   */
  async function toggle(message: Message): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.updateMessage(message.id, { enabled: !message.enabled });

      toast.success(message.enabled ? 'Mensagem desligada' : 'Mensagem ligada', {
        description: response.detail,
      });
      await load();
    } catch (cause) {
      toast.error('Não consegui gravar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function test(message: Message): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.testMessage(message.id);
      const failed = response.reports.filter((report) => !report.ok);

      if (failed.length === 0) {
        toast.success('Saiu no chat', { description: response.detail });
      } else {
        toast.error('Nem todo servidor recebeu', {
          description: failed
            .map((report) => `${report.serverId}: ${report.error ?? ''}`)
            .join(' · '),
        });
      }

      // O `next_at` NÃO muda com o teste, mas o `message_log` sim —
      // e é ele que a tela mostra logo abaixo.
      if (logOf === message.id) {
        setEntries((await agent.messageLog(message.id, 100)).entries);
      }
    } catch (cause) {
      toast.error('Não consegui mandar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(message: Message): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeMessage(message.id);

      toast.success('Mensagem removida', { description: response.detail });
      await load();
    } catch (cause) {
      toast.error('Não consegui remover', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Mensagens"
        description="O que o servidor fala sozinho: avisos, convites e lembretes. Cada uma tem o seu ritmo."
        aside={
          <Button variant="primary" disabled={busy} onClick={() => setEditing(null)}>
            Nova mensagem
          </Button>
        }
      />

      <div className="mt-4 space-y-4">
        {error !== null && (
          <StateBlock variant="error" title="Não consegui ler as mensagens" detail={error} />
        )}

        {messages === null && error === null && (
          <StateBlock variant="loading" title="Lendo as mensagens…" />
        )}

        {messages !== null && messages.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nenhuma mensagem ainda"
            detail="Uma mensagem é uma fala do servidor com ritmo próprio: de meia em meia hora, todo dia às 20:00, toda quinta, ou uma vez só. Ela é da rede — escreva uma vez e escolha onde sai."
          />
        )}

        {messages !== null && messages.length > 0 && (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <HeaderCell>
                    <span className="sr-only">Ligada</span>
                  </HeaderCell>
                  <HeaderCell>Nome</HeaderCell>
                  <HeaderCell>Texto</HeaderCell>
                  <HeaderCell>Repete</HeaderCell>
                  <HeaderCell>Próxima</HeaderCell>
                  <HeaderCell>Onde</HeaderCell>
                  <HeaderCell>Enviadas</HeaderCell>
                  <HeaderCell>
                    <span className="sr-only">Ações</span>
                  </HeaderCell>
                </tr>
              </thead>

              <tbody className="divide-y divide-border">
                {messages.map((message) => (
                  <tr key={message.id} className={cn(!message.enabled && 'text-muted')}>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void toggle(message)}
                        aria-pressed={message.enabled}
                        title={message.enabled ? 'Desligar esta mensagem' : 'Ligar esta mensagem'}
                        className="flex items-center"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-3 w-3 shrink-0 rounded-full border',
                            message.enabled
                              ? 'border-olive bg-olive'
                              : 'border-border bg-transparent',
                          )}
                        />
                        <span className="sr-only">
                          {message.enabled ? 'Ligada' : 'Desligada'}
                        </span>
                      </button>
                    </td>

                    <td className="px-3 py-2">
                      <p className="truncate">{message.name}</p>
                      {message.onlyWithPlayers && (
                        <p className="truncate text-2xs text-muted">
                          só com {message.minPlayers}+ online
                        </p>
                      )}
                    </td>

                    <td className="max-w-80 px-3 py-2">
                      <p className="truncate text-muted" title={message.text}>
                        {message.tag === null ? '' : `${message.tag} `}
                        {message.text}
                      </p>
                    </td>

                    {/* A frase vem do AGENTE (messages/schedule.ts):
                        duas versões dela divergiriam no primeiro
                        ajuste, e a que ninguém lê seria a errada. */}
                    <td className="px-3 py-2 text-muted">
                      {message.schedule}
                      {message.windowFrom !== null && message.windowTo !== null && (
                        <span className="block text-2xs">
                          {message.windowFrom}–{message.windowTo}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      {!message.enabled ? (
                        <span className="text-2xs uppercase text-muted">desligada</span>
                      ) : message.nextAt === null ? (
                        <span className="text-2xs text-amber">sem próxima</span>
                      ) : (
                        <span title={formatDateTime(message.nextAt)}>
                          {formatNext(message.nextAt)}
                        </span>
                      )}
                    </td>

                    {/* Os NOMES, e não a contagem. Vazio = TODOS, e a
                        tela diz isso com todas as letras: um traço
                        pareceria "nenhum". */}
                    <td className="px-3 py-2 text-muted">
                      {message.targets.length === 0 ? (
                        <span className="text-2xs uppercase">todos</span>
                      ) : (
                        message.targets.join(', ')
                      )}
                    </td>

                    <td className="px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void openLog(message)}
                        title="Ver o histórico: ela está mesmo aparecendo?"
                      >
                        {message.sentCount}
                      </Button>
                    </td>

                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void test(message)}
                          title="Manda agora, sem mexer no horário da próxima"
                        >
                          Testar
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(message)}
                        >
                          Editar
                        </Button>

                        <ConfirmButton
                          variant="danger"
                          disabled={busy}
                          icon={null}
                          label="Remover"
                          confirmLabel="Remover mesmo"
                          hint={
                            message.sentCount === 0
                              ? `"${message.name}" some da lista.`
                              : `"${message.name}" some da lista e leva ${String(message.sentCount)} envio(s) de histórico. Para calar preservando o histórico, desligue a mensagem.`
                          }
                          onConfirm={() => void remove(message)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {logOf !== null && (
          <div className="border border-border bg-surface">
            <div className="border-b border-border px-3 py-2">
              <h2 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
                <span aria-hidden="true" className="h-4 w-[3px] shrink-0 bg-rust" />
                Ela está mesmo aparecendo?
              </h2>
            </div>

            <div className="p-3">
              {entries === null && <StateBlock variant="loading" title="Lendo…" />}

              {entries !== null && entries.length === 0 && (
                <StateBlock
                  variant="empty"
                  title="Esta mensagem ainda não saiu"
                  detail="O histórico guarda também as tentativas que falharam, com o motivo — mas o que não chegou a ser tentado (servidor parado, servidor vazio) não entra aqui: seriam milhares de linhas por semana."
                />
              )}

              {entries !== null && entries.length > 0 && (
                <ul className="divide-y divide-border">
                  {entries.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2 text-sm">
                      <span className="min-w-32">{entry.serverId}</span>
                      <span className="text-2xs text-muted" title={formatDateTime(entry.at)}>
                        {formatWhen(entry.at)}
                      </span>
                      <span className={cn('text-2xs', entry.ok ? 'text-muted' : 'text-amber')}>
                        {entry.ok
                          ? // Zero pelo `say` quer dizer DESCONHECIDO: o
                            // jogo não devolve quantos receberam.
                            entry.players === 0
                            ? 'saiu (o jogo não diz para quantos)'
                            : `saiu para ${String(entry.players)} jogador(es)`
                          : `não saiu — ${entry.error ?? 'sem motivo registrado'}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <p className="text-2xs leading-relaxed text-muted">
          O agente confere de <strong>30 em 30 segundos</strong> quem venceu. Com o servidor fora do
          ar — ou vazio, quando a mensagem exige gente — o horário <strong>não é consumido</strong>:
          ela sai assim que dá, em vez de sumir até a próxima volta. E{' '}
          <strong>testar não adia nada</strong>.
        </p>
      </div>

      {editing !== undefined && (
        <MessageDialog
          open
          message={editing}
          variables={variables}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * "em 12 min", "em 1h 04m", "25/08 02h".
 *
 * A coluna responde "quando é a próxima?", e é de relance. Uma data
 * completa obrigaria a fazer a conta de cabeça; passado um dia, a
 * conta inverte e a data é que localiza.
 */
function formatNext(iso: string): string {
  const at = Date.parse(iso);

  if (!Number.isFinite(at)) {
    return EM_DASH;
  }

  const seconds = Math.round((at - Date.now()) / 1000);

  // Já venceu: a próxima volta do relógio a pega. "há 3 min" na
  // coluna PRÓXIMA pareceria defeito.
  if (seconds <= 60) {
    return 'a qualquer momento';
  }

  if (seconds < 3_600) {
    return `em ${String(Math.floor(seconds / 60))} min`;
  }

  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);

    return `em ${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
  }

  return new Date(at).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
