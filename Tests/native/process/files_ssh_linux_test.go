package nativeprocess_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/files"
)

func result(t *testing.T, event wire) files.Result {
	t.Helper()
	data, err := json.Marshal(event["result"])
	if err != nil {
		t.Fatal(err)
	}
	var r files.Result
	if json.Unmarshal(data, &r) != nil {
		t.Fatal("invalid file result")
	}
	return r
}
func digest(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

func TestFileTransactionThroughRealSSH(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		t.Skip("isolated SSH fixture only")
	}
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte("before"), 0640); err != nil {
		t.Fatal(err)
	}
	inspect := start(t, "--files")
	inspect.send("inspect", wire{"payload": files.Request{Path: path}})
	before := result(t, inspect.wait("file-result"))
	if before.Status != "inspected" || before.Snapshot == nil {
		t.Fatalf("inspect: %+v", before)
	}
	artifact, err := os.ReadFile(helper(t))
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("after\n")
	req := files.Request{Action: "write", Fingerprint: digest([]byte("approved-operation")), ContentBase64: base64.StdEncoding.EncodeToString(content), Plan: &files.Plan{
		Version: 1, TransactionID: "ssh-write", Before: *before.Snapshot, ContentSHA256: digest(content), ContentSize: len(content), MetadataPolicy: "preserve-or-refuse",
		Runtime: files.Artifact{ProtocolVersion: 1, Platform: "linux", Arch: runtime.GOARCH, SHA256: digest(artifact), Size: int64(len(artifact))},
	}}
	apply := start(t, "--files")
	apply.send("apply", wire{"payload": req})
	apply.wait("file-staged")
	if data, _ := os.ReadFile(path); string(data) != "before" {
		t.Fatal("file changed before commit authorization")
	}
	apply.send("file-commit", nil)
	committed := result(t, apply.wait("file-result"))
	if committed.Status != "succeeded" || committed.Receipt == nil {
		t.Fatalf("apply: %+v", committed)
	}
	if data, _ := os.ReadFile(path); string(data) != string(content) {
		t.Fatal("committed content mismatch")
	}
	recover := start(t, "--files")
	recover.send("recover", wire{"payload": req})
	if r := result(t, recover.wait("file-result")); r.Status != "succeeded" || r.Receipt == nil {
		t.Fatalf("recover: %+v", r)
	}
	cleanup := start(t, "--files")
	cleanup.send("cleanup", wire{"payload": req})
	if r := result(t, cleanup.wait("file-result")); r.Status != "cleaned" {
		t.Fatalf("cleanup: %+v", r)
	}
}
