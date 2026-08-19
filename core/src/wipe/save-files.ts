// ============================================================
//  save-files.ts  -  O QUE UM WIPE APAGA.
//
//  É o arquivo mais perigoso desta fase: uma regra errada aqui
//  apaga o trabalho de todos os jogadores do servidor. Por isso
//  ele NÃO APAGA NADA — ele só CLASSIFICA, e cada decisão vem com
//  o motivo escrito, em português, para aparecer na tela ANTES de
//  qualquer coisa acontecer (ver preview.ts).
//
//  Quem apaga é o passo `apagar` de run.ts, e ele consome esta
//  mesma classificação. Uma lista do que SERIA apagado, exibida na
//  tela, e outra do que É apagado de fato seriam duas verdades
//  sobre a mesma pasta — e a divergência entre elas só apareceria
//  depois do estrago.
//
//  ------------------------------------------------------------
//  ####  CLASSIFICAR POR PADRÃO, E NUNCA POR NOME FIXO  ####
//
//  A internet inteira diz para apagar `proceduralmap.*.sav`. Isso
//  funciona até o servidor rodar um mapa custom ou um dos mapas
//  fixos do jogo — e aí o save se chama outra coisa, sobrevive ao
//  "wipe", e o mundo velho volta inteiro no próximo boot.
//
//  Então a regra é a EXTENSÃO (todo `.map`, todo `.sav` e os
//  rotativos `.sav.1`, `.sav.2`) ou o PREFIXO (`player.deaths.`,
//  `sv.files.`), nunca o nome inteiro.
//
//  ------------------------------------------------------------
//  ####  O NÚMERO NO NOME É A VERSÃO DO FORMATO  ####
//
//  MEDIDO em Servers\server01\server\server01\ nesta árvore:
//
//      player.blueprints.16.db     player.states.287.db
//      player.deaths.16.db         sv.files.287.db
//      player.identities.16.db     clans.287.db
//      player.tokens.db            relationship.287.db
//
//  Três coisas de uma vez, e nenhuma delas é palpite:
//
//    1. `16` e `287` CONVIVEM na mesma pasta. O número é a versão
//       do formato da Facepunch, não um contador nosso: quando ela
//       muda o formato, o jogo cria o arquivo com o número
//       seguinte e IGNORA o anterior. Um nome cravado deixaria o
//       arquivo novo para trás no mês em que a versão mudasse — e
//       o BP wipe simplesmente não aconteceria;
//    2. `player.tokens.db` NÃO TEM NÚMERO. Um padrão que exigisse
//       `nome.<n>.db` erraria este;
//    3. cada `.db` tem o `-wal` ao lado. Ver SIDECAR, lá embaixo.
//
//  ------------------------------------------------------------
//  ####  E DOIS ARQUIVOS QUE NENHUM GUIA MENCIONA  ####
//
//  `proceduralmap.4000.12345.287_occlusion_3.dat` (12 MB) e
//  `relationship.287.db` também estão na pasta de verdade, e não
//  aparecem em documentação nenhuma. O primeiro é derivado do
//  mapa e some com ele; o segundo é reconhecimento entre jogadores
//  e FICA. Os dois estão nas regras abaixo com o motivo.
// ============================================================

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { BpPolicy } from '../types/wipe.js';

/** O que acontece com um arquivo naquele wipe. */
export type FileFate = 'delete' | 'keep';

/** A que assunto o arquivo pertence, para a tela agrupar. */
export type FileGroup = 'world' | 'uploads' | 'deaths' | 'blueprints' | 'players' | 'other';

/** Um arquivo da pasta do save, com o destino dele já decidido. */
export interface ClassifiedFile {
  readonly name: string;
  readonly bytes: number;
  readonly fate: FileFate;
  readonly group: FileGroup;
  /** Por que este arquivo some (ou fica). Vai inteiro para a tela. */
  readonly reason: string;
}

/** A pasta do save inteira, classificada e somada. */
export interface SaveFolderSummary {
  readonly path: string;
  /** `false` quando ela não existe — servidor que nunca subiu. */
  readonly exists: boolean;
  readonly files: readonly ClassifiedFile[];
  readonly deletedCount: number;
  readonly deletedBytes: number;
  readonly keptCount: number;
  readonly keptBytes: number;
}

/**
 * Onde ficam os saves de uma identity.
 *
 * `Servers\server01\server\server01\` — o `server` do meio é do
 * jogo, e não um engano de digitação. O último segmento é a
 * `SERVER_IDENTITY`, que por padrão é o id do servidor mas NÃO
 * precisa ser: montar o caminho com o id quando os dois divergem
 * classificaria uma pasta vazia e o wipe não apagaria nada,
 * relatando sucesso.
 */
