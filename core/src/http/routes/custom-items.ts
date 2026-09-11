// ============================================================
//  routes/custom-items.ts  -  os itens que NÓS criamos.
//
//      GET    /custom-items             a lista
//      GET    /custom-items/categories  as categorias que existem
//      GET    /custom-items/:id         um item
//      POST   /custom-items             cria
//      PUT    /custom-items/:id         edita (o item INTEIRO)
//      DELETE /custom-items/:id         remove
//
//  ####  ESTAS ROTAS RESPONDEM COM OS SERVIDORES DESLIGADOS  ####
//
//  Pela mesma razão da `/items`: cadastrar item é trabalho de
//  madrugada, com tudo parado. Nenhuma rota daqui fala com o RCON.
//  Quem leva o cadastro ao jogo é a sincronização, e ela acontece
//  quando o servidor sobe.
//
//  ####  O PUT REESCREVE O ITEM INTEIRO  ####
//
//  Não é PATCH. A tela edita num formulário só e manda tudo; um
//  merge parcial abriria a pergunta "o que acontece com os
//  servidores que não vieram?", e a única resposta segura seria não
//  mexer — o oposto do que espera quem desmarcou um na tela.
//
//  ####  A VALIDAÇÃO PESADA MORA AQUI, E NÃO NO BANCO  ####
//
//  O banco tem dois CHECK (skin ≠ '0', max_stack > 0) porque eles
//  pegam o caminho que esquecer de validar. Tudo o mais — a forma
//  da ação, os oito tipos de efeito, o item base existir — é zod,
//  porque a regra é longa demais para um CHECK e um CHECK que
//  entende metade dela é pior que nenhum.
// ============================================================

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { projectRoot } from '../../config.js';

import type {
  CustomItemInput,
  CustomItemRecord,
  CustomItemsRepository,
} from '../../db/custom-items-repository.js';
import type { ItemsRepository } from '../../db/items-repository.js';
import type { ServersRepository } from '../../db/servers-repository.js';
import { ApiError } from '../error-response.js';

export interface CustomItemRoutesDeps {
  readonly repository: CustomItemsRepository;
  /** Para conferir que o item base existe no catálogo do jogo. */
  readonly items: ItemsRepository;
  /** Para conferir que os servidores escolhidos existem. */
  readonly servers: ServersRepository;
  /**
   * Quem leva o cadastro ao jogo.
   *
   * Opcional porque os testes montam as rotas sem ele: o cadastro
   * tem de funcionar com todos os servidores parados, e é essa a
   * promessa que os testes guardam.
   */
  readonly sync?: { pushAll(trigger: string): Promise<unknown> };
}

/**
 * Os oito tipos de efeito, e são os do JOGO.
 *
 * MEDIDOS no enum `MetabolismAttribute.Type` do
 * `Assembly-CSharp.dll` deste servidor. A lista é fechada de
 * propósito: um nono tipo digitado errado no painel só falharia
 * dentro do jogo, em silêncio, com o jogador achando que o item
 * está quebrado.
 */
export const EFFECT_TYPES = [
  'Health',
  'HealthOverTime',
  'Bleeding',
  'Calories',
  'Hydration',
  'Poison',
  'Radiation',
  'Heartrate',
] as const;

/**
 * Quantos efeitos cabem numa ação.
 *
 * Oito tipos existem; repetir o mesmo tipo é legítimo (duas doses
 * de cura com tempos diferentes), mas dezesseis linhas de efeito
 * num item é sinal de engano, não de intenção.
 */
export const MAX_EFFECTS = 16;

const effectSchema = z.object({
  type: z.enum(EFFECT_TYPES),
  amount: z.number().finite(),
  onlyIfHealthBelow: z.number().min(0).max(1000).optional(),
});

