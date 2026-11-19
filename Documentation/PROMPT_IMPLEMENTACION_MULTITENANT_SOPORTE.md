# Prompt de Implementación: Arquitectura Multi-Tenant (Perfiles de Empresa) y Rol Soporte

Implementá un sistema **Multi-Tenant por columna discriminadora (`empresa_id`)** con gestión autónoma de empresas, aislamiento estricto de datos/configuraciones por inquilino y un rol global **Soporte** con capacidad de inmersión contextual (modo mantenimiento) en cualquier empresa.

---

## 1. Contexto y Objetivo

- **Objetivo:** Transformar o construir la aplicación bajo un esquema multi-empresa donde cada organización opera en un entorno lógico completamente aislado, administrado por uno o más usuarios con rol `DUENO` y operado por usuarios `EMPLEADO` (ej. `MECANICO` u operador de dominio).
- **Rol Global (`SOPORTE`):** Usuario de nivel plataforma sin empresa fija (`empresa_id = NULL` por defecto) que administra cuentas de soporte, visualiza todas las empresas registradas y puede ingresar temporalmente al contexto de cualquier empresa para tareas de mantenimiento o asistencia, adoptando la vista y permisos operativos del `DUENO` de esa empresa.
- **Adaptación de Stack:**
  - **Base de datos relacional (PostgreSQL / MySQL / SQLite):** Usar claves foráneas, índices por `empresa_id` y restricciones `UNIQUE` compuestas `(empresa_id, clave_negocio)`.
  - **Base de datos documental (MongoDB / Firestore):** Incluir `empresa_id` indexado en cada colección de dominio y validar en el middleware de acceso.
  - **Autenticación con JWT (Stateless) o Sesiones (Stateful):** Incluir `sub` (ID usuario), `rol` y `empresa_id` (contexto activo) en el payload del token o estado de sesión.

---

## 2. Modelo de Datos

Implementá o adaptá las siguientes entidades principales y aplicá la llave foránea `empresa_id` en todas las tablas operativas y de configuración del dominio:

### 2.1. Tabla `empresas`
| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` / `BIGINT` | `PK`, `NOT NULL` | Identificador único de la empresa. |
| `nombre` | `VARCHAR(150)` | `NOT NULL` | Nombre comercial o razón social. |
| `identificador_fiscal` | `VARCHAR(50)` | `NULL` | CUIT, RUT, NIT o Tax ID. |
| `telefono` | `VARCHAR(50)` | `NULL` | Teléfono de contacto de la empresa. |
| `email` | `VARCHAR(255)` | `NULL` | Correo institucional de la empresa. |
| `direccion` | `VARCHAR(255)` | `NULL` | Domicilio físico. |
| `activo` | `BOOLEAN` | `NOT NULL`, `DEFAULT TRUE` | Estado operativo del inquilino. |
| `creado_en` | `TIMESTAMP` | `NOT NULL`, `DEFAULT NOW()` | Fecha de alta. |
| `actualizado_en` | `TIMESTAMP` | `NOT NULL`, `DEFAULT NOW()` | Fecha de última modificación. |

### 2.2. Tabla `usuarios`
| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` / `BIGINT` | `PK`, `NOT NULL` | Identificador único del usuario. |
| `empresa_id` | `UUID` / `BIGINT` | `FK -> empresas.id`, `NULL`, `INDEX` | Empresa asociada (`NULL` para `SOPORTE` fuera de contexto). |
| `nombre` | `VARCHAR(100)` | `NOT NULL` | Nombre completo. |
| `email` | `VARCHAR(255)` | `UNIQUE`, `INDEX`, `NOT NULL` | Credencial de acceso (normalizado a minúsculas). |
| `telefono` | `VARCHAR(30)` | `NULL` | Teléfono de contacto. |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` | Hash criptográfico de la contraseña. |
| `rol` | `ENUM` / `VARCHAR(20)` | `NOT NULL` | Valores: `SOPORTE`, `DUENO`, `EMPLEADO` (o rol operativo equivalente). |
| `activo` | `BOOLEAN` | `NOT NULL`, `DEFAULT TRUE` | Habilitación de inicio de sesión (`FALSE` para registros pendientes de aprobación). |
| `creado_en` | `TIMESTAMP` | `NOT NULL`, `DEFAULT NOW()` | Fecha de alta. |
| `actualizado_en` | `TIMESTAMP` | `NOT NULL`, `DEFAULT NOW()` | Fecha de última modificación. |

### 2.3. Tabla `soporte_accesos_log` (Auditoría de Soporte)
| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` / `BIGINT` | `PK`, `NOT NULL` | Identificador del evento. |
| `soporte_user_id` | `UUID` / `BIGINT` | `FK -> usuarios.id`, `NOT NULL`, `INDEX` | Usuario `SOPORTE` que ejecutó la acción. |
| `empresa_id` | `UUID` / `BIGINT` | `FK -> empresas.id`, `NOT NULL`, `INDEX` | Empresa accedida. |
| `accion` | `VARCHAR(20)` | `NOT NULL` | `INGRESO` o `SALIDA`. |
| `ip_origen` | `VARCHAR(45)` | `NULL` | Dirección IP de la solicitud. |
| `creado_en` | `TIMESTAMP` | `NOT NULL`, `DEFAULT NOW()` | Timestamp exacto del evento. |

