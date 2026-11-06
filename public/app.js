// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const minutosDesde = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));

function hora(iso) {
  const d = new Date(iso);
  const h = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
  const hoje = d.toDateString() === new Date().toDateString();
  return hoje ? h : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${h}`;
}

function formatarTelefone(v) {
  const d = soDigitos(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function formatarCep(v) {
  const d = soDigitos(v).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

async function api(url, { method = 'GET', body } = {}) {
  const resposta = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const dados = resposta.status === 204 ? null : await resposta.json();
  if (!resposta.ok) throw new Error(dados?.erro || 'Não foi possível concluir a ação.');
  return dados;
}

let timerAviso;
function avisar(mensagem, tipo = 'ok') {
  const el = $('#aviso');
  el.textContent = mensagem;
  el.className = `aviso visivel ${tipo}`;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => el.classList.remove('visivel'), 4500);
}

const estado = {
  view: 'novo',
  produtos: [],
  carrinho: new Map(), // produto_id -> quantidade
  cep: null,           // resposta do /api/cep
  ticketsVistos: null, // ids da fila já exibidos (para animar só os novos)
  conversaAtual: null,
  ultimaConversa: '',
  editando: null,
};

// ---------------------------------------------------------------------------
// Navegação entre telas (pelo #hash, para a cozinha abrir direto em /#cozinha)
// ---------------------------------------------------------------------------
const VIEWS = ['novo', 'pedidos', 'cozinha', 'mensagens', 'cardapio'];

function abrirView() {
  const pedida = location.hash.slice(1);
  const view = VIEWS.includes(pedida) ? pedida : estado.view;
  estado.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.aba').forEach((a) => {
    if (a.getAttribute('href') === `#${view}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  carregarView();
}

async function carregarView() {
  try {
    if (estado.view === 'novo') {
      await carregarProdutos();
      renderMenu();
      renderComanda();
    } else if (estado.view === 'pedidos') {
      renderPedidos(await api('/api/pedidos'));
    } else if (estado.view === 'cozinha') {
      renderCozinha(await api('/api/fila'));
    } else if (estado.view === 'mensagens') {
      await carregarMensagens();
    } else if (estado.view === 'cardapio') {
      await carregarProdutos();
      renderCardapio();
    }
  } catch (erro) {
    avisar(erro.message, 'erro');
  }
}

async function atualizarContadores() {
  try {
    const [pedidos, fila] = await Promise.all([api('/api/pedidos'), api('/api/fila')]);
    const andamento = pedidos.filter((p) => p.status !== 'entregue').length;
    const c1 = $('#cont-pedidos');
    const c2 = $('#cont-cozinha');
    c1.textContent = andamento; c1.hidden = !andamento;
    c2.textContent = fila.length; c2.hidden = !fila.length;
  } catch { /* servidor fora do ar: a próxima tentativa resolve */ }
}

async function carregarProdutos() {
  estado.produtos = await api('/api/produtos');
}

// ---------------------------------------------------------------------------
// Novo pedido
// ---------------------------------------------------------------------------
const form = $('#form-pedido');

function controleQuantidade(p) {
  const qtd = estado.carrinho.get(p.id) || 0;
  if (!p.disponivel) return '<span class="indisponivel">Indisponível</span>';
  if (!qtd) return `<button type="button" class="btn btn-linha" data-mais="${p.id}">Adicionar</button>`;
  return `<div class="qtd">
      <button type="button" data-menos="${p.id}" aria-label="Tirar um ${esc(p.nome)}">−</button>
      <output aria-label="Quantidade">${qtd}</output>
      <button type="button" data-mais="${p.id}" aria-label="Mais um ${esc(p.nome)}">+</button>
    </div>`;
}

