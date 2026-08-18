// StateModel — the on-disk state file (~/.local/state/omarchy/dock-recall.json).
// Source of truth: the schema comment block at the top of StateModel.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const { loadFixture, IDENTITIES } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const LAPTOP_KEY = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

// The identities as the file stores them: engine identities plus a launch
// command, which is the one field the engine never looks at.
const FILE_IDENTITIES = [
  { id: "terminal", patterns: ["^foot$"], launch: "foot" },
  { id: "browser", patterns: ["^chromium$"], launch: "omarchy-launch-browser" }
];

function sampleLayout(monitors) {
  return engine.buildLayout(clientsLaptop, monitors || monitorsLaptop, IDENTITIES, AT);
}

function sampleState() {
  return state.upsertLayout(
    { version: 1, identities: FILE_IDENTITIES, layouts: {} },
    sampleLayout()
  );
}

// --------------------------------------------------------------- roundtrip

test("a default state is version 3, active, with nothing recorded", () => {
  const fresh = state.defaultState();
  assert.deepStrictEqual(fresh, { version: 3, paused: false, identities: [], layouts: {} });
  assert.strictEqual(state.STATE_VERSION, 3);
});

test("serialize -> parse round-trips a populated state byte for byte", () => {
  const original = sampleState();
  const text = state.serializeState(original);

  const result = state.parseState(text);
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.recovered, false);
  assert.deepStrictEqual(result.state, original);

  // And the text is stable: writing what we just read produces the same file,
  // so a shell restart never rewrites the file for no reason.
  assert.strictEqual(state.serializeState(result.state), text);
});

test("the serialized file is human-readable JSON with a trailing newline", () => {
  const text = state.serializeState(sampleState());
  assert.ok(text.endsWith("\n"));
  assert.ok(text.indexOf("\n  \"version\": 3") !== -1, "pretty-printed with 2-space indent");
});

test("a recorded layout survives the round trip unchanged", () => {
  const layout = sampleLayout();
  const parsed = state.parseState(state.serializeState(state.upsertLayout(state.defaultState(), layout)));
  // The stored shape is topologyKey/recordedAt/apps. buildLayout also returns
  // `excluded` (tick pqv) — its report of apps deliberately left out — which
  // normalizeLayout drops on the way in and nothing reads back off the file.
  assert.deepStrictEqual(state.layoutFor(parsed.state, LAPTOP_KEY), {
    topologyKey: layout.topologyKey,
    recordedAt: layout.recordedAt,
    apps: layout.apps
  });
});

// ------------------------------------------------------------- layoutFor

test("layoutFor hits the topology it was filed under", () => {
  const populated = sampleState();
  const layout = state.layoutFor(populated, LAPTOP_KEY);
  assert.ok(layout);
  assert.strictEqual(layout.topologyKey, LAPTOP_KEY);
  assert.strictEqual(state.hasLayoutFor(populated, LAPTOP_KEY), true);
});

test("layoutFor misses return null rather than undefined or a throw", () => {
  const populated = sampleState();
  assert.strictEqual(state.layoutFor(populated, LAPTOP_KEY + " | hw-test"), null);
  assert.strictEqual(state.layoutFor(populated, ""), null);
  assert.strictEqual(state.layoutFor(populated, undefined), null);
  assert.strictEqual(state.layoutFor(null, LAPTOP_KEY), null);
  assert.strictEqual(state.hasLayoutFor(populated, "nope"), false);
});

test("layoutFor does not answer for inherited Object properties", () => {
  // "constructor"/"toString" are on every object's prototype chain; a naive
  // lookup would hand a Function back to planRestore.
  const populated = sampleState();
  assert.strictEqual(state.layoutFor(populated, "constructor"), null);
  assert.strictEqual(state.layoutFor(populated, "toString"), null);
});

// --------------------------------------------------------------- upsert

test("upsertLayout files a layout under its own topologyKey", () => {
  const next = state.upsertLayout(state.defaultState(), sampleLayout());
  assert.deepStrictEqual(state.topologyKeys(next), [LAPTOP_KEY]);
});

test("upsertLayout REPLACES the record for a topology, it does not accumulate", () => {
  const first = state.upsertLayout(state.defaultState(), sampleLayout());
  const rerecorded = Object.assign({}, sampleLayout(), { recordedAt: "2026-08-16T09:00:00Z" });
  const second = state.upsertLayout(first, rerecorded);

  assert.deepStrictEqual(state.topologyKeys(second), [LAPTOP_KEY]);
  assert.strictEqual(state.layoutFor(second, LAPTOP_KEY).recordedAt, "2026-08-16T09:00:00Z");
});

test("upsertLayout keeps layouts for other topologies and the identity list", () => {
  const docked = Object.assign({}, sampleLayout(), { topologyKey: LAPTOP_KEY + " | hw-test" });
  const next = state.upsertLayout(sampleState(), docked);

  assert.deepStrictEqual(state.topologyKeys(next), [LAPTOP_KEY, LAPTOP_KEY + " | hw-test"]);
  assert.deepStrictEqual(next.identities, FILE_IDENTITIES);
});

test("upsertLayout returns a new object and never mutates the old one", () => {
  const before = sampleState();
  const snapshot = JSON.stringify(before);
  const after = state.upsertLayout(before, Object.assign({}, sampleLayout(), { topologyKey: "other" }));

  assert.notStrictEqual(after, before);
  assert.notStrictEqual(after.layouts, before.layouts);
  assert.strictEqual(JSON.stringify(before), snapshot);
});

test("upsertLayout ignores a layout with no topologyKey", () => {
  const before = sampleState();
  const after = state.upsertLayout(before, { topologyKey: "", apps: [] });
  assert.deepStrictEqual(state.topologyKeys(after), [LAPTOP_KEY]);
  assert.deepStrictEqual(state.upsertLayout(before, null).layouts, before.layouts);
});

test("removeLayout drops exactly one topology", () => {
  const two = state.upsertLayout(sampleState(), Object.assign({}, sampleLayout(), { topologyKey: "other" }));
  assert.deepStrictEqual(state.topologyKeys(state.removeLayout(two, "other")), [LAPTOP_KEY]);
  assert.deepStrictEqual(state.topologyKeys(state.removeLayout(two, "absent")), [LAPTOP_KEY, "other"]);
});

// ------------------------------------------------------------ identities

test("identity lookup and launch commands", () => {
  const populated = sampleState();
  assert.strictEqual(state.identityById(populated, "terminal").launch, "foot");
  assert.strictEqual(state.identityById(populated, "nope"), null);
  assert.strictEqual(state.launchCommandFor(populated, "browser"), "omarchy-launch-browser");
  // A launch-less identity reports "", never undefined: the executor tests it
  // as a string and must not dispatch `exec_cmd([[undefined]])`.
  assert.strictEqual(state.launchCommandFor(populated, "nope"), "");
});

test("identity order is preserved — it is priority order for matchClient", () => {
  const populated = sampleState();
  const roundTripped = state.parseState(state.serializeState(populated)).state;
  assert.deepStrictEqual(roundTripped.identities.map((i) => i.id), ["terminal", "browser"]);
});

