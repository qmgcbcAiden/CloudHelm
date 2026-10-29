//go:build linux

package files_test

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/files"
	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"golang.org/x/sys/unix"
)

func hash(data string) string { s := sha256.Sum256([]byte(data)); return hex.EncodeToString(s[:]) }
func plan(t *testing.T, path, content string) *files.Plan {
	t.Helper()
	r := files.Handle("inspect", files.Request{Path: path})
	if r.Status != "inspected" {
		t.Fatalf("inspect: %+v", r)
	}
	return &files.Plan{Version: 1, TransactionID: "txn-1", Before: *r.Snapshot, ContentSHA256: hash(content), ContentSize: len(content), MetadataPolicy: "preserve-or-refuse", Runtime: files.Artifact{ProtocolVersion: 1, Platform: "linux", Arch: "amd64", SHA256: hash("binary"), Size: 1}}
}
func request(p *files.Plan, content string) files.Request {
	return files.Request{Plan: p, Fingerprint: hash("operation"), Action: "write", ContentBase64: base64.StdEncoding.EncodeToString([]byte(content))}
}
func TestReplacePreservesMetadataAndReceipt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte("old"), 0640); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, 123, 456); err != nil {
			t.Fatal(err)
		}
	}
	p := plan(t, path, "new")
	r := files.Handle("apply", request(p, "new"))
	if r.Status != "succeeded" || r.Stage != "confirmed" || r.Receipt == nil {
		t.Fatalf("apply: %+v", r)
	}
	after := files.Handle("inspect", files.Request{Path: path})
	if after.Snapshot.Metadata.UID != p.Before.Metadata.UID || after.Snapshot.Metadata.GID != p.Before.Metadata.GID || after.Snapshot.Metadata.Mode != 0640 {
		t.Fatalf("metadata changed: %+v", after.Snapshot)
	}
	backup, err := os.ReadFile(r.Backup)
	if err != nil || string(backup) != "old" {
		t.Fatalf("backup: %q %v", backup, err)
	}
	assertBackup(t, r, p.Before, "old")
	recovered := files.Handle("recover", request(p, "new"))
	if recovered.Status != "succeeded" {
		t.Fatalf("recover: %+v", recovered)
	}
	cleaned := files.Handle("cleanup", request(p, "new"))
	if cleaned.Status != "cleaned" {
		t.Fatalf("cleanup: %+v", cleaned)
	}
	if _, err = os.Stat(r.Directory); !os.IsNotExist(err) {
		t.Fatalf("cleanup did not remove private transaction: %v", err)
	}
}
func assertBackup(t *testing.T, result files.Result, before files.Snapshot, content string) {
	t.Helper()
	backup := files.Handle("inspect", files.Request{Path: result.Backup})
	if backup.Status != "inspected" || backup.Snapshot == nil || backup.Snapshot.SHA256 != hash(content) || !reflect.DeepEqual(backup.Snapshot.Metadata, before.Metadata) {
		t.Fatalf("backup does not preserve original content and metadata: %+v", backup)
	}
	var directory unix.Stat_t
	if err := unix.Stat(result.Directory, &directory); err != nil || directory.Mode&0777 != 0700 || directory.Uid != uint32(os.Geteuid()) {
		t.Fatalf("recovery directory is not private: %+v %v", directory, err)
	}
}
func TestDeleteRetainsOriginalMetadataInPrivateBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, 123, 456); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Setxattr(path, "user.recovery", []byte("recovery-attribute"), 0); err != nil {
		t.Fatal(err)
	}
	p := plan(t, path, "")
	p.ContentSHA256 = ""
	req := files.Request{Plan: p, Fingerprint: hash("operation"), Action: "delete"}
	result := files.Handle("apply", req)
	if result.Status != "succeeded" || result.Receipt == nil || !result.Receipt.Deleted {
		t.Fatalf("delete: %+v", result)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("target was not deleted: %v", err)
	}
	assertBackup(t, result, p.Before, "old")
}
func TestRejectsChangedTargetBeforeAnyStaging(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	os.WriteFile(path, []byte("old"), 0600)
	p := plan(t, path, "new")
	os.WriteFile(path, []byte("external"), 0600)
	r := files.Handle("apply", request(p, "new"))
	if r.Code != "conflict" || r.Effects != "none" {
		t.Fatalf("%+v", r)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "external" {
		t.Fatal("overwrote conflicting contents")
	}
}
func TestRefusesSpecialFilesLinksAndOversize(t *testing.T) {
	root := t.TempDir()
	fifo := filepath.Join(root, "fifo")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	r := files.Handle("inspect", files.Request{Path: fifo})
	if r.Code != "unsupported" || time.Since(start) > time.Second {
		t.Fatalf("FIFO was not promptly rejected: %+v", r)
	}
	file := filepath.Join(root, "file")
	os.WriteFile(file, []byte("a"), 0600)
	os.Link(file, filepath.Join(root, "alias"))
	if r = files.Handle("inspect", files.Request{Path: file}); r.Code != "unsupported" {
		t.Fatalf("hardlink: %+v", r)
	}
	os.Remove(filepath.Join(root, "alias"))
	unix.Chmod(file, 04755)
	if r = files.Handle("inspect", files.Request{Path: file}); r.Code != "unsupported" {
		t.Fatalf("setuid: %+v", r)
	}
	unix.Chmod(file, 0600)
	os.Truncate(file, protocol.MaxFile+1)
	if r = files.Handle("inspect", files.Request{Path: file}); r.Code != "unsupported" {
		t.Fatalf("oversize: %+v", r)
	}
	link := filepath.Join(root, "linked")
	os.Symlink(root, link)
	if r = files.Handle("inspect", files.Request{Path: filepath.Join(link, "file")}); r.Status != "failed" {
		t.Fatalf("symlink parent: %+v", r)
	}
}
func TestAttributeValuesNeverEnterManifest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	os.WriteFile(path, []byte("old"), 0600)
	secret := []byte("private-xattr-value")
	if err := unix.Setxattr(path, "user.private", secret, 0); err != nil {
		t.Fatalf("fixture filesystem must support xattrs: %v", err)
	}
	p := plan(t, path, "new")
	if p.Before.Metadata.Xattrs["user.private"] != hash(string(secret)) {
		t.Fatal("snapshot must contain only xattr digest")
	}
	r := files.Handle("apply", request(p, "new"))
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	data, err := os.ReadFile(filepath.Join(r.Directory, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, secret) || bytes.Contains(data, []byte(base64.StdEncoding.EncodeToString(secret))) {
		t.Fatal("xattr leaked into receipt")
	}
	value := make([]byte, 100)
	n, err := unix.Getxattr(path, "user.private", value)
	if err != nil || !bytes.Equal(value[:n], secret) {
		t.Fatalf("attribute not preserved: %v", err)
	}
	assertBackup(t, r, p.Before, "old")
	n, err = unix.Getxattr(r.Backup, "user.private", value)
	if err != nil || !bytes.Equal(value[:n], secret) {
		t.Fatalf("recovery attribute not preserved: %v", err)
	}
}
func staged(t *testing.T, req files.Request) (*io.PipeWriter, *bufio.Scanner, <-chan error) {
	t.Helper()
	in, write := io.Pipe()
	out, read := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- files.Run(in, read); read.Close(); in.Close() }()
	payload, _ := json.Marshal(req)
	frame := protocol.Request{Binding: protocol.Binding{Version: 1, SessionID: "session", OperationID: "operation", Generation: 1}, Type: "apply", Payload: payload}
	raw, _ := json.Marshal(frame)
	go func() { write.Write(append(raw, '\n')) }()
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), protocol.MaxFrame)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"file-staged"`) {
		t.Fatalf("did not stage: %s %v", scanner.Text(), scanner.Err())
	}
	return write, scanner, done
}
func TestRevocationAtCommitBoundaryLeavesOriginal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	os.WriteFile(path, []byte("old"), 0600)
	req := request(plan(t, path, "new"), "new")
	write, scanner, done := staged(t, req)
	write.Close()
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"status":"unknown"`) {
		t.Fatalf("no unknown result: %s", scanner.Text())
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "old" {
		t.Fatal("committed after EOF")
	}
	r := files.Handle("recover", req)
	if r.Status != "unknown" || r.Code != "original-observed" {
		t.Fatalf("%+v", r)
	}
	if r = files.Handle("cleanup", req); r.Code != "unsupported" {
		t.Fatalf("cleaned unresolved transaction: %+v", r)
	}
}
func TestLastVersionRecheckRejectsConflict(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	os.WriteFile(path, []byte("old"), 0600)
	req := request(plan(t, path, "new"), "new")
	write, scanner, done := staged(t, req)
	os.WriteFile(path, []byte("external"), 0600)
	commit := protocol.Request{Binding: protocol.Binding{Version: 1, SessionID: "session", OperationID: "operation", Generation: 1}, Type: "file-commit"}
	raw, _ := json.Marshal(commit)
	go func() { write.Write(append(raw, '\n')); write.Close() }()
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"code":"conflict"`) {
		t.Fatalf("no conflict: %s", scanner.Text())
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "external" {
		t.Fatal("overwrote external update")
	}
}
func TestReceiptIsBoundAndRecoveryDoesNotClaimMissingReceipt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	req := request(plan(t, path, "new"), "new")
	r := files.Handle("apply", req)
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	changed := req
	changed.Fingerprint = hash("other")
	if out := files.Handle("recover", changed); out.Status != "unknown" || out.Receipt != nil {
		t.Fatalf("accepted unbound receipt: %+v", out)
	}
	manifestPath := filepath.Join(r.Directory, "manifest.json")
	data, _ := os.ReadFile(manifestPath)
	var m map[string]any
	json.Unmarshal(data, &m)
	delete(m, "receipt")
	m["stage"] = "staged"
	data, _ = json.Marshal(m)
	os.WriteFile(manifestPath, data, 0600)
	out := files.Handle("recover", req)
	if out.Status != "unknown" || out.Code != "matches-without-receipt" {
		t.Fatalf("invented history from matching content: %+v", out)
	}
}

func TestParentReplacementAfterStagingCannotRedirectCommit(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "parent")
	os.Mkdir(parent, 0700)
	path := filepath.Join(parent, "file")
	os.WriteFile(path, []byte("old"), 0600)
	req := request(plan(t, path, "new"), "new")
	write, scanner, done := staged(t, req)
	moved := filepath.Join(root, "moved")
	if err := os.Rename(parent, moved); err != nil {
		t.Fatal(err)
	}
	os.Mkdir(parent, 0700)
	os.WriteFile(path, []byte("other"), 0600)
	commit := protocol.Request{Binding: protocol.Binding{Version: 1, SessionID: "session", OperationID: "operation", Generation: 1}, Type: "file-commit"}
	raw, _ := json.Marshal(commit)
	go func() { write.Write(append(raw, '\n')); write.Close() }()
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"code":"conflict"`) {
		t.Fatalf("parent change not rejected: %s", scanner.Text())
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(filepath.Join(moved, "file"))
	current, _ := os.ReadFile(path)
	if string(original) != "old" || string(current) != "other" {
		t.Fatal("changed a moved or substituted directory")
	}
}

