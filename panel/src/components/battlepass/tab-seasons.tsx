'use client';

// ============================================================
//  tab-seasons.tsx  -  criar o passe de outubro, novembro e
//  dezembro; publicar; e ver em que pé cada um está.
//
//  ####  AQUI SE CRIA E SE PUBLICA; QUEM EDITA É A CONFIGURAÇÃO  ####
//
//  O diálogo desta aba pergunta as QUATRO coisas sem as quais uma
//  temporada não existe: que mês é, como ela se chama, quantos
//  níveis tem e em que servidores vale. Todo o resto — as chaves,
//  a curva, o retroativo, o texto — mora na aba Configuração.
//
//  A divisão não é gosto: dois formulários para os mesmos campos
//  divergiriam no primeiro campo novo, e o que ficasse para trás
//  gravaria um valor velho por cima do que o outro salvou. É o
//  mesmo argumento do cabeçalho do `RewardList`.
//
//  ####  PUBLICAR É BOTÃO  ####
//
//  E não efeito do calendário (01 §1.1): uma temporada esquecida em
//  rascunho no dia 1 não deve entrar no ar meio montada. Os botões
//  de estado mandam PARA ONDE ir; quem decide se pode é o agente —
//  ele conhece a regra de "só uma no ar por servidor", e a recusa
//  dele vai inteira para a tela. Nenhum botão é escondido "porque
//  não vai dar certo".
// ============================================================

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  DEFAULT_XP_CURVE,
  messageOf,
  nextPeriodOf,
  periodLabel,
  upcomingPeriods,
} from '@/components/battlepass/normalize';
import {
  ServerMultiChoice,
  type BattlePassServerOption,
} from '@/components/battlepass/server-choice';
import { StateBadge } from '@/components/battlepass/state-badge';
import { Section } from '@/components/section';
import { StateBlock } from '@/components/state-block';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field, INPUT } from '@/components/ui/field';
import {
  agent,
  type BattlePassSeason,
  type BattlePassSeasonInput,
  type BattlePassSeasonState,
} from '@/lib/api';
import { formatInteger, formatWhen } from '@/lib/format';
import { toast } from '@/lib/toast';

interface StateMove {
  readonly to: BattlePassSeasonState;
  readonly label: string;
}

/**
 * Para onde dá para ir a partir de cada estado, e com que verbo.
 *
 * Nenhum caminho é escondido por "não vai dar certo": pôr no ar
 * uma temporada sem servidor, ou com outra já no ar, é um botão que
 * aparece e uma recusa que se lê — com a frase do agente, que é
 * quem conhece a regra.
 */
const MOVES: Readonly<Record<BattlePassSeasonState, readonly StateMove[]>> = {
  draft: [
    { to: 'scheduled', label: 'Publicar' },
    { to: 'active', label: 'Pôr no ar' },
  ],
  scheduled: [
    { to: 'active', label: 'Pôr no ar' },
    { to: 'draft', label: 'Voltar a rascunho' },
  ],
  active: [{ to: 'closed', label: 'Encerrar' }],
  closed: [{ to: 'active', label: 'Pôr no ar de novo' }],
};

/** O agente mandou um estado que este painel não conhece: os quatro. */
const UNKNOWN_STATE_MOVES: readonly StateMove[] = [
  { to: 'draft', label: 'Rascunho' },
  { to: 'scheduled', label: 'Publicar' },
  { to: 'active', label: 'Pôr no ar' },
  { to: 'closed', label: 'Encerrar' },
];