test("setIdentities replaces the list and normalizes it", () => {
  const next = state.setIdentities(sampleState(), [
    { id: "editor", patterns: "^code$" },
    { patterns: ["orphan"] },
    { id: "editor", patterns: ["dupe"] }
  ]);
  assert.deepStrictEqual(next.identities, [{ id: "editor", patterns: ["^code$"], launch: "" }]);
  // Layouts are untouched by an identity edit.
  assert.deepStrictEqual(state.topologyKeys(next), [LAPTOP_KEY]);
});

// -------------------------------------------------------- tolerant parse

test("a missing or empty file parses as a fresh default", () => {
  for (const raw of ["", "   \n ", null, undefined]) {
    const result = state.parseState(raw);
    assert.deepStrictEqual(result.state, state.defaultState());
    assert.strictEqual(result.recovered, true);
    assert.ok(result.error);
  }
});

test("a corrupt file parses as a fresh default instead of throwing", () => {
  for (const raw of ['{"version": 1, "layouts":', "not json at all", "[]", '"a string"', "null"]) {
    const result = state.parseState(raw);
    assert.deepStrictEqual(result.state, state.defaultState(), "raw: " + raw);
    assert.strictEqual(result.recovered, true, "raw: " + raw);
    assert.ok(result.error, "raw: " + raw);
  }
});

test("a half-valid file keeps what is usable and repairs the rest", () => {
  const result = state.parseState(JSON.stringify({
    version: 1,
    identities: [
      { id: "terminal", patterns: ["^foot$"], launch: "foot" },
      { id: "broken", patterns: null },
      "nonsense",
      { patterns: ["no id"] }
    ],
    layouts: {
      "Laptop": { topologyKey: "Laptop", recordedAt: AT, apps: [{ identityId: "terminal", workspaceId: 1 }, null, 7] },
      "Junk": "not a layout object"
    },
    strayKey: "dropped"
  }));

  assert.strictEqual(result.recovered, false);
  assert.deepStrictEqual(result.state.identities, [
    { id: "terminal", patterns: ["^foot$"], launch: "foot" },
    { id: "broken", patterns: [], launch: "" }
  ]);
  assert.deepStrictEqual(state.topologyKeys(result.state), ["Laptop"]);
  assert.deepStrictEqual(state.layoutFor(result.state, "Laptop").apps,
    [{ identityId: "terminal", workspaceId: 1, occurrence: 0, at: null, size: null }]);
  assert.strictEqual(result.state.strayKey, undefined);
});

test("a layout missing its own topologyKey inherits the map key it was filed under", () => {
  const result = state.parseState(JSON.stringify({
    version: 1,
    identities: [],
    layouts: { "Laptop | hw-test": { recordedAt: AT, apps: [] } }
  }));
  assert.strictEqual(state.layoutFor(result.state, "Laptop | hw-test").topologyKey, "Laptop | hw-test");
});

test("an unknown version is reported but still read", () => {
  const result = state.parseState(JSON.stringify({ version: 99, identities: FILE_IDENTITIES, layouts: {} }));
  assert.strictEqual(result.recovered, false);
  assert.ok(result.error && result.error.indexOf("99") !== -1);
  assert.deepStrictEqual(result.state.identities, FILE_IDENTITIES);
});

// --------------------------------------------------- the engine contract

test("what the file stores is exactly what the engine plans from", () => {
  // The whole point of the file: read it back and the engine converges on a
  // desktop that already matches, with no ops at all.
  const populated = sampleState();
  const parsed = state.parseState(state.serializeState(populated)).state;
  const layout = state.layoutFor(parsed, LAPTOP_KEY);

  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, layout, IDENTITIES), []);
});

test("identities from the file drive the engine as-is (the extra launch field is ignored)", () => {
  const populated = sampleState();
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, populated.identities, AT);
  const terminal = layout.apps.filter((a) => a.identityId === "terminal");
  assert.strictEqual(terminal.length, 2, "both foot windows recorded under the file's own identity list");
  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, layout, populated.identities), []);
});

// ------------------------------------------ workspaceId is a NUMBER on read

// A recorded workspaceId is interpolated straight into a Lua dispatch string by
// the restore executor, which makes the state file an injection surface for
// anything that can write it. The coercion lives in normalizeLayout, so every
// reader of the file is covered by construction rather than per dispatch site.

test("normalizeWorkspaceId keeps numbers, parses numeric strings, drops the rest", () => {
  assert.strictEqual(state.normalizeWorkspaceId(7), 7);
  assert.strictEqual(state.normalizeWorkspaceId(0), 0);
  assert.strictEqual(state.normalizeWorkspaceId(-99), -99, "special workspaces are negative");
  assert.strictEqual(state.normalizeWorkspaceId("7"), 7);
  assert.strictEqual(state.normalizeWorkspaceId(" 7 "), 7);

  assert.strictEqual(state.normalizeWorkspaceId(undefined), null);
  assert.strictEqual(state.normalizeWorkspaceId(null), null);
  assert.strictEqual(state.normalizeWorkspaceId(""), null);
  assert.strictEqual(state.normalizeWorkspaceId("   "), null);
  assert.strictEqual(state.normalizeWorkspaceId("seven"), null);
  assert.strictEqual(state.normalizeWorkspaceId(NaN), null);
  assert.strictEqual(state.normalizeWorkspaceId(Infinity), null);
  assert.strictEqual(state.normalizeWorkspaceId({ id: 7 }), null);
  assert.strictEqual(state.normalizeWorkspaceId([7]), null);
  assert.strictEqual(state.normalizeWorkspaceId(true), null);
});

test("a Lua payload smuggled into workspaceId does not survive the read", () => {
  const attack = '1", follow = false }); os.execute("touch /tmp/pwned"); hl.dsp.focus({ window = "x';
  const result = state.parseState(JSON.stringify({
    version: 1,
    identities: [],
    layouts: {
      "Laptop": {
        topologyKey: "Laptop",
        recordedAt: AT,
        apps: [{ identityId: "terminal", monitorDescription: "Laptop", workspaceId: attack, floating: false, group: null }]
      }
    }
  }));

  const app = state.layoutFor(result.state, "Laptop").apps[0];
  assert.strictEqual(app.workspaceId, null, "unparseable as a number, so it becomes null");
  assert.strictEqual(state.serializeState(result.state).indexOf("os.execute"), -1,
    "and it is not written back to disk either");
});

test("a numeric-string workspaceId is repaired rather than dropped", () => {
  // The realistic corruption is a panel or a hand edit writing "3" instead of 3.
  // That app should still restore, just with a number.
  const result = state.parseState(JSON.stringify({
    version: 1,
    identities: [],
    layouts: { "Laptop": { topologyKey: "Laptop", apps: [{ identityId: "terminal", workspaceId: "3" }] } }
  }));
  assert.strictEqual(state.layoutFor(result.state, "Laptop").apps[0].workspaceId, 3);
});

