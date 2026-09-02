#!/bin/bash
# undock-locked.sh — the HOST half of the undock-while-locked scenario (Tier C).
#
# THE GAP THIS CLOSES. `tests/nested-notes.md` closed tick sug DONE_WITH_CONCERNS:
# the undock focus failover's DETECTION reads the right thing and its REPAIR
# dispatch works, but the repair branch has never actually fired, because the
# state it targets — a lock surface holding keyboard focus on an output that is
# being removed — cannot be reproduced in a nested compositor. The note names
# exactly what would close it: lock the session, remove the focused output, and
# read the `[dock-recall]` log for one of two lines.
#
#     [dock-recall] monitor "<name>" removed; focus intact on "<other>"
#
#   or
#
#     [dock-recall] monitor "<name>" removed and took focus with it — failing over to "<other>"
#     [dock-recall] focus failover ok
#
# Either is a real answer, and which one appears is a finding rather than a
# verdict. The first says the compositor re-homed focus itself and the service
# correctly did nothing; the second is the branch that has never run. What is NOT
# an answer is neither line — or a session that cannot be unlocked afterwards.
#
# WHY A HOST SCRIPT AT ALL. An in-guest test can lock (`omarchy-shell lock lock`)
# and can undock (`hyprctl output remove`), and both keep working over SSH while
# the session is locked. What it cannot do is UNLOCK: a session lock takes
# keyboard input from the seat, and the base image ships nothing that can type
# into it. The keyboard that can is the emulated one, behind QMP, on the host.
#
# WHAT THE PICTURES ARE AND ARE NOT. QMP screendumps are taken at each step and
# kept, but they are NOT the evidence that the session was locked. Measured on
# 2026-09-02: this guest's virtio-vga framebuffer goes on showing the desktop —
# bar, clock ticking — while `omarchy-shell lock isLocked` says `true` and
# Hyprland reports a LOCK blocker. So the lock is proven three other ways: the
# decisive query, the compositor's own blocker, and a deliberately WRONG password
# that leaves the session locked before the right one releases it. That last one
# is the control: it is what turns "a lock released" into "the emulated keyboard
# was read by an authenticating password prompt".
#
# So the scenario is split at that seam. `dock-recall-undock-locked-prepare-test.sh`
# runs inside the acceptance suite and leaves the guest with the plugin live, a
# watched window on a fake dock and a layout recorded — and locks nothing. This
# script drives everything after that against the still-running VM, which is why
# run.sh passes `--keep-running`.
#
#   ./tests/acceptance/undock-locked.sh          exit 0 = the scenario passed
#
# Environment: see vm-lib.sh (OMARCHY_ISO_DIR, OMARCHY_ISO_IMAGE,
# DR_GUEST_SSH_PORT, DR_RUN_DIR_OVERRIDE).

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/vm-lib.sh"

# The contract with dock-recall-undock-locked-prepare-test.sh. Changing any of
# these means changing both files.
APP_TITLE="dock-recall-locked"
IDENTITY="dr-locked"
OUTPUT="dr-lock-dock"
TARGET_WS=8
SCATTER_WS=1

failures=0
note() { printf '%s\n' "$*"; }
ok() { printf 'ok - %s\n' "$1"; }
notok() {
  printf 'not ok - %s\n' "$1" >&2
  [[ -n ${2:-} ]] && printf '  %s\n' "$2" >&2
  failures=$((failures + 1))
}
die() { notok "$1" "${2:-}"; summarize; exit 1; }

# ------------------------------------------------------------- find the VM

dr_find_vm || {
  echo "not ok - dock-recall undock while locked: no running acceptance VM (was the harness run with --keep-running?)" >&2
  exit 1
}
note "run dir:   $DR_RUN_DIR"
note "qemu pid:  $DR_QEMU_PID"
note "qmp:       $DR_QMP_SOCK"
note "guest ssh: $DR_GUEST_USER@127.0.0.1:$DR_SSH_PORT"

poll() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ----------------------------------------------------------- guest questions

monitor_present() { dr_ssh_session "hyprctl monitors all -j | jq -e --arg n '$1' 'any(.[]; .name==\$n)'" >/dev/null 2>&1; }
monitor_absent() { ! monitor_present "$1"; }
monitor_id() { dr_ssh_session "hyprctl monitors all -j | jq -r --arg n '$1' 'first(.[]|select(.name==\$n)|.id)//empty'" | tr -d '\r\n'; }

