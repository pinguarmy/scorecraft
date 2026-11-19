import { spawn } from 'node:child_process';

const children = ['dev:server', 'dev:web'].map(script => spawn(process.execPath, [process.env.npm_execpath, 'run', script], { stdio: 'inherit', env: process.env }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', code => stop(code || 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
