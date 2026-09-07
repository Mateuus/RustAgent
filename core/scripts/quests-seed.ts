// ============================================================
//  quests-seed.ts  -  o menu `/quest` e um punhado de missões
//  para testar no jogo.
//
//  ####  PARA QUE ISTO EXISTE  ####
//
//  Duas coisas precisam estar no banco antes de alguém conseguir
//  abrir `/quest` no jogo:
//
//    1. o MENU PRINCIPAL na revisão nova, ligado ao servidor — é
//       dele que saem a página MISSÕES e o atalho `/quest`, e sem
//       a revisão nova o `OrigemZUI` não registra o comando;
//    2. pelo menos uma MISSÃO, senão a tela abre vazia.
//
//  Ele também APAGA o documento `menu-quests`, que era o menu
//  clonado da primeira versão.
//
//  O documento nasce do preset (`UI_PRESETS`), o mesmo caminho que
//  a tela de Interface do painel usa. As missões são de teste: as
//  quantidades são pequenas de propósito, para dar para conferir o
//  ciclo inteiro em minutos e não em horas.
//
//  ####  ELE É IDEMPOTENTE  ####
//
//  Rodar duas vezes não duplica nada: o documento é encontrado pelo
//  slug e as missões pelo id. É o que permite rodá-lo depois de
//  mexer no preset, para ver a mudança no jogo.
//
//  Uso:
//      npx tsx scripts/quests-seed.ts [serverId]
// ============================================================

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { QuestsRepository } from '../src/db/quests-repository.js';
import { UiDocumentsRepository } from '../src/db/ui-documents-repository.js';
import { MAIN_MENU_SLUG, UI_PRESETS } from '../src/game/ui-preset-main-menu.js';
import { questInputSchema, type QuestDraft } from '../src/types/quests.js';

const args = process.argv.slice(2);

// ####  O MENU PRINCIPAL SÓ COM A FLAG  ####
//
// Recriá-lo do preset APAGA o que o admin tenha editado na tela de
// Interface — e o menu é o documento que mais se mexe. A flag
// existe para que isso nunca aconteça por engano: quem a digita
// sabe o que está trocando.
//
// Ela é o caminho para o `/menu` ganhar a aba MISSÕES e o atalho
// `/quest`, que só existem no preset novo.
const withMainMenu = args.includes('--menu');

/**
 * O documento que as missões tiveram antes, e que não existe mais.
 *
 * Ele era o menu inteiro CLONADO só para responder a `/quest`. Hoje
 * `/quest` é um atalho do próprio menu (ver `shortcuts` em
 * types/ui-document.ts), e este slug é lixo: enquanto estiver no
 * banco, o servidor continua recebendo as onze telas dele em toda
 * carga e o admin continua vendo dois "Menu" na tela de Interface.
 */
const LEGACY_QUESTS_SLUG = 'menu-quests';
const serverId = args.find((item) => !item.startsWith('--')) ?? 'server01';

// ####  O CAMINHO É RESOLVIDO DA RAIZ DO PROJETO  ####
//
// `data/rustagent.db` relativo criaria um banco VAZIO dentro de
// `core/` quando o script fosse rodado de lá — e a primeira
// gravação falharia com FOREIGN KEY, porque o servidor não existe
// nele. MEDIDO: aconteceu.
const root = fileURLToPath(new URL('../..', import.meta.url));
const db = openDatabase({ file: join(root, 'data', 'rustagent.db') });

runMigrations(db);

// ------------------------------------------------------------
//  1. O DOCUMENTO
// ------------------------------------------------------------

const documents = new UiDocumentsRepository(db);

/** Grava um preset por slug e o liga ao servidor. */
function seedDocument(slug: string): void {
  const preset = UI_PRESETS[slug];

  if (preset === undefined) {
    throw new Error(`o preset "${slug}" sumiu de UI_PRESETS`);
  }

  // O `slug` do documento é o `id` do próprio `UiDocument` — ver o
  // `create` do repositório.
  const existing = documents.getBySlug(slug);
  const document = existing === null ? documents.create(preset()) : documents.update(existing.id, preset());

  if (document === null) {
    throw new Error(`não consegui gravar o documento "${slug}"`);
  }

  // ####  LIGAR AO SERVIDOR É O QUE FAZ O COMANDO EXISTIR  ####
  //
  // O `OrigemZUI` registra `/quest` a partir do que RECEBE. Um
  // documento gravado e não ligado não é empurrado a servidor
  // nenhum.
  documents.setBinding(serverId, document.id, { enabled: true, hidden: [] });

  console.log(`documento "${slug}" pronto e ligado a ${serverId}`);
}