export function saveFolderPath(installDir: string, identity: string): string {
  return join(installDir, 'server', identity);
}

interface Rule {
  readonly group: FileGroup;
  readonly test: (name: string) => boolean;
  /** `true` se o arquivo some naquele wipe. */
  readonly deletedBy: (bpPolicy: BpPolicy) => boolean;
  readonly reason: (bpPolicy: BpPolicy) => string;
}

const lower = (name: string): string => name.toLowerCase();

/**
 * As regras, NA ORDEM EM QUE SÃO TESTADAS.
 *
 * A ordem é a regra: `player.blueprints.16.db` casaria com o
 * `player.` genérico se ele viesse antes, e um wipe com política
 * `wipe` deixaria os blueprints de pé — do jeito mais silencioso
 * possível, porque a tela mostraria "mantidos" e ninguém acharia
 * estranho.
 */
const RULES: readonly Rule[] = [
  {
    // `.map`, `.sav`, `.sav.1`, `.sav.2`… Ver o cabeçalho: é a
    // extensão, e não o nome, que identifica um save de mundo.
    group: 'world',
    test: (name) => /\.map$/i.test(name) || /\.sav(\.\d+)?$/i.test(name),
    deletedBy: () => true,
    reason: () => 'O mundo: o terreno e tudo o que foi construído nele.',
  },
  {
    // ####  ACHADO NA PASTA DE VERDADE  ####
    //
    // `proceduralmap.4000.12345.287_occlusion_3.dat`, 12 MB de
    // dados de oclusão que o jogo DERIVA do mapa. Nenhum guia da
    // internet o menciona, e ele não casa com padrão de save
    // conhecido nenhum.
    //
    // Ele pertence ao mundo que está sendo apagado: mantido, fica
    // órfão ocupando disco, com o nome de um mapa que não existe
    // mais.
    group: 'world',
    test: (name) => /_occlusion(_\d+)?\.dat$/i.test(name),
    deletedBy: () => true,
    reason: () =>
      'Dados de oclusão derivados do mapa antigo. Sem o mapa, eles não servem para nada.',
  },
  {
    group: 'uploads',
    test: (name) => lower(name).startsWith('sv.files.'),
    deletedBy: () => true,
    reason: () =>
      'Imagens enviadas pelos jogadores (placas, quadros). Elas pertencem ao mundo antigo.',
  },
  {
    group: 'deaths',
    test: (name) => lower(name).startsWith('player.deaths.'),
    deletedBy: () => true,
    reason: () => 'A tela de morte: quem matou quem, com quê. É do mundo que acabou.',
  },
  {
    group: 'blueprints',
    test: (name) => lower(name).startsWith('player.blueprints.'),
    deletedBy: (bpPolicy) => bpPolicy !== 'keep',
    reason: (bpPolicy) =>
      bpPolicy === 'keep'
        ? 'Fica: este wipe mantém os blueprints, e todo mundo continua sabendo o que pesquisou.'
        : bpPolicy === 'wipe_except_vip'
          ? 'Some do arquivo, que é de todos os jogadores de uma vez. Quem tem direito recebe de ' +
            'volta pelo snapshot, depois — não há como recortar este arquivo por jogador.'
          : 'Todo mundo volta a não saber nada — scrap, bancada e research de novo.',
  },
  {
    // `player.identities.*.db` (SteamID <-> nome),
    // `player.states.*.db` (estado entre sessões) e
    // `player.tokens.db` (sem número — ver o cabeçalho).
    group: 'players',
    test: (name) => lower(name).startsWith('player.'),
    deletedBy: () => false,
    reason: () =>
      'Fica: é a identidade do jogador (SteamID, nome, estado entre sessões), e não algo que o ' +
      'mundo novo precise zerar. O full wipe pode levá-lo, item a item, na lista de dados de ' +
      'plugin.',
  },
  {
    // Times e reconhecimento entre jogadores — do JOGO, não de
    // plugin, apesar de `clans` parecer nome de plugin.
    group: 'players',
    test: (name) => /^(clans|relationship)\./i.test(name),
    deletedBy: () => false,
    reason: () =>
      'Fica: times e reconhecimento entre jogadores. O jogo não os zera junto com o mapa, e ' +
      'desfazer os times de todo mundo é decisão de servidor — não efeito colateral de trocar o ' +
      'mapa. O full wipe pode levá-lo, se marcado.',
  },
];

const OTHER: Rule = {
  group: 'other',
  test: () => true,
  deletedBy: () => false,
  reason: () => 'Fica: o agente não reconhece este arquivo, e não mexe no que não conhece.',
};

