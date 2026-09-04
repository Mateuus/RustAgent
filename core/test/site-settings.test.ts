// ============================================================
//  site-settings.test.ts  -  a URL do site, editada pela tela.
//
//  ####  O BUG QUE ESTE ARQUIVO EXISTE PARA IMPEDIR  ####
//
//  A primeira versão da rota devolvia a URL lida no BOOT. Gravar
//  funcionava — o valor entrava na tabela `meta` —, mas a tela relia
//  o valor antigo e reescrevia o campo com ele. Para quem estava na
//  frente dela, "gravei e não gravou": o toast dizia sucesso e o
//  campo voltava sozinho.
//
//  A correção não foi só ler na hora. São DOIS valores, e eles são
//  genuinamente diferentes entre gravar e reiniciar:
//
//    - o GRAVADO  -> o que vale no próximo boot. É o que a tela edita;
//    - o EM USO   -> o que os `SiteClient` já construídos usam.
//
//  Esconder a diferença é o que produziu o bug; mostrá-la é o que
//  responde "por que ainda não funcionou?".
// ============================================================

import { describe, expect, it } from 'vitest';

import { openDatabase, MEMORY_DATABASE } from '../src/db/database.js';
import { MetaRepository } from '../src/db/meta-repository.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  SITE_BASE_URL_KEY,
  normalizeSiteBaseUrl,
  rejectSiteBaseUrl,
} from '../src/site/settings.js';

function meta(): MetaRepository {
  const db = openDatabase({ file: MEMORY_DATABASE });

  runMigrations(db);

  return new MetaRepository(db);
}

describe('a URL gravada pela tela', () => {
  it('o que foi gravado é o que a leitura seguinte devolve', () => {
    // O bug: a leitura vinha do boot, e o valor novo nunca aparecia.
    const repository = meta();

    expect(repository.read(SITE_BASE_URL_KEY)).toBeNull();

    repository.write(SITE_BASE_URL_KEY, 'https://devsite2.origemz.com');

    expect(repository.read(SITE_BASE_URL_KEY)).toBe('https://devsite2.origemz.com');
  });

  it('vazio é um valor, e não "nunca gravei"', () => {
    // Gravar vazio é o jeito de DESLIGAR a integração pela tela. Se a
    // leitura tratasse `''` como ausente, ela cairia de volta no
    // `.env` — e desligar pela tela não desligaria nada.
    const repository = meta();

    repository.write(SITE_BASE_URL_KEY, '');

    expect(repository.read(SITE_BASE_URL_KEY)).toBe('');
    expect(repository.read(SITE_BASE_URL_KEY)).not.toBeNull();
  });
});

describe('o que a rota recusa, e a frase que ela ensina', () => {
  it('o /api no fim é o erro que custa uma tarde', () => {
    // O agente acrescenta `/api/agent/...` sozinho. Com o `/api` já
    // no valor, ele monta `.../api/api/agent/...` e o sintoma é 404
    // em tudo — quer dizer, "a loja parou".
    const problem = rejectSiteBaseUrl('https://origemznetwork.com/api');

    expect(problem).not.toBeNull();
    expect(problem).toContain('/api');
  });

  it('recusa caminho, e diz qual', () => {
    const problem = rejectSiteBaseUrl('https://origemznetwork.com/rust/');

    expect(problem).toContain('/rust');
  });

  it('recusa o que não é URL', () => {
    expect(rejectSiteBaseUrl('origemznetwork.com')).not.toBeNull();
    expect(rejectSiteBaseUrl('ftp://origemznetwork.com')).not.toBeNull();
  });

  it('aceita a origem, com e sem barra no fim', () => {
    expect(rejectSiteBaseUrl('https://devsite2.origemz.com')).toBeNull();
    expect(rejectSiteBaseUrl('https://devsite2.origemz.com/')).toBeNull();
    // http é aceito: o ambiente de desenvolvimento costuma não ter TLS.
    expect(rejectSiteBaseUrl('http://127.0.0.1:3000')).toBeNull();
  });

  it('vazio é aceito: é o jeito de desligar', () => {
    expect(rejectSiteBaseUrl('')).toBeNull();
    expect(rejectSiteBaseUrl('   ')).toBeNull();
  });

  it('a forma canônica não tem barra no fim', () => {
    // Sem isso, `.../` e `...` montariam caminhos com barra dupla no
    // meio, e ninguém depura uma barra a mais num endereço.
    expect(normalizeSiteBaseUrl('https://devsite2.origemz.com/')).toBe(
      'https://devsite2.origemz.com',
    );
    expect(normalizeSiteBaseUrl('  https://devsite2.origemz.com///  ')).toBe(
      'https://devsite2.origemz.com',
    );
  });
});

