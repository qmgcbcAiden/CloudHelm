#!/bin/sh
set -eu

# These public fixture credentials exist only inside the disposable container.
# Real su/PAM and password-requiring sudo are intentional; no authentication shim.
printf '%s\n' 'cloudhelm:fixture-login-password' 'root:fixture-root-password' | chpasswd
mkdir -p /run/sshd /home/cloudhelm/.ssh /home/cloudhelm/runtime
chmod 700 /home/cloudhelm/.ssh /home/cloudhelm/runtime
ssh-keygen -q -t ed25519 -N '' -f /home/cloudhelm/.ssh/id_ed25519
cp /home/cloudhelm/.ssh/id_ed25519.pub /home/cloudhelm/.ssh/authorized_keys
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
fi
awk '{ print "127.0.0.1 " $1 " " $2 }' /etc/ssh/ssh_host_ed25519_key.pub > /home/cloudhelm/.ssh/known_hosts
if [ "${CLOUDHELM_FIXTURE_EXTERNAL:-}" != 1 ]; then
  cp /fixture/helper /home/cloudhelm/runtime/helper
  chmod 700 /home/cloudhelm/runtime/helper
fi
chmod 600 /home/cloudhelm/.ssh/authorized_keys /home/cloudhelm/.ssh/known_hosts
chown -R cloudhelm:cloudhelm /home/cloudhelm
mkdir -p /root/.ssh /root/runtime
chmod 700 /root/.ssh /root/runtime
cp /home/cloudhelm/.ssh/authorized_keys /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if [ "${CLOUDHELM_FIXTURE_EXTERNAL:-}" != 1 ]; then
  cp /fixture/helper /root/runtime/helper
  chmod 700 /root/runtime/helper
  chmod 755 /fixture/process.test /fixture/files.test
fi

cat > /etc/ssh/sshd_config <<'SSHD'
Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
UsePAM yes
AllowUsers cloudhelm root
PidFile /run/sshd.pid
LogLevel ERROR
Subsystem sftp /bin/false
SSHD
if [ "${CLOUDHELM_FIXTURE_EXTERNAL:-}" = 1 ]; then
  sed -i 's/ListenAddress 127.0.0.1/ListenAddress 0.0.0.0/' /etc/ssh/sshd_config
fi
cat > /etc/sudoers <<'SUDOERS'
Defaults env_reset,timestamp_timeout=0,passwd_tries=1
root ALL=(ALL:ALL) ALL
cloudhelm ALL=(root) PASSWD: /usr/bin/printf allowed
SUDOERS
chmod 440 /etc/sudoers
visudo -c
sshd=/usr/sbin/sshd
if [ -x /usr/sbin/sshd.pam ]; then sshd=/usr/sbin/sshd.pam; fi
"$sshd" -D -e -f /etc/ssh/sshd_config > /tmp/cloudhelm-sshd.log 2>&1 &
sshd_pid=$!
trap 'kill "$sshd_pid" 2>/dev/null || true' EXIT

attempt=0
until su -s /bin/sh cloudhelm -c 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=1 cloudhelm@127.0.0.1 true'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then cat /tmp/cloudhelm-sshd.log; exit 1; fi
  sleep 0.1
done

if [ "${CLOUDHELM_FIXTURE_EXTERNAL:-}" = 1 ]; then
  touch /fixture-ready
  wait "$sshd_pid"
  exit $?
fi

if [ "${CLOUDHELM_FIXTURE_RESTRICTED_ROOT:-}" = 1 ]; then
  su -s /bin/sh cloudhelm -c 'CLOUDHELM_NATIVE_RESTRICTED_ROOT=1 CLOUDHELM_NATIVE_SSH=1 CLOUDHELM_HELPER=/home/cloudhelm/runtime/helper /fixture/process.test -test.v -test.timeout=30s -test.run=^TestRestrictedRootCopyFailsBeforeBusiness$'
  su -s /bin/sh cloudhelm -c 'CLOUDHELM_NATIVE_LOGIN=root CLOUDHELM_NATIVE_SSH=1 CLOUDHELM_HELPER=/root/runtime/helper /fixture/process.test -test.v -test.timeout=30s -test.run=^TestDirectRootSSHDoesNotRequireSu$'
  exit 0
fi

su -s /bin/sh cloudhelm -c 'CLOUDHELM_NATIVE_SSH=1 CLOUDHELM_HELPER=/home/cloudhelm/runtime/helper /fixture/process.test -test.v -test.timeout=180s'
su -s /bin/sh cloudhelm -c '/fixture/files.test -test.v -test.timeout=60s'
/fixture/files.test -test.v -test.timeout=60s
su -s /bin/sh cloudhelm -c 'CLOUDHELM_NATIVE_LOGIN=root CLOUDHELM_NATIVE_SSH=1 CLOUDHELM_HELPER=/root/runtime/helper /fixture/process.test -test.v -test.timeout=30s -test.run=^TestDirectRootSSHDoesNotRequireSu$'

# Run the real distribution PAM password module followed by a real TOTP module.
# No fake conversation callback is substituted for either authentication stage.
printf '%s\n' 'JBSWY3DPEHPK3PXP' '" TOTP_AUTH' '" WINDOW_SIZE 3' > /home/cloudhelm/.google_authenticator
chown cloudhelm:cloudhelm /home/cloudhelm/.google_authenticator
chmod 600 /home/cloudhelm/.google_authenticator
printf '\nauth required pam_google_authenticator.so\n' >> /etc/pam.d/sudo
su -s /bin/sh cloudhelm -c 'CLOUDHELM_NATIVE_MFA=1 CLOUDHELM_NATIVE_SSH=1 CLOUDHELM_HELPER=/home/cloudhelm/runtime/helper /fixture/process.test -test.v -test.timeout=60s -test.run=^TestRealMultiStagePAMChallenge$'

# OpenSSH still has a valid /bin/sh login shell when Bash is deliberately absent.
sed -i 's|/bin/bash$|/bin/sh|' /etc/passwd
mv /bin/bash /bin/bash.fixture-disabled
su -s /bin/sh cloudhelm -c 'CLOUDHELM_NATIVE_NO_BASH=1 CLOUDHELM_NATIVE_SSH=1 CLOUDHELM_HELPER=/home/cloudhelm/runtime/helper /fixture/process.test -test.v -test.timeout=30s -test.run=^TestNoBashRejectsBeforePayload$'
