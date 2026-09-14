'use client';

// ============================================================
//  betterloot-rebuild-dialog.tsx  -  refazer a base do loot.
//
//  ####  POR QUE ISTO EXISTE  ####
//
//  O BetterLoot lê a tabela nativa do jogo UMA vez, quando cria a
//  entrada do prefab (`LoadAllContainers`). Dali em diante o
//  arquivo é a única verdade que ele conhece — e meses depois a
//  configuração de um servidor de produção tem caixa sem item
//  nenhum, caixa presa em "JOGO" desde um update do Rust, e perfil
//  citado que não existe mais.
//
//  Consertar isso caixa a caixa é o que o editor já faz. São 111
//  caixas. Esta caixa de diálogo faz o contrário: manda o PLUGIN
//  gerar a base outra vez, do jogo de agora, e devolve por cima
//  dela o que era da casa.
//
//  ####  A TELA PRECISA DIZER O QUE SE PERDE  ####
//
//  Não "isto é irreversível" — o que se perde, nome por nome. O
//  quadro dos dois modos é a peça central desta caixa, e ele vem
//  ANTES do botão de propósito: quem lê "a quantidade que você
//  ajustou volta ao do jogo" e desiste economizou um backup.
//
//  ####  E A PALAVRA DIGITADA NÃO É TEATRO  ####
//
//  Ela é diferente por modo ("REFAZER" e "RESETAR") porque o
//  `factory` apaga os perfis e o `merge` não. Um botão só, com
//  dois cliques, deixaria os dois à mesma distância da mão.
// ============================================================

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import {
  agent,
  type BetterLootRebuildMode,
  type BetterLootRebuildResponse,
} from '@/lib/api';

/** A palavra de cada modo. A mesma tabela vive no agente. */
const CONFIRM: Record<BetterLootRebuildMode, string> = {
  merge: 'REFAZER',
  factory: 'RESETAR',
};

interface BetterLootRebuildDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly serverId: string;
  /** Chamado depois de concluir: a tela inteira precisa reler o disco. */
  readonly onDone: () => void;
}

