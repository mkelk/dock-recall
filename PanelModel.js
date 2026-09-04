// PanelModel.js — everything the panel decides, as pure functions.
//
// Dual-runtime like engine.js and StateModel.js: ES5 only, no dependencies, no
// ES modules, `module.exports` behind a typeof guard. It runs under
// `node --test` and loads in QML as `import "PanelModel.js" as PanelModel`.
//
// The division of labour, and why this file exists at all: Panel.qml is a
// LAYOUT — rectangles, rows, a key catcher. Every question with a right answer
// ("how big is that monitor on screen?", "which chips are fused?", "what
// pattern watches this window class?") is answered here, where a test can ask
// it without a compositor.
//
// It deliberately does NOT require engine.js or StateModel.js. QML's .js
// imports cannot see each other, so a dependency between two of these files
// would only work under node — the QML half would load a module with holes in
// it. Anything this file needs from the engine (which identity a client
// matched, the drift report) is passed IN by the caller, and anything it wants
// to persist is RETURNED for StateModel to normalize and write.

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function trim(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
}

// A map lookup Object.prototype cannot answer — see the long note above
// `own` in StateModel.js. Every index in this file keyed by an identity id, a
// group id or a member key reads through this, because `map["constructor"]` on
// a bare object is truthy whether or not anything was put there (tick 8hp).
function own(map, key) {
  if (!map) return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// Escape every character that means something to a regex. Window classes
// contain dots as a matter of routine (md.obsidian.Obsidian), and an
// unescaped dot in a generated pattern is a wildcard that silently widens what
// the user thought they ticked.
//
// "-" is deliberately NOT escaped: it is only special inside a character
// class, and `\-` outside one is an Annex-B identity escape this code has no
// reason to lean on. The patterns first-party-style identity lists carry
// ("^chrome-app\\.slack\\.com") leave it bare too.
function escapeRegex(text) {
  return String(text === undefined || text === null ? "" : text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(text) {
  var words = String(text || "").split(/[-_\s]+/);
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    if (!word) continue;
    out.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// Naming the topology
// ---------------------------------------------------------------------------

var TOPOLOGY_SEPARATOR = " | ";

// What humanizeTopology says when there is no topology to name. Named because
// three callers have to RECOGNISE it — barGlyphTooltip, restoreTooltip, and
// recordTooltip all fall back to a generic phrase ("Dock Recall", "this
// setup") instead of naming a topology that is not there; a tooltip that
// opened with "for No monitors" would be describing a desk that is not there.
var EMPTY_TOPOLOGY = "No monitors";

// Monitor names Hyprland gives to a built-in laptop panel. The description of
// such a panel is a part number nobody recognises ("Samsung Display Corp.
// ATNA60HR07-0"), so when the live monitor list is available it is worth
// trading it for the word the user actually thinks in.
var INTERNAL_NAME = /^(eDP|LVDS|DSI)/i;

// Corporate noise that appears in EDID descriptions and carries no
// information: "AOC Inc. U34G2G" and "AOC U34G2G" name the same monitor.
var VENDOR_NOISE = /\s*\b(inc|llc|ltd|corp|co|gmbh|company|display|electronics|technology|technologies)\b\.?/gi;

// One monitor's label, shortened for a header.
function shortMonitorLabel(label, monitor) {
  if (monitor && INTERNAL_NAME.test(trim(monitor.name))) return "Laptop";

  var text = trim(label).replace(VENDOR_NOISE, " ").replace(/\s+/g, " ");
  text = trim(text);
  if (!text) return trim(monitor && monitor.name) || "Monitor";

  // Two words is the sweet spot: a make and a model ("AOC U34G2G4R3"), which
  // is how people name their screens out loud.
  var words = text.split(" ");
  if (words.length > 2) words = words.slice(0, 2);
  return words.join(" ");
}

// "Samsung Display Corp. ATNA60HR07-0 | AOC Inc. U34G2G" -> "Laptop + AOC U34G2G"
//
// `monitors` is optional: without it the laptop panel cannot be recognised by
// name and keeps its part number, which is still correct, just less friendly.
// That matters because the panel titles RECORDED topologies too, and the
// monitors of a topology you are not currently plugged into are not around to
// be asked.
function humanizeTopology(topologyKey, monitors) {
  var key = trim(topologyKey);
  if (!key) return EMPTY_TOPOLOGY;

  var labels = key.split(TOPOLOGY_SEPARATOR);
  var list = isArray(monitors) ? monitors : [];
  var parts = [];

  for (var i = 0; i < labels.length; i++) {
    var label = trim(labels[i]);
    if (!label) continue;
    var monitor = null;
    for (var j = 0; j < list.length; j++) {
      var candidate = list[j];
      if (!candidate) continue;
      var candidateLabel = trim(candidate.description) || trim(candidate.name);
      if (candidateLabel === label) { monitor = candidate; break; }
    }
    parts.push(shortMonitorLabel(label, monitor));
  }

  return parts.length ? parts.join(" + ") : EMPTY_TOPOLOGY;
}

// ---------------------------------------------------------------------------
// Identity derivation: what ticking a chip actually writes
// ---------------------------------------------------------------------------
//
// Watched-ness is per app IDENTITY, not per window (see the UX sketch), so
// clicking a chip has to turn a live window class into a durable rule. Two
// rules, because window classes come in two shapes.

var CHROME_PREFIX = /^chrome-/i;
// A trailing TLD in a webapp's synthesized class. Used only to drop it.
var TLD = /^[a-z]{2,6}$/i;
// Tokens that name a packaging convention rather than an app.
var GENERIC_TOKENS = {
  com: true, org: true, net: true, io: true, dev: true, me: true,
  app: true, apps: true, desktop: true, gnome: true, kde: true, x: true,
  md: true, www: true, exe: true, bin: true
};

// The part of a Chromium webapp class that is stable.
//
// Chromium synthesizes classes like
//   chrome-app.slack.com__client_T0EXAMPLE01_C0EXAMPLE02-Profile_1
// where everything after the "__" varies by profile, workspace and URL. Only
// the head survives a re-login, so only the head can be matched on.
function chromeStem(className) {
  var text = trim(className);
  var cut = text.indexOf("__");
  if (cut > 0) return text.slice(0, cut);
  cut = text.indexOf("-Profile");
  if (cut > 0) return text.slice(0, cut);
  return text;
}

// The regex the state file stores for a window class.
//
//   chrome-*  ->  an anchored PREFIX, no trailing $, because the tail is noise
//                 that changes under the user
//   anything  ->  an exact, fully anchored match. engine.compilePattern always
//   else          compiles case-insensitively, so no flag is needed here and
//                 none is stored.
function derivePattern(className) {
  var text = trim(className);
  if (!text) return "";
  if (CHROME_PREFIX.test(text)) return "^" + escapeRegex(chromeStem(text));
  return "^" + escapeRegex(text) + "$";
}

// The regex the state file stores for a window TITLE (schema v4
// `titlePatterns`). Always anchored on BOTH ends, with no prefix case: a title
// put there by the `--title` convention is a whole word chosen on purpose, not
// a packaging string with a varying tail like a Chromium class. derivePattern
// is deliberately not reused — its chrome- branch would turn a binary honestly
// named `chrome-something` into an open-ended prefix that claims titles nobody
// asked for.
function deriveTitlePattern(title) {
  var text = trim(title);
  if (!text) return "";
  return "^" + escapeRegex(text) + "$";
}

// A readable, stable id for a window class — the handle a recorded placement
// refers to, so it has to survive being looked at in a text editor.
//
//   chrome-app.slack.com__…        -> "slack"
//   chrome-mail.google.com__…      -> "mail-google"
//   chrome-calendar.google.com__…  -> "calendar-google"
//   md.obsidian.Obsidian           -> "obsidian"
//   org.telegram.desktop           -> "telegram"
//   foot                           -> "foot"
//
// Webapps keep their subdomain (minus a bare "app"/"web") because dropping it
// would collide Gmail with Calendar — two identities with one id, and
// StateModel drops the duplicate. Everything else keeps the last meaningful
// token of a reverse-DNS class, which is where the app's own name lives.
function deriveIdentityId(className) {
  var text = trim(className).toLowerCase();
  if (!text) return "";

  var tokens;
  if (CHROME_PREFIX.test(text)) {
    tokens = chromeStem(text).replace(CHROME_PREFIX, "").split(".");
    if (tokens.length > 1 && TLD.test(tokens[tokens.length - 1])) tokens = tokens.slice(0, tokens.length - 1);
    var kept = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      // "app.slack.com" and "web.whatsapp.com" name the app in ONE token; the
      // leading word is Chromium's, not the user's.
      // "app.slack.com", "web.whatsapp.com", "www.rememberthemilk.com" all
      // name the app in ONE token; the leading word is Chromium's or the
      // web's, not the user's.
      if (i === 0 && tokens.length > 1 && (token === "app" || token === "web" || token === "www")) continue;
      kept.push(token);
    }
    if (!kept.length) kept = [chromeStem(text).replace(CHROME_PREFIX, "")];
    return kept.join("-").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  }

  tokens = text.split(".");
  var survivors = [];
  for (var j = 0; j < tokens.length; j++) {
    var candidate = tokens[j];
    if (!candidate || candidate.length < 2) continue;
    if (own(GENERIC_TOKENS, candidate)) continue;
    survivors.push(candidate);
  }
  var chosen = survivors.length ? survivors[survivors.length - 1] : text;
  return chosen.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

// The id a TITLE identity carries: the name of the app inside the terminal,
// not the terminal's. `foot` hosting `herdr` is "herdr" — an id of "foot"
// would name the wrong thing, and the user would have no way to tell two
// terminal identities apart in their own state file.
//
// deriveIdentityId is the wrong tool for this: it reads a class, so it splits
// on dots and keeps the LAST token, which would turn the title "python3.11"
// into the id "11". A title is already one word — titleFromArgv0 reduced a
// binary path to one — so all it needs is the same final reduction to the
// characters an id may carry.
function identityIdFromTitle(title) {
  return trim(title).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

// The display name for a chip and a list row.
function displayNameFor(className) {
  var id = deriveIdentityId(className);
  return id ? titleCase(id) : trim(className);
}

// Does this pattern list already carry this EXACT pattern string?
//
// Its one caller left is the duplicate guard, where exact equality is the right
// question: it compares a pattern this file just generated against patterns
// stored in the file, and two identities are duplicates only when they say the
// same thing. Every place that asks whether a pattern MATCHES something reads
// it the matcher's way instead — matchesAnyPattern, tick 7qe.
function patternListHas(value, pattern) {
  return (isArray(value) ? value : []).indexOf(pattern) !== -1;
}

// THE DUPLICATE GUARD, and what it compares now that an identity has two axes.
//
// It used to compare `patterns` alone, which was complete while `patterns` was
// the only axis: same class pattern meant same rule. Schema v4 added
// `titlePatterns`, the two are ANDed (see the rule table in engine.js), and a
// class pattern on its own no longer says what an identity claims. So the guard
// compares BOTH AXES, and an empty title list counts as "no title constraint"
// rather than "any title" — because that is exactly what it means to
// matchClient:
//
//   proposal           existing on the list         verdict
//   -----------------  ---------------------------  -------------------------
//   ^foot$             ^foot$                       duplicate — same rule
//   ^foot$ + ^herdr$   ^foot$ + ^herdr$             duplicate — same rule
//   ^foot$ + ^herdr$   ^foot$, no title             NOT a duplicate. The
//                                                   existing rule claims EVERY
//                                                   foot window; the proposal
//                                                   claims the one titled
//                                                   herdr. Two different rules,
//                                                   and the specific one is
//                                                   prepended so first-match
//                                                   reaches it first.
//   ^foot$             ^foot$ + ^herdr$             NOT a duplicate — the same
//                                                   thing the other way round:
//                                                   watching plain foot is
//                                                   still possible once one
//                                                   titled foot window is
//                                                   watched.
//
// Comparing `patterns` alone would have refused to propose the herdr identity
// on any desktop that already watches plain foot — which is the ordinary case
// and the whole point of a title identity.
function identityClaimsSame(identity, pattern, titlePattern) {
  if (!patternListHas(identity.patterns, pattern)) return false;
  var titles = isArray(identity.titlePatterns) ? identity.titlePatterns : [];
  if (!titlePattern) return titles.length === 0;
  return patternListHas(titles, titlePattern);
}

// Build the Identity a freshly ticked window needs.
//
// Returns `{ refusal: "already-watched" }` when an identity claiming the same
// thing is ALREADY on the list — see identityClaimsSame above for what "the
// same thing" means — because adding a second identity for it would record the
// same window twice and make matchClient's answer depend on list order.
//
// Null is reserved for "there is no proposal to make at all": a class that
// derives no pattern. Everything else that declines carries a reason, because
// the panel has to be able to say which of the two happened.
//
// A colliding id (Chromium's second webapp on a domain already claimed) gets a
// numeric suffix rather than being merged: two ids that look alike are a
// cosmetic problem, one id meaning two apps is a data-loss one.
//
// `derivation` is OPTIONAL and is what terminalChildDerivation answered about
// the window being ticked. It is passed IN rather than computed here because
// naming the app inside a terminal takes a /proc read, and this function is
// pure. When it carries a title — meaning the ticked window is a terminal
// hosting exactly one unambiguous child — the proposal is a TITLE identity:
//
//   { id: "herdr", patterns: ["^foot$"], titlePatterns: ["^herdr$"],
//     launch: "foot --title=herdr herdr", pictured: false }
//
// which under the v4 AND semantics means "the foot window titled herdr" and
// nothing else.
//
// WITHOUT one, the answer depends on whether the class is a TERMINAL:
//
//   - not a terminal — the class-only proposal it has always been. A class is
//     the whole truth about a browser window or an editor window.
//   - a terminal — a REFUSAL, `{ refusal: "<reason>" }`. A bare `^foot$` claims
//     every terminal on the desktop and launches whichever one command it
//     learned, so writing it silently is the wrong answer wearing a tick mark;
//     the README calls it useless in as many words. The reason travels so the
//     panel can say WHY in the panel, which is what this project does with a
//     thing it cannot read (see CLAUDE.md, "Refusals are a feature").
//
// The refusal covers the ABSENT derivation too — the /proc read that has not
// come back yet, the race the panel's tickDerivation comment admits — under the
// reason "not-read". Before tick gpq that race wrote the catch-all and the
// autofill pass a moment later stamped the one app's command onto it, so what
// a tick produced was decided by click timing.
function suggestIdentity(className, identities, derivation) {
  var pattern = derivePattern(className);
  if (!pattern) return null;

  var answer = (derivation && typeof derivation === "object") ? derivation : {};
  var title = typeof answer.title === "string" ? trim(answer.title) : "";
  var titlePattern = title ? deriveTitlePattern(title) : "";

  var list = isArray(identities) ? identities : [];
  var taken = {};
  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string") continue;
    taken[identity.id] = true;
    // A duplicate is a REFUSAL, not a null (tick v5c, finding A7).
    //
    // It used to answer null, on the reasoning that ticking something already
    // watched is a harmless no-op. It is a no-op; it was not harmless, because
    // the panel could not tell "nothing to add" from "nothing to say". The
    // click fell through every gate — no refusal, an unchanged list, a
    // byte-identical write that returns TRUE — and the panel logged
    // `watching "foot" — 3 identities` about an identity it had not created,
    // naming the CLASS because there was no added identity to name.
    //
    // The click is most often this: a terminal running `herdr` that was started
    // without `--title`, on a desk where `{^foot$ + ^herdr$}` is already
    // watched. The window matches nothing, so it offers a chip; the app is
    // already claimed, so there is nothing to add; and the one thing that would
    // help — relaunch it under the title the identity looks for — is exactly
    // what a refusal reason gets said for.
    if (identityClaimsSame(identity, pattern, titlePattern)) {
      return { refusal: "already-watched" };
    }
  }

  // The terminal refusal comes AFTER the duplicate guard, and still does: when
  // both are true the duplicate is the more specific truth about the CLICK.
  // A refusal carries the reason and nothing else. It used to repeat the class
  // back as well, and no caller ever read it: every one of them — the panel's
  // refusal line included — already has the class it just passed in.
  if (!titlePattern && isTerminalClass(className)) {
    return { refusal: trim(answer.reason) || "not-read" };
  }

  var base = (titlePattern ? identityIdFromTitle(title) : deriveIdentityId(className)) || "app";
  var id = base;
  var suffix = 2;
  while (own(taken, id)) {
    id = base + "-" + suffix;
    suffix += 1;
  }

  // launch: "" for the class case, because THIS function is pure and
  // synchronous and a truthful launch command can only be read off the running
  // process or a desktop file — I/O the caller has to do. The field is filled
  // in a moment later by the panel's derivation pass (launchDerivation /
  // backfillLaunchCommands below), never guessed from the class here.
  //
  // The user-found bug this comment used to describe as a feature: an identity
  // that stays at "" can never be restored when its app is closed, which is
  // exactly the case Restore exists for.
  //
  // The TITLE case is not a guess and not an exception to that rule: the
  // caller already did the read, and `derivation.command` is the very command
  // terminalChildDerivation built from it. Writing it here rather than leaving
  // the autofill pass to derive the identical string a moment later means the
  // identity is complete in the first write.
  //
  // `pictured: false` on BOTH returns (schema v5, tick 2c3). Being watched and
  // being photographed are separate consents, and a tick grants only the first:
  // an app the user wants RESTORED has not thereby been offered up to be
  // captured to disk. StateModel.normalizeIdentity would materialize the false
  // on the way to the file anyway, so writing it here buys nothing on disk —
  // what it buys is that the object this function HANDS BACK has the schema's
  // shape before it ever reaches a file, and every caller that reads a proposal
  // straight (the panel's confirmation line, the undo stash) sees the same
  // identity the file will hold. The alternative is a field that is undefined
  // for exactly as long as it takes to write, which is the window the learnings
  // entry behind this tick was written about.
  if (!titlePattern) return { id: id, patterns: [pattern], launch: "", pictured: false };
  return {
    id: id,
    patterns: [pattern],
    titlePatterns: [titlePattern],
    launch: dispatchableCommand(answer.command),
    pictured: false
  };
}

// Tick or untick a class. Returns a NEW identity list for the caller to hand
// to StateModel.setIdentities — this file never touches the file itself.
//
// `identityId` is what the caller already knows from the chip model: the id
// this window currently matches, or "" when it matches nothing. Passing it in
// rather than re-deriving it keeps ONE matcher (engine.matchClient) in charge
// of what a window is, so the panel can never untick something different from
// what the chip was showing.
//
// New identities go to the FRONT, with ONE exception: the list is priority
// order and engine.matchClient returns the first match, so the specific thing
// the user just pointed at must not end up behind a catch-all that was added
// earlier. That is exactly what a title identity needs — `{^foot$ + ^herdr$}`
// has to sit in front of a plain `{^foot$}` or the catch-all answers first and
// the title axis never gets asked.
//
// THE EXCEPTION (tick gpq, human decision 2026-08-19). Prepending blindly is
// how the panel MANUFACTURED the state engine.shadowedIdentities exists to
// report: a user with a working `{^foot$ + ^herdr$}` ticks a plain terminal, a
// fresh `^foot$` lands in front of it, and every herdr window silently becomes
// "terminal". So a new identity is inserted AFTER the last existing identity it
// would shadow — see insertionIndexFor for what "would shadow" means and why
// the answer needs BOTH engine.couldShadow and a shared class pattern.
//
// `derivation` is passed straight through to suggestIdentity: it is the
// terminal-tick answer for the window being ticked, which only the caller can
// obtain (it takes a /proc read). Untick ignores it.
//
// `couldShadow` is engine.couldShadow, passed IN rather than reimplemented:
// which pairs of identities stand in the shadowing relation is one rule and it
// lives beside the matcher. Without it the insert prepends, which is what every
// caller that predates tick gpq expects.
function toggleWatchedIdentities(identities, className, identityId, derivation, couldShadow) {
  return tickOutcome(identities, className, identityId, derivation, couldShadow).identities;
}

// EVERYTHING one chip click does, decided once (tick zkb).
//
// A single click used to ask suggestIdentity TWICE — through tickRefusalReason
// to decide whether to refuse, and again inside toggleWatchedIdentities to
// build the list — and then diff the two lists with addedIdentity to recover
// the identity the second call had just built and discarded. Three passes over
// one question, and three places for the answers to drift apart the day any of
// them grows a condition the others lack.
//
// Returns { refusal, identities, added }:
//   refusal    — the reason to say no, or "". The panel shows it and writes
//                nothing.
//   identities — the list to write. Always a new array, and equal to the input
//                (by value) whenever nothing changed.
//   added      — the identity this click created, or null. The panel's success
//                line names it, so it must be the object that was actually
//                inserted rather than one recovered by comparing lists.
//
// toggleWatchedIdentities is this function's `identities`, so the two can never
// answer differently; the panel calls this one, and the older name stays for
// the callers and tests that only ever wanted the list.
function tickOutcome(identities, className, identityId, derivation, couldShadow) {
  var list = isArray(identities) ? identities : [];
  var wanted = trim(identityId);

  if (wanted) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === wanted) continue;
      out.push(list[i]);
    }
    return { refusal: "", identities: out, added: null };
  }

  var addition = suggestIdentity(className, list, derivation);
  // Null is "there is no proposal to make at all" (a class that derives no
  // pattern); a refusal is a message for the user. Neither changes the list.
  if (!addition) return { refusal: "", identities: list.slice(), added: null };
  if (addition.refusal) {
    return { refusal: String(addition.refusal), identities: list.slice(), added: null };
  }

  var at = insertionIndexFor(addition, list, couldShadow);
  return {
    refusal: "",
    identities: list.slice(0, at).concat([addition]).concat(list.slice(at)),
    added: addition
  };
}

// Do two identities constrain the same window CLASS at all?
//
// engine.couldShadow answers about AXES — which of `patterns`/`titlePatterns`
// each side constrains — and is deliberately blind to what the patterns say,
// because regex subsumption is not decidable. That makes it true of ANY two
// class-only identities, `^foot$` and `^chromium$` included, which have no
// window in common and no order worth arguing about.
//
// So the insert asks this as well. Two identities that share a class pattern
// string claim from the same pool of windows; two that do not are unordered
// with respect to each other, and the front is where a new identity goes.
// Compared case-insensitively because engine.compilePattern compiles that way,
// so `^Foot$` and `^foot$` claim the same windows.
function sharesClassPattern(a, b) {
  var left = isArray(a && a.patterns) ? a.patterns : [];
  var right = isArray(b && b.patterns) ? b.patterns : [];
  for (var i = 0; i < left.length; i++) {
    if (typeof left[i] !== "string") continue;
    var one = trim(left[i]).toLowerCase();
    if (!one) continue;
    for (var j = 0; j < right.length; j++) {
      if (typeof right[j] !== "string") continue;
      if (trim(right[j]).toLowerCase() === one) return true;
    }
  }
  return false;
}

// Where in the list a new identity belongs: the front, unless it would shadow
// something already there.
//
// "Would shadow" is `couldShadow(addition, existing)` — could the addition, if
// it sat in front, claim everything the existing one claims — AND a shared
// class pattern, without which couldShadow's axis test says yes to every pair
// of class-only identities and a new identity would sink to the back of the
// list for no reason (see sharesClassPattern).
//
// AFTER THE LAST one it would shadow, not before the first: the addition has to
// clear every identity it could swallow, and the identities it does NOT shadow
// keep it in front of them, which is the ordinary prepend.
//
//   existing [herdr {^foot$+^herdr$}], addition {^foot$}   ->  index 1
//   existing [browser {^chromium$}],   addition {^foot$}   ->  index 0
//   existing [terminal {^foot$}],      addition {^foot$+^btop$} -> index 0
function insertionIndexFor(addition, identities, couldShadow) {
  var list = isArray(identities) ? identities : [];
  if (typeof couldShadow !== "function") return 0;

  var at = 0;
  for (var i = 0; i < list.length; i++) {
    var existing = list[i];
    if (!existing || typeof existing !== "object") continue;
    if (!sharesClassPattern(addition, existing)) continue;
    if (!couldShadow(addition, existing)) continue;
    at = i + 1;
  }
  return at;
}

// ---------------------------------------------------------------------------
// Saying that an identity can never win
// ---------------------------------------------------------------------------
//
// engine.shadowedIdentities does the finding — it is a question about the
// matcher, so it lives beside the matcher, and the report is passed IN here the
// way the drift report and the verdicts are. This half is the sentence.
//
// It has to name BOTH identities. The user's only fixes are to move one above
// the other in the state file or to untick the one in front, and neither is
// possible from a message that says only "something is wrong". Naming the ids —
// not the display names — is deliberate: the id is what they will read in the
// file and what the chip's tick removes.
//
// Why this is a panel-level line rather than a row hint: a shadowed identity
// usually has NO row. Its windows all resolved to the identity in front, so
// appRows lists them under that one; the shadowed identity appears only as a
// recorded ghost, if it happens to be in the layout, saying "not running" about
// an app that is on screen. There is nothing to hang the reason on.

// `"a"`, `"a" and "b"`, `"a", "b" and "c"` — ids, quoted, in the order given.
function quotedIdList(ids) {
  var list = isArray(ids) ? ids : [];
  var quoted = [];
  for (var i = 0; i < list.length; i++) {
    var id = trim(list[i]);
    if (id) quoted.push('"' + id + '"');
  }
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0];
  return quoted.slice(0, quoted.length - 1).join(", ") + " and " + quoted[quoted.length - 1];
}

// One entry of engine.shadowedIdentities -> one sentence, or "" when the entry
// says nothing usable (which is the caller's single truthy test — a hint that
// renders as an empty line looks like a bug in the panel).
//
// TWO SENTENCES, because the evidence supports two different strengths of claim
// (tick ytt). `entry.strict` says every claimant constrains strictly fewer axes
// than the shadowed identity — it is wider by construction, so moving the
// shadowed identity above it costs the claimant nothing it can still reach, and
// "put it above, or untick" is provably safe advice. Where the two constrain
// the SAME axes, all the evidence supports is an observation: no window reaches
// it right now. An imperative there would be advice about what is open at the
// moment, which is the wolf-cry this detector exists to remove.
//
// A missing `strict` is treated as the WEAK case on purpose: an entry that does
// not say the relation is strict has not earned an instruction.
function shadowNoticeFor(entry) {
  if (!entry || typeof entry !== "object") return "";
  var id = trim(entry.id);
  var names = quotedIdList(entry.claimedBy);
  if (!id || !names) return "";

  var matched = Number(entry.windows) || 0;
  // How many of them the NAMED claimants took. engine.shadowedIdentities is the
  // only producer of these entries and it always writes the field; the
  // pre-ytt fallback that read an absent one as "all of them" outlived the
  // shape it was compensating for.
  var took = Number(entry.claimed) || 0;
  if (took > matched) took = matched;

  var windows;
  if (took < matched) windows = took + " of the " + matched + " windows it matches";
  else if (matched > 1) windows = "all " + matched + " windows it matches";
  else windows = "the only window it matches";

  var one = isArray(entry.claimedBy) && entry.claimedBy.length === 1;
  var body = names + (one ? " is" : " are") + " earlier in the list and "
    + (one ? "claims " : "claim ") + windows;

  if (entry.strict === true) {
    return '"' + id + '" never wins a window: ' + body
      + '. Put "' + id + '" above ' + (one ? names : "them") + " in the state file, or untick "
      + (one ? names : "them") + ".";
  }
  return 'No open window currently reaches "' + id + '": ' + body
    + ". " + names + (one ? " is" : " are") + " no narrower a rule than \"" + id
    + "\", so this may be nothing more than what is open right now.";
}

// Every such sentence, one per line, or "" when the list is healthy.
function shadowedIdentityHint(report) {
  var list = isArray(report) ? report : [];
  var lines = [];
  for (var i = 0; i < list.length; i++) lines.push(shadowNoticeFor(list[i]));
  return joinLines(lines);
}

// ---------------------------------------------------------------------------
// Deriving a launch command
// ---------------------------------------------------------------------------
//
// The gap this section closes: suggestIdentity writes `launch: ""` for the
// identities it creates from a CLASS alone, and "" means NEVER LAUNCH (see the
// Identity schema note in StateModel.js). A TITLE identity is the exception —
// the caller already read /proc to name the app inside the terminal, so the
// command comes back with the title and is written in the same breath — but
// every ordinary tick still arrives here empty. A user who ticked three
// webapps, recorded them, closed them and pressed Restore got nothing at all —
// the service logged "not running and has no launch command — leaving it"
// three times and called it a converged pass. Restore could bring a window back
// to its workspace but could never bring the app back.
//
// So the panel learns the command instead of guessing it, from the two places
// where a true answer already exists:
//
//   1. THE RUNNING PROCESS.  A watched window carries a pid, and
//      /proc/<pid>/cmdline is the exact argv the app was started with. Read as
//      `tr '\0' '\n' < /proc/PID/cmdline` (QML has no readable /proc access of
//      its own) and re-quoted here.
//   2. THE DESKTOP FILE.  For an app that is NOT running — which is precisely
//      the case Restore exists for — the only record left is its `.desktop`
//      entry. Its Exec= line is a launch command by definition.
//
// Nothing here ever overwrites a launch the user already has: a derived
// command is a repair for an empty field, not an opinion about a filled one.
//
// ---------------------------------------------------------------------------
// QUOTING STRATEGY — read this before touching the two producers
// ---------------------------------------------------------------------------
//
// The string these functions return ends up, verbatim, inside a Lua long
// string in a Hyprland dispatch:
//
//     hl.dsp.exec_cmd([[<command>]])
//
// and is then run by a shell. That is TWO layers, and they want opposite
// things, so each producer is explicit about which layer it is responsible for:
//
//   - THE SHELL LAYER is owned by whoever knows whether its input is already
//     quoted. /proc/<pid>/cmdline is a NUL-separated list of RAW argv strings —
//     no quoting at all — so launchCommandFromArgv adds it (shellQuoteArg).
//     A desktop file's Exec= is ALREADY a quoted command line by spec, so
//     desktopExecCommand only strips the %-field codes and otherwise leaves
//     every character where the packager put it. Re-quoting it would turn
//     `foo "https://x"` into one literal argument.
//
//   - THE LUA LAYER cannot be escaped, only avoided: `]]` closes a long string
//     early and there is no escape sequence for it inside one. Service.qml
//     already refuses to dispatch such a command (stepsForLaunch); this file
//     refuses to WRITE one, so the bad value never reaches the state file.
//     Control characters are rejected for the same reason — a newline inside
//     `[[ ]]` is legal Lua but makes the dispatch unreadable and a leading one
//     is silently eaten by the parser.
//
// The single choke point for both rules is dispatchableCommand(); every
// producer in this section returns through it, and "" is always the answer for
// "there is no safe command here", which is the same value as "none known".

// Characters that need no shell quoting at all. Deliberately conservative:
// anything outside this set gets quoted, because the cost of an unnecessary
// pair of quotes is nil and the cost of a missed one is arbitrary execution.
var SHELL_SAFE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

