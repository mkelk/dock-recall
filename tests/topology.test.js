// Topology key + monitor resolution.
// Source of truth: docs/thoughts/2026-08-15-inspiration-and-design-sketch.md
// ("Topology key").

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const { loadFixture, IDENTITIES, makeClient } = require("./helpers.js");

const monitorsLaptop = loadFixture("monitors-laptop.json");
const monitorsDocked = loadFixture("monitors-laptop+headless.json");
const clientsLaptop = loadFixture("clients-laptop.json");
const clientsDocked = loadFixture("clients-laptop+headless.json");

const LAPTOP_DESC = "Samsung Display Corp. ATNA60HR07-0";

test("monitorLabel prefers description", () => {
  assert.strictEqual(engine.monitorLabel(monitorsLaptop[0]), LAPTOP_DESC);
});

test("monitorLabel falls back to name when description is empty", () => {
  const headless = monitorsDocked.find((m) => m.name === "hw-test");
  assert.strictEqual(headless.description, "");
  assert.strictEqual(engine.monitorLabel(headless), "hw-test");
});

test("monitorLabel is defensive about junk input", () => {
  assert.strictEqual(engine.monitorLabel(null), "");
  assert.strictEqual(engine.monitorLabel({}), "");
  assert.strictEqual(engine.monitorLabel({ name: "DP-2" }), "DP-2");
  assert.strictEqual(engine.monitorLabel({ name: "DP-2", description: "  " }), "DP-2");
});

test("laptop-only and laptop+headless produce distinct keys", () => {
  const laptop = engine.topologyKey(monitorsLaptop);
  const docked = engine.topologyKey(monitorsDocked);

  assert.strictEqual(laptop, LAPTOP_DESC);
  assert.strictEqual(docked, LAPTOP_DESC + " | hw-test");
  assert.notStrictEqual(laptop, docked);
});

test("the key does not depend on monitor array order", () => {
  const forwards = engine.topologyKey(monitorsDocked);
  const backwards = engine.topologyKey(monitorsDocked.slice().reverse());
  assert.strictEqual(forwards, backwards);
});

test("the key never reads serial — eDP-1's is empty", () => {
  assert.strictEqual(monitorsLaptop[0].serial, "");

  // Give every monitor a serial; the key must not budge.
  const withSerials = monitorsDocked.map((m, i) =>
    Object.assign({}, m, { serial: "SN-" + i })
  );
  assert.strictEqual(engine.topologyKey(withSerials), engine.topologyKey(monitorsDocked));

  // And two serial-less monitors must not collapse into one key entry.
  assert.strictEqual(engine.topologyKey(monitorsDocked).split(" | ").length, 2);
});

test("the key is stable across recaptures of the same topology", () => {
  // Volatile fields (focus, active workspace, id renumbering) must not leak in.
  const shuffled = monitorsDocked
    .slice()
    .reverse()
    .map((m, i) =>
      Object.assign({}, m, {
        id: 10 + i,
        focused: !m.focused,
        activeWorkspace: { id: 99, name: "99" }
      })
    );
  assert.strictEqual(engine.topologyKey(shuffled), engine.topologyKey(monitorsDocked));
});

test("topologyKey tolerates an empty or missing monitor list", () => {
  assert.strictEqual(engine.topologyKey([]), "");
  assert.strictEqual(engine.topologyKey(null), "");
  assert.strictEqual(engine.topologyKey(undefined), "");
});

test("monitorByIndex resolves the id clients report", () => {
  assert.strictEqual(engine.monitorByIndex(monitorsDocked, 0).name, "eDP-1");
  assert.strictEqual(engine.monitorByIndex(monitorsDocked, 1).name, "hw-test");
  assert.strictEqual(engine.monitorByIndex(monitorsDocked, 7), null);
  assert.strictEqual(engine.monitorByIndex(monitorsLaptop, 1), null);
  assert.strictEqual(engine.monitorByIndex(monitorsLaptop, null), null);
  assert.strictEqual(engine.monitorByIndex(null, 0), null);
});

