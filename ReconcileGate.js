// ReconcileGate.js — when is it safe to act after a monitor hotplug?
//
// Omarchy 4.5 re-sorts workspaces asynchronously after a hotplug: the lua
// defers monitor removal by a second, rewrites the blocks file, and only then
// restores merged workspaces (restore(), lua 582-617) and places strays
// (place(), 565-578). Acting before that finishes moves windows to the wrong
// block. This module decides "ready" from plain data; the Service supplies the
// clock, the raw event names and the parsed tables.
//
// Ready needs ALL of: the hold after the last monitor event has elapsed, no
// pending reason, and the signature (clients + monitors + both files) equal on
// two checks at least STABLE_MS apart, counted from the end of the hold.
// MAX_WAIT_MS after the first touch the gate gives up: timedOut, never ready.
// The clock starts at a monitor/config event (a hold) or at the first check;
// a bare workspace event is only a stability reset and never starts it.
// Exception, decided by the human 2026-11-14 ("restore the rest"): when the
// timeout is ONLY workspace-off-owner and no hold event (monitor add/remove,
// config reload) arrived in the episode, the answer carries planAnyway: the
// planner's per-app workspace-elsewhere refusal skips the affected apps and the
// rest restore.
//
// A gate is a plain object; every function returns a new one. A gate that
// answered ready or timed out comes back fresh, ready for the next episode.
//
// Dual-runtime: ES5, no require, guarded module.exports. Slots.js cannot be
// imported from here in QML, so the two small rules shared with it
// (isLiveMonitor, blockForMonitor) are mirrored below and pinned equal to
// Slots.js by tests/reconcile-gate.test.js.

var HOLD_AFTER_REMOVE_MS = 1500;
var HOLD_AFTER_OTHER_MS = 300;
var STABLE_MS = 400;
var MAX_WAIT_MS = 15000;

