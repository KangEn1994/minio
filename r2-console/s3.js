import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { child, children, parseXml, value, xmlEscape } from './xml.js';

const sha256 = input => crypto.createHash('sha256').update(input).digest('hex');
const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest();
const encode = text => encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = key => key.split('/').map(encode).join('/');
const array = node => node?.children || [];

export class S3Error extends Error {
  constructor(message, status = 502, code = 'UpstreamError') {
    super(message); this.status = status; this.code = code;
  }
}

export class S3Client {
  constructor({ endpoint, accessKey, secretKey, region = 'us-east-1' }) {
    this.endpoint = new URL(endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username ||
        this.endpoint.password || this.endpoint.search || this.endpoint.hash || this.endpoint.pathname !== '/') {
      throw new Error('MINIO_ENDPOINT must be an http(s) origin');
    }
    this.accessKey = accessKey; this.secretKey = secretKey; this.region = region;
  }

  async request(method, bucket = '', key = '', { query = {}, body = Buffer.alloc(0), headers = {}, raw = false } = {}) {
    const pathname = '/' + (bucket ? encode(bucket) : '') + (key ? '/' + encodeKey(key) : '');
    const params = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [encode(k), encode(String(v))]).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join('&');
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const hash = sha256(content);
    const canonicalHeaders = {
      host: this.endpoint.host,
      'x-amz-content-sha256': hash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]))
    };
    const headerNames = Object.keys(canonicalHeaders).sort();
    const signedHeaders = headerNames.join(';');
    const canonical = [method, pathname, canonicalQuery,
      headerNames.map(k => `${k}:${canonicalHeaders[k]}\n`).join(''), signedHeaders, hash].join('\n');
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretKey}`, shortDate), this.region), 's3'), 'aws4_request');
    const signature = hmac(signingKey, stringToSign).toString('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    // Use the raw request path. WHATWG URL/fetch normalizes `.` and `..` segments,
    // which are legal object-key components and must reach MinIO unchanged.
    const requestPath = pathname + (canonicalQuery ? '?' + canonicalQuery : '');
    let response;
    try {
      response = await new Promise((resolve, reject) => {
        const transport = this.endpoint.protocol === 'https:' ? https : http;
        const request = transport.request({ protocol: this.endpoint.protocol,
          hostname: this.endpoint.hostname, port: this.endpoint.port, path: requestPath,
          method, agent: false, headers: { ...canonicalHeaders, authorization } }, upstream => {
          const noBody = method === 'HEAD' || [204, 304].includes(upstream.statusCode);
          resolve(new Response(noBody ? null : Readable.toWeb(upstream), {
            status: upstream.statusCode, statusText: upstream.statusMessage,
            headers: upstream.headers }));
        });
        request.setTimeout(30000, () => request.destroy(new Error('MinIO request timed out')));
        request.on('error', reject);
        request.end(['GET', 'HEAD'].includes(method) ? undefined : content);
      });
    } catch (err) { throw new S3Error(`MinIO connection failed: ${err.message}`, 502, 'ConnectionFailed'); }
    if (!response.ok) {
      const errorBody = method === 'HEAD' ? '' : await response.text();
      let code = `HTTP${response.status}`, message = response.statusText;
      try { const parsed = parseXml(errorBody); code = value(parsed, 'Code') || code; message = value(parsed, 'Message') || message; }
      catch { /* Preserve HTTP error if upstream sent non-XML. */ }
      throw new S3Error(message || 'MinIO request failed', response.status, code);
    }
    if (raw) return response;
    if (method === 'HEAD' || response.status === 204) return { response };
    const text = await response.text();
    return { response, xml: text ? parseXml(text) : null, text };
  }

  async listBuckets() {
    const { xml } = await this.request('GET');
    return children(child(xml, 'Buckets'), 'Bucket').map(item => ({
      name: value(item, 'Name'), creationDate: value(item, 'CreationDate')
    }));
  }
  async createBucket(bucket) { await this.request('PUT', bucket); }
  async deleteBucket(bucket) { await this.request('DELETE', bucket); }
  async listObjects(bucket, prefix = '', token = '') {
    const query = { 'list-type': 2, delimiter: '/', prefix, 'max-keys': 100 };
    if (token) query['continuation-token'] = token;
    const { xml } = await this.request('GET', bucket, '', { query });
    return {
      objects: children(xml, 'Contents').map(item => ({ key: value(item, 'Key'),
        size: Number(value(item, 'Size') || 0), lastModified: value(item, 'LastModified'), etag: value(item, 'ETag') })),
      prefixes: children(xml, 'CommonPrefixes').map(item => value(item, 'Prefix')),
      nextContinuationToken: value(xml, 'NextContinuationToken') || null
    };
  }
  async headObject(bucket, key) {
    const { response } = await this.request('HEAD', bucket, key);
    return { key, size: Number(response.headers.get('content-length') || 0),
      contentType: response.headers.get('content-type') || '', etag: response.headers.get('etag') || '',
      lastModified: response.headers.get('last-modified') || '',
      metadata: Object.fromEntries([...response.headers].filter(([k]) => k.startsWith('x-amz-meta-'))
        .map(([k, v]) => [k.slice('x-amz-meta-'.length), v])) };
  }
  async getObject(bucket, key) { return this.request('GET', bucket, key, { raw: true }); }
  async putObject(bucket, key, body, contentType = 'application/octet-stream') {
    await this.request('PUT', bucket, key, { body, headers: { 'content-type': contentType } });
  }
  async deleteObject(bucket, key) { await this.request('DELETE', bucket, key); }
  async createMultipart(bucket, key) {
    const { xml } = await this.request('POST', bucket, key, { query: { uploads: '' } });
    const uploadId = value(xml, 'UploadId');
    if (!uploadId) throw new S3Error('MinIO returned no multipart upload ID');
    return uploadId;
  }
  async uploadPart(bucket, key, uploadId, partNumber, body) {
    const { response } = await this.request('PUT', bucket, key,
      { query: { uploadId, partNumber }, body });
    const etag = response.headers.get('etag');
    if (!etag) throw new S3Error('MinIO returned no part ETag');
    return etag;
  }
  async completeMultipart(bucket, key, uploadId, parts) {
    const xml = '<CompleteMultipartUpload>' + parts.map(({ partNumber, etag }) =>
      `<Part><PartNumber>${partNumber}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`)
      .join('') + '</CompleteMultipartUpload>';
    const result = await this.request('POST', bucket, key,
      { query: { uploadId }, body: xml, headers: { 'content-type': 'application/xml' } });
    if (result.xml?.name === 'Error') throw new S3Error(value(result.xml, 'Message'), 502, value(result.xml, 'Code'));
  }
  async abortMultipart(bucket, key, uploadId) {
    await this.request('DELETE', bucket, key, { query: { uploadId } });
  }
  async getLifecycle(bucket) {
    try {
      const { xml } = await this.request('GET', bucket, '', { query: { lifecycle: '' } });
      return children(xml, 'Rule').map(rule => ({ id: value(rule, 'ID'), status: value(rule, 'Status'),
        prefix: value(child(rule, 'Filter'), 'Prefix') || value(rule, 'Prefix'),
        expirationDays: Number(value(child(rule, 'Expiration'), 'Days') || 0) }));
    } catch (err) { if (err.code === 'NoSuchLifecycleConfiguration') return []; throw err; }
  }
  async putLifecycle(bucket, rules) {
    if (!rules.length) { await this.deleteLifecycle(bucket); return; }
    const xml = '<LifecycleConfiguration>' + rules.map(rule => `<Rule><ID>${xmlEscape(rule.id)}</ID>` +
      `<Status>${rule.status}</Status><Filter><Prefix>${xmlEscape(rule.prefix)}</Prefix></Filter>` +
      `<Expiration><Days>${rule.expirationDays}</Days></Expiration></Rule>`).join('') + '</LifecycleConfiguration>';
    await this.request('PUT', bucket, '', { query: { lifecycle: '' }, body: xml,
      headers: { 'content-type': 'application/xml',
        'content-md5': crypto.createHash('md5').update(xml).digest('base64') } });
  }
  async deleteLifecycle(bucket) { await this.request('DELETE', bucket, '', { query: { lifecycle: '' } }); }
}

export function validateBucketName(name) {
  return typeof name === 'string' && name.length >= 3 && name.length <= 63 &&
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/--/.test(name);
}
