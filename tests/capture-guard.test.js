// The capture guard: no picture is ever taken of a pinned window, or of a
// window whose monitor Hyprland no longer lists.
//
// Hyprland 0.56.2 segfaults in CScreenshareSession::init() on a toplevel-export
// capture of a window whose monitor is dead, and a pinned window on an unplugged
// output is exactly that (moveWorkspaceToMonitor skips pinned windows, and
// hyprctl then reports "monitor": -1). Both capture rounds make that request
// through a ScreencopyView, so both plans refuse such a window, and both stores
// ask again over a fresh hyprctl read at the grab.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../engine.js");
const panel = require("../PanelModel.js");
const { loadFixture, makeClient } = require("./helpers.js");

const monitorsLaptop = loadFixture("monitors-laptop.json");
const AT = "2026-11-15T12:00:00.000Z";

// Two monitors, as a docked desk has them: the laptop panel (id 0) and an
// external (id 1).
const DOCKED = [
  { id: 0, name: "eDP-1", disabled: false },
  { id: 1, name: "DP-1", disabled: false }
];
// The same desk after the external was unplugged.
const UNDOCKED = [DOCKED[0]];

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", name), "utf8");
}

function bodyOf(text, signature) {
  const at = text.indexOf(signature);
  assert.ok(at !== -1, "missing: " + signature);
  return text.slice(at, text.indexOf("\n  }\n", at));
}

// ---------------------------------------------------------------- the rule

test("a window on a live monitor is safe to capture", () => {
  const client = makeClient({ address: "0xaa", monitor: 1 });
  assert.strictEqual(panel.captureGuardReason(client, DOCKED), "");
});

test("a PINNED window is never captured, even on a live monitor", () => {
  // The undock that kills its monitor lands before monitorremoved, so "its
  // monitor is alive right now" is not a promise about the grab.
  const client = makeClient({ address: "0xaa", monitor: 0, pinned: true });
  assert.strictEqual(panel.captureGuardReason(client, DOCKED), "pinned");
  // Only the literal true is pinned: hyprctl prints a boolean.
  for (const junk of [false, undefined, null, 0, "true"]) {
    assert.strictEqual(panel.captureGuardReason(
      makeClient({ address: "0xaa", monitor: 0, pinned: junk }), DOCKED), "", String(junk));
  }
});

test("a window whose monitor is gone is never captured", () => {
  // What hyprctl showed in the VM for the pinned window after the DRM unplug.
  assert.strictEqual(panel.captureGuardReason(
    makeClient({ address: "0xaa", monitor: -1 }), UNDOCKED), "no-monitor");
  // A monitor id the current list no longer has.
  assert.strictEqual(panel.captureGuardReason(
    makeClient({ address: "0xaa", monitor: 1 }), UNDOCKED), "no-monitor");
  // No monitor field at all, or one that is not a number.
  for (const junk of [undefined, null, "1", NaN]) {
    assert.strictEqual(panel.captureGuardReason(
      makeClient({ address: "0xaa", monitor: junk }), DOCKED), "no-monitor", String(junk));
  }
});

test("without a monitor list, every window is refused rather than guessed at", () => {
  const client = makeClient({ address: "0xaa", monitor: 0 });
  for (const junk of [undefined, null, {}, "[]"]) {
    assert.strictEqual(panel.captureGuardReason(client, junk), "no-monitor", String(junk));
  }
  assert.strictEqual(panel.captureGuardReason(client, []), "no-monitor");
});

test("no client is the caller's gap, named as such", () => {
  assert.strictEqual(panel.captureGuardReason(null, DOCKED), "no-window");
  assert.strictEqual(panel.captureGuardReason({ monitor: 0 }, DOCKED), "no-window");
});

// ---------------------------------------------------------- the Record plan