/**
 * Os satélites do SQLite: `-wal`, `-shm`, `-journal`.
 *
 * ####  ACHADO NA PASTA DE VERDADE, E ERA UM DEFEITO  ####
 *
 * A pasta tem `player.blueprints.16.db` E
 * `player.blueprints.16.db-wal`. Sem esta regra, um BP wipe
 * apagaria só o primeiro — e o segundo, sozinho, é um write-ahead
 * log órfão com escritas que o SQLite ainda não aplicou.
 *
 * Um WAL órfão ao lado de um banco recriado dá dois desfechos, os
 * dois ruins: o jogo recusa abrir o arquivo, ou aplica escritas de
 * um mundo que deixou de existir. Nenhum guia de wipe menciona
 * isso porque, em servidor encerrado de forma limpa, o WAL some
 * sozinho no checkpoint — ele só sobra quando o processo é morto à
 * força, que é justamente o caminho de "o servidor travou, force o
 * wipe".
 *
 * A regra, então: o satélite tem o MESMO destino do arquivo dele.
 * Herdado, e nunca decidido de novo — se um dia a regra do pai
 * mudar, esta acompanha sem ninguém precisar lembrar.
 */
const SIDECAR = /-(wal|shm|journal)$/i;

/** Classifica UM nome. Puro: não toca em disco e não decide sozinho. */
export function classifyFile(name: string, bpPolicy: BpPolicy, bytes = 0): ClassifiedFile {
  const sidecar = SIDECAR.exec(name);

  if (sidecar !== null) {
    const base = name.slice(0, sidecar.index);
    const parent = classifyFile(base, bpPolicy);

    return {
      name,
      bytes,
      fate: parent.fate,
      group: parent.group,
      reason:
        parent.fate === 'delete'
          ? `Some junto com ${base}: é o write-ahead log dele, e sozinho ressuscitaria parte do ` +
            'que foi apagado.'
          : `Fica junto com ${base}: é o write-ahead log dele.`,
    };
  }

  const rule = RULES.find((entry) => entry.test(name)) ?? OTHER;

  return {
    name,
    bytes,
    fate: rule.deletedBy(bpPolicy) ? 'delete' : 'keep',
    group: rule.group,
    reason: rule.reason(bpPolicy),
  };
}

/**
 * Lê a pasta do save e classifica o que há nela.
 *
 * ####  SÓ O NÍVEL DE CIMA  ####
 *
 * Sem recursão, de propósito. A pasta da identity tem subpastas
 * (`cfg\`, com o server.cfg e as listas de admin; `command_history\`;
 * `serveremoji\`) que não fazem parte de wipe nenhum — descer nelas
 * seria oferecer ao operador a chance de apagar a própria
 * configuração do servidor junto com o mundo.
 *
 * Pasta inexistente devolve `exists: false` em vez de lançar: é o
 * estado normal de quem ainda não subiu o servidor pela primeira
 * vez, e o passo `apagar` trata isso como sucesso.
 */
export async function classifySaveFolder(
  path: string,
  bpPolicy: BpPolicy,
): Promise<SaveFolderSummary> {
  let names: string[];

  try {
    const found = await readdir(path, { withFileTypes: true });

    names = found.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return {
      path,
      exists: false,
      files: [],
      deletedCount: 0,
      deletedBytes: 0,
      keptCount: 0,
      keptBytes: 0,
    };
  }

  const files: ClassifiedFile[] = [];

  for (const name of names) {
    let bytes = 0;

    try {
      bytes = (await stat(join(path, name))).size;
    } catch {
      // O arquivo sumiu entre o readdir e o stat — o servidor
      // rotaciona saves enquanto roda. Tamanho zero é melhor que
      // derrubar a prévia inteira por causa de um arquivo.
      bytes = 0;
    }

    files.push(classifyFile(name, bpPolicy, bytes));
  }

  // O que some primeiro e, dentro disso, o maior primeiro: é a
  // ordem em que alguém confere uma lista antes de autorizar um
  // apagamento.
  files.sort((a, b) => {
    if (a.fate !== b.fate) {
      return a.fate === 'delete' ? -1 : 1;
    }

    return b.bytes - a.bytes;
  });

  const deleted = files.filter((file) => file.fate === 'delete');
  const kept = files.filter((file) => file.fate === 'keep');

  return {
    path,
    exists: true,
    files,
    deletedCount: deleted.length,
    deletedBytes: deleted.reduce((total, file) => total + file.bytes, 0),
    keptCount: kept.length,
    keptBytes: kept.reduce((total, file) => total + file.bytes, 0),
  };
}
