// Property test: planRestore converges, and converges ON THE RECORDING.
//
// NODE-ONLY, deliberately: this file never loads in QML, so modern JS is fine
// here — the ES5 rule binds the root *.js modules, not test land. No Math.random
// anywhere: every case is derived from a fixed seed, so a failure line
// ("case 173 seed 0x…") reproduces byte for byte. Override with
// PROP_SEED=<number> to explore other universes; the committed default is the
// contract.
//
// The property, per generated (recording × live-desktop) pair:
//
//   1. CONVERGES: repeatedly plan → simulate-apply → re-plan reaches the empty
//      plan within a small bound, and every intermediate plan differs from the
//      one before it (engine.samePlan — the no-progress diagnosis must never
//      fire against the simulator).
//   2. HONEST ADDRESSES: no plan ever names an address absent from the client
//      list it was built from (engine.unknownPlanAddresses).
//   3. MATCHES: the final simulated desktop agrees with the recording on every
//      modeled dimension — workspace, workspace's monitor, floating, group
//      membership and tab order, plus a recorded FLOAT's rect to within
//      engine.GEOMETRY_TOLERANCE_PX per axis — for every app the plan could
//      legitimately act on (identity still watched, recorded monitor known and
//      present).
//      The comparisons are made DIRECTLY on the simulated state, not through
//      driftOf, so the check is independent of the machinery it is checking.
//
// The simulator models op semantics as live-verified on this machine:
//   - move: Hyprland moves a grouped window's WHOLE group with it; a window
//     moved to a workspace that does not exist yet creates that workspace on
//     the focused monitor (modeled as the first live monitor) — which is
//     exactly why the workspace-monitor op exists.
//   - workspace-monitor: the workspace moves, every window on it follows.
//   - group: the service's rebuild choreography, mechanically: dissolve every
//     claim-tangled window (engine.dissolveTargets), create the group around
//     the anchor, then join member i by focusing member i-1 (nominating the
//     insertion point) and inserting AFTER the focused tab — the literal
//     into_group semantics, so the test proves the choreography reproduces
//     recorded tab order rather than assuming it.
//   - ungroup: group.toggle takes a whole group down at once; later toggles on
//     already-freed members are no-ops (the dissolveStep re-read).
//   - floating: the service's read-gated toggle nets out to an assignment —
//     AND it hands the window a fresh compositor-chosen rect, because that is
//     what a real float toggle does. Modeled as a deterministic scramble.
//   - geometry: resize-then-move, both absolute and both exact (live-proven on
//     scale-1.6 hardware, tick y29), so the op nets out to assigning the
//     recorded rect. Only ever emitted for a recorded FLOAT.
//   - launch: a window of the identity's class appears on workspace 1 —
//     never on its recorded placement; the moves have to earn that.
//
// GEOMETRY, and what is and is not modeled (tick qkv). Floats carry real rects
// through the whole simulation, and the two things that DISPLACE a float are
// modeled because they are the reason the geometry op has to run last: a
// workspace move re-clamps a float against the new workspace's reserved area
// (live-measured: [1500,400] -> [1500,198] on a bare workspace move), and a
// float toggle hands the window a rect the compositor chose. Both are modeled
// as deterministic scrambles — the exact numbers are fiction, the fact that the
// rect changes is not, and it is the fact that makes the ordering assertion
// real rather than decorative.
//
// TILED rects used to be carried but never planned for, exactly as the engine
// treated them. TICK pyo CHANGED THAT: tiled placement is now approximated, and
// this file has to say precisely how much of that it can and cannot see.
//
//   swap      MODELLED EXACTLY. or5 measured hl.dsp.window.swap exchanging two
//             tiles' rects and doing nothing else — no focus, no divider, no
//             workspace shown — so the model IS the measurement.
//   divider   MODELLED, WITH LIMITS. The ask lands exactly on the subject and
//             the neighbour beyond its far edge absorbs the difference; both
//             are measured (or5 § 8). The fiction is that there is no dwindle
//             tree here, so "the neighbour" is found geometrically and a real
//             divider drags a whole SUBTREE rather than one window. On a
//             two-window split those are the same thing; deeper, this model
//             moves LESS of the desktop than the compositor does.
//             That cuts two ways, and tick eqb corrected the second half of
//             this note. For CONVERGENCE it is conservative: a plan that
//             converges here is not leaning on help it will not get. For
//             DIVERGENCE it is UNDER-MODELLED, which is the more important
//             half — a nudge that goes wrong (the far side of a split, the
//             wrong divider entirely) displaces one neighbour by one delta
//             here, where the real compositor rescales a whole subtree and,
//             from the far side, lands on 2 × current − asked. So this file
//             cannot be read as evidence that a wrong nudge is survivable. The
//             sign law and the ambiguity refusal are argued from the TREE in
//             engine.js and measured live in docs/state-matrix.md § 8; nothing
//             here tests them.
//   the tree  NOT MODELLED for the generated cases, and it cannot be: this file
//             generates arbitrary rects, not tilings, so there is no split tree
//             for a move to build and none for a focus choreography to
//             reproduce. What IS checked instead is the one property of the
//             placement program that survives without a tiling model — see the
//             move branch. A tiled rect is still a number along for the ride
//             everywhere else, and re-tiling after a dissolve still does not
//             recompute anything.
//   split     MODELLED FROM THE TREE (tick uk5), which is possible for exactly
//             this one op because the planner only emits it for a workspace
//             whose live rects reconstruct to ONE guillotine tree. So the
//             simulator rebuilds that tree and applies dwindle's own semantics —
//             flip the focused window's parent node, re-split its region on the
//             other axis at the same ratio, lay each side's subtree out again in
//             its new box. The rect numbers are as real as the input; what is
//             fiction is nothing, because an axis-wise affine map of a subtree's
//             box preserves every descendant split's orientation and ratio,
//             which is what the compositor recomputes. Generated cases almost
//             never reach it, so there is a DIRECTED case at the bottom of this
//             file that does.
//
// Known simplification, on purpose: dissolving a group re-tiles windows in
// place — no tiled geometry is modeled at all. That waiver once hid a real
// defect:
// this file used to say "into_group always succeeds in one direction", and on
// the live compositor that is FALSE — into_group only joins a group that is
// the directly ADJACENT tile (live-proven 2026-08-16, tick z0l; forensics dump
// 2026-08-16T06:34:51.393Z), and a dock transition routinely leaves the
// candidate non-adjacent, which made every real group join fail while this
// test stayed green. The join modeled below is faithful to the FIXED service
// choreography, which guarantees adjacency by construction (Service.qml
// scratchJoin assembles the pair alone on an empty workspace picked by
// engine.pickScratchWorkspace when the in-place directions are exhausted) —
// not to a bare into_group dispatch, which no simulator without a tiling
// model may assume succeeds.

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../engine.js");

