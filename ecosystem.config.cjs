// ============================================================
//  ecosystem.config.cjs  -  configuracao do PM2
//
//  Este arquivo e .cjs de proposito: o package.json da raiz
//  declara "type": "module", entao um .js aqui seria tratado como
//  ESM e o "module.exports" abaixo quebraria. O PM2 le CommonJS.
//
//  Uso (a partir da raiz do projeto):
//      npm install
//      npm run build
//      pm2 start ecosystem.config.cjs
//      pm2 logs rustagent
//      pm2 save
// ============================================================

module.exports = {
  apps: [
    {
      name: 'rustagent',

      // ========================================================
      //  O PM2 sobe o AGENTE DIRETO.
      //
      //  Nao ha launcher, nao ha releases\ e nao ha current.json:
      //  atualizar e `git pull` + `npm run build` + `pm2 restart`
      //  (ver Docs\03-DECISOES.md, D2). O que aquela camada
      //  resolvia - trocar versao numa maquina sem terminal - nao
      //  e mais o nosso caso.
      // ========================================================
      script: 'core/dist/index.js',

      // cwd fixo na raiz: e a partir daqui que o config.ts acha o
      // .env, o Configs\, o Servers\ e o banco.
      cwd: __dirname,

      // ========================================================
      //  !!! NAO TROQUE PARA CLUSTER. NAO AUMENTE instances. !!!
      //
      //  Este servico e deliberadamente um processo unico:
      //
      //  1. Ele mantem UMA conexao WebRCON por servidor de Rust.
      //     Em cluster, cada worker abriria a sua. O servidor
      //     receberia N copias de cada comando e o agente veria N
      //     copias de cada linha de log.
      //
      //  2. O estado das operacoes vive em memoria: a trava do
      //     SteamCMD e o log ao vivo. Duas instancias disputariam
      //     o mesmo lock do Steam e deixariam a pasta de
      //     instalacao pela metade - com o painel mostrando 100%.
      //
      //  Escalar isto exige antes: estado externo e um unico dono
      //  de cada conexao RCON.
      // ========================================================
      exec_mode: 'fork',
      instances: 1,

      // Servico sempre-ligado: se cair, sobe de novo.
      autorestart: true,

      // ========================================================
      //  Saida 0 = desligamento PEDIDO. Nao reinicie.
      //
      //  Sem esta linha o "autorestart" acima traz o servico de
      //  volta em seguida, e o desligamento ordenado deixa de
      //  existir na pratica.
      //
      //  Vale so para o 0. Qualquer outro codigo continua sendo
      //  crash e continua reiniciando.
      // ========================================================
      stop_exit_codes: [0],

      // Sem watch em producao: um arquivo tocado por engano
      // derrubaria as conexoes RCON no meio de uma instalacao.
      watch: false,

      // Se o processo morrer 10x seguidas sem ficar de pe por pelo
      // menos min_uptime, o PM2 desiste e deixa parado em vez de
      // entrar em laco infinito de restart.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,

      // ========================================================
      //  ####  NO WINDOWS, SINAL NAO E SINAL  ####
      //
      //  `process.kill(pid, 'SIGINT')` no Windows nao entrega
      //  sinal nenhum: chama o TerminateProcess. O processo morre
      //  na hora e o handler de SIGINT/SIGTERM dele NAO roda.
      //
      //  Com `shutdown_with_message` o PM2 manda a string
      //  'shutdown' pelo canal de IPC. Isso funciona igual nos
      //  dois sistemas, e e o caminho que o proprio PM2 recomenda
      //  no Windows. O agente escuta process.on('message').
      // ========================================================
      shutdown_with_message: true,

      // Mata a ARVORE se o desligamento ordenado nao terminar a
      // tempo. Repare que os servidores de Rust NAO sao filhos do
      // agente (sobem destacados), entao isto nao os alcanca - e e
      // exatamente o que se quer.
      treekill: true,

      // ========================================================
      //  O orcamento precisa caber, nesta ordem:
      //
      //    15 s  o desligamento limpo do agente (fecha os RCON,
      //          para os relogios, fecha o banco)
      //    25 s  o PM2 desiste e mata
      //
      //  Se o PM2 desistir primeiro, ele mata justamente quem
      //  estava conduzindo o desligamento.
      // ========================================================
      kill_timeout: 25000,

      env: {
        NODE_ENV: 'production',
      },

      // Logs com timestamp, junto do servico.
      time: true,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
    },
  ],
};
