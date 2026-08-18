// Geometry scoring — tick 5sc, amended by tick qkv.
//
// Schema v2 (tick xz9) started recording each window's `at`/`size`; this file
// pins what the tool is allowed to CONCLUDE from them. Tick 5sc's rule was flat
// — measured, never enforced, because nothing in planRestore could move a
// window by pixels. Epic yyz built the op that can, for FLOATS, so the rule
// split in two and this file now holds both halves:
//
//   FLOAT  — enforced. A recorded float outside the ±2px band is drift: it
//            moves verdict.ok, it moves the drift count, it plans a geometry op
//            and it moves scripts/verify's exit code. That is honest precisely
//            BECAUSE there is now a button that fixes it.
//   TILED  — still measured, never enforced, and the negative assertions that
//            hold that line are the more important half of this file. A tiled
//            rect is an outcome of the dwindle tree, Hyprland exposes no way to
//            command it, and `window.resize` aimed at one silently rearranges
//            the split (tick y29). Nothing here may mark a tiled desktop down.
//
// The second property is the null contract. Any recording written before schema
// v2 carries no geometry at all; every entry of it scores `not-scored`, and a
// build that read that as a mismatch would paint a correct desktop wrong on the
// day the feature shipped. `not-scored` is never a mismatch and never an
// agreement.
//
// (Until 2026-08-16 that described the user's own file, and several comments in
// this tree said so. It does not any more — theirs is v2 with rects on all 18
// entries. What keeps THEIR desktop unmarked is the tiled rule above, not this
// one: every entry of it is recorded `floating: false`. Checked in tick qkv.)

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");
const state = require("../StateModel.js");
const panel = require("../PanelModel.js");
const { loadFixture, IDENTITIES, makeClient } = require("./helpers.js");

const clientsLaptop = loadFixture("clients-laptop.json");
const monitorsLaptop = loadFixture("monitors-laptop.json");

const AT = "2026-08-15T18:30:00Z";
const TOL = engine.GEOMETRY_TOLERANCE_PX;

// A one-window desktop, so a geometry assertion is about geometry and not about
// which window the matcher picked. `terminal` is `^foot$`, which nothing else
// in IDENTITIES claims.
function oneWindow(overrides) {
  return [makeClient(Object.assign({
    address: "0xfoot",
    class: "foot",
    workspace: 3,
    monitor: 0,
    at: [100, 200],
    size: [800, 600],
    floating: false
  }, overrides || {}))];
}

function scoreOf(recordedClients, liveClients) {
  const layout = engine.buildLayout(recordedClients, monitorsLaptop, IDENTITIES, AT);
  const report = engine.driftOf(liveClients, monitorsLaptop, layout, IDENTITIES);
  return { report: report, entry: report.apps[0], layout: layout };
}

function verdictOf(recordedClients, liveClients) {
  const layout = engine.buildLayout(recordedClients, monitorsLaptop, IDENTITIES, AT);
  const report = engine.driftOf(liveClients, monitorsLaptop, layout, IDENTITIES);
  return engine.verdictsFor(report, [])[0];
}

// ---------------------------------------------------------------- the metric

test("rectIou is 1 for the same rect and 0 for rects that do not touch", () => {
  const a = { at: [0, 0], size: [100, 100] };
  assert.strictEqual(engine.rectIou(a, { at: [0, 0], size: [100, 100] }), 1);
  assert.strictEqual(engine.rectIou(a, { at: [500, 500], size: [100, 100] }), 0);
  // Edge-to-edge is touching, not overlapping: zero area shared.
  assert.strictEqual(engine.rectIou(a, { at: [100, 0], size: [100, 100] }), 0);
});

// The worked example carried in docs/state-matrix.md § Geometry scoring. If
// this number ever changes, that document is wrong and has to move with it.
test("the worked example from the state matrix scores 0.667", () => {
  const recorded = { at: [0, 0], size: [1000, 1000] };
  const live = { at: [200, 0], size: [1000, 1000] };
  // intersection 800x1000 = 800000; union 1000000 + 1000000 - 800000 = 1200000
  assert.strictEqual(engine.rectIou(recorded, live), 0.6667);

  const halfWidth = { at: [0, 0], size: [500, 1000] };
  // intersection 500x1000 = 500000; union 1000000 + 500000 - 500000 = 1000000
  assert.strictEqual(engine.rectIou(recorded, halfWidth), 0.5);

  // Both wrong at once: shifted AND narrowed. Shared 600..1000 = 400x1000 =
  // 400000; union 1000000 + 500000 - 400000 = 1100000.
  const shiftedNarrow = { at: [600, 0], size: [500, 1000] };
  assert.strictEqual(engine.rectIou(recorded, shiftedNarrow), 0.3636);
});

