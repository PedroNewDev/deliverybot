// Área do cliente: cardápio -> finalizar pedido -> acompanhar
// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const hora = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
const somarMinutos = (d, min) => new Date(new Date(d).getTime() + min * 60000);
const limitar = (v, min, max) => Math.min(max, Math.max(min, v));

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
  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(dados?.erro || 'Não foi possível concluir. Tente de novo.');
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

// Guarda sacola, dados do cliente e último pedido neste aparelho
const guardado = {
  ler(chave) {
    try { return JSON.parse(localStorage.getItem(`deliverybot:${chave}`)); } catch { return null; }
  },
  salvar(chave, valor) {
    try { localStorage.setItem(`deliverybot:${chave}`, JSON.stringify(valor)); } catch { /* modo privado */ }
  },
};

const estado = {
  produtos: [],
  sacola: new Map(), // produto_id -> quantidade
  cep: null,
  situacao: null,
  folha: null,       // { id, qtd } do prato aberto no detalhe
  pedido: null,      // pedido acompanhado agora
  chavePedido: '',
  msgsVistas: 0,
  timerPedido: null,
  timerRelogio: null,
};

const produto = (id) => estado.produtos.find((p) => p.id === Number(id));
const imagem = (p, classe = '') => (p.foto
  ? `<img class="${classe}" src="${esc(p.foto)}" alt="" loading="lazy" decoding="async" width="320" height="240">`
  : '');

// ---------------------------------------------------------------------------
// Telas (pelo #hash: #cardapio, #sacola, #pedido-12)
// ---------------------------------------------------------------------------
function mostrarTela() {
  const hash = location.hash.slice(1);
  const pedidoId = hash.match(/^pedido-(\d+)$/)?.[1];
  const tela = pedidoId ? 'pedido' : hash === 'sacola' ? 'sacola' : 'cardapio';

  clearInterval(estado.timerPedido);
  clearInterval(estado.timerRelogio);
  if ($('#folha').open) $('#folha').close();
  document.body.dataset.tela = tela;
  document.querySelectorAll('.tela').forEach((t) => { t.hidden = t.id !== `tela-${tela}`; });
  window.scrollTo(0, 0);

  carregarSituacao();
  if (tela === 'cardapio') {
    observarCategorias();
    renderDestaque();
  }
  if (tela === 'sacola') atualizarPrevisao();
  if (tela === 'pedido') {
    estado.chavePedido = '';
    estado.pedido = null;
    $('#acompanhar').innerHTML = '<p class="carregando">Carregando o seu pedido…</p>';
    carregarPedido(pedidoId);
    estado.timerPedido = setInterval(() => carregarPedido(pedidoId), 5000);
    estado.timerRelogio = setInterval(atualizarAoVivo, 1000);
  }
}

// ---------------------------------------------------------------------------
// Situação da cozinha (tempo de entrega estimado no topo)
// ---------------------------------------------------------------------------
async function carregarSituacao() {
  try {
    estado.situacao = await api('/api/situacao');
  } catch {
    return;
  }
  const s = estado.situacao;
  const tempos = estado.produtos.map((p) => p.tempo_preparo).filter((t) => t > 0);
  const preparoTipico = tempos.length ? tempos.reduce((a, b) => a + b, 0) / tempos.length : 15;
  const trajeto = Math.min(...s.area_entrega.map((a) => a.trajeto));
  const minutos = Math.round((preparoTipico + s.na_cozinha * s.minutos_por_pedido + trajeto) / 5) * 5;
  const fila = s.na_cozinha === 0
    ? 'Cozinha livre agora'
    : `${s.na_cozinha} ${s.na_cozinha === 1 ? 'pedido' : 'pedidos'} na cozinha agora`;
  $('#casa-agora').innerHTML = `<strong>Entrega em cerca de ${minutos} min</strong><span>${fila}</span>`;
  atualizarPrevisao();
}

