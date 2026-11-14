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
//     version:    7                 // the schema generation. A file at an
//                                   // OLDER version is UPGRADED in place on the
//                                   // read (see "Migration" below); a file from
//                                   // the FUTURE keeps its own number, is still
//                                   // read and restored from, and becomes
//                                   // READ-ONLY — parseState reports the
//                                   // mismatch and writeRefusal turns every
//                                   // writer away (see "Reading the future").
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
//     pictures:   true              // v7. THE ONE SWITCH. May this tool
//                                   // PHOTOGRAPH the windows it watches? It
//                                   // gates every capture there is — the
//                                   // recorded pictures under ~/.cache and the
//                                   // live ones that never reach disk — and
//                                   // there is nothing in front of it or
//                                   // beneath it: a watched app is pictured.
//                                   // Lives here for the same reason `paused`
//                                   // does: a user decision that must survive
//                                   // a shell restart.
//                                   // DEFAULT TRUE, which is the exact
//                                   // opposite of the generation it replaces
//                                   // (v5's per-app `pictured`, default off,
//                                   // plus v6's dialogue on the first Record).
//                                   // The pictures ARE the feature: a panel
//                                   // that draws icons until you find a
//                                   // control is a panel that never shows you
//                                   // anything, and the dialogue talked its
//                                   // own author out of the thing he had
//                                   // asked for. Off is one click in the
//                                   // overflow menu, it deletes every stored
//                                   // picture, and it says so before it does
//                                   // it — see Panel.qml, setPictures.
//                                   // Only the literal `false` is off; see
//                                   // picturesOn for why that direction.
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
//   An identity has NO picture field. v5 gave it one (`pictured`, a per-app
//   consent) and v7 took it away again: whether a window is photographed is a
//   fact about the tool, not about the app, and it is the top-level `pictures`
//   switch above. See the v6 -> v7 note under Migration for what happens to the
//   old per-app values (they are dropped, and the reason is there).
//
//   Layout — exactly what engine.buildLayout() returns:
//     { topologyKey, recordedAt, apps: [ { identityId, occurrence,
//       monitorDescription, slot, floating, group, at, size, layoutMode } ] }.
//     See
//     Slots.js for the placement contract; this file stores it verbatim, with
//     these exceptions:
//       - apps[].slot (v8) is an integer 1..10 or null. It replaces v7's
//         workspaceId, which is NOT written any more: a live workspace id
//         depends on which block of ten Omarchy 4.5 handed the monitor, so the
//         file stores the monitor and the slot and Slots.toLive resolves them.
//         A v7-or-older entry with a workspaceId and no slot is migrated by
//         normalizeSlot (slot = ((W - 1) % 10) + 1; W <= 0 or junk -> null).
//       - apps[].layoutMode (v9) is "dwindle" | "scrolling" | "floating" |
//         null: the recorded workspace's layout mode, null when it was not
//         recorded (a migrated v8 entry, or a record taken without a planning
//         context). Anything else reads as null. See normalizeLayoutMode.
//       - apps[].group (v9) is null or { groupId, index, active }, every
//         other field of it kept. `active` is true on the one watched member
//         that was the group's visible tab, false on the others (on all of
//         them when the visible tab was an unwatched window), null when not
//         recorded — and null never drifts. See normalizeGroupMembership.
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
//   v4 -> v5 added `pictured: false` to every identity — a per-app photograph
//   consent, withheld by default — and v7 has since removed the field
//   altogether. The step is kept here as history, not as behaviour: a v4 file
//   read today gains nothing per identity, because there is nothing at that
//   level to gain. See v6 -> v7 below.
//
//   THE DELIBERATE CHOICE, v4: the empty list IS MATERIALIZED. normalizeIdentity
//   writes `titlePatterns` on every identity it returns, so a v3 file read and
//   written back gains a `"titlePatterns": []` line per identity rather than
//   keeping the key absent. That costs one line per identity in the file and
//   buys the thing every other field here already has: ONE shape. Consumers
//   (engine.matchClient today; any pattern editor the panel grows later — there
//   is no such editor yet, in Panel.qml or PanelModel.js) never have to
//   distinguish "absent" from "empty", exactly as they never have to for
//   `patterns: []` or
//   `launch: ""`, both of which have always been written whether the file said
//   so or not.
//
//   v5 made the same choice for `pictured` and v7 unmade it by deleting the
//   field. The precedent survives its first casualty: it is about fields that
//   EXIST, and the cheapest way to keep a shape honest is still to write it.
//
//   THE ONE THING v4 TAKES AWAY (tick j8o): a migrated `launch` that forces a
//   window class NO pattern of its own identity claims — the signature of v3's
//   retired `--app-id` backfill — is EMPTIED. It is the first non-additive step
//   in the chain, and the reason is that the alternative is worse: the command
//   cannot be repaired downstream and restoring it spawns stray windows for
//   ever. See migratedLaunch, which owns the rule and the discriminator.
//   Everything else an identity said is carried through untouched, and all of
//   it is pinned by tests/state.test.js.
//
//   v5 -> v6 added `pictureConsent` at the TOP level — the answer to a dialogue
//   the first Record put up — and v7 has removed that too. Kept as history for
//   the same reason v5 is: the value it holds is the only input v6 -> v7 has.
//
//   v6 -> v7 is the first step that REPLACES rather than adds. One top-level
//   `pictures` boolean, default TRUE, takes the place of both consent fields:
//   the per-identity `pictured` and the file-level `pictureConsent`. `version`
//   becomes 7. No layout entry moves.
//
//   The derivation is the one thing the user actually said. `pictureConsent`
//   held four values and exactly one of them is a refusal: "none" — "delete
//   them all, take no more". That becomes `pictures: false`. "keep",
//   "not-these", "unasked" and an absent field all become `pictures: true`,
//   because none of them is a person saying no to pictures as such: two are
//   consents, and the other two are silence from before the question existed.
//   THE ONE REFUSAL IS HONOURED AND NOTHING ELSE IS INVENTED — a user who
//   answered "No pictures" opens this build to a tool that is still not taking
//   any.
//
//   Per-identity `pictured` values are DROPPED, not folded in. They cannot be:
//   the new field is one boolean for the whole tool, and there is no honest way
//   to turn "three of your eleven apps were pictured" into it. Any-of would
//   photograph the eight the user never granted, all-of would silence the three
//   they did. The switch starts on, which is what this generation means, and it
//   is one click to turn off — a click the old model made nearly unfindable,
//   which is why it is gone.
//
//   MATERIALIZED, like the generations before it: normalizeState writes
//   `pictures` on every state it returns, so a v6 file read and written back
//   gains one `"pictures": true` line and loses `pictureConsent` and every
//   `"pictured"` line in the same write.
//
//   v7 -> v8 replaced each entry's live `workspaceId` with its `slot` (1..10)
//   — see normalizeSlot.
//
//   v8 -> v9 is ADDITIVE again, per layout entry: `layoutMode` absent -> null,
//   and a group membership without `active` gains `active: null`. Nothing else
//   moves. null is the honest value — a v8 build never read either fact — and
//   it is the one value no consumer acts on. The bump itself is what matters:
//   normalizeLayout copies unknown fields, so a v8 build would not strip the
//   new ones, but it would re-record without them and call the file its own;
//   at v9 a v8 build refuses the file instead (the future-version refusal).
//
//   A v1 file therefore CHAINS — v1 -> ... -> v9 in one read — because
//   normalizeLayout writes the v2, v3, v8 (slot) and v9 fields,
//   normalizeIdentity writes the v4 one and normalizeState writes the v7 one,
//   all unconditionally, so there are no intermediate states to sequence. A v9
//   file read and written back is byte-identical to itself.
//
//   And every step of it happens IN MEMORY. Nothing here writes a file: the
//   service reads an older file, runs from the upgraded state, and the file on
//   disk keeps its own version until the next write has a reason of its own.
//   That is deliberate — opening the panel must not rewrite the user's file —
//   and it is pinned in tests/state.test.js and end to end in
//   tests/acceptance/dock-recall-appid-migration-test.sh.
//
// Reading the future (the other direction, and it has no migration):
//   A file whose version EXCEEDS this build's is READ, and that is all: it is
//   never written and it never drives a restore. There is no forward migration
//   to run — this build cannot know what a later generation added — and the two
//   halves above make BOTH the round trip and the restore unsound:
//   normalizeIdentity drops the unknown fields, migrateVersion keeps the newer
//   number, so any write would persist stripped content under a version that
//   says nothing was stripped, and any restore would act on identity rules
//   stripped back to whatever they meant before the newer schema narrowed them.
//   `isFutureVersion` is the single question; `writeRefusal` and
//   `restoreRefusal` are its two consequences, and every writer of this file and
//   the one funnel that dispatches restores ask them (tick t03).
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
//     shapes:      Shape[]       // v9 (epic 9i2). Finished tiled workspaces whose
//                                // tile shape a restore did not or could not
//                                // reproduce: { workspaceId, monitorDescription,
//                                // meanIou, reason } — reason is a refusal word
//                                // or null. Junk rows are dropped on read.
//     shapeCount:  int           // always shapes.length. glyphState answers
//                                // "drifted" when this is > 0 even if driftCount
//                                // is 0: the same glyph as window drift, the
//                                // reason goes to the tooltip and panel.
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