// One argv element as one shell word.
//
// Single quotes, because inside them the shell interprets NOTHING — no $, no
// backtick, no backslash. The one character that cannot appear inside single
// quotes is a single quote, and the standard dance for it is to close, emit an
// escaped quote, and reopen: `it's` -> `'it'\''s'`.
function shellQuoteArg(value) {
  var text = String(value === undefined || value === null ? "" : value);
  if (text === "") return "''";
  if (SHELL_SAFE.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

// The Lua-layer gate described above. Returns the command, or "" when it could
// not survive the trip to hl.dsp.exec_cmd intact.
function dispatchableCommand(command) {
  var text = trim(command);
  if (!text) return "";
  // `]]` would close the [[ ]] long string early and turn the rest of the
  // command into Lua syntax. There is no escape for it; the only safe answer
  // is to have no command.
  if (text.indexOf("]]") !== -1) return "";
  // Control characters (newlines included) survive neither the dispatch string
  // nor the log line that reports it.
  if (/[\x00-\x1f\x7f]/.test(text)) return "";
  return text;
}

// A launch command that may be WRITTEN to the state file, or "".
//
// dispatchableCommand asks whether a string survives the trip to
// `hl.dsp.exec_cmd`. This asks the question before that one: is this a command
// at all? It exists because of tick tnm (finding A9), where the answer was no
// and every gate downstream said yes.
//
// The panel's row repair read its derivation map with a bare bracket lookup.
// The map is keyed by identity id, and `map["constructor"]` on a bare object
// does not answer undefined on a key miss — it answers with the `Object`
// constructor. `if (!command)` let it through, and `String(Object)` is
// `function Object() { [native code] }`, which contains no `]]` and no control
// character, so dispatchableCommand happily returned it and the state file
// gained:
//
//     "launch": "function Object() { [native code] }"
//
// The lookup is own-guarded now, which stops that particular value at source.
// This is the second rule, and it is the one that generalises: a launch command
// is a STRING, and it is not JavaScript source. Anything else reaching a write
// is the shape of a bug — a map miss, a function that got copied where a string
// was meant, a value out of a hand-edited file — and the right answer to a
// value the panel cannot explain is to write nothing.
//
// The cost, stated: the `class` and `async` prefixes also refuse a real command
// whose executable is named `class` or `async` (`async run …`). That is the
// trade this deliberately takes — such a binary is vanishingly rare, the user
// can still hand-edit the launch into the state file, and the failure mode it
// buys off is JavaScript source silently becoming a stored launch command.
var FUNCTION_SOURCE = /^\s*(function\b|class\b|async\b|\(\s*[A-Za-z0-9_$,\s]*\)\s*=>)/;

function learnableLaunch(value) {
  // Not a string: a function, an object, a number, `Object` itself. There is no
  // coercion here on purpose — String(anything) always produces SOMETHING, and
  // producing something is exactly how the junk got written.
  if (typeof value !== "string") return "";
  var command = dispatchableCommand(value);
  if (!command) return "";
  // A string that IS JavaScript source. Belt and braces on top of the type
  // check: a value that took the scenic route through a template or a log line
  // arrives as a string and would otherwise pass everything above.
  if (FUNCTION_SOURCE.test(command)) return "";
  if (command.indexOf("[native code]") !== -1) return "";
  return command;
}

// The one-identity repair a panel ROW performs, as a map the backfill accepts —
// or null when there is nothing to learn.
//
// A row's "Learn launch" is the footer button narrowed to one app, so it goes
// through the same repair rule and can never write what the button would have
// refused. What it adds is the two guards above: the lookup is `own`, so a key
// miss on a reserved id is a miss, and the value is `learnableLaunch`, so a
// map entry that is not a runnable command is not written.
//
// `__proto__` answers null here and that is correct: `own` cannot find it (a
// write to a bare object stores nothing under it), so the derivation genuinely
// has no command for it. See the reserved-id note in StateModel.js for why that
// key is a documented limit rather than a repairable case.
function singleLaunchRepair(commands, identityId) {
  var id = typeof identityId === "string" ? identityId : "";
  if (!id) return null;
  var command = learnableLaunch(own(commands, id));
  if (!command) return null;
  var one = {};
  one[id] = command;
  return one;
}

// ------------------------------------------------------- the running process

// Split the output of `tr '\0' '\n' < /proc/PID/cmdline` into argv.
//
// cmdline ends with a trailing NUL, so the translated text ends with a blank
// line; empty entries are dropped. KNOWN LIMIT: an argv element that itself
// contains a newline is split in two. Nothing on this desktop launches that
// way, and the alternative (a binary read) is not available to a QML Process.
//
// This function stays a SPLITTER and nothing more: it reports what the file
// contained, even when what it contained is not really argv. Some processes
// (Electron above all) rewrite their cmdline with spaces instead of NULs, and
// the result arrives here as one element carrying a whole command line.
// Deciding that such a reading may not be turned into a launch command is
// argvLooksNulLess's job, below — a trust question, asked where the other two
// trust questions are asked.
function parseProcCmdline(raw) {
  var text = String(raw === undefined || raw === null ? "" : raw);
  var parts = text.split("\n");
  var argv = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    argv.push(parts[i]);
  }
  return argv;
}

// The window classes that belong to a BROWSER PROCESS — the browser's own
// window and the webapp windows it hosts.
//
// A small data list rather than one clever regex, so that adding a browser is
// a one-line edit and each line can say what it is for. Every entry is
// anchored at the start and matched case-insensitively against the whole
// class:
//
//   chromium…            Chromium (chromium, chromium-browser)
//   chrome, chrome-…     Chrome's own class, and every webapp window class
//                        Chromium synthesizes (chrome-mail.google.com__mail-…)
//   google-chrome…       Chrome as packaged (…-beta, …-unstable)
//   brave…               Brave (brave-browser)
//   edge…, microsoft-edge…  Edge (…-beta, …-dev)
//   vivaldi…             Vivaldi (vivaldi-stable)
var BROWSER_FAMILY = [
  /^chromium/i,
  /^chrome($|-)/i,
  /^google-chrome/i,
  /^brave/i,
  /^(microsoft-)?edge/i,
  /^vivaldi/i
];

// Is this window class one of a browser process's windows?
//
// WHY THIS EXISTS (user-found, third gate test): Chromium runs ONE process per
// profile, and EVERY window it owns reports that process's pid — the plain
// browser window and each webapp window alike. So /proc/<pid>/cmdline is not
// the argv of the window in front of you; it is whatever argv happened to
// create the process, which may have been a sibling window months of uptime
// ago.
//
// The user ticked their plain Chromium window. Its process had been created by
// a webapp relaunch, so its cmdline ended in
// `--app=https://mail.google.com/…`. The panel learned that as chromium's
// launch command; "launch chromium" then opened a GMAIL window, which never
// matches `^chromium$`, so the launch wait timed out, the pass made no
// progress, and Restore stopped before it converged.
//
// The earlier version of this guard only rejected browser argv WITHOUT
// `--app=`, on the theory that an `--app=` cmdline must be the webapp's own.
// It isn't: a shared process's cmdline carries the `--app=` of whichever
// window created it. There is no test that separates "this argv made THIS
// window" from "this argv made a sibling", so for this family /proc is not
// evidence at all — the desktop file is the only honest source.
//
// KNOWN LIMIT: a browser-family window with no desktop file (an ad-hoc webapp
// nobody packaged) now derives nothing rather than a possibly-wrong command.
// "" means "no launch known", which the panel shows as `no launch cmd` — a
// visible dead end beats a command that opens the wrong window.
function isBrowserFamilyClass(className) {
  var text = trim(className);
  if (!text) return false;
  for (var i = 0; i < BROWSER_FAMILY.length; i++) {
    if (BROWSER_FAMILY[i].test(text)) return true;
  }
  return false;
}

// How many live windows each pid owns: { "<pid>": <count> }.
//
// `clients` is the hyprctl client list the panel already holds. This is the
// input to the structural half of the trust question below — no /proc walk, no
// extra read, just a tally of what is on screen.
function windowCountByPid(clients) {
  var list = isArray(clients) ? clients : [];
  var out = {};
  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    if (!client) continue;
    var pid = trim(client.pid);
    if (!pid || pid === "0" || pid === "-1") continue;
    out[pid] = (out[pid] || 0) + 1;
  }
  return out;
}

// Does this pid own MORE THAN ONE live window?
//
// The general form of the shared-Chromium bug. A pid with two windows on
// screen is a multi-window host process: `foot --server` behind footclient,
// emacsclient against a running daemon, a single-instance Electron app, kitty
// in single-instance mode, and every browser. Its /proc cmdline is the argv
// that created the PROCESS — for a server, the argv of a daemon that opens no
// window at all — and using it as a per-window launch command produces
// commands that either open the wrong thing or nothing.
//
// Deliberately structural: it asks what the process IS DOING rather than what
// it is CALLED, so it covers apps no name list would have thought of. Its
// blind spot (a host with only one window open right now) is what the
// browser-family list backstops.
function isSharedProcessPid(pid, windowsByPid) {
  var key = trim(pid);
  if (!key) return false;
  var map = (windowsByPid && typeof windowsByPid === "object") ? windowsByPid : {};
  return (own(map, key) || 0) > 1;
}

// Does this argv have the shape of a cmdline that was rewritten WITHOUT the
// NUL separators — i.e. is it not really argv at all?
//
// WHY THIS EXISTS (user-found, hardware checklist): /proc/<pid>/cmdline is by
// contract a NUL-separated list, and the read (`tr '\0' '\n'`) depends on that
// completely. Electron/chromium REWRITE their own cmdline at startup — they
// overwrite the argv area in place to set the process title — and write plain
// SPACES between the arguments. The kernel hands back exactly what is in that
// memory, so the read produces ONE line:
//
//     /usr/lib/electron43/electron -disable-gpu --enable-wayland-ime /usr/lib/obsidian/app.asar
//
// parseProcCmdline then honestly reports one argv element, and quoting one
// element is quoting a filename — which produced the exact string that has
// been haunting the user's state file:
//
//     '/usr/lib/electron43/electron -disable-gpu … /usr/lib/obsidian/app.asar'
//
// one shell word naming a program that does not exist. Neither existing guard
// catches it: obsidian is not browser-family (its class is md.obsidian.Obsidian
// and no name list would think to include it), and the window is alone in its
// process, so the shared-pid test sees an ordinary single-window app.
//
// The tell is the SHAPE, and it is the only honest one available: a real argv
// whose whole command line is a single element cannot contain a space, because
// a space is precisely what separates argv elements. So one element with
// internal whitespace means the separators were lost — the string is a
// rendering of an argv, not an argv — and /proc is not evidence here.
//
// WHAT THIS DELIBERATELY DOES NOT DO: split it on spaces. A path may contain
// spaces (`/opt/My App/bin/app --flag` is indistinguishable from
// `/opt/My.App --flag /home/u/My Vault` once the separators are gone), so any
// split is a guess, and a wrong guess writes a launch command that starts the
// wrong thing — worse than starting nothing. Refusing sends the derivation
// down to the desktop file, where obsidian.desktop answers /usr/bin/obsidian.
//
// KEPT TRUSTED: a normal multi-element argv (`foot --working-directory …`,
// separators intact) and a single element with NO whitespace (`herdr`, `foot`),
// which is what a one-word command line legitimately looks like.
//
// KNOWN LIMIT, and the deliberate side of the trade: a genuine one-element argv
// whose only element is a path containing a space (`/opt/My App/bin/app`, run
// with no arguments) is refused too, because from here it is the same string.
// It costs that app its /proc derivation and sends it to its desktop file,
// which is the ordinary path for every app that is not running anyway.
function argvLooksNulLess(argv) {
  var list = isArray(argv) ? argv : [];
  if (list.length !== 1) return false;
  if (typeof list[0] !== "string") return false;
  return /\s/.test(trim(list[0]));
}

// ---------------------------------------------------------------------------
// Terminal-hosted apps: deriving a launch from the CHILD process
// ---------------------------------------------------------------------------
//
// The blind spot the README's terminal-title section describes, closed from the
// other side. A TUI app typed into a plain terminal (`herdr` in `foot`) owns no
// window of its own: the window is class `foot`, and /proc/<pid>/cmdline is
// `foot` — the terminal, not the app. Nothing in the derivation above can see
// past that, so the identity gets no launch command and Restore can never bring
// the app back.
//
// The terminal's CHILD process is the app. Reading it turns `foot` into
// `foot --title=herdr herdr`, which is exactly the command the README asks the
// user to bind by hand — so the panel can offer it instead of asking.
//
// Why the TITLE, and not a window class of its own (measured 2026-08-18):
//
//   - `foot --title=herdr herdr` fixes `initialTitle` at `herdr` and leaves
//     `class` as `foot`, so every Omarchy class-matched window rule still
//     applies. A private class would silently lose all of them.
//   - `initialTitle` is set once, at map time. An app that renames itself the
//     instant it starts moves `title` only, never `initialTitle` — which is
//     why identity matching reads `initialTitle` and nothing else.
//   - Hyprland FULL-matches an unanchored window-rule regex, so a compound
//     class like `foot.herdr` cannot be made to match alongside plain `foot`.
//     The title is the only route.
//
// The window classes of the terminals this is attempted for. A named list, like
// BROWSER_FAMILY, so adding a terminal is a one-line edit:
//
//   foot, footclient   foot, and its client against a foot server
//   alacritty          Alacritty (class Alacritty)
//   kitty              kitty (class kitty)
//   ghostty            Ghostty (class ghostty, com.mitchellh.ghostty)
//
// They all spell the title the same way, so THAT is a constant rather than a
// per-entry column: the flag column existed only because the terminals disagree
// about `--app-id` versus `--class`, and no terminal here disagrees about
// `--title`. What still differs per terminal is the COMMAND SHAPE, and the
// derived command has to run — a command that is merely plausible would fail at
// the one moment it matters: a restore after a reboot, with nobody watching.
//
//   exec  what has to come between the flags and the hosted command
//           foot, kitty        "" — a bare trailing command is the command
//           alacritty, ghostty "-e" — a bare trailing command is REJECTED
//
// So the two shapes are:
//
//   foot --title=herdr herdr
//   alacritty --title=herdr -e herdr
//
// Alacritty is the one that used to be wrong here. Verified against Alacritty
// 0.17.0: `alacritty --title=x x` exits with a usage error — `-e` is not
// optional.
var TERMINAL_TITLE_FLAG = "--title";

var TERMINAL_FAMILY = [
  { test: /^foot(client)?$/i, exec: "" },
  { test: /^kitty$/i, exec: "" },
  { test: /^alacritty$/i, exec: "-e" },
  // Ghostty's `-e` is taken from upstream docs and is unverified locally — no
  // Ghostty on the machine this was written on.
  { test: /^(com\.mitchellh\.)?ghostty$/i, exec: "-e" }
];

function isTerminalClass(className) {
  var text = trim(className);
  if (!text) return false;
  for (var i = 0; i < TERMINAL_FAMILY.length; i++) {
    if (TERMINAL_FAMILY[i].test.test(text)) return true;
  }
  return false;
}

// The word that has to sit between the flags and the hosted command, or "" for
// the terminals that take a bare trailing command.
function terminalExecFlag(className) {
  var text = trim(className);
  for (var i = 0; i < TERMINAL_FAMILY.length; i++) {
    if (TERMINAL_FAMILY[i].test.test(text)) return TERMINAL_FAMILY[i].exec;
  }
  return "";
}

// The shells a terminal starts BEFORE the app. A terminal launched with no
// command runs the login shell, and the shell runs whatever was typed — so the
// app is the shell's child, not the terminal's, and the wrapper has to be
// looked through rather than refused.
var SHELL_BINARIES = ["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "tcsh", "csh"];

function basenameOf(path) {
  var text = trim(path);
  var cut = text.lastIndexOf("/");
  return cut === -1 ? text : text.substring(cut + 1);
}

// Is this argv a BARE shell — the interactive wrapper, carrying no command of
// its own? A login shell reports argv0 with a leading "-" ("-bash"), which is
// the same shell.
//
// A shell WITH arguments (`bash -c "herdr --watch"`) is not bare: it is a
// command in its own right, and deriving through it would throw away the very
// argument that says what to run.
function isShellArgv(argv) {
  var list = isArray(argv) ? argv : [];
  if (list.length !== 1) return false;
  var name = basenameOf(list[0]).replace(/^-/, "");
  if (!name) return false;
  for (var i = 0; i < SHELL_BINARIES.length; i++) {
    if (SHELL_BINARIES[i] === name) return true;
  }
  return false;
}

// A process node's children, in pid order so two reads of one unchanged tree
// answer the same way.
function childNodesOf(node) {
  var out = [];
  if (!node || !node.children) return out;
  for (var pid in node.children) {
    if (Object.prototype.hasOwnProperty.call(node.children, pid)) out.push(node.children[pid]);
  }
  out.sort(function (a, b) { return Number(a.pid) - Number(b.pid); });
  return out;
}

// The window TITLE to give a terminal-hosted app, derived from the binary it
// runs. Lower-cased and reduced to the characters a title pattern may safely
// carry — the same shape deriveIdentityId produces, for the same reason: the
// derived word ends up inside an anchored regex, and Hyprland full-matches an
// unanchored one.
function titleFromArgv0(argv0) {
  var name = basenameOf(argv0).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name;
}

// The whole terminal-child rule, as one answer:
//
//   { command: "<terminal> --title=<derived> [-e] <child argv>", title: "<derived>",
//     reason: "" }
//   { command: "", title: "", reason: "no-child" | "several-children"
//                                   | "shell-chain" | "unreadable-child" }
//   { command: "", title: "", reason: "" }  — not a terminal question at all
//
// `title` is the same word the command's `--title=` carries, said separately
// because two different callers want two different halves of one answer: the
// launch derivation wants the command, and suggestIdentity wants the title —
// it is both the new identity's id and its `titlePatterns` entry. Deriving it
// twice would be two chances to disagree about what the app is called.
//
// ONLY an unambiguous single child derives. Anything else REFUSES, loudly and
// on purpose: the panel says "ambiguous" and points at the --title convention
// rather than guessing. A terminal with two children is a terminal running two
// things (or a shell job plus a pager), and picking one of them would write a
// launch command that reopens the wrong app — silently, and only discovered at
// the next restore.
//
// A BARE shell between the terminal and the app is looked THROUGH: that is the
// ordinary shape (`foot` -> `bash` -> `herdr`), not an ambiguity. A shell with
// two children of its own is one again.
function terminalChildDerivation(className, ownArgv, node) {
  var out = { command: "", title: "", reason: "" };
  if (!isTerminalClass(className)) return out;

  // Only when the terminal's own cmdline says nothing but the terminal. A
  // `foot --title=herdr herdr` cmdline already IS the answer and goes through
  // the ordinary derivation; so does `foot -e something`.
  var own = isArray(ownArgv) ? ownArgv : [];
  if (own.length !== 1 || !trim(own[0])) return out;

  var kids = childNodesOf(node);
  if (kids.length !== 1) {
    out.reason = kids.length ? "several-children" : "no-child";
    return out;
  }

  var child = kids[0];
  if (isShellArgv(child.argv)) {
    var grandkids = childNodesOf(child);
    if (grandkids.length !== 1) {
      out.reason = grandkids.length ? "several-children" : "no-child";
      return out;
    }
    child = grandkids[0];
    if (isShellArgv(child.argv)) {
      // A shell inside a shell inside a terminal. Nothing here says which of
      // them the user means, and two levels is already as far as the read goes.
      out.reason = "shell-chain";
      return out;
    }
  }

  var argv = isArray(child.argv) ? child.argv : [];
  if (!argv.length || !trim(argv[0])) {
    out.reason = "no-child";
    return out;
  }
  // The same trust question the top-level derivation asks: a one-element argv
  // full of spaces is a RENDERING of an argv, not an argv.
  if (argvLooksNulLess(argv)) {
    out.reason = "unreadable-child";
    return out;
  }

  var title = titleFromArgv0(argv[0]);
  if (!title) {
    out.reason = "unreadable-child";
    return out;
  }

  var words = [shellQuoteArg(trim(own[0])), TERMINAL_TITLE_FLAG + "=" + title];
  // Alacritty and Ghostty reject a bare trailing command; foot and kitty take
  // one. See TERMINAL_FAMILY.
  var execFlag = terminalExecFlag(className);
  if (execFlag) words.push(execFlag);
  for (var i = 0; i < argv.length; i++) words.push(shellQuoteArg(argv[i]));
  out.command = dispatchableCommand(words.join(" "));
  // The title travels only with a command that survived dispatchableCommand.
  // A command the panel refuses to run and a title identity that promises to
  // start it would be a disagreement written into the user's file.
  if (out.command) out.title = title;
  return out;
}

// The words that END the terminal's own argv: everything after one of them
// belongs to the HOSTED command. `-e` is the exec flag TERMINAL_FAMILY records
// for alacritty and ghostty, and `--` is the universal end-of-options marker.
//
// `--hold` is here for a DIFFERENT reason, and the comment that said it "takes
// the command on the terminals that spell it" was simply wrong (tick 3bp): foot,
// kitty and alacritty all document `--hold` as "remain open after the child
// process exits", a plain flag taking no value and hosting nothing. It is kept
// in this list as a deliberately conservative boundary — on foot and kitty a
// hosted command is a BARE trailing word, so it does sit after `--hold` when
// there is one, and stopping here means a `--title` written after `--hold` is
// REFUSED rather than misread as the terminal's own. A lost title is a refusal
// the user can see; a stolen one is a wrong identity in their file.
var TERMINAL_EXEC_BOUNDARIES = ["-e", "--", "--hold"];

function isTerminalExecBoundary(word) {
  for (var i = 0; i < TERMINAL_EXEC_BOUNDARIES.length; i++) {
    if (TERMINAL_EXEC_BOUNDARIES[i] === word) return true;
  }
  return false;
}

// The HOSTED command inside a terminal's own argv — the words that are the
// program, not the terminal — or [] when the terminal was launched with none.
//
// It scans to the same boundaries titleFromOwnArgv does, so the two can never
// disagree about where the terminal's argv ends. They differ on exactly one
// thing, and they have to: what to do with the word after an UNKNOWN flag.
//
// Neither can know which unknown flags take a SEPARATE value — a terminal's
// `--working-directory /x` and its `--fullscreen btop` are the same shape on the
// way in. So each resolves that ambiguity in the direction that is safe FOR ITS
// OWN CALLER, and the claim that early-stopping was "the safe direction for
// every caller here" was false in one of them (tick 3bp):
//
//   titleFromOwnArgv stops at the word and answers "". Its caller writes the
//   answer into a titlePattern, so a lost title is a refusal the user can see
//   and fix, and a stolen one is a wrong identity in their file. Stopping is
//   safe there.
//
//   HERE, stopping is the unsafe direction. The caller is the case-2 gate in
//   terminalTickDerivation, which reads a non-empty answer as "the terminal was
//   launched with a command, so the title on this window is one the TERMINAL
//   set" — and then trusts that title. Stopping reported `foot
//   --working-directory /x` as hosting `/x`, and the gate trusted a title an
//   interactive SHELL had written: `^~/proj$`, matching only while that shell
//   sits in that directory, on an identity whose launch reopens a bare shell.
//   The `=` spelling of the very same flag refuses it (tick q58); the space
//   spelling wrote it.
//
// THE RULE, then: a flag CONSUMES the word after it unless that word is itself
// a flag, or the flag already carries its value with an `=`. `--title herdr` was
// always read that way; every flag is now. The cost is `foot --fullscreen btop`,
// where `btop` really is the hosted command but is consumed as a value and the
// answer comes back [] — one word late, so the gate refuses a window it could
// have named. That is the safe direction for THIS caller: a refusal the panel
// says out loud, rather than a window title trusted on evidence it never had.
function hostedArgvOf(argv) {
  var list = isArray(argv) ? argv : [];
  for (var i = 1; i < list.length; i++) {
    var word = typeof list[i] === "string" ? list[i] : "";
    if (isTerminalExecBoundary(word)) return list.slice(i + 1);
    if (word.charAt(0) !== "-") return list.slice(i);
    if (word.indexOf("=") !== -1) continue;
    var next = typeof list[i + 1] === "string" ? list[i + 1] : "";
    if (next && next.charAt(0) !== "-") i += 1;
  }
  return [];
}

// The value of the terminal's own `--title` flag, or "".
//
// Two spellings, because both are ordinary on a command line and the panel does
// not get to choose how the user launched their terminal:
//
//   foot --title=herdr herdr
//   foot --title herdr herdr
//
// The short forms (`-T`, `-t`) are deliberately NOT read: they mean different
// things to different terminals, and a wrong guess here writes a titlePattern
// that matches nothing. `--title` is the one flag the whole family agrees on,
// and it is the flag this plugin tells the user to use.
//
// The scan STOPS at the terminal's command boundary (tick qkz). It used to run
// to the end of argv, so `alacritty -e watch --title x` handed back `x` — the
// flag of the program the terminal is RUNNING, read as the terminal's own. The
// identity that came out promised a window title alacritty never sets: a
// permanent awaiting-title ghost, and the log affirmed the tick.
//
// Two boundaries, because the family has two shapes. An explicit exec word
// (TERMINAL_EXEC_BOUNDARIES) ends it for alacritty and ghostty; foot and kitty
// take a BARE trailing command (TERMINAL_FAMILY exec ""), so for them the first
// word that is not a flag is the boundary.
//
// The one thing this cannot know is which UNKNOWN flags take a separate value:
// `foot --working-directory /x --title=herdr` stops at `/x` and answers "". That
// is the safe direction on purpose — a lost title is a refusal the user can see
// and fix, a stolen one is a wrong identity written into their file.
function titleFromOwnArgv(argv) {
  var list = isArray(argv) ? argv : [];
  var prefix = TERMINAL_TITLE_FLAG + "=";
  // From 1: argv[0] is the terminal binary, and it is never a flag, so the
  // bare-word boundary below would end the scan on it.
  for (var i = 1; i < list.length; i++) {
    var word = typeof list[i] === "string" ? list[i] : "";
    if (isTerminalExecBoundary(word)) return "";
    if (word.slice(0, prefix.length) === prefix) return trim(word.slice(prefix.length));
    if (word === TERMINAL_TITLE_FLAG && i + 1 < list.length) return trim(list[i + 1]);
    if (word.charAt(0) !== "-") return "";
  }
  return "";
}

// What a TICK should propose for a terminal window — the same answer shape as
// terminalChildDerivation, from the best evidence available rather than from
// the child process alone.
//
// The blocker this fixes (tick gpq): a window ALREADY launched the way the
// README asks — `foot --title=herdr herdr` — has a three-word cmdline, so
// terminalChildDerivation's "only when the terminal's own cmdline says nothing
// but the terminal" test answered "not a terminal question", and the tick fell
// back to the `^foot$` catch-all. The title was sitting on the window the whole
// time, twice over: in the flag that put it there and in the window's own
// `initialTitle`. The README documented that flow as working. It did not.
//
// THE ORDER OF EVIDENCE, strongest first:
//
//   1. the terminal's own `--title=` flag. It is the exact string the window's
//      initialTitle was set from, and the argv it came in is also the exact
//      command that would start the window again.
//   2. the window's `initialTitle`, when the terminal was launched WITH a
//      command of its own (`foot -e btop`, whose title foot sets from the
//      command) and the title is not merely the class. Restricted to that case
//      on purpose: for a BARE terminal an interactive shell may have retitled
//      the window to a working directory before it was mapped, and an identity
//      built on `^~/git/dock-recall$` is junk that happens to match once.
//   3. the single unambiguous child process — terminalChildDerivation, exactly
//      as before, which is the bare-terminal case the whole feature began as.
//
// Cases 1 and 2 name a title the LIVE window already carries, so the identity
// they propose matches it immediately. Case 3 names the title the window WOULD
// carry if it had been launched the plugin's way: the identity is still created
// (human decision 2026-08-19), and the panel says out loud that this window
// will not match until it is relaunched — see awaitingTitleHint.
//
// `reason` is "" for a non-terminal (there is no question here), "not-read"
// when the /proc read has not come back, "no-title" when the terminal's own
// command line names no title and its children could not be asked,
// "unrunnable-command" when the argv that named the title cannot be turned back
// into a runnable command, and otherwise whatever terminalChildDerivation
// refused with.
//
// THE INVARIANT, in both argv cases (tick cjs): a title travels only with a
// command that survived dispatchableCommand — the same rule
// terminalChildDerivation states and holds. It was not held here, and
// `launch: ""` is the schema's NEVER-LAUNCH marker, so a refused command wrote
// a titlePatterns identity that can never be started, as a silent success. A
// refusal is the only honest answer, and this project makes it out loud.
function terminalTickDerivation(className, ownArgv, node, initialTitle) {
  var out = { command: "", title: "", reason: "" };
  if (!isTerminalClass(className)) return out;

  var argv = isArray(ownArgv) ? ownArgv : [];
  if (!argv.length || !trim(argv[0])) {
    out.reason = "not-read";
    return out;
  }

  var flagged = titleFromOwnArgv(argv);
  if (flagged) {
    out.command = launchCommandFromArgv(argv, className);
    if (!out.command) { out.reason = "unrunnable-command"; return out; }
    out.title = flagged;
    return out;
  }

  // Case 2 rests entirely on the terminal having been launched WITH a command
  // of its own: only then did the terminal set the title from that command, and
  // only then is initialTitle evidence rather than whatever an interactive
  // shell renamed the window to. `argv.length > 1` was a proxy for that and it
  // is not one (tick q58) — `foot --working-directory=/x` carries only the
  // terminal's own flags, and `foot fish` hosts a BARE SHELL, which is the
  // wrapper isShellArgv exists to see through, not a command. Both used to
  // write `^~/proj$` as a titlePattern: an identity that matches only while the
  // shell sits in that directory, whose launch reopens a bare shell.
  var hosted = hostedArgvOf(argv);
  var shown = trim(initialTitle);
  if (hosted.length && !isShellArgv(hosted)
      && shown && shown.toLowerCase() !== trim(className).toLowerCase()) {
    out.command = launchCommandFromArgv(argv, className);
    if (!out.command) { out.reason = "unrunnable-command"; return out; }
    out.title = shown;
    return out;
  }

  var child = terminalChildDerivation(className, argv, node);
  if (child.title) return { command: child.command, title: child.title, reason: "" };
  out.reason = child.reason || "no-title";
  return out;
}

// Why a tick REFUSED, or "". The one question the panel asks before toggling,
// so a click that cannot produce a working identity says so instead of writing
// a catch-all. Returns "" for everything that is not a refusal — an ordinary
// class, a terminal that named its app, a tick that is really an untick.
function tickRefusalReason(className, identities, derivation) {
  var proposal = suggestIdentity(className, identities, derivation);
  if (!proposal || !proposal.refusal) return "";
  return String(proposal.refusal);
}

// The refusal, as the sentence the panel shows. "" when there is nothing to say.
//
// Every branch names the SAME way out — the `--title` convention — because that
// is the one thing the user can do that makes the next tick work, and it is the
// convention the identity would have been built on anyway.
function tickRefusalHint(className, reason) {
  var name = trim(className);
  var why = trim(reason);
  if (!name || !why) return "";

  var head = 'Not watching this ' + name + ' window yet: ';
  var body;
  if (why === "already-watched") {
    // The one refusal that is not about a terminal being unreadable, so it gets
    // its own head, its own body and its own tail (tick v5c). The app is not
    // unknown — it is on the list. What is wrong is the WINDOW: it does not
    // match the rule that claims it, which for a terminal means it was started
    // without the title that rule looks for.
    var already = 'This ' + name + ' window is already covered: an app on the watched list claims'
      + ' exactly it, and this particular window does not match that rule.';
    return isTerminalClass(name)
      ? already + ' Relaunch it as ' + name + ' --title=<name> <command> and it will be claimed'
        + ' on sight; ticking it again cannot add anything, because there is nothing to add.'
      : already + " Nothing is added by ticking it again. Check the rule's title patterns"
        + " against this window's title — the state file is hand-editable.";
  }
  if (why === "not-read") {
    body = "the panel is still reading what this terminal is running. Press it again in a moment.";
  } else if (why === "several-children") {
    body = "it is running more than one thing, so which app it is would be a guess.";
  } else if (why === "shell-chain") {
    body = "it is running a shell inside a shell, so which app it is would be a guess.";
  } else if (why === "no-child") {
    body = "it is not running anything yet — just a shell.";
  } else if (why === "unreadable-child") {
    body = "the command line of the program inside it could not be read.";
  } else if (why === "unrunnable-command") {
    // It DID name the app — the refusal is about the command that would bring
    // it back. Saying so is the difference between a user who relaunches the
    // window the documented way and one who presses the tick again forever.
    body = "the command line it was started with cannot be turned into a command that runs.";
  } else {
    body = "nothing about it names the app inside it.";
  }

  var tail = why === "not-read" ? ""
    : ' Relaunch it as ' + name + ' --title=<name> <command> and tick it again.'
      + ' Watching every ' + name + ' window instead is a hand edit of the state file:'
      + ' a class-only identity claims them all and can only ever start one of them.';

  return head + body + tail;
}

// THE AWAITING-TITLE QUESTION, asked once (tick 7qe).
//
// Which watched TITLE identities have a live terminal window of their own class
// on screen and nothing matching them? Two callers want two shapes of the
// answer — awaitingTitleHint wants a sentence, awaitingTitleIndex wants a
// row — and they asked it twice, ~20 lines apart, in code that had drifted
// apart on both of the things it decides:
//
//   THE PATTERN TEST. Both compared `identity.patterns` to a freshly
//   regenerated `derivePattern(className)` by exact string equality, while the
//   MATCHER compiles the pattern case-insensitively (engine.compilePattern). A
//   hand-edited `^Foot$` or `^(foot|footclient)$` — the README invites the hand
//   edit — keeps matching, recording and restoring, and lost only the hint and
//   the row: the one moment the user needs a way back from a mis-tick. So the
//   test is the matcher's, over the same two class fields engine.matchClient
//   reads.
//
//   THE MAPPABILITY RULE. The hint took any live client; the row took only an
//   isMappable one, so a terminal on a SPECIAL workspace got the sentence and no
//   row to undo the tick with. The permissive rule wins: isMappable answers "does
//   this window belong on the MAP", and that is a different question — a
//   scratchpad terminal is on screen, is tickable, and is exactly the shape the
//   README's `--title` advice is most often used for. Nothing here is placed
//   anywhere, so having no slot costs the window nothing.
//
//   THE TERMINAL FILTER, removed here and moved outward (tick s7l, finding A12).
//   This used to drop every non-terminal window, defended by a comment about the
//   ADVICE: a webapp identity whose window is closed is an ordinary not-running
//   app, and telling that user to relaunch with `--title` would be advice about
//   the wrong thing. The comment is right about the advice and was applied to
//   the wrong thing — what the filter removed was the RECOVERY ROW.
//
//   So a hand-authored `^chromium$` + `^Gmail$` (the README invites the hand
//   edit) matched nothing while an ordinary chromium window sat on screen, and
//   had no chip, no row, and no way back except editing the state file: exactly
//   the state tick 1m4 exists to make recoverable, one class of app further out.
//   The candidate now says whether its window is a terminal, and the two places
//   that give advice branch on it. Note what the condition still requires — a
//   LIVE window of the identity's own class. A closed webapp has none, so it
//   stays an ordinary not-running app and nothing here says a word about it.
//
// Returns [{ identity, windows: [{ client, className, isTerminal }] }] — every
// candidate window per identity, in client order, because the row wants the
// first and the hint wants the first whose child process names the identity's
// title.
function awaitingTitleCandidates(clients, identities, resolve) {
  var list = isArray(identities) ? identities : [];
  var live = isArray(clients) ? clients : [];
  var resolver = typeof resolve === "function" ? resolve : function () { return ""; };

  var satisfied = {};
  for (var c = 0; c < live.length; c++) {
    var matched = trim(resolver(live[c]));
    if (matched) satisfied[matched] = true;
  }

  var out = [];
  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;
    var titles = isArray(identity.titlePatterns) ? identity.titlePatterns : [];
    // A class-only identity is not this problem: it already matches its
    // terminal.
    if (!titles.length) continue;
    if (own(satisfied, identity.id)) continue;

    var windows = [];
    for (var w = 0; w < live.length; w++) {
      var client = live[w];
      if (!client) continue;
      var className = trim(client.class) || trim(client.initialClass);
      if (!matchesAnyPattern(client.class, identity.patterns)
          && !matchesAnyPattern(client.initialClass, identity.patterns)) continue;
      // Answered, not filtered on: whether this window is a terminal decides
      // what ADVICE it can be given, and nothing else. See the note above.
      windows.push({
        client: client,
        className: className,
        isTerminal: isTerminalClass(className)
      });
    }
    if (windows.length) out.push({ identity: identity, windows: windows });
  }

  return out;
}

