// planRestore / driftOf / opToCommand — the restore side.
// Source of truth: the design sketch's "Restore verbs (Quattro Lua dispatch)"
// and the proven helpers in ~/.config/omarchy/scripts/session-layout.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const {
  loadFixture,
  IDENTITIES,
  makeClient,
  twoWindowGroupClients,
  duplicateWindowGroupClients,
  SLACK_CLASS,
  WHATSAPP_CLASS
} = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");
const monitorsDocked = loadFixture("monitors-laptop+headless.json");

const LAPTOP_DESC = "Samsung Display Corp. ATNA60HR07-0";
const AT = "2026-08-15T18:30:00Z";

const recorded = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);

function driftFor(report, id) {
  const entry = report.apps.find((a) => a.identityId === id);
  assert.ok(entry, "no drift entry for " + id);
  return entry;
}

function addressOf(clients, cls) {
  const found = clients.find((c) => c.class === cls);
  assert.ok(found, "no client with class " + cls);
  return found.address;
}

// --- idempotency ------------------------------------------------------------

test("a conforming desktop plans nothing", () => {
  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, recorded, IDENTITIES), []);
});

test("replanning after a plan would have run is still empty", () => {
  // Nothing changed, so the second look agrees with the first.
  const once = engine.planRestore(clientsLaptop, monitorsLaptop, recorded, IDENTITIES);
  const twice = engine.planRestore(clientsLaptop, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(once, twice);
  assert.deepStrictEqual(twice, []);
});

test("a conforming desktop reports no drift", () => {
  const report = engine.driftOf(clientsLaptop, monitorsLaptop, recorded, IDENTITIES);

  assert.strictEqual(report.topologyKey, LAPTOP_DESC);
  assert.strictEqual(report.layoutTopologyKey, LAPTOP_DESC);
  assert.strictEqual(report.topologyMatches, true);
  // One row per recorded WINDOW since schema v3 — two foot windows and two
  // Gmail windows make 12 rows out of 10 identities.
  assert.strictEqual(report.summary.ok, recorded.apps.length);
  assert.deepStrictEqual(report.summary, { ok: recorded.apps.length, drifted: 0, missing: 0, skipped: 0 });
  for (const app of report.apps) assert.strictEqual(app.status, "ok");
});

// --- drift ------------------------------------------------------------------

test("one window on the wrong workspace plans exactly one move", () => {
  const drifted = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { workspace: { id: 7, name: "7" } }) : c
  );

  const ops = engine.planRestore(drifted, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(ops, [
    {
      kind: "move",
      address: addressOf(clientsLaptop, "code"),
      workspaceId: 3,
      monitorDescription: LAPTOP_DESC
    }
  ]);
});

test("the drift report names what moved and how", () => {
  const drifted = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { workspace: { id: 7, name: "7" } }) : c
  );
  const report = engine.driftOf(drifted, monitorsLaptop, recorded, IDENTITIES);
  const editor = driftFor(report, "editor");

  assert.strictEqual(editor.status, "drifted");
  assert.deepStrictEqual(editor.drift, { monitor: false, workspace: true, group: false, floating: false, geometry: false });
  assert.strictEqual(editor.recorded.workspaceId, 3);
  assert.strictEqual(editor.current.workspaceId, 7);
  assert.strictEqual(editor.current.address, addressOf(clientsLaptop, "code"));
  assert.strictEqual(report.summary.drifted, 1);
  assert.strictEqual(report.summary.ok, recorded.apps.length - 1);
});

test("several drifted windows plan one move each, in layout order", () => {
  const drifted = clientsLaptop.map((c) => {
    if (c.class === "code") return Object.assign({}, c, { workspace: { id: 7, name: "7" } });
    if (c.class === "chromium") return Object.assign({}, c, { workspace: { id: 6, name: "6" } });
    return c;
  });

  const ops = engine.planRestore(drifted, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["move", "move"]);
  // "browser" comes before "editor" in the identity list, so its move comes first.
  assert.strictEqual(ops[0].address, addressOf(clientsLaptop, "chromium"));
  assert.strictEqual(ops[1].address, addressOf(clientsLaptop, "code"));
});

// --- launching --------------------------------------------------------------

test("a watched app that is not running plans a launch", () => {
  const withoutEditor = clientsLaptop.filter((c) => c.class !== "code");

  const ops = engine.planRestore(withoutEditor, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(ops, [{ kind: "launch", identityId: "editor" }]);

  const report = engine.driftOf(withoutEditor, monitorsLaptop, recorded, IDENTITIES);
  assert.strictEqual(driftFor(report, "editor").status, "missing");
  assert.strictEqual(driftFor(report, "editor").current, null);
  assert.strictEqual(report.summary.missing, 1);
});

test("launches come before moves", () => {
  const scattered = clientsLaptop
    .filter((c) => c.class !== "code")
    .map((c) => (c.class === "chromium" ? Object.assign({}, c, { workspace: { id: 6, name: "6" } }) : c));

  const ops = engine.planRestore(scattered, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["launch", "move"]);
  assert.strictEqual(ops[0].identityId, "editor");
});

test("a launched app gets its move on the next plan, not this one", () => {
  // The plan is re-run once the window appears — that is the whole strategy.
  const withoutEditor = clientsLaptop.filter((c) => c.class !== "code");
  const firstPass = engine.planRestore(withoutEditor, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(firstPass, [{ kind: "launch", identityId: "editor" }]);

  // It came up on the wrong workspace, as Quattro likes to do.
  const relaunched = withoutEditor.concat([
    makeClient({ address: "0xnew", class: "code", workspace: 1 })
  ]);
  const secondPass = engine.planRestore(relaunched, monitorsLaptop, recorded, IDENTITIES);
  assert.deepStrictEqual(secondPass, [
    { kind: "move", address: "0xnew", workspaceId: 3, monitorDescription: LAPTOP_DESC }
  ]);

  // Third pass, now conforming.
  const settled = withoutEditor.concat([makeClient({ address: "0xnew", class: "code", workspace: 3 })]);
  assert.deepStrictEqual(engine.planRestore(settled, monitorsLaptop, recorded, IDENTITIES), []);
});

// --- absent monitors --------------------------------------------------------

test("an app recorded on a monitor that is gone is skipped, and said so", () => {
  // Record with the headless output up, pretending the editor lived there.
  const dockedLayout = engine.buildLayout(clientsLaptop, monitorsDocked, IDENTITIES, AT);
  dockedLayout.apps = dockedLayout.apps.map((a) =>
    a.identityId === "editor" ? Object.assign({}, a, { monitorDescription: "hw-test", workspaceId: 4 }) : a
  );

  // Restore against the undocked desktop: hw-test does not exist.
  const ops = engine.planRestore(clientsLaptop, monitorsLaptop, dockedLayout, IDENTITIES);
  assert.deepStrictEqual(ops, [], "the missing monitor must not produce a move");

  const report = engine.driftOf(clientsLaptop, monitorsLaptop, dockedLayout, IDENTITIES);
  const editor = driftFor(report, "editor");
  assert.strictEqual(editor.status, "skipped");
  assert.strictEqual(editor.reason, "monitor-absent");
  assert.strictEqual(editor.recorded.monitorDescription, "hw-test");
  assert.strictEqual(editor.current.monitorDescription, LAPTOP_DESC, "the UI still shows where it is now");
  assert.strictEqual(report.summary.skipped, 1);
  assert.strictEqual(report.topologyMatches, false);
});

test("a LEGACY entry recorded on a special workspace is skipped, and never planned", () => {
  // buildLayout has refused to write this since tick pqv, so the only way it
  // exists is a file recorded before the filter. The number must not reach a
  // dispatch: the live probe (docs/thoughts/2026-08-17-special-ws-probe.md)
  // watched `workspace.move({ workspace = "-98" })` answer "ok" and drag a
  // USER workspace onto another monitor instead.
  const legacy = Object.assign({}, recorded, {
    apps: recorded.apps.map((a) =>
      a.identityId === "editor"
        ? Object.assign({}, a, { workspaceId: -98 })
        : a
    )
  });

  const report = engine.driftOf(clientsLaptop, monitorsLaptop, legacy, IDENTITIES);
  const editor = driftFor(report, "editor");
  assert.strictEqual(editor.status, "skipped");
  assert.strictEqual(editor.reason, "workspace-special");
  assert.strictEqual(editor.recorded.workspaceId, -98);
  // The UI still shows where the window actually is, exactly as monitor-absent
  // does — a skip is an explanation, not a blind spot.
  assert.strictEqual(editor.current.workspaceId, 3);
  // Skipped is excluded from the badge on purpose: no button can clear it.
  assert.strictEqual(report.summary.skipped, 1);

  const ops = engine.planRestore(clientsLaptop, monitorsLaptop, legacy, IDENTITIES);
  assert.ok(JSON.stringify(ops).indexOf("-98") === -1, "no op may carry a negative workspace id");
  assert.deepStrictEqual(
    ops.filter((op) => op.kind === "move" || op.kind === "workspace-monitor"),
    [],
    "a scratchpad recording plans no placement op at all"
  );
});

test("the special-workspace skip outranks monitor-absent — re-plugging would not help", () => {
  const legacy = Object.assign({}, recorded, {
    apps: recorded.apps.map((a) =>
      a.identityId === "editor"
        ? Object.assign({}, a, { workspaceId: -98, monitorDescription: "Gone Inc. X1" })
        : a
    )
  });
  const editor = driftFor(engine.driftOf(clientsLaptop, monitorsLaptop, legacy, IDENTITIES), "editor");
  assert.strictEqual(editor.reason, "workspace-special");
  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, legacy, IDENTITIES), []);
});

test("an app recorded without any monitor says so, instead of blaming the topology", () => {
  // buildLayout stores "" when the client's monitor index resolved to nothing.
  // Nothing was unplugged; there simply is no destination.
  const orphan = [makeClient({ address: "0xfff", class: "code", workspace: 3, monitor: 7 })];
  const layout = engine.buildLayout(orphan, monitorsLaptop, IDENTITIES, AT);
  assert.strictEqual(layout.apps.length, 1);
  assert.strictEqual(layout.apps[0].monitorDescription, "");

  const report = engine.driftOf(clientsLaptop, monitorsLaptop, layout, IDENTITIES);
  const editor = driftFor(report, "editor");
  assert.strictEqual(editor.status, "skipped");
  assert.strictEqual(editor.reason, "monitor-unknown", "monitor-absent would blame a cable that is fine");
  assert.strictEqual(editor.current.monitorDescription, LAPTOP_DESC, "the UI still shows where it is now");
  assert.strictEqual(report.summary.skipped, 1);

  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, layout, IDENTITIES), []);
});

test("an app whose identity is no longer watched is skipped", () => {
  const narrowed = IDENTITIES.filter((i) => i.id !== "editor");
  const report = engine.driftOf(clientsLaptop, monitorsLaptop, recorded, narrowed);

  assert.strictEqual(driftFor(report, "editor").status, "skipped");
  assert.strictEqual(driftFor(report, "editor").reason, "identity-unknown");
  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, recorded, narrowed), []);
});

// --- monitor drift ----------------------------------------------------------

// Apply a workspace-monitor op to a client list the way Hyprland would: every
// window on that workspace comes along, because the workspace is what moves.
function applyWorkspaceMonitor(clients, monitors, op) {
  const target = monitors.find((m) => (m.description || m.name) === op.monitorDescription);
  assert.ok(target, "the op names a monitor that is not in this topology");
  return clients.map((c) =>
    c.workspace.id === op.workspaceId ? Object.assign({}, c, { monitor: target.id }) : c
  );
}

test("a window on the right workspace but the wrong monitor moves the WORKSPACE", () => {
  // Docked, and workspace 3 — the editor's — has ended up on the headless
  // output instead of the laptop panel it was recorded on. The window is on the
  // workspace it belongs to, so moving the window can achieve nothing.
  const drifted = clientsLaptop.map((c) => (c.class === "code" ? Object.assign({}, c, { monitor: 1 }) : c));

  const report = engine.driftOf(drifted, monitorsDocked, recorded, IDENTITIES);
  assert.deepStrictEqual(driftFor(report, "editor").drift, { monitor: true, workspace: false, group: false, floating: false, geometry: false });

  const ops = engine.planRestore(drifted, monitorsDocked, recorded, IDENTITIES);
  assert.deepStrictEqual(ops, [
    {
      kind: "workspace-monitor",
      workspaceId: 3,
      monitorDescription: LAPTOP_DESC,
      monitorName: "eDP-1"
    },
    {
      kind: "move",
      address: addressOf(clientsLaptop, "code"),
      workspaceId: 3,
      monitorDescription: LAPTOP_DESC
    }
  ]);

  // Convergence: run the workspace move for real and the next plan is empty.
  // Without the workspace-monitor op the plan would repeat forever.
  const applied = applyWorkspaceMonitor(drifted, monitorsDocked, ops[0]);
  assert.deepStrictEqual(engine.planRestore(applied, monitorsDocked, recorded, IDENTITIES), []);
});