const AT = "2026-08-16T08:00:00Z";
const CASES = 300;
const MAX_ITERATIONS = 10;
const DEFAULT_SEED = 0x84a41;
const SEED = process.env.PROP_SEED ? Number(process.env.PROP_SEED) : DEFAULT_SEED;

// ---------------------------------------------------------------- seeded rng

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    chance: (p) => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
  };
}

// ------------------------------------------------------------------ universe

const MONITOR_POOL = [
  { id: 0, name: "eDP-1", description: "Samsung Display Corp. TEST-PANEL" },
  { id: 1, name: "DP-1", description: "AOC CU34V5C 1UJQ2HA000683" },
  // The name-fallback trap: a headless output has no description at all.
  { id: 2, name: "hw-test", description: "" }
];

const IDENTITY_IDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

function identityClass(id) {
  return "cls-" + id;
}

function makeIdentities(ids) {
  return ids.map((id) => ({ id, patterns: ["^cls-" + id + "$"] }));
}

let addressCounter = 0;
function freshAddress() {
  addressCounter += 1;
  return "0xp" + addressCounter.toString(16);
}

function makeClient(cls, wsId, monitorId, floating, at, size) {
  return {
    address: freshAddress(),
    class: cls,
    initialClass: cls,
    workspace: { id: wsId, name: String(wsId) },
    monitor: monitorId,
    floating: !!floating,
    grouped: [],
    // Every window has a rect. Schema v2 records them for tiled windows too,
    // and the engine has to keep scoring those without ever planning for them.
    at: at || [100, 100],
    size: size || [800, 600]
  };
}

// A rect for a generated window. Deliberately awkward numbers — odd, and wider
// than the tolerance band in both axes — so nothing here can pass by rounding.
function someRect(rng) {
  return {
    at: [rng.int(0, 40) * 37 + 11, rng.int(0, 30) * 29 + 7],
    size: [rng.int(3, 20) * 61 + 13, rng.int(3, 16) * 47 + 9]
  };
}

// What a float toggle or a workspace move does to a floating window's rect. The
// compositor picks; we only model that it CHANGES, and deterministically, so a
// failing case replays. Chosen to always land outside the +-2px band.
function displace(client, salt) {
  if (!client.floating) return;
  client.at = [client.at[0] + 13 + salt, client.at[1] - 17 - salt];
  client.size = [Math.max(60, client.size[0] - 23), Math.max(60, client.size[1] + 19)];
}

// ---------------------------------------------------------------- generation

// A consistent desktop: every workspace lives on exactly one monitor.
function wsMonitorMapOf(clients) {
  const map = {};
  for (const c of clients) map[c.workspace.id] = c.monitor;
  return map;
}