// ---------------------------------------------------------------------------
// Cardápio
// ---------------------------------------------------------------------------
function linhaPrato(p) {
  const qtd = estado.sacola.get(p.id) || 0;
  return `
    <li class="prato${qtd ? ' escolhido' : ''}${p.foto ? '' : ' sem-foto'}" data-produto="${p.id}">
      <button type="button" class="prato-abrir" data-abrir="${p.id}">
        <span class="prato-txt">
          <span class="prato-nome">${esc(p.nome)}</span>
          ${p.descricao ? `<span class="prato-desc">${esc(p.descricao)}</span>` : ''}
          <span class="prato-preco">${reais(p.preco)}${qtd ? `<span class="prato-qtd">${qtd} no pedido</span>` : ''}</span>
        </span>
        ${p.foto ? `<span class="prato-foto">${imagem(p)}</span>` : ''}
      </button>
      <button type="button" class="add" data-mais="${p.id}" aria-label="Adicionar ${esc(p.nome)}">+</button>
    </li>`;
}

function renderCardapio() {
  const grupos = new Map();
  estado.produtos.filter((p) => p.disponivel).forEach((p) => {
    if (!grupos.has(p.categoria)) grupos.set(p.categoria, []);
    grupos.get(p.categoria).push(p);
  });
  const lista = [...grupos];

  $('#cats').innerHTML = lista
    .map(([categoria], i) => `<button type="button" data-alvo="cat-${i}">${esc(categoria)}</button>`)
    .join('');

  $('#menu').innerHTML = lista.map(([categoria, itens], i) => `
    <section class="cat" id="cat-${i}">
      <h2>${esc(categoria)}</h2>
      <ul>${itens.map(linhaPrato).join('')}</ul>
    </section>`).join('') || '<p class="vazio">O cardápio está vazio no momento.</p>';

  // Mais pedidos: os 4 produtos com mais unidades vendidas
  const top = estado.produtos
    .filter((p) => p.disponivel && p.vendidos > 0)
    .sort((a, b) => b.vendidos - a.vendidos)
    .slice(0, 4);
  $('#mais-pedidos').hidden = top.length < 2;
  $('#vitrine').innerHTML = top.map((p) => `
    <li class="vitrine-item">
      <button type="button" class="vitrine-abrir" data-abrir="${p.id}">
        <span class="vitrine-foto">${imagem(p)}</span>
        <span class="vitrine-nome">${esc(p.nome)}</span>
        <span class="vitrine-preco">${reais(p.preco)}</span>
      </button>
      <button type="button" class="add" data-mais="${p.id}" aria-label="Adicionar ${esc(p.nome)}">+</button>
    </li>`).join('');
}

