# Etapa 7: Adaptación al Core Blueprint Modular y Multi-Tenant

**Fecha:** 2026-11-25  
**Especificación aplicada:** `Proyectos/Modular/PROMPT_ADAPTACION_ARQUITECTURA_MODULAR.md`

---

## 1. Capa de Datos Dual (`DB/`)
- **Esquemas SQLite WAL y PostgreSQL 17+ (`DB/schema.sqlite.sql`, `DB/schema.postgres.sql`, `backend/src/db/schema.sql`):**
  - Se incorporaron las **7 Tablas Transversales** del Core Blueprint: `schema_migrations`, `empresas`, `usuarios`, `soporte_accesos_log`, `audit_logs` (con triggers de inmutabilidad `RNF-04`), `archivos_storage` y `respaldos_sistema`.
  - Se integraron las tablas de dominio de **Caja y Arqueo (Sin Stock)**: `rubros`, `medios_pago`, `clientes_fiado`, `turnos_caja`, `movimientos_caja`, `ventas`, `lineas_venta_rubro` y `pagos_venta` con restricciones compuestas `UNIQUE(empresa_id, ...)` e importes en `NUMERIC(14, 2)` en PostgreSQL.
- **Migraciones y Backup 3-2-1:**
  - `DB/migrations/001_core_foundation.sql` ejecutada por `runMigrations(db)` con verificación SHA-256 en `schema_migrations`.
  - `DB/scripts/backup-3-2-1.sh` para volcado automatizado de `db_caja_arqueo` y sincronización externa vía `rclone`.

---

## 2. Backend Modular (`backend/src/core/` y `backend/src/modules/`)
- **Núcleo (`backend/src/core/`):**
  - `config.js`, `crypto.js` (scrypt + JWT HS256 con `access_token` y `refresh_token`), `database.js` (`runMigrations` + `runHotBackup` con `VACUUM INTO` y checksum SHA-256), `errors.js`, `logger.js`, `uuidv7.js` (RFC 9562) y `module-registry.js` (`ModuleRegistry`).
- **4 Módulos Transversales (`backend/src/modules/`):**
  - `tenancy/tenancy.module.js` (`/api/v1/empresas`): Registro atómico de empresa + primer `DUENO` + siembra de catálogos base (`rubros` y 5 `medios_pago`), listado de empresas e inmersión contextual (`/:id/ingresar` y `/salir`) con registro en `soporte_accesos_log`.
  - `auth/auth.module.js` (`/api/v1/auth`): Login, refresh token, cambio de contraseña, CRUD de usuarios de empresa y CRUD exclusivo de usuarios `SOPORTE` con protección contra auto-eliminación y escalada de privilegios.
  - `audit/audit.module.js` (`/api/v1/auditoria`): Helper `recordAudit` y consulta filtrada por `empresa_id`, `modulo` y `accion`.
  - `storage/storage.module.js` (`/api/v1/sistema`): Estado de cuota (`/storage/status`), exportación/restauración/vaciado de manifiesto (`/storage/backup`, `/storage/restore`, `/storage/clear`) y ejecución de Hot Backup SQLite (`/backups/ejecutar`).
- **Módulo de Dominio Enchufable (`backend/src/modules/caja-arqueo/caja-arqueo.module.js`):**
  - Registrado en `backend/src/app.js` bajo `/api/v1/caja-arqueo` y montado en `backend/src/server.js` preservando compatibilidad total con las rutas existentes (`/api/*` y `/auth/*`).

---

## 3. Frontend Modular, Preservación Visual y 3 Targets
- **Preservación Estricta de Identidad Visual (`frontend/styles/` y `frontend/styles.css`):**
  - Se conservaron íntegramente la paleta **Cappuccino y Caramelo** (`--bg: #eee6dd`, `--surface: #f8f3ed`, `--primary-top: #a86b43`, `--confirm-top: #588157`), los encabezados **Cinta Almendra**, los botones táctiles biselados de `3px` y las transiciones fluidas a `500ms` (`transiciones-suaves-ui`), estructurando además los 4 archivos base (`variables.css`, `reset.css`, `components.css`, `utilities.css`).
- **Núcleo Cliente y Consola `SOPORTE` (`frontend/core/`, `frontend/index.html`, `frontend/app.js`):**
  - Se añadieron `frontend/core/{api.js,authStore.js,moduleRegistry.js}` y la 4.ª pestaña **`💾 Almacenamiento y Backup`** en la consola global de `SOPORTE`.
  - Se agregó `capacitor.config.json` y los scripts `android:apk` / `android:aab` en `package.json`.
