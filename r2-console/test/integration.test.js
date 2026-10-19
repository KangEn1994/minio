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
    const versionedName = `r2-versioned-${crypto.randomBytes(5).toString('hex')}`;
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
      result = await api('GET', '/api/admin/access-keys/capabilities');
      assert.equal(result.response.status, 200);
      if (process.env.MINIO_ADMIN_HELPER_BIN) {
        assert.equal(result.data.available, true);
        const createKey = { bucket: name, prefix: 'photos/', permissions: ['list', 'read'],
          expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), name: 'isolated-qa' };
        result = await api('POST', '/api/admin/access-keys', createKey);
        assert.equal(result.response.status, 400); // Explicit typed-bucket gate.
        result = await api('POST', '/api/admin/access-keys', { ...createKey, confirmBucket: name });
        assert.equal(result.response.status, 201);
        const scopedKey = result.data.account.accessKey;
        const scoped = new S3Client({ endpoint: process.env.MINIO_TEST_ENDPOINT,
          accessKey: scopedKey, secretKey: result.data.secretKey });
        assert.deepEqual(Buffer.from(await (await scoped.getObject(name, 'photos/hello.txt')).arrayBuffer()), small);
        await assert.rejects(scoped.putObject(name, 'photos/blocked.txt', Buffer.from('no')),
          err => err.status === 403);
        result = await api('GET', '/api/admin/access-keys');
        assert.ok(result.data.accounts.some(account => account.accessKey === scopedKey));
        result = await api('DELETE', `/api/admin/access-keys/${encodeURIComponent(scopedKey)}`,
          { confirmAccessKey: 'wrong' });
        assert.equal(result.response.status, 400);
        result = await api('DELETE', `/api/admin/access-keys/${encodeURIComponent(scopedKey)}`,
          { confirmAccessKey: scopedKey });
        assert.equal(result.response.status, 200);
        await assert.rejects(scoped.getObject(name, 'photos/hello.txt'), err => err.status === 403);
      } else assert.equal(result.data.available, false);
      result = await api('GET', `/api/buckets/${name}/objects?prefix=`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.deepEqual(result.data.prefixes, ['photos/']);
      result = await api('GET', `/api/buckets/${name}/objects?prefix=photos%2F`);
      assert.ok(result.data.objects.some(object => object.key === 'photos/hello.txt'));
      result = await api('GET', `/api/buckets/${name}/stats`);
      assert.equal(result.response.status, 200);
      assert.equal(result.data.objects, 2); // Folder marker and file are both real keys.
      assert.equal(result.data.bytes, small.length);
      assert.equal(result.data.exact, true);
      result = await api('GET', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}?metadata=1`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.size, small.length);
      result = await api('GET', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}`);
      assert.equal(result.response.status, 200);
      assert.deepEqual(Buffer.from(result.data), small);
      result = await api('POST', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}/copy`,
        { destinationKey: 'photos/copied.txt' });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.size, small.length);
      assert.deepEqual(Buffer.from(await (await s3.getObject(name, 'photos/copied.txt')).arrayBuffer()), small);
      result = await api('PATCH', `/api/buckets/${name}/objects/${encodeURIComponent('photos/copied.txt')}/metadata`,
        { patch: { contentType: 'text/plain', cacheControl: 'max-age=120',
          customMetadata: { label: 'qa-copy' } } });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.cacheControl, 'max-age=120');
      assert.equal(result.data.metadata.label, 'qa-copy');
      assert.deepEqual(Buffer.from(await (await s3.getObject(name, 'photos/copied.txt')).arrayBuffer()), small);
      result = await api('POST', `/api/buckets/${name}/objects/${encodeURIComponent('photos/hello.txt')}/share`,
        { method: 'GET', expiresSeconds: 300 });
      assert.equal(result.response.status, 200);
      const signedGet = result.data.url;
      assert.deepEqual(Buffer.from(await (await fetch(signedGet)).arrayBuffer()), small);
      assert.equal((await fetch(signedGet.replace('X-Amz-Expires=300', 'X-Amz-Expires=301'))).status, 403);
      result = await api('POST', `/api/buckets/${name}/objects/${encodeURIComponent('photos/signed-put.txt')}/share`,
        { method: 'PUT', expiresSeconds: 300 });
      assert.equal(result.response.status, 200);
      assert.equal((await fetch(result.data.url, { method: 'PUT', body: 'via signed PUT' })).status, 200);
      assert.deepEqual(Buffer.from(await (await s3.getObject(name, 'photos/signed-put.txt')).arrayBuffer()),
        Buffer.from('via signed PUT'));
      const anonymousObject = `${process.env.MINIO_TEST_ENDPOINT}/${name}/photos/hello.txt`;
      const anonymousWrite = `${process.env.MINIO_TEST_ENDPOINT}/${name}/photos/anonymous-write.txt`;
      result = await api('GET', `/api/buckets/${name}/policy`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.policy, null);
      assert.equal((await fetch(anonymousObject)).status, 403);
      const publicRead = { Version: '2012-10-17', Statement: [{ Sid: 'PublicReadOnly',
        Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${name}/*`] }] };
      const publicWrite = { ...publicRead, Statement: [{ ...publicRead.Statement[0], Action: ['s3:PutObject'] }] };
      result = await api('PUT', `/api/buckets/${name}/policy`, { policy: publicWrite, confirmBucket: name });
      assert.equal(result.response.status, 400); // No anonymous-write option, even in custom JSON.
      result = await api('PUT', `/api/buckets/${name}/policy`, { policy: publicRead });
      assert.equal(result.response.status, 400); // Explicit bucket-name gate.
      result = await api('PUT', `/api/buckets/${name}/policy`, { policy: publicRead, confirmBucket: name });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      const savedPolicy = result.data.policy;
      assert.deepEqual(savedPolicy.Statement[0].Principal, { AWS: ['*'] }); // MinIO canonicalizes '*'.
      assert.deepEqual(savedPolicy.Statement[0].Action, ['s3:GetObject']);
      result = await api('GET', `/api/buckets/${name}/policy`);
      assert.deepEqual(result.data.policy, savedPolicy);
      const anonymousRead = await fetch(anonymousObject);
      assert.equal(anonymousRead.status, 200);
      assert.deepEqual(Buffer.from(await anonymousRead.arrayBuffer()), small);
      assert.equal((await fetch(anonymousWrite, { method: 'PUT', body: 'must not write' })).status, 403);
      result = await api('PUT', `/api/buckets/${name}/policy`,
        { policy: { ...publicRead, Version: 'bogus' }, confirmBucket: name });
      assert.equal(result.response.status, 400);
      result = await api('GET', `/api/buckets/${name}/policy`);
      assert.deepEqual(result.data.policy, savedPolicy); // Invalid edit did not overwrite policy.
      result = await api('DELETE', `/api/buckets/${name}/policy`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.policy, null);
      assert.equal((await fetch(anonymousObject)).status, 403);
      assert.equal((await fetch(anonymousWrite, { method: 'PUT', body: 'still denied' })).status, 403);
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
      const staleKey = 'photos/abandoned.bin';
      const staleUploadId = await s3.createMultipart(name, staleKey);
      result = await api('GET', `/api/buckets/${name}/multipart-uploads`);
      assert.equal(result.response.status, 200);
      assert.ok(result.data.uploads.some(upload => upload.key === staleKey && upload.uploadId === staleUploadId));
      result = await api('DELETE', `/api/buckets/${name}/multipart-uploads?${new URLSearchParams({ key: staleKey, uploadId: staleUploadId })}`,
        { confirmUploadId: 'wrong' });
      assert.equal(result.response.status, 400);
      result = await api('DELETE', `/api/buckets/${name}/multipart-uploads?${new URLSearchParams({ key: staleKey, uploadId: staleUploadId })}`,
        { confirmUploadId: staleUploadId });
      assert.equal(result.response.status, 200);
      result = await api('GET', `/api/buckets/${name}/multipart-uploads`);
      assert.ok(!result.data.uploads.some(upload => upload.uploadId === staleUploadId));
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
      result = await api('PUT', `/api/buckets/${name}/lifecycle`,
        { rules: [{ id: 'abort-uploads', status: 'Enabled', prefix: 'incoming/', abortMultipartDays: 7 }] });
      assert.equal(result.response.status, 400);
      result = await api('GET', `/api/buckets/${name}/lifecycle`);
      assert.equal(result.data.rules[0].expirationDays, 30);
      result = await api('PUT', `/api/buckets/${name}/lifecycle`,
        { rules: [{ id: 'expire-date', status: 'Disabled', prefix: 'dated/', expirationDate: '2030-01-01' }] });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      result = await api('GET', `/api/buckets/${name}/lifecycle`);
      assert.equal(result.data.rules[0].expirationDate, '2030-01-01');
      result = await api('GET', `/api/buckets/${name}/cors`);
      assert.equal(result.data.supported, false);
      await s3.createBucket(versionedName);
      await s3.request('PUT', versionedName, '', { query: { versioning: '' },
        body: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
        headers: { 'content-type': 'application/xml' } });
      assert.equal(await s3.getBucketVersioning(versionedName), 'Enabled');
      result = await api('DELETE', `/api/buckets/${versionedName}/empty`);
      assert.equal(result.response.status, 409); // Must not create delete markers and call it empty.
      await s3.deleteBucket(versionedName);
      result = await api('DELETE', `/api/buckets/${name}`);
      assert.equal(result.response.status, 400); // Prevent normalized-key collision.
      result = await api('DELETE', `/api/buckets/${name}?deleteBucket=1`);
      assert.equal(result.response.status, 409); // MinIO rejects nonempty buckets.
      result = await api('DELETE', `/api/buckets/${name}/lifecycle`);
      assert.equal(result.response.status, 200);
      for (let i = 0; i < 115; i++) await s3.putObject(name, `remove/a/${i}.txt`, Buffer.from('x'));
      await s3.putObject(name, 'remove/ab/keep.txt', Buffer.from('sibling'));
      const boundedStats = await s3.getBucketStats(name, 100);
      assert.equal(boundedStats.objects, 100);
      assert.equal(boundedStats.exact, false);
      result = await api('GET', `/api/buckets/${name}/stats`);
      assert.equal(result.response.status, 200);
      assert.equal(result.data.exact, true);
      assert.ok(result.data.objects > 115);
      let pages = 0, removed = 0;
      do {
        result = await api('DELETE', `/api/buckets/${name}/prefix?prefix=remove%2Fa%2F`);
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
        assert.deepEqual(result.data.failed, []);
        pages++; removed += result.data.deleted;
      } while (result.data.hasMore);
      assert.ok(pages > 1);
      assert.equal(removed, 115);
      assert.equal((await s3.getObject(name, 'remove/ab/keep.txt')).status, 200);
      do {
        result = await api('DELETE', `/api/buckets/${name}/empty`);
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
        assert.deepEqual(result.data.failed, []);
      } while (result.data.hasMore);
      result = await api('GET', `/api/buckets/${name}/stats`);
      assert.deepEqual(result.data, { objects: 0, bytes: 0, exact: true, includesVersions: false });
      result = await api('DELETE', `/api/buckets/${name}?deleteBucket=1`);
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      result = await api('POST', '/api/logout');
      assert.equal(result.response.status, 200);
      result = await api('GET', '/api/buckets');
      assert.equal(result.response.status, 401);
    } finally {
      try { await s3.deleteBucket(versionedName); } catch { /* bucket may be gone */ }
      try { await s3.deleteBucketPolicy(name); } catch { /* bucket may be gone */ }
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