// ------------------------------------------------------------
//  O CLONE VAI EMBORA
// ------------------------------------------------------------

const legacy = documents.getBySlug(LEGACY_QUESTS_SLUG);

if (legacy === null) {
  console.log(`nada a apagar: "${LEGACY_QUESTS_SLUG}" não está no banco`);
} else if (documents.remove(legacy.id)) {
  console.log(`documento "${LEGACY_QUESTS_SLUG}" APAGADO — /quest agora é atalho do menu`);
} else {
  console.log(`não consegui apagar "${LEGACY_QUESTS_SLUG}"`);
}

if (withMainMenu) {
  seedDocument(MAIN_MENU_SLUG);
}

// ------------------------------------------------------------
//  2. AS MISSÕES
// ------------------------------------------------------------

/**
 * As seis formas de objetivo que funcionam hoje, uma de cada.
 *
 * Os números são pequenos porque o ponto é ver o ciclo fechar — o
 * contador subir, a missão concluir, o prêmio sair —, e não medir
 * paciência.
 */
const SEED: readonly (QuestDraft & { readonly id: string })[] = [
  {
    id: 'teste-cientistas',
    title: 'Limpeza no monumento',
    description: 'Mate 3 cientistas em qualquer monumento.',
    category: 'teste',
    objectives: [{ seq: 0, kind: 'kill', target: 'scientist', amount: 3 }],
    rewards: [{ kind: 'coins', amount: 500 }],
  },
  {
    id: 'teste-enxofre',
    title: 'Minerador de enxofre',
    description: 'Junte 100 de minério de enxofre na picareta.',
    category: 'teste',
    objectives: [{ seq: 0, kind: 'gather', target: 'sulfur.ore', amount: 100 }],
    rewards: [{ kind: 'item', shortname: 'metal.refined', amount: 25 }],
  },
  {
    id: 'teste-craft',
    title: 'Fabricante',
    description: 'Fabrique 20 flechas de madeira.',
    category: 'teste',
    objectives: [{ seq: 0, kind: 'craft', target: 'arrow.wooden', amount: 20 }],
    rewards: [{ kind: 'coins', amount: 200 }],
  },
  {
    id: 'teste-presenca',
    title: 'Presença confirmada',
    description: 'Fique 2 minutos online. Ela começa sozinha quando você entra.',
    category: 'teste',
    // `autoAccept`: ela abre no `onPlayerJoined` sem ninguém clicar.
    autoAccept: true,
    objectives: [{ seq: 0, kind: 'playtime', amount: 2 }],
    rewards: [{ kind: 'points', metric: 'quest.completed', amount: 1 }],
  },
  {
    id: 'teste-saque',
    title: 'Catador',
    description: 'Junte 20 de scrap. Eles SAEM do inventário no resgate.',
    category: 'teste',
    // O hook mais caro do jogo, e o `consume` do §7.4 — os dois no
    // mesmo teste.
    objectives: [{ seq: 0, kind: 'loot', target: 'scrap', amount: 20, consume: true }],
    rewards: [{ kind: 'coins', amount: 1000 }],
  },
  {
    id: 'teste-cadeia',
    title: 'Veterano',
    description: 'Só aparece depois que você resgatar a Limpeza no monumento.',
    category: 'teste',
    requiresQuest: 'teste-cientistas',
    repeatMode: 'cooldown',
    cooldownSeconds: 300,
    objectives: [{ seq: 0, kind: 'kill', target: 'scientist', amount: 5 }],
    rewards: [
      { kind: 'coins', amount: 750 },
      { kind: 'points', metric: 'quest.completed', amount: 2 },
    ],
  },
];

const quests = new QuestsRepository(db);

for (const draft of SEED) {
  const { id, ...body } = draft;
  const input = questInputSchema.parse(body);

  if (quests.get(id) === null) {
    quests.create(id, input);
    console.log(`missão criada: ${id} — ${input.title}`);
  } else {
    quests.update(id, input);
    console.log(`missão atualizada: ${id} — ${input.title}`);
  }
}

console.log('\npronto. No jogo:');
console.log('  /quest            abre o menu direto nas missões');
console.log('  /menu             tem a aba MISSÕES (só depois de rodar com --menu)');
console.log('  A lista DISPONÍVEIS tem as missões; a de PRESENÇA começa sozinha.');

if (!withMainMenu) {
  console.log('\nO menu principal NÃO foi tocado. Para ele ganhar a aba MISSÕES:');
  console.log('  npx tsx scripts/quests-seed.ts --menu');
  console.log('  (isso RECRIA o menu do preset e apaga o que foi editado em Interface)');
}
