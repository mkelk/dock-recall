# Nested Hyprland sandbox — what was actually verified

Run: `tests/nested-focus.sh` (config: `tests/nested.lua`). Machine:
omarchy-host, Hyprland 0.56, Omarchy 4 "Quattro", 2026-08-15.

The service's undock focus failover (`Service.qml`, `checkFocusFailover` /
`evaluateFocusFailover`) only ever runs in the REAL session. The nested run
exists to prove the mechanism it relies on, on a compositor instance that can
be wedged without costing anyone their desktop.

## Verified

1. **A nested Hyprland is a usable sandbox for monitor surgery.**
   `Hyprland -c tests/nested.lua` starts as a window inside the running
   session; the new instance is the newest directory under
   `$XDG_RUNTIME_DIR/hypr`, and `HYPRLAND_INSTANCE_SIGNATURE=<that> hyprctl …`
   drives it in complete isolation. `output create headless` / `output remove`
   work there exactly as in the real session.

2. **`hl.dsp.focus({ monitor = "<name>" })` is accepted and moves focus.**
   Dispatch answers `ok`, and `hyprctl monitors -j` then reports
   `focused: true` on the named output. This is the exact dispatch the failover
   performs, and the key spelling (`monitor`, a bare output NAME rather than a
   direction) is now confirmed rather than inferred — first-party Omarchy only
   ever binds the relative forms `{ monitor = "+1" }` / `{ monitor = "l" }`.

3. **Removing the focused output does not, by itself, strip focus.**
   With `nested-b` focused (and a window on it), `hyprctl output remove
   nested-b` left Hyprland reporting `focused: WAYLAND-1` — the compositor
   re-homed focus onto a survivor on its own. The service's check
   ("does any live monitor claim focus?") therefore correctly does nothing in
   this scenario, which is the behaviour you want: no gratuitous focus jump on
   every undock.

## NOT verified — the concern

**The failover branch never fired**, because the nested sandbox would not
reproduce the focus-lost state. The undock-while-LOCKED freeze this failover
targets is precisely the case where the compositor's own re-homing is believed
to fail (the lock surface holds keyboard focus on an output that is
disappearing), and reproducing it needs a lock screen inside the nested
instance plus a way to observe input while locked — impractical here, and
explicitly out of scope for the tick.

So what is proven is: the DETECTION reads the right thing (`hyprctl monitors
-j`, `focused` flag, active outputs only) and the REPAIR dispatch works. What
is unproven is that the repair is reached in the real freeze, and that it is
sufficient to unfreeze a locked session.

**Tick sug is therefore DONE_WITH_CONCERNS.** Closing the gap needs Layer 5:
lock the real session, undock the physical AOC, and read the `[dock-recall]`
log afterwards for either

    [dock-recall] monitor "<name>" removed; focus intact on "<other>"

or

    [dock-recall] monitor "<name>" removed and took focus with it — failing over to "<other>"
    [dock-recall] focus failover ok

## Incidental finding, worth more than the test

A **hyprlang (`.conf`) config leaves the Lua dispatch layer unloaded**: in an
instance started with a plain `.conf`, every `hyprctl dispatch 'hl.dsp.…'`
answers `Invalid dispatcher`, while `hl.*` config-style dispatches work fine in
the Lua-configured real session. The first version of this sandbox used
`tests/nested.conf` and every dispatch failed for that reason alone — nothing
to do with monitors or focus. Any future nested test of Quattro dispatch verbs
must use a Lua config.

---

# 2026-09-02 — Tier B: the plugin itself, in an invisible nested Hyprland

Run: `tests/sandbox-dock.sh` (config: `tests/nested.lua`). Machine: the dev box,
Hyprland 0.56.2, Omarchy 4 "Quattro", Quickshell from `/usr/bin/qs`.

The 2026-08-15 run above proved the sandbox could host *monitor surgery*. This
one answers the question that mattered: can the PLUGIN run in there — service,
state file, dispatches and all — while the user keeps working, and without the
desktop showing a trace of it.

Yes. Every claim below was measured on this machine on the date given.

## The decision: a stripped `shell.qml`, not a second omarchy-shell

The spike question was "full omarchy-shell second instance, or a minimal qs
config that loads the plugin's entry points?". **Minimal config wins, decisively,
and it also gets Panel.qml** — which was the tie-breaker nobody expected.

The whole sandbox shell is:

    import Quickshell
    import "plugin" as Plugin

    ShellRoot {
      Plugin.Service {}
      Plugin.Panel {}
    }

A second omarchy-shell was never attempted past reading what it would cost: it
owns a bar, a lock surface, ~20 first-party services and the same state
directory the plugin writes, and the nested instance would have to be talked out
of all of it. The plugin's entry points are ordinary QML components. They load
on their own.

`shell` and `manifest` — the two properties omarchy-shell injects — are declared
`property var … : null` in both `Service.qml` and `Panel.qml`, and every read of
them is guarded. Nothing in the sandbox needed either.

## Four mechanics, each of which had to be found

1. **Quickshell blackholes imports that resolve outside the config folder.**
   `qs -p <worktree>/tests/sandbox` with `import "../.."` fails with
   `Module path "…" is outside of the config folder` → `Type Plugin.Service
   unavailable`. The fix is a **symlink inside the config folder**: the config
   root is a mktemp dir containing `plugin -> <worktree>`. Quickshell accepts it,
   and the gate reads the worktree's live files rather than a copy that drifts.

2. **`Panel.qml` loads too**, which node tests can never reach — findings A7–A10
   are QML-side bugs. It imports `qs.Commons` and `qs.Ui`; the `qs.` prefix is
   rooted at the config folder, so `Commons -> $OMARCHY_PATH/shell/Commons` and
   `Ui -> …/Ui` symlinked next to `plugin` resolve them. Loaded clean, no
   warnings, no errors.

3. **The state redirect is `HOME`, not `XDG_STATE_HOME`.** `Service.qml:48-52`
   builds its state dir as `Quickshell.env("HOME") + "/.local/state/omarchy"`.
   Setting only `XDG_STATE_HOME` would have written the user's real file. The
   sandbox launches qs under `env -i` with `HOME` in a mktemp dir (and the
   `XDG_*` vars alongside it so nothing falls back), which also gives the
   isolation footer something exact to assert: after a full run the live
   `~/.local/state/omarchy/dock-recall.json` is byte-identical.

