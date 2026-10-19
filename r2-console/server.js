import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { S3Client, S3Error, validateBucketName } from './s3.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const endpoint = process.env.MINIO_ENDPOINT || 'http://127.0.0.1:9000';
const region = process.env.MINIO_REGION || 'us-east-1';
const host = process.env.CONSOLE_HOST || '127.0.0.1';
const port = Number(process.env.CONSOLE_PORT || 9090);
const publicOrigin = process.env.CONSOLE_PUBLIC_ORIGIN || '';
if (publicOrigin && new URL(publicOrigin).pathname !== '/') throw new Error('CONSOLE_PUBLIC_ORIGIN must be an origin');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONSOLE_PORT');
if (host !== '127.0.0.1' && host !== '::1' && !publicOrigin) {
  throw new Error('Set CONSOLE_PUBLIC_ORIGIN before binding a public interface');
}
if (publicOrigin && !publicOrigin.startsWith('https://') &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(publicOrigin)) {
  throw new Error('Public console origin must use HTTPS');
}
const secureCookie = publicOrigin.startsWith('https://');
const sessions = new Map();
const attempts = new Map();
const sessionDuration = 8 * 60 * 60 * 1000;
const maxJson = 128 * 1024;
const maxObject = 16 * 1024 * 1024;
const cookieName = 'minio_r2_session';

class HttpError extends Error {
  constructor(status, message, code = 'BadRequest') { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const json = (res, status, data, extra = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra });
  res.end(body);
};
function cookie(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split(/=(.*)/s).slice(0, 2)))[cookieName];
}
function session(req) {
  const id = cookie(req);
  const found = id ? sessions.get(id) : null;
  if (!found) return null;
  if (found.expires < Date.now()) { sessions.delete(id); return null; }
  found.expires = Date.now() + sessionDuration;
  return found;
}
function setSessionCookie(res, id, maxAge) {
  res.setHeader('set-cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`);
}
function originCheck(req) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = publicOrigin || `http://${req.headers.host}`;
  if (origin !== expected) fail(403, 'Cross-origin request blocked', 'CrossOrigin');
}
function csrfCheck(req, active) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return;
  const supplied = req.headers['x-csrf-token'];
  if (typeof supplied !== 'string' || supplied.length !== active.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(active.csrf))) {
    fail(403, 'Invalid CSRF token', 'InvalidCSRF');
  }
}
async function readBody(req, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, 'Request body too large', 'RequestTooLarge');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Expected JSON body');
  try { return JSON.parse((await readBody(req, maxJson)).toString('utf8')); }
  catch (err) { if (err instanceof HttpError) throw err; fail(400, 'Invalid JSON'); }
}
function requireBucket(name) { if (!validateBucketName(name)) fail(400, 'Invalid bucket name'); }
function requireKey(key) { if (!key || key.includes('\0') || Buffer.byteLength(key) > 1024) fail(400, 'Invalid object key'); }
function requireUploadId(uploadId) {
  if (!uploadId || uploadId.length > 1024 || /[\x00-\x1f]/.test(uploadId)) fail(400, 'Invalid upload ID');
}
function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 1000) fail(400, 'Expected up to 1000 lifecycle rules');
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id || rule.id.length > 255 || ids.has(rule.id) ||
        !['Enabled', 'Disabled'].includes(rule.status) || typeof rule.prefix !== 'string' ||
        !Number.isInteger(rule.expirationDays) || rule.expirationDays < 1 || rule.expirationDays > 36500) {
      fail(400, 'Invalid lifecycle rule');
    }
    ids.add(rule.id);
  }
}
function endpointInfo() { return { endpoint, region, cors: false }; }

