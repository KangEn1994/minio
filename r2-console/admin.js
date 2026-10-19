import { spawn } from 'node:child_process';
import path from 'node:path';

export class AdminError extends Error {
  constructor(message, status = 502, code = 'AdminUnavailable') {
    super(message); this.status = status; this.code = code;
  }
}

// The official madmin SDK requires a prebuilt, operator-configured helper.
// Credentials are sent only through its stdin, never argv, environment or logs.
export async function runAdminHelper(binary, request) {
  if (!binary || !path.isAbsolute(binary))
    throw new AdminError('MinIO access-key management is not configured', 501);
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 64 * 1024)
    throw new AdminError('Admin request too large', 413, 'RequestTooLarge');
  return new Promise((resolve, reject) => {
    let done = false, output = Buffer.alloc(0);
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AdminError('MinIO admin request timed out'));
    }, 20000);
    child.on('error', () => finish(new AdminError('MinIO admin helper could not start')));
    child.stdout.on('data', chunk => {
      if (done) return;
      if (output.length + chunk.length > 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new AdminError('MinIO admin response too large'));
      } else output = Buffer.concat([output, chunk]);
    });
    child.on('close', code => {
      if (done) return;
      if (code !== 0) return finish(new AdminError('MinIO admin helper failed'));
      let result;
      try { result = JSON.parse(output.toString('utf8')); }
      catch { return finish(new AdminError('MinIO admin helper returned invalid data')); }
      if (!result || typeof result.ok !== 'boolean')
        return finish(new AdminError('MinIO admin helper returned invalid data'));
      if (!result.ok) return finish(new AdminError(result.error || 'MinIO admin action unavailable',
        403, 'AdminDenied'));
      finish(null, result);
    });
    child.stdin.on('error', () => { /* close/error handlers report the failure. */ });
    child.stdin.end(input);
  });
}
