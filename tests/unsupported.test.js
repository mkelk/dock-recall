// A system without Omarchy 4.5's per-monitor workspaces is detected and
// says so — nothing restored, nothing planned, nothing recorded.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const slots = require("../Slots.js");
const state = require("../StateModel.js");
const panel = require("../PanelModel.js");

const read = function (f) { return fs.readFileSync(path.join(__dirname, "..", f), "utf8"); };
const TEXT = "Needs Omarchy 4.5 or newer";

test("the decision: either witness is enough, neither means pre-4.5", function () {
  assert.strictEqual(slots.unsupportedReason(true, true), "");
  assert.strictEqual(slots.unsupportedReason(true, false), "");
  assert.strictEqual(slots.unsupportedReason(false, true), "");
  assert.strictEqual(slots.unsupportedReason(false, false), slots.NEEDS_OMARCHY_45);
  // junk is not a witness
  assert.strictEqual(slots.unsupportedReason(undefined, "yes"), slots.NEEDS_OMARCHY_45);
});

test("the status field round-trips and defaults to supported", function () {
  assert.strictEqual(state.defaultStatus().unsupportedReason, "");
  assert.strictEqual(state.normalizeStatus({ unsupportedReason: 7 }).unsupportedReason, "");
  const merged = state.mergeStatus(state.defaultStatus(), { unsupportedReason: slots.NEEDS_OMARCHY_45 });
  assert.strictEqual(merged.unsupportedReason, slots.NEEDS_OMARCHY_45);
  const back = state.parseStatus(state.serializeStatus(merged)).status;
  assert.strictEqual(back.unsupportedReason, slots.NEEDS_OMARCHY_45);
  // a patch without the key leaves it alone
  assert.strictEqual(state.mergeStatus(merged, { restoring: true }).unsupportedReason, slots.NEEDS_OMARCHY_45);
});

test("the wording, in the bar tooltip, the badge tooltip and Record", function () {
  const bad = state.mergeStatus(state.defaultStatus(), { unsupportedReason: slots.NEEDS_OMARCHY_45, recorded: true });
  const good = state.defaultStatus();
  assert.strictEqual(panel.needsOmarchyText(bad), TEXT);
  assert.strictEqual(panel.needsOmarchyText(good), "");
  assert.strictEqual(panel.needsOmarchyText(null), "");
  assert.ok(panel.barGlyphTooltip(state.glyphState(bad), bad, "Laptop").indexOf(TEXT) !== -1);
  assert.ok(panel.badgeTooltip(state.glyphState(bad), bad).indexOf(TEXT) !== -1);
  assert.ok(panel.recordTooltip(3, "Laptop", false, false, bad).indexOf(TEXT) !== -1);
  // supported systems are untouched
  assert.ok(panel.barGlyphTooltip("filled", good, "Laptop").indexOf(TEXT) === -1);
  assert.ok(panel.recordTooltip(3, "Laptop", false, false, good).indexOf(TEXT) === -1);
  assert.strictEqual(panel.recordTooltip(3, "Laptop", false, false), panel.recordTooltip(3, "Laptop", false, false, good));
});

test("wiring: the service probes both witnesses, stamps the status and stands down", function () {
  const svc = read("Service.qml");
  assert.ok(svc.indexOf("${OMARCHY_PATH:-/usr/share/omarchy}/default/hypr/monitor-workspaces.lua") !== -1);
  assert.ok(svc.indexOf("Slots.unsupportedReason(") !== -1);
  assert.ok(svc.indexOf("stamped.unsupportedReason = root.unsupportedReason") !== -1);
  // requestRestore refuses before it starts a cycle, and the first pass stands down before planning
  const req = svc.slice(svc.indexOf("function requestRestore("));
  assert.ok(req.indexOf('root.unsupportedReason !== ""') !== -1
    && req.indexOf('root.unsupportedReason !== ""') < req.indexOf("root.cycleActive = true"));
  assert.ok(/if \(root\.unsupportedReason !== ""\) \{ root\.endUnsupportedCycle\(\); return \}\s*root\.planAndExecute\(\)/.test(svc));
  const pan = read("Panel.qml");
  assert.ok(/canRecord: [^]*root\.needsOmarchyReason === ""/.test(pan));
});