/**
 * A ação.
 *
 * `none` não aceita mais nada junto: um item sem ação que trouxesse
 * uma lista de efeitos deixaria a dúvida de qual dos dois vale.
 */
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('consume'),
    // O gesto do jogador que dispara. `use` é o padrão porque é o
    // único que existe em todo item consumível.
    trigger: z.string().min(1).max(32).default('use'),
    consumes: z.number().int().min(0).max(100).default(1),
    effects: z.array(effectSchema).min(1).max(MAX_EFFECTS),
  }),
  // ####  O ITEM VIRA PONTO  ####
  //
  // É o desenho do Troféu Bleik: o item é um RECIBO, e não uma
  // coisa para guardar. Quem SOMA é o agente, e não o plugin — um
  // contador dentro do jogo morre no primeiro `oxide.reload`, e a
  // pontuação de uma temporada de três meses não pode morar lá.
  //
  // A métrica ainda não é validada contra uma lista: o ranking é a
  // migração 033, que está reservada e vazia. Quando ele existir,
  // este campo passa a ser conferido contra as métricas dele — e é
  // por isso que o formato (`familia.nome`) já segue o de lá.
  z.object({
    kind: z.literal('points'),
    metric: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/, 'A métrica é minúscula, no formato "familia.nome".'),
    perUnit: z.number().int().min(1).max(10_000).default(1),
    // ####  ACEITO, MAS QUEM MANDA É A COLUNA  ####
    //
    // `consume_on_pickup` (migração 042) e este campo respondem a
    // MESMA pergunta — "quando a ação acontece?" —, e a duplicata
    // é a dívida que o §3.2 do Docs\CustomItem\03 mandou quitar.
    //
    // Ele continua aqui para não recusar cadastro já gravado, mas
    // não decide nada: o `toInput` o REESCREVE com o valor da
    // coluna antes de gravar, e ele não viaja até o plugin.
    onPickup: z.boolean().default(true),
  }),
]);

/**
 * A marca, e a regra que mais importa deste arquivo.
 *
 * `skinId` é UInt64 em texto, e NUNCA é zero. Dois motivos
 * independentes, e o segundo derruba jogador do servidor:
 *
 *  1. skin 0 é indistinguível de item comum — o plugin passaria a
 *     reconhecer como nosso o troféu do Twitch que o jogador já
 *     tinha no baú;
 *  2. skin 0 num item SEM skins estoura o cliente pelo caminho do
 *     CUI. Ver `game/ui-cui.ts:309-330`.
 */
const skinIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, 'A skin é um número inteiro positivo, e nunca zero.');

const bodySchema = z.object({
  displayName: z.string().min(1).max(120),
  baseShortname: z.string().min(1).max(120),
  skinId: skinIdSchema,
  category: z.string().min(1).max(60),
  description: z.string().max(500).nullable().default(null),
  iconFile: z.string().max(120).nullable().default(null),
  // Null herda o do item base. Ver a migração 041: isto só sabe
  // DIMINUIR — o teto vive na ItemDefinition, que é do jogo.
  maxStack: z.number().int().min(1).max(1000).nullable().default(null),
  deployable: z.boolean().default(true),
  // Ver a migracao 042: e QUANDO a acao acontece, e nao O QUE.
  consumeOnPickup: z.boolean().default(false),
  action: actionSchema.default({ kind: 'none' }),
  message: z.string().max(200).nullable().default(null),
  enabled: z.boolean().default(true),
  servers: z.array(z.string().min(1)).default([]),
});

const idParams = z.object({ id: z.string().min(1) });

// ============================================================
//  O ÍCONE
//
//  ####  ELE MORA EM DISCO, E NÃO NO BANCO  ####
//
//  `Assets\items\` fica ao lado de `Assets\ui\`, que é onde as
//  imagens do menu do jogo já moram — mesma natureza, mesmo lugar:
//  arquivos que quem administra a rede troca, e não código.
//
//  O banco guarda só o NOME. O PNG vai para o jogo pelo canal do
//  agente, e quem devolve o CRC é o plugin — guardar o CRC aqui
//  seria uma segunda verdade sobre a mesma imagem.
// ============================================================

/** Onde os ícones dos itens custom moram, na raiz do projeto. */
export const ITEM_ASSETS_DIR = join('Assets', 'items');

