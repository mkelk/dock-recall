// Tiled placement — tick 35n.
//
// Two questions, kept apart on purpose:
//
//   1. THE READING. Given a set of recorded rects, what dwindle tree produced
//      them, and what insertion program rebuilds it? That is pure geometry, it
//      is a table, and it is checked below against trees this project WATCHED
//      being built (docs/state-matrix.md § Tiled placement § 4) — not against
//      trees invented here, which would only prove the code agrees with itself.
//
//   2. THE GATE. planRestore may only put that program in a plan when the
//      workspace is about to be built from nothing, by us, out of windows we
//      can all account for. Five preconditions, and the tests that matter most
//      are the ones where a precondition FAILS and the plan comes back in plain
//      recorded order with no focus in it at all — because the failure mode of
//      a wrong tree is not a bad score, it is a restore that confidently
//      focuses the wrong windows and assembles a layout nobody recorded.
//
// The rects are the real ones, off eDP-1 at 1440x900 logical: usable area
// [12,38] 1416x850, gaps_in 5, so a 50/50 vertical cut gives 701 and 701 with
// the far side starting at 727.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const { makeClient } = require("./helpers.js");

// ---------------------------------------------------------------------------
// The trees the probe actually built, as fixtures
// ---------------------------------------------------------------------------

const TREES = {
  // Two windows: one cut, and the only cut there can be.
  pair: [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [701, 850] }
  ],
  // 3-window, second cut on the FAR side — the tree the probe got from
  // "focus 1, move 2; focus 2, move 3".
  spine3: [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [701, 418] },
    { key: "c", at: [727, 470], size: [701, 418] }
  ],
  // 3-window, second cut on the NEAR side — "focus 1, move 2; focus 1, move 3".
  fan3: [
    { key: "a", at: [12, 38], size: [701, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] }
  ],
  // 4-window spine 1→2→3.
  spine4: [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [701, 418] },
    { key: "c", at: [727, 470], size: [341, 418] },
    { key: "d", at: [1082, 470], size: [346, 418] }
  ],
  // 4-window, every arrival splitting the first window.
  fan4: [
    { key: "a", at: [12, 38], size: [346, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] },
    { key: "d", at: [372, 38], size: [341, 418] }
  ]
};

function program(items) {
  const order = engine.placementOrderOf(items);
  if (!order) return null;
  return order.map((o) => o.key + (o.parentKey ? "<-" + o.parentKey : "")).join(" ");
}

test("the insertion program of a tree the probe watched being built is the program that built it", () => {
  // Left column is what docs/state-matrix.md § Tiled placement § 4 dispatched;
  // right column is what this code reads back out of the rects it produced.
  assert.equal(program(TREES.pair), "a b<-a");
  assert.equal(program(TREES.spine3), "a b<-a c<-b");
  assert.equal(program(TREES.fan3), "a b<-a c<-a");
  assert.equal(program(TREES.spine4), "a b<-a c<-b d<-c");
  assert.equal(program(TREES.fan4), "a b<-a c<-a d<-a");
});

test("input order does not change the program — a recording is a set of rects, not a list", () => {
  for (const name of Object.keys(TREES)) {
    const forwards = program(TREES[name]);
    const backwards = program(TREES[name].slice().reverse());
    const rotated = program(TREES[name].slice(1).concat(TREES[name].slice(0, 1)));
    assert.equal(backwards, forwards, name + " reversed");
    assert.equal(rotated, forwards, name + " rotated");
  }
});

test("a single window is a program of one, with nothing to split", () => {
  assert.deepEqual(engine.placementOrderOf([{ key: "a", at: [12, 38], size: [1416, 850] }]),
    [{ key: "a", parentKey: null }]);
});

test("every window appears exactly once, and only the first has no parent", () => {
  for (const name of Object.keys(TREES)) {
    const order = engine.placementOrderOf(TREES[name]);
    assert.equal(order.length, TREES[name].length, name);
    const keys = order.map((o) => o.key).sort();
    assert.deepEqual(keys, TREES[name].map((i) => i.key).sort(), name);
    assert.equal(order[0].parentKey, null, name);
    for (let i = 1; i < order.length; i++) assert.ok(order[i].parentKey, name + " step " + i);
  }
});