### 2.4. Tablas de Dominio y Configuración (`<entidad_dominio>`)
- Agregá `empresa_id` (`FK -> empresas.id`, `NOT NULL`, `INDEX`) en **todas** las tablas de negocio y de parámetros/catálogos.
- Reemplazá cualquier restricción `UNIQUE(codigo_o_clave)` global por una restricción compuesta `UNIQUE(empresa_id, codigo_o_clave)`.

---

## 3. Roles y Permisos (Matriz Rol x Acción)

Implementá el control de acceso basado en roles (RBAC) combinado con validación de contexto (`empresa_id`):

| Acción / Módulo | `SOPORTE` (Fuera de empresa) | `SOPORTE` (Dentro de empresa) | `DUENO` | `EMPLEADO` |
| :--- | :---: | :---: | :---: | :---: |
|Ver listado global de empresas | ✅ | ❌ (Debe salir primero) | ❌ | ❌ |
|Gestionar usuarios `SOPORTE` (CRUD) | ✅ | ❌ (Debe salir primero) | ❌ | ❌ |
|Cambiar su propia contraseña | ✅ | ✅ | ✅ | ✅ |
|Ingresar a una empresa (Modo Mantenimiento) | ✅ | 🔄 (Salir / Cambiar) | ❌ | ❌ |
|Salir de empresa a consola Soporte | ❌ | ✅ | ❌ | ❌ |
|Crear / Editar usuarios de la empresa (`DUENO` / `EMPLEADO`) | ❌ | ✅ (Solo empresa activa) | ✅ (Solo su empresa) | ❌ |
|Configurar parámetros / catálogos de la empresa | ❌ | ✅ (Solo empresa activa) | ✅ (Solo su empresa) | ❌ |
|Módulos de control, caja, inventario, métricas | ❌ | ✅ (Solo empresa activa) | ✅ (Solo su empresa) | ❌ |
|Módulos operativos diarios (tareas, recepción, agenda) | ❌ | ✅ (Solo empresa activa) | ✅ (Solo su empresa) | ✅ (Solo su empresa) |

---

## 4. Flujos de Negocio

### 4.1. Creación de Empresa y su Primer Dueño (`POST /auth/register-empresa`)
Ejecutá dentro de una **única transacción atómica**:
```text
FUNCTION register_empresa(payload):
  1. Normalizar email_dueno = LOWER(TRIM(payload.email_dueno))
  2. IF EXISTS usuario WHERE LOWER(email) == email_dueno:
       RETURN Error 409 "Email ya registrado"
  3. BEGIN TRANSACTION
  4. empresa = INSERT INTO empresas (nombre, identificador_fiscal, telefono, direccion, activo=TRUE)
  5. dueno = INSERT INTO usuarios (
       empresa_id = empresa.id,
       nombre = TRIM(payload.nombre_dueno),
       email = email_dueno,
       telefono = payload.telefono_dueno,
       password_hash = HASH(payload.password_dueno),
       rol = 'DUENO',
       activo = TRUE
     )
  6. Sembrar configuraciones iniciales y catálogos base vinculados a `empresa.id`
  7. COMMIT TRANSACTION
  8. Emitir tokens/sesión para `dueno` con `{ sub: dueno.id, rol: 'DUENO', empresa_id: empresa.id }`
  9. RETURN tokens + datos de sesión
```

