const { getDb, DEFAULT_EMPRESA_ID } = require('../db/database');
const { calcularSaldosEsperadosTurno } = require('./turnos.service');

function buildWhereClause({
  empresa_id = DEFAULT_EMPRESA_ID,
  fecha = null,
  fecha_desde = null,
  fecha_hasta = null,
  turno_id = null,
  cajero_id = null,
  rubro_id = null,
}) {
  const conditions = ["v.estado = 'COMPLETADA'", 'v.empresa_id = ?'];
  const params = [empresa_id];

  if (fecha) {
    conditions.push('substr(v.fecha_venta, 1, 10) = ?');
    params.push(fecha);
  } else {
    if (fecha_desde) {
      conditions.push('substr(v.fecha_venta, 1, 10) >= ?');
      params.push(fecha_desde);
    }
    if (fecha_hasta) {
      conditions.push('substr(v.fecha_venta, 1, 10) <= ?');
      params.push(fecha_hasta);
    }
  }

  if (turno_id) {
    conditions.push('v.turno_id = ?');
    params.push(turno_id);
  }

  if (cajero_id) {
    conditions.push('v.cajero_id = ?');
    params.push(cajero_id);
  }

  if (rubro_id) {
    conditions.push(
      'EXISTS (SELECT 1 FROM lineas_venta_rubro lvr WHERE lvr.venta_id = v.id AND lvr.rubro_id = ?)'
    );
    params.push(rubro_id);
  }

  return {
    whereSql: conditions.join(' AND '),
    params,
  };
}

