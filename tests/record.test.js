// buildLayout — the record side, and the on-disk state schema.
// Source of truth: the schema comment block in engine.js and
// docs/thoughts/2026-08-15-inspiration-and-design-sketch.md ("What to record").

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const {
  loadFixture,
  IDENTITIES,
  makeClient,
  twoWindowGroupClients,
  duplicateWindowGroupClients,
  rotateGroupedPerMember,
  assertGroupInvariant,
  SLACK_CLASS
} = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const monitorsDocked = loadFixture("monitors-laptop+headless.json");

const LAPTOP_DESC = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

function appsById(layout) {
  const out = {};
  for (const app of layout.apps) out[app.identityId] = app;
  return out;
}

// Schema v3: an identity can hold several entries, so the key that names ONE
// entry is its (identityId, occurrence) member key — "slack", "slack#1".
function appsByKey(layout) {
  const out = {};
  for (const app of layout.apps) out[engine.memberKeyFor(app.identityId, app.occurrence)] = app;
  return out;
}

test("a layout records the topology it was taken under", () => {
  assert.strictEqual(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT).topologyKey, LAPTOP_DESC);
  assert.strictEqual(
    engine.buildLayout(clientsLaptop, monitorsDocked, IDENTITIES, AT).topologyKey,
    LAPTOP_DESC + " | hw-test"
  );
});

test("recordedAt is whatever the caller passed, and no clock is read", () => {
  assert.strictEqual(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT).recordedAt, AT);
  assert.strictEqual(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, 1755281400000).recordedAt, 1755281400000);
  assert.strictEqual(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES).recordedAt, null);

  // Same inputs, same bytes — twice.
  const a = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const b = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  assert.deepStrictEqual(a, b);
});

test("engine.js contains no clock call at all", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "engine.js"), "utf8");
  assert.ok(!/Date\.now|new Date\(/.test(source), "engine.js must stay clock-free");
});

test("one entry per running WINDOW of every watched identity, in identity order", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);

  // Identity order still governs the rows (matchClient's first-match priority);
  // an identity with two windows simply contributes two adjacent rows.
  assert.deepStrictEqual(
    layout.apps.map((a) => a.identityId),
    ["obsidian", "telegram", "slack", "whatsapp", "gmail", "gmail",
      "gcal", "rtm", "browser", "editor", "terminal", "terminal"]
  );

  // Two foot windows and two Gmail windows are open, and since schema v3 each
  // contributes an entry of its own. Before that, the second of each pair was
  // invisible to the record and therefore to restore.
  const terminals = layout.apps.filter((a) => a.identityId === "terminal");
  const mails = layout.apps.filter((a) => a.identityId === "gmail");
  assert.deepStrictEqual(terminals.map((a) => a.occurrence), [0, 1]);
  assert.deepStrictEqual(mails.map((a) => a.occurrence), [0, 1]);

  // And the occurrence is PLACEMENT order, not hyprctl order: one monitor, one
  // workspace apiece, so the window's own x decides which is which.
  assert.deepStrictEqual(terminals.map((a) => a.at[0]), [12, 727]);
  assert.deepStrictEqual(mails.map((a) => a.at[0]), [0, 727]);
});

test("shuffling the hyprctl read does not change a single occurrence", () => {
  // The whole point of the placement comparator: hyprctl lists windows in
  // creation/focus order, which changes when nothing on the desk has moved.
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const reversed = engine.buildLayout(clientsLaptop.slice().reverse(), monitorsLaptop, IDENTITIES, AT);
  assert.deepStrictEqual(reversed, layout, "a reversed read records the identical layout");

  // And a rotation, which reverse alone would not catch.
  const rotated = clientsLaptop.slice(5).concat(clientsLaptop.slice(0, 5));
  assert.deepStrictEqual(engine.buildLayout(rotated, monitorsLaptop, IDENTITIES, AT), layout);
});

test("apps that are not running are absent, unwatched windows are excluded", () => {
  const withGhost = IDENTITIES.concat([{ id: "spotify", patterns: ["^spotify$"] }]);
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, withGhost, AT);
  assert.ok(!appsById(layout).spotify);

  // Only one identity watched → only one entry, even though 12 windows are open.
  const narrow = engine.buildLayout(clientsLaptop, monitorsLaptop, [{ id: "editor", patterns: ["^code$"] }], AT);
  assert.strictEqual(narrow.apps.length, 1);
  assert.strictEqual(narrow.apps[0].identityId, "editor");

  // Nothing watched → nothing recorded, but the topology key still stands.
  const none = engine.buildLayout(clientsLaptop, monitorsLaptop, [], AT);
  assert.deepStrictEqual(none.apps, []);
  assert.strictEqual(none.topologyKey, LAPTOP_DESC);
});