/**
 * Teto do PNG, em bytes.
 *
 * ####  ELE NASCEU DO RCON, E FICOU POR OUTRO MOTIVO  ####
 *
 * Nasceu quando o ícone ia numa linha só de console: o frame do
 * WebRCON aguenta ~50 KB, o base64 infla 4/3, e 33 KB de PNG davam
 * ~45.000 caracteres. Desde 11/09/2026 ele vai em pedaços, pelo
 * OrigemZImages (game/image-library.ts), e esse limite deixou de
 * existir — o do transporte agora é 3 MiB.
 *
 * Ficou porque continua certo para o que ele é: um ícone de slot é
 * desenhado com menos de 100 pixels, e CADA jogador baixa o arquivo
 * na primeira vez que vê o item. MEDIDO com a arte real do Troféu
 * Bleik: 96×96 dá 25 KB, que é o que o painel já produz sozinho.
 * Subir o teto é uma linha, se um dia um ícone pedir mais.
 */
export const MAX_ICON_BYTES = 33_000;

/**
 * O lado que a recusa RECOMENDA, e que o painel já aplica sozinho.
 *
 * MEDIDO no Chrome 152 com a arte real do Troféu Bleik (1254×1254,
 * 2,9 MB): 96×96 sai com 25.060 bytes e sobra um quarto do teto;
 * 112×112 sai com 33.478 e estoura por 478. Dizer o número na frase
 * é a diferença entre "não coube" e "faça assim".
 */
export const RECOMMENDED_ICON_SIZE = 96;

/**
 * Quanto o agente LÊ antes de decidir.
 *
 * ####  ELE É MAIOR QUE O TETO DE PROPÓSITO  ####
 *
 * Parar de ler exatamente no teto custava o tamanho do arquivo: o
 * multipart corta a leitura e lança sem dizer quanto o PNG tinha, e
 * a recusa virava "passou do teto" para 34 KB e para 3 MB do mesmo
 * jeito. Quatro vezes o teto são 132 KB de memória no pior caso — e
 * cobrem a imagem QUASE certa, que é a que mais aparece: alguém
 * exportou em 128×128 e passou por 10 KB.
 *
 * O que vem muito acima disso continua sendo cortado antes de subir
 * inteiro à memória, e aí a frase diz só o teto.
 */
const ICON_READ_LIMIT = MAX_ICON_BYTES * 4;

/** A régua do nome de arquivo. */
const ICON_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.png$/i;

/**
 * Bytes na unidade em que uma pessoa lê.
 *
 * ####  KB DECIMAL AQUI, E KiB NOS OUTROS TETOS  ####
 *
 * Cada teto é escrito na base em que ele é REDONDO: o do plugin é
 * `2 * 1024 * 1024` e aparece em MiB; este é 33.000, e em KiB
 * viraria "32,2 KB" — a frase passaria a dizer um número que não
 * está em lugar nenhum do código.
 */
function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${String(Math.round(bytes / 1_000))} KB`
    : `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/**
 * A recusa por tamanho, com o que fazer depois dela.
 *
 * ####  ELA É A ÚNICA PORTA PARA QUEM NÃO USA O PAINEL  ####
 *
 * O painel reduz a imagem sozinho, no navegador, antes de enviar —
 * um upload por script ou `curl` não passa por lá. Para esse
 * caminho, esta frase é toda a orientação que existe: sem o tamanho
 * recomendado dentro dela, quem manda a arte original pelo terminal
 * só descobre que ela não serve, e não o que fazer.
 *
 * @param measured os bytes que chegaram, ou `null` quando o
 * multipart cortou a leitura antes de saber o tamanho.
 */
function iconTooLarge(measured: number | null): ApiError {
  const size =
    measured === null
      ? `O PNG passa do teto de ${formatBytes(MAX_ICON_BYTES)}`
      : `O PNG tem ${formatBytes(measured)} e o teto é ${formatBytes(MAX_ICON_BYTES)}`;

  return new ApiError(
    'ICON_TOO_LARGE',
    `${size} (${String(MAX_ICON_BYTES)} bytes). O ícone é desenhado pequeno no inventário, e ` +
      'cada jogador baixa o arquivo inteiro na primeira vez que vê o item. Envie pelo painel, ' +
      `que reduz a imagem sozinho, ou redimensione para ${String(RECOMMENDED_ICON_SIZE)}×` +
      `${String(RECOMMENDED_ICON_SIZE)} antes de mandar — a arte da medalha, nesse tamanho, dá ` +
      '25 KB.',
    400,
  );
}

