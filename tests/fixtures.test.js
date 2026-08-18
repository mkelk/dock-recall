// Smoke test: the captured fixtures exist, parse, and still carry the traps
// they were captured to exercise. See tests/fixtures/README.md.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const { FIXTURE_NAMES, fixturePath, loadFixture } = require("./helpers.js");

test("all four fixtures exist and parse as JSON arrays", () => {
  for (const name of FIXTURE_NAMES) {
    assert.ok(fs.existsSync(fixturePath(name)), name + " is missing");
    const parsed = loadFixture(name);
    assert.ok(Array.isArray(parsed), name + " is not a JSON array");
    assert.ok(parsed.length > 0, name + " is empty");
  }
});

test("laptop-only fixture has exactly one monitor, with an empty serial", () => {
  const monitors = loadFixture("monitors-laptop.json");
  assert.strictEqual(monitors.length, 1);
  assert.strictEqual(monitors[0].name, "eDP-1");
  assert.strictEqual(monitors[0].serial, "", "eDP-1's serial must stay empty — that is the trap");
  assert.ok(monitors[0].description.length > 0);
});

test("two-monitor fixture adds hw-test, whose description is empty", () => {
  const monitors = loadFixture("monitors-laptop+headless.json");
  assert.strictEqual(monitors.length, 2);
  const names = monitors.map((m) => m.name).sort();
  assert.deepStrictEqual(names, ["eDP-1", "hw-test"]);

  const headless = monitors.find((m) => m.name === "hw-test");
  assert.strictEqual(headless.description, "", "hw-test has no description — forces the name fallback");
  assert.strictEqual(headless.serial, "");
});

test("client fixtures carry the real class-name traps", () => {
  const clients = loadFixture("clients-laptop.json");
  const classes = clients.map((c) => c.class);

  // Obsidian's Quattro rename.
  assert.ok(classes.includes("md.obsidian.Obsidian"));
  // Chromium webapp synthesized classes.
  assert.ok(classes.some((c) => c.startsWith("chrome-app.slack.com__")));
  assert.ok(classes.some((c) => c.startsWith("chrome-mail.google.com__")));
  // Plain classes too.
  assert.ok(classes.includes("chromium"));

  for (const client of clients) {
    assert.strictEqual(typeof client.class, "string");
    assert.strictEqual(typeof client.initialClass, "string");
    assert.strictEqual(typeof client.monitor, "number");
    assert.strictEqual(typeof client.workspace.id, "number");
    assert.ok(Array.isArray(client.grouped));
  }
});

test("client fixtures contain a real group whose grouped arrays agree", () => {
  const clients = loadFixture("clients-laptop.json");
  const grouped = clients.filter((c) => c.grouped.length > 0);
  assert.ok(grouped.length >= 2, "expected a real group in the fixture");

  // Every member reports the same address array — that array is the tab order.
  const order = grouped[0].grouped;
  for (const member of grouped) {
    assert.deepStrictEqual(member.grouped, order);
    assert.ok(order.includes(member.address));
  }
});

test("engine.js loads under node", () => {
  const engine = require("../engine.js");
  assert.strictEqual(typeof engine, "object");
});

// ---------------------------------------------------------------------------
// The non-adjacent group join (tick z0l) — the service's own forensics dump of
// the failing desktop, captured 2026-08-16T06:34:51.393Z and replayed by hand
// dispatch by dispatch. Mechanism, live-proven: `into_group` only joins a
// group that is the directly ADJACENT tile in the asked direction; on this
// desktop a full column (obsidian) sat between slack and whatsapp's group, so
// all four directions answered "ok" and did nothing, across three passes.
// These tests pin two things: that the measurement layer reproduces the
// dump's verdicts from its raw reads, and that the scratch-workspace pick the
// fix relies on picks an actually-empty, actually-invisible workspace here.
// ---------------------------------------------------------------------------

const engine = require("../engine.js");
const { makeClient } = require("./helpers.js");
const forensics = loadFixture("forensics-nonadjacent-join.json");