test("placement stores the monitor DESCRIPTION, never the index", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);

  for (const app of layout.apps) {
    assert.strictEqual(app.monitorDescription, LAPTOP_DESC);
    assert.strictEqual(typeof app.monitorDescription, "string");
    assert.ok(!("monitor" in app), "no raw monitor index may leak into the record");
  }
  assert.ok(!JSON.stringify(layout).includes('"monitor":'));
});

test("placement stores workspace id and floating", () => {
  const apps = appsById(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT));

  assert.strictEqual(apps.obsidian.workspaceId, 10);
  assert.strictEqual(apps.editor.workspaceId, 3);
  assert.strictEqual(apps.terminal.workspaceId, 1);
  assert.strictEqual(apps.browser.workspaceId, 2);
  assert.strictEqual(apps.gmail.workspaceId, 9);
  assert.strictEqual(apps.gcal.workspaceId, 8);

  for (const app of Object.values(apps)) assert.strictEqual(app.floating, false);

  const floated = clientsLaptop.map((c) => (c.class === "code" ? Object.assign({}, c, { floating: true }) : c));
  assert.strictEqual(appsById(engine.buildLayout(floated, monitorsLaptop, IDENTITIES, AT)).editor.floating, true);
});

// --- special workspaces are refused at the door (tick pqv) -------------------
//
// Live evidence: docs/thoughts/2026-08-17-special-ws-probe.md. A negative
// workspace id is a RELATIVE selector to every Hyprland dispatcher, so
// recording one buys a row whose only restore op moves the wrong workspace and
// answers "ok" while doing it.

test("an app parked on a special workspace is NOT recorded, and the result says why", () => {
  const scratchpadded = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { workspace: { id: -98, name: "special:magic" } }) : c
  );
  const layout = engine.buildLayout(scratchpadded, monitorsLaptop, IDENTITIES, AT);

  assert.ok(!appsById(layout).editor, "a scratchpad placement must not enter the layout");
  assert.strictEqual(
    layout.apps.length,
    engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT).apps.length - 1,
    "exactly one entry short — nothing else may be dropped"
  );

  // Omitted LOUDLY: the structured note is what the panel and record-current
  // turn into a line, so a short recording is never a silent one.
  assert.deepStrictEqual(layout.excluded, [
    { identityId: "editor", occurrence: 0, reason: "workspace-special", workspaceId: -98, workspaceName: "special:magic" }
  ]);

  // An ordinary recording says nothing, rather than saying nothing happened.
  assert.deepStrictEqual(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT).excluded, []);

  // And the note never reaches the file: the layout the state model stores is
  // topologyKey/recordedAt/apps, exactly as it was before this tick.
  const stored = state.upsertLayout(state.defaultState(), layout).layouts[layout.topologyKey];
  assert.ok(!("excluded" in stored), "the note is a report, not a schema field");
});

test("no negative workspace id can reach a new recording, whatever shape it arrives in", () => {
  for (const workspace of [{ id: -1, name: "special:a" }, { id: -98, name: "special:b" }]) {
    const clients = [makeClient({ address: "0xfff", class: "code", workspace })];
    const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
    assert.deepStrictEqual(layout.apps, [], "ws " + workspace.id + " must not be recorded");
    assert.strictEqual(layout.excluded.length, 1);
  }

  // Positive ids and the unreadable-workspace null are untouched by the filter.
  assert.strictEqual(engine.isSpecialWorkspaceId(1), false);
  assert.strictEqual(engine.isSpecialWorkspaceId(0), false);
  assert.strictEqual(engine.isSpecialWorkspaceId(null), false);
  assert.strictEqual(engine.isSpecialWorkspaceId(-98), true);
  // A hand-edited file can carry the number as text.
  assert.strictEqual(engine.isSpecialWorkspaceId("-98"), true);
});

