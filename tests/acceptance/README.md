# VM acceptance tests (Tier C)

The node suite pins the pure modules and `tests/sim-dock.sh` drives the live
desk. Neither can answer the question this directory exists for: *does a user
who installs this plugin on a real Omarchy get their windows back when they
redock?* That needs a real install, a real Quickshell, a real Hyprland, and a
desk nobody minds us restarting.

So these tests run inside a disposable Omarchy VM, driven by the `omarchy-iso`
harness. Machine setup — packages, the ISO, the reusable base image, and the
headless mechanism — is in [PROVISIONING.md](PROVISIONING.md).

## Files

| | |
|---|---|
| `run.sh` | **the entrypoint** — stage, boot, run, and answer in an exit code |
| `dock-recall-roundtrip-test.sh` | record, undock, scatter, redock, restored |
| `dock-recall-appid-migration-test.sh` | the v3 `--app-id` upgrade, end to end |
| `dock-recall-captures-test.sh` | record-time pictures, observed on the guest filesystem |
| `dock-recall-motion-test.sh` | that the motion is *wired* — bound durations, and a morph that ran |
| `dock-recall-panel-test.sh` | the panel's `IpcHandler`, on both render paths |
| `dock-recall-undock-locked-prepare-test.sh` | the locked scenario's in-guest setup |
| `undock-locked.sh` | the locked scenario's host half — QMP keyboard and screendumps |
| `vm-lib.sh` | reaching a VM the harness left running (sourced, not run) |
| `stage.sh` | builds the directory the harness pushes into the guest |
| `PROVISIONING.md` | what has to exist on the host, and where |

The in-guest runner globs `*-test.sh` and runs them **in sorted order inside one
boot**, so the file names carry the ordering. `stage.sh` says which order and
why.

## Running it

```bash
OMARCHY_ISO_HOST=<the host holding ~/git/omarchy> ./tests/acceptance/run.sh
```

That is the whole gate. **Exit 0 means every scenario passed inside the VM**;
exit 1 says which of the required lines was missing and prints every
`not ok -` from the run. It stages, pins `PATH=/usr/bin:$PATH`, and passes
`--reuse-base --no-preview`, so none of those can be forgotten. About 5 minutes,
entirely headless.

Results land in `~/git/omarchy-iso/test-runs/omarchy-4.0.1/runs/<timestamp>/`:
`serial.log`, the harness's own console captures, and `omarchy-acceptance/` with
the tests' screenshots, the state files each scenario seeded and migrated, and
`dock-recall-*-service.log` — the `[dock-recall]` lines the service itself
emitted during the run. `run.sh` also keeps the harness's own output at the
`log:` path it prints.

The underlying invocation, for when something needs to be run by hand:

```bash
stage=$(mktemp -d)
OMARCHY_ISO_HOST=<the host holding ~/git/omarchy> tests/acceptance/stage.sh "$stage"

cd ~/git/omarchy-iso
PATH=/usr/bin:$PATH ./bin/omarchy-iso-test release/omarchy-4.0.1.iso \
  --reuse-base --no-preview --sync-omarchy "$stage"
```

Two of those pieces are not optional:

- **`--no-preview`** — without it the harness ends by opening the screenshots in
  `imv` on your desktop. The VM itself is always headless (`-display none`), so
  this is the only thing that would put a window on your screen.
- **`PATH=/usr/bin:$PATH`** — the Android SDK ships a `qemu-img` from 2017 that
  shadows the system one and does not support `-F`, which the harness needs to
  create the run overlay. Without the pin the run dies at
  `qemu-img create -f qcow2 -b base.qcow2 -F qcow2`.

### Background: why `run.sh` parses lines instead of reading an exit code

**The harness exits 1 even when this test passes.** Before the acceptance suite
it runs its own `shortcut_smoke_phase`, and on the current base image three of
its checks fail for reasons that have nothing to do with this plugin:

```
not ok - launcher shortcut opens
not ok - menu shortcut opens
not ok - universal clipboard test opens Chromium
```

That is what turns the harness's exit code red, and it is why
`omarchy-iso-test`'s own status can never be the gate. What *is* unambiguous is
its output, so `run.sh` requires **all** of these lines and nothing less:

```
ok - acceptance suite passed in 122s (artifacts in /tmp/omarchy-acceptance)
ok - dock-recall round trip: record, undock, scatter, redock, restored
ok - dock-recall v3 --app-id upgrade: migrated, converged, repairable
ok - dock-recall captures: stored per consent, keyed, overwritten, evicted, and never able to fail a record
ok - dock-recall panel IPC: chips keyed and reported on both render paths, positioned and fallback
ok - dock-recall undock-while-locked: guest prepared (dr-locked on ws 8 @ dr-lock-dock, session UNLOCKED)
ok - dock-recall undock while locked: locked, undocked, focus verdict, unlocked, redocked, restored
```

All of them, because any one alone is a lie. The suite's line on its own would
go green if the test files never reached the guest and nothing dock-recall-shaped
ran at all; a test's own line alone would mean the suite aborted somewhere after
it. `run.sh` matches them literally and **anchored to the start of the line**, so
a change to any message is a loud failure rather than a quiet fuzzy match — and
`not ok - <the same text>`, which contains the required substring, can never
satisfy the gate for the test it belongs to.

That list is one entry per staged in-guest `dock-recall-*-test.sh`, plus the
host-driven locked scenario, plus the suite's own line, and `run.sh` checks that
arithmetic against what `stage.sh` actually staged before it boots anything. A
new test file that nobody added to the list stops the run rather than quietly
not being required.

A whole run takes about 5 minutes with `--reuse-base`; the suite itself is about
two of those.

## How the plugin reaches the guest

`--sync-omarchy DIR` tars `DIR/test/acceptance` and `DIR/test/acceptance.d` into
the guest and runs the suite from there. Nothing else crosses. So `stage.sh`
puts the plugin tree **inside `acceptance.d/dock-recall/`**, where it rides
along with the test file, and the test installs it from that local path the way
`scripts/dev-install` does: rsync into `~/.config/omarchy/plugins/`,
`rescanPlugins`, `enablePlugin`, then restart the shell.

The alternatives were rejected deliberately:

- **`omarchy plugin add <git-url>`** — the honest user-facing route, but it needs
  the branch pushed to a remote. A test must be runnable on an unpushed branch.
- **`--sync-all`** — pushes a whole omarchy checkout and repoints `OMARCHY_PATH`
  at it, changing what is under test beyond the plugin.
- **scp into the guest** — no hook: the guest is only reachable through the
  harness's own SSH session, which exists for the length of `acceptance_phase`.

## What the test asserts

A full round trip against a fake dock (`hyprctl output create headless`, the
same trick `sim-dock.sh` uses):

1. install the plugin, enable it, restart the shell so the *service* is really
   live — a hot-reloaded service runs QML but never starts a `Process`;
2. launch `foot --title=dock-recall-acceptance`;
3. dock: create the headless output;
4. move the window to workspace 7 on the dock and **record the layout through
   the engine** — `engine.topologyKey`, `engine.monitorLabel` and
   `StateModel.upsertLayout`, written atomically;
5. undock: remove the output, **then scatter the window to workspace 1**;
6. redock: create the output again, and assert the window came back to
   workspace 7 on the dock.

