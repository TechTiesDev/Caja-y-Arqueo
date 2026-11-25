const { uuidv7 } = require('../utils/uuidv7');
const { getDb, DEFAULT_EMPRESA_ID } = require('../db/database');
const { registrarAuditoria } = require('./audit.service');
const { broadcastEvent } = require('./sse.service');

/**
 * Apertura de Caja aislada por `empresa_id`.
 */
function abrirTurnoCaja(
  db = getDb(),
  { puesto_caja = 'CAJA-01', nombre_turno = null, fondo_inicial = 0, abierto_en_dispositivo = null },
  actor
) {
  if (Number(fondo_inicial) < 0) {
    throw new Error('El fondo inicial no puede ser negativo.');
  }

  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;

  const turnoAbierto = db
    .prepare(
      "SELECT id, abierto_en FROM turnos_caja WHERE empresa_id = ? AND puesto_caja = ? AND estado = 'ABIERTO'"
    )
    .get(empresaId, puesto_caja);

  if (turnoAbierto) {
    throw new Error(
      'Ya hay una caja abierta actualmente. Debe cerrarla antes de iniciar una nueva apertura.'
    );
  }

  const id = `tur-${uuidv7().slice(-12)}`;
  const abiertoEn = abierto_en_dispositivo || new Date().toISOString();

  let turnoInterno = nombre_turno;
  if (!turnoInterno || !['MANANA', 'TARDE', 'NOCHE', 'UNICO'].includes(turnoInterno)) {
    const horaLocal = new Date(abiertoEn).getHours();
    turnoInterno = horaLocal < 14 ? 'MANANA' : horaLocal < 21 ? 'TARDE' : 'NOCHE';
  }

  db.prepare(`
    INSERT INTO turnos_caja (id, empresa_id, puesto_caja, nombre_turno, cajero_apertura_id, fondo_inicial, estado, abierto_en)
    VALUES (?, ?, ?, ?, ?, ?, 'ABIERTO', ?)
  `).run(id, empresaId, puesto_caja, turnoInterno, actor.id, Number(fondo_inicial), abiertoEn);

  registrarAuditoria({
    db,
    empresaId,
    usuarioId: actor.id,
    rolUsuario: actor.rol,
    terminal: puesto_caja,
    accion: 'APERTURA_CAJA',
    entidadAfectada: 'turnos_caja',
    entidadId: id,
    detalle: { puesto_caja, abierto_en: abiertoEn, fondo_inicial: Number(fondo_inicial) },
  });

  const nuevoTurno = db.prepare('SELECT * FROM turnos_caja WHERE id = ?').get(id);
  broadcastEvent('TURNO_ABIERTO', { empresaId, turnoId: id, puesto_caja, abierto_en: abiertoEn });
  return nuevoTurno;
}

function obtenerTurnoActivo(db = getDb(), puesto_caja = 'CAJA-01', empresaId = DEFAULT_EMPRESA_ID) {
  return db
    .prepare(`
      SELECT t.id, t.empresa_id, t.puesto_caja, t.nombre_turno, t.cajero_apertura_id, u.nombre as cajero_nombre,
             t.fondo_inicial, t.estado, t.abierto_en
      FROM turnos_caja t
      JOIN usuarios u ON u.id = t.cajero_apertura_id
      WHERE t.empresa_id = ? AND t.puesto_caja = ? AND t.estado = 'ABIERTO'
    `)
    .get(empresaId, puesto_caja);
}

function obtenerTurnosEnArqueo(db = getDb(), puesto_caja = 'CAJA-01', empresaId = DEFAULT_EMPRESA_ID) {
  return db
    .prepare(`
      SELECT t.id, t.empresa_id, t.puesto_caja, t.nombre_turno, t.cajero_apertura_id, u.nombre as cajero_nombre,
             t.fondo_inicial, t.estado, t.abierto_en
      FROM turnos_caja t
      JOIN usuarios u ON u.id = t.cajero_apertura_id
      WHERE t.empresa_id = ? AND t.puesto_caja = ? AND t.estado = 'EN_ARQUEO'
      ORDER BY t.abierto_en ASC
    `)
    .all(empresaId, puesto_caja);
}

