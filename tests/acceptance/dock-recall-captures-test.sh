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
#   THE WRITE       — Record stores exactly one picture per PICTURED app, keyed
#                     on (identityId, occurrence, topologyKey). The expected
#                     name is computed by asking the plugin's own
#                     PanelModel.captureFileName with the topology key read out
#                     of the state file the record just wrote — so the test
#                     agrees with the code about the key by construction, and
#                     disagrees loudly about everything else.
#   THE CONSENT     — a watched app that has NOT granted the second consent gets
#                     no picture. This is the whole privacy claim, and it is the
#                     one assertion that would still pass if the count were
#                     merely right.
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
#                     withheld window, the panel's own 1x1 host surface scaled
#                     up, or the whole output — both test windows are the same
#                     binary, so their content cannot tell them apart. Their
#                     SHAPES can: they are floated at aspect ratios five times
#                     apart, and the stored JPEG's own proportions have to be the
#                     pictured window's and not the withheld one's.
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
#   THE DIALOGUE    — the FIRST Record with picturable apps puts the panel in
#                     the consent state, showing the captures just taken and
#                     offering exactly three answers. Asserted on what it is
#                     SHOWING (a thumbnail whose Image reports Ready, at the same
#                     URL the recorded map binds) as much as on what it offers,
#                     because a strip of empty boxes would satisfy a count. The
#                     answer is then read back off the state file, survives a
#                     SHELL RESTART, and the next Record does not ask again —
#                     which is the whole of "asked once". Finally "Not for these
#                     apps" is driven end to end: the cameras go off AND the
#                     pictures already taken are deleted, because either half
#                     alone is the wrong behaviour.
#   EVERY DESK      — and this one needs TWO topologies, because an eviction
#                     keyed on the desk you happen to be plugged into passes
#                     every other assertion in this file. A second headless
#                     output is docked, a picture is stored on each side of it,
#                     and then the camera is switched off ONCE: both have to go.
#                     The same for unticking the app, and for "Not for these
#                     apps" answered after the desk changed while the prompt was
#                     up — which is the case where the panel is looking at one
#                     desk's pictures and `topologyKey` names another.
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

# TWO APPS, and the pair is the point: one has granted the second consent and
# one has not. A run with only the first would pass identically if the plugin
# photographed everything it watched.
PICTURED_TITLE="dock-recall-pictured"
PICTURED_IDENTITY="dr-pictured"
WITHHELD_TITLE="dock-recall-withheld"
WITHHELD_IDENTITY="dr-withheld"
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
EXPECTED_FILE=""

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

# The app list's key for the app that has the camera, found the way a finger
# finds it: from the WINDOW, through the chip that draws it, to the row it is
# linked to. Not from `.pictured`, because half the assertions below start with
# the camera already off — and not from the row's name, because both windows are
# class `foot` and only their titles differ.
#
# The link key is a live-map fact, so the caller puts the panel on the live map
# first.
pictured_row_key() {
  local address link
  address=$(window_address "$PICTURED_TITLE")
  [[ -n $address ]] || return 1
  link=$(panel_state_json | jq -r --arg a "$address" \
    'first(.chips[]|select(.key == $a)|.linkKey)//empty')
  [[ -n $link ]] || return 1
  panel_state_json | jq -r --arg l "$link" 'first(.rows[]|select(.linkKey == $l)|.key)//empty'
}

# Every topology the state file has a layout for, and the picture each one would
# hold for the pictured app — asked of the plugin's own naming function, exactly
# as EXPECTED_FILE is, so the test agrees with the code about the key by
# construction and disagrees loudly about everything else.
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

# Every .jpg the cache holds right now, one per line, sorted. A missing
# directory is an empty listing and NOT an error — that is the state the plugin
# ships in and the state a cleaner leaves behind.
cache_files() {
  find "$CACHE_DIR" -maxdepth 1 -type f -name '*.jpg' -printf '%f\n' 2>/dev/null | sort
}
cache_count() { cache_files | grep -c . ; }
cache_is() { [[ $(cache_count) -eq "$1" ]]; }

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
  echo "--- cache dir ---" >&2
  ls -la "$CACHE_DIR" >&2 2>/dev/null || echo "(no $CACHE_DIR)" >&2
  ls -ld "$CACHE_PARENT" >&2 2>/dev/null || echo "(no $CACHE_PARENT)" >&2
  echo "--- state file ---" >&2
  head -60 "$STATE" >&2 2>/dev/null
  echo "--- panel state (raw) ---" >&2
  panel_state_json | head -c 3000 >&2
  echo >&2
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
  pkill -f "foot --title=$PICTURED_TITLE" 2>/dev/null
  pkill -f "foot --title=$WITHHELD_TITLE" 2>/dev/null
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

pkill -f "foot --title=$PICTURED_TITLE" 2>/dev/null
pkill -f "foot --title=$WITHHELD_TITLE" 2>/dev/null
launch_app "foot --title=$PICTURED_TITLE"
launch_app "foot --title=$WITHHELD_TITLE"
wait_until "the pictured app's window appeared (captures)" 30 window_here "$PICTURED_TITLE"
wait_until "the withheld app's window appeared (captures)" 30 window_here "$WITHHELD_TITLE"
pass "two windows on the desk: one app that will grant the picture consent, one that will not"

# --------------------------------- 2b. TWO DELIBERATELY DIFFERENT SHAPES (3xi)
#
# Both windows are class `foot` from the same binary, so their PIXELS cannot tell
# them apart — and a test that only checks the file name, the JPEG header and a
# width cap passes just as happily on a store that photographed the WITHHELD
# window, the panel's own 1x1 host surface scaled up, or the whole output.
#
# Their SHAPES can tell them apart. Floated at wildly different aspect ratios —
# one wide, one tall — the stored JPEG's own proportions become evidence about
# which window was in front of the camera. `captureWidth` scales the picture
# down but scales it PROPORTIONALLY (targetHeight is height * targetWidth /
# width), so the ratio survives the resize; only the absolute pixels do not,
# which is why nothing below compares those.
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

