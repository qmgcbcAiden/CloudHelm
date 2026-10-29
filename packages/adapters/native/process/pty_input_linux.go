package process

import (
	"errors"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"golang.org/x/sys/unix"
)

// A non-reading command must not block the supervisor from receiving cancel or
// authentication controls. Bounded pending input is retried by the event loop.
type ptyInput struct {
	fd      int
	pending []byte
}

func (p *ptyInput) append(data []byte) error {
	if len(p.pending)+len(data) > 65536 {
		return errors.New("input-backpressure-limit")
	}
	p.pending = append(p.pending, data...)
	return p.flush()
}
func (p *ptyInput) clear() { protocol.Clear(p.pending); p.pending = nil }
func (p *ptyInput) flush() error {
	for len(p.pending) > 0 {
		n, err := unix.Write(p.fd, p.pending)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EAGAIN) {
			return nil
		}
		if errors.Is(err, unix.EIO) {
			p.clear()
			return nil
		}
		if err != nil {
			return errors.New("input-unavailable")
		}
		if n == 0 {
			return nil
		}
		protocol.Clear(p.pending[:n])
		p.pending = p.pending[n:]
	}
	return nil
}