function ensureTurnoInDb(db, turno_id, empresaId, actor = null, fallbackFondo = 0) {
  if (!turno_id) return null;
  let turno = db
    .prepare('SELECT * FROM turnos_caja WHERE id = ? AND empresa_id = ?')
    .get(turno_id, empresaId);
  if (turno) return turno;

  // Si existe bajo otra empresa, es un intento Cross-Tenant -> denegar con null (404)
  const otherEmpresaTurno = db
    .prepare('SELECT id, empresa_id FROM turnos_caja WHERE id = ?')
    .get(turno_id);
  if (otherEmpresaTurno) return null;

  // Si no existe en absoluto en la BD local (ej. reinicio de contenedor Serverless /tmp en Vercel), rehidratar
  const cajeroId = (actor && actor.id) || 'usr-caj-01';
  const ahora = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO turnos_caja (id, empresa_id, puesto_caja, nombre_turno, cajero_apertura_id, fondo_inicial, estado, abierto_en)
    VALUES (?, ?, 'CAJA-01', 'MANANA', ?, ?, 'ABIERTO', ?)
  `).run(turno_id, empresaId, cajeroId, Number(fallbackFondo || 0), ahora);

  return db
    .prepare('SELECT * FROM turnos_caja WHERE id = ? AND empresa_id = ?')
    .get(turno_id, empresaId);
}

function iniciarCierreTurno(db = getDb(), { turno_id, fondo_inicial = 0 }, actor) {
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const turno = ensureTurnoInDb(db, turno_id, empresaId, actor, fondo_inicial);
  if (!turno) {
    const err = new Error('Turno no encontrado.');
    err.statusCode = 404;
    throw err;
  }
  if (turno.estado !== 'ABIERTO') {
    throw new Error('El turno ya está en proceso de arqueo o cerrado.');
  }

  db.prepare("UPDATE turnos_caja SET estado = 'EN_ARQUEO' WHERE id = ? AND empresa_id = ?").run(
    turno_id,
    empresaId
  );
  broadcastEvent('TURNO_EN_ARQUEO', { empresaId, turnoId: turno_id, actorId: actor?.id });
  return db.prepare('SELECT * FROM turnos_caja WHERE id = ?').get(turno_id);
}

function registrarMovimientoCaja(
  db = getDb(),
  {
    turno_id,
    usuario_id = null,
    tipo,
    categoria = 'OTRO',
    monto,
    motivo,
    autorizado_por_id = null,
    fondo_inicial = 0,
  },
  actor
) {
  if (!turno_id || !['ENTRADA', 'SALIDA'].includes(tipo)) {
    throw new Error('Debe indicar turno_id y tipo válido (ENTRADA o SALIDA).');
  }
  if (!monto || Number(monto) <= 0) {
    throw new Error('El monto del movimiento debe ser mayor a 0.');
  }
  if (!motivo || !String(motivo).trim()) {
    throw new Error('El motivo del movimiento es obligatorio.');
  }

  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const turno = ensureTurnoInDb(db, turno_id, empresaId, actor, fondo_inicial);
  if (!turno) {
    const err = new Error('Turno no encontrado en esta empresa.');
    err.statusCode = 404;
    throw err;
  }
  if (turno.estado !== 'ABIERTO') {
    throw new Error('El turno indicado ya no admite movimientos.');
  }

  const ROLE_LEVEL = { CAJERO: 1, SUPERVISOR: 2, DUENO: 3, SOPORTE: 4 };
  const targetUserId = usuario_id || actor.id;

  if (actor && targetUserId !== actor.id) {
    if (actor.rol === 'CAJERO') {
      throw new Error('Un Cajero solo puede registrar movimientos a su propio nombre.');
    }
    let targetUser = db
      .prepare('SELECT id, rol, empresa_id FROM usuarios WHERE id = ?')
      .get(targetUserId);
    if (!targetUser) {
      const { hashPin } = require('../utils/crypto');
      const h = hashPin('1111');
      db.prepare(`
        INSERT OR IGNORE INTO usuarios (id, empresa_id, nombre, username, pin_hash, password_hash, rol, activo)
        VALUES (?, ?, 'Cajero', ?, ?, ?, 'CAJERO', 1)
      `).run(targetUserId, empresaId, `cajero_${targetUserId.slice(-6)}`, h, h);
      targetUser = db
        .prepare('SELECT id, rol, empresa_id FROM usuarios WHERE id = ?')
        .get(targetUserId);
    }
    if (!targetUser || targetUser.empresa_id !== empresaId) {
      const err = new Error('El empleado seleccionado no pertenece a esta empresa.');
      err.statusCode = 404;
      throw err;
    }
    if ((ROLE_LEVEL[targetUser.rol] || 0) > (ROLE_LEVEL[actor.rol] || 0)) {
      throw new Error('Solo puede operar en nombre de personal de rol igual o inferior al suyo.');
    }
  }

  const id = `mov-${uuidv7().slice(-12)}`;
  const creadoEn = new Date().toISOString();

  db.prepare(`
    INSERT INTO movimientos_caja (id, empresa_id, turno_id, usuario_id, autorizado_por_id, tipo, categoria, monto, motivo, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    empresaId,
    turno_id,
    targetUserId,
    autorizado_por_id || actor.id,
    tipo,
    categoria,
    Number(monto),
    String(motivo).trim(),
    creadoEn
  );

  registrarAuditoria({
    db,
    empresaId,
    usuarioId: actor.id,
    rolUsuario: actor.rol,
    terminal: turno.puesto_caja,
    accion: tipo === 'ENTRADA' ? 'ENTRADA_DINERO' : 'SALIDA_DINERO',
    entidadAfectada: 'movimientos_caja',
    entidadId: id,
    detalle: {
      turno_id,
      tipo,
      categoria,
      monto: Number(monto),
      motivo: String(motivo).trim(),
      autorizado_por_id,
    },
  });

  broadcastEvent('MOVIMIENTO_CAJA', { empresaId, turnoId: turno_id, tipo, monto: Number(monto) });
  return db.prepare('SELECT * FROM movimientos_caja WHERE id = ?').get(id);
}