test("normalizing a layout preserves placement fields this version does not know about", () => {
  const layout = state.parseState(JSON.stringify({
    version: 1,
    identities: [],
    layouts: { "Laptop": { topologyKey: "Laptop", apps: [{ identityId: "terminal", workspaceId: "2", futureField: "keep me" }] } }
  })).state.layouts["Laptop"];
  assert.deepStrictEqual(layout.apps[0],
    { identityId: "terminal", workspaceId: 2, futureField: "keep me", occurrence: 0, at: null, size: null });
});

// ------------------------------------------- schema v2: geometry and paused

// The contract added in tick xz9: every app entry carries `at`/`size` (or an
// explicit null), the root carries `paused`, and a v1 file becomes a v2 file on
// the way in without losing a byte of what it said.

test("normalizeGeometry takes a pair of finite numbers and nothing else", () => {
  assert.deepStrictEqual(state.normalizeGeometry([12, 66]), [12, 66]);
  assert.deepStrictEqual(state.normalizeGeometry([0, 0]), [0, 0], "the origin is a real position");
  assert.deepStrictEqual(state.normalizeGeometry([-1920, 40]), [-1920, 40], "a monitor left of origin");
  assert.deepStrictEqual(state.normalizeGeometry(["12", " 66 "]), [12, 66], "a hand edit that quoted the numbers");
  assert.deepStrictEqual(state.normalizeGeometry([1416.5, 822.5]), [1416.5, 822.5], "fractional scaling is not floored");

  for (const junk of [null, undefined, [], [1], [1, 2, 3], [1, "x"], [NaN, 2], [Infinity, 2], "12,66", 12, {}, [null, null]]) {
    assert.strictEqual(state.normalizeGeometry(junk), null, "junk: " + JSON.stringify(junk));
  }
});

test("the record side and the read side agree on every geometry input", () => {
  // engine.geometryPair and state.normalizeGeometry are twins in two files that
  // cannot import each other. If they ever disagree, a recording would be
  // rewritten by the very next read of the file it was written to.
  const inputs = [
    [12, 66], [0, 0], [-1920, 40], ["12", " 66 "], [1416.5, 822.5],
    null, undefined, [], [1], [1, 2, 3], [1, "x"], [NaN, 2], [Infinity, 2], "12,66", 12, {}, [null, null], [true, 1]
  ];
  for (const input of inputs) {
    assert.deepStrictEqual(
      engine.geometryPair(input),
      state.normalizeGeometry(input),
      "disagreement on: " + JSON.stringify(input)
    );
  }
});

test("a v2 state round-trips byte for byte, geometry and paused included", () => {
  const populated = state.setPaused(sampleState(), true);
  const text = state.serializeState(populated);

  const parsed = state.parseState(text);
  assert.strictEqual(parsed.error, null);
  assert.strictEqual(parsed.recovered, false);
  assert.strictEqual(parsed.migrated, false, "a v2 file is not a migration");
  assert.deepStrictEqual(parsed.state, populated);
  assert.strictEqual(state.serializeState(parsed.state), text, "writing what we read changes nothing");

  // And the geometry actually survived, rather than round-tripping as null.
  const apps = state.layoutFor(parsed.state, LAPTOP_KEY).apps;
  assert.ok(apps.length > 0);
  for (const app of apps) {
    assert.strictEqual(app.at.length, 2, app.identityId + " kept its position");
    assert.strictEqual(app.size.length, 2, app.identityId + " kept its size");
  }
});

test("paused defaults to false, and only an explicit true pauses", () => {
  assert.strictEqual(state.defaultState().paused, false);
  assert.strictEqual(state.parseState("{}").state.paused, false);
  assert.strictEqual(state.normalizeState({ paused: "yes" }).paused, false, "a truthy string is not a decision");
  assert.strictEqual(state.normalizeState({ paused: 1 }).paused, false);
  assert.strictEqual(state.normalizeState({ paused: true }).paused, true);
  assert.strictEqual(state.isPaused(state.normalizeState({ paused: true })), true);
  assert.strictEqual(state.isPaused(null), false);
});

test("setPaused returns a new state and leaves everything else alone", () => {
  const before = sampleState();
  const after = state.setPaused(before, true);
  assert.notStrictEqual(after, before, "a new object, or QML bindings never notice");
  assert.strictEqual(before.paused, false, "the input is not mutated");
  assert.strictEqual(after.paused, true);
  assert.deepStrictEqual(after.layouts, before.layouts);
  assert.deepStrictEqual(after.identities, before.identities);
  assert.strictEqual(state.setPaused(after, false).paused, false);
});

test("paused survives every other edit to the file", () => {
  // The panel toggles pause; the service records layouts and learns launch
  // commands. Neither may quietly un-pause the tool.
  const paused = state.setPaused(sampleState(), true);
  assert.strictEqual(state.upsertLayout(paused, sampleLayout(monitorsLaptop)).paused, true);
  assert.strictEqual(state.removeLayout(paused, LAPTOP_KEY).paused, true);
  assert.strictEqual(state.setIdentities(paused, FILE_IDENTITIES).paused, true);
});

// ------------------------------------------- the v1 -> v2 -> v3 migration

const V1_TEXT = fs.readFileSync(path.join(__dirname, "fixtures", "state-v1.json"), "utf8");
const V1_RAW = JSON.parse(V1_TEXT);

test("a v1 file upgrades to v3 without losing anything it said", () => {
  const result = state.parseState(V1_TEXT);

  assert.strictEqual(result.recovered, false, "an upgrade is not a recovery");
  assert.strictEqual(result.error, null, "and it is not an error either");
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 3, "the whole chain runs in one read");
  assert.strictEqual(result.state.paused, false);

  // Every identity, verbatim — including the `launch: ""` never-launch entry.
  assert.deepStrictEqual(result.state.identities, V1_RAW.identities);

  // Every layout, every app, every field the v1 file carried, unchanged.
  assert.deepStrictEqual(state.topologyKeys(result.state), Object.keys(V1_RAW.layouts).sort());
  for (const key of Object.keys(V1_RAW.layouts)) {
    const before = V1_RAW.layouts[key];
    const after = state.layoutFor(result.state, key);
    assert.strictEqual(after.topologyKey, before.topologyKey, key);
    assert.strictEqual(after.recordedAt, before.recordedAt, key);
    assert.strictEqual(after.apps.length, before.apps.length, key);
    before.apps.forEach((app, i) => {
      const upgraded = after.apps[i];
      const where = key + " app " + i + " (" + app.identityId + ")";
      assert.strictEqual(upgraded.identityId, app.identityId, where);
      assert.strictEqual(upgraded.monitorDescription, app.monitorDescription, where);
      assert.strictEqual(upgraded.workspaceId, app.workspaceId, where);
      assert.strictEqual(upgraded.floating, app.floating, where);
      assert.deepStrictEqual(upgraded.group, app.group, where);
      // The only differences, and every one of them is additive.
      assert.strictEqual(upgraded.at, null, where + " has no recorded position");
      assert.strictEqual(upgraded.size, null, where + " has no recorded size");
      assert.strictEqual(upgraded.occurrence, 0, where + " is the identity's first window");
    });
  }
});

