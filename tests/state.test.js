// StateModel — the on-disk state file (~/.local/state/omarchy/dock-recall.json).
// Source of truth: the schema comment block at the top of StateModel.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const engine = require("../engine.js");
const state = require("../StateModel.js");
// Only for the cross-pin below: StateModel itself may never require PanelModel.
const panel = require("../PanelModel.js");
const { loadFixture, IDENTITIES } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const LAPTOP_KEY = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

// The identities as the file stores them: engine identities plus a launch
// command, which is the one field the engine never looks at. Written the way a
// pre-v4 file wrote them — no `titlePatterns` key at all — because that is what
// every file on disk today looks like.
const FILE_IDENTITIES = [
  { id: "terminal", patterns: ["^foot$"], launch: "foot" },
  { id: "browser", patterns: ["^chromium$"], launch: "omarchy-launch-browser" }
];

// The same identities as the READER returns them: v4 materializes the empty
// `titlePatterns`, and that is now the only key an older file gains — v5's
// `pictured` was removed again by v7, whose switch is one field on the STATE
// rather than anything on an identity. See "THE DELIBERATE CHOICE, v4" and the
// v6 -> v7 note in the StateModel.js header.
function asRead(identities) {
  return identities.map((identity) => ({
    id: identity.id,
    patterns: identity.patterns,
    titlePatterns: identity.titlePatterns || [],
    launch: identity.launch
  }));
}

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

test("a default state is version 7, active, photographing, with nothing recorded", () => {
  const fresh = state.defaultState();
  assert.deepStrictEqual(fresh,
    { version: 7, paused: false, pictures: true, identities: [], layouts: {} });
  assert.strictEqual(state.STATE_VERSION, 7);
  // The two keys v7 retired, named so a re-introduction has to argue with a
  // test: there is no file-level consent and no per-identity flag any more.
  assert.ok(!("pictureConsent" in fresh), "no consent answer in a fresh state");
  const withApp = state.setIdentities(fresh, [{ id: "a", patterns: ["^a$"], launch: "" }]);
  assert.ok(!("pictured" in withApp.identities[0]), "and no per-app camera on an identity");
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
  assert.ok(text.indexOf("\n  \"version\": 7") !== -1, "pretty-printed with 2-space indent");
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
  assert.deepStrictEqual(next.identities, asRead(FILE_IDENTITIES));
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
  assert.deepStrictEqual(next.identities,
    [{ id: "editor", patterns: ["^code$"], titlePatterns: [], launch: "" }]);
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
    { id: "terminal", patterns: ["^foot$"], titlePatterns: [], launch: "foot" },
    { id: "broken", patterns: [], titlePatterns: [], launch: "" }
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
  assert.deepStrictEqual(result.state.identities, asRead(FILE_IDENTITIES));
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

// -------------------------------- the v1 -> ... -> v7 migration

const V1_TEXT = fs.readFileSync(path.join(__dirname, "fixtures", "state-v1.json"), "utf8");
const V1_RAW = JSON.parse(V1_TEXT);

test("a v1 file upgrades to v7 without losing anything it said", () => {
  const result = state.parseState(V1_TEXT);

  assert.strictEqual(result.recovered, false, "an upgrade is not a recovery");
  assert.strictEqual(result.error, null, "and it is not an error either");
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 7, "the whole chain runs in one read");
  assert.strictEqual(result.state.paused, false);
  assert.strictEqual(result.state.pictures, true,
    "v7: a file that never mentioned pictures gets them — the switch ships on");

  // Every identity, verbatim — including the `launch: ""` never-launch entry —
  // plus the one additive field v4 left behind.
  assert.deepStrictEqual(result.state.identities, asRead(V1_RAW.identities));

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
  assert.strictEqual(state.migrateVersion(1), 7, "upgraded, the whole chain");
  assert.strictEqual(state.migrateVersion(2), 7, "upgraded");
  assert.strictEqual(state.migrateVersion(3), 7, "upgraded");
  assert.strictEqual(state.migrateVersion(4), 7, "upgraded");
  assert.strictEqual(state.migrateVersion(5), 7, "upgraded");
  assert.strictEqual(state.migrateVersion(6), 7, "upgraded");
  assert.strictEqual(state.migrateVersion(7), 7);
  assert.strictEqual(state.migrateVersion(8), 8, "we did not write it, so we do not claim it");
  assert.strictEqual(state.migrateVersion(undefined), 7, "a version-less file is as old as they come");
  assert.strictEqual(state.migrateVersion("2"), 7);

  const future = state.parseState(JSON.stringify({ version: 99, identities: [], layouts: {} }));
  assert.strictEqual(future.state.version, 99);
  assert.strictEqual(future.migrated, false);
  assert.ok(future.error && future.error.indexOf("99") !== -1);
});

// ------------------------------------ a file from the FUTURE is READ-ONLY
//
// Tick 291. The read of a newer-schema file is sound; the ROUND TRIP is not.
// normalizeIdentity is a whitelist (that is the junk repair a hand-editable file
// needs) so it drops every identity field a newer version added, and
// migrateVersion keeps the newer number — so a write persists stripped content
// still stamped with the version that says nothing was stripped. The next
// binary that understands that version finds nothing to migrate and the data is
// gone. `titlePatterns` is the field that made this urgent: hand-authored, and
// unrecoverable once dropped.
//
// StateModel.writeRefusal is the single rule. The tests below pin the rule, pin
// that the three write paths a user can reach leave the file byte-identical, and
// pin that every writer in the repository actually consults it.

// A v8 file: everything this build knows, plus one identity field it does not.
// Hand-shaped rather than fixtured, because there is no v8 and the point is what
// an unknown field does on the way through.
const FUTURE_TEXT = JSON.stringify({
  version: 8,
  paused: false,
  identities: [
    { id: "terminal", patterns: ["^foot$"], titlePatterns: ["^scratch$"], launch: "foot",
      workspacePreference: "the v8 field this build has never heard of" }
  ],
  layouts: {}
}, null, 2) + "\n";

// The write path every writer of the state file shares, reduced to what it does
// to the DISK: ask writeRefusal, and only then serialize and replace the file.
// Panel.qml's writeState, Service.qml's writeState and scripts/record-current
// are each this with a FileView or an fs.renameSync doing the last line — and
// the test below the byte checks pins that they really are.
function guardedWrite(file, next) {
  const refusal = state.writeRefusal(next);
  if (refusal) return refusal;
  fs.writeFileSync(file, state.serializeState(next));
  return null;
}

function freshStateFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-recall-readonly-"));
  const file = path.join(dir, "dock-recall.json");
  fs.writeFileSync(file, text);
  return file;
}

