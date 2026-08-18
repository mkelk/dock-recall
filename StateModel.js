// StateModel.js — the on-disk state file, as pure functions, plus the handful
// of live-read decisions the service needs (see the last section).
//
// Dual-runtime like engine.js: ES5 only, no dependencies, no ES modules, and a
// trailing `module.exports` behind a typeof guard so the same file runs under
// `node --test` and loads in QML as `import "StateModel.js" as StateModel`.
// No I/O in here — the service owns the FileView and hands text in and out.
//
// ---------------------------------------------------------------------------
// THE STATE FILE  ~/.local/state/omarchy/dock-recall.json
// ---------------------------------------------------------------------------
//
// This is THE CONTRACT between the service (reads it, restores from it) and
// the panel epic (writes it). Add fields; never repurpose one.
//
//   State {
//     version:    4                 // the schema generation. A file at an
//                                   // OLDER version is UPGRADED in place on the
//                                   // read (see "Migration" below); a file from
//                                   // the FUTURE keeps its own number and is
//                                   // still read, with parseState reporting the
//                                   // mismatch so the UI can warn.
//     paused:     false             // v2. The whole tool's on/off switch, owned
//                                   // by the panel's activate/deactivate
//                                   // control. `true` means the service ignores
//                                   // EVENT-triggered restore cycles (hotplug,
//                                   // settle passes); the MANUAL trigger file
//                                   // still runs a full cycle, and drift
//                                   // refreshes still publish status — pausing
//                                   // stops the tool from ACTING, it does not
//                                   // stop it from LOOKING. Lives in the state
//                                   // file rather than the status file because
//                                   // it is a user decision that must survive a
//                                   // shell restart.
//     identities: Identity[]        // ORDER IS PRIORITY ORDER — engine.js
//                                   // matchClient() returns the FIRST match, so
//                                   // specific webapp identities must sit
//                                   // before a catch-all browser identity, and
//                                   // reordering this list changes what gets
//                                   // recorded, not just what gets displayed
//     layouts:    { [topologyKey: string]: Layout }
//                                   // keyed by engine.topologyKey(monitors).
//                                   // The key is free text built from monitor
//                                   // descriptions joined with " | " — it
//                                   // contains spaces and punctuation, so it is
//                                   // a JSON object key and nothing else (never
//                                   // a filename, never a shell word)
//   }
//
//   Identity {
//     id:       string    // stable handle used by Layout.apps[].identityId.
//                         // Renaming an id orphans every recorded placement
//                         // that refers to it (they degrade to
//                         // status "skipped", reason "identity-unknown").
//     patterns: string[]  // regex SOURCE strings (plain JSON, no /slashes/),
//                         // matched case-insensitively against a client's
//                         // `class` and `initialClass`. A malformed pattern is
//                         // dropped by engine.compilePattern rather than
//                         // throwing — a typo in the UI must not brick restore.
//     titlePatterns:      // v4. The same kind of list: regex SOURCE strings,
//       string[]          // the same repair semantics as `patterns`, matched
//                         // against a client's `initialTitle` and NOTHING
//                         // ELSE. Not the live `title`, which changes as the
//                         // user works — an identity whose membership moved
//                         // under a window would record one desk and restore
//                         // another. `initialTitle` is set once, when the
//                         // window maps, and survives the app renaming itself.
//                         // It exists because a terminal launched to host one
//                         // app (`foot --title herdr`) cannot be told from a
//                         // plain terminal by class alone — both read `foot`.
//                         // [] means "this identity does not look at titles",
//                         // which is what every identity written before v4
//                         // means, and it is ALWAYS PRESENT (see Migration).
//     launch:   string    // shell command run to bring the app back when no
//                         // window matches. "" means "never launch this one" —
//                         // a legitimate choice for apps that must not be
//                         // started automatically, and the reason the restore
//                         // executor treats a launch-less identity as a
//                         // permanent miss instead of retrying.
//   }
//
//   Layout — exactly what engine.buildLayout() returns:
//     { topologyKey, recordedAt, apps: [ { identityId, occurrence,
//       monitorDescription, workspaceId, floating, group, at, size } ] }.  See
//     the schema block in engine.js; this file stores it verbatim, with these
//     exceptions:
//       - apps[].workspaceId is coerced to a number, because it is the only
//         recorded field that ends up inside a Lua dispatch string. See
//         normalizeWorkspaceId.
//       - apps[].occurrence (v3) is coerced to a non-negative integer, default
//         0. See normalizeOccurrence.
//       - apps[].at and apps[].size (v2) are coerced to a pair of finite
//         numbers or to null. See normalizeGeometry, and keep it in step with
//         engine.geometryPair — the two live in different files on purpose
//         (neither may import the other) and tests/state.test.js pins them to
//         the same answers.
//
//   Geometry (v2), per app entry:
//     at:   null | [x, y]   // the window's top-left in layout coordinates, as
//                           // hyprctl clients reports it, at RECORD time
//     size: null | [w, h]   // ditto, its width and height
//   null means "not known" — a v1 record upgraded to v2, or a live read where
//   the fields were missing. It is a legal, permanent value: consumers must
//   treat it as "nothing to compare against" (verdict word `not-scored`), never
//   as zero.
//   RESTORE PLANNING READS THESE FIELDS (since tick qkv), for entries recorded
//   `floating: true`: a float outside engine.GEOMETRY_TOLERANCE_PX of its
//   recorded rect is drift and plans a `geometry` op that resizes and moves it
//   back. For entries recorded tiled they are still measurement only. Which is
//   why normalizeGeometry must never invent numbers: whatever it returns here
//   can end up inside a dispatch. [0, 0] is passed through as the real value it
//   is — the planner, not the reader, is where an unusable rect is refused (see
//   engine.geometryPlanSkip).
//
//   Occurrence (v3), per app entry:
//     occurrence: number   // 0-based index of WHICH window of the identity
//                          // this entry describes. An identity with three
//                          // windows records three entries, occurrence 0, 1
//                          // and 2, assigned in the deterministic placement
//                          // order engine.placementComparator defines.
//   Every entry has one; a single-window identity records occurrence 0, which
//   is exactly what every pre-v3 entry meant without saying so. That is what
//   makes the v2 -> v3 migration a rename of an assumption rather than a change
//   of meaning. The identity of a placement is therefore the TUPLE
//   (identityId, occurrence), and GroupMembership is a tuple-aware statement
//   too: the same identity may appear twice in one group, at different
//   occurrences and different tab indexes.
//
// Migration (parseState / normalizeState do it, on every read):
//   v1 -> v2 is LOSSLESS and TOLERANT. Every v1 field is carried through
//   untouched, `paused` defaults to false, each app entry gains `at: null` and
//   `size: null` when it has no geometry, and `version` becomes 2. There is no
//   failure mode: a v1 file cannot be corrupted by being read, and a v1 file
//   that is read and written back differs from itself only by those additive
//   fields. Nothing writes v1 any more, and nothing needs to read v1 twice.
//
//   v2 -> v3 is the same kind of step and is applied by the same single pass:
//   every entry that does not carry an `occurrence` gains `occurrence: 0`, and
//   `version` becomes 3. Nothing else moves.
//
//   v3 -> v4 is the same kind of step again, one field further out: every
//   identity that does not carry `titlePatterns` gains `titlePatterns: []`, and
//   `version` becomes 4. No layout entry moves at all — this generation touches
//   identities only.
//
//   THE DELIBERATE CHOICE, v4: the empty list IS MATERIALIZED. normalizeIdentity
//   writes `titlePatterns` on every identity it returns, so a v3 file read and
//   written back gains a `"titlePatterns": []` line per identity rather than
//   keeping the key absent. That costs one line per identity in the file and
//   buys the thing every other field here already has: ONE shape. Consumers
//   (engine.matchClient, the panel's editor) never have to distinguish "absent"
//   from "empty", exactly as they never have to for `patterns: []` or
//   `launch: ""`, both of which have always been written whether the file said
//   so or not. Everything an identity DID say is carried through untouched: the
//   upgrade is purely additive, and pinned as such by tests/state.test.js.
//
//   A v1 file therefore CHAINS — v1 -> v2 -> v3 -> v4 in one read — because
//   normalizeLayout writes the v2 and v3 fields and normalizeIdentity writes the
//   v4 field unconditionally, so there are no intermediate states to sequence.
//   A v4 file read and written back is byte-identical to itself.
//
// Quirks the UI must know:
//   - layouts is a MAP keyed by topologyKey, and Layout.topologyKey repeats that
//     key inside the record. upsertLayout files a layout under its own
//     topologyKey, so the two can never disagree; a hand-edited file where they
//     do is repaired on the next upsert, not at read time.
//   - A missing file, an empty file and a corrupt file all read as the same
//     fresh default state. The service then WRITES that default back, so the
//     file always exists after the service has run once.
//   - Unknown top-level keys are DROPPED on the parse -> serialize round trip.
//     Anything the panel needs to persist has to be added to this schema; it
//     cannot be smuggled into the file as an extra key.
//
// ---------------------------------------------------------------------------
// THE STATUS FILE  ~/.local/state/omarchy/dock-recall.status.json
// ---------------------------------------------------------------------------
//
// The second contract, and the opposite direction of the first: the SERVICE
// writes it, the UI (bar glyph, panel badge) only ever reads it. It exists so
// the bar widget can render the ambient story without running a single
// hyprctl of its own — a FileView on one small file, no polling.
//
//   Status {
//     topologyKey: string        // engine.topologyKey(monitors) as the service
//                                // last saw it. "" is NEVER published: a read
//                                // that could not resolve a topology leaves
//                                // the previous status alone (see below).
//     topologyName: string       // the same desk, named the way the user thinks
//                                // of it ("Laptop + AOC U34G2G"). It is
//                                // PanelModel.humanizeTopology of the key
//                                // above, resolved by the SERVICE because the
//                                // service is the one holding the live monitor
//                                // list: without that list a built-in laptop
//                                // panel cannot be recognised and keeps its
//                                // part number. The bar widget has no monitor
//                                // list — running hyprctl is exactly the cost
//                                // this file exists to avoid — so the name has
//                                // to travel with the key. "" means the writer
//                                // did not name it (an older service, a
//                                // hand-edited file); readers fall back to
//                                // humanizing the key themselves.
//     recorded:    boolean       // is there a layout on file for that key
//     driftCount:  int           // how many recorded apps a restore would act
//                                // on RIGHT NOW — see driftCountOf. 0 with
//                                // recorded=true is the "in sync" badge.
//     restoring:   boolean       // a restore cycle is in flight (glyph sweeps)
//     lastResult:  null | { ok: boolean, summary: string, at: string }
//                                // the outcome of the last cycle that ran in
//                                // this session. null before the first one —
//                                // "nothing has happened yet", which is not
//                                // the same as "the last one succeeded".
//     paused:      boolean       // v2. A mirror of State.paused, republished on
//                                // every status write so the bar glyph and the
//                                // panel badge can render the paused state from
//                                // the one small file they already watch —
//                                // without opening the state file, which is the
//                                // panel's to write and nobody else's to poll.
//                                // The state file remains the source of truth;
//                                // this is a read-only echo of it.
//     deferredLocked: boolean    // v2 (tick 97e). The last cycle found group
//                                // JOIN work in its plan while the session was
//                                // LOCKED, executed everything focus-
//                                // independent, and left the joins for the
//                                // unlock. `into_group` ignores its window
//                                // selector and acts on the focused window
//                                // (live-verified), and under an
//                                // ext-session-lock there is no window to
//                                // focus — so a rebuild attempted there
//                                // assembles in the wrong order. The service
//                                // polls the lock while this is true and
//                                // re-runs the restore when it clears, so the
//                                // flag is a statement about WHY the desk is
//                                // still drifted, not a failure. glyphState
//                                // does not read it: drifted is what the
//                                // desktop IS, and a fourth glyph for a state
//                                // that clears itself would teach nothing. The
//                                // bar tooltip says it in words instead.
//     verdicts:    Verdict[]     // the per-identity verdict table (the shape is
//                                // documented in engine.js — engine.verdictsFor
//                                // builds it). Republished after every cycle
//                                // AND every drift refresh, so the file always
//                                // says WHICH app is wrong and HOW, not just
//                                // how many. Empty when the topology has no
//                                // recording; never partially updated.
//                                // Each verdict also carries `geometry` (v2:
//                                // "ok" | "geometry-off" | "scored" |
//                                // "not-scored") and `geometryDetail` — the
//                                // measured rects, delta and IoU. Neither is
//                                // part of `ok`, and neither may ever become
//                                // part of it: geometry is measured, never
//                                // enforced (tick 5sc).
//   }
//
// The discipline that makes this file trustworthy, and the reason the writer
// lives in Service.qml rather than anywhere else:
//
//   - ATOMIC WRITES ONLY (temp + rename), same as the state file. A reader with
//     a FileView watch sees every truncation, and a half-written status is a
//     glyph flickering to "no layout" on somebody's bar.
//   - A FAILED LIVE READ PUBLISHES NOTHING. The status is derived from
//     `hyprctl clients/monitors`, and StateModel.parseHyprctlArray exists
//     because a failed read looks exactly like an empty desktop. Publishing
//     that would zero driftCount and clear `recorded` — the UI would announce
//     "no layout for this topology" because hyprctl hiccuped. Every writer
//     therefore PATCHES the last published status (mergeStatus) instead of
//     rebuilding it from scratch, and abandons the write when the read failed.
//
// Unknown keys are dropped on the parse -> serialize round trip, exactly as in
// the state file: this is a schema, not a scratchpad.

