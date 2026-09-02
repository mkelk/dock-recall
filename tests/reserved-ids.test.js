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
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const panel = require("../PanelModel.js");
const { makeClient, loadFixture } = require("./helpers.js");

const monitorsLaptop = loadFixture("monitors-laptop.json");
const AT = "2026-08-15T18:30:00Z";

// Every inherited key a real state file could plausibly carry. `__proto__` is
// deliberately in the list, and it is the one the read guard cannot repair: it
// is a SETTER on Object.prototype rather than an inherited value, so a write to
// it stores nothing and a read of it answers with the prototype object. What is
// pinned for it is the STATE-MODEL half — it survives the round trip, and it is
// not deduped. The engine half does not hold, and the last test in this file
// pins that honestly rather than leaving the claim to a comment.
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

// ----------------------------------------------- the maps that were still QML
//
// Tick v29 / finding A8. The 8hp sweep fixed every map node could reach and
// stopped at the QML boundary, so three bare-object dedupes keyed by exactly
// these strings survived in Panel.qml and Service.qml — where a node test
// cannot see them and `own()` was never called:
//
//   Panel.qml runningIdentityIds       `seen[id]`   — identity ids. An app whose
//     class is `Constructor` derives the id `constructor`; the map answered
//     "already seen" the first time it was seen, so the chip said NOT RUNNING
//     about a window sitting right there.
//   Service.qml identitiesForAddresses `seen[id]`   — the same, on the path that
//     turns an op's window addresses into the app names a verdict reports. The
//     app vanished from its own restore diagnostics.
//   Service.qml launchedClassesSince   `seen[name]` — window CLASS names, which
//     are whatever the app calls itself. A launch that timed out reported "no
//     new window appeared at all" while a `constructor`-classed one was there.
//     (That caller folded into engine.launchTimeoutDiagnosis in tick ql5; the
//     dedupe it reads is still engine.newClassesSince, pinned below.)
//
// The fix is not another guard in QML: none of this was QML's to decide. Each
// is a pure function of a client list now, tested here, and the QML is a call.

const RUNNING_IDENTITIES = [
  { id: "constructor", patterns: ["^Constructor$"] },
  { id: "terminal", patterns: ["^foot$"] }
];

test("runningIdentityIds does not drop an identity whose id is an Object.prototype key", () => {
  for (const id of RESERVED) {
    const identities = [{ id: id, patterns: ["^Thing$"] }, { id: "terminal", patterns: ["^foot$"] }];
    const clients = [
      makeClient({ address: "0x1", class: "Thing" }),
      makeClient({ address: "0x2", class: "foot" })
    ];
    assert.deepStrictEqual(engine.runningIdentityIds(clients, identities), [id, "terminal"],
      id + " was deduped away the first time it was seen");
  }
});

test("runningIdentityIds still dedupes, keeps first-seen order and skips unmatched windows", () => {
  const clients = [
    makeClient({ address: "0x1", class: "foot" }),
    makeClient({ address: "0x2", class: "Constructor" }),
    makeClient({ address: "0x3", class: "Constructor" }),
    makeClient({ address: "0x4", class: "nothing-watches-this" }),
    makeClient({ address: "0x5", class: "foot" })
  ];
  assert.deepStrictEqual(engine.runningIdentityIds(clients, RUNNING_IDENTITIES),
    ["terminal", "constructor"]);
  assert.deepStrictEqual(engine.runningIdentityIds([], RUNNING_IDENTITIES), []);
  assert.deepStrictEqual(engine.runningIdentityIds(clients, []), []);
  assert.deepStrictEqual(engine.runningIdentityIds(null, null), []);
});

test("identityIdsForAddresses does not drop a reserved id either", () => {
  const clients = [
    makeClient({ address: "0xaa", class: "Constructor" }),
    makeClient({ address: "0xbb", class: "foot" }),
    makeClient({ address: "0xcc", class: "Constructor" })
  ];
  // Two addresses of the same app, plus one of another, plus an address of no
  // window at all — the shape a multi-address op hands in.
  assert.deepStrictEqual(
    engine.identityIdsForAddresses(clients, ["0xaa", "0xcc", "0xbb", "0xff"], RUNNING_IDENTITIES),
    ["constructor", "terminal"]);
  assert.deepStrictEqual(engine.identityIdsForAddresses(clients, [], RUNNING_IDENTITIES), []);
  assert.deepStrictEqual(engine.identityIdsForAddresses(null, null, null), []);
});

