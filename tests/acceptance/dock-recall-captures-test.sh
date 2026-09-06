#!/bin/bash
# dock-recall-captures-test.sh — record-time pictures, on the guest filesystem.
#
# Runs INSIDE a disposable Omarchy VM booted by omarchy-iso's harness, in a real
# Hyprland session with a real Quickshell shell.
#
# WHY THIS ONE ASSERTS ON FILES. The rest of increment 06-bwf is proven at
# bind level — the panel reports what it computed and bound, and this venue
# cannot show a pixel was rasterized. Captures are the exception, and the reason
# this test exists as its own file: a picture on disk is a real artifact. It can
# be counted, named, opened and shown to be a JPEG, which is a strictly stronger
# claim than any payload field, so it is made here rather than through the IPC.
#
# WHAT IT PINS
#
#   THE WRITE       — Record stores one picture per WATCHED app, keyed on
#                     (identityId, occurrence, topologyKey). The expected names
#                     are computed by asking the plugin's own
#                     PanelModel.captureFileName with the topology key read out
#                     of the state file the record just wrote — so the test
#                     agrees with the code about the key by construction, and
#                     disagrees loudly about everything else. BOTH apps, by
#                     name: pictures are on by default now (schema v7), and a
#                     count of two cannot tell "one each" from "two of one".
#   THE SWITCH      — one entry in the overflow menu governs every picture there
#                     is. Off deletes every stored one and stops photographing;
#                     on resumes at the next open and the next Record. That is
#                     the whole privacy claim, and it survives a shell restart.
#   THE FORMAT      — the bytes are a JPEG with a real frame header, and it is
#                     at most 512 px wide. Read with a 30-line SOF parser in
#                     node rather than with `file`: a magic number says only
#                     that the first two bytes are right, and neither host nor
#                     guest has an imaging library. The parser walking the
#                     segment chain to a frame marker IS the decode this venue
#                     can honestly perform.
#   THE SUBJECT     — and this is the one the format assertions cannot make. The
#                     name proves the KEY; nothing proved the PIXELS, and every
#                     assertion above passes on a store that photographed the
#                     other window, the panel's own 1x1 host surface scaled up,
#                     or the whole output — both test windows are the same
#                     binary, so their content cannot tell them apart. Their
#                     SHAPES can: they are floated at aspect ratios five times
#                     apart, and EACH stored JPEG's proportions have to be its
#                     OWN window's and not the other one's. Two pictures, two
#                     shapes, checked both ways round — which is strictly more
#                     than the old single-picture version could ask.
#   RE-RECORD       — records again and requires the file to have CHANGED, not
#                     merely to still be there. A capture path that quietly
#                     stopped writing would leave the first record's picture in
#                     place and pass a count.
#   UNDO            — the layout goes and the pictures go with it. Undo cannot
#                     put pictures BACK (the re-record overwrote them in place,
#                     and nothing kept the pixels), and that is asserted as the
#                     behaviour rather than left as a surprise: the restored
#                     recording falls back to icons.
#   FORGET          — the delete point. No picture of this topology survives it.
#   A FAILED CAPTURE CANNOT FAIL A RECORD — driven, not argued. The cache
#                     directory is made uncreatable, a record is performed, and
#                     the state file has to come out complete with the layout in
#                     it and no picture anywhere.
#   A WIPED CACHE   — the directory is deleted under a live panel, and every
#                     chip has to go on reporting an icon source with no capture
#                     path and nothing erroring. That is the degradation this
#                     feature is designed around, and the reason the pictures
#                     are a cache rather than state.
#   THE DRAWING     — `capturePath` is what the PANEL says (the cache holds a
#                     file for this chip) and `captureSource` is what the CHIP
#                     says (the file:// URL its Image bound, reported only once
#                     that Image is Ready). Two keys, two claims, agreeing by
#                     construction — so a chip reporting a path and no source is
#                     one the map decided not to draw.
#   BOTH RENDER PATHS — the layout's geometry is stripped so the recorded map
#                     drops to the stacked fallback, and the SAME file has to be
#                     drawn there, on a chip that still reports its name. The
#                     cache key carries no geometry, so this is literally one
#                     picture on two paths and not a second recording. The
#                     Recorded map is entirely the fallback in the field, and
#                     the project's learnings record it engaging silently and
#                     hiding a broken model for two live rounds.
#   NO PROMPT, EVER — the assertion that replaced a whole dialogue. After the
#                     first Record that stored pictures, the payload carries
#                     NONE of consentOpen, consentChoices, consentCaptures,
#                     pictureConsent — asserted ABSENT with has(), because
#                     present-and-null is a different payload and the README is
#                     normative about the difference — and `pictures` is there
#                     and true.
#   EVERY DESK      — and this one needs TWO topologies, because an eviction
#                     keyed on the desk you happen to be plugged into passes
#                     every other assertion in this file. A second headless
#                     output is docked, a picture is stored on each side of it,
#                     and then the switch is thrown ONCE: both have to go. The
#                     same for unticking the app, which is still a per-app act.
#   THE LIVE MAP     — and this is the one assertion in the file that is about a
#                     picture NOT being on disk. The Live map draws what the
#                     windows look like right now, from memory: BOTH watched
#                     apps get one, every chip still reports an icon, and the
#                     cache DIRECTORY is never even created. It is asserted
#                     between the wiped-cache step and the unwritable-cache
#                     step, both of which need that directory gone, so the
#                     filesystem itself carries the claim. Then the pictures are
#                     switched off with the panel still open: the live ones stop
#                     and the stored ones are deleted, without a reopen — and
#                     switched back on, they come back without one either.
#   ONE CAPTURE GONE — the file is deleted and the panel re-summoned. It must be
#                     offered no picture at all. Asserted on a FRESH panel
#                     because that is the honest shape: within one session a
#                     chip that has already decoded its picture goes on drawing
#                     it, and the shell destroys the panel on hide anyway.
#
# HOW A RECORD IS REACHED. Through the panel's own IpcHandler — `dock-recall
# record`, `undoRecord`, `forgetLayout` — which route to root.recordLayout,
# undoRecord and forgetLayout and nothing else. That matters: the pictures are
# taken by the RECORD path, and `scripts/record-current` writes through
# StateModel without ever opening a panel, so it takes no pictures and never
# could. Before those verbs this act had no door a headless test could use.
#
# The panel is DISMISSED and both apps are killed on the way out, however this
# test ends: its layer takes keyboard focus exclusively, and the tests after it
# in the same boot want the desk back.

set -uo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/dock-recall"
PLUGIN_ID="mkelk.dock-recall"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

STATE_DIR="$HOME/.local/state/omarchy"
STATE="$STATE_DIR/dock-recall.json"

# The cache, exactly as Panel.qml computes it: XDG_CACHE_HOME or ~/.cache, then
# omarchy/dock-recall. The guest sets no XDG_CACHE_HOME, and that is asserted
# rather than assumed — a guest that did set one would send the plugin somewhere
# else and every file assertion below would be looking at an empty directory.
CACHE_PARENT="$HOME/.cache/omarchy"
CACHE_DIR="$CACHE_PARENT/dock-recall"

# TWO APPS, and the pair is still the point — but it is a different point since
# schema v7. There is no per-app consent to withhold any more: BOTH are watched
# and both are photographed, and what the pair proves is that each picture is of
# its OWN window. They are shaped five times apart on purpose (step 2b) and
# named for their shapes, because that is the only thing about them that differs
# — same binary, same class, same everything else.
WIDE_TITLE="dock-recall-wide"
WIDE_IDENTITY="dr-wide"
TALL_TITLE="dock-recall-tall"
TALL_IDENTITY="dr-tall"
# The two of them as the recording will list them. Every "which apps does the
# layout name" check below reads the file through jq's `sort`, so the expected
# side is sorted by the SAME tool — "dr-tall" sorts before "dr-wide", and the
# first remote gate run (j18) failed on a literal written in declaration order
# against a list jq had sorted. Like with like, computed once.
EXPECTED_APPS=$(jq -rn --arg a "$WIDE_IDENTITY" --arg b "$TALL_IDENTITY" '[$a, $b] | sort | join(",")')
APP_CLASS="foot"

PANEL_NAMESPACE="mkelk-dock-recall"
IPC_TARGET="dock-recall"

# A SECOND DESK, for the assertions that are about "every desk" (tick sp7). The
# fake dock is `hyprctl output create headless`, the same trick the roundtrip
# test docks with — a second monitor changes the topology key, so a Record on
# each side of it stores its picture under a different prefix. One desk cannot
# prove any of those claims: an eviction keyed on the desk you are plugged into
# passes every single-topology assertion in this file.
DOCK_OUTPUT="dr-cap-dock"

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

# HOW LONG A CAPTURE ROUND IS GIVEN, READ OUT OF THE STORE ITSELF (tick 070).
#
# Every wait below that is really a wait on a capture round used to be a flat
# `poll 40`, and CaptureStore's own whole-queue deadline is 45 s. Those two
# numbers disagree, and the disagreement is not academic: a round that is merely
# SLOW is failed here five seconds before the store would have said a word about
# it, so the diagnostics dump lands on a log that is still legitimately quiet and
# the reader is left with "the round went silent" for something that had not
# finished. That is exactly how tick 070's real bug was first mis-read.
#
# So the number is the store's, plus headroom for the record, the mkdir, the
# eviction `find` and the listing that bracket the round — and it is READ from
# the source rather than copied, because a copied constant is a constant that
# drifts. A round that genuinely hangs is still caught: it is caught by the
# store, which warns, and then by this poll a few seconds later.
CAPTURE_TOTAL_MS=$(sed -n 's/^[[:space:]]*property int totalMs:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' \
  "$PLUGIN_SRC/CaptureStore.qml" | head -1)
[[ $CAPTURE_TOTAL_MS =~ ^[0-9]+$ ]] ||
  fail "the capture round's deadline can be read from CaptureStore.qml (captures)" \
    "no 'property int totalMs' in $PLUGIN_SRC/CaptureStore.qml — got '$CAPTURE_TOTAL_MS'"
ROUND_S=$(( CAPTURE_TOTAL_MS / 1000 + 15 ))

TOPOLOGY_KEY=""
WIDE_FILE=""

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }
as_root() { echo "$GUEST_PASSWORD" | sudo -S "$@" 2>/dev/null; }
shell_log() { qs log -p "${OMARCHY_PATH:-/usr/share/omarchy}/shell" --tail 3000 2>/dev/null; }
dr_log() { shell_log | grep -F "[dock-recall]"; }
service_ready() { dr_log | grep -qF "service-ready"; }
# WORD FOR WORD the other four copies of this in this directory (tick md1).
# This one had drifted into an UNANCHORED regex over the whole line, inferring
# the state from a substring — and `PLUGIN_ID` contains a `.`, so the pattern
# matched more than it meant to; a format change that moved the word "enabled"
# would have reported `disabled` for an enabled plugin, and the enable step
# below would then have chased a phantom.
plugin_state() {
  omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$1 == id { print $2 }'
}
plugin_known() { [[ -n $(plugin_state) ]]; }
panel_layer_present() {
  hyprctl layers -j | jq -e --arg ns "$PANEL_NAMESPACE" \
    '[..|objects|select(.namespace? == $ns)]|length > 0' >/dev/null
}
panel_layer_absent() { ! panel_layer_present; }
panel_state_json() { omarchy-shell "$IPC_TARGET" state 2>/dev/null; }

