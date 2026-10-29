// Package su isolates authentication from every business process and its input.
package su

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/privilege"
	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type connectPayload struct {
	RootDirectory string `json:"rootDirectory"`
	SHA256        string `json:"sha256"`
}
type frame struct {
	protocol.Binding
	Type      string  `json:"type"`
	ID        string  `json:"id,omitempty"`
	Answer    *string `json:"answer,omitempty"`
	Data      string  `json:"data,omitempty"`
	Mode      string  `json:"mode,omitempty"`
	Directory string  `json:"rootDirectory,omitempty"`
	SHA256    string  `json:"sha256,omitempty"`
}

func id() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("random-unavailable")
	}
	return hex.EncodeToString(b)
}
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// Bootstrap copies the running image to a root-owned exclusive directory and checks
// its expected artifact digest before root executes any bytes from that image.
func Bootstrap(directory, digest, socket, token string, pid int) (string, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || !strings.HasPrefix(filepath.Base(directory), "cloudhelm-root-") || len(directory) > 512 {
		return "", errors.New("invalid-root-directory")
	}
	if len(digest) != 64 {
		return "", errors.New("invalid-artifact")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return "", errors.New("invalid-artifact")
	}
	target := filepath.Join(directory, "helper")
	// Every ancestor must be root-owned; writable ancestors must have sticky-bit
	// protection. A user-writable home must never contain the root executable.
	script := `set -eu
umask 077
p=` + quote(filepath.Dir(directory)) + `
while :; do
 [ "$(stat -c %u -- "$p")" = 0 ] || exit 71
 m=$(stat -c %a -- "$p")
 [ $((0$m & 0022)) = 0 ] || [ $((0$m & 01000)) != 0 ] || exit 71
 [ ! -L "$p" ] || exit 71
 [ "$p" = / ] && break
 p=${p%/*}; [ -n "$p" ] || p=/
done
mkdir -- ` + quote(directory) + `
cp -- ` + quote(fmt.Sprintf("/proc/%d/exe", pid)) + ` ` + quote(target) + ` || exit 72
chmod 700 -- ` + quote(target) + ` || exit 73
printf '%s\n' ` + quote(digest+"  "+target) + ` | sha256sum -c - >/dev/null || exit 74
` + quote(target) + ` --su-root ` + quote(socket) + ` ` + quote(token) + ` ` + quote(digest) + ` ` + quote(directory) + ` ` + fmt.Sprint(pid)
	return script, nil
}

