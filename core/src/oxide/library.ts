// ============================================================
//  library.ts  -  os plugins que o agente guarda, e o que cada
//  servidor liga.
//
//  ####  TRÊS LUGARES, E ELES NÃO SE CONFUNDEM  ####
//
//      Plugins\                       a BIBLIOTECA. Um .cs, uma
//                                     vez, para todos os servidores.
//
//      Plugins\<id>\                  o CUSTOM daquele servidor: o
//                                     evento do fim de semana, o
//                                     teste que não vai para os
//                                     outros.
//
//      Servers\<id>\oxide\plugins\    o que está VALENDO ali agora.
//                                     Cópia derivada de um dos dois
//                                     de cima.
//
//  Os dois primeiros são acervo; o terceiro é execução. Antes disto
//  só existia o terceiro: cada servidor era uma cópia solta dos
//  mesmos arquivos, e subir a versão nova em cinco servidores era o
//  mesmo upload cinco vezes.
//
//  ------------------------------------------------------------
//  ####  DESLIGAR NÃO PODE CUSTAR A CONFIGURAÇÃO  ####
//
//  `oxide\config\<Nome>.json` e `oxide\data\` NÃO são tocados em
//  lugar nenhum deste arquivo. Desligar um plugin para testar
//  alguma coisa e voltar atrás precisa ser barato; se custasse a
//  configuração dele — horas de ajuste fino, em alguns casos —
//  ninguém desligaria nada, e o interruptor viraria enfeite.
//
//  ------------------------------------------------------------
//  ####  ADOTAR, NUNCA APAGAR  ####
//
//  Um servidor que já tinha `.cs` na pasta quando o agente chegou
//  não é um servidor "sujo": aquilo foi decisão de alguém, e o
//  agente é que acabou de aparecer. O que estava lá vira CUSTOM
//  daquele servidor e nasce ligado. Nada é removido por não ser
//  reconhecido.
// ============================================================

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginRecord, PluginsRepository } from '../db/plugins-repository.js';
import { ApiError } from '../http/error-response.js';
import type { Logger } from '../logger.js';
import { disconnectedRcon, type OpsRcon } from '../ops/service.js';
import { toError } from '../util.js';
import {
  assertValidJson,
  backupPluginConfig,
  listPluginConfigs,
  MAX_CONFIG_BYTES,
  readPluginConfig,
  removePluginConfig,
  writePluginConfig,
  type PluginConfigContent,
  type PluginConfigInfo,
} from './plugin-config.js';
import { readPluginMetadata, sha256Of } from './plugin-metadata.js';
import {
  assertPluginContent,
  listPlugins,
  pluginPath,
  PLUGIN_NAME_PATTERN,
  reloadPlugin,
  removePlugin,
  type PluginReloadResult,
} from './plugins.js';

/**
 * O que a biblioteca precisa saber sobre os servidores.
 *
 * Interface mínima pelo mesmo motivo do `OpsRcon`: o
 * `ServerSupervisor` a satisfaz por estrutura, e um teste satisfaz
 * com três funções e uma pasta temporária — sem `.ini`, sem
 * processo, sem socket. A alternativa seria montar meio agente para
 * conferir que desligar um plugin preserva o `oxide\config`.
 */
export interface PluginServers {
  /** Os ids que este agente conhece. */
  ids(): readonly string[];
  /** `null` = não existe servidor com este id. */
  configOf(id: string): {
    readonly paths: {
      readonly pluginsDir: string;
      /** `Servers\<id>\oxide\config` — o `.json` de cada plugin. */
      readonly oxideConfigDir: string;
      /** `Backups\<id>\` — a cópia antes de mexer na config. */
      readonly backupsDir: string;
    };
  } | null;
  /** `null` = existe, mas está desligado — sem RCON. */
  contextOf(id: string): { readonly rcon: OpsRcon } | null;
}

export interface PluginLibraryDeps {
  /** `Plugins\` — ver `AgentPaths.pluginLibraryDir`. */
  readonly libraryDir: string;
  readonly repository: PluginsRepository;
  readonly servers: PluginServers;
  readonly logger: Logger;
}

/** Um plugin do acervo, como as telas o mostram. */
export interface PluginView {
  /** A chave: o nome NÃO é único entre biblioteca e customs. */
  readonly id: number;
  readonly name: string;
  readonly file: string;
  /** `null` = da biblioteca; um id = custom DAQUELE servidor. */
  readonly serverId: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly bytes: number;
  readonly sha256: string;
  /** `// Requires: X` — de quem ele não carrega sem. */
  readonly requires: readonly string[];
  /** `[PluginReference]` — de quem ele usa, mas sobrevive sem. */
  readonly references: readonly string[];
  /** ISO na borda HTTP; o banco guarda epoch ms. */
  readonly addedAt: string;
  readonly updatedAt: string;
  /** Os ids dos servidores em que ele está ATIVO agora. */
  readonly servers: readonly string[];
}