4. **Env goes on the exec, and only there** (learnings § Plugin dev loop). Every
   compositor call the plugin makes is a `hyprctl` subprocess, so
   `HYPRLAND_INSTANCE_SIGNATURE` + `WAYLAND_DISPLAY` on the qs process is the
   entire steering mechanism — no plugin change, no test hook. The nested
   instance signature is the newest directory under `$XDG_RUNTIME_DIR/hypr`
   (as in 2026-08-15); the nested `WAYLAND_DISPLAY` is the `wayland-N` socket
   that appears in `$XDG_RUNTIME_DIR` alongside it.

## Invisibility, and the one thing that leaked

The nested compositor is launched **through the live one**, so the exec can
carry a window rule:

    hyprctl dispatch 'hl.dsp.exec_cmd([[ [workspace special:dr-sandbox silent] … ]])'

A special workspace is not shown unless something toggles it open, and `silent`
keeps the launch from taking focus. Measured during a run: the nested
compositor's window is a live client of class `aquamarine` sitting on
`special:dr-sandbox`, no monitor reports that workspace in `specialWorkspace`,
and `hyprctl activewindow` is the same address before and after. The exec
dispatch is the ONLY thing the run asks of the live instance — no output is
created there, no window is moved.

`hyprctl dispatch exec` reports no pid, so the dispatch runs a two-line wrapper
that writes `$$` and `exec`s Hyprland; that pid is what the trap kills.

**A window on a hidden workspace still gets no frame callbacks, and it did not
matter**: the nested compositor's IPC, its headless outputs and its window
mapping all run off its own event loop. Windows opened inside it map, move and
report normally while nothing is ever drawn.

**What did leak, once:** the cycle-completion toast. `notify-send` finds the
real session bus through `$XDG_RUNTIME_DIR/bus` even under `env -i`, and the
spike put *"Dock Recall — WAYLAND-1 + sbx-test — 1/1 arranged"* on the user's
screen (notification id 5, 18:44). The gate now puts a `notify-send` stub first
on `PATH`; it records the call and delivers nothing. Anything else that talks to
a session-bus daemon needs the same treatment.

`DR_TEST_LOCKED=false` is set for the same reason: `Service.qml`'s lock probe
shells out to `omarchy-shell lock isLocked`, which would be the sandbox's one
question to the live session. The override answers it in-process.

## The one behavioural difference from a real desk, and its fix

A bare nested Hyprland creates workspaces on demand. A used desktop has them
already, so `hl.dsp.workspace.move({ workspace = "9", monitor = "sbx-test" })`
— planned in the same iteration that launches the window — answered
`Workspace not found`, the service logged a `VERB-ERROR`, hit its no-progress
guard, and wrote a forensics dump. It still converged on settle pass 2 (the
workspace existed by then, because the launched window was on it), which is a
decent unplanned proof that the convergence loop does its job. But it is
sandbox-only noise.

The gate now pre-creates workspaces 1–10 in the nested instance:

    hyprctl eval 'hl.workspace_rule({ workspace = "9", persistent = true })'

`hyprctl keyword` is rejected by the Lua parser (learnings), `hl.workspace` does
not exist, and `hl.workspace_rule` is the spelling Omarchy itself writes into
`~/.local/state/omarchy/workspace-layouts/*.lua`. With the workspaces present,
the same run converges on pass 1 with no VERB-ERROR and no forensics dump.

## Where the evidence is

Not `qs log`. A manually exec'd Quickshell writes to
`$XDG_RUNTIME_DIR/quickshell/by-id/<id>/log.qslog`, whose id is not known until
it starts — so the gate simply redirects the process's stderr to
`$SBOX/qs.log`, which carries every `[dock-recall]` line (colour-escaped;
strip with `sed 's/\x1b\[[0-9;]*m//g'`). The sandbox directory is deleted on a
clean pass and **kept, with its path printed, on any failure**; `DR_SANDBOX_KEEP=1`
keeps it either way.

## What this retires

`tests/sim-dock.sh`'s shared-singleton constraint. The Tier B gate runs from any
worktree, in parallel, while the user works. The live gate stays for what only a
real session can answer, and needs the human's go-ahead.

## The case set the gate actually runs

Three, sim-dock's own, unchanged in substance:

1. **LAUNCH** — `output create headless sbx-test` in the nested instance; the
   service launches `foot --app-id=dr-sim` onto ws 9 on that output. The foot
   window opens *inside* the nested compositor, because the launch goes out
   through the sandbox plugin's own dispatch.
2. **SCATTER** — the window is dispatched to ws 1 on the nested instance's other
   output, the trigger file is touched, and it has to come back.
3. **IDEMPOTENCY** — one more trigger: `converged, 0 ops` must go up and
   `pass N iteration M` must not move at all.

Each case waits on the log's `restore cycle done` marker before the next begins,
so no case is ever scored against a queued rerun of its predecessor. Nothing
sleeps-then-asserts. A whole run is about a minute.

Two runs back to back, both `ALL PASS`, exit 0, no orphan Hyprland or Quickshell
process and no leftover sandbox directory. The trap was exercised on a forced
mid-run failure as well: both children died, the dead instance's socket
directory was removed, the exit status was preserved, and the sandbox directory
was kept with its path printed.

---

# 2026-09-02 — Layer 5: undock while genuinely LOCKED, in a VM

Run: `tests/acceptance/run.sh` (host half: `tests/acceptance/undock-locked.sh`,
in-guest setup: `dock-recall-undock-locked-prepare-test.sh`). Guest: Omarchy
4.0.1 from the ISO, Hyprland 0.56, headless QEMU driven over QMP.

This closes the gap the 2026-08-15 section left open. It names the two lines to
look for; the run produced the **first** of them:

    [dock-recall] monitor "dr-lock-dock" removed; focus intact on "Virtual-1"

Focus was parked on `dr-lock-dock` before the lock (`focused: true` on it in the
probe below), the session was locked, and that output was then removed. Hyprland
re-homed focus onto the survivor by itself, exactly as it did unlocked in the
nested run — so the service's check correctly did nothing, and the restore cycle
that followed reported `0 ops`.

**So the repair branch STILL has not fired, and now we know more about why.** It
is not that the nested sandbox was too weak: on Hyprland 0.56 the compositor
re-homes focus on the removal of a focused output *even while an
ext-session-lock is up*. The freeze the failover was written against does not
reproduce on this version. What is now proven is the whole detection path under a
real lock, and that the repair is not needed here; what remains unproven is the
repair dispatch in a real freeze, and there is no longer an obvious way to
produce one.

## The lock was real — and the screen is not how you know