test("a monitor that cannot be resolved records an empty description", () => {
  const orphan = [makeClient({ address: "0xfff", class: "code", workspace: 3, monitor: 7 })];
  const layout = engine.buildLayout(orphan, monitorsLaptop, IDENTITIES, AT);

  assert.strictEqual(layout.apps.length, 1);
  assert.strictEqual(layout.apps[0].monitorDescription, "");
  assert.strictEqual(layout.apps[0].workspaceId, 3);
});

test("the real four-window group records its tab order", () => {
  const apps = appsById(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT));
  const expectedOrder = ["obsidian", "telegram", "slack", "whatsapp"];
  const groupId = "group:" + expectedOrder.join("+");

  expectedOrder.forEach((id, index) => {
    assert.ok(apps[id].group, id + " should be grouped");
    assert.strictEqual(apps[id].group.groupId, groupId);
    assert.strictEqual(apps[id].group.index, index);
  });

  // Everyone else is ungrouped.
  for (const app of Object.values(apps)) {
    if (expectedOrder.indexOf(app.identityId) === -1) assert.strictEqual(app.group, null);
  }
});

test("the group id is stable across recaptures but changes with membership", () => {
  const first = appsById(engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT)).obsidian.group.groupId;

  // Same group, different window addresses (as after a relaunch).
  const relaunched = clientsLaptop.map((c) => {
    const remap = (a) => a.replace("0x55c6", "0x77d7");
    return Object.assign({}, c, { address: remap(c.address), grouped: c.grouped.map(remap) });
  });
  assert.strictEqual(appsById(engine.buildLayout(relaunched, monitorsLaptop, IDENTITIES, AT)).obsidian.group.groupId, first);

  // Drop WhatsApp from the watched list → different membership, different id.
  const fewer = IDENTITIES.filter((i) => i.id !== "whatsapp");
  assert.notStrictEqual(appsById(engine.buildLayout(clientsLaptop, monitorsLaptop, fewer, AT)).obsidian.group.groupId, first);
});

test("a synthesized two-window group preserves tab order, not array order", () => {
  const clients = twoWindowGroupClients();
  const apps = appsById(engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT));

  // hyprctl lists chromium first and IDENTITIES ranks it first too, but the
  // tab order is foot, then chromium.
  assert.strictEqual(apps.terminal.group.index, 0);
  assert.strictEqual(apps.browser.group.index, 1);
  assert.strictEqual(apps.terminal.group.groupId, "group:terminal+browser");
  assert.strictEqual(apps.browser.group.groupId, apps.terminal.group.groupId);
  assert.strictEqual(apps.terminal.workspaceId, 2);
  assert.strictEqual(apps.browser.workspaceId, 2);
  assert.strictEqual(apps.editor.group, null);
});

test("reversing the tab order reverses the recorded indexes", () => {
  const clients = twoWindowGroupClients().map((c) =>
    c.grouped.length ? Object.assign({}, c, { grouped: c.grouped.slice().reverse() }) : c
  );
  const apps = appsById(engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT));

  assert.strictEqual(apps.browser.group.index, 0);
  assert.strictEqual(apps.terminal.group.index, 1);
  assert.strictEqual(apps.browser.group.groupId, "group:browser+terminal");
});

// --- one window choice per identity (user gate finding 4) --------------------
//
// The failure this section exists for, from the user's live state:
//
//   { identityId: "telegram", workspaceId: 10,
//     group: { groupId: "group:telegram+slack+whatsapp", index: 0 } }
//   { identityId: "slack",    workspaceId: 9,  group: null }
//   { identityId: "whatsapp", workspaceId: 10,
//     group: { groupId: "group:telegram+slack+whatsapp", index: 2 } }
//
// Indexes 0 and 2, and the identity named at index 1 recorded on another
// workspace, ungrouped. That group can never be rebuilt: the member at index 1
// is not in it.

