const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getDb, DEFAULT_EMPRESA_ID } = require('./db/database');
const { verifyPin, issueSessionTokens } = require('./utils/crypto');
const { requirePermission, getCurrentUser, extractUserFromRequest } = require('./middleware/rbac');
const {
  obtenerSnapshotCatalogos,
  crearRubro,
  editarRubro,
  eliminarRubro,
  crearEmpleado,
  crearClienteFiado,
} = require('./services/catalogos.service');
const { listarAuditoria, registrarAuditoria } = require('./services/audit.service');
const {
  abrirTurnoCaja,
  obtenerTurnoActivo,
  obtenerTurnosEnArqueo,
  iniciarCierreTurno,
  registrarMovimientoCaja,
  obtenerResumenAcotadoSupervisor,
  cerrarTurnoArqueoCiego,
} = require('./services/turnos.service');
const {
  registrarVenta,
  sincronizarVentasOffline,
  anularVenta,
  listarVentasRecientes,
  obtenerVentaPorId,
} = require('./services/ventas.service');
const { obtenerDashboardEnVivo, exportarReporte } = require('./services/analitica.service');
const {
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
} = require('./services/multitenant.service');
const { subscribeClient } = require('./services/sse.service');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Normalizar prefijo /auth/* -> /api/auth/* para compatibilidad con ambos esquemas
  const rawPathname = url.pathname;
  const pathname = rawPathname.startsWith('/auth/') ? `/api${rawPathname}` : rawPathname;
  const db = getDb();

  try {
    // 1. Healthcheck
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok',
        multitenant: true,
        modoSinStock: true,
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Autenticación por username/email + PIN/password
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const cred = String(body.username || body.email || '').trim().toLowerCase();
      const pass = String(body.pin || body.password || '');

      if (!cred || !pass) {
        return sendJson(res, 400, { error: 'Debe proporcionar usuario/email y PIN/contraseña.' });
      }

      const user = db
        .prepare(
          'SELECT * FROM usuarios WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND activo = 1'
        )
        .get(cred, cred);

      if (!user || !verifyPin(pass, user.pin_hash)) {
        return sendJson(res, 401, { error: 'Credenciales o PIN incorrectos.' });
      }

      let empresaNombre = null;
      // 4.4: Si user.rol == 'SOPORTE', limpiar siempre user.empresa_id = NULL en base de datos
      if (user.rol === 'SOPORTE') {
        db.prepare('UPDATE usuarios SET empresa_id = NULL WHERE id = ?').run(user.id);
        user.empresa_id = null;
      } else if (user.empresa_id) {
        const emp = db.prepare('SELECT * FROM empresas WHERE id = ?').get(user.empresa_id);
        if (!emp || !emp.activo) {
          return sendJson(res, 403, { error: 'La empresa asociada se encuentra inactiva.' });
        }
        empresaNombre = emp.nombre;
      }

      const tokens = issueSessionTokens(user, empresaNombre);

      return sendJson(res, 200, {
        ...tokens,
        usuario: {
          id: user.id,
          empresa_id: user.empresa_id,
          empresa_nombre: empresaNombre,
          nombre: user.nombre,
          username: user.username,
          email: user.email,
          rol: user.rol,
        },
      });
    }

    // 3. Registro autónomo de nueva Empresa y su primer Dueño (4.1)
    if (req.method === 'POST' && pathname === '/api/auth/register-empresa') {
      const body = await readJsonBody(req);
      const result = registerEmpresa(db, body);
      return sendJson(res, 201, result);
    }

    // 4. Sesión actual (/api/auth/me)
    if (req.method === 'GET' && pathname === '/api/auth/me') {
      const user = getCurrentUser(req, { db, allowWithoutCompany: true });
      return sendJson(res, 200, {
        usuario: {
          id: user.id,
          empresa_id: user.empresa_id,
          empresa_nombre: user.empresa_nombre || null,
          nombre: user.nombre,
          username: user.username,
          email: user.email,
          rol: user.rol,
        },
      });
    }

    // 5. Cambio de propia contraseña/PIN (permitido a todos los roles autenticados)
    if (req.method === 'POST' && pathname === '/api/auth/change-password') {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const body = await readJsonBody(req);
      const resPass = cambiarPasswordPropia(db, body, actor);
      return sendJson(res, 200, resPass);
    }

    // =========================================================================
    // ENDPOINTS DE CONSOLA SOPORTE E INMERSIÓN CONTEXTUAL (4.3 y 4.4)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/auth/empresas') {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const search = url.searchParams.get('q') || '';
      const empresas = listarEmpresasParaSoporte(db, actor, search);
      return sendJson(res, 200, { empresas });
    }

    const matchIngresarEmpresa = pathname.match(/^\/api\/auth\/empresas\/([^/]+)\/ingresar$/);
    if (req.method === 'POST' && matchIngresarEmpresa) {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const empresaId = decodeURIComponent(matchIngresarEmpresa[1]);
      const ip = req.socket?.remoteAddress || '127.0.0.1';
      const result = ingresarEmpresaSoporte(db, empresaId, actor, ip);
      return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/auth/empresas/salir') {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const ip = req.socket?.remoteAddress || '127.0.0.1';
      const result = salirEmpresaSoporte(db, actor, ip);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/auth/soporte/usuarios') {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const usuarios = listarUsuariosSoporte(db, actor);
      return sendJson(res, 200, { usuarios });
    }

    if (req.method === 'POST' && pathname === '/api/auth/soporte/usuarios') {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const body = await readJsonBody(req);
      const creado = crearUsuarioSoporte(db, body, actor);
      return sendJson(res, 201, creado);
    }

    const matchSoporteUserId = pathname.match(/^\/api\/auth\/soporte\/usuarios\/([^/]+)$/);
    if (matchSoporteUserId) {
      const actor = getCurrentUser(req, { db, allowWithoutCompany: true });
      const targetId = decodeURIComponent(matchSoporteUserId[1]);
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const editado = editarUsuarioSoporte(db, targetId, body, actor);
        return sendJson(res, 200, editado);
      }
      if (req.method === 'DELETE') {
        const eliminado = eliminarUsuarioSoporte(db, targetId, actor);
        return sendJson(res, 200, eliminado);
      }
    }

    // =========================================================================
    // GESTIÓN DE USUARIOS INTERNOS DE LA EMPRESA ACTIVA (4.2)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/auth/usuarios') {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const usuarios = listarUsuariosEmpresa(db, actor);
      return sendJson(res, 200, { usuarios });
    }

    if (req.method === 'POST' && pathname === '/api/auth/usuarios') {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const body = await readJsonBody(req);
      const creado = crearUsuarioEmpresa(db, body, actor);
      return sendJson(res, 201, creado);
    }

    const matchUsuarioInterno = pathname.match(/^\/api\/auth\/usuarios\/([^/]+)$/);
    if (req.method === 'PATCH' && matchUsuarioInterno) {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const targetId = decodeURIComponent(matchUsuarioInterno[1]);
      const body = await readJsonBody(req);
      const editado = editarUsuarioEmpresa(db, targetId, body, actor);
      return sendJson(res, 200, editado);
    }

    // =========================================================================
    // CATÁLOGOS ADMINISTRABLES POR EMPRESA
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/catalogos/snapshot') {
      const payload = extractUserFromRequest(req);
      let empresaId = DEFAULT_EMPRESA_ID;
      if (payload) {
        const actor = getCurrentUser(req, { db });
        empresaId = actor.empresa_id;
      }
      const snapshot = obtenerSnapshotCatalogos(db, empresaId);
      return sendJson(res, 200, snapshot);
    }

    if (req.method === 'POST' && pathname === '/api/catalogos/rubros') {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const body = await readJsonBody(req);
      const nuevoRubro = crearRubro(db, body, actor);
      return sendJson(res, 201, nuevoRubro);
    }

    const matchRubroId = pathname.match(/^\/api\/catalogos\/rubros\/([^/]+)$/);
    if (matchRubroId) {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const rubroId = decodeURIComponent(matchRubroId[1]);
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const editado = editarRubro(db, rubroId, body, actor);
        return sendJson(res, 200, editado);
      }
      if (req.method === 'DELETE') {
        const eliminado = eliminarRubro(db, rubroId, actor);
        return sendJson(res, 200, eliminado);
      }
    }

    if (req.method === 'POST' && pathname === '/api/catalogos/empleados') {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const body = await readJsonBody(req);
      const nuevoEmpleado = crearEmpleado(db, body, actor);
      return sendJson(res, 201, nuevoEmpleado);
    }

    if (req.method === 'POST' && pathname === '/api/catalogos/clientes-fiado') {
      const actor = requirePermission(req, 'ADMINISTRAR_CATALOGOS', { db });
      const body = await readJsonBody(req);
      const nuevoCliente = crearClienteFiado(db, body, actor);
      return sendJson(res, 201, nuevoCliente);
    }

    // =========================================================================
    // AUDITORÍA DE LA EMPRESA ACTIVA
    // =========================================================================
    if (req.method === 'POST' && pathname === '/api/auditoria/apertura-cajon') {
      const actor = requirePermission(req, 'ABRIR_CAJON_SIN_VENTA', { db });
      const { terminal = 'POS-01', motivo = 'Cambio / Revisión' } = await readJsonBody(req);
      const log = registrarAuditoria({
        db,
        empresaId: actor.empresa_id,
        usuarioId: actor.id,
        rolUsuario: actor.rol,
        terminal,
        accion: 'APERTURA_CAJON_SIN_VENTA',
        detalle: { motivo },
      });
      return sendJson(res, 201, log);
    }

    if (req.method === 'GET' && pathname === '/api/auditoria') {
      const actor = requirePermission(req, 'VER_AUDIT_LOGS', { db });
      const accion = url.searchParams.get('accion') || null;
      const limit = Number(url.searchParams.get('limit') || 100);
      const logs = listarAuditoria({ db, empresaId: actor.empresa_id, limit, accion });
      return sendJson(res, 200, { logs });
    }

    // =========================================================================
    // TURNOS, ENTRADAS/SALIDAS Y ARQUEO CIEGO (POR EMPRESA)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/turnos/activo') {
      const payload = extractUserFromRequest(req);
      let empresaId = DEFAULT_EMPRESA_ID;
      if (payload) {
        const actor = getCurrentUser(req, { db });
        empresaId = actor.empresa_id;
      }
      const puesto = url.searchParams.get('puesto_caja') || 'CAJA-01';
      const turno = obtenerTurnoActivo(db, puesto, empresaId);
      const turnosEnArqueo = obtenerTurnosEnArqueo(db, puesto, empresaId);
      return sendJson(res, 200, { turno: turno || null, turnos_en_arqueo: turnosEnArqueo });
    }

    if (req.method === 'POST' && pathname === '/api/turnos/abrir') {
      const actor = requirePermission(req, 'ABRIR_CAJA', { db });
      const body = await readJsonBody(req);
      const turno = abrirTurnoCaja(db, body, actor);
      return sendJson(res, 201, turno);
    }

    if (req.method === 'POST' && pathname === '/api/turnos/iniciar-cierre') {
      const actor = requirePermission(req, 'ARQUEO_CIEGO_CIERRE', { db });
      const body = await readJsonBody(req);
      const turnoEnArqueo = iniciarCierreTurno(db, body, actor);
      return sendJson(res, 200, turnoEnArqueo);
    }

    if (req.method === 'POST' && pathname === '/api/turnos/movimientos') {
      const actor = requirePermission(req, 'REGISTRAR_MOVIMIENTO_CAJA', { db });
      const body = await readJsonBody(req);
      const movimiento = registrarMovimientoCaja(db, body, actor);
      return sendJson(res, 201, movimiento);
    }

    if (req.method === 'GET' && pathname === '/api/turnos/resumen-supervisor') {
      const actor = requirePermission(req, 'VER_TOTAL_CAJA_TURNO_ACTIVO', { db });
      const turnoId = url.searchParams.get('turno_id');
      if (!turnoId) return sendJson(res, 400, { error: 'Debe indicar turno_id.' });
      const resumen = obtenerResumenAcotadoSupervisor(db, turnoId, actor);
      return sendJson(res, 200, resumen);
    }

    if (req.method === 'POST' && pathname === '/api/turnos/cerrar-arqueo') {
      const actor = requirePermission(req, 'ARQUEO_CIEGO_CIERRE', { db });
      const body = await readJsonBody(req);
      const resultado = cerrarTurnoArqueoCiego(db, body, actor);
      return sendJson(res, 200, resultado);
    }

    // =========================================================================
    // VENTAS POR RUBRO, PAGOS COMBINADOS Y SINCRONIZACIÓN OFFLINE (POR EMPRESA)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/ventas') {
      const actor = requirePermission(req, 'VER_REPORTES_Y_DASHBOARD_VIVO', { db });
      const turnoId = url.searchParams.get('turno_id') || null;
      const limit = Number(url.searchParams.get('limit') || 25);
      const ventas = listarVentasRecientes(db, {
        empresaId: actor.empresa_id,
        turno_id: turnoId,
        limit,
      });
      return sendJson(res, 200, { ventas });
    }

    const matchVentaId = pathname.match(/^\/api\/ventas\/([^/]+)$/);
    if (
      req.method === 'GET' &&
      matchVentaId &&
      !['offline-sync', 'anular'].includes(matchVentaId[1])
    ) {
      const actor = requirePermission(req, 'VER_REPORTES_Y_DASHBOARD_VIVO', { db });
      const venta = obtenerVentaPorId(db, decodeURIComponent(matchVentaId[1]), actor);
      return sendJson(res, 200, venta);
    }

    if (req.method === 'POST' && pathname === '/api/ventas') {
      const actor = requirePermission(req, 'REGISTRAR_VENTA', { db });
      const body = await readJsonBody(req);
      const venta = registrarVenta(db, body, actor);
      return sendJson(res, 201, venta);
    }

    if (req.method === 'POST' && pathname === '/api/ventas/offline-sync') {
      const actor = requirePermission(req, 'REGISTRAR_VENTA', { db });
      const body = await readJsonBody(req);
      const resultado = sincronizarVentasOffline(db, body, actor);
      return sendJson(res, 200, resultado);
    }

    if (req.method === 'POST' && pathname === '/api/ventas/anular') {
      const actor = requirePermission(req, 'ANULAR_VENTA_O_RUBRO', { db });
      const body = await readJsonBody(req);
      const ventaAnulada = anularVenta(db, body, actor);
      return sendJson(res, 200, ventaAnulada);
    }

    // =========================================================================
    // TABLERO EN VIVO, FILTROS Y EXPORTACIÓN EXCEL / PDF (POR EMPRESA)
    // =========================================================================
    if (req.method === 'GET' && pathname === '/api/analitica/dashboard') {
      const actor = requirePermission(req, 'VER_REPORTES_Y_DASHBOARD_VIVO', { db });
      const filtros = {
        empresa_id: actor.empresa_id,
        fecha: url.searchParams.get('fecha') || null,
        fecha_desde: url.searchParams.get('fecha_desde') || null,
        fecha_hasta: url.searchParams.get('fecha_hasta') || null,
        turno_id: url.searchParams.get('turno_id') || null,
        cajero_id: url.searchParams.get('cajero_id') || null,
        rubro_id: url.searchParams.get('rubro_id') || null,
      };
      const dashboard = obtenerDashboardEnVivo(db, filtros);
      return sendJson(res, 200, dashboard);
    }

    if (req.method === 'GET' && pathname === '/api/analitica/exportar') {
      const actor = requirePermission(req, 'EXPORTAR_EXCEL_PDF', { db });
      const formato = url.searchParams.get('formato') || 'excel';
      const filtros = {
        empresa_id: actor.empresa_id,
        fecha: url.searchParams.get('fecha') || null,
        turno_id: url.searchParams.get('turno_id') || null,
        cajero_id: url.searchParams.get('cajero_id') || null,
        rubro_id: url.searchParams.get('rubro_id') || null,
      };
      const archivo = exportarReporte(db, filtros, formato);
      res.writeHead(200, {
        'Content-Type': archivo.contentType,
        'Content-Disposition': `attachment; filename="${archivo.filename}"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(archivo.content);
    }

    if (req.method === 'GET' && pathname === '/api/analitica/stream') {
      return subscribeClient(res);
    }

    // =========================================================================
    // DESCARGA DIRECTA DEL PROTOTIPO APK ANDROID
    // =========================================================================
    if (req.method === 'GET' && pathname === '/descargar-apk') {
      const apkPath = path.join(__dirname, '..', '..', 'CajaYArqueo-prototipo.apk');
      if (fs.existsSync(apkPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Disposition': 'attachment; filename="CajaYArqueo-prototipo.apk"',
        });
        return res.end(fs.readFileSync(apkPath));
      }
    }

    // =========================================================================
    // SERVIDOR DE ARCHIVOS ESTÁTICOS FRONTEND
    // =========================================================================
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const cleanPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(FRONTEND_DIR, cleanPath);
      if (
        filePath.startsWith(FRONTEND_DIR) &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
        return res.end(fs.readFileSync(filePath));
      }
    }

    return sendJson(res, 404, { error: `Ruta no encontrada: ${req.method} ${pathname}` });
  } catch (err) {
    const status = err.statusCode || 400;
    return sendJson(res, status, { error: err.message || 'Error interno del servidor' });
  }
}

function createServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  getDb();
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Servidor Caja y Arqueo Multi-Tenant activo en http://localhost:${PORT}`);
  });
}

module.exports = { createServer, handleRequest };
