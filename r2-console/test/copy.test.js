import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { S3Client, S3Error } from '../s3.js';
import { copyObject, replaceObjectMetadata } from '../copy.js';

const copyResult = { xml: { name: 'CopyObjectResult', children: [
  { name: 'ETag', text: '"etag"' }, { name: 'LastModified', text: '2026-10-19T00:00:00Z' }] } };
const stub = head => {
  const calls = [];
  return { calls, request: async (...args) => {
    calls.push(args);
    return args[0] === 'HEAD' ? { response: { headers: new Headers(head) } } : copyResult;
  } };
};

test('copy encodes source exactly and requests COPY metadata and tags', async () => {
  const client = stub();
  const result = await copyObject(client, 'my-bucket', 'dir/a b+你好.txt', 'new/你好 &+.txt');
  assert.equal(result.etag, '"etag"');
  assert.deepEqual(client.calls[0].slice(0, 3), ['PUT', 'my-bucket', 'new/你好 &+.txt']);
  assert.equal(client.calls[0][3].headers['x-amz-copy-source'],
    '/my-bucket/dir/a%20b%2B%E4%BD%A0%E5%A5%BD.txt');
  assert.equal(client.calls[0][3].headers['x-amz-metadata-directive'], 'COPY');
  assert.equal(client.calls[0][3].headers['x-amz-tagging-directive'], 'COPY');
});

test('invalid destination and self-copy fail before any request', async () => {
  const client = stub();
  for (const key of ['', 'bad\nkey', 'x'.repeat(1025), '\uD800',
    'folder/../collided', 'folder/./collided'])
    await assert.rejects(copyObject(client, 'my-bucket', 'source', key), S3Error);
  await assert.rejects(copyObject(client, 'my-bucket', 'same', 'same'),
    e => e.code === 'SelfCopyRequiresReplace');
  assert.equal(client.calls.length, 0);
});

test('metadata REPLACE preserves supported headers and merges all user metadata', async () => {
  const client = stub({ 'content-length': '4', etag: '"old"', 'content-type': 'text/plain',
    'cache-control': 'max-age=60', 'content-disposition': 'inline',
    'content-encoding': 'gzip', 'content-language': 'en',
    expires: 'Wed, 21 Oct 2030 07:28:00 GMT',
    'x-amz-meta-original': 'keep', 'x-amz-meta-change': 'old',
    'x-amz-website-redirect-location': '/redirect' });
  await replaceObjectMetadata(client, 'my-bucket', 'a b/你好', { change: 'new' });
  assert.equal(client.calls.length, 2);
  const h = client.calls[1][3].headers;
  assert.equal(h['x-amz-copy-source'], '/my-bucket/a%20b/%E4%BD%A0%E5%A5%BD');
  assert.equal(h['x-amz-copy-source-if-match'], '"old"');
  assert.equal(h['x-amz-metadata-directive'], 'REPLACE');
  for (const [name, expected] of Object.entries({ 'content-type': 'text/plain',
    'cache-control': 'max-age=60', 'content-disposition': 'inline',
    'content-encoding': 'gzip', 'content-language': 'en',
    expires: 'Wed, 21 Oct 2030 07:28:00 GMT',
    'x-amz-website-redirect-location': '/redirect' }))
    assert.equal(h[name], expected);
  assert.equal(h['x-amz-meta-original'], 'keep');
  assert.equal(h['x-amz-meta-change'], 'new');
});

test('structured patch edits Content-Type and Cache-Control without dropping other metadata', async () => {
  const client = stub({ 'content-length': '4', etag: '"old"',
    'content-type': 'application/octet-stream', 'cache-control': 'max-age=60',
    'content-disposition': 'inline', 'x-amz-meta-original': 'keep' });
  await replaceObjectMetadata(client, 'my-bucket', 'key', {
    customMetadata: { added: 'yes' }, contentType: 'text/plain', cacheControl: 'max-age=300'
  });
  const h = client.calls[1][3].headers;
  assert.equal(h['content-type'], 'text/plain');
  assert.equal(h['cache-control'], 'max-age=300');
  assert.equal(h['content-disposition'], 'inline');
  assert.equal(h['x-amz-meta-original'], 'keep');
  assert.equal(h['x-amz-meta-added'], 'yes');
});

