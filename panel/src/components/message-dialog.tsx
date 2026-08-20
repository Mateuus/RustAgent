'use client';

// ============================================================
//  message-dialog.tsx  -  criar e editar uma fala do servidor.
//
//  ####  O RITMO É A DECISÃO CENTRAL DESTA CAIXA  ####
//
//  Os quatro modos são exclusivos, e por isso são um grupo de
//  rádio — não abas, não um select. Cada um mostra SÓ os campos
//  dele: um "a cada 30" ao lado de um "toda quinta às 16:00" faria
//  o admin preencher os dois e não saber qual valeu.
//
//      a cada N        minutos / horas / dias
//      todo dia às     HH:MM
//      toda <dia> às   HH:MM
//      uma vez em      data + hora
//
//  ####  O FUSO É DO CAMPO, E NÃO DO NAVEGADOR  ####
//
//  "16:00" mais `America/Sao_Paulo` — nunca um instante com fuso
//  embutido. É o que impede a mensagem deslizar uma hora sozinha em
//  novembro. O `once` é a única exceção, e ali a conversão para ISO
//  acontece com o fuso ESCOLHIDO, e não com o do host de quem
//  preenche: o admin pode estar em Lisboa.
//
//  ####  A PRÉVIA MOSTRA O QUE VAI SAIR  ####
//
//  Com a tag, a cor e o tamanho de verdade. Uma aparência que só
//  aparece dentro do jogo é uma aparência que ninguém confere — e o
//  botão "testar agora" existe para o resto.
// ============================================================

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { CHAT_COLORS, parseChatMarkup } from '@/lib/chat-markup';
import {
  agent,
  type Message,
  type MessageInput,
  type MessageVariables,
  type ScheduleKind,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** O teto do texto. O mesmo da rota — ver core/src/http/routes/messages.ts. */
const MAX_TEXT = 512;

/** O fuso padrão do projeto. Ver Docs/16 §14, decisão 7. */
const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

const KINDS: readonly { value: ScheduleKind; label: string }[] = [
  { value: 'interval', label: 'A cada' },
  { value: 'daily', label: 'Todo dia' },
  { value: 'weekly', label: 'Toda semana' },
  { value: 'once', label: 'Uma vez' },
];

/** 0 = domingo, como no contrato (core/src/types/messages.ts). */
const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'dom' },
  { value: 1, label: 'seg' },
  { value: 2, label: 'ter' },
  { value: 3, label: 'qua' },
  { value: 4, label: 'qui' },
  { value: 5, label: 'sex' },
  { value: 6, label: 'sáb' },
];

type Unit = 'minutos' | 'horas' | 'dias';

const UNIT_SECONDS: Readonly<Record<Unit, number>> = {
  minutos: 60,
  horas: 3600,
  dias: 86_400,
};

/**
 * Alguns fusos comuns, e não a lista IANA inteira.
 *
 * O agente aceita qualquer zona válida; a lista aqui é atalho. Um
 * combo com 400 entradas seria pior que quatro escolhas certas —
 * e quem precisa de outra digita.
 */
const TIME_ZONES: readonly string[] = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/New_York',
  'Europe/Lisbon',
  'UTC',
];

