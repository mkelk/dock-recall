// Slots.js: the v8 placement contract (monitorDescription + slot) and its
// resolution against Omarchy 4.5's per-monitor workspace blocks.
// Source of truth: the contract in Slots.js's header, which mirrors
// /usr/share/omarchy/default/hypr/monitor-workspaces.lua (load_blocks,
// load_merged, the identity check in identities_of, block_of_id) and the bar's
// readBlocks in plugins/bar/widgets/Workspaces.qml.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const slots = require("../Slots.js");
const engine = require("../engine.js");

const FIXTURES = path.join(__dirname, "fixtures");
function fixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

const LAPTOP = "Samsung Display Corp. ATNA60HR07-0";
const AOC = "AOC CU34V5C XXXXXXXXXXXXX";

const docked = slots.parseBlocks(fixtureText("monitor-workspaces-docked.txt"));
const undocked = slots.parseBlocks(fixtureText("monitor-workspaces-undocked.txt"));

const laptop = { id: 0, name: "eDP-1", description: LAPTOP, activeWorkspace: { id: 1, name: "1" } };
const aoc = { id: 1, name: "DP-1", description: AOC, activeWorkspace: { id: 11, name: "11" } };

function placement(fields) {
  return Object.assign({
    identityId: "slack", occurrence: 0, monitorDescription: AOC, slot: 3,
    floating: false, group: null, at: null, size: null
  }, fields);
}

function layoutOf(apps) {
  return { topologyKey: "k", recordedAt: "2026-11-14T00:00:00.000Z", apps };
}

// --- block / slot arithmetic -------------------------------------------------

test("blockOf and slotOf over 1..200 invert workspaceIdFor", () => {
  for (let id = 1; id <= 200; id++) {
    const block = slots.blockOf(id);
    const slot = slots.slotOf(id);
    assert.strictEqual(block, Math.floor((id - 1) / 10), "block of " + id);
    assert.ok(slot >= 1 && slot <= 10, "slot of " + id);
    assert.strictEqual(slots.workspaceIdFor(block, slot), id, "round trip " + id);
  }
  assert.strictEqual(slots.blockOf(10), 0);
  assert.strictEqual(slots.slotOf(10), 10);
  assert.strictEqual(slots.blockOf(11), 1);
  assert.strictEqual(slots.slotOf(11), 1);
  assert.strictEqual(slots.SLOTS, 10);
});

test("blockOf and slotOf answer null for anything not a regular workspace id", () => {
  for (const junk of [0, -1, -98, 1.5, NaN, Infinity, "3", null, undefined, {}, []]) {
    assert.strictEqual(slots.blockOf(junk), null, "blockOf " + String(junk));
    assert.strictEqual(slots.slotOf(junk), null, "slotOf " + String(junk));
  }
});

test("workspaceIdFor refuses a negative block or a slot outside 1..10", () => {
  assert.strictEqual(slots.workspaceIdFor(1, 3), 13);
  assert.strictEqual(slots.workspaceIdFor(0, 10), 10);
  for (const [block, slot] of [[-1, 3], [0, 0], [0, 11], [1.5, 3], [1, 2.5], [null, 3], [1, null], ["1", 3]]) {
    assert.strictEqual(slots.workspaceIdFor(block, slot), null, block + "/" + slot);
  }
});

// --- parsing ---------------------------------------------------------------

test("parseBlocks reads the docked fixture", () => {
  assert.deepStrictEqual(docked.rows, [
    { block: 0, connector: "eDP-1", identity: LAPTOP },
    { block: 1, connector: "DP-1", identity: AOC }
  ]);
  assert.strictEqual(docked.byConnector["DP-1"].block, 1);
  assert.deepStrictEqual(docked.byIdentity, { [LAPTOP]: 0, [AOC]: 1 });
});

test("parseBlocks keeps an unplugged monitor's block but not its connector", () => {
  assert.deepStrictEqual(Object.keys(undocked.byConnector), ["eDP-1"]);
  assert.strictEqual(slots.blockForIdentity(undocked, AOC), 1);
});

