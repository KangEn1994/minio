import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { S3Client } from '../s3.js';

test('real MinIO: console auth, bucket, objects, multipart, lifecycle and cleanup',
  { skip: !process.env.MINIO_TEST_ENDPOINT, timeout: 120000 }, async () => {
    process.env.MINIO_ENDPOINT = process.env.MINIO_TEST_ENDPOINT;
    process.env.CONSOLE_PORT = '19190';
    const { server, cleanup } = await import('../server.js');
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:19190';
    let cookie = '', csrf = '';
    async function api(method, pathname, body, type = 'application/json', extraHeaders = {}) {
      const headers = { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': type } : {}), ...extraHeaders };
      const response = await fetch(base + pathname, { method, headers,
        body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
      const text = await response.text();
      const data = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
      return { response, data };
    }
    const name = `r2-qa-${crypto.randomBytes(5).toString('hex')}`;
    const s3 = new S3Client({ endpoint: process.env.MINIO_TEST_ENDPOINT,
      accessKey: process.env.MINIO_ROOT_USER, secretKey: process.env.MINIO_ROOT_PASSWORD });
    try {
      let result = await api('GET', '/api/buckets');
      assert.equal(result.response.status, 401);
      result = await api('GET', '/api/session');
      assert.equal(result.data.authenticated, false);
      assert.equal(result.data.endpoint, undefined);
      result = await api('POST', '/api/login', { accessKey: process.env.MINIO_ROOT_USER,
        secretKey: process.env.MINIO_ROOT_PASSWORD });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      cookie = result.response.headers.get('set-cookie').split(';')[0];
      csrf = result.data.csrf;
      result = await api('POST', '/api/buckets', { name });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      assert.ok((await s3.listBuckets()).some(bucket => bucket.name === name));
      result = await api('POST', `/api/buckets/${name}/folders`, { prefix: 'photos/' });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      const small = Buffer.from('MinIO storage round trip: 你好');
      result = await api('PUT', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}`,
        small, 'text/plain');
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      result = await api('GET', `/api/buckets/${name}/objects?prefix=`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.deepEqual(result.data.prefixes, ['photos/']);
      result = await api('GET', `/api/buckets/${name}/objects?prefix=photos%2F`);
      assert.ok(result.data.objects.some(object => object.key === 'photos/hello.txt'));
      result = await api('GET', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}?metadata=1`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.size, small.length);
      result = await api('GET', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}`);
      assert.equal(result.response.status, 200);
      assert.deepEqual(Buffer.from(result.data), small);
      for (const specialKey of ['photos/ leading and trailing .txt', 'photos/你好.txt']) {
        const bytes = Buffer.from(`special object ${specialKey}`);
        result = await api('PUT', `/api/buckets/${name}/objects/${encodeURIComponent(specialKey)}`,
          bytes, 'text/plain');
        assert.equal(result.response.status, 201, JSON.stringify(result.data));
        result = await api('GET', `/api/buckets/${name}/objects/${encodeURIComponent(specialKey)}`);
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
        assert.deepEqual(Buffer.from(result.data), bytes);
      }
      // MinIO itself rejects dot-segment keys; ensure we do not normalize them
      // into another key and write unintended data.
      result = await api('PUT', `/api/buckets/${name}/objects/${encodeURIComponent('photos/../dot.txt')}`,
        Buffer.from('must not write'), 'text/plain');
      assert.equal(result.response.status, 400);
      result = await api('GET', `/api/buckets/${name}/objects?prefix=photos%2F`);
      assert.ok(result.data.objects.some(object => object.key === 'photos/ leading and trailing .txt'));
      assert.ok(!result.data.objects.some(object => object.key === 'photos/../dot.txt'));
      const large = crypto.randomBytes(17 * 1024 * 1024 + 7);
      const key = 'photos/large.bin';
      result = await api('POST', `/api/buckets/${name}/multipart/${encodeURIComponent(key)}`);
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      const uploadId = result.data.uploadId;
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const chunk = large.subarray(i * 8 * 1024 * 1024, Math.min(large.length, (i + 1) * 8 * 1024 * 1024));
        result = await api('PUT', `/api/buckets/${name}/multipart/${encodeURIComponent(key)}/parts/${i + 1}?uploadId=${encodeURIComponent(uploadId)}`,
          chunk, 'application/octet-stream', i === 2 ? { 'x-last-part': 'true' } : {});
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
        parts.push({ partNumber: i + 1, etag: result.data.etag });
      }
      result = await api('POST', `/api/buckets/${name}/multipart/${encodeURIComponent(key)}/complete?uploadId=${encodeURIComponent(uploadId)}`, { parts });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      const downloaded = await s3.getObject(name, key);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), large);
      result = await api('PUT', `/api/buckets/${name}/lifecycle`,
        { rules: [{ id: 'expire-temp', status: 'Enabled', prefix: 'temporary/', expirationDays: 30 }] });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      result = await api('GET', `/api/buckets/${name}/lifecycle`);
      assert.equal(result.data.rules[0].expirationDays, 30);
      result = await api('GET', `/api/buckets/${name}/cors`);
      assert.equal(result.data.supported, false);
      result = await api('DELETE', `/api/buckets/${name}`);
      assert.equal(result.response.status, 400); // Prevent normalized-key collision.
      result = await api('DELETE', `/api/buckets/${name}?deleteBucket=1`);
      assert.equal(result.response.status, 409); // MinIO rejects nonempty buckets.
      result = await api('DELETE', `/api/buckets/${name}/lifecycle`);
      assert.equal(result.response.status, 200);
      for (const objectKey of [key, 'photos/hello.txt', 'photos/ leading and trailing .txt',
        'photos/你好.txt', 'photos/']) {
        result = await api('DELETE', `/api/buckets/${name}/objects/${encodeURIComponent(objectKey)}`);
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
      }
      result = await api('DELETE', `/api/buckets/${name}?deleteBucket=1`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      result = await api('POST', '/api/logout');
      assert.equal(result.response.status, 200);
      result = await api('GET', '/api/buckets');
      assert.equal(result.response.status, 401);
    } finally {
      try { await s3.deleteLifecycle(name); } catch { /* bucket may be gone */ }
      try {
        const list = await s3.listObjects(name);
        for (const object of list.objects) await s3.deleteObject(name, object.key);
        await s3.deleteBucket(name);
      } catch { /* already cleaned up */ }
      cleanup[Symbol.dispose]?.();
      await new Promise(resolve => server.close(resolve));
    }
  });
