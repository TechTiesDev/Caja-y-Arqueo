const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Carga ligera de variables desde .env si existe
const envPath = path.join(__dirname, '..', '..', '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const JWT_SECRET =
  process.env.JWT_SECRET_KEY || process.env.JWT_SECRET || 'caja-arqueo-multitenant-secret-2026';

function hashPin(pin) {
  const salt = 'caja-salt-v1';
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function verifyPin(pin, hash) {
  if (!pin || !hash) return false;
  const computed = hashPin(pin);
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

function signToken(payload, expiresInSeconds = 43200, type = 'access') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      sub: payload.sub || payload.id,
      empresa_id: payload.empresa_id !== undefined ? payload.empresa_id : null,
      type,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function issueSessionTokens(user, empresaNombre = null) {
  const baseClaims = {
    id: user.id,
    sub: user.id,
    nombre: user.nombre,
    username: user.username,
    email: user.email || null,
    rol: user.rol,
    empresa_id: user.empresa_id !== undefined ? user.empresa_id : null,
    empresa_nombre: empresaNombre,
  };
  const accessToken = signToken(baseClaims, 43200, 'access');
  const refreshToken = signToken(baseClaims, 604800, 'refresh');
  return {
    token: accessToken,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  if (signature !== expectedSig) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { hashPin, verifyPin, signToken, issueSessionTokens, verifyToken };
