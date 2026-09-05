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
#   ok - dock-recall captures: stored per consent, keyed, overwritten, evicted, …
#   ok - dock-recall motion: bound durations on both render paths, and a morph …
#   ok - dock-recall panel IPC: chips keyed and reported on both render paths, …
#   ok - dock-recall undock-while-locked: guest prepared (…)
#
#   ok - dock-recall undock while locked: locked, undocked, focus verdict, unlocked, redocked, restored
#
# Requiring all of them matters. The suite line alone would go green if our test
# files never reached the guest and nothing ran; a test's own line alone would
# mean the suite aborted after it. Neither is a pass. Each line is required as a
# line PREFIX, never as a substring, because `not ok - <the same text>` contains
# `ok - <the same text>` — a substring gate can be satisfied by the very failure
# it exists to catch.
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

# The lines that constitute a pass. Kept as literals and matched as a line
# PREFIX (see found_line): a fuzzy match here would be a gate that goes green on
# the wrong output, and a changed message is meant to be a loud failure rather
# than a quiet miss.
#
# One entry per in-guest test file, plus the host-driven scenario, plus the
# suite's own line — and that arithmetic is checked mechanically below, so a new
# test that nobody added here stops the run instead of quietly not being
# required.
REQUIRED_OK=(
  "ok - acceptance suite passed"
  "ok - dock-recall round trip: record, undock, scatter, redock, restored"
  "ok - dock-recall v3 --app-id upgrade: migrated, converged, repairable"
  "ok - dock-recall captures: stored per consent, keyed, overwritten, evicted, and never able to fail a record"
  "ok - dock-recall motion: bound durations on both render paths, and a morph that ran and ended"
  "ok - dock-recall panel IPC: chips keyed and reported on both render paths, positioned and fallback"
  "ok - dock-recall undock-while-locked: guest prepared"
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
# Checked here rather than discovered six minutes in: the locked scenario's every
# QMP call goes through socat, and without it those calls no-op instead of
# failing — which turns the wrong-password control into a vacuous pass.
command -v socat >/dev/null 2>&1 || { echo "FAIL: socat is not installed, and the undock-while-locked scenario types the guest's password over QMP through it"; exit 1; }

# The floor for "a run directory belonging to THIS invocation" — vm-lib's
# fallback discovery refuses anything older, so a VM leaked by an earlier
# session (killed past the harness's trap, its qemu still alive) can never be
# mistaken for the one this run just booted. Slack for clock granularity.
export DR_RUN_MIN_EPOCH=$(( $(date +%s) - 5 ))

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

# THE ACCOUNTING, CHECKED RATHER THAN REMEMBERED. REQUIRED_OK is what makes this
# a gate, and its worst failure mode is silent: someone adds a test file, stages
# it, and forgets this list — so the new test can fail, or never run at all, and
# this script still prints PASS. Nothing about that is visible in a green run.
# So the count is derived from what was actually staged and compared:
#
#   one line per staged in-guest dock-recall-*-test.sh
# + one for the host-driven locked scenario (undock-locked.sh)
# + one for the suite's own "acceptance suite passed"
# = the length of REQUIRED_OK.
#
# It cannot tell whether the RIGHT lines are listed — only that none is missing
# by count, which is exactly the mistake that otherwise goes unnoticed.
staged_tests=$(find "$STAGE/test/acceptance.d" -maxdepth 1 -name 'dock-recall-*-test.sh' -type f | wc -l)
want_required=$((staged_tests + 2))
if ((want_required != ${#REQUIRED_OK[@]})); then
  echo "FAIL: the gate's accounting is off by $((want_required - ${#REQUIRED_OK[@]}))."
  echo "  $staged_tests staged in-guest test(s) + 1 host scenario + 1 suite line = $want_required required ok-line(s),"
  echo "  but REQUIRED_OK in $0 lists ${#REQUIRED_OK[@]}:"
  printf '    %s\n' "${REQUIRED_OK[@]}"
  echo "  Staged:"
  find "$STAGE/test/acceptance.d" -maxdepth 1 -name 'dock-recall-*-test.sh' -type f -printf '    %f\n' | sort
  echo "  Add the missing test's own ok-line to REQUIRED_OK (or drop the stale entry). A test this"
  echo "  script does not require is a test that can fail, or never run, without failing this gate."
  exit 1
fi
echo "gate accounting: $staged_tests staged in-guest test(s) + host scenario + suite line = ${#REQUIRED_OK[@]} required ok-line(s)"

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

# Strip the harness's colour escapes so a matcher sees what a human reads.
plain() { sed 's/\x1b\[[0-9;]*m//g' "$LOG"; }

# ------------------------------------------- the host-driven locked scenario

# WHICH VM the locked scenario drives is not a detail. It is read off the
# harness's own "Artifacts: <run dir>" line — the directory this invocation
# created — rather than left to "the newest one under runs/", which a VM leaked
# by an earlier session (killed past the harness's trap, its qemu still alive)
# would win. Driving that one would produce a verdict about nothing.
harness_run_dir=$(plain | sed -n 's/.*Artifacts: \(.*\)$/\1/p' | tail -1)
[[ -n $harness_run_dir ]] ||
  harness_run_dir=$(plain | sed -n 's/.*Collecting artifacts into \(.*\)$/\1/p' | tail -1)
if [[ -n $harness_run_dir && -d $harness_run_dir ]]; then
  export DR_RUN_DIR_OVERRIDE="$harness_run_dir"
  echo "run dir (as the harness named it): $DR_RUN_DIR_OVERRIDE"
else
  echo "note: the harness printed no usable run directory; falling back to the newest one no older than this run"
fi

echo
echo "=== undock while locked (host-driven, over QMP) ==="
"$REPO_ROOT/tests/acceptance/undock-locked.sh" 2>&1 | tee -a "$LOG"
locked_status=${PIPESTATUS[0]}

# ----------------------------------------------------------------- the verdict

# A required line must BEGIN the line it is found on, once leading whitespace is
# gone. A plain substring search does not: every required entry starts with
# "ok - ", and `not ok - <same text>` CONTAINS that — so the failing form of a
# test would satisfy the gate that exists to catch it. `index($0, w) == 1` is
# that anchor, and it stays a literal comparison (no regex metacharacters in the
# required text to escape).
found_line() {
  plain | sed 's/^[[:space:]]*//' | awk -v w="$1" 'index($0, w) == 1' | tail -1
}

echo
echo "=== dock-recall acceptance verdict ==="
echo "harness exit code: $harness_status (not the gate — see the header of this file)"
echo "undock-while-locked exit code: $locked_status"
echo "log: $LOG"

missing=0
for want in "${REQUIRED_OK[@]}"; do
  line=$(found_line "$want")
  if [[ -n $line ]]; then
    echo "  found: $line"
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
plain | sed 's/^[[:space:]]*//' | grep -E '^not ok - ' | sed 's/^/  /'
exit 1
