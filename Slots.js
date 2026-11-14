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
// `unplaceable`, never a guess.
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

// Lines of a file read by FileView or cat. Split on "\n" only, as the lua's
// file:lines() does.
function linesOf(text) {
  if (text === null || text === undefined || text === "") return [];
  return String(text).split("\n");
}

// The blocks file (lua load_blocks). A line that does not match the grammar is
// dropped. A later row for the same identity or connector wins, as it does in
// the lua's tables. An empty connector means "known, not plugged in": the row
// keeps its block in byIdentity but is not in byConnector.
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
function blockForMonitor(table, monitor) {
  if (!table || !monitor) return null;
  var row = own(table.byConnector, monitor.name);
  if (!row) return null;
  if (row.identity.replace(/ #\d+$/, "") !== monitorIdentityLabel(monitor)) return null;
  return { block: row.block, identity: row.identity };
}

// The block an identity was last given, exact match. For a monitor that is not
// plugged in: what its slots WOULD map to, for display only.
function blockForIdentity(table, identity) {
  if (!table || typeof identity !== "string") return null;
  var block = own(table.byIdentity, identity);
  return block === undefined ? null : block;
}

// The first live monitor recorded under this label (engine.monitorByDescription
// — twins resolve to the first, the documented refusal).
function liveMonitorFor(monitors, description) {
  var wanted = (description || "").trim();
  if (!wanted) return null;
  var list = monitors || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && monitorIdentityLabel(list[i]) === wanted) return list[i];
  }
  return null;
}

// The block a recorded monitor maps to now: through its live row when it is
// plugged in, through its identity's last block when it is not. null when
// neither is known.
function blockForDescription(table, monitors, description) {
  var monitor = liveMonitorFor(monitors, description);
  if (monitor) {
    var found = blockForMonitor(table, monitor);
    return found ? found.block : null;
  }
  return blockForIdentity(table, description);
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
//   unplaceable  null | "monitor-unassigned" | "slot-unknown"
// "monitor-unassigned" (the monitor's block is not known — no valid row) is
// reported ahead of "slot-unknown" (the record carries no usable slot): the
// first is transient and worth waiting out, and either way nothing is placed.
// A monitor that is not plugged in resolves through its identity's last block
// so the panel can show where it would go; restore skips it for being absent.
function toLive(layout, table, monitors) {
  if (!layout || typeof layout !== "object") return layout;
  var out = copyFields(layout);
  var apps = [];
  var source = layout.apps || [];
  for (var i = 0; i < source.length; i++) {
    var app = copyFields(source[i]);
    var block = blockForDescription(table, monitors, app.monitorDescription);
    app.workspaceId = null;
    app.unplaceable = null;
    if (block === null) app.unplaceable = "monitor-unassigned";
    else if (!isSlot(app.slot)) app.unplaceable = "slot-unknown";
    else app.workspaceId = workspaceIdFor(block, app.slot);
    apps.push(app);
  }
  out.apps = apps;
  return out;
}

// Live layout (engine.buildLayout, live workspace ids) -> recorded v8 layout.
// Each placement keeps its fields, loses workspaceId (and any unplaceable), and
// gains `slot`. An app sitting on another block's workspace — a guest, e.g.
// workspace 13 shown on the monitor that owns block 0 — is excluded rather than
// recorded: its slot would land it on its own monitor's slot 3 next time, which
// is not where it was. With its monitor's block unknown there is no guest check.
function toRecorded(liveLayout, table, monitors) {
  if (!liveLayout || typeof liveLayout !== "object") return { layout: liveLayout, excluded: [] };
  var out = copyFields(liveLayout);
  var apps = [];
  var excluded = [];
  var source = liveLayout.apps || [];
  for (var i = 0; i < source.length; i++) {
    var live = source[i];
    var workspaceId = live.workspaceId;
    var block = blockForDescription(table, monitors, live.monitorDescription);
    var ownBlock = blockOf(workspaceId);
    if (block !== null && ownBlock !== null && ownBlock !== block) {
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
// a monitor is showing while empty (its activeWorkspace). Keys are strings.
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
    toLive: toLive,
    toRecorded: toRecorded,
    workspaceMonitors: workspaceMonitors
  };
}
