// ============================================================
//  panel-password.ts  -  gera a linha PANEL_PASSWORD_HASH.
//
//      npm run panel:senha -w core             pergunta a senha
//      npm run panel:senha -w core -- --gerar  sorteia uma
//
//  Imprime a linha pronta e NÃO escreve nada em disco. Copiar e
//  colar no `.env` é de propósito: um script que edita o `.env`
//  sozinho é um script que um dia sobrescreve o arquivo de
//  produção de alguém.
//
//  ------------------------------------------------------------
//  ####  A DIGITAÇÃO NÃO APARECE, E ISSO PRECISA SER DITO  ####
//
//  A senha é digitada às cegas para não ficar no terminal nem no
//  histórico do shell. Sem uma linha avisando, um terminal que
//  não mostra nada é indistinguível de um programa travado — e
//  foi exatamente o que aconteceu na primeira versão deste
//  script, que ainda por cima escrevia o prompt com
//  `stdout.write` sem quebra de linha (o PowerShell segura isso
//  no buffer, e aí nem o aviso aparecia).
//
//  Daí as duas regras aqui: todo texto sai por `console.log` —
//  que termina em `\n` e faz o flush —, e o aviso vem ANTES da
//  pergunta.
// ============================================================

import { randomBytes } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

import { hashPassword } from '../src/auth/operator.js';

/** Sem `/ \ ? #` nem espaço — a mesma restrição do resto do projeto. */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';

function randomPassword(length = 20): string {
  const bytes = randomBytes(length);

  return Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length] ?? '-').join('');
}

/**
 * Pergunta sem eco.
 *
 * O `_writeToOutput` vazio é o que apaga o eco: o readline não
 * expõe isso na API pública, e é o caminho que todo prompt de
 * senha em Node usa.
 */
function askHidden(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const internal = rl as unknown as { _writeToOutput: (text: string) => void };

  internal._writeToOutput = (): void => {};

  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--gerar') || args.includes('-g')) {
    const password = randomPassword();

    console.log('');
    console.log('Senha sorteada (guarde-a agora — ela não é gravada em lugar nenhum):');
    console.log('');
    console.log(`    ${password}`);
    console.log('');
    console.log('Ponha esta linha no .env, na raiz do projeto:');
    console.log('');
    console.log(`PANEL_PASSWORD_HASH=${await hashPassword(password)}`);
    console.log('');

    return;
  }

  if (stdin.isTTY !== true) {
    console.error('');
    console.error('Este terminal não aceita digitação escondida.');
    console.error('Use:  npm run panel:senha -w core -- --gerar');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('Digite a senha do painel e tecle Enter.');
  console.log('A DIGITAÇÃO NÃO APARECE NA TELA — é de propósito, não é travamento.');
  console.log('(ou rode com  -- --gerar  para sortear uma)');
  console.log('');
  console.log('Senha:');

  const password = (await askHidden()).trim();

  if (password.length < 8) {
    console.error('');
    console.error('A senha precisa ter pelo menos 8 caracteres.');
    console.error('');
    process.exit(1);
  }

  console.log('Repita a senha:');

  const confirmation = (await askHidden()).trim();

  if (password !== confirmation) {
    console.error('');
    console.error('As duas senhas não são iguais.');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('Ponha esta linha no .env, na raiz do projeto:');
  console.log('');
  console.log(`PANEL_PASSWORD_HASH=${await hashPassword(password)}`);
  console.log('');
}

void main();
