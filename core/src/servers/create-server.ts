// ============================================================
//  create-server.ts  -  UM SERVIDOR NOVO, PELO PAINEL.
//
//      POST /api/servers  ->  Configs\<id>.ini  +  linha em `servers`
//
//  Duas escritas, nesta ordem, e nada além disso. O que esta
//  operação faz é CONFIGURAR um servidor — ela não instala o jogo,
//  não sobe processo nenhum e não mexe no registry em memória.
//
//  ------------------------------------------------------------
//  ####  O SERVIDOR NASCE DESLIGADO, E ISSO É O DESENHO  ####
//
//  `SERVER_ENABLED=0` no arquivo, `enabled = 0` na tabela.
//
//  O RustDedicated são dezenas de GB que ainda não estão em disco
//  no instante em que alguém clica em "criar". Um servidor que
//  nascesse ligado ganharia um `ServerContext` no próximo boot — ou
//  seja, um `RconClient` tentando conectar numa porta onde nunca vai
//  haver processo, reconectando para sempre, e um painel mostrando
//  como "fora do ar" um servidor que nunca esteve no ar.
//
//  Ligar é decisão de DEPOIS de instalar, e são dois passos:
//
//      POST /api/servers/<id>/operations  {"kind":"server-install"}
//                                         o SteamCMD baixa o jogo
//      PATCH /api/servers/<id> {enabled}  liga, sem reiniciar nada
//
//  O segundo passo é do supervisor (servers/supervisor.ts): ele
//  monta o contexto, sobe o RCON e grava `SERVER_ENABLED=1` no
//  `.ini` — reiniciar o agente deixou de ser necessário.
//
//  ------------------------------------------------------------
//  ####  O MODELO É O server.example.ini, E NÃO UM TEXTO DAQUI  ####
//
//  O arquivo gerado precisa ter TODAS as chaves que o agente lê:
//  `STEAM_APPID` e `STEAM_LOGIN` na instalação, `SERVER_DESCRIPTION`,
//  `SERVER_SAVEINTERVAL` e `RCON_WEB` na linha de comando do jogo.
//  Um template escrito aqui esqueceria a próxima chave que
//  aparecesse, e o sintoma seria um `+app_update` sem AppID — uma
//  instalação que falha depois de o dono já ter clicado.
//
//  Por isso a fonte é `Configs\server.example.ini`: o que a
//  requisição informa é substituído, e todo o resto vai junto,
//  inclusive os comentários que explicam cada chave.
//
//  ------------------------------------------------------------
//  ####  VALIDA TUDO, DEPOIS ESCREVE  ####
//
//  E se a linha da tabela falhar, o `.ini` recém-escrito é APAGADO.
//  Um arquivo órfão faria a tentativa seguinte bater no 409 de "já
//  existe" por culpa da tentativa anterior — e a pessoa ficaria
//  presa sem ter o que consertar na tela.
// ============================================================

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { MAP_LEVELS, MAX_SEED, MAX_WORLD_SIZE, MIN_WORLD_SIZE } from './map-levels.js';
import type { ServerInput, ServerRecord } from '../db/servers-repository.js';
import { toError } from '../util.js';
import {
  MAX_PORT_BLOCK,
  portBlock,
  suggestPortBlock,
  validateNoConflicts,
  type PortBlock,
  type PortConflict,
} from './ports.js';

/**
 * O que um `serverId` NOVO pode ser.
 *
 * Mais apertado que o `SERVER_ID_PATTERN` de config.ts, que
 * DESCOBRE servidores: aquele aceita o que já existe em `Configs\`
 * (inclusive id começando por dígito), este decide o que passa a
 * existir. Começar por letra e ter pelo menos dois caracteres evita
 * nome de pasta esquisito e id de uma letra que ninguém reconhece
 * numa lista.
 *
 * Minúsculas porque o id vira nome de pasta e o Windows não
 * distingue `Pvp2\` de `pvp2\` — dois ids que só diferem no caixa
 * apontariam para a MESMA instalação.
 */
