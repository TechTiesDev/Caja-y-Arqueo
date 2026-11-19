const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../db/database');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'data', 'backups');

/**
 * Ejecuta un respaldo en caliente (Hot Backup) consistente de la base de datos SQLite
 * utilizando VACUUM INTO para no bloquear las cajas mientras están cobrando (Etapa 5).
 */
function realizarBackupBaseDatos(db = getDb(), customDir = BACKUP_DIR) {
  if (!fs.existsSync(customDir)) {
    fs.mkdirSync(customDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(customDir, `caja_arqueo_backup_${timestamp}.sqlite`);
  const escapedPath = backupFile.replace(/'/g, "''");

  db.exec(`VACUUM INTO '${escapedPath}';`);

  const stats = fs.statSync(backupFile);
  return {
    archivo: backupFile,
    tamano_bytes: stats.size,
    creado_en: new Date().toISOString(),
  };
}

module.exports = { realizarBackupBaseDatos };
