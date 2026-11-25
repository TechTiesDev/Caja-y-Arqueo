/* ============================================================================
   FRONTEND CAJA Y ARQUEO — MULTI-TENANT + CONSOLA SOPORTE + TURNOS PARALELOS
   ============================================================================ */

const ROLE_LEVEL = { CAJERO: 1, SUPERVISOR: 2, DUENO: 3, SOPORTE: 4 };

const state = {
  token: null,
  usuario: null,
  activeMaintenanceCompanyId: null,
  activeView: 'caja',
  soporteSubTab: 'empresas',
  empresasSoporteCache: [],
  catalogos: { empleados: [], rubros: [], mediosPago: [], clientesFiado: [] },
  turnoActivo: null,
  turnosEnArqueo: [],
  offlineSimulated: false,
  outboxQueue: JSON.parse(localStorage.getItem('caja_outbox_queue') || '[]'),
  wizard: {
    step: 1,
    cajero: null,
    cantidadActual: '',
    rubrosSeleccionados: [],
    montosPorMedio: {},
    pagos: [],
    clienteFiado: null,
  },
  movWizard: {
    step: 1,
    empleado: null,
    tipo: 'SALIDA',
    destinatario: '',
    monto: '',
  },
};

function isSoporte() {
  return state.usuario?.rol === 'SOPORTE';
}

function isInCompany() {
  return !isSoporte() || Boolean(state.usuario?.empresa_id && state.activeMaintenanceCompanyId);
}

function isOnline() {
  return navigator.onLine && !state.offlineSimulated;
}

function showToast(msg, isError = false) {
  const el = document.getElementById('pos-toast');
  el.textContent = msg;
  el.style.background = isError ? '#a64137' : '#466945';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3200);
}

function uuidv7Client() {
  const ts = BigInt(Date.now());
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const hexTs = ts.toString(16).padStart(12, '0');
  const hexRand = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hexTs.slice(0, 8)}-${hexTs.slice(8, 12)}-7${hexRand.slice(0, 3)}-8${hexRand.slice(3, 6)}-${hexRand.slice(6, 18)}`;
}

async function apiFetch(path, options = {}) {
  // Si se ejecuta dentro del prototipo APK Android (file://) o en modo autónomo, usar el motor embebido
  if (
    (window.location.protocol === 'file:' || state.useStandaloneFallback) &&
    typeof window.handleStandaloneApi === 'function'
  ) {
    return window.handleStandaloneApi(path, options);
  }
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  try {
    const res = await fetch(path, { ...options, headers });
    // Si el hosting estático (ej. Vercel/GitHub Pages sin runtime Node24) devuelve 404/502 en /api, activar motor autónomo
    if ((res.status === 404 || res.status >= 500) && typeof window.handleStandaloneApi === 'function') {
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        state.useStandaloneFallback = true;
        return window.handleStandaloneApi(path, options);
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`);
    return data;
  } catch (err) {
    if (
      (err.name === 'TypeError' || String(err.message).includes('Failed to fetch')) &&
      typeof window.handleStandaloneApi === 'function'
    ) {
      state.useStandaloneFallback = true;
      return window.handleStandaloneApi(path, options);
    }
    throw err;
  }
}

/* CONTROL DE BARRA LATERAL DESPLEGABLE */
function toggleSidebar(forceOpen = null) {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar || !backdrop) return;

  const isCurrentlyHidden = sidebar.classList.contains('hidden');
  const shouldOpen = forceOpen !== null ? forceOpen : isCurrentlyHidden;

  sidebar.classList.toggle('hidden', !shouldOpen);
  backdrop.classList.toggle('hidden', !shouldOpen);
}

function canAccessView(rol, viewName) {
  if (isSoporte() && !isInCompany()) {
    return viewName === 'soporte';
  }
  if (viewName === 'soporte') {
    return isSoporte() && !isInCompany();
  }
  if (['dashboard', 'catalogo', 'personal', 'auditoria'].includes(viewName)) {
    return rol === 'DUENO' || rol === 'SOPORTE';
  }
  if (viewName === 'supervisor') return rol === 'SUPERVISOR' || rol === 'DUENO' || rol === 'SOPORTE';
  return true; // 'caja', 'pos', 'movimientos'
}

function triggerViewAnimation(el) {
  if (!el) return;
  el.style.animation = 'none';
  // Forzar reflow para reiniciar la animación de 500ms al cambiar de función o iniciar sesión
  void el.offsetWidth;
  el.style.animation = '';
}

function switchView(viewName) {
  const rol = state.usuario?.rol || 'CAJERO';

  // 5.1 Guardia de Rutas: Si Soporte está fuera de una empresa, redirigir siempre a 'soporte'
  if (isSoporte() && !isInCompany()) {
    state.activeView = 'soporte';
    document.querySelectorAll('.view-section').forEach((s) => {
      const isTarget = s.id === 'view-soporte';
      s.classList.toggle('active', isTarget);
      if (isTarget) triggerViewAnimation(s);
    });
    toggleSidebar(false);
    loadSoporteConsoleData();
    return;
  }

  let targetView = canAccessView(rol, viewName) ? viewName : 'caja';

  // Bloquear acceso a Cobro y Entrada/Salida si no hay un turno iniciado
  if ((targetView === 'pos' || targetView === 'movimientos') && !state.turnoActivo) {
    showToast('No se permite ningún cobro ni movimiento si no hay un turno iniciado.', true);
    targetView = 'caja';
  }

  state.activeView = targetView;
  persistSessionStorage();

  document.querySelectorAll('#main-nav .nav-tab, #sidebar-company-nav .nav-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === targetView);
  });
  document.querySelectorAll('.view-section').forEach((s) => {
    const isTarget = s.id === `view-${targetView}`;
    s.classList.toggle('active', isTarget);
    if (isTarget) triggerViewAnimation(s);
  });

  toggleSidebar(false);

  if (targetView === 'dashboard' && (rol === 'DUENO' || rol === 'SOPORTE')) loadDashboardVivo();
  if (targetView === 'catalogo' && (rol === 'DUENO' || rol === 'SOPORTE')) renderVistaCatalogo();
  if (targetView === 'personal' && (rol === 'DUENO' || rol === 'SOPORTE')) renderVistaPersonal();
  if (targetView === 'auditoria' && (rol === 'DUENO' || rol === 'SOPORTE')) loadVistaAuditoria();
  if (targetView === 'supervisor' && ['SUPERVISOR', 'DUENO', 'SOPORTE'].includes(rol)) loadVistaSupervisor();
}

function switchSoporteSubTab(subTab) {
  state.soporteSubTab = subTab;
  persistSessionStorage();
  document.querySelectorAll('#sidebar-soporte-nav .nav-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.soporteTab === subTab);
  });
  document.getElementById('soporte-pane-empresas').classList.toggle('hidden', subTab !== 'empresas');
  document.getElementById('soporte-pane-password').classList.toggle('hidden', subTab !== 'password');
  document.getElementById('soporte-pane-usuarios').classList.toggle('hidden', subTab !== 'usuarios');
  const paneStorage = document.getElementById('soporte-pane-storage');
  if (paneStorage) paneStorage.classList.toggle('hidden', subTab !== 'storage');
  toggleSidebar(false);

  if (subTab === 'empresas') loadEmpresasSoporte();
  if (subTab === 'usuarios') loadUsuariosSoporte();
  if (subTab === 'storage') loadStorageAndBackupsSoporte();
}

function clearRestrictedPanelsDOM(rol) {
  if (rol !== 'DUENO' && rol !== 'SOPORTE') {
    ['kpi-recaudacion', 'kpi-efectivo-cajon', 'kpi-digital', 'kpi-tickets'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '-';
    });
    ['tbody-empleados', 'bars-rubros', 'bars-medios', 'tbody-horas', 'tbody-dias', 'tbody-arqueos', 'audit-log-list', 'tbody-ultimas-ventas'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  }
  if (rol === 'CAJERO') {
    const supEl = document.getElementById('sup-efectivo-cajon');
    if (supEl) supEl.textContent = '$0';
  }
}

