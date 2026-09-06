#!/bin/bash
# run-remote.sh — the acceptance gate, on a box that is not the human's desk.
#
# WHY THIS EXISTS. tests/acceptance/run.sh boots the Omarchy VM with
# `-smp 20 -m 8192` on whatever machine runs it, for four to five minutes. That
# is not a background task on a laptop somebody is working on, and the human has
# stopped a run over exactly that (.tick/profile.md, the Tier C row). This script
# moves the WHOLE gate — staging, the VM, the in-guest suite, the host-driven
# locked scenario — to a second box that has the omarchy-iso harness, and brings
# back only the verdict. The laptop does an rsync and an ssh.
#
# WHAT THE REMOTE NEEDS, checked below rather than assumed: the harness
# (~/git/omarchy-iso with bin/omarchy-iso-test, the ISO, the reusable base
# image), a checkout of the omarchy fork carrying test/acceptance (~/git/omarchy —
# run.sh takes it as $1 so no ssh-from-the-remote is needed), qemu, rsync, node
# and jq. The plugin tree itself is rsynced fresh on every run into
# ~/git/dock-recall-gate, .git excluded, so the gate runs on exactly the working
# tree the orchestrator just integrated — the same rule stage.sh applies locally.
#
# THE ORPHAN SWEEP IS DELIBERATELY NARROW. An interrupted run leaves a daemonized
# qemu holding port 2222 and the shared OVMF pflash (.tick/learnings.md,
# "Acceptance VM"). On a box that is not ours to police, this script kills ONLY a
# qemu it can prove is the harness's own — its command line names the harness's
# QMP socket — and only when it is older than any honest run. A younger harness
# qemu is somebody's live run and the script steps aside; any other qemu (an
# Android emulator was found here on the first run) is noted and left alone.
#
# Environment:
#   DR_GATE_HOST      ssh host that runs the gate         (default omarchy-asus)
#   DR_GATE_DIR       plugin tree on that host, ~-relative (default git/dock-recall-gate)
#   DR_GATE_OMARCHY   omarchy fork on that host, ~-relative (default git/omarchy)
#   DR_GATE_ISO_DIR   harness on that host, ~-relative    (default git/omarchy-iso)
#
# Exit status is run.sh's own: 0 is a pass, anything else is not.

set -uo pipefail

HOST="${DR_GATE_HOST:-omarchy-asus}"
REMOTE_DIR="${DR_GATE_DIR:-git/dock-recall-gate}"
OMARCHY_SRC="${DR_GATE_OMARCHY:-git/omarchy}"
ISO_DIR="${DR_GATE_ISO_DIR:-git/omarchy-iso}"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

echo "=== remote pre-flight on $HOST ==="
# One ssh, one script, so the checks cannot drift apart from each other. Every
# line it prints is a fact; the local side only reads the last word.
preflight=$(ssh "${ssh_opts[@]}" "$HOST" bash -s -- "$OMARCHY_SRC" "$ISO_DIR" <<'REMOTE'
set -u
src="$1"; iso="$2"; ok=1
need() { if eval "$2"; then echo "ok:   $1"; else echo "MISSING: $1"; ok=0; fi; }
need "omarchy fork with test/acceptance ($src)"  'test -f ~/"$src"/test/acceptance && test -f ~/"$src"/test/acceptance.d/base-test.sh'
need "harness bin ($iso/bin/omarchy-iso-test)"   'test -x ~/"$iso"/bin/omarchy-iso-test'
need "ISO ($iso/release/omarchy-4.0.1.iso)"       'test -f ~/"$iso"/release/omarchy-4.0.1.iso'
need "base image (else the run is ~40 min)"       'test -f ~/"$iso"/test-runs/omarchy-4.0.1/base.qcow2'
need "qemu"  'command -v qemu-system-x86_64 >/dev/null'
need "rsync" 'command -v rsync >/dev/null'
need "node"  'command -v node >/dev/null'
need "jq"    'command -v jq >/dev/null'

# The sweep: harness leftovers only, and refuse on anything else. "Leftover"
# means the harness's OWN qemu (its command line names the harness's QMP
# socket) AND older than any honest run could be — a run lasts five to forty
# minutes, so a harness qemu under an hour old is somebody's live run (this box
# also reviews pull requests the same way) and this script steps aside for it.
#
# `pgrep -x` cannot find it: the name is 18 characters and pgrep's exact-match
# cap is 15 (.tick/learnings.md says so, and this script tripped over it anyway
# on its first run). So match the full command line and confirm through
# /proc/<pid>/comm that the process IS qemu, not a shell talking about it.
others=0
for pid in $(pgrep -f 'qemu-system-x86_64'); do
  [[ $(cat "/proc/$pid/comm" 2>/dev/null) == qemu-system-x86* ]] || continue
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' '); age=${age:-0}
  if [[ $cmd == *omarchy-iso-test-qmp* && $age -gt 3600 ]]; then
    echo "sweep: killing the harness's own leftover qemu pid $pid, ${age}s old (it holds the shared pflash)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  elif [[ $cmd == *omarchy-iso-test-qmp* ]]; then
    echo "REFUSING: a harness qemu (pid $pid) is only ${age}s old — that is somebody's live run, not a leftover"
    others=1
  else
    # Not ours and not our business. The harness's hazards are ITS OWN leftover
    # (the shared pflash) and port 2222 — both checked on their own terms. A
    # foreign qemu (the first run here found an Android emulator two days old)
    # only competes for CPU, and a slower cycle is not a reason to refuse.
    echo "note: a qemu that is not the harness's is running (pid $pid, $(echo "$cmd" | cut -c1-120)); left alone"
  fi
done
rm -f /tmp/omarchy-iso-test-qmp.*.sock 2>/dev/null || true
[[ $others == 0 ]] || ok=0
if ss -ltn 2>/dev/null | grep -q ':2222 '; then echo "MISSING: port 2222 free"; ok=0; else echo "ok:   port 2222 free"; fi
echo "PREFLIGHT $ok"
REMOTE
)
echo "$preflight"
[[ $(echo "$preflight" | tail -1) == "PREFLIGHT 1" ]] || { echo "FAIL: remote pre-flight failed on $HOST"; exit 1; }

echo "=== syncing $REPO_ROOT -> $HOST:~/$REMOTE_DIR ==="
# .git excluded, exactly as stage.sh does locally: the gate runs on the working
# tree, not on a commit, so what is tested is what was just integrated.
rsync -a --delete --exclude='.git/' -e "ssh ${ssh_opts[*]}" "$REPO_ROOT/" "$HOST:$REMOTE_DIR/" \
  || { echo "FAIL: rsync to $HOST failed"; exit 1; }

echo "=== running the gate on $HOST (the VM lives there, not here) ==="
# PATH=/usr/bin first for the same reason run.sh does it locally: a stray
# qemu-img earlier on PATH kills overlay creation. Harmless where there is none.
ssh "${ssh_opts[@]}" "$HOST" \
  "cd ~/$REMOTE_DIR && OMARCHY_ISO_DIR=~/$ISO_DIR PATH=/usr/bin:\$PATH tests/acceptance/run.sh ~/$OMARCHY_SRC"
status=$?

echo "=== remote gate exit: $status (log and artifacts stay on $HOST: /tmp/dr-acceptance-*.log, ~/$ISO_DIR/test-runs/omarchy-4.0.1/runs/) ==="
exit "$status"
