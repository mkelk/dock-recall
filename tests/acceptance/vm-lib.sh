#!/bin/bash
# vm-lib.sh — reaching a VM the omarchy-iso harness left running. SOURCED, not
# run.
#
# Most of Tier C needs nothing from the host: the harness boots a VM, runs the
# suite inside it over SSH, and tears it down. One scenario cannot live inside
# that shape. Undock-while-locked has to type a password into a session lock, and
# a lock surface takes keyboard input from the seat — no in-guest tool the base
# image ships can reach it. The keyboard that can is the emulated one, behind
# QMP, on the host.
#
# So `run.sh` passes `--keep-running`, and this file is how anything on the host
# then finds and drives that VM:
#
#   dr_find_vm            locate the run directory, the qemu pid and the QMP
#                         socket. Sets DR_RUN_DIR / DR_QEMU_PID / DR_QMP_SOCK.
#   dr_qmp <json>         one QMP command
#   dr_screendump <name>  a PNG of the emulated framebuffer, into the run dir
#   dr_press <chord>      QMP send-key, dash-separated ("ret", "ctrl-u")
#   dr_type_text <text>   the same, one character at a time
#   dr_ssh_guest <cmd>    SSH into the guest
#   dr_ssh_session <cmd>  ...with the graphical session's environment recovered
#   dr_poweroff           shut the VM down, gracefully then not
#
# It is a library rather than a copy in each caller for the reason sandbox-lib.sh
# is: `run.sh` must be able to power the VM off in its EXIT trap whether or not
# the locked scenario ever ran, and a second copy of that teardown is a copy that
# drifts from the one that matters.
#
# Everything here is host-side and read-only about the harness: it discovers what
# the harness already created and never starts a VM of its own.

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  echo "source tests/acceptance/vm-lib.sh; do not run it directly" >&2
  exit 1
fi

DR_ISO_DIR="${OMARCHY_ISO_DIR:-$HOME/git/omarchy-iso}"
DR_ISO_IMAGE="${OMARCHY_ISO_IMAGE:-release/omarchy-4.0.1.iso}"
DR_BASE_DIR="$DR_ISO_DIR/test-runs/$(basename "$DR_ISO_IMAGE" .iso)"
DR_SSH_KEY="$DR_BASE_DIR/id_ed25519"
DR_SSH_PORT="${DR_GUEST_SSH_PORT:-2222}"     # the harness's own default
DR_GUEST_USER="omarchy"
DR_GUEST_PASSWORD="omarchy"

DR_RUN_DIR=""
DR_QEMU_PID=""
DR_QMP_SOCK=""