### 4.2. Alta y Edición de Usuarios Internos (`POST /auth/usuarios`, `PATCH /auth/usuarios/:id`)
- **Restricción de Rol Autorizado:** Solo ejecutable por `DUENO` o `SOPORTE` con `empresa_id` activo.
- **Restricción de Roles Asignables:** Validar estrictamente en backend que `payload.rol IN ('DUENO', 'EMPLEADO')`. Rechazar con `HTTP 403` cualquier intento de asignar `SOPORTE`.
- **Asignación Forzada de Inquilino:** Ignorar cualquier `empresa_id` enviado desde el cliente y forzar siempre `usuario.empresa_id = current_user.empresa_id`.
- **Edición:** Verificar antes de actualizar que el usuario objetivo pertenezca a `current_user.empresa_id` y su rol sea `DUENO` o `EMPLEADO`; de lo contrario retornar `HTTP 404`.
- **Auto-registro opcional de Empleado (`POST /auth/register-empleado`):** Si se habilita registro público de empleados, el usuario selecciona una empresa activa, se crea con `rol = 'EMPLEADO'`, `empresa_id = seleccionada` y `activo = FALSE` hasta que el `DUENO` de esa empresa lo active.

### 4.3. Seed Inicial y Gestión de Usuarios Soporte
- **Seed en el Arranque:**
  ```text
  FUNCTION seed_initial_soporte():
    soporte_email = ENV("INITIAL_SOPORTE_EMAIL")
    soporte_password = ENV("INITIAL_SOPORTE_PASSWORD")
    IF NOT EXISTS usuario WHERE rol == 'SOPORTE':
      IF soporte_email AND soporte_password:
        INSERT INTO usuarios (
          empresa_id = NULL,
          nombre = "Soporte",
          email = LOWER(TRIM(soporte_email)),
          password_hash = HASH(soporte_password),
          rol = 'SOPORTE',
          activo = TRUE
        )
  ```
- **CRUD de Soporte (`/auth/soporte/usuarios`):**
  - Accesible exclusivamente por usuarios con `rol == 'SOPORTE'`.
  - **Listar (`GET`):** Filtra `WHERE rol == 'SOPORTE'`.
  - **Crear (`POST`):** Fuerza `rol = 'SOPORTE'`, `empresa_id = NULL`, `activo = TRUE`, validando unicidad de email.
  - **Editar (`PATCH /:id`):** Permite modificar `nombre`, `email`, `telefono`, `activo` y opcionalmente `password` (si se envía no vacío) solo sobre registros con `rol == 'SOPORTE'`.
  - **Eliminar (`DELETE /:id`):** Prohibir la auto-eliminación (`IF target_id == current_user.id RETURN Error 400 "No puedes eliminar tu propio usuario en sesión"`).

### 4.4. Inmersión Contextual del Soporte en una Empresa
- **Login de Soporte (`POST /auth/login`):** Si `user.rol == 'SOPORTE'`, limpiar siempre `user.empresa_id = NULL` en base de datos y emitir token con `empresa_id = NULL`.
- **Ingresar a Empresa (`POST /auth/empresas/:empresa_id/ingresar`):**
  1. Validar que `current_user.rol == 'SOPORTE'` y que `empresa_id` exista.
  2. Actualizar `current_user.empresa_id = empresa.id`.
  3. Registrar evento `INGRESO` en `soporte_accesos_log`.
  4. Emitir nuevos tokens con `{ sub: current_user.id, rol: 'SOPORTE', empresa_id: empresa.id }` y retornar `{ access_token, refresh_token, empresa_id, empresa_nombre }`.
- **Salir de Empresa (`POST /auth/empresas/salir`):**
  1. Validar que `current_user.rol == 'SOPORTE'`.
  2. Registrar evento `SALIDA` en `soporte_accesos_log` (si tenía `empresa_id` previo).
  3. Actualizar `current_user.empresa_id = NULL`.
  4. Emitir nuevos tokens con `{ sub: current_user.id, rol: 'SOPORTE', empresa_id: NULL }`.

---

## 5. Interfaz y Navegación del Rol Soporte

Implementá una máquina de estados de navegación en el frontend determinada por:
- `isSoporte = (user.rol === 'SOPORTE')`
- `isInCompany = !isSoporte || Boolean(user.empresa_id && activeMaintenanceCompanyId)`

