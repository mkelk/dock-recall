#!/bin/bash
# run.sh — THE entrypoint for the VM acceptance gate (Tier C).
#
# One command: stage the plugin and omarchy's own runner, boot a disposable
# Omarchy VM with the omarchy-iso harness, run the round trip inside it, and
# answer in an exit code.
#
#   ./tests/acceptance/run.sh     exit 0 = the round trip passed in the VM
#
# WHY THIS EXISTS RATHER THAN "read the harness's exit code": the harness runs
# its own shortcut smoke phase before our suite, and on the current base image
# three of those checks fail for reasons that have nothing to do with this
# plugin — so `omarchy-iso-test` exits 1 on a perfectly green dock-recall run.
# Its exit code is therefore useless as a gate. What is not useless is the
# output: the suite prints one line when it passes and each test prints one line
# when IT passes, and all of them are unambiguous. This script requires ALL of:
#
#   ok - acceptance suite passed in <n>s (artifacts in …)   ← the suite's own
#   ok - dock-recall round trip: record, undock, scatter, redock, restored
#   ok - dock-recall v3 --app-id upgrade: migrated, converged, repairable
#
#   ok - dock-recall undock while locked: locked, undocked, focus verdict, unlocked, redocked, restored
#
# Requiring all of them matters. The suite line alone would go green if our test
# files never reached the guest and nothing ran; a test's own line alone would
# mean the suite aborted after it. Neither is a pass.
#
# The last of those does not come from the in-guest suite at all. Its scenario
# has to type a password into a session lock, which no in-guest tool can do — so
# the harness runs with `--keep-running` and this script then drives the
# still-live VM through `undock-locked.sh`, over QMP. Turning that VM off again
# is this script's EXIT trap, on every path out.
#
# Environment:
#   OMARCHY_ISO_HOST      host holding ~/git/omarchy (the fork carrying the
#                         acceptance suite) — see stage.sh. Not needed if a
#                         local omarchy checkout is passed as $1.
#   OMARCHY_ISO_DIR       harness checkout            (default ~/git/omarchy-iso)
#   OMARCHY_ISO_IMAGE     ISO, relative to that dir   (default release/omarchy-4.0.1.iso)
#   DR_ACCEPTANCE_KEEP=1  keep the staging directory
#
# Usage: tests/acceptance/run.sh [omarchy-source]
#        ($1 is passed straight through to stage.sh — a local omarchy checkout
#         or an scp-style host:path.)

set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ISO_DIR="${OMARCHY_ISO_DIR:-$HOME/git/omarchy-iso}"
ISO_IMAGE="${OMARCHY_ISO_IMAGE:-release/omarchy-4.0.1.iso}"

# The lines that constitute a pass. Kept as literals, matched with grep -F: a
# fuzzy match here would be a gate that goes green on the wrong output, and a
# changed message is meant to be a loud failure rather than a quiet miss.
REQUIRED_OK=(
  "ok - acceptance suite passed"
  "ok - dock-recall round trip: record, undock, scatter, redock, restored"
  "ok - dock-recall v3 --app-id upgrade: migrated, converged, repairable"
  "ok - dock-recall undock while locked: locked, undocked, focus verdict, unlocked, redocked, restored"
)

source "$REPO_ROOT/tests/acceptance/vm-lib.sh"

STAGE=""
cleanup() {
  local status=$?
  # The VM outlives the harness on purpose (--keep-running, so the locked
  # scenario can reach its keyboard over QMP), which means NOTHING else will
  # stop it. This trap is the only thing that will, on every path out.
  dr_poweroff >/dev/null 2>&1
  if [[ -n $STAGE && -d $STAGE ]]; then
    if [[ ${DR_ACCEPTANCE_KEEP:-0} == 1 ]]; then
      echo "staging directory kept: $STAGE"
    else
      rm -rf "$STAGE"
    fi
  fi
  exit $status
}
trap cleanup EXIT

