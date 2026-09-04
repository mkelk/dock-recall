// The toplevel bridge's pure half — hyprctl address to a place in the
// Quickshell.Hyprland toplevel model (ticks o2x, w25).
//
// ToplevelBridge.qml owns two things a test here cannot reach: a live QObject,
// and the CLOCK. Everything else was pushed down into PanelModel so it could be
// pinned — the snapshot copy, the argument guards, the readiness predicate and
// the moved-model recheck — because `ready()`'s original bug (false forever for
// a closed window, blind to `invalid`) is exactly what a test would have caught
// and QML had none.
//
// This plugin cares WHICH way a lookup went wrong (CLAUDE.md, "Refusals are a
// feature"): a window that closed, a window whose handle has not arrived, and a
// model that has not finished loading all look identical to a null return, and
// only one of those three is permanent.

const test = require("node:test");
const assert = require("node:assert");

const PanelModel = require("../PanelModel.js");

// THE MODEL'S OWN DIALECT: `HyprlandToplevel.address` carries NO `0x` prefix
// ("562be03ac9a0"), where `hyprctl clients` prints one ("0x562be03ac9a0") —
// measured in the nested sandbox, tick o2x. That asymmetry is the entire reason
// `normalizedAddress` exists, so the fixture has to speak the dialect the real
// model speaks; written in the hyprctl form it exercised nothing, and dropping
// normalization on the model side left every test green (tick w25).
//
// One-off literals rather than tests/helpers.js IDENTITIES — nothing here is
// about identity matching, and the shared fixture is priority-ordered
// (.tick/learnings.md § Test fixtures).
const MODEL = [
  { address: "55c506263040", hasWayland: true },  // the hidden window, o2x
  { address: "55c5062bc3e0", hasWayland: true },  // the visible one
  { address: "7f0011223344", hasWayland: false }  // in the model, no handle yet
];

// What a caller asks with: the hyprctl spelling, prefix and all.
const HIDDEN = "0x55c506263040";
const VISIBLE = "0x55c5062bc3e0";
const UNMAPPED = "0x7f0011223344";

// ---------------------------------------------------------------------------
// normalizedAddress
// ---------------------------------------------------------------------------

test("normalizedAddress accepts what hyprctl prints", () => {
  assert.strictEqual(PanelModel.normalizedAddress("0x55c506263040"), "0x55c506263040");
});

test("normalizedAddress adds the prefix, lowercases and trims", () => {
  assert.strictEqual(PanelModel.normalizedAddress("55C506263040"), "0x55c506263040");
  assert.strictEqual(PanelModel.normalizedAddress("  0X55C506263040 "), "0x55c506263040");
});

test("normalizedAddress strips leading zeros, so one window has one spelling", () => {
  // Nothing prints these today. The point is that if anything ever does, the
  // padded form must not land in the bucket callers are told not to retry.
  assert.strictEqual(PanelModel.normalizedAddress("0000562be03ac9a0"), "0x562be03ac9a0");
  assert.strictEqual(PanelModel.normalizedAddress("0x0000562be03ac9a0"), "0x562be03ac9a0");
  assert.strictEqual(PanelModel.normalizedAddress("0x0"), "0x0");
  assert.strictEqual(PanelModel.normalizedAddress("0x0000"), "0x0");
});

test("normalizedAddress rejects anything that is not a string", () => {
  // `trim()` stringifies, so this used to turn the number 1234 into the address
  // "0x1234" and the caller's bug into a silent success.
  [1234, 0x55c5, true, null, undefined, {}, [], ["0x1"]].forEach((junk) => {
    assert.strictEqual(PanelModel.normalizedAddress(junk), "",
      "expected a non-string to normalize to empty: " + JSON.stringify(junk));
  });
});

test("normalizedAddress rejects anything that is not an address", () => {
  ["", "   ", "address:0x1", "0xzz", "foot", "0x55c5 0x55c6", "0x"]
    .forEach((junk) => {
      assert.strictEqual(PanelModel.normalizedAddress(junk), "",
        "expected junk to normalize to empty: " + JSON.stringify(junk));
    });
});