function generateCase(rng) {
  // Monitors present at record time: 1-3 of the pool.
  const monitorCount = rng.int(1, 3);
  const recordMonitors = rng.shuffle(MONITOR_POOL).slice(0, monitorCount)
    .map((m) => ({ ...m }));

  const identities = makeIdentities(IDENTITY_IDS);

  // Which workspace sits on which monitor, decided once for the record-time
  // desktop so it is consistent by construction.
  const recordWsMon = {};
  for (let ws = 1; ws <= 8; ws++) recordWsMon[ws] = rng.pick(recordMonitors).id;

  // Record-time desktop: 0-3 windows per identity, scattered. Schema v3 records
  // EVERY one of them, so an identity is no longer a row — it is a family of
  // rows that a restore has to keep apart. The distribution keeps the
  // single-window case dominant (it is the real one) while making a second and
  // a third window ordinary rather than exotic.
  const recordClients = [];
  const running = [];
  for (const id of IDENTITY_IDS) {
    const roll = rng.int(0, 9);
    const count = roll < 2 ? 0 : (roll < 7 ? 1 : (roll < 9 ? 2 : 3));
    for (let n = 0; n < count; n++) {
      const ws = rng.int(1, 8);
      const rect = someRect(rng);
      const client = makeClient(identityClass(id), ws, recordWsMon[ws], rng.chance(0.25),
        rect.at, rect.size);
      recordClients.push(client);
      running.push({ id, client });
    }
  }

  // Maybe one recorded tab group of 2-4 running apps, all pulled onto one
  // workspace, tiled, in a random tab order.
  let recordedGroupAddresses = [];
  if (running.length >= 2 && rng.chance(0.55)) {
    const size = Math.min(running.length, rng.int(2, 4));
    const members = rng.shuffle(running).slice(0, size);
    const ws = rng.int(1, 8);
    const order = members.map((m) => m.client.address);
    for (const m of members) {
      m.client.workspace = { id: ws, name: String(ws) };
      m.client.monitor = recordWsMon[ws];
      m.client.floating = false;
      m.client.grouped = order.slice();
    }
    // Held as ADDRESSES, not identity ids: two windows of one identity can be
    // tabbed into the same group now, and an id no longer names a window.
    recordedGroupAddresses = members.map((m) => m.client.address);
  }

  const layout = engine.buildLayout(recordClients, recordMonitors, identities, AT);

  // Which recorded entry each record-time window produced. The generator needs
  // it to ask "is THIS window recorded ungrouped?" — a question that used to be
  // answerable by identity and is not any more.
  const recordChosen = engine.chosenWindows(recordClients, identities, recordMonitors);
  const entryByAddress = {};
  for (const app of layout.apps) {
    const client = engine.windowForOccurrence(recordChosen, app.identityId, app.occurrence);
    if (client) entryByAddress[client.address] = app;
  }

  // The identity list the PLAN runs with: occasionally one identity has been
  // un-watched since the recording (identity-unknown -> skipped).
  let planIdentities = identities;
  if (rng.chance(0.25)) {
    const dropped = rng.pick(IDENTITY_IDS);
    planIdentities = identities.filter((i) => i.id !== dropped);
  }

  // Live monitors: usually the recorded set; sometimes one output is gone
  // (recorded-monitor-absent -> skipped).
  let liveMonitors = recordMonitors.map((m) => ({ ...m }));
  if (liveMonitors.length > 1 && rng.chance(0.2)) {
    liveMonitors = liveMonitors.slice(0, liveMonitors.length - 1);
  }

  // Live desktop: start from the record-time one, then drift it.
  const liveWsMon = {};
  const pickLiveMonitor = () => rng.pick(liveMonitors).id;
  const wsOf = (ws) => {
    if (liveWsMon[ws] === undefined) liveWsMon[ws] = pickLiveMonitor();
    return liveWsMon[ws];
  };

  let liveClients = [];
  const liveByRecordAddress = {};
  for (const c of recordClients) {
    if (rng.chance(0.2)) continue; // closed since the recording
    const ws = rng.chance(0.5) ? rng.int(1, 10) : c.workspace.id;
    const live = makeClient(c.class, ws, wsOf(ws), false);
    // Keep the same address so recorded groups can be re-created live.
    live.address = c.address;
    live.floating = rng.chance(0.3) ? !c.floating : c.floating;
    // The rect drifts on its own often enough to matter: sometimes exactly as
    // recorded (the op must NOT be planned), sometimes nudged inside the band
    // (still must not be planned), sometimes moved for real.
    const roll = rng.int(0, 2);
    if (roll === 0) {
      live.at = c.at.slice();
      live.size = c.size.slice();
    } else if (roll === 1) {
      // Inside the band, per axis. Rounding noise, not intent.
      live.at = [c.at[0] + rng.int(-2, 2), c.at[1] + rng.int(-2, 2)];
      live.size = [c.size[0] + rng.int(-2, 2), c.size[1] + rng.int(-2, 2)];
    } else {
      const rect = someRect(rng);
      live.at = rect.at;
      live.size = rect.size;
    }
    liveClients.push(live);
    liveByRecordAddress[c.address] = live;
  }

  // Live grouping. All live clients start ungrouped (the loop above); now
  // impose one of several shapes.
  const liveRecordedGroup = recordedGroupAddresses
    .map((address) => liveByRecordAddress[address] || null)
    .filter(Boolean);

  if (liveRecordedGroup.length >= 2) {
    const roll = rng.int(0, 3);
    if (roll <= 1) {
      // 0: the recorded group stands, right order. 1: wrong order.
      const order = roll === 0
        ? liveRecordedGroup.map((c) => c.address)
        : rng.shuffle(liveRecordedGroup).map((c) => c.address);
      const ws = rng.int(1, 10);
      for (const c of liveRecordedGroup) {
        c.workspace = { id: ws, name: String(ws) };
        c.monitor = wsOf(ws);
        c.floating = false;
        c.grouped = order.slice();
      }
    }
    // 2-3: scattered/ungrouped — already the state.
  }

  // A stray live group of windows the recording says are UNGROUPED — the
  // dissolve case. Only recorded-ungrouped, live-present windows qualify.
  const strayCandidates = liveClients.filter((c) => {
    if (c.grouped.length > 0) return false;
    const rec = entryByAddress[c.address];
    return rec && !rec.group;
  });
  if (strayCandidates.length >= 2 && rng.chance(0.5)) {
    const size = Math.min(strayCandidates.length, rng.int(2, 3));
    const members = rng.shuffle(strayCandidates).slice(0, size);
    const ws = rng.int(1, 10);
    const order = members.map((c) => c.address);
    for (const c of members) {
      c.workspace = { id: ws, name: String(ws) };
      c.monitor = wsOf(ws);
      c.floating = false;
      c.grouped = order.slice();
    }
  }

  // Unwatched strangers, sometimes tabbed into a live group.
  if (rng.chance(0.5)) {
    const ws = rng.int(1, 10);
    const stranger = makeClient("org.gnome.Nautilus", ws, wsOf(ws), false);
    const groups = liveClients.filter((c) => c.grouped.length > 1);
    if (groups.length > 0 && rng.chance(0.5)) {
      const host = rng.pick(groups);
      stranger.workspace = { ...host.workspace };
      stranger.monitor = host.monitor;
      const order = host.grouped.concat([stranger.address]);
      stranger.grouped = order;
      for (const c of liveClients) {
        if (host.grouped.indexOf(c.address) !== -1) c.grouped = order.slice();
      }
    }
    liveClients.push(stranger);
  }

  // Split-brain: one member of a live group under-reports its own array.
  const groupedLive = liveClients.filter((c) => c.grouped.length > 1);
  if (groupedLive.length > 0 && rng.chance(0.4)) {
    const victim = rng.pick(groupedLive);
    victim.grouped = rng.chance(0.5) ? [victim.address] : [];
  }

  return { layout, identities, planIdentities, liveMonitors, liveClients };
}

// ---------------------------------------------------------------- simulator