test("monitorByDescription resolves a recorded label back to a monitor", () => {
  assert.strictEqual(engine.monitorByDescription(monitorsDocked, LAPTOP_DESC).name, "eDP-1");
  // hw-test is only findable by its name-derived label.
  assert.strictEqual(engine.monitorByDescription(monitorsDocked, "hw-test").name, "hw-test");
});

test("monitorByDescription returns null for a monitor absent from the topology", () => {
  assert.strictEqual(engine.monitorByDescription(monitorsLaptop, "hw-test"), null);
  assert.strictEqual(engine.monitorByDescription(monitorsDocked, "AOC ultrawide"), null);
  assert.strictEqual(engine.monitorByDescription(monitorsDocked, ""), null);
  assert.strictEqual(engine.monitorByDescription(monitorsDocked, null), null);
});

test("every client's monitor index round-trips through a label", () => {
  const cases = [
    [clientsLaptop, monitorsLaptop],
    [clientsDocked, monitorsDocked]
  ];

  for (const [clients, monitors] of cases) {
    assert.ok(clients.length > 0);
    for (const client of clients) {
      const monitor = engine.monitorByIndex(monitors, client.monitor);
      assert.ok(monitor, "client " + client.class + " on unknown monitor " + client.monitor);

      const label = engine.monitorLabel(monitor);
      assert.ok(label.length > 0);
      assert.strictEqual(engine.monitorByDescription(monitors, label), monitor);
    }
  }
});

// --- twin identical monitors (tick ojr) --------------------------------------
//
// TWO OUTPUTS, ONE LABEL. A monitor's identity in this schema IS its
// description (monitorLabel), and a matched pair of the same model reports the
// same description on both connectors. Schema v2 has no second field to tell
// them apart — AppPlacement carries `monitorDescription` and nothing else about
// the output — so v2 REFUSES to disambiguate rather than guessing.
//
// These tests are the evidence for that refusal: they pin what the code does
// today, deliberately, including the parts that are lossy. They are not a
// wish-list. Twins cannot be simulated with real headless outputs either (a
// headless output has an EMPTY description and falls back to its unique NAME in
// monitorLabel, which makes it the opposite of a twin), so synthesized monitor
// objects are the only way to reach this case at all.
const TWIN_DESC = "Dell Inc. U2723QE";

function twinMonitors(extra) {
  const twins = [
    Object.assign({}, monitorsLaptop[0], {
      id: 0, name: "DP-1", description: TWIN_DESC, x: 0, y: 0,
      width: 2560, height: 1440, scale: 1, focused: true,
      activeWorkspace: { id: 1, name: "1" }
    }),
    Object.assign({}, monitorsLaptop[0], {
      id: 1, name: "DP-2", description: TWIN_DESC, x: 2560, y: 0,
      width: 2560, height: 1440, scale: 1, focused: false,
      activeWorkspace: { id: 2, name: "2" }
    })
  ];
  return extra ? twins.concat([extra]) : twins;
}

test("twin monitors: monitorByDescription returns the FIRST match, always", () => {
  const monitors = twinMonitors();
  assert.strictEqual(engine.monitorLabel(monitors[0]), engine.monitorLabel(monitors[1]));

  assert.strictEqual(engine.monitorByDescription(monitors, TWIN_DESC).name, "DP-1");
  // Not "the focused one", not "the one the window is on" — the first in the
  // list. And the list order follows connection sequence, so which physical
  // panel that is can change across a reboot.
  const swapped = [monitors[1], monitors[0]];
  assert.strictEqual(engine.monitorByDescription(swapped, TWIN_DESC).name, "DP-2");
});

test("twin monitors: the topology key carries the same label twice", () => {
  // Not deduplicated. Two twins are a different desk from one of them, and the
  // sorted join says so — which is the one thing about twins that DOES work:
  // unplugging one twin changes the key, so the recording for the pair is not
  // silently restored onto the single.
  assert.strictEqual(engine.topologyKey(twinMonitors()), TWIN_DESC + " | " + TWIN_DESC);
  assert.notStrictEqual(engine.topologyKey(twinMonitors()), TWIN_DESC);
  assert.strictEqual(
    engine.topologyKey(twinMonitors(monitorsLaptop[0])),
    [LAPTOP_DESC, TWIN_DESC, TWIN_DESC].sort().join(" | ")
  );
});

