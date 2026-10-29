package nativeprocess_test

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWritableSudoCannotReceiveAuthentication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sudo")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf untrusted-program-ran\n"), 0700); err != nil {
		t.Fatal(err)
	}
	p := start(t, "--serve")
	p.launch([]string{path, "-A", "--", "/usr/bin/printf", "allowed"}, true, "/tmp")
	if p.wait("launch-error")["code"] != "sudo-executable-untrusted" {
		t.Fatal("untrusted sudo not rejected")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, event := range p.all {
		if event["type"] == "auth" || event["type"] == "started" {
			t.Fatal("untrusted sudo received authentication capability")
		}
	}
}

func TestSudoCarriesRawPromptDigest(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		return
	}
	p := start(t, "--serve")
	rawPrompt := "Password:\x01"
	p.launch([]string{"/usr/bin/sudo", "-A", "-p", rawPrompt, "--", "/usr/bin/printf", "allowed"}, true, "/tmp")
	challenge := p.wait("auth")
	if challenge["prompt"] != "Password:" || challenge["promptSha256"] != digest([]byte(rawPrompt)) {
		t.Fatal("raw prompt identity was lost during display sanitation")
	}
	p.send("answer", wire{"id": challenge["id"], "answer": "fixture-login-password"})
	if p.wait("exit")["code"] != float64(0) {
		t.Fatal("custom sudo prompt did not authenticate")
	}
}

func TestNoBashRejectsBeforePayload(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_NO_BASH") != "1" {
		return
	}
	if _, err := os.Stat("/bin/bash"); !os.IsNotExist(err) {
		t.Fatal("fixture still provides Bash")
	}
	p := start(t, "--serve")
	p.launch(source("printf forbidden-payload"), false, "/tmp")
	if p.wait("launch-error")["kind"] != "unsupported" {
		t.Fatal("missing Bash did not fail closed")
	}
	if p.output() != "" {
		t.Fatal("payload started despite missing Bash")
	}
}

func TestReadonlyRuntimeDirectoryRejectsUpload(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		return
	}
	if err := sshCommand("cp", helper(t), "/readonly/helper").Run(); err == nil {
		t.Fatal("fixture accepted upload into readonly runtime directory")
	}
	if _, err := os.Stat("/readonly/helper"); !os.IsNotExist(err) {
		t.Fatal("failed upload left an executable")
	}
}

func totp() string {
	key, _ := base32.StdEncoding.DecodeString("JBSWY3DPEHPK3PXP")
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(time.Now().Unix()/30))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 15
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000)
}

func TestRealMultiStagePAMChallenge(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_MFA") != "1" {
		return
	}
	p := start(t, "--serve")
	p.launch([]string{"/usr/bin/sudo", "-A", "--", "/usr/bin/printf", "allowed"}, true, "/tmp")
	password := p.wait("auth")
	p.send("answer", wire{"id": password["id"], "answer": "fixture-login-password"})
	otp := p.wait("auth")
	if password["id"] == otp["id"] || password["prompt"] == otp["prompt"] {
		t.Fatal("PAM conversation did not create separate challenges")
	}
	code := totp()
	p.send("answer", wire{"id": otp["id"], "answer": code})
	exit := p.wait("exit")["code"]
	if strings.Contains(p.output(), "fixture-login-password") || strings.Contains(p.output(), code) {
		t.Fatal("PAM secret reached business output")
	}
	if exit != float64(0) || !strings.HasSuffix(p.output(), "allowed") {
		t.Fatalf("real PAM password+TOTP failed: exit=%v", exit)
	}
}

func TestRestrictedRootCopyFailsBeforeBusiness(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_RESTRICTED_ROOT") != "1" {
		return
	}
	password := "fixture-root-password"
	p, _ := rootConnect(t, &password, "")
	err := p.wait("error")
	if err["bootstrapExit"] != float64(72) {
		t.Fatalf("expected restricted /proc copy rejection, got %v", err["bootstrapExit"])
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, event := range p.all {
		if event["type"] == "ready" || event["type"] == "output" {
			t.Fatal("restricted root copy started a business session")
		}
	}
}

func TestDirectRootSSHDoesNotRequireSu(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_LOGIN") != "root" {
		return
	}
	p := start(t, "--serve")
	p.launch(source("id -u"), false, "/root")
	started := p.wait("started")
	if started["supervisorUid"] != float64(0) || started["supervisorEuid"] != float64(0) {
		t.Fatal("root SSH native identity was not UID 0")
	}
	if p.wait("exit")["code"] != float64(0) || p.output() != "0\r\n" {
		t.Fatal("direct root SSH command failed")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, event := range p.all {
		if event["type"] == "auth" {
			t.Fatal("direct root SSH incorrectly requested su/sudo authentication")
		}
	}
}

func TestRootRejectsReplacementBrokerSocket(t *testing.T) {
	if os.Getenv("CLOUDHELM_NATIVE_SSH") != "1" {
		return
	}
	p := start(t, "--su-broker")
	content, err := os.ReadFile(helper(t))
	if err != nil {
		t.Fatal(err)
	}
	directory := fmt.Sprintf("/tmp/cloudhelm-root-replacement-%d", time.Now().UnixNano())
	p.send("connect", wire{"payload": wire{"rootDirectory": directory, "sha256": digest(content)}})
	auth := p.wait("auth")
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(helper(t)), "su-*.sock"))
	if err != nil || len(paths) != 1 {
		t.Fatalf("cannot identify isolated broker socket: %v", err)
	}
	if err = os.Remove(paths[0]); err != nil {
		t.Fatal(err)
	}
	rogue, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths[0], Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer rogue.Close()
	rogue.SetDeadline(time.Now().Add(10 * time.Second))
	p.send("answer", wire{"id": auth["id"], "answer": "fixture-root-password"})
	connection, err := rogue.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	var data [1]byte
	if n, _ := connection.Read(data[:]); n != 0 {
		t.Fatal("root trusted a replacement broker before checking peer PID")
	}
	if p.wait("error")["code"] != "authentication-unconfirmed" {
		t.Fatal("replacement broker became ready")
	}
}
