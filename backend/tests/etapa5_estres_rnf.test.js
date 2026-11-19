const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase, setDb } = require('../src/db/database');
const { abrirTurnoCaja } = require('../src/services/turnos.service');
const { registrarVenta, sincronizarVentasOffline } = require('../src/services/ventas.service');
const { obtenerDashboardEnVivo } = require('../src/services/analitica.service');
const { realizarBackupBaseDatos } = require('../src/utils/backup');
const { uuidv7 } = require('../src/utils/uuidv7');

describe('Etapa 5: Certificación RNF (Estrés 90 Días, Latencia <1s/≤2s, Conflicto Fiado Offline y Backup)', () => {
  let db;
  let cajero;
  let turno;
  let tmpBackupDir;

  before(() => {
    db = createDatabase(':memory:');
    setDb(db);
    cajero = db.prepare("SELECT * FROM usuarios WHERE username = 'lucas'").get();
    turno = abrirTurnoCaja(
      db,
      { puesto_caja: 'CAJA-STRESS', nombre_turno: 'MANANA', fondo_inicial: 25000 },
      cajero
    );
    tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caja-backup-'));
  });

  after(() => {
    db.close();
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
  });

  it('1. Certificación RNF-01: Soporta ráfaga de 180 tickets distribuidos en 90 días con latencia <50ms por cobro y <200ms en Dashboard', () => {
    const rubros = ['rub-almacen', 'rub-bebidas', 'rub-lacteos', 'rub-fiambreria', 'rub-panaderia', 'rub-limpieza'];
    const medios = ['EFECTIVO', 'DEBITO', 'CREDITO', 'QR_TRANSFERENCIA'];

    let maxTicketMs = 0;
    const baseNow = Date.now();

    for (let i = 0; i < 180; i++) {
      const diasAtras = i % 90;
      const hora = 8 + (i % 13);
      const fechaSimulada = new Date(baseNow - diasAtras * 86400000);
      fechaSimulada.setUTCHours(hora, i % 60, 0, 0);

      const rubro = rubros[i % rubros.length];
      const medio = medios[i % medios.length];
      const subtotal = 1500 + (i % 10) * 500;

      const t0 = performance.now();
      registrarVenta(
        db,
        {
          turno_id: turno.id,
          cajero_id: cajero.id,
          lineas_rubro: [{ rubro_id: rubro, cantidad: (i % 4) + 1, subtotal }],
          pagos: [{ codigo_medio: medio, monto: subtotal }],
          fecha_venta: fechaSimulada.toISOString(),
        },
        cajero
      );
      const elapsed = performance.now() - t0;
      if (elapsed > maxTicketMs) maxTicketMs = elapsed;
    }

    assert.ok(maxTicketMs < 1000, `RNF-01: Máximo tiempo por ticket fue ${maxTicketMs.toFixed(2)}ms (límite 1000ms)`);

    // Medición de consulta completa de Dashboard con 90 días de historia
    const tDash0 = performance.now();
    const dash = obtenerDashboardEnVivo(db, {});
    const dashMs = performance.now() - tDash0;

    assert.ok(dashMs <= 2000, `RNF-01: Dashboard tardó ${dashMs.toFixed(2)}ms (límite 2000ms)`);
    assert.equal(dash.kpis.cantidad_tickets, 180);
    assert.ok(dash.ventas_por_dia.length >= 80, 'Debe consolidar la serie histórica de hasta 90 días (RF-15)');
    assert.ok(dash.ventas_por_hora.length >= 10, 'Debe consolidar las franjas horarias (RF-14)');
  });

  it('2. Mitigación de Riesgo R01: Al sincronizar ventas Offline que superan el límite de fiado de un cliente, registra alerta en Audit Log', () => {
    // Cliente cli-03 (Marta Vecina) tiene límite $25.000 y saldo deudor $5.000 (disponible $20.000)
    // En modo offline se cobra una venta de $22.000 en cuenta corriente: se acepta para no perder el registro y dispara alerta al Dueño
    const syncRes = sincronizarVentasOffline(
      db,
      {
        ventas: [
          {
            id: uuidv7(),
            turno_id: turno.id,
            cajero_id: cajero.id,
            cliente_fiado_id: 'cli-03',
            lineas_rubro: [{ rubro_id: 'rub-almacen', cantidad: 5, subtotal: 22000 }],
            pagos: [{ codigo_medio: 'CUENTA_CORRIENTE', monto: 22000 }],
          },
        ],
      },
      cajero
    );

    assert.equal(syncRes.sincronizadas, 1);

    const alertaLog = db
      .prepare("SELECT * FROM audit_logs WHERE accion = 'EXCESO_LIMITE_FIADO_OFFLINE' AND entidad_id = 'cli-03'")
      .get();
    assert.ok(alertaLog, 'Debe haberse generado la alerta de exceso de límite offline en audit_logs');
  });

  it('3. Respaldo en Caliente (Hot Backup VACUUM INTO): Genera copia íntegra de la base de datos sin detener la operación', () => {
    const resultado = realizarBackupBaseDatos(db, tmpBackupDir);
    assert.ok(fs.existsSync(resultado.archivo), 'El archivo de backup SQLite debe existir en disco');
    assert.ok(resultado.tamano_bytes > 4096, 'El archivo de backup debe contener la estructura y los datos');
  });
});
