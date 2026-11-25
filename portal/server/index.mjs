import { buildApp } from './app.mjs';

const server = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}

await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' });