var STATE_VERSION = 4;

// ES5, no Array.isArray assumptions about the QML JS engine's vintage: this is
// the one array test that behaves the same in node and in Qt's V4.
function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function defaultState() {
  return { version: STATE_VERSION, paused: false, identities: [], layouts: {} };
}

// Coerce whatever a pattern list contains into an array of non-empty strings.
// A user-edited file can hold nulls, numbers, or a bare string instead of a
// list; none of those should cost the identity its other patterns.
function normalizePatterns(value) {
  var patterns = [];
  var list = value;
  if (typeof list === "string") list = [list];
  if (!isArray(list)) return patterns;
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] === "string" && list[i]) patterns.push(list[i]);
  }
  return patterns;
}

// An identity without an id cannot be referred to by a layout, so it is
// dropped; everything else is repaired to its default.
function normalizeIdentity(value) {
  if (!value || typeof value !== "object") return null;
  var id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  return {
    id: id,
    patterns: normalizePatterns(value.patterns),
    // v4. Same coercion as `patterns` — same repair semantics, same "a typo
    // costs you the pattern, never the identity" — and always written, even
    // when empty, so nothing downstream has to tell absent from empty. An
    // identity from a v3 file gains it here; that IS the v3 -> v4 migration.
    titlePatterns: normalizePatterns(value.titlePatterns),
    launch: typeof value.launch === "string" ? value.launch : ""
  };
}