shape_window "the pictured window" "$(window_address "$PICTURED_TITLE")" 900 340 20 20
shape_window "the withheld window" "$(window_address "$WITHHELD_TITLE")" 340 700 20 400

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
prev_pictured_size="" prev_withheld_size=""
while (( SECONDS < shape_settle_deadline )); do
  cur_pictured_size=$(window_size "$PICTURED_TITLE")
  cur_withheld_size=$(window_size "$WITHHELD_TITLE")
  [[ -n $cur_pictured_size && -n $cur_withheld_size \
     && $cur_pictured_size == "$prev_pictured_size" \
     && $cur_withheld_size == "$prev_withheld_size" ]] && break
  prev_pictured_size="$cur_pictured_size" prev_withheld_size="$cur_withheld_size"
  sleep 0.3
done

PICTURED_SIZE=$(window_size "$PICTURED_TITLE")
WITHHELD_SIZE=$(window_size "$WITHHELD_TITLE")
[[ -n $PICTURED_SIZE && -n $WITHHELD_SIZE ]] ||
  fail "both test windows report a size (captures)" \
    "pictured '$PICTURED_SIZE', withheld '$WITHHELD_SIZE'"

# The two shapes have to be far enough apart that a picture of the wrong one
# could not be mistaken for a picture of the right one. 40% is a floor, not a
# target: the shapes asked for above differ by a factor of five.
shapes_differ=$(node -e '
  function ratio(s) { var p = String(s).split("x"); return Number(p[0]) / Number(p[1]); }
  var mine = ratio(process.argv[1]), theirs = ratio(process.argv[2]);
  if (!isFinite(mine) || !isFinite(theirs) || mine <= 0 || theirs <= 0) process.exit(2);
  process.stdout.write(mine.toFixed(3) + " vs " + theirs.toFixed(3));
  process.exit(Math.abs(mine - theirs) / Math.max(mine, theirs) >= 0.4 ? 0 : 1);
' "$PICTURED_SIZE" "$WITHHELD_SIZE") ||
  fail "the two test windows have distinguishable shapes (captures)" \
    "pictured $PICTURED_SIZE, withheld $WITHHELD_SIZE (aspect $shapes_differ) — the resize did not take, so no assertion below could tell a picture of one from a picture of the other"
pass "the two windows are shaped differently on purpose: pictured $PICTURED_SIZE, withheld $WITHHELD_SIZE (aspect $shapes_differ)"

# ------------------------------------------------------- 3. seed the identities
#
# Both watched; only one PICTURED. The version is read out of StateModel rather
# than typed, for the reason every seed in this directory reads it: a seed
# declaring an older version is read as a MIGRATION, and v4's migration is not
# purely additive, so a stale number would quietly change what this test
# believes it seeded.
#
# `titlePatterns` is what separates the two: both windows are class `foot`, and
# the engine ANDs the two axes, so the title is the only thing that tells the
# consenting window from the withholding one.

SCHEMA_VERSION=$(node -e 'process.stdout.write(String(require(process.argv[1] + "/StateModel.js").STATE_VERSION))' "$PLUGIN_DIR" 2>/dev/null)
[[ $SCHEMA_VERSION =~ ^[0-9]+$ ]] ||
  fail "schema version read from StateModel (captures)" "StateModel.STATE_VERSION came back as '$SCHEMA_VERSION'"

cat > "$STATE.seed" <<JSON
{
  "version": $SCHEMA_VERSION,
  "paused": false,
  "identities": [
    {
      "id": "$PICTURED_IDENTITY",
      "patterns": ["^$APP_CLASS\$"],
      "titlePatterns": ["^$PICTURED_TITLE\$"],
      "launch": "foot --title=$PICTURED_TITLE",
      "pictured": true
    },
    {
      "id": "$WITHHELD_IDENTITY",
      "patterns": ["^$APP_CLASS\$"],
      "titlePatterns": ["^$WITHHELD_TITLE\$"],
      "launch": "foot --title=$WITHHELD_TITLE",
      "pictured": false
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
pass "seeded: $PICTURED_IDENTITY pictured, $WITHHELD_IDENTITY watched and NOT pictured"

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
panel_ready() {
  panel_state_json | jq -e '(.chips|type) == "array" and (.chips|length) > 0
    and ([.chips[]|select(.pictured == true)]|length) >= 1' >/dev/null
}
if ! poll 60 panel_ready; then
  diagnostics
  fail "the panel has read the desk and the consent (captures)" \
    "no payload with chips, one of them pictured"
fi
screenshot "success-dock-recall-captures-01-open"
pass "panel summoned, reading the desk, and reporting the granted consent"

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
[[ $recorded_apps == "$PICTURED_IDENTITY,$WITHHELD_IDENTITY" ]] ||
  fail "both watched apps are in the recording (captures)" \
    "the layout names '$recorded_apps', expected '$PICTURED_IDENTITY,$WITHHELD_IDENTITY'"

# THE EXPECTED NAME, asked of the plugin's own naming function with the topology
# key the record actually wrote. The test does not re-implement the key — that
# would be two spellings of one rule — but it does insist the file on disk is
# the one that key names, which is the assertion that would catch a picture
# filed under the wrong window or the wrong desk.
EXPECTED_FILE=$(node -e '
  var panel = require(process.argv[1] + "/PanelModel.js");
  process.stdout.write(panel.captureFileName(process.argv[2], 0, process.argv[3]));
' "$PLUGIN_DIR" "$PICTURED_IDENTITY" "$TOPOLOGY_KEY")
[[ -n $EXPECTED_FILE ]] || fail "the plugin can name a capture file (captures)"

WITHHELD_FILE=$(node -e '
  var panel = require(process.argv[1] + "/PanelModel.js");
  process.stdout.write(panel.captureFileName(process.argv[2], 0, process.argv[3]));
' "$PLUGIN_DIR" "$WITHHELD_IDENTITY" "$TOPOLOGY_KEY")

if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "Record stored one picture (captures)" \
    "after ${ROUND_S}s $CACHE_DIR holds $(cache_count) picture(s): $(cache_files | tr '\n' ' ')"
fi

stored=$(cache_files)
[[ $stored == "$EXPECTED_FILE" ]] ||
  fail "the picture is keyed on identity, occurrence and topology (captures)" \
    "the cache holds '$stored', expected '$EXPECTED_FILE'"
[[ -s "$CACHE_DIR/$EXPECTED_FILE" ]] ||
  fail "the picture is not empty (captures)" "$CACHE_DIR/$EXPECTED_FILE is zero bytes"

dimensions=$(jpeg_size "$CACHE_DIR/$EXPECTED_FILE") ||
  fail "the picture decodes as a JPEG (captures)" \
    "no start-of-frame marker in $CACHE_DIR/$EXPECTED_FILE ($(wc -c < "$CACHE_DIR/$EXPECTED_FILE") bytes)"
width=${dimensions%x*}
((width > 0 && width <= 512)) ||
  fail "the picture is stored at chip size (captures)" \
    "it is ${dimensions}, and the store caps the width at 512"
bytes=$(wc -c < "$CACHE_DIR/$EXPECTED_FILE")
pass "Record stored one picture, $EXPECTED_FILE — $dimensions, $bytes bytes, a decodable JPEG"

# AND IT IS A PICTURE OF THE RIGHT WINDOW (tick 3xi).
#
# Everything above this line — the file name, the SOF walk, the width cap, the
# non-emptiness — passes unchanged on a store that photographed the WITHHELD
# window, the panel's own 1x1 host surface scaled up, or the whole output. The
# name proves the KEY; nothing proved the PIXELS, and the two test windows are
# the same binary so their content cannot tell them apart.
#
# Their proportions can. `jpeg_size` already read both dimensions and this used
# to throw the height away; the stored picture's aspect ratio has to be the
# PICTURED window's and not the WITHHELD one's — one wide, one tall, five times
# apart. Compared with a tolerance rather than an equality on purpose: the
# compositor's captured size and the geometry hyprctl reports disagree about
# borders and scale (spike o2x, and it is why CaptureStore sizes from
# sourceSize), so the honest claim is "these proportions, not those".
aspect_verdict=$(node -e '
  function ratio(s) { var p = String(s).split("x"); return Number(p[0]) / Number(p[1]); }
  var stored = ratio(process.argv[1]);
  var mine = ratio(process.argv[2]);
  var theirs = ratio(process.argv[3]);
  if (!isFinite(stored) || !isFinite(mine) || !isFinite(theirs)) process.exit(2);
  var dMine = Math.abs(stored - mine) / mine;
  var dTheirs = Math.abs(stored - theirs) / theirs;
  process.stdout.write("stored " + stored.toFixed(3)
    + ", pictured " + mine.toFixed(3) + " (off by " + (dMine * 100).toFixed(1) + "%)"
    + ", withheld " + theirs.toFixed(3) + " (off by " + (dTheirs * 100).toFixed(1) + "%)");
  process.exit((dMine <= 0.15 && dTheirs > 0.15) ? 0 : 1);
' "$dimensions" "$PICTURED_SIZE" "$WITHHELD_SIZE") || {
  diagnostics
  fail "the stored picture is OF the pictured window, and not of the other one" \
    "$aspect_verdict — a picture whose proportions are not the pictured window's is a picture of something else"
}
pass "the picture's proportions are the pictured window's, not the withheld one's: $aspect_verdict"

# THE CONSENT. The withheld app is watched, it is running, and it is in the
# recording — and it has no picture. Asserted by NAME as well as by count: a
# count of one would also be satisfied by photographing the wrong app.
[[ ! -e "$CACHE_DIR/$WITHHELD_FILE" ]] ||
  fail "an app that withheld the consent is not photographed (captures)" \
    "$CACHE_DIR/$WITHHELD_FILE exists for $WITHHELD_IDENTITY, which is watched and NOT pictured"
pass "and none for $WITHHELD_IDENTITY — watched, recorded, and never photographed"

# ------------------------------- 5a. THE FIRST-RECORD DIALOGUE (tick y28)
#
# The first Record with picturable apps puts the panel in the CONSENT STATE: it
# shows the captures just taken and offers exactly three answers. This is the
# moment the feature demonstrates itself, so the assertion is on what the prompt
# is SHOWING as much as on what it is offering — a strip that reported three
# sources and no ready picture would be a prompt showing the user empty boxes.
#
# The seed above left `pictureConsent` out of the state file entirely, which the
# reader materializes as "unasked" — so this is genuinely the first ask, reached
# the way a user reaches it and not by setting a flag.

CAPTURE_URL="file://$CACHE_DIR/$EXPECTED_FILE"

consent_offered() {
  panel_state_json | jq -e --arg id "$PICTURED_IDENTITY" --arg url "$CAPTURE_URL" '
    .consentOpen == true
    and .pictureConsent == "unasked"
    # EXACTLY THREE, in order, under exactly these words. The ids come from the
    # model and the labels from the buttons that drew them, so a prompt offering
    # the right ids under the wrong words fails here.
    and ([.consentChoices[]|.id] == ["keep", "not-these", "none"])
    and ([.consentChoices[]|.label]
         == ["Keep pictures", "Not for these apps", "No pictures"])
    # THE CAPTURES JUST TAKEN, and they are the ones on disk: the same URL the
    # recorded map binds, decoded (ready) rather than merely pointed at.
    and ((.consentCaptures|length) == 1)
    and (.consentCaptures[0].identityId == $id)
    and (.consentCaptures[0].source == $url)
    and (.consentCaptures[0].ready == true)
    and ((.consentCaptures[0].name|length) > 0)' >/dev/null
}
if ! poll "$ROUND_S" consent_offered; then
  diagnostics
  fail "the first Record with picturable apps puts the panel in the consent state" \
    "no payload with consentOpen, pictureConsent 'unasked', the three answers, and one ready thumbnail"
fi
screenshot "success-dock-recall-captures-02-consent"
pass "the first Record asks: three answers — Keep pictures / Not for these apps / No pictures — over the picture it just took"

# ANSWERED THROUGH THE PANEL'S OWN VERB, which routes to root.answerConsent and
# nothing else — the one place that re-reads the file, writes once, evicts and
# logs. There is no pointer in this venue, and this is the door that replaces
# one.
keep_answer=$(omarchy-shell "$IPC_TARGET" answerConsent keep 2>&1)
[[ $keep_answer == "keep" ]] ||
  fail "the panel records the answer (captures)" "answerConsent keep answered '$keep_answer'"

consent_kept() {
  panel_state_json | jq -e '
    .consentOpen == false
    and .pictureConsent == "keep"
    and ((.consentChoices|length) == 0)
    and ((.consentCaptures|length) == 0)' >/dev/null
}
if ! poll 20 consent_kept; then
  diagnostics
  fail "answering closes the prompt and records the answer (captures)" \
    "the payload still shows the prompt, or does not report the answer"
fi
# ON DISK, which is what makes it survive anything at all.
stored_answer=$(jq -r '.pictureConsent//"absent"' "$STATE" 2>/dev/null)
[[ $stored_answer == "keep" ]] ||
  fail "the answer is written to the state file (captures)" \
    "the state file says pictureConsent '$stored_answer'"
# And "Keep pictures" kept them: nothing was deleted and nobody's camera moved.
cache_is 1 ||
  fail "\"Keep pictures\" keeps the pictures (captures)" "$CACHE_DIR holds $(cache_count)"
still_pictured=$(jq -r --arg id "$PICTURED_IDENTITY" \
  'first(.identities[]|select(.id == $id)|.pictured)|tostring' "$STATE" 2>/dev/null)
[[ $still_pictured == "true" ]] ||
  fail "\"Keep pictures\" leaves the camera on (captures)" \
    "$PICTURED_IDENTITY reports pictured '$still_pictured'"
pass "answered: the prompt closed, the answer is in the state file, the picture and the camera are untouched"

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
# Both are ABSENT, never present-and-empty, for the chip that has no picture:
# the payload convention is that a key the panel has nothing to say about is not
# there at all, and "" would be a second spelling of the same silence.
#
# CAPTURE_URL is set at step 5a, where the consent prompt asserts on the same URL.
[[ $CACHE_DIR/$EXPECTED_FILE =~ ^[A-Za-z0-9/._~-]+$ ]] ||
  fail "the capture path needs no percent-encoding (captures)" \
    "$CACHE_DIR/$EXPECTED_FILE contains a character Util.fileUrl would escape"

capture_reported() {
  panel_state_json | jq -e --arg path "$CACHE_DIR/$EXPECTED_FILE" --arg url "$CAPTURE_URL" --arg want "$1" '
    ([.chips[]|select(has("capturePath") and .capturePath == $path
       and has("captureSource") and .captureSource == $url
       and .pictured == true and .renderPath == $want)]|length) == 1
    and ([.chips[]|select(has("capturePath"))]|length) == 1
    and ([.chips[]|select(has("captureSource"))]|length) == 1
    and ([.chips[]|select(has("capturePath") and (.capturePath|length) == 0)]|length) == 0
    and ([.chips[]|select(has("captureSource") and (.captureSource|length) == 0)]|length) == 0
    # Every chip still has its icon. A capture fills in UNDERNEATH the icon and
    # the name, and does not replace either.
    and ([.chips[]|select((.iconSource|type) == "string" and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll 30 capture_reported positioned; then
  diagnostics
  fail "the panel reports the stored picture, and only for the chip that has one" \
    "no POSITIONED chip reports capturePath '$CACHE_DIR/$EXPECTED_FILE' and captureSource '$CAPTURE_URL', or more than one does, or a chip reports one empty"
fi
pass "POSITIONED: the Recorded map draws the capture — path and source agree, and both keys are ABSENT for the chip with none"

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
  panel_state_json | jq -e --arg url "$CAPTURE_URL" '
    (.chips|length) > 0
    and ([.chips[]|select(.renderPath == "fallback")]|length) == (.chips|length)
    and ([.chips[]|select(has("captureSource") and .captureSource == $url
          and .pictured == true)]|length) == 1
    # AND THE NAME SURVIVES IT. The stacked rows are 17 px tall and this is
    # where names came back after a size ladder silently took every one of them
    # away; a capture that cost them their label would undo that just as
    # quietly. The tiers that draw a name are pill and strip, and this asks for
    # the OUTCOME rather than for a tier by name.
    and ([.chips[]|select(has("captureSource")
          and (.treatment == "pill" or .treatment == "strip"))]|length) == 1
    and ([.chips[]|select((.name|type) == "string" and (.name|length) > 0)]|length) == (.chips|length)
    and ([.chips[]|select((.iconSource|type) == "string" and (.iconSource|length) > 0)]|length) == (.chips|length)' >/dev/null
}
if ! poll 40 fallback_capture; then
  diagnostics
  fail "the FALLBACK path draws the same capture, and still draws the name" \
    "after stripping the layout's geometry, no fallback chip reports captureSource '$CAPTURE_URL' at a tier that carries a name"
fi
pass "FALLBACK: the same picture on the stacked path, on a chip that still reports its name and its icon"

# ------------------- 5c. a capture deleted under the panel falls back
#
# ONE file, not the whole directory (that is step 8), and the assertion is made
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
rm -f "$CACHE_DIR/$EXPECTED_FILE"
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
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "the picture is back after the fallback round (captures)" "$CACHE_DIR holds $(cache_count)"
fi

# ------------------------------------------------- 6. RE-RECORD overwrites

# THE MTIME, not the bytes. The claim being tested is "the file was written
# again", and a terminal showing a prompt really can produce two byte-identical
# JPEGs — the pixels did not change, so the encoder's output does not either.
# Asserting on content would make a correct pipeline fail on an idle window.
# Nanosecond mtime cannot: the store deletes the topology's pictures and writes
# new ones, so a re-record that happened is a new file every time.
before_mtime=$(stat -c %y "$CACHE_DIR/$EXPECTED_FILE")

rerecord_answer=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $rerecord_answer == "recorded" ]] ||
  fail "panel IPC re-records (captures)" "record answered '$rerecord_answer'"

# Still exactly one file, still under the same key — a re-record REPLACES a
# topology's pictures rather than accumulating them.
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "a re-record replaces the pictures rather than adding to them (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi
[[ $(cache_files) == "$EXPECTED_FILE" ]] ||
  fail "the re-recorded picture keeps its key (captures)" "the cache holds '$(cache_files)'"

# And it is a NEW picture. Polled, because the write is asynchronous; the point
# is that the file is rewritten at all, which is what a pipeline that had
# quietly stopped writing would fail.
changed() { [[ $(stat -c %y "$CACHE_DIR/$EXPECTED_FILE" 2>/dev/null) != "$before_mtime" ]]; }
if ! poll "$ROUND_S" changed; then
  diagnostics
  fail "a re-record rewrites the picture (captures)" \
    "$EXPECTED_FILE was not written again by the second Record (mtime still $before_mtime)"
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
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "recording again stores the picture again (captures)" "$CACHE_DIR holds $(cache_count)"
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
if [[ $blocked_apps != "$PICTURED_IDENTITY,$WITHHELD_IDENTITY" || -z $blocked_stamp ]]; then
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
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "a failed capture round must not disable every Record after it" \
    "$CACHE_DIR holds $(cache_count) after a Record with a writable cache — the earlier failed round left the store latched"
fi
pass "a Record after the failed one stores a picture: the failed round did not latch the store"

# ----------------------------------------------------- 10. FORGET deletes

# Put the pictures back first, so forgetting has something to delete: a forget
# over an empty cache would pass this on a plugin that never deletes anything.
final_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $final_record == "recorded" ]] || fail "panel IPC records before the forget (captures)" "record answered '$final_record'"
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "there is a picture to forget (captures)" "$CACHE_DIR holds $(cache_count)"
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
pass "forgetting the layout deleted both the recording and its picture"

# --------------------- 10b. ASKED ONCE, across a shell restart (tick y28)
#
# The answer is in the state file rather than in the panel, so a restart is what
# proves it: the shell process that held "keep" in memory is gone, and the panel
# below is a fresh object reading the file from disk.
#
# The SECOND restart in this test, and it is the honest cost of the claim. The
# apps are Hyprland clients rather than shell children, so they survive it; only
# the panel has to be summoned again.
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
if ! poll 60 panel_ready; then
  diagnostics
  fail "the restarted panel has read the desk and the consent (captures)" \
    "no payload with chips, one of them pictured"
fi

survived() { panel_state_json | jq -e '.pictureConsent == "keep" and .consentOpen == false' >/dev/null; }
if ! poll 30 survived; then
  diagnostics
  fail "the answer survives a shell restart (captures)" \
    "the restarted panel reports pictureConsent '$(panel_state_json | jq -r '.pictureConsent//"absent"')'"
fi

# AND IT DOES NOT ASK AGAIN. A Record that stores a picture is exactly the event
# that opened the prompt the first time, so this is the same trigger under an
# answered file — the whole of "asked once".
asked_again_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $asked_again_record == "recorded" ]] ||
  fail "panel IPC records after the restart (captures)" "record answered '$asked_again_record'"
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "the record after the restart stores a picture (captures)" "$CACHE_DIR holds $(cache_count)"
fi
# The picture is on disk, so the prompt's trigger has fired; give the panel a
# moment it could open in and require that it did not.
sleep 3
panel_state_json | jq -e '.consentOpen == false and .pictureConsent == "keep"' >/dev/null ||
  fail "the prompt does not appear again (captures)" \
    "a Record after the answer put the panel back in the consent state"
pass "asked ONCE: the answer survived a shell restart and the next Record did not ask again"

# ---------- 10c. “Not for these apps” unpictures them and deletes theirs
#
# The one answer with a destructive half, driven end to end. The question has to
# be asked again to answer it differently, and the only honest way to reach that
# is the file itself — `pictureConsent` is user-editable like everything else in
# it, and setting it back to "unasked" is what a user who wanted to be asked
# again would do. Nothing else is touched: the camera is still on and the
# picture from 10b is still on disk.
TOPOLOGY_KEY=$(jq -r 'first(.layouts|keys[])//empty' "$STATE" 2>/dev/null)
[[ -n $TOPOLOGY_KEY ]] || fail "there is a layout to re-record (captures)" "no layout key in $STATE"
node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2];
  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  fs.writeFileSync(statePath + ".tmp",
    StateModel.serializeState(StateModel.setPictureConsent(state, "unasked")));
  fs.renameSync(statePath + ".tmp", statePath);
' "$PLUGIN_DIR" "$STATE" || fail "the state file can be set back to unasked (captures)"

unasked_again() { panel_state_json | jq -e '.pictureConsent == "unasked"' >/dev/null; }
if ! poll 30 unasked_again; then
  diagnostics
  fail "the panel picks up the reset answer (captures)" "the panel still reports an answered consent"
fi

reask_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $reask_record == "recorded" ]] ||
  fail "panel IPC records for the second ask (captures)" "record answered '$reask_record'"
