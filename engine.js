// engine.js — the pure-JS brain of mkelk.dock-recall.
//
// Dual-runtime by design: plain top-level functions plus a trailing
// `module.exports` guard, so the same file runs under node (`node --test`)
// and is imported by QML as `import "engine.js" as Engine`. Constraints that
// follow from that: no ES modules, no `.pragma`, no `require()` of anything,
// no dependencies. See
// /usr/share/omarchy/shell/plugins/services/battery/BatteryModel.js for the
// first-party idiom.
//
// Everything here is a pure function over plain data:
//   - clientsJson  — `hyprctl clients -j`
//   - monitorsJson — `hyprctl monitors all -j`
//   - layout       — a previously recorded layout record
// No I/O, no clocks, no dispatching. The QML service does all of that.

// ---------------------------------------------------------------------------
// Monitors: stable identity, and resolving the index clients report
// ---------------------------------------------------------------------------

// Separator between monitor labels in a topology key. Chosen because monitor
// descriptions are free text ("Samsung Display Corp. ATNA60HR07-0") but never
// contain a pipe.
var TOPOLOGY_SEPARATOR = " | ";

// The stable name for a monitor.
//
// `serial` is deliberately never consulted: the built-in panel (eDP-1) reports
// an empty serial, so any key built from serials collides the moment a second
// serial-less output appears. `description` is the good identifier, but it too
// can be empty — a headless output created with `hyprctl output create
// headless hw-test` has none — so fall back to `name`.
function monitorLabel(monitor) {
  if (!monitor) return "";
  var description = (monitor.description || "").trim();
  if (description) return description;
  return (monitor.name || "").trim();
}

// A stable string identifying "this monitor setup".
//
// Sorted, so it does not depend on the order hyprctl happens to list monitors
// in — that order follows connection sequence and renumbers across hotplug.
//
// NOTE: monitors are counted as listed by `hyprctl monitors all -j`, which
// includes monitors that are present but disabled (clamshell mode disables
// eDP-1 rather than removing it). Physically unplugged monitors disappear from
// the list entirely, so dock/undock is covered; whether a disabled monitor
// should count as a different topology is an open question for the service.
function topologyKey(monitorsJson) {
  var monitors = monitorsJson || [];
  var labels = [];
  for (var i = 0; i < monitors.length; i++) {
    var label = monitorLabel(monitors[i]);
    if (label) labels.push(label);
  }
  labels.sort();
  return labels.join(TOPOLOGY_SEPARATOR);
}

// Resolve the `monitor` field of a client (an id/index, unstable across
// hotplug) to the monitor object it refers to. Returns null when the monitor
// is gone.
function monitorByIndex(monitorsJson, idx) {
  var monitors = monitorsJson || [];
  if (idx === null || idx === undefined) return null;
  for (var i = 0; i < monitors.length; i++) {
    if (monitors[i].id === idx) return monitors[i];
  }
  return null;
}

