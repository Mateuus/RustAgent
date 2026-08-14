// ============================================================
//  clipboard.ts  -  copiar o SteamID.
//
//  ####  A API DE ÁREA DE TRANSFERÊNCIA NÃO EXISTE EM TODO
//        LUGAR  ####
//
//  Ela exige contexto seguro, e o painel é servido por HTTP puro
//  num IP de rede local com frequência. Falhar em silêncio ali
//  deixaria um botão que não faz nada; o desfecho é mostrar o id
//  no toast, de onde ainda dá para copiar à mão.
//
//  Mora aqui, e não dentro de uma tela, porque os dois lugares que
//  copiam SteamID são telas diferentes — a lista de quem está
//  online num servidor e a ficha do jogador. Duas cópias
//  divergiriam no primeiro ajuste.
// ============================================================

import { toast } from '@/lib/toast';

export function copySteamId(steamId: string): void {
  void (async () => {
    try {
      await navigator.clipboard.writeText(steamId);
      toast.success('SteamID copiado', { description: steamId });
    } catch {
      toast.info('Copie à mão', {
        description: `${steamId} — o navegador só libera a área de transferência em HTTPS.`,
        duration: null,
      });
    }
  })();
}