if ! poll "$ROUND_S" consent_offered; then
  diagnostics
  fail "the prompt comes back once the question is owed again (captures)" \
    "no payload with consentOpen and the three answers"
fi

decline_answer=$(omarchy-shell "$IPC_TARGET" answerConsent not-these 2>&1)
[[ $decline_answer == "not-these" ]] ||
  fail "the panel records the refusal (captures)" "answerConsent not-these answered '$decline_answer'"

# THE APPS ARE UNPICTURED AND THE PICTURES ARE GONE. Both halves, because either
# one alone would be the wrong behaviour: a camera left on would photograph them
# again at the next Record, and a picture left on disk is the thing the user just
# said they did not want kept.
if ! poll 30 cache_is 0; then
  diagnostics
  fail "\"Not for these apps\" removes the captures already taken" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi
declined_pictured=$(jq -r --arg id "$PICTURED_IDENTITY" \
  'first(.identities[]|select(.id == $id)|.pictured)|tostring' "$STATE" 2>/dev/null)
[[ $declined_pictured == "false" ]] ||
  fail "\"Not for these apps\" leaves those apps unpictured" \
    "$PICTURED_IDENTITY still reports pictured '$declined_pictured'"
declined_answer_on_disk=$(jq -r '.pictureConsent//"absent"' "$STATE" 2>/dev/null)
[[ $declined_answer_on_disk == "not-these" ]] ||
  fail "the refusal is written to the state file (captures)" \
    "the state file says pictureConsent '$declined_answer_on_disk'"

