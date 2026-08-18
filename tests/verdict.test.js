// The verdict table — engine.verdictsFor / verdictSummary — plus the two
// pieces of plumbing that carry it: the status file's copy of the table
// (StateModel) and the row/chip text the panel renders from it (PanelModel).
//
// What this file is for: before tick vkx the product measured itself with one
// number (driftCount) and four booleans nobody could see, so the USER was the
// measurement instrument — "windows out of sync" was the whole bug report,
// because there was no other vocabulary available. Every test here pins a word
// the product now says instead.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const panel = require("../PanelModel.js");
const { loadFixture, IDENTITIES, makeClient } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const monitorsDocked = loadFixture("monitors-laptop+headless.json");

const LAPTOP_DESC = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

const recorded = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);

const GROUP = ["obsidian", "telegram", "slack", "whatsapp"];

function addressOf(clients, id) {
  const identity = IDENTITIES.find((i) => i.id === id);
  const found = engine.firstClientFor(clients, identity, IDENTITIES);
  assert.ok(found, "no live window for " + id);
  return found.address;
}

function verdictsOf(clients, monitors, layout, outcomes) {
  const report = engine.driftOf(clients, monitors || monitorsLaptop, layout || recorded, IDENTITIES);
  return engine.verdictsFor(report, outcomes);
}

function verdictFor(verdicts, id) {
  const found = verdicts.find((v) => v.identityId === id);
  assert.ok(found, "no verdict for " + id);
  return found;
}

// Rewrite every group member's `grouped` array to `addresses`. That is what a
// live read looks like: every member of a real group reports the SAME array.
function withGroup(clients, addresses) {
  const inGroup = {};
  for (const address of addresses) inGroup[address] = true;
  return clients.map((c) =>
    inGroup[c.address]
      ? Object.assign({}, c, { grouped: addresses.slice() })
      : (c.grouped && c.grouped.length ? Object.assign({}, c, { grouped: [] }) : c)
  );
}

// --- the clean case ---------------------------------------------------------

test("a conforming desktop gets nine words, and every one of them is ok", () => {
  const verdicts = verdictsOf(clientsLaptop);

  assert.strictEqual(verdicts.length, recorded.apps.length);
  for (const verdict of verdicts) {
    assert.deepStrictEqual(
      {
        monitor: verdict.monitor,
        workspace: verdict.workspace,
        floating: verdict.floating,
        group: verdict.group
      },
      { monitor: "ok", workspace: "ok", floating: "ok", group: "ok" },
      verdict.identityId + " should read ok on every dimension"
    );
    assert.strictEqual(verdict.ok, true);
    assert.strictEqual(verdict.text, "");
    assert.strictEqual(verdict.blockedBy, null);
  }
});

test("the verdict order is the recorded order, so a table is stable to read", () => {
  const verdicts = verdictsOf(clientsLaptop);
  assert.deepStrictEqual(
    verdicts.map((v) => v.identityId),
    recorded.apps.map((a) => a.identityId)
  );
});

// --- one word per dimension -------------------------------------------------

test("a window on the wrong workspace says workspace, and nothing else", () => {
  const drifted = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { workspace: { id: 7, name: "7" } }) : c
  );
  const editor = verdictFor(verdictsOf(drifted), "editor");

  assert.strictEqual(editor.workspace, "wrong-workspace");
  assert.strictEqual(editor.monitor, "ok");
  assert.strictEqual(editor.floating, "ok");
  assert.strictEqual(editor.group, "ok");
  assert.strictEqual(editor.ok, false);
  assert.strictEqual(editor.text, "on the wrong workspace");
});

test("a window on the wrong monitor says monitor", () => {
  // Docked: the recording is a laptop-only one, so an app read on the headless
  // output is on the wrong monitor for it.
  const dockedLayout = Object.assign({}, recorded, {
    topologyKey: engine.topologyKey(monitorsDocked)
  });
  const moved = clientsLaptop.map((c) => (c.class === "code" ? Object.assign({}, c, { monitor: 1 }) : c));
  const editor = verdictFor(verdictsOf(moved, monitorsDocked, dockedLayout), "editor");

  assert.strictEqual(editor.monitor, "wrong-monitor");
  assert.strictEqual(editor.text, "on the wrong monitor");
});

