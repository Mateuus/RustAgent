'use client';

// ============================================================
//  tab-mapas.tsx  -  a sub-aba MAPAS da aba WIPE.
//
//  Ela responde uma pergunta só: *qual mundo entra no lugar deste,
//  e como ele é?*
//
//  ------------------------------------------------------------
//  ####  A PRIMEIRA DA FILA É O PRÓXIMO MAPA  ####
//
//  Não há botão de "escolher": a ordem É a decisão. Por isso a
//  primeira entrada pronta aparece marcada, e por isso reordenar é
//  a ação mais visível da tela.
//
//  ####  E A ORDEM VIAJA INTEIRA  ####
//
//  As setas mexem numa cópia local e o "Gravar a ordem" manda a
//  fila TODA. Com movimento relativo, duas abas abertas produzem
//  uma ordem que nenhuma das duas pediu — a segunda aplicaria
//  "sobe o #3" sobre uma lista que já não é a que ela viu.
//
//  ####  FILA VAZIA NÃO É PROBLEMA  ####
//
//  É o estado normal de quem não quer curar mapa nenhum: o agente
//  sorteia na hora do wipe e registra o que sorteou. A tela diz
//  isso com todas as letras, porque uma faixa vermelha ali faria
//  o admin procurar um defeito que não existe.
//
//  ####  MAPA CUSTOM ENTRA COM TRAVA  ####
//
//  O agente confere a URL antes (responde? é .map? qual o
//  tamanho?), e mesmo conferida ela NÃO entra num wipe forçado
//  enquanto ninguém marcar, na mão, que o arquivo serve para a
//  versão nova do jogo. O forçado troca o binário — um .map de
//  ontem pode não carregar hoje, e o sintoma seria o servidor não
//  subir de madrugada, com o mundo velho já apagado.
// ============================================================