app_ws() { dr_ssh_session "hyprctl clients -j | jq -r --arg t '$APP_TITLE' 'first(.[]|select(.initialTitle==\$t)|.workspace.id)//empty'" | tr -d '\r\n'; }
app_monitor() { dr_ssh_session "hyprctl clients -j | jq -r --arg t '$APP_TITLE' 'first(.[]|select(.initialTitle==\$t)|.monitor)//empty'" | tr -d '\r\n'; }
app_addr() { dr_ssh_session "hyprctl clients -j | jq -r --arg t '$APP_TITLE' 'first(.[]|select(.initialTitle==\$t)|.address)//empty'" | tr -d '\r\n'; }

# `omarchy-shell lock isLocked` is THE decisive query — the same one Service.qml
# uses (its lockProbeCommand). loginctl's LockedHint is blind to this lock, and
# omarchy-hyprland-session-locked's LOCK blocker is STICKY once a lock client
# dies, so it can go on saying "locked" about a session nobody is looking at.
# That one is still read, as corroboration, but never as the answer.
lock_state() { dr_ssh_session "omarchy-shell lock isLocked" | tr -d '\r\n'; }
is_locked() { [[ $(lock_state) == "true" ]]; }
is_unlocked() { [[ $(lock_state) == "false" ]]; }
lock_blocker() { dr_ssh_session "omarchy-hyprland-session-locked; echo exit=\$?" | tr -d '\r' | tail -1; }

dr_log() { dr_ssh_session "qs log -p /usr/share/omarchy/shell --tail 6000 2>/dev/null | grep -F '[dock-recall]'"; }