test("the upgraded v1 file is stable: reading it twice more changes nothing", () => {
  const once = state.parseState(V1_TEXT).state;
  const written = state.serializeState(once);
  const twice = state.parseState(written);
  assert.strictEqual(twice.migrated, false, "the second read has nothing left to upgrade");
  assert.deepStrictEqual(twice.state, once);
  assert.strictEqual(state.serializeState(twice.state), written);
});

test("the upgraded v1 layouts still plan and score exactly as they did", () => {
  // The migration must be invisible to every consumer: same drift report, same
  // plan, off the upgraded record as off the raw one.
  const upgraded = state.parseState(V1_TEXT).state;
  const key = "Example Panel Co. EX-1234";
  const identities = upgraded.identities;
  const rawLayout = V1_RAW.layouts[key];
  const upgradedLayout = state.layoutFor(upgraded, key);

  const before = engine.driftOf(clientsLaptop, monitorsLaptop, rawLayout, identities);
  const after = engine.driftOf(clientsLaptop, monitorsLaptop, upgradedLayout, identities);
  assert.deepStrictEqual(after.summary, before.summary);
  assert.deepStrictEqual(
    engine.planRestore(clientsLaptop, monitorsLaptop, upgradedLayout, identities),
    engine.planRestore(clientsLaptop, monitorsLaptop, rawLayout, identities)
  );
});

test("a v1 file with junk in the new fields is repaired, never rejected", () => {
  // Nothing writes these in v1, but a hand edit or a partial write can leave
  // anything at all there, and a v1 file must NEVER fail to read.
  const mangled = JSON.parse(V1_TEXT);
  mangled.paused = "sort of";
  const key = "Example Panel Co. EX-1234";
  mangled.layouts[key].apps[0].at = "12,66";
  mangled.layouts[key].apps[1].size = [1416];
  mangled.layouts[key].apps[2].at = [null, 0];

  const result = state.parseState(JSON.stringify(mangled));
  assert.strictEqual(result.recovered, false, "still not a corrupt file");
  const apps = state.layoutFor(result.state, key).apps;
  assert.strictEqual(result.state.paused, false);
  assert.strictEqual(apps[0].at, null);
  assert.strictEqual(apps[1].size, null);
  assert.strictEqual(apps[2].at, null);
  assert.strictEqual(apps[0].workspaceId, 10, "and the rest of the entry is untouched");
});

test("a version from the FUTURE keeps its number; an older one does not", () => {
  assert.strictEqual(state.migrateVersion(1), 3, "upgraded, the whole chain");
  assert.strictEqual(state.migrateVersion(2), 3, "upgraded");
  assert.strictEqual(state.migrateVersion(3), 3);
  assert.strictEqual(state.migrateVersion(4), 4, "we did not write it, so we do not claim it");
  assert.strictEqual(state.migrateVersion(undefined), 3, "a version-less file is as old as they come");
  assert.strictEqual(state.migrateVersion("2"), 3);

  const future = state.parseState(JSON.stringify({ version: 99, identities: [], layouts: {} }));
  assert.strictEqual(future.state.version, 99);
  assert.strictEqual(future.migrated, false);
  assert.ok(future.error && future.error.indexOf("99") !== -1);
});

// --------------------------------------- schema v3: the occurrence index

// Tick xjb. `occurrence` says WHICH window of an identity an entry describes.
// It ships here as schema and migration only: nothing yet writes anything but
// 0, and the point of these tests is that turning the number on cost no file
// anything it used to say.

// A v2 file, synthesized from the v1 fixture the way the v1 -> v2 migration
// would have written it: version 2, `paused`, and real geometry on every entry.
// Its entries carry NO occurrence, which is exactly what a file written by the
// shipped v2 recorder looks like.
function syntheticV2Text() {
  const raw = JSON.parse(V1_TEXT);
  raw.version = 2;
  raw.paused = false;
  let n = 0;
  for (const key of Object.keys(raw.layouts)) {
    for (const app of raw.layouts[key].apps) {
      app.at = [10 * n, 20 * n];
      app.size = [800 + n, 600 + n];
      n += 1;
    }
  }
  return JSON.stringify(raw, null, 2) + "\n";
}

test("a v2 file upgrades to v3 by gaining occurrence 0, and nothing else moves", () => {
  const text = syntheticV2Text();
  const before = JSON.parse(text);
  const result = state.parseState(text);

  assert.strictEqual(result.recovered, false, "an upgrade is not a recovery");
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 3);
  assert.deepStrictEqual(result.state.identities, before.identities);

  for (const key of Object.keys(before.layouts)) {
    const after = state.layoutFor(result.state, key);
    assert.strictEqual(after.apps.length, before.layouts[key].apps.length, key);
    before.layouts[key].apps.forEach((app, i) => {
      const upgraded = after.apps[i];
      const where = key + " app " + i + " (" + app.identityId + ")";
      assert.strictEqual(upgraded.monitorDescription, app.monitorDescription, where);
      assert.strictEqual(upgraded.workspaceId, app.workspaceId, where);
      assert.strictEqual(upgraded.floating, app.floating, where);
      assert.deepStrictEqual(upgraded.group, app.group, where);
      assert.deepStrictEqual(upgraded.at, app.at, where + " keeps its v2 geometry");
      assert.deepStrictEqual(upgraded.size, app.size, where + " keeps its v2 size");
      // The only difference.
      assert.strictEqual(upgraded.occurrence, 0, where);
    });
  }
});

test("a v3 file re-reads byte-identical: the migration has nothing left to do", () => {
  // Both doors into v3 — a v1 file and a v2 file — and then the fixed point.
  for (const source of [V1_TEXT, syntheticV2Text()]) {
    const once = state.serializeState(state.parseState(source).state);
    const again = state.parseState(once);
    assert.strictEqual(again.migrated, false, "a v3 file is not migrated again");
    assert.strictEqual(again.error, null);
    assert.strictEqual(state.serializeState(again.state), once, "byte for byte");
  }
});

test("junk in occurrence coerces to 0 rather than costing the entry its place", () => {
  assert.strictEqual(state.normalizeOccurrence(0), 0);
  assert.strictEqual(state.normalizeOccurrence(2), 2);
  assert.strictEqual(state.normalizeOccurrence("2"), 2, "a hand edit that quoted the number");
  assert.strictEqual(state.normalizeOccurrence(" 2 "), 2);

  assert.strictEqual(state.normalizeOccurrence(-1), 0, "an occurrence is an array index");
  assert.strictEqual(state.normalizeOccurrence(-0.5), 0);
  assert.strictEqual(state.normalizeOccurrence(1.5), 0, "and a whole one");
  assert.strictEqual(state.normalizeOccurrence("1.5"), 0);
  assert.strictEqual(state.normalizeOccurrence("second"), 0);
  assert.strictEqual(state.normalizeOccurrence(""), 0);
  assert.strictEqual(state.normalizeOccurrence(undefined), 0, "a v2 entry");
  assert.strictEqual(state.normalizeOccurrence(null), 0);
  assert.strictEqual(state.normalizeOccurrence(NaN), 0);
  assert.strictEqual(state.normalizeOccurrence(Infinity), 0);
  assert.strictEqual(state.normalizeOccurrence({}), 0);
  assert.strictEqual(state.normalizeOccurrence([2]), 0);
  assert.strictEqual(state.normalizeOccurrence(true), 0);
});