function makeSimulator(clients, monitors, identities) {
  const state = {
    clients: clients.map((c) => ({
      ...c,
      workspace: { ...c.workspace },
      grouped: c.grouped.slice(),
      at: c.at.slice(),
      size: c.size.slice()
    })),
    monitors,
    wsMon: wsMonitorMapOf(clients)
  };

  const byAddress = (address) => state.clients.find((c) => c.address === address) || null;

  // The monitor a workspace lives on, creating it on the "focused" (first)
  // monitor when it does not exist yet — the Hyprland behavior the
  // workspace-monitor op exists to correct.
  function monitorOfWs(ws) {
    if (state.wsMon[ws] === undefined) state.wsMon[ws] = state.monitors[0].id;
    return state.wsMon[ws];
  }

  // Everybody tangled into `address`'s group, by claims from either side —
  // what one group.toggle takes down.
  function claimSetOf(address) {
    const set = new Set([address]);
    const claims = engine.groupClaimants(state.clients, address);
    for (const a of claims) set.add(a);
    // Claims are one hop; close over the whole tangle.
    let grew = true;
    while (grew) {
      grew = false;
      for (const a of Array.from(set)) {
        for (const b of engine.groupClaimants(state.clients, a)) {
          if (!set.has(b)) {
            set.add(b);
            grew = true;
          }
        }
      }
    }
    return set;
  }

  function dissolveWhole(address) {
    if (!engine.isGroupClaimed(state.clients, address)) return;
    for (const a of claimSetOf(address)) {
      const c = byAddress(a);
      if (c) c.grouped = [];
    }
  }

  function moveClient(address, ws) {
    const c = byAddress(address);
    if (!c) return;
    // A grouped window's whole group moves with it.
    const movers = c.grouped.length > 1 ? c.grouped.slice() : [address];
    const mon = monitorOfWs(ws);
    for (const a of movers) {
      const m = byAddress(a);
      if (!m) continue;
      const moved = m.workspace.id !== ws;
      m.workspace = { id: ws, name: String(ws) };
      m.monitor = mon;
      // A workspace move re-clamps a floating window against the new
      // workspace's reserved area (live-measured, tick y29). This is exactly
      // why the geometry op runs last; if it did not, this line would break
      // the property.
      if (moved) displace(m, 3);
    }
  }

  function apply(op) {
    if (op.kind === "launch") {
      const identity = identities.find((i) => i.id === op.identityId);
      const cls = identity ? identityClass(identity.id) : "cls-unknown";
      const ws = 1;
      state.clients.push(makeClient(cls, ws, monitorOfWs(ws), false));
      return;
    }
    if (op.kind === "ungroup") {
      for (const address of op.addresses) dissolveWhole(address);
      return;
    }
    if (op.kind === "workspace-monitor") {
      const target = state.monitors.find((m) => m.name === op.monitorName);
      if (!target) return;
      state.wsMon[op.workspaceId] = target.id;
      for (const c of state.clients) {
        if (c.workspace.id !== op.workspaceId) continue;
        const moved = c.monitor !== target.id;
        c.monitor = target.id;
        // A float's rect is in GLOBAL layout coordinates, so a workspace that
        // changes monitor relocates every float on it — the same re-clamp a
        // per-window workspace move causes (tick y29), for the same reason.
        // Modeled here too, so "geometry runs last" is held against BOTH ops
        // that can displace a float and not just one of them.
        if (moved) displace(c, 5);
      }
      return;
    }
    if (op.kind === "move") {
      // TILED PLACEMENT IS FICTION HERE, AND IT IS SPELLED OUT (tick 35n).
      //
      // A move may carry a `splitParent`: the window whose tile this arrival
      // has to split, which the service turns into a focus dispatch in front
      // of the move. This simulator has no dwindle model — a tiled rect is a
      // number along for the ride (see the header) — so it cannot reproduce
      // the tree the choreography builds, and it does not pretend to. Nothing
      // below re-tiles anything.
      //
      // What it CAN check without a tiling model is the one property of the
      // program that would break it, and that no live symptom would reveal: a
      // parent must already BE on the destination workspace when its child
      // arrives. A program that focuses a window which is not there yet
      // focuses nothing, the arrival splits whatever dwindle falls back to,
      // and every dispatch still answers "ok". That is exactly the shape of
      // bug this file exists to catch — the into_group waiver in the header is
      // the same story told once already.
      //
      // So: placementOrderOf's pre-order property, asserted against the
      // PLANNER'S real output over 300 generated desktops rather than assumed.
      // 27 choreographed moves are reached at the committed seed — not a lot,
      // and enough: the first thing it caught was a split parent that was LIVE
      // FLOATING and therefore held no tile at all, which no amount of reading
      // the planner had found (see the gate test of the same name).
      if (op.splitParent) {
        const parent = byAddress(op.splitParent);
        assert.ok(parent, "a move named a split parent that is not on the desktop: " + op.splitParent);
        assert.equal(parent.workspace.id, op.workspaceId,
          "a move named a split parent that has not arrived yet: " + op.splitParent
            + " is on ws " + parent.workspace.id + ", not " + op.workspaceId);
        assert.ok(!parent.floating,
          "a move named a FLOATING split parent, which holds no tile: " + op.splitParent);
      }
      moveClient(op.address, op.workspaceId);
      return;
    }
    if (op.kind === "floating") {
      const c = byAddress(op.address);
      if (c && !!c.floating !== !!op.value) {
        c.floating = !!op.value;
        // A real float toggle hands the window a compositor-chosen rect. The
        // geometry op has to be able to survive that, which it does only
        // because it carries the RECORDED rect rather than a delta.
        displace(c, 7);
      }
      return;
    }
    if (op.kind === "geometry") {
      const c = byAddress(op.address);
      if (!c) return;
      // resize(size) then move(at): both absolute and both exact on live
      // hardware, so the pair nets out to the recorded rect. The planner
      // guarantees this window is a recorded float; assert it here rather than
      // trusting it, because a geometry op reaching a tiled window is the one
      // mistake this op could make that no dispatch answer would reveal.
      assert.ok(c.floating,
        "the simulator was handed a geometry op for a TILED window: " + op.address);
      c.size = op.size.slice();
      c.at = op.at.slice();
      return;
    }
    if (op.kind === "group") {
      // The service's rebuild, mechanically.
      const targets = engine.dissolveTargets(op.addresses, state.clients);
      for (const t of targets) dissolveWhole(t);

      const anchor = byAddress(op.addresses[0]);
      if (!anchor) return;
      let ring = [anchor.address];
      let focusedTab = anchor.address;
      anchor.grouped = ring.slice();

      for (let i = 1; i < op.addresses.length; i++) {
        const predecessor = op.addresses[i - 1];
        const joiner = byAddress(op.addresses[i]);
        if (!joiner) continue;
        // focus(predecessor) makes it the group's focused tab; focus(joiner)
        // then holds the keyboard; into_group inserts the ACTIVE window AFTER
        // the group's focused tab.
        focusedTab = predecessor;
        const at = ring.indexOf(focusedTab);
        ring = ring.slice(0, at + 1).concat([joiner.address]).concat(ring.slice(at + 1));
        // The joined window lands in the group: same workspace, tiled, and it
        // becomes the group's focused tab.
        joiner.workspace = { ...anchor.workspace };
        joiner.monitor = anchor.monitor;
        joiner.floating = false;
        focusedTab = joiner.address;
        for (const a of ring) {
          const m = byAddress(a);
          if (m) m.grouped = ring.slice();
        }
      }
      return;
    }
    if (op.kind === "split") {
      // MODELLED HONESTLY, which here means "modelled from the tree", because
      // for once the tree is reachable: the planner only ever emits this op for
      // a workspace whose live rects reconstruct to exactly one guillotine tree
      // (engine.singleFlipOf, behind the ambiguity refusal), so this file can
      // rebuild that tree and apply the compositor's own semantics instead of
      // guessing from rects.
      //
      // dwindle's `togglesplit` flips the FOCUSED window's parent node and
      // nothing else: the node's region is re-split on the other axis at the
      // same ratio, and each side's subtree is laid out again inside its new
      // box. Re-laying a subtree by scaling its box on each axis is not an
      // approximation — every descendant split keeps its orientation and its
      // ratio under an axis-wise affine map, which is exactly what the
      // compositor recomputes. The rounding is done on EDGES rather than on
      // sizes so two tiles that shared a line still share it afterwards.
      const subject = byAddress(op.address);
      assert.ok(subject, "the simulator was handed a split naming a window that is not here");
      assert.ok(!subject.floating,
        "the simulator was handed a split op for a FLOATING window: " + op.address);
      const peers = state.clients.filter(
        (c) => !c.floating && c.workspace.id === subject.workspace.id);
      const items = peers.map((c) => ({ key: c.address, at: c.at.slice(), size: c.size.slice() }));
      const tree = engine.splitTreeOf(items);
      assert.ok(tree, "a split op was planned for a workspace that is not a guillotine tiling");

      const leavesOf = (node, acc = []) => {
        if (!node) return acc;
        if (node.key !== undefined) { acc.push(node.key); return acc; }
        leavesOf(node.near, acc);
        leavesOf(node.far, acc);
        return acc;
      };
      const holds = (node, key) => leavesOf(node).indexOf(key) >= 0;

      // The node `togglesplit` would flip: the subject leaf's PARENT.
      let parent = null;
      for (let node = tree; node && node.key === undefined;) {
        const child = holds(node.near, op.address) ? node.near : node.far;
        if (child.key !== undefined) { parent = node; break; }
        node = child;
      }
      assert.ok(parent,
        "a split op named a window whose parent node is not the node that differs: " + op.address);

      const boxOf = (keys) => {
        const rects = keys.map((k) => byAddress(k));
        const lo = [Infinity, Infinity];
        const hi = [-Infinity, -Infinity];
        for (const r of rects) {
          for (const a of [0, 1]) {
            lo[a] = Math.min(lo[a], r.at[a]);
            hi[a] = Math.max(hi[a], r.at[a] + r.size[a]);
          }
        }
        return { at: lo, size: [hi[0] - lo[0], hi[1] - lo[1]] };
      };

      const nearKeys = leavesOf(parent.near);
      const farKeys = leavesOf(parent.far);
      const oldAxis = parent.axis;
      const newAxis = oldAxis === 0 ? 1 : 0;
      const nearBox = boxOf(nearKeys);
      const farBox = boxOf(farKeys);
      const region = boxOf(nearKeys.concat(farKeys));
      const gap = Math.max(0, farBox.at[oldAxis] - (nearBox.at[oldAxis] + nearBox.size[oldAxis]));
      const ratio = nearBox.size[oldAxis] / (nearBox.size[oldAxis] + farBox.size[oldAxis]);
      const span = Math.max(2, region.size[newAxis] - gap);
      const nearSpan = Math.max(1, Math.min(span - 1, Math.round(span * ratio)));

      const targetOf = (side) => {
        const at = region.at.slice();
        const size = region.size.slice();
        size[newAxis] = side === "near" ? nearSpan : span - nearSpan;
        if (side === "far") at[newAxis] = region.at[newAxis] + nearSpan + gap;
        return { at, size };
      };

      const relayout = (keys, from, to) => {
        for (const key of keys) {
          const c = byAddress(key);
          const at = c.at.slice();
          const size = c.size.slice();
          for (const a of [0, 1]) {
            const scale = from.size[a] > 0 ? to.size[a] / from.size[a] : 1;
            const near = Math.round(to.at[a] + (c.at[a] - from.at[a]) * scale);
            const far = Math.round(to.at[a] + (c.at[a] + c.size[a] - from.at[a]) * scale);
            at[a] = near;
            size[a] = Math.max(1, far - near);
          }
          c.at = at;
          c.size = size;
        }
      };
      relayout(nearKeys, nearBox, targetOf("near"));
      relayout(farKeys, farBox, targetOf("far"));
      return;
    }
    if (op.kind === "swap") {
      // EXACT, and modelled exactly. Tick or5 measured `hl.dsp.window.swap`
      // exchanging two tiles' rects and doing nothing else — no focus moved, no
      // divider moved, no workspace shown — so the model is the measurement.
      const a = byAddress(op.address);
      const b = byAddress(op.target);
      assert.ok(a && b, "the simulator was handed a swap naming a window that is not here");
      assert.notEqual(op.address, op.target, "a self-swap is refused by the compositor and must never be planned");
      assert.equal(a.workspace.id, b.workspace.id,
        "a swap crossed workspaces: " + op.address + " on " + a.workspace.id
          + ", " + op.target + " on " + b.workspace.id);
      const at = a.at; const size = a.size;
      a.at = b.at; a.size = b.size;
      b.at = at; b.size = size;
      return;
    }
    if (op.kind === "divider") {
      // MODELLED, WITH ITS LIMITS SAID OUT LOUD.
      //
      // What or5 measured, and what is faithful here: the ask lands EXACTLY on
      // the subject (it is the left/top child of the divider it moves — the
      // planner emits it for no other case), and the neighbour on the far side
      // of that divider absorbs the whole difference. Both are reproduced.
      //
      // What is fiction: there is no dwindle tree in this file, so "the
      // neighbour" is found geometrically — the nearest window whose near edge
      // is at or beyond the subject's far edge on that axis — and a real
      // divider drags a whole SUBTREE, not one window. On a two-window split
      // that is the same thing; on a deeper tree the model moves less of the
      // desktop than the compositor would.
      //
      // For convergence that is the conservative direction — the simulated
      // desktop converges no faster than the real one, so a plan that converges
      // here is not relying on help the compositor does not give. For
      // DIVERGENCE it is the unsafe one, and saying only "no help" hid that:
      // this model UNDER-STATES what a wrong nudge does. A real one aimed at
      // the far side of a split lands on 2 × current − asked and rescales
      // everything under that divider; here it would move one neighbour by one
      // delta. The assertion below is what keeps this honest — it refuses the
      // op rather than simulating it — but the guarantee itself is the
      // planner's, read off the tree, and cannot be demonstrated in this file.
      const subject = byAddress(op.address);
      assert.ok(subject, "the simulator was handed a divider naming a window that is not here");
      assert.ok(!subject.floating,
        "the simulator was handed a divider op for a FLOATING window: " + op.address);
      // ONE AXIS PER OP, which is the planner's rule and not a convenience
      // here: the other component of `size` is only the window's current
      // measurement on the axis this op is not moving.
      const axis = op.axis;
      assert.ok(axis === 0 || axis === 1, "a divider op with no axis: " + JSON.stringify(op));
      const delta = op.size[axis] - subject.size[axis];
      if (!delta) return;
      const farEdge = subject.at[axis] + subject.size[axis];
      let neighbour = null;
      const perp = axis === 0 ? 1 : 0;
      for (const c of state.clients) {
        if (c === subject || c.floating) continue;
        if (c.workspace.id !== subject.workspace.id) continue;
        if (c.at[axis] < farEdge) continue;
        // Overlapping on the OTHER axis, or the two tiles do not share a line.
        // The same test the planner makes (engine.farEdgeIsDivider) — stated
        // twice on purpose, so this assertion is a check on the planner rather
        // than a restatement of it.
        if (c.at[perp] >= subject.at[perp] + subject.size[perp]) continue;
        if (subject.at[perp] >= c.at[perp] + c.size[perp]) continue;
        if (!neighbour || c.at[axis] < neighbour.at[axis]) neighbour = c;
      }
      // No neighbour means the subject's far edge was the edge of the tiling,
      // which is precisely the case the sign law forbids the planner to emit.
      assert.ok(neighbour, "a divider op was aimed at the FAR side of its split: " + op.address);
      subject.size = subject.size.slice();
      subject.size[axis] += delta;
      neighbour.at = neighbour.at.slice();
      neighbour.size = neighbour.size.slice();
      neighbour.at[axis] += delta;
      neighbour.size[axis] = Math.max(1, neighbour.size[axis] - delta);
      return;
    }
    throw new Error("simulator: unknown op kind " + op.kind);
  }

  return { state, apply };
}

