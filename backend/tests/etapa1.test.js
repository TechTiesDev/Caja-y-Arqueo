const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDatabase, setDb } = require('../src/db/database');
const { handleRequest } = require('../src/server');
const { uuidv7 } = require('../src/utils/uuidv7');

async function apiRequest(path, { method = 'GET', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = { host: 'localhost', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };

  let statusCode = 200;
  let responseBody = '';

  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end(chunk) {
      if (chunk) responseBody += chunk;
    },
  };

  const promise = handleRequest(req, res);
  if (body !== null) {
    req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
  }
  req.emit('end');
  await promise;

  return {
    status: statusCode,
    json: async () => (responseBody ? JSON.parse(responseBody) : {}),
  };
}

describe('Etapa 1: Modelo Sin Stock, Catálogos Administrables, RBAC 3 Roles y Audit Log Inalterable', () => {
  let db;
  let tokenDueno;
  let tokenSupervisor;
  let tokenCajero;

  before(() => {
    db = createDatabase(':memory:');
    setDb(db);
  });

  after(() => {
    db.close();
  });

  it('1. Genera UUIDv7 ordenables cronológicamente para soporte Offline sin colisiones', () => {
    const id1 = uuidv7(1700000000000);
    const id2 = uuidv7(1700000005000);
    assert.ok(id1 < id2, 'UUIDv7 posterior debe ser lexicográficamente mayor');
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('2. Verifica regla estructural Sin Stock: existen catálogos de rubros y 5 medios de pago sin tabla de productos individuales', async () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => t.name);

    assert.ok(!tables.includes('productos'), 'No debe existir tabla de productos individuales');
    assert.ok(!tables.includes('stock'), 'No debe existir tabla de control de stock');
    assert.ok(tables.includes('rubros'), 'Debe existir tabla de rubros');
    assert.ok(tables.includes('lineas_venta_rubro'), 'Debe existir tabla de líneas por rubro');

    const res = await apiRequest('/api/catalogos/snapshot');
    assert.equal(res.status, 200);
    const snapshot = await res.json();
    assert.ok(snapshot.rubros.length >= 6, 'Debe incluir los rubros iniciales (Almacén, Bebidas, Lácteos, etc.)');
    assert.equal(snapshot.mediosPago.length, 5, 'Debe incluir los 5 medios de pago requeridos en RF-10');
  });

  it('3. Autentica correctamente a los 3 roles estrictos: CAJERO, SUPERVISOR y DUENO (RF-06, RNF-03)', async () => {
    const login = async (username, pin) => {
      const res = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { username, pin },
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const duenoData = await login('dueno', '9999');
    const superData = await login('supervisor', '5555');
    const cajeroData = await login('lucas', '1111');

    assert.equal(duenoData.usuario.rol, 'DUENO');
    assert.equal(superData.usuario.rol, 'SUPERVISOR');
    assert.equal(cajeroData.usuario.rol, 'CAJERO');

    tokenDueno = duenoData.token;
    tokenSupervisor = superData.token;
    tokenCajero = cajeroData.token;
  });

  it('4. Aplica RBAC de 3 niveles (RNF-03): Cajero y Supervisor NO pueden crear rubros ni ver Audit Logs; Dueño sí puede', async () => {
    // Cajero intenta crear rubro -> 403
    const resCajero = await apiRequest('/api/catalogos/rubros', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: { nombre: 'Congelados' },
    });
    assert.equal(resCajero.status, 403);

    // Supervisor intenta ver audit logs -> 403
    const resSuper = await apiRequest('/api/auditoria', {
      headers: { Authorization: `Bearer ${tokenSupervisor}` },
    });
    assert.equal(resSuper.status, 403);

    // Dueño crea rubro -> 201 y genera Audit Log automático
    const resDueno = await apiRequest('/api/catalogos/rubros', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDueno}` },
      body: { nombre: 'Congelados', color_hex: '#06B6D4' },
    });
    assert.equal(resDueno.status, 201);
    const rubroCreado = await resDueno.json();
    assert.equal(rubroCreado.nombre, 'Congelados');
  });

  it('5. Garantiza que el Historial de Auditoría (RNF-04) sea secreto e inalterable (bloquea UPDATE y DELETE)', async () => {
    // Supervisor registra apertura de cajón sin venta
    const resApertura = await apiRequest('/api/auditoria/apertura-cajon', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSupervisor}` },
      body: { terminal: 'CAJA-01', motivo: 'Cambio de billetes grandes' },
    });
    assert.equal(resApertura.status, 201);

    // Dueño consulta los logs
    const resLogs = await apiRequest('/api/auditoria', {
      headers: { Authorization: `Bearer ${tokenDueno}` },
    });
    assert.equal(resLogs.status, 200);
    const { logs } = await resLogs.json();
    assert.ok(logs.length >= 2, 'Deben existir los registros de auditoría');

    // Intento de alterar o borrar un registro directamente en SQLite debe fallar por Trigger RNF-04
    assert.throws(
      () => {
        db.prepare('DELETE FROM audit_logs').run();
      },
      /VIOLACION_SEGURIDAD_RNF04/,
      'El trigger debe impedir cualquier DELETE en audit_logs'
    );

    assert.throws(
      () => {
        db.prepare("UPDATE audit_logs SET accion = 'APERTURA_CAJA'").run();
      },
      /VIOLACION_SEGURIDAD_RNF04/,
      'El trigger debe impedir cualquier UPDATE en audit_logs'
    );
  });
});
