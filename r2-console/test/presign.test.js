import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { presignObject } from '../presign.js';
import { S3Client } from '../s3.js';

const options = { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1',
  accessKey: 'example', secretKey: 'secret', bucket: 'test-bucket',
  key: 'photos/hello world/你好!.txt', method: 'GET', expiresSeconds: 600 };

test('creates a SigV4 query URL with precisely encoded key and required fields', () => {
  const signed = presignObject(options);
  const url = new URL(signed);
  assert.equal(url.pathname, '/test-bucket/photos/hello%20world/%E4%BD%A0%E5%A5%BD%21.txt');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(url.searchParams.get('X-Amz-Credential'), /^example\/\d{8}\/us-east-1\/s3\/aws4_request$/);
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  assert.ok(!signed.includes('secret'));
  assert.equal(presignObject({ ...options, method: 'PUT' }).includes('X-Amz-Signature='), true);
});

test('rejects unsafe endpoint, path, method and expiry values', () => {
  for (const endpoint of ['ftp://example.com', 'https://example.com/path',
    'https://example.com?x=1', 'https://user:pass@example.com', 'https://example.com/#x']) {
    assert.throws(() => presignObject({ ...options, endpoint }), /endpoint/);
  }
  for (const key of ['', 'a/../b', './b', 'a/./b', 'a\0b', 'a'.repeat(1025)])
    assert.throws(() => presignObject({ ...options, key }), /key/);
  for (const bucket of ['ab', 'A-bucket', 'a/b', 'abc.def'])
    assert.throws(() => presignObject({ ...options, bucket }), /bucket/);
  assert.ok(presignObject({ ...options, bucket: 'abc--def' }));
  for (const method of ['DELETE', 'get', 'POST'])
    assert.throws(() => presignObject({ ...options, method }), /Method/);
  for (const expiresSeconds of [0, 59, 3601, 60.5, '600'])
    assert.throws(() => presignObject({ ...options, expiresSeconds }), /Expiration/);
});

test('real MinIO: signed GET and PUT grant only the intended access',
  { skip: !process.env.MINIO_TEST_ENDPOINT, timeout: 30000 }, async () => {
    const endpoint = process.env.MINIO_TEST_ENDPOINT;
    const accessKey = process.env.MINIO_ROOT_USER;
    const secretKey = process.env.MINIO_ROOT_PASSWORD;
    assert.ok(accessKey && secretKey, 'MINIO_ROOT_USER and MINIO_ROOT_PASSWORD required');
    const s3 = new S3Client({ endpoint, accessKey, secretKey });
    const bucket = `r2-presign-${crypto.randomBytes(6).toString('hex')}`;
    const getKey = 'folder/spaces 你好.txt';
    const putKey = 'folder/direct upload.txt';
    const original = Buffer.from('signed MinIO GET: 你好');
    const uploaded = Buffer.from('signed MinIO PUT: こんにちは');
    let created = false;
    try {
      await s3.createBucket(bucket); created = true;
      await s3.putObject(bucket, getKey, original);
      const base = { endpoint, region: 'us-east-1', accessKey, secretKey, bucket, expiresSeconds: 60 };
      const getUrl = presignObject({ ...base, key: getKey, method: 'GET' });
      const unsignedUrl = `${new URL(endpoint).origin}/${bucket}/folder/spaces%20%E4%BD%A0%E5%A5%BD.txt`;
      assert.equal((await fetch(unsignedUrl)).status, 403);
      const got = await fetch(getUrl);
      assert.equal(got.status, 200);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), original);
      assert.equal((await fetch(getUrl, { method: 'PUT', body: 'wrong method' })).status, 403);
      const tampered = new URL(getUrl);
      tampered.searchParams.set('X-Amz-Expires', '61');
      assert.equal((await fetch(tampered)).status, 403);
      const putUrl = presignObject({ ...base, key: putKey, method: 'PUT' });
      assert.equal((await fetch(putUrl, { method: 'PUT', body: uploaded })).status, 200);
      const read = await s3.getObject(bucket, putKey);
      assert.deepEqual(Buffer.from(await read.arrayBuffer()), uploaded);
    } finally {
      if (created) {
        await Promise.allSettled([s3.deleteObject(bucket, getKey), s3.deleteObject(bucket, putKey)]);
        await s3.deleteBucket(bucket);
      }
    }
  });
