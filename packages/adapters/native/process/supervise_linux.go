// Package process implements one foreground operation, never an interactive root shell.
package process

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type Launch struct {
	Argv    []string `json:"argv"`
	Cwd     string   `json:"cwd"`
	Sudo    bool     `json:"sudo"`
	Command string   `json:"command,omitempty"`
	Cols    uint16   `json:"cols"`
	Rows    uint16   `json:"rows"`
}

type control struct {
	protocol.Binding
	Type   string  `json:"type"`
	Data   string  `json:"data,omitempty"`
	ID     string  `json:"id,omitempty"`
	Answer *string `json:"answer"`
	Cols   uint16  `json:"cols,omitempty"`
	Rows   uint16  `json:"rows,omitempty"`
}

func Run(in io.Reader, out io.Writer) error {
	reader := protocol.NewReader(in)
	var request protocol.Request
	if reader.Next(&request) != nil || !request.Binding.Valid() || request.Type != "launch" {
		return errors.New("invalid-launch")
	}
	w := protocol.NewWriter(out, request.Binding)
	var launch Launch
	if json.Unmarshal(request.Payload, &launch) != nil || len(launch.Argv) == 0 || len(launch.Argv) > 4096 || !filepath.IsAbs(launch.Cwd) {
		return w.Emit("launch-error", map[string]any{"kind": "unsupported", "code": "invalid-launch"})
	}
	for _, arg := range launch.Argv {
		if strings.ContainsRune(arg, 0) {
			return errors.New("invalid-launch")
		}
	}
	if launch.Sudo && (filepath.Base(launch.Argv[0]) != "sudo" || len(launch.Argv) < 2 || launch.Argv[1] != "-A") {
		return w.Emit("launch-error", map[string]any{"kind": "unsupported", "code": "unprepared-authentication"})
	}
	executable, err := exec.LookPath(launch.Argv[0])
	if err != nil {
		return launchError(w, launch.Sudo, err)
	}
	stat, err := os.Stat(launch.Cwd)
	if err != nil || !stat.IsDir() {
		return launchError(w, false, err)
	}
	if err = unix.Access(launch.Cwd, unix.X_OK); err != nil {
		return launchError(w, false, err)
	}
	if launch.Cols == 0 || launch.Cols > 1000 || launch.Rows == 0 || launch.Rows > 1000 {
		return errors.New("invalid-window")
	}
	cmd := exec.Command(executable, launch.Argv[1:]...)
	cmd.Dir = launch.Cwd
	cmd.Env = environment()
	var auth *authServer
	if launch.Sudo {
		auth, err = newAuthServer(w)
		if err != nil {
			return launchError(w, false, err)
		}
		defer auth.Close()
		self, selfErr := os.Executable()
		if selfErr != nil {
			return launchError(w, false, selfErr)
		}
		cmd.Env = append(cmd.Env, "SUDO_ASKPASS="+self, "CLOUDHELM_AUTH_SOCKET="+auth.path, "CLOUDHELM_AUTH_TOKEN="+auth.token)
	}
	master, slave, err := pty.Open()
	if err != nil {
		return launchError(w, false, err)
	}
	defer master.Close()
	defer slave.Close()
	if err = pty.Setsize(master, &pty.Winsize{Rows: launch.Rows, Cols: launch.Cols}); err != nil {
		return launchError(w, false, err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err = cmd.Start(); err != nil {
		return launchError(w, false, err)
	}
	_ = w.Emit("started", map[string]any{"pid": cmd.Process.Pid, "uid": os.Getuid(), "euid": os.Geteuid()})
	_ = w.Emit("prompt", map[string]any{"data": prompt(launch.Cwd)})
	if launch.Command != "" {
		_ = w.Emit("display", map[string]any{"data": "\r\x1b[2K" + prompt(launch.Cwd) + strings.ReplaceAll(launch.Command, "\n", "\r\n") + "\r\n"})
	}
	if auth != nil {
		go auth.Serve()
	}
	exited := make(chan int, 1)
	go func() {
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			code = 1
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				status := exitErr.Sys().(syscall.WaitStatus)
				if status.Signaled() {
					code = 128 + int(status.Signal())
				} else {
					code = status.ExitStatus()
				}
			}
		}
		exited <- code
	}()
	outputDone := make(chan int, 1)
	go readOutput(master, exited, outputDone, w)
	controls := make(chan control)
	inputDone := make(chan struct{})
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer close(inputDone)
		for {
			var message control
			if reader.Next(&message) != nil || !message.Binding.Equal(request.Binding) {
				return
			}
			select {
			case controls <- message:
			case <-done:
				return
			}
		}
	}()
	for {
		select {
		case code := <-outputDone:
			return w.Emit("exit", map[string]any{"code": code})
		case <-inputDone:
			// Loss of the controller is not proof that the business process has exited.
			return errors.New("controller-closed")
		case message := <-controls:
			switch message.Type {
			case "input":
				data, decodeErr := base64.StdEncoding.DecodeString(message.Data)
				if decodeErr != nil || len(data) > 65536 {
					return errors.New("invalid-control")
				}
				if len(data) == 1 && data[0] == 3 {
					_ = unix.Kill(-cmd.Process.Pid, unix.SIGINT)
				} else {
					_, _ = master.Write(data)
				}
			case "resize":
				if message.Rows < 1 || message.Rows > 1000 || message.Cols < 1 || message.Cols > 1000 {
					return errors.New("invalid-window")
				}
				_ = pty.Setsize(master, &pty.Winsize{Rows: message.Rows, Cols: message.Cols})
			case "answer":
				if auth == nil || !auth.Answer(message.ID, message.Answer) {
					return errors.New("stale-answer")
				}
			case "cancel":
				if auth != nil {
					auth.Cancel()
				}
				_ = unix.Kill(-cmd.Process.Pid, unix.SIGINT)
			default:
				return errors.New("invalid-control")
			}
		}
	}
}

