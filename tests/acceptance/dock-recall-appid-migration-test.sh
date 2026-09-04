#!/bin/bash
# dock-recall-appid-migration-test.sh — the v3 `--app-id` upgrade, end to end
# in a real Omarchy VM (Tier C).
#
# THE FINDING THIS PROVES (increment 05-dtp, A1). A 0.2.0 state file carries
# launch commands the retired backfill wrote:
#
#     <terminal> --app-id=<identity-id> <command>
#
# It forced a window class per identity so a class pattern could claim the
# window. The mechanism is gone — the terminals disagree about `--app-id` versus
# `--class`, alacritty has neither — but the FILE still says it, against an
# identity whose patterns say `^foot$`. Restoring that spawns a class-`herdr`
# window `^foot$` can never claim: a stray window per dock event plus a 10s
# launch timeout, forever, and nothing downstream repairs it. The fix lives in
# the v3 -> v4 migration (StateModel.migratedLaunch): a forced class NO pattern
# of the identity claims is the retired mechanism's signature, and that launch is
# EMPTIED — which is the one repair the existing machinery genuinely supports.
#
# The node suite pins migratedLaunch against fixtures. This file answers the
# question the fixtures cannot: does a REAL v3 file, read by a REAL service, on
# a REAL dock event, converge — no stray window, no timeout churn, and a row the
# user can repair?
#
# THE TWO IDENTITIES. Both are needed, because the discriminator is the
# IDENTITY, not the flag:
#
#   subject  patterns ["^foot$"]        launch "foot --app-id=herdr herdr"
#            The retired backfill's exact shape. `^foot$` does not claim class
#            `herdr`, so migration EMPTIES it.
#
#   control  patterns ["^scratchpad$"]  launch "/usr/bin/foot --app-id=scratchpad"
#            A hand-written scratchpad pin — forcing a class the identity's own
#            patterns DO claim is exactly how a scratchpad terminal works, and
#            an absolute path is a shape the backfill also wrote. It must
#            survive BYTE-IDENTICAL. A migration that empties this one has
#            destroyed a correct user command.
#
# WHERE THE MIGRATION LANDS, AND WHY THIS TEST WRITES ONCE. The service upgrades
# the file IN MEMORY and deliberately does not write it back (Service.qml: "the
# upgrade is lossless in memory, and rewriting a file nobody asked to change
# would both undo any backup discipline around it and strand a user who
# downgrades the plugin"). It persists at the next LEGITIMATE write — a Record,
# a panel edit, a pause toggle — none of which has an IPC surface to drive from
# a headless test. So this file proves the two halves separately and honestly:
#
#   phase 1  the SERVICE, on the v3 file: the upgrade line in its own log, no
#            herdr window across the whole settle window, no launch dispatched
#            for the subject at all, and no launch-timeout churn. The file on
#            disk is asserted STILL v3 — that contract is behaviour too.
#   phase 2  the WRITE, through the plugin's own StateModel (parse + serialize +
#            atomic rename, the exact byte path Panel.writeState takes): the
#            file that lands on disk is at the CURRENT schema version, subject
#            emptied, control verbatim.
#   phase 3  the persisted, upgraded file back under the live service, second dock
#            event: still converged. The loop closes on the file a user would
#            actually be left with.
#
# Screenshots land in $OMARCHY_ACCEPTANCE_DIR and are tarred back to the host.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"
TRIGGER="$STATE_DIR/dock-recall.trigger"

SUBJECT_ID="dr-mig-subject"
SUBJECT_PATTERN='^foot$'
SUBJECT_LAUNCH='foot --app-id=herdr herdr'
STRAY_CLASS="herdr"

CONTROL_ID="dr-mig-control"
CONTROL_PATTERN='^scratchpad$'
CONTROL_LAUNCH='/usr/bin/foot --app-id=scratchpad'

OUTPUT="dr-mig-dock"
TARGET_WS=7
SEED_VERSION=3

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# How long the service is given to finish a cycle, plus a margin generous enough
# that a 10s launch timeout would have fired twice inside it.
SETTLE_S=45
CHURN_S=30

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }

stray_windows() {
  clients | jq -r --arg c "$STRAY_CLASS" \
    '[.[]|select(.class==$c or .initialClass==$c)]|length' 2>/dev/null
}

monitor_id() {
  hyprctl monitors all -j | jq -r --arg n "$1" 'first(.[]|select(.name==$n)|.id)//empty'
}
monitor_present() { [[ -n $(monitor_id "$1") ]]; }
monitor_absent() { ! monitor_present "$1"; }

