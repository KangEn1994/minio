import crypto from 'node:crypto';

// S3 SigV4 query authentication: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Create a path-style, GET or PUT S3 SigV4 URL without contacting the server. */
export function presignObject({ endpoint, region = 'us-east-1', accessKey, secretKey,
  bucket, key, method, expiresSeconds = 900 }) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError('endpoint must be an http(s) origin'); }
  if (typeof endpoint !== 'string' || !['http:', 'https:'].includes(url.protocol) ||
      (endpoint !== url.origin && endpoint !== `${url.origin}/`) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('endpoint must be an http(s) origin');
  }
  if (typeof region !== 'string' || !/^[a-zA-Z0-9-]+$/.test(region))
    throw new TypeError('Invalid S3 region');
  if (typeof accessKey !== 'string' || !accessKey || /[\x00-\x20/]/.test(accessKey) ||
      typeof secretKey !== 'string' || !secretKey) throw new TypeError('Invalid S3 credentials');
  if (typeof bucket !== 'string' || bucket.length < 3 || bucket.length > 63 ||
      !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(bucket))
    throw new TypeError('Invalid bucket name');
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024 ||
      /[\x00-\x1f\x7f]/.test(key) || key.split('/').some(part => part === '.' || part === '..'))
    throw new TypeError('Invalid object key');
  if (method !== 'GET' && method !== 'PUT') throw new TypeError('Method must be GET or PUT');
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 3600)
    throw new TypeError('Expiration must be 60 to 3600 seconds');

  // Do not pass the object path through URL: URL normalizes dot segments and can
  // change which S3 object is addressed. Encode each segment, retaining slashes.
  const path = `/${bucket}/${key.split('/').map(encode).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${region}/s3/aws4_request`;
  const parameters = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host'
  };
  const query = Object.entries(parameters).map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`).join('&');
  const canonicalRequest = [method, path, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, shortDate), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return `${url.origin}${path}?${query}&X-Amz-Signature=${signature}`;
}