// ------------------------------------------------------------- the property

// `suppress` is the MUTATION HOOK: a kind of op to drop from every plan before
// it is simulated, as if planRestore had never learned to emit it. A property
// worth having must FAIL when the thing it is checking is removed, and each
// suppressed kind below is one this file would otherwise be free to pass
// without ever exercising. See the mutation test at the bottom.
//
// It also takes a FUNCTION, which is how the schema-v3 mutations are expressed:
// "never launch a second window of an identity" and "never move anything but
// the first occurrence" are not op KINDS, they are the shape a
// one-entry-per-identity planner would have had, and they are exactly what this
// file has to be able to notice.
function runCase(caseIndex, caseSeed, suppress) {
  const rng = makeRng(caseSeed);
  const { layout, planIdentities, liveMonitors, liveClients } = generateCase(rng);
  const tag = `case ${caseIndex} (seed 0x${caseSeed.toString(16)})`;

  const sim = makeSimulator(liveClients, liveMonitors, planIdentities);

  let plan = [];
  let previous = null;
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations++) {
    plan = engine.planRestore(sim.state.clients, liveMonitors, layout, planIdentities);
    if (typeof suppress === "function") {
      plan = suppress(plan, { clients: sim.state.clients, monitors: liveMonitors, layout, identities: planIdentities });
    } else if (suppress) {
      plan = plan.filter((op) => op.kind !== suppress);
    }
    assert.deepStrictEqual(
      engine.unknownPlanAddresses(plan, sim.state.clients), [],
      `${tag}: a plan named an address its own snapshot lacks`);
    if (plan.length === 0) break;
    if (previous !== null) {
      assert.ok(!engine.samePlan(plan, previous),
        `${tag}: no progress — the identical plan came back: ${engine.planSignature(plan)}`);
    }
    for (const op of plan) sim.apply(op);
    previous = plan;
  }
  assert.strictEqual(plan.length, 0,
    `${tag}: did not converge in ${MAX_ITERATIONS} iterations; still: ${engine.planSignature(plan)}`);

  // Independent match check, straight off the simulated state.
  // Schema v3: a recorded entry names ONE window of its identity, so every
  // lookup below has to go through the pairing rather than through the identity.
  // The pairing is the engine's own (there is no second way to decide which of
  // two identical windows is which) — but everything CHECKED through it is
  // still read straight off the simulated desktop, never off a drift report.
  const matched = engine.matchLayout(sim.state.clients, liveMonitors, layout, planIdentities);
  const chosen = { byId: matched.chosen.byId, idByAddress: matched.idByAddress };
  const windowAt = {};
  layout.apps.forEach((app, i) => { windowAt[i] = matched.clientByEntry[i]; });
  const windowFor = (app) => windowAt[layout.apps.indexOf(app)];

  // The pairing must be a BIJECTION. Two entries claiming one window would
  // satisfy every per-entry check below while leaving a window of that identity
  // sitting somewhere nobody asked for.
  const claimed = {};
  layout.apps.forEach((app, i) => {
    const window = matched.clientByEntry[i];
    if (!window) return;
    const key = engine.memberKeyFor(app.identityId, app.occurrence);
    assert.ok(!claimed[window.address],
      `${tag}: ${key} matched ${window.address}, already claimed by ${claimed[window.address]}`);
    claimed[window.address] = key;
  });

  const restorable = (app) => {
    if (!planIdentities.some((i) => i.id === app.identityId)) return false;   // identity-unknown
    if (!(app.monitorDescription || "").trim()) return false;                 // monitor-unknown
    if (!engine.monitorByDescription(liveMonitors, app.monitorDescription)) return false; // monitor-absent
    return true;
  };

  for (const app of layout.apps) {
    if (!restorable(app)) continue;
    const window = windowFor(app);
    assert.ok(window, `${tag}: ${app.identityId} should be running after the restore`);
    assert.strictEqual(window.workspace.id, app.workspaceId,
      `${tag}: ${app.identityId} on ws ${window.workspace.id}, recorded ws ${app.workspaceId}`);
    const label = engine.monitorLabel(engine.monitorByIndex(liveMonitors, window.monitor));
    assert.strictEqual(label, app.monitorDescription,
      `${tag}: ${app.identityId} on monitor "${label}", recorded "${app.monitorDescription}"`);
    assert.strictEqual(!!window.floating, !!app.floating,
      `${tag}: ${app.identityId} floating=${!!window.floating}, recorded ${!!app.floating}`);

    // A recorded FLOAT is back on its recorded pixels, within the band. A
    // recorded TILED window is deliberately NOT checked: its rect is an
    // outcome of a dwindle tree this simulator does not model, and the engine
    // is not allowed to plan for it either.
    if (app.floating && app.at && app.size) {
      const delta = engine.geometryDelta(
        { at: app.at, size: app.size },
        { at: window.at, size: window.size });
      assert.ok(engine.withinTolerance(delta, engine.GEOMETRY_TOLERANCE_PX),
        `${tag}: ${app.identityId} floats at [${window.at}] ${window.size}, `
        + `recorded [${app.at}] ${app.size} (delta ${JSON.stringify(delta)})`);
    }
  }

  // Groups: every recorded group must stand exactly, restricted to the members
  // that are restorable — and a recorded-ungrouped app must share no watched
  // group (a group of unwatched windows around it is deliberately not ours).
  const groupsById = {};
  for (const app of layout.apps) {
    if (!app.group) continue;
    (groupsById[app.group.groupId] = groupsById[app.group.groupId] || []).push(app);
  }
  for (const groupId of Object.keys(groupsById)) {
    const members = groupsById[groupId].slice().sort((a, b) => a.group.index - b.group.index);
    const present = members.filter((a) => restorable(a) && windowFor(a));
    if (present.length < 2) continue; // one window is not a tab group
    const wanted = present.map((a) => engine.memberKeyFor(a.identityId, a.occurrence)).join("+");
    for (const app of present) {
      const live = engine.groupMemberIds(
        windowFor(app), sim.state.clients, planIdentities, chosen.idByAddress);
      assert.strictEqual(live.join("+"), wanted,
        `${tag}: group ${groupId} reads ${live.join("+")} at ${app.identityId}, recorded ${wanted}`);
    }
  }
  for (const app of layout.apps) {
    if (app.group || !restorable(app)) continue;
    const window = windowFor(app);
    if (!window) continue;
    const members = engine.groupMemberIds(window, sim.state.clients, planIdentities, chosen.idByAddress);
    assert.ok(members.length <= 1,
      `${tag}: ${app.identityId} recorded ungrouped but shares a watched group: ${members.join("+")}`);
  }

  return iterations;
}

