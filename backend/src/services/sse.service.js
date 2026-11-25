const clients = new Set();

function subscribeClient(res) {
  const isServerless = Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      (process.env.DB_PATH && process.env.DB_PATH.includes('tmp'))
  );

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: isServerless ? 'close' : 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(
    `retry: 60000\ndata: ${JSON.stringify({
      type: 'CONNECTED',
      serverless: isServerless,
      timestamp: new Date().toISOString(),
    })}\n\n`
  );

  // En entornos Serverless (Vercel), cerrar inmediatamente para no bloquear la instancia Lambda
  // ni forzar el balanceador a crear contenedores paralelos con bases /tmp aisladas
  if (isServerless) {
    return res.end();
  }

  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

function broadcastEvent(type, payload = {}) {
  const message = `data: ${JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    payload,
  })}\n\n`;
  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = { subscribeClient, broadcastEvent };