# Locate the VM the harness left behind. Returns 1 (quietly, with a reason on
# stderr) when there is none, so a caller can decide whether that is a failure
# or simply nothing to clean up.
dr_find_vm() {
  DR_RUN_DIR="${DR_RUN_DIR_OVERRIDE:-}"
  if [[ -z $DR_RUN_DIR ]]; then
    DR_RUN_DIR=$(ls -td "$DR_BASE_DIR"/runs/*/ 2>/dev/null | head -1)
    DR_RUN_DIR="${DR_RUN_DIR%/}"
  fi
  [[ -n $DR_RUN_DIR && -d $DR_RUN_DIR ]] || { echo "vm-lib: no run directory under $DR_BASE_DIR/runs" >&2; return 1; }

  [[ -f $DR_RUN_DIR/qemu.pid ]] || { echo "vm-lib: no $DR_RUN_DIR/qemu.pid" >&2; return 1; }
  DR_QEMU_PID=$(cat "$DR_RUN_DIR/qemu.pid")
  kill -0 "$DR_QEMU_PID" 2>/dev/null || { echo "vm-lib: qemu pid $DR_QEMU_PID is not running" >&2; return 1; }

  # The socket path is a `mktemp -u` name the harness never prints, so it is read
  # back off the process that owns it rather than guessed.
  DR_QMP_SOCK=$(tr '\0' '\n' < "/proc/$DR_QEMU_PID/cmdline" 2>/dev/null |
    sed -n 's/^unix:\(.*\),server,nowait$/\1/p' | head -1)
  [[ -S ${DR_QMP_SOCK:-} ]] || { echo "vm-lib: no QMP socket on qemu pid $DR_QEMU_PID's command line" >&2; return 1; }

  return 0
}

dr_qmp() {
  printf '{"execute":"qmp_capabilities"}\n{"execute":%s}\n' "$1" |
    timeout 10 socat -t 3 - "UNIX-CONNECT:$DR_QMP_SOCK" 2>/dev/null || true
}

# A photograph of the emulated GPU's framebuffer. It does not go through the
# guest's Wayland stack at all, which is exactly why it is used for the locked
# states: a screencopy client (`grim`) can be refused while an ext-session-lock
# is up, and this cannot.
dr_screendump() {
  local name="$1" ppm="$DR_RUN_DIR/.dr-vm-lib.ppm"
  rm -f "$ppm"
  dr_qmp "\"screendump\", \"arguments\": {\"filename\": \"$ppm\"}" >/dev/null
  sleep 1
  if [[ -s $ppm ]]; then
    magick "$ppm" "$DR_RUN_DIR/$name.png" 2>/dev/null && echo "screendump: $DR_RUN_DIR/$name.png"
  else
    echo "screendump: FAILED for $name (no frame)"
  fi
  rm -f "$ppm"
}

# Dash-separated qcodes, the harness's own spelling: "ret", "esc", "ctrl-u".
dr_press() {
  local part json="" ; local -a parts
  IFS='-' read -ra parts <<<"$1"
  for part in "${parts[@]}"; do json+="{\"type\":\"qcode\",\"data\":\"$part\"},"; done
  dr_qmp "\"send-key\", \"arguments\": {\"keys\": [${json%,}]}" >/dev/null
}

# Only what a password of letters and digits needs. Anything else would be a
# silent wrong keystroke, so it is refused rather than guessed at — a mistyped
# password reads as "the session will not unlock", which is a very expensive
# thing to misdiagnose.
dr_type_text() {
  local text="$1" ch i
  for ((i = 0; i < ${#text}; i++)); do
    ch=${text:i:1}
    case "$ch" in
      [a-z0-9]) dr_press "$ch" ;;
      [A-Z]) dr_press "shift-${ch,,}" ;;
      *) echo "vm-lib: refusing to guess a qcode for '$ch'" >&2; return 1 ;;
    esac
    sleep 0.05
  done
}

dr_ssh_guest() {
  ssh -i "$DR_SSH_KEY" -p "$DR_SSH_PORT" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR \
    "$DR_GUEST_USER@127.0.0.1" "$@" </dev/null
}

# An SSH login inherits none of the graphical session, so it is recovered the
# same way the harness's own ssh_session recovers it.
dr_ssh_session() {
  dr_ssh_guest "export XDG_RUNTIME_DIR=/run/user/\$(id -u); \
    export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus; \
    export HYPRLAND_INSTANCE_SIGNATURE=\$(ls -t \$XDG_RUNTIME_DIR/hypr | head -1); \
    export WAYLAND_DISPLAY=\$(find \$XDG_RUNTIME_DIR -maxdepth 1 -name 'wayland-*' ! -name '*.lock' -printf '%f\\n' | head -1); \
    export OMARCHY_PATH=/usr/share/omarchy; \
    export PATH=\$OMARCHY_PATH/bin:\$PATH; \
    $1"
}

# Graceful first, then ACPI, then the hammer. A VM left running is the one way
# this whole arrangement could cost the operator something: `--keep-running`
# means nothing else will stop it.
dr_poweroff() {
  dr_find_vm >/dev/null 2>&1 || return 0
  echo "stopping the acceptance VM (pid $DR_QEMU_PID)"
  dr_ssh_guest "echo $DR_GUEST_PASSWORD | sudo -S systemctl poweroff" >/dev/null 2>&1 ||
    dr_qmp '"system_powerdown"' >/dev/null

  local waited=0
  while kill -0 "$DR_QEMU_PID" 2>/dev/null && ((waited < 30)); do
    sleep 2; waited=$((waited + 2))
  done
  if kill -0 "$DR_QEMU_PID" 2>/dev/null; then
    dr_qmp '"quit"' >/dev/null
    sleep 2
    kill -0 "$DR_QEMU_PID" 2>/dev/null && kill -9 "$DR_QEMU_PID" 2>/dev/null
  fi
}