The QMP screendump of the guest's virtio-vga head goes on showing the **desktop**
while the session is locked: bar drawn, clock ticking, the first-run dialog still
on screen. A picture of that frame looks unlocked and would be wrong. Nor does
`hyprctl layers` help — the Quattro lock is an `ext-session-lock` surface, not a
layer, so it appears in no namespace list. Probed while locked:

    --- omarchy-shell lock isLocked ---   true
    --- omarchy-hyprland-session-locked --- exit=0
    --- monitors: solitaryBlockedBy ---
    [{"name":"Virtual-1","focused":false,"solitaryBlockedBy":["LOCK","WINDOWED","CANDIDATE"]},
     {"name":"dr-lock-dock","focused":true,"solitaryBlockedBy":["LOCK","WINDOWED","CANDIDATE"]}]
    --- layer namespaces ---
    ["omarchy-background","omarchy-bar","omarchy-notifications"]

`LOCK` on every monitor is the compositor saying it holds a session lock. The
decisive check, though, is the **wrong-password control**: typing
`definitelynotthepassword` over QMP left `isLocked` at `true`, and the real
password then released it. That is what turns "a lock released" into "an
authenticating password prompt read the emulated keyboard" — and it is the only
one of these signals that could not be produced by anything else.

**Rule for future runs:** never treat a VM screendump as evidence that a session
is locked. Use `omarchy-shell lock isLocked` plus the `LOCK` blocker, and prove
the input path with a wrong password before the right one.

---

# 2026-09-04 — Can we photograph a window we cannot see? (tick o2x)

The Recorded map wants a picture of each watched window, taken when the user
presses Record and shown later with the app closed. The whole feature stands on
one question, so it was asked first and alone, in the nested sandbox.

**R1 — can a window that no monitor is showing be captured? YES.**
**R2 — does the hosted `grabToImage` pattern work? YES.**

Both measured with `tests/sandbox-lib.sh` (nested Hyprland 0.56.2, quickshell
0.3.1). Nothing ran against the live session; the isolation footer passed on
every run.

## The stage, and how "not visible" was established

Three independent facts, all recorded before a single capture was taken:

1. **The window's workspace belongs to a monitor that IS rendering.** A headless
   output (`hyprctl output create headless dr-cap`) was created inside the nested
   compositor and BOTH workspaces moved onto it with
   `hl.dsp.workspace.move({ workspace = "N", monitor = "dr-cap" })` — hidden one
   first, so the shown one ends up active. `hyprctl workspaces -j` then reports
   ws 2 and ws 11 both on `dr-cap`.
2. **No monitor is showing that workspace.** `hyprctl monitors -j` reports
   active workspaces `[1, 11]`; the targets sit on ws 2, and no special
   workspace is open.
3. **A screen scrape does not contain them.** `grim -o dr-cap` — the whole of
   what is on screen — comes back green and yellow, the two visible windows.
   Neither the red nor the blue window is anywhere in it.

Each window is a `foot` with a solid background (`-o colors.background=ff0000`),
so "is this really that window's picture?" is answerable by one pixel rather than
by eye.

## The result

Four windows, two hidden and two visible, captured in one interleaved queue:

    hidden  ff0000 -> 952x1070, 99.9959% red
    hidden  0000ff -> 952x1070, 99.9786% blue
    visible 00ff00 -> 952x1070, 99.9935% green
    visible ffff00 -> 952x1070, 99.9935% yellow

The red capture is 2,043,026 of 2,043,700 pixels pure `#FF0000` — it is that
window, not a blank frame and not the screen. Repeated across three runs with the
hidden window first, second and third in the queue, so its position cannot
explain the outcome.

## The one case where capture does NOT work

**A window on a monitor that is not rendering at all never delivers a frame.**
In the sandbox that monitor is `WAYLAND-1`, the nested compositor's own surface,
parked on a hidden special workspace of the live session and therefore never
given a frame callback. Two independent symptoms:

- `grim -o WAYLAND-1` **blocks forever** (hence the `timeout 8` around it).
- `ScreencopyView.hasContent` never flips, and the capture times out.

The first attempt at R1 put the hidden window there and got a NO that meant
nothing about the product. On a real desk the equivalent is a monitor that is off
or asleep. **Every capture needs a timeout as well as a callback**, and a "no
frame" answer must be reported as such rather than treated as an empty picture.

## What the capture tick has to know

- **`HyprlandToplevel.address` has no `0x` prefix.** The model returns
  `"562be03ac9a0"` where `hyprctl clients` says `"0x562be03ac9a0"`. Normalizing
  is load-bearing, not tidiness — that is `PanelModel.normalizedAddress`.
- **The model fills in asynchronously, in two stages.** For roughly the first
  second `Hyprland.toplevels` is empty; `refreshToplevels()` posts a request and
  returns, so reading `.values` in the same tick reads nothing. Poll
  `ToplevelBridge.ready(addresses)`; never sleep, never read once.
- **Do not call `captureFrame()` in the tick that creates the view.** With
  `live: false`, assigning `captureSource` already starts one capture, and the
  extra call answers *"Cannot capture frame, as no recording context is ready"*.
  The four-window run does not call it at all and captures everything.
- **`hyprctl clients` geometry and the captured size can disagree.** After the
  workspace moved to `dr-cap`, `hyprctl` still reported the hidden windows as
  700x801 while their captures came back 952x1070 — the tile size on the new
  monitor. Size the picture from `ScreencopyView.sourceSize`, not from the
  recorded window box.
- **The host window may be 1x1.** Every run above used a 1x1 background layer
  surface (`WlrLayershell.layer: WlrLayer.Background`,
  `exclusionMode: ExclusionMode.Ignore`, `focusable: false`) with the
  `ScreencopyView` sized to the source and overflowing it. `grabToImage` still
  returns the full 952x1070 image, so the hosting window need not be anywhere
  near the size of what it captures — but it does have to exist and be rendering.

## The sequencing pattern for N windows

One in flight, a fresh view each time, a deadline on every step:

    next():
      destroy the previous view; stop the guard timer
      if the queue is empty -> done
      view = ScreencopyView.createObject(stage, { captureSource: handle })
      start the guard timer            // hasContent may never arrive

    view.onHasContentChanged:          // first async hop: Wayland round-trip
      if (!hasContent) return
      view.grabToImage(function (result) {      // second: render-thread job
        result.saveToFile(path)
        Qt.callLater(next)             // callLater, not a direct call — the
      }, Qt.size(sourceSize.width, sourceSize.height))
                                       // grab callback runs off the render sync

    guard.onTriggered:                 // the monitor is not rendering
      record "no frame"; next()