func launchError(w *protocol.Writer, sudo bool, err error) error {
	kind, code := "unsupported", "launch-unavailable"
	if errors.Is(err, os.ErrPermission) {
		kind = "permission-denied"
	}
	if sudo {
		code = "sudo-unavailable"
	}
	return w.Emit("launch-error", map[string]any{"kind": kind, "code": code})
}

func environment() []string {
	result := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "CLOUDHELM_") || key == "SUDO_ASKPASS" || key == "TERM" {
			continue
		}
		result = append(result, entry)
	}
	return append(result, "TERM=xterm-256color")
}

func prompt(cwd string) string {
	name := "uid-" + os.Getenv("UID")
	if current, err := user.Current(); err == nil {
		name = current.Username
	}
	host, _ := os.Hostname()
	clean := func(s string) string {
		return strings.Map(func(r rune) rune {
			if r < 32 || r == 127 {
				return -1
			}
			return r
		}, s)
	}
	suffix := "$ "
	if os.Geteuid() == 0 {
		suffix = "# "
	}
	return clean(name) + "@" + clean(host) + ":" + clean(cwd) + suffix
}

func readOutput(master *os.File, exited <-chan int, done chan<- int, w *protocol.Writer) {
	buffer := make([]byte, 8192)
	code, finished, quiet := 0, false, 0
	for {
		if !finished {
			select {
			case code = <-exited:
				finished = true
			default:
			}
		}
		poll := []unix.PollFd{{Fd: int32(master.Fd()), Events: unix.POLLIN}}
		ready, err := unix.Poll(poll, 100)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			done <- 255
			return
		}
		if ready > 0 && poll[0].Revents&unix.POLLIN != 0 {
			count, readErr := master.Read(buffer)
			if count > 0 {
				_ = w.Emit("data", map[string]any{"dataBase64": base64.StdEncoding.EncodeToString(buffer[:count])})
				quiet = 0
			}
			if readErr != nil && !finished {
				time.Sleep(10 * time.Millisecond)
			}
		} else if finished {
			quiet++
			if quiet >= 2 {
				done <- code
				return
			}
		}
	}
}
