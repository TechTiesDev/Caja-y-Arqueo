const { uuidv7 } = require('../../core/uuidv7');
const { hashPassword, verifyPassword, issueSessionTokens, verifyToken } = require('../../core/crypto');
const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} = require('../../core/errors');
const { recordAudit } = require('../audit/audit.module');

const ALLOWED_TENANT_ROLES = ['DUENO', 'SUPERVISOR', 'CAJERO', 'OPERADOR', 'CLIENTE'];

function sanitizeUser(u, empresaNombre = null) {
  return {
    id: u.id,
    empresa_id: u.empresa_id || null,
    empresa_nombre: empresaNombre || u.empresa_nombre || null,
    nombre: u.nombre,
    username: u.username,
    email: u.email,
    telefono: u.telefono,
    rol: u.rol,
    activo: Boolean(u.activo),
    creado_en: u.creado_en,
  };
}

const authModule = {
  name: 'auth',
  prefix: '/api/v1/auth',
  permissions: {
    SOPORTE_PLATAFORMA: ['SOPORTE'],
    GESTIONAR_USUARIOS_EMPRESA: ['DUENO', 'SOPORTE'],
  },
  routes: [
    {
      method: 'POST',
      path: '/login',
      public: true,
      handler: ({ db, body }) => {
        const identifier = String(body.identifier || body.username || body.email || '')
          .trim()
          .toLowerCase();
        const secret = String(body.password || body.pin || '');

        if (!identifier || !secret) {
          throw new ValidationError('Debe proporcionar usuario/email y contraseña/PIN.');
        }

        const user = db
          .prepare('SELECT * FROM usuarios WHERE LOWER(username) = ? OR LOWER(email) = ?')
          .get(identifier, identifier);

        if (
          !user ||
          !user.activo ||
          !verifyPassword(secret, user.password_hash || user.pin_hash)
        ) {
          throw new UnauthorizedError('Credenciales inválidas.');
        }

        // Regla 4.4 TallerApp: Si el usuario es SOPORTE, al iniciar sesión siempre arranca en consola global (empresa_id = NULL)
        let empresaNombre = null;
        if (user.rol === 'SOPORTE') {
          if (user.empresa_id !== null) {
            db.prepare('UPDATE usuarios SET empresa_id = NULL WHERE id = ?').run(user.id);
            user.empresa_id = null;
          }
        } else if (user.empresa_id) {
          const emp = db.prepare('SELECT * FROM empresas WHERE id = ?').get(user.empresa_id);
          if (!emp || !emp.activo) {
            throw new ForbiddenError('La empresa asociada al usuario está deshabilitada.');
          }
          empresaNombre = emp.nombre;
        }

        const tokens = issueSessionTokens(user, empresaNombre);
        return {
          status: 200,
          data: {
            ...tokens,
            usuario: sanitizeUser(user, empresaNombre),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/refresh',
      public: true,
      handler: ({ db, body }) => {
        const refreshToken = String(body.refresh_token || '').trim();
        const payload = verifyToken(refreshToken);
        if (!payload || payload.type !== 'refresh') {
          throw new UnauthorizedError('Refresh token inválido o expirado.');
        }

        const user = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(payload.sub || payload.id);
        if (!user || !user.activo) {
          throw new UnauthorizedError('Usuario inexistente o deshabilitado.');
        }

        const effectiveEmpresaId =
          user.rol === 'SOPORTE' ? payload.empresa_id || null : user.empresa_id;
        let empresaNombre = null;
        if (effectiveEmpresaId) {
          const emp = db.prepare('SELECT * FROM empresas WHERE id = ?').get(effectiveEmpresaId);
          if (emp && emp.activo) {
            empresaNombre = emp.nombre;
          }
        }

        const tokens = issueSessionTokens({ ...user, empresa_id: effectiveEmpresaId }, empresaNombre);
        return {
          status: 200,
          data: {
            ...tokens,
            usuario: sanitizeUser({ ...user, empresa_id: effectiveEmpresaId }, empresaNombre),
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/me',
      allowWithoutCompany: true,
      handler: ({ actor }) => {
        return {
          status: 200,
          data: {
            usuario: sanitizeUser(actor, actor.empresa_nombre),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/change-password',
      allowWithoutCompany: true,
      handler: ({ db, actor, body }) => {
        const currentPassword = String(body.current_password || body.password_actual || '');
        const newPassword = String(body.new_password || body.password_nueva || '').trim();

        if (
          !currentPassword ||
          !verifyPassword(currentPassword, actor.password_hash || actor.pin_hash)
        ) {
          throw new ValidationError('La contraseña actual es incorrecta.');
        }
        if (newPassword.length < 4) {
          throw new ValidationError('La nueva contraseña debe tener al menos 4 caracteres.');
        }

        const now = new Date().toISOString();
        const hashed = hashPassword(newPassword);
        db.prepare(
          'UPDATE usuarios SET password_hash = ?, pin_hash = ?, actualizado_en = ? WHERE id = ?'
        ).run(hashed, hashed, now, actor.id);

        recordAudit(db, {
          empresaId: actor.empresa_id || null,
          usuarioId: actor.id,
          rolUsuario: actor.rol,
          modulo: 'AUTH',
          accion: 'CAMBIO_PASSWORD_PROPIO',
          entidadAfectada: 'usuarios',
          entidadId: actor.id,
        });

        return { status: 200, data: { detail: 'Contraseña actualizada exitosamente.' } };
      },
    },
    // =========================================================================
    // CRUD DE USUARIOS DE SOPORTE (Exclusivo rol SOPORTE, referencia TallerApp)
    // =========================================================================
    {
      method: 'GET',
      path: '/soporte/usuarios',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db }) => {
        const rows = db
          .prepare("SELECT * FROM usuarios WHERE rol = 'SOPORTE' ORDER BY nombre ASC")
          .all();
        return {
          status: 200,
          data: {
            items: rows.map((r) => sanitizeUser({ ...r, empresa_id: null }, null)),
            total: rows.length,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/soporte/usuarios',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor, body }) => {
        const nombre = String(body.nombre || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const username = String(body.username || email).trim().toLowerCase();
        const password = String(body.password || body.pin || '').trim();
        const telefono = body.telefono ? String(body.telefono).trim() : null;

        if (!nombre || !email || !password) {
          throw new ValidationError(
            'nombre, email y password son obligatorios para crear un usuario SOPORTE.'
          );
        }

        const dup = db
          .prepare('SELECT id FROM usuarios WHERE LOWER(email) = ? OR LOWER(username) = ?')
          .get(email, username);
        if (dup) {
          throw new ConflictError('Ya existe un usuario con ese email o username.');
        }

        const id = uuidv7();
        const now = new Date().toISOString();
        const hashed = hashPassword(password);
        db.prepare(`
          INSERT INTO usuarios (id, empresa_id, nombre, username, email, telefono, pin_hash, password_hash, rol, activo, creado_en, actualizado_en)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'SOPORTE', 1, ?, ?)
        `).run(id, nombre, username, email, telefono, hashed, hashed, now, now);

        recordAudit(db, {
          empresaId: null,
          usuarioId: actor.id,
          rolUsuario: 'SOPORTE',
          modulo: 'AUTH',
          accion: 'ALTA_USUARIO_SOPORTE',
          entidadAfectada: 'usuarios',
          entidadId: id,
          detalle: { email, nombre },
        });

        const created = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
        return { status: 201, data: { usuario: sanitizeUser(created, null) } };
      },
    },
    {
      method: 'PATCH',
      path: '/soporte/usuarios/:id',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor, params, body }) => {
        const target = db
          .prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'SOPORTE'")
          .get(params.id);
        if (!target) {
          throw new NotFoundError('Usuario Soporte no encontrado.');
        }

        const nextEmail =
          body.email !== undefined ? String(body.email).trim().toLowerCase() : target.email;
        if (nextEmail !== target.email) {
          const dup = db
            .prepare('SELECT id FROM usuarios WHERE LOWER(email) = ? AND id != ?')
            .get(nextEmail, target.id);
          if (dup) {
            throw new ConflictError('Ya existe otro usuario con ese email.');
          }
        }

        const nextNombre = body.nombre !== undefined ? String(body.nombre).trim() : target.nombre;
        const nextTelefono =
          body.telefono !== undefined
            ? String(body.telefono || '').trim() || null
            : target.telefono;
        const nextActivo = body.activo !== undefined ? (body.activo ? 1 : 0) : target.activo;
        const nextPasswordHash =
          body.password && String(body.password).trim()
            ? hashPassword(String(body.password).trim())
            : target.password_hash || target.pin_hash;
        const now = new Date().toISOString();

        db.prepare(`
          UPDATE usuarios
          SET nombre = ?, email = ?, username = ?, telefono = ?, activo = ?, password_hash = ?, pin_hash = ?, actualizado_en = ?
          WHERE id = ?
        `).run(
          nextNombre,
          nextEmail,
          nextEmail,
          nextTelefono,
          nextActivo,
          nextPasswordHash,
          nextPasswordHash,
          now,
          target.id
        );

        recordAudit(db, {
          empresaId: null,
          usuarioId: actor.id,
          rolUsuario: 'SOPORTE',
          modulo: 'AUTH',
          accion: 'ACTUALIZAR_USUARIO_SOPORTE',
          entidadAfectada: 'usuarios',
          entidadId: target.id,
          detalle: { nombre: nextNombre, email: nextEmail, activo: Boolean(nextActivo) },
        });

        const updated = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(target.id);
        return { status: 200, data: { usuario: sanitizeUser(updated, null) } };
      },
    },
    {
      method: 'DELETE',
      path: '/soporte/usuarios/:id',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor, params }) => {
        if (params.id === actor.id) {
          throw new ValidationError('No podés eliminar tu propio usuario Soporte en sesión.');
        }
        const target = db
          .prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'SOPORTE'")
          .get(params.id);
        if (!target) {
          throw new NotFoundError('Usuario Soporte no encontrado.');
        }

        db.prepare('DELETE FROM usuarios WHERE id = ?').run(target.id);

        recordAudit(db, {
          empresaId: null,
          usuarioId: actor.id,
          rolUsuario: 'SOPORTE',
          modulo: 'AUTH',
          accion: 'ELIMINAR_USUARIO_SOPORTE',
          entidadAfectada: 'usuarios',
          entidadId: target.id,
          detalle: { email: target.email },
        });

        return { status: 200, data: { deleted_id: target.id } };
      },
    },
    // =========================================================================
    // CRUD DE USUARIOS DE LA EMPRESA ACTIVA (DUENO o SOPORTE en mantenimiento)
    // =========================================================================
    {
      method: 'GET',
      path: '/usuarios',
      permission: 'GESTIONAR_USUARIOS_EMPRESA',
      handler: ({ db, actor }) => {
        const rows = db
          .prepare(
            `SELECT * FROM usuarios
             WHERE empresa_id = ? AND rol != 'SOPORTE'
             ORDER BY nombre ASC`
          )
          .all(actor.empresa_id);
        return {
          status: 200,
          data: {
            items: rows.map((r) => sanitizeUser(r, actor.empresa_nombre)),
            total: rows.length,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/usuarios',
      permission: 'GESTIONAR_USUARIOS_EMPRESA',
      handler: ({ db, actor, body }) => {
        const rol = String(body.rol || 'CAJERO').trim().toUpperCase();
        if (rol === 'SOPORTE') {
          throw new ForbiddenError(
            'PROHIBIDO: No se puede crear ni promover usuarios al rol global SOPORTE desde una empresa.'
          );
        }
        if (!ALLOWED_TENANT_ROLES.includes(rol)) {
          throw new ValidationError(`Rol inválido. Permitidos: ${ALLOWED_TENANT_ROLES.join(', ')}`);
        }

        const nombre = String(body.nombre || '').trim();
        const email = body.email ? String(body.email).trim().toLowerCase() : null;
        const username = String(body.username || email || '').trim().toLowerCase();
        const password = String(body.password || body.pin || '');

        if (!nombre || !username || !password) {
          throw new ValidationError('nombre, username/email y password/pin son obligatorios.');
        }

        const dup = db
          .prepare(
            'SELECT id FROM usuarios WHERE LOWER(username) = ? OR (email IS NOT NULL AND LOWER(email) = ?)'
          )
          .get(username, email || '');
        if (dup) {
          throw new ConflictError('El usuario o email ya existe.');
        }

        const id = uuidv7();
        const now = new Date().toISOString();
        const hashed = hashPassword(password);
        // Aislamiento estricto: se ignora cualquier `empresa_id` del body y se fuerza `actor.empresa_id`
        db.prepare(`
          INSERT INTO usuarios (id, empresa_id, nombre, username, email, telefono, pin_hash, password_hash, rol, activo, creado_en, actualizado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          id,
          actor.empresa_id,
          nombre,
          username,
          email,
          body.telefono || null,
          hashed,
          hashed,
          rol,
          now,
          now
        );

        recordAudit(db, {
          empresaId: actor.empresa_id,
          usuarioId: actor.id,
          rolUsuario: actor.rol,
          modulo: 'AUTH',
          accion: 'ALTA_USUARIO_EMPRESA',
          entidadAfectada: 'usuarios',
          entidadId: id,
          detalle: { username, rol },
        });

        const created = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
        return {
          status: 201,
          data: { usuario: sanitizeUser(created, actor.empresa_nombre) },
        };
      },
    },
    {
      method: 'PATCH',
      path: '/usuarios/:id',
      permission: 'GESTIONAR_USUARIOS_EMPRESA',
      handler: ({ db, actor, params, body }) => {
        const target = db
          .prepare("SELECT * FROM usuarios WHERE id = ? AND empresa_id = ? AND rol != 'SOPORTE'")
          .get(params.id, actor.empresa_id);
        if (!target) {
          throw new NotFoundError('Usuario no encontrado en la empresa activa.');
        }

        let nextRol = target.rol;
        if (body.rol !== undefined) {
          nextRol = String(body.rol).trim().toUpperCase();
          if (nextRol === 'SOPORTE') {
            throw new ForbiddenError('PROHIBIDO: No se puede promover un usuario al rol SOPORTE.');
          }
          if (!ALLOWED_TENANT_ROLES.includes(nextRol)) {
            throw new ValidationError(`Rol inválido. Permitidos: ${ALLOWED_TENANT_ROLES.join(', ')}`);
          }
        }

        const nextNombre = body.nombre !== undefined ? String(body.nombre).trim() : target.nombre;
        const nextActivo = body.activo !== undefined ? (body.activo ? 1 : 0) : target.activo;
        const nextPasswordHash =
          body.password && String(body.password).trim()
            ? hashPassword(String(body.password).trim())
            : target.password_hash || target.pin_hash;
        const now = new Date().toISOString();

        db.prepare(`
          UPDATE usuarios
          SET nombre = ?, rol = ?, activo = ?, password_hash = ?, pin_hash = ?, actualizado_en = ?
          WHERE id = ? AND empresa_id = ?
        `).run(
          nextNombre,
          nextRol,
          nextActivo,
          nextPasswordHash,
          nextPasswordHash,
          now,
          target.id,
          actor.empresa_id
        );

        const updated = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(target.id);
        return { status: 200, data: { usuario: sanitizeUser(updated, actor.empresa_nombre) } };
      },
    },
  ],
};

module.exports = { authModule, sanitizeUser };
