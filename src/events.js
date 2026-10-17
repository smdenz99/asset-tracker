// Server-sent events: every open browser hears about changes so the register
// stays current for everyone on the team.
const clients = new Set();

export function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  const client = { res, userId: req.user.id };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.res.write(message);
}

export function disconnectUser(userId) {
  for (const client of clients) if (client.userId === userId) client.res.end();
}

export function disconnectAll() {
  for (const client of clients) client.res.end();
}