// ---------------------------------------------------------------------------
// toplevelSnapshot — the copy out of the QML model
// ---------------------------------------------------------------------------

test("toplevelSnapshot copies a QML-style sequence that is not an Array", () => {
  // `Hyprland.toplevels.values` indexes and has `.length` but is NOT an Array
  // to Object.prototype. A guard that demanded an Array would see an empty
  // model forever, and every window would read as gone.
  const sequence = {
    length: 2,
    0: { address: "55c506263040", wayland: {} },
    1: { address: "7f0011223344", wayland: null }
  };
  assert.deepStrictEqual(PanelModel.toplevelSnapshot(sequence), [
    { address: "55c506263040", hasWayland: true },
    { address: "7f0011223344", hasWayland: false }
  ]);
});

test("toplevelSnapshot is empty rather than broken when the model is not there", () => {
  [null, undefined, {}, 7, "toplevels", { length: NaN }, { length: -1 }]
    .forEach((junk) => {
      assert.deepStrictEqual(PanelModel.toplevelSnapshot(junk), [],
        "expected an empty snapshot for " + JSON.stringify(junk));
    });
});

test("toplevelSnapshot survives a hole in the model", () => {
  assert.deepStrictEqual(
    PanelModel.toplevelSnapshot([null, { address: 7, wayland: {} }]),
    [{ address: "", hasWayland: false }, { address: "", hasWayland: true }]);
});

// ---------------------------------------------------------------------------
// resolveToplevels — the matching
// ---------------------------------------------------------------------------

test("resolveToplevels returns model indices, in the order asked", () => {
  const plan = PanelModel.resolveToplevels(MODEL, [VISIBLE, HIDDEN]);
  assert.deepStrictEqual(plan.resolved, [
    { address: VISIBLE, index: 1 },
    { address: HIDDEN, index: 0 }
  ]);
  assert.deepStrictEqual(plan.invalid, []);
  assert.deepStrictEqual(plan.missing, []);
  assert.deepStrictEqual(plan.unmapped, []);
});

test("the model's own unprefixed dialect matches the hyprctl one", () => {
  // The regression this pins: drop `normalizedAddress` from the MODEL side and
  // every entry becomes unfindable. With a `0x`-prefixed fixture that change
  // was invisible.
  assert.strictEqual(MODEL[0].address.indexOf("0x"), -1,
    "the fixture must speak the model's dialect, not hyprctl's");
  const plan = PanelModel.resolveToplevels(MODEL, [HIDDEN]);
  assert.deepStrictEqual(plan.resolved, [{ address: HIDDEN, index: 0 }]);
  assert.deepStrictEqual(plan.missing, []);
});

test("resolveToplevels matches an address written differently", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["55C506263040"]);
  assert.deepStrictEqual(plan.resolved, [{ address: HIDDEN, index: 0 }]);
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
  const plan = PanelModel.resolveToplevels(MODEL, [UNMAPPED]);
  assert.deepStrictEqual(plan.unmapped, [UNMAPPED]);
  assert.deepStrictEqual(plan.missing, []);
  assert.deepStrictEqual(plan.resolved, []);
});

test("junk in the wanted list is invalid and does not stop the rest", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["not-an-address", HIDDEN]);
  assert.deepStrictEqual(plan.invalid, ["not-an-address"]);
  assert.deepStrictEqual(plan.resolved, [{ address: HIDDEN, index: 0 }]);
});

test("a repeated address is photographed once", () => {
  const plan = PanelModel.resolveToplevels(
    MODEL, [HIDDEN, "0X55C506263040", HIDDEN]);
  assert.deepStrictEqual(plan.resolved, [{ address: HIDDEN, index: 0 }]);
});