test("IoU punishes a move and a resize alike, which an area ratio would not", () => {
  const recorded = { at: [0, 0], size: [400, 400] };
  const movedSameSize = engine.rectIou(recorded, { at: [200, 0], size: [400, 400] });
  const sameSpotHalfArea = engine.rectIou(recorded, { at: [0, 0], size: [200, 400] });
  assert.ok(movedSameSize < 1, "a window that moved cannot score 1");
  assert.ok(sameSpotHalfArea < 1, "a window that shrank cannot score 1");
});

test("an unknown or zero-area rect scores null, never 0", () => {
  const a = { at: [0, 0], size: [100, 100] };
  assert.strictEqual(engine.rectIou(a, { at: null, size: [100, 100] }), null);
  assert.strictEqual(engine.rectIou(a, { at: [0, 0], size: null }), null);
  assert.strictEqual(engine.rectIou(a, null), null);
  // Zero is a MEASUREMENT ("nowhere near"); null is the absence of one. A
  // zero-area rect has no similarity to report, so it must not claim 0.
  assert.strictEqual(engine.rectIou(a, { at: [0, 0], size: [0, 100] }), null);
  assert.strictEqual(engine.rectIou({ at: [0, 0], size: [100, 0] }, a), null);
});

test("geometryDelta is signed and per-axis, so direction survives", () => {
  const delta = engine.geometryDelta(
    { at: [100, 200], size: [800, 600] },
    { at: [112, 190], size: [800, 640] }
  );
  assert.deepStrictEqual(delta, { dx: 12, dy: -10, dw: 0, dh: 40 });
  assert.strictEqual(engine.geometryDelta(null, { at: [0, 0], size: [1, 1] }), null);
  assert.strictEqual(engine.geometryDelta({ at: null, size: [1, 1] }, { at: [0, 0], size: [1, 1] }), null);
});

// ------------------------------------------------------------ the tolerance

test("a float inside ±2 px on every axis reads ok", () => {
  const recorded = oneWindow({ floating: true });
  for (const nudge of [[0, 0, 0, 0], [TOL, 0, 0, 0], [0, -TOL, 0, 0], [TOL, -TOL, TOL, -TOL]]) {
    const live = oneWindow({
      floating: true,
      at: [100 + nudge[0], 200 + nudge[1]],
      size: [800 + nudge[2], 600 + nudge[3]]
    });
    const score = scoreOf(recorded, live).entry.geometry;
    assert.strictEqual(score.mode, "float");
    assert.strictEqual(score.verdict, "ok", "nudge " + nudge.join(",") + " is inside tolerance");
  }
});

test("a float one pixel outside the tolerance reads geometry-off, on any single axis", () => {
  const recorded = oneWindow({ floating: true });
  const cases = [
    { at: [100 + TOL + 1, 200], size: [800, 600], axis: "x" },
    { at: [100, 200 - (TOL + 1)], size: [800, 600], axis: "y" },
    { at: [100, 200], size: [800 + TOL + 1, 600], axis: "w" },
    { at: [100, 200], size: [800, 600 - (TOL + 1)], axis: "h" }
  ];
  for (const c of cases) {
    const score = scoreOf(recorded, oneWindow({ floating: true, at: c.at, size: c.size })).entry.geometry;
    assert.strictEqual(score.verdict, "geometry-off", c.axis + " out of tolerance must be off");
  }
});

test("the tolerance is ±2 px and the constant is what everything reads", () => {
  assert.strictEqual(engine.GEOMETRY_TOLERANCE_PX, 2);
  const score = scoreOf(oneWindow({ floating: true }), oneWindow({ floating: true })).entry.geometry;
  assert.strictEqual(score.tolerance, engine.GEOMETRY_TOLERANCE_PX);
});

// ------------------------------------------------------------- tiled windows

test("a tiled window is scored, never passed or failed", () => {
  const recorded = oneWindow({ floating: false });
  // Miles out of any float tolerance, and still not a failure: there is no
  // primitive that could have put a tiled window back.
  const live = oneWindow({ floating: false, at: [900, 200], size: [400, 600] });
  const score = scoreOf(recorded, live).entry.geometry;
  assert.strictEqual(score.mode, "tiled");
  assert.strictEqual(score.verdict, "scored");
  assert.ok(score.iou !== null && score.iou < 1, "a displaced tiled window scores below 1");
  assert.notStrictEqual(score.verdict, "geometry-off");
});

test("a tiled window back exactly where it was scores 1", () => {
  const score = scoreOf(oneWindow({ floating: false }), oneWindow({ floating: false })).entry.geometry;
  assert.strictEqual(score.verdict, "scored");
  assert.strictEqual(score.iou, 1);
});

