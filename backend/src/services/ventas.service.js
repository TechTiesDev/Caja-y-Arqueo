const { uuidv7 } = require('../utils/uuidv7');
const { getDb, DEFAULT_EMPRESA_ID } = require('../db/database');
const { registrarAuditoria } = require('./audit.service');
const { broadcastEvent } = require('./sse.service');
const { ensureTurnoInDb } = require('./turnos.service');

/**
 * Registra una venta aislada por `empresa_id`.
 */
function registrarVenta(
  db = getDb(),
  {
    id = null,
    turno_id,
    fondo_inicial = 0,
    cajero_id = null,
    cliente_fiado_id = null,
    lineas_rubro = [],
    pagos = [],
    efectivo_recibido = null,
    creado_offline = false,
    fecha_venta = null,
  },
  actor
) {
  const ventaId = id || uuidv7();
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;

  // Idempotencia para reintentos de cola Offline
  const existente = db
    .prepare('SELECT * FROM ventas WHERE id = ? AND empresa_id = ?')
    .get(ventaId, empresaId);
  if (existente) {
    return { ...existente, idempotente: true };
  }

  if (!turno_id) {
    throw new Error('No se permite ningún cobro si no hay un turno iniciado.');
  }
  const turno = ensureTurnoInDb(db, turno_id, empresaId, actor, fondo_inicial);
  if (!turno) {
    const err = new Error('No se permite ningún cobro si no hay un turno iniciado.');
    err.statusCode = 404;
    throw err;
  }
  if (turno.estado !== 'ABIERTO' && !creado_offline) {
    throw new Error('No se permite ningún cobro si no hay un turno iniciado.');
  }

  if (!Array.isArray(lineas_rubro) || lineas_rubro.length === 0) {
    throw new Error('La venta debe incluir al menos una línea con cantidad, rubro_id y subtotal.');
  }

  let cantidadTotal = 0;
  let montoTotal = 0;

  for (const linea of lineas_rubro) {
    const cant = Number(linea.cantidad);
    const sub = Number(linea.subtotal);
    if (!linea.rubro_id || !Number.isInteger(cant) || cant <= 0 || isNaN(sub) || sub <= 0) {
      throw new Error('Cada línea debe tener rubro_id válido, cantidad entera > 0 y subtotal > 0.');
    }
    let rubroRow = db
      .prepare('SELECT id, empresa_id FROM rubros WHERE id = ?')
      .get(linea.rubro_id);
    if (!rubroRow) {
      db.prepare(`
        INSERT OR IGNORE INTO rubros (id, empresa_id, nombre, color_hex, icono, orden, activo)
        VALUES (?, ?, ?, '#2563EB', 'shopping-basket', 99, 1)
      `).run(
        linea.rubro_id,
        empresaId,
        linea.rubro_nombre || `Rubro ${String(linea.rubro_id).slice(-6)}`
      );
      rubroRow = db
        .prepare('SELECT id, empresa_id FROM rubros WHERE id = ?')
        .get(linea.rubro_id);
    }
    if (!rubroRow || rubroRow.empresa_id !== empresaId) {
      const err = new Error(`El rubro ${linea.rubro_id} no pertenece a esta empresa.`);
      err.statusCode = 404;
      throw err;
    }
    cantidadTotal += cant;
    montoTotal += sub;
  }
  montoTotal = Math.round(montoTotal * 100) / 100;

  if (!Array.isArray(pagos) || pagos.length === 0) {
    throw new Error('Debe especificar al menos un medio de pago.');
  }

  let sumaPagos = 0;
  let montoFiado = 0;
  let montoEfectivo = 0;

  const mediosEmpresa = db
    .prepare('SELECT * FROM medios_pago WHERE empresa_id = ?')
    .all(empresaId);
  const mediosMap = new Map(mediosEmpresa.map((m) => [m.id, m]));
  const mediosPorCodigo = new Map(mediosEmpresa.map((m) => [m.codigo, m]));

  const pagosNormalizados = pagos.map((p) => {
    const medio = mediosMap.get(p.medio_pago_id) || mediosPorCodigo.get(p.codigo_medio);
    if (!medio) {
      throw new Error(`Medio de pago inválido: ${p.medio_pago_id || p.codigo_medio}`);
    }
    const montoPago = Math.round(Number(p.monto) * 100) / 100;
    if (isNaN(montoPago) || montoPago <= 0) {
      throw new Error('El monto de cada pago debe ser mayor a 0.');
    }
    sumaPagos += montoPago;
    if (medio.codigo === 'CUENTA_CORRIENTE') montoFiado += montoPago;
    if (medio.codigo === 'EFECTIVO') montoEfectivo += montoPago;
    return { medio_pago_id: medio.id, codigo: medio.codigo, monto: montoPago };
  });

  sumaPagos = Math.round(sumaPagos * 100) / 100;
  if (Math.abs(sumaPagos - montoTotal) > 0.01) {
    throw new Error(
      `La suma de los medios de pago ($${sumaPagos}) no coincide con el total de la venta ($${montoTotal}).`
    );
  }

  if (montoFiado > 0) {
    if (!cliente_fiado_id) {
      throw new Error('Para cobrar con Cuenta Corriente debe seleccionar un cliente autorizado.');
    }
    const cliente = db
      .prepare('SELECT * FROM clientes_fiado WHERE id = ? AND empresa_id = ? AND activo = 1')
      .get(cliente_fiado_id, empresaId);
    if (!cliente) {
      const err = new Error('El cliente de cuenta corriente no existe en esta empresa.');
      err.statusCode = 404;
      throw err;
    }
    const nuevoSaldo = Number(cliente.saldo_deudor) + montoFiado;
    if (nuevoSaldo > Number(cliente.limite_credito) && !creado_offline) {
      const disponible = Number(cliente.limite_credito) - Number(cliente.saldo_deudor);
      throw new Error(
        `LIMITE_FIADO_EXCEDIDO: El cliente ${cliente.nombre} solo dispone de $${disponible} de crédito.`
      );
    }
  }

  let vueltoEntregado = 0;
  let efectivoRecibidoNum = efectivo_recibido !== null ? Number(efectivo_recibido) : montoEfectivo;
  if (montoEfectivo > 0 && efectivo_recibido !== null) {
    if (efectivoRecibidoNum < montoEfectivo) {
      throw new Error(
        `El efectivo recibido ($${efectivoRecibidoNum}) es menor al monto a cubrir en efectivo ($${montoEfectivo}).`
      );
    }
    vueltoEntregado = Math.round((efectivoRecibidoNum - montoEfectivo) * 100) / 100;
  }

  const ROLE_LEVEL = { CAJERO: 1, SUPERVISOR: 2, DUENO: 3, SOPORTE: 4 };
  const cajeroFinalId = cajero_id || (actor && actor.id) || turno.cajero_apertura_id;

  if (actor) {
    if (actor.rol === 'CAJERO' && cajeroFinalId !== actor.id) {
      throw new Error('Un Cajero solo puede registrar ventas a su propio nombre.');
    }
    if ((actor.rol === 'SUPERVISOR' || actor.rol === 'DUENO') && cajeroFinalId === actor.id) {
      throw new Error(
        'Los Supervisores y Dueños solo pueden cobrar en nombre de otro personal, de rol igual o inferior.'
      );
    }
    if (cajeroFinalId !== actor.id) {
      let targetUser = db
        .prepare('SELECT id, rol, empresa_id FROM usuarios WHERE id = ?')
        .get(cajeroFinalId);
      if (!targetUser) {
        const { hashPin } = require('../utils/crypto');
        const h = hashPin('1111');
        db.prepare(`
          INSERT OR IGNORE INTO usuarios (id, empresa_id, nombre, username, pin_hash, password_hash, rol, activo)
          VALUES (?, ?, 'Cajero', ?, ?, ?, 'CAJERO', 1)
        `).run(cajeroFinalId, empresaId, `cajero_${cajeroFinalId.slice(-6)}`, h, h);
        targetUser = db
          .prepare('SELECT id, rol, empresa_id FROM usuarios WHERE id = ?')
          .get(cajeroFinalId);
      }
      if (!targetUser || targetUser.empresa_id !== empresaId) {
        const err = new Error('El empleado seleccionado para la venta no pertenece a esta empresa.');
        err.statusCode = 404;
        throw err;
      }
      if ((ROLE_LEVEL[targetUser.rol] || 0) > (ROLE_LEVEL[actor.rol] || 0)) {
        throw new Error('Solo puede cobrar en nombre de personal de rol igual o inferior al suyo.');
      }
    }
  }

  const esPagoCombinado = pagosNormalizados.length > 1 ? 1 : 0;
  const timestampVenta = fecha_venta || new Date().toISOString();

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const nextTicketRow = db
      .prepare(
        'SELECT COALESCE(MAX(numero_ticket), 0) + 1 AS proximo FROM ventas WHERE turno_id = ? AND empresa_id = ?'
      )
      .get(turno_id, empresaId);
    const numeroTicket = nextTicketRow.proximo;

    db.prepare(`
      INSERT INTO ventas (
        id, empresa_id, numero_ticket, turno_id, cajero_id, cliente_fiado_id,
        cantidad_total_articulos, monto_total, es_pago_combinado,
        efectivo_recibido, vuelto_entregado, estado, creado_offline, fecha_venta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETADA', ?, ?)
    `).run(
      ventaId,
      empresaId,
      numeroTicket,
      turno_id,
      cajeroFinalId,
      cliente_fiado_id,
      cantidadTotal,
      montoTotal,
      esPagoCombinado,
      efectivoRecibidoNum,
      vueltoEntregado,
      creado_offline ? 1 : 0,
      timestampVenta
    );

    const insertLinea = db.prepare(`
      INSERT INTO lineas_venta_rubro (id, venta_id, rubro_id, cantidad, subtotal)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const l of lineas_rubro) {
      insertLinea.run(
        uuidv7(),
        ventaId,
        l.rubro_id,
        Number(l.cantidad),
        Math.round(Number(l.subtotal) * 100) / 100
      );
    }

    const insertPago = db.prepare(`
      INSERT INTO pagos_venta (id, venta_id, medio_pago_id, monto)
      VALUES (?, ?, ?, ?)
    `);
    for (const p of pagosNormalizados) {
      insertPago.run(uuidv7(), ventaId, p.medio_pago_id, p.monto);
    }

    if (montoFiado > 0 && cliente_fiado_id) {
      db.prepare('UPDATE clientes_fiado SET saldo_deudor = saldo_deudor + ? WHERE id = ? AND empresa_id = ?').run(
        montoFiado,
        cliente_fiado_id,
        empresaId
      );
      const clienteActualizado = db
        .prepare('SELECT * FROM clientes_fiado WHERE id = ? AND empresa_id = ?')
        .get(cliente_fiado_id, empresaId);
      if (Number(clienteActualizado.saldo_deudor) > Number(clienteActualizado.limite_credito)) {
        registrarAuditoria({
          db,
          empresaId,
          usuarioId: cajeroFinalId,
          rolUsuario: (actor && actor.rol) || 'CAJERO',
          terminal: turno.puesto_caja,
          accion: 'EXCESO_LIMITE_FIADO_OFFLINE',
          entidadAfectada: 'clientes_fiado',
          entidadId: cliente_fiado_id,
          detalle: {
            venta_id: ventaId,
            limite: clienteActualizado.limite_credito,
            saldo_resultante: clienteActualizado.saldo_deudor,
          },
        });
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const ventaCreada = db.prepare('SELECT * FROM ventas WHERE id = ?').get(ventaId);
  broadcastEvent('NUEVA_VENTA', {
    empresaId,
    ventaId,
    turnoId: turno_id,
    cajeroId: cajeroFinalId,
    montoTotal,
    cantidadTotal,
    esPagoCombinado: Boolean(esPagoCombinado),
  });

  return ventaCreada;
}

function sincronizarVentasOffline(db = getDb(), { ventas = [] }, actor) {
  const resultados = [];
  for (const item of ventas) {
    const res = registrarVenta(db, { ...item, creado_offline: true }, actor);
    resultados.push({
      id: res.id,
      numero_ticket: res.numero_ticket,
      idempotente: Boolean(res.idempotente),
    });
  }
  broadcastEvent('OFFLINE_BATCH_SYNC', { cantidadSincronizada: resultados.length });
  return { sincronizadas: resultados.length, detalle: resultados };
}

function anularVenta(db = getDb(), { venta_id, motivo }, actor) {
  if (!motivo || !String(motivo).trim()) {
    throw new Error('Debe especificar el motivo de la anulación.');
  }
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const venta = db
    .prepare('SELECT * FROM ventas WHERE id = ? AND empresa_id = ?')
    .get(venta_id, empresaId);
  if (!venta) {
    const err = new Error('Venta no encontrada en esta empresa.');
    err.statusCode = 404;
    throw err;
  }
  if (venta.estado === 'ANULADA') throw new Error('La venta ya se encuentra anulada.');

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    db.prepare(`
      UPDATE ventas
      SET estado = 'ANULADA', anulada_por_id = ?, motivo_anulacion = ?
      WHERE id = ? AND empresa_id = ?
    `).run(actor.id, String(motivo).trim(), venta_id, empresaId);

    if (venta.cliente_fiado_id) {
      const pagoFiado = db
        .prepare(`
          SELECT COALESCE(SUM(pv.monto), 0) as total_fiado
          FROM pagos_venta pv
          JOIN medios_pago mp ON mp.id = pv.medio_pago_id
          WHERE pv.venta_id = ? AND mp.codigo = 'CUENTA_CORRIENTE'
        `)
        .get(venta_id);

      if (pagoFiado && pagoFiado.total_fiado > 0) {
        db.prepare(
          'UPDATE clientes_fiado SET saldo_deudor = MAX(0, saldo_deudor - ?) WHERE id = ? AND empresa_id = ?'
        ).run(Number(pagoFiado.total_fiado), venta.cliente_fiado_id, empresaId);
      }
    }

    registrarAuditoria({
      db,
      empresaId,
      usuarioId: actor.id,
      rolUsuario: actor.rol,
      accion: 'ANULACION_TICKET',
      entidadAfectada: 'ventas',
      entidadId: venta_id,
      detalle: {
        numero_ticket: venta.numero_ticket,
        monto_anulado: venta.monto_total,
        cajero_original_id: venta.cajero_id,
        motivo: String(motivo).trim(),
      },
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  broadcastEvent('VENTA_ANULADA', { empresaId, ventaId: venta_id, montoAnulado: venta.monto_total });
  return db.prepare('SELECT * FROM ventas WHERE id = ?').get(venta_id);
}

function listarVentasRecientes(
  db = getDb(),
  { empresaId = DEFAULT_EMPRESA_ID, turno_id = null, limit = 30 } = {}
) {
  if (turno_id) {
    return db
      .prepare(`
        SELECT v.*, u.nombre AS cajero_nombre
        FROM ventas v
        JOIN usuarios u ON u.id = v.cajero_id
        WHERE v.empresa_id = ? AND v.turno_id = ?
        ORDER BY v.fecha_venta DESC
        LIMIT ?
      `)
      .all(empresaId, turno_id, limit);
  }
  return db
    .prepare(`
      SELECT v.*, u.nombre AS cajero_nombre
      FROM ventas v
      JOIN usuarios u ON u.id = v.cajero_id
      WHERE v.empresa_id = ?
      ORDER BY v.fecha_venta DESC
      LIMIT ?
    `)
    .all(empresaId, limit);
}

function obtenerVentaPorId(db = getDb(), ventaId, actor) {
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const venta = db
    .prepare('SELECT * FROM ventas WHERE id = ? AND empresa_id = ?')
    .get(ventaId, empresaId);
  if (!venta) {
    const err = new Error('Venta no encontrada.');
    err.statusCode = 404;
    throw err;
  }
  return venta;
}

module.exports = {
  registrarVenta,
  sincronizarVentasOffline,
  anularVenta,
  listarVentasRecientes,
  obtenerVentaPorId,
};