// A watched TITLE identity whose window's class is on screen and which still
// matches nothing, said out loud — with the exact command that fixes it when
// there is one to give.
//
// The human decision behind the terminal half (2026-08-19): when a bare
// terminal hosts one unambiguous app, ticking it still CREATES the identity —
// the derivation is right about what the app is, and the command it built is
// right about how to start it — but the window in front of the user has
// `initialTitle: "foot"` and so matches nothing. No row, no chip, nothing to
// untick, silently missing from the next Record. Creating it and saying nothing
// would be the silent wrong answer this project refuses to ship; refusing to
// create it would throw away a correct derivation. So: create it, and say what
// is missing.
//
// EVIDENCE, not a prediction, in the same spirit as engine.shadowedIdentities:
// the line appears only while a live window of the identity's own class is on
// screen and nothing resolves to the identity, and it CLEARS the moment one
// does — which is exactly what relaunching with `--title` does.
//
// TWO KINDS OF APP, TWO SENTENCES (tick s7l). The `--title` convention is a
// terminal convention, and the relaunch line is only true about a terminal. A
// hand-authored `^chromium$` + `^Gmail$` is in exactly the same situation —
// watched, its class on screen, matching nothing — and the honest thing to say
// about it names its title patterns and the class they are being compared
// against, so the user can look at the two and see which is wrong. It does NOT
// claim a relaunch would fix anything, because for a chromium window it would
// not.
//
// The terminal line still asks for the /proc read (it is what names the app and
// builds the command); the non-terminal one cannot and does not — there is no
// child process to read, and the candidate itself is the whole evidence.
//
// `resolve` is the panel's ONE matcher (engine.matchClient bound to the watched
// list), passed in the way appRows and the map models take it.
function awaitingTitleHint(clients, identities, resolve, argvByPid, procTree) {
  var argvMap = (argvByPid && typeof argvByPid === "object") ? argvByPid : {};
  var tree = (procTree && typeof procTree === "object") ? procTree : {};

  var candidates = awaitingTitleCandidates(clients, identities, resolve);
  var lines = [];
  for (var i = 0; i < candidates.length; i++) {
    var identity = candidates[i].identity;
    var windows = candidates[i].windows;
    var said = false;

    for (var w = 0; w < windows.length && !said; w++) {
      if (!windows[w].isTerminal) continue;
      var className = windows[w].className;
      var client = windows[w].client;
      var pid = (client.pid === undefined || client.pid === null) ? "" : trim(String(client.pid));
      if (!pid) continue;
      var answer = terminalChildDerivation(className, argvMap[pid], tree[pid]);
      if (!answer.title) continue;
      // The MATCHER's question again: would this identity's title patterns claim
      // the title the child process names? A regenerated pattern compared by
      // string equality answered no for every hand edit.
      if (!matchesAnyPattern(answer.title, identity.titlePatterns)) continue;

      var command = trim(identity.launch) || answer.command;
      lines.push('"' + identity.id + '" is watched, but this ' + className
        + ' window was not launched with --title, so nothing matches it yet.'
        + (command ? " Relaunch it as: " + command : ""));
      said = true;
    }
    if (said) continue;

    // The non-terminal sentence. Reached only when no terminal window of this
    // identity produced the line above, so a terminal whose /proc read has not
    // come back yet is not suddenly told the wrong thing — it is told nothing,
    // which is what it was told before.
    for (var n = 0; n < windows.length && !said; n++) {
      if (windows[n].isTerminal) continue;
      lines.push('"' + identity.id + '" is watched, but no ' + windows[n].className
        + ' window on screen matches its title patterns ('
        + titlePatternList(identity.titlePatterns) + '), so nothing matches it yet.');
      said = true;
    }
  }

  return joinLines(lines);
}

// The title patterns as the user would read them back out of the state file.
// Quoted nowhere and joined with commas: this goes inside a parenthesis in a
// sentence, and the patterns carry their own `^…$` punctuation already.
function titlePatternList(patterns) {
  var list = isArray(patterns) ? patterns : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") continue;
    var one = trim(list[i]);
    if (one) out.push(one);
  }
  return out.join(", ");
}

// The same fact the hint states in a sentence, as a set of identity ids — so
// the LIST can carry it too: { identityId: className }.
//
// Why the list needs it (tick 1m4). A title identity created for a bare
// terminal matches no window until that terminal is relaunched with `--title`.
// Until then it has no chip and no row, so pressing the chip again re-ticks
// idempotently instead of unticking, and the only way back from a mis-tick was
// a hand edit of the state file. appRows turns this index into a row that is
// ticked, says why it is not running, and unticks on a click — the recovery.
//
// EVIDENCE, not a prediction, exactly as the hint is: an id appears only while
// a live TERMINAL window of the identity's own class is on screen and nothing
// resolves to the identity, and it is gone the moment a window matches.
//
// The ONE thing the hint asks for and this deliberately does not: the /proc
// read. The row has to survive a panel frame whose cmdline map has not come
// back yet (it is refreshed on every open), and a row that blinks out while the
// user is reaching for it is worse than a row that says one sentence less. What
// the child process is called does not change the answer: the identity is on
// the watched list either way, and either way it matches nothing.
//
// Everything else — which identities are in the question, which windows count,
// and how a pattern is read — is awaitingTitleCandidates, shared with the hint
// so the two can never again disagree about the same fact.
function awaitingTitleIndex(clients, identities, resolve) {
  var candidates = awaitingTitleCandidates(clients, identities, resolve);
  var out = {};
  for (var i = 0; i < candidates.length; i++) {
    out[candidates[i].identity.id] = candidates[i].windows[0].className;
  }
  return out;
}

// The pids of the live TERMINAL windows, in client order and without repeats.
//
// Why the panel reads these at all: a terminal's class says nothing about the
// app inside it, so the child process has to be known BEFORE the click — the
// tick builds its proposal synchronously, from a pure function, at the moment
// the user presses. The ordinary cmdline read only asks about identities that
// already need a launch command, and an unwatched terminal is neither watched
// nor missing anything, so nothing would ever ask about it and every tick
// would fall back to the useless `^foot$`.
//
// Terminals ONLY: reading every window's cmdline would be a /proc walk of the
// whole desktop to answer a question that is asked about four classes.
function terminalPids(clients) {
  var list = isArray(clients) ? clients : [];
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    if (!client || client.pid === undefined || client.pid === null) continue;
    if (!isTerminalClass(trim(client.class)) && !isTerminalClass(trim(client.initialClass))) continue;
    var pid = trim(String(client.pid));
    if (!pid || seen[pid]) continue;
    seen[pid] = true;
    out.push(pid);
  }
  return out;
}

// The live window a tick is about.
//
// A CHIP is one window and carries its address, which is the exact answer. A
// LIST ROW folds every window of an unwatched class onto one line and carries
// the address of the window the row was built from — but a row that predates a
// refresh can name an address that has since closed, and then the class is all
// that is left. Falling back to the first window of that class keeps the tick
// working; it is also why the address is preferred, because for a terminal the
// two windows of one class can host different apps.
function clientForTick(clients, address, className) {
  var list = isArray(clients) ? clients : [];
  var wanted = trim(address);
  var name = trim(className);
  var fallback = null;
  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    if (!client) continue;
    if (wanted && trim(client.address) === wanted) return client;
    if (fallback || !name) continue;
    if (trim(client.class) === name || trim(client.initialClass) === name) fallback = client;
  }
  return fallback;
}

// Is a recorded tick refusal still about a window that EXISTS?
//
// `refusal` is the panel's `refusedTick`: `{ className, address }`, the question
// a refused tick asked rather than the sentence it produced. The panel re-asks
// that question against the live desktop every frame, so a refusal that was
// only "the /proc read has not come back" clears itself the moment it does.
//
// This is the check that re-ask was missing (tick 8rw, finding A10). The re-ask
// resolves its window through clientForTick, which falls back to the first
// window of the same CLASS when the address is gone. That fallback is correct
// for a TICK — a list row can predate a refresh, and the class is all that is
// left to work with — and wrong for a REFUSAL, in two directions:
//
//   - another window of the same class is open: the hint silently re-derives
//     against a window the user never clicked, and reports on it;
//   - no window of that class is left: clientForTick answers null, the
//     derivation is null, the reason stays "not-read", and the panel offers
//     "press it again in a moment" forever about a window that is gone.
//
// So the refusal's own liveness is a separate question with a separate answer.
// An ADDRESS makes it exact: that window, and only that window — and its class
// must still be the one that was refused, because an address can be reused. No
// address (a chip that carried none) makes the class the whole question, and
// then any window of the class is the one it was always about.
function refusalStillLive(clients, refusal) {
  var list = isArray(clients) ? clients : [];
  if (!refusal || typeof refusal !== "object" || isArray(refusal)) return false;
  var name = trim(refusal.className);
  if (!name) return false;
  var wanted = trim(refusal.address);
  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    if (!client) continue;
    var sameClass = trim(client.class) === name || trim(client.initialClass) === name;
    if (wanted) {
      if (trim(client.address) === wanted) return sameClass;
    } else if (sameClass) {
      return true;
    }
  }
  return false;
}

// argv -> a shell command that would start it again, or "".
//
// `className` is the class of the WINDOW the pid was read from, and is used
// only for the browser-family check above; pass "" when there is no window in
// the picture. The structural shared-pid guard lives in launchDerivation, which
// is where the client list is in scope.
function launchCommandFromArgv(argv, className) {
  var list = isArray(argv) ? argv : [];
  var words = [];
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") continue;
    words.push(list[i]);
  }
  if (!words.length || !trim(words[0])) return "";
  if (isBrowserFamilyClass(className)) return "";
  // The separators were lost before this file ever saw them; quoting what is
  // left would write the unrunnable one-word command all over again.
  if (argvLooksNulLess(words)) return "";

  var quoted = [];
  for (var w = 0; w < words.length; w++) quoted.push(shellQuoteArg(words[w]));
  return dispatchableCommand(quoted.join(" "));
}

// ---------------------------------------------------------- the desktop file

// The %-codes a Desktop Entry Exec= line may carry. They stand for the files
// or URLs the entry was invoked with, and this plugin invokes it with none —
// so they are removed rather than substituted. `%%` is a literal percent and
// is the one that must NOT be treated as a code.
var DESKTOP_FIELD_CODES = "fFuUdDnNickvm";

// Exec= -> a runnable command.
//
// The line is left otherwise VERBATIM (see the quoting note above): it is
// already a quoted command line, and `Exec=omarchy-launch-webapp
// "https://mail.google.com/mail/u/0/#inbox"` only works if those double quotes
// reach the shell.
//
// KNOWN LIMIT: runs of spaces left behind by a removed code are collapsed,
// which would also collapse a run of spaces inside a quoted argument. No
// entry on this machine has one, and the alternative is a full Exec parser.
function desktopExecCommand(execLine) {
  var text = trim(execLine);
  if (!text) return "";

  var out = "";
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch !== "%") { out += ch; continue; }
    var next = text.charAt(i + 1);
    if (next === "%") { out += "%"; i += 1; continue; }
    if (next && DESKTOP_FIELD_CODES.indexOf(next) !== -1) { i += 1; continue; }
    out += ch;
  }

  return dispatchableCommand(trim(out.replace(/ {2,}/g, " ")));
}

// Read the [Desktop Entry] group of a .desktop file.
//
// ONLY that group: a file routinely carries [Desktop Action …] groups with
// their own Name= and Exec= (foot.desktop has a "New Terminal" action whose
// Exec is also `foot`), and reading the whole file flat would let an action's
// value shadow the entry's.
function parseDesktopEntry(text) {
  var lines = String(text === undefined || text === null ? "" : text).split("\n");
  var entry = { name: "", exec: "", startupWMClass: "", type: "", hidden: false, icon: "" };
  var inEntry = false;

  for (var i = 0; i < lines.length; i++) {
    var line = trim(lines[i]);
    if (!line || line.charAt(0) === "#") continue;
    if (line.charAt(0) === "[") {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;

    var cut = line.indexOf("=");
    if (cut <= 0) continue;
    // Locale-suffixed keys (Name[de]) name the same field in another language;
    // the plain key is the one this file wants.
    var key = trim(line.slice(0, cut));
    var value = line.slice(cut + 1);
    if (key === "Name" && !entry.name) entry.name = trim(value);
    else if (key === "Exec" && !entry.exec) entry.exec = trim(value);
    else if (key === "StartupWMClass" && !entry.startupWMClass) entry.startupWMClass = trim(value);
    else if (key === "Type" && !entry.type) entry.type = trim(value);
    else if (key === "Hidden") entry.hidden = trim(value).toLowerCase() === "true";
    else if (key === "Icon" && !entry.icon) entry.icon = trim(value);
  }

  return entry;
}

// The window classes a desktop entry claims, in the order they are trusted.
//
// StartupWMClass is the field that EXISTS to answer "which window belongs to
// this launcher", so it comes first. The "chrome-" variant is there because
// Omarchy's webapp entries record the bare host (StartupWMClass=mail.google.com)
// while Chromium synthesizes the window class with its own prefix and a
// per-profile tail (chrome-mail.google.com__mail-Profile_1) — the two halves of
// the same fact, written down in two places.
function desktopClassCandidates(entry) {
  var out = [];
  var wmClass = trim(entry && entry.startupWMClass);
  if (wmClass) {
    out.push(wmClass);
    if (!CHROME_PREFIX.test(wmClass)) out.push("chrome-" + wmClass);
  }
  return out;
}

// ------------------------------------------- strategy 2: the Exec line's URL
//
// WHY THIS EXISTS (user-found, fifth gate test): a webapp entry is allowed to
// declare no StartupWMClass at all. The real file on this machine —
// ~/.local/share/applications/WhatsApp.desktop — is exactly three lines of
// substance:
//
//     Exec=omarchy-launch-webapp https://web.whatsapp.com/
//     Type=Application
//     Icon=whatsapp
//
// while its window arrives as `chrome-web.whatsapp.com__-Profile_1`. Nothing in
// the file names that class, so both strategies above miss and whatsapp's
// launch stayed empty through record, restore and repair alike.
//
// But the file DOES say which host it opens, and Chromium builds the class from
// that same host: `chrome-` + host, dots and all. That is the missing link, and
// it is a fact about Chromium's naming rather than a guess about this app.

// The host of the first http(s) URL in a webapp Exec line, lowercased, or "".
//
// Deliberately NOT "any URL anywhere in any Exec": a text editor whose Exec
// passes a documentation URL is not a webapp, and matching one would hand a
// browser class the wrong launcher. Only the two forms that MEAN "this entry
// opens this site as an app window" are read — Omarchy's own launcher, and
// Chromium's `--app=`.
function urlHost(url) {
  var text = trim(url);
  var scheme = text.indexOf("://");
  if (scheme < 0) return "";
  text = text.slice(scheme + 3);
  var cut = text.search(/[\/?#]/);
  if (cut >= 0) text = text.slice(0, cut);
  // user:pass@host and host:port both leave the host in the middle.
  var at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  var colon = text.indexOf(":");
  if (colon >= 0) text = text.slice(0, colon);
  return text.toLowerCase();
}

function desktopWebappHost(entry) {
  var exec = trim(entry && entry.exec);
  if (!exec) return "";

  // Chromium's own flag, quoted or not.
  var appFlag = exec.match(/--app=["']?(https?:\/\/[^\s"']+)/i);
  if (appFlag) return urlHost(appFlag[1]);

  // Omarchy's launcher, with or without a path in front of it.
  if (/^(\S*\/)?omarchy-launch-webapp(\s|$)/i.test(exec)) {
    var url = exec.match(/(https?:\/\/[^\s"']+)/i);
    if (url) return urlHost(url[1]);
  }
  return "";
}

// The window class Chromium would synthesize for that host: the stem only, so
// it matches the anchored PREFIX pattern derivePattern stores for a webapp
// (`^chrome-web\.whatsapp\.com`). The host's dots are kept — they are part of
// the class.
function desktopWebappClassCandidate(entry) {
  var host = desktopWebappHost(entry);
  return host ? "chrome-" + host : "";
}

// ------------------------------ strategy 3: a StartupWMClass that nearly fits
//
// WHY THIS EXISTS (user-found, fifth gate test): /usr/share/applications/
// obsidian.desktop declares
//
//     StartupWMClass=md.Obsidian
//
// and the window it produces is `md.obsidian.Obsidian`. The packager wrote down
// a shorter reverse-DNS name than the app reports, which exact matching cannot
// bridge — so obsidian never found its own desktop file and kept whatever
// stale command was already in the state file.
//
// The bridge is that both strings are dot-separated token lists naming the same
// app. A declared class is accepted when every one of its tokens appears in the
// window's, case-insensitively, AND the two agree on the LAST token — the one
// that carries the app's own name. The last-token rule is what keeps this from
// becoming a wildcard: `md.Obsidian` matches `md.obsidian.Obsidian`, while a
// desktop file declaring `code` matches nothing of the sort.

function classTokens(text) {
  var parts = String(text === undefined || text === null ? "" : text).toLowerCase().split(".");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var token = trim(parts[i]);
    if (token) out.push(token);
  }
  return out;
}

// A stored pattern that is nothing but an anchored literal -> that literal.
//
// Fuzzy matching compares NAMES, and a pattern is a regex; the only patterns it
// can honestly be run against are the ones derivePattern wrote, which are an
// anchored, escaped class name and nothing else. A pattern carrying a real
// regex construct (a user's hand-written `^(foo|bar)$`) returns "" and is left
// to the exact strategies, where a regex belongs.
function patternLiteral(pattern) {
  var text = trim(pattern);
  if (!text || text.charAt(0) !== "^") return "";
  text = text.slice(1);
  if (text.slice(-1) === "$") text = text.slice(0, -1);

  var out = "";
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch === "\\") {
      var next = text.charAt(i + 1);
      if (!next) return "";
      out += next;
      i += 1;
      continue;
    }
    if ("^$.|?*+()[]{}".indexOf(ch) !== -1) return "";
    out += ch;
  }
  return out;
}

// Does this declared StartupWMClass name the same app as this window class?
function wmClassFuzzyMatches(wmClass, className) {
  var declared = classTokens(wmClass);
  var actual = classTokens(className);
  if (!declared.length || !actual.length) return false;

  var declaredLast = declared[declared.length - 1];
  var actualLast = actual[actual.length - 1];
  // The app's own name has to be the same word in both, and it has to be a
  // word that names an APP: `desktop` in `org.telegram.desktop` is a packaging
  // convention, and letting it carry a match would marry unrelated entries.
  if (declaredLast !== actualLast) return false;
  if (own(GENERIC_TOKENS, actualLast)) return false;

  var have = {};
  for (var a = 0; a < actual.length; a++) have[actual[a]] = true;
  for (var d = 0; d < declared.length; d++) {
    if (!own(have, declared[d])) return false;
  }
  return true;
}

function wmClassFuzzyMatchesAny(wmClass, patterns) {
  if (!trim(wmClass)) return false;
  var list = isArray(patterns) ? patterns : [];
  for (var i = 0; i < list.length; i++) {
    var literal = patternLiteral(list[i]);
    if (literal && wmClassFuzzyMatches(wmClass, literal)) return true;
  }
  return false;
}

// The desktop file's own basename, minus the extension — the last-resort
// candidate, tried only after every StartupWMClass in the set has failed. It is
// a weaker claim (a packager's filename, not a declaration about windows), and
// trying it early would let `gmail.desktop` win a match that
// `StartupWMClass=mail.google.com` should have made.
function desktopBasename(path) {
  var text = trim(path);
  var slash = text.lastIndexOf("/");
  if (slash >= 0) text = text.slice(slash + 1);
  if (text.slice(-8) === ".desktop") text = text.slice(0, -8);
  return text;
}

// Compiled patterns, keyed by their source string — engine.js's COMPILED_PATTERNS
// invariant, restated here because QML's .js imports cannot see each other (see
// the header of this file), and the same paragraph applies word for word: one
// pattern string always compiles to the same regex, the flags are fixed at "i"
// with no /g anywhere (a global regex carries `lastIndex` between calls, and
// sharing one would make `.test` answer differently depending on who asked
// last), a pattern that does not compile caches its `null`, and the "re:" prefix
// keeps a pattern spelled `__proto__` off Object.prototype's members.
//
// It earns its keep here for the same shape of reason it did there: the four
// desktop-file passes call this once per candidate per file per pass, so a
// single iconNameIndex over 158 files recompiled the same handful of patterns
// thousands of times. A memo of a pure function, not a decision.
var COMPILED_PATTERNS = {};

// Compile a stored pattern the way engine.compilePattern does — case
// insensitive, and a typo simply never matches rather than throwing.
function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern) return null;
  var key = "re:" + pattern;
  if (Object.prototype.hasOwnProperty.call(COMPILED_PATTERNS, key)) return COMPILED_PATTERNS[key];
  var compiled = null;
  try {
    compiled = new RegExp(pattern, "i");
  } catch (e) {
    compiled = null;
  }
  COMPILED_PATTERNS[key] = compiled;
  return compiled;
}

function matchesAnyPattern(text, patterns) {
  var value = trim(text);
  if (!value) return false;
  var list = isArray(patterns) ? patterns : [];
  for (var i = 0; i < list.length; i++) {
    var re = compilePattern(list[i]);
    if (re && re.test(value)) return true;
  }
  return false;
}

// Find the launch command for a set of identity patterns among desktop files.
//
// `files` is [{ path, text }] — whatever the caller scraped out of the
// applications directories, in priority order (the user's own overrides
// first). Returns "" when nothing matches, which is the honest answer and
// leaves `launch` empty rather than filling it with a wrong command.
//
// FOUR PASSES, strongest claim first. Every pass runs over ALL the files before
// the next one starts, so a weaker claim can never beat a stronger one just by
// coming earlier in the directory scan:
//
//   1. the declared window class, exactly (StartupWMClass, and its chrome-
//      variant) — the field that exists to answer this question
//   2. the host in a webapp Exec line — a fact about how Chromium names the
//      window it is about to open, for entries that declare no class at all
//   3. the declared window class, fuzzily — the packager wrote a shorter
//      reverse-DNS name than the app reports
//   4. the filename — a packager's choice of filename, not a statement about
//      windows
// The dump, parsed once: [{ path, entry, command }] for every file that could
// describe an application at all.
//
// Split out from launchFromDesktopFiles because the icon lookup below runs the
// SAME four passes and there are now several keys asking per panel frame — one
// per watched identity, one per unwatched class. Re-parsing a hundred desktop
// files for each of them is the difference between a frame and a stutter, so
// the caller parses once and matches many.
//
// `requireCommand` is what keeps launch resolution byte-identical to what it
// was: an entry with no runnable Exec was dropped BEFORE the passes, so a
// strong pass-1 claim on an Exec-less file could never shadow a weaker claim on
// a file that actually launches something. The icon lookup asks for the same
// list without that filter — "which entry is this window's app" is a question a
// file with no Exec can still answer, and an entry with no Icon simply falls
// through to the next pass.
// The parse, memoized on the IDENTITY of the file list.
//
// WHY. `iconNameIndex` is asked from a QML binding on `liveClients`, and
// liveClients is reassigned whenever the text of `hyprctl clients -j` differs —
// which, because that JSON carries window TITLES, is most 2 s ticks on a desk
// where anything is happening. Each re-evaluation reparsed all 158 desktop
// files, on the GUI thread, in the same pass that rebuilds the map: measured at
// 8.4 ms per tick on this machine, ~12 ms on the reviewer's.
//
// THE CACHE INVARIANT: `files` is REPLACED, never edited in place. Every
// producer of it in this project builds a fresh array (desktopFilesFromDump
// returns one, and Panel.qml assigns that whole array to root.desktopFiles), so
// reference equality is a sound answer to "is this the same scan". A caller that
// mutated a file's `text` under a kept reference would get the previous parse;
// do not become that caller. The result is likewise treated as read-only by
// every caller — matchDesktopEntry and the icon lookup only ever read it.
//
// TWO SLOTS, because the two callers disagree on `requireCommand` — launch
// resolution wants entries that can run, the icon lookup wants all of them —
// and a single slot would thrash between them and cache nothing.
var PARSED_DESKTOP_ENTRIES = { withCommand: null, all: null };

function parsedDesktopEntries(files, requireCommand) {
  var slot = requireCommand ? "withCommand" : "all";
  var cached = PARSED_DESKTOP_ENTRIES[slot];
  if (cached && cached.files === files) return cached.parsed;

  var list = isArray(files) ? files : [];
  var parsed = [];

  for (var i = 0; i < list.length; i++) {
    var file = list[i];
    if (!file) continue;
    var entry = parseDesktopEntry(file.text);
    if (entry.hidden) continue;
    if (entry.type && entry.type !== "Application") continue;
    var command = desktopExecCommand(entry.exec);
    if (requireCommand && !command) continue;
    parsed.push({ path: trim(file.path), entry: entry, command: command });
  }

  PARSED_DESKTOP_ENTRIES[slot] = { files: files, parsed: parsed };
  return parsed;
}

// The four passes themselves, over an already-parsed list. Returns the winning
// record, or null. `accept` lets a caller skip a record that matched but has
// nothing to give — the icon lookup passes one, so an entry that claims the
// class but declares no Icon= does not swallow the match and leave the app
// iconless when a weaker file would have named one.
function matchDesktopEntry(patterns, parsed, accept) {
  var list = isArray(parsed) ? parsed : [];
  var wanted = typeof accept === "function" ? accept : function () { return true; };

  // Pass 1: the declared window class, exactly.
  for (var p = 0; p < list.length; p++) {
    if (!wanted(list[p])) continue;
    var candidates = desktopClassCandidates(list[p].entry);
    for (var c = 0; c < candidates.length; c++) {
      if (matchesAnyPattern(candidates[c], patterns)) return list[p];
    }
  }

  // Pass 2: the host of a webapp Exec line.
  for (var u = 0; u < list.length; u++) {
    if (!wanted(list[u])) continue;
    var webapp = desktopWebappClassCandidate(list[u].entry);
    if (webapp && matchesAnyPattern(webapp, patterns)) return list[u];
  }

  // Pass 3: the declared window class, fuzzily.
  for (var f = 0; f < list.length; f++) {
    if (!wanted(list[f])) continue;
    if (wmClassFuzzyMatchesAny(list[f].entry.startupWMClass, patterns)) return list[f];
  }

  // Pass 4: the filename.
  for (var q = 0; q < list.length; q++) {
    if (!wanted(list[q])) continue;
    if (matchesAnyPattern(desktopBasename(list[q].path), patterns)) return list[q];
  }

  return null;
}

function launchFromDesktopFiles(patterns, files) {
  var hit = matchDesktopEntry(patterns, parsedDesktopEntries(files, true), null);
  return hit ? hit.command : "";
}

// The same question asked about a live window rather than a stored identity.
function launchFromDesktopFilesForClass(className, files) {
  var pattern = derivePattern(className);
  if (!pattern) return "";
  return launchFromDesktopFiles([pattern], files);
}

// ------------------------------------------------------------------- icons
//
// The NAME an app's desktop entry gives its icon — "obsidian", "whatsapp", or
// an absolute path. Not a file and not a URL: turning a name into something an
// Image can draw is the shell's job (shell.appLibrary.iconSource), because only
// the shell knows the icon theme, keeps a contextual index that stops "zoom"
// resolving to an action icon, and can fall back to application-x-executable.
// This file stays pure and clock-free; it answers the half that is a fact about
// the desktop files.
//
// "" means no entry claimed this app, or the entry that did declares no Icon=.
// The panel then draws the generic executable icon and reports iconResolved
// false — never an empty source.
function iconNameFromDesktopFiles(patterns, parsed) {
  var hit = matchDesktopEntry(patterns, parsed, function (record) {
    return trim(record && record.entry && record.entry.icon) !== "";
  });
  return hit ? trim(hit.entry.icon) : "";
}

// One lookup table for a whole panel frame: identity ids and window classes to
// icon names.
//
// Keyed the way the callers ask — "id:<identityId>" for a watched identity,
// "class:<className>" for a window that has no identity yet — because a chip or
// a row knows one or the other and a recorded ghost knows only the identity
// (its className is "", there being no window). The two keyspaces are kept
// apart by their prefixes for the same reason appRows keys its rows that way.
//
// An identity is looked up by its own `patterns`, which is what
// launchFromDesktopFiles already uses and therefore what makes the icon come
// from the same entry the launch command did.
// The only thing iconNameIndex reads off a client, as one comparable string.
//
// The index is keyed by window CLASS, and a client list changes far more often
// than the set of classes in it: Panel.qml reassigns `liveClients` whenever the
// text of `hyprctl clients -j` differs, and that JSON carries window TITLES, so
// a browser tab switch is a new array with the same classes in it. This lets the
// panel ask "did the answer's inputs change" instead of "did the input object
// change" — a `string` property notifies only on a different VALUE, where a
// `var` holding a fresh array notifies every time.
//
// Sorted and de-duplicated so the answer is about the SET, not the order
// Hyprland happened to list windows in, and derived from exactly the expression
// iconNameIndex uses below, so the two can never disagree about what a client's
// class is.
function clientClassKey(clients) {
  var list = isArray(clients) ? clients : [];
  var seen = {};
  var names = [];
  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    var className = trim(client && (client.class || client.initialClass));
    // "cls:" for the same reason engine.js prefixes its pattern cache: a window
    // may call itself `__proto__`, and a bare object key would then find
    // Object.prototype's member instead of an absent one.
    if (!className || seen["cls:" + className]) continue;
    seen["cls:" + className] = true;
    names.push(className);
  }
  names.sort();
  return names.join("\n");
}

function iconNameIndex(identities, clients, desktopFiles) {
  var parsed = parsedDesktopEntries(desktopFiles, false);
  var identityList = isArray(identities) ? identities : [];
  var clientList = isArray(clients) ? clients : [];
  var out = {};
  var i;

  for (i = 0; i < identityList.length; i++) {
    var identity = identityList[i];
    var id = trim(identity && identity.id);
    // `undefined` and not a truthiness test: "" is a real answer ("nothing
    // claims this app"), and re-deriving it per duplicate id would be work for
    // the same empty string.
    if (!id || out["id:" + id] !== undefined) continue;
    var patterns = isArray(identity.patterns) ? identity.patterns : [];
    out["id:" + id] = iconNameFromDesktopFiles(patterns, parsed);
  }

  for (i = 0; i < clientList.length; i++) {
    var client = clientList[i];
    var className = trim(client && (client.class || client.initialClass));
    if (!className || out["class:" + className] !== undefined) continue;
    var pattern = derivePattern(className);
    out["class:" + className] = pattern
      ? iconNameFromDesktopFiles([pattern], parsed) : "";
  }

  return out;
}

// The icon name for one chip or one row, off that table. Identity first: a
// watched window's identity is the more specific claim (it can carry
// hand-narrowed patterns and a title axis), and it is the only thing a recorded
// ghost has at all.
function iconNameFor(index, identityId, className) {
  var map = (index && typeof index === "object") ? index : {};
  var id = trim(identityId);
  if (id && trim(map["id:" + id])) return trim(map["id:" + id]);
  var cls = trim(className);
  if (cls && trim(map["class:" + cls])) return trim(map["class:" + cls]);
  return "";
}

// ------------------------------------------------------------- putting it together

// --------------------------------------------------- a launch that cannot run
//
// WHY THIS EXISTS (user-found, fifth gate test): before the quoting rules above
// existed, a derived command was quoted as a WHOLE — the state file on this
// machine carried
//
//     "launch": "'/usr/lib/electron43/electron -disable-gpu --enable-wayland-ime /usr/lib/obsidian/app.asar'"
//
// which is one shell word: a request to execute a program whose FILENAME
// contains spaces and flags. It can never start anything, the launch wait times
// out, and the only symptom the user sees is "no new window appeared at all".
// The fix upstream stopped new ones being written; it did nothing about the
// ones already in people's files, and nothing said they were wrong.
//
// So the panel now recognises the shape and says so. It NEVER rewrites one on
// its own: a launch command is the user's field, and "this looks broken" is a
// diagnosis, not permission to edit. Learn launch and Record — both of them a
// press — are what actually repair it.

// Split a command the way a shell would. Returns null when the text could not
// be a command line at all (an unterminated quote, a trailing backslash).
function shellWords(command) {
  var text = String(command === undefined || command === null ? "" : command);
  var words = [];
  var current = "";
  var started = false;
  var quote = "";

  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (quote) {
      // Inside single quotes nothing is special; inside double quotes only a
      // backslash is, and only in front of a few characters. Close enough for
      // a shape test — this never runs anything.
      if (ch === quote) { quote = ""; continue; }
      if (ch === "\\" && quote === "\"") {
        var escaped = text.charAt(i + 1);
        if (!escaped) return null;
        current += escaped;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") { quote = ch; started = true; continue; }
    if (ch === "\\") {
      var next = text.charAt(i + 1);
      if (!next) return null;
      current += next;
      i += 1;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) { words.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) return null;
  if (started) words.push(current);
  return words;
}

// Does this stored launch command look like it cannot possibly run?
//
// "" is not broken — it is "never launch this one", a legitimate user choice.
// Three shapes are:
//
//   - it could not survive the dispatch at all (`]]`, a control character)
//   - its quoting does not close, so no shell can parse it
//   - it is ONE shell word carrying what is plainly an argument list: the
//     round-trip test, in the only form that matters here — shellQuoteArg of
//     the single word gives the whole command back, so the command IS one
//     quoted word. `/opt/My App/bin/app` is one word with a space too, and is
//     perfectly runnable, so a flag-or-path fragment after the space is
//     required before calling it broken.
function launchLooksBroken(launch) {
  var text = trim(launch);
  if (!text) return false;
  if (!dispatchableCommand(text)) return true;

  var words = shellWords(text);
  if (words === null) return true;
  if (!words.length) return true;
  if (words.length > 1) return false;

  var fragments = words[0].split(/\s+/);
  if (fragments.length < 2) return false;
  for (var i = 1; i < fragments.length; i++) {
    var head = fragments[i].charAt(0);
    if (head === "-" || head === "/") return true;
  }
  return false;
}

// Which identities need a launch command looked at: the ones with none, and
// the ones whose stored command cannot run. "" is a legitimate USER choice
// ("never start this one"), so the first group is not a list of faults — it is
// the list of rows the panel offers to repair and the list Record backfills.
// The second group IS a fault, and one the user cannot see without being told.
function identitiesNeedingLaunch(identities) {
  var list = isArray(identities) ? identities : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;
    if (trim(identity.launch) && !launchLooksBroken(identity.launch)) continue;
    out.push(identity.id);
  }
  return out;
}

// Derive a launch command for each request that has none.
//
//   requests: [{ identityId, patterns, className, argv }]
//     className / argv — the live window this identity currently matches and
//                        the argv read from its pid. Both absent for an app
//                        that is not running, which is the whole reason the
//                        desktop-file half exists.
//     pid              — the pid that argv was read from, so the shared-process
//                        test below can be applied. "" when nothing is running.
//
//   windowsByPid: { "<pid>": <how many live windows that pid owns> }, from
//     windowCountByPid(clients). Optional — without it only the name-based
//     guard is left, which is weaker (see below).
//
// Running window FIRST: the argv is what actually started this app on this
// machine, flags and all, where a desktop file is what a packager thought it
// should be. The fallback runs whenever the argv produced nothing usable.
//
// THREE GUARDS DECIDE WHETHER THE ARGV MAY BE TRUSTED AT ALL:
//
//   1. STRUCTURAL, and the primary one: does any OTHER window share this
//      window's pid? One pid with several windows is a multi-window HOST
//      process, and a host's argv is the argv of whatever created the process
//      — not a description of the window in front of us. That is true of a
//      browser, and equally of `foot --server`/footclient, emacsclient, a
//      single-instance Electron app and kitty's single-instance mode. The
//      test needs no list of names: it reads the shape of the situation off
//      the client list the panel already has.
//
//   2. THE BROWSER-FAMILY NAME LIST (isBrowserFamilyClass), which stays as a
//      backstop for the blind spot in guard 1: when only ONE window of a
//      multi-window host is currently open, nothing is shared YET and the
//      structural test sees an ordinary single-window app. A lone webapp
//      window is exactly that case, and browsers are the known offenders, so
//      they are refused on the name too.
//
//   3. THE CMDLINE SHAPE (argvLooksNulLess), inside launchCommandFromArgv:
//      a reading that came back as ONE element containing spaces never had
//      NUL separators to begin with, so it is a rendering of an argv rather
//      than an argv. Electron apps rewrite their cmdline that way, and neither
//      guard above sees them — they are not browser-family and they own one
//      window. Refused, and the desktop file answers instead.
//
// Returns { commands: { identityId: command }, refusals: { identityId: reason } }.
//
// The REFUSALS are tick dwv's half: a terminal-class window whose app cannot be
// named without guessing yields no command AND no desktop-file fallback. All
// four reasons, which is the whole list terminalChildDerivation can answer
// with: `no-child` (an empty prompt), `several-children` (two things running),
// `shell-chain` (a shell inside a shell) and `unreadable-child` (a child whose
// cmdline came back as a rendering rather than an argv). No fallback, because
// the fallback for a terminal is the terminal — `foot` launches an empty
// prompt, not the app the user recorded, and offering it would be a repair that
// quietly does nothing.
// The identity gets launchState "ambiguous" and a hint pointing at the --title
// convention instead. Nothing here ever WATCHES anything: derivation feeds the
// existing suggest/learn flows and no other.
function launchDerivation(requests, desktopFiles, windowsByPid, procTree) {
  var list = isArray(requests) ? requests : [];
  var tree = (procTree && typeof procTree === "object") ? procTree : {};
  var commands = {};
  var refusals = {};

  for (var i = 0; i < list.length; i++) {
    var request = list[i];
    if (!request || !trim(request.identityId)) continue;
    var identityId = trim(request.identityId);

    // The structural shared-process guard comes FIRST and is unconditional: a
    // pid that owns several windows describes none of them, and that is as true
    // of a terminal server as it is of a browser.
    if (isSharedProcessPid(request.pid, windowsByPid)) {
      var shared = launchFromDesktopFiles(request.patterns, desktopFiles);
      if (shared) commands[identityId] = shared;
      continue;
    }

    // The terminal question, asked before the ordinary derivation because the
    // ordinary derivation's answer for a bare terminal is the terminal.
    var terminal = terminalChildDerivation(request.className, request.argv, tree[trim(request.pid)]);
    if (terminal.command) {
      commands[identityId] = terminal.command;
      continue;
    }
    if (terminal.reason) {
      refusals[identityId] = terminal.reason;
      continue;
    }

    var command = launchCommandFromArgv(request.argv, request.className);
    if (!command) command = launchFromDesktopFiles(request.patterns, desktopFiles);
    if (!command) continue;
    commands[identityId] = command;
  }

  return { commands: commands, refusals: refusals };
}

// What a press would write, per identity: { identityId: command }.
//
// The ONE place that decides whether a stored launch may be replaced, so the
// button's count, the row's offer and the write itself can never disagree.
// Two cases qualify:
//
//   - the field is EMPTY and something was derived — the original repair
//   - the field holds a command that cannot run (launchLooksBroken) and the
//     derivation is a different, runnable one
//
// A non-empty, runnable launch is never touched, on any path. The user may have
// typed it by hand or deliberately narrowed the one this file derived, and a
// backfill that "corrected" it would be a silent edit of their file — the rule
// holds especially when the derived command differs.
function launchRepairIndex(identities, launchMap) {
  var list = isArray(identities) ? identities : [];
  var map = (launchMap && typeof launchMap === "object") ? launchMap : {};
  var out = {};

  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;
    var command = dispatchableCommand(own(map, identity.id));
    if (!command) continue;

    var stored = trim(identity.launch);
    if (!stored) { out[identity.id] = command; continue; }
    if (launchLooksBroken(stored) && command !== stored) out[identity.id] = command;
  }

  return out;
}

// A repaired identity is the SAME identity with ONE field replaced, so it is
// built by copying every field the identity already had rather than by listing
// the fields the schema happens to have today. The enumerated form is what
// dropped `titlePatterns` the moment schema v4 added it (tick h5i): a "Learn
// launch" press on a title-matched app silently destroyed its title matching,
// and the loss only showed up later, when the window stopped being recognized.
// A copy cannot go stale when the schema grows; a field list has to be edited
// every time, and forgetting is exactly this bug.
//
// A fresh object either way — never an in-place edit — because QML bindings
// only notice a reassignment, and writeState drops a byte-identical text.
//
// The copy is SHALLOW, so the returned identity's `patterns` and
// `titlePatterns` arrays are the input's, not clones. That holds only while
// nothing mutates a pattern list in place — nothing does; serializeState
// rebuilds both lists on every write — and a future in-place editor has to
// deep-copy here first.
function identityWithLaunch(identity, command) {
  var out = {};
  for (var key in identity) {
    if (Object.prototype.hasOwnProperty.call(identity, key)) out[key] = identity[key];
  }
  out.launch = command;
  return out;
}

// Apply those repairs. Returns a NEW identity list for StateModel.setIdentities.
function backfillLaunchCommands(identities, launchMap) {
  var list = isArray(identities) ? identities : [];
  var repairs = launchRepairIndex(list, launchMap);
  var out = [];

  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity) continue;
    var command = own(repairs, identity.id);
    if (!command) { out.push(identity); continue; }
    out.push(identityWithLaunch(identity, command));
  }

  return out;
}

