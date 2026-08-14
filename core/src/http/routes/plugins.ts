// ============================================================
//  routes/plugins.ts  -  o acervo de plugins, e o que cada
//  servidor liga dele.
//
//  Duas famílias de rota, porque são dois assuntos:
//
//      /api/plugins                a BIBLIOTECA — vale para todos
//      /api/servers/:id/plugins    o acervo DAQUELE servidor (a
//                                  biblioteca + os customs dele) e
//                                  o que está ligado
//
//  ####  O UPLOAD EXISTE NOS DOIS LUGARES, E SIGNIFICA COISAS
//        DIFERENTES  ####
//
//    POST /api/plugins               entra para a biblioteca:
//                                    qualquer servidor pode ligar
//
//    POST /api/servers/:id/plugins   entra como CUSTOM daquele
//                                    servidor: nenhum outro o vê
//
//  O segundo é o `.cs` do evento de um fim de semana, o teste que
//  não vai para os outros. Mandá-lo para a biblioteca de todos
//  seria poluir a tela de rede com o experimento de um servidor.
//
//  ------------------------------------------------------------
//  ####  `:pluginId` É NÚMERO, E NÃO O NOME  ####
//
//  O nome não é único: a biblioteca pode ter um `Kits` e o `pvp1`
//  ter outro, custom, com conteúdo diferente. Uma rota por nome
//  seria ambígua justamente no caso que a migração 003 existe para
//  permitir.
// ============================================================

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { PluginLibrary } from '../../oxide/library.js';
import { MAX_PLUGIN_BYTES } from '../../oxide/plugins.js';
import { ApiError } from '../error-response.js';

export interface PluginRoutesDeps {
  readonly library: PluginLibrary;
}

const serverParams = z.object({ id: z.string().min(1) });
const pluginParams = z.object({ pluginId: z.coerce.number().int().positive() });
const serverPluginParams = z.object({
  id: z.string().min(1),
  pluginId: z.coerce.number().int().positive(),
});

const serverConfigParams = z.object({
  id: z.string().min(1),
  // A trava de verdade é o `pluginConfigPath`, que confere o
  // alfabeto E o caminho resolvido. Aqui só se recusa o vazio: uma
  // segunda cópia do padrão do nome seria a que um dia diverge.
  plugin: z.string().min(1).max(64),
});

const toggleBody = z.object({ enabled: z.boolean() });
const configBody = z.object({ text: z.string() });
const copyFromBody = z.object({ from: z.string().min(1) });
const forceQuery = z.object({ force: z.enum(['0', '1']).optional() });

/** O `.cs` que veio no multipart, conferido. */
async function uploadedFile(
  request: FastifyRequest,
): Promise<{ filename: string; content: Buffer }> {
  if (!request.isMultipart()) {
    throw new ApiError(
      'INVALID_BODY',
      'Mande o arquivo do plugin como multipart/form-data (campo "file").',
      400,
    );
  }

  const file = await request.file({ limits: { fileSize: MAX_PLUGIN_BYTES } });

  if (file === undefined) {
    throw new ApiError('INVALID_BODY', 'Nenhum arquivo veio na requisição.', 400);
  }

  return { filename: file.filename, content: await file.toBuffer() };
}

/**
 * O texto de "gravei, mas não apliquei".
 *
 * ####  ENVIAR NÃO É APLICAR  ####
 *
 * O acervo ficou em dia; os servidores que já usam o plugin
 * continuam com a versão anterior até alguém aplicar. Dizer isso na
 * resposta é o que evita a conclusão de que "subiu, então já está
 * valendo".
 */
function storedMessage(pendingServers: readonly string[], where: string): string {
  if (pendingServers.length === 0) {
    return `Plugin gravado ${where}.`;
  }

  return (
    `Plugin gravado ${where}. ${pendingServers.join(', ')} ainda está na versão anterior — ` +
    'aplique a atualização na aba Plugins de cada um.'
  );
}

