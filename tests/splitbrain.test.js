// Post-wake failure, case 5 (2026-08-16). Two separate guards live here.
//
// 1. The plan/snapshot address invariant. The reported symptom was "the plan
//    names window addresses the live desktop does not have". It turned out not
//    to be what happened — the addresses were live at plan time and were only
//    absent from a client list read six minutes later — but the invariant it
//    would have violated is worth holding to permanently, because nothing else
//    in the system can see it break.
//
// 2. Split-brain group state. What DID happen: after the docked wake the four
//    ws-10 windows disagreed about who was in their tab group. The three
//    messengers each reported the full four-member array; obsidian reported a
//    group of itself alone. Every dissolve/rebuild decision that asks one
//    window's own `grouped` array is wrong in that state.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const { loadFixture, IDENTITIES, makeClient, assertGroupInvariant } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const clientsDocked = loadFixture("clients-laptop+headless.json");
const monitorsDocked = loadFixture("monitors-laptop+headless.json");

const AT = "2026-08-16T05:00:00Z";

// --- the live case, as a fixture --------------------------------------------
//
// The addresses are the ones from the user's desktop, so a reader can match
// this against the qs log lines that motivated it.

const OBSIDIAN = "0x55c6f662f8c0";
const SLACK = "0x55c6f64632c0";
const TELEGRAM = "0x55c6f748cf20";
const WHATSAPP = "0x55c6f83237c0";

const WHOLE_GROUP = [OBSIDIAN, SLACK, TELEGRAM, WHATSAPP];

// The healthy read: every member reports the same array.
function healthyGroupClients() {
  return [
    makeClient({ address: OBSIDIAN, class: "md.obsidian.Obsidian", workspace: 10, grouped: WHOLE_GROUP }),
    makeClient({ address: SLACK, class: "chrome-app.slack.com__x-Profile_1", workspace: 10, grouped: WHOLE_GROUP }),
    makeClient({ address: TELEGRAM, class: "org.telegram.desktop", workspace: 10, grouped: WHOLE_GROUP }),
    makeClient({ address: WHATSAPP, class: "chrome-web.whatsapp.com__-Profile_1", workspace: 10, grouped: WHOLE_GROUP })
  ];
}

// The read the user's desktop actually produced after the docked wake: the
// three messengers agree, obsidian reports a group of one.
function splitBrainClients() {
  const clients = healthyGroupClients();
  clients[0].grouped = [OBSIDIAN];
  return clients;
}

// The opposite polarity, which is just as possible and must behave the same
// way: obsidian reports the whole group, the messengers report nothing.
function splitBrainInvertedClients() {
  const clients = healthyGroupClients();
  clients[1].grouped = [];
  clients[2].grouped = [];
  clients[3].grouped = [];
  return clients;
}

// --- claims -----------------------------------------------------------------

test("a healthy group: every member claims every other member", () => {
  const clients = healthyGroupClients();
  assert.deepStrictEqual(engine.groupClaimants(clients, OBSIDIAN).sort(), [SLACK, TELEGRAM, WHATSAPP].sort());
  assert.deepStrictEqual(engine.groupClaimants(clients, SLACK).sort(), [OBSIDIAN, TELEGRAM, WHATSAPP].sort());
});

test("a window never claims itself", () => {
  const clients = healthyGroupClients();
  assert.ok(engine.groupClaimants(clients, OBSIDIAN).indexOf(OBSIDIAN) === -1);
});

test("split-brain: the under-reporting member is still claimed by its peers", () => {
  const clients = splitBrainClients();
  // Its own array says it is alone...
  assert.deepStrictEqual(clients[0].grouped, [OBSIDIAN]);
  // ...but the other three all name it, and that is a claim.
  assert.deepStrictEqual(engine.groupClaimants(clients, OBSIDIAN).sort(), [SLACK, TELEGRAM, WHATSAPP].sort());
  assert.strictEqual(engine.isGroupClaimed(clients, OBSIDIAN), true);
});

test("split-brain inverted: a member with an EMPTY array is still claimed", () => {
  const clients = splitBrainInvertedClients();
  assert.deepStrictEqual(clients[1].grouped, []);
  assert.strictEqual(engine.isGroupClaimed(clients, SLACK), true);
  assert.deepStrictEqual(engine.groupClaimants(clients, SLACK), [OBSIDIAN]);
});

test("a genuinely ungrouped window is claimed by nobody", () => {
  const clients = healthyGroupClients().concat([
    makeClient({ address: "0xlone", class: "foot", workspace: 3 })
  ]);
  assert.deepStrictEqual(engine.groupClaimants(clients, "0xlone"), []);
  assert.strictEqual(engine.isGroupClaimed(clients, "0xlone"), false);
});