test("an identity with two windows records BOTH, and the grouped one keeps its slot", () => {
  const clients = duplicateWindowGroupClients();

  // The old representative-window tie-breaks still answer the question they
  // were asked — the panel still asks it — and they still disagree with each
  // other: "first in hyprctl order" is the LONE Slack window on ws 9, and the
  // group-aware pick is the one tabbed in with Telegram and WhatsApp.
  assert.strictEqual(engine.firstClientFor(clients, IDENTITIES[2], IDENTITIES).address, "0xslackalone");
  assert.strictEqual(IDENTITIES[2].id, "slack");
  assert.strictEqual(engine.pickClientFor(clients, IDENTITIES[2], IDENTITIES).address, "0xslackgrouped");

  // The RECORD no longer has to choose, which is what closes the index hole for
  // good rather than merely picking the right side of it: both Slack windows
  // get an entry, and only one of them is in the group.
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const byKey = appsByKey(layout);
  assert.deepStrictEqual(
    layout.apps.filter((a) => a.identityId === "slack").map((a) => a.occurrence),
    [0, 1]
  );

  // Placement order: same monitor, so the workspace id decides. The lone window
  // on ws 9 is occurrence 0; the grouped one on ws 10 is occurrence 1.
  assert.strictEqual(byKey["slack"].workspaceId, 9);
  assert.strictEqual(byKey["slack"].group, null);
  assert.strictEqual(byKey["slack#1"].workspaceId, 10);

  // The group names the TUPLE, so the membership says which Slack window it
  // means — and the three indexes are still 0, 1, 2 with no hole.
  const groupId = "group:telegram+slack#1+whatsapp";
  assert.deepStrictEqual(byKey["slack#1"].group, { groupId: groupId, index: 1 });
  assert.strictEqual(byKey.telegram.group.index, 0);
  assert.strictEqual(byKey.whatsapp.group.index, 2);
  for (const key of ["telegram", "slack#1", "whatsapp"]) {
    assert.strictEqual(byKey[key].group.groupId, groupId);
  }
  assertGroupInvariant(assert, layout, "duplicate-window fixture");
});

test("the recorded group invariant holds: no index holes, every member owns its group", () => {
  assertGroupInvariant(assert, engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT), "laptop fixture");
  assertGroupInvariant(
    assert,
    engine.buildLayout(duplicateWindowGroupClients(), monitorsLaptop, IDENTITIES, AT),
    "duplicate-window fixture"
  );
  assertGroupInvariant(
    assert,
    engine.buildLayout(twoWindowGroupClients(), monitorsLaptop, IDENTITIES, AT),
    "two-window fixture"
  );

  // And the shape the user's corrupt record had is now unreachable: no entry
  // is left claiming a group that does not claim it back.
  const layout = engine.buildLayout(duplicateWindowGroupClients(), monitorsLaptop, IDENTITIES, AT);
  const named = {};
  for (const app of layout.apps) {
    if (!app.group) continue;
    for (const key of app.group.groupId.replace(/^group:/, "").split("+")) named[key] = app.group.groupId;
  }
  for (const app of layout.apps) {
    const key = engine.memberKeyFor(app.identityId, app.occurrence);
    if (!named[key]) continue;
    assert.ok(app.group, key + " is named by a group but recorded ungrouped");
  }
});

test("two windows of one identity in one group both record, at two tab indexes", () => {
  // The behavior schema v3 REPLACED. Before it, the second Slack window
  // collapsed out of the membership — the group recorded as two tabs, and a
  // restore rebuilt two tabs where the user had three.
  const tabs = ["0xtele", "0xslackA", "0xslackB"];
  const clients = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xslackA", class: SLACK_CLASS, workspace: 10, grouped: tabs }),
    makeClient({ address: "0xslackB", class: SLACK_CLASS, workspace: 10, grouped: tabs })
  ];
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const byKey = appsByKey(layout);

  // Same monitor, same workspace, same rect: the address is the tie-break that
  // makes the order total, and "0xslackA" sorts before "0xslackB".
  const groupId = "group:telegram+slack+slack#1";
  assert.deepStrictEqual(Object.keys(byKey).sort(), ["slack", "slack#1", "telegram"]);
  for (const key of ["telegram", "slack", "slack#1"]) {
    assert.strictEqual(byKey[key].group.groupId, groupId, key);
  }
  assert.strictEqual(byKey.telegram.group.index, 0);
  assert.strictEqual(byKey.slack.group.index, 1);
  assert.strictEqual(byKey["slack#1"].group.index, 2);
  assertGroupInvariant(assert, layout, "two slack windows in one group");
});