test("newClassesSince lists a class named after an Object.prototype key", () => {
  const before = ["0x1"];
  const after = [
    makeClient({ address: "0x1", class: "foot" }),
    makeClient({ address: "0x2", class: "constructor" }),
    makeClient({ address: "0x3", class: "constructor" }),
    makeClient({ address: "0x4", class: "toString" })
  ];
  // The window that predates the dispatch is not "new"; the two that are share
  // a class and are named once.
  assert.deepStrictEqual(engine.newClassesSince(after, before), ["constructor", "toString"]);

  // Nothing new at all is the empty list — the caller's "no new window appeared
  // at all" branch depends on being able to tell that from a dropped name.
  assert.deepStrictEqual(engine.newClassesSince([after[0]], before), []);
  assert.deepStrictEqual(engine.newClassesSince(null, null), []);

  // A window with no class of its own falls back to initialClass.
  assert.deepStrictEqual(
    engine.newClassesSince([makeClient({ address: "0x9", class: "", initialClass: "valueOf" })], []),
    ["valueOf"]);
});

test("addressesOf and newAddressSince are the launch wait's two halves", () => {
  const before = [makeClient({ address: "0x1", class: "foot" })];
  const addresses = engine.addressesOf(before);
  assert.deepStrictEqual(addresses, ["0x1"]);

  const after = before.concat([makeClient({ address: "0x2", class: "foot" })]);
  assert.strictEqual(engine.newAddressSince(after, addresses), "0x2");
  // Every match predates the dispatch: the honest answer is "", not a window
  // the user opened an hour ago.
  assert.strictEqual(engine.newAddressSince(before, addresses), "");
  assert.strictEqual(engine.newAddressSince(null, null), "");
  assert.deepStrictEqual(engine.addressesOf(null), []);
});

test("the QML sites are wired to the pure answers and keep no map of their own", () => {
  const root = path.join(__dirname, "..");
  const panelSource = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");
  const serviceSource = fs.readFileSync(path.join(root, "Service.qml"), "utf8");

  assert.ok(/Engine\.runningIdentityIds\(/.test(panelSource),
    "Panel.qml still builds its own running-identity dedupe");
  assert.ok(/Engine\.identityIdsForAddresses\(/.test(serviceSource),
    "Service.qml still builds its own address→identity dedupe");
  // Since tick ql5 the launched-class list reaches Service.qml inside
  // engine.launchTimeoutDiagnosis, which is where the class dedupe now runs.
  assert.ok(/Engine\.launchTimeoutDiagnosis\(/.test(serviceSource),
    "Service.qml still builds its own launched-class dedupe");

  // The sweep's real claim: no bare-object map in either file is keyed by an
  // identity id or a window class any more. `seen[…]` is the shape all three
  // had, and a new one would be a new instance of the same bug.
  for (const [name, source] of [["Panel.qml", panelSource], ["Service.qml", serviceSource]]) {
    for (const line of source.split("\n")) {
      assert.ok(!/\bseen\[(id|name|identityId|className)\]/.test(line),
        name + " still dedupes an identity or class key on a bare object: " + line.trim());
    }
  }
});

// -------------------------------------------------- the one that does NOT hold
//
// `__proto__` is the key the read guard cannot repair, and the comments used to
// claim it "simply fails to be indexed rather than returning something wrong".
// It does return something wrong. Writing it to a bare object stores nothing;
// reading it back answers with the prototype object, and the engine indexes
// built on identity ids hand that to code expecting a window list.
//
// Pinned rather than fixed, and pinned as a LIMIT: the same call throws
// identically on the pre-8hp code, so this is not a regression, and nothing
// derives the id `__proto__` — PanelModel.identityIdFromTitle and
// deriveIdentityId both strip the underscores. Reaching it takes a hand-written
// layout entry. If a future change makes these calls survive, this test is the
// one to delete, deliberately.
test("a hand-written layout naming __proto__ throws, and that is a known limit", () => {
  const identities = [{ id: "__proto__", patterns: ["^Thing$"] }];
  const client = makeClient({ address: "0xp0", class: "Thing", workspace: 1 });
  const layout = {
    topologyKey: "K",
    recordedAt: AT,
    apps: [{
      identityId: "__proto__", occurrence: 0, floating: false,
      monitor: { index: 0 }, workspaceId: 1,
      geometry: { x: 0, y: 0, width: 10, height: 10 }
    }]
  };

  for (const name of ["matchLayout", "driftOf", "planRestore"]) {
    assert.throws(() => engine[name]([client], monitorsLaptop, layout, identities), TypeError,
      name + " no longer throws on a __proto__ identity id — update the comments that say it does");
  }

  // Neither the id generator nor the title-derived id can produce it, which is
  // why this stays a limit rather than a bug.
  assert.notStrictEqual(panel.deriveIdentityId("__proto__"), "__proto__");
  assert.notStrictEqual(panel.identityIdFromTitle("__proto__"), "__proto__");

  // And the state model half still holds: it round-trips and is not deduped.
  const parsed = state.parseState(state.serializeState({
    version: state.STATE_VERSION,
    identities: [{ id: "__proto__", patterns: ["^Thing$"], titlePatterns: [], launch: "thing" }],
    layouts: {}
  }));
  assert.strictEqual(parsed.state.identities.length, 1);
  assert.strictEqual(parsed.state.identities[0].id, "__proto__");
});