Step 5's scatter is what gives the test teeth, and it is not optional. Removing
the monitor alone proves nothing: the window cannot be "on the dock" while the
dock does not exist, so step 6 would go green the moment Hyprland put
workspace 7 back on the reappearing output from its own workspace-to-monitor
memory — with the plugin asleep. Moving the window to a workspace the recording
does not name removes that explanation, so only something that has read the
recording can put it back.

`success-dock-recall-<step>.png` is captured at each visually distinct state;
`base-test.sh`'s `fail` captures `failure-<step>.png` before aborting.

The layout is recorded through the engine rather than by hand-writing it, and
rather than by driving the panel: a hand-written layout rots at the next
`STATE_VERSION` bump, and the panel has no IPC for Record — its only summon
payload is `{"focus":...}`. Recording through `StateModel` is the same code path
the panel writes with, so the file is always schema-correct.

The identity the test watches *is* hand-written — a literal JSON seed, because
there is no engine call that means "start watching this". Its `version` field is
read out of `StateModel.STATE_VERSION` rather than typed in, which is the part
that would otherwise rot: a seed declaring an older version is read as a
migration, and v4's migration is not purely additive (it can rewrite `launch`),
so a stale number would quietly change what the test believes it seeded.

## What the v3 `--app-id` upgrade test asserts

`dock-recall-appid-migration-test.sh` is the end-to-end proof of finding A1. A
0.2.0 state file carries launch commands the retired backfill wrote —
`<terminal> --app-id=<identity-id> <command>` — which force a window class the
identity's own patterns can never claim. Restoring one spawns a stray window per
dock event plus a 10-second launch timeout, forever. The fix is in the v3 → v4
migration: `StateModel.migratedLaunch` EMPTIES a launch whose forced class no
pattern of the identity claims, and leaves every other launch alone.

The node suite pins that rule against fixtures. This test asks the question the
fixtures cannot — *does a real v3 file, read by a real service, on a real dock
event, converge?* — with two identities, because the discriminator is the
identity and not the flag:

| | patterns | launch | must become |
|---|---|---|---|
| subject | `^foot$` | `foot --app-id=herdr herdr` | `""` |
| control | `^scratchpad$` | `/usr/bin/foot --app-id=scratchpad` | byte-identical |

The seed's `version` is **hardcoded 3**, which is the one place this directory
does not read `StateModel.STATE_VERSION`: the file *is* a v3 file, and reading
the current version would silently stop testing anything the day the schema
moves on. What
the test does read out of `StateModel` is that 3 is genuinely in the past, so a
future bump makes the seed staler rather than inert.

It then proves three things in sequence:

1. **the service, on the v3 file** — its own log announces the upgrade; no
   `herdr` window appears at any point across 45 seconds of polling; no launch
   is dispatched for the subject at all and `--app-id=herdr` appears nowhere in
   the log; and the launch-timeout count is 0 and still 0 thirty seconds later.
   The file on disk is asserted **still v3**, because that is a contract too:
   the service upgrades in memory and never rewrites a file nobody asked it to
   change.
2. **the write** — the migration persists at the next legitimate write, and none
   of the three (Record, a panel edit, a pause toggle) has an IPC surface a
   headless test can drive. So the test performs the plugin's own write path
   itself: `StateModel.parseState` → `serializeState` → temp-and-rename, the
   same serialization `Panel.writeState` writes. `parseState` is the code under
   test, not a re-implementation of it. The file that lands is at the current
schema version, subject
   emptied, control verbatim.
3. **the file the user is left with** — the persisted, upgraded file is reloaded by the
   live service (no second migration announced), a second dock event runs, and
   nothing strays and nothing times out.

Assertion (d), that an emptied launch is not a dead end, is checked through
`PanelModel`: `identitiesNeedingLaunch` lists the subject and not the control,
and `launchRepairIndex` offers the subject a derived command while leaving the
control's runnable one alone. Empty is precisely the shape the repair machinery
supports; a stripped-but-wrong command would be non-empty and runnable, which is
what neither of them will ever touch.

Both seeded and migrated state files are copied into the artifacts directory, so
the migration is auditable after the VM is gone.

## What the captures test asserts

`dock-recall-captures-test.sh` is the one test here whose evidence is **files**.
Everything else in increment 06-bwf is proven at bind level, because this venue
cannot show a pixel was rasterized — but a picture on disk is a real artifact. It
can be counted, named, opened and shown to be a JPEG, which is strictly stronger
than any payload field, so the claim is made against the guest filesystem rather
than through the IPC.

Two apps, both watched, both class `foot`, told apart by `titlePatterns`: one has
granted the **second consent** (`pictured: true`) and one has not. The pair is
the point. A run with only the consenting app would pass identically on a plugin
that photographed everything it watches.

| | |
|---|---|
| the write | Record stores exactly **one** picture, and it is the file `PanelModel.captureFileName(identity, occurrence, topologyKey)` names — asked of the plugin's own function, with the topology key read out of the state file the record just wrote |
| the consent | the withheld app is watched, running and **in the recording**, and has no file. Asserted by name as well as by count |
| the format | a 30-line SOF parser in node walks the segment chain to a frame header and reads the width. `file` would say only that two bytes are right, and neither host nor guest has an imaging library — walking to a frame marker is the decode this venue can honestly perform. The width must be ≤ 512 |
| re-record | records again and requires the file to have been **written again** (mtime, not bytes: an idle terminal really can encode to the same JPEG twice) |
| undo | the layout comes back and the pictures go. Undo cannot put pictures *back* — the re-record overwrote them in place — so the restored recording falls back to icons, asserted as behaviour rather than left as a surprise |
| forget | the delete point: no picture of this topology survives it |
| a failed capture | the cache directory is made **uncreatable** and a Record is performed. It must answer `recorded`, the state file must carry the layout with both apps and a timestamp, and no picture may exist. Driven, not argued |
| a wiped cache | the whole directory is deleted under a live panel. Every chip must go on reporting an icon source, no chip may report a `capturePath`, and nothing may error |
| both render paths | the layout's geometry is stripped so the recorded map drops to the stacked fallback, and the **same file** must still be drawn there — at a tier that carries the app's name |
| the first-Record dialogue | the **first** Record with picturable apps puts the panel in the consent state: `consentOpen`, `pictureConsent: "unasked"`, exactly three answers (`keep` / `not-these` / `none` — ids from the model, labels from the buttons that drew them), and a thumbnail whose Image reports **Ready** at the same URL the recorded map binds. A strip of empty boxes would satisfy a count, so `ready` is asserted and not only `source` |
| asked once | the answer is read back off the state file, the **shell is restarted**, and the restarted panel still reports it. Then a Record — the same event that opened the prompt the first time — must not reopen it |
| "Delete these" | driven end to end: the cameras go off **and** the pictures already taken are deleted. Either half alone is the wrong behaviour — a camera left on photographs them again at the next Record, and a picture left on disk is exactly what the user just said they did not want kept. Reaching the second ask means setting `pictureConsent` back to `"unasked"` in the file, which is what a user who wanted asking again would do |
| the live map | the Live map draws what the windows look like **now**, from memory: every app whose camera is on reports `liveCapture: true` with a non-empty `liveSource`, the withheld app reports neither, every chip still reports an `iconSource`, and **the cache directory is not even created**. Asserted between the wiped-cache step and the unwritable-cache step, both of which need that directory gone, so the filesystem carries the claim rather than a count. Then the camera is switched off with the panel still open and the live pictures stop — no reopen |
| one capture deleted | the file goes and the panel is re-summoned. It must be offered no picture at all: no `captureSource`, no `capturePath`, icon and name intact. Asserted on a fresh panel because that is the honest shape — within one session a chip that already decoded its picture goes on drawing it, and the shell destroys the panel on hide anyway |

