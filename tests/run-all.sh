#!/bin/bash
# run-all.sh — THE pre-release gate: every tier of this repository's test stack,
# in one command, in order, with one summary and one exit code.
#
#   ./tests/run-all.sh
#
# WHAT IT RUNS, AND WHY IN THIS ORDER — cheapest and most specific first, so a
# broken pure function is reported in three seconds rather than after a VM boot:
#
#   1. node --test 'tests/**/*.test.js'   the pure brain, against real hyprctl
#                                         fixtures. Seconds.
#   2. omarchy plugin validate .          the manifest and its entry points.
#   3. qmllint                            SYNTAX ONLY on the four QML files.
#                                         Never cite it as evidence that
#                                         bindings resolve — an unknown id was
#                                         once injected and it passed.
#   4. tests/sandbox-dock.sh              Tier B: the plugin's own service and
#                                         panel, live in a nested compositor you
#                                         never see. Launch / scatter / no-op.
#   5. tests/sandbox-future-version.sh --both   a schema-v99 file is INERT, with
#                                         the same-seed control arm that makes
#                                         "nothing happened" mean something.
#   6. tests/sandbox-reserved-id.sh       an identity id that collides with an
#                                         Object.prototype key survives the round
#                                         trip.
#   7. tests/acceptance/run.sh            Tier C: a disposable Omarchy VM — real
#                                         install, real Quickshell, real
#                                         Hyprland. Minutes.
#
# EVERY STEP RUNS, even after one fails. A gate that stops at the first red
# tells you one thing per run, and the whole point of a pre-release pass is to
# learn everything that is wrong in one sitting. The exit code is nonzero if any
# step failed.
#
# WHAT IT DOES NOT RUN: `tests/sim-dock.sh` and anything else that drives the
# LIVE session. That is a venue to ask a human for, never a step in an
# unattended gate. Steps 4-6 run a second Hyprland parked on a special
# workspace and assert the live desk is untouched, which is why they are safe
# here; the acceptance VM is headless for the same reason.
#
# Environment:
#   OMARCHY_ISO_HOST    host holding ~/git/omarchy — needed by step 7 only.
#                       See tests/acceptance/PROVISIONING.md.
#   OMARCHY_PATH        omarchy checkout for qmllint's import path
#                       (default /usr/share/omarchy)
#   DR_RUN_ALL_LOG_DIR  where per-step logs land (default a mktemp dir)
#   DR_RUN_ALL_SKIP     space-separated step numbers to skip, for when a tier is
#                       known-unavailable on this machine. A skipped step is
#                       reported as SKIP and never as a pass.

set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OMARCHY_PATH="${OMARCHY_PATH:-/usr/share/omarchy}"
LOG_DIR="${DR_RUN_ALL_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dr-run-all-XXXXXX")}"
SKIP="${DR_RUN_ALL_SKIP:-}"

mkdir -p "$LOG_DIR"
cd "$REPO_ROOT" || exit 1

names=()
results=()
seconds=()
notes=()

step_number=0
failed=0