/** O mesmo plugin, visto de dentro de UM servidor. */
export interface ServerPluginView extends PluginView {
  readonly enabled: boolean;
  /** O sha256 do que está em disco naquele servidor. */
  readonly appliedSha: string | null;
  readonly appliedAt: string | null;
  /**
   * Ligado, mas com um arquivo diferente do do acervo.
   *
   * É o "há versão nova para aplicar" da tela. Desligado nunca é
   * `true`: não há o que atualizar onde não há arquivo.
   */
  readonly updateAvailable: boolean;
  /**
   * Um HOMÔNIMO já ocupa o lugar deste plugin naquele servidor.
   *
   * A biblioteca pode ter um `Kits` e o servidor um `Kits` custom.
   * Os dois gravariam `Kits.cs` no mesmo caminho, e o Oxide carrega
   * um só — então ligar o segundo é recusado, e a tela mostra aqui
   * de onde vem o que está no caminho. `null` = livre.
   */
  readonly blockedBy: 'biblioteca' | 'custom' | null;
  /**
   * Dependências DURAS que não estão ligadas neste servidor.
   *
   * Ligar assim mesmo é permitido — o Oxide segura o plugin e o
   * carrega quando a dependência aparecer. O que não pode é a tela
   * ficar calada: "liguei e não funcionou" é o pior desfecho, e a
   * causa nunca é óbvia.
   */
  readonly missingRequires: readonly string[];
  /**
   * Quem, LIGADO aqui, depende deste plugin.
   *
   * `hard` sai do ar junto se este for tirado; `soft` continua no ar
   * com a parte que dependia dele morta. É o aviso que a tela mostra
   * antes de desligar.
   */
  readonly dependents: {
    readonly hard: readonly string[];
    readonly soft: readonly string[];
  };
}

export interface AddPluginResult {
  readonly plugin: PluginView;
  /**
   * Os servidores em que a versão nova AINDA NÃO foi aplicada.
   *
   * O upload não aplica sozinho, de propósito: cinco servidores no
   * ar recarregando um plugin porque alguém arrastou um arquivo é o
   * tipo de efeito que ninguém pede e todo mundo leva um susto — e
   * um plugin que não compila derrubaria os cinco de uma vez, em
   * vez de um só, com alguém olhando.
   */
  readonly pendingServers: readonly string[];
}

export interface ToggleResult {
  readonly plugin: ServerPluginView;
  readonly reload: PluginReloadResult;
}

/** Uma config da pasta, com o que o acervo sabe daquele nome. */
export interface PluginConfigView extends PluginConfigInfo {
  /** O `[Info]` do `.cs`, quando o plugin está no acervo. */
  readonly title: string | null;
  /**
   * O plugin existe no acervo deste servidor?
   *
   * `false` é a config ÓRFÃ: o `.json` do plugin que saiu, ou de um
   * que nunca passou pelo agente. Ela continua na lista de
   * propósito — ver `configList`.
   */
  readonly inStore: boolean;
  /** Ele está LIGADO aqui? Só então gravar recarrega algo. */
  readonly enabled: boolean;
}

export interface PluginConfigWriteResult {
  /**
   * Como o arquivo ficou DEPOIS do reload.
   *
   * `null` = não existe: no `configReset` de um plugin desligado, o
   * arquivo só volta quando alguém o ligar.
   */
  readonly config: PluginConfigContent | null;
  /** Onde foi parar a versão anterior. `null` = não havia arquivo. */
  readonly backup: string | null;
  readonly reload: PluginReloadResult;
}

/** Epoch ms -> ISO, com o `null` sobrevivendo. */
function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Quem, entre os plugins ligados, depende de `name`.
 *
 * ####  DURO E MOLE NÃO SÃO A MESMA NOTÍCIA  ####
 *
 * `hard` (`// Requires:`) sai do ar junto: o Oxide descarrega quem
 * perdeu a dependência. `soft` (`[PluginReference]`) continua no ar
 * com a parte que usava o outro morta — o que é pior de descobrir,
 * porque nada aparece no log e o servidor parece bem.
 *
 * Separar os dois é o que permite a tela dizer "derruba estes" e
 * "afeta aqueles" em vez de uma lista só, onde a consequência de
 * cada nome seria adivinhação.
 */
function dependentsOf(
  name: string,
  online: readonly PluginRecord[],
): { hard: readonly string[]; soft: readonly string[] } {
  const hard: string[] = [];
  const soft: string[] = [];

  for (const other of online) {
    if (other.name === name) {
      continue;
    }

    if (other.requires?.includes(name) === true) {
      hard.push(other.name);
    } else if (other.references?.includes(name) === true) {
      soft.push(other.name);
    }
  }

  return { hard, soft };
}

export class PluginLibrary {
  readonly #deps: PluginLibraryDeps;