function persistSessionStorage() {
  if (!state.token || !state.usuario) return;
  try {
    localStorage.setItem(
      'caja_session',
      JSON.stringify({
        token: state.token,
        access_token: state.token,
        usuario: state.usuario,
        activeMaintenanceCompanyId: state.activeMaintenanceCompanyId || null,
        activeView: state.activeView || 'caja',
        soporteSubTab: state.soporteSubTab || 'empresas',
      })
    );
  } catch {
    // Ignorar errores de cuota en storage
  }
}

/* 1. INICIO DE SESIÓN, REGISTRO DE EMPRESA Y CONTROL DE ROLES / SOPORTE */
function activateSessionData(res, maintenanceCompanyId = null) {
  state.token = res.access_token || res.token;
  state.usuario = res.usuario;
  state.activeMaintenanceCompanyId = maintenanceCompanyId;
  if (res.activeView) state.activeView = res.activeView;
  if (res.soporteSubTab) state.soporteSubTab = res.soporteSubTab;
  persistSessionStorage();

  const loginEl = document.getElementById('login-screen');
  const topbarEl = document.getElementById('app-topbar');
  const mainEl = document.getElementById('app-main');

  loginEl.classList.add('hidden');
  topbarEl.classList.remove('hidden');
  mainEl.classList.remove('hidden');
  triggerViewAnimation(topbarEl);
  triggerViewAnimation(mainEl);

  applyRoleVisibility();
}

async function performLogin(username, pin) {
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, pin }),
  });
  activateSessionData(res, null);

  if (isSoporte() && !isInCompany()) {
    switchView('soporte');
    switchSoporteSubTab('empresas');
  } else {
    await refreshAll();
    resetWizard();
    resetMovWizard();
    switchView('caja');
  }
}

function logoutSession() {
  state.token = null;
  state.usuario = null;
  state.activeMaintenanceCompanyId = null;
  localStorage.removeItem('caja_session');
  clearRestrictedPanelsDOM('CAJERO');
  toggleSidebar(false);
  document.getElementById('app-topbar').classList.add('hidden');
  document.getElementById('app-main').classList.add('hidden');
  const loginEl = document.getElementById('login-screen');
  loginEl.classList.remove('hidden');
  triggerViewAnimation(loginEl);
  document.getElementById('login-pin').value = '';
}

function applyRoleVisibility() {
  const rol = state.usuario?.rol || 'CAJERO';
  const mainNav = document.getElementById('main-nav');
  const companyNav = document.getElementById('sidebar-company-nav');
  const soporteNav = document.getElementById('sidebar-soporte-nav');
  const companyBadge = document.getElementById('sidebar-company-badge');
  const btnSalirEmp = document.getElementById('btn-salir-empresa-soporte');
  const sidebarTitle = document.getElementById('sidebar-header-title');
  const tabSup = document.getElementById('tab-supervisor');
  const tabDash = document.getElementById('tab-dashboard');
  const btnEntrada = document.getElementById('btn-tipo-entrada');

  // 5.1 Estado 1: Soporte Fuera de una Empresa
  if (isSoporte() && !isInCompany()) {
    mainNav.classList.add('hidden');
    companyNav.classList.add('hidden');
    soporteNav.classList.remove('hidden');
    companyBadge.classList.add('hidden');
    btnSalirEmp.classList.add('hidden');
    if (sidebarTitle) sidebarTitle.textContent = 'Soporte';
    clearRestrictedPanelsDOM('CAJERO');
    return;
  }

  // 5.2 Estado 2: Soporte Dentro de una Empresa o Usuario Operativo (DUENO / SUPERVISOR / CAJERO)
  mainNav.classList.remove('hidden');
  companyNav.classList.remove('hidden');
  soporteNav.classList.add('hidden');
  if (sidebarTitle) sidebarTitle.textContent = 'Accesos';

  if (state.usuario?.empresa_nombre) {
    companyBadge.textContent = `🏢 ${state.usuario.empresa_nombre}`;
    companyBadge.classList.remove('hidden');
  } else {
    companyBadge.classList.add('hidden');
  }

  if (isSoporte() && isInCompany()) {
    btnSalirEmp.classList.remove('hidden');
  } else {
    btnSalirEmp.classList.add('hidden');
  }

  // Soporte dentro de empresa adopta los mismos enlaces y permisos que DUENO
  const esDuenoOSoporte = rol === 'DUENO' || rol === 'SOPORTE';
  const esSupDuenoOSoporte = ['SUPERVISOR', 'DUENO', 'SOPORTE'].includes(rol);

  tabSup.style.display = esSupDuenoOSoporte ? 'inline-flex' : 'none';
  tabDash.style.display = esDuenoOSoporte ? 'inline-flex' : 'none';
  ['tab-catalogo', 'tab-personal', 'tab-auditoria'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = esDuenoOSoporte ? 'inline-flex' : 'none';
  });

  // Salida/Entrada: Opción de Entrada de dinero habilitada también para los Cajeros
  if (btnEntrada) {
    btnEntrada.style.display = 'inline-flex';
  }

  clearRestrictedPanelsDOM(rol);

  if (!canAccessView(rol, state.activeView)) {
    switchView('caja');
  }
}

/* =========================================================================
   CONSOLA DE SOPORTE E INMERSIÓN CONTEXTUAL EN EMPRESAS (Sección 5)
   ========================================================================= */
async function loadSoporteConsoleData() {
  if (!isSoporte() || isInCompany()) return;
  await loadEmpresasSoporte();
}

