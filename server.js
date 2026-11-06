const express = require('express');
const path = require('node:path');
const db = require('./db');

const PORTA = process.env.PORT || 3000;

// Cidades atendidas e tempo médio do trajeto do entregador (minutos)
const AREA_ENTREGA = [
  { cidade: 'União da Vitória', uf: 'PR', trajeto: 20 },
  { cidade: 'Porto União', uf: 'SC', trajeto: 30 },
];
// Cada pedido que já está na cozinha soma este tempo ao novo pedido
const MINUTOS_POR_PEDIDO_NA_FRENTE = 5;

const app = express();
app.use(express.json());
// extensions: '/pedir' abre public/pedir.html (área do cliente)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const texto = (v) => String(v ?? '').trim();
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hora = (iso) =>
  new Date(iso)
    .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
    .replace(':', 'h');

function transacao(fn) {
  db.exec('BEGIN');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}

function registrarMensagem(pedidoId, clienteId, tipo, conteudo) {
  db.prepare('INSERT INTO mensagens (pedido_id, cliente_id, tipo, texto) VALUES (?, ?, ?, ?)')
    .run(pedidoId, clienteId, tipo, conteudo);
}

// ---------------------------------------------------------------------------
// Segunda API: ViaCEP. Confirma o endereço e se a cidade está na área de entrega.
// ---------------------------------------------------------------------------
async function consultarCep(valor) {
  const cep = soDigitos(valor);
  if (cep.length !== 8) throw new ErroHttp(400, 'O CEP precisa ter 8 dígitos.');

  let dados;
  try {
    const resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) });
    dados = await resposta.json();
  } catch {
    throw new ErroHttp(502, 'O ViaCEP não respondeu. Tente de novo em alguns segundos.');
  }
  if (dados.erro) throw new ErroHttp(404, 'CEP não encontrado.');

  const area = AREA_ENTREGA.find((a) => a.cidade === dados.localidade && a.uf === dados.uf);
  return {
    cep: dados.cep,
    logradouro: dados.logradouro,
    bairro: dados.bairro,
    cidade: dados.localidade,
    uf: dados.uf,
    atende: Boolean(area),
    trajeto: area ? area.trajeto : null,
    cidades_atendidas: AREA_ENTREGA.map((a) => `${a.cidade}/${a.uf}`),
  };
}

app.get('/api/cep/:cep', async (req, res) => {
  res.json(await consultarCep(req.params.cep));
});

// ---------------------------------------------------------------------------
// Produtos (cadastro do cardápio)
// ---------------------------------------------------------------------------
function lerProduto(body = {}) {
  const produto = {
    nome: texto(body.nome),
    descricao: texto(body.descricao),
    categoria: texto(body.categoria),
    preco: Number(body.preco),
    tempo_preparo: Number(body.tempo_preparo),
    disponivel: body.disponivel === false ? 0 : 1,
    foto: texto(body.foto),
  };
  if (!produto.nome) throw new ErroHttp(400, 'Informe o nome do produto.');
  if (!produto.categoria) throw new ErroHttp(400, 'Informe a categoria do produto.');
  if (!Number.isFinite(produto.preco) || produto.preco < 0) throw new ErroHttp(400, 'Preço inválido.');
  if (!Number.isInteger(produto.tempo_preparo) || produto.tempo_preparo < 0) {
    throw new ErroHttp(400, 'O tempo de preparo deve ser um número inteiro de minutos.');
  }
  return produto;
}

const buscarProduto = (id) => db.prepare('SELECT * FROM produtos WHERE id = ?').get(id);