test("parseBlocks drops junk lines and survives empty input", () => {
  const text = [
    "", "# comment", "x\tDP-1\tJunk", "1 DP-2 Spaces not tabs", "2\tDP-3", "3\tDP-3\t",
    "-1\tDP-4\tNegative", "4\tDP-5\tGood", "5\tA\tB\tC"
  ].join("\n");
  const table = slots.parseBlocks(text);
  assert.deepStrictEqual(table.rows, [
    { block: 4, connector: "DP-5", identity: "Good" },
    { block: 5, connector: "A", identity: "B\tC" }
  ]);
  for (const empty of [null, undefined, ""]) {
    assert.deepStrictEqual(slots.parseBlocks(empty), { rows: [], byConnector: {}, byIdentity: {} });
  }
});

test("parseBlocks: a later row wins for a duplicate identity and a duplicate connector; rows stay raw", () => {
  const table = slots.parseBlocks("1\tDP-1\tA\n2\tDP-2\tA\n3\tDP-2\tB\n");
  assert.strictEqual(table.rows.length, 3);
  assert.strictEqual(table.byIdentity.A, 2);
  assert.strictEqual(table.byIdentity.B, 3);
  assert.deepStrictEqual(table.byConnector["DP-2"], { block: 3, connector: "DP-2", identity: "B" });
  assert.deepStrictEqual(table.byConnector["DP-1"], { block: 1, connector: "DP-1", identity: "A" });
});

test("parseBlocks and parseMerged strip a trailing CR", () => {
  const table = slots.parseBlocks("1\tDP-1\t" + AOC + "\r\n");
  assert.deepStrictEqual(slots.blockForMonitor(table, aoc), { block: 1, identity: AOC });
  assert.deepStrictEqual(slots.parseMerged("6\t11\t" + AOC + "\r\n"), [{ id: 6, originalId: 11, identity: AOC }]);
});

test("parseMerged: a later line wins for the same id, output in ascending id order", () => {
  assert.deepStrictEqual(slots.parseMerged("9\t21\tA\n4\t12\tB\n9\t22\tC\n"), [
    { id: 4, originalId: 12, identity: "B" },
    { id: 9, originalId: 22, identity: "C" }
  ]);
});

test("parseMerged reads the merged fixture and drops junk lines", () => {
  assert.deepStrictEqual(slots.parseMerged(fixtureText("monitor-workspaces-merged.txt")),
    [{ id: 6, originalId: 11, identity: AOC }]);
  assert.deepStrictEqual(slots.parseMerged("junk\n7\tx\tA\n7\t12\t\n8\t13\tB\n"),
    [{ id: 8, originalId: 13, identity: "B" }]);
  assert.deepStrictEqual(slots.parseMerged(null), []);
  assert.deepStrictEqual(slots.parseMerged(""), []);
});

// --- identity ----------------------------------------------------------------

test("monitorIdentityLabel equals engine.monitorLabel", () => {
  const cases = [
    laptop, aoc,
    { name: "HEADLESS-2", description: "" },
    { name: "HEADLESS-2" },
    { name: " DP-9 ", description: "   " },
    { name: "DP-1", description: "  Padded Desc  " },
    {}, null, undefined
  ];
  for (const monitor of cases) {
    assert.strictEqual(slots.monitorIdentityLabel(monitor), engine.monitorLabel(monitor), JSON.stringify(monitor));
  }
});

// --- blockForMonitor ---------------------------------------------------------

test("blockForMonitor accepts the row on the monitor's connector", () => {
  assert.deepStrictEqual(slots.blockForMonitor(docked, aoc), { block: 1, identity: AOC });
  assert.deepStrictEqual(slots.blockForMonitor(docked, laptop), { block: 0, identity: LAPTOP });
});

test("blockForMonitor rejects a stale row: connector matches, identity differs", () => {
  const other = { id: 1, name: "DP-1", description: "Dell U2720Q ABC" };
  assert.strictEqual(slots.blockForMonitor(docked, other), null);
});

