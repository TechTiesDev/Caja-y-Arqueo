const { getDb } = require('./core/database');
const { ModuleRegistry } = require('./core/module-registry');
const { tenancyModule } = require('./modules/tenancy/tenancy.module');
const { authModule } = require('./modules/auth/auth.module');
const { auditModule } = require('./modules/audit/audit.module');
const { storageModule } = require('./modules/storage/storage.module');
const { cajaArqueoModule } = require('./modules/caja-arqueo/caja-arqueo.module');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('Payload excede el límite de 2MB.'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Cuerpo JSON malformado.'));
      }
    });
    req.on('error', reject);
  });
}

function createModularApp({ db = null, extraModules = [] } = {}) {
  const registry = new ModuleRegistry({
    dbGetter: () => db || getDb(),
  });

  // Registro de los 4 Módulos Transversales del Core Blueprint
  registry.register(tenancyModule);
  registry.register(authModule);
  registry.register(auditModule);
  registry.register(storageModule);

  // Registro del Módulo de Dominio Caja y Arqueo
  registry.register(cajaArqueoModule);

  // Registro de Módulos de Dominio adicionales enchufables
  for (const mod of extraModules) {
    if (!registry.modules.has(mod.name)) {
      registry.register(mod);
    }
  }

  async function handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      return sendJson(res, 200, { ok: true });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      return sendJson(res, 200, {
        ok: true,
        data: {
          status: 'healthy',
          architecture: 'Core Blueprint Modular Multi-Tenant',
          domain: 'Caja y Arqueo (Sin Stock)',
          modules: registry.listModules(),
          timestamp: new Date().toISOString(),
        },
      });
    }

    return registry.dispatch(req, res, readJsonBody, sendJson);
  }

  return {
    registry,
    handleRequest,
  };
}

module.exports = { createModularApp };