window_address() {
  clients | jq -r --arg t "$1" 'first(.[]|select(.initialTitle==$t)|.address)//empty'
}
window_here() { [[ -n $(window_address "$1") ]]; }

monitor_id() {
  hyprctl monitors all -j | jq -r --arg n "$1" 'first(.[]|select(.name==$n)|.id)//empty'
}
monitor_present() { [[ -n $(monitor_id "$1") ]]; }
monitor_absent() { ! monitor_present "$1"; }

# The app list's key for the WIDE app, found the way a finger finds it: from the
# window, through the chip that draws it, to the row it is linked to. Not from
# the row's name, because both windows are class `foot` and only their titles
# differ, and not from any per-app picture field — there is none since v7.
#
# The link key is a live-map fact, so the caller puts the panel on the live map
# first.
wide_row_key() {
  local address link
  address=$(window_address "$WIDE_TITLE")
  [[ -n $address ]] || return 1
  link=$(panel_state_json | jq -r --arg a "$address" \
    'first(.chips[]|select(.key == $a)|.linkKey)//empty')
  [[ -n $link ]] || return 1
  panel_state_json | jq -r --arg l "$link" 'first(.rows[]|select(.linkKey == $l)|.key)//empty'
}

# Every topology the state file has a layout for, and the picture each one would
# hold for the named app — asked of the plugin's own naming function, exactly as
# WIDE_FILE is, so the test agrees with the code about the key by construction
# and disagrees loudly about everything else.
expected_files_for_all_layouts() {
  node -e '
    var fs = require("fs");
    var panel = require(process.argv[1] + "/PanelModel.js");
    var state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    var keys = Object.keys((state && state.layouts) || {}).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(panel.captureFileName(process.argv[3], 0, keys[i]));
    process.stdout.write(out.sort().join("\n"));
  ' "$PLUGIN_DIR" "$STATE" "$1"
}

layout_count() { jq -r '(.layouts|keys|length)//0' "$STATE" 2>/dev/null; }
layouts_are() { [[ $(layout_count) -eq "$1" ]]; }

# base-test.sh's wait_until aborts on timeout, which is right for most steps but
# leaves no room to dump diagnostics first. poll returns instead.
poll() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# RECORD ONCE, AND THEN WAIT — never `poll <n> some_function_that_records`.
#
# A poll whose body issues `record` re-issues it on the SUCCESSFUL iteration
# too: the loop records, the check it is polling for finally passes, and the
# section proceeds with the round that very call just started STILL IN FLIGHT.
# Everything after it — an untick, a dock, a switch — then lands mid-round,
# which is the interleave the store's write-time gate exists for and is not what
# any of these steps means to be testing. It is also how a step can pass for the
# wrong reason: the assertion sees the PREVIOUS round's files while a new round
# is still writing over them.
#
# THE ONE LEGITIMATE RETRY is the busy refusal. `record` answers "cannot-record"
# when `canRecord` is dimmed, and a capture round in flight is exactly what dims
# it — so "ask again in a second" is the right answer to that and only to that.
# "The file does not say what I wanted yet" is not a reason to record again; it
# is a reason to keep waiting, which is what the caller's own poll is for.
record_once() {
  local what="$1" answer deadline
  deadline=$((SECONDS + 60))
  while :; do
    answer=$(omarchy-shell "$IPC_TARGET" record 2>&1)
    [[ $answer == "recorded" ]] && return 0
    [[ $answer == "cannot-record" ]] || break
    ((SECONDS < deadline)) || break
    sleep 1
  done
  diagnostics
  fail "panel IPC records ($what)" "record answered '$answer'"
}

# Every .jpg the cache holds right now, one per line, sorted. A missing
# directory is an empty listing and NOT an error — that is the state the plugin
# ships in and the state a cleaner leaves behind.
cache_files() {
  find "$CACHE_DIR" -maxdepth 1 -type f -name '*.jpg' -printf '%f\n' 2>/dev/null | sort
}
cache_count() { cache_files | grep -c . ; }
cache_is() { [[ $(cache_count) -eq "$1" ]]; }

# THE PANEL'S OWN VIEW OF THE DESK — waited for after EVERY dock and undock.
#
# `monitor_present`/`monitor_absent` are the COMPOSITOR's answer, and the
# compositor is not what builds the topology key: recordLayout reads the panel's
# own copy of the monitor list, which arrives an event later. A record made
# inside that window files the layout — and its picture — under the desk that
# just went away, and a count-only check cannot see it, because one file is one
# file whichever desk it belongs to.
#
# Tick m1p fixed exactly this at ONE of the six desk changes in this file and
# left a learning saying the siblings were "a defect waiting for the first run
# that reaches it". The first run that reached one failed here. So it is fixed
# as a CLASS: every transition below waits for the panel, not for hyprctl.
panel_topology() { panel_state_json | jq -r '.topologyName // ""'; }
panel_sees_dock()    { panel_state_json | jq -e --arg d "$DOCK_OUTPUT" '(.topologyName|contains($d))' >/dev/null; }
panel_sees_no_dock() { panel_state_json | jq -e --arg d "$DOCK_OUTPUT" '(.topologyName|contains($d))|not' >/dev/null; }

await_panel_docked() {
  poll 30 panel_sees_dock && return 0
  diagnostics
  fail "the panel noticed the dock ($1)" \
    "the panel still reports topology \"$(panel_topology)\" after $DOCK_OUTPUT appeared"
}
await_panel_undocked() {
  poll 30 panel_sees_no_dock && return 0
  diagnostics
  fail "the panel noticed the undock ($1)" \
    "the panel still reports topology \"$(panel_topology)\" after $DOCK_OUTPUT was removed"
}

# A structural decode, not a magic-number peek. Walks the JPEG segment chain to
# a start-of-frame marker and prints "<width>x<height>"; anything that is not a
# JPEG with a real frame header prints nothing and exits 1.
jpeg_size() {
  node -e '
    var fs = require("fs");
    var b = fs.readFileSync(process.argv[1]);
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) process.exit(1);
    var i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xFF) process.exit(1);
      var marker = b[i + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      var length = b.readUInt16BE(i + 2);
      // SOF0..SOF15, minus the two that are not frame headers.
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        process.stdout.write(b.readUInt16BE(i + 7) + "x" + b.readUInt16BE(i + 5));
        process.exit(0);
      }
      i += 2 + length;
    }
    process.exit(1);
  ' "$1"
}

capture_service_log() { dr_log > "$ARTIFACTS/dock-recall-captures-service.log" 2>/dev/null || true; }

ensure_pkg() {
  command -v "$1" >/dev/null && return 0
  echo "installing missing guest package: $2"
  as_root pacman -S --noconfirm --needed "$2" >/dev/null 2>&1
  command -v "$1" >/dev/null
}

diagnostics() {
  # THE SHELL INSTANCES FIRST, because two of this file's failures are only
  # legible against them. `dr_log` reads the log of the shell at
  # $OMARCHY_PATH/shell, and this test restarts that shell — so a failure after
  # the restart can be "the assertion is wrong" or "the log being read belongs
  # to a process that is gone", and nothing else in this dump tells those apart.
  # `qs list -j` names every running instance with its pid and its path.
  echo "--- quickshell instances ---" >&2
  qs list -j >&2 2>/dev/null || echo "(qs list unavailable)" >&2
  echo "--- cache dir ---" >&2
  ls -la "$CACHE_DIR" >&2 2>/dev/null || echo "(no $CACHE_DIR)" >&2
  ls -ld "$CACHE_PARENT" >&2 2>/dev/null || echo "(no $CACHE_PARENT)" >&2
  echo "--- state file ---" >&2
  head -60 "$STATE" >&2 2>/dev/null
  echo "--- panel state (raw) ---" >&2
  panel_state_json | head -c 3000 >&2
  echo >&2
  echo "--- shell log: errors, and anything naming our QML (UNFILTERED) ---" >&2
  # THE FILTERED LOG BELOW CANNOT SHOW A PANEL THAT NEVER LOADED, and that cost
  # a whole VM cycle: a QML error carries no "[dock-recall]" prefix, so a panel
  # that failed to construct left `dr_log` looking perfectly healthy — the
  # service and the bar widget had both said their piece — while the one thing
  # this test needs had silently not been built. `qmllint` cannot see it either;
  # it exits 0 on an unknown id and on a handler for a signal that does not
  # exist. So the raw log is dumped first, narrowed to lines that could name a
  # fault or one of our files.
  shell_log | grep -iE "error|warning|cannot|unable|is not a type|unexpected|mkelk|\\.qml" \
    | tail -30 >&2
  echo "--- [dock-recall] log ---" >&2
  dr_log | tail -30 >&2
  capture_service_log
}

cleanup() {
  local status=$?
  set +e
  # Whatever happened, the cache parent must be writable again — a 0500
  # ~/.cache/omarchy left behind would break every later test that touches a
  # cache, and it is this test's own doing.
  chmod 700 "$CACHE_PARENT" 2>/dev/null
  # And the fake dock goes, however this ended: a headless output left behind is
  # a different desk for every test after this one.
  monitor_present "$DOCK_OUTPUT" && hyprctl output remove "$DOCK_OUTPUT" >/dev/null 2>&1
  omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
  pkill -f "foot --title=$WIDE_TITLE" 2>/dev/null
  pkill -f "foot --title=$TALL_TITLE" 2>/dev/null
  # This test's seed and this test's pictures. The tests after it in the same
  # boot start from no recordings at all, and a watched identity for a window
  # that no longer exists would leak into them.
  rm -f "$STATE" 2>/dev/null
  rm -rf "$CACHE_DIR" 2>/dev/null
  set -e
  return $status
}
trap cleanup EXIT

# --------------------------------------------------------- 0. prerequisites

ensure_pkg jq jq       || fail "jq available in the guest (captures)"
ensure_pkg foot foot   || fail "foot available in the guest (captures)"
ensure_pkg node nodejs || fail "node available in the guest (captures)"

# The cache path Panel.qml will use has to be the one this test watches. If the
# guest ever grows an XDG_CACHE_HOME, every file assertion below would be
# looking somewhere the plugin is not writing — and it would look exactly like a
# capture pipeline that stores nothing.
[[ -z ${XDG_CACHE_HOME:-} ]] ||
  fail "the guest uses the default cache home (captures)" \
    "XDG_CACHE_HOME is set to '$XDG_CACHE_HOME'; this test watches $CACHE_DIR"
pass "guest prerequisites present (jq, foot, node), cache home is the default — captures"

# ------------------------------------------------------- 1. install the plugin

mkdir -p "$PLUGIN_DIR" "$STATE_DIR"
rsync -a --delete --exclude='.git/' "$PLUGIN_SRC/" "$PLUGIN_DIR/" ||
  fail "plugin installed (captures)" "rsync into $PLUGIN_DIR failed"

