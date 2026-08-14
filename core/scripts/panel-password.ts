// ============================================================
//  panel-password.ts  -  gera a linha PANEL_PASSWORD_HASH.
//
//      npm run panel:senha -w core
//
//  Pergunta a senha, imprime a linha pronta e NÃO escreve nada em
//  disco. Copiar e colar no `.env` é de propósito: um script que
//  edita o `.env` sozinho é um script que um dia sobrescreve o
//  arquivo de produção de alguém.
//
//  A digitação é escondida (sem eco), então a senha não fica no
//  terminal nem no histórico do shell.
// ============================================================

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

import { hashPassword } from '../src/auth/operator.js';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  return new Promise((resolve) => {
    // Sem eco: o `_writeToOutput` vazio faz o terminal não
    // imprimir o que está sendo digitado.
    const anyRl = rl as unknown as { _writeToOutput: (text: string) => void };
    stdout.write(question);
    anyRl._writeToOutput = (): void => {};

    rl.question('', (answer) => {
      stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const password = (await ask('Senha do painel: ')).trim();

  if (password.length < 8) {
    console.error('\nA senha precisa ter pelo menos 8 caracteres.\n');
    process.exit(1);
  }

  const confirmation = (await ask('Repita a senha: ')).trim();

  if (password !== confirmation) {
    console.error('\nAs duas senhas não são iguais.\n');
    process.exit(1);
  }

  const hash = await hashPassword(password);

  console.log('\nPonha esta linha no .env, na raiz do projeto:\n');
  console.log(`PANEL_PASSWORD_HASH=${hash}\n`);
}

void main();