test("a mangled occurrence never stops a file from reading", () => {
  const result = state.parseState(JSON.stringify({
    version: 3,
    identities: [],
    layouts: {
      "Laptop": {
        topologyKey: "Laptop",
        recordedAt: AT,
        apps: [
          { identityId: "terminal", workspaceId: 1, occurrence: -3 },
          { identityId: "terminal", workspaceId: 2, occurrence: "1" },
          { identityId: "editor", workspaceId: 3, occurrence: 2.5 }
        ]
      }
    }
  }));
  assert.strictEqual(result.recovered, false);
  const apps = state.layoutFor(result.state, "Laptop").apps;
  assert.deepStrictEqual(apps.map((a) => a.occurrence), [0, 1, 0]);
  assert.strictEqual(apps[0].workspaceId, 1, "and the rest of the entry is untouched");
});

test("the recorder writes an occurrence on every entry it produces", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  assert.ok(layout.apps.length > 0);
  for (const app of layout.apps) {
    assert.strictEqual(typeof app.occurrence, "number", app.identityId);
    assert.strictEqual(app.occurrence, state.normalizeOccurrence(app.occurrence), app.identityId);
  }
  // A single-window identity is occurrence 0 — the shape every pre-v3 file had.
  assert.strictEqual(layout.apps.filter((a) => a.identityId === "editor")[0].occurrence, 0);
});

// ------------------------------------------------- live-read: hyprctl reads

// The failure these close: a read that did not succeed used to arrive as an
// empty array, which the planner cannot tell from "no windows are open" — and
// the plan for no windows open is "launch every recorded app".

test("a good hyprctl read is reported ok with its parsed array", () => {
  const read = state.parseHyprctlArray('[{"address":"0xaaa"}]', 0, "");
  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.error, null);
  assert.deepStrictEqual(read.value, [{ address: "0xaaa" }]);
});

test("an EMPTY array is a success — a desktop really can have no windows", () => {
  const read = state.parseHyprctlArray("[]", 0, "");
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(read.value, []);
});

test("a non-zero exit fails even when stdout looks like JSON", () => {
  const read = state.parseHyprctlArray("[]", 1, "Couldn't connect to a Hyprland IPC socket");
  assert.strictEqual(read.ok, false);
  assert.deepStrictEqual(read.value, []);
  assert.ok(read.error.indexOf("exited 1") !== -1, read.error);
  assert.ok(read.error.indexOf("IPC socket") !== -1, "stderr is carried into the message: " + read.error);
});

test("empty, blank, unparseable and non-array output all fail", () => {
  const bad = ["", "   \n", undefined, null, "{", '{"not":"an array"}', "null", '"text"'];
  for (let i = 0; i < bad.length; i++) {
    const read = state.parseHyprctlArray(bad[i], 0, "");
    assert.strictEqual(read.ok, false, "should have failed: " + JSON.stringify(bad[i]));
    assert.deepStrictEqual(read.value, []);
    assert.ok(read.error, "a failed read always explains itself");
  }
});

test("an exit code the caller could not observe is not held against the read", () => {
  const read = state.parseHyprctlArray('[{"name":"eDP-1"}]', undefined, "");
  assert.strictEqual(read.ok, true);
});

// -------------------------------------------------------- live-read: groups

test("isGrouped counts a one-window group as a group", () => {
  assert.strictEqual(state.isGrouped({ address: "0xaaa", grouped: [] }), false);
  assert.strictEqual(state.isGrouped({ address: "0xaaa" }), false);
  assert.strictEqual(state.isGrouped(null), false);
  // hl.dsp.group.toggle() on a lone window produces exactly this, and it has to
  // be dissolved like any other group before a rebuild.
  assert.strictEqual(state.isGrouped({ address: "0xaaa", grouped: ["0xaaa"] }), true);
  assert.strictEqual(state.isGrouped({ address: "0xaaa", grouped: ["0xaaa", "0xbbb"] }), true);
});

test("inGroupWith only accepts the group built around the anchor", () => {
  const anchor = "0xaaa";
  const joined = { address: "0xbbb", grouped: ["0xaaa", "0xbbb"] };
  const solo = { address: "0xbbb", grouped: ["0xbbb"] };
  const elsewhere = { address: "0xbbb", grouped: ["0xbbb", "0xccc"] };

  assert.strictEqual(state.inGroupWith(joined, anchor), true);
  // The regression: a window in a group of its own IS grouped, but it has not
  // joined anything, and calling that a success abandons the remaining
  // into_group directions and leaves the recorded group unbuilt.
  assert.strictEqual(state.inGroupWith(solo, anchor), false);
  assert.strictEqual(state.inGroupWith(elsewhere, anchor), false);
  assert.strictEqual(state.inGroupWith({ address: "0xbbb", grouped: [] }, anchor), false);
  assert.strictEqual(state.inGroupWith(null, anchor), false);
  assert.strictEqual(state.inGroupWith(joined, ""), false);
});

test("the anchor itself counts as joined once it has a group", () => {
  assert.strictEqual(state.inGroupWith({ address: "0xaaa", grouped: ["0xaaa"] }, "0xaaa"), true);
  assert.strictEqual(state.inGroupWith({ address: "0xaaa", grouped: [] }, "0xaaa"), false);
});

// ------------------------------------------------------ live-read: failover

test("focus intact on a surviving monitor needs no failover", () => {
  const choice = state.pickFailoverTarget(
    [{ name: "eDP-1", focused: false }, { name: "DP-2", focused: true }],
    "DP-3"
  );
  assert.deepStrictEqual(choice, { kind: "intact", name: "DP-2" });
});

test("with focus gone, the last-focused SURVIVING monitor wins over the first listed", () => {
  const choice = state.pickFailoverTarget(
    [{ name: "eDP-1", focused: false }, { name: "DP-2", focused: false }],
    "DP-2"
  );
  assert.deepStrictEqual(choice, { kind: "failover", name: "DP-2" },
    "the screen the user was last on, not whichever one hyprctl listed first");
});

test("a last-focused monitor that left falls back to the first surviving one", () => {
  const choice = state.pickFailoverTarget(
    [{ name: "eDP-1", focused: false }, { name: "DP-2", focused: false }],
    "hw-test"
  );
  assert.deepStrictEqual(choice, { kind: "failover", name: "eDP-1" });
});

test("no last-focused monitor at all still yields a target", () => {
  assert.deepStrictEqual(
    state.pickFailoverTarget([{ name: "eDP-1", focused: false }], ""),
    { kind: "failover", name: "eDP-1" }
  );
});

test("an empty monitor list has nothing to focus", () => {
  assert.deepStrictEqual(state.pickFailoverTarget([], "eDP-1"), { kind: "none", name: "" });
  assert.deepStrictEqual(state.pickFailoverTarget(null, "eDP-1"), { kind: "none", name: "" });
});

// ------------------------------------------------------------- status file
//
// Source of truth: the status schema block in StateModel.js. These
// cover the shaping only — the service owns the FileView and the timing.

