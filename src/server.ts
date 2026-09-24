import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const { httpServer, io } = createApp(config);

httpServer.listen(config.port, '0.0.0.0', () => {
  console.log(`Bomb-It-Server listening on port ${config.port}`);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  io.close(() => { process.exitCode = 0; });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
