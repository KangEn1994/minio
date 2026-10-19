import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Dockerfile runtime file layout starts and serves the console', { timeout: 15000 }, async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const sourceCopy = dockerfile.split('\n').find(line => /^COPY\s+--chown=node:node\s+package\.json\s/.test(line));
  assert.ok(sourceCopy, 'Dockerfile must copy runtime files');
  const files = sourceCopy.trim().split(/\s+/).slice(2, -1);
  assert.ok(files.includes('package.json'));
  const dir = await mkdtemp(join(tmpdir(), 'minio-console-image-smoke-'));
  let child;
  try {
    for (const file of files) await copyFile(join(root, file), join(dir, file));
    await cp(join(root, 'public'), join(dir, 'public'), { recursive: true });
    const port = await freePort();
    child = spawn(process.execPath, ['server.js'], { cwd: dir,
      env: { PATH: process.env.PATH || '', CONSOLE_PORT: String(port), CONSOLE_HOST: '127.0.0.1',
        MINIO_ENDPOINT: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Packaged console did not start')), 10000);
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('MinIO Storage console listening')) {
          clearTimeout(timeout); resolve();
        }
      });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Packaged console exited ${code}`)); });
      child.on('error', err => { clearTimeout(timeout); reject(err); });
    });
    const session = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, false);
    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /MinIO Storage/);
  } finally {
    if (child) {
      if (child.exitCode === null) {
        child.kill();
        await new Promise(resolve => child.once('close', resolve));
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