test("blockForMonitor accepts a twin row 'D #2' for its own connector", () => {
  const table = slots.parseBlocks("0\teDP-1\t" + LAPTOP + "\n1\tDP-1\tDell U2720Q\n2\tDP-2\tDell U2720Q #2\n");
  assert.deepStrictEqual(slots.blockForMonitor(table, { name: "DP-2", description: "Dell U2720Q" }),
    { block: 2, identity: "Dell U2720Q #2" });
  assert.deepStrictEqual(slots.blockForMonitor(table, { name: "DP-1", description: "Dell U2720Q" }),
    { block: 1, identity: "Dell U2720Q" });
  // The suffix is stripped only as a trailing " #<digits>".
  const odd = slots.parseBlocks("3\tDP-3\tDell U2720Q #2x\n");
  assert.strictEqual(slots.blockForMonitor(odd, { name: "DP-3", description: "Dell U2720Q" }), null);
});

test("blockForMonitor accepts a row written with an untrimmed description", () => {
  const table = slots.parseBlocks("1\tDP-1\tFoo Bar \n2\tDP-2\tFoo Bar #2\n");
  const padded = { name: "DP-1", description: "Foo Bar " };
  assert.strictEqual(slots.monitorIdentityLabel(padded), "Foo Bar");
  assert.deepStrictEqual(slots.blockForMonitor(table, padded), { block: 1, identity: "Foo Bar " });
  assert.deepStrictEqual(slots.blockForMonitor(table, { name: "DP-2", description: "Foo Bar " }), { block: 2, identity: "Foo Bar #2" });
  assert.strictEqual(slots.blockForMonitor(table, { name: "DP-1", description: "Foo Baz " }), null);
});

test("blockForMonitor resolves a headless monitor (empty description) by name", () => {
  const table = slots.parseBlocks("0\teDP-1\t" + LAPTOP + "\n1\tHEADLESS-2\tHEADLESS-2\n");
  assert.deepStrictEqual(slots.blockForMonitor(table, { name: "HEADLESS-2", description: "" }),
    { block: 1, identity: "HEADLESS-2" });
});

test("blockForMonitor and blockForIdentity answer null on a missing table or row", () => {
  assert.strictEqual(slots.blockForMonitor(null, aoc), null);
  assert.strictEqual(slots.blockForMonitor(docked, null), null);
  assert.strictEqual(slots.blockForMonitor(undocked, aoc), null);
  assert.strictEqual(slots.blockForIdentity(docked, "Nope"), null);
  assert.strictEqual(slots.blockForIdentity(docked, "toString"), null);
  assert.strictEqual(slots.blockForIdentity(null, AOC), null);
});

// --- toLive ------------------------------------------------------------------

test("toLive maps AOC slot 3 to workspace 13 on the docked desk", () => {
  const live = slots.toLive(layoutOf([placement({ slot: 3 }), placement({ identityId: "gmail", monitorDescription: LAPTOP, slot: 2 })]),
    docked, [laptop, aoc]);
  assert.strictEqual(live.apps[0].workspaceId, 13);
  assert.strictEqual(live.apps[0].unplaceable, null);
  assert.strictEqual(live.apps[1].workspaceId, 2);
  assert.strictEqual(live.apps[1].unplaceable, null);
  assert.strictEqual(live.topologyKey, "k");
  assert.strictEqual(live.recordedAt, "2026-11-14T00:00:00.000Z");
  assert.strictEqual(live.apps[0].slot, 3, "the v8 fields are kept");
});

test("toLive does not mutate its input", () => {
  const layout = layoutOf([placement({ slot: 3 })]);
  const before = JSON.parse(JSON.stringify(layout));
  slots.toLive(layout, docked, [laptop, aoc]);
  assert.deepStrictEqual(layout, before);
});