function obtenerDashboardEnVivo(db = getDb(), filtros = {}) {
  const empresaId = filtros.empresa_id || DEFAULT_EMPRESA_ID;
  const { whereSql, params } = buildWhereClause({ ...filtros, empresa_id: empresaId });

  const kpisRow = db
    .prepare(`
      SELECT
        COUNT(v.id) AS cantidad_tickets,
        COALESCE(SUM(v.monto_total), 0) AS recaudacion_total,
        COALESCE(SUM(v.cantidad_total_articulos), 0) AS unidades_vendidas,
        COALESCE(AVG(v.monto_total), 0) AS ticket_promedio
      FROM ventas v
      WHERE ${whereSql}
    `)
    .get(...params);

  const turnosAbiertos = db
    .prepare(
      "SELECT id FROM turnos_caja WHERE empresa_id = ? AND estado = 'ABIERTO' ORDER BY abierto_en DESC"
    )
    .all(empresaId);

  let efectivoTotalEnCajones = 0;
  let digitalTotalEnTurnosAbiertos = 0;
  const detalleCajasAbiertas = turnosAbiertos.map((t) => {
    const s = calcularSaldosEsperadosTurno(db, t.id, empresaId);
    efectivoTotalEnCajones += s.esperado_efectivo;
    digitalTotalEnTurnosAbiertos += s.esperado_digital_total;
    return s;
  });

  const totalGeneral = Number(kpisRow.recaudacion_total || 0);
  const porEmpleadoRaw = db
    .prepare(`
      SELECT
        u.id AS cajero_id,
        u.nombre AS cajero_nombre,
        COUNT(v.id) AS cantidad_tickets,
        COALESCE(SUM(v.monto_total), 0) AS total_vendido,
        COALESCE(AVG(v.monto_total), 0) AS ticket_promedio
      FROM usuarios u
      LEFT JOIN ventas v ON v.cajero_id = u.id AND (${whereSql})
      WHERE u.empresa_id = ? AND u.rol IN ('CAJERO', 'SUPERVISOR', 'DUENO') AND u.activo = 1
      GROUP BY u.id, u.nombre
      HAVING COUNT(v.id) > 0 OR u.rol = 'CAJERO'
      ORDER BY total_vendido DESC
    `)
    .all(...params, empresaId);

  const rendimientoEmpleados = porEmpleadoRaw.map((emp) => ({
    cajero_id: emp.cajero_id,
    cajero_nombre: emp.cajero_nombre,
    cantidad_tickets: Number(emp.cantidad_tickets),
    total_vendido: Math.round(Number(emp.total_vendido) * 100) / 100,
    ticket_promedio: Math.round(Number(emp.ticket_promedio) * 100) / 100,
    porcentaje_participacion:
      totalGeneral > 0 ? Math.round((Number(emp.total_vendido) / totalGeneral) * 10000) / 100 : 0,
  }));

  const ventasPorRubroRaw = db
    .prepare(`
      SELECT
        r.id AS rubro_id,
        r.nombre AS rubro_nombre,
        r.color_hex,
        COALESCE(SUM(CASE WHEN v.id IS NOT NULL THEN lvr.cantidad ELSE 0 END), 0) AS unidades,
        COALESCE(SUM(CASE WHEN v.id IS NOT NULL THEN lvr.subtotal ELSE 0 END), 0) AS total_vendido
      FROM rubros r
      LEFT JOIN lineas_venta_rubro lvr ON lvr.rubro_id = r.id
      LEFT JOIN ventas v ON v.id = lvr.venta_id AND (${whereSql})
      WHERE r.empresa_id = ? AND r.activo = 1
      GROUP BY r.id, r.nombre, r.color_hex
      ORDER BY total_vendido DESC
    `)
    .all(...params, empresaId);

  const sumaRubros = ventasPorRubroRaw.reduce((acc, r) => acc + Number(r.total_vendido), 0);
  const ventasPorRubro = ventasPorRubroRaw.map((r) => ({
    rubro_id: r.rubro_id,
    rubro_nombre: r.rubro_nombre,
    color_hex: r.color_hex,
    unidades: Number(r.unidades),
    total_vendido: Math.round(Number(r.total_vendido) * 100) / 100,
    porcentaje: sumaRubros > 0 ? Math.round((Number(r.total_vendido) / sumaRubros) * 10000) / 100 : 0,
  }));

  const ventasPorMedioRaw = db
    .prepare(`
      SELECT
        mp.id AS medio_id,
        mp.codigo,
        mp.nombre AS medio_nombre,
        COALESCE(SUM(CASE WHEN v.id IS NOT NULL THEN pv.monto ELSE 0 END), 0) AS total_ingresado,
        COUNT(DISTINCT CASE WHEN v.id IS NOT NULL THEN pv.venta_id ELSE NULL END) AS cantidad_operaciones
      FROM medios_pago mp
      LEFT JOIN pagos_venta pv ON pv.medio_pago_id = mp.id
      LEFT JOIN ventas v ON v.id = pv.venta_id AND (${whereSql})
      WHERE mp.empresa_id = ? AND mp.activo = 1
      GROUP BY mp.id, mp.codigo, mp.nombre
      ORDER BY mp.orden ASC
    `)
    .all(...params, empresaId);

  const ventasPorMedioPago = ventasPorMedioRaw.map((m) => ({
    medio_id: m.medio_id,
    codigo: m.codigo,
    medio_nombre: m.medio_nombre,
    total_ingresado: Math.round(Number(m.total_ingresado) * 100) / 100,
    cantidad_operaciones: Number(m.cantidad_operaciones),
    porcentaje:
      totalGeneral > 0 ? Math.round((Number(m.total_ingresado) / totalGeneral) * 10000) / 100 : 0,
  }));

  const ventasPorHora = db
    .prepare(`
      SELECT
        substr(v.fecha_venta, 12, 2) || ':00' AS franja_horaria,
        COUNT(v.id) AS cantidad_tickets,
        COALESCE(SUM(v.monto_total), 0) AS total_vendido
      FROM ventas v
      WHERE ${whereSql}
      GROUP BY substr(v.fecha_venta, 12, 2)
      ORDER BY franja_horaria ASC
    `)
    .all(...params);

  const nombresDia = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const ventasPorDiaRaw = db
    .prepare(`
      SELECT
        substr(v.fecha_venta, 1, 10) AS fecha,
        CAST(strftime('%w', v.fecha_venta) AS INTEGER) AS dia_semana_num,
        COUNT(v.id) AS cantidad_tickets,
        COALESCE(SUM(v.monto_total), 0) AS total_vendido
      FROM ventas v
      WHERE ${whereSql}
      GROUP BY substr(v.fecha_venta, 1, 10)
      ORDER BY fecha DESC
      LIMIT 90
    `)
    .all(...params);

  const ventasPorDia = ventasPorDiaRaw.map((d) => ({
    fecha: d.fecha,
    dia_semana: nombresDia[d.dia_semana_num] || 'Día',
    cantidad_tickets: Number(d.cantidad_tickets),
    total_vendido: Math.round(Number(d.total_vendido) * 100) / 100,
  }));

  const historialArqueos = db
    .prepare(`
      SELECT
        t.id, t.empresa_id, t.puesto_caja, t.nombre_turno, t.estado, t.abierto_en, t.cerrado_en,
        u.nombre AS cajero_nombre,
        t.fondo_inicial, t.declarado_efectivo, t.esperado_efectivo,
        t.diferencia_efectivo, t.diferencia_total, t.estado_cuadre
      FROM turnos_caja t
      JOIN usuarios u ON u.id = t.cajero_apertura_id
      WHERE t.empresa_id = ?
      ORDER BY t.abierto_en DESC
      LIMIT 20
    `)
    .all(empresaId);

  return {
    generado_en: new Date().toISOString(),
    empresa_id: empresaId,
    filtros_aplicados: filtros,
    kpis: {
      recaudacion_total: Math.round(totalGeneral * 100) / 100,
      cantidad_tickets: Number(kpisRow.cantidad_tickets || 0),
      ticket_promedio: Math.round(Number(kpisRow.ticket_promedio || 0) * 100) / 100,
      unidades_vendidas: Number(kpisRow.unidades_vendidas || 0),
      efectivo_en_cajon_actual: Math.round(efectivoTotalEnCajones * 100) / 100,
      ingresos_digitales_turnos_abiertos: Math.round(digitalTotalEnTurnosAbiertos * 100) / 100,
    },
    cajas_abiertas: detalleCajasAbiertas,
    rendimiento_empleados: rendimientoEmpleados,
    ventas_por_rubro: ventasPorRubro,
    ventas_por_medio_pago: ventasPorMedioPago,
    ventas_por_hora: ventasPorHora,
    ventas_por_dia: ventasPorDia,
    historial_arqueos: historialArqueos,
  };
}