export const NEW_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * O que a senha do WebRCON NÃO pode ter.
 *
 * Ela viaja no CAMINHO da URL (`ws://host:porta/SENHA`) e o Rust
 * compara o caminho cru com a senha configurada — não há como
 * percent-encodar. Com "/", "\", "?", "#" ou espaço, o sintoma é
 * "falha de autenticação" em laço de reconexão, sem nada dizendo
 * por quê.
 *
 * Mora aqui, onde a senha é ESCRITA, e é importada por config.ts,
 * onde ela é LIDA. Uma regra só de propósito: uma senha que a
 * criação aceitasse e a leitura recusasse deixaria o agente subir
 * sem RCON num servidor recém-criado.
 */
export const FORBIDDEN_RCON_PASSWORD_CHARS = /[/\\?#\s]/;

/** O modelo versionado, dentro de `Configs\`. */
export const SERVER_INI_TEMPLATE_FILE = 'server.example.ini';

/**
 * Texto que vai virar `CHAVE=valor` num `.ini`.
 *
 * O `\p{Cc}` (caractere de controle) é o ponto: uma quebra de linha
 * dentro do hostname escreveria uma LINHA NOVA no arquivo, e essa
 * linha seria lida como outra chave. `RCON_PASSWORD` embutida num
 * nome de servidor é o exemplo de por que isto é recusado na borda.
 */
function iniText(label: string, max: number) {
  return z
    .string({ invalid_type_error: `${label} precisa ser texto` })
    .trim()
    .min(1, `${label} não pode ser vazio`)
    .max(max, `${label} não pode passar de ${String(max)} caracteres`)
    .refine(
      (value) => !/\p{Cc}/u.test(value),
      `${label} não pode conter quebra de linha nem caractere de controle: ` +
        'o valor vai para uma linha CHAVE=valor de Configs\\<id>.ini',
    );
}

/**
 * O corpo de `POST /api/servers`.
 *
 * `.strict()` pelo mesmo motivo do resto da API: um painel que
 * mande `world_size` em vez de `worldSize` precisa saber na hora,
 * em vez de criar um mundo de 3000 achando que pediu 4000.
 */
export const createServerBodySchema = z
  .object({
    id: z
      .string({ invalid_type_error: 'id precisa ser texto' })
      .trim()
      .regex(
        NEW_SERVER_ID_PATTERN,
        'id precisa ter de 2 a 31 caracteres, começar por letra minúscula e usar só ' +
          'minúsculas, dígitos e hífen (ele vira o nome do .ini e o da pasta): pvp2, arena-2',
      ),

    name: iniText('name', 80),

    /**
     * Ausente = igual ao `id`.
     *
     * Não é o mesmo que o id: o id organiza a MÁQUINA (arquivo,
     * pastas, chave estrangeira do histórico) e a identity organiza
     * os SAVES, dentro da instalação. Mesmo alfabeto porque ela
     * também vira nome de pasta.
     */
    identity: z
      .string({ invalid_type_error: 'identity precisa ser texto' })
      .trim()
      .regex(
        NEW_SERVER_ID_PATTERN,
        'identity segue a mesma regra do id (minúsculas, dígitos e hífen): ela vira o ' +
          'nome da pasta de saves',
      )
      .optional(),

    /** O `server.hostname`: o nome que aparece na lista da Steam. */
    hostname: iniText('hostname', 120),

    maxPlayers: z
      .number({ invalid_type_error: 'maxPlayers precisa ser número (não string)' })
      .int('maxPlayers precisa ser inteiro')
      .min(1, 'maxPlayers precisa ser pelo menos 1')
      .max(1_000, 'maxPlayers não pode passar de 1000'),

    /**
     * O `server.level`.
     *
     * A lista é a mesma da fila de mapas (`MAP_LEVELS`) de
     * propósito: mapa por URL não é aceito lá porque nada verifica
     * se o arquivo existe e se ele bate com a versão do jogo, e
     * aceitá-lo aqui criaria um servidor que não sobe no primeiro
     * boot.
     */
    map: z.enum(MAP_LEVELS, {
      errorMap: () => ({
        message: `map precisa ser um destes: ${MAP_LEVELS.join(', ')}`,
      }),
    }),

    worldSize: z
      .number({ invalid_type_error: 'worldSize precisa ser número (não string)' })
      .int('worldSize precisa ser inteiro')
      .min(MIN_WORLD_SIZE, `worldSize não pode ser menor que ${String(MIN_WORLD_SIZE)}`)
      .max(MAX_WORLD_SIZE, `worldSize não pode passar de ${String(MAX_WORLD_SIZE)}`),

    /** Ausente = a seed que o modelo já traz. */
    seed: z
      .number({ invalid_type_error: 'seed precisa ser número (não string)' })
      .int('seed precisa ser inteiro')
      .min(0, 'seed não pode ser negativa')
      .max(MAX_SEED, `seed não pode passar de ${String(MAX_SEED)}`)
      .optional(),

    rconPassword: z
      .string({ invalid_type_error: 'rconPassword precisa ser texto' })
      .min(1, 'rconPassword é obrigatória: sem ela o agente não tem como falar com o servidor')
      .max(200, 'rconPassword não pode passar de 200 caracteres')
      .refine(
        (value) => !FORBIDDEN_RCON_PASSWORD_CHARS.test(value),
        'rconPassword não pode conter "/", "\\", "?", "#" nem espaços: o WebRCON transporta ' +
          'a senha no caminho da URL e esses caracteres a corrompem',
      ),

    /** Ausente = o primeiro bloco livre. Ver `suggestPortBlock`. */
    portBlock: z
      .number({ invalid_type_error: 'portBlock precisa ser número (não string)' })
      .int('portBlock precisa ser inteiro')
      .min(0, 'portBlock não pode ser negativo')
      .max(MAX_PORT_BLOCK, `portBlock não pode passar de ${String(MAX_PORT_BLOCK)}`)
      .optional(),
  })
  .strict();

export type CreateServerBody = z.infer<typeof createServerBodySchema>;

/**
 * O recorte da tabela `servers` que a criação usa.
 *
 * `ServersRepository` a satisfaz por estrutura, sem adaptador. O
 * tipo é declarado assim para deixar explícito o que esta operação
 * lê (as portas de quem já existe) e o que ela escreve (uma linha).
 */
export interface ServerRegistrationStore {
  /** Todos os cadastrados. Só id e portas são lidos daqui. */
  list(): readonly ServerRecord[];
  /** `null` = o id está livre. */
  get(id: string): ServerRecord | null;
  create(input: ServerInput, now?: number): ServerRecord;
}

/**
 * Erro de regra da criação, com `code` e `status` já escolhidos.
 *
 * Mesmo desenho do `MapPoolError`: a mensagem nasce aqui, em
 * português e dizendo o que fazer, e a rota só a repassa. Quem
 * decide o texto é quem conhece a regra.
 */
export class CreateServerError extends Error {
  readonly code: string;
  readonly status: number;
  /** Só no conflito de portas: quem segura o quê. */
  readonly conflicts: readonly PortConflict[];

  constructor(
    code: string,
    message: string,
    status: number,
    conflicts: readonly PortConflict[] = [],
  ) {
    super(message);
    this.name = 'CreateServerError';
    this.code = code;
    this.status = status;
    this.conflicts = conflicts;
  }
}

export function isCreateServerError(error: unknown): error is CreateServerError {
  return error instanceof CreateServerError;
}

/** O servidor recém-cadastrado, do jeito que a rota o devolve. */
export interface CreatedServer {
  readonly id: string;
  readonly name: string;
  readonly identity: string;
  /** Sempre `false`. Ver o cabeçalho deste arquivo. */
  readonly enabled: boolean;
  readonly gamePort: number;
  readonly rconPort: number;
  readonly queryPort: number;
  readonly appPort: number;
  /** Onde o SteamCMD vai instalar o jogo. */
  readonly installDir: string;
  /** O `.ini` que acabou de ser escrito. */
  readonly configPath: string;
  /** Qual bloco da grade ficou com este servidor. */
  readonly portBlockIndex: number;
}

export interface CreateServerOptions {
  /** A raiz do projeto: onde ficam `Configs\`, `Servers\` e os `.bat`. */
  readonly projectRoot: string;
  readonly store: ServerRegistrationStore;
  readonly input: CreateServerBody;
}

/** `Configs\<id>.ini`. */
export function serverConfigPath(projectRoot: string, id: string): string {
  return join(projectRoot, 'Configs', `${id}.ini`);
}

/**
 * Onde o SteamCMD instala este servidor: `Servers\<id>\`.
 *
 * Uma pasta por servidor, sempre — é o `+force_install_dir` da
 * instalação, e é o que faz um servidor não pisar no outro.
 */
export function serverInstallDir(projectRoot: string, id: string): string {
  return join(projectRoot, 'Servers', id);
}

/**
 * O bloco de portas que este servidor deveria receber.
 *
 * Separado de `createServer` porque `GET /api/servers` o mostra
 * ANTES de qualquer criação: o formulário pré-visualiza as quatro
 * portas enquanto a pessoa ainda está digitando o nome.
 *
 * `null` quando a grade inteira acabou — 375 blocos, o que na
 * prática só acontece se alguém cadastrar servidores num laço.
 */
export function suggestedPortBlockFor(store: ServerRegistrationStore): PortBlock | null {
  try {
    return suggestPortBlock(store.list());
  } catch {
    // `suggestPortBlock` lança RangeError quando não sobrou bloco.
    // Aqui isso não é erro: é "não tenho o que sugerir", e a tela
    // continua funcionando com o campo em branco.
    return null;
  }
}

/**
 * Cadastra o servidor: escreve o `.ini` e insere a linha.
 *
 * @throws {CreateServerError} em toda recusa prevista — id em uso,
 * `.ini` já em disco, portas em conflito, modelo ausente. Nenhuma
 * delas deixa rastro: as validações acontecem TODAS antes da
 * primeira escrita, e a falha da inserção apaga o arquivo.
 */
export function createServer(options: CreateServerOptions): CreatedServer {
  const { projectRoot, store, input } = options;

  const id = input.id;
  const identity = input.identity ?? id;
  const configPath = serverConfigPath(projectRoot, id);

  // ---- 1. as validações, antes de qualquer escrita --------
  if (store.get(id) !== null) {
    throw new CreateServerError(
      'SERVER_ID_TAKEN',
      `Já existe um servidor com o id "${id}" neste agente. Escolha outro id — ` +
        'ele nomeia o arquivo de configuração, as pastas e todo o histórico daquele ' +
        'servidor, e por isso não se repete.',
      409,
    );
  }

  // O arquivo é conferido à parte da tabela de propósito: quem
  // criou o `Configs\<id>.ini` na mão ainda não tem linha nenhuma —
  // ela só nasce no próximo boot do agente. Sobrescrever esse
  // arquivo apagaria a senha de RCON de um servidor que já existe.
  if (existsSync(configPath)) {
    throw new CreateServerError(
      'SERVER_CONFIG_EXISTS',
      `Já existe o arquivo Configs\\${id}.ini nesta máquina, mesmo sem cadastro no ` +
        'banco. Escolha outro id, ou apague o arquivo à mão se ele for sobra de uma ' +
        'configuração que ninguém usa.',
      409,
    );
  }

  const block = resolvePortBlock(store, input.portBlock);

  assertNoPortConflicts(store, id, block);

  // ---- 2. o arquivo --------------------------------------
  const template = readTemplate(projectRoot);

  const values: Record<string, string> = {
    // As duas, e são diferentes: `SERVER_NAME` é o rótulo do
    // seletor do painel e `SERVER_HOSTNAME` é o que o jogador lê
    // na lista do jogo. Gravar só o segundo era o defeito — o nome
    // digitado no formulário vivia até o primeiro restart e depois
    // virava o hostname, porque `reconcileServersTable` relê o
    // `.ini`. Ver `SERVER_NAME` em config.ts.
    SERVER_NAME: input.name,
    SERVER_HOSTNAME: input.hostname,
    SERVER_IDENTITY: identity,
    SERVER_LEVEL: input.map,
    SERVER_WORLDSIZE: String(input.worldSize),
    SERVER_MAXPLAYERS: String(input.maxPlayers),
    // O ponto do recorte inteiro: o agente ignora este servidor até
    // alguém instalar o jogo e ligar a chave.
    SERVER_ENABLED: '0',
    SERVER_PORT: String(block.gamePort),
    SERVER_QUERYPORT: String(block.queryPort),
    SERVER_APPPORT: String(block.appPort),
    RCON_PORT: String(block.rconPort),
    RCON_PASSWORD: input.rconPassword,
  };

  // Seed ausente mantém a do modelo, e não vira 0: `server.seed 0`
  // é um mundo válido e específico, e um campo em branco no
  // formulário não é um pedido para jogá-lo.
  if (input.seed !== undefined) {
    values.SERVER_SEED = String(input.seed);
  }

  writeConfigFile(configPath, id, renderServerIni(template, id, values));

  // ---- 3. a linha, e o desfazer -------------------------
  //
  // Daqui para baixo já existe arquivo em disco. Toda saída que
  // não for sucesso precisa apagá-lo.
  try {
    store.create({
      id,
      name: input.name,
      identity,
      gamePort: block.gamePort,
      rconPort: block.rconPort,
      queryPort: block.queryPort,
      appPort: block.appPort,
      installDir: serverInstallDir(projectRoot, id),
      enabled: false,
      // A senha NÃO é gravada no banco: ela mora no `.ini`, e o
      // runtime a lê de lá. Copiá-la para cá criaria uma segunda
      // cópia do segredo, num arquivo que vai junto em todo backup
      // (ver o cabeçalho de db/servers-repository.ts).
    });
  } catch (error) {
    throw new CreateServerError(
      'SERVER_REGISTRATION_FAILED',
      `Não consegui cadastrar o servidor "${id}" no banco: ${toError(error).message}. ` +
        'As quatro portas e a identity são únicas na tabela `servers` — o valor que ' +
        'faltou está preso na linha de outro servidor. ' +
        rollbackConfigFile(configPath, id),
      409,
    );
  }

  return {
    id,
    name: input.name,
    identity,
    enabled: false,
    gamePort: block.gamePort,
    rconPort: block.rconPort,
    queryPort: block.queryPort,
    appPort: block.appPort,
    installDir: serverInstallDir(projectRoot, id),
    configPath,
    portBlockIndex: block.index,
  };
}

/**
 * O bloco pedido, ou o primeiro livre.
 *
 * @throws {CreateServerError} quando a grade acabou.
 */
function resolvePortBlock(
  store: ServerRegistrationStore,
  requested: number | undefined,
): PortBlock {
  if (requested !== undefined) {
    // A faixa já foi validada pelo schema; `portBlock` continua
    // sendo quem calcula as quatro portas.
    return portBlock(requested);
  }

  const suggested = suggestedPortBlockFor(store);

  if (suggested === null) {
    throw new CreateServerError(
      'NO_FREE_PORT_BLOCK',
      `Não há bloco de portas livre: os ${String(MAX_PORT_BLOCK + 1)} blocos da grade ` +
        'já estão ocupados. Apague um servidor que não existe mais para devolver o ' +
        'bloco dele à fila.',
      409,
    );
  }

  return suggested;
}

/**
 * As quatro portas deste bloco já são de alguém?
 *
 * A pergunta é feita ao CADASTRO, e não ao sistema operacional: o
 * servidor está nascendo desligado e não vai abrir porta nenhuma
 * hoje. Quem confere o SO é o `assertServerPortsAvailable`, na hora
 * de subir.
 *
 * Só interessam os conflitos que envolvem o servidor NOVO. Duas
 * linhas antigas que já colidam entre si são um problema de quem as
 * cadastrou, e recusar uma criação sem relação com elas trancaria o
 * painel por causa de um estrago que ele não fez.
 *
 * @throws {CreateServerError}
 */
function assertNoPortConflicts(
  store: ServerRegistrationStore,
  id: string,
  block: PortBlock,
): void {
  const candidate = {
    id,
    gamePort: block.gamePort,
    rconPort: block.rconPort,
    queryPort: block.queryPort,
    appPort: block.appPort,
  };

  const conflicts = validateNoConflicts([...store.list(), candidate]).filter((conflict) =>
    conflict.holders.some((holder) => holder.serverId === id),
  );

  if (conflicts.length === 0) {
    return;
  }

  throw new CreateServerError(
    'PORT_BLOCK_TAKEN',
    `O bloco de portas ${String(block.index)} não está livre:\n` +
      `${conflicts.map((conflict) => `  - ${conflict.message}`).join('\n')}\n` +
      'Escolha outro bloco, ou deixe o campo em branco para receber o primeiro livre.',
    409,
    conflicts,
  );
}

/**
 * Lê `Configs\server.example.ini`.
 *
 * @throws {CreateServerError} 500: sem o modelo não há como gerar
 * um `.ini` completo, e gerar um incompleto seria entregar um
 * servidor que o `UpdateServer.bat` não consegue instalar.
 */
function readTemplate(projectRoot: string): string {
  const templatePath = join(projectRoot, 'Configs', SERVER_INI_TEMPLATE_FILE);

  try {
    return readFileSync(templatePath, 'utf8');
  } catch (error) {
    throw new CreateServerError(
      'SERVER_TEMPLATE_MISSING',
      `Não consegui ler o modelo ${templatePath}: ${toError(error).message}. ` +
        'Ele é versionado no git, em Configs\\ — restaure-o antes de criar servidores.',
      500,
    );
  }
}

/**
 * Escreve o `.ini`, e recusa sobrescrever.
 *
 * `flag: 'wx'` é a mesma checagem do `existsSync` lá em cima, feita
 * agora pelo sistema de arquivos: entre uma coisa e outra cabe um
 * segundo clique, e o custo de perder essa corrida seria apagar a
 * senha de RCON de um servidor que já existia.
 *
 * @throws {CreateServerError}
 */
function writeConfigFile(configPath: string, id: string, content: string): void {
  try {
    writeFileSync(configPath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CreateServerError(
        'SERVER_CONFIG_EXISTS',
        `Já existe o arquivo Configs\\${id}.ini nesta máquina. Escolha outro id.`,
        409,
      );
    }

    throw new CreateServerError(
      'SERVER_CONFIG_WRITE_FAILED',
      `Não consegui escrever ${configPath}: ${toError(error).message}. ` +
        'Confira se a pasta Configs\\ existe e se o agente tem permissão de escrita nela.',
      500,
    );
  }
}

/**
 * Apaga o `.ini` que a criação acabou de escrever.
 *
 * Devolve o trecho de mensagem que descreve o que aconteceu: o
 * caminho feliz é "nada ficou para trás, pode tentar de novo", e o
 * infeliz precisa dizer em voz alta qual arquivo sobrou — senão a
 * próxima tentativa esbarra num 409 que ninguém entende.
 */
function rollbackConfigFile(configPath: string, id: string): string {
  try {
    unlinkSync(configPath);
    return `O arquivo Configs\\${id}.ini foi desfeito — nada ficou pela metade.`;
  } catch (error) {
    return (
      `ATENÇÃO: o arquivo ${configPath} foi criado e eu NÃO consegui apagá-lo ` +
      `(${toError(error).message}). Apague-o à mão antes de tentar de novo.`
    );
  }
}

/** O cabeçalho que o arquivo gerado ganha, acima do modelo. */
function generatedHeader(id: string): readonly string[] {
  // ASCII puro, como o resto do modelo: estes arquivos são lidos
  // pelo `for /f` do cmd.exe, que os interpreta na codepage do
  // console — acento aqui vira ruído no console de quem instala.
  return [
    '; ============================================================',
    `;  ${id}.ini  -  criado pelo painel (POST /api/servers).`,
    ';',
    ';  ####  ESTE SERVIDOR AINDA NAO ESTA INSTALADO  ####',
    ';',
    ';  SERVER_ENABLED=0 mantem o RustAgent longe dele: sem os',
    ';  arquivos do jogo em disco, o agente so ficaria tentando',
    ';  reconectar num RCON que nunca vai responder.',
    ';',
    ';  Para colocar este servidor no ar, nesta ordem:',
    ';',
    ';      1. Instalar, no painel (aba Operacoes)',
    ';         o SteamCMD baixa o jogo - sao dezenas de GB',
    ';      2. ligue-o no painel, em Servidores',
    ';         (ou PATCH /api/servers/' + id + ' {"enabled":true})',
    ';         o agente passa a cuidar dele na hora e grava',
    ';         SERVER_ENABLED=1 aqui neste arquivo',
    ';      3. Iniciar, no painel',
    ';',
    ';  O resto do arquivo veio de Configs\\server.example.ini, que',
    ';  documenta cada chave.',
    '; ============================================================',
    '',
  ];
}

/**
 * O modelo com os valores desta criação no lugar, sob o cabeçalho
 * que diz que o servidor ainda não está instalado.
 *
 * A substituição é do `applyIniValues` logo abaixo — e é lá que
 * estão os cuidados que ela toma. O que esta função acrescenta é
 * só o cabeçalho gerado.
 */
export function renderServerIni(
  template: string,
  id: string,
  values: Readonly<Record<string, string>>,
): string {
  const eol = template.includes('\r\n') ? '\r\n' : '\n';

  return [...generatedHeader(id), ...applyIniValues(template, values).split(eol)].join(eol);
}

/**
 * Troca chaves de um `.ini` NO LUGAR, sem tocar em mais nada.
 *
 * É o miolo do `renderServerIni` acima, separado porque a criação
 * não é o único momento em que uma chave muda: ligar e desligar um
 * servidor pelo painel reescreve `SERVER_ENABLED` num arquivo que
 * já existe, com a senha de RCON e os comentários de quem o
 * editou à mão dentro. Uma segunda implementação para isso seria
 * a que um dia esqueceria um dos três cuidados abaixo.
 *
 *   - linha de COMENTÁRIO nunca é tocada. O modelo tem
 *     `;      SERVER_HOSTNAME=Meu Servidor` no cabeçalho, como
 *     exemplo de sintaxe, e reescrevê-lo estragaria a documentação
 *     sem mudar nada do servidor;
 *
 *   - TODAS as ocorrências de uma chave são substituídas. Os dois
 *     parsers (o `.bat` e o `parseServerIni`) ficam com a ÚLTIMA
 *     linha de uma chave repetida, então trocar só a primeira
 *     escreveria um valor que ninguém leria;
 *
 *   - chave que o arquivo não tem é ACRESCENTADA no fim. Sem isso,
 *     um `.ini` sem `SERVER_ENABLED` continuaria sem a chave
 *     depois de alguém pedir para desligar o servidor — e o boot
 *     seguinte o ligaria de novo, porque o padrão do schema é 1.
 *
 * A quebra de linha do ORIGINAL é preservada: estes arquivos são
 * lidos pelo `for /f` do cmd.exe, e trocar CRLF por LF é o tipo de
 * coisa que se descobre na marra.
 */
export function applyIniValues(
  content: string,
  values: Readonly<Record<string, string>>,
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const written = new Set<string>();

  const lines = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('[')) {
      return line;
    }

    const separator = trimmed.indexOf('=');

    if (separator <= 0) {
      return line;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = values[key];

    if (value === undefined) {
      return line;
    }

    written.add(key);
    return `${key}=${value}`;
  });

  const missing = Object.entries(values).filter(([key]) => !written.has(key));

  if (missing.length > 0) {
    lines.push(
      '',
      '; ------------------------------------------------------------',
      '; Chaves que o modelo nao trazia e que o painel precisou',
      '; gravar. Elas valem do mesmo jeito: a secao e decorativa e as',
      '; chaves do arquivo sao globais.',
      ...missing.map(([key, value]) => `${key}=${value}`),
      '',
    );
  }

  return lines.join(eol);
}
