package nativeprocess_test

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type wire map[string]any
type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.buffer.String() }

type process struct {
	t       *testing.T
	cmd     *exec.Cmd
	input   io.WriteCloser
	events  chan wire
	done    chan struct{}
	binding wire
	all     []wire
	stderr  lockedBuffer
	mu      sync.Mutex
}

func binding() wire {
	return wire{"version": 1, "sessionId": "integration", "operationId": fmt.Sprintf("op-%d", time.Now().UnixNano()), "generation": 1}
}
func helper(t *testing.T) string {
	t.Helper()
	p := os.Getenv("CLOUDHELM_HELPER")
	if p == "" {
		t.Fatal("CLOUDHELM_HELPER must name the built Linux artifact")
	}
	return p
}
func sshCommand(args ...string) *exec.Cmd {
	login := os.Getenv("CLOUDHELM_NATIVE_LOGIN")
	if login == "" {
		login = "cloudhelm"
	}
	return exec.Command("ssh", append([]string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", login + "@127.0.0.1"}, args...)...)
}
func start(t *testing.T, mode string) *process {
	t.Helper()
	var cmd *exec.Cmd
	if os.Getenv("CLOUDHELM_NATIVE_SSH") == "1" {
		cmd = sshCommand(helper(t), mode)
	} else {
		cmd = exec.Command(helper(t), mode)
	}
	p := &process{t: t, cmd: cmd, events: make(chan wire, 100), done: make(chan struct{}), binding: binding()}
	var err error
	p.input, err = cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = &p.stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 2*1024*1024)
		for scanner.Scan() {
			var e wire
			if json.Unmarshal(scanner.Bytes(), &e) != nil {
				continue
			}
			p.mu.Lock()
			p.all = append(p.all, e)
			p.mu.Unlock()
			p.events <- e
		}
		close(p.events)
		_ = cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		_ = p.input.Close()
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
			_ = cmd.Process.Kill()
		}
	})
	return p
}
func (p *process) send(kind string, fields wire) {
	p.t.Helper()
	m := wire{}
	for k, v := range p.binding {
		m[k] = v
	}
	for k, v := range fields {
		m[k] = v
	}
	m["type"] = kind
	if json.NewEncoder(p.input).Encode(m) != nil {
		p.t.Fatal("control transport failed")
	}
}
func (p *process) wait(kind string) wire {
	p.t.Helper()
	for {
		e := p.next()
		if e["type"] == "error" && kind != "error" {
			p.t.Fatalf("native error waiting for %s: code=%v bootstrapExit=%v", kind, e["code"], e["bootstrapExit"])
		}
		if e["type"] == kind {
			return e
		}
	}
}
func (p *process) next() wire {
	p.t.Helper()
	timeout := time.NewTimer(20 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case e, ok := <-p.events:
			if !ok {
				p.t.Fatalf("transport closed before next frame: %s", p.stderr.String())
			}
			for _, key := range []string{"version", "sessionId", "operationId", "generation"} {
				if fmt.Sprint(e[key]) != fmt.Sprint(p.binding[key]) {
					p.t.Fatalf("unbound event: %s", key)
				}
			}
			return e
		case <-timeout.C:
			p.t.Fatal("timed out waiting for next frame")
		}
	}
}
func (p *process) launch(argv []string, sudo bool, cwd string) {
	p.send("launch", wire{"payload": wire{"argv": argv, "cwd": cwd, "sudo": sudo, "command": "fixture operation", "cols": 132, "rows": 42}})
}
func (p *process) output() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var result strings.Builder
	for _, e := range p.all {
		if e["type"] == "data" {
			b, _ := base64.StdEncoding.DecodeString(e["dataBase64"].(string))
			result.Write(b)
		}
	}
	return result.String()
}
func (p *process) waitOutput(text string) {
	p.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(p.output(), text) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	p.t.Fatalf("missing output %q", text)
}
func source(s string) []string { return []string{"/bin/bash", "--noprofile", "--norc", "-c", s} }

