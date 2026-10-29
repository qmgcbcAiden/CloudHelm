"""Generate disposable VM credentials without printing them into CI logs."""
import json
from pathlib import Path

root = Path(".cache/selinux")
config = {
    "hostname": "cloudhelm-selinux-fixture",
    "ssh_pwauth": False,
    "disable_root": True,
    "users": [{
        "name": "cloudhelm",
        "groups": ["wheel"],
        "shell": "/bin/bash",
        "lock_passwd": True,
        "sudo": "ALL=(ALL) NOPASSWD:ALL",
        "ssh_authorized_keys": [(root / "identity.pub").read_text().strip()],
    }],
    "ssh_deletekeys": True,
    "ssh_keys": {
        "ed25519_private": (root / "host-key").read_text(),
        "ed25519_public": (root / "host-key.pub").read_text().strip(),
    },
    "runcmd": [["/bin/sh", "-c", "set -eu; setenforce 1; restorecon -R /home/cloudhelm; test \"$(getenforce)\" = Enforcing"]],
}
(root / "user-data").write_text("#cloud-config\n" + json.dumps(config))
(root / "meta-data").write_text("instance-id: cloudhelm-selinux-fixture\nlocal-hostname: cloudhelm-selinux-fixture\n")
public = (root / "host-key.pub").read_text().split()
(root / "known_hosts").write_text("[127.0.0.1]:2222 " + " ".join(public[:2]) + "\n")