test("one workspace-monitor op covers every app recorded on that workspace", () => {
  // Both Gmail windows and the calendar sit on workspaces 9 and 8; drag the
  // whole lot onto the headless output and the plan must not repeat itself.
  const drifted = clientsLaptop.map((c) =>
    c.workspace.id === 8 || c.workspace.id === 9 ? Object.assign({}, c, { monitor: 1 }) : c
  );

  const ops = engine.planRestore(drifted, monitorsDocked, recorded, IDENTITIES);
  const workspaceOps = ops.filter((o) => o.kind === "workspace-monitor");

  // gmail(9), gcal(8) and rtm(8) drifted — but only two workspaces moved.
  assert.deepStrictEqual(workspaceOps.map((o) => o.workspaceId), [9, 8]);
  for (const op of workspaceOps) assert.strictEqual(op.monitorName, "eDP-1");

  let applied = drifted;
  for (const op of workspaceOps) applied = applyWorkspaceMonitor(applied, monitorsDocked, op);
  assert.deepStrictEqual(engine.planRestore(applied, monitorsDocked, recorded, IDENTITIES), []);
});

test("the workspace dedupe key still uses a NUL separator, byte for byte", () => {
  // The key that deduplicates workspace-monitor ops joins a workspace id and a
  // monitor description with a NUL. It used to be a LITERAL NUL byte in the
  // source, which made engine.js "binary" to grep — every plain search over the
  // file returned nothing, for every line in it. It is now written "\u0000".
  //
  // This test is the proof that the two spellings are the same string, so the
  // fix is a change to the SOURCE and not to the behaviour.
  assert.strictEqual("\u0000", String.fromCharCode(0));
  assert.strictEqual("9\u0000Laptop", "9" + String.fromCharCode(0) + "Laptop");
  // And the property the separator was chosen for: no pair of parts can be
  // re-cut into another pair, because neither part can contain a NUL.
  assert.notStrictEqual("1\u0000" + "2 Laptop", "1 2" + "\u0000Laptop");

  // The behaviour it guards, end to end: two apps recorded on the SAME
  // workspace produce one move, two apps on different workspaces produce two.
  const monitors = [
    { id: 0, name: "eDP-1", description: "Laptop", x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { id: 1, name: "DP-2", description: "Ultrawide", x: 1920, y: 0, width: 1920, height: 1080, scale: 1 }
  ];
  const recordedOnUltrawide = engine.buildLayout([
    makeClient({ address: "0xaaa", class: "foot", workspace: 4, monitor: 1 }),
    makeClient({ address: "0xbbb", class: "code", workspace: 4, monitor: 1 }),
    makeClient({ address: "0xccc", class: "chromium", workspace: 5, monitor: 1 })
  ], monitors, IDENTITIES, AT);

  const live = [
    makeClient({ address: "0xaaa", class: "foot", workspace: 4, monitor: 0 }),
    makeClient({ address: "0xbbb", class: "code", workspace: 4, monitor: 0 }),
    makeClient({ address: "0xccc", class: "chromium", workspace: 5, monitor: 0 })
  ];
  const workspaceOps = engine.planRestore(live, monitors, recordedOnUltrawide, IDENTITIES)
    .filter((o) => o.kind === "workspace-monitor");
  // Two ops, not three: the two apps sharing workspace 4 ask for the same move
  // and the dedupe key collapses them. (The ORDER is the recorded apps' order,
  // which is identity priority order, and is not what this test is about.)
  assert.deepStrictEqual(workspaceOps.map((o) => o.workspaceId).slice().sort(), [4, 5]);
});

test("workspace-monitor comes before the moves, which come before the groups", () => {
  const tabs = ["0xaaa", "0xbbb"];
  const asRecorded = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 2, monitor: 1, grouped: tabs }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 1, grouped: tabs }),
    makeClient({ address: "0xccc", class: "code", workspace: 3, monitor: 0 })
  ];
  const layout = engine.buildLayout(asRecorded, monitorsDocked, IDENTITIES, AT);

  // foot is on its recorded workspace but the wrong monitor; chromium is on the
  // wrong workspace AND ungrouped; the editor is not running at all.
  const live = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 5, monitor: 0 }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 2, monitor: 0 })
  ];

  const ops = engine.planRestore(live, monitorsDocked, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), [
    "launch",
    "workspace-monitor",
    "move",
    "move",
    "group"
  ]);
  assert.strictEqual(ops[0].identityId, "editor");
  assert.deepStrictEqual(ops[1], {
    kind: "workspace-monitor",
    workspaceId: 2,
    monitorDescription: "hw-test",
    monitorName: "hw-test"
  });
  assert.deepStrictEqual(ops[4], { kind: "group", addresses: ["0xaaa", "0xbbb"], missing: [] });
});

// --- groups -----------------------------------------------------------------

test("an intact group plans no group op", () => {
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  assert.deepStrictEqual(engine.planRestore(clients, monitorsLaptop, layout, IDENTITIES), []);
});

test("an ungrouped pair plans the moves first, then the group in tab order", () => {
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);

  // Both members ungrouped and scattered onto other workspaces.
  const scattered = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 5 }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 6 }),
    makeClient({ address: "0xccc", class: "code", workspace: 3 })
  ];

  const ops = engine.planRestore(scattered, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["move", "move", "group"]);

  // Moves carry the recorded destination.
  assert.deepStrictEqual(ops[0], {
    kind: "move",
    address: "0xbbb",
    workspaceId: 2,
    monitorDescription: LAPTOP_DESC
  });
  assert.deepStrictEqual(ops[1], {
    kind: "move",
    address: "0xaaa",
    workspaceId: 2,
    monitorDescription: LAPTOP_DESC
  });

  // The group op is last and lists addresses in RECORDED TAB ORDER
  // (foot, then chromium) — not the order the moves happened in.
  assert.deepStrictEqual(ops[2], { kind: "group", addresses: ["0xaaa", "0xbbb"], missing: [] });
});

// --- what a LOCKED session may execute (tick 97e) ----------------------------

test("planHasGroupJoins names the group join specifically, not every op that needs the keyboard", () => {
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const scattered = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 5 }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 6 }),
    makeClient({ address: "0xccc", class: "code", workspace: 3 })
  ];
  const plan = engine.planRestore(scattered, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(plan.map((o) => o.kind), ["move", "move", "group"]);
  assert.strictEqual(engine.planHasGroupJoins(plan), true);

  // Every other kind is focus-independent — each names its subject and the
  // compositor honours the selector (live-verified, engine's opToCommand block).
  // `ungroup` included: a dissolve is a whole-group toggle, not an into_group.
  for (const kind of ["move", "workspace-monitor", "ungroup", "floating", "geometry", "swap", "divider", "launch"]) {
    assert.strictEqual(engine.planHasGroupJoins([{ kind: kind }]), false, kind + " must not defer");
  }
  assert.strictEqual(engine.planHasGroupJoins([]), false);
  assert.strictEqual(engine.planHasGroupJoins(null), false);
  assert.strictEqual(engine.planHasGroupJoins([null]), false);
});

test("planWithoutGroupJoins keeps the order and leaves the original plan alone", () => {
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const scattered = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 5 }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 6 }),
    makeClient({ address: "0xccc", class: "code", workspace: 3 })
  ];
  const plan = engine.planRestore(scattered, monitorsLaptop, layout, IDENTITIES);

  const runnable = engine.planWithoutGroupJoins(plan);
  assert.deepStrictEqual(runnable.map((o) => o.kind), ["move", "move"]);
  // The ops themselves are the SAME objects — nothing is rebuilt, so nothing
  // can be rebuilt differently.
  assert.strictEqual(runnable[0], plan[0]);
  // …and the full plan is untouched: it is still what the no-progress check
  // compares against.
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(engine.planHasGroupJoins(runnable), false);

  // A plan of nothing but joins leaves nothing to run — the service ends the
  // pass there rather than dispatching zero ops and re-planning for ever.
  assert.deepStrictEqual(engine.planWithoutGroupJoins([{ kind: "group", addresses: [] }]), []);
  assert.deepStrictEqual(engine.planWithoutGroupJoins(null), []);
});

test("a group in the wrong tab order is regrouped without any move", () => {
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);

  const reversedTabs = ["0xbbb", "0xaaa"];
  const wrongOrder = clients.map((c) =>
    c.grouped.length ? Object.assign({}, c, { grouped: reversedTabs }) : c
  );

  const ops = engine.planRestore(wrongOrder, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops, [{ kind: "group", addresses: ["0xaaa", "0xbbb"], missing: [] }]);

  const report = engine.driftOf(wrongOrder, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(driftFor(report, "terminal").drift, { monitor: false, workspace: false, group: true, floating: false, geometry: false });
});

test("a group whose second member must be launched waits for the next pass", () => {
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const withoutFoot = clients.filter((c) => c.class !== "foot");

  const ops = engine.planRestore(withoutFoot, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["launch"], "one member cannot form a group");
  assert.strictEqual(ops[0].identityId, "terminal");
});

test("the real four-window group regroups in its recorded tab order", () => {
  const ungrouped = clientsLaptop.map((c) => Object.assign({}, c, { grouped: [] }));
  const ops = engine.planRestore(ungrouped, monitorsLaptop, recorded, IDENTITIES);

  assert.deepStrictEqual(ops.map((o) => o.kind), ["group"]);
  assert.deepStrictEqual(
    ops[0].addresses,
    ["md.obsidian.Obsidian", "org.telegram.desktop", "chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1", "chrome-web.whatsapp.com__-Profile_1"].map(
      (cls) => addressOf(clientsLaptop, cls)
    )
  );
});

test("a group is not rebuilt just because an unwatched window joined it", () => {
  // Extra members that nobody watches do not disturb the recorded order.
  const clients = twoWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);

  const tabs = ["0xaaa", "0xbbb", "0xddd"];
  const withStranger = clients
    .map((c) => (c.grouped.length ? Object.assign({}, c, { grouped: tabs }) : c))
    .concat([makeClient({ address: "0xddd", class: "org.gnome.Nautilus", workspace: 2, grouped: tabs })]);

  assert.deepStrictEqual(engine.planRestore(withStranger, monitorsLaptop, layout, IDENTITIES), []);
});

// --- partial groups and order drift (user gate finding 4) --------------------

// The three-messenger group from the user's desktop, in the shape the record
// now takes: telegram(0), slack(1), whatsapp(2) tabbed together on ws 10.
function messengerLayout() {
  // Recorded off the GROUPED windows only. The fixture also carries a second,
  // lone Slack window, and since schema v3 that window earns a recorded
  // occurrence of its own — a fact these tests are not about (the duplicate
  // section owns it) and which would otherwise put a permanent launch intent
  // into every plan below.
  const grouped = duplicateWindowGroupClients().filter((c) => c.address !== "0xslackalone");
  return engine.buildLayout(grouped, monitorsLaptop, IDENTITIES, AT);
}

// The same three windows, ungrouped and scattered — plus whichever members the
// caller wants left out entirely.
function scatteredMessengers(without) {
  const drop = without || [];
  const all = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 3 }),
    makeClient({ address: "0xslackgrouped", class: SLACK_CLASS, workspace: 4 }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 5 })
  ];
  return all.filter((c) => drop.indexOf(c.address) === -1);
}

test("a group whose members are all here is rebuilt in recorded order", () => {
  const layout = messengerLayout();
  const ops = engine.planRestore(scatteredMessengers(), monitorsLaptop, layout, IDENTITIES);
  const groups = ops.filter((o) => o.kind === "group");

  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0], {
    kind: "group",
    addresses: ["0xtele", "0xslackgrouped", "0xwhats"],
    missing: []
  });
});

