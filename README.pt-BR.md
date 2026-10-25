# HTTP Fixture Lab

Servidor pequeno de respostas HTTP fixas ou sequências determinísticas para testes de integração, demonstrações de clientes e testes de falha. Declare as respostas em JSON, inicie na interface local com uma porta disponível, configure seu cliente com a URL retornada e encerre ao terminar. Requer Node.js 20 ou superior; não tem dependências de execução ou desenvolvimento.

[English](README.md) · [Licença MIT](LICENSE)

## Exemplo útil

```sh
node cli.js examples/payments.json
# http://127.0.0.1:49152 (a porta real varia)
node cli.js examples/payments.json --port 8087
node cli.js --help
node --test
```

O exemplo de pagamentos é inteiramente sintético: inclui `/health`, consulta de pagamento, criação, exclusão e falha persistente `503` com `Retry-After`. Aponte a URL base do cliente para o endereço impresso. `/payments/demo-001` permite testar a leitura de JSON; `/payments/unavailable` permite testar uma falha persistente. Nenhum identificador representa dados reais.

O CLI imprime a URL depois de abrir a porta e permanece ativo até `SIGINT` ou `SIGTERM`. Arquivos, configurações, argumentos ou portas inválidos geram uma mensagem genérica no stderr e código de saída `2`. Apenas o arquivo regular UTF-8 JSON explicitamente indicado é lido, com limite de 1 MiB. Nomes de membros repetidos seguem `JSON.parse`: **a última ocorrência prevalece**; não há detecção de duplicatas no texto JSON.

## Repetir uma tentativa após falha temporária

```sh
node examples/retry.mjs
# attempt 1: 503
# attempt 2: 200
# attempt 3: 200
```

O cliente sintético executável inicia uma fixture na interface local, consome as respostas `503 → 200 → 200` e encerra o servidor. Para usar seu próprio cliente, execute `node cli.js examples/retry.json` e solicite `/orders/demo-retry` na URL impressa. `Retry-After: 0` torna o exemplo imediato. Cada novo servidor começa na primeira resposta.

A rota JSON é declarativa:

```json
{
  "method": "GET",
  "path": "/orders/demo-retry",
  "responses": [
    { "status": 503, "body": "tente novamente\n", "headers": { "Retry-After": "0" } },
    { "status": 200, "body": "pronto\n" }
  ]
}
```

## Biblioteca

```js
import { startFixtureServer, validateFixture } from './index.js';

const fixture = { routes: [
  { method: 'GET', path: '/health', status: 200, body: 'pronto\n' },
  { method: 'HEAD', path: '/health', status: 200, body: 'pronto\n' },
] };

const snapshot = validateFixture(fixture); // cópia independente e congelada
const servidor = await startFixtureServer(snapshot, { port: 0 });
try {
  const resposta = await fetch(`${servidor.url}/health`);
  console.log(await resposta.text());
} finally {
  await servidor.close();
}
```

`validateFixture(document)` retorna uma cópia independente, congelada em todos os níveis. `startFixtureServer(document, { port = 0 } = {})` valida e copia os dados, retornando `{ url, close }`. `close()` retorna uma promessa idempotente e encerra conexões abertas, inclusive requisições incompletas. A biblioteca não instala manipuladores de sinais no processo. A única opção é `port`, inteiro entre `0` e `65535`; a interface é sempre `127.0.0.1`.

## Contrato

A raiz contém apenas `routes`, um array denso com no máximo 1.000 rotas. A lista pode ser vazia. Cada rota usa exatamente um de dois formatos:

- Fixa: `method`, `path`, `status`, `body` e, opcionalmente, `headers`.
- Sequência: `method`, `path` e `responses`, um array denso de 1 a 100 objetos de resposta. Cada resposta contém exatamente `status`, `body` e, opcionalmente, `headers`, com as mesmas regras de uma rota fixa. Os formatos não podem ser misturados; uma rota de sequência não aceita `status`, `body` ou `headers` no nível da rota.

| Campo | Regras |
| --- | --- |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` ou `OPTIONS`, em maiúsculas. |
| `path` | ASCII visível, começa com `/`, nunca `//`; sem espaços, controles, query ou fragmento. Cada `%` precisa de dois dígitos hexadecimais. |
| `status` | Inteiro de `200` a `599`. |
| `body` | String Unicode válida, no máximo 65.536 bytes em UTF-8; vazia para `204` e `304`. |
| `headers` | Objeto simples com nomes HTTP válidos e valores string. Nomes repetidos sem distinguir maiúsculas são rejeitados. Valores aceitam TAB, espaço/bytes ASCII visíveis e Latin-1 `U+00A0`–`U+00FF`, sem outros controles. |