test("the mode follows the RECORD, because the record is the statement of intent", () => {
  const recordedFloating = scoreOf(oneWindow({ floating: true }), oneWindow({ floating: false })).entry.geometry;
  assert.strictEqual(recordedFloating.mode, "float");
  const recordedTiled = scoreOf(oneWindow({ floating: false }), oneWindow({ floating: true })).entry.geometry;
  assert.strictEqual(recordedTiled.mode, "tiled");
});

// ------------------------------------------------------------- not-scored

test("a v1 recording — no geometry anywhere — scores not-scored on every row", () => {
  const layout = engine.buildLayout(clientsLaptop, monitorsLaptop, IDENTITIES, AT);
  // Exactly what StateModel's v1 migration produces: the keys present, null.
  const v1 = {
    topologyKey: layout.topologyKey,
    recordedAt: layout.recordedAt,
    apps: layout.apps.map((a) => Object.assign({}, a, { at: null, size: null }))
  };
  const report = engine.driftOf(clientsLaptop, monitorsLaptop, v1, IDENTITIES);
  const verdicts = engine.verdictsFor(report, []);

  assert.ok(verdicts.length > 0, "the fixture must record something");
  for (const verdict of verdicts) {
    assert.strictEqual(verdict.geometry, "not-scored", verdict.identityId);
  }
  assert.strictEqual(report.geometry.tiled.scored, 0);
  assert.strictEqual(report.geometry.tiled.meanIou, null);
  assert.deepStrictEqual(report.geometry.workspaces, []);

  // …and NOT ONE of them is a mismatch. This is the whole null contract.
  for (const verdict of verdicts) {
    assert.strictEqual(verdict.ok, true, verdict.identityId + " must still be ok");
  }
  assert.strictEqual(engine.verdictSummary(verdicts).ok, true);
});

test("null geometry is neither a mismatch nor an agreement", () => {
  const recorded = oneWindow({ floating: true });
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  layout.apps[0].at = null;
  const report = engine.driftOf(oneWindow({ floating: true }), monitorsLaptop, layout, IDENTITIES);
  const score = report.apps[0].geometry;
  assert.strictEqual(score.verdict, "not-scored");
  assert.strictEqual(score.delta, null, "no delta was measured");
  assert.strictEqual(score.iou, null, "no similarity was measured");
  assert.notStrictEqual(score.verdict, "ok", "silence is not agreement");
});

test("an app that is not running scores not-scored, not a miss", () => {
  const verdict = verdictOf(oneWindow({ floating: true }), []);
  assert.strictEqual(verdict.status, "missing");
  assert.strictEqual(verdict.geometry, "not-scored");
});

test("a skipped app is not scored across a topology it does not belong to", () => {
  // Layout coordinates are global and shift when a monitor comes or goes, so a
  // window whose recorded monitor is absent has no comparable rect at all.
  const recorded = oneWindow({ floating: true });
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  layout.apps[0].monitorDescription = "Some Monitor That Is Not Here";
  const report = engine.driftOf(oneWindow({ floating: true }), monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.apps[0].status, "skipped");
  assert.strictEqual(report.apps[0].geometry.verdict, "not-scored");
});

// ------------------------------------- floats enforce, tiled windows do not

test("a float 40 px out of place is NOT ok and is not counted as arranged", () => {
  const verdict = verdictOf(
    oneWindow({ floating: true }),
    oneWindow({ floating: true, at: [140, 200], size: [800, 600] })
  );
  assert.strictEqual(verdict.geometry, "geometry-off");
  // The four placement dimensions are all fine — the window is on the right
  // monitor, the right workspace, floating as recorded and ungrouped. Geometry
  // alone carries this verdict, which is what makes it the interesting case.
  assert.strictEqual(verdict.monitor, "ok");
  assert.strictEqual(verdict.workspace, "ok");
  assert.strictEqual(verdict.floating, "ok");
  assert.strictEqual(verdict.group, "ok");
  // Reversed by tick qkv: there is an op for this now, so saying "arranged"
  // would be claiming a restore finished when a button can still improve it.
  assert.strictEqual(verdict.ok, false, "a drifted float is not arranged");
  assert.strictEqual(engine.verdictSummary([verdict]).ok, false);
  assert.strictEqual(engine.verdictSummary([verdict]).arranged, 0);
  assert.match(verdict.text, /Δpos/, "and it says how far, not just that it is off");
});

test("a TILED window's score never makes a verdict not-ok, however bad", () => {
  // The line tick 5sc drew and tick qkv did NOT cross. This rect misses by
  // hundreds of pixels in both axes and at half the size; it scores, and the
  // verdict stays green, because Hyprland exposes nothing that could command it.
  const verdict = verdictOf(
    oneWindow({ floating: false }),
    oneWindow({ floating: false, at: [900, 900], size: [400, 300] })
  );
  assert.strictEqual(verdict.geometry, "scored");
  assert.notStrictEqual(verdict.geometry, "geometry-off");
  assert.strictEqual(verdict.ok, true, "a tiled miss must never fail a verdict");
  assert.strictEqual(engine.verdictSummary([verdict]).ok, true);
  assert.strictEqual(verdict.text, "", "and must never put a complaint on the row");
});