A **fresh view per window** is not fussiness: reuse a single view and
`hasContent` is already `true` from the previous window, so the handler either
never fires or fires on the old buffer. Creating N views at once opens N capture
sessions on the compositor simultaneously.

## Where the evidence is

`.devmeta/increments/increment-06-bwf/evidence/o2x/` in the dev repository — the
four capture PNGs, the `grim` screen scrape they are absent from, the
`hyprctl monitors`/`workspaces`/`clients` dumps taken while they were hidden, and
the full sandbox run log. The probe itself was a throwaway; only the bridge it
exercised is in this repository.

---

# 2026-09-04 — Does the bridge tell the truth about TIME? (tick w25)

Every capture tick in this epic stands on `ToplevelBridge`, and a foundation
review found it dishonest in exactly the place nothing could test: it treated
"not in the toplevel model" as permanent, when for the first second of every
shell's life it means "not there **yet**". This run measured the repaired
bridge against a real, asynchronously-filling model.

Harness: a throwaway probe over `tests/sandbox-lib.sh` — nested Hyprland 0.56.2,
a **second** Quickshell hosting the worktree's `ToplevelBridge.qml` (a fresh
process, so its own toplevel model starts empty and fills, which is the whole
point). Two `foot` windows opened in the nested instance first. Nothing ran
against the live session; the isolation footer passed. `ALL PASS`, 13 checks.

## The first tick, which is where the old code lied

At `Component.onCompleted` the model is empty. Two windows that are open,
mapped and listed by `hyprctl` right then:

    PROBE t0-live  handles=0 pending=2 gone=0 asked=2 settled=false decided=false
                   refusal='Cannot picture 2 not ready to capture yet.'

`pending`, not `gone`; `decided=false`, so a consumer polls instead of giving
up. The old code put both in `missing` and the header told callers `missing` was
not worth retrying — so an honest consumer refused to capture anything, forever.

An address that really is closed looks identical at this moment, and is treated
identically (`t0-ghost`: `pending=1 gone=0`). It has to be: nothing can tell
them apart yet. What separates them is the settle.

## The settle, and the flip

The bridge's judgement is a **latch** (the model has been non-empty at least
once) **and quiescence** (it has held still for `settleMs`, 1200 ms). Measured
timeline, 100 ms samples:

    t=0                model empty     settled=false  readyGhost=false
    t=109  entries=2   filled          settled=false  readyGhost=false
    t=1310 entries=2   held still      settled=true   readyGhost=TRUE
    PROBE wait-ghost   gone=1 decided=true ok=false waitedMs=1327
                       refusal='Cannot picture 1 no longer open.'

So a closed window is `false` for 1.3 s and then `true` — **not false forever**,
which is what `ready()` used to be for exactly this case while the file's own
header instructed consumers to poll it. The live windows resolved through the
same wait in 127 ms (`wait-live handles=2 ok=true`).

## A window closed AFTER the model settled

The mirror case, and the one that proves quiescence rather than a one-shot
latch. Window B was killed once `settled=true`:

    readyB   over the run:  true -> false -> true
    okB      over the run:  true -> false
    entries  over the run:  2 -> 1
    PROBE wait-closed  gone=1 decided=true ok=false waitedMs=600

The model MOVED, so the settle clock restarted and B went back to `pending`
before it was ever called `gone`. A one-shot "has the model ever filled?" latch
would have condemned it instantly — which is the same bug as the startup one,
just later. This is also the case that shows `decided` and `ok` are different
questions: after the flip `ready()` is true and `allResolved()` is false.

## The deadline, on a wait that can never end by itself

A second bridge instance with `settleMs: 999999` — a model that never settles,
so a pending answer stays pending — and `deadlineMs: 800`:

    PROBE wait-deadline  timedOut=true waitedMs=846 pending=1
                         refusal='Cannot picture 1 still not ready to capture after 846ms.'

`resolveWhenReady` is the bounded wait, built once on the bridge so this epic's
several capture ticks do not each invent one. It matters beyond startup: a
window on a monitor that is not rendering resolves its handle **perfectly** and
then never delivers a frame (tick o2x), so the timeout is the only thing that
ends that capture.

## The QVariant guard, measured rather than assumed

Handing `resolve()` the toplevel model's own `values` — the exact shape a QML
caller reaches for — is refused out loud, before and after the model fills:

    refusal='Cannot picture anything: the address list arrived as a QML sequence
             rather than a JavaScript array. Copy it out element by element
             before it crosses into PanelModel.'

Confirms the learnings-file claim on the argument side: a V4Sequence is still
not an `Array` to `Object.prototype` in quickshell 0.3.1, and without the guard
the whole batch returned an empty plan with an empty refusal — "nothing to do,
everything fine" over windows nobody photographed.

## Also pinned, at every sample

`ready([])` is `true` (nothing was asked, so nothing can change; `asked=0` and
`ok=true` distinguish it from a successful capture) and `ready(["junk"])` is
`true` (permanent, and `ok=false`). Both are derived: `pending` is the only
retryable bucket, so `pending` is the only bucket that gates the predicate.

The probe was a throwaway, as in o2x; only the bridge it exercised is in this
repository, and every decidable part of it now has a node test.

---

# 2026-09-04 — The sandbox refuses to start unparked (tick n1s)

Run: `tests/sandbox-nested-guard.sh` over `tests/sandbox-lib.sh`. Machine: the
dev box, Hyprland 0.56.2, Omarchy 4 "Quattro". Nothing ran against the live
session; the isolation footer passed. `ALL PASS`.

## The hole

`sandbox_up` parks the nested compositor behind
`hl.dsp.exec_cmd([[ [workspace special:dr-sandbox silent] … ]])` and then
VERIFIES the parking (`sandbox-lib.sh`: the window is on `$SPECIAL_WS`, no
monitor is showing it). That check is good and is untouched. But it only runs
if you go through `sandbox_up`. A direct `Hyprland -c tests/nested.lua` skips
the prefix, skips the check, and opens an ordinary window on the user's desktop
mid-session. It happened twice; the human stopped the run both times.

`tests/nested.lua` could not fix this by carrying a parking rule — it
configures the INNER compositor, and the window belongs to the outer one. So it
refuses to configure at all instead.

## The guard

The launch wrapper exports `DR_NESTED_SANDBOX_PID="$$"` and then `exec`s
Hyprland, so the value IS the compositor's pid. `nested.lua` reads its own pid
from `/proc/self/stat` and calls `os.exit(1)` unless the two match.