// A drift report shaped like engine.driftOf's: the laptop layout, compared
// against whatever desktop the caller hands over.
function driftAgainst(clients) {
  return engine.driftOf(clients, monitorsLaptop, sampleLayout(), IDENTITIES);
}

// -------------------------------------------------- the re-record fingerprint

test("layoutStampFor changes when a topology is re-recorded, and only then", () => {
  // The service uses this to answer ONE question on every state-file reload:
  // did the user just Record? A Record retires the previous restore's verdict
  // (the badge has to leave "Restore failed"), and ticking a chip or learning a
  // launch command — which rewrite the same file — must not.
  const before = state.upsertLayout(state.defaultState(),
    engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT));
  const stamp = state.layoutStampFor(before, LAPTOP_KEY);
  assert.ok(stamp, "a recorded topology has a stamp");

  // A different topology, and an unrecorded state, have none.
  assert.strictEqual(state.layoutStampFor(before, "Some Other Monitor"), "");
  assert.strictEqual(state.layoutStampFor(state.defaultState(), LAPTOP_KEY), "");

  // Editing the identity list does not touch the layout, so the stamp holds.
  const ticked = state.setIdentities(before, FILE_IDENTITIES);
  assert.strictEqual(state.layoutStampFor(ticked, LAPTOP_KEY), stamp);

  // Re-recording the SAME desktop a second later does change it — recordedAt is
  // the moment the user pressed the button.
  const rerecorded = state.upsertLayout(before,
    engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, "2026-08-15T19:00:00Z"));
  assert.notStrictEqual(state.layoutStampFor(rerecorded, LAPTOP_KEY), stamp);

  // …and so does recording a different set of apps at the same instant, which
  // is why the app count is part of the fingerprint.
  const fewer = state.upsertLayout(before,
    engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES.slice(0, 2), AT));
  assert.notStrictEqual(state.layoutStampFor(fewer, LAPTOP_KEY), stamp);

  // Forgetting the layout is not a re-record: the stamp goes empty, and the
  // service leaves the verdict alone (the glyph goes hollow on its own).
  assert.strictEqual(state.layoutStampFor(state.removeLayout(before, LAPTOP_KEY), LAPTOP_KEY), "");
});

test("a default status says nothing is known yet", () => {
  assert.deepStrictEqual(state.defaultStatus(), {
    topologyKey: "",
    // Unnamed rather than guessed: this model has no monitor list to humanize a
    // key with, and "" is what tells the reader to fall back on its own.
    topologyName: "",
    recorded: false,
    driftCount: 0,
    restoring: false,
    paused: false,
    // v2 (tick 97e). Nothing is waiting on an unlock until a cycle says so.
    deferredLocked: false,
    lastResult: null,
    // An empty table, not a missing one: "no app has a verdict yet" is a
    // statement the UI can render, and undefined is not.
    verdicts: []
  });
});

test("driftCount counts what a restore would ACT on: drifted plus missing", () => {
  const report = { summary: { ok: 3, drifted: 2, missing: 1, skipped: 4 } };
  // Not 2 — drifted alone would read "in sync" on a desktop where Restore
  // launches an app. Not 7 — engine.driftOf marks an app skipped precisely
  // when restore cannot touch it, and a badge counting those would never
  // reach zero while a monitor is unplugged.
  assert.strictEqual(state.driftCountOf(report), 3);
});

test("driftCount of a missing or malformed report is zero, never NaN", () => {
  assert.strictEqual(state.driftCountOf(null), 0);
  assert.strictEqual(state.driftCountOf({}), 0);
  assert.strictEqual(state.driftCountOf({ summary: {} }), 0);
  assert.strictEqual(state.driftCountOf({ summary: "no" }), 0);
});

test("a conforming desktop shapes into recorded, zero drift", () => {
  const patch = state.statusPatchFor(LAPTOP_KEY, sampleLayout(), driftAgainst(clientsLaptop));
  assert.deepStrictEqual(patch, { topologyKey: LAPTOP_KEY, recorded: true, driftCount: 0 });
});

test("a window moved off its recorded workspace shows up in driftCount", () => {
  const moved = clientsLaptop.map((client) =>
    client.class === "foot"
      ? Object.assign({}, client, { workspace: { id: 9, name: "9" } })
      : client);
  const patch = state.statusPatchFor(LAPTOP_KEY, sampleLayout(), driftAgainst(moved));
  assert.strictEqual(patch.recorded, true);
  assert.ok(patch.driftCount >= 1, "the moved window has to be counted");
});

test("no layout for the topology is recorded=false with no drift to report", () => {
  const patch = state.statusPatchFor(LAPTOP_KEY, null, driftAgainst(clientsLaptop));
  // The verdict table is CLEARED rather than left alone: with nothing recorded
  // there is nothing to have a verdict about, and the previous topology's rows
  // lingering under a hollow badge would describe a desktop that is not here.
  assert.deepStrictEqual(patch, { topologyKey: LAPTOP_KEY, recorded: false, driftCount: 0, verdicts: [] });
});

test("a caller that passes no verdicts leaves the published table alone", () => {
  // The panel's path: it overlays its own fresher drift count on the service's
  // status and has no business retiring the service's table.
  const patch = state.statusPatchFor(LAPTOP_KEY, { apps: [] }, driftAgainst(clientsLaptop));
  assert.strictEqual(patch.verdicts, undefined);

  const merged = state.mergeStatus(
    { topologyKey: LAPTOP_KEY, verdicts: [{ identityId: "slack", group: "not-joined" }] },
    patch
  );
  assert.strictEqual(merged.verdicts.length, 1);
  assert.strictEqual(merged.verdicts[0].group, "not-joined");
});

test("no resolvable topology yields NO patch at all", () => {
  // The service must publish nothing here. A patch carrying an empty key
  // would overwrite a good status with "no layout for this setup" every time
  // a read landed mid-hotplug.
  assert.strictEqual(state.statusPatchFor("", null, null), null);
  assert.strictEqual(state.statusPatchFor(null, null, null), null);
});

test("mergeStatus leaves untouched fields alone", () => {
  const previous = {
    topologyKey: LAPTOP_KEY,
    topologyName: "Laptop",
    recorded: true,
    driftCount: 3,
    restoring: false,
    paused: false,
    deferredLocked: false,
    lastResult: { ok: true, summary: "2 moved", at: AT },
    verdicts: []
  };
  // The restore cycle flips one flag and knows nothing about drift.
  const started = state.mergeStatus(previous, { restoring: true });
  assert.deepStrictEqual(started, Object.assign({}, previous, { restoring: true }));

  // …and a drift refresh must not clear the cycle's flags.
  const refreshed = state.mergeStatus(started, { topologyKey: LAPTOP_KEY, recorded: true, driftCount: 0 });
  assert.strictEqual(refreshed.restoring, true);
  assert.deepStrictEqual(refreshed.lastResult, previous.lastResult);
  assert.strictEqual(refreshed.driftCount, 0);
});

