# Registro de Evolución — Sistema de Conteo de Ventas y Arqueo de Caja (Etapas 1 a 5 y Refinamiento UI/UX)

Este documento registra la arquitectura implementada, las reglas de negocio financieras, las políticas de permisos por rol y las iteraciones de diseño UI/UX aplicadas en el proyecto **Caja y Arqueo**.

---

## 1. Arquitectura Base y Modelo de Datos Sin Control de Stock (Etapa 1)
- **Regla Estructural Sin Stock:** Se diseñó el esquema relacional en SQLite (`backend/src/db/schema.sql`) prescindiendo deliberadamente de tablas de artículos individuales, códigos de barras o inventario. Las ventas se registran asociando únicamente **cantidad de unidades, rubro(s)/familia(s) e importe cobrado** (`ventas`, `lineas_venta_rubro` y `pagos_venta`).
- **Concurrencia y Persistencia Local:** Se configuró `node:sqlite` en modo `PRAGMA journal_mode = WAL` y `foreign_keys = ON` (`backend/src/db/database.js`), acompañado de identificadores cronológicos `UUIDv7` (`backend/src/utils/uuidv7.js`) para evitar colisiones entre cobros realizados sin conexión.
- **Historial de Auditoría Inalterable:** La tabla `audit_logs` cuenta con triggers a nivel motor SQLite (`trg_audit_logs_no_update` y `trg_audit_logs_no_delete`) que abortan cualquier intento de modificación o borrado de eventos sensibles (aperturas, cierres, anulaciones, aperturas de cajón y excesos de límite de cuenta corriente).

---

## 2. Seguridad y Jerarquía de 3 Roles (RBAC)
- **Separación Estricta de Roles (`CAJERO`, `SUPERVISOR`, `DUENO`):**
  - **Cajero:** Opera bajo su propia sesión, registra salidas de efectivo menores, cobra únicamente a su propio nombre y realiza el arqueo ciego sin visualizar saldos esperados ni métricas.
  - **Supervisor:** Visualiza únicamente el efectivo total esperado en el cajón del turno activo (`/api/turnos/resumen-supervisor`), autoriza/registra aperturas de cajón sin venta y está habilitado para registrar **Entradas de efectivo**, teniendo bloqueado el acceso al tablero de métricas y reportes de ventas.
  - **Dueño:** Acceso total local y remoto al tablero de métricas, conciliación de faltantes y sobrantes, exportación a Excel (`.csv`) y PDF imprimible, administración de catálogos (rubros y empleados), anulación auditada de tickets y visualización del registro de auditoría.
- **Regla de Cobro por Delegación Jerárquica:** En `ventas.service.js` y en el Paso 1 del flujo de cobro (`frontend/app.js`), los **Supervisores y Dueños** solo pueden cobrar en nombre de **otro personal de rol igual o inferior al suyo**, mientras que los **Cajeros** solo pueden cobrar a su propio nombre.
- **Aislamiento de Vistas al Cambiar de Sesión:** Al cerrar sesión o cambiar de usuario hacia un rol de menor jerarquía, el sistema limpia los contenedores del DOM restringidos (`clearRestrictedPanelsDOM`) y redirige automáticamente a la vista permitida.

---

## 3. Gestión de Turnos en Paralelo y Arqueo Ciego (Etapa 3)
- **Bloqueo Estricto de Cobros sin Turno Iniciado:** Tanto el frontend (`switchView`, `goToStep`, `confirmarVentaFinal`) como el backend (`registrarVenta`) impiden cualquier intento de cobro o movimiento si no existe un turno activo (`estado = 'ABIERTO'`), redirigiendo al operador a la pantalla de **Iniciar turno**.
- **Botón Único Dinámico (`Iniciar turno` ↔ `Cerrar turno`):** La pantalla inicial muestra el ingreso de Efectivo Inicial y el botón **Iniciar turno** (tomando la hora automáticamente del dispositivo). Al iniciarse el turno, el botón se transforma en **Cerrar turno**.
- **Arqueo Diferido y Turnos Simultáneos (`estado = 'EN_ARQUEO'`):**
  - El formulario de **Cierre de Caja (arqueo)** permanece oculto durante la operación normal y solo se despliega al presionar **Cerrar turno** (`POST /api/turnos/iniciar-cierre`).
  - Mientras se realiza el arqueo ciego del turno saliente, el sistema habilita inmediatamente el botón **Iniciar turno** para que el relevo comience a operar un turno nuevo en paralelo.
  - Toda venta o movimiento posterior impacta exclusivamente en el turno nuevo (`ABIERTO`), mientras que el cierre en curso (`EN_ARQUEO`) conserva únicamente las operaciones ocurridas durante su ventana de trabajo.