test('unsafe HEAD state and malformed patches fail without PUT', async () => {
  for (const extra of [{ 'x-amz-server-side-encryption': 'AES256' },
    { 'x-amz-tagging-count': '1' }, { 'x-amz-object-lock-mode': 'GOVERNANCE' },
    { 'x-amz-vendor-property': 'unknown' }]) {
    const client = stub({ 'content-length': '1', etag: '"x"',
      'content-type': 'text/plain', ...extra });
    await assert.rejects(replaceObjectMetadata(client, 'my-bucket', 'k', { changed: 'yes' }),
      e => e.code === 'UnsupportedObjectMetadata');
    assert.equal(client.calls.length, 1);
  }
  const client = stub();
  await assert.rejects(replaceObjectMetadata(client, 'my-bucket', 'k', { bad_name: 'x' }),
    e => e.code === 'InvalidMetadataPatch');
  await assert.rejects(replaceObjectMetadata(client, 'my-bucket', 'k', { contentType: '' }),
    e => e.code === 'InvalidMetadataPatch');
  assert.equal(client.calls.length, 0);
});

test('embedded HTTP 200 CopyObject errors are treated as failures', async () => {
  const client = { request: async () => ({ xml: { name: 'Error', children: [
    { name: 'Code', text: 'AccessDenied' }, { name: 'Message', text: 'Denied' }] } }) };
  await assert.rejects(copyObject(client, 'my-bucket', 'a', 'b'),
    e => e.code === 'AccessDenied');
});

test('real MinIO: copy content/metadata, replace metadata, preserve bytes and reject failures',
  { skip: !process.env.MINIO_TEST_ENDPOINT, timeout: 60000 }, async () => {
    const client = new S3Client({ endpoint: process.env.MINIO_TEST_ENDPOINT,
      accessKey: process.env.MINIO_ROOT_USER, secretKey: process.env.MINIO_ROOT_PASSWORD });
    const bucket = `r2-copy-${crypto.randomBytes(5).toString('hex')}`;
    const source = 'folder/ a+你好.txt';
    const dest = 'copy/ 新 file+.txt';
    const body = Buffer.from('copy and metadata roundtrip 你好');
    await client.createBucket(bucket);
    try {
      await client.request('PUT', bucket, source, { body, headers: {
        'content-type': 'text/plain', 'cache-control': 'max-age=120',
        'content-disposition': 'inline', 'content-language': 'en',
        'x-amz-meta-original': 'preserve', 'x-amz-meta-change': 'old' } });
      await copyObject(client, bucket, source, dest);
      let head = (await client.request('HEAD', bucket, dest)).response.headers;
      assert.equal(head.get('x-amz-meta-original'), 'preserve');
      assert.equal(head.get('cache-control'), 'max-age=120');
      assert.deepEqual(Buffer.from(await (await client.getObject(bucket, dest)).arrayBuffer()), body);
      await replaceObjectMetadata(client, bucket, dest, { customMetadata: {
        change: 'new', added: 'yes' }, contentType: 'text/html', cacheControl: 'max-age=300' });
      head = (await client.request('HEAD', bucket, dest)).response.headers;
      for (const [name, expected] of Object.entries({ 'content-type': 'text/html',
        'cache-control': 'max-age=300', 'content-disposition': 'inline',
        'content-language': 'en', 'x-amz-meta-original': 'preserve',
        'x-amz-meta-change': 'new', 'x-amz-meta-added': 'yes' }))
        assert.equal(head.get(name), expected, name);
      assert.deepEqual(Buffer.from(await (await client.getObject(bucket, dest)).arrayBuffer()), body);
      await assert.rejects(copyObject(client, bucket, source, source),
        e => e.code === 'SelfCopyRequiresReplace');
      await assert.rejects(copyObject(client, bucket, 'not-there', 'failed-copy'), S3Error);
      await assert.rejects(client.request('HEAD', bucket, 'failed-copy'), S3Error);
    } finally {
      for (const key of [source, dest, 'failed-copy'])
        try { await client.deleteObject(bucket, key); } catch { /* preserve original failure */ }
      await client.deleteBucket(bucket);
    }
  });
