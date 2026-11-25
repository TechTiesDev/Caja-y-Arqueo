const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase, setDb } = require('../src/core/database');
const { createModularApp } = require('../src/app');
const { uuidv7 } = require('../src/core/uuidv7');
const { config } = require('../src/core/config');

describe('Core Blueprint Modular + Caja y Arqueo: Suite Integral (Tenancy, Auth/RBAC, SOPORTE, Audit RNF-04, Storage/Backups y Dominio)', () => {
  let db;
  let app;
  let tokenDuenoA;
  let tokenDuenoB;
  let tokenCajeroA;
  let tokenSoporte;
  let empresaAId;
  let empresaBId;

  async function request(urlPath, { method = 'GET', token = null, body = null } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = urlPath;
    req.headers = { host: 'localhost' };
    if (token) {
      req.headers['authorization'] = `Bearer ${token}`;
    }

    let statusCode = 200;
    let rawBody = '';
    const res = {
      writeHead(code) {
        statusCode = code;
      },
      end(chunk) {
        if (chunk) rawBody += chunk;
      },
    };

    const promise = app.handleRequest(req, res);
    if (body !== null) {
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.emit('end');
    await promise;

    return {
      status: statusCode,
      payload: rawBody ? JSON.parse(rawBody) : {},
    };
  }

  before(() => {
    process.env.LOG_SILENT = 'true';
    db = createDatabase(':memory:');
    setDb(db);
    app = createModularApp({ db });
  });

  after(() => {
    db.close();
  });

  it('1. Genera UUIDv7 (RFC 9562) ordenables cronológicamente para soporte Offline-First', () => {
    const u1 = uuidv7(1710000000000);
    const u2 = uuidv7(1710000050000);
    assert.ok(u1 < u2, 'UUIDv7 posterior debe ser lexicográficamente mayor');
    assert.match(u1, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('2. Módulo Tenancy + Módulo Caja y Arqueo: Crea 2 empresas y garantiza aislamiento Multi-Tenant estricto', async () => {
    // Registro Empresa A
    const regA = await request('/api/v1/empresas/registro', {
      method: 'POST',
      body: {
        nombre_empresa: 'Supermercado Alfa',
        nombre_dueno: 'Ana Alfa',
        email_dueno: 'ana@alfa.com',
        password_dueno: 'Alfa1234!',
      },
    });
    assert.equal(regA.status, 201);
    assert.equal(regA.payload.ok, true);
    tokenDuenoA = regA.payload.data.access_token;
    empresaAId = regA.payload.data.empresa.id;

    // Registro Empresa B
    const regB = await request('/api/v1/empresas/registro', {
      method: 'POST',
      body: {
        nombre_empresa: 'Minimercado Beta',
        nombre_dueno: 'Bruno Beta',
        email_dueno: 'bruno@beta.com',
        password_dueno: 'Beta1234!',
      },
    });
    assert.equal(regB.status, 201);
    tokenDuenoB = regB.payload.data.access_token;
    empresaBId = regB.payload.data.empresa.id;

    // Ambas empresas pueden crear un rubro con el mismo nombre gracias a UNIQUE(empresa_id, nombre)
    const rubA = await request('/api/v1/caja-arqueo/catalogos/rubros', {
      method: 'POST',
      token: tokenDuenoA,
      body: { nombre: 'Dietética Especial', color_hex: '#16A34A' },
    });
    assert.equal(rubA.status, 201);

    const rubB = await request('/api/v1/caja-arqueo/catalogos/rubros', {
      method: 'POST',
      token: tokenDuenoB,
      body: { nombre: 'Dietética Especial', color_hex: '#2563EB' },
    });
    assert.equal(rubB.status, 201);

    // Empresa B intenta eliminar el rubro de Empresa A -> 404 (Aislamiento estricto)
    const delCross = await request(
      `/api/v1/caja-arqueo/catalogos/rubros/${rubA.payload.data.rubro.id}`,
      {
        method: 'DELETE',
        token: tokenDuenoB,
      }
    );
    assert.equal(delCross.status, 404);
  });

  it('3. RBAC y Seguridad de Escalada: DUENO crea CAJERO, bloquea promoción a SOPORTE y CAJERO no puede gestionar usuarios', async () => {
    // Intento de crear usuario con rol SOPORTE desde un DUENO -> 403 Prohibido
    const attemptSoporte = await request('/api/v1/auth/usuarios', {
      method: 'POST',
      token: tokenDuenoA,
      body: {
        nombre: 'Hacker Escalada',
        username: 'hacker@alfa.com',
        password: '1234',
        rol: 'SOPORTE',
      },
    });
    assert.equal(attemptSoporte.status, 403);

    // DUENO crea un CAJERO válido (intentando inyectar empresa_id de Empresa B en body)
    const createOp = await request('/api/v1/auth/usuarios', {
      method: 'POST',
      token: tokenDuenoA,
      body: {
        nombre: 'Carlos Cajero',
        username: 'carlos@alfa.com',
        password: 'Oper1234!',
        rol: 'CAJERO',
        empresa_id: empresaBId, // Debe ser ignorado y forzado a empresaAId
      },
    });
    assert.equal(createOp.status, 201);
    assert.equal(createOp.payload.data.usuario.empresa_id, empresaAId);

    // Login del CAJERO y prueba de Refresh Token
    const loginOp = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { identifier: 'carlos@alfa.com', password: 'Oper1234!' },
    });
    assert.equal(loginOp.status, 200);
    tokenCajeroA = loginOp.payload.data.access_token;

    const refreshRes = await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refresh_token: loginOp.payload.data.refresh_token },
    });
    assert.equal(refreshRes.status, 200);
    assert.ok(refreshRes.payload.data.access_token);

    // CAJERO intenta crear otro usuario -> 403
    const opCreateUser = await request('/api/v1/auth/usuarios', {
      method: 'POST',
      token: tokenCajeroA,
      body: { nombre: 'Intruso', username: 'intruso@alfa.com', password: '1234' },
    });
    assert.equal(opCreateUser.status, 403);
  });

  it('4. Rol Global SOPORTE: Consola Global (empresa_id = NULL), Inmersión Contextual en Empresa, Salida y CRUD de Usuarios Soporte', async () => {
    const loginSop = await request('/api/v1/auth/login', {
      method: 'POST',
      body: {
        identifier: config.initialSoporteEmail,
        password: config.initialSoportePassword,
      },
    });
    assert.equal(loginSop.status, 200);
    assert.equal(loginSop.payload.data.usuario.rol, 'SOPORTE');
    assert.equal(loginSop.payload.data.usuario.empresa_id, null);
    tokenSoporte = loginSop.payload.data.access_token;

    // SOPORTE fuera de empresa intenta consultar catálogos de dominio -> 403 (debe ingresar primero)
    const noCompanyTry = await request('/api/v1/caja-arqueo/catalogos/snapshot', {
      token: tokenSoporte,
    });
    assert.equal(noCompanyTry.status, 403);

    // SOPORTE lista todas las empresas registradas
    const listEmp = await request('/api/v1/empresas', { token: tokenSoporte });
    assert.equal(listEmp.status, 200);
    assert.ok(listEmp.payload.data.items.length >= 2);

    // SOPORTE ingresa en Modo Mantenimiento a Empresa A
    const enterA = await request(`/api/v1/empresas/${empresaAId}/ingresar`, {
      method: 'POST',
      token: tokenSoporte,
    });
    assert.equal(enterA.status, 200);
    assert.equal(enterA.payload.data.modo_soporte_activo, true);
    const tokenSoporteInA = enterA.payload.data.access_token;

    // Ahora SOPORTE ve únicamente el catálogo de Empresa A
    const snapshotInA = await request('/api/v1/caja-arqueo/catalogos/snapshot', {
      token: tokenSoporteInA,
    });
    assert.equal(snapshotInA.status, 200);
    assert.equal(snapshotInA.payload.data.empresa_id, empresaAId);

    // SOPORTE sale de la empresa de regreso a la consola global
    const exitA = await request('/api/v1/empresas/salir', {
      method: 'POST',
      token: tokenSoporteInA,
    });
    assert.equal(exitA.status, 200);
    assert.equal(exitA.payload.data.modo_soporte_activo, false);
    tokenSoporte = exitA.payload.data.access_token;

    // CRUD de Usuarios Soporte + protección contra auto-eliminación
    const createSop2 = await request('/api/v1/auth/soporte/usuarios', {
      method: 'POST',
      token: tokenSoporte,
      body: {
        nombre: 'Soporte Nivel 2',
        email: 'soporte2@modular.local',
        password: 'Soporte2Pass!',
      },
    });
    assert.equal(createSop2.status, 201);
    const sop2Id = createSop2.payload.data.usuario.id;

    // Intento de auto-eliminación del usuario Soporte activo -> 400
    const selfDel = await request(
      `/api/v1/auth/soporte/usuarios/${loginSop.payload.data.usuario.id}`,
      {
        method: 'DELETE',
        token: tokenSoporte,
      }
    );
    assert.equal(selfDel.status, 400);

    // Eliminación de otro usuario Soporte -> 200
    const otherDel = await request(`/api/v1/auth/soporte/usuarios/${sop2Id}`, {
      method: 'DELETE',
      token: tokenSoporte,
    });
    assert.equal(otherDel.status, 200);
  });

  it('5. Auditoría Inmutable (Append-Only RNF-04): registra eventos y bloquea UPDATE/DELETE por triggers de base de datos', async () => {
    const logsRes = await request('/api/v1/auditoria', { token: tokenDuenoA });
    assert.equal(logsRes.status, 200);
    assert.ok(logsRes.payload.data.items.length >= 2);

    assert.throws(
      () => {
        db.prepare('DELETE FROM audit_logs').run();
      },
      /VIOLACION_SEGURIDAD_RNF04/,
      'El trigger SQLite debe abortar cualquier DELETE en audit_logs'
    );

    assert.throws(
      () => {
        db.prepare("UPDATE audit_logs SET accion = 'ALTERADO'").run();
      },
      /VIOLACION_SEGURIDAD_RNF04/,
      'El trigger SQLite debe abortar cualquier UPDATE en audit_logs'
    );
  });

  it('6. Storage, Cuota y Hot Backup SQLite (VACUUM INTO): verifica backup, restore, clear y checksum SHA-256', async () => {
    db.prepare(`
      INSERT INTO archivos_storage (id, empresa_id, modulo, entidad_id, ruta_objeto, url_publica, tamano_bytes)
      VALUES (?, ?, 'CAJA_ARQUEO', 'cierre-1', 'empresas/a/cierre-1.pdf', '/uploads/cierre-1.pdf', 524288)
    `).run(uuidv7(), empresaAId);

    const statusRes = await request('/api/v1/sistema/storage/status', { token: tokenDuenoA });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.payload.data.total_archivos, 1);

    const exportRes = await request('/api/v1/sistema/storage/backup', { token: tokenSoporte });
    assert.equal(exportRes.status, 200);
    const exportedManifest = exportRes.payload.data.manifest;
    assert.equal(exportedManifest.total_archivos, 1);

    const clearRes = await request('/api/v1/sistema/storage/clear', {
      method: 'DELETE',
      token: tokenSoporte,
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.payload.data.deleted_files, 1);

    const restoreRes = await request('/api/v1/sistema/storage/restore', {
      method: 'POST',
      token: tokenSoporte,
      body: { manifest: exportedManifest },
    });
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.payload.data.restored_files, 1);

    // Ejecución de Hot Backup SQLite con checksum SHA-256
    const backupRes = await request('/api/v1/sistema/backups/ejecutar', {
      method: 'POST',
      token: tokenSoporte,
    });
    assert.equal(backupRes.status, 201);
    const bkp = backupRes.payload.data.backup;
    assert.match(bkp.checksum_sha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(bkp.archivo));

    try {
      fs.unlinkSync(bkp.archivo);
      fs.rmdirSync(path.dirname(bkp.archivo));
    } catch {
      // Ignorar si el directorio contiene otros archivos
    }
  });

  it('7. Módulo Enchufable Caja y Arqueo (/api/v1/caja-arqueo/*): ciclo completo de apertura, venta por rubro, arqueo diferido y dashboard', async () => {
    const snapRes = await request('/api/v1/caja-arqueo/catalogos/snapshot', {
      token: tokenCajeroA,
    });
    assert.equal(snapRes.status, 200);
    const { rubros, mediosPago } = snapRes.payload.data;
    assert.ok(rubros.length >= 7);
    assert.equal(mediosPago.length, 5);

    const abrirRes = await request('/api/v1/caja-arqueo/turnos/abrir', {
      method: 'POST',
      token: tokenCajeroA,
      body: {
        puesto_caja: 'CAJA-01',
        nombre_turno: 'MANANA',
        fondo_inicial: 10000,
      },
    });
    assert.equal(abrirRes.status, 201);
    const turnoId = abrirRes.payload.data.turno.id;

    const mpEfectivo = mediosPago.find((m) => m.codigo === 'EFECTIVO');
    const ventaRes = await request('/api/v1/caja-arqueo/ventas', {
      method: 'POST',
      token: tokenCajeroA,
      body: {
        turno_id: turnoId,
        lineas: [{ rubro_id: rubros[0].id, cantidad: 2, subtotal: 4500 }],
        pagos: [{ medio_pago_id: mpEfectivo.id, monto: 4500 }],
        efectivo_recibido: 5000,
      },
    });
    assert.equal(ventaRes.status, 201);
    assert.equal(ventaRes.payload.data.venta.vuelto_entregado, 500);

    const dashRes = await request('/api/v1/caja-arqueo/analitica/dashboard', {
      token: tokenDuenoA,
    });
    assert.equal(dashRes.status, 200);
    assert.equal(dashRes.payload.data.kpis.recaudacion_total, 4500);
  });
});