**A pid, not a flag.** Everything the sandbox launches inherits the wrapper's
environment, so a bare flag would be a skeleton key handed to every process in
the nested world — including a probe that then ran `Hyprland -c` from in there.
A pid cannot be inherited into being true: one fork and the marker is false.

**`os.exit`, not `error()`.** A Lua error trips Hyprland's emergency mode
("A lua config error resulted in no binds being registered"), which starts a
compositor anyway — the exact outcome the guard exists to prevent. `os` and
`io` are both open in Hyprland's Lua (Omarchy's own config uses `os.getenv` and
`io.popen`), and the exit lands during config parse, before a backend exists.
A `kill -9` on our own pid is the fallback if a future build removes `os.exit`.

## Proving it without putting a window on the desk

The failure case is *attempting* the thing that caused the incident. So the
attempt goes out through the **same parked dispatch** with the marker withheld
(`sandbox_probe_unmarked_start`): if the guard is ever broken, the compositor
it wrongly starts is parked and silent like the legitimate one, and the failure
is reported rather than displayed. **A bare `Hyprland -c` is never run to prove
a guard against bare `Hyprland -c`.**

`sandbox_up` is the control arm — same wrapper, same config, same dispatch,
marker present — and a compositor came up. Measured, one run:

    control: the MARKED start produced a working compositor (…_1788551611_… answers hyprctl)
    control: the guard let the legitimate path through without a word
    park guard: the unmarked start ended by itself — nothing is left running
    park guard: it opened no Hyprland IPC socket — the abort landed before a compositor existed
    park guard: it said why, in its own log
      nested.lua: REFUSING TO CONFIGURE — no DR_NESTED_SANDBOX_PID in the
      environment, so this start did not come through the parked launch path

## Correction: `disable_logo` was never the red banner

`.tick/learnings.md` blames `nested.lua`'s `misc.disable_logo` for a red
*"Your config has errors"* overlay on every nested start. **It does not
produce one.** Measured both ways in the sandbox, with the key in and out:

    hyprctl configerrors  ->  blank (two newlines), both times

and no "Your config has errors" anywhere in `hyprland.log` or on stdout. The
LUA config manager IGNORES an unknown table key silently; only the hyprlang
parser errors on one. `misc:disable_logo` is genuinely not a key 0.56.2 has
(`misc:disable_hyprland_logo` is the real spelling and is still set), so the
line was dead weight and is gone — but the banner has another cause, still
unidentified.

Two more things worth knowing, both of which broke a first draft of this check:

- Hyprland's config diagnostics go to `$XDG_RUNTIME_DIR/hypr/<sig>/hyprland.log`,
  **not** to the stdout the launch wrapper captures. A grep over
  `$SBOX/nested-hyprland.log` for "config error" passes whatever the config says.
- `hyprctl configerrors` answers **blank** on a clean instance, not the string
  `"no errors"` its own `--help` line suggests.

---

# 2026-09-04 — Why the two test windows would not change shape (tick z65)

Run: a throwaway probe over `tests/sandbox-lib.sh` (nested Hyprland 0.56.2,
Lua-configured exactly as an Omarchy Quattro guest is). Nothing ran against the
live session; the isolation footer passed on every run. The subject is
`tests/acceptance/dock-recall-captures-test.sh`'s `shape_window()`, which floats
the two test windows at aspect ratios five times apart so the stored JPEG's
proportions can say WHICH window was photographed.

In the VM both windows came back `621x368` — identical, the tiled size — and the
test's precondition correctly refused to prove anything.

## The cause, and it is sharper than "unknown dispatcher"

The three plain dispatchers `shape_window` sent are not merely unrecognised.
A Lua-configured Hyprland hands `hyprctl dispatch <anything>` to the LUA parser
as `hl.dispatch(<anything>)`, and the legacy argument syntax is not Lua, so all
three are **parse errors**:

    setfloating address:0x… ->
      error: [string "return hl.dispatch(setfloating address:0x..."]:1:
             ')' expected near 'address'
       → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax
               might need to be updated.

    resizewindowpixel exact 900 340,address:0x…  -> same, near 'exact'
    movewindowpixel   exact 20 20,address:0x…    -> same, near 'exact'

The window is untouched: a tiled `foot` read `1406x840 at 5,5 floating=false`
before all three and `1406x840 at 5,5 floating=false` after. **`hyprctl` exits
0 regardless**, and `shape_window` threw the messages away with
`>/dev/null 2>&1` — so the only symptom that ever reached anyone was two
identical tiled sizes, five minutes into a VM boot.

## The working form

The one `engine.js`'s own restore executor emits (`opToCommand`, ticks 8t4/y29)
and the one every other script in `tests/acceptance/` already uses:

    hl.dsp.window.float({ window = "address:0x…", action = "toggle" })
    hl.dsp.window.resize({ window = "address:0x…", x = <w>, y = <h> })
    hl.dsp.window.move({   window = "address:0x…", x = <x>, y = <y> })

Resize BEFORE move (a resize keeps the centre fixed and therefore moves `at`),
and the float is sent only when a fresh read disagrees, because `action` is
ignored on 0.56 and every spelling toggles.

Measured, two tiled 700x840 `foot` windows on a 1416x850 nested output:

    float -> ok, resize -> ok, move -> ok   (all six dispatches)
    pictured  900x340 at 20,20   floating=true
    withheld  340x700 at 20,400  floating=true
    aspect 2.647 vs 0.486 — 81.7% apart, against the test's 40% floor

Both landed on the window they NAMED. That is not a formality: an unrecognised
selector key acts silently on the ACTIVE window (`.tick/learnings.md`), so "one
window carries the other's numbers" is a live failure mode, and it is what the
`900x340 != 340x700` check in the probe was there to catch.

## One jq trap on the way

`.floating // empty` collapses a TILED window and a window that does not exist
into the same empty string, because jq's `//` treats a literal `false` as
absent. Both cases happen to want the same thing here, so it worked by accident;
`// false` says what is meant.

---

# 2026-09-04 — Where the capture round went silent (tick 070)

Run: a throwaway probe over `tests/sandbox-lib.sh` (nested Hyprland 0.56.2,
Lua-configured, quickshell 0.3.1). Nothing ran against the live session; the
isolation footer passed on every run. The subject is the acceptance VM's
`not ok - Record stored one picture (captures)`: the layout was written, the
round logged `dropped the pictures for this layout (re-recorded)` and then said
nothing at all, and the cache stayed empty.

## The stage the probe rebuilt