# The panel agrees, from the row that draws the camera.
declined_reported() {
  panel_state_json | jq -e '
    .consentOpen == false
    and .pictureConsent == "not-these"
    and (([.rows[]|select(.pictured == true)]|length) == 0)
    and (([.chips[]|select(.pictured == true)]|length) == 0)' >/dev/null
}
if ! poll 30 declined_reported; then
  diagnostics
  fail "the panel reports the withdrawn consent (captures)" \
    "a row or a chip still reports pictured after \"Not for these apps\""
fi
pass "\"Not for these apps\": the cameras are off, the pictures just taken are deleted, and the answer is on disk"

# ------- 10d. A CAMERA IS A FACT ABOUT AN APP, NOT ABOUT A DESK (tick sp7)
#
# EVERYTHING ABOVE THIS LINE IS ONE TOPOLOGY, and that is exactly how the bug
# survived a whole epic: an eviction keyed on the desk you happen to be plugged
# into passes every single-desk assertion in this file. So from here on there are
# TWO, and each claim is made across both.
#
# The promise being tested is the one the epic exists to keep: a user who
# withdraws consent gets the pictures deleted. Not the pictures on this desk —
# the pictures. A camera is a field on an IDENTITY and has no topology in it, so
# a withdrawal that reached one desk left the others holding photographs of an
# app whose camera is off, with nobody who would ever come back for them: a
# Record's eviction only runs for the desk you are on, and so does Forget.
#
# PAUSED FIRST. Docking and undocking are monitor events, and the service acts on
# them — restoring layouts and moving the two windows about while the assertions
# below are about the panel's own eviction. Pausing is the first-party way to say
# "watch nothing for a moment", and it leaves every panel act available.
paused_answer=$(omarchy-shell "$IPC_TARGET" setPaused on 2>&1)
[[ $paused_answer == "paused" ]] ||
  fail "the plugin can be paused for the two-desk round (captures)" "setPaused on answered '$paused_answer'"