---

## 4. Flujos Operativos de Cobro y Entrada / Salida (Etapa 2)
- **Interfaz Limpia sin Ruido Visual:** Se eliminaron las barras de progreso, las leyendas de estado en cabecera y los títulos de paso a paso dentro de **Cobro** y **Entrada / Salida**.
- **Flujo de Cobro por Etapas:**
  1. Selección de personal habilitado según jerarquía de rol.
  2. Ingreso exclusivo de **Cantidad de unidades** mediante teclado numérico táctil/físico, iniciando por defecto vacío con un `0` transparente (`opacity: 0.28`).
  3. Selección **múltiple de Rubros** con el botón **Siguiente ➡** ubicado por debajo de la grilla.
  4. Contenedores individuales por cada **Medio de Pago** (*Efectivo, Débito, Crédito, Transferencia/QR y Cuenta Corriente*) con pago combinado activo por defecto (los contenedores vacíos o en `0` se ignoran al procesar).
  5. Resumen editable en un toque y confirmación instantánea (`< 10 ms` en SQLite, con cola automática para modo sin internet).
- **Módulo Independiente de Entrada / Salida de Efectivo:**
  - Ubicado en la barra de navegación principal entre *Cobro* y *Caja*, separado en pasos: *(1) Quién registra → (2) Elegir Salida o Entrada → (3) Quién retira o entrega el dinero → (4) Monto*.
  - **Restricción de Entradas de Dinero:** Las **Entradas de efectivo** solo están habilitadas para **Dueño y Supervisor** (ocultas para Cajeros en UI y bloqueadas con HTTP `403` en `turnos.service.js`), y en el paso siguiente muestran únicamente a los Supervisores y Dueños como opciones.

---

## 5. Diseño Visual "Cappuccino y Caramelo", Barra Lateral y Métricas (Etapas 4 y 5)
- **Paleta y Terminación Táctil:** Aplicación integral de la paleta **Cappuccino y Caramelo** (`#eee6dd`, `#f8f3ed`, `#a86b43`, `#588157`) pensada para el descanso visual en jornadas extensas, con botones de acabado satinado, luz interna superior y bisel físico inferior de `3px` sin sombras difusas.
- **Tipografía Unificada "Cinta Almendra":** Se unificó la familia tipográfica humanista (`Segoe UI` / `Trebuchet MS` con `tabular-nums` para importes y métricas) y el estilo de encabezados enmarcados en cinta almendra en toda la aplicación, incluyendo todas las tarjetas y tablas de la sección **Métricas**.
- **Barra Lateral Desplegable:** Los accesos de **Supervisor**, **Métricas** y **Salir** se alojaron en una barra lateral izquierda (`#app-sidebar`) controlada por el botón `☰ Menú` de la barra superior, manteniendo estandarizado el tamaño de los botones de navegación.
- **Estabilidad de PWA y Servidor:** Se filtraron en el Service Worker (`frontend/sw.js`) los esquemas ajenos al origen (`chrome-extension://`) y se configuró `node --watch` en `iniciar_sistema.bat` junto con la suite completa de 16 pruebas automatizadas (`etapa1.test.js`, `etapa2_3_4.test.js` y `etapa5_estres_rnf.test.js`).