test("floating says which way round it is wrong", () => {
  const floated = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { floating: true }) : c
  );
  // Recorded tiled, live floating.
  assert.strictEqual(verdictFor(verdictsOf(floated), "editor").floating, "should-tile");
  assert.strictEqual(verdictFor(verdictsOf(floated), "editor").text, "should be tiled");

  // …and the mirror image: recorded floating, live tiled.
  const recordedFloating = engine.buildLayout(floated, monitorsLaptop, IDENTITIES, AT);
  assert.strictEqual(
    verdictFor(verdictsOf(clientsLaptop, monitorsLaptop, recordedFloating), "editor").floating,
    "should-float"
  );
});

test("two dimensions wrong is two phrases, in plan order", () => {
  const drifted = clientsLaptop.map((c) =>
    c.class === "code"
      ? Object.assign({}, c, { workspace: { id: 7, name: "7" }, floating: true })
      : c
  );
  const editor = verdictFor(verdictsOf(drifted), "editor");
  assert.strictEqual(editor.text, "on the wrong workspace, should be tiled");
});

// --- the five group words ---------------------------------------------------
//
// This is the distinction the whole tick exists for: driftOf said `group: true`
// for every one of these, and the user had to look at the screen to find out
// which of them it was.

test("a group nobody joined reads not-joined, for every member that is here", () => {
  const scattered = withGroup(clientsLaptop, []);
  const verdicts = verdictsOf(scattered);

  for (const id of GROUP) {
    assert.strictEqual(verdictFor(verdicts, id).group, "not-joined", id);
    assert.strictEqual(verdictFor(verdicts, id).text, "not in its recorded group");
  }
});

test("the same members in the wrong tab order read wrong-order, not not-joined", () => {
  const addresses = GROUP.map((id) => addressOf(clientsLaptop, id));
  const reversed = withGroup(clientsLaptop, addresses.slice().reverse());
  const verdicts = verdictsOf(reversed);

  for (const id of GROUP) {
    assert.strictEqual(verdictFor(verdicts, id).group, "wrong-order", id);
  }
  assert.strictEqual(
    verdictFor(verdicts, "slack").text,
    "in its group in the wrong tab order"
  );
});

test("a window recorded alone but live tabbed in reads unexpected-group", () => {
  // The user's post-wake ws-10 finding, in verdict form: recorded ungrouped,
  // live grouped. Recorded from a desktop where nothing is grouped.
  const ungroupedClients = withGroup(clientsLaptop, []);
  const ungroupedLayout = engine.buildLayout(ungroupedClients, monitorsLaptop, IDENTITIES, AT);
  const addresses = GROUP.map((id) => addressOf(clientsLaptop, id));
  const regrouped = withGroup(ungroupedClients, addresses);

  const verdicts = verdictsOf(regrouped, monitorsLaptop, ungroupedLayout);
  for (const id of GROUP) {
    assert.strictEqual(verdictFor(verdicts, id).group, "unexpected-group", id);
  }
  assert.strictEqual(
    verdictFor(verdicts, "slack").text,
    "grouped, but recorded standing alone"
  );
});

test("a group short of a member that IS here reads missing-member", () => {
  // Three of the four tabbed together; the fourth is on the desktop, ungrouped.
  const addresses = GROUP.slice(0, 3).map((id) => addressOf(clientsLaptop, id));
  const partial = withGroup(clientsLaptop, addresses);
  const verdicts = verdictsOf(partial);

  for (const id of GROUP.slice(0, 3)) {
    assert.strictEqual(verdictFor(verdicts, id).group, "missing-member", id);
  }
  // The one that is out of the group entirely is not missing a member — it is
  // the member that is missing.
  assert.strictEqual(verdictFor(verdicts, "whatsapp").group, "not-joined");
  assert.strictEqual(
    verdictFor(verdicts, "slack").text,
    "its group is short a member that is here"
  );
});

test("a stranger tabbed into the group reads unexpected-group for its members", () => {
  const addresses = GROUP.map((id) => addressOf(clientsLaptop, id));
  addresses.push(addressOf(clientsLaptop, "editor"));
  const invaded = withGroup(clientsLaptop, addresses);
  const verdicts = verdictsOf(invaded);

  assert.strictEqual(verdictFor(verdicts, "slack").group, "unexpected-group");
  // The stranger is recorded ungrouped and is now in a group: same word, from
  // the other side.
  assert.strictEqual(verdictFor(verdicts, "editor").group, "unexpected-group");
});

