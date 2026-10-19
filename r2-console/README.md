# MinIO Storage console

A self-hosted, R2-inspired administration console for personal MinIO use. It is an **additional service** in this fork, served on port 9090 by default. The standard embedded MinIO Console on port 9001 is unchanged. This project does not depend on Cloudflare services or copy Cloudflare branding.

## What works

- Sign in with MinIO access key and secret key. The server validates them with MinIO and keeps them in memory for an eight-hour browser session. They are never written to disk or sent back to the browser after login.
- List, create and delete buckets. MinIO itself rejects deleting nonempty buckets.
- Browse real S3 objects by prefix with breadcrumbs and continuation-token pagination. Folders are zero-byte objects whose keys end in `/`.
- Upload multiple files, including S3 multipart upload above 16 MiB, with progress and abort-on-failure; inspect object metadata; download and delete objects.
- Read and manage S3 lifecycle expiration rules, with a read-back after save. These rules can automatically delete stored data, so check the prefix and age carefully.
- Show an honest unsupported state for per-bucket CORS. MinIO Community Edition exposes dummy S3 Bucket CORS handlers. Configure MinIO's server-wide CORS settings outside this console if needed.

R2-specific public domains, Cloudflare metrics and billing are deliberately absent. MinIO versioning and its delete-marker semantics are not presented as R2 features. The UI does not claim to replace the embedded MinIO Console in this version.

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

The console binds to 127.0.0.1 by default. Remote access requires an HTTPS reverse proxy and `CONSOLE_PUBLIC_ORIGIN=https://your-console-origin`; bind to another address only when intentionally exposing it. Never expose the S3 API or console over plain HTTP on the public internet. `MINIO_REGION` defaults to `us-east-1`. Authentication requires permission to list buckets; other actions require corresponding S3 permissions.

## Docker Compose

From `r2-console/`, copy `.env.example` to `.env`, replace both credential placeholders, then run `docker compose up --build -d`. The new console is at http://localhost:9090; MinIO's original embedded Console remains at http://localhost:9001. Ports bind to localhost by default. This sample uses the upstream MinIO container image; to run this fork's server source instead, build its binary and use `start-local.sh` or substitute your own image in `MINIO_IMAGE`. For access beyond your computer, put an HTTPS reverse proxy in front of port 9090, set `CONSOLE_PUBLIC_ORIGIN` to that exact HTTPS origin, and restrict access to the MinIO S3 API. Do not commit `.env`.

## Test

```sh
cd r2-console
npm test
```

The included unit tests cover XML parsing, bucket validation, request signing shape and S3 error handling. For end-to-end verification, start a disposable MinIO server, create a uniquely named test bucket in the console, upload a file, download it and compare bytes, exercise multipart upload, lifecycle settings and deletion. Do not use production data for destructive tests.

## Security notes

The API is same-origin, uses HttpOnly SameSite session cookies and an explicit CSRF token for mutations. Public deployments require HTTPS for credentials and cookies. Browser data is inserted via text nodes rather than untrusted HTML. Credentials remain in process memory only, so restarting the console signs everyone out. Keep both MinIO and this console patched, restrict network access, and use least-privilege MinIO credentials where possible.

License: the repository's AGPL-3.0 license applies.