// Destaca a categoria que está na tela
let observador;
function observarCategorias() {
  observador?.disconnect();
  const nav = $('#cats');
  observador = new IntersectionObserver((entradas) => {
    entradas.filter((e) => e.isIntersecting).forEach((e) => {
      nav.querySelectorAll('button').forEach((b) => {
        const ativo = b.dataset.alvo === e.target.id;
        b.toggleAttribute('aria-current', ativo);
        if (ativo) nav.scrollTo({ left: b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' });
      });
    });
  }, { rootMargin: `-${nav.offsetHeight + 8}px 0px -65% 0px` });
  document.querySelectorAll('.cat').forEach((s) => observador.observe(s));
}

$('#cats').addEventListener('click', (e) => {
  const botao = e.target.closest('[data-alvo]');
  if (botao) document.getElementById(botao.dataset.alvo).scrollIntoView({ behavior: 'smooth' });
});

// Topo do cardápio: pedido em andamento ou "pedir de novo"
async function renderDestaque() {
  const el = $('#destaque');
  const id = guardado.ler('ultimoPedido');
  if (!id) { el.innerHTML = ''; return; }
  let p;
  try { p = await api(`/api/pedidos/${id}`); } catch { el.innerHTML = ''; return; }

  if (p.status !== 'entregue') {
    el.innerHTML = `
      <a class="ativo" href="#pedido-${p.id}">
        <span class="ativo-etapa">${TITULO[p.status]}</span>
        <span class="ativo-txt">Pedido nº ${p.id}, ${textoChegada(p)}</span>
        <span class="ativo-link">Acompanhar</span>
      </a>`;
    return;
  }

  const disponiveis = p.itens.filter((i) => produto(i.produto_id)?.disponivel);
  if (!disponiveis.length) { el.innerHTML = ''; return; }
  const total = disponiveis.reduce((s, i) => s + produto(i.produto_id).preco * i.quantidade, 0);
  el.innerHTML = `
    <section class="de-novo" aria-labelledby="de-novo-titulo">
      <div class="de-novo-fotos">${disponiveis.slice(0, 3).map((i) => imagem(produto(i.produto_id))).join('')}</div>
      <div class="de-novo-txt">
        <h2 id="de-novo-titulo">Pedir de novo</h2>
        <p>${disponiveis.map((i) => `${i.quantidade}× ${esc(i.nome)}`).join(', ')}</p>
      </div>
      <button type="button" class="btn btn-cheio" data-repetir="${p.id}">Repetir, ${reais(total)}</button>
    </section>`;
  estado.ultimoEntregue = p;
}

// ---------------------------------------------------------------------------
// Sacola
// ---------------------------------------------------------------------------
function controle(p) {
  const qtd = estado.sacola.get(p.id) || 0;
  return `<div class="qtd">
      <button type="button" data-menos="${p.id}" aria-label="Tirar um ${esc(p.nome)}">−</button>
      <output aria-label="Quantidade de ${esc(p.nome)}">${qtd}</output>
      <button type="button" data-mais="${p.id}" aria-label="Mais um ${esc(p.nome)}">+</button>
    </div>`;
}

function linhasSacola() {
  return [...estado.sacola]
    .map(([id, qtd]) => ({ produto: produto(id), qtd }))
    .filter((l) => l.produto);
}

function renderSacola() {
  const linhas = linhasSacola();
  const total = linhas.reduce((s, l) => s + l.produto.preco * l.qtd, 0);
  const itens = linhas.reduce((s, l) => s + l.qtd, 0);
  const lista = linhas.map((l) => `
    <li>
      <span class="item-foto">${imagem(l.produto)}</span>
      <span class="item-nome">${esc(l.produto.nome)}<span class="item-valor">${reais(l.produto.preco * l.qtd)}</span></span>
      ${controle(l.produto)}
    </li>`).join('');

  $('#resumo-itens').innerHTML = linhas.length
    ? `<ul class="itens">${lista}</ul>`
    : '<p class="vazio">Toque num prato para ver os detalhes, ou no + para adicionar direto.</p>';
  $('#sacola-itens').innerHTML = linhas.length
    ? lista
    : '<li class="vazio">Sua sacola está vazia. <a href="#cardapio">Escolher no cardápio</a></li>';

  ['#resumo-total', '#sacola-total', '#finalizar-total', '#barra-total'].forEach((s) => { $(s).textContent = reais(total); });
  $('#barra-qtd').textContent = itens;
  $('#barra').hidden = !linhas.length;
  $('#resumo-continuar').hidden = !linhas.length;
  atualizarPrevisao();

  guardado.salvar('sacola', [...estado.sacola]);
}

function alterarQuantidade(id, delta) {
  const nova = (estado.sacola.get(id) || 0) + delta;
  if (nova > 0) estado.sacola.set(id, nova);
  else estado.sacola.delete(id);

  const linha = document.querySelector(`.prato[data-produto="${id}"]`);
  if (linha) linha.outerHTML = linhaPrato(produto(id));
  renderSacola();
  if (delta > 0) pularSacola();
}

function pularSacola() {
  const qtd = $('#barra-qtd');
  qtd.classList.remove('pulou');
  void qtd.offsetWidth; // reinicia a animação
  qtd.classList.add('pulou');
}

function repetirPedido(itens) {
  let fora = 0;
  itens.forEach((i) => {
    if (!produto(i.produto_id)?.disponivel) { fora += 1; return; }
    estado.sacola.set(i.produto_id, (estado.sacola.get(i.produto_id) || 0) + i.quantidade);
  });
  renderCardapio();
  renderSacola();
  location.hash = '#sacola';
  if (fora) avisar('Alguns itens não estão disponíveis hoje e ficaram de fora.');
}

// ---------------------------------------------------------------------------
// Detalhe do prato
// ---------------------------------------------------------------------------
const folha = $('#folha');

function abrirFolha(id) {
  const p = produto(id);
  estado.folha = { id: p.id, qtd: 1 };
  $('#folha-conteudo').innerHTML = `
    ${p.foto ? `<img class="folha-foto" src="${esc(p.foto)}" alt="${esc(p.nome)}">` : ''}
    <div class="folha-corpo">
      <h2 id="folha-nome">${esc(p.nome)}</h2>
      ${p.descricao ? `<p class="folha-desc">${esc(p.descricao)}</p>` : ''}
      <p class="folha-meta">
        <span>${reais(p.preco)}</span>
        ${p.tempo_preparo ? `<span>Fica pronto em cerca de ${p.tempo_preparo} min</span>` : ''}
      </p>
      <div class="folha-acoes">
        <div class="qtd">
          <button type="button" data-folha="-1" aria-label="Menos um">−</button>
          <output id="folha-qtd">1</output>
          <button type="button" data-folha="1" aria-label="Mais um">+</button>
        </div>
        <button type="button" class="btn btn-cheio" data-folha-add>
          <span>Adicionar</span><span id="folha-preco">${reais(p.preco)}</span>
        </button>
      </div>
    </div>`;
  folha.showModal();
  folha.focus(); // foco no painel, sem anel de foco no botão fechar ao tocar
}

folha.addEventListener('click', (e) => {
  if (e.target === folha) { folha.close(); return; } // toque fora do conteúdo
  const passo = e.target.closest('[data-folha]');
  if (passo) {
    estado.folha.qtd = limitar(estado.folha.qtd + Number(passo.dataset.folha), 1, 20);
    $('#folha-qtd').textContent = estado.folha.qtd;
    $('#folha-preco').textContent = reais(produto(estado.folha.id).preco * estado.folha.qtd);
  }
  if (e.target.closest('[data-folha-add]')) {
    const { id, qtd } = estado.folha;
    folha.close();
    alterarQuantidade(id, qtd);
    avisar(`${qtd}× ${produto(id).nome} no seu pedido.`);
  }
});

// ---------------------------------------------------------------------------
// Cliques gerais
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const mais = e.target.closest('[data-mais]');
  const menos = e.target.closest('[data-menos]');
  const abrir = e.target.closest('[data-abrir]');
  const repetir = e.target.closest('[data-repetir]');
  if (mais) alterarQuantidade(Number(mais.dataset.mais), 1);
  else if (menos) alterarQuantidade(Number(menos.dataset.menos), -1);
  else if (abrir) abrirFolha(abrir.dataset.abrir);
  else if (repetir) {
    const p = estado.pedido?.id === Number(repetir.dataset.repetir) ? estado.pedido : estado.ultimoEntregue;
    if (p) repetirPedido(p.itens);
  }
});