test("a repeated junk string is one bug, not two", () => {
  const plan = PanelModel.resolveToplevels(MODEL, ["nope", "nope", " nope "]);
  assert.deepStrictEqual(plan.invalid, ["nope"]);
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(plan),
    "Cannot picture 1 not an address.");
});

test("a duplicate entry in the model resolves to the first", () => {
  const stale = [
    { address: "1", hasWayland: true },
    { address: "1", hasWayland: true }
  ];
  const plan = PanelModel.resolveToplevels(stale, ["0x1"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x1", index: 0 }]);
});

test("a model entry with a junk address is skipped rather than indexed", () => {
  const junk = [{ address: "", hasWayland: true }, { address: "2", hasWayland: true }];
  const plan = PanelModel.resolveToplevels(junk, ["0x2"]);
  assert.deepStrictEqual(plan.resolved, [{ address: "0x2", index: 1 }]);
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

// ---------------------------------------------------------------------------
// toplevelAddressListRefusal — the guard on the caller's own argument
// ---------------------------------------------------------------------------

test("a real array of addresses is accepted, empty included", () => {
  assert.strictEqual(PanelModel.toplevelAddressListRefusal([]), "");
  assert.strictEqual(PanelModel.toplevelAddressListRefusal([HIDDEN]), "");
});

test("a QML sequence for the addresses is refused out loud, not silently emptied", () => {
  // The hazard the `entries` side has been defended against since o2x, on the
  // side that was not: a QVariant-wrapped sequence used to make a whole batch
  // return {resolved:[],…} with refusal "" — "nothing to do, everything fine".
  const sequence = { length: 2, 0: HIDDEN, 1: VISIBLE };
  const refusal = PanelModel.toplevelAddressListRefusal(sequence);
  assert.match(refusal, /QML sequence/);
  assert.match(refusal, /Copy it out/);
});

test("no address list at all is refused with a different sentence", () => {
  [null, undefined, {}, 7, "0x55c506263040"].forEach((junk) => {
    assert.strictEqual(PanelModel.toplevelAddressListRefusal(junk),
      "Cannot picture anything: no list of addresses was given.");
  });
});

// ---------------------------------------------------------------------------
// classifyToplevels — the taxonomy, with time folded in
// ---------------------------------------------------------------------------

test("an empty model is PENDING, not missing, while it is still filling", () => {
  // The blocker this replaces: `Hyprland.toplevels` is empty for about a second
  // after every shell starts, so an unsettled empty model put live windows into
  // the bucket the header said was not worth retrying. A consumer honouring
  // that refused to capture anything, permanently.
  const verdict = PanelModel.classifyToplevels([], [HIDDEN, VISIBLE], false);
  assert.deepStrictEqual(verdict.pending, [HIDDEN, VISIBLE]);
  assert.deepStrictEqual(verdict.gone, []);
  assert.strictEqual(verdict.decided, false, "an unsettled model decides nothing");
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(verdict),
    "Cannot picture 2 not ready to capture yet.");
});

test("the same empty model is GONE once it has settled", () => {
  const verdict = PanelModel.classifyToplevels([], [HIDDEN, VISIBLE], true);
  assert.deepStrictEqual(verdict.gone, [HIDDEN, VISIBLE]);
  assert.deepStrictEqual(verdict.pending, []);
  assert.strictEqual(verdict.decided, true, "a settled answer is final");
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(verdict),
    "Cannot picture 2 no longer open.");
});

test("a partly filled model does not condemn the windows it has not reached", () => {
  // The model fills INCREMENTALLY. A window present in hyprctl but not yet in
  // the toplevel model is pending until the model stops moving.
  const half = [MODEL[0]];
  const verdict = PanelModel.classifyToplevels(half, [HIDDEN, VISIBLE], false);
  assert.deepStrictEqual(verdict.resolved, [{ address: HIDDEN, index: 0 }]);
  assert.deepStrictEqual(verdict.pending, [VISIBLE]);
  assert.deepStrictEqual(verdict.gone, []);
  assert.strictEqual(verdict.decided, false);
});

test("a handle that has not arrived is pending whether or not the model settled", () => {
  [false, true].forEach((settled) => {
    const verdict = PanelModel.classifyToplevels(MODEL, [UNMAPPED], settled);
    assert.deepStrictEqual(verdict.pending, [UNMAPPED],
      "unmapped is retryable regardless of settling (settled=" + settled + ")");
    assert.strictEqual(verdict.decided, false);
  });
});

test("decided is not the same question as ok", () => {
  const good = PanelModel.classifyToplevels(MODEL, [HIDDEN], true);
  assert.strictEqual(good.decided, true);
  assert.strictEqual(good.ok, true);

  // A closed window: nothing left to wait for, and nothing worked.
  const closed = PanelModel.classifyToplevels(MODEL, ["0xdeadbeef"], true);
  assert.strictEqual(closed.decided, true, "a closed window is not false forever");
  assert.strictEqual(closed.ok, false);

  // Junk: permanent too, and it must not be invisible to the predicate the way
  // it was when `ready()` gated on `missing` alone.
  const junk = PanelModel.classifyToplevels(MODEL, ["junk", HIDDEN], true);
  assert.strictEqual(junk.decided, true);
  assert.strictEqual(junk.ok, false, "invalid must not read as success");
});

test("an empty ask is decided and ok, and says so with asked", () => {
  const verdict = PanelModel.classifyToplevels(MODEL, [], true);
  assert.strictEqual(verdict.decided, true, "ready([]) has a defined answer: true");
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.asked, 0, "asked is how you tell nothing from everything");
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(verdict), "");
});

