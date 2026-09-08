# Respostas gravadas

O que está aqui são **corpos de resposta de serviços de fora**, guardados em
arquivo para o teste poder exercitar o parser sem tocar na rede.

> **De onde eles vieram**
>
> Os arquivos `rustmaps-*.json` são **capturas da API real**, feitas em
> 07/09/2026 com uma chave em mãos contra `api.rustmaps.com`, e conferidas
> contra `api.rustmaps.com/swagger/v4-public/swagger.json`. Antes disso eles
> eram montados a partir de uma implementação de referência de terceiro — e a
> diferença entre as duas coisas custou um defeito, descrito abaixo.

## O que a captura desmentiu

A versão inventada destes arquivos punha o mapa inteiro — id, URLs, monumentos
— no corpo do `200` de `POST /v4/maps`. **A API nunca fez isso.** Aquele `200`
significa só *"esse mapa já existe"*, e o corpo é `{"meta":{…},"data":null}`;
quem tem as imagens é `GET /v4/maps/{size}/{seed}`.

Como o teste usava a fixture inventada, ele passava — e atestava, com toda a
confiança, um contrato que não existia. Na produção a fila mostrava *"pronta ·
sem prévia ainda"* e o cartão repetia *"o rustmaps.com respondeu 200 sem o id
do mapa"* a cada volta do relógio, para sempre.

A lição não é sobre o RustMaps: **uma fixture escrita de cabeça testa a nossa
imaginação.** Enquanto ninguém tiver a credencial para capturar a resposta de
verdade, o arquivo é uma hipótese — e o aviso de que ele é uma hipótese vale
mais do que o teste verde que ele produz.

## O que cada arquivo é

| Arquivo | A resposta de |
|---|---|
| `rustmaps-200-ready.json` | `GET /v4/maps/4000/2026680033?staging=false` — o retrato completo, com as URLs e 185 monumentos |
| `rustmaps-200-post-exists.json` | `POST /v4/maps` de um mapa que já existe — `data: null`, e nada mais |
| `rustmaps-200-limits.json` | `GET /v4/maps/limits` — a cota de geração (`concurrent`, `monthly`) |
| `rustmaps-404-missing.json` | `GET /v4/maps/{id}` de um id que não existe |
| `rustmaps-201-queued.json` | `POST /v4/maps` que entrou na fila do gerador |
| `rustmaps-409-exists.json` | existe, mas ainda está sendo gerado |
| `rustmaps-401-invalid-key.json` · `rustmaps-403-plan.json` · `rustmaps-429-throttled.json` | chave recusada, plano insuficiente, limite estourado |

Os três últimos e o `201`/`409` **ainda não foram capturados** — para gravá-los
seria preciso uma chave inválida, um plano sem cobertura e uma cota estourada
de propósito. Os códigos estão certos; os nomes dos campos dentro deles
continuam sendo a parte a conferir no dia em que alguém esbarrar num deles de
verdade.

## Para atualizar uma captura

Rode a chamada com a chave do `.env`, cole a resposta por cima do arquivo e
rode `npm test -w core`. Se o parser precisar mudar, é sinal de que o contrato
mudou — e o comentário do topo de `core/src/wipe/rustmaps.ts` precisa mudar
junto.

Um teste que fala com a internet falha no CI por um motivo que não é o dele — e
pior, passa a depender de um serviço de fora para dizer que o nosso código está
certo.
