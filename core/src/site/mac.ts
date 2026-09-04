// ============================================================
//  mac.ts  -  o endereço físico que o beacon manda.
//
//  ####  O SITE GRAVA ISTO, E DEPOIS BANE POR ELE  ####
//
//  O beacon manda `mac`, o site o normaliza (`trim().toLowerCase()`),
//  grava em `agents.beaconMac` e o usa em `findBan(ip, mac)`. Mandar
//  o MAC de uma interface VIRTUAL — uma ponte de Docker, um
//  adaptador de VPN, um loopback — significa gravar no site uma
//  identidade que muda quando o Docker sobe, e banir por ela é banir
//  a máquina errada.
//
//  ####  VAZIO É UMA RESPOSTA VÁLIDA  ####
//
//  O campo é opcional no beacon. Uma string vazia é melhor que um
//  MAC inventado: ela diz "não sei", e o site continua usando o IP.
// ============================================================

import { networkInterfaces } from 'node:os';

/** O que o Node devolve para interface sem endereço físico. */
const EMPTY_MAC = '00:00:00:00:00:00';

/**
 * A primeira interface NÃO interna com MAC de verdade.
 *
 * `''` quando não houver nenhuma. Não lança, nunca: ele roda no
 * boot, e uma máquina sem placa de rede reconhecível não pode
 * impedir o agente de subir.
 */
export function primaryMac(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.mac !== EMPTY_MAC && address.mac !== '') {
        return address.mac.toLowerCase();
      }
    }
  }

  return '';
}
