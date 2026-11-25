-- ============================================================================
-- CORE BLUEPRINT + CAJA Y ARQUEO: ESQUEMA MODULAR MULTI-TENANT (POSTGRESQL 17+)
-- Convenciones:
--   1. Tablas en snake_case plural; columnas en snake_case singular.
--   2. PKs en UUID / VARCHAR(64) compatibles con UUIDv7 RFC 9562.
--   3. Aislamiento Multi-Tenant estricto por columna discriminadora `empresa_id`.
--   4. Timestamps en TIMESTAMPTZ (`creado_en`, `actualizado_en`).
--   5. Importes monetarios en NUMERIC(14, 2) (prohibido FLOAT/REAL para dinero).
--   6. Regla de Dominio Caja y Arqueo: Sin control de stock ni productos individuales.
-- ============================================================================

-- 0. CONTROL DE MIGRACIONES
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    checksum VARCHAR(64) NOT NULL,
    aplicado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. MÓDULO TENANCY: EMPRESAS / INQUILINOS
CREATE TABLE IF NOT EXISTS empresas (
    id VARCHAR(64) PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    slug VARCHAR(100) UNIQUE,
    identificador_fiscal VARCHAR(30),
    telefono VARCHAR(50),
    email VARCHAR(255),
    direccion VARCHAR(255),
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. MÓDULO AUTH & RBAC: USUARIOS Y ACCESOS DE SOPORTE
-- Nota: `empresa_id` es NULL únicamente para usuarios globales con rol 'SOPORTE'.
CREATE TABLE IF NOT EXISTS usuarios (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) REFERENCES empresas(id) ON DELETE RESTRICT,
    nombre VARCHAR(120) NOT NULL,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) UNIQUE,
    telefono VARCHAR(50),
    dni_cuit VARCHAR(30),
    direccion VARCHAR(255),
    password_hash VARCHAR(255) NOT NULL DEFAULT '',
    pin_hash VARCHAR(255) NOT NULL DEFAULT '',
    rol VARCHAR(40) NOT NULL DEFAULT 'CAJERO' CHECK (rol IN ('SOPORTE', 'DUENO', 'SUPERVISOR', 'CAJERO', 'OPERADOR', 'CLIENTE')),
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS soporte_accesos_log (
    id VARCHAR(64) PRIMARY KEY,
    soporte_user_id VARCHAR(64) NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    accion VARCHAR(20) NOT NULL CHECK (accion IN ('INGRESO', 'SALIDA')),
    ip_origen VARCHAR(64),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. MÓDULO AUDITORÍA INMUTABLE (APPEND-ONLY)
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) REFERENCES empresas(id) ON DELETE RESTRICT,
    usuario_id VARCHAR(64) NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    rol_usuario VARCHAR(40) NOT NULL,
    terminal VARCHAR(60) NOT NULL DEFAULT 'POS-01',
    modulo VARCHAR(60) NOT NULL DEFAULT 'CORE',
    accion VARCHAR(80) NOT NULL,
    entidad_afectada VARCHAR(80),
    entidad_id VARCHAR(100),
    detalle_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'VIOLACION_SEGURIDAD_RNF04: Los registros de auditoria son inalterables y no permiten %.', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- 4. MÓDULO STORAGE & BACKUPS: ARCHIVOS Y RESPALDOS
CREATE TABLE IF NOT EXISTS archivos_storage (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    subido_por_id VARCHAR(64) REFERENCES usuarios(id) ON DELETE SET NULL,
    modulo VARCHAR(60) NOT NULL,
    entidad_id VARCHAR(100) NOT NULL,
    proveedor VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (proveedor IN ('local', 'supabase', 's3')),
    bucket VARCHAR(100) NOT NULL DEFAULT 'uploads',
    ruta_objeto VARCHAR(500) NOT NULL,
    url_publica VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NOT NULL DEFAULT 'application/octet-stream',
    tamano_bytes BIGINT NOT NULL DEFAULT 0 CHECK (tamano_bytes >= 0),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS respaldos_sistema (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) REFERENCES empresas(id) ON DELETE SET NULL,
    tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('HOT_BACKUP_DB', 'STORAGE_ZIP', 'JSON_SNAPSHOT')),
    archivo VARCHAR(500) NOT NULL,
    proveedor_destino VARCHAR(40) NOT NULL DEFAULT 'local',
    tamano_bytes BIGINT NOT NULL DEFAULT 0,
    checksum_sha256 VARCHAR(64),
    creado_por_id VARCHAR(64) REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 5. TABLAS DE DOMINIO: CAJA Y ARQUEO (SIN STOCK, POR RUBROS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rubros (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    nombre VARCHAR(120) NOT NULL,
    color_hex VARCHAR(20) NOT NULL DEFAULT '#2563EB',
    icono VARCHAR(60) NOT NULL DEFAULT 'shopping-basket',
    orden INTEGER NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(empresa_id, nombre)
);

CREATE TABLE IF NOT EXISTS medios_pago (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    codigo VARCHAR(40) NOT NULL CHECK (codigo IN ('EFECTIVO', 'DEBITO', 'CREDITO', 'QR_TRANSFERENCIA', 'CUENTA_CORRIENTE')),
    nombre VARCHAR(120) NOT NULL,
    requiere_vuelto BOOLEAN NOT NULL DEFAULT FALSE,
    requiere_cliente BOOLEAN NOT NULL DEFAULT FALSE,
    es_efectivo_fisico BOOLEAN NOT NULL DEFAULT FALSE,
    orden INTEGER NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(empresa_id, codigo)
);

CREATE TABLE IF NOT EXISTS clientes_fiado (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    nombre VARCHAR(150) NOT NULL,
    documento_telefono VARCHAR(80),
    limite_credito NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (limite_credito >= 0),
    saldo_deudor NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (saldo_deudor >= 0),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS turnos_caja (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    puesto_caja VARCHAR(60) NOT NULL DEFAULT 'CAJA-01',
    nombre_turno VARCHAR(30) NOT NULL CHECK (nombre_turno IN ('MANANA', 'TARDE', 'NOCHE', 'UNICO')),
    cajero_apertura_id VARCHAR(64) NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    cajero_cierre_id VARCHAR(64) REFERENCES usuarios(id) ON DELETE RESTRICT,
    fondo_inicial NUMERIC(14, 2) NOT NULL CHECK (fondo_inicial >= 0),
    estado VARCHAR(30) NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'EN_ARQUEO', 'CERRADO')),
    abierto_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cerrado_en TIMESTAMPTZ,
    declarado_efectivo NUMERIC(14, 2),
    declarado_debito NUMERIC(14, 2),
    declarado_credito NUMERIC(14, 2),
    declarado_qr NUMERIC(14, 2),
    declarado_cuenta_corriente NUMERIC(14, 2),
    esperado_efectivo NUMERIC(14, 2),
    esperado_digital_total NUMERIC(14, 2),
    diferencia_efectivo NUMERIC(14, 2),
    diferencia_total NUMERIC(14, 2),
    estado_cuadre VARCHAR(30) CHECK (estado_cuadre IN ('EXACTO', 'SOBRANTE', 'FALTANTE')),
    observaciones_cierre TEXT
);