### 5.1. Estado 1: Soporte Fuera de una Empresa (`isSoporte && !isInCompany`)
- **Guardia de Rutas Frontend:** Redirigir cualquier ruta operativa de negocio hacia `/soporte/empresas`.
- **Barra Lateral (Sidebar):** Mostrar únicamente la sección **Soporte** con:
  1. **Empresas (`/soporte/empresas`):** Buscador instantáneo (por nombre, ID fiscal o dirección) y grilla de tarjetas interactivas por empresa (mostrando nombre, fecha de alta, estado Activo/Inactivo, ID fiscal, teléfono, dirección y botón **"Ingresar / Mantenimiento"**).
  2. **Cambio de contraseña (`/soporte/password`):** Formulario con contraseña actual, nueva contraseña y confirmación, con toggle para mostrar/ocultar texto.
  3. **Usuarios Soporte (`/soporte/usuarios`):** Tabla de usuarios `SOPORTE` con botón **"Nuevo Usuario Soporte"**, modal de creación/edición y botón **"Eliminar"** (oculto o deshabilitado en la fila del propio usuario en sesión).

### 5.2. Estado 2: Soporte Dentro de una Empresa (`isSoporte && isInCompany`)
- **Transición al hacer clic en una tarjeta de empresa:** Llamar a `POST /auth/empresas/:id/ingresar`, actualizar el store de autenticación con los nuevos tokens, `empresa_id` y `empresa_nombre`, guardar `activeMaintenanceCompanyId = empresa.id` y redirigir a la vista principal de la empresa.
- **Barra Lateral (Sidebar):**
  - Reemplazar las opciones de Soporte por **exactamente las mismas secciones y enlaces que ve el rol `DUENO`** de esa empresa.
  - Mostrar en el encabezado de la barra lateral el nombre de la empresa activa (`🏢 {user.empresa_nombre}`).
  - Agregar en el pie de la barra lateral el botón **"← Salir de la empresa"**, que invoca `POST /auth/empresas/salir`, limpia `empresa_id` y `activeMaintenanceCompanyId` en el store y redirige a `/soporte/empresas`.

---

## 6. Reglas de Aislamiento Multi-Tenant (Backend-First)

1. **Middleware / Dependencia Global de Autenticación (`get_current_user`):**
   ```text
   FUNCTION get_current_user(request, token):
     payload = VERIFY_JWT(token)
     user = DB.find_user_by_id(payload.sub, include_empresa=True)
     IF NOT user OR NOT user.activo:
       THROW HTTP 401

     IF user.rol IN ('DUENO', 'EMPLEADO'):
       IF NOT user.empresa_id OR NOT user.empresa OR NOT user.empresa.activo:
         THROW HTTP 403 "Sin acceso activo a una empresa"
       IF payload.empresa_id != user.empresa_id:
         THROW HTTP 403 "Inconsistencia de empresa en sesión"

     ELSE IF user.rol == 'SOPORTE':
       IF payload.empresa_id IS NOT NULL:
         empresa = DB.find_empresa_by_id(payload.empresa_id)
         IF NOT empresa:
           THROW HTTP 404 "Empresa no encontrada"
         user.empresa_id = empresa.id
         user.empresa = empresa
       ELSE:
         user.empresa_id = NULL
         user.empresa = NULL

     # Bloquear acceso a cualquier endpoint de negocio si no hay empresa_id activo
     IF request.path NOT IN GLOBAL_AUTH_PATHS:
       IF user.empresa_id IS NULL:
         THROW HTTP 403 "Debe ingresar a una empresa para acceder a este módulo"

     RETURN user
   ```
   *(Donde `GLOBAL_AUTH_PATHS` incluye únicamente: `/auth/me`, `/auth/change-password`, `/auth/empresas`, `/auth/soporte/*`).*

2. **Scoping Obligatorio en Consultas y Mutaciones:**
   - **Lecturas (`SELECT`):** Toda consulta a tablas de negocio o configuración debe incluir `WHERE entidad.empresa_id = current_user.empresa_id`.
   - **Escrituras (`INSERT`):** Todo registro creado debe inyectar `empresa_id = current_user.empresa_id` desde el servidor, ignorando el body del cliente.
   - **Modificaciones y Bajas (`UPDATE` / `DELETE`):** Buscar el recurso filtrando simultáneamente por `id == resource_id AND empresa_id == current_user.empresa_id`. Si no coincide, retornar `HTTP 404` (para no revelar la existencia de IDs de otras empresas).
   - **Relaciones Cruzadas:** Al vincular dos entidades (ej. asignar un empleado o ítem a una orden), validar que ambas pertenezcan al mismo `current_user.empresa_id`.

---

## 7. Seguridad

