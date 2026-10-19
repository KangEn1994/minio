package main

import (
	"encoding/json"
	madmin "github.com/minio/madmin-go/v3"
	"testing"
)

func TestPolicyIsScoped(t *testing.T) {
	p, e := makePolicy("photos", "team/", []string{"list", "read", "write"})
	if e != nil {
		t.Fatal(e)
	}
	var doc struct {
		Statement []struct {
			Action    []string
			Resource  []string
			Condition map[string]map[string][]string
		}
	}
	if e = json.Unmarshal(p, &doc); e != nil {
		t.Fatal(e)
	}
	if len(doc.Statement) != 2 || doc.Statement[0].Resource[0] != "arn:aws:s3:::photos" || doc.Statement[0].Condition["StringLike"]["s3:prefix"][0] != "team/*" || doc.Statement[1].Resource[0] != "arn:aws:s3:::photos/team/*" {
		t.Fatalf("bad policy: %s", p)
	}
}
func TestPolicyRejectsBadScope(t *testing.T) {
	for _, v := range []struct {
		bucket, prefix string
		permissions    []string
	}{{"bad..bucket", "", []string{"read"}}, {"photos", "/root/", []string{"read"}}, {"photos", "team", []string{"read"}}, {"photos", "team*/", []string{"read"}}, {"photos", "", []string{"admin"}}, {"photos", "", nil}} {
		if _, e := makePolicy(v.bucket, v.prefix, v.permissions); e == nil {
			t.Fatalf("accepted %+v", v)
		}
	}
}
func TestPolicyRejectsControlAndDotSegments(t *testing.T) {
	for _, prefix := range []string{"./", "../", "team/./", "team/../", "team/../x/", "team/\x01/", "team/\x1f/", "team/\x7f/", "team/\n/"} {
		if _, err := makePolicy("photos", prefix, []string{"read"}); err == nil {
			t.Errorf("accepted unsafe prefix %q", prefix)
		}
	}
	for _, prefix := range []string{"team/.hidden/", "team/dots..okay/"} {
		if _, err := makePolicy("photos", prefix, []string{"read"}); err != nil {
			t.Errorf("rejected valid prefix %q: %v", prefix, err)
		}
	}
}
func TestEndpoint(t *testing.T) {
	for _, s := range []string{"https://example.com/path", "https://user:pass@example.com", "file:///tmp/x", "https://example.com/?x=1"} {
		if _, _, e := parseEndpoint(s); e == nil {
			t.Fatal(s)
		}
	}
	if host, tls, e := parseEndpoint("http://127.0.0.1:9000/"); e != nil || host != "127.0.0.1:9000" || tls {
		t.Fatal(host, tls, e)
	}
}

func TestRevokeOnlyDirectChild(t *testing.T) {
	accounts := []madmin.ServiceAccountInfo{{AccessKey: "target123", ParentUser: "owner123"}, {AccessKey: "sibling123", ParentUser: "elsewhere"}}
	if !canRevoke(accounts, "owner123", "target123") {
		t.Fatal("direct child should be revocable")
	}
	if canRevoke(accounts, "owner123", "sibling123") || canRevoke(accounts, "other123", "target123") {
		t.Fatal("unrelated account revocable")
	}
}