**How a Record is reached.** Through the panel's own `record`, `undoRecord` and
`forgetLayout` verbs. That matters: pictures are taken by the *record path*, and
`scripts/record-current` writes through `StateModel` without ever opening a
panel, so it takes no captures and never could.

**Where the pictures are not.** `~/.cache/omarchy/dock-recall/`, and never the
state file. A cache is a directory a cleaner is allowed to wipe, the correct
behaviour when it does is that the map falls back to icons, and keeping the
pixels out is what preserves the README's "writes one state file" promise byte
for byte. The test asserts the guest has no `XDG_CACHE_HOME` before it believes
anything about that directory — a guest that set one would send the plugin
somewhere else, and every file assertion would look exactly like a pipeline that
stores nothing.

## What the panel IPC test asserts

`dock-recall-panel-test.sh` is the first test here that opens the **panel**.
Everything else watches the service — the state file, `hyprctl`, the
`[dock-recall]` log — and the round trip's notes above say why it avoided the
panel: it had no IPC to ask.

It has one now. `Panel.qml` registers an `IpcHandler` on the target
`dock-recall`, and because the shell's panel loader instantiates the component
only while the panel is open, **that target exists only while the panel is up**.
Summon it first:

```bash
omarchy-shell shell summon mkelk.dock-recall '{}'
omarchy-shell dock-recall state                  # the payload below
omarchy-shell dock-recall setView recorded       # "live" | "recorded" | "unknown" | "no-recording"
omarchy-shell dock-recall setPaused on           # "paused" | "active" | "unknown" | "no-state"
omarchy-shell dock-recall setOverflow open       # "open" | "closed" | "unknown"
omarchy-shell dock-recall toggleRow <row key>    # "toggled" | "not-clickable" | "no-row" | "unknown"
omarchy-shell dock-recall setPictured <row key> on
                                                 # "on" | "off" | "not-picturable" | "no-row" | "no-state" | "unknown"
omarchy-shell dock-recall hoverLink <link key>   # the key now hovered, or "none"
omarchy-shell dock-recall record                 # "recorded" | "refused" | "cannot-record" | "no-state"
omarchy-shell dock-recall undoRecord             # "undone" | "refused" | "nothing-to-undo"
omarchy-shell dock-recall forgetLayout           # "forgotten" | "nothing-to-forget" | "no-state"
omarchy-shell dock-recall answerConsent keep     # "keep" | "not-these" | "none" | "not-asking"
                                                 #   | "refused" | "no-state" | "unknown"
```

The last three exist because **Record is the moment a picture is taken**, and
until they landed the act had no door a headless test could open:
`scripts/record-current` writes through `StateModel` without ever instantiating
a panel, so it takes no captures and never could. Each routes to the panel's own
`recordLayout` / `undoRecord` / `forgetLayout` — the fresh read, the atomic
write, the one-shot undo stash and the cache eviction — and each answers what
*happened*. None of them waits for the pictures: the capture round is
best-effort and runs after the write, so `"recorded"` is a claim about the state
file alone.

`setPaused` answers the position the switch is **in afterwards**, which is not
always the one asked for: a read-only state file refuses the write and the switch
stays where it was. It goes through the panel's own `setPaused`, the one place
that re-reads the file before writing — an IPC path that set the flag directly
would be a second writer with none of that discipline.

```json
{
  "topologyName": "Laptop + Dell U2720Q",
  "showRecorded": false,
  "recordedAt": "2026-09-03T09:12:44.101Z",
  "recordedAge": "recorded 3 days ago",
  "headerTitle": "Laptop + Dell U2720Q",
  "headerMeta": "Drifted (1) · 3 apps watched",
  "paused": false,
  "badgeText": "Drifted (1)",
  "badgeTone": "accent",
  "overflowOpen": false,
  "overflowLayouts": [],
  "pictureConsent": "unasked",
  "consentOpen": false,
  "consentChoices": [],
  "consentCaptures": [],
  "workspaces": [
    { "id": 7, "name": "7", "monitorName": "eDP-1", "renderPath": "positioned",
      "badgeValue": "7", "badgeFocused": true }
  ],
  "chips": [
    { "key": "0x5581f0a1", "name": "Alacritty", "workspaceId": 7,
      "monitorName": "eDP-1", "watched": true, "pictured": false,
      "liveCapture": false,
      "renderPath": "positioned", "placed": true, "width": 214, "height": 120,
      "iconSource": "file:///usr/share/icons/hicolor/scalable/apps/obsidian.svg",
      "iconResolved": true, "treatment": "pill",
      "fillState": "watched", "edgeTone": "drift" }
  ]
}
```

### Absent vs `null` — the normative statement

**This section is the payload contract.** `Panel.qml`, `PanelModel.js` and
`dock-recall-panel-test.sh` all obey it and all three now *cite* it rather than
restate it. That is deliberate and it is the whole reason it is written down
here: the rationale used to be spelled out in full in four places, so the next
field added to the payload meant four edits, three of them in files nowhere near
the code that changed. Four copies of a rule is four chances for one of them to
go quietly stale, and a stale copy of a contract is worse than no copy — a reader
who finds it has no way to know it is the old one.

Here, and nowhere else. Add a field to the payload and this is the paragraph to
extend.

The fields the rest of increment 06-bwf fills in — `fillState`, `treatment`,
`badgeValue` — are **not in the payload at all** until the tick that computes
them lands. They are not there as `null`. The convention, settled before the
first consumer:

| the payload | means | a consumer tests |
|---|---|---|
| the key is **absent** | the panel has nothing to say about it: no tick computes it yet, or the thing it describes does not exist | `jq 'has("treatment")'` |
| the key is present and **`null`** | computed, and the answer is genuinely empty | `jq '.iconSource == null'` |
| the key is present with a value | that is the answer | `jq '.iconSource'` |

So a consumer asks `has("k")` first and only then looks at the value, and a
later tick **adds** its key rather than un-nulling one.

The distinction is not hypothetical. `recordedAt` is implemented, and it used to
report `null` both for *this topology has no recording* and for *the recording
carries no timestamp* — two different sentences for the dated Recorded header to
say. It now answers:

```bash
omarchy-shell dock-recall state | jq 'has("recordedAt")'   # false → no recording at all
omarchy-shell dock-recall state | jq '.recordedAt'         # null  → a recording with no timestamp
```

`recordedAge` travels with it and answers the same two ways: absent when there is
no recording, `null` when there is one that carries no timestamp. It is the age
in words — "recorded 3 days ago" — computed from the recording's **own**
`recordedAt` and never from a file mtime, because one state file holds every
topology's layout and its mtime is the last time *any* of them changed. A stale
recording under a fresh mtime is exactly the lie this line exists to prevent, and
it is what will let the next epic's captures be honest about their own age.

The **Recorded** tab puts it in the hero's `headerMeta` and the **Live** tab does
not: when a layout was recorded is a fact about the other tab. The test asserts
both sides — the recorded payload's `headerMeta` must contain `recordedAge`, and
the live payload's must not mention "recorded ".