test("a drifted float moves the drift count; a tiled window's score never does", () => {
  const recordedFloat = () => engine.buildLayout(
    oneWindow({ floating: true }), monitorsLaptop, IDENTITIES, AT);

  const clean = engine.driftOf(oneWindow({ floating: true }), monitorsLaptop,
    recordedFloat(), IDENTITIES);
  assert.strictEqual(state.driftCountOf(clean), 0);

  const off = engine.driftOf(oneWindow({ floating: true, at: [900, 900] }), monitorsLaptop,
    recordedFloat(), IDENTITIES);
  assert.strictEqual(off.apps[0].geometry.verdict, "geometry-off");
  assert.strictEqual(off.apps[0].drift.geometry, true);
  assert.strictEqual(off.apps[0].status, "drifted");
  assert.strictEqual(state.driftCountOf(off), 1, "the badge has to point at it");

  // Same miss, recorded TILED: scored, and invisible to the badge.
  const tiled = engine.driftOf(oneWindow({ floating: false, at: [900, 900] }), monitorsLaptop,
    engine.buildLayout(oneWindow({ floating: false }), monitorsLaptop, IDENTITIES, AT), IDENTITIES);
  assert.strictEqual(tiled.apps[0].geometry.verdict, "scored");
  assert.strictEqual(tiled.apps[0].drift.geometry, false);
  assert.strictEqual(tiled.apps[0].status, "ok");
  assert.strictEqual(state.driftCountOf(tiled), 0);
});

test("a tiled window never reaches a plan, however far its rect has moved", () => {
  const layout = engine.buildLayout(oneWindow({ floating: false }), monitorsLaptop, IDENTITIES, AT);
  const live = oneWindow({ floating: false, at: [1200, 900], size: [300, 200] });
  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.apps[0].geometry.verdict, "scored");
  assert.deepStrictEqual(engine.planRestore(live, monitorsLaptop, layout, IDENTITIES), [],
    "resize aimed at a tiled window rearranges the dwindle split — never plan one");
});

// ------------------------------------------------------------- the roll-up

test("per-workspace mean IoU is grouped by the RECORDED workspace", () => {
  const recorded = [
    makeClient({ address: "0xa", class: "foot", workspace: 3, at: [0, 0], size: [1000, 1000] }),
    makeClient({ address: "0xb", class: "code", workspace: 3, at: [0, 0], size: [1000, 1000] }),
    makeClient({ address: "0xc", class: "chromium", workspace: 4, at: [0, 0], size: [1000, 1000] })
  ];
  const live = [
    // ws 3: one perfect, one shifted 200 of 1000 -> 0.6667. Mean 0.8334 (rounded).
    makeClient({ address: "0xa", class: "foot", workspace: 3, at: [0, 0], size: [1000, 1000] }),
    makeClient({ address: "0xb", class: "code", workspace: 3, at: [200, 0], size: [1000, 1000] }),
    // ws 4: half the width -> 0.5
    makeClient({ address: "0xc", class: "chromium", workspace: 4, at: [0, 0], size: [500, 1000] })
  ];
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  const geometry = report.geometry;

  assert.strictEqual(geometry.workspaces.length, 2);
  const ws3 = geometry.workspaces.find((w) => w.workspaceId === 3);
  const ws4 = geometry.workspaces.find((w) => w.workspaceId === 4);
  assert.strictEqual(ws3.count, 2);
  assert.strictEqual(ws3.meanIou, 0.8334);
  assert.strictEqual(ws4.count, 1);
  assert.strictEqual(ws4.meanIou, 0.5);

  // The aggregate is the mean over WINDOWS, not the mean of the per-workspace
  // means — a workspace with one window must not weigh as much as one with six.
  assert.strictEqual(geometry.tiled.scored, 3);
  assert.strictEqual(geometry.tiled.meanIou, 0.7222);
});

test("a window that wandered to another workspace is counted where it was RECORDED", () => {
  const recorded = [makeClient({ address: "0xa", class: "foot", workspace: 3, at: [0, 0], size: [100, 100] })];
  const live = [makeClient({ address: "0xa", class: "foot", workspace: 8, at: [0, 0], size: [100, 100] })];
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  const report = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES);
  assert.strictEqual(report.geometry.workspaces.length, 1);
  assert.strictEqual(report.geometry.workspaces[0].workspaceId, 3);
});

