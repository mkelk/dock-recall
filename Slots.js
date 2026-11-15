// Slots.js — the translator between a recorded placement and a live workspace.
//
// Omarchy 4.5 gives every monitor its own block of ten workspaces: the monitor
// that owns block B shows workspaces B*10+1 .. B*10+10, and Super+N means "slot
// N of the focused monitor's block". Which monitor owns which block is decided
// by Hyprland's own config (default/hypr/monitor-workspaces.lua) and kept in
// two files under $XDG_STATE_HOME/omarchy/:
//
//   monitor-workspaces          <block> TAB <connector> TAB <identity>
//                               one row per monitor ever seen; the connector
//                               is empty for a monitor not plugged in now
//   monitor-workspaces-merged   <id> TAB <originalId> TAB <identity>
//                               a workspace that joined another monitor's
//                               block while its own monitor was unplugged
//
// A recorded placement (schema v8) therefore stores the monitor and the SLOT,
// never a live workspace id: the id a slot maps to depends on which block the
// monitor was handed, and that can differ between sessions. This module is the
// only place the two are converted. engine.js and PanelModel.js keep working on
// live ids, over a layout this module has RESOLVED.
//
// Resolution mirrors the lua and the bar's Workspaces.qml exactly: a live
// monitor finds its row by connector, and the row counts only if its identity,
// minus a twin's " #N" suffix, is the monitor's description (or its name, when
// the description is empty). No valid row means the monitor is not placed yet
// — 4.5 re-sorts asynchronously after a hotplug — and the answer is
// `unplaceable`, never a guess. Two monitor reasons, kept apart on purpose:
//
//   monitor-unassigned  the monitor IS plugged in (listed, enabled, not a
//                       mirror) but its connector has no valid row yet.
//                       Transient: the reconcile gate waits it out.
//   monitor-unknown     the monitor is NOT plugged in and its identity is not
//                       in the blocks file at all. Nothing will change by
//                       waiting.
//
// A monitor that is not plugged in but whose identity the file knows resolves
// through that identity's last block, for display only.
//
// Dual-runtime like engine.js: ES5, plain top-level functions, no require, no
// `.pragma`, and `module.exports` behind a guard. QML imports it as
// `import "Slots.js" as Slots`. Pure: no I/O, no clock — the file texts and the
// hyprctl reads are passed in.

var SLOTS = 10;

