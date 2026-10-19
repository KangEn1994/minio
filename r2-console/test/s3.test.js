import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { S3Client, S3Error, validateBucketName } from '../s3.js';
import { parseXml, value, xmlEscape } from '../xml.js';

test('bucket names reject invalid and accept R2-style names', () => {
  for (const name of ['abc', 'my-bucket', 'bucket1']) assert.ok(validateBucketName(name));
  for (const name of ['ABCD', 'ab', '-bad', 'bad-', 'bad.name', 'bad--name', '../x'])
    assert.ok(!validateBucketName(name), name);
});

test('XML parsing decodes S3 values and rejects entity declarations', () => {
  const parsed = parseXml('<Result><Key>a&amp;b&lt;c</Key></Result>');
  assert.equal(value(parsed, 'Key'), 'a&b<c');
  assert.equal(value(parseXml('<Result><Key> leading and trailing </Key></Result>'), 'Key'), ' leading and trailing ');
  assert.equal(xmlEscape('a&<"'), 'a&amp;&lt;&quot;');
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'));
});

test('signed request canonicalizes path, query and headers', async () => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization,
      hash: req.headers['x-amz-content-sha256'] };
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end('<ListBucketResult><Contents><Key>dir/a&amp;b.txt</Key><Size>13</Size></Contents><CommonPrefixes><Prefix>dir/sub/</Prefix></CommonPrefixes><NextContinuationToken>abc</NextContinuationToken></ListBucketResult>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new S3Client({ endpoint: `http://127.0.0.1:${server.address().port}`,
      accessKey: 'key', secretKey: 'secret' });
    const list = await client.listObjects('bucket', 'dir/', 'next+token');
    assert.equal(list.objects[0].key, 'dir/a&b.txt');
    assert.equal(list.prefixes[0], 'dir/sub/');
    assert.equal(list.nextContinuationToken, 'abc');
    assert.match(seen.url, /^\/bucket\?continuation-token=next%2Btoken&delimiter=%2F/);
    assert.match(seen.authorization, /^AWS4-HMAC-SHA256 Credential=key\//);
    assert.equal(seen.hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  } finally { server.close(); }
});

test('S3 XML errors preserve code and status', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new S3Client({ endpoint: `http://127.0.0.1:${server.address().port}`,
      accessKey: 'key', secretKey: 'secret' });
    await assert.rejects(client.listBuckets(), err => err instanceof S3Error &&
      err.status === 403 && err.code === 'AccessDenied' && err.message === 'Denied');
  } finally { server.close(); }
});

test('signed object request preserves dot path segments', async () => {
  let seen;
  const server = http.createServer((req, res) => { seen = req.url; res.writeHead(200); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new S3Client({ endpoint: `http://127.0.0.1:${server.address().port}`,
      accessKey: 'key', secretKey: 'secret' });
    await client.putObject('bucket', 'a/../b', Buffer.from('test'));
    assert.equal(seen, '/bucket/a/../b');
  } finally { server.close(); }
});