# Start from no recordings and no pictures at all, so only this test's own
# Record can explain anything that appears.
rm -f "$STATE"
rm -rf "$CACHE_DIR"

omarchy-shell shell rescanPlugins >/dev/null 2>&1
wait_until "plugin registry knows $PLUGIN_ID (captures)" 30 plugin_known

enable_result=$(omarchy-shell shell enablePlugin "$PLUGIN_ID" '{}' 2>&1)
[[ $enable_result == "ok" ]] ||
  fail "plugin enabled (captures)" "omarchy-shell shell enablePlugin answered '$enable_result'"

# The panel hot-reloads, but this plugin is a SERVICE too and a hot-reloaded
# service runs QML while its Process and FileView never fire. Restarting is also
# what guarantees the panel loader looks at the tree just installed.
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after restart (captures)" 60 pgrep -f 'quickshell -n -p'
wait_until "dock-recall service reported ready (captures)" 60 service_ready
pass "plugin installed, enabled, and its service is live (captures)"

# ------------------------------------------------------------ 2. run the apps

pkill -f "foot --title=$WIDE_TITLE" 2>/dev/null
pkill -f "foot --title=$TALL_TITLE" 2>/dev/null
launch_app "foot --title=$WIDE_TITLE"
launch_app "foot --title=$TALL_TITLE"
wait_until "the wide app's window appeared (captures)" 30 window_here "$WIDE_TITLE"
wait_until "the tall app's window appeared (captures)" 30 window_here "$TALL_TITLE"
pass "two windows on the desk, both to be watched and both to be photographed"

# --------------------------------- 2b. TWO DELIBERATELY DIFFERENT SHAPES (3xi)
#
# Both windows are class `foot` from the same binary, so their PIXELS cannot tell
# them apart — and a test that only checks the file name, the JPEG header and a
# width cap passes just as happily on a store that photographed the other window,
# the panel's own 1x1 host surface scaled up, or the whole output.
#
# Their SHAPES can tell them apart. Floated at wildly different aspect ratios —
# one wide, one tall — each stored JPEG's own proportions become evidence about
# which window was in front of the camera. `captureWidth` scales the picture
# down but scales it PROPORTIONALLY (targetHeight is height * targetWidth /
# width), so the ratio survives the resize; only the absolute pixels do not,
# which is why nothing below compares those.
#
# THE PROOF IS DOUBLED SINCE v7 (epic wau). Both apps are photographed now, so
# there are two files and the question can be asked BOTH WAYS ROUND: the wide
# app's picture has to be wide and not tall, and the tall app's has to be tall
# and not wide. A store that photographed one window twice, or that swapped the
# two, passes every name and format assertion in this file and fails here.
#
# The exact numbers do not matter and are not asserted. What is asserted, below,
# is that the two ended up different enough for the question to be answerable —
# a run where the resize did not take is a run where this proves nothing, and it
# says so rather than passing.
#
# DISPATCH FORM (tick z65) — MEASURED, in the nested sandbox, both ways.
#
# The three plain dispatchers this used to send — setfloating /
# resizewindowpixel / movewindowpixel — do nothing at all on an Omarchy Quattro
# guest, and the reason is sharper than "unknown dispatcher". The config is Lua,
# so `hyprctl dispatch <anything>` is handed to the LUA parser as
# `hl.dispatch(<anything>)`, and the legacy argument syntax is not Lua. All
# three come back with a PARSE error:
#
#   setfloating address:0x… ->
#     error: [string "return hl.dispatch(setfloating address:0x..."]:1:
#            ')' expected near 'address'
#      → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax
#              might need to be updated.
#
# and the window is untouched — measured on a tiled foot: 1406x840 before,
# 1406x840 after all three. `hyprctl` exits 0 anyway, and this function threw
# the message away with `>/dev/null 2>&1`, so the VM's identical 621x368 tiled
# sizes were the only symptom that ever reached the log. Hence rule 1 of this
# tick: nothing here swallows an answer any more.
#
# The working spelling is the one engine.js's own restore executor uses and
# live-verified against the real session (ticks 8t4/y29), and the one every
# other script in this directory reaches for (dock-recall-roundtrip-test.sh,
# undock-locked.sh): `hl.dsp.window.float` / `.resize` / `.move`, each naming
# its subject with `window = "address:0x…"`. Verified end to end in the nested
# sandbox before this was written — two tiled 700x840 foot windows came out
# 900x340 at 20,20 and 340x700 at 20,400, every dispatch answering `ok`, aspect
# 2.647 vs 0.486, 81.7% apart against a 40% floor. Both landed on the window
# they NAMED, which is the selector trap in .tick/learnings.md: an unrecognised
# selector key acts silently on the ACTIVE window, so "one window carries the
# other's numbers" is a real failure mode and the check below would catch it.
#
# Two things from that evidence matter here:
#   - `hl.dsp.window.float`'s `action` is IGNORED by this Hyprland — every
#     spelling toggles — so the current `.floating` is read first and the
#     dispatch is sent only when it disagrees with "floating", exactly as
#     Service.qml's executeFloating does. Sending it unconditionally would
#     un-float a window a previous run of this test left floating.
#   - RESIZE MUST COME BEFORE MOVE. A resize keeps the window's CENTRE fixed,
#     so it also changes `at`; resizing after positioning drags the window off
#     the very (x, y) just asked for.
shape_window() {
  local label="$1" address="$2" width="$3" height="$4" x="$5" y="$6"
  [[ -n $address ]] || return 1

  # `// false` and not `// empty`: jq's `//` treats a literal `false` as absent,
  # so `.floating // empty` collapses "tiled" and "no such window" into the same
  # empty string. Both still want the toggle, so it worked — but only by
  # accident, and the next reader of this line deserves better than that.
  local floating answer
  floating=$(clients | jq -r --arg a "$address" 'first(.[]|select(.address==$a)|.floating)//false')
  if [[ $floating != "true" ]]; then
    answer=$(hyprctl dispatch "hl.dsp.window.float({ window = \"address:$address\", action = \"toggle\" })")
    [[ $answer == "ok" ]] ||
      fail "$label floated (captures)" "hl.dsp.window.float answered '$answer' for $address"
  fi

  answer=$(hyprctl dispatch "hl.dsp.window.resize({ window = \"address:$address\", x = $width, y = $height })")
  [[ $answer == "ok" ]] ||
    fail "$label resized (captures)" "hl.dsp.window.resize answered '$answer' for $address"

  answer=$(hyprctl dispatch "hl.dsp.window.move({ window = \"address:$address\", x = $x, y = $y })")
  [[ $answer == "ok" ]] ||
    fail "$label moved (captures)" "hl.dsp.window.move answered '$answer' for $address"
}
window_size() {
  clients | jq -r --arg t "$1" 'first(.[]|select(.initialTitle==$t)|"\(.size[0])x\(.size[1])")//empty'
}

shape_window "the wide window" "$(window_address "$WIDE_TITLE")" 900 340 20 20
shape_window "the tall window" "$(window_address "$TALL_TITLE")" 340 700 20 400

# Poll for two agreeing reads rather than `sleep 2` — the house rule everywhere
# else in this suite, and `sleep 0.3` inside a deadline loop is the poll, not a
# sleep-then-assert. Each `hyprctl dispatch` above is a synchronous round trip
# that commits before the next is parsed (engine.js geometry-actuator notes,
# tick y29), and in the sandbox the new sizes were already readable on the first
# sample — so this waits for `hyprctl clients` to be QUIET, not for the resize.
#
# It deliberately decides nothing. If the dispatches were accepted and then
# silently undone — the "tiler simply re-took the window" case this whole
# section exists to catch — the sizes go quiet too, just at the wrong values,
# and the distinguishable-shapes check right below is what calls that. Two
# consecutive agreeing reads at the TILED size is a settled answer and still a
# failure, which is exactly the outcome the VM run produced.
shape_settle_deadline=$((SECONDS + 10))
prev_wide_size="" prev_tall_size=""
while (( SECONDS < shape_settle_deadline )); do
  cur_wide_size=$(window_size "$WIDE_TITLE")
  cur_tall_size=$(window_size "$TALL_TITLE")
  [[ -n $cur_wide_size && -n $cur_tall_size \
     && $cur_wide_size == "$prev_wide_size" \
     && $cur_tall_size == "$prev_tall_size" ]] && break
  prev_wide_size="$cur_wide_size" prev_tall_size="$cur_tall_size"
  sleep 0.3
done

WIDE_SIZE=$(window_size "$WIDE_TITLE")
TALL_SIZE=$(window_size "$TALL_TITLE")
[[ -n $WIDE_SIZE && -n $TALL_SIZE ]] ||
  fail "both test windows report a size (captures)" \
    "wide '$WIDE_SIZE', tall '$TALL_SIZE'"

