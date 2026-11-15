#!/bin/bash
# reenable-rehearsal.sh — the HOST half of the 4.5 re-enable rehearsal (Tier C).
#
# WHAT THIS PROVES THAT THE STUB TEST CANNOT. omarchy-fast's migration
# 0000000123_dock_recall_reenable_45.sh puts Dock Recall back on the desk after
# migrations 118/119 switched it off. Its hermetic stub test
# (cutover/test-reenable-45.sh in the records repo) fakes `omarchy plugin add`,
# the shell and Hyprland. So two things only a real 4.5 guest can answer are
# still open:
#
#   1. the REAL `omarchy plugin add <github url> --yes` succeeds after the
#      migration moved the old directory aside, and
#   2. the RESTARTED shell keeps the jq-written plugins[] record (a shell holds
#      its config in memory and can write it back over an edit made behind its
#      back; the migration restarts it precisely so that cannot happen — here
#      the restart is a real one).
#
# This script puts a 4.5 guest in the desk's state of 2026-11-15, runs the
# migration in it, asserts, runs it a second time and asserts that was a no-op.
#
#   ./tests/acceptance/reenable-rehearsal.sh        exit 0 = the rehearsal passed
#
# IT NEEDS A RUNNING 4.5 VM, and it does not boot one: like undock-locked.sh it
# drives a VM the harness left running (`omarchy-iso-test ... --keep-running`),
# found through vm-lib.sh (DR_RUN_DIR_OVERRIDE pins which). It also needs the
# GUEST to reach github.com, because the migration installs from GitHub master
# and DEFERS (exit 75) until master is the 0.4.0 build. So it runs only AFTER
# the 4.5 build is published; a 75 is reported as exactly that, not as a failure
# of the migration.
#
# THE STATE IT BUILDS (the desk's, per the migration's own header):
#   - ~/.config/omarchy/plugins/mkelk.dock-recall = the OLD build, a
#     `git archive` of DR_OLD_REF (default c8c2748, manifest 0.3.0, no
#     Slots.js, STATE_VERSION 7) — checked here before it is pushed
#   - shell.json lists the id in neither plugins[] nor any bar.layout array
#   - bindings.lua carries migration 118's two-line note and the
#     SUPER+SHIFT+L bind commented out
#   - ~/.local/state/omarchy/dock-recall.json = tests/fixtures/state-v7.json
#   - the guest shell is restarted so its memory matches that state
#
# WHAT IT ASSERTS AFTER THE FIRST RUN: exit 0; plugins[] record AND bar entry in
# shell.json and in the running shell's own config (listShellConfig, rechecked
# after a settle so a write-back would show); the bind is live in Hyprland
# (modmask 65, key l, description) and active in bindings.lua; the installed
# manifest says DR_EXPECT_VERSION (0.4.0) and the directory is a git clone; the
# old plugin was tarred and the v7 recordings kept once; a NEW
# `[dock-recall] service-ready` line in the shell log; and after
# scripts/record-current (the next write) the recordings file reads as v9 with
# the v7 layouts still in it. Then the second run: exit 0, shell.json,
# bindings.lua, manifest and .installed-from byte-identical, no new backup, no
# restart.
#
# Environment: vm-lib.sh's (OMARCHY_ISO_DIR, DR_GUEST_SSH_PORT, GUEST_PASSWORD,
# DR_RUN_DIR_OVERRIDE, DR_RUN_MIN_EPOCH), plus
#   DR_MIGRATION       a migration file to run (default: read from the
#                      dock-recall-reenable-45 branch of OMARCHY_FAST_DIR)
#   OMARCHY_FAST_DIR   default ~/git/omarchy-fast
#   DR_OLD_REF         the old build's commit in this repo (default c8c2748)
#   DR_EXPECT_VERSION  the manifest version the install must have (default 0.4.0)

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/vm-lib.sh"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION_NAME="0000000123_dock_recall_reenable_45.sh"
MIGRATION_BRANCH="dock-recall-reenable-45"
OMARCHY_FAST_DIR="${OMARCHY_FAST_DIR:-$HOME/git/omarchy-fast}"
OLD_REF="${DR_OLD_REF:-c8c2748}"
EXPECT_VERSION="${DR_EXPECT_VERSION:-0.4.0}"
FIXTURE="$REPO_ROOT/tests/fixtures/state-v7.json"
GUEST_MIGRATION="/tmp/dr-reenable-45.sh"

