# Optional MinIO service-account helper

This one-shot process uses the official `github.com/minio/madmin-go/v3` already required by this repository. It only manages service accounts owned by the authenticated MinIO identity. Do not run it with root environment credentials: the calling console supplies the signed-in user's S3 access key and secret through stdin for each invocation. MinIO may deny these admin APIs for particular users or policies. In that case the console should report the feature as unavailable; ordinary S3 features do not depend on it.

Build a precompiled binary from the repository root with `go build -o r2-console/admin-helper/minio-admin-helper ./r2-console/admin-helper`. Do not build on a user request. Keep the binary path server-configured, never user-controlled. It is deliberately absent from source control.

The process reads a single JSON object (maximum 64 KiB) on stdin and writes one JSON object on stdout. The common input fields are `action`, `endpoint` (HTTP(S) origin, optional trailing `/`), `accessKey`, and `secretKey`. No secret may be passed in command-line arguments, environment variables, logs, or files. The caller should use `spawn` with stdin/stdout pipes, no shell, no inherited credentials, bounded output, and a short process timeout. stdout is sensitive because `create` returns the new secret. It must not be logged or persisted; present the secret once. Use no-store HTTP responses. The process itself prints only generic errors and makes no disk writes.

Actions:

- `capabilities`: tests MinIO authentication and self-list support. Success: `{"ok":true,"available":true}`.
- `list`: returns `{"ok":true,"accounts":[{"accessKey":"...","parentUser":"...","name":"...","description":"...","status":"...","expiresAt":"..."}]}`. No account secrets are included.
- `create`: requires `bucket`, `prefix`, `permissions`, and `expiresAt`; optional `name` and `description`. `permissions` is a nonempty subset of `list`, `read`, `write`, and `delete`. `prefix` is empty for an entire bucket or a literal folder ending in `/`; glob characters, ASCII control characters, and `.` or `..` path segments are forbidden. `expiresAt` is RFC3339, more than a minute in the future and no more than one year away. Success: `{"ok":true,"account":{"accessKey":"...","expiresAt":"..."},"secretKey":"...","policy":{...}}`.
- `revoke`: requires `targetAccessKey`. The key must appear in the caller's own account list with `parentUser` exactly matching the caller access key before deletion. Success: `{"ok":true}`.

Errors have `{"ok":false,"error":"..."}`. Network or MinIO API errors are redacted rather than returned verbatim.

The policy scopes object actions to `arn:aws:s3:::<bucket>/<prefix>*`. Bucket listing uses `s3:prefix` condition `<prefix>*`; on an empty prefix it permits listing the named bucket. MinIO service-account permissions are intersected with those of the parent identity. The helper does not set a target user and cannot assign keys to another identity.

Run synthetic unit tests with `go test ./r2-console/admin-helper`. To opt into the real MinIO integration test, run against an isolated local MinIO server with `MINIO_TEST_ENDPOINT=http://127.0.0.1:9000 MINIO_TEST_ACCESS_KEY=<synthetic-user> MINIO_TEST_SECRET_KEY=<synthetic-secret> go test ./r2-console/admin-helper -run TestIntegrationServiceAccount -count=1`. The test rejects non-loopback endpoints, creates two randomly named temporary buckets and one short-lived scoped service account, verifies permitted and denied operations, revokes the account, and removes test resources. Never point it at a production account.