test("toLive: a live monitor absent from the file is monitor-unassigned", () => {
  const live = slots.toLive(layoutOf([placement({ slot: 3 })]), slots.parseBlocks("0\teDP-1\t" + LAPTOP + "\n"), [laptop, aoc]);
  assert.strictEqual(live.apps[0].workspaceId, null);
  assert.strictEqual(live.apps[0].unplaceable, "monitor-unassigned");
});

test("toLive: a stale row (connector matches, identity differs) is monitor-unassigned", () => {
  const table = slots.parseBlocks("0\teDP-1\t" + LAPTOP + "\n1\tDP-1\tDell U2720Q ABC\n");
  const live = slots.toLive(layoutOf([placement({ slot: 3 })]), table, [laptop, aoc]);
  assert.strictEqual(live.apps[0].workspaceId, null);
  assert.strictEqual(live.apps[0].unplaceable, "monitor-unassigned");
});

test("toLive: a monitor that is not live resolves by identity, for display", () => {
  const live = slots.toLive(layoutOf([placement({ slot: 3 })]), undocked, [laptop]);
  assert.strictEqual(live.apps[0].workspaceId, 13);
  assert.strictEqual(live.apps[0].unplaceable, null);
  const unknown = slots.toLive(layoutOf([placement({ monitorDescription: "Never Seen", slot: 3 })]), undocked, [laptop]);
  assert.strictEqual(unknown.apps[0].workspaceId, null);
  assert.strictEqual(unknown.apps[0].unplaceable, "monitor-unknown");
});

test("toLive: a headless monitor resolves by name", () => {
  const headless = { id: 1, name: "HEADLESS-2", description: "" };
  const table = slots.parseBlocks("0\teDP-1\t" + LAPTOP + "\n1\tHEADLESS-2\tHEADLESS-2\n");
  const live = slots.toLive(layoutOf([placement({ monitorDescription: "HEADLESS-2", slot: 5 })]), table, [laptop, headless]);
  assert.strictEqual(live.apps[0].workspaceId, 15);
  assert.strictEqual(live.apps[0].unplaceable, null);
});

test("toLive: a missing or invalid slot is slot-unknown", () => {
  for (const slot of [null, undefined, 0, 11, 1.5, "3"]) {
    const live = slots.toLive(layoutOf([placement({ slot })]), docked, [laptop, aoc]);
    assert.strictEqual(live.apps[0].workspaceId, null, "slot " + String(slot));
    assert.strictEqual(live.apps[0].unplaceable, "slot-unknown", "slot " + String(slot));
  }
});

test("toLive: an unassigned or unknown monitor is reported ahead of an unknown slot", () => {
  const live = slots.toLive(layoutOf([placement({ slot: null })]), slots.parseBlocks(""), [laptop, aoc]);
  assert.strictEqual(live.apps[0].unplaceable, "monitor-unassigned");
  const absent = slots.toLive(layoutOf([placement({ slot: null })]), slots.parseBlocks(""), [laptop]);
  assert.strictEqual(absent.apps[0].unplaceable, "monitor-unknown");
});

const TWINS = slots.parseBlocks("0\teDP-1\t" + LAPTOP + "\n1\tDP-1\tD\n2\tDP-2\tD #2\n");
const twin1 = { id: 1, name: "DP-1", description: "D" };
const twin2 = { id: 2, name: "DP-2", description: "D" };

test("toLive: twins resolve to the first twin's block", () => {
  const live = slots.toLive(layoutOf([placement({ monitorDescription: "D", slot: 3 })]), TWINS, [laptop, twin1, twin2]);
  assert.strictEqual(live.apps[0].workspaceId, 13);
  assert.strictEqual(live.apps[0].unplaceable, null);
});