function caseSeeds(count) {
  const seedRng = mulberry32(SEED);
  const seeds = [];
  for (let i = 0; i < count; i++) seeds.push(Math.floor(seedRng() * 0xffffffff) >>> 0);
  return seeds;
}

test(`restore converges onto the recording across ${CASES} generated desktops (seed 0x${SEED.toString(16)})`, () => {
  const seeds = caseSeeds(CASES);
  let totalIterations = 0;
  let maxIterations = 0;
  for (let i = 0; i < CASES; i++) {
    const iterations = runCase(i, seeds[i]);
    totalIterations += iterations;
    maxIterations = Math.max(maxIterations, iterations);
  }
  // A sanity floor: if the generator ever degenerates into producing only
  // already-converged desktops, this property stops testing anything.
  assert.ok(totalIterations >= CASES,
    `only ${totalIterations} plan iterations across ${CASES} cases — the generator has gone flat`);
  assert.ok(maxIterations <= MAX_ITERATIONS, "bound respected");
});

// --------------------------------------------------------------- mutation
//
// A property that cannot fail proves nothing. Each op kind below is REMOVED
// from every plan and the whole suite is re-run; the property must break. This
// is the check that a passing run above is evidence and not a coincidence of
// the generator never producing the case — which is exactly how the group-join
// defect survived (see the header note): a waiver in this file said a mechanism
// always worked, and nothing here would have noticed if it never ran at all.