test("a group missing one member groups the two that are here, and names the absentee", () => {
  // The user's live shape: three recorded members, one app closed. A partial
  // group is better than none — before this, the whole group op vanished and
  // every cycle logged "0 grouped".
  const layout = messengerLayout();
  const withoutSlack = scatteredMessengers(["0xslackgrouped"]);

  const ops = engine.planRestore(withoutSlack, monitorsLaptop, layout, IDENTITIES);
  const groups = ops.filter((o) => o.kind === "group");

  assert.strictEqual(groups.length, 1, "two present members are still a group");
  assert.deepStrictEqual(groups[0], {
    kind: "group",
    addresses: ["0xtele", "0xwhats"],
    missing: ["slack"]
  });
  // And the plan says so out loud, since the service logs describeOp.
  assert.strictEqual(engine.describeOp(groups[0]), "group 0xtele+0xwhats (without slack)");

  // The absentee is still planned for: a launch comes first, and the group op
  // is built from whoever is actually on screen this pass.
  assert.deepStrictEqual(ops.map((o) => o.kind), ["launch", "move", "move", "group"]);
  assert.strictEqual(ops[0].identityId, "slack");
});

test("a partial group CONVERGES once its present members are tabbed together", () => {
  // The other half of the old bug: a group that can never satisfy its record
  // would re-plan forever. Membership is judged against the members that are
  // here, so two of three in recorded order is a finished job.
  const layout = messengerLayout();
  const tabs = ["0xtele", "0xwhats"];
  const rebuilt = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10, grouped: tabs })
  ];

  const report = engine.driftOf(rebuilt, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(report.groups, [
    {
      groupId: "group:telegram+slack+whatsapp",
      identityIds: ["telegram", "whatsapp"],
      memberKeys: ["telegram", "whatsapp"],
      addresses: ["0xtele", "0xwhats"],
      missing: ["slack"],
      needed: false
    }
  ]);
  assert.strictEqual(driftFor(report, "telegram").drift.group, false);
  assert.strictEqual(driftFor(report, "whatsapp").drift.group, false);

  // Slack is still missing, so the plan is the launch and nothing else — no
  // group op, because the group it would build is the one already standing.
  assert.deepStrictEqual(
    engine.planRestore(rebuilt, monitorsLaptop, layout, IDENTITIES),
    [{ kind: "launch", identityId: "slack" }]
  );
});

test("the present members in the WRONG order is drift, and plans a rebuild", () => {
  const layout = messengerLayout();
  // All three grouped on the right workspace — but slack and whatsapp swapped.
  const tabs = ["0xtele", "0xwhats", "0xslackgrouped"];
  const wrongOrder = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xslackgrouped", class: SLACK_CLASS, workspace: 10, grouped: tabs }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10, grouped: tabs })
  ];

  const report = engine.driftOf(wrongOrder, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.groups[0].needed, true, "wrong tab order is drift");
  for (const id of ["telegram", "slack", "whatsapp"]) {
    assert.strictEqual(driftFor(report, id).drift.group, true, id + " should report group drift");
    assert.strictEqual(driftFor(report, id).status, "drifted");
  }

  assert.deepStrictEqual(engine.planRestore(wrongOrder, monitorsLaptop, layout, IDENTITIES), [
    { kind: "group", addresses: ["0xtele", "0xslackgrouped", "0xwhats"], missing: [] }
  ]);

  // Put them in the recorded order and the plan is empty — membership AND order
  // are what "converged" means.
  const right = wrongOrder.map((c) =>
    Object.assign({}, c, { grouped: ["0xtele", "0xslackgrouped", "0xwhats"] })
  );
  assert.deepStrictEqual(engine.planRestore(right, monitorsLaptop, layout, IDENTITIES), []);
});

test("an extra WATCHED app tabbed into the group is drift; an unwatched one is not", () => {
  const layout = messengerLayout();
  const tabs = ["0xtele", "0xslackgrouped", "0xwhats", "0xcode"];
  const gatecrashed = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xslackgrouped", class: SLACK_CLASS, workspace: 10, grouped: tabs }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10, grouped: tabs }),
    makeClient({ address: "0xcode", class: "code", workspace: 10, grouped: tabs })
  ];

  const ops = engine.planRestore(gatecrashed, monitorsLaptop, layout, IDENTITIES);
  const groups = ops.filter((o) => o.kind === "group");
  assert.strictEqual(groups.length, 1, "a watched app in the group that the record does not name is drift");
  assert.deepStrictEqual(groups[0].addresses, ["0xtele", "0xslackgrouped", "0xwhats"]);
});

test("record and restore agree on WHICH window of a duplicated identity they mean", () => {
  // The question the old "chosen window" tie-break existed to answer. Schema v3
  // answers it by not asking: BOTH Slack windows are recorded, each at its own
  // occurrence, so there is no window left over for a restore to drag around by
  // mistake.
  const clients = duplicateWindowGroupClients();
  const layout = engine.buildLayout(clients, monitorsLaptop, IDENTITIES, AT);
  const report = engine.driftOf(clients, monitorsLaptop, layout, IDENTITIES);

  const slacks = report.apps.filter((a) => a.identityId === "slack");
  assert.deepStrictEqual(slacks.map((a) => a.occurrence), [0, 1]);
  assert.strictEqual(slacks[0].current.address, "0xslackalone", "ws 9 sorts before ws 10");
  assert.strictEqual(slacks[1].current.address, "0xslackgrouped");
  for (const entry of slacks) {
    assert.strictEqual(entry.status, "ok", "the desktop it was recorded from cannot have drifted");
  }
  assert.deepStrictEqual(engine.planRestore(clients, monitorsLaptop, layout, IDENTITIES), []);

  // Move the lone window and it is the LONE window's row that drifts. Before
  // v3 this window had no entry at all and the nudge was invisible.
  const nudged = clients.map((c) =>
    c.address === "0xslackalone" ? Object.assign({}, c, { workspace: { id: 6, name: "6" } }) : c
  );
  assert.deepStrictEqual(engine.planRestore(nudged, monitorsLaptop, layout, IDENTITIES), [
    { kind: "move", address: "0xslackalone", workspaceId: 9, monitorDescription: LAPTOP_DESC }
  ]);
});

test("a group recorded with an index hole plans what it can, and never loops", () => {
  // The literal record from the user's state file, corrupt as it was written:
  // three names in the groupId, indexes 0 and 2, and slack's own entry
  // ungrouped on another workspace. New code cannot RECORD this, but it is on
  // the user's disk, so it has to be survivable.
  const corrupt = {
    topologyKey: LAPTOP_DESC,
    recordedAt: AT,
    apps: [
      {
        identityId: "whatsapp", monitorDescription: LAPTOP_DESC, workspaceId: 10, floating: false,
        group: { groupId: "group:telegram+slack+whatsapp", index: 2 }
      },
      {
        identityId: "telegram", monitorDescription: LAPTOP_DESC, workspaceId: 10, floating: false,
        group: { groupId: "group:telegram+slack+whatsapp", index: 0 }
      },
      {
        identityId: "slack", monitorDescription: LAPTOP_DESC, workspaceId: 9, floating: false, group: null
      }
    ]
  };

  const scattered = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 3 }),
    makeClient({ address: "0xslackgrouped", class: SLACK_CLASS, workspace: 4 }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 5 })
  ];

  const ops = engine.planRestore(scattered, monitorsLaptop, corrupt, IDENTITIES);
  const groups = ops.filter((o) => o.kind === "group");
  // The two members the record actually placed in the group, in their recorded
  // order. The third is a member in name only — the record puts it on ws 9,
  // ungrouped, and that is what gets restored.
  assert.deepStrictEqual(groups, [
    { kind: "group", addresses: ["0xtele", "0xwhats"], missing: [] }
  ]);

  // And it converges: apply the plan and the next one is empty.
  const applied = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: ["0xtele", "0xwhats"] }),
    makeClient({ address: "0xslackgrouped", class: SLACK_CLASS, workspace: 9 }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10, grouped: ["0xtele", "0xwhats"] })
  ];
  assert.deepStrictEqual(engine.planRestore(applied, monitorsLaptop, corrupt, IDENTITIES), []);
});

test("the drift report carries one group entry per recorded group", () => {
  const layout = messengerLayout();
  const report = engine.driftOf(scatteredMessengers(), monitorsLaptop, layout, IDENTITIES);

  assert.deepStrictEqual(report.groups, [
    {
      groupId: "group:telegram+slack+whatsapp",
      identityIds: ["telegram", "slack", "whatsapp"],
      memberKeys: ["telegram", "slack", "whatsapp"],
      addresses: ["0xtele", "0xslackgrouped", "0xwhats"],
      missing: [],
      needed: true
    }
  ]);

  // A layout with no groups has no group entries, and neither does no layout.
  assert.deepStrictEqual(engine.driftOf(clientsLaptop, monitorsLaptop, null, IDENTITIES).groups, []);
});

test("a group left with one present member asks for nothing and reports no drift", () => {
  // One window is not a tab group. Reporting drift here would be a badge the
  // user cannot clear by any action.
  const layout = messengerLayout();
  const alone = [makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10 })];

  const report = engine.driftOf(alone, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(driftFor(report, "telegram").drift.group, false);
  assert.strictEqual(driftFor(report, "telegram").status, "ok");
  assert.deepStrictEqual(report.groups[0].identityIds, ["telegram"]);
  assert.deepStrictEqual(report.groups[0].missing, ["slack", "whatsapp"]);
  assert.strictEqual(report.groups[0].needed, false);

  const groups = engine.planRestore(alone, monitorsLaptop, layout, IDENTITIES).filter((o) => o.kind === "group");
  assert.deepStrictEqual(groups, []);
});

// --- ungroup: recorded ungrouped, live grouped (tick 8t4, user live finding) --
//
// The state this op was born from, byte for byte off the user's machine: the
// docked recording carries group:null for all four ws-10 apps, while the live
// desktop has them tabbed into one four-window group. driftOf called that
// drifted (correctly), but planRestore had no op to say "take that group
// apart" — an amber badge that "Restore now" could never clear.

function ungroupLayout() {
  // Four watched apps recorded UNGROUPED on ws 10.
  const recordClients = [
    makeClient({ address: "0xobs", class: "md.obsidian.Obsidian", workspace: 10 }),
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10 }),
    makeClient({ address: "0xslack", class: SLACK_CLASS, workspace: 10 }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10 })
  ];
  return engine.buildLayout(recordClients, monitorsLaptop, IDENTITIES, AT);
}

function liveGroupedAnyway() {
  const tabs = ["0xobs", "0xtele", "0xslack", "0xwhats"];
  return [
    makeClient({ address: "0xobs", class: "md.obsidian.Obsidian", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: tabs }),
    makeClient({ address: "0xslack", class: SLACK_CLASS, workspace: 10, grouped: tabs }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 10, grouped: tabs })
  ];
}

test("recording says ungrouped, live is grouped: the plan dissolves the group", () => {
  const layout = ungroupLayout();
  for (const app of layout.apps) assert.strictEqual(app.group, null, "the recording must say ungrouped");

  const live = liveGroupedAnyway();
  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  for (const id of ["obsidian", "telegram", "slack", "whatsapp"]) {
    assert.strictEqual(driftFor(report, id).drift.group, true, id);
    assert.strictEqual(driftFor(report, id).status, "drifted", id);
  }

  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  // ONE op for the one live group, members in live tab order — placements are
  // right, so there is nothing else to do.
  assert.deepStrictEqual(ops, [
    { kind: "ungroup", addresses: ["0xobs", "0xtele", "0xslack", "0xwhats"] }
  ]);
  assert.strictEqual(engine.describeOp(ops[0]), "ungroup 0xobs+0xtele+0xslack+0xwhats");
  assert.deepStrictEqual(engine.planAddresses(ops), ["0xobs", "0xtele", "0xslack", "0xwhats"]);
  assert.deepStrictEqual(engine.unknownPlanAddresses(ops, live), []);
});

test("the ungroup converges: once the group is dissolved the plan is empty", () => {
  const layout = ungroupLayout();
  const dissolved = liveGroupedAnyway().map((c) => Object.assign({}, c, { grouped: [] }));
  assert.deepStrictEqual(engine.planRestore(dissolved, monitorsLaptop, layout, IDENTITIES), []);
  const report = engine.driftOf(dissolved, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.summary.drifted, 0);
});

