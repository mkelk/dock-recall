// Tiled refinement — tick pyo.
//
// Tick 35n put the right windows on the right workspace in the right tree, and
// closed nothing at all for the case the user reported: a redock that re-tiled
// workspace 8 IN PLACE. Nothing had to move, `planRestore` said "nothing to do",
// and the desktop scored 0.782 with every verdict green. Two defects live in
// that gap and they are not the same defect:
//
//   OCCUPANCY  right slots, wrong windows in them  -> `swap`, one dispatch,
//              exact, focus-free
//   RATIO      right windows, dividers in the wrong places -> `divider`, one
//              nudge per plan, read-gated, no-progress stopped
//
// The assertions that matter most in here are the ones about NOT acting: the
// sign law (never the far side of a divider, so two windows can never pull at
// one line in opposite directions), the structural precondition (refinement
// adjusts a tiling, it never builds one) and the cap.
//
// Rects are eDP-1 at 1440x900 logical: usable [12,38] 1416x850, gaps_in 5.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const { makeClient } = require("./helpers.js");

// The 3-window spine tree the or5 probe built, and the same tree with both
// dividers dragged somewhere else — the exact pair § 9 of the state matrix
// measured being repaired in two dispatches.
const RECORDED3 = [
  { key: "a", at: [12, 38], size: [701, 850] },
  { key: "b", at: [727, 38], size: [701, 418] },
  { key: "c", at: [727, 470], size: [701, 418] }
];
const SCRAMBLED3 = [
  { key: "a", at: [12, 38], size: [400, 850] },
  { key: "b", at: [426, 38], size: [1002, 250] },
  { key: "c", at: [426, 302], size: [1002, 586] }
];

function permute(items, mapping) {
  // Same rects, different occupants: `mapping` says which key sits where.
  return items.map((item, i) => ({ key: mapping[i], at: item.at, size: item.size }));
}

// ---------------------------------------------------------------- occupancy

test("two windows in each other's slots are one swap, and no divider at all", () => {
  const recorded = [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [701, 850] }
  ];
  const live = permute(recorded, ["b", "a"]);
  const program = engine.planWorkspaceTiling(recorded, live);
  assert.deepEqual(program.swaps, [{ address: "b", target: "a" }]);
  assert.deepEqual(program.dividers, []);
});

test("the user's ws-8 shape scores 0 before the swap and is a single dispatch to fix", () => {
  const recorded = [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [701, 850] }
  ];
  const live = permute(recorded, ["b", "a"]);
  // Two identical-size windows that traded places share no pixels at all.
  assert.equal(engine.rectIou(recorded[0], live.find((i) => i.key === "a")), 0);
  const program = engine.planWorkspaceTiling(recorded, live);
  assert.equal(program.swaps.length, 1);
});

test("a three-cycle is two swaps, and the program is correct run start to finish", () => {
  const live = permute(RECORDED3, ["b", "c", "a"]);
  const program = engine.planWorkspaceTiling(RECORDED3, live);
  assert.equal(program.swaps.length, 2);

  // Run the program against the slots and check everybody ends up home. A swap
  // exchanges exactly two rects, which is what makes this simulation the same
  // arithmetic the compositor does.
  const where = {};
  for (const item of live) where[item.key] = { at: item.at, size: item.size };
  for (const swap of program.swaps) {
    const t = where[swap.address];
    where[swap.address] = where[swap.target];
    where[swap.target] = t;
  }
  for (const want of RECORDED3) {
    assert.deepEqual(where[want.key].at, want.at, want.key + " at");
    assert.deepEqual(where[want.key].size, want.size, want.key + " size");
  }
});

test("a tiling that is already right plans nothing at all", () => {
  assert.equal(engine.planWorkspaceTiling(RECORDED3, RECORDED3.map((i) => ({ ...i }))), null);
});

test("a self-swap is never planned, and never dispatched if one were", () => {
  const program = engine.planWorkspaceTiling(RECORDED3, permute(RECORDED3, ["b", "a", "c"]));
  for (const swap of program.swaps) assert.notEqual(swap.address, swap.target);
  assert.deepEqual(engine.opToCommand({ kind: "swap", address: "0xa", target: "0xa" }), []);
  assert.deepEqual(engine.opToCommand({ kind: "swap", address: "0xa" }), []);
});

test("the swap dispatch names BOTH windows and uses target, never direction", () => {
  const commands = engine.opToCommand({ kind: "swap", address: "0xa", target: "0xb" });
  assert.deepEqual(commands, [
    'hyprctl dispatch \'hl.dsp.window.swap({ window = "address:0xa", target = "address:0xb" })\''
  ]);
  // `direction` resolves from the ACTIVE window and not from the selector
  // (or5 § 7), so a restore using it would swap whatever the user is looking at.
  assert.ok(commands[0].indexOf("direction") === -1);
});

test("a swap names two windows, and every consumer sees both", () => {
  const op = { kind: "swap", address: "0xa", target: "0xb" };
  assert.deepEqual(engine.opAddressesOf(op), ["0xa", "0xb"]);
  assert.equal(engine.opSubjectOf(op), "0xa+0xb");
  // The snapshot invariant has to be able to catch a swap naming a window the
  // read did not contain — which is the whole reason `target` is in the shape.
  assert.deepEqual(engine.unknownPlanAddresses([op], [makeClient({ address: "0xa" })]), ["0xb"]);
});

// -------------------------------------------------------------------- ratios

test("a scrambled two-divider tree is repaired one nudge at a time, outer first", () => {
  // Exactly the sequence docs/state-matrix.md § Tiled placement § 9 measured.
  const first = engine.planWorkspaceTiling(RECORDED3, SCRAMBLED3);
  assert.deepEqual(first.swaps, []);
  assert.equal(first.dividers.length, 1, "one nudge per plan");
  assert.equal(first.dividers[0].address, "a", "the OUTER divider first — 'a' sits against it");
  assert.equal(first.dividers[0].axis, 0);
  assert.equal(first.dividers[0].size[0], 701);

  // After that nudge the compositor gives 'a' its 701 and hands the rest to the
  // far side, which is what or5 measured. The next plan takes the inner cut.
  const afterOuter = [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [701, 250] },
    { key: "c", at: [727, 302], size: [701, 586] }
  ];
  const second = engine.planWorkspaceTiling(RECORDED3, afterOuter);
  assert.equal(second.dividers.length, 1);
  assert.equal(second.dividers[0].address, "b", "the inner cut, from its TOP side");
  assert.equal(second.dividers[0].axis, 1);
  assert.equal(second.dividers[0].size[1], 418);

  // And then it is done.
  assert.equal(engine.planWorkspaceTiling(RECORDED3, RECORDED3.map((i) => ({ ...i }))), null);
});