The captures acceptance test's, inside the nested compositor: two `foot` windows
told apart by `--title=`, floated at aspect ratios five times apart (tick z65),
two seeded identities of which one is `pictured`, a `headless` output for the
windows to live on, and a Record driven through the panel's own
`dock-recall record` IPC. `sandbox_up`'s generated `shell.qml` was replaced with
one that gives the panel an id and adds a probe-only `IpcHandler` whose verb
calls `dockPanel.open("{}")` — there is no `omarchy-shell` in the sandbox to
summon it, and Record is a panel act.

It reproduced first time: `record` answered `recorded`, and the cache held
nothing 60 s later.

## The stall, and it is not where the chain reads as if it were

`capture()` → `mkdir` → `evict` → `job.then` → `_runEvictThen` → `_resolveThenWalk`
is intact, and instrumentation walked all of it:

    CAPDBG _resolveThenWalk: addresses=["0x557bcc230660"]
    CAPDBG _resolveThenWalk: total armed at 45000ms, running=true
    CAPDBG bridge callback: ok=true handles=1 timedOut=false waitedMs=0
    CAPDBG _next: creating view for 0x557bcc230660 host=true screen=sbx-cap
    CAPDBG _next: queue=1 current=view      <- 6 s later, and again, and again…

The queue never moved. The per-window guard fired every `stepMs`, took its
"not the step in flight" branch, and called `_next()` — which destroys the view
and builds another one **for the same queue head**. Seven times, then the
whole-queue deadline ended the round at 45 s.

**`_isCurrentEntry(entry)` could never be true.** The decisive sample:

    entry={"address":"0x557bcc230660","file":"432df7d1-…-0.jpg",
           "identityId":"dr-pictured","occurrence":0}
    head ={"identityId":"dr-pictured","occurrence":0,
           "address":"0x557bcc230660","file":"432df7d1-…-0.jpg"}
    entry===head false   head===head2 true   entry.address===head.address true

`Component.createObject(parent, { entry: entry })` passes its property map
through a QVariantMap, so the queue entry arrives in the view's `property var`
as a **deep copy** — the key order alone gives it away, a QVariantMap sorts them.
Reading `store._queue[0]` twice DOES give one object (`head===head2 true`), so it
is the view's property that is the boundary and nothing else.

Every path that answered for a step was handed that copy: the grab callback
returned before saving, `_settle` returned before recording, the guard respawned.
**A round in that state writes nothing and logs nothing** — which is exactly what
the VM showed, because the test polls 40 s and the store's `totalMs` is 45 s, so
the run failed and dumped its diagnostics five seconds before the store would
have said a word.

The repair is that a step's identity is an `int` the boundary cannot copy into
something else, plus a loud shared abandon so the guard's impossible state can
never be a silent loop again.

## The rule this is an instance of

**Never compare JS object identity across a QML property boundary.** A `var`
property assigned from JS in the same object keeps its reference; one populated
through `createObject`'s property map, or through any QVariant conversion, does
not. If two sides must agree on "the same thing", agree on a number.

## What this sandbox could NOT prove, and how that was established

**`hasContent` never arrives here**, so no JPEG was written in any run and the
fixed round reports `no-frame` rather than a picture. That is not the panel
sitting over the capture host: a second, bare `CaptureStore` with its own 1x1
host was driven directly, with the panel CLOSED and then OPEN, and both answered
`no-frame`. And the output IS rendering — `grim -o sbx-cap` came back with a
46 KB PNG in the same run. So the frame path is a limitation of this stage
(tick o2x captured on a nested headless output by moving BOTH workspaces onto it,
which this probe did not do), not of the round.

**The picture itself is the VM's to prove.** What the sandbox settles is that the
round now recognises its own answers, advances its queue, and reports:

    0 picture(s) stored, 1 could not be captured (no-frame), 1 not pictured

within one step budget, where before it said nothing for 45 s and then
`timed-out`.

---

# 2026-11-14 — Omarchy 4.5's per-monitor workspaces, measured nested (tick zf6)

Run: `tests/sandbox-45-probe.sh` over `tests/sandbox-lib.sh`, three runs with
identical answers. Machine: the dev box, Hyprland 0.56.2, the 4.5
`default/hypr/monitor-workspaces.lua`. Nothing ran against the live session;
the isolation footer passed, including the new check that the desk's own
`monitor-workspaces` and `monitor-workspaces-merged` kept their mtimes.
`ALL PASS`.

## The sandbox now runs the real module