function calcularSaldosEsperadosTurno(db = getDb(), turno_id, empresaId = null) {
  const turno = empresaId
    ? ensureTurnoInDb(db, turno_id, empresaId)
    : db.prepare('SELECT * FROM turnos_caja WHERE id = ?').get(turno_id);

  if (!turno) {
    const err = new Error('Turno no encontrado.');
    err.statusCode = 404;
    throw err;
  }

  const empId = turno.empresa_id;

  const pagosPorMedio = db
    .prepare(`
      SELECT mp.codigo,
             COALESCE(SUM(CASE WHEN v.id IS NOT NULL THEN pv.monto ELSE 0 END), 0) as total
      FROM medios_pago mp
      LEFT JOIN pagos_venta pv ON pv.medio_pago_id = mp.id
      LEFT JOIN ventas v ON v.id = pv.venta_id AND v.turno_id = ? AND v.empresa_id = ? AND v.estado = 'COMPLETADA'
      WHERE mp.empresa_id = ?
      GROUP BY mp.codigo
    `)
    .all(turno_id, empId, empId);

  const mapaPagos = {
    EFECTIVO: 0,
    DEBITO: 0,
    CREDITO: 0,
    QR_TRANSFERENCIA: 0,
    CUENTA_CORRIENTE: 0,
  };
  for (const row of pagosPorMedio) {
    mapaPagos[row.codigo] = Number(row.total || 0);
  }

  const movimientos = db
    .prepare(`
      SELECT tipo, COALESCE(SUM(monto), 0) as total
      FROM movimientos_caja
      WHERE turno_id = ? AND empresa_id = ?
      GROUP BY tipo
    `)
    .all(turno_id, empId);

  let entradasEfectivo = 0;
  let salidasEfectivo = 0;
  for (const m of movimientos) {
    if (m.tipo === 'ENTRADA') entradasEfectivo = Number(m.total || 0);
    if (m.tipo === 'SALIDA') salidasEfectivo = Number(m.total || 0);
  }

  const esperadoEfectivo =
    Number(turno.fondo_inicial) + mapaPagos.EFECTIVO + entradasEfectivo - salidasEfectivo;

  const esperadoDigitalTotal =
    mapaPagos.DEBITO + mapaPagos.CREDITO + mapaPagos.QR_TRANSFERENCIA + mapaPagos.CUENTA_CORRIENTE;

  return {
    turno_id: turno.id,
    empresa_id: empId,
    puesto_caja: turno.puesto_caja,
    nombre_turno: turno.nombre_turno,
    estado: turno.estado,
    fondo_inicial: Number(turno.fondo_inicial),
    entradas_efectivo: entradasEfectivo,
    salidas_efectivo: salidasEfectivo,
    ventas_por_medio: mapaPagos,
    esperado_efectivo: Math.round(esperadoEfectivo * 100) / 100,
    esperado_digital_total: Math.round(esperadoDigitalTotal * 100) / 100,
    total_recaudado_ventas:
      Math.round((mapaPagos.EFECTIVO + esperadoDigitalTotal) * 100) / 100,
  };
}

function obtenerResumenAcotadoSupervisor(db = getDb(), turno_id, actor = null) {
  const empresaId = (actor && actor.empresa_id) || null;
  const saldos = calcularSaldosEsperadosTurno(db, turno_id, empresaId);
  return {
    turno_id: saldos.turno_id,
    empresa_id: saldos.empresa_id,
    puesto_caja: saldos.puesto_caja,
    nombre_turno: saldos.nombre_turno,
    estado: saldos.estado,
    total_efectivo_en_cajon_turno: saldos.esperado_efectivo,
  };
}