// How many identities a "Learn launch" press would actually repair. An identity
// nothing can be derived for is not counted, because a button that claims work
// it cannot do is worse than no button.
function learnableCount(identities, launchMap) {
  var repairs = launchRepairIndex(identities, launchMap);
  var count = 0;
  for (var id in repairs) {
    if (Object.prototype.hasOwnProperty.call(repairs, id)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// The half of the repair that may happen WITHOUT a press (tick i07)
// ---------------------------------------------------------------------------
//
// The bug: ticking an app writes an identity with `launch: ""` INSTANTLY, and
// "" means never start this one. The derivation that could have filled it
// arrives a moment later, from a scan the tick itself kicks off — so a state
// file could sit for the rest of the session with an empty launch for an app
// whose .desktop file was on disk the whole time, and a restore would move the
// app but never reopen it. The user pressed nothing wrong; they pressed the
// only thing there was to press.
//
// So an EMPTY launch may be filled without a press. Nothing else may:
//
//   - a stored command that cannot RUN is still user-pressed only. It is a
//     value the user may have typed, and replacing it behind their back is a
//     silent edit of their file — the "Learn launch" button and the row's own
//     offer are where that repair belongs (launchRepairIndex's second case).
//   - no identity is ever invented. This maps over the identities that already
//     exist; a class nobody ticked stays unticked.
//
// The narrower rule is expressed as a FILTER over launchRepairIndex rather than
// a second copy of it, so the one place that decides whether a stored launch
// may be replaced stays the one place.
function launchAutofillIndex(identities, launchMap) {
  var list = isArray(identities) ? identities : [];
  var repairs = launchRepairIndex(list, launchMap);
  var out = {};

  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;
    if (trim(identity.launch)) continue;
    var command = own(repairs, identity.id);
    if (command) out[identity.id] = command;
  }

  return out;
}

// Apply exactly those. Returns a NEW identity list — or the SAME list object
// when there is nothing to fill, which is the caller's no-op guard: an
// auto-write that fired on every scan of an already-complete file would be a
// write loop against a file the service watches.
function autofillLaunchCommands(identities, launchMap) {
  var list = isArray(identities) ? identities : [];
  var fills = launchAutofillIndex(list, launchMap);
  var any = false;
  for (var id in fills) {
    if (Object.prototype.hasOwnProperty.call(fills, id)) { any = true; break; }
  }
  if (!any) return list;
  return backfillLaunchCommands(list, fills);
}

// The one line the panel logs when it fills something in on its own. Empty when
// nothing was filled, so the caller has a single truthy test for "did anything
// happen" and cannot log a count of zero.
function autofillLaunchLog(fills, source) {
  var map = (fills && typeof fills === "object") ? fills : {};
  var pairs = [];
  for (var id in map) {
    if (Object.prototype.hasOwnProperty.call(map, id) && map[id]) pairs.push(id + " -> " + map[id]);
  }
  if (!pairs.length) return "";
  pairs.sort();
  var where = trim(source);
  return "auto-filled " + pairs.length + " launch command" + (pairs.length === 1 ? "" : "s")
    + (where ? " after the " + where : "") + ": " + pairs.join("; ");
}

// One derivation request, built from an identity and the live window the ONE
// matcher picked for it. Shared by the panel's standing `launchRequests`
// binding and by the just-ticked identity a toggle creates, so a launch derived
// at the moment of the click and one derived a second later come from the same
// shape.
function launchRequestFor(identity, client, argvByPid) {
  if (!identity || typeof identity.id !== "string" || !identity.id) return null;
  var map = (argvByPid && typeof argvByPid === "object") ? argvByPid : {};
  var pid = (client && client.pid !== undefined && client.pid !== null) ? trim(String(client.pid)) : "";
  return {
    identityId: identity.id,
    patterns: identity.patterns,
    className: client ? String(client.class || client.initialClass || "") : "",
    pid: pid,
    argv: (pid && map[pid]) ? map[pid] : null
  };
}

// Which identity a toggle just CREATED, or null when the toggle removed one.
// Compared by id rather than by position, so it does not depend on
// toggleWatchedIdentities prepending.
function addedIdentity(before, after) {
  var had = {};
  var previous = isArray(before) ? before : [];
  for (var i = 0; i < previous.length; i++) {
    if (previous[i] && typeof previous[i].id === "string") had[previous[i].id] = true;
  }

  var list = isArray(after) ? after : [];
  for (var j = 0; j < list.length; j++) {
    var identity = list[j];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;
    if (!own(had, identity.id)) return identity;
  }
  return null;
}

// What a list row should say about an identity's launch command.
//
//   ""           it has a runnable one, or the row is not a watched app
//   "derivable"  empty, and a command is waiting to be written
//   "missing"    empty, and nothing could be derived — the honest dead end,
//                and the one case where the user has to know that Restore
//                cannot bring this app back
//   "broken"     it has one, and that command cannot run. Said whether or not
//                a replacement was derived: a user whose restore does nothing
//                needs to know WHY even when the panel cannot fix it for them.
//   "ambiguous"  empty, and the app runs inside a terminal whose child process
//                does not name it without guessing (tick dwv). NOT the same as
//                "missing": there is something the user can DO about it, and
//                the hint says what — relaunch it with a `--title` of its own.
//                NOT a window class of its own, which is the advice this epic
//                exists to retract: a dedicated class silently loses every
//                class-matched window rule the desktop already has for
//                terminals (README, "Terminal-hosted apps are known by their
//                title"). It outranks "derivable" on purpose: the only thing
//                derivable for a bare terminal is the terminal, and offering to
//                learn that would be a repair that opens an empty prompt.
//
// `refusals` is optional ({ identityId: reason }, from launchDerivation);
// without it this answers exactly what it answered before tick dwv.
function launchStateIndex(identities, launchMap, refusals) {
  var list = isArray(identities) ? identities : [];
  var repairs = launchRepairIndex(list, launchMap);
  var refused = (refusals && typeof refusals === "object") ? refusals : {};
  var out = {};
  for (var i = 0; i < list.length; i++) {
    var identity = list[i];
    if (!identity || typeof identity.id !== "string" || !identity.id) continue;
    if (trim(identity.launch)) {
      if (launchLooksBroken(identity.launch)) out[identity.id] = "broken";
      continue;
    }
    if (own(refused, identity.id)) { out[identity.id] = "ambiguous"; continue; }
    out[identity.id] = own(repairs, identity.id) ? "derivable" : "missing";
  }
  return out;
}

function launchHintFor(launchState) {
  if (launchState === "derivable") return "learn launch";
  if (launchState === "missing") return "no launch cmd";
  if (launchState === "broken") return "launch cmd looks broken";
  // The sentence that points at the convention rather than at the failure: the
  // app is invisible because it shares its terminal's window title, and the fix
  // is to give it one of its own (README, the terminal-hosted apps section).
  if (launchState === "ambiguous") return "runs in a terminal — give it its own --title";
  return "";
}

// ---------------------------------------------------------------------------
// Sectioned command output
// ---------------------------------------------------------------------------
//
// One Process, many files: the panel needs every desktop file's head and every
// watched pid's cmdline, and spawning a Process per file would be dozens of
// them. Instead one `bash -c` loop prints a marker line before each item and
// the pure parser below splits the result back up.
//
// The marker is a fixed prefix rather than a control character because the
// whole pipeline (bash printf, StdioCollector, this parser, a test fixture) is
// text, and a control byte in any of those is a debugging afternoon.

var DUMP_MARKER = "@@mw@@ ";

// text -> [{ header, body }], in the order the producer emitted them.
//
// KNOWN LIMIT: a body line that begins with the marker starts a bogus section.
// Nothing this reads (Desktop Entry keys, argv elements) can plausibly do so.
function parseSectionedDump(text) {
  var lines = String(text === undefined || text === null ? "" : text).split("\n");
  var sections = [];
  var current = null;
  var body = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.slice(0, DUMP_MARKER.length) === DUMP_MARKER) {
      if (current !== null) sections.push({ header: current, body: body.join("\n") });
      current = trim(line.slice(DUMP_MARKER.length));
      body = [];
      continue;
    }
    if (current === null) continue;
    body.push(line);
  }
  if (current !== null) sections.push({ header: current, body: body.join("\n") });

  return sections;
}

// The desktop-file dump -> the [{ path, text }] launchFromDesktopFiles wants.
function desktopFilesFromDump(text) {
  var sections = parseSectionedDump(text);
  var out = [];
  for (var i = 0; i < sections.length; i++) {
    if (!sections[i].header) continue;
    out.push({ path: sections[i].header, text: sections[i].body });
  }
  return out;
}

// The cmdline dump -> { pid: argv }, for the WINDOW pids only.
//
// Since tick dwv the same dump also carries the children of those pids, under
// headers that name the path down to them ("1234/1250"). They are a different
// question and belong to a different reader (procTreeFromDump); a "/" in the
// header is what tells the two apart.
function argvByPidFromDump(text) {
  var sections = parseSectionedDump(text);
  var out = {};
  for (var i = 0; i < sections.length; i++) {
    var pid = trim(sections[i].header);
    if (!pid || pid.indexOf("/") !== -1) continue;
    var argv = parseProcCmdline(sections[i].body);
    if (!argv.length) continue;
    out[pid] = argv;
  }
  return out;
}

