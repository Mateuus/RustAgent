'use client';

// ============================================================
//  tab-configuracao.tsx  -  "como o agente executa?"
//
//  Avisa em quanto tempo antes, espera quanto para o servidor
//  esvaziar, copia o save antes de apagar, e quais dados de plugin
//  o full wipe leva.
//
//  ####  A LISTA DO FULL WIPE É LIDA DO DISCO  ####
//
//  Ela não é uma lista escrita à mão neste arquivo: o agente varre
//  `oxide\data` e os `.db` da pasta do save e devolve o que EXISTE,
//  com tamanho e data. E NADA vem marcado — o `OrigemZVip.json` é
//  o VIP que alguém pagou, e um full wipe indiscriminado não
//  devolve servidor novo, devolve chargeback.
//
//  ####  E O QUE SUMIU DO DISCO CONTINUA MARCADO  ####
//
//  Um plugin desinstalado tira o `.json` da pasta, e a escolha do
//  admin continua salva — ela reaparece marcada no dia em que o
//  plugin voltar. Apagar a escolha porque o arquivo não estava lá
//  naquele dia é como se perde uma configuração em silêncio.
//
//  ####  MAS A CAIXA TEM DE OBEDECER AO CLIQUE  ####
//
//  A linha é um arquivo e a lista salva é de PADRÕES: a marca pode
//  vir do caminho exato, de um satélite (`...db-wal`) ou de um
//  glob. Enquanto o clique tirava `file.path` da lista, desmarcar
//  uma linha marcada por outro padrão devolvia a lista IDÊNTICA e
//  a caixa voltava marcada — sem campo livre de padrão na tela,
//  não sobrava saída nenhuma. Quem conserta isso é
//  `patternsAfterToggle`, com o `selectedBy` que o agente manda.
// ============================================================

