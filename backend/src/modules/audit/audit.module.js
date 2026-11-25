const { uuidv7 } = require('../../core/uuidv7');
const { logger } = require('../../core/logger');

/**
 * Registra un evento en la tabla inmutable `audit_logs` (Append-Only protegido por triggers RNF-04).
 */
function recordAudit(
  db,
  {
    empresaId = null,
    usuarioId,
    rolUsuario,
    terminal = 'WEB-01',
    modulo = 'CORE',
    accion,
    entidadAfectada = null,
    entidadId = null,
    detalle = {},
  }
) {
  const id = uuidv7();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO audit_logs
      (id, empresa_id, timestamp, creado_en, usuario_id, rol_usuario, terminal, modulo, accion, entidad_afectada, entidad_id, detalle_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    empresaId,
    now,
    now,
    usuarioId,
    rolUsuario,
    terminal,
    modulo,
    accion,
    entidadAfectada,
    entidadId ? String(entidadId) : null,
    JSON.stringify(detalle || {})
  );

  logger.audit(`AUDIT:${modulo}:${accion}`, {
    auditId: id,
    empresaId,
    usuarioId,
    rolUsuario,
    entidadAfectada,
    entidadId,
  });

  return { id, empresa_id: empresaId, modulo, accion, creado_en: now, timestamp: now };
}

const auditModule = {
  name: 'audit',
  prefix: '/api/v1/auditoria',
  permissions: {
    VER_AUDITORIA: ['DUENO', 'SOPORTE'],
  },
  routes: [
    {
      method: 'GET',
      path: '',
      permission: 'VER_AUDITORIA',
      allowWithoutCompany: true,
      handler: ({ db, actor, query }) => {
        const limit = Math.min(Number(query.get('limit') || 100), 500);
        const modulo = query.get('modulo') || null;
        const accion = query.get('accion') || null;

        // Si SOPORTE está fuera de empresa puede auditar eventos globales o filtrar por empresa_id
        const targetEmpresaId =
          actor.rol === 'SOPORTE' && !actor.empresa_id
            ? query.get('empresa_id') || null
            : actor.empresa_id;

        const clauses = [];
        const params = [];

        if (targetEmpresaId) {
          clauses.push('a.empresa_id = ?');
          params.push(targetEmpresaId);
        }
        if (modulo) {
          clauses.push('a.modulo = ?');
          params.push(modulo);
        }
        if (accion) {
          clauses.push('a.accion = ?');
          params.push(accion);
        }

        const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db
          .prepare(
            `SELECT a.*, u.nombre AS usuario_nombre, u.username AS usuario_username
             FROM audit_logs a
             LEFT JOIN usuarios u ON u.id = a.usuario_id
             ${whereSql}
             ORDER BY a.creado_en DESC
             LIMIT ?`
          )
          .all(...params, limit);

        const items = rows.map((r) => ({
          ...r,
          detalle: (() => {
            try {
              return JSON.parse(r.detalle_json || '{}');
            } catch {
              return {};
            }
          })(),
        }));

        return { status: 200, data: { items, total: items.length } };
      },
    },
  ],
};

module.exports = { auditModule, recordAudit };