test("suppressing an op kind makes the property fail — for every kind that plans", () => {
  const seeds = caseSeeds(CASES);

  // Every kind planRestore can emit. Measured failure rates over the 300 cases
  // at the committed seed, as a record of how much of the generator each op
  // actually reaches: move 281, launch 187, floating 161, workspace-monitor
  // 150, geometry 136, group 130, ungroup 99. None of them is rare, and none
  // of the 1143 failures is a harness error.
  for (const kind of [
    "geometry", "floating", "ungroup", "move", "group", "workspace-monitor", "launch"
  ]) {
    let failed = false;
    let firstError = "";
    for (let i = 0; i < CASES && !failed; i++) {
      try {
        runCase(i, seeds[i], kind);
      } catch (error) {
        failed = true;
        firstError = String(error && error.message);
      }
    }
    assert.ok(failed,
      `dropping every "${kind}" op left the property GREEN — it is not being tested`);
    // And it must fail for a reason about the desktop, not because the harness
    // threw: a TypeError here would pass the check above while proving nothing.
    assert.ok(!/is not a function|undefined is not|Cannot read/.test(firstError),
      `dropping "${kind}" failed with a harness error rather than a property `
      + `violation: ${firstError}`);
  }
});

// ------------------------------------------- mutation: per-OCCURRENCE ops
//
// The mutations above drop whole op kinds. These two drop the part of an op
// kind that only exists because a record can name several windows of one
// identity — the second launch, the second window's move — which is the whole
// of what tick 9sl added. Without them, a planner that quietly went back to one
// entry per identity would still pass every check in this file.