test("a recorded member that closed does not make the rest of the group wrong", () => {
  // whatsapp is gone; the other three are correctly tabbed together. The plan
  // converges on the partial group, so the verdicts have to agree with it.
  const withoutWhatsapp = clientsLaptop.filter((c) => c.address !== addressOf(clientsLaptop, "whatsapp"));
  const addresses = GROUP.slice(0, 3).map((id) => addressOf(clientsLaptop, id));
  const partial = withGroup(withoutWhatsapp, addresses);
  const verdicts = verdictsOf(partial);

  for (const id of GROUP.slice(0, 3)) {
    assert.strictEqual(verdictFor(verdicts, id).group, "ok", id);
    assert.strictEqual(verdictFor(verdicts, id).ok, true, id);
  }
  assert.strictEqual(verdictFor(verdicts, "whatsapp").group, "not-running");
  // The verdicts have to agree with the plan: the only thing left to do about
  // this desktop is open whatsapp again — no group op, because the three that
  // are here are already tabbed the way the recording asks.
  assert.deepStrictEqual(
    engine.planRestore(partial, monitorsLaptop, recorded, IDENTITIES),
    [{ kind: "launch", identityId: "whatsapp" }]
  );
});

// --- the states that are not a mismatch -------------------------------------

test("an app that is not running says so on every dimension, once", () => {
  const withoutEditor = clientsLaptop.filter((c) => c.class !== "code");
  const editor = verdictFor(verdictsOf(withoutEditor), "editor");

  assert.strictEqual(editor.status, "missing");
  assert.strictEqual(editor.monitor, "not-running");
  assert.strictEqual(editor.group, "not-running");
  // Deduped: four dimensions saying "not running" is one fact, not four.
  assert.strictEqual(editor.text, "not running");
});

test("a skipped app says not-judged rather than pretending to be ok", () => {
  // Recorded on a monitor this topology does not have.
  const orphaned = Object.assign({}, recorded, {
    apps: recorded.apps.map((a) =>
      a.identityId === "editor" ? Object.assign({}, a, { monitorDescription: "Gone Inc. X1" }) : a
    )
  });
  const editor = verdictFor(verdictsOf(clientsLaptop, monitorsLaptop, orphaned), "editor");

  assert.strictEqual(editor.status, "skipped");
  assert.strictEqual(editor.monitor, "monitor-absent");
  assert.strictEqual(editor.workspace, "not-judged");
  assert.strictEqual(editor.group, "not-judged");
  // "ok" would paint a green row over an app nobody has looked at.
  assert.strictEqual(editor.ok, false);
  assert.strictEqual(editor.text, "its recorded monitor is not connected");
});

test("a scratchpad recording blames the WORKSPACE, and the row says it in words", () => {
  // A legacy entry (buildLayout refuses these since tick pqv). Its monitor is
  // connected and fine — the unrestorable thing is the negative workspace id —
  // so the sentence must not send the user to check a cable.
  const legacy = Object.assign({}, recorded, {
    apps: recorded.apps.map((a) =>
      a.identityId === "editor" ? Object.assign({}, a, { workspaceId: -98 }) : a
    )
  });
  const editor = verdictFor(verdictsOf(clientsLaptop, monitorsLaptop, legacy), "editor");

  assert.strictEqual(editor.status, "skipped");
  assert.strictEqual(editor.workspace, "workspace-special");
  assert.strictEqual(editor.monitor, "not-judged");
  assert.strictEqual(editor.floating, "not-judged");
  assert.strictEqual(editor.group, "not-judged");
  assert.strictEqual(editor.ok, false);
  assert.strictEqual(editor.text, "recorded on a special workspace — not restorable");
  // …and that is the line the panel puts on the row.
  assert.strictEqual(panel.verdictLine(editor), "recorded on a special workspace — not restorable");
});

test("an app whose identity is no longer watched says that, not 'out of place'", () => {
  const fewer = IDENTITIES.filter((i) => i.id !== "editor");
  const report = engine.driftOf(clientsLaptop, monitorsLaptop, recorded, fewer);
  const editor = verdictFor(engine.verdictsFor(report), "editor");

  assert.strictEqual(editor.monitor, "identity-unknown");
  assert.strictEqual(editor.text, "no longer a watched app");
});

