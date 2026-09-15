// ============================================================
//  teams.ts  -  O CONTRATO DA EQUIPE.
//
//  ####  METADE DISTO NÃO É NOSSO  ####
//
//  A equipe é do jogo. Quem está dentro, quem é líder, quem foi
//  convidado e quantos cabem vêm do `RelationshipManager` e voltam
//  a cada pergunta — nada disso é gravado no agente.
//
//  O que é nosso é UMA coisa: o cargo, que o Rust não tem. Ele mora
//  em `team_ranks` e é o único campo daqui que sobrevive a um
//  reinício do agente.
//
//  Por isso os tipos vêm em duas famílias:
//
//    GameTeam / GameMember   o que o plugin respondeu, cru
//    Team / TeamMember       o mesmo, já com o cargo colado
//
//  Misturar as duas é como se perde a noção de quem é o dono do
//  dado — e o dia em que o agente "corrigir" a lista de membros
//  contra o jogo é o dia em que alguém é expulso por um bug.
//
//  Ver Docs/OrigemZTeam/00-LEVANTAMENTO.md.
// ============================================================

import { z } from 'zod';

// ------------------------------------------------------------
//  §1  O CARGO — a única coisa que é nossa
// ------------------------------------------------------------

/**
 * Os cargos, do mais alto para o mais baixo.
 *
 * `leader` NÃO se grava: ele é do jogo, e quem responde quem é o
 * líder é o `RelationshipManager`. Ele está na lista porque a tela
 * o mostra na mesma coluna — e porque uma ordenação que não o
 * conhecesse colocaria o líder embaixo do oficial.
 */
export const TEAM_RANKS = ['leader', 'officer', 'member'] as const;
export type TeamRank = (typeof TEAM_RANKS)[number];

/** O que se pode GRAVAR. O líder fica de fora, de propósito. */
export const GRANTABLE_RANKS = ['officer', 'member'] as const;
export type GrantableRank = (typeof GRANTABLE_RANKS)[number];

/** O nome do cargo na tela. */
export const TEAM_RANK_LABEL: Record<TeamRank, string> = {
  leader: 'Líder',
  officer: 'Oficial',
  member: 'Membro',
};

/** Quanto vale cada cargo, para ordenar e comparar. Maior manda mais. */
export const TEAM_RANK_WEIGHT: Record<TeamRank, number> = {
  leader: 30,
  officer: 20,
  member: 10,
};

// ------------------------------------------------------------
//  §2  O NOME DA EQUIPE
// ------------------------------------------------------------

/**
 * O teto do nome.
 *
 * Vinte e quatro porque ele aparece na tela do jogador ao lado do
 * progresso do KOTH, e porque o plugin corta nesse mesmo número —
 * um nome cortado só de um lado seria um nome diferente no painel
 * e no jogo.
 */
export const TEAM_NAME_MAX = 24;

/**
 * A régua do nome.
 *
 * ####  POR QUE ELA É TÃO SOLTA  ####
 *
 * Um nome de equipe é apelido de gente, e apelido tem acento,
 * número, ponto e emoji. O que ela recusa é o que QUEBRA alguma
 * coisa: vazio (o jogo já mostra o nome do líder nesse caso), o que
 * passa do teto, e quebra de linha — que no console viraria duas
 * linhas e no CUI, um elemento fora do lugar.
 *
 * Palavrão não é problema de schema: é moderação, e moderação que
 * mora numa regex vira uma lista infinita que nunca pega o que
 * importa.
 */
export const teamNameSchema = z
  .string()
  .trim()
  .min(1, 'o nome não pode ser vazio')
  .max(TEAM_NAME_MAX, `no máximo ${String(TEAM_NAME_MAX)} caracteres`)
  .refine((value) => !/[\r\n]/.test(value), 'o nome não pode ter quebra de linha');

/** O id de uma equipe, como ele viaja: texto. Ver a migração 088. */
export const teamIdSchema = z.string().regex(/^[0-9]{1,20}$/, 'id de equipe inválido');

/** Um SteamID de 17 dígitos. A mesma régua do resto do agente. */
export const steamIdSchema = z.string().regex(/^[0-9]{17}$/, 'SteamID inválido');

export const rankInputSchema = z.object({
  steamId: steamIdSchema,
  rank: z.enum(GRANTABLE_RANKS),
});

export type RankInput = z.infer<typeof rankInputSchema>;

export const renameInputSchema = z.object({ name: teamNameSchema });

// ------------------------------------------------------------
//  §3  O QUE O PLUGIN RESPONDE
// ------------------------------------------------------------

/**
 * Um membro, como o jogo o conhece.
 *
 * `name` pode ser o próprio SteamID: o plugin devolve o id quando
 * ninguém naquele servidor sabe o nome — o que acontece com quem
 * nunca entrou depois do wipe. Ver `NameOf` em OrigemZTeam.cs.
 */
export interface GameMember {
  readonly steamId: string;
  readonly name: string;
  readonly online: boolean;
  readonly leader: boolean;
}

export interface GameTeam {
  readonly teamId: string;
  /** Vazio = ninguém batizou. O cliente mostra o nome do líder. */
  readonly name: string;
  readonly leader: string;
  readonly leaderName: string;
  /** Segundos desde que ela existe. NÃO é data: conta do boot do servidor. */
  readonly ageSeconds: number;
  readonly members: readonly GameMember[];
  readonly invites: readonly string[];
}

// ------------------------------------------------------------
//  §4  O QUE O PAINEL VÊ
// ------------------------------------------------------------

export interface TeamMember extends GameMember {
  readonly rank: TeamRank;
}

export interface Team extends Omit<GameTeam, 'members'> {
  readonly members: readonly TeamMember[];
  /** Quantos cargos gravados esta equipe tem. Zero é o normal. */
  readonly officers: number;
}

export interface TeamsSnapshot {
  readonly serverId: string;
  readonly maxSize: number;
  readonly teams: readonly Team[];
  /** Quando o agente perguntou ao jogo. Epoch ms. */
  readonly readAt: number;
}

/**
 * O cargo de uma pessoa, como ele sai do banco.
 *
 * Existe separado de `TeamMember` porque ele é lido SEM o jogo na
 * mesa: a ficha do jogador no painel mostra a equipe dele sem
 * perguntar ao servidor, e esta é a metade que sobrevive a um
 * servidor parado.
 */
export interface TeamRankRow {
  readonly serverId: string;
  readonly teamId: string;
  readonly steamId: string;
  readonly rank: string;
  readonly grantedBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** O que o plugin grita no console. Ver `#OZTEAM#` em OrigemZTeam.cs. */
export const TEAM_PUSH_KINDS = [
  'ready',
  'created',
  'disbanded',
  'joined',
  'left',
  'kicked',
  'leader',
  'renamed',
] as const;

export type TeamPushKind = (typeof TEAM_PUSH_KINDS)[number];

export interface TeamPush {
  readonly kind: TeamPushKind;
  readonly teamId?: string;
  readonly steamId?: string;
  readonly name?: string;
  readonly leader?: string;
  readonly leaderName?: string;
}