# ------------------------------------------------------------------ preflight

[[ -d $ISO_DIR ]] || { echo "FAIL: no omarchy-iso harness at $ISO_DIR (see PROVISIONING.md)"; exit 1; }
[[ -x $ISO_DIR/bin/omarchy-iso-test ]] || { echo "FAIL: $ISO_DIR/bin/omarchy-iso-test is missing or not executable"; exit 1; }
[[ -f $ISO_DIR/$ISO_IMAGE ]] || { echo "FAIL: no ISO at $ISO_DIR/$ISO_IMAGE (see PROVISIONING.md)"; exit 1; }

# --------------------------------------------------------------------- stage

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/dr-acceptance-stage.XXXXXX")
# Outside the staging directory, which is removed on the way out: the log is the
# evidence for whatever the verdict turns out to be.
LOG="${TMPDIR:-/tmp}/dr-acceptance-$(date +%Y%m%d-%H%M%S).log"

echo "=== staging ==="
if [[ $# -ge 1 ]]; then
  "$REPO_ROOT/tests/acceptance/stage.sh" "$STAGE" "$1" || { echo "FAIL: staging failed"; exit 1; }
else
  "$REPO_ROOT/tests/acceptance/stage.sh" "$STAGE" || { echo "FAIL: staging failed"; exit 1; }
fi

# ---------------------------------------------------------------- the harness

# --no-preview: without it the harness ends by opening the screenshots in `imv`
#   on the operator's desktop. The VM itself is always headless (-display none),
#   so this flag is the whole difference between an invisible run and a window.
# --reuse-base: skip the ~40 minute OCR-driven install and boot a throwaway
#   overlay on the prepared base image.
# PATH=/usr/bin:$PATH: the Android SDK ships a 2017 qemu-img that shadows the
#   system one and has no -F, which the harness needs for the overlay. Pinned
#   here so a caller cannot forget it. (PROVISIONING.md § the qemu-img PATH trap)
# --keep-running: the last in-guest test leaves the guest set up for the
#   undock-while-locked scenario, whose remaining half needs the VM's KEYBOARD —
#   a session lock takes input from the seat and no in-guest tool can type into
#   it, so the password goes in over QMP from here. The trap above owns turning
#   the VM off again.
echo "=== omarchy-iso harness (headless, ~4 min) ==="
(
  cd "$ISO_DIR" || exit 1
  PATH=/usr/bin:$PATH ./bin/omarchy-iso-test "$ISO_IMAGE" \
    --reuse-base --no-preview --keep-running --sync-omarchy "$STAGE" 2>&1
) | tee "$LOG"
harness_status=${PIPESTATUS[0]}

# ------------------------------------------- the host-driven locked scenario

echo
echo "=== undock while locked (host-driven, over QMP) ==="
"$REPO_ROOT/tests/acceptance/undock-locked.sh" 2>&1 | tee -a "$LOG"
locked_status=${PIPESTATUS[0]}

# ----------------------------------------------------------------- the verdict

# Strip the harness's colour escapes so grep -F sees what a human reads.
plain() { sed 's/\x1b\[[0-9;]*m//g' "$LOG"; }

echo
echo "=== dock-recall acceptance verdict ==="
echo "harness exit code: $harness_status (not the gate — see the header of this file)"
echo "undock-while-locked exit code: $locked_status"
echo "log: $LOG"

missing=0
for want in "${REQUIRED_OK[@]}"; do
  line=$(plain | grep -F "$want" | tail -1)
  if [[ -n $line ]]; then
    echo "  found: ${line# }"
  else
    echo "  MISSING: \"$want\""
    missing=1
  fi
done

if (( missing == 0 )); then
  echo "dock-recall acceptance: PASS"
  exit 0
fi

echo "dock-recall acceptance: FAIL"
plain | grep -E '^not ok - ' | sed 's/^/  /'
exit 1