test("writeRefusal names the future version and the one this build writes", () => {
  assert.strictEqual(state.writeRefusal(state.defaultState()), null);
  assert.strictEqual(state.writeRefusal(sampleState()), null, "a v1 file, upgraded on read");
  assert.strictEqual(state.writeRefusal({}), null,
    "a version-less object is as old as they come, and old is writable");
  assert.strictEqual(state.writeRefusal(null), null, "nothing to refuse about nothing");

  const refusal = state.writeRefusal(state.parseState(FUTURE_TEXT).state);
  assert.ok(refusal, "a v8 state cannot be written by a v7 build");
  assert.ok(refusal.indexOf("v8") !== -1, "says which version the file is");
  assert.ok(refusal.indexOf("v" + state.STATE_VERSION) !== -1, "and which one this build writes");
  assert.ok(refusal.indexOf("READ-ONLY") !== -1, "and what that means for the file");

  // The refusal survives every update helper, because they all carry the
  // version through — which is exactly why the writers can ask about the state
  // they are ABOUT to write rather than about the one they read.
  const future = state.parseState(FUTURE_TEXT).state;
  assert.ok(state.writeRefusal(state.setPaused(future, true)));
  assert.ok(state.writeRefusal(state.setIdentities(future, [])));
  assert.ok(state.writeRefusal(state.upsertLayout(future, sampleLayout())));
  assert.ok(state.writeRefusal(state.removeLayout(future, LAPTOP_KEY)));
});

test("this is what a write would destroy: the v8 field is gone by the time it is in memory", () => {
  const identity = state.parseState(FUTURE_TEXT).state.identities[0];
  assert.strictEqual(identity.workspacePreference, undefined,
    "normalizeIdentity is a whitelist — the unknown field never reaches memory");
  assert.strictEqual(state.serializeState(state.parseState(FUTURE_TEXT).state).indexOf("workspacePreference"), -1,
    "so serializing would write the file back without it");
  assert.ok(state.serializeState(state.parseState(FUTURE_TEXT).state).indexOf("\"version\": 8") !== -1,
    "and still stamped v8, which is the lie that loses the data");
});

test("a Record, a panel edit and a pause toggle each leave a v8 file byte-identical", () => {
  const file = freshStateFile(FUTURE_TEXT);
  const before = fs.readFileSync(file);
  const loaded = state.parseState(fs.readFileSync(file, "utf8")).state;

  // Record: the layout for this topology, filed on top of what is there.
  const record = guardedWrite(file, state.upsertLayout(loaded, sampleLayout()));
  assert.ok(record, "Record is refused");
  assert.deepStrictEqual(fs.readFileSync(file), before, "and the file is untouched");

  // A panel edit: ticking a chip (or learning a launch command) — both are a
  // whole-identity-list write.
  const edit = guardedWrite(file, state.setIdentities(loaded,
    state.identities(loaded).concat([{ id: "browser", patterns: ["^chromium$"], launch: "" }])));
  assert.ok(edit, "the panel edit is refused");
  assert.deepStrictEqual(fs.readFileSync(file), before, "and the file is untouched");

  // The pause toggle: the one write that rebuilds the whole file from a fresh
  // read, and so the one with the most to lose.
  const pause = guardedWrite(file, state.setPaused(loaded, true));
  assert.ok(pause, "the pause toggle is refused");
  assert.deepStrictEqual(fs.readFileSync(file), before, "and the file is untouched");

  // Forget/undo travel the same road.
  assert.ok(guardedWrite(file, state.removeLayout(loaded, LAPTOP_KEY)), "Forget is refused");
  assert.deepStrictEqual(fs.readFileSync(file), before);

  // Each refusal says why — a silent no-op would be the worse bug.
  for (const reason of [record, edit, pause]) {
    assert.ok(reason.indexOf("v8") !== -1 && reason.indexOf("READ-ONLY") !== -1, reason);
  }

  // The file is still READ correctly — the identity it names is materialized in
  // memory and the panel can show it. What it may no longer do is DRIVE the
  // desktop; see the restoreRefusal block below (tick t03).
  assert.strictEqual(state.identities(loaded).length, 1);
  assert.deepStrictEqual(state.identities(loaded)[0].titlePatterns, ["^scratch$"]);
});

// ------------------------------------------- a v8 file is INERT, not read-only
//
// Finding A6. Write protection alone was half a rule. `normalizeIdentity` is a
// whitelist, so a v8 identity arrives in memory with every narrowing field v8
// added STRIPPED — a `^chromium$` rule that v8 scoped to one profile, one
// title, one workspace comes through as class-only. The old build then restored
// from it: it claimed, moved and RELAUNCHED windows against rules far broader
// than the ones the user wrote. Refusing the write while still acting on the
// read protects the file and not the desktop, which is the wrong half.
//
// So: one predicate — `isFutureVersion` — and two consequences hanging off it.
// The file is read (the panel shows what it can), it is never written, and it
// dispatches NOTHING.

test("isFutureVersion is the single question both refusals ask", () => {
  assert.strictEqual(state.isFutureVersion(state.defaultState()), false);
  assert.strictEqual(state.isFutureVersion(sampleState()), false, "a v1 file, upgraded on read");
  assert.strictEqual(state.isFutureVersion({}), false,
    "a version-less object is as old as they come");
  assert.strictEqual(state.isFutureVersion(null), false, "nothing to refuse about nothing");
  assert.strictEqual(state.isFutureVersion({ version: Number.NaN }), false,
    "a version that is not a number is not from the future, it is junk");

  const future = state.parseState(FUTURE_TEXT).state;
  assert.strictEqual(state.isFutureVersion(future), true);

  // The two refusals agree, always, because they ask the same question.
  for (const candidate of [state.defaultState(), sampleState(), {}, null, future]) {
    assert.strictEqual(
      state.writeRefusal(candidate) === null,
      state.restoreRefusal(candidate) === null,
      "writeRefusal and restoreRefusal disagreed about " + JSON.stringify(candidate && candidate.version));
  }
});

test("restoreRefusal makes a future-version file inert and says why", () => {
  assert.strictEqual(state.restoreRefusal(state.defaultState()), null);
  assert.strictEqual(state.restoreRefusal(sampleState()), null, "a v1 file, upgraded on read");
  assert.strictEqual(state.restoreRefusal(null), null);

  const future = state.parseState(FUTURE_TEXT).state;
  const refusal = state.restoreRefusal(future);
  assert.ok(refusal, "a v8 state may not drive a restore on a v7 build");
  assert.ok(refusal.indexOf("v8") !== -1, "says which version the file is");
  assert.ok(refusal.indexOf("v" + state.STATE_VERSION) !== -1, "and which one this build understands");
  assert.ok(/INERT|no restore/i.test(refusal), "and what it means: nothing is dispatched");

  // It survives the update helpers for the same reason writeRefusal does — the
  // version travels with the state, so a caller can ask about the state it is
  // holding rather than about the read it came from.
  assert.ok(state.restoreRefusal(state.setPaused(future, true)));
  assert.ok(state.restoreRefusal(state.upsertLayout(future, sampleLayout())));

  // A v8 file with a perfectly good layout for the topology on screen is STILL
  // inert: the layout is not the problem, the stripped identities are.
  const withLayout = state.upsertLayout(future, sampleLayout());
  assert.ok(state.hasLayoutFor(withLayout, LAPTOP_KEY),
    "the layout is there and would otherwise be restored from");
  assert.ok(state.restoreRefusal(withLayout));
});