test("THE SIGN LAW: the far side of a divider is never nudged, so nothing can fight", () => {
  // 'b' is the right-hand window: its far edge on x IS the edge of the tiling,
  // so a resize at it lands on 2*current - asked and walks AWAY from the target
  // (or5 § 8, measured). Both windows are the wrong width here — the classic
  // two-windows-one-divider fight — and only the left one may be asked.
  const recorded = [
    { key: "a", at: [12, 38], size: [900, 850] },
    { key: "b", at: [926, 38], size: [502, 850] }
  ];
  const live = [
    { key: "a", at: [12, 38], size: [500, 850] },
    { key: "b", at: [526, 38], size: [902, 850] }
  ];
  const program = engine.planWorkspaceTiling(recorded, live);
  assert.equal(program.dividers.length, 1);
  assert.equal(program.dividers[0].address, "a", "only the LEFT child of the divider");
  assert.equal(program.dividers[0].size[0], 900);

  // And the fix for one is the fix for both: after 'a' lands on 900 the
  // compositor has handed 'b' its 502, so there is nothing left to ask for.
  assert.equal(engine.planWorkspaceTiling(recorded, recorded.map((i) => ({ ...i }))), null);
});

test("SIGN LAW: touching a divider is not the same as being able to push it", () => {
  // The regression that a live round found and no amount of reading the rects
  // would have. This is the probe's 4-window "fan" tree: window `d` sits in the
  // top row, and its far edge on x really does touch the ROOT divider, with `b`
  // immediately beyond it. Resizing `d` does NOT move the root divider —
  // Hyprland walks up to the NEAREST split of that orientation, which is the
  // little one `d` shares with `a` — and on that one `d` is the FAR child, so
  // the ask comes back mirrored. Measured live: 472 asked for 341 became 603,
  // and the workspace went from 0.622 to 0.552.
  const recorded = [
    { key: "a", at: [12, 38], size: [346, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] },
    { key: "d", at: [372, 38], size: [341, 418] }
  ];
  const live = [
    { key: "a", at: [12, 38], size: [215, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] },
    { key: "d", at: [241, 38], size: [472, 418] }
  ];
  const program = engine.planWorkspaceTiling(recorded, live);
  assert.equal(program.dividers.length, 1);
  assert.equal(program.dividers[0].address, "a",
    "the LEFT child of the split that actually moves, never the one merely touching the root divider");
  assert.equal(program.dividers[0].axis, 0);
  assert.equal(program.dividers[0].size[0], 346);
});

test("NO OSCILLATION: a target the divider cannot reach is asked for once and then stopped", () => {
  // 62 px is the minimum tile width this compositor will give (or5 § 8: asked
  // for 30 it answers "ok" and gives 62). A recording made at a width the
  // divider can no longer reach — a smaller monitor, say — asks once.
  const recorded = [
    { key: "a", at: [12, 38], size: [30, 850] },
    { key: "b", at: [46, 38], size: [1382, 850] }
  ];
  const clamped = [
    { key: "a", at: [12, 38], size: [62, 850] },
    { key: "b", at: [78, 38], size: [1350, 850] }
  ];
  const first = engine.planWorkspaceTiling(recorded, clamped);
  assert.equal(first.dividers.length, 1);
  assert.equal(first.dividers[0].size[0], 30);

  // The planner is stateless, so on its own it WOULD ask again — and the two
  // things that stop it are both real. The op's signature is identical, so
  // engine.samePlan ends the pass; and the service's confirm read sees a rect
  // that did not change at all and fails the op with that sentence
  // (Service.executeDivider). Here is the first half, which is the half a pure
  // test can hold:
  const again = engine.planWorkspaceTiling(recorded, clamped);
  assert.ok(engine.samePlan(
    [{ kind: "divider", address: first.dividers[0].address, axis: 0, size: first.dividers[0].size }],
    [{ kind: "divider", address: again.dividers[0].address, axis: 0, size: again.dividers[0].size }]));
});

test("the divider signature is the axis and the target, not the size pair", () => {
  // The other axis is a snapshot that changes whenever a neighbouring divider
  // moves. If it were in the signature, an op being ignored would look like a
  // NEW op on every iteration and the no-progress check would never fire.
  const a = { kind: "divider", address: "0xa", axis: 0, size: [700, 850] };
  const b = { kind: "divider", address: "0xa", axis: 0, size: [700, 400] };
  assert.equal(engine.opSignature(a), engine.opSignature(b));
  assert.notEqual(engine.opSignature(a), engine.opSignature({ ...a, size: [701, 850] }));
  assert.equal(engine.describeOp(a), "divider 0xa width -> 700");
  assert.equal(engine.describeOp({ ...a, axis: 1 }), "divider 0xa height -> 850");
});

test("the divider dispatch carries both axes, because the dispatcher demands both", () => {
  assert.deepEqual(engine.opToCommand({ kind: "divider", address: "0xa", axis: 0, size: [700, 850] }),
    ['hyprctl dispatch \'hl.dsp.window.resize({ window = "address:0xa", x = 700, y = 850 })\'']);
  // A size that is not a rect is never dispatched — the same rule the float
  // geometry op has, for the same reason: it cannot be satisfied, so it would
  // re-plan for ever.
  assert.deepEqual(engine.opToCommand({ kind: "divider", address: "0xa", axis: 0, size: [0, 850] }), []);
  assert.deepEqual(engine.opToCommand({ kind: "divider", address: "0xa", axis: 0, size: [700] }), []);
});

test("a workspace already within the stated threshold is left completely alone", () => {
  // 0.95 mean IoU is the documented stop. A divider a couple of pixels off is
  // inside it, and nudging it for ever on every dock event would be the tool
  // fidgeting.
  const nearly = [
    { key: "a", at: [12, 38], size: [703, 850] },
    { key: "b", at: [729, 38], size: [699, 418] },
    { key: "c", at: [729, 470], size: [699, 418] }
  ];
  assert.ok(engine.TILED_REFINEMENT_TARGET_IOU === 0.95);
  assert.equal(engine.planWorkspaceTiling(RECORDED3, nearly), null);
});

// ------------------------------------------------------------ what it refuses

