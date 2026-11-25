const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPin } = require('../utils/crypto');
const { uuidv7 } = require('../utils/uuidv7');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'caja_arqueo.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_EMPRESA_ID = 'emp-default-01';

let dbInstance = null;

function createDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Si existe una BD en disco previa al esquema Core Blueprint (sin tabla respaldos_sistema), recrear limpiamente
    if (fs.existsSync(dbPath)) {
      const checkDb = new DatabaseSync(dbPath);
      const hasCoreTables = checkDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='respaldos_sistema'")
        .get();
      checkDb.close();
      if (!hasCoreTables) {
        fs.unlinkSync(dbPath);
      }
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);

  seedDefaults(db);
  seedInitialSoporte(db);
  return db;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = createDatabase();
  }
  return dbInstance;
}

function setDb(customDb) {
  dbInstance = customDb;
}

/**
 * Siembra los catálogos iniciales (Rubros y 5 Medios de Pago) vinculados a una empresa.
 */
function seedCompanyCatalogs(db, empresaId, useFixedIds = false) {
  const countRubros = db
    .prepare('SELECT COUNT(*) as total FROM rubros WHERE empresa_id = ?')
    .get(empresaId).total;

  if (countRubros === 0) {
    const insertRubro = db.prepare(`
      INSERT INTO rubros (id, empresa_id, nombre, color_hex, icono, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    const rubrosBase = [
      ['rub-almacen', 'Almacén', '#2563EB', 'package', 1],
      ['rub-bebidas', 'Bebidas', '#0891B2', 'cup-soda', 2],
      ['rub-lacteos', 'Lácteos', '#0284C7', 'milk', 3],
      ['rub-fiambreria', 'Fiambrería', '#DC2626', 'beef', 4],
      ['rub-panaderia', 'Panadería', '#D97706', 'croissant', 5],
      ['rub-limpieza', 'Limpieza', '#16A34A', 'sparkles', 6],
      ['rub-verduleria', 'Verdulería', '#65A30D', 'apple', 7],
    ];
    for (const [fixedId, nombre, color, icono, orden] of rubrosBase) {
      const id = useFixedIds || empresaId === DEFAULT_EMPRESA_ID ? fixedId : `${fixedId}-${empresaId}`;
      insertRubro.run(id, empresaId, nombre, color, icono, orden);
    }
  }

  const countMedios = db
    .prepare('SELECT COUNT(*) as total FROM medios_pago WHERE empresa_id = ?')
    .get(empresaId).total;

  if (countMedios === 0) {
    const insertMedio = db.prepare(`
      INSERT INTO medios_pago (id, empresa_id, codigo, nombre, requiere_vuelto, requiere_cliente, es_efectivo_fisico, orden, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const mediosBase = [
      ['mp-efectivo', 'EFECTIVO', 'Efectivo', 1, 0, 1, 1],
      ['mp-debito', 'DEBITO', 'Tarjeta de Débito', 0, 0, 0, 2],
      ['mp-credito', 'CREDITO', 'Tarjeta de Crédito', 0, 0, 0, 3],
      ['mp-qr', 'QR_TRANSFERENCIA', 'Transferencia / QR (MP)', 0, 0, 0, 4],
      ['mp-fiado', 'CUENTA_CORRIENTE', 'Cuenta Corriente (Fiado)', 0, 1, 0, 5],
    ];
    for (const [fixedId, codigo, nombre, reqVuelto, reqCli, esEf, orden] of mediosBase) {
      const id = useFixedIds || empresaId === DEFAULT_EMPRESA_ID ? fixedId : `${fixedId}-${empresaId}`;
      insertMedio.run(id, empresaId, codigo, nombre, reqVuelto, reqCli, esEf, orden);
    }
  }
}

/**
 * Sección 4.3: Seed en el arranque del usuario SOPORTE desde variables de entorno.
 */
function seedInitialSoporte(db) {
  const soporteEmail = (process.env.INITIAL_SOPORTE_EMAIL || 'soporte@cajayarqueo.com').trim().toLowerCase();
  const soportePassword = process.env.INITIAL_SOPORTE_PASSWORD || '9999';
  const hashed = hashPin(soportePassword);

  const soporteExistente = db
    .prepare("SELECT id, email, password_hash, pin_hash FROM usuarios WHERE id = 'usr-soporte-01'")
    .get();

  if (!soporteExistente) {
    const anySoporte = db.prepare("SELECT id FROM usuarios WHERE rol = 'SOPORTE' LIMIT 1").get();
    if (!anySoporte) {
      db.prepare(`
        INSERT INTO usuarios (id, empresa_id, nombre, username, email, pin_hash, password_hash, rol, activo)
        VALUES ('usr-soporte-01', NULL, 'Soporte', 'soporte', ?, ?, ?, 'SOPORTE', 1)
      `).run(soporteEmail, hashed, hashed);
    }
  } else if (
    soporteExistente.email === 'soporte@modular.local' ||
    !soporteExistente.pin_hash ||
    !soporteExistente.password_hash
  ) {
    db.prepare(`
      UPDATE usuarios
      SET email = ?, pin_hash = ?, password_hash = ?, activo = 1
      WHERE id = 'usr-soporte-01'
    `).run(soporteEmail, hashed, hashed);
  }
}

function seedDefaults(db) {
  // 0. Empresa por defecto para operación inicial y compatibilidad de pruebas
  const empExistente = db
    .prepare('SELECT id FROM empresas WHERE id = ?')
    .get(DEFAULT_EMPRESA_ID);

  if (!empExistente) {
    db.prepare(`
      INSERT INTO empresas (id, nombre, slug, identificador_fiscal, telefono, email, direccion, activo)
      VALUES (?, 'Almacén Central', 'almacen-central', '30-71122334-9', '11-4000-5000', 'admin@almacencentral.com', 'Av. Principal 123', 1)
    `).run(DEFAULT_EMPRESA_ID);
  }

  // 1. Semillas de Usuarios de la empresa por defecto
  const countUsers = db
    .prepare('SELECT COUNT(*) as total FROM usuarios WHERE empresa_id = ?')
    .get(DEFAULT_EMPRESA_ID).total;

  if (countUsers === 0) {
    const insertUser = db.prepare(`
      INSERT INTO usuarios (id, empresa_id, nombre, username, email, pin_hash, password_hash, rol, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    insertUser.run('usr-dueno-01', DEFAULT_EMPRESA_ID, 'Roberto (Dueño)', 'dueno', 'roberto@almacencentral.com', hashPin('9999'), hashPin('9999'), 'DUENO');
    insertUser.run('usr-super-01', DEFAULT_EMPRESA_ID, 'Carla (Supervisora)', 'supervisor', 'carla@almacencentral.com', hashPin('5555'), hashPin('5555'), 'SUPERVISOR');
    insertUser.run('usr-caj-01', DEFAULT_EMPRESA_ID, 'Lucas (Cajero Mañana)', 'lucas', 'lucas@almacencentral.com', hashPin('1111'), hashPin('1111'), 'CAJERO');
    insertUser.run('usr-caj-02', DEFAULT_EMPRESA_ID, 'Martina (Cajera Tarde)', 'martina', 'martina@almacencentral.com', hashPin('2222'), hashPin('2222'), 'CAJERO');
    insertUser.run('usr-caj-03', DEFAULT_EMPRESA_ID, 'Diego (Cajero Refuerzo)', 'diego', 'diego@almacencentral.com', hashPin('3333'), hashPin('3333'), 'CAJERO');
  }

  // 2 y 3. Semillas de Rubros y 5 Medios de Pago de la empresa por defecto
  seedCompanyCatalogs(db, DEFAULT_EMPRESA_ID, true);

  // 4. Semillas de Clientes de Cuenta Corriente
  const countClientes = db
    .prepare('SELECT COUNT(*) as total FROM clientes_fiado WHERE empresa_id = ?')
    .get(DEFAULT_EMPRESA_ID).total;

  if (countClientes === 0) {
    const insertCliente = db.prepare(`
      INSERT INTO clientes_fiado (id, empresa_id, nombre, documento_telefono, limite_credito, saldo_deudor, activo)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    insertCliente.run('cli-01', DEFAULT_EMPRESA_ID, 'Familia Gómez', '11-4455-6677', 50000, 12000);
    insertCliente.run('cli-02', DEFAULT_EMPRESA_ID, 'Kiosco El Paso', '11-2233-4455', 80000, 0);
    insertCliente.run('cli-03', DEFAULT_EMPRESA_ID, 'Marta Vecina', '11-9988-7766', 25000, 5000);
  }
}

module.exports = {
  DEFAULT_EMPRESA_ID,
  createDatabase,
  getDb,
  setDb,
  seedDefaults,
  seedCompanyCatalogs,
  seedInitialSoporte,
};
