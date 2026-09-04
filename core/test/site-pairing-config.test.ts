// ============================================================
//  site-pairing-config.test.ts  -  colar o token pelo painel.
//
//  O bearer do site é gerado no painel DELE e precisa chegar até
//  aqui. Ele mora em `Configs\<id>.ini`, junto da senha de RCON,
//  porque é segredo DAQUELE servidor — e, como ela, ele é gravável
//  pela tela e NUNCA volta para ela.
//
//  O que este arquivo guarda:
//
//    1. as duas chaves são lidas do `.ini` e viram o pareamento;
//    2. o pareamento vira `hasToken`, e o TOKEN não sai;
//    3. dois servidores com o mesmo id no site DERRUBAM o boot;
//    4. esvaziar as duas é o jeito de desparear.
// ============================================================

import { describe, expect, it } from 'vitest';

import { parseIni } from '../src/config.js';
import { applyIniValues, createServerBodySchema } from '../src/servers/create-server.js';

/** O que o `.ini` de um servidor pareado tem a mais. */
const INI = [
  'SERVER_HOSTNAME=PVP 1',
  'RCON_PASSWORD=uma-senha-longa',
  'SITE_SERVER_ID=RUST01',
  'SITE_TOKEN=bearer-secreto-do-site',
].join('\n');

describe('o pareamento na CRIAÇÃO do servidor', () => {
  it('os dois campos são opcionais', () => {
    // O bearer nasce no painel do SITE, e isso costuma acontecer
    // DEPOIS de o servidor existir aqui. Exigi-los na criação
    // obrigaria a criar o servidor duas vezes.
    const parsed = createServerBodySchema.safeParse({
      id: 'pvp1',
      name: 'PVP 1',
      hostname: 'PVP 1',
      map: 'Procedural Map',
      worldSize: 4000,
      maxPlayers: 200,
      rconPassword: 'uma-senha-longa',
    });

    expect(parsed.success).toBe(true);
  });

  it('um id acima de 50 chars é recusado, com a frase que ensina', () => {
    const parsed = createServerBodySchema.safeParse({
      id: 'pvp1',
      name: 'PVP 1',
      hostname: 'PVP 1',
      map: 'Procedural Map',
      worldSize: 4000,
      maxPlayers: 200,
      rconPassword: 'uma-senha-longa',
      siteServerId: 'R'.repeat(51),
    });

    expect(parsed.success).toBe(false);
  });

  it('a chave é ACRESCENTADA num .ini que não a tinha', () => {
    // O modelo passou a trazer as duas, mas um `.ini` antigo não
    // tem — e o painel precisa conseguir gravar nele mesmo assim.
    const antigo = ['SERVER_HOSTNAME=PVP 1', 'RCON_PASSWORD=x'].join('\n');
    const escrito = applyIniValues(antigo, { SITE_SERVER_ID: 'RUST01' });

    expect(parseIni(escrito).SITE_SERVER_ID).toBe('RUST01');
    // E o que já estava lá não é tocado.
    expect(parseIni(escrito).RCON_PASSWORD).toBe('x');
  });

  it('trocar o pareamento não mexe no resto do arquivo', () => {
    const antes = ['SITE_SERVER_ID=RUST01', 'RCON_PASSWORD=x', 'SERVER_ENABLED=1'].join(
      '\n',
    );
    const depois = parseIni(applyIniValues(antes, { SITE_SERVER_ID: 'RUST02' }));

    expect(depois.SITE_SERVER_ID).toBe('RUST02');
    expect(depois.RCON_PASSWORD).toBe('x');
    expect(depois.SERVER_ENABLED).toBe('1');
  });
});

describe('o pareamento no .ini', () => {
  it('as duas chaves são lidas junto do resto', () => {
    const values = parseIni(INI);

    expect(values.SITE_SERVER_ID).toBe('RUST01');
    expect(values.SITE_TOKEN).toBe('bearer-secreto-do-site');
    // E ele não atrapalha o que já existia.
    expect(values.RCON_PASSWORD).toBe('uma-senha-longa');
  });

  it('a caixa alta conta: rust01 e RUST01 são dois', () => {
    // O site casa por texto EXATO, e o 404 que a diferença produz não
    // diz que ela é de caixa — foi por isso que o manual escreveu o
    // aviso, e é por isso que a tela não normaliza o que a pessoa
    // digita.
    expect(parseIni('SITE_SERVER_ID=rust01').SITE_SERVER_ID).not.toBe(
      parseIni('SITE_SERVER_ID=RUST01').SITE_SERVER_ID,
    );
  });

  it('um .ini sem as duas chaves não está pareado', () => {
    const values = parseIni('SERVER_HOSTNAME=PVP 1\nRCON_PASSWORD=uma-senha-longa');

    expect(values.SITE_SERVER_ID).toBeUndefined();
    expect(values.SITE_TOKEN).toBeUndefined();
  });

  it('esvaziar a chave é diferente de não ter a chave', () => {
    // Gravar vazio é o jeito de DESPAREAR pela tela: a linha fica no
    // arquivo, sem valor, e o boot lê "sem pareamento".
    const values = parseIni('SITE_SERVER_ID=\nSITE_TOKEN=');

    expect(values.SITE_SERVER_ID).toBe('');
    expect(values.SITE_TOKEN).toBe('');
  });
});