trigger() { date +%s.%N > "$TRIGGER"; }   # content must CHANGE; a bare touch is ignored

as_root() { echo "$GUEST_PASSWORD" | sudo -S "$@" 2>/dev/null; }

shell_log() { qs log -p "${OMARCHY_PATH:-/usr/share/omarchy}/shell" --tail 6000 2>/dev/null; }
dr_log() { shell_log | grep -F "[dock-recall]"; }
service_ready() { dr_log | grep -qF "service-ready"; }

# The 10s launch timeout, counted rather than matched: assertion (c) is that the
# number STOPS GROWING, which needs two readings of the same thing.
launch_timeout_count() { dr_log | grep -cF "produced no window within" ; }

plugin_state() {
  omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id { print $2 }'
}
plugin_known() { [[ -n $(plugin_state) ]]; }

capture_service_log() { dr_log > "$ARTIFACTS/dock-recall-appid-migration-service.log" 2>/dev/null || true; }

ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

# Read one identity's launch out of the on-disk file as RAW JSON — the quoted
# string, so a comparison is over bytes and not over anything jq re-encoded.
launch_json() {
  jq -c --arg id "$1" 'first(.identities[]|select(.id==$id)|.launch)' "$STATE" 2>/dev/null
}
file_version() { jq -r '.version // empty' "$STATE" 2>/dev/null; }

diagnostics() {
  echo "--- monitors ---" >&2
  hyprctl monitors all -j | jq -c '[.[]|{id,name}]' >&2
  echo "--- windows of class $STRAY_CLASS ---" >&2
  clients | jq -c --arg c "$STRAY_CLASS" \
    '[.[]|select(.class==$c or .initialClass==$c)|{address,class,initialClass,title}]' >&2
  echo "--- state file ---" >&2
  head -60 "$STATE" >&2 2>/dev/null
  echo "--- [dock-recall] log ---" >&2
  dr_log | tail -40 >&2
  capture_service_log
}

cleanup() {
  local status=$?
  set +e
  monitor_present "$OUTPUT" && hyprctl output remove "$OUTPUT" >/dev/null 2>&1
  return $status
}
trap cleanup EXIT

# Watch for a stray window for N seconds while the cycle runs and settles.
# Polling rather than a single look at the end: the pre-fix failure mode is a
# window that MAPS and then dies with its foot process, so an end-state check
# could miss the very thing this test exists to catch.
watch_for_strays() {
  # Two statements, not one: bash expands every word of a `local` before it
  # assigns any of them, so `local s="$1" deadline=$((SECONDS + s))` reads an
  # unset `s` — and under `set -u` that is a dead test, not a wrong number.
  local seconds="$1" n
  local deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    n=$(stray_windows)
    if [[ -n $n && $n != 0 ]]; then
      diagnostics
      fail "no stray $STRAY_CLASS window at any point" \
        "$n window(s) of class $STRAY_CLASS appeared — the retired --app-id launch was dispatched"
    fi
    sleep 1
  done
}

# One undock/redock cycle against the recorded topology, then the settle watch.
dock_cycle() {
  local label="$1"
  hyprctl output remove "$OUTPUT" >/dev/null 2>&1
  wait_until "dock removed ($label)" 20 monitor_absent "$OUTPUT"
  sleep 4                                   # let the undock cycle's debounce expire
  hyprctl output create headless "$OUTPUT" >/dev/null 2>&1
  wait_until "dock came back ($label)" 20 monitor_present "$OUTPUT"
  trigger
  watch_for_strays "$SETTLE_S"
}

# --------------------------------------------------------- 0. prerequisites

[[ -d $PLUGIN_SRC ]] || fail "plugin payload present" "no plugin tree at $PLUGIN_SRC"

ensure_pkg jq jq       || fail "jq available in the guest"
ensure_pkg foot foot   || fail "foot available in the guest"
ensure_pkg node nodejs || fail "node available in the guest"
pass "guest prerequisites present (jq, foot, node)"

# ------------------------------------------------------- 1. install the plugin

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed" "rsync into $PLUGIN_DIR failed"

rm -f "$STATE"