/** O erro que o multipart lança quando o arquivo passa do teto. */
function isFileTooLarge(cause: unknown): boolean {
  return cause instanceof Error && (cause as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE';
}

/** O PNG que veio no multipart, conferido. */
async function uploadedIcon(
  request: FastifyRequest,
): Promise<{ filename: string; content: Buffer }> {
  if (!request.isMultipart()) {
    throw new ApiError(
      'INVALID_BODY',
      'Mande o PNG como multipart/form-data (campo "file").',
      400,
    );
  }

  const file = await request.file({ limits: { fileSize: ICON_READ_LIMIT } });

  if (file === undefined) {
    throw new ApiError('INVALID_BODY', 'Nenhum arquivo veio na requisição.', 400);
  }

  if (!ICON_NAME.test(file.filename)) {
    throw new ApiError(
      'INVALID_ICON_NAME',
      `"${file.filename}" não serve como nome de arquivo. Use letras, números, ponto, hífen ou ` +
        'sublinhado, e termine em .png — o nome viaja num comando de console do jogo, onde ' +
        'espaço separa argumentos.',
      400,
    );
  }

  let content: Buffer;

  try {
    content = await file.toBuffer();
  } catch (cause) {
    // ####  QUEM MANDA A ARTE ORIGINAL É CORTADO AQUI  ####
    //
    // O multipart para de ler no `fileSize` — que é o ponto: sem
    // isso o agente carregaria os 2,9 MB da medalha na memória só
    // para depois recusá-los. O preço é que o erro vem do
    // @fastify/multipart, em inglês e falando de "multipart
    // config", que não é o assunto de quem mandou uma imagem
    // grande demais. Traduzi-lo aqui é o que faz a recusa dizer o
    // tamanho recomendado.
    if (isFileTooLarge(cause)) {
      throw iconTooLarge(null);
    }

    throw cause;
  }

  // ####  PNG DE VERDADE, E NÃO SÓ COM O NOME CERTO  ####
  //
  // Os oito bytes da assinatura. Um JPG renomeado para .png
  // chegaria ao FileStorage do servidor, ganharia um CRC válido, e
  // o sintoma seria um quadrado vazio no inventário sem nada
  // dizendo por quê.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (content.length < 8 || !content.subarray(0, 8).equals(signature)) {
    throw new ApiError(
      'INVALID_ICON',
      'O arquivo não é um PNG. O ícone precisa ser PNG porque é o formato que guarda o fundo ' +
        'transparente — um JPG viraria um quadrado opaco no slot do inventário.',
      400,
    );
  }

  if (content.length > MAX_ICON_BYTES) {
    throw iconTooLarge(content.length);
  }

  return { filename: file.filename, content };
}

