// Package privilege pins OS authentication programs before exposing credentials.
package privilege

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// Bind executes the same opened inode that passed validation. Resolving PATH
// alone would let a writable sudo wrapper impersonate the authentication program.
// Keeping Args untouched preserves the command approved by the application.
func Bind(cmd *exec.Cmd, executable string) (*os.File, error) {
	fd, err := unix.Open(executable, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("untrusted-authentication-program")
	}
	file := os.NewFile(uintptr(fd), executable)
	fail := func() (*os.File, error) { file.Close(); return nil, errors.New("untrusted-authentication-program") }
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSetuid == 0 || info.Mode().Perm()&0022 != 0 {
		return fail()
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != 0 {
		return fail()
	}
	// Setuid is ignored for scripts. Refuse them before creating any challenge.
	read, err := os.Open(fmt.Sprintf("/proc/self/fd/%d", fd))
	if err != nil {
		return fail()
	}
	var header [4]byte
	n, err := read.ReadAt(header[:], 0)
	read.Close()
	if err != nil || n != len(header) || !bytes.Equal(header[:], []byte{0x7f, 'E', 'L', 'F'}) {
		return fail()
	}
	childFD := 3 + len(cmd.ExtraFiles)
	cmd.ExtraFiles = append(cmd.ExtraFiles, file)
	cmd.Path = fmt.Sprintf("/proc/self/fd/%d", childFD)
	return file, nil
}
