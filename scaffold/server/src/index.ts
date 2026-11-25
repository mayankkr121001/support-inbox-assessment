import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectDb } from './db.js';

async function start(): Promise<void> {
  await connectDb();

  const app = createApp();
  const server = createServer(app);

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
