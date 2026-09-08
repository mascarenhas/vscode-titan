// Linux process-group cleanup for the experimental native profiling harness.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitForGroupExit(pid, milliseconds, pollMs) {
  const deadline = performance.now() + milliseconds;
  while (signalGroup(pid, 0)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(pollMs, remaining));
  }
  return true;
}

export async function terminateProcessGroup(pid, {
  termMs = 10_000, killMs = 10_000, pollMs = 25,
} = {}) {
  assert(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'invalid child process group');
  for (const value of [termMs, killMs, pollMs]) assert(Number.isFinite(value) && value > 0);
  // A detached child's PID remains the process-group ID after its leader exits.
  if (!signalGroup(pid, 'SIGTERM') || await waitForGroupExit(pid, termMs, pollMs)) {
    return { pid, stopped: true, escalated: false };
  }
  if (!signalGroup(pid, 'SIGKILL') || await waitForGroupExit(pid, killMs, pollMs)) {
    return { pid, stopped: true, escalated: true };
  }
  throw new Error(`profile process group ${pid} still exists after bounded SIGTERM/SIGKILL cleanup`);
}