No schema change was needed: `recordedAt` has been a normalized layout field
since v1 (`StateModel.normalizeLayout`), so the dated header cost the schema
nothing.

`renderPath`, `placed`, `width`, `height`, `iconSource` and `iconResolved` are
`null` while the delegate that draws the chip has not reported yet — a transient
of the first frames, which is why every assertion here is polled.

### Icons

`iconSource` is what the chip's `Image` was bound to and `iconResolved` says
whether it is the app's own icon or the generic executable one. The flag exists
because `AppLibrary.iconSource` **never answers empty** — it falls back to
`application-x-executable` — so a non-empty source proves only that something
will be drawn, not that it is the right thing. The test asserts both, on a chip
whose app has a desktop entry with an `Icon=` and on a window class no desktop
file claims, on **both** render paths. On the fallback path a recorded chip has
no window class at all, so that half also pins that the lookup falls back to the
identity's own patterns.

The honest limit: an app whose desktop entry really does say
`Icon=application-x-executable` reports `iconResolved: false`. It is drawing the
generic icon, which is what the flag is about.

### The treatment ladder

`treatment` is which of five drawings a chip earned — `pill` (icon and name),
`badge` (the icon alone), `strip` (icon and name on one line, for a chip wide
enough for a word and only one line tall), `veiled` (the content veiled, the icon
centred), `field` (the colour field alone). The panel asks
`PanelModel.chipTreatment` with the size it **drew** at, which is why the
function is standalone rather than baked into the model: the fallback path never
calls `chipRectsForCanvas`, so a treatment carried on the model would be silently
wrong there.

The test does not merely check the word is one of five. It **re-derives** the
tier from the `width` and `height` reported beside it, using the ratified
cutoffs restated in `jq`, for every chip on both paths. A panel that asked
`chipTreatment` with the wrong numbers reports a tier its own geometry does not
earn, and that is the failure this catches. The cutoffs therefore live in two
places on purpose — a test that imported the answer would agree with a wrong
one.

Self-consistency is not enough on its own, and the `strip` tier exists because it
was not. Re-deriving the tier from the reported size passes a panel whose whole
Recorded tab is nameless icons, because a 210×17 stacked row really does earn
`veiled` under a ladder that demands both axes — those cutoffs were ratified
against positioned, window-shaped chips, and the fallback stack is the one shape
where both-axes is the wrong question. So three further assertions run beside the
re-derivation: a fallback chip must reach a tier that **draws its name**; every
fallback chip must clear the same 16×10 floor the positioned ones do (the floor
was asserted only on the positioned path, so a fallback laying every chip out at
0×0 passed everything); and a run must exercise **more than one tier** across its
two maps, so a collapsed ladder fails the gate instead of being visible only to a
human reading the log.

`chipLabelVisible` is gone. It decided the label on width alone, and two
thresholds disagreeing about whether a chip has room for its name is what the
ladder exists to end.

### Two colour channels, and why they are two

`fillState` is the durable state — `watched`, `ghost` or `unwatched`, one fill
each. `edgeTone` is what the outline says — `drift`, `hover`, `watched` or
`quiet`. They are separate fields because a chip can be two things at once: the
seeded app is recorded on a workspace it is not on, so it reports
`fillState: "watched"` **and** `edgeTone: "drift"`, and a payload that blended
them could not say so.

The fills exist at all because the outline used to carry nearly everything, and
the hover fill *replaced* the watched one — so a watched chip under the pointer
was indistinguishable from an unwatched one. Hover is now a translucent layer
over whichever fill the chip already had, which is also why it is not in
`fillState`: it is transient, and a polled payload would race it.

The ghost fill is only ever visible on the **recorded** map. A ghost is by
definition an app that is not running, so it has no live chip anywhere; the test
seeds a second watched identity it never launches to reach that state.

`fillState` is cross-checked against `watched` on every chip, which is what stops
the panel reporting a fill it did not draw.

### Workspace number badges

`badgeValue` is what the badge reads and must equal the workspace's own name;
`badgeFocused` says whether it is the accent-filled one. **At most one badge is
filled per payload** — every monitor has an active workspace and only the focused
monitor is in front of the user, so a second filled badge means the focus rule
leaked across monitors. Zero is legitimate: a headless output set has no focus at
all, and `PanelModel.focusedWorkspaceKey` answers `""` rather than guessing.

The badge shows the **live** desk's focus on both maps. On the recorded map that
is the point: the recording says where the windows belong, and "you are standing
here" is the one thing about it that has to come from now.

### The header

The header is the shell's `Ui/PanelHero`: a monitor glyph, the topology name as
`title`, the status line as `meta`, and a `Ui/ToggleSwitch` for Pause as its
`trailingControl` — the hero reserves that space itself, which the hand-rolled
chain of right-to-left anchors it replaces did not.

`headerTitle` and `headerMeta` are what the hero was **handed**; `topologyName`
is what the panel computed. They agree by construction, which is what makes a
disagreement worth failing on.

That the header **is** a `PanelHero` is not something this payload can show: a
hand-rolled `Item` with two `Text` elements and the same two `reportHeader` calls
would report the same strings. It is pinned in `tests/qml-plaintext.test.js`
instead — the repository's source-scan file — which requires exactly one
`PanelHero` element in `Panel.qml`, requires the `headerTitle`/`headerMeta` report
to be bound to *that element's* own `title` and `meta`, and requires it to still
be handed the icon component and the trailing control. Those last two are the
structural reason for using the shell's component at all: the hero reserves the
trailing control's width itself, and the chain of four right-to-left anchors it
replaced grew a link with every addition to the row.

The status badge deliberately did **not** move into the hero's `detail` pill.
That pill has one fixed border colour, and `PanelModel.badgeFor` maps six states
onto four tones — `ok`, `muted`, `accent`, `urgent` — which is the only channel a
glance uses. The six are enumerated in `tests/panel.test.js`; the VM drives
`setPaused` and watches the switch position and the badge move together, because
`Paused` outranks `Drifted` on the badge exactly as it does on the bar glyph.

`overflowLayouts` is reported by the menu's row **delegates**. A shut menu lists
nothing however many layouts are on disk — the delegates outlive the popup being
closed (tick `be1`), so it is `panelState()` that gates on `overflowOpen` — and a
non-empty list is evidence that rows were drawn rather than that a model could
have produced them.

The delegates report under the layout's `topologyKey`, not its display `name`:
`humanizeTopology` truncates a desk to two monitor labels, so two desks with the
same make and model and different EDID serials share a name, and keying on it
would have both rows carrying whichever delegate finished last — `current`
included. The payload still carries the name, which is what a consumer reads.

### The first-Record dialogue

Four keys, answering four different questions:

| key | question |
|---|---|
| `pictureConsent` | what the **file** says the user answered: `"unasked"`, `"keep"`, `"not-these"` or `"none"`. Schema v6, beside `paused`, so it survives a shell restart — which is what makes "asked once" a claim about the tool and not about one panel session |
| `consentOpen` | is the prompt on screen right now |
| `consentChoices` | what it is **offering**, from the buttons that drew it: `{id, label}` per answer. The id comes from the model and the label from the button, so a prompt offering the right three ids under the wrong three words fails |
| `consentCaptures` | what it is **showing**: `{identityId, occurrence, name, source, ready}` per thumbnail. `ready` is `Image.Ready` and nothing looser — a strip that reported three sources and one ready picture is a prompt showing the user two empty boxes |

