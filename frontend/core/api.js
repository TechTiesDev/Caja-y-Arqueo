import { authStore } from './authStore.js';

const API_BASE = '/api/v1';

export class ApiClientError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest(endpoint, { method = 'GET', body = null, skipAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const state = authStore.getState();

  if (!skipAuth && state.accessToken) {
    headers['Authorization'] = `Bearer ${state.accessToken}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    const errObj = payload.error || {};
    throw new ApiClientError(
      res.status,
      errObj.code || 'API_ERROR',
      errObj.message || payload.error || 'Error en la comunicación con el servidor.',
      errObj.details || null
    );
  }

  return payload.data !== undefined ? payload.data : payload;
}
