// groupbar.test.js — the swap read-back's tile box (tick aa2).
//
// The desk's group:groupbar:height is 22, not the 21 the code once assumed, and
// the read can land mid-animation: a false "Restore failed" came from a 7px miss
// on a swap that had landed. The height is read from hyprctl and the compare is
// banded per edge.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../engine.js");

const SERVICE = fs.readFileSync(path.join(__dirname, "..", "Service.qml"), "utf8");

test("parseGroupbarHeight: the getoption answer, or null", () => {
  assert.strictEqual(engine.parseGroupbarHeight('{"option":"group:groupbar:height","int":22,"set":true}'), 22);
  assert.strictEqual(engine.parseGroupbarHeight('{"int":33}'), 33);
  for (const bad of ["", "nope", "{}", '{"int":0}', '{"int":-3}', '{"int":2.5}', '{"int":"22"}', "null", "[22]"]) {
    assert.strictEqual(engine.parseGroupbarHeight(bad), null, bad);
  }
});

test("tileBoxesMatch: the desk's false miss (7px) passes, a real miss does not", () => {
  // desk-gate 2026-11-15: read [2522,45] 1056x843, wanted [2522,38] 1056x850
  const wanted = { at: [2522, 38], size: [1056, 850] };
  const read = { at: [2522, 45], size: [1056, 843] };
  assert.ok(engine.tileBoxesMatch(wanted, read, engine.TILE_BOX_TOLERANCE_PX));
  assert.ok(engine.tileBoxesMatch(wanted, read), "the default band is the engine's");
  assert.ok(engine.tileBoxesMatch(wanted, { at: [2522, 46], size: [1056, 842] }, 8), "8px per edge is inside");
  assert.ok(!engine.tileBoxesMatch(wanted, { at: [2522, 47], size: [1056, 841] }, 8), "9px is outside");
  assert.ok(!engine.tileBoxesMatch(wanted, { at: [100, 38], size: [1056, 850] }), "another tile");
  assert.ok(!engine.tileBoxesMatch(wanted, { at: [2522, 38], size: [500, 850] }), "half the width");
  assert.ok(!engine.tileBoxesMatch(wanted, null));
  assert.ok(!engine.tileBoxesMatch(wanted, { at: [1], size: [2, 3] }));
});

test("the groupbar height is read from hyprctl, never a constant, and the swap compares banded", () => {
  assert.ok(!/readonly property int groupbarPx/.test(SERVICE), "no readonly groupbar constant");
  assert.ok(SERVICE.indexOf('["hyprctl", "getoption", "group:groupbar:height", "-j"]') !== -1);
  assert.ok(/Engine\.parseGroupbarHeight\(groupbarOut\.text\)/.test(SERVICE));
  assert.ok(/root\.groupbarRead = false/.test(SERVICE), "the cache is dropped at each cycle start");
  assert.ok(/function executeSwap\(op, outcome, done\) \{\s*root\.readGroupbar\(/.test(SERVICE),
    "the swap reads the height before its tile boxes");
  assert.ok(SERVICE.indexOf("Engine.tileBoxesMatch(wantedRect, afterRect, Engine.TILE_BOX_TOLERANCE_PX)") !== -1,
    "the read-back uses the banded compare");
  assert.ok(SERVICE.indexOf("check(1)") !== -1, "one settle re-read before calling a miss");
});
