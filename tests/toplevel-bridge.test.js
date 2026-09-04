// The toplevel bridge's pure half — hyprctl address to a place in the
// Quickshell.Hyprland toplevel model (tick o2x).
//
// The QML half (ToplevelBridge.qml) turns an index back into a live handle and
// cannot be tested here; what CAN be tested is every way the lookup goes wrong,
// and this plugin cares which way it went (CLAUDE.md, "Refusals are a feature"):
// a window that closed and a window whose Wayland handle has not arrived yet
// look identical to a null return, and only one of them is worth retrying.

const test = require("node:test");
const assert = require("node:assert");

const PanelModel = require("../PanelModel.js");

// One-off literals rather than tests/helpers.js IDENTITIES — nothing here is
// about identity matching, and the shared fixture is priority-ordered
// (.tick/learnings.md § Test fixtures).
const MODEL = [
  { address: "0x55c506263040", hasWayland: true },  // the hidden window, o2x
  { address: "0x55c5062bc3e0", hasWayland: true },  // the visible one
  { address: "0x7f0011223344", hasWayland: false }  // in the model, no handle yet
];

test("normalizedAddress accepts what hyprctl prints", () => {
  assert.strictEqual(PanelModel.normalizedAddress("0x55c506263040"), "0x55c506263040");
});

test("normalizedAddress adds the prefix, lowercases and trims", () => {
  assert.strictEqual(PanelModel.normalizedAddress("55C506263040"), "0x55c506263040");
  assert.strictEqual(PanelModel.normalizedAddress("  0X55C506263040 "), "0x55c506263040");
});

test("normalizedAddress rejects anything that is not an address", () => {
  ["", "   ", "address:0x1", "0xzz", "foot", "0x55c5 0x55c6", null, undefined, {}, []]
    .forEach((junk) => {
      assert.strictEqual(PanelModel.normalizedAddress(junk), "",
        "expected junk to normalize to empty: " + JSON.stringify(junk));
    });
});

test("resolveToplevels returns model indices, in the order asked", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["0x55c5062bc3e0", "0x55c506263040"]);
  assert.deepStrictEqual(plan.resolved, [
    { address: "0x55c5062bc3e0", index: 1 },
    { address: "0x55c506263040", index: 0 }
  ]);
  assert.deepStrictEqual(plan.invalid, []);
  assert.deepStrictEqual(plan.missing, []);
  assert.deepStrictEqual(plan.unmapped, []);
});

test("resolveToplevels matches an address written differently", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["55C506263040"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x55c506263040", index: 0 }]);
});

test("a well-formed address the model does not have is missing, not unmapped", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["0xdeadbeef"]);
  assert.deepStrictEqual(plan.missing, ["0xdeadbeef"]);
  assert.deepStrictEqual(plan.unmapped, []);
  assert.deepStrictEqual(plan.resolved, []);
});

test("an entry with no Wayland handle yet is unmapped, not missing", () => {
  // The distinction is the whole point: measured in the sandbox, the model
  // fills in before the handles do, and unmapped is the case worth retrying.
  const plan = PanelModel.resolveToplevels(MODEL, ["0x7f0011223344"]);
  assert.deepStrictEqual(plan.unmapped, ["0x7f0011223344"]);
  assert.deepStrictEqual(plan.missing, []);
  assert.deepStrictEqual(plan.resolved, []);
});

test("junk in the wanted list is invalid and does not stop the rest", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["not-an-address", "0x55c506263040"]);
  assert.deepStrictEqual(plan.invalid, ["not-an-address"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x55c506263040", index: 0 }]);
});

test("a repeated address is photographed once", () => {
  const plan = PanelModel.resolveToplevels(
    MODEL, ["0x55c506263040", "0X55C506263040", "0x55c506263040"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x55c506263040", index: 0 }]);
});

test("a duplicate entry in the model resolves to the first", () => {
  const stale = [
    { address: "0x1", hasWayland: true },
    { address: "0x1", hasWayland: true }
  ];
  const plan = PanelModel.resolveToplevels(stale, ["0x1"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x1", index: 0 }]);
});

test("a model entry with a junk address is skipped rather than indexed", () => {
  const junk = [{ address: "", hasWayland: true }, { address: "0x2", hasWayland: true }];
  const plan = PanelModel.resolveToplevels(junk, ["0x2"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x2", index: 1 }]);
});

test("an empty model makes every wanted address missing", () => {
  const plan = PanelModel.resolveToplevels([], ["0x1", "0x2"]);
  assert.deepStrictEqual(plan.missing, ["0x1", "0x2"]);
});

test("resolveToplevels survives junk arguments", () => {
  [null, undefined, {}, "toplevels", 7].forEach((junk) => {
    const plan = PanelModel.resolveToplevels(junk, junk);
    assert.deepStrictEqual(plan,
      { resolved: [], invalid: [], missing: [], unmapped: [] });
  });
});

test("an address that is a bare Object.prototype key is not a false hit", () => {
  // `map["constructor"]` is truthy on a bare object; the index reads through
  // `own` for exactly this reason (tick 8hp). "constructor" is not hex, so it
  // normalizes away — this pins that it does not sneak in another way.
  const plan = PanelModel.resolveToplevels(MODEL, ["constructor", "__proto__"]);
  assert.deepStrictEqual(plan.resolved, []);
  assert.deepStrictEqual(plan.invalid, ["constructor", "__proto__"]);
});

test("the refusal sentence is empty when everything resolved", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["0x55c506263040"]);
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(plan), "");
});

test("the refusal sentence names each failure kind and its count", () => {
  const plan = PanelModel.resolveToplevels(
    MODEL, ["nope", "0xdeadbeef", "0xfeedface", "0x7f0011223344"]);
  assert.strictEqual(
    PanelModel.toplevelBridgeRefusal(plan),
    "Cannot picture 1 not an address, 2 no longer open, 1 not ready to capture yet.");
});

test("the refusal sentence is defensive about junk", () => {
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(null), "");
  assert.strictEqual(PanelModel.toplevelBridgeRefusal({}), "");
});
