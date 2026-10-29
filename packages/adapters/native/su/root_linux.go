package su

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"golang.org/x/sys/unix"
)

type rootHello struct {
	Token  string `json:"token"`
	UID    int    `json:"uid"`
	SHA256 string `json:"sha256"`
}

// Root only runs from a verified private copy. Its transport is independent of
// su's authentication tty and no business child inherits that tty.
func Root(socket, token, digest, directory string) error {
	if os.Getuid() != 0 || os.Geteuid() != 0 {
		return errors.New("root-required")
	}
	self, err := os.Executable()
	if err != nil || self != filepath.Join(directory, "helper") {
		return errors.New("invalid-root-image")
	}
	stat, err := os.Lstat(directory)
	if err != nil || !stat.IsDir() || stat.Mode().Perm() != 0700 || stat.Sys().(*syscall.Stat_t).Uid != 0 {
		return errors.New("invalid-root-directory")
	}
	binary, err := os.ReadFile(self)
	if err != nil {
		return errors.New("invalid-root-image")
	}
	hash := sha256.Sum256(binary)
	if hex.EncodeToString(hash[:]) != digest {
		return errors.New("invalid-root-image")
	}
	signal.Ignore(syscall.SIGHUP)
	null, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		return err
	}
	for _, fd := range []int{0, 1, 2} {
		if int(null.Fd()) != fd && unix.Dup3(int(null.Fd()), fd, 0) != nil {
			return errors.New("detach-failed")
		}
	}
	if null.Fd() > 2 {
		null.Close()
	}
	_, _ = syscall.Setsid()
	connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return errors.New("root-link-failed")
	}
	defer connection.Close()
	if json.NewEncoder(connection).Encode(rootHello{Token: token, UID: os.Getuid(), SHA256: digest}) != nil {
		return errors.New("root-link-failed")
	}
	var active *exec.Cmd
	var input io.WriteCloser
	var outputDone chan struct{}
	var processDone chan struct{}
	var output io.ReadCloser
	var writer sync.Mutex
	stop := func() {
		if input != nil {
			input.Close()
			input = nil
		}
		if active != nil {
			select {
			case <-processDone:
			case <-time.After(3 * time.Second):
				// Only terminate the controller. A business child uses a separate
				// session; its result remains unknown until independently verified.
				_ = active.Process.Kill()
				_ = output.Close()
				<-processDone
			}
			active = nil
		}
		if outputDone != nil {
			<-outputDone
			outputDone = nil
		}
	}
	defer stop()
	reader := protocol.NewReader(connection)
	for {
		var message frame
		if reader.Next(&message) != nil {
			return nil
		}
		switch message.Type {
		case "start":
			if active != nil {
				stop()
			}
			mode := "--serve"
			if message.Mode == "files" {
				mode = "--files"
			} else if message.Mode != "" && message.Mode != "serve" {
				return errors.New("invalid-mode")
			}
			child := exec.Command(self, mode)
			child.Env = os.Environ()
			pipe, e := child.StdinPipe()
			if e != nil {
				return e
			}
			childOutput, e := child.StdoutPipe()
			if e != nil {
				pipe.Close()
				return e
			}
			child.Stderr = nil
			if child.Start() != nil {
				pipe.Close()
				return errors.New("launch-failed")
			}
			active = child
			output = childOutput
			input = pipe
			outputDone = make(chan struct{})
			processDone = make(chan struct{})
			finished := outputDone
			go func() {
				defer close(finished)
				reader := protocol.NewReader(childOutput)
				for {
					var raw json.RawMessage
					if reader.Next(&raw) != nil {
						return
					}
					writer.Lock()
					_ = connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
					err := json.NewEncoder(connection).Encode(raw)
					writer.Unlock()
					if err != nil {
						return
					}
				}
			}()
			waited := processDone
			go func() { <-finished; _ = child.Wait(); close(waited) }()
		case "control":
			if input == nil {
				return errors.New("missing-process")
			}
			if len(message.Data) > 2*1024*1024 {
				return errors.New("invalid-frame")
			}
			if _, err = input.Write([]byte(message.Data)); err != nil {
				return err
			}
		case "end":
			stop()
		default:
			return errors.New("invalid-control")
		}
	}
}
