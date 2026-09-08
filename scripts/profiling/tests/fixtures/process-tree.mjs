// Fake writers only: no Titan or C compiler is involved in lifecycle tests.
import { spawn } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, pidFile, behavior = 'term'] = process.argv.slice(2);
if (mode === 'worker') {
  if (behavior === 'ignore') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => process.exit(0));
  const heartbeat = process.env.PROFILE_TEST_CACHE;
  const tick = () => { if (heartbeat) writeFileSync(path.join(heartbeat, 'worker-alive'), String(Date.now())); };
  tick(); setInterval(tick, 10);
  process.send({ ready: true });
} else {
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', pidFile, behavior], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: process.env,
  });
  if (behavior === 'ignore') process.on('SIGTERM', () => {});
  worker.once('message', () => {
    writeFileSync(pidFile, JSON.stringify({ leader: process.pid, worker: worker.pid }));
    if (mode === 'exited') process.exit(23);
    // The open mode keeps an LSP read pending to exercise signal interruption.
    if (mode !== 'open') closeSync(1);
    setInterval(() => {}, 1000);
  });
}