test("a group of purely-unwatched windows around a watched one is left alone", () => {
  // The rule's other half: the tool tears down groups of things it MANAGES,
  // never groups the user made out of things it does not.
  const layout = engine.buildLayout(
    [makeClient({ address: "0xcode", class: "code", workspace: 3 })],
    monitorsLaptop, IDENTITIES, AT);

  const tabs = ["0xcode", "0xnautilus"];
  const live = [
    makeClient({ address: "0xcode", class: "code", workspace: 3, grouped: tabs }),
    makeClient({ address: "0xnautilus", class: "org.gnome.Nautilus", workspace: 3, grouped: tabs })
  ];
  assert.deepStrictEqual(engine.planRestore(live, monitorsLaptop, layout, IDENTITIES), []);
  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(driftFor(report, "editor").drift.group, false);
});

test("two separate stray groups plan two ungroup ops", () => {
  const recordClients = [
    makeClient({ address: "0xa", class: "foot", workspace: 1 }),
    makeClient({ address: "0xb", class: "chromium", workspace: 1 }),
    makeClient({ address: "0xc", class: "code", workspace: 2 }),
    makeClient({ address: "0xd", class: "org.telegram.desktop", workspace: 2 })
  ];
  const layout = engine.buildLayout(recordClients, monitorsLaptop, IDENTITIES, AT);

  const g1 = ["0xa", "0xb"];
  const g2 = ["0xc", "0xd"];
  const live = [
    makeClient({ address: "0xa", class: "foot", workspace: 1, grouped: g1 }),
    makeClient({ address: "0xb", class: "chromium", workspace: 1, grouped: g1 }),
    makeClient({ address: "0xc", class: "code", workspace: 2, grouped: g2 }),
    makeClient({ address: "0xd", class: "org.telegram.desktop", workspace: 2, grouped: g2 })
  ];

  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["ungroup", "ungroup"]);
  const address_sets = ops.map((o) => o.addresses.slice().sort().join("+")).sort();
  assert.deepStrictEqual(address_sets, ["0xa+0xb", "0xc+0xd"]);
});

test("ungroups come before moves — a move on a grouped window drags the whole group", () => {
  // Recorded: foot ungrouped on ws 5, chromium ungrouped on ws 1. Live: both
  // tabbed together on ws 1. The dissolve must run before foot's move, or the
  // move would take chromium along to ws 5.
  const recordClients = [
    makeClient({ address: "0xa", class: "foot", workspace: 5 }),
    makeClient({ address: "0xb", class: "chromium", workspace: 1 })
  ];
  const layout = engine.buildLayout(recordClients, monitorsLaptop, IDENTITIES, AT);

  const tabs = ["0xa", "0xb"];
  const live = [
    makeClient({ address: "0xa", class: "foot", workspace: 1, grouped: tabs }),
    makeClient({ address: "0xb", class: "chromium", workspace: 1, grouped: tabs })
  ];

  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["ungroup", "move"]);
  assert.deepStrictEqual(ops[0].addresses.slice().sort(), ["0xa", "0xb"]);
  assert.strictEqual(ops[1].address, "0xa");
});

test("a stray group and a recorded group coexist: ungroup the stray, rebuild the recorded", () => {
  // Recorded: telegram+slack a group on ws 10; whatsapp ungrouped on ws 9.
  // Live: all THREE tabbed together on ws 10.
  const recordClients = [
    makeClient({ address: "0xtele", class: "org.telegram.desktop", workspace: 10, grouped: ["0xtele", "0xslack"] }),
    makeClient({ address: "0xslack", class: SLACK_CLASS, workspace: 10, grouped: ["0xtele", "0xslack"] }),
    makeClient({ address: "0xwhats", class: WHATSAPP_CLASS, workspace: 9 })
  ];
  const layout = engine.buildLayout(recordClients, monitorsLaptop, IDENTITIES, AT);

  const tabs = ["0xtele", "0xslack", "0xwhats"];
  const live = recordClients.map((c) =>
    Object.assign({}, c, { workspace: { id: 10, name: "10" }, grouped: tabs }));

  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["ungroup", "move", "group"]);
  // The stray op names only the window whose RECORDING is ungrouped.
  assert.deepStrictEqual(ops[0].addresses, ["0xwhats"]);
  assert.strictEqual(ops[1].address, "0xwhats");
  assert.deepStrictEqual(ops[2].addresses, ["0xtele", "0xslack"]);
});

test("an ungroup op maps to no static commands — the service owns the dissolve", () => {
  assert.deepStrictEqual(engine.opToCommand({ kind: "ungroup", addresses: ["0xa", "0xb"] }), []);
});

// --- floating (tick 8t4) ------------------------------------------------------
//
// Restorable since the live verification of hl.dsp.window.float: the verb is
// address-targeted and focus-independent, but it TOGGLES whatever `action`
// says, so the op carries the recorded value and the service gates the toggle
// on a fresh read. See the evidence block in engine.js opToCommand.

test("a window recorded floating but live tiled plans a floating op, and back", () => {
  const floatedRecord = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { floating: true }) : c);
  const layout = engine.buildLayout(floatedRecord, monitorsLaptop, IDENTITIES, AT);

  // Live: tiled again.
  const report = engine.driftOf(clientsLaptop, monitorsLaptop, layout, IDENTITIES);
  const editor = driftFor(report, "editor");
  assert.strictEqual(editor.status, "drifted");
  assert.deepStrictEqual(editor.drift, { monitor: false, workspace: false, group: false, floating: true, geometry: false });
  assert.strictEqual(editor.recorded.floating, true);
  assert.strictEqual(editor.current.floating, false);

  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, layout, IDENTITIES), [
    { kind: "floating", address: addressOf(clientsLaptop, "code"), value: true }
  ]);

  // The mirror image: recorded tiled, live floating.
  const tiledLayout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  const liveFloated = clientsLaptop.map((c) =>
    c.class === "code" ? Object.assign({}, c, { floating: true }) : c);
  assert.deepStrictEqual(engine.planRestore(liveFloated, monitorsLaptop, tiledLayout, IDENTITIES), [
    { kind: "floating", address: addressOf(clientsLaptop, "code"), value: false }
  ]);

  // And it converges: a desktop matching the record plans nothing.
  assert.deepStrictEqual(engine.planRestore(floatedRecord, monitorsLaptop, layout, IDENTITIES), []);
});

test("the floating op is one targeted toggle, and the signature says the direction", () => {
  const op = { kind: "floating", address: "0xaaa", value: true };
  assert.deepStrictEqual(engine.opToCommand(op), [
    "hyprctl dispatch 'hl.dsp.window.float({ window = \"address:0xaaa\", action = \"toggle\" })'"
  ]);
  assert.strictEqual(engine.describeOp(op), "float 0xaaa");
  assert.strictEqual(engine.describeOp({ kind: "floating", address: "0xaaa", value: false }), "tile 0xaaa");
  // Direction is part of the signature: float->tile and tile->float on the
  // same window are different plans, or the no-progress check goes blind.
  assert.notStrictEqual(
    engine.opSignature(op),
    engine.opSignature({ kind: "floating", address: "0xaaa", value: false }));
  assert.deepStrictEqual(engine.planAddresses([op]), ["0xaaa"]);
});

test("floating ops run after the moves and before the groups", () => {
  // Recorded: foot floating on ws 2, chromium+code a group on ws 2. Live: foot
  // tiled on ws 5, the group scattered and ungrouped.
  const recordClients = [
    makeClient({ address: "0xfoot", class: "foot", workspace: 2, floating: true }),
    makeClient({ address: "0xchrom", class: "chromium", workspace: 2, grouped: ["0xchrom", "0xcode"] }),
    makeClient({ address: "0xcode", class: "code", workspace: 2, grouped: ["0xchrom", "0xcode"] })
  ];
  const layout = engine.buildLayout(recordClients, monitorsLaptop, IDENTITIES, AT);

  const live = [
    makeClient({ address: "0xfoot", class: "foot", workspace: 5 }),
    makeClient({ address: "0xchrom", class: "chromium", workspace: 4 }),
    makeClient({ address: "0xcode", class: "code", workspace: 3 })
  ];
  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["move", "move", "move", "floating", "group"]);
});

test("a skipped app never plans a floating op", () => {
  // Recorded floating on a monitor that is gone: skipped is skipped.
  const layout = engine.buildLayout(
    [makeClient({ address: "0xfoot", class: "foot", workspace: 2, floating: true })],
    monitorsDocked, IDENTITIES, AT);
  layout.apps[0].monitorDescription = "hw-test";

  const live = [makeClient({ address: "0xfoot", class: "foot", workspace: 2 })];
  assert.deepStrictEqual(engine.planRestore(live, monitorsLaptop, layout, IDENTITIES), []);
});

// --- floating geometry (tick qkv) ---------------------------------------------
//
// The op that puts a float back on its recorded pixels. Two dispatches, resize
// then move, both naming the window — the ordering and the absolute-vs-delta
// spelling are live-proven in tick y29 (see the FLOAT ACTUATOR SEMANTICS block
// in engine.js). The precondition that keeps it safe is enforced HERE, in the
// planner: a recorded FLOAT, both rects known, outside the ±2px band. Aimed at
// a tiled window the resize half silently rearranges the dwindle split and
// still answers "ok", so this is the only place that mistake can be caught.

// A one-app desktop whose single float can be placed exactly, so a geometry
// assertion is about geometry and not about which window matched.
function floatAt(at, size) {
  return [makeClient({
    address: "0xfoot", class: "foot", workspace: 2, monitor: 0,
    floating: true, at: at, size: size
  })];
}

const RECORDED_AT = [400, 300];
const RECORDED_SIZE = [800, 600];

function geometryLayout() {
  return engine.buildLayout(floatAt(RECORDED_AT, RECORDED_SIZE), monitorsLaptop, IDENTITIES, AT);
}

test("a float off by 3 px plans a geometry op; off by 2 does not", () => {
  const layout = geometryLayout();

  // ±2 is the band, and the band is INCLUSIVE — GEOMETRY_TOLERANCE_PX px of
  // rounding noise on a fractional-scale output is not a user's intent.
  for (const at of [[402, 300], [400, 302], [398, 300], [400, 298]]) {
    assert.deepStrictEqual(
      engine.planRestore(floatAt(at, RECORDED_SIZE), monitorsLaptop, layout, IDENTITIES), [],
      "at " + at + " is inside the band and must plan nothing");
  }
  for (const size of [[802, 600], [800, 602], [798, 600], [800, 598]]) {
    assert.deepStrictEqual(
      engine.planRestore(floatAt(RECORDED_AT, size), monitorsLaptop, layout, IDENTITIES), [],
      "size " + size + " is inside the band and must plan nothing");
  }

  // One pixel further out on ANY of the four axes, and the op appears. Per
  // axis, not as a distance: an axis a window is 3 px wrong on is 3 px wrong
  // whatever the other axis did.
  for (const [at, size] of [
    [[403, 300], RECORDED_SIZE],
    [[400, 303], RECORDED_SIZE],
    [RECORDED_AT, [803, 600]],
    [RECORDED_AT, [800, 603]]
  ]) {
    assert.deepStrictEqual(
      engine.planRestore(floatAt(at, size), monitorsLaptop, layout, IDENTITIES),
      [{ kind: "geometry", address: "0xfoot", at: RECORDED_AT, size: RECORDED_SIZE }],
      "at " + at + " size " + size + " is outside the band and must plan the op");
  }
});

test("the geometry op carries the RECORDED rect, not the live one", () => {
  const plan = engine.planRestore(
    floatAt([1200, 900], [300, 200]), monitorsLaptop, geometryLayout(), IDENTITIES);
  assert.strictEqual(plan.length, 1);
  // A destination, never a delta — which is what makes the dispatch idempotent
  // and what makes an unconverged re-plan produce the identical signature the
  // no-progress check has to be able to see.
  assert.deepStrictEqual(plan[0].at, RECORDED_AT);
  assert.deepStrictEqual(plan[0].size, RECORDED_SIZE);
  assert.notStrictEqual(plan[0].at, geometryLayout().apps[0].at, "and it is a copy");
});

test("null recorded geometry never plans, however far the live window is", () => {
  // Any pre-v2 recording carries null on every entry, permanently and legally.
  // "We never knew where it was" can never become "put it back".
  for (const nulls of [{ at: null }, { size: null }, { at: null, size: null }]) {
    const layout = geometryLayout();
    Object.assign(layout.apps[0], nulls);
    assert.deepStrictEqual(
      engine.planRestore(floatAt([1200, 900], [300, 200]), monitorsLaptop, layout, IDENTITIES), [],
      JSON.stringify(nulls) + " must plan nothing");
  }
});