import { AlertTriangle, MessageSquare, Plus, Save, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { patternsAfterToggle, selectionNote } from '@/components/wipe/labels';
import {
  agent,
  type WipeExecSettings,
  type WipePluginDataFile,
  type WipePluginDataResponse,
} from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** Os atalhos de aviso, em minutos. O admin acrescenta os dele. */
const OFFSET_SHORTCUTS = [1440, 720, 360, 60, 30, 15, 5, 1];

export function TabConfiguracao({ serverId }: { readonly serverId: string }) {
  const [settings, setSettings] = useState<WipeExecSettings | null>(null);
  const [disk, setDisk] = useState<WipePluginDataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [novoOffset, setNovoOffset] = useState('');
  const [testando, setTestando] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await agent.wipeExecSettings(serverId);

      setSettings(response.settings);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }

    try {
      setDisk(await agent.wipePluginData(serverId));
    } catch {
      // A lista do disco é a SEGUNDA leitura: sem ela a
      // configuração acima continua valendo, e a seção diz que não
      // conseguiu varrer a pasta em vez de mostrar uma lista vazia
      // — que pareceria "não há nada para apagar".
      setDisk(null);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: WipeExecSettings) => {
      setBusy(true);
      // Otimista: a lista de arquivos marcados precisa responder ao
      // clique, e o agente devolve o estado gravado logo em seguida.
      setSettings(next);

      try {
        const response = await agent.saveWipeExecSettings(serverId, next);

        setSettings(response.settings);
        toast.success('Configuração salva', { description: response.message });
        setDisk(await agent.wipePluginData(serverId));
      } catch (cause) {
        toast.error('Não deu para salvar', {
          description: cause instanceof Error ? cause.message : String(cause),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, serverId],
  );

  /**
   * Manda o texto do aviso AGORA, pelo caminho de verdade.
   *
   * Nada é gravado: `POST /chat/broadcast` é uma fala avulsa, e ela
   * não mexe em execução, em agenda nem no horário de mensagem
   * nenhuma. A resposta traz o texto JÁ resolvido — é ela que
   * responde "o {wipe.faltam} está pegando?" sem esperar o wipe.
   */
  const testarNoChat = useCallback(async () => {
    if (settings === null) {
      return;
    }

    setTestando(true);

    try {
      const response = await agent.broadcastChat({
        serverId,
        text: settings.announce.text,
        tag: settings.announce.tag,
        tagColor: settings.announce.tagColor,
        color: settings.announce.color,
        size: settings.announce.size,
      });

      // O texto resolvido vai na descrição de propósito: um "enviado"
      // sozinho não mostra que a variável virou número.
      toast.success('Aviso enviado ao chat', { description: response.text });
    } catch (cause) {
      // Servidor parado, RCON caído, plugin fora do ar: o teste
      // falhar é justamente o que ele existe para descobrir — e
      // ANTES do wipe, e não durante.
      toast.error('Não deu para falar no chat', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setTestando(false);
    }
  }, [serverId, settings]);

  if (loading) {
    return <StateBlock variant="loading" title="Consultando o agente…" />;
  }

  if (error !== null || settings === null) {
    return (
      <StateBlock
        variant="error"
        title="Não consegui ler a configuração de execução."
        detail={error ?? 'O agente respondeu sem a configuração.'}
      />
    );
  }

  const toggleFile = (file: WipePluginDataFile): void => {
    void save({
      ...settings,
      pluginData: {
        ...settings.pluginData,
        patterns: patternsAfterToggle(settings.pluginData.patterns, file),
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* ---- AVISOS ANTES ---- */}
      <Section title="Avisos antes">
        <div className="space-y-3">
          <div>
            <Label>Avisar em</Label>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {settings.announce.offsetsMinutes.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void save({
                      ...settings,
                      announce: {
                        ...settings.announce,
                        offsetsMinutes: settings.announce.offsetsMinutes.filter(
                          (value) => value !== minutes,
                        ),
                      },
                    });
                  }}
                  className="flex items-center gap-1 border border-border bg-surface-2 px-2 py-1 text-2xs text-foreground hover:border-rust"
                >
                  {humanMinutes(minutes)}
                  <X aria-hidden className="h-3 w-3" />
                </button>
              ))}

              {settings.announce.offsetsMinutes.length === 0 && (
                <span className="text-2xs text-muted">
                  nenhum — o wipe acontece sem aviso no chat
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <Label htmlFor="novo-offset">Minutos antes</Label>
              <Input
                id="novo-offset"
                inputMode="numeric"
                value={novoOffset}
                onChange={(event) => setNovoOffset(event.target.value)}
              />
            </div>
            <Button
              size="md"
              disabled={busy}
              onClick={() => {
                const minutes = Number(novoOffset.trim());

                if (!Number.isFinite(minutes) || minutes < 1) {
                  toast.error('Minutos inválidos', {
                    description: 'Um aviso é "quantos minutos ANTES do wipe" — um número maior que zero.',
                  });
                  return;
                }

                setNovoOffset('');
                void save({
                  ...settings,
                  announce: {
                    ...settings.announce,
                    offsetsMinutes: [
                      ...new Set([...settings.announce.offsetsMinutes, Math.round(minutes)]),
                    ].sort((a, b) => b - a),
                  },
                });
              }}
            >
              <Plus aria-hidden className="mr-1 h-4 w-4" />
              acrescentar
            </Button>

            <div className="flex flex-wrap items-center gap-1">
              {OFFSET_SHORTCUTS.filter(
                (minutes) => !settings.announce.offsetsMinutes.includes(minutes),
              ).map((minutes) => (
                <Button
                  key={minutes}
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void save({
                      ...settings,
                      announce: {
                        ...settings.announce,
                        offsetsMinutes: [...settings.announce.offsetsMinutes, minutes].sort(
                          (a, b) => b - a,
                        ),
                      },
                    });
                  }}
                >
                  +{humanMinutes(minutes)}
                </Button>
              ))}
            </div>
          </div>

          <TextField
            id="aviso-texto"
            label="Texto do aviso"
            value={settings.announce.text}
            busy={busy}
            hint="As variáveis são resolvidas no envio: {wipe.faltam}, {wipe.quando}, {wipe.mapa}, {wipe.bp}. O que o agente não conhece fica LITERAL no chat — nunca vira vazio."
            onSave={(text) => void save({ ...settings, announce: { ...settings.announce, text } })}
          />

          <div className="grid gap-2 sm:grid-cols-4">
            <TextField
              id="aviso-tag"
              label="Tag"
              value={settings.announce.tag}
              busy={busy}
              onSave={(tag) => void save({ ...settings, announce: { ...settings.announce, tag } })}
            />
            <TextField
              id="aviso-tagcolor"
              label="Cor da tag"
              value={settings.announce.tagColor}
              busy={busy}
              onSave={(tagColor) =>
                void save({ ...settings, announce: { ...settings.announce, tagColor } })
              }
            />
            <TextField
              id="aviso-color"
              label="Cor do texto"
              value={settings.announce.color}
              busy={busy}
              onSave={(color) => void save({ ...settings, announce: { ...settings.announce, color } })}
            />
            <TextField
              id="aviso-size"
              label="Tamanho"
              value={String(settings.announce.size)}
              busy={busy}
              onSave={(raw) => {
                const size = Number(raw);

                if (Number.isFinite(size) && size >= 8 && size <= 40) {
                  void save({ ...settings, announce: { ...settings.announce, size } });
                }
              }}
            />
          </div>

          <p className="text-2xs text-muted">
            A APARÊNCIA é aplicada pelo plugin, e não pelo agente: ele manda o texto cru mais estes
            campos. Formatar dos dois lados criaria duas verdades sobre como um aviso se parece.
          </p>

          {/*
            ####  TESTAR É VER O AVISO DE VERDADE  ####

            O botão manda a fala AGORA, pelo mesmo transporte e com a
            mesma resolução de variáveis do aviso automático — e não
            uma prévia montada aqui no navegador. Uma prévia local
            responderia "o texto está bonito?"; a pergunta que custa
            caro é outra: "o {wipe.faltam} está pegando neste
            servidor?". Só o agente sabe responder isso.

            Ele NÃO abre um segundo caminho de envio: é a rota avulsa
            do módulo de mensagens, que chama o mesmo `Broadcaster`.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="md"
              variant="ghost"
              disabled={busy || testando || settings.announce.text.trim() === ''}
              onClick={() => {
                void testarNoChat();
              }}
            >
              <MessageSquare aria-hidden className="mr-1 h-4 w-4" />
              testar no chat agora
            </Button>
            <span className="text-2xs text-muted">
              A fala sai no chat de quem está online neste servidor, com as variáveis já resolvidas.
            </span>
          </div>
        </div>
      </Section>

      {/* ---- ESVAZIAR ---- */}
      <Section title="Esvaziar o servidor">
        <div className="space-y-3">
          <Row
            label="Avisar e esperar a saída"
            hint="O agente anuncia, espera, e só então manda o quit — que salva o mundo antes de sair."
          >
            <Toggle
              on={settings.drain.enabled}
              busy={busy}
              label="Esvaziar antes de parar"
              onChange={(enabled) => void save({ ...settings, drain: { ...settings.drain, enabled } })}
            />
          </Row>

          <div className="w-40">
            <TextField
              id="drain-espera"
              label="Esperar até (minutos)"
              value={String(settings.drain.waitMinutes)}
              busy={busy || !settings.drain.enabled}
              onSave={(raw) => {
                const waitMinutes = Number(raw);

                if (Number.isFinite(waitMinutes) && waitMinutes >= 0 && waitMinutes <= 60) {
                  void save({ ...settings, drain: { ...settings.drain, waitMinutes } });
                }
              }}
            />
          </div>

          <Row
            label="Matar o processo se o RCON não responder"
            hint="Perde TUDO desde o último save automático. Sem isto, um servidor com o RCON caído faz o wipe parar no passo `parar` — e é o desfecho certo, porque nada foi apagado ainda."
            danger
          >
            <Toggle
              on={settings.drain.force}
              busy={busy}
              label="Matar o processo"
              onChange={(force) => void save({ ...settings, drain: { ...settings.drain, force } })}
            />
          </Row>
        </div>
      </Section>

      {/* ---- BACKUP ---- */}
      <Section title="Backup">
        <div className="space-y-3">
          <Row
            label="Copiar o save antes de apagar"
            hint="É a única volta atrás que existe. O agente confere o espaço em disco ANTES de parar o servidor — falhar o backup com o servidor já parado é o pior desfecho possível."
          >
            <Toggle
              on={settings.backup.enabled}
              busy={busy}
              label="Fazer backup"
              onChange={(enabled) =>
                void save({ ...settings, backup: { ...settings.backup, enabled } })
              }
            />
          </Row>

          {!settings.backup.enabled && (
            <StateBlock
              variant="error"
              title="Sem backup, o wipe não tem volta."
              detail="Nenhum arquivo apagado poderá ser restaurado — nem se a política estiver errada, nem se for o servidor errado."
            />
          )}

          <div className="w-40">
            <TextField
              id="backup-keep"
              label="Manter os últimos"
              value={String(settings.backup.keep)}
              busy={busy || !settings.backup.enabled}
              onSave={(raw) => {
                const keep = Number(raw);

                if (Number.isFinite(keep) && keep >= 1 && keep <= 30) {
                  void save({ ...settings, backup: { ...settings.backup, keep } });
                }
              }}
            />
          </div>
        </div>
      </Section>

      {/* ---- FULL WIPE ---- */}
      <Section
        title="Dados de plugin (full wipe)"
        aside={
          <Toggle
            on={settings.pluginData.enabled}
            busy={busy}
            label="Apagar dados de plugin"
            onChange={(enabled) =>
              void save({ ...settings, pluginData: { ...settings.pluginData, enabled } })
            }
          />
        }
      >
        <div className="space-y-3">
          <p className="flex items-start gap-2 text-2xs text-muted">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-rust" />
            Nunca é &quot;apagar tudo&quot;: o VIP que alguém pagou mora aí. O agente só leva o que
            estiver marcado abaixo, item a item.
          </p>

          {disk === null ? (
            <StateBlock
              variant="error"
              title="Não consegui varrer as pastas deste servidor."
              detail="A lista abaixo é lida do disco. Sem ela, o que já estiver marcado continua valendo — o que não dá é escolher novos itens agora."
            />
          ) : disk.files.length === 0 ? (
            <StateBlock
              variant="empty"
              title="Não há dado de plugin nesta máquina."
              detail="O agente varreu oxide\data e os .db da pasta do save e não achou nada que o wipe já não leve pela política."
            />
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto">
              {disk.files.map((file) => {
                // Quem segura a marca desta linha, quando não é o
                // caminho dela. O admin precisa ler isso ANTES de
                // clicar: é o que o clique vai remover da lista.
                const nota = selectionNote(file, disk.files);

                return (
                  <li key={file.path}>
                    <label className="flex cursor-pointer items-baseline gap-2 border-b border-border py-1 last:border-0">
                      <input
                        type="checkbox"
                        checked={file.selected}
                        disabled={busy}
                        onChange={() => toggleFile(file)}
                        className="mt-1 shrink-0"
                      />
                      <span
                        className={cn(
                          'min-w-0 break-all font-mono text-2xs',
                          file.selected ? 'text-foreground' : 'text-muted',
                        )}
                      >
                        {file.path}
                        {/* O satélite não é uma escolha à parte: marcar
                            o banco leva o `-wal` junto, e é isso que
                            impede um banco pela metade. */}
                        {file.companions.length > 0 && (
                          <span className="text-muted"> + {file.companions.length} satélite(s)</span>
                        )}
                        {nota !== null && <span className="block text-muted">{nota}</span>}
                      </span>
                      <span className="ml-auto shrink-0 text-2xs text-muted">
                        {kb(file.bytes)} · {stamp(file.modifiedAt)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {/* ---- O QUE A LISTA NÃO ESTÁ MOSTRANDO ---- */}
          {disk !== null && disk.truncated && (
            <StateBlock
              variant="empty"
              title={`A lista mostra ${String(disk.files.length)} de ${String(disk.total)} arquivos.`}
              detail="O corte é só da tela — os marcados vêm na frente. O wipe apaga TUDO o que casa com os padrões marcados, e não só o que coube aqui."
            />
          )}

          {disk !== null && disk.notScanned.length > 0 && (
            <StateBlock
              variant="empty"
              title="Há pastas fundas demais que o agente não varreu."
              detail={
                <>
                  {disk.notScanned.join(', ')}. O que está dentro delas não aparece nesta lista, e o
                  full wipe não vai levar.
                  {/* "Não olhei" não é "não existe": estes marcados
                      ficam FORA do bloco de ausentes, que diz o
                      contrário sobre o mesmo caminho. */}
                  {disk.maybeTooDeep.length > 0 && (
                    <>
                      {' '}
                      E há {disk.maybeTooDeep.length} item(ns) marcado(s) que pode(m) estar aí
                      dentro: {disk.maybeTooDeep.join(', ')}. Eles não estão ausentes — vão
                      continuar em disco depois do wipe.
                    </>
                  )}
                </>
              }
            />
          )}

          {disk !== null && disk.missing.length > 0 && (
            <StateBlock
              variant="empty"
              title="Itens marcados que não existem mais em disco."
              detail={
                <>
                  {disk.missing.join(', ')}. A escolha CONTINUA salva: se o plugin voltar a ser
                  instalado, o arquivo volta marcado. Apagar num arquivo ausente é sucesso, e não
                  erro.
                </>
              }
            />
          )}
        </div>
      </Section>

      {/* ---- DEPOIS DE SUBIR ---- */}
      <Section title="Depois de subir">
        <div className="space-y-3">
          <Row
            label="Ressincronizar VIP, loadouts, kits e interface"
            hint="O cache desses plugins vive na memória deles, e o wipe derruba o RCON junto. Sem isto, o mundo novo sobe com os plugins sem saber de nada até alguém sincronizar à mão."
          >
            <Toggle
              on={settings.post.resync}
              busy={busy}
              label="Ressincronizar"
              onChange={(resync) => void save({ ...settings, post: { ...settings.post, resync } })}
            />
          </Row>

          <Row label="Anunciar o mundo novo no chat" hint="Sai pelo mesmo transporte dos avisos.">
            <Toggle
              on={settings.post.announce}
              busy={busy}
              label="Anunciar"
              onChange={(announce) =>
                void save({ ...settings, post: { ...settings.post, announce } })
              }
            />
          </Row>

          <TextField
            id="pos-texto"
            label="Texto do anúncio"
            value={settings.post.announceText}
            busy={busy || !settings.post.announce}
            onSave={(announceText) =>
              void save({ ...settings, post: { ...settings.post, announceText } })
            }
          />
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------
//  Peças
// ------------------------------------------------------------

function Row({
  label,
  hint,
  danger,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly danger?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className={cn('text-sm', danger === true ? 'text-foreground' : 'text-foreground')}>
          {label}
        </p>
        <p className="text-2xs text-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * Um campo que grava no `blur` e no Enter.
 *
 * Gravar a cada tecla mandaria uma requisição por caractere; um
 * botão "salvar" por campo encheria a tela de botões. O `blur` é o
 * meio-termo que o resto do painel já usa.
 */
function TextField({
  id,
  label,
  value,
  busy,
  hint,
  onSave,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly busy: boolean;
  readonly hint?: string;
  readonly onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // O valor do agente vence o rascunho quando ele muda por fora —
  // um salvamento que o agente normalizou, por exemplo.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== value) {
              onSave(draft);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft !== value) {
              onSave(draft);
            }
          }}
        />
        {draft !== value && (
          <Button size="sm" disabled={busy} onClick={() => onSave(draft)} aria-label="Salvar">
            <Save aria-hidden className="h-3 w-3" />
          </Button>
        )}
      </div>
      {hint !== undefined && <p className="text-2xs text-muted">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------
//  Formatação
// ------------------------------------------------------------

function humanMinutes(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return `${String(minutes / 1440)} d`;
  }

  if (minutes >= 60 && minutes % 60 === 0) {
    return `${String(minutes / 60)} h`;
  }

  return `${String(minutes)} min`;
}

function kb(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

function stamp(at: number): string {
  return new Date(at).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
