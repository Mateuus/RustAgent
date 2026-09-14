// ============================================================
//  rules.ts  -  O CONTRATO DAS REGRAS DO SERVIDOR.
//
//  O que o jogador lê na aba REGRAS do `/menu`, e o que o admin
//  escreve no painel. Uma SEÇÃO é o que a barra lateral lista
//  ("Equipes e Alianças"); um ITEM é cada regra dentro dela.
//
//  ####  A REDE ESCREVE; O SERVIDOR SOBRESCREVE  ####
//
//  Decisão do dono em 14/09/2026, perguntado se a regra é de cada
//  servidor ou geral: as duas. Então há um conjunto da REDE — o
//  que todo servidor lê enquanto não disser o contrário — e o
//  conjunto PRÓPRIO de quem quis o seu.
//
//  Quem decide qual dos dois vale é o `RulesScopeMode`, e nunca a
//  existência de linhas: um servidor com `own` e nenhuma seção
//  mostra uma página vazia, e isso é uma escolha legítima do
//  admin. Ver a migração 083.
//
//  ####  O TEXTO É DO ADMIN, E ELE PODE ESTAR ERRADO  ####
//
//  Nada aqui inventa regra: o modelo de `RULES_TEMPLATE` só existe
//  atrás de um clique no painel, e nasce como rascunho para ser
//  reescrito. Um servidor que não publicou nada mostra a página
//  dizendo isso — nunca uma regra que o dono dele não escreveu.
// ============================================================

import { z } from 'zod';

/**
 * A cor da linha no jogo, e nada além disso.
 *
 * `proibido` é o vermelho do que dá banimento, `alerta` o âmbar do
 * que custa aviso, `normal` o texto comum. O tom não muda o que a
 * regra vale — quem aplica é a administração, não a tela.
 */
export const RULE_TONES = ['normal', 'alerta', 'proibido'] as const;
export type RuleTone = (typeof RULE_TONES)[number];

/**
 * De onde a página de um servidor lê.
 *
 * `inherit` é o padrão de todo servidor que nunca foi tocado, e é
 * o que mantém uma regra escrita uma vez valendo na rede inteira.
 */
export const RULES_SCOPE_MODES = ['inherit', 'own'] as const;
export type RulesScopeMode = (typeof RULES_SCOPE_MODES)[number];

/**
 * O limite do texto de uma regra.
 *
 * 300 caracteres não é gosto: é o que cabe em três linhas da caixa
 * desenhada, na fonte 12 da base 1280x720. Acima disso a regra
 * seria cortada na tela do jogador, e um texto cortado numa página
 * de regras é pior que um texto ausente. Ver `ui-rules-screen.ts`.
 */
export const MAX_RULE_TEXT = 300;

export const ruleItemInputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, 'a regra precisa de um texto')
      .max(MAX_RULE_TEXT, `a regra passa de ${String(MAX_RULE_TEXT)} caracteres e seria cortada`),
    tone: z.enum(RULE_TONES).default('normal'),
  })
  .strict();

export type RuleItemInput = z.infer<typeof ruleItemInputSchema>;

export const ruleSectionInputSchema = z
  .object({
    title: z.string().trim().min(1, 'a seção precisa de um título').max(60),
    enabled: z.boolean().default(true),
  })
  .strict();

export type RuleSectionInput = z.infer<typeof ruleSectionInputSchema>;

/** Uma regra, como o painel e o jogo a leem. */
export interface RuleItem {
  readonly id: number;
  readonly text: string;
  readonly tone: RuleTone;
  readonly position: number;
}

/** Uma seção com as regras dela, na ordem. */
export interface RuleSection {
  readonly id: number;
  readonly title: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly items: readonly RuleItem[];
}

/**
 * O que um servidor lê, e de onde.
 *
 * `mode` vem junto porque a tela do painel precisa dizer, em uma
 * frase, se o que está na lista é editável ali ou se pertence à
 * rede — sem isso, o admin editaria a regra da rede achando que
 * mexe só no servidor dele.
 */
export interface RulesView {
  readonly mode: RulesScopeMode;
  readonly sections: readonly RuleSection[];
}

// ------------------------------------------------------------
//  O MODELO, QUE SÓ ENTRA POR UM CLIQUE
// ------------------------------------------------------------

/**
 * As quatro seções do desenho que o dono mandou, com um rascunho
 * de regra em cada uma.
 *
 * ####  POR QUE ISTO NÃO É SEMEADO NA MIGRAÇÃO  ####
 *
 * Porque seria o agente publicando, no lugar do dono do servidor,
 * regras que ele não escreveu — e um jogador banido por uma linha
 * dessas teria razão em reclamar. O modelo existe para vencer a
 * página em branco: o painel o oferece num botão, ele entra como
 * qualquer seção criada à mão, e daí em diante é texto do admin.
 */
export const RULES_TEMPLATE: readonly {
  readonly title: string;
  readonly items: readonly { readonly text: string; readonly tone: RuleTone }[];
}[] = [
  {
    title: 'Equipes e Alianças',
    items: [
      { text: 'Respeite o limite de jogadores por equipe deste servidor.', tone: 'normal' },
      {
        text: 'Aliança entre equipes que ultrapasse esse limite não é permitida.',
        tone: 'proibido',
      },
      { text: 'Dividir loot ou base com outra equipe conta como aliança.', tone: 'alerta' },
    ],
  },
  {
    title: 'Cheats, Exploits e Bugs',
    items: [
      { text: 'Qualquer programa que altere o jogo resulta em banimento permanente.', tone: 'proibido' },
      { text: 'Usar falha do mapa ou da construção para entrar em base é proibido.', tone: 'proibido' },
      { text: 'Encontrou um bug? Avise a administração em vez de usá-lo.', tone: 'normal' },
    ],
  },
  {
    title: 'Gameplay e Desempenho',
    items: [
      { text: 'Não construa de forma a travar o servidor de propósito.', tone: 'alerta' },
      { text: 'Bases abandonadas podem ser removidas pela administração.', tone: 'normal' },
      { text: 'Respeite os outros jogadores no chat e na voz.', tone: 'normal' },
    ],
  },
  {
    title: 'Aplicação das Regras',
    items: [
      { text: 'A administração decide a punição caso a caso, do aviso ao banimento.', tone: 'normal' },
      { text: 'Provas (vídeo ou print) ajudam a apurar qualquer denúncia.', tone: 'normal' },
      { text: 'Não saber a regra não desfaz a punição.', tone: 'alerta' },
    ],
  },
];
