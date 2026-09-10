// ============================================================
//  seed.ts  -  as sete plantas que vêm com o projeto.
//
//  ####  ELE SÓ AGE NUM ACERVO VAZIO  ####
//
//  E isso é a regra inteira. Um seeder que reinserisse a cada boot
//  ressuscitaria, toda madrugada, a planta que alguém apagou de
//  propósito — e ninguém entenderia por quê.
//
//  A consequência de desenho: quem apagar todas as sete e reiniciar
//  o agente as recebe de volta. É o comportamento certo para o caso
//  que importa (banco novo, instalação nova) e um incômodo de um
//  clique no caso raro.
//
//  ####  E ELE NÃO É UM PASSO DE INSTALAÇÃO  ####
//
//  Roda no boot, junto com as migrações, pela mesma razão que elas:
//  o projeto não tem "passo de setup" para alguém esquecer. Ver
//  Docs/README.md.
// ============================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BlueprintKind,
  DungeonBlueprintsRepository,
} from '../db/dungeon-blueprints-repository.js';
import type { DungeonLayoutsRepository } from '../db/dungeon-layouts-repository.js';
import type { Logger } from '../logger.js';
import { FACTORY_LAYOUTS } from '../types/dungeon-layouts.js';
import { toError } from '../util.js';

/**
 * Onde as plantas de fábrica moram.
 *
 * `Assets/` e não `Docs/`: elas são conteúdo que o agente lê em
 * tempo de execução, e documentação é o que gente lê. Ficam ao
 * lado de `Assets/ui`, que é lido pelo mesmo motivo.
 */
export const DUNGEON_ASSETS_DIR = join('Assets', 'dungeons');

/**
 * Tira o `#dung#` do nome do arquivo.
 *
 * O prefixo é do CopyPaste — ele o usava para separar os arquivos
 * dele dos de outros plugins na mesma pasta. Aqui a pasta já é só
 * nossa, e um `#` no meio de uma URL de painel é um problema que
 * não precisa existir.
 */
function slugOf(fileName: string): string {
  return fileName.replace(/\.json$/i, '').replace(/^#dung#/i, '');
}

/**
 * `entrance` ou `base`, pelo nome.
 *
 * Frágil de propósito: o arquivo não diz o que é, e a alternativa —
 * adivinhar pela geometria — erraria calada. Um nome fora do padrão
 * cai em `entrance`, que é o caso em que a falta de alçapão é
 * cobrada; errar para o lado que reclama é melhor que errar para o
 * lado que aceita.
 */
function kindOf(slug: string): BlueprintKind {
  return slug.toLowerCase().startsWith('base') ? 'base' : 'entrance';
}

/**
 * Põe as plantas de fábrica no banco, se ele estiver vazio.
 *
 * Devolve quantas entraram. Zero é o resultado normal de todo boot
 * a partir do segundo.
 */
export function seedDungeonBlueprints(
  repository: DungeonBlueprintsRepository,
  options: { readonly rootDir: string; readonly logger?: Logger } ,
): number {
  if (repository.count() > 0) return 0;

  const dir = join(options.rootDir, DUNGEON_ASSETS_DIR);
  let files: readonly string[];

  try {
    files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch (cause) {
    // A pasta pode não existir, e não existir é um estado válido:
    // quem clonou o repositório sem os assets não tem plantas de
    // fábrica, e isso não impede o agente de subir.
    options.logger?.debug(
      { dir, error: toError(cause).message },
      'sem plantas de fábrica para importar',
    );

    return 0;
  }

  let imported = 0;

  for (const fileName of files) {
    const slug = slugOf(fileName);

    try {
      const content = readFileSync(join(dir, fileName), 'utf8');

      const result = repository.save({
        id: slug,
        name: slug,
        kind: kindOf(slug),
        content,
        origin: 'builtin',
      });

      if (result.ok) {
        imported += 1;
        continue;
      }

      // Uma planta ruim não pode derrubar as outras seis. Ela vira
      // um aviso com nome, e o admin decide o que fazer.
      options.logger?.warn(
        { blueprint: slug, problem: result.problem },
        'planta de fábrica recusada',
      );
    } catch (cause) {
      options.logger?.warn(
        { blueprint: slug, error: toError(cause).message },
        'planta de fábrica ilegível',
      );
    }
  }

  if (imported > 0) {
    options.logger?.info({ imported }, 'plantas de fábrica importadas');
  }

  return imported;
}

/**
 * Põe os quatro traçados de fábrica no banco, se ele estiver vazio.
 *
 * ####  MESMA REGRA DAS PLANTAS: SÓ NUM ACERVO VAZIO  ####
 *
 * Um seeder que reinserisse a cada boot ressuscitaria, toda
 * madrugada, o traçado que alguém apagou de propósito.
 *
 * ####  E ELES NÃO SÃO ARQUIVO, SÃO CÓDIGO  ####
 *
 * As plantas do CopyPaste são megabytes e moram em `Assets/`. Os
 * quatro traçados são quarenta linhas de texto: moram em
 * `types/dungeon-layouts.ts`, ao lado das quatro receitas de
 * fábrica, e pela mesma razão — são conteúdo do produto,
 * versionado junto com quem o lê.
 *
 * Devolve quantos entraram. Zero é o resultado normal de todo boot
 * a partir do segundo.
 */
export function seedDungeonLayouts(
  repository: DungeonLayoutsRepository,
  options: { readonly logger?: Logger } = {},
): number {
  if (repository.count() > 0) return 0;

  let imported = 0;

  for (const layout of FACTORY_LAYOUTS) {
    try {
      repository.save({
        id: layout.id,
        name: layout.name,
        description: layout.description,
        grid: layout.grid,
        origin: 'builtin',
      });

      imported += 1;
    } catch (cause) {
      // Um traçado ruim não pode derrubar os outros três.
      options.logger?.warn(
        { layout: layout.id, error: toError(cause).message },
        'traçado de fábrica recusado',
      );
    }
  }

  if (imported > 0) {
    options.logger?.info({ imported }, 'traçados de fábrica importados');
  }

  return imported;
}
