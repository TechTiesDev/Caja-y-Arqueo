const { verifyToken } = require('../utils/crypto');
const { getDb } = require('../db/database');

/**
 * Matriz de Permisos por Rol (RBAC Multi-Tenant + Rol Global SOPORTE):
 * - SOPORTE (Dentro de empresa): Adopta la vista y permisos operativos completos del DUENO de esa empresa.
 * - DUENO: Acceso total a su empresa.
 * - SUPERVISOR: Total de caja del turno activo, entradas/salidas, apertura de cajón.
 * - CAJERO: Cobro, salidas menores y arqueo ciego en su empresa.
 */
const PERMISSIONS = {
  REGISTRAR_VENTA: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  ABRIR_CAJA: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  REGISTRAR_MOVIMIENTO_CAJA: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  AUTORIZAR_MOVIMIENTO_CAJA: ['SUPERVISOR', 'DUENO', 'SOPORTE'],
  ARQUEO_CIEGO_CIERRE: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  ABRIR_CAJON_SIN_VENTA: ['SUPERVISOR', 'DUENO', 'SOPORTE'],
  VER_TOTAL_CAJA_TURNO_ACTIVO: ['SUPERVISOR', 'DUENO', 'SOPORTE'],

  // Permisos de Dueño (y Soporte en Modo Mantenimiento dentro de una empresa)
  VER_SALDO_ESPERADO_Y_FALTANTES: ['DUENO', 'SOPORTE'],
  VER_REPORTES_Y_DASHBOARD_VIVO: ['DUENO', 'SOPORTE'],
  EXPORTAR_EXCEL_PDF: ['DUENO', 'SOPORTE'],
  ANULAR_VENTA_O_RUBRO: ['DUENO', 'SOPORTE'],
  ADMINISTRAR_CATALOGOS: ['DUENO', 'SOPORTE'],
  VER_AUDIT_LOGS: ['DUENO', 'SOPORTE'],

  // Exclusivo de Soporte a nivel plataforma
  SOPORTE_PLATAFORMA: ['SOPORTE'],
};

function hasPermission(rol, permissionKey) {
  const allowedRoles = PERMISSIONS[permissionKey];
  if (!allowedRoles) return false;
  return allowedRoles.includes(rol);
}

function extractUserFromRequest(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return verifyToken(token);
}

/**
 * Sección 6.1: Middleware / Dependencia Global de Autenticación y Aislamiento Multi-Tenant.
 */
function getCurrentUser(req, { db = getDb(), allowWithoutCompany = false } = {}) {
  const payload = extractUserFromRequest(req);
  if (!payload) {
    const err = new Error('No autenticado. Inicie sesión.');
    err.statusCode = 401;
    throw err;
  }

  const userId = payload.sub || payload.id;
  let user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(userId);

  // Si el JWT es válido pero la instancia Serverless (ej. Vercel /tmp) reinició la BD en memoria, rehidratar contexto
  if (!user && payload.rol && (payload.username || payload.email)) {
    if (payload.empresa_id) {
      const empExists = db.prepare('SELECT id FROM empresas WHERE id = ?').get(payload.empresa_id);
      if (!empExists) {
        const { seedCompanyCatalogs } = require('../db/database');
        db.prepare(`
          INSERT INTO empresas (id, nombre, activo) VALUES (?, ?, 1)
        `).run(payload.empresa_id, payload.empresa_nombre || 'Comercio Activo');
        seedCompanyCatalogs(db, payload.empresa_id, false);
      }
    }
    const { hashPin } = require('../utils/crypto');
    db.prepare(`
      INSERT OR IGNORE INTO usuarios (id, empresa_id, nombre, username, email, pin_hash, rol, activo)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      userId,
      payload.empresa_id || null,
      payload.nombre || 'Usuario',
      payload.username || payload.email,
      payload.email || null,
      hashPin('9999'),
      payload.rol
    );
    user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(userId);
  }

  if (!user || !user.activo) {
    const err = new Error('Usuario inexistente o deshabilitado.');
    err.statusCode = 401;
    throw err;
  }

  if (['DUENO', 'SUPERVISOR', 'CAJERO'].includes(user.rol)) {
    if (!user.empresa_id) {
      const err = new Error('Sin acceso activo a una empresa');
      err.statusCode = 403;
      throw err;
    }
    const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(user.empresa_id);
    if (!empresa || !empresa.activo) {
      const err = new Error('Sin acceso activo a una empresa');
      err.statusCode = 403;
      throw err;
    }
    if (payload.empresa_id && payload.empresa_id !== user.empresa_id) {
      const err = new Error('Inconsistencia de empresa en sesión');
      err.statusCode = 403;
      throw err;
    }
    user.empresa = empresa;
    user.empresa_nombre = empresa.nombre;
  } else if (user.rol === 'SOPORTE') {
    if (payload.empresa_id !== null && payload.empresa_id !== undefined) {
      let empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(payload.empresa_id);
      if (!empresa && payload.empresa_nombre) {
        const { seedCompanyCatalogs } = require('../db/database');
        db.prepare('INSERT INTO empresas (id, nombre, activo) VALUES (?, ?, 1)').run(
          payload.empresa_id,
          payload.empresa_nombre
        );
        seedCompanyCatalogs(db, payload.empresa_id, false);
        empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(payload.empresa_id);
      }
      if (!empresa) {
        const err = new Error('Empresa no encontrada');
        err.statusCode = 404;
        throw err;
      }
      user.empresa_id = empresa.id;
      user.empresa = empresa;
      user.empresa_nombre = empresa.nombre;
    } else {
      user.empresa_id = null;
      user.empresa = null;
      user.empresa_nombre = null;
    }
  }

  if (!allowWithoutCompany && !user.empresa_id) {
    const err = new Error('Debe ingresar a una empresa para acceder a este módulo');
    err.statusCode = 403;
    throw err;
  }

  return user;
}

function requirePermission(req, permissionKey, { db = getDb(), allowWithoutCompany = false } = {}) {
  const user = getCurrentUser(req, { db, allowWithoutCompany });
  if (!hasPermission(user.rol, permissionKey)) {
    const err = new Error(
      `ACCESO_DENEGADO_RNF03: El rol '${user.rol}' no tiene permiso para '${permissionKey}'.`
    );
    err.statusCode = 403;
    throw err;
  }
  return user;
}

module.exports = {
  PERMISSIONS,
  hasPermission,
  extractUserFromRequest,
  getCurrentUser,
  requirePermission,
};
