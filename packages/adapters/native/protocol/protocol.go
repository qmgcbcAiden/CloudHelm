// Package protocol contains the bounded wire format shared by the native modes.
// Authentication values must never be included in errors, diagnostics or receipts.
package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
)

const Version = 1
const MaxFrame = 2 * 1024 * 1024
const MaxFile = 1024 * 1024

type Binding struct {
	Version     int    `json:"version"`
	SessionID   string `json:"sessionId"`
	OperationID string `json:"operationId"`
	Generation  int    `json:"generation"`
}

func (b Binding) Valid() bool {
	return b.Version == Version && b.Generation > 0 && validID(b.SessionID) && validID(b.OperationID)
}

func validID(value string) bool {
	return len(value) > 0 && len(value) <= 128 && !strings.ContainsAny(value, "\x00\r\n/\\")
}

func (b Binding) Equal(other Binding) bool { return b == other }

type Request struct {
	Binding
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Reader rejects oversized and malformed frames without reproducing their data.
type Reader struct{ scanner *bufio.Scanner }

func NewReader(in io.Reader) *Reader {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), MaxFrame)
	return &Reader{scanner: scanner}
}

func (r *Reader) Next(value any) error {
	if !r.scanner.Scan() {
		if r.scanner.Err() != nil {
			return errors.New("invalid-frame")
		}
		return io.EOF
	}
	decoder := json.NewDecoder(bytes.NewReader(r.scanner.Bytes()))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return errors.New("invalid-frame")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return errors.New("invalid-frame")
	}
	return nil
}

type Writer struct {
	mu      sync.Mutex
	out     io.Writer
	Binding Binding
}

func NewWriter(out io.Writer, binding Binding) *Writer { return &Writer{out: out, Binding: binding} }

func (w *Writer) Emit(kind string, fields map[string]any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	value := make(map[string]any, len(fields)+5)
	for key, field := range fields {
		value[key] = field
	}
	value["version"] = Version
	value["sessionId"] = w.Binding.SessionID
	value["operationId"] = w.Binding.OperationID
	value["generation"] = w.Binding.Generation
	value["type"] = kind
	data, err := json.Marshal(value)
	if err != nil || len(data) >= MaxFrame {
		return errors.New("invalid-frame")
	}
	data = append(data, '\n')
	_, err = w.out.Write(data)
	return err
}

func ValidSecret(value string) bool {
	return len(value) <= 4095 && !strings.ContainsAny(value, "\x00\r\n")
}

func Clear(value []byte) {
	for i := range value {
		value[i] = 0
	}
}