export function registerCustomItemRoutes(app: FastifyInstance, deps: CustomItemRoutesDeps): void {
  /**
   * As categorias, com quantos itens cada uma tem.
   *
   * Registrada ANTES da rota de `:id` por clareza — o Fastify
   * prefere o caminho estático de qualquer jeito, mas ler o arquivo
   * na ordem em que ele resolve poupa a dúvida.
   */
  app.get('/custom-items/categories', async () => {
    return { ok: true, categories: deps.repository.categories() };
  });

  app.get('/custom-items', async () => {
    const items = deps.repository.list();

    return { ok: true, count: items.length, items: items.map(toBody) };
  });

  /**
   * Os ícones que já estão em disco.
   *
   * A tela usa isto para oferecer o que já foi enviado, em vez de
   * pedir que alguém digite o nome do arquivo de cabeça.
   */
  app.get('/custom-items/icons', async () => {
    return { ok: true, icons: listIcons() };
  });

  /**
   * Recebe um PNG e o grava em `Assets\items\`.
   *
   * Devolve o NOME, que é o que vai para a coluna `icon_file`. Os
   * bytes só chegam ao jogo depois, pela sincronização — esta rota
   * não fala com o RCON, como nenhuma outra daqui.
   */
  /**
   * Devolve o PNG, para a tela conseguir mostrá-lo.
   *
   * ####  POR QUE O AGENTE SERVE A IMAGEM  ####
   *
   * Porque ela não está em lugar nenhum que o navegador alcance: o
   * arquivo mora em `Assets\items\`, na máquina do agente, e o que
   * o jogo tem é um CRC dentro do servidor de Rust. Sem esta rota,
   * a tela de cadastro mostraria o nome do arquivo e pediria fé.
   *
   * O `immutable` no cache é seguro porque reenviar a mesma arte
   * grava o mesmo nome com bytes novos — e quem quer ver a nova
   * acabou de enviá-la, então a tela já tem os bytes na mão.
   */
  app.get('/custom-items/icons/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(request.params);

    // A régua barra `..` e barra invertida antes de o nome virar
    // caminho: sem ela, `../../.env` seria um pedido válido.
    if (!ICON_NAME.test(name)) {
      throw new ApiError('INVALID_ICON_NAME', `"${name}" não é um nome de ícone válido.`, 400);
    }

    let content: Buffer;

    try {
      content = readFileSync(join(projectRoot(), ITEM_ASSETS_DIR, name));
    } catch {
      throw new ApiError('ICON_NOT_FOUND', `Nenhum ícone chamado "${name}".`, 404);
    }

    return reply.type('image/png').header('cache-control', 'private, max-age=60').send(content);
  });

  app.post('/custom-items/icons', async (request) => {
    const { filename, content } = await uploadedIcon(request);
    const dir = join(projectRoot(), ITEM_ASSETS_DIR);

    // A pasta não existir é o estado normal de quem nunca enviou
    // ícone nenhum — criá-la é parte do trabalho, e não um erro.
    mkdirSync(dir, { recursive: true });

    // Sobrescrever é o comportamento certo: reenviar a arte
    // corrigida com o mesmo nome é exatamente o gesto de "troquei o
    // ícone". E o CRC do jogo nasce dos BYTES, então o cliente
    // baixa a versão nova sozinho, sem ninguém invalidar nada.
    writeFileSync(join(dir, filename), content);

    request.log.info({ icon: filename, bytes: content.length }, 'ícone de item custom recebido');

    return { ok: true, icon: { name: filename, bytes: content.length } };
  });

  app.get('/custom-items/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    return { ok: true, item: toBody(mustGet(deps, id)) };
  });

  app.post('/custom-items', async (request, reply) => {
    const input = toInput(bodySchema.parse(request.body));

    validate(deps, input, null);

    const created = deps.repository.create(input);

    request.log.info(
      { item: created.id, base: created.baseShortname, skin: created.skinId },
      'item custom criado',
    );

    // ####  SEM ISTO, O ITEM NÃO EXISTE NO JOGO  ####
    //
    // Ele fica no banco, aparece na tela, e o plugin nunca soube
    // que existe — o nome não é aplicado, o ícone não é aplicado e
    // a conversão não acontece. Ver game/custom-items-sync.ts.
    //
    // `void` e sem `await`: um servidor reiniciando não pode
    // segurar a resposta de quem acabou de salvar. O cadastro já
    // está gravado, e a reconexão o empurra de novo.
    void deps.sync?.pushAll('custom-item-created');

    await reply.code(201).send({ ok: true, item: toBody(created) });
  });

  app.put('/custom-items/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const input = toInput(bodySchema.parse(request.body));

    mustGet(deps, id);
    validate(deps, input, id);

    const saved = deps.repository.update(id, input);

    if (saved === null) {
      // Só chega aqui se alguém apagou o item entre o `mustGet` e o
      // `update`. É improvável, e é exatamente por isso que merece
      // um 404 honesto em vez de um 500.
      throw notFound(id);
    }

    void deps.sync?.pushAll('custom-item-updated');

    return { ok: true, item: toBody(saved) };
  });

  app.delete('/custom-items/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    mustGet(deps, id);

    // ####  APAGAR É DIFERENTE DE DESLIGAR  ####
    //
    // Desligar (`enabled: false`) tira o item de circulação e não
    // deixa órfão nenhum: quem já o tem no inventário continua com
    // ele, e o plugin continua reconhecendo. Apagar tira a linha —
    // e a tela precisa oferecer o primeiro antes do segundo.
    deps.repository.remove(id);

    request.log.info({ item: id }, 'item custom apagado');

    // O `clear` do plugin é o que faz o item apagado sumir do jogo:
    // sem esta linha ele continuaria sendo reconhecido lá até o
    // próximo restart.
    void deps.sync?.pushAll('custom-item-removed');

    return { ok: true };
  });
}