test("a TILED record never plans a geometry op, however far its rect moved", () => {
  const recorded = [makeClient({
    address: "0xfoot", class: "foot", workspace: 2, monitor: 0,
    floating: false, at: RECORDED_AT, size: RECORDED_SIZE
  })];
  const live = [makeClient({
    address: "0xfoot", class: "foot", workspace: 2, monitor: 0,
    floating: false, at: [1200, 900], size: [300, 200]
  })];
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  assert.deepStrictEqual(engine.planRestore(live, monitorsLaptop, layout, IDENTITIES), []);
});

test("a skipped app never plans a geometry op", () => {
  const layout = geometryLayout();
  layout.apps[0].monitorDescription = "hw-test";
  assert.deepStrictEqual(
    engine.planRestore(floatAt([1200, 900], [300, 200]), monitorsLaptop, layout, IDENTITIES), []);
});

test("a float that is BOTH tiled and misplaced plans the toggle, then the pixels", () => {
  // The float op assigns a fresh compositor-chosen rect, so pixels placed
  // before it would be placed twice (tick y29). Order is the assertion.
  const layout = geometryLayout();
  const live = [makeClient({
    address: "0xfoot", class: "foot", workspace: 7, monitor: 0,
    floating: false, at: [1200, 900], size: [300, 200]
  })];
  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["move", "floating", "geometry"]);
});

test("geometry runs LAST, after the groups", () => {
  // A workspace move re-clamps a float against the new workspace's reserved
  // area (live-measured, tick y29), so geometry cannot precede the moves; and
  // it sits after the groups too, because "last" is a rule that needs no
  // per-op reasoning to stay true.
  const recordClients = [
    makeClient({ address: "0xfoot", class: "foot", workspace: 2, monitor: 0,
      floating: true, at: RECORDED_AT, size: RECORDED_SIZE }),
    makeClient({ address: "0xchrom", class: "chromium", workspace: 2, grouped: ["0xchrom", "0xcode"] }),
    makeClient({ address: "0xcode", class: "code", workspace: 2, grouped: ["0xchrom", "0xcode"] })
  ];
  const layout = engine.buildLayout(recordClients, monitorsLaptop, IDENTITIES, AT);
  const live = [
    makeClient({ address: "0xfoot", class: "foot", workspace: 2, monitor: 0,
      floating: true, at: [1200, 900], size: [300, 200] }),
    makeClient({ address: "0xchrom", class: "chromium", workspace: 4 }),
    makeClient({ address: "0xcode", class: "code", workspace: 3 })
  ];
  const ops = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.deepStrictEqual(ops.map((o) => o.kind), ["move", "move", "group", "geometry"]);
});

test("the geometry restore converges, and a converged float plans nothing", () => {
  const layout = geometryLayout();
  const plan = engine.planRestore(
    floatAt([1200, 900], [300, 200]), monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(plan.length, 1);

  // Apply what the dispatches would do, in the order opToCommand emits them:
  // resize to `size`, then move to `at`. Both absolute, both exact on live
  // hardware (tick y29 row 15), so the result is the recorded rect exactly.
  const after = floatAt(plan[0].at, plan[0].size);
  assert.deepStrictEqual(engine.planRestore(after, monitorsLaptop, layout, IDENTITIES), []);

  const report = engine.driftOf(after, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.apps[0].geometry.verdict, "ok");
  assert.strictEqual(report.apps[0].drift.geometry, false);
  assert.strictEqual(engine.verdictsFor(report, [])[0].ok, true);
});

test("a REFUSED geometry op names the app whose row it blocked", () => {
  // The executor refuses a geometry op whose window reads TILED at execution
  // time, because a resize aimed at a tiled window moves the dwindle split and
  // still answers "ok". A refusal is only worth making if it reaches the user,
  // and the only route it has is the ledger: engine.blockedByIndex folds a
  // failed outcome into a verdict THROUGH `identityIds`, which the service
  // resolves from the op's window address.
  //
  // Which is the whole point of this test. A geometry op carries `address`,
  // singular, exactly like `move` and `floating`, and Service.beginOp did not
  // know it: the op fell through to the `addresses` branch, resolved to an
  // EMPTY identity list, and a loudly-refused geometry op left the row saying
  // nothing at all. Caught in tick qkv by reading this path rather than the op;
  // the list of kinds that made it possible was deleted in tick ae1 (see "a
  // future op kind…" below), so this test now guards the outcome rather than
  // the branch.
  const layout = geometryLayout();
  const live = floatAt([1200, 900], [300, 200]);
  const plan = engine.planRestore(live, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(plan[0].kind, "geometry");
  assert.deepStrictEqual(engine.planAddresses(plan), [plan[0].address],
    "one address, and it is on `address` and not `addresses`");

  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  const refused = {
    seq: 1, kind: "geometry", subject: plan[0].address, identityIds: ["terminal"],
    ok: false, reason: "the window was tiled when the geometry op came up, so it was refused"
  };
  const verdict = engine.verdictsFor(report, [refused])[0];
  assert.strictEqual(verdict.identityId, "terminal");
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.blockedBy.kind, "geometry");
  assert.match(verdict.blockedBy.reason, /tiled/);

  // And an outcome with no identityIds — what the defect produced — reaches
  // nobody, which is exactly why it was invisible.
  const anonymous = Object.assign({}, refused, { identityIds: [], subject: "" });
  assert.strictEqual(engine.verdictsFor(report, [anonymous])[0].blockedBy, null);
});

test("the geometry op is TWO dispatches, resize then move, both naming the window", () => {
  const op = { kind: "geometry", address: "0xaaa", at: [1700, 400], size: [1000, 700] };

  // Live-proven spelling, tick y29. Resize FIRST: a resize keeps the window's
  // centre fixed and therefore moves its `at`, so move→resize misses by exactly
  // half the size change. No `relative` key: x/y are the TARGET width/height on
  // resize and the TARGET position on move.
  assert.deepStrictEqual(engine.opToCommand(op), [
    "hyprctl dispatch 'hl.dsp.window.resize({ window = \"address:0xaaa\", x = 1000, y = 700 })'",
    "hyprctl dispatch 'hl.dsp.window.move({ window = \"address:0xaaa\", x = 1700, y = 400 })'"
  ]);

  assert.strictEqual(engine.describeOp(op), "geometry 0xaaa -> 1700,400 1000x700");
  assert.deepStrictEqual(engine.planAddresses([op]), ["0xaaa"]);

  // The TARGET is in the signature: two passes asking for the same destination
  // and not getting there are the same plan, which is what the no-progress
  // check has to be able to see.
  assert.notStrictEqual(
    engine.opSignature(op),
    engine.opSignature({ kind: "geometry", address: "0xaaa", at: [1700, 401], size: [1000, 700] }));
  assert.notStrictEqual(
    engine.opSignature(op),
    engine.opSignature({ kind: "geometry", address: "0xaaa", at: [1700, 400], size: [1001, 700] }));
  assert.ok(engine.samePlan([op], [{ kind: "geometry", address: "0xaaa", at: [1700, 400], size: [1000, 700] }]));
});

test("a geometry op never touches the focus, and a malformed one dispatches nothing", () => {
  const op = { kind: "geometry", address: "0xfeed", at: [10, 20], size: [30, 40] };
  for (const command of engine.opToCommand(op)) {
    assert.ok(!command.includes("hl.dsp.focus"), "focus-independent: " + command);
    assert.ok(command.includes('window = "address:0xfeed"'), "names its window: " + command);
    assert.ok(!command.includes("relative"), "absolute, never a nudge: " + command);
  }
  // A rect that is not a pair cannot be dispatched at all — better nothing than
  // a Lua payload with `x = undefined` in it.
  assert.deepStrictEqual(engine.opToCommand({ kind: "geometry", address: "0xa", at: [1], size: [2, 3] }), []);
  assert.deepStrictEqual(engine.opToCommand({ kind: "geometry", address: "0xa", size: [2, 3] }), []);
  assert.deepStrictEqual(engine.opToCommand({ kind: "geometry", address: "0xa", at: [1, 2] }), []);
});

// --- the planner gate: coordinates, and rects (tick ae1) ---------------------
//
// A geometry op is the only op in the plan that carries RAW GLOBAL COORDINATES
// out of the recording and into a dispatch. Everything else names a window, a
// workspace or a monitor and lets the compositor resolve it against the desktop
// as it is now. Two ways that goes wrong, both invisible to every gate that
// came before, and both refused in the planner where the recording is in hand.

test("a monitor REARRANGEMENT plans no pixels, and says why", () => {
  // topologyKey is a sorted list of DESCRIPTIONS. It is blind to position, to
  // scale and to order — deliberately, so a topology survives a reboot that
  // renumbers outputs. So the user who drags one output to the other side of
  // the other in the display settings keeps the same key, the same recording,
  // the same identities and the same monitor-present check, while every global
  // coordinate in the file now points somewhere else.
  const recorded = [makeClient({
    address: "0xfoot", class: "foot", workspace: 4, monitor: 1,
    floating: true, at: [1500, 100], size: [400, 300]
  })];
  const layout = engine.buildLayout(recorded, monitorsDocked, IDENTITIES, AT);
  // The headless output has no description at all, so the record holds its
  // NAME — the fallback this fixture exists to keep load-bearing.
  assert.strictEqual(layout.apps[0].monitorDescription, "hw-test");

  const live = [makeClient({
    address: "0xfoot", class: "foot", workspace: 4, monitor: 1,
    floating: true, at: [1600, 200], size: [400, 300]
  })];

  // As recorded: hw-test sits at x 1440, the rect is on it, and the op is
  // planned. This is the control — the gate must not cost the normal case.
  const planned = engine.planRestore(live, monitorsDocked, layout, IDENTITIES);
  assert.deepStrictEqual(planned,
    [{ kind: "geometry", address: "0xfoot", at: [1500, 100], size: [400, 300] }]);
  assert.strictEqual(
    engine.driftOf(live, monitorsDocked, layout, IDENTITIES).apps[0].geometry.skip, null);

  // Now the same two outputs with their POSITIONS swapped: hw-test on the left,
  // the laptop panel to the right of it. Nothing else about the desktop moves.
  const swapped = monitorsDocked.map((m) => Object.assign({}, m, {
    x: m.name === "hw-test" ? 0 : 960
  }));
  assert.strictEqual(engine.topologyKey(swapped), engine.topologyKey(monitorsDocked),
    "same key, same recording — this is why the coordinates have to be checked");

  const report = engine.driftOf(live, swapped, layout, IDENTITIES);
  const entry = report.apps[0];
  assert.strictEqual(entry.status, "drifted", "the monitor is present; the app is not skipped");
  assert.strictEqual(entry.geometry.verdict, "geometry-off", "and it really is off its pixels");
  assert.strictEqual(entry.geometry.skip, "off-region");
  assert.deepStrictEqual(engine.planRestore(live, swapped, layout, IDENTITIES), [],
    "no dispatch may aim x 1500 at a screen that no longer reaches it");

  // The reason travels the same road `monitor-absent` does: onto the verdict,
  // into the status file, out to the panel row and verify's GEOMETRY column.
  const verdict = engine.verdictsFor(report, [])[0];
  assert.strictEqual(verdict.geometry, "geometry-off");
  assert.strictEqual(verdict.geometryDetail.skip, "off-region");
  assert.match(verdict.text, /re-record/);
});

test("a rearrangement the UNION would have missed is caught by the recorded monitor", () => {
  // Swapping two outputs leaves the union of all monitor rects untouched, so
  // "is this rect anywhere on the desktop" answers yes for a window that is now
  // on the wrong screen. The recorded monitor's own rect is the question that
  // catches it, and it is the one the gate asks first.
  const recorded = [makeClient({
    address: "0xfoot", class: "foot", workspace: 4, monitor: 1,
    floating: true, at: [1500, 100], size: [400, 300]
  })];
  const layout = engine.buildLayout(recorded, monitorsDocked, IDENTITIES, AT);
  const swapped = monitorsDocked.map((m) => Object.assign({}, m, {
    x: m.name === "hw-test" ? 0 : 960
  }));

  const wanted = { x: 1500, y: 100, w: 400, h: 300 };
  assert.strictEqual(engine.rectsOverlap(wanted, engine.monitorRect(swapped[0])), true,
    "x 1500 is on the LAPTOP now — a union test sees nothing wrong");
  assert.strictEqual(engine.rectsOverlap(wanted, engine.monitorRect(swapped[1])), false,
    "…and nothing at all on the output it was recorded on");
  assert.strictEqual(engine.geometryPlanSkip(layout.apps[0], swapped), "off-region");
});

test("a corrupt recorded size can never dispatch, and never churns", () => {
  // The scenario: a hand-edited or damaged v2 file carries size [0, 0]. It is a
  // pair of finite numbers, so the readers pass it through (they coerce, they
  // never invent), it is recorded floating, and the live rect is nowhere near
  // it — every precondition the op had before this tick.
  const layout = geometryLayout();
  layout.apps[0].size = [0, 0];
  const live = floatAt([400, 300], [800, 600]);

  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.apps[0].geometry.verdict, "geometry-off");
  assert.strictEqual(report.apps[0].geometry.skip, "non-positive-size");

  // The churn this prevents, spelled out: the op carries the RECORDED rect, so
  // an op that cannot converge re-plans identically on every iteration of every
  // settle pass of every cycle, for ever, on a file the user cannot see is
  // broken. Ten plans, ten empty answers.
  for (let cycle = 0; cycle < 10; cycle++) {
    assert.deepStrictEqual(engine.planRestore(live, monitorsLaptop, layout, IDENTITIES), [],
      "cycle " + cycle + " must ask for nothing");
  }

  // And why the PLANNER is the place for it: handed the op, the executor's own
  // command builder produces two perfectly well-formed dispatches for a rect
  // nothing can be resized to. Nothing downstream of here would have caught it.
  assert.deepStrictEqual(
    engine.opToCommand({ kind: "geometry", address: "0xfoot", at: [400, 300], size: [0, 0] }),
    [
      "hyprctl dispatch 'hl.dsp.window.resize({ window = \"address:0xfoot\", x = 0, y = 0 })'",
      "hyprctl dispatch 'hl.dsp.window.move({ window = \"address:0xfoot\", x = 400, y = 300 })'"
    ]);

  // A size of zero on ONE axis is the same refusal — half a rect is not a rect.
  layout.apps[0].size = [800, 0];
  assert.deepStrictEqual(engine.planRestore(live, monitorsLaptop, layout, IDENTITIES), []);
});