`tests/nested.lua` loads `default/hypr/monitor-workspaces.lua` after the park
guard, with the smallest shim Omarchy's bootstrap would otherwise supply:
`$OMARCHY_PATH/?.lua` on `package.path` (not the user's `~/.config` entries) and
a global `o` with `shell_quote` and `bind_expressions`. It drops cached
`default.hypr.*` modules first, as `bootstrap.lua` does, because Hyprland keeps
one Lua state across `hyprctl reload` — without that a reload skips the module
body. It refuses to load unless `XDG_STATE_HOME` is a `dr-sandbox.*` state home:
the module writes its block table there, and a nested table written over the
desk's would renumber the human's bar.

The persistent workspace rules 1..10 that `sandbox_up` used to add are gone.
They made ten workspaces on the first monitor — exactly what the module's
reconciles fight — and the module's own `hyprland.start` reconcile is what a
4.5 desk starts from. `tests/sandbox-dock.sh` leaned on them (a `workspace.move`
to a not-yet-existing ws 9) and may fail until it is ported.

The stage: the nested `WAYLAND-1` output owns block 0 (1..10), a headless
`sbx-b1` block 1 (11..20). The sandboxed plugin service ran alongside with no
seeded layout and made 0 ops throughout.

## The answers

**(a) A move to a workspace that does not exist yet creates it on the FOCUSED
monitor** — not the window's, and not the monitor whose block the id belongs
to. `window.move({ workspace = "13", follow = false, window = "address:…" })`
on a block-0 window put ws 13 on `WAYLAND-1` with the focus there, and on
`sbx-b1` with the focus on `sbx-b1`. Left on the block-0 monitor, the next
reconcile (a config reload) does not send 13 to its owner: `place()` ADOPTS it
into the monitor it is on, keeping the slot, so the window ended on **ws 3 of
`WAYLAND-1`**. A misplaced new workspace is renumbered, not repaired.

**(b) `window.move({ monitor = NAME })` then a move to 13 lands on the block-1
monitor only because the first move TAKES THE FOCUS.** The default follows:
after it the nested focus was on `sbx-b1` (and, once the window moved on to the
hidden ws 13, on no window at all). With `follow = false` on the monitor move
the focus stays put — and ws 13 is then created on the focused block-0 monitor
again. So that pair does not do the job without stealing focus.

There is **no single-dispatch form**: `window.move({ workspace = "13",
monitor = "sbx-b1", … })` ignores `monitor` and creates 13 on the focused
monitor. Two forms DO land the window on ws 13 of `sbx-b1` with the focus
unchanged, each sent as one `hyprctl eval`:

    hl.dispatch(hl.dsp.window.move({ workspace = "13", follow = false, window = "address:…" }))
    hl.dispatch(hl.dsp.workspace.move({ workspace = "13", monitor = "sbx-b1" }))

    hl.workspace_rule({ workspace = "13", monitor = "sbx-b1" })
    hl.dispatch(hl.dsp.window.move({ workspace = "13", follow = false, window = "address:…" }))

The first is two dispatches with ws 13 briefly on the wrong monitor (no
reconcile runs in between — only monitor events and reloads trigger one). The
second leaves a workspace rule behind until the next config reload.

**(c) Yes — a window on ws 901 is renumbered by a reconcile.** It sat on 901
untouched until `hyprctl reload`; the `config.reloaded` reconcile's `merge()`
then treated 901 (block 90, owned by no monitor) as a guest and moved it to
**ws 2**, the slot after block 0's highest. No merged record was written: block
90 has no identity to remember. Without a reload or a monitor event, 901 stays.

**(d) The module settles synchronously with the hyprctl call.** Measured from
just before the call, polling the block file, the merged file and the workspace
set every ~50 ms until 3 s pass without a change:

| event | hyprctl returned | last change |
|---|---|---|
| `output create` (new monitor, block 2) | 9-10 ms | 11-12 ms |
| `output remove` (one window on its ws 21) | 5-7 ms | 7-8 ms |
| `output create` again (merged restore) | 10 ms | 12 ms |

The removal reconcile sits behind `hl.timer({ timeout = 1 })`, which is
evidently milliseconds — it had run before the first poll. On removal ws 21
merged into block 0 as ws 3 (`3⇥21⇥sbx-b2` in the merged file, ⇥ = tab); re-creating the
output returned it to ws 21 on `sbx-b2` and emptied the merged file. These are
headless outputs in a nested compositor; a real DRM hotplug adds its own
latency before Hyprland reports the monitor, which this does not measure.

**(e) Yes — a headless output's identity is its connector name.** `sbx-b1`
reports an empty description, and its block-table row is
`1⇥sbx-b1⇥sbx-b1`. So is the nested `WAYLAND-1` output's
(`0⇥WAYLAND-1⇥WAYLAND-1`).

## What the engine tick should take from this

- Moving a window to a not-yet-existing workspace of another monitor's block
  needs either the window-then-workspace pair or a workspace rule; a plain
  `window.move` puts the new workspace wherever focus is, and the next
  reconcile renumbers it into that monitor's block.
- A scratch workspace at 901+ is safe only between reconciles: any monitor
  event or config reload moves its windows into a real block.

# 2026-11-14 — 9i2 fidelity facts (tick ejc)

Run: `tests/sandbox-fidelity-probe.sh` over `tests/sandbox-lib.sh`, Hyprland
0.56.2, nested `WAYLAND-1` at 701x850 (gaps_in 2, gaps_out 4, border 1).
`tests/nested.lua` does not set Omarchy's split settings yet, so the probe set
them with `nested eval` (`force_split = 2`, `preserve_split = true`, read back
as 2/1). The sandboxed plugin service ran with no seeded layout and made no
ops. Isolation footer `ALL PASS`. Two full runs; the first was cut short in (f)
by an edit to the script while it ran, and every answer it got to matched the
second run to the pixel.

The ground truth for "which tab is active" is the compositor's own:
`hyprctl eval` writes Lua's `window.group.current` / `current_index`
(typed in `/usr/share/hypr/stubs/hl.meta.lua`) to a file in the sandbox, and
the probe reads it back. Classes are `dr-fp-<name>`; below, the bare name.

### 9i2 (a) — the active tab is `visible`, on every workspace

Group ga,gb,gc (tab order), each candidate against `Group.current`:

    shown, gb last focused:        truth gb [current_index 2] | visible=true:[gb] hidden=false:[ga+gb+gc] min-fhid:gb
    shown, tab set by group.active: truth gc [3]              | visible=true:[gc] hidden=false:[ga+gb+gc] min-fhid:gb
    hidden (was shown), same:      truth gc [3]              | visible=true:[gc] ...                    min-fhid:gb
    NEVER shown (group carried to ws 8 with window.move, follow=false):
                                   truth gb [2]              | visible=true:[gb] ...                    min-fhid:gb
    NEVER shown, tab set by group.active: truth gc [3]       | visible=true:[gc] ...                    min-fhid:gb

`visible === true` names the active tab on shown, hidden and never-shown
workspaces alike — it is a per-group "current tab" flag, not "on screen" (every
window on a hidden ws 2 or never-shown ws 8 outside a group also reads
`visible: true`). `hidden` is `false` on every member always. The lowest
`focusHistoryID` is wrong whenever the tab changed without a focus. **Agrees with
§2.2 `activeTabOf`** (exactly one member with `visible === true`).

### 9i2 (b) — group.active honours the selector; the index is 1-based

With the focus on a2 (tiled beside the group, not in it), ws 2 shown:

    group.active({ index = 0, window = "address:<gc>" }) -> ok, tab gc   (aw a2, shown 2 unchanged)
    index = 1 -> ga    index = 2 -> gb    index = 3 -> gc               (aw, shown unchanged each time)
    no selector, a2 focused, index = 1 -> "warning: Window is not in a group", tab unchanged
    focus on ga (in the group), index = 2 by selector -> tab gb, activewindow ga -> gb
    group on hidden ws 2, focus home on ws 1, index = 0 -> tab gc; aw home, shown 1 unchanged
    group on never-shown ws 8, index = 3 -> tab gc; aw home, shown 1 unchanged

The selector is honoured, on a hidden and a never-shown workspace too, and the
named member only picks the group. The index is **1-based** (Lua's
`current_index` agrees). **Index 0 silently selects the LAST tab.** It moves
neither the shown workspace nor `activewindow`, unless the focus is already
inside that group. Then `activewindow` follows the new tab, as a tab click would.
So a `tab` op needs no focus and does not have to wait while the session is locked.

For the record, the focus path: `focus({ window = ga })` on hidden ws 8 changed
the shown workspace 1 -> 8 and made ga the tab. `focus(home)` brought ws 1 back,
and ws 8 kept ga as its tab.

**Contradiction with §2 to settle in the contract:** §2.6's `tab` op carries
`index`, and the recorded `group.index` is 0-based (ga@0, gb@1, gc@2). The
dispatch must send `index = group.index + 1`. Sent unconverted, tab 0 lands on
the last tab and every other tab is off by one, and the call still answers `ok`.

### 9i2 (c) — resizing any member moves the group tile's divider; the sign law holds

Group tile and plain window et, stacked (axis 1). Sizes are the member's WINDOW
height, which is the tile minus the 21px groupbar:

    group FAR (below et), active ea:    cur 396 ask 356 -> 436 = 2*cur-ask; et 417 -> 377
    group FAR, non-active eb:           cur 436 ask 396 -> 476 = 2*cur-ask; et 377 -> 337
    (swap et with the group: group now NEAR)
    group NEAR, active ea:              cur 316 ask 276 -> 276 EXACT;      et 497 -> 537
    group NEAR, non-active eb:          cur 276 ask 236 -> 236 EXACT;      et 537 -> 577
    plain et, far side:                 cur 577 ask 537 -> 617 = 2*cur-ask

The active and non-active members behave the same, all members keep one shared
rect, the tab does not change, and every call answers `ok`. A divider op may be
addressed to the tile key (§2.3) whatever its tab. The asked value is the
member's window size, so recorded and live member rects compare like for like.
`splitTreeOf` accepts the 21px inset: et 5,5 691x417 over group 5,449 691x396
reconstructs as `{axis 1, near et, far g}`.

### 9i2 (d) — swap with a non-active member swaps the whole tile; togglesplit from a member flips the tile's parent

    tab ec; swap({ window = et, target = ea (non-active) }) -> ok:
      et 5,5 691x417 -> 5,428 691x417; group 5,449 691x396 -> 5,26 691x396 (all three members);
      tab still ec; activewindow and shown workspace unchanged
    swap({ window = eb (non-active), target = et }) -> ok: back to et 5,5 / group 5,449, tab ec
    focus ec (active), layout("togglesplit") -> ok: et/group axis 1 -> 0 (et 5,5 343x840, group 354,26 342x819)
    focus ea (non-active), layout("togglesplit") -> ok: axis 0 -> 1, back.
      Focusing ea MADE ea the tab.

A swap works with a member in either role, and it needs no focus.
Togglesplit flips the tile's parent from any member. But focusing a non-active
member changes the active tab, so a `split` op on a group tile should focus the
recorded-active member, or reapply the tab afterwards. Agrees with §2.3 and
rationale point 2.

### 9i2 (e) — the member chain holds: adjacent joins, leader keeps its rect

Leader et, then ea arriving on et, eb on ea, ec on eb (focus on the predecessor,
then `window.move`). Then `group.toggle(ea)`, and the joins in tab order (focus the
predecessor, focus the candidate, `into_group`):

    leaders: et 5,5 691x417, ea 5,428 691x417
    after arrivals: ea 5,428 343x417, eb 354,428 342x205, ec 354,639 342x206
    join eb (pred ea): took on "left", the first direction tried
    join ec (pred eb): took on "left", the first direction tried
    after: group ea,eb,ec at 5,449 691x396 — same left, width and bottom as ea's
           417-high tile, 21px groupbar inset; et unchanged

Every join was adjacent, with no scratch fallback. The tab order is ea,eb,ec, and
the leader's tile is exactly its arrival rect. **E1 can sequence members (§2.3
arrival program)**; the fallback named in rationale point 3 is not needed.

