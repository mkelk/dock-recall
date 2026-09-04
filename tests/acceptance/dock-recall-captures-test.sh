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

GUEST_PASSWORD="${GUEST_PASSWORD:-omarchy}"

TOPOLOGY_KEY=""
EXPECTED_FILE=""

# ---------------------------------------------------------------- primitives

clients() { hyprctl clients -j; }
as_root() { echo "$GUEST_PASSWORD" | sudo -S "$@" 2>/dev/null; }
shell_log() { qs log -p "${OMARCHY_PATH:-/usr/share/omarchy}/shell" --tail 3000 2>/dev/null; }
dr_log() { shell_log | grep -F "[dock-recall]"; }
service_ready() { dr_log | grep -qF "service-ready"; }
plugin_state() { omarchy plugin list 2>/dev/null | awk -v id="$PLUGIN_ID" '$0 ~ id {print ($0 ~ /enabled/ ? "enabled" : "disabled")}' | head -1; }
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

# The record is a state-file write and it is synchronous, so the layout is on
# disk the moment the verb answers. The pictures are not: they are deliberately
# taken afterwards, off the recording's stack.
TOPOLOGY_KEY=$(jq -r 'first(.layouts|keys[])//empty' "$STATE" 2>/dev/null)
[[ -n $TOPOLOGY_KEY ]] ||
  fail "the record wrote a layout (captures)" "no layout key in $STATE after record answered 'recorded'"

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

if ! poll 40 cache_is 1; then
  diagnostics
  fail "Record stored one picture (captures)" \
    "after 40s $CACHE_DIR holds $(cache_count) picture(s): $(cache_files | tr '\n' ' ')"
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

# THE CONSENT. The withheld app is watched, it is running, and it is in the
# recording — and it has no picture. Asserted by NAME as well as by count: a
# count of one would also be satisfied by photographing the wrong app.
[[ ! -e "$CACHE_DIR/$WITHHELD_FILE" ]] ||
  fail "an app that withheld the consent is not photographed (captures)" \
    "$CACHE_DIR/$WITHHELD_FILE exists for $WITHHELD_IDENTITY, which is watched and NOT pictured"
pass "and none for $WITHHELD_IDENTITY — watched, recorded, and never photographed"

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
CAPTURE_URL="file://$CACHE_DIR/$EXPECTED_FILE"
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
if ! poll 40 cache_is 1; then
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
if ! poll 40 cache_is 1; then
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
if ! poll 40 changed; then
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
if ! poll 40 cache_is 1; then
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

# ----------------------------------------------------- 10. FORGET deletes

# Put the pictures back first, so forgetting has something to delete: a forget
# over an empty cache would pass this on a plugin that never deletes anything.
final_record=$(omarchy-shell "$IPC_TARGET" record 2>&1)
[[ $final_record == "recorded" ]] || fail "panel IPC records before the forget (captures)" "record answered '$final_record'"
if ! poll 40 cache_is 1; then
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

# --------------------------------------------------------- 11. leave it closed

omarchy-shell shell hide "$PLUGIN_ID" >/dev/null 2>&1
if ! poll 20 panel_layer_absent; then
  diagnostics
  fail "panel dismissed (captures)" "the panel's layer '$PANEL_NAMESPACE' is still mapped"
fi
pass "panel dismissed; the desk is back for the tests after this one"

capture_service_log
pass "dock-recall captures: stored per consent, keyed, overwritten, evicted, and never able to fail a record"