live_answer=$(omarchy-shell "$IPC_TARGET" setView live 2>&1)
[[ $live_answer == "live" ]] ||
  fail "the panel shows the live map for the row lookup (captures)" "setView live answered '$live_answer'"

PICTURED_ROW_KEY=""
find_row() { PICTURED_ROW_KEY=$(pictured_row_key); [[ -n $PICTURED_ROW_KEY ]]; }
if ! poll 30 find_row; then
  diagnostics
  fail "the pictured app has a row the camera can be driven on (captures)" \
    "no row links to the window titled $PICTURED_TITLE"
fi

camera_on=$(omarchy-shell "$IPC_TARGET" setPictured "$PICTURED_ROW_KEY" on 2>&1)
[[ $camera_on == "on" ]] ||
  fail "the camera can be switched back on (captures)" "setPictured '$PICTURED_ROW_KEY' on answered '$camera_on'"

# DESK ONE.
rm -rf "$CACHE_DIR"
desk_a_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $desk_a_record == "recorded" ]] ||
  fail "panel IPC records on the first desk (captures)" "record answered '$desk_a_record'"
if ! poll "$ROUND_S" cache_is 1; then
  diagnostics
  fail "the first desk stored its picture (captures)" "$CACHE_DIR holds $(cache_count)"