test("twin monitors: a window dragged from one twin to the other is not drift at all", () => {
  // The record cannot express the difference, so neither can the comparison.
  // This is the honest half of the refusal: the tool does not report a drift it
  // has no vocabulary for, and does not move a window it cannot aim.
  const monitors = twinMonitors();
  const onFirst = [makeClient({ address: "0xaaa", class: "code", workspace: 3, monitor: 0 })];
  const layout = engine.buildLayout(onFirst, monitors, IDENTITIES, "2026-08-17T09:00:00Z");
  assert.strictEqual(layout.apps.length, 1);
  assert.strictEqual(layout.apps[0].monitorDescription, TWIN_DESC);

  const onSecond = [Object.assign({}, onFirst[0], { monitor: 1 })];
  const report = engine.driftOf(onSecond, monitors, layout, IDENTITIES);
  const editor = report.apps.find((a) => a.identityId === "editor");
  assert.strictEqual(editor.status, "ok");
  assert.strictEqual(editor.drift.monitor, false, "same label on both outputs — nothing to compare");
  assert.deepStrictEqual(engine.planRestore(onSecond, monitors, layout, IDENTITIES), []);
});

test("twin monitors: both apps land on the FIRST twin — the documented v2 refusal", () => {
  // Recorded on the twin desk with the laptop also attached: one app on each
  // twin, on its own workspace. Both entries say TWIN_DESC, because that is all
  // the schema can say.
  const monitors = twinMonitors(Object.assign({}, monitorsLaptop[0], { id: 2, focused: false }));
  const AT = "2026-08-17T09:00:00Z";
  const recordedClients = [
    makeClient({ address: "0xaaa", class: "code", workspace: 3, monitor: 0 }),
    makeClient({ address: "0xbbb", class: "foot", workspace: 4, monitor: 1 })
  ];
  const layout = engine.buildLayout(recordedClients, monitors, IDENTITIES, AT);
  assert.deepStrictEqual(
    layout.apps.map((a) => a.monitorDescription),
    [TWIN_DESC, TWIN_DESC],
    "the record cannot name WHICH twin, and does not pretend to"
  );

  // Live: both windows have ended up on the laptop panel, which IS a label the
  // comparison can see — so both drift, and both plan a destination.
  const liveClients = recordedClients.map((c) => Object.assign({}, c, { monitor: 2 }));
  const report = engine.driftOf(liveClients, monitors, layout, IDENTITIES);
  for (const id of ["editor", "terminal"]) {
    assert.strictEqual(report.apps.find((a) => a.identityId === id).drift.monitor, true);
  }

  const ops = engine.planRestore(liveClients, monitors, layout, IDENTITIES)
    .filter((op) => op.kind === "workspace-monitor");
  assert.strictEqual(ops.length, 2, "one per recorded workspace");
  // THE REFUSAL, said in a dispatch: every op names DP-1, because
  // monitorByDescription answers with the first match and there is no recorded
  // field that could pick DP-2. The workspace that lived on the second twin is
  // restored onto the first one, and the tool cannot know it got that wrong.
  assert.deepStrictEqual(ops.map((op) => op.monitorName), ["DP-1", "DP-1"]);
  assert.deepStrictEqual(ops.map((op) => op.workspaceId), [3, 4]);
});

test("labels survive the id renumbering a hotplug causes", () => {
  // Same two monitors, ids swapped — as if hw-test had come up first.
  const renumbered = [
    Object.assign({}, monitorsDocked[1], { id: 0 }),
    Object.assign({}, monitorsDocked[0], { id: 1 })
  ];

  assert.strictEqual(engine.topologyKey(renumbered), engine.topologyKey(monitorsDocked));
  assert.strictEqual(engine.monitorByIndex(renumbered, 0).name, "hw-test");
  assert.strictEqual(engine.monitorByDescription(renumbered, LAPTOP_DESC).id, 1);
});
