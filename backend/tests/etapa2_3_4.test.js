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
  req.headers = {
    host: 'localhost',
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };

  let statusCode = 200;
  let responseHeaders = {};
  let responseBody = '';

  const res = {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      responseHeaders = hdrs;
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
    headers: responseHeaders,
    text: async () => responseBody,
    json: async () => (responseBody ? JSON.parse(responseBody) : {}),
  };
}

describe('Etapas 2, 3, 4 y 5: Ventas por Rubro, Offline Sync, Arqueo Ciego, Roles y Dashboard en Vivo', () => {
  let db;
  let tokenDueno;
  let tokenSupervisor;
  let tokenCajero;
  let turnoActivoId;

  before(async () => {
    db = createDatabase(':memory:');
    setDb(db);

    const login = async (username, pin) => {
      const r = await apiRequest('/api/auth/login', { method: 'POST', body: { username, pin } });
      return (await r.json()).token;
    };

    tokenDueno = await login('dueno', '9999');
    tokenSupervisor = await login('supervisor', '5555');
    tokenCajero = await login('lucas', '1111');
  });

  after(() => {
    db.close();
  });

  it('RF-01 y RF-08: Cajero abre turno de caja con fondo inicial de $15.000', async () => {
    const res = await apiRequest('/api/turnos/abrir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        puesto_caja: 'CAJA-01',
        nombre_turno: 'MANANA',
        fondo_inicial: 15000,
      },
    });
    assert.equal(res.status, 201);
    const turno = await res.json();
    assert.equal(turno.fondo_inicial, 15000);
    assert.equal(turno.estado, 'ABIERTO');
    turnoActivoId = turno.id;
  });

  it('RF-10, RF-12 y RNF-01: Registra venta en Efectivo calculando vuelto automáticamente en <1 segundo (Sin Stock)', async () => {
    const t0 = performance.now();
    const res = await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turnoActivoId,
        efectivo_recibido: 10000,
        lineas_rubro: [
          { rubro_id: 'rub-almacen', cantidad: 3, subtotal: 4500 },
          { rubro_id: 'rub-bebidas', cantidad: 2, subtotal: 3000 },
        ],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 7500 }],
      },
    });
    const elapsedMs = performance.now() - t0;

    assert.equal(res.status, 201);
    assert.ok(elapsedMs < 1000, `RNF-01: El ticket debe registrarse en <1000ms (tardó ${elapsedMs.toFixed(2)}ms)`);
    const venta = await res.json();
    assert.equal(venta.monto_total, 7500);
    assert.equal(venta.cantidad_total_articulos, 5);
    assert.equal(venta.vuelto_entregado, 2500);
  });

  it('RF-11: Registra Pago Combinado (Efectivo + Transferencia/QR Mercado Pago en un mismo ticket)', async () => {
    const res = await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turnoActivoId,
        lineas_rubro: [{ rubro_id: 'rub-fiambreria', cantidad: 2, subtotal: 6000 }],
        pagos: [
          { codigo_medio: 'EFECTIVO', monto: 2000 },
          { codigo_medio: 'QR_TRANSFERENCIA', monto: 4000 },
        ],
      },
    });
    assert.equal(res.status, 201);
    const venta = await res.json();
    assert.equal(venta.es_pago_combinado, 1);
    assert.equal(venta.monto_total, 6000);
  });

  it('RNF-02: Sincroniza lote de ventas cobradas sin conexión (Modo Offline) con idempotencia UUIDv7', async () => {
    const offlineVentaId = uuidv7();
    const payloadOffline = {
      ventas: [
        {
          id: offlineVentaId,
          turno_id: turnoActivoId,
          lineas_rubro: [{ rubro_id: 'rub-lacteos', cantidad: 4, subtotal: 5000 }],
          pagos: [{ codigo_medio: 'DEBITO', monto: 5000 }],
        },
      ],
    };

    const res1 = await apiRequest('/api/ventas/offline-sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: payloadOffline,
    });
    assert.equal(res1.status, 200);
    const sync1 = await res1.json();
    assert.equal(sync1.sincronizadas, 1);
    assert.equal(sync1.detalle[0].idempotente, false);

    // Segundo envío del mismo lote (reintento de red) no duplica la venta
    const res2 = await apiRequest('/api/ventas/offline-sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: payloadOffline,
    });
    const sync2 = await res2.json();
    assert.equal(sync2.detalle[0].idempotente, true);
  });

  it('RF-02: Cajero puede registrar tanto Entradas como Salidas de Efectivo (saldo neto -$3.500)', async () => {
    // Cajero registra ENTRADA de $1.500 -> 201 Created
    const resEntradaCajero = await apiRequest('/api/turnos/movimientos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turnoActivoId,
        tipo: 'ENTRADA',
        categoria: 'AJUSTE_CAMBIO',
        monto: 1500,
        motivo: 'Ingreso de cambio autorizado por Dueño',
      },
    });
    assert.equal(resEntradaCajero.status, 201);

    // Cajero registra SALIDA de $5.000 -> 201 Created (neto: +1500 - 5000 = -3500)
    const res = await apiRequest('/api/turnos/movimientos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turnoActivoId,
        tipo: 'SALIDA',
        categoria: 'PROVEEDOR',
        monto: 5000,
        motivo: 'Pago proveedor panadería',
      },
    });
    assert.equal(res.status, 201);
  });

  it('RNF-03: Supervisor puede ver el total de efectivo del turno ($21.000), pero tiene PROHIBIDO ver el Dashboard de ventas', async () => {
    // Esperado en cajón: Fondo ($15.000) + Efectivo Ventas ($7.500 + $2.000) - Salida ($3.500) = $21.000
    const resSup = await apiRequest(`/api/turnos/resumen-supervisor?turno_id=${turnoActivoId}`, {
      headers: { Authorization: `Bearer ${tokenSupervisor}` },
    });
    assert.equal(resSup.status, 200);
    const dataSup = await resSup.json();
    assert.equal(dataSup.total_efectivo_en_cajon_turno, 21000);

    // Supervisor intenta abrir el Dashboard de ventas/recaudación -> 403 Forbidden
    const resDashSup = await apiRequest('/api/analitica/dashboard', {
      headers: { Authorization: `Bearer ${tokenSupervisor}` },
    });
    assert.equal(resDashSup.status, 403);
    // Supervisor intenta cobrar a su propio nombre -> bloqueado (debe cobrar en nombre de otro personal <= su rol)
    const resCobroPropioSup = await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSupervisor}` },
      body: {
        turno_id: turnoActivoId,
        lineas_rubro: [{ rubro_id: 'rub-almacen', cantidad: 1, subtotal: 1000 }],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 1000 }],
      },
    });
    assert.equal(resCobroPropioSup.status, 400);

    // Supervisor intenta cobrar en nombre del Dueño (rol superior) -> bloqueado
    const resCobroDuenoPorSup = await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenSupervisor}` },
      body: {
        turno_id: turnoActivoId,
        cajero_id: 'usr-dueno-01',
        lineas_rubro: [{ rubro_id: 'rub-almacen', cantidad: 1, subtotal: 1000 }],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 1000 }],
      },
    });
    assert.equal(resCobroDuenoPorSup.status, 400);
  });

  it('RF-03, RF-07, RF-13..17: Dueño consulta el Tablero en Vivo y exporta a Excel y PDF', async () => {
    const resDash = await apiRequest('/api/analitica/dashboard', {
      headers: { Authorization: `Bearer ${tokenDueno}` },
    });
    assert.equal(resDash.status, 200);
    const dash = await resDash.json();

    assert.equal(dash.kpis.recaudacion_total, 18500); // 7500 + 6000 + 5000
    assert.equal(dash.kpis.efectivo_en_cajon_actual, 21000);
    assert.equal(dash.kpis.cantidad_tickets, 3);
    assert.ok(dash.rendimiento_empleados.length >= 1);
    assert.ok(dash.ventas_por_rubro.length >= 6);
    assert.equal(dash.ventas_por_medio_pago.length, 5);

    // Exportación a Excel (.csv)
    const resExcel = await apiRequest('/api/analitica/exportar?formato=excel', {
      headers: { Authorization: `Bearer ${tokenDueno}` },
    });
    assert.equal(resExcel.status, 200);
    const csvText = await resExcel.text();
    assert.ok(csvText.includes('RENDIMIENTO POR EMPLEADO'));

    // Exportación a PDF
    const resPdf = await apiRequest('/api/analitica/exportar?formato=pdf', {
      headers: { Authorization: `Bearer ${tokenDueno}` },
    });
    assert.equal(resPdf.status, 200);
    const htmlPdf = await resPdf.text();
    assert.ok(htmlPdf.includes('window.print()'));
  });

  it('RF-04 y RF-05: Cajero realiza Arqueo Ciego sin ver saldo esperado y el Dueño recibe el reporte de Faltante ($500)', async () => {
    // El cajón espera $21.000 en efectivo, pero el cajero declara $20.500 (Faltante de -$500)
    const resCierreCajero = await apiRequest('/api/turnos/cerrar-arqueo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turnoActivoId,
        declarado_efectivo: 20500,
        declarado_debito: 5000,
        declarado_credito: 0,
        declarado_qr: 4000,
        declarado_cuenta_corriente: 0,
      },
    });
    assert.equal(resCierreCajero.status, 200);
    const respuestaCajero = await resCierreCajero.json();

    // RF-04: El cajero NO recibe esperado_efectivo ni diferencia_efectivo
    assert.equal(respuestaCajero.esperado_efectivo, undefined);
    assert.equal(respuestaCajero.diferencia_efectivo, undefined);
    assert.equal(respuestaCajero.arqueo_ciego_registrado, true);

    // RF-05: El Dueño consulta el dashboard y ve el faltante exacto (-500) y estado FALTANTE
    const resDashDueno = await apiRequest('/api/analitica/dashboard', {
      headers: { Authorization: `Bearer ${tokenDueno}` },
    });
    const dashDueno = await resDashDueno.json();
    const arqueoCerrado = dashDueno.historial_arqueos.find((a) => a.id === turnoActivoId);
    assert.equal(arqueoCerrado.esperado_efectivo, 21000);
    assert.equal(arqueoCerrado.declarado_efectivo, 20500);
    assert.equal(arqueoCerrado.diferencia_efectivo, -500);
    assert.equal(arqueoCerrado.estado_cuadre, 'FALTANTE');

    // Reglas #7, #8 y #9: Permite pasar el turno a EN_ARQUEO ("Cerrar turno"), iniciar un turno nuevo en paralelo,
    // registrar ventas en el turno nuevo y cerrar el arqueo del anterior conservando solo lo de su turno
    const resAperturaT2 = await apiRequest('/api/turnos/abrir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        fondo_inicial: 18000,
        abierto_en_dispositivo: new Date().toISOString(),
      },
    });
    assert.equal(resAperturaT2.status, 201);
    const turno2 = await resAperturaT2.json();

    // Venta en Turno 2 ($3.000 efectivo) -> Turno 2 espera $21.000 ($18.000 + $3.000)
    await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turno2.id,
        lineas_rubro: [{ rubro_id: 'rub-panaderia', cantidad: 1, subtotal: 3000 }],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 3000 }],
      },
    });

    // Presiona "Cerrar turno" en Turno 2 -> pasa a EN_ARQUEO
    const resIniciarCierreT2 = await apiRequest('/api/turnos/iniciar-cierre', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: { turno_id: turno2.id },
    });
    assert.equal(resIniciarCierreT2.status, 200);
    assert.equal((await resIniciarCierreT2.json()).estado, 'EN_ARQUEO');

    // Mientras Turno 2 sigue en arqueo, se inicia el Turno 3 y se registra una venta en el Turno 3 ($9.000)
    const resAperturaT3 = await apiRequest('/api/turnos/abrir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: { fondo_inicial: 10000 },
    });
    assert.equal(resAperturaT3.status, 201);
    const turno3 = await resAperturaT3.json();

    await apiRequest('/api/ventas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenCajero}` },
      body: {
        turno_id: turno3.id,
        lineas_rubro: [{ rubro_id: 'rub-bebidas', cantidad: 2, subtotal: 9000 }],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 9000 }],
      },
    });

    // Ahora se confirma el arqueo del Turno 2 con $21.000 -> debe dar EXACTO sin mezclar los $9.000 del Turno 3
    const resCierreT2 = await apiRequest('/api/turnos/cerrar-arqueo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenDueno}` },
      body: {
        turno_id: turno2.id,
        declarado_efectivo: 21000,
      },
    });
    assert.equal(resCierreT2.status, 200);
    const cierreT2Data = await resCierreT2.json();
    assert.equal(cierreT2Data.esperado_efectivo, 21000);
    assert.equal(cierreT2Data.estado_cuadre, 'EXACTO');
  });
});