test("the gate leaves every other reason a float is not planned exactly as it was", () => {
  // Regression fence around the four pre-existing "no op" answers, none of
  // which may start carrying a skip word: they were never candidates, and a
  // reason on those rows would be an unexplained amber.
  const layout = geometryLayout();
  const far = floatAt([1200, 800], [200, 100]);
  const drifted = engine.driftOf(far, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(drifted.apps[0].geometry.skip, null, "an ordinary miss plans, and skips nothing");

  const v1 = geometryLayout();
  v1.apps[0].at = null;
  v1.apps[0].size = null;
  assert.strictEqual(engine.driftOf(far, monitorsLaptop, v1, IDENTITIES).apps[0].geometry.skip, null);

  const tiledRecord = engine.buildLayout(
    [makeClient({ address: "0xfoot", class: "foot", workspace: 2, monitor: 0, at: [400, 300], size: [800, 600] })],
    monitorsLaptop, IDENTITIES, AT);
  assert.strictEqual(
    engine.driftOf(far, monitorsLaptop, tiledRecord, IDENTITIES).apps[0].geometry.skip, null,
    "a tiled record is measured, never planned, and never skipped either");

  const skipped = geometryLayout();
  skipped.apps[0].monitorDescription = "hw-test";
  assert.strictEqual(engine.driftOf(far, monitorsLaptop, skipped, IDENTITIES).apps[0].geometry.skip, null);
});

// --- what an op touches: one answer, one place (tick ae1) --------------------

// Service.beginOp's body, as it now stands: three engine calls and not one
// mention of a kind. Mirrored here because the QML cannot be run under node —
// what is under test is that the engine gives the service everything the ledger
// needs for an op no branch has ever heard of.
function ledgerRecord(op, clients, identities) {
  const addresses = engine.opAddressesOf(op);
  const ids = [];
  for (const address of addresses) {
    const client = clients.find((c) => c && c.address === address);
    const id = client ? engine.matchClient(client, identities) : "";
    if (id && ids.indexOf(id) === -1) ids.push(id);
  }
  return {
    seq: 1,
    kind: op.kind,
    subject: engine.opSubjectOf(op),
    identityIds: addresses.length
      ? ids
      : ((typeof op.identityId === "string" && op.identityId) ? [op.identityId] : []),
    ok: true,
    reason: ""
  };
}

test("a future op kind that names a window is resolved by SHAPE, not by a list of kinds", () => {
  // The trap this retires: "which windows does this op touch" was answered by
  // three separate kind ladders (planAddresses, the snapshot check through it,
  // and beginOp's ledger). Tick qkv added an op and updated two of them, and
  // the third failed silently — an empty identity list is invisible to
  // blockedByIndex, so every refused geometry op left the user's row blank.
  //
  // So the test is written against a kind that does not exist and never will:
  // if anything downstream still enumerates kinds, this is where it says so.
  const clients = floatAt([400, 300], [800, 600]);
  const future = { kind: "teleport", address: "0xfoot", destination: "mars" };

  assert.deepStrictEqual(engine.opAddressesOf(future), ["0xfoot"]);
  assert.strictEqual(engine.opSubjectOf(future), "0xfoot");
  assert.deepStrictEqual(engine.planAddresses([future]), ["0xfoot"]);
  assert.deepStrictEqual(engine.unknownPlanAddresses([future], clients), [],
    "the snapshot invariant covers it too, with no edit");
  assert.deepStrictEqual(engine.unknownPlanAddresses([future], []), ["0xfoot"]);

  // The ledger entry beginOp would open, and the row it can therefore reach.
  const record = ledgerRecord(future, clients, IDENTITIES);
  assert.strictEqual(record.subject, "0xfoot", "never a blank subject");
  assert.deepStrictEqual(record.identityIds, ["terminal"]);

  const layout = geometryLayout();
  const report = engine.driftOf(floatAt([1200, 900], [300, 200]), monitorsLaptop, layout, IDENTITIES);
  engine.failOutcome(record, "the compositor has no teleporter");
  const verdict = engine.verdictsFor(report, [record])[0];
  assert.strictEqual(verdict.blockedBy.kind, "teleport");
  assert.match(verdict.blockedBy.reason, /teleporter/);

  // A multi-window future kind travels the same road.
  const pair = { kind: "swap", addresses: ["0xfoot", "0xghost"] };
  assert.deepStrictEqual(engine.opAddressesOf(pair), ["0xfoot", "0xghost"]);
  assert.strictEqual(engine.opSubjectOf(pair), "0xfoot+0xghost");
  assert.deepStrictEqual(engine.unknownPlanAddresses([pair], clients), ["0xghost"]);

  // And it compares by SUBJECT, so two different future ops are two different
  // plans rather than one no-progress loop.
  assert.notStrictEqual(engine.opSignature(future),
    engine.opSignature({ kind: "teleport", address: "0xbeef" }));
  assert.ok(engine.describeOp(future).indexOf("0xfoot") >= 0);
});

test("opAddressesOf agrees with every op the planner actually emits", () => {
  const table = [
    [{ kind: "launch", identityId: "slack" }, [], "slack"],
    [{ kind: "workspace-monitor", workspaceId: 9, monitorDescription: "Laptop", monitorName: "eDP-1" },
      [], "9@eDP-1"],
    [{ kind: "move", address: "0xa", workspaceId: 3 }, ["0xa"], "0xa"],
    [{ kind: "floating", address: "0xb", value: true }, ["0xb"], "0xb"],
    [{ kind: "geometry", address: "0xc", at: [1, 2], size: [3, 4] }, ["0xc"], "0xc"],
    [{ kind: "group", addresses: ["0xd", "0xe"], missing: [] }, ["0xd", "0xe"], "0xd+0xe"],
    [{ kind: "ungroup", addresses: ["0xf"] }, ["0xf"], "0xf"]
  ];
  for (const [op, addresses, subject] of table) {
    assert.deepStrictEqual(engine.opAddressesOf(op), addresses, op.kind);
    assert.strictEqual(engine.opSubjectOf(op), subject, op.kind);
  }

  // Junk in, empty out — never a crash and never a phantom address, because
  // this answer is what the snapshot invariant is checked against.
  for (const op of [null, undefined, {}, { kind: "move" }, { kind: "move", address: "" },
    { kind: "group", addresses: null }, { kind: "group", addresses: "0xa" },
    { kind: "group", addresses: ["", null, 7] }]) {
    assert.deepStrictEqual(engine.opAddressesOf(op), [], JSON.stringify(op));
  }
  assert.strictEqual(engine.opSubjectOf(null), "");
  assert.strictEqual(engine.opSubjectOf({ kind: "mystery" }), "");
});

// --- one op, one failure, first reason wins (tick ae1) -----------------------

test("the FIRST reason wins: a diagnosis is not overwritten by its own symptom", () => {
  // The sequence this comes from: a geometry op's resize is rejected, hyprctl
  // answers with the compositor's own words (the sentence that actually
  // diagnoses the bug), and the confirming re-read that follows reports only
  // that the window did not move — which is what the first sentence already
  // said, minus the diagnosis. Last-write-wins kept the symptom every time.
  const record = { seq: 1, kind: "geometry", subject: "0xa", identityIds: ["terminal"], ok: true, reason: "" };

  assert.strictEqual(engine.failOutcome(record, "compositor refused place 0xa: unrecognized arguments"), true,
    "the first failure is the one that fails the record");
  assert.strictEqual(record.ok, false);

  assert.strictEqual(engine.failOutcome(record, "the geometry dispatch did not land (reads …)"), false,
    "and every later one is told it changed nothing");
  assert.match(record.reason, /unrecognized arguments/);
});

test("one op counts one cycle failure, however many times it is observed failing", () => {
  // cycleFailures is what lastResult.ok, the "— N failed" toast and the
  // forensics gate all read, so it counts OPS THAT DID NOT LAND. The service
  // increments on failOutcome's return value; this is that arithmetic.
  const record = { seq: 1, kind: "geometry", subject: "0xa", identityIds: ["terminal"], ok: true, reason: "" };
  let cycleFailures = 0;
  const failAndCount = (reason, ids) => {
    if (engine.failOutcome(record, reason, ids)) cycleFailures += 1;
  };

  failAndCount("compositor refused the resize");
  failAndCount("the geometry dispatch did not land");
  failAndCount("the geometry dispatch did not land");
  assert.strictEqual(cycleFailures, 1, "one window that did not move is one failure");
});

test("a narrowed blame travels with the reason it belongs to, and cannot be re-aimed", () => {
  // A group of four where the third member would not join is ONE blocked app,
  // not four — so narrowing moves with the reason. And because the reason is
  // first-wins, a later failure cannot leave the first sentence pointing at a
  // different app than the one it is about.
  const record = { seq: 1, kind: "group", subject: "a+b+c", identityIds: ["x", "y", "z"], ok: true, reason: "" };
  engine.failOutcome(record, "group join refused by compositor", ["y"]);
  assert.deepStrictEqual(record.identityIds, ["y"]);

  engine.failOutcome(record, "something else entirely", ["z"]);
  assert.deepStrictEqual(record.identityIds, ["y"], "the first failure keeps its subject");
  assert.match(record.reason, /group join refused/);

  // No narrowing given: the op's own list stands.
  const wide = { seq: 2, kind: "group", subject: "a+b", identityIds: ["x", "y"], ok: true, reason: "" };
  engine.failOutcome(wide, "the clients read failed");
  assert.deepStrictEqual(wide.identityIds, ["x", "y"]);

  // Defensive: no record is not a failure, and a missing reason is "" and not
  // the string "undefined" on a panel row.
  assert.strictEqual(engine.failOutcome(null, "nobody"), false);
  const bare = { ok: true, reason: "x" };
  assert.strictEqual(engine.failOutcome(bare), true);
  assert.strictEqual(bare.reason, "");
});

// --- empty / defensive ------------------------------------------------------

test("no layout means nothing to do", () => {
  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, null, IDENTITIES), []);
  assert.deepStrictEqual(engine.planRestore(clientsLaptop, monitorsLaptop, { apps: [] }, IDENTITIES), []);

  const report = engine.driftOf(clientsLaptop, monitorsLaptop, null, IDENTITIES);
  assert.deepStrictEqual(report.apps, []);
  assert.deepStrictEqual(report.summary, { ok: 0, drifted: 0, missing: 0, skipped: 0 });
  assert.strictEqual(report.topologyMatches, false);
});

