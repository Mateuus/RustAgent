// ============================================================
//  oxide-compat.test.ts  -  o Oxide "latest" NÃO é sempre o do
//  build do Rust que está em disco.
//
//  ####  O DEFEITO QUE ISTO TRAVA  ####
//
//  Aconteceu em 03/09/2026, com estes carimbos de tempo:
//
//      17:29:23  a Facepunch publica o build 25083359
//      17:32:32  o SteamCMD do agente termina de baixá-lo
//      17:32:33  o agente baixa o Oxide "latest" — 2.0.7638,
//                de 28/08, feita para o build ANTERIOR
//      17:32:41  o OxideMod publica a 2.0.7676, a do build novo
//
//  Nove segundos de diferença, e o servidor passou a noite subindo
//  e travando no boot: `MissingMethodException` no log do jogo,
//  processo vivo, RCON mudo, quinze minutos de espera por
//  operação.
//
//  Os números abaixo são os de verdade, lidos do `timeupdated` do
//  branch e da API do GitHub. Se algum dia alguém "simplificar" a
//  regra, é este teste que vai dizer que a noite volta.
// ============================================================

import { describe, expect, it } from 'vitest';

import {
  explainOxideBehind,
  FALLBACK_ZIP,
  oxideServesRustBuild,
  parseRelease,
} from '../src/oxide/compat.js';

/** O relógio da noite em que isto aconteceu. */
const RUST_BUILD_25083359 = Date.parse('2026-09-03T17:29:23.000Z');
const OXIDE_2_0_7638 = Date.parse('2026-08-28T10:57:01Z');
const OXIDE_2_0_7676 = Date.parse('2026-09-03T17:32:41Z');

describe('a release do Oxide serve para o build do Rust?', () => {
  it('recusa a release publicada ANTES do build — o caso de 03/09', () => {
    expect(oxideServesRustBuild(OXIDE_2_0_7638, RUST_BUILD_25083359)).toBe(false);
  });

  it('aceita a release publicada depois — a mesma noite, nove segundos adiante', () => {
    expect(oxideServesRustBuild(OXIDE_2_0_7676, RUST_BUILD_25083359)).toBe(true);
  });

  it('aceita a release publicada no MESMO instante do build', () => {
    expect(oxideServesRustBuild(RUST_BUILD_25083359, RUST_BUILD_25083359)).toBe(true);
  });

  // ####  NÃO SABER NÃO PODE PARAR O AGENTE  ####
  //
  // Sem uma das duas datas, recusar transformaria uma piscada do
  // GitHub — ou da Steam — num servidor que não sobe. O `false`
  // desta função é uma AFIRMAÇÃO, e ela só sai com as duas datas
  // na mão.
  it('deixa passar quando falta a data do Oxide (API do GitHub fora)', () => {
    expect(oxideServesRustBuild(null, RUST_BUILD_25083359)).toBe(true);
  });

  it('deixa passar quando falta a data do build (Steam fora)', () => {
    expect(oxideServesRustBuild(OXIDE_2_0_7638, null)).toBe(true);
  });
});

describe('a release, como o GitHub a descreve', () => {
  it('lê a tag, a data e a URL do zip', () => {
    const release = parseRelease({
      tag_name: '2.0.7676',
      published_at: '2026-09-03T17:32:41Z',
      assets: [
        { name: 'Oxide.Rust.zip', browser_download_url: 'https://exemplo/Oxide.Rust.zip' },
        { name: 'outra-coisa.zip', browser_download_url: 'https://exemplo/nao.zip' },
      ],
    });

    expect(release.tag).toBe('2.0.7676');
    expect(release.publishedAt).toBe(OXIDE_2_0_7676);
    expect(release.zipUrl).toBe('https://exemplo/Oxide.Rust.zip');
  });

  // A 2.0.7638 veio com o corpo VAZIO — foi por isso que a régua
  // não pôde ser o texto da release. Mas a data sempre vem.
  it('não depende do corpo da release, que às vezes vem vazio', () => {
    const release = parseRelease({
      tag_name: '2.0.7638',
      body: '',
      published_at: '2026-08-28T10:57:01Z',
      assets: [{ name: 'Oxide.Rust.zip', browser_download_url: 'https://exemplo/a.zip' }],
    });

    expect(release.publishedAt).toBe(OXIDE_2_0_7638);
  });

  it('cai na URL direta quando o asset não veio', () => {
    const release = parseRelease({ tag_name: '2.0.7676', assets: [] });

    expect(release.zipUrl).toBe(FALLBACK_ZIP);
    expect(release.publishedAt).toBeNull();
  });

  it('sobrevive a um payload que não é o esperado', () => {
    const release = parseRelease({ mensagem: 'API rate limit exceeded' });

    expect(release.tag).toBe('latest');
    expect(release.publishedAt).toBeNull();
    expect(release.zipUrl).toBe(FALLBACK_ZIP);
  });

  it('ignora uma data ilegível em vez de virar NaN', () => {
    const release = parseRelease({ tag_name: 'x', published_at: 'ontem à tarde' });

    expect(release.publishedAt).toBeNull();
  });
});

describe('a frase que a tela mostra', () => {
  const frase = explainOxideBehind({
    tag: '2.0.7638',
    oxidePublishedAt: OXIDE_2_0_7638,
    rustBuildId: '25083359',
    rustBuildPublishedAt: RUST_BUILD_25083359,
  });

  it('nomeia a versão, o build e as duas datas', () => {
    expect(frase).toContain('2.0.7638');
    expect(frase).toContain('25083359');
    expect(frase).toContain('2026-08-28');
    expect(frase).toContain('2026-09-03');
  });

  // Quem lê isto às três da manhã precisa saber DUAS coisas: que
  // não é preciso fazer nada, e o que aconteceria se forçasse.
  it('diz o que aconteceria se aplicasse, e que o agente resolve sozinho', () => {
    expect(frase).toContain('MissingMethodException');
    expect(frase).toContain('sozinho');
  });
});
