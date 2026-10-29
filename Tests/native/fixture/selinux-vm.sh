#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$PWD/.cache/selinux"
image=Fedora-Cloud-Base-Generic-43-1.6.x86_64.qcow2
image_sha=846574c8a97cd2d8dc1f231062d73107cc85cbbbda56335e264a46e3a6c8ab2f
image_base=https://dl.fedoraproject.org/pub/fedora/linux/releases/43/Cloud/x86_64/images
curl --fail --location --retry 3 "$image_base/Fedora-Cloud-43-1.6-x86_64-CHECKSUM" -o "$fixture_dir/Fedora-CHECKSUM"
grep -F "SHA256 ($image) = $image_sha" "$fixture_dir/Fedora-CHECKSUM"
curl --fail --location --retry 3 "$image_base/$image" -o "$fixture_dir/$image"
printf '%s  %s\n' "$image_sha" "$fixture_dir/$image" | sha256sum --check -

ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/identity"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host-key"
python3 Tests/native/fixture/selinux-cloud-config.py
cloud-localds "$fixture_dir/seed.iso" "$fixture_dir/user-data" "$fixture_dir/meta-data"
qemu-img create -f qcow2 -F qcow2 -b "$fixture_dir/$image" "$fixture_dir/disk.qcow2"
qemu-img resize "$fixture_dir/disk.qcow2" 20G

acceleration=tcg
cpu=max
if [ -c /dev/kvm ]; then
  sudo chmod a+rw /dev/kvm
  acceleration=kvm
  cpu=host
fi
qemu-system-x86_64 -machine "q35,accel=$acceleration" -cpu "$cpu" -m 3072 -smp 2 \
  -display none -serial "file:$fixture_dir/boot.log" -monitor none \
  -drive "file=$fixture_dir/disk.qcow2,format=qcow2,if=virtio" -cdrom "$fixture_dir/seed.iso" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=net0 \
  -daemonize -pidfile "$fixture_dir/qemu.pid"
trap 'if [ -f "$fixture_dir/qemu.pid" ]; then kill "$(cat "$fixture_dir/qemu.pid")" 2>/dev/null || true; fi' EXIT

ssh_args=(-i "$fixture_dir/identity" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$fixture_dir/known_hosts" -o ConnectTimeout=2)
ready=false
for attempt in $(seq 1 180); do
  if ssh "${ssh_args[@]}" -p 2222 cloudhelm@127.0.0.1 true 2>/dev/null; then ready=true; break; fi
  sleep 2
done
if [ "$ready" != true ]; then tail -n 100 "$fixture_dir/boot.log"; exit 1; fi
ssh "${ssh_args[@]}" -p 2222 cloudhelm@127.0.0.1 'sudo timeout 180 cloud-init status --wait; test "$(getenforce)" = Enforcing'
scp "${ssh_args[@]}" -P 2222 "$fixture_dir/selinux.test" cloudhelm@127.0.0.1:/home/cloudhelm/selinux.test
ssh "${ssh_args[@]}" -p 2222 cloudhelm@127.0.0.1 'chmod 700 /home/cloudhelm/selinux.test; sudo restorecon /home/cloudhelm/selinux.test; sudo env CLOUDHELM_NATIVE_SELINUX=1 /home/cloudhelm/selinux.test -test.v -test.timeout=90s' | tee "$fixture_dir/results.log"
