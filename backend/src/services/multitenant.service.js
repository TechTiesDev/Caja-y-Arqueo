const { uuidv7 } = require('../utils/uuidv7');
const { hashPin, verifyPin, issueSessionTokens } = require('../utils/crypto');
const { getDb, seedCompanyCatalogs } = require('../db/database');

/**
 * 4.1. Creación de Empresa y su Primer Dueño en una única transacción atómica.
 */
function registerEmpresa(
  db = getDb(),
  {
    nombre_empresa,
    nombre,
    identificador_fiscal = null,
    telefono = null,
    email_empresa = null,
    direccion = null,
    nombre_dueno,
    email_dueno,
    username_dueno = null,
    telefono_dueno = null,
    password_dueno,
  }
) {
  const empName = String(nombre_empresa || nombre || '').trim();
  const duenoName = String(nombre_dueno || '').trim();
  const emailNorm = String(email_dueno || '').trim().toLowerCase();
  const usernameNorm = String(username_dueno || emailNorm).trim().toLowerCase();
  const pass = String(password_dueno || '');

  if (!empName || !duenoName || !emailNorm || !pass) {
    const err = new Error('Nombre de empresa, nombre del dueño, email y contraseña/PIN son obligatorios.');
    err.statusCode = 400;
    throw err;
  }

  const existente = db
    .prepare('SELECT id FROM usuarios WHERE LOWER(email) = ? OR LOWER(username) = ?')
    .get(emailNorm, usernameNorm);
  if (existente) {
    const err = new Error('Email o usuario ya registrado');
    err.statusCode = 409;
    throw err;
  }

  const empresaId = `emp-${uuidv7().slice(-10)}`;
  const duenoId = `usr-${uuidv7().slice(-10)}`;
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    db.prepare(`
      INSERT INTO empresas (id, nombre, identificador_fiscal, telefono, email, direccion, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(empresaId, empName, identificador_fiscal, telefono, email_empresa || emailNorm, direccion, now, now);

    const hashed = hashPin(pass);
    db.prepare(`
      INSERT INTO usuarios (id, empresa_id, nombre, username, email, telefono, pin_hash, password_hash, rol, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DUENO', 1, ?, ?)
    `).run(duenoId, empresaId, duenoName, usernameNorm, emailNorm, telefono_dueno, hashed, hashed, now, now);

    seedCompanyCatalogs(db, empresaId, false);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }

  const dueno = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(duenoId);
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);
  const tokens = issueSessionTokens(dueno, empresa.nombre);

  return {
    ...tokens,
    empresa,
    usuario: {
      id: dueno.id,
      empresa_id: dueno.empresa_id,
      empresa_nombre: empresa.nombre,
      nombre: dueno.nombre,
      username: dueno.username,
      email: dueno.email,
      rol: dueno.rol,
    },
  };
}

/**
 * 4.2. Alta y Edición de Usuarios Internos de la Empresa (DUENO / SUPERVISOR / CAJERO / EMPLEADO).
 */
function normalizarRolInterno(rolInput) {
  if (!rolInput) return 'CAJERO';
  const r = String(rolInput).trim().toUpperCase();
  if (r === 'SOPORTE') {
    const err = new Error('PROHIBIDO: No puede asignar el rol SOPORTE desde la gestión de empresa.');
    err.statusCode = 403;
    throw err;
  }
  if (r === 'EMPLEADO') return 'CAJERO';
  if (!['DUENO', 'SUPERVISOR', 'CAJERO'].includes(r)) {
    const err = new Error('Rol inválido. Use DUENO, SUPERVISOR o CAJERO.');
    err.statusCode = 400;
    throw err;
  }
  return r;
}

function listarUsuariosEmpresa(db = getDb(), actor) {
  return db
    .prepare(`
      SELECT id, empresa_id, nombre, username, email, telefono, rol, activo, creado_en, actualizado_en
      FROM usuarios
      WHERE empresa_id = ? AND rol IN ('DUENO', 'SUPERVISOR', 'CAJERO')
      ORDER BY nombre ASC
    `)
    .all(actor.empresa_id);
}

function crearUsuarioEmpresa(db = getDb(), payload, actor) {
  const rol = normalizarRolInterno(payload.rol);
  const nombre = String(payload.nombre || '').trim();
  const email = payload.email ? String(payload.email).trim().toLowerCase() : null;
  const username = String(payload.username || email || '').trim().toLowerCase();
  const pass = String(payload.password || payload.pin || '');

  if (!nombre || !username || !pass) {
    const err = new Error('Nombre, usuario/email y contraseña/PIN son obligatorios.');
    err.statusCode = 400;
    throw err;
  }

  const dup = db
    .prepare('SELECT id FROM usuarios WHERE LOWER(username) = ? OR (email IS NOT NULL AND LOWER(email) = ?)')
    .get(username, email || '');
  if (dup) {
    const err = new Error('El usuario o email ya existe.');
    err.statusCode = 409;
    throw err;
  }

  // Ignorar cualquier empresa_id enviado en el body y forzar siempre actor.empresa_id
  const id = `usr-${uuidv7().slice(-10)}`;
  const now = new Date().toISOString();
  const hashed = hashPin(pass);
  db.prepare(`
    INSERT INTO usuarios (id, empresa_id, nombre, username, email, telefono, pin_hash, password_hash, rol, activo, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    actor.empresa_id,
    nombre,
    username,
    email,
    payload.telefono || null,
    hashed,
    hashed,
    rol,
    now,
    now
  );

  return db
    .prepare('SELECT id, empresa_id, nombre, username, email, telefono, rol, activo, creado_en FROM usuarios WHERE id = ?')
    .get(id);
}

function editarUsuarioEmpresa(db = getDb(), targetId, payload, actor) {
  if (payload.rol !== undefined) {
    normalizarRolInterno(payload.rol);
  }

  const target = db
    .prepare("SELECT * FROM usuarios WHERE id = ? AND empresa_id = ? AND rol IN ('DUENO', 'SUPERVISOR', 'CAJERO')")
    .get(targetId, actor.empresa_id);

  if (!target) {
    const err = new Error('Usuario no encontrado en esta empresa.');
    err.statusCode = 404;
    throw err;
  }

  const nuevoNombre = payload.nombre !== undefined ? String(payload.nombre).trim() : target.nombre;
  const nuevoEmail = payload.email !== undefined ? String(payload.email).trim().toLowerCase() : target.email;
  const nuevoTel = payload.telefono !== undefined ? payload.telefono : target.telefono;
  const nuevoRol = payload.rol !== undefined ? normalizarRolInterno(payload.rol) : target.rol;
  const nuevoActivo = payload.activo !== undefined ? (payload.activo ? 1 : 0) : target.activo;
  const nuevoHash =
    payload.password || payload.pin
      ? hashPin(payload.password || payload.pin)
      : target.pin_hash || target.password_hash;

  db.prepare(`
    UPDATE usuarios
    SET nombre = ?, email = ?, telefono = ?, rol = ?, activo = ?, pin_hash = ?, password_hash = ?, actualizado_en = ?
    WHERE id = ? AND empresa_id = ?
  `).run(
    nuevoNombre,
    nuevoEmail,
    nuevoTel,
    nuevoRol,
    nuevoActivo,
    nuevoHash,
    nuevoHash,
    new Date().toISOString(),
    targetId,
    actor.empresa_id
  );

  return db
    .prepare('SELECT id, empresa_id, nombre, username, email, telefono, rol, activo, actualizado_en FROM usuarios WHERE id = ?')
    .get(targetId);
}

/**
 * 4.3. CRUD de Usuarios SOPORTE (/api/auth/soporte/usuarios).
 */
function exigirSoporteFueraDeEmpresa(actor) {
  if (!actor || actor.rol !== 'SOPORTE') {
    const err = new Error('Acceso exclusivo para el rol SOPORTE.');
    err.statusCode = 403;
    throw err;
  }
  if (actor.empresa_id) {
    const err = new Error('Debe salir de la empresa en mantenimiento antes de gestionar la plataforma.');
    err.statusCode = 403;
    throw err;
  }
}

function listarUsuariosSoporte(db = getDb(), actor) {
  exigirSoporteFueraDeEmpresa(actor);
  return db
    .prepare(`
      SELECT id, nombre, username, email, telefono, rol, activo, creado_en, actualizado_en
      FROM usuarios
      WHERE rol = 'SOPORTE'
      ORDER BY creado_en ASC
    `)
    .all();
}

function crearUsuarioSoporte(db = getDb(), payload, actor) {
  exigirSoporteFueraDeEmpresa(actor);
  const nombre = String(payload.nombre || '').trim();
  const email = String(payload.email || payload.username || '').trim().toLowerCase();
  const username = String(payload.username || email).trim().toLowerCase();
  const pass = String(payload.password || payload.pin || '');

  if (!nombre || !email || !pass) {
    const err = new Error('Nombre, email y contraseña/PIN son obligatorios.');
    err.statusCode = 400;
    throw err;
  }

  const dup = db
    .prepare('SELECT id FROM usuarios WHERE LOWER(email) = ? OR LOWER(username) = ?')
    .get(email, username);
  if (dup) {
    const err = new Error('El email o usuario ya está registrado.');
    err.statusCode = 409;
    throw err;
  }

  const id = `usr-sop-${uuidv7().slice(-8)}`;
  const now = new Date().toISOString();
  const hashed = hashPin(pass);
  db.prepare(`
    INSERT INTO usuarios (id, empresa_id, nombre, username, email, telefono, pin_hash, password_hash, rol, activo, creado_en, actualizado_en)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'SOPORTE', 1, ?, ?)
  `).run(id, nombre, username, email, payload.telefono || null, hashed, hashed, now, now);

  return db
    .prepare('SELECT id, empresa_id, nombre, username, email, telefono, rol, activo, creado_en FROM usuarios WHERE id = ?')
    .get(id);
}

function editarUsuarioSoporte(db = getDb(), targetId, payload, actor) {
  exigirSoporteFueraDeEmpresa(actor);
  const target = db.prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'SOPORTE'").get(targetId);
  if (!target) {
    const err = new Error('Usuario de Soporte no encontrado.');
    err.statusCode = 404;
    throw err;
  }

  const nuevoNombre = payload.nombre !== undefined ? String(payload.nombre).trim() : target.nombre;
  const nuevoEmail = payload.email !== undefined ? String(payload.email).trim().toLowerCase() : target.email;
  const nuevoTel = payload.telefono !== undefined ? payload.telefono : target.telefono;
  const nuevoActivo = payload.activo !== undefined ? (payload.activo ? 1 : 0) : target.activo;
  const nuevoHash =
    payload.password || payload.pin
      ? hashPin(payload.password || payload.pin)
      : target.pin_hash || target.password_hash;

  db.prepare(`
    UPDATE usuarios
    SET nombre = ?, email = ?, telefono = ?, activo = ?, pin_hash = ?, password_hash = ?, actualizado_en = ?
    WHERE id = ? AND rol = 'SOPORTE'
  `).run(nuevoNombre, nuevoEmail, nuevoTel, nuevoActivo, nuevoHash, nuevoHash, new Date().toISOString(), targetId);

  return db
    .prepare('SELECT id, empresa_id, nombre, username, email, telefono, rol, activo, actualizado_en FROM usuarios WHERE id = ?')
    .get(targetId);
}

function eliminarUsuarioSoporte(db = getDb(), targetId, actor) {
  exigirSoporteFueraDeEmpresa(actor);
  if (targetId === actor.id) {
    const err = new Error('No puedes eliminar tu propio usuario en sesión');
    err.statusCode = 400;
    throw err;
  }
  const target = db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'SOPORTE'").get(targetId);
  if (!target) {
    const err = new Error('Usuario de Soporte no encontrado.');
    err.statusCode = 404;
    throw err;
  }
  db.prepare("DELETE FROM usuarios WHERE id = ? AND rol = 'SOPORTE'").run(targetId);
  return { eliminado: true, id: targetId };
}

/**
 * 4.4. Listado de Empresas e Inmersión Contextual del Soporte (Modo Mantenimiento).
 */
function listarEmpresasParaSoporte(db = getDb(), actor, search = '') {
  exigirSoporteFueraDeEmpresa(actor);
  const q = `%${String(search || '').trim().toLowerCase()}%`;
  return db
    .prepare(`
      SELECT
        e.*,
        (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id AND u.rol != 'SOPORTE') AS total_usuarios,
        (SELECT COUNT(*) FROM ventas v WHERE v.empresa_id = e.id AND v.estado = 'COMPLETADA') AS total_ventas
      FROM empresas e
      WHERE LOWER(e.nombre) LIKE ?
         OR LOWER(COALESCE(e.identificador_fiscal, '')) LIKE ?
         OR LOWER(COALESCE(e.direccion, '')) LIKE ?
      ORDER BY e.creado_en DESC
    `)
    .all(q, q, q);
}

function ingresarEmpresaSoporte(db = getDb(), empresaId, actor, ipOrigen = '127.0.0.1') {
  if (!actor || actor.rol !== 'SOPORTE') {
    const err = new Error('Solo el rol SOPORTE puede ingresar en modo mantenimiento.');
    err.statusCode = 403;
    throw err;
  }
  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);
  if (!empresa) {
    const err = new Error('Empresa no encontrada.');
    err.statusCode = 404;
    throw err;
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE usuarios SET empresa_id = ?, actualizado_en = ? WHERE id = ?').run(
    empresa.id,
    now,
    actor.id
  );

  db.prepare(`
    INSERT INTO soporte_accesos_log (id, soporte_user_id, empresa_id, accion, ip_origen, creado_en)
    VALUES (?, ?, ?, 'INGRESO', ?, ?)
  `).run(uuidv7(), actor.id, empresa.id, ipOrigen, now);

  const userActualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(actor.id);
  const tokens = issueSessionTokens(userActualizado, empresa.nombre);

  return {
    ...tokens,
    empresa_id: empresa.id,
    empresa_nombre: empresa.nombre,
    usuario: {
      id: userActualizado.id,
      nombre: userActualizado.nombre,
      username: userActualizado.username,
      email: userActualizado.email,
      rol: userActualizado.rol,
      empresa_id: empresa.id,
      empresa_nombre: empresa.nombre,
    },
  };
}

function salirEmpresaSoporte(db = getDb(), actor, ipOrigen = '127.0.0.1') {
  if (!actor || actor.rol !== 'SOPORTE') {
    const err = new Error('Solo el rol SOPORTE puede salir del modo mantenimiento.');
    err.statusCode = 403;
    throw err;
  }

  const now = new Date().toISOString();
  const prevEmpresaId =
    actor.empresa_id || db.prepare('SELECT empresa_id FROM usuarios WHERE id = ?').get(actor.id)?.empresa_id;

  if (prevEmpresaId) {
    db.prepare(`
      INSERT INTO soporte_accesos_log (id, soporte_user_id, empresa_id, accion, ip_origen, creado_en)
      VALUES (?, ?, ?, 'SALIDA', ?, ?)
    `).run(uuidv7(), actor.id, prevEmpresaId, ipOrigen, now);
  }

  db.prepare('UPDATE usuarios SET empresa_id = NULL, actualizado_en = ? WHERE id = ?').run(now, actor.id);

  const userActualizado = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(actor.id);
  userActualizado.empresa_id = null;
  const tokens = issueSessionTokens(userActualizado, null);

  return {
    ...tokens,
    empresa_id: null,
    empresa_nombre: null,
    usuario: {
      id: userActualizado.id,
      nombre: userActualizado.nombre,
      username: userActualizado.username,
      email: userActualizado.email,
      rol: userActualizado.rol,
      empresa_id: null,
      empresa_nombre: null,
    },
  };
}

function cambiarPasswordPropia(db = getDb(), { password_actual, password_nueva }, actor) {
  if (!password_actual || !password_nueva) {
    const err = new Error('Debe indicar la contraseña actual y la nueva contraseña.');
    err.statusCode = 400;
    throw err;
  }
  const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(actor.id);
  if (!user || !verifyPin(password_actual, user.pin_hash || user.password_hash)) {
    const err = new Error('La contraseña/PIN actual es incorrecta.');
    err.statusCode = 400;
    throw err;
  }
  const hashed = hashPin(password_nueva);
  db.prepare('UPDATE usuarios SET pin_hash = ?, password_hash = ?, actualizado_en = ? WHERE id = ?').run(
    hashed,
    hashed,
    new Date().toISOString(),
    actor.id
  );
  return { actualizado: true };
}

module.exports = {
  registerEmpresa,
  listarUsuariosEmpresa,
  crearUsuarioEmpresa,
  editarUsuarioEmpresa,
  listarUsuariosSoporte,
  crearUsuarioSoporte,
  editarUsuarioSoporte,
  eliminarUsuarioSoporte,
  listarEmpresasParaSoporte,
  ingresarEmpresaSoporte,
  salirEmpresaSoporte,
  cambiarPasswordPropia,
};