/**
 * As conferências que o banco não faz.
 *
 * @throws ApiError com a frase pronta. Ver o cabeçalho para por que
 * elas moram aqui e não num CHECK.
 */
function validate(deps: CustomItemRoutesDeps, input: CustomItemInput, currentId: string | null) {
  // ####  O ITEM BASE PRECISA EXISTIR NESTA VERSÃO DO JOGO  ####
  //
  // Conferir aqui é conferir no cadastro. Não conferir seria
  // descobrir dias depois, na entrega, com o jogador esperando — o
  // mesmo defeito que o catálogo de itens nasceu para evitar.
  const base = deps.items.get(input.baseShortname);

  if (base === null) {
    throw new ApiError(
      'UNKNOWN_BASE_ITEM',
      `Nenhum item do jogo com o shortname "${input.baseShortname}". O item custom empresta o ` +
        'corpo de um item que o Rust já tem — escolha um da lista do catálogo.',
      400,
    );
  }

  // ####  "SÓ AO USAR" NÃO EXISTE EM ITEM NÃO-CONSUMÍVEL  ####
  //
  // O hook `OnItemUse` do Oxide só dispara em quem tem
  // `ItemModConsumable`, e o menu de contexto do item é montado
  // pelo CLIENTE a partir da `ItemDefinition` — não há como criar
  // uma opção nova nele, e este projeto já mediu isso.
  //
  // Salvar essa combinação produz um item INERTE, em silêncio: o
  // jogador pega o troféu, clica, nada acontece, e nada no log
  // explica. Recusar agora é a diferença entre descobrir no
  // cadastro e descobrir por reclamação de jogador.
  //
  // O `null` do `consumable` NÃO recusa: ele é "ninguém perguntou"
  // (catálogo anterior à migração 045, ou plugin velho no
  // servidor), e negar por falta de dado quebraria a promessa
  // desta tela de funcionar com todos os servidores parados. Nesse
  // caso quem avisa é o plugin, no log, ao receber a definição.
  if (input.action.kind === 'points' && !input.consumeOnPickup && base.consumable === false) {
    throw new ApiError(
      'BASE_ITEM_NOT_CONSUMABLE',
      `"${base.displayName}" (${base.shortname}) não é um item consumível do Rust, então o ` +
        'jogador não tem como "usá-lo" — o menu do botão direito é montado pelo cliente do jogo, ' +
        'e nenhum plugin acrescenta opção nele. Configurado assim, o item ficaria no inventário ' +
        'sem nunca virar ponto. Escolha "Assim que cair no inventário", ou troque o item base por ' +
        'um consumível (uma comida, uma bebida, um remédio).',
      400,
    );
  }

  // ####  A MARCA É ÚNICA  ####
  //
  // Duas definições com o mesmo par (base, skin) deixariam o plugin
  // sem critério para escolher qual dos dois itens ele está vendo.
  // O índice único do banco também recusa; aqui a recusa vira uma
  // frase que diz QUAL item já usa a marca.
  const clash = deps.repository
    .list()
    .find(
      (item) =>
        item.baseShortname === input.baseShortname &&
        item.skinId === input.skinId &&
        item.id !== currentId,
    );

  if (clash !== undefined) {
    throw new ApiError(
      'DUPLICATE_MARK',
      `A skin ${input.skinId} em "${input.baseShortname}" já é a marca do item "${clash.displayName}". ` +
        'Dois itens com a mesma marca são indistinguíveis dentro do jogo — escolha outra skin.',
      409,
    );
  }

  // Servidor que não existe na tabela vira uma ligação órfã que o
  // FOREIGN KEY recusaria com uma mensagem que ninguém entende.
  const known = new Set(deps.servers.list().map((server) => server.id));
  const unknown = input.servers.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw new ApiError(
      'UNKNOWN_SERVER',
      `Estes servidores não existem: ${unknown.join(', ')}.`,
      400,
    );
  }
}

/**
 * Os PNGs de `Assets\items\`, com o tamanho de cada um.
 *
 * Pasta ausente devolve lista vazia, sem aviso: é o estado normal
 * de quem ainda não enviou ícone nenhum, e um `warn` por leitura
 * seria ruído que ensina a ignorar o log.
 */