test("a parent is always already placed when its child arrives — the pre-order property", () => {
  // This is the whole correctness argument stated as an assertion: a window
  // cannot split a tile that is not on the workspace yet.
  for (const name of Object.keys(TREES)) {
    const order = engine.placementOrderOf(TREES[name]);
    const placed = {};
    for (const step of order) {
      if (step.parentKey) assert.ok(placed[step.parentKey], name + ": " + step.key + " split an absent " + step.parentKey);
      placed[step.key] = true;
    }
  }
});

test("a 2x2 grid is ambiguous and that is fine — either cut lays out the same four rects", () => {
  const grid = [
    { key: "a", at: [12, 38], size: [701, 418] },
    { key: "b", at: [727, 38], size: [701, 418] },
    { key: "c", at: [12, 470], size: [701, 418] },
    { key: "d", at: [727, 470], size: [701, 418] }
  ];
  const order = engine.placementOrderOf(grid);
  assert.ok(order, "a grid is a guillotine layout and must reconstruct");
  assert.equal(order.length, 4);
  // Deterministic: the same input gives the same program every time, which is
  // what stops two passes over one desktop from being two different plans.
  assert.equal(program(grid), program(grid.slice()));
});

test("a zero-gap layout still cuts — the boundary test is <=, not <", () => {
  assert.equal(program([
    { key: "a", at: [0, 0], size: [700, 900] },
    { key: "b", at: [700, 0], size: [700, 900] }
  ]), "a b<-a");
});

test("rects that are not a guillotine partition are a null, never a guess", () => {
  // A pinwheel: four rects that tile a square with no straight line through it.
  assert.equal(engine.placementOrderOf([
    { key: "a", at: [0, 0], size: [60, 40] },
    { key: "b", at: [60, 0], size: [40, 60] },
    { key: "c", at: [40, 60], size: [60, 40] },
    { key: "d", at: [0, 40], size: [40, 60] }
  ]), null);
  // Overlapping rects — two windows claiming the same pixels cannot be a tree.
  assert.equal(engine.placementOrderOf([
    { key: "a", at: [0, 0], size: [100, 100] },
    { key: "b", at: [50, 0], size: [100, 100] }
  ]), null);
});

test("a missing, malformed or zero-area rect is a null, not an exception", () => {
  assert.equal(engine.placementOrderOf([]), null);
  assert.equal(engine.placementOrderOf(null), null);
  assert.equal(engine.placementOrderOf([{ key: "a", at: [0, 0] }, { key: "b", at: [50, 0], size: [10, 10] }]), null);
  assert.equal(engine.placementOrderOf([{ key: "a", at: [0, 0], size: [0, 100] },
    { key: "b", at: [50, 0], size: [10, 10] }]), null);
  assert.equal(engine.placementOrderOf([{ key: "a", at: ["x", 0], size: [10, 10] },
    { key: "b", at: [50, 0], size: [10, 10] }]), null);
});

// ---------------------------------------------------------------------------
// The gate: when planRestore is allowed to use the program
// ---------------------------------------------------------------------------

const MONITORS = [{
  id: 0, name: "eDP-1", description: "Test Panel", make: "T", model: "P", serial: "",
  x: 0, y: 0, width: 1440, height: 900, scale: 1,
  activeWorkspace: { id: 1, name: "1" }, focused: true
}];
const IDS = [
  { id: "one", patterns: ["^app-one$"] },
  { id: "two", patterns: ["^app-two$"] },
  { id: "three", patterns: ["^app-three$"] }
];
const RECT = { one: TREES.spine3[0], two: TREES.spine3[1], three: TREES.spine3[2] };

// A recording of three tiled windows on workspace 5, in the spine3 tree.
function layoutOn(workspaceId, overrides) {
  const apps = ["one", "two", "three"].map((id) => Object.assign({
    identityId: id,
    workspaceId: workspaceId,
    monitorDescription: "Test Panel",
    monitorIndex: 0,
    floating: false,
    group: null,
    at: RECT[id].at.slice(),
    size: RECT[id].size.slice()
  }, (overrides && overrides[id]) || {}));
  return { topologyKey: "Test Panel", recordedAt: "2026-08-16T00:00:00Z", apps: apps };
}