function normalizeIdentities(value) {
  var out = [];
  var seen = {};
  if (!isArray(value)) return out;
  for (var i = 0; i < value.length; i++) {
    var identity = normalizeIdentity(value[i]);
    if (!identity) continue;
    // A duplicate id would make identityById ambiguous and record the same
    // window twice. First wins, consistent with the rest of the engine.
    if (seen[identity.id]) continue;
    seen[identity.id] = true;
    out.push(identity);
  }
  return out;
}

// A recorded `occurrence` (schema v3): WHICH window of the identity an entry
// describes, 0-based.
//
// Unlike geometry, there is no "not known" here. An entry always describes some
// window, and before v3 every entry described the one window the record kept —
// which is occurrence 0. So the fallback is 0, not null, and it is the same
// answer for a v2 entry that never had the field, a hand edit that emptied it,
// and a file that put junk there.
//
// Coercion follows normalizeWorkspaceId (a hand edit writing "1" must still
// mean 1), and then the value has to be a NON-NEGATIVE INTEGER to survive: an
// occurrence is an array index in every consumer, and -1 or 1.5 would index
// nothing. Negative, fractional, infinite, non-numeric — all land on 0.
//
// Landing two entries of one identity on the same occurrence is possible with a
// hand-mangled file, and it is deliberately NOT repaired here: this reader
// cannot tell which entry the user meant to keep, and the group invariant check
// in the recorder is where a contradictory record is meant to be noticed.
function normalizeOccurrence(value) {
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

// A recorded workspace id is INTERPOLATED INTO A LUA DISPATCH by the restore
// executor (`hl.dsp.window.move({ workspace = "<id>" })`), which makes it the
// one field of a hand-edited or corrupted state file that could smuggle code
// into the compositor — `"1\", follow = false }); os.execute(\"…"` and the
// quoting is gone. Coerced to a finite number at the single choke point every
// reader of the file goes through, rather than escaped at each dispatch site.
//
// Anything that is not a number lands on null, which is already a legal
// recorded value: buildLayout stores null for a window whose workspace could
// not be read.
function normalizeWorkspaceId(value) {
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  var trimmed = value.replace(/^\s+|\s+$/g, "");
  if (!trimmed) return null;
  var parsed = Number(trimmed);
  return isFinite(parsed) ? parsed : null;
}

// A recorded `at` or `size`: a pair of finite numbers, or null.
//
// The twin of engine.geometryPair, and it has to STAY the twin — the record
// side (engine.buildLayout) and the read side (this file) are two independent
// ES5 files that may not import each other, so the agreement is pinned by a
// test rather than by the type system.
//
// Everything that is not a two-element pair of finite numbers lands on null,
// which is a legal permanent value meaning "not known": a v1 record that never
// carried geometry, or a hyprctl read that omitted the field. Deliberately NOT
// repaired to zeros — [0, 0] is a real position a window can have, and a
// scorer that cannot tell "at the origin" from "we have no idea" would report
// a confident wrong number. Strings are coerced the way workspaceId is (a hand
// edit writing "12" should still score), and a non-integer is kept as-is:
// hyprctl reports integers, but a fractional-scale future should not be
// silently floored.
function normalizeGeometry(value) {
  if (!isArray(value) || value.length !== 2) return null;
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

// A layout is stored verbatim, but its shell has to be sane: apps must be an
// array, or every consumer (driftOf, planRestore, the panel list) has to guard.
function normalizeLayout(value, keyFallback) {
  if (!value || typeof value !== "object") return null;
  var apps = [];
  if (isArray(value.apps)) {
    for (var i = 0; i < value.apps.length; i++) {
      var app = value.apps[i];
      if (!app || typeof app !== "object" || typeof app.identityId !== "string") continue;
      // Copied field by field rather than rebuilt from a known list: a placement
      // written by a newer panel may carry fields this version has never heard
      // of, and dropping them would silently downgrade the file on every read.
      var placement = {};
      for (var key in app) {
        if (Object.prototype.hasOwnProperty.call(app, key)) placement[key] = app[key];
      }
      placement.workspaceId = normalizeWorkspaceId(app.workspaceId);
      // v3. Written unconditionally too, and for the same reason: a v2 entry
      // that never carried the field described the identity's one window, which
      // IS occurrence 0. Writing it here is the whole of the v2 -> v3
      // migration, and it chains off the v1 -> v2 one in the same pass.
      placement.occurrence = normalizeOccurrence(app.occurrence);
      // v2. Written unconditionally, including for a v1 entry that has neither:
      // this IS the migration, and an explicit null says "we looked and there
      // was nothing to record" where an absent key would leave every consumer
      // guessing whether it is reading an old file or a new one.
      placement.at = normalizeGeometry(app.at);
      placement.size = normalizeGeometry(app.size);
      apps.push(placement);
    }
  }
  return {
    topologyKey: typeof value.topologyKey === "string" && value.topologyKey ? value.topologyKey : (keyFallback || ""),
    recordedAt: value.recordedAt === undefined ? null : value.recordedAt,
    apps: apps
  };
}

function normalizeLayouts(value) {
  var out = {};
  if (!value || typeof value !== "object") return out;
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!key) continue;
    var layout = normalizeLayout(value[key], key);
    if (layout) out[key] = layout;
  }
  return out;
}