// --- the verdicts and the badge cannot disagree ------------------------------

test("every app the badge counts has a verdict that is not ok, and the reverse", () => {
  const drifted = withGroup(
    clientsLaptop.map((c) =>
      c.class === "code" ? Object.assign({}, c, { workspace: { id: 7, name: "7" } }) : c
    ),
    []
  );
  const report = engine.driftOf(drifted, monitorsLaptop, recorded, IDENTITIES);
  const verdicts = engine.verdictsFor(report);

  const notOk = verdicts.filter((v) => !v.ok && v.status !== "skipped").length;
  assert.strictEqual(notOk, state.driftCountOf(report));
  // 1 workspace + 4 group members
  assert.strictEqual(notOk, 5);
});

// --- blockedBy --------------------------------------------------------------

const JOIN_REFUSED = [
  {
    kind: "group",
    subject: "0xaaa+0xbbb",
    identityIds: ["slack"],
    ok: false,
    reason: "group join refused by compositor"
  }
];

test("a failed op is carried to the app it failed for, by name and reason", () => {
  const scattered = withGroup(clientsLaptop, []);
  const verdicts = verdictsOf(scattered, monitorsLaptop, recorded, JOIN_REFUSED);

  assert.deepStrictEqual(verdictFor(verdicts, "slack").blockedBy, {
    kind: "group",
    reason: "group join refused by compositor"
  });
  // The other members are out of their group too, but nothing refused THEM —
  // inventing a reason for them would be the imprecision this replaces.
  assert.strictEqual(verdictFor(verdicts, "telegram").blockedBy, null);
});

test("a reason never outlives the mismatch it explains", () => {
  // The same failed outcome, against a desktop that has since come right (the
  // user tabbed the group back together by hand). No mismatch, no blame.
  const verdicts = verdictsOf(clientsLaptop, monitorsLaptop, recorded, JOIN_REFUSED);
  assert.strictEqual(verdictFor(verdicts, "slack").ok, true);
  assert.strictEqual(verdictFor(verdicts, "slack").blockedBy, null);
});

test("the last failure for an app wins", () => {
  const scattered = withGroup(clientsLaptop, []);
  const verdicts = verdictsOf(scattered, monitorsLaptop, recorded, [
    { kind: "group", identityIds: ["slack"], ok: false, reason: "first" },
    { kind: "group", identityIds: ["slack"], ok: false, reason: "second" }
  ]);
  assert.strictEqual(verdictFor(verdicts, "slack").blockedBy.reason, "second");
});

test("a successful op explains nothing", () => {
  const scattered = withGroup(clientsLaptop, []);
  const verdicts = verdictsOf(scattered, monitorsLaptop, recorded, [
    { kind: "group", identityIds: ["slack"], ok: true, reason: "" }
  ]);
  assert.strictEqual(verdictFor(verdicts, "slack").blockedBy, null);
});

test("blockedByIndex ignores junk without throwing", () => {
  assert.deepStrictEqual(engine.blockedByIndex(null), {});
  assert.deepStrictEqual(engine.blockedByIndex([null, {}, { ok: false }]), {});
  assert.deepStrictEqual(engine.blockedByIndex([{ ok: false, identityIds: [""] }]), {});
});

// --- the honest toast -------------------------------------------------------

test("the summary counts apps, not dispatches", () => {
  const scattered = withGroup(clientsLaptop, []);
  const verdicts = verdictsOf(scattered, monitorsLaptop, recorded, JOIN_REFUSED);
  const summary = engine.verdictSummary(verdicts);

  // One verdict per recorded WINDOW since schema v3: the laptop fixture holds
  // two foot windows and two Gmail windows, so 10 identities make 12 rows.
  assert.strictEqual(summary.counted, 12);
  assert.strictEqual(summary.arranged, 8);
  assert.strictEqual(summary.ok, false);
  // Two names then a count: a notification listing every app is one nobody
  // reads to the end.
  assert.strictEqual(
    summary.text,
    "8/12 arranged — obsidian: not in its recorded group;"
      + " telegram: not in its recorded group; +2 more"
  );
});

