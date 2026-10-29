//go:build linux

package files

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"golang.org/x/sys/unix"
)

func identity(st *unix.Stat_t) Identity {
	return Identity{strconv.FormatUint(uint64(st.Dev), 10), strconv.FormatUint(st.Ino, 10), st.Size, strconv.FormatInt(st.Mtim.Sec*1e9+st.Mtim.Nsec, 10), strconv.FormatInt(st.Ctim.Sec*1e9+st.Ctim.Nsec, 10)}
}
func sum(content []byte) string     { value := sha256.Sum256(content); return hex.EncodeToString(value[:]) }
func sameParent(a, b Identity) bool { return a.Device == b.Device && a.Inode == b.Inode }
func openParent(path string) (int, string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || strings.ContainsRune(path, 0) {
		return -1, "", errInvalid
	}
	fd, err := unix.Open("/", unix.O_DIRECTORY|unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, "", err
	}
	for _, part := range strings.Split(strings.TrimPrefix(filepath.Dir(path), "/"), "/") {
		if part == "" {
			continue
		}
		next, e := unix.Openat(fd, part, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if e != nil {
			return -1, "", e
		}
		fd = next
	}
	// Pseudo-filesystem 'regular files' do not provide managed file semantics.
	var fs unix.Statfs_t
	if err = unix.Fstatfs(fd, &fs); err != nil {
		unix.Close(fd)
		return -1, "", err
	}
	switch uint64(fs.Type) {
	case 0x9fa0, 0x62656572, 0x1cd1, 0x63677270, 0x27e0eb, 0x74726163:
		unix.Close(fd)
		return -1, "", errUnsupported
	}
	return fd, filepath.Base(path), nil
}
func parentIdentity(fd int) (Identity, error) {
	var st unix.Stat_t
	err := unix.Fstat(fd, &st)
	return identity(&st), err
}
func metadata(fd int, st *unix.Stat_t) (Metadata, error) {
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Mode&06000 != 0 {
		return Metadata{}, errUnsupported
	}
	// Flags affecting replace semantics are refused rather than silently discarded.
	flags, err := unix.IoctlGetInt(fd, unix.FS_IOC_GETFLAGS)
	if err == nil && flags & ^(0x80000|0x10000000) != 0 {
		return Metadata{}, errUnsupported
	}
	if err != nil && !errors.Is(err, unix.ENOTTY) && !errors.Is(err, unix.EOPNOTSUPP) && !errors.Is(err, unix.EINVAL) {
		return Metadata{}, err
	}
	size, err := unix.Flistxattr(fd, nil)
	if errors.Is(err, unix.ENOTSUP) {
		size = 0
		err = nil
	}
	if err != nil {
		return Metadata{}, err
	}
	if size > 65536 {
		return Metadata{}, errUnsupported
	}
	names := make([]byte, size)
	if size > 0 {
		n, e := unix.Flistxattr(fd, names)
		if e != nil {
			return Metadata{}, e
		}
		names = names[:n]
	}
	attrs := map[string]string{}
	total := 0
	for _, name := range strings.Split(string(names), "\x00") {
		if name == "" {
			continue
		}
		if !strings.HasPrefix(name, "user.") && name != "system.posix_acl_access" && name != "security.selinux" {
			return Metadata{}, errUnsupported
		}
		n, e := unix.Fgetxattr(fd, name, nil)
		if e != nil {
			return Metadata{}, e
		}
		total += n
		if n < 0 || total > 65536 {
			return Metadata{}, errUnsupported
		}
		value := make([]byte, n)
		n, e = unix.Fgetxattr(fd, name, value)
		if e != nil {
			return Metadata{}, e
		}
		attrs[name] = sum(value[:n])
	}
	return Metadata{st.Uid, st.Gid, st.Mode & 0777, attrs}, nil
}

// O_PATH inspects the object without opening a device or waiting on a FIFO.
// Reopen the pinned regular inode through the kernel's proc fd view.
func openRegularAt(parent int, name string) (int, error) {
	probe, err := unix.Openat(parent, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	defer unix.Close(probe)
	var st unix.Stat_t
	if err = unix.Fstat(probe, &st); err != nil {
		return -1, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Size < 0 || st.Size > protocol.MaxFile {
		return -1, errUnsupported
	}
	var proc unix.Statfs_t
	if err = unix.Statfs("/proc/self/fd", &proc); err != nil || uint64(proc.Type) != 0x9fa0 {
		return -1, errUnsupported
	}
	fd, err := unix.Open("/proc/self/fd/"+strconv.Itoa(probe), unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var opened unix.Stat_t
	if err = unix.Fstat(fd, &opened); err != nil || identity(&opened) != identity(&st) {
		unix.Close(fd)
		return -1, errConflict
	}
	return fd, nil
}
func readSnapshot(parent int, name, path string) (Snapshot, []byte, error) {
	pid, err := parentIdentity(parent)
	if err != nil {
		return Snapshot{}, nil, err
	}
	snap := Snapshot{Path: path, Parent: pid}
	fd, err := openRegularAt(parent, name)
	if errors.Is(err, unix.ENOENT) {
		return snap, nil, nil
	}
	if err != nil {
		return snap, nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	var before unix.Stat_t
	if err = unix.Fstat(fd, &before); err != nil {
		return snap, nil, err
	}
	if before.Mode&unix.S_IFMT != unix.S_IFREG || before.Size < 0 || before.Size > protocol.MaxFile {
		return snap, nil, errUnsupported
	}
	meta, err := metadata(fd, &before)
	if err != nil {
		return snap, nil, err
	}
	content, err := io.ReadAll(io.LimitReader(file, protocol.MaxFile+1))
	if err != nil {
		return snap, nil, err
	}
	if len(content) > protocol.MaxFile {
		return snap, nil, errUnsupported
	}
	var after unix.Stat_t
	if err = unix.Fstat(fd, &after); err != nil {
		return snap, nil, err
	}
	if identity(&before) != identity(&after) || int64(len(content)) != before.Size {
		return snap, nil, errConflict
	}
	var named unix.Stat_t
	if err = unix.Fstatat(parent, name, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return snap, nil, err
	}
	if identity(&after) != identity(&named) {
		return snap, nil, errConflict
	}
	id := identity(&after)
	snap.Exists = true
	snap.Identity = &id
	snap.Metadata = &meta
	snap.SHA256 = sum(content)
	return snap, content, nil
}
func sameSnapshot(a, b Snapshot) bool {
	return a.Path == b.Path && sameParent(a.Parent, b.Parent) && a.Exists == b.Exists && reflect.DeepEqual(a.Identity, b.Identity) && reflect.DeepEqual(a.Metadata, b.Metadata) && a.SHA256 == b.SHA256
}
func inspectResult(path string) Result {
	parent, name, err := openParent(path)
	if err != nil {
		return failure(err, false)
	}
	defer unix.Close(parent)
	snap, content, err := readSnapshot(parent, name, path)
	if err != nil {
		return failure(err, false)
	}
	return Result{Status: "inspected", Effects: "none", Snapshot: &snap, ContentBase64: base64.StdEncoding.EncodeToString(content)}
}
func failure(err error, effects bool) Result {
	code := "io-error"
	if errors.Is(err, errConflict) {
		code = "conflict"
	} else if errors.Is(err, errUnsupported) {
		code = "unsupported"
	} else if errors.Is(err, errInvalid) {
		code = "invalid-request"
	} else if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
		code = "permission-denied"
	}
	status, stage, effect := "failed", "prepared", "none"
	if effects {
		status = "unknown"
		stage = "unknown"
		effect = "possible"
	}
	if code == "conflict" && !effects {
		stage = "conflict"
	}
	return Result{Status: status, Stage: stage, Effects: effect, Code: code}
}
func writeFileAt(dir int, name string, data []byte, mode uint32) (int, error) {
	fd, err := unix.Openat(dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode)
	if err != nil {
		return -1, err
	}
	file := os.NewFile(uintptr(fd), name)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if err != nil {
		file.Close()
		return -1, err
	}
	dup, err := unix.Dup(fd)
	file.Close()
	return dup, err
}
func copyMetadata(parent int, name string, fd int, before Snapshot) error {
	source, err := openRegularAt(parent, name)
	if err != nil {
		return err
	}
	defer unix.Close(source)
	var sourceStat unix.Stat_t
	if err = unix.Fstat(source, &sourceStat); err != nil {
		return err
	}
	if before.Identity == nil || identity(&sourceStat) != *before.Identity || before.Metadata == nil {
		return errConflict
	}
	meta := *before.Metadata

	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Uid != meta.UID || st.Gid != meta.GID {
		if err := unix.Fchown(fd, int(meta.UID), int(meta.GID)); err != nil {
			return err
		}
	}
	if err := unix.Fchmod(fd, meta.Mode); err != nil {
		return err
	}
	for name, expectedHash := range meta.Xattrs {
		size, err := unix.Fgetxattr(source, name, nil)
		if err != nil {
			return err
		}
		if size < 0 || size > 65536 {
			return errUnsupported
		}
		data := make([]byte, size)
		n, err := unix.Fgetxattr(source, name, data)
		if err != nil {
			return err
		}
		data = data[:n]
		if sum(data) != expectedHash {
			return errConflict
		}
		if err = unix.Fsetxattr(fd, name, data, 0); err != nil {
			return err
		}
		for i := range data {
			data[i] = 0
		}
	}

	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	got, err := metadata(fd, &st)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(got, meta) {
		return fmt.Errorf("metadata-not-preserved")
	}
	return unix.Fsync(fd)
}