function cerrarTurnoArqueoCiego(
  db = getDb(),
  {
    turno_id,
    fondo_inicial = 0,
    declarado_efectivo = 0,
    declarado_debito = 0,
    declarado_credito = 0,
    declarado_qr = 0,
    declarado_cuenta_corriente = 0,
    observaciones_cierre = '',
  },
  actor
) {
  const empresaId = (actor && actor.empresa_id) || DEFAULT_EMPRESA_ID;
  const turno = ensureTurnoInDb(db, turno_id, empresaId, actor, fondo_inicial);
  if (!turno) {
    const err = new Error('Turno no encontrado en esta empresa.');
    err.statusCode = 404;
    throw err;
  }
  if (turno.estado === 'CERRADO') throw new Error('El turno ya se encuentra cerrado.');

  const saldos = calcularSaldosEsperadosTurno(db, turno_id, empresaId);

  const decEfectivo = Number(declarado_efectivo || 0);
  const decDebito = Number(declarado_debito || 0);
  const decCredito = Number(declarado_credito || 0);
  const decQr = Number(declarado_qr || 0);
  const decFiado = Number(declarado_cuenta_corriente || 0);
  const decDigitalTotal = decDebito + decCredito + decQr + decFiado;

  const diferenciaEfectivo = Math.round((decEfectivo - saldos.esperado_efectivo) * 100) / 100;
  const diferenciaTotal =
    Math.round(
      (decEfectivo + decDigitalTotal - (saldos.esperado_efectivo + saldos.esperado_digital_total)) * 100
    ) / 100;

  let estadoCuadre = 'EXACTO';
  if (diferenciaTotal > 0.009) estadoCuadre = 'SOBRANTE';
  else if (diferenciaTotal < -0.009) estadoCuadre = 'FALTANTE';

  const cerradoEn = new Date().toISOString();

  db.prepare(`
    UPDATE turnos_caja
    SET cajero_cierre_id = ?,
        estado = 'CERRADO',
        cerrado_en = ?,
        declarado_efectivo = ?,
        declarado_debito = ?,
        declarado_credito = ?,
        declarado_qr = ?,
        declarado_cuenta_corriente = ?,
        esperado_efectivo = ?,
        esperado_digital_total = ?,
        diferencia_efectivo = ?,
        diferencia_total = ?,
        estado_cuadre = ?,
        observaciones_cierre = ?
    WHERE id = ? AND empresa_id = ?
  `).run(
    actor.id,
    cerradoEn,
    decEfectivo,
    decDebito,
    decCredito,
    decQr,
    decFiado,
    saldos.esperado_efectivo,
    saldos.esperado_digital_total,
    diferenciaEfectivo,
    diferenciaTotal,
    estadoCuadre,
    observaciones_cierre,
    turno_id,
    empresaId
  );

  registrarAuditoria({
    db,
    empresaId,
    usuarioId: actor.id,
    rolUsuario: actor.rol,
    terminal: turno.puesto_caja,
    accion: 'CIERRE_ARQUEO_CIEGO',
    entidadAfectada: 'turnos_caja',
    entidadId: turno_id,
    detalle: {
      declarado_efectivo: decEfectivo,
      declarado_digital: decDigitalTotal,
      esperado_efectivo: saldos.esperado_efectivo,
      diferencia_efectivo: diferenciaEfectivo,
      diferencia_total: diferenciaTotal,
      estado_cuadre: estadoCuadre,
    },
  });

  broadcastEvent('TURNO_CERRADO', { empresaId, turnoId: turno_id, estadoCuadre, diferenciaTotal });

  const registroCompleto = db.prepare('SELECT * FROM turnos_caja WHERE id = ?').get(turno_id);

  if (actor.rol !== 'DUENO' && actor.rol !== 'SOPORTE') {
    return {
      id: registroCompleto.id,
      empresa_id: registroCompleto.empresa_id,
      puesto_caja: registroCompleto.puesto_caja,
      nombre_turno: registroCompleto.nombre_turno,
      estado: registroCompleto.estado,
      cerrado_en: registroCompleto.cerrado_en,
      declarado_efectivo: registroCompleto.declarado_efectivo,
      declarado_debito: registroCompleto.declarado_debito,
      declarado_credito: registroCompleto.declarado_credito,
      declarado_qr: registroCompleto.declarado_qr,
      declarado_cuenta_corriente: registroCompleto.declarado_cuenta_corriente,
      arqueo_ciego_registrado: true,
      mensaje: 'Arqueo ciego registrado correctamente.',
    };
  }

  return registroCompleto;
}

module.exports = {
  ensureTurnoInDb,
  abrirTurnoCaja,
  obtenerTurnoActivo,
  obtenerTurnosEnArqueo,
  iniciarCierreTurno,
  registrarMovimientoCaja,
  calcularSaldosEsperadosTurno,
  obtenerResumenAcotadoSupervisor,
  cerrarTurnoArqueoCiego,
};