// The recorded map never mislabels an unplaced monitor.
test("recorded map: apps of a monitor with no block row keep their own slots", function () {
  const MON = "Some Dock Display";
  const layout = { apps: [
    { identityId: "slack", occurrence: 0, monitorDescription: MON, slot: 3, workspaceId: null, unplaceable: "monitor-unknown" },
    { identityId: "gmail", occurrence: 0, monitorDescription: MON, slot: 10, workspaceId: null, unplaceable: "monitor-unknown" }
  ] };
  const monitors = [{ name: "DP-1", description: MON, width: 1920, height: 1080, x: 0, y: 0, scale: 1, id: 0 }];
  const map = panel.recordedMapModel(layout, monitors, ["slack", "gmail"], 480, 240);
  const box = map.monitors.filter(function (m) { return m.label === MON; })[0];
  assert.ok(box, "the monitor box is there");
  assert.strictEqual(box.workspaces.length, 2, "one workspace per slot, not one pooled workspace");
  assert.deepStrictEqual(box.workspaces.map(function (w) { return w.name; }), ["3", "0"]);
  assert.deepStrictEqual(box.workspaces.map(function (w) { return w.slot; }), [3, 10]);
  assert.strictEqual(box.workspaces[0].slots[0].chips[0].placement, "DP-1 · ws 3");
  assert.strictEqual(box.workspaces[1].slots[0].chips[0].placement, "DP-1 · ws 0");
});

test("placementLabel falls back to the slot, and only when there is no workspace id", function () {
  assert.strictEqual(panel.placementLabel("X", null, [], 4), "X · ws 4");
  assert.strictEqual(panel.placementLabel("X", null, [], undefined), "X · ws ?");
  assert.strictEqual(panel.placementLabel("X", 13, [], 5), "X · ws 3");
});

test("lua witness honours OMARCHY_PATH, unsupported cycle clears its latches, scratch join gated", function () {
  const svc = read("Service.qml");
  const end = svc.slice(svc.indexOf("function endUnsupportedCycle("), svc.indexOf("function readBlocks("));
  assert.ok(end.indexOf("root.endReloadCheck()") !== -1 && end.indexOf("reloadCheckAfterCycle") !== -1);
  assert.ok(end.indexOf("root.pendingJoins = false") !== -1 && end.indexOf("root.gateArgs = null") !== -1);
  // the status it publishes must drop the deferred-join flag too, or a stale "joins deferred" tooltip outlives the latch
  assert.ok(/publishStatus\(\{[^}]*deferredLocked: false[^}]*\}, "unsupported system"\)/.test(end));
  const sj = svc.slice(svc.indexOf("function scratchJoin("), svc.indexOf("function scratchJoinReady("));
  assert.ok(sj.indexOf('root.unsupportedReason !== ""') !== -1
    && sj.indexOf('root.unsupportedReason !== ""') < sj.indexOf("root.gateThen("));
});

test("record-current refuses on a system without 4.5's workspaces", function () {
  const os = require("node:os");
  const cp = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
  const file = path.join(dir, "state.json");
  const seeded = state.defaultState();
  seeded.identities = [{ id: "slack", name: "Slack", match: { class: "Slack" } }];
  fs.writeFileSync(file, state.serializeState(seeded));
  const run = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "record-current"), "--state", file], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { XDG_STATE_HOME: dir, OMARCHY_PATH: path.join(dir, "none"), PATH: "/nonexistent" })
  });
  assert.ok(state.identities(state.parseState(fs.readFileSync(file, "utf8")).state).length > 0, "seed is valid");
  assert.ok(/Needs Omarchy 4\.5/.test(run.stderr), run.stderr + run.error);
  assert.strictEqual(run.status, 1);
});
