// cloudhelm-helper is a short-lived process bound to an SSH channel.
package main

import (
	"encoding/json"
	"os"
	"strconv"

	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/files"
	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/process"
	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/protocol"
	"github.com/TianJiaJi/CloudHelm/packages/adapters/native/su"
)

func main() {
	var err error
	if os.Getenv("CLOUDHELM_AUTH_SOCKET") != "" {
		prompt := ""
		if len(os.Args) > 1 {
			prompt = os.Args[1]
		}
		err = process.Askpass(prompt, os.Stdout)
	} else if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--serve":
			err = process.Run(os.Stdin, os.Stdout)
		case "--files":
			err = files.Run(os.Stdin, os.Stdout)
		case "--su-broker":
			err = su.Run(os.Stdin, os.Stdout)
		case "--su-root":
			if len(os.Args) != 7 {
				os.Exit(2)
			}
			pid, parseErr := strconv.Atoi(os.Args[6])
			if parseErr != nil {
				os.Exit(2)
			}
			err = su.Root(os.Args[2], os.Args[3], os.Args[4], os.Args[5], pid)
		case "--identity":
			err = json.NewEncoder(os.Stdout).Encode(map[string]any{"protocolVersion": protocol.Version, "uid": os.Getuid(), "euid": os.Geteuid()})
		case "--version":
			err = json.NewEncoder(os.Stdout).Encode(map[string]any{"protocolVersion": protocol.Version})
		default:
			os.Exit(2)
		}
	} else {
		os.Exit(2)
	}
	// Never print error strings: authentication and protocol data are private.
	if err != nil {
		os.Exit(1)
	}
}