### 9i2 (f) — the arrival's axis is the split tile's aspect; togglesplit on the arrival flips only its node

    f2 on f1 (tile 691x840, taller): axis 1, f2 below   (5,428 691x417)
    f3 on f2 (tile 691x417, wider):  axis 0, f3 right   (354,428 342x417)
    f4 on f3 (tile 342x417, taller): axis 1, f4 below   (354,639 342x206)
    togglesplit, f3 focused right after it arrived: f2/f3 axis 0 -> 1; only f2 and f3 moved
    togglesplit, f4 focused right after it arrived: f3/f4 axis 1 -> 0; only f3 and f4 moved

Under `force_split = 2` the arrival always takes the far side (right or below).
The axis follows the split tile's aspect: wider gives side by side (axis 0),
taller gives stacked (axis 1). Togglesplit with the arrival focused, right after
it arrives, flips exactly the node the arrival created. Each flip was toggled
back. Agrees with §2.5's axis step: one toggle is always enough.

### 9i2 (g) — modes, float, tags

    workspacerules -j for ws 9 before the rule: []
    hl.workspace_rule({ workspace = "9", layout = "scrolling" }) -> ok
    workspacerules -j for ws 9 after:  [{"workspaceString":"9","enabled":true}]   (keys: enabled, workspaceString only)
    windows spawned onto ws 9 (never shown): workspaces -j tiledLayout "scrolling"; ws 5 "dwindle"
    on scrolling, shown: swap(s1, s3) -> ok, positions exchanged
                         resize(s2 341 -> ask 281) -> ok, s2 280 wide, neighbours shifted
                         layout("togglesplit") -> error: no such layoutmsg for scrolling
    float action "on","on","off","off" -> ok each; floating true,true,false,false
    window.tag({ tag = "+omarchy-floating-workspace" }) -> tags ["omarchy-floating-workspace"]
    the same tag from a window RULE                   -> tags ["omarchy-floating-workspace*"]

`tiledLayout` reads the mode of any existing workspace, shown or not.
`workspacerules -j` does **not** expose a rule's layout, so a workspace that does
not exist yet has an unreadable mode. On scrolling, swap and resize answer `ok`
and really do rearrange, which is why §2.4 must refuse them by name: no error will
catch them. `float` on/off is absolute and idempotent. A tag set by dispatch has no
`*`, and a rule's tag has a trailing `*`. 4.5's `workspace-modes.lua` sets
`omarchy-floating-workspace` by dispatch, so it reads bare, and §2.2's "a
trailing `*` is ignored" covers both forms.

**Gap in §2.2/§2.4 (not a contradiction):** `workspaceModeOf` is null for a
workspace that does not exist yet, whatever rule is waiting for it. A
sequenced program into a not-yet-existing scrolling workspace therefore gets
`splitParent` moves on its first plan. The mode becomes readable once the first
arrival creates the workspace. S-ticks should re-read `workspaces -j` between
arrivals, or accept one mis-choreographed first pass.
