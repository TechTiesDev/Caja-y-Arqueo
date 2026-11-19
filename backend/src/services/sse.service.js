const clients = new Set();

function subscribeClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() })}\n\n`);
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