fi
DESK_A_FILE=$(cache_files)

# DESK TWO. A second monitor is a different topology key, so the Record below
# files its layout and its picture under a different prefix — which is the whole
# point: two files, one per desk, for one app with one camera.
hyprctl output create headless "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock appeared (captures)" 20 monitor_present "$DOCK_OUTPUT"

# The panel has to have SEEN the new desk before it can record for it — a Record
# on a stale monitor list would file the second layout under the first key and
# quietly turn this into a one-desk test again.
docked_record() { [[ $(omarchy-shell "$IPC_TARGET" record 2>&1) == "recorded" ]] && layouts_are 2; }
if ! poll 60 docked_record; then
  diagnostics
  fail "panel IPC records a SECOND topology (captures)" \
    "after docking $DOCK_OUTPUT the state file still holds $(layout_count) layout(s)"
fi
if ! poll "$ROUND_S" cache_is 2; then
  diagnostics
  fail "each desk stores its own picture (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi

# BY NAME, not by count. Two files whose only difference is the topology hash,
# both named by the plugin's own captureFileName for the two keys the state file
# actually carries.
want_two=$(expected_files_for_all_layouts "$PICTURED_IDENTITY")
[[ $(cache_files) == "$want_two" ]] ||
  fail "the two desks' pictures are keyed on their two topologies (captures)" \
    "the cache holds '$(cache_files | tr '\n' ' ')', expected '$(printf '%s' "$want_two" | tr '\n' ' ')'"