test("refinement adjusts a tiling, it never builds one: a different SHAPE is refused", () => {
  // The fan tree and the spine tree lay out the same three windows in
  // structurally different trees. No sequence of divider moves turns one into
  // the other — a resize moves lines, it does not re-parent them — so this must
  // plan nothing rather than burn a pass distorting a layout it cannot fix.
  const fan = [
    { key: "a", at: [12, 38], size: [701, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] }
  ];
  assert.equal(engine.planWorkspaceTiling(RECORDED3, fan), null);
});

test("rects that are not a tree at all are refused, on either side", () => {
  const pinwheel = [
    { key: "a", at: [0, 0], size: [60, 40] },
    { key: "b", at: [60, 0], size: [40, 60] },
    { key: "c", at: [40, 60], size: [60, 40] }
  ];
  assert.equal(engine.planWorkspaceTiling(RECORDED3, pinwheel), null);
  assert.equal(engine.planWorkspaceTiling(pinwheel, RECORDED3), null);
});

test("a window that is on one side and not the other is refused", () => {
  const stranger = SCRAMBLED3.map((i) => ({ ...i }));
  stranger[2].key = "z";
  assert.equal(engine.planWorkspaceTiling(RECORDED3, stranger), null);
  assert.equal(engine.planWorkspaceTiling(RECORDED3, SCRAMBLED3.slice(0, 2)), null);
  assert.equal(engine.planWorkspaceTiling([RECORDED3[0]], [SCRAMBLED3[0]]), null);
});

// -------------------------------------------------- through the whole planner

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

function layout3(rects) {
  return {
    topologyKey: "Test Panel",
    recordedAt: "2026-08-16T00:00:00Z",
    apps: ["one", "two", "three"].map((id, i) => ({
      identityId: id, workspaceId: 5, monitorDescription: "Test Panel", monitorIndex: 0,
      floating: false, group: null, at: rects[i].at.slice(), size: rects[i].size.slice()
    }))
  };
}
function clients3(rects, extra) {
  return ["app-one", "app-two", "app-three"].map((cls, i) => makeClient({
    address: "0x" + (i + 1), class: cls, workspace: 5, at: rects[i].at.slice(), size: rects[i].size.slice()
  })).concat(extra || []);
}
const RECORDED_RECTS = RECORDED3.map((i) => ({ at: i.at, size: i.size }));

test("the ws-8 case end to end: a plan that used to be empty is now one swap", () => {
  // Windows one and two have traded slots and nothing else is wrong. Before
  // this tick planRestore returned [] for exactly this desktop.
  const live = clients3([RECORDED3[1], RECORDED3[0], RECORDED3[2]].map((i) => ({ at: i.at, size: i.size })));
  const plan = engine.planRestore(live, MONITORS, layout3(RECORDED_RECTS), IDS);
  assert.deepEqual(plan.map((op) => op.kind), ["swap"]);
  assert.deepEqual(engine.opAddressesOf(plan[0]).sort(), ["0x1", "0x2"]);
  // Nothing else in the plan: no move, no float, no geometry. The workspace is
  // right in every dimension the tool grades.
  assert.deepEqual(engine.driftOf(live, MONITORS, layout3(RECORDED_RECTS), IDS)
    .apps.map((a) => a.drift.workspace || a.drift.monitor || a.drift.floating), [false, false, false]);
});

test("swaps come before nudges across the whole plan, never interleaved", () => {
  const scrambledAndSwapped = [SCRAMBLED3[1], SCRAMBLED3[0], SCRAMBLED3[2]].map((i) => ({ at: i.at, size: i.size }));
  const plan = engine.planRestore(clients3(scrambledAndSwapped), MONITORS, layout3(RECORDED_RECTS), IDS);
  const kinds = plan.map((op) => op.kind);
  assert.ok(kinds.indexOf("swap") >= 0 && kinds.indexOf("divider") >= 0, JSON.stringify(kinds));
  assert.ok(kinds.lastIndexOf("swap") < kinds.indexOf("divider"),
    "a swap exchanges whole rects, so who-is-where is settled before where-the-lines-are: " + kinds);
});

test("a converged desktop still plans nothing — refinement costs a settled desktop zero ops", () => {
  assert.deepEqual(
    engine.planRestore(clients3(RECORDED_RECTS), MONITORS, layout3(RECORDED_RECTS), IDS), []);
});

test("GATE: a pending move means the tiling is about to change, so nothing is refined", () => {
  const live = clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size })));
  live[2].workspace = { id: 9, name: "9" };
  const plan = engine.planRestore(live, MONITORS, layout3(RECORDED_RECTS), IDS);
  assert.deepEqual(plan.map((op) => op.kind), ["move"]);
});

test("GATE: a stranger holding a tile means the recorded rects are unreachable", () => {
  const stranger = makeClient({ address: "0x9", class: "nobody-watches-this", workspace: 5 });
  const plan = engine.planRestore(
    clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size })), [stranger]),
    MONITORS, layout3(RECORDED_RECTS), IDS);
  assert.deepEqual(plan, []);
});

test("GATE: a live float on the workspace takes no tile and does not stand refinement down", () => {
  const drifter = makeClient({ address: "0x9", class: "nobody-watches-this", workspace: 5, floating: true });
  const plan = engine.planRestore(
    clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size })), [drifter]),
    MONITORS, layout3(RECORDED_RECTS), IDS);
  assert.deepEqual(plan.map((op) => op.kind), ["divider"]);
});

test("GATE: a recorded float on the workspace stands refinement down entirely", () => {
  const layout = layout3(RECORDED_RECTS);
  layout.apps[2].floating = true;
  const live = clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size })));
  live[2].floating = true;
  const plan = engine.planRestore(live, MONITORS, layout, IDS);
  assert.ok(plan.every((op) => op.kind !== "divider" && op.kind !== "swap"), JSON.stringify(plan));
});

test("GATE: a v1 recording carries no rects, so nothing is ever refined from one", () => {
  const layout = layout3(RECORDED_RECTS);
  for (const app of layout.apps) { delete app.at; delete app.size; }
  assert.deepEqual(
    engine.planRestore(clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size }))), MONITORS, layout, IDS),
    []);
});

