const { getDb } = require('./database');
const { abrirTurnoCaja, registrarMovimientoCaja } = require('../services/turnos.service');
const { registrarVenta } = require('../services/ventas.service');

/**
 * Pobla la base de datos SQLite con un turno abierto y ventas distribuidas por hora y día
 * para visualizar de inmediato el Tablero en Vivo (RF-13, RF-14, RF-15, RF-16).
 */
function runDemoSeed() {
  const db = getDb();
  const actorCajero1 = db.prepare("SELECT * FROM usuarios WHERE username = 'lucas'").get();
  const actorCajero2 = db.prepare("SELECT * FROM usuarios WHERE username = 'martina'").get();

  let turno = db.prepare("SELECT * FROM turnos_caja WHERE puesto_caja = 'CAJA-01' AND estado = 'ABIERTO'").get();
  if (!turno) {
    turno = abrirTurnoCaja(
      db,
      { puesto_caja: 'CAJA-01', nombre_turno: 'MANANA', fondo_inicial: 20000 },
      actorCajero1
    );
  }

  const countVentas = db.prepare('SELECT COUNT(*) as total FROM ventas').get().total;
  if (countVentas === 0) {
    const hoy = new Date().toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const muestras = [
      {
        cajero: actorCajero1,
        fecha: `${ ayer }T10:15:00.000Z`,
        lineas: [{ rubro_id: 'rub-almacen', cantidad: 4, subtotal: 6800 }],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 6800 }],
      },
      {
        cajero: actorCajero2,
        fecha: `${ ayer }T18:30:00.000Z`,
        lineas: [{ rubro_id: 'rub-bebidas', cantidad: 3, subtotal: 5400 }],
        pagos: [{ codigo_medio: 'QR_TRANSFERENCIA', monto: 5400 }],
      },
      {
        cajero: actorCajero1,
        fecha: `${ hoy }T09:10:00.000Z`,
        lineas: [
          { rubro_id: 'rub-panaderia', cantidad: 2, subtotal: 3200 },
          { rubro_id: 'rub-lacteos', cantidad: 2, subtotal: 4100 },
        ],
        pagos: [{ codigo_medio: 'EFECTIVO', monto: 7300 }],
        efectivo_recibido: 10000,
      },
      {
        cajero: actorCajero1,
        fecha: `${ hoy }T11:40:00.000Z`,
        lineas: [{ rubro_id: 'rub-fiambreria', cantidad: 3, subtotal: 8500 }],
        pagos: [
          { codigo_medio: 'EFECTIVO', monto: 3500 },
          { codigo_medio: 'DEBITO', monto: 5000 },
        ],
      },
      {
        cajero: actorCajero2,
        fecha: `${ hoy }T13:20:00.000Z`,
        lineas: [{ rubro_id: 'rub-limpieza', cantidad: 2, subtotal: 4900 }],
        pagos: [{ codigo_medio: 'CREDITO', monto: 4900 }],
      },
    ];

    for (const m of muestras) {
      registrarVenta(
        db,
        {
          turno_id: turno.id,
          cajero_id: m.cajero.id,
          lineas_rubro: m.lineas,
          pagos: m.pagos,
          efectivo_recibido: m.efectivo_recibido || null,
          fecha_venta: m.fecha,
        },
        m.cajero
      );
    }

    registrarMovimientoCaja(
      db,
      {
        turno_id: turno.id,
        tipo: 'SALIDA',
        categoria: 'PROVEEDOR',
        monto: 4000,
        motivo: 'Pago proveedor lácteos mañana',
      },
      actorCajero1
    );
  }

  console.log('Base de datos SQLite inicializada con turno abierto y datos de demostración.');
}

if (require.main === module) {
  runDemoSeed();
}

module.exports = { runDemoSeed };
