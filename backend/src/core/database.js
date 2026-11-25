const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config } = require('./config');
const { hashPassword } = require('./crypto');
const { uuidv7 } = require('./uuidv7');
const dbLayer = require('../db/database');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'DB', 'migrations');

function runMigrations(db) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(file);
    if (existing) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');

    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)').run(
        file,
        checksum
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }
}

function ensureInitialSoporte(db) {
  const existing = db.prepare("SELECT id FROM usuarios WHERE rol = 'SOPORTE' LIMIT 1").get();
  if (existing) return existing.id;

  const id = 'usr-soporte-01';
  const email = config.initialSoporteEmail;
  const hashed = hashPassword(config.initialSoportePassword);

  db.prepare(`
    INSERT INTO usuarios (id, empresa_id, nombre, username, email, pin_hash, password_hash, rol, activo)
    VALUES (?, NULL, 'Soporte', 'soporte', ?, ?, ?, 'SOPORTE', 1)
  `).run(id, email, hashed, hashed);

  return id;
}

function createDatabase(dbPath = config.dbPath) {
  const db = dbLayer.createDatabase(dbPath);
  runMigrations(db);
  ensureInitialSoporte(db);
  return db;
}

function getDb() {
  return dbLayer.getDb();
}

function setDb(customDb) {
  dbLayer.setDb(customDb);
}

/**
 * Ejecuta un Hot Backup de SQLite usando `VACUUM INTO` y registra su checksum SHA-256 en `respaldos_sistema`.
 */
function runHotBackup(
  db = getDb(),
  backupDir = path.join(__dirname, '..', '..', 'backups'),
  actorId = null,
  empresaId = null
) {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `backup-${stamp}-${uuidv7().slice(-6)}.sqlite`);
  const escaped = backupFile.replace(/'/g, "''");

  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec(`VACUUM INTO '${escaped}';`);

  const stat = fs.statSync(backupFile);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(backupFile)).digest('hex');
  const backupId = uuidv7();

  db.prepare(`
    INSERT INTO respaldos_sistema (id, empresa_id, tipo, archivo, proveedor_destino, tamano_bytes, checksum_sha256, creado_por_id)
    VALUES (?, ?, 'HOT_BACKUP_DB', ?, 'local', ?, ?, ?)
  `).run(backupId, empresaId, backupFile, stat.size, hash, actorId);

  return {
    id: backupId,
    archivo: backupFile,
    tamano_bytes: stat.size,
    checksum_sha256: hash,
  };
}

module.exports = {
  createDatabase,
  getDb,
  setDb,
  runMigrations,
  runHotBackup,
};
