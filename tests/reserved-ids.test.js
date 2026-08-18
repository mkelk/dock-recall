// An identity id that collides with an Object.prototype key.
//
// The bug (tick 8hp, found by epic 4gz's correctness review): every index in
// this project is a bare `{}` keyed by an identity id, and `map[id]` on a bare
// object ANSWERS for `constructor`, `toString`, `valueOf`, `hasOwnProperty` and
// the rest whether or not anything was ever put there. So a dedupe map said
// "already seen" about an identity nobody had seen, and a lookup handed back
// `Object` where a command or a window list was expected.
//
// It is reachable without a hand edit: PanelModel.deriveIdentityId builds an id
// out of the class name's segments, so an app whose window class is
// `Constructor` produces the id `constructor` — pinned below. The state file is
// user-editable too, so any of the keys can arrive by hand.
//
// This file walks the whole family: the reader, the id generator, the launch
// repair index, the panel's rows, and the engine indexes a record and a restore
// are built out of. Each case is the SAME cause, so they are pinned together —
// a future map keyed by an identity id belongs here too.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const panel = require("../PanelModel.js");
const { makeClient, loadFixture } = require("./helpers.js");

const monitorsLaptop = loadFixture("monitors-laptop.json");
const AT = "2026-08-15T18:30:00Z";

// Every inherited key a real state file could plausibly carry. `__proto__` is
// deliberately in the list: it is the one that is not merely inherited but has
// a SETTER on Object.prototype, so a write to it is swallowed rather than
// stored — the read guard cannot help there, and what is claimed for it below
// is exactly what holds (it survives the round trip; it is not deduped).
const RESERVED = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

// ---------------------------------------------------------------- reachable

test("a window class of Constructor really does derive the id 'constructor'", () => {
  assert.strictEqual(panel.deriveIdentityId("Constructor"), "constructor");
  assert.strictEqual(panel.deriveIdentityId("org.example.Constructor"), "constructor");
});

// ------------------------------------------------------ StateModel: the read

test("an identity whose id is an Object.prototype key survives a parse/serialize round trip", () => {
  for (const id of RESERVED.concat(["__proto__"])) {
    const written = state.serializeState({
      version: state.STATE_VERSION,
      identities: [{ id: id, patterns: ["^Thing$"], titlePatterns: [], launch: "thing" }],
      layouts: {}
    });
    const parsed = state.parseState(written);

    assert.strictEqual(parsed.error, null, id + ": " + JSON.stringify(parsed));
    assert.strictEqual(parsed.state.identities.length, 1, id + " was dropped on the way in");
    assert.strictEqual(parsed.state.identities[0].id, id);
    assert.strictEqual(state.identityById(parsed.state, id).launch, "thing");
    assert.strictEqual(state.launchCommandFor(parsed.state, id), "thing");
  }
});

test("a reserved id is still deduped exactly once, like every other id", () => {
  for (const id of RESERVED) {
    const list = state.identities(state.setIdentities(state.defaultState(), [
      { id: id, patterns: ["^First$"] },
      { id: id, patterns: ["^Second$"] },
      { id: "plain", patterns: ["^Plain$"] }
    ]));
    assert.deepStrictEqual(list.map((i) => i.id), [id, "plain"], id);
    // First wins, consistent with the rest of the engine.
    assert.deepStrictEqual(list[0].patterns, ["^First$"], id);
  }
});

// ------------------------------------------------- PanelModel: the generator

test("suggestIdentity does not hand out a colliding id, and does not invent one either", () => {
  // Nothing is watched, so nothing is taken: the honest id is "constructor".
  const fresh = panel.suggestIdentity("Constructor", []);
  assert.strictEqual(fresh.id, "constructor");

  // A REAL collision still suffixes, exactly as it does for any other id.
  const taken = panel.suggestIdentity("Constructor", [{ id: "constructor", patterns: ["^Other$"] }]);
  assert.strictEqual(taken.id, "constructor-2");

  // And two of them in a row keep counting rather than looping forever.
  const twice = panel.suggestIdentity("Constructor", [
    { id: "constructor", patterns: ["^Other$"] },
    { id: "constructor-2", patterns: ["^Another$"] }
  ]);
  assert.strictEqual(twice.id, "constructor-3");
});

test("a reserved id never blocks a tick, and a tick of it is undone by the same click", () => {
  const watched = panel.toggleWatchedIdentities([], "Constructor", "");
  assert.strictEqual(watched.length, 1);
  assert.strictEqual(watched[0].id, "constructor");

  const unwatched = panel.toggleWatchedIdentities(watched, "Constructor", "constructor");
  assert.deepStrictEqual(unwatched, []);
});

// ------------------------------------------- PanelModel: the launch machinery

test("launchRepairIndex answers about a reserved id from the map, never from the prototype", () => {
  const identities = [{ id: "constructor", patterns: ["^Constructor$"], launch: "" }];

  // Nothing derived for it: no repair, no phantom command off Object.prototype.
  assert.deepStrictEqual(panel.launchRepairIndex(identities, {}), {});
  assert.strictEqual(panel.learnableCount(identities, {}), 0);
  assert.deepStrictEqual(panel.launchStateIndex(identities, {}), { constructor: "missing" });

  // Something derived for it: the repair is offered under its own id.
  const map = { constructor: "constructor-app" };
  assert.deepStrictEqual(panel.launchRepairIndex(identities, map), { constructor: "constructor-app" });
  assert.strictEqual(panel.learnableCount(identities, map), 1);
  assert.deepStrictEqual(panel.launchStateIndex(identities, map), { constructor: "derivable" });

  const filled = panel.backfillLaunchCommands(identities, map);
  assert.strictEqual(filled[0].launch, "constructor-app");
});