// Resolve a recorded monitor label (see monitorLabel) back to a live monitor
// object. Returns null when the recorded monitor is not part of the current
// topology — callers treat that as "skip this app".
//
// TWIN IDENTICAL MONITORS: a matched pair reports the SAME description on both
// connectors, and this answers with the FIRST one in the list. That is schema
// v2's documented refusal rather than an oversight (tick ojr, state-matrix §3):
// AppPlacement carries `monitorDescription` and nothing else about the output,
// so a record cannot say which twin it meant and this cannot invent it. The
// consequences are pinned by tests rather than left to be discovered — a window
// moved between twins is not drift (the labels are equal, so the comparison
// sees nothing), and a workspace recorded on the second twin is restored onto
// the first. Fixing it is a SCHEMA question, deferred to epic 69b's v3.
function monitorByDescription(monitorsJson, desc) {
  var monitors = monitorsJson || [];
  var wanted = (desc || "").trim();
  if (!wanted) return null;
  for (var i = 0; i < monitors.length; i++) {
    if (monitorLabel(monitors[i]) === wanted) return monitors[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// App identity: which window is "the app I ticked"
// ---------------------------------------------------------------------------
//
// An identity is { id: "obsidian", patterns: ["(^|\\.)obsidian(\\.|$)"] }.
// Patterns are regex *strings* (so the list is plain JSON on disk) matched
// case-insensitively against a client's `class` AND its `initialClass`.
//
// Why a list of patterns and not one literal class:
//   - Classes are renamed between Omarchy versions. Obsidian became
//     `md.obsidian.Obsidian` in Quattro and silently broke a working script;
//     one identity carries patterns for both spellings.
//   - Chromium webapps get synthesized classes like
//     `chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1`, whose
//     tail varies by profile and URL. Only a prefix pattern survives them.
//   - A window's `class` can change at runtime while `initialClass` does not
//     (and vice versa), so both fields are consulted.
//
// An identity may ALSO carry `titlePatterns: ["^herdr$"]` — regex strings in the
// same shape, matched case-insensitively against `initialTitle` and nothing
// else. It exists for a TUI app in a plain terminal: `herdr` running in `foot`
// has class `foot` like every other terminal, and `foot --title=herdr herdr`
// gives the window `initialTitle: "herdr"` while the class stays `foot`, so the
// host's window rules keep matching it. Two rules hold this together:
//   - `titlePatterns` is OPT-IN and separate from `patterns`. Feeding
//     `initialTitle` into the `patterns` loop would let every existing class
//     pattern start claiming windows by their title (the `obsidian` identity
//     would swallow a terminal titled "obsidian").
//   - It is matched against `initialTitle` ONLY, never `title`. Live titles
//     change constantly — an app renaming itself moves only `title`, while
//     `initialTitle` is fixed at map time — and matching them would make a
//     window's identity time-varying, which is the exact failure mode this
//     design exists to avoid. Never against `class`/`initialClass` either.
//
// WHEN BOTH LISTS ARE PRESENT THE RULE IS AND. An EMPTY list means "no
// constraint on this axis"; a NON-EMPTY one is a constraint that has to be
// satisfied:
//
//   patterns    titlePatterns   matches when
//   ---------   -------------   ---------------------------------------------
//   non-empty   non-empty       BOTH sides match — the class side against
//                               `class`/`initialClass`, the title side against
//                               `initialTitle`
//   non-empty   empty           the class side alone
//   empty       non-empty       the title side alone
//   empty       empty           never
//
// AND rather than OR because `{patterns: ["^foot$"], titlePatterns: ["^herdr$"]}`
// is what a person writes to mean "the foot window titled herdr", and under OR
// that identity would claim EVERY foot window instead. A list of nothing but
// broken patterns is still a constraint (it is not empty), so it can never be
// satisfied. One consequence is worth saying out loud, and is pinned by a test
// in tests/identity.test.js: when `titlePatterns` is non-empty and the client
// has no usable `initialTitle`, the title side fails and the identity does not
// match at all — a satisfied class side cannot rescue it.
//
// Identity order stays priority order, so a title identity must sit BEFORE the
// catch-all terminal identity that would otherwise claim its window first.

// Compile a pattern string. A user-editable list can contain a typo; a bad
// regex must not take the whole engine down, so it simply never matches.
function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch (e) {
    return null;
  }
}

// A pattern list, or an empty one. ES5, and no assumption about the QML JS
// engine's Array.isArray — the same test StateModel and PanelModel use. The
// guard matters: `identity.patterns || []` hands a bare STRING to the loop
// below, which then iterates it by characters, so `"zzh"` would match "herdr"
// through /h/i. normalizeIdentity coerces a bare string into a one-element list
// before it can get here, but a hand-built identity does not go through it, and
// a list that is not a list is no constraint rather than a nonsense one.
function patternList(value) {
  return Object.prototype.toString.call(value) === "[object Array]" ? value : [];
}

// A map lookup Object.prototype cannot answer — see the long note above
// `own` in StateModel.js. Every index in this file keyed by an identity id, a
// group id or a member key reads through this, because `map["constructor"]` on
// a bare object is truthy whether or not anything was put there (tick 8hp).
function own(map, key) {
  if (!map) return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// Does any pattern in the list match any of these fields? An empty or
// all-broken list is a no.
function anyPatternMatches(patterns, fields) {
  for (var p = 0; p < patterns.length; p++) {
    var re = compilePattern(patterns[p]);
    if (!re) continue;
    for (var f = 0; f < fields.length; f++) {
      var value = fields[f];
      if (typeof value === "string" && value && re.test(value)) return true;
    }
  }
  return false;
}

// Does this client belong to this identity? See the rule table above: a
// non-empty list is a constraint, an empty one is not, and every constraint
// present has to be satisfied.
function clientMatchesIdentity(client, identity) {
  if (!client || !identity) return false;

  var patterns = patternList(identity.patterns);
  // Opt-in, and deliberately a separate axis over a single field:
  // `initialTitle` only — never `title` (a live title makes identity
  // time-varying), never `class`/`initialClass` (that is what `patterns` is
  // for).
  var titlePatterns = patternList(identity.titlePatterns);

  // An identity that constrains nothing claims nothing.
  if (patterns.length === 0 && titlePatterns.length === 0) return false;

  if (patterns.length > 0 &&
      !anyPatternMatches(patterns, [client.class, client.initialClass])) return false;
  if (titlePatterns.length > 0 &&
      !anyPatternMatches(titlePatterns, [client.initialTitle])) return false;

  return true;
}

// The id of the first identity this client belongs to, or null when the client
// is not watched. Identity order is priority order: put the specific webapp
// identities before a catch-all browser identity.
function matchClient(client, identities) {
  var list = identities || [];
  for (var i = 0; i < list.length; i++) {
    if (clientMatchesIdentity(client, list[i])) return list[i].id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SHADOWED IDENTITIES — an identity that can never win, said out loud
// ---------------------------------------------------------------------------
//
// matchClient is first-match-wins across the WHOLE list, and the panel's
// toggleWatchedIdentities PREPENDS. Put together, that is a reachable way to
// lose an answer silently: a user with a working
// `{patterns:["^foot$"], titlePatterns:["^herdr$"]}` identity later ticks a
// plain foot terminal, a fresh `^foot$` identity goes in FRONT of it, and every
// herdr window quietly becomes "terminal". The record binds it wrong, a restore
// launches the wrong command, and the chip shows the wrong name — so even
// unticking removes the wrong identity. Nothing anywhere says so.
//
// This does NOT change the priority rule and does not reorder anything: list
// order stays the contract. It only NAMES the state, because a silent wrong
// answer is the thing this project refuses to ship.
//
// WHY IT ASKS THE DESKTOP RATHER THAN THE PATTERNS. Whether one regex claims a
// superset of another's windows is not a question a regex engine can answer, so
// a static "does `^foot$` subsume `^foot$` + `^herdr$`?" analysis would be a
// guess wearing a proof. The live window list is evidence: an identity that
// matches windows and wins none of them has demonstrably lost, right now, on
// this desktop. It is also the only version of the question the user can act
// on — the windows are on screen in front of them.
//
// Note what this is NOT: PanelModel's identityClaimsSame is the DUPLICATE
// guard, and it decides whether two rules are the SAME rule (an exact match on
// both axes) so a proposal can be refused before it is written. Shadowing is
// the asymmetric relation that guard deliberately lets through — `^foot$`
// already watched does not stop `^foot$` + `^herdr$` being proposed, and must
// not, since the narrow one is prepended in front of it. This function catches
// the case where the list ended up the other way round.
//
// WHICH DIRECTION IS THE BAD ONE, re-derived from the v4 AND rule. An identity
// that constrains BOTH axes is strictly narrower than one constraining only the
// class, because every constraint present has to be satisfied (see the rule
// table above). So:
//
//   in front           behind                      can the front one shadow it?
//   -----------------  --------------------------  ----------------------------
//   ^foot$             ^foot$ + title ^herdr$      YES — it claims every foot
//                                                  window, titled or not. This
//                                                  is the hazard.
//   ^foot$ + ^herdr$   ^foot$                      NO — it only ever takes the
//                                                  ONE titled window; plain
//                                                  terminals still fall through.
//
// That asymmetry is decidable WITHOUT deciding regex subsumption, from which
// AXES each side constrains: an identity that constrains an axis its rival
// leaves free is asking for something strictly narrower on that axis and can
// never claim everything the rival does. So a claimant counts only when its
// constrained axes are a SUBSET of the shadowed identity's.
//
// Without that test the detector would cry wolf on the ordinary correct desk: a
// user whose herdr identity sits properly in front of `terminal`, with herdr
// running and no plain terminal open, would be told `terminal` never matches —
// true this second, false the moment they open a terminal, and a panel that
// says a working rule is broken is the same class of wrong answer this is
// supposed to remove.
//
// THE AXIS TEST IS NOT ENOUGH ON ITS OWN (tick ytt). It fixed the wolf-cry
// across axes and cannot see breadth WITHIN one, so the same false alarm came
// back class-against-class:
//
//   [ { id: "browser", patterns: ["^chromium$"] },
//     { id: "slack",   patterns: ["^chrome-app\\.slack\\.com", "^chromium$"] } ]
//
// — the exact shape StateModel's schema comment mandates — with only the plain
// chromium window open. `browser` takes it, slack wins nothing, and the axis
// test says browser is wide enough, so the panel painted an urgent line saying
// to reorder or untick. Slack's OTHER pattern claims windows browser can never
// see; open the webapp and slack wins fine. Following that advice would have
// broken a correct configuration.
//
// So a second, still evidence-free-of-guesses test: do the claimants TOGETHER
// constrain at least what the shadowed identity constrains, pattern for pattern
// (claimantsCover)? A pattern of the shadowed identity that no claimant carries
// is room the claimants cannot reach, and an identity with room to grow into is
// idle, not dead. The union rather than each claimant on its own, because a
// two-pattern identity really can be shadowed by two one-pattern identities
// between them — see the workbench test.
//
// KNOWN LIMIT, and it is the same root cause: patterns are compared as STRINGS,
// so `^chrome-` in front of `^chrome-app\.slack\.com` is not seen to cover it
// and a genuine shadow there goes unreported. That direction is the safe one —
// silence rather than a false alarm about a working desk — and closing it means
// deciding regex subsumption, which is not decidable and would be a guess
// wearing a proof. The same limit reads the other way for a vacuously broad
// axis: `{patterns:["^foot$"], titlePatterns:[".*"]}` in front of a plain
// `{^foot$}` genuinely wins every foot window forever, and is not reported,
// because `.*` counts as a constrained axis. Both are reachable only by hand
// editing, and both are deliberately left alone.
//
// The rest of the rules, all earned:
//   - an identity that wins even ONE live window is not shadowed. A partial
//     loss is an ordering the user may well have meant; only a total one is a
//     rule that cannot fire.
//   - an identity with NO live match is never called shadowed. Its app is not
//     running, there is no evidence either way, and a refusal without evidence
//     is the guess this exists to avoid.
//   - an earlier identity carrying the SAME id is not a shadower. matchClient
//     still answers with that id, so nothing observable was lost (a duplicate
//     id is StateModel's dedupe problem, not a matching one).
//
// Returns [ { id, windows, claimed, claimedBy, strict } ] in list order:
//
//   windows    how many live windows the identity matches
//   claimed    how many of them a NAMED claimant took. Lower than `windows`
//              when an earlier identity that failed the tests above took the
//              rest — which is why it is counted separately: the sentence names
//              the claimants, so its number has to be theirs (tick ytt).
//   claimedBy  the earlier identities that took them AND could shadow it, in
//              LIST order rather than the order hyprctl listed the windows, so
//              two reads of one unchanged desktop agree.
//   strict     whether every claimant constrains STRICTLY FEWER axes than the
//              shadowed identity. Only then is "move it up, or untick the other
//              one" provably safe advice; otherwise the evidence supports an
//              observation and no more. PanelModel.shadowNoticeFor is where
//              that distinction becomes two different sentences.

// Which axes an identity constrains. An empty list is no constraint; see the
// rule table above.
function constrainedAxes(identity) {
  return {
    cls: patternList(identity.patterns).length > 0,
    title: patternList(identity.titlePatterns).length > 0
  };
}

// Could `earlier` claim everything `later` claims? Only if it constrains no
// axis that `later` leaves free.
//
// The AXIS half of the question, and the whole of it for a caller that is only
// asking about the relation between two rules — PanelModel's insert position
// is one. shadowedIdentities asks claimantsCover as well.
function couldShadow(earlier, later) {
  var a = constrainedAxes(earlier);
  var b = constrainedAxes(later);
  return (!a.cls || b.cls) && (!a.title || b.title);
}

// Does `earlier` constrain strictly FEWER axes than `later` — is it wider by
// construction rather than merely wide enough? That is the case where telling
// the user to move `later` up costs `earlier` nothing it can still claim.
function strictlyWider(earlier, later) {
  var a = constrainedAxes(earlier);
  var b = constrainedAxes(later);
  return (!a.cls && b.cls) || (!a.title && b.title);
}

// Do these claimants, together, carry every pattern `identity` constrains on
// this axis? An empty list on a claimant is NO constraint on that axis, which
// covers everything; an empty list on the identity is nothing to cover.
// Compared case-insensitively, because compilePattern always compiles that way.
function axisCovered(claimants, identity, key) {
  var wanted = patternList(identity[key]);
  if (wanted.length === 0) return true;

  for (var w = 0; w < wanted.length; w++) {
    if (typeof wanted[w] !== "string") continue;
    var want = wanted[w].toLowerCase();
    var found = false;
    for (var c = 0; c < claimants.length && !found; c++) {
      var have = patternList(claimants[c][key]);
      if (have.length === 0) { found = true; break; }
      for (var h = 0; h < have.length; h++) {
        if (typeof have[h] === "string" && have[h].toLowerCase() === want) { found = true; break; }
      }
    }
    if (!found) return false;
  }
  return true;
}

function claimantsCover(claimants, identity) {
  return axisCovered(claimants, identity, "patterns")
    && axisCovered(claimants, identity, "titlePatterns");
}

function shadowedIdentities(clientsJson, identities) {
  var clients = clientsJson || [];
  var list = identities || [];
  var out = [];

  // From 1: the first identity has nothing in front of it to lose to.
  for (var i = 1; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;

    var matched = 0;
    var claimed = 0;
    var wins = false;
    var claimedAt = [];

    for (var c = 0; c < clients.length; c++) {
      var client = clients[c];
      if (!clientMatchesIdentity(client, identity)) continue;
      matched += 1;

      var winner = -1;
      for (var e = 0; e < i; e++) {
        if (clientMatchesIdentity(client, list[e])) { winner = e; break; }
      }
      // No earlier claimant, or one wearing this very id: the identity's id is
      // what matchClient answers for this window, so it has lost nothing.
      if (winner < 0 || list[winner].id === identity.id) { wins = true; break; }
      if (!couldShadow(list[winner], identity)) continue;
      // Counted here rather than from `matched`: a window taken by an earlier
      // identity that is NOT one of the claimants is not the claimants' doing,
      // and the sentence names the claimants.
      claimed += 1;
      if (claimedAt.indexOf(winner) < 0) claimedAt.push(winner);
    }

    // Every window gone, and at least one of the identities that took them is
    // wide enough to keep taking them.
    if (wins || matched === 0 || claimedAt.length === 0) continue;

    claimedAt.sort(function (a, b) { return a - b; });
    var claimants = [];
    var claimedBy = [];
    var strict = true;
    for (var k = 0; k < claimedAt.length; k++) {
      var claimant = list[claimedAt[k]];
      claimants.push(claimant);
      if (!strictlyWider(claimant, identity)) strict = false;
      var id = claimant.id;
      if (typeof id === "string" && id && claimedBy.indexOf(id) < 0) claimedBy.push(id);
    }
    if (claimedBy.length === 0) continue;
    // The claimants have to reach everywhere this identity does. Where they do
    // not, its emptiness is what happens to be open — not a rule that cannot
    // fire — and saying otherwise breaks a correct desk.
    if (!claimantsCover(claimants, identity)) continue;

    out.push({
      id: identity.id,
      windows: matched,
      claimed: claimed,
      claimedBy: claimedBy,
      strict: strict
    });
  }

  return out;
}

// The first client belonging to an identity, in the order hyprctl listed them,
// or null when the app is not running.
//
// NOT what the record uses any more: choosing an identity's window is
// pickClientFor's job, because "first in hyprctl order" picks a window that can
// contradict the group the record is about to describe (see the bug note
// there). This stays for the question it is actually good at — "has a window of
// this app appeared yet?", asked by the launch poll in Service.qml, where any
// window is a yes.
//
// `identities` is the FULL watched list, and passing it is what makes identity
// order priority order at RECORD time, not just in matchClient(). A client is
// resolved to exactly one identity — matchClient's first match — so a catch-all
// `^chrome` identity sitting behind the specific webapp identities never also
// claims the Gmail window: without this, one window records under two
// identities, and a grouped window records with `group.index: -1` because the
// group's member ids (which do go through matchClient) never mention the
// catch-all.
//
// Omitting `identities` matches this identity alone. That is the same answer
// whenever no other identity competes for the window, and it keeps the function
// usable as a one-identity question.
function firstClientFor(clientsJson, identity, identities) {
  var candidates = clientsFor(clientsJson, identity, identities);
  return candidates.length ? candidates[0] : null;
}

// EVERY client belonging to an identity, in the order hyprctl listed them.
// One identity commonly has several windows: two Slack webapp windows, a
// second Obsidian vault, three terminals.
function clientsFor(clientsJson, identity, identities) {
  var clients = clientsJson || [];
  var out = [];
  if (!identity) return out;
  var list = identities || [identity];
  for (var i = 0; i < clients.length; i++) {
    if (matchClient(clients[i], list) === identity.id) out.push(clients[i]);
  }
  return out;
}

// How many windows of an identity are open right now.
//
// The number the launch coordinator holds out for: with a deficit of two, the
// service dispatches one launch and waits for THIS to reach the count it was at
// plus one before dispatching the next. Waiting for "a window exists" instead —
// which is all a single-window restore ever needed — would let the second
// launch fire while the first window was still the only one on screen, and the
// pass would end believing both had landed.
function liveWindowCount(clientsJson, identity, identities) {
  return clientsFor(clientsJson, identity, identities).length;
}

// The launch intents a plan carries, per identity, in the order they first
// appear:  [ { identityId, count } ].
//
// planRestore emits ONE launch op per missing recorded occurrence, so `count`
// IS the deficit — how many more windows of that app the recording wants than
// the desktop has. A deficit of one is the shape every plan had before schema
// v3 and stays byte-identical; anything above one is what the serial launch
// coordination in Service.qml exists for.
function launchDeficits(plan) {
  var list = plan || [];
  var order = [];
  var byId = {};
  for (var i = 0; i < list.length; i++) {
    var op = list[i];
    if (!op || op.kind !== "launch") continue;
    var id = op.identityId;
    if (typeof id !== "string" || !id) continue;
    if (own(byId, id) === undefined) {
      byId[id] = order.length;
      order.push({ identityId: id, count: 0 });
    }
    order[own(byId, id)].count += 1;
  }
  return order;
}

// The deficit for ONE identity in a plan, or 0.
function launchDeficitFor(plan, identityId) {
  var deficits = launchDeficits(plan);
  for (var i = 0; i < deficits.length; i++) {
    if (deficits[i].identityId === identityId) return deficits[i].count;
  }
  return 0;
}

// How many OTHER watched identities have a window in this client's group.
//
// Deliberately asked WITHOUT the chosen-window filter: this is the question
// that decides which window gets chosen, so it cannot depend on the answer.
function watchedPeerCount(client, clientsJson, identities, selfId) {
  var ids = groupMemberIds(client, clientsJson, identities);
  var count = 0;
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] !== selfId) count += 1;
  }
  return count;
}

// THE one window that represents an identity, for the callers that still need
// exactly one: the panel's per-identity chip and position row (Panel.qml), and
// the record-time tie-break tests that pin this function's own history.
//
// NOT what the record uses any more. Since schema v3 the record describes EVERY
// window of an identity (chosenWindows, below), so there is no choosing left to
// do there and the group-aware tie-break this function exists for has nothing
// to disambiguate: both windows are recorded, each at its own occurrence.
//
// It is kept, and kept tested, because the reasoning below is still the right
// answer to the question it asks — and because the panel asks it.
//
// The bug that taught us (user gate finding 4, live): the Slack identity
// matched TWO windows — a lone one on workspace 9 and one tabbed into the
// messenger group on workspace 10. firstClientFor picked the workspace 9
// window for Slack's own entry (group: null), while the group membership
// recorded for Telegram and WhatsApp was derived from the workspace 10 window
// and therefore listed "slack" as member 1. The result was a group of three
// with indexes 0 and 2 — a hole no restore can ever fill, because the identity
// named at index 1 is recorded as living somewhere else entirely.
//
// So the choice is GROUP-AWARE: among an identity's windows, the one that
// shares a tab group with the most other watched identities wins. Ties, and
// the overwhelmingly common single-window case, keep the old "first in hyprctl
// order" answer, so nothing that was not already ambiguous changes.
function pickClientFor(clientsJson, identity, identities) {
  var candidates = clientsFor(clientsJson, identity, identities);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  var best = candidates[0];
  var bestScore = watchedPeerCount(candidates[0], clientsJson, identities, identity.id);
  for (var i = 1; i < candidates.length; i++) {
    var score = watchedPeerCount(candidates[i], clientsJson, identities, identity.id);
    if (score > bestScore) {
      best = candidates[i];
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// THE PLACEMENT ORDER — the one deterministic order over windows
// ---------------------------------------------------------------------------
//
// Schema v3 records every window of an identity and labels each with an
// `occurrence`. That number has to mean the same thing on two reads of an
// unchanged desktop, or a record taken twice would disagree with itself and a
// restore would shuffle windows for no reason. hyprctl's listing order is NOT
// that: it follows creation and focus history, so closing and reopening a
// window renumbers the identity's windows without anything moving.
//
// So occurrence is assigned in a WHERE-THE-WINDOW-IS order, most significant
// first:
//
//   1. the monitor's LOGICAL POSITION, x then y — left-to-right across the
//      desk, and not the monitor INDEX, which renumbers on hotplug
//   2. the workspace id
//   3. the window's own top-left, x then y
//   4. the window ADDRESS, as the final tie-break — arbitrary, but total: two
//      windows can share a monitor, a workspace and a rect (a stack of floats
//      dropped on the same pixel), and an order that stops before this one is
//      not an order.
//
// This is ONE comparator with two callers by design: the recorder assigns
// occurrences with it (chosenWindows) and the restore matcher pairs leftover
// live windows to leftover recorded occurrences with it (matchOccurrences). Two
// copies would drift apart on the first edit, and the symptom would be a
// restore that swaps two windows on every pass.
//
// `monitorsJson` is optional. Without it — or when a client's monitor index
// resolves to nothing — the monitor's index stands in for its position: still
// deterministic, just not spatial. Callers that have the monitor list should
// always pass it.
function placementKeyOf(client, monitorsJson) {
  var c = client || {};
  var haveMonitors = Object.prototype.toString.call(monitorsJson) === "[object Array]"
    && monitorsJson.length > 0;
  var mon = monitorByIndex(monitorsJson, c.monitor);
  var mx = (mon && typeof mon.x === "number" && isFinite(mon.x)) ? mon.x : null;
  var my = (mon && typeof mon.y === "number" && isFinite(mon.y)) ? mon.y : 0;
  if (mx === null) {
    // With a monitor list in hand, a client whose monitor is not in it sorts
    // LAST — its position is genuinely unknown, and borrowing the index would
    // mix a small integer in among pixel coordinates and put the orphan
    // somewhere in the middle of the desk. With NO monitor list, the index is
    // the only monitor fact there is, and every client is measured by it.
    mx = haveMonitors
      ? Infinity
      : ((typeof c.monitor === "number" && isFinite(c.monitor)) ? c.monitor : Infinity);
    my = 0;
  }
  var ws = (c.workspace && typeof c.workspace.id === "number" && isFinite(c.workspace.id))
    ? c.workspace.id : Infinity;
  var at = geometryPair(c.at);
  return {
    monitorX: mx,
    monitorY: my,
    workspaceId: ws,
    x: at ? at[0] : Infinity,
    y: at ? at[1] : Infinity,
    address: typeof c.address === "string" ? c.address : ""
  };
}

// Compare two placement keys. Unknown values sort LAST (Infinity), and two
// unknowns compare equal, so a read that omitted a field degrades the order
// rather than randomizing it.
function comparePlacementKeys(a, b) {
  if (a.monitorX !== b.monitorX) return a.monitorX < b.monitorX ? -1 : 1;
  if (a.monitorY !== b.monitorY) return a.monitorY < b.monitorY ? -1 : 1;
  if (a.workspaceId !== b.workspaceId) return a.workspaceId < b.workspaceId ? -1 : 1;
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return 0;
}

// The comparator itself, over CLIENTS, bound to a monitor list. Pass the result
// to Array.prototype.sort.
function placementComparator(monitorsJson) {
  return function (a, b) {
    return comparePlacementKeys(placementKeyOf(a, monitorsJson), placementKeyOf(b, monitorsJson));
  };
}

// The KEY that names one recorded window: an identity plus which of its windows
// this is.
//
// Occurrence 0 is spelled as the bare identity id, deliberately. It is what
// every pre-v3 record meant, so every groupId, every panel row key and every
// stored string built out of these keys is byte-identical to the one the single
// window case produced before v3 — the whole multi-window feature costs a
// single-window desktop nothing, in the file or on the screen.
function memberKeyFor(identityId, occurrence) {
  var n = occurrenceOf(occurrence);
  return n ? identityId + "#" + n : identityId;
}

// A recorded `occurrence` as a number this code can index with: a non-negative
// integer, and 0 for everything else.
//
// The twin of StateModel.normalizeOccurrence, and it has to STAY the twin — the
// record side and the read side are two independent ES5 files that may not
// import each other, so the agreement is pinned by a test. It is repeated here
// because driftOf is handed layouts that never went through the file (the
// panel's preview, a test's hand-built record), and a fractional label reaching
// an array index would be a silent miss rather than a loud one.
function occurrenceOf(value) {
  var n = value;
  if (typeof n === "string") {
    var trimmed = n.replace(/^\s+|\s+$/g, "");
    n = trimmed ? Number(trimmed) : NaN;
  }
  if (typeof n !== "number" || !isFinite(n)) return 0;
  if (n < 0) return 0;
  if (Math.floor(n) !== n) return 0;
  return n;
}

// The identity half of a member key.
//
// An identity id that itself ends in "#<digits>" is ambiguous here and reads as
// identity + occurrence. Identity ids are user-chosen handles ("gmail",
// "terminal") and nothing generates that shape, so the ambiguity is documented
// rather than escaped — escaping would put a backslash into every groupId on
// disk to defend against a name nobody writes.
function memberIdentityOf(key) {
  var s = String(key === undefined || key === null ? "" : key);
  var hash = s.lastIndexOf("#");
  if (hash <= 0) return s;
  var tail = s.substring(hash + 1);
  if (!/^[0-9]+$/.test(tail)) return s;
  return s.substring(0, hash);
}

// The occurrence half of a member key. A key with no "#<digits>" suffix is
// occurrence 0 — see memberKeyFor.
function memberOccurrenceOf(key) {
  var s = String(key === undefined || key === null ? "" : key);
  var hash = s.lastIndexOf("#");
  if (hash <= 0) return 0;
  var tail = s.substring(hash + 1);
  if (!/^[0-9]+$/.test(tail)) return 0;
  return Number(tail);
}

// EVERY window of every watched identity that is running, occurrence-indexed.
//
//   { byId:        { identityId: [client, client, …] },   // index IS occurrence
//     idByAddress: { address: { identityId, occurrence } } }
//
// The array is sorted by the placement comparator above, which is what makes
// the index a stable name for a window rather than a position in a read.
//
// idByAddress is what keeps group membership consistent with the app entries:
// every watched window has an entry of its own now, so a group can be described
// in terms of the tuples those entries carry and the two halves of a record can
// never disagree. Pass it to groupMemberIds.
//
// An identity with no windows is ABSENT from byId rather than present with an
// empty array, so `chosen.byId[id]` stays falsy for "not running".
function chosenWindows(clientsJson, identities, monitorsJson) {
  var list = identities || [];
  var byId = {};
  var idByAddress = {};
  var compare = placementComparator(monitorsJson);
  for (var i = 0; i < list.length; i++) {
    var windows = clientsFor(clientsJson, list[i], list).slice().sort(compare);
    if (!windows.length) continue;
    byId[list[i].id] = windows;
    for (var w = 0; w < windows.length; w++) {
      idByAddress[windows[w].address] = { identityId: list[i].id, occurrence: w };
    }
  }
  return { byId: byId, idByAddress: idByAddress };
}

// The live window a recorded (identityId, occurrence) names, or null.
//
// A recorded occurrence is a LABEL, not an index into a dense array: a window
// parked in a scratchpad is refused at record time (buildLayout's `excluded`)
// without renumbering the ones around it, so a legal record can name
// occurrence 1 and no occurrence 0. Reading it back is still a plain lookup —
// which is the naive answer, and it is the one this returns. Pairing a live
// desktop to a recording properly (a window that moved is still that window) is
// matchOccurrences' job.
function windowForOccurrence(chosen, identityId, occurrence) {
  if (!chosen || !chosen.byId) return null;
  var windows = own(chosen.byId, identityId);
  if (!windows || !windows.length) return null;
  return windows[occurrenceOf(occurrence)] || null;
}

// The member key a live window carries, given a chosenWindows() index.
function memberKeyOfAddress(idByAddress, address) {
  var found = idByAddress ? idByAddress[address] : null;
  if (!found) return null;
  return memberKeyFor(found.identityId, found.occurrence);
}

// ---------------------------------------------------------------------------
// MATCHING — pairing a live desktop to a multi-window recording
// ---------------------------------------------------------------------------
//
// The problem, and it only exists once an identity can be recorded twice. Two
// terminals are recorded on workspaces 1 and 4. A restore reads two live
// terminals and has to decide WHICH live window is the workspace-1 one. Get it
// wrong and the plan swaps them; get it wrong the same way next pass and the
// swap repeats for ever, which is exactly what the property test's convergence
// invariant catches.
//
// Placement order alone is not the answer: it renumbers as soon as a window
// moves, so the plan that moves a window changes what the next plan thinks that
// window is. The matcher pins the pairing against the RECORDING instead, in
// three passes, most-confident first:
//
//   1. EXACT PLACEMENT AGREEMENT. A live window already on the recorded
//      monitor, on the recorded workspace, in the recorded group slot, IS that
//      recorded window. This is what makes a conforming desktop plan nothing:
//      every window is already where some entry says it should be, so every
//      entry finds its own window and no op is emitted. It is also what stops a
//      half-restored desktop from un-restoring itself — the windows already
//      placed keep their occurrences.
//   2. BEST GEOMETRY OVERLAP. Of what is left, pair the recorded rect with the
//      live rect it overlaps most (IoU > 0), best pair first. A window that was
//      dragged to another workspace is still recognisably the window that used
//      to be that size in that corner.
//   3. THE REMAINDER, in the shared placement order on both sides. Arbitrary
//      but total and stable, which is all that is needed once nothing else can
//      tell the windows apart.
//
// The group slot is compared WITHOUT occurrences — as the group's identity ids
// in tab order plus this window's index in it — because occurrences are what
// this function is deciding. Comparing them here would be circular.

// The identity ids of a client's watched group in tab order, DUPLICATES KEPT,
// with this client's own index in that order. null when it is not in a watched
// group of two or more.
//
// The occurrence-free twin of groupMemberIds, and the difference is the point:
// this is the question the matcher asks BEFORE occurrences exist.
function groupSlotOf(client, clientsJson, identities) {
  if (!client) return null;
  var clients = clientsJson || [];
  var addresses = groupOrderFor(client, clients);
  var ids = [];
  var index = -1;
  for (var a = 0; a < addresses.length; a++) {
    var member = null;
    for (var c = 0; c < clients.length; c++) {
      if (clients[c] && clients[c].address === addresses[a]) {
        member = clients[c];
        break;
      }
    }
    if (!member) continue;
    var id = matchClient(member, identities);
    if (!id) continue;
    if (addresses[a] === client.address) index = ids.length;
    ids.push(id);
  }
  if (ids.length < 2) return null;
  return ids.join("+") + "@" + index;
}

// The same slot, read off a RECORDED entry: the groupId's member keys with
// their occurrences stripped, plus the recorded tab index.
function recordedGroupSlotOf(recorded) {
  if (!recorded || !recorded.group || !recorded.group.groupId) return null;
  var keys = String(recorded.group.groupId).replace(/^group:/, "").split("+");
  var ids = [];
  for (var i = 0; i < keys.length; i++) ids.push(memberIdentityOf(keys[i]));
  if (ids.length < 2) return null;
  return ids.join("+") + "@" + recorded.group.index;
}

// Pair one identity's recorded entries to its live windows.
//
// `recorded` is the identity's entries in record order; `live` is its windows in
// placement order (a chosenWindows bucket). Returns an array parallel to
// `recorded` holding the matched client or null.
function matchOccurrences(recorded, live, clientsJson, monitorsJson, identities) {
  var out = [];
  var taken = {};
  var i, j;
  for (i = 0; i < recorded.length; i++) out.push(null);
  if (!live || !live.length) return out;

  // Pass 1: exact placement agreement.
  var liveSlot = [];
  for (j = 0; j < live.length; j++) liveSlot.push(groupSlotOf(live[j], clientsJson, identities));
  for (i = 0; i < recorded.length; i++) {
    var want = recorded[i];
    var wantSlot = recordedGroupSlotOf(want);
    for (j = 0; j < live.length; j++) {
      if (taken[j]) continue;
      var client = live[j];
      if (monitorLabel(monitorByIndex(monitorsJson, client.monitor)) !== (want.monitorDescription || "")) continue;
      if ((client.workspace ? client.workspace.id : null) !== want.workspaceId) continue;
      if (liveSlot[j] !== wantSlot) continue;
      taken[j] = true;
      out[i] = client;
      break;
    }
  }

  // Pass 2: best geometry overlap, best pair first. Recomputed after each pick
  // rather than sorted once, because taking a pair changes which pairs are
  // still available — and a greedy best-first pass is deterministic as long as
  // ties break on the recorded index then the live index, which they do.
  for (;;) {
    var bestScore = 0;
    var bestI = -1;
    var bestJ = -1;
    for (i = 0; i < recorded.length; i++) {
      if (out[i]) continue;
      for (j = 0; j < live.length; j++) {
        if (taken[j]) continue;
        var iou = rectIou(
          { at: recorded[i].at, size: recorded[i].size },
          { at: live[j].at, size: live[j].size }
        );
        if (iou === null || iou <= 0) continue;
        if (iou > bestScore) {
          bestScore = iou;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI === -1) break;
    out[bestI] = live[bestJ];
    taken[bestJ] = true;
  }

  // Pass 3: the remainder, both sides in their own order.
  j = 0;
  for (i = 0; i < recorded.length; i++) {
    if (out[i]) continue;
    while (j < live.length && taken[j]) j++;
    if (j >= live.length) break;
    out[i] = live[j];
    taken[j] = true;
  }
  return out;
}

// Pair a WHOLE recording to a live desktop, and hand back the occurrence index
// that pairing implies.
//
//   { clientByEntry: [client|null],            // parallel to layout.apps
//     idByAddress:   { address: { identityId, occurrence } } }
//
// idByAddress is the FINAL one — the one every group question must be asked
// through. A matched window carries the occurrence of the entry it matched, so
// a conforming desktop's live groupId is byte-identical to the recorded one; an
// unmatched window keeps the lowest occurrence its identity has left, so two
// live windows never claim the same tuple.
function matchLayout(clientsJson, monitorsJson, layout, identities, chosen) {
  var recordedApps = (layout && layout.apps) || [];
  var index = chosen || chosenWindows(clientsJson, identities, monitorsJson);

  // The recorded entries, bucketed by identity, remembering where each came from.
  var buckets = {};
  var order = [];
  var i;
  for (i = 0; i < recordedApps.length; i++) {
    var id = recordedApps[i].identityId;
    if (!own(buckets, id)) {
      buckets[id] = { entries: [], at: [] };
      order.push(id);
    }
    buckets[id].entries.push(recordedApps[i]);
    buckets[id].at.push(i);
  }

  var clientByEntry = [];
  for (i = 0; i < recordedApps.length; i++) clientByEntry.push(null);

  var idByAddress = {};
  var usedOccurrences = {};
  var matchedAddresses = {};

  for (var b = 0; b < order.length; b++) {
    var bucket = own(buckets, order[b]);
    var live = own(index.byId, order[b]) || [];
    var paired = matchOccurrences(bucket.entries, live, clientsJson, monitorsJson, identities);
    if (!own(usedOccurrences, order[b])) usedOccurrences[order[b]] = {};
    for (i = 0; i < paired.length; i++) {
      if (!paired[i]) continue;
      clientByEntry[bucket.at[i]] = paired[i];
      var occ = occurrenceOf(bucket.entries[i].occurrence);
      idByAddress[paired[i].address] = { identityId: order[b], occurrence: occ };
      usedOccurrences[order[b]][occ] = true;
      matchedAddresses[paired[i].address] = true;
    }
  }

  // Live windows no entry claimed: numbered around the matched ones, in
  // placement order, so the index stays a bijection.
  for (var idKey in index.byId) {
    if (!Object.prototype.hasOwnProperty.call(index.byId, idKey)) continue;
    var windows = own(index.byId, idKey);
    var used = own(usedOccurrences, idKey) || {};
    var next = 0;
    for (var w = 0; w < windows.length; w++) {
      if (matchedAddresses[windows[w].address]) continue;
      while (used[next]) next += 1;
      used[next] = true;
      idByAddress[windows[w].address] = { identityId: idKey, occurrence: next };
    }
  }

  return { clientByEntry: clientByEntry, idByAddress: idByAddress, chosen: index };
}

// ---------------------------------------------------------------------------
// Record: the layout snapshot
// ---------------------------------------------------------------------------
//
// THE ON-DISK STATE SCHEMA. What buildLayout() returns is what the service
// persists (layouts keyed by topology, under
// ~/.local/state/omarchy/dock-recall.json) and what Panel.qml renders.
// Treat it as a contract; add fields, do not repurpose them.
//
//   Layout {
//     topologyKey:  string    // topologyKey(monitors) at record time. The map
//                             // key this record is filed under.
//     recordedAt:   any       // supplied by the caller (an ISO string or an
//                             // epoch ms number). Never read from a clock in
//                             // here — that is what keeps this testable.
//     apps:         AppPlacement[]   // one entry per watched identity that had
//                             // a window open. Identities that were not
//                             // running are simply absent; unwatched windows
//                             // are never recorded.
//   }
//
//   AppPlacement {
//     identityId:        string   // Identity.id, NOT a window class — classes
//                                 // get renamed between Omarchy versions.
//     occurrence:        number   // schema v3. WHICH window of that identity
//                                 // this entry describes, 0-based. An identity
//                                 // with three windows open records three
//                                 // entries — occurrence 0, 1, 2 — and the
//                                 // number is assigned in a DETERMINISTIC
//                                 // placement order, not in hyprctl's read
//                                 // order, so two reads of an unchanged desktop
//                                 // agree. The record's unit of identity is
//                                 // therefore the TUPLE (identityId,
//                                 // occurrence); `identityId` alone names an
//                                 // app, not a window.
//     monitorDescription:string   // monitorLabel() of the monitor the window
//                                 // was on: a stable description (or name when
//                                 // the description is empty). NEVER the
//                                 // monitor index — indices renumber on
//                                 // hotplug. "" when it could not be resolved.
//     workspaceId:       number   // client.workspace.id. Always POSITIVE in a
//                                 // record written since tick pqv: a special
//                                 // workspace's negative id is not a workspace
//                                 // identity to any dispatcher, so an app
//                                 // parked in a scratchpad is refused at record
//                                 // time (buildLayout's `excluded`) and skipped
//                                 // at restore time (`workspace-special`).
//     floating:          boolean
//     group:             null | GroupMembership
//     at:    null | [x, y]        // schema v2. The window's top-left in layout
//                                 // coordinates, straight off client.at.
//     size:  null | [w, h]        // schema v2. client.size, same coordinates.
//   }
//
// GEOMETRY (schema v2) — what it is and, just as importantly, what it is not.
//
// `at`/`size` are RECORDED and MEASURED, and for entries recorded
// `floating: true`, planRestore also ACTS on them (since tick qkv): a float
// outside GEOMETRY_TOLERANCE_PX of its recorded rect is drift and plans a
// `geometry` op that resizes and moves it back — see the "Floating geometry"
// block below and geometryPlanSkip for the one thing that can veto it. For
// entries recorded tiled they remain measurement only; no op moves or resizes
// a tiled window because of them. Scoring is the other reason they exist: the
// verdict layer uses them to judge how closely a restored desktop matches the
// recording — the tiled-layout question the state matrix's out-of-scope table
// raised, which could not even be asked while the record threw the numbers
// away.
//
// null means "not known", and it is permanent and legal:
//   - every entry of a v1 record, upgraded (StateModel migrates to null, never
//     to zeros — [0, 0] is a real position and inventing it would make a
//     scorer confidently wrong);
//   - a client whose `at`/`size` the read did not carry.
// Consumers must render/score null as `not-scored`, never as a mismatch and
// never as agreement.
//
// The numbers are Hyprland's LAYOUT coordinates: whole pixels in a global
// space spanning every monitor, so a window's `at` moves when its monitor is
// repositioned even though nothing about the window changed. That is exactly
// why geometry is scored WITHIN a topology (recordings are keyed by
// topologyKey) and comparing across topologies is meaningless.
//
//   GroupMembership {
//     groupId: string   // stable id for the tab group, derived from its
//                       // watched members in tab order, so the same group
//                       // recorded twice gets the same id.
//     index:   number   // 0-based position of this app in the tab order.
//   }
//
// Recorded membership is (identityId, occurrence)-AWARE as of schema v3. A tab
// group can legitimately hold two windows of ONE identity — two terminals, two
// notebooks — and before v3 the second one collapsed out of the membership
// because there was only one entry per identity to point at. The member of a
// group is therefore a TUPLE, and an identity may appear in one group twice, at
// two occurrences and two tab indexes.
//
// THE GROUP INVARIANT, and it is a contract: for every groupId in a record, the
// members' indexes are 0..n-1 with no holes, and every (identityId, occurrence)
// named in the groupId carries that same groupId in its OWN entry. A record
// that breaks it describes a group that can never be rebuilt — the window at
// the missing index is recorded as living somewhere else. chosenWindows() is
// what enforces it (one entry per live window, group membership filtered to
// recorded windows); tests/record.test.js asserts it over every fixture.
//
// MULTI-WINDOW, schema v3 (epic 69b): the schema no longer says "one entry per
// identity". `occurrence` is the field that lifted that limitation and it
// shipped WITH v3 — every read migrates a v2 entry to `occurrence: 0` — and the
// machinery that PRODUCES more than one entry per identity (the placement
// comparator, the occurrence-aware record, the restore matcher) landed in the
// ticks that followed. It is all here now: buildLayout emits one entry per
// recorded WINDOW, so a second window of one identity is recorded at
// occurrence 1 (pinned in tests/record.test.js).
//
// STATE_VERSION has since moved on to 4, which is a generation about
// IDENTITIES rather than entries — it adds `titlePatterns` — so a file written
// today carries that line per identity too. No layout entry changed shape for
// it.

// The tab order to believe for `client`'s group.
//
// On a healthy read this is just `client.grouped`, and that is the answer for
// every read this project saw before 2026-08-16. On a split-brain read it is
// not: the window whose array under-reports would otherwise be recorded as
// UNGROUPED, and a group recorded as four ungrouped windows can never be
// restored — planRestore has no op that says "these belong together" if the
// record does not say so. That is not a hypothetical; it is what the docked
// layout on this machine was re-recorded as.
//
// So when the client's own array carries no group (fewer than two members) but
// other windows still claim it, believe THEM: take the longest array among the
// claimants, because that is the one that still carries the whole tab order.
// A client whose own array already describes a group is always believed over
// its peers — the healthy case must not change shape.
//
// Ties go to the first claimant in hyprctl order, which is arbitrary but
// deterministic. Nothing is invented: if nobody claims the client either, the
// answer is still its own array, and a group nobody reports is a group this
// tool cannot know about.
function groupOrderFor(client, clientsJson) {
  var own = groupedOf(client);
  if (own.length > 1) return own;
  if (!client || !client.address) return own;

  var clients = clientsJson || [];
  var best = own;
  for (var i = 0; i < clients.length; i++) {
    var peer = clients[i];
    if (!peer || peer.address === client.address) continue;
    var grouped = groupedOf(peer);
    if (grouped.length <= best.length) continue;
    // Only a peer that names this client is talking about this client's group.
    for (var g = 0; g < grouped.length; g++) {
      if (grouped[g] === client.address) {
        best = grouped;
        break;
      }
    }
  }
  return best;
}

// The watched members of a client's group, as MEMBER KEYS in tab order.
//
// A member key is `identityId` for the identity's first window and
// `identityId#N` for its Nth — see memberKeyFor. Before schema v3 this returned
// bare identity ids and COLLAPSED duplicates: two windows of one identity in
// one tab group recorded as one member, because there was only one entry per
// identity for the second one to point at. That collapse is gone. Two terminals
// tabbed together are two members, at two tab indexes, each with its own entry.
//
// A client's `grouped` array is the group's window addresses and its order IS
// the tab order — live-verified on this machine: every member of a real
// four-window group reports the SAME array in the SAME order (it is not
// rotated to start at the member reporting it), so any member's view of the
// group is the group's view of itself.
//
// Unwatched members are dropped (restore cannot recreate them), so the result is
// the tab order of the things this tool can actually put back.
//
// `idByAddress` (optional, from chosenWindows) is what makes the keys tuples: it
// is the map from a live window to the (identityId, occurrence) its entry
// carries. Without it, membership is "any watched window" named by bare identity
// id with duplicates collapsed — the pre-v3 answer, and the question
// pickClientFor has to ask before there are any occurrences to filter by.
function groupMemberIds(client, clientsJson, identities, idByAddress) {
  var clients = clientsJson || [];
  var addresses = groupOrderFor(client, clients);
  var members = [];

  for (var a = 0; a < addresses.length; a++) {
    var id = null;

    if (idByAddress) {
      id = memberKeyOfAddress(idByAddress, addresses[a]);
    } else {
      var member = null;
      for (var c = 0; c < clients.length; c++) {
        if (clients[c].address === addresses[a]) {
          member = clients[c];
          break;
        }
      }
      if (!member) continue;
      id = matchClient(member, identities);
    }

    if (!id) continue;
    if (members.indexOf(id) === -1) members.push(id);
  }
  return members;
}

// A group's window addresses rotated so that `anchor` comes first.
//
// Live evidence says hyprctl does NOT rotate `grouped` per member, so this is
// a no-op on a healthy read — but the group rebuild asserts its own work
// against the anchor window it created the group around, and normalizing there
// makes that assertion true regardless of which member's array is read and of
// where the compositor decides the ring starts.
function normalizeGroupOrder(addresses, anchor) {
  var list = addresses || [];
  var at = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === anchor) {
      at = i;
      break;
    }
  }
  if (at <= 0) return list.slice();
  return list.slice(at).concat(list.slice(0, at));
}

function sameAddressOrder(a, b) {
  var x = a || [];
  var y = b || [];
  if (x.length !== y.length) return false;
  for (var i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

// Is the live group around `anchor` exactly `wanted`, in that order?
//
// The rebuild's per-join assertion: after member i has been pulled in, the
// group must read as the recording's first i+1 windows and nothing else.
function groupOrderMatches(client, wanted, anchor) {
  if (!client) return false;
  return sameAddressOrder(normalizeGroupOrder(client.grouped || [], anchor), wanted || []);
}

// A group id that is stable across sessions: same watched members in the same
// tab order, same id. Window addresses are useless for this — they change every
// launch.
function groupIdFor(memberIds) {
  return "group:" + memberIds.join("+");
}

// ---------------------------------------------------------------------------
// Split-brain group state
// ---------------------------------------------------------------------------
//
// The fact the rest of this file was written against — every member of a real
// group reports the SAME `grouped` array — is true of a HEALTHY read and is not
// true after a suspend/resume. Live evidence (2026-08-16, case 5, docked wake):
// the three messengers each reported grouped=[obsidian, slack, telegram,
// whatsapp] while obsidian reported grouped=[obsidian] — a group of one. The
// arrays disagreed about who was in the group.
//
// That is fatal to a rebuild that decides "is this window grouped?" from the
// window's OWN array alone. The window whose array under-reports is left
// undissolved, `group.toggle` on it then reads as "create" to us and "dissolve"
// to the compositor (or the reverse), and every subsequent `into_group` has no
// group to join. The observed signature is the rebuild asking for
// anchor+member and reading back the anchor alone, in every direction, on every
// retry, across three consecutive cycles.
//
// So membership is asked as a CLAIM, and a claim from either side counts.

// ES5, and no assumption about the QML JS engine's Array.isArray.
function isAddressList(value) {
  return !!value && Object.prototype.toString.call(value) === "[object Array]";
}

function groupedOf(client) {
  return client && isAddressList(client.grouped) ? client.grouped : [];
}

// Every live address that claims shared group membership with `address`:
// what the window itself names, plus every OTHER window that names it.
// `address` is never included in its own claim list.
//
// A healthy read makes the two halves agree and this is just the group. A
// split-brain read makes them disagree, and the union is the only honest answer
// to "who does the compositor still think is tabbed together here".
function groupClaimants(clientsJson, address) {
  var clients = clientsJson || [];
  var out = [];
  var seen = {};
  if (!address) return out;

  function add(candidate) {
    if (!candidate || candidate === address || seen[candidate]) return;
    seen[candidate] = true;
    out.push(candidate);
  }

  var self = null;
  for (var i = 0; i < clients.length; i++) {
    if (clients[i] && clients[i].address === address) {
      self = clients[i];
      break;
    }
  }

  var own = groupedOf(self);
  for (var o = 0; o < own.length; o++) add(own[o]);

  for (var c = 0; c < clients.length; c++) {
    var client = clients[c];
    if (!client || client.address === address) continue;
    var grouped = groupedOf(client);
    for (var g = 0; g < grouped.length; g++) {
      if (grouped[g] === address) {
        add(client.address);
        break;
      }
    }
  }
  return out;
}

// Does the compositor still tie `address` to a group — by its own array, or by
// somebody else's?
//
// The `grouped: [self]` case counts: a solo group is a group, and toggling it
// is what clears it. This is what StateModel.isGrouped asks of one client;
// asking it of the whole read is the split-brain-tolerant version.
function isGroupClaimed(clientsJson, address) {
  var clients = clientsJson || [];
  for (var i = 0; i < clients.length; i++) {
    if (clients[i] && clients[i].address === address && groupedOf(clients[i]).length > 0) return true;
  }
  return groupClaimants(clientsJson, address).length > 0;
}

// Everything that must be dissolved before `addresses` can be rebuilt into a
// group, in a deterministic order: the recorded members first (in recorded
// order), then any other live window dragged in by a claim.
//
// Only LIVE addresses are returned — a claim naming a window that no longer
// exists is nothing we can dispatch at, and `group.toggle` on a dead address is
// a VERB-ERROR, not a dissolve.
//
// A window nobody claims is deliberately absent: `group.toggle` on a genuinely
// ungrouped window CREATES a solo group, which is the state this whole function
// exists to get rid of.
function dissolveTargets(addresses, clientsJson) {
  var clients = clientsJson || [];
  var members = addresses || [];
  var live = {};
  for (var i = 0; i < clients.length; i++) {
    if (clients[i] && clients[i].address) live[clients[i].address] = true;
  }

  var out = [];
  var seen = {};

  function take(address) {
    if (!address || seen[address] || !live[address]) return;
    if (!isGroupClaimed(clients, address)) return;
    seen[address] = true;
    out.push(address);
  }

  for (var m = 0; m < members.length; m++) take(members[m]);
  for (var n = 0; n < members.length; n++) {
    var claims = groupClaimants(clients, members[n]);
    for (var c = 0; c < claims.length; c++) take(claims[c]);
  }
  return out;
}

// An empty, invisible workspace id for assembling a group on.
//
// Why one is needed at all — live-proven 2026-08-16 (forensics dump
// 2026-08-16T06:34:51.393Z, replayed by hand dispatch by dispatch):
// `into_group` joins ONLY a group that is the directly ADJACENT layout node in
// the given direction. With one full column of other tiles between the
// candidate and the anchor's group, all four directions answered "ok" and did
// nothing — focus verified landing (activewindow read back), workspace visible
// on its monitor, hours after the last monitor event — while the identical
// choreography joined on the first try the moment the two windows were alone
// on an empty workspace (two layout nodes are always adjacent). A dock
// transition scrambles exactly this geometry, and geometry is out of scope for
// the recording, so the service manufactures adjacency instead of hoping for
// it: group and candidate go to the workspace this picks, join there, and the
// group is moved home.
//
// The pick avoids every workspace that HAS windows (the emptiness is the whole
// point) and every workspace a monitor is currently SHOWING or has as its
// special workspace (moving windows through a visible workspace is churn the
// user watches happen). 31 is the base: past Omarchy's 1..10 bindings, stable
// for tests. The scan is bounded; 31..99 all being in use means the desktop
// has bigger problems than this join.
function pickScratchWorkspace(clientsJson, monitorsJson) {
  var used = {};
  var clients = clientsJson || [];
  for (var i = 0; i < clients.length; i++) {
    var ws = clients[i] && clients[i].workspace ? clients[i].workspace.id : null;
    if (typeof ws === "number") used[ws] = true;
  }
  var monitors = monitorsJson || [];
  for (var m = 0; m < monitors.length; m++) {
    var mon = monitors[m];
    if (!mon) continue;
    if (mon.activeWorkspace && typeof mon.activeWorkspace.id === "number") used[mon.activeWorkspace.id] = true;
    if (mon.specialWorkspace && typeof mon.specialWorkspace.id === "number") used[mon.specialWorkspace.id] = true;
  }
  for (var id = 31; id < 100; id++) {
    if (!used[id]) return id;
  }
  return 100;
}

// A window's `at` or `size` as the record stores it: a pair of finite numbers,
// or null when the read did not carry one.
//
// The twin of StateModel.normalizeGeometry — the record side and the read side
// have to agree exactly, and the two files may not import each other (engine.js
// loads standalone in QML), so the agreement is pinned by a test instead.
function geometryPair(value) {
  if (Object.prototype.toString.call(value) !== "[object Array]" || value.length !== 2) return null;
  var out = [];
  for (var i = 0; i < 2; i++) {
    var v = value[i];
    if (typeof v === "string") {
      var trimmed = v.replace(/^\s+|\s+$/g, "");
      v = trimmed ? Number(trimmed) : NaN;
    }
    if (typeof v !== "number" || !isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

// Does this workspace id name a SPECIAL workspace (a scratchpad)?
//
// Hyprland hands special workspaces NEGATIVE ids, and tick pqv's live probe
// (docs/thoughts/2026-08-17-special-ws-probe.md, Hyprland 0.56.2) established
// that such an id is worse than useless in a dispatch: to every dispatcher a
// bare negative number is a RELATIVE workspace selector, not an identity.
// `window.move({ workspace = "-98" })` answers "ok" and clamps the window to
// the workspace neighbourhood of whatever is active; `workspace.move({
// workspace = "-98" })` answers "ok" and drags an INNOCENT NORMAL WORKSPACE
// onto another monitor — silently, and repeatably, once per convergence round.
// The ids are also session-local slots rather than names: the probe watched -97
// get reused by a differently-named scratchpad minutes later, so a recorded -98
// does not identify a workspace across a logout even in principle.
//
// So the number is refused at both doors — at record time (buildLayout, below)
// so it never enters a new file, and at restore time (driftOf's
// "workspace-special" skip) so a file recorded before this tick cannot reach a
// dispatch either. Coerced the way normalizeWorkspaceId coerces, because a
// hand-edited file may carry "-98" as a string.
function isSpecialWorkspaceId(value) {
  var id = value;
  if (typeof id === "string") {
    var trimmed = id.replace(/^\s+|\s+$/g, "");
    id = trimmed ? Number(trimmed) : NaN;
  }
  return typeof id === "number" && isFinite(id) && id < 0;
}

// Snapshot the current placement of every watched app.
//
// `recordedAt` is passed in rather than read from a clock, so this function is
// pure and its output is byte-comparable in tests.
//
// The result carries an `excluded` list alongside `apps`: every watched app
// that was deliberately LEFT OUT, with the reason. It is not part of the stored
// layout — StateModel.normalizeLayout keeps `topologyKey`, `recordedAt` and
// `apps` and drops everything else, so this never reaches the state file — it
// exists so a recorder (the panel, scripts/record-current) can say out loud
// that the count it just printed is short, and why. A silently short recording
// is exactly the "windows out of sync" report this project exists to answer.
function buildLayout(clientsJson, monitorsJson, identities, recordedAt) {
  var clients = clientsJson || [];
  var monitors = monitorsJson || [];
  var list = identities || [];
  var apps = [];
  var excluded = [];

  // EVERY window of every watched identity, occurrence-indexed in placement
  // order, indexed once before anything is recorded and used for both halves of
  // every entry. An app entry that describes window A while the group it claims
  // to be in was read off window B is the index-hole bug — see pickClientFor.
  var chosen = chosenWindows(clients, list, monitors);

  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    var windows = own(chosen.byId, identity.id) || [];

    // ONE ENTRY PER RUNNING WINDOW (schema v3). Two Slack windows record twice,
    // at occurrence 0 and 1, and each entry describes its own window's monitor,
    // workspace, group slot and rect. Before v3 the second window was invisible
    // to the record and therefore to restore.
    for (var occ = 0; occ < windows.length; occ++) {
      var client = windows[occ];

      // Parked in a scratchpad at record time: refuse the entry rather than file
      // a number no restore can act on (see isSpecialWorkspaceId). Recording it
      // would buy a permanently-drifted row whose only op is a destructive one.
      // The app is not lost — it is simply not part of this arrangement, which
      // is what a scratchpad means.
      //
      // The occurrences AROUND it are not renumbered. A refusal here leaves a
      // hole in the recorded occurrences of this identity, and that is the
      // correct record: the number names a window's place on the desk, and the
      // other windows did not move because this one was refused. Every consumer
      // treats a recorded occurrence as a label rather than a dense index.
      if (isSpecialWorkspaceId(client.workspace ? client.workspace.id : null)) {
        excluded.push({
          identityId: identity.id,
          occurrence: occ,
          reason: "workspace-special",
          workspaceId: client.workspace.id,
          workspaceName: (typeof client.workspace.name === "string") ? client.workspace.name : ""
        });
        continue;
      }

      var monitor = monitorByIndex(monitors, client.monitor);
      var group = null;
      var memberIds = groupMemberIds(client, clients, list, chosen.idByAddress);

      // A group of one watched window is not a group: there is nothing to tab it
      // with on restore, so record it as ungrouped. Two windows of the SAME
      // identity are two members and do make a group — the collapse that used to
      // hide that is gone with the tuple keys.
      if (memberIds.length > 1) {
        group = {
          groupId: groupIdFor(memberIds),
          index: memberIds.indexOf(memberKeyFor(identity.id, occ))
        };
      }

      apps.push({
        identityId: identity.id,
        // v3. WHICH window of this identity — its index in the placement order.
        occurrence: occ,
        monitorDescription: monitorLabel(monitor),
        workspaceId: client.workspace ? client.workspace.id : null,
        floating: !!client.floating,
        group: group,
        // v2. Recorded off the SAME window as everything else in this entry —
        // geometry read from a different window of the same identity would
        // describe a desktop that never existed.
        at: geometryPair(client.at),
        size: geometryPair(client.size)
      });
    }
  }

  return {
    topologyKey: topologyKey(monitors),
    recordedAt: recordedAt === undefined ? null : recordedAt,
    apps: apps,
    excluded: excluded
  };
}

// ---------------------------------------------------------------------------
// Drift: where the watched apps are now, versus where they were recorded
// ---------------------------------------------------------------------------
//
//   DriftReport {
//     topologyKey:       string   // the topology right now
//     layoutTopologyKey: string   // the topology the layout was recorded under
//     topologyMatches:   boolean  // restoring a layout recorded under a
//                                 // different topology is legal but worth a
//                                 // warning in the UI
//     apps:              AppDrift[]
//     groups:            GroupDrift[]   // one per recorded groupId
//     summary:           { ok, drifted, missing, skipped }   // for the badge
//   }
//
//   GroupDrift {
//     groupId:     string
//     identityIds: string[]   // the members that are HERE, in recorded order,
//                             // as bare identity ids — what gets SAID about
//                             // the group. One id may appear twice (two
//                             // windows of one app in one group)
//     memberKeys:  string[]   // the same list as (identityId, occurrence)
//                             // tuple keys — what gets COMPARED
//     addresses:   string[]   // their live windows, same order — what a
//                             // rebuild would tab together
//     missing:     string[]   // recorded members that are not restorable now
//                             // (not running, unwatched, monitor gone). The
//                             // service logs them; a partial group is better
//                             // than no group.
//     needed:      boolean    // the live grouping does not match: wrong
//                             // members, wrong order, or no group at all
//   }
//
//   AppDrift {
//     identityId: string
//     occurrence: number      // v3. WHICH window of that identity this row is
//                             // about. One recorded app can produce several
//                             // rows, one per occurrence.
//     status:     "ok" | "drifted" | "missing" | "skipped"
//     reason:     null
//               | "monitor-absent"    // recorded a monitor; it is not here now
//               | "monitor-unknown"   // recorded no monitor at all (the record
//                                     // has ""), so there is no destination —
//                                     // a different thing from "unplugged",
//                                     // and the UI must not blame the cable
//               | "workspace-special" // recorded workspace id is NEGATIVE — a
//                                     // scratchpad. buildLayout has refused to
//                                     // write these since tick pqv, so this is
//                                     // the legacy-file door: the id cannot be
//                                     // dispatched (it reads as a RELATIVE
//                                     // selector and moves the wrong workspace
//                                     // — see isSpecialWorkspaceId)
//               | "identity-unknown"
//     drift:      { monitor, workspace, group, floating }
//                                     // booleans; all false unless drifted.
//                                     // `floating` compares the live window's
//                                     // floating state against the recorded
//                                     // one — restorable since tick 8t4 via
//                                     // the "floating" op (see the op list).
//     recorded:   { monitorDescription, workspaceId, group, floating }
//     current:    null | { address, monitorDescription, workspaceId, floating, group }
//   }

// Where a live window sits right now, in the same vocabulary a record uses.
function currentPlacement(client, clientsJson, monitorsJson, identities, idByAddress) {
  if (!client) return null;

  var memberIds = groupMemberIds(client, clientsJson, identities, idByAddress);
  var group = null;
  if (memberIds.length > 1) {
    // Which member of its own group this window is. With an idByAddress in hand
    // that is the window's own tuple key; without one, membership is described
    // by bare identity ids and so is this.
    var selfKey = memberKeyOfAddress(idByAddress, client.address);
    if (!selfKey) selfKey = matchClient(client, identities);
    group = {
      groupId: groupIdFor(memberIds),
      index: memberIds.indexOf(selfKey),
      // The LIVE tab order, as MEMBER KEYS. groupId already encodes it, but
      // only as one joined string — and a consumer that has to split "group:"
      // and "+" back apart to learn who is in the group is one identity id
      // containing a "+" away from being wrong. The verdict table below asks
      // this question of every grouped window, so the list is carried.
      memberIds: memberIds.slice()
    };
  }

  return {
    address: client.address,
    monitorDescription: monitorLabel(monitorByIndex(monitorsJson, client.monitor)),
    workspaceId: client.workspace ? client.workspace.id : null,
    floating: !!client.floating,
    group: group,
    // v2 geometry, read through the same coercion the record side uses so a
    // hyprctl quirk cannot make the live half of a comparison a different kind
    // of value from the recorded half. null means the read did not carry it.
    at: geometryPair(client.at),
    size: geometryPair(client.size)
  };
}

function identityById(identities, id) {
  var list = identities || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// Per-identity comparison of the recorded layout against the live desktop.
// This is what powers the UI badge, and planRestore() is derived from it — so
// what the badge says and what a restore would do can never disagree.
function driftOf(clientsJson, monitorsJson, layout, identities) {
  var clients = clientsJson || [];
  var monitors = monitorsJson || [];
  var recordedApps = (layout && layout.apps) || [];
  // WHICH live window each recorded entry is about. Not a lookup by occurrence:
  // the recording's occurrences were assigned on the desktop that was recorded,
  // and this one has moved since. See matchLayout — and note that `chosen`
  // below carries the MATCHED occurrence index, not the placement one, so every
  // group question asked through it speaks the recording's tuples.
  var matched = matchLayout(clients, monitors, layout, identities);
  var chosen = { byId: matched.chosen.byId, idByAddress: matched.idByAddress };
  var apps = [];
  var appClients = [];
  var summary = { ok: 0, drifted: 0, missing: 0, skipped: 0 };

  // Pass 1: everything except the group verdict, which cannot be reached one
  // app at a time — whether a group is right depends on which of its OTHER
  // members are here.
  for (var i = 0; i < recordedApps.length; i++) {
    var recorded = recordedApps[i];
    var entry = {
      identityId: recorded.identityId,
      // v3. WHICH window of the identity this row is about. Coerced through the
      // same gate the file uses, so a hand-edited record cannot put a
      // fractional or negative label on a row.
      occurrence: occurrenceOf(recorded.occurrence),
      status: "ok",
      reason: null,
      // `geometry` is the FLOAT-ONLY pixel dimension (tick qkv). A tiled
      // window never sets it — its rect is an outcome of the dwindle tree, not
      // a promise anything can keep, and `resize` aimed at one silently
      // rearranges the split (tick y29 evidence). See the geometry block below.
      drift: { monitor: false, workspace: false, group: false, floating: false, geometry: false },
      recorded: {
        monitorDescription: recorded.monitorDescription,
        workspaceId: recorded.workspaceId,
        group: recorded.group || null,
        // Coerced: buildLayout always writes a boolean, but the state file is
        // hand-editable and an old or foreign record may carry junk here.
        floating: !!recorded.floating,
        // v2. Coerced through the same gate as everything else that comes off
        // the file; a v1 entry has neither key and lands on null.
        at: geometryPair(recorded.at),
        size: geometryPair(recorded.size)
      },
      current: null,
      // Filled in below for every app that has a live window. An app with no
      // window scores "not-scored" — there is no rect to compare, which is not
      // the same as a rect in the wrong place.
      geometry: null
    };

    var live = null;
    var identity = identityById(identities, recorded.identityId);
    if (!identity) {
      // The layout remembers an app that is no longer on the watched list.
      entry.status = "skipped";
      entry.reason = "identity-unknown";
    } else if (isSpecialWorkspaceId(recorded.workspaceId)) {
      // A LEGACY entry: the record names a special workspace by its negative
      // id. buildLayout has refused to write one since tick pqv, so this can
      // only come off a file recorded before it — and it must never reach
      // opToCommand, where the number would be read as a relative selector and
      // move a workspace nobody asked about (the probe's row (c), silent and
      // destructive). Checked BEFORE the monitor questions on purpose: if both
      // apply, "re-plug the monitor" is advice that would not help, and this is
      // the reason the app is unrestorable however the desk is arranged.
      entry.status = "skipped";
      entry.reason = "workspace-special";
      entry.current = currentPlacement(matched.clientByEntry[i], clients, monitors, identities, chosen.idByAddress);
    } else if (!(recorded.monitorDescription || "").trim()) {
      // The RECORD never had a monitor: buildLayout stores "" when the client's
      // monitor index resolved to nothing. Skipped for the same reason, but the
      // cause is the opposite one — nothing was unplugged, we simply never knew
      // where the window was — so say so rather than accusing the topology.
      entry.status = "skipped";
      entry.reason = "monitor-unknown";
      entry.current = currentPlacement(matched.clientByEntry[i], clients, monitors, identities, chosen.idByAddress);
    } else if (!monitorByDescription(monitors, recorded.monitorDescription)) {
      // The recorded monitor is not part of this topology — undocked, cable
      // moved, whatever. Skip the app rather than dumping it somewhere wrong.
      entry.status = "skipped";
      entry.reason = "monitor-absent";
      entry.current = currentPlacement(matched.clientByEntry[i], clients, monitors, identities, chosen.idByAddress);
    } else {
      var client = matched.clientByEntry[i];
      if (!client) {
        entry.status = "missing";
      } else {
        live = client;
        entry.current = currentPlacement(client, clients, monitors, identities, chosen.idByAddress);
        entry.drift.monitor = entry.current.monitorDescription !== recorded.monitorDescription;
        entry.drift.workspace = entry.current.workspaceId !== recorded.workspaceId;
        entry.drift.floating = !!entry.current.floating !== !!recorded.floating;
        // Recorded ungrouped: being in a WATCHED group now IS drift, and since
        // tick 8t4 the plan fixes it with an "ungroup" op — the recording is
        // the statement "these windows stand alone", and a restore that cannot
        // say so leaves an amber badge no button can clear (the user's live
        // ws-10 finding). A group of purely-unwatched windows around this
        // window is invisible here (current.group counts watched members
        // only), so groups the user made out of things this tool does not
        // manage are left alone. Group members get their verdict in pass 2.
        if (!recorded.group) entry.drift.group = !!entry.current.group;
        if (entry.drift.monitor || entry.drift.workspace || entry.drift.group || entry.drift.floating) {
          entry.status = "drifted";
        }
      }
    }

    // Geometry, for the apps whose live rect is comparable at all.
    //
    // Only `ok` and `drifted` qualify. A SKIPPED app is skipped because its
    // recorded monitor is not in this topology (or was never known), and
    // `at`/`size` are LAYOUT coordinates — a global space that shifts under
    // every window when a monitor comes or goes. Comparing across that would
    // report a metre of drift on a window nobody touched. A MISSING app has no
    // rect at all. Both land on "not-scored", which is exactly what they are.
    entry.geometry = geometryScoreFor(
      entry.recorded,
      (entry.status === "ok" || entry.status === "drifted") ? entry.current : null
    );

    // A recorded FLOAT that is outside the tolerance band is DRIFT as of tick
    // qkv, where it was measurement-only before (tick 5sc). What changed is not
    // the opinion, it is the capability: planRestore now emits a geometry op
    // for exactly this case, so the badge is pointing at something a button can
    // fix. The rule tick 5sc wrote — "geometry is a measurement, not a promise"
    // — still holds for everything it was written about, because
    // `geometry-off` is a verdict geometryScoreFor only ever reaches in FLOAT
    // mode; a tiled window scores `scored`/`not-scored` and can never land
    // here, so no tiled desktop turns amber over a rect nobody can command.
    //
    // `not-scored` is likewise inert on purpose: a v1 record, a closed app or a
    // window whose monitor is not in this topology has nothing to be off BY.
    entry.drift.geometry = entry.geometry.mode === "float"
      && entry.geometry.verdict === "geometry-off";
    if (entry.status === "ok" && entry.drift.geometry) entry.status = "drifted";

    // …and whether the planner is allowed to act on it. The verdict stands
    // either way — the float IS off its recorded pixels — but a rect this
    // topology cannot hold, or a size no resize can satisfy, must not become a
    // dispatch. See the planner-gate block above geometryPlanSkip; planRestore
    // reads this field and emits nothing when it is set.
    if (entry.drift.geometry) {
      entry.geometry.skip = geometryPlanSkip(entry.recorded, monitors);
    }

    apps.push(entry);
    appClients.push(live);
  }

  // Pass 2: the group verdicts, one group at a time.
  var groups = groupDriftOf(recordedApps, apps, appClients, clients, identities, chosen);

  for (var s = 0; s < apps.length; s++) {
    if (apps[s].status === "ok" && apps[s].drift.group) apps[s].status = "drifted";
    summary[apps[s].status] += 1;
  }

  // Pass 3: which finished workspaces the tiled refinement will not touch, and
  // why (tick eqb). Computed here rather than in the planner because this is
  // the report every reader already has — `scripts/verify` never builds a plan
  // — and because a ceiling that is only visible to whoever runs a restore is a
  // ceiling the person looking at the amber number cannot find.
  var tilingRefusals = tilingRefusalsOf(recordedApps, apps, clients);
  var refusalByWorkspace = {};
  for (var t = 0; t < tilingRefusals.length; t++) {
    refusalByWorkspace[String(tilingRefusals[t].monitorDescription || "")
      + "\u0000" + String(tilingRefusals[t].workspaceId)] = tilingRefusals[t].reason;
  }
  // On the app's own geometry detail as well as on the workspace row: the
  // per-app struct is what travels into the verdicts, the status file and the
  // panel, exactly as `geometry.skip` does for a float the planner will not
  // move. Same shape of fact, same place to look for it.
  for (var u = 0; u < apps.length; u++) {
    var app = apps[u];
    if (!app || !app.geometry || app.geometry.mode !== "tiled") continue;
    var recordedApp = app.recorded || {};
    var refusalKey = String(recordedApp.monitorDescription || "")
      + "\u0000" + String(recordedApp.workspaceId);
    if (refusalByWorkspace[refusalKey]) app.geometry.refinement = refusalByWorkspace[refusalKey];
  }

  return {
    topologyKey: topologyKey(monitors),
    layoutTopologyKey: (layout && layout.topologyKey) || "",
    topologyMatches: topologyKey(monitors) === ((layout && layout.topologyKey) || ""),
    apps: apps,
    groups: groups,
    summary: summary,
    // Measured, informational, and kept OUT of `summary` on purpose: summary is
    // what driftCountOf and the badge read, and a geometry number has no
    // business moving either of them.
    geometry: geometrySummaryOf(apps, refusalByWorkspace),
    // The refusals as a list, for a caller that wants them without walking the
    // workspace rows — the service logs from this one.
    tilingRefusals: tilingRefusals
  };
}

// Every recorded group, judged against the live desktop.
//
// The rule, and it is the whole of requirement B: a group is compared against
// the members that are ACTUALLY HERE, in their recorded relative order. A
// member that is not restorable right now (not running, unwatched, its monitor
// unplugged) is reported in `missing` and left out of the comparison — so a
// group of three with one member closed converges on the two that are open,
// instead of drifting forever against a member that cannot be produced.
//
// What counts as a match is EXACT: the same members, in the same order,
// starting from the recorded first tab. Unwatched windows in the group are
// invisible here (groupMemberIds drops them), so a stranger tabbing itself in
// does not trigger a rebuild — but a watched app in the wrong slot does, which
// is order drift, which is a rebuild.
function groupDriftOf(recordedApps, apps, appClients, clients, identities, chosen) {
  var byId = {};
  var order = [];

  for (var i = 0; i < recordedApps.length; i++) {
    var recorded = recordedApps[i];
    if (!recorded.group || !recorded.group.groupId) continue;
    var groupId = recorded.group.groupId;
    if (!own(byId, groupId)) {
      byId[groupId] = { groupId: groupId, members: [] };
      order.push(groupId);
    }
    byId[groupId].members.push({
      index: recorded.group.index,
      identityId: recorded.identityId,
      // v3. The recorded group order is a list of (identityId, occurrence)
      // TUPLES: one identity may hold two tabs in the same group.
      occurrence: occurrenceOf(recorded.occurrence),
      memberKey: memberKeyFor(recorded.identityId, recorded.occurrence),
      at: i
    });
  }

  var out = [];
  for (var g = 0; g < order.length; g++) {
    var group = byId[order[g]];
    var members = group.members.slice().sort(function (a, b) {
      return a.index - b.index;
    });

    var identityIds = [];
    var memberKeys = [];
    var addresses = [];
    var missing = [];
    var present = [];

    for (var m = 0; m < members.length; m++) {
      var client = appClients[members[m].at];
      if (!client) {
        missing.push(members[m].identityId);
        continue;
      }
      identityIds.push(members[m].identityId);
      memberKeys.push(members[m].memberKey);
      addresses.push(client.address);
      present.push(members[m].at);
    }

    var needed = false;
    if (memberKeys.length > 1) {
      // Compared as TUPLE keys, not identity ids: a group holding two windows
      // of one identity is "a, a#1" and a live group holding one of them twice
      // is not the same group, however equal the identity ids look.
      var wanted = memberKeys.join("+");
      for (var p = 0; p < present.length; p++) {
        var live = groupMemberIds(appClients[present[p]], clients, identities, chosen.idByAddress);
        var matches = live.join("+") === wanted;
        if (!matches) {
          apps[present[p]].drift.group = true;
          needed = true;
        }
      }
    }
    // Fewer than two members here means there is no group to build and no
    // drift to report: one window on its own is not a tab group, and saying it
    // has drifted would be a badge nobody can clear.

    out.push({
      groupId: group.groupId,
      // The identity ids of the members that are here, in recorded order. Kept
      // as bare ids because this is what gets SAID — logged, shown, put in a
      // sentence — and "gmail" twice is what a user with two Gmail windows in
      // one group would say too. `memberKeys` is the same list as tuples, for
      // the comparisons.
      identityIds: identityIds,
      memberKeys: memberKeys,
      addresses: addresses,
      missing: missing,
      needed: needed
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdicts: the measurement, as the product's visible contract
// ---------------------------------------------------------------------------
//
// driftOf answers "would a restore act on this app" with a status and four
// booleans. That is enough to plan with and it is NOT enough to be measured
// by: `drift.group === true` covers "it is not in its group at all", "it is in
// its group but the tabs are the wrong way round" and "it is in a group the
// recording never asked for", and the user reporting "windows out of sync" was
// doing, by eye, the work of telling those apart.
//
// A Verdict says, per recorded app, ONE WORD PER DIMENSION:
//
//   Verdict {
//     identityId: string
//     status:     "ok" | "drifted" | "missing" | "skipped"   // from driftOf
//     workspace:  "ok" | "wrong-workspace" | "workspace-special"
//               | "not-running" | "identity-unknown" | "not-judged"
//     monitor:    "ok" | "wrong-monitor" | "monitor-absent" | "monitor-unknown"
//               | "not-running" | "identity-unknown"
//     floating:   "ok" | "should-float" | "should-tile" | "not-running"
//               | "identity-unknown" | "not-judged"
//     group:      "ok" | "not-joined" | "wrong-order" | "unexpected-group"
//               | "missing-member" | "not-running" | "identity-unknown"
//               | "not-judged"
//     ok:         boolean   // every PLACEMENT dimension reads "ok", AND a
//                           // recorded float is back on its pixels. `ok` folds
//                           // in exactly one geometry word, `geometry-off`,
//                           // which only a FLOAT can reach — see below.
//     text:       string    // the same verdict as one human phrase, "" when ok
//     geometry:   "ok" | "geometry-off" | "scored" | "not-scored"
//                           // Measured for every recorded app; ENFORCED for
//                           // floats only (tick qkv). `geometry-off` is a float
//                           // verdict, it is drift, it plans an op and it makes
//                           // `ok` false. `scored` is the tiled measurement and
//                           // stays inert: no drift, no op, no effect on `ok`.
//     geometryDetail: null | GeometryScore   // the numbers behind that word,
//                           // including `skip` — set when the planner refused
//                           // to act on a geometry-off float (see the planner
//                           // gate in the geometry section below)
//     blockedBy:  null | { kind, reason }
//                           // the op the LAST cycle attempted for this app and
//                           // the reason it did not take ("group join refused
//                           // by compositor"). Only ever set on a verdict that
//                           // is not ok: a dimension that came right is not
//                           // blocked by anything, whatever happened on the way.
//   }
//
// Two rules keep this honest:
//
//   - the dimension words are DERIVED FROM driftOf's booleans, never
//     recomputed. A verdict that said "ok" where the badge counted drift (or
//     the reverse) would be a third opinion about the same desktop, and the
//     whole point of this table is that there are only ever two things to
//     compare: the recording and the live read.
//   - "not-judged" is said out loud rather than passed off as "ok". A skipped
//     app (its monitor is unplugged) genuinely has no verdict on workspace or
//     grouping — restore will not act on it — and calling that "ok" would put
//     a green row over an app nobody has looked at.

// ---------------------------------------------------------------------------
// Geometry scoring (schema v2) — MEASURED for all, ENFORCED for FLOATS
// ---------------------------------------------------------------------------
//
// Tick 5sc wrote this block as measurement-only: nothing in it could change a
// verdict, `verdict.ok`, `driftCountOf`, a plan or scripts/verify's exit code.
// The stated reason was not caution but honesty — `planRestore` had no op that
// moved a window by pixels, so a geometry miss was something the tool could
// report and not something it could be blamed for.
//
// TICK qkv BUILT THAT OP, FOR FLOATS, and the rule split along the line its own
// reasoning drew. So, precisely:
//
//   a recorded FLOAT is measured AND ENFORCED. `geometry-off` sets
//   `drift.geometry`, makes the entry `drifted`, counts in `driftCountOf`,
//   folds into `verdict.ok`, plans a `{kind:"geometry"}` op and fails
//   scripts/verify's exit code;
//
//   a recorded TILED window is measured ONLY, and that is the state of things
//   this increment rather than a permanent law. A `scored` IoU cannot set
//   `drift.geometry`, cannot reach `geometry-off`, cannot enter `verdict.ok`,
//   cannot be planned for and cannot move verify's exit code.
//
// Three things keep the floats' enforcement inside ground it can vouch for: the
// mode comes from the RECORD (a live-tiled window against a floating record is
// the `floating` op's business first, and executeGeometry refuses it besides);
// the PLANNER GATE below (geometryPlanSkip) will not aim pixels at coordinates
// this topology cannot place; and both dispatches are absolute and idempotent,
// so a converged op is a no-op rather than an oscillation.
//
// TWO DIFFERENT QUESTIONS, because floating and tiled windows are not
// comparable:
//
//   FLOATING — the record's x/y/w/h is a promise Hyprland CAN keep: there are
//     pixel move and resize dispatches. So a float gets a PASS/FAIL against a
//     tolerance: `ok` inside it, `geometry-off` outside.
//
//   TILED — the record's rect is an OUTCOME, not an input. Hyprland exposes no
//     way to read or write the dwindle split tree (state matrix, out-of-scope
//     table), so a tiled window's rect is whatever the layout engine computed
//     from window count, insertion order and gaps. Demanding ±2px of it would
//     be marking the tool down for a promise nothing can make. A tiled window
//     therefore gets no pass/fail at all — only a SIMILARITY number (`scored`),
//     aggregated per workspace, which is the honest way to say "this workspace
//     came back 0.94 of the way".
//
// THE TOLERANCE: ±2 px, on each of x, y, w and h independently (not a distance
// — an axis a window is 3px wrong on is 3px wrong whatever the other axis did).
//
// Why 2 and not 0: `at`/`size` are integers, but they are integers at the END of
// a logical -> device -> logical round trip through the output's scale. This
// machine runs DP-1 at scale 1.6, where a logical pixel is not a device pixel
// and the compositor rounds twice; a window nobody touched can be re-reported
// one pixel off on either axis, and a border or gap recomputation moves the
// same amount. ±1 is exactly that rounding error, so a 0 or ±1 tolerance would
// report phantom drift on a perfectly restored desktop — the one failure mode
// this project cannot afford, having been built because the user could not
// trust what the tool said.
//
// Why 2 and not 8 or 16: the tolerance has to stay far below any movement a
// human could have MEANT. Omarchy's own float-nudge keybinds move in tens of
// pixels and the smallest thing a mouse drag can produce is larger than 2px, so
// nothing at ±2 can hide a deliberate move. Two pixels is the widest band that
// still contains only noise.
//
// The number is one constant, exported, so a future tick can move it in one
// place and every consumer — verdicts, verify, the panel — moves with it.
var GEOMETRY_TOLERANCE_PX = 2;

// A pair of finite numbers, or null. Used on the READ side, where a client's
// at/size arrives straight from hyprctl rather than from the record; the record
// side has already been through geometryPair/normalizeGeometry.
function geometryOf(value) {
  return geometryPair(value);
}

// The signed difference between a live rect and a recorded one, per axis, or
// null when either side is unknown. Positive dx means the window is further
// right than recorded; positive dw means it is wider.
function geometryDelta(recorded, current) {
  if (!recorded || !current) return null;
  var at = geometryOf(recorded.at);
  var size = geometryOf(recorded.size);
  var liveAt = geometryOf(current.at);
  var liveSize = geometryOf(current.size);
  if (!at || !size || !liveAt || !liveSize) return null;
  return {
    dx: liveAt[0] - at[0],
    dy: liveAt[1] - at[1],
    dw: liveSize[0] - size[0],
    dh: liveSize[1] - size[1]
  };
}

function withinTolerance(delta, tolerance) {
  if (!delta) return false;
  var limit = typeof tolerance === "number" && isFinite(tolerance) ? Math.abs(tolerance) : GEOMETRY_TOLERANCE_PX;
  return Math.abs(delta.dx) <= limit
    && Math.abs(delta.dy) <= limit
    && Math.abs(delta.dw) <= limit
    && Math.abs(delta.dh) <= limit;
}

// Round to 4 decimals, so a similarity score is stable enough to serialize into
// the status file and to compare in a test without chasing float dust.
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Intersection-over-union of two rects given as (at, size) pairs: the area the
// two share, divided by the area they cover between them. 1 is the same rect,
// 0 is no overlap at all, and everything between is "this much of the way".
//
// IoU rather than a centre distance or an area ratio because it is the only one
// of the three that punishes BOTH kinds of wrong at once: a window in the right
// place at half the size and a window at the right size in the wrong place both
// score below 1, and a window that is right scores exactly 1. An area ratio
// would give a half-size window in the wrong corner the same 0.5 as one that
// merely shrank in place.
//
// null — not 0 — when either rect is unknown or has no area. Zero would mean
// "measured, and completely wrong", which is a different and much stronger
// claim than "there was nothing to measure".
function rectIou(recorded, current) {
  if (!recorded || !current) return null;
  var at = geometryOf(recorded.at);
  var size = geometryOf(recorded.size);
  var liveAt = geometryOf(current.at);
  var liveSize = geometryOf(current.size);
  if (!at || !size || !liveAt || !liveSize) return null;
  if (size[0] <= 0 || size[1] <= 0 || liveSize[0] <= 0 || liveSize[1] <= 0) return null;

  var left = Math.max(at[0], liveAt[0]);
  var top = Math.max(at[1], liveAt[1]);
  var right = Math.min(at[0] + size[0], liveAt[0] + liveSize[0]);
  var bottom = Math.min(at[1] + size[1], liveAt[1] + liveSize[1]);

  var overlapW = right - left;
  var overlapH = bottom - top;
  var intersection = (overlapW > 0 && overlapH > 0) ? overlapW * overlapH : 0;

  var union = (size[0] * size[1]) + (liveSize[0] * liveSize[1]) - intersection;
  if (union <= 0) return null;
  return round4(intersection / union);
}

//   GeometryScore {
//     mode:      "float" | "tiled"   // which question was asked, from the
//                                    // RECORD's `floating` — the recording is
//                                    // the statement of intent, and a window
//                                    // that is live-tiled against a floating
//                                    // record already has a `should-float`
//                                    // verdict saying so.
//     verdict:   "ok" | "geometry-off" | "scored" | "not-scored"
//     tolerance: number              // px, per axis; only meaningful for floats
//     recorded:  { at, size }        // null-able pairs, as recorded
//     current:   { at, size }        // null-able pairs, as read
//     delta:     null | { dx, dy, dw, dh }
//     iou:       null | number       // 0..1, computed for BOTH modes (it costs
//                                    // nothing and a float's IoU is a useful
//                                    // second opinion), aggregated for tiled.
//     skip:      null | string       // why the PLANNER declined to act on a
//                                    // `geometry-off` float: "off-region" or
//                                    // "non-positive-size". null on every
//                                    // other score, including every one that
//                                    // was never a candidate for an op. See
//                                    // geometryPlanSkip.
//   }
//
// `not-scored` is the answer whenever either side has no numbers, and that is
// the WHOLE of the null contract: every entry of a pre-v2 recording is null and
// stays null until it is re-recorded, and a scorer that read that as a mismatch
// would paint an entire desktop wrong on the day the feature shipped. null is
// legal, permanent, and never evidence of anything.
function geometryScoreFor(recordedApp, currentPlacement) {
  var recorded = {
    at: recordedApp ? geometryOf(recordedApp.at) : null,
    size: recordedApp ? geometryOf(recordedApp.size) : null
  };
  var current = {
    at: currentPlacement ? geometryOf(currentPlacement.at) : null,
    size: currentPlacement ? geometryOf(currentPlacement.size) : null
  };
  var mode = (recordedApp && recordedApp.floating) ? "float" : "tiled";

  var score = {
    mode: mode,
    verdict: "not-scored",
    tolerance: GEOMETRY_TOLERANCE_PX,
    recorded: recorded,
    current: current,
    delta: null,
    iou: null,
    // Stamped by driftOf, which has the live monitor list this function does
    // not. Always present so the shape is one shape.
    skip: null,
    // Likewise stamped by driftOf (tick eqb): the word for why the tiled
    // refinement will not touch this window's workspace, or null when it will.
    // A tiled window's IoU is a measurement with no complaint attached, and
    // this is the field that says whether anything is going to be done about
    // it — the tiled twin of `skip`.
    refinement: null
  };

  var delta = geometryDelta(recorded, current);
  if (!delta) return score;

  score.delta = delta;
  score.iou = rectIou(recorded, current);
  score.verdict = mode === "float"
    ? (withinTolerance(delta, GEOMETRY_TOLERANCE_PX) ? "ok" : "geometry-off")
    : "scored";
  return score;
}

// ---------------------------------------------------------------------------
// The planner gate: coordinates this topology can actually place
// ---------------------------------------------------------------------------
//
// A geometry op is the only op in the plan that carries RAW GLOBAL COORDINATES
// out of the recording and into a dispatch. Every other op names a window, a
// workspace or a monitor — symbols the compositor resolves for itself against
// the desktop as it is now. Pixels are different: [2400, 300] means whatever
// the current monitor arrangement says it means, and the recording cannot tell.
//
// It cannot tell because `topologyKey` is a SORTED LIST OF DESCRIPTIONS. It is
// blind to position, to scale and to order — deliberately, because a topology
// has to stay recognisable across a reboot that renumbers outputs. So a user
// who drags DP-1 from the right of eDP-1 to the left of it, or swaps two
// identical-description monitors, keeps the SAME topologyKey and the same
// recording while every global coordinate in it now points somewhere else. A
// float recorded at x 2400 on the right-hand output restores to x 2400, which
// is now empty space or another screen entirely — with every gate green, the
// window recorded floating, both rects known and the op perfectly idempotent.
// It converges. It converges on the wrong place. That is the failure this gate
// exists for, and it is invisible to every check that came before it.
//
// So: pixels may only be dispatched at a rect this topology can actually hold.
//
//   - preferably against the RECORDED MONITOR'S CURRENT rect, which is the only
//     test that catches a pure SWAP — swapping two outputs leaves the union of
//     all monitor rects completely unchanged, so a union test would wave it
//     through. driftOf has already established that this monitor is present
//     (an absent one is `monitor-absent`, skipped, never scored);
//   - failing that (a monitor the read describes without placing), against the
//     UNION of every live monitor rect, which is the weaker question "is this
//     anywhere on the desktop at all";
//   - and if NO live monitor carries a usable rect, the question cannot be
//     asked and the gate does not answer it. Fail-open, deliberately: hyprctl
//     always reports x/y/width/height/scale, so an empty answer means a
//     synthetic or degraded monitor list, and a gate that failed closed there
//     would silently switch float restore off on the day a read shape changed.
//     The primary safety property — never resize a TILED window — does not
//     depend on this gate; it lives in the recorded-floating precondition.
//
// The same gate refuses a NON-POSITIVE SIZE, and this is where that check
// belongs rather than in normalizeGeometry/geometryPair on the read side:
//
//   - the readers' contract is "coerce, never invent". [0, 0] is a real pair of
//     finite numbers that a corrupt or hand-edited file genuinely contains, and
//     mapping it to null there would (a) make the reader lie about what the
//     file says, (b) rewrite the user's file on the next state round trip,
//     which the byte-identical discipline forbids, and (c) put the same
//     decision in two files that may not import each other (StateModel.js and
//     engine.js keep those two functions in step by test, not by call);
//   - a zero-area rect is still perfectly good MEASUREMENT input: rectIou
//     already answers null for it, which is exactly right.
//
//   What a zero size is not good for is dispatching, and the churn it causes is
//   the point: `resize({ x = 0, y = 0 })` cannot be satisfied, so the op never
//   converges, and because the op carries the recorded rect it re-plans
//   identically on every settle pass of every cycle, for ever, on a file the
//   user cannot see is broken. Refusing it in the planner turns an unbounded
//   loop into one word on one row. Position may be negative — a monitor to the
//   left of the origin is an ordinary layout — so only w/h are checked.
//
// Both answers are WORDS, not silence: the score keeps its `geometry-off`
// verdict (the float IS off its recorded pixels; that is a true statement and
// suppressing it would be the tool lying to look green), and the reason the
// planner did not act rides along in `skip`, through the status file to the
// panel row and verify's GEOMETRY column. Same shape as `monitor-absent`: the
// tool says what it sees and says why it is not acting on it.

var GEOMETRY_SKIP_OFF_REGION = "off-region";
var GEOMETRY_SKIP_BAD_SIZE = "non-positive-size";

// A monitor's LOGICAL rect — the coordinate space `at`/`size` are reported in.
//
// hyprctl reports `width`/`height` in DEVICE pixels and everything else in
// logical ones, so the mode has to be divided by the scale: this machine's DP-1
// is 2560x1440 at scale 1.6, which is 1600x900 of layout space. A 90°/270°
// transform (the odd values) swaps the two axes. Anything the read does not
// describe well enough to place is null rather than guessed at.
function monitorRect(monitor) {
  if (!monitor) return null;
  var x = Number(monitor.x);
  var y = Number(monitor.y);
  var w = Number(monitor.width);
  var h = Number(monitor.height);
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;

  var scale = Number(monitor.scale);
  if (!isFinite(scale) || scale <= 0) scale = 1;
  w = w / scale;
  h = h / scale;

  var transform = Number(monitor.transform);
  if (isFinite(transform) && Math.abs(Math.round(transform)) % 2 === 1) {
    var swap = w;
    w = h;
    h = swap;
  }
  return { x: x, y: y, w: w, h: h };
}

// Overlap of positive area. Touching edges do not count: a window whose left
// edge sits exactly on a monitor's right edge is on the other side of it.
function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h;
}

// null when a geometry op may be planned from this record, otherwise the word
// saying why not. Asked only of records that already reached `geometry-off`.
function geometryPlanSkip(recordedApp, monitorsJson) {
  var at = recordedApp ? geometryOf(recordedApp.at) : null;
  var size = recordedApp ? geometryOf(recordedApp.size) : null;
  // No numbers at all is `not-scored`, which never planned anything and has
  // nothing to refuse. Saying "skip" here would put a reason on rows that were
  // never candidates.
  if (!at || !size) return null;
  if (size[0] <= 0 || size[1] <= 0) return GEOMETRY_SKIP_BAD_SIZE;

  var wanted = { x: at[0], y: at[1], w: size[0], h: size[1] };

  var home = monitorRect(monitorByDescription(monitorsJson, recordedApp.monitorDescription));
  if (home) return rectsOverlap(wanted, home) ? null : GEOMETRY_SKIP_OFF_REGION;

  var monitors = monitorsJson || [];
  var asked = false;
  for (var i = 0; i < monitors.length; i++) {
    var rect = monitorRect(monitors[i]);
    if (!rect) continue;
    asked = true;
    if (rectsOverlap(wanted, rect)) return null;
  }
  return asked ? GEOMETRY_SKIP_OFF_REGION : null;
}

// The report-level roll-up: how the floats did against the tolerance, and how
// close the tiled windows came, per workspace and overall.
//
// Grouped by the RECORDED workspace, not the live one. The question is "how
// close is workspace 10 to the way workspace 10 was recorded", and a window
// that wandered to another workspace has to be counted as a miss ON THE
// WORKSPACE IT LEFT — putting it under the workspace it wandered to would
// quietly improve the score of a workspace that never had it.
//
// Only TILED windows feed the per-workspace means. Mixing a float's IoU in
// would make the number answer two questions at once: floats are pass/fail
// against a tolerance and are reported that way.
function geometrySummaryOf(apps, refusalByWorkspace) {
  var list = apps || [];
  var refusals = refusalByWorkspace || {};
  var floats = { total: 0, ok: 0, off: 0, notScored: 0 };
  var tiled = { total: 0, scored: 0, notScored: 0, meanIou: null };
  var order = [];
  var byWorkspace = {};
  var iouTotal = 0;

  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var score = entry && entry.geometry;
    if (!score) continue;

    if (score.mode === "float") {
      floats.total += 1;
      if (score.verdict === "ok") floats.ok += 1;
      else if (score.verdict === "geometry-off") floats.off += 1;
      else floats.notScored += 1;
      continue;
    }

    tiled.total += 1;
    if (score.verdict !== "scored" || score.iou === null) {
      tiled.notScored += 1;
      continue;
    }
    tiled.scored += 1;
    iouTotal += score.iou;

    var recorded = (entry.recorded) || {};
    var workspaceId = recorded.workspaceId;
    // A key, not a label: two monitors can each have a workspace whose id is
    // null in a broken read, and merging those into one row would invent a
    // workspace that does not exist.
    //
    // The NUL separator is spelled as an ESCAPE and never as a literal byte —
    // the same rule planRestore's wsKey states, for the same reason: one
    // literal NUL anywhere in this file makes the WHOLE file "binary" to grep,
    // which then answers "binary file matches" and nothing else for every other
    // line in it. It WAS a literal byte from tick 5sc until tick y29, which is
    // the tick that paid the cost; the string it builds is byte-for-byte the
    // same either way.
    var key = String(recorded.monitorDescription || "") + "\u0000" + String(workspaceId);
    if (!byWorkspace[key]) {
      byWorkspace[key] = {
        workspaceId: workspaceId === undefined ? null : workspaceId,
        monitorDescription: recorded.monitorDescription || "",
        count: 0,
        meanIou: null,
        // Why the tiled refinement will not touch this workspace, or null.
        // Keyed off the same NUL-joined recorded key, so the row and the app
        // rows under it can never disagree about which workspace was refused.
        refinement: refusals[key] || null,
        _total: 0
      };
      order.push(key);
    }
    byWorkspace[key].count += 1;
    byWorkspace[key]._total += score.iou;
  }

  var workspaces = [];
  for (var w = 0; w < order.length; w++) {
    var row = byWorkspace[order[w]];
    row.meanIou = round4(row._total / row.count);
    delete row._total;
    workspaces.push(row);
  }
  // Reading order, so two runs over the same desktop print the same table.
  workspaces.sort(function (a, b) {
    if (a.monitorDescription !== b.monitorDescription) {
      return a.monitorDescription < b.monitorDescription ? -1 : 1;
    }
    return Number(a.workspaceId) - Number(b.workspaceId);
  });

  if (tiled.scored > 0) tiled.meanIou = round4(iouTotal / tiled.scored);

  return {
    tolerance: GEOMETRY_TOLERANCE_PX,
    floats: floats,
    tiled: tiled,
    workspaces: workspaces
  };
}

// The phrase a verdict word becomes in a sentence. "not-judged" maps to the
// empty string on purpose: it contributes nothing to a row's text.
var VERDICT_PHRASES = {
  "wrong-workspace": "on the wrong workspace",
  "wrong-monitor": "on the wrong monitor",
  "monitor-absent": "its recorded monitor is not connected",
  "monitor-unknown": "no monitor was ever recorded for it",
  "workspace-special": "recorded on a special workspace — not restorable",
  "should-float": "should be floating",
  "should-tile": "should be tiled",
  "not-joined": "not in its recorded group",
  "wrong-order": "in its group in the wrong tab order",
  "unexpected-group": "grouped, but recorded standing alone",
  "missing-member": "its group is short a member that is here",
  "not-running": "not running",
  "identity-unknown": "no longer a watched app",
  "not-judged": "",
  // Geometry words. Only "geometry-off" has a phrase: "scored" and
  // "not-scored" are not complaints and must never read like one.
  "geometry-off": "not back at its recorded position and size",
  "scored": "",
  "not-scored": ""
};

// The dimensions `verdict.ok` is computed over as a LIST of words — the four
// things whose verdict is one word per dimension.
//
// Geometry is not in the list and cannot be, because its words do not mean the
// same thing: a tiled window scores `scored` (a number, not a complaint) and
// `not-scored` (nothing to compare), and a list membership test would read both
// as "not ok" and turn every tiled desktop red. It is folded into `verdict.ok`
// separately, in verdictForApp, on the ONE word that is a complaint —
// `geometry-off`, which geometryScoreFor only ever reaches in FLOAT mode.
//
// That fold is new in tick qkv and it reverses tick 5sc's rule for floats only.
// The reason is the one 5sc gave for the rule in the first place: a geometry
// miss was not something the tool could be blamed for because it had no op that
// moved a window by pixels. It has one now, for floats, so a float that is off
// is a restore that did not finish — and scripts/verify going red on it is the
// gate doing its job rather than an unactionable complaint. Tiled geometry is
// unchanged: still measured, still never enforced, still nothing an exit code
// can be built on until epic b9m says otherwise.
var VERDICT_DIMENSIONS = ["monitor", "workspace", "floating", "group"];

function verdictPhrase(word) {
  if (!word || word === "ok") return "";
  var phrase = own(VERDICT_PHRASES, word);
  return phrase === undefined ? String(word) : phrase;
}

function signed(value) {
  return (value > 0 ? "+" : "") + String(value);
}

// The geometry-off phrase, WITH the numbers. "not back where it was" invites
// the same "out of sync" report this project was built to answer; "Δpos +12,-4"
// tells the user how far and which way, which is the difference between a
// complaint and a measurement.
// A float the PLANNER will not act on has to say so in the same sentence.
// Otherwise the row is a complaint with no button behind it — the amber badge
// nothing can clear, which is the exact failure the ungroup op was written to
// end. These two say why, and both point at a fix the user can make (re-record
// here / the recording is damaged).
var GEOMETRY_SKIP_PHRASES = {
  "off-region": "its recorded rect is not on any monitor as they are arranged now,"
    + " so nothing was moved — re-record this topology",
  "non-positive-size": "its recorded size is not a usable rect, so nothing was moved"
};

function geometrySkipPhrase(skip) {
  if (!skip) return "";
  var phrase = own(GEOMETRY_SKIP_PHRASES, skip);
  return phrase === undefined ? String(skip) : phrase;
}

function geometryOffPhrase(detail) {
  var base = verdictPhrase("geometry-off");
  var delta = detail && detail.delta;
  var text = delta
    ? base + " (Δpos " + signed(delta.dx) + "," + signed(delta.dy)
      + " · Δsize " + signed(delta.dw) + "," + signed(delta.dh) + ")"
    : base;
  var skip = detail && detail.skip;
  return skip ? text + " — " + geometrySkipPhrase(skip) : text;
}

// Which of the five group words describes this app's grouping.
//
// Only ever asked when driftOf already said the group dimension drifted, so
// "ok" is not among the answers — the job here is to say WHICH kind of wrong.
function groupVerdictFor(app, groupsById) {
  var recorded = (app.recorded && app.recorded.group) || null;
  var live = (app.current && app.current.group && app.current.group.memberIds) || [];

  // Recorded standing alone, live tabbed in with other watched windows.
  if (!recorded) return "unexpected-group";

  var group = own(groupsById, recorded.groupId) || null;
  // The members that are actually here, in recorded tab order — the same list
  // the plan would rebuild. A member that is not restorable right now is not
  // this app's problem (it gets its own "not-running" verdict).
  // As TUPLE keys, because `live` is: two windows of one identity in a group
  // are two different members.
  var wanted = (group && group.memberKeys) || [];

  if (live.length === 0) return "not-joined";

  var wantedSet = {};
  for (var w = 0; w < wanted.length; w++) wantedSet[wanted[w]] = true;
  var liveSet = {};
  for (var l = 0; l < live.length; l++) liveSet[live[l]] = true;

  var extra = false;
  for (var e = 0; e < live.length; e++) {
    if (!own(wantedSet, live[e])) extra = true;
  }
  var short = false;
  for (var m = 0; m < wanted.length; m++) {
    if (!own(liveSet, wanted[m])) short = true;
  }

  if (extra) return "unexpected-group";
  if (short) return "missing-member";
  // Same members, both ways: the only thing left to be wrong is the order.
  return "wrong-order";
}

function verdictForApp(app, groupsById, blocked, instance) {
  var place = instance || null;
  var verdict = {
    identityId: (app && app.identityId) || "",
    // v3. WHICH window of the identity this verdict is about, and how many
    // windows the RECORDING has of it. `instances` is 1 for the overwhelming
    // majority of rows and it is what every consumer tests: a sentence only
    // disambiguates when there is something to disambiguate.
    occurrence: occurrenceOf(app && app.occurrence),
    instance: place ? place.index + 1 : 1,
    instances: place ? place.count : 1,
    status: (app && app.status) || "skipped",
    monitor: "ok",
    workspace: "ok",
    floating: "ok",
    group: "ok",
    ok: true,
    text: "",
    // Carried straight off the drift entry; nothing is decided a second time
    // here, for the same reason the placement words are derived rather than
    // recomputed.
    geometry: (app && app.geometry && app.geometry.verdict) || "not-scored",
    geometryDetail: (app && app.geometry) || null,
    blockedBy: null
  };

  var drift = (app && app.drift) || {};
  var recorded = (app && app.recorded) || {};

  if (verdict.status === "skipped") {
    if (app.reason === "identity-unknown") {
      verdict.monitor = "identity-unknown";
      verdict.workspace = "identity-unknown";
      verdict.floating = "identity-unknown";
      verdict.group = "identity-unknown";
    } else if (app.reason === "workspace-special") {
      // The WORKSPACE dimension carries this one — the monitor may be sitting
      // right there, and saying "monitor" about a scratchpad recording would
      // send the user to check a cable that is fine.
      verdict.workspace = "workspace-special";
      verdict.monitor = "not-judged";
      verdict.floating = "not-judged";
      verdict.group = "not-judged";
    } else {
      // monitor-absent / monitor-unknown: the monitor dimension carries the
      // whole story and the other three have no destination to be judged
      // against.
      verdict.monitor = app.reason || "not-judged";
      verdict.workspace = "not-judged";
      verdict.floating = "not-judged";
      verdict.group = "not-judged";
    }
  } else if (verdict.status === "missing") {
    verdict.monitor = "not-running";
    verdict.workspace = "not-running";
    verdict.floating = "not-running";
    verdict.group = "not-running";
  } else {
    if (drift.monitor) verdict.monitor = "wrong-monitor";
    if (drift.workspace) verdict.workspace = "wrong-workspace";
    if (drift.floating) verdict.floating = recorded.floating ? "should-float" : "should-tile";
    if (drift.group) verdict.group = groupVerdictFor(app, groupsById);
  }

  var phrases = [];
  for (var d = 0; d < VERDICT_DIMENSIONS.length; d++) {
    var word = verdict[VERDICT_DIMENSIONS[d]];
    if (word === "ok") continue;
    verdict.ok = false;
    var phrase = verdictPhrase(word);
    if (phrase && phrases.indexOf(phrase) === -1) phrases.push(phrase);
  }

  // Geometry joins the sentence, and since tick qkv it joins the verdict too —
  // but only on `geometry-off`, and `geometry-off` is a word geometryScoreFor
  // only reaches for a recorded FLOAT. A tiled window's `scored`/`not-scored`
  // leaves `ok` exactly where the loop above left it, so no tiled desktop is
  // marked down for a rect the tool cannot command. See VERDICT_DIMENSIONS.
  //
  // Last in the phrase list, so a row that is on the wrong monitor leads with
  // the wrong monitor. And only "geometry-off": a tiled window's score is a
  // number for the table, not a sentence for a row.
  if (verdict.geometry === "geometry-off") {
    verdict.ok = false;
    var geometryText = geometryOffPhrase(verdict.geometryDetail);
    if (phrases.indexOf(geometryText) === -1) phrases.push(geometryText);
  }
  verdict.text = phrases.join(", ");

  if (!verdict.ok && blocked && own(blocked, verdict.identityId)) {
    verdict.blockedBy = {
      kind: own(blocked, verdict.identityId).kind,
      reason: own(blocked, verdict.identityId).reason
    };
  }

  return verdict;
}

// What the last cycle tried to do for each identity, and why it did not take.
//
// `outcomes` is the service's per-op ledger: one entry per op it executed,
// { kind, subject, identityIds, ok, reason }. Only FAILED outcomes reach a
// verdict — a successful op needs no explanation — and the last failure for an
// identity wins, because a cycle runs several passes and the most recent one is
// the state the desktop was left in.
function blockedByIndex(outcomes) {
  var list = outcomes || [];
  var index = {};
  for (var i = 0; i < list.length; i++) {
    var outcome = list[i];
    if (!outcome || outcome.ok !== false) continue;
    var ids = outcome.identityIds || [];
    for (var j = 0; j < ids.length; j++) {
      if (!ids[j]) continue;
      index[ids[j]] = {
        kind: String(outcome.kind || ""),
        reason: String(outcome.reason || "")
      };
    }
  }
  return index;
}

// The verdict table for one driftOf report, in recorded order.
function verdictsFor(driftReport, outcomes) {
  var apps = (driftReport && driftReport.apps) || [];
  var groups = (driftReport && driftReport.groups) || [];
  var groupsById = {};
  for (var g = 0; g < groups.length; g++) {
    if (groups[g] && groups[g].groupId) groupsById[groups[g].groupId] = groups[g];
  }
  var blocked = blockedByIndex(outcomes);

  // How many rows each identity has in THIS report, and which of them each row
  // is. Counted over the drift report rather than off the occurrence numbers:
  // a recorded occurrence is a label and can have holes (see buildLayout's
  // `excluded`), and "window 2 of 2" has to count the rows the user can see.
  var counts = {};
  var seen = {};
  var i;
  for (i = 0; i < apps.length; i++) {
    var id = (apps[i] && apps[i].identityId) || "";
    counts[id] = (own(counts, id) || 0) + 1;
  }

  var out = [];
  for (i = 0; i < apps.length; i++) {
    var identityId = (apps[i] && apps[i].identityId) || "";
    var index = own(seen, identityId) || 0;
    seen[identityId] = index + 1;
    out.push(verdictForApp(apps[i], groupsById, blocked, {
      index: index,
      count: own(counts, identityId) || 1
    }));
  }
  return out;
}

// "window 2 of 2", or "" when the identity has only one recorded window.
//
// The disambiguator every instance-aware sentence uses, in one place so the
// panel row, the toast and scripts/verify cannot word it three ways. Sentences
// stay IDENTITY-level — "gmail is on the wrong workspace" is still what a user
// wants to read — and this is appended only when saying "gmail" would leave
// them looking at two windows wondering which one.
function verdictInstanceLabel(verdict) {
  if (!verdict) return "";
  var count = verdict.instances;
  if (typeof count !== "number" || count <= 1) return "";
  var index = typeof verdict.instance === "number" ? verdict.instance : 1;
  return "window " + index + " of " + count;
}

// The one honest sentence a toast can carry: how many apps are where the
// recording says, and who is not — by name and by reason.
//
// Counted over the apps a restore can ACT on (skipped apps are reported
// separately), because "8/9 arranged" has to mean "one of the nine I could
// have arranged is not", not "one of the nine has an unplugged monitor".
//
// The counts come from the verdicts and from nothing else. The old summary was
// a tally of dispatches ("1 grouped — 6 failed"), which says what the service
// tried, and the user has no way to read a desktop out of that.
function verdictSummary(verdicts) {
  var list = verdicts || [];
  var counted = 0;
  var arranged = 0;
  var skipped = 0;
  var blocked = [];

  for (var i = 0; i < list.length; i++) {
    var verdict = list[i];
    if (!verdict) continue;
    if (verdict.status === "skipped") {
      skipped += 1;
      continue;
    }
    counted += 1;
    if (verdict.ok) {
      arranged += 1;
      continue;
    }
    var instanceLabel = verdictInstanceLabel(verdict);
    blocked.push({
      identityId: verdict.identityId,
      // The name the toast says. One window of an app is the app's own name; two
      // windows of it have to be told apart or the same name appears twice in
      // one sentence saying two different things.
      label: instanceLabel ? verdict.identityId + " (" + instanceLabel + ")" : verdict.identityId,
      reason: (verdict.blockedBy && verdict.blockedBy.reason) || verdict.text || "out of place"
    });
  }

  var text = arranged + "/" + counted + " arranged";
  if (skipped > 0) text += ", " + skipped + " skipped";
  if (blocked.length) {
    var named = [];
    // Two names, then a count. A notification that lists nine apps is a
    // notification nobody reads to the end.
    for (var n = 0; n < blocked.length && n < 2; n++) {
      named.push(blocked[n].label + ": " + blocked[n].reason);
    }
    if (blocked.length > 2) named.push("+" + (blocked.length - 2) + " more");
    text += " — " + named.join("; ");
  }

  return {
    total: list.length,
    counted: counted,
    arranged: arranged,
    skipped: skipped,
    blocked: blocked,
    ok: blocked.length === 0,
    text: text
  };
}

// ---------------------------------------------------------------------------
// Tiled placement: reading a dwindle tree back out of the rects it produced
// ---------------------------------------------------------------------------
//
// Hyprland exposes no split-tree API — that sentence has been in this project
// since tick 5sc and it is still true. What tick or5's probe found is that the
// tree does not have to be READ, because it can be RECONSTRUCTED: dwindle is a
// guillotine layout, so every tiling it produces is a binary tree of straight
// cuts, and a set of recorded rects determines such a tree (up to ambiguities
// that do not matter — see below).
//
// Three live facts hold this up, all in docs/state-matrix.md § Tiled placement:
//
//   1. arrival order fixes occupancy — the k-th window to arrive takes the k-th
//      slot, byte-identically across repeats;
//   2. `dwindle:force_split = 2` (Omarchy sets it) means a new window always
//      takes the RIGHT or BOTTOM half of the tile it splits, so at every cut
//      the left/top side is the window that was already there and the
//      right/bottom side is the newcomer;
//   3. the tile that gets split is the one whose window holds the FOCUS — and
//      with no focus on that workspace it is whichever tile the mouse pointer
//      happens to be over, by layout coordinates, on a workspace nobody can
//      see. That is the non-determinism this reconstruction exists to remove.
//
// So: cut the recorded rects into a tree, then read an insertion program off it.
//
// AMBIGUITY IS HARMLESS *WHEN BUILDING FROM EMPTY* — and that qualifier is tick
// eqb's, because the sentence was written without it and it is only half true.
// A 2×2 grid can be cut vertically-then-horizontally or horizontally-then-
// vertically, and the two trees are different programs — but they lay out the
// SAME FOUR RECTS, and a program that fills an empty workspace is judged by
// nothing except the rects it produces. So the search takes the first cut it
// finds (vertical before horizontal, nearest boundary first) and does not
// agonise: for PLACEMENT, every valid cut is a correct answer.
//
// It is NOT harmless when REFINING a tiling that already exists. There the tree
// is not a program about to be run, it is a CLAIM about the tree the compositor
// is already holding, and a divider nudge is aimed through that claim: the sign
// law (§ 8) is read off the reconstruction, and if the compositor's real tree is
// the other one, the nudge lands on the wrong divider from the wrong side and
// moves it `2 × current − asked` — away from the target, on a workspace this
// project's own ceiling promises to leave alone. Three columns side by side are
// one set of rects and two dwindle trees (`(a|b)|c` and `a|(b|c)`); so is a 2×2
// grid. That case is REFUSED rather than guessed at — see tilingRefusalOf.
//
// FAILURE IS A WORD, NOT A GUESS. A set of rects that is not a guillotine
// partition — overlapping, pinwheeled, or recorded against a monitor
// arrangement these coordinates no longer describe — returns null, and the
// planner falls back to plain recorded order with no focus choreography at all.
// There is no "closest tree": a wrong tree is a program that focuses the wrong
// windows and assembles a layout nobody recorded.

function isRectPair(value) {
  return Object.prototype.toString.call(value) === "[object Array]" &&
    value.length === 2 && typeof value[0] === "number" && isFinite(value[0]) &&
    typeof value[1] === "number" && isFinite(value[1]);
}

// EVERY way these rects are separable by one straight line on `axis`, in
// near-to-far order. `axis` 0 is a vertical cut (x), 1 is horizontal (y).
//
// All of them and not just the first, because "how many are there" is a
// question with two different callers: the tree build wants one cut and takes
// the nearest, and the ambiguity guard wants the COUNT and refuses at two.
function guillotineCuts(items, axis) {
  var sorted = items.slice().sort(function (a, b) {
    var d = a.at[axis] - b.at[axis];
    if (d) return d;
    // A stable tie-break, so two runs over one recording cut identically.
    var e = a.size[axis] - b.size[axis];
    if (e) return e;
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });

  var cuts = [];
  for (var i = 1; i < sorted.length; i++) {
    var maxFar = -Infinity;
    for (var l = 0; l < i; l++) {
      var far = sorted[l].at[axis] + sorted[l].size[axis];
      if (far > maxFar) maxFar = far;
    }
    var minNear = Infinity;
    for (var r = i; r < sorted.length; r++) {
      if (sorted[r].at[axis] < minNear) minNear = sorted[r].at[axis];
    }
    // `<=` and not `<`: adjacent tiles are separated by a gap on this desktop
    // (gaps_in 5), but a zero-gap configuration is legal and must still cut.
    if (maxFar <= minNear) cuts.push({ near: sorted.slice(0, i), far: sorted.slice(i) });
  }
  return cuts;
}

// The nearest cut on this axis, or null. What the tree build takes.
function guillotineCut(items, axis) {
  var cuts = guillotineCuts(items, axis);
  return cuts.length ? cuts[0] : null;
}

// Do these rects fit MORE THAN ONE guillotine tree?
//
// Asked at every node, because ambiguity anywhere is ambiguity about which
// divider a nudge moves: three collinear same-axis cuts (`(a|b)|c` versus
// `a|(b|c)`) and a 2×2 grid (cut vertically first or horizontally first) are the
// two shapes that produce it, and both are ordinary desktops. A node with
// exactly one cut is determined — the compositor's tree is a guillotine tree
// over these same rects, so if only one such cut exists at this node, that IS
// the compositor's cut — and the question recurses into the two sides it makes.
//
// A node with NO cut is not ambiguous, it is not a tiling at all; splitTreeOf
// answers that one with null and tilingRefusalOf gives it its own word, because
// "we cannot tell which of two trees this is" and "this is not a tree" are
// different sentences and only one of them is about a layout dwindle can make.
function layoutIsAmbiguous(items) {
  var list = items || [];
  if (list.length < 2) return false;
  var cuts = guillotineCuts(list, 0).concat(guillotineCuts(list, 1));
  if (cuts.length !== 1) return cuts.length > 1;
  return layoutIsAmbiguous(cuts[0].near) || layoutIsAmbiguous(cuts[0].far);
}

// The tree, or null. A node is { key } for a leaf, or { axis, near, far } for a
// cut — `near` the left/top side (the incumbent) and `far` the right/bottom
// side (the arrival that made the cut).
function splitTreeOf(items) {
  var list = items || [];
  if (!list.length) return null;
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!it || !isRectPair(it.at) || !isRectPair(it.size)) return null;
    if (!(it.size[0] > 0) || !(it.size[1] > 0)) return null;
  }
  if (list.length === 1) return { key: list[0].key };

  for (var axis = 0; axis < 2; axis++) {
    var cut = guillotineCut(list, axis);
    if (!cut) continue;
    var near = splitTreeOf(cut.near);
    var far = splitTreeOf(cut.far);
    if (!near || !far) return null;
    return { axis: axis, near: near, far: far };
  }
  return null;
}

// The window that holds a subtree's whole rect until that subtree is cut: keep
// taking the near side, because the near side is always the incumbent.
function firstKeyOf(node) {
  if (!node) return "";
  if (node.key !== undefined) return node.key;
  return firstKeyOf(node.near);
}

// The insertion program: [{ key, parentKey }] in the order the windows must
// arrive, `parentKey` naming the window whose tile each arrival has to split
// (null for the first, which lands on an empty workspace).
//
// PRE-ORDER, and that is the whole correctness argument. At the moment a cut's
// arrival is dispatched, the incumbent must be holding that cut's ENTIRE rect —
// undivided. Emitting a node's own cut before descending into either child says
// exactly "every cut above me has happened and no cut below me has", which is
// that condition. Emitting a whole subtree before its sibling — the obvious
// depth-first order — breaks it: the incumbent would already have been cut up
// by its own descendants, and the arrival would split a fragment.
//
// Checked against the probe's own builds: the 4-window "spine 1→2→3" tree reads
// back as 1, 2←1, 3←2, 4←3, and the 4-window "all splits on 1" tree reads back
// as 1, 2←1, 3←1, 4←1 — which are the two programs that built them.
function placementOrderOf(items) {
  var tree = splitTreeOf(items);
  if (!tree) return null;

  var order = [{ key: firstKeyOf(tree), parentKey: null }];
  var queue = [tree];
  while (queue.length) {
    var node = queue.shift();
    if (node.key !== undefined) continue;
    order.push({ key: firstKeyOf(node.far), parentKey: firstKeyOf(node.near) });
    // Unshifted, near first, so the traversal stays pre-order rather than
    // becoming a breadth-first sweep — see the argument above.
    queue.unshift(node.far);
    queue.unshift(node.near);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Tiled refinement: the two things left over once the windows are on the
// workspace (tick pyo)
// ---------------------------------------------------------------------------
//
// Tick 35n closed the case where a workspace is BUILT by the restore: the moves
// go in tree order, each naming the tile it splits, and the recorded tiling
// comes back exactly. It closed nothing at all for the case the user actually
// reported, because in that one nothing has to move. A redock re-tiled
// workspace 8 in place, both windows were already on the workspace they belong
// to, `planRestore` emitted zero ops and the desktop scored 0.782 with every
// verdict green (docs/bench/baseline.md, the `reorder` shape).
//
// Two defects live in that gap, and they are NOT the same defect:
//
//   OCCUPANCY   the tiling has the right SLOTS and the wrong windows in them.
//               The user's ws-8 case. Fixed by exchanging two windows, which
//               `hl.dsp.window.swap({ window, target })` does exactly —
//               address-targeted on both ends, focus-independent, safe on a
//               hidden workspace, loud about every way it can fail, and it
//               moves no divider (tick or5, § Tiled placement § 7).
//   RATIO       the right windows in the right slots, with the dividers in the
//               wrong places. The user's `herdr` case at 0.497 — composition
//               dependent sizing, which is what a split ratio is. Fixed by
//               `hl.dsp.window.resize`, which on a tiled window moves the
//               divider its far edge sits on.
//
// Both are done here, in that order, because a swap exchanges whole rects: fix
// who is where first, then where the lines between them are.
//
// THE SIGN LAW is the reason this converges instead of running away, and it is
// measured rather than reasoned (or5 § 8):
//
//   `resize` at a tiled window is EXACT if and only if the window is the
//   LEFT/TOP child of the divider being moved. Aimed at the right/bottom child
//   it lands on `2 × current − asked` — away from the target by exactly the
//   amount asked for.
//
// So a window is only ever nudged on an axis where its FAR EDGE IS A DIVIDER
// rather than the edge of the workspace. That is readable straight off the live
// rects, it is never more than one side of any divider, and it is why two
// windows can never be found pulling at the same line in opposite directions —
// the planner will not emit the second op at all.
//
// AND THE PRECONDITION THAT MAKES IT HONEST: refinement adjusts a tiling, it
// does not build one. Both the recorded rects and the live rects must
// reconstruct a guillotine tree, and the two trees must have the SAME
// STRUCTURE. Same slots, possibly different occupants, possibly different
// ratios. A live tiling of a different shape is not something a resize can
// reach — no sequence of divider moves turns one split tree into another — and
// pretending otherwise would burn a plan's iterations distorting a layout it
// cannot fix. That case belongs to 35n's placement, or to nothing.
//
// AND THE SECOND PRECONDITION, added in tick eqb: the reconstruction has to be
// the ONLY one. Placement can shrug at an ambiguous set of rects because it is
// building from empty and every valid tree builds the same desktop; refinement
// cannot, because it is aiming a dispatch at a divider it has inferred. On an
// ambiguous layout that inference can be wrong, and a wrong inference here is
// not a missed opportunity — it is the sign law inverting and a divider moving
// the wrong way on a workspace this project promises not to touch. So an
// ambiguous workspace is refused, by name, and left exactly as it is.

// Structure only, ignoring which window is where: same cut axes in the same
// places, same leaves in the same positions.
function sameTreeStructure(a, b) {
  if (!a || !b) return false;
  var aLeaf = a.key !== undefined;
  var bLeaf = b.key !== undefined;
  if (aLeaf !== bLeaf) return false;
  if (aLeaf) return true;
  if (a.axis !== b.axis) return false;
  return sameTreeStructure(a.near, b.near) && sameTreeStructure(a.far, b.far);
}

// The leaves, near side first — a canonical position order, so position i in
// one tree and position i in a structurally identical tree are THE SAME SLOT.
function leafKeysOf(node, out) {
  var acc = out || [];
  if (!node) return acc;
  if (node.key !== undefined) { acc.push(node.key); return acc; }
  leafKeysOf(node.near, acc);
  leafKeysOf(node.far, acc);
  return acc;
}

// ---------------------------------------------------------------------------
// ONE FLIP: the shape difference that IS reachable (tick uk5)
// ---------------------------------------------------------------------------
//
// "No sequence of divider moves turns one split tree into another" is true, and
// it is the whole argument for the different-shape refusal. It is also not the
// whole story, because a resize is not the only thing the compositor offers: the
// dwindle layout has `togglesplit`, which flips ONE node's orientation and moves
// nothing else. Omarchy binds it to SUPER+J, which is exactly how the case
// arrives — a user pressed it after the recording was made, or a stray click
// mid-choreography made an arrival split the same tile the other way (§ 11 of
// the state matrix).
//
// So the refusal is narrowed to what it can honestly claim: two trees that
// differ by EXACTLY ONE node's split orientation, with the same leaves in the
// same slots elsewhere, are ONE dispatch apart, and that dispatch is planned.
// Anything more than one flip is still refused by name — two flips are not two
// togglesplits, because the first one changes every rect below it and the second
// node has to be found again in a tree this planner has not re-read.
//
// THE NODE HAS TO BE THE PARENT OF A LEAF, and that is not a simplification —
// it is what makes the dispatch aimable. `togglesplit` toggles the split of the
// FOCUSED WINDOW'S PARENT node (dwindle: `PNODE->pParent->splitTop = !…`), so
// the only nodes it can be pointed at are the ones that have a window directly
// under them. A flip wanted higher up the tree has no window to focus that would
// reach it, and is refused with everything else.
//
// In practice, and worth saying out loud rather than discovering later: the
// ambiguity guard above means this fires almost exclusively on a TWO-WINDOW
// node. In an unambiguous guillotine tree every non-leaf node's axis differs
// from its parent's — three same-axis regions in a row are precisely the
// `(a|b)|c` ambiguity — so flipping any node whose parent or child is a node
// makes the live layout ambiguous, and an ambiguous layout is refused before
// this question is ever asked. That is not a defect in this rule: a flip we
// cannot locate in a tree we cannot identify is a guess, and the eqb law says
// this planner does not guess about live trees. What is left is the common case
// and the reported one — two windows side by side that should be stacked.
function collectFlips(recorded, live, out) {
  if (!recorded || !live) return false;
  var recordedLeaf = recorded.key !== undefined;
  var liveLeaf = live.key !== undefined;
  if (recordedLeaf !== liveLeaf) return false;
  if (recordedLeaf) return true;
  if (recorded.axis !== live.axis) out.push(live);
  if (!collectFlips(recorded.near, live.near, out)) return false;
  return collectFlips(recorded.far, live.far, out);
}

// A window directly under this node — the near side first, because the near
// side is the incumbent and naming it keeps the choice the same on every run.
function leafChildKeyOf(node) {
  if (!node || node.key !== undefined) return null;
  if (node.near && node.near.key !== undefined) return node.near.key;
  if (node.far && node.far.key !== undefined) return node.far.key;
  return null;
}

function sameLeafSet(a, b) {
  var left = leafKeysOf(a).slice().sort();
  var right = leafKeysOf(b).slice().sort();
  if (left.length !== right.length) return false;
  for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

// { node, address } when the live tree is the recorded tree with exactly one
// node flipped and that node is reachable by a focus, or null.
//
// Occupancy is deliberately NOT part of the question: the leaves may be in each
// other's slots, and that is the swap pass's business on the NEXT plan, once the
// shape matches and the swap pass is allowed to look at all.
function singleFlipOf(recordedTree, liveTree) {
  if (!recordedTree || !liveTree) return null;
  var flips = [];
  if (!collectFlips(recordedTree, liveTree, flips)) return null;
  if (flips.length !== 1) return null;
  // The same windows on both sides, or "the same slot" is a sentence about two
  // different desktops and the flip would be aimed at a tree nobody recorded.
  if (!sameLeafSet(recordedTree, liveTree)) return null;
  var address = leafChildKeyOf(flips[0]);
  if (!address) return null;
  return { node: flips[0], address: address };
}

// A window's far edge on this axis: is there a tile immediately beyond it?
//
// Asked PER PAIR and not against the workspace's overall extent, which was the
// first way this was written and was wrong — a window can have something else
// far away on the same axis while its own far edge is the edge of the world,
// and asking that window for a size then moves a divider it is not touching or
// no divider at all. The property test found it. So: a real neighbour, one
// whose near edge is at or beyond this far edge AND which overlaps this window
// on the OTHER axis, because two tiles that do not overlap perpendicularly do
// not share a line.
function farEdgeIsDivider(rect, items, axis) {
  var perp = axis === 0 ? 1 : 0;
  var edge = rect.at[axis] + rect.size[axis];
  for (var i = 0; i < items.length; i++) {
    var other = items[i];
    if (other === rect) continue;
    if (other.at[axis] < edge) continue;
    if (other.at[perp] >= rect.at[perp] + rect.size[perp]) continue;
    if (rect.at[perp] >= other.at[perp] + other.size[perp]) continue;
    return true;
  }
  return false;
}

function subtreeHasKey(node, key) {
  if (!node) return false;
  if (node.key !== undefined) return node.key === key;
  return subtreeHasKey(node.near, key) || subtreeHasKey(node.far, key);
}

// WHICH divider does a resize on this window move, and is the ask exact?
//
// The first two answers to this were both wrong, and both wrong in ways only a
// live round could show, so they are recorded here rather than quietly fixed:
//
//   1. "order by how long the divider is" — the perpendicular extent of the
//      window as a stand-in for depth. Wrong in the very tree § 9 of the state
//      matrix measured, where the INNER divider is 1002 px long and the outer
//      one 850, so the proxy took the inner cut first and the outer nudge then
//      rescaled the ratio it had just set.
//   2. "the window whose far edge touches the divider is the one that can push
//      it" — read straight off the rects. That one measured WORSE on a live
//      four-window round (0.622 -> 0.552) and it is worth being precise about
//      why, because it is the whole subtlety of this op. In a fan tree the
//      top-right window's far edge really does sit against the ROOT divider —
//      and resizing it does not move the root divider at all, because Hyprland
//      walks up from the window to the NEAREST ancestor split of the matching
//      orientation, which is the little one it shares with its left-hand
//      neighbour. It moved that instead, and moved it the wrong way, because on
//      that split the window is the FAR child: 472 asked for 341 became 603,
//      which is 2 x 472 - 341 to the pixel.
//
// So the question is asked of the TREE and only of the tree: walk down to the
// leaf, keep the LAST ancestor whose axis matches — that is the nearest one,
// and it is the divider Hyprland will move — and report which side of it the
// window is on. The ask is exact only from the NEAR side (the sign law), and
// the depth is what orders outer cuts before inner ones.
//
// Exactness of the value follows from "nearest": there is no cut of this
// orientation between the window and that divider, so the window's extent on
// this axis IS the near side's extent, and setting one sets the other.
function nearestAxisCut(node, key, axis) {
  var depth = 0;
  var at = node;
  var found = null;
  while (at && at.key === undefined) {
    var inNear = subtreeHasKey(at.near, key);
    if (at.axis === axis) found = { depth: depth, onNear: inNear };
    at = inNear ? at.near : at.far;
    depth += 1;
  }
  return found;
}

var TILED_REFINEMENT_TARGET_IOU = 0.95;

// How many divider nudges one workspace may be given before the service stops
// asking. One nudge per workspace per plan is the RATE (see the block below the
// candidate sort); this is the TOTAL, and it is the number Service.qml counts
// refinement iterations against instead of counting them against the general
// iteration cap.
//
// Why the two caps had to be separated (tick eqb): a dwindle tree of n windows
// has n − 1 cuts, so a workspace of seven windows can need six nudges — six
// plan/execute iterations, every one of them making real progress — and the
// general cap is five. The pass gave up on iteration six with a GIVE-UP warning
// and a counted failure, and the cycle then converged anyway on its next settle
// pass: a "1 failed" toast on a restore that finished perfectly. The general cap
// is not the wrong number for the work it is about (a move, a group join or a
// float toggle that has not landed in five tries is not going to), it is simply
// not about this work, where each iteration is one deliberate step of a bounded
// walk down a tree.
//
// 12 is a workspace of thirteen windows, which is past the point where the
// per-window tile is bigger than the compositor's minimum. The no-progress check
// still stops a refinement that is stuck on its very next iteration, so this
// bound is only ever reached by a workspace that is genuinely still converging.
var TILED_REFINEMENT_MAX_NUDGES = 12;

// ---------------------------------------------------------------------------
// When refinement REFUSES a workspace, and in which words
// ---------------------------------------------------------------------------
//
// Each of these is a sentence the tool can say out loud, which is the whole
// reason they are words rather than a bare null. A refusal is not a failure —
// it is this project's ceiling doing its job — but a ceiling nobody can see is
// indistinguishable from a bug, and "workspace 8 is 0.78 and the tool does
// nothing about it, for ever" is exactly the report that gets filed.
var TILING_REFUSAL_NOT_A_TREE = "not-a-tree";
var TILING_REFUSAL_AMBIGUOUS = "ambiguous-tree";
var TILING_REFUSAL_DIFFERENT_SHAPE = "different-shape";

var TILING_REFUSAL_PHRASES = {
  "not-a-tree": "these rects are not a guillotine tiling, so there is no divider to aim at",
  "ambiguous-tree": "these rects fit more than one split tree, so which divider a nudge"
    + " would move is a guess — the shape is left exactly as it is",
  "different-shape": "the live split shape differs from the recording by more than one"
    + " flip, and no sequence of divider moves reaches another shape"
};

function tilingRefusalPhrase(reason) {
  if (!reason) return "";
  var phrase = own(TILING_REFUSAL_PHRASES, reason);
  return phrase === undefined ? String(reason) : phrase;
}

// Why this workspace cannot be refined, or null when it can.
//
// Asked of the two rect sets and of nothing else, so the planner and the report
// answer it the same way — the planner to decide whether to emit ops, driftOf to
// put the reason where `scripts/verify` and the panel can print it.
//
// Returns null for the cases that are not refusals at all: fewer than two
// windows (nothing to refine), or two sets of different sizes (a workspace
// mid-restore, which the gate above has already excluded and which will be
// asked again next pass).
function tilingRefusalOf(recordedItems, liveItems) {
  var recorded = recordedItems || [];
  var live = liveItems || [];
  if (recorded.length < 2 || recorded.length !== live.length) return null;

  var recordedTree = splitTreeOf(recorded);
  var liveTree = splitTreeOf(live);
  if (!recordedTree || !liveTree) return TILING_REFUSAL_NOT_A_TREE;
  // Ambiguity is asked BEFORE the structure comparison, because on an ambiguous
  // layout the structure comparison is comparing two guesses: both sides
  // reconstruct to whichever tree the search happened to find first, and "the
  // same structure" would then be a statement about this function's tie-breaks
  // rather than about the desktop.
  if (layoutIsAmbiguous(recorded) || layoutIsAmbiguous(live)) return TILING_REFUSAL_AMBIGUOUS;
  if (!sameTreeStructure(recordedTree, liveTree)) {
    // …unless it is ONE flip away, which `togglesplit` reaches in a single
    // dispatch. Not a refusal at all then — planWorkspaceTiling emits the op.
    if (singleFlipOf(recordedTree, liveTree)) return null;
    return TILING_REFUSAL_DIFFERENT_SHAPE;
  }
  return null;
}

// The refinement program for ONE workspace, or null when there is nothing this
// can honestly do.
//
//   recordedItems  [{ key, at, size }]  what the recording says
//   liveItems      [{ key, at, size }]  what is on the workspace now
//
// Returns { swaps: [{ address, target }], dividers: [{ address, size }] }.
//
// `refusalOut` (optional) is an object this fills in with `.reason` when it
// refuses for a reason worth saying out loud — an out-parameter rather than a
// richer return value because every caller and every test of this function
// reads "null means nothing to do", and a refusal IS nothing to do.
function planWorkspaceTiling(recordedItems, liveItems, refusalOut) {
  var recorded = recordedItems || [];
  var live = liveItems || [];
  if (recorded.length < 2 || recorded.length !== live.length) return null;

  var refusal = tilingRefusalOf(recorded, live);
  if (refusal) {
    if (refusalOut) refusalOut.reason = refusal;
    return null;
  }

  var recordedTree = splitTreeOf(recorded);
  var liveTree = splitTreeOf(live);

  // ONE FLIP AND NOTHING ELSE THIS PLAN. The flip changes every rect under the
  // flipped node, so any swap or nudge computed here would be computed against
  // a tiling that is about to stop existing. The pass's own re-plan is where
  // occupancy and ratios get their turn — against the shape this op produced,
  // read back from the compositor rather than predicted.
  var flip = singleFlipOf(recordedTree, liveTree);
  if (flip) {
    return { swaps: [], dividers: [], split: { address: flip.address }, meanIou: null };
  }

  var wantOrder = leafKeysOf(recordedTree);
  var haveOrder = leafKeysOf(liveTree);
  if (wantOrder.length !== haveOrder.length) return null;

  var recordedByKey = {};
  for (var i = 0; i < recorded.length; i++) recordedByKey[recorded[i].key] = recorded[i];
  var liveByKey = {};
  for (var j = 0; j < live.length; j++) liveByKey[live[j].key] = live[j];
  // Every key on one side must exist on the other, or "the same slot" is a
  // sentence about two different desktops.
  for (var w = 0; w < wantOrder.length; w++) if (!own(liveByKey, wantOrder[w])) return null;
  for (var h = 0; h < haveOrder.length; h++) if (!own(recordedByKey, haveOrder[h])) return null;

  // ---- occupancy: selection-sort `have` into `want`, one swap per fix.
  //
  // Simulated as it goes, so the emitted list is a program that is correct when
  // run start to finish against a desktop none of it has touched yet — a swap
  // exchanges exactly two windows' rects and nothing else, which is what makes
  // that simulation trustworthy rather than optimistic.
  var current = haveOrder.slice();
  var swaps = [];
  for (var s = 0; s < current.length; s++) {
    if (current[s] === wantOrder[s]) continue;
    var from = current.indexOf(wantOrder[s]);
    if (from < 0) return null;
    swaps.push({ address: current[s], target: current[from] });
    var t = current[s]; current[s] = current[from]; current[from] = t;
  }

  // ---- ratios, against the arrangement the swaps will have produced.
  //
  // Slot i is a live RECT; after the swaps the window that holds it is
  // wantOrder[i]. So the ratio question is asked of the slots, not of the
  // windows, and it is the same question whether a swap happened or not.
  var slots = [];
  for (var p = 0; p < haveOrder.length; p++) slots.push(liveByKey[haveOrder[p]]);

  // Stop when the slots are already close enough. The threshold is a stated
  // number and not a hidden one: 0.95 mean IoU over the workspace, which on
  // this monitor is a divider within about 2% of where it was recorded — below
  // what a person can see, and above the point where another dispatch buys
  // anything. A workspace already there is left alone entirely, which is what
  // keeps a settled desktop from being nudged on every dock event for ever.
  var iouTotal = 0;
  var iouCount = 0;
  for (var q = 0; q < wantOrder.length; q++) {
    var score = rectIou(
      { at: recordedByKey[wantOrder[q]].at, size: recordedByKey[wantOrder[q]].size },
      { at: slots[q].at, size: slots[q].size });
    if (score === null) continue;
    iouTotal += score;
    iouCount += 1;
  }
  var meanIou = iouCount ? iouTotal / iouCount : null;

  var dividers = [];
  if (meanIou === null || meanIou < TILED_REFINEMENT_TARGET_IOU) {
    var candidates = [];
    for (var c = 0; c < wantOrder.length; c++) {
      var want = recordedByKey[wantOrder[c]];
      var slot = slots[c];
      for (var axis = 0; axis < 2; axis++) {
        if (Math.abs(want.size[axis] - slot.size[axis]) <= GEOMETRY_TOLERANCE_PX) continue;
        // A second, independent check, on the RECTS rather than on the tree:
        // there really is a tile immediately beyond this edge. Redundant on a
        // real tiling and cheap, and it is what keeps the property test's
        // simulator — which has no tree, only rects — able to model this op at
        // all.
        if (!farEdgeIsDivider(slot, slots, axis)) continue;
        var cut = nearestAxisCut(recordedTree, wantOrder[c], axis);
        // THE SIGN LAW, asked of the tree: only the near side of the divider
        // this resize would actually move can be asked for a size and get it.
        // This is also the whole of the no-oscillation guarantee — for any one
        // divider exactly one of the two sides is ever a candidate, so two
        // windows can never be found pulling at one line in opposite
        // directions.
        if (!cut || !cut.onNear) continue;
        var size = [slot.size[0], slot.size[1]];
        size[axis] = want.size[axis];
        candidates.push({ address: wantOrder[c], axis: axis, size: size, depth: cut.depth, index: c });
      }
    }
    // Outer dividers first, because an outer nudge rescales every ratio below
    // it (or5 § 9: the outer-then-inner pair restored a two-divider tree
    // exactly, and the other order would have had the outer move undo the inner
    // one). "Outer" is read off the tree, not guessed at from the rects — see
    // cutDepthFor. Ties break on slot position and then axis, so the choice is
    // the same choice on every run over one desktop.
    candidates.sort(function (a, b) {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (a.index !== b.index) return a.index - b.index;
      return a.axis - b.axis;
    });

    // ONE NUDGE PER WORKSPACE PER PLAN, and this is the hard cap the tick asks
    // for — expressed as a rate rather than a total, which is what makes it
    // both bounded and read-gated.
    //
    // The reason is not caution, it is correctness. Every candidate above was
    // computed against the rects as they are NOW, and a divider move changes
    // the rects of everything on the far side of it. A plan carrying two nudges
    // would dispatch the second one at numbers the first one had already
    // invalidated — including on the axis it was not trying to move, where the
    // op carries the current size precisely so that axis stays still. So the
    // plan takes one, and the pass's own re-plan loop takes the next against a
    // fresh read. That IS the "confirm read after each nudge" the refinement
    // needs, and it is machinery this service already has rather than a second
    // loop inside an op.
    //
    // The total is therefore bounded by the pass: Service.maxIterations is 5,
    // and a dwindle tree of n windows has n − 1 cuts, so a workspace of up to
    // six windows converges inside one pass and anything deeper finishes across
    // the three settle passes. A workspace that has not converged by then is
    // not slow, it is stuck, and the no-progress check names the op.
    if (candidates.length) {
      dividers.push({ address: candidates[0].address, axis: candidates[0].axis, size: candidates[0].size });
    }
  }

  if (!swaps.length && !dividers.length) return null;
  return { swaps: swaps, dividers: dividers, meanIou: meanIou };
}

// ---------------------------------------------------------------------------
// Restore: the ordered op list
// ---------------------------------------------------------------------------
//
//   Op = { kind: "launch", identityId }
//      | { kind: "ungroup", addresses }
//            // addresses: windows RECORDED UNGROUPED that the live desktop has
//            //   tabbed together with other watched windows — one op per live
//            //   group, members in live tab order. The service dissolves them
//            //   through the claim-based machinery (dissolveStep), which is
//            //   split-brain-tolerant and re-reads before every toggle.
//            //   Groups made purely of unwatched windows never produce one of
//            //   these: driftOf only sees watched members.
//      | { kind: "workspace-monitor", workspaceId, monitorDescription,
//                                     monitorName }
//      | { kind: "move",   address, workspaceId, monitorDescription }
//      | { kind: "floating", address, value }
//            // value: the recorded floating state. Executed by the service as
//            //   a READ-GATED targeted toggle — see the floating verb evidence
//            //   above opToCommand: on Hyprland 0.56 the float dispatcher only
//            //   ever toggles, so a blind dispatch can invert a window that is
//            //   already right.
//      | { kind: "split",  address, workspaceId }
//            // address: a window whose PARENT node in the live split tree has
//            //   the wrong orientation — the one node the live tiling differs
//            //   from the recording by. Executed as focus + `togglesplit`;
//            //   focus-dependent, so it defers while the session is locked.
//      | { kind: "group",  addresses, missing }
//            // addresses: the members that are here, in RECORDED tab order —
//            //   the rebuild reproduces exactly this order, tab for tab.
//            // missing:   recorded members that could not take part, so the
//            //   service can log which app the group is short of.
//
// Order is launches, then ungroups, then workspace-monitor, then moves, then
// floatings, then groups:
//   - a window that has to be launched has no address to do anything to yet;
//   - stale groups are dissolved BEFORE any move, because Hyprland moves a
//     grouped window's whole group with it — moving first would drag windows
//     that are recorded elsewhere onto the wrong workspace;
//   - a window has to be on the right workspace before the workspace's monitor
//     decides which screen it shows up on;
//   - floating is restored after the moves (a float toggle re-places the window
//     within its CURRENT workspace) and before the groups (a group member must
//     be tiled for into_group to find it);
//   - a group can only be formed once its members are on the right workspace.
//
// Why "workspace-monitor" exists at all: in Hyprland a workspace lives on
// exactly ONE output, so a window's monitor IS its workspace's monitor. A
// window that is already on its recorded workspace but on the wrong monitor
// therefore cannot be fixed by moving the window — `window.move({ workspace })`
// onto the workspace it is already on is a no-op, and the identical plan would
// be emitted forever. The workspace itself has to move.
//
// The plan is IDEMPOTENT: run it against a conforming desktop and it is empty.
// That is what makes the restore safe to re-run, which is the whole strategy —
// after the launches settle the service simply plans again, and the second plan
// contains the moves and groups the first could not express.

function planRestore(clientsJson, monitorsJson, layout, identities) {
  var clients = clientsJson || [];
  var report = driftOf(clients, monitorsJson, layout, identities);
  var recordedApps = (layout && layout.apps) || [];

  var launches = [];
  var ungroups = [];
  var ungroupByLiveGroup = {};
  var ungroupOrder = [];
  var workspaceMoves = [];
  var seenWorkspaceMoves = {};
  var moves = [];
  var moveRects = [];
  var floatings = [];
  var groups = [];
  var geometries = [];

  for (var i = 0; i < recordedApps.length; i++) {
    var recorded = recordedApps[i];
    var entry = report.apps[i];

    if (entry.status === "skipped") continue;

    if (entry.status === "missing") {
      launches.push({ kind: "launch", identityId: recorded.identityId });
      continue;
    }

    // Recorded ungrouped, live tabbed in with other watched windows: the
    // recording says "this window stands alone", so the live group has to go.
    // Collected per LIVE group (current.group.groupId), because dissolving is
    // a per-group act — group.toggle on any member takes the whole group down —
    // and one op per group is what lets the service log it as one event.
    if (!recorded.group && entry.drift.group && entry.current && entry.current.group) {
      var liveGroupId = entry.current.group.groupId;
      if (!ungroupByLiveGroup[liveGroupId]) {
        ungroupByLiveGroup[liveGroupId] = [];
        ungroupOrder.push(liveGroupId);
      }
      ungroupByLiveGroup[liveGroupId].push({
        address: entry.current.address,
        index: entry.current.group.index
      });
    }

    if (entry.drift.monitor) {
      // Put the recorded workspace back on the recorded monitor. Deduplicated:
      // several apps recorded on the same workspace ask for the same move, and
      // it only needs doing once. driftOf has already established that the
      // recorded monitor exists in this topology, so the lookup resolves.
      // The separator is a NUL, spelled as an ESCAPE and never as a literal
      // byte: a literal NUL in the source makes the whole file "binary" to
      // grep, which then reports nothing at all for every other line in it.
      // NUL rather than "|" or " " because a monitor description is free text
      // that can contain both, and a separator that can occur inside the parts
      // is a key collision waiting for the right pair of monitors.
      var wsKey = recorded.workspaceId + "\u0000" + recorded.monitorDescription;
      if (!seenWorkspaceMoves[wsKey]) {
        seenWorkspaceMoves[wsKey] = true;
        var target = monitorByDescription(monitorsJson, recorded.monitorDescription);
        workspaceMoves.push({
          kind: "workspace-monitor",
          workspaceId: recorded.workspaceId,
          monitorDescription: recorded.monitorDescription,
          // The live output name, resolved here while the monitor list is in
          // hand, because that is what the dispatch has to name. See
          // opToCommand.
          monitorName: (target && target.name) || ""
        });
      }
    }

    if (entry.drift.monitor || entry.drift.workspace) {
      moves.push({
        kind: "move",
        address: entry.current.address,
        workspaceId: recorded.workspaceId,
        monitorDescription: recorded.monitorDescription
      });
      // The rect each move is aimed at, kept ALONGSIDE the op rather than on
      // it: applyPlacementOrder needs it to reconstruct the tree, and nothing
      // downstream — dispatch, signature, ledger — has any business seeing it.
      moveRects.push({
        address: entry.current.address,
        at: recorded.at ? geometryPair(recorded.at) : null,
        size: recorded.size ? geometryPair(recorded.size) : null
      });
    }

    if (entry.drift.floating) {
      floatings.push({
        kind: "floating",
        address: entry.current.address,
        value: !!recorded.floating
      });
    }

    // Floating geometry (tick qkv). driftOf has already established every
    // precondition this op needs and there is deliberately no second opinion
    // formed here: the record says floating, both rects are non-null, and the
    // live rect is outside the ±2px band. A tiled record can never set this
    // flag, which is the whole safety property — `resize` aimed at a tiled
    // window answers "ok" and silently moves the dwindle divider instead
    // (tick y29), so the planner is the only place that mistake can be caught.
    //
    // The rect carried is the RECORDED one, coerced (entry.recorded.at/size
    // are geometryPair'd), so the op is a destination and never a delta — which
    // is what makes it idempotent and what makes a re-plan of an unconverged
    // op produce the identical signature the no-progress check needs to see.
    //
    // `geometry.skip` is the one thing that can veto it: the recorded rect does
    // not land on this arrangement of monitors, or its size is not a rect a
    // resize could reach. Those are the two ways a green-looking float op can
    // put a window somewhere nobody asked for or loop for ever, and neither is
    // visible to driftOf's booleans — see the planner-gate block. The row keeps
    // its `geometry-off` verdict and carries the reason; the plan stays empty.
    if (entry.drift.geometry && !entry.geometry.skip) {
      geometries.push({
        kind: "geometry",
        address: entry.current.address,
        at: entry.recorded.at.slice(),
        size: entry.recorded.size.slice()
      });
    }

  }

  // The ungroup ops, one per live group, members in live tab order — a
  // deterministic order so two plans over the same desktop are the same plan.
  for (var u = 0; u < ungroupOrder.length; u++) {
    var members = ungroupByLiveGroup[ungroupOrder[u]].slice().sort(function (a, b) {
      return a.index - b.index;
    });
    var addresses = [];
    for (var m = 0; m < members.length; m++) addresses.push(members[m].address);
    ungroups.push({ kind: "ungroup", addresses: addresses });
  }

  // Groups come ready-made from driftOf: the members that are here, in
  // recorded order, with the ones that are not named so the service can say so.
  // A partial group is planned rather than skipped — two of three messengers
  // tabbed together is what the user recorded, minus the app they closed.
  var reportGroups = report.groups || [];
  for (var g = 0; g < reportGroups.length; g++) {
    var group = reportGroups[g];
    if (!group.needed) continue;
    if (group.addresses.length < 2) continue;
    groups.push({
      kind: "group",
      addresses: group.addresses.slice(),
      missing: group.missing.slice()
    });
  }

  // Geometry runs LAST, after everything else in the plan, and that ordering is
  // live evidence rather than tidiness (tick y29): moving a float to another
  // workspace RE-CLAMPS it against that workspace's reserved area — the probe
  // watched a float go from [1500,400] to [1500,198] on a bare workspace move —
  // and the floating toggle hands the window a fresh compositor-chosen rect.
  // Pixels placed before either of those would be placed twice. Group ops touch
  // only tiled windows and so cannot disturb a float, but geometry sits after
  // them too: last is a rule that needs no per-op reasoning to stay true.
  // Tiled refinement comes after everything, geometry included, for the same
  // reason geometry comes after the moves: it is the only step whose input is
  // the desktop the rest of the plan just produced. A swap or a divider nudge
  // computed against the pre-move desktop would be computed against a tiling
  // that no longer exists — so on a pass that moves windows, this contributes
  // nothing (the moves are still pending, and the gate below sees them), and
  // the re-plan that follows is where it does its work. Which is also why it
  // costs nothing on a converged desktop: it plans, finds the slots right and
  // the ratios inside 0.95, and returns empty.
  var refinements = planTiledRefinements(recordedApps, report, clients);

  return launches
    .concat(ungroups)
    .concat(workspaceMoves)
    .concat(applyPlacementOrder(moves, moveRects, recordedApps, report, clients))
    .concat(floatings)
    .concat(groups)
    .concat(geometries)
    .concat(refinements.splits)
    .concat(refinements.swaps)
    .concat(refinements.dividers);
}

// Every workspace refinement is allowed to LOOK at, in recorded order, with
// both rect sets already assembled. Shared by the planner and by driftOf, which
// is the point: a refusal the user reads in `scripts/verify` has to be the same
// refusal the planner acted on, and two copies of this gate would drift apart on
// the first edit to either.
//
// THE GATE, and it is deliberately narrow. Refinement may only look at a
// workspace that is FINISHED — everybody who belongs there is there, tiled, on
// the right monitor, with nobody else's window taking a tile — because every one
// of those conditions changes the rects, and a refinement computed against rects
// that are about to change is a refinement aimed at nothing. A workspace the
// gate excludes is not REFUSED, it is not yet ASKED: the ops that will finish it
// are already in the plan above, and the next iteration asks again. That
// distinction is why this returns only the workspaces that passed — nothing may
// report a refusal about a workspace nobody put the question to.
function tiledWorkspacesOf(recordedApps, appEntries, clients) {
  var apps = appEntries || [];
  var byWorkspace = {};
  var order = [];

  for (var i = 0; i < recordedApps.length; i++) {
    var recorded = recordedApps[i];
    var entry = apps[i];
    if (!entry || entry.status === "skipped") continue;
    var key = recorded.workspaceId + " " + recorded.monitorDescription;
    if (!byWorkspace[key]) {
      byWorkspace[key] = {
        ok: true, items: [], live: [],
        workspaceId: recorded.workspaceId,
        monitorDescription: recorded.monitorDescription
      };
      order.push(key);
    }
    var bucket = byWorkspace[key];

    // Any one of these and the workspace is not finished, so it is not ours.
    if (entry.status === "missing" || !entry.current) { bucket.ok = false; continue; }
    if (recorded.floating || entry.current.floating) { bucket.ok = false; continue; }
    if (entry.drift.workspace || entry.drift.monitor) { bucket.ok = false; continue; }

    var at = geometryPair(recorded.at);
    var size = geometryPair(recorded.size);
    var liveAt = geometryPair(entry.current.at);
    var liveSize = geometryPair(entry.current.size);
    if (!at || !size || !liveAt || !liveSize) { bucket.ok = false; continue; }

    bucket.items.push({ key: entry.current.address, at: at, size: size });
    bucket.live.push({ key: entry.current.address, at: liveAt, size: liveSize });
  }

  var out = [];
  for (var k = 0; k < order.length; k++) {
    var group = byWorkspace[order[k]];
    if (!group.ok || group.items.length < 2) continue;

    // A window nobody watches, tiled on this workspace, holds a tile that is
    // not in the recording — so the recorded rects are not reachable and every
    // nudge would be aimed past it. Same rule the placement gate uses, for the
    // same reason; a FLOAT holds no tile and does not count.
    var occupied = {};
    for (var m = 0; m < group.live.length; m++) occupied[group.live[m].key] = true;
    var stranger = false;
    var live = clients || [];
    for (var c = 0; c < live.length; c++) {
      var client = live[c];
      if (!client || !client.workspace) continue;
      if (String(client.workspace.id) !== String(group.workspaceId)) continue;
      if (client.floating) continue;
      if (occupied[client.address]) continue;
      stranger = true;
      break;
    }
    if (stranger) continue;

    out.push(group);
  }
  return out;
}

// Is this workspace already where the recording puts it?
//
// The same 0.95 the refinement stops at, asked per WINDOW against its own
// recorded rect rather than per slot — which needs no tree, and that is the
// whole point: this is the question that has to stay answerable about a
// workspace whose tree cannot be read. Occupancy shows up in it anyway, because
// two windows in each other's slots share few pixels with their own recorded
// rects.
function tilingSettled(recordedItems, liveItems) {
  var recorded = recordedItems || [];
  var live = liveItems || [];
  if (!recorded.length || recorded.length !== live.length) return false;
  var byKey = {};
  for (var i = 0; i < live.length; i++) byKey[live[i].key] = live[i];
  var total = 0;
  for (var r = 0; r < recorded.length; r++) {
    var mine = own(byKey, recorded[r].key);
    if (!mine) return false;
    var score = rectIou(recorded[r], mine);
    if (score === null) return false;
    total += score;
  }
  return (total / recorded.length) >= TILED_REFINEMENT_TARGET_IOU;
}

// The refusals, for the report: every gate-passing workspace whose tiling this
// tool will not touch AND would otherwise have had something to do, with the
// word for why. driftOf hangs these on the geometry roll-up, which is how a
// refusal reaches `scripts/verify`, the panel's verdict detail and the
// service's log without anyone having to run the planner to find out.
//
// THE REPORT IS QUIETER THAN THE PLANNER'S OWN GATE, deliberately, and the very
// first live read of this feature is why. A workspace holding a TAB GROUP is
// four windows with four identical rects: not a guillotine tiling, so the
// planner refuses it — and sitting at IoU 1.000, exactly where the recording
// put it, with nothing whatsoever for a refinement to do. Printing "refinement
// refused" beside a perfect row is noise, and noise on a green row is how a
// ceiling stops being read at all. So a SETTLED workspace reports nothing. The
// planner's refusal is unchanged, and the sentence comes back the moment the
// workspace drifts — which is the only moment a reader needs it.
function tilingRefusalsOf(recordedApps, appEntries, clients) {
  var groups = tiledWorkspacesOf(recordedApps || [], appEntries, clients);
  var out = [];
  for (var i = 0; i < groups.length; i++) {
    if (tilingSettled(groups[i].items, groups[i].live)) continue;
    var reason = tilingRefusalOf(groups[i].items, groups[i].live);
    if (!reason) continue;
    out.push({
      workspaceId: groups[i].workspaceId,
      monitorDescription: groups[i].monitorDescription,
      reason: reason
    });
  }
  return out;
}

// Every workspace whose tiling can be refined, turned into ops. Returns
// { swaps, dividers } — the two lists kept apart so the caller can put every
// swap in front of every nudge across the whole plan, not just within a
// workspace: a swap moves no divider, so nothing about that interleaving can go
// wrong, and one rule is easier to keep true than one rule per workspace.
function planTiledRefinements(recordedApps, report, clients) {
  var splits = [];
  var swaps = [];
  var dividers = [];
  var groups = tiledWorkspacesOf(recordedApps, report.apps, clients);

  for (var k = 0; k < groups.length; k++) {
    var group = groups[k];
    var program = planWorkspaceTiling(group.items, group.live);
    if (!program) continue;
    if (program.split) {
      splits.push({ kind: "split", address: program.split.address, workspaceId: group.workspaceId });
      continue;
    }
    for (var s = 0; s < program.swaps.length; s++) {
      swaps.push({ kind: "swap", address: program.swaps[s].address, target: program.swaps[s].target });
    }
    for (var d = 0; d < program.dividers.length; d++) {
      dividers.push({
        kind: "divider",
        address: program.dividers[d].address,
        axis: program.dividers[d].axis,
        size: program.dividers[d].size.slice()
      });
    }
  }

  return { splits: splits, swaps: swaps, dividers: dividers };
}

// ---------------------------------------------------------------------------
// Ordering the moves, and naming the tile each one has to split
// ---------------------------------------------------------------------------
//
// Tick or5's baseline said the defect precisely: a restore's move ops already
// put the right window in the right SLOT — occupancy follows arrival order and
// the plan is already in a deterministic order — and still scored 0.328 for
// three windows and 0.184 for four, because the SHAPE of the tree was wrong.
// Every arrival split the same tile (the first window on the workspace, which
// is what dwindle falls back to when the dispatches come back to back), while
// the recording was made from a desktop whose windows arrived under a pointer.
//
// So this does two things to the move list, in one pass, and only when it can
// prove all of them are safe:
//
//   ORDER   the moves for a workspace into the sequence placementOrderOf reads
//           off the recorded rects, and
//   NAME    on each move but the first, the window whose tile it must split.
//
// The naming is what the service turns into a focus dispatch, and focus is not
// free: `hl.dsp.focus` at a window on a hidden workspace pulls that workspace
// onto the monitor (state-matrix § Tiled placement § 5). So `splitParent` is
// stamped only where it will actually be used, and never on a workspace whose
// shape is already whatever it is going to be.
//
// FIVE PRECONDITIONS, all of them the same question — is this workspace about
// to be built from nothing, by us, out of windows we can all account for?
// Because the program placementOrderOf produces is only valid against an EMPTY
// workspace filled in that exact order. Any of them failing is not an error: it
// leaves the moves in recorded order with no focus at all, which is exactly the
// behaviour tick or5 measured, and the workspace scores whatever it scores.
//
//   1. at least two windows are being moved onto that workspace — one window
//      splits nothing, and the focus flicker would buy nothing;
//   2. every recorded TILED app that belongs on that workspace is one of them.
//      A recorded window that is missing (closed) or skipped leaves a hole the
//      reconstructed tree does not have, and the program would build a
//      different layout with full confidence;
//   3. no recorded FLOAT belongs on that workspace. Floats do not take part in
//      the tiling, but a float that is live-tiled right now occupies a tile,
//      and the plan's own `floating` op that would fix it runs AFTER the moves;
//   4. no other tiled window is living on that workspace already — including
//      windows this tool has never heard of. The first arrival has to land on
//      an empty workspace or it splits a stranger's tile;
//   5. the recorded rects reconstruct a guillotine tree (placementOrderOf).
//      Rects from a monitor arrangement these coordinates no longer describe
//      do not, and that is the case where guessing would be worst.
function applyPlacementOrder(moves, moveRects, recordedApps, report, clients) {
  if (moves.length < 2) return moves;

  var rectByAddress = {};
  for (var r = 0; r < moveRects.length; r++) rectByAddress[moveRects[r].address] = moveRects[r];

  // Group the moves by the workspace they are aimed at. Same NUL-separated key
  // shape as the workspace-monitor dedupe above, for the same reason.
  var groupsByKey = {};
  var keyOrder = [];
  for (var i = 0; i < moves.length; i++) {
    var key = moves[i].workspaceId + "\u0000" + moves[i].monitorDescription;
    if (!groupsByKey[key]) { groupsByKey[key] = []; keyOrder.push(key); }
    groupsByKey[key].push(moves[i]);
  }

  var ordered = [];
  for (var k = 0; k < keyOrder.length; k++) {
    var group = groupsByKey[keyOrder[k]];
    var sequenced = sequenceWorkspaceMoves(group, rectByAddress, recordedApps, report, clients);
    ordered = ordered.concat(sequenced);
  }
  return ordered;
}

function sequenceWorkspaceMoves(group, rectByAddress, recordedApps, report, clients) {
  if (group.length < 2) return group;                                   // (1)

  var workspaceId = group[0].workspaceId;
  var monitorDescription = group[0].monitorDescription;

  var moving = {};
  for (var g = 0; g < group.length; g++) moving[group[g].address] = true;

  // (3a) NOBODY IN THE GROUP IS A LIVE FLOAT.
  //
  // Found by the property test rather than reasoned out, which is why it is
  // worth its own paragraph. A window RECORDED tiled can be LIVE floating —
  // the user hit SUPER+T, or it came back from a hotplug floating — and the
  // plan does fix that, with a `floating` op that runs AFTER the moves,
  // because a workspace move re-clamps a float and the ordering was settled in
  // tick y29. So at the moment the choreography runs, that window is still a
  // float: it holds NO TILE. Focusing it splits nothing and the arrival lands
  // wherever dwindle falls back to; being it, it takes no slot and every other
  // window in the tree shifts up one. Every dispatch answers "ok" throughout.
  //
  // Reordering the plan to float them first would trade this for the
  // re-clamping bug y29 measured. Standing the choreography down costs one
  // cycle: the floats are fixed by the end of this pass, and the next settle
  // pass plans against a workspace where everybody holds a tile.
  var liveByAddress = {};
  var all = clients || [];
  for (var q = 0; q < all.length; q++) if (all[q] && all[q].address) liveByAddress[all[q].address] = all[q];
  for (var f = 0; f < group.length; f++) {
    var subject = liveByAddress[group[f].address];
    if (!subject || subject.floating) return group;
  }

  // (2) and (3): everything the recording puts on this workspace is here, and
  // none of it is recorded as a float.
  var wanted = 0;
  for (var a = 0; a < recordedApps.length; a++) {
    var recorded = recordedApps[a];
    if (String(recorded.workspaceId) !== String(workspaceId)) continue;
    if (String(recorded.monitorDescription) !== String(monitorDescription)) continue;
    var entry = report.apps[a];
    if (entry && entry.status === "skipped") continue;
    if (recorded.floating) return group;
    // "ok" and "drifted" both carry a live window; "missing" does not, and a
    // window that is not here cannot take the slot the tree hands it.
    if (!entry || !entry.current || !moving[entry.current.address]) return group;
    wanted += 1;
  }
  if (wanted !== group.length) return group;

  // (4) nobody else is on the workspace. A window that is grouped (tabbed) is
  // still one tile, so it counts once; a float takes no tile and does not.
  var live = clients || [];
  for (var c = 0; c < live.length; c++) {
    var client = live[c];
    if (!client || !client.workspace) continue;
    if (String(client.workspace.id) !== String(workspaceId)) continue;
    if (client.floating) continue;
    if (moving[client.address]) continue;
    return group;
  }

  // (5) the rects have to be a tree.
  var items = [];
  for (var m = 0; m < group.length; m++) {
    var rect = rectByAddress[group[m].address];
    if (!rect || !rect.at || !rect.size) return group;
    items.push({ key: group[m].address, at: rect.at, size: rect.size });
  }
  var order = placementOrderOf(items);
  if (!order || order.length !== group.length) return group;

  var byAddress = {};
  for (var b = 0; b < group.length; b++) byAddress[group[b].address] = group[b];

  // Resolved FIRST and stamped SECOND, deliberately. Stamping as we go would
  // leave half the ops carrying a splitParent if the last one failed to
  // resolve, and a partly-choreographed workspace is worse than an
  // unchoreographed one: it focuses some windows and not others, which is a
  // program nobody designed.
  var out = [];
  for (var o = 0; o < order.length; o++) {
    if (!byAddress[order[o].key]) return group;
    out.push(byAddress[order[o].key]);
  }
  for (var s = 0; s < order.length; s++) {
    if (order[s].parentKey) out[s].splitParent = order[s].parentKey;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan/snapshot address invariant
// ---------------------------------------------------------------------------
//
// A plan op may only ever name a window address that was in the client list the
// plan was built from. planRestore holds to that by construction — every
// address it emits is copied off a client in `clientsJson`, and it has no other
// source of addresses — but "by construction" is exactly the kind of guarantee
// that a later caching layer, a retained snapshot or a reused plan object
// quietly breaks, and the failure it produces is invisible: the service
// dispatches at windows that are not there, every dispatch is answered, and the
// plan never converges.
//
// So it is checked rather than assumed. tests assert it over every fixture, and
// Service.qml re-checks each plan against the very read it planned from and
// refuses the pass with a SNAPSHOT-STALE warning if it ever fails.

// ---------------------------------------------------------------------------
// What an op touches: one answer, one place
// ---------------------------------------------------------------------------
//
// Which windows does this op act on? Three separate places used to answer it
// with three separate `if (op.kind === …)` ladders — planAddresses here, the
// snapshot check through it, and Service.beginOp's ledger — and every one of
// them had to be edited by hand when tick qkv added the `geometry` op. One of
// them was not. The op fell through beginOp's ladder onto the multi-address
// branch, resolved to an EMPTY identity list, and a loudly-REFUSED geometry op
// left the app's row saying nothing at all: the warning went to the log, the
// cycle counted a failure, and `blockedBy` — the one surface the user reads —
// stayed null. A silent failure produced by a list of kinds that had grown one
// kind since it was written.
//
// So the question is asked ONCE, and answered from the op's SHAPE rather than
// from its kind: an op names either one window (`address`) or a set of them
// (`addresses`), and everything that needs to know reads it here. A future op
// kind that follows either convention is handled by every consumer the day it
// is added, with no list to remember to extend — which is the property the
// tests pin, using a synthetic kind no branch has ever heard of.
function opAddressesOf(op) {
  if (!op) return [];
  if (typeof op.address === "string" && op.address) {
    // A THIRD convention, added by tick pyo's swap op and spelled here rather
    // than branched on by kind, which is the whole point of this function: an
    // op may name a second window it acts WITH. `target` is that window — a
    // real subject, present in the dispatch, and one whose disappearance would
    // make the op meaningless — so every consumer (the snapshot invariant, the
    // ledger, the plan's address list) has to see it, and now they all do
    // without any of them knowing what a swap is.
    if (typeof op.target === "string" && op.target && op.target !== op.address) {
      return [op.address, op.target];
    }
    return [op.address];
  }
  if (!isAddressList(op.addresses)) return [];
  var out = [];
  for (var i = 0; i < op.addresses.length; i++) {
    var address = op.addresses[i];
    if (typeof address === "string" && address) out.push(address);
  }
  return out;
}

// The op's subject as one string, for a ledger entry or a log line: the windows
// it names, or the identity it launches, or the workspace it moves. Shape
// again, in the same order of preference, so the same synthetic op that
// resolves its addresses also gets a subject and is never a blank row.
function opSubjectOf(op) {
  if (!op) return "";
  var addresses = opAddressesOf(op);
  if (addresses.length) return addresses.join("+");
  if (typeof op.identityId === "string" && op.identityId) return op.identityId;
  if (op.workspaceId !== undefined && op.workspaceId !== null) {
    return op.workspaceId + "@" + (op.monitorName || op.monitorDescription || "");
  }
  return "";
}

// Every window address a plan names, in plan order, deduped. Ops that address
// a workspace or an identity rather than a window contribute nothing.
function planAddresses(plan) {
  var ops = plan || [];
  var out = [];
  var seen = {};

  for (var i = 0; i < ops.length; i++) {
    var addresses = opAddressesOf(ops[i]);
    for (var a = 0; a < addresses.length; a++) {
      var address = addresses[a];
      if (seen[address]) continue;
      seen[address] = true;
      out.push(address);
    }
  }
  return out;
}

// The addresses a plan names that the snapshot does not contain. Empty is the
// only acceptable answer; anything else means the plan and the desktop it was
// planned against have come apart.
function unknownPlanAddresses(plan, clientsJson) {
  var clients = clientsJson || [];
  var live = {};
  for (var i = 0; i < clients.length; i++) {
    if (clients[i] && clients[i].address) live[clients[i].address] = true;
  }

  var named = planAddresses(plan);
  var out = [];
  for (var n = 0; n < named.length; n++) {
    if (!live[named[n]]) out.push(named[n]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zero progress: telling "not finished yet" apart from "not working"
// ---------------------------------------------------------------------------
//
// The convergence loop re-plans after every batch of dispatches and stops when
// the plan comes back empty. What it could not see is the difference between a
// plan that is SHRINKING (the restore is working, give it another iteration) and
// a plan that is IDENTICAL to the one just executed (the dispatches did nothing
// at all, and running them four more times will do nothing four more times).
//
// That distinction is the whole diagnosis. The focus-dependent-move bug spent
// five iterations × three passes re-issuing the same two dispatches, and the
// only thing the log had to say about it was a GIVE-UP after the fact — no
// dispatch had errored, because a dispatch that acts on the wrong window still
// answers "ok". A plan that repeats itself verbatim is that failure, observable
// one iteration after it starts.
//
// Compared by SUBJECT, not by object identity: two plans built from two separate
// hyprctl reads are never the same objects, and a re-plan that produced the same
// work is exactly what "no progress" means.

// The comparable signature of one op: what it would do, to what.
//
// Deliberately not JSON.stringify(op) — key order is an implementation detail of
// whoever built the object, and a field that carries no instruction (a move's
// monitorDescription is context for the caller) must not make two identical
// plans look different.
function opSignature(op) {
  if (!op) return "";
  if (op.kind === "launch") return "launch:" + op.identityId;
  if (op.kind === "workspace-monitor") {
    return "workspace-monitor:" + op.workspaceId + "@" + (op.monitorName || op.monitorDescription || "");
  }
  // The split parent is part of the signature, because it is part of the
  // PROGRAM: two plans that move the same windows to the same workspaces but
  // split different tiles build different desktops, and a no-progress check
  // that could not tell them apart would abandon a pass that was in fact about
  // to do something new. Omitted when there is none, so the signature of an
  // unchoreographed move is byte-identical to what it always was.
  if (op.kind === "move") {
    return "move:" + op.address + "->" + op.workspaceId +
      (op.splitParent ? "^" + op.splitParent : "");
  }
  if (op.kind === "floating") return "floating:" + op.address + "->" + (op.value ? "float" : "tile");
  // The TARGET rect is part of the signature, not the live one: two passes that
  // ask for the same destination and did not get there are the same plan, which
  // is exactly what the no-progress check has to be able to see.
  if (op.kind === "geometry") {
    return "geometry:" + op.address + "->" + (op.at || []).join(",") + "/" + (op.size || []).join(",");
  }
  if (op.kind === "swap") return "swap:" + op.address + "<->" + op.target;
  // AXIS AND TARGET ONLY, deliberately not the whole size pair. A divider op
  // moves one line; the other axis of `size` is a snapshot of what the window
  // happens to measure right now, and it changes whenever a neighbouring
  // divider moves. Signing the whole pair would make a nudge that is being
  // ignored look like a NEW op on every iteration, which is exactly the case
  // the no-progress check exists to catch and would then miss.
  if (op.kind === "divider") {
    return "divider:" + op.address + ":" + op.axis + "->" + ((op.size || [])[op.axis]);
  }
  if (op.kind === "group") return "group:" + ((op.addresses || []).join("+"));
  if (op.kind === "ungroup") return "ungroup:" + ((op.addresses || []).join("+"));
  // An op kind this version has never heard of still has to compare by SUBJECT
  // and not just by kind: two different future ops that signed as the bare word
  // would look like the same op to samePlan, and a plan making real progress
  // through them would be called a no-progress loop and abandoned.
  return String(op.kind) + ":" + opSubjectOf(op);
}

function planSignature(plan) {
  var list = plan || [];
  var parts = [];
  for (var i = 0; i < list.length; i++) parts.push(opSignature(list[i]));
  return parts.join(" ; ");
}

// Would running this plan repeat the work the previous one already asked for?
//
// Order matters as well as content: the plan IS an ordered program (launches,
// then workspace moves, then window moves, then groups), and two plans with the
// same ops in a different order came from different desktops.
function samePlan(a, b) {
  if (!a || !b) return false;
  return planSignature(a) === planSignature(b);
}

// Is this plan nothing but tiled refinement — swaps and divider nudges?
//
// The service asks because the two kinds of work are counted against different
// budgets (TILED_REFINEMENT_MAX_NUDGES says why). It is a property of the PLAN
// and not of a single op, deliberately: the moment a plan also carries a move,
// a group join or a launch, the pass is doing ordinary restore work and the
// ordinary iteration cap is the right instrument again — a refinement op riding
// along must not buy the rest of the plan extra iterations.
//
// An empty plan is not a refinement plan. It is a converged desktop, and the
// caller has already stopped.
function isRefinementPlan(plan) {
  var list = plan || [];
  if (!list.length) return false;
  for (var i = 0; i < list.length; i++) {
    var kind = list[i] && list[i].kind;
    if (kind !== "swap" && kind !== "divider" && kind !== "split") return false;
  }
  return true;
}

// Does this plan contain work that needs the KEYBOARD FOCUS to land?
//
// Exactly one op kind does: `group`. The rebuild runs through `into_group`,
// which IGNORES its window selector and acts on the focused window (live-
// verified, learnings § Dispatch selector traps) — so the service focuses each
// member in turn and reads the tab order back. Every other op names its subject
// and is focus-independent: moves, workspace moves, the whole-group `group.
// toggle` an `ungroup` dispatches, the float toggle, resize/move, swaps.
//
// The service asks because of the LOCKED SESSION (state-matrix §7, tick 97e):
// under an ext-session-lock there is no window to focus, so a rebuild attempted
// there assembles in whatever order the compositor was left in. The joins are
// deferred to the unlock instead, and the rest of the plan runs normally.
//
// A choreographed move (`splitParent`) also borrows the focus, and it is NOT
// counted here on purpose: it is a fidelity refinement, not a correctness one —
// a move that splits the wrong tile still puts the window on the right
// workspace, and it is re-derived on the next pass — whereas a mis-assembled
// group is a wrong desktop that persists. Service.planHasChoreography is the
// predicate for that half, and closing the panel is what it drives.
//
// A property of the PLAN, in engine.js rather than in the service, because the
// plan is engine.js's vocabulary and this has to be testable in node.
function planHasGroupJoins(plan) {
  var list = plan || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].kind === "group") return true;
  }
  return false;
}

// The same question, asked of every op kind that needs the keyboard — which is
// what the lock gate actually cares about, and since tick uk5 there are two of
// them. `split` joined `group` because `togglesplit` takes no window selector
// at all: it flips the FOCUSED window's parent node, so a locked session (no
// window to focus) would flip whatever the compositor was left holding, on a
// workspace the user cannot see. Deferred to the unlock, exactly like a join,
// and replayed by the same idempotent re-plan.
//
// `planHasGroupJoins` is kept beside it rather than replaced: "which ops need
// focus" and "which ops are group joins" are two questions. The service now
// asks only the first — both lock-gate call sites below use the focus-ops
// variant — but the group-joins query survives as tested public API.
function planHasFocusOps(plan) {
  var list = plan || [];
  for (var i = 0; i < list.length; i++) {
    var kind = list[i] && list[i].kind;
    if (kind === "group" || kind === "split") return true;
  }
  return false;
}

// The same plan with the focus-dependent ops taken out — what a LOCKED session
// may execute. A new array; the input is never mutated, because the full plan is
// still what the no-progress check compares against.
function planWithoutFocusOps(plan) {
  var list = plan || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var kind = list[i] && list[i].kind;
    if (kind === "group" || kind === "split") continue;
    out.push(list[i]);
  }
  return out;
}

// The same plan with the group joins taken out — what a LOCKED session can
// safely execute. Returns a new array; the input is never mutated, because the
// full plan is still what the no-progress check compares against.
function planWithoutGroupJoins(plan) {
  var list = plan || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].kind === "group") continue;
    out.push(list[i]);
  }
  return out;
}

// One op in a sentence a human can act on. Used in the no-progress WARN, which
// has to name the thing that is not happening — "3 ops" tells nobody which
// dispatch is being ignored.
function describeOp(op) {
  if (!op) return "(no op)";
  if (op.kind === "launch") return "launch " + op.identityId;
  if (op.kind === "workspace-monitor") {
    return "workspace-monitor ws " + op.workspaceId + " -> "
      + (op.monitorName || op.monitorDescription || "(no monitor)");
  }
  if (op.kind === "move") {
    return "move " + op.address + " -> ws " + op.workspaceId +
      (op.splitParent ? " (splitting " + op.splitParent + ")" : "");
  }
  if (op.kind === "floating") {
    return (op.value ? "float " : "tile ") + op.address;
  }
  if (op.kind === "geometry") {
    return "geometry " + op.address + " -> " + (op.at || []).join(",")
      + " " + (op.size || []).join("x");
  }
  if (op.kind === "split") {
    return "split " + op.address
      + (op.workspaceId === undefined ? "" : " (ws " + op.workspaceId + ")");
  }
  if (op.kind === "swap") return "swap " + op.address + " with " + op.target;
  if (op.kind === "divider") {
    return "divider " + op.address + " " + (op.axis === 1 ? "height" : "width")
      + " -> " + ((op.size || [])[op.axis]);
  }
  if (op.kind === "group") {
    return "group " + ((op.addresses || []).join("+"))
      + ((op.missing && op.missing.length) ? " (without " + op.missing.join(", ") + ")" : "");
  }
  if (op.kind === "ungroup") return "ungroup " + ((op.addresses || []).join("+"));
  var subject = opSubjectOf(op);
  return subject ? String(op.kind) + " " + subject : String(op.kind);
}

// ---------------------------------------------------------------------------
// One op, one failure, and the FIRST reason wins
// ---------------------------------------------------------------------------
//
// The service keeps a ledger entry per op (Service.beginOp) and turns the
// failed ones into the `blockedBy` a panel row shows. Two rules, both learned
// from geometry ops, and both pure enough to live here and be tested here.
//
// FIRST REASON WINS. An op that fails usually fails once and is then observed
// to have failed a second time: `hyprctl` answers a resize with the
// compositor's own words (VERB-ERROR — "unrecognized arguments…", the sentence
// that actually diagnoses the bug), and the confirming re-read that follows
// says only "the geometry dispatch did not land (reads …, wanted …)", which is
// the SYMPTOM of the first sentence. Last-write-wins threw the diagnosis away
// and kept the symptom on every op with a confirm step behind it. The first
// reason is the closest one to the cause, so it is the one the row keeps.
//
// ONE OP, ONE FAILURE. `cycleFailures` is what `lastResult.ok`, the "— N
// failed" toast and the forensics gate all read, so it has to count ops that
// did not land, not dispatches that went wrong on the way to one. The same
// refused resize counted twice (once at the VERB-ERROR, once at the confirm)
// reported two failures for one window that did not move. This returns true
// exactly once per record — on the transition to failed — and the caller
// increments on that.
//
// Returns: true if this call is what failed the record, false if the record was
// already failed (or there is no record to fail).
function failOutcome(record, reason, identityIds) {
  if (!record) return false;
  if (record.ok === false) return false;
  record.ok = false;
  record.reason = (reason === undefined || reason === null) ? "" : String(reason);
  // Narrowing belongs to the failure that is being recorded — a group of four
  // where the third would not join is one blocked app, not four — so it moves
  // with the reason, and a later failure cannot re-aim the first one's sentence
  // at a different app.
  if (identityIds && identityIds.length) record.identityIds = identityIds;
  return true;
}

// ---------------------------------------------------------------------------
// Ops → Quattro Lua dispatch commands
// ---------------------------------------------------------------------------
//
// Omarchy 4 / Hyprland 0.56 replaced the legacy `hyprctl dispatch <name> <args>`
// string form with a Lua one. The old form is a hard error, not a warning — it
// silently killed the SUPER+SHIFT+L script. These strings are ported from the
// proven helpers in ~/.config/omarchy/scripts/session-layout.
//
// opToCommand() returns an ORDERED list of complete shell command strings; a
// single op can take more than one dispatch. The service runs them in order — as
// a string via `sh -c`, or by splitting off the single-quoted Lua payload and
// running ["hyprctl", "dispatch", payload] through a QML Process.
//
// EVERY dispatch that can name its subject DOES.
//
// The bug that taught us: a restore triggered from the OPEN panel moved nothing.
// The panel is a keyboard-focused layer surface, so `hl.dsp.focus({ window })`
// does not hand the keyboard to the target window, and a focus-relative
// `hl.dsp.window.move({ workspace })` then acts on whatever the compositor still
// considers active — which is not the window we meant. Five iterations of an
// unchanging plan, then GIVE-UP. Trigger-file restores worked, which is why the
// whole test history was green.
//
// Live-verified on this machine (2026-08-15, Hyprland 0.56 / Omarchy 4), against
// a scratch `foot --app-id=mw-97n` while the keyboard focus sat on ANOTHER
// window the whole time:
//
//   hl.dsp.window.move({ window = "address:0x…", workspace = "7",
//                        follow = false })         → target moved ws 1 → 7,
//                                                    focus never moved.       OK
//   hl.dsp.group.toggle({ window = "address:0x…" }) → target became/left a
//                                                    group, focus untouched.  OK
//   hl.dsp.window.move({ window = "address:0x…", into_group = "left" })
//                                                  → the selector is IGNORED;
//                                                    into_group always acts on
//                                                    the ACTIVE window.       NO
//
// The FLOATING verb, live-verified 2026-08-16 (tick 8t4) against a scratch
// `foot --app-id=mw-8t4` parked on a scratch workspace while the keyboard
// focus sat on ANOTHER window the whole time:
//
//   hl.dsp.window.float({ window = "address:0x…", action = "toggle" })
//                                                  → the NAMED window toggled
//                                                    floating<->tiled, focus
//                                                    never moved.            OK
//   … action = "set"    → TOGGLED (set on a floating window TILED it)
//   … action = "unset"  → TOGGLED (unset on a tiled window FLOATED it)
//   … window = "address:0xdeadbeef" (recognised key, dead value)
//                                                  → no-op, answered "ok",
//                                                    nothing floated — the
//                                                    asymmetry that proves the
//                                                    selector key is right.
//
// So on Hyprland 0.56.2 the float dispatcher is a TOGGLE whatever the action
// says (the binary carries an eTogglableAction for it, but every spelling
// toggles; each observation above was made with a `hyprctl clients -j` read
// between dispatches, because two back-to-back toggles read once look exactly
// like an idempotent set). The consequence for the restore executor: a
// floating op may NEVER be dispatched blind — the service reads the window's
// live state first and toggles only when it differs from the recorded value,
// then confirms with a re-read (Service.qml executeFloating).
//
// So the join half of a group rebuild still has to focus first — see the group
// branch below. Two live facts make that acceptable and make VERIFYING this
// mandatory rather than optional:
//
//   - An UNRECOGNISED key is silently dropped and the dispatch falls back to the
//     ACTIVE window. `{ wndw = "address:…", workspace = "6" }` answered "ok" and
//     moved the focused window instead. A misspelled selector is therefore not a
//     no-op, it is a wrong move on the wrong window — and it never says so.
//   - A RECOGNISED key with an unresolvable value moves nothing at all:
//     `{ window = "address:0xdeadbeef", workspace = "5" }` answered "ok" and left
//     every window where it was. That asymmetry is the proof the key is right.
//
// `hyprctl dispatch` answers "ok" in all three cases, so the compositor is no
// help here; only `hyprctl clients -j` before and after is.

// ---------------------------------------------------------------------------
// FLOAT ACTUATOR SEMANTICS — the geometry pair (tick y29, evidence only)
// ---------------------------------------------------------------------------
//
// Live-probed 2026-08-16 on the real session (Hyprland 0.56.2 / Omarchy 4,
// DP-1 at scale 1.6) against two scratch `foot` windows on a scratch
// workspace: `mw-float` as the subject and `mw-sacrifice` holding the keyboard
// focus for EVERY dispatch, so a selector that is silently dropped resizes the
// sacrifice instead of the subject and says so in the read-back. Nothing here
// changes a code path — this tick establishes the contract that tick qkv
// implements. Verb evidence for the spelling: `resize` is listed on
// HL.DspWindowNamespace in /usr/share/hypr/stubs/hl.meta.lua, and Omarchy's own
// /usr/share/omarchy/default/hypr/bindings/tiling.lua binds SUPER+<->
// to `hl.dsp.window.resize({ x = ±100, y = 0, relative = true })`.
//
// THE TWO DISPATCHES, exactly as a geometry op must emit them:
//
//   hyprctl dispatch 'hl.dsp.window.resize({ window = "address:0x…", x = <w>, y = <h> })'
//   hyprctl dispatch 'hl.dsp.window.move({ window = "address:0x…", x = <x>, y = <y> })'
//
// and the findings that fix every part of that spelling:
//
//   1. ABSOLUTE, not delta. With no `relative` key, `x`/`y` on resize are the
//      target WIDTH and HEIGHT, not a nudge: a 701×850 float dispatched
//      { x = 800, y = 500 } read back exactly [800, 500]. `relative = true`
//      (tiling.lua's form) is the delta form and is NOT what a restore wants.
//      Same for move: { x, y } is an absolute layout position (already known
//      from tick 5sc, re-verified here).
//
//   2. IDEMPOTENT. The identical resize dispatched twice left the window
//      unchanged the second time; likewise move. A converged geometry op is a
//      no-op, not an oscillation — unlike the float toggle, so unlike
//      executeFloating this one does not NEED a read to be safe. It gets one
//      anyway, to confirm rather than to protect.
//
//   3. EXACT under fractional scale. On DP-1 at scale 1.6, four (at, size)
//      quadruples of deliberately awkward odd numbers — [1801,501]/[901,601],
//      [1799,503]/[903,599], [1777,333]/[777,555], [1500,400]/[1000,700] —
//      each read back byte-identical. There is no logical→device→logical
//      rounding on this path, so a geometry op CONVERGES exactly and the ±2px
//      GEOMETRY_TOLERANCE_PX band is pure margin, never the thing that makes
//      the plan settle.
//
//   4. RESIZE RE-CENTRES, so RESIZE MUST COME FIRST. A resize keeps the
//      window's CENTRE fixed and therefore moves its `at`: 701×850 at
//      [2697,38] (centre 3047,463) resized to 800×500 landed at [2648,213] —
//      the same centre. Proven both ways in one round:
//        move→resize, asking at [1700,400] size [1000,700]  →  at [1600,300] ✗
//        resize→move, asking the same                       →  at [1700,400] ✓
//      The move-first order misses by exactly half the size change. A geometry
//      op is therefore an ORDERED PAIR and never a set.
//
//   5. FOCUS-INDEPENDENT, and the `window` key is genuinely honoured. This one
//      needed care, because the first two probes were both consistent with the
//      into_group failure mode (selector dropped → acts on the ACTIVE window):
//      two tiled windows share one divider, so "shrink the subject" and "grow
//      the sacrifice" are the same observation. Two probes settle it:
//        - dead address: { window = "address:0xdeadbeef", x = 900, y = 850 }
//          answered "ok" and moved nothing at all. An IGNORED key would have
//          resized the focused window; a recognised key with an unresolvable
//          value does nothing. Same asymmetry that proves window.move's key.
//        - asymmetric split: with the sacrifice at 400px and the subject at
//          1712px, an absolute resize naming the SUBJECT drove the sacrifice to
//          its 98px minimum. Had the key been dropped, the focused sacrifice
//          would have become exactly the 600px asked for. It did not.
//      So resize joins move, group.toggle and window.float in the
//      names-its-subject set; into_group remains the only exception.
//
//   6. NO SETTLE DELAY after the float toggle. `hl.dsp.window.float` (toggle),
//      then resize, then move, dispatched back to back with no sleep between
//      them, landed exactly: float=true at [1800,500] size [900,600]. Each
//      `hyprctl dispatch` is a synchronous round trip, so the compositor has
//      committed the float before the next dispatch is parsed. A geometry op
//      may follow a floating op in the same pass.
//
//   7. AN INVISIBLE WORKSPACE IS FINE — for a FLOAT. The subject parked on a
//      non-visible scratch workspace took both dispatches exactly. (Tiled
//      windows are the opposite: their rects go stale on a workspace that is
//      not being composited, which is how this probe found out. Another reason
//      geometry is a float-only op.)
//
//   8. BUT A WORKSPACE MOVE DISPLACES A FLOAT. Moving the subject to a fresh
//      workspace moved it from [1500,400] to [1500,198] — the compositor
//      re-clamps a float against the new workspace's reserved area. So the
//      geometry pair has to run AFTER the workspace-monitor ops, after the
//      moves and after the floating toggle: it is the LAST thing in a plan, or
//      it is restoring a position something later will move.
//
// THE TILED BLAST RADIUS (tick y29 question 3), and it is the reason
// planRestore must never plan geometry for a tiled record:
//
//   - `hl.dsp.window.move({ window, x, y })` at a TILED window is a clean
//     NO-OP. Answered "ok", changed nothing. Harmless.
//   - `hl.dsp.window.resize({ window, x, y })` at a TILED window is NOT. It is
//     neither refused nor ignored: it answers "ok" and RESIZES THE DWINDLE
//     SPLIT, moving the divider by (target − current) and dragging the
//     neighbouring tile with it. Two equal 1056px tiles, one absolute resize to
//     400px, and the pair came back 400/1712 — the user's tiling rearranged, no
//     error anywhere. A second mis-planned op does it again from the new
//     numbers, so it does not even converge.
//
// That asymmetry is the whole safety argument for the op: the half that is
// harmless on the wrong window kind is the half that would be visible, and the
// half that does damage is silent. Neither the dispatch's answer nor a log line
// can catch a geometry op aimed at a tiled window. Only the PLANNER can, which
// is why "recorded floating" is a precondition of emitting one and not a
// property the executor checks afterwards.

function dispatchCommand(lua) {
  return "hyprctl dispatch '" + lua + "'";
}

// The selector fragment that names a window to a dispatcher that supports one.
// Spelled once, because getting it wrong is silent (see above).
function windowSelector(address) {
  return 'window = "address:' + address + '"';
}

function focusWindowCommand(address) {
  return dispatchCommand("hl.dsp.focus({ " + windowSelector(address) + " })");
}

function opToCommand(op) {
  if (!op) return [];

  if (op.kind === "move") {
    // ONE dispatch, naming the window — unless the planner has stamped a
    // `splitParent`, in which case exactly one focus goes in front of it.
    //
    // That is not a walking back of the old rule. The old bug was focusing the
    // window BEING MOVED, to make the move land — the panel held the keyboard,
    // the focus never arrived, and the move hit whatever was active. This
    // focuses a DIFFERENT window, the one already on the destination workspace
    // whose tile this arrival has to split, and the move itself still names its
    // own subject and does not depend on focus at all. If the focus is refused
    // the move still lands; it lands in the wrong tile, which is the score, not
    // a wrong window.
    //
    // Live-proven in tick or5 (state-matrix § Tiled placement § 4): naming the
    // split parent before each move makes the resulting tree an input rather
    // than a function of where the mouse was. The service adds the step that
    // puts the user's own focus back — see Service.stepsForOp; a pure function
    // cannot know what it was.
    //
    // follow = false: do not drag the focus onto the destination workspace,
    // exactly as session-layout's ensure_on does. The window follows its
    // workspace onto the right monitor, which is why the op's monitorDescription
    // is context for the caller rather than a second dispatch.
    var moveCommands = [];
    if (typeof op.splitParent === "string" && op.splitParent) {
      moveCommands.push(focusWindowCommand(op.splitParent));
    }
    moveCommands.push(
      dispatchCommand(
        "hl.dsp.window.move({ " + windowSelector(op.address) +
        ', workspace = "' + op.workspaceId + '", follow = false })'
      )
    );
    return moveCommands;
  }

  if (op.kind === "workspace-monitor") {
    // Legacy `moveworkspacetomonitor <ws> <monitor>`. The Quattro verb is
    // hl.dsp.workspace.move, and the evidence is first-party: Omarchy's own
    // /usr/share/omarchy/default/hypr/bindings/tiling.lua binds
    // SUPER+SHIFT+ALT+<arrow> to `hl.dsp.workspace.move({ monitor = "l" })`,
    // and /usr/share/hypr/stubs/hl.meta.lua lists `move` on
    // HL.DspWorkspaceNamespace plus a "workspace.move_to_monitor" event. The
    // `workspace` key is the selector spelling the verified session-layout port
    // uses everywhere else (hl.dsp.focus, hl.dsp.window.move); the stubs type
    // the dispatchers as `fun(...)`, so the key names are not spelled out
    // there. Omitting `workspace` would move the ACTIVE one, which is exactly
    // the bug this op exists to avoid.
    //
    // The monitor is named by its live OUTPUT NAME rather than the recorded
    // label: a bare string selector is matched against the monitor name, while
    // a description needs a `desc:` prefix — and monitorLabel() yields a
    // description most of the time but falls back to a name (the headless
    // output has no description), so the recorded label alone cannot be turned
    // into a selector without guessing. planRestore resolves it against the
    // live monitor list instead. No live monitor means nothing safe to
    // dispatch.
    if (!op.monitorName) return [];
    return [
      dispatchCommand(
        'hl.dsp.workspace.move({ workspace = "' + op.workspaceId + '", monitor = "' + op.monitorName + '" })'
      )
    ];
  }

  if (op.kind === "floating") {
    // ONE dispatch, naming the window — but it is a TOGGLE (see the evidence
    // block above: on Hyprland 0.56 every `action` spelling toggles), so this
    // command is only correct against the desktop the plan was built from.
    // The service therefore does NOT run this string blind: executeFloating
    // re-reads the window first, dispatches only on a live mismatch, and
    // confirms after. The string is produced here anyway so the spelling
    // lives in one place and the tests can pin it.
    return [
      dispatchCommand(
        "hl.dsp.window.float({ " + windowSelector(op.address) + ', action = "toggle" })'
      )
    ];
  }

  if (op.kind === "geometry") {
    // TWO dispatches, in this order, both naming the window. The full evidence
    // is in the FLOAT ACTUATOR SEMANTICS block above; the three facts this
    // spelling rests on:
    //
    //   - absolute, because there is no `relative` key: resize's x/y are the
    //     target WIDTH and HEIGHT, move's are the target POSITION;
    //   - resize FIRST, because a resize keeps the window's centre fixed and
    //     therefore moves its `at`. move→resize misses by exactly half the size
    //     change — measured, both ways, on live hardware;
    //   - both are idempotent and focus-independent, so unlike the floating op
    //     this one is safe to dispatch against a stale plan. The service reads
    //     back anyway, to CONFIRM rather than to protect (executeGeometry).
    //
    // Emitted only for a recorded FLOAT (planRestore's precondition). Pointed
    // at a tiled window the move half is a harmless no-op but the resize half
    // silently rearranges the dwindle split and answers "ok", which is why that
    // guard lives in the planner and is not re-checked here: this function is
    // handed an op and cannot see the record that justified it.
    var at = op.at || [];
    var size = op.size || [];
    if (at.length !== 2 || size.length !== 2) return [];
    return [
      dispatchCommand(
        "hl.dsp.window.resize({ " + windowSelector(op.address) +
        ", x = " + size[0] + ", y = " + size[1] + " })"
      ),
      dispatchCommand(
        "hl.dsp.window.move({ " + windowSelector(op.address) +
        ", x = " + at[0] + ", y = " + at[1] + " })"
      )
    ];
  }

  if (op.kind === "split") {
    // TWO dispatches, and the first one is not optional: `togglesplit` takes no
    // window selector of any kind. It is a dwindle LAYOUT message — Omarchy's
    // own binding is `hl.dsp.layout("togglesplit")` (first-party evidence:
    // /usr/share/omarchy/default/hypr/bindings/tiling.lua binds SUPER+J to
    // exactly that string, and /usr/share/hypr/stubs/hl.meta.lua types `layout`
    // on HL.DspNamespace beside `focus` and `exec_cmd`) — and it flips the split
    // of the FOCUSED window's parent node. So the window whose parent is the
    // node to flip has to hold the keyboard when it fires.
    //
    // Which is why this op is planned only for a node that has a window
    // DIRECTLY under it (singleFlipOf), why it is focus-dependent in the sense
    // the lock gate means (planHasFocusOps), and why the service hands the
    // keyboard back afterwards with the same refocusHomeSteps a choreographed
    // move uses. There is no address-targeted spelling of this to fall back to:
    // the alternative is a bare `hyprctl dispatch togglesplit`, which is the
    // same dispatcher through the legacy parser and takes no selector either.
    if (!op.address) return [];
    return [
      focusWindowCommand(op.address),
      dispatchCommand('hl.dsp.layout("togglesplit")')
    ];
  }

  if (op.kind === "swap") {
    // ONE dispatch, naming BOTH windows, and it is the only op in this plan
    // that needs neither focus nor a settle. Live-verified in tick or5
    // (§ Tiled placement § 7): the two windows exchange rects exactly, the
    // user's focused window and visible workspace are untouched, it works on a
    // workspace nobody can see, and it is LOUD about every way it can fail —
    // `warning: target window not found` for an address that is gone,
    // `warning: Can't swap a window with itself`. That last one is why the
    // planner never emits a self-swap and this never has to check for one:
    // there is no silent-wrong-window failure mode here of the kind
    // `window.move`'s selector has.
    //
    // `target` rather than `direction`: a direction is resolved from the ACTIVE
    // window and not from the selector, so `direction` in a restore would swap
    // whatever the user is looking at.
    if (!op.address || !op.target || op.address === op.target) return [];
    return [
      dispatchCommand(
        "hl.dsp.window.swap({ " + windowSelector(op.address) +
        ', target = "address:' + op.target + '" })'
      )
    ];
  }

  if (op.kind === "divider") {
    // ONE dispatch — the same verb the geometry op's first half uses, aimed at
    // a TILED window on purpose, which is the thing tick y29 spent a whole
    // section warning against.
    //
    // What makes it safe here is not that the warning was wrong. It was right:
    // a resize at a tiled window moves the dwindle divider and drags the
    // neighbour, and it answers "ok" either way. What changed is that or5
    // measured the rule that makes the outcome predictable — the ask lands
    // EXACTLY when the window is the left/top child of the divider it moves,
    // and lands on `2 × current − asked` when it is not — and the planner only
    // ever emits this for the left/top side (planWorkspaceTiling, the sign
    // law). So the divider moves to a place the recording named, and the
    // neighbour it drags is dragged onto ITS recorded edge.
    //
    // Both x and y are required by the dispatcher (`error: … Expected positions
    // (x & y)`), so an axis this op is not trying to change carries the
    // window's current size on that axis and is a no-op.
    var wanted = op.size || [];
    if (wanted.length !== 2) return [];
    if (!(wanted[0] > 0) || !(wanted[1] > 0)) return [];
    return [
      dispatchCommand(
        "hl.dsp.window.resize({ " + windowSelector(op.address) +
        ", x = " + wanted[0] + ", y = " + wanted[1] + " })"
      )
    ];
  }

  if (op.kind === "ungroup") {
    // Deliberately empty, exactly like "group": everything about dissolving
    // depends on live state — which windows still claim group membership, and
    // whether a toggle would dissolve a group or CREATE one — so the service
    // executes it through the claim-based dissolve machinery (dissolveStep,
    // fed by dissolveTargets/isGroupClaimed above), re-reading before every
    // toggle. A static command list here would re-create the two-members-one-
    // group double-toggle bug the dissolve machinery exists to prevent.
    return [];
  }

  if (op.kind === "group") {
    // Make the first window a group, then pull the rest in — IN ORDER.
    //
    // The ordering rule, live-verified: `into_group` inserts the active window
    // AFTER the group's currently focused tab. So joining member i means
    // focusing member i-1 FIRST (which makes it the group's focused tab), then
    // focusing member i, then dispatching the join. Without the first focus the
    // insertion point is wherever the group's focus happened to be left — which
    // after a join is the window just added often enough to look correct, and
    // not often enough to be the recorded order.
    //
    // The two halves are targeted differently because the compositor treats
    // them differently, and both spellings are live-verified (see the block
    // above): group.toggle TAKES a window selector, so the group is created
    // without touching focus — but into_group IGNORES one and always acts on
    // the active window, so the join still has to focus first. `into_group`
    // wants a SPELLED-OUT direction ("left", not "l"), and it is window.move —
    // NOT hl.dsp.group.move_window, which is `movegroupwindow`, reorders within
    // an existing group and errors with "Window not in a group".
    //
    // Four things the service must add, because they need live state a pure
    // function cannot see: let the preceding moves settle (they run with
    // follow = false, so the windows need a moment to land in the tiling);
    // dissolve any stale grouping on these windows first
    // (hl.dsp.group.toggle({ window }) per member); if a member did not join,
    // retry with "right" / "up" / "down" — into_group is a no-op when there is
    // no group in the given direction, which depends on the tiling; and ASSERT
    // the order after every join with groupOrderMatches, because a join that
    // landed in the wrong slot answers "ok" exactly like one that did not.
    //
    // And the tiling can make ALL FOUR directions no-ops: into_group only
    // joins a group that is the directly ADJACENT layout node (live-proven,
    // see pickScratchWorkspace above), so when the candidate is not next to
    // the anchor the service assembles the pair on an empty workspace and
    // moves the group home (Service.qml scratchJoin). These commands are the
    // in-place half only.
    var addresses = op.addresses || [];
    if (addresses.length < 2) return [];

    var commands = [
      dispatchCommand("hl.dsp.group.toggle({ " + windowSelector(addresses[0]) + " })")
    ];
    for (var i = 1; i < addresses.length; i++) {
      commands.push(focusWindowCommand(addresses[i - 1]));
      commands.push(focusWindowCommand(addresses[i]));
      commands.push(dispatchCommand('hl.dsp.window.move({ into_group = "left" })'));
    }
    return commands;
  }

  if (op.kind === "launch") {
    // Deliberately empty. An Identity DOES carry a `launch` command these days
    // (see the Identity schema in StateModel.js), but a launch op carries only
    // an identityId — this function is handed the op and nothing else, so the
    // command is not in reach here, and resolving it would mean passing the
    // identity list into a per-op formatter for one op's sake.
    //
    // Launching stays the service's job for a second reason: the dispatch
    // `hyprctl dispatch 'hl.dsp.exec_cmd([[<cmd>]])'` (session-layout's
    // run_cmd) is only half of it — the other half is polling for the window
    // and re-planning once it exists, which is exactly the live-state work a
    // pure function cannot do. See Service.qml stepsForLaunch/waitForIdentity.
    return [];
  }

  return [];
}

if (typeof module !== "undefined") {
  module.exports = {
    TOPOLOGY_SEPARATOR: TOPOLOGY_SEPARATOR,
    monitorLabel: monitorLabel,
    topologyKey: topologyKey,
    monitorByIndex: monitorByIndex,
    monitorByDescription: monitorByDescription,
    clientMatchesIdentity: clientMatchesIdentity,
    matchClient: matchClient,
    shadowedIdentities: shadowedIdentities,
    couldShadow: couldShadow,
    strictlyWider: strictlyWider,
    claimantsCover: claimantsCover,
    firstClientFor: firstClientFor,
    clientsFor: clientsFor,
    liveWindowCount: liveWindowCount,
    launchDeficits: launchDeficits,
    launchDeficitFor: launchDeficitFor,
    pickClientFor: pickClientFor,
    chosenWindows: chosenWindows,
    placementKeyOf: placementKeyOf,
    comparePlacementKeys: comparePlacementKeys,
    placementComparator: placementComparator,
    occurrenceOf: occurrenceOf,
    memberKeyFor: memberKeyFor,
    memberIdentityOf: memberIdentityOf,
    memberOccurrenceOf: memberOccurrenceOf,
    windowForOccurrence: windowForOccurrence,
    memberKeyOfAddress: memberKeyOfAddress,
    groupSlotOf: groupSlotOf,
    recordedGroupSlotOf: recordedGroupSlotOf,
    matchOccurrences: matchOccurrences,
    matchLayout: matchLayout,
    groupMemberIds: groupMemberIds,
    groupOrderFor: groupOrderFor,
    groupIdFor: groupIdFor,
    groupClaimants: groupClaimants,
    isGroupClaimed: isGroupClaimed,
    dissolveTargets: dissolveTargets,
    pickScratchWorkspace: pickScratchWorkspace,
    splitTreeOf: splitTreeOf,
    layoutIsAmbiguous: layoutIsAmbiguous,
    placementOrderOf: placementOrderOf,
    planWorkspaceTiling: planWorkspaceTiling,
    tilingRefusalOf: tilingRefusalOf,
    singleFlipOf: singleFlipOf,
    tilingRefusalsOf: tilingRefusalsOf,
    tilingSettled: tilingSettled,
    tilingRefusalPhrase: tilingRefusalPhrase,
    TILING_REFUSAL_NOT_A_TREE: TILING_REFUSAL_NOT_A_TREE,
    TILING_REFUSAL_AMBIGUOUS: TILING_REFUSAL_AMBIGUOUS,
    TILING_REFUSAL_DIFFERENT_SHAPE: TILING_REFUSAL_DIFFERENT_SHAPE,
    TILED_REFINEMENT_TARGET_IOU: TILED_REFINEMENT_TARGET_IOU,
    TILED_REFINEMENT_MAX_NUDGES: TILED_REFINEMENT_MAX_NUDGES,
    isRefinementPlan: isRefinementPlan,
    planHasGroupJoins: planHasGroupJoins,
    planWithoutGroupJoins: planWithoutGroupJoins,
    planHasFocusOps: planHasFocusOps,
    planWithoutFocusOps: planWithoutFocusOps,
    opAddressesOf: opAddressesOf,
    opSubjectOf: opSubjectOf,
    failOutcome: failOutcome,
    planAddresses: planAddresses,
    unknownPlanAddresses: unknownPlanAddresses,
    normalizeGroupOrder: normalizeGroupOrder,
    sameAddressOrder: sameAddressOrder,
    groupOrderMatches: groupOrderMatches,
    geometryPair: geometryPair,
    GEOMETRY_TOLERANCE_PX: GEOMETRY_TOLERANCE_PX,
    geometryDelta: geometryDelta,
    withinTolerance: withinTolerance,
    rectIou: rectIou,
    geometryScoreFor: geometryScoreFor,
    geometrySummaryOf: geometrySummaryOf,
    geometryOffPhrase: geometryOffPhrase,
    geometrySkipPhrase: geometrySkipPhrase,
    monitorRect: monitorRect,
    rectsOverlap: rectsOverlap,
    geometryPlanSkip: geometryPlanSkip,
    GEOMETRY_SKIP_OFF_REGION: GEOMETRY_SKIP_OFF_REGION,
    GEOMETRY_SKIP_BAD_SIZE: GEOMETRY_SKIP_BAD_SIZE,
    isSpecialWorkspaceId: isSpecialWorkspaceId,
    buildLayout: buildLayout,
    currentPlacement: currentPlacement,
    driftOf: driftOf,
    verdictPhrase: verdictPhrase,
    blockedByIndex: blockedByIndex,
    verdictsFor: verdictsFor,
    verdictInstanceLabel: verdictInstanceLabel,
    verdictSummary: verdictSummary,
    planRestore: planRestore,
    opSignature: opSignature,
    planSignature: planSignature,
    samePlan: samePlan,
    describeOp: describeOp,
    opToCommand: opToCommand
  };
}