// ---------------------------------------------------------------------------
// Finalizar pedido
// ---------------------------------------------------------------------------
const form = $('#form');

function mostrarCep(texto, tipo = '') {
  const el = $('#cep-status');
  el.textContent = texto;
  el.className = `cep-status ${tipo}`;
}

function atualizarPrevisao() {
  const el = $('#finalizar-previsao');
  const linhas = linhasSacola();
  if (!linhas.length) { el.textContent = ''; return; }
  if (!estado.cep?.atende || !estado.situacao) { el.textContent = 'Informe o CEP para ver a previsão'; return; }
  const preparo = Math.max(...linhas.map((l) => l.produto.tempo_preparo));
  const minutos = preparo + estado.situacao.na_cozinha * estado.situacao.minutos_por_pedido + estado.cep.trajeto;
  el.textContent = `Chega por volta das ${hora(somarMinutos(Date.now(), minutos))}`;
}

async function verificarCep(cep) {
  mostrarCep('Conferindo se entregamos no seu CEP…', 'carregando');
  try {
    const r = await api(`/api/cep/${cep}`);
    if (soDigitos(form.cep.value) !== cep) return;
    estado.cep = r;
    if (r.logradouro) form.logradouro.value = r.logradouro;
    if (r.bairro) form.bairro.value = r.bairro;
    if (r.atende) {
      const semRua = r.logradouro ? '' : ' Esse é o CEP geral da cidade, preencha a rua.';
      mostrarCep(`Entregamos em ${r.cidade}/${r.uf}.${semRua}`, 'ok');
    } else {
      mostrarCep(`Ainda não entregamos em ${r.cidade}/${r.uf}. Atendemos ${r.cidades_atendidas.join(' e ')}.`, 'erro');
    }
  } catch (erro) {
    estado.cep = null;
    mostrarCep(erro.message, 'erro');
  }
  atualizarPrevisao();
}

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
    atualizarPrevisao();
  }
});

form.telefone.addEventListener('input', (e) => { e.target.value = formatarTelefone(e.target.value); });