function gateOwn(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function gateLabel(monitor) {
  if (!monitor) return "";
  var description = (monitor.description || "").trim();
  return description ? description : (monitor.name || "").trim();
}

function gateIsLive(monitor) {
  if (!monitor || monitor.disabled === true) return false;
  var mirror = monitor.mirrorOf;
  return mirror === undefined || mirror === null || mirror === "" || mirror === "none";
}

function gateBlock(table, monitor) {
  if (!table || !monitor) return null;
  var row = gateOwn(table.byConnector, monitor.name);
  if (!row) return null;
  var stripped = row.identity.replace(/ #\d+$/, "");
  var raw = monitor.description ? monitor.description : monitor.name;
  if (stripped !== gateLabel(monitor) && stripped !== raw) return null;
  return row.block;
}

function create() {
  return { startMs: null, holdUntil: 0, sig: null, sigSince: 0, sigChecks: 0, holdSeen: false };
}

function copyGate(gate) {
  var g = gate || create();
  return { startMs: g.startMs, holdUntil: g.holdUntil, sig: g.sig, sigSince: g.sigSince, sigChecks: g.sigChecks, holdSeen: g.holdSeen === true };
}

// Strip the "v2" suffix and any ">>data" tail: "monitorremovedv2>>1,DP-1".
function eventKind(raw) {
  var name = String(raw || "").split(">>")[0];
  return name.replace(/v2$/, "");
}

function onEvent(gate, rawEventName, nowMs) {
  var g = copyGate(gate);
  var kind = eventKind(rawEventName);
  var hold = 0;
  if (kind === "monitorremoved") hold = HOLD_AFTER_REMOVE_MS;
  else if (kind === "monitoradded" || kind === "configreloaded") hold = HOLD_AFTER_OTHER_MS;
  var stability = kind === "moveworkspace" || kind === "changeworkspaceid" ||
    kind === "createworkspace" || kind === "destroyworkspace";
  if (!hold && !stability) return g;
  // Only a hold starts the clock: a stray workspace event with no wait in
  // progress must not age a later wait into an instant timeout.
  if (hold && g.startMs === null) g.startMs = nowMs;
  if (hold) g.holdSeen = true;
  if (hold && nowMs + hold > g.holdUntil) g.holdUntil = nowMs + hold;
  g.sig = null;
  g.sigSince = 0;
  g.sigChecks = 0;
  return g;
}

function signature(clients, monitors, blocksText, mergedText) {
  var parts = [];
  var cl = clients || [];
  for (var i = 0; i < cl.length; i++) {
    var c = cl[i] || {};
    parts.push([c.address, c.workspace ? c.workspace.id : "", c.monitor].join("|"));
  }
  parts.sort();
  var ml = monitors || [];
  var mon = [];
  for (var j = 0; j < ml.length; j++) {
    var m = ml[j] || {};
    mon.push([m.id, m.name, m.description, m.disabled === true ? "off" : "on", m.mirrorOf || "",
      m.activeWorkspace ? m.activeWorkspace.id : ""].join("|"));
  }
  mon.sort();
  return parts.join(",") + "#" + mon.join(",") + "#" + (blocksText || "") + "#" + (mergedText || "");
}

// Why the 4.5 re-sort is not finished, or null. Same inputs as Slots: parsed
// blocks table, parsed merged list, hyprctl clients and monitors.
function pending(table, merged, clients, monitors) {
  var live = [];
  var ml = monitors || [];
  var i;
  for (i = 0; i < ml.length; i++) if (gateIsLive(ml[i])) live.push(ml[i]);

  for (i = 0; i < live.length; i++) {
    if (gateBlock(table, live[i]) === null) return "monitor-unassigned";
  }

  var mr = merged || [];
  for (i = 0; i < mr.length; i++) {
    var identity = String(mr[i].identity || "").replace(/ #\d+$/, "");
    for (var k = 0; k < live.length; k++) {
      if (gateLabel(live[k]) === identity) return "merged-owner-present";
    }
  }

  return offOwnerWorkspaces(table, clients, monitors).length ? "workspace-off-owner" : null;
}

// Workspace ids (sorted, unique) holding a window whose monitor is not the
// owner of that workspace's block.
function offOwnerWorkspaces(table, clients, monitors) {
  var live = [];
  var ml = monitors || [];
  var i;
  for (i = 0; i < ml.length; i++) if (gateIsLive(ml[i])) live.push(ml[i]);
  var ownerOfBlock = {};
  for (i = 0; i < live.length; i++) {
    var b = gateBlock(table, live[i]);
    if (b !== null) ownerOfBlock[String(b)] = live[i].name;
  }
  var byId = {};
  for (i = 0; i < ml.length; i++) if (ml[i] && ml[i].id !== undefined) byId[String(ml[i].id)] = ml[i];
  var seen = {};
  var out = [];
  var cl = clients || [];
  for (i = 0; i < cl.length; i++) {
    var ws = cl[i] && cl[i].workspace ? cl[i].workspace.id : null;
    if (typeof ws !== "number" || ws < 1 || Math.floor(ws) !== ws) continue;
    var owner = gateOwn(ownerOfBlock, String(Math.floor((ws - 1) / 10)));
    if (owner === undefined) continue;
    var mon = cl[i].monitor === null || cl[i].monitor === undefined ? undefined : gateOwn(byId, String(cl[i].monitor));
    if (mon && mon.name !== owner && !seen[String(ws)]) {
      seen[String(ws)] = true;
      out.push(ws);
    }
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}

// input: { nowMs, signature, pendingReason }
function check(gate, input) {
  var g = copyGate(gate);
  var now = input.nowMs;
  if (g.startMs === null) g.startMs = now;

  if (now - g.startMs >= MAX_WAIT_MS) {
    var anyway = input.pendingReason === "workspace-off-owner" && g.holdSeen !== true;
    return { gate: create(), ready: false, waitMs: 0, reason: "timeout", timedOut: true, planAnyway: anyway };
  }
  if (now < g.holdUntil) {
    return { gate: g, ready: false, waitMs: g.holdUntil - now, reason: "hold", timedOut: false, planAnyway: false };
  }
  if (g.sig === null || g.sig !== input.signature) {
    g.sig = input.signature;
    g.sigSince = now;
    g.sigChecks = 1;
  } else {
    g.sigChecks += 1;
  }
  if (input.pendingReason) {
    g.sig = null; // stability is counted only while nothing is pending
    return { gate: g, ready: false, waitMs: STABLE_MS, reason: input.pendingReason, timedOut: false, planAnyway: false };
  }
  var held = now - g.sigSince;
  if (g.sigChecks < 2 || held < STABLE_MS) {
    return { gate: g, ready: false, waitMs: Math.max(1, STABLE_MS - held), reason: "unstable", timedOut: false, planAnyway: false };
  }
  return { gate: create(), ready: true, waitMs: 0, reason: null, timedOut: false, planAnyway: false };
}

// ------------------------------------------------- config reload: restore or not
//
// Human decision 2026-11-14, "restore only if monitors changed". Entering 4.5's
// floating mode reloads Hyprland's config (several configreloaded events), and a
// reload that started a restore cycle moved windows back and LAUNCHED recorded
// but closed apps. A reload still feeds the gate (it holds, and 4.5 may re-sort),
// but it is restore-relevant only when the monitor set, the topology key or the
// block table (monitor-workspaces) differs from the reading taken before it.
//
// reloadReading(monitors, topologyKey, blocksText) -> the comparable reading.
// The monitor set is name, description, on/off and mirror per output, sorted;
// the focused workspace is left out (it moves with every keystroke). The block
// table is compared row by row, trimmed and sorted, so a rewrite of the same
// rows in another order is no change.
function reloadReading(monitors, topologyKey, blocksText) {
  var ml = monitors || [];
  var mon = [];
  for (var i = 0; i < ml.length; i++) {
    var m = ml[i] || {};
    mon.push([m.name, m.description, m.disabled === true ? "off" : "on", m.mirrorOf || ""].join("|"));
  }
  mon.sort();
  var lines = String(blocksText || "").split("\n");
  var rows = [];
  for (var j = 0; j < lines.length; j++) {
    var row = lines[j].trim();
    if (row) rows.push(row);
  }
  rows.sort();
  return { topologyKey: String(topologyKey || ""), monitors: mon.join(","), blocks: rows.join("\n") };
}

// reloadDecision(before, after) -> { restore, reason }
//   before null: nothing was read before the reload, so "unchanged" cannot be
//   shown — restore, as every reload did before this rule (reason no-baseline).
//   after null: the reading after the reload failed — no restore (no-reading).
//   Otherwise the first difference names the reason: topology-changed,
//   monitors-changed, blocks-changed; none is { restore: false, unchanged }.
function reloadDecision(before, after) {
  if (!before) return { restore: true, reason: "no-baseline" };
  if (!after) return { restore: false, reason: "no-reading" };
  if (before.topologyKey !== after.topologyKey) return { restore: true, reason: "topology-changed" };
  if (before.monitors !== after.monitors) return { restore: true, reason: "monitors-changed" };
  if (before.blocks !== after.blocks) return { restore: true, reason: "blocks-changed" };
  return { restore: false, reason: "unchanged" };
}

if (typeof module !== "undefined") {
  module.exports = {
    HOLD_AFTER_REMOVE_MS: HOLD_AFTER_REMOVE_MS,
    HOLD_AFTER_OTHER_MS: HOLD_AFTER_OTHER_MS,
    STABLE_MS: STABLE_MS,
    MAX_WAIT_MS: MAX_WAIT_MS,
    create: create,
    onEvent: onEvent,
    signature: signature,
    pending: pending,
    offOwnerWorkspaces: offOwnerWorkspaces,
    check: check,
    reloadReading: reloadReading,
    reloadDecision: reloadDecision
  };
}
