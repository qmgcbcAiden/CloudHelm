//go:build linux

package selinux_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/files"
	"golang.org/x/sys/unix"
)

func hash(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func label(t *testing.T, path string) []byte {
	t.Helper()
	size, err := unix.Getxattr(path, "security.selinux", nil)
	if err != nil || size <= 0 || size > 4096 {
		t.Fatalf("real SELinux label unavailable: %v", err)
	}
	value := make([]byte, size)
	n, err := unix.Getxattr(path, "security.selinux", value)
	if err != nil {
		t.Fatal(err)
	}
	return value[:n]
}

// This is a separate VM-only package. Missing enforcement or tooling is a test
// failure, not a skipped check or a mocked substitute for SELinux evidence.
func TestEnforcingSELinuxLabelSurvivesAtomicReplacement(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SELINUX") != "1" {
		t.Fatal("run this package only in the required enforcing SELinux VM fixture")
	}
	enforcing, err := os.ReadFile("/sys/fs/selinux/enforce")
	if err != nil || strings.TrimSpace(string(enforcing)) != "1" {
		t.Fatalf("SELinux must be enforcing: %v", err)
	}
	context, err := os.ReadFile("/proc/self/attr/current")
	if err != nil || len(context) == 0 {
		t.Fatalf("process SELinux context unavailable: %v", err)
	}
	t.Logf("process context: %s", bytes.TrimSpace(context))
	path := filepath.Join(t.TempDir(), "managed.conf")
	old := []byte("original nonsecret configuration\n")
	next := []byte("updated nonsecret configuration\n")
	if err = os.WriteFile(path, old, 0640); err != nil {
		t.Fatal(err)
	}
	inherited := label(t, path)
	if output, err := exec.Command("chcon", "--type=httpd_sys_content_t", path).CombinedOutput(); err != nil {
		t.Fatalf("fixture must allow a real non-default target label: %v %s", err, output)
	}
	before := label(t, path)
	if bytes.Equal(inherited, before) {
		t.Fatal("fixture did not establish a non-default label; this would not test preservation")
	}
	t.Logf("target label before: %s", bytes.TrimRight(before, "\x00"))
	inspected := files.Handle("inspect", files.Request{Path: path})
	if inspected.Status != "inspected" || inspected.Snapshot == nil {
		t.Fatalf("inspection failed: %+v", inspected)
	}
	if inspected.Snapshot.Metadata.Xattrs["security.selinux"] != hash(before) {
		t.Fatal("review snapshot did not bind the real label digest")
	}
	plan := &files.Plan{Version: 1, TransactionID: "selinux-transaction", Before: *inspected.Snapshot, ContentSHA256: hash(next), ContentSize: len(next), MetadataPolicy: "preserve-or-refuse",
		Runtime: files.Artifact{ProtocolVersion: 1, Platform: "linux", Arch: "amd64", SHA256: hash([]byte("fixture-helper")), Size: 1}}
	request := files.Request{Plan: plan, Fingerprint: hash([]byte("reviewed-file-operation")), Action: "write", ContentBase64: base64.StdEncoding.EncodeToString(next)}
	result := files.Handle("apply", request)
	if result.Status != "succeeded" || result.Stage != "confirmed" || result.Receipt == nil {
		t.Fatalf("file commit failed under enforcing SELinux: %+v", result)
	}
	after := label(t, path)
	if !bytes.Equal(after, before) {
		t.Fatalf("SELinux label changed: %q -> %q", before, after)
	}
	t.Logf("target label after: %s", bytes.TrimRight(after, "\x00"))
	actual, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(actual, next) {
		t.Fatalf("replacement content mismatch: %v", err)
	}
	backup, err := os.ReadFile(result.Backup)
	if err != nil || !bytes.Equal(backup, old) {
		t.Fatalf("recovery copy mismatch: %v", err)
	}
	observed := files.Handle("inspect", files.Request{Path: path})
	if observed.Snapshot == nil || observed.Snapshot.Metadata.UID != plan.Before.Metadata.UID || observed.Snapshot.Metadata.GID != plan.Before.Metadata.GID || observed.Snapshot.Metadata.Mode != plan.Before.Metadata.Mode {
		t.Fatal("replacement changed basic metadata")
	}
	if recovered := files.Handle("recover", request); recovered.Status != "succeeded" {
		t.Fatalf("committed receipt could not be verified: %+v", recovered)
	}
	if cleaned := files.Handle("cleanup", request); cleaned.Status != "cleaned" {
		t.Fatalf("private recovery resources could not be cleaned: %+v", cleaned)
	}
}
