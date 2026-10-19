# Verification record

Tested on a disposable, loopback-only MinIO instance using synthetic buckets and files. No production data was used.

- `node --check public/app.js`, `bash -n start-local.sh`, `git diff --check`: passed.
- `npm test` with `MINIO_TEST_ENDPOINT`, `MINIO_ROOT_USER`, and `MINIO_ROOT_PASSWORD` set by the disposable MinIO launcher: 17 passed, 0 failed, 0 skipped. This includes real S3 create/list/delete bucket, upload/download byte comparison, 17 MiB multipart completion, lifecycle read/write/delete, and negative authentication/security checks.
- Signed-in cloud-browser walkthrough: invalid bucket name rejected; create bucket; create and browse Unicode prefix; upload two files, including a Unicode filename; verify object metadata and exact downloaded bytes; save, reload, cancel removal, and remove lifecycle rule; bulk-delete cancellation and confirmation; delete folder marker; reject deletion of nonempty bucket; delete empty bucket; verify overview, refresh, Back/Forward navigation, route cleanup after bucket deletion, and logout persistence.
- Visual inspection: overview, bucket objects, and settings at a 1180px-wide viewport. Screenshots of synthetic data are retained outside the repository.

Known limits: this is an additional console service, not a replacement for MinIO's embedded Console. Per-bucket CORS is unsupported by the tested MinIO Community backend. Cloudflare-only domains, analytics, and billing are outside scope. A public deployment URL was not available in the test environment; use the local or Docker instructions in `README.md` for a private deployment, or an HTTPS reverse proxy for remote use.
