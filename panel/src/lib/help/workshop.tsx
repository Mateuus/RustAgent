// ============================================================
//  help/workshop.tsx  -  o que a "Skin de temporada" é, e o que
//  o wipe faz com ela.
//
//  As mesmas quatro partes do help/dungeons.tsx e do help/timers.tsx:
//  o que é, um exemplo com número, o limite, e com o que conversa.
//
//  ####  O TEXTO MORA AQUI PORQUE O CONCEITO APARECE EM DUAS TELAS  ####
//
//  A marca é cadastrada em /workshop e CONSUMIDA na tela de wipe. Se
//  as duas explicassem com palavras próprias, a primeira diria "sai
//  no wipe" e a segunda "só quando eu mandar" — e as duas juntas
//  ensinariam a coisa errada. Ver Docs/OrigemZWorkshop/02 §4.6.
// ============================================================

import { HelpExample, HelpWarn, type HelpTopic } from '@/components/ui/help-tip';

export const WORKSHOP_HELP: {
  readonly season: HelpTopic;
  readonly wipeSeasonSkins: HelpTopic;
} = {
  /** O (?) do formulário de cadastro da skin. */
  season: {
    title: 'Skin de temporada',
    short: 'A posse dela PODE sair num wipe — só no wipe em que você escolher.',
    body: (
      <>
        <p>
          Marque quando a skin for de uma temporada. Ela só sai da posse dos jogadores no{' '}
          <strong>wipe em que você escolher “Remover da posse”</strong> — por padrão, nada é
          removido, e uma skin pode atravessar vários wipes.
        </p>
        <HelpExample>
          uma skin do Halloween marcada hoje continua com todos os donos no wipe de semana que vem e
          no seguinte. Ela só sai quando <strong>um wipe</strong> for disparado com “Remover da
          posse” marcado.
        </HelpExample>
        <p>
          A marca não muda <strong>nada</strong> no jogo: o menu de skins só informa que aquela é de
          temporada. Quem aplica, quem vê e quem pode usar continuam exatamente iguais.
        </p>
        <HelpWarn>
          quando um wipe remover, ele remove a posse de <strong>todas</strong> as skins marcadas, de
          todos os jogadores, na rede inteira — vivas e vencidas. O cadastro da skin fica, e o item
          que já foi pintado continua pintado.
        </HelpWarn>
      </>
    ),
  },

  /** O (?) da opção na tela de wipe (execução e cadência). */
  wipeSeasonSkins: {
    title: 'Skins de temporada no wipe',
    short: '“Remover da posse” apaga a posse de todas as skins marcadas. Não tem volta.',
    body: (
      <>
        <p>
          <strong>Manter na posse</strong> (o padrão) não encosta em skin nenhuma.{' '}
          <strong>Remover da posse</strong> apaga a posse de <strong>todas</strong> as skins
          marcadas como “Skin de temporada”, de todos os jogadores, na rede inteira — as posses{' '}
          <strong>vivas e as vencidas</strong>.
        </p>
        <HelpExample>
          com 3 skins marcadas e 12 posses entre elas, o passo do wipe termina dizendo{' '}
          <strong>“12 posse(s) removida(s)”</strong>. Quem estiver online perde a skin do menu na
          hora; quem está fora, ao entrar.
        </HelpExample>
        <p>
          O que ele <strong>não</strong> faz: não apaga o cadastro da skin (ela continua no catálogo,
          e pode ser dada de novo), e não tira a skin do item que já foi pintado.
        </p>
        <HelpWarn>
          é <strong>irreversível</strong>. O backup do wipe copia a pasta do save, e a posse não mora
          lá — ela é do banco do agente. Remover por engano quer dizer devolver na mão, jogador por
          jogador.
        </HelpWarn>
      </>
    ),
  },
};
