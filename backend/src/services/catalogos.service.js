const { uuidv7 } = require('../utils/uuidv7');
const { hashPin } = require('../utils/crypto');
const { getDb, DEFAULT_EMPRESA_ID } = require('../db/database');
const { registrarAuditoria } = require('./audit.service');

/**
 * Obtiene el snapshot de catálogos administrables aislado por `empresa_id`.
 */
function obtenerSnapshotCatalogos(db = getDb(), empresaId = DEFAULT_EMPRESA_ID) {
  const empleados = db
    .prepare(
      `SELECT id, empresa_id, nombre, username, email, rol, activo
       FROM usuarios
       WHERE empresa_id = ? AND activo = 1 AND rol IN ('CAJERO', 'SUPERVISOR', 'DUENO')
       ORDER BY CASE rol WHEN 'CAJERO' THEN 1 WHEN 'SUPERVISOR' THEN 2 ELSE 3 END, nombre ASC`
    )
    .all(empresaId);

  const rubros = db
    .prepare(
      `SELECT id, empresa_id, nombre, color_hex, icono, orden, activo
       FROM rubros
       WHERE empresa_id = ? AND activo = 1
       ORDER BY orden ASC, nombre ASC`
    )
    .all(empresaId);

  const mediosPago = db
    .prepare(
      `SELECT id, empresa_id, codigo, nombre, requiere_vuelto, requiere_cliente, es_efectivo_fisico, orden, activo
       FROM medios_pago
       WHERE empresa_id = ? AND activo = 1
       ORDER BY orden ASC`
    )
    .all(empresaId);

  const clientesFiado = db
    .prepare(
      `SELECT id, empresa_id, nombre, documento_telefono, limite_credito, saldo_deudor,
              (limite_credito - saldo_deudor) AS disponible, activo
       FROM clientes_fiado
       WHERE empresa_id = ? AND activo = 1
       ORDER BY nombre ASC`
    )
    .all(empresaId);

  return {
    version: new Date().toISOString(),
    empresa_id: empresaId,
    empleados,
    rubros,
    mediosPago,
    clientesFiado,
  };
}

function crearRubro(
  db = getDb(),
  { nombre, color_hex = '#2563EB', icono = 'shopping-basket', orden = 99 },
  actor
) {
  if (!nombre || !String(nombre).trim()) {
    throw new Error('El nombre del rubro es obligatorio.');
  }
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const id = `rub-${uuidv7().slice(-8)}`;
  db.prepare(`
    INSERT INTO rubros (id, empresa_id, nombre, color_hex, icono, orden, activo)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(id, empresaId, String(nombre).trim(), color_hex, icono, Number(orden));

  if (actor) {
    registrarAuditoria({
      db,
      empresaId,
      usuarioId: actor.id,
      rolUsuario: actor.rol,
      accion: 'MODIFICACION_CATALOGO',
      entidadAfectada: 'rubros',
      entidadId: id,
      detalle: { operacion: 'CREAR_RUBRO', nombre: String(nombre).trim() },
    });
  }

  return db.prepare('SELECT * FROM rubros WHERE id = ? AND empresa_id = ?').get(id, empresaId);
}

function editarRubro(db = getDb(), rubroId, payload, actor) {
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const rubro = db.prepare('SELECT * FROM rubros WHERE id = ? AND empresa_id = ?').get(rubroId, empresaId);
  if (!rubro) {
    const err = new Error('Rubro no encontrado en esta empresa.');
    err.statusCode = 404;
    throw err;
  }

  const nuevoNombre = payload.nombre !== undefined ? String(payload.nombre).trim() : rubro.nombre;
  const nuevoColor = payload.color_hex !== undefined ? payload.color_hex : rubro.color_hex;
  const nuevoActivo = payload.activo !== undefined ? (payload.activo ? 1 : 0) : rubro.activo;

  db.prepare('UPDATE rubros SET nombre = ?, color_hex = ?, activo = ? WHERE id = ? AND empresa_id = ?').run(
    nuevoNombre,
    nuevoColor,
    nuevoActivo,
    rubroId,
    empresaId
  );

  return db.prepare('SELECT * FROM rubros WHERE id = ? AND empresa_id = ?').get(rubroId, empresaId);
}

function eliminarRubro(db = getDb(), rubroId, actor) {
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const rubro = db.prepare('SELECT * FROM rubros WHERE id = ? AND empresa_id = ?').get(rubroId, empresaId);
  if (!rubro) {
    const err = new Error('Rubro no encontrado en esta empresa.');
    err.statusCode = 404;
    throw err;
  }
  db.prepare('DELETE FROM rubros WHERE id = ? AND empresa_id = ?').run(rubroId, empresaId);
  return { eliminado: true, id: rubroId };
}

function crearEmpleado(db = getDb(), { nombre, username, email = null, pin, rol = 'CAJERO' }, actor) {
  if (!nombre || !username || !pin) {
    throw new Error('Nombre, username y PIN son obligatorios.');
  }
  if (rol === 'SOPORTE') {
    const err = new Error('No se permite asignar el rol SOPORTE desde una empresa.');
    err.statusCode = 403;
    throw err;
  }
  if (!['CAJERO', 'SUPERVISOR', 'DUENO'].includes(rol)) {
    throw new Error('Rol inválido. Use CAJERO, SUPERVISOR o DUENO.');
  }
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const id = `usr-${uuidv7().slice(-8)}`;
  db.prepare(`
    INSERT INTO usuarios (id, empresa_id, nombre, username, email, pin_hash, rol, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    empresaId,
    String(nombre).trim(),
    String(username).trim().toLowerCase(),
    email ? String(email).trim().toLowerCase() : null,
    hashPin(pin),
    rol
  );

  if (actor) {
    registrarAuditoria({
      db,
      empresaId,
      usuarioId: actor.id,
      rolUsuario: actor.rol,
      accion: 'MODIFICACION_CATALOGO',
      entidadAfectada: 'usuarios',
      entidadId: id,
      detalle: { operacion: 'CREAR_EMPLEADO', username, rol },
    });
  }

  return db
    .prepare('SELECT id, empresa_id, nombre, username, email, rol, activo, creado_en FROM usuarios WHERE id = ?')
    .get(id);
}

function crearClienteFiado(db = getDb(), { nombre, documento_telefono = '', limite_credito = 0 }, actor) {
  if (!nombre || Number(limite_credito) < 0) {
    throw new Error('Nombre válido y límite de crédito >= 0 son obligatorios.');
  }
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const id = `cli-${uuidv7().slice(-8)}`;
  db.prepare(`
    INSERT INTO clientes_fiado (id, empresa_id, nombre, documento_telefono, limite_credito, saldo_deudor, activo)
    VALUES (?, ?, ?, ?, ?, 0, 1)
  `).run(id, empresaId, String(nombre).trim(), documento_telefono, Number(limite_credito));

  if (actor) {
    registrarAuditoria({
      db,
      empresaId,
      usuarioId: actor.id,
      rolUsuario: actor.rol,
      accion: 'MODIFICACION_CATALOGO',
      entidadAfectada: 'clientes_fiado',
      entidadId: id,
      detalle: { operacion: 'CREAR_CLIENTE_FIADO', nombre, limite_credito },
    });
  }

  return db.prepare('SELECT * FROM clientes_fiado WHERE id = ? AND empresa_id = ?').get(id, empresaId);
}

module.exports = {
  obtenerSnapshotCatalogos,
  crearRubro,
  editarRubro,
  eliminarRubro,
  crearEmpleado,
  crearClienteFiado,
};