export function registerPluginRoutes(app: FastifyInstance, deps: PluginRoutesDeps): void {
  // ==========================================================
  //  A biblioteca (nível de rede)
  // ==========================================================

  // ####  ESTE GET VARRE `Plugins\`  ####
  //
  // Um `.cs` copiado para a pasta à mão entra para a biblioteca
  // aqui. É o que faz "copiar trinta arquivos de uma vez" valer
  // tanto quanto trinta uploads. Ver PluginLibrary.syncStore.
  app.get('/plugins', async () => ({ ok: true, plugins: await deps.library.list() }));

  app.post('/plugins', async (request) => {
    const { filename, content } = await uploadedFile(request);
    const result = await deps.library.add(filename, content);

    return { ok: true, ...result, message: storedMessage(result.pendingServers, 'na biblioteca') };
  });

  app.delete('/plugins/:pluginId', async (request) => {
    const { pluginId } = pluginParams.parse(request.params);
    const { force } = forceQuery.parse(request.query);

    // Sem `force`, a biblioteca recusa com 409 dizendo QUAIS
    // servidores usam o plugin. Ver PluginLibrary.remove.
    const result = await deps.library.remove(pluginId, force === '1');

    return {
      ok: true,
      ...result,
      message:
        result.removedFrom.length === 0
          ? `${result.name} saiu do acervo.`
          : `${result.name} saiu do acervo e de ${result.removedFrom.join(', ')}. ` +
            'A configuração em oxide\\config foi preservada.',
    };
  });

  // ==========================================================
  //  O acervo daquele servidor
  // ==========================================================

  /**
   * A biblioteca mais os customs deste servidor, cada um com
   * `enabled`, `updateAvailable` e `blockedBy`.
   *
   * ####  ESTE GET ADOTA  ####
   *
   * Um `.cs` que alguém copiou à mão para `oxide\plugins` entra
   * para o acervo aqui, como custom deste servidor — e é o momento
   * certo, porque é quando alguém está olhando para a tela dele. A
   * alternativa seria o operador ver um plugin carregado no jogo e
   * ausente do painel, sem nada explicando a diferença.
   */
  app.get('/servers/:id/plugins', async (request) => {
    const { id } = serverParams.parse(request.params);

    return { ok: true, ...(await deps.library.serverList(id)) };
  });

  /** O upload CUSTOM: entra só para este servidor. */
  app.post('/servers/:id/plugins', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { filename, content } = await uploadedFile(request);

    const result = await deps.library.addCustom(id, filename, content);

    return {
      ok: true,
      ...result,
      message:
        `${storedMessage(result.pendingServers, `nos plugins custom de ${id}`)} ` +
        'Ligue-o na coluna de disponíveis para aplicá-lo ao servidor.',
    };
  });

  /**
   * Liga, desliga — e aplica a atualização.
   *
   * `{ enabled: true }` num plugin JÁ ligado recopia o arquivo do
   * acervo e recarrega: é assim que "há versão nova para aplicar"
   * vira "aplicada". Uma rota separada para isso seria um segundo
   * caminho para copiar-e-recarregar, e os dois divergiriam no
   * primeiro ajuste.
   */
  app.put('/servers/:id/plugins/:pluginId', async (request) => {
    const { id, pluginId } = serverPluginParams.parse(request.params);
    const { enabled } = toggleBody.parse(request.body);
    const { force } = forceQuery.parse(request.query);

    // Sem `force`, desligar um plugin do qual outros dependem
    // responde 409 dizendo quem cai junto. Ver
    // PluginLibrary.setEnabled.
    const result = await deps.library.setEnabled(id, pluginId, enabled, force === '1');
    const { name, missingRequires } = result.plugin;

    return {
      ok: true,
      ...result,
      // Gravar e carregar são coisas diferentes: o arquivo pode ir
      // para o lugar certo e o plugin não compilar. O que o Oxide
      // respondeu — inclusive o erro de compilação — está em
      // `reload.output`.
      message: [
        result.reload.sent
          ? enabled
            ? `${name} aplicado e recarregado. Veja em reload.output o que o Oxide respondeu.`
            : `${name} descarregado e removido deste servidor. A configuração dele foi preservada.`
          : enabled
            ? `${name} copiado. O servidor está parado — o Oxide o carrega no próximo start.`
            : `${name} removido deste servidor. Ele estava parado, então não houve o que descarregar.`,
        // ####  LIGADO NÃO É O MESMO QUE CARREGADO  ####
        //
        // Com uma dependência dura faltando, o Oxide segura o
        // plugin até ela aparecer. O arquivo está lá, a tela diz
        // "ativo", e nada acontece no jogo — dizer isto aqui é o
        // que evita a caça ao erro que não existe.
        enabled && missingRequires.length > 0
          ? `Atenção: ele depende de ${missingRequires.join(', ')}, que não está ligado aqui — ` +
            'o Oxide só vai carregá-lo quando isso mudar.'
          : null,
      ]
        .filter((parte): parte is string => parte !== null)
        .join(' '),
    };
  });

  // ==========================================================
  //  A configuração de cada plugin
  // ==========================================================

  //  ####  AQUI A CHAVE É O NOME, E NÃO O `:pluginId`  ####
  //
  //  Contra a regra do resto deste arquivo, e de propósito: a config
  //  mora em `oxide\config\<Nome>.json`, do lado do jogo, e sobrevive
  //  ao plugin. Desligar não a apaga; tirar do acervo não a apaga.
  //
  //  Uma rota por `:pluginId` não conseguiria abrir a config do
  //  plugin que saiu do acervo — que é exatamente a que alguém vai
  //  procurar, para recuperar horas de ajuste. E o nome não é
  //  ambíguo aqui: naquela pasta, `Kits.json` é um arquivo só,
  //  qualquer que tenha sido o `Kits` que o criou.

  app.get('/servers/:id/plugin-configs', async (request) => {
    const { id } = serverParams.parse(request.params);

    return { ok: true, ...(await deps.library.configList(id)) };
  });

  app.get('/servers/:id/plugin-configs/:plugin', async (request) => {
    const { id, plugin } = serverConfigParams.parse(request.params);
    const config = await deps.library.configRead(id, plugin);

    return {
      ok: true,
      plugin,
      config,
      // Ausente não é erro: o plugin só cria o arquivo quando carrega
      // pela primeira vez. Um 404 aqui apareceria na tela como
      // "deu problema", e o certo a dizer é o que falta acontecer.
      message:
        config === null
          ? `${plugin} ainda não criou o arquivo de configuração. Ele nasce com os padrões do ` +
            'plugin no primeiro carregamento — ligue-o neste servidor e o arquivo aparece.'
          : null,
    };
  });

  app.put('/servers/:id/plugin-configs/:plugin', async (request) => {
    const { id, plugin } = serverConfigParams.parse(request.params);
    const { text } = configBody.parse(request.body);

    const result = await deps.library.configWrite(id, plugin, text);

    return {
      ok: true,
      plugin,
      ...result,
      // O que a tela mostra depois de gravar. As duas frases são
      // situações diferentes, e chamar as duas de "salvo" faria o
      // operador esperar um efeito que não veio.
      message: result.reload.sent
        ? `Configuração de ${plugin} gravada e o plugin recarregado. Veja em reload.output o que ` +
          'o Oxide respondeu — é ali que aparece o campo que o plugin esperava e não veio.'
        : `Configuração de ${plugin} gravada. Ela passa a valer quando o plugin estiver ligado ` +
          'neste servidor e o servidor estiver no ar.',
    };
  });

  app.delete('/servers/:id/plugin-configs/:plugin', async (request) => {
    const { id, plugin } = serverConfigParams.parse(request.params);
    const result = await deps.library.configReset(id, plugin);

    return {
      ok: true,
      plugin,
      ...result,
      message:
        result.config === null
          ? `Configuração de ${plugin} apagada. O plugin a recria com os padrões dele no próximo ` +
            'carregamento.'
          : `Configuração de ${plugin} restaurada: o plugin recriou o arquivo com os padrões ` +
            'dele.',
    };
  });

  /**
   * Liga o plugin E o que ele precisa, na ordem certa.
   *
   * Uma rota, e não a tela chamando o `PUT` várias vezes: a ordem
   * topológica é regra, e no navegador ela não teria teste.
   */
  app.post('/servers/:id/plugins/:pluginId/enable-with-deps', async (request) => {
    const { id, pluginId } = serverPluginParams.parse(request.params);
    const result = await deps.library.enableWithDeps(id, pluginId);

    return {
      ok: true,
      ...result,
      message:
        result.enabled.length === 0
          ? `${result.plugin.name} já estava ligado, com todas as dependências.`
          : `Ligados nesta ordem: ${result.enabled.join(' → ')}. A ordem é a das dependências — ` +
            'o Oxide segura um plugin enquanto o que ele exige não estiver carregado.',
    };
  });

  /**
   * Deixa este servidor com os mesmos plugins de outro.
   *
   * O "conjunto" é um servidor que já funciona — ver
   * `PluginLibrary.copyFrom`. A configuração de cada plugin NÃO vem
   * junto: ela é de lá.
   */
  app.post('/servers/:id/plugins/copy-from', async (request) => {
    const { id } = serverParams.parse(request.params);
    const { from } = copyFromBody.parse(request.body);

    const result = await deps.library.copyFrom(id, from);

    return {
      ok: true,
      from,
      ...result,
      message: [
        result.enabled.length === 0
          ? `Nada foi ligado: este servidor já tinha tudo o que "${from}" usa.`
          : `Ligados aqui: ${result.enabled.join(', ')}.`,
        result.skipped.length === 0
          ? null
          : `${String(result.skipped.length)} não vieram — veja "skipped" para o motivo de cada um.`,
        'A configuração de cada plugin não foi copiada: ela é daquele servidor.',
      ]
        .filter((parte): parte is string => parte !== null)
        .join(' '),
    };
  });

  app.post('/servers/:id/plugins/:pluginId/reload', async (request) => {
    const { id, pluginId } = serverPluginParams.parse(request.params);
    const reload = await deps.library.reload(id, pluginId);

    if (!reload.sent && reload.output === null) {
      throw new ApiError(
        'RCON_UNAVAILABLE',
        `O servidor "${id}" não está no ar — não há para quem mandar o oxide.reload.`,
        503,
      );
    }

    return { ok: true, reload };
  });
}
