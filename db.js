// Conexão com o SQLite (módulo nativo do Node, sem dependência extra)
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, 'deliverybot.db'));
db.exec('PRAGMA foreign_keys = ON');
// Banco criado antes da coluna foto existir: adiciona a coluna
const tabelaExiste = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'produtos'").get();
const semFoto = tabelaExiste && !db.prepare('PRAGMA table_info(produtos)').all().some((c) => c.name === 'foto');
if (semFoto) db.exec("ALTER TABLE produtos ADD COLUMN foto TEXT NOT NULL DEFAULT ''");

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Fotos do cardápio de exemplo (Wikimedia Commons, créditos em public/creditos.html)
const FOTOS = {
  'Marmita de frango grelhado': 'fotos/marmita.jpg',
  'Parmegiana de carne': 'fotos/parmegiana.jpg',
  'Strogonoff de frango': 'fotos/strogonoff.jpg',
  'Feijoada individual': 'fotos/feijoada.jpg',
  'X-salada': 'fotos/x-salada.jpg',
  'X-bacon': 'fotos/x-bacon.jpg',
  'Pastel de carne': 'fotos/pastel.jpg',
  'Batata frita': 'fotos/batata.jpg',
  'Polenta frita': 'fotos/polenta.jpg',
  'Refrigerante lata': 'fotos/refrigerante.jpg',
  'Guaraná 2 L': 'fotos/guarana.jpg',
  'Suco de laranja': 'fotos/suco.jpg',
  'Pudim de leite': 'fotos/pudim.jpg',
};

// Cardápio inicial, inserido só na primeira execução
const { total } = db.prepare('SELECT COUNT(*) AS total FROM produtos').get();
if (total === 0) {
  const inserir = db.prepare(
    'INSERT INTO produtos (categoria, nome, descricao, preco, tempo_preparo) VALUES (?, ?, ?, ?, ?)'
  );
  [
    ['Pratos', 'Marmita de frango grelhado', 'Arroz, feijão, farofa e salada', 24.9, 20],
    ['Pratos', 'Parmegiana de carne', 'Com arroz e batata frita', 39.9, 30],
    ['Pratos', 'Strogonoff de frango', 'Com arroz e batata palha', 29.9, 20],
    ['Pratos', 'Feijoada individual', 'Com couve, laranja e farofa', 34.9, 15],
    ['Lanches', 'X-salada', 'Hambúrguer de 150 g, queijo, alface e tomate', 22, 15],
    ['Lanches', 'X-bacon', 'Hambúrguer de 150 g, queijo e bacon', 26, 15],
    ['Lanches', 'Pastel de carne', 'Massa crocante, recheio de carne moída', 9.5, 10],
    ['Porções', 'Batata frita', '400 g', 24, 15],
    ['Porções', 'Polenta frita', '400 g', 22, 15],
    ['Bebidas', 'Refrigerante lata', '350 ml', 6, 0],
    ['Bebidas', 'Guaraná 2 L', '', 13, 0],
    ['Bebidas', 'Suco de laranja', 'Natural, 500 ml', 10, 5],
    ['Sobremesas', 'Pudim de leite', 'Fatia', 9, 0],
  ].forEach((p) => inserir.run(...p));
}

if (total === 0 || semFoto) {
  const definirFoto = db.prepare("UPDATE produtos SET foto = ? WHERE nome = ? AND foto = ''");
  Object.entries(FOTOS).forEach(([nome, foto]) => definirFoto.run(foto, nome));
}

module.exports = db;