test("asked counts distinct addresses understood, not raw arguments", () => {
  const verdict = PanelModel.classifyToplevels(
    MODEL, [HIDDEN, HIDDEN, "junk", "junk", UNMAPPED, "0xdeadbeef"], true);
  assert.strictEqual(verdict.asked, 4);
  assert.strictEqual(verdict.settled, true);
});

test("classifyToplevels survives junk arguments", () => {
  [null, undefined, {}, "toplevels", 7].forEach((junk) => {
    const verdict = PanelModel.classifyToplevels(junk, junk, junk);
    assert.deepStrictEqual(verdict.pending, []);
    assert.deepStrictEqual(verdict.gone, []);
    assert.strictEqual(verdict.asked, 0);
    assert.strictEqual(verdict.decided, true);
  });
});

// ---------------------------------------------------------------------------
// toplevelHandleStillValid — the moved-model recheck
// ---------------------------------------------------------------------------

test("a resolved index still pointing at its own window is valid", () => {
  const want = { address: HIDDEN, index: 0 };
  assert.strictEqual(
    PanelModel.toplevelHandleStillValid(want, "55c506263040", true), true);
});

test("a REORDERED model does not hand back the wrong window's handle", () => {
  // The subtle one: checking only that the row still has a `wayland` handle
  // passes for a row that is now a DIFFERENT window, and the caller would
  // photograph that window under the address it asked for with no way to tell.
  const want = { address: HIDDEN, index: 0 };
  assert.strictEqual(
    PanelModel.toplevelHandleStillValid(want, "55c5062bc3e0", true), false);
});

test("a row that lost its handle, or vanished, is not valid", () => {
  const want = { address: HIDDEN, index: 0 };
  assert.strictEqual(
    PanelModel.toplevelHandleStillValid(want, "55c506263040", false), false);
  assert.strictEqual(PanelModel.toplevelHandleStillValid(want, "", false), false);
  assert.strictEqual(PanelModel.toplevelHandleStillValid(null, "55c506263040", true), false);
});

// ---------------------------------------------------------------------------
// toplevelBridgeRefusal
// ---------------------------------------------------------------------------

test("the refusal sentence is empty when everything resolved", () => {
  const verdict = PanelModel.classifyToplevels(MODEL, [HIDDEN], true);
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(verdict), "");
});