failures=0
note() { printf '%s\n' "$*"; }
ok() { printf 'ok - %s\n' "$1"; }
notok() {
  printf 'not ok - %s\n' "$1" >&2
  [[ -n ${2:-} ]] && printf '  %s\n' "$2" >&2
  failures=$((failures + 1))
}
summarize() { ((failures == 0)) || echo "$failures assertion(s) failed" >&2; }
die() { notok "$1" "${2:-}"; summarize; exit 1; }

# --------------------------------------------------------------- preflight

for tool in git jq ssh; do
  command -v "$tool" >/dev/null 2>&1 ||
    { echo "not ok - dock-recall re-enable rehearsal: $tool is not installed on the host" >&2; exit 1; }
done
[[ -f $FIXTURE ]] || { echo "not ok - dock-recall re-enable rehearsal: no $FIXTURE" >&2; exit 1; }

# The migration under test, as the file the guest will run.
MIGRATION_FILE=$(mktemp)
trap 'rm -f "$MIGRATION_FILE"' EXIT
if [[ -n ${DR_MIGRATION:-} ]]; then
  cp -- "$DR_MIGRATION" "$MIGRATION_FILE" 2>/dev/null ||
    { echo "not ok - dock-recall re-enable rehearsal: cannot read DR_MIGRATION=$DR_MIGRATION" >&2; exit 1; }
else
  git -C "$OMARCHY_FAST_DIR" show "$MIGRATION_BRANCH:migrations/$MIGRATION_NAME" >"$MIGRATION_FILE" 2>/dev/null ||
    { echo "not ok - dock-recall re-enable rehearsal: no migrations/$MIGRATION_NAME on branch $MIGRATION_BRANCH of $OMARCHY_FAST_DIR (set DR_MIGRATION or OMARCHY_FAST_DIR)" >&2; exit 1; }
fi
bash -n "$MIGRATION_FILE" ||
  { echo "not ok - dock-recall re-enable rehearsal: the migration does not parse" >&2; exit 1; }

# The OLD build must really be old, or the rehearsal starts from the wrong state
# and "the migration installed the new build" would prove nothing.
old_version=$(git -C "$REPO_ROOT" show "$OLD_REF:manifest.json" 2>/dev/null | jq -r '.version // empty')
[[ -n $old_version ]] ||
  { echo "not ok - dock-recall re-enable rehearsal: DR_OLD_REF '$OLD_REF' has no manifest.json in $REPO_ROOT" >&2; exit 1; }
if git -C "$REPO_ROOT" cat-file -e "$OLD_REF:Slots.js" 2>/dev/null ||
  [[ $(printf '%s\n%s\n' "$old_version" "$EXPECT_VERSION" | sort -V | head -1) == "$EXPECT_VERSION" ]]; then
  echo "not ok - dock-recall re-enable rehearsal: DR_OLD_REF '$OLD_REF' is not the old build (manifest $old_version, Slots.js present or version >= $EXPECT_VERSION)" >&2
  exit 1
fi

dr_find_vm || {
  echo "not ok - dock-recall re-enable rehearsal: no running acceptance VM (boot one with omarchy-iso-test --keep-running, and pin it with DR_RUN_DIR_OVERRIDE)" >&2
  exit 1
}
note "run dir:   $DR_RUN_DIR"
note "guest ssh: $DR_GUEST_USER@127.0.0.1:$DR_SSH_PORT"
note "old build: $OLD_REF (manifest $old_version)"
note "migration: ${DR_MIGRATION:-$MIGRATION_BRANCH:migrations/$MIGRATION_NAME}"

# ---------------------------------------------------------- guest plumbing

# dr_ssh_session cannot take a script on stdin (vm-lib closes it), and this
# scenario ships files and scripts, so the session environment is recovered the
# same way here and the script goes in on stdin: gx <args...> < script.
SESSION_ENV='export XDG_RUNTIME_DIR=/run/user/$(id -u); \
  export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; \
  export HYPRLAND_INSTANCE_SIGNATURE=$(ls -t $XDG_RUNTIME_DIR/hypr | head -1); \
  export WAYLAND_DISPLAY=$(find $XDG_RUNTIME_DIR -maxdepth 1 -name "wayland-*" ! -name "*.lock" -printf "%f\n" | head -1); \
  export OMARCHY_PATH=/usr/share/omarchy; \
  export PATH=$OMARCHY_PATH/bin:$PATH'
gx() {
  local q
  q=$(printf ' %q' "$@")
  ssh -i "$DR_SSH_KEY" -p "$DR_SSH_PORT" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR \
    "$DR_GUEST_USER@127.0.0.1" "$SESSION_ENV; bash -s --$q"
}