test("every member of a group reports the SAME tab order — the ring is not rotated", () => {
  // The assumption the whole record side rests on, and it is live-verified on
  // this machine (2026-08-15, Hyprland 0.56): a real three-window group of
  // scratch foot windows (mw-g1/g2/g3) answered
  //
  //   mw-g1  0x…6d80  ["0x…6d80","0x…a120","0x…5610"]
  //   mw-g2  0x…a120  ["0x…6d80","0x…a120","0x…5610"]
  //   mw-g3  0x…5610  ["0x…6d80","0x…a120","0x…5610"]
  //
  // — the identical array, in the identical order, from every member. `grouped`
  // is the group's tab order, not a ring rotated to start at whoever is asked.
  // That is what lets one member's view stand for the group's, which is what
  // makes the recorded indexes agree with each other.
  const captured = loadFixture("clients-laptop.json").filter((c) => (c.grouped || []).length);
  assert.strictEqual(captured.length, 4, "the captured fixture should hold the real four-window group");
  for (const member of captured) {
    assert.deepStrictEqual(member.grouped, captured[0].grouped, member.class + " sees a different tab order");
  }
});

test("the rebuild's order check is anchored, so it cannot be fooled by where a ring starts", () => {
  // normalizeGroupOrder is the machinery the group rebuild asserts through. The
  // live ring is not rotated (above), so on a healthy read this is the identity
  // function — it exists so the assertion stays true against the window the
  // rebuild actually created the group around, whichever member is read.
  const ring = ["0xaaa", "0xbbb", "0xccc"];
  assert.deepStrictEqual(engine.normalizeGroupOrder(ring, "0xaaa"), ring);
  assert.deepStrictEqual(engine.normalizeGroupOrder(["0xbbb", "0xccc", "0xaaa"], "0xaaa"), ring);
  assert.deepStrictEqual(engine.normalizeGroupOrder(["0xccc", "0xaaa", "0xbbb"], "0xaaa"), ring);
  // An anchor that is not in the ring leaves the ring alone — there is no
  // rotation that can make it start at a window that is not there.
  assert.deepStrictEqual(engine.normalizeGroupOrder(ring, "0xzzz"), ring);
  assert.deepStrictEqual(engine.normalizeGroupOrder(null, "0xaaa"), []);

  assert.strictEqual(engine.groupOrderMatches({ grouped: ring }, ring, "0xaaa"), true);
  assert.strictEqual(engine.groupOrderMatches({ grouped: ["0xbbb", "0xccc", "0xaaa"] }, ring, "0xaaa"), true);
  assert.strictEqual(engine.groupOrderMatches({ grouped: ["0xaaa", "0xccc", "0xbbb"] }, ring, "0xaaa"), false);
  assert.strictEqual(engine.groupOrderMatches({ grouped: ["0xaaa", "0xbbb"] }, ring, "0xaaa"), false);
  assert.strictEqual(engine.groupOrderMatches(null, ring, "0xaaa"), false);
});

test("a per-member rotated ring is exactly what the record could NOT survive", () => {
  // The counterfactual, pinned so the assumption above is not just a comment.
  // Rotate the fixture the way a per-member ring would report it and the two
  // members no longer agree on who is first — which is a DIFFERENT groupId per
  // member and an unrebuildable record. hyprctl does not do this (live-verified
  // three ways: the captured four-window fixture, the mw-g1/g2/g3 probe, and
  // this project's own panel rendering one fused slot rather than N). If a
  // future Hyprland ever did, this test fails first and says why.
  const rotated = rotateGroupedPerMember(twoWindowGroupClients());
  const apps = appsById(engine.buildLayout(rotated, monitorsLaptop, IDENTITIES, AT));

  assert.strictEqual(apps.terminal.group.groupId, "group:terminal+browser");
  assert.strictEqual(apps.browser.group.groupId, "group:browser+terminal");
  assert.throws(
    () => assertGroupInvariant(assert, engine.buildLayout(rotated, monitorsLaptop, IDENTITIES, AT)),
    "a rotated ring must trip the group invariant, not pass quietly"
  );
});

test("a group with only one watched member is recorded as ungrouped", () => {
  const tabOrder = ["0xaaa", "0xbbb"];
  const clients = [
    makeClient({ address: "0xaaa", class: "code", workspace: 4, grouped: tabOrder }),
    makeClient({ address: "0xbbb", class: "org.gnome.Nautilus", workspace: 4, grouped: tabOrder })
  ];
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);

  assert.strictEqual(layout.apps.length, 1);
  assert.strictEqual(layout.apps[0].group, null);
});