// The version this state should be WRITTEN back as.
//
// Anything at or below the current generation is UPGRADED: every migration is
// additive and lossless (see the Migration note in the schema block), so a v1
// file that has been read is already a current-generation object in memory —
// the whole chain runs in one pass — and claiming otherwise on the way back out
// would be a lie about its own shape.
//
// A version from the FUTURE is preserved verbatim. This reader drops top-level
// keys it does not know, so stamping such a file with the current number would
// advertise a downgrade it did not perform; keeping the number lets parseState
// report the mismatch and the UI warn instead.
function migrateVersion(value) {
  if (typeof value !== "number" || !isFinite(value)) return STATE_VERSION;
  return value > STATE_VERSION ? value : STATE_VERSION;
}

// Turn anything at all into a state object this codebase can work with.
function normalizeState(value) {
  if (!value || typeof value !== "object" || isArray(value)) return defaultState();
  return {
    version: migrateVersion(value.version),
    // v2, and the default is the safe direction: a file that does not mention
    // pausing is a file from before the switch existed, and the tool has always
    // been active. Only an explicit `true` pauses.
    paused: value.paused === true,
    identities: normalizeIdentities(value.identities),
    layouts: normalizeLayouts(value.layouts)
  };
}

// Read the file's text. NEVER throws and always yields a usable state: a
// missing file, an empty file, truncated JSON and a JSON array all land on the
// same fresh default, because the service's only sane response to any of them
// is the same — start over and write the default back.
//
// Returns { state, error, recovered, migrated }:
//   error     — human-readable reason the raw text was unusable, else null
//   recovered — true when `state` is a fresh default rather than the file's
//               content. The service logs it and rewrites the file.
//   migrated  — true when the file was an OLDER schema version that this read
//               upgraded (v1 -> v2 -> v3 -> v4, as far as it has to go, in the
//               one pass). Not an error and not a recovery: nothing was lost
//               and nothing was invented. The service logs it once and the next
//               write persists the upgraded shape.
function parseState(raw) {
  var text = typeof raw === "string" ? raw : "";
  if (!text.replace(/^\s+|\s+$/g, "")) {
    return { state: defaultState(), error: "empty or missing state file", recovered: true, migrated: false };
  }

  var parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { state: defaultState(), error: "invalid JSON: " + (e && e.message ? e.message : String(e)), recovered: true, migrated: false };
  }

  if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
    return { state: defaultState(), error: "state file is not a JSON object", recovered: true, migrated: false };
  }

  var state = normalizeState(parsed);
  var error = null;
  var migrated = false;
  if (typeof parsed.version === "number" && parsed.version > STATE_VERSION) {
    // From the future. Not recovered: fields have only ever been added, so the
    // file still reads. The caller decides whether to warn.
    error = "unexpected state version " + parsed.version + " (expected " + STATE_VERSION + ")";
  } else if (typeof parsed.version !== "number" || parsed.version < STATE_VERSION) {
    // An older (or version-less) file, upgraded in place. Reported separately
    // from `error` on purpose: an upgrade is a normal event with a happy
    // outcome, and warning about it would train the user to ignore warnings.
    migrated = true;
  }
  return { state: state, error: error, recovered: false, migrated: migrated };
}