var STATE_VERSION = 9;

// The one v6 word this build still recognises, and the only place it appears.
// `pictureConsent` held four values and three of them said "yes" or "nothing";
// only this one is a refusal, and only a refusal carries into v7. Everything
// else about the consent generation — the other three words, the setter, the
// per-identity flag and the prompt that wrote them — is gone.
var PICTURE_CONSENT_NONE = "none";

// ES5, no Array.isArray assumptions about the QML JS engine's vintage: this is
// the one array test that behaves the same in node and in Qt's V4.
function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

// ---------------------------------------------------------------------------
// A LOOKUP OBJECT.PROTOTYPE CANNOT ANSWER
// ---------------------------------------------------------------------------
//
// Every index in this project is a bare `{}` — a dedupe map, a launch map, a
// bucket of windows per identity — and `map[key]` on a bare object ANSWERS for
// `constructor`, `toString`, `valueOf`, `hasOwnProperty` and the rest whether
// or not anything was ever stored under them. The keys are identity ids, group
// ids, member keys and class-name tokens: every one of them comes out of a
// user-editable state file or off a window class.
//
// It is not hypothetical. `normalizeIdentities`' dedupe map below said "already
// seen" about an identity nobody had seen, so an identity with `id:
// "constructor"` vanished from the parsed state on EVERY read — the file was
// intact and the app was simply gone. Elsewhere the same shape handed back the
// `Object` function where a command or a window list was expected, which came
// out as a TypeError in the middle of a restore plan. And it is reachable
// without a hand edit: PanelModel.deriveIdentityId builds an id out of the
// class name's segments, so an app whose window class is `Constructor` produces
// exactly the id `constructor`.
//
// So every read of a map keyed by one of those goes through here. The guard is
// `Object.prototype.hasOwnProperty.call` and never `map.hasOwnProperty(key)`:
// the map's own `hasOwnProperty` entry is precisely one of the keys this exists
// for, and calling it would call whatever the user stored.
//
// The one key it cannot repair is `__proto__`, which is a SETTER on
// Object.prototype rather than an inherited value: a write to it never stores
// anything this guard could find, and a READ of it answers with the prototype
// object — so an index keyed by that id hands back something that is neither
// the value nor undefined. It survives this module intact (parse, serialize,
// identityById, launchCommandFor — all pinned in tests/reserved-ids.test.js),
// and a hand-written LAYOUT entry naming it makes engine.matchLayout, driftOf
// and planRestore throw a TypeError. That is a known limit rather than a
// regression — the pre-8hp code throws identically — and it is pinned as one:
// nothing derives the id `__proto__`, so reaching it takes a hand edit.
function own(map, key) {
  if (!map) return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    paused: false,
    // v7. On, because that is what this tool does — see the schema block.
    pictures: true,
    identities: [],
    layouts: {}
  };
}

