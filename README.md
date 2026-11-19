# Sistema de Conteo de Ventas y Arqueo de Caja (Sin Stock)

Aplicación POS Táctil por etapas (Wizard de 5 pasos), Control de Turnos, Arqueo Ciego y Tablero en Tiempo Real para Almacén / Minimercado.

## 1. Inicio Rápido

- **Con 1 clic en Windows:** Ejecutar [iniciar_sistema.bat](file:///d:/Mis%20Documentos/Escritorio/Programacion/Proyectos/Caja%20y%20Arqueo/iniciar_sistema.bat).
- **Por terminal:**
  ```bash
  node backend/src/db/seed-cli.js
  node backend/src/server.js
  ```
  Abrir en el navegador: `http://localhost:4000`
- **Correr Suite de Pruebas Automatizadas (Etapas 1 a 5):**
  ```bash
  node --test backend/tests/*.test.js
  ```

## 2. Credenciales Preconfiguradas (3 Roles Estrictos — RNF-03)

| Usuario | Rol | PIN | Permisos Asignados |
| :--- | :--- | :---: | :--- |
| `lucas` / `martina` | **CAJERO** | `1111` / `2222` | Cobro rápido por rubro, entradas/salidas menores y **Arqueo Ciego** (no ve saldos esperados ni reportes). |
| `supervisor` | **SUPERVISOR** | `5555` | Autoriza movimientos, registra aperturas de cajón sin venta y **solo ve el efectivo total del turno activo** (sin acceso a reportes de ventas ni recaudación). |
| `dueno` | **DUEÑO** | `9999` | Acceso total local y remoto (móvil/PC): Tablero en vivo (≤2 s), reportes por hora/día/rubro/medio, faltantes/sobrantes, exportación Excel/PDF, administración de catálogos, anulaciones y Audit Log antirrobo. |

## 3. Regla Estructural (Sin Control de Stock)
El sistema **no utiliza códigos de barras ni productos individuales**. Toda venta se registra en segundos indicando únicamente:
1. **Empleado** → 2. **Cantidad de unidades e Importe ($)** → 3. **Rubro(s) / Familia(s)** → 4. **Medio(s) de Pago (5 medios + Pagos Combinados + Cálculo de Vuelto)** → 5. **Resumen Editable y Confirmación (`Enter`)**.