The last three are reported by the prompt's own delegates and are empty while it
is shut, on the same discipline `overflowLayouts` uses: never reset, gated at
read time on `consentOpen`, and iterated from the **model** so a report left over
from a previous offer cannot enter the payload.

`answerConsent` routes to the panel's own `answerConsent` and nothing else — the
one place that re-reads the file, composes the answer and any withdrawal into a
**single** write, evicts the pictures *after* that write goes through, and logs.
An IPC path that set `pictureConsent` directly would record an answer without
performing it: a "Delete all" that deleted nothing.

### The app list

Every row is the shell's `Ui/Toggle` — the *labeled* one, which wraps a
`ToggleSwitch` with `interactive: false` so the row owns the click. The icon and
the right-hand launch hint and placement text sit outside it, because `Toggle`
gives its label whatever width is left after the switch and there is no way to
reach in past that.

`PanelModel.appRows` builds **three** row states and the test requires all three:
an unwatched live window, a watched identity, and a recorded-but-unwatched
**ghost**. The ghost needs a watched identity that is never launched, which is
why the seed carries a second one — a run exercising only watched rows misses
two thirds of this.

`toggleRow` calls exactly what `Toggle`'s `clicked()` calls. It ticks the
**no-entry** window rather than the seeded one: unticking the seeded app would
delete the identity its recorded layout names, and ticking it back would mint a
new id rather than restore it. The assertion is that the row's `watched` and the
chip's `fillState` move **in one query** — they are written by two different
delegates reporting independently, so a payload in which only one changed is a
real split between the list and the map.

### Window titles are never markup

Qt's `Text.textFormat` defaults to `Text.AutoText`, which renders a string that
looks like HTML **as** HTML. The panel draws strings it did not write — window
classes from Hyprland, identity ids from a user-editable state file, monitor
descriptions from an EDID, and through the terminal proposal, names derived from
a window's own title, which an application picks for itself.

Every `Text` in `Panel.qml` therefore declares `textFormat: Text.PlainText`, and
`tests/qml-plaintext.test.js` fails naming the line if a new one does not. The
rule is *all* of them rather than the ones that can currently be argued to reach
a title, because that argument would have to be re-made correctly by every future
author. The same test asserts the shell components the panel hands untrusted
strings to (`Ui/PanelToolTip`, `Ui/Toggle`, `Ui/PanelHero`) still declare it too —
the tooltip carries a raw window title, and that binding is not ours to guard.

### The second consent

`pictured` is on chips **and** rows; `picturable` is on rows alone. Being
*watched* lets the tool move an app's windows; being *pictured* lets it
photograph them at Record and keep the picture on disk. Those are different
permissions — someone who wants their password manager restored has not agreed
to have it photographed — so they are two fields, granted separately, and
`pictured` defaults **off**.

`picturable` exists because `pictured: false` says two different things. A
watched app that has withheld the grant reports `picturable: true,
pictured: false` and draws a camera; an unwatched live window and an orphaned
recorded ghost report `picturable: false` and draw none, because `pictured` is a
field **on an identity** and an identity exists exactly while the app is
watched. The camera is on the **row** rather than on the chip: the map is
already the control surface for the first tick, and a second consent there would
have to be a modifier-click or a second hit zone inside a rectangle that is
16 × 10 px at its floor — an invisible affordance for a privacy decision.

Two invariants are checked on every payload: a chip that is not watched is never
pictured, and a row that is not picturable never is. The grant itself is driven
by `setPictured <row key> on|off`, which routes through the panel's own
`setPicturedFor` — a fresh read of the file, `StateModel.setPictured` (one
field, one identity, every other identity byte-identical), and a log line gated
on the write. Like `setPaused` it answers the position the camera is **in
afterwards**, so a refused write is visible without reading a log.

The test then requires that the grant moved **only** `pictured`: the row is
still watched, no other row became pictured, and the state file on disk still
carries both identities with the seeded one's patterns and launch unchanged. It
restarts the shell and re-asserts, because a flag that lives only in a panel
property is not a consent the user gave.

The limit, pinned in `tests/state.test.js` so it is a decision rather than a
surprise: unwatching an app removes its identity and takes the grant with it,
and re-watching starts from the default. Consent is not remembered for an app
nobody is watching, which is the safe direction.

### The stored picture

`capturePath` is on chips, on the **recorded** map only, and it is **absent**
when the cache holds no picture for that chip — never `""`, never `null`. It is
the absolute path of the file, and it is panel-computed rather than
delegate-reported: it is the claim *the cache has a picture for this identity,
occurrence and topology*, which is a different sentence from *the chip drew it*.
The second sentence is `captureSource`, reported by the delegate that bound the
`Image`.

It is gated on a directory listing rather than on the name simply being
computable, because an `Image` pointed at a path that is not there draws nothing
and reports a source anyway — "the panel says it has a picture" has to mean the
cache does. The listing is re-read when the panel opens and when the topology
changes; a different desk is a different key prefix.

It is off the Live map on purpose. The cache key is the recording's, and a
picture is a fact about a recorded layout: the Live tab draws the windows that
are on screen, and offering it a photograph of one of them answers a question
nobody asked.

`captureSource` is the second half, and the two are deliberately not one key.
`capturePath` is what the **panel** says — the cache holds a file for this chip.
`captureSource` is what the **chip** says: the `file://` URL its `Image` was
bound to, reported only once that `Image` says `Ready`, so it never claims a
picture the map could not make good on. They agree by construction, which is
what makes a disagreement worth failing on — a chip reporting a path and no
source is one the map decided not to draw.

The capture is drawn as the chip's **ground**: first in document order, so the
veil quietens it and the icon and the name paint on top, and it is a *sibling*
of the content Column rather than a member of it. That is what keeps it from
pushing the name out — and it matters most on the **fallback** path, whose
210 x 17 stacked rows are the whole Recorded map and are where names were only
just restored. The test asserts the same picture on both paths, on a chip that
still reports its name and its icon, and it reaches the fallback by stripping
the layout's geometry rather than by re-recording: the cache key carries no
geometry, so it is literally the same file on the other render path.

### The live picture

`liveCapture` and `liveSource` are the Live map's answer to `capturePath` and
`captureSource`, and the pair is shaped the same way on purpose: one claim from
the **panel**, one from the **chip**.

`liveCapture` is on **every** chip and is **always** a boolean — never absent,
never `null`. It is the panel's claim: *a photograph of this window, taken when
the panel opened, is in memory right now*. It is `false` on the Recorded map, on
a chip whose app has no camera, and in the moments before the grab lands.

It is a boolean and not a path **because there is no path**. Live pictures are
held in memory only — photographed when the panel opens, drawn from memory,
never written to disk, discarded when the panel closes — which is the human's
ratified choice for this feature, made after being shown an on-disk cache as the
alternative. The whole consent architecture around `capturePath` is about
pictures that *persist*: where they are, how they are evicted, what a withdrawal
deletes. A live picture has none of that surface, and the absence of a path in
this payload is that design saying so. **A test that finds a file on this path
has found a defect**, not a detail: the captures suite asserts the cache
directory is untouched while the Live map is drawing.

`liveSource` is the chip's half: the in-process image URL its `Image` was bound
to, reported only once that `Image` says `Ready` — so it never claims a picture
the map could not make good on. It is **absent** when there is none, never `""`,
exactly as `captureSource` is. It is not a `file://` URL and must not be checked
as one; what a consumer can assert is that it is non-empty on a chip whose
`liveCapture` is `true`, and that the chip's `iconSource` is still there.