CREATE TABLE IF NOT EXISTS movimientos_caja (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    turno_id VARCHAR(64) NOT NULL REFERENCES turnos_caja(id) ON DELETE RESTRICT,
    usuario_id VARCHAR(64) NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    autorizado_por_id VARCHAR(64) REFERENCES usuarios(id) ON DELETE RESTRICT,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('ENTRADA', 'SALIDA')),
    categoria VARCHAR(40) NOT NULL CHECK (categoria IN ('PROVEEDOR', 'INSUMOS_MENORES', 'RETIRO_SEGURIDAD', 'AJUSTE_CAMBIO', 'OTRO')),
    monto NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
    motivo TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ventas (
    id VARCHAR(64) PRIMARY KEY,
    empresa_id VARCHAR(64) NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
    numero_ticket INTEGER,
    turno_id VARCHAR(64) NOT NULL REFERENCES turnos_caja(id) ON DELETE RESTRICT,
    cajero_id VARCHAR(64) NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
    cliente_fiado_id VARCHAR(64) REFERENCES clientes_fiado(id) ON DELETE RESTRICT,
    cantidad_total_articulos INTEGER NOT NULL CHECK (cantidad_total_articulos > 0),
    monto_total NUMERIC(14, 2) NOT NULL CHECK (monto_total > 0),
    es_pago_combinado BOOLEAN NOT NULL DEFAULT FALSE,
    efectivo_recibido NUMERIC(14, 2),
    vuelto_entregado NUMERIC(14, 2) DEFAULT 0 CHECK (vuelto_entregado >= 0),
    estado VARCHAR(30) NOT NULL DEFAULT 'COMPLETADA' CHECK (estado IN ('COMPLETADA', 'ANULADA')),
    anulada_por_id VARCHAR(64) REFERENCES usuarios(id) ON DELETE RESTRICT,
    motivo_anulacion TEXT,
    creado_offline BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_venta TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lineas_venta_rubro (
    id VARCHAR(64) PRIMARY KEY,
    venta_id VARCHAR(64) NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    rubro_id VARCHAR(64) NOT NULL REFERENCES rubros(id) ON DELETE RESTRICT,
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    subtotal NUMERIC(14, 2) NOT NULL CHECK (subtotal > 0)
);

CREATE TABLE IF NOT EXISTS pagos_venta (
    id VARCHAR(64) PRIMARY KEY,
    venta_id VARCHAR(64) NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    medio_pago_id VARCHAR(64) NOT NULL REFERENCES medios_pago(id) ON DELETE RESTRICT,
    monto NUMERIC(14, 2) NOT NULL CHECK (monto > 0)
);

-- ÍNDICES COMPUESTOS MULTI-TENANT
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa_rol ON usuarios(empresa_id, rol, activo);
CREATE INDEX IF NOT EXISTS idx_soporte_log_user_empresa ON soporte_accesos_log(soporte_user_id, empresa_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_audit_empresa_fecha ON audit_logs(empresa_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_audit_empresa_accion ON audit_logs(empresa_id, modulo, accion);
CREATE INDEX IF NOT EXISTS idx_archivos_empresa_entidad ON archivos_storage(empresa_id, modulo, entidad_id);
CREATE INDEX IF NOT EXISTS idx_rubros_empresa ON rubros(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_medios_empresa ON medios_pago(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes_fiado(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_ventas_empresa_turno ON ventas(empresa_id, turno_id, estado);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha_estado ON ventas(empresa_id, fecha_venta, estado);
CREATE INDEX IF NOT EXISTS idx_turnos_puesto_estado ON turnos_caja(empresa_id, puesto_caja, estado);