// The same dump -> the process TREE under each window pid.
//
//   { "<pid>": { pid, argv, children: { "<childPid>": { pid, argv, children } } } }
//
// The producer emits one section per process, headed by the path of pids from
// the window's own process down to it — "1234", then "1234/1250", then
// "1234/1250/1301" — so the shape is rebuilt here without the reader having to
// know how deep the loop went. A process whose cmdline came back empty (it
// exited between the two reads, or it is a kernel thread) still gets a node:
// it is a child, it counts towards ambiguity, and pretending it is not there
// would be the one direction this must never guess in.
function procTreeFromDump(text) {
  var sections = parseSectionedDump(text);
  var out = {};

  for (var i = 0; i < sections.length; i++) {
    var header = trim(sections[i].header);
    if (!header) continue;
    var parts = header.split("/");
    var cursor = null;
    var broken = false;
    for (var p = 0; p < parts.length; p++) {
      var pid = trim(parts[p]);
      if (!pid) { broken = true; break; }
      var bucket = cursor ? cursor.children : out;
      if (!bucket[pid]) bucket[pid] = { pid: pid, argv: [], children: {} };
      cursor = bucket[pid];
    }
    if (broken || !cursor) continue;
    var argv = parseProcCmdline(sections[i].body);
    if (argv.length) cursor.argv = argv;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The map: monitors to scale
// ---------------------------------------------------------------------------

// Does this transform turn the monitor on its side?
//
// hyprctl reports `transform` as a wl_output_transform: 0/2 are upright and
// upside down, 4/6 are the flipped versions of those, and the ODD values
// (1 = 90°, 3 = 270°, 5 and 7 their flipped twins) are the quarter turns. Only
// the quarter turns change which axis is which.
function isRotated(monitor) {
  var transform = Number(monitor && monitor.transform);
  if (!isFinite(transform)) return false;
  return Math.abs(Math.round(transform)) % 2 === 1;
}

// Hyprland reports a monitor's pixel mode plus its scale factor; the LOGICAL
// size (what the layout is arranged in, and what x/y are expressed in) is the
// mode divided by the scale. Using the raw mode would draw a 2x HiDPI laptop
// twice its real estate and put every neighbour in the wrong place.
//
// The mode is reported UNTRANSFORMED — a portrait 1080x1920 desk monitor is
// still "width 1920, height 1080" with transform 1 — so a rotated monitor has
// to have its axes swapped here. Without the swap the map drew a portrait
// screen as a landscape one, which is the one thing a picture of a desk cannot
// get wrong, and every neighbour to its right was placed against a span that
// did not exist.
function logicalSize(monitor) {
  var scale = Number(monitor && monitor.scale);
  if (!isFinite(scale) || scale <= 0) scale = 1;
  var width = Number(monitor && monitor.width);
  var height = Number(monitor && monitor.height);
  if (!isFinite(width) || width <= 0) width = 1920 * scale;
  if (!isFinite(height) || height <= 0) height = 1080 * scale;
  if (isRotated(monitor)) {
    var swap = width;
    width = height;
    height = swap;
  }
  return { width: Math.round(width / scale), height: Math.round(height / scale) };
}

// The monitor as a rectangle in LAYOUT space: where it starts, and how big it
// is once scale and rotation have been applied. This is the frame every window
// on that monitor is measured against — `client.at` is global, and the only way
// back to "where in this screen" is to subtract this origin and divide by this
// size.
//
// x/y default to 0 for the same reason mapGeometry's did: a monitor list from a
// mock or a half-written read must place its windows somewhere sane rather than
// producing NaN fractions that QML silently draws at the origin.
function logicalRect(monitor) {
  var size = logicalSize(monitor);
  var x = Number(monitor && monitor.x);
  var y = Number(monitor && monitor.y);
  if (!isFinite(x)) x = 0;
  if (!isFinite(y)) y = 0;
  return { x: x, y: y, width: size.width, height: size.height };
}

// The engine's geometryPair, re-implemented rather than imported.
//
// PanelModel cannot import engine.js (both files are loaded standalone by QML's
// `import "x.js" as X`, which gives them no module system to share), so the
// coercion is duplicated on purpose and must stay in step: a finite pair of
// numbers, strings coerced, anything else null. A recording made before schema
// v2 has null here, and so does a hyprctl read that came back without the
// field — and "null" has to mean the same thing on both sides or the live map
// and the recorded map would disagree about which windows can be drawn to
// scale.
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

// One window's place inside its monitor, as FRACTIONS of that monitor: rx/ry
// are the top-left, rw/rh the size, all in 0..1.
//
// Fractions rather than pixels because the panel decides how big a workspace
// box is (it depends on the card width, the number of monitors, the theme's
// text size) and that decision must not travel into the model. A window that
// covers the left half of a screen is `{ rx: 0, rw: 0.5 }` whatever the map is
// drawn at.
//
// `at` is GLOBAL layout space — a window on the second monitor of a side-by-side
// pair has an x of 1920-something — so the monitor's own origin comes off first.
// Getting this wrong does not look like a rounding error: every window on every
// monitor but the leftmost lands outside its own box.
//
// Windows that hang off the edge (a floating window dragged half off-screen, a
// stale read taken mid-move) are CROPPED to the box rather than dropped: the
// map is a picture of where things are, and a window that is mostly on this
// screen belongs on this screen. A window with no area left after cropping has
// nothing to draw and falls back with the null-geometry ones.
function windowRect(at, size, rect) {
  var origin = geometryPair(at);
  var extent = geometryPair(size);
  if (!origin || !extent) return null;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;

  var rx = (origin[0] - rect.x) / rect.width;
  var ry = (origin[1] - rect.y) / rect.height;
  var rw = extent[0] / rect.width;
  var rh = extent[1] / rect.height;
  if (!isFinite(rx) || !isFinite(ry) || !isFinite(rw) || !isFinite(rh)) return null;

  // Crop, in both directions. Trimming the near edge moves the origin AND
  // shortens the span; trimming the far edge only shortens it.
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  if (rx > 1) rx = 1;
  if (ry > 1) ry = 1;
  if (rx + rw > 1) rw = 1 - rx;
  if (ry + rh > 1) rh = 1 - ry;
  if (!(rw > 0) || !(rh > 0)) return null;

  return { rx: rx, ry: ry, rw: rw, rh: rh };
}

// Place every monitor inside `targetWidth` x `targetHeight`, preserving the
// real arrangement and one shared scale factor — the map is only worth having
// if a 34" ultrawide next to a laptop LOOKS like a 34" ultrawide next to a
// laptop.
//
// Disabled monitors are dropped: they occupy no space in the layout, and
// Hyprland parks them all at 0,0, which would pile them on top of the real
// ones. They still count towards the topology KEY (see engine.topologyKey);
// this is only about what gets drawn.
//
// The scaled box.x/y/width/height and the returned scale/width/height below
// are vestigial for drawing purposes since the workspace-grid repair (see the
// big comment above this section): Panel.qml's map now sizes monitor
// sections by workspace count and logical width (workspaceGridLayout,
// monitorSectionWidths), and reads only logicalWidth/logicalHeight/sizeLabel/
// name/label/workspaces off each box, never the scaled fields. They stay
// because this function still does two things nothing else does — `label`
// is what recordedMapModel groups a recorded app's monitor onto, and the
// sort below is the map's left-to-right order that other code (and
// mapCanvas.sectionWidths' comment, Panel.qml) leans on — and because
// tests/panel.test.js exercises the scale/x/y/width/height directly ("monitors
// are placed to scale in their real arrangement" and neighbours). Trimming
// the scaled fields would mean rewriting those tests around a shape they no
// longer have any reason to describe, for a computation that costs nothing
// this function isn't already doing.
function mapGeometry(monitors, targetWidth, targetHeight) {
  var list = isArray(monitors) ? monitors : [];
  var boxes = [];
  var minX = null, minY = null, maxX = null, maxY = null;

  for (var i = 0; i < list.length; i++) {
    var monitor = list[i];
    if (!monitor) continue;
    if (monitor.disabled === true) continue;
    var rect = logicalRect(monitor);
    var size = { width: rect.width, height: rect.height };
    var x = rect.x;
    var y = rect.y;

    boxes.push({
      id: monitor.id,
      name: trim(monitor.name),
      label: trim(monitor.description) || trim(monitor.name),
      focused: monitor.focused === true,
      logicalWidth: size.width,
      logicalHeight: size.height,
      realX: x,
      realY: y
    });

    if (minX === null || x < minX) minX = x;
    if (minY === null || y < minY) minY = y;
    if (maxX === null || x + size.width > maxX) maxX = x + size.width;
    if (maxY === null || y + size.height > maxY) maxY = y + size.height;
  }

  if (!boxes.length) return { scale: 1, width: 0, height: 0, monitors: [] };

  var spanX = Math.max(1, maxX - minX);
  var spanY = Math.max(1, maxY - minY);
  var availableWidth = Number(targetWidth) > 0 ? Number(targetWidth) : spanX;
  var availableHeight = Number(targetHeight) > 0 ? Number(targetHeight) : spanY;
  var scale = Math.min(availableWidth / spanX, availableHeight / spanY);
  if (!isFinite(scale) || scale <= 0) scale = 1;

  for (var b = 0; b < boxes.length; b++) {
    var box = boxes[b];
    box.x = Math.round((box.realX - minX) * scale);
    box.y = Math.round((box.realY - minY) * scale);
    box.width = Math.max(1, Math.round(box.logicalWidth * scale));
    box.height = Math.max(1, Math.round(box.logicalHeight * scale));
    box.sizeLabel = box.logicalWidth + "×" + box.logicalHeight;
  }

  // Left to right, then top to bottom: the order the user's eye reads them in,
  // which is not the order hyprctl lists them in (that follows connection
  // sequence and renumbers across a hotplug).
  boxes.sort(function (a, b2) {
    if (a.realX !== b2.realX) return a.realX - b2.realX;
    return a.realY - b2.realY;
  });

  return {
    scale: scale,
    width: Math.round(spanX * scale),
    height: Math.round(spanY * scale),
    monitors: boxes
  };
}

// ---------------------------------------------------------------------------
// The map's layout: how big a workspace box is, and where a chip lands in it
// ---------------------------------------------------------------------------
//
// Why this exists at all: the map used to be ONE scaled picture of the desk —
// every monitor at its true size, every workspace a column inside it, the whole
// thing squeezed into a fixed 150-unit height. Live verification on a 1440×900
// laptop with 7 occupied workspaces (docs/evidence/increment-03/m9u) showed what
// that costs at real workspace counts: the fixed height bound the scale, so 70 %
// of the map's WIDTH sat empty; each workspace came out ~42×86 — PORTRAIT, for a
// 16:10 screen; and every chip hit its minimum width, so a 98 %-of-the-screen
// window and a 49 % one were drawn the same size and two side-by-side tiles were
// drawn one on top of the other.
//
// The trade this section makes, deliberately: a WORKSPACE box is uniform and
// readable (one mini-monitor at the monitor's aspect, wrapped into rows) rather
// than a to-scale slice of a to-scale monitor. Monitors keep their real
// left-to-right order and their relative widths, so the picture still says which
// screen is the big one — but inside a monitor, being able to READ a workspace
// wins over being able to measure it against its neighbour.

// A workspace box narrower than this cannot show two windows side by side, which
// is the least a map of a tiling desktop has to be able to say.
var MAP_BOX_MIN_WIDTH = 96;
// And past this a lone workspace on a wide panel becomes a poster rather than a
// map; it is also what keeps the map's HEIGHT (boxes × rows) bounded.
var MAP_BOX_MAX_WIDTH = 220;
var MAP_BOX_GAP = 6;
// A monitor section has to hold one readable box plus its own border padding.
var MAP_SECTION_MIN_WIDTH = 112;

// The chip floor, in pixels. Small enough that a half-width window still reads
// as half a box on the smallest box we draw (96 px → 48 px, three times the
// floor) — the old floor was 24 SPACING UNITS, which on a 37 px canvas clamped
// every chip to the full width of its workspace.
var CHIP_MIN_WIDTH = 16;
var CHIP_MIN_HEIGHT = 10;

function positiveOr(value, fallback) {
  var n = Number(value);
  return (isFinite(n) && n > 0) ? n : fallback;
}

// How big is one workspace box, and how do `wsCount` of them pack into
// `availableWidth`?
//
// `monitorAspect` is the MONITOR's width/height — a workspace fills its monitor,
// so anything else draws every window inside it at the wrong proportions.
//
// The column count is balanced rather than greedy: 7 boxes into a strip that
// holds 5 would leave a row of 5 and a row of 2, so the rows are counted first
// (2) and the columns derived from that (4). Same number of rows, bigger boxes,
// and a rectangle instead of a staircase.
function workspaceGridLayout(wsCount, monitorAspect, availableWidth, gap, minWidth, maxWidth) {
  var count = Math.round(Number(wsCount));
  if (!isFinite(count) || count <= 0) return { boxW: 0, boxH: 0, cols: 0, rows: 0 };

  var aspect = positiveOr(monitorAspect, 16 / 9);
  var g = positiveOr(gap, MAP_BOX_GAP);
  var minW = positiveOr(minWidth, MAP_BOX_MIN_WIDTH);
  var maxW = positiveOr(maxWidth, MAP_BOX_MAX_WIDTH);
  if (maxW < minW) maxW = minW;
  var width = positiveOr(availableWidth, minW);

  // How many boxes at the readable minimum fit across? At least one — a panel
  // too narrow for even that gets one box at whatever width there is, which is
  // honest, where a box drawn wider than its container is not.
  var maxCols = Math.floor((width + g) / (minW + g));
  if (maxCols < 1) maxCols = 1;
  if (maxCols > count) maxCols = count;

  var rows = Math.ceil(count / maxCols);
  var cols = Math.ceil(count / rows);

  var boxW = Math.floor((width - g * (cols - 1)) / cols);
  if (boxW > maxW) boxW = maxW;
  if (boxW < 1) boxW = 1;

  return {
    boxW: boxW,
    boxH: Math.max(1, Math.round(boxW / aspect)),
    cols: cols,
    rows: rows
  };
}

// Split `availableWidth` between the monitor sections, left to right.
//
// Proportional to the monitors' logical widths — a 34" ultrawide next to a
// laptop still gets the bigger half — but floored, because a section too narrow
// for one workspace box says nothing at all. When even the floor does not fit
// (three monitors on a phone-width panel), everyone gets an equal share and the
// boxes inside shrink: an unreadable section for the small monitor is not more
// honest than an evenly split row.
function monitorSectionWidths(widths, availableWidth, gap, minWidth) {
  var list = isArray(widths) ? widths : [];
  var n = list.length;
  if (!n) return [];

  var g = positiveOr(gap, MAP_BOX_GAP);
  var minW = positiveOr(minWidth, MAP_SECTION_MIN_WIDTH);
  var total = positiveOr(availableWidth, n) - g * (n - 1);
  if (total < n) total = n;

  var vals = [];
  var i;
  for (i = 0; i < n; i++) vals.push(positiveOr(list[i], 1));

  var out = [];
  if (total < n * minW) {
    for (i = 0; i < n; i++) out.push(total / n);
  } else {
    // Anyone the proportional split would put under the floor is pinned there
    // and taken out of the pool; pinning one can push the next one under, so
    // this repeats until nobody moves (at most n rounds).
    var pinned = [];
    for (i = 0; i < n; i++) pinned.push(false);
    var changed = true;
    var pool, freeSum;
    while (changed) {
      changed = false;
      pool = total;
      freeSum = 0;
      for (i = 0; i < n; i++) {
        if (pinned[i]) pool -= minW;
        else freeSum += vals[i];
      }
      for (i = 0; i < n; i++) {
        if (pinned[i] || freeSum <= 0) continue;
        if (pool * vals[i] / freeSum < minW) { pinned[i] = true; changed = true; break; }
      }
    }
    for (i = 0; i < n; i++) {
      out.push(pinned[i] || freeSum <= 0 ? minW : pool * vals[i] / freeSum);
    }
  }

  // Round down, then hand the leftover pixels to the widest remainders, so the
  // sections add up to exactly what was available instead of leaving a ragged
  // gap at the right edge.
  var rounded = [];
  var used = 0;
  for (i = 0; i < n; i++) {
    var floored = Math.max(1, Math.floor(out[i]));
    rounded.push(floored);
    used += floored;
  }
  var spare = Math.floor(total) - used;
  var order = [];
  for (i = 0; i < n; i++) order.push({ index: i, frac: out[i] - Math.floor(out[i]) });
  order.sort(function (a, b) { return b.frac - a.frac; });
  for (i = 0; spare > 0 && i < order.length; i++) { rounded[order[i].index] += 1; spare -= 1; }
  return rounded;
}

// One workspace's chips, resolved from 0..1 fractions to whole pixels on a
// canvas — floors applied, and NEVER at the price of drawing two separate
// windows on top of each other.
//
// The floor is what makes a tiny window clickable; the barrier below is what
// stops the floor lying. For every pair of rects that do NOT overlap on the real
// screen, the axis they are furthest apart on gets a barrier at the MIDPOINT of
// the gap between them: each may grow towards the other, neither may cross. Two
// rects that grow into the same gap therefore meet, at worst, exactly — and two
// windows that really do overlap (a float over a tile) still overlap, because
// the map is a picture of the screen and that is what the screen looks like.
//
// `rects` is one entry per slot: either the `{ rx, ry, rw, rh }` fraction rect
// itself, or the SLOT that carries one as `.rect` (which is what the map model
// hands the panel, so the caller does not have to unpack it). The answer is
// index-for-index, null where the input had no rect to place.
function chipRectsForCanvas(rects, canvasWidth, canvasHeight, minWidth, minHeight) {
  var list = isArray(rects) ? rects : [];
  var n = list.length;
  var W = Math.max(1, positiveOr(canvasWidth, 1));
  var H = Math.max(1, positiveOr(canvasHeight, 1));
  var minW = Math.min(W, positiveOr(minWidth, CHIP_MIN_WIDTH));
  var minH = Math.min(H, positiveOr(minHeight, CHIP_MIN_HEIGHT));

  var raw = [];
  var limit = [];
  var i, j;
  for (i = 0; i < n; i++) {
    var r = list[i];
    if (r && r.rect !== undefined) r = r.rect;
    if (!r) { raw.push(null); limit.push(null); continue; }
    var left = Number(r.rx) * W;
    var top = Number(r.ry) * H;
    var w = Number(r.rw) * W;
    var h = Number(r.rh) * H;
    if (!isFinite(left) || !isFinite(top) || !isFinite(w) || !isFinite(h)) { raw.push(null); limit.push(null); continue; }
    if (left < 0) { w += left; left = 0; }
    if (top < 0) { h += top; top = 0; }
    if (left > W) left = W;
    if (top > H) top = H;
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    if (left + w > W) w = W - left;
    if (top + h > H) h = H - top;
    raw.push({ left: left, top: top, right: left + w, bottom: top + h });
    limit.push({ left: 0, top: 0, right: W, bottom: H });
  }

  for (i = 0; i < n; i++) {
    if (!raw[i]) continue;
    for (j = i + 1; j < n; j++) {
      if (!raw[j]) continue;
      var a = raw[i];
      var b = raw[j];

      // Which way round are they, and how far apart? null on an axis means they
      // share it — two tiles side by side share their vertical extent.
      var gapX = null, leftIdx = i, rightIdx = j;
      if (a.right <= b.left) gapX = b.left - a.right;
      else if (b.right <= a.left) { gapX = a.left - b.right; leftIdx = j; rightIdx = i; }
      var gapY = null, topIdx = i, bottomIdx = j;
      if (a.bottom <= b.top) gapY = b.top - a.bottom;
      else if (b.bottom <= a.top) { gapY = a.top - b.bottom; topIdx = j; bottomIdx = i; }

      // Genuinely overlapping on the screen: nothing to separate.
      if (gapX === null && gapY === null) continue;

      if (gapY === null || (gapX !== null && gapX >= gapY)) {
        var midX = (raw[leftIdx].right + raw[rightIdx].left) / 2;
        if (midX < limit[leftIdx].right) limit[leftIdx].right = midX;
        if (midX > limit[rightIdx].left) limit[rightIdx].left = midX;
      } else {
        var midY = (raw[topIdx].bottom + raw[bottomIdx].top) / 2;
        if (midY < limit[topIdx].bottom) limit[topIdx].bottom = midY;
        if (midY > limit[bottomIdx].top) limit[bottomIdx].top = midY;
      }
    }
  }

  var out = [];
  for (i = 0; i < n; i++) {
    if (!raw[i]) { out.push(null); continue; }
    var box = raw[i];
    var lim = limit[i];
    var span = resolveSpan(box.left, box.right, lim.left, lim.right, minW);
    var run = resolveSpan(box.top, box.bottom, lim.top, lim.bottom, minH);
    out.push({ x: span.start, y: run.start, width: span.size, height: run.size });
  }
  return out;
}

// One axis of the above: grow `[from, to]` to at least `want`, forwards first
// and backwards with the remainder, never past the barriers — which are never
// inside the rect itself, so the real extent always survives.
function resolveSpan(from, to, lowLimit, highLimit, want) {
  var start = from;
  var end = Math.max(to, from + want);
  if (end > highLimit) {
    var overflow = end - highLimit;
    end = highLimit;
    start = Math.max(lowLimit, start - overflow);
  }
  if (start < lowLimit) start = lowLimit;
  var a = Math.round(start);
  var b = Math.round(end);
  return { start: a, size: Math.max(1, b - a) };
}

// Cutoffs for chipTreatment, human-ratified against actual rendered chips
// rather than derived from any formula — hence named constants, the same way
// CHIP_MIN_WIDTH/CHIP_MIN_HEIGHT are, instead of literals buried in the function.
var CHIP_PILL_MIN_WIDTH = 140;
var CHIP_PILL_MIN_HEIGHT = 56;
var CHIP_BADGE_MIN_WIDTH = 56;
var CHIP_BADGE_MIN_HEIGHT = 40;
var CHIP_VEILED_MIN_WIDTH = 24;
var CHIP_VEILED_MIN_HEIGHT = 16;

// The STRIP tier, and it deliberately introduces no number of its own — it is
// the pill's ratified width paired with the veiled tier's ratified height.
//
// The four cutoffs above were ratified against POSITIONED chips, which are
// window-shaped: a chip is its window's rectangle scaled into a box that has
// the monitor's aspect, so width and height rise together and demanding both
// axes is right. The fallback stacked path draws a different shape on purpose —
// one canvas-wide row per app, a fixed 17 px tall — and it is the one geometry
// where the both-axes rule gives the wrong answer: such a row can never clear
// the badge's 40 px height however wide the map gets, so every app on the
// Recorded tab was a nameless icon under a 55% veil.
//
// The rule that rescues it, and nothing else: a chip has room for a WORD ACROSS
// (CHIP_PILL_MIN_WIDTH — the width at which a name was ratified to fit beside
// an icon) and room for ONE LINE DOWN (CHIP_VEILED_MIN_HEIGHT — the ladder's
// own floor for "there is something to see here at all", and one line of
// caption text) draws its name, on a single line, without the pill's vertical
// padding.
var CHIP_STRIP_MIN_WIDTH = CHIP_PILL_MIN_WIDTH;
var CHIP_STRIP_MIN_HEIGHT = CHIP_VEILED_MIN_HEIGHT;

// Which of five drawings a chip earns, from its actual DRAWN pixel size.
//
// STANDALONE on purpose: this takes the chip's size AFTER chipRectsForCanvas
// (or whatever else placed it) has already decided it, rather than being baked
// into chipFor()'s output or into chipRectsForCanvas itself. Panel.qml has two
// render paths — the canvas one, which calls chipRectsForCanvas, and a fallback
// stacked path that never does — and a treatment carried on the model would be
// silently absent on the second path. Asking at draw time is correct on both.
// It is still a pure function of (width, height): it knows nothing about which
// path drew the chip, and the strip tier below is a SHAPE, not a path.
//
// Both axes must clear a tier's cutoffs together: a chip wide enough for "pill"
// but too short is a "badge", not a pill stretched thin.
//
// The strip is asked LAST of the drawing tiers — after pill and after badge —
// and that ordering is the whole of its safety. Every size that reached "pill"
// or "badge" before still reaches it, because those two branches are untouched
// and are tested first; the strip can only ever rescue a size the badge tier
// REJECTED, which given w >= 140 means h < 40. So a strip is always wider than
// 140 and shorter than 40 — the short-and-wide corner, and nothing else.
function chipTreatment(width, height) {
  var w = Number(width);
  var h = Number(height);
  if (!isFinite(w) || !isFinite(h)) return "field";
  if (w >= CHIP_PILL_MIN_WIDTH && h >= CHIP_PILL_MIN_HEIGHT) return "pill";
  if (w >= CHIP_BADGE_MIN_WIDTH && h >= CHIP_BADGE_MIN_HEIGHT) return "badge";
  if (w >= CHIP_STRIP_MIN_WIDTH && h >= CHIP_STRIP_MIN_HEIGHT) return "strip";
  if (w >= CHIP_VEILED_MIN_WIDTH && h >= CHIP_VEILED_MIN_HEIGHT) return "veiled";
  return "field";
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

// Index a drift report by identity id, so a chip can ask about itself in
// constant time instead of the map being quadratic in app count.
function driftIndex(driftReport) {
  var index = {};
  var apps = (driftReport && isArray(driftReport.apps)) ? driftReport.apps : [];
  for (var i = 0; i < apps.length; i++) {
    if (apps[i] && typeof apps[i].identityId === "string") index[apps[i].identityId] = apps[i];
  }
  return index;
}

// ---------------------------------------------------------------------------
// Instances: one identity, several windows (schema v3)
// ---------------------------------------------------------------------------
//
// An identity used to be a row and a chip's name. Since schema v3 a recording
// can name several windows of one app, and the panel has to be able to say
// which of them it means — "Gmail (2) is on the wrong workspace" — without
// changing a single byte of what it says about the app that has one window,
// which is nearly all of them.
//
// Three things have to agree for hover to work: the row's linkKey, the live
// chip's linkKey and the recorded chip's linkKey. They are all built from the
// SAME index, computed once per panel frame and passed in, because computing it
// three times from three different inputs is how they would drift apart.

// A recorded occurrence as a number: a non-negative integer, 0 for anything
// else. The twin of engine.occurrenceOf and StateModel.normalizeOccurrence —
// this file may not require either (see the header), so the agreement is pinned
// by a test.
function occurrenceOf(value) {
  var n = value;
  if (typeof n === "string") {
    var trimmed = trim(n);
    n = trimmed ? Number(trimmed) : NaN;
  }
  if (typeof n !== "number" || !isFinite(n)) return 0;
  if (n < 0) return 0;
  if (Math.floor(n) !== n) return 0;
  return n;
}

// The key an INTERNAL map uses for one (identityId, occurrence). NUL-joined
// rather than "#"-joined so it can never collide with a user-chosen identity id
// that happens to contain a "#" — and spelled as an escape, never as a literal
// byte, for the reason planRestore's wsKey states (a literal NUL makes the whole
// file "binary" to grep).
function occurrenceKey(identityId, occurrence) {
  return trim(identityId) + "\u0000" + occurrenceOf(occurrence);
}

// The key a ROW uses, and the one that is user-facing through linkKey. An
// identity with ONE window is spelled by its bare id — no "#0" anywhere — so
// every key, linkKey and cursor position on a single-window desktop is
// byte-identical to what it was before instances existed.
function instanceKeyFor(identityId, occurrence, instances) {
  var id = trim(identityId);
  if (!instances || instances <= 1) return id;
  return id + "#" + occurrenceOf(occurrence);
}

// The hover link key for one instance of one identity. Unwatched windows have
// no identity and no instances; they keep the class key they always had.
function instanceLinkKeyFor(identityId, className, occurrence, instances) {
  var id = trim(identityId);
  if (!id) return linkKeyFor(id, className);
  return "id:" + instanceKeyFor(id, occurrence, instances);
}

// "Gmail (2)" — the name a row or chip shows for one instance. `index` is the
// 0-based position of this instance among the identity's rows, so the marker
// counts what the user can see rather than the recorded occurrence, which is a
// label and may have holes.
function instanceNameFor(identityId, index, instances) {
  var base = titleCase(identityId);
  if (!instances || instances <= 1) return base;
  return base + " (" + ((index || 0) + 1) + ")";
}

// Every window this panel can talk about, indexed by which INSTANCE of its
// identity it is.
//
//   { byAddress:  { address: { identityId, occurrence, index, instances } },
//     byIdentity: { identityId: { order: [occurrence…], instances,
//                                 addressByOccurrence: { occurrence: address },
//                                 recordedByOccurrence: { occurrence: app } } } }
//
// An instance exists if the identity has a window RUNNING at that occurrence or
// a placement RECORDED at it — "recorded-or-running", which is what makes a
// closed second window keep its own ghost row instead of vanishing into the
// first one's.
//
// Occurrences come from the drift report where it has them, because that report
// is the output of the engine's matcher and is the only thing that knows which
// live window is which recorded one. Windows the report does not mention (an
// unrecorded second terminal, or any window at all when nothing is recorded) are
// numbered around the matched ones in the panel's own placement order.
function instanceIndex(clients, monitors, resolve, driftReport, layout) {
  var resolver = typeof resolve === "function" ? resolve : function () { return ""; };
  var driftApps = (driftReport && isArray(driftReport.apps)) ? driftReport.apps : [];
  var recordedApps = (layout && isArray(layout.apps)) ? layout.apps : [];
  var byIdentity = {};
  var occByAddress = {};
  var i, occ, entry, identityId;

  function bucketFor(id) {
    if (!own(byIdentity, id)) {
      byIdentity[id] = {
        occurrences: {}, live: [], order: [], instances: 0,
        addressByOccurrence: {}, recordedByOccurrence: {}
      };
    }
    return byIdentity[id];
  }

  for (i = 0; i < driftApps.length; i++) {
    entry = driftApps[i];
    if (!entry || !trim(entry.identityId)) continue;
    identityId = trim(entry.identityId);
    occ = occurrenceOf(entry.occurrence);
    var bucket = bucketFor(identityId);
    bucket.occurrences[occ] = true;
    if (!bucket.recordedByOccurrence[occ]) {
      bucket.recordedByOccurrence[occ] = entry.recorded || null;
    }
    var liveAddress = trim(entry.current && entry.current.address);
    if (liveAddress) occByAddress[liveAddress] = { identityId: identityId, occurrence: occ };
  }

  for (i = 0; i < recordedApps.length; i++) {
    entry = recordedApps[i];
    if (!entry || !trim(entry.identityId)) continue;
    identityId = trim(entry.identityId);
    occ = occurrenceOf(entry.occurrence);
    bucketFor(identityId).occurrences[occ] = true;
    bucketFor(identityId).recordedByOccurrence[occ] = entry;
  }

  var list = isArray(clients) ? clients : [];
  for (i = 0; i < list.length; i++) {
    var client = list[i];
    if (!isMappable(client)) continue;
    identityId = trim(resolver(client));
    if (!identityId) continue;
    bucketFor(identityId).live.push({
      address: trim(client.address),
      place: placementKeyForClient(client, monitors)
    });
  }

  var byAddress = {};
  for (var id in byIdentity) {
    if (!Object.prototype.hasOwnProperty.call(byIdentity, id)) continue;
    var b = byIdentity[id];
    b.live.sort(function (x, y) {
      var byPlace = comparePlacement(x.place, y.place);
      if (byPlace !== 0) return byPlace;
      if (x.address === y.address) return 0;
      return x.address < y.address ? -1 : 1;
    });

    var assigned = {};
    var used = {};
    var w;
    for (w = 0; w < b.live.length; w++) {
      var found = occByAddress[b.live[w].address];
      if (!found || found.identityId !== id) continue;
      assigned[b.live[w].address] = found.occurrence;
      used[found.occurrence] = true;
      b.occurrences[found.occurrence] = true;
    }
    var next = 0;
    for (w = 0; w < b.live.length; w++) {
      if (assigned[b.live[w].address] !== undefined) continue;
      while (used[next]) next += 1;
      used[next] = true;
      assigned[b.live[w].address] = next;
      b.occurrences[next] = true;
    }

    var order = [];
    for (var k in b.occurrences) {
      if (Object.prototype.hasOwnProperty.call(b.occurrences, k)) order.push(Number(k));
    }
    order.sort(function (x, y) { return x - y; });
    b.order = order;
    b.instances = order.length;

    for (w = 0; w < b.live.length; w++) {
      var address = b.live[w].address;
      var occurrence = assigned[address];
      b.addressByOccurrence[occurrence] = address;
      var at = 0;
      for (var o = 0; o < order.length; o++) {
        if (order[o] === occurrence) { at = o; break; }
      }
      byAddress[address] = {
        identityId: id,
        occurrence: occurrence,
        index: at,
        instances: order.length
      };
    }
  }

  return { byAddress: byAddress, byIdentity: byIdentity };
}

// Where an identity's instance sits in the index, or a one-window default. The
// default is what every caller that has no index gets, and it is exactly the
// pre-v3 answer.
function instancePlaceFor(instances, address, identityId) {
  var found = (instances && instances.byAddress) ? instances.byAddress[trim(address)] : null;
  if (found) return found;
  return { identityId: trim(identityId), occurrence: 0, index: 0, instances: 1 };
}

// The drift entry for each LIVE window, by address. A drift report has one row
// per recorded window now, so "the row for this identity" is no longer a
// question with one answer — but "the row whose matched window is this address"
// always is.
function driftIndexByAddress(driftReport) {
  var index = {};
  var apps = (driftReport && isArray(driftReport.apps)) ? driftReport.apps : [];
  for (var i = 0; i < apps.length; i++) {
    var address = trim(apps[i] && apps[i].current && apps[i].current.address);
    if (address) index[address] = apps[i];
  }
  return index;
}

// A verdict table indexed by (identityId, occurrence).
function verdictIndexByOccurrence(verdicts) {
  var index = {};
  var list = isArray(verdicts) ? verdicts : [];
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || typeof list[i].identityId !== "string") continue;
    index[occurrenceKey(list[i].identityId, list[i].occurrence)] = list[i];
  }
  return index;
}

// What a row or a chip says about a verdict, in one line.
//
// The arrow ("ws 3 → DP-2 · ws 10") says WHERE the app should be, and used to
// be the whole story — which made every kind of wrong look like the same kind
// of wrong. A window sitting in exactly the right place with its tabs in the
// wrong order got the same arrow as one on the wrong monitor, and the user was
// left to work out the difference by looking at the screen. This is the
// difference, said out loud, plus the reason the last cycle could not fix it
// when there is one.
//
// Geometry (tick 5sc) is the one dimension whose word is read directly rather
// than through `ok`. A float can be on the right monitor, on the right
// workspace, floating exactly as recorded — and 40 px from where it was left.
// Tick 5sc showed that row while `ok` stayed TRUE, because no op could fix it;
// tick qkv gave floats an op, so `ok` is false for that case now and the second
// half of the test below is the load-bearing one. The `geometry` check stays
// anyway, and is not redundant: it is what keeps this function honest if the
// fold in verdictForApp is ever narrowed again, and it costs nothing.
//
// Only `geometry-off` reaches a row. A tiled window's `scored` is a number for
// the verify table, not a sentence — it does not move `ok` and must not put a
// complaint on a row — and `not-scored` is the permanent legal state of every
// v1 recording. A row announcing either would be noise on nine rows out of
// nine, which is how a panel teaches a user to stop reading it.
//
// Schema v3: the sentence stays IDENTITY-level — "on the wrong workspace" is
// what the user wants to read about their mail window — and gains a
// disambiguator only when the identity has more than one recorded window, where
// the sentence alone would leave them looking at two windows not knowing which
// one is being complained about. One window, one app, no marker: the single
// case is byte-identical to what it always said.
//
// `rowInstances` — optional — is how many windows the ROW this line lands on
// belongs to, from instanceIndex. The two counts are computed from different
// populations: the verdict's `instances` counts DRIFT-REPORT rows (recorded
// windows), while instanceIndex counts the recorded-or-running UNION, so an
// app with one recorded window and a second, unrecorded one open is "2" to the
// row and "1" to the verdict. Whenever they disagree the verdict cannot say
// WHICH of the rows it means — "window 2 of 2" under a row titled "window 2 of
// 3" is worse than no marker at all — so the marker is dropped and the
// sentence stays identity-level. Aligning the counts instead is not possible
// here: the drift report has never heard of the unrecorded window.
function verdictLine(verdict, rowInstances) {
  if (!verdict) return "";
  if (verdict.ok && verdict.geometry !== "geometry-off") return "";
  var text = typeof verdict.text === "string" ? verdict.text : "";
  var blocked = verdict.blockedBy;
  var reason = blocked && typeof blocked.reason === "string" ? trim(blocked.reason) : "";
  var line = text;
  if (!line) line = reason;
  else if (reason) line = text + " — " + reason;

  var instance = verdictInstanceLabel(verdict);
  if (typeof rowInstances === "number" && rowInstances !== verdict.instances) instance = "";
  if (!instance) return line;
  return line ? line + " (" + instance + ")" : instance;
}

// ---------------------------------------------------------------------------
// One undo, for the one destructive thing this panel does (tick 7ow)
// ---------------------------------------------------------------------------
//
// From the sketch, twice over: "Recording OVERWRITES this topology's layout —
// the previous one is gone (single undo kept in memory until next record)", and
// "the panel never blocks: no modals, no confirmation dialogs. Destructive-ish
// actions rely on instant feedback + undo instead of 'are you sure'".
//
// So Record stays a single click that does the thing, and the safety net is
// behind it rather than in front of it. IN MEMORY is deliberate and is the whole
// scope: one stash, on the panel object, holding the layout Record replaced. It
// does not survive the panel closing and it is not written anywhere — an undo
// that outlived the moment would be a second recording store with its own
// staleness questions, and the sketch asks for a net, not a history.
//
// The FIRST recording for a topology is the case that makes the label matter.
// There is no previous layout to put back, so undoing it means FORGETTING the
// one just made — a different act, and one the user has to be told about before
// they press it rather than after.

// Is this stash still something the panel can act on?
//
// Two ways it stops being: it is empty (nothing recorded yet this session, or
// the last undo used it up), or the desktop has since become a DIFFERENT
// topology — a dock, an undock — in which case the layout it holds belongs to a
// monitor arrangement that is no longer on the desk, and writing it back would
// be filing a recording for a topology the user is not looking at.
function recordUndoValid(stash, topologyKey) {
  if (!stash) return false;
  var key = trim(stash.topologyKey);
  if (!key) return false;
  return key === trim(topologyKey);
}

// Does undoing mean putting a layout BACK, or forgetting the one just made?
function recordUndoRestores(stash) {
  return !!(stash && stash.previousLayout && trim(stash.previousLayout.topologyKey));
}

// WHICH act the stash is a net under (tick gwa). The slot is one slot on
// purpose — a second armer does not get a second button — but the sentence on
// that button has to name the thing the user just did, and "Undo record" over a
// layout the user FORGOT is a button describing somebody else's click.
//
// Defaults to "record", so a stash armed before this field existed (and every
// caller that has no reason to care) keeps the original wording.
function undoStashAction(stash) {
  return (stash && trim(stash.action) === "forget") ? "forget" : "record";
}

// The stash a Forget arms, or null when this topology has no layout to forget.
//
// Deliberately the SAME shape and the SAME slot as Record's: the sketch allows
// exactly one destructive act to be outstanding ("single undo kept in memory
// until next record"), and forgetting a layout is destructive in precisely the
// way recording over one is. Two slots would mean two buttons and a question
// about which one the next Esc belongs to.
// The layout comes in from the caller (StateModel.layoutFor against a FRESH
// read) rather than being looked up here: this file never touches the state
// file's shape, and the write and the stash have to come from the same read or
// the undo puts back something the write never removed.
function forgetUndoStash(topologyKey, previousLayout) {
  var key = trim(topologyKey);
  if (!key) return null;
  if (!previousLayout || !trim(previousLayout.topologyKey)) return null;
  return { topologyKey: key, previousLayout: previousLayout, action: "forget" };
}

function undoRecordLabel(stash) {
  if (undoStashAction(stash) === "forget") {
    return recordUndoRestores(stash) ? "Undo — put the layout back" : "Undo";
  }
  return recordUndoRestores(stash) ? "Undo record" : "Undo — forget this recording";
}

// What pressing it will DO, naming the recording it puts back — because "undo"
// on its own is the one word in this panel that could mean either of two
// opposite things, and the user pressed Record on purpose a moment ago.
function undoRecordTooltip(stash, topologyName) {
  if (!stash) return "";
  var name = trim(topologyName) || "this setup";
  if (undoStashAction(stash) === "forget") {
    if (!recordUndoRestores(stash)) return "";
    var forgotten = stash.previousLayout;
    var forgottenApps = isArray(forgotten.apps) ? forgotten.apps.length : 0;
    var forgottenWhen = trim(forgotten.recordedAt);
    return "Put back the layout you just forgot for " + name
      + (forgottenWhen ? ", recorded on " + forgottenWhen : "")
      + " (" + forgottenApps + " app" + (forgottenApps === 1 ? "" : "s") + ").";
  }
  if (!recordUndoRestores(stash)) {
    return "Forget the recording just made for " + name + "."
      + " There was no layout for this setup before it, so undoing means having none again.";
  }
  var previous = stash.previousLayout;
  var apps = isArray(previous.apps) ? previous.apps.length : 0;
  var when = trim(previous.recordedAt);
  return "Put back the layout recorded for " + name
    + (when ? " on " + when : "")
    + " (" + apps + " app" + (apps === 1 ? "" : "s") + ")."
    + " The recording just made is discarded.";
}

// ---------------------------------------------------------------------------
// The failed-restore list (tick jzx)
// ---------------------------------------------------------------------------
//
// The sketch's auto-restore flow ends with "failures: red dot on the glyph; the
// panel lists which apps failed, each with a retry", and until now the panel had
// the first half only. A failed cycle turned the badge red and put its reason on
// each app's row, which is exactly where a user is NOT looking when the toast
// says a restore failed — the rows are sorted by where the windows are, so the
// two that failed are somewhere in a list of nine.
//
// So: a short section, one line per app the last cycle could not finish, with
// the reason the compositor or the service gave. It is not a second opinion
// about the desktop — every word in it comes from `verdict.blockedBy`, which is
// the ledger of what the LAST cycle attempted and how it went — so a row here
// and the same app's row in the list can never say different things.
//
// RETRY IS A WHOLE RESTORE, and that is a decision rather than a shortcut. The
// restore is idempotent by construction (planRestore against a conforming
// desktop is empty), so "retry this app" and "restore everything" reach the same
// desktop; a per-app plan would be a second planner with its own gates, its own
// ordering rules and its own bugs, for a button that would then do the same
// thing. The per-app buttons are UX scoping: they tell the user WHICH app they
// are acting for, and the tooltip says the rest.

// What a browser cannot promise, said before the user presses Retry a third
// time. Chromium and its family answer a second launch of the same profile by
// opening a TAB in the window that is already up, so a `launch` op for one can
// fail in a way no amount of retrying fixes.
var BROWSER_LAUNCH_CAVEAT = "browsers may open a tab instead of a new window —"
  + " open one manually and Restore";

// The apps the LAST cycle could not finish, as rows.
//
//   `verdicts` — the verdict table from the status file (StateModel), which is
//                where `blockedBy` lives.
//   `rows`     — this panel's own instance rows (appRows), so the section says
//                the same NAME the list does. A verdict with no row still
//                produces a line, from the verdict alone: an app that failed is
//                the one thing this section may never drop silently.
function failedRestoreRows(verdicts, rows) {
  var list = isArray(verdicts) ? verdicts : [];
  var rowList = isArray(rows) ? rows : [];

  var rowByKey = {};
  for (var r = 0; r < rowList.length; r++) {
    var row = rowList[r];
    if (!row || !trim(row.identityId)) continue;
    rowByKey[occurrenceKey(row.identityId, row.occurrence)] = row;
  }

  var out = [];
  for (var i = 0; i < list.length; i++) {
    var verdict = list[i];
    if (!verdict || !verdict.blockedBy) continue;
    var identityId = trim(verdict.identityId);
    if (!identityId) continue;

    var key = occurrenceKey(identityId, verdict.occurrence);
    var matched = rowByKey[key] || null;

    // The same rule verdictLine follows: the two instance counts are computed
    // over different populations, and a marker that disagrees with the row's own
    // title is worse than no marker.
    var instance = verdictInstanceLabel(verdict);
    if (matched && typeof matched.instances === "number"
      && matched.instances !== verdict.instances) instance = "";

    // The class is the honest input to the browser question, and a NOT-RUNNING
    // app — which is every `launch` failure — has none: its row is a ghost and
    // ghosts carry no class. The identity id is the fallback because it is
    // derived FROM the class (deriveIdentityId), so "chromium" survives the trip
    // and "mail-google" correctly does not — a webapp's `--app=` launch really
    // does open its own window.
    var className = matched ? trim(matched.className) : "";
    var kind = trim(verdict.blockedBy.kind);
    var caveat = (kind === "launch" && isBrowserFamilyClass(className || identityId))
      ? BROWSER_LAUNCH_CAVEAT : "";

    out.push({
      key: "failed:" + key,
      identityId: identityId,
      occurrence: occurrenceOf(verdict.occurrence),
      className: className,
      // The row's own name when there is a row, so the section and the list
      // agree letter for letter about what this app is called.
      name: matched ? matched.name : titleCase(identityId),
      instanceLabel: instance,
      kind: kind,
      // The compositor's or the service's own words. `text` is the fallback for
      // a verdict that is blocked without a reason string, which a hand-edited
      // status file can produce — a blank line under a red header reads as a
      // broken panel.
      reason: trim(verdict.blockedBy.reason) || trim(verdict.text)
        || "the last restore could not finish this one",
      caveat: caveat
    });
  }
  return out;
}

// What Retry says it will do, which is more than its label can.
//
// It has to be honest about the scope — pressing it runs the WHOLE restore, not
// this app's share of it — because a button that quietly did more than its label
// says is how a user stops trusting the panel. Naming the app is still the point:
// it is what tells them which failure they are acting on.
//
// `restoreRefusalReason` is optional and usually "" — an inert file (tick 66x)
// dims Retry exactly as it dims Restore now, and for the same reason: retrying
// is the whole restore, and the whole restore is what the build has refused.
function retryTooltip(row, restoring, restoreRefusalReason) {
  var inert = trim(restoreRefusalReason);
  // Before the `restoring` branch: an inert file never starts a cycle, so a
  // restore cannot be running because of one, and if some other cycle is in
  // flight the honest sentence is still that this button will not join it.
  if (inert) return "Nothing will be restored: " + inert;
  if (restoring) return "A restore is running — this will be retried by it.";
  var name = row ? trim(row.name) : "";
  var lines = [name
    ? "Run the restore again, for " + name + " and everything else it covers."
    : "Run the restore again."];
  lines.push("Restoring twice is safe: a desktop already in place plans no ops.");
  if (row && trim(row.caveat)) lines.push(trim(row.caveat));
  return lines.join(" ");
}

// The section's header, or "" when there is nothing to head.
//
// Driven by `lastResult` and by nothing else, which is what makes the section
// CLEAR: the moment a cycle succeeds the service writes an ok result, this
// answers "", and the whole section goes with it. A stale list of failures under
// a desktop that has since been restored is the one thing this must not become.
function failedRestoreTitle(lastResult) {
  if (!lastResult || lastResult.ok !== false) return "";
  var summary = trim(lastResult.summary);
  return summary ? "Restore failed — " + summary : "Restore failed";
}

// "window 2 of 2", or "" when the identity has only one recorded window.
//
// The twin of engine.verdictInstanceLabel, and it has to STAY the twin: this
// file may not require engine.js (see the header), so the agreement is pinned
// by a test instead of by the call. Sentences stay identity-level; this is the
// only place an instance is ever named in one.
function verdictInstanceLabel(verdict) {
  if (!verdict) return "";
  var count = verdict.instances;
  if (typeof count !== "number" || count <= 1) return "";
  var index = typeof verdict.instance === "number" ? verdict.instance : 1;
  return "window " + index + " of " + count;
}

// "HDMI-A-1 · ws 2" — where a placement points, in the shortest form that is
// still unambiguous. Falls back to the recorded description when that monitor
// is not part of the current topology, which is exactly when the user most
// needs to be told the full name.
function placementLabel(monitorDescription, workspaceId, monitors) {
  var list = isArray(monitors) ? monitors : [];
  var wanted = trim(monitorDescription);
  var name = wanted;
  for (var i = 0; i < list.length; i++) {
    var monitor = list[i];
    if (!monitor) continue;
    var label = trim(monitor.description) || trim(monitor.name);
    if (label === wanted && trim(monitor.name)) { name = trim(monitor.name); break; }
  }
  var workspace = (workspaceId === null || workspaceId === undefined || workspaceId === "")
    ? "?" : String(workspaceId);
  if (!name) return "ws " + workspace;
  return name + " · ws " + workspace;
}

// "eDP-1 · ws 3" for a LIVE window — the monitor it is on and the workspace it
// is in, in the same shape placementLabel gives a recorded placement.
//
// The monitor's NAME comes first here (description second), which is the
// opposite of what a recording stores: a live window is being pointed at on a
// desk the user is looking at, and "eDP-1" is what hyprctl, the config file and
// every other tool call it.
function livePlacementLabel(client, monitors) {
  var list = isArray(monitors) ? monitors : [];
  var label = "";
  for (var i = 0; i < list.length; i++) {
    if (list[i] && client && list[i].id === client.monitor) {
      label = trim(list[i].name) || trim(list[i].description);
      break;
    }
  }
  var workspaceId = (client && client.workspace && client.workspace.id !== undefined
    && client.workspace.id !== null) ? client.workspace.id : "?";
  return (label ? label + " · " : "") + "ws " + workspaceId;
}

// ---------------------------------------------------------------------------
// Hover linking: one key, two surfaces
// ---------------------------------------------------------------------------
//
// The map and the list are two pictures of the same desktop, and until now
// nothing connected them — hovering a chip told you nothing about which row it
// was, and hovering a row left you hunting the map for a name. A LINK KEY is
// what both sides agree to call an app, so the panel can hold ONE hovered key
// and every chip and row that answers to it lights up.
//
// It is deliberately not a 1:1 pairing. One row can be several chips (an app
// with three windows open), and in the recorded view a row can be a ghost chip
// as well as a live one. Linking is by key EQUALITY, so all of that works
// without anybody maintaining a mapping.
//
// The two levels mirror how the panel groups things everywhere else: a watched
// app is its identity, and an unwatched one has no identity yet, so it is its
// class — the same thing one step earlier. The prefixes keep an identity called
// "foot" from colliding with the class "foot", which is otherwise exactly the
// pair most likely to meet.
function linkKeyFor(identityId, className) {
  var id = trim(identityId);
  if (id) return "id:" + id;
  var cls = trim(className);
  return cls ? "class:" + cls : "";
}

function chipLinkKey(chip) {
  return chip ? linkKeyFor(chip.identityId, chip.className) : "";
}

function rowLinkKey(row) {
  return row ? linkKeyFor(row.identityId, row.className) : "";
}

// ---------------------------------------------------------------------------
// Tooltips: the whole of what the panel knows about one thing
// ---------------------------------------------------------------------------

// Assemble a multi-line tooltip, dropping the lines that have nothing in them.
//
// Blank lines are the failure mode this exists to prevent: a chip with no
// window title and no mismatch would otherwise render as a tooltip with two
// empty rows in it, which looks like a bug in the panel rather than an app with
// nothing wrong.
function joinLines(lines) {
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = trim(lines[i]);
    if (line) out.push(line);
  }
  return out.join("\n");
}

// "→ recorded on DP-2 · ws 10", or "" — the arrow the amber edge is short for.
function driftLine(drifted, driftTo) {
  var where = trim(driftTo);
  if (!drifted || !where) return "";
  return "→ recorded on " + where;
}

// ---------------------------------------------------------------------------
// Chip tags: the two things a chip can say without being hovered (tick rjq)
// ---------------------------------------------------------------------------
//
// The map had exactly one inline signal — an amber edge and an arrow glued to
// the name — and it said the same thing about two different situations. A window
// the restore is about to MOVE and a workspace the restore has DECLINED to
// reshape both came out amber-ish and wordless, and the difference between "the
// tool is going to fix this" and "the tool has looked at this and will not touch
// it" is the whole of what a ceiling has to communicate. So there are two tags,
// they are different colours in Panel.qml, and each one is short enough to sit
// inside a chip.
//
// SHORT IS THE POINT. A chip is a rectangle scaled off a real window, and on a
// busy workspace it is three letters wide. Both builders produce something that
// fits in a pill beside the label, and both have a full sentence behind them in
// the tooltip — the tag is the headline, never the explanation.

// "→ DP-1 ws 10" from a driftTo of "DP-1 · ws 10".
//
// The monitor half goes through shortMonitorLabel, which matters in exactly the
// case the label is longest: a recording pointing at a monitor that is NOT in
// this topology keeps its full EDID description ("Samsung Display Corp.
// ATNA60HR07-0"), because placementLabel could not resolve it to a live name.
function driftTagFor(driftTo) {
  var where = trim(driftTo);
  if (!where) return "";
  var parts = where.split(" · ");
  if (parts.length < 2) return "→ " + where;
  return "→ " + shortMonitorLabel(parts[0], null) + " " + parts.slice(1).join(" ");
}

// The refusal codes engine.js can put on a geometry score's `refinement`, in two
// registers: a pill-sized tag and the sentence behind it.
//
// SPELLED HERE AND NOT IMPORTED, like verdictInstanceLabel above and for the
// same reason — this file may not require engine.js (see the header). The words
// are deliberately NOT the engine's: engine.tilingRefusalPhrase writes for a
// terminal table and a service log, where a full clause per line is right, and
// this writes for a tooltip beside a picture of the desktop. The agreement that
// has to hold is over the CODES, and a test pins that all three are covered.
var REFUSAL_TAGS = {
  "not-a-tree": "not a tiling",
  "ambiguous-tree": "shape unclear",
  "different-shape": "shape differs"
};