test("refinement moves no verdict: tiled stays measured, never graded", () => {
  // The whole point of the split the state matrix draws. A workspace that is
  // being refined must still read `ok` on every dimension the tool grades, and
  // scripts/verify's exit code must not move — otherwise a tiling nobody can
  // command becomes a red gate.
  const live = clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size })));
  const layout = layout3(RECORDED_RECTS);
  const report = engine.driftOf(live, MONITORS, layout, IDS);
  const verdicts = engine.verdictsFor(report, []);
  for (const verdict of verdicts) {
    assert.equal(verdict.ok, true, verdict.identityId + " must not be graded down for a tiled rect");
    assert.equal(verdict.geometry, "scored");
  }
  assert.equal(report.summary.drifted, 0);
  // …while the plan is nonetheless doing something about it.
  assert.ok(engine.planRestore(live, MONITORS, layout, IDS).length > 0);
});

// ======================================================================
// Tick eqb — the ambiguity refusal, the choreography contract, and the
// refinement's own iteration budget.
// ======================================================================

// ------------------------------------------------------- ambiguity refusal
//
// The defect this closes is not a wrong number, it is a wrong DISPATCH. Rects
// alone do not always name one dwindle tree: three columns side by side are
// `(a|b)|c` and `a|(b|c)` at once, and a 2×2 grid is "vertical first" and
// "horizontal first" at once. splitTreeOf takes the first cut it finds, which
// is correct for BUILDING a workspace from empty (every valid tree lays out the
// same rects) and is a guess when REFINING one — the sign law is read off the
// reconstruction, so if the compositor holds the other tree the nudge lands on
// the wrong divider from the wrong side and moves it 2 × current − asked. On a
// workspace this project's ceiling promises to leave alone.

const THREE_COLUMNS = [
  { key: "a", at: [12, 38], size: [464, 850] },
  { key: "b", at: [482, 38], size: [464, 850] },
  { key: "c", at: [952, 38], size: [476, 850] }
];

const GRID_2X2 = [
  { key: "a", at: [12, 38], size: [701, 418] },
  { key: "b", at: [727, 38], size: [701, 418] },
  { key: "c", at: [12, 470], size: [701, 418] },
  { key: "d", at: [727, 470], size: [701, 418] }
];

test("three columns fit two trees, and refinement says so instead of guessing", () => {
  assert.equal(engine.layoutIsAmbiguous(THREE_COLUMNS), true);
  const scrambled = [
    { key: "a", at: [12, 38], size: [300, 850] },
    { key: "b", at: [318, 38], size: [628, 850] },
    { key: "c", at: [952, 38], size: [476, 850] }
  ];
  assert.equal(engine.tilingRefusalOf(THREE_COLUMNS, scrambled), engine.TILING_REFUSAL_AMBIGUOUS);

  const refusal = {};
  assert.equal(engine.planWorkspaceTiling(THREE_COLUMNS, scrambled, refusal), null);
  assert.equal(refusal.reason, "ambiguous-tree");
  // The reason is a sentence somewhere, not only a word: the log line, the
  // verify row and the panel all print through this.
  assert.ok(engine.tilingRefusalPhrase("ambiguous-tree").indexOf("more than one split tree") >= 0);
});

test("a 2x2 grid is ambiguous too, and it is ambiguous in the OTHER way", () => {
  // Three columns are two trees on ONE axis; a grid is one tree per axis. Both
  // have to be caught, and the guard counts cuts across both axes for exactly
  // this reason.
  assert.equal(engine.layoutIsAmbiguous(GRID_2X2), true);
  assert.equal(engine.planWorkspaceTiling(GRID_2X2, GRID_2X2.map((i) => ({ ...i }))), null,
    "an already-right grid plans nothing anyway");
  // …and a grid that is WRONG is refused rather than nudged, which is the case
  // that would otherwise have dispatched at a divider chosen by a coin toss.
  const refusal = {};
  const live = [
    { key: "a", at: [12, 38], size: [500, 418] },
    { key: "b", at: [526, 38], size: [902, 418] },
    { key: "c", at: [12, 470], size: [500, 418] },
    { key: "d", at: [526, 470], size: [902, 418] }
  ];
  assert.equal(engine.planWorkspaceTiling(GRID_2X2, live, refusal), null);
  assert.equal(refusal.reason, "ambiguous-tree");
});

test("the unambiguous shapes still refine — the guard is a scalpel, not a shutdown", () => {
  // The two trees the whole epic is built on: the spine and the fan. If the
  // ambiguity guard caught either of these, tick pyo's 60-for-60 would be gone.
  assert.equal(engine.layoutIsAmbiguous(RECORDED3), false);
  assert.equal(engine.layoutIsAmbiguous(SCRAMBLED3), false);
  const program = engine.planWorkspaceTiling(RECORDED3, SCRAMBLED3);
  assert.equal(program.dividers.length, 1);
  assert.equal(program.dividers[0].address, "a");
  const fan = [
    { key: "a", at: [12, 38], size: [346, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] },
    { key: "d", at: [372, 38], size: [341, 418] }
  ];
  assert.equal(engine.layoutIsAmbiguous(fan), false);
  // Two windows can never be ambiguous: one cut, one axis, one tree.
  assert.equal(engine.layoutIsAmbiguous(RECORDED3.slice(0, 2)), false);
});

test("'not a tree' and 'ambiguous' are different refusals, and keep their own words", () => {
  // A real pinwheel — five rects, no straight line anywhere through the whole
  // set. (The three-rect "pinwheel" the older test uses IS separable, at the
  // line y = 60; a guillotine cut asks only whether the two sides are on
  // opposite sides of one line, not whether they tile their box.)
  const pinwheel = [
    { key: "a", at: [0, 0], size: [60, 40] },
    { key: "b", at: [60, 0], size: [40, 60] },
    { key: "c", at: [40, 60], size: [60, 40] },
    { key: "d", at: [0, 40], size: [40, 60] },
    { key: "e", at: [40, 40], size: [20, 20] }
  ];
  assert.equal(engine.splitTreeOf(pinwheel), null);
  assert.equal(engine.tilingRefusalOf(pinwheel, pinwheel.map((i) => ({ ...i }))),
    engine.TILING_REFUSAL_NOT_A_TREE);
  const fan = [
    { key: "a", at: [12, 38], size: [701, 418] },
    { key: "b", at: [727, 38], size: [701, 850] },
    { key: "c", at: [12, 470], size: [701, 418] }
  ];
  assert.equal(engine.tilingRefusalOf(RECORDED3, fan), engine.TILING_REFUSAL_DIFFERENT_SHAPE);
  // Nothing to refine is not a refusal: one window, or two sets of different
  // sizes (a workspace mid-restore), answer null and get asked again.
  assert.equal(engine.tilingRefusalOf([RECORDED3[0]], [RECORDED3[0]]), null);
  assert.equal(engine.tilingRefusalOf(RECORDED3, RECORDED3.slice(0, 2)), null);
});

