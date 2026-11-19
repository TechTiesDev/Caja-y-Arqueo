/* ============================================================================
   MOTOR AUTÓNOMO EMBEBIDO PARA PROTOTIPO APK ANDROID (OFFLINE / WEBVIEW NATIVO)
   Permite que el APK funcione al 100% en cualquier celular sin depender del servidor PC.
   ============================================================================ */

(function initStandaloneEngine() {
  const STORAGE_KEY = 'caja_apk_standalone_db_v1';

  function loadDb() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // Recrear si está corrupto
      }
    }
    const initial = {
      empresas: [
        {
          id: 'emp-default-01',
          nombre: 'Almacén Central',
          telefono: '11-4000-5000',
          email: 'admin@almacencentral.com',
          activo: 1,
          creado_en: new Date().toISOString(),
        },
      ],
      usuarios: [
        {
          id: 'usr-soporte-01',
          empresa_id: null,
          nombre: 'Soporte',
          username: 'soporte',
          email: 'soporte@cajayarqueo.com',
          pin: '9999',
          rol: 'SOPORTE',
          activo: 1,
          creado_en: new Date().toISOString(),
        },
        {
          id: 'usr-dueno-01',
          empresa_id: 'emp-default-01',
          nombre: 'Roberto (Dueño)',
          username: 'dueno',
          email: 'roberto@almacencentral.com',
          pin: '9999',
          rol: 'DUENO',
          activo: 1,
          creado_en: new Date().toISOString(),
        },
        {
          id: 'usr-super-01',
          empresa_id: 'emp-default-01',
          nombre: 'Carla (Supervisora)',
          username: 'supervisor',
          email: 'carla@almacencentral.com',
          pin: '5555',
          rol: 'SUPERVISOR',
          activo: 1,
          creado_en: new Date().toISOString(),
        },
        {
          id: 'usr-caj-01',
          empresa_id: 'emp-default-01',
          nombre: 'Lucas (Cajero Mañana)',
          username: 'lucas',
          email: 'lucas@almacencentral.com',
          pin: '1111',
          rol: 'CAJERO',
          activo: 1,
          creado_en: new Date().toISOString(),
        },
        {
          id: 'usr-caj-02',
          empresa_id: 'emp-default-01',
          nombre: 'Martina (Cajera Tarde)',
          username: 'martina',
          email: 'martina@almacencentral.com',
          pin: '2222',
          rol: 'CAJERO',
          activo: 1,
          creado_en: new Date().toISOString(),
        },
      ],
      rubros: [
        { id: 'rub-almacen', empresa_id: 'emp-default-01', nombre: 'Almacén', color_hex: '#a86b43', orden: 1, activo: 1 },
        { id: 'rub-bebidas', empresa_id: 'emp-default-01', nombre: 'Bebidas', color_hex: '#0891B2', orden: 2, activo: 1 },
        { id: 'rub-lacteos', empresa_id: 'emp-default-01', nombre: 'Lácteos', color_hex: '#0284C7', orden: 3, activo: 1 },
        { id: 'rub-fiambreria', empresa_id: 'emp-default-01', nombre: 'Fiambrería', color_hex: '#DC2626', orden: 4, activo: 1 },
        { id: 'rub-panaderia', empresa_id: 'emp-default-01', nombre: 'Panadería', color_hex: '#D97706', orden: 5, activo: 1 },
        { id: 'rub-limpieza', empresa_id: 'emp-default-01', nombre: 'Limpieza', color_hex: '#588157', orden: 6, activo: 1 },
        { id: 'rub-verduleria', empresa_id: 'emp-default-01', nombre: 'Verdulería', color_hex: '#65A30D', orden: 7, activo: 1 },
      ],
      mediosPago: [
        { id: 'mp-efectivo', empresa_id: 'emp-default-01', codigo: 'EFECTIVO', nombre: 'Efectivo', orden: 1, activo: 1 },
        { id: 'mp-debito', empresa_id: 'emp-default-01', codigo: 'DEBITO', nombre: 'Tarjeta de Débito', orden: 2, activo: 1 },
        { id: 'mp-credito', empresa_id: 'emp-default-01', codigo: 'CREDITO', nombre: 'Tarjeta de Crédito', orden: 3, activo: 1 },
        { id: 'mp-qr', empresa_id: 'emp-default-01', codigo: 'QR_TRANSFERENCIA', nombre: 'Transferencia / QR (MP)', orden: 4, activo: 1 },
        { id: 'mp-fiado', empresa_id: 'emp-default-01', codigo: 'CUENTA_CORRIENTE', nombre: 'Cuenta Corriente (Fiado)', orden: 5, activo: 1 },
      ],
      clientesFiado: [
        { id: 'cli-01', empresa_id: 'emp-default-01', nombre: 'Familia Gómez', documento_telefono: '11-4455-6677', limite_credito: 50000, saldo_deudor: 12000, activo: 1 },
        { id: 'cli-02', empresa_id: 'emp-default-01', nombre: 'Kiosco El Paso', documento_telefono: '11-2233-4455', limite_credito: 80000, saldo_deudor: 0, activo: 1 },
      ],
      turnos: [],
      movimientos: [],
      ventas: [],
      auditoria: [],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }

  function saveDb(db) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  window.handleStandaloneApi = async function handleStandaloneApi(path, options = {}) {
    const db = loadDb();
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    const urlObj = new URL(path, 'http://localhost');
    const pathname = urlObj.pathname.startsWith('/auth/') ? `/api${urlObj.pathname}` : urlObj.pathname;

    const sessionRaw = localStorage.getItem('caja_session');
    const sessionUser = sessionRaw ? JSON.parse(sessionRaw).usuario : null;
    const empresaId = sessionUser?.empresa_id || 'emp-default-01';

    // 1. Login
    if (method === 'POST' && pathname === '/api/auth/login') {
      const cred = String(body.username || body.email || '').trim().toLowerCase();
      const pass = String(body.pin || body.password || '');
      const u = db.usuarios.find(
        (x) => ((x.username || '').toLowerCase() === cred || (x.email || '').toLowerCase() === cred) && x.pin === pass && x.activo
      );
      if (!u) throw new Error('Credenciales o PIN incorrectos.');
      if (u.rol === 'SOPORTE') u.empresa_id = null;
      const emp = u.empresa_id ? db.empresas.find((e) => e.id === u.empresa_id) : null;
      saveDb(db);
      return {
        token: `apk-token-${u.id}`,
        access_token: `apk-token-${u.id}`,
        usuario: { ...u, empresa_nombre: emp ? emp.nombre : null },
      };
    }

    // 2. Register Empresa
    if (method === 'POST' && pathname === '/api/auth/register-empresa') {
      const empId = uid('emp');
      const emp = {
        id: empId,
        nombre: body.nombre_empresa,
        telefono: body.telefono || '',
        activo: 1,
        creado_en: new Date().toISOString(),
      };
      db.empresas.push(emp);
      const dueno = {
        id: uid('usr'),
        empresa_id: empId,
        nombre: body.nombre_dueno,
        username: String(body.email_dueno).toLowerCase(),
        email: String(body.email_dueno).toLowerCase(),
        pin: String(body.password_dueno),
        rol: 'DUENO',
        activo: 1,
        creado_en: new Date().toISOString(),
      };
      db.usuarios.push(dueno);
      // Clonar rubros y medios base para la nueva empresa
      ['Almacén', 'Bebidas', 'Lácteos', 'Fiambrería', 'Panadería', 'Limpieza'].forEach((nom, i) => {
        db.rubros.push({ id: uid('rub'), empresa_id: empId, nombre: nom, color_hex: '#a86b43', orden: i + 1, activo: 1 });
      });
      [
        ['EFECTIVO', 'Efectivo'],
        ['DEBITO', 'Tarjeta de Débito'],
        ['CREDITO', 'Tarjeta de Crédito'],
        ['QR_TRANSFERENCIA', 'Transferencia / QR (MP)'],
        ['CUENTA_CORRIENTE', 'Cuenta Corriente (Fiado)'],
      ].forEach(([cod, nom], i) => {
        db.mediosPago.push({ id: uid('mp'), empresa_id: empId, codigo: cod, nombre: nom, orden: i + 1, activo: 1 });
      });
      saveDb(db);
      return {
        token: `apk-token-${dueno.id}`,
        access_token: `apk-token-${dueno.id}`,
        empresa: emp,
        usuario: { ...dueno, empresa_nombre: emp.nombre },
      };
    }

    // 3. Soporte: Empresas e Inmersión
    if (method === 'GET' && pathname === '/api/auth/empresas') {
      const q = (urlObj.searchParams.get('q') || '').toLowerCase();
      const list = db.empresas
        .filter((e) => e.nombre.toLowerCase().includes(q))
        .map((e) => ({
          ...e,
          total_usuarios: db.usuarios.filter((u) => u.empresa_id === e.id).length,
          total_ventas: db.ventas.filter((v) => v.empresa_id === e.id && v.estado === 'COMPLETADA').length,
        }));
      return { empresas: list };
    }

    const matchIng = pathname.match(/^\/api\/auth\/empresas\/([^/]+)\/ingresar$/);
    if (method === 'POST' && matchIng) {
      const targetEmp = db.empresas.find((e) => e.id === decodeURIComponent(matchIng[1]));
      if (!targetEmp) throw new Error('Empresa no encontrada.');
      return {
        token: `apk-token-soporte-${targetEmp.id}`,
        access_token: `apk-token-soporte-${targetEmp.id}`,
        empresa_id: targetEmp.id,
        empresa_nombre: targetEmp.nombre,
        usuario: { ...sessionUser, empresa_id: targetEmp.id, empresa_nombre: targetEmp.nombre },
      };
    }

    if (method === 'POST' && pathname === '/api/auth/empresas/salir') {
      return {
        token: 'apk-token-soporte',
        access_token: 'apk-token-soporte',
        empresa_id: null,
        empresa_nombre: null,
        usuario: { ...sessionUser, empresa_id: null, empresa_nombre: null },
      };
    }

    if (method === 'GET' && pathname === '/api/auth/soporte/usuarios') {
      return { usuarios: db.usuarios.filter((u) => u.rol === 'SOPORTE') };
    }

    if (method === 'POST' && pathname === '/api/auth/soporte/usuarios') {
      const nuevo = {
        id: uid('usr-sop'),
        empresa_id: null,
        nombre: body.nombre,
        username: body.email,
        email: body.email,
        pin: String(body.password || '9999'),
        rol: 'SOPORTE',
        activo: 1,
        creado_en: new Date().toISOString(),
      };
      db.usuarios.push(nuevo);
      saveDb(db);
      return nuevo;
    }

    const matchDelSop = pathname.match(/^\/api\/auth\/soporte\/usuarios\/([^/]+)$/);
    if (method === 'DELETE' && matchDelSop) {
      const tId = decodeURIComponent(matchDelSop[1]);
      if (tId === sessionUser?.id) throw new Error('No puedes eliminar tu propio usuario en sesión');
      db.usuarios = db.usuarios.filter((u) => u.id !== tId);
      saveDb(db);
      return { eliminado: true };
    }

    if (method === 'POST' && pathname === '/api/auth/change-password') {
      const u = db.usuarios.find((x) => x.id === sessionUser?.id);
      if (!u || u.pin !== String(body.password_actual)) throw new Error('Contraseña actual incorrecta.');
      u.pin = String(body.password_nueva);
      saveDb(db);
      return { actualizado: true };
    }

    // 4. Catálogos Snapshot
    if (method === 'GET' && pathname === '/api/catalogos/snapshot') {
      return {
        empresa_id: empresaId,
        empleados: db.usuarios.filter((u) => u.empresa_id === empresaId && u.activo && u.rol !== 'SOPORTE'),
        rubros: db.rubros.filter((r) => r.empresa_id === empresaId && r.activo),
        mediosPago: db.mediosPago.filter((m) => m.empresa_id === empresaId && m.activo),
        clientesFiado: db.clientesFiado
          .filter((c) => c.empresa_id === empresaId && c.activo)
          .map((c) => ({ ...c, disponible: c.limite_credito - c.saldo_deudor })),
      };
    }

    if (method === 'POST' && pathname === '/api/catalogos/rubros') {
      const r = { id: uid('rub'), empresa_id: empresaId, nombre: body.nombre, color_hex: '#a86b43', orden: 99, activo: 1 };
      db.rubros.push(r);
      saveDb(db);
      return r;
    }

    const matchDelRub = pathname.match(/^\/api\/catalogos\/rubros\/([^/]+)$/);
    if (method === 'DELETE' && matchDelRub) {
      db.rubros = db.rubros.filter((r) => r.id !== decodeURIComponent(matchDelRub[1]));
      saveDb(db);
      return { eliminado: true };
    }

    if (method === 'POST' && pathname === '/api/catalogos/empleados') {
      const u = {
        id: uid('usr'),
        empresa_id: empresaId,
        nombre: body.nombre,
        username: String(body.username).toLowerCase(),
        pin: String(body.pin),
        rol: body.rol || 'CAJERO',
        activo: 1,
        creado_en: new Date().toISOString(),
      };
      db.usuarios.push(u);
      saveDb(db);
      return u;
    }

    if (method === 'POST' && pathname === '/api/catalogos/clientes-fiado') {
      const c = {
        id: uid('cli'),
        empresa_id: empresaId,
        nombre: body.nombre,
        documento_telefono: body.documento_telefono || '',
        limite_credito: Number(body.limite_credito || 0),
        saldo_deudor: 0,
        activo: 1,
      };
      db.clientesFiado.push(c);
      saveDb(db);
      return c;
    }

    // 5. Turnos y Arqueo
    if (method === 'GET' && pathname === '/api/turnos/activo') {
      const activo = db.turnos.find((t) => t.empresa_id === empresaId && t.estado === 'ABIERTO') || null;
      const enArqueo = db.turnos.filter((t) => t.empresa_id === empresaId && t.estado === 'EN_ARQUEO');
      return { turno: activo, turnos_en_arqueo: enArqueo };
    }

    if (method === 'POST' && pathname === '/api/turnos/abrir') {
      const t = {
        id: uid('tur'),
        empresa_id: empresaId,
        puesto_caja: 'CAJA-01',
        nombre_turno: 'MANANA',
        cajero_apertura_id: sessionUser?.id || 'usr-caj-01',
        cajero_nombre: sessionUser?.nombre || 'Lucas',
        fondo_inicial: Number(body.fondo_inicial || 0),
        estado: 'ABIERTO',
        abierto_en: new Date().toISOString(),
        declarado_efectivo: null,
        esperado_efectivo: null,
        diferencia_efectivo: null,
        estado_cuadre: null,
      };
      db.turnos.unshift(t);
      db.auditoria.unshift({
        id: uid('aud'),
        empresa_id: empresaId,
        accion: 'APERTURA_CAJA',
        usuario_nombre: sessionUser?.nombre || 'Cajero',
        rol_usuario: sessionUser?.rol || 'CAJERO',
        timestamp: new Date().toISOString(),
      });
      saveDb(db);
      return t;
    }

    if (method === 'POST' && pathname === '/api/turnos/iniciar-cierre') {
      const t = db.turnos.find((x) => x.id === body.turno_id);
      if (t) t.estado = 'EN_ARQUEO';
      saveDb(db);
      return t;
    }

    if (method === 'POST' && pathname === '/api/turnos/movimientos') {
      const m = {
        id: uid('mov'),
        empresa_id: empresaId,
        turno_id: body.turno_id,
        tipo: body.tipo,
        monto: Number(body.monto),
        motivo: body.motivo,
        creado_en: new Date().toISOString(),
      };
      db.movimientos.push(m);
      db.auditoria.unshift({
        id: uid('aud'),
        empresa_id: empresaId,
        accion: body.tipo === 'ENTRADA' ? 'ENTRADA_DINERO' : 'SALIDA_DINERO',
        usuario_nombre: sessionUser?.nombre || 'Cajero',
        rol_usuario: sessionUser?.rol || 'CAJERO',
        timestamp: new Date().toISOString(),
      });
      saveDb(db);
      return m;
    }

    if (method === 'POST' && pathname === '/api/turnos/cerrar-arqueo') {
      const t = db.turnos.find((x) => x.id === body.turno_id);
      if (!t) throw new Error('Turno no encontrado.');
      const ventasTurno = db.ventas.filter((v) => v.turno_id === t.id && v.estado === 'COMPLETADA');
      let efVentas = 0;
      ventasTurno.forEach((v) => {
        (v.pagos || []).forEach((p) => {
          if (p.codigo_medio === 'EFECTIVO') efVentas += Number(p.monto);
        });
      });
      const movs = db.movimientos.filter((m) => m.turno_id === t.id);
      const entradas = movs.filter((m) => m.tipo === 'ENTRADA').reduce((a, b) => a + b.monto, 0);
      const salidas = movs.filter((m) => m.tipo === 'SALIDA').reduce((a, b) => a + b.monto, 0);

      t.esperado_efectivo = t.fondo_inicial + efVentas + entradas - salidas;
      t.declarado_efectivo = Number(body.declarado_efectivo || 0);
      t.diferencia_efectivo = t.declarado_efectivo - t.esperado_efectivo;
      t.diferencia_total = t.diferencia_efectivo;
      t.estado_cuadre =
        Math.abs(t.diferencia_efectivo) < 0.01 ? 'EXACTO' : t.diferencia_efectivo > 0 ? 'SOBRANTE' : 'FALTANTE';
      t.estado = 'CERRADO';
      t.cerrado_en = new Date().toISOString();

      db.auditoria.unshift({
        id: uid('aud'),
        empresa_id: empresaId,
        accion: 'CIERRE_ARQUEO_CIEGO',
        usuario_nombre: sessionUser?.nombre || 'Cajero',
        rol_usuario: sessionUser?.rol || 'CAJERO',
        timestamp: new Date().toISOString(),
      });
      saveDb(db);
      return sessionUser?.rol === 'DUENO' || sessionUser?.rol === 'SOPORTE'
        ? t
        : { id: t.id, estado: 'CERRADO', arqueo_ciego_registrado: true };
    }

    if (method === 'GET' && pathname === '/api/turnos/resumen-supervisor') {
      const tId = urlObj.searchParams.get('turno_id');
      const t = db.turnos.find((x) => x.id === tId);
      const ventasTurno = db.ventas.filter((v) => v.turno_id === tId && v.estado === 'COMPLETADA');
      let efVentas = 0;
      ventasTurno.forEach((v) => {
        (v.pagos || []).forEach((p) => {
          if (p.codigo_medio === 'EFECTIVO') efVentas += Number(p.monto);
        });
      });
      const movs = db.movimientos.filter((m) => m.turno_id === tId);
      const entradas = movs.filter((m) => m.tipo === 'ENTRADA').reduce((a, b) => a + b.monto, 0);
      const salidas = movs.filter((m) => m.tipo === 'SALIDA').reduce((a, b) => a + b.monto, 0);
      return { total_efectivo_en_cajon_turno: (t ? t.fondo_inicial : 0) + efVentas + entradas - salidas };
    }

    // 6. Ventas
    if (method === 'POST' && pathname === '/api/ventas') {
      const montoTotal = (body.pagos || []).reduce((a, p) => a + Number(p.monto), 0);
      const cantTotal = (body.lineas_rubro || []).reduce((a, l) => a + Number(l.cantidad), 0);
      const cajeroUser = db.usuarios.find((u) => u.id === body.cajero_id) || sessionUser;
      const nueva = {
        id: body.id || uid('ven'),
        empresa_id: empresaId,
        numero_ticket: db.ventas.filter((v) => v.empresa_id === empresaId).length + 1,
        turno_id: body.turno_id,
        cajero_id: cajeroUser?.id,
        cajero_nombre: cajeroUser?.nombre || 'Cajero',
        cantidad_total_articulos: cantTotal,
        monto_total: montoTotal,
        lineas_rubro: body.lineas_rubro,
        pagos: body.pagos,
        estado: 'COMPLETADA',
        fecha_venta: new Date().toISOString(),
      };
      db.ventas.unshift(nueva);
      saveDb(db);
      return nueva;
    }

    if (method === 'GET' && pathname === '/api/ventas') {
      return { ventas: db.ventas.filter((v) => v.empresa_id === empresaId).slice(0, 20) };
    }

    if (method === 'POST' && pathname === '/api/ventas/anular') {
      const v = db.ventas.find((x) => x.id === body.venta_id && x.empresa_id === empresaId);
      if (v) v.estado = 'ANULADA';
      db.auditoria.unshift({
        id: uid('aud'),
        empresa_id: empresaId,
        accion: 'ANULACION_TICKET',
        usuario_nombre: sessionUser?.nombre || 'Dueño',
        rol_usuario: sessionUser?.rol || 'DUENO',
        timestamp: new Date().toISOString(),
      });
      saveDb(db);
      return v;
    }

    // 7. Auditoría y Dashboard
    if (method === 'GET' && pathname === '/api/auditoria') {
      const acc = urlObj.searchParams.get('accion') || '';
      const logs = db.auditoria.filter((a) => a.empresa_id === empresaId && (!acc || a.accion === acc));
      return { logs };
    }

    if (method === 'POST' && pathname === '/api/auditoria/apertura-cajon') {
      const log = {
        id: uid('aud'),
        empresa_id: empresaId,
        accion: 'APERTURA_CAJON_SIN_VENTA',
        usuario_nombre: sessionUser?.nombre || 'Supervisor',
        rol_usuario: sessionUser?.rol || 'SUPERVISOR',
        timestamp: new Date().toISOString(),
      };
      db.auditoria.unshift(log);
      saveDb(db);
      return log;
    }

    if (method === 'GET' && pathname === '/api/analitica/dashboard') {
      const ventasActivas = db.ventas.filter((v) => v.empresa_id === empresaId && v.estado === 'COMPLETADA');
      const recaudacion = ventasActivas.reduce((a, v) => a + v.monto_total, 0);
      const tickets = ventasActivas.length;
      const promedio = tickets > 0 ? Math.round(recaudacion / tickets) : 0;

      const tAbierto = db.turnos.find((t) => t.empresa_id === empresaId && t.estado === 'ABIERTO');
      let efCajon = tAbierto ? tAbierto.fondo_inicial : 0;
      let digAbierto = 0;
      if (tAbierto) {
        ventasActivas
          .filter((v) => v.turno_id === tAbierto.id)
          .forEach((v) => {
            (v.pagos || []).forEach((p) => {
              if (p.codigo_medio === 'EFECTIVO') efCajon += Number(p.monto);
              else digAbierto += Number(p.monto);
            });
          });
        db.movimientos
          .filter((m) => m.turno_id === tAbierto.id)
          .forEach((m) => {
            if (m.tipo === 'ENTRADA') efCajon += m.monto;
            else efCajon -= m.monto;
          });
      }

      const emps = db.usuarios
        .filter((u) => u.empresa_id === empresaId && u.rol !== 'SOPORTE')
        .map((u) => {
          const vEmp = ventasActivas.filter((v) => v.cajero_id === u.id);
          const tot = vEmp.reduce((a, v) => a + v.monto_total, 0);
          return {
            cajero_id: u.id,
            cajero_nombre: u.nombre,
            cantidad_tickets: vEmp.length,
            total_vendido: tot,
            ticket_promedio: vEmp.length > 0 ? Math.round(tot / vEmp.length) : 0,
            porcentaje_participacion: recaudacion > 0 ? Math.round((tot / recaudacion) * 100) : 0,
          };
        });

      const rubrosStats = db.rubros
        .filter((r) => r.empresa_id === empresaId)
        .map((r) => {
          let u = 0;
          let tot = 0;
          ventasActivas.forEach((v) => {
            (v.lineas_rubro || []).forEach((l) => {
              if (l.rubro_id === r.id) {
                u += Number(l.cantidad);
                tot += Number(l.subtotal);
              }
            });
          });
          return {
            rubro_id: r.id,
            rubro_nombre: r.nombre,
            color_hex: r.color_hex,
            unidades: u,
            total_vendido: tot,
            porcentaje: recaudacion > 0 ? Math.round((tot / recaudacion) * 100) : 0,
          };
        });

      const mediosStats = db.mediosPago
        .filter((m) => m.empresa_id === empresaId)
        .map((m) => {
          let tot = 0;
          let ops = 0;
          ventasActivas.forEach((v) => {
            (v.pagos || []).forEach((p) => {
              if (p.codigo_medio === m.codigo || p.medio_pago_id === m.id) {
                tot += Number(p.monto);
                ops += 1;
              }
            });
          });
          return {
            medio_id: m.id,
            codigo: m.codigo,
            medio_nombre: m.nombre,
            total_ingresado: tot,
            cantidad_operaciones: ops,
            porcentaje: recaudacion > 0 ? Math.round((tot / recaudacion) * 100) : 0,
          };
        });

      return {
        kpis: {
          recaudacion_total: recaudacion,
          cantidad_tickets: tickets,
          ticket_promedio: promedio,
          efectivo_en_cajon_actual: efCajon,
          ingresos_digitales_turnos_abiertos: digAbierto,
        },
        rendimiento_empleados: emps,
        ventas_por_rubro: rubrosStats,
        ventas_por_medio_pago: mediosStats,
        ventas_por_hora: [{ franja_horaria: `${new Date().getHours()}:00`, cantidad_tickets: tickets, total_vendido: recaudacion }],
        ventas_por_dia: [{ fecha: new Date().toISOString().slice(0, 10), dia_semana: 'Hoy', cantidad_tickets: tickets, total_vendido: recaudacion }],
        historial_arqueos: db.turnos.filter((t) => t.empresa_id === empresaId),
      };
    }

    return {};
  };
})();
