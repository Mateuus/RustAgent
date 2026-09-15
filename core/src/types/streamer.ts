// ============================================================
//  streamer.ts  -  O MODO STREAMER: o que some da tela de quem
//  está transmitindo.
//
//  Pedido do dono em 14/09/2026: "alguns streamer faz live e
//  grava video; precisamos na parte do jogador algumas variáveis
//  que podemos ativar ou desativar para usuários específicos —
//  como desativar a logo para esse usuário, desativar propaganda
//  para esse usuário". E, no mesmo dia: "o próprio jogador, se
//  tiver como streamer ativado, pode mandar um comando para
//  desativar ou ativar — só se tiver ativo".
//
//  ------------------------------------------------------------
//  ####  SÃO DUAS CHAVES, E ELAS TÊM DONOS DIFERENTES  ####
//
//      allowed   o ADMIN libera, na ficha do jogador. Sem isso o
//                comando no jogo responde que ele não tem acesso.
//      active    o JOGADOR liga e desliga, com `/streamer`,
//                quando a live começa e quando ela acaba.
//
//  Juntar as duas numa só destruiria o pedido: o admin teria de
//  ligar e desligar à mão a cada transmissão, e o streamer ficaria
//  sem a marca do servidor mesmo fora do ar — que é justamente
//  quando o servidor QUER aparecer.
//
//  ####  O QUE SOME É ESCOLHA DO ADMIN, E É POR JOGADOR  ####
//
//  `hideLogo`, `hideAds` e `hideMessages` são independentes de
//  propósito (decidido com o dono em 14/09/2026): um parceiro
//  pode esconder a propaganda e MANTER a logo, que é exatamente o
//  acordo que se faz com quem divulga o servidor.
//
//  O `/streamer` do jogador não escolhe entre elas — ele liga e
//  desliga o conjunto que o admin montou para ele. Um comando com
//  subopções seria uma coisa a mais para decorar no meio de uma
//  transmissão ao vivo.
//
//  ####  É DA REDE, E NÃO DE UM SERVIDOR  ####
//
//  Como o VIP, e pela mesma razão: quem está em live é a PESSOA.
//  Ela troca de servidor no meio da transmissão e a logo não pode
//  voltar a aparecer na tela dela por causa disso.
//
//  A propaganda, essa sim, é por servidor (ver types/ads.ts) — mas
//  o que esta tabela diz é "não desenhe para este SteamID", e isso
//  vale em qualquer lugar onde ele entre.
// ============================================================

import { z } from 'zod';

/**
 * O que o agente sabe sobre o modo streamer de UM jogador.
 *
 * Datas em epoch ms, como o resto da ficha (ver
 * db/players-repository.ts) — e não em ISO, como o overlay. As
 * duas convenções existem no projeto; aqui vale a da ficha,
 * porque é onde este dado aparece.
 */
export interface StreamerProfile {
  readonly steamId: string;
  /** O admin liberou o uso do comando. */
  readonly allowed: boolean;
  /** O jogador ligou o modo. Só vale com `allowed`. */
  readonly active: boolean;
  readonly hideLogo: boolean;
  readonly hideAds: boolean;
  readonly hideMessages: boolean;
  /** Quando o modo foi LIGADO pela última vez. `null` = nunca. */
  readonly activatedAt: number | null;
  /** Quem liberou, para a ficha mostrar. `null` = não sei. */
  readonly grantedBy: string | null;
  readonly updatedAt: number;
}

/**
 * O que a ficha mostra para quem NUNCA foi liberado.
 *
 * Linha ausente não é erro: é o estado de 99% dos jogadores. A
 * tela precisa de um objeto para desenhar as chaves desligadas, e
 * inventá-lo em dois lugares (aqui e no painel) seria a segunda
 * fonte da mesma verdade.
 *
 * ####  OS PADRÕES NÃO SÃO TODOS `false`  ####
 *
 * `hideLogo`, `hideAds` e `hideMessages` nascem LIGADOS porque
 * eles só têm efeito com `allowed` e `active` — e quem acabou de
 * liberar um streamer quis esconder o overlay dele, não liberar um
 * comando que não faz nada. O admin desmarca o que quiser manter.
 */
export function defaultStreamerProfile(steamId: string): StreamerProfile {
  return {
    steamId,
    allowed: false,
    active: false,
    hideLogo: true,
    hideAds: true,
    hideMessages: true,
    activatedAt: null,
    grantedBy: null,
    updatedAt: 0,
  };
}

/**
 * Este perfil esconde ALGUMA coisa neste instante?
 *
 * As três condições juntas, e a ordem importa para quem lê: sem
 * liberação não há modo, sem o jogador ter ligado não há live, e
 * sem nenhuma flag marcada o modo está ligado mas não esconde
 * nada — que é um estado legítimo (o admin desmarcou tudo) e
 * precisa sair do payload como qualquer outro.
 */
export function isHidingAnything(profile: StreamerProfile): boolean {
  if (!profile.allowed || !profile.active) {
    return false;
  }

  return profile.hideLogo || profile.hideAds || profile.hideMessages;
}

// ------------------------------------------------------------
//  A BORDA HTTP
// ------------------------------------------------------------

/**
 * O PUT é parcial: a tela salva uma chave sem reenviar as outras.
 *
 * `active` entra aqui de propósito, mesmo sendo do jogador: o
 * suporte precisa poder desligar o modo de quem saiu do ar e
 * esqueceu o comando, e quem está testando o desenho precisa
 * poder ligar sem entrar no jogo.
 */
export const streamerUpdateSchema = z
  .object({
    allowed: z.boolean().optional(),
    active: z.boolean().optional(),
    hideLogo: z.boolean().optional(),
    hideAds: z.boolean().optional(),
    hideMessages: z.boolean().optional(),
  })
  .strict();

export type StreamerUpdateInput = z.infer<typeof streamerUpdateSchema>;