test("the refusal sentence names each failure kind and its count", () => {
  const verdict = PanelModel.classifyToplevels(
    MODEL, ["nope", "0xdeadbeef", "0xfeedface", UNMAPPED], true);
  assert.strictEqual(
    PanelModel.toplevelBridgeRefusal(verdict),
    "Cannot picture 1 not an address, 2 no longer open, 1 not ready to capture yet.");
});

test("the refusal says so when the pending ones ran out of time", () => {
  const verdict = PanelModel.classifyToplevels(MODEL, [UNMAPPED], true);
  assert.strictEqual(
    PanelModel.toplevelBridgeRefusal(verdict, 5000),
    "Cannot picture 1 still not ready to capture after 5000ms.");
});

test("a raw plan handed to the refusal still refuses out loud", () => {
  // `resolveToplevels` has no `gone`/`pending`; falling through to "" there
  // would turn a lost window into a silent success.
  const plan = PanelModel.resolveToplevels(MODEL, ["0xdeadbeef", UNMAPPED]);
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(plan),
    "Cannot picture 1 no longer open, 1 not ready to capture yet.");
});

test("the refusal sentence is defensive about junk", () => {
  assert.strictEqual(PanelModel.toplevelBridgeRefusal(null), "");
  assert.strictEqual(PanelModel.toplevelBridgeRefusal({}), "");
  assert.strictEqual(PanelModel.toplevelBridgeRefusal({}, "later"), "");
});

// ---------------------------------------------------------------------------
// `decided` and `ok` have ONE definition (tick md1)
// ---------------------------------------------------------------------------

test("the bridge re-derives decided/ok with the same function classifyToplevels used", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "ToplevelBridge.qml"), "utf8");

  // THE BUG: `evaluate()` computed both again, in different text, right beside
  // the copy the tests above pin — because its handle re-check can move a
  // resolved entry into `pending` after the classification is done. Two
  // derivations of one rule is two rules, and only one of them was tested: the
  // tested source and the running source could differ with nothing saying so.
  assert.ok(source.indexOf("PanelModel.applyToplevelVerdictFlags(verdict, handles.length)") !== -1,
    "ToplevelBridge no longer derives decided/ok through the shared function");
  assert.strictEqual(source.indexOf("verdict.decided ="), -1,
    "ToplevelBridge writes `decided` itself again — that is the second spelling");
  assert.strictEqual(source.indexOf("verdict.ok ="), -1,
    "ToplevelBridge writes `ok` itself again — that is the second spelling");
});

test("the shared derivation answers what both callers need", () => {
  // Without a handle count — classifyToplevels' question. A clean
  // classification is decided and ok.
  const clean = PanelModel.classifyToplevels(MODEL, [VISIBLE], true);
  assert.strictEqual(clean.decided, true);
  assert.strictEqual(clean.ok, true);

  // WITH a handle count — the bridge's extra requirement: every window that was
  // asked about produced a live handle. One short and `ok` goes false while
  // `decided` stays true, which is exactly the state the handle re-check
  // produces and the pair the bridge's refusal reads.
  const short = PanelModel.applyToplevelVerdictFlags(
    PanelModel.classifyToplevels(MODEL, [VISIBLE], true), 0);
  assert.strictEqual(short.decided, true);
  assert.strictEqual(short.ok, false);

  // And a pending entry is undecided whatever the handles say.
  const pending = PanelModel.applyToplevelVerdictFlags(
    PanelModel.classifyToplevels(MODEL, [UNMAPPED], false), 0);
  assert.strictEqual(pending.decided, false);
  assert.strictEqual(pending.ok, false);

  // It MUTATES and returns the same object, which is what lets the bridge apply
  // it to a verdict it has already been pushing into.
  const verdict = PanelModel.classifyToplevels(MODEL, [VISIBLE], true);
  assert.strictEqual(PanelModel.applyToplevelVerdictFlags(verdict, 1), verdict);
});