// The v7 field, derived from whatever a file actually carries.
//
// The field wins whenever it is there at all (by picturesOn's rule). Only a file
// that has never heard of it falls back to the v6 answer, and only one of those
// four answers was a refusal — see the v6 -> v7 note in the schema block. The
// comparison is on the raw word rather than through a normalizer, because
// "none" is now the only one of the four this build has any use for: a typo, a
// hand edit and a word from a generation that never existed all mean "not a
// refusal", which is the same answer "unasked" always gave.
function normalizePictures(value) {
  if (!value || typeof value !== "object") return true;
  if (Object.prototype.hasOwnProperty.call(value, "pictures")) return value.pictures !== false;
  return value.pictureConsent !== PICTURE_CONSENT_NONE;
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

// The terminal binaries the retired backfill could have written a launch for,
// and the words after which a terminal's own argv has ENDED — everything past
// one of them belongs to the program the terminal hosts.
//
// DUPLICATED FROM PanelModel (TERMINAL_FAMILY, TERMINAL_EXEC_BOUNDARIES) ON
// PURPOSE: this file may not require it — QML `.js` imports cannot see each
// other, the same constraint that has `isArray` and `own` in all three modules
// (see the note at line 94). Only the two facts forcedAppIdClass needs are
// copied, and tests/state.test.js pins both copies to the originals.
//
// Binaries, not classes: PanelModel matches window class names, and this reads
// the first word of a COMMAND. They coincide for this family — `com.mitchellh.
// ghostty` is a class only, and its binary is `ghostty`.
var TERMINAL_BINARIES = ["foot", "footclient", "kitty", "alacritty", "ghostty"];
var TERMINAL_ARGV_END = ["-e", "--", "--hold"];

function isTerminalBinary(word) {
  var text = typeof word === "string" ? word : "";
  var cut = text.lastIndexOf("/");
  var name = (cut === -1 ? text : text.substring(cut + 1)).toLowerCase();
  if (!name) return false;
  for (var i = 0; i < TERMINAL_BINARIES.length; i++) {
    if (TERMINAL_BINARIES[i] === name) return true;
  }
  return false;
}

function isTerminalArgvEnd(word) {
  for (var i = 0; i < TERMINAL_ARGV_END.length; i++) {
    if (TERMINAL_ARGV_END[i] === word) return true;
  }
  return false;
}

// The window class an `--app-id` flag FORCES in a launch command OF THE SHAPE
// THE RETIRED BACKFILL WROTE, or null when this command is not that shape or
// names no such flag. `""` — the flag with nothing after it — is a found flag
// with no class, which is not the same answer as "absent".
//
// The shape is the whole point (tick bcc). This asked only "does the command
// spell `--app-id` anywhere?", and the backfill is far from the only thing that
// does; two ordinary launches were emptied on migration because of it:
//
//   `chromium --app-id=<extension-id>` — Chromium's OWN flag, a hand-written PWA
//   launch. The window class it produces is `chrome-<extension-id>-Default` and
//   never the flag's value, so patternsClaimClass could only ever answer
//   "unclaimed" about a perfectly correct identity, and the migration destroyed
//   the command that starts it. normalizeIdentity's comment promises that a hand
//   edit of this field "is a decision this module does not overrule".
//
//   `foot -e grep --app-id log.txt` — the flag belongs to the program the
//   terminal HOSTS. It forces no window class at all.
//
// The backfill only ever wrote `<terminal-binary> --app-id=<id> <command>`. So
// the detector fires only when the FIRST word is a terminal-family binary (by
// basename: it wrote `/usr/bin/foot` as readily as `foot`) and the `--app-id`
// token sits in the TERMINAL's own argv — before an exec boundary, and before
// the first bare word, which is where foot's and kitty's hosted command begins.
//
// Whitespace splitting is enough and quoting is deliberately not parsed: the
// retired path never quoted the flag or its value. A command that hides
// `--app-id` inside a quoted argument reads as absent — and so does every shape
// the scoping now excludes. All of them leave the launch ALONE, which is the
// safe direction for a field the user may have typed.
function forcedAppIdClass(launch) {
  if (typeof launch !== "string") return null;
  var words = launch.replace(/^\s+|\s+$/g, "").split(/\s+/);
  if (!isTerminalBinary(words[0])) return null;
  var prefix = "--app-id=";
  // From 1: words[0] is the terminal binary, and the bare-word stop below would
  // otherwise end the scan on it.
  for (var i = 1; i < words.length; i++) {
    if (isTerminalArgvEnd(words[i])) return null;
    if (words[i] === "--app-id") return i + 1 < words.length ? words[i + 1] : "";
    if (words[i].slice(0, prefix.length) === prefix) return words[i].slice(prefix.length);
    if (words[i].charAt(0) !== "-") return null;
  }
  return null;
}

// Does any of this identity's own patterns claim that class? Case-insensitive
// and never throwing, because that is what the MATCHER does (engine.js
// compilePattern): a pattern that cannot compile simply never matches, and
// asking a different question here than the matcher asks would neutralize a
// launch the running plugin is perfectly happy with. The two-line duplication
// of compilePattern is the same dual node/QML loading constraint that has
// `isArray` and `own` in all three modules.
function patternsClaimClass(patterns, className) {
  if (typeof className !== "string" || !className) return false;
  for (var i = 0; i < patterns.length; i++) {
    var re = null;
    try {
      re = new RegExp(patterns[i], "i");
    } catch (e) {
      re = null;
    }
    if (re && re.test(className)) return true;
  }
  return false;
}

// v3 -> v4, and the one part of the upgrade that is not purely additive.
//
// v3's launch backfill auto-derived terminal launches as
// `<terminal> --app-id=<identity-id> <command>`: it forced a window class per
// identity so a class pattern could claim the window. That mechanism is retired
// — the terminals disagree about `--app-id` versus `--class` and alacritty has
// neither, so the derivation spells `--title` now (see TERMINAL_FAMILY in
// PanelModel.js) — but a 0.2.0 file still carries what it wrote, against an
// identity whose patterns say `^foot$`. Restoring it spawns a class-`herdr`
// window `^foot$` can never claim: strays per dock event plus a launch timeout,
// forever, and nothing downstream repairs it (launchLooksBroken passes a
// multi-word command; launchRepairIndex never overwrites a runnable non-empty
// launch). Migration is the only place this data can be dealt with.
//
// The discriminator is the IDENTITY, not the flag. `/usr/bin/foot
// --app-id=scratchpad` against `^scratchpad$` — the v1 fixture's scratchpad — is
// a correct hand-written launch, and forcing a class the identity's own patterns
// claim is exactly how a scratchpad terminal is pinned. Only a forced class NO
// pattern of the identity claims is the retired mechanism's signature.
//
// Neutralize means EMPTIED, not "strip the flag down to something runnable".
// Stripping is a guess this module cannot make: `alacritty --app-id=top top`
// minus the flag is `alacritty top`, which alacritty rejects (it needs `-e`),
// and the terminal shapes live in PanelModel, which this file must not depend
// on. Empty is the one repair the EXISTING machinery genuinely supports —
// launchRepairIndex's first case ("the field is EMPTY and something was
// derived") offers the relearn, and identitiesNeedingLaunch puts the row in
// front of the user. A stripped-but-wrong command would be non-empty and
// runnable, which is precisely the shape neither of them will ever touch.
function migratedLaunch(launch, patterns) {
  var forced = forcedAppIdClass(launch);
  if (forced === null) return launch;
  return patternsClaimClass(patterns, forced) ? launch : "";
}

// An identity without an id cannot be referred to by a layout, so it is
// dropped; everything else is repaired to its default.
//
// `migrating` is true only when the file is older than v4 — the generation that
// STOPPED deriving `--app-id` (see needsLaunchRepair, which owns that boundary
// and is the only thing that sets this). A file at v4 or later was written by a
// build that no longer derives the flag, so anything spelling it there was typed
// by hand, and a hand edit of the launch field is a decision this module does
// not overrule.
function normalizeIdentity(value, migrating) {
  if (!value || typeof value !== "object") return null;
  var id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  var patterns = normalizePatterns(value.patterns);
  var launch = typeof value.launch === "string" ? value.launch : "";
  return {
    id: id,
    patterns: patterns,
    // v4. Same coercion as `patterns` — same repair semantics, same "a typo
    // costs you the pattern, never the identity" — and always written, even
    // when empty, so nothing downstream has to tell absent from empty. An
    // identity from a v3 file gains it here; that IS the v3 -> v4 migration.
    titlePatterns: normalizePatterns(value.titlePatterns),
    launch: migrating ? migratedLaunch(launch, patterns) : launch
    // No `pictured`. v5 put a per-app photograph consent here and v7 replaced
    // it with the top-level `pictures` switch, so this whitelist DROPS the old
    // field the way it drops any other key it does not know — which is what
    // makes the v6 -> v7 migration happen on the read, with no separate pass.
  };
}

function normalizeIdentities(value, migrating) {
  var out = [];
  var seen = {};
  if (!isArray(value)) return out;
  for (var i = 0; i < value.length; i++) {
    var identity = normalizeIdentity(value[i], migrating);
    if (!identity) continue;
    // A duplicate id would make identityById ambiguous and record the same
    // window twice. First wins, consistent with the rest of the engine.
    if (own(seen, identity.id)) continue;
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

// v7 and older: a recorded workspace id. Since v8 this is only the MIGRATION
// INPUT for the slot (see normalizeSlot); it is never written back.
//
// It used to be INTERPOLATED INTO A LUA DISPATCH by the restore
// executor (`hl.dsp.window.move({ workspace = "<id>" })`), which made it the
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

// v8: a recorded slot — an integer 1..10, or null. A hand-edited numeric
// string is coerced like normalizeWorkspaceId does; 0, 11 and fractions are null.
function normalizeSlotValue(value) {
  var n = normalizeWorkspaceId(value);
  return n !== null && Math.floor(n) === n && n >= 1 && n <= 10 ? n : null;
}

// The v7 -> v8 step for one app. A recorded `slot` wins, valid or not (a v8
// entry that says null means null). Without one, the legacy workspaceId decides:
// W >= 1 -> ((W - 1) % 10) + 1, anything else (0, specials, junk) -> null.
// Inline arithmetic on purpose, Slots.js may not be required here; a test pins
// it equal to Slots.slotOf.
function normalizeSlot(app) {
  if (app.slot !== undefined) return normalizeSlotValue(app.slot);
  var w = normalizeWorkspaceId(app.workspaceId);
  if (w === null || Math.floor(w) !== w || w < 1) return null;
  return ((w - 1) % 10) + 1;
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

// v9: the workspace's layout mode when the entry was recorded. Exactly the
// three words engine.workspaceModeOf answers; anything else, absent included,
// is null — "not recorded", which never refuses and never drifts.
var LAYOUT_MODES = ["dwindle", "scrolling", "floating"];

function normalizeLayoutMode(value) {
  return (typeof value === "string" && LAYOUT_MODES.indexOf(value) !== -1) ? value : null;
}

// v9: a recorded group membership, every field kept, `active` coerced to
// true | false | null. true is the member that was the group's visible tab,
// false the others; null (a migrated v8 entry, junk, or a read that could not
// tell) never drifts and never plans a tab switch.
function normalizeGroupMembership(group) {
  var out = {};
  for (var key in group) {
    if (Object.prototype.hasOwnProperty.call(group, key)) out[key] = group[key];
  }
  out.active = group.active === true ? true : (group.active === false ? false : null);
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
      // v8. The slot is derived (from a v7 workspaceId) BEFORE the legacy field
      // is dropped, and the drop is unconditional: v8 stores no workspace id.
      placement.slot = normalizeSlot(app);
      delete placement.workspaceId;
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
      // v9. Both written unconditionally, the v2 way: an absent key in a v8
      // entry means "not recorded", and null says so explicitly. The group is
      // copied field by field too (it is the one nested object of a
      // placement), and only its `active` is coerced.
      if (app.group && typeof app.group === "object" && !isArray(app.group)) {
        placement.group = normalizeGroupMembership(app.group);
      }
      placement.layoutMode = normalizeLayoutMode(app.layoutMode);
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
// Anything at or below the current generation is UPGRADED: the whole chain runs
// in one pass (see the Migration note in the schema block — additive throughout
// bar v4's one deliberate subtraction, migratedLaunch), so a v1
// file that has been read is already a current-generation object in memory —
// the whole chain runs in one pass — and claiming otherwise on the way back out
// would be a lie about its own shape.
//
// A version from the FUTURE is preserved verbatim. This reader drops top-level
// keys it does not know, so stamping such a file with the current number would
// advertise a downgrade it did not perform; keeping the number lets parseState
// report the mismatch and writeRefusal keep the file READ-ONLY. The number
// survives the round trip in memory precisely so that every writer can see it.
function migrateVersion(value) {
  if (typeof value !== "number" || !isFinite(value)) return STATE_VERSION;
  return value > STATE_VERSION ? value : STATE_VERSION;
}

// Is this an OLDER generation than the one this build writes — the thing an
// upgrade is performed ON? The same predicate parseState reports as `migrated`,
// said once so the two can never disagree about which reads are migrations. A
// version-less object counts: nothing has written one since v1.
function isOlderVersion(value) {
  return typeof value !== "number" || value < STATE_VERSION;
}

// Is this file old enough for v4's LAUNCH SUBTRACTION to apply to it?
//
// A SEPARATE QUESTION FROM isOlderVersion, and conflating the two was a bug
// that shipped with the v5 -> v6 bump and survived to v7 (review z4b). The
// subtraction is v3 -> v4's and only v3 -> v4's: it empties a `launch` that
// forces an `--app-id` class no pattern of its own identity claims, because
// that string is the signature of a mechanism v3 retired and cannot be repaired
// downstream (see migratedLaunch). `normalizeState` passed `isOlderVersion`, so
// the moment STATE_VERSION moved past 4 the subtraction started re-running on
// every file below the CURRENT generation — a v6 identity carrying
// `foot --app-id=herdr herdr` came back with `launch: ""` while the identical
// identity in a v7 file was left alone.
//
// That is the module's own promise broken (normalizeIdentity, above): a file at
// a generation that no longer DERIVES the flag can only have got it by hand, and
// a hand edit of the launch field is a decision this module does not overrule.
// v4 is where the deriving stopped, so v4 is the boundary — not wherever this
// build's number happens to be today.
//
// A version-less object counts, for the reason isOlderVersion says: nothing has
// written one since v1.
function needsLaunchRepair(value) {
  return typeof value !== "number" || value < 4;
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
    // v7, and the default runs the other way: this one is a feature switch, not
    // a consent, so a file that does not mention it gets the pictures. A v6
    // file's answer is consulted first, and only "none" turns them off — see
    // normalizePictures and the v6 -> v7 note in the schema block.
    pictures: normalizePictures(value),
    // The v3 -> v4 step is the one migration that is not purely additive — see
    // migratedLaunch — so the identities need to know whether this read is
    // crossing it. `needsLaunchRepair`, NOT `isOlderVersion`: the subtraction
    // belongs to that one step and not to "any file older than today". Every
    // other caller of normalizeIdentities is a WRITE path and passes nothing,
    // which is the same as "no".
    identities: normalizeIdentities(value.identities, needsLaunchRepair(value.version)),
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
//               upgraded (v1 -> ... -> v9, as far as it has to go, in the one
//               pass). Not an error and not a recovery: nothing was invented,
//               and the only things dropped are the workspaceId v7 -> v8
//               replaces with a slot, the one v3 -> v4 subtracts on
//               purpose (migratedLaunch, and only for a file below v4 — see
//               needsLaunchRepair) and the two consent fields v6 -> v7 replaced.
//               The service logs it once and the next write persists the
//               upgraded shape.
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
    // READ is sound — every field this generation knows about is there and the
    // service can restore from it. The ROUND TRIP is not: normalizeIdentity is
    // a whitelist, so writing this state back would drop everything the newer
    // version added while migrateVersion kept its number. That is why the state
    // is READ-ONLY, not merely warned about — see writeRefusal, which every
    // writer of this file consults.
    error = "unexpected state version " + parsed.version + " (expected " + STATE_VERSION + ")";
  } else if (typeof parsed.version !== "number" || parsed.version < STATE_VERSION) {
    // An older (or version-less) file, upgraded in place. Reported separately
    // from `error` on purpose: an upgrade is a normal event with a happy
    // outcome, and warning about it would train the user to ignore warnings.
    migrated = true;
  }
  return { state: state, error: error, recovered: false, migrated: migrated };
}

// THE question, asked once. Both refusals below hang off it, so "is this file
// from a generation we do not understand" can never get two different answers in
// the same process. A version that is not a finite number is not from the future
// — it is junk, and normalizeState has already replaced it with this build's.
function isFutureVersion(state) {
  return stateVersionOf(state) > STATE_VERSION;
}

function stateVersionOf(state) {
  return state && typeof state.version === "number" && isFinite(state.version)
    ? state.version : STATE_VERSION;
}

// MAY this state be written back to the file it came from? Returns null when it
// may, and the REASON it may not when it may not. Every writer of the state file
// — Service.qml's writeState, Panel.qml's writeState, scripts/record-current —
// asks this first and refuses out loud with the answer.
//
// One case, and it is the destructive one: a state whose version is from the
// FUTURE. Reading such a file is safe and running from it is safe (fields have
// only ever been added), but the round trip is not, because the two halves of
// this module disagree on purpose:
//
//   - normalizeIdentity is a WHITELIST — deliberately, that is the junk repair a
//     hand-editable file needs — so every identity field a newer schema added is
//     dropped on the way in, `titlePatterns` being exactly the kind of
//     hand-authored, unrecoverable value at stake;
//   - migrateVersion PRESERVES the future number, because claiming a downgrade
//     this reader did not perform would be a worse lie.
//
// Put those together and any write — a Record, a panel edit, a pause toggle —
// persists the stripped content STILL STAMPED with the newer version. The next
// binary that understands that version then sees nothing to migrate, and what
// it added is gone. A refusal costs the user one edit; a write costs them the
// file. So: read it, run from it, never write it.
//
// Pure and here rather than duplicated in two QML files, so the rule has one
// definition and a test.
function writeRefusal(state) {
  var version = stateVersionOf(state);
  if (isFutureVersion(state)) {
    return "the state file is schema v" + version + ", newer than this build understands (v"
      + STATE_VERSION + ") — it is READ-ONLY, because writing it back would drop every field v"
      + version + " added while still stamping the file v" + version
      + ". Upgrade Dock Recall, or move the file aside, to make changes.";
  }
  return null;
}

// MAY this state DRIVE a restore? Returns null when it may, and the REASON it
// may not when it may not. `requestRestore` — the single funnel every event,
// settle pass, replayed request and manual trigger arrives at — asks this first.
//
// Same question as writeRefusal, opposite half of the same damage (tick t03,
// finding A6). Protecting only the file was protecting the wrong thing:
//
//   - normalizeIdentity is a WHITELIST, so a v6 identity reaches memory with
//     every field v6 added STRIPPED. A rule that v6 narrowed — to a profile, a
//     title, a workspace — arrives here as the class-only rule it was BEFORE
//     that narrowing existed;
//   - a restore then acts on that broader rule: it CLAIMS windows the user
//     scoped away from this identity, MOVES them, and LAUNCHES more of them.
//
// Reading the file is safe. Writing it is refused. Acting on it is neither: it
// is the read's stripped-down conclusion applied to the user's live desktop, and
// it is worse than the write, because a refused write costs one edit while a
// wrong restore rearranges everything on screen.
//
// So a future-version file is INERT. The panel still shows what it can read, the
// bar still reports drift, nothing is dispatched. Unlike `paused`, the manual
// trigger does NOT override this: the user's button cannot make a stripped
// identity list mean what the newer schema meant.
function restoreRefusal(state) {
  var version = stateVersionOf(state);
  if (isFutureVersion(state)) {
    return "the state file is schema v" + version + ", newer than this build understands (v"
      + STATE_VERSION + ") — it is INERT: this build reads it, but every narrowing field v"
      + version + " added is stripped on the way in, so restoring from it would claim, move and"
      + " relaunch windows against rules broader than the ones in the file."
      + " Upgrade Dock Recall, or move the file aside, to restore from it again.";
  }
  return null;
}

// Pretty-printed with a trailing newline: this file is meant to be readable and
// hand-editable, and it lands in a directory people `cat`. Round-tripping a
// FUTURE version through here is lossy by construction — ask writeRefusal
// before you hand the result to a file.
function serializeState(state) {
  return JSON.stringify(normalizeState(state), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Queries and updates
// ---------------------------------------------------------------------------

// A NEW state, normalized, with one or two top-level fields replaced — and the
// only shape in which the setters below are allowed to build one.
//
// It exists because every setter here used to end with the same literal:
//   `return { version: …, paused: …, identities: …, layouts: … }`
// written out four times. That is precisely the enumerated-field-list shape
// .tick/learnings.md calls "a data-loss bug waiting for the next field", and it
// has had two of them since: v6's `pictureConsent` and now v7's `pictures`,
// either of which would have survived a pause toggle and been silently dropped
// by the first Record, because upsertLayout's literal never mentioned it.
// Turning the switch off and then recording would have turned it back on.
//
// The copy is of the NORMALIZED base, so a caller handing in half a state still
// gets a whole one — and the merged RESULT is normalized too, so a key this
// schema has never heard of cannot ride in on `patch` either. Both passes are
// needed and neither is redundant: the first repairs what the caller brought,
// the second is the whitelist standing between `patch` and the object every
// setter here returns. Normalizing only the base would let
// `stateWith(state, { strayKey: 1 })` hand back a state carrying `strayKey` in
// memory — harmless on the way to serializeState, which normalizes again, and
// not harmless at all for the callers that read a setter's return directly.
function stateWith(state, patch) {
  var base = normalizeState(state);
  var out = {};
  var key;
  for (key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
  }
  for (key in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
  }
  return normalizeState(out);
}

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

  return stateWith(base, { layouts: layouts });
}

function removeLayout(state, topologyKey) {
  var base = normalizeState(state);
  var layouts = {};
  for (var key in base.layouts) {
    if (!Object.prototype.hasOwnProperty.call(base.layouts, key)) continue;
    if (key === topologyKey) continue;
    layouts[key] = base.layouts[key];
  }
  return stateWith(base, { layouts: layouts });
}

// Replace the whole identity list (the panel edits it as a list). Returns a new
// state, normalized, so a UI that hands over half-built rows cannot corrupt the
// file.
function setIdentities(state, list) {
  return stateWith(state, { identities: normalizeIdentities(list) });
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

// -------------------------------------------------- the one switch (v7)

// Does this state allow photographs? THE gate, asked by the panel before every
// capture round, every live source and every cache lookup.
//
// TRUE UNLESS THE STATE SAYS `false`, and the asymmetry is the whole point: this
// is the opposite discipline from the consent it replaces. `paused` reads
// `=== true`, and so did v5's `pictured` before v7 deleted it, because a file
// that has not said yes has not consented and a missing key must never grant
// something. `pictures` is not a
// consent — it is the feature, and it ships on — so a missing key must never
// SILENCE it either. A hand edit that mistypes the value, a key lost to a
// botched round trip, a caller holding half a state: every one of them lands on
// "take the pictures", which is what the user chose by installing this.
//
// Only the literal `false` is off, for the same reason only the literal `true`
// used to be on: `"false"`, `0` and `null` are things a hand edit produces while
// meaning something else, and the value that stops the photographs had better be
// the one the writer of this file emits.
function picturesOn(state) {
  return !(state && state.pictures === false);
}

// Throw the switch. One field, one write — and the same caller contract as
// setPaused, for the same reason: read the file FRESH, apply this, write
// atomically. The service rewrites this file underneath the panel.
//
// `on !== false` rather than `on === true`, so the reading rule is picturesOn's
// at both ends of the field's life. It matters more here than it reads: OFF is
// the destructive direction — the panel deletes every stored picture on the
// transition — and a garbled argument must not be the thing that does that.
function setPictures(state, on) {
  return stateWith(state, { pictures: on !== false });
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
  return { topologyKey: "", topologyName: "", recorded: false, driftCount: 0, shapes: [], shapeCount: 0, restoring: false, paused: false, deferredLocked: false, lastResult: null, verdicts: [] };
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

// One unmet-shape row. Rows without a numeric workspaceId are junk and are
// dropped; the other fields are repaired rather than trusted.
function normalizeShapes(value) {
  var out = [];
  if (!isArray(value)) return out;
  for (var i = 0; i < value.length; i++) {
    var row = value[i];
    if (!row || typeof row !== "object" || isArray(row)) continue;
    if (typeof row.workspaceId !== "number" || !isFinite(row.workspaceId)) continue;
    out.push({
      workspaceId: row.workspaceId,
      monitorDescription: typeof row.monitorDescription === "string" ? row.monitorDescription : "",
      meanIou: typeof row.meanIou === "number" && isFinite(row.meanIou) ? row.meanIou : 0,
      reason: typeof row.reason === "string" ? row.reason : null
    });
  }
  return out;
}

function normalizeStatus(value) {
  var src = value && typeof value === "object" && !isArray(value) ? value : {};
  var count = typeof src.driftCount === "number" && isFinite(src.driftCount) ? Math.floor(src.driftCount) : 0;
  var shapes = normalizeShapes(src.shapes);
  return {
    topologyKey: typeof src.topologyKey === "string" ? src.topologyKey : "",
    // Coerced like every other string in here, and defaulted to "" rather than
    // to a humanized key: this model has no monitor list and guessing one would
    // put a part number in the file under the name of a friendly label. "" is
    // the honest "unnamed", and the reader knows what to do with it.
    topologyName: typeof src.topologyName === "string" ? src.topologyName : "",
    recorded: src.recorded === true,
    driftCount: count < 0 ? 0 : count,
    shapes: shapes,
    shapeCount: shapes.length,
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
  var shapes = layout ? normalizeShapes(driftReport && driftReport.shapes) : [];
  var patch = {
    topologyKey: key,
    recorded: !!layout,
    driftCount: layout ? driftCountOf(driftReport) : 0,
    shapes: shapes,
    shapeCount: shapes.length
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
  if (next.shapes !== undefined) {
    base.shapes = normalizeShapes(next.shapes);
    base.shapeCount = base.shapes.length;
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
  if (current.driftCount > 0 || current.shapeCount > 0) return "drifted";
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

// What to dispatch after a monitor was removed, given whether the session is
// locked. Builds on pickFailoverTarget and adds the one case it cannot see:
//
//   Under the session lock, "focus intact" is not the same as "keyboard input
//   has somewhere to go". VM run 2 (tick s58): removing the FOCUSED output
//   while locked left input on no lock surface until the pointer touched the
//   survivor, while hyprctl went on reporting focus on the survivor. So when
//   locked, even an intact focus is re-asserted: a monitor focus dispatch
//   first, then (when the survivor's geometry is known) the cursor moved to its
//   centre, which is what actually fixed it. Only focus and cursor dispatches —
//   never a window move while locked (state-matrix §7).
//
//   { kind, name, reassert, dispatches }
//     kind        pickFailoverTarget's: "intact" | "failover" | "none"
//     reassert    true when an intact focus is being re-asserted because locked
//     dispatches  Lua strings for `hyprctl dispatch`, in order; [] = do nothing
function planFailover(monitors, lastFocusedName, locked) {
  var choice = pickFailoverTarget(monitors, lastFocusedName);
  var plan = { kind: choice.kind, name: choice.name, reassert: false, dispatches: [] };
  if (choice.kind === "none") return plan;
  if (choice.kind === "intact" && locked !== true) return plan;

  plan.reassert = choice.kind === "intact";
  plan.dispatches.push('hl.dsp.focus({ monitor = "' + choice.name + '" })');

  if (locked === true) {
    var target = null;
    for (var i = 0; i < monitors.length; i++) {
      if (monitors[i] && monitors[i].name === choice.name) target = monitors[i];
    }
    // Logical size: hyprctl reports physical pixels, the cursor lives in layout
    // coordinates.
    var scale = target && typeof target.scale === "number" && target.scale > 0 ? target.scale : 1;
    if (target && typeof target.x === "number" && typeof target.y === "number"
        && typeof target.width === "number" && typeof target.height === "number"
        && target.width > 0 && target.height > 0) {
      // hyprctl reports width/height before the transform: a rotated monitor
      // (transform 1/3, or 5/7 flipped) occupies the layout with them swapped.
      var odd = typeof target.transform === "number" && target.transform % 2 === 1;
      var lw = odd ? target.height : target.width;
      var lh = odd ? target.width : target.height;
      var cx = Math.round(target.x + lw / scale / 2);
      var cy = Math.round(target.y + lh / scale / 2);
      plan.dispatches.push("hl.dsp.cursor.move({ x = " + cx + ", y = " + cy + " })");
    }
  }
  return plan;
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
    isFutureVersion: isFutureVersion,
    writeRefusal: writeRefusal,
    restoreRefusal: restoreRefusal,
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
    picturesOn: picturesOn,
    setPictures: setPictures,
    stateWith: stateWith,
    defaultStatus: defaultStatus,
    normalizeStatus: normalizeStatus,
    normalizeVerdict: normalizeVerdict,
    normalizeVerdicts: normalizeVerdicts,
    // Exported for the cross-pin in tests/state.test.js and nothing else: they
    // are copies of PanelModel's, and the test is what keeps them honest.
    TERMINAL_BINARIES: TERMINAL_BINARIES,
    TERMINAL_ARGV_END: TERMINAL_ARGV_END,
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
    pickFailoverTarget: pickFailoverTarget,
    planFailover: planFailover
  };
}