function listIcons(): readonly { readonly name: string; readonly bytes: number }[] {
  const dir = join(projectRoot(), ITEM_ASSETS_DIR);

  try {
    return readdirSync(dir)
      .filter((file) => /\.png$/i.test(file))
      .map((file) => ({ name: file, bytes: statSync(join(dir, file)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Os bytes de um ícone de `Assets\items\`, ou `null`.
 *
 * É a porta da sincronização (game/custom-items-sync.ts), que leva o
 * PNG ao OrigemZImages. A régua do nome é a MESMA do upload, e aqui
 * ela protege outra coisa: `icon_file` vem do banco, e o PUT só
 * confere o tamanho dele — sem a régua, `../../.env` seria lido e
 * mandado ao RCON.
 */
export function readItemIcon(name: string): Buffer | null {
  if (!ICON_NAME.test(name)) {
    return null;
  }

  try {
    return readFileSync(join(projectRoot(), ITEM_ASSETS_DIR, name));
  } catch {
    return null;
  }
}

function mustGet(deps: CustomItemRoutesDeps, id: string): CustomItemRecord {
  const item = deps.repository.get(id);

  if (item === null) {
    throw notFound(id);
  }

  return item;
}

function notFound(id: string): ApiError {
  return new ApiError('CUSTOM_ITEM_NOT_FOUND', `Nenhum item custom com o id "${id}".`, 404);
}

/** O corpo validado vira o que o repositório espera. */
function toInput(body: z.infer<typeof bodySchema>): CustomItemInput {
  return {
    displayName: body.displayName,
    baseShortname: body.baseShortname,
    skinId: body.skinId,
    category: body.category,
    description: body.description,
    iconFile: body.iconFile,
    maxStack: body.maxStack,
    deployable: body.deployable,
    consumeOnPickup: body.consumeOnPickup,
    action: mirrorPickup(body.action, body.consumeOnPickup),
    message: body.message,
    enabled: body.enabled,
    servers: body.servers,
  };
}

/**
 * O `action.onPickup` passa a ser um ESPELHO da coluna.
 *
 * ####  DUAS VERDADES SOBRE A MESMA COISA VIRAM UMA  ####
 *
 * `consume_on_pickup` e `action.onPickup` respondem a mesma
 * pergunta ("quando a ação acontece?"), e enquanto as duas
 * pudessem divergir a próxima pessoa a ler o registro não teria
 * como saber qual valia. A coluna manda — porque a pergunta é do
 * ITEM, e não de cada tipo de ação: enfiá-la dentro de cada `kind`
 * obrigaria a repeti-la em todo tipo novo e a esquecê-la em um
 * deles. Ver Docs\CustomItem\03 §3.2.
 *
 * Reescrever aqui, na gravação, é o que impede a divergência de
 * nascer. Sem isto, um cadastro salvo pelo painel de antes deixaria
 * `onPickup: true` (o default do zod) ao lado de
 * `consumeOnPickup: false` — e quem lesse o JSON concluiria o
 * oposto do que o jogo faz.
 */
function mirrorPickup(
  action: z.infer<typeof actionSchema>,
  consumeOnPickup: boolean,
): z.infer<typeof actionSchema> {
  return action.kind === 'points' ? { ...action, onPickup: consumeOnPickup } : action;
}

/** Um item, na forma que a API entrega. Datas em ISO. */
function toBody(item: CustomItemRecord) {
  return {
    id: item.id,
    displayName: item.displayName,
    baseShortname: item.baseShortname,
    baseItemId: item.baseItemId,
    // O item base sumiu do jogo. A tela precisa dizer isso: um item
    // custom em cima de um shortname que o Rust não tem mais nunca
    // vai ser entregue.
    baseMissing: item.baseMissing,
    skinId: item.skinId,
    category: item.category,
    description: item.description,
    iconFile: item.iconFile,
    maxStack: item.maxStack,
    deployable: item.deployable,
    consumeOnPickup: item.consumeOnPickup,
    action: item.action,
    message: item.message,
    enabled: item.enabled,
    servers: item.servers,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}
