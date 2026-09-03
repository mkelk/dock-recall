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
the current version would silently stop testing anything the day v5 lands. What
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
   test, not a re-implementation of it. The file that lands is v4, subject
   emptied, control verbatim.
3. **the file the user is left with** — the persisted v4 file is reloaded by the
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
```

```json
{
  "topologyName": "Laptop + Dell U2720Q",
  "showRecorded": false,
  "recordedAt": "2026-09-03T09:12:44.101Z",
  "workspaces": [
    { "id": 7, "name": "7", "badgeValue": null, "renderPath": "positioned" }
  ],
  "chips": [
    { "key": "0x5581f0a1", "name": "Alacritty", "workspaceId": 7,
      "iconSource": null, "iconResolved": null, "watched": true,
      "fillState": null, "treatment": null, "renderPath": "positioned" }
  ]
}
```

`null` is "no answer yet": the fields the rest of increment 06-bwf fills in
report null until the tick that computes them lands, and each is added to the
objects above rather than beside them. `key` and `renderPath` are exact from the
first tick, because every later assertion keys on them.

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

and then requires, in each view, that every chip carries a non-empty key and one
of the two paths, that no chip disagrees with its own workspace about which path
drew it, and that the two views do not report the same chip keys. `renderPath`
is reported by the delegate that drew the chip, from the same `positioned` flag
its x, y, width and height branch on — not derived a second time from the model,
which could agree with the model while the screen did something else.

Both payloads are copied into the artifacts directory as
`dock-recall-panel-state-live.json` and `-recorded.json`, and the panel is
dismissed on the way out however the test ends: its layer holds keyboard focus
exclusively, and the tests after it want the desk back.

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
