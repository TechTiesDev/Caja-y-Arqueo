const fs = require('node:fs');
const path = require('node:path');

const envPaths = [
  path.join(__dirname, '..', '..', '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];

for (const envPath of envPaths) {
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
}

const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret:
    process.env.JWT_SECRET_KEY || process.env.JWT_SECRET || 'caja-arqueo-multitenant-secret-2026',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'caja_arqueo.sqlite'),
  storageQuotaMb: Number(process.env.STORAGE_QUOTA_MB || 1024),
  initialSoporteEmail: (process.env.INITIAL_SOPORTE_EMAIL || 'soporte@cajayarqueo.com')
    .trim()
    .toLowerCase(),
  initialSoportePassword: process.env.INITIAL_SOPORTE_PASSWORD || '9999',
};

module.exports = { config };