# rescanPlugins is asynchronous: enabling in the next breath answers
# `PluginRegistry.setEnabled: unknown plugin`, the plugin stays disabled and the
# service never loads — while every later assertion still "passes", because a
# migration that never ran also produces no stray window. So: rescan, WAIT for
# the registry, enable, check the answer.
omarchy-shell shell rescanPlugins >/dev/null 2>&1
wait_until "plugin registry knows $PLUGIN_ID" 30 plugin_known

enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
[[ $enable_result == "ok" ]] ||
  fail "plugin enabled" "omarchy-shell shell enablePlugin answered '$enable_result'"
[[ $(plugin_state) == "enabled" ]] ||
  fail "plugin enabled" "omarchy plugin list still reports '$(plugin_state)'"

# A SERVICE plugin only becomes live inside a real reload cycle: a hot-reloaded
# service runs QML but its Process and FileView never fire.
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after restart" 60 pgrep -f 'quickshell -n -p'
wait_until "dock-recall service reported ready" 60 service_ready
pass "plugin installed, enabled, and its service is live"

# ------------------------------------------------------ 2. dock, then seed v3

hyprctl output create headless "$OUTPUT" >/dev/null 2>&1
wait_until "fake dock monitor appeared" 20 monitor_present "$OUTPUT"
screenshot "success-dock-recall-appid-01-docked"

# The seed's version is HARDCODED 3 and must be: this file IS a v3 file, and the
# whole point is that reading it performs a migration. Reading STATE_VERSION
# here — which the round-trip test does for its own seed, correctly, because it
# wants a file that is ALREADY current — would silently stop testing anything
# the day the schema moves on. What is asserted from StateModel instead is that v3 is
# genuinely in the past.
CURRENT_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $CURRENT_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel" "StateModel.STATE_VERSION came back as '$CURRENT_VERSION'"
(( CURRENT_VERSION > SEED_VERSION )) ||
  fail "v$SEED_VERSION is an OLDER schema than this build's" \
    "StateModel.STATE_VERSION is $CURRENT_VERSION; a v$SEED_VERSION seed would not be read as a migration"
pass "this build is schema v$CURRENT_VERSION, so a v$SEED_VERSION file is read as a migration"

# The layout is built through the engine (topologyKey / monitorLabel can only be
# computed while the dock exists), but the FILE is assembled and stamped v3 by
# hand: StateModel.serializeState would stamp the current version, which is the
# one thing this seed must not be.
node -e '
  var fs = require("fs");
  var cp = require("child_process");
  var engine = require(process.argv[1] + "/engine.js");
  var statePath = process.argv[2], output = process.argv[3];
  var ws = Number(process.argv[4]), version = Number(process.argv[5]);
  var subject = { id: process.argv[6], pattern: process.argv[7], launch: process.argv[8] };
  var control = { id: process.argv[9], pattern: process.argv[10], launch: process.argv[11] };

  var monitors = JSON.parse(cp.execFileSync("hyprctl", ["monitors", "all", "-j"], { encoding: "utf8" }));
  var dock = null;
  for (var i = 0; i < monitors.length; i++) if (monitors[i].name === output) dock = monitors[i];
  if (!dock) { console.error("dock-recall migration: " + output + " not in the monitor list"); process.exit(1); }

  var key = engine.topologyKey(monitors);
  var seed = {
    version: version,
    paused: false,
    // v3 identities carry id/patterns/launch and NOTHING else: titlePatterns is
    // the v4 addition, and writing it here would hand the reader a file that had
    // already been migrated.
    identities: [
      { id: subject.id, patterns: [subject.pattern], launch: subject.launch },
      { id: control.id, patterns: [control.pattern], launch: control.launch }
    ],
    layouts: {}
  };
  seed.layouts[key] = {
    topologyKey: key,
    recordedAt: new Date().toISOString(),
    apps: [{
      identityId: subject.id,
      monitorDescription: engine.monitorLabel(dock),
      workspaceId: ws,
      occurrence: 0,
      floating: false,
      group: null,
      at: null,
      size: null
    }]
  };
  fs.writeFileSync(statePath + ".seed", JSON.stringify(seed, null, 2) + "\n");
  fs.renameSync(statePath + ".seed", statePath);
  console.log("seeded v" + version + " state for \"" + key + "\": "
    + subject.id + " on ws " + ws + " @ " + seed.layouts[key].apps[0].monitorDescription);
' "$PLUGIN_DIR" "$STATE" "$OUTPUT" "$TARGET_WS" "$SEED_VERSION" \
  "$SUBJECT_ID" "$SUBJECT_PATTERN" "$SUBJECT_LAUNCH" \
  "$CONTROL_ID" "$CONTROL_PATTERN" "$CONTROL_LAUNCH" ||
  fail "v$SEED_VERSION state file seeded"

