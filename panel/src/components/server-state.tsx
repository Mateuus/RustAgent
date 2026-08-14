// ============================================================
//  server-state.tsx  -  o estado de um servidor, em uma etiqueta.
//
//  Os quatro estados são perguntas diferentes, e misturá-las é o
//  defeito clássico desta tela:
//
//    não instalado  o jogo não está em disco
//    parado         instalado, e o agente não cuida dele (ou o
//                   processo está fora do ar)
//    conectando     o agente cuida dele, mas o RCON ainda não
//                   respondeu — um mapa procedural leva MINUTOS
//    no ar          o RCON respondeu. É o único sinal que vale
//
//  "Conectando" existir é o que impede alguém de achar que travou
//  e clicar em Iniciar de novo.
// ============================================================

import type { ServerView } from '@/lib/api';

export type ServerState = 'nao-instalado' | 'parado' | 'conectando' | 'no-ar';

export function serverStateOf(server: ServerView): ServerState {
  if (!server.installed) {
    return 'nao-instalado';
  }

  if (server.rcon === null) {
    return 'parado';
  }

  return server.rcon.connected ? 'no-ar' : 'conectando';
}

const LABEL: Record<ServerState, string> = {
  'nao-instalado': 'não instalado',
  parado: 'parado',
  conectando: 'conectando',
  'no-ar': 'no ar',
};

// A cor NUNCA é o único sinal: o texto ao lado diz o mesmo, para
// quem não separa verde de âmbar.
const DOT: Record<ServerState, string> = {
  'nao-instalado': 'bg-muted',
  parado: 'bg-muted',
  conectando: 'bg-amber',
  'no-ar': 'bg-olive',
};

export function ServerStateBadge({ server }: { server: ServerView }) {
  const state = serverStateOf(server);

  return (
    <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-2xs uppercase tracking-wider text-muted">
      <span className={`inline-block h-2 w-2 rounded-full ${DOT[state]}`} aria-hidden />
      {LABEL[state]}
    </span>
  );
}