function isWholeNumber(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function own(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

// Workspace id -> block (lua block_of_id). null for anything that is not a
// regular workspace id: 0, negatives (special workspaces), fractions, strings.
function blockOf(id) {
  if (!isWholeNumber(id) || id < 1) return null;
  return Math.floor((id - 1) / SLOTS);
}

// Workspace id -> slot 1..10 within its block. null likewise.
function slotOf(id) {
  if (!isWholeNumber(id) || id < 1) return null;
  return ((id - 1) % SLOTS) + 1;
}

// (block, slot) -> workspace id. null unless block >= 0 and 1 <= slot <= 10.
function workspaceIdFor(block, slot) {
  if (!isWholeNumber(block) || block < 0) return null;
  if (!isWholeNumber(slot) || slot < 1 || slot > SLOTS) return null;
  return block * SLOTS + slot;
}

// The label a monitor is recorded under. MUST equal engine.monitorLabel
// (tests/slots.test.js pins it): the two files may not import each other.
// It is also the lua's `described()` — description, else connector name — which
// is what an identity in the blocks file carries before any " #N" suffix.
function monitorIdentityLabel(monitor) {
  if (!monitor) return "";
  var description = (monitor.description || "").trim();
  if (description) return description;
  return (monitor.name || "").trim();
}

// Lines of a file read by FileView or cat. Split on "\n", as the lua's
// file:lines() does, with a trailing "\r" stripped so a file that went through
// a CRLF editor does not turn every identity stale.
function linesOf(text) {
  if (text === null || text === undefined || text === "") return [];
  var lines = String(text).split("\n");
  for (var i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, "");
  return lines;
}

// The blocks file (lua load_blocks). A line that does not match the grammar is
// dropped. `rows` is RAW: every matching line in file order, superseded
// duplicates included. `byConnector` and `byIdentity` are last-wins, as the
// lua's tables are, and they are what resolution reads. An empty connector
// means "known, not plugged in": the row keeps its block in byIdentity but is
// not in byConnector.
function parseBlocks(text) {
  var table = { rows: [], byConnector: {}, byIdentity: {} };
  var lines = linesOf(text);
  for (var i = 0; i < lines.length; i++) {
    var match = /^(\d+)\t([^\t]*)\t(.+)$/.exec(lines[i]);
    if (!match) continue;
    var row = { block: parseInt(match[1], 10), connector: match[2], identity: match[3] };
    table.rows.push(row);
    table.byIdentity[row.identity] = row.block;
    if (row.connector !== "") table.byConnector[row.connector] = row;
  }
  return table;
}

// The merged file (lua load_merged): one entry per workspace id, a later line
// for the same id replacing the earlier one, in ascending id order.
function parseMerged(text) {
  var byId = {};
  var ids = [];
  var lines = linesOf(text);
  for (var i = 0; i < lines.length; i++) {
    var match = /^(\d+)\t(\d+)\t(.+)$/.exec(lines[i]);
    if (!match) continue;
    var id = parseInt(match[1], 10);
    if (own(byId, String(id)) === undefined) ids.push(id);
    byId[String(id)] = { id: id, originalId: parseInt(match[2], 10), identity: match[3] };
  }
  ids.sort(function (a, b) { return a - b; });
  var out = [];
  for (var j = 0; j < ids.length; j++) out.push(byId[String(ids[j])]);
  return out;
}

// The block a LIVE monitor owns, or null when its connector's row is missing or
// stale. Stale means the connector is now driven by a different monitor than
// the row names (lua identities_of, line 189): until 4.5 rewrites the file the
// row says nothing about this monitor. A twin's row carries "D #2"; the suffix
// is dropped before comparing, so each twin is accepted for its own connector.
// The lua compares against the UNTRIMMED description (its described()), so a
// row is accepted against either that raw form or the trimmed label.
function blockForMonitor(table, monitor) {
  if (!table || !monitor) return null;
  var row = own(table.byConnector, monitor.name);
  if (!row) return null;
  var stripped = row.identity.replace(/ #\d+$/, "");
  var raw = monitor.description ? monitor.description : monitor.name;
  if (stripped !== monitorIdentityLabel(monitor) && stripped !== raw) return null;
  return { block: row.block, identity: row.identity };
}

// The block an identity was last given, exact match. For a monitor that is not
// plugged in: what its slots WOULD map to, for display only.
function blockForIdentity(table, identity) {
  if (!table || typeof identity !== "string") return null;
  var block = own(table.byIdentity, identity);
  return block === undefined ? null : block;
}

// A monitor that shows its own workspaces: listed, not disabled (a clamshell
// panel stays in `monitors all` with disabled: true) and not mirroring another
// output. Anything else counts as not plugged in.
function isLiveMonitor(monitor) {
  if (!monitor || monitor.disabled === true) return false;
  var mirror = monitor.mirrorOf;
  return mirror === undefined || mirror === null || mirror === "" || mirror === "none";
}

// Connector -> block for every live monitor whose row blockForMonitor accepts.
// A stale or missing row leaves the connector absent: the map then falls back
// to what it knows without the table.
function blocksByConnector(table, monitors) {
  var out = {};
  var list = monitors || [];
  for (var i = 0; i < list.length; i++) {
    if (!isLiveMonitor(list[i])) continue;
    var found = blockForMonitor(table, list[i]);
    if (found) out[list[i].name] = found.block;
  }
  return out;
}

// Every live monitor recorded under this label, in list order. More than one
// means twins; the first is the one engine.monitorByDescription answers with.
function liveMonitorsFor(monitors, description) {
  var wanted = (description || "").trim();
  var found = [];
  if (!wanted) return found;
  var list = monitors || [];
  for (var i = 0; i < list.length; i++) {
    if (isLiveMonitor(list[i]) && monitorIdentityLabel(list[i]) === wanted) found.push(list[i]);
  }
  return found;
}

// How a recorded monitor label resolves now:
//   { live: true,  block }  plugged in; block is the FIRST twin's valid block,
//                           or null when its row is missing or stale
//   { live: false, block }  not plugged in; block is its identity's last block,
//                           or null when the file has never seen it
function resolveDescription(table, monitors, description) {
  var live = liveMonitorsFor(monitors, description);
  if (live.length) {
    var found = blockForMonitor(table, live[0]);
    return { live: true, block: found ? found.block : null };
  }
  return { live: false, block: blockForIdentity(table, description) };
}

// The block a recorded monitor maps to now: through its live row when it is
// plugged in, through its identity's last block when it is not. null when
// neither is known.
function blockForDescription(table, monitors, description) {
  return resolveDescription(table, monitors, description).block;
}

function copyFields(source) {
  var out = {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

function isSlot(slot) {
  return isWholeNumber(slot) && slot >= 1 && slot <= SLOTS;
}

// Recorded (v8) layout -> resolved layout, in memory only. Every placement
// keeps its fields and gains:
//   workspaceId  the live id its slot maps to, or null
//   unplaceable  null | "monitor-unassigned" | "monitor-unknown" | "slot-unknown"
//     monitor-unassigned  the monitor is plugged in but has no valid row yet.
//                         TRANSIENT: 4.5 is still re-sorting; the reconcile
//                         gate waits on it.
//     monitor-unknown     the monitor is not plugged in and the blocks file
//                         has never seen its identity. Nothing to wait for.
//     slot-unknown        the record carries no usable slot.
// The monitor reasons are reported ahead of slot-unknown; either way nothing
// is placed. A monitor that is not plugged in but whose identity is known
// resolves through that identity's last block, for display: restore skips it
// for being absent. Twins resolve to the first twin (the documented refusal).
// Falsy app entries are dropped.
function toLive(layout, table, monitors) {
  if (!layout || typeof layout !== "object") return layout;
  var out = copyFields(layout);
  var apps = [];
  var source = layout.apps || [];
  for (var i = 0; i < source.length; i++) {
    if (!source[i]) continue;
    var app = copyFields(source[i]);
    var where = resolveDescription(table, monitors, app.monitorDescription);
    app.workspaceId = null;
    app.unplaceable = null;
    if (where.block === null) app.unplaceable = where.live ? "monitor-unassigned" : "monitor-unknown";
    else if (!isSlot(app.slot)) app.unplaceable = "slot-unknown";
    else app.workspaceId = workspaceIdFor(where.block, app.slot);
    apps.push(app);
  }
  out.apps = apps;
  return out;
}

// Every block the recorded monitor label could own now: each live twin's valid
// block, or the identity's last block when none is plugged in.
function blocksForDescription(table, monitors, description) {
  var live = liveMonitorsFor(monitors, description);
  var blocks = [];
  if (!live.length) {
    var known = blockForIdentity(table, description);
    if (known !== null) blocks.push(known);
    return blocks;
  }
  for (var i = 0; i < live.length; i++) {
    var found = blockForMonitor(table, live[i]);
    if (found) blocks.push(found.block);
  }
  return blocks;
}

// Live layout (engine.buildLayout, live workspace ids) -> recorded v8 layout.
// Each placement keeps its fields, loses workspaceId (and any unplaceable), and
// gains `slot`. An app sitting on another block's workspace — a guest, e.g.
// workspace 13 shown on the monitor that owns block 0 — is excluded rather than
// recorded: its slot would land it on its own monitor's slot 3 next time, which
// is not where it was. Twins share a label, so a workspace in ANY twin's block
// is not a guest. With no block known there is no guest check. Falsy app
// entries are dropped.
function toRecorded(liveLayout, table, monitors) {
  if (!liveLayout || typeof liveLayout !== "object") return { layout: liveLayout, excluded: [] };
  var out = copyFields(liveLayout);
  var apps = [];
  var excluded = [];
  var source = liveLayout.apps || [];
  for (var i = 0; i < source.length; i++) {
    var live = source[i];
    if (!live) continue;
    var workspaceId = live.workspaceId;
    var blocks = blocksForDescription(table, monitors, live.monitorDescription);
    var ownBlock = blockOf(workspaceId);
    if (blocks.length && ownBlock !== null && blocks.indexOf(ownBlock) < 0) {
      excluded.push({
        identityId: live.identityId,
        occurrence: live.occurrence,
        reason: "workspace-guest",
        workspaceId: workspaceId,
        monitorDescription: live.monitorDescription
      });
      continue;
    }
    var app = copyFields(live);
    delete app.workspaceId;
    delete app.unplaceable;
    app.slot = slotOf(workspaceId);
    apps.push(app);
  }
  out.apps = apps;
  return { layout: out, excluded: excluded };
}

// Live workspace id -> the connector showing it, for every regular workspace
// that exists: those with windows (from the clients' monitor index) and those
// a monitor is showing while empty (its activeWorkspace). A monitor's
// activeWorkspace is applied last and wins a conflict. Keys are strings.
function workspaceMonitors(clients, monitors) {
  var out = {};
  var monitorList = monitors || [];
  var byId = {};
  for (var m = 0; m < monitorList.length; m++) {
    if (monitorList[m] && monitorList[m].id !== undefined) byId[String(monitorList[m].id)] = monitorList[m];
  }
  var clientList = clients || [];
  for (var c = 0; c < clientList.length; c++) {
    var client = clientList[c];
    var ws = client && client.workspace ? client.workspace.id : null;
    if (!isWholeNumber(ws) || ws < 1) continue;
    var monitor = client.monitor === null || client.monitor === undefined ? undefined : own(byId, String(client.monitor));
    if (monitor && monitor.name) out[String(ws)] = monitor.name;
  }
  for (var a = 0; a < monitorList.length; a++) {
    var mon = monitorList[a];
    var active = mon && mon.activeWorkspace ? mon.activeWorkspace.id : null;
    if (isWholeNumber(active) && active >= 1 && mon.name) out[String(active)] = mon.name;
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = {
    SLOTS: SLOTS,
    blockOf: blockOf,
    slotOf: slotOf,
    workspaceIdFor: workspaceIdFor,
    monitorIdentityLabel: monitorIdentityLabel,
    parseBlocks: parseBlocks,
    parseMerged: parseMerged,
    blockForMonitor: blockForMonitor,
    blockForIdentity: blockForIdentity,
    blockForDescription: blockForDescription,
    isLiveMonitor: isLiveMonitor,
    blocksByConnector: blocksByConnector,
    toLive: toLive,
    toRecorded: toRecorded,
    workspaceMonitors: workspaceMonitors
  };
}