test("deferredLocked travels through the status like every other flag", () => {
  // Only an explicit true defers: a status file written by a service that had
  // never heard of the lock probe must read as "nothing is waiting".
  assert.strictEqual(state.normalizeStatus({}).deferredLocked, false);
  assert.strictEqual(state.normalizeStatus({ deferredLocked: true }).deferredLocked, true);
  for (const junk of ["true", 1, {}, [], null, "yes"]) {
    assert.strictEqual(state.normalizeStatus({ deferredLocked: junk }).deferredLocked, false,
      "coerced, never trusted: " + JSON.stringify(junk));
  }

  const deferred = state.mergeStatus(state.defaultStatus(), { deferredLocked: true });
  assert.strictEqual(deferred.deferredLocked, true);
  // A patch that does not mention it leaves it exactly where it was — the
  // unlock is what clears it, not the next drift refresh.
  assert.strictEqual(state.mergeStatus(deferred, { driftCount: 4 }).deferredLocked, true);
  assert.strictEqual(state.mergeStatus(deferred, { deferredLocked: false }).deferredLocked, false);

  // …and it survives the file.
  const round = state.parseStatus(state.serializeStatus(deferred)).status;
  assert.strictEqual(round.deferredLocked, true);

  // The GLYPH is deliberately untouched by it (see the schema note): the desk
  // really is drifted, and that is what the picture says.
  assert.strictEqual(
    state.glyphState(state.mergeStatus(deferred, { recorded: true, driftCount: 2 })),
    state.glyphState(state.mergeStatus(state.defaultStatus(), { recorded: true, driftCount: 2 }))
  );
});

test("the slow drift poll runs only where a read would tell us something", () => {
  // It exists for one compositor limitation: an in-place float drag emits no
  // event (state-matrix §4b), so the badge needs a floor under its staleness.
  // Everywhere else it must be OFF — an idle unrecorded desk owes this plugin
  // zero hyprctl reads.
  const status = (patch) => state.mergeStatus(state.defaultStatus(), patch);

  assert.strictEqual(state.shouldSlowPoll(status({ recorded: true })), true);

  // Nothing recorded for this topology: nothing to be drifted from.
  assert.strictEqual(state.shouldSlowPoll(status({})), false);
  assert.strictEqual(state.shouldSlowPoll(status({ recorded: true, driftCount: 3 })), true);
  // Paused: the tool still follows real events, but it does not go looking.
  assert.strictEqual(state.shouldSlowPoll(status({ recorded: true, paused: true })), false);
  // A cycle owns the read machinery and publishes its own status at the end.
  assert.strictEqual(state.shouldSlowPoll(status({ recorded: true, restoring: true })), false);

  // Junk in, off — the gate defaults to not reading.
  assert.strictEqual(state.shouldSlowPoll(null), false);
  assert.strictEqual(state.shouldSlowPoll(undefined), false);
  assert.strictEqual(state.shouldSlowPoll({ recorded: "true" }), false);
  // A status file straight off disk (the shape the service actually holds).
  assert.strictEqual(
    state.shouldSlowPoll(state.parseStatus(state.serializeStatus(status({ recorded: true }))).status),
    true
  );
});

test("mergeStatus can deliberately clear lastResult, but undefined never does", () => {
  const previous = state.mergeStatus(state.defaultStatus(), {
    lastResult: { ok: false, summary: "1 failed", at: AT }
  });
  assert.deepStrictEqual(previous.lastResult, { ok: false, summary: "1 failed", at: AT });
  assert.strictEqual(state.mergeStatus(previous, { restoring: true }).lastResult.summary, "1 failed");
  assert.strictEqual(state.mergeStatus(previous, { lastResult: null }).lastResult, null);
});

test("a half-built lastResult never fakes a success", () => {
  // Anything that is not a real object reads as "no result yet"…
  assert.strictEqual(state.normalizeStatus({ lastResult: "ok" }).lastResult, null);
  assert.strictEqual(state.normalizeStatus({ lastResult: [] }).lastResult, null);
  // …and `ok` is true only when it is literally true.
  assert.deepStrictEqual(state.normalizeStatus({ lastResult: { ok: "yes" } }).lastResult,
    { ok: false, summary: "", at: "" });
});

test("a corrupt driftCount is repaired rather than propagated", () => {
  assert.strictEqual(state.normalizeStatus({ driftCount: -4 }).driftCount, 0);
  assert.strictEqual(state.normalizeStatus({ driftCount: "7" }).driftCount, 0);
  assert.strictEqual(state.normalizeStatus({ driftCount: 2.7 }).driftCount, 2);
  assert.strictEqual(state.normalizeStatus({ driftCount: Infinity }).driftCount, 0);
});

test("status survives the serialize -> parse round trip", () => {
  const status = state.mergeStatus(state.defaultStatus(), {
    topologyKey: LAPTOP_KEY,
    recorded: true,
    driftCount: 2,
    restoring: false,
    lastResult: { ok: false, summary: "2 moved — 1 failed", at: AT }
  });
  const text = state.serializeStatus(status);
  assert.ok(text.endsWith("\n"), "the file is meant to be cat-able");
  const read = state.parseStatus(text);
  assert.strictEqual(read.error, null);
  assert.deepStrictEqual(read.status, status);
});

test("unknown status keys are dropped on the round trip", () => {
  const read = state.parseStatus(JSON.stringify({ topologyKey: LAPTOP_KEY, mood: "cheerful" }));
  assert.strictEqual(read.status.mood, undefined);
  assert.strictEqual(read.status.topologyKey, LAPTOP_KEY);
});

test("a missing or corrupt status file reads as the default, never throws", () => {
  for (const raw of ["", "   ", "{", "[]", "null", undefined]) {
    const read = state.parseStatus(raw);
    assert.deepStrictEqual(read.status, state.defaultStatus());
    assert.ok(read.error, "the reason is reported even though the status is usable");
  }
});

// ------------------------------------------------ the humanized topology name
//
// The service publishes the name beside the key because the bar widget cannot
// derive it: humanizing a built-in laptop panel needs the live monitor list,
// and the whole point of the status file is that the bar never reads one.

test("a valid topologyName survives normalization untouched", () => {
  assert.strictEqual(state.normalizeStatus({ topologyName: "Laptop + AOC U34G2G" }).topologyName,
    "Laptop + AOC U34G2G");
  // Not second-guessed against the key: the writer holds the monitor list and
  // this model does not, so whatever name it published is the better one.
  const odd = state.normalizeStatus({ topologyKey: LAPTOP_KEY, topologyName: "Desk" });
  assert.strictEqual(odd.topologyName, "Desk");
  assert.strictEqual(odd.topologyKey, LAPTOP_KEY);
});

test("a missing or corrupt topologyName defaults to the empty string", () => {
  // Missing entirely — a status file written before the field existed.
  assert.strictEqual(state.normalizeStatus({ topologyKey: LAPTOP_KEY }).topologyName, "");
  // …and every non-string a hand-edited file can hold. "" and not a humanized
  // key: guessing here would put a part number in the file under the name of a
  // friendly label, and the reader's own fallback is the honest answer.
  for (const junk of [null, undefined, 7, true, {}, [], ["Laptop"]]) {
    assert.strictEqual(state.normalizeStatus({ topologyName: junk }).topologyName, "",
      `topologyName: ${JSON.stringify(junk)}`);
  }
});