// --- identity priority at record time ---------------------------------------

// A Chromium webapp nobody has a specific identity for. The catch-all is the
// only thing that can claim it.
const FIGMA = "chrome-app.figma.com__file-Profile_1";
const CATCH_ALL = { id: "anything-chrome", patterns: ["^chrome"] };

test("a catch-all identity behind the specific ones records each window once", () => {
  // `^chrome` matches every Chromium webapp class in the fixture. Identity
  // order is priority order, so the specific identities in front of it keep
  // their windows and the catch-all gets only what is left over.
  const identities = IDENTITIES.concat([CATCH_ALL]);
  const clients = clientsLaptop.concat([makeClient({ address: "0xf16", class: FIGMA, workspace: 5 })]);
  const layout = engine.buildLayout(clients, monitorsLaptop, identities, AT);
  const apps = appsById(layout);

  // No window is claimed by two identities — that is what would put the same
  // window into the record twice.
  const claimed = identities
    .map((i) => engine.firstClientFor(clients, i, identities))
    .filter(Boolean)
    .map((c) => c.address);
  assert.strictEqual(new Set(claimed).size, claimed.length, "a window was recorded under two identities");

  // The specific identities are untouched...
  assert.strictEqual(apps.gmail.workspaceId, 9);
  assert.strictEqual(apps.slack.group.index, 2);
  assert.strictEqual(apps.browser.workspaceId, 2);

  // ...and the catch-all still catches what none of them matched.
  assert.strictEqual(apps["anything-chrome"].workspaceId, 5);
  assert.strictEqual(apps["anything-chrome"].group, null);

  // A window resolved to one identity is a member of its own group, so no
  // entry can end up with the "I am not in this group" index.
  for (const app of layout.apps) {
    if (app.group) assert.notStrictEqual(app.group.index, -1, app.identityId + " recorded group.index -1");
  }
});

test("moving the catch-all to the front takes the windows away from the specific ones", () => {
  // The mirror image, so the ordering is demonstrably load-bearing and not an
  // accident of which patterns happen to overlap.
  const identities = [CATCH_ALL].concat(IDENTITIES);
  const clients = clientsLaptop.concat([makeClient({ address: "0xf16", class: FIGMA, workspace: 5 })]);
  const apps = appsById(engine.buildLayout(clients, monitorsLaptop, identities, AT));

  for (const stolen of ["gmail", "gcal", "slack", "whatsapp", "rtm"]) {
    assert.ok(!apps[stolen], stolen + " should have been swallowed by the catch-all in front");
  }
  // `chromium` does not start with "chrome", so the browser keeps its window.
  assert.strictEqual(apps.browser.workspaceId, 2);
  assert.ok(apps["anything-chrome"]);
});

test("the record round-trips through JSON unchanged", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(layout)), layout);

  // And carries exactly the documented fields. `excluded` (tick pqv) is the
  // recorder's REPORT — apps deliberately left out, with the reason — and is
  // not part of the stored layout; the test above pins that it never reaches
  // the file.
  assert.deepStrictEqual(Object.keys(layout).sort(), ["apps", "excluded", "recordedAt", "topologyKey"]);
  for (const app of layout.apps) {
    assert.deepStrictEqual(
      Object.keys(app).sort(),
      ["at", "floating", "group", "identityId", "monitorDescription", "occurrence", "size", "workspaceId"]
    );
    if (app.group) assert.deepStrictEqual(Object.keys(app.group).sort(), ["groupId", "index"]);
  }
});

// -------------------------------------------------- geometry (schema v2)

test("the record carries each window's position and size off the live read", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const chosen = engine.chosenWindows(clientsLaptop, IDENTITIES, monitorsLaptop);

  assert.ok(layout.apps.length > 0);
  for (const app of layout.apps) {
    const where = engine.memberKeyFor(app.identityId, app.occurrence);
    const client = engine.windowForOccurrence(chosen, app.identityId, app.occurrence);
    assert.deepStrictEqual(app.at, client.at, where + " records the window's own at");
    assert.deepStrictEqual(app.size, client.size, where + " records the window's own size");
  }

  // Spot-check against the fixture by hand, so this test would notice the two
  // fields being swapped — which every "compare to the client" loop would not.
  assert.deepStrictEqual(appsById(layout).obsidian.at, [12, 66]);
  assert.deepStrictEqual(appsById(layout).obsidian.size, [1416, 822]);
});