`liveSource` and `captureSource` are **mutually exclusive**. Each is gated on
`showRecorded` in the panel function behind it, on opposite sides, so no chip may
ever report both — the Recorded map draws out of the cache and the Live map draws
out of memory, and a chip reporting both would mean one of the two gates had gone.

**A chip is never blank.** A live grab takes a moment to arrive and can fail
outright — a window on a monitor that is not rendering never delivers a frame —
and for every one of those moments the chip draws its **icon**, through exactly
the mechanism the Recorded map already used (`Image.Ready` gates the picture, and
the icon steps aside only for a picture that arrived). So `liveCapture: false`
with a non-empty `iconSource` is the correct, complete state of a chip whose
picture has not landed, and no consumer should read it as a fault.

**Record stays available while a live round runs.** `captureStore.busy` dims
Record so two capture rounds cannot interleave; a live round on every panel open
sharing that flag would dim Record for a moment every time the panel appeared.
The dependency therefore runs one way only: the live round stands aside for
Record — parking mid-queue and walking on afterwards — and Record never waits for
it. `canRecord` does not mention the live store, and a source-scan test pins that.

**Consent is shared and unchanged.** An app is photographed live only while its
camera is on, read through the same `pictured` flag Record obeys. Switching a
camera off stops the drawing in the same frame the flag is written and takes the
pixels out of memory, with **no panel reopen** — and `liveCapture` goes `false`
for that app's chips accordingly.

Granting one does *not* work in reverse within a session: the round is taken when
the panel **opens**, so a camera switched on under an open panel produces a live
picture at the next open. That is the same shape as the recorded half — granting
a camera does not create a stored picture either; it grants what the next
picture-taking act may do.

### The row-to-chip link

`linkKey` is on chips and rows; `linked` says whether that surface is lit right
now. One key, and everything answering to it lights up whichever direction the
pointer came from. `hoverLink` sets `hoveredLinkKey`, which is exactly what a
hover on either surface sets — driving a real pointer would need a
`zwlr_virtual_pointer_v1` client, which is a live-session rig this increment does
not use. The test requires that the key lights its row *and* its chips **and
nothing else**, then that clearing it darkens both.

### The chip's name

`name` is the odd one out among the chip's fields: every other draw-time value is
reported by the delegate that drew it, and this one is read straight off the
model — so "the chip reports what it drew" is weakest exactly where nothing was
pinning it. It now is. Every chip on both paths must carry a non-empty one, and
the two single-instance windows are checked against the **row** that names the
same app, found through the `linkKey` the chip reports. The row's name *is*
delegate-reported, so the pair is two sites rather than one value read twice —
and one name per app across both surfaces is what the hover already promises:
the row and the chips that light up with it are one thing.

### The chip's three motion fields, and the bar's own handler

`fillMotionMs`, `edgeMotionMs` and `motionEasing` are on chips, and they are
draw-time: `null` until the delegate has reported, like every other value the
chip itself says. They are read off the chip's own **animation objects** —
`fillFade.duration`, `edgeFade.duration`, `fillFade.easing.type` in
`MapWorkspace.qml` — and never off `Motion.qml`'s tokens. That distinction is
the whole assertion. This venue cannot watch a colour move, so the most it can
honestly ask is whether the property is bound to an animation with a real
duration, and only a number that came from the animating thing answers it: a
number restated from `Motion.qml` would pass on a panel whose `Behavior`
somebody had deleted.

Two channels, two durations, for the reason `fillState` and `edgeTone` are two:
a chip can become drifted without becoming watched, and one animation would make
the edge wait for the fill.

`motionEasing` is Qt's easing enum and is **Linear (0)** for both colour fades by
design — Omarchy's own `Ui/ToggleSwitch` gives its `ColorAnimation` no curve and
its knob `OutCubic`, two shapes and one duration, and this plugin copies that
rather than inventing one. Said with its limit: a deleted `Behavior` also reports
0, so the Linear clause states the convention and the **durations** are what
catch a deletion.

**The bar widget is a second IPC target**, `dock-recall-bar`, read-only, one verb:

```
omarchy-shell dock-recall-bar motion
  → { glyphFadeMs, glyphFadeEasing, sweepMs, sweepRunning, sweeping, glyph }
```

It is a separate target rather than a second verb on `dock-recall` because the
bar widget is a separate top-level entry point — loaded by the bar and not by the
panel loader — so nothing in `Panel.qml` can see into it, and the panel's payload
has no route to `glyphFade` or `sweepRun` at all. The widget owns no state and
writes nothing, which is what keeps an enabled bar free; this handler reports
what its two animation objects say about *themselves*, for the reason the chip's
three fields do.

`sweepRunning` is reported beside `sweeping` because an animation that is bound
but never runs is not motion — and a `NumberAnimation on x` runs by default, so a
`running:` binding somebody removed leaves the band travelling for ever under a
glyph that is not restoring. The two must agree. `sweepMs` is `Motion.sweepDuration`
and is deliberately **not** the state-change duration: a long looping hint that
something is happening is a different kind of thing from a transition between two
states, and a sweep sharing the toggles' number would strobe.

### The Live → Recorded morph

`morph` is one object and it is **always present** — `active`, `durationMs`,
`easing`, `runs`, `settled`, `pairs`, `liveOnly`, `recordedOnly`, `flights` —
with `pairs` empty when the
topology has nothing recorded. It is not a draw-time `null`: "these two maps
share no chip" is a fact the panel has, not a value it is waiting for. Each chip
also carries `morphRole` (`paired` / `live-only` / `recorded-only` / `""`),
which *is* delegate-reported and therefore `null` until the chip has drawn.

`pairs` is `PanelModel.mapMorphPairs`'s own answer, projected by
`PanelModel.morphPayload`. The panel pairs the two maps **once**, into
`root.morph`, and the fade, the per-chip `morphRole` and this key all read that
one object — the epic's own DoD is that the pair set in the payload is the only
evidence the right chips morphed, so a second pairing computed for the report
would be evidence of nothing (tick 3xi). Both ends of a pair are named by `key`
(`liveKey`, `recordedKey`) rather than by `linkKey` alone, because `linkKey` is
not unique: two unwatched windows of one class share `class:<cls>`. `geometry`
is the only thing said about rectangles — *could this pair be translated at
all* — and no rect is in the payload, because a chip's `rect` is the **window's**
fraction and not the rectangle the chip is drawn at.

`active` is the morph animation's own `running`, and `durationMs`/`easing` are
read off that same object, for the reason the chip's three motion fields are: a
number restated from `Motion.qml` would pass on a panel whose animation had been
deleted. It cannot latch — there is no store to latch, and switching back
mid-morph restarts the one animation rather than starting a second one.

**Do not assert on `active` after a `setView`.** A morph lasts 120 ms and an
`omarchy-shell dock-recall state` round trip does not reliably land inside it,
so that assertion is a race whichever way it comes out. `runs` and `settled` are
the same fact in a form a poll can catch: both are written by the animation's own
`started` and `finished` signals, so `runs` going up proves a morph began and
`settled` catching up proves it **ended** — which is the half of this tick that
matters, a flag that latches true proving nothing. A mid-flight reversal leaves
`runs` one ahead of `settled` for ever after; that is the truthful record that
one morph was abandoned rather than finished, not a defect.