func sendCommit(write *io.PipeWriter) {
	commit := protocol.Request{Binding: protocol.Binding{Version: 1, SessionID: "session", OperationID: "operation", Generation: 1}, Type: "file-commit"}
	raw, _ := json.Marshal(commit)
	go func() { write.Write(append(raw, '\n')); write.Close() }()
}
func TestMissingStagedPayloadCannotTruncateOriginal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	os.WriteFile(path, []byte("old"), 0600)
	req := request(plan(t, path, "new"), "new")
	write, scanner, done := staged(t, req)
	if err := os.Remove(filepath.Join(filepath.Dir(path), ".cloudhelm-txn-txn-1", "new")); err != nil {
		t.Fatal(err)
	}
	sendCommit(write)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"status":"unknown"`) {
		t.Fatalf("missing payload not reported: %s", scanner.Text())
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "old" {
		t.Fatal("truncated target despite staging failure")
	}
}
func TestCommitReceiptDiskFailure(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=^TestFileDiskFaultChild$", "-test.v")
	command.Env = append(os.Environ(), "CLOUDHELM_FILE_FAULT_CHILD=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("file fault fixture failed: %v\n%s", err, output)
	}
}

// A separate test process scopes RLIMIT_FSIZE and SIGXFSZ to this fixture. There
// are no production fault switches and no privileged mounts or global changes.
func TestFileDiskFaultChild(t *testing.T) {
	if os.Getenv("CLOUDHELM_FILE_FAULT_CHILD") != "1" {
		return
	}
	path := filepath.Join(t.TempDir(), "file")
	os.WriteFile(path, []byte("old"), 0600)
	req := request(plan(t, path, "new"), "new")
	write, scanner, done := staged(t, req)
	var previous unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_FSIZE, &previous); err != nil {
		t.Fatal(err)
	}
	signal.Ignore(syscall.SIGXFSZ)
	if err := unix.Setrlimit(unix.RLIMIT_FSIZE, &unix.Rlimit{Cur: 0, Max: previous.Max}); err != nil {
		t.Fatal(err)
	}
	defer unix.Setrlimit(unix.RLIMIT_FSIZE, &previous)
	sendCommit(write)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"status":"unknown"`) {
		t.Fatalf("receipt write failure was not unknown: %s", scanner.Text())
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := unix.Setrlimit(unix.RLIMIT_FSIZE, &previous); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "new" {
		t.Fatalf("fixture did not reach commit: %q", data)
	}
	recovered := files.Handle("recover", req)
	if recovered.Status != "unknown" || recovered.Code != "matches-without-receipt" || recovered.Receipt != nil {
		t.Fatalf("manufactured receipt: %+v", recovered)
	}
}
func TestAccessACLPreservedByDescriptor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("old"), 0640); err != nil {
		t.Fatal(err)
	}
	acl := make([]byte, 44)
	binary.LittleEndian.PutUint32(acl, 2)
	entries := [][3]uint32{{1, 6, 0xffffffff}, {2, 4, 12345}, {4, 4, 0xffffffff}, {16, 4, 0xffffffff}, {32, 0, 0xffffffff}}
	for i, entry := range entries {
		offset := 4 + i*8
		binary.LittleEndian.PutUint16(acl[offset:], uint16(entry[0]))
		binary.LittleEndian.PutUint16(acl[offset+2:], uint16(entry[1]))
		binary.LittleEndian.PutUint32(acl[offset+4:], entry[2])
	}
	if err := unix.Setxattr(path, "system.posix_acl_access", acl, 0); err != nil {
		t.Fatalf("fixture filesystem must support access ACLs: %v", err)
	}
	p := plan(t, path, "new")
	if p.Before.Metadata.Xattrs["system.posix_acl_access"] != hash(string(acl)) {
		t.Fatal("ACL digest not bound")
	}
	r := files.Handle("apply", request(p, "new"))
	if r.Status != "succeeded" {
		t.Fatalf("ACL replace: %+v", r)
	}
	actual := make([]byte, 100)
	n, err := unix.Getxattr(path, "system.posix_acl_access", actual)
	if err != nil || !bytes.Equal(actual[:n], acl) {
		t.Fatalf("ACL lost: %v", err)
	}
	assertBackup(t, r, p.Before, "old")
	n, err = unix.Getxattr(r.Backup, "system.posix_acl_access", actual)
	if err != nil || !bytes.Equal(actual[:n], acl) {
		t.Fatalf("recovery ACL lost: %v", err)
	}
}

func TestCleanupRefusesUnrecognizedObjectsWithoutDeletingReceipt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	req := request(plan(t, path, "new"), "new")
	r := files.Handle("apply", req)
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	if err := os.WriteFile(filepath.Join(r.Directory, "unowned"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	result := files.Handle("cleanup", req)
	if result.Code != "unsupported" || result.Effects != "none" {
		t.Fatalf("unexpected cleanup: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(r.Directory, "manifest.json")); err != nil {
		t.Fatal("cleanup removed receipt before validating directory")
	}
}

func TestCleanupRefusesModifiedRecoveryCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	req := request(plan(t, path, "new"), "new")
	r := files.Handle("apply", req)
	if r.Status != "succeeded" {
		t.Fatalf("%+v", r)
	}
	if err := os.WriteFile(r.Backup, []byte("changed backup"), 0600); err != nil {
		t.Fatal(err)
	}
	if result := files.Handle("cleanup", req); result.Code != "unsupported" || result.Effects != "none" {
		t.Fatalf("removed modified backup: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(r.Directory, "manifest.json")); err != nil {
		t.Fatal("cleanup removed receipt before validating backup")
	}
}
