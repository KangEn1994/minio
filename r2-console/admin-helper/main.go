// admin-helper is a one-shot, capability-gated adapter to MinIO's official
// madmin SDK. It accepts one JSON request on stdin and writes one JSON result.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	madmin "github.com/minio/madmin-go/v3"
)

type request struct {
	Action          string   `json:"action"`
	Endpoint        string   `json:"endpoint"`
	AccessKey       string   `json:"accessKey"`
	SecretKey       string   `json:"secretKey"`
	Bucket          string   `json:"bucket,omitempty"`
	Prefix          string   `json:"prefix,omitempty"`
	Permissions     []string `json:"permissions,omitempty"`
	ExpiresAt       string   `json:"expiresAt,omitempty"`
	Name            string   `json:"name,omitempty"`
	Description     string   `json:"description,omitempty"`
	TargetAccessKey string   `json:"targetAccessKey,omitempty"`
}
type account struct {
	AccessKey   string     `json:"accessKey"`
	ParentUser  string     `json:"parentUser,omitempty"`
	Name        string     `json:"name,omitempty"`
	Description string     `json:"description,omitempty"`
	Status      string     `json:"status,omitempty"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
}
type result struct {
	OK        bool            `json:"ok"`
	Available bool            `json:"available,omitempty"`
	Error     string          `json:"error,omitempty"`
	Accounts  []account       `json:"accounts,omitempty"`
	Account   *account        `json:"account,omitempty"`
	SecretKey string          `json:"secretKey,omitempty"`
	Policy    json.RawMessage `json:"policy,omitempty"`
}

var bucketRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
var keyRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$`)

func makePolicy(bucket, prefix string, permissions []string) (json.RawMessage, error) {
	if !bucketRE.MatchString(bucket) || strings.Contains(bucket, "..") || strings.Contains(bucket, ".-") || strings.Contains(bucket, "-.") {
		return nil, errors.New("invalid bucket")
	}
	if strings.HasPrefix(prefix, "/") || strings.ContainsAny(prefix, "*?\\") || (prefix != "" && !strings.HasSuffix(prefix, "/")) {
		return nil, errors.New("invalid prefix")
	}
	for _, c := range prefix {
		if c <= 0x1f || c == 0x7f {
			return nil, errors.New("invalid prefix")
		}
	}
	for _, segment := range strings.Split(prefix, "/") {
		if segment == "." || segment == ".." {
			return nil, errors.New("invalid prefix")
		}
	}
	if len(permissions) == 0 {
		return nil, errors.New("at least one permission is required")
	}
	allowed := map[string]string{"read": "s3:GetObject", "write": "s3:PutObject", "delete": "s3:DeleteObject"}
	actions := []string{}
	list := false
	seen := map[string]bool{}
	for _, p := range permissions {
		if seen[p] {
			continue
		}
		seen[p] = true
		if p == "list" {
			list = true
			continue
		}
		a, ok := allowed[p]
		if !ok {
			return nil, errors.New("invalid permission")
		}
		actions = append(actions, a)
	}
	statements := []map[string]any{}
	if list {
		s := map[string]any{"Effect": "Allow", "Action": []string{"s3:ListBucket"}, "Resource": []string{"arn:aws:s3:::" + bucket}}
		if prefix != "" {
			s["Condition"] = map[string]any{"StringLike": map[string]any{"s3:prefix": []string{prefix + "*"}}}
		}
		statements = append(statements, s)
	}
	if len(actions) > 0 {
		statements = append(statements, map[string]any{"Effect": "Allow", "Action": actions, "Resource": []string{"arn:aws:s3:::" + bucket + "/" + prefix + "*"}})
	}
	return json.Marshal(map[string]any{"Version": "2012-10-17", "Statement": statements})
}
func parseEndpoint(raw string) (string, bool, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", false, errors.New("endpoint must be an http(s) origin")
	}
	return u.Host, u.Scheme == "https", nil
}
func canRevoke(accounts []madmin.ServiceAccountInfo, caller, target string) bool {
	for _, a := range accounts {
		if a.AccessKey == target && a.ParentUser == caller {
			return true
		}
	}
	return false
}