**What actually moves, in three cases.** A view flip rebuilds the map, so no
chip object exists on both sides of the switch to translate — the morph is
therefore drawn *above* the map, by an overlay owning its own rectangles, and
`morphRole` alone does not say what happened to a chip:

| the pair | what happens | how to see it |
|---|---|---|
| `geometry: true`, both ends resolved | **translated** — one rectangle flies between the two drawn rects while the real chip at each end stands aside | it is in `morph.flights`, and its chips report `morphFlying` |
| `geometry: false` | does not move — a fallback workspace draws stacked and its rects mean nothing, and a PAIRED chip is held at full opacity on both maps, so it cuts rather than fading | `morphRole: "paired"`, absent from `flights` |
| one-sided | fades in from nothing | `morphRole: "live-only"` / `"recorded-only"` |

`flights` carries `from` and `to` in map-canvas pixels, resolved through
`PanelModel.morphDrawnChipRect` — which calls `chipRectsForCanvas` over the
workspace's **whole** slot list rather than scaling the chip's own fraction,
because the floor and the anti-superimposition barriers are decided between
neighbours. A tab group's members each get their own segment of the shared slot.
Two rectangles per flight is the strongest thing this venue can be told: it
cannot watch the chip cross, but it can check that both ends were real drawn
rectangles and that the pair they belong to is one the matcher returned.

One flight can be absent on the **first** switch into a view and present on every
later one: the destination map has never been laid out, so neither end resolves
until its delegates report their canvas geometry a frame or two later. The flight
joins in progress rather than starting from a stale origin, so poll rather than
assert on a single reading.

The honest limit stands: nothing here proves a pixel moved, and whether the morph
*reads* as a morph is the human's gate for this epic.

### The fields that are exact from the first tick

`key`, `monitorName`, `renderPath`, `placed`, `width` and `height`, because every
later assertion keys on them.

`key` must also be **unique**, which is not free: `instanceKeyFor` spells a
single-instance identity with its bare id, so two recorded entries of one
identity at the same occurrence — reachable, and deliberately left unrepaired by
the state reader — produce byte-identical keys, and a live chip falls back to its
`className` when the window has no address. Later ticks select chips *by* key, so
a collision would silently assert about one chip twice and about another never.
The test checks uniqueness on every payload.

`renderPath: "positioned"` is **not** on its own proof that anything was drawn.
Inside the positioned branch there is a second, silent branch: a chip whose slot
never resolved a rect draws a floor-sized marker at the canvas origin (`Panel.qml`
calls it visibly wrong), and a chip measured during warm-up is sized from a
zero-width canvas, where `chipRectsForCanvas` floors against `min(canvas, floor)`
and answers 1×1 — non-null, so the delegate's own warning never fires either.
`placed` separates the first case and `width`/`height` the second: a positioned
chip must report `placed: true` **and** clear the 16×10 floor. A 1-pixel chip
fails the gate. The same two numbers are what the treatment ladder is asked
about — its answer is `PanelModel.chipTreatment(width, height)` on the *drawn*
size, which no payload without them could be checked against.

`monitorName` is on chips **and** workspaces. The panel's workspace render
registry keys on the monitor because a stale recording can name one workspace id
under two monitors; the payload carries the same monitor so a consumer can
reproduce that disambiguation, and so this test's chip-versus-workspace
cross-check matches on monitor *and* id rather than on id alone.

That registry is also keyed by **view**. Both map models derive their monitor
boxes from the same `mapGeometry`, so without the discriminator the recorded
map's fallback answer for `eDP-1/7` would overwrite the live map's positioned
one. (Chips need no such namespace: recorded chip keys carry a `recorded-`
prefix and live ones are addresses.) The test flips to the recorded view and back
and re-asserts the whole live shape, which is where that overwrite would show.

**Why a query rather than a picture.** This venue cannot prove a pixel was
rasterized — there are no golden images, no Pillow on host or guest, and the
locked scenario measured the emulated framebuffer showing a normal desktop while
the session was genuinely locked. So the standard is bind-level: the panel
reports the values it *computed and bound*, and this test asserts on them the way
every other test here asserts. It cannot catch a purely rasterization-layer bug
(a theme override, zero opacity, a broken image codec). That is the accepted
limit of the venue, decided by a human at the start of the increment.

**Both render paths, in one panel session.** `Panel.qml` draws a workspace
either absolutely-positioned or as the stacked fallback, and the fallback branch
never calls `chipRectsForCanvas` at all — the learnings record it engaging
silently and hiding a broken model for two live rounds. The test reaches each
the way a user does:

| view | how it gets there | path |
|---|---|---|
| Live | real windows carry `at`/`size` | `positioned` |
| Recorded | the seeded layout has **no** `at`/`size`, the shape of a v1 recording | `fallback` |

and then requires, in each view, that every chip carries a non-empty key, a
*distinct* one, a monitor, one of the two paths and the geometry it drew with;
that a positioned chip really was placed and really has a size; that no chip
disagrees with its own workspace *on its own monitor* about which path drew it;
and that the two views do not report the same chip keys. `renderPath`, `placed`,
`width` and `height` are reported by the delegate that drew the chip, from the
same `positioned` flag and the same resolved rect its x, y, width and height
branch on — not derived a second time from the model, which could agree with the
model while the screen did something else.

**One read per view.** Each view's payload is fetched by the poll that validates
it, and the assertions and the pass lines below it use that same captured
payload. The panel's refresh timer runs throughout, so a second fetch is a second
answer: the headline used to be able to read `null chip(s)` on a line that still
said `ok -`.

**The seeded window is named.** The live map draws every mappable client whether
it is watched or not, and the recorded map hardcodes `watched: true`, so `watched`
alone asserts nothing — the test used to pass identically if the identity never
loaded. It now requires a live chip keyed by the seeded window's own `hyprctl`
address and reporting `watched: true`, and every wait in the file is a poll on
something observable (the service's own `state loaded: N identities, M layouts`
line for the two seeds).

Both payloads are copied into the artifacts directory as
`dock-recall-panel-state-live.json` and `-recorded.json`; the panel is dismissed
on the way out however the test ends, because its layer holds keyboard focus
exclusively and the tests after it want the desk back; and the state file the
test seeded is removed with it, so a watched identity for a window that no longer
exists and a layout with no geometry do not leak into the next test in the boot.

## What the motion test asserts

`dock-recall-motion-test.sh` is epic kw9's gate, and its DoD is deliberately
narrow: **that the motion is wired, not that it looks right.** Whether the morph
*reads* as a morph is the human's own `--awaiting` gate, not something any
assertion here stands in for.

Every claim in the file has one of three shapes.

**A duration that came off an animation object.** Every chip reports a non-zero
`fillMotionMs` and `edgeMotionMs`, the morph reports a non-zero `durationMs`, and
the bar reports a non-zero `glyphFadeMs` and `sweepMs`. None of those numbers is
compared to a literal from `Motion.qml` — they are compared **to each other**:
four animation objects across two QML entry points, read over two IPC targets,
have to report one duration. The equality is the assertion, and the non-zero
clause beside it is what a deleted `Behavior` fails (its report falls to 0, and
so would a comparison of 0 against 0).