function preencherDadosSalvos() {
  const c = guardado.ler('cliente');
  if (!c) return;
  ['nome', 'telefone', 'cep', 'logradouro', 'numero', 'complemento', 'bairro'].forEach((campo) => {
    form[campo].value = c[campo] || '';
  });
  if (soDigitos(c.cep).length === 8) verificarCep(soDigitos(c.cep));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!estado.sacola.size) return avisar('Sua sacola está vazia. Escolha algo no cardápio.', 'erro');
  if (!estado.cep?.atende) {
    form.cep.focus();
    return avisar('Informe um CEP dentro da área de entrega.', 'erro');
  }

  const botao = form.querySelector('[type=submit]');
  botao.disabled = true;
  botao.textContent = 'Enviando pedido…';
  const cliente = {
    nome: form.nome.value.trim(),
    telefone: form.telefone.value,
    cep: form.cep.value,
    logradouro: form.logradouro.value.trim(),
    numero: form.numero.value.trim(),
    complemento: form.complemento.value.trim(),
    bairro: form.bairro.value.trim(),
  };

  try {
    const pedido = await api('/api/pedidos', {
      method: 'POST',
      body: {
        cliente: { nome: cliente.nome, telefone: cliente.telefone },
        entrega: cliente,
        observacao: form.observacao.value,
        itens: [...estado.sacola].map(([produto_id, quantidade]) => ({ produto_id, quantidade })),
      },
    });
    guardado.salvar('cliente', cliente);
    guardado.salvar('ultimoPedido', pedido.id);
    estado.sacola.clear();
    form.observacao.value = '';
    renderCardapio();
    renderSacola();
    location.hash = `#pedido-${pedido.id}`;
  } catch (erro) {
    avisar(erro.message, 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = 'Fazer pedido';
  }
});

// ---------------------------------------------------------------------------
// Acompanhar pedido
// ---------------------------------------------------------------------------
const ETAPAS = [
  ['recebido', 'Recebido', 'criado_em'],
  ['em_preparo', 'Em preparo', 'iniciado_em'],
  ['pronto', 'Pronto', 'concluido_em'],
  ['saiu_entrega', 'Saiu para entrega', 'saiu_em'],
  ['entregue', 'Entregue', null],
];
const TITULO = {
  recebido: 'Pedido recebido',
  em_preparo: 'Na cozinha',
  pronto: 'Pronto para sair',
  saiu_entrega: 'A caminho',
  entregue: 'Entregue',
};
const AVISO_ETAPA = {
  em_preparo: 'A cozinha começou o seu pedido.',
  pronto: 'Seu pedido está pronto e já vai sair.',
  saiu_entrega: 'Seu pedido saiu para entrega.',
  entregue: 'Pedido entregue. Bom apetite!',
};

const chegadaPrevista = (p) => (p.saiu_em ? somarMinutos(p.saiu_em, p.tempo_trajeto) : new Date(p.previsao_entrega));
const preparoPrevisto = (p) => Math.max(0, ...p.itens.map((i) => i.tempo_preparo));

function textoChegada(p) {
  if (p.status === 'entregue') return 'entregue';
  const min = Math.ceil((chegadaPrevista(p) - Date.now()) / 60000);
  return min > 1 ? `chega em ${min} min` : 'chegando agora';
}

async function carregarPedido(id) {
  try {
    const p = await api(`/api/pedidos/${id}`);
    const chave = `${p.status}:${p.mensagens.length}`;
    const anterior = estado.pedido;
    estado.pedido = p;
    if (chave !== estado.chavePedido) {
      estado.chavePedido = chave;
      renderPedido(p, anterior);
      if (anterior && anterior.status !== p.status) {
        avisar(AVISO_ETAPA[p.status] || TITULO[p.status]);
        navigator.vibrate?.([120, 60, 120]);
      }
    }
    atualizarAoVivo();
    if (p.status === 'entregue') clearInterval(estado.timerPedido);
  } catch (erro) {
    clearInterval(estado.timerPedido);
    clearInterval(estado.timerRelogio);
    $('#acompanhar').innerHTML = `
      <p class="carregando">${esc(erro.message)}</p>
      <a class="btn btn-cheio" href="#cardapio">Ir para o cardápio</a>`;
  }
}

