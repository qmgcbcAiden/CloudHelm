//go:build linux

// Package files implements bounded, descriptor-relative file replacement.
// Version checks detect conflicts; they are not atomic CAS against other writers.
package files

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"time"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
)

type Identity struct {
	Device  string `json:"device"`
	Inode   string `json:"inode"`
	Size    int64  `json:"size"`
	MtimeNS string `json:"mtimeNs"`
	CtimeNS string `json:"ctimeNs"`
}
type Metadata struct {
	UID    uint32            `json:"uid"`
	GID    uint32            `json:"gid"`
	Mode   uint32            `json:"mode"`
	Xattrs map[string]string `json:"xattrs"`
}
type Snapshot struct {
	Path     string    `json:"path"`
	Parent   Identity  `json:"parent"`
	Exists   bool      `json:"exists"`
	Identity *Identity `json:"identity,omitempty"`
	Metadata *Metadata `json:"metadata,omitempty"`
	SHA256   string    `json:"sha256,omitempty"`
}
type Artifact struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Platform        string `json:"platform"`
	Arch            string `json:"arch"`
	SHA256          string `json:"sha256"`
	Size            int64  `json:"size"`
}
type Plan struct {
	Version        int      `json:"version"`
	TransactionID  string   `json:"transactionId"`
	Before         Snapshot `json:"before"`
	ContentSHA256  string   `json:"contentSha256,omitempty"`
	ContentSize    int      `json:"contentSize"`
	MetadataPolicy string   `json:"metadataPolicy"`
	Runtime        Artifact `json:"runtime"`
}
type Request struct {
	Path          string `json:"path,omitempty"`
	Plan          *Plan  `json:"plan,omitempty"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	Action        string `json:"action,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
}
type Receipt struct {
	TransactionID string `json:"transactionId"`
	Fingerprint   string `json:"fingerprint"`
	TargetSHA256  string `json:"targetSha256,omitempty"`
	Deleted       bool   `json:"deleted"`
}
type Result struct {
	Status        string    `json:"status"`
	Code          string    `json:"code,omitempty"`
	Effects       string    `json:"effects"`
	Stage         string    `json:"stage,omitempty"`
	Snapshot      *Snapshot `json:"snapshot,omitempty"`
	ContentBase64 string    `json:"contentBase64,omitempty"`
	Directory     string    `json:"directory,omitempty"`
	Backup        string    `json:"backup,omitempty"`
	Receipt       *Receipt  `json:"receipt,omitempty"`
}
type manifest struct {
	Version     int      `json:"version"`
	Plan        Plan     `json:"plan"`
	Fingerprint string   `json:"fingerprint"`
	Action      string   `json:"action"`
	Stage       string   `json:"stage"`
	Receipt     *Receipt `json:"receipt,omitempty"`
}

var transactionID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var errConflict = errors.New("file-conflict")
var errUnsupported = errors.New("unsupported-file")
var errInvalid = errors.New("invalid-request")

// Run reads exactly one bounded request. No arbitrary command is accepted.
func Run(in io.Reader, out io.Writer) error {
	reader := protocol.NewReader(in)
	var frame protocol.Request
	if err := reader.Next(&frame); err != nil {
		return err
	}
	if !frame.Binding.Valid() {
		return errInvalid
	}
	var req Request
	if err := decode(frame.Payload, &req); err != nil {
		return err
	}
	writer := protocol.NewWriter(out, frame.Binding)
	var result Result
	if frame.Type == "apply" && req.Plan != nil && validPlan(*req.Plan) && digest.MatchString(req.Fingerprint) && (req.Action == "write" || req.Action == "delete") {
		result = apply(req, func(staged Result) error {
			if err := writer.Emit("file-staged", map[string]any{"result": staged}); err != nil {
				return err
			}
			reply := make(chan error, 1)
			go func() {
				var commit protocol.Request
				err := reader.Next(&commit)
				if err == nil && (commit.Type != "file-commit" || !commit.Binding.Equal(frame.Binding) || len(commit.Payload) != 0) {
					err = errInvalid
				}
				reply <- err
			}()
			select {
			case err := <-reply:
				return err
			case <-time.After(30 * time.Second):
				return errors.New("commit-timeout")
			}
		})
	} else {
		result = Handle(frame.Type, req)
	}
	return writer.Emit("file-result", map[string]any{"result": result})
}

func decode(data []byte, value any) error {
	var raw json.RawMessage = data
	if len(raw) == 0 {
		return errInvalid
	}
	reader := json.NewDecoder(bytes.NewReader(raw))
	reader.DisallowUnknownFields()
	if err := reader.Decode(value); err != nil {
		return errInvalid
	}
	var extra any
	if reader.Decode(&extra) != io.EOF {
		return errInvalid
	}
	return nil
}

// Handle is exported for Linux integration tests without an SSH server.
func Handle(kind string, req Request) Result {
	if kind == "inspect" {
		return inspectResult(req.Path)
	}
	if req.Plan == nil || !validPlan(*req.Plan) || !digest.MatchString(req.Fingerprint) || (req.Action != "write" && req.Action != "delete") {
		return failure(errInvalid, false)
	}
	switch kind {
	case "apply":
		return apply(req, func(Result) error { return nil })
	case "recover":
		return recoverTransaction(req)
	case "cleanup":
		return cleanup(req)
	}
	return failure(errInvalid, false)
}

func validPlan(plan Plan) bool {
	return plan.Version == 1 && transactionID.MatchString(plan.TransactionID) && plan.ContentSize >= 0 && plan.ContentSize <= protocol.MaxFile && plan.MetadataPolicy == "preserve-or-refuse" && plan.Runtime.ProtocolVersion == 1 && plan.Runtime.Platform == "linux" && (plan.Runtime.Arch == "amd64" || plan.Runtime.Arch == "arm64") && digest.MatchString(plan.Runtime.SHA256)
}