export function BetterLootRebuildDialog({
  open,
  onClose,
  serverId,
  onDone,
}: BetterLootRebuildDialogProps) {
  const [mode, setMode] = useState<BetterLootRebuildMode>('merge');
  const [adopt, setAdopt] = useState(true);
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BetterLootRebuildResponse | null>(null);

  const expected = CONFIRM[mode];
  const armed = typed.trim().toUpperCase() === expected;

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);

    try {
      const response = await agent.rebuildBetterLoot(serverId, {
        mode,
        adopt,
        confirm: expected,
      });

      setResult(response);
      // A lista, os globais e a caixa aberta ficaram todos velhos:
      // o arquivo no disco é outro.
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  const close = (): void => {
    setResult(null);
    setError(null);
    setTyped('');
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="Refazer a base do loot"
      busy={running}
      onClose={close}
      className="max-w-3xl"
    >
      {result !== null ? (
        <RebuildReport result={result} onClose={close} />
      ) : (
        <div className="space-y-4">
          <p className="text-2xs leading-relaxed text-muted">
            Quem gera a base nova é o <strong>próprio BetterLoot</strong>: o agente tira o{' '}
            <span className="font-mono">LootTables.json</span> do caminho e recarrega o plugin, que
            o escreve outra vez lendo o jogo deste servidor. Por isso a base nunca fica velha — e
            por isso <strong>o servidor precisa estar no ar</strong>.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <ModeCard
              picked={mode === 'merge'}
              title="Refazer a base"
              summary="A lista de itens do jogo volta em todas as caixas, e o que é da casa volta por cima dela."
              keeps={[
                'itens da casa (skin, troféu, chave com {1})',
                'os perfis ligados a cada caixa, com chance e teto',
                'o travamento de pool e o "ignorar raridade"',
              ]}
              loses={[
                'a quantidade que alguém ajustou num item DO JOGO',
                'o "quanto sai" da caixa (itens, scrap, blueprints)',
              ]}
              onPick={() => {
                setMode('merge');
                setTyped('');
              }}
            />

            <ModeCard
              picked={mode === 'factory'}
              title="Resetar tudo ao padrão do jogo"
              summary="A base nova, e nada mais. É o estado de instalação do plugin, para editar do zero."
              keeps={['nada — tudo fica só no backup']}
              loses={[
                'todos os itens da casa, em todas as caixas',
                'todos os perfis do LootGroups.json, inclusive os seus',
                'todos os vínculos entre caixa e perfil',
              ]}
              onPick={() => {
                setMode('factory');
                setTyped('');
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3 border border-border bg-surface-2 px-3 py-2">
            <div className="min-w-0">
              <p className="text-2xs font-medium text-foreground">
                Adotar todas as caixas (tirar a marca JOGO)
              </p>
              <p className="text-[10px] leading-snug text-muted">
                Liga os dois interruptores de cada caixa — o{' '}
                <span className="font-mono">Is Prefab Enabled?</span> da tabela e o{' '}
                <span className="font-mono">Watched Container Prefabs</span> da configuração.
                Desligado, a caixa que o plugin cadastrou como &quot;jogo&quot; continua fora do
                painel.
              </p>
              {/* ####  AS DUAS DE EVENTO SÃO O CASO A AVISAR  ####

                  O BetterLoot gera a caixa do Bradley e a do heli
                  SEMPRE desligadas (`container.Enabled = !contains
                  (bradley_crate) && !contains(heli_crate)`), e
                  "adotar todas" as liga junto. Medido no server01:
                  foram as duas únicas adotadas de 111. Quem não
                  quiser o BetterLoot no loot de evento desliga as
                  duas depois, na lista. */}
              <p className="mt-1 text-[10px] leading-snug text-amber">
                Isto inclui a caixa do Bradley e a do helicóptero, que o plugin sempre gera
                desligadas. Para deixar o loot delas com o jogo, desligue as duas na lista depois.
              </p>
            </div>
            <Toggle
              on={adopt}
              busy={running}
              label="Adotar todas as caixas"
              onChange={setAdopt}
            />
          </div>

          <p className="text-2xs leading-relaxed text-muted">
            Antes de qualquer escrita, o agente copia os três arquivos para a pasta de backup deste
            servidor e responde com os caminhos. Se o plugin não gerar a base, tudo volta ao lugar e
            nada muda. A lista de itens banidos (<span className="font-mono">Blacklist.json</span>)
            não é tocada em nenhum dos dois modos.
          </p>

          {error !== null && (
            <div className="flex items-start gap-2 border border-rust bg-rust/10 px-3 py-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rust" />
              <p className="text-2xs leading-relaxed text-foreground">{error}</p>
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-2 border-t border-border pt-3">
            <div className="space-y-1">
              <Label htmlFor="rebuild-confirm">
                Para confirmar, digite <strong>{expected}</strong>
              </Label>
              <Input
                id="rebuild-confirm"
                value={typed}
                disabled={running}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                className="h-8 w-40 uppercase"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={running} onClick={close}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                disabled={!armed || running}
                onClick={() => void run()}
                className="flex items-center gap-1"
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                {running
                  ? 'Refazendo…'
                  : mode === 'merge'
                    ? 'Refazer a base'
                    : 'Resetar ao padrão do jogo'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Um dos dois modos.
 *
 * O cartão mostra o que SOBREVIVE e o que se PERDE lado a lado. A
 * segunda coluna é a que importa e é a que costuma faltar nas
 * telas de "restaurar padrão" — quem só lê "isto não pode ser
 * desfeito" descobre o que perdeu depois.
 */
function ModeCard({
  picked,
  title,
  summary,
  keeps,
  loses,
  onPick,
}: {
  readonly picked: boolean;
  readonly title: string;
  readonly summary: string;
  readonly keeps: readonly string[];
  readonly loses: readonly string[];
  readonly onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      className={`space-y-2 border p-3 text-left ${
        picked ? 'border-amber bg-surface-2' : 'border-border bg-surface-1 hover:border-muted'
      }`}
    >
      <p className="text-2xs font-bold uppercase tracking-wide text-foreground">{title}</p>
      <p className="text-[10px] leading-snug text-muted">{summary}</p>

      <dl className="space-y-1 text-[10px] leading-snug">
        <div>
          <dt className="text-olive">Continua valendo</dt>
          <dd className="text-muted">
            <ul className="list-disc pl-4">
              {keeps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-rust">Volta ao do jogo</dt>
          <dd className="text-muted">
            <ul className="list-disc pl-4">
              {loses.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </button>
  );
}

/**
 * O que aconteceu, depois.
 *
 * ####  O RELATÓRIO É PARTE DA OPERAÇÃO, E NÃO UM EXTRA  ####
 *
 * Ele responde às três perguntas que sobram: o que voltou, o que
 * foi preservado e o que ficou de fora. Sem ele, o admin teria de
 * abrir 111 caixas para descobrir — que é o retrabalho que este
 * botão existe para acabar.
 */
function RebuildReport({
  result,
  onClose,
}: {
  readonly result: BetterLootRebuildResponse;
  readonly onClose: () => void;
}) {
  const { report } = result;

  return (
    <div className="space-y-4">
      <p className="text-2xs leading-relaxed text-foreground">
        {report.mode === 'merge'
          ? 'A base foi refeita pelo plugin, e o que era da casa voltou por cima dela.'
          : 'O loot voltou ao padrão do jogo. Os perfis foram zerados e o plugin recriou o arquivo deles vazio.'}
      </p>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Caixas na base" value={report.tables} />
        <Stat label="Itens do jogo" value={report.nativeItems} />
        <Stat label="Itens da casa preservados" value={report.keptItems} />
        <Stat label="Vínculos com perfil" value={report.keptProfiles} />
      </dl>

      <ul className="space-y-1 text-2xs text-muted">
        <li>
          <strong className="text-foreground">{result.watchedAdded}</strong> caixa(s) entraram na
          lista de vigia do <span className="font-mono">BetterLoot.json</span>
          {report.adopted.length > 0 && (
            <>
              {' '}
              e <strong className="text-foreground">{report.adopted.length}</strong> saíram da marca
              JOGO
            </>
          )}
          .
        </li>
        {report.fresh.length > 0 && (
          <li>
            <strong className="text-foreground">{report.fresh.length}</strong> caixa(s) que o painel
            não conhecia entraram agora — são as que o jogo ganhou depois da instalação do plugin.
          </li>
        )}
        {report.preserved.length > 0 && (
          <li>
            <strong className="text-foreground">{report.preserved.length}</strong> caixa(s) o plugin
            não gerou e ficaram como estavam — o BetterLoot pula o corpo de cientista que está fora
            da vigia. Refazer com <strong>adotar todas</strong> ligado traz a lista do jogo para
            elas também.
          </li>
        )}
        {report.dropped.length > 0 && (
          <li>
            <strong className="text-foreground">{report.dropped.length}</strong> prefab(s) ficaram
            de fora: o jogo de hoje não os tem. Eles continuam no backup.
          </li>
        )}
        {report.orphanProfiles.length > 0 && (
          <li className="text-amber">
            Perfis citados por alguma caixa e que não existem no{' '}
            <span className="font-mono">LootGroups.json</span>:{' '}
            {report.orphanProfiles.join(', ')}. O BetterLoot ignora o vínculo órfão — crie o perfil
            com esse nome, ou tire o vínculo da caixa.
          </li>
        )}
        {!result.reloaded && (
          <li className="text-amber">
            O plugin não confirmou o segundo carregamento. O arquivo está gravado e vale no próximo
            load.
          </li>
        )}
      </ul>

      {report.changed.length > 0 && (
        <div className="max-h-64 overflow-y-auto border border-border">
          <table className="w-full text-2xs">
            <thead className="sticky top-0 bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Caixa</th>
                <th className="px-2 py-1 text-right font-medium">Do jogo</th>
                <th className="px-2 py-1 text-right font-medium">Da casa</th>
                <th className="px-2 py-1 text-right font-medium">Perfis</th>
              </tr>
            </thead>
            <tbody>
              {report.changed.map((table) => (
                <tr key={table.prefab} className="border-t border-border/60">
                  <td className="max-w-0 truncate px-2 py-1 font-mono text-foreground">
                    {table.prefab.split('/').pop() ?? table.prefab}
                    {table.adopted && <span className="ml-1 text-olive">adotada</span>}
                    {table.fresh && <span className="ml-1 text-amber">nova</span>}
                  </td>
                  <td className="px-2 py-1 text-right text-muted">{table.nativeItems}</td>
                  <td className="px-2 py-1 text-right text-muted">
                    {table.keptItems.length + table.keptGuaranteed.length}
                  </td>
                  <td className="px-2 py-1 text-right text-muted">{table.keptProfiles.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-1 border-t border-border pt-3">
        <p className="text-2xs text-muted">As cópias do que estava lá antes:</p>
        <ul className="space-y-0.5">
          {result.backups.map((path) => (
            <li key={path} className="break-all font-mono text-[10px] text-muted">
              {path}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex justify-end">
        <Button variant="confirm" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="border border-border bg-surface-2 px-2 py-1">
      <dt className="text-[10px] leading-snug text-muted">{label}</dt>
      <dd className="font-condensed text-lg text-foreground">{value}</dd>
    </div>
  );
}