[[ $(printf '%s\n' "$want_two" | grep -c .) -eq 2 ]] ||
  fail "the second desk really is a second topology (captures)" \
    "both layouts name the same picture — the dock did not change the topology key"
pass "two desks, two recordings, two pictures of one app — $(cache_files | tr '\n' ' ')"

# THE WITHDRAWAL. One click on one camera, on the desk that is plugged in now.
camera_off=$(omarchy-shell "$IPC_TARGET" setPictured "$PICTURED_ROW_KEY" off 2>&1)
[[ $camera_off == "off" ]] ||
  fail "the camera can be switched off (captures)" "setPictured '$PICTURED_ROW_KEY' off answered '$camera_off'"

if ! poll 30 cache_is 0; then
  diagnostics
  fail "switching a camera off deletes that app's pictures on EVERY desk" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ') — the other desk's copies survived the withdrawal"
fi
withdrawn=$(jq -r --arg id "$PICTURED_IDENTITY" \
  'first(.identities[]|select(.id == $id)|.pictured)|tostring' "$STATE" 2>/dev/null)
[[ $withdrawn == "false" ]] ||
  fail "the withdrawal reached the state file (captures)" "$PICTURED_IDENTITY reports pictured '$withdrawn'"

# AND THE MAP STOPS DRAWING IT. The delete is a process and the listing that
# follows it is another; the gate that makes this immediate is the flag.
withdrawn_view=$(omarchy-shell "$IPC_TARGET" setView recorded 2>&1)
[[ $withdrawn_view == "recorded" ]] ||
  fail "the recorded map opens after the withdrawal (captures)" "setView recorded answered '$withdrawn_view'"
if ! poll 30 capture_gone; then
  diagnostics
  fail "the map stops drawing a picture whose camera has been switched off" \
    "a chip still reports a capture after the camera went off"
fi
pass "one camera switched off: BOTH desks' pictures deleted, and the map stopped drawing them"

# ---------- 10e. \"Not for these apps\" deletes what it is LOOKING AT (sp7)
#
# The two ways the old code got this wrong, in one drive:
#
#   · it evicted the LIVE topology's prefix, so a dock or an undock while the
#     prompt was up pointed the delete at a desk the user was not looking at and
#     left the very pictures on screen;
#   · the answer withdraws the camera GLOBALLY, so every other desk's copies
#     stayed behind cameras that were off.
#
# So: build a picture on each desk, ask the question on the SECOND desk, UNDOCK
# while the prompt is up, and then answer. Nothing may survive.
camera_back=$(omarchy-shell "$IPC_TARGET" setPictured "$PICTURED_ROW_KEY" on 2>&1)
[[ $camera_back == "on" ]] ||
  fail "the camera goes back on for the refusal round (captures)" "setPictured answered '$camera_back'"

hyprctl output remove "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock went for the first desk's record (captures)" 20 monitor_absent "$DOCK_OUTPUT"
undocked_record() { [[ $(omarchy-shell "$IPC_TARGET" record 2>&1) == "recorded" ]] && cache_is 1; }
if ! poll 60 undocked_record; then
  diagnostics
  fail "the first desk has a picture again (captures)" "$CACHE_DIR holds $(cache_count)"
fi

# The question has to be owed again to be answered differently, and the only
# honest way to reach that is the file — `pictureConsent` is user-editable like
# everything else in it. Nothing else is touched.
node -e '
  var fs = require("fs");
  var StateModel = require(process.argv[1] + "/StateModel.js");
  var statePath = process.argv[2];
  var state = StateModel.parseState(fs.readFileSync(statePath, "utf8")).state;
  fs.writeFileSync(statePath + ".tmp",
    StateModel.serializeState(StateModel.setPictureConsent(state, "unasked")));
  fs.renameSync(statePath + ".tmp", statePath);
' "$PLUGIN_DIR" "$STATE" || fail "the state file can be set back to unasked again (captures)"
if ! poll 30 unasked_again; then
  diagnostics
  fail "the panel picks up the reset answer for the refusal round (captures)" \
    "the panel still reports an answered consent"
fi