var REFUSAL_SENTENCES = {
  "not-a-tree": "these windows do not divide the screen along straight lines, so there is"
    + " no divider to aim at — the shape is left as it is",
  "ambiguous-tree": "these windows fit more than one split shape, so which divider a nudge"
    + " would move is a guess — the shape is left as it is",
  "different-shape": "live split shape differs from the recording — auto-fix is limited to a"
    + " single flip, so this shape is left as it is"
};

// A code this panel has never heard of comes from a NEWER engine, and it is
// shown rather than swallowed: an unreadable word beats a silent chip, and the
// panel is the surface where a stale plugin is most likely to be noticed.
function refusalTagFor(reason) {
  var code = trim(reason);
  if (!code) return "";
  var tag = own(REFUSAL_TAGS, code);
  return tag === undefined ? code : tag;
}

function refusalSentenceFor(reason) {
  var code = trim(reason);
  if (!code) return "";
  var sentence = own(REFUSAL_SENTENCES, code);
  return sentence === undefined
    ? "the tiled shape of this workspace is left as it is (" + code + ")"
    : sentence;
}

// The refusal code carried on a verdict, or "" — null-safe through every layer
// this can arrive by (no verdict, no geometryDetail, a file that never had one).
function refusalOfVerdict(verdict) {
  if (!verdict) return "";
  var detail = verdict.geometryDetail;
  if (!detail) return "";
  return trim(detail.refinement);
}

// What a chip says when the pointer rests on it.
//
// Everything the chip cannot fit: the window's own title (a chip is three
// letters wide on a busy workspace), what it actually is, where it is, and —
// when there is something wrong — where it belongs and what is wrong with it.
//
// "" means there is nothing worth showing, and the caller hides the tooltip
// rather than popping an empty box.
function chipTooltipText(chip) {
  if (!chip) return "";
  return joinLines([
    chip.title,
    chip.className,
    chip.placement,
    driftLine(chip.drifted, chip.driftTo),
    chip.mismatch,
    // LAST, and only ever one line: a refusal is not a complaint about this
    // window, it is a statement about the workspace it sits on, and it must not
    // read as the diagnosis of a window that has one of its own.
    refusalSentenceFor(chip && chip.refusal)
  ]);
}

// The same, for a row. A row has no window title — it is one line per APP, and
// an app with three windows has three titles — so it leads with the app's name
// instead.
function rowTooltipText(row) {
  if (!row) return "";
  return joinLines([
    row.name,
    row.className,
    row.position,
    driftLine(row.drifted, row.driftTo),
    row.mismatch
  ]);
}

// One live window as a chip.
//
// `identityId` is the caller's answer from engine.matchClient — "" for a
// window that matches nothing, which is precisely the unwatched grey chip.
//
// `monitorRect` is the logical rectangle of the monitor this window is on (see
// logicalRect). With it the chip carries a true-proportion `rect`; without it —
// or without usable geometry on the window — `rect` is null and the workspace
// falls back to equal slots.
function chipFor(client, identityId, drift, monitors, verdict, monitorRect, place) {
  var className = trim(client && (client.class || client.initialClass));
  var watched = !!trim(identityId);
  var entry = watched && drift ? drift : null;
  var drifted = !!(entry && entry.status === "drifted");
  var at = place || { occurrence: 0, index: 0, instances: 1 };
  var driftTo = drifted
    ? placementLabel(entry.recorded.monitorDescription, entry.recorded.workspaceId, monitors) : "";
  // Only a WATCHED window can carry one: a refusal is a fact about a recorded
  // workspace, and an unwatched window is not part of any recording.
  var refusal = watched ? refusalOfVerdict(verdict) : "";

  return {
    // Where this window sits inside its monitor, in 0..1 fractions, or null
    // when the read did not carry geometry.
    rect: windowRect(client && client.at, client && client.size, monitorRect),
    // "not in its recorded group — group join refused by compositor". "" when
    // there is no verdict for this chip or the verdict is clean.
    mismatch: watched ? verdictLine(verdict, at.instances) : "",
    key: trim(client && client.address) || className,
    address: trim(client && client.address),
    className: className,
    identityId: trim(identityId),
    // What the app calls THIS window. The chip is far too small to show it, and
    // it is the one thing that tells two windows of the same app apart, so it
    // travels to the tooltip.
    title: trim(client && client.title),
    placement: livePlacementLabel(client, monitors),
    // What the hovered row has to match to light this chip up. See linkKeyFor
    // — and instanceLinkKeyFor, which is the same key with the instance in it
    // when the identity has more than one window.
    linkKey: instanceLinkKeyFor(identityId, className, at.occurrence, at.instances),
    name: watched
      ? instanceNameFor(identityId, at.index, at.instances)
      : (displayNameFor(className) || className),
    // v3. WHICH window of its identity this chip is, and how many the panel
    // knows about. 0 and 1 for every single-window app, which is what makes
    // every key above identical to the pre-v3 one.
    occurrence: at.occurrence,
    instances: at.instances,
    watched: watched,
    ghost: false,
    drifted: drifted,
    // The whole point of the amber tag: say where a restore would put this
    // window BEFORE the user commits to one.
    driftTo: driftTo,
    // The same fact, short enough to sit ON the chip when there is room for it.
    driftTag: drifted ? driftTagFor(driftTo) : "",
    // Why the tiled refinement will not reshape this window's workspace, and the
    // pill-sized word for it. "" on every chip whose workspace is fine or whose
    // workspace nobody asked about — a refusal is only ever reported for a
    // finished workspace that has drifted (engine.tilingRefusalsOf).
    refusal: refusal,
    refusalTag: refusalTagFor(refusal),
    floating: !!(client && client.floating),
    tabIndex: 0,
    groupSize: 1
  };
}

// Group the clients of one workspace into SLOTS: a slot is either a single
// chip or a fused run of chips that share a tab group, rendered in the group's
// own tab order (client.grouped is that order, and it is not the order hyprctl
// lists the windows in).
//
// A slot also carries the RECT it is drawn at: its own for a single chip, the
// lead (first tab) member's for a fused group — a tab group is one window's
// worth of screen however many tabs are in it, so drawing one rect per member
// would draw the same rectangle n times.
function slotsForClients(clients, resolve, drift, monitors, verdicts, monitorRect, instances, driftByAddress) {
  var list = isArray(clients) ? clients : [];
  var verdictsByOccurrence = verdicts || {};
  var byAddress = driftByAddress || {};
  var slots = [];
  var placed = {};

  // The drift row and the verdict for ONE window: found by address (the engine
  // matched that window to that recorded row) and by (identity, occurrence),
  // never by identity alone — an identity can have several of each now.
  function chipContext(client) {
    var address = trim(client && client.address);
    var identityId = trim(resolve(client));
    var place = instancePlaceFor(instances, address, identityId);
    return {
      identityId: identityId,
      place: place,
      drift: byAddress[address] || (drift ? own(drift, identityId) : null),
      verdict: verdictsByOccurrence[occurrenceKey(identityId, place.occurrence)]
    };
  }

  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    if (!client) continue;
    var address = trim(client.address);
    if (placed[address]) continue;

    var grouped = isArray(client.grouped) ? client.grouped : [];
    if (grouped.length < 2) {
      placed[address] = true;
      var solo = chipContext(client);
      var soloChip = chipFor(client, solo.identityId, solo.drift, monitors,
        solo.verdict, monitorRect, solo.place);
      slots.push({
        key: address || ("solo-" + i),
        group: false,
        rect: soloChip.rect,
        chips: [soloChip]
      });
      continue;
    }

    var chips = [];
    for (var g = 0; g < grouped.length; g++) {
      var memberAddress = trim(grouped[g]);
      var member = null;
      for (var m = 0; m < list.length; m++) {
        if (list[m] && trim(list[m].address) === memberAddress) { member = list[m]; break; }
      }
      // A member on another workspace cannot happen in Hyprland, but a client
      // list read mid-move can be missing one. Skip it rather than drawing a
      // hole in the group.
      if (!member) continue;
      placed[memberAddress] = true;
      var memberContext = chipContext(member);
      var chip = chipFor(member, memberContext.identityId, memberContext.drift, monitors,
        memberContext.verdict, monitorRect, memberContext.place);
      chip.tabIndex = chips.length;
      chip.groupSize = grouped.length;
      chips.push(chip);
    }
    if (!chips.length) continue;
    slots.push({ key: "group-" + trim(grouped[0]), group: true, rect: chips[0].rect, chips: chips });
  }

  return slots;
}

// A client that belongs on the map at all. Special workspaces (scratchpads)
// and windows with no workspace are deliberately absent: they have no slot to
// live in, and a recorded placement for one could never be restored.
function isMappable(client) {
  if (!client) return false;
  if (!client.workspace || typeof client.workspace.id !== "number") return false;
  if (client.workspace.id < 0) return false;
  return !!trim(client.class || client.initialClass);
}

function workspacesForMonitor(clients, monitor) {
  var list = isArray(clients) ? clients : [];
  var byWorkspace = {};
  var order = [];

  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    if (!isMappable(client)) continue;
    if (client.monitor !== monitor.id) continue;
    var id = client.workspace.id;
    if (!byWorkspace[id]) {
      byWorkspace[id] = { id: id, name: trim(client.workspace.name) || String(id), clients: [] };
      order.push(id);
    }
    byWorkspace[id].clients.push(client);
  }

  order.sort(function (a, b) { return a - b; });
  var out = [];
  for (var o = 0; o < order.length; o++) out.push(byWorkspace[order[o]]);
  return out;
}

// The logical rectangle a mapGeometry box came from. mapGeometry already keeps
// the untouched numbers (realX/realY are the monitor's layout origin,
// logicalWidth/logicalHeight its rotated, descaled size), so this is a reshape
// rather than a second computation — there is exactly one place that decides
// what a monitor's logical rect is, and it is logicalRect().
function boxRect(box) {
  return { x: box.realX, y: box.realY, width: box.logicalWidth, height: box.logicalHeight };
}

// The key a workspace is named by when a bare id is not enough. Both sides of
// the comparison build it here so they cannot spell it differently — the same
// discipline Panel.qml's render registry follows, and for the same reason: a
// stale recording can name one workspace id under two monitors.
function workspaceKey(monitorName, workspaceId) {
  return String(monitorName === undefined || monitorName === null ? "" : monitorName)
    + "/" + String(workspaceId === undefined || workspaceId === null ? "" : workspaceId);
}

// The workspace the user is actually looking at: the ACTIVE workspace of the
// FOCUSED monitor, as one of those keys.
//
// Only the focused monitor has one. Every monitor has an active workspace, and
// lighting all of them would say "you are here" three times on a docked desk —
// the badge is answering "which of these is in front of you", which has one
// answer or none.
//
// "" when nothing is focused, when the focused monitor reports no active
// workspace, or when the read came back without either field. A headless output
// set is the real case, and it is a legitimate one: no badge is filled, which
// is honest rather than arbitrary.
function focusedWorkspaceKey(monitors) {
  var list = isArray(monitors) ? monitors : [];
  for (var i = 0; i < list.length; i++) {
    var monitor = list[i];
    if (!monitor || monitor.focused !== true) continue;
    if (monitor.disabled === true) continue;
    var active = monitor.activeWorkspace;
    if (!active || active.id === undefined || active.id === null) return "";
    return workspaceKey(trim(monitor.name), active.id);
  }
  return "";
}

// One workspace of the map, with the two things the drawing needs beyond its
// slots.
//
// `aspect` is the monitor's shape, not the workspace's: a workspace fills its
// monitor, so a box drawn at any other ratio would put every window inside it
// at the wrong one — which is the whole point of drawing windows to scale.
//
// `fallback` is the branch. Absolutely-positioned rects need EVERY slot in the
// workspace to have one: mixing a positioned window with a stacked leftover
// would draw the leftover on top of whatever happens to be under it. One slot
// without geometry (a v1 recording, a read that came back without the field)
// therefore drops the whole workspace back to the equal-slot column, which is
// the layout this panel drew before rects existed and is still honest — it just
// says less.
function workspaceModel(id, name, rect, slots) {
  var fallback = false;
  for (var s = 0; s < slots.length; s++) {
    if (!slots[s].rect) { fallback = true; break; }
  }
  return {
    id: id,
    name: name,
    aspect: (rect && rect.height > 0) ? (rect.width / rect.height) : 0,
    fallback: fallback,
    slots: slots
  };
}

// The LIVE map: what is on screen right now.
//
//   resolve(client) -> identityId | ""   (engine.matchClient, injected)
function liveMapModel(clients, monitors, resolve, driftReport, targetWidth, targetHeight, verdicts, instances) {
  var geometry = mapGeometry(monitors, targetWidth, targetHeight);
  var drift = driftIndex(driftReport);
  var driftByAddress = driftIndexByAddress(driftReport);
  var verdictsByOccurrence = verdictIndexByOccurrence(verdicts);
  var resolver = typeof resolve === "function" ? resolve : function () { return ""; };
  // Optional: a caller that does not build the index gets the pre-v3 answer —
  // every window is instance 1 of 1 — which is the right answer for every
  // single-window identity and therefore for almost every desktop.
  var index = instances || instanceIndex(clients, monitors, resolver, driftReport, null);

  for (var i = 0; i < geometry.monitors.length; i++) {
    var box = geometry.monitors[i];
    box.shortLabel = shortMonitorLabel(box.label, { name: box.name });
    var rect = boxRect(box);
    var workspaces = workspacesForMonitor(clients, box);
    var built = [];
    for (var w = 0; w < workspaces.length; w++) {
      built.push(workspaceModel(workspaces[w].id, workspaces[w].name, rect,
        slotsForClients(workspaces[w].clients, resolver, drift, monitors, verdictsByOccurrence,
          rect, index, driftByAddress)));
    }
    box.workspaces = built;
  }

  return geometry;
}

// The RECORDED map: what the stored layout says this topology looks like.
//
// Apps that are not running right now render as GHOSTS — same slot, same
// place, dashed — because "this is where Slack goes" is still true when Slack
// is closed, and a recorded layout that hid its own closed apps would look
// like it had forgotten them.
//
// Every chip here carries watched: true, and in THIS view that flag means "part
// of the recording" — which is what the recorded map is a picture of. Whether
// the app is still on the watched list is a different question, and appRows
// (which has the identity list to answer it with) is where the panel answers
// it, in the row states documented there.
function recordedMapModel(layout, monitors, runningIdentityIds, targetWidth, targetHeight, instances) {
  var geometry = mapGeometry(monitors, targetWidth, targetHeight);
  var apps = (layout && isArray(layout.apps)) ? layout.apps : [];
  var running = {};
  var runningList = isArray(runningIdentityIds) ? runningIdentityIds : [];
  for (var r = 0; r < runningList.length; r++) running[runningList[r]] = true;
  // The SAME index the rows and the live map use, so a hover pairs the right
  // recorded chip with the right row. Without one, fall back to what this
  // layout alone says — which is the whole truth whenever the recording is the
  // only thing on screen.
  var index = instances || instanceIndex([], monitors, null, null, layout);
  function placeOf(app) {
    var bucket = own(index.byIdentity, trim(app.identityId)) || null;
    if (!bucket) return { occurrence: occurrenceOf(app.occurrence), index: 0, instances: 1 };
    var occurrence = occurrenceOf(app.occurrence);
    var at = 0;
    for (var o = 0; o < bucket.order.length; o++) {
      if (bucket.order[o] === occurrence) { at = o; break; }
    }
    return { occurrence: occurrence, index: at, instances: bucket.instances };
  }

  for (var i = 0; i < geometry.monitors.length; i++) {
    var box = geometry.monitors[i];
    box.shortLabel = shortMonitorLabel(box.label, { name: box.name });
    var rect = boxRect(box);

    var byWorkspace = {};
    var order = [];
    for (var a = 0; a < apps.length; a++) {
      var app = apps[a];
      if (!app || trim(app.monitorDescription) !== box.label) continue;
      var id = app.workspaceId === null || app.workspaceId === undefined ? 0 : app.workspaceId;
      if (!byWorkspace[id]) {
        byWorkspace[id] = { id: id, name: String(id), slots: [], groups: {} };
        order.push(id);
      }

      var place = placeOf(app);
      var chip = {
        // The recorded ghost, drawn where the recording says it goes. A v1
        // recording has no at/size and lands on null, which drops its whole
        // workspace to the fallback layout — the recording genuinely does not
        // know where inside the screen the window was.
        rect: windowRect(app.at, app.size, rect),
        key: "recorded-" + instanceKeyFor(app.identityId, place.occurrence, place.instances),
        address: "",
        className: "",
        identityId: app.identityId,
        // A recording has no window titles — it is a picture of where apps go,
        // not of what they had open — so the app's own name stands in.
        title: instanceNameFor(app.identityId, place.index, place.instances),
        placement: placementLabel(app.monitorDescription, app.workspaceId, monitors),
        linkKey: instanceLinkKeyFor(app.identityId, "", place.occurrence, place.instances),
        name: instanceNameFor(app.identityId, place.index, place.instances),
        occurrence: place.occurrence,
        instances: place.instances,
        watched: true,
        ghost: !own(running, app.identityId),
        drifted: false,
        driftTo: "",
        driftTag: "",
        // A recorded ghost is a picture of the recording, and the recording's
        // own shape is not something the refinement can refuse.
        refusal: "",
        refusalTag: "",
        // The recorded map is a picture of the RECORDING, and a recording is
        // never out of place with respect to itself.
        mismatch: "",
        floating: !!app.floating,
        tabIndex: app.group ? app.group.index : 0,
        groupSize: 1
      };

      var slotList = byWorkspace[id].slots;
      if (app.group && app.group.groupId) {
        var slot = byWorkspace[id].groups[app.group.groupId];
        if (!slot) {
          slot = { key: "group-" + app.group.groupId, group: true, chips: [] };
          byWorkspace[id].groups[app.group.groupId] = slot;
          slotList.push(slot);
        }
        slot.chips.push(chip);
      } else {
        slotList.push({ key: chip.key, group: false, rect: chip.rect, chips: [chip] });
      }
    }

    order.sort(function (x, y) { return x - y; });
    var built = [];
    for (var o = 0; o < order.length; o++) {
      var workspace = byWorkspace[order[o]];
      // Recorded tab order is the group index, and it is the whole reason the
      // group was recorded — restoring rebuilds the tabs in it.
      for (var s = 0; s < workspace.slots.length; s++) {
        if (!workspace.slots[s].group) continue;
        workspace.slots[s].chips.sort(function (c1, c2) { return c1.tabIndex - c2.tabIndex; });
        for (var c = 0; c < workspace.slots[s].chips.length; c++) {
          workspace.slots[s].chips[c].groupSize = workspace.slots[s].chips.length;
        }
        // The lead tab's rect, chosen only once the tab order is settled — a
        // group is one rectangle on the screen, and which member's geometry it
        // is has to be the same question the live map answers.
        workspace.slots[s].rect = workspace.slots[s].chips[0].rect;
      }
      built.push(workspaceModel(workspace.id, workspace.name, rect, workspace.slots));
    }
    box.workspaces = built;
  }

  return geometry;
}

// ---------------------------------------------------------------------------
// The flat list under the map
// ---------------------------------------------------------------------------

// WHERE a row's app is, reduced to the numbers the list is sorted on: which
// monitor (by its place on the desk, not by its index), which workspace, and
// where inside that workspace.
//
// Every field is a number so one comparator can walk them, and an app whose
// monitor cannot be resolved gets Infinity in all of them — which is what puts
// it at the end of the list with nothing but its name to sort by.
var UNPLACED = { monX: Infinity, monY: Infinity, ws: Infinity, x: Infinity, y: Infinity, tab: Infinity };

// The monitor a live window is on, by hyprctl's index. The index is fine HERE
// (it is what client.monitor means, in the same read), unlike in a recording,
// where it renumbers across a hotplug and the description is the only stable
// handle.
function monitorOriginById(monitors, id) {
  var list = isArray(monitors) ? monitors : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return logicalRect(list[i]);
  }
  return null;
}

// The monitor a RECORDED placement names, by the label it was recorded under —
// engine.monitorLabel's description-or-name, the same string placementLabel
// resolves.
//
// Disabled outputs are skipped for the same reason mapGeometry drops them: they
// are parked at 0,0 and have no place on the desk, so a ghost recorded on one
// belongs at the end of the list rather than in front of everything.
function monitorOriginByLabel(monitors, description) {
  var list = isArray(monitors) ? monitors : [];
  var wanted = trim(description);
  if (!wanted) return null;
  for (var i = 0; i < list.length; i++) {
    var monitor = list[i];
    if (!monitor || monitor.disabled === true) continue;
    if ((trim(monitor.description) || trim(monitor.name)) === wanted) return logicalRect(monitor);
  }
  return null;
}

function placementKeyForClient(client, monitors) {
  var origin = monitorOriginById(monitors, client.monitor);
  if (!origin) return UNPLACED;
  var at = geometryPair(client.at);
  var grouped = isArray(client.grouped) ? client.grouped : [];
  var tab = grouped.length > 1 ? grouped.indexOf(trim(client.address)) : 0;
  if (tab < 0) tab = 0;
  return {
    monX: origin.x,
    monY: origin.y,
    ws: (client.workspace && typeof client.workspace.id === "number") ? client.workspace.id : Infinity,
    // Global layout coordinates, which is what BOTH halves of this comparison
    // are in — and the comparison only ever happens between two windows on the
    // same monitor, so there is nothing to normalize away.
    x: at ? at[0] : Infinity,
    y: at ? at[1] : Infinity,
    tab: tab
  };
}

function placementKeyForRecorded(app, monitors) {
  var origin = monitorOriginByLabel(monitors, app && app.monitorDescription);
  if (!origin) return UNPLACED;
  var at = geometryPair(app.at);
  var workspaceId = (app.workspaceId === null || app.workspaceId === undefined) ? Infinity : Number(app.workspaceId);
  if (!isFinite(workspaceId)) workspaceId = Infinity;
  var tab = (app.group && isFinite(Number(app.group.index))) ? Number(app.group.index) : 0;
  return {
    monX: origin.x,
    monY: origin.y,
    ws: workspaceId,
    x: at ? at[0] : Infinity,
    y: at ? at[1] : Infinity,
    tab: tab
  };
}

// The map's reading order, as a comparator: left to right across the desk, top
// to bottom where two monitors share a column, then workspace by number, then
// across the workspace.
//
// Tab order falls out of the geometry rather than being asked for separately: a
// tab group is ONE rectangle, so every member reports the same x and y and the
// tie between them is broken by `tab`, which is the group's own order. A window
// the read gave no geometry for has x = Infinity and sits after the placed
// ones — behind the picture, where a row nobody can point at belongs.
function comparePlacement(a, b) {
  if (a.monX !== b.monX) return a.monX < b.monX ? -1 : 1;
  if (a.monY !== b.monY) return a.monY < b.monY ? -1 : 1;
  if (a.ws !== b.ws) return a.ws < b.ws ? -1 : 1;
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.tab !== b.tab) return a.tab < b.tab ? -1 : 1;
  return 0;
}

// One row per app the panel can talk about: every live window that is mappable,
// plus every recorded app that is not currently running (so a layout's closed
// apps stay visible and un-tickable rather than vanishing).
//
// Sorted in the MAP's reading order — monitor left to right, then workspace,
// then across the workspace — because the list is a mirror of the map and a
// mirror that reorders its subject is not one. The old sort was watched-first
// then alphabetical, which read fine on its own and matched nothing above it:
// finding the row for the chip you were looking at meant scanning the whole
// list for a name. Recorded ghosts interleave at the placement the recording
// gives them, for the same reason they appear on the recorded map at all.
// `identities` and `launchMap` are optional and only feed the launch hint —
// callers that predate the launch-derivation repair keep working and simply
// get launchState "" on every row.
//
// FOUR ROW STATES, and the last two are the repairs this function exists in its
// current shape for:
//
//   watched          — an identity on the list. Ticked; a click unticks it.
//   unwatched        — a live window matching nothing. Unticked; a click
//                      watches it.
//   awaitingTitle    — a watched TITLE identity that matches no window yet,
//                      because the terminal it was derived from has not been
//                      relaunched with `--title` (see awaitingTitleIndex). It
//                      has no recorded placement either, so before tick 1m4 it
//                      produced nothing at all: no chip, no row, and pressing
//                      the chip again re-ticked idempotently rather than
//                      unticking, which left a mis-tick recoverable only by
//                      hand-editing the state file. It is a watched identity
//                      like any other, so it renders as one — ticked, clickable,
//                      and a click removes it — and it says WHY it is not
//                      running rather than reading as an app that is merely
//                      closed. It disappears into an ordinary chip and row the
//                      moment a matching window exists.
//   recordedUnwatched — an identity the RECORDING still refers to but the
//                      watched list no longer has. It used to render ticked,
//                      because "it is in the layout" was mistaken for "it is
//                      watched" — and a click on it was a silent no-op
//                      (toggleWatchedIdentities was asked to remove an id that
//                      was not there). It now says what it is and does not
//                      pretend to be clickable: the identity's PATTERNS went
//                      with it when it was unticked, so there is nothing left
//                      here to re-watch FROM. Re-watching is done by clicking
//                      the app's live window — which re-derives the pattern
//                      from a real class, the only honest source — and this row
//                      exists to explain why Restore is going to skip the app
//                      until then.
function appRows(clients, monitors, resolve, driftReport, layout, identities, launchMap, verdicts, instances, launchRefusals) {
  var list = isArray(clients) ? clients : [];
  var drift = driftIndex(driftReport);
  var driftByAddress = driftIndexByAddress(driftReport);
  // Optional, like `identities` and `launchMap`: a caller without a verdict
  // table gets rows whose `mismatch` is "" and the arrow it always had.
  var verdictsByOccurrence = verdictIndexByOccurrence(verdicts);
  var resolver = typeof resolve === "function" ? resolve : function () { return ""; };
  var launch = launchStateIndex(identities, launchMap, launchRefusals);
  // Whether the hint is also an OFFER. A "broken" row says so even when nothing
  // could be derived for it, and a row that cannot be repaired must not be
  // painted or wired as if a click would fix it.
  var repairs = launchRepairIndex(identities, launchMap);
  // `identities` is optional (see above). Without it there is no way to tell a
  // watched identity from an orphaned one, so the old assumption stands and
  // every recorded app reads as watched; a caller that passes [] is saying
  // something different — nothing is watched — and gets orphan rows.
  var haveIdentityList = isArray(identities);
  var identityList = haveIdentityList ? identities : [];
  var watchedIds = {};
  for (var wi = 0; wi < identityList.length; wi++) {
    if (identityList[wi] && typeof identityList[wi].id === "string") watchedIds[identityList[wi].id] = true;
  }
  // Which window is which instance of its identity, computed once for the whole
  // panel frame and passed in by Panel.qml so the rows, the live map and the
  // recorded map cannot disagree about it. See instanceIndex.
  var index = instances || instanceIndex(list, monitors, resolver, driftReport, layout);

  // { row, place, occurrence } triples. The sort key is held BESIDE the row
  // rather than on it: where a row sorts is this function's business, and the
  // row object is a contract with Panel.qml.
  var entries = [];
  // Unwatched live rows, indexed by the id their class WOULD derive to. It is
  // how a recorded-but-unwatched identity finds its own running window: the id
  // in the layout was derived from that same class when the app was ticked, so
  // the two agree for every identity this panel created. (They do not agree for
  // a hand-written id — `terminal` for `foot` — and that case simply falls
  // through to a row of its own, which is honest, just less tidy.)
  var unwatchedRowByDerivedId = {};
  var clientByAddress = {};
  var i;

  // ---- unwatched live windows: still ONE row per CLASS -------------------
  //
  // An unwatched window has no identity yet, so it has no instances either —
  // three unticked terminals are one row and one tick, exactly as before. What
  // changed is only what happens once they ARE watched: then the recording can
  // name each of them, and each earns a row (below).
  //
  // Which of a class's windows the row DESCRIBES is the first one you would
  // meet reading the map, so the row sits where the eye finds the app first and
  // the answer does not depend on the order the windows arrived in.
  var buckets = [];
  var bucketByKey = {};
  for (i = 0; i < list.length; i++) {
    var candidate = list[i];
    if (!isMappable(candidate)) continue;
    clientByAddress[trim(candidate.address)] = candidate;
    if (trim(resolver(candidate))) continue;
    var candidateClass = trim(candidate.class || candidate.initialClass);
    var bucketKey = "class:" + candidateClass;
    var candidatePlace = placementKeyForClient(candidate, monitors);
    var bucket = bucketByKey[bucketKey];
    if (!bucket) {
      bucket = { className: candidateClass, client: candidate, place: candidatePlace };
      bucketByKey[bucketKey] = bucket;
      buckets.push(bucket);
      continue;
    }
    if (comparePlacement(candidatePlace, bucket.place) < 0) {
      bucket.client = candidate;
      bucket.place = candidatePlace;
    }
  }

  for (var b = 0; b < buckets.length; b++) {
    var unwatchedClient = buckets[b].client;
    var className = buckets[b].className;
    var unwatchedRow = {
      key: "class:" + className,
      identityId: "",
      className: className,
      // The window this row was built from. A row is one line per CLASS, but a
      // tick is about one window: for a terminal, two windows of class `foot`
      // can host two different apps, and the proposal names the app. Carrying
      // the address makes a row click and a chip click agree about which
      // window is being ticked. See clientForTick.
      address: trim(unwatchedClient && unwatchedClient.address),
      // What the map's chips have to match to light this row up. See
      // linkKeyFor — for a class row this equals `key` (both "class:"+name).
      linkKey: linkKeyFor("", className),
      name: displayNameFor(className),
      watched: false,
      ghost: false,
      // A row the user can act on. Only the orphaned recorded rows below are
      // ever false: every live window can be ticked or unticked.
      clickable: true,
      recordedUnwatched: false,
      awaitingTitle: false,
      occurrence: 0,
      instances: 1,
      position: livePlacementLabel(unwatchedClient, monitors)
        + (isArray(unwatchedClient.grouped) && unwatchedClient.grouped.length > 1 ? " · grouped" : ""),
      drifted: false,
      driftTo: "",
      mismatch: "",
      launchState: "",
      launchHint: "",
      launchRepairable: false
    };
    entries.push({ row: unwatchedRow, place: buckets[b].place, occurrence: 0 });
    var derivedId = deriveIdentityId(className);
    if (derivedId && !own(unwatchedRowByDerivedId, derivedId)) unwatchedRowByDerivedId[derivedId] = unwatchedRow;
  }

  // ---- watched (or recorded) identities: ONE ROW PER INSTANCE -------------
  //
  // An identity with one window — nearly all of them — produces exactly the row
  // it always produced: the bare id as its key, "id:<id>" as its linkKey, its
  // plain name, no marker anywhere. An identity with two produces two rows, and
  // every one of those three strings gains the instance so the row, the chip and
  // the hover can point at each other.
  //
  // The TICK is still per identity: both rows carry the same `identityId`, and
  // Panel.qml toggles by that, so clicking either one watches or unwatches the
  // app as a whole. There is no such thing as watching one window of an app —
  // watching is a property of the IDENTITY, and an identity is a matching rule;
  // the rows are the live windows that rule claims, and a rule cannot be turned
  // on for one of them. (A rule CAN be written narrowly enough to claim a
  // single specifically-titled window of a shared class — that is what
  // `titlePatterns` is for — but that is a second identity with its own tick,
  // not a per-window toggle on this one.)
  var identityIds = [];
  for (var known in index.byIdentity) {
    if (Object.prototype.hasOwnProperty.call(index.byIdentity, known)) identityIds.push(known);
  }
  identityIds.sort();

  // How many recorded-but-unwatched occurrences have been folded onto a running
  // unwatched row, and what that row's position read BEFORE any of them. Two
  // recorded windows of a dropped identity are one fact about that row, said
  // once — not the same clause appended twice.
  var foldedOntoUnwatched = {};

  for (var n = 0; n < identityIds.length; n++) {
    var identityId = identityIds[n];
    var instanceBucket = index.byIdentity[identityId];
    var stillWatched = !haveIdentityList || own(watchedIds, identityId) === true;
    var count = instanceBucket.instances;

    for (var o = 0; o < instanceBucket.order.length; o++) {
      var occurrence = instanceBucket.order[o];
      var address = instanceBucket.addressByOccurrence[occurrence];
      var client = address ? clientByAddress[address] : null;
      var rowKey = instanceKeyFor(identityId, occurrence, count);
      var linkKey = instanceLinkKeyFor(identityId, "", occurrence, count);
      var name = instanceNameFor(identityId, o, count);
      var verdict = verdictsByOccurrence[occurrenceKey(identityId, occurrence)];

      if (client) {
        var entry = driftByAddress[address] || (count > 1 ? null : own(drift, identityId)) || null;
        var drifted = !!(entry && entry.status === "drifted");
        entries.push({ place: placementKeyForClient(client, monitors), occurrence: occurrence, row: {
          key: rowKey,
          identityId: identityId,
          className: trim(client.class || client.initialClass),
          linkKey: linkKey,
          name: name,
          watched: true,
          ghost: false,
          clickable: true,
          recordedUnwatched: false,
          awaitingTitle: false,
          occurrence: occurrence,
          instances: count,
          position: livePlacementLabel(client, monitors)
            + (isArray(client.grouped) && client.grouped.length > 1 ? " · grouped" : ""),
          drifted: drifted,
          driftTo: drifted
            ? placementLabel(entry.recorded.monitorDescription, entry.recorded.workspaceId, monitors) : "",
          // WHAT is wrong, not just where it should be. See verdictLine — the
          // row's own instance count goes with it, so a verdict counted over a
          // different population cannot mislabel this row.
          mismatch: verdictLine(verdict, count),
          launchState: own(launch, identityId) || "",
          launchHint: launchHintFor(own(launch, identityId) || ""),
          launchRepairable: !!own(repairs, identityId)
        } });
        continue;
      }

      // A recorded occurrence with no window: a ghost, one per missing
      // instance, so a user with two recorded terminals and one running is told
      // that ONE of them is not running rather than that "terminal" is fine.
      var app = instanceBucket.recordedByOccurrence[occurrence];
      if (!app) continue;
      var where = placementLabel(app.monitorDescription, app.workspaceId, monitors);
      // A ghost sits where the RECORDING says it goes, resolved against the
      // monitors that are actually here — which is the only placement it has,
      // and exactly the one the recorded map draws it at.
      var ghostPlace = placementKeyForRecorded(app, monitors);

      if (!stillWatched) {
        // The recording refers to an identity nobody watches any more. If its
        // app happens to be running, say so on the row that already shows that
        // window rather than adding a second line for the same app — the
        // running row is also the one a click can actually re-watch.
        var host = own(unwatchedRowByDerivedId, identityId);
        if (host) {
          var folded = own(foldedOntoUnwatched, identityId);
          if (!folded) {
            folded = { base: host.position, count: 0 };
            foldedOntoUnwatched[identityId] = folded;
          }
          folded.count += 1;
          host.recordedUnwatched = true;
          host.position = folded.base
            + " · recorded" + (folded.count > 1 ? " ×" + folded.count : "")
            + " · no longer watched";
          continue;
        }
        entries.push({ place: ghostPlace, occurrence: occurrence, row: {
          key: "recorded:" + rowKey,
          identityId: identityId,
          className: "",
          linkKey: linkKey,
          name: name,
          watched: false,
          ghost: true,
          // Not clickable: there is no pattern left to re-watch from (see the
          // three-row-states note above), and a tick box that does nothing is
          // exactly the bug this row replaces.
          clickable: false,
          recordedUnwatched: true,
          awaitingTitle: false,
          occurrence: occurrence,
          instances: count,
          position: where + " · recorded · no longer watched",
          drifted: false,
          driftTo: "",
          // The row already says the whole of what is wrong with it.
          mismatch: "",
          launchState: "",
          launchHint: "",
          launchRepairable: false
        } });
        continue;
      }

      entries.push({ place: ghostPlace, occurrence: occurrence, row: {
        key: rowKey,
        identityId: identityId,
        className: "",
        linkKey: linkKey,
        name: name,
        watched: true,
        ghost: true,
        clickable: true,
        recordedUnwatched: false,
        awaitingTitle: false,
        occurrence: occurrence,
        instances: count,
        position: where + " · not running",
        drifted: false,
        driftTo: "",
        // "not running" is already in the position; the only thing a verdict
        // can add to a closed app's row is WHY the last cycle failed to open it.
        mismatch: (verdict && verdict.blockedBy) ? trim(verdict.blockedBy.reason) : "",
        // Launch is an IDENTITY-level fact: the command that opens a second
        // Gmail window is the command that opens the first, so every instance
        // row of an identity carries the same state and the same hint.
        launchState: own(launch, identityId) || "",
        launchHint: launchHintFor(own(launch, identityId) || ""),
        launchRepairable: !!own(repairs, identityId)
      } });
    }
  }

  // ---- watched identities waiting for a title ----------------------------
  //
  // The fourth row state (see above). These identities are on the watched list
  // and NOT in the instance index at all: no window resolves to them, and the
  // recording — if there is one — has never seen them either, because they were
  // created after the last Record and match nothing to record. So no loop above
  // can reach them, and without this pass the panel's only trace of them is the
  // awaitingTitleHint sentence, which explains the situation but cannot undo
  // it.
  //
  // Only with an identity list: without one there is nothing to enumerate, and
  // every caller that predates this gets exactly the rows it got before.
  if (haveIdentityList) {
    var awaiting = awaitingTitleIndex(list, identityList, resolver);
    for (var t = 0; t < identityList.length; t++) {
      var waiting = identityList[t];
      if (!waiting || typeof waiting.id !== "string" || !waiting.id) continue;
      if (!own(awaiting, waiting.id)) continue;
      // Belt and braces: an identity the index knows already has a row of its
      // own — a live one, or the recorded ghost above — and both are clickable.
      // A second row for it would be the same tick offered twice.
      if (own(index.byIdentity, waiting.id)) continue;
      var waitingState = own(launch, waiting.id) || "";
      // The class of the window that put this identity in the index — and so
      // whether the `--title` sentence is true about it (tick s7l).
      var waitingClass = own(awaiting, waiting.id) || "";
      entries.push({ place: UNPLACED, occurrence: 0, row: {
        // One window at most is ever waiting on one title, so this identity has
        // exactly one instance and spells its keys the bare single-window way.
        key: waiting.id,
        identityId: waiting.id,
        // No live window, so no class — the same "" the recorded ghosts carry,
        // and what makes a click on this row an untick by identity id.
        className: "",
        linkKey: instanceLinkKeyFor(waiting.id, "", 0, 1),
        name: instanceNameFor(waiting.id, 0, 1),
        watched: true,
        ghost: true,
        clickable: true,
        recordedUnwatched: false,
        awaitingTitle: true,
        occurrence: 0,
        instances: 1,
        // WHY it is not running, not just that it is not: an ordinary closed app
        // comes back when it is started again, and this one will not until
        // something about it changes. WHICH thing depends on the app (tick s7l):
        // a terminal needs a title of its own, and `--title` is how it gets one;
        // a chromium window has no such convention, and the true thing to say is
        // that its title patterns match nothing on screen. The exact command,
        // where there is one, is in the panel's hint line (awaitingTitleHint) —
        // saying it twice on a row with no room for it would crowd out the name.
        position: isTerminalClass(waitingClass)
          ? "not running · will match once relaunched with --title"
          : "not running · no " + waitingClass + " window matches its title patterns",
        drifted: false,
        driftTo: "",
        mismatch: "",
        launchState: waitingState,
        launchHint: launchHintFor(waitingState),
        launchRepairable: !!own(repairs, waiting.id)
      } });
    }
  }

  // A TOTAL order, on purpose. Placement first, then the occurrence (two
  // instances of one app can sit at the same spot on the map — a tab group, or
  // a rect the read did not carry), then the name, then the row key — which no
  // two rows share, so the result does not depend on whether the engine's sort
  // happens to be stable. Two panels looking at the same desktop must produce
  // the same list, and so must one panel looking at it twice.
  entries.sort(function (x, y) {
    var byPlace = comparePlacement(x.place, y.place);
    if (byPlace !== 0) return byPlace;
    if (x.occurrence !== y.occurrence) return x.occurrence < y.occurrence ? -1 : 1;
    if (x.row.name !== y.row.name) return x.row.name < y.row.name ? -1 : 1;
    if (x.row.key !== y.row.key) return x.row.key < y.row.key ? -1 : 1;
    return 0;
  });

  var rows = [];
  for (var e = 0; e < entries.length; e++) rows.push(entries[e].row);
  return rows;
}