// The three windows, live, all parked on the WRONG workspace (9) — so every one
// of them is planned a move back onto 5. Plus whatever extra clients a case
// wants on the desktop.
function scattered(extra) {
  return [
    makeClient({ address: "0x1", class: "app-one", workspace: 9 }),
    makeClient({ address: "0x2", class: "app-two", workspace: 9 }),
    makeClient({ address: "0x3", class: "app-three", workspace: 9 })
  ].concat(extra || []);
}

function movesOf(plan) {
  return plan.filter((op) => op.kind === "move")
    .map((op) => op.address + (op.splitParent ? "<-" + op.splitParent : ""));
}

test("three windows coming home are ordered into the tree, each naming the tile it splits", () => {
  const plan = engine.planRestore(scattered(), MONITORS, layoutOn(5), IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2<-0x1", "0x3<-0x2"]);
});

test("the order is the TREE's, not the recording's — a recording listed backwards plans the same", () => {
  const layout = layoutOn(5);
  layout.apps.reverse();
  const plan = engine.planRestore(scattered(), MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2<-0x1", "0x3<-0x2"]);
});

test("the fan tree plans a different program from the spine tree, off the rects alone", () => {
  const layout = layoutOn(5, {
    one: { at: TREES.fan3[0].at, size: TREES.fan3[0].size },
    two: { at: TREES.fan3[1].at, size: TREES.fan3[1].size },
    three: { at: TREES.fan3[2].at, size: TREES.fan3[2].size }
  });
  const plan = engine.planRestore(scattered(), MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2<-0x1", "0x3<-0x1"]);
});

test("GATE: one window moving alone is never choreographed — it splits nothing", () => {
  const layout = layoutOn(5);
  const clients = [
    makeClient({ address: "0x1", class: "app-one", workspace: 5, at: RECT.one.at, size: RECT.one.size }),
    makeClient({ address: "0x2", class: "app-two", workspace: 5, at: RECT.two.at, size: RECT.two.size }),
    makeClient({ address: "0x3", class: "app-three", workspace: 9 })
  ];
  const plan = engine.planRestore(clients, MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x3"]);
});

test("GATE: a recorded app that is not running leaves a hole, so nobody is choreographed", () => {
  const layout = layoutOn(5);
  const plan = engine.planRestore(
    [makeClient({ address: "0x1", class: "app-one", workspace: 9 }),
      makeClient({ address: "0x2", class: "app-two", workspace: 9 })],
    MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2"]);
});

test("GATE: a recorded FLOAT on the workspace stands the choreography down", () => {
  const layout = layoutOn(5, { three: { floating: true } });
  const plan = engine.planRestore(scattered(), MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2", "0x3"]);
});

test("GATE: a window recorded tiled but LIVE FLOATING stands the choreography down", () => {
  // Found by tests/property.test.js, not by reasoning, and it is the subtlest
  // of the five: the plan DOES fix this window, with a `floating` op — but that
  // op runs after the moves (tick y29 settled that ordering), so at the moment
  // the choreography runs the window is still a float and holds no tile.
  // Focusing it splits nothing; being it, it takes no slot. Every dispatch
  // would answer "ok".
  const clients = scattered();
  clients[0].floating = true;
  const plan = engine.planRestore(clients, MONITORS, layoutOn(5), IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2", "0x3"]);
  // …and the pass is not wasted: the float op is still there, so the NEXT
  // settle pass plans against a workspace where everybody holds a tile.
  assert.ok(plan.some((op) => op.kind === "floating" && op.address === "0x1"));
});

test("GATE: a stranger already tiled on the destination stands it down — even one we never watch", () => {
  const stranger = makeClient({ address: "0x9", class: "some-app-nobody-watches", workspace: 5 });
  const plan = engine.planRestore(scattered([stranger]), MONITORS, layoutOn(5), IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2", "0x3"]);
});

test("GATE: a FLOAT already on the destination does not stand it down — it takes no tile", () => {
  const drifter = makeClient({ address: "0x9", class: "some-app-nobody-watches", workspace: 5, floating: true });
  const plan = engine.planRestore(scattered([drifter]), MONITORS, layoutOn(5), IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2<-0x1", "0x3<-0x2"]);
});

test("GATE: rects that are not a tree fall back to recorded order, silently and safely", () => {
  const layout = layoutOn(5, {
    one: { at: [0, 0], size: [100, 100] },
    two: { at: [50, 0], size: [100, 100] },
    three: { at: [200, 0], size: [100, 100] }
  });
  const plan = engine.planRestore(scattered(), MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2", "0x3"]);
});

test("GATE: a v1 recording has no rects at all, and plans exactly as it did before this tick", () => {
  const layout = layoutOn(5);
  for (const app of layout.apps) { delete app.at; delete app.size; }
  const plan = engine.planRestore(scattered(), MONITORS, layout, IDS);
  assert.deepEqual(movesOf(plan), ["0x1", "0x2", "0x3"]);
});

test("two workspaces are sequenced independently, and neither leaks a parent into the other", () => {
  const layout = layoutOn(5);
  layout.apps[2].workspaceId = 6;
  layout.apps[2].at = [12, 38];
  layout.apps[2].size = [1416, 850];
  const plan = engine.planRestore(scattered(), MONITORS, layout, IDS);
  // ws 5 keeps its pair and its one split; ws 6 holds one window and gets none.
  assert.deepEqual(movesOf(plan), ["0x1", "0x2<-0x1", "0x3"]);
});

// ---------------------------------------------------------------------------
// What the plan turns into, and what the no-progress check can see
// ---------------------------------------------------------------------------

test("a choreographed move dispatches ONE focus in front of it, at the parent and not the subject", () => {
  const commands = engine.opToCommand({
    kind: "move", address: "0xB", workspaceId: 5, splitParent: "0xA"
  });
  assert.equal(commands.length, 2);
  assert.match(commands[0], /hl\.dsp\.focus\(\{ window = "address:0xA" \}\)/);
  assert.match(commands[1], /hl\.dsp\.window\.move\(\{ window = "address:0xB", workspace = "5", follow = false \}\)/);
});

test("an unchoreographed move dispatches exactly what it always did", () => {
  assert.deepEqual(
    engine.opToCommand({ kind: "move", address: "0xB", workspaceId: 5 }),
    ["hyprctl dispatch 'hl.dsp.window.move({ window = \"address:0xB\", workspace = \"5\", follow = false })'"]);
});

test("the split parent is part of the plan's signature — a different program is a different plan", () => {
  const base = { kind: "move", address: "0xB", workspaceId: 5 };
  const viaA = Object.assign({}, base, { splitParent: "0xA" });
  const viaC = Object.assign({}, base, { splitParent: "0xC" });
  assert.notEqual(engine.opSignature(viaA), engine.opSignature(viaC));
  assert.notEqual(engine.opSignature(viaA), engine.opSignature(base));
  // …and an unchoreographed move signs exactly as it used to, so no existing
  // no-progress diagnosis changes meaning.
  assert.equal(engine.opSignature(base), "move:0xB->5");
  assert.ok(!engine.samePlan([viaA], [viaC]));
});

test("the split parent is named in the sentence the no-progress warning prints", () => {
  assert.equal(
    engine.describeOp({ kind: "move", address: "0xB", workspaceId: 5, splitParent: "0xA" }),
    "move 0xB -> ws 5 (splitting 0xA)");
});

test("a choreographed plan still only ever names addresses the read contained", () => {
  const clients = scattered();
  const plan = engine.planRestore(clients, MONITORS, layoutOn(5), IDS);
  assert.deepEqual(engine.unknownPlanAddresses(plan, clients), []);
  // The parent is an address too, and it is the one a shape-based check would
  // miss — opAddressesOf reads `address`, not `splitParent`.
  for (const op of plan) {
    if (op.splitParent) {
      assert.ok(clients.some((c) => c.address === op.splitParent),
        "splitParent " + op.splitParent + " is not in the read");
    }
  }
});