// Rota desenhada: cozinha (esquerda) até a casa do cliente (direita)
const CAMINHO = 'M26 108 C 84 108, 92 34, 160 44 S 238 120, 296 40';

function palco(p) {
  if (p.status === 'recebido') {
    const frente = p.na_frente === 0
      ? 'Seu pedido é o próximo da cozinha.'
      : `${p.na_frente} ${p.na_frente === 1 ? 'pedido' : 'pedidos'} na sua frente.`;
    return `<div class="palco palco-fila"><strong>${frente}</strong><span>A cozinha começa assim que chegar a sua vez.</span></div>`;
  }
  if (p.status === 'em_preparo') {
    return `
      <div class="palco palco-preparo">
        <div class="progresso" role="progressbar" aria-label="Preparo" aria-valuemin="0" aria-valuemax="100">
          <span data-vivo="preparo-barra"></span>
        </div>
        <p data-vivo="preparo-txt"></p>
      </div>`;
  }
  if (p.status === 'pronto') {
    return '<div class="palco palco-fila"><strong>Embalado e esperando o entregador.</strong><span>Sai em instantes.</span></div>';
  }
  if (p.status === 'saiu_entrega') {
    const destino = p.endereco.split(',').slice(0, 2).join(',');
    const ponte = p.endereco.endsWith('/SC')
      ? '<g class="rota-ponte" data-vivo="ponte"><rect x="-26" y="-9" width="52" height="18" rx="4"/><text y="4">Ponte PR/SC</text></g>'
      : '';
    return `
      <div class="palco palco-rota">
        <svg class="rota" viewBox="0 0 322 140" role="img" aria-label="Trajeto do entregador até o seu endereço">
          <path class="rota-rua" d="${CAMINHO}"/>
          <path class="rota-faixa" d="${CAMINHO}"/>
          <path class="rota-feita" d="${CAMINHO}" data-vivo="rota"/>
          ${ponte}
          <g transform="translate(26 108)" class="rota-cozinha"><circle r="9"/><circle r="3.5" class="miolo"/></g>
          <g transform="translate(296 40)" class="rota-casa"><path d="M-10 1 L0 -9 L10 1 V11 H-10 Z"/><rect x="-3" y="4" width="6" height="7" class="miolo"/></g>
          <g class="rota-moto" data-vivo="moto">
            <circle r="16"/>
            <g transform="translate(-10 -9)" class="moto-desenho">
              <circle cx="4" cy="13" r="3.2"/><circle cx="16" cy="13" r="3.2"/>
              <path d="M4 13 L8.5 6 H13 L16 13"/><path d="M13 6 L14.5 2.5 H17.5"/><path d="M6 6 H10"/>
            </g>
          </g>
        </svg>
        <div class="rota-pontas"><span>Cozinha do Iguaçu</span><span>${esc(destino)}</span></div>
        <p class="rota-txt" data-vivo="rota-txt"></p>
      </div>`;
  }
  return `
    <div class="palco palco-fim">
      <strong>Bom apetite.</strong>
      <span>Gostou? Peça de novo com um toque.</span>
      <button type="button" class="btn btn-cheio" data-repetir="${p.id}">Pedir de novo</button>
    </div>`;
}

function renderPedido(p, anterior) {
  const atual = ETAPAS.findIndex(([s]) => s === p.status);
  const etapas = ETAPAS.map(([, rotulo, campo], i) => {
    const classe = i < atual ? 'feita' : i === atual ? 'atual' : '';
    const quando = campo && p[campo] && i <= atual ? `<time>${hora(p[campo])}</time>` : '';
    return `<li class="${classe}"${i === atual ? ' aria-current="step"' : ''}><span>${rotulo}</span>${quando}</li>`;
  }).join('');

  const novas = anterior?.id === p.id ? p.mensagens.length - anterior.mensagens.length : 0;
  const mensagens = p.mensagens.map((m, i) => `
    <li${i >= p.mensagens.length - novas ? ' class="nova"' : ''}>
      <p>${esc(m.texto)}</p>
      <time>${hora(m.enviada_em)}</time>
    </li>`).join('');

  const itens = p.itens.map((i) => `
    <li>
      <span class="item-foto">${imagem(i)}</span>
      <span>${i.quantidade}× ${esc(i.nome)}</span>
    </li>`).join('');

  $('#acompanhar').innerHTML = `
    <section class="acomp-topo">
      <p class="acomp-num">Pedido nº ${p.id}</p>
      <h1 class="acomp-titulo">${TITULO[p.status]}</h1>
      <p class="acomp-chegada" data-vivo="chegada"></p>
    </section>

    <div class="acomp-grid">
      <div class="acomp-principal">
        ${palco(p)}
        <ol class="etapas">${etapas}</ol>
      </div>

      <div class="acomp-lado">
        <section>
          <h2>Mensagens do restaurante</h2>
          <ol class="msgs">${mensagens}</ol>
        </section>
        <section class="acomp-pedido">
          <h2>Seu pedido</h2>
          <ul class="acomp-itens">${itens}</ul>
          ${p.observacao ? `<p class="acomp-obs">Obs.: ${esc(p.observacao)}</p>` : ''}
          <p class="acomp-total"><span>Total</span><strong>${reais(p.total)}</strong></p>
          <p class="acomp-end">${esc(p.endereco)}</p>
        </section>
      </div>
    </div>

    <a class="btn btn-linha voltar-cardapio" href="#cardapio">Voltar ao cardápio</a>`;
}

