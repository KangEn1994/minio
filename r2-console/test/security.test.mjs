import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { S3Client, S3Error } from '../s3.js';

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const close = (server) => new Promise((resolve) => server.close(resolve));

test('console rejects unauthorized, cross-origin, oversized and forged requests', async (t) => {
  const hits = [];
  let mockPort;
  const mock = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${mockPort}/target` });
      return res.end();
    }
    if (req.url === '/target') return res.end('redirect followed');
    if (req.url === '/' && req.headers.authorization?.includes('Credential=outage-access/')) {
      res.writeHead(502, { 'content-type': 'application/xml' });
      return res.end('<Error><Code>ConnectionFailed</Code><Message>internal-storage.example:9000 unavailable</Message></Error>');
    }
    if (!req.headers.authorization?.includes('Credential=unit-access/')) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      return res.end('<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>');
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<ListAllMyBucketsResult><Buckets><Bucket><Name>qa-bucket</Name></Bucket></Buckets></ListAllMyBucketsResult>');
    }
    if (req.method === 'GET' && req.url?.startsWith('/qa-bucket?')) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<ListBucketResult><Contents><Key> leading .txt </Key><Size>4</Size></Contents><Contents><Key>你好.txt</Key><Size>4</Size></Contents></ListBucketResult>');
    }
    if (req.method === 'GET' && req.url === '/qa-bucket/%E4%BD%A0%E5%A5%BD.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 4 });
      return res.end('data');
    }
    if (req.method === 'PUT' && req.url === '/qa-bucket') {
      res.writeHead(200); return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/xml' });
    res.end('<Error><Code>NoSuchKey</Code><Message>Missing</Message></Error>');
  });
  mockPort = await listen(mock);
  const socket = http.createServer();
  const consolePort = await listen(socket);
  await close(socket);
  process.env.MINIO_ENDPOINT = `http://127.0.0.1:${mockPort}`;
  process.env.CONSOLE_PORT = String(consolePort);
  process.env.CONSOLE_HOST = '127.0.0.1';
  const { server: consoleServer, cleanup } = await import('../server.js');
  if (!consoleServer.listening) await once(consoleServer, 'listening');
  const base = `http://127.0.0.1:${consolePort}`;
  let cookie = '', csrf = '';
  const api = (method, route, body, headers = {}) => fetch(base + route, {
    method, headers: { ...(cookie ? { cookie } : {}), ...headers }, body
  });
  try {
    await t.test('unauthenticated requests do not reach MinIO or reveal its endpoint', async () => {
      const before = hits.length;
      const session = await api('GET', '/api/session');
      assert.equal(session.status, 200);
      assert.equal((await session.json()).endpoint, undefined);
      assert.equal((await api('GET', '/api/buckets')).status, 401);
      assert.equal((await api('POST', '/api/buckets', '{}', { 'content-type': 'application/json' })).status, 401);
      assert.equal((await api('DELETE', '/api/buckets/qa-bucket')).status, 401);
      assert.equal(hits.length, before);
    });
    await t.test('cross-origin login is blocked', async () => {
      const res = await api('POST', '/api/login', JSON.stringify({ accessKey: 'unit-access', secretKey: 'unit-secret' }),
        { 'content-type': 'application/json', origin: 'https://other.example' });
      assert.equal(res.status, 403);
    });
    await t.test('upstream outage details do not leak during unauthenticated login', async () => {
      const res = await api('POST', '/api/login', JSON.stringify({ accessKey: 'outage-access', secretKey: 'unit-secret' }),
        { 'content-type': 'application/json' });
      assert.equal(res.status, 502);
      const body = await res.text();
      assert.ok(!body.includes('internal-storage.example'));
      assert.match(body, /Storage service temporarily unavailable/);
    });
    await t.test('valid login establishes a session', async () => {
      const res = await api('POST', '/api/login', JSON.stringify({ accessKey: 'unit-access', secretKey: 'unit-secret' }),
        { 'content-type': 'application/json' });
      assert.equal(res.status, 200);
      cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
      assert.match(cookie, /^minio_r2_session=/);
      csrf = (await res.json()).csrf;
      assert.ok(csrf);
    });
    await t.test('mutations require correct CSRF token and origin', async () => {
      const body = JSON.stringify({ name: 'qa-bucket' });
      const before = hits.length;
      assert.equal((await api('POST', '/api/buckets', body, { 'content-type': 'application/json' })).status, 403);
      assert.equal((await api('POST', '/api/buckets', body,
        { 'content-type': 'application/json', 'x-csrf-token': 'wrong' })).status, 403);
      assert.equal((await api('POST', '/api/buckets', body,
        { 'content-type': 'application/json', 'x-csrf-token': csrf, origin: 'https://other.example' })).status, 403);
      assert.equal(hits.length, before);
      assert.equal((await api('POST', '/api/buckets', body,
        { 'content-type': 'application/json', 'x-csrf-token': csrf })).status, 201);
    });
    await t.test('JSON request cap is enforced', async () => {
      const huge = JSON.stringify({ name: 'qa-bucket', padding: 'x'.repeat(128 * 1024) });
      const res = await api('POST', '/api/buckets', huge,
        { 'content-type': 'application/json', 'x-csrf-token': csrf });
      assert.equal(res.status, 413);
    });
    await t.test('single-object upload cap is enforced before S3 write', async () => {
      const before = hits.length;
      const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
      const res = await api('PUT', '/api/buckets/qa-bucket/objects/oversized.bin', oversized,
        { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf });
      assert.equal(res.status, 413);
      assert.equal(hits.length, before);
    });
    await t.test('listed key whitespace and Unicode download survive intact', async () => {
      const listed = await api('GET', '/api/buckets/qa-bucket/objects');
      assert.equal(listed.status, 200);
      const data = await listed.json();
      assert.deepEqual(data.objects.map((item) => item.key), [' leading .txt ', '你好.txt']);
      const download = await api('GET', `/api/buckets/qa-bucket/objects/${encodeURIComponent('你好.txt')}`);
      assert.equal(download.status, 200);
      assert.equal(await download.text(), 'data');
      assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''%E4%BD%A0%E5%A5%BD\.txt/);
    });
    await t.test('signed S3 client never follows upstream redirects', async () => {
      const client = new S3Client({ endpoint: `http://127.0.0.1:${mockPort}`,
        accessKey: 'unit-access', secretKey: 'unit-secret' });
      await assert.rejects(client.request('GET', 'redirect'),
        (error) => error instanceof S3Error && error.status === 302);
      assert.ok(!hits.includes('GET /target'));
    });
  } finally {
    cleanup[Symbol.dispose]?.();
    await close(consoleServer);
    await close(mock);
  }
});