// Pretty-printed with a trailing newline: this file is meant to be readable and
// hand-editable, and it lands in a directory people `cat`.
function serializeState(state) {
  return JSON.stringify(normalizeState(state), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Queries and updates
// ---------------------------------------------------------------------------

function layoutFor(state, topologyKey) {
  var layouts = (state && state.layouts) || {};
  var key = typeof topologyKey === "string" ? topologyKey : "";
  if (!key) return null;
  if (!Object.prototype.hasOwnProperty.call(layouts, key)) return null;
  return layouts[key] || null;
}

function hasLayoutFor(state, topologyKey) {
  return !!layoutFor(state, topologyKey);
}

// A cheap fingerprint of the layout stored for one topology: "" when there is
// none, otherwise its recordedAt stamp and app count.
//
// It exists for exactly one question, asked by the service every time the state
// file reloads: DID THIS TOPOLOGY JUST GET RE-RECORDED? A Record is the user
// saying "this is the arrangement now", which retires the verdict of whatever
// restore ran before it — the badge has to leave "Restore failed" and go to
// "In sync" (ux-sketch, Record is WYSIWYG with instant feedback). Ticking a
// chip or learning a launch command also rewrites the file, and neither of
// those says anything about the last restore, so a blunt "the state changed"
// test would clear the verdict for the wrong reasons.
function layoutStampFor(state, topologyKey) {
  var layout = layoutFor(state, topologyKey);
  if (!layout) return "";
  var at = typeof layout.recordedAt === "string" ? layout.recordedAt : String(layout.recordedAt);
  return at + "#" + (isArray(layout.apps) ? layout.apps.length : 0);
}

function topologyKeys(state) {
  var layouts = (state && state.layouts) || {};
  var keys = [];
  for (var key in layouts) {
    if (Object.prototype.hasOwnProperty.call(layouts, key)) keys.push(key);
  }
  keys.sort();
  return keys;
}

function identities(state) {
  return (state && state.identities) || [];
}

function identityById(state, id) {
  var list = identities(state);
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// The command that brings an identity back, or "" when it has none (see the
// Identity schema note: "" means never launch).
function launchCommandFor(state, identityId) {
  var identity = identityById(state, identityId);
  return (identity && identity.launch) || "";
}

// File a layout under its own topologyKey, replacing any previous record for
// that topology. Returns a NEW state object — QML property bindings only
// notice a reassignment, and an in-place mutation of `layouts` would leave the
// UI showing the old layout.
function upsertLayout(state, layout) {
  var base = normalizeState(state);
  var normalized = normalizeLayout(layout, "");
  if (!normalized || !normalized.topologyKey) return base;

  var layouts = {};
  for (var key in base.layouts) {
    if (Object.prototype.hasOwnProperty.call(base.layouts, key)) layouts[key] = base.layouts[key];
  }
  layouts[normalized.topologyKey] = normalized;

  return { version: base.version, paused: base.paused, identities: base.identities, layouts: layouts };
}

function removeLayout(state, topologyKey) {
  var base = normalizeState(state);
  var layouts = {};
  for (var key in base.layouts) {
    if (!Object.prototype.hasOwnProperty.call(base.layouts, key)) continue;
    if (key === topologyKey) continue;
    layouts[key] = base.layouts[key];
  }
  return { version: base.version, paused: base.paused, identities: base.identities, layouts: layouts };
}

// Replace the whole identity list (the panel edits it as a list). Returns a new
// state, normalized, so a UI that hands over half-built rows cannot corrupt the
// file.
function setIdentities(state, list) {
  var base = normalizeState(state);
  return { version: base.version, paused: base.paused, identities: normalizeIdentities(list), layouts: base.layouts };
}

// Flip the tool's on/off switch. Same new-object discipline as the rest: the
// panel binds to the state object, and mutating `paused` in place would leave
// the toggle showing the position it was in before it was pressed.
//
// The CALLER's job, and the reason this takes a whole state rather than owning
// one: read the file FRESH, apply this, write atomically. The service rewrites
// the same file (recordings, learned launch commands), so a toggle computed
// from a state object that has been sitting in a property since the panel
// opened would write back a stale recording along with the new flag.
function setPaused(state, paused) {
  var base = normalizeState(state);
  base.paused = paused === true;
  return base;
}

function isPaused(state) {
  return !!(state && state.paused === true);
}

// ---------------------------------------------------------------------------
// The status file: pure shaping
// ---------------------------------------------------------------------------
//
// Everything below turns inputs the service already has (a topology key, a
// layout, an engine.driftOf report) into the Status object documented at the
// top of this file. No I/O and no clock: `at` timestamps are passed in, the
// same rule engine.buildLayout follows.

function defaultStatus() {
  return { topologyKey: "", topologyName: "", recorded: false, driftCount: 0, restoring: false, paused: false, deferredLocked: false, lastResult: null, verdicts: [] };
}

// One dimension word. Kept as free text rather than checked against a
// whitelist: the vocabulary lives in engine.js and a status file written by a
// NEWER service must not have its words blanked by an older reader — but it is
// coerced to a string, because a number or an object here would reach the
// panel's row text and QML would render "[object Object]" beside an app name.
function normalizeVerdictWord(value) {
  return typeof value === "string" && value ? value : "ok";
}

function normalizeBlockedBy(value) {
  if (!value || typeof value !== "object" || isArray(value)) return null;
  return {
    kind: typeof value.kind === "string" ? value.kind : "",
    reason: typeof value.reason === "string" ? value.reason : ""
  };
}

// The geometry verdict word (tick 5sc). Unlike the four placement words this
// does NOT default to "ok": a status file written by a service that knew
// nothing about geometry has measured nothing, and "ok" would be an agreement
// nobody reached. "not-scored" is the honest default and the honest fallback.
function normalizeGeometryWord(value) {
  if (value === "ok" || value === "geometry-off" || value === "scored") return value;
  return "not-scored";
}

function normalizeNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

// The numbers behind the geometry word, as they survive a trip through the
// status file. Every field is null-able, because "not measured" has to stay
// distinguishable from "measured as zero" all the way to the panel.
function normalizeGeometryDetail(value) {
  if (!value || typeof value !== "object" || isArray(value)) return null;
  var delta = null;
  if (value.delta && typeof value.delta === "object" && !isArray(value.delta)) {
    var dx = normalizeNumber(value.delta.dx);
    var dy = normalizeNumber(value.delta.dy);
    var dw = normalizeNumber(value.delta.dw);
    var dh = normalizeNumber(value.delta.dh);
    // All four or none: a half-read delta cannot be rendered and must not be
    // half-rendered.
    if (dx !== null && dy !== null && dw !== null && dh !== null) {
      delta = { dx: dx, dy: dy, dw: dw, dh: dh };
    }
  }
  return {
    mode: value.mode === "float" ? "float" : "tiled",
    verdict: normalizeGeometryWord(value.verdict),
    tolerance: normalizeNumber(value.tolerance),
    recorded: {
      at: normalizeGeometry(value.recorded && value.recorded.at),
      size: normalizeGeometry(value.recorded && value.recorded.size)
    },
    current: {
      at: normalizeGeometry(value.current && value.current.at),
      size: normalizeGeometry(value.current && value.current.size)
    },
    delta: delta,
    iou: normalizeNumber(value.iou),
    // Why the planner declined to act on a `geometry-off` float, or null. Kept
    // as a free string rather than checked against a list of words: this file
    // is the READER, and a reason a newer service knows about must reach the
    // row it explains instead of being blanked into an unexplained amber. The
    // panel prints whatever it is handed (engine.geometrySkipPhrase falls back
    // to the word itself).
    skip: (typeof value.skip === "string" && value.skip) ? value.skip : null,
    // …and its tiled twin (tick eqb): why the tiled refinement will not touch
    // this window's workspace, or null. Same free-string rule and the same
    // reason — a word a newer service knows about must reach the row it
    // explains rather than being blanked into an unexplained number.
    refinement: (typeof value.refinement === "string" && value.refinement) ? value.refinement : null
  };
}

// A verdict without an identityId cannot be shown against a row, so it is
// dropped — same rule as an identity without an id.
function normalizeVerdict(value) {
  if (!value || typeof value !== "object" || isArray(value)) return null;
  if (typeof value.identityId !== "string" || !value.identityId) return null;
  return {
    identityId: value.identityId,
    status: typeof value.status === "string" ? value.status : "skipped",
    monitor: normalizeVerdictWord(value.monitor),
    workspace: normalizeVerdictWord(value.workspace),
    floating: normalizeVerdictWord(value.floating),
    group: normalizeVerdictWord(value.group),
    // Recomputed rather than trusted: `ok` is what the UI paints green, and a
    // file claiming ok:true beside a non-ok dimension is exactly the lie this
    // whole tick exists to remove.
    //
    // GEOMETRY joins this expression as of tick qkv, on ONE word and no other:
    // `geometry-off`. Tick 5sc kept geometry out entirely because there was no
    // op that moved a window by pixels, so a miss was unactionable; epic yyz
    // added one for floats, and `geometry-off` is a verdict engine's
    // geometryScoreFor only ever reaches in FLOAT mode. A tiled window scores
    // `scored` or `not-scored` and still cannot turn this false — which is what
    // keeps 5sc's actual promise intact: no tiled desktop goes amber, negative
    // or red over a rect nobody can command.
    //
    // Tested against the word rather than against the mode deliberately. The
    // mode lives in geometryDetail, which is null-able through the file; the
    // word survives normalizeGeometryWord and defaults to the inert
    // "not-scored", so a status file written by an older service — or a
    // corrupt one — can only ever fail SAFE here.
    ok: normalizeVerdictWord(value.monitor) === "ok"
      && normalizeVerdictWord(value.workspace) === "ok"
      && normalizeVerdictWord(value.floating) === "ok"
      && normalizeVerdictWord(value.group) === "ok"
      && normalizeGeometryWord(value.geometry) !== "geometry-off",
    text: typeof value.text === "string" ? value.text : "",
    geometry: normalizeGeometryWord(value.geometry),
    geometryDetail: normalizeGeometryDetail(value.geometryDetail),
    blockedBy: normalizeBlockedBy(value.blockedBy)
  };
}

function normalizeVerdicts(value) {
  var out = [];
  if (!isArray(value)) return out;
  for (var i = 0; i < value.length; i++) {
    var verdict = normalizeVerdict(value[i]);
    if (verdict) out.push(verdict);
  }
  return out;
}

// A cycle outcome, or null. `ok: false` is what turns the glyph's dot red, so
// a malformed result must not be able to fake a success: anything that is not
// an object at all reads as "no result yet" rather than "it went fine".
function normalizeLastResult(value) {
  if (!value || typeof value !== "object" || isArray(value)) return null;
  return {
    ok: value.ok === true,
    summary: typeof value.summary === "string" ? value.summary : "",
    at: typeof value.at === "string" ? value.at : ""
  };
}

function normalizeStatus(value) {
  var src = value && typeof value === "object" && !isArray(value) ? value : {};
  var count = typeof src.driftCount === "number" && isFinite(src.driftCount) ? Math.floor(src.driftCount) : 0;
  return {
    topologyKey: typeof src.topologyKey === "string" ? src.topologyKey : "",
    // Coerced like every other string in here, and defaulted to "" rather than
    // to a humanized key: this model has no monitor list and guessing one would
    // put a part number in the file under the name of a friendly label. "" is
    // the honest "unnamed", and the reader knows what to do with it.
    topologyName: typeof src.topologyName === "string" ? src.topologyName : "",
    recorded: src.recorded === true,
    driftCount: count < 0 ? 0 : count,
    restoring: src.restoring === true,
    // Same default direction as State.paused: only an explicit `true` pauses,
    // so a status file written by an older service reads as active.
    paused: src.paused === true,
    // Same direction again (tick 97e): only an explicit `true` defers. A status
    // file from a service that had never heard of the lock probe reads as "no
    // joins are waiting", which is the state such a service was always in.
    deferredLocked: src.deferredLocked === true,
    lastResult: normalizeLastResult(src.lastResult),
    verdicts: normalizeVerdicts(src.verdicts)
  };
}

// How many recorded apps a restore would ACT on right now.
//
// Deliberately drifted + missing, not just drifted: a watched app that is not
// running at all is something restore would launch, so counting only the
// out-of-place ones would show "In sync" on a desktop where pressing Restore
// starts three programs. `skipped` is excluded for the mirror-image reason —
// engine.driftOf marks an app skipped precisely when there is nothing restore
// can do about it (its monitor is unplugged, its identity is gone), and a
// badge that never reaches zero while a monitor is away is noise, not news.
function driftCountOf(driftReport) {
  var summary = driftReport && driftReport.summary;
  if (!summary || typeof summary !== "object") return 0;
  var drifted = typeof summary.drifted === "number" ? summary.drifted : 0;
  var missing = typeof summary.missing === "number" ? summary.missing : 0;
  return drifted + missing;
}

// The half of the status that a fresh live read establishes. Kept separate
// from restoring/lastResult because those two are owned by the restore cycle
// and must survive a status refresh that happens while a cycle is running.
//
// Returns null when there is no topology to speak of — a mid-hotplug read
// where every monitor resolves to no label at all. Callers must publish
// nothing at all in that case rather than publishing an empty key; see the
// discipline note in the schema block.
// `verdicts` is optional, and the two ways of leaving it out mean different
// things:
//   - no layout for this topology: the table is CLEARED. There is nothing
//     recorded to have a verdict about, and last topology's rows lingering
//     under a hollow badge would be the panel describing a desktop that is not
//     on the screen.
//   - a layout, and the caller passed no verdicts: the key is absent from the
//     patch, so mergeStatus leaves whatever was last published alone. That is
//     the panel's path — it overlays its own fresher drift count on the
//     service's status and has no business retiring the service's table.
function statusPatchFor(topologyKey, layout, driftReport, verdicts) {
  var key = typeof topologyKey === "string" ? topologyKey : "";
  if (!key) return null;
  var patch = {
    topologyKey: key,
    recorded: !!layout,
    driftCount: layout ? driftCountOf(driftReport) : 0
  };
  if (!layout) patch.verdicts = [];
  else if (verdicts !== undefined) patch.verdicts = normalizeVerdicts(verdicts);
  return patch;
}

// Apply a patch to the last published status. Only the known keys move,
// and only when the patch actually carries them — `undefined` means "leave it
// as it was", which is what lets the cycle flip `restoring` without knowing
// anything about drift, and lets a drift refresh run without disturbing the
// cycle's flags.
function mergeStatus(previous, patch) {
  var base = normalizeStatus(previous);
  var next = patch && typeof patch === "object" && !isArray(patch) ? patch : {};

  if (next.topologyKey !== undefined) base.topologyKey = typeof next.topologyKey === "string" ? next.topologyKey : base.topologyKey;
  // "" IS a meaningful patch value here, unlike the key: a writer that can no
  // longer name the topology says so by clearing the name, and the reader falls
  // back to the key. Only a non-string is ignored.
  if (next.topologyName !== undefined) base.topologyName = typeof next.topologyName === "string" ? next.topologyName : base.topologyName;
  if (next.recorded !== undefined) base.recorded = next.recorded === true;
  if (next.driftCount !== undefined) {
    var count = typeof next.driftCount === "number" && isFinite(next.driftCount) ? Math.floor(next.driftCount) : 0;
    base.driftCount = count < 0 ? 0 : count;
  }
  if (next.restoring !== undefined) base.restoring = next.restoring === true;
  if (next.paused !== undefined) base.paused = next.paused === true;
  if (next.deferredLocked !== undefined) base.deferredLocked = next.deferredLocked === true;
  // null is a MEANINGFUL patch value here ("forget the last result"), so it
  // has to pass through normalizeLastResult rather than be skipped.
  if (next.lastResult !== undefined) base.lastResult = normalizeLastResult(next.lastResult);
  // Same rule, and the same reason an empty table has to be publishable: "no
  // app has a verdict" is a statement, not a missing value.
  if (next.verdicts !== undefined) base.verdicts = normalizeVerdicts(next.verdicts);

  return base;
}

// May the service run its slow background drift poll right now?
//
// The poll exists for ONE compositor limitation (state-matrix §4b, tick ae1):
// an in-place float drag or resize emits no Hyprland event at all, so the badge
// would stay stale until something else happened on the desktop. The poll puts
// a bound on that; the event path is still what does the work.
//
// Three conditions, and each is a case where a read would buy nothing:
//   - nothing RECORDED for this topology: there is no layout to be drifted
//     from, the glyph is hollow, and a desk the user has never recorded must
//     cost this plugin exactly zero hyprctl reads;
//   - PAUSED: the tool has been told to leave the desktop alone. It still
//     refreshes on real events (the badge keeps telling the truth), but it does
//     not go looking on its own;
//   - RESTORING: the cycle owns the read machinery and publishes its own status
//     at the end.
//
// A predicate over the STATUS rather than the whole world because that is the
// object the service already keeps up to date, and because a `running:` binding
// on the timer is what makes the gate cost nothing — a timer that fires and
// then decides not to read has already paid for the wakeup. The service adds
// the one condition this file cannot see: the state file has loaded.
function shouldSlowPoll(status) {
  var current = normalizeStatus(status);
  return current.recorded === true && !current.paused && !current.restoring;
}

// Same contract as parseState: never throws, always yields a usable Status.
// A missing or corrupt status file is not an error worth surfacing — the UI
// simply renders the "nothing known yet" glyph until the service publishes.
function parseStatus(raw) {
  var text = typeof raw === "string" ? raw : "";
  if (!text.replace(/^\s+|\s+$/g, "")) {
    return { status: defaultStatus(), error: "empty or missing status file" };
  }
  var parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { status: defaultStatus(), error: "invalid JSON: " + (e && e.message ? e.message : String(e)) };
  }
  if (!parsed || typeof parsed !== "object" || isArray(parsed)) {
    return { status: defaultStatus(), error: "status file is not a JSON object" };
  }
  return { status: normalizeStatus(parsed), error: null };
}

function serializeStatus(status) {
  return JSON.stringify(normalizeStatus(status), null, 2) + "\n";
}

// Which of the six bar-glyph renderings a status calls for (see the state
// matrix in docs/thoughts/2026-08-15-ux-sketch.md):
//
//   "hollow"    outline only    — no layout recorded for this topology
//   "paused"    outline + slash — the tool is switched off (v2)
//   "filled"    solid           — recorded and in sync
//   "drifted"   solid + dot     — recorded, but the desktop has moved on
//   "failed"    solid + dot     — the last restore did not go cleanly
//   "restoring" solid + sweep   — a cycle is in flight
//
// The order the checks run in IS the design, so it is spelled out rather than
// implied:
//   - `restoring` wins over everything. It is the only live state, it lasts
//     seconds, and during a cycle every other field is by definition stale.
//     It outranks `paused` too, and must: a paused tool still runs the MANUAL
//     trigger, and a restore the user asked for has to show its sweep.
//   - `paused` comes next, ahead of hollow, drift and failure alike. Those
//     three are statements about a desktop; paused is a statement about the
//     TOOL, and "there are four apps out of place" is misleading on a bar when
//     the thing that would fix them has been switched off. Drift is still
//     counted, still published, and still on the panel's rows — it is only the
//     one-glyph summary that leads with the switch.
//   - `hollow` comes next, because with nothing recorded there is nothing for
//     a dot to mean: drift and restore failures are both statements ABOUT a
//     recording, and the empty topology has none.
//   - a failure outranks drift. A failed restore usually LEAVES drift, so
//     showing amber there would report the symptom and hide the cause.
function glyphState(status) {
  var current = normalizeStatus(status);
  if (current.restoring) return "restoring";
  if (current.paused) return "paused";
  if (!current.recorded) return "hollow";
  if (current.lastResult && current.lastResult.ok === false) return "failed";
  if (current.driftCount > 0) return "drifted";
  return "filled";
}

// ---------------------------------------------------------------------------
// Failure forensics
// ---------------------------------------------------------------------------
//
// Every cycle that ends not-ok drops one file in
// ~/.local/state/omarchy/dock-recall-forensics/, holding everything a
// replayable fixture needs: the topology key, the recording, the raw clients
// and monitors reads, the plan of every iteration, the per-op outcomes and the
// verdict table. The point is that a real failure stops needing live
// spelunking — the state that produced it is on disk before the desktop has
// moved on, and every field in it is an input the pure functions already take.
//
// Only the naming and the rotation live here; the write is the service's (it
// owns the filesystem). Rotation is pure so it can be tested: "keep the newest
// 10" is exactly the kind of off-by-one that is invisible until the file
// somebody needed is the one that was deleted.

var FORENSICS_KEEP = 10;

// The ISO timestamp verbatim, so `ls` sorts the directory chronologically
// (ISO-8601 is lexicographically ordered) and every filename says when the
// failure happened without opening it. Colons are legal on every filesystem
// this runs on; the service quotes the path.
function forensicsFileName(isoTimestamp) {
  var stamp = typeof isoTimestamp === "string" ? isoTimestamp.replace(/^\s+|\s+$/g, "") : "";
  if (!stamp) return "";
  // A timestamp is generated, never user input — but this becomes a PATH, and
  // the only safe way to say so is a whitelist. A blacklist of "/" and space is
  // one caller away from being handed a newline, a NUL or a "..", and the
  // failure would be a file written somewhere nobody thought to look.
  // Everything an ISO-8601 instant is made of, and nothing else.
  if (/[^0-9A-Za-z:.\-]/.test(stamp)) return "";
  return stamp + ".json";
}

// Which files in the directory to delete so that the newest `keep` remain,
// counting the one about to be written.
//
// `names` is the directory listing as it is RIGHT NOW (before the new file
// exists), so keeping `keep - 1` of them leaves room for the new one — a
// rotation that kept 10 old files and then added one would grow the directory
// by one file per failure forever, which is the bug this returns a list to
// avoid. Anything that is not a .json dump is left alone: the directory is the
// service's, but deleting a file we did not write is never this function's
// call.
function forensicsPrune(names, keep) {
  var list = isArray(names) ? names : [];
  var limit = typeof keep === "number" && isFinite(keep) ? Math.floor(keep) : FORENSICS_KEEP;
  if (limit < 1) limit = 1;

  var dumps = [];
  for (var i = 0; i < list.length; i++) {
    var name = typeof list[i] === "string" ? list[i].replace(/^\s+|\s+$/g, "") : "";
    if (!name) continue;
    if (name.length < 6 || name.slice(-5) !== ".json") continue;
    dumps.push(name);
  }
  dumps.sort();

  var room = limit - 1;
  if (dumps.length <= room) return [];
  return dumps.slice(0, dumps.length - room);
}

// ---------------------------------------------------------------------------
// Live-read decisions
// ---------------------------------------------------------------------------
//
// These never touch the state file. They live here rather than in engine.js
// because engine.js answers exactly one question — WHERE A WINDOW BELONGS —
// and none of these do: they are the service's plumbing decisions (did that
// hyprctl read succeed? did this window join that group? which monitor takes
// focus now?), pulled out of Service.qml only so `node --test` can reach them.

// Interpret one `hyprctl … -j` read.
//
// The bug this exists to close: a non-zero exit, a killed process, or a
// compositor that answered nothing at all all produced an EMPTY string, which
// the old parse turned into an empty array and handed to the planner as a fact
// — an empty desktop, whose restore plan is "launch every recorded app". One
// failed read therefore duplicated the user's entire session.
//
// A literal `[]` is NOT a failure: a desktop really can have no windows open,
// and launching them is the right plan for that.
//
// Returns { ok, value, error }. On failure `value` is [] and MUST NOT be used;
// the caller's job is to abandon the pass.
function parseHyprctlArray(raw, exitCode, stderrText) {
  var text = typeof raw === "string" ? raw : "";
  var errText = (typeof stderrText === "string" ? stderrText : "").replace(/^\s+|\s+$/g, "");
  var detail = errText ? " (stderr: " + errText + ")" : "";

  if (typeof exitCode === "number" && exitCode !== 0) {
    return { ok: false, value: [], error: "hyprctl exited " + exitCode + detail };
  }
  if (!text.replace(/^\s+|\s+$/g, "")) {
    return { ok: false, value: [], error: "empty output" + detail };
  }

  var parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      value: [],
      error: "unparseable JSON: " + (e && e.message ? e.message : String(e)) + detail
    };
  }
  if (!isArray(parsed)) return { ok: false, value: [], error: "expected a JSON array" + detail };

  return { ok: true, value: parsed, error: null };
}