async function routeApi(req, res, url) {
  originCheck(req);
  const method = req.method;
  const route = url.pathname;
  if (route === '/api/session' && method === 'GET') {
    const active = session(req);
    return json(res, 200, { authenticated: !!active, accessKey: active?.accessKey || null,
      ...(active ? endpointInfo() : {}) });
  }
  if (route === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || '';
    const previous = attempts.get(ip) || { count: 0, until: 0, updatedAt: Date.now() };
    if (previous.until > Date.now()) fail(429, 'Too many login attempts; retry later', 'RateLimited');
    const input = await readJson(req);
    if (!input || typeof input.accessKey !== 'string' || !input.accessKey ||
        typeof input.secretKey !== 'string' || !input.secretKey ||
        input.accessKey.length > 256 || input.secretKey.length > 512) fail(400, 'Invalid credentials');
    const s3 = new S3Client({ endpoint, region, accessKey: input.accessKey, secretKey: input.secretKey });
    try { await s3.listBuckets(); }
    catch (err) {
      previous.count += 1;
      if (previous.count >= 5) { previous.until = Date.now() + 60000; previous.count = 0; }
      previous.updatedAt = Date.now();
      attempts.set(ip, previous);
      if (err instanceof S3Error && (err.status === 403 || err.status === 401))
        fail(401, 'Invalid credentials or insufficient ListBuckets permission', 'LoginFailed');
      throw err;
    }
    attempts.delete(ip);
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { accessKey: input.accessKey, secretKey: input.secretKey, csrf,
      expires: Date.now() + sessionDuration });
    setSessionCookie(res, id, sessionDuration / 1000);
    return json(res, 200, { authenticated: true, accessKey: input.accessKey, csrf });
  }
  const active = session(req);
  if (!active) fail(401, 'Sign in required', 'Unauthorized');
  csrfCheck(req, active);
  if (route === '/api/csrf' && method === 'GET') return json(res, 200, { token: active.csrf });
  if (route === '/api/logout' && method === 'POST') {
    sessions.delete(cookie(req)); setSessionCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  const s3 = new S3Client({ endpoint, region, accessKey: active.accessKey, secretKey: active.secretKey });
  if (route === '/api/buckets' && method === 'GET') return json(res, 200, { buckets: await s3.listBuckets() });
  if (route === '/api/buckets' && method === 'POST') {
    const input = await readJson(req); requireBucket(input?.name);
    await s3.createBucket(input.name); return json(res, 201, { name: input.name });
  }
  const match = route.match(/^\/api\/buckets\/([^/]+)(?:\/(.*))?$/);
  if (!match) fail(404, 'Unknown API route', 'NotFound');
  let bucket;
  try { bucket = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid bucket path'); }
  requireBucket(bucket);
  const sub = match[2] || '';
  if (!sub && method === 'DELETE') {
    if (url.searchParams.get('deleteBucket') !== '1') fail(400, 'Bucket deletion marker required');
    await s3.deleteBucket(bucket); return json(res, 200, { ok: true });
  }
  if (sub === 'objects' && method === 'GET') {
    const prefix = url.searchParams.get('prefix') || '';
    const token = url.searchParams.get('continuation') || '';
    if (Buffer.byteLength(prefix) > 1024 || token.length > 4096) fail(400, 'Invalid listing parameters');
    return json(res, 200, await s3.listObjects(bucket, prefix, token));
  }
  if (sub === 'folders' && method === 'POST') {
    const input = await readJson(req);
    const prefix = input?.prefix;
    if (typeof prefix !== 'string' || !prefix.endsWith('/')) fail(400, 'Folder prefix must end in /');
    requireKey(prefix);
    await s3.putObject(bucket, prefix, Buffer.alloc(0));
    return json(res, 201, { prefix });
  }
  if (sub === 'lifecycle') {
    if (method === 'GET') return json(res, 200, { rules: await s3.getLifecycle(bucket) });
    if (method === 'PUT') {
      const input = await readJson(req); validateRules(input?.rules);
      await s3.putLifecycle(bucket, input.rules);
      return json(res, 200, { rules: await s3.getLifecycle(bucket) });
    }
    if (method === 'DELETE') { await s3.deleteLifecycle(bucket); return json(res, 200, { rules: [] }); }
  }
  if (sub === 'cors') {
    if (method === 'GET') return json(res, 200, { supported: false,
      message: 'MinIO Community Edition does not support per-bucket CORS through S3.' });
    fail(501, 'Per-bucket CORS is unsupported by MinIO Community Edition', 'NotImplemented');
  }
  const objectMatch = sub.match(/^objects\/(.+)$/);
  if (objectMatch) {
    let key;
    try { key = decodeURIComponent(objectMatch[1]); } catch { fail(400, 'Invalid object path'); }
    requireKey(key);
    if (url.searchParams.has('metadata') && method === 'GET')
      return json(res, 200, await s3.headObject(bucket, key));
    if (method === 'GET') {
      const upstream = await s3.getObject(bucket, key);
      const baseName = key.split('/').at(-1) || 'object';
      const safeName = baseName.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'content-disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(baseName)}`,
        'content-length': upstream.headers.get('content-length') || undefined,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return Readable.fromWeb(upstream.body).pipe(res);
    }
    if (method === 'PUT') {
      const body = await readBody(req, maxObject);
      await s3.putObject(bucket, key, body, req.headers['content-type'] || 'application/octet-stream');
      return json(res, 201, { key, size: body.length });
    }
    if (method === 'DELETE') { await s3.deleteObject(bucket, key); return json(res, 200, { ok: true }); }
  }
  const multipart = sub.match(/^multipart\/(.+?)(?:\/parts\/([1-9][0-9]*))?(?:\/(complete))?$/);
  if (multipart) {
    let key;
    try { key = decodeURIComponent(multipart[1]); } catch { fail(400, 'Invalid object path'); }
    requireKey(key);
    const uploadId = url.searchParams.get('uploadId');
    if (!multipart[2] && !multipart[3] && method === 'POST')
      return json(res, 201, { uploadId: await s3.createMultipart(bucket, key) });
    requireUploadId(uploadId);
    if (!multipart[2] && !multipart[3] && method === 'DELETE') {
      await s3.abortMultipart(bucket, key, uploadId); return json(res, 200, { ok: true });
    }
    if (multipart[2] && method === 'PUT') {
      const partNumber = Number(multipart[2]);
      if (partNumber < 1 || partNumber > 10000) fail(400, 'Invalid part number');
      const body = await readBody(req, maxObject);
      if (body.length < 5 * 1024 * 1024 && req.headers['x-last-part'] !== 'true')
        fail(400, 'Only the last multipart part may be under 5 MiB');
      return json(res, 200, { etag: await s3.uploadPart(bucket, key, uploadId, partNumber, body) });
    }
    if (multipart[3] && method === 'POST') {
      const input = await readJson(req);
      if (!Array.isArray(input?.parts) || input.parts.length < 1 || input.parts.length > 10000 ||
        input.parts.some((p, i) => !Number.isInteger(p.partNumber) || p.partNumber !== i + 1 ||
          typeof p.etag !== 'string' || !/^"?[a-fA-F0-9]{32}(?:-[0-9]+)?"?$/.test(p.etag))) {
        fail(400, 'Invalid multipart completion list');
      }
      await s3.completeMultipart(bucket, key, uploadId, input.parts);
      return json(res, 200, { ok: true });
    }
  }
  fail(404, 'Unknown API route', 'NotFound');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch { fail(400, 'Invalid path'); }
  if (relative === '/') relative = '/index.html';
  if (relative.includes('\0') || relative.split('/').includes('..') || relative.startsWith('/.')) fail(404, 'Not found');
  const file = path.resolve(publicDir, '.' + relative);
  if (!file.startsWith(publicDir + path.sep)) fail(404, 'Not found');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  let body;
  try { body = await fs.readFile(file); } catch { fail(404, 'Not found'); }
  res.writeHead(200, { 'content-type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8',
    'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await routeApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    if (res.headersSent) { res.destroy(err); return; }
    const status = err instanceof HttpError || err instanceof S3Error ? err.status : 500;
    if (status >= 500) console.error(err);
    json(res, status, { error: err.code || 'InternalError',
      message: status >= 500 ? 'Storage service temporarily unavailable' : err.message });
  }
});
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, active] of sessions) if (active.expires < now) sessions.delete(id);
  for (const [ip, attempt] of attempts) if (attempt.updatedAt < now - 60000) attempts.delete(ip);
}, 60000).unref();
server.listen(port, host, () => console.log(`MinIO Storage console listening on http://${host}:${port}`));

export { server, cleanup };
