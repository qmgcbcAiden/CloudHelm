package process

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"golang.org/x/sys/unix"
)

type authServer struct {
	mu          sync.Mutex
	listener    *net.UnixListener
	path, token string
	w           *protocol.Writer
	waiting     string
	answer      chan *string
	closed      bool
	attempts    int
}

func randomID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic("random-unavailable")
	}
	return hex.EncodeToString(value)
}

func newAuthServer(w *protocol.Writer) (*authServer, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(filepath.Dir(self), "auth-"+randomID())
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return &authServer{listener: listener, path: path, token: randomID(), w: w}, nil
}

func (a *authServer) Serve() {
	for {
		connection, err := a.listener.AcceptUnix()
		if err != nil {
			return
		}
		go a.authenticate(connection)
	}
}

func (a *authServer) authenticate(connection *net.UnixConn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(125 * time.Second))
	raw, err := connection.SyscallConn()
	if err != nil {
		return
	}
	validPeer := false
	_ = raw.Control(func(fd uintptr) {
		peer, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		validPeer = e == nil && peer.Uid == uint32(os.Getuid())
	})
	if !validPeer {
		return
	}
	var hello struct {
		Token  string `json:"token"`
		Prompt string `json:"prompt"`
	}
	reader := protocol.NewReader(io.LimitReader(connection, 8192))
	if reader.Next(&hello) != nil || subtle.ConstantTimeCompare([]byte(hello.Token), []byte(a.token)) != 1 || len(hello.Prompt) > 4096 {
		return
	}
	a.mu.Lock()
	if a.closed || a.waiting != "" || a.attempts >= 3 {
		a.mu.Unlock()
		_, _ = io.WriteString(connection, "null\n")
		return
	}
	a.attempts++
	id := randomID()
	answer := make(chan *string, 1)
	a.waiting = id
	a.answer = answer
	a.mu.Unlock()
	prompt := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, hello.Prompt)
	promptDigest := sha256.Sum256([]byte(hello.Prompt))
	if a.w.Emit("auth", map[string]any{"id": id, "prompt": prompt, "promptSha256": hex.EncodeToString(promptDigest[:]), "mechanism": "sudo", "kind": "unknown"}) != nil {
		a.Close()
		return
	}
	var value *string
	select {
	case value = <-answer:
	case <-time.After(120 * time.Second):
	}
	// Close the prior challenge before sudo can ask the next PAM question.
	// Otherwise concurrent askpass clients may reorder auth-close/auth frames.
	if a.w.Emit("auth-close", map[string]any{"id": id}) != nil {
		a.Close()
		return
	}
	a.mu.Lock()
	if a.waiting == id {
		a.waiting = ""
		a.answer = nil
	}
	a.mu.Unlock()
	encoded, _ := json.Marshal(value)
	_, _ = connection.Write(append(encoded, '\n'))
	protocol.Clear(encoded)
}

func (a *authServer) Answer(id string, value *string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || id != a.waiting || a.answer == nil || (value != nil && !protocol.ValidSecret(*value)) {
		return false
	}
	select {
	case a.answer <- value:
		a.answer = nil
		return true
	default:
		return false
	}
}

func (a *authServer) Cancel() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.answer != nil {
		select {
		case a.answer <- nil:
		default:
		}
		a.answer = nil
	}
}

func (a *authServer) Close() {
	a.Cancel()
	a.mu.Lock()
	a.closed = true
	a.mu.Unlock()
	a.listener.Close()
	_ = os.Remove(a.path)
}

// Askpass only writes the answer to sudo's private pipe, never to the business PTY.
func Askpass(prompt string, out io.Writer) error {
	path, token := os.Getenv("CLOUDHELM_AUTH_SOCKET"), os.Getenv("CLOUDHELM_AUTH_TOKEN")
	if path == "" || token == "" || len(prompt) > 4096 {
		return errors.New("authentication-unavailable")
	}
	connection, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return errors.New("authentication-unavailable")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(125 * time.Second))
	hello, _ := json.Marshal(map[string]string{"token": token, "prompt": prompt})
	if _, err = connection.Write(append(hello, '\n')); err != nil {
		return errors.New("authentication-unavailable")
	}
	protocol.Clear(hello)
	line, err := bufio.NewReader(io.LimitReader(connection, 16384)).ReadBytes('\n')
	defer protocol.Clear(line)
	if err != nil {
		return errors.New("authentication-unavailable")
	}
	var answer *string
	if json.Unmarshal(line, &answer) != nil || answer == nil || !protocol.ValidSecret(*answer) {
		return errors.New("authentication-cancelled")
	}
	_, err = fmt.Fprintln(out, *answer)
	return err
}
