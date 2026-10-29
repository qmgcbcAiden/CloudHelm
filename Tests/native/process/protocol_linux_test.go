package nativeprocess_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
)

func rejected(t *testing.T, p *process) {
	t.Helper()
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		t.Fatal("invalid control did not close the bounded protocol")
	}
	for _, event := range p.all {
		if event["type"] == "exit" {
			t.Fatal("invalid controller message invented a business completion")
		}
	}
}

func TestReaderRejectsMalformedAndOversizedFrames(t *testing.T) {
	for name, data := range map[string]string{
		"unknown-field": `{"version":1,"sessionId":"s","operationId":"o","generation":1,"type":"launch","secret":"untrusted"}`,
		"trailing-json": `{}` + `{}`,
		"malformed":     `{"type":`,
		"oversized":     strings.Repeat("x", protocol.MaxFrame+1),
	} {
		t.Run(name, func(t *testing.T) {
			var value protocol.Request
			err := protocol.NewReader(strings.NewReader(data + "\n")).Next(&value)
			if err == nil || strings.Contains(err.Error(), "untrusted") {
				t.Fatal("malformed protocol was accepted or reflected private input")
			}
		})
	}
}

func TestInputBeforeLaunchIsRejected(t *testing.T) {
	p := start(t, "--serve")
	p.send("input", wire{"data": "Zm9yYmlkZGVu"})
	rejected(t, p)
	if p.output() != "" {
		t.Fatal("pre-launch input reached a business process")
	}
}

func TestDuplicateLaunchCannotReplayTheOperation(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "calls")
	p := start(t, "--serve")
	argv := source("printf once >> '" + marker + "'; printf ready; read -r answer")
	p.launch(argv, false, "/tmp")
	p.waitOutput("ready")
	p.send("launch", wire{"payload": wire{"argv": argv, "cwd": "/tmp", "cols": 80, "rows": 24}})
	rejected(t, p)
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "once" {
		t.Fatal("duplicate launch replayed or lost the original operation")
	}
}

func TestOversizedControlClosesWithoutDispatchingItsInput(t *testing.T) {
	p := start(t, "--serve")
	p.launch(source("printf ready; read -r value; printf 'received:%s' \"$value\""), false, "/tmp")
	p.waitOutput("ready")
	frame := wire{}
	for key, value := range p.binding {
		frame[key] = value
	}
	frame["type"], frame["data"] = "input", strings.Repeat("A", protocol.MaxFrame+1)
	_ = json.NewEncoder(p.input).Encode(frame) // The peer may close before this entire invalid frame is sent.
	rejected(t, p)
	if strings.Contains(p.output(), "received:") {
		t.Fatal("oversized message reached stdin")
	}
}
