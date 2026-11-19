# Registro de Evolución — Etapa 6: Arquitectura Multi-Tenant (Perfiles de Empresa) y Rol Global Soporte

Este documento detalla la adaptación e integración de la arquitectura Multi-Tenant por columna discriminadora (`empresa_id`) y el rol global **Soporte** con modo mantenimiento en el proyecto **Caja y Arqueo**.

---

## 1. Modelo de Datos Multi-Tenant (`schema.sql` y `database.js`)
- **Tabla `empresas`:** Almacena cada comercio/minimercado de forma aislada (`id`, `nombre`, `identificador_fiscal`, `telefono`, `email`, `direccion`, `activo`, `creado_en`, `actualizado_en`).
- **Tabla `usuarios` extendida:** Soporta `empresa_id` (`NULL` para usuarios `SOPORTE` fuera de contexto) y los roles `SOPORTE`, `DUENO`, `SUPERVISOR` y `CAJERO` (mapeando `EMPLEADO` a `CAJERO` para compatibilidad transversal).
- **Tabla `soporte_accesos_log`:** Registra cada evento de inmersión contextual (`INGRESO` y `SALIDA`) del personal de Soporte en una empresa con `soporte_user_id`, `empresa_id`, `ip_origen` y `creado_en`.
- **Aislamiento de Tablas de Dominio:** Todas las tablas operativas y de catálogos (`rubros`, `medios_pago`, `clientes_fiado`, `turnos_caja`, `movimientos_caja`, `ventas`, `audit_logs`) incorporan `empresa_id` indexado y restricciones compuestas `UNIQUE(empresa_id, nombre)` y `UNIQUE(empresa_id, codigo)`.

---

## 2. Flujos de Negocio, Seguridad y RBAC (`rbac.js` y `multitenant.service.js`)
- **Seed Configurable de Soporte (`.env`):** En el arranque (`seedInitialSoporte`), se lee `INITIAL_SOPORTE_EMAIL` y `INITIAL_SOPORTE_PASSWORD` desde variables de entorno para crear el usuario inicial `SOPORTE` sin credenciales fijas en el código fuente.
- **Alta Autónoma de Empresa (`POST /api/auth/register-empresa`):** Crea en una única transacción atómica la empresa, su primer usuario `DUENO` y siembra sus catálogos base (7 rubros iniciales y los 5 medios de pago), emitiendo `access_token` y `refresh_token` con el claim `empresa_id`.
- **Aislamiento Backend-First (`getCurrentUser`):**
  - Bloquea con `HTTP 403` cualquier invocación a endpoints operativos de caja, turnos, ventas o analítica cuando un usuario `SOPORTE` no ha ingresado a una empresa (`empresa_id == NULL`).
  - Rechaza con `HTTP 403` cualquier intento de un `DUENO` de crear o promover un usuario al rol `SOPORTE`.
  - Filtra todas las lecturas, escrituras y modificaciones por `empresa_id = actor.empresa_id`, devolviendo `HTTP 404` ante intentos de acceso cruzado entre empresas.
- **Inmersión Contextual (`POST /api/auth/empresas/:id/ingresar` y `POST /api/auth/empresas/salir`):** Permite al usuario `SOPORTE` ingresar en modo mantenimiento a cualquier empresa (adoptando los permisos operativos de `DUENO` de esa empresa), auditando la entrada y la salida en `soporte_accesos_log`.

---

## 3. Consola Frontend de Soporte y Barra Lateral Adaptable (`index.html` y `app.js`)
- **Registro de Empresa Simplificado desde Login:** Formulario integrado en la pantalla de acceso para dar de alta un nuevo comercio y su primer Dueño en un paso, prescindiendo de los campos de CUIT y Dirección Física e incorporando la indicación explícita de `* Campo obligatorio`.
- **Estado 1 (`SOPORTE` fuera de empresa):** Oculta las vistas operativas de caja y presenta la **Consola de Soporte** con barra lateral dedicada:
  1. *Empresas:* Buscador instantáneo por nombre y tarjetas interactivas con botón **🔧 Ingresar / Mantenimiento**.
  2. *Cambio de Contraseña:* Actualización de clave con conmutador mostrar/ocultar.
  3. *Usuarios Soporte:* Alta, listado y baja de cuentas `SOPORTE` con protección contra auto-eliminación (`HTTP 400`).
- **Estado 2 (`SOPORTE` dentro de empresa):** Al ingresar a una empresa, la barra lateral muestra el indicador `🏢 {empresa_nombre}`, habilita todos los módulos de la empresa (igual que el `DUENO`) e incorpora en el pie el botón **← Salir de la empresa** para retornar a la consola global.

---

## 4. Modularización de Secciones Administrativas, Permisos de Entrada y Transiciones Suaves (`300 ms`)
- **Secciones Independientes en Barra Lateral (`#sidebar-company-nav`):** Se desacoplaron del tablero de *Métricas* tres vistas dedicadas para `DUENO` y `SOPORTE` en mantenimiento:
  1. **Catálogo (`#view-catalogo`):** Alta, listado y baja de Rubros/Familias, más alta y estado de crédito de Clientes de Cuenta Corriente.
  2. **Personal (`#view-personal`):** Formulario de registro y listado del personal activo del comercio (`Cajero`, `Supervisor`, `Dueño`).
  3. **Auditoría (`#view-auditoria`):** Consulta del historial inalterable con filtro dinámico por tipo de acción (`APERTURA_CAJA`, `CIERRE_ARQUEO_CIEGO`, `ENTRADA_DINERO`, `SALIDA_DINERO`, `APERTURA_CAJON_SIN_VENTA`, `ANULACION_TICKET`, `MODIFICACION_CATALOGO`) y tabla de últimos tickets con anulación auditada.
- **Habilitación de Entradas de Efectivo para Cajeros:** Se habilitó en `frontend/app.js` y `backend/src/services/turnos.service.js` que el rol `CAJERO` también pueda registrar **Entradas de Efectivo** en el flujo de *Entrada / Salida*, manteniendo en el paso siguiente la selección de Supervisores y Dueños como responsables de la entrega.
- **Skill `transiciones-suaves-ui` a `300 ms`:** Se creó la skill de workspace `.agents/skills/transiciones-suaves-ui/SKILL.md` y se aplicaron transiciones de `300 ms` (`cubic-bezier(0.22, 1, 0.36, 1)`) en cambios de vista, pasos de los wizards, deslizamiento físico de la barra lateral (`translateX`), micro-interacciones de botones, foco de inputs y notificaciones flotantes.
