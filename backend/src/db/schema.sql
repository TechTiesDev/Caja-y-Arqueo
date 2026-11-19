-- ============================================================================
-- ESQUEMA DE BASE DE DATOS MULTI-TENANT: SISTEMA DE CAJA, ARQUEO Y ROL SOPORTE
-- Regla Estructural: SIN CONTROL DE STOCK NI PRODUCTOS INDIVIDUALES
-- Aislamiento por columna discriminadora `empresa_id` + Rol Global SOPORTE
-- ============================================================================

PRAGMA foreign_keys = ON;

-- 0. EMPRESAS / INQUILINOS (Multi-Tenant)
CREATE TABLE IF NOT EXISTS empresas (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    identificador_fiscal TEXT,
    telefono TEXT,
    email TEXT,
    direccion TEXT,
    activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 1. USUARIOS Y ROLES (SOPORTE global con empresa_id NULL, DUENO, SUPERVISOR, CAJERO)
CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    empresa_id TEXT REFERENCES empresas(id),
    nombre TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    telefono TEXT,
    pin_hash TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('SOPORTE', 'DUENO', 'SUPERVISOR', 'CAJERO')),
    activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 1B. AUDITORÍA DE ACCESOS DE SOPORTE A EMPRESAS (Inmersión Contextual)
CREATE TABLE IF NOT EXISTS soporte_accesos_log (
    id TEXT PRIMARY KEY,
    soporte_user_id TEXT NOT NULL REFERENCES usuarios(id),
    empresa_id TEXT NOT NULL REFERENCES empresas(id),
    accion TEXT NOT NULL CHECK (accion IN ('INGRESO', 'SALIDA')),
    ip_origen TEXT,
    creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. RUBROS / FAMILIAS DE PRODUCTOS (Aislados por empresa_id con UNIQUE compuesto)
CREATE TABLE IF NOT EXISTS rubros (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL DEFAULT 'emp-default-01' REFERENCES empresas(id),
    nombre TEXT NOT NULL,
    color_hex TEXT NOT NULL DEFAULT '#2563EB',
    icono TEXT NOT NULL DEFAULT 'shopping-basket',
    orden INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(empresa_id, nombre)
);

-- 3. MEDIOS DE PAGO (Aislados por empresa_id con UNIQUE compuesto)
CREATE TABLE IF NOT EXISTS medios_pago (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL DEFAULT 'emp-default-01' REFERENCES empresas(id),
    codigo TEXT NOT NULL CHECK (codigo IN ('EFECTIVO', 'DEBITO', 'CREDITO', 'QR_TRANSFERENCIA', 'CUENTA_CORRIENTE')),
    nombre TEXT NOT NULL,
    requiere_vuelto INTEGER NOT NULL DEFAULT 0 CHECK (requiere_vuelto IN (0, 1)),
    requiere_cliente INTEGER NOT NULL DEFAULT 0 CHECK (requiere_cliente IN (0, 1)),
    es_efectivo_fisico INTEGER NOT NULL DEFAULT 0 CHECK (es_efectivo_fisico IN (0, 1)),
    orden INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    UNIQUE(empresa_id, codigo)
);

-- 4. CLIENTES DE CUENTA CORRIENTE / FIADO (Aislados por empresa_id)
CREATE TABLE IF NOT EXISTS clientes_fiado (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL DEFAULT 'emp-default-01' REFERENCES empresas(id),
    nombre TEXT NOT NULL,
    documento_telefono TEXT,
    limite_credito REAL NOT NULL DEFAULT 0 CHECK (limite_credito >= 0),
    saldo_deudor REAL NOT NULL DEFAULT 0 CHECK (saldo_deudor >= 0),
    activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 5. TURNOS Y APERTURA/CIERRE DE CAJA (Aislados por empresa_id)
CREATE TABLE IF NOT EXISTS turnos_caja (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL DEFAULT 'emp-default-01' REFERENCES empresas(id),
    puesto_caja TEXT NOT NULL DEFAULT 'CAJA-01',
    nombre_turno TEXT NOT NULL CHECK (nombre_turno IN ('MANANA', 'TARDE', 'NOCHE', 'UNICO')),
    cajero_apertura_id TEXT NOT NULL REFERENCES usuarios(id),
    cajero_cierre_id TEXT REFERENCES usuarios(id),
    fondo_inicial REAL NOT NULL CHECK (fondo_inicial >= 0),
    estado TEXT NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'EN_ARQUEO', 'CERRADO')),
    abierto_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cerrado_en TEXT,
    declarado_efectivo REAL,
    declarado_debito REAL,
    declarado_credito REAL,
    declarado_qr REAL,
    declarado_cuenta_corriente REAL,
    esperado_efectivo REAL,
    esperado_digital_total REAL,
    diferencia_efectivo REAL,
    diferencia_total REAL,
    estado_cuadre TEXT CHECK (estado_cuadre IN ('EXACTO', 'SOBRANTE', 'FALTANTE')),
    observaciones_cierre TEXT
);