test("a solo group is a group — grouped:[self] counts as claimed", () => {
  const clients = [makeClient({ address: "0xsolo", class: "foot", workspace: 3, grouped: ["0xsolo"] })];
  assert.strictEqual(engine.isGroupClaimed(clients, "0xsolo"), true);
  // ...but it has no peers, which is what tells a dissolve it created the group
  // rather than found it.
  assert.deepStrictEqual(engine.groupClaimants(clients, "0xsolo"), []);
});

test("claims tolerate junk: no grouped field, a non-array, an unknown address", () => {
  const clients = [
    makeClient({ address: "0xa", class: "foot" }),
    Object.assign(makeClient({ address: "0xb", class: "foot" }), { grouped: null }),
    Object.assign(makeClient({ address: "0xc", class: "foot" }), { grouped: "0xa" })
  ];
  assert.deepStrictEqual(engine.groupClaimants(clients, "0xa"), []);
  assert.deepStrictEqual(engine.groupClaimants(clients, "0xnothere"), []);
  assert.deepStrictEqual(engine.groupClaimants([], "0xa"), []);
  assert.strictEqual(engine.isGroupClaimed(clients, "0xb"), false);
  assert.strictEqual(engine.isGroupClaimed(null, "0xa"), false);
});

// --- the dissolve list ------------------------------------------------------

test("a healthy group dissolves through its members, in recorded order", () => {
  const clients = healthyGroupClients();
  assert.deepStrictEqual(engine.dissolveTargets(WHOLE_GROUP, clients), WHOLE_GROUP);
});

test("split-brain: the member whose own array under-reports is STILL dissolved", () => {
  const clients = splitBrainClients();
  assert.deepStrictEqual(engine.dissolveTargets(WHOLE_GROUP, clients), WHOLE_GROUP);
});

test("split-brain inverted: members with empty arrays are STILL dissolved", () => {
  const clients = splitBrainInvertedClients();
  assert.deepStrictEqual(engine.dissolveTargets(WHOLE_GROUP, clients), WHOLE_GROUP);
});

test("a stranger tabbed into the group is dissolved too", () => {
  // group.toggle acts on whole groups, so a non-member sharing the group has to
  // be cleared or the rebuild is fighting a group it did not make.
  const withStranger = WHOLE_GROUP.concat(["0xstranger"]);
  const clients = healthyGroupClients().map((c) => Object.assign(c, { grouped: withStranger }));
  clients.push(makeClient({ address: "0xstranger", class: "foot", workspace: 10, grouped: withStranger }));

  const targets = engine.dissolveTargets(WHOLE_GROUP, clients);
  // Recorded members first, in recorded order; the stranger after them.
  assert.deepStrictEqual(targets, WHOLE_GROUP.concat(["0xstranger"]));
});

test("an ungrouped recorded member is NOT dissolved — toggling it would create a group", () => {
  const clients = healthyGroupClients();
  clients.push(makeClient({ address: "0xfree", class: "foot", workspace: 10 }));
  const targets = engine.dissolveTargets(WHOLE_GROUP.concat(["0xfree"]), clients);
  assert.deepStrictEqual(targets, WHOLE_GROUP);
});

test("a claim naming a window that is not in the read is never dispatched at", () => {
  // The dead-address shape: the group array still names a window hyprctl no
  // longer lists. group.toggle on it is a VERB-ERROR, not a dissolve.
  const clients = healthyGroupClients().map((c) =>
    Object.assign(c, { grouped: WHOLE_GROUP.concat(["0xdeadbeef"]) })
  );
  const targets = engine.dissolveTargets(WHOLE_GROUP, clients);
  assert.deepStrictEqual(targets, WHOLE_GROUP);
  assert.ok(targets.indexOf("0xdeadbeef") === -1);
});

test("dissolveTargets never repeats an address and survives junk input", () => {
  const clients = splitBrainClients();
  const targets = engine.dissolveTargets(WHOLE_GROUP.concat(WHOLE_GROUP), clients);
  assert.deepStrictEqual(targets, WHOLE_GROUP);
  assert.deepStrictEqual(engine.dissolveTargets(null, clients), []);
  assert.deepStrictEqual(engine.dissolveTargets(WHOLE_GROUP, null), []);
  assert.deepStrictEqual(engine.dissolveTargets(WHOLE_GROUP, []), []);
});

test("split-brain does not change WHICH windows get dissolved versus a healthy read", () => {
  // The whole point: the rebuild behaves identically whether or not the
  // compositor's arrays agree with each other.
  assert.deepStrictEqual(
    engine.dissolveTargets(WHOLE_GROUP, splitBrainClients()),
    engine.dissolveTargets(WHOLE_GROUP, healthyGroupClients())
  );
  assert.deepStrictEqual(
    engine.dissolveTargets(WHOLE_GROUP, splitBrainInvertedClients()),
    engine.dissolveTargets(WHOLE_GROUP, healthyGroupClients())
  );
});