test("Service.qml gates every restore path on restoreRefusal", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "Service.qml"), "utf8");

  // requestRestore is the single funnel — every event, every settle pass, every
  // replayed request and the manual trigger arrive here. The gate belongs where
  // the pause contract already lives.
  const request = balancedBody(source, "function requestRestore(reason, manual) {", "Service.qml");
  assert.ok(request.indexOf("StateModel.restoreRefusal(") !== -1,
    "requestRestore never asks whether the file may drive a restore at all");
  assert.ok(request.indexOf("StateModel.restoreRefusal(") < request.indexOf("root.cycleActive = true"),
    "requestRestore asks after it has already started the cycle");

  // Unlike `paused`, the manual trigger does NOT override this one: the user's
  // button cannot make a stripped identity list safe to act on. The gate is the
  // call and the refusal it guards — up to the `return` that ends it.
  const gateStart = request.indexOf("StateModel.restoreRefusal(");
  const gate = request.slice(gateStart, request.indexOf("return", gateStart) + "return".length);
  assert.strictEqual(gate.indexOf("byHand"), -1,
    "the inert gate has a manual escape hatch — a v8 file must be inert for the button too");

  // And it comes BEFORE the pause contract, which does have that escape hatch:
  // "I cannot read this file" outranks "not right now".
  assert.ok(gateStart < request.indexOf("StateModel.isPaused("),
    "the pause contract is consulted before the inert one");

  // And the held request from before the file loaded is DROPPED, not replayed
  // into a gate that will only refuse it a line later.
  const flush = balancedBody(source, "function flushPendingRestore() {", "Service.qml");
  assert.ok(flush.indexOf("StateModel.restoreRefusal(") !== -1,
    "flushPendingRestore replays a held request against a file that may not be acted on");
});

// The panel's half of the same contract (tick 66x). Service.requestRestore
// refuses an inert file, but it refuses it into a log — and the panel had
// already written the trigger and DISMISSED ITSELF by then, so the user's click
// vanished with no sentence attached to it. The refusal has to happen before
// either of those two irreversible steps, with the panel still on screen.
test("Panel.qml refuses a manual restore from an inert file before it dismisses", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");

  const body = balancedBody(source, "function restoreNow() {", "Panel.qml");
  const gate = body.indexOf("root.restoreRefusalReason");
  assert.ok(gate !== -1, "restoreNow never asks whether the file may drive a restore");
  assert.ok(gate < body.indexOf("triggerFile.setText("),
    "restoreNow writes the trigger before it asks — the click dead-ends in the service's log");
  assert.ok(gate < body.indexOf("root.dismiss()"),
    "restoreNow dismisses the panel before it asks, taking the refusal off screen with it");
  // Refused means refused: neither irreversible step may be reachable from the
  // inert branch, so the branch has to END in a return.
  const refusalBranch = body.slice(gate, body.indexOf("}", gate));
  assert.ok(refusalBranch.indexOf("return") !== -1,
    "the inert branch falls through into the trigger write");
  // ...and the panel is not dismissed by it: the Inert line is the whole point.
  assert.strictEqual(refusalBranch.indexOf("dismiss"), -1,
    "a dismissed panel is a refusal the user can only read in a log file");
  assert.ok(refusalBranch.indexOf("ensureCursorVisible") !== -1,
    "the refusal is not brought into view at the moment the click costs the user something");

  // The affordances follow the file, not the moment: every entry point to
  // restoreNow gates on the one shared answer rather than on `recordedLayout`
  // alone. (Three of them — the footer button, a failed row's Retry, and the
  // keyboard's Enter, which stands in for both.)
  const calls = source.split("\n").filter((line) => line.indexOf("root.restoreNow()") !== -1);
  assert.ok(calls.length >= 3, "expected the footer, the retry row and the keyboard: " + calls.length);
  for (const line of calls) {
    assert.ok(line.indexOf("root.canRestore") !== -1,
      "a caller of restoreNow that does not consult canRestore: " + line.trim());
  }
  assert.ok(source.indexOf("PanelModel.mayManualRestore(") !== -1,
    "canRestore no longer asks PanelModel — the condition has drifted back into a binding");
});

test("the same three writes against a v7 file go through (the guard is not a blanket no)", () => {
  const file = freshStateFile(state.serializeState(sampleState()));
  const before = fs.readFileSync(file, "utf8");
  const loaded = state.parseState(before).state;

  assert.strictEqual(guardedWrite(file, state.upsertLayout(loaded, sampleLayout(monitorsLaptop))), null);
  assert.strictEqual(guardedWrite(file, state.setIdentities(loaded, [])), null);
  const after = fs.readFileSync(file, "utf8");
  assert.strictEqual(guardedWrite(file, state.setPaused(state.parseState(after).state, true)), null);
  assert.ok(fs.readFileSync(file, "utf8").indexOf("\"paused\": true") !== -1,
    "the pause toggle landed, so the byte-identical result above is the refusal and not the harness");
});