test("forensics dump: the failing desktop carries the non-adjacency evidence intact", () => {
  const clients = forensics.clients;
  const byClass = (prefix) => clients.find((c) => c.class.startsWith(prefix));
  const slack = byClass("chrome-app.slack.com");
  const whatsapp = byClass("chrome-web.whatsapp.com");
  const obsidian = byClass("md.obsidian.Obsidian");

  // The solo-group residue of the failed rebuild: the create-group step ran,
  // no join ever landed.
  assert.deepStrictEqual(whatsapp.grouped, [whatsapp.address]);
  assert.deepStrictEqual(slack.grouped, []);

  // The geometry that gated the join: slack's column and whatsapp's column do
  // not touch — obsidian's column spans the gap between them.
  const right = (c) => c.at[0] + c.size[0];
  assert.ok(right(slack) < whatsapp.at[0], "slack must end left of whatsapp");
  assert.ok(obsidian.at[0] > right(slack) - 20 && right(obsidian) < whatsapp.at[0] + 20,
    "obsidian sits in the column between them");
});

test("forensics dump: the verdict layer reproduces the dump's own verdicts from raw reads", () => {
  const report = engine.driftOf(
    forensics.clients, forensics.monitors, forensics.recording, forensics.identities);
  const verdicts = engine.verdictsFor(report, forensics.outcomes);

  const byId = {};
  for (const v of verdicts) byId[v.identityId] = v;

  // The two group members failed exactly as the dump says, on the group
  // dimension alone; slack carries the blocking outcome.
  for (const id of ["whatsapp", "slack"]) {
    assert.strictEqual(byId[id].ok, false, id + " must not be ok");
    assert.strictEqual(byId[id].monitor, "ok");
    assert.strictEqual(byId[id].workspace, "ok");
    assert.strictEqual(byId[id].floating, "ok");
    assert.notStrictEqual(byId[id].group, "ok", id + "'s group dimension must be the failure");
  }
  assert.ok(byId.slack.blockedBy, "slack must carry the blocking group outcome");
  assert.match(byId.slack.blockedBy.reason, /group join refused/);

  // Everyone else was arranged; the dump's summary said 7/9.
  const okIds = verdicts.filter((v) => v.ok).map((v) => v.identityId).sort();
  assert.deepStrictEqual(okIds,
    ["calendar-google", "chromium", "herdr", "mail-google", "obsidian", "rememberthemilk", "telegram"]);
});

test("pickScratchWorkspace: on the forensics desktop it picks 31 — empty and invisible", () => {
  const pick = engine.pickScratchWorkspace(forensics.clients, forensics.monitors);
  assert.strictEqual(pick, 31);

  for (const c of forensics.clients) {
    assert.notStrictEqual(c.workspace.id, pick, "picked a workspace with windows on it");
  }
  for (const m of forensics.monitors) {
    assert.notStrictEqual(m.activeWorkspace.id, pick, "picked a workspace a monitor is showing");
  }
});

test("pickScratchWorkspace: skips occupied ids, visible ids, special ids, and never throws on junk", () => {
  // Empty desktop: the base.
  assert.strictEqual(engine.pickScratchWorkspace([], []), 31);
  assert.strictEqual(engine.pickScratchWorkspace(null, null), 31);

  // Windows sitting on the base ids push the pick upward.
  const squatters = [31, 32, 33].map((ws) => makeClient({ workspace: ws }));
  assert.strictEqual(engine.pickScratchWorkspace(squatters, []), 34);

  // A monitor SHOWING an empty candidate disqualifies it — the assembly must
  // not be churn the user watches. So does its special workspace.
  const showing = [{ activeWorkspace: { id: 31 }, specialWorkspace: { id: 32 } }];
  assert.strictEqual(engine.pickScratchWorkspace([], showing), 33);

  // Junk shapes must not throw: clients without workspace, monitors without
  // the workspace objects.
  assert.strictEqual(engine.pickScratchWorkspace([{ address: "0x1" }], [{}]), 31);
});