cp "$STATE" "$ARTIFACTS/dock-recall-appid-seed-v$SEED_VERSION.json" 2>/dev/null || true
SEED_SUBJECT_LAUNCH=$(launch_json "$SUBJECT_ID")
SEED_CONTROL_LAUNCH=$(launch_json "$CONTROL_ID")
[[ $SEED_SUBJECT_LAUNCH == "\"$SUBJECT_LAUNCH\"" ]] ||
  fail "seed carries the retired --app-id launch" "subject launch reads $SEED_SUBJECT_LAUNCH"
pass "seeded a real v$SEED_VERSION file: subject carries $SEED_SUBJECT_LAUNCH, control carries $SEED_CONTROL_LAUNCH"

# ------------------------------------- 3. the service reads it as a migration

migrated_announced() { dr_log | grep -qF "state file upgraded to schema v$CURRENT_VERSION on read"; }
wait_until "service announced the v$SEED_VERSION -> v$CURRENT_VERSION upgrade" 40 migrated_announced

# The file is NOT rewritten on read, and that is a contract, not an accident:
# asserting it here is what keeps phase 2 honest about who does the writing.
[[ $(file_version) == "$SEED_VERSION" ]] ||
  fail "the file on disk is untouched by the read" \
    "expected version $SEED_VERSION still on disk, found '$(file_version)'"
pass "upgraded in memory; the file on disk is still v$SEED_VERSION (untouched until the next write)"

# ------------------------------- 4. a dock event converges, with no stray window

screenshot "success-dock-recall-appid-02-before-cycle"
dock_cycle "first"
screenshot "success-dock-recall-appid-03-settled"
pass "dock event on the migrated file: no $STRAY_CLASS window across ${SETTLE_S}s of settling"

# The sharpest form of the same claim: the retired command was never DISPATCHED.
# A stray window is the symptom; this is the cause, and it cannot be missed by a
# poll that blinked.
if dr_log | grep -qF -- "--app-id=$STRAY_CLASS"; then
  diagnostics
  fail "the retired --app-id command was never dispatched" \
    "the service log mentions --app-id=$STRAY_CLASS"
fi
if dr_log | grep -qF "launch of \"$SUBJECT_ID\""; then
  diagnostics
  fail "the retired --app-id command was never dispatched" \
    "the service log shows a launch dispatched for $SUBJECT_ID"
fi
pass "no launch was dispatched for $SUBJECT_ID, and --app-id=$STRAY_CLASS appears nowhere in the service log"

# Assertion (c): the churn. Pre-fix this grows by one per dock event, forever.
timeouts_before=$(launch_timeout_count)
sleep "$CHURN_S"
timeouts_after=$(launch_timeout_count)
[[ $timeouts_before == 0 && $timeouts_after == 0 ]] ||
  { diagnostics; fail "no launch-timeout churn after the cycle settled" \
      "launch-timeout WARNs: $timeouts_before then $timeouts_after over ${CHURN_S}s (want 0 and 0)"; }
pass "no launch-timeout churn: 0 timeout WARNs, still 0 after ${CHURN_S}s"

# --------------------------------------- 5. persist, through the plugin's writer

# The service never writes the file it merely migrated (see the header). This is
# the plugin's OWN write path — StateModel.parseState + StateModel.serializeState
# + temp-and-rename — the same serialization Panel.writeState writes when the
# user records, edits or pauses. What it is NOT is a re-implementation of the
# migration: parseState is the code under test.
#
# Counted first, because "state loaded:" is not a line this file can wait for
# without knowing how many are already there — the v3 read logged one too.
loads_before=$(dr_log | grep -cF "state loaded:")

node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2];
  var read = StateModel.parseState(fs.readFileSync(statePath, "utf8"));
  if (read.error) { console.error("parseState: " + read.error); process.exit(1); }
  if (!read.migrated) { console.error("parseState did not report a migration"); process.exit(1); }
  fs.writeFileSync(statePath + ".tmp", StateModel.serializeState(read.state));
  fs.renameSync(statePath + ".tmp", statePath);
  console.log("persisted the migrated state (migrated=" + read.migrated + ")");
' "$PLUGIN_DIR" "$STATE" || fail "the migrated state was written back through StateModel"

