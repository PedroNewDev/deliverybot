# DeliveryBot: pedidos de restaurante

Tema 09. Alunos: Pedro de Farias, Erivelton Somasnki, Diulio Less.

Sistema para o restaurante registrar pedidos de delivery sem confirmar um a um
na mão. O atendente monta o pedido, o sistema valida o endereço pelo CEP,
calcula o tempo estimado, coloca o pedido na fila da cozinha e o bot manda as
mensagens para o cliente (confirmação, tempo estimado e "saiu para entrega").

## Como rodar

Precisa do Node.js 22.13 ou mais novo (o banco usa o SQLite que já vem no Node).

```bash
npm install
npm start
```

- Painel do restaurante: http://localhost:3000
- Área do cliente (pedido pelo celular): http://localhost:3000/pedir

O arquivo `deliverybot.db` é criado sozinho na primeira execução, já com um
cardápio de exemplo. Para zerar tudo, pare o servidor e apague esse arquivo.

## Área do cliente (`/pedir`)

Feita primeiro para o celular.

- **Cardápio com fotos.** Tocar no prato abre o detalhe (foto grande, tempo de
  preparo, quantidade); o **+** adiciona direto. "Mais pedidos" usa a soma real
  de `itens_pedido`. O topo mostra a previsão de entrega calculada com a fila
  atual da cozinha.
- **Pedir de novo:** depois de um pedido entregue, um toque repete os itens.
- **Finalizar:** o ViaCEP valida o CEP na hora e a barra de baixo já mostra o
  horário previsto de chegada.
- **Acompanhar** (`/pedir#pedido-12`, atualiza a cada 5 s): contagem regressiva,
  posição na fila, barra de preparo e, quando sai para entrega, o trajeto com o
  entregador andando até a casa do cliente (posição estimada pelo tempo desde a
  saída e o tempo de trajeto da cidade; não é GPS). Em Porto União a rota mostra
  a ponte da divisa PR/SC. A cada mudança de etapa aparece um aviso e o celular
  vibra.

Fotos dos pratos: Wikimedia Commons, com autores e licenças em `/creditos.html`.

O pedido do cliente entra no mesmo fluxo do balcão: vai para a fila da cozinha
e aparece em Pedidos no painel. A sacola, os dados de entrega e o último pedido
ficam guardados no próprio celular (localStorage), então o cliente não digita
o endereço de novo no próximo pedido.

## Painel do restaurante

| Tela | Para quê |
|---|---|
| Novo pedido | Cardápio + comanda. Telefone de cliente antigo preenche o endereço. O CEP é consultado no ViaCEP na hora. |
| Pedidos | Andamento de cada pedido. Quando a cozinha termina, aparece o botão "Saiu para entrega" e depois "Marcar como entregue". |
| Cozinha | Fila de preparo, do mais antigo para o mais novo. Pode ficar aberta numa TV em `/#cozinha` (atualiza a cada 5 s). |
| Mensagens | Conversa de cada cliente com o que o bot enviou. |
| Cardápio | Cadastro, edição, exclusão e disponibilidade dos produtos. |

As mensagens são simuladas: ficam gravadas na tabela `mensagens` e aparecem na
tela. Para enviar de verdade bastaria trocar a função `registrarMensagem` do
`server.js` por uma chamada à API do WhatsApp ou de SMS.

## Banco de dados

Estrutura completa em [`schema.sql`](schema.sql).

- `clientes`: nome, telefone (único) e último endereço usado
- `produtos`: o cardápio (preço, categoria, tempo de preparo, disponível, foto)
- `pedidos`: cliente, endereço de entrega, total, status e previsão de entrega
- `itens_pedido`: produtos de cada pedido, com o preço da hora da compra
- `fila_preparo`: posição do pedido na cozinha (aguardando, preparando, pronto)
- `mensagens`: tudo o que o bot enviou ao cliente

Status do pedido: `recebido` → `em_preparo` → `pronto` → `saiu_entrega` → `entregue`.

## Segunda API: ViaCEP

`GET https://viacep.com.br/ws/{cep}/json/` é chamado pelo servidor em dois
momentos: quando o atendente digita o CEP (para preencher rua e bairro) e de
novo ao salvar o pedido, para ninguém burlar a validação pelo navegador.

A área de entrega fica no topo do `server.js`:

| Cidade | Trajeto |
|---|---|
| União da Vitória/PR | 20 min |
| Porto União/SC | 30 min |

CEP de outra cidade é recusado. CEPs para testar: `84600-025` (União da
Vitória, com rua), `89400-000` (Porto União, CEP geral, a rua é digitada) e
`01001-000` (São Paulo, fora da área).

## Tempo estimado

```
tempo = item mais demorado do pedido
      + 5 min por pedido que já está na cozinha
      + trajeto até a cidade do cliente
```

## API própria

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/produtos` | Lista o cardápio |
| POST | `/api/produtos` | Cadastra produto |
| PUT | `/api/produtos/:id` | Edita produto |
| DELETE | `/api/produtos/:id` | Exclui (só se nunca foi pedido) |
| GET | `/api/cep/:cep` | Consulta o ViaCEP e diz se entrega |
| GET | `/api/clientes?telefone=` | Busca cliente pelo telefone |
| GET | `/api/pedidos` | Lista pedidos com itens |
| GET | `/api/pedidos/:id` | Um pedido com itens, mensagens, horário de cada etapa e posição na fila |
| GET | `/api/situacao` | Pedidos na cozinha agora e área de entrega (estimativa no topo) |
| POST | `/api/pedidos` | Cria pedido, entra na fila e envia confirmação + tempo |
| PATCH | `/api/pedidos/:id/status` | `saiu_entrega` (envia aviso) ou `entregue` |
| GET | `/api/fila` | Fila de preparo da cozinha |
| POST | `/api/fila/:id/iniciar` | Cozinha começa o preparo |
| POST | `/api/fila/:id/concluir` | Cozinha termina, pedido fica pronto |
| GET | `/api/conversas` | Clientes com mensagens |
| GET | `/api/conversas/:clienteId` | Mensagens de um cliente |

## Arquivos

```
server.js        API (Express) e regras de negócio
db.js            conexão com o SQLite e cardápio inicial
schema.sql       tabelas
public/          painel do restaurante (index.html, style.css, app.js)
                 área do cliente (pedir.html, pedir.css, pedir.js)
```