func execute(r request) result {
	if r.AccessKey == "" || r.SecretKey == "" {
		return result{Error: "credentials are required"}
	}
	host, secure, err := parseEndpoint(r.Endpoint)
	if err != nil {
		return result{Error: err.Error()}
	}
	client, err := madmin.New(host, r.AccessKey, r.SecretKey, secure)
	if err != nil {
		return result{Error: "invalid MinIO endpoint"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	switch r.Action {
	case "capabilities":
		// Self-list tests both authentication and support for the service-account API.
		_, err = client.ListServiceAccounts(ctx, "")
		if err != nil {
			return result{Error: "MinIO service-account management unavailable or forbidden"}
		}
		return result{OK: true, Available: true}
	case "list":
		resp, e := client.ListServiceAccounts(ctx, "")
		if e != nil {
			return result{Error: "Unable to list service accounts"}
		}
		out := []account{}
		for _, a := range resp.Accounts {
			out = append(out, account{AccessKey: a.AccessKey, ParentUser: a.ParentUser, Name: a.Name, Description: a.Description, Status: a.AccountStatus, ExpiresAt: a.Expiration})
		}
		return result{OK: true, Accounts: out}
	case "create":
		policy, e := makePolicy(r.Bucket, r.Prefix, r.Permissions)
		if e != nil {
			return result{Error: e.Error()}
		}
		expiry, e := time.Parse(time.RFC3339, r.ExpiresAt)
		if e != nil || !expiry.After(time.Now().Add(time.Minute)) || expiry.After(time.Now().Add(365*24*time.Hour)) {
			return result{Error: "expiresAt must be more than one minute ahead and within one year"}
		}
		if len(r.Name) > 32 || len(r.Description) > 256 {
			return result{Error: "name or description too long"}
		}
		creds, e := client.AddServiceAccount(ctx, madmin.AddServiceAccountReq{Policy: policy, Expiration: &expiry, Name: r.Name, Description: r.Description})
		if e != nil {
			return result{Error: "Unable to create service account"}
		}
		return result{OK: true, Account: &account{AccessKey: creds.AccessKey, Name: r.Name, Description: r.Description, ExpiresAt: &expiry}, SecretKey: creds.SecretKey, Policy: policy}
	case "revoke":
		if !keyRE.MatchString(r.TargetAccessKey) {
			return result{Error: "invalid targetAccessKey"}
		}
		// Only own listed accounts are revocable. In particular, an admin credential
		// cannot use this helper to remove an unrelated account by key.
		resp, e := client.ListServiceAccounts(ctx, "")
		if e != nil {
			return result{Error: "Unable to verify service account ownership"}
		}
		if !canRevoke(resp.Accounts, r.AccessKey, r.TargetAccessKey) {
			return result{Error: "service account was not found in your account list"}
		}
		if e = client.DeleteServiceAccount(ctx, r.TargetAccessKey); e != nil {
			return result{Error: "Unable to revoke service account"}
		}
		return result{OK: true}
	default:
		return result{Error: "invalid action"}
	}
}
func main() {
	defer func() {
		if recover() != nil {
			_ = json.NewEncoder(os.Stdout).Encode(result{Error: "helper failed"})
		}
	}()
	b, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024+1))
	if err != nil || len(b) > 64*1024 {
		_ = json.NewEncoder(os.Stdout).Encode(result{Error: "request too large"})
		return
	}
	var r request
	if err = json.Unmarshal(b, &r); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(result{Error: "invalid JSON request"})
		return
	}
	out := execute(r)
	if err = json.NewEncoder(os.Stdout).Encode(out); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "failed to write helper response")
	}
}
