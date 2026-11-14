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

test("an event long before the first check does not time it out", () => {
  let r = run(gate.create(), 400, "S");
  r = run(r.gate, 800, "S");
  assert.strictEqual(r.ready, true);
  const g = gate.onEvent(r.gate, "createworkspacev2>>5,5", 1000);
  r = run(g, 16500, "S");
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.ready, false);
  r = run(r.gate, 16900, "S");
  assert.strictEqual(r.ready, true);
});

test("off-owner alone at timeout allows planning anyway", () => {
  const stuck = { address: "0x1", workspace: { id: 3 }, monitor: 1 };
  assert.strictEqual(gate.pending(docked, [], [stuck], [laptop, aoc]), "workspace-off-owner");
  assert.deepStrictEqual(gate.offOwnerWorkspaces(docked, [stuck, stuck], [laptop, aoc]), [3]);
  let r = run(gate.create(), 0, "S", "workspace-off-owner");
  r = run(r.gate, gate.MAX_WAIT_MS, "S", "workspace-off-owner");
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.planAnyway, true);
  // a stability-only event does not count as a hold
  let g = gate.onEvent(gate.create(), "moveworkspacev2>>3,3,x", 10);
  r = run(g, 20, "S", "workspace-off-owner");
  r = run(r.gate, 20 + gate.MAX_WAIT_MS, "S", "workspace-off-owner");
  assert.strictEqual(r.planAnyway, true);
});

test("planning anyway is refused when a hold event hit the episode or another reason remains", () => {
  for (const ev of ["monitoraddedv2", "monitorremovedv2", "configreloaded"]) {
    let g = gate.onEvent(gate.create(), ev, 0);
    let r = run(g, 2000, "S", "workspace-off-owner");
    r = run(r.gate, gate.MAX_WAIT_MS, "S", "workspace-off-owner");
    assert.strictEqual(r.timedOut, true, ev);
    assert.strictEqual(r.planAnyway, false, ev);
  }
  for (const why of ["monitor-unassigned", "merged-owner-present", null]) {
    let r = run(gate.create(), 0, "S", why);
    r = run(r.gate, gate.MAX_WAIT_MS, "S", why);
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(r.planAnyway, false, String(why));
  }
  assert.strictEqual(run(gate.create(), 0, "S", "workspace-off-owner").planAnyway, false);
});

test("parity: gate.pending agrees with Slots.blockForMonitor on the stale/twin/untrimmed/name cases", () => {
  const cases = [
    // [table text, monitor]
    ["0\teDP-1\t" + LAPTOP + "\n1\tDP-1\t" + AOC + "\n", { id: 1, name: "DP-1", description: "Dell U2720Q ABC" }], // stale row
    ["0\teDP-1\t" + LAPTOP + "\n1\tDP-1\tDell U2720Q\n2\tDP-2\tDell U2720Q #2\n", { id: 2, name: "DP-2", description: "Dell U2720Q" }],
    ["0\teDP-1\t" + LAPTOP + "\n1\tDP-1\tDell U2720Q\n2\tDP-2\tDell U2720Q #2\n", { id: 1, name: "DP-1", description: "Dell U2720Q" }],
    ["3\tDP-3\tDell U2720Q #2x\n", { id: 3, name: "DP-3", description: "Dell U2720Q" }],
    ["1\tDP-1\tFoo Bar \n2\tDP-2\tFoo Bar #2\n", { id: 1, name: "DP-1", description: "Foo Bar " }],
    ["1\tDP-1\tFoo Bar \n2\tDP-2\tFoo Bar #2\n", { id: 2, name: "DP-2", description: "Foo Bar " }],
    ["1\tDP-1\tFoo Bar \n2\tDP-2\tFoo Bar #2\n", { id: 1, name: "DP-1", description: "Foo Baz " }],
    ["0\teDP-1\t" + LAPTOP + "\n1\tHEADLESS-2\tHEADLESS-2\n", { id: 1, name: "HEADLESS-2", description: "" }],
    ["0\teDP-1\t" + LAPTOP + "\n", { id: 1, name: "HEADLESS-2", description: "" }]
  ];
  for (const [t, m] of cases) {
    const table = slots.parseBlocks(t);
    const expectOk = slots.blockForMonitor(table, m) !== null;
    assert.strictEqual(gate.pending(table, [], [], [m]) === null, expectOk, t + " / " + m.name);
  }
  // and a window on the block the owner row names resolves the same owner
  const table = slots.parseBlocks("1\tDP-1\tFoo Bar \n");
  const m = { id: 1, name: "DP-1", description: "Foo Bar " };
  const onOther = { address: "0x1", workspace: { id: 11 }, monitor: 1 };
  assert.strictEqual(gate.pending(table, [], [onOther], [m, { id: 0, name: "eDP-1", description: "", disabled: true }]), null);
  assert.strictEqual(gate.pending(table, [], [onOther], [m, { id: 0, name: "eDP-1", description: "" }]), "monitor-unassigned");
});

