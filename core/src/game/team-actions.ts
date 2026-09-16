// ============================================================
//  team-actions.ts  -  o clique da aba EQUIPE vira mudança.
//
//  ####  POR QUE ISTO SAIU DO index.ts  ####
//
//  Mesma razão do `ui-store-bridge.ts`: o `index` é montagem — ele
//  liga as peças e não deveria conhecer a regra de nenhuma delas.
//  E, mais concreto: enquanto isto morava lá, não havia como
//  TESTAR. O `index.ts` tem 4.300 linhas e sobe o agente inteiro no
//  import; ninguém escreve um teste que sobe um servidor de HTTP
//  para conferir se um oficial pode expulsar outro.
//
//  Aqui é uma função pura de dependências: recebe o serviço, e
//  quem o chama decide se ele é o de verdade ou um de mentira.
//
//  ####  É AQUI QUE A PERMISSÃO É COBRADA  ####
//
//  A tela desenha o botão pela mesma tabela (`rankCan`), mas quem
//  desenha não é quem decide: o endereço de um botão é digitável no
//  F1, e um jogador que nunca viu o botão de expulsar pode mandar o
//  clique dele.
// ============================================================

import {
  TEAM_RANK_LABEL,
  rankCan,
  rankOutranks,
  teamNameSchema,
  type TeamPower,
} from '../types/teams.js';

import { TeamCommandError, type TeamsService } from './teams.js';

/**
 * O que o `TeamsService` precisa ter para esta frente funcionar.
 *
 * Um `Pick`, e não o serviço inteiro: é o que deixa o teste passar
 * um objeto de cinco métodos em vez de montar RCON, banco e
 * supervisor para perguntar se um membro pode expulsar o líder.
 */
export type TeamActionService = Pick<
  TeamsService,
  'teamOf' | 'rename' | 'kick' | 'setLeader' | 'setRank'
>;

/** O desfecho, do jeito que o jogador vai ler. */
export interface TeamActionOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export async function runTeamAction(input: {
  readonly service: TeamActionService;
  readonly serverId: string;
  /** Quem clicou. Da CONEXÃO, nunca do endereço. */
  readonly steamId: string;
  /** O que veio depois do `team:` — `name`, `kick:765…`. */
  readonly action: string;
  /** O que ele escreveu, quando o clique veio do campo de texto. */
  readonly value: string | undefined;
}): Promise<TeamActionOutcome> {
  const [verb, target] = input.action.split(':');

  try {
    const team = await input.service.teamOf(input.serverId, input.steamId);

    if (team === null) {
      return { ok: false, message: 'Você não está em uma equipe.' };
    }

    const viewer = team.members.find((member) => member.steamId === input.steamId);

    if (viewer === undefined) {
      // O jogo respondeu uma equipe em que quem perguntou não está.
      // Não deveria acontecer — e por isso mesmo não se age.
      return { ok: false, message: 'Não consegui confirmar seu cargo na equipe. Reabra o menu.' };
    }

    // ----------------------------------------------------------
    //  SAIR — a única ação que se faz sobre si mesmo
    //
    //  Ela vai pelo `kick`, e não por um comando novo: o
    //  `RemovePlayer` do jogo já limpa a equipe do jogador, promove
    //  o próximo líder e desfaz a equipe que esvaziou (medido no
    //  decompilado). Um caminho próprio para sair teria de
    //  reimplementar as três coisas.
    // ----------------------------------------------------------
    if (verb === 'leave') {
      const last = team.members.length <= 1;

      await input.service.kick(input.serverId, team.teamId, input.steamId);

      return {
        ok: true,
        message: last
          ? 'Você saiu, e a equipe foi desfeita.'
          : 'Você saiu da equipe. Para voltar, peça um convite.',
      };
    }

    // ----------------------------------------------------------
    //  O NOME
    // ----------------------------------------------------------
    if (verb === 'name') {
      if (!rankCan(viewer.rank, 'rename')) {
        return { ok: false, message: 'Só o líder muda o nome da equipe.' };
      }

      // O texto vem CRU do cliente: ele não passou por régua
      // nenhuma no caminho. A daqui é a mesma do painel, de
      // propósito — um nome que o admin não conseguiria salvar não
      // pode entrar pelo jogo.
      const parsed = teamNameSchema.safeParse(input.value ?? '');

      if (!parsed.success) {
        const why = parsed.error.issues[0]?.message ?? 'nome inválido';

        return { ok: false, message: `Esse nome não serve: ${why}.` };
      }

      const saved = await input.service.rename(input.serverId, team.teamId, parsed.data);

      return { ok: true, message: `A equipe agora se chama ${saved.name}.` };
    }

    // ----------------------------------------------------------
    //  AS TRÊS QUE TÊM ALVO
    // ----------------------------------------------------------
    const power: TeamPower | null =
      verb === 'rank' ? 'rank' : verb === 'leader' ? 'leader' : verb === 'kick' ? 'kick' : null;

    if (power === null || target === undefined || !/^\d{17}$/.test(target)) {
      return { ok: false, message: 'Este botão não é mais válido. Reabra o menu.' };
    }

    // O alvo tem de estar NA EQUIPE DE QUEM PEDIU. É esta linha que
    // impede um endereço forjado de alcançar outro time: a lista
    // veio do jogo, para a equipe de quem clicou.
    const member = team.members.find((entry) => entry.steamId === target);

    if (member === undefined) {
      return { ok: false, message: 'Esse jogador não está mais na equipe.' };
    }

    if (member.steamId === viewer.steamId) {
      return { ok: false, message: 'Essa ação não é sobre você. Para sair, use SAIR DA EQUIPE.' };
    }

    if (!rankCan(viewer.rank, power) || !rankOutranks(viewer.rank, member.rank)) {
      return {
        ok: false,
        message: `Seu cargo (${TEAM_RANK_LABEL[viewer.rank].toLowerCase()}) não permite isso.`,
      };
    }

    if (verb === 'rank') {
      // Um botão só, que alterna: o cargo já está escrito ao lado,
      // e o destino é decidido pelo que ele é AGORA — relido acima.
      const next = member.rank === 'member' ? 'officer' : 'member';

      await input.service.setRank({
        serverId: input.serverId,
        teamId: team.teamId,
        steamId: member.steamId,
        rank: next,
        grantedBy: input.steamId,
      });

      return {
        ok: true,
        message:
          next === 'officer'
            ? `${member.name} agora é oficial da equipe.`
            : `${member.name} voltou a ser membro.`,
      };
    }

    if (verb === 'leader') {
      await input.service.setLeader(input.serverId, team.teamId, member.steamId);

      return { ok: true, message: `${member.name} agora é o líder da equipe.` };
    }

    await input.service.kick(input.serverId, team.teamId, member.steamId);

    return { ok: true, message: `${member.name} foi removido da equipe.` };
  } catch (cause) {
    // O `TeamCommandError` já vem com a frase certa em português —
    // "O servidor não está com o RCON de pé", "Essa equipe não
    // existe mais". É ela que o jogador precisa ler.
    return {
      ok: false,
      message:
        cause instanceof TeamCommandError ? cause.message : 'Não deu para fazer isso agora.',
    };
  }
}
