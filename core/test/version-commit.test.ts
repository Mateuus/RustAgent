// ============================================================
//  version-commit.test.ts  -  qual commit está rodando aqui?
//
//  ####  A PERGUNTA QUE NÃO TINHA COMO SER RESPONDIDA  ####
//
//  Em 20/09/2026 um PR foi mergeado, o servidor de teste ficou com
//  a tela nova e produção continuou com a de antes. Perguntar ao
//  agente de lá não ajudava: `GET /api/system` respondia `1.0.0`
//  nas duas máquinas, porque a versão é um literal que ninguém
//  mexe a cada commit.
//
//  A única forma de descobrir era abrir o jogo e OLHAR — e olhar
//  só diz "está diferente", nunca "está três commits atrás".
//
//  `readCommit` lê o `.git/HEAD` do clone. Os dois caminhos que ele
//  precisa acertar estão medidos aqui, porque os dois EXISTEM em
//  instalação de verdade: o ref solto (o clone que já fez commit ou
//  checkout) e o `packed-refs` (o clone recém-feito, que não cria o
//  arquivo solto).
// ============================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCommit } from '../src/version.js';

const HASH = '4f1c0e9a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e';

const feitos: string[] = [];

/** Um clone de mentira, com só o que o `readCommit` lê. */
function fakeClone(build: (gitDir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'rustagent-git-'));
  const gitDir = join(root, '.git');

  mkdirSync(gitDir, { recursive: true });
  build(gitDir);
  feitos.push(root);

  return root;
}

afterEach(() => {
  while (feitos.length > 0) {
    const root = feitos.pop();

    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('o commit que o agente está rodando', () => {
  it('lê o ref solto, que é o caso de quem já fez checkout', () => {
    const root = fakeClone((gitDir) => {
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
      writeFileSync(join(gitDir, 'refs', 'heads', 'main'), `${HASH}\n`);
    });

    expect(readCommit(root)).toBe(HASH.slice(0, 12));
  });

  it('lê o `packed-refs`, que é o caso do clone recém-feito', () => {
    // ####  SEM ISTO, TODA INSTALAÇÃO NOVA RESPONDIA `null`  ####
    //
    // `git clone` guarda os refs empacotados e não cria o arquivo
    // solto até o primeiro commit ou checkout — ou seja, justamente
    // a máquina que acabou de ser instalada é a que não saberia
    // dizer em que commit está.
    const root = fakeClone((gitDir) => {
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(
        join(gitDir, 'packed-refs'),
        `# pack-refs with: peeled fully-peeled sorted\n${HASH} refs/heads/main\n`,
      );
    });

    expect(readCommit(root)).toBe(HASH.slice(0, 12));
  });

  it('lê o HEAD destacado, sem ref nenhum no meio', () => {
    const root = fakeClone((gitDir) => {
      writeFileSync(join(gitDir, 'HEAD'), `${HASH}\n`);
    });

    expect(readCommit(root)).toBe(HASH.slice(0, 12));
  });

  it('sem `.git`, responde `null` em vez de inventar', () => {
    // Uma cópia por ZIP, ou o agente rodando de `dist` em outro
    // lugar. "Não dá para saber daqui" é a resposta honesta — e é
    // diferente de um hash errado, que mandaria alguém procurar
    // defeito na máquina certa.
    const root = mkdtempSync(join(tmpdir(), 'rustagent-sem-git-'));

    feitos.push(root);

    expect(readCommit(root)).toBeNull();
  });

  it('e o ref que aponta para o nada também é `null`', () => {
    const root = fakeClone((gitDir) => {
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/uma-branch-que-sumiu\n');
    });

    expect(readCommit(root)).toBeNull();
  });
});