import { ArrowDown, ArrowUp, Dices, Link2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agent, type WipeMap } from '@/lib/api';
import { EM_DASH, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';

/** Espelha wipe/map-pool.ts do núcleo. O agente valida de novo. */
const MIN_WORLD_SIZE = 1_000;
const MAX_WORLD_SIZE = 6_000;
const DEFAULT_WORLD_SIZE = 4_000;

const LEVELS = ['Procedural Map', 'Barren', 'HapisIsland', 'Craggy Island'] as const;

/** Os tamanhos que aparecem como atalho. Qualquer valor é aceito. */
const SIZE_SHORTCUTS = [3000, 3500, 4000, 4500] as const;

function isQueued(map: WipeMap): boolean {
  return map.status !== 'used';
}

/** A linha de identificação do mundo, em uma frase. */
function describe(map: WipeMap): string {
  if (map.kind === 'custom') {
    return map.level === null || map.level === '' ? 'mapa custom' : `custom · ${map.level}`;
  }

  const level = map.level ?? 'Procedural Map';
  const size = map.worldSize === null ? EM_DASH : String(map.worldSize);

  return `${level === 'Procedural Map' ? 'procedural' : level} · ${size} · seed ${map.seed ?? EM_DASH}`;
}

/** O que o status quer dizer para quem olha a fila. */
function statusLabel(map: WipeMap): string {
  if (map.status === 'ready') {
    return map.previewUrl === null ? 'pronta' : 'pronta (com prévia)';
  }
  if (map.status === 'generating') {
    return 'gerando a prévia…';
  }
  if (map.status === 'used') {
    return map.usedAt === null ? 'já jogada' : `jogada em ${formatDateTime(isoOf(map.usedAt))}`;
  }
  if (map.status === 'failed') {
    return map.lastError ?? 'a geração da prévia falhou — a seed continua valendo';
  }

  return 'rascunho';
}

/** Epoch ms -> ISO, que é o que os formatadores do painel leem. */
function isoOf(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

export function TabMapas({ serverId }: { readonly serverId: string }) {
  const [maps, setMaps] = useState<WipeMap[] | null>(null);
  const [next, setNext] = useState<WipeMap | null>(null);
  const [willDraw, setWillDraw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** A ordem que a pessoa está montando. `null` = igual à gravada. */
  const [ordem, setOrdem] = useState<number[] | null>(null);

  const [seed, setSeed] = useState('');
  const [worldSize, setWorldSize] = useState(String(DEFAULT_WORLD_SIZE));
  const [level, setLevel] = useState<string>(LEVELS[0]);
  const [levelUrl, setLevelUrl] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await agent.wipeMaps(serverId);

      setMaps(response.maps);
      setNext(response.next);
      setWillDraw(response.willDraw);
      setOrdem(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const fila = (maps ?? []).filter(isQueued);
  const jogados = (maps ?? []).filter((map) => !isQueued(map));

  /** A fila na ordem da tela — a gravada, ou a que a pessoa arrastou. */
  const filaVisivel =
    ordem === null
      ? fila
      : ordem
          .map((id) => fila.find((map) => map.id === id))
          .filter((map): map is WipeMap => map !== undefined);

  function move(index: number, delta: number): void {
    const ids = filaVisivel.map((map) => map.id);
    const alvo = index + delta;

    if (alvo < 0 || alvo >= ids.length) {
      return;
    }

    const atual = ids[index];
    const trocado = ids[alvo];

    if (atual === undefined || trocado === undefined) {
      return;
    }

    ids[index] = trocado;
    ids[alvo] = atual;

    setOrdem(ids);
  }

  async function gravarOrdem(): Promise<void> {
    if (ordem === null) {
      return;
    }

    setBusy(true);

    try {
      const response = await agent.reorderWipeMaps(serverId, ordem);

      toast.success('Fila gravada', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui gravar a ordem', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function colar(): Promise<void> {
    const tamanho = Number(worldSize.trim());

    if (!Number.isInteger(tamanho) || tamanho < MIN_WORLD_SIZE || tamanho > MAX_WORLD_SIZE) {
      toast.error('Tamanho fora da faixa', {
        description: `O mundo vai de ${String(MIN_WORLD_SIZE)} a ${String(MAX_WORLD_SIZE)}.`,
      });
      return;
    }

    setBusy(true);

    try {
      const response = await agent.addWipeMap(serverId, {
        kind: 'procedural',
        seed: seed.trim() === '' ? null : seed.trim(),
        worldSize: tamanho,
        level,
      });

      toast.success('Na fila', { description: response.message });

      // Aviso NÃO é erro: a seed entrou, e a frase existe para o
      // admin não descobrir a repetição no dia do wipe.
      for (const warning of response.warnings) {
        toast.warning('Confira', { description: warning.message });
      }

      setSeed('');
      await load();
    } catch (cause) {
      toast.error('Não consegui pôr na fila', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function sortear(): Promise<void> {
    const tamanho = Number(worldSize.trim());

    setBusy(true);

    try {
      const response = await agent.drawWipeMap(serverId, {
        worldSize: Number.isInteger(tamanho) ? tamanho : DEFAULT_WORLD_SIZE,
        level,
      });

      toast.success('Sorteada', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui sortear', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function colarCustom(): Promise<void> {
    if (levelUrl.trim() === '') {
      return;
    }

    setBusy(true);

    try {
      const response = await agent.addWipeMap(serverId, {
        kind: 'custom',
        levelUrl: levelUrl.trim(),
      });

      toast.success('Mapa custom na fila', { description: response.message });
      setLevelUrl('');
      await load();
    } catch (cause) {
      toast.error('O link não passou na conferência', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function marcarVersao(map: WipeMap): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.markWipeMapVersion(serverId, map.id, !map.versionOk);

      toast.success('Marca gravada', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui marcar', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remover(map: WipeMap): Promise<void> {
    setBusy(true);

    try {
      const response = await agent.removeWipeMap(serverId, map.id);

      toast.success('Fora da fila', { description: response.message });
      await load();
    } catch (cause) {
      toast.error('Não consegui tirar da fila', {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="border border-border bg-surface px-3 py-2">
        <p className="max-w-3xl text-2xs leading-relaxed text-muted">
          Qual mundo entra no lugar deste. A <strong>primeira entrada pronta</strong> é o mapa do
          próximo wipe — a ordem é a decisão, e não há botão de escolher. Num mundo procedural a
          seed <strong>é</strong> o mapa: o terreno nasce no boot, sempre na versão certa do jogo.
        </p>
      </div>

      {error !== null && (
        <StateBlock variant="error" title="Não consegui ler a fila" detail={error} />
      )}

      {maps === null && error === null && <StateBlock variant="loading" title="Lendo a fila…" />}

      {/* ---- A FILA ---------------------------------------- */}
      <Section
        title="A fila"
        aside={
          ordem !== null && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void gravarOrdem()}>
              Gravar a ordem
            </Button>
          )
        }
      >
        {maps !== null && filaVisivel.length === 0 && (
          <StateBlock
            variant="empty"
            title="Nenhum mapa esperando — e isso não trava wipe nenhum"
            detail="Na hora do wipe o agente sorteia uma seed, usa, e registra que sorteou. Curar a fila é escolha, e não obrigação."
          />
        )}

        <ul className="space-y-2">
          {filaVisivel.map((map, index) => {
            const proximo = next !== null && next.id === map.id;

            return (
              <li
                key={map.id}
                className={
                  'flex flex-wrap items-center gap-3 border px-3 py-2 ' +
                  (proximo ? 'border-rust bg-surface-2' : 'border-border bg-surface-2')
                }
              >
                {/* A miniatura do RustMaps quando existe; a moldura
                    vazia quando não — prévia é enfeite, e a falta
                    dela não pode parecer defeito. */}
                {map.thumbUrl === null ? (
                  <span
                    aria-hidden="true"
                    className="flex h-12 w-12 shrink-0 items-center justify-center border border-border text-2xs text-muted"
                  >
                    {map.kind === 'custom' ? '.map' : 'seed'}
                  </span>
                ) : (
                  // `<img>`, e não o `<Image>` do Next: o
                  // otimizador dele não existe num export
                  // estático, e a miniatura vem de um host de
                  // fora (o RustMaps) que ele não conseguiria
                  // processar de todo jeito.
                  <img
                    src={map.thumbUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-12 w-12 shrink-0 border border-border object-cover"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <p className="font-condensed text-sm font-bold uppercase tracking-wide">
                    <span className="text-muted">#{index + 1}</span>{' '}
                    <span className="font-mono normal-case tracking-normal">{describe(map)}</span>
                    {proximo && <span className="ml-2 text-2xs text-rust">PRÓXIMO WIPE</span>}
                  </p>

                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                    <span>{statusLabel(map)}</span>

                    {map.monuments !== null && map.monuments.length > 0 && (
                      <span>
                        {map.monuments.length} monumentos · {map.monuments.slice(0, 3).join(', ')}
                      </span>
                    )}

                    {map.note !== null && <span>{map.note}</span>}

                    {map.kind === 'custom' && (
                      <span className={map.versionOk ? 'text-olive' : 'text-amber'}>
                        {map.versionOk
                          ? 'marcado como compatível com a versão nova'
                          : 'não entra em wipe FORÇADO enquanto ninguém marcar que é compatível'}
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {map.kind === 'custom' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void marcarVersao(map)}
                    >
                      {map.versionOk ? 'Tirar a marca' : 'Marcar compatível'}
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Subir ${describe(map)}`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" className="h-4 w-4" />
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Descer ${describe(map)}`}
                    disabled={busy || index === filaVisivel.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" className="h-4 w-4" />
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Tirar ${describe(map)} da fila`}
                    disabled={busy}
                    onClick={() => void remover(map)}
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        {willDraw && filaVisivel.length > 0 && (
          <p className="mt-2 text-2xs leading-relaxed text-amber">
            Nenhuma entrada está <strong>pronta</strong>: no próximo wipe o agente sorteia mesmo
            assim, e registra o que sorteou.
          </p>
        )}
      </Section>

      {/* ---- PÔR UM MUNDO NA FILA -------------------------- */}
      <Section title="Pôr um mundo na fila">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <label className="block">
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide">Seed</span>

            <Input
              inputMode="numeric"
              value={seed}
              disabled={busy}
              placeholder="vazio = o agente sorteia"
              onChange={(event) => setSeed(event.target.value)}
              className="mt-1 font-mono"
            />

            <span className="mt-1 block text-2xs leading-relaxed text-muted">
              É o número que o rustmaps.com mostra no endereço do mapa. Mesma seed com o mesmo
              tamanho dá exatamente o mesmo mundo.
            </span>
          </label>

          <label className="block">
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
              Tamanho
            </span>

            <Input
              inputMode="numeric"
              value={worldSize}
              disabled={busy}
              onChange={(event) => setWorldSize(event.target.value)}
              className="mt-1 w-28 font-mono"
            />

            <span className="mt-1 flex flex-wrap gap-1">
              {SIZE_SHORTCUTS.map((size) => (
                <button
                  key={size}
                  type="button"
                  disabled={busy}
                  onClick={() => setWorldSize(String(size))}
                  className="border border-border px-1 text-2xs text-muted hover:text-foreground"
                >
                  {size}
                </button>
              ))}
            </span>
          </label>

          <label className="block">
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide">Mundo</span>

            <select
              value={level}
              disabled={busy}
              onChange={(event) => setLevel(event.target.value)}
              className="mt-1 h-9 w-full border border-border bg-surface-2 px-2 text-sm text-foreground"
            >
              {LEVELS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void colar()}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Pôr na fila
          </Button>

          <Button variant="outline" size="sm" disabled={busy} onClick={() => void sortear()}>
            <Dices aria-hidden="true" className="h-4 w-4" />
            Sortear uma
          </Button>

          <span className="text-2xs leading-relaxed text-muted">
            O sorteio evita o que já está na fila e o que os últimos wipes usaram.
          </span>
        </div>
      </Section>

      {/* ---- MAPA CUSTOM ----------------------------------- */}
      <Section title="Mapa custom (arquivo .map)">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="font-condensed text-2xs font-bold uppercase tracking-wide">
              Link do arquivo
            </span>

            <Input
              value={levelUrl}
              disabled={busy}
              placeholder="https://…/mundo.map"
              onChange={(event) => setLevelUrl(event.target.value)}
              className="mt-1 font-mono"
            />
          </label>

          <Button
            variant="outline"
            size="sm"
            disabled={busy || levelUrl.trim() === ''}
            onClick={() => void colarCustom()}
          >
            <Link2 aria-hidden="true" className="h-4 w-4" />
            Conferir e pôr na fila
          </Button>
        </div>

        <p className="mt-2 max-w-3xl text-2xs leading-relaxed text-muted">
          O agente confere o link <strong>antes</strong> de aceitar: responde? termina em
          <code className="mx-1 font-mono">.map</code>? qual o tamanho? Mesmo conferido, ele{' '}
          <strong>não entra num wipe forçado</strong> enquanto ninguém marcar que o arquivo serve
          para a versão nova do jogo — o forçado troca o binário, e um mapa de ontem pode não
          carregar hoje. Mundo procedural não tem esse problema: quem o gera é o servidor, no boot.
        </p>
      </Section>

      {/* ---- JÁ JOGADOS ------------------------------------ */}
      {jogados.length > 0 && (
        <Section title="Já jogados">
          <ul className="space-y-1">
            {jogados.map((map) => (
              <li
                key={map.id}
                className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted"
              >
                <span className="font-mono">{describe(map)}</span>
                <span>{formatDateTime(isoOf(map.usedAt))}</span>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-2xs leading-relaxed text-muted">
            Esta lista não se apaga: ela é a única memória de qual mundo cada wipe gerou, e é o que
            avisa quando uma seed repetida volta para a fila.
          </p>
        </Section>
      )}
    </div>
  );
}