-- 6. ENTRADAS Y SALIDAS DE DINERO EN CAJA (Aislados por empresa_id)
CREATE TABLE IF NOT EXISTS movimientos_caja (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL DEFAULT 'emp-default-01' REFERENCES empresas(id),
    turno_id TEXT NOT NULL REFERENCES turnos_caja(id),
    usuario_id TEXT NOT NULL REFERENCES usuarios(id),
    autorizado_por_id TEXT REFERENCES usuarios(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA', 'SALIDA')),
    categoria TEXT NOT NULL CHECK (categoria IN ('PROVEEDOR', 'INSUMOS_MENORES', 'RETIRO_SEGURIDAD', 'AJUSTE_CAMBIO', 'OTRO')),
    monto REAL NOT NULL CHECK (monto > 0),
    motivo TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 7. VENTAS / TICKETS (Aislados por empresa_id)
CREATE TABLE IF NOT EXISTS ventas (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL DEFAULT 'emp-default-01' REFERENCES empresas(id),
    numero_ticket INTEGER,
    turno_id TEXT NOT NULL REFERENCES turnos_caja(id),
    cajero_id TEXT NOT NULL REFERENCES usuarios(id),
    cliente_fiado_id TEXT REFERENCES clientes_fiado(id),
    cantidad_total_articulos INTEGER NOT NULL CHECK (cantidad_total_articulos > 0),
    monto_total REAL NOT NULL CHECK (monto_total > 0),
    es_pago_combinado INTEGER NOT NULL DEFAULT 0 CHECK (es_pago_combinado IN (0, 1)),
    efectivo_recibido REAL,
    vuelto_entregado REAL DEFAULT 0 CHECK (vuelto_entregado >= 0),
    estado TEXT NOT NULL DEFAULT 'COMPLETADA' CHECK (estado IN ('COMPLETADA', 'ANULADA')),
    anulada_por_id TEXT REFERENCES usuarios(id),
    motivo_anulacion TEXT,
    creado_offline INTEGER NOT NULL DEFAULT 0 CHECK (creado_offline IN (0, 1)),
    fecha_venta TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sincronizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 8. LÍNEAS DE VENTA POR RUBRO
CREATE TABLE IF NOT EXISTS lineas_venta_rubro (
    id TEXT PRIMARY KEY,
    venta_id TEXT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    rubro_id TEXT NOT NULL REFERENCES rubros(id),
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    subtotal REAL NOT NULL CHECK (subtotal > 0)
);

-- 9. DESGLOSE DE PAGOS POR VENTA
CREATE TABLE IF NOT EXISTS pagos_venta (
    id TEXT PRIMARY KEY,
    venta_id TEXT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    medio_pago_id TEXT NOT NULL REFERENCES medios_pago(id),
    monto REAL NOT NULL CHECK (monto > 0)
);

-- 10. HISTORIAL DE AUDITORÍA INALTERABLE / ANTIRROBO (Append-Only estricto con empresa_id)
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    empresa_id TEXT DEFAULT 'emp-default-01' REFERENCES empresas(id),
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    usuario_id TEXT NOT NULL REFERENCES usuarios(id),
    rol_usuario TEXT NOT NULL,
    terminal TEXT NOT NULL DEFAULT 'POS-01',
    accion TEXT NOT NULL CHECK (accion IN (
        'APERTURA_CAJA',
        'CIERRE_ARQUEO_CIEGO',
        'ENTRADA_DINERO',
        'SALIDA_DINERO',
        'APERTURA_CAJON_SIN_VENTA',
        'ANULACION_TICKET',
        'ANULACION_LINEA_RUBRO',
        'MODIFICACION_CATALOGO',
        'EXCESO_LIMITE_FIADO_OFFLINE'
    )),
    entidad_afectada TEXT,
    entidad_id TEXT,
    detalle_json TEXT NOT NULL
);

-- ============================================================================
-- TRIGGERS DE INMUTABILIDAD PARA AUDIT_LOGS (Prohibido UPDATE o DELETE)
-- ============================================================================
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'VIOLACION_SEGURIDAD_RNF04: Los registros de auditoria son inalterables y no pueden modificarse.');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'VIOLACION_SEGURIDAD_RNF04: Los registros de auditoria son inalterables y no pueden eliminarse.');
END;

-- ============================================================================
-- ÍNDICES MULTI-TENANT Y DE RENDIMIENTO
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa ON usuarios(empresa_id, rol);
CREATE INDEX IF NOT EXISTS idx_soporte_log_user ON soporte_accesos_log(soporte_user_id, empresa_id);
CREATE INDEX IF NOT EXISTS idx_rubros_empresa ON rubros(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_medios_empresa ON medios_pago(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes_fiado(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_ventas_empresa_turno ON ventas(empresa_id, turno_id, estado);
CREATE INDEX IF NOT EXISTS idx_ventas_turno_estado ON ventas(turno_id, estado);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha_estado ON ventas(empresa_id, fecha_venta, estado);
CREATE INDEX IF NOT EXISTS idx_ventas_cajero_fecha ON ventas(empresa_id, cajero_id, fecha_venta, estado);
CREATE INDEX IF NOT EXISTS idx_lineas_rubro_venta ON lineas_venta_rubro(rubro_id, venta_id);
CREATE INDEX IF NOT EXISTS idx_pagos_medio_venta ON pagos_venta(medio_pago_id, venta_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_turno_tipo ON movimientos_caja(empresa_id, turno_id, tipo);
CREATE INDEX IF NOT EXISTS idx_turnos_puesto_estado ON turnos_caja(empresa_id, puesto_caja, estado);