// --- recording a split-brain group ------------------------------------------
//
// The failure this prevents, observed on the live machine: the docked layout
// was re-recorded while the group read badly and came back with group: null on
// all four members. A group recorded as four ungrouped windows can never be
// restored — planRestore has no op that says "these belong together" if the
// record does not say so — and the desktop is left permanently drifted with a
// restore that plans zero ops. Amber badge, "Restore now" does nothing, for
// ever.

const RECORD_MONITORS = [{ id: 0, name: "eDP-1", description: "Laptop", focused: true }];

function recordedGroupIndexes(clients) {
  const layout = engine.buildLayout(clients, RECORD_MONITORS, IDENTITIES, AT);
  const out = {};
  for (const app of layout.apps) out[app.identityId] = app.group ? app.group.index : null;
  return out;
}

function onMonitorZero(clients) {
  return clients.map((c) => Object.assign({}, c, { monitor: 0 }));
}

test("a healthy group records every member at its tab index", () => {
  assert.deepStrictEqual(recordedGroupIndexes(onMonitorZero(healthyGroupClients())), {
    obsidian: 0,
    slack: 1,
    telegram: 2,
    whatsapp: 3
  });
});

test("split-brain: the under-reporting member is recorded IN the group, not as null", () => {
  // Before groupOrderFor, obsidian recorded as group: null here — and the
  // remaining three then described a group with a hole at index 0.
  assert.deepStrictEqual(recordedGroupIndexes(onMonitorZero(splitBrainClients())), {
    obsidian: 0,
    slack: 1,
    telegram: 2,
    whatsapp: 3
  });
});

test("split-brain inverted: members with empty arrays are recorded in the group", () => {
  assert.deepStrictEqual(recordedGroupIndexes(onMonitorZero(splitBrainInvertedClients())), {
    obsidian: 0,
    slack: 1,
    telegram: 2,
    whatsapp: 3
  });
});

test("a split-brain recording still satisfies the group invariant", () => {
  const layout = engine.buildLayout(onMonitorZero(splitBrainClients()), RECORD_MONITORS, IDENTITIES, AT);
  assertGroupInvariant(assert, layout, "split-brain record");
});

test("a split-brain group records identically to the healthy one", () => {
  const healthy = engine.buildLayout(onMonitorZero(healthyGroupClients()), RECORD_MONITORS, IDENTITIES, AT);
  const split = engine.buildLayout(onMonitorZero(splitBrainClients()), RECORD_MONITORS, IDENTITIES, AT);
  assert.deepStrictEqual(split, healthy);
});

test("a group that has genuinely been dissolved is still recorded as ungrouped", () => {
  // The limit of what claims can recover: when every window says it is alone
  // and nobody names anybody else, there is no group in the read to find, and
  // inventing one would record a group the user does not have.
  const allSolo = onMonitorZero(healthyGroupClients()).map((c) =>
    Object.assign({}, c, { grouped: [c.address] })
  );
  assert.deepStrictEqual(recordedGroupIndexes(allSolo), {
    obsidian: null,
    slack: null,
    telegram: null,
    whatsapp: null
  });
});

test("groupOrderFor believes a client that already describes a group", () => {
  const clients = splitBrainClients();
  // The three that agree keep their own array...
  assert.deepStrictEqual(engine.groupOrderFor(clients[1], clients), WHOLE_GROUP);
  // ...and the one that does not adopts theirs, because they name it.
  assert.deepStrictEqual(engine.groupOrderFor(clients[0], clients), WHOLE_GROUP);
});

test("groupOrderFor never adopts an array that does not name the client", () => {
  const other = ["0xp", "0xq"];
  const clients = [
    makeClient({ address: "0xlone", class: "foot", workspace: 3 }),
    makeClient({ address: "0xp", class: "code", workspace: 3, grouped: other }),
    makeClient({ address: "0xq", class: "chromium", workspace: 3, grouped: other })
  ];
  assert.deepStrictEqual(engine.groupOrderFor(clients[0], clients), []);
});

test("groupOrderFor is defensive about junk", () => {
  assert.deepStrictEqual(engine.groupOrderFor(null, []), []);
  assert.deepStrictEqual(engine.groupOrderFor(makeClient({ address: "0xa" }), null), []);
  assert.deepStrictEqual(engine.groupOrderFor({ address: "0xa", grouped: "nope" }, []), []);
});