function exportarReporte(db = getDb(), filtros = {}, formato = 'excel') {
  const data = obtenerDashboardEnVivo(db, filtros);

  if (formato === 'excel') {
    const lines = [
      '\uFEFFREPORTE DE CAJA Y VENTAS - ALMACEN / MINIMERCADO',
      `Fecha de Generacion;${data.generado_en}`,
      '',
      'INDICADORES CLAVE DEL PERIODO',
      'Recaudacion Total ($);Cantidad de Tickets;Ticket Promedio ($);Unidades Vendidas;Efectivo Estimado en Cajon ($)',
      `${data.kpis.recaudacion_total};${data.kpis.cantidad_tickets};${data.kpis.ticket_promedio};${data.kpis.unidades_vendidas};${data.kpis.efectivo_en_cajon_actual}`,
      '',
      'RENDIMIENTO POR EMPLEADO',
      'Empleado;Tickets Emitidos;Total Vendido ($);Ticket Promedio ($);Participacion (%)',
      ...data.rendimiento_empleados.map(
        (e) =>
          `${e.cajero_nombre};${e.cantidad_tickets};${e.total_vendido};${e.ticket_promedio};${e.porcentaje_participacion}%`
      ),
      '',
      'VENTAS POR RUBRO',
      'Rubro / Familia;Unidades;Total Vendido ($);Participacion (%)',
      ...data.ventas_por_rubro.map(
        (r) => `${r.rubro_nombre};${r.unidades};${r.total_vendido};${r.porcentaje}%`
      ),
      '',
      'VENTAS POR MEDIO DE PAGO',
      'Medio de Pago;Operaciones;Total Ingresado ($);Participacion (%)',
      ...data.ventas_por_medio_pago.map(
        (m) => `${m.medio_nombre};${m.cantidad_operaciones};${m.total_ingresado};${m.porcentaje}%`
      ),
      '',
      'VENTAS POR FRANJA HORARIA',
      'Hora;Tickets;Total Vendido ($)',
      ...data.ventas_por_hora.map((h) => `${h.franja_horaria};${h.cantidad_tickets};${h.total_vendido}`),
    ];
    return {
      contentType: 'text/csv; charset=utf-8',
      filename: `reporte_caja_${new Date().toISOString().slice(0, 10)}.csv`,
      content: lines.join('\r\n'),
    };
  }

  const htmlPdf = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Reporte de Caja y Ventas</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; margin: 24px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    h2 { font-size: 15px; margin-top: 20px; border-bottom: 2px solid #111; padding-bottom: 4px; }
    .kpi-grid { display: flex; gap: 16px; margin: 12px 0; }
    .kpi-box { border: 1px solid #333; padding: 10px 14px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
    th { background: #f3f4f6; }
  </style>
</head>
<body onload="window.print()">
  <h1>Reporte de Recaudación, Ventas y Arqueo de Caja</h1>
  <p>Generado: ${data.generado_en}</p>
  <div class="kpi-grid">
    <div class="kpi-box"><strong>Recaudación Total:</strong> $${data.kpis.recaudacion_total}</div>
    <div class="kpi-box"><strong>Efectivo en Cajón:</strong> $${data.kpis.efectivo_en_cajon_actual}</div>
    <div class="kpi-box"><strong>Tickets Emitidos:</strong> ${data.kpis.cantidad_tickets}</div>
    <div class="kpi-box"><strong>Ticket Promedio:</strong> $${data.kpis.ticket_promedio}</div>
  </div>
  <h2>Rendimiento por Empleado</h2>
  <table>
    <thead><tr><th>Empleado</th><th>Tickets</th><th>Total ($)</th><th>Promedio ($)</th><th>% Local</th></tr></thead>
    <tbody>
      ${data.rendimiento_empleados
        .map(
          (e) =>
            `<tr><td>${e.cajero_nombre}</td><td>${e.cantidad_tickets}</td><td>$${e.total_vendido}</td><td>$${e.ticket_promedio}</td><td>${e.porcentaje_participacion}%</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
  <h2>Ventas por Rubro</h2>
  <table>
    <thead><tr><th>Rubro</th><th>Unidades</th><th>Total ($)</th><th>%</th></tr></thead>
    <tbody>
      ${data.ventas_por_rubro
        .map(
          (r) =>
            `<tr><td>${r.rubro_nombre}</td><td>${r.unidades}</td><td>$${r.total_vendido}</td><td>${r.porcentaje}%</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
  <h2>Ventas por Medio de Pago</h2>
  <table>
    <thead><tr><th>Medio de Pago</th><th>Operaciones</th><th>Total ($)</th><th>%</th></tr></thead>
    <tbody>
      ${data.ventas_por_medio_pago
        .map(
          (m) =>
            `<tr><td>${m.medio_nombre}</td><td>${m.cantidad_operaciones}</td><td>$${m.total_ingresado}</td><td>${m.porcentaje}%</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
</body>
</html>`;

  return {
    contentType: 'text/html; charset=utf-8',
    filename: `reporte_caja_${new Date().toISOString().slice(0, 10)}.html`,
    content: htmlPdf,
  };
}

module.exports = {
  obtenerDashboardEnVivo,
  exportarReporte,
};