test("an empty desktop plans a launch for every recorded app", () => {
  const ops = engine.planRestore([], monitorsLaptop, recorded, IDENTITIES);
  assert.strictEqual(ops.length, recorded.apps.length);
  for (const op of ops) assert.strictEqual(op.kind, "launch");
  assert.deepStrictEqual(ops.map((o) => o.identityId), recorded.apps.map((a) => a.identityId));
});

// --- command strings --------------------------------------------------------

test("a move op is ONE dispatch that names the window, never focus-then-move", () => {
  const op = { kind: "move", address: "0x55c6f813b3f0", workspaceId: 10, monitorDescription: LAPTOP_DESC };

  // Live-verified spelling (see the block above opToCommand): the window is
  // named, so the move lands whatever holds the keyboard — which an open panel
  // does, and that is the bug this shape exists to fix.
  assert.deepStrictEqual(engine.opToCommand(op), [
    "hyprctl dispatch 'hl.dsp.window.move({ window = \"address:0x55c6f813b3f0\""
      + ", workspace = \"10\", follow = false })'"
  ]);
});

test("a move op does not touch the focus at all", () => {
  const op = { kind: "move", address: "0xfeed", workspaceId: 4, monitorDescription: LAPTOP_DESC };
  for (const command of engine.opToCommand(op)) {
    assert.ok(!command.includes("hl.dsp.focus"), command);
  }
});

test("a workspace-monitor op becomes hl.dsp.workspace.move, naming the live output", () => {
  // The Quattro spelling of the legacy `moveworkspacetomonitor 3 eDP-1`.
  // Verb evidence: Omarchy's own hypr/bindings/tiling.lua uses
  // hl.dsp.workspace.move({ monitor = ... }) for the arrow-key bindings.
  const op = {
    kind: "workspace-monitor",
    workspaceId: 3,
    monitorDescription: LAPTOP_DESC,
    monitorName: "eDP-1"
  };

  assert.deepStrictEqual(engine.opToCommand(op), [
    "hyprctl dispatch 'hl.dsp.workspace.move({ workspace = \"3\", monitor = \"eDP-1\" })'"
  ]);

  // The output NAME is what goes on the wire — a bare description is not a
  // monitor selector, and monitorLabel() only sometimes yields one.
  assert.ok(!engine.opToCommand(op)[0].includes(LAPTOP_DESC));

  // Without a resolved live monitor there is nothing safe to dispatch.
  assert.deepStrictEqual(
    engine.opToCommand({ kind: "workspace-monitor", workspaceId: 3, monitorDescription: "gone", monitorName: "" }),
    []
  );
});

test("a group op names the window it toggles, and focuses only for into_group", () => {
  const op = { kind: "group", addresses: ["0xaaa", "0xbbb", "0xccc"], missing: [] };

  // Asymmetric on purpose, and both halves are live-verified: group.toggle
  // honours `window = "address:…"`, into_group ignores it and acts on the
  // ACTIVE window — so the join, and only the join, still focuses first.
  //
  // TWO focuses per join, and the order between them is the whole point:
  // into_group inserts after the group's FOCUSED tab, so the predecessor is
  // focused first to nominate the insertion point, then the joiner is focused
  // because that is the window into_group will actually move.
  assert.deepStrictEqual(engine.opToCommand(op), [
    "hyprctl dispatch 'hl.dsp.group.toggle({ window = \"address:0xaaa\" })'",
    "hyprctl dispatch 'hl.dsp.focus({ window = \"address:0xaaa\" })'",
    "hyprctl dispatch 'hl.dsp.focus({ window = \"address:0xbbb\" })'",
    "hyprctl dispatch 'hl.dsp.window.move({ into_group = \"left\" })'",
    "hyprctl dispatch 'hl.dsp.focus({ window = \"address:0xbbb\" })'",
    "hyprctl dispatch 'hl.dsp.focus({ window = \"address:0xccc\" })'",
    "hyprctl dispatch 'hl.dsp.window.move({ into_group = \"left\" })'"
  ]);
});

test("no dispatch that can name its window is left to act on the focus", () => {
  // The regression guard for the whole tick. A dispatch that CAN be targeted
  // and is not is the silent failure: the compositor answers "ok" and moves
  // whatever happens to be active, which under an open panel is nothing.
  const targetable = [
    { kind: "move", address: "0xaaa", workspaceId: 3, monitorDescription: LAPTOP_DESC },
    { kind: "group", addresses: ["0xaaa", "0xbbb"] }
  ];

  for (const op of targetable) {
    for (const command of engine.opToCommand(op)) {
      if (command.includes("hl.dsp.window.move({ workspace")) {
        assert.fail("untargeted move, acts on the focused window: " + command);
      }
      if (command.includes("hl.dsp.group.toggle()")) {
        assert.fail("untargeted group toggle, acts on the focused window: " + command);
      }
    }
  }
});

test("the commands never use a legacy dispatcher or the wrong group verb", () => {
  const plan = [
    { kind: "workspace-monitor", workspaceId: 2, monitorDescription: LAPTOP_DESC, monitorName: "eDP-1" },
    { kind: "move", address: "0xaaa", workspaceId: 2, monitorDescription: LAPTOP_DESC },
    { kind: "group", addresses: ["0xaaa", "0xbbb"] }
  ];

  for (const op of plan) {
    for (const command of engine.opToCommand(op)) {
      assert.ok(command.startsWith("hyprctl dispatch 'hl.dsp."), command);
      assert.ok(command.endsWith("'"), command);
      // movegroupwindow reorders WITHIN a group and errors here.
      assert.ok(!command.includes("group.move_window"), command);
      assert.ok(!command.includes("movegroupwindow"), command);
      assert.ok(!/into_group = "[lrud]"/.test(command), "direction must be spelled out: " + command);
      assert.ok(!/dispatch (movewindow|workspace|togglegroup|focuswindow)/.test(command), command);
      assert.ok(!command.includes("moveworkspacetomonitor"), command);
    }
  }
});

test("degenerate ops produce no commands", () => {
  assert.deepStrictEqual(engine.opToCommand({ kind: "group", addresses: ["0xaaa"] }), []);
  assert.deepStrictEqual(engine.opToCommand({ kind: "group" }), []);
  // Launching needs a command an identity does not carry yet — the service owns it.
  assert.deepStrictEqual(engine.opToCommand({ kind: "launch", identityId: "editor" }), []);
  assert.deepStrictEqual(engine.opToCommand({ kind: "nonsense" }), []);
  assert.deepStrictEqual(engine.opToCommand(null), []);
});

test("a full plan maps to a runnable command sequence", () => {
  const scattered = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 5 }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 6 }),
    makeClient({ address: "0xccc", class: "code", workspace: 3 })
  ];
  const layout = engine.buildLayout(twoWindowGroupClients(), monitorsLaptop, IDENTITIES, AT);

  const commands = engine
    .planRestore(scattered, monitorsLaptop, layout, IDENTITIES)
    .reduce((all, op) => all.concat(engine.opToCommand(op)), []);

  assert.deepStrictEqual(commands, [
    "hyprctl dispatch 'hl.dsp.window.move({ window = \"address:0xbbb\", workspace = \"2\", follow = false })'",
    "hyprctl dispatch 'hl.dsp.window.move({ window = \"address:0xaaa\", workspace = \"2\", follow = false })'",
    "hyprctl dispatch 'hl.dsp.group.toggle({ window = \"address:0xaaa\" })'",
    "hyprctl dispatch 'hl.dsp.focus({ window = \"address:0xaaa\" })'",
    "hyprctl dispatch 'hl.dsp.focus({ window = \"address:0xbbb\" })'",
    "hyprctl dispatch 'hl.dsp.window.move({ into_group = \"left\" })'"
  ]);
});

// --- zero progress ----------------------------------------------------------
//
// The convergence loop's new stop condition: a plan that comes back IDENTICAL to
// the one just executed means the dispatches did nothing, and the remaining
// iterations would only do nothing again. See Service.qml planAndExecute.

test("a plan is the same as itself, and as an equal plan built separately", () => {
  const a = [
    { kind: "move", address: "0xaaa", workspaceId: 8, monitorDescription: LAPTOP_DESC },
    { kind: "group", addresses: ["0xaaa", "0xbbb"] }
  ];
  const b = [
    { kind: "move", address: "0xaaa", workspaceId: 8, monitorDescription: LAPTOP_DESC },
    { kind: "group", addresses: ["0xaaa", "0xbbb"] }
  ];

  assert.strictEqual(engine.samePlan(a, a), true);
  // Different objects, same instructions — which is the only case that ever
  // occurs, since each iteration re-plans from a fresh hyprctl read.
  assert.strictEqual(engine.samePlan(a, b), true);
});

test("a plan that lost an op, gained one, or reordered is not the same plan", () => {
  const base = [
    { kind: "move", address: "0xaaa", workspaceId: 8, monitorDescription: LAPTOP_DESC },
    { kind: "move", address: "0xbbb", workspaceId: 9, monitorDescription: LAPTOP_DESC }
  ];

  assert.strictEqual(engine.samePlan(base, base.slice(1)), false, "shrinking is progress");
  assert.strictEqual(
    engine.samePlan(base, base.concat([{ kind: "launch", identityId: "mail" }])),
    false
  );
  assert.strictEqual(engine.samePlan(base, base.slice().reverse()), false, "order is instruction");
});

test("the same op with a different subject is a different plan", () => {
  const to8 = [{ kind: "move", address: "0xaaa", workspaceId: 8, monitorDescription: LAPTOP_DESC }];
  const to9 = [{ kind: "move", address: "0xaaa", workspaceId: 9, monitorDescription: LAPTOP_DESC }];
  const other = [{ kind: "move", address: "0xbbb", workspaceId: 8, monitorDescription: LAPTOP_DESC }];

  assert.strictEqual(engine.samePlan(to8, to9), false);
  assert.strictEqual(engine.samePlan(to8, other), false);
});

test("a field that carries no instruction does not make two plans differ", () => {
  // monitorDescription is context for the caller; the move dispatch never
  // mentions it. Two plans that would run the same dispatches are the same.
  const a = [{ kind: "move", address: "0xaaa", workspaceId: 8, monitorDescription: LAPTOP_DESC }];
  const b = [{ kind: "move", address: "0xaaa", workspaceId: 8, monitorDescription: "" }];
  assert.strictEqual(engine.samePlan(a, b), true);
});

test("two empty plans are the same, and a missing plan is never the same as anything", () => {
  assert.strictEqual(engine.samePlan([], []), true);
  // null is "no previous plan yet", i.e. the first iteration of a pass — which
  // must never be mistaken for no progress.
  assert.strictEqual(engine.samePlan(null, []), false);
  assert.strictEqual(engine.samePlan([], null), false);
  assert.strictEqual(engine.samePlan(null, null), false);
});

test("planRestore against an unchanged desktop plans the same plan twice", () => {
  // The real shape of the failure: nothing was dispatched (or the dispatches
  // did nothing), so the second read yields the identical plan.
  const scattered = [
    makeClient({ address: "0xbbb", class: "chromium", workspace: 5 }),
    makeClient({ address: "0xaaa", class: "foot", workspace: 6 })
  ];
  const layout = engine.buildLayout(twoWindowGroupClients(), monitorsLaptop, IDENTITIES, AT);

  const first = engine.planRestore(scattered, monitorsLaptop, layout, IDENTITIES);
  const second = engine.planRestore(scattered, monitorsLaptop, layout, IDENTITIES);

  assert.ok(first.length > 0);
  assert.strictEqual(engine.samePlan(first, second), true);
});

test("describeOp names the subject of every op kind", () => {
  assert.strictEqual(
    engine.describeOp({ kind: "move", address: "0xaaa", workspaceId: 8 }),
    "move 0xaaa -> ws 8"
  );
  assert.strictEqual(
    engine.describeOp({ kind: "workspace-monitor", workspaceId: 3, monitorName: "eDP-1" }),
    "workspace-monitor ws 3 -> eDP-1"
  );
  assert.strictEqual(
    engine.describeOp({ kind: "group", addresses: ["0xaaa", "0xbbb"] }),
    "group 0xaaa+0xbbb"
  );
  assert.strictEqual(engine.describeOp({ kind: "launch", identityId: "mail" }), "launch mail");
  assert.strictEqual(engine.describeOp(null), "(no op)");
});

