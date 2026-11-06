-- DeliveryBot: estrutura do banco (SQLite)
-- Datas gravadas em ISO 8601 UTC, ex.: 2026-11-06T22:10:05.123Z

CREATE TABLE IF NOT EXISTS clientes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT NOT NULL,
  telefone    TEXT NOT NULL UNIQUE,          -- só dígitos, com DDD
  cep         TEXT,
  logradouro  TEXT,
  numero      TEXT,
  complemento TEXT,
  bairro      TEXT,
  cidade      TEXT,
  uf          TEXT,
  criado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS produtos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nome          TEXT NOT NULL,
  descricao     TEXT NOT NULL DEFAULT '',
  categoria     TEXT NOT NULL,
  preco         REAL NOT NULL CHECK (preco >= 0),
  tempo_preparo INTEGER NOT NULL DEFAULT 15,  -- minutos
  disponivel    INTEGER NOT NULL DEFAULT 1,    -- 1 = sim, 0 = não
  foto          TEXT NOT NULL DEFAULT ''      -- caminho da imagem, ex.: fotos/pastel.jpg
);

CREATE TABLE IF NOT EXISTS pedidos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id       INTEGER NOT NULL REFERENCES clientes(id),
  status           TEXT NOT NULL DEFAULT 'recebido'
                   CHECK (status IN ('recebido', 'em_preparo', 'pronto', 'saiu_entrega', 'entregue')),
  cep              TEXT NOT NULL,
  endereco         TEXT NOT NULL,              -- endereço de entrega no momento do pedido
  observacao       TEXT NOT NULL DEFAULT '',
  total            REAL NOT NULL,
  tempo_estimado   INTEGER NOT NULL,           -- minutos até chegar no cliente
  tempo_trajeto    INTEGER NOT NULL,           -- minutos do restaurante até a cidade do cliente
  previsao_entrega TEXT NOT NULL,
  criado_em        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS itens_pedido (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id      INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id     INTEGER NOT NULL REFERENCES produtos(id),
  quantidade     INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unitario REAL NOT NULL                 -- preço cobrado na hora do pedido
);

CREATE TABLE IF NOT EXISTS fila_preparo (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id    INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'aguardando'
               CHECK (status IN ('aguardando', 'preparando', 'pronto')),
  entrou_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  iniciado_em  TEXT,
  concluido_em TEXT
);

CREATE TABLE IF NOT EXISTS mensagens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  pedido_id  INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL CHECK (tipo IN ('confirmacao', 'tempo_estimado', 'saiu_entrega')),
  texto      TEXT NOT NULL,
  enviada_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