test("floats are counted apart from tiled windows and never enter the mean", () => {
  const recorded = [
    makeClient({ address: "0xa", class: "foot", workspace: 3, floating: true, at: [0, 0], size: [100, 100] }),
    makeClient({ address: "0xb", class: "code", workspace: 3, floating: false, at: [0, 0], size: [100, 100] })
  ];
  const live = [
    makeClient({ address: "0xa", class: "foot", workspace: 3, floating: true, at: [90, 0], size: [100, 100] }),
    makeClient({ address: "0xb", class: "code", workspace: 3, floating: false, at: [0, 0], size: [100, 100] })
  ];
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  const geometry = engine.driftOf(live, monitorsLaptop, layout, IDENTITIES).geometry;

  assert.deepStrictEqual(geometry.floats, { total: 1, ok: 0, off: 1, notScored: 0 });
  assert.strictEqual(geometry.tiled.total, 1);
  assert.strictEqual(geometry.tiled.scored, 1);
  // The badly-placed float scores 0.1 on its own; the mean must be the tiled
  // window's 1 alone.
  assert.strictEqual(geometry.tiled.meanIou, 1);
});

test("the roll-up survives an empty and a junk app list", () => {
  const empty = engine.geometrySummaryOf([]);
  assert.strictEqual(empty.tiled.meanIou, null);
  assert.deepStrictEqual(empty.workspaces, []);
  assert.strictEqual(empty.tolerance, engine.GEOMETRY_TOLERANCE_PX);
  assert.doesNotThrow(() => engine.geometrySummaryOf([null, {}, { geometry: null }]));
});

// --------------------------------------------------------------- the words

test("the geometry phrase carries the numbers, not just a complaint", () => {
  const verdict = verdictOf(
    oneWindow({ floating: true }),
    oneWindow({ floating: true, at: [112, 190], size: [800, 640] })
  );
  // Signed where there is a direction, bare where there is not: "+0" would be
  // a direction nobody moved in.
  assert.match(verdict.text, /Δpos \+12,-10/);
  assert.match(verdict.text, /Δsize 0,\+40/);
});

test("a row leads with the placement problem and mentions geometry last", () => {
  const recorded = oneWindow({ floating: true, workspace: 3 });
  const live = oneWindow({ floating: true, workspace: 7, at: [500, 200], size: [800, 600] });
  const verdict = verdictOf(recorded, live);
  assert.strictEqual(verdict.ok, false, "the workspace really is wrong");
  const wsAt = verdict.text.indexOf("wrong workspace");
  const geoAt = verdict.text.indexOf("Δpos");
  assert.ok(wsAt >= 0 && geoAt > wsAt, "geometry comes after the placement phrase");
});

test("a tiled score and a not-scored row say nothing in a sentence", () => {
  const tiled = verdictOf(oneWindow({ floating: false }),
    oneWindow({ floating: false, at: [900, 900], size: [100, 100] }));
  assert.strictEqual(tiled.geometry, "scored");
  assert.strictEqual(tiled.text, "", "a tiled score is a number, not a complaint");

  const layout = engine.buildLayout(oneWindow({ floating: true }), monitorsLaptop, IDENTITIES, AT);
  layout.apps[0].at = null;
  layout.apps[0].size = null;
  const report = engine.driftOf(oneWindow({ floating: true }), monitorsLaptop, layout, IDENTITIES);
  const notScored = engine.verdictsFor(report, [])[0];
  assert.strictEqual(notScored.geometry, "not-scored");
  assert.strictEqual(notScored.text, "");
});

// ------------------------------------------------------- the panel and file

test("the panel row speaks for a geometry-off float, with the deltas", () => {
  const verdict = verdictOf(
    oneWindow({ floating: true }),
    oneWindow({ floating: true, at: [200, 200], size: [800, 600] })
  );
  assert.strictEqual(verdict.ok, false, "since tick qkv a drifted float is drift");
  const line = panel.verdictLine(verdict);
  assert.ok(line, "a measured miss the user can see must reach the row");
  assert.match(line, /Δpos/);
});

test("the panel row stays silent for scored, not-scored and clean rows", () => {
  for (const word of ["ok", "scored", "not-scored"]) {
    const line = panel.verdictLine({ identityId: "x", ok: true, text: "", geometry: word });
    assert.strictEqual(line, "", word + " must not put a sentence on a clean row");
  }
});

test("a geometry-off float round-trips through the status file, ok and all", () => {
  const verdict = verdictOf(
    oneWindow({ floating: true }),
    oneWindow({ floating: true, at: [140, 200], size: [800, 600] })
  );
  const parsed = state.parseStatus(state.serializeStatus({
    topologyKey: "t", recorded: true, driftCount: 1, restoring: false, verdicts: [verdict]
  })).status;
  const back = parsed.verdicts[0];

  assert.strictEqual(back.geometry, "geometry-off");
  // normalizeVerdict RECOMPUTES ok rather than trusting the file, so this is
  // the check that the two halves of the fold agree — engine and StateModel
  // reaching different answers about one desktop is the lie the recompute
  // exists to prevent.
  assert.strictEqual(back.ok, false, "the recompute must reach the engine's answer");
  assert.deepStrictEqual(back.geometryDetail.delta, { dx: 40, dy: 0, dw: 0, dh: 0 });
  assert.deepStrictEqual(back.geometryDetail.recorded.at, [100, 200]);
  assert.strictEqual(back.geometryDetail.mode, "float");
});