cp "$STATE" "$ARTIFACTS/dock-recall-appid-migrated-v$CURRENT_VERSION.json" 2>/dev/null || true

# Assertion (a), all three halves.
[[ $(file_version) == "$CURRENT_VERSION" ]] ||
  fail "the persisted file is at the current schema version" \
    "expected version $CURRENT_VERSION on disk, found '$(file_version)'"

after_subject=$(launch_json "$SUBJECT_ID")
after_control=$(launch_json "$CONTROL_ID")

[[ $after_subject == '""' ]] ||
  { diagnostics; fail "the subject's retired launch was EMPTIED by the migration" \
      "subject launch is $after_subject, wanted \"\""; }
[[ $after_control == "$SEED_CONTROL_LAUNCH" ]] ||
  { diagnostics; fail "the control's claimed-class launch survived byte-identical" \
      "control launch is $after_control, wanted $SEED_CONTROL_LAUNCH"; }

pass "migrated on disk: v$SEED_VERSION -> v$CURRENT_VERSION, subject launch $SEED_SUBJECT_LAUNCH -> $after_subject, control launch $after_control unchanged"

# ------------------------------------------------ 6. the subject is repairable

# Assertion (d). Empty is not a dead end, it is the ONE repair the existing
# machinery supports: identitiesNeedingLaunch puts the row in front of the user,
# and launchRepairIndex offers whatever the derivation answered. The control,
# with a runnable command, must be offered nothing — a repair that overwrote it
# would be the same data loss from the other direction.
node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var PanelModel = require(process.argv[1] + "/PanelModel.js");
  var statePath = process.argv[2], subject = process.argv[3], control = process.argv[4];

  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var identities = StateModel.identities(state);
  var needing = PanelModel.identitiesNeedingLaunch(identities);

  function has(list, id) { return list.indexOf(id) !== -1; }
  if (!has(needing, subject)) { console.error(subject + " is not offered a repair: " + JSON.stringify(needing)); process.exit(1); }
  if (has(needing, control)) { console.error(control + " is offered a repair and must not be"); process.exit(1); }

  // And the offer is real: hand the panel a derivation and it fills the empty
  // field with it, leaving the control alone.
  var derived = {};
  derived[subject] = "foot --title=herdr";
  derived[control] = "foot --title=scratchpad";
  var repairs = PanelModel.launchRepairIndex(identities, derived);
  if (repairs[subject] !== "foot --title=herdr") { console.error("no repair offered for " + subject); process.exit(1); }
  if (Object.prototype.hasOwnProperty.call(repairs, control)) { console.error("a repair was offered for " + control); process.exit(1); }

  console.log("repair offered for " + subject + " -> \"" + repairs[subject] + "\"; " + control + " left alone");
' "$PLUGIN_DIR" "$STATE" "$SUBJECT_ID" "$CONTROL_ID" ||
  fail "the emptied subject is repair-eligible and the control is not"
pass "the emptied subject is repair-eligible and the control is left alone"

# --------------------- 7. the persisted, upgraded file, back under the live service

# The loop closes here. Everything above proved the migration; this proves the
# file a user is actually left with still converges when the dock comes and goes.
reloaded_after_write() { (( $(dr_log | grep -cF "state loaded:") > loads_before )); }
wait_until "service reloaded the persisted v$CURRENT_VERSION file" 40 reloaded_after_write

# And it was NOT read as a migration this time: a second upgrade announcement
# would mean the write had not actually landed at the current version.
[[ $(dr_log | grep -cF "state file upgraded to schema v$CURRENT_VERSION on read") == 1 ]] ||
  { diagnostics; fail "the persisted file is read WITHOUT a migration" \
      "the upgrade line appears $(dr_log | grep -cF "state file upgraded to schema v$CURRENT_VERSION on read") times; wanted exactly the one from the v$SEED_VERSION read"; }
pass "the persisted file is read straight, with no second migration"

dock_cycle "second"
screenshot "success-dock-recall-appid-04-second-cycle"

timeouts_final=$(launch_timeout_count)
[[ $timeouts_final == 0 ]] ||
  { diagnostics; fail "the persisted file still produces no launch-timeout churn" \
      "launch-timeout WARNs: $timeouts_final"; }
pass "second dock event on the persisted v$CURRENT_VERSION file: still no $STRAY_CLASS window, still 0 launch timeouts"

capture_service_log
pass "dock-recall v3 --app-id upgrade: migrated, converged, repairable"