test("toLive: a disabled or mirroring monitor counts as not plugged in", () => {
  const table = slots.parseBlocks("0\t\t" + LAPTOP + "\n1\tDP-1\t" + AOC + "\n");
  for (const off of [{ disabled: true }, { mirrorOf: "DP-1" }]) {
    const panel = Object.assign({}, laptop, off);
    const live = slots.toLive(layoutOf([placement({ monitorDescription: LAPTOP, slot: 2 })]), table, [panel, aoc]);
    assert.strictEqual(live.apps[0].workspaceId, 2, JSON.stringify(off));
    assert.strictEqual(live.apps[0].unplaceable, null, JSON.stringify(off));
  }
  for (const on of [{ disabled: false }, { mirrorOf: "none" }, { mirrorOf: "" }]) {
    const panel = Object.assign({}, laptop, on);
    const live = slots.toLive(layoutOf([placement({ monitorDescription: LAPTOP, slot: 2 })]), table, [panel, aoc]);
    assert.strictEqual(live.apps[0].unplaceable, "monitor-unassigned", JSON.stringify(on));
  }
});

test("toLive and toRecorded skip falsy app entries", () => {
  const live = slots.toLive(layoutOf([null, placement({ slot: 3 }), undefined]), docked, [laptop, aoc]);
  assert.strictEqual(live.apps.length, 1);
  const back = slots.toRecorded(layoutOf([null, live.apps[0], 0]), docked, [laptop, aoc]);
  assert.strictEqual(back.layout.apps.length, 1);
  assert.deepStrictEqual(back.excluded, []);
});

test("blockForDescription resolves live first, then by identity", () => {
  assert.strictEqual(slots.blockForDescription(docked, [laptop, aoc], AOC), 1);
  assert.strictEqual(slots.blockForDescription(undocked, [laptop], AOC), 1);
  assert.strictEqual(slots.blockForDescription(undocked, [laptop, aoc], AOC), null);
  assert.strictEqual(slots.blockForDescription(undocked, [laptop], "Never Seen"), null);
});

test("toLive overwrites a stale workspaceId and is idempotent", () => {
  const once = slots.toLive(layoutOf([placement({ slot: 3, workspaceId: 3 })]), docked, [laptop, aoc]);
  assert.strictEqual(once.apps[0].workspaceId, 13);
  assert.deepStrictEqual(slots.toLive(once, docked, [laptop, aoc]), once);
});

// --- toRecorded --------------------------------------------------------------

test("toRecorded round-trips toLive", () => {
  const recorded = layoutOf([
    placement({ slot: 3 }),
    placement({ identityId: "gmail", monitorDescription: LAPTOP, slot: 10, at: [1, 2], size: [3, 4] })
  ]);
  const live = slots.toLive(recorded, docked, [laptop, aoc]);
  const back = slots.toRecorded(live, docked, [laptop, aoc]);
  assert.deepStrictEqual(back, { layout: recorded, excluded: [] });
  for (const app of back.layout.apps) {
    assert.ok(!("workspaceId" in app), "no workspaceId in a v8 placement");
    assert.ok(!("unplaceable" in app));
  }
});

test("toRecorded excludes a guest: workspace 13 on a block-0 monitor", () => {
  const live = layoutOf([
    { identityId: "slack", occurrence: 1, monitorDescription: LAPTOP, workspaceId: 13, floating: false, group: null, at: null, size: null },
    { identityId: "gmail", occurrence: 0, monitorDescription: LAPTOP, workspaceId: 3, floating: false, group: null, at: null, size: null }
  ]);
  const out = slots.toRecorded(live, docked, [laptop, aoc]);
  assert.deepStrictEqual(out.excluded, [
    { identityId: "slack", occurrence: 1, reason: "workspace-guest", workspaceId: 13, monitorDescription: LAPTOP }
  ]);
  assert.strictEqual(out.layout.apps.length, 1);
  assert.strictEqual(out.layout.apps[0].identityId, "gmail");
  assert.strictEqual(out.layout.apps[0].slot, 3);
});

test("toRecorded: a workspace in either twin's block is not a guest", () => {
  const app = (ws) => ({ identityId: "slack", occurrence: 0, monitorDescription: "D", workspaceId: ws, floating: false, group: null, at: null, size: null });
  const out = slots.toRecorded(layoutOf([app(23), app(13), app(33), app(3)]), TWINS, [laptop, twin1, twin2]);
  assert.deepStrictEqual(out.layout.apps.map((a) => a.slot), [3, 3]);
  assert.deepStrictEqual(out.excluded.map((e) => e.workspaceId), [33, 3]);
});