O método e o caminho codificado precisam corresponder exatamente. `/a%2Fb`, `/a%2fb` e `/a/b` são diferentes. A query é ignorada. Não há curingas, decodificação de caminho, seleção pelo corpo, respostas calculadas ou conversão automática de GET para HEAD. Declare HEAD explicitamente: seu `Content-Length` corresponde aos bytes UTF-8 da resposta selecionada, mas nenhum corpo é enviado.

Cada servidor mantém uma posição independente para cada método e caminho codificado exatos. Uma requisição válida com rota correspondente consome a próxima resposta somente após a leitura completa de seu corpo; a última resposta se repete indefinidamente. Requisições rejeitadas (inclusive framing ou caminhos malformados, Host incorreto, métodos não suportados e corpos excessivos ou incompletos) e rotas desconhecidas não avançam a sequência. `HEAD` consome apenas sua sequência declarada explicitamente. Respostas fixas sempre se repetem.

Com clientes concorrentes, a seleção segue a ordem em que termina a leitura dos corpos aceitos, **não a criação das conexões nem a chegada dos cabeçalhos**. Uma conexão posterior cujo corpo termina primeiro pode receber a resposta anterior da sequência. Não dependa de uma ordem entre clientes que terminam juntos. As posições não modificam os dados de entrada nem a cópia congelada. Servidores criados a partir da mesma cópia são independentes, e iniciar um novo servidor reinicia todas as sequências. Não há API de reset, ciclos de repetição nem novas opções de sequência.

São aceitos `Content-Type`, `Location`, cabeçalhos personalizados e `Retry-After`. Cabeçalhos de transporte/hop-by-hop são rejeitados: `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding` e `Upgrade`. Também não é permitido definir `Content-Length`: o servidor gera um único campo canônico com o tamanho correto, inclusive zero para `204` e `304`. O tipo padrão é `text/plain; charset=utf-8`.

A configuração deve conter **dados JSON passivos**: objetos simples ou com protótipo nulo, arrays normais densos e valores primitivos JSON. Funções, getters/setters, proxies (inclusive revogados), protótipos personalizados, símbolos, propriedades não enumeráveis, lacunas/extras em arrays e ciclos são rejeitados. A inspeção verifica descritores e rejeita proxies antes de inspecioná-los, sem executar getters ou traps. O mesmo limite global de profundidade (12), orçamento de percurso (20.000 valores) e limite por contêiner (1.000 entradas) vale para toda a configuração, incluindo cada resposta das sequências. O limite de 100 respostas é por rota e não aumenta esses orçamentos globais. Cada corpo de resposta mantém o limite de 65.536 bytes. Os dados do chamador não são alterados nem congelados. Toda configuração inválida lança `FixtureError` com a mensagem fixa `Invalid fixture configuration.` A interface é de dados estritos, **não uma sandbox para JavaScript arbitrário**, e pressupõe os recursos nativos do Node sem alterações.

## Comportamento HTTP e limites

- Aceita exatamente um `Host`: `localhost:PORTA_REAL` ou `127.0.0.1:PORTA_REAL`. Outros recebem `421` com texto fixo. Não atende IPv6 nem outras interfaces.
- Rota desconhecida recebe `404`; caminho inválido, `400`; método não suportado, `405`. Rejeita Upgrade, CONNECT e Expect.
- A resposta normal só é enviada após ler e descartar o corpo da requisição. Mais de 65.536 bytes gera `413`, com `Content-Length` ou transferência chunked. O corpo recebido nunca é refletido na resposta.
- Cabeçalhos e corpo têm prazo de até cinco segundos. Limita 64 conexões, 16 KiB / 100 campos de cabeçalho e 100 requisições por conexão. O prazo ocioso de keep-alive é um segundo. Encerrar destrói conexões abertas.
- Não grava tráfego, registra requisições, faz chamadas externas, avalia expressões, expande templates, atua como proxy ou carrega arquivos de resposta. `{{nome}}` é texto literal.

É uma ferramenta de desenvolvimento. Interface local e validação de Host reduzem exposição acidental, mas não substituem autenticação de produção. Processos locais que alcançam a porta podem solicitar os dados configurados. O parsing HTTP/1 é feito pelo módulo nativo do Node. Não coloque segredos nas fixtures.

## Desenvolvimento

Execute `node --test` com Node 20+. Os testes usam HTTP real na interface local e verificam UTF-8, HEAD, limites, chunked, Host, dados passivos, validação de sequências, progressão de tentativas, posições independentes, ordem de conclusão entre clientes concorrentes, requisições rejeitadas, encerramento, o exemplo executável de tentativas, sinais e erros do CLI. O CI cobre Node 20, 22 e 24 com permissão de leitura. Não há downloads de pacotes ou chamadas a serviços externos. O [README em inglês](README.md#development) inclui um comando Bubblewrap para executar com fontes somente leitura, home vazio, ambiente limpo e rede externa isolada.
