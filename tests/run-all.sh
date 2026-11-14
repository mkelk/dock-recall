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
#   3. qmllint                            SYNTAX ONLY, on every QML file the
#                                         repository ships — from a glob, not a
#                                         list, so a new one cannot be missed.
#                                         Never cite it as evidence that
#                                         bindings resolve — an unknown id was
#                                         once injected and it passed.
#   4. tests/sandbox-dock.sh              Tier B: the plugin's own service and
#                                         panel, live in a nested compositor you
#                                         never see. Launch / scatter / no-op.
#      tests/sandbox-slots.sh             Tier B, Omarchy 4.5: three apps on two
#                                         slots, dock -> undock -> dock, each
#                                         window on its recorded (monitor, slot).
#      tests/sandbox-fidelity.sh          Tier B, epic 9i2: within-workspace
#                                         fidelity, seven cases — the tiling
#                                         tree, the tab group beside a tiled
#                                         window, the visible tab, the refusals
#                                         for a scrolling workspace and an
#                                         ambiguous tree.
#      tests/sandbox-reload.sh            Tier B: a config reload with the
#                                         monitors unchanged restores nothing;
#                                         one beside an added output restores.
#   5. tests/sandbox-future-version.sh --both   a schema-v99 file is INERT, with
#                                         the same-seed control arm that makes
#                                         "nothing happened" mean something.
#   6. tests/sandbox-reserved-id.sh       an identity id that collides with an
#                                         Object.prototype key survives the round
#                                         trip.
#   7. tests/sandbox-nested-guard.sh      the sandbox itself: a nested compositor
#                                         started OUTSIDE the parked launch path
#                                         refuses to configure, so it can never
#                                         again open a window on the user's desk.
#   8. tests/acceptance/run.sh            Tier C: a disposable Omarchy VM — real
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
# unattended gate. Steps 4-7 run a second Hyprland parked on a special
# workspace and assert the live desk is untouched, which is why they are safe
# here; the acceptance VM is headless for the same reason.
#
# Environment:
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

# EVERY QML FILE, FROM A GLOB (tick md1). This was a hand-maintained argument
# list, and it is the same class of guard as tests/qml-plaintext.test.js's scan
# targets: tick xk5 shipped MapWorkspace.qml outside BOTH of them and tick y4y
# spent a whole tick retro-fitting them. A file the linter is never handed is a
# file whose syntax nothing checks, and the omission is silent.
#
# The plugin installs its clone root and its QML sits at the top level (see
# CLAUDE.md), so `*.qml` here IS the set. An empty expansion has to be an ERROR
# rather than a `qmllint '*.qml'` that lints a file by that name, or a step that
# passes having checked nothing at all.
qml_files=()
for qml in *.qml; do
  [[ -e $qml ]] || continue
  qml_files+=("$qml")
done
if ((${#qml_files[@]} == 0)); then
  printf '\033[1;31mno QML files in %s — the qmllint step would check nothing\033[0m\n' "$REPO_ROOT"
  exit 1
fi

step "qmllint (syntax) on all ${#qml_files[@]} QML files" \
  qmllint -I "$OMARCHY_PATH/shell" "${qml_files[@]}"

step "tests/sandbox-dock.sh" \
  ./tests/sandbox-dock.sh

step "tests/sandbox-slots.sh" \
  ./tests/sandbox-slots.sh

step "tests/sandbox-fidelity.sh" \
  ./tests/sandbox-fidelity.sh

step "tests/sandbox-reload.sh" \
  ./tests/sandbox-reload.sh

step "tests/sandbox-future-version.sh --both" \
  ./tests/sandbox-future-version.sh --both

step "tests/sandbox-reserved-id.sh" \
  ./tests/sandbox-reserved-id.sh

step "tests/sandbox-nested-guard.sh" \
  ./tests/sandbox-nested-guard.sh

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