test("ReconcileGate.js loads without module, as QML imports it, and is ES5", () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "..", "ReconcileGate.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.strictEqual(typeof context.check, "function");
  assert.strictEqual(typeof context.offOwnerWorkspaces, "function");
  assert.strictEqual(context.create().startMs, null);
  const banned = [
    [/\b(let|const|class|import|export)\b/, "ES6 declaration or module syntax"],
    [/=>/, "arrow function"],
    [/`/, "template literal"],
    [/\.\.\./, "spread or rest"],
    [/\bvar\s*[[{]/, "destructuring"],
    [/^\s*(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/m, "shorthand method"]
  ];
  const code = source.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  for (const [pattern, what] of banned) {
    const hit = pattern.exec(code);
    assert.ok(!hit, "ES5 only: " + what + (hit ? " at '" + hit[0] + "'" : ""));
  }
});

// ------------------------------------------- config reload: restore or not
// Human decision 2026-11-14, "restore only if monitors changed": a reload starts
// a restore cycle only when the monitor set, the topology key or the block table
// differs from the reading taken before it.

const engine = require("../engine.js");
const reading = (monitors, blocksText) => gate.reloadReading(monitors, engine.topologyKey(monitors), blocksText);
const DOCKED_BLOCKS = text("monitor-workspaces-docked.txt");
const UNDOCKED_BLOCKS = text("monitor-workspaces-undocked.txt");

test("reload with the same monitors and blocks does not restore", () => {
  const before = reading([laptop, aoc], DOCKED_BLOCKS);
  // A reload moves focus and rewrites the blocks file with the same rows: neither is a change.
  const after = reading([{ ...aoc, activeWorkspace: { id: 14 }, focused: true }, { ...laptop, activeWorkspace: { id: 3 } }],
    DOCKED_BLOCKS.split("\n").reverse().join("\n") + "\n\n");
  assert.deepStrictEqual(gate.reloadDecision(before, after), { restore: false, reason: "unchanged" });
});

test("reload restores when an output appeared, went off, or the blocks changed", () => {
  const before = reading([laptop], UNDOCKED_BLOCKS);
  assert.deepStrictEqual(gate.reloadDecision(before, reading([laptop, aoc], UNDOCKED_BLOCKS)),
    { restore: true, reason: "topology-changed" });
  // Same topology key (a disabled output still counts towards it), different set.
  const two = reading([laptop, aoc], DOCKED_BLOCKS);
  assert.deepStrictEqual(gate.reloadDecision(two, reading([laptop, { ...aoc, disabled: true }], DOCKED_BLOCKS)),
    { restore: true, reason: "monitors-changed" });
  assert.deepStrictEqual(gate.reloadDecision(two, reading([laptop, { ...aoc, name: "DP-2" }], DOCKED_BLOCKS)).restore, true);
  assert.deepStrictEqual(gate.reloadDecision(two, reading([laptop, aoc], UNDOCKED_BLOCKS)),
    { restore: true, reason: "blocks-changed" });
});

test("reload with no reading before it restores; a failed reading after it does not", () => {
  assert.deepStrictEqual(gate.reloadDecision(null, reading([laptop], UNDOCKED_BLOCKS)), { restore: true, reason: "no-baseline" });
  assert.deepStrictEqual(gate.reloadDecision(reading([laptop], UNDOCKED_BLOCKS), null), { restore: false, reason: "no-reading" });
});