test("the split-brain recording round-trips into a plan that rebuilds the group", () => {
  // End to end: record from a split-brain read, then plan against a desktop
  // whose tab order is wrong, and the group op must come out.
  const recordClients = onMonitorZero(splitBrainClients());
  const layout = engine.buildLayout(recordClients, RECORD_MONITORS, IDENTITIES, AT);

  const wrongOrder = [OBSIDIAN, TELEGRAM, SLACK, WHATSAPP];
  const liveClients = onMonitorZero(healthyGroupClients()).map((c) =>
    Object.assign({}, c, { grouped: wrongOrder })
  );

  const plan = engine.planRestore(liveClients, RECORD_MONITORS, layout, IDENTITIES);
  const groupOps = plan.filter((op) => op.kind === "group");
  assert.strictEqual(groupOps.length, 1, "the wrong tab order must plan a rebuild");
  assert.deepStrictEqual(groupOps[0].addresses, WHOLE_GROUP);
  assert.deepStrictEqual(engine.unknownPlanAddresses(plan, liveClients), []);
});

// --- the plan/snapshot address invariant ------------------------------------

test("planAddresses names every window a plan touches, and nothing else", () => {
  const plan = [
    { kind: "launch", identityId: "slack" },
    { kind: "workspace-monitor", workspaceId: 10, monitorName: "DP-2" },
    { kind: "move", address: "0xa", workspaceId: 10 },
    { kind: "group", addresses: ["0xa", "0xb"], missing: [] }
  ];
  assert.deepStrictEqual(engine.planAddresses(plan), ["0xa", "0xb"]);
  assert.deepStrictEqual(engine.planAddresses([]), []);
  assert.deepStrictEqual(engine.planAddresses(null), []);
  assert.deepStrictEqual(engine.planAddresses([null, {}]), []);
});

test("unknownPlanAddresses catches an op aimed at a window the snapshot lacks", () => {
  const clients = healthyGroupClients();
  const stale = [{ kind: "group", addresses: [OBSIDIAN, "0x55c6f73bd5e0"], missing: [] }];
  assert.deepStrictEqual(engine.unknownPlanAddresses(stale, clients), ["0x55c6f73bd5e0"]);
});

test("unknownPlanAddresses is empty for a plan built from the same snapshot", () => {
  const clients = healthyGroupClients();
  const fine = [
    { kind: "move", address: SLACK, workspaceId: 10 },
    { kind: "group", addresses: WHOLE_GROUP, missing: [] }
  ];
  assert.deepStrictEqual(engine.unknownPlanAddresses(fine, clients), []);
});

test("a plan against an empty snapshot is entirely unknown", () => {
  const plan = [{ kind: "move", address: "0xa", workspaceId: 1 }];
  assert.deepStrictEqual(engine.unknownPlanAddresses(plan, []), ["0xa"]);
  assert.deepStrictEqual(engine.unknownPlanAddresses(plan, null), ["0xa"]);
  assert.deepStrictEqual(engine.unknownPlanAddresses([], []), []);
});

// THE invariant, over the real fixtures: whatever planRestore emits, every
// address in it came from the client list it was handed.
test("planRestore never names an address absent from the snapshot it planned from", () => {
  const cases = [
    ["laptop layout, laptop desktop", clientsLaptop, monitorsLaptop, clientsLaptop, monitorsLaptop],
    ["laptop layout, docked desktop", clientsLaptop, monitorsLaptop, clientsDocked, monitorsDocked],
    ["docked layout, laptop desktop", clientsDocked, monitorsDocked, clientsLaptop, monitorsLaptop],
    ["docked layout, docked desktop", clientsDocked, monitorsDocked, clientsDocked, monitorsDocked]
  ];

  for (const [what, recClients, recMonitors, liveClients, liveMonitors] of cases) {
    const layout = engine.buildLayout(recClients, recMonitors, IDENTITIES, AT);
    const plan = engine.planRestore(liveClients, liveMonitors, layout, IDENTITIES);
    assert.deepStrictEqual(engine.unknownPlanAddresses(plan, liveClients), [], what);
  }
});

test("the invariant holds when the group is split-brain, which is when it matters", () => {
  const clients = splitBrainClients();
  const layout = engine.buildLayout(healthyGroupClients(), monitorsLaptop, IDENTITIES, AT);
  const plan = engine.planRestore(clients, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(engine.unknownPlanAddresses(plan, clients), []);
});

test("the invariant holds when windows are missing from the live desktop", () => {
  // The launch path: recorded apps with no window contribute launches, which
  // name an identity and no address at all.
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const plan = engine.planRestore([], monitorsLaptop, layout, IDENTITIES);
  assert.ok(plan.length > 0, "an empty desktop should plan launches");
  assert.deepStrictEqual(engine.planAddresses(plan), []);
  assert.deepStrictEqual(engine.unknownPlanAddresses(plan, []), []);
});
