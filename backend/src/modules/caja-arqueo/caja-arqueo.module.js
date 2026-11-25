const {
  obtenerSnapshotCatalogos,
  crearRubro,
  editarRubro,
  eliminarRubro,
  crearClienteFiado,
} = require('../../services/catalogos.service');
const {
  abrirTurnoCaja,
  obtenerTurnoActivo,
  obtenerTurnosEnArqueo,
  iniciarCierreTurno,
  registrarMovimientoCaja,
  obtenerResumenAcotadoSupervisor,
  cerrarTurnoArqueoCiego,
} = require('../../services/turnos.service');
const {
  registrarVenta,
  sincronizarVentasOffline,
  anularVenta,
  listarVentasRecientes,
  obtenerVentaPorId,
} = require('../../services/ventas.service');
const { obtenerDashboardEnVivo } = require('../../services/analitica.service');

/**
 * Módulo de Dominio Enchufable: Caja y Arqueo (Sin Stock, Venta por Rubros, Turnos y Arqueo Ciego)
 * Registrado en el ModuleRegistry del Core Blueprint bajo `/api/v1/caja-arqueo`.
 */
const cajaArqueoModule = {
  name: 'caja-arqueo',
  prefix: '/api/v1/caja-arqueo',
  permissions: {
    OPERAR_CAJA_ARQUEO: ['CAJERO', 'OPERADOR', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
    SUPERVISAR_CAJA_ARQUEO: ['SUPERVISOR', 'DUENO', 'SOPORTE'],
    ADMINISTRAR_CAJA_ARQUEO: ['DUENO', 'SOPORTE'],
  },
  routes: [
    // 1. Catálogos de la Empresa Activa (Rubros, 5 Medios de Pago, Clientes Fiado)
    {
      method: 'GET',
      path: '/catalogos/snapshot',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor }) => {
        const snapshot = obtenerSnapshotCatalogos(db, actor.empresa_id);
        return { status: 200, data: snapshot };
      },
    },
    {
      method: 'POST',
      path: '/catalogos/rubros',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const rubro = crearRubro(db, body, actor);
        return { status: 201, data: { rubro } };
      },
    },
    {
      method: 'PATCH',
      path: '/catalogos/rubros/:id',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, params, body }) => {
        const rubro = editarRubro(db, params.id, body, actor);
        return { status: 200, data: { rubro } };
      },
    },
    {
      method: 'DELETE',
      path: '/catalogos/rubros/:id',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, params }) => {
        const res = eliminarRubro(db, params.id, actor);
        return { status: 200, data: res };
      },
    },
    {
      method: 'POST',
      path: '/catalogos/clientes-fiado',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const cliente = crearClienteFiado(db, body, actor);
        return { status: 201, data: { cliente } };
      },
    },

    // 2. Turnos, Movimientos y Arqueo Ciego
    {
      method: 'GET',
      path: '/turnos/activo',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, query }) => {
        const puesto = query.get('puesto_caja') || 'CAJA-01';
        const turno = obtenerTurnoActivo(db, puesto, actor.empresa_id);
        const turnosEnArqueo = obtenerTurnosEnArqueo(db, puesto, actor.empresa_id);
        return {
          status: 200,
          data: { turno: turno || null, turnos_en_arqueo: turnosEnArqueo },
        };
      },
    },
    {
      method: 'POST',
      path: '/turnos/abrir',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const turno = abrirTurnoCaja(db, body, actor);
        return { status: 201, data: { turno } };
      },
    },
    {
      method: 'POST',
      path: '/turnos/iniciar-cierre',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const turno = iniciarCierreTurno(db, body, actor);
        return { status: 200, data: { turno } };
      },
    },
    {
      method: 'POST',
      path: '/turnos/movimientos',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const movimiento = registrarMovimientoCaja(db, body, actor);
        return { status: 201, data: { movimiento } };
      },
    },
    {
      method: 'GET',
      path: '/turnos/resumen-supervisor',
      permission: 'SUPERVISAR_CAJA_ARQUEO',
      handler: ({ db, actor, query }) => {
        const turnoId = query.get('turno_id');
        const resumen = obtenerResumenAcotadoSupervisor(db, turnoId, actor);
        return { status: 200, data: resumen };
      },
    },
    {
      method: 'POST',
      path: '/turnos/cerrar-arqueo',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const resultado = cerrarTurnoArqueoCiego(db, body, actor);
        return { status: 200, data: resultado };
      },
    },

    // 3. Ventas por Rubro, Pagos Combinados y Sincronización Offline
    {
      method: 'GET',
      path: '/ventas',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, query }) => {
        const turnoId = query.get('turno_id') || null;
        const limit = Number(query.get('limit') || 25);
        const ventas = listarVentasRecientes(db, {
          empresaId: actor.empresa_id,
          turno_id: turnoId,
          limit,
        });
        return { status: 200, data: { items: ventas, total: ventas.length } };
      },
    },
    {
      method: 'GET',
      path: '/ventas/:id',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, params }) => {
        const venta = obtenerVentaPorId(db, params.id, actor);
        return { status: 200, data: { venta } };
      },
    },
    {
      method: 'POST',
      path: '/ventas',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const normalizedBody = {
          ...body,
          lineas_rubro: body.lineas_rubro || body.lineas || [],
        };
        const venta = registrarVenta(db, normalizedBody, actor);
        return { status: 201, data: { venta } };
      },
    },
    {
      method: 'POST',
      path: '/ventas/offline-sync',
      permission: 'OPERAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const resultado = sincronizarVentasOffline(db, body, actor);
        return { status: 200, data: resultado };
      },
    },
    {
      method: 'POST',
      path: '/ventas/anular',
      permission: 'SUPERVISAR_CAJA_ARQUEO',
      handler: ({ db, actor, body }) => {
        const venta = anularVenta(db, body, actor);
        return { status: 200, data: { venta } };
      },
    },

    // 4. Analítica y Tablero en Vivo
    {
      method: 'GET',
      path: '/analitica/dashboard',
      permission: 'ADMINISTRAR_CAJA_ARQUEO',
      handler: ({ db, actor, query }) => {
        const dashboard = obtenerDashboardEnVivo(db, {
          empresa_id: actor.empresa_id,
          fecha: query.get('fecha') || null,
          fecha_desde: query.get('fecha_desde') || null,
          fecha_hasta: query.get('fecha_hasta') || null,
          turno_id: query.get('turno_id') || null,
          cajero_id: query.get('cajero_id') || null,
          rubro_id: query.get('rubro_id') || null,
        });
        return { status: 200, data: dashboard };
      },
    },
  ],
};

module.exports = { cajaArqueoModule };