export function TabSeasons({
  seasons,
  servers,
  onChanged,
}: {
  readonly seasons: readonly BattlePassSeason[];
  readonly servers: readonly BattlePassServerOption[];
  /** A lista mudou: quem recarrega é a página, que é dona dela. */
  readonly onChanged: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<BattlePassSeason | null>(null);
  /** A temporada cujo "onde vale" está aberto. */
  const [placing, setPlacing] = useState<BattlePassSeason | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Toda ação segue o mesmo caminho: agir, avisar, reler.
   *
   * Devolve se deu certo — é o que decide se um diálogo fecha. Uma
   * caixa que se fecha na recusa leva junto o formulário inteiro, e
   * a pessoa tem de digitar tudo de novo para ler o mesmo erro.
   */
  async function run(what: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);

    try {
      await action();
      toast.success(what);
      await onChanged();

      return true;
    } catch (cause) {
      // A frase do agente vai INTEIRA: ela já vem em português e
      // conhece a regra que recusou.
      toast.error(`Não deu: ${what.toLowerCase()}`, { description: messageOf(cause) });

      return false;
    } finally {
      setBusy(false);
    }
  }

  const serverName = (id: string): string => servers.find((entry) => entry.id === id)?.name ?? id;

  return (
    <Section
      title="As temporadas"
      aside={
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Nova temporada
        </Button>
      }
      contentClassName="p-0"
    >
      {seasons.length === 0 ? (
        <div className="p-3">
          <StateBlock
            variant="empty"
            title="Nenhuma temporada criada."
            detail="A temporada é o mês: crie a de agora e, de preferência, as dos próximos — assim a virada do dia 1 não pega ninguém sem passe."
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <thead className="border-b border-border font-condensed text-2xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Mês</th>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">Níveis</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Onde vale</th>
                <th className="px-3 py-2">Atualizada</th>
                <th className="px-3 py-2 text-right">O que fazer</th>
              </tr>
            </thead>

            <tbody>
              {seasons.map((season) => (
                <tr key={season.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap text-foreground">
                    {periodLabel(season.period)}
                  </td>
                  <td className="px-3 py-2 text-foreground">{season.label}</td>
                  <td className="px-3 py-2">{formatInteger(season.levels)}</td>
                  <td className="px-3 py-2">
                    <StateBadge state={season.state} />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPlacing(season)}
                      className="text-left underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {season.servers.length === 0 ? (
                        // Nenhum marcado é "em nenhum", e não "em todos".
                        <span className="text-foreground">em nenhum servidor</span>
                      ) : (
                        season.servers.map(serverName).join(', ')
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">
                    {formatWhen(season.updatedAt)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {(season.state === null
                        ? UNKNOWN_STATE_MOVES
                        : MOVES[season.state]
                      ).map((move) => (
                        <Button
                          key={move.to}
                          size="sm"
                          variant={move.to === 'active' ? 'confirm' : 'outline'}
                          disabled={busy}
                          onClick={() =>
                            void run(`${move.label}: ${periodLabel(season.period)}`, () =>
                              agent.setBattlePassSeasonState(season.id, move.to),
                            )
                          }
                        >
                          {move.label}
                        </Button>
                      ))}

                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Apagar a temporada de ${periodLabel(season.period)}`}
                        disabled={busy}
                        onClick={() => setRemoving(season)}
                      >
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Montado só enquanto aberto: assim o formulário nasce
          limpo a cada abertura, em vez de guardar o mês que alguém
          escolheu e desistiu na vez passada. */}
      {creating && (
        <SeasonDialog
          seasons={seasons}
          servers={servers}
          busy={busy}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const ok = await run(`Temporada de ${periodLabel(input.period)} criada`, () =>
              agent.createBattlePassSeason(input),
            );

            if (ok) setCreating(false);
          }}
        />
      )}

      {placing !== null && (
        <ServersDialog
          season={placing}
          servers={servers}
          busy={busy}
          onClose={() => setPlacing(null)}
          onSave={async (chosen) => {
            const ok = await run(`Onde vale: ${periodLabel(placing.period)}`, () =>
              agent.setBattlePassSeasonServers(placing.id, chosen),
            );

            if (ok) setPlacing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Apagar a temporada"
        confirmLabel="Apagar"
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const season = removing;

          if (season === null) return;

          setRemoving(null);
          void run(`Temporada de ${periodLabel(season.period)} apagada`, () =>
            agent.removeBattlePassSeason(season.id),
          );
        }}
      >
        <p className="text-sm text-foreground">
          Apagar <strong>{removing?.label}</strong> leva junto a trilha, o progresso de todo mundo,
          os direitos comprados e o que estava na caixa esperando entrega.
        </p>
        <p className="text-xs text-muted">
          O registro fica: é ele que responde “quem apagou {periodLabel(removing?.period ?? '')}?”.
        </p>
      </ConfirmDialog>
    </Section>
  );
}

/**
 * Onde a temporada vale.
 *
 * Ela tem rota própria (`PUT .../servers`), e é por isso que mora
 * aqui e não no formulário da Configuração: marcar um servidor não
 * pode exigir reenviar a temporada inteira — é assim que se apaga o
 * que outra pessoa salvou no meio.
 */
function ServersDialog({
  season,
  servers,
  busy,
  onClose,
  onSave,
}: {
  readonly season: BattlePassSeason;
  readonly servers: readonly BattlePassServerOption[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (servers: string[]) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<readonly string[]>(season.servers);

  return (
    <Dialog
      open
      title={`Onde vale · ${periodLabel(season.period)}`}
      busy={busy}
      onClose={onClose}
    >
      <div className="space-y-4">
        <ServerMultiChoice servers={servers} value={chosen} busy={busy} onChange={setChosen} />

        <p className="text-2xs text-muted">
          O XP e o direito comprado são de cada servidor: tirar um daqui não apaga o progresso de
          ninguém — a temporada simplesmente deixa de aparecer lá.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void onSave([...chosen])}>
            Salvar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * O formulário de criar.
 *
 * O mês é ESCOLHIDO numa lista, e não digitado: `2026-10` é um
 * formato que se erra de três jeitos diferentes, e o erro só
 * apareceria na recusa do agente. Os meses que já têm temporada
 * aparecem marcados — criar dois passes para outubro é o tipo de
 * engano que só se descobre no dia 1.
 */
function SeasonDialog({
  seasons,
  servers,
  busy,
  onClose,
  onCreate,
}: {
  readonly seasons: readonly BattlePassSeason[];
  readonly servers: readonly BattlePassServerOption[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onCreate: (input: BattlePassSeasonInput) => Promise<void>;
}) {
  const options = upcomingPeriods(12);
  const taken = new Set(seasons.map((season) => season.period));
  const suggested = options.find((period) => !taken.has(period)) ?? options[0] ?? '';

  const [period, setPeriod] = useState(suggested);
  const [label, setLabel] = useState('');
  const [levels, setLevels] = useState(30);
  const [chosen, setChosen] = useState<readonly string[]>(servers.map((server) => server.id));

  // O nome nasce sugerido pelo mês, e continua editável: "Temporada
  // de outubro de 2026" é o que o jogador lê no cabeçalho, e digitar
  // isso à mão doze vezes por ano não é trabalho de ninguém.
  const finalLabel = label.trim() === '' ? `Temporada de ${periodLabel(period)}` : label.trim();

  return (
    <Dialog open title="Nova temporada" busy={busy} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();

          void onCreate({
            period,
            label: finalLabel,
            levels,
            // O resto nasce no padrão do agente e se edita na aba
            // Configuração — ver o cabeçalho deste arquivo.
            xpCurve: DEFAULT_XP_CURVE,
            freeLane: true,
            paidLane: true,
            retroactive: true,
            description: null,
            servers: [...chosen],
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mês" hint="A temporada é o mês do calendário, e ela fecha no último dia.">
            <select
              className={INPUT}
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {periodLabel(option)}
                  {taken.has(option) ? ' (já tem temporada)' : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Níveis" hint="Quantas casas a trilha tem. Dá para mudar depois.">
            <input
              type="number"
              min={1}
              max={200}
              className={INPUT}
              value={levels}
              onChange={(event) => setLevels(Number(event.target.value))}
            />
          </Field>
        </div>

        <Field label="Nome" hint={`Em branco fica "${`Temporada de ${periodLabel(period)}`}".`}>
          <input
            className={INPUT}
            value={label}
            maxLength={80}
            placeholder={`Temporada de ${periodLabel(period)}`}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>

        <div>
          <span className="mb-1 block font-condensed text-2xs uppercase tracking-wide text-muted">
            Em que servidores ela vale
          </span>
          <ServerMultiChoice
            servers={servers}
            value={chosen}
            busy={busy}
            onChange={setChosen}
          />
        </div>

        {taken.has(period) && (
          <StateBlock
            variant="error"
            title={`Já existe uma temporada de ${periodLabel(period)}.`}
            detail="Duas no mesmo mês não são recusadas pelo agente, mas só uma pode ficar no ar em cada servidor — e a outra vira um rascunho que ninguém lembra por que existe."
          />
        )}

        <p className="text-2xs text-muted">
          Ela nasce em <strong>rascunho</strong>: ninguém a vê até você publicar. O mês seguinte a
          este é {periodLabel(nextPeriodOf(period))} — vale criar os dois de uma vez.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Criar temporada
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