# What every guest-side script shares. Checks print `PASS <name>` or
# `FAIL <name>: <why>` lines; the host turns those into ok / not ok.
read -r -d '' PRELUDE <<'EOF' || true
ID=mkelk.dock-recall
PDIR=$HOME/.config/omarchy/plugins/$ID
SJ=$HOME/.config/omarchy/shell.json
BL=$HOME/.config/hypr/bindings.lua
ST=$HOME/.local/state/omarchy
REC=$ST/dock-recall.json
SHELL_DIR=/usr/share/omarchy/shell
BIND_DESC="Dock Recall restore"
entryid='def entryid: if type == "object" then (.id // "") else tostring end;'
in_plugins() { jq -e --arg id "$ID" "$entryid"' any((.plugins // [])[]; entryid == $id)' >/dev/null 2>&1; }
on_bar() { jq -e --arg id "$ID" "$entryid"' any((.bar.layout // {}) | to_entries[] | select(.value | type == "array") | .value[]; entryid == $id)' >/dev/null 2>&1; }
ready_count() { qs log -p "$SHELL_DIR" --tail 6000 2>/dev/null | grep -F '[dock-recall]' | grep -cF service-ready || true; }
bind_live() { hyprctl -j binds 2>/dev/null | jq -e --arg d "$BIND_DESC" 'any(.[]; .modmask == 65 and (.key | ascii_downcase) == "l" and .description == $d)' >/dev/null 2>&1; }
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; }
EOF
gs() { { printf '%s\n' "$PRELUDE"; cat; } | gx "$@"; }

# Run a guest check script and turn its PASS/FAIL lines into verdicts. Anything
# else it prints is shown as a note.
checks() {
  local out line
  out=$(gs "$@") || { notok "guest check script ran" "ssh/bash returned nonzero; output: $out"; return; }
  while IFS= read -r line; do
    case $line in
      "PASS "*) ok "${line#PASS }" ;;
      "FAIL "*) notok "${line#FAIL }" ;;
      "") ;;
      *) note "  $line" ;;
    esac
  done <<<"$out"
}

# ------------------------------------------------- 1. the guest, and its network

step=$(gs "$DR_GUEST_PASSWORD" <<'EOF'
GUEST_PW="$1"
for t in git jq node; do
  command -v "$t" >/dev/null 2>&1 && continue
  pkg=$t; [ "$t" = node ] && pkg=nodejs
  echo "$GUEST_PW" | sudo -S pacman -S --noconfirm --needed "$pkg" >/dev/null 2>&1
done
for t in git jq node qs omarchy omarchy-shell hyprctl; do
  command -v "$t" >/dev/null 2>&1 || { echo "MISSING $t"; exit 0; }
done
[ -f /usr/share/omarchy/default/hypr/monitor-workspaces.lua ] || { echo "NOT45"; exit 0; }
[ -f "$SJ" ] || { echo "NOSHELLJSON"; exit 0; }
[ -f "$BL" ] || { echo "NOBINDINGS"; exit 0; }
git ls-remote https://github.com/mkelk/dock-recall.git HEAD >/dev/null 2>&1 || { echo "NONET"; exit 0; }
echo READY
EOF
)
step=$(printf '%s' "$step" | tr -d '\r' | tail -1)
case $step in
  READY) ok "the guest is a 4.5 session with git, jq, node and a route to github.com" ;;
  NONET) die "dock-recall re-enable rehearsal: the guest reaches GitHub" "git ls-remote https://github.com/mkelk/dock-recall.git failed inside the guest: the migration installs from GitHub master, so the rehearsal needs guest network" ;;
  NOT45) die "dock-recall re-enable rehearsal: the guest is Omarchy 4.5" "no default/hypr/monitor-workspaces.lua: the migration would defer on this guest" ;;
  MISSING*) die "dock-recall re-enable rehearsal: the guest has its tools" "${step}" ;;
  *) die "dock-recall re-enable rehearsal: the guest is reachable and set up" "answer: '$step'" ;;
esac

# ----------------------------------------- 2. put the guest in the desk's state

# Old plugin: a git archive of the old commit, extracted over an empty directory.
{
  printf '%s\n' "$PRELUDE"
  cat <<'EOF'
rm -rf "$PDIR"
mkdir -p "$PDIR"
EOF
} | gx >/dev/null