test("the whole launch family survives a map key that is a prototype method", () => {
  // `hasOwnProperty` is the nastiest of them: the maps' own guard is a METHOD
  // call on the map in the old code, so an entry with this id replaced the
  // function that was about to be called on it.
  const identities = [{ id: "hasOwnProperty", patterns: ["^Odd$"], launch: "" }];
  const map = { hasOwnProperty: "odd-app" };

  assert.deepStrictEqual(panel.launchRepairIndex(identities, map), { hasOwnProperty: "odd-app" });
  assert.strictEqual(panel.learnableCount(identities, map), 1);
  assert.deepStrictEqual(panel.launchAutofillIndex(identities, map), { hasOwnProperty: "odd-app" });
  assert.strictEqual(panel.autofillLaunchCommands(identities, map)[0].launch, "odd-app");
  assert.strictEqual(panel.autofillLaunchLog({ hasOwnProperty: "odd-app" }, "tick"),
    "auto-filled 1 launch command after the tick: hasOwnProperty -> odd-app");
});

test("a reserved-id identity gets its row, its hint and its tick", () => {
  const identities = [{ id: "constructor", patterns: ["^Constructor$"], launch: "" }];
  const client = makeClient({ address: "0xc0", class: "Constructor", workspace: 1 });
  const resolve = (c) => engine.matchClient(c, identities) || "";

  const rows = panel.appRows([client], monitorsLaptop, resolve, null, null, identities, {});
  const row = rows.find((r) => r.identityId === "constructor");

  assert.ok(row, JSON.stringify(rows));
  assert.strictEqual(row.watched, true);
  assert.strictEqual(row.launchState, "missing");
  assert.strictEqual(row.launchRepairable, false);
});

test("addedIdentity sees a reserved id as new rather than as already there", () => {
  const before = [];
  const after = [{ id: "constructor", patterns: ["^Constructor$"], launch: "" }];
  assert.strictEqual(panel.addedIdentity(before, after).id, "constructor");
  assert.strictEqual(panel.addedIdentity(after, after), null);
});

// ---------------------------------------------------------- engine: indexes

test("a plan's launch deficits count a reserved id instead of throwing", () => {
  const plan = [
    { kind: "launch", identityId: "constructor" },
    { kind: "launch", identityId: "constructor" },
    { kind: "launch", identityId: "plain" }
  ];
  assert.deepStrictEqual(engine.launchDeficits(plan), [
    { identityId: "constructor", count: 2 },
    { identityId: "plain", count: 1 }
  ]);
  assert.strictEqual(engine.launchDeficitFor(plan, "constructor"), 2);
});

test("chosenWindows indexes a reserved id, and reading it back gives the window", () => {
  const identities = [{ id: "constructor", patterns: ["^Constructor$"] }];
  const clients = [makeClient({ address: "0xc0", class: "Constructor", workspace: 1 })];
  const chosen = engine.chosenWindows(clients, identities, monitorsLaptop);

  assert.strictEqual(engine.windowForOccurrence(chosen, "constructor", 0).address, "0xc0");
  // An id nobody indexed is still "not running", not an Object.
  assert.strictEqual(engine.windowForOccurrence(chosen, "toString", 0), null);
  assert.strictEqual(engine.windowForOccurrence(chosen, "valueOf", 0), null);
});

test("a reserved id records, drifts and gets a verdict like any other app", () => {
  const identities = [{ id: "constructor", patterns: ["^Constructor$"], launch: "" }];
  const at = makeClient({ address: "0xc0", class: "Constructor", workspace: 1 });
  const moved = makeClient({ address: "0xc0", class: "Constructor", workspace: 7 });

  const layout = engine.buildLayout([at], monitorsLaptop, identities, AT);
  assert.strictEqual(layout.apps.length, 1);
  assert.strictEqual(layout.apps[0].identityId, "constructor");

  // Unmoved: no drift.
  const clean = engine.driftOf([at], monitorsLaptop, layout, identities);
  assert.strictEqual(clean.summary.drifted, 0);
  assert.strictEqual(clean.apps[0].status, "ok");

  // Moved: one drifted row, and a verdict that names it.
  const report = engine.driftOf([moved], monitorsLaptop, layout, identities);
  assert.strictEqual(report.summary.drifted, 1);
  assert.strictEqual(report.apps[0].identityId, "constructor");
  assert.strictEqual(report.apps[0].status, "drifted");

  const verdicts = engine.verdictsFor(report, []);
  assert.strictEqual(verdicts.length, 1);
  assert.strictEqual(verdicts[0].identityId, "constructor");
  // The count that used to come back as a concatenated string off Object.
  assert.strictEqual(verdicts[0].instances, 1);
  assert.strictEqual(verdicts[0].text, "on the wrong workspace");

  // And a restore has something to say about it.
  const plan = engine.planRestore([moved], monitorsLaptop, layout, identities);
  assert.ok(plan.length > 0);
});

test("matchLayout pairs a reserved id's recorded entry to its live window", () => {
  const identities = [{ id: "constructor", patterns: ["^Constructor$"] }];
  const one = makeClient({ address: "0xc0", class: "Constructor", workspace: 1 });
  const two = makeClient({ address: "0xc1", class: "Constructor", workspace: 2 });
  const layout = engine.buildLayout([one, two], monitorsLaptop, identities, AT);

  const matched = engine.matchLayout([one, two], monitorsLaptop, layout, identities);
  const addresses = layout.apps.map((app, i) => matched.clientByEntry
    ? (matched.clientByEntry[i] && matched.clientByEntry[i].address)
    : null);
  assert.deepStrictEqual(addresses.slice().sort(), ["0xc0", "0xc1"]);
});
