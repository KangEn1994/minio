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
  let bucketPolicy = null;
  let versioned = false;
  const objects = new Set(['safe/a/one.txt', 'safe/a/two.txt', 'safe/ab/keep.txt']);
  const mock = http.createServer(async (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const target = new URL(req.url, 'http://mock');
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
    if (req.url === '/qa-bucket?policy=') {
      if (req.method === 'GET') {
        if (!bucketPolicy) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          return res.end('<Error><Code>NoSuchBucketPolicy</Code><Message>No policy</Message></Error>');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(bucketPolicy));
      }
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        bucketPolicy = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200); return res.end();
      }
      if (req.method === 'DELETE') {
        bucketPolicy = null;
        res.writeHead(204); return res.end();
      }
    }
    if (target.pathname === '/qa-bucket' && req.method === 'GET' && target.searchParams.has('versioning')) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<VersioningConfiguration>${versioned ? '<Status>Enabled</Status>' : ''}</VersioningConfiguration>`);
    }
    if (target.pathname === '/qa-bucket' && req.method === 'GET' && target.searchParams.has('uploads')) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<ListMultipartUploadsResult><Upload><Key>stale.txt</Key><UploadId>upload-1</UploadId><Initiated>2026-01-01T00:00:00Z</Initiated></Upload><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>');
    }
    if (target.pathname === '/qa-bucket' && req.method === 'GET' &&
        target.searchParams.has('list-type') && !target.searchParams.has('delimiter')) {
      const prefix = target.searchParams.get('prefix') || '';
      const limit = Number(target.searchParams.get('max-keys') || '1000');
      const matched = [...objects].filter((key) => key.startsWith(prefix)).sort();
      const page = matched.slice(0, limit);
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<ListBucketResult>${page.map((key) => `<Contents><Key>${key}</Key><Size>4</Size></Contents>`).join('')}<IsTruncated>${matched.length > limit}</IsTruncated>${matched.length > limit ? '<NextContinuationToken>next</NextContinuationToken>' : ''}</ListBucketResult>`);
    }
    if (req.method === 'GET' && req.url?.startsWith('/qa-bucket?')) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<ListBucketResult><Contents><Key> leading .txt </Key><Size>4</Size></Contents><Contents><Key>你好.txt</Key><Size>4</Size></Contents></ListBucketResult>');
    }
    if (req.method === 'GET' && req.url === '/qa-bucket/%E4%BD%A0%E5%A5%BD.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 4 });
      return res.end('data');
    }
    if (req.method === 'HEAD' && target.pathname.startsWith('/qa-bucket/')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 4, etag: '"mock-etag"' });
      return res.end();
    }
    if (req.method === 'PUT' && target.pathname.startsWith('/qa-bucket/') && req.headers['x-amz-copy-source']) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<CopyObjectResult><ETag>"mock-etag"</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></CopyObjectResult>');
    }
    if (req.method === 'DELETE' && target.pathname === '/qa-bucket/stale.txt' && target.searchParams.get('uploadId') === 'upload-1') {
      res.writeHead(204); return res.end();
    }
    if (req.method === 'DELETE' && target.pathname.startsWith('/qa-bucket/')) {
      objects.delete(decodeURIComponent(target.pathname.slice('/qa-bucket/'.length)));
      res.writeHead(204); return res.end();
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
  delete process.env.MINIO_ADMIN_HELPER_BIN;
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
      assert.equal((await api('GET', '/api/buckets/qa-bucket/policy')).status, 401);
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
    await t.test('policy changes require confirmation and reject broad anonymous access', async () => {
      const route = '/api/buckets/qa-bucket/policy';
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
      const publicRead = { Version: '2012-10-17', Statement: [{ Effect: 'Allow',
        Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::qa-bucket/*'] }] };
      const put = (policy, confirmBucket = 'qa-bucket') => api('PUT', route,
        JSON.stringify({ policy, confirmBucket }), headers);
      const putCount = () => hits.filter((hit) => hit === 'PUT /qa-bucket?policy=').length;
      assert.equal((await api('GET', route)).status, 200);
      assert.equal(bucketPolicy, null);
      const before = putCount();
      assert.equal((await api('PUT', route, JSON.stringify({ policy: publicRead }), headers)).status, 400);
      assert.equal((await put(publicRead, 'other-bucket')).status, 400);
      assert.equal((await put({ ...publicRead, Version: 'bogus' })).status, 400);
      assert.equal((await api('PUT', route, '{bad json', headers)).status, 400);
      for (const [principal, action] of [
        ['*', 's3:PutObject'], [{ AWS: ['*'] }, 's3:DeleteObject'], ['*', 's3:*'],
        ['*', 's3:ListBucket'], ['*', 's3:Get*']
      ]) {
        const unsafe = { ...publicRead, Statement: [{ ...publicRead.Statement[0], Principal: principal, Action: [action] }] };
        assert.equal((await put(unsafe)).status, 400, action);
      }
      assert.equal(putCount(), before);
      assert.equal(bucketPolicy, null);
      assert.equal((await put(publicRead)).status, 200);
      assert.deepEqual(bucketPolicy, publicRead);
      assert.deepEqual((await (await api('GET', route)).json()).policy, publicRead);
      const saved = JSON.stringify(bucketPolicy);
      assert.equal((await put({ ...publicRead, Version: 'bogus' })).status, 400);
      assert.equal(JSON.stringify(bucketPolicy), saved);
      assert.equal((await api('DELETE', route, undefined, { 'x-csrf-token': csrf })).status, 200);
      assert.equal(bucketPolicy, null);
    });
    await t.test('share links enforce method, expiry, CSRF and safe keys', async () => {
      const route = '/api/buckets/qa-bucket/objects/source.txt/share';
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
      const post = (path, input, h = headers) => api('POST', path, JSON.stringify(input), h);
      const before = hits.length;
      assert.equal((await post(route, { method: 'PUT', expiresSeconds: 60 },
        { 'content-type': 'application/json' })).status, 403);
      for (const input of [{ method: 'DELETE', expiresSeconds: 60 }, { method: 'PUT', expiresSeconds: 59 },
        { method: 'GET', expiresSeconds: 3601 }, { method: 'PUT', expiresSeconds: '600' }])
        assert.equal((await post(route, input)).status, 400);
      assert.equal((await post('/api/buckets/qa-bucket/objects/a%2F..%2Fb/share',
        { method: 'PUT', expiresSeconds: 60 })).status, 400);
      assert.equal(hits.length, before);
      const res = await post(route, { method: 'PUT', expiresSeconds: 60 });
      assert.equal(res.status, 200);
      const data = await res.json();
      const signed = new URL(data.url);
      assert.equal(signed.searchParams.get('X-Amz-Expires'), '60');
      assert.match(signed.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
      assert.ok(!data.url.includes('unit-secret'));
    });
    await t.test('copy and metadata editing reject unsafe inputs before mutation', async () => {
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
      const copy = (destinationKey) => api('POST', '/api/buckets/qa-bucket/objects/source.txt/copy',
        JSON.stringify({ destinationKey }), headers);
      const patch = (value) => api('PATCH', '/api/buckets/qa-bucket/objects/source.txt/metadata',
        JSON.stringify({ patch: { customMetadata: { note: value } } }), headers);
      const countPuts = () => hits.filter((hit) => hit.startsWith('PUT /qa-bucket/')).length;
      const before = countPuts();
      assert.equal((await copy('../outside.txt')).status, 400);
      assert.equal((await copy('source.txt')).status, 400);
      assert.equal((await patch('bad\nvalue')).status, 400);
      assert.equal((await patch('你好')).status, 400);
      assert.equal(countPuts(), before);
      assert.equal((await copy('copied.txt')).status, 201);
      assert.equal((await patch('safe value')).status, 200);
      assert.equal(countPuts(), before + 2);
    });
    await t.test('multipart abort is gated and pagination is bounded', async () => {
      const route = '/api/buckets/qa-bucket/multipart-uploads';
      const listed = await api('GET', route);
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json()).uploads.map((item) => item.uploadId), ['upload-1']);
      const before = hits.length;
      assert.equal((await api('GET', `${route}?uploadIdMarker=${'x'.repeat(1025)}`)).status, 400);
      const target = `${route}?key=stale.txt&uploadId=upload-1`;
      assert.equal((await api('DELETE', target, JSON.stringify({ confirmUploadId: 'upload-1' }),
        { 'content-type': 'application/json' })).status, 403);
      assert.equal((await api('DELETE', target, JSON.stringify({ confirmUploadId: 'wrong' }),
        { 'content-type': 'application/json', 'x-csrf-token': csrf })).status, 400);
      assert.equal(hits.length, before);
      assert.equal((await api('DELETE', target, JSON.stringify({ confirmUploadId: 'upload-1' }),
        { 'content-type': 'application/json', 'x-csrf-token': csrf })).status, 200);
      assert.ok(hits.includes('DELETE /qa-bucket/stale.txt?uploadId=upload-1'));
    });
    await t.test('unconfigured service-account helper cannot create credentials', async () => {
      const cap = await api('GET', '/api/admin/access-keys/capabilities');
      assert.equal(cap.status, 200);
      assert.equal((await cap.json()).available, false);
      assert.equal((await api('GET', '/api/admin/access-keys')).status, 501);
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
      const baseInput = { bucket: 'qa-bucket', confirmBucket: 'qa-bucket', prefix: 'team/',
        permissions: ['read'], expiresAt: new Date(Date.now() + 86400000).toISOString() };
      const create = (input) => api('POST', '/api/admin/access-keys', JSON.stringify(input), headers);
      assert.equal((await create({ ...baseInput, prefix: 'team/../' })).status, 400);
      assert.equal((await create({ ...baseInput, prefix: 'team/\n/' })).status, 400);
      assert.equal((await create({ ...baseInput, permissions: ['admin'] })).status, 400);
      assert.equal((await create({ ...baseInput, confirmBucket: 'other-bucket' })).status, 400);
      assert.equal((await create(baseInput)).status, 501);
    });
    await t.test('bounded stats and prefix deletion preserve adjacent keys', async () => {
      const client = new S3Client({ endpoint: `http://127.0.0.1:${mockPort}`,
        accessKey: 'unit-access', secretKey: 'unit-secret' });
      assert.deepEqual(await client.getBucketStats('qa-bucket', 2),
        { objects: 2, bytes: 8, exact: false, includesVersions: false });
      assert.deepEqual(await (await api('GET', '/api/buckets/qa-bucket/stats')).json(),
        { objects: 3, bytes: 12, exact: true, includesVersions: false });
      const headers = { 'x-csrf-token': csrf };
      const before = hits.filter((hit) => hit.startsWith('DELETE /qa-bucket/')).length;
      assert.equal((await api('DELETE', '/api/buckets/qa-bucket/prefix?prefix=safe%2Fa', undefined, headers)).status, 400);
      assert.equal(hits.filter((hit) => hit.startsWith('DELETE /qa-bucket/')).length, before);
      versioned = true;
      assert.equal((await api('DELETE', '/api/buckets/qa-bucket/prefix?prefix=safe%2Fa%2F', undefined, headers)).status, 409);
      assert.equal(objects.size, 3);
      versioned = false;
      const removed = await api('DELETE', '/api/buckets/qa-bucket/prefix?prefix=safe%2Fa%2F', undefined, headers);
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).deleted, 2);
      assert.deepEqual([...objects], ['safe/ab/keep.txt']);
      const emptied = await api('DELETE', '/api/buckets/qa-bucket/empty', undefined, headers);
      assert.equal(emptied.status, 200);
      assert.equal((await emptied.json()).deleted, 1);
      assert.equal(objects.size, 0);
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