git -C "$REPO_ROOT" archive --format=tar "$OLD_REF" |
  ssh -i "$DR_SSH_KEY" -p "$DR_SSH_PORT" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR \
    "$DR_GUEST_USER@127.0.0.1" 'tar -x -C "$HOME/.config/omarchy/plugins/mkelk.dock-recall"' ||
  die "dock-recall re-enable rehearsal: the old build reaches the guest" "git archive $OLD_REF | tar -x failed"

ssh -i "$DR_SSH_KEY" -p "$DR_SSH_PORT" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR \
  "$DR_GUEST_USER@127.0.0.1" 'mkdir -p "$HOME/.local/state/omarchy" && cat > "$HOME/.local/state/omarchy/dock-recall.json"' <"$FIXTURE" ||
  die "dock-recall re-enable rehearsal: the v7 recordings reach the guest" "writing the fixture failed"

ssh -i "$DR_SSH_KEY" -p "$DR_SSH_PORT" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR \
  "$DR_GUEST_USER@127.0.0.1" "cat > $GUEST_MIGRATION" <"$MIGRATION_FILE" ||
  die "dock-recall re-enable rehearsal: the migration reaches the guest" "writing $GUEST_MIGRATION failed"

# shell.json, bindings.lua, leftovers, then a real shell restart so the shell's
# memory agrees with the files.
gs >/dev/null <<'EOF'
# shell.json: the id out of plugins[] and out of every bar.layout array.
tmp=$(mktemp "$SJ.XXXXXX")
jq --arg id "$ID" "$entryid"'
  (.plugins // []) as $p | .plugins = [$p[] | select(entryid != $id)]
  | if (.bar.layout // null) | type == "object"
    then .bar.layout |= with_entries(.value |= (if type == "array" then [.[] | select(entryid != $id)] else . end))
    else . end' "$SJ" >"$tmp" && cp "$tmp" "$SJ"
rm -f "$tmp"
# bindings.lua: drop anything of ours (a previous rehearsal's too), then
# migration 118's disabled form: two note lines and the bind commented out.
tmp=$(mktemp "$BL.XXXXXX")
grep -vE 'summon mkelk\.dock-recall|Disabled by omarchy-fast migration 118|^-- Omarchy 4\.5 per-monitor workspaces\.$|omarchy-fast: dock_recall_reenable_45|^-- The .\{"focus":"restore"\}. payload|^-- focused, so Enter completes|^-- never rearranges windows on its own' "$BL" >"$tmp" || true
cat >>"$tmp" <<'LUA'
-- Disabled by omarchy-fast migration 118: Dock Recall conflicts with
-- Omarchy 4.5 per-monitor workspaces.
-- o.bind("SUPER + SHIFT + L", "Dock Recall restore", [[omarchy-shell shell summon mkelk.dock-recall '{"focus":"restore"}']])
LUA
cp "$tmp" "$BL"; rm -f "$tmp"
# Leftovers of an earlier run in this VM.
rm -f "$ST"/dock-recall-plugin.pre-4.5-*.tar.gz "$REC".pre-4.5-* "$PDIR/.installed-from"
rm -rf "$ST"/.dock-recall-old.* "$ST"/.dock-recall-probe.*
hyprctl reload >/dev/null 2>&1 || true
omarchy-restart-shell >/dev/null 2>&1 || true
EOF

# The restarted shell has to answer before anything is asserted about it.
checks <<'EOF'
up=0
for _ in $(seq 1 40); do
  [ "$(omarchy-shell shell ping 2>/dev/null || true)" = ok ] && { up=1; break; }
  sleep 1.5
done
[ $up = 1 ] && pass "the guest shell is back up after the restart that sets the desk's state" || fail "the guest shell answers ping after the setup restart"
v=$(jq -r '.version' "$PDIR/manifest.json" 2>/dev/null)
[ -n "$v" ] && [ ! -e "$PDIR/Slots.js" ] && pass "pre-state: the old plugin is installed (manifest $v, no Slots.js)" || fail "pre-state: the old plugin is installed (manifest '$v')"
in_plugins <"$SJ" && fail "pre-state: shell.json has no plugins[] record" || pass "pre-state: shell.json has no plugins[] record"
on_bar <"$SJ" && fail "pre-state: shell.json has no bar entry" || pass "pre-state: shell.json has no bar entry"
grep -vE '^[[:space:]]*--' "$BL" | grep -qF "summon $ID" && fail "pre-state: the SUPER+SHIFT+L bind is commented out" || pass "pre-state: the SUPER+SHIFT+L bind is commented out"
bind_live && fail "pre-state: the bind is not live in Hyprland" || pass "pre-state: the bind is not live in Hyprland"
[ "$(jq -r '.version' "$REC")" = 7 ] && pass "pre-state: the recordings file is v7" || fail "pre-state: the recordings file is v7"
EOF
((failures == 0)) || { summarize; exit 1; }

READY_BEFORE=$(gs <<'EOF' | tr -d '\r\n'
ready_count
EOF
)
note "service-ready lines in the shell log before the migration: ${READY_BEFORE:-?}"

# ------------------------------------------------------- 3. the first run

echo
echo "=== the migration, first run ==="
log1="$DR_RUN_DIR/dock-recall-reenable-rehearsal-run1.log"
gx <<EOF >"$log1" 2>&1
timeout 900 bash $GUEST_MIGRATION
echo "MIGRATION_EXIT=\$?"
EOF
sed 's/^/  | /' "$log1"
exit1=$(sed -n 's/^MIGRATION_EXIT=//p' "$log1" | tail -1)
case $exit1 in
  0) ok "the migration exits 0 on the desk's old state" ;;
  75) die "dock-recall re-enable rehearsal: the migration applies" "exit 75 = DEFERRED. If the output above says the GitHub default branch is not the 4.5 build yet, publish master first; this rehearsal runs only after that. Nothing was installed." ;;
  *) die "dock-recall re-enable rehearsal: the migration exits 0" "exit '${exit1:-none}' — see $log1" ;;