test("a status file cannot fake ok:true over a geometry-off word", () => {
  const parsed = state.parseStatus(JSON.stringify({
    topologyKey: "t",
    verdicts: [{
      identityId: "slack", monitor: "ok", workspace: "ok", floating: "ok", group: "ok",
      geometry: "geometry-off", ok: true
    }]
  })).status;
  assert.strictEqual(parsed.verdicts[0].ok, false);
});

test("a TILED score round-trips without ever touching ok", () => {
  const verdict = verdictOf(
    oneWindow({ floating: false }),
    oneWindow({ floating: false, at: [140, 200], size: [800, 600] })
  );
  const parsed = state.parseStatus(state.serializeStatus({
    topologyKey: "t", recorded: true, driftCount: 0, restoring: false, verdicts: [verdict]
  })).status;
  assert.strictEqual(parsed.verdicts[0].geometry, "scored");
  assert.strictEqual(parsed.verdicts[0].ok, true);
});

test("a status file from a service that never measured geometry reads not-scored", () => {
  const parsed = state.parseStatus(JSON.stringify({
    topologyKey: "t",
    recorded: true,
    verdicts: [{ identityId: "slack", monitor: "ok", workspace: "ok", floating: "ok", group: "ok" }]
  })).status;
  // NOT "ok": nothing was measured, and claiming agreement would be an
  // agreement nobody reached.
  assert.strictEqual(parsed.verdicts[0].geometry, "not-scored");
  assert.strictEqual(parsed.verdicts[0].geometryDetail, null);
  assert.strictEqual(parsed.verdicts[0].ok, true);
});

test("a status file cannot smuggle a geometry word the code does not know", () => {
  const parsed = state.parseStatus(JSON.stringify({
    topologyKey: "t",
    verdicts: [{ identityId: "slack", geometry: "perfect", geometryDetail: { delta: { dx: 1 } } }]
  })).status;
  assert.strictEqual(parsed.verdicts[0].geometry, "not-scored");
  // A half-read delta cannot be rendered, so it is dropped rather than
  // half-rendered.
  assert.strictEqual(parsed.verdicts[0].geometryDetail.delta, null);
});

// ------------------------------------------------------------ the two twins

test("engine.geometryPair and StateModel.normalizeGeometry still agree", () => {
  const cases = [
    [1, 2], ["3", "4"], [1.5, 2.5], [0, 0], [-10, -20],
    null, undefined, [], [1], [1, 2, 3], ["a", 1], [NaN, 1], [Infinity, 1], "1,2", {}
  ];
  for (const value of cases) {
    assert.deepStrictEqual(
      engine.geometryPair(value),
      state.normalizeGeometry(value),
      "disagreement on " + JSON.stringify(value)
    );
  }
});

// ------------------------------------------------ the planner gate (tick ae1)
//
// Scoring answers "is this float where it was recorded". The gate answers the
// second question the op needs and scoring cannot: "is the recorded rect
// something this desktop can be asked to produce at all". Two ways it is not —
//
//   OFF-REGION. `at`/`size` are GLOBAL layout coordinates and topologyKey is a
//     sorted list of descriptions, blind to position, scale and order. Rearrange
//     two monitors and the key, the recording, the identities and every other
//     gate stay green while every coordinate in the file now points somewhere
//     else. The op would converge exactly, on the wrong place.
//   NON-POSITIVE SIZE. `resize({ x = 0, y = 0 })` cannot be satisfied, so the op
//     never converges and — carrying the recorded rect — re-plans identically
//     for ever.
//
// Both are refused in the planner, where the recording is in hand, and both are
// SAID rather than hidden: the score keeps its geometry-off verdict and carries
// the word.

const monitorsDockedGeometry = loadFixture("monitors-laptop+headless.json");

