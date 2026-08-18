#!/bin/bash
# nested-focus.sh — verify the undock focus-failover MECHANISM in a nested
# Hyprland, where removing the focused output cannot wedge the real session.
#
# What it proves: after `hyprctl output remove <focused>`, the compositor may
# leave NO monitor reporting focused=true, and the dispatch the service uses —
# hl.dsp.focus({ monitor = "<survivor>" }) — puts focus back on a survivor.
#
# The service itself only ever runs in the real session; this is a test of the
# dispatch sequence it performs, not of the plugin.
#
# Usage: tests/nested-focus.sh          (from anywhere; needs a Wayland session)

set -uo pipefail

CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nested.lua"
NESTED_PID=""
NESTED_SIG=""
FAILURES=0

cleanup() {
  if [[ -n $NESTED_PID ]] && kill -0 "$NESTED_PID" 2>/dev/null; then
    kill "$NESTED_PID" 2>/dev/null
    for _ in $(seq 20); do
      kill -0 "$NESTED_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$NESTED_PID" 2>/dev/null
  fi
  echo "nested session cleaned up"
}
trap cleanup EXIT

nested() { HYPRLAND_INSTANCE_SIGNATURE="$NESTED_SIG" hyprctl "$@"; }

check() {  # check <description> <expected> <actual>
  if [[ $2 == "$3" ]]; then
    echo "PASS: $1 ($3)"
  else
    echo "FAIL: $1 — expected '$2', got '$3'"
    FAILURES=$((FAILURES + 1))
  fi
}

before=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort)

Hyprland -c "$CONF" >/tmp/nested-hyprland.log 2>&1 &
NESTED_PID=$!

# The new instance announces itself by creating its socket directory.
for _ in $(seq 60); do
  after=$(ls "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | sort)
  NESTED_SIG=$(comm -13 <(echo "$before") <(echo "$after") | tail -1)
  [[ -n $NESTED_SIG && -S $XDG_RUNTIME_DIR/hypr/$NESTED_SIG/.socket.sock ]] && break
  NESTED_SIG=""
  sleep 0.5
done

if [[ -z $NESTED_SIG ]]; then
  echo "FAIL: nested Hyprland never came up (see /tmp/nested-hyprland.log)"
  exit 1
fi
echo "nested instance: $NESTED_SIG"

# Give it a moment to finish creating its default output.
for _ in $(seq 20); do
  nested monitors -j >/dev/null 2>&1 && break
  sleep 0.5
done

nested output create headless nested-a >/dev/null
nested output create headless nested-b >/dev/null
sleep 1
echo "monitors: $(nested monitors -j | jq -r '[.[].name]|join(", ")')"

# Focus the second headless output, then pull it out from under the focus.
# A monitor with no window on it does not always take focus on the first ask —
# the cursor is still over the parent output and follow_mouse pulls focus back —
# so a window is opened on it first, which is also the realistic case.
nested dispatch 'hl.dsp.focus({ monitor = "nested-b" })' | sed 's/^/focus dispatch: /'
sleep 0.5
nested dispatch 'hl.dsp.exec_cmd([[foot --app-id=nested-probe]])' >/dev/null
for _ in $(seq 40); do
  [[ $(nested clients -j | jq -r '[.[]|select(.class=="nested-probe")]|length') -gt 0 ]] && break
  sleep 0.25
done
nested dispatch 'hl.dsp.focus({ monitor = "nested-b" })' | sed 's/^/focus dispatch: /'
sleep 0.5
focused_before=$(nested monitors -j | jq -r 'first(.[]|select(.focused)|.name)//"none"')
check "focus moved onto the doomed monitor" "nested-b" "$focused_before"

nested output remove nested-b >/dev/null
sleep 1

survivors=$(nested monitors -j | jq -r '[.[].name]|join(",")')
focused_after=$(nested monitors -j | jq -r 'first(.[]|select(.focused)|.name)//"none"')
echo "after removal: monitors=[$survivors] focused=$focused_after"

if [[ $focused_after == "none" ]]; then
  # This is the failure the service repairs: nothing holds focus.
  target=$(nested monitors -j | jq -r 'first(.[].name)')
  echo "no monitor holds focus — dispatching the service's failover to $target"
  out=$(nested dispatch "hl.dsp.focus({ monitor = \"$target\" })")
  check "failover dispatch accepted" "ok" "$out"
  sleep 0.5
  focused_after=$(nested monitors -j | jq -r 'first(.[]|select(.focused)|.name)//"none"')
fi

if [[ $focused_after == "none" ]]; then
  echo "FAIL: focus is still on no monitor after the failover"
  FAILURES=$((FAILURES + 1))
elif [[ $focused_after == "nested-b" ]]; then
  echo "FAIL: focus is still on the removed monitor"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: focus landed on survivor '$focused_after'"
fi

if [[ $FAILURES -eq 0 ]]; then
  echo "nested-focus: ALL PASS"
else
  echo "nested-focus: $FAILURES failure(s)"
fi
exit $FAILURES