function renderMenu() {
  const grupos = new Map();
  estado.produtos.forEach((p) => {
    if (!grupos.has(p.categoria)) grupos.set(p.categoria, []);
    grupos.get(p.categoria).push(p);
  });
  $('#menu').innerHTML = [...grupos].map(([categoria, itens]) => `
    <section class="categoria">
      <h2>${esc(categoria)}</h2>
      <ul>
        ${itens.map((p) => `
          <li class="prato${p.disponivel ? '' : ' off'}${estado.carrinho.has(p.id) ? ' no-pedido' : ''}">
            <div class="prato-info">
              <strong>${esc(p.nome)}</strong>
              ${p.descricao ? `<span>${esc(p.descricao)}</span>` : ''}
            </div>
            <span class="preco">${reais(p.preco)}</span>
            ${controleQuantidade(p)}
          </li>`).join('')}
      </ul>
    </section>`).join('');
}

function linhasCarrinho() {
  return [...estado.carrinho]
    .map(([id, qtd]) => ({ produto: estado.produtos.find((p) => p.id === id), qtd }))
    .filter((l) => l.produto);
}

function renderComanda() {
  const linhas = linhasCarrinho();
  const total = linhas.reduce((s, l) => s + l.produto.preco * l.qtd, 0);
  const itens = linhas.reduce((s, l) => s + l.qtd, 0);

  $('#itens-comanda').innerHTML = linhas.length
    ? `<ul>${linhas.map((l) => `
        <li>
          <span class="item-nome">${esc(l.produto.nome)}</span>
          ${controleQuantidade(l.produto)}
          <span class="item-valor">${reais(l.produto.preco * l.qtd)}</span>
        </li>`).join('')}</ul>`
    : '<p class="vazio">Toque em Adicionar no cardápio para montar o pedido.</p>';

  $('#total').textContent = reais(total);
  $('#barra-carrinho').hidden = !linhas.length;
  $('#barra-resumo').textContent = `${itens} ${itens === 1 ? 'item' : 'itens'}, ${reais(total)}`;
}

function alterarQuantidade(id, delta) {
  const nova = (estado.carrinho.get(id) || 0) + delta;
  if (nova > 0) estado.carrinho.set(id, nova);
  else estado.carrinho.delete(id);
  renderMenu();
  renderComanda();
}

document.addEventListener('click', (e) => {
  const mais = e.target.closest('[data-mais]');
  const menos = e.target.closest('[data-menos]');
  if (mais) alterarQuantidade(Number(mais.dataset.mais), 1);
  if (menos) alterarQuantidade(Number(menos.dataset.menos), -1);
});

$('#ir-comanda').addEventListener('click', () => $('#comanda').scrollIntoView({ behavior: 'smooth' }));

function mostrarCep(texto, tipo = '') {
  const el = $('#cep-status');
  el.textContent = texto;
  el.className = `cep-status ${tipo}`;
}

async function verificarCep(cep) {
  mostrarCep('Consultando o CEP no ViaCEP…', 'carregando');
  try {
    const r = await api(`/api/cep/${cep}`);
    if (soDigitos(form.cep.value) !== cep) return; // o CEP mudou durante a consulta
    estado.cep = r;
    if (r.logradouro) form.logradouro.value = r.logradouro;
    if (r.bairro) form.bairro.value = r.bairro;
    if (r.atende) {
      const semRua = r.logradouro ? '' : ' CEP geral da cidade: preencha a rua.';
      mostrarCep(`Entregamos em ${r.cidade}/${r.uf}. Trajeto de cerca de ${r.trajeto} min.${semRua}`, 'ok');
    } else {
      mostrarCep(`Fora da área de entrega (${r.cidade}/${r.uf}). Atendemos ${r.cidades_atendidas.join(' e ')}.`, 'erro');
    }
  } catch (erro) {
    estado.cep = null;
    mostrarCep(erro.message, 'erro');
  }
}

form.telefone.addEventListener('input', (e) => { e.target.value = formatarTelefone(e.target.value); });