// ============================================================
//  O PAREAMENTO GRAVADO E AINDA NÃO EM USO
//
//  ####  O SEGUNDO BUG PELA MESMA CAUSA  ####
//
//  O primeiro foi a URL: a tela relia o valor do boot e o campo
//  voltava sozinho. Consertado ali, o MESMO defeito sobreviveu no
//  pareamento — e apareceu pior, porque a tela afirmava o oposto do
//  que ela própria mostrava:
//
//    campo:  ID DO SERVIDOR NO SITE = RUST01
//    estado: "não está pareado: sem SITE_SERVER_ID"
//
//  As duas frases na mesma tela, e a verdadeira era a terceira:
//  falta reiniciar. O beacon, a carteira e a fila de cada servidor
//  são montados no BOOT, a partir do `.ini` daquele instante.
//
//  A lição, e é ela que este bloco guarda: sempre que a tela puder
//  gravar algo que só vale no próximo boot, ela tem de dizer QUAL
//  dos dois valores está vendo.
// ============================================================

/** O que a rota de status recebe: o boot e o `.ini` de agora. */
interface Pairing {
  readonly serverId: string;
  readonly siteServerId: string;
  readonly hasToken: boolean;
}

/**
 * A regra da rota, isolada: quem está gravado e o boot não viu.
 *
 * É a mesma expressão de `routes/site.ts` — aqui ela é exercitada
 * sem subir um Fastify inteiro.
 */
function awaitingRestart(
  saved: readonly Pairing[],
  loaded: ReadonlySet<string>,
): readonly Pairing[] {
  return saved.filter((item) => item.siteServerId !== '' && !loaded.has(item.serverId));
}

describe('o pareamento gravado que o boot não viu', () => {
  it('não é "não pareado": é "falta reiniciar"', () => {
    const saved: Pairing[] = [{ serverId: 'server01', siteServerId: 'RUST01', hasToken: true }];
    // O boot não carregou nenhum: o `.ini` estava sem pareamento
    // quando o agente subiu.
    const awaiting = awaitingRestart(saved, new Set());

    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.siteServerId).toBe('RUST01');
  });

  it('o que o boot JÁ carregou não entra na lista', () => {
    // Senão o aviso de "falta reiniciar" ficaria para sempre na tela,
    // inclusive com o pareamento funcionando.
    const saved: Pairing[] = [{ serverId: 'server01', siteServerId: 'RUST01', hasToken: true }];

    expect(awaitingRestart(saved, new Set(['server01']))).toHaveLength(0);
  });

  it('servidor SEM pareamento no .ini continua sendo "não pareado"', () => {
    // Este é o caso em que a frase antiga estava certa, e ela
    // precisa continuar aparecendo.
    const saved: Pairing[] = [{ serverId: 'server01', siteServerId: '', hasToken: false }];

    expect(awaitingRestart(saved, new Set())).toHaveLength(0);
  });

  it('com dois servidores, só o que falta aparece', () => {
    const saved: Pairing[] = [
      { serverId: 'pvp1', siteServerId: 'RUST01', hasToken: true },
      { serverId: 'pve', siteServerId: 'RUST02', hasToken: true },
    ];
    const awaiting = awaitingRestart(saved, new Set(['pvp1']));

    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.serverId).toBe('pve');
  });
});