test("topologyName round-trips through the status file", () => {
  const named = state.mergeStatus(state.defaultStatus(), {
    topologyKey: LAPTOP_KEY,
    topologyName: "Laptop",
    recorded: true
  });
  assert.strictEqual(named.topologyName, "Laptop");

  const text = state.serializeStatus(named);
  const read = state.parseStatus(text);
  assert.strictEqual(read.error, null);
  assert.strictEqual(read.status.topologyName, "Laptop");
  assert.deepStrictEqual(read.status, named);
  assert.strictEqual(state.serializeStatus(read.status), text, "stable across a second write");
});

test("mergeStatus moves topologyName only when the patch carries one", () => {
  const before = state.mergeStatus(state.defaultStatus(),
    { topologyKey: LAPTOP_KEY, topologyName: "Laptop", recorded: true });

  // The restore cycle patches `restoring` and knows nothing about the desk's
  // name; the name it does not mention has to survive.
  assert.strictEqual(state.mergeStatus(before, { restoring: true }).topologyName, "Laptop");
  assert.strictEqual(state.mergeStatus(before, { topologyName: undefined }).topologyName, "Laptop");
  // A non-string is not a rename either.
  assert.strictEqual(state.mergeStatus(before, { topologyName: 7 }).topologyName, "Laptop");

  // But "" IS a statement — a writer that can no longer name the desk says so,
  // and the reader falls back to the key.
  assert.strictEqual(state.mergeStatus(before, { topologyName: "" }).topologyName, "");
  assert.strictEqual(state.mergeStatus(before, { topologyName: "Laptop + AOC U34G2G" }).topologyName,
    "Laptop + AOC U34G2G");
  // Nothing else moved with it.
  assert.deepStrictEqual(state.mergeStatus(before, { topologyName: "Desk" }),
    Object.assign({}, before, { topologyName: "Desk" }));
});

test("a status file written before topologyName existed still renders", () => {
  const legacy = state.parseStatus(JSON.stringify({
    topologyKey: LAPTOP_KEY, recorded: true, driftCount: 0
  })).status;
  assert.strictEqual(legacy.topologyName, "");
  // The empty name costs the reader nothing else: the glyph is decided by the
  // same fields it always was.
  assert.strictEqual(state.glyphState(legacy), "filled");
});

// ------------------------------------------------------- the bar-glyph matrix
//
// Source of truth: the state table in docs/thoughts/2026-08-15-ux-sketch.md.

function status(patch) {
  return state.mergeStatus(state.defaultStatus(), patch);
}

test("the six glyph states come out of the six statuses", () => {
  assert.strictEqual(state.glyphState(status({ topologyKey: LAPTOP_KEY })), "hollow");
  assert.strictEqual(state.glyphState(status({ recorded: true })), "filled");
  assert.strictEqual(state.glyphState(status({ recorded: true, driftCount: 2 })), "drifted");
  assert.strictEqual(state.glyphState(status({ recorded: true, restoring: true })), "restoring");
  assert.strictEqual(state.glyphState(status({ recorded: true, paused: true })), "paused");
  assert.strictEqual(
    state.glyphState(status({ recorded: true, lastResult: { ok: false, summary: "1 failed", at: AT } })),
    "failed");
});

test("paused outranks drift, failure and hollow — but never the live cycle", () => {
  // A switched-off tool is not going to fix the drift it is reporting, and a
  // badge leading with the symptom would send the user looking for the wrong
  // problem. The drift COUNT is untouched; only the one-word summary changes.
  const drifted = status({ recorded: true, driftCount: 4, paused: true });
  assert.strictEqual(state.glyphState(drifted), "paused");
  assert.strictEqual(drifted.driftCount, 4, "still counted, just not the headline");

  const failed = status({
    recorded: true,
    paused: true,
    lastResult: { ok: false, summary: "1 failed", at: AT }
  });
  assert.strictEqual(state.glyphState(failed), "paused");

  // Nothing recorded here AND switched off: "the tool is off" is the more
  // useful of the two, and the only one the user can act on from the bar.
  assert.strictEqual(state.glyphState(status({ recorded: false, paused: true })), "paused");

  // …but a manual restore still runs while paused, and its sweep has to show.
  assert.strictEqual(
    state.glyphState(status({ recorded: true, paused: true, restoring: true })),
    "restoring");
});

test("a paused status round-trips through the status file", () => {
  const paused = status({ topologyKey: LAPTOP_KEY, recorded: true, paused: true });
  const text = state.serializeStatus(paused);
  const read = state.parseStatus(text).status;
  assert.strictEqual(read.paused, true);
  assert.deepStrictEqual(read, paused);
  assert.strictEqual(state.serializeStatus(read), text);

  // And an older status file, written before the flag existed, reads as active.
  const legacy = state.parseStatus(JSON.stringify({ topologyKey: LAPTOP_KEY, recorded: true })).status;
  assert.strictEqual(legacy.paused, false);
  assert.strictEqual(state.glyphState(legacy), "filled");
});

test("mergeStatus can flip paused without disturbing anything else", () => {
  const before = status({ topologyKey: LAPTOP_KEY, recorded: true, driftCount: 2 });
  const after = state.mergeStatus(before, { paused: true });
  assert.deepStrictEqual(after, Object.assign({}, before, { paused: true }));
  assert.strictEqual(state.mergeStatus(after, { driftCount: 3 }).paused, true, "undefined leaves it alone");
  assert.strictEqual(state.mergeStatus(after, { paused: false }).paused, false);
});

test("restoring outranks everything — it is the only live state", () => {
  const busy = status({
    recorded: true,
    driftCount: 5,
    restoring: true,
    lastResult: { ok: false, summary: "1 failed", at: AT }
  });
  assert.strictEqual(state.glyphState(busy), "restoring");
});

test("a failure outranks drift, because a failed restore leaves drift behind", () => {
  const both = status({
    recorded: true,
    driftCount: 3,
    lastResult: { ok: false, summary: "2 moved — 1 failed", at: AT }
  });
  // Amber here would report the symptom and hide the cause.
  assert.strictEqual(state.glyphState(both), "failed");
});

test("with nothing recorded the glyph stays hollow whatever else the status says", () => {
  // Drift and failure are both statements ABOUT a recording; an unrecorded
  // topology has none for a dot to refer to.
  const noisy = status({
    recorded: false,
    driftCount: 4,
    lastResult: { ok: false, summary: "stale", at: AT }
  });
  assert.strictEqual(state.glyphState(noisy), "hollow");
});

test("a successful last restore does not mark the glyph", () => {
  const good = status({ recorded: true, lastResult: { ok: true, summary: "3 moved", at: AT } });
  assert.strictEqual(state.glyphState(good), "filled");
});

test("glyphState is defensive about junk", () => {
  assert.strictEqual(state.glyphState(null), "hollow");
  assert.strictEqual(state.glyphState(undefined), "hollow");
  assert.strictEqual(state.glyphState("nonsense"), "hollow");
});