// A client's `grouped` array holds the addresses of every window in its tab
// group, itself included, and is empty when the window is not grouped. A
// ONE-entry array is still a group — hl.dsp.group.toggle() on a lone window
// makes exactly that — and it has to be dissolved like any other before a
// rebuild can impose the recorded tab order.
function isGrouped(client) {
  return !!(client && isArray(client.grouped) && client.grouped.length > 0);
}

// Did `client` land in the SAME group as `anchorAddress`?
//
// The test this replaces asked only "is it grouped at all", which a window's
// own freshly-created solo group answers yes to — so an `into_group` that did
// nothing looked like a success, the remaining directions were never tried,
// and the window was left sitting beside the group it never joined.
function inGroupWith(client, anchorAddress) {
  if (!client || !anchorAddress) return false;
  if (client.address === anchorAddress) return isGrouped(client);
  if (!isArray(client.grouped)) return false;
  return client.grouped.indexOf(anchorAddress) !== -1;
}

// Who holds focus after a monitor was removed.
//
//   { kind: "intact",   name }  — a surviving monitor already claims focus;
//                                 nothing to dispatch
//   { kind: "failover", name }  — nobody claims focus: `name` must be focused
//                                 or the session is taking input on an output
//                                 that no longer exists (the freeze this
//                                 project exists to fix)
//   { kind: "none",     name: "" } — no monitors left at all
//
// The failover target prefers the LAST-FOCUSED monitor when it survived the
// removal: "the screen you were just working on" is a better answer than
// "whichever output hyprctl happens to list first", and on a laptop being
// undocked at a desk those are routinely different monitors.
function pickFailoverTarget(monitors, lastFocusedName) {
  var list = isArray(monitors) ? monitors : [];
  if (list.length === 0) return { kind: "none", name: "" };

  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].focused === true) return { kind: "intact", name: list[i].name || "" };
  }

  var preferred = typeof lastFocusedName === "string" ? lastFocusedName : "";
  if (preferred) {
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].name === preferred) return { kind: "failover", name: preferred };
    }
  }
  return { kind: "failover", name: (list[0] && list[0].name) || "" };
}