esac
grep -qF "Installed mkelk.dock-recall v" "$log1" &&
  ok "the real omarchy plugin add installed the plugin after the move-aside" ||
  notok "the real omarchy plugin add installed the plugin after the move-aside" "no 'Installed mkelk.dock-recall v…' line in the output"

# Let the restarted shell settle: if it were going to write its in-memory config
# back over shell.json, it would have done so by now.
sleep 8

checks "$EXPECT_VERSION" "$READY_BEFORE" <<'EOF'
want="$1"; before="${2:-0}"
in_plugins <"$SJ" && pass "shell.json has the plugins[] record" || fail "shell.json has the plugins[] record"
on_bar <"$SJ" && pass "shell.json has the bar entry" || fail "shell.json has the bar entry"
live=$(omarchy-shell shell listShellConfig 2>/dev/null || true)
echo "$live" | in_plugins && pass "the restarted shell keeps the plugins[] record (listShellConfig)" || fail "the restarted shell keeps the plugins[] record: listShellConfig lacks it"
echo "$live" | on_bar && pass "the restarted shell keeps the bar entry (listShellConfig)" || fail "the restarted shell keeps the bar entry: listShellConfig lacks it"
grep -vE '^[[:space:]]*--' "$BL" | grep -qF "summon $ID" && pass "bindings.lua has the active SUPER+SHIFT+L bind" || fail "bindings.lua has the active SUPER+SHIFT+L bind"
grep -qF 'Disabled by omarchy-fast migration 118' "$BL" && fail "118's note lines are gone from bindings.lua" || pass "118's note lines are gone from bindings.lua"
bind_live && pass "the SUPER+SHIFT+L bind is live in Hyprland (modmask 65, key l, '$BIND_DESC')" || fail "the SUPER+SHIFT+L bind is live in Hyprland"
errs=$(hyprctl configerrors 2>&1 || true)
{ [ -z "$errs" ] || printf '%s' "$errs" | grep -q 'no errors'; } && pass "hyprctl configerrors is clean" || fail "hyprctl configerrors is clean: $errs"
v=$(jq -r '.version // "?"' "$PDIR/manifest.json" 2>/dev/null)
[ "$v" = "$want" ] && pass "the installed plugin manifest says $want" || fail "the installed plugin manifest says $want (it says '$v')"
[ -f "$PDIR/Slots.js" ] && pass "the installed plugin is the 4.5 build (Slots.js present)" || fail "the installed plugin has Slots.js"
git -C "$PDIR" rev-parse HEAD >/dev/null 2>&1 && pass "the plugin directory is a git clone (omarchy plugin update works)" || fail "the plugin directory is a git clone"
[ -s "$PDIR/.installed-from" ] && pass ".installed-from is written ($(cut -c1-12 "$PDIR/.installed-from"))" || fail ".installed-from is written"
ls "$ST"/dock-recall-plugin.pre-4.5-*.tar.gz >/dev/null 2>&1 && pass "the old plugin was tarred to $ST" || fail "the old plugin was tarred to $ST"
ls "$REC".pre-4.5-* >/dev/null 2>&1 && pass "the v7 recordings were kept once" || fail "the v7 recordings were kept once"
ls -d "$ST"/.dock-recall-old.* >/dev/null 2>&1 && fail "no move-aside directory is left behind" || pass "no move-aside directory is left behind"
ok=0
for _ in $(seq 1 40); do
  n=$(ready_count)
  [ "${n:-0}" -gt "${before:-0}" ] && { ok=1; break; }
  sleep 1.5