test("toRecorded: with the monitor's block unknown there is no guest check", () => {
  const live = layoutOf([{ identityId: "slack", occurrence: 0, monitorDescription: AOC, workspaceId: 23, floating: false, group: null, at: null, size: null }]);
  const out = slots.toRecorded(live, slots.parseBlocks(""), [laptop, aoc]);
  assert.deepStrictEqual(out.excluded, []);
  assert.strictEqual(out.layout.apps[0].slot, 3);
  assert.ok(!("workspaceId" in out.layout.apps[0]));
});

test("toRecorded: a junk workspace id records slot null", () => {
  const live = layoutOf([{ identityId: "slack", occurrence: 0, monitorDescription: AOC, workspaceId: -98, floating: false, group: null, at: null, size: null }]);
  const out = slots.toRecorded(live, docked, [laptop, aoc]);
  assert.deepStrictEqual(out.excluded, []);
  assert.strictEqual(out.layout.apps[0].slot, null);
});

// --- workspaceMonitors -------------------------------------------------------

test("workspaceMonitors includes non-empty and empty active workspaces, id > 0", () => {
  const clients = [
    { address: "0x1", monitor: 0, workspace: { id: 2, name: "2" } },
    { address: "0x2", monitor: 1, workspace: { id: 13, name: "13" } },
    { address: "0x3", monitor: 0, workspace: { id: -98, name: "special:magic" } },
    { address: "0x4", monitor: 7, workspace: { id: 4, name: "4" } }
  ];
  const map = slots.workspaceMonitors(clients, [laptop, aoc]);
  assert.deepStrictEqual(map, { "1": "eDP-1", "2": "eDP-1", "11": "DP-1", "13": "DP-1" });
  assert.deepStrictEqual(slots.workspaceMonitors(null, null), {});
});

test("workspaceMonitors: a monitor's active workspace wins over a client's monitor", () => {
  const clients = [{ address: "0x1", monitor: 0, workspace: { id: 11, name: "11" } }];
  assert.deepStrictEqual(slots.workspaceMonitors(clients, [laptop, aoc]), { "1": "eDP-1", "11": "DP-1" });
});

// --- dual runtime --------------------------------------------------------------

test("Slots.js loads without module, as QML imports it", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "Slots.js"), "utf8");
  const context = {};
  vm.runInNewContext(source, context);
  assert.strictEqual(typeof context.toLive, "function");
  assert.strictEqual(context.workspaceIdFor(1, 3), 13);
  assertEs5(source);
});

// Comments and string contents removed, so prose cannot trip the guard.
function codeOf(source) {
  return source
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function assertEs5(source) {
  const code = codeOf(source);
  const banned = [
    [/\b(let|const|class|import|export)\b/, "ES6 declaration or module syntax"],
    [/=>/, "arrow function"],
    [/`/, "template literal"],
    [/\.\.\./, "spread or rest"],
    [/\bvar\s*[[{]/, "destructuring"],
    [/[{,]\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/, "shorthand method"],
    [/^\s*(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/m, "shorthand method"]
  ];
  for (const [pattern, what] of banned) {
    const hit = pattern.exec(code);
    assert.ok(!hit, "ES5 only: " + what + (hit ? " at '" + hit[0] + "'" : ""));
  }
}

test("the ES5 guard catches what it claims to", () => {
  for (const bad of [
    "for (let i = 0; i < 1; i++) {}", "const x = 1;", "var s = `t`;", "var f = (a) => a;",
    "var { a } = o;", "var [a] = o;", "var o = { m() { return 1; } };", "var o = {\n  m(a) {\n  }\n};",
    "f(...args);", "class A {}"
  ]) {
    assert.throws(() => assertEs5(bad), /ES5 only/, bad);
  }
  assertEs5("// let it be => `x`\nvar s = \"const ... =>\";\nif (a) {\n}\nfunction f(a) {\n  return a;\n}\n");
});
