// ============================================================
//  version.ts  -  a versão do agente, em um lugar só.
//
//  ####  ELA PRECISAVA SAIR DO index.ts  ####
//
//  Era `const VERSION = '1.0.0'` declarada dentro de `index.ts`,
//  sem export — e `config.ts` não a alcançava. Com a integração do
//  site, a versão passou a aparecer no `User-Agent` de toda chamada
//  e no corpo do beacon, que são montados na configuração. Um
//  literal repetido lá seria a segunda verdade sobre a versão, e
//  ela viajaria no fio enquanto o `index.ts` já tivesse subido para
//  a seguinte.
// ============================================================

export const VERSION = '1.0.0';

// ============================================================
//  QUAL COMMIT ESTÁ RODANDO
//
//  ####  "JÁ ESTÁ EM PRODUÇÃO?" NÃO TINHA COMO SER RESPONDIDO  ####
//
//  O `VERSION` acima é um literal: ele não muda de um commit para
//  o outro, então duas máquinas com meses de diferença respondem a
//  mesma coisa em `GET /api/system`.
//
//  O desfecho disso apareceu em 20/09/2026: um PR mergeado, o
//  servidor de teste com a tela nova, e produção com a de antes. A
//  única forma de descobrir era abrir o jogo e OLHAR — e olhar só
//  diz "é diferente", nunca "está três commits atrás".
//
//  ####  LIDO DO CLONE, E NÃO DO `git`  ####
//
//  O agente é instalado por `git clone` (Docs/03-DECISOES.md), e
//  `.git/HEAD` é um arquivo de texto de uma linha. Ler o arquivo
//  não depende de o git estar instalado na máquina do servidor,
//  não abre processo nenhum e não falha no boot.
//
//  Sem `.git` (uma cópia por ZIP, por exemplo) a resposta é `null`,
//  que é honesto: "não dá para saber daqui".
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * O commit que este processo está rodando, ou `null`.
 *
 * Só os doze primeiros caracteres: é o que se lê num log ou se
 * compara de olho com o `git log` do outro lado, e o hash inteiro
 * não acrescenta nada a quem está conferindo.
 */
export function readCommit(root: string): string | null {
  const gitDir = join(root, '.git');

  let head: string;

  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    // Sem `.git`: cópia de arquivos, container sem a pasta, ou o
    // agente rodando de `dist` em outro lugar. Ver o cabeçalho.
    return null;
  }

  // `HEAD` detached: o hash está ali mesmo.
  if (!head.startsWith('ref: ')) {
    return head.slice(0, 12);
  }

  const ref = head.slice(5).trim();

  try {
    return readFileSync(join(gitDir, ref), 'utf8').trim().slice(0, 12);
  } catch {
    // O ref pode estar EMPACOTADO: um clone recém-feito guarda os
    // refs em `packed-refs` e não cria o arquivo solto. Sem este
    // segundo caminho, toda instalação nova responderia `null`.
    try {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');

      for (const line of packed.split('\n')) {
        const [hash, name] = line.trim().split(' ');

        if (name === ref && hash !== undefined) {
          return hash.slice(0, 12);
        }
      }
    } catch {
      return null;
    }

    return null;
  }
}