test("geometry is read off the CHOSEN window, not the first one that matched", () => {
  // The duplicate-window trap, in geometry form: slack has two windows, and the
  // grouped one is the one the record describes. Its geometry has to come from
  // the same window as its workspace, or the entry describes a desktop that
  // never existed.
  const clients = duplicateWindowGroupClients().map((c) =>
    c.address === "0xslackalone"
      ? Object.assign({}, c, { at: [0, 0], size: [800, 600] })
      : Object.assign({}, c, { at: [100, 200], size: [1200, 900] })
  );
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const byKey = appsByKey(layout);

  assert.strictEqual(byKey["slack#1"].workspaceId, 10, "the grouped window is occurrence 1");
  assert.deepStrictEqual(byKey["slack#1"].at, [100, 200], "and it records its OWN geometry");
  assert.deepStrictEqual(byKey["slack#1"].size, [1200, 900]);
  assert.deepStrictEqual(byKey["slack"].at, [0, 0], "the lone window records its own, on its own row");
  assert.deepStrictEqual(byKey["slack"].size, [800, 600]);
});

test("a window whose geometry the read did not carry records null, not zeros", () => {
  // [0, 0] is a real position. A record that cannot tell "at the origin" from
  // "we never saw it" makes every later score confidently wrong.
  const clients = [
    makeClient({ address: "0xa", class: "foot", workspace: 1, at: undefined, size: undefined }),
    makeClient({ address: "0xb", class: "code", workspace: 1, at: [0, 0], size: [10, 10] }),
    makeClient({ address: "0xc", class: "chromium", workspace: 1, at: [1, 2, 3], size: ["wide", 10] })
  ];
  const apps = appsById(engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT));

  assert.strictEqual(apps.terminal.at, null);
  assert.strictEqual(apps.terminal.size, null);
  assert.deepStrictEqual(apps.editor.at, [0, 0], "the origin is recorded, not nulled");
  assert.deepStrictEqual(apps.editor.size, [10, 10]);
  assert.strictEqual(apps.browser.at, null, "a three-element array is not a position");
  assert.strictEqual(apps.browser.size, null);
});

test("geometry comes back byte-identical through the state file", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const stored = state.parseState(state.serializeState(state.upsertLayout(state.defaultState(), layout))).state;
  // Everything the file actually holds. `excluded` is the recorder's report and
  // is dropped on the way in (tick pqv) — deliberately, so the round trip stays
  // byte-identical rather than growing a field a re-read would strip anyway.
  assert.deepStrictEqual(state.layoutFor(stored, LAPTOP_DESC), {
    topologyKey: layout.topologyKey,
    recordedAt: layout.recordedAt,
    apps: layout.apps
  });
});

test("buildLayout tolerates missing inputs", () => {
  const empty = engine.buildLayout(null, null, IDENTITIES, AT);
  assert.deepStrictEqual(empty.apps, []);
  assert.strictEqual(empty.topologyKey, "");
  assert.deepStrictEqual(engine.buildLayout(clientsLaptop, monitorsLaptop, null, AT).apps, []);
});

// ------------------------------------ schema v3: occurrences (tick s8b)