// The rule is pure and tested above; these are the call sites. Node cannot run
// QML, so the pin is on the source — the same tactic tests/migration.test.js
// uses for the bash snippet inside Service.qml, and for the same reason: there
// is no second copy of the logic, only the question of who asks.
function balancedBody(source, header, what) {
  const start = source.indexOf(header);
  assert.ok(start !== -1, what + " has no " + header);
  let depth = 0;
  for (let i = start + header.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(what + ": unbalanced braces after " + header);
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

// -------------------------------------------- a refused write says so (sma)
//
// The blocker: press Record on a future-version file and the panel AFFIRMED SUCCESS.
// writeState's refusal was a console.warn and a bare `return`; the next line
// logged "recorded 7 apps" regardless; and because the undo stash was armed
// BEFORE the write, the Undo button — the panel's one positive confirmation
// that a record happened — appeared for a record that was refused. The user
// walked away believing their arrangement was saved.
//
// The gates are QML, which node cannot instantiate, so they are pinned at the
// source the way the writeRefusal call itself is below.
test("a refused write can never look like it worked", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");

  // 1. writeState ANSWERS, and answers false on both refusal paths.
  const body = balancedBody(source, "function writeState(next) {", "Panel.qml");
  assert.strictEqual(occurrences(body, "return false"), 2,
    "writeState must answer false for the unread file AND for the refusal");
  assert.ok(occurrences(body, "return true") >= 1, "and true when the file says what was asked");

  // 2. EVERY caller gates on the answer. A bare `root.writeState(...)` followed
  //    by a log line is exactly the shape this tick removed.
  const calls = source.split("\n").filter((line) => line.indexOf("root.writeState(") !== -1);
  assert.ok(calls.length >= 7, "the whole family is here: " + calls.length);
  for (const line of calls) {
    assert.ok(/if \(!?root\.writeState\(/.test(line.trim()),
      "an ungated write, whose success log runs whatever the file did: " + line.trim());
  }

  // 3. The undo stash is armed AFTER the write, in both places that arm it.
  //    Armed before, it grew an Undo button for a record that never happened.
  const record = balancedBody(source, "function recordLayout() {", "Panel.qml");
  assert.ok(record.indexOf("root.writeState(") < record.indexOf("root.recordUndo = {"),
    "recordLayout arms the undo before the write it may not survive");
  const forget = balancedBody(source, "function forgetLayout() {", "Panel.qml");
  assert.ok(forget.indexOf("root.writeState(") < forget.indexOf("root.recordUndo = stash"),
    "forgetLayout arms the undo before the write it may not survive");

  // 4. And the panel SAYS the file is read-only, persistently, rather than
  //    leaving the only word on the subject to a notify-send toast at load
  //    time — on a desk that may have no notification daemon at all.
  assert.ok(/property string writeRefusalReason/.test(source),
    "Panel.qml never asks StateModel.writeRefusal about the file it is showing");
  assert.ok(/visible: root\.writeRefusalReason !== ""/.test(source),
    "the read-only reason is never rendered");
  const canRecord = source.slice(source.indexOf("readonly property bool canRecord:"));
  assert.ok(canRecord.slice(0, 400).indexOf("writeRefusalReason") !== -1,
    "canRecord offers a Record the file will refuse");
});

test("every writer of the state file consults writeRefusal before touching the disk", () => {
  const root = path.join(__dirname, "..");

  for (const name of ["Panel.qml", "Service.qml"]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    // One choke point per file: if a new action ever calls setText directly,
    // this is the assertion that catches it.
    assert.strictEqual(occurrences(source, "stateFile.setText("), 1,
      name + " writes the state file somewhere other than writeState");
    const body = balancedBody(source, "function writeState(next) {", name);
    assert.ok(body.indexOf("StateModel.writeRefusal(") !== -1,
      name + "'s writeState does not ask StateModel.writeRefusal");
    assert.ok(body.indexOf("StateModel.writeRefusal(") < body.indexOf("stateFile.setText("),
      name + " asks writeRefusal after it has already written the file");
    assert.ok(body.indexOf("root.warn(") !== -1,
      name + "'s writeState refuses silently — a refusal must say why");
  }

  const record = fs.readFileSync(path.join(root, "scripts", "record-current"), "utf8");
  assert.ok(record.indexOf("StateModel.writeRefusal(") !== -1,
    "scripts/record-current writes the state file without asking writeRefusal");
  assert.ok(record.indexOf("StateModel.writeRefusal(") < record.indexOf("fs.renameSync("),
    "scripts/record-current asks writeRefusal after it has already replaced the file");

  // And the service says it out loud on the READ too, not only when a write is
  // attempted: the user who downgraded needs to know before they try.
  const service = fs.readFileSync(path.join(root, "Service.qml"), "utf8");
  assert.ok(/READ-ONLY/.test(service),
    "Service.qml never tells the user the file is read-only");
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

// And a v3 file, the same way: what the shipped v3 recorder wrote — geometry
// and an occurrence on every entry, and identities with NO `titlePatterns`,
// because the field did not exist yet. Used by the v4 tests below.
function syntheticV3Text() {
  const raw = JSON.parse(syntheticV2Text());
  raw.version = 3;
  for (const key of Object.keys(raw.layouts)) {
    for (const app of raw.layouts[key].apps) app.occurrence = 0;
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
  assert.strictEqual(result.state.version, 7, "and it keeps going, to the current generation");
  assert.deepStrictEqual(result.state.identities, asRead(before.identities));

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

test("a v7 file re-reads byte-identical: the migration has nothing left to do", () => {
  // Every door into v7 — a v1 file, a v2 file, a v3 file, a v4 file, a v6 file
  // — and then the fixed point.
  for (const source of [V1_TEXT, syntheticV2Text(), syntheticV3Text(), syntheticV4Text(),
    syntheticV6Text()]) {
    const once = state.serializeState(state.parseState(source).state);
    const again = state.parseState(once);
    assert.strictEqual(again.migrated, false, "a v7 file is not migrated again");
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
    version: 4,
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

// ------------------------------------------ schema v4: identity titles

// Tick cag. `titlePatterns` is a second regex list on an identity, matched
// against a client's `initialTitle` — the field that tells `foot --title herdr`
// from a plain foot terminal, which class alone cannot. It ships HERE as schema
// and migration only: the matching itself lives in engine.js (tick 3e7), and
// nothing in this file compiles or applies a pattern.

// Exactly the four fields an identity has had since v7 removed v5's `pictured`,
// because this is compared against what the READER hands back and the reader
// materializes every one of them.
const TITLED = {
  id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
  launch: "foot --title herdr"
};

test("an identity carrying titlePatterns survives the parse -> serialize round trip", () => {
  // The failure this closes: before v4, normalizeIdentity rebuilt every identity
  // from exactly {id, patterns, launch}, so the field was silently dropped on
  // the FIRST write — nothing downstream could ever have matched on it.
  const written = state.serializeState({ version: 7, identities: [TITLED], layouts: {} });
  assert.ok(written.indexOf("titlePatterns") !== -1, "it reaches the file at all");

  const result = state.parseState(written);
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.recovered, false);
  assert.deepStrictEqual(result.state.identities, [TITLED]);
  assert.strictEqual(state.serializeState(result.state), written, "and the file is a fixed point");
});

test("titlePatterns is repaired exactly the way patterns is", () => {
  // Same helper, so the same promise: a typo costs you the pattern, never the
  // identity, and never its other entries.
  const result = state.parseState(JSON.stringify({
    version: 4,
    identities: [
      { id: "bare-string", patterns: "^foot$", titlePatterns: "^herdr$", launch: "" },
      { id: "junk", patterns: ["^foot$"], titlePatterns: ["^a$", null, 7, "", "^b$"], launch: "" },
      { id: "not-a-list", patterns: ["^foot$"], titlePatterns: { 0: "^herdr$" }, launch: "" },
      { id: "absent", patterns: ["^foot$"], launch: "" }
    ],
    layouts: {}
  }));

  assert.strictEqual(result.recovered, false, "none of that is a corrupt file");
  assert.deepStrictEqual(result.state.identities.map((i) => i.titlePatterns), [
    ["^herdr$"],
    ["^a$", "^b$"],
    [],
    []
  ]);
  assert.deepStrictEqual(result.state.identities.map((i) => i.patterns),
    [["^foot$"], ["^foot$"], ["^foot$"], ["^foot$"]], "and the class patterns are untouched throughout");
});

test("a v3 file upgrades to v4 by gaining an empty titlePatterns, and nothing else moves", () => {
  const text = syntheticV3Text();
  const before = JSON.parse(text);
  const result = state.parseState(text);

  assert.strictEqual(result.recovered, false, "an upgrade is not a recovery");
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 7, "and it keeps going, to the current generation");

  // Every identity byte for byte, plus the one additive field and nothing else.
  assert.strictEqual(result.state.identities.length, before.identities.length);
  before.identities.forEach((identity, i) => {
    const upgraded = result.state.identities[i];
    assert.strictEqual(upgraded.id, identity.id, identity.id);
    assert.deepStrictEqual(upgraded.patterns, identity.patterns, identity.id);
    assert.strictEqual(upgraded.launch, identity.launch, identity.id);
    // The only difference — and it IS materialized. See "THE DELIBERATE
    // CHOICE, v4" in the StateModel.js header: the empty list is written on
    // every identity rather than left absent, so no consumer ever has to tell
    // "absent" from "empty".
    assert.deepStrictEqual(upgraded.titlePatterns, [], identity.id);
    assert.ok("titlePatterns" in upgraded, identity.id + " carries the key, not just the value");
    assert.deepStrictEqual(Object.keys(upgraded),
      ["id", "patterns", "titlePatterns", "launch"], identity.id);
  });

  // v4 is an identity-only generation: not one layout entry moves.
  assert.deepStrictEqual(state.topologyKeys(result.state), Object.keys(before.layouts).sort());
  for (const key of Object.keys(before.layouts)) {
    assert.deepStrictEqual(state.layoutFor(result.state, key), before.layouts[key], key);
  }

  // And it is written back on the way out.
  assert.ok(state.serializeState(result.state).indexOf('"titlePatterns": []') !== -1);
});

test("the upgraded v3 file is stable: reading it again has nothing left to upgrade", () => {
  const once = state.parseState(syntheticV3Text()).state;
  const written = state.serializeState(once);
  const twice = state.parseState(written);
  assert.strictEqual(twice.migrated, false, "the second read is a v5 read");
  assert.strictEqual(twice.error, null);
  assert.deepStrictEqual(twice.state, once);
  assert.strictEqual(state.serializeState(twice.state), written);
});

test("the upgraded v3 file plans and scores exactly as it did before", () => {
  // v4 must be invisible to every consumer: the identities still drive the
  // engine, and the record still converges on the same desk.
  const before = state.parseState(syntheticV3Text()).state;
  const key = "Example Panel Co. EX-1234";
  const rawLayout = JSON.parse(syntheticV3Text()).layouts[key];
  const upgradedLayout = state.layoutFor(before, key);

  assert.deepStrictEqual(
    engine.driftOf(clientsLaptop, monitorsLaptop, upgradedLayout, before.identities).summary,
    engine.driftOf(clientsLaptop, monitorsLaptop, rawLayout, JSON.parse(syntheticV3Text()).identities).summary
  );
});

// ------------------------- schema v4: neutralizing the retired --app-id launch

// Tick j8o. v3's launch backfill wrote terminal launches as
// `<terminal> --app-id=<identity-id> <command>` — it forced a window class per
// identity so a class pattern could claim the window. The mechanism is retired
// (see TERMINAL_FAMILY in PanelModel.js: no terminal family agrees on the flag,
// and the derivation now spells the title instead), but a 0.2.0 state file
// still carries what it wrote. Migration is where that data has to be dealt
// with, because nothing downstream can: launchLooksBroken passes a multi-word
// command and launchRepairIndex never overwrites a runnable non-empty launch,
// so the stray-window restore runs forever with no repair path.

test("a v3 --app-id launch the identity's own patterns cannot claim is neutralized", () => {
  // The exact shape the backfill wrote, with the identity it wrote it for: the
  // forced class is `herdr`, and `^foot$` is the only pattern the identity has.
  // On restore this spawns a class-`herdr` window nothing ever claims.
  const text = JSON.stringify({
    version: 3,
    paused: false,
    identities: [{ id: "herdr", patterns: ["^foot$"], launch: "foot --app-id=herdr herdr" }],
    layouts: {}
  }, null, 2) + "\n";

  const result = state.parseState(text);
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.recovered, false, "an upgrade is not a recovery");
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 7);

  const migrated = result.state.identities[0];
  assert.notStrictEqual(migrated.launch, "foot --app-id=herdr herdr",
    "the broken command must never survive the migration verbatim");
  assert.strictEqual(migrated.launch, "",
    "and it is EMPTIED, which is the one repair launchRepairIndex reaches");
  assert.deepStrictEqual(migrated.patterns, ["^foot$"], "nothing else about the identity moves");
  assert.deepStrictEqual(migrated.titlePatterns, []);
});

test("--app-id spelled as two words, and with no value, is neutralized too", () => {
  const result = state.parseState(JSON.stringify({
    version: 3,
    identities: [
      { id: "herdr", patterns: ["^foot$"], launch: "foot --app-id herdr herdr" },
      { id: "top", patterns: ["^alacritty$"], launch: "alacritty --app-id=top top" },
      { id: "bare", patterns: ["^foot$"], launch: "foot --app-id" }
    ],
    layouts: {}
  }));
  assert.deepStrictEqual(result.state.identities.map((i) => i.launch), ["", "", ""]);
});

test("a hand-written --app-id launch the identity's patterns DO claim survives", () => {
  // The v1 fixture's scratchpad: `/usr/bin/foot --app-id=scratchpad` against
  // `^scratchpad$`. Forcing a class the identity's own patterns claim is how a
  // scratchpad terminal is supposed to be pinned, and it works. The
  // discriminator is the identity, not the flag.
  const result = state.parseState(JSON.stringify({
    version: 3,
    identities: [
      { id: "scratchpad", patterns: ["^scratchpad$"], launch: "/usr/bin/foot --app-id=scratchpad" },
      // Case-insensitively, the way the matcher reads it (engine.js compilePattern).
      { id: "notes", patterns: ["^Notes$"], launch: "foot --app-id=notes notes" }
    ],
    layouts: {}
  }));
  assert.deepStrictEqual(result.state.identities.map((i) => i.launch),
    ["/usr/bin/foot --app-id=scratchpad", "foot --app-id=notes notes"]);
});

test("an --app-id that is not the retired backfill's survives the migration", () => {
  // Tick bcc. The detector asked one question — "does this command spell
  // `--app-id` anywhere?" — and the retired backfill was not the only thing that
  // does. Two ordinary launches were EMPTIED on the way to v4:
  //
  //   a hand-written PWA launch, where `--app-id` is Chromium's own flag and
  //   names an extension id. Chromium's window class is `chrome-<id>-Default`,
  //   never the flag's value, so patternsClaimClass could only ever say
  //   "unclaimed" — the identity is correct, matches, restores, and the
  //   migration destroyed the command that starts it. normalizeIdentity's own
  //   comment promises a hand edit is "a decision this module does not
  //   overrule".
  //
  //   an `--app-id` belonging to the program the terminal HOSTS, which is not
  //   the terminal's flag at all and forces no class whatsoever.
  //
  // The backfill only ever wrote `<terminal-binary> --app-id=<id> <command>`,
  // so that is the only shape the detector is allowed to fire on.
  const result = state.parseState(JSON.stringify({
    version: 3,
    identities: [
      { id: "gmail", patterns: ["^chrome-cinhimbnkkaeohfgghhklpknlkffjgod-Default$"],
        launch: "chromium --app-id=cinhimbnkkaeohfgghhklpknlkffjgod" },
      { id: "logs", patterns: ["^foot$"], launch: "foot -e grep --app-id log.txt" }
    ],
    layouts: {}
  }));
  assert.strictEqual(result.migrated, true);
  assert.deepStrictEqual(result.state.identities.map((i) => i.launch), [
    "chromium --app-id=cinhimbnkkaeohfgghhklpknlkffjgod",
    "foot -e grep --app-id log.txt"
  ]);

  // And the two shapes that ARE the backfill's still go, so the scoping did not
  // simply switch the repair off.
  const still = state.parseState(JSON.stringify({
    version: 3,
    identities: [
      { id: "herdr", patterns: ["^foot$"], launch: "foot --app-id=herdr herdr" },
      { id: "scratchpad", patterns: ["^scratchpad$"], launch: "/usr/bin/foot --app-id=scratchpad" }
    ],
    layouts: {}
  }));
  assert.deepStrictEqual(still.state.identities.map((i) => i.launch),
    ["", "/usr/bin/foot --app-id=scratchpad"]);
});

test("StateModel's terminal knowledge agrees with PanelModel's", () => {
  // StateModel may not require PanelModel (QML .js imports cannot see each
  // other — the same constraint that has isArray and own in all three modules),
  // so the duplicated terminal-family and exec-boundary knowledge is pinned to
  // the original here instead.
  for (const binary of state.TERMINAL_BINARIES) {
    assert.ok(panel.isTerminalClass(binary),
      `${binary} must still be a terminal to PanelModel`);
  }
  for (const word of ["chromium", "code", "obsidian", ""]) {
    assert.ok(!panel.isTerminalClass(word), word);
  }

  // The boundary words, read through the one PanelModel behaviour that shows
  // them: past a boundary the terminal's own argv has ended, so a --title after
  // it is not the terminal's.
  for (const word of state.TERMINAL_ARGV_END) {
    assert.strictEqual(panel.titleFromOwnArgv(["foot", word, "--title=x"]), "",
      `${word} must still end the terminal's own argv`);
  }
  assert.strictEqual(panel.titleFromOwnArgv(["foot", "--fullscreen", "--title=x"]), "x",
    "and an ordinary flag must not, or the pin above would prove nothing");
});

test("the version bump is unchanged for a v3 file whose launches are clean", () => {
  // The neutralization is the ONLY thing v4 adds to an identity beyond
  // titlePatterns — a file with no --app-id anywhere migrates exactly as before.
  const text = syntheticV3Text();
  const before = JSON.parse(text);
  const result = state.parseState(text);
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 7);
  before.identities.forEach((identity, i) => {
    assert.strictEqual(result.state.identities[i].launch, identity.launch, identity.id);
  });
});

test("the launch subtraction belongs to v3 -> v4, not to \"older than today\"", () => {
  // THE BUG THIS CLOSES, and it shipped with the v5 -> v6 bump and survived to
  // v7 (review z4b). normalizeState handed normalizeIdentities `isOlderVersion`,
  // which is "older than whatever STATE_VERSION is now" — so the moment the
  // number moved past 4, v4's one deliberate subtraction started re-running on
  // every file below the current generation. A v6 identity carrying a hand-typed
  // `--app-id` launch came back EMPTIED, while the identical identity in a v7
  // file was left alone: the same file, read by two builds, answering
  // differently about a field the user typed.
  //
  // The boundary is v4, because v4 is where the deriving stopped. Below it the
  // string is the retired mechanism's output and cannot be repaired downstream;
  // at or above it the string was typed by hand, and normalizeIdentity's own
  // contract is that a hand edit is not overruled.
  const carrying = (version) => JSON.stringify({
    version: version,
    identities: [{ id: "herdr", patterns: ["^foot$"], titlePatterns: [],
      launch: "foot --app-id=herdr herdr" }],
    layouts: {}
  });
  const launchAt = (version) =>
    state.parseState(carrying(version)).state.identities[0].launch;

  // BELOW v4: still repaired, which is the whole point of the step and the one
  // case that must not regress.
  assert.strictEqual(launchAt(1), "", "v1 is below the boundary");
  assert.strictEqual(launchAt(3), "", "v3 is the generation that derived it");

  // AT v4 AND ABOVE: the user's, untouched, at every generation since — the
  // assertion that would have failed on the shipped v6 and v7 builds.
  for (const version of [4, 5, 6, 7]) {
    assert.strictEqual(launchAt(version), "foot --app-id=herdr herdr",
      "v" + version + " is at or past the generation that stopped deriving the flag,"
      + " so this launch was typed by hand and is not this module's to empty");
  }

  // And it is still a MIGRATION at every one of those versions but the last —
  // the repair being skipped is not the read being skipped.
  for (const version of [1, 3, 4, 5, 6]) {
    assert.strictEqual(state.parseState(carrying(version)).migrated, true, "v" + version);
  }
  assert.strictEqual(state.parseState(carrying(7)).migrated, false);
});

test("a v7 file's --app-id launch is the USER's and is never touched", () => {
  // Only a MIGRATED file carries the retired mechanism's data. A file already at
  // this generation was written by a build that no longer derives the flag, so
  // anything spelling it there was typed by hand — and a hand edit of the launch
  // field is a decision this module does not overrule.
  const text = JSON.stringify({
    version: 7,
    paused: false,
    pictures: true,
    identities: [{ id: "herdr", patterns: ["^foot$"], titlePatterns: [],
      launch: "foot --app-id=herdr herdr" }],
    layouts: {}
  }, null, 2) + "\n";
  const result = state.parseState(text);
  assert.strictEqual(result.migrated, false);
  assert.strictEqual(result.state.identities[0].launch, "foot --app-id=herdr herdr");
  assert.strictEqual(state.serializeState(result.state), text, "and the v7 file is still a fixed point");
});

// ------------------------------------------ schema v7: the one switch (fhy)
//
// One top-level `pictures` boolean, default TRUE, in place of BOTH consents the
// two generations before it built: v5's per-identity `pictured` (default off)
// and v6's `pictureConsent` (the answer to a dialogue the first Record put up).
//
// The reversal is the point. The old model asked twice, defaulted to nothing,
// and hid the per-app control well enough that the person who commissioned it
// could not find it — and the dialogue talked him out of the pictures he had
// asked for. Pictures are what this panel is FOR, so they are on, and turning
// them off is one entry in the overflow menu.
//
// What migrates: the one refusal. `pictureConsent: "none"` — "delete them all,
// take no more" — becomes `pictures: false`. Everything else, including the two
// grants and the silence of a file written before the question existed, becomes
// `pictures: true`. Per-identity `pictured` values are DROPPED: one boolean
// cannot honestly summarize eleven, and any-of would photograph the apps nobody
// granted while all-of would silence the ones they did.

// What the shipped v4 writer put on disk: geometry and an occurrence on every
// entry, a materialized (empty) titlePatterns on every identity, and no
// `pictured` key at all, because the field did not exist yet.
function syntheticV4Text() {
  const raw = JSON.parse(syntheticV3Text());
  raw.version = 4;
  for (const identity of raw.identities) identity.titlePatterns = [];
  return JSON.stringify(raw, null, 2) + "\n";
}

// What the shipped v6 writer put on disk: everything v4 wrote, plus the
// file-level answer and a per-identity camera on every identity — granted on
// every other one, so a migration that folded them together would have to pick
// a side and be caught doing it.
function syntheticV6Text(answer) {
  const raw = JSON.parse(syntheticV4Text());
  raw.version = 6;
  raw.pictureConsent = answer === undefined ? "keep" : answer;
  if (answer === null) delete raw.pictureConsent;
  raw.identities.forEach((identity, i) => { identity.pictured = i % 2 === 0; });
  return JSON.stringify(raw, null, 2) + "\n";
}

test("a v6 file reads as v7: one switch on, both consents gone, nothing else moved", () => {
  const text = syntheticV6Text("keep");
  const before = JSON.parse(text);
  const result = state.parseState(text);

  assert.strictEqual(result.recovered, false, "an upgrade is not a recovery");
  assert.strictEqual(result.error, null, "and it is not an error either");
  assert.strictEqual(result.migrated, true);
  assert.strictEqual(result.state.version, 7);
  assert.strictEqual(result.state.pictures, true, "'keep' was a consent, so the pictures stay");
  assert.ok(!("pictureConsent" in result.state), "and the answer itself does not survive");

  // Every identity byte for byte, MINUS the field this generation removed —
  // including the grant on every other one, which is dropped rather than folded
  // into the switch.
  assert.strictEqual(result.state.identities.length, before.identities.length);
  before.identities.forEach((identity, i) => {
    const upgraded = result.state.identities[i];
    assert.deepStrictEqual(Object.keys(upgraded),
      ["id", "patterns", "titlePatterns", "launch"], identity.id);
    assert.strictEqual(upgraded.id, identity.id, identity.id);
    assert.deepStrictEqual(upgraded.patterns, identity.patterns, identity.id);
    assert.deepStrictEqual(upgraded.titlePatterns, identity.titlePatterns, identity.id);
    assert.strictEqual(upgraded.launch, identity.launch, identity.id);
  });
  assert.ok(before.identities.some((i) => i.pictured === true),
    "the fixture granted at least one camera, or the drop above proves nothing");

  // v7 is a top-level generation: not one layout entry moves.
  assert.deepStrictEqual(state.topologyKeys(result.state), Object.keys(before.layouts).sort());
  for (const key of Object.keys(before.layouts)) {
    assert.deepStrictEqual(state.layoutFor(result.state, key), before.layouts[key], key);
  }
});

test("the one v6 answer that carries forward is the refusal", () => {
  // "none" is the only one of the four that is a person saying no to pictures
  // as such. "keep" and "not-these" are consents; "unasked" and an absent field
  // are silence from before the question existed, and silence is not a no.
  assert.strictEqual(state.parseState(syntheticV6Text("none")).state.pictures, false,
    "'No pictures' still means no pictures");
  for (const answer of ["keep", "not-these", "unasked", null]) {
    assert.strictEqual(state.parseState(syntheticV6Text(answer)).state.pictures, true,
      String(answer) + " is not a refusal");
  }

  // And junk in the field reads as "unasked" reads — the whitelist has not
  // changed, only what its answer is used for.
  assert.strictEqual(state.parseState(syntheticV6Text("No")).state.pictures, true);
});

test("a v6 file is READ as v7 while the file on disk stays v6 until the next write", () => {
  // The property every migration in this file has, kept: the read upgrades in
  // MEMORY and touches nothing. A migration that rewrote the file on sight would
  // rewrite it under a user who only opened the panel — and the acceptance suite
  // pins the same thing end to end for v3 -> v4
  // (tests/acceptance/dock-recall-appid-migration-test.sh, "upgraded in memory;
  // the file on disk is still v3").
  const file = freshStateFile(syntheticV6Text("none"));
  const before = fs.readFileSync(file);

  const loaded = state.parseState(fs.readFileSync(file, "utf8"));
  assert.strictEqual(loaded.migrated, true, "the read IS an upgrade");
  assert.strictEqual(loaded.state.version, 7, "and in memory it is v7");
  assert.strictEqual(loaded.state.pictures, false, "carrying the answer the file gave");

  assert.deepStrictEqual(fs.readFileSync(file), before, "and the file on disk is untouched by the read");
  const onDisk = fs.readFileSync(file, "utf8");
  assert.strictEqual(JSON.parse(onDisk).version, 6, "still v6 on disk");
  assert.ok(onDisk.indexOf('"pictureConsent"') !== -1, "with its consent answer still in it");
  assert.ok(onDisk.indexOf('"pictured"') !== -1, "and its per-app cameras");

  // The NEXT write is what persists the upgrade, and it is not refused: an
  // older file is writable, only a newer one is not.
  assert.strictEqual(guardedWrite(file, state.setPaused(loaded.state, true)), null);
  const after = fs.readFileSync(file, "utf8");
  assert.strictEqual(JSON.parse(after).version, 7, "now the file itself is v7");
  assert.strictEqual(JSON.parse(after).pictures, false, "and the refusal survived the write");
  assert.strictEqual(after.indexOf("pictureConsent"), -1, "with no consent answer left in it");
  assert.strictEqual(after.indexOf("pictured"), -1, "and no per-app camera anywhere");
});

test("a v7 file re-reads byte-identical, and the three writes leave it v7", () => {
  const file = freshStateFile(state.serializeState(state.parseState(syntheticV6Text("keep")).state));
  const written = fs.readFileSync(file, "utf8");

  const again = state.parseState(written);
  assert.strictEqual(again.migrated, false, "a v7 file is not a migration");
  assert.strictEqual(again.error, null);
  assert.strictEqual(state.serializeState(again.state), written, "byte for byte");

  // The three writes a user can reach. Each one rebuilds the whole file, which
  // is exactly where a top-level field goes missing (see stateWith).
  const record = state.upsertLayout(again.state, sampleLayout());
  assert.strictEqual(guardedWrite(file, record), null);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).version, 7, "after a Record");

  const loadedA = state.parseState(fs.readFileSync(file, "utf8")).state;
  assert.strictEqual(guardedWrite(file, state.setIdentities(loadedA, loadedA.identities)), null);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).version, 7, "after a panel edit");

  const loadedB = state.parseState(fs.readFileSync(file, "utf8")).state;
  assert.strictEqual(guardedWrite(file, state.setPaused(loadedB, true)), null);
  const end = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(end.version, 7, "after the pause toggle");
  assert.strictEqual(end.pictures, true, "and the switch survived all three");
});

test("picturesOn is on unless the state says the literal false", () => {
  // The opposite discipline from the consent it replaces, and the comment on
  // picturesOn says why: `paused` reads `=== true` (and so did v5's `pictured`,
  // before v7 deleted it) because a missing key must never GRANT anything, and
  // `pictures` reads `!== false` because a missing key must never silence the
  // feature the tool exists for.
  assert.strictEqual(state.picturesOn({}), true, "absent: the switch ships on");
  assert.strictEqual(state.picturesOn({ pictures: true }), true);
  assert.strictEqual(state.picturesOn({ pictures: false }), false, "the one value that is off");
  assert.strictEqual(state.picturesOn(state.defaultState()), true);
  assert.strictEqual(state.picturesOn(null), true, "nothing has not turned them off");

  // Only the boolean false is off. Everything a hand edit produces while meaning
  // something else lands on ON, which is the direction that loses nobody's data.
  for (const junk of ["false", "off", 0, null, undefined, "", {}]) {
    assert.strictEqual(state.picturesOn({ pictures: junk }), true,
      JSON.stringify(junk) + " is not the literal false");
  }
});

test("setPictures writes the boolean and touches nothing else", () => {
  const base = watchedPair();
  assert.strictEqual(state.picturesOn(base), true, "a fresh state starts on");

  const off = state.setPictures(base, false);
  assert.strictEqual(off.pictures, false);
  assert.strictEqual(state.picturesOn(off), false);

  const on = state.setPictures(off, true);
  assert.strictEqual(on.pictures, true);
  assert.deepStrictEqual(on, base, "and the round trip is back where it started");

  // Everything BUT the switch, deep-compared, so a setter that rebuilt the
  // state from a literal would be caught here rather than by the first Record.
  const rest = (s) => ({ version: s.version, paused: s.paused, identities: s.identities, layouts: s.layouts });
  assert.deepStrictEqual(rest(off), rest(base), "the off write moved nothing else");
  assert.deepStrictEqual(rest(on), rest(base), "and neither did the on write");

  // The caller's object is not mutated under it: the panel binds to this, and an
  // in-place edit would leave the menu entry reading the position it was in
  // before it was pressed.
  assert.strictEqual(base.pictures, true);
});

test("every top-level setter carries the switch through", () => {
  // THE BUG THIS CLOSES, and it is the one .tick/learnings.md already names:
  // four setters used to END with an enumerated `{version, paused, identities,
  // layouts}` literal, so a new top-level field would survive the setter that
  // wrote it and be silently dropped by the first Record. Here that would mean
  // recording a layout turned the pictures back on.
  const off = state.setPictures(watchedPair(), false);
  assert.strictEqual(state.picturesOn(off), false);

  const doors = {
    upsertLayout: state.upsertLayout(off, sampleLayout()),
    removeLayout: state.removeLayout(off, LAPTOP_KEY),
    setIdentities: state.setIdentities(off, off.identities),
    setPaused: state.setPaused(off, true),
    serialize: state.parseState(state.serializeState(off)).state
  };
  for (const name of Object.keys(doors)) {
    assert.strictEqual(state.picturesOn(doors[name]), false,
      name + " turned the pictures back on");
  }
});

test("the switch survives the round trip to the file, both ways round", () => {
  const file = freshStateFile(state.serializeState(watchedPair()));
  const loaded = state.parseState(fs.readFileSync(file, "utf8")).state;
  assert.ok(fs.readFileSync(file, "utf8").indexOf('"pictures": true') !== -1,
    "materialized, like titlePatterns before it: absent and on are one shape");

  assert.strictEqual(guardedWrite(file, state.setPictures(loaded, false)), null);
  const back = state.parseState(fs.readFileSync(file, "utf8")).state;
  assert.strictEqual(state.picturesOn(back), false,
    "which is what makes the switch hold across a shell restart");
  assert.strictEqual(back.identities.length, 2, "and the switch touched nobody's identity");

  assert.strictEqual(guardedWrite(file, state.setPictures(back, true)), null);
  const on = state.parseState(fs.readFileSync(file, "utf8")).state;
  assert.strictEqual(state.picturesOn(on), true);
  assert.deepStrictEqual(on.identities, watchedPair().identities);
});

// The pair the retired setters were written against: two watched apps, and
// nothing else said about either of them.
function watchedPair() {
  return state.setIdentities(state.defaultState(), [
    { id: "vault", patterns: ["^KeePassXC$"], titlePatterns: [], launch: "keepassxc" },
    { id: "editor", patterns: ["^code$"], titlePatterns: [], launch: "code" }
  ]);
}

test("no identity proposal can carry a picture field into the file", () => {
  // suggestIdentity is the sole CONSTRUCTOR of an identity and it has two
  // return statements — the class-only proposal and the title proposal. Both
  // were pinned here when v5 ADDED a field to them; the pin now runs the other
  // way, at the WRITE, because that is where the whitelist is and the failure
  // mode is the one the learnings entry names: a rebuild site that was missed.
  const classOnly = panel.suggestIdentity("chromium", []);

  // The derivation is handed in rather than derived — suggestIdentity is pure,
  // and this shape is what terminalChildDerivation answers.
  const titled = panel.suggestIdentity("foot", [],
    { title: "herdr", command: "foot --title=herdr herdr", reason: "" });
  assert.strictEqual(titled.id, "herdr", "the title proposal was made at all");

  // Whatever a proposal says, the write drops it: normalizeIdentity is a
  // whitelist and the field is no longer on it.
  const saved = state.setIdentities(state.defaultState(),
    [classOnly, titled, { id: "stray", patterns: ["^x$"], launch: "", pictured: true }]);
  for (const identity of saved.identities) {
    assert.ok(!("pictured" in identity), identity.id);
  }
  assert.strictEqual(state.serializeState(saved).indexOf("pictured"), -1,
    "and it never reaches the file");
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
