import { S3Error, validateBucketName } from './s3.js';
import { value } from './xml.js';

// These helpers use an existing S3Client and only copy within one bucket.
// copyObject(client, bucket, sourceKey, destinationKey) preserves source metadata
// and tags. replaceObjectMetadata(client, bucket, key, patch) accepts
// { customMetadata?: {name: value}, contentType?, cacheControl?,
//   contentDisposition?, contentEncoding?, contentLanguage?, expires? }.
// It adds/replaces only supplied fields and preserves all other supported HEAD
// metadata; it never interprets empty strings or null as an instruction to
// unset metadata. A flat { name: value } patch is accepted as customMetadata.
// Neither helper deletes source objects. Both reject an embedded XML Error in
// an HTTP 200 CopyObject response. They are single-request copies (<= 5 GiB).
const encode = s => encodeURIComponent(s).replace(/[!'()*]/g,
  c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sourcePath = (bucket, key) => `/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;
const preservedHeaders = ['content-type', 'cache-control', 'content-disposition',
  'content-encoding', 'content-language', 'expires', 'x-amz-website-redirect-location'];
const editableHeaders = { contentType: 'content-type', cacheControl: 'cache-control',
  contentDisposition: 'content-disposition', contentEncoding: 'content-encoding',
  contentLanguage: 'content-language', expires: 'expires' };
const benignAmzHeaders = new Set(['x-amz-request-id', 'x-amz-id-2', 'x-amz-bucket-region',
  'x-amz-version-id', 'x-amz-expiration', 'x-amz-restore', 'x-amz-mp-parts-count']);
const unsupported = detail => new S3Error(`Cannot safely edit this object's metadata: ${detail}`,
  409, 'UnsupportedObjectMetadata');

function validKey(key) {
  return typeof key === 'string' && key.length > 0 &&
    Buffer.byteLength(key, 'utf8') <= 1024 && !/[\u0000-\u001f\u007f]/.test(key) &&
    !key.split('/').some(segment => segment === '.' || segment === '..') &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(key);
}
function validate(bucket, sourceKey, destinationKey) {
  if (!validateBucketName(bucket) || !validKey(sourceKey) || !validKey(destinationKey))
    throw new S3Error('Invalid bucket or object key', 400, 'InvalidCopyDestination');
}
function checkCopyResult(result) {
  if (result.xml?.name === 'Error') throw new S3Error(value(result.xml, 'Message') ||
    'CopyObject failed', 502, value(result.xml, 'Code') || 'CopyObjectFailed');
  if (result.xml?.name !== 'CopyObjectResult' || !value(result.xml, 'ETag'))
    throw new S3Error('CopyObject returned no valid result', 502, 'InvalidCopyResponse');
  return { etag: value(result.xml, 'ETag'), lastModified: value(result.xml, 'LastModified') };
}

export async function copyObject(client, bucket, sourceKey, destinationKey) {
  validate(bucket, sourceKey, destinationKey);
  if (sourceKey === destinationKey)
    throw new S3Error('Copy destination must differ from source', 400, 'SelfCopyRequiresReplace');
  const result = await client.request('PUT', bucket, destinationKey, { headers: {
    'x-amz-copy-source': sourcePath(bucket, sourceKey),
    'x-amz-metadata-directive': 'COPY', 'x-amz-tagging-directive': 'COPY'
  } });
  return checkCopyResult(result);
}

export async function replaceObjectMetadata(client, bucket, key, patch) {
  validate(bucket, key, key);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      !Object.keys(patch).length)
    throw new S3Error('Provide a nonempty metadata patch', 400, 'InvalidMetadataPatch');
  const structured = Object.keys(patch).some(name => name === 'customMetadata' ||
    Object.hasOwn(editableHeaders, name));
  if (structured && Object.keys(patch).some(name => name !== 'customMetadata' &&
      !Object.hasOwn(editableHeaders, name)))
    throw new S3Error('Unknown metadata patch field', 400, 'InvalidMetadataPatch');
  const userMetadata = structured ? (patch.customMetadata ?? {}) : patch;
  if (!userMetadata || typeof userMetadata !== 'object' || Array.isArray(userMetadata))
    throw new S3Error('Invalid custom metadata map', 400, 'InvalidMetadataPatch');
  const additions = new Map();
  for (const [name, val] of Object.entries(userMetadata)) {
    if (!/^[a-z0-9-]+$/i.test(name) || typeof val !== 'string' || !val.length ||
        /[^\u0020-\u007e]/.test(val))
      throw new S3Error('Invalid metadata name or value', 400, 'InvalidMetadataPatch');
    const lower = name.toLowerCase();
    if (additions.has(lower)) throw new S3Error('Duplicate metadata name', 400, 'InvalidMetadataPatch');
    additions.set(lower, val);
  }
  const standardEdits = {};
  if (structured) for (const [field, header] of Object.entries(editableHeaders)) {
    if (!Object.hasOwn(patch, field)) continue;
    const val = patch[field];
    if (typeof val !== 'string' || !val.length || /[^\u0020-\u007e]/.test(val) ||
        (field === 'expires' && !Number.isFinite(Date.parse(val))))
      throw new S3Error(`Invalid ${field}`, 400, 'InvalidMetadataPatch');
    standardEdits[header] = val;
  }
  if (!additions.size && !Object.keys(standardEdits).length)
    throw new S3Error('Provide a nonempty metadata patch', 400, 'InvalidMetadataPatch');
  const { response } = await client.request('HEAD', bucket, key);
  const head = response.headers;
  const size = Number(head.get('content-length'));
  if (!Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 ** 3)
    throw unsupported('size is unknown or exceeds the 5 GiB CopyObject limit');
  const etag = head.get('etag');
  if (!etag) throw unsupported('ETag is unavailable');
  const headers = { 'x-amz-copy-source': sourcePath(bucket, key),
    'x-amz-copy-source-if-match': etag,
    'x-amz-metadata-directive': 'REPLACE', 'x-amz-tagging-directive': 'COPY' };
  for (const [name, val] of head) {
    if (name.startsWith('x-amz-meta-')) {
      const metaName = name.slice('x-amz-meta-'.length);
      if (!/^[a-z0-9-]+$/.test(metaName)) throw unsupported(`invalid metadata name ${name}`);
      headers[name] = val;
    } else if (preservedHeaders.includes(name)) {
      headers[name] = val;
    } else if (name === 'x-amz-tagging-count') {
      // COPY is explicitly requested, but HEAD alone cannot verify that a
      // nonempty tag set is actually preservable by every S3-compatible store.
      if (val !== '0') throw unsupported('object tags require a separate workflow');
    } else if (name.startsWith('x-amz-') && !benignAmzHeaders.has(name)) {
      // Includes SSE, object lock, checksum and vendor-specific object state.
      throw unsupported(`unsupported ${name} header`);
    }
  }
  if (!headers['content-type']) throw unsupported('Content-Type is unavailable');
  Object.assign(headers, standardEdits);
  for (const [name, val] of additions) headers[`x-amz-meta-${name}`] = val;
  return checkCopyResult(await client.request('PUT', bucket, key, { headers }));
}