// ------------------------------------ the refusal, all the way to the reader

function layoutN(rects, ids, workspaceId) {
  return {
    topologyKey: "Test Panel",
    recordedAt: "2026-08-16T00:00:00Z",
    apps: ids.map((id, i) => ({
      identityId: id, workspaceId: workspaceId || 5, monitorDescription: "Test Panel",
      monitorIndex: 0, floating: false, group: null,
      at: rects[i].at.slice(), size: rects[i].size.slice()
    }))
  };
}

function clientsN(rects, classes, workspaceId) {
  return classes.map((cls, i) => makeClient({
    address: "0x" + (i + 1), class: cls, workspace: workspaceId || 5,
    at: rects[i].at.slice(), size: rects[i].size.slice()
  }));
}

test("an ambiguous workspace plans NOTHING through the whole planner", () => {
  const recorded = THREE_COLUMNS.map((i) => ({ at: i.at, size: i.size }));
  const live = [
    { at: [12, 38], size: [300, 850] },
    { at: [318, 38], size: [628, 850] },
    { at: [952, 38], size: [476, 850] }
  ];
  const layout = layoutN(recorded, ["one", "two", "three"]);
  const plan = engine.planRestore(
    clientsN(live, ["app-one", "app-two", "app-three"]), MONITORS, layout, IDS);
  assert.deepEqual(plan, [], "no divider, no swap, no dispatch at a divider nobody can name");
});

test("the refusal reaches the report, the workspace row and the app's own detail", () => {
  const recorded = THREE_COLUMNS.map((i) => ({ at: i.at, size: i.size }));
  const live = [
    { at: [12, 38], size: [300, 850] },
    { at: [318, 38], size: [628, 850] },
    { at: [952, 38], size: [476, 850] }
  ];
  const report = engine.driftOf(
    clientsN(live, ["app-one", "app-two", "app-three"]), MONITORS,
    layoutN(recorded, ["one", "two", "three"]), IDS);

  assert.deepEqual(report.tilingRefusals, [
    { workspaceId: 5, monitorDescription: "Test Panel", reason: "ambiguous-tree" }
  ]);
  assert.equal(report.geometry.workspaces.length, 1);
  assert.equal(report.geometry.workspaces[0].refinement, "ambiguous-tree");
  for (const app of report.apps) {
    assert.equal(app.geometry.refinement, "ambiguous-tree", app.identityId);
  }
  // …and it is still not a verdict. A refusal explains a number; it does not
  // grade a desktop down, and scripts/verify's exit code must not move.
  for (const verdict of engine.verdictsFor(report, [])) assert.equal(verdict.ok, true);
});

test("a workspace that CAN be refined carries no refusal at all", () => {
  const report = engine.driftOf(
    clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size }))),
    MONITORS, layout3(RECORDED_RECTS), IDS);
  assert.deepEqual(report.tilingRefusals, []);
  assert.equal(report.geometry.workspaces[0].refinement, null);
  for (const app of report.apps) assert.equal(app.geometry.refinement, null);
});

test("a workspace nobody ASKED about reports no refusal — not-yet is not refused", () => {
  // A pending move means the tiling is about to change. The gate holds the
  // question back entirely, and a report that said "refused" here would be
  // describing a workspace the next iteration is about to fix.
  const live = clients3(SCRAMBLED3.map((i) => ({ at: i.at, size: i.size })));
  live[2].workspace = { id: 9, name: "9" };
  const report = engine.driftOf(live, MONITORS, layout3(RECORDED_RECTS), IDS);
  assert.deepEqual(report.tilingRefusals, []);
});

test("PLACEMENT is ambiguity-safe, and keeps its choreography on an ambiguous layout", () => {
  // The distinction the whole guard rests on: building from empty is judged by
  // the rects it produces, and every valid tree produces these. So an ambiguous
  // recording is still ordered and still stamped with split parents — refusing
  // it would throw away tick 35n's 1.000 for a risk that does not exist here.
  const order = engine.placementOrderOf(THREE_COLUMNS);
  assert.equal(order.length, 3);
  assert.equal(order[0].parentKey, null);

  const recorded = THREE_COLUMNS.map((i) => ({ at: i.at, size: i.size }));
  const away = clientsN(recorded, ["app-one", "app-two", "app-three"], 9);
  const plan = engine.planRestore(away, MONITORS, layoutN(recorded, ["one", "two", "three"]), IDS);
  assert.deepEqual(plan.map((op) => op.kind), ["move", "move", "move"]);
  assert.equal(plan.filter((op) => op.splitParent).length, 2,
    "two of the three arrivals name the tile they split");
});

// --------------------------------------------- the choreography's contract
//
// Service.qml reads the focus dispatch off the FRONT of a choreographed move's
// command list (`i === 0`), verifies it landed with a read of `activewindow`,
// and stands the shape down for that workspace when it did not. That indexing
// is a contract between two files, and this is the half a pure test can hold.

test("a choreographed move puts its focus FIRST and its move second, always", () => {
  const commands = engine.opToCommand({
    kind: "move", address: "0xb", workspaceId: 7, monitorDescription: "Test Panel",
    splitParent: "0xa"
  });
  assert.equal(commands.length, 2);
  assert.ok(commands[0].indexOf('hl.dsp.focus({ window = "address:0xa" })') >= 0,
    "the focus at the split parent, and it is command 0: " + commands[0]);
  assert.ok(commands[1].indexOf("hl.dsp.window.move") >= 0, commands[1]);
});

test("a plain move dispatches no focus, so there is nothing to verify or hand back", () => {
  const commands = engine.opToCommand({
    kind: "move", address: "0xb", workspaceId: 7, monitorDescription: "Test Panel"
  });
  assert.equal(commands.length, 1);
  assert.ok(commands[0].indexOf("hl.dsp.focus") === -1, commands[0]);
});

// ------------------------------------------------ the refinement's own budget
//
// A dwindle tree of n windows has n − 1 cuts and the planner emits ONE divider
// nudge per workspace per plan, so a seven-window workspace needs six
// plan/execute iterations — every one of them progress. Service.maxIterations
// is 5, and before tick eqb those six spent that budget: the pass warned
// GIVE-UP and counted a failure on iteration six, the cycle converged on its
// next settle pass anyway, and the user got "1 failed" for a restore that
// worked. The fix is a second budget, and this is the fixture that proves the
// first one is the wrong instrument for this work.