async function loadEmpresasSoporte(search = '') {
  try {
    const res = await apiFetch(`/api/auth/empresas?q=${encodeURIComponent(search)}`);
    state.empresasSoporteCache = res.empresas || [];
    renderGridEmpresasSoporte(state.empresasSoporteCache);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderGridEmpresasSoporte(empresas) {
  const grid = document.getElementById('grid-empresas-soporte');
  if (!grid) return;
  if (!empresas.length) {
    grid.innerHTML = '<p class="muted-note">No se encontraron empresas con ese criterio.</p>';
    return;
  }

  grid.innerHTML = empresas
    .map((emp) => {
      const fechaAlta = (emp.creado_en || '').slice(0, 10);
      const estadoLabel = emp.activo ? 'ACTIVA' : 'INACTIVA';
      return `
        <div class="card">
          <h2>🏢 ${emp.nombre}</h2>
          <p class="muted-note"><strong>Estado:</strong> ${estadoLabel} · <strong>Alta:</strong> ${fechaAlta}</p>
          <p class="muted-note"><strong>Teléfono:</strong> ${emp.telefono || 'S/D'}</p>
          <p class="muted-note"><strong>Usuarios:</strong> ${emp.total_usuarios || 0} · <strong>Ventas registradas:</strong> ${emp.total_ventas || 0}</p>
          <button type="button" class="btn-primary-xl mt-16" onclick="window.ingresarMantenimientoEmpresa('${emp.id}')">
            🔧 Ingresar / Mantenimiento
          </button>
        </div>
      `;
    })
    .join('');
}

window.ingresarMantenimientoEmpresa = async (empresaId) => {
  try {
    const res = await apiFetch(`/api/auth/empresas/${encodeURIComponent(empresaId)}/ingresar`, {
      method: 'POST',
    });
    activateSessionData(res, res.empresa_id);
    showToast(`🔧 Modo Mantenimiento activo en ${res.empresa_nombre}`);
    await refreshAll();
    resetWizard();
    resetMovWizard();
    switchView('caja');
  } catch (err) {
    showToast(err.message, true);
  }
};

async function salirMantenimientoEmpresa() {
  try {
    const res = await apiFetch('/api/auth/empresas/salir', {
      method: 'POST',
    });
    activateSessionData(res, null);
    showToast('Salió de la empresa. De regreso en Consola Soporte.');
    switchView('soporte');
    switchSoporteSubTab('empresas');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadUsuariosSoporte() {
  try {
    const res = await apiFetch('/api/auth/soporte/usuarios');
    const tbody = document.getElementById('tbody-usuarios-soporte');
    if (!tbody) return;
    tbody.innerHTML = (res.usuarios || [])
      .map((u) => {
        const esPropio = u.id === state.usuario?.id;
        return `
          <tr>
            <td><strong>${u.nombre}</strong></td>
            <td>${u.email || u.username}</td>
            <td>${u.activo ? 'Activo' : 'Inactivo'}</td>
            <td>
              ${esPropio
            ? '<small class="muted-note">En sesión</small>'
            : `<button type="button" class="btn-outline-sm" onclick="window.eliminarSoporteUserUI('${u.id}')">Eliminar</button>`
          }
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    showToast(err.message, true);
  }
}

window.eliminarSoporteUserUI = async (targetId) => {
  try {
    await apiFetch(`/api/auth/soporte/usuarios/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
    });
    showToast('Usuario Soporte eliminado.');
    await loadUsuariosSoporte();
  } catch (err) {
    showToast(err.message, true);
  }
};

async function loadStorageAndBackupsSoporte() {
  try {
    const statusRes = await apiFetch('/api/v1/sistema/storage/status');
    const st = statusRes.data || statusRes;
    const resumenEl = document.getElementById('soporte-storage-resumen');
    if (resumenEl) {
      resumenEl.textContent = `Proveedor: ${st.storage_provider} (${st.bucket}) · Archivos: ${st.total_archivos} · Uso: ${st.used_mb} MB / ${st.quota_mb} MB (${st.percent_used}%)`;
    }

    const backupsRes = await apiFetch('/api/v1/sistema/backups');
    const items = backupsRes.data?.items || backupsRes.items || [];
    const tbody = document.getElementById('tbody-backups-soporte');
    if (tbody) {
      tbody.innerHTML = items.length
        ? items
            .map(
              (b) => `
          <tr>
            <td>${(b.creado_en || '').slice(0, 19).replace('T', ' ')}</td>
            <td><strong>${b.tipo}</strong></td>
            <td>${Math.round(Number(b.tamano_bytes || 0) / 1024)} KB</td>
            <td><code>${(b.checksum_sha256 || '').slice(0, 16)}...</code></td>
          </tr>
        `
            )
            .join('')
        : '<tr><td colspan="4" class="muted-note">Sin respaldos ejecutados aún.</td></tr>';
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

/* 2. CARGA DE CATÁLOGOS Y ESTADO DE TURNOS DE LA EMPRESA ACTIVA */
async function refreshAll() {
  if (isSoporte() && !isInCompany()) return;

  try {
    if (isOnline()) {
      const snap = await apiFetch('/api/catalogos/snapshot');
      state.catalogos = snap;
      localStorage.setItem('caja_catalogos_cache', JSON.stringify(snap));

      const tRes = await apiFetch('/api/turnos/activo?puesto_caja=CAJA-01');
      state.turnoActivo = tRes.turno || null;
      state.turnosEnArqueo = tRes.turnos_en_arqueo || [];
      localStorage.setItem('caja_turno_cache', JSON.stringify(state.turnoActivo));
      localStorage.setItem('caja_turnos_arqueo_cache', JSON.stringify(state.turnosEnArqueo));
    } else {
      const cachedCat = localStorage.getItem('caja_catalogos_cache');
      if (cachedCat) state.catalogos = JSON.parse(cachedCat);
      const cachedTur = localStorage.getItem('caja_turno_cache');
      if (cachedTur) state.turnoActivo = JSON.parse(cachedTur);
      const cachedArq = localStorage.getItem('caja_turnos_arqueo_cache');
      if (cachedArq) state.turnosEnArqueo = JSON.parse(cachedArq);
    }
  } catch {
    // Fallback offline silencioso
  }

  renderEstadoCajaView();
  renderWizardStep1();
  renderWizardStep3();
  renderWizardStep4Medios();
  renderMovStep1();
  populateDashboardFilters();

  if ((state.usuario?.rol === 'DUENO' || state.usuario?.rol === 'SOPORTE') && isOnline()) {
    if (state.activeView === 'dashboard') loadDashboardVivo();
    if (state.activeView === 'catalogo') renderVistaCatalogo();
    if (state.activeView === 'personal') renderVistaPersonal();
    if (state.activeView === 'auditoria') loadVistaAuditoria();
  }
  if (['SUPERVISOR', 'DUENO', 'SOPORTE'].includes(state.usuario?.rol) && state.turnoActivo && isOnline() && state.activeView === 'supervisor') {
    loadVistaSupervisor();
  }
}

function renderEstadoCajaView() {
  const tituloControl = document.getElementById('titulo-control-turno');
  const wrapFondo = document.getElementById('wrap-fondo-inicial');
  const btnAccion = document.getElementById('btn-accion-turno');
  const cardCierre = document.getElementById('card-cierre-caja');
  const notaArqueo = document.getElementById('nota-turno-arqueo');
  const tabPos = document.querySelector('.nav-tab[data-view="pos"]');
  const tabMov = document.querySelector('.nav-tab[data-view="movimientos"]');

  if (!state.turnoActivo) {
    tituloControl.textContent = 'Iniciar turno';
    wrapFondo.classList.remove('hidden');
    btnAccion.textContent = 'Iniciar turno';
    btnAccion.className = 'btn-primary-xl mt-16';
    if (tabPos) tabPos.style.opacity = '0.5';
    if (tabMov) tabMov.style.opacity = '0.5';
    if (state.activeView === 'pos' || state.activeView === 'movimientos') {
      switchView('caja');
    }
  } else {
    tituloControl.textContent = 'Turno en curso';
    wrapFondo.classList.add('hidden');
    btnAccion.textContent = 'Cerrar turno';
    btnAccion.className = 'btn-danger-xl mt-16';
    if (tabPos) tabPos.style.opacity = '1';
    if (tabMov) tabMov.style.opacity = '1';
  }

  if (state.turnosEnArqueo && state.turnosEnArqueo.length > 0) {
    const turnoArqueo = state.turnosEnArqueo[0];
    const horaAp = new Date(turnoArqueo.abierto_en).toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const cajeroNom = (turnoArqueo.cajero_nombre || '').split('(')[0].trim();
    if (notaArqueo) {
      notaArqueo.textContent = `Arqueo correspondiente al turno iniciado a las ${horaAp} hs (${cajeroNom}).`;
    }
    cardCierre.classList.remove('hidden');
  } else {
    cardCierre.classList.add('hidden');
  }
}

/* 3. WIZARD DE COBRO */
function goToStep(stepNum) {
  if (stepNum > 1 && !state.turnoActivo) {
    showToast('No se permite ningún cobro si no hay un turno iniciado.', true);
    switchView('caja');
    return;
  }
  state.wizard.step = stepNum;
  document.querySelectorAll('#view-pos .wizard-step').forEach((el, idx) => {
    el.classList.toggle('active', idx + 1 === stepNum);
  });

  document.getElementById('btn-wizard-back').disabled = stepNum === 1;

  if (stepNum === 2) {
    updateNumpadDisplays();
  } else if (stepNum === 3) {
    renderWizardStep3();
  } else if (stepNum === 4) {
    renderStep4State();
  } else if (stepNum === 5) {
    renderStep5Summary();
  }
}

function getAllowedCashiersForCurrentSession() {
  const actor = state.usuario;
  if (!actor) return state.catalogos.empleados;

  if (actor.rol === 'CAJERO') {
    return state.catalogos.empleados.filter((e) => e.id === actor.id);
  }

  const actorLevel = ROLE_LEVEL[actor.rol] || 1;
  return state.catalogos.empleados.filter(
    (e) => e.id !== actor.id && (ROLE_LEVEL[e.rol] || 1) <= actorLevel
  );
}

function resetWizard() {
  const permitidos = getAllowedCashiersForCurrentSession();
  const defaultCajero = permitidos[0] || null;
  state.wizard = {
    step: 1,
    cajero: defaultCajero,
    cantidadActual: '',
    rubrosSeleccionados: [],
    montosPorMedio: {},
    pagos: [],
    clienteFiado: null,
  };
  document.getElementById('panel-cuenta-corriente').classList.add('hidden');
  renderWizardStep1();
  renderWizardStep4Medios();
  goToStep(1);
}

function renderWizardStep1() {
  const grid = document.getElementById('grid-empleados');
  if (!grid) return;
  grid.innerHTML = '';

  const permitidos = getAllowedCashiersForCurrentSession();
  permitidos.forEach((emp) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-btn';
    btn.textContent = emp.nombre.split('(')[0].trim();
    btn.onclick = () => {
      state.wizard.cajero = emp;
      goToStep(2);
    };
    grid.appendChild(btn);
  });
}

function updateNumpadDisplays() {
  const display = document.getElementById('display-cantidad');
  if (!state.wizard.cantidadActual || state.wizard.cantidadActual === '0') {
    display.innerHTML = '<span class="placeholder-zero">0</span>';
  } else {
    display.textContent = state.wizard.cantidadActual;
  }
}

function handleNumpadKey(key) {
  if (key === 'C') {
    state.wizard.cantidadActual = '';
  } else {
    const current = state.wizard.cantidadActual === '0' ? '' : state.wizard.cantidadActual;
    const next = (current + key).replace(/^0+/, '').slice(0, 5);
    state.wizard.cantidadActual = next;
  }
  updateNumpadDisplays();
}

function validateStep2AndAdvance() {
  const cant = parseInt(state.wizard.cantidadActual, 10);
  if (isNaN(cant) || cant <= 0) {
    return showToast('Ingrese una cantidad mayor a 0.', true);
  }
  goToStep(3);
}

function renderWizardStep3() {
  const grid = document.getElementById('grid-rubros');
  grid.innerHTML = '';
  const selectedIds = new Set(state.wizard.rubrosSeleccionados.map((r) => r.id));

  state.catalogos.rubros.forEach((rub) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSel = selectedIds.has(rub.id);
    btn.className = `touch-btn${isSel ? ' selected' : ''}`;
    btn.textContent = rub.nombre;
    btn.onclick = () => {
      const idx = state.wizard.rubrosSeleccionados.findIndex((r) => r.id === rub.id);
      if (idx >= 0) {
        state.wizard.rubrosSeleccionados.splice(idx, 1);
      } else {
        state.wizard.rubrosSeleccionados.push(rub);
      }
      renderWizardStep3();
    };
    grid.appendChild(btn);
  });
}

function validateStep3AndAdvance() {
  if (state.wizard.rubrosSeleccionados.length === 0) {
    return showToast('Seleccione al menos un rubro.', true);
  }
  goToStep(4);
}

function getTotalStep4() {
  return Object.values(state.wizard.montosPorMedio).reduce((acc, val) => {
    const num = parseFloat(val);
    return acc + (!isNaN(num) && num > 0 ? num : 0);
  }, 0);
}

function renderWizardStep4Medios() {
  const grid = document.getElementById('grid-medios-pago');
  grid.innerHTML = '';

  state.catalogos.mediosPago.forEach((mp) => {
    const card = document.createElement('div');
    const currentVal = state.wizard.montosPorMedio[mp.id] || '';
    card.className = `payment-container-card${Number(currentVal) > 0 ? ' has-amount' : ''}`;
    card.innerHTML = `
      <label class="payment-container-title">${mp.nombre}</label>
      <input
        type="number"
        class="payment-container-input"
        placeholder="$ 0"
        min="0"
        step="any"
        value="${currentVal}"
      />
    `;
    const input = card.querySelector('input');
    input.oninput = (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val > 0) {
        state.wizard.montosPorMedio[mp.id] = Math.round(val * 100) / 100;
        card.classList.add('has-amount');
      } else {
        delete state.wizard.montosPorMedio[mp.id];
        card.classList.remove('has-amount');
      }
      renderStep4State();
    };
    grid.appendChild(card);
  });
}

function renderStep4State() {
  const total = getTotalStep4();
  document.getElementById('step4-total-label').textContent = `$${total.toLocaleString('es-AR')}`;

  const mpFiado = state.catalogos.mediosPago.find((m) => m.codigo === 'CUENTA_CORRIENTE');
  const montoFiado = mpFiado ? Number(state.wizard.montosPorMedio[mpFiado.id] || 0) : 0;
  const panelFiado = document.getElementById('panel-cuenta-corriente');

  if (montoFiado > 0) {
    panelFiado.classList.remove('hidden');
    const gridCli = document.getElementById('grid-clientes-fiado');
    gridCli.innerHTML = '';
    state.catalogos.clientesFiado.forEach((cli) => {
      const b = document.createElement('button');
      b.type = 'button';
      const isSelected = state.wizard.clienteFiado?.id === cli.id;
      b.className = `touch-btn${isSelected ? ' selected' : ''}`;
      b.innerHTML = `<span>${cli.nombre}</span><small>$${cli.disponible}</small>`;
      b.onclick = () => {
        state.wizard.clienteFiado = cli;
        renderStep4State();
      };
      gridCli.appendChild(b);
    });
  } else {
    state.wizard.clienteFiado = null;
    panelFiado.classList.add('hidden');
  }
}

function validateStep4AndAdvance() {
  const pagosActivos = [];
  for (const mp of state.catalogos.mediosPago) {
    const monto = Number(state.wizard.montosPorMedio[mp.id] || 0);
    if (monto > 0) {
      pagosActivos.push({
        medio_pago_id: mp.id,
        codigo_medio: mp.codigo,
        nombre: mp.nombre,
        monto: Math.round(monto * 100) / 100,
      });
    }
  }

  if (pagosActivos.length === 0) {
    return showToast('Ingrese monto en al menos un método de pago.', true);
  }

  const usaFiado = pagosActivos.some((p) => p.codigo_medio === 'CUENTA_CORRIENTE');
  if (usaFiado && !state.wizard.clienteFiado) {
    return showToast('Seleccione el cliente para Cuenta Corriente.', true);
  }

  state.wizard.pagos = pagosActivos;
  goToStep(5);
}

function buildLineasRubroFromWizard() {
  const rubros = state.wizard.rubrosSeleccionados;
  const cantTotal = Math.max(1, parseInt(state.wizard.cantidadActual, 10) || 1);
  const montoTotal = Math.round(getTotalStep4() * 100) / 100;
  const n = rubros.length;

  let cantRestante = cantTotal;
  let montoRestante = montoTotal;

  return rubros.map((r, i) => {
    const esUltimo = i === n - 1;
    const cantLinea = esUltimo ? Math.max(1, cantRestante) : Math.max(1, Math.floor(cantTotal / n));
    cantRestante = Math.max(1, cantRestante - cantLinea);

    const subLinea = esUltimo ? Math.round(montoRestante * 100) / 100 : Math.round((montoTotal / n) * 100) / 100;
    montoRestante = Math.round((montoRestante - subLinea) * 100) / 100;

    return {
      rubro_id: r.id,
      rubro_nombre: r.nombre,
      cantidad: cantLinea,
      subtotal: subLinea,
    };
  });
}

function renderStep5Summary() {
  const card = document.getElementById('summary-editable-card');
  const total = getTotalStep4();
  const cantTotal = parseInt(state.wizard.cantidadActual, 10) || 1;
  const rubrosTexto = state.wizard.rubrosSeleccionados.map((r) => r.nombre).join(', ');
  const pagosTexto = state.wizard.pagos.map((p) => `${p.nombre}: $${p.monto.toLocaleString('es-AR')}`).join(' + ');

  card.innerHTML = `
    <div class="summary-row" data-goto="1">
      <span>Cajero:</span>
      <strong>${state.wizard.cajero?.nombre.split('(')[0].trim() || 'Seleccionar'} ✎</strong>
    </div>
    <div class="summary-row" data-goto="2">
      <span>Cantidad:</span>
      <strong>${cantTotal} u. ✎</strong>
    </div>
    <div class="summary-row" data-goto="3">
      <span>Rubro(s):</span>
      <strong>${rubrosTexto} ✎</strong>
    </div>
    <div class="summary-row" data-goto="4">
      <span>Pago(s):</span>
      <strong>${pagosTexto} ✎</strong>
    </div>
    <div class="summary-row" data-goto="4">
      <span>TOTAL:</span>
      <strong style="font-size:1.5rem;color:#253c24;">$${total.toLocaleString('es-AR')}</strong>
    </div>
  `;

  card.querySelectorAll('.summary-row').forEach((row) => {
    row.onclick = () => goToStep(Number(row.dataset.goto));
  });
}

async function confirmarVentaFinal() {
  if (!state.turnoActivo) {
    showToast('No se permite ningún cobro si no hay un turno iniciado.', true);
    switchView('caja');
    return;
  }

  const lineasRubro = buildLineasRubroFromWizard();
  const payload = {
    id: uuidv7Client(),
    turno_id: state.turnoActivo.id,
    fondo_inicial: Number(state.turnoActivo.fondo_inicial || 0),
    cajero_id: state.wizard.cajero?.id || state.usuario?.id,
    cliente_fiado_id: state.wizard.clienteFiado?.id || null,
    lineas_rubro: lineasRubro,
    pagos: state.wizard.pagos,
    fecha_venta: new Date().toISOString(),
  };

  if (!isOnline()) {
    state.outboxQueue.push(payload);
    localStorage.setItem('caja_outbox_queue', JSON.stringify(state.outboxQueue));
    showToast('Venta guardada sin internet.');
    resetWizard();
    return;
  }

  try {
    const venta = await apiFetch('/api/ventas', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast(`✔ Ticket #${venta.numero_ticket} registrado ($${venta.monto_total})`);
    resetWizard();
    if ((state.usuario?.rol === 'DUENO' || state.usuario?.rol === 'SOPORTE') && state.activeView === 'dashboard') {
      loadDashboardVivo();
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

/* 4. ENTRADA / SALIDA DE EFECTIVO EN 4 PASOS SEPARADOS */
function goToMovStep(stepNum) {
  state.movWizard.step = stepNum;
  document.querySelectorAll('#view-movimientos .wizard-step').forEach((el, idx) => {
    el.classList.toggle('active', idx + 1 === stepNum);
  });

  document.getElementById('btn-mov-back').disabled = stepNum === 1;

  if (stepNum === 3) {
    renderMovStep3Destinatarios();
  } else if (stepNum === 4) {
    renderMovStep4Summary();
  }
}

function renderMovStep3Destinatarios() {
  const grid = document.getElementById('grid-mov-destinatarios');
  const wrapCustom = document.getElementById('wrap-mov-custom-dest');
  if (!grid) return;
  grid.innerHTML = '';

  if (state.movWizard.tipo === 'ENTRADA') {
    if (wrapCustom) wrapCustom.classList.add('hidden');
    const supervisoresYDueno = state.catalogos.empleados.filter(
      (e) => e.rol === 'SUPERVISOR' || e.rol === 'DUENO'
    );
    supervisoresYDueno.forEach((persona) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const label = persona.nombre.split('(')[0].trim();
      btn.className = `touch-btn${state.movWizard.destinatario === label ? ' selected' : ''}`;
      btn.textContent = `${label} (${persona.rol === 'DUENO' ? 'Dueño' : 'Supervisor'})`;
      btn.onclick = () => {
        state.movWizard.destinatario = label;
        goToMovStep(4);
      };
      grid.appendChild(btn);
    });
  } else {
    if (wrapCustom) wrapCustom.classList.remove('hidden');
    const opcionesSalida = [
      'Dueño',
      'Proveedor Panadería',
      'Proveedor Bebidas',
      'Proveedor Lácteos',
      'Proveedor Fiambrería',
      'Otro Proveedor',
    ];
    opcionesSalida.forEach((dest) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `touch-btn${state.movWizard.destinatario === dest ? ' selected' : ''}`;
      btn.textContent = dest;
      btn.onclick = () => {
        state.movWizard.destinatario = dest;
        const customInput = document.getElementById('input-mov-custom-dest');
        if (customInput) customInput.value = dest;
        goToMovStep(4);
      };
      grid.appendChild(btn);
    });
  }
}

function resetMovWizard() {
  const permitidos = getAllowedCashiersForCurrentSession();
  state.movWizard = {
    step: 1,
    empleado: permitidos[0] || state.usuario || null,
    tipo: 'SALIDA',
    destinatario: '',
    monto: '',
  };
  const customInput = document.getElementById('input-mov-custom-dest');
  if (customInput) customInput.value = '';
  const montoInput = document.getElementById('input-mov-monto');
  if (montoInput) montoInput.value = '';
  document.querySelectorAll('#grid-mov-tipo .touch-btn').forEach((b) => b.classList.remove('selected'));
  document.querySelectorAll('#grid-mov-destinatarios .touch-btn').forEach((b) => b.classList.remove('selected'));
  renderMovStep1();
  goToMovStep(1);
}

function renderMovStep1() {
  const grid = document.getElementById('grid-mov-empleados');
  if (!grid) return;
  grid.innerHTML = '';

  // Aplicar el mismo criterio de opciones limitado según el rol en sesión
  const permitidos = getAllowedCashiersForCurrentSession();
  permitidos.forEach((emp) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-btn';
    btn.textContent = emp.nombre.split('(')[0].trim();
    btn.onclick = () => {
      state.movWizard.empleado = emp;
      goToMovStep(2);
    };
    grid.appendChild(btn);
  });
}

function renderMovStep4Summary() {
  const box = document.getElementById('mov-summary-preview');
  const quien = state.movWizard.empleado?.nombre.split('(')[0].trim() || '-';
  const tipoLabel = state.movWizard.tipo === 'SALIDA' ? 'Salida de Efectivo' : 'Entrada de Efectivo';
  box.innerHTML = `
    <div class="summary-row" onclick="goToMovStep(1)">
      <span>Registra:</span>
      <strong>${quien} ✎</strong>
    </div>
    <div class="summary-row" onclick="goToMovStep(2)">
      <span>Operación:</span>
      <strong>${tipoLabel} ✎</strong>
    </div>
    <div class="summary-row" onclick="goToMovStep(3)">
      <span>Retira / Entrega:</span>
      <strong>${state.movWizard.destinatario} ✎</strong>
    </div>
  `;
}

async function confirmarMovimientoEfectivo() {
  if (!state.turnoActivo) {
    showToast('Primero debe iniciar turno en la pestaña Caja.', true);
    switchView('caja');
    return;
  }

  const monto = parseFloat(document.getElementById('input-mov-monto').value);
  if (isNaN(monto) || monto <= 0) {
    return showToast('Ingrese un monto válido mayor a $0.', true);
  }

  const dest = state.movWizard.destinatario || 'General';
  const categoria = dest.toLowerCase().includes('dueño')
    ? 'RETIRO_SEGURIDAD'
    : dest.toLowerCase().includes('proveedor')
      ? 'PROVEEDOR'
      : 'OTRO';

  try {
    await apiFetch('/api/turnos/movimientos', {
      method: 'POST',
      body: JSON.stringify({
        turno_id: state.turnoActivo.id,
        fondo_inicial: Number(state.turnoActivo.fondo_inicial || 0),
        usuario_id: state.movWizard.empleado?.id || state.usuario?.id,
        tipo: state.movWizard.tipo,
        categoria,
        monto: Math.round(monto * 100) / 100,
        motivo: `${dest} (Registrado por ${state.movWizard.empleado?.nombre.split('(')[0].trim() || 'Cajero'})`,
      }),
    });
    showToast(`✔ ${state.movWizard.tipo === 'SALIDA' ? 'Salida' : 'Entrada'} registrada ($${monto})`);
    resetMovWizard();
    await refreshAll();
  } catch (err) {
    showToast(err.message, true);
  }
}

/* 5. SINCRONIZACIÓN AUTOMÁTICA DE COLA OFFLINE */
async function syncOfflineQueueIfNeeded() {
  if (!isOnline() || state.outboxQueue.length === 0 || !state.token) return;
  try {
    const res = await apiFetch('/api/ventas/offline-sync', {
      method: 'POST',
      body: JSON.stringify({ ventas: state.outboxQueue }),
    });
    state.outboxQueue = [];
    localStorage.setItem('caja_outbox_queue', '[]');
    showToast(`🔄 Sincronizadas ${res.sincronizadas} ventas.`);
    await refreshAll();
  } catch (err) {
    showToast(`Error sincronizando: ${err.message}`, true);
  }
}

/* 6. PANEL DE SUPERVISOR Y MÉTRICAS DEL DUEÑO / SOPORTE */
async function loadVistaSupervisor() {
  if (!state.turnoActivo) {
    document.getElementById('sup-efectivo-cajon').textContent = '$0 (Sin turno activo)';
    return;
  }
  try {
    const data = await apiFetch(`/api/turnos/resumen-supervisor?turno_id=${state.turnoActivo.id}`);
    document.getElementById('sup-efectivo-cajon').textContent = `$${Number(data.total_efectivo_en_cajon_turno).toLocaleString('es-AR')}`;
  } catch {
    // Silencioso
  }
}

function populateDashboardFilters() {
  const selEmp = document.getElementById('filtro-empleado');
  const selRub = document.getElementById('filtro-rubro');
  const empVal = selEmp.value;
  const rubVal = selRub.value;

  selEmp.innerHTML =
    '<option value="">Todos los Empleados</option>' +
    state.catalogos.empleados.map((e) => `<option value="${e.id}">${e.nombre.split('(')[0].trim()}</option>`).join('');
  selRub.innerHTML =
    '<option value="">Todos los Rubros</option>' +
    state.catalogos.rubros.map((r) => `<option value="${r.id}">${r.nombre}</option>`).join('');

  selEmp.value = empVal;
  selRub.value = rubVal;
}

async function loadDashboardVivo() {
  const rol = state.usuario?.rol;
  if ((rol !== 'DUENO' && rol !== 'SOPORTE') || !isOnline()) return;
  const cajeroId = document.getElementById('filtro-empleado').value;
  const rubroId = document.getElementById('filtro-rubro').value;
  const qs = new URLSearchParams();
  if (cajeroId) qs.set('cajero_id', cajeroId);
  if (rubroId) qs.set('rubro_id', rubroId);

  try {
    const d = await apiFetch(`/api/analitica/dashboard?${qs.toString()}`);
    document.getElementById('kpi-recaudacion').textContent = `$${d.kpis.recaudacion_total.toLocaleString('es-AR')}`;
    document.getElementById('kpi-efectivo-cajon').textContent = `$${d.kpis.efectivo_en_cajon_actual.toLocaleString('es-AR')}`;
    document.getElementById('kpi-digital').textContent = `$${d.kpis.ingresos_digitales_turnos_abiertos.toLocaleString('es-AR')}`;
    document.getElementById('kpi-tickets').textContent = `${d.kpis.cantidad_tickets} ($${d.kpis.ticket_promedio})`;

    document.getElementById('tbody-empleados').innerHTML = d.rendimiento_empleados
      .map(
        (e) => `<tr>
          <td><strong>${e.cajero_nombre.split('(')[0].trim()}</strong></td>
          <td>${e.cantidad_tickets}</td>
          <td>$${e.total_vendido.toLocaleString('es-AR')}</td>
          <td>$${e.ticket_promedio.toLocaleString('es-AR')}</td>
          <td><strong>${e.porcentaje_participacion}%</strong></td>
        </tr>`
      )
      .join('');

    document.getElementById('bars-rubros').innerHTML = d.ventas_por_rubro
      .map(
        (r) => `<div class="bar-row">
          <div class="bar-label"><span>${r.rubro_nombre} (${r.unidades} u.)</span><span>$${r.total_vendido.toLocaleString('es-AR')} (${r.porcentaje}%)</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${r.porcentaje}%;background:${r.color_hex}"></div></div>
        </div>`
      )
      .join('');

    document.getElementById('bars-medios').innerHTML = d.ventas_por_medio_pago
      .map(
        (m) => `<div class="bar-row">
          <div class="bar-label"><span>${m.medio_nombre}</span><span>$${m.total_ingresado.toLocaleString('es-AR')} (${m.porcentaje}%)</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${m.porcentaje}%"></div></div>
        </div>`
      )
      .join('');

    document.getElementById('tbody-horas').innerHTML = d.ventas_por_hora
      .map((h) => `<tr><td>${h.franja_horaria}</td><td>${h.cantidad_tickets}</td><td>$${h.total_vendido.toLocaleString('es-AR')}</td></tr>`)
      .join('');

    document.getElementById('tbody-dias').innerHTML = d.ventas_por_dia
      .map((dia) => `<tr><td>${dia.fecha}</td><td>${dia.dia_semana}</td><td>${dia.cantidad_tickets}</td><td>$${dia.total_vendido.toLocaleString('es-AR')}</td></tr>`)
      .join('');

    document.getElementById('tbody-arqueos').innerHTML = d.historial_arqueos
      .map((a) => {
        const horaAp = new Date(a.abierto_en).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        return `<tr>
          <td>${horaAp} hs (${a.estado})</td>
          <td>${a.cajero_nombre.split('(')[0].trim()}</td>
          <td>${a.declarado_efectivo !== null ? '$' + a.declarado_efectivo : '-'}</td>
          <td>${a.esperado_efectivo !== null ? '$' + a.esperado_efectivo : 'En curso'}</td>
          <td>${a.diferencia_efectivo !== null ? '$' + a.diferencia_efectivo : '-'}</td>
          <td><strong>${a.estado_cuadre || a.estado}</strong></td>
        </tr>`;
      })
      .join('');
  } catch {
    // Silencioso
  }
}

/* SECCIONES INDEPENDIENTES: CATÁLOGO, PERSONAL Y AUDITORÍA */
function renderVistaCatalogo() {
  const tbodyRubros = document.getElementById('tbody-catalogo-rubros');
  if (tbodyRubros) {
    tbodyRubros.innerHTML = state.catalogos.rubros
      .map(
        (r) => `<tr>
          <td><strong>${r.nombre}</strong></td>
          <td>
            <button type="button" class="btn-outline-sm" onclick="window.eliminarRubroUI('${r.id}', '${r.nombre}')">
              Eliminar
            </button>
          </td>
        </tr>`
      )
      .join('');
  }

  const tbodyClientes = document.getElementById('tbody-catalogo-clientes');
  if (tbodyClientes) {
    tbodyClientes.innerHTML = state.catalogos.clientesFiado
      .map(
        (c) => `<tr>
          <td><strong>${c.nombre}</strong></td>
          <td>$${Number(c.limite_credito).toLocaleString('es-AR')}</td>
          <td>$${Number(c.saldo_deudor).toLocaleString('es-AR')}</td>
          <td><strong>$${Number(c.disponible).toLocaleString('es-AR')}</strong></td>
        </tr>`
      )
      .join('');
  }
}

window.eliminarRubroUI = async (rubroId, nombre) => {
  try {
    await apiFetch(`/api/catalogos/rubros/${encodeURIComponent(rubroId)}`, {
      method: 'DELETE',
    });
    showToast(`Rubro "${nombre}" eliminado.`);
    await refreshAll();
  } catch (err) {
    showToast(err.message, true);
  }
};

function renderVistaPersonal() {
  const tbodyPersonal = document.getElementById('tbody-personal-lista');
  if (!tbodyPersonal) return;
  tbodyPersonal.innerHTML = state.catalogos.empleados
    .map(
      (e) => `<tr>
        <td><strong>${e.nombre.split('(')[0].trim()}</strong></td>
        <td>${e.username || e.email || '-'}</td>
        <td>${e.rol}</td>
        <td>${e.activo ? 'Activo' : 'Inactivo'}</td>
      </tr>`
    )
    .join('');
}

async function loadVistaAuditoria() {
  const rol = state.usuario?.rol;
  if ((rol !== 'DUENO' && rol !== 'SOPORTE') || !isOnline()) return;

  try {
    const accionFiltro = document.getElementById('filtro-auditoria-accion')?.value || '';
    const qs = accionFiltro ? `?limit=50&accion=${encodeURIComponent(accionFiltro)}` : '?limit=50';
    const auditRes = await apiFetch(`/api/auditoria${qs}`);
    document.getElementById('audit-log-list').innerHTML = auditRes.logs
      .map(
        (l) => `<div style="padding:8px 0;border-bottom:1px solid #d2bfb0;font-size:0.9rem;">
          <strong>[${l.accion}]</strong> ${l.usuario_nombre.split('(')[0].trim()} (${l.rol_usuario}) — <small>${l.timestamp.slice(0, 10)} ${l.timestamp.slice(11, 19)}</small>
        </div>`
      )
      .join('');

    const ventasRes = await apiFetch('/api/ventas?limit=20');
    document.getElementById('tbody-ultimas-ventas').innerHTML = ventasRes.ventas
      .map(
        (v) => `<tr>
          <td>#${v.numero_ticket}</td>
          <td>${v.cajero_nombre.split('(')[0].trim()}</td>
          <td>${v.cantidad_total_articulos} u.</td>
          <td>$${Number(v.monto_total).toLocaleString('es-AR')}</td>
          <td><strong>${v.estado}</strong></td>
          <td>${v.estado === 'COMPLETADA'
            ? `<button class="btn-outline-sm" onclick="window.anularTicketUI('${v.id}', ${v.numero_ticket})">Anular</button>`
            : '<small>Anulada</small>'
          }</td>
        </tr>`
      )
      .join('');
  } catch {
    // Silencioso
  }
}

window.anularTicketUI = async (ventaId, numTicket) => {
  const motivo = prompt(`Motivo de anulación del Ticket #${numTicket}:`, 'Error de cobro');
  if (!motivo) return;
  try {
    await apiFetch('/api/ventas/anular', {
      method: 'POST',
      body: JSON.stringify({ venta_id: ventaId, motivo }),
    });
    showToast(`Ticket #${numTicket} anulado.`);
    await loadVistaAuditoria();
  } catch (err) {
    showToast(err.message, true);
  }
};

/* 7. EVENT LISTENERS E INICIALIZACIÓN */
window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { });
  }

  window.addEventListener('online', () => {
    syncOfflineQueueIfNeeded();
  });

  // Botón desplegar / ocultar barra lateral
  document.getElementById('btn-toggle-sidebar').onclick = () => toggleSidebar();
  document.getElementById('btn-close-sidebar').onclick = () => toggleSidebar(false);
  document.getElementById('sidebar-backdrop').onclick = () => toggleSidebar(false);

  // Selector rápido de perfiles en Login
  const quickSelect = document.getElementById('login-quick-select');
  if (quickSelect) {
    quickSelect.onchange = (e) => {
      const [u, p] = e.target.value.split('|');
      document.getElementById('login-username').value = u;
      document.getElementById('login-pin').value = p;
    };
  }

  // Alternar entre Login y Registro de Nueva Empresa (4.1)
  document.getElementById('btn-show-register-empresa').onclick = () => {
    document.getElementById('form-login').classList.add('hidden');
    document.getElementById('form-register-empresa').classList.remove('hidden');
  };
  document.getElementById('btn-back-to-login').onclick = () => {
    document.getElementById('form-register-empresa').classList.add('hidden');
    document.getElementById('form-login').classList.remove('hidden');
  };

  document.getElementById('form-register-empresa').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/auth/register-empresa', {
        method: 'POST',
        body: JSON.stringify({
          nombre_empresa: document.getElementById('reg-emp-nombre').value,
          telefono: document.getElementById('reg-emp-tel').value,
          nombre_dueno: document.getElementById('reg-dueno-nombre').value,
          email_dueno: document.getElementById('reg-dueno-email').value,
          password_dueno: document.getElementById('reg-dueno-pass').value,
        }),
      });
      e.target.reset();
      document.getElementById('form-register-empresa').classList.add('hidden');
      document.getElementById('form-login').classList.remove('hidden');
      activateSessionData(res, null);
      showToast(`✔ Empresa "${res.empresa.nombre}" creada. Sesión iniciada.`);
      await refreshAll();
      resetWizard();
      resetMovWizard();
      switchView('caja');
    } catch (err) {
      showToast(err.message, true);
    }
  };

  // Inicio de sesión
  const btnToggleLoginPin = document.getElementById('btn-toggle-login-pin');
  if (btnToggleLoginPin) {
    btnToggleLoginPin.onclick = () => {
      const pinInput = document.getElementById('login-pin');
      if (!pinInput) return;
      const isHidden = pinInput.type === 'password';
      pinInput.type = isHidden ? 'text' : 'password';
      btnToggleLoginPin.textContent = isHidden ? '🙈 Ocultar' : '👁 Ver';
    };
  }

  const btnToggleRegPass = document.getElementById('btn-toggle-reg-pass');
  if (btnToggleRegPass) {
    btnToggleRegPass.onclick = () => {
      const regPassInput = document.getElementById('reg-dueno-pass');
      if (!regPassInput) return;
      const isHidden = regPassInput.type === 'password';
      regPassInput.type = isHidden ? 'text' : 'password';
      btnToggleRegPass.textContent = isHidden ? '🙈 Ocultar' : '👁 Ver';
    };
  }

  document.getElementById('form-login').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const pin = document.getElementById('login-pin').value;
    try {
      await performLogin(username, pin);
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('btn-logout').onclick = logoutSession;
  document.getElementById('btn-salir-empresa-soporte').onclick = salirMantenimientoEmpresa;

  // Navegación de empresa activa
  document.querySelectorAll('#main-nav .nav-tab, #sidebar-company-nav .nav-tab').forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  // Navegación interna de Consola Soporte (5.1)
  document.querySelectorAll('#sidebar-soporte-nav .nav-tab').forEach((btn) => {
    btn.onclick = () => switchSoporteSubTab(btn.dataset.soporteTab);
  });

  const inputBuscarEmp = document.getElementById('input-buscar-empresas');
  if (inputBuscarEmp) {
    inputBuscarEmp.oninput = (e) => loadEmpresasSoporte(e.target.value);
  }

  const btnTogglePassVis = document.getElementById('btn-toggle-pass-vis');
  if (btnTogglePassVis) {
    btnTogglePassVis.onclick = () => {
      ['sop-pass-actual', 'sop-pass-nueva', 'sop-pass-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.type = el.type === 'password' ? 'text' : 'password';
      });
    };
  }

  document.getElementById('form-soporte-password').onsubmit = async (e) => {
    e.preventDefault();
    const actual = document.getElementById('sop-pass-actual').value;
    const nueva = document.getElementById('sop-pass-nueva').value;
    const confirm = document.getElementById('sop-pass-confirm').value;
    if (nueva !== confirm) {
      return showToast('La nueva contraseña y su confirmación no coinciden.', true);
    }
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ password_actual: actual, password_nueva: nueva }),
      });
      e.target.reset();
      showToast('✔ Contraseña actualizada correctamente.');
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('form-nuevo-soporte-user').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/auth/soporte/usuarios', {
        method: 'POST',
        body: JSON.stringify({
          nombre: document.getElementById('sop-usr-nombre').value,
          email: document.getElementById('sop-usr-email').value,
          telefono: document.getElementById('sop-usr-tel').value,
          password: document.getElementById('sop-usr-pass').value,
        }),
      });
      e.target.reset();
      showToast('✔ Usuario de Soporte creado.');
      await loadUsuariosSoporte();
    } catch (err) {
      showToast(err.message, true);
    }
  };

  // Controles del Wizard de Cobro
  document.getElementById('btn-wizard-back').onclick = () => {
    if (state.wizard.step > 1) goToStep(state.wizard.step - 1);
  };
  document.getElementById('btn-wizard-reset').onclick = resetWizard;

  document.querySelectorAll('.num-key').forEach((btn) => {
    btn.onclick = () => handleNumpadKey(btn.dataset.key);
  });

  document.getElementById('btn-step2-next').onclick = validateStep2AndAdvance;
  document.getElementById('btn-step3-next').onclick = validateStep3AndAdvance;
  document.getElementById('btn-step4-next').onclick = validateStep4AndAdvance;
  document.getElementById('btn-confirmar-venta-final').onclick = confirmarVentaFinal;

  // Controles del Wizard de Entrada / Salida
  document.getElementById('btn-mov-back').onclick = () => {
    if (state.movWizard.step > 1) goToMovStep(state.movWizard.step - 1);
  };
  document.getElementById('btn-mov-reset').onclick = resetMovWizard;

  document.querySelectorAll('#grid-mov-tipo .touch-btn').forEach((btn) => {
    btn.onclick = () => {
      const tipoElegido = btn.dataset.tipo;
      document.querySelectorAll('#grid-mov-tipo .touch-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.movWizard.tipo = tipoElegido;
      goToMovStep(3);
    };
  });

  document.getElementById('btn-mov-step3-next').onclick = () => {
    const custom = document.getElementById('input-mov-custom-dest').value.trim();
    if (!custom && !state.movWizard.destinatario) {
      return showToast('Seleccione o escriba quién retira o entrega el dinero.', true);
    }
    if (custom) state.movWizard.destinatario = custom;
    goToMovStep(4);
  };

  document.getElementById('btn-confirmar-movimiento').onclick = confirmarMovimientoEfectivo;

  // Botón único "Iniciar turno" ↔ "Cerrar turno"
  document.getElementById('btn-accion-turno').onclick = async () => {
    try {
      if (!state.turnoActivo) {
        await apiFetch('/api/turnos/abrir', {
          method: 'POST',
          body: JSON.stringify({
            puesto_caja: 'CAJA-01',
            fondo_inicial: Number(document.getElementById('input-fondo-inicial').value || 0),
            abierto_en_dispositivo: new Date().toISOString(),
          }),
        });
        showToast('✔ Turno iniciado.');
        await refreshAll();
      } else {
        try {
          await apiFetch('/api/turnos/iniciar-cierre', {
            method: 'POST',
            body: JSON.stringify({ turno_id: state.turnoActivo.id }),
          });
          await refreshAll();
        } catch (err) {
          if (String(err.message).includes('404') || String(err.message).includes('Ruta no encontrada')) {
            state.turnosEnArqueo = [state.turnoActivo];
            state.turnoActivo = null;
            renderEstadoCajaView();
          } else {
            throw err;
          }
        }
        showToast('Turno finalizado. Complete el cierre de caja.');
      }
    } catch (err) {
      showToast(err.message, true);
    }
  };

  // Confirmar Cierre de Caja
  document.getElementById('form-arqueo-ciego').onsubmit = async (e) => {
    e.preventDefault();
    const turnoParaArqueo = (state.turnosEnArqueo && state.turnosEnArqueo[0]) || state.turnoActivo;
    if (!turnoParaArqueo) return showToast('No hay un cierre de turno pendiente.', true);

    try {
      const res = await apiFetch('/api/turnos/cerrar-arqueo', {
        method: 'POST',
        body: JSON.stringify({
          turno_id: turnoParaArqueo.id,
          declarado_efectivo: Number(document.getElementById('arq-efectivo').value || 0),
          declarado_debito: Number(document.getElementById('arq-debito').value || 0),
          declarado_credito: Number(document.getElementById('arq-credito').value || 0),
          declarado_qr: Number(document.getElementById('arq-qr').value || 0),
          declarado_cuenta_corriente: Number(document.getElementById('arq-fiado').value || 0),
        }),
      });
      const box = document.getElementById('resultado-arqueo-box');
      box.classList.remove('hidden');
      if (res.esperado_efectivo !== undefined) {
        box.innerHTML = `<strong>Resultado de Cierre:</strong> ${res.estado_cuadre} | Dif. Efectivo: $${res.diferencia_efectivo} | Dif. Total: $${res.diferencia_total}`;
      } else {
        box.innerHTML = `<strong>✔ Cierre de caja registrado correctamente.</strong>`;
      }
      e.target.reset();
      showToast('✔ Cierre de caja completado.');
      await refreshAll();
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('btn-sup-abrir-cajon').onclick = async () => {
    try {
      await apiFetch('/api/auditoria/apertura-cajon', {
        method: 'POST',
        body: JSON.stringify({ terminal: 'CAJA-01', motivo: 'Apertura autorizada por Supervisor' }),
      });
      showToast('Apertura de cajón registrada.');
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('filtro-empleado').onchange = loadDashboardVivo;
  document.getElementById('filtro-rubro').onchange = loadDashboardVivo;
  document.getElementById('btn-limpiar-filtros').onclick = () => {
    document.getElementById('filtro-empleado').value = '';
    document.getElementById('filtro-rubro').value = '';
    loadDashboardVivo();
  };

  const triggerExport = async (formato) => {
    try {
      const res = await fetch(`/api/analitica/exportar?formato=${formato}`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (formato === 'pdf') {
        window.open(url, '_blank');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = `reporte_caja_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('btn-export-excel').onclick = () => triggerExport('excel');
  document.getElementById('btn-export-pdf').onclick = () => triggerExport('pdf');

  document.getElementById('form-nuevo-rubro').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const nombre = document.getElementById('input-nuevo-rubro').value;
      await apiFetch('/api/catalogos/rubros', {
        method: 'POST',
        body: JSON.stringify({ nombre }),
      });
      showToast(`Rubro "${nombre}" agregado.`);
      e.target.reset();
      await refreshAll();
    } catch (err) {
      showToast(err.message, true);
    }
  };

  const formClienteFiado = document.getElementById('form-nuevo-cliente-fiado');
  if (formClienteFiado) {
    formClienteFiado.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await apiFetch('/api/catalogos/clientes-fiado', {
          method: 'POST',
          body: JSON.stringify({
            nombre: document.getElementById('input-cli-nombre').value,
            documento_telefono: document.getElementById('input-cli-tel').value,
            limite_credito: Number(document.getElementById('input-cli-limite').value || 0),
          }),
        });
        showToast('Cliente de Cuenta Corriente agregado.');
        e.target.reset();
        await refreshAll();
      } catch (err) {
        showToast(err.message, true);
      }
    };
  }

  const filtroAuditoria = document.getElementById('filtro-auditoria-accion');
  if (filtroAuditoria) {
    filtroAuditoria.onchange = () => loadVistaAuditoria();
  }

  const btnHotBackup = document.getElementById('btn-ejecutar-hot-backup');
  if (btnHotBackup) {
    btnHotBackup.onclick = async () => {
      try {
        await apiFetch('/api/v1/sistema/backups/ejecutar', { method: 'POST' });
        showToast('Hot Backup SQLite ejecutado y verificado con SHA-256.');
        await loadStorageAndBackupsSoporte();
      } catch (err) {
        showToast(err.message, true);
      }
    };
  }

  const btnExportManifest = document.getElementById('btn-exportar-storage-manifest');
  if (btnExportManifest) {
    btnExportManifest.onclick = async () => {
      try {
        const res = await apiFetch('/api/v1/sistema/storage/backup');
        const manifest = res.data?.manifest || res.manifest || {};
        showToast(`Manifiesto exportado (${manifest.total_archivos || 0} archivos).`);
      } catch (err) {
        showToast(err.message, true);
      }
    };
  }

  document.getElementById('form-nuevo-empleado').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/catalogos/empleados', {
        method: 'POST',
        body: JSON.stringify({
          nombre: document.getElementById('input-emp-nombre').value,
          username: document.getElementById('input-emp-user').value,
          pin: document.getElementById('input-emp-pin').value,
          rol: document.getElementById('select-emp-rol').value,
        }),
      });
      showToast('Usuario agregado.');
      e.target.reset();
      await refreshAll();
    } catch (err) {
      showToast(err.message, true);
    }
  };

  window.addEventListener('keydown', (e) => {
    const posActive = document.getElementById('view-pos').classList.contains('active');
    if (!posActive || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    if (e.key === 'Escape') {
      if (state.wizard.step > 1) goToStep(state.wizard.step - 1);
      return;
    }

    if (state.wizard.step === 2) {
      if (/^[0-9]$/.test(e.key)) {
        handleNumpadKey(e.key);
      } else if (e.key === 'Backspace') {
        handleNumpadKey('C');
      } else if (e.key === 'Enter') {
        validateStep2AndAdvance();
      }
    } else if (state.wizard.step === 5 && e.key === 'Enter') {
      confirmarVentaFinal();
    }
  });

  if (window.location.protocol !== 'file:' && !window.location.hostname.endsWith('.vercel.app')) {
    try {
      const evtSource = new EventSource('/api/analitica/stream');
      evtSource.onmessage = () => {
        if ((state.usuario?.rol === 'DUENO' || state.usuario?.rol === 'SOPORTE') && state.activeView === 'dashboard') {
          loadDashboardVivo();
        }
        if (state.usuario?.rol === 'SUPERVISOR' && state.activeView === 'supervisor') {
          loadVistaSupervisor();
        }
      };
    } catch {
      // Silencioso
    }
  }

  // Restaurar sesión iniciada automáticamente al volver a abrir o recargar la aplicación
  const savedSessionRaw = localStorage.getItem('caja_session');
  if (savedSessionRaw) {
    let savedSession = null;
    try {
      savedSession = JSON.parse(savedSessionRaw);
    } catch {
      localStorage.removeItem('caja_session');
    }

    if (savedSession && savedSession.usuario && (savedSession.token || savedSession.access_token)) {
      const restoredView = savedSession.activeView || 'caja';
      const restoredSubTab = savedSession.soporteSubTab || 'empresas';
      activateSessionData(
        savedSession,
        savedSession.activeMaintenanceCompanyId !== undefined
          ? savedSession.activeMaintenanceCompanyId
          : savedSession.usuario.empresa_id || null
      );

      if (isSoporte() && !isInCompany()) {
        switchView('soporte');
        switchSoporteSubTab(restoredSubTab);
      } else {
        try {
          await refreshAll();
        } catch {
          // Mantener la sesión activa aunque falle temporalmente la carga inicial
        }
        resetWizard();
        resetMovWizard();
        switchView(restoredView);
      }
    }
  }
});