  constructor(deps: PluginLibraryDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------
  //  Leitura
  // ------------------------------------------------------

  /**
   * Só a BIBLIOTECA. É o que a tela de rede mostra.
   *
   * Os customs ficam de fora de propósito: o experimento de um
   * servidor não é acervo da rede, e listá-lo aqui encheria a tela
   * de coisas que mais ninguém pode usar.
   *
   * Reconcilia a pasta antes de listar. Ver `syncStore`.
   */
  async list(): Promise<readonly PluginView[]> {
    await this.#syncDir(null);

    const active = this.#deps.repository.activeServersByPlugin();

    return this.#deps.repository
      .library()
      .map((plugin) => this.#toView(plugin, active.get(plugin.id) ?? []));
  }

  /**
   * O acervo daquele servidor: a biblioteca MAIS os customs dele,
   * cada um com o estado ali.
   *
   * A lista inclui o que ele NÃO usa — senão não haveria como ligar
   * nada. Quem separa "disponíveis" de "ativos" é a tela, pelo
   * `enabled`.
   *
   * Adota antes de listar. Ver `adopt`.
   */
  async serverList(
    serverId: string,
  ): Promise<{ readonly pluginsDir: string; readonly plugins: readonly ServerPluginView[] }> {
    const pluginsDir = this.#pluginsDirOf(serverId);

    // As duas pastas que alimentam esta tela: a biblioteca e os
    // customs deste servidor. Ver `syncStore`.
    await this.#syncDir(null);
    await this.#syncDir(serverId);
    await this.adopt(serverId);

    const active = this.#deps.repository.activeServersByPlugin();
    const state = new Map(
      this.#deps.repository.serverPlugins(serverId).map((row) => [row.pluginId, row]),
    );

    const available = this.#deps.repository.availableFor(serverId);

    // Quem já ocupa cada NOME naquele servidor. É o que responde o
    // `blockedBy` sem uma consulta por linha listada.
    const holderOf = new Map<string, PluginRecord>();

    for (const plugin of available) {
      if (state.get(plugin.id)?.enabled === true) {
        holderOf.set(plugin.name, plugin);
      }
    }

    // Os nomes LIGADOS aqui. É contra este conjunto que se
    // responde "falta alguma dependência?" e "quem cai se eu tirar
    // este?".
    const onlineNames = new Set([...holderOf.keys()]);

    const plugins = available.map((plugin): ServerPluginView => {
      const row = state.get(plugin.id);
      const enabled = row?.enabled === true;
      const holder = holderOf.get(plugin.name);

      return {
        ...this.#toView(plugin, active.get(plugin.id) ?? []),
        enabled,
        appliedSha: row?.appliedSha ?? null,
        appliedAt: toIso(row?.appliedAt ?? null),
        // Desligado nunca tem atualização pendente: não há arquivo
        // naquele servidor para estar velho.
        updateAvailable: enabled && row?.appliedSha !== plugin.sha256,
        blockedBy:
          holder === undefined || holder.id === plugin.id
            ? null
            : holder.serverId === null
              ? 'biblioteca'
              : 'custom',
        missingRequires: (plugin.requires ?? []).filter((name) => !onlineNames.has(name)),
        dependents: dependentsOf(plugin.name, [...holderOf.values()]),
      };
    });

    return { pluginsDir, plugins };
  }

  // ------------------------------------------------------
  //  Acervo: enviar e remover
  // ------------------------------------------------------

  /**
   * Põe (ou substitui) um `.cs` na BIBLIOTECA — para todos.
   *
   * Os metadados saem do PRÓPRIO arquivo — ver plugin-metadata.ts.
   * Não há formulário: um segundo lugar para dizer a versão é o
   * lugar que um dia contradiz o arquivo.
   */
  add(fileName: string, content: Buffer): Promise<AddPluginResult> {
    return this.#store(null, fileName, content);
  }

  /**
   * Põe (ou substitui) um `.cs` CUSTOM daquele servidor.
   *
   * Mesmo caminho do anterior, com dono. O arquivo vai para
   * `Plugins\<id>\`, e nenhum outro servidor o enxerga: é o `.cs`
   * que só faz sentido ali, e mandá-lo para a biblioteca de todos
   * seria poluir a tela de rede com o experimento de um.
   */
  addCustom(serverId: string, fileName: string, content: Buffer): Promise<AddPluginResult> {
    // Confere que o servidor existe ANTES de gravar: a chave
    // estrangeira recusaria depois, com o arquivo já em disco.
    this.#pluginsDirOf(serverId);

    return this.#store(serverId, fileName, content);
  }

  async #store(
    serverId: string | null,
    fileName: string,
    content: Buffer,
  ): Promise<AddPluginResult> {
    const dir = this.#dirOf(serverId);
    // A ordem importa: o caminho é conferido ANTES de qualquer
    // escrita, e é ele quem recusa `..\..\Managed\Oxide.Core.cs`.
    const target = pluginPath(dir, fileName);

    assertPluginContent(content);

    const name = fileName.slice(0, -3);
    const metadata = readPluginMetadata(content);
    const sha256 = sha256Of(content);

    await mkdir(dir, { recursive: true });

    try {
      await writeFile(target, content);
    } catch (error) {
      throw new ApiError(
        'PLUGIN_WRITE_FAILED',
        `Não consegui gravar ${target}: ${toError(error).message}.`,
        500,
      );
    }

    const plugin = this.#deps.repository.upsert({
      name,
      file: fileName,
      serverId,
      title: metadata.title,
      author: metadata.author,
      version: metadata.version,
      description: metadata.description,
      bytes: content.length,
      sha256,
      requires: metadata.requires,
      references: metadata.references,
    });

    // Quem já usa este plugin e ficou para trás. Ver o comentário
    // em `AddPluginResult.pendingServers`.
    const servers = this.#deps.repository.activeServersOf(plugin.id);
    const pendingServers = servers.filter(
      (id) => this.#deps.repository.serverPlugin(id, plugin.id)?.appliedSha !== sha256,
    );