// A zero-gap spine tiling: each cut takes `ratio` of the box and alternates
// axis, which is a tree of n − 1 cuts and exactly one valid cut at every node.
function spineTiling(count, box, ratio) {
  const out = [];
  let at = box.at.slice();
  let size = box.size.slice();
  for (let i = 0; i < count - 1; i++) {
    const axis = i % 2;
    const near = Math.max(40, Math.round(size[axis] * ratio));
    const leafAt = at.slice();
    const leafSize = size.slice();
    leafSize[axis] = near;
    out.push({ key: "0x" + (i + 1), at: leafAt, size: leafSize });
    at = at.slice();
    at[axis] += near;
    size = size.slice();
    size[axis] -= near;
  }
  out.push({ key: "0x" + count, at: at, size: size });
  return out;
}

// The compositor's own arithmetic for a divider move, on a tree rather than on
// a pair of rects: find the nearest same-axis ancestor of the subject, set the
// near side to the asked-for extent, and RESCALE both subtrees into their new
// boxes. That last part is what the property test's simulator cannot do and
// what makes this fixture worth having — a nudge here disturbs everything under
// the divider it moves, exactly as or5 § 8 measured.
function boxOfKeys(keys, byKey) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const key of keys) {
    const r = byKey[key];
    x0 = Math.min(x0, r.at[0]); y0 = Math.min(y0, r.at[1]);
    x1 = Math.max(x1, r.at[0] + r.size[0]); y1 = Math.max(y1, r.at[1] + r.size[1]);
  }
  return { at: [x0, y0], size: [x1 - x0, y1 - y0] };
}

function leavesOf(node, acc) {
  const out = acc || [];
  if (!node) return out;
  if (node.key !== undefined) { out.push(node.key); return out; }
  leavesOf(node.near, out);
  leavesOf(node.far, out);
  return out;
}

function applyDividerToTiling(items, op) {
  const byKey = {};
  for (const item of items) byKey[item.key] = { key: item.key, at: item.at.slice(), size: item.size.slice() };
  const tree = engine.splitTreeOf(items);
  assert.ok(tree, "the fixture stopped being a tiling");

  const axis = op.axis;
  let node = tree;
  let target = null;
  while (node && node.key === undefined) {
    const inNear = leavesOf(node.near).indexOf(op.address) >= 0;
    if (node.axis === axis) target = node;
    node = inNear ? node.near : node.far;
  }
  // No same-axis ancestor: the compositor answers "ok" and nothing moves.
  if (!target) return Object.keys(byKey).map((k) => byKey[k]);

  const nearKeys = leavesOf(target.near);
  const farKeys = leavesOf(target.far);
  const nearBox = boxOfKeys(nearKeys, byKey);
  const farBox = boxOfKeys(farKeys, byKey);
  const total = nearBox.size[axis] + farBox.size[axis];
  const wanted = Math.max(40, Math.min(total - 40, op.size[axis]));      // the compositor's silent clamp
  const scaleInto = (keys, oldBox, newStart, newExtent) => {
    const factor = newExtent / oldBox.size[axis];
    for (const key of keys) {
      const r = byKey[key];
      r.at[axis] = Math.round(newStart + (r.at[axis] - oldBox.at[axis]) * factor);
      r.size[axis] = Math.round(r.size[axis] * factor);
    }
    // Re-seal the seams rounding may have opened: a tiling with a 1 px hole in
    // it is not a tiling, and the guillotine test is exact.
    const sorted = keys.slice().sort((a, b) => byKey[a].at[axis] - byKey[b].at[axis]);
    for (const key of sorted) {
      const r = byKey[key];
      if (r.at[axis] < newStart) { r.size[axis] -= newStart - r.at[axis]; r.at[axis] = newStart; }
      const overshoot = r.at[axis] + r.size[axis] - (newStart + newExtent);
      if (overshoot > 0) r.size[axis] -= overshoot;
    }
  };
  scaleInto(nearKeys, nearBox, nearBox.at[axis], wanted);
  scaleInto(farKeys, farBox, nearBox.at[axis] + wanted, total - wanted);
  return items.map((i) => byKey[i.key]);
}

test("a 7-window workspace converges past the general iteration cap, with no failure", () => {
  const BOX = { at: [0, 0], size: [1400, 840] };
  const recorded = spineTiling(7, BOX, 0.5);
  const live = spineTiling(7, BOX, 0.35);
  assert.equal(engine.layoutIsAmbiguous(recorded), false, "the fixture must be one tree");
  assert.equal(engine.layoutIsAmbiguous(live), false);
  let current = live.map((i) => ({ key: i.key, at: i.at.slice(), size: i.size.slice() }));
  let iterations = 0;
  let lastSignature = "";
  for (; iterations < 40; iterations++) {
    const program = engine.planWorkspaceTiling(recorded, current);
    if (!program) break;
    assert.equal(program.swaps.length, 0, "nobody changed places, so nothing may be swapped");
    assert.equal(program.dividers.length, 1, "one nudge per workspace per plan");
    const op = { kind: "divider", address: program.dividers[0].address,
      axis: program.dividers[0].axis, size: program.dividers[0].size };
    // The no-progress check, which is the OTHER half of the discipline: a
    // converging refinement must never re-issue the plan it just ran.
    const signature = engine.planSignature([op]);
    assert.notEqual(signature, lastSignature,
      "iteration " + iterations + " re-planned the identical op — that is a stall, not a budget");
    lastSignature = signature;
    // Every one of these plans is a REFINEMENT plan, which is what makes them
    // the refinement budget's business and not the general cap's.
    assert.equal(engine.isRefinementPlan([op]), true);
    current = applyDividerToTiling(current, op);
  }

  // The two halves of the fix, as this file can hold them: the work exceeds the
  // GENERAL cap (Service.maxIterations, 5) and stays inside the REFINEMENT one
  // (Service counts these iterations against TILED_REFINEMENT_MAX_NUDGES
  // instead, because every plan above answered true to isRefinementPlan). A
  // cycle made of these iterations therefore ends by converging rather than by
  // giving up, and counts no failure on the way.
  assert.ok(iterations > 5,
    "the fixture has to actually exceed maxIterations, or it proves nothing — took " + iterations);
  assert.ok(iterations <= engine.TILED_REFINEMENT_MAX_NUDGES,
    "…and stay inside the budget that replaced it — took " + iterations);
  assert.equal(engine.planWorkspaceTiling(recorded, current), null, "it converged");
});