func Run(in io.Reader, out io.Writer) error {
	reader := protocol.NewReader(in)
	var req protocol.Request
	if reader.Next(&req) != nil || !req.Binding.Valid() || req.Type != "connect" {
		return errors.New("invalid-connect")
	}
	w := protocol.NewWriter(out, req.Binding)
	fail := func(code string) error { _ = w.Emit("error", map[string]any{"code": code}); return errors.New(code) }
	var payload connectPayload
	if json.Unmarshal(req.Payload, &payload) != nil {
		return fail("unsupported")
	}
	self, err := os.Executable()
	if err != nil {
		return fail("unsupported")
	}
	socket := filepath.Join(filepath.Dir(self), "su-"+id()+".sock")
	token := id()
	command, err := Bootstrap(payload.RootDirectory, payload.SHA256, socket, token, os.Getpid())
	if err != nil {
		return fail("unsupported")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return fail("unsupported")
	}
	defer listener.Close()
	defer os.Remove(socket)
	if os.Chmod(socket, 0600) != nil {
		return fail("unsupported")
	}
	suPath := "/usr/bin/su"
	if _, err = os.Stat(suPath); err != nil {
		suPath = "/bin/su"
	}
	master, slave, err := pty.Open()
	if err != nil {
		return fail("unsupported")
	}
	defer master.Close()
	defer slave.Close()
	cmd := exec.Command(suPath, "-s", "/bin/sh", "root", "-c", command)
	trusted, trustedErr := privilege.Bind(cmd, suPath)
	if trustedErr != nil {
		return fail("unsupported")
	}
	defer trusted.Close()
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "TERM=dumb"}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if cmd.Start() != nil {
		return fail("unsupported")
	}
	ready := false
	defer func() {
		if !ready {
			_ = unix.Kill(-cmd.Process.Pid, unix.SIGTERM)
		}
	}()
	processDone := make(chan struct{})
	processCode := 0
	go func() {
		if e := cmd.Wait(); e != nil {
			if status, ok := e.(*exec.ExitError); ok {
				processCode = status.ExitCode()
			} else {
				processCode = -1
			}
		}
		close(processDone)
	}()
	controls := make(chan frame)
	controlDone := make(chan struct{})
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer close(controlDone)
		for {
			var m frame
			if reader.Next(&m) != nil || !m.Binding.Equal(req.Binding) {
				return
			}
			select {
			case controls <- m:
			case <-done:
				return
			}
		}
	}()
	prompts := make(chan []byte)
	go func() {
		b := make([]byte, 4096)
		for {
			n, e := master.Read(b)
			if e != nil {
				return
			}
			chunk := append([]byte(nil), b[:n]...)
			select {
			case prompts <- chunk:
			case <-done:
				return
			}
		}
	}()
	accepted := make(chan *net.UnixConn, 1)
	go func() {
		c, e := listener.AcceptUnix()
		if e != nil {
			return
		}
		if !peerUID(c, 0) {
			c.Close()
			return
		}
		select {
		case accepted <- c:
		case <-done:
			c.Close()
		}
	}()
	deadline := time.NewTimer(120 * time.Second)
	defer deadline.Stop()
	var peer *net.UnixConn
	defer func() {
		if peer != nil {
			peer.Close()
		}
	}()
	var prompt []byte
	waiting := ""
	attempts := 0
	for !ready {
		select {
		case <-deadline.C:
			return fail("timeout")
		case <-controlDone:
			return fail("cancelled")
		case <-processDone:
			_ = w.Emit("error", map[string]any{"code": "authentication-unconfirmed", "bootstrapExit": processCode})
			return errors.New("authentication-unconfirmed")
		case chunk := <-prompts:
			prompt = append(prompt, chunk...)
			if len(prompt) > 4096 {
				prompt = prompt[len(prompt)-4096:]
			}
			if waiting == "" && strings.HasSuffix(strings.TrimSpace(string(prompt)), "Password:") {
				settings, e := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
				if e != nil || settings.Lflag&unix.ECHO != 0 || attempts >= 3 {
					return fail("unsupported")
				}
				attempts++
				waiting = id()
				prompt = nil
				_ = w.Emit("auth", map[string]any{"id": waiting, "prompt": "su root 身份验证", "mechanism": "su", "kind": "unknown", "processId": fmt.Sprint(cmd.Process.Pid)})
			}
		case m := <-controls:
			if m.Type == "cancel" {
				return fail("cancelled")
			}
			if m.Type != "answer" || waiting == "" || m.ID != waiting {
				continue
			}
			if m.Answer == nil || !protocol.ValidSecret(*m.Answer) {
				return fail("cancelled")
			}
			settings, e := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
			if e != nil || settings.Lflag&unix.ECHO != 0 {
				return fail("authentication-unconfirmed")
			}
			select {
			case <-processDone:
				return fail("authentication-unconfirmed")
			default:
			}
			data := append([]byte(*m.Answer), '\n')
			_, e = master.Write(data)
			protocol.Clear(data)
			m.Answer = nil
			if e != nil {
				return fail("transport-unavailable")
			}
			_ = w.Emit("auth-close", map[string]any{"id": waiting})
			waiting = ""
		case peer = <-accepted:
			_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
			var hello rootHello
			if protocol.NewReader(peer).Next(&hello) != nil || hello.Token != token || hello.UID != 0 || hello.SHA256 != payload.SHA256 {
				return fail("authentication-unconfirmed")
			}
			_ = peer.SetReadDeadline(time.Time{})
			ready = true
		}
	}
	_ = w.Emit("ready", map[string]any{"uid": 0, "euid": 0, "rootDirectory": payload.RootDirectory})
	// No more authentication-PTY reads or writes occur after root identity is proved.
	return relay(peer, controls, controlDone, done, w, payload.RootDirectory, payload.SHA256)
}

func peerUID(c *net.UnixConn, uid uint32) bool {
	raw, e := c.SyscallConn()
	if e != nil {
		return false
	}
	valid := false
	_ = raw.Control(func(fd uintptr) {
		p, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		valid = err == nil && p.Uid == uid
	})
	return valid
}
func relay(peer *net.UnixConn, controls <-chan frame, controlDone <-chan struct{}, done <-chan struct{}, w *protocol.Writer, directory, digest string) error {
	output := make(chan json.RawMessage)
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		r := protocol.NewReader(peer)
		for {
			var value json.RawMessage
			if r.Next(&value) != nil {
				return
			}
			select {
			case output <- value:
			case <-done:
				return
			}
		}
	}()
	cleaning := false
	for {
		select {
		case <-controlDone:
			return errors.New("controller-closed")
		case <-closed:
			return errors.New("root-closed")
		case value := <-output:
			var event struct {
				Type      string `json:"type"`
				Directory string `json:"rootDirectory"`
				SHA256    string `json:"sha256"`
			}
			if json.Unmarshal(value, &event) == nil && event.Type == "cleanup-confirmed" {
				if !cleaning || event.Directory != directory || event.SHA256 != digest {
					return errors.New("invalid-cleanup")
				}
				return w.Emit("cleanup-confirmed", map[string]any{"rootDirectory": directory, "sha256": digest})
			}
			if w.Emit("output", map[string]any{"data": string(value) + "\n"}) != nil {
				return errors.New("controller-closed")
			}
		case m := <-controls:
			if cleaning || (m.Type != "start" && m.Type != "control" && m.Type != "end" && m.Type != "cleanup") {
				return errors.New("invalid-control")
			}
			if m.Type == "cleanup" {
				if m.Directory != directory || m.SHA256 != digest {
					return errors.New("invalid-cleanup")
				}
				cleaning = true
			}
			if json.NewEncoder(peer).Encode(m) != nil {
				return errors.New("root-closed")
			}
		}
	}
}
