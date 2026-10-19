package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// TestIntegrationServiceAccount runs only with an explicitly configured,
// disposable local MinIO. It never prints credentials or created secrets.
func TestIntegrationServiceAccount(t *testing.T) {
	endpoint := os.Getenv("MINIO_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("set MINIO_TEST_ENDPOINT for disposable local MinIO integration test")
	}
	u, e := url.Parse(endpoint)
	if e != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		t.Fatal("invalid test endpoint")
	}
	if host := u.Hostname(); host != "localhost" && net.ParseIP(host) == nil {
		t.Fatal("integration test requires loopback endpoint")
	} else if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() {
		t.Fatal("integration test requires loopback endpoint")
	}
	access, secret := os.Getenv("MINIO_TEST_ACCESS_KEY"), os.Getenv("MINIO_TEST_SECRET_KEY")
	if access == "" || secret == "" {
		t.Fatal("set MINIO_TEST_ACCESS_KEY and MINIO_TEST_SECRET_KEY")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	client, e := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(access, secret, ""), Secure: u.Scheme == "https"})
	if e != nil {
		t.Fatal("MinIO test client initialization failed")
	}
	suffix := make([]byte, 5)
	if _, e = rand.Read(suffix); e != nil {
		t.Fatal(e)
	}
	bucket := "r2helper-" + hex.EncodeToString(suffix)
	other := bucket + "-other"
	for _, b := range []string{bucket, other} {
		if e = client.MakeBucket(ctx, b, minio.MakeBucketOptions{}); e != nil {
			t.Fatal("failed to create isolated test bucket", e)
		}
	}
	t.Cleanup(func() {
		cleanCtx, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		for _, b := range []string{bucket, other} {
			for obj := range client.ListObjects(cleanCtx, b, minio.ListObjectsOptions{Recursive: true}) {
				if obj.Err == nil {
					_ = client.RemoveObject(cleanCtx, b, obj.Key, minio.RemoveObjectOptions{})
				}
			}
			_ = client.RemoveBucket(cleanCtx, b)
		}
	})
	for b, k := range map[string]string{bucket: "team/allowed.txt", other: "outside.txt"} {
		if _, e = client.PutObject(ctx, b, k, strings.NewReader("test"), 4, minio.PutObjectOptions{}); e != nil {
			t.Fatal("failed to seed isolated test object", e)
		}
	}
	base := request{Endpoint: endpoint, AccessKey: access, SecretKey: secret}
	base.Action = "capabilities"
	if out := execute(base); !out.OK || !out.Available {
		t.Fatalf("capabilities unavailable: %s", out.Error)
	}
	base.Action = "create"
	base.Bucket = bucket
	base.Prefix = "team/"
	base.Permissions = []string{"list", "read"}
	base.ExpiresAt = time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339)
	base.Name = "R2HelperTest"
	created := execute(base)
	if !created.OK || created.Account == nil || created.SecretKey == "" {
		t.Fatalf("create failed: %s", created.Error)
	}
	key := created.Account.AccessKey
	t.Cleanup(func() {
		_ = execute(request{Action: "revoke", Endpoint: endpoint, AccessKey: access, SecretKey: secret, TargetAccessKey: key})
	})
	limited, e := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(key, created.SecretKey, ""), Secure: u.Scheme == "https"})
	if e != nil {
		t.Fatal("limited client init failed")
	}
	obj, e := limited.GetObject(ctx, bucket, "team/allowed.txt", minio.GetObjectOptions{})
	if e != nil {
		t.Fatal("limited read failed")
	}
	_, e = io.Copy(io.Discard, obj)
	_ = obj.Close()
	if e != nil {
		t.Fatal("limited read denied", e)
	}
	seen := false
	for x := range limited.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: "team/", Recursive: true}) {
		if x.Err != nil {
			t.Fatal("limited list denied", x.Err)
		}
		if x.Key == "team/allowed.txt" {
			seen = true
		}
	}
	if !seen {
		t.Fatal("allowed object not listed")
	}
	if _, e = limited.PutObject(ctx, bucket, "team/no-write.txt", bytes.NewReader([]byte("x")), 1, minio.PutObjectOptions{}); e == nil {
		t.Fatal("unexpected write permission")
	}
	obj, e = limited.GetObject(ctx, other, "outside.txt", minio.GetObjectOptions{})
	if e == nil {
		_, e = io.Copy(io.Discard, obj)
		_ = obj.Close()
	}
	if e == nil {
		t.Fatal("unexpected other-bucket read permission")
	}
	obj, e = limited.GetObject(ctx, bucket, "outside.txt", minio.GetObjectOptions{})
	if e == nil {
		_, e = io.Copy(io.Discard, obj)
		_ = obj.Close()
	}
	if e == nil {
		t.Fatal("unexpected outside-prefix read permission")
	}
	base.Action = "list"
	listed := execute(base)
	if !listed.OK {
		t.Fatalf("list failed: %s", listed.Error)
	}
	found := false
	for _, a := range listed.Accounts {
		if a.AccessKey == key {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("created account missing from list")
	}
	revoked := execute(request{Action: "revoke", Endpoint: endpoint, AccessKey: access, SecretKey: secret, TargetAccessKey: key})
	if !revoked.OK {
		t.Fatalf("revoke failed: %s", revoked.Error)
	}
	obj, e = limited.GetObject(ctx, bucket, "team/allowed.txt", minio.GetObjectOptions{})
	if e == nil {
		_, e = io.Copy(io.Discard, obj)
		_ = obj.Close()
	}
	if e == nil {
		t.Fatal("revoked key still has read access")
	}
}