    this.#deps.logger.info(
      { plugin: name, custom: serverId, version: plugin.version, pending: pendingServers.length },
      'plugin gravado no acervo',
    );

    return { plugin: this.#toView(plugin, servers), pendingServers };
  }

  /**
   * Tira o plugin do acervo E de todos os servidores.
   *
   * Sem `force`, com servidores usando, é 409 dizendo QUAIS — a
   * confirmação da tela precisa do nome deles, não da contagem.
   */
  async remove(
    pluginId: number,
    force: boolean,
  ): Promise<{ readonly name: string; readonly removedFrom: readonly string[] }> {
    const plugin = this.#requirePlugin(pluginId);
    const servers = this.#deps.repository.activeServersOf(pluginId);

    if (servers.length > 0 && !force) {
      throw new ApiError(
        'PLUGIN_IN_USE',
        `O plugin "${plugin.name}" está ativo em ${servers.join(', ')}. Removê-lo o descarrega ` +
          'e apaga o .cs desses servidores — a configuração em oxide\\config é preservada. ' +
          'Confirme para continuar.',
        409,
      );
    }

    for (const serverId of servers) {
      try {
        await this.#unloadFrom(serverId, plugin);
      } catch (error) {
        // Um servidor que não deu para limpar NÃO segura a remoção
        // dos outros: o `.cs` continua lá, e a próxima adoção o traz
        // de volta como custom. Sumir em silêncio é que não pode.
        this.#deps.logger.warn(
          { server: serverId, plugin: plugin.name, err: toError(error) },
          'não consegui apagar o .cs deste servidor ao remover o plugin do acervo',
        );
      }
    }

    this.#deps.repository.remove(pluginId);

    try {
      await rm(pluginPath(this.#dirOf(plugin.serverId), plugin.file), { force: true });
    } catch (error) {
      throw new ApiError(
        'PLUGIN_REMOVE_FAILED',
        'A linha saiu do banco, mas não consegui apagar o arquivo do acervo: ' +
          `${toError(error).message}. Apague-o à mão — do jeito que está, a próxima adoção o ` +
          'traria de volta.',
        500,
      );
    }

    this.#deps.logger.info({ plugin: plugin.name, servers }, 'plugin removido do acervo');

    return { name: plugin.name, removedFrom: servers };
  }

  // ------------------------------------------------------
  //  Num servidor: ligar, desligar, aplicar
  // ------------------------------------------------------

  /**
   * Liga ou desliga o plugin naquele servidor.
   *
   * Ligar o que JÁ ESTÁ ligado é o caminho de "aplicar a
   * atualização": recopia o arquivo do acervo e recarrega. É de
   * propósito que seja o mesmo caminho — dois códigos para
   * copiar-e-recarregar divergiriam no primeiro ajuste.
   */
  async setEnabled(
    serverId: string,
    pluginId: number,
    enabled: boolean,
    force = false,
  ): Promise<ToggleResult> {
    const plugin = this.#requirePlugin(pluginId);

    if (plugin.serverId !== null && plugin.serverId !== serverId) {
      throw new ApiError(
        'PLUGIN_NOT_AVAILABLE',
        `O plugin "${plugin.name}" é custom do servidor "${plugin.serverId}" e não existe em ` +
          `"${serverId}". Envie o .cs neste servidor, ou publique-o na biblioteca para todos.`,
        403,
      );
    }

    if (!enabled && !force) {
      this.#assertNothingDependsOn(serverId, plugin);
    }

    const reload = enabled
      ? await this.#applyTo(serverId, plugin)
      : await this.#unloadFrom(serverId, plugin);

    return { plugin: await this.#serverViewOf(serverId, pluginId), reload };
  }

  /**
   * Tirar este plugin derruba outros?
   *
   * ####  O ESTRAGO ACONTECE DEPOIS, E LONGE  ####
   *
   * `// Requires: OrigemZAgent` faz o Oxide descarregar quem ficou
   * sem a dependência. Quem tira o `OrigemZAgent` vê um "plugin
   * removido" e mais nada; os outros três somem do ar em silêncio, e
   * o sintoma aparece no jogo — kit que não vem, fila que não
   * ordena — sem nada ligando uma coisa à outra.
   *
   * Por isso a recusa é o padrão e a confirmação é explícita: o
   * `force` existe para quando a pessoa JÁ leu quem cai junto.
   *
   * @throws {ApiError} 409 com os nomes.
   */
  #assertNothingDependsOn(serverId: string, plugin: PluginRecord): void {
    const online = this.#deps.repository
      .serverPlugins(serverId)
      .filter((row) => row.enabled && row.pluginId !== plugin.id)
      .map((row) => this.#deps.repository.get(row.pluginId))
      .filter((other): other is PluginRecord => other !== null);

    const { hard, soft } = dependentsOf(plugin.name, online);

    if (hard.length === 0 && soft.length === 0) {
      return;
    }

    const partes = [
      hard.length === 0 ? null : `${hard.join(', ')} sai${hard.length > 1 ? 'em' : ''} do ar junto`,
      soft.length === 0
        ? null
        : `${soft.join(', ')} continua${soft.length > 1 ? 'm' : ''} no ar, mas perde${
            soft.length > 1 ? 'm' : ''
          } a parte que usa este`,
    ].filter((parte): parte is string => parte !== null);

    throw new ApiError(
      'PLUGIN_HAS_DEPENDENTS',
      `Tirar "${plugin.name}" mexe em outros plugins deste servidor: ${partes.join('; ')}. ` +
        'Confirme para continuar.',
      409,
    );
  }

  /**
   * Recarrega sem recopiar.
   *
   * Serve para o caso em que o arquivo está certo e o plugin é que
   * precisa reiniciar — depois de editar `oxide\config\<Nome>.json`
   * à mão, por exemplo. Copiar de novo aqui seria trabalho à toa.
   */
  reload(serverId: string, pluginId: number): Promise<PluginReloadResult> {
    const plugin = this.#requirePlugin(pluginId);

    return reloadPlugin(this.#rconOf(serverId), plugin.name);
  }

  // ------------------------------------------------------
  //  A configuração de cada plugin
  // ------------------------------------------------------

  /**
   * O que há em `oxide\config` daquele servidor.
   *
   * ####  QUEM MANDA NA LISTA É A PASTA, NÃO O ACERVO  ####
   *
   * A config sobrevive ao plugin: desligar não a apaga, remover do
   * acervo não a apaga. Listar a partir do acervo esconderia
   * justamente o arquivo que alguém foi procurar — o do plugin que
   * saiu semana passada e cuja configuração ele quer de volta.
   *
   * O acervo entra como ENFEITE de cada linha (`enabled`, `title`),
   * e não como filtro.
   */
  async configList(serverId: string): Promise<{
    readonly configDir: string;
    readonly configs: readonly PluginConfigView[];
  }> {
    const configDir = this.#pathsOf(serverId).oxideConfigDir;
    const known = new Map(
      this.#deps.repository.availableFor(serverId).map((plugin) => [plugin.name, plugin]),
    );
    const state = new Map(
      this.#deps.repository.serverPlugins(serverId).map((row) => [row.pluginId, row]),
    );

    const configs = (await listPluginConfigs(configDir)).map((config): PluginConfigView => {
      const plugin = known.get(config.plugin);

      return {
        ...config,
        title: plugin?.title ?? null,
        // Sem plugin no acervo: a config está órfã. A tela diz isso
        // em vez de escondê-la — ver o cabeçalho.
        inStore: plugin !== undefined,
        enabled: plugin !== undefined && state.get(plugin.id)?.enabled === true,
      };
    });

    return { configDir, configs };
  }

  /** O JSON de hoje, ou `null` se o plugin ainda não o criou. */
  configRead(serverId: string, plugin: string): Promise<PluginConfigContent | null> {
    return readPluginConfig(this.#pathsOf(serverId).oxideConfigDir, plugin);
  }

  /**
   * Grava a config e recarrega o plugin.
   *
   * ####  A ORDEM É TODA A SEGURANÇA DISTO  ####
   *
   *   1. conferir o JSON — o que não passa não chega ao disco, e o
   *      arquivo de ontem continua valendo;
   *   2. copiar o que estava lá para `Backups\<id>\oxide-config\`;
   *   3. gravar;
   *   4. recarregar, se o plugin estiver ligado aqui;
   *   5. RELER do disco.
   *
   * O passo 5 não é zelo: vários plugins chamam `SaveConfig()` ao
   * carregar e reescrevem o arquivo normalizando o que leram.
   * Devolver o texto que o operador enviou faria a tela afirmar uma
   * coisa que o arquivo não diz mais — e a divergência só apareceria
   * na próxima vez que alguém abrisse a tela.
   */
  async configWrite(
    serverId: string,
    plugin: string,
    text: string,
  ): Promise<PluginConfigWriteResult> {
    const { oxideConfigDir, backupsDir } = this.#pathsOf(serverId);

    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
      throw new ApiError(
        'PLUGIN_CONFIG_TOO_LARGE',
        `A configuração tem ${String(Math.round(Buffer.byteLength(text, 'utf8') / 1024))} KB e o ` +
          `limite é ${String(MAX_CONFIG_BYTES / 1024)} KB.`,
        400,
      );
    }

    assertValidJson(text);

    const backup = await backupPluginConfig(oxideConfigDir, backupsDir, plugin, Date.now());

    await writePluginConfig(oxideConfigDir, plugin, text);

    const reload = await this.#reloadIfEnabled(serverId, plugin);

    this.#deps.logger.info(
      { server: serverId, plugin, backup, reloaded: reload.sent },
      'configuração de plugin gravada',
    );

    return { config: await readPluginConfig(oxideConfigDir, plugin), backup, reload };
  }

  /**
   * Apaga a config: o plugin a recria com os padrões dele.
   *
   * É o "voltar ao padrão" da tela, e por isso o backup vem antes —
   * é a única coisa entre um clique e a perda de horas de ajuste.
   *
   * Com o plugin carregado, o `oxide.reload` faz o arquivo nascer de
   * novo na hora. Com ele desligado, a config volta a existir quando
   * alguém o ligar; até lá, a resposta traz `config: null`, que a
   * tela mostra como "o plugin ainda não criou este arquivo".
   */
  async configReset(serverId: string, plugin: string): Promise<PluginConfigWriteResult> {
    const { oxideConfigDir, backupsDir } = this.#pathsOf(serverId);

    const backup = await backupPluginConfig(oxideConfigDir, backupsDir, plugin, Date.now());

    await removePluginConfig(oxideConfigDir, plugin);

    const reload = await this.#reloadIfEnabled(serverId, plugin);

    this.#deps.logger.info(
      { server: serverId, plugin, backup, reloaded: reload.sent },
      'configuração de plugin restaurada ao padrão',
    );

    return { config: await readPluginConfig(oxideConfigDir, plugin), backup, reload };
  }

  /**
   * Recarrega — mas só o que está ligado ALI.
   *
   * Mandar `oxide.reload` de um plugin que aquele servidor não usa
   * enche o console do jogo com um erro que não é erro nenhum, e o
   * operador acabaria procurando defeito num plugin que ele nem
   * ligou. Editar a config de um plugin desligado é legítimo: o
   * arquivo está lá, e o que ele diz passa a valer quando alguém o
   * ligar.
   */
  async #reloadIfEnabled(serverId: string, plugin: string): Promise<PluginReloadResult> {
    const record = this.#deps.repository
      .availableFor(serverId)
      .find((candidate) => candidate.name === plugin);

    if (
      record === undefined ||
      this.#deps.repository.serverPlugin(serverId, record.id)?.enabled !== true
    ) {
      return { sent: false, output: null };
    }

    return reloadPlugin(this.#rconOf(serverId), plugin);
  }

  /** Copia do acervo para o servidor e manda recarregar. */
  async #applyTo(serverId: string, plugin: PluginRecord): Promise<PluginReloadResult> {
    this.#assertNameFree(serverId, plugin);

    const pluginsDir = this.#pluginsDirOf(serverId);
    const content = await this.#readFromStore(plugin);
    const target = pluginPath(pluginsDir, plugin.file);

    await mkdir(pluginsDir, { recursive: true });

    try {
      await writeFile(target, content);
    } catch (error) {
      throw new ApiError(
        'PLUGIN_WRITE_FAILED',
        `Não consegui gravar ${target}: ${toError(error).message}.`,
        500,
      );
    }

    // O banco só DEPOIS do arquivo: `applied_sha` afirma o que está
    // em disco, e gravá-lo antes deixaria a tela dizendo "em dia"
    // sobre uma cópia que não existe.
    this.#deps.repository.setServerPlugin(serverId, plugin.id, true, plugin.sha256);

    const reload = await reloadPlugin(this.#rconOf(serverId), plugin.name);

    this.#deps.logger.info(
      { server: serverId, plugin: plugin.name, sent: reload.sent },
      'plugin aplicado no servidor',
    );

    return reload;
  }

  /**
   * Um HOMÔNIMO já está ligado ali?
   *
   * A biblioteca pode ter um `Kits` e o servidor um `Kits` custom.
   * Os dois gravariam `Kits.cs` no mesmo caminho: o segundo
   * sobrescreveria o primeiro em silêncio, e a tela mostraria os
   * DOIS ligados — com o Oxide rodando um só, sem dizer qual.
   *
   * @throws {ApiError} 409, dizendo de onde vem o que está no
   * caminho e o que fazer.
   */
  #assertNameFree(serverId: string, plugin: PluginRecord): void {
    const rival =
      plugin.serverId === null
        ? this.#deps.repository.findCustom(serverId, plugin.name)
        : this.#deps.repository.findLibrary(plugin.name);

    if (rival === null) {
      return;
    }

    if (this.#deps.repository.serverPlugin(serverId, rival.id)?.enabled !== true) {
      return;
    }

    throw new ApiError(
      'PLUGIN_NAME_TAKEN',
      `Já há um plugin chamado "${plugin.name}" ligado neste servidor, vindo ` +
        `${rival.serverId === null ? 'da biblioteca' : 'dos plugins custom deste servidor'}. ` +
        'Os dois gravam o mesmo arquivo e o Oxide carrega um só — desligue aquele antes de ' +
        'ligar este.',
      409,
    );
  }

  /**
   * Descarrega e apaga o `.cs` daquele servidor.
   *
   * A configuração (`oxide\config\<Nome>.json`) e os dados
   * (`oxide\data\`) NÃO são tocados. Ver o cabeçalho.
   */
  async #unloadFrom(serverId: string, plugin: PluginRecord): Promise<PluginReloadResult> {
    const pluginsDir = this.#pluginsDirOf(serverId);
    const unload = await removePlugin(pluginsDir, plugin.file, this.#rconOf(serverId));

    this.#deps.repository.setServerPlugin(serverId, plugin.id, false, null);

    this.#deps.logger.info(
      { server: serverId, plugin: plugin.name },
      'plugin desligado no servidor',
    );

    return unload;
  }

  // ------------------------------------------------------
  //  A pasta manda no acervo
  // ------------------------------------------------------

  /**
   * Reconcilia o acervo com o que está EM `Plugins\`.
   *
   * ####  COPIAR O ARQUIVO NA PASTA É UM CAMINHO DE VERDADE  ####
   *
   * O upload pelo painel é conveniente, mas não pode ser o único
   * jeito de um `.cs` entrar: quem tem trinta plugins num
   * repositório os copia de uma vez, e clicar trinta vezes numa
   * tela para dizer ao agente o que já está no disco dele é
   * trabalho inventado.
   *
   * Vale para as duas pastas, com o mesmo significado de sempre:
   *
   *     Plugins\<arquivo>.cs        entra na biblioteca
   *     Plugins\<id>\<arquivo>.cs   entra como custom do <id>
   *
   * ####  ELA NÃO APAGA NADA  ####
   *
   * Arquivo que sumiu da pasta NÃO tira a linha do banco: a
   * remoção derrubaria junto, por cascata, o registro de quem
   * ativou o quê — e um `.cs` movido por engano custaria a
   * configuração de cinco servidores. Quem remove é a tela, com
   * confirmação. O sumiço vira um 409 explicando, na hora de
   * aplicar.
   */
  async syncStore(): Promise<void> {
    await this.#syncDir(null);

    for (const serverId of this.#deps.servers.ids()) {
      await this.#syncDir(serverId);
    }
  }

  /**
   * Uma pasta do acervo.
   *
   * O arquivo é lido inteiro para comparar o sha256, e não pelo
   * tamanho: trocar o dígito de uma versão preserva os bytes, e um
   * plugin "atualizado" que a tela não percebe é pior do que ler
   * alguns KB a mais numa abertura de tela.
   */
  async #syncDir(serverId: string | null): Promise<void> {
    const dir = this.#dirOf(serverId);

    for (const found of await listPlugins(dir)) {
      if (!PLUGIN_NAME_PATTERN.test(found.name)) {
        continue;
      }

      try {
        const content = await readFile(pluginPath(dir, found.name));
        const sha256 = sha256Of(content);

        const existing =
          serverId === null
            ? this.#deps.repository.findLibrary(found.plugin)
            : this.#deps.repository.findCustom(serverId, found.plugin);

        // `requires === null` = linha anterior à migração 004: o
        // conteúdo não mudou, mas as dependências nunca foram
        // extraídas dele. Relê uma vez.
        if (existing?.sha256 === sha256 && existing.requires !== null) {
          continue;
        }

        // A mesma trava do upload: um `.zip` renomeado na pasta não
        // pode virar um plugin que o Oxide tenta compilar em laço.
        assertPluginContent(content);

        const metadata = readPluginMetadata(content);

        this.#deps.repository.upsert({
          name: found.plugin,
          file: found.name,
          serverId,
          title: metadata.title,
          author: metadata.author,
          version: metadata.version,
          description: metadata.description,
          bytes: content.length,
          sha256,
          requires: metadata.requires,
          references: metadata.references,
        });

        this.#deps.logger.info(
          { plugin: found.plugin, custom: serverId, version: metadata.version },
          existing === null ? 'plugin novo encontrado na pasta' : 'plugin atualizado na pasta',
        );
      } catch (error) {
        // Um arquivo ilegível — ou que não parece C# — não pode
        // impedir a tela de abrir nem o agente de subir.
        this.#deps.logger.warn(
          { plugin: found.plugin, custom: serverId, err: toError(error) },
          'não consegui ler este plugin da pasta',
        );
      }
    }
  }

  // ------------------------------------------------------
  //  Adoção
  // ------------------------------------------------------

  /**
   * O que já estava em `oxide\plugins` entra para o acervo.
   *
   * Roda no boot e a cada abertura da aba de plugins do servidor —
   * é barato (um `readdir` mais os arquivos ainda não conhecidos) e
   * é o que faz o agente enxergar o `.cs` que alguém copiou à mão
   * enquanto ele estava no ar.
   *
   * ####  DE QUEM É O ARQUIVO ADOTADO  ####
   *
   * Na ordem: o custom daquele servidor com o mesmo nome, depois o
   * da biblioteca, e só então um custom NOVO. O palpite é
   * conservador de propósito — um `.cs` solto na pasta de um
   * servidor é, até prova em contrário, daquele servidor, e
   * mandá-lo para a biblioteca de todos seria decidir por quem não
   * pediu.
   *
   * ####  O ACERVO NUNCA É SOBRESCRITO PELA ADOÇÃO  ####
   *
   * Se o nome já existe, o arquivo do servidor NÃO substitui o do
   * acervo. O que acontece é a linha nascer com o `applied_sha` do
   * disco — que, divergindo, aparece na tela como "há versão nova
   * para aplicar". O agente mostra a diferença em vez de escolher
   * um lado sozinho.
   */
  async adopt(serverId: string): Promise<void> {
    const pluginsDir = this.#pluginsDirOf(serverId);

    // ####  QUEM JÁ ESTÁ LIGADO É O DONO DO ARQUIVO  ####
    //
    // A trava é por NOME, e não por id: `Kits.cs` em disco pertence
    // ao `Kits` que está ligado ali, seja ele da biblioteca ou
    // custom. Sem isto, o homônimo desligado seria "adotado" por
    // cima — e a tela mostraria DOIS plugins ligados para um
    // arquivo só, com o Oxide rodando um e sem dizer qual.
    const taken = new Set<string>();

    for (const row of this.#deps.repository.serverPlugins(serverId)) {
      if (!row.enabled) {
        continue;
      }

      const plugin = this.#deps.repository.get(row.pluginId);

      if (plugin !== null) {
        taken.add(plugin.name);
      }
    }

    for (const found of await listPlugins(pluginsDir)) {
      if (!PLUGIN_NAME_PATTERN.test(found.name) || taken.has(found.plugin)) {
        continue;
      }

      // Nome livre com o arquivo em disco: ou é a primeira vez que
      // o agente o vê, ou alguém o copiou de volta à mão depois de
      // desligá-lo. Nos dois casos a resposta é a mesma — o disco
      // manda, e o plugin volta a constar como ligado.
      const existing =
        this.#deps.repository.findCustom(serverId, found.plugin) ??
        this.#deps.repository.findLibrary(found.plugin);

      try {
        await this.#adoptOne(serverId, pluginsDir, found.name, found.plugin, existing);
      } catch (error) {
        // Adoção é conveniência: um arquivo ilegível não pode
        // impedir a tela de abrir nem o agente de subir.
        this.#deps.logger.warn(
          { server: serverId, plugin: found.plugin, err: toError(error) },
          'não consegui adotar este plugin',
        );
      }
    }
  }

  async #adoptOne(
    serverId: string,
    pluginsDir: string,
    file: string,
    name: string,
    existing: PluginRecord | null,
  ): Promise<void> {
    const source = pluginPath(pluginsDir, file);
    const content = await readFile(source);
    const sha256 = sha256Of(content);

    let plugin = existing;

    if (plugin === null) {
      const metadata = readPluginMetadata(content);
      const dir = this.#dirOf(serverId);

      await mkdir(dir, { recursive: true });
      await copyFile(source, pluginPath(dir, file));

      plugin = this.#deps.repository.upsert({
        name,
        file,
        // Custom daquele servidor. Ver o cabeçalho de `adopt`.
        serverId,
        title: metadata.title,
        author: metadata.author,
        version: metadata.version,
        description: metadata.description,
        bytes: content.length,
        sha256,
        requires: metadata.requires,
        references: metadata.references,
      });
    }

    // Nasce LIGADO: ele já está carregado naquele servidor. Nascer
    // desligado faria a tela mentir sobre um plugin em execução.
    this.#deps.repository.setServerPlugin(serverId, plugin.id, true, sha256);

    this.#deps.logger.info(
      { server: serverId, plugin: name, custom: plugin.serverId !== null },
      'plugin adotado',
    );
  }

  /**
   * A varredura do boot.
   *
   * A pasta primeiro, os servidores depois: um `.cs` copiado para
   * `Plugins\` enquanto o agente estava parado precisa existir no
   * acervo ANTES de a adoção decidir de quem é o arquivo que está
   * na pasta de um servidor — senão ele seria adotado como custom,
   * e o mesmo plugin passaria a existir duas vezes.
   */
  async adoptAll(): Promise<void> {
    await this.syncStore();

    for (const serverId of this.#deps.servers.ids()) {
      try {
        await this.adopt(serverId);
      } catch (error) {
        this.#deps.logger.warn(
          { server: serverId, err: toError(error) },
          'não consegui varrer os plugins deste servidor',
        );
      }
    }
  }

  // ------------------------------------------------------
  //  Ajudantes
  // ------------------------------------------------------

  /** `Plugins\` para a biblioteca; `Plugins\<id>\` para o custom. */
  #dirOf(serverId: string | null): string {
    return serverId === null ? this.#deps.libraryDir : join(this.#deps.libraryDir, serverId);
  }

  #toView(plugin: PluginRecord, servers: readonly string[]): PluginView {
    return {
      id: plugin.id,
      name: plugin.name,
      file: plugin.file,
      serverId: plugin.serverId,
      title: plugin.title,
      author: plugin.author,
      version: plugin.version,
      description: plugin.description,
      bytes: plugin.bytes,
      sha256: plugin.sha256,
      // `null` aqui é "ainda não extraí" (linha anterior à 004). A
      // tela não tem o que fazer com essa distinção — para ela, o
      // que não se sabe é lista vazia.
      requires: plugin.requires ?? [],
      references: plugin.references ?? [],
      // As duas colunas são NOT NULL: o `?? ''` é só o tipo.
      addedAt: toIso(plugin.addedAt) ?? '',
      updatedAt: toIso(plugin.updatedAt) ?? '',
      servers,
    };
  }

  /**
   * O conteúdo do `.cs` guardado pelo agente.
   *
   * @throws {ApiError} 409 quando a linha existe e o arquivo não —
   * alguém apagou de `Plugins\` à mão. A mensagem diz isso, em vez
   * de deixar um ENOENT cru virar 500.
   */
  async #readFromStore(plugin: PluginRecord): Promise<Buffer> {
    const path = pluginPath(this.#dirOf(plugin.serverId), plugin.file);

    try {
      return await readFile(path);
    } catch (error) {
      throw new ApiError(
        'PLUGIN_FILE_MISSING',
        `O plugin "${plugin.name}" está cadastrado, mas o arquivo ${path} não existe mais ` +
          `(${toError(error).message}). Envie o .cs de novo.`,
        409,
      );
    }
  }

  #requirePlugin(pluginId: number): PluginRecord {
    const plugin = this.#deps.repository.get(pluginId);

    if (plugin === null) {
      throw new ApiError(
        'UNKNOWN_PLUGIN',
        `Não existe plugin com o id ${String(pluginId)} neste agente. Ele pode ter sido ` +
          'removido em outra aba — recarregue a tela.',
        404,
      );
    }

    return plugin;
  }

  #pathsOf(serverId: string): {
    readonly pluginsDir: string;
    readonly oxideConfigDir: string;
    readonly backupsDir: string;
  } {
    const config = this.#deps.servers.configOf(serverId);

    if (config === null) {
      throw new ApiError(
        'UNKNOWN_SERVER',
        `Não existe servidor com o id "${serverId}" neste agente.`,
        404,
      );
    }

    return config.paths;
  }

  #pluginsDirOf(serverId: string): string {
    return this.#pathsOf(serverId).pluginsDir;
  }

  /**
   * Servidor parado responde igual: o arquivo vai para o lugar e o
   * Oxide o carrega no próximo start. Recusar aqui obrigaria a
   * subir o jogo só para preparar a pasta.
   */
  #rconOf(serverId: string): OpsRcon {
    return this.#deps.servers.contextOf(serverId)?.rcon ?? disconnectedRcon(serverId);
  }

  async #serverViewOf(serverId: string, pluginId: number): Promise<ServerPluginView> {
    const { plugins } = await this.serverList(serverId);
    const view = plugins.find((plugin) => plugin.id === pluginId);

    if (view === undefined) {
      throw new ApiError('UNKNOWN_PLUGIN', 'O plugin sumiu do acervo.', 404);
    }

    return view;
  }
}