// --- multi-window restore: matching, per-occurrence drift, launch deficit ----
//
// Tick 9sl. The record can now name several windows of one identity, so restore
// has to decide WHICH live window each recorded occurrence is about. The three
// passes are exact placement agreement, then best geometry overlap, then the
// remainder in the shared placement order (engine.matchOccurrences).

const TERMINALS = [{ id: "terminal", patterns: ["^foot$"], launch: "foot" }];

function terminalsAt(specs) {
  return specs.map((spec) => makeClient({
    address: spec.address,
    class: "foot",
    workspace: spec.workspace,
    at: spec.at || [0, 0],
    size: spec.size || [800, 600],
    grouped: spec.grouped || []
  }));
}

const THREE_TERMINALS = terminalsAt([
  { address: "0xt1", workspace: 1, at: [0, 0] },
  { address: "0xt2", workspace: 4, at: [10, 10] },
  { address: "0xt3", workspace: 7, at: [20, 20] }
]);
const THREE_RECORDED = engine.buildLayout(THREE_TERMINALS, monitorsLaptop, TERMINALS, AT);

test("two conforming same-identity windows plan zero ops, in any read order", () => {
  // The idempotence invariant, and the reason the matcher exists at all. A
  // lookup by occurrence would renumber the pair on the reversed read and plan
  // two moves that swap them — and then two more, for ever.
  const pair = THREE_TERMINALS.slice(0, 2);
  const layout = engine.buildLayout(pair, monitorsLaptop, TERMINALS, AT);

  assert.deepStrictEqual(engine.planRestore(pair, monitorsLaptop, layout, TERMINALS), []);
  assert.deepStrictEqual(
    engine.planRestore(pair.slice().reverse(), monitorsLaptop, layout, TERMINALS), [],
    "no pointless swap moves when hyprctl lists the windows the other way round");

  // And every occurrence keeps its own window rather than merely "some window".
  const report = engine.driftOf(pair.slice().reverse(), monitorsLaptop, layout, TERMINALS);
  assert.deepStrictEqual(report.apps.map((a) => a.occurrence), [0, 1]);
  assert.deepStrictEqual(report.apps.map((a) => a.current.address), ["0xt1", "0xt2"]);
  assert.ok(report.apps.every((a) => a.status === "ok"));
});

test("an already-in-place window keeps its occurrence while its twin is moved", () => {
  // Pass 1 is what makes a HALF-restored desktop finish rather than start over:
  // the window already on ws 1 is the ws-1 entry, whatever the other one does.
  const moved = terminalsAt([
    { address: "0xt1", workspace: 1, at: [0, 0] },
    { address: "0xt2", workspace: 9, at: [10, 10] }
  ]);
  const layout = engine.buildLayout(THREE_TERMINALS.slice(0, 2), monitorsLaptop, TERMINALS, AT);

  assert.deepStrictEqual(engine.planRestore(moved, monitorsLaptop, layout, TERMINALS), [
    { kind: "move", address: "0xt2", workspaceId: 4, monitorDescription: LAPTOP_DESC }
  ]);
});

test("geometry overlap pairs a window that moved with the entry it came from", () => {
  // Neither window is where it was recorded, so pass 1 has nothing to say. Both
  // kept their rects, and the rects are what tell them apart.
  const layout = engine.buildLayout(terminalsAt([
    { address: "0xt1", workspace: 1, at: [0, 0], size: [800, 600] },
    { address: "0xt2", workspace: 4, at: [900, 0], size: [800, 600] }
  ]), monitorsLaptop, TERMINALS, AT);

  // Live: the ws-1 window is now on ws 5 and the ws-4 window on ws 6, but each
  // still carries its own rect — and hyprctl lists them the other way round.
  const shuffled = terminalsAt([
    { address: "0xt2", workspace: 6, at: [900, 0], size: [800, 600] },
    { address: "0xt1", workspace: 5, at: [0, 0], size: [800, 600] }
  ]);

  assert.deepStrictEqual(engine.planRestore(shuffled, monitorsLaptop, layout, TERMINALS), [
    { kind: "move", address: "0xt1", workspaceId: 1, monitorDescription: LAPTOP_DESC },
    { kind: "move", address: "0xt2", workspaceId: 4, monitorDescription: LAPTOP_DESC }
  ]);
});

test("missing occurrences are reported one row each, and the deficit is the launch count", () => {
  const report = engine.driftOf([THREE_TERMINALS[0]], monitorsLaptop, THREE_RECORDED, TERMINALS);

  assert.deepStrictEqual(
    report.apps.map((a) => [a.occurrence, a.status]),
    [[0, "ok"], [1, "missing"], [2, "missing"]],
    "each occurrence answers for itself"
  );
  assert.deepStrictEqual(report.summary, { ok: 1, drifted: 0, missing: 2, skipped: 0 });

  // Two missing occurrences, two launch intents: the deficit IS the count.
  const plan = engine.planRestore([THREE_TERMINALS[0]], monitorsLaptop, THREE_RECORDED, TERMINALS);
  assert.deepStrictEqual(plan, [
    { kind: "launch", identityId: "terminal" },
    { kind: "launch", identityId: "terminal" }
  ]);
  // And it re-plans identically, so the no-progress check reads it as one
  // stalled step rather than as churn.
  assert.strictEqual(engine.samePlan(plan,
    engine.planRestore([THREE_TERMINALS[0]], monitorsLaptop, THREE_RECORDED, TERMINALS)), true);
});

test("a deficit of one plans exactly the op today's single-window record planned", () => {
  // The byte-compatibility pin: nothing about the one-window case may have moved.
  const layout = engine.buildLayout([THREE_TERMINALS[0]], monitorsLaptop, TERMINALS, AT);
  assert.deepStrictEqual(engine.planRestore([], monitorsLaptop, layout, TERMINALS),
    [{ kind: "launch", identityId: "terminal" }]);
  assert.deepStrictEqual(engine.planRestore([], monitorsLaptop, THREE_RECORDED, TERMINALS).length, 3);
});

test("a group op addresses the MATCHED windows, in recorded tuple order", () => {
  // Two terminals tabbed together with a third window elsewhere. The group's
  // recorded order is (terminal,0), (terminal,1) — two tuples of one identity,
  // which is the membership schema v2 could not express at all.
  const tabs = ["0xt1", "0xt2"];
  const grouped = terminalsAt([
    { address: "0xt1", workspace: 2, at: [0, 0], grouped: tabs },
    { address: "0xt2", workspace: 2, at: [0, 0], grouped: tabs }
  ]);
  const layout = engine.buildLayout(grouped, monitorsLaptop, TERMINALS, AT);
  assert.deepStrictEqual(layout.apps.map((a) => a.group), [
    { groupId: "group:terminal+terminal#1", index: 0 },
    { groupId: "group:terminal+terminal#1", index: 1 }
  ]);
  assert.deepStrictEqual(engine.planRestore(grouped, monitorsLaptop, layout, TERMINALS), []);

  // Pulled apart: the rebuild names both live windows, in recorded tab order.
  const scattered = terminalsAt([
    { address: "0xt2", workspace: 2, at: [0, 0] },
    { address: "0xt1", workspace: 2, at: [0, 0] }
  ]);
  const ops = engine.planRestore(scattered, monitorsLaptop, layout, TERMINALS);
  assert.deepStrictEqual(ops.filter((o) => o.kind === "group"), [
    { kind: "group", addresses: ["0xt1", "0xt2"], missing: [] }
  ]);

  const report = engine.driftOf(scattered, monitorsLaptop, layout, TERMINALS);
  assert.deepStrictEqual(report.groups[0].memberKeys, ["terminal", "terminal#1"]);
  assert.deepStrictEqual(report.groups[0].identityIds, ["terminal", "terminal"]);
});

test("a verdict sentence names the instance only when there is more than one", () => {
  const report = engine.driftOf(terminalsAt([
    { address: "0xt1", workspace: 1, at: [0, 0] },
    { address: "0xt2", workspace: 9, at: [10, 10] }
  ]), monitorsLaptop, THREE_RECORDED, TERMINALS);
  const verdicts = engine.verdictsFor(report, []);

  assert.deepStrictEqual(verdicts.map((v) => [v.instance, v.instances]), [[1, 3], [2, 3], [3, 3]]);
  assert.strictEqual(engine.verdictInstanceLabel(verdicts[1]), "window 2 of 3");

  // A single-window identity says nothing about instances at all.
  const solo = engine.verdictsFor(
    engine.driftOf(clientsLaptop, monitorsLaptop,
      engine.buildLayout([clientsLaptop.find((c) => c.class === "code")], monitorsLaptop, IDENTITIES, AT),
      IDENTITIES), []);
  assert.deepStrictEqual(solo.map((v) => [v.instance, v.instances]), [[1, 1]]);
  assert.strictEqual(engine.verdictInstanceLabel(solo[0]), "");

  // And the toast disambiguates by the same words, in the same place.
  const summary = engine.verdictSummary(verdicts);
  assert.ok(summary.text.indexOf("terminal (window 2 of 3)") !== -1, summary.text);
});

// --- the launch deficit, as pure numbers (tick l64) --------------------------
//
// The service's serial launch coordination is QML, but what it counts is not:
// how many windows of an identity are open, and how many more the plan wants.

test("liveWindowCount counts every window of an identity, not just the first", () => {
  assert.strictEqual(engine.liveWindowCount(THREE_TERMINALS, TERMINALS[0], TERMINALS), 3);
  assert.strictEqual(engine.liveWindowCount([THREE_TERMINALS[0]], TERMINALS[0], TERMINALS), 1);
  assert.strictEqual(engine.liveWindowCount([], TERMINALS[0], TERMINALS), 0);
  assert.strictEqual(engine.liveWindowCount(null, TERMINALS[0], TERMINALS), 0);

  // The catch-all trap: counted through matchClient's priority order, so a
  // window that a more specific identity claims is not counted twice.
  assert.strictEqual(
    engine.liveWindowCount(clientsLaptop, IDENTITIES.find((i) => i.id === "terminal"), IDENTITIES), 2);
});

test("the launch deficit is the count of launch ops, per identity, in plan order", () => {
  const deficit = engine.launchDeficits(
    engine.planRestore([THREE_TERMINALS[0]], monitorsLaptop, THREE_RECORDED, TERMINALS));
  assert.deepStrictEqual(deficit, [{ identityId: "terminal", count: 2 }]);
  assert.strictEqual(engine.launchDeficitFor(
    engine.planRestore([THREE_TERMINALS[0]], monitorsLaptop, THREE_RECORDED, TERMINALS), "terminal"), 2);

  // First-appearance order, and non-launch ops are invisible to it.
  assert.deepStrictEqual(engine.launchDeficits([
    { kind: "launch", identityId: "b" },
    { kind: "move", address: "0x1" },
    { kind: "launch", identityId: "a" },
    { kind: "launch", identityId: "b" }
  ]), [{ identityId: "b", count: 2 }, { identityId: "a", count: 1 }]);

  // A deficit of one is what every pre-v3 plan carried, and it still reads as 1.
  const solo = engine.buildLayout([THREE_TERMINALS[0]], monitorsLaptop, TERMINALS, AT);
  assert.deepStrictEqual(engine.launchDeficits(engine.planRestore([], monitorsLaptop, solo, TERMINALS)),
    [{ identityId: "terminal", count: 1 }]);

  assert.deepStrictEqual(engine.launchDeficits([]), []);
  assert.deepStrictEqual(engine.launchDeficits(null), []);
  assert.strictEqual(engine.launchDeficitFor([], "terminal"), 0);
});

test("filling the deficit one window at a time converges", () => {
  // What the service does, as arithmetic: launch, the count goes up by one,
  // re-plan. Three recorded windows and none running takes three launches and
  // then asks for nothing.
  let live = [];
  let plan = engine.planRestore(live, monitorsLaptop, THREE_RECORDED, TERMINALS);
  const counts = [];
  for (let guard = 0; guard < 5 && plan.length; guard++) {
    counts.push(engine.launchDeficitFor(plan, "terminal"));
    // One launch per pass, exactly as the serial coordinator dispatches them.
    live = live.concat([THREE_TERMINALS[live.length]]);
    plan = engine.planRestore(live, monitorsLaptop, THREE_RECORDED, TERMINALS);
  }
  assert.deepStrictEqual(counts, [3, 2, 1]);
  assert.deepStrictEqual(plan, []);
});