# The two shapes have to be far enough apart that a picture of the wrong one
# could not be mistaken for a picture of the right one. 40% is a floor, not a
# target: the shapes asked for above differ by a factor of five.
shapes_differ=$(node -e '
  function ratio(s) { var p = String(s).split("x"); return Number(p[0]) / Number(p[1]); }
  var mine = ratio(process.argv[1]), theirs = ratio(process.argv[2]);
  if (!isFinite(mine) || !isFinite(theirs) || mine <= 0 || theirs <= 0) process.exit(2);
  process.stdout.write(mine.toFixed(3) + " vs " + theirs.toFixed(3));
  process.exit(Math.abs(mine - theirs) / Math.max(mine, theirs) >= 0.4 ? 0 : 1);
' "$WIDE_SIZE" "$TALL_SIZE") ||
  fail "the two test windows have distinguishable shapes (captures)" \
    "wide $WIDE_SIZE, tall $TALL_SIZE (aspect $shapes_differ) — the resize did not take, so no assertion below could tell a picture of one from a picture of the other"
pass "the two windows are shaped differently on purpose: wide $WIDE_SIZE, tall $TALL_SIZE (aspect $shapes_differ)"

# ------------------------------------------------------- 3. seed the identities
#
# BOTH WATCHED, and nothing else said about either of them. There is no
# `pictured` field to grant (v7 removed it) and no `pictureConsent` to preset (v7
# removed that too) — a watched app IS pictured, and the seed says so by carrying
# neither key. That absence is load-bearing: a seed that still named them would
# be silently dropped by normalizeIdentity and this test would be asserting
# against a file it did not write.
#
# The version is read out of StateModel rather than typed, for the reason every
# seed in this directory reads it: a seed declaring an older version is read as a
# MIGRATION, and neither v4's nor v7's migration is purely additive, so a stale
# number would quietly change what this test believes it seeded.
#
# `titlePatterns` is what separates the two: both windows are class `foot`, and
# the engine ANDs the two axes, so the title is the only thing that tells one
# window from the other.

SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel (captures)" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

cat > "$STATE.seed" <<JSON
{
  "version": $SCHEMA_VERSION,
  "paused": false,
  "identities": [
    {
      "id": "$WIDE_IDENTITY",
      "patterns": ["^$APP_CLASS\$"],
      "titlePatterns": ["^$WIDE_TITLE\$"],
      "launch": "foot --title=$WIDE_TITLE"
    },
    {
      "id": "$TALL_IDENTITY",
      "patterns": ["^$APP_CLASS\$"],
      "titlePatterns": ["^$TALL_TITLE\$"],
      "launch": "foot --title=$TALL_TITLE"
    }
  ],
  "layouts": {}
}
JSON
mv -f "$STATE.seed" "$STATE"

state_loaded() { dr_log | grep -qF "state loaded: $1 identities, $2 layouts"; }
if ! poll 30 state_loaded 2 0; then
  diagnostics
  fail "the service read back the seeded identities (captures)" \
    "no 'state loaded: 2 identities, 0 layouts' after the seed"
fi
# The seed named neither retired key; the file the reader hands back must not
# have grown one, because every "no prompt, ever" assertion below is about what
# the state file does NOT say.
# has(), NOT `// empty`: jq's `//` treats a literal `false` as absent, so a
# `"pictured": false` — the exact value the retired field defaulted to — would
# count as nothing and this guard would pass on a file that still carried it.
# The same trap `shape_window` documents above, in the other direction.
seeded_keys=$(jq -r '([select(has("pictureConsent"))]|length)
  + ([.identities[]|select(has("pictured"))]|length)' "$STATE")
[[ $seeded_keys == "0" ]] ||
  fail "the seed carries no retired consent key (captures)" \
    "the state file still names pictureConsent or a per-identity pictured"
pass "seeded: $WIDE_IDENTITY and $TALL_IDENTITY watched, both to be photographed, no consent key anywhere"

# ------------------------------------------------------- 4. summon the panel
#
# Recording is a PANEL action — that is the whole reason captures are possible
# at all, because the panel is on screen and QML is alive at the moment the user
# says "this arrangement matters".

omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "panel layer '$PANEL_NAMESPACE' appeared (captures)" "the panel never mapped a layer surface"
fi

# The panel refuses to record until it has both the state file and a live read
# of the desk, so wait for a payload that has chips in it rather than sleeping.
# THE SWITCH IS A TOP-LEVEL FACT, not a per-chip one: there is no `.pictured` on
# a chip any more, so "the panel has read the desk" is chips plus the one boolean
# it always states.
panel_ready() {
  panel_state_json | jq -e '(.chips|type) == "array" and (.chips|length) > 0
    and (.pictures == true)' >/dev/null
}
if ! poll 60 panel_ready; then
  diagnostics
  fail "the panel has read the desk and reports the switch (captures)" \
    "no payload with chips and pictures == true"
fi
screenshot "success-dock-recall-captures-01-open"
pass "panel summoned, reading the desk, and reporting pictures on"

# ------------------------------------------------------------ 5. RECORD

record_answer=$(omarchy-shell "$IPC_TARGET" record 2>&1)
if [[ $record_answer != "recorded" ]]; then
  diagnostics
  fail "panel IPC records a layout (captures)" "record answered '$record_answer'"
fi

# THIS READ IS DELIBERATELY NOT A POLL (tick m4s). "recorded" is a promise that
# the bytes are on disk, and the promise is what is under test here: the panel's
# state FileView declares blockWrites, so writeState cannot answer true with a
# write still in flight. Polling would turn a broken promise into a slow one and
# hide the defect this assertion was written by — the panel answered "recorded",
# armed its Undo button, and left the previous file on disk, where the panel's
# own synchronous re-read (freshState) would have rewritten the recording away.
# If this line fails, the contract is broken; do not add a sleep to it.
#
# The pictures are a different matter: they are deliberately taken afterwards,
# off the recording's stack, and every wait on THEM below is a poll.
TOPOLOGY_KEY=$(jq -r 'first(.layouts|keys[])//empty' "$STATE" 2>/dev/null)
if [[ -z $TOPOLOGY_KEY ]]; then
  diagnostics
  fail "the record wrote a layout (captures)" \
    "no layout key in $STATE after record answered 'recorded' — the write did not block"
fi

recorded_apps=$(jq -r --arg k "$TOPOLOGY_KEY" '[.layouts[$k].apps[]|.identityId]|sort|join(",")' "$STATE")
if [[ $recorded_apps != "$EXPECTED_APPS" ]]; then
  diagnostics
  fail "both watched apps are in the recording (captures)" \
    "the layout names '$recorded_apps', expected '$EXPECTED_APPS'"
fi

# THE EXPECTED NAME, asked of the plugin's own naming function with the topology
# key the record actually wrote. The test does not re-implement the key — that
# would be two spellings of one rule — but it does insist the file on disk is
# the one that key names, which is the assertion that would catch a picture
# filed under the wrong window or the wrong desk.
WIDE_FILE=$(node -e '
  var panel = require(process.argv[1] + "/PanelModel.js");
  process.stdout.write(panel.captureFileName(process.argv[2], 0, process.argv[3]));
' "$PLUGIN_DIR" "$WIDE_IDENTITY" "$TOPOLOGY_KEY")
[[ -n $WIDE_FILE ]] || fail "the plugin can name a capture file (captures)"

TALL_FILE=$(node -e '
  var panel = require(process.argv[1] + "/PanelModel.js");
  process.stdout.write(panel.captureFileName(process.argv[2], 0, process.argv[3]));
' "$PLUGIN_DIR" "$TALL_IDENTITY" "$TOPOLOGY_KEY")

if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "Record stored a picture for both watched apps (captures)" \
    "after ${ROUND_S}s $CACHE_DIR holds $(cache_count) picture(s): $(cache_files | tr '\n' ' ')"
fi

# BY NAME AND NOT BY COUNT, both of them. A count of two is satisfied by two
# pictures of one window, and the two windows are the same binary — this is the
# assertion .tick/learnings.md's "a COUNT cannot distinguish" was written about.
want_both=$(printf '%s\n%s\n' "$WIDE_FILE" "$TALL_FILE" | sort)
stored=$(cache_files)
[[ $stored == "$want_both" ]] ||
  fail "each picture is keyed on its own identity, occurrence and topology (captures)" \
    "the cache holds '$(printf '%s' "$stored" | tr '\n' ' ')', expected '$(printf '%s' "$want_both" | tr '\n' ' ')'"

for f in "$WIDE_FILE" "$TALL_FILE"; do
  [[ -s "$CACHE_DIR/$f" ]] || fail "the picture is not empty (captures)" "$CACHE_DIR/$f is zero bytes"
done

WIDE_DIMENSIONS=$(jpeg_size "$CACHE_DIR/$WIDE_FILE") ||
  fail "the wide app's picture decodes as a JPEG (captures)" \
    "no start-of-frame marker in $CACHE_DIR/$WIDE_FILE ($(wc -c < "$CACHE_DIR/$WIDE_FILE") bytes)"
TALL_DIMENSIONS=$(jpeg_size "$CACHE_DIR/$TALL_FILE") ||
  fail "the tall app's picture decodes as a JPEG (captures)" \
    "no start-of-frame marker in $CACHE_DIR/$TALL_FILE ($(wc -c < "$CACHE_DIR/$TALL_FILE") bytes)"
for d in "$WIDE_DIMENSIONS" "$TALL_DIMENSIONS"; do
  w=${d%x*}
  ((w > 0 && w <= 512)) ||
    fail "the picture is stored at chip size (captures)" \
      "it is ${d}, and the store caps the width at 512"
done
pass "Record stored two pictures, $WIDE_FILE ($WIDE_DIMENSIONS) and $TALL_FILE ($TALL_DIMENSIONS) — both decodable JPEGs"

# AND EACH IS A PICTURE OF ITS OWN WINDOW (tick 3xi, doubled by epic wau).
#
# Everything above this line — the names, the SOF walks, the width caps, the
# non-emptiness — passes unchanged on a store that photographed one window twice
# under two names, or that swapped the two. The two test windows are the same
# binary so their content cannot tell them apart.
#
# Their proportions can, and now there are two pictures to ask about, so the
# question is asked BOTH WAYS ROUND: each stored JPEG's aspect has to be its own
# window's and NOT the other's. Compared with a tolerance rather than an equality
# on purpose: the compositor's captured size and the geometry hyprctl reports
# disagree about borders and scale (spike o2x, and it is why CaptureStore sizes
# from sourceSize), so the honest claim is "these proportions, not those".
aspect_of() {
  node -e '
    function ratio(s) { var p = String(s).split("x"); return Number(p[0]) / Number(p[1]); }
    var stored = ratio(process.argv[1]);
    var mine = ratio(process.argv[2]);
    var theirs = ratio(process.argv[3]);
    if (!isFinite(stored) || !isFinite(mine) || !isFinite(theirs)) process.exit(2);
    var dMine = Math.abs(stored - mine) / mine;
    var dTheirs = Math.abs(stored - theirs) / theirs;
    process.stdout.write("stored " + stored.toFixed(3)
      + ", own " + mine.toFixed(3) + " (off by " + (dMine * 100).toFixed(1) + "%)"
      + ", other " + theirs.toFixed(3) + " (off by " + (dTheirs * 100).toFixed(1) + "%)");
    process.exit((dMine <= 0.15 && dTheirs > 0.15) ? 0 : 1);
  ' "$1" "$2" "$3"
}

wide_verdict=$(aspect_of "$WIDE_DIMENSIONS" "$WIDE_SIZE" "$TALL_SIZE") || {
  diagnostics
  fail "the wide app's picture is OF the wide window, and not of the tall one" \
    "$wide_verdict — a picture whose proportions are not its own window's is a picture of something else"
}
tall_verdict=$(aspect_of "$TALL_DIMENSIONS" "$TALL_SIZE" "$WIDE_SIZE") || {
  diagnostics
  fail "the tall app's picture is OF the tall window, and not of the wide one" \
    "$tall_verdict — a picture whose proportions are not its own window's is a picture of something else"
}
pass "each picture's proportions are its own window's: wide [$wide_verdict], tall [$tall_verdict]"

# ------------------------------------------ 5a. NO PROMPT, EVER (epic wau)
#
# This step used to be the first-Record dialogue: a modal that showed the
# pictures it had just taken and offered three answers, one of which deleted
# them. It is gone, and the assertion that replaced it is the ABSENCE.
#
# WHY THE ABSENCE NEEDS A TEST. Nothing else fails when a prompt comes back. The
# increment that built it was ratified by this very file; what un-ratified it was
# the human using it once and being talked out of his own pictures. So the shape
# of the claim is: after the Record that stored the pictures — the exact event
# that opened the prompt — the payload has none of its keys, and the switch is on.
#
# ABSENT, NOT NULL, asserted with has(). tests/acceptance/README.md is normative
# about the difference: a key present and null means "the panel has nothing to
# say yet", a key that is not there means "this build has no such fact". A
# consent key coming back as null would be a half-reverted prompt, and
# `.consentOpen == false` would pass on it.

CAPTURE_URL="file://$CACHE_DIR/$WIDE_FILE"
TALL_CAPTURE_URL="file://$CACHE_DIR/$TALL_FILE"

no_prompt() {
  panel_state_json | jq -e '
    (has("consentOpen")|not)
    and (has("consentChoices")|not)
    and (has("consentCaptures")|not)
    and (has("pictureConsent")|not)
    # And the one key that IS there, always, and is a boolean rather than a
    # string: the switch this generation replaced all four of them with.
    and has("pictures")
    and (.pictures|type) == "boolean"
    and .pictures == true' >/dev/null
}
if ! poll 20 no_prompt; then
  diagnostics
  fail "the Record that stored pictures asks nothing" \
    "the payload still carries a consent key, or does not state the pictures switch: $(panel_state_json | jq -c '{consentOpen, consentChoices, consentCaptures, pictureConsent, pictures}' 2>&1)"
fi

# Give the panel a moment a prompt could still open in, and require that none
# did. THE ONE DELIBERATE SLEEP IN THIS FILE, and it is a negative wait: there is
# no observable for "a prompt did not appear", and the old prompt arrived from
# the capture round's completion callback a few hundred ms behind the file
# landing on disk — so an assertion made the instant the picture appears would
# have passed on the build that still had one.
sleep 3
no_prompt || {
  diagnostics
  fail "no prompt appears after the pictures are stored" \
    "a consent key turned up in the payload $(panel_state_json | jq -c '{consentOpen, pictureConsent}' 2>&1)"
}

# AND THE STATE FILE SAYS THE SAME. The payload is what the panel reports; this
# is what it wrote, and it is the half that survives a restart (asserted at 10b).
file_keys=$(jq -r '([select(has("pictureConsent"))]|length)
  + ([.identities[]|select(has("pictured"))]|length)' "$STATE")
[[ $file_keys == "0" ]] || {
  diagnostics
  fail "no consent key is written to the state file" \
    "the state file grew a pictureConsent or a per-identity pictured after the record"
}
file_switch=$(jq -r '.pictures|tostring' "$STATE" 2>/dev/null)
[[ $file_switch == "true" ]] ||
  fail "the switch is on in the state file (captures)" "the state file says pictures '$file_switch'"
screenshot "success-dock-recall-captures-02-no-prompt"
pass "no prompt, ever: no consent key in the payload or the file, and pictures == true in both"

# The panel says so too: the recorded map reports a capture path for the chip
# that has one, and no such key for the chip that does not.
view_answer=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $view_answer == "recorded" ]] ||
  fail "the panel shows the recorded map (captures)" "setView recorded answered '$view_answer'"

# TWO KEYS, TWO CLAIMS, and they are deliberately not one. `capturePath` is the
# PANEL's answer — the cache holds a file for this identity, occurrence and
# topology. `captureSource` is what the CHIP is drawing: the delegate reports it
# only once its Image says Ready, so it is never a claim the map could not make
# good on. They agree by construction here, which is what makes a disagreement
# worth failing on.
#
# Both are ABSENT, never present-and-empty, for a chip that has no picture: the
# payload convention is that a key the panel has nothing to say about is not
# there at all, and "" would be a second spelling of the same silence. Here BOTH
# chips have one, so the absence half is asserted by requiring no EMPTY value —
# a chip carrying `capturePath: ""` would fail.
#
# The URLs are set at step 5a.
for path in "$CACHE_DIR/$WIDE_FILE" "$CACHE_DIR/$TALL_FILE"; do
  [[ $path =~ ^[A-Za-z0-9/._~-]+$ ]] ||
    fail "the capture path needs no percent-encoding (captures)" \
      "$path contains a character Util.fileUrl would escape"
done

capture_reported() {
  panel_state_json | jq -e \
    --arg wp "$CACHE_DIR/$WIDE_FILE" --arg wu "$CAPTURE_URL" \
    --arg tp "$CACHE_DIR/$TALL_FILE" --arg tu "$TALL_CAPTURE_URL" --arg want "$1" '
    # ONE CHIP EACH, NAMED. Two chips reporting a path is a count; two chips
    # reporting THESE two paths is the claim — a map that put each picture on
    # the other chip satisfies the count and fails this.
    ([.chips[]|select(has("capturePath") and .capturePath == $wp
       and has("captureSource") and .captureSource == $wu
       and .renderPath == $want)]|length) == 1
    and ([.chips[]|select(has("capturePath") and .capturePath == $tp
       and has("captureSource") and .captureSource == $tu
       and .renderPath == $want)]|length) == 1
    and ([.chips[]|select(has("capturePath"))]|length) == 2
    and ([.chips[]|select(has("captureSource"))]|length) == 2
    and ([.chips[]|select(has("capturePath") and (.capturePath|length) == 0)]|length) == 0
    and ([.chips[]|select(has("captureSource") and (.captureSource|length) == 0)]|length) == 0
    # No chip carries a per-app grant any more — the switch is top-level.
    and ([.chips[]|select(has("pictured"))]|length) == 0
    # Every chip still has its icon. A capture fills in UNDERNEATH the icon and
    # the name, and does not replace either.
    and ([.chips[]|select((.iconSource|type) == "string" and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll 30 capture_reported positioned; then
  diagnostics
  fail "the panel reports both stored pictures, each on its own chip" \
    "no POSITIONED pair of chips reports capturePath '$CACHE_DIR/$WIDE_FILE' and '$CACHE_DIR/$TALL_FILE' with the matching sources"
fi
pass "POSITIONED: the Recorded map draws both captures — path and source agree on each, and no chip carries a per-app grant"

# ------------------------------ 5b. THE FALLBACK PATH, with the same picture
#
# The Recorded map is the one that is routinely the STACKED FALLBACK — a v1
# recording, or any read that came back without geometry, drops a workspace to
# it, and Panel.qml's positioned branch never runs there. The project's own
# learnings record the fallback engaging silently and hiding a broken model for
# two live rounds, so a capture asserted only on the positioned path is a
# capture half-asserted.
#
# The layout is rewritten WITHOUT at/size, which is exactly what makes the
# workspace fall back — and the pictures stay valid, because the cache key is
# (identity, occurrence, topology) and carries no geometry at all. So this is
# the same file, on the other render path, with nothing re-recorded.
node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2], key = process.argv[3];
  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  var layout = StateModel.layoutFor(state, key);
  if (!layout) { console.error("no layout for " + key); process.exit(1); }
  var stripped = {
    topologyKey: layout.topologyKey,
    recordedAt: layout.recordedAt,
    apps: layout.apps.map(function (app) {
      return { identityId: app.identityId, occurrence: app.occurrence,
               monitorDescription: app.monitorDescription, workspaceId: app.workspaceId,
               floating: app.floating, group: app.group };
    })
  };
  fs.writeFileSync(statePath + ".tmp", StateModel.serializeState(StateModel.upsertLayout(state, stripped)));
  fs.renameSync(statePath + ".tmp", statePath);
' "$PLUGIN_DIR" "$STATE" "$TOPOLOGY_KEY" ||
  fail "the layout can be rewritten without geometry (captures)"

fallback_capture() {
  panel_state_json | jq -e --arg wu "$CAPTURE_URL" --arg tu "$TALL_CAPTURE_URL" '
    (.chips|length) > 0
    and ([.chips[]|select(.renderPath == "fallback")]|length) == (.chips|length)
    and ([.chips[]|select(has("captureSource") and .captureSource == $wu)]|length) == 1
    and ([.chips[]|select(has("captureSource") and .captureSource == $tu)]|length) == 1
    # AND THE NAME SURVIVES IT. The stacked rows are 17 px tall and this is
    # where names came back after a size ladder silently took every one of them
    # away; a capture that cost them their label would undo that just as
    # quietly. The tiers that draw a name are pill and strip, and this asks for
    # the OUTCOME rather than for a tier by name.
    and ([.chips[]|select(has("captureSource")
          and (.treatment == "pill" or .treatment == "strip"))]|length) == 2
    and ([.chips[]|select((.name|type) == "string" and (.name|length) > 0)]|length) == (.chips|length)
    and ([.chips[]|select((.iconSource|type) == "string" and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll 40 fallback_capture; then
  diagnostics
  fail "the FALLBACK path draws the same captures, and still draws the names" \
    "after stripping the layout's geometry, no pair of fallback chips reports captureSource '$CAPTURE_URL' and '$TALL_CAPTURE_URL' at a tier that carries a name"
fi
pass "FALLBACK: the same two pictures on the stacked path, on chips that still report their names and icons"

# ------------------ 5c. captures deleted under the panel fall back
#
# The FILES, not the whole directory (that is step 8), and the assertion is made
# after the panel is summoned AGAIN — which is deliberate and is the honest
# shape of this behaviour rather than a convenience.
#
# Within one panel session a chip that has already decoded its picture goes on
# drawing it: Qt holds the decoded image, and a photograph the plugin
# legitimately took does not become wrong because the file behind it was
# removed. What must be true is that a panel opened AFTER the file went never
# offers it — and that is guaranteed structurally, because `captureSourceOf` is
# gated on a directory listing re-read on every open, so the Image is never
# even pointed at a file that is not there. No source, no path, no error, and
# the chip is what it was before this epic: its icon and its name.
#
# That is also the real user's case. The shell destroys the panel's Loader on
# hide, so "a cleaner ran while I was not looking" is always a fresh panel.
rm -f "$CACHE_DIR/$WIDE_FILE" "$CACHE_DIR/$TALL_FILE"
omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
poll 20 panel_layer_absent
omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "the panel comes back after a capture was deleted (captures)" "no panel layer"
fi
deleted_view=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $deleted_view == "recorded" ]] ||
  fail "the recorded map opens after a capture was deleted (captures)" "setView recorded answered '$deleted_view'"

capture_gone() {
  panel_state_json | jq -e '
    (.chips|length) > 0
    and ([.chips[]|select(has("captureSource"))]|length) == 0
    and ([.chips[]|select(has("capturePath"))]|length) == 0
    and ([.chips[]|select((.iconSource|type) == "string" and (.iconSource|length) > 0)]|length) == (.chips|length)
    and ([.chips[]|select((.name|type) == "string" and (.name|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll 40 capture_gone; then
  diagnostics
  fail "a capture deleted under the panel falls back to the icon" \
    "a chip still reports a capture for a file that is no longer there, or lost its icon or its name"
fi
pass "a capture deleted from the cache: the chip is back to its icon and its name, offered no picture, nothing errored"

# Put the geometry and the picture back for the steps that follow.
restore_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $restore_record == "recorded" ]] ||
  fail "panel IPC records after the fallback round (captures)" "record answered '$restore_record'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "the pictures are back after the fallback round (captures)" "$CACHE_DIR holds $(cache_count)"
fi

# ------------------------------------------------- 6. RE-RECORD overwrites

# THE MTIME, not the bytes. The claim being tested is "the file was written
# again", and a terminal showing a prompt really can produce two byte-identical
# JPEGs — the pixels did not change, so the encoder's output does not either.
# Asserting on content would make a correct pipeline fail on an idle window.
# Nanosecond mtime cannot: the store deletes the topology's pictures and writes
# new ones, so a re-record that happened is a new file every time.
before_mtime=$(stat -c %y "$CACHE_DIR/$WIDE_FILE")

rerecord_answer=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $rerecord_answer == "recorded" ]] ||
  fail "panel IPC re-records (captures)" "record answered '$rerecord_answer'"

# Still exactly two files, still under the same keys — a re-record REPLACES a
# topology's pictures rather than accumulating them.
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "a re-record replaces the pictures rather than adding to them (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi
[[ $(cache_files) == "$want_both" ]] ||
  fail "the re-recorded pictures keep their keys (captures)" "the cache holds '$(cache_files | tr '\n' ' ')'"

# And it is a NEW picture. Polled, because the write is asynchronous; the point
# is that the file is rewritten at all, which is what a pipeline that had
# quietly stopped writing would fail.
changed() { [[ $(stat -c %y "$CACHE_DIR/$WIDE_FILE" 2>/dev/null) != "$before_mtime" ]]; }
if ! poll "$ROUND_S" changed; then
  diagnostics
  fail "a re-record rewrites the picture (captures)" \
    "$WIDE_FILE was not written again by the second Record (mtime still $before_mtime)"
fi
pass "a re-record replaces the picture in place: one file, same key, written again"

# ------------------------------------------------------------- 7. UNDO

undo_answer=$(omarchy-shell "$IPC_TARGET" undoRecord 2>&1)
[[ $undo_answer == "undone" ]] ||
  fail "panel IPC undoes a record (captures)" "undoRecord answered '$undo_answer'"

# The undo of a re-record puts the PREVIOUS layout back, and the pictures follow
# the recording out. They cannot come back: the re-record overwrote them in
# place and nothing kept the pixels, so the restored recording falls back to
# icons. That is the honest behaviour of a one-shot undo over an
# overwrite-in-place cache, and it is asserted rather than left to be
# discovered.
if ! poll 30 cache_is 0; then
  diagnostics
  fail "undo takes the pictures with it (captures)" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi
undone_layout=$(jq -r --arg k "$TOPOLOGY_KEY" '(.layouts[$k].apps|length)//0' "$STATE")
((undone_layout > 0)) ||
  fail "undo put the previous layout back (captures)" \
    "the state file has no layout for '$TOPOLOGY_KEY' after undoRecord"
pass "undo restores the previous layout and drops its pictures — the map falls back to icons"

# ------------------------------------- 8. a WIPED CACHE degrades to icons

record_again=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $record_again == "recorded" ]] || fail "panel IPC records again (captures)" "record answered '$record_again'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "recording again stores the pictures again (captures)" "$CACHE_DIR holds $(cache_count)"
fi

# Delete the whole thing under a live panel — a cleaner is allowed to, and the
# correct behaviour is that the map goes back to icons with nothing erroring.
rm -rf "$CACHE_DIR"
icons_only() {
  panel_state_json | jq -e '
    ([.chips[]|select(has("capturePath"))]|length) == 0
    and (.chips|length) > 0
    and ([.chips[]|select((.iconSource|type) == "string" and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
# The panel re-reads the directory when it opens and when the desk changes, so
# it is re-summoned here rather than waited on: this is the "the user comes back
# tomorrow and a cleaner has run" case, not a live-invalidation one.
omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
poll 20 panel_layer_absent
omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "the panel comes back after the cache was wiped (captures)" "no panel layer"
fi
setview_again=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $setview_again == "recorded" ]] ||
  fail "the recorded map still opens with no pictures (captures)" "setView recorded answered '$setview_again'"
if ! poll 30 icons_only; then
  diagnostics
  fail "a wiped cache leaves the map drawing icons (captures)" \
    "a chip still reports a capturePath, or one has no iconSource"
fi
pass "the whole cache deleted: every chip reports an icon source, none reports a capture path, nothing errored"

# ------------- 8b. THE LIVE MAP DRAWS THE WINDOWS AS THEY ARE NOW (tick 2zi)
#
# AND WRITES NOTHING. This step is placed exactly here on purpose: the cache
# directory has just been deleted, and step 9 below refuses to run unless it is
# still gone. So the strongest assertion this feature has — that a live picture
# never reaches a disk — is made against the state of the filesystem between two
# steps that both depend on it, rather than by a count, which a directory that
# had been created and then emptied would satisfy.
#
# The Live map draws a photograph of every watched window, taken when the panel
# opened and held in memory. BOTH apps get one now (schema v7): there is no
# per-app grant left to withhold, and the control that stops this is the one
# switch, driven in the second half of this step.
live_view=$(omarchy-shell "$IPC_TARGET" setView live 2>&1)
[[ $live_view == "live" ]] ||
  fail "the live map opens for the live pictures (captures)" "setView live answered '$live_view'"

# TWO CLAIMS, as on the recorded map: `liveCapture` is what the PANEL says (a
# picture of this window is in memory) and `liveSource` is what the CHIP says
# (the url its Image bound and DREW). And the two source keys are mutually
# exclusive — the recorded map draws out of the cache, the live map out of
# memory, and a chip reporting both would mean a gate had gone.
live_pictures_drawn() {
  panel_state_json | jq -e --arg w "$WIDE_TITLE" --arg t "$TALL_TITLE" '
    (.showRecorded == false)
    and (.pictures == true)
    # BY NAME, both of them. `[.chips[]|select(.liveCapture)]|length == 2` is a
    # count and cannot tell two pictures of one window from one of each; the
    # chips are keyed by window address, so the titles are looked up through the
    # windows the harness launched.
    and ([.chips[]|select(.liveCapture == true
       and (.liveSource|type) == "string" and (.liveSource|length) > 0)]|length) == 2
    and ([.chips[]|select(has("liveSource") and has("captureSource"))]|length) == 0
    and ([.chips[]|select(has("capturePath"))]|length) == 0
    and ([.chips[]|select((.iconSource|type) == "string"
       and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll "$ROUND_S" live_pictures_drawn; then
  diagnostics
  fail "the Live map draws a live picture for every watched window" \
    "$(panel_state_json | jq -c '[.chips[]|{name, liveCapture, liveSource, iconSource}]' 2>&1)"
fi

# EACH ON ITS OWN CHIP, named through the window each app owns — the same
# discipline the recorded half uses, because a count of two is satisfied by two
# pictures of one window.
live_one_each() {
  local wide tall
  wide=$(window_address "$WIDE_TITLE")
  tall=$(window_address "$TALL_TITLE")
  [[ -n $wide && -n $tall ]] || return 1
  panel_state_json | jq -e --arg w "$wide" --arg t "$tall" '
    ([.chips[]|select(.key == $w and .liveCapture == true
       and (.liveSource|length) > 0)]|length) == 1
    and ([.chips[]|select(.key == $t and .liveCapture == true
       and (.liveSource|length) > 0)]|length) == 1
    and ((first(.chips[]|select(.key == $w)|.liveSource))
         != (first(.chips[]|select(.key == $t)|.liveSource)))' >/dev/null
}
if ! poll 30 live_one_each; then
  diagnostics
  fail "each window has its OWN live picture" \
    "$(panel_state_json | jq -c '[.chips[]|{key, liveCapture, liveSource}]' 2>&1)"
fi

# NOTHING WAS WRITTEN. Not "the cache holds no new file" — the directory itself
# must not have been created, which is the state the plugin ships in and the
# state step 9 needs to find.
[[ ! -e $CACHE_DIR ]] ||
  fail "a live picture reached the disk" \
    "$CACHE_DIR exists after the Live map drew its pictures — live pictures are memory only"
# The shot waits for the MORPH to land (tick omw). `setView live` above flies
# every chip from its recorded place to its live one over Motion.sweepDuration,
# and a flying chip draws an icon on the selected fill with a full-strength
# accent edge — never a picture. A screenshot inside the sweep therefore shows
# icons sitting exactly over chips whose own report, underneath the overlay,
# says a picture is drawn: that was ep6's first look, and it was the overlay,
# not a chip state. The assertions above read the payload and are unaffected;
# this only makes the picture show what the payload says. A timeout is not a
# failure — the picture is for eyes, not for the gate.
morph_landed() {
  panel_state_json | jq -e '([.chips[]|select(.morphFlying == true)]|length) == 0' >/dev/null
}
poll 10 morph_landed || true
screenshot "success-dock-recall-captures-04-live-pictures"
pass "the Live map drew both windows from memory, one picture each: nothing was written"

# A CHIP IS NEVER BLANK — every chip reports an icon source in the same payload
# that reports the pictures, above. The icon is what a chip draws while a grab is
# in flight and what it goes back to when one fails, through exactly the
# mechanism the recorded map already used.
#
# ---------------- THE SWITCH, WITHOUT A PANEL REOPEN (epic wau)
#
# The whole affordance, driven end to end in the panel that is on screen. OFF
# has to do three things at once and every one of them is asserted: the live
# pictures stop (the gate is read at draw time, so there is nothing asynchronous
# to wait for), every STORED picture is deleted on disk, and the switch itself
# is reported and written. There are stored pictures to delete because a Record
# is done first — this step is otherwise sitting on a deleted cache.
switch_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $switch_record == "recorded" ]] ||
  fail "panel IPC records before the switch is thrown (captures)" "record answered '$switch_record'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "there are stored pictures for the switch to delete (captures)" \
    "$CACHE_DIR holds $(cache_count)"
fi

pictures_off=$(omarchy-shell "$IPC_TARGET" setPictures off 2>&1)
[[ $pictures_off == "off" ]] ||
  fail "the pictures can be switched off (captures)" "setPictures off answered '$pictures_off'"

live_pictures_gone() {
  panel_state_json | jq -e '
    .pictures == false
    and ([.chips[]|select(.liveCapture == true)]|length) == 0
    and ([.chips[]|select(has("liveSource"))]|length) == 0
    and ([.chips[]|select(has("captureSource"))]|length) == 0
    and ([.chips[]|select(has("capturePath"))]|length) == 0
    and ([.chips[]|select((.iconSource|type) == "string"
       and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll 30 live_pictures_gone; then
  diagnostics
  fail "switching the pictures off stops them without a panel reopen" \
    "$(panel_state_json | jq -c '{pictures, chips: [.chips[]|select(.liveCapture == true)|{key, liveSource}]}' 2>&1)"
fi

# ON DISK, asserted on the filesystem and not on a payload: the stored pictures
# are deleted, every one of them, and this is the claim the menu entry's tooltip
# makes before the press.
if ! poll 30 cache_is 0; then
  diagnostics
  fail "switching the pictures off deletes every stored one" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi
off_on_disk=$(jq -r '.pictures|tostring' "$STATE" 2>/dev/null)
[[ $off_on_disk == "false" ]] ||
  fail "the switch is written to the state file (captures)" "the state file says pictures '$off_on_disk'"
pass "pictures off: the live ones stopped in the open panel, every stored one deleted, and the file says so"

# AND BACK ON, in the same panel. The recorded half needs nothing but the next
# Record; the LIVE half needs the round RE-RUN, because a live round is once per
# panel session — so this is the assertion that the switch drops that latch
# rather than leaving the user to close and reopen the panel.
#
# THE PAYLOAD ALONE CANNOT TELL A NEW ROUND FROM THE OLD PIXELS DRAWN AGAIN, and
# that is why the bracket is counted here. `live_pictures_gone` above is
# satisfied by the DRAW-TIME gate on its own — `liveSourceOf` returns "" while
# the switch is off whatever is still in memory — so a build that switched off
# without calling `clear()` AND switched on without dropping the latch passes
# both halves: the old URLs simply start drawing again. Each mutation alone is
# caught; the PAIR is not, and a pair is what a single missing `if` produces.
#
# LiveCaptureStore opens every round with a line naming what it is about to do
# (the bracket rule, tick 070) — the same line 10b waits on — so a round that
# genuinely ran is a round that COUNTED, and that is a fact no draw-time gate
# can fake.
rounds_before_on=$(dr_log | grep -c "live picture round:")
pictures_on=$(omarchy-shell "$IPC_TARGET" setPictures on 2>&1)
[[ $pictures_on == "on" ]] ||
  fail "the pictures can be switched back on (captures)" "setPictures on answered '$pictures_on'"
on_on_disk=$(jq -r '.pictures|tostring' "$STATE" 2>/dev/null)
[[ $on_on_disk == "true" ]] ||
  fail "the switch going back on is written to the state file (captures)" \
    "the state file says pictures '$on_on_disk'"

# NO REOPEN — this poll is the whole point of the assertion, so nothing here
# hides or summons the panel. BOTH halves: a NEW round opened (the count grew)
# and it produced pictures the panel is drawing.
live_round_is_new() {
  [[ $(dr_log | grep -c "live picture round:") -gt $rounds_before_on ]] && live_pictures_drawn
}
if ! poll "$ROUND_S" live_round_is_new; then
  diagnostics
  fail "switching the pictures back on runs a NEW live round without a panel reopen" \
    "rounds logged before the switch: $rounds_before_on, now $(dr_log | grep -c "live picture round:") — $(panel_state_json | jq -c '{pictures, chips: [.chips[]|{key, liveCapture, liveSource}]}' 2>&1)"
fi
pass "pictures on again: a NEW live round opened and drew, in the panel that was already open"

# AND THE NEXT RECORD STORES AGAIN. The recorded half of "on resumes", and the
# one the tooltip promises.
resumed_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $resumed_record == "recorded" ]] ||
  fail "panel IPC records after the pictures came back (captures)" "record answered '$resumed_record'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "the Record after the switch went back on stores again" \
    "$CACHE_DIR holds $(cache_count)"
fi
[[ $(cache_files) == "$want_both" ]] ||
  fail "the resumed Record stores the same two keys (captures)" \
    "the cache holds '$(cache_files | tr '\n' ' ')'"
pass "the next Record stored both pictures again — the switch resumes what it stopped"

# Step 9 needs the cache directory GONE, and this step has just filled it.
back_to_recorded=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $back_to_recorded == "recorded" ]] ||
  fail "the recorded map comes back after the live round (captures)" \
    "setView recorded answered '$back_to_recorded'"
rm -rf "$CACHE_DIR"

# --------------------------- 9. a failed capture cannot fail a record

# Make the cache uncreatable. The store's own mkdir is what fails, which is a
# failure of the capture path and of nothing else — the state write happened
# long before it and does not touch this directory.
mkdir -p "$CACHE_PARENT"
chmod 500 "$CACHE_PARENT" ||
  fail "the cache parent can be made read-only (captures)" "chmod 500 $CACHE_PARENT failed"
[[ ! -d $CACHE_DIR ]] ||
  fail "the cache directory is gone before the unwritable record (captures)" "$CACHE_DIR still exists"

blocked_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
if [[ $blocked_record != "recorded" ]]; then
  chmod 700 "$CACHE_PARENT"
  diagnostics
  fail "a record whose pictures cannot be stored still succeeds" \
    "record answered '$blocked_record' with an unwritable cache — a screenshot failed a record"
fi

# The state file is written and COMPLETE: the layout is there, it names both
# watched apps, and it carries a timestamp. Every one of those is the record
# doing its whole job while the capture path was failing.
blocked_apps=$(jq -r --arg k "$TOPOLOGY_KEY" '[.layouts[$k].apps[]|.identityId]|sort|join(",")' "$STATE" 2>/dev/null)
blocked_stamp=$(jq -r --arg k "$TOPOLOGY_KEY" '.layouts[$k].recordedAt//empty' "$STATE" 2>/dev/null)
if [[ $blocked_apps != "$EXPECTED_APPS" || -z $blocked_stamp ]]; then
  chmod 700 "$CACHE_PARENT"
  diagnostics
  fail "the record is complete though no picture could be stored" \
    "the layout names '$blocked_apps' and its recordedAt is '$blocked_stamp'"
fi
if [[ -d $CACHE_DIR ]]; then
  chmod 700 "$CACHE_PARENT"
  fail "no picture was stored when the cache could not be created" "$CACHE_DIR exists after all"
fi
chmod 700 "$CACHE_PARENT"
pass "a record whose pictures cannot be stored is still a complete record — layout written, stamped, no picture"

# ------------------ 9b. a failed round must not disable every Record after it

# THE REAL PROPERTY (tick gox). The mkdir failure above filled the store's
# queue before it aborted; if the teardown after that abort left the queue
# non-empty, the guard in the store's capture() reads it as "a round is
# already running" and every Record from here on refuses silently, having
# stored nothing, for the rest of the panel's life. The cache parent is
# writable again (restored just above) — this Record's cache is fine, so if
# it still stores nothing, the previous round's failure is what latched it.
recovered_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $recovered_record == "recorded" ]] ||
  fail "panel IPC records again once the cache is writable (captures)" "record answered '$recovered_record'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "a failed capture round must not disable every Record after it" \
    "$CACHE_DIR holds $(cache_count) after a Record with a writable cache — the earlier failed round left the store latched"
fi
pass "a Record after the failed one stores its pictures: the failed round did not latch the store"

# ----------------------------------------------------- 10. FORGET deletes

# Put the pictures back first, so forgetting has something to delete: a forget
# over an empty cache would pass this on a plugin that never deletes anything.
final_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $final_record == "recorded" ]] || fail "panel IPC records before the forget (captures)" "record answered '$final_record'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "there are pictures to forget (captures)" "$CACHE_DIR holds $(cache_count)"
fi

forget_answer=$(omarchy-shell "$IPC_TARGET" forgetLayout 2>&1)
[[ $forget_answer == "forgotten" ]] ||
  fail "panel IPC forgets a layout (captures)" "forgetLayout answered '$forget_answer'"
if ! poll 30 cache_is 0; then
  diagnostics
  fail "forgetting a layout deletes its pictures (captures)" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi
forgotten=$(jq -r --arg k "$TOPOLOGY_KEY" '(.layouts|has($k))|tostring' "$STATE" 2>/dev/null)
[[ $forgotten == "false" ]] ||
  fail "forgetting a layout removes it from the file (captures)" \
    "the state file still has a layout for '$TOPOLOGY_KEY'"
pass "forgetting the layout deleted both the recording and its pictures"

# ------------------ 10b. THE SWITCH SURVIVES A SHELL RESTART (epic wau)
#
# The switch is in the state file rather than in the panel, so a restart is what
# proves it: the shell process that held it in memory is gone, and the panel
# below is a fresh object reading the file from disk. That is the whole reason
# it lives beside `paused` instead of being a panel property.
#
# The SECOND restart in this test, and it is the honest cost of the claim. The
# apps are Hyprland clients rather than shell children, so they survive it; only
# the panel has to be summoned again.
switch_off_before_restart=$(omarchy-shell "$IPC_TARGET" setPictures off 2>&1)
[[ $switch_off_before_restart == "off" ]] ||
  fail "the pictures are switched off before the restart (captures)" \
    "setPictures off answered '$switch_off_before_restart'"

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
poll 20 panel_layer_absent
omarchy-restart-shell >/dev/null 2>&1
wait_until "shell is back after the second restart (captures)" 60 pgrep -f 'quickshell -n -p'
wait_until "dock-recall service is ready again (captures)" 60 service_ready
omarchy-shell shell summon "$PLUGIN_ID" '{}' >/dev/null 2>&1
if ! poll 30 panel_layer_present; then
  diagnostics
  fail "the panel comes back after the second restart (captures)" "no panel layer"
fi

# A FRESH PANEL, READING THE FILE. `panel_ready` requires `pictures == true`, so
# it deliberately is not used here — this is the one moment in the file where the
# switch is off and a ready panel has to say so.
restarted_ready() {
  panel_state_json | jq -e '(.chips|type) == "array" and (.chips|length) > 0
    and has("pictures") and .pictures == false' >/dev/null
}
if ! poll 60 restarted_ready; then
  diagnostics
  fail "the switch survives a shell restart (captures)" \
    "the restarted panel reports pictures '$(panel_state_json | jq -r '.pictures|tostring')'"
fi

# AND IT TAKES NO LIVE PICTURE. The round runs when the panel opens, and this
# panel has just opened with the switch off.
#
# AN ABSENCE CANNOT BE POLLED FOR, so this waits on the round's OWN evidence
# instead of on a clock: LiveCaptureStore brackets every round with a line, and
# a round that planned nothing says so ("0 window(s) to photograph"). That line
# is the round having happened AND having taken nothing — which a sleep followed
# by an empty payload cannot distinguish from a round that had not started yet.
live_round_took_nothing() {
  dr_log | grep -qF "live picture round: 0 window(s) to photograph"
}
if ! poll "$ROUND_S" live_round_took_nothing; then
  diagnostics
  fail "the live round on a panel opened with the pictures off plans nothing" \
    "no 'live picture round: 0 window(s) to photograph' line after the restart"
fi
no_live_after_restart() {
  panel_state_json | jq -e '
    ([.chips[]|select(.liveCapture == true)]|length) == 0
    and ([.chips[]|select(has("liveSource"))]|length) == 0
    and ([.chips[]|select((.iconSource|type) == "string"
       and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
no_live_after_restart || {
  diagnostics
  fail "a panel opened with the pictures off takes none" \
    "$(panel_state_json | jq -c '[.chips[]|select(.liveCapture == true)|{key, liveSource}]' 2>&1)"
}

# AND A RECORD STORES NOTHING, which is the recorded half of the same fact —
# waited on the same way, through the round's own line rather than a clock. With
# the switch off every app in the layout is `pictures-off` in the plan, so the
# panel logs the no-pictures sentence rather than going quiet.
off_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $off_record == "recorded" ]] ||
  fail "panel IPC records with the pictures off (captures)" "record answered '$off_record'"
record_took_nothing() { dr_log | grep -qF "no pictures for this recording"; }
if ! poll "$ROUND_S" record_took_nothing; then
  diagnostics
  fail "a Record with the pictures off says it took none" \
    "no 'no pictures for this recording' line after a Record with the switch off"
fi
cache_is 0 || {
  diagnostics
  fail "a Record with the pictures off stores nothing" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
}
pass "the switch survived a shell restart: a fresh panel reports it off, its live round planned nothing and its Record stored nothing"

# Back on for the rest of the file.
switch_back_on=$(omarchy-shell "$IPC_TARGET" setPictures on 2>&1)
[[ $switch_back_on == "on" ]] ||
  fail "the pictures go back on after the restart (captures)" \
    "setPictures on answered '$switch_back_on'"
if ! poll 60 panel_ready; then
  diagnostics
  fail "the restarted panel reports the switch back on (captures)" \
    "no payload with chips and pictures == true"
fi

# ---------- 10d. THE SWITCH REACHES EVERY DESK (tick sp7, epic wau)
#
# EVERYTHING ABOVE THIS LINE IS ONE TOPOLOGY, and that is exactly how the
# original bug survived a whole epic: an eviction keyed on the desk you happen to
# be plugged into passes every single-desk assertion in this file. So from here
# on there are TWO, and the claim is made across both.
#
# The promise being tested is the one the overflow entry's tooltip makes: off
# deletes every stored picture, on every desk. Not the pictures on this desk —
# the pictures. `pictures` is one top-level boolean with no topology in it, so an
# eviction that reached one desk would leave the others holding photographs the
# user has switched off, with nobody who would ever come back for them: a
# Record's eviction only runs for the desk you are on, and so does Forget.
#
# PAUSED FIRST. Docking and undocking are monitor events, and the service acts on
# them — restoring layouts and moving the two windows about while the assertions
# below are about the panel's own eviction. Pausing is the first-party way to say
# "watch nothing for a moment", and it leaves every panel act available.
paused_answer=$(omarchy-shell "$IPC_TARGET" setPaused on 2>&1)
[[ $paused_answer == "paused" ]] ||
  fail "the plugin can be paused for the two-desk round (captures)" "setPaused on answered '$paused_answer'"

# DESK ONE.
rm -rf "$CACHE_DIR"
desk_a_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $desk_a_record == "recorded" ]] ||
  fail "panel IPC records on the first desk (captures)" "record answered '$desk_a_record'"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "the first desk stored its pictures (captures)" "$CACHE_DIR holds $(cache_count)"
fi

# DESK TWO. A second monitor is a different topology key, so the Record below
# files its layout and its pictures under a different prefix — which is the whole
# point: four files, two per desk, for two apps and one switch.
hyprctl output create headless "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock appeared (captures)" 20 monitor_present "$DOCK_OUTPUT"
await_panel_docked "two desks"

# The panel has to have SEEN the new desk before it can record for it — a Record
# on a stale monitor list would file the second layout under the first key and
# quietly turn this into a one-desk test again. `await_panel_docked` above is
# that precondition, which is why ONE record is enough here: the retry loop this
# replaced was insurance against a wait that already happened, and it bought the
# insurance by leaving a round in flight for the untick and the switch below.
record_once "the second desk"

# NOT A POLL, for the reason step 5 spells out (tick m4s): "recorded" is a
# promise that the bytes are on disk, and polling would turn a broken promise
# into a slow one.
layouts_are 2 || {
  diagnostics
  fail "panel IPC records a SECOND topology (captures)" \
    "after docking $DOCK_OUTPUT the state file holds $(layout_count) layout(s)"
}
if ! poll "$ROUND_S" cache_is 4; then
  diagnostics
  fail "each desk stores its own pictures (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi

# BY NAME, not by count. Four files whose only differences are the topology hash
# and the identity, all named by the plugin's own captureFileName for the two
# keys the state file actually carries.
want_four=$(printf '%s\n%s\n' \
  "$(expected_files_for_all_layouts "$WIDE_IDENTITY")" \
  "$(expected_files_for_all_layouts "$TALL_IDENTITY")" | sort)
[[ $(cache_files) == "$want_four" ]] ||
  fail "the two desks' pictures are keyed on their two topologies (captures)" \
    "the cache holds '$(cache_files | tr '\n' ' ')', expected '$(printf '%s' "$want_four" | tr '\n' ' ')'"
[[ $(printf '%s\n' "$want_four" | grep -c .) -eq 4 ]] ||
  fail "the second desk really is a second topology (captures)" \
    "both layouts name the same pictures — the dock did not change the topology key"
pass "two desks, two recordings, four pictures — $(cache_files | tr '\n' ' ')"

# THE SWITCH. One press, on the desk that is plugged in now.
two_desk_off=$(omarchy-shell "$IPC_TARGET" setPictures off 2>&1)
[[ $two_desk_off == "off" ]] ||
  fail "the pictures can be switched off on the two-desk round (captures)" \
    "setPictures off answered '$two_desk_off'"

if ! poll 30 cache_is 0; then
  diagnostics
  fail "switching the pictures off deletes them on EVERY desk" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ') — the other desk's copies survived the switch"
fi
switched_on_disk=$(jq -r '.pictures|tostring' "$STATE" 2>/dev/null)
[[ $switched_on_disk == "false" ]] ||
  fail "the switch reached the state file (captures)" "the state file says pictures '$switched_on_disk'"

# AND THE MAP STOPS DRAWING THEM. The delete is a process and the listing that
# follows it is another; the gate that makes this immediate is the switch.
withdrawn_view=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $withdrawn_view == "recorded" ]] ||
  fail "the recorded map opens after the switch (captures)" "setView recorded answered '$withdrawn_view'"
if ! poll 30 capture_gone; then
  diagnostics
  fail "the map stops drawing pictures the switch has turned off" \
    "a chip still reports a capture after the pictures went off"
fi
pass "one switch thrown: BOTH desks' pictures deleted, and the map stopped drawing them"

# ------------- 10f. UNTICKING AN APP TAKES ITS PICTURES WITH IT (tick sp7)
#
# THE ONE PER-APP ACT LEFT, and the switch does not change it. Watching is still
# per app, so "stop watching this" is still a statement about ONE app's
# pictures — on every desk, because being watched has no topology in it either.
#
# This is the assertion that the global switch did not swallow the per-identity
# eviction on its way in: the wide app is unticked and BOTH of its pictures go,
# while BOTH of the tall app's stay. A `cache_is 0` here would pass on a build
# that deleted everything, which is precisely the wrong behaviour.
untick_switch_on=$(omarchy-shell "$IPC_TARGET" setPictures on 2>&1)
[[ $untick_switch_on == "on" ]] ||
  fail "the pictures go back on for the untick round (captures)" \
    "setPictures on answered '$untick_switch_on'"

# The dock from 10d is still plugged in, so this desk is desk TWO.
record_once "the second desk, for the untick round"
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "the second desk has pictures to untick away (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi

hyprctl output remove "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock went for the untick round (captures)" 20 monitor_absent "$DOCK_OUTPUT"
await_panel_undocked "the untick round"
rounds_before_untick=$(dr_log | grep -c "picture(s) stored")
record_once "the first desk, for the untick round"
if ! poll "$ROUND_S" cache_is 4; then
  diagnostics
  fail "both desks have pictures to untick away (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi

# AND THE ROUND HAS CLOSED before the untick below. `cache_is 4` is the last
# file LANDING, which is not the same as the round being over — and the untick
# is precisely the act whose interleave with a live round the store's write-time
# gate exists for, so a step that means to test the eviction must not be testing
# that gate by accident.
#
# THE OBSERVABLE IS THE ROUND'S OWN CLOSING LINE, counted, and it is deliberately
# not `record` answering something other than "cannot-record": asking the panel
# to record is how you find out a round has finished AND how you start the next
# one, and a probe that mutates what it measures is the shape this whole section
# was repaired out of.
records_closed() { [[ $(dr_log | grep -c "picture(s) stored") -gt $rounds_before_untick ]]; }
if ! poll "$ROUND_S" records_closed; then
  diagnostics
  fail "the capture round closed before the untick (captures)" \
    "no new 'picture(s) stored' line after the first desk's Record — the round never reported"
fi

# The row to untick, found the way a finger finds it: from the WINDOW, through
# the chip that draws it, to the row it is linked to. Not by name — both windows
# are class `foot` and only their titles differ. The link key is a live-map fact,
# so the panel goes there first.
untick_view=$(omarchy-shell "$IPC_TARGET" setView live 2>&1)
[[ $untick_view == "live" ]] ||
  fail "the live map opens for the row lookup (captures)" "setView live answered '$untick_view'"
WIDE_ROW_KEY=""
find_row() { WIDE_ROW_KEY=$(wide_row_key); [[ -n $WIDE_ROW_KEY ]]; }
if ! poll 30 find_row; then
  diagnostics
  fail "the wide app has a row it can be unticked on (captures)" \
    "no row links to the window titled $WIDE_TITLE"
fi

# WHICH FILES SHOULD SURVIVE, by name, from the plugin's own naming function for
# the two keys the state file carries. Computed BEFORE the untick, because the
# untick takes the identity out of the file and `expected_files_for_all_layouts`
# would then be naming an app nobody watches.
tall_survivors=$(expected_files_for_all_layouts "$TALL_IDENTITY")
[[ $(printf '%s\n' "$tall_survivors" | grep -c .) -eq 2 ]] ||
  fail "the tall app has a picture on each desk (captures)" \
    "expected two survivors, got '$(printf '%s' "$tall_survivors" | tr '\n' ' ')'"

untick_answer=$(omarchy-shell "$IPC_TARGET" toggleRow "$WIDE_ROW_KEY" 2>&1)
[[ $untick_answer == "toggled" ]] ||
  fail "panel IPC unticks the wide app (captures)" "toggleRow '$WIDE_ROW_KEY' answered '$untick_answer'"

untick_left_the_others() { [[ $(cache_files) == "$tall_survivors" ]]; }
if ! poll 30 untick_left_the_others; then
  diagnostics
  fail "unticking an app deletes ITS pictures on every desk, and only its" \
    "$CACHE_DIR holds '$(cache_files | tr '\n' ' ')', expected exactly the tall app's two: '$(printf '%s' "$tall_survivors" | tr '\n' ' ')'"
fi
unwatched=$(jq -r --arg id "$WIDE_IDENTITY" \
  '[.identities[]|select(.id == $id)]|length' "$STATE" 2>/dev/null)
[[ $unwatched == "0" ]] ||
  fail "the untick reached the state file (captures)" \
    "$WIDE_IDENTITY is still in the watched list after toggleRow"
# And the switch is untouched by a per-app act: unticking one app is not a
# statement about whether this tool photographs.
untick_switch=$(jq -r '.pictures|tostring' "$STATE" 2>/dev/null)
[[ $untick_switch == "true" ]] ||
  fail "unticking an app moved the global switch (captures)" \
    "the state file says pictures '$untick_switch' after a toggleRow"
pass "unticking the wide app deleted its pictures on both desks and left the tall app's — the switch untouched"

unpaused_answer=$(omarchy-shell "$IPC_TARGET" setPaused off 2>&1)
[[ $unpaused_answer == "active" ]] ||
  fail "the plugin is active again after the two-desk round (captures)" \
    "setPaused off answered '$unpaused_answer'"

# --------------------------------------------------------- 11. leave it closed

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
if ! poll 20 panel_layer_absent; then
  diagnostics
  fail "panel dismissed (captures)" "the panel's layer '$PANEL_NAMESPACE' is still mapped"
fi
pass "panel dismissed; the desk is back for the tests after this one"

capture_service_log
pass "dock-recall captures: stored by default, keyed, overwritten, evicted, switched off in one place, and never able to fail a record"
