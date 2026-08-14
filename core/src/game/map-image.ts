// ============================================================
//  map-image.ts  -  a imagem do mapa, gerada pelo próprio jogo.
//
//  ####  ELA NÃO VEM DE FORA  ####
//
//  O caminho óbvio para um mapa de fundo seria o RustMaps: chave de
//  API, upload da seed, espera, e uma dependência externa no meio
//  de uma tela que precisa funcionar num dedicado sem internet
//  liberada.
//
//  O servidor sabe fazer isso sozinho. `world.rendermap` é um
//  comando do próprio Rust que renderiza um PNG de alta resolução
//  do mundo carregado e o grava ao lado da instalação:
//
//      Servers\<id>\map_<worldSize>_<seed>.png
//
//  Nome DERIVADO do mundo, e isso resolve o problema seguinte de
//  graça: no wipe a seed muda, o nome muda, e a imagem velha
//  simplesmente deixa de ser encontrada. Não existe cache para
//  invalidar nem imagem de outro mapa aparecendo por engano.
//
//  ------------------------------------------------------------
//  ####  UMA VEZ POR MUNDO, E O MUNDO DURA UM WIPE  ####
//
//  MEDIDO neste servidor: ~17,5 MB de PNG, e o comando passa dos
//  cinco segundos do timeout de RCON — o servidor engasga enquanto
//  desenha. Fazer isso a cada abertura de tela seria um engasgo por
//  visita; deixar no botão seria uma tarefa manual repetida a cada
//  wipe, e portanto esquecida.
//
//  O render acontece QUANDO O RCON CONECTA e não há imagem para
//  aquele mundo. Isso dá, de graça, exatamente o ciclo certo:
//
//    - primeira subida do mapa novo -> desenha (e é o melhor
//      momento possível: o servidor acabou de subir e ainda não há
//      ninguém dentro para sentir o engasgo);
//    - toda subida seguinte        -> o arquivo existe, não faz
//                                     nada;
//    - wipe                        -> a seed muda, o NOME muda, o
//                                     arquivo não existe, e o
//                                     desenho refaz sozinho.
//
//  Não há cache para invalidar nem imagem de outro mapa aparecendo
//  por engano: quem responde "esta imagem é deste mundo?" é o nome
//  do arquivo.
//
//  ####  E O COMANDO NÃO ESPERA RESPOSTA  ####
//
//  `sendWithoutReply`: o `world.rendermap` demora mais que o
//  timeout, e esperar por ele transformaria um render que ACONTECEU
//  num erro registrado. Ver o cabeçalho de rcon/client.ts.
// ============================================================

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../logger.js';
import type { OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';

export interface MapImage {
  /** O arquivo existe em disco? */
  readonly available: boolean;
  /** Caminho absoluto. Vai para a tela porque explica o resto. */
  readonly path: string;
  readonly bytes: number | null;
  /** ISO. Quando o jogo desenhou esta imagem. */
  readonly generatedAt: string | null;
  readonly worldSize: number;
  readonly seed: number;
  /** O lado do PNG, em pixels. `null` sem imagem. */
  readonly pixels: number | null;
  /**
   * Quantas UNIDADES DO MUNDO a imagem cobre, de ponta a ponta.
   *
   * ####  ELA É MAIOR QUE O MUNDO, E ISSO QUEBRA TUDO SE FOR
   *       IGNORADO  ####
   *
   * MEDIDO: um mundo de 4000 rende um PNG de 5000×5000. O jogo
   * desenha o `worldsize` MAIS uma faixa de oceano em volta — e o
   * desenho sai a 1 pixel por unidade.
   *
   * Projetar sobre `worldSize` em vez daqui empurra todo mundo para
   * fora por 25%: um jogador na costa norte aparece no meio do
   * oceano, e a tela fica dizendo que ele está na água. Foi
   * exatamente o que aconteceu.
   *
   * O número é LIDO do cabeçalho do PNG, e não uma constante: se um
   * update mudar a margem, o agente acompanha sem ninguém precisar
   * descobrir por que os pontos saíram do lugar.
   */
  readonly coverage: number | null;
}

/**
 * `Servers\<id>\map_<worldSize>_<seed>.png`.
 *
 * O nome é o do próprio jogo — não é uma convenção nossa. Mudá-lo
 * aqui faria o agente procurar um arquivo que o Rust nunca escreve.
 */
export function mapImagePath(installDir: string, worldSize: number, seed: number): string {
  return join(installDir, `map_${String(worldSize)}_${String(seed)}.png`);
}

/**
 * O que existe em disco para aquele mundo.
 *
 * Arquivo ausente NÃO é erro: é o estado de um servidor onde
 * ninguém pediu o render ainda, e a tela oferece o botão. Um 500
 * aqui assustaria por causa de um arquivo que é opcional.
 */
export async function readMapImage(
  installDir: string,
  worldSize: number,
  seed: number,
): Promise<MapImage> {
  const path = mapImagePath(installDir, worldSize, seed);

  try {
    const info = await stat(path);
    const pixels = await readPngWidth(path);

    return {
      available: true,
      path,
      bytes: info.size,
      generatedAt: new Date(info.mtimeMs).toISOString(),
      worldSize,
      seed,
      pixels,
      // 1 pixel por unidade do mundo — ver o comentário do campo.
      // Sem conseguir ler o cabeçalho, `null`: a tela então NÃO
      // desenha os pontos sobre a imagem, em vez de desenhá-los no
      // lugar errado.
      coverage: pixels,
    };
  } catch {
    return {
      available: false,
      path,
      bytes: null,
      generatedAt: null,
      worldSize,
      seed,
      pixels: null,
      coverage: null,
    };
  }
}

/**
 * O lado do PNG, lido do cabeçalho.
 *
 * ####  24 BYTES, E NÃO A IMAGEM INTEIRA  ####
 *
 * O arquivo tem ~17 MB e a resposta está nos primeiros bytes: todo
 * PNG começa com a assinatura de 8 bytes e um chunk `IHDR` cujos
 * dois primeiros campos são largura e altura, em big-endian. Ler o
 * arquivo todo para descobrir isso seria 17 MB de I/O por abertura
 * de tela.
 *
 * `null` quando o arquivo não é um PNG que reconhecemos — e aí quem
 * chamou trata como "não sei a escala", que é diferente de supor
 * uma.
 */
async function readPngWidth(path: string): Promise<number | null> {
  const handle = await open(path, 'r');

  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);

    if (bytesRead < 24 || header.toString('binary', 1, 4) !== 'PNG') {
      return null;
    }

    const width = header.readUInt32BE(16);

    return width > 0 ? width : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Manda o jogo desenhar o mapa.
 *
 * Devolve assim que o comando SAI, e não quando o desenho termina —
 * ver o cabeçalho. Quem chamou descobre que terminou pelo arquivo
 * aparecendo em disco, que é a única prova que interessa.
 */
export async function renderMapImage(rcon: OpsRcon): Promise<void> {
  const withoutReply = (rcon as { sendWithoutReply?: (command: string) => Promise<void> })
    .sendWithoutReply;

  if (typeof withoutReply === 'function') {
    await withoutReply.call(rcon, 'world.rendermap');
    return;
  }

  await rcon.send('world.rendermap');
}

/**
 * O que o guardião precisa saber dos servidores.
 *
 * Interface mínima, pelo mesmo motivo do `BanServers`: o
 * `ServerSupervisor` a satisfaz por estrutura, e um teste a
 * satisfaz com duas funções.
 */
export interface MapImageServers {
  configOf(id: string): {
    readonly worldSize: number;
    readonly seed: number;
    readonly paths: { readonly installDir: string };
  } | null;
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

/**
 * Garante que existe uma imagem para o mundo que está no ar.
 *
 * Pendurado no mesmo gancho da reconciliação de banimentos: o RCON
 * conectar é o instante em que o agente volta a alcançar o
 * servidor, e é quando dá para saber qual mundo está carregado.
 */
export class MapImageKeeper {
  readonly #servers: MapImageServers;
  readonly #logger: Logger;
  /**
   * Quem já está desenhando.
   *
   * O render leva dezenas de segundos, e nesse meio-tempo o arquivo
   * AINDA NÃO existe: sem esta trava, uma reconexão de RCON durante
   * o desenho pediria um segundo render por cima do primeiro.
   */
  readonly #rendering = new Set<string>();

  constructor(deps: { servers: MapImageServers; logger: Logger }) {
    this.#servers = deps.servers;
    this.#logger = deps.logger;
  }

  /**
   * Desenha se faltar. Nunca lança: é conveniência, e uma falha
   * aqui não pode atrapalhar quem subiu o servidor.
   */
  async ensure(serverId: string): Promise<void> {
    if (this.#rendering.has(serverId)) {
      return;
    }

    const config = this.#servers.configOf(serverId);
    const rcon = this.#servers.contextOf(serverId)?.rcon;

    if (config === null || rcon === undefined || !rcon.isConnected) {
      return;
    }

    try {
      const image = await readMapImage(config.paths.installDir, config.worldSize, config.seed);

      if (image.available) {
        return;
      }

      this.#rendering.add(serverId);

      this.#logger.info(
        { server: serverId, world: config.worldSize, seed: config.seed, path: image.path },
        'não há imagem deste mundo ainda — pedindo o render ao jogo (uma vez por wipe)',
      );

      await renderMapImage(rcon);
    } catch (error) {
      this.#logger.warn(
        { server: serverId, err: toError(error) },
        'não consegui pedir o render do mapa; a aba de administração oferece o botão',
      );
    } finally {
      // Liberada na saída, e não quando o arquivo aparece: o
      // comando já saiu, e uma nova tentativa só faria sentido
      // depois de alguém reconectar de novo — quando a leitura do
      // disco decide sozinha.
      this.#rendering.delete(serverId);
    }
  }
}
