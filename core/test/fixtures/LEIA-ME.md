# Respostas gravadas

O que está aqui são **corpos de resposta de serviços de fora**, guardados em
arquivo para o teste poder exercitar o parser sem tocar na rede.

> **De onde eles vieram, e o que isso significa**
>
> Os arquivos `rustmaps-*.json` foram montados a partir do contrato descrito na
> implementação de referência da API v4
> (`RustServerManager/RustMaps-API`) e das fontes reunidas em
> `Docs\16-PLANO-WIPE-CALENDARIO-MENSAGENS.md` — **não** de uma captura feita
> com uma chave em mãos: `api.rustmaps.com/docs` responde `403` sem chave.
>
> Na prática isso quer dizer: os **códigos** (200, 201, 409, 401, 403, 429) são
> a parte confiável, e os **nomes dos campos** são a parte a conferir no dia em
> que a chave existir. É por isso que `core/src/wipe/rustmaps.ts` lê cada campo
> por mais de um nome e devolve `null` no que não vier, em vez de estourar.
>
> Quando alguém tiver a chave: rode uma chamada de verdade, cole a resposta
> aqui por cima e rode `npm test -w core`. Se o parser precisar mudar, é sinal
> de que este aviso fez o seu trabalho.

Um teste que fala com a internet falha no CI por um motivo que não é o dele — e
pior, passa a depender de um serviço de fora para dizer que o nosso código está
certo.