done
[ $ok = 1 ] && pass "'[dock-recall] service-ready' is in the shell log ($before -> $n)" || fail "'[dock-recall] service-ready' is in the shell log: still $n line(s) after 60 s (was $before)"
EOF

# --------------------------------------- 4. the recordings read as v9 after a write

checks <<'EOF'
# The next write: record-current goes through the engine and writes the file.
[ -f "$REC" ] || { fail "the recordings file exists"; exit 0; }
echo "recordings before the write: v$(jq -r '.version' "$REC")"
out=$(node "$PDIR/scripts/record-current" 2>&1); rc=$?
[ $rc = 0 ] && pass "record-current (the next write) succeeds on the migrated file" || fail "record-current succeeds on the migrated file: $out"
[ "$(jq -r '.version' "$REC")" = 9 ] && pass "the recordings file reads as v9 after the write" || fail "the recordings file reads as v9 after the write (v$(jq -r '.version' "$REC"))"
EOF
fixture_layouts=$(jq -c '.layouts | keys' "$FIXTURE")
checks "$fixture_layouts" <<'EOF'
want="$1"
jq -e --argjson want "$want" '(.layouts | keys) as $have | all($want[]; . as $k | $have | index($k) != null)' "$REC" >/dev/null 2>&1 &&
  pass "the v7 layouts survived the v7 -> v9 write" || fail "the v7 layouts survived the v7 -> v9 write (have $(jq -c '.layouts | keys' "$REC"))"
EOF

# ------------------------------------------------------- 5. the second run

echo
echo "=== the migration, second run (must be a no-op) ==="
SNAP=$(gs <<'EOF'
{ sha256sum "$SJ" "$BL" "$PDIR/manifest.json" "$PDIR/.installed-from" 2>&1
  ls "$ST"/dock-recall-plugin.pre-4.5-*.tar.gz "$REC".pre-4.5-* "$SJ".bak-* 2>&1
  echo "ready=$(ready_count)"; } | sort
EOF
)
log2="$DR_RUN_DIR/dock-recall-reenable-rehearsal-run2.log"
gx <<EOF >"$log2" 2>&1
timeout 900 bash $GUEST_MIGRATION
echo "MIGRATION_EXIT=\$?"
EOF
sed 's/^/  | /' "$log2"
exit2=$(sed -n 's/^MIGRATION_EXIT=//p' "$log2" | tail -1)
[[ $exit2 == 0 ]] && ok "the second run exits 0" ||
  notok "the second run exits 0" "exit '${exit2:-none}' — see $log2"
SNAP2=$(gs <<'EOF'
{ sha256sum "$SJ" "$BL" "$PDIR/manifest.json" "$PDIR/.installed-from" 2>&1
  ls "$ST"/dock-recall-plugin.pre-4.5-*.tar.gz "$REC".pre-4.5-* "$SJ".bak-* 2>&1
  echo "ready=$(ready_count)"; } | sort
EOF
)
if [[ $SNAP == "$SNAP2" ]]; then
  ok "the second run changed nothing: shell.json, bindings.lua, manifest, .installed-from, backups"
else
  notok "the second run changed nothing" "$(diff <(printf '%s\n' "$SNAP") <(printf '%s\n' "$SNAP2") | head -12)"
fi
grep -qF "already the 4.5 build" "$log2" &&
  ok "the second run says the plugin is already the 4.5 build" ||
  notok "the second run says the plugin is already the 4.5 build" "no such line in $log2"
grep -qF "Restarting the Omarchy shell" "$log2" &&
  notok "the second run does not restart the shell" "it printed 'Restarting the Omarchy shell…'" ||
  ok "the second run does not restart the shell"

summarize

if ((failures == 0)); then
  echo "ok - dock-recall re-enable rehearsal: old state, migrated, bind live, 0.4.0, service-ready, v9 after a write, second run a no-op"
  exit 0
fi
echo "not ok - dock-recall re-enable rehearsal: $failures assertion(s) failed" >&2
exit 1