test("the app that was refused is named with the compositor's reason", () => {
  // Exactly the sentence the tick asked for: one app out of place, and the
  // reason it is, from the op that failed.
  const verdicts = verdictsOf(clientsLaptop).map((v) =>
    v.identityId === "telegram"
      ? Object.assign({}, v, {
        ok: false,
        group: "not-joined",
        text: "not in its recorded group",
        blockedBy: { kind: "group", reason: "group join refused" }
      })
      : v
  );
  assert.strictEqual(engine.verdictSummary(verdicts).text,
    "11/12 arranged — telegram: group join refused");
});

test("a fully arranged desktop says so without naming anybody", () => {
  const summary = engine.verdictSummary(verdictsOf(clientsLaptop));
  assert.strictEqual(summary.text, "12/12 arranged");
  assert.strictEqual(summary.ok, true);
});

test("skipped apps are counted apart, never as arranged", () => {
  const orphaned = Object.assign({}, recorded, {
    apps: recorded.apps.map((a) =>
      a.identityId === "editor" ? Object.assign({}, a, { monitorDescription: "Gone Inc. X1" }) : a
    )
  });
  const summary = engine.verdictSummary(verdictsOf(clientsLaptop, monitorsLaptop, orphaned));
  assert.strictEqual(summary.text, "11/11 arranged, 1 skipped");
  // Nothing was blocked: an unplugged monitor is not a failure to arrange.
  assert.strictEqual(summary.ok, true);
});

test("verdictSummary survives an empty and a junk table", () => {
  assert.strictEqual(engine.verdictSummary([]).text, "0/0 arranged");
  assert.strictEqual(engine.verdictSummary(null).text, "0/0 arranged");
  assert.strictEqual(engine.verdictSummary([null]).text, "0/0 arranged");
});

// --- the status file's copy of the table ------------------------------------

test("verdicts round-trip through the status file", () => {
  const verdicts = verdictsOf(withGroup(clientsLaptop, []), monitorsLaptop, recorded, JOIN_REFUSED);
  const status = state.mergeStatus(state.defaultStatus(), {
    topologyKey: LAPTOP_DESC,
    recorded: true,
    verdicts: verdicts
  });
  const read = state.parseStatus(state.serializeStatus(status)).status;

  assert.strictEqual(read.verdicts.length, verdicts.length);
  const slack = read.verdicts.find((v) => v.identityId === "slack");
  assert.strictEqual(slack.group, "not-joined");
  assert.strictEqual(slack.blockedBy.reason, "group join refused by compositor");
  assert.strictEqual(slack.ok, false);
});

test("a status file cannot claim ok over a dimension that is not", () => {
  // ok is recomputed, never trusted: it is what the UI paints green.
  const read = state.normalizeStatus({
    verdicts: [{ identityId: "slack", ok: true, group: "not-joined" }]
  });
  assert.strictEqual(read.verdicts[0].ok, false);
});

test("a verdict with no identityId is dropped, and junk words become ok", () => {
  const read = state.normalizeStatus({
    verdicts: [{ group: "not-joined" }, { identityId: "slack", group: 7 }, null, "nope"]
  });
  assert.strictEqual(read.verdicts.length, 1);
  assert.strictEqual(read.verdicts[0].group, "ok");
  assert.strictEqual(read.verdicts[0].blockedBy, null);
});

test("an unknown verdict word from a newer service is kept, not blanked", () => {
  const read = state.normalizeStatus({
    verdicts: [{ identityId: "slack", group: "fullscreen-mismatch" }]
  });
  assert.strictEqual(read.verdicts[0].group, "fullscreen-mismatch");
  assert.strictEqual(read.verdicts[0].ok, false);
});

// --- forensics rotation ------------------------------------------------------

test("a forensics filename is the ISO stamp, so ls sorts chronologically", () => {
  assert.strictEqual(state.forensicsFileName("2026-08-16T07:12:33.123Z"), "2026-08-16T07:12:33.123Z.json");
  const names = ["2026-08-16T07:12:33.123Z", "2026-08-15T23:00:00.000Z", "2026-08-16T06:00:00.000Z"]
    .map(state.forensicsFileName);
  assert.deepStrictEqual(names.slice().sort(), [
    "2026-08-15T23:00:00.000Z.json",
    "2026-08-16T06:00:00.000Z.json",
    "2026-08-16T07:12:33.123Z.json"
  ]);
});

