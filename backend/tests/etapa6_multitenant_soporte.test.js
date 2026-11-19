const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDatabase, setDb } = require('../src/db/database');
const { handleRequest } = require('../src/server');

async function apiRequest(path, { method = 'GET', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = {
    host: 'localhost',
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };

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

describe('Etapa 6: Arquitectura Multi-Tenant (Perfiles de Empresa) y Rol Global Soporte', () => {
  let db;
  let tokenDuenoA;
  let empresaA;
  let tokenDuenoB;
  let empresaB;
  let tokenSoporte;
  let soporteUserId;
  let ventaEmpresaAId;
  let rubroEmpresaAId;

  before(() => {
    process.env.INITIAL_SOPORTE_EMAIL = 'soporte@cajayarqueo.com';
    process.env.INITIAL_SOPORTE_PASSWORD = '9999';
    db = createDatabase(':memory:');
    setDb(db);
  });

  after(() => {
    db.close();
  });

  it('Test 1 (Aislamiento Cross-Tenant): Empresa B no puede leer, editar ni anular registros operativos de Empresa A (404 / lista vacía)', async () => {
    // Crear Empresa A (Dueño A)
    const resEmpA = await apiRequest('/auth/register-empresa', {
      method: 'POST',
      body: {
        nombre_empresa: 'Minimercado Norte (Empresa A)',
        identificador_fiscal: '30-11111111-1',
        nombre_dueno: 'Dueño A',
        email_dueno: 'duenoA@empresa-a.com',
        password_dueno: '1234',
      },
    });
    assert.equal(resEmpA.status, 201);
    const dataA = await resEmpA.json();
    tokenDuenoA = dataA.access_token;
    empresaA = dataA.empresa;

    // Crear Empresa B (Dueño B)
    const resEmpB = await apiRequest('/auth/register-empresa', {
      method: 'POST',
      body: {
        nombre_empresa: 'Despensa Sur (Empresa B)',
        identificador_fiscal: '30-22222222-2',
        nombre_dueno: 'Dueño B',
        email_dueno: 'duenoB@empresa-b.com',
        password_dueno: '5678',
      },
    });
    assert.equal(resEmpB.status, 201);
    const dataB = await resEmpB.json();
    tokenDuenoB = dataB.access_token;
    empresaB = dataB.empresa;

    // En Empresa A: crear cajero, abrir turno y registrar una venta
    const resCajA = await apiRequest('/auth/usuarios', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDuenoA}` },
      body: {
        nombre: 'Cajero A',
        username: 'cajero_a',
        email: 'cajero@empresa-a.com',
        password: '1111',
        rol: 'EMPLEADO',
      },
    });
    assert.equal(resCajA.status, 201);
    const cajeroA = await resCajA.json();

    const resTurnoA = await apiRequest('/api/turnos/abrir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDuenoA}` },
      body: { fondo_inicial: 10000 },
    });
    assert.equal(resTurnoA.status, 201);
    const turnoA = await resTurnoA.json();

    const snapA = await (
      await apiRequest('/api/catalogos/snapshot', {
        headers: { Authorization: `Bearer ${tokenDuenoA}` },
      })
    ).json();
    rubroEmpresaAId = snapA.rubros[0].id;

    const resVentaA = await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDuenoA}` },
      body: {
        turno_id: turnoA.id,
        cajero_id: cajeroA.id,
        lineas_rubro: [{ rubro_id: rubroEmpresaAId, cantidad: 2, subtotal: 4000 }],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 4000 }],
      },
    });
    assert.equal(resVentaA.status, 201);
    ventaEmpresaAId = (await resVentaA.json()).id;

    // Dueño B intenta leer la venta de Empresa A por ID -> 404 Not Found
    const resReadCross = await apiRequest(`/api/ventas/${ventaEmpresaAId}`, {
      headers: { Authorization: `Bearer ${tokenDuenoB}` },
    });
    assert.equal(resReadCross.status, 404);

    // Dueño B lista sus ventas -> lista vacía (0 ventas)
    const resListB = await apiRequest('/api/ventas', {
      headers: { Authorization: `Bearer ${tokenDuenoB}` },
    });
    const listB = await resListB.json();
    assert.equal(listB.ventas.length, 0);

    // Dueño B intenta editar al usuario de Empresa A -> 404 Not Found
    const resEditUserCross = await apiRequest(`/auth/usuarios/${cajeroA.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenDuenoB}` },
      body: { nombre: 'Intruso' },
    });
    assert.equal(resEditUserCross.status, 404);

    // Dueño B intenta eliminar un rubro de Empresa A -> 404 Not Found
    const resDelRubroCross = await apiRequest(`/api/catalogos/rubros/${rubroEmpresaAId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenDuenoB}` },
    });
    assert.equal(resDelRubroCross.status, 404);
  });

  it('Test 2 (Independencia de Configuraciones): Modificar o agregar rubros en Empresa A mantiene intacta la configuración de Empresa B', async () => {
    const resNuevoRubroA = await apiRequest('/api/catalogos/rubros', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDuenoA}` },
      body: { nombre: 'Dietética Exclusiva A' },
    });
    assert.equal(resNuevoRubroA.status, 201);

    const snapB = await (
      await apiRequest('/api/catalogos/snapshot', {
        headers: { Authorization: `Bearer ${tokenDuenoB}` },
      })
    ).json();

    assert.ok(
      !snapB.rubros.some((r) => r.nombre === 'Dietética Exclusiva A'),
      'El catálogo de Empresa B no debe verse afectado por cambios en Empresa A'
    );
  });

  it('Test 3 (Escalada de Privilegios Denegada): Intentar crear o actualizar un usuario con rol SOPORTE desde Dueño retorna 403 Forbidden', async () => {
    const resCreateSoporteByDueno = await apiRequest('/auth/usuarios', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDuenoA}` },
      body: {
        nombre: 'Falso Soporte',
        email: 'hacker@empresa-a.com',
        password: '1234',
        rol: 'SOPORTE',
      },
    });
    assert.equal(resCreateSoporteByDueno.status, 403);

    const usuariosA = (
      await (
        await apiRequest('/auth/usuarios', {
          headers: { Authorization: `Bearer ${tokenDuenoA}` },
        })
      ).json()
    ).usuarios;

    const resPatchSoporteByDueno = await apiRequest(`/auth/usuarios/${usuariosA[0].id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenDuenoA}` },
      body: { rol: 'SOPORTE' },
    });
    assert.equal(resPatchSoporteByDueno.status, 403);
  });

  it('Test 4 (Bloqueo de Rutas a Soporte sin Contexto): Autenticarse como SOPORTE (empresa_id == NULL) e invocar ruta de negocio retorna 403 Forbidden', async () => {
    const resLoginSoporte = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'soporte@cajayarqueo.com', password: '9999' },
    });
    assert.equal(resLoginSoporte.status, 200);
    const loginData = await resLoginSoporte.json();
    assert.equal(loginData.usuario.rol, 'SOPORTE');
    assert.equal(loginData.usuario.empresa_id, null);

    tokenSoporte = loginData.access_token;
    soporteUserId = loginData.usuario.id;

    // Soporte sin empresa intenta consultar el dashboard operativo -> 403 Forbidden
    const resDashSinContexto = await apiRequest('/api/analitica/dashboard', {
      headers: { Authorization: `Bearer ${tokenSoporte}` },
    });
    assert.equal(resDashSinContexto.status, 403);

    // Soporte sin empresa intenta abrir un turno de caja -> 403 Forbidden
    const resAbrirSinContexto = await apiRequest('/api/turnos/abrir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSoporte}` },
      body: { fondo_inicial: 5000 },
    });
    assert.equal(resAbrirSinContexto.status, 403);
  });

  it('Test 5 (Ciclo de Inmersión de Soporte): Ingresar a Empresa A emite nuevo token con empresa_id, registra INGRESO en soporte_accesos_log, permite operar y Salir limpia empresa_id registrando SALIDA', async () => {
    // 1. Soporte lista las empresas disponibles
    const resEmpresas = await apiRequest('/auth/empresas', {
      headers: { Authorization: `Bearer ${tokenSoporte}` },
    });
    assert.equal(resEmpresas.status, 200);
    const { empresas } = await resEmpresas.json();
    assert.ok(empresas.some((e) => e.id === empresaA.id));

    // 2. Soporte ingresa a Empresa A en Modo Mantenimiento
    const resIngreso = await apiRequest(`/auth/empresas/${empresaA.id}/ingresar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSoporte}` },
    });
    assert.equal(resIngreso.status, 200);
    const ingresoData = await resIngreso.json();
    assert.equal(ingresoData.empresa_id, empresaA.id);
    assert.equal(ingresoData.empresa_nombre, empresaA.nombre);

    const tokenSoporteEnEmpresaA = ingresoData.access_token;

    // 3. Con el nuevo token, Soporte puede ver el Dashboard de Empresa A (con los $4.000 vendidos en Empresa A)
    const resDashEnEmpresaA = await apiRequest('/api/analitica/dashboard', {
      headers: { Authorization: `Bearer ${tokenSoporteEnEmpresaA}` },
    });
    assert.equal(resDashEnEmpresaA.status, 200);
    const dashA = await resDashEnEmpresaA.json();
    assert.equal(dashA.kpis.recaudacion_total, 4000);

    // 4. Soporte sale de Empresa A y regresa a la consola global
    const resSalida = await apiRequest('/auth/empresas/salir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSoporteEnEmpresaA}` },
    });
    assert.equal(resSalida.status, 200);
    const salidaData = await resSalida.json();
    assert.equal(salidaData.empresa_id, null);
    tokenSoporte = salidaData.access_token;

    // 5. Verificar registros de auditoría INGRESO y SALIDA en soporte_accesos_log
    const logsSoporte = db
      .prepare('SELECT * FROM soporte_accesos_log WHERE soporte_user_id = ? AND empresa_id = ? ORDER BY creado_en ASC')
      .all(soporteUserId, empresaA.id);
    assert.equal(logsSoporte.length, 2);
    assert.equal(logsSoporte[0].accion, 'INGRESO');
    assert.equal(logsSoporte[1].accion, 'SALIDA');
  });

  it('Test 6 (Protección de Auto-Eliminación de Soporte): Intentar ejecutar DELETE /auth/soporte/usuarios/{mi_propio_id} retorna 400 Bad Request', async () => {
    // Crear un segundo usuario Soporte y eliminarlo -> 200 OK
    const resCrearSop2 = await apiRequest('/auth/soporte/usuarios', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSoporte}` },
      body: {
        nombre: 'Soporte Auxiliar',
        email: 'auxiliar@cajayarqueo.com',
        password: '4444',
      },
    });
    assert.equal(resCrearSop2.status, 201);
    const sop2 = await resCrearSop2.json();

    const resDelSop2 = await apiRequest(`/auth/soporte/usuarios/${sop2.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenSoporte}` },
    });
    assert.equal(resDelSop2.status, 200);

    // Intentar auto-eliminarse -> 400 Bad Request
    const resAutoDelete = await apiRequest(`/auth/soporte/usuarios/${soporteUserId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenSoporte}` },
    });
    assert.equal(resAutoDelete.status, 400);
  });
});
