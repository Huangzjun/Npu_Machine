import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const settingsPath = resolve(process.argv[2]);
const root = dirname(settingsPath);
const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
const endpoint = new URL(settings.endpoint);
if (endpoint.protocol !== 'https:') throw new Error('HTTPS endpoint required');

async function transfer({ id, host, token }) {
  try {
    const { stdout } = await execute('/usr/bin/ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'IdentitiesOnly=yes', '-o', 'ClearAllForwardings=yes',
      '-o', 'UserKnownHostsFile=' + JSON.stringify(join(root, 'known_hosts')), '-i', join(root, 'reader-' + id),
      'npu-board-reader@' + host, 'sample',
    ], { timeout: 15000, maxBuffer: 16384 });
    const { ageMs, sample } = JSON.parse(stdout);
    if (!Number.isSafeInteger(ageMs) || ageMs < 0 || ageMs > 75000) throw new Error('stale SSH sample');
    const sampledAt = Date.now() - ageMs;
    if (sample?.cards?.length !== 8) throw new Error('expected eight NPU cards');

    const response = await fetch(new URL('/api/ingest/' + id, endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ ...sample, sampledAt }),
    });
    if (response.status !== 204) throw new Error('upload HTTP ' + response.status);
    if (process.argv.includes('--verbose')) console.log('machine ' + id + ': 8 NPU');
    return true;
  } catch (error) {
    const detail = String(error.stderr || '').trim().split('\n').at(-1);
    const reason = error.cmd ? 'SSH exit ' + error.code + (detail ? ' (' + detail + ')' : '') : error.message;
    console.error('machine ' + id + ': ' + reason);
    return false;
  }
}

const results = await Promise.all(settings.machines.map(transfer));
if (results.some(success => !success)) process.exitCode = 1;