# Dock, and ask the question THERE — so the pictures the prompt is showing are
# the second desk's.
hyprctl output create headless "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock came back for the prompt (captures)" 20 monitor_present "$DOCK_OUTPUT"
prompt_on_desk_two() {
  [[ $(omarchy-shell "$IPC_TARGET" record 2>&1) == "recorded" ]] && cache_is 2 \
    && panel_state_json | jq -e '.consentOpen == true' >/dev/null
}
if ! poll 60 prompt_on_desk_two; then
  diagnostics
  fail "the prompt is asked on the second desk (captures)" \
    "$CACHE_DIR holds $(cache_count) and consentOpen is $(panel_state_json | jq -r '.consentOpen|tostring')"
fi

# WHICH desk's picture the prompt is showing, because that is the half the old
# code got wrong: it deleted the prefix of whatever desk was plugged in when the
# button was pressed, not the one the pictures on screen belong to.
DESK_B_FILE=$(cache_files | grep -vxF "$DESK_A_FILE" | head -1)
[[ -n $DESK_B_FILE && $DESK_B_FILE != "$DESK_A_FILE" ]] ||
  fail "the second desk stored a picture of its own (captures)" \
    "the cache holds '$(cache_files | tr '\n' ' ')' and the first desk's is '$DESK_A_FILE'"
consent_shows_desk_two() {
  panel_state_json | jq -e --arg id "$PICTURED_IDENTITY" --arg url "file://$CACHE_DIR/$DESK_B_FILE" '
    .consentOpen == true
    and .pictureConsent == "unasked"
    and ([.consentChoices[]|.id] == ["keep", "not-these", "none"])
    and ((.consentCaptures|length) == 1)
    and (.consentCaptures[0].identityId == $id)
    and (.consentCaptures[0].source == $url)
    and (.consentCaptures[0].ready == true)' >/dev/null
}
if ! poll 30 consent_shows_desk_two; then
  diagnostics
  fail "the prompt shows the SECOND desk's picture (captures)" \
    "the strip does not report a ready thumbnail at file://$CACHE_DIR/$DESK_B_FILE"
fi
screenshot "success-dock-recall-captures-03-consent-two-desks"

# THE TOPOLOGY CHANGES WHILE THE PROMPT IS UP. The panel is still showing the
# second desk's pictures; `root.topologyKey` now names the first.
hyprctl output remove "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the desk changed under the open prompt (captures)" 20 monitor_absent "$DOCK_OUTPUT"
still_asking() { panel_state_json | jq -e '.consentOpen == true' >/dev/null; }
if ! poll 20 still_asking; then
  diagnostics
  fail "the prompt survives a topology change (captures)" \
    "the panel closed the consent prompt when the desk changed, so this round proves nothing"
fi

declined_two=$(omarchy-shell "$IPC_TARGET" answerConsent not-these 2>&1)
[[ $declined_two == "not-these" ]] ||
  fail "the panel records the refusal on the changed desk (captures)" \
    "answerConsent not-these answered '$declined_two'"

if ! poll 30 cache_is 0; then
  diagnostics
  fail "\"Not for these apps\" deletes what it is looking at, on every desk" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ') — the answer evicted the desk that happened to be plugged in rather than the app's pictures"
fi
pass "\"Not for these apps\" answered after the desk changed under the prompt: BOTH desks' pictures gone"

# ------------- 10f. UNTICKING AN APP TAKES ITS PICTURES WITH IT (tick sp7)
#
# The README has always promised "Unticking an app takes its camera consent with
# it". It took the FLAG — the field lives on the identity that goes — and left
# the photographs, on every desk, with the ghost chip still rendering them and no
# camera button left to press. This is the half a user would actually check.
untick_camera=$(omarchy-shell "$IPC_TARGET" setPictured "$PICTURED_ROW_KEY" on 2>&1)
[[ $untick_camera == "on" ]] ||
  fail "the camera goes back on for the untick round (captures)" "setPictured answered '$untick_camera'"

untick_record() { [[ $(omarchy-shell "$IPC_TARGET" record 2>&1) == "recorded" ]] && cache_is 1; }
if ! poll 60 untick_record; then
  diagnostics
  fail "there is a picture to untick away (captures)" "$CACHE_DIR holds $(cache_count)"
fi
hyprctl output create headless "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock came back for the untick round (captures)" 20 monitor_present "$DOCK_OUTPUT"
untick_record_two() { [[ $(omarchy-shell "$IPC_TARGET" record 2>&1) == "recorded" ]] && cache_is 2; }
if ! poll 60 untick_record_two; then
  diagnostics
  fail "both desks have a picture to untick away (captures)" \
    "$CACHE_DIR holds $(cache_count): $(cache_files | tr '\n' ' ')"
fi

untick_answer=$(omarchy-shell "$IPC_TARGET" toggleRow "$PICTURED_ROW_KEY" 2>&1)
[[ $untick_answer == "toggled" ]] ||
  fail "panel IPC unticks the pictured app (captures)" "toggleRow '$PICTURED_ROW_KEY' answered '$untick_answer'"

if ! poll 30 cache_is 0; then
  diagnostics
  fail "unticking an app deletes its pictures, on every desk" \
    "$CACHE_DIR still holds $(cache_count): $(cache_files | tr '\n' ' ') — the README's promise is still only about the flag"
fi
unwatched=$(jq -r --arg id "$PICTURED_IDENTITY" \
  '[.identities[]|select(.id == $id)]|length' "$STATE" 2>/dev/null)
[[ $unwatched == "0" ]] ||
  fail "the untick reached the state file (captures)" \
    "$PICTURED_IDENTITY is still in the watched list after toggleRow"
pass "unticking the app deleted its pictures on both desks — the README's promise, in full"

hyprctl output remove "$DOCK_OUTPUT" >/dev/null 2>&1
wait_until "the fake dock removed (captures)" 20 monitor_absent "$DOCK_OUTPUT"
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
pass "dock-recall captures: stored per consent, keyed, overwritten, evicted, and never able to fail a record"
