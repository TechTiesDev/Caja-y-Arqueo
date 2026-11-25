const STORAGE_KEY = 'caja_session';

function loadInitialState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { user: null, accessToken: null, refreshToken: null, activeMaintenanceCompanyId: null };
    const parsed = JSON.parse(raw);
    return {
      user: parsed.usuario || parsed.user || null,
      accessToken: parsed.access_token || parsed.token || parsed.accessToken || null,
      refreshToken: parsed.refresh_token || parsed.refreshToken || null,
      activeMaintenanceCompanyId: parsed.activeMaintenanceCompanyId || null,
    };
  } catch {
    return { user: null, accessToken: null, refreshToken: null, activeMaintenanceCompanyId: null };
  }
}

let state = loadInitialState();
const listeners = new Set();

export const authStore = {
  getState() {
    const isSoporte = state.user?.rol === 'SOPORTE';
    const isInCompany = !isSoporte
      ? Boolean(state.user?.empresa_id)
      : Boolean(state.user?.empresa_id && state.activeMaintenanceCompanyId);
    return {
      ...state,
      isAuthenticated: Boolean(state.user && state.accessToken),
      isSoporte,
      isInCompany,
    };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