// vendidos = quantidade total já pedida (usado em "Mais pedidos" na área do cliente)
app.get('/api/produtos', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, COALESCE((SELECT SUM(quantidade) FROM itens_pedido WHERE produto_id = p.id), 0) AS vendidos
    FROM produtos p ORDER BY p.id`).all());
});

app.post('/api/produtos', (req, res) => {
  const p = lerProduto(req.body);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO produtos (nome, descricao, categoria, preco, tempo_preparo, disponivel, foto) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.nome, p.descricao, p.categoria, p.preco, p.tempo_preparo, p.disponivel, p.foto);
  res.status(201).json(buscarProduto(lastInsertRowid));
});

app.put('/api/produtos/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = lerProduto(req.body);
  const { changes } = db
    .prepare('UPDATE produtos SET nome = ?, descricao = ?, categoria = ?, preco = ?, tempo_preparo = ?, disponivel = ?, foto = ? WHERE id = ?')
    .run(p.nome, p.descricao, p.categoria, p.preco, p.tempo_preparo, p.disponivel, p.foto, id);
  if (!changes) throw new ErroHttp(404, 'Produto não encontrado.');
  res.json(buscarProduto(id));
});

app.delete('/api/produtos/:id', (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM itens_pedido WHERE produto_id = ? LIMIT 1').get(id)) {
    throw new ErroHttp(409, 'Este produto já está em pedidos. Marque como indisponível em vez de excluir.');
  }
  const { changes } = db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  if (!changes) throw new ErroHttp(404, 'Produto não encontrado.');
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Clientes (busca pelo telefone para preencher o endereço)
// ---------------------------------------------------------------------------
app.get('/api/clientes', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE telefone = ?').get(soDigitos(req.query.telefone));
  res.json(cliente ?? null);
});

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------
const SQL_PEDIDO = `
  SELECT p.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone
  FROM pedidos p JOIN clientes c ON c.id = p.cliente_id`;

const itensDoPedido = (pedidoId) =>
  db.prepare(`
    SELECT i.produto_id, i.quantidade, i.preco_unitario, pr.nome, pr.tempo_preparo, pr.foto
    FROM itens_pedido i JOIN produtos pr ON pr.id = i.produto_id
    WHERE i.pedido_id = ? ORDER BY i.id`).all(pedidoId);

function buscarPedido(id) {
  const pedido = db.prepare(`${SQL_PEDIDO} WHERE p.id = ?`).get(id);
  if (!pedido) throw new ErroHttp(404, 'Pedido não encontrado.');
  return { ...pedido, itens: itensDoPedido(id) };
}

app.get('/api/pedidos', (req, res) => {
  const pedidos = db.prepare(`${SQL_PEDIDO} ORDER BY p.id DESC LIMIT 100`).all();
  res.json(pedidos.map((p) => ({ ...p, itens: itensDoPedido(p.id) })));
});

// Acompanhamento do pedido pelo cliente: status, horário de cada etapa e mensagens recebidas
app.get('/api/pedidos/:id', (req, res) => {
  const pedido = buscarPedido(Number(req.params.id));
  const fila = db.prepare('SELECT * FROM fila_preparo WHERE pedido_id = ?').get(pedido.id) ?? {};
  const { naFrente } = db.prepare(`
    SELECT COUNT(*) AS naFrente FROM fila_preparo
    WHERE status != 'pronto' AND (entrou_em < ? OR (entrou_em = ? AND id < ?))`).get(fila.entrou_em, fila.entrou_em, fila.id);
  const mensagens = db.prepare('SELECT tipo, texto, enviada_em FROM mensagens WHERE pedido_id = ? ORDER BY enviada_em, id').all(pedido.id);
  const saiu = mensagens.find((m) => m.tipo === 'saiu_entrega');
  res.json({
    ...pedido,
    na_frente: pedido.status === 'recebido' ? naFrente : 0,
    iniciado_em: fila.iniciado_em ?? null,
    concluido_em: fila.concluido_em ?? null,
    saiu_em: saiu ? saiu.enviada_em : null,
    mensagens,
  });
});

// Situação da cozinha agora (a área do cliente usa para estimar o tempo antes do pedido)
app.get('/api/situacao', (req, res) => {
  const { naCozinha } = db.prepare("SELECT COUNT(*) AS naCozinha FROM fila_preparo WHERE status != 'pronto'").get();
  res.json({ na_cozinha: naCozinha, minutos_por_pedido: MINUTOS_POR_PEDIDO_NA_FRENTE, area_entrega: AREA_ENTREGA });
});

app.post('/api/pedidos', async (req, res) => {
  const { cliente = {}, entrega = {}, itens = [], observacao = '' } = req.body ?? {};
  const nome = texto(cliente.nome);
  const telefone = soDigitos(cliente.telefone);
  if (!nome) throw new ErroHttp(400, 'Informe o nome do cliente.');
  if (telefone.length < 10 || telefone.length > 11) throw new ErroHttp(400, 'Informe o telefone com DDD.');
  if (!Array.isArray(itens) || !itens.length) throw new ErroHttp(400, 'Adicione pelo menos um item ao pedido.');

  const local = await consultarCep(entrega.cep);
  if (!local.atende) throw new ErroHttp(422, `Não entregamos em ${local.cidade}/${local.uf}.`);

  const end = {
    cep: local.cep,
    logradouro: texto(entrega.logradouro) || local.logradouro,
    numero: texto(entrega.numero),
    complemento: texto(entrega.complemento),
    bairro: texto(entrega.bairro) || local.bairro,
    cidade: local.cidade,
    uf: local.uf,
  };
  if (!end.logradouro || !end.numero) throw new ErroHttp(400, 'Informe a rua e o número da entrega.');
  const endereco = [`${end.logradouro}, ${end.numero}`, end.complemento, end.bairro, `${end.cidade}/${end.uf}`]
    .filter(Boolean)
    .join(', ');

  const linhas = itens.map((item) => {
    const produto = buscarProduto(Number(item.produto_id));
    const quantidade = Number(item.quantidade);
    if (!produto || !produto.disponivel) throw new ErroHttp(400, 'Um dos itens não está mais disponível no cardápio.');
    if (!Number.isInteger(quantidade) || quantidade < 1) throw new ErroHttp(400, 'Quantidade inválida.');
    return { produto, quantidade };
  });
  const total = Math.round(linhas.reduce((s, l) => s + l.produto.preco * l.quantidade, 0) * 100) / 100;

  // Tempo estimado = item mais demorado + pedidos à frente na cozinha + trajeto até a cidade
  const { naFrente } = db.prepare("SELECT COUNT(*) AS naFrente FROM fila_preparo WHERE status != 'pronto'").get();
  const preparo = Math.max(...linhas.map((l) => l.produto.tempo_preparo));
  const tempoEstimado = preparo + naFrente * MINUTOS_POR_PEDIDO_NA_FRENTE + local.trajeto;
  const previsao = new Date(Date.now() + tempoEstimado * 60_000).toISOString();

  const pedidoId = transacao(() => {
    const { id: clienteId } = db.prepare(`
      INSERT INTO clientes (nome, telefone, cep, logradouro, numero, complemento, bairro, cidade, uf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (telefone) DO UPDATE SET
        nome = excluded.nome, cep = excluded.cep, logradouro = excluded.logradouro, numero = excluded.numero,
        complemento = excluded.complemento, bairro = excluded.bairro, cidade = excluded.cidade, uf = excluded.uf
      RETURNING id`).get(nome, telefone, end.cep, end.logradouro, end.numero, end.complemento, end.bairro, end.cidade, end.uf);

    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO pedidos (cliente_id, cep, endereco, observacao, total, tempo_estimado, tempo_trajeto, previsao_entrega)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(clienteId, end.cep, endereco, texto(observacao), total, tempoEstimado, local.trajeto, previsao);

    const inserirItem = db.prepare('INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?)');
    linhas.forEach((l) => inserirItem.run(id, l.produto.id, l.quantidade, l.produto.preco));
    db.prepare('INSERT INTO fila_preparo (pedido_id) VALUES (?)').run(id);

    const primeiroNome = nome.split(' ')[0];
    const lista = linhas.map((l) => `${l.quantidade}x ${l.produto.nome}`).join('\n');
    registrarMensagem(id, clienteId, 'confirmacao',
      `Olá, ${primeiroNome}! Recebemos o seu pedido nº ${id}.\n\n${lista}\n\nTotal: ${reais(total)}\nEntrega em: ${endereco}`);
    registrarMensagem(id, clienteId, 'tempo_estimado',
      `Tempo estimado de entrega: ${tempoEstimado} minutos. O seu pedido deve chegar por volta das ${hora(previsao)}.`);
    return id;
  });

  res.status(201).json(buscarPedido(pedidoId));
});

// Etapas depois da cozinha: pronto -> saiu para entrega -> entregue
const PROXIMA_ETAPA = { pronto: 'saiu_entrega', saiu_entrega: 'entregue' };

app.patch('/api/pedidos/:id/status', (req, res) => {
  const pedido = buscarPedido(Number(req.params.id));
  const novo = req.body?.status;
  if (PROXIMA_ETAPA[pedido.status] !== novo) {
    throw new ErroHttp(409, 'Este pedido não pode ir para essa etapa agora. Atualize a tela.');
  }
  transacao(() => {
    db.prepare('UPDATE pedidos SET status = ? WHERE id = ?').run(novo, pedido.id);
    if (novo === 'saiu_entrega') {
      registrarMensagem(pedido.id, pedido.cliente_id, 'saiu_entrega',
        `O seu pedido nº ${pedido.id} saiu para entrega e chega em cerca de ${pedido.tempo_trajeto} minutos.`);
    }
  });
  res.json(buscarPedido(pedido.id));
});

// ---------------------------------------------------------------------------
// Fila de preparo (tela da cozinha)
// ---------------------------------------------------------------------------
app.get('/api/fila', (req, res) => {
  const fila = db.prepare(`
    SELECT f.*, p.observacao, c.nome AS cliente_nome
    FROM fila_preparo f
    JOIN pedidos p ON p.id = f.pedido_id
    JOIN clientes c ON c.id = p.cliente_id
    WHERE f.status != 'pronto'
    ORDER BY f.entrou_em, f.id`).all();
  res.json(fila.map((f) => ({ ...f, itens: itensDoPedido(f.pedido_id) })));
});

const ACOES_FILA = {
  iniciar: { de: 'aguardando', para: 'preparando', pedido: 'em_preparo', coluna: 'iniciado_em' },
  concluir: { de: 'preparando', para: 'pronto', pedido: 'pronto', coluna: 'concluido_em' },
};

app.post('/api/fila/:id/:acao', (req, res) => {
  const acao = ACOES_FILA[req.params.acao];
  if (!acao) throw new ErroHttp(404, 'Ação desconhecida.');
  const item = db.prepare('SELECT * FROM fila_preparo WHERE id = ?').get(Number(req.params.id));
  if (!item) throw new ErroHttp(404, 'Pedido não encontrado na fila.');
  if (item.status !== acao.de) throw new ErroHttp(409, 'Este pedido já mudou de etapa. Atualize a tela.');

  transacao(() => {
    db.prepare(`UPDATE fila_preparo SET status = ?, ${acao.coluna} = ? WHERE id = ?`)
      .run(acao.para, new Date().toISOString(), item.id);
    db.prepare('UPDATE pedidos SET status = ? WHERE id = ?').run(acao.pedido, item.pedido_id);
  });
  res.json(buscarPedido(item.pedido_id));
});

// ---------------------------------------------------------------------------
// Mensagens enviadas pelo bot
// ---------------------------------------------------------------------------
app.get('/api/conversas', (req, res) => {
  res.json(db.prepare(`
    SELECT c.id, c.nome, c.telefone, m.texto AS ultima_mensagem, m.enviada_em
    FROM clientes c
    JOIN mensagens m ON m.id = (SELECT id FROM mensagens WHERE cliente_id = c.id ORDER BY enviada_em DESC, id DESC LIMIT 1)
    ORDER BY m.enviada_em DESC`).all());
});

app.get('/api/conversas/:clienteId', (req, res) => {
  const id = Number(req.params.clienteId);
  const cliente = db.prepare('SELECT id, nome, telefone FROM clientes WHERE id = ?').get(id);
  if (!cliente) throw new ErroHttp(404, 'Cliente não encontrado.');
  const mensagens = db.prepare('SELECT * FROM mensagens WHERE cliente_id = ? ORDER BY id').all(id);
  res.json({ cliente, mensagens });
});

// Erros viram JSON { erro: "mensagem" }
app.use((erro, req, res, next) => {
  const status = erro.status || 500;
  if (status === 500) console.error(erro);
  res.status(status).json({ erro: status === 500 ? 'Erro interno no servidor.' : erro.message });
});

app.listen(PORTA, () => {
  console.log(`DeliveryBot rodando em http://localhost:${PORTA}`);
});