function guardDesk(monitors) {
  const identities = [{ id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" }];
  const clients = [
    makeClient({ address: "0xa1", class: "foot", workspace: 1, monitor: 0, at: [0, 0] }),
    makeClient({ address: "0xa2", class: "foot", workspace: 1, monitor: 0, at: [900, 0] }),
    makeClient({ address: "0xa3", class: "foot", workspace: 1, monitor: 0, at: [400, 400] })
  ];
  return { identities, clients, monitors };
}

test("the Record plan skips a pinned window and a monitor-less one, each with its reason", () => {
  const desk = guardDesk(monitorsLaptop);
  const layout = engine.buildLayout(desk.clients, monitorsLaptop, desk.identities, AT);
  const chosen = engine.chosenWindows(desk.clients, desk.identities, monitorsLaptop);
  // The desk changes under the index: one window is pinned, one loses its
  // monitor. `chosen` carries the same client objects, which is what the guard
  // reads.
  const byAddress = {};
  for (const c of chosen.byId.terminal) byAddress[c.address] = c;
  byAddress["0xa2"].pinned = true;
  byAddress["0xa3"].monitor = -1;

  const plan = panel.capturePlan(layout, desk.identities, chosen, true, monitorsLaptop);
  assert.deepStrictEqual(plan.captures.map((c) => c.address), ["0xa1"]);
  const skipped = {};
  for (const s of plan.skipped) skipped[chosen.byId.terminal[s.occurrence].address] = s.reason;
  assert.deepStrictEqual(skipped, { "0xa2": "pinned", "0xa3": "no-monitor" });

  // And the skips are a fact about the DESK, named in the log line, not folded
  // into "not pictured".
  const line = panel.captureLogLine(plan, [{ ok: true, reason: "" }]);
  assert.ok(line.indexOf("1 picture(s) stored") === 0, line);
  // The reasons follow the layout's order, which is placement order.
  assert.match(line, /2 not captured to keep Hyprland up \((pinned, no-monitor|no-monitor, pinned)\)/);
  assert.strictEqual(line.indexOf("not pictured"), -1, line);
});

test("the Record plan refuses every window when it has no monitor list", () => {
  const desk = guardDesk(monitorsLaptop);
  const layout = engine.buildLayout(desk.clients, monitorsLaptop, desk.identities, AT);
  const chosen = engine.chosenWindows(desk.clients, desk.identities, monitorsLaptop);
  const plan = panel.capturePlan(layout, desk.identities, chosen, true);
  assert.deepStrictEqual(plan.captures, []);
  assert.ok(plan.skipped.length === 3 && plan.skipped.every((s) => s.reason === "no-monitor"),
    JSON.stringify(plan.skipped));
});

// ---------------------------------------------------------- the live plan

function liveGuardDesk() {
  return {
    instances: {
      byAddress: {
        "0xaa": { identityId: "terminal", occurrence: 0 },
        "0xbb": { identityId: "terminal", occurrence: 1 },
        "0xcc": { identityId: "terminal", occurrence: 2 },
        "0xdd": { identityId: "terminal", occurrence: 3 }
      }
    },
    identities: [{ id: "terminal" }],
    clients: [
      makeClient({ address: "0xaa", monitor: 0 }),
      makeClient({ address: "0xbb", monitor: 1, pinned: true }),
      makeClient({ address: "0xcc", monitor: -1 })
      // 0xdd is in the index but not in the client list
    ]
  };
}

test("the live plan skips a pinned window and a monitor-less one, each with its reason", () => {
  const desk = liveGuardDesk();
  const plan = panel.liveCapturePlan(desk.instances, desk.identities, true, desk.clients, DOCKED);
  assert.deepStrictEqual(plan.captures, [{ address: "0xaa", identityId: "terminal", occurrence: 0 }]);
  assert.deepStrictEqual(plan.skipped.map((s) => [s.address, s.reason]),
    [["0xbb", "pinned"], ["0xcc", "no-monitor"], ["0xdd", "no-window"]]);

  const line = panel.liveCaptureLogLine(plan, [{ ok: true, reason: "" }]);
  assert.ok(line.indexOf("2 not captured to keep Hyprland up (pinned, no-monitor)") !== -1, line);
  assert.ok(line.indexOf("1 not pictured") !== -1, line);
});

test("the live plan after an undock: the external's id is gone, so its windows are too", () => {
  const desk = liveGuardDesk();
  desk.clients[1].pinned = false;  // a plain window still claiming monitor 1
  const plan = panel.liveCapturePlan(desk.instances, desk.identities, true, desk.clients, UNDOCKED);
  assert.deepStrictEqual(plan.captures.map((c) => c.address), ["0xaa"]);
  assert.strictEqual(plan.skipped.find((s) => s.address === "0xbb").reason, "no-monitor");
});

test("the live plan matches its client by address in any spelling hyprctl uses", () => {
  const plan = panel.liveCapturePlan(
    { byAddress: { "0xAA": { identityId: "terminal", occurrence: 0 } } },
    [{ id: "terminal" }], true, [makeClient({ address: "0x00aa", monitor: 0 })], DOCKED);
  assert.strictEqual(plan.captures.length, 1, JSON.stringify(plan));
});

test("with pictures off the live plan still says pictures-off, not a guard reason", () => {
  const desk = liveGuardDesk();
  const plan = panel.liveCapturePlan(desk.instances, desk.identities, false, desk.clients, DOCKED);
  assert.ok(plan.skipped.every((s) => s.reason === "pictures-off"), JSON.stringify(plan.skipped));
});

// ------------------------------------------------------- the grab-time check

test("the grab-time check refuses a window that became PINNED after planning", () => {
  const planned = panel.liveCapturePlan(
    { byAddress: { "0xaa": { identityId: "terminal", occurrence: 0 } } },
    [{ id: "terminal" }], true, [makeClient({ address: "0xaa", monitor: 1 })], DOCKED);
  assert.strictEqual(planned.captures.length, 1, "the plan was fine when it was made");

  const fresh = [makeClient({ address: "0xaa", monitor: 1, pinned: true })];
  assert.deepStrictEqual(panel.captureGrabCheck(fresh, DOCKED, "0xaa"),
    { ok: false, reason: "pinned" });
});

test("the grab-time check refuses a window that LOST ITS MONITOR after planning", () => {
  // The undock: the external is gone from the fresh monitor list, and the
  // pinned-or-not window that was on it reports -1.
  assert.deepStrictEqual(
    panel.captureGrabCheck([makeClient({ address: "0xaa", monitor: -1 })], UNDOCKED, "0xaa"),
    { ok: false, reason: "no-monitor" });
  // Or still names the id the fresh list no longer has.
  assert.deepStrictEqual(
    panel.captureGrabCheck([makeClient({ address: "0xaa", monitor: 1 })], UNDOCKED, "0xaa"),
    { ok: false, reason: "no-monitor" });
});

test("the grab-time check lets a healthy window through, in any address spelling", () => {
  const fresh = [makeClient({ address: "0x0000aBc", monitor: 0 })];
  assert.deepStrictEqual(panel.captureGrabCheck(fresh, DOCKED, "0xabc"), { ok: true, reason: "" });
});

test("the grab-time check refuses a closed window and a failed read", () => {
  assert.deepStrictEqual(panel.captureGrabCheck([], DOCKED, "0xaa"),
    { ok: false, reason: "no-window" });
  assert.deepStrictEqual(panel.captureGrabCheck([makeClient({ address: "0xaa" })], DOCKED, ""),
    { ok: false, reason: "no-window" });
  // A read that failed is not "probably still fine": the grab is the step that
  // can take the compositor down.
  for (const [clients, monitors] of [[null, DOCKED], [[], null], [undefined, undefined]]) {
    assert.deepStrictEqual(panel.captureGrabCheck(clients, monitors, "0xaa"),
      { ok: false, reason: "recheck-failed" });
  }
});

// ------------------------------------------------- the QML that wires it in

test("both stores re-check every window over a fresh read before its view exists", () => {
  for (const [file, obj] of [["LiveCaptureStore.qml", "liveStore"], ["CaptureStore.qml", "store"]]) {
    const text = source(file);
    const next = bodyOf(text, "function _next()");
    // The view is not built in _next any more; it is built only from the
    // guard's answer, and only when that answer is yes.
    assert.strictEqual(next.indexOf("createObject("), -1, file + ": _next builds a view directly");
    const recheckAt = next.indexOf("bridge.recheck(entry.address, function (verdict) {");
    assert.ok(recheckAt !== -1, file + ": _next no longer asks the guard:\n" + next);
    const answer = next.slice(recheckAt);
    assert.ok(answer.indexOf("if (!" + obj + "._isCurrentStep(step)) return") !== -1,
      file + ": a late guard answer is not checked against the step token");
    assert.ok(answer.indexOf("verdict.ok !== true") < answer.indexOf(obj + "._createView(step, handle)"),
      file + ": the view is created before the guard's refusal is handled");
    assert.ok(answer.indexOf(obj + "._settle(step, false, verdict ? verdict.reason : \"recheck-failed\")")
      !== -1, file + ": a refused window does not settle with the guard's reason");

    const view = bodyOf(text, "function _createView(step, handle)");
    assert.ok(view.indexOf("createObject(stage, { captureSource: handle, step: step })") !== -1, view);
    // And nothing else in the file assigns a capture source.
    assert.strictEqual(text.split("captureSource: handle").length - 1, 1,
      file + ": a second place hands a ScreencopyView its source");
  }
});

test("the bridge's re-check reads hyprctl afresh and asks the pure check", () => {
  const text = source("ToplevelBridge.qml");
  assert.ok(text.indexOf('command: ["hyprctl", "clients", "-j"]') !== -1);
  assert.ok(text.indexOf('command: ["hyprctl", "monitors", "all", "-j"]') !== -1);
  assert.ok(text.indexOf("PanelModel.captureGrabCheck(clients, monitors, address)") !== -1);
  // A failed clients read answers with nulls, which captureGrabCheck refuses.
  assert.ok(text.indexOf("bridge._answerRecheck(null, null)") !== -1);
});

test("the panel hands both plans the lists the guard judges by", () => {
  const text = source("Panel.qml");
  assert.ok(text.indexOf("root.instanceIndex, root.identities, root.picturesOn, root.liveClients,"
    + " root.liveMonitors") !== -1, "the live plan is not given the client and monitor reads");
  const after = bodyOf(text, "function captureAfterRecord(layout, chosen)");
  assert.ok(after.indexOf("PanelModel.capturePlan(layout, root.identities, chosen, root.picturesOn,\n"
    + "      root.liveMonitors)") !== -1, "the Record plan is not given the monitor list:\n" + after);
});