test("a plan is only the refinement's business when it is ALL refinement", () => {
  assert.equal(engine.isRefinementPlan([{ kind: "divider" }, { kind: "swap" }]), true);
  // One move in the plan and the pass is doing ordinary restore work again: a
  // refinement op riding along must not buy the rest of the plan iterations.
  assert.equal(engine.isRefinementPlan([{ kind: "divider" }, { kind: "move" }]), false);
  assert.equal(engine.isRefinementPlan([{ kind: "launch" }]), false);
  // An empty plan is a converged desktop, and the caller has already stopped.
  assert.equal(engine.isRefinementPlan([]), false);
  assert.equal(engine.isRefinementPlan(null), false);
});

test("a SETTLED workspace reports no refusal, while the planner still refuses it", () => {
  // Found on the first live read of this feature, on the user's own desktop:
  // workspace 10 holds a four-window TAB GROUP, which is four identical rects —
  // not a guillotine tiling — sitting at IoU 1.000 with nothing to fix. The
  // planner refuses it and always did; the REPORT must not print "refinement
  // refused" beside a perfect row, or the ceiling becomes noise nobody reads.
  const tabbed = [
    { key: "0x1", at: [12, 38], size: [1416, 850] },
    { key: "0x2", at: [12, 38], size: [1416, 850] },
    { key: "0x3", at: [12, 38], size: [1416, 850] }
  ];
  assert.equal(engine.tilingSettled(tabbed, tabbed.map((i) => ({ ...i }))), true);
  assert.equal(engine.tilingRefusalOf(tabbed, tabbed.map((i) => ({ ...i }))),
    engine.TILING_REFUSAL_NOT_A_TREE, "the planner's answer does not change");

  const recorded = tabbed.map((i) => ({ at: i.at, size: i.size }));
  const report = engine.driftOf(
    clientsN(recorded, ["app-one", "app-two", "app-three"]), MONITORS,
    layoutN(recorded, ["one", "two", "three"]), IDS);
  assert.deepEqual(report.tilingRefusals, [], "nothing to do, so nothing to say");
  assert.equal(report.geometry.workspaces[0].refinement, null);
});

test("…and the sentence comes back the moment that workspace drifts", () => {
  const recorded = THREE_COLUMNS.map((i) => ({ at: i.at, size: i.size }));
  // Inside the 0.95 stop: a couple of pixels off is not something the
  // refinement would have acted on, so there is nothing to refuse.
  const nearly = [
    { at: [12, 38], size: [466, 850] },
    { at: [482, 38], size: [462, 850] },
    { at: [950, 38], size: [478, 850] }
  ];
  const settled = engine.driftOf(clientsN(nearly, ["app-one", "app-two", "app-three"]),
    MONITORS, layoutN(recorded, ["one", "two", "three"]), IDS);
  assert.deepEqual(settled.tilingRefusals, []);

  // …and a divider dragged far enough to matter says so.
  const dragged = [
    { at: [12, 38], size: [300, 850] },
    { at: [318, 38], size: [628, 850] },
    { at: [952, 38], size: [476, 850] }
  ];
  const drifted = engine.driftOf(clientsN(dragged, ["app-one", "app-two", "app-three"]),
    MONITORS, layoutN(recorded, ["one", "two", "three"]), IDS);
  assert.equal(drifted.tilingRefusals.length, 1);
  assert.equal(drifted.tilingRefusals[0].reason, "ambiguous-tree");
});

// ------------------------------------------------- one flip, one dispatch (uk5)
//
// `different-shape` used to be the end of the conversation: no sequence of
// divider moves turns one split tree into another, so the workspace was left as
// it was. True, and not the whole story — dwindle has `togglesplit`, which flips
// ONE node and moves nothing else, and Omarchy binds it to SUPER+J, which is
// exactly how the case arrives. So the refusal is narrowed to what it can
// honestly claim, and a live tiling that is ONE flip from the recording is
// planned instead of refused.

const RECORDED2 = [
  { key: "a", at: [12, 38], size: [701, 850] },
  { key: "b", at: [727, 38], size: [701, 850] }
];
// The same two windows, stacked: the root node's split flipped and nothing else.
const FLIPPED2 = [
  { key: "a", at: [12, 38], size: [1416, 418] },
  { key: "b", at: [12, 470], size: [1416, 418] }
];

test("a live tiling ONE flip from the recording is a split op, not a refusal", () => {
  assert.equal(engine.tilingRefusalOf(RECORDED2, FLIPPED2), null,
    "one flip is reachable, so it is not a refusal");
  const program = engine.planWorkspaceTiling(RECORDED2, FLIPPED2);
  assert.deepEqual(program.split, { address: "a" });
  // NOTHING ELSE this plan: the flip changes every rect under the flipped node,
  // so a swap or a nudge computed here would be aimed at a tiling that is about
  // to stop existing.
  assert.deepEqual(program.swaps, []);
  assert.deepEqual(program.dividers, []);
});

test("the flip names a window whose PARENT is the node that differs", () => {
  // `togglesplit` flips the FOCUSED window's parent node, so the op is only
  // aimable when the differing node has a window directly under it — and the
  // near side is named, because the near side is the incumbent and naming it
  // keeps the choice the same on every run.
  assert.deepEqual(engine.singleFlipOf(
    engine.splitTreeOf(RECORDED2), engine.splitTreeOf(FLIPPED2)).address, "a");

  // A flip wanted higher up the tree has no window to focus that would reach it.
  const grid = { axis: 0, near: { axis: 1, near: { key: "a" }, far: { key: "b" } },
    far: { axis: 1, near: { key: "c" }, far: { key: "d" } } };
  const flippedRoot = { axis: 1, near: grid.near, far: grid.far };
  assert.equal(engine.singleFlipOf(grid, flippedRoot), null,
    "the root has no leaf child, so no focus reaches it — refused with the rest");
});

