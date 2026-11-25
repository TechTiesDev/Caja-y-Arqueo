const { verifyToken } = require('./crypto');
const { AppError, UnauthorizedError, ForbiddenError, NotFoundError } = require('./errors');
const { uuidv7 } = require('./uuidv7');
const { logger } = require('./logger');

function matchRoutePattern(pattern, pathname) {
  const patParts = pattern.split('/').filter(Boolean);
  const urlParts = pathname.split('/').filter(Boolean);
  if (patParts.length !== urlParts.length) return null;

  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    const p = patParts[i];
    const u = urlParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(u);
    } else if (p !== u) {
      return null;
    }
  }
  return params;
}

class ModuleRegistry {
  constructor({ dbGetter }) {
    this.dbGetter = dbGetter;
    this.modules = new Map();
    this.permissions = {};
    this.routes = [];
  }

  register(moduleDef) {
    if (!moduleDef || !moduleDef.name || !moduleDef.prefix) {
      throw new Error('Cada módulo debe definir `name` y `prefix`.');
    }
    if (this.modules.has(moduleDef.name)) {
      throw new Error(`El módulo '${moduleDef.name}' ya fue registrado.`);
    }

    this.modules.set(moduleDef.name, moduleDef);

    if (moduleDef.permissions) {
      for (const [permKey, allowedRoles] of Object.entries(moduleDef.permissions)) {
        this.permissions[permKey] = allowedRoles;
      }
    }

    for (const r of moduleDef.routes || []) {
      const cleanPrefix = moduleDef.prefix.replace(/\/+$/, '');
      const cleanPath = (r.path || '').replace(/^\/+/, '');
      const fullPath = cleanPath ? `${cleanPrefix}/${cleanPath}` : cleanPrefix;
      this.routes.push({
        moduleName: moduleDef.name,
        method: r.method.toUpperCase(),
        fullPath,
        public: Boolean(r.public),
        permission: r.permission || null,
        allowWithoutCompany: Boolean(r.allowWithoutCompany),
        handler: r.handler,
      });
    }
  }

  listModules() {
    return Array.from(this.modules.values()).map((m) => ({
      name: m.name,
      prefix: m.prefix,
      routesCount: (m.routes || []).length,
    }));
  }

  authenticate(req, db, { allowWithoutCompany = false } = {}) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) {
      throw new UnauthorizedError('Se requiere encabezado Authorization: Bearer <token>.');
    }

    const payload = verifyToken(token);
    if (!payload || payload.type === 'refresh') {
      throw new UnauthorizedError('Token inválido o expirado.');
    }

    const user = db
      .prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1')
      .get(payload.sub || payload.id);

    if (!user) {
      throw new UnauthorizedError('El usuario de la sesión no existe o fue desactivado.');
    }

    // Regla 4.4 TallerApp: Si el usuario es SOPORTE, su contexto de inmersión proviene del JWT o DB
    const effectiveEmpresaId =
      user.rol === 'SOPORTE' ? payload.empresa_id || user.empresa_id || null : user.empresa_id;

    if (!effectiveEmpresaId && !allowWithoutCompany) {
      if (user.rol === 'SOPORTE') {
        throw new ForbiddenError(
          'SOPORTE: Debe ingresar primero a una empresa en Modo Mantenimiento para operar este módulo.'
        );
      }
      throw new ForbiddenError('El usuario no tiene una empresa activa asignada.');
    }

    let empresaNombre = null;
    if (effectiveEmpresaId) {
      const emp = db
        .prepare('SELECT id, nombre, activo FROM empresas WHERE id = ?')
        .get(effectiveEmpresaId);
      if (!emp || !emp.activo) {
        throw new ForbiddenError('La empresa activa no existe o se encuentra suspendida.');
      }
      empresaNombre = emp.nombre;
    }

    return {
      ...user,
      empresa_id: effectiveEmpresaId,
      empresa_nombre: empresaNombre,
    };
  }

  authorize(actor, permissionKey) {
    if (!permissionKey) return;
    const allowedRoles = this.permissions[permissionKey];
    if (!allowedRoles || !allowedRoles.includes(actor.rol)) {
      throw new ForbiddenError(
        `Permiso denegado: '${permissionKey}' requiere uno de [${(allowedRoles || []).join(', ')}].`
      );
    }
  }

  async dispatch(req, res, readBodyFn, sendJsonFn) {
    const requestId = req.headers['x-request-id'] || uuidv7();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();
    const db = this.dbGetter();

    try {
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const params = matchRoutePattern(route.fullPath, pathname);
        if (!params) continue;

        let actor = null;
        if (!route.public) {
          actor = this.authenticate(req, db, {
            allowWithoutCompany: route.allowWithoutCompany,
          });
          if (route.permission) {
            this.authorize(actor, route.permission);
          }
        }

        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
          ? await readBodyFn(req)
          : {};

        const result = await route.handler({
          req,
          res,
          db,
          actor,
          params,
          query: url.searchParams,
          body,
          requestId,
        });

        if (result && result.__rawSent) return;

        const statusCode = result?.status || 200;
        const data = result?.data !== undefined ? result.data : result;
        return sendJsonFn(res, statusCode, {
          ok: true,
          data,
          request_id: requestId,
        });
      }

      throw new NotFoundError(`Endpoint no encontrado: ${method} ${pathname}`);
    } catch (err) {
      const status = err instanceof AppError ? err.statusCode : err.statusCode || 400;
      const code = err instanceof AppError ? err.code : 'APP_ERROR';
      if (status >= 500) {
        logger.error(err.message, { requestId, pathname, method });
      }
      return sendJsonFn(res, status, {
        ok: false,
        error: {
          code,
          message: err.message || 'Error interno del servidor',
          details: err.details || null,
          request_id: requestId,
        },
      });
    }
  }
}

module.exports = { ModuleRegistry, matchRoutePattern };
