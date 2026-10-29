package nativeprocess_test

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
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