func TestBashSourcePTYAndExit(t *testing.T) {
	p := start(t, "--serve")
	p.launch(source(":; help cd >/dev/null; shopt -u nullglob; stty size; printf '中文\\n'; exit 7"), false, "/tmp")
	e := p.wait("exit")
	if e["code"] != float64(7) || !strings.Contains(p.output(), "42 132\r\n中文\r\n") {
		t.Fatalf("incorrect process result: code=%v output=%q", e["code"], p.output())
	}
}
func TestShortProcessNeverLosesOutput(t *testing.T) {
	for i := 0; i < 8; i++ {
		p := start(t, "--serve")
		p.launch(source("printf immediate-output"), false, "/tmp")
		if p.wait("exit")["code"] != float64(0) || p.output() != "immediate-output" {
			t.Fatal("short process output lost")
		}
	}
}
func TestCtrlCSeparatelyObservesExit(t *testing.T) {
	p := start(t, "--serve")
	p.launch(source("printf ready; sleep 30"), false, "/tmp")
	p.waitOutput("ready")
	p.send("input", wire{"data": base64.StdEncoding.EncodeToString([]byte{3})})
	if p.wait("exit")["code"] != float64(130) {
		t.Fatal("did not observe interrupted exit")
	}
}
func TestBlockedStdinDoesNotPreventCancellation(t *testing.T) {
	p := start(t, "--serve")
	p.launch(source("stty -echo -icanon; printf ready; sleep 30"), false, "/tmp")
	p.waitOutput("ready")
	p.send("input", wire{"data": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 65536)))})
	p.send("input", wire{"data": base64.StdEncoding.EncodeToString([]byte{3})})
	if p.wait("exit")["code"] != float64(130) {
		t.Fatal("stdin backpressure blocked interrupt")
	}
}
func TestWrongBindingCannotBecomeInput(t *testing.T) {
	p := start(t, "--serve")
	p.launch(source("printf ready; read -r value; printf 'received:%s' \"$value\""), false, "/tmp")
	p.waitOutput("ready")
	p.send("input", wire{"operationId": "foreign", "data": base64.StdEncoding.EncodeToString([]byte("forbidden\n"))})
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		t.Fatal("foreign control not rejected")
	}
	if strings.Contains(p.output(), "forbidden") {
		t.Fatal("foreign control reached payload")
	}
}
func TestRealSudoExactCommandAndPassword(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		t.Skip("requires the isolated real sshd/PAM fixture")
	}
	p := start(t, "--serve")
	p.launch([]string{"/usr/bin/sudo", "-A", "--", "/usr/bin/printf", "allowed"}, true, "/tmp")
	auth := p.wait("auth")
	p.send("answer", wire{"id": auth["id"], "answer": "fixture-login-password"})
	exit := p.wait("exit")["code"]
	if exit != float64(0) || !strings.HasSuffix(p.output(), "allowed") {
		t.Fatalf("exact sudoers command result: exit=%v output=%q", exit, strings.ReplaceAll(p.output(), "fixture-login-password", "<redacted>"))
	}
	if strings.Contains(p.output(), "fixture-login-password") {
		t.Fatal("credential reached output")
	}
	denied := start(t, "--serve")
	denied.launch([]string{"/usr/bin/sudo", "-A", "--", "/usr/bin/printf", "denied"}, true, "/tmp")
	for {
		e := denied.next()
		if e["type"] == "auth" {
			denied.send("answer", wire{"id": e["id"], "answer": "fixture-login-password"})
		}
		if e["type"] == "exit" {
			if e["code"] == float64(0) {
				t.Fatal("sudoers command restriction bypassed")
			}
			break
		}
	}
}
func TestFixtureHasNoPythonAndRejectsSFTP(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		t.Skip("isolated SSH fixture only")
	}
	if out, err := sshCommand("/bin/sh", "-c", "'! command -v python && ! command -v python3'").CombinedOutput(); err != nil {
		t.Fatalf("fixture unexpectedly has Python: %s", out)
	}
	cmd := exec.Command("sftp", "-oBatchMode=yes", "-b", "-", "cloudhelm@127.0.0.1")
	cmd.Stdin = strings.NewReader("pwd\n")
	if cmd.Run() == nil {
		t.Fatal("fixture unexpectedly accepts SFTP")
	}
}
func TestNoexecCannotLaunchHelper(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		t.Skip("isolated noexec mount only")
	}
	target := "/noexec/helper"
	if out, err := sshCommand("cp", helper(t), target).CombinedOutput(); err != nil {
		t.Fatalf("copy fixture: %s", out)
	}
	if sshCommand(target, "--version").Run() == nil {
		t.Fatal("helper unexpectedly executed on noexec mount")
	}
}

