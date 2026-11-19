import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 4381);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 到 65535 的整数。');
const { app, engine, close } = await createApp({ root });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`ScoreCraft 本机服务：http://127.0.0.1:${port}`);
  void engine.health().then((health) => console.log(`Audiveris：${health.available ? '可用' : '不可用'} ${health.version ?? ''} ${health.detail ?? ''}`));
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.on('error', (error) => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    close();
    server.close(() => { process.exitCode = 0; });
    // Recognition subprocess is killed with its own bounded timeout. Immediate exit
    // would orphan a JVM, so let the active recognition finish before process exits.
    server.closeIdleConnections();
  });
}