test("a filename that would be a path is refused rather than written", () => {
  assert.strictEqual(state.forensicsFileName("../../etc/passwd"), "");
  assert.strictEqual(state.forensicsFileName("2026-08-16 07:12"), "");
  assert.strictEqual(state.forensicsFileName(""), "");
  assert.strictEqual(state.forensicsFileName(null), "");
});

function dumps(n, from) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push("2026-08-16T00:00:" + String((from || 0) + i).padStart(2, "0") + ".000Z.json");
  }
  return out;
}

test("rotation keeps room for the file about to be written", () => {
  // Nine on disk plus the one being written IS ten: nothing to delete.
  assert.deepStrictEqual(state.forensicsPrune(dumps(9), 10), []);
  // Ten on disk plus one is eleven, so the oldest goes.
  assert.deepStrictEqual(state.forensicsPrune(dumps(10), 10), [dumps(10)[0]]);
  // …and the directory converges rather than growing by one per failure.
  assert.strictEqual(state.forensicsPrune(dumps(30), 10).length, 21);
});

test("rotation deletes the OLDEST, whatever order the listing arrived in", () => {
  const shuffled = dumps(12).slice().reverse();
  assert.deepStrictEqual(state.forensicsPrune(shuffled, 10), [dumps(12)[0], dumps(12)[1], dumps(12)[2]]);
});

test("rotation never touches a file it did not write", () => {
  const listing = dumps(12).concat(["README", "notes.txt", "", "  "]);
  const prune = state.forensicsPrune(listing, 10);
  for (const name of prune) assert.ok(name.endsWith(".json"), name + " is not a dump");
  assert.strictEqual(prune.length, 3);
});

test("rotation tolerates junk and a nonsense keep count", () => {
  assert.deepStrictEqual(state.forensicsPrune(null, 10), []);
  assert.deepStrictEqual(state.forensicsPrune([null, 7, {}], 10), []);
  // keep < 1 is meaningless and clamps to 1 — which still leaves room for the
  // dump about to be written, so the one already there goes.
  assert.deepStrictEqual(state.forensicsPrune(dumps(1), 0), [dumps(1)[0]]);
  assert.deepStrictEqual(state.forensicsPrune([], 0), []);
});

// --- what the panel renders --------------------------------------------------

test("a row says what is wrong, not only where the app belongs", () => {
  const scattered = withGroup(clientsLaptop, []);
  const report = engine.driftOf(scattered, monitorsLaptop, recorded, IDENTITIES);
  const verdicts = engine.verdictsFor(report, JOIN_REFUSED);
  const rows = panel.appRows(
    scattered,
    monitorsLaptop,
    (client) => engine.matchClient(client, IDENTITIES) || "",
    report,
    recorded,
    IDENTITIES,
    null,
    verdicts
  );

  const slack = rows.find((r) => r.identityId === "slack");
  assert.strictEqual(slack.mismatch, "not in its recorded group — group join refused by compositor");
  const telegram = rows.find((r) => r.identityId === "telegram");
  assert.strictEqual(telegram.mismatch, "not in its recorded group");
  const editor = rows.find((r) => r.identityId === "editor");
  assert.strictEqual(editor.mismatch, "", "an app that is where it belongs says nothing");
});

test("a caller with no verdict table still gets rows", () => {
  const report = engine.driftOf(clientsLaptop, monitorsLaptop, recorded, IDENTITIES);
  const rows = panel.appRows(
    clientsLaptop,
    monitorsLaptop,
    (client) => engine.matchClient(client, IDENTITIES) || "",
    report,
    recorded,
    IDENTITIES
  );
  assert.ok(rows.length > 0);
  for (const row of rows) assert.strictEqual(row.mismatch, "");
});

test("a closed app's row carries the reason the launch failed, not 'not running' twice", () => {
  const withoutEditor = clientsLaptop.filter((c) => c.class !== "code");
  const report = engine.driftOf(withoutEditor, monitorsLaptop, recorded, IDENTITIES);
  const verdicts = engine.verdictsFor(report, [
    { kind: "launch", identityIds: ["editor"], ok: false, reason: "launch produced no window within 10s" }
  ]);
  const rows = panel.appRows(
    withoutEditor,
    monitorsLaptop,
    (client) => engine.matchClient(client, IDENTITIES) || "",
    report,
    recorded,
    IDENTITIES,
    null,
    verdicts
  );

  const editor = rows.find((r) => r.identityId === "editor");
  assert.ok(editor.position.indexOf("not running") !== -1);
  assert.strictEqual(editor.mismatch, "launch produced no window within 10s");
});