summarize() {
  note ""
  note "=== undock-while-locked artifacts ==="
  ls -1 "$DR_RUN_DIR"/*dock-recall-locked*.png "$DR_RUN_DIR"/dock-recall-undock-locked-lock-probe.txt 2>/dev/null | sed 's/^/  /'
  dr_log > "$DR_RUN_DIR/dock-recall-undock-locked-service.log" 2>/dev/null &&
    note "  $DR_RUN_DIR/dock-recall-undock-locked-service.log"
}

# ------------------------------------------------- 0. the prepared state

dr_ssh_guest true 2>/dev/null ||
  die "dock-recall undock while locked" "the guest is not reachable over SSH on port $DR_SSH_PORT"

monitor_present "$OUTPUT" ||
  die "dock-recall undock while locked" \
    "the fake dock \"$OUTPUT\" is not present — the in-guest prepare test did not run or did not finish"

started_ws=$(app_ws)
[[ $started_ws == "$TARGET_WS" ]] ||
  die "dock-recall undock while locked" \
    "the watched window is on ws '$started_ws', wanted ws $TARGET_WS on $OUTPUT"

PRIMARY=$(dr_ssh_session "hyprctl monitors all -j | jq -r --arg n '$OUTPUT' 'first(.[]|select(.name!=\$n)|.name)//empty'" | tr -d '\r\n')
[[ -n $PRIMARY ]] ||
  die "dock-recall undock while locked" "the guest has no monitor other than $OUTPUT to fail over to"
ok "prepared: $IDENTITY on ws $TARGET_WS @ $OUTPUT, with \"$PRIMARY\" as the survivor"

# Focus must be ON the output that is about to disappear. An undock of an
# UNFOCUSED monitor is the case tests/nested-focus.sh already covered, and it can
# only ever produce the "focus intact" half of the answer.
dr_ssh_session "hyprctl dispatch 'hl.dsp.focus({ monitor = \"$OUTPUT\" })'" >/dev/null 2>&1
sleep 1
focused=$(dr_ssh_session "hyprctl monitors -j | jq -r 'first(.[]|select(.focused==true)|.name)//empty'" | tr -d '\r\n')
[[ $focused == "$OUTPUT" ]] ||
  note "WARNING: focus is on \"$focused\", not \"$OUTPUT\" — the failover branch may not be exercised"
ok "focus parked on the output about to be removed (focused monitor: \"$focused\")"

# --------------------------------------------------------------- 1. lock

# The session's own lock command, not a stand-in: omarchy-system-lock is what the
# menu and the keybinding run, and it routes to `omarchy-shell lock lock`, which
# is the lock living inside the Quickshell process.
dr_ssh_session "omarchy-system-lock" >/dev/null 2>&1 ||
  dr_ssh_session "omarchy-shell lock lock" >/dev/null 2>&1

if ! poll 30 is_locked; then
  dr_screendump "failure-dock-recall-locked-01-lock-refused"
  die "dock-recall undock while locked: the guest genuinely locks" \
    "omarchy-shell lock isLocked never answered 'true' (last answer: '$(lock_state)') — this headless guest does not lock, and the rest of the scenario would be theatre"
fi
dr_screendump "success-dock-recall-locked-01-locked"

# What the compositor itself says it is holding, kept as evidence rather than
# asserted on: the QMP screendump of this guest's virtio-vga head does NOT show a
# lock surface even while the lock is genuinely up (a 2026-09-02 finding — the
# desktop keeps rendering into the framebuffer), so the picture is not the proof.
# The proof is the LOCK blocker below, and the wrong-password control in step 4.
{
  echo "--- omarchy-shell lock isLocked ---"; lock_state
  echo "--- omarchy-hyprland-session-locked ---"; lock_blocker
  echo "--- monitors: solitaryBlockedBy ---"
  dr_ssh_session "hyprctl monitors -j | jq -c '[.[]|{name,focused,solitaryBlockedBy}]'"
  echo "--- layer namespaces ---"
  dr_ssh_session "hyprctl layers -j | jq -c '[.. | objects | select(has(\"namespace\")) | .namespace] | unique'"
} > "$DR_RUN_DIR/dock-recall-undock-locked-lock-probe.txt" 2>&1

blocker=$(lock_blocker)
[[ $blocker == "exit=0" ]] ||
  die "dock-recall undock while locked: the compositor holds a session lock" \
    "omarchy-hyprland-session-locked answered '$blocker' — no LOCK blocker on any monitor, so nothing has an ext-session-lock"
ok "session genuinely locked (omarchy-shell lock isLocked = true; the compositor reports a LOCK blocker)"

# ------------------------------------------------------- 2. undock, locked

dr_ssh_session "hyprctl output remove $OUTPUT" >/dev/null 2>&1
if ! poll 30 monitor_absent "$OUTPUT"; then
  dr_screendump "failure-dock-recall-locked-02-undock"
  die "dock-recall undock while locked: the focused output is removed" "$OUTPUT is still in the monitor list"
fi
sleep 5                      # the failover reads `hyprctl monitors -j` of its own accord
dr_screendump "success-dock-recall-locked-02-post-undock"
ok "the focused output was removed while the session was locked"

# ------------------------------------- 3. the service's own verdict, verbatim

log_text=$(dr_log)
printf '%s\n' "$log_text" > "$DR_RUN_DIR/dock-recall-undock-locked-service.log"

intact_line=$(printf '%s\n' "$log_text" | grep -F "removed; focus intact on" | tail -1)
failover_line=$(printf '%s\n' "$log_text" | grep -F "removed and took focus with it" | tail -1)
failover_ok=$(printf '%s\n' "$log_text" | grep -F "focus failover ok" | tail -1)

if [[ -n $failover_line ]]; then
  ok "focus failover FIRED: ${failover_line#*\[dock-recall\] }"
  if [[ -n $failover_ok ]]; then
    ok "focus failover confirmed: ${failover_ok#*\[dock-recall\] }"
  else
    notok "dock-recall undock while locked: the failover dispatch was confirmed" \
      "\"failing over\" was logged but \"focus failover ok\" was not"
  fi
elif [[ -n $intact_line ]]; then
  ok "focus intact, no repair needed: ${intact_line#*\[dock-recall\] }"
else
  printf '%s\n' "$log_text" | tail -30 >&2
  die "dock-recall undock while locked: the service reached a focus verdict" \
    "neither documented outcome appears in the [dock-recall] log"
fi

# ------------------------------------------------------- 4. unlock, by typing

# The lock may have blanked the display, so a wake keystroke comes first; the
# password then goes in as real key events on the emulated keyboard, which is the
# only input path a session lock accepts.
#
# THE WRONG PASSWORD FIRST, and it is the control that makes the right one mean
# something. `isLocked` flipping to false proves a lock released; on its own it
# does not prove that the KEYSTROKES did it, and this guest's framebuffer shows
# no lock surface to photograph. A deliberately wrong password that leaves the
# session locked, followed by the real one that does not, is a password prompt
# reading the emulated keyboard and authenticating against PAM — which is the
# whole claim. (pam_faillock on this image is deny=10, so one miss is free.)
dr_press esc
sleep 3
dr_press ctrl-u
dr_type_text "definitelynotthepassword" ||
  die "dock-recall undock while locked: the wrong password can be typed" "unsupported character"
dr_press ret
sleep 10
if is_locked; then
  ok "the lock REJECTED a wrong password typed over QMP (still locked)"
else
  die "dock-recall undock while locked: the lock rejects a wrong password" \
    "the session unlocked on 'definitelynotthepassword' — whatever released it was not an authenticating lock"
fi

dr_press ctrl-u                     # clear the rejected attempt out of the field
sleep 1
dr_type_text "$DR_GUEST_PASSWORD" ||
  die "dock-recall undock while locked: the password can be typed" "unsupported character in the guest password"
dr_press ret

if ! poll 60 is_unlocked; then
  # One retry: a first keystroke that only woke the display can swallow the first
  # character, which reads exactly like a wrong password.
  note "first unlock attempt did not take (isLocked = '$(lock_state)'); retrying"
  dr_press esc
  sleep 3
  dr_press ctrl-u
  dr_type_text "$DR_GUEST_PASSWORD"
  dr_press ret
  poll 60 is_unlocked
fi

if is_unlocked; then
  dr_screendump "success-dock-recall-locked-03-post-unlock"
  ok "unlocked by typing the RIGHT password over QMP (omarchy-shell lock isLocked = false)"
else
  dr_screendump "failure-dock-recall-locked-03-still-locked"
  die "dock-recall undock while locked: the session unlocks again" \
    "omarchy-shell lock isLocked is still '$(lock_state)' after two typed attempts"
fi

# Reporting unlocked is not the same as being usable. The session has to ACT.
dispatch_answer=$(dr_ssh_session "hyprctl dispatch 'hl.dsp.focus({ monitor = \"$PRIMARY\" })'" | tr -d '\r\n')
[[ $dispatch_answer == "ok" ]] ||
  die "dock-recall undock while locked: the unlocked session answers a dispatch" \
    "hl.dsp.focus answered '$dispatch_answer'"
ok "the unlocked session answers a dispatch (hl.dsp.focus -> ok)"

# ------------------------------------------------------- 5. redock, restore

# Scattered first, for the same reason the round trip scatters: without it,
# Hyprland's own workspace-to-monitor memory would put ws $TARGET_WS back on the
# reappearing output and the assertion below would go green with the plugin
# asleep.
addr=$(app_addr)
[[ -n $addr ]] ||
  die "dock-recall undock while locked: the watched window survived the lock" "no window titled $APP_TITLE"
dr_ssh_session "hyprctl dispatch 'hl.dsp.window.move({ window = \"address:$addr\", workspace = \"$SCATTER_WS\", follow = false })'" >/dev/null 2>&1
sleep 2
scattered=$(app_ws)
[[ $scattered == "$SCATTER_WS" ]] ||
  die "dock-recall undock while locked: the window is scattered before the redock" \
    "wanted ws $SCATTER_WS, the window is on ws '$scattered'"

dr_ssh_session "hyprctl output create headless $OUTPUT" >/dev/null 2>&1
poll 30 monitor_present "$OUTPUT" ||
  die "dock-recall undock while locked: the dock comes back" "$OUTPUT never reappeared"
dr_ssh_session "date +%s.%N > ~/.local/state/omarchy/dock-recall.trigger" >/dev/null 2>&1

restored() {
  local ws mon want
  ws=$(app_ws); mon=$(app_monitor); want=$(monitor_id "$OUTPUT")
  [[ -n $ws && $ws == "$TARGET_WS" && -n $want && $mon == "$want" ]]
}

if poll 90 restored; then
  dr_screendump "success-dock-recall-locked-04-post-redock"
  ok "the recorded layout restored after the redock (ws $TARGET_WS on $OUTPUT)"
else
  dr_screendump "failure-dock-recall-locked-04-not-restored"
  die "dock-recall undock while locked: the layout restores after the redock" \
    "the window is on ws '$(app_ws)' monitor '$(app_monitor)', wanted ws $TARGET_WS on monitor $(monitor_id "$OUTPUT")"
fi

summarize

if ((failures == 0)); then
  echo "ok - dock-recall undock while locked: locked, undocked, focus verdict, unlocked, redocked, restored"
  exit 0
fi
echo "not ok - dock-recall undock while locked: $failures assertion(s) failed" >&2
exit 1