test("monitorRect reads the LOGICAL rect: device pixels divided by scale", () => {
  // eDP-1 is 2880x1800 at scale 2 — 1440x900 of layout space, which is the
  // space `at`/`size` are reported in. Reading the mode raw would make the
  // region twice as wide as the desktop and let a genuinely off-screen rect
  // through.
  assert.deepStrictEqual(engine.monitorRect(monitorsLaptop[0]), { x: 0, y: 0, w: 1440, h: 900 });
  assert.deepStrictEqual(engine.monitorRect(monitorsDockedGeometry[1]),
    { x: 1440, y: 0, w: 960, h: 540 });

  // A fractional scale, the case this machine actually runs on DP-1.
  assert.deepStrictEqual(
    engine.monitorRect({ x: 0, y: 0, width: 2560, height: 1440, scale: 1.6 }),
    { x: 0, y: 0, w: 1600, h: 900 });

  // 90 and 270 swap the axes; 180 does not.
  assert.deepStrictEqual(
    engine.monitorRect({ x: 10, y: 20, width: 1920, height: 1080, scale: 1, transform: 1 }),
    { x: 10, y: 20, w: 1080, h: 1920 });
  assert.deepStrictEqual(
    engine.monitorRect({ x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 2 }),
    { x: 0, y: 0, w: 1920, h: 1080 });
});

test("monitorRect refuses to guess at a read that does not place the monitor", () => {
  for (const monitor of [
    null, {}, { x: 0, y: 0 },
    { x: 0, y: 0, width: 0, height: 1080 },
    { x: 0, y: 0, width: 1920, height: -1 },
    { x: "left", y: 0, width: 1920, height: 1080 }
  ]) {
    assert.strictEqual(engine.monitorRect(monitor), null, JSON.stringify(monitor) + " is not a rect");
  }
  // A missing or nonsense scale falls back to 1 rather than to null: the
  // position IS known, and 1 is what an unscaled output reports.
  assert.deepStrictEqual(engine.monitorRect({ x: 0, y: 0, width: 800, height: 600 }),
    { x: 0, y: 0, w: 800, h: 600 });
  assert.deepStrictEqual(engine.monitorRect({ x: 0, y: 0, width: 800, height: 600, scale: 0 }),
    { x: 0, y: 0, w: 800, h: 600 });
});

test("rectsOverlap wants area: a shared edge is not an overlap", () => {
  const monitor = { x: 0, y: 0, w: 1440, h: 900 };
  assert.strictEqual(engine.rectsOverlap({ x: 1439, y: 0, w: 100, h: 100 }, monitor), true,
    "one pixel of the window is on the screen");
  assert.strictEqual(engine.rectsOverlap({ x: 1440, y: 0, w: 100, h: 100 }, monitor), false,
    "flush against the right edge is on the other side of it");
  assert.strictEqual(engine.rectsOverlap({ x: 0, y: 900, w: 100, h: 100 }, monitor), false);
  assert.strictEqual(engine.rectsOverlap({ x: -50, y: -50, w: 100, h: 100 }, monitor), true,
    "hanging off the top-left corner still overlaps");
  assert.strictEqual(engine.rectsOverlap(null, monitor), false);
});

test("geometryPlanSkip passes a rect that is on the monitor it was recorded on", () => {
  const recorded = {
    monitorDescription: "Samsung Display Corp. ATNA60HR07-0",
    at: [400, 300], size: [800, 600]
  };
  assert.strictEqual(engine.geometryPlanSkip(recorded, monitorsLaptop), null);
});

test("geometryPlanSkip refuses a rect that this arrangement of monitors cannot hold", () => {
  // Recorded on the headless output while it sat to the RIGHT of the laptop.
  const recorded = { monitorDescription: "hw-test", at: [1500, 100], size: [400, 300] };
  assert.strictEqual(engine.geometryPlanSkip(recorded, monitorsDockedGeometry), null,
    "as recorded, x 1500 is on hw-test");

  // The same two outputs, same descriptions, same topologyKey — swapped.
  const swapped = monitorsDockedGeometry.map((m) => Object.assign({}, m, {
    x: m.name === "hw-test" ? 0 : 960
  }));
  assert.strictEqual(engine.topologyKey(swapped), engine.topologyKey(monitorsDockedGeometry),
    "the key is blind to position — which is the whole reason this gate exists");
  assert.strictEqual(engine.geometryPlanSkip(recorded, swapped), "off-region");

  // And note WHY the recorded monitor is asked first: x 1500 is still inside
  // the UNION of the swapped monitors (it is on eDP-1 now), so a union test
  // would have waved this straight through.
  assert.strictEqual(
    engine.rectsOverlap({ x: 1500, y: 100, w: 400, h: 300 }, engine.monitorRect(swapped[0])), true);
});

test("geometryPlanSkip refuses a size no resize could reach, and allows a negative position", () => {
  const on = "Samsung Display Corp. ATNA60HR07-0";
  for (const size of [[0, 0], [0, 600], [800, 0], [-800, 600]]) {
    assert.strictEqual(
      engine.geometryPlanSkip({ monitorDescription: on, at: [100, 100], size: size },
        monitorsLaptop),
      "non-positive-size", JSON.stringify(size) + " is not a rect anything can be resized to");
  }
  // `at` may be negative — a monitor to the left of the origin is an ordinary
  // multi-monitor layout, and only w/h are checked.
  assert.strictEqual(
    engine.geometryPlanSkip({ monitorDescription: on, at: [-200, -100], size: [800, 600] },
      [{ name: "eDP-1", description: on, x: -1440, y: -900, width: 1440, height: 900, scale: 1 }]),
    null);
});

