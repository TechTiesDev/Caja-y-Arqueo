const { uuidv7 } = require('../utils/uuidv7');
const { getDb, DEFAULT_EMPRESA_ID } = require('../db/database');

/**
 * Servicio de Historial de Auditoría Inalterable con aislamiento Multi-Tenant (empresa_id).
 */
function registrarAuditoria({
  db = getDb(),
  empresaId = DEFAULT_EMPRESA_ID,
  usuarioId,
  rolUsuario,
  terminal = 'POS-01',
  accion,
  entidadAfectada = null,
  entidadId = null,
  detalle = {},
}) {
  const id = uuidv7();
  const timestamp = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO audit_logs (id, empresa_id, timestamp, usuario_id, rol_usuario, terminal, accion, entidad_afectada, entidad_id, detalle_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    empresaId,
    timestamp,
    usuarioId,
    rolUsuario,
    terminal,
    accion,
    entidadAfectada,
    entidadId,
    JSON.stringify(detalle)
  );
  return { id, empresa_id: empresaId, timestamp, accion };
}

function listarAuditoria({ db = getDb(), empresaId = DEFAULT_EMPRESA_ID, limit = 100, accion = null } = {}) {
  if (accion) {
    return db
      .prepare(
        `SELECT a.*, u.nombre as usuario_nombre
         FROM audit_logs a
         JOIN usuarios u ON u.id = a.usuario_id
         WHERE a.empresa_id = ? AND a.accion = ?
         ORDER BY a.timestamp DESC
         LIMIT ?`
      )
      .all(empresaId, accion, limit);
  }
  return db
    .prepare(
      `SELECT a.*, u.nombre as usuario_nombre
       FROM audit_logs a
       JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.empresa_id = ?
       ORDER BY a.timestamp DESC
       LIMIT ?`
    )
    .all(empresaId, limit);
}

module.exports = { registrarAuditoria, listarAuditoria };