**A counter the animation itself wrote.** `morph.runs` and `morph.settled` are
incremented by `morphFade`'s own `started` and `finished` handlers. Every view
switch in the test requires `runs` to go up **and** `settled` to catch up **and**
`active` to be false again — a morph began, it ended, and nothing latched.
`morph.active` is never asserted true: it is a 120 ms flag against an
`omarchy-shell` round trip, so that would be a race whichever way it came out.
The test fires a burst of reads straight after a switch and *prints* how many
caught it, as a `#` note, so the claim is a measurement in the log rather than an
assurance. Nothing has yet found a way to observe it up reliably.

**A set the pure function returned.** `morph.pairs`, `liveOnly` and
`recordedOnly` are `PanelModel.mapMorphPairs`'s own answer, and they are asserted
**by name at both ends** — the running window's own `hyprctl` address on the live
side, the recorded chip key on the other. A count over pairs cannot tell one chip
from another. Beside the named clauses sits a partition: the keys the map
actually **drew** sort-equal that side's pair ends plus its one-sided list, so a
matcher that quietly dropped a chip fails even when every named clause passes.

`morph.flights` is held to the pairs. Each flight has to name a pair the matcher
returned *and* one it marked `geometry: true`, and both of its rectangles have to
clear the same 16 × 10 chip floor a drawn chip does — a flight resolved against a
canvas that has not laid out yet is 1 × 1 and non-null, so nothing else complains.
The **direction** is checked from two payloads: `from` and `to` swap when the tab
flips back, and the two ends are required to be different rectangles, which is why
the seed records the app on a workspace it is not on.

**Both render paths**, and reached the way a user reaches them. The layout is
**recorded for real** through `dock-recall record`, so it carries the at/size the
plugin itself wrote and both maps draw positioned — the pair reports
`geometry: true` and it flies. The same layout is then rewritten **without**
at/size, which is the shape of a v1 recording, every recorded workspace drops to
the stacked path, the pair reports `geometry: false`, `flights` empties, and the
chips have to go on reporting their two fade durations there. That last is what
the section exists for: a rule calibrated on positioned chips can be wrong on the
fallback's fixed-height rows, and the fallback has hidden a broken model here
before.

Two ends of the matcher's answer cannot come out of a `record` — an app that is
not running, and a chip recorded somewhere it is not — so those are written onto
the recording afterwards through `StateModel`. Every *geometry* in the file is
still the plugin's own.

**The bar's sweep is driven, not merely read.** The widget renders the published
status file and nothing else, so the test writes a `restoring` status through the
plugin's own `StateModel` and requires `sweeping` **and** `sweepRunning` to go
true, then puts the file back and requires both to go false. What that proves is
the DoD's claim — the animation is bound to the state and runs when the state says
so. What it deliberately does not prove is that the *service* publishes
`restoring` at the right moment; that is a fact about a restore cycle and it is
earned in `dock-recall-roundtrip-test.sh`.

The payloads are copied into the artifacts directory as
`dock-recall-motion-state-live.json`, `-recorded.json`, `-live-back.json`,
`-fallback.json` and `dock-recall-motion-bar.json`. The panel is dismissed, both
windows are killed and the status file is restored on the way out however the
test ends.

## What the undock-while-locked scenario asserts

This is the one `tests/nested-notes.md` left open. Tick sug closed
DONE_WITH_CONCERNS: the undock focus failover's *detection* reads the right
thing and its *repair dispatch* works, but the repair branch has never fired,
because the state it targets — a lock surface holding keyboard focus on an
output that is disappearing — cannot be reproduced in a nested compositor. The
note names exactly what would close it: lock the session, remove the focused
output, and read the `[dock-recall]` log for one of

```
[dock-recall] monitor "<name>" removed; focus intact on "<other>"
```

or

```
[dock-recall] monitor "<name>" removed and took focus with it — failing over to "<other>"
[dock-recall] focus failover ok
```

Either is a real answer, and which one appears is a finding rather than a
verdict: the first says the compositor re-homed focus itself and the service
correctly did nothing, the second is the branch that has never run. What is *not*
an answer is neither line, or a session that cannot be unlocked afterwards.

### Why it is split in two

An in-guest test can lock (`omarchy-system-lock`, which routes to
`omarchy-shell lock lock` — the lock that lives inside the Quickshell process)
and can undock, and both keep working over SSH while the session is locked. What
it cannot do is **unlock**: a session lock takes keyboard input from the seat,
and the base image ships nothing that can type into it. The keyboard that can is
the emulated one, behind QMP, on the host.

**The screendumps are not the proof.** Measured 2026-09-02: this guest's
virtio-vga framebuffer goes on showing the desktop — bar, clock ticking — while
`omarchy-shell lock isLocked` says `true` and Hyprland reports a `LOCK` blocker.
A picture of that screen would look unlocked and would be wrong. So the lock is
established three other ways, and the third is the one that matters: the
decisive query, the compositor's own blocker, and a deliberately **wrong**
password that leaves the session locked before the right one releases it. That
control is what turns "a lock released" into "the emulated keyboard was read by
an authenticating password prompt". The screendumps are kept as run artifacts,
not as evidence.

So `dock-recall-undock-locked-prepare-test.sh` runs inside the suite and stops
where the session is: plugin live, one watched window on a fake dock, a layout
recorded, **nothing locked**. `run.sh` then passes `--keep-running` and drives
the rest from the host through `undock-locked.sh`:

1. park focus on the output that is about to vanish — undocking an *unfocused*
   monitor is the case `tests/nested-focus.sh` already covered, and can only
   ever produce the "focus intact" half of the answer;
2. lock, and prove it: `omarchy-shell lock isLocked` must answer `true` — the
   decisive query, the same one `Service.qml` uses, because `loginctl`'s
   `LockedHint` is blind to this lock — *and* Hyprland must report a `LOCK`
   blocker. If either is missing the run stops there and says so, rather than
   proceeding with a scenario that would be theatre;
3. remove the focused output while locked, and read the service's verdict
   verbatim out of its own log;
4. type a **wrong** password and assert the session stays locked, then the real
   one and assert it releases; then prove the session *acts* and not merely
   reports: `hl.dsp.focus` must answer `ok`;
5. scatter the window, redock, and assert the recorded layout comes back — the
   scatter for the same reason the round trip scatters.

QMP screendumps land in the harness's run directory as
`success-dock-recall-locked-01-locked.png`, `-02-post-undock`,
`-03-post-unlock` and `-04-post-redock`, with `failure-…` variants at whichever
step gave up. The `[dock-recall]` log is copied out beside them as
`dock-recall-undock-locked-service.log`.

The VM that `--keep-running` leaves behind is stopped by `run.sh`'s EXIT trap on
every path out — `vm-lib.sh` owns that, and is a library rather than a copy in
each caller precisely so the teardown cannot drift.

## Guest packages

The test installs `jq`, `foot` and `nodejs` in the guest if they are missing
(`pacman`, as the guest's own `omarchy` user with the harness's known password).
`node` is needed to record through the engine. This is a throwaway VM built from
the base image every run, so nothing accumulates.

## Sanitization

Everything in the guest is synthetic: the harness installs with user `omarchy`,
password `omarchy`, and the test's own window title is
`dock-recall-acceptance`. No host paths, host name or personal data cross into
the VM — `--sync-omarchy` copies only this directory and the plugin tree.
Screenshots are of that VM's desktop, not yours; they are deliberately **not**
committed, and stay under `test-runs/` on the host.