// ---------------------------------------------------------------------------
// The keyboard cursor
// ---------------------------------------------------------------------------

// Every chip on the map, in the map's reading order: monitor (left to right),
// then workspace, then slot, then tab. Arrow keys walk this sequence — there
// is no grid to move around in, and pretending otherwise would make "right"
// mean something different on every monitor.
function flattenChips(map) {
  var out = [];
  var monitors = (map && isArray(map.monitors)) ? map.monitors : [];
  for (var i = 0; i < monitors.length; i++) {
    var workspaces = isArray(monitors[i].workspaces) ? monitors[i].workspaces : [];
    for (var w = 0; w < workspaces.length; w++) {
      var slots = isArray(workspaces[w].slots) ? workspaces[w].slots : [];
      for (var s = 0; s < slots.length; s++) {
        var chips = isArray(slots[s].chips) ? slots[s].chips : [];
        for (var c = 0; c < chips.length; c++) out.push(chips[c]);
      }
    }
  }
  return out;
}

// Where the chip cursor lands after one arrow press.
//
// The cursor is a chip KEY, not an index, because the map model is rebuilt
// from scratch by the panel's refresh timer — an index would quietly slide
// onto a different window every time hyprctl returned its clients in another
// order. A key is a window address: it either still exists or it does not,
// and a cursor whose chip closed starts again from the end it was moving
// towards rather than teleporting.
//
// Clamped rather than wrapped: the map is a picture of a desk, and running off
// the right edge back to the left is not how a desk behaves.
function nextCursorKey(chips, currentKey, delta) {
  var list = isArray(chips) ? chips : [];
  if (!list.length) return "";

  var step = Number(delta) < 0 ? -1 : 1;
  var index = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].key === currentKey) { index = i; break; }
  }
  if (index < 0) return step > 0 ? list[0].key : list[list.length - 1].key;

  var next = index + step;
  if (next < 0) next = 0;
  if (next > list.length - 1) next = list.length - 1;
  return list[next].key;
}

// Tab between the panel's focus sections, wrapping — a Tab chain is a loop
// even when a map is not.
function nextSection(order, current, direction) {
  var list = isArray(order) ? order : [];
  if (!list.length) return "";
  var index = list.indexOf(current);
  if (index < 0) index = 0;
  var step = Number(direction) < 0 ? -1 : 1;
  return list[(index + step + list.length) % list.length];
}

// The Tab chain itself, in reading order:
//
//   chips -> [failed] -> [learn] -> restore -> record -> [undo] -> pause -> ⋯
//
// Three sections are CONDITIONAL, and each is conditional on the thing it acts
// on existing: a Tab that stops on a button nobody drew is a dead keystroke,
// and the panel's whole keyboard promise ("everything in the panel is
// keyboard-reachable") is only true in the other direction too — nothing
// drawn may be unreachable.
//
// "failed" is the failed-restore list's Retry buttons, and it sits where the
// section is DRAWN: after the map, before the footer. It used to be missing
// entirely, which made Retry the one control in the panel a keyboard could not
// press (live verification, finding F4) — the more visible for being the
// control a user arrives at the panel to press.
//
// The pause switch and the ⋯ sit last though they are drawn first, in the
// header: Tab order here is by weight, not by pixel position. See Panel.qml's
// focusOrder for that argument in full.
//
// `opts` — { learnable, failed, canUndo }. `learnable` and `failed` are counts
// (0 means the button/section is not drawn); `canUndo` is a flag.
function panelFocusOrder(opts) {
  var o = opts || {};
  var out = ["chips"];
  if (Number(o.failed) > 0) out.push("failed");
  if (Number(o.learnable) > 0) out.push("learn");
  out.push("restore");
  out.push("record");
  if (o.canUndo) out.push("undo");
  out.push("pause");
  out.push("overflow");
  return out;
}

// ---------------------------------------------------------------------------
// Header, footer, empty state
// ---------------------------------------------------------------------------

// The status badge. Takes the glyph state StateModel already computed rather
// than re-deriving it, so the bar and the panel can never disagree about what
// is going on.
//
// `tone` is a role, not a colour: Panel.qml maps it onto theme tokens.
function badgeFor(glyphState, status) {
  var current = status || {};
  if (glyphState === "restoring") return { text: "Restoring…", tone: "accent" };
  // Same precedence as the bar glyph, and the same reason: the badge is a
  // one-phrase summary, and "Drifted (4)" over a switched-off tool describes a
  // repair that is not going to happen. The rows still carry the drift.
  if (glyphState === "paused") return { text: "Paused", tone: "muted" };
  if (glyphState === "hollow") return { text: "Not recorded", tone: "muted" };
  if (glyphState === "failed") return { text: "Restore failed", tone: "urgent" };
  if (glyphState === "drifted") return { text: "Drifted (" + (current.driftCount || 0) + ")", tone: "accent" };
  return { text: "In sync", tone: "ok" };
}

// The primary button says what it will do, including the fact that it
// overwrites — the UX sketch trades a confirmation dialog for a label that
// leaves no room for surprise.
function recordLabel(watchedCount, topologyName) {
  var count = Number(watchedCount) || 0;
  var where = trim(topologyName);
  if (count === 0) return "Record layout";
  return "Record " + count + (count === 1 ? " app" : " apps") + (where ? " for " + where : "");
}

// The repair button, which exists only while there is something to repair.
//
// It says the COUNT because that is the whole promise: press it and N apps
// that Restore could not bring back become apps it can. Identities nothing was
// derived for are excluded upstream (learnableCount), so the number never
// overstates.
function learnLaunchLabel(count) {
  var n = Number(count) || 0;
  if (n <= 0) return "";
  return "Learn launch (" + n + ")";
}

// Why Record is dimmed, or "" when it is not.
//
// Recording DURING a restore would file the half-moved desktop the cycle is
// still working on as the layout the cycle is restoring towards — the user's
// recording overwritten by a snapshot of its own restore, mid-flight. The
// button therefore goes out for the couple of seconds a cycle lasts, and says
// why: a control that dims with no explanation reads as broken.
//
// `capturing` is the second reason (tick ilg), and it is the same shape of
// reason: the previous Record's pictures are still being taken, one window at a
// time over a single compositor capture session, and a second round interleaved
// with the first would delete the first's files as it wrote them. It lasts about
// as long — a fraction of a second per window, bounded by the store's
// whole-queue deadline — and it says so for the same reason.
//
// RESTORING WINS when both hold: it is the one that also stops the Restore side
// of the panel, and two sentences in a one-line hint is a hint nobody reads.
function recordBlockedHint(restoring, capturing) {
  if (restoring) return "Restoring… Record is disabled until the restore finishes.";
  if (capturing) return "Taking this recording's pictures… Record is disabled until they are done.";
  return "";
}

// ---------------------------------------------------------------------------
// Tooltips for the controls
// ---------------------------------------------------------------------------
//
// Every control in the panel says what it does before it is pressed. These are
// pure functions and not QML string literals for the usual reason — a sentence
// a user reads is a thing that can be wrong, and a thing that can be wrong is a
// thing to test — plus one specific to a panel: the badge's tooltip and the
// badge's WORD have to agree about what is going on, and they now come from two
// functions reading the same glyph state.

// What the badge's one word actually means, and what to do about it.
//
// The badge says "Drifted (4)"; this says what drifted means and which of the
// two exits the sketch offers applies. It takes the same glyph state badgeFor
// does, so the badge and its explanation cannot describe different desktops.
// Break a one-line tooltip into lines that fit the panel.
//
// The shell's tooltip is a Text with no wrapMode, inside a ToolTip with no
// maximum width, and neither is reachable from here — the footer buttons build
// theirs inside Ui/Button.qml. Live verification caught the Record tooltip
// running ~380 device px past the right edge of the panel and floating over the
// desktop (docs/evidence/increment-03/m9u, Finding 2), which on a narrower
// screen would run off it entirely.
//
// So the wrap happens in the STRING, where the panel still owns it. Column
// count rather than pixels because that is all a builder can know; ~56 fits
// comfortably inside the panel's card at the caption sizes the tooltips use.
// Existing newlines are kept (a chip tooltip is already several lines), and a
// word longer than the limit is HARD-BROKEN into limit-sized chunks — a chip
// tooltip's class string (e.g. "chrome-www.rememberthemilk.com__app_-Profile_1",
// 46 chars, no spaces) has nothing else to break on, and left whole it pushed
// the popup ~100 logical px past the panel's left edge (evidence
// docs/evidence/increment-03/m9u/evidence.md Round 3, Finding 7). Cutting mid
// word beats a popup that floats off the panel.
var TOOLTIP_WRAP_COLUMNS = 56;

function wrapTooltip(text, columns) {
  var raw = (typeof text === "string") ? text : "";
  if (!raw) return "";
  var limit = Math.round(positiveOr(columns, TOOLTIP_WRAP_COLUMNS));
  if (limit < 8) limit = 8;

  var paragraphs = raw.split("\n");
  var out = [];
  for (var p = 0; p < paragraphs.length; p++) {
    var words = paragraphs[p].split(/\s+/);
    var line = "";
    for (var w = 0; w < words.length; w++) {
      var word = words[w];
      if (!word) continue;
      if (word.length > limit) {
        // Longer than a whole line by itself: flush whatever is pending,
        // then chop it into limit-sized chunks. The final, shorter chunk
        // becomes the new current line so a following short word can still
        // pack onto it, same as any other line.
        if (line) { out.push(line); line = ""; }
        var start = 0;
        while (word.length - start > limit) {
          out.push(word.substr(start, limit));
          start += limit;
        }
        line = word.substr(start);
        continue;
      }
      if (!line) { line = word; continue; }
      if (line.length + 1 + word.length <= limit) { line += " " + word; continue; }
      out.push(line);
      line = word;
    }
    out.push(line);
  }
  return out.join("\n");
}

function badgeTooltip(glyphState, status) {
  var current = status || {};
  if (glyphState === "restoring") {
    return "Putting the watched apps back where the recording says they go.";
  }
  if (glyphState === "paused") {
    return "Paused: monitor changes are ignored. Restore now still works, and drift is still measured.";
  }
  if (glyphState === "hollow") {
    return "No layout recorded for this setup yet. Arrange your windows, tick the ones you care about, then Record.";
  }
  if (glyphState === "failed") {
    var last = current.lastResult;
    var summary = (last && typeof last.summary === "string") ? trim(last.summary) : "";
    return "The last restore did not finish"
      + (summary ? " (" + summary + ")" : "")
      + ". The rows below say which apps it could not place.";
  }
  if (glyphState === "drifted") {
    var count = Number(current.driftCount) || 0;
    return count + (count === 1 ? " app is" : " apps are")
      + " not where the recording puts them. Restore now moves them back; Record layout files where they are instead.";
  }
  return "Every watched app is where the recording puts it.";
}

// May a manual restore actually FIRE? (tick 66x.)
//
// The one question behind every manual entry point — the footer's Restore now,
// a failed row's Retry, and the Enter that stands in for either — so that all
// three agree by construction instead of by three copies of the same `&&`.
//
// Two ways to answer no, and they are different in kind. Nothing recorded for
// this topology is an EMPTY state: there is no layout, so there is nothing to
// put back. A restore refusal is an INERT state: there is a layout, the file is
// readable, and this build has decided it may not act on what it read (a schema
// from the future, whose narrowing fields are stripped on the way in — see
// StateModel.restoreRefusal, and the same gate in Service.requestRestore, which
// is where a trigger written anyway would die). The service refuses either way;
// what this stops is the panel offering a lit button for it.
function mayManualRestore(hasLayout, restoreRefusalReason) {
  if (!hasLayout) return false;
  return trim(restoreRefusalReason) === "";
}

// The two footer actions, which are the two exits from drift — and each says
// which direction it moves things in, because that is the whole difference
// between them.
//
// `restoreRefusalReason` is optional and usually "": when it is not, the button
// is dim and the tooltip is the one place a pointer user gets the reason on
// demand (the panel's persistent Inert line is the other, always on screen).
function restoreTooltip(hasLayout, topologyName, restoreRefusalReason) {
  var inert = trim(restoreRefusalReason);
  var where = trim(topologyName);
  // Callers pass humanizeTopology's output, which is never "" — an empty
  // topology comes back as EMPTY_TOPOLOGY ("No monitors"), not "". Treat that
  // the same as empty, or a degenerate desk reads "for No monitors".
  if (!where || where === EMPTY_TOPOLOGY) where = "";
  // Ahead of the empty-layout branch: an inert file is the stronger refusal, and
  // saying "nothing recorded yet" about a file full of recordings this build has
  // decided it may not read would be the wrong sentence twice over.
  if (inert) return "Nothing will be restored: " + inert;
  if (!hasLayout) {
    return "Nothing recorded for " + (where || "this setup") + " yet — there is no layout to put back.";
  }
  return "Move every watched app to where the recording for " + (where || "this setup")
    + " puts it. Safe to press twice.";
}

function recordTooltip(watchedCount, topologyName, restoring, capturing) {
  if (restoring || capturing) return recordBlockedHint(restoring, capturing);
  var count = Number(watchedCount) || 0;
  var where = trim(topologyName);
  // Same EMPTY_TOPOLOGY fallback as restoreTooltip above.
  if (!where || where === EMPTY_TOPOLOGY) where = "";
  if (count === 0) {
    return "Nothing is watched yet — click the windows you care about on the map first.";
  }
  return "File where " + count + (count === 1 ? " watched app is" : " watched apps are")
    + " right now as the layout for " + (where || "this setup")
    + ". This replaces the previous recording for it.";
}

// The hero's meta line: what the tool thinks of this desk, and how much of it
// it is holding.
//
// It repeats the badge's word on purpose. The badge is one word carrying a
// TONE, which is the channel a glance actually uses and the only thing that
// says "in sync" and "restore failed" are different kinds of news; the meta
// line is the sentence, and the count is the half the badge has never had room
// for. "In sync" over an empty watched list is a true statement about nothing,
// and that is exactly the case the count makes visible.
// `extra` is one more clause for the same line — the Recorded tab's age, which
// is a fact about what is on screen rather than about the desk.
function headerMeta(badgeText, watchedCount, extra) {
  var state = trim(badgeText);
  var count = Number(watchedCount);
  if (!isFinite(count) || count < 0) count = 0;
  var apps = count === 1 ? "1 app watched" : count + " apps watched";
  var line = state ? state + " · " + apps : apps;
  var tail = trim(extra);
  return tail ? line + " · " + tail : line;
}

// WHEN THE RECORDED LAYOUT WAS RECORDED, in words.
//
// From the recording's OWN `recordedAt` — a field the schema has carried since
// v1 and StateModel.normalizeLayout preserves — and never from a file mtime.
// WHY not the mtime is written out once, in tests/acceptance/README.md under
// "Absent vs `null` — the normative statement"; it is the payload contract's
// section and this line is one of its consumers.
//
// `nowMs` is passed in. This file is clock-free (see CLAUDE.md), and that is
// also what makes every case below testable rather than observable.
//
// "" for a recording that carries no timestamp: there is genuinely nothing to
// say, and the header says nothing rather than guessing. The caller keeps the
// difference between that and NO RECORDING AT ALL — the payload spells the
// first `null` and the second absent.
//
// A stamp in the FUTURE is not clamped to "just now". A layout recorded on
// another machine, or before a clock correction, would then read as fresh when
// it is the one thing it cannot be known to be; the day it names is the honest
// answer instead. A minute of skew is tolerated, because that is a clock being
// a clock rather than a recording being from the future.
var RECORDED_FUTURE_TOLERANCE_MS = 60 * 1000;
var MINUTE_MS = 60 * 1000;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;

function plural(count, word) {
  return count + " " + word + (count === 1 ? "" : "s");
}

function recordedAgeLabel(recordedAt, nowMs) {
  var stamp = (typeof recordedAt === "string") ? trim(recordedAt) : "";
  if (!stamp) return "";
  var then = Date.parse(stamp);
  if (!isFinite(then)) return "";
  var now = Number(nowMs);
  if (!isFinite(now)) return "";

  var age = now - then;
  if (age < -RECORDED_FUTURE_TOLERANCE_MS) {
    // Name the day rather than an age nobody can act on. The ISO stamp's own
    // date part, so this says the same thing the file says.
    return "recorded " + stamp.slice(0, 10);
  }
  if (age < MINUTE_MS) return "recorded just now";
  if (age < HOUR_MS) return "recorded " + plural(Math.floor(age / MINUTE_MS), "minute") + " ago";
  if (age < DAY_MS) return "recorded " + plural(Math.floor(age / HOUR_MS), "hour") + " ago";
  var days = Math.floor(age / DAY_MS);
  if (days < 30) return "recorded " + plural(days, "day") + " ago";
  // THE MONTH BUCKET IS CLAMPED AT ELEVEN, and that is the fix for a cosmetic
  // bug the epic c7f retro caught: 360 to 364 days is `days < 365` and
  // `floor(days / 30)` is 12, so the label read "12 months ago" — a unit nobody
  // uses out loud, and one the very next day replaces with "1 year ago".
  //
  // Clamped rather than moved to a 360-day year, because every other bucket here
  // FLOORS: a label may round an age down, never up, and 360 days is not a year
  // however close it reads. "11 months ago" is the same understatement "29 days
  // ago" makes at the other end of the same ladder, and the sequence stays
  // monotone across the boundary — 11 months, 11 months, then 1 year.
  if (days < 365) {
    return "recorded " + plural(Math.min(11, Math.floor(days / 30)), "month") + " ago";
  }
  return "recorded " + plural(Math.floor(days / 365), "year") + " ago";
}

// The header switch. It is ON when the tool is WORKING, which is the only
// polarity a switch with no label can carry: `paused` is the flag, and a switch
// that was on while the tool was off would be the control lying about itself.
function pauseSwitchChecked(paused) {
  return !paused;
}

// The header switch. Labelled with the ACT, so the tooltip carries the
// consequence.
function pauseTooltip(paused) {
  return paused
    ? "Act on monitor changes again."
    : "Ignore monitor changes. Restore now still works.";
}

function learnLaunchTooltip(count) {
  var n = Number(count) || 0;
  if (n <= 0) return "";
  return n + (n === 1 ? " watched app has" : " watched apps have")
    + " no launch command, so Restore can move them but never reopen them."
    + " Press to fill them in from the running process or the app's .desktop file.";
}

// The Live / Recorded toggle. Two pictures of the same desk, and the tooltip is
// where the difference is said out loud.
function viewToggleTooltip(showingRecorded, hasLayout) {
  if (!showingRecorded) return "What is on screen right now.";
  if (!hasLayout) return "Nothing recorded for this setup yet.";
  return "Where the saved layout puts things. Apps that are not running show as dashed ghosts.";
}

// ---------------------------------------------------------------------------
// The header overflow menu (tick gwa)
// ---------------------------------------------------------------------------
//
// The sketch's last unbuilt piece: "Overflow menu: list of recorded topologies
// (with mini monitor glyphs), forget this layout, re-record."
//
// TWO HALVES, and the difference between them is the whole design. The list is
// a MEMORY — every desk this plugin has been taught, named the way the header
// names the one in front of you — and it is informational only: there is no
// action on a topology you are not plugged into, because every act this panel
// has (record, restore, forget) is about the monitors on the desk right now,
// and a button that filed a recording for an absent desk would be recording a
// desktop nobody can see. The two ACTIONS underneath are therefore about the
// current topology alone, and say so.
//
// Neither action asks "are you sure" (interaction rules: the panel never
// blocks). Forget arms the same one-shot undo Record arms — see forgetUndoStash
// above — so the way out of a mis-click is the footer button that appears the
// moment the menu closes, not a dialog in front of the click.

function overflowTooltip() {
  return "More — every recorded layout, forget this one, re-record it.";
}

// How many monitors a topology KEY describes. The key is the join of the
// monitors' descriptions, which is the only record left of a desk that is not
// plugged in — there are no monitor objects to count for a topology you are not
// looking at, and that is exactly the row the glyph has to draw.
function topologyMonitorCount(topologyKey) {
  var key = trim(topologyKey);
  if (!key) return 0;
  var parts = key.split(TOPOLOGY_SEPARATOR);
  var count = 0;
  for (var i = 0; i < parts.length; i++) {
    if (trim(parts[i])) count += 1;
  }
  return count;
}

// One row per recorded topology. `layouts` is the caller's list of stored
// layout objects (StateModel owns the file's shape; this file never reads it).
//
// The CURRENT desk is hoisted to the top and marked, because it is the one the
// actions below the list act on — a marked row three places down would leave
// "Forget this layout" pointing at a row the eye never landed on.
function overflowMenuRows(layouts, currentKey, monitors) {
  var list = isArray(layouts) ? layouts : [];
  var current = trim(currentKey);
  var rows = [];
  var currentRow = null;

  for (var i = 0; i < list.length; i++) {
    var layout = list[i];
    if (!layout) continue;
    var key = trim(layout.topologyKey);
    if (!key) continue;
    var apps = isArray(layout.apps) ? layout.apps.length : 0;
    var monitorCount = topologyMonitorCount(key);
    var isCurrent = current !== "" && key === current;
    var row = {
      topologyKey: key,
      name: humanizeTopology(key, monitors),
      monitors: monitorCount,
      // The mini glyph: one outlined rectangle per monitor, three at most.
      // Beyond three the count is doing the work anyway, and a row of eight
      // little boxes is a picture of nothing.
      glyphs: Math.max(1, Math.min(3, monitorCount)),
      moreMonitors: monitorCount > 3,
      apps: apps,
      appLabel: apps + " app" + (apps === 1 ? "" : "s"),
      recordedAt: trim(layout.recordedAt),
      current: isCurrent,
      note: isCurrent ? "this setup" : ""
    };
    if (isCurrent) currentRow = row;
    else rows.push(row);
  }

  return currentRow ? [currentRow].concat(rows) : rows;
}

// The two acts, both about the CURRENT topology and both disabled with a
// sentence rather than hidden: a menu whose contents change shape depending on
// what is recorded is a menu the user has to re-read every time.
function overflowMenuActions(hasLayout, canRecord, topologyName) {
  var name = trim(topologyName);
  if (!name || name === EMPTY_TOPOLOGY) name = "this setup";
  return [
    {
      id: "forget",
      label: "Forget this layout",
      enabled: !!hasLayout,
      tooltip: hasLayout
        ? "Delete the recorded layout for " + name + "."
          + " Nothing is asked twice: an undo appears in the footer straight afterwards,"
          + " for as long as the panel stays open."
        : "Nothing is recorded for " + name + " yet, so there is nothing to forget."
    },
    {
      id: "rerecord",
      label: "Re-record",
      enabled: !!canRecord,
      tooltip: canRecord
        ? "Record what is on screen now for " + name + ", replacing the stored layout."
          + " The same single undo applies."
        : "There is nothing to record for " + name + " right now."
    }
  ];
}

function overflowMenuModel(layouts, currentKey, monitors, canRecord, topologyName) {
  var rows = overflowMenuRows(layouts, currentKey, monitors);
  var hasCurrent = rows.length > 0 && rows[0].current === true;
  var hint = "";
  if (!rows.length) hint = "No layouts recorded yet — Record layout files the first one.";
  else if (!hasCurrent) hint = "This setup is not recorded yet.";

  return {
    title: "Recorded layouts",
    rows: rows,
    actions: overflowMenuActions(hasCurrent, canRecord, topologyName),
    currentRecorded: hasCurrent,
    hint: hint
  };
}

// Keyboard support for any menu built here: the ids in order, the row behind an
// id, and where the cursor lands when the menu opens. The informational rows
// are NOT in this list — arrows walk what can be pressed, and a cursor that
// stopped on a line with no action would be a keyboard dead end.
function menuActionIds(actions) {
  var list = isArray(actions) ? actions : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && trim(list[i].id)) out.push(trim(list[i].id));
  }
  return out;
}

function menuAction(actions, id) {
  var list = isArray(actions) ? actions : [];
  var wanted = trim(id);
  if (!wanted) return null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && trim(list[i].id) === wanted) return list[i];
  }
  return null;
}

// The first action that can actually be pressed, falling back to the first one
// at all — an all-disabled menu still has to put the cursor somewhere.
function firstEnabledActionId(actions) {
  var list = isArray(actions) ? actions : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].enabled && trim(list[i].id)) return trim(list[i].id);
  }
  return list.length && list[0] ? trim(list[0].id) : "";
}

// The bar glyph's whole story in one line: WHICH desk, and what the plugin
// thinks of it.
//
// The glyph is a picture with no text — that is the point of it — so this is
// the only place the ambient half of the plugin can say which topology it is
// talking about. Without a topology (no monitors read yet, or a status file
// from before there was one) it falls back to naming the plugin, which is at
// least true.
// The DEFERRED-JOINS suffix (tick 97e). The glyph does not get a state of its
// own for it — the desk really is drifted, which is what `drifted` means, and a
// fourth picture for a condition that clears itself on the next unlock would be
// a symbol nobody learns. The words carry it instead, because "drifted (2)" on a
// desk whose group the tool DELIBERATELY did not rebuild is a true number with a
// misleading story: it reads as "the restore could not manage it" when the
// truth is "the restore is waiting for you to unlock".
//
// Suffixed onto whatever the glyph is already saying rather than replacing it,
// and skipped while a cycle is in flight or the tool is paused: "restoring…" and
// "paused" are statements about right now, and the joins are a statement about
// what happens next.
function deferredLockedSuffix(status) {
  return (status && status.deferredLocked === true)
    ? " — joins deferred until unlock" : "";
}

function barGlyphTooltip(glyphState, status, topologyName) {
  var current = status || {};
  var where = trim(topologyName);
  if (!where || where === EMPTY_TOPOLOGY) where = "Dock Recall";

  if (glyphState === "restoring") return where + " — restoring…";
  if (glyphState === "paused") {
    return where + " — paused (monitor changes are ignored; Restore still works)";
  }
  if (glyphState === "hollow") return where + " — no layout recorded";
  if (glyphState === "failed") {
    var last = current.lastResult;
    var summary = (last && typeof last.summary === "string") ? trim(last.summary) : "";
    return where + " — restore failed" + (summary ? " (" + summary + ")" : "")
      + deferredLockedSuffix(current);
  }
  if (glyphState === "drifted") {
    return where + " — drifted (" + (Number(current.driftCount) || 0) + ")"
      + deferredLockedSuffix(current);
  }
  return where + " — in sync" + deferredLockedSuffix(current);
}

// The empty state is a state of the IDENTITY LIST, not of the layout: a
// topology with nothing ticked has nothing worth recording, and the sketch
// asks for one hint line and a single lit action rather than a disabled panel.
function emptyStateHint(watchedCount) {
  if ((Number(watchedCount) || 0) > 0) return "";
  return "No apps watched yet — click the windows you care about, then record.";
}

// ---------------------------------------------------------------------------
// The toplevel bridge — hyprctl address to Wayland handle (ticks o2x, w25)
// ---------------------------------------------------------------------------
//
// Everything this plugin knows about a window comes from `hyprctl clients`,
// where a window IS its address: an opaque `0x…` string. Capturing a picture of
// that window needs something else entirely — a `Toplevel` handle from the
// Wayland foreign-toplevel protocol, which is what `ScreencopyView.captureSource`
// accepts and the only thing it accepts.
//
// `Quickshell.Hyprland`'s toplevel model is the join: each of its entries
// carries BOTH the hyprctl `address` and a `wayland` handle. So the bridge is a
// lookup, and this is its pure half — the matching, which has a right answer and
// therefore a test. ToplevelBridge.qml holds the part that cannot be pure: the
// live QObject, and THE CLOCK (see `classifyToplevels` below).
//
// It answers with kinds rather than a null, because they mean different things
// to a caller and this plugin refuses out loud (CLAUDE.md):
//
//   invalid  — the string is not an address at all. A bug in the caller.
//   missing  — a well-formed address the model does not have. Either the window
//              closed, or the model has not got to it yet — and which of those
//              it is, is not a question this file can answer. See
//              `classifyToplevels`.
//   unmapped — the model HAS it, but with no Wayland handle yet. Measured, tick
//              o2x: for ~1s after the shell starts, `Hyprland.toplevels` is
//              empty, then fills WITHOUT handles, then the handles arrive over
//              hyprland-toplevel-mapping-v1. Always worth retrying.