// A desktop where every watched identity has exactly ONE window: the shape of
// the overwhelming majority of records, and the one that must not have moved.
function singleWindowClients() {
  const seen = {};
  return clientsLaptop.filter((c) => {
    const id = engine.matchClient(c, IDENTITIES);
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

test("a single-window desktop records exactly what v2 recorded, plus occurrence 0", () => {
  // The compatibility pin for the whole epic. Everything about a one-window
  // identity — its fields, its values, its groupId spelling — is byte-identical
  // to the v2 record; the only difference in the file is the number 0.
  const layout = engine.buildLayout(singleWindowClients(), monitorsLaptop, IDENTITIES, AT);

  assert.deepStrictEqual(layout.apps.map((a) => a.identityId), IDENTITIES.map((i) => i.id));
  for (const app of layout.apps) {
    assert.strictEqual(app.occurrence, 0, app.identityId);

    const withoutOccurrence = Object.assign({}, app);
    delete withoutOccurrence.occurrence;
    assert.deepStrictEqual(
      Object.keys(withoutOccurrence).sort(),
      ["at", "floating", "group", "identityId", "monitorDescription", "size", "workspaceId"],
      app.identityId + " carries the v2 field set and nothing else"
    );

    // And no "#" reaches a stored string: a member key at occurrence 0 is the
    // bare identity id, so the groupId a v2 file holds still reads back equal.
    if (app.group) assert.strictEqual(app.group.groupId.indexOf("#"), -1, app.group.groupId);
  }
  assert.strictEqual(JSON.stringify(layout).indexOf("#"), -1, "no member key suffix in the record");
});

test("the placement comparator orders by monitor, workspace, rect, then address", () => {
  const monitors = [
    { id: 0, name: "eDP-1", description: "Left", x: 0, y: 0, width: 1920, height: 1080 },
    { id: 1, name: "DP-1", description: "Right", x: 1920, y: 0, width: 1920, height: 1080 }
  ];
  const c = (address, monitor, ws, at) =>
    makeClient({ address: address, class: "foot", monitor: monitor, workspace: ws, at: at });

  const windows = [
    c("0xd", 1, 1, [2000, 0]),   // right monitor beats everything
    c("0xc", 0, 5, [0, 0]),      // same monitor, later workspace
    c("0xb", 0, 1, [900, 0]),    // same workspace, further right
    c("0xa2", 0, 1, [10, 0]),
    c("0xa1", 0, 1, [10, 0])     // identical rect: the address decides
  ];
  const sorted = windows.slice().sort(engine.placementComparator(monitors));
  assert.deepStrictEqual(sorted.map((w) => w.address), ["0xa1", "0xa2", "0xb", "0xc", "0xd"]);

  // y before x is NOT the rule; x is the more significant of the pair.
  assert.strictEqual(engine.comparePlacementKeys(
    engine.placementKeyOf(c("0x1", 0, 1, [10, 900]), monitors),
    engine.placementKeyOf(c("0x2", 0, 1, [20, 0]), monitors)
  ), -1);

  // A window whose monitor cannot be resolved sorts LAST rather than randomly.
  const orphan = c("0x0", 9, 1, [0, 0]);
  assert.strictEqual(
    [orphan, windows[0]].sort(engine.placementComparator(monitors))[1].address, "0x0");

  // The comparator is a total order: equal keys compare 0, both ways.
  const key = engine.placementKeyOf(windows[0], monitors);
  assert.strictEqual(engine.comparePlacementKeys(key, key), 0);
});

test("member keys spell occurrence 0 as the bare identity id, and round-trip", () => {
  assert.strictEqual(engine.memberKeyFor("gmail", 0), "gmail");
  assert.strictEqual(engine.memberKeyFor("gmail", 2), "gmail#2");
  assert.strictEqual(engine.memberKeyFor("gmail", undefined), "gmail");
  assert.strictEqual(engine.memberKeyFor("gmail", -1), "gmail", "junk is occurrence 0");
  assert.strictEqual(engine.memberKeyFor("gmail", 1.5), "gmail");

  for (const [id, occ] of [["gmail", 0], ["gmail", 3], ["a#b", 2], ["chrome-app.slack.com", 1]]) {
    const key = engine.memberKeyFor(id, occ);
    assert.strictEqual(engine.memberIdentityOf(key), id, key);
    assert.strictEqual(engine.memberOccurrenceOf(key), occ, key);
  }
});

test("chosenWindows indexes every window of an identity, both ways round", () => {
  const chosen = engine.chosenWindows(clientsLaptop, IDENTITIES, monitorsLaptop);

  assert.strictEqual(chosen.byId.terminal.length, 2);
  assert.strictEqual(chosen.byId.editor.length, 1);
  assert.strictEqual(chosen.byId.spotify, undefined, "an identity with no window is absent");

  for (const identityId of Object.keys(chosen.byId)) {
    chosen.byId[identityId].forEach((client, occurrence) => {
      assert.deepStrictEqual(chosen.idByAddress[client.address], { identityId, occurrence });
      assert.strictEqual(
        engine.windowForOccurrence(chosen, identityId, occurrence).address, client.address);
    });
  }
  assert.strictEqual(engine.windowForOccurrence(chosen, "terminal", 7), null);
  assert.strictEqual(engine.windowForOccurrence(chosen, "spotify", 0), null);
});