test("a chip carries the same sentence its row does", () => {
  const scattered = withGroup(clientsLaptop, []);
  const report = engine.driftOf(scattered, monitorsLaptop, recorded, IDENTITIES);
  const verdicts = engine.verdictsFor(report, JOIN_REFUSED);
  const map = panel.liveMapModel(
    scattered,
    monitorsLaptop,
    (client) => engine.matchClient(client, IDENTITIES) || "",
    report,
    400,
    150,
    verdicts
  );

  const chips = [];
  for (const monitor of map.monitors) {
    for (const workspace of monitor.workspaces) {
      for (const slot of workspace.slots) for (const chip of slot.chips) chips.push(chip);
    }
  }
  const slack = chips.find((c) => c.identityId === "slack");
  assert.strictEqual(slack.mismatch, "not in its recorded group — group join refused by compositor");
  const terminal = chips.find((c) => c.identityId === "terminal");
  assert.strictEqual(terminal.mismatch, "");
});

test("an unwatched window never carries a mismatch", () => {
  const stranger = makeClient({ address: "0xstranger", class: "totally-unwatched", workspace: 1 });
  const chip = panel.chipFor(stranger, "", null, monitorsLaptop, {
    identityId: "", ok: false, text: "not in its recorded group", blockedBy: null
  });
  assert.strictEqual(chip.mismatch, "");
});

test("verdictLine composes the mismatch and the reason, and nothing when clean", () => {
  assert.strictEqual(panel.verdictLine(null), "");
  assert.strictEqual(panel.verdictLine({ ok: true, text: "" }), "");
  assert.strictEqual(panel.verdictLine({ ok: false, text: "on the wrong workspace" }), "on the wrong workspace");
  assert.strictEqual(
    panel.verdictLine({ ok: false, text: "", blockedBy: { reason: "the compositor said no" } }),
    "the compositor said no"
  );
  assert.strictEqual(
    panel.verdictLine({ ok: false, text: "not in its recorded group", blockedBy: { reason: "refused" } }),
    "not in its recorded group — refused"
  );
});

test("a verdict sentence names its window only when the identity has several", () => {
  // The single case, byte-identical to what it always said.
  const solo = { ok: false, text: "on the wrong workspace", instance: 1, instances: 1 };
  assert.strictEqual(panel.verdictLine(solo), "on the wrong workspace");
  assert.strictEqual(panel.verdictLine({ ok: false, text: "on the wrong workspace" }),
    "on the wrong workspace", "a verdict from before instances existed reads the same");

  // Two windows: the sentence stays identity-level and gains the disambiguator.
  assert.strictEqual(
    panel.verdictLine({ ok: false, text: "on the wrong workspace", instance: 2, instances: 2 }),
    "on the wrong workspace (window 2 of 2)");
  assert.strictEqual(
    panel.verdictLine({
      ok: false, text: "not in its recorded group", instance: 1, instances: 3,
      blockedBy: { reason: "refused" }
    }),
    "not in its recorded group — refused (window 1 of 3)");
  // Nothing to say but which window: still worth saying.
  assert.strictEqual(
    panel.verdictLine({ ok: false, text: "", instance: 3, instances: 3 }),
    "window 3 of 3");
});

test("the panel's instance label is the engine's, word for word", () => {
  // PanelModel may not require engine.js (QML .js imports cannot see each
  // other), so the two copies are pinned to each other here instead.
  const cases = [
    null,
    {},
    { instance: 1, instances: 1 },
    { instance: 1, instances: 2 },
    { instance: 2, instances: 2 },
    { instance: 3, instances: 12 },
    { instances: 4 },
    { instance: 2, instances: "two" }
  ];
  for (const verdict of cases) {
    assert.strictEqual(
      panel.verdictInstanceLabel(verdict),
      engine.verdictInstanceLabel(verdict),
      JSON.stringify(verdict)
    );
  }
});
