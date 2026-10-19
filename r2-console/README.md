# MinIO Storage console

A self-hosted, R2-inspired administration console for personal MinIO use. It is an **additional service** in this fork, served on port 9090 by default. The standard embedded MinIO Console on port 9001 is unchanged. This project does not depend on Cloudflare services or copy Cloudflare branding.

## What works

- Sign in with MinIO access key and secret key. The server validates them with MinIO and keeps them in memory for an eight-hour browser session. They are never written to disk or sent back to the browser after login.
- Search the complete bucket list, create buckets, see real object-count and byte totals, and delete buckets. Totals scan up to 10,000 current objects; larger results are marked as lower bounds and exclude older versions.
- Browse real S3 objects by prefix with breadcrumbs and continuation-token pagination. Folders are zero-byte objects whose keys end in `/`.
- Upload multiple files, including S3 multipart upload above 16 MiB, with progress and abort-on-failure; inspect object metadata; download and delete objects. Copy within a bucket and edit supported metadata with server-side CopyObject (up to 5 GiB); risky object states are rejected rather than silently dropped.
- Delete a folder prefix or empty a bucket in 100-object steps with progress and explicit confirmation. Versioned buckets are blocked because ordinary deletion leaves versions or markers.
- Create time-limited signed GET/PUT S3 URLs for individual objects. These grant bearer access for up to one hour. URLs use `MINIO_PUBLIC_ENDPOINT` when configured, otherwise `MINIO_ENDPOINT`, and work only where that S3 origin is reachable.
- Read and manage S3 lifecycle expiration rules, with a read-back after save. These rules can automatically delete stored data, so check the prefix and age carefully.
- Read, replace, and remove MinIO S3 bucket policies. The private preset removes the bucket policy; the public-read preset grants anonymous `s3:GetObject` only. Custom JSON policies require typed bucket-name confirmation, and anonymous write/list grants are rejected. Other IAM grants may still apply after a policy is removed.
- Manually list and abort incomplete multipart uploads from bucket settings. Automatic abort lifecycle rules are unsupported by this MinIO Community backend.
- Optionally list, create and revoke bucket/prefix-scoped MinIO service accounts with the official MinIO admin-helper. This capability needs a MinIO identity authorized for service-account management. New keys expire and are shown once; revocation is permanent.
- Show an honest unsupported state for per-bucket CORS. MinIO Community Edition exposes dummy S3 Bucket CORS handlers. Configure MinIO's server-wide CORS settings outside this console if needed.

R2-specific public domains, Cloudflare metrics, billing, storage tiers, Queue-backed event notifications and Data Access Logs are deliberately absent. MinIO S3 Object Lock cannot reproduce R2's retroactive prefix locks. MinIO versioning and its delete-marker semantics are not presented as R2 features. The UI does not claim to replace the embedded MinIO Console in this version.

## Run locally

Requires Node.js 20+ and a MinIO server executable. No npm install is needed.

```sh
export MINIO_ROOT_USER='choose-a-local-access-key'
export MINIO_ROOT_PASSWORD='choose-a-long-local-secret'
export MINIO_BIN=/path/to/minio
./r2-console/start-local.sh
```

Open http://127.0.0.1:9090 and sign in with those MinIO credentials. The local launcher stores data in `r2-console/minio-data` unless `MINIO_DATA_DIR` is set. Do not commit this data directory or credentials.

To attach to an existing MinIO instance instead, run:

```sh
MINIO_ENDPOINT=http://127.0.0.1:9000 node r2-console/server.js
```

The console binds to 127.0.0.1 by default. Remote access requires an HTTPS reverse proxy and `CONSOLE_PUBLIC_ORIGIN=https://your-console-origin`; bind to another address only when intentionally exposing it. Never expose the S3 API or console over plain HTTP on the public internet. `MINIO_REGION` defaults to `us-east-1`. `MINIO_PUBLIC_ENDPOINT` optionally sets the S3 origin embedded in signed URLs; it must be reachable by recipients and should use HTTPS for remote use. It can differ from the console server's internal `MINIO_ENDPOINT`. Authentication requires permission to list buckets; other actions require corresponding S3 permissions.

## Optional scoped access-key management

Build the small official-SDK helper with Go 1.24+ from the repository root:

```sh
go build -o /absolute/path/minio-console-admin ./r2-console/admin-helper
MINIO_ADMIN_HELPER_BIN=/absolute/path/minio-console-admin node r2-console/server.js
```

It uses the repository's `github.com/minio/madmin-go/v3` dependency. Set `MINIO_ADMIN_HELPER_BIN` only to a trusted absolute executable path controlled by the operator. The console sends credentials to it through a private stdin pipe, never command-line arguments. Leave it unset if key management is unnecessary. Access-key settings appear only when enabled and an admin login is authorized.

## Docker Compose

From `r2-console/`, copy `.env.example` to `.env`, replace both credential placeholders, then run `docker compose up --build -d`. The new console is at http://localhost:9090; MinIO's original embedded Console remains at http://localhost:9001. Ports bind to localhost by default. This sample uses the upstream MinIO container image; to run this fork's server source instead, build its binary and use `start-local.sh` or substitute your own image in `MINIO_IMAGE`. Compose sets signed URLs to `http://localhost:9000` for use on that same machine; they will not work for another machine. The Compose example does not build the optional admin helper, so access-key management stays disabled there. For access beyond your computer, put an HTTPS reverse proxy in front of port 9090, set `CONSOLE_PUBLIC_ORIGIN` to that exact HTTPS origin, and configure a reachable HTTPS `MINIO_PUBLIC_ENDPOINT` for sharing signed URLs. Do not commit `.env`.

## Test

```sh
cd r2-console
npm test
```

The default command runs unit and negative-security tests; the live integration test skips unless `MINIO_TEST_ENDPOINT`, `MINIO_ROOT_USER`, and `MINIO_ROOT_PASSWORD` are set. Set these only for a disposable, isolated MinIO instance, then run `npm test` again. Optionally set `MINIO_ADMIN_HELPER_BIN` to include service-account creation/revocation. The live suite creates and deletes random synthetic buckets, exercises object, policy, lifecycle, and multipart operations, and compares downloaded bytes. Never point it at production data.

## Security notes

The API is same-origin, uses HttpOnly SameSite session cookies and an explicit CSRF token for mutations. Public deployments require HTTPS for credentials and cookies. Browser data is inserted via text nodes rather than untrusted HTML. Credentials remain in process memory only, so restarting the console signs everyone out. Keep both MinIO and this console patched, restrict network access, and use least-privilege MinIO credentials where possible.

License: the repository's AGPL-3.0 license applies.