// Cliente que já pediu antes: preenche nome e endereço pelo telefone
form.telefone.addEventListener('change', async () => {
  const telefone = soDigitos(form.telefone.value);
  if (telefone.length < 10) return;
  try {
    const c = await api(`/api/clientes?telefone=${telefone}`);
    if (!c) return;
    form.nome.value = c.nome;
    form.cep.value = formatarCep(c.cep);
    form.logradouro.value = c.logradouro || '';
    form.numero.value = c.numero || '';
    form.complemento.value = c.complemento || '';
    form.bairro.value = c.bairro || '';
    avisar(`${c.nome} já é cliente. Endereço preenchido.`);
    verificarCep(soDigitos(c.cep));
  } catch (erro) {
    avisar(erro.message, 'erro');
  }
});

form.cep.addEventListener('input', (e) => {
  e.target.value = formatarCep(e.target.value);
  const cep = soDigitos(e.target.value);
  estado.cep = null;
  if (cep.length === 8) {
    form.logradouro.value = ''; // endereço de CEP anterior não vale mais
    form.bairro.value = '';
    verificarCep(cep);
  } else {
    mostrarCep('');
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!estado.carrinho.size) return avisar('Adicione pelo menos um item do cardápio.', 'erro');
  if (!estado.cep?.atende) return avisar('Informe um CEP dentro da área de entrega.', 'erro');

  const botao = form.querySelector('[type=submit]');
  botao.disabled = true;
  try {
    const pedido = await api('/api/pedidos', {
      method: 'POST',
      body: {
        cliente: { nome: form.nome.value, telefone: form.telefone.value },
        entrega: {
          cep: form.cep.value,
          logradouro: form.logradouro.value,
          numero: form.numero.value,
          complemento: form.complemento.value,
          bairro: form.bairro.value,
        },
        observacao: form.observacao.value,
        itens: [...estado.carrinho].map(([produto_id, quantidade]) => ({ produto_id, quantidade })),
      },
    });
    estado.carrinho.clear();
    estado.cep = null;
    form.reset();
    mostrarCep('');
    renderMenu();
    renderComanda();
    atualizarContadores();
    avisar(`Pedido #${pedido.id} confirmado. Chega por volta das ${hora(pedido.previsao_entrega)}.`);
  } catch (erro) {
    avisar(erro.message, 'erro');
  } finally {
    botao.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------
const ETAPAS = [
  ['recebido', 'Recebido'],
  ['em_preparo', 'Em preparo'],
  ['pronto', 'Pronto'],
  ['saiu_entrega', 'Saiu para entrega'],
  ['entregue', 'Entregue'],
];

function linhaPedido(p) {
  const atual = ETAPAS.findIndex(([s]) => s === p.status);
  const etapas = ETAPAS.map(([, rotulo], i) => {
    const classe = i < atual ? 'feita' : i === atual ? 'atual' : '';
    return `<li class="${classe}"${i === atual ? ' aria-current="step"' : ''}>${rotulo}</li>`;
  }).join('');

  let acao = '<span class="na-cozinha">Na cozinha</span>';
  if (p.status === 'pronto') acao = `<button class="btn btn-cheio" data-status="saiu_entrega" data-id="${p.id}">Saiu para entrega</button>`;
  if (p.status === 'saiu_entrega') acao = `<button class="btn btn-linha" data-status="entregue" data-id="${p.id}">Marcar como entregue</button>`;
  if (p.status === 'entregue') acao = '';

  return `
    <li class="pedido status-${p.status}">
      <div class="pedido-id">
        <span class="num">#${p.id}</span>
        <span>${hora(p.criado_em)}</span>
      </div>
      <div class="pedido-corpo">
        <p class="pedido-cliente"><strong>${esc(p.cliente_nome)}</strong> <span>${formatarTelefone(p.cliente_telefone)}</span></p>
        <ol class="etapas" aria-label="Andamento do pedido">${etapas}</ol>
        <p class="pedido-itens">${p.itens.map((i) => `${i.quantidade}× ${esc(i.nome)}`).join(', ')}</p>
        <p class="pedido-end">${esc(p.endereco)}</p>
        ${p.observacao ? `<p class="pedido-obs">Obs.: ${esc(p.observacao)}</p>` : ''}
      </div>
      <div class="pedido-lado">
        <strong class="pedido-total">${reais(p.total)}</strong>
        ${p.status !== 'entregue' ? `<span class="previsao">Previsão ${hora(p.previsao_entrega)}</span>` : ''}
        ${acao}
      </div>
    </li>`;
}

function renderPedidos(pedidos) {
  // em andamento: mais antigo primeiro, igual à fila da cozinha
  const andamento = pedidos.filter((p) => p.status !== 'entregue').reverse();
  const entregues = pedidos.filter((p) => p.status === 'entregue');
  $('#lista-andamento').innerHTML = andamento.map(linhaPedido).join('')
    || '<li class="vazio">Nenhum pedido em andamento. Pedidos confirmados em Novo pedido aparecem aqui.</li>';
  $('#lista-entregues').innerHTML = entregues.map(linhaPedido).join('')
    || '<li class="vazio">Nenhum pedido entregue ainda.</li>';
}

$('#view-pedidos').addEventListener('click', async (e) => {
  const botao = e.target.closest('[data-status]');
  if (!botao) return;
  botao.disabled = true;
  try {
    const pedido = await api(`/api/pedidos/${botao.dataset.id}/status`, { method: 'PATCH', body: { status: botao.dataset.status } });
    avisar(pedido.status === 'saiu_entrega'
      ? `Pedido #${pedido.id} saiu para entrega. Cliente avisado.`
      : `Pedido #${pedido.id} entregue.`);
    await carregarView();
    atualizarContadores();
  } catch (erro) {
    avisar(erro.message, 'erro');
    botao.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Cozinha
// ---------------------------------------------------------------------------
function ticket(f, novo) {
  const preparo = Math.max(...f.itens.map((i) => i.tempo_preparo));
  const cozinhando = f.status === 'preparando';
  const decorrido = minutosDesde(cozinhando ? f.iniciado_em : f.entrou_em);
  const atrasado = cozinhando && decorrido > preparo;
  const tempo = cozinhando
    ? `No fogo: ${decorrido} de ${preparo} min${atrasado ? ', atrasado' : ''}`
    : `Na fila há ${decorrido} min`;

  return `
    <div class="pendurado${novo ? ' chegou' : ''}">
      <article class="ticket ${f.status}${atrasado ? ' atrasado' : ''}">
        <header>
          <span class="num">#${f.pedido_id}</span>
          <span class="hora">${hora(f.entrou_em)}</span>
        </header>
        <p class="tempo">${tempo}</p>
        <ul>
          ${f.itens.map((i) => `<li><b>${i.quantidade}</b><span>${esc(i.nome)}</span></li>`).join('')}
        </ul>
        ${f.observacao ? `<p class="obs">${esc(f.observacao)}</p>` : ''}
        <p class="ticket-cliente">${esc(f.cliente_nome)}</p>
        <button class="btn ${cozinhando ? 'btn-pronto' : 'btn-fogo'}" data-fila="${f.id}" data-acao="${cozinhando ? 'concluir' : 'iniciar'}">
          ${cozinhando ? 'Pedido pronto' : 'Começar preparo'}
        </button>
      </article>
    </div>`;
}

function renderCozinha(fila) {
  const preparando = fila.filter((f) => f.status === 'preparando').length;
  $('#cozinha-resumo').textContent = fila.length
    ? `${fila.length - preparando} aguardando, ${preparando} em preparo`
    : '';

  const primeiraVez = estado.ticketsVistos === null;
  const vistos = estado.ticketsVistos || new Set();
  $('#tickets').innerHTML = fila.length
    ? fila.map((f) => ticket(f, !primeiraVez && !vistos.has(f.id))).join('')
    : '<p class="trilho-vazio">Nenhum pedido na fila. Quando o atendimento confirmar um pedido, a comanda aparece aqui.</p>';
  estado.ticketsVistos = new Set(fila.map((f) => f.id));
}

$('#tickets').addEventListener('click', async (e) => {
  const botao = e.target.closest('[data-fila]');
  if (!botao) return;
  botao.disabled = true;
  try {
    const pedido = await api(`/api/fila/${botao.dataset.fila}/${botao.dataset.acao}`, { method: 'POST' });
    if (pedido.status === 'pronto') avisar(`Pedido #${pedido.id} pronto para sair.`);
    await carregarView();
    atualizarContadores();
  } catch (erro) {
    avisar(erro.message, 'erro');
    botao.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------
const TIPOS = {
  confirmacao: 'Confirmação',
  tempo_estimado: 'Tempo estimado',
  saiu_entrega: 'Saiu para entrega',
};

async function carregarMensagens() {
  const conversas = await api('/api/conversas');
  if (!conversas.some((c) => c.id === estado.conversaAtual)) estado.conversaAtual = conversas[0]?.id ?? null;

  $('#lista-conversas').innerHTML = conversas.length
    ? conversas.map((c) => `
        <li>
          <button class="conversa-item" data-cliente="${c.id}"${c.id === estado.conversaAtual ? ' aria-current="true"' : ''}>
            <strong>${esc(c.nome)}</strong>
            <time>${hora(c.enviada_em)}</time>
            <span>${esc(c.ultima_mensagem.split('\n')[0])}</span>
          </button>
        </li>`).join('')
    : '<li class="vazio">Nenhuma mensagem ainda. O bot escreve para o cliente assim que um pedido é confirmado.</li>';

  if (!estado.conversaAtual) {
    $('#conversa').innerHTML = '';
    estado.ultimaConversa = '';
    return;
  }

  const { cliente, mensagens } = await api(`/api/conversas/${estado.conversaAtual}`);
  const chave = `${cliente.id}:${mensagens.at(-1)?.id}`;
  if (chave === estado.ultimaConversa) return; // nada novo: não mexe na rolagem
  estado.ultimaConversa = chave;

  $('#conversa').innerHTML = `
    <header class="conversa-topo">
      <strong>${esc(cliente.nome)}</strong>
      <span>${formatarTelefone(cliente.telefone)}</span>
    </header>
    <ol class="bolhas">
      ${mensagens.map((m) => `
        <li class="bolha tipo-${m.tipo}">
          <span class="bolha-tipo">${TIPOS[m.tipo]}, pedido #${m.pedido_id}</span>
          <p>${esc(m.texto)}</p>
          <time>${hora(m.enviada_em)}</time>
        </li>`).join('')}
    </ol>`;
  const lista = $('#conversa .bolhas');
  lista.scrollTop = lista.scrollHeight;
}

$('#lista-conversas').addEventListener('click', (e) => {
  const item = e.target.closest('[data-cliente]');
  if (!item) return;
  estado.conversaAtual = Number(item.dataset.cliente);
  carregarMensagens().catch((erro) => avisar(erro.message, 'erro'));
});

// ---------------------------------------------------------------------------
// Cardápio (cadastro de produtos)
// ---------------------------------------------------------------------------
const formProduto = $('#form-produto');

function renderCardapio() {
  $('#tabela-produtos tbody').innerHTML = estado.produtos.map((p) => `
    <tr class="${p.disponivel ? '' : 'off'}">
      <td><strong>${esc(p.nome)}</strong>${p.descricao ? `<span>${esc(p.descricao)}</span>` : ''}</td>
      <td>${esc(p.categoria)}</td>
      <td class="num">${reais(p.preco)}</td>
      <td class="num">${p.tempo_preparo} min</td>
      <td>
        <label class="chave">
          <input type="checkbox" data-disponivel="${p.id}"${p.disponivel ? ' checked' : ''}>
          <span>${p.disponivel ? 'Disponível' : 'Indisponível'}</span>
        </label>
      </td>
      <td class="acoes">
        <button class="btn btn-texto" data-editar="${p.id}">Editar</button>
        <button class="btn btn-texto perigo" data-excluir="${p.id}">Excluir</button>
      </td>
    </tr>`).join('');

  const categorias = [...new Set(estado.produtos.map((p) => p.categoria))];
  $('#categorias').innerHTML = categorias.map((c) => `<option value="${esc(c)}">`).join('');
}

function limparFormProduto() {
  estado.editando = null;
  formProduto.reset();
  $('#form-produto-titulo').textContent = 'Novo produto';
  $('#salvar-produto').textContent = 'Cadastrar produto';
  $('#cancelar-edicao').hidden = true;
}

$('#tabela-produtos').addEventListener('click', async (e) => {
  const editar = e.target.closest('[data-editar]');
  const excluir = e.target.closest('[data-excluir]');

  if (editar) {
    const p = estado.produtos.find((x) => x.id === Number(editar.dataset.editar));
    estado.editando = p.id;
    formProduto.nome.value = p.nome;
    formProduto.categoria.value = p.categoria;
    formProduto.descricao.value = p.descricao;
    formProduto.foto.value = p.foto || '';
    formProduto.preco.value = p.preco;
    formProduto.tempo_preparo.value = p.tempo_preparo;
    formProduto.disponivel.checked = Boolean(p.disponivel);
    $('#form-produto-titulo').textContent = `Editando ${p.nome}`;
    $('#salvar-produto').textContent = 'Salvar alterações';
    $('#cancelar-edicao').hidden = false;
    formProduto.nome.focus();
  }

  if (excluir) {
    const p = estado.produtos.find((x) => x.id === Number(excluir.dataset.excluir));
    if (!confirm(`Excluir ${p.nome} do cardápio?`)) return;
    try {
      await api(`/api/produtos/${p.id}`, { method: 'DELETE' });
      if (estado.editando === p.id) limparFormProduto();
      avisar(`${p.nome} excluído do cardápio.`);
      await carregarView();
    } catch (erro) {
      avisar(erro.message, 'erro');
    }
  }
});

$('#tabela-produtos').addEventListener('change', async (e) => {
  const chave = e.target.closest('[data-disponivel]');
  if (!chave) return;
  const p = estado.produtos.find((x) => x.id === Number(chave.dataset.disponivel));
  try {
    await api(`/api/produtos/${p.id}`, { method: 'PUT', body: { ...p, disponivel: chave.checked } });
    avisar(chave.checked ? `${p.nome} voltou ao cardápio.` : `${p.nome} marcado como indisponível.`);
    await carregarView();
  } catch (erro) {
    avisar(erro.message, 'erro');
    chave.checked = !chave.checked;
  }
});

formProduto.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    nome: formProduto.nome.value,
    categoria: formProduto.categoria.value,
    descricao: formProduto.descricao.value,
    foto: formProduto.foto.value,
    preco: Number(formProduto.preco.value),
    tempo_preparo: Number(formProduto.tempo_preparo.value),
    disponivel: formProduto.disponivel.checked,
  };
  try {
    const salvo = estado.editando
      ? await api(`/api/produtos/${estado.editando}`, { method: 'PUT', body })
      : await api('/api/produtos', { method: 'POST', body });
    avisar(estado.editando ? `${salvo.nome} atualizado.` : `${salvo.nome} cadastrado no cardápio.`);
    limparFormProduto();
    await carregarView();
  } catch (erro) {
    avisar(erro.message, 'erro');
  }
});

$('#cancelar-edicao').addEventListener('click', limparFormProduto);

// ---------------------------------------------------------------------------
// Início + atualização automática a cada 5 s (cozinha, pedidos e mensagens)
// ---------------------------------------------------------------------------
window.addEventListener('hashchange', abrirView);
abrirView();
atualizarContadores();
setInterval(() => {
  atualizarContadores();
  if (['pedidos', 'cozinha', 'mensagens'].includes(estado.view)) carregarView();
}, 5000);