- **Hash de Contraseñas:** Utilizar `bcrypt` (cost factor >= 12) o `Argon2id`. Nunca almacenar ni registrar contraseñas en texto plano.
- **Credenciales Configurables:** Prohibido fijar credenciales por defecto en el código fuente. Leer `INITIAL_SOPORTE_EMAIL`, `INITIAL_SOPORTE_PASSWORD` y `JWT_SECRET_KEY` desde variables de entorno.
- **Tokens:** Firmar tokens de acceso (corta duración) y de refresco (larga duración) diferenciados por el atributo `type: "access" | "refresh"`. Al cambiar de contexto de empresa en `SOPORTE`, invalidar o reemplazar el token en el cliente con el nuevo claim `empresa_id`.
- **Auditoría:** Registrar cada `INGRESO` y `SALIDA` de `SOPORTE` en `soporte_accesos_log` con `soporte_user_id`, `empresa_id`, `ip_origen` y `creado_en`.

---

## 8. Orden de Implementación, Criterios de Aceptación y Pruebas Mínimas

Ejecutá la implementación en este orden secuencial:

1. **Paso 1 — Esquema y Migración de Base de Datos:**
   - Crear tablas `empresas`, `usuarios` y `soporte_accesos_log`.
   - Agregar columna `empresa_id` + índices + claves únicas compuestas en todas las tablas del dominio.
2. **Paso 2 — Seed y Autenticación Base:**
   - Implementar hashing de contraseñas, generación/validación de JWT con claim `empresa_id` y seed del usuario `SOPORTE` inicial desde variables de entorno.
3. **Paso 3 — Middleware de Seguridad y Aislamiento:**
   - Implementar `get_current_user` y `require_roles(*roles)` con validación de `empresa_id` activo para rutas de negocio.
4. **Paso 4 — Endpoints de Empresas, Usuarios y Soporte:**
   - Implementar `POST /auth/register-empresa`, CRUD `/auth/usuarios` (restringido a `DUENO`/`EMPLEADO` de la empresa activa), CRUD `/auth/soporte/usuarios`, `POST /auth/change-password`, `POST /auth/empresas/:id/ingresar` y `POST /auth/empresas/salir`.
5. **Paso 5 — Refactorización de Servicios de Dominio:**
   - Inyectar `empresa_id = current_user.empresa_id` en todos los servicios y repositorios del sistema, incluyendo la creación de configuraciones iniciales por empresa.
6. **Paso 6 — Frontend (Auth Store, Guardias, Consola Soporte y Sidebar Dinámico):**
   - Implementar registro de empresa en login, store con `empresa_id` y `activeMaintenanceCompanyId`, vistas de Soporte (tarjetas de empresas, cambio de clave, CRUD soportes) y barra lateral adaptable con botón de salida de empresa.

### Criterios de Aceptación y Pruebas Mínimas Obligatorias
Verificá que todas las siguientes pruebas pasen antes de finalizar:

- [ ] **Test 1 (Aislamiento Cross-Tenant):** Crear `Empresa A` (`Dueño A`) y `Empresa B` (`Dueño B`). Crear un registro operativo en `Empresa A`. Intentar leerlo, editarlo o eliminarlo autenticándose como `Dueño B` -> Debe retornar `404 Not Found` o lista vacía.
- [ ] **Test 2 (Independencia de Configuraciones):** Modificar un parámetro o catálogo en `Empresa A` -> Verificar que la configuración de `Empresa B` permanezca intacta.
- [ ] **Test 3 (Escalada de Privilegios Denegada):** Intentar crear o actualizar un usuario con `rol = "SOPORTE"` desde `POST /auth/usuarios` o `PATCH /auth/usuarios/:id` autenticado como `DUENO` -> Debe retornar `403 Forbidden`.
- [ ] **Test 4 (Bloqueo de Rutas a Soporte sin Contexto):** Autenticarse como `SOPORTE` (donde `empresa_id == NULL`) e invocar directamente un endpoint de negocio -> Debe retornar `403 Forbidden`.
- [ ] **Test 5 (Ciclo de Inmersión de Soporte):** Con `SOPORTE`, llamar a `POST /auth/empresas/{id_A}/ingresar` -> Verificar que el nuevo token permita operar en `Empresa A`, que se registre `INGRESO` en `soporte_accesos_log`, que el sidebar muestre solo el menú de `Empresa A`, y que al llamar a `POST /auth/empresas/salir` el token vuelva a `empresa_id = NULL` y se registre `SALIDA`.
- [ ] **Test 6 (Protección de Auto-Eliminación de Soporte):** Intentar ejecutar `DELETE /auth/soporte/usuarios/{mi_propio_id}` -> Debe retornar `400 Bad Request`.