interface MessageDialogProps {
  readonly open: boolean;
  /** `null` = criar. Preenchido = editar aquela mensagem. */
  readonly message: Message | null;
  /** Os nomes que o agente sabe trocar, vindos do REGISTRO. */
  readonly variables: MessageVariables | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function MessageDialog({
  open,
  message,
  variables,
  onClose,
  onDone,
}: MessageDialogProps) {
  const [servers, setServers] = useState<string[]>([]);

  const [name, setName] = useState(message?.name ?? '');
  const [text, setText] = useState(message?.text ?? '');
  const [enabled, setEnabled] = useState(message?.enabled ?? true);
  const [kind, setKind] = useState<ScheduleKind>(message?.scheduleKind ?? 'interval');

  const initial = splitInterval(message?.everySeconds ?? 1800);

  const [every, setEvery] = useState(String(initial.amount));
  const [unit, setUnit] = useState<Unit>(initial.unit);
  const [timeOfDay, setTimeOfDay] = useState(message?.timeOfDay ?? '20:00');
  const [weekdays, setWeekdays] = useState<number[]>(message?.weekdays ?? [4]);
  const [onceDate, setOnceDate] = useState(toDateInput(message?.runAt ?? null));
  const [onceTime, setOnceTime] = useState(toTimeInput(message?.runAt ?? null));
  const [timeZone, setTimeZone] = useState(message?.timeZone ?? DEFAULT_TIME_ZONE);

  const [windowFrom, setWindowFrom] = useState(message?.windowFrom ?? '');
  const [windowTo, setWindowTo] = useState(message?.windowTo ?? '');
  const [onlyWithPlayers, setOnlyWithPlayers] = useState(message?.onlyWithPlayers ?? false);
  const [minPlayers, setMinPlayers] = useState(String(message?.minPlayers ?? 1));

  const [allServers, setAllServers] = useState((message?.targets ?? []).length === 0);
  const [chosen, setChosen] = useState<string[]>(message === null ? [] : [...message.targets]);

  const [tag, setTag] = useState(message?.tag ?? '');
  const [tagColor, setTagColor] = useState(message?.tagColor ?? '#ffcc00');
  const [color, setColor] = useState(message?.color ?? '#ffffff');
  const [size, setSize] = useState(String(message?.size ?? 15));

  const [busy, setBusy] = useState(false);

  /**
   * O campo de texto de verdade, e não uma cópia do valor.
   *
   * A cor é aplicada NA SELEÇÃO, e seleção é estado do DOM: sem a
   * referência, o botão de cor só saberia grudar o marcador no fim
   * da frase — que é justamente o que ninguém quer, porque a cor
   * quase sempre é de uma palavra do meio.
   */
  const textArea = useRef<HTMLTextAreaElement>(null);

  /**
   * Onde o cursor esteve pela última vez. `null` = ainda não esteve.
   *
   * Um textarea sem foco responde `selectionStart: 0`, e confiar
   * nisso faria a primeira cor cair no COMEÇO da frase — no lugar
   * mais errado possível, já que quem clica numa cor sem ter tocado
   * no texto está escrevendo do fim para a frente.
   */
  const selection = useRef<{ start: number; end: number } | null>(null);

  /** A última cor livre escolhida no seletor. */
  const [customColor, setCustomColor] = useState('#ff0000');

  /**
   * Envolve o que estiver selecionado em `[cor]…[/]`.
   *
   * Sem seleção, deixa o par vazio com o cursor DENTRO: quem clicou
   * na cor antes de escrever continua digitando e já sai colorido.
   *
   * Escrever o par por aqui, e não deixar o admin decorar a sintaxe,
   * é o ponto: `[/]` esquecido pinta o resto da frase, e a fileira
   * de cores nunca esquece.
   */
  function applyColor(marker: string): void {
    const field = textArea.current;
    const at = selection.current ?? { start: text.length, end: text.length };
    const start = Math.min(at.start, text.length);
    const end = Math.min(at.end, text.length);
    const inner = text.slice(start, end);
    const open = `[${marker}]`;
    const next = `${text.slice(0, start)}${open}${inner}[/]${text.slice(end)}`;

    // O teto é do agente, e ele recusaria a gravação inteira. Cortar
    // aqui seria pior: o admin perderia o texto sem entender por quê.
    if (next.length > MAX_TEXT) {
      toast.error(`A marcação não cabe: o texto passaria de ${String(MAX_TEXT)} caracteres.`);
      return;
    }

    setText(next);

    // Sem seleção o cursor fica DENTRO do par; com seleção, logo
    // depois do fechamento — nos dois casos onde a pessoa ia
    // continuar digitando.
    const cursor = inner === '' ? start + open.length : start + open.length + inner.length + 3;

    selection.current = { start: cursor, end: cursor };

    // O React só reescreve o campo no próximo quadro; mexer no
    // cursor antes disso seria mexer no texto antigo.
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(cursor, cursor);
    });
  }

  useEffect(() => {
    void (async () => {
      try {
        setServers((await agent.servers()).servers.map((server) => server.id));
      } catch {
        // Sem a lista, os checkboxes ficam vazios e o agente recusa
        // um servidor inventado. Não é motivo para fechar o
        // formulário — e "todos os servidores" continua funcionando.
      }
    })();
  }, []);

  function buildInput(): MessageInput {
    return {
      name: name.trim(),
      text: text.trim(),
      enabled,
      scheduleKind: kind,
      everySeconds: kind === 'interval' ? intervalSeconds(every, unit) : null,
      timeOfDay: kind === 'daily' || kind === 'weekly' ? timeOfDay : null,
      weekdays: kind === 'weekly' ? weekdays : [],
      runAt: kind === 'once' ? toIso(onceDate, onceTime, timeZone) : null,
      timeZone,
      // A janela é um PAR: um lado só preenchido é configuração pela
      // metade, e o agente a recusa dizendo isso. Aqui os dois
      // viram `null` juntos.
      windowFrom: windowFrom.trim() === '' || windowTo.trim() === '' ? null : windowFrom.trim(),
      windowTo: windowFrom.trim() === '' || windowTo.trim() === '' ? null : windowTo.trim(),
      onlyWithPlayers,
      minPlayers: Math.max(0, Number(minPlayers) || 0),
      tag: tag.trim() === '' ? null : tag.trim(),
      tagColor: tag.trim() === '' ? null : tagColor,
      color: color.trim() === '' ? null : color,
      size: Number(size) > 0 ? Number(size) : null,
      // Lista VAZIA quer dizer TODOS. É o que o admin espera de uma
      // mensagem de rede recém-criada.
      targets: allServers ? [] : chosen,
    };
  }

  async function submit(): Promise<void> {
    const input = buildInput();

    if (kind === 'once' && input.runAt === null) {
      toast.error('Falta a data', {
        description: 'Uma mensagem de uma vez só precisa da data e da hora em que ela sai.',
      });
      return;
    }

    setBusy(true);

    try {
      const response =
        message === null
          ? await agent.createMessage(input)
          : await agent.updateMessage(message.id, input);

      toast.success(message === null ? 'Mensagem criada' : 'Mensagem gravada', {
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

  /**
   * Manda agora, do formulário aberto.
   *
   * Só numa mensagem que JÁ existe: o teste manda o que está
   * gravado, e não o rascunho. Prometer o contrário exigiria uma
   * rota que aceita texto solto — e ela existe, mas é a de fala
   * avulsa, que não tem tag nem cor desta mensagem.
   */
  async function test(): Promise<void> {
    if (message === null) {
      return;
    }

    setBusy(true);

    try {
      const response = await agent.testMessage(message.id);
      const failed = response.reports.filter((report) => !report.ok);

      if (failed.length === 0) {
        toast.success('Saiu no chat', { description: response.detail });
      } else {
        toast.error('Nem todo servidor recebeu', {
          description: failed.map((report) => `${report.serverId}: ${report.error ?? ''}`).join(' · '),
        });
      }
    } catch (cause) {
      toast.error('Não consegui mandar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={message === null ? 'Nova mensagem' : `Mensagem ${message.name}`}
      busy={busy}
      onClose={onClose}
      className="w-[min(52rem,94vw)]"
    >
      <div className="space-y-3">
        <div>
          <Label>Nome</Label>
          <Input
            value={name}
            placeholder="Discord"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-1 text-2xs text-muted">
            É o nome da lista, de quem administra. O jogador nunca o vê.
          </p>
        </div>

        <div>
          <Label>Texto</Label>
          <textarea
            ref={textArea}
            value={text}
            rows={2}
            maxLength={MAX_TEXT}
            disabled={busy}
            onChange={(event) => {
              setText(event.target.value);
              selection.current = {
                start: event.target.selectionStart,
                end: event.target.selectionEnd,
              };
            }}
            // Clique, seta, arrastar: é aqui que o botão de cor
            // descobre em cima de QUE pedaço ele deve agir.
            onSelect={(event) => {
              selection.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            className="w-full border border-border bg-surface-2 px-3 py-2 text-sm text-foreground"
          />
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-2xs text-muted">
            <span className={cn(text.length > MAX_TEXT * 0.9 && 'text-amber')}>
              {text.length}/{MAX_TEXT}
            </span>
            <span>variáveis:</span>
            {/* A lista vem do REGISTRO do agente: quem registra o
                `{wipe.*}` é outra frente, e uma lista escrita à mão
                aqui ficaria mentindo no dia em que ela entrasse. */}
            {(variables?.names ?? []).map((variable) => (
              <VariableChip
                key={variable}
                token={`{${variable}}`}
                disabled={busy}
                onInsert={(token) => setText(`${text}${token}`)}
              />
            ))}
            {(variables?.namespaces ?? []).map((namespace) => (
              <span key={namespace} className="font-mono">
                {`{${namespace}.…}`}
              </span>
            ))}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Uma variável que o agente não conhece sai <strong>literal</strong> no chat — feio, e
            visível. Uma frase que perde metade em silêncio ninguém descobre.
          </p>

          {/* ---- A COR DE UM PEDAÇO SÓ ----

              A `Cor do texto`, lá embaixo, pinta a fala INTEIRA.
              Aqui é o outro caso, e é o mais pedido: destacar o
              número, a data, a palavra que importa.

              Os botões escrevem o PAR (`[verde]…[/]`) em volta do
              que estiver selecionado. Deixar o admin decorar a
              sintaxe seria deixá-lo esquecer o fechamento — e uma
              cor que não fecha pinta o resto da frase. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-muted">
            <span className="mr-0.5">cor de um trecho:</span>

            {Object.entries(CHAT_COLORS).map(([nome, hex]) => (
              <button
                key={nome}
                type="button"
                disabled={busy}
                title={`${nome} — pinta o trecho selecionado`}
                aria-label={`Pintar de ${nome}`}
                onClick={() => applyColor(nome)}
                className="h-4 w-4 border border-border hover:scale-110 disabled:opacity-40"
                style={{ backgroundColor: hex }}
              />
            ))}

            <span aria-hidden className="mx-1 h-4 w-px bg-border" />

            <input
              type="color"
              value={customColor}
              disabled={busy}
              aria-label="Escolher outra cor"
              onChange={(event) => setCustomColor(event.target.value)}
              className="h-4 w-7 cursor-pointer border border-border bg-transparent p-0"
            />

            <button
              type="button"
              disabled={busy}
              title="Pinta o trecho selecionado com este código"
              onClick={() => applyColor(customColor)}
              className="border border-border px-1 font-mono hover:text-foreground disabled:opacity-40"
            >
              {customColor}
            </button>
          </div>

          <p className="mt-1 text-2xs leading-relaxed text-muted">
            Selecione um pedaço e clique numa cor: o texto vira{' '}
            <code className="font-mono">
              Agora tem [verde]{'{online}'}[/]/{'{max}'}
            </code>
            . Só o trecho marcado muda — o resto segue a <strong>Cor do texto</strong>. Colchete que
            não é cor (<code className="font-mono">[AVISO]</code>) sai como está.
          </p>
        </div>

        {/* ---- QUANDO ---- */}
        <div className="border-t border-border pt-3">
          <Label>Quando</Label>

          <div className="flex flex-wrap items-stretch border border-border">
            {KINDS.map((option, index) => (
              <div key={option.value} className="flex items-stretch">
                {index > 0 && <span aria-hidden className="my-1.5 w-px bg-border" />}

                <button
                  type="button"
                  aria-pressed={kind === option.value}
                  disabled={busy}
                  onClick={() => setKind(option.value)}
                  className={cn(
                    'px-4 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                    kind === option.value
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-end gap-3">
            {kind === 'interval' && (
              <>
                <div>
                  <Label>A cada</Label>
                  <Input
                    type="number"
                    min={1}
                    value={every}
                    disabled={busy}
                    onChange={(event) => setEvery(event.target.value)}
                    className="w-24"
                  />
                </div>

                <select
                  value={unit}
                  disabled={busy}
                  onChange={(event) => setUnit(event.target.value as Unit)}
                  className="h-9 border border-border bg-surface-2 px-3 text-sm text-foreground"
                >
                  <option value="minutos">minutos</option>
                  <option value="horas">horas</option>
                  <option value="dias">dias</option>
                </select>

                <p className="max-w-72 text-2xs leading-relaxed text-muted">
                  A conta parte do horário <strong>previsto</strong>, e não do instante do envio:
                  &quot;a cada 30 min&quot; anda de 30 em 30 sem deriva acumulada.
                </p>
              </>
            )}

            {(kind === 'daily' || kind === 'weekly') && (
              <div>
                <Label>Às</Label>
                <Input
                  type="time"
                  value={timeOfDay}
                  disabled={busy}
                  onChange={(event) => setTimeOfDay(event.target.value)}
                  className="w-28"
                />
              </div>
            )}

            {kind === 'weekly' && (
              <div>
                <Label>Nos dias</Label>
                <div className="flex flex-wrap items-stretch border border-border">
                  {WEEKDAYS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      aria-pressed={weekdays.includes(day.value)}
                      disabled={busy}
                      onClick={() =>
                        setWeekdays(
                          weekdays.includes(day.value)
                            ? weekdays.filter((entry) => entry !== day.value)
                            : [...weekdays, day.value],
                        )
                      }
                      className={cn(
                        'px-3 py-2 font-condensed text-2xs font-bold uppercase tracking-wide',
                        weekdays.includes(day.value)
                          ? 'bg-surface-2 text-foreground'
                          : 'text-muted hover:text-foreground',
                      )}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {kind === 'once' && (
              <>
                <div>
                  <Label>Em</Label>
                  <Input
                    type="date"
                    value={onceDate}
                    disabled={busy}
                    onChange={(event) => setOnceDate(event.target.value)}
                    className="w-40"
                  />
                </div>

                <div>
                  <Label>Às</Label>
                  <Input
                    type="time"
                    value={onceTime}
                    disabled={busy}
                    onChange={(event) => setOnceTime(event.target.value)}
                    className="w-28"
                  />
                </div>

                <p className="max-w-72 text-2xs leading-relaxed text-muted">
                  Depois de sair, ela <strong>se desliga sozinha</strong>. Uma
                  &quot;manutenção às 03:00&quot; que continuasse ligada reapareceria no mês
                  seguinte, sem manutenção nenhuma.
                </p>
              </>
            )}
          </div>

          <div className="mt-2">
            <Label>Fuso</Label>
            <input
              list="message-time-zones"
              value={timeZone}
              disabled={busy}
              onChange={(event) => setTimeZone(event.target.value)}
              className="h-9 w-64 border border-border bg-surface-2 px-3 text-sm text-foreground"
            />
            <datalist id="message-time-zones">
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              O horário acima é lido NESTE fuso, e o agente guarda o instante em UTC. É o que impede
              a mensagem deslizar uma hora sozinha quando o fuso muda de offset.
            </p>
          </div>
        </div>

        {/* ---- SÓ ENTRE / SÓ COM JOGADORES ---- */}
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
              Com o servidor vazio o horário <strong>não é consumido</strong>: o primeiro jogador
              que entrar recebe a mensagem logo, em vez de esperar meia hora.
            </p>
          </div>
        </div>

        {/* ---- ONDE ---- */}
        <div className="border-t border-border pt-3">
          <Label>Onde ela sai</Label>

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

          {!allServers && chosen.length === 0 && (
            <p className="mt-1 text-2xs text-amber">
              Sem servidor nenhum marcado, esta mensagem não sai em lugar algum.
            </p>
          )}
        </div>

        {/* ---- APARÊNCIA ---- */}
        <div className="border-t border-border pt-3">
          <Label>Aparência</Label>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Tag</Label>
              <Input
                value={tag}
                placeholder="[AVISO]"
                disabled={busy}
                onChange={(event) => setTag(event.target.value)}
                className="w-32"
              />
            </div>

            <div>
              <Label>Cor da tag</Label>
              <Input
                value={tagColor}
                disabled={busy || tag.trim() === ''}
                onChange={(event) => setTagColor(event.target.value)}
                className="w-28 font-mono"
              />
            </div>

            <div>
              <Label>Cor do texto</Label>
              <Input
                value={color}
                disabled={busy}
                onChange={(event) => setColor(event.target.value)}
                className="w-28 font-mono"
              />
            </div>

            <div>
              <Label>Tamanho</Label>
              <Input
                type="number"
                min={8}
                max={40}
                value={size}
                disabled={busy}
                onChange={(event) => setSize(event.target.value)}
                className="w-20"
              />
            </div>
          </div>

          {/* A prévia usa as cores de VERDADE. Uma aparência que só
              aparece dentro do jogo é uma aparência que ninguém
              confere antes de mil pessoas a verem. */}
          <div className="mt-2 border border-border bg-background px-3 py-2">
            <span className="text-2xs uppercase tracking-wide text-muted">prévia</span>
            <p className="mt-1 break-words" style={{ fontSize: `${clampSize(size)}px` }}>
              {tag.trim() !== '' && (
                <span style={{ color: safeColor(tagColor, '#ffcc00') }}>{tag.trim()} </span>
              )}
              {text.trim() === '' ? (
                <span style={{ color: safeColor(color, '#ffffff') }}>o texto aparece aqui</span>
              ) : (
                // A prévia lê a marcação com a MESMA regra do agente
                // (lib/chat-markup.ts é o espelho de
                // core/src/game/chat-markup.ts). Uma prévia que
                // adivinha diferente é pior que prévia nenhuma.
                parseChatMarkup(text.trim()).map((span, index) => (
                  <span
                    key={index}
                    style={{ color: span.color ?? safeColor(color, '#ffffff') }}
                  >
                    {span.text}
                  </span>
                ))
              )}
            </p>
            <p className="mt-1 text-2xs text-muted">
              Sem o plugin OrigemZChat no servidor, a fala sai pelo <code>say</code> do jogo — sem
              cor, sem tamanho e sem os marcadores. Melhor que silêncio.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-3">
            <Toggle on={enabled} busy={busy} labels={['Ligada', 'Desligada']} onChange={setEnabled} />
            <span className="max-w-72 text-2xs leading-relaxed text-muted">
              Desligada, ela fica na lista e não sai.
            </span>
          </div>

          <div className="flex gap-2">
            {message !== null && (
              <Button variant="outline" disabled={busy} onClick={() => void test()}>
                Testar agora
              </Button>
            )}

            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancelar
            </Button>

            <Button
              variant="primary"
              disabled={busy || name.trim() === '' || text.trim() === ''}
              onClick={() => void submit()}
            >
              {busy ? 'Gravando…' : 'Gravar'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Um atalho que cola a variável no fim do texto. */
function VariableChip({
  token,
  disabled,
  onInsert,
}: {
  readonly token: string;
  readonly disabled: boolean;
  readonly onInsert: (token: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onInsert(token)}
      title={`Inserir ${token}`}
      className="border border-border px-1 font-mono text-2xs text-muted hover:text-foreground"
    >
      {token}
    </button>
  );
}

/**
 * 1800 -> `{ amount: 30, unit: 'minutos' }`.
 *
 * A maior unidade que divide certo: 7200 vira "2 horas", e não
 * "120 minutos". Quem administra pensa em horas.
 */
function splitInterval(seconds: number): { amount: number; unit: Unit } {
  if (seconds % UNIT_SECONDS.dias === 0) {
    return { amount: seconds / UNIT_SECONDS.dias, unit: 'dias' };
  }

  if (seconds % UNIT_SECONDS.horas === 0) {
    return { amount: seconds / UNIT_SECONDS.horas, unit: 'horas' };
  }

  return { amount: Math.max(1, Math.round(seconds / 60)), unit: 'minutos' };
}

function intervalSeconds(amount: string, unit: Unit): number {
  return Math.max(1, Math.round(Number(amount) || 0)) * UNIT_SECONDS[unit];
}

/** ISO -> `2026-08-25` no fuso de quem lê. Vazio quando não há. */
function toDateInput(iso: string | null): string {
  if (iso === null) {
    return '';
  }

  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

/** ISO -> `02:00`. */
function toTimeInput(iso: string | null): string {
  if (iso === null) {
    return '02:00';
  }

  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? '02:00' : parsed.toISOString().slice(11, 16);
}

/**
 * Data + hora + fuso -> ISO com offset.
 *
 * ####  O FUSO É O ESCOLHIDO, E NÃO O DO NAVEGADOR  ####
 *
 * `new Date('2026-08-25T02:00')` lê a hora no fuso do HOST. O admin
 * pode estar em Lisboa configurando um servidor brasileiro, e a
 * manutenção sairia quatro horas antes. A conta abaixo mede o
 * offset da zona escolhida naquele instante e corrige.
 */
function toIso(date: string, time: string, timeZone: string): string | null {
  if (date === '' || time === '') {
    return null;
  }

  const naive = Date.parse(`${date}T${time}:00Z`);

  if (Number.isNaN(naive)) {
    return null;
  }

  const instant = naive - offsetMinutes(naive, timeZone) * 60_000;
  // Segunda passada: a correção pode ter atravessado uma mudança de
  // horário de verão e caído num offset diferente do medido.
  const corrected = naive - offsetMinutes(instant, timeZone) * 60_000;

  return new Date(corrected).toISOString();
}

/** Quantos minutos aquela zona está à frente do UTC naquele instante. */
function offsetMinutes(epochMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(epochMs));

    const get = (type: Intl.DateTimeFormatPartTypes): number => {
      const found = parts.find((part) => part.type === type);
      return found === undefined ? 0 : Number(found.value);
    };

    const asIfUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );

    return (asIfUtc - Math.floor(epochMs / 1000) * 1000) / 60_000;
  } catch {
    // Zona que o navegador não conhece. O agente recusa a gravação
    // com uma frase clara — aqui a prévia não pode quebrar por isso.
    return 0;
  }
}

/** A prévia não deixa a fonte crescer sem limite. */
function clampSize(value: string): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? Math.min(28, Math.max(10, parsed)) : 14;
}

/**
 * Só hexadecimal entra no `style`.
 *
 * A mesma trava do core (game/chat.ts): o campo é texto que alguém
 * digita, e sem a conferência ele seria um caminho para injetar CSS
 * na tela de quem administra.
 */
function safeColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : fallback;
}
