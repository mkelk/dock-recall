// ReconcileGate.js: the wait-for-4.5-re-sort gate. Pure, clock passed in.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const gate = require("../ReconcileGate.js");
const slots = require("../Slots.js");

const FIXTURES = path.join(__dirname, "fixtures");
const text = (n) => fs.readFileSync(path.join(FIXTURES, n), "utf8");

const LAPTOP = "Samsung Display Corp. ATNA60HR07-0";
const AOC = "AOC CU34V5C XXXXXXXXXXXXX";
const laptop = { id: 0, name: "eDP-1", description: LAPTOP, activeWorkspace: { id: 1 } };
const aoc = { id: 1, name: "DP-1", description: AOC, activeWorkspace: { id: 11 } };

const docked = slots.parseBlocks(text("monitor-workspaces-docked.txt"));
const undocked = slots.parseBlocks(text("monitor-workspaces-undocked.txt"));
const merged = slots.parseMerged(text("monitor-workspaces-merged.txt"));

function run(g, nowMs, sig, pendingReason) {
  return gate.check(g, { nowMs: nowMs, signature: sig, pendingReason: pendingReason || null });
}

test("monitorremovedv2 holds 1500 ms even with a stable signature", () => {
  let g = gate.onEvent(gate.create(), "monitorremovedv2", 0);
  for (const t of [400, 1000, 1400]) {
    const r = run(g, t, "S");
    g = r.gate;
    assert.strictEqual(r.ready, false, "t=" + t);
    assert.ok(r.waitMs > 0);
  }
  let r = run(g, 1500, "S");
  assert.strictEqual(r.ready, false, "first equal signature after the hold");
  r = run(r.gate, 1900, "S");
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.waitMs, 0);
  assert.strictEqual(r.timedOut, false);
});

test("a signature change after the hold defers", () => {
  let g = gate.onEvent(gate.create(), "monitorremovedv2>>1,DP-1", 0);
  let r = run(g, 1500, "S");
  r = run(r.gate, 1600, "T");
  assert.strictEqual(r.ready, false);
  assert.ok(r.waitMs > 0);
  r = run(r.gate, 2000, "T");
  assert.strictEqual(r.ready, true);
});

test("a workspace event resets stability", () => {
  let r = run(gate.create(), 0, "S");
  r = run(r.gate, 400, "S");
  const g = gate.onEvent(r.gate, "moveworkspacev2>>3,3,x", 450);
  r = run(g, 500, "S");
  assert.strictEqual(r.ready, false);
  r = run(r.gate, 900, "S");
  assert.strictEqual(r.ready, true);
});

test("a pending reason blocks readiness and is reported", () => {
  let r = run(gate.create(), 0, "S", "monitor-unassigned");
  r = run(r.gate, 500, "S", "monitor-unassigned");
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.reason, "monitor-unassigned");
  r = run(r.gate, 1000, "S", null);
  assert.strictEqual(r.ready, false);
  r = run(r.gate, 1400, "S", null);
  assert.strictEqual(r.ready, true);
});

test("configreloaded and monitoradded hold 300 ms", () => {
  for (const ev of ["configreloaded", "monitoraddedv2"]) {
    let g = gate.onEvent(gate.create(), ev, 1000);
    let r = run(g, 1100, "S");
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.waitMs, 200);
    r = run(r.gate, 1300, "S");
    assert.strictEqual(r.ready, false);
    r = run(r.gate, 1700, "S");
    assert.strictEqual(r.ready, true);
  }
});

test("with no event ever, the first check is not ready and the second equal one is", () => {
  let r = run(gate.create(), 5000, "S");
  assert.strictEqual(r.ready, false);
  r = run(r.gate, 5400, "S");
  assert.strictEqual(r.ready, true);
});

test("unrelated events change nothing", () => {
  const g = gate.onEvent(gate.create(), "activewindowv2>>abc", 10);
  assert.deepStrictEqual(g, gate.create());
});

test("timeout: never ready, timedOut true, gate resets", () => {
  let g = gate.onEvent(gate.create(), "monitorremovedv2", 0);
  let r = run(g, 1500, "S", "monitor-unassigned");
  r = run(r.gate, gate.MAX_WAIT_MS, "S", "monitor-unassigned");
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.gate, gate.create());
});

test("pending: undocked table with the dock monitor live is monitor-unassigned", () => {
  assert.strictEqual(gate.pending(undocked, [], [], [laptop, aoc]), "monitor-unassigned");
  assert.strictEqual(gate.pending(docked, [], [], [laptop, aoc]), null);
});

test("pending: disabled and mirroring monitors are not waited on", () => {
  const off = Object.assign({}, aoc, { disabled: true });
  const mirror = Object.assign({}, aoc, { mirrorOf: "eDP-1" });
  assert.strictEqual(gate.pending(undocked, [], [], [laptop, off]), null);
  assert.strictEqual(gate.pending(undocked, [], [], [laptop, mirror]), null);
});

test("pending: a merged row for a returning identity waits until cleared", () => {
  assert.strictEqual(gate.pending(docked, merged, [], [laptop, aoc]), "merged-owner-present");
  assert.strictEqual(gate.pending(docked, [], [], [laptop, aoc]), null);
  // identity not live: nothing to restore yet
  assert.strictEqual(gate.pending(undocked, merged, [], [laptop]), null);
});

test("pending: a window on a workspace of another monitor's block", () => {
  const onLaptopBlock = { address: "0x1", workspace: { id: 3 }, monitor: 1 };
  assert.strictEqual(gate.pending(docked, [], [onLaptopBlock], [laptop, aoc]), "workspace-off-owner");
  const home = { address: "0x1", workspace: { id: 3 }, monitor: 0 };
  assert.strictEqual(gate.pending(docked, [], [home], [laptop, aoc]), null);
  const special = { address: "0x2", workspace: { id: -98 }, monitor: 1 };
  assert.strictEqual(gate.pending(docked, [], [special], [laptop, aoc]), null);
});

test("mirrored rules agree with Slots.js", () => {
  const cases = [laptop, aoc, { name: "X-1", description: "" }, { name: "X-2", disabled: true },
    { name: "X-3", mirrorOf: "none" }, { name: "X-4", mirrorOf: "eDP-1" }];
  for (const m of cases) {
    const slotsLive = slots.isLiveMonitor(m);
    // a live monitor with no row is monitor-unassigned; a non-live one is ignored
    const unassigned = gate.pending(slots.parseBlocks(""), [], [], [m]) === "monitor-unassigned";
    assert.strictEqual(unassigned, slotsLive, m.name);
  }
  for (const t of [docked, undocked]) {
    for (const m of [laptop, aoc]) {
      const expectOk = slots.blockForMonitor(t, m) !== null;
      assert.strictEqual(gate.pending(t, [], [], [m]) === null, expectOk);
    }
  }
});

test("signature is order-independent and sensitive to the files", () => {
  const c1 = { address: "a", workspace: { id: 1 }, monitor: 0 };
  const c2 = { address: "b", workspace: { id: 2 }, monitor: 0 };
  assert.strictEqual(gate.signature([c1, c2], [laptop, aoc], "x", ""), gate.signature([c2, c1], [aoc, laptop], "x", ""));
  assert.notStrictEqual(gate.signature([c1], [laptop], "x", ""), gate.signature([c1], [laptop], "y", ""));
  assert.notStrictEqual(gate.signature([c1], [laptop], "x", ""), gate.signature([c1], [laptop], "x", "m"));
});
