const os = require('node:os');
const path = require('node:path');

// En Vercel el sistema de archivos es de solo lectura salvo /tmp
if (!process.env.DB_PATH) {
  process.env.DB_PATH = path.join(os.tmpdir(), 'caja_arqueo.sqlite');
}

const { handleRequest } = require('../backend/src/server');

module.exports = async (req, res) => {
  return handleRequest(req, res);
};
