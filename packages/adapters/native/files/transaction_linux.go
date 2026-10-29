//go:build linux

package files

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"

	"golang.org/x/sys/unix"
)

func directory(plan *Plan) string { return ".cloudhelm-txn-" + plan.TransactionID }
func directoryPath(plan *Plan) string {
	return filepath.Join(filepath.Dir(plan.Before.Path), directory(plan))
}
func openTransaction(parent int, plan *Plan) (int, error) {
	fd, err := unix.Openat(parent, directory(plan), unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var st unix.Stat_t
	err = unix.Fstat(fd, &st)
	if err == nil && (st.Uid != uint32(os.Geteuid()) || st.Mode&0777 != 0700) {
		err = errUnsupported
	}
	if err != nil {
		unix.Close(fd)
		return -1, err
	}
	return fd, nil
}
func lockTransaction(dir int) (int, error) {
	fd, err := unix.Openat(dir, "lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return -1, err
	}
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		unix.Close(fd)
		return -1, err
	}
	return fd, nil
}
func writeManifest(dir int, m manifest) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	// Only the exclusive transaction owner can create this fixed private file.
	if err = unix.Unlinkat(dir, "manifest.next", 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	fd, err := writeFileAt(dir, "manifest.next", data, 0600)
	if err != nil {
		return err
	}
	unix.Close(fd)
	if err = unix.Renameat(dir, "manifest.next", dir, "manifest.json"); err != nil {
		return err
	}
	return unix.Fsync(dir)
}
func readManifest(dir int, req Request) (manifest, error) {
	fd, err := unix.Openat(dir, "manifest.json", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return manifest{}, err
	}
	file := os.NewFile(uintptr(fd), "manifest.json")
	defer file.Close()
	var st unix.Stat_t
	if err = unix.Fstat(fd, &st); err != nil {
		return manifest{}, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Size > 262144 || st.Uid != uint32(os.Geteuid()) {
		return manifest{}, errInvalid
	}
	data, err := io.ReadAll(io.LimitReader(file, 262145))
	if err != nil || len(data) > 262144 {
		return manifest{}, errInvalid
	}
	var m manifest
	if err = decode(data, &m); err != nil {
		return m, err
	}
	if m.Version != 1 || !reflect.DeepEqual(m.Plan, *req.Plan) || m.Fingerprint != req.Fingerprint || m.Action != req.Action {
		return m, errInvalid
	}
	return m, nil
}
func locate(result Result, plan *Plan) Result {
	result.Directory = directoryPath(plan)
	if plan.Before.Exists {
		result.Backup = filepath.Join(result.Directory, "backup")
	}
	return result
}
func apply(req Request, beforeCommit func(Result) error) Result {
	plan := req.Plan
	content, err := base64.StdEncoding.Strict().DecodeString(req.ContentBase64)
	if err != nil {
		return failure(errInvalid, false)
	}
	if req.Action == "write" {
		if len(content) != plan.ContentSize || !digest.MatchString(plan.ContentSHA256) || sum(content) != plan.ContentSHA256 {
			return failure(errInvalid, false)
		}
	} else if len(content) != 0 || plan.ContentSize != 0 || plan.ContentSHA256 != "" || !plan.Before.Exists {
		return failure(errInvalid, false)
	}
	parent, name, err := openParent(plan.Before.Path)
	if err != nil {
		return failure(err, false)
	}
	defer unix.Close(parent)
	before, old, err := readSnapshot(parent, name, plan.Before.Path)
	if err != nil {
		return failure(err, false)
	}
	if !sameSnapshot(before, plan.Before) {
		return failure(errConflict, false)
	}
	if err = unix.Mkdirat(parent, directory(plan), 0700); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return recoverTransaction(req)
		}
		return failure(err, false)
	}
	dir, err := openTransaction(parent, plan)
	if err != nil {
		return locate(failure(err, true), plan)
	}
	defer unix.Close(dir)
	lock, err := lockTransaction(dir)
	if err != nil {
		return locate(failure(err, true), plan)
	}
	defer unix.Close(lock)
	m := manifest{Version: 1, Plan: *plan, Fingerprint: req.Fingerprint, Action: req.Action, Stage: "prepared"}
	if err = writeManifest(dir, m); err != nil {
		return locate(failure(err, true), plan)
	}
	if before.Exists {
		fd, e := writeFileAt(dir, "backup", old, 0600)
		if e != nil {
			return locate(failure(e, true), plan)
		}
		unix.Close(fd)
	}
	if req.Action == "write" {
		fd, e := writeFileAt(dir, "new", content, 0600)
		if e != nil {
			return locate(failure(e, true), plan)
		}
		if before.Metadata != nil {
			e = copyMetadata(parent, name, fd, before)
		} else {
			e = unix.Fchmod(fd, 0600)
			if e == nil {
				e = unix.Fsync(fd)
			}
		}
		unix.Close(fd)
		if e != nil {
			return locate(failure(e, true), plan)
		}
	}
	m.Stage = "staged"
	if err = writeManifest(dir, m); err != nil {
		return locate(failure(err, true), plan)
	}
	if err = beforeCommit(locate(Result{Status: "unknown", Effects: "possible", Stage: "staged"}, plan)); err != nil {
		return locate(failure(err, true), plan)
	}
	// No general filesystem primitive offers hash-based compare-and-swap. This
	// last check detects changes before rename; non-cooperating writers can race.
	currentParent, _, reopenErr := openParent(plan.Before.Path)
	if reopenErr != nil {
		return locate(failure(errConflict, true), plan)
	}
	actualParent, reopenErr := parentIdentity(currentParent)
	unix.Close(currentParent)
	if reopenErr != nil || !sameParent(actualParent, plan.Before.Parent) {
		return locate(failure(errConflict, true), plan)
	}
	current, _, err := readSnapshot(parent, name, plan.Before.Path)
	if err != nil || !sameSnapshot(current, plan.Before) {
		if err == nil {
			err = errConflict
		}
		return locate(failure(err, true), plan)
	}
	if req.Action == "delete" {
		err = unix.Unlinkat(parent, name, 0)
	} else {
		if plan.Before.Exists {
			err = unix.Renameat(dir, "new", parent, name)
		} else {
			err = unix.Renameat2(dir, "new", parent, name, unix.RENAME_NOREPLACE)
			if errors.Is(err, unix.EEXIST) {
				err = errConflict
			}
			if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
				err = errUnsupported
			}
		}
	}
	if err != nil {
		return locate(failure(err, true), plan)
	}
	if err = unix.Fsync(parent); err != nil {
		return locate(failure(err, true), plan)
	}
	m.Stage = "committed"
	m.Receipt = &Receipt{plan.TransactionID, req.Fingerprint, plan.ContentSHA256, req.Action == "delete"}
	if err = writeManifest(dir, m); err != nil {
		return locate(failure(err, true), plan)
	}
	visibleParent, _, reopenErr := openParent(plan.Before.Path)
	if reopenErr != nil {
		return locate(failure(errConflict, true), plan)
	}
	visibleIdentity, reopenErr := parentIdentity(visibleParent)
	unix.Close(visibleParent)
	if reopenErr != nil || !sameParent(visibleIdentity, plan.Before.Parent) {
		return locate(failure(errConflict, true), plan)
	}
	after, _, err := readSnapshot(parent, name, plan.Before.Path)
	if err != nil || !matchesAfter(after, req) {
		if err == nil {
			err = errConflict
		}
		return locate(failure(err, true), plan)
	}
	m.Stage = "confirmed"
	if err = writeManifest(dir, m); err != nil {
		return locate(failure(err, true), plan)
	}
	return locate(Result{Status: "succeeded", Effects: "possible", Stage: "confirmed", Receipt: m.Receipt, Snapshot: &after}, plan)
}
func matchesAfter(snapshot Snapshot, req Request) bool {
	if req.Action == "delete" {
		return !snapshot.Exists
	}
	return snapshot.Exists && snapshot.SHA256 == req.Plan.ContentSHA256 && (req.Plan.Before.Metadata == nil || reflect.DeepEqual(snapshot.Metadata, req.Plan.Before.Metadata))
}
func recoverTransaction(req Request) Result {
	parent, name, err := openParent(req.Plan.Before.Path)
	if err != nil {
		return failure(err, true)
	}
	defer unix.Close(parent)
	pid, err := parentIdentity(parent)
	if err != nil || !sameParent(pid, req.Plan.Before.Parent) {
		return failure(errConflict, true)
	}
	dir, err := openTransaction(parent, req.Plan)
	if err != nil {
		return locate(failure(err, true), req.Plan)
	}
	defer unix.Close(dir)
	// Read-only recovery does not create, remove or upgrade any receipt.
	m, err := readManifest(dir, req)
	if err != nil {
		return locate(failure(err, true), req.Plan)
	}
	current, _, err := readSnapshot(parent, name, req.Plan.Before.Path)
	if err != nil {
		return locate(failure(err, true), req.Plan)
	}
	result := Result{Status: "unknown", Effects: "possible", Stage: m.Stage, Receipt: m.Receipt, Snapshot: &current}
	if (m.Stage == "committed" || m.Stage == "confirmed") && m.Receipt != nil && matchesAfter(current, req) {
		result.Status = "succeeded"
		result.Stage = "confirmed"
	} else if matchesAfter(current, req) {
		result.Code = "matches-without-receipt"
	} else if sameSnapshot(current, req.Plan.Before) {
		result.Code = "original-observed"
	} else {
		result.Code = "conflict"
	}
	return locate(result, req.Plan)
}
func cleanup(req Request) Result {
	parent, _, err := openParent(req.Plan.Before.Path)
	if err != nil {
		return failure(err, false)
	}
	defer unix.Close(parent)
	pid, err := parentIdentity(parent)
	if err != nil || !sameParent(pid, req.Plan.Before.Parent) {
		return failure(errConflict, false)
	}
	dir, err := openTransaction(parent, req.Plan)
	if err != nil {
		return failure(err, false)
	}
	defer unix.Close(dir)
	lock, err := lockTransaction(dir)
	if err != nil {
		return failure(err, false)
	}
	defer unix.Close(lock)
	m, err := readManifest(dir, req)
	if err != nil {
		return failure(err, false)
	}
	if m.Stage != "confirmed" || m.Receipt == nil {
		return failure(errUnsupported, false)
	}
	// Never recurse into a path discovered from untrusted filesystem contents.
	for _, name := range []string{"backup", "new", "manifest.next", "manifest.json", "lock"} {
		if err = unix.Unlinkat(dir, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return locate(failure(err, true), req.Plan)
		}
	}
	if err = unix.Unlinkat(parent, directory(req.Plan), unix.AT_REMOVEDIR); err != nil {
		return locate(failure(err, true), req.Plan)
	}
	if err = unix.Fsync(parent); err != nil {
		return locate(failure(err, true), req.Plan)
	}
	return Result{Status: "cleaned", Effects: "possible", Stage: "confirmed", Receipt: m.Receipt}
}