func rootConnect(t *testing.T, password *string, digestOverride string) (*process, string) {
	t.Helper()
	p := start(t, "--su-broker")
	content, err := os.ReadFile(helper(t))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	if digestOverride != "" {
		digest = digestOverride
	}
	directory := filepath.Join("/tmp", fmt.Sprintf("cloudhelm-root-test-%d", time.Now().UnixNano()))
	p.send("connect", wire{"payload": wire{"rootDirectory": directory, "sha256": digest}})
	auth := p.wait("auth")
	p.send("answer", wire{"id": auth["id"], "answer": password})
	return p, directory
}
func TestRealSuRootPeerAndIndependentPayload(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		t.Skip("requires the isolated real su/PAM fixture")
	}
	password := "fixture-root-password"
	p, directory := rootConnect(t, &password, "")
	ready := p.wait("ready")
	if ready["uid"] != float64(0) || ready["rootDirectory"] != directory {
		t.Fatal("root peer not attested")
	}
	p.send("start", wire{"mode": "serve"})
	inner := binding()
	launch := wire{}
	for k, v := range inner {
		launch[k] = v
	}
	launch["type"] = "launch"
	launch["payload"] = wire{"argv": source("id -u; printf payload-ready; read -r value; printf 'input:%s' \"$value\""), "cwd": "/root", "sudo": false, "cols": 80, "rows": 24}
	data, _ := json.Marshal(launch)
	p.send("control", wire{"data": string(data) + "\n"})
	var output strings.Builder
	sent := false
	for {
		event := p.wait("output")
		var frame wire
		if json.Unmarshal([]byte(event["data"].(string)), &frame) != nil {
			t.Fatal("invalid nested frame")
		}
		if frame["type"] == "data" {
			b, _ := base64.StdEncoding.DecodeString(frame["dataBase64"].(string))
			output.Write(b)
			if !sent && strings.Contains(output.String(), "payload-ready") {
				input := wire{}
				for k, v := range inner {
					input[k] = v
				}
				input["type"] = "input"
				input["data"] = base64.StdEncoding.EncodeToString([]byte("ordinary\n"))
				encoded, _ := json.Marshal(input)
				p.send("control", wire{"data": string(encoded) + "\n"})
				sent = true
			}
		}
		if frame["type"] == "exit" {
			if frame["code"] != float64(0) {
				t.Fatal("root payload failed")
			}
			break
		}
	}
	if !strings.HasPrefix(output.String(), "0\r\n") || !strings.Contains(output.String(), "input:ordinary") || strings.Contains(output.String(), password) {
		t.Fatalf("root isolation result incorrect: %q", output.String())
	}
	p.send("end", nil)
	content, err := os.ReadFile(helper(t))
	if err != nil {
		t.Fatal(err)
	}
	p.send("cleanup", wire{"rootDirectory": directory, "sha256": digest(content)})
	p.wait("cleanup-confirmed")
	if _, err = os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("approved cleanup did not remove root directory")
	}
	_ = p.input.Close()
}
func TestSuRejectsWrongPasswordAndCorruptArtifact(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		t.Skip("isolated real PAM fixture only")
	}
	for _, tc := range []struct{ name, password, digest string }{{"password", "incorrect-fixture-password", ""}, {"artifact", "fixture-root-password", strings.Repeat("0", 64)}} {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := rootConnect(t, &tc.password, tc.digest)
			e := p.wait("error")
			if e["code"] != "authentication-unconfirmed" {
				t.Fatalf("unexpected authentication failure: %v", e["code"])
			}
			if tc.name == "artifact" && e["bootstrapExit"] != float64(74) {
				t.Fatalf("artifact mismatch was not checked before root execution: %v", e["bootstrapExit"])
			}
			p.mu.Lock()
			defer p.mu.Unlock()
			for _, event := range p.all {
				if event["type"] == "ready" {
					t.Fatal("invalid authentication/copy became root")
				}
			}
		})
	}
}