test("geometryPlanSkip has nothing to say about a record it was never going to plan", () => {
  const on = "Samsung Display Corp. ATNA60HR07-0";
  // A v1 entry: no numbers, so `not-scored`, so never a candidate. A skip word
  // here would put an unexplained reason on rows nobody asked about.
  assert.strictEqual(engine.geometryPlanSkip({ monitorDescription: on, at: null, size: null },
    monitorsLaptop), null);
  assert.strictEqual(engine.geometryPlanSkip(null, monitorsLaptop), null);
});

test("a monitor list that places nothing cannot answer the question, and does not pretend to", () => {
  // Fail-open, deliberately. hyprctl always reports x/y/width/height/scale, so
  // an unplaceable list is a synthetic or degraded read — and a gate that
  // failed closed there would silently switch float restore off on the day a
  // read shape changed. The property that keeps a TILED window safe is the
  // recorded-floating precondition, not this gate.
  const placeless = [{ name: "eDP-1", description: "Laptop" }, { name: "DP-1", description: "Ultrawide" }];
  assert.strictEqual(
    engine.geometryPlanSkip({ monitorDescription: "Laptop", at: [9000, 9000], size: [800, 600] },
      placeless),
    null);
  assert.strictEqual(engine.geometryPlanSkip({ monitorDescription: "Laptop", at: [0, 0], size: [8, 6] }, []),
    null);
  // A non-positive size is still refused — that answer needs no monitors at all.
  assert.strictEqual(
    engine.geometryPlanSkip({ monitorDescription: "Laptop", at: [0, 0], size: [0, 0] }, placeless),
    "non-positive-size");
});

test("a skipped float keeps its geometry-off verdict and carries the reason", () => {
  // The gate suppresses the OP, never the measurement. The window really is off
  // its recorded pixels; saying otherwise to look green is the one thing this
  // project cannot do. So the row stays not-ok, and the sentence says why no
  // restore is going to fix it.
  const recorded = oneWindow({ floating: true, at: [1300, 100], size: [100, 100] });
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  // Same description, half the width: the rect the record kept is now off the
  // right-hand end of the only monitor there is.
  const shrunk = [Object.assign({}, monitorsLaptop[0], { width: 1200 })];
  const live = oneWindow({ floating: true, at: [200, 100], size: [100, 100] });

  const report = engine.driftOf(live, shrunk, layout, IDENTITIES);
  const entry = report.apps[0];
  assert.strictEqual(entry.geometry.verdict, "geometry-off");
  assert.strictEqual(entry.drift.geometry, true, "it IS drifted, and the badge says so");
  assert.strictEqual(entry.geometry.skip, "off-region");
  assert.deepStrictEqual(engine.planRestore(live, shrunk, layout, IDENTITIES), [],
    "and not one pixel is dispatched");

  const verdict = engine.verdictsFor(report, [])[0];
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.geometryDetail.skip, "off-region");
  assert.match(verdict.text, /re-record/, "the row names the fix the user can actually make");
});

test("the skip word survives the status file, phrase and all", () => {
  const recorded = oneWindow({ floating: true, at: [1300, 100], size: [100, 100] });
  const layout = engine.buildLayout(recorded, monitorsLaptop, IDENTITIES, AT);
  const shrunk = [Object.assign({}, monitorsLaptop[0], { width: 1200 })];
  const report = engine.driftOf(oneWindow({ floating: true, at: [200, 100], size: [100, 100] }),
    shrunk, layout, IDENTITIES);
  const verdict = engine.verdictsFor(report, [])[0];

  const parsed = state.parseStatus(state.serializeStatus({
    topologyKey: "t", recorded: true, driftCount: 1, restoring: false, verdicts: [verdict]
  })).status;
  assert.strictEqual(parsed.verdicts[0].geometryDetail.skip, "off-region");
  assert.strictEqual(parsed.verdicts[0].ok, false);
  assert.match(panel.verdictLine(parsed.verdicts[0]), /re-record/);

  // A reason a NEWER service knows about must reach the row it explains rather
  // than be blanked into an unexplained amber, so the reader keeps the word and
  // the phrase falls back to it.
  const future = state.parseStatus(JSON.stringify({
    topologyKey: "t",
    verdicts: [{ identityId: "terminal", geometry: "geometry-off", geometryDetail: { skip: "sunspots" } }]
  })).status;
  assert.strictEqual(future.verdicts[0].geometryDetail.skip, "sunspots");
  assert.strictEqual(engine.geometrySkipPhrase("sunspots"), "sunspots");
  assert.strictEqual(engine.geometrySkipPhrase(null), "");
});
