#!/bin/bash
# sandbox-nested-guard.sh — an earlier change: the nested sandbox refuses to start
# unparked.
#
# THE HOLE THIS CLOSES. `sandbox_up` parks the nested compositor by dispatching
# it through the LIVE one behind `[workspace special:dr-sandbox silent]`, and
# then verifies the parking (the window is on the special workspace, no monitor
# is showing it). That check is good, and it is untouched. But it only runs if
# you go through `sandbox_up`. A direct `Hyprland -c tests/nested.lua` skips the
# prefix, skips the check, and opens an ordinary window on the human's desktop
# mid-session. That happened twice; they stopped the run both times.
#
# `tests/nested.lua` now refuses to configure — and aborts the process during
# config parse — unless it finds DR_NESTED_SANDBOX_PID holding its OWN pid,
# which only the parked launch wrapper in sandbox-lib.sh ever issues.
#
# THE TWO ARMS, and this run is both of them:
#
#   CONTROL — `sandbox_up` itself. Same wrapper, same config, same dispatch,
#       marker present. A compositor MUST come up and answer hyprctl; the
#       harness's own parking check must pass. Without this arm the subject's
#       silence would be equally consistent with a machine that cannot start a
#       nested Hyprland at all.
#   SUBJECT — `sandbox_probe_unmarked_start`. The identical launch with the
#       marker withheld. No compositor may come up, the process must end by
#       itself, and it must say why.
#
# The subject arm is dispatched through the SAME parked prefix as the control.
# That is deliberate and is the only reason this test is safe to write: if the
# guard were broken, the compositor it wrongly started would still be parked out
# of sight, and the failure would be REPORTED rather than displayed. Nothing
# here runs a bare `Hyprland -c`.
#
# One at a time, like every sandbox run — the library's flock says so.

set -uo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$LIB_DIR/sandbox-lib.sh"

echo "### sandbox-nested-guard: the marker is the only difference between the two arms"

# ---------------------------------------------------------- CONTROL: it starts
#
# sandbox_up brings up the marked start and asserts the parking itself. Its own
# PASS lines are the control arm's evidence; the two below are what this
# scenario needs on top of them.

sandbox_up

if nested monitors -j >/dev/null 2>&1; then
  pass "control: the MARKED start produced a working compositor ($NESTED_SIG answers hyprctl)"
else
  fail "control: the marked start is not answering hyprctl — the subject arm below would prove nothing"
fi

if grep -qF "REFUSING TO CONFIGURE" "$SBOX/nested-hyprland.log" 2>/dev/null; then
  fail "control: the marked start was REFUSED by the guard — the legitimate path is broken"
  sed -n '1,20p' "$SBOX/nested-hyprland.log"
else
  pass "control: the guard let the legitimate path through without a word"
fi

# No config error, because a config error is a RED OVERLAY across the whole
# nested surface — cosmetic only for as long as the parking holds, which is the
# very thing that failed twice.
#
# Asked of the compositor, not of a log. Two things were measured while writing
# this check, and both are why it is spelled this way:
#
#   - Hyprland's config diagnostics go to `$XDG_RUNTIME_DIR/hypr/<sig>/
#     hyprland.log`, NOT to the stdout the launch wrapper captures. A grep over
#     `$SBOX/nested-hyprland.log` for "config error" passes whatever the config
#     says, so it is not a check at all.
#   - `hyprctl configerrors` on a clean instance answers BLANK — two newlines,
#     not the string "no errors". Comparing against that string fails always.
#
# And the finding that made this check what it is rather than what an earlier change
# expected: `misc:disable_logo` — the key removed from nested.lua in this change,
# and the one the project notes blames for the banner — produces NO config
# error on 0.56.2. Measured both ways, with the key in and out: `configerrors`
# is blank either time. The Lua config manager IGNORES an unknown table key
# silently; only the hyprlang parser errors on one. The key was dead weight and
# is gone, but it was never the banner. This check is the standing guard for a
# construct that really does error.
config_errors=$(nested configerrors 2>&1 | tr -d '[:space:]')
if [[ -z $config_errors ]]; then
  pass "control: the nested config parses clean — hyprctl configerrors is empty, so no red error overlay"
else
  fail "control: the nested config has parse errors — that is a red overlay over the whole nested surface"
  nested configerrors 2>&1 | head -10
fi

# ------------------------------------------------------ SUBJECT: it does not

sandbox_probe_unmarked_start

sandbox_verdict "sandbox-nested-guard"
