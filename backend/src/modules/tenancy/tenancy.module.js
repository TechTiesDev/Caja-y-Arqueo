const { uuidv7 } = require('../../core/uuidv7');
const { hashPassword, issueSessionTokens } = require('../../core/crypto');
const { ValidationError, ConflictError, NotFoundError } = require('../../core/errors');
const { recordAudit } = require('../audit/audit.module');
const { seedCompanyCatalogs } = require('../../db/database');

function registerEmpresaWithOwner(db, body = {}) {
  const nombreEmpresa = String(body.nombre_empresa || body.nombre || '').trim();
  const nombreDueno = String(body.nombre_dueno || '').trim();
  const emailDueno = String(body.email_dueno || '').trim().toLowerCase();
  const usernameDueno = String(body.username_dueno || emailDueno).trim().toLowerCase();
  const passwordDueno = String(body.password_dueno || '');

  if (!nombreEmpresa || !nombreDueno || !emailDueno || !passwordDueno) {
    throw new ValidationError(
      'nombre_empresa, nombre_dueno, email_dueno y password_dueno son obligatorios.'
    );
  }

  const dup = db
    .prepare('SELECT id FROM usuarios WHERE LOWER(email) = ? OR LOWER(username) = ?')
    .get(emailDueno, usernameDueno);
  if (dup) {
    throw new ConflictError('El email o username ya se encuentra registrado.');
  }

  const empresaId = uuidv7();
  const duenoId = uuidv7();
  const now = new Date().toISOString();
  const hashed = hashPassword(passwordDueno);
  const slug =
    body.slug ||
    `${nombreEmpresa
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')}-${empresaId.slice(-6)}`;

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    db.prepare(`
      INSERT INTO empresas (id, nombre, slug, identificador_fiscal, telefono, email, direccion, config_json, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      empresaId,
      nombreEmpresa,
      slug,
      body.identificador_fiscal || null,
      body.telefono || null,
      body.email_empresa || emailDueno,
      body.direccion || null,
      JSON.stringify(body.config || {}),
      now,
      now
    );

    db.prepare(`
      INSERT INTO usuarios (id, empresa_id, nombre, username, email, telefono, pin_hash, password_hash, rol, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DUENO', 1, ?, ?)
    `).run(
      duenoId,
      empresaId,
      nombreDueno,
      usernameDueno,
      emailDueno,
      body.telefono_dueno || null,
      hashed,
      hashed,
      now,
      now
    );

    seedCompanyCatalogs(db, empresaId, false);

    recordAudit(db, {
      empresaId,
      usuarioId: duenoId,
      rolUsuario: 'DUENO',
      modulo: 'TENANCY',
      accion: 'ALTA_EMPRESA',
      entidadAfectada: 'empresas',
      entidadId: empresaId,
      detalle: { nombre_empresa: nombreEmpresa, dueno_email: emailDueno },
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(empresaId);
  const dueno = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(duenoId);
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

const tenancyModule = {
  name: 'tenancy',
  prefix: '/api/v1/empresas',
  permissions: {
    SOPORTE_PLATAFORMA: ['SOPORTE'],
  },
  routes: [
    {
      method: 'POST',
      path: '/registro',
      public: true,
      handler: ({ db, body }) => {
        const result = registerEmpresaWithOwner(db, body);
        return { status: 201, data: result };
      },
    },
    {
      method: 'GET',
      path: '',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, query }) => {
        const search = (query.get('q') || '').trim().toLowerCase();
        const rows = search
          ? db
              .prepare('SELECT * FROM empresas WHERE LOWER(nombre) LIKE ? ORDER BY creado_en DESC')
              .all(`%${search}%`)
          : db.prepare('SELECT * FROM empresas ORDER BY creado_en DESC').all();
        return { status: 200, data: { items: rows, total: rows.length } };
      },
    },
    {
      method: 'POST',
      path: '/:id/ingresar',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor, params, req }) => {
        const empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(params.id);
        if (!empresa) {
          throw new NotFoundError('Empresa no encontrada.');
        }

        const logId = uuidv7();
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
        db.prepare(`
          INSERT INTO soporte_accesos_log (id, soporte_user_id, empresa_id, accion, ip_origen)
          VALUES (?, ?, ?, 'INGRESO', ?)
        `).run(logId, actor.id, empresa.id, String(ip));

        recordAudit(db, {
          empresaId: empresa.id,
          usuarioId: actor.id,
          rolUsuario: 'SOPORTE',
          modulo: 'TENANCY',
          accion: 'SOPORTE_INGRESO_EMPRESA',
          entidadAfectada: 'empresas',
          entidadId: empresa.id,
          detalle: { ip_origen: String(ip) },
        });

        const immersedUser = { ...actor, empresa_id: empresa.id };
        const tokens = issueSessionTokens(immersedUser, empresa.nombre);
        return {
          status: 200,
          data: {
            ...tokens,
            empresa,
            modo_soporte_activo: true,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/salir',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor, req }) => {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
        if (actor.empresa_id) {
          db.prepare(`
            INSERT INTO soporte_accesos_log (id, soporte_user_id, empresa_id, accion, ip_origen)
            VALUES (?, ?, ?, 'SALIDA', ?)
          `).run(uuidv7(), actor.id, actor.empresa_id, String(ip));
        }

        const globalUser = { ...actor, empresa_id: null };
        const tokens = issueSessionTokens(globalUser, null);
        return {
          status: 200,
          data: {
            ...tokens,
            empresa: null,
            modo_soporte_activo: false,
          },
        };
      },
    },
  ],
};

module.exports = { tenancyModule, registerEmpresaWithOwner };