test("TWO flips are still refused: one togglesplit is one node", () => {
  // The spine, with BOTH its nodes flipped — a shape a single dispatch cannot
  // reach, and the second node would have to be found again in a tree the flip
  // has already rewritten.
  const twoFlips = [
    { key: "a", at: [12, 38], size: [1416, 418] },
    { key: "b", at: [12, 470], size: [701, 418] },
    { key: "c", at: [727, 470], size: [701, 418] }
  ];
  assert.equal(engine.layoutIsAmbiguous(twoFlips), false, "the case is reachable at all");
  assert.equal(engine.tilingRefusalOf(RECORDED3, twoFlips), engine.TILING_REFUSAL_DIFFERENT_SHAPE);
  assert.equal(engine.planWorkspaceTiling(RECORDED3, twoFlips), null);
});

test("a flip is only a flip when both sides hold the SAME windows", () => {
  const stranger = FLIPPED2.map((i) => ({ ...i }));
  stranger[1].key = "z";
  assert.equal(engine.tilingRefusalOf(RECORDED2, stranger), engine.TILING_REFUSAL_DIFFERENT_SHAPE);
  assert.equal(engine.planWorkspaceTiling(RECORDED2, stranger), null);
});

test("a flip DEEPER than the root lands on the ambiguity guard, and stays refused", () => {
  // Worth pinning because it is the shape of the whole feature: in an
  // unambiguous guillotine tree every node's axis differs from its parent's, so
  // flipping any node with a node above or below it makes the live layout
  // ambiguous — and an ambiguous layout is refused before the flip question is
  // ever asked. A flip we cannot locate in a tree we cannot identify is a guess.
  const innerFlip = [
    { key: "a", at: [12, 38], size: [701, 850] },
    { key: "b", at: [727, 38], size: [348, 850] },
    { key: "c", at: [1080, 38], size: [348, 850] }
  ];
  assert.equal(engine.layoutIsAmbiguous(innerFlip), true, "three columns fit two trees");
  assert.equal(engine.tilingRefusalOf(RECORDED3, innerFlip), engine.TILING_REFUSAL_AMBIGUOUS);
  assert.equal(engine.planWorkspaceTiling(RECORDED3, innerFlip), null);
});

test("the split dispatch is a focus and a togglesplit, in that order", () => {
  // `togglesplit` takes no window selector of any kind — it is a dwindle layout
  // message that flips the FOCUSED window's parent — so the focus IS the aim.
  // The spelling is Omarchy's own (default/hypr/bindings/tiling.lua, SUPER+J).
  assert.deepEqual(engine.opToCommand({ kind: "split", address: "0x1", workspaceId: 5 }), [
    'hyprctl dispatch \'hl.dsp.focus({ window = "address:0x1" })\'',
    'hyprctl dispatch \'hl.dsp.layout("togglesplit")\''
  ]);
  assert.deepEqual(engine.opToCommand({ kind: "split" }), []);
  assert.equal(engine.describeOp({ kind: "split", address: "0x1", workspaceId: 5 }),
    "split 0x1 (ws 5)");
  // One window, named the ordinary way, so the ledger and the snapshot check
  // both see it without knowing what a split is.
  assert.deepEqual(engine.opAddressesOf({ kind: "split", address: "0x1" }), ["0x1"]);
});

// -------------------------------------------------- the flip through the planner

const RECORDED2_RECTS = RECORDED2.map((i) => ({ at: i.at, size: i.size }));
const FLIPPED2_RECTS = FLIPPED2.map((i) => ({ at: i.at, size: i.size }));

test("a flipped two-window workspace plans exactly one split, and nothing else", () => {
  const layout = layoutN(RECORDED2_RECTS, ["one", "two"]);
  const live = clientsN(FLIPPED2_RECTS, ["app-one", "app-two"]);
  const plan = engine.planRestore(live, MONITORS, layout, IDS);
  assert.deepEqual(plan.map((op) => op.kind), ["split"]);
  assert.equal(plan[0].address, "0x1");
  assert.equal(plan[0].workspaceId, 5);
  // Focus-dependent, so a locked session defers it exactly like a group join.
  assert.equal(engine.planHasFocusOps(plan), true);
  assert.deepEqual(engine.planWithoutFocusOps(plan), []);
  // …and it is refinement work, counted against the refinement's own budget.
  assert.equal(engine.isRefinementPlan(plan), true);
  // No refusal reaches the reader for a workspace the tool is about to fix.
  assert.deepEqual(
    engine.driftOf(live, MONITORS, layout, IDS).tilingRefusals, []);
});

test("IDEMPOTENT: once the flip has landed, the same desktop plans nothing", () => {
  const layout = layoutN(RECORDED2_RECTS, ["one", "two"]);
  assert.deepEqual(
    engine.planRestore(clientsN(RECORDED2_RECTS, ["app-one", "app-two"]), MONITORS, layout, IDS),
    []);
  // And a flip that landed on a desktop whose windows are ALSO in each other's
  // slots leaves the swap for the next plan, which is where it belongs: the
  // shape matches now, so the occupancy pass is allowed to look.
  const swapped = clientsN([RECORDED2_RECTS[1], RECORDED2_RECTS[0]], ["app-one", "app-two"]);
  assert.deepEqual(
    engine.planRestore(swapped, MONITORS, layout, IDS).map((op) => op.kind), ["swap"]);
});

test("planHasFocusOps names BOTH ops that need the keyboard, and no others", () => {
  assert.equal(engine.planHasFocusOps([{ kind: "group" }]), true);
  assert.equal(engine.planHasFocusOps([{ kind: "split" }]), true);
  for (const kind of ["move", "workspace-monitor", "ungroup", "floating", "geometry",
    "swap", "divider", "launch"]) {
    assert.equal(engine.planHasFocusOps([{ kind: kind }]), false, kind + " must not defer");
  }
  assert.equal(engine.planHasFocusOps([]), false);
  assert.equal(engine.planHasFocusOps(null), false);
  assert.equal(engine.planHasFocusOps([null]), false);

  const plan = [{ kind: "move" }, { kind: "split" }, { kind: "group" }, { kind: "divider" }];
  const runnable = engine.planWithoutFocusOps(plan);
  assert.deepEqual(runnable.map((o) => o.kind), ["move", "divider"]);
  assert.strictEqual(runnable[0], plan[0], "the ops are the same objects, never rebuilt");
  assert.equal(plan.length, 4, "the full plan is untouched — the no-progress check reads it");
  assert.deepEqual(engine.planWithoutFocusOps(null), []);
  // The narrower question is still asked by the group machinery, and is still
  // only about group joins.
  assert.equal(engine.planHasGroupJoins([{ kind: "split" }]), false);
});
