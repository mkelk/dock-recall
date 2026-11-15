// x53: a system without Omarchy 4.5's per-monitor workspaces is detected and
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
  assert.ok(svc.indexOf("/usr/share/omarchy/default/hypr/monitor-workspaces.lua") !== -1);
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