# Run one step, live on the terminal and into its own log. The log is what the
# summary points at, so a failure is one `less` away rather than a scroll back
# through a run that may have taken ten minutes.
step() {
  local name="$1"; shift
  step_number=$((step_number + 1))

  local slug
  slug=$(printf '%02d-%s' "$step_number" "$name")
  slug=${slug,,}; slug=${slug// /-}; slug=${slug//[^a-z0-9.-]/}
  local log="$LOG_DIR/$slug.log"

  if [[ " $SKIP " == *" $step_number "* ]]; then
    names+=("$name"); results+=("SKIP"); seconds+=("0"); notes+=("DR_RUN_ALL_SKIP")
    printf '\n\033[1;33m=== [%d] %s — SKIPPED ===\033[0m\n' "$step_number" "$name"
    return 0
  fi

  printf '\n\033[1;35m=== [%d] %s ===\033[0m\n' "$step_number" "$name"
  local started=$SECONDS status=0
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  local took=$((SECONDS - started))

  names+=("$name")
  seconds+=("$took")
  if ((status == 0)); then
    results+=("PASS")
  else
    results+=("FAIL")
    failed=$((failed + 1))
  fi
  notes+=("$log")
  printf '\033[1;35m--- [%d] %s: %s in %ss ---\033[0m\n' \
    "$step_number" "$name" "${results[-1]}" "$took"
}

# ------------------------------------------------------------------ the steps

step "node --test 'tests/**/*.test.js'" \
  node --test 'tests/**/*.test.js'

step "omarchy plugin validate ." \
  omarchy plugin validate .

step "qmllint (syntax) on the four QML files" \
  qmllint -I "$OMARCHY_PATH/shell" Service.qml Panel.qml BarWidget.qml ToplevelBridge.qml

step "tests/sandbox-dock.sh" \
  ./tests/sandbox-dock.sh

step "tests/sandbox-future-version.sh --both" \
  ./tests/sandbox-future-version.sh --both

step "tests/sandbox-reserved-id.sh" \
  ./tests/sandbox-reserved-id.sh

step "tests/acceptance/run.sh" \
  ./tests/acceptance/run.sh

# ----------------------------------------------------------------- the summary

# The node suite's own count, lifted out of its footer: README states a number,
# and a number in prose that nothing checks is a number that rots.
#
# Matched on the last two FIELDS rather than a line prefix, because the prefix
# is not stable: node's TAP reporter writes `# pass 805` and its spec reporter
# (the default when stdout is not a tty) writes `ℹ pass 805`.
node_counts() { awk -v want="$1" '$(NF-1) == want { n = $NF } END { if (n != "") print n }' "$LOG_DIR"/01-*.log 2>/dev/null; }
node_pass=$(node_counts pass)
node_fail=$(node_counts fail)

total=0
for s in "${seconds[@]}"; do total=$((total + s)); done

# A skipped step is not a passed step, and the two lines a reader actually takes
# away from this — the TOTAL row and the last line — used to say a bare PASS
# either way. "PASS" over a run where the VM tier never ran is the single most
# expensive sentence this file could print, so the skips are carried into both.
skipped=0
for r in "${results[@]}"; do [[ $r == SKIP ]] && skipped=$((skipped + 1)); done
verdict() {
  local word="$1"
  if ((skipped > 0)); then printf '%s (%d skipped)' "$word" "$skipped"; else printf '%s' "$word"; fi
}

printf '\n'
printf '=== dock-recall full-stack run ===\n'
printf 'logs: %s\n' "$LOG_DIR"
printf '\n'
printf '%-2s %-48s %-18s %8s\n' '#' 'STEP' 'RESULT' 'SECONDS'
printf '%s\n' "----------------------------------------------------------------------------"
for i in "${!names[@]}"; do
  printf '%-2s %-48s %-18s %8s\n' "$((i + 1))" "${names[$i]}" "${results[$i]}" "${seconds[$i]}"
done
printf '%s\n' "----------------------------------------------------------------------------"
printf '%-2s %-48s %-18s %8s\n' '' 'TOTAL' "$( ((failed == 0)) && verdict PASS || verdict FAIL)" "$total"
printf '\n'
[[ -n ${node_pass:-} ]] && printf 'node suite: %s tests passed, %s failed\n' "$node_pass" "${node_fail:-0}"

if ((failed == 0)); then
  printf 'dock-recall full stack: %s\n' "$(verdict PASS)"
  if ((skipped > 0)); then
    skip_list=""
    for i in "${!names[@]}"; do
      [[ ${results[$i]} == SKIP ]] || continue
      skip_list+="${skip_list:+, }[$((i + 1))] ${names[$i]}"
    done
    printf '  skipped, and therefore NOT proven: %s\n' "$skip_list"
  fi
  exit 0
fi

printf 'dock-recall full stack: FAIL (%d step(s)%s)\n' "$failed" \
  "$( ((skipped > 0)) && printf ', %d skipped' "$skipped")"
for i in "${!names[@]}"; do
  [[ ${results[$i]} == FAIL ]] && printf '  failed: %s  ->  %s\n' "${names[$i]}" "${notes[$i]}"
done
exit 1
