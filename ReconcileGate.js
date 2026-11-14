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
  return { startMs: null, holdUntil: 0, sig: null, sigSince: 0, sigChecks: 0 };
}

function copyGate(gate) {
  var g = gate || create();
  return { startMs: g.startMs, holdUntil: g.holdUntil, sig: g.sig, sigSince: g.sigSince, sigChecks: g.sigChecks };
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
  if (g.startMs === null) g.startMs = nowMs;
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

  var ownerOfBlock = {};
  for (i = 0; i < live.length; i++) ownerOfBlock[String(gateBlock(table, live[i]))] = live[i].name;
  var byId = {};
  for (i = 0; i < ml.length; i++) if (ml[i] && ml[i].id !== undefined) byId[String(ml[i].id)] = ml[i];
  var cl = clients || [];
  for (i = 0; i < cl.length; i++) {
    var ws = cl[i] && cl[i].workspace ? cl[i].workspace.id : null;
    if (typeof ws !== "number" || ws < 1 || Math.floor(ws) !== ws) continue;
    var owner = gateOwn(ownerOfBlock, String(Math.floor((ws - 1) / 10)));
    if (owner === undefined) continue;
    var mon = cl[i].monitor === null || cl[i].monitor === undefined ? undefined : gateOwn(byId, String(cl[i].monitor));
    if (mon && mon.name !== owner) return "workspace-off-owner";
  }
  return null;
}

// input: { nowMs, signature, pendingReason }
function check(gate, input) {
  var g = copyGate(gate);
  var now = input.nowMs;
  if (g.startMs === null) g.startMs = now;

  if (now - g.startMs >= MAX_WAIT_MS) {
    return { gate: create(), ready: false, waitMs: 0, reason: "timeout", timedOut: true };
  }
  if (now < g.holdUntil) {
    return { gate: g, ready: false, waitMs: g.holdUntil - now, reason: "hold", timedOut: false };
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
    return { gate: g, ready: false, waitMs: STABLE_MS, reason: input.pendingReason, timedOut: false };
  }
  var held = now - g.sigSince;
  if (g.sigChecks < 2 || held < STABLE_MS) {
    return { gate: g, ready: false, waitMs: Math.max(1, STABLE_MS - held), reason: "unstable", timedOut: false };
  }
  return { gate: create(), ready: true, waitMs: 0, reason: null, timedOut: false };
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
    check: check
  };
}