if (typeof module !== "undefined") {
  module.exports = {
    STATE_VERSION: STATE_VERSION,
    defaultState: defaultState,
    normalizeState: normalizeState,
    normalizeIdentity: normalizeIdentity,
    normalizeWorkspaceId: normalizeWorkspaceId,
    normalizeOccurrence: normalizeOccurrence,
    normalizeGeometry: normalizeGeometry,
    migrateVersion: migrateVersion,
    parseState: parseState,
    serializeState: serializeState,
    layoutFor: layoutFor,
    hasLayoutFor: hasLayoutFor,
    layoutStampFor: layoutStampFor,
    topologyKeys: topologyKeys,
    identities: identities,
    identityById: identityById,
    launchCommandFor: launchCommandFor,
    upsertLayout: upsertLayout,
    removeLayout: removeLayout,
    setIdentities: setIdentities,
    setPaused: setPaused,
    isPaused: isPaused,
    defaultStatus: defaultStatus,
    normalizeStatus: normalizeStatus,
    normalizeVerdict: normalizeVerdict,
    normalizeVerdicts: normalizeVerdicts,
    FORENSICS_KEEP: FORENSICS_KEEP,
    forensicsFileName: forensicsFileName,
    forensicsPrune: forensicsPrune,
    driftCountOf: driftCountOf,
    statusPatchFor: statusPatchFor,
    mergeStatus: mergeStatus,
    parseStatus: parseStatus,
    serializeStatus: serializeStatus,
    glyphState: glyphState,
    shouldSlowPoll: shouldSlowPoll,
    parseHyprctlArray: parseHyprctlArray,
    isGrouped: isGrouped,
    inGroupWith: inGroupWith,
    pickFailoverTarget: pickFailoverTarget
  };
}