const OCCURRENCE_MUTATIONS = {
  "a launch beyond the identity's first window": (plan, ctx) => plan.filter((op) => {
    if (op.kind !== "launch") return true;
    // Refuse to start a second window of an app that already has one — the
    // pre-v3 world, where an identity was either running or not.
    return !ctx.clients.some((c) => engine.matchClient(c, ctx.identities) === op.identityId);
  }),
  "a move of anything but occurrence 0": (plan, ctx) => {
    const matched = engine.matchLayout(ctx.clients, ctx.monitors, ctx.layout, ctx.identities);
    return plan.filter((op) => {
      if (op.kind !== "move") return true;
      const found = matched.idByAddress[op.address];
      return !found || found.occurrence === 0;
    });
  }
};

test("suppressing a per-occurrence op makes the property fail — launch and move", () => {
  const seeds = caseSeeds(CASES);

  for (const label of Object.keys(OCCURRENCE_MUTATIONS)) {
    let failed = false;
    let firstError = "";
    for (let i = 0; i < CASES && !failed; i++) {
      try {
        runCase(i, seeds[i], OCCURRENCE_MUTATIONS[label]);
      } catch (error) {
        failed = true;
        firstError = String(error && error.message);
      }
    }
    assert.ok(failed,
      `dropping ${label} left the property GREEN — multi-window restore is not being tested`);
    assert.ok(!/is not a function|undefined is not|Cannot read/.test(firstError),
      `dropping ${label} failed with a harness error rather than a property `
      + `violation: ${firstError}`);
  }
});

// ------------------------------------------------ the flip, through the simulator
//
// The generator makes arbitrary rects, not tilings, so a `split` op is not
// something the 300 cases above reliably produce — and a simulator branch that
// never runs is a branch nobody has checked. This is that check, directed: one
// two-window workspace recorded side by side and living stacked, driven through
// the same plan → apply → re-plan loop, with the same convergence and no-progress
// rules the property itself uses.

test("a flipped workspace converges through the simulator, in one dispatch", () => {
  const monitors = [{ ...MONITOR_POOL[0], x: 0, y: 0, width: 1440, height: 900, scale: 1,
    make: "T", model: "P", serial: "", activeWorkspace: { id: 1, name: "1" }, focused: true }];
  const identities = makeIdentities(["alpha", "bravo"]);

  const recorded = [
    makeClient(identityClass("alpha"), 5, 0, false, [12, 38], [701, 850]),
    makeClient(identityClass("bravo"), 5, 0, false, [727, 38], [701, 850])
  ];
  const layout = engine.buildLayout(recorded, monitors, identities, AT);

  // The same two windows, stacked — the root node's split flipped, which is
  // what SUPER+J does and what a stray click mid-choreography leaves behind.
  const live = recorded.map((c, i) => ({
    ...c,
    workspace: { ...c.workspace },
    grouped: [],
    at: i === 0 ? [12, 38] : [12, 470],
    size: [1416, 418]
  }));

  const sim = makeSimulator(live, monitors, identities);
  let plan = engine.planRestore(sim.state.clients, monitors, layout, identities);
  assert.deepStrictEqual(plan.map((op) => op.kind), ["split"],
    "the flip is the whole plan: nothing else is computable against a shape about to change");

  let iterations = 0;
  let previous = null;
  for (; iterations < MAX_ITERATIONS; iterations++) {
    plan = engine.planRestore(sim.state.clients, monitors, layout, identities);
    if (plan.length === 0) break;
    if (previous) {
      assert.ok(!engine.samePlan(plan, previous),
        "no progress — the identical plan came back: " + engine.planSignature(plan));
    }
    for (const op of plan) sim.apply(op);
    previous = plan;
  }
  assert.strictEqual(plan.length, 0, "did not converge: " + engine.planSignature(plan));

  // The shape is the recorded shape again — asked of the TREE, which is the
  // only thing a flip is about, and read straight off the simulated desktop.
  const shapeOf = (items) => JSON.stringify(engine.splitTreeOf(items), (key, value) =>
    key === "key" ? "-" : value);
  const asItems = (list) => list.map((c) => ({ key: c.address, at: c.at, size: c.size }));
  assert.strictEqual(
    shapeOf(asItems(sim.state.clients)),
    shapeOf(layout.apps.map((a, i) => ({ key: String(i), at: a.at, size: a.size }))),
    "the live split tree is the recorded split tree again");

  // …and a desk that already conforms still emits nothing at all.
  assert.deepStrictEqual(
    engine.planRestore(makeSimulator(recorded, monitors, identities).state.clients,
      monitors, layout, identities), []);
});