// Partes que mudam a cada segundo: contagem, barra de preparo e posição do entregador
function atualizarAoVivo() {
  const p = estado.pedido;
  if (!p) return;
  const chegada = $('[data-vivo="chegada"]');
  if (chegada) {
    const min = Math.ceil((chegadaPrevista(p) - Date.now()) / 60000);
    chegada.innerHTML = p.status === 'entregue'
      ? 'Obrigado por pedir na Cozinha do Iguaçu.'
      : min > 1
        ? `Chega em <strong>${min} min</strong>, por volta das ${hora(chegadaPrevista(p))}`
        : '<strong>Chegando a qualquer momento</strong>';
  }

  if (p.status === 'em_preparo' && p.iniciado_em) {
    const previsto = preparoPrevisto(p) || 1;
    const passou = Math.max(0, (Date.now() - new Date(p.iniciado_em)) / 60000);
    $('[data-vivo="preparo-barra"]').style.width = `${limitar((passou / previsto) * 100, 4, 100)}%`;
    $('[data-vivo="preparo-txt"]').textContent = passou <= previsto
      ? `Preparando há ${Math.floor(passou)} min de ${previsto} previstos`
      : `Preparando há ${Math.floor(passou)} min, quase lá`;
  }

  const rota = $('[data-vivo="rota"]');
  if (rota && p.saiu_em) {
    // para antes da casa: a entrega só termina quando o restaurante marca "entregue"
    const progresso = limitar((Date.now() - new Date(p.saiu_em)) / (p.tempo_trajeto * 60000), 0, 0.9);
    const total = rota.getTotalLength();
    rota.style.strokeDasharray = total;
    rota.style.strokeDashoffset = total * (1 - progresso);
    const ponto = rota.getPointAtLength(total * progresso);
    $('[data-vivo="moto"]').style.transform = `translate(${ponto.x.toFixed(1)}px, ${ponto.y.toFixed(1)}px)`;
    const ponte = $('[data-vivo="ponte"]');
    if (ponte) {
      const meio = rota.getPointAtLength(total * 0.5);
      ponte.setAttribute('transform', `translate(${meio.x.toFixed(1)} ${(meio.y - 24).toFixed(1)})`);
    }
    $('[data-vivo="rota-txt"]').textContent = `Saiu às ${hora(p.saiu_em)}. Trajeto de cerca de ${p.tempo_trajeto} min.`;
    // só anima a partir da segunda atualização, para o entregador não "voar" da borda ao abrir
    const palcoRota = $('.palco-rota');
    if (!palcoRota.classList.contains('pronta')) requestAnimationFrame(() => palcoRota.classList.add('pronta'));
  }
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
async function iniciar() {
  try {
    estado.produtos = await api('/api/produtos');
  } catch {
    $('#menu').innerHTML = '<p class="vazio">Não foi possível carregar o cardápio. Atualize a página.</p>';
  }
  (guardado.ler('sacola') || []).forEach(([id, qtd]) => {
    if (produto(id)?.disponivel) estado.sacola.set(id, qtd);
  });
  preencherDadosSalvos();
  renderCardapio();
  renderSacola();
  mostrarTela();
}

window.addEventListener('hashchange', mostrarTela);
iniciar();