// An hyprctl address, in one spelling. Applied to BOTH sides of every
// comparison, which is the only reason a lookup works at all: the model's
// `HyprlandToplevel.address` has no `0x` prefix ("562be03ac9a0") where hyprctl
// prints one ("0x562be03ac9a0"), measured in tick o2x.
function normalizedAddress(value) {
  // A STRING, and only a string. `trim()` stringifies whatever it is handed, so
  // without this line `normalizedAddress(1234)` answered "0x1234": a number
  // that never came from hyprctl quietly became a valid address, and the caller
  // that passed the wrong thing was never told (tick w25).
  if (typeof value !== "string") return "";
  var address = trim(value).toLowerCase();
  if (!address.match(/^(0x)?[0-9a-f]+$/)) return "";
  var digits = address.indexOf("0x") === 0 ? address.slice(2) : address;
  // Leading zeros are not part of the number. Nothing prints them today, but
  // "0x0000562b…" and "0x562b…" are the same window, and without this they land
  // in different buckets — one of them the bucket a caller is told not to retry.
  return "0x" + digits.replace(/^0+(?=.)/, "");
}

// The QML toplevel model, copied into a plain array of { address, hasWayland }.
//
// Takes an ARRAY-LIKE deliberately. `Hyprland.toplevels.values` is a
// QVariant-wrapped V4Sequence: it indexes and has `.length`, but it is NOT an
// Array to `Object.prototype`, so `isArray()` — which everything else in this
// file guards with — would reject the only value this is ever called with
// (.tick/learnings.md § QML/JS boundary). Anything without a usable numeric
// length is an empty snapshot rather than a crash: the model is null for part
// of a shell's startup.
function toplevelSnapshot(values) {
  var out = [];
  // A string has a `.length` and indexes, and would otherwise snapshot as one
  // empty entry per character.
  if (!values || typeof values === "string") return out;
  var length = Number(values.length);
  if (!(length > 0)) return out;
  for (var i = 0; i < length; i++) {
    var entry = values[i];
    out.push({
      address: entry && typeof entry.address === "string" ? entry.address : "",
      hasWayland: !!(entry && entry.wayland)
    });
  }
  return out;
}

// The `addresses` argument, checked before anything is built out of it.
//
// `entries` has been copied out of the QML model since o2x; this side was not
// guarded at all, and the same QVariant wrapper arriving here made a whole
// batch read as "nothing to do, everything fine" — an empty plan with an empty
// refusal. That is the exact failure .tick/learnings.md records as having
// hidden a broken model for two live rounds, and it is the opposite of what
// this plugin does with an ambiguity (CLAUDE.md, "Refusals are a feature").
//
// Returns "" for a real Array — including an empty one, which is a legitimate
// "photograph nothing" — and a sentence naming the fix otherwise.
function toplevelAddressListRefusal(addresses) {
  if (isArray(addresses)) return "";
  if (addresses && typeof addresses !== "string"
      && typeof addresses.length === "number" && isFinite(addresses.length)
      && addresses.length >= 0) {
    return "Cannot picture anything: the address list arrived as a QML sequence "
      + "rather than a JavaScript array. Copy it out element by element before "
      + "it crosses into PanelModel.";
  }
  return "Cannot picture anything: no list of addresses was given.";
}



// entries: a PLAIN array (copy it out of the QML model first — a QVariant-wrapped
// V4Sequence is not an Array here, see the QML/JS boundary note in learnings) of
// { address, hasWayland }, in model order. Indices into it are what comes back,
// so the caller can pick the live object without this file ever touching one.
//
// addresses: the windows wanted, in the order wanted. Repeats are collapsed —
// a capture queue photographs a window once.
function resolveToplevels(entries, addresses) {
  var list = isArray(entries) ? entries : [];
  var wanted = isArray(addresses) ? addresses : [];
  var byAddress = {};
  var i;

  for (i = 0; i < list.length; i++) {
    var address = normalizedAddress(list[i] && list[i].address);
    // First wins: an address is unique in one Hyprland instance, and a later
    // duplicate could only be a stale entry the model has not dropped yet.
    if (address && own(byAddress, address) === undefined) {
      byAddress[address] = { index: i, hasWayland: !!(list[i] && list[i].hasWayland) };
    }
  }

  var out = { resolved: [], invalid: [], missing: [], unmapped: [] };
  var seen = {};
  var seenInvalid = {};

  for (i = 0; i < wanted.length; i++) {
    var raw = wanted[i];
    var key = normalizedAddress(raw);
    if (!key) {
      // De-duplicated like the good addresses are: a queue that asks for the
      // same junk string twice has one bug, and the refusal should say "1 not
      // an address", not "2".
      var label = trim(raw);
      if (own(seenInvalid, label) === undefined) {
        seenInvalid[label] = true;
        out.invalid.push(label);
      }
      continue;
    }
    if (own(seen, key) !== undefined) continue;
    seen[key] = true;

    var found = own(byAddress, key);
    if (found === undefined) { out.missing.push(key); continue; }
    if (!found.hasWayland) { out.unmapped.push(key); continue; }
    out.resolved.push({ address: key, index: found.index });
  }

  return out;
}

// The taxonomy with TIME folded in — the one judgement resolveToplevels cannot
// make, and the reason `missing` used to be a lie.
//
// `Hyprland.toplevels` is EMPTY for about a second after a shell starts and
// then fills INCREMENTALLY (measured, tick o2x). So a well-formed address the
// model does not have means one of two opposite things, and no pure function
// can tell them apart, because the difference is elapsed time and this file is
// clock-free by rule (CLAUDE.md: the brain has no clock).
//
// `settled` is the caller's answer to "has the model finished filling in?".
// ToplevelBridge.qml owns the clock and works it out; this function only
// applies it. Given it, every address lands in exactly one bucket:
//
//   resolved — the model has it, with a handle. Done.
//   pending  — unmapped, or missing while the model is still filling. RETRY.
//   gone     — missing after the model settled. The window closed. PERMANENT.
//   invalid  — not an address at all. PERMANENT, and a bug in the caller.
//
// and the two questions a consumer actually has get separate answers:
//
//   decided — nothing here can change any more, so STOP POLLING. It is NOT
//             "everything worked": a closed window and a junk string are both
//             decided. This is the poll predicate.
//   ok      — everything worked.
//
// `asked` is how many distinct addresses were understood, so "nothing was
// asked" is distinguishable from "everything worked" — both of which otherwise
// present as an empty refusal.
function classifyToplevels(entries, addresses, settled) {
  var plan = resolveToplevels(entries, addresses);
  var pending = [];
  var gone = [];
  var i;

  for (i = 0; i < plan.unmapped.length; i++) pending.push(plan.unmapped[i]);
  for (i = 0; i < plan.missing.length; i++) {
    if (settled) gone.push(plan.missing[i]);
    else pending.push(plan.missing[i]);
  }

  return {
    resolved: plan.resolved,
    invalid: plan.invalid,
    missing: plan.missing,
    unmapped: plan.unmapped,
    pending: pending,
    gone: gone,
    settled: !!settled,
    asked: plan.resolved.length + plan.invalid.length
      + plan.missing.length + plan.unmapped.length,
    decided: pending.length === 0,
    ok: pending.length === 0 && gone.length === 0 && plan.invalid.length === 0
  };
}

// One resolved entry, re-checked against the live model row its index points
// at. Pure so the rule has a test; the QML side reads the row and passes what
// it found.
//
// The index came out of a SNAPSHOT, and the model moves. It does not only drop
// entries: a reorder leaves a perfectly live handle at that index belonging to
// a DIFFERENT window, and a caller handed that would photograph the wrong
// window under the address it asked for and have no way to notice. So the
// address is re-checked, not just the handle's existence.
function toplevelHandleStillValid(want, rowAddress, rowHasWayland) {
  if (!want || !rowHasWayland) return false;
  return normalizedAddress(rowAddress) === want.address;
}

// The one line a refusal needs. Empty only when nothing failed, so a caller can
// use it as the condition as well as the message — but `asked` is what says
// whether anything was attempted at all.
//
// Reads the time-aware buckets when they are there and falls back to the raw
// plan's `missing`/`unmapped` when they are not, so handing this a bare
// `resolveToplevels` result still refuses out loud instead of answering "".
//
// `waitedMs`, when positive, says the pending ones ran out of time rather than
// simply not being ready yet — the difference between "ask again in a moment"
// and "this window is never going to answer" (tick o2x: a monitor that is not
// rendering never delivers a frame).
function toplevelBridgeRefusal(verdict, waitedMs) {
  if (!verdict) return "";
  var parts = [];
  var waited = Number(waitedMs) || 0;
  var invalid = isArray(verdict.invalid) ? verdict.invalid : [];
  var gone = isArray(verdict.gone) ? verdict.gone
    : (isArray(verdict.missing) ? verdict.missing : []);
  var pending = isArray(verdict.pending) ? verdict.pending
    : (isArray(verdict.unmapped) ? verdict.unmapped : []);
  if (invalid.length) parts.push(invalid.length + " not an address");
  if (gone.length) parts.push(gone.length + " no longer open");
  if (pending.length) {
    parts.push(waited > 0
      ? pending.length + " still not ready to capture after " + waited + "ms"
      : pending.length + " not ready to capture yet");
  }
  if (!parts.length) return "";
  return "Cannot picture " + parts.join(", ") + ".";
}

// ---------------------------------------------------------------------------
// The capture cache: what a picture is called, and which ones a Record takes
// ---------------------------------------------------------------------------
//
// Pictures live in ~/.cache/omarchy/dock-recall/ and NOT in the state file.
// That is a product decision, not a filesystem one: a cache is a directory a
// cleaner is allowed to wipe, the correct behaviour when it does is that the
// map falls back to icons, and keeping the pixels out of the state file
// preserves the README's "writes one state file" promise byte for byte. If
// losing a picture broke anything it would have to join the atomic write, and
// that property would be gone.
//
// THE KEY is (identityId, occurrence, topologyKey) — the tuple
// engine.buildLayout already makes unique for one recording. Identity alone
// would give two windows of one app the same picture; leaving the topology out
// would make the laptop's recording and the docked one overwrite each other.
//
// THE NAME has to survive being a filename and being handed to `find`, and both
// of its variable parts come from places a user can type into: an identity id is
// hand-editable in the state file, and a topology key is built from monitor
// descriptions an EDID supplies. So neither is used raw. The topology becomes a
// hash, which also gives eviction the one thing it needs — every picture of one
// recording shares a leading segment, so "forget this layout" is a single
// prefixed `find`. The identity keeps a readable, sanitized fragment for anyone
// looking at the directory, plus its own hash so two ids that sanitize to the
// same characters still get different files.
//
// A hash collision on the topology (1 in 2^32) would make two desks share a
// prefix and evict each other's pictures. The cost is a lost cache entry and a
// map that falls back to icons, which is the same outcome as a cleaner running
// — so it is a tolerable failure rather than a corruption, and it is written
// down here rather than left to be discovered.

var CAPTURE_SUFFIX = ".jpg";
var CAPTURE_ID_CHARS = 40;

// FNV-1a, 32-bit, as 8 hex digits. Not a security hash and not asked to be —
// it is a short, stable, dependency-free name for an arbitrary string.
//
// The multiply is written as shifts and adds because ES5 has no 32-bit multiply:
// `hash * 16777619` exceeds 2^53 for a large hash and silently loses low bits,
// which would make the name depend on floating-point rounding.
function captureHash(text) {
  var s = (text === undefined || text === null) ? "" : String(text);
  var hash = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    hash = (hash ^ s.charCodeAt(i)) >>> 0;
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  var hex = hash.toString(16);
  while (hex.length < 8) hex = "0" + hex;
  return hex;
}

// One path segment, safe by construction. Anything outside [A-Za-z0-9._-]
// becomes "_", which is what turns `../../etc/passwd` into a name and not a
// traversal, and a leading "-" or "." is replaced too — the first would read as
// a flag to the tools that clean this directory up, the second would hide the
// file and, as "..", would name the parent.
function captureSafeSegment(text, cap) {
  var s = (text === undefined || text === null) ? "" : String(text);
  var limit = (typeof cap === "number" && cap > 0) ? cap : CAPTURE_ID_CHARS;
  var out = "";
  for (var i = 0; i < s.length && out.length < limit; i++) {
    var ch = s.charAt(i);
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : "_";
  }
  if (out === "") return "_";
  var first = out.charAt(0);
  if (first === "-" || first === ".") out = "_" + out.substring(1);
  return out;
}

// Every picture of one recording starts with this. Eviction is exactly "delete
// the files under this prefix", which is why the topology segment is first and
// alone.
function captureTopologyPrefix(topologyKey) {
  return captureHash(topologyKey) + "-";
}

// The file one (identity, occurrence) of one recording is stored as. "" for an
// entry with no identity, which is not a thing a layout carries — the guard is
// so a caller cannot build a name that is only a prefix and then hand it to
// something that treats it as one.
function captureFileName(identityId, occurrence, topologyKey) {
  var id = (typeof identityId === "string") ? trim(identityId) : "";
  if (!id) return "";
  return captureTopologyPrefix(topologyKey)
    + captureSafeSegment(id, CAPTURE_ID_CHARS) + "-" + captureHash(id)
    + "-" + occurrenceOf(occurrence) + CAPTURE_SUFFIX;
}

// WHICH PICTURES A RECORD SHOULD TAKE, and which it deliberately will not.
//
// One entry per app in the layout that was just committed, so the pictures and
// the recording describe the same moment and the same windows. The window each
// entry names comes from engine.chosenWindows — the SAME index buildLayout
// numbered the occurrences with — rather than from a second matching pass here:
// a picture filed under occurrence 1 that photographed the window buildLayout
// called occurrence 0 would be a lie the map could never detect.
//
// `skipped` is not an error list. "not-pictured" is the normal, intended answer
// for every app whose second consent is withheld, and it is the majority of a
// healthy plan; "no-window" is an app the recording carries but the desk no
// longer does. Both are reported so a caller can say what it did rather than
// only what it managed.
//
// A layout with no topologyKey plans nothing: without one there is no prefix,
// and a picture with no prefix could not be evicted with the recording.
function capturePlan(layout, identities, chosen) {
  var topologyKey = (layout && typeof layout.topologyKey === "string") ? layout.topologyKey : "";
  if (!topologyKey) return { topologyKey: "", prefix: "", captures: [], skipped: [] };

  var apps = (layout && isArray(layout.apps)) ? layout.apps : [];
  var list = isArray(identities) ? identities : [];
  var pictured = {};
  for (var i = 0; i < list.length; i++) {
    // `=== true` and nothing looser: this is the read of a CONSENT, and the
    // same rule StateModel.normalizeIdentity applies to the file.
    if (list[i] && typeof list[i].id === "string" && list[i].pictured === true) {
      pictured[list[i].id] = true;
    }
  }

  var byId = (chosen && chosen.byId) ? chosen.byId : {};
  var captures = [];
  var skipped = [];
  for (var a = 0; a < apps.length; a++) {
    var app = apps[a];
    var identityId = (app && typeof app.identityId === "string") ? trim(app.identityId) : "";
    if (!identityId) continue;
    var occurrence = occurrenceOf(app.occurrence);

    if (!own(pictured, identityId)) {
      skipped.push({ identityId: identityId, occurrence: occurrence, reason: "not-pictured" });
      continue;
    }

    // own(), never a bare lookup: for an id like "constructor" a bare read
    // answers with Object.prototype's member — truthy, and not a window list
    // (.tick/learnings.md, tick 8hp).
    var windows = own(byId, identityId);
    var client = (windows && windows[occurrence]) ? windows[occurrence] : null;
    var address = client ? trim(client.address) : "";
    if (!address) {
      skipped.push({ identityId: identityId, occurrence: occurrence, reason: "no-window" });
      continue;
    }

    captures.push({
      identityId: identityId,
      occurrence: occurrence,
      address: address,
      file: captureFileName(identityId, occurrence, topologyKey)
    });
  }

  return {
    topologyKey: topologyKey,
    prefix: captureTopologyPrefix(topologyKey),
    captures: captures,
    skipped: skipped
  };
}

// What a finished capture round says in the log. A sentence rather than a count
// because the interesting number is which of four things happened, and a caller
// assembling it inline would say it differently at each of its call sites.
//
// Best-effort is stated OUT LOUD: a record whose pictures all failed is still a
// good record, and the line has to read that way rather than as a failure.
// A FAILURE SAYS WHY. The reasons are the whole diagnostic value of this line:
// "no-frame" is a window on a monitor that is not rendering (the one real
// failure mode this feature has), "no-handle" is a window that closed between
// the record and the capture, "save-failed" is a disk that would not take it.
// Without them the line is "1 could not be captured" and the next person has
// nothing to go on.
function captureLogLine(plan, results) {
  var list = isArray(results) ? results : [];
  var taken = 0;
  var failed = 0;
  var reasons = [];
  var seenReason = {};
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].ok === true) {
      taken++;
      continue;
    }
    failed++;
    var reason = (list[i] && list[i].reason) ? String(list[i].reason) : "unknown";
    if (!own(seenReason, reason)) {
      seenReason[reason] = true;
      reasons.push(reason);
    }
  }
  var withheld = 0;
  var gone = 0;
  var skipped = (plan && isArray(plan.skipped)) ? plan.skipped : [];
  for (var s = 0; s < skipped.length; s++) {
    if (skipped[s] && skipped[s].reason === "no-window") gone++; else withheld++;
  }

  var parts = [taken + " picture(s) stored"];
  if (failed) parts.push(failed + " could not be captured (" + reasons.join(", ") + ")");
  if (withheld) parts.push(withheld + " not pictured");
  if (gone) parts.push(gone + " no longer open");
  return parts.join(", ");
}

// The basenames a directory listing came back with, as a set. `find -printf
// '%f\n'` is what produces it, and a missing cache directory produces nothing
// at all — which is the correct answer and not an error: a wiped cache means
// the map falls back to icons.
function captureFileIndex(listing) {
  var out = {};
  var lines = String(listing === undefined || listing === null ? "" : listing).split("\n");
  for (var i = 0; i < lines.length; i++) {
    var name = trim(lines[i]);
    if (name) out[name] = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE FIRST-RECORD DIALOGUE (tick y28)
// ---------------------------------------------------------------------------
//
// WHAT IT IS, AND WHAT IT IS NOT. It is an ONBOARDING MOMENT that demonstrates
// the feature, not a warning label. The user has already granted the per-app
// consent (the camera on the row), a Record has just happened, and the pictures
// exist — so the panel shows them THE PICTURES IT JUST TOOK and asks what they
// think. That framing is the whole reason it shows thumbnails rather than
// describing what a thumbnail would be: a sentence about photographs of your
// windows is a scary abstraction, and three photographs of your own windows is
// a thing you can look at and have an opinion about.
//
// It is asked ONCE. The answer lives in the state file
// (StateModel.pictureConsent, schema v6), so it survives a shell restart, and
// "unasked" is the only value that brings it back.
//
// WHY THE PICTURES ARE TAKEN FIRST. There is no honest way to show somebody
// their own captures before taking them, and the alternative — describing the
// feature and asking permission in the abstract — is exactly the warning label
// the design rejects. The per-app camera is what authorises the capture; this
// asks whether the RESULT is what the user expected, with an answer ("Not for
// these apps") that takes it back.

// The three answers, in the order they are drawn and tabbed through.
//
// Shaped like an overflow-menu action list — `{id, label, tooltip, enabled}` —
// so menuActionIds, menuAction, firstEnabledActionId and nextSection drive this
// prompt's cursor without a second navigation vocabulary. They are all always
// enabled: a prompt with a dimmed answer is a question whose answer the asker
// has already decided.
//
// The ORDER is the design's: the affirming answer first, because it is the one
// the user is most likely to want and the one the moment is for, then the two
// refusals in order of scope. Nothing here is a default — there is no preselect
// beyond "the cursor starts on the first" — and Escape is not an answer.
function consentChoices() {
  return [
    {
      id: "keep",
      label: "Keep pictures",
      tooltip: "Keep these pictures and go on taking one for each app whose camera"
        + " is on. You can switch any app's camera off later.",
      enabled: true
    },
    {
      id: "not-these",
      label: "Not for these apps",
      tooltip: "Delete the pictures just taken and switch the camera off for these"
        + " apps. Other apps are unaffected, and this is not asked again.",
      enabled: true
    },
    {
      id: "none",
      label: "No pictures",
      tooltip: "Delete every picture this plugin has stored and switch off every"
        + " app's camera. Nothing is photographed again unless you switch a"
        + " camera back on.",
      enabled: true
    }
  ];
}

// Is `answer` one of the three? The IPC verb asks it, so a caller cannot answer
// the prompt with a word the panel would then have to interpret.
function isConsentChoice(answer) {
  var wanted = trim(answer);
  var choices = consentChoices();
  for (var i = 0; i < choices.length; i++) {
    if (choices[i].id === wanted) return true;
  }
  return false;
}

// The captures a finished round actually STORED, in the order they were taken —
// the thumbnails the prompt shows, and the apps "Not for these apps" is about.
//
// The successes and nothing else. A round's results carry every planned capture
// including the ones that failed, and a strip with a hole in it where a window
// on a sleeping monitor should be would be a prompt asking about a picture that
// does not exist. `identityId` and `occurrence` are carried through because the
// map keys on the pair and the panel resolves the file the same way it resolves
// a chip's.
function consentCaptureEntries(results) {
  var list = isArray(results) ? results : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var result = list[i];
    if (!result || result.ok !== true) continue;
    var identityId = trim(result.identityId);
    if (!identityId) continue;
    out.push({
      identityId: identityId,
      occurrence: occurrenceOf(result.occurrence),
      file: trim(result.file)
    });
  }
  return out;
}

// The identities the strip is showing, deduped and in first-seen order. What
// "these apps" means, said once, so the button's label and the write it performs
// cannot describe two different sets.
function consentIdentityIds(entries) {
  var list = isArray(entries) ? entries : [];
  var out = [];
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var id = list[i] ? trim(list[i].identityId) : "";
    if (!id || own(seen, id)) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

// SHOULD THE PROMPT OPEN? Asked when a capture round finishes, and the one place
// the rule lives.
//
// Two conditions, and the second is not the one the DoD's sentence suggests.
// "The first Record with picturable apps" is the case this fires in, but the
// test is on the pictures that were actually STORED, not on the plan: a round
// where every capture failed (a window on a monitor that is not rendering, the
// one real failure mode this feature has) has nothing to show, and a
// three-choice dialogue over an empty strip is precisely the warning label this
// moment is not. The user is asked at the next Record that produces something,
// which is the first moment there is anything to ask about.
function consentPromptDue(answer, entries) {
  if (consentAnswered(answer)) return false;
  return (isArray(entries) ? entries : []).length > 0;
}

// Has the question been answered at all? A copy of
// StateModel.pictureConsentAsked, spelled out here rather than imported:
// PanelModel and StateModel are siblings and neither may require the other, so
// the two spellings are pinned against each other in tests/panel.test.js — the
// same arrangement TERMINAL_BINARIES already lives under.
function consentAnswered(answer) {
  var word = trim(answer);
  return word === "keep" || word === "not-these" || word === "none";
}

// What the prompt says above the strip, and what it says under it.
//
// The title names what happened, in the past tense, because it already has:
// the Record is on disk and so are the pictures. The body is one sentence about
// what they are FOR, because a picture of your own window is self-explanatory
// and a cache under ~/.cache is not.
function consentTitle(count) {
  var n = (typeof count === "number" && isFinite(count) && count > 0) ? Math.round(count) : 0;
  if (n === 1) return "Dock Recall took a picture of this window";
  return "Dock Recall took pictures of these " + n + " windows";
}

function consentBody() {
  return "They are stored on this machine, under ~/.cache, and drawn on the"
    + " Recorded map so you can see which window was where. They are replaced"
    + " when you record again and deleted when you forget the layout.";
}

// The log line each answer leaves. One sentence per answer, naming what it DID
// rather than which button was pressed — the log is read by somebody asking
// what happened to their files.
function consentAnswerLine(answer, identityIds) {
  var ids = isArray(identityIds) ? identityIds : [];
  if (answer === "keep") {
    return "pictures kept — " + ids.length + " app(s) go on being photographed at Record";
  }
  if (answer === "not-these") {
    return "no pictures for " + (ids.length ? "\"" + ids.join("\", \"") + "\"" : "these apps")
      + " — their cameras are off and the pictures just taken are deleted";
  }
  if (answer === "none") {
    return "no pictures at all — every camera is off and every stored picture is deleted;"
      + " switch a camera back on to change that";
  }
  return "";
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizedAddress: normalizedAddress,
    toplevelSnapshot: toplevelSnapshot,
    toplevelAddressListRefusal: toplevelAddressListRefusal,
    resolveToplevels: resolveToplevels,
    classifyToplevels: classifyToplevels,
    toplevelHandleStillValid: toplevelHandleStillValid,
    toplevelBridgeRefusal: toplevelBridgeRefusal,
    captureHash: captureHash,
    captureSafeSegment: captureSafeSegment,
    captureTopologyPrefix: captureTopologyPrefix,
    captureFileName: captureFileName,
    capturePlan: capturePlan,
    captureLogLine: captureLogLine,
    captureFileIndex: captureFileIndex,
    consentChoices: consentChoices,
    isConsentChoice: isConsentChoice,
    consentCaptureEntries: consentCaptureEntries,
    consentIdentityIds: consentIdentityIds,
    consentPromptDue: consentPromptDue,
    consentAnswered: consentAnswered,
    consentTitle: consentTitle,
    consentBody: consentBody,
    consentAnswerLine: consentAnswerLine,
    // Exported for the QML side as much as for the tests: an identity-id lookup
    // in Panel.qml has to go through this too (tick 8hp).
    own: own,
    escapeRegex: escapeRegex,
    titleCase: titleCase,
    shortMonitorLabel: shortMonitorLabel,
    humanizeTopology: humanizeTopology,
    chromeStem: chromeStem,
    derivePattern: derivePattern,
    deriveTitlePattern: deriveTitlePattern,
    deriveIdentityId: deriveIdentityId,
    identityIdFromTitle: identityIdFromTitle,
    displayNameFor: displayNameFor,
    suggestIdentity: suggestIdentity,
    toggleWatchedIdentities: toggleWatchedIdentities,
    tickOutcome: tickOutcome,
    sharesClassPattern: sharesClassPattern,
    insertionIndexFor: insertionIndexFor,
    tickRefusalReason: tickRefusalReason,
    tickRefusalHint: tickRefusalHint,
    awaitingTitleHint: awaitingTitleHint,
    awaitingTitleCandidates: awaitingTitleCandidates,
    awaitingTitleIndex: awaitingTitleIndex,
    shadowNoticeFor: shadowNoticeFor,
    shadowedIdentityHint: shadowedIdentityHint,
    shellQuoteArg: shellQuoteArg,
    dispatchableCommand: dispatchableCommand,
    learnableLaunch: learnableLaunch,
    singleLaunchRepair: singleLaunchRepair,
    parseProcCmdline: parseProcCmdline,
    isBrowserFamilyClass: isBrowserFamilyClass,
    windowCountByPid: windowCountByPid,
    isSharedProcessPid: isSharedProcessPid,
    argvLooksNulLess: argvLooksNulLess,
    launchCommandFromArgv: launchCommandFromArgv,
    desktopExecCommand: desktopExecCommand,
    parseDesktopEntry: parseDesktopEntry,
    desktopClassCandidates: desktopClassCandidates,
    desktopBasename: desktopBasename,
    urlHost: urlHost,
    desktopWebappHost: desktopWebappHost,
    desktopWebappClassCandidate: desktopWebappClassCandidate,
    patternLiteral: patternLiteral,
    wmClassFuzzyMatches: wmClassFuzzyMatches,
    parsedDesktopEntries: parsedDesktopEntries,
    matchDesktopEntry: matchDesktopEntry,
    launchFromDesktopFiles: launchFromDesktopFiles,
    launchFromDesktopFilesForClass: launchFromDesktopFilesForClass,
    iconNameFromDesktopFiles: iconNameFromDesktopFiles,
    iconNameIndex: iconNameIndex,
    clientClassKey: clientClassKey,
    iconNameFor: iconNameFor,
    identitiesNeedingLaunch: identitiesNeedingLaunch,
    shellWords: shellWords,
    launchLooksBroken: launchLooksBroken,
    launchRepairIndex: launchRepairIndex,
    launchDerivation: launchDerivation,
    procTreeFromDump: procTreeFromDump,
    isTerminalClass: isTerminalClass,
    terminalExecFlag: terminalExecFlag,
    isShellArgv: isShellArgv,
    titleFromArgv0: titleFromArgv0,
    terminalChildDerivation: terminalChildDerivation,
    titleFromOwnArgv: titleFromOwnArgv,
    terminalTickDerivation: terminalTickDerivation,
    terminalPids: terminalPids,
    clientForTick: clientForTick,
    refusalStillLive: refusalStillLive,
    backfillLaunchCommands: backfillLaunchCommands,
    learnableCount: learnableCount,
    launchAutofillIndex: launchAutofillIndex,
    autofillLaunchCommands: autofillLaunchCommands,
    autofillLaunchLog: autofillLaunchLog,
    launchRequestFor: launchRequestFor,
    addedIdentity: addedIdentity,
    learnLaunchLabel: learnLaunchLabel,
    launchStateIndex: launchStateIndex,
    launchHintFor: launchHintFor,
    parseSectionedDump: parseSectionedDump,
    desktopFilesFromDump: desktopFilesFromDump,
    argvByPidFromDump: argvByPidFromDump,
    isRotated: isRotated,
    logicalSize: logicalSize,
    logicalRect: logicalRect,
    geometryPair: geometryPair,
    windowRect: windowRect,
    mapGeometry: mapGeometry,
    workspaceKey: workspaceKey,
    focusedWorkspaceKey: focusedWorkspaceKey,
    workspaceGridLayout: workspaceGridLayout,
    monitorSectionWidths: monitorSectionWidths,
    chipRectsForCanvas: chipRectsForCanvas,
    chipTreatment: chipTreatment,
    MAP_BOX_MIN_WIDTH: MAP_BOX_MIN_WIDTH,
    MAP_BOX_MAX_WIDTH: MAP_BOX_MAX_WIDTH,
    CHIP_MIN_WIDTH: CHIP_MIN_WIDTH,
    CHIP_MIN_HEIGHT: CHIP_MIN_HEIGHT,
    CHIP_PILL_MIN_WIDTH: CHIP_PILL_MIN_WIDTH,
    CHIP_PILL_MIN_HEIGHT: CHIP_PILL_MIN_HEIGHT,
    CHIP_BADGE_MIN_WIDTH: CHIP_BADGE_MIN_WIDTH,
    CHIP_BADGE_MIN_HEIGHT: CHIP_BADGE_MIN_HEIGHT,
    CHIP_VEILED_MIN_WIDTH: CHIP_VEILED_MIN_WIDTH,
    CHIP_VEILED_MIN_HEIGHT: CHIP_VEILED_MIN_HEIGHT,
    CHIP_STRIP_MIN_WIDTH: CHIP_STRIP_MIN_WIDTH,
    CHIP_STRIP_MIN_HEIGHT: CHIP_STRIP_MIN_HEIGHT,
    wrapTooltip: wrapTooltip,
    placementLabel: placementLabel,
    livePlacementLabel: livePlacementLabel,
    linkKeyFor: linkKeyFor,
    chipLinkKey: chipLinkKey,
    rowLinkKey: rowLinkKey,
    driftTagFor: driftTagFor,
    refusalTagFor: refusalTagFor,
    refusalSentenceFor: refusalSentenceFor,
    refusalOfVerdict: refusalOfVerdict,
    REFUSAL_TAGS: REFUSAL_TAGS,
    chipTooltipText: chipTooltipText,
    rowTooltipText: rowTooltipText,
    verdictIndexByOccurrence: verdictIndexByOccurrence,
    driftIndexByAddress: driftIndexByAddress,
    occurrenceOf: occurrenceOf,
    occurrenceKey: occurrenceKey,
    instanceKeyFor: instanceKeyFor,
    instanceLinkKeyFor: instanceLinkKeyFor,
    instanceNameFor: instanceNameFor,
    instanceIndex: instanceIndex,
    verdictLine: verdictLine,
    recordUndoValid: recordUndoValid,
    recordUndoRestores: recordUndoRestores,
    undoStashAction: undoStashAction,
    forgetUndoStash: forgetUndoStash,
    undoRecordLabel: undoRecordLabel,
    undoRecordTooltip: undoRecordTooltip,
    failedRestoreRows: failedRestoreRows,
    failedRestoreTitle: failedRestoreTitle,
    BROWSER_LAUNCH_CAVEAT: BROWSER_LAUNCH_CAVEAT,
    retryTooltip: retryTooltip,
    verdictInstanceLabel: verdictInstanceLabel,
    chipFor: chipFor,
    slotsForClients: slotsForClients,
    liveMapModel: liveMapModel,
    recordedMapModel: recordedMapModel,
    appRows: appRows,
    flattenChips: flattenChips,
    nextCursorKey: nextCursorKey,
    nextSection: nextSection,
    panelFocusOrder: panelFocusOrder,
    badgeFor: badgeFor,
    badgeTooltip: badgeTooltip,
    mayManualRestore: mayManualRestore,
    restoreTooltip: restoreTooltip,
    recordTooltip: recordTooltip,
    headerMeta: headerMeta,
    recordedAgeLabel: recordedAgeLabel,
    pauseSwitchChecked: pauseSwitchChecked,
    pauseTooltip: pauseTooltip,
    learnLaunchTooltip: learnLaunchTooltip,
    viewToggleTooltip: viewToggleTooltip,
    overflowTooltip: overflowTooltip,
    topologyMonitorCount: topologyMonitorCount,
    overflowMenuRows: overflowMenuRows,
    overflowMenuActions: overflowMenuActions,
    overflowMenuModel: overflowMenuModel,
    menuActionIds: menuActionIds,
    menuAction: menuAction,
    firstEnabledActionId: firstEnabledActionId,
    barGlyphTooltip: barGlyphTooltip,
    deferredLockedSuffix: deferredLockedSuffix,
    recordLabel: recordLabel,
    recordBlockedHint: recordBlockedHint,
    emptyStateHint: emptyStateHint
  };
}
