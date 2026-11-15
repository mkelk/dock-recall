-- Minimal Hyprland config for the nested sandbox (Layer 4 of the build-test
-- loop). The compositor it configures runs as a WINDOW inside the real session,
-- with its own instance signature, so destructive monitor experiments cannot
-- wedge the real desktop.
--
-- IT IS NOT LAUNCHED BY HAND. `Hyprland -c tests/nested.lua` from a shell is
-- REFUSED by the park guard below, because that window would open on the user's
-- desktop. The only legal launcher is `sandbox_up` in tests/sandbox-lib.sh,
-- which parks it out of sight first.
--
-- WHY LUA AND NOT A .conf: a hyprlang config leaves the `hl` Lua environment
-- unloaded, and every `hyprctl dispatch 'hl.dsp.…'` in that instance answers
-- "Invalid dispatcher" — measured, see tests/nested-notes.md. Since the whole
-- point of the sandbox is to exercise the Quattro Lua dispatch verbs this
-- plugin uses, the nested config has to be Lua too.
--
-- It deliberately inherits almost NOTHING from Omarchy: sourcing the real config
-- drags in the exec-once storm (bar, shell, agents) and a second omarchy-shell
-- fighting over the same state files. No exec-once at all — the test drives
-- everything through hyprctl. The ONE exception is Omarchy 4.5's per-monitor
-- workspaces module, loaded on its own below the park guard: it
-- renumbers workspaces on every monitor change, and a sandbox without it would
-- prove the plugin against a desk that no longer exists.

-- ============================================================== THE PARK GUARD
--
-- READ THIS BEFORE CHANGING ANYTHING BELOW IT.
--
-- A nested Hyprland started from inside a running session is an ORDINARY WINDOW
-- on the user's desktop. The only thing that has ever kept it off screen is the
-- prefix `sandbox_up` puts on its launch:
--
--     hl.dsp.exec_cmd([[ [workspace special:dr-sandbox silent] … ]])
--
-- and that prefix belongs to the OUTER compositor. This config cannot express
-- it — it configures the inner one — so for two increments the parking was a
-- rule in a document, and twice an agent ran `Hyprland -c tests/nested.lua`
-- straight from a shell and put a window in front of the human mid-session.
-- Both times they stopped the run. A rule that is only written down is not a
-- guard; this is the guard.
--
-- HOW IT WORKS. `tests/sandbox-lib.sh`'s launch wrapper — the one and only
-- thing reachable through that parked dispatch — exports DR_NESTED_SANDBOX_PID
-- holding `$$`, and then `exec`s Hyprland, so the value IS this process's pid.
-- This config reads its own pid from /proc/self/stat and refuses to configure
-- unless the two agree. Refusing here is not a warning: it calls os.exit, which
-- ends the process during config parse, BEFORE a backend or a surface exists.
-- No window, no compositor, no IPC socket — nothing to appear on any screen.
--
-- WHY THE PID AND NOT A PLAIN FLAG. Everything launched inside the nested world
-- inherits the wrapper's environment, so a bare flag would be a key the sandbox
-- hands to every process it starts — including any probe that then ran
-- `Hyprland -c tests/nested.lua` from in there and sailed past the guard. A pid
-- cannot be inherited into being true: only the process the wrapper exec'd has
-- it, and one generation of fork makes the marker false again.
--
-- FAIL CLOSED. Every branch that cannot establish the answer refuses. A
-- refusal costs a test run; the alternative costs the human their session.
--
-- THE LEGITIMATE PATH IS UNCHANGED: `tests/sandbox-dock.sh` and every other
-- scenario over sandbox-lib.sh go through the wrapper and never see this.

local MARKER = "DR_NESTED_SANDBOX_PID"

-- Our own pid, read from the process itself rather than asked of a shell: this
-- IS the Hyprland process (the wrapper exec'd into it), so field 1 of
-- /proc/self/stat is the number the marker has to match.
local function own_pid()
  local ok, pid = pcall(function()
    local f = io.open("/proc/self/stat", "r")
    if not f then return nil end
    local line = f:read("*l")
    f:close()
    return line and line:match("^(%d+)")
  end)
  if ok then return pid end
  return nil
end

local function refuse(reason)
  io.stderr:write(
    "\n" ..
    "nested.lua: REFUSING TO CONFIGURE — " .. reason .. "\n" ..
    "  This config is only ever legal inside the parked launch path in\n" ..
    "  tests/sandbox-lib.sh, which dispatches it through the live compositor\n" ..
    "  as `hl.dsp.exec_cmd([[ [workspace special:dr-sandbox silent] … ]])` and\n" ..
    "  exports " .. MARKER .. " on the way. Started any other way — a bare\n" ..
    "  `Hyprland -c tests/nested.lua` from a shell, say — this compositor opens\n" ..
    "  as a VISIBLE WINDOW on the user's desktop. It has done, twice.\n" ..
    "  Use `source tests/sandbox-lib.sh; sandbox_up`. If the shape you need is\n" ..
    "  not in that harness, extend the harness.\n" ..
    "  Aborting the start; no compositor will come up.\n")
  io.stderr:flush()

  if type(os) == "table" and type(os.exit) == "function" then
    os.exit(1)
  end

  -- os.exit gone from this build's Lua: an `error()` alone would only trip
  -- Hyprland's emergency mode, which starts a compositor anyway — the exact
  -- outcome this guard exists to prevent. Kill the process outright instead.
  local pid = own_pid()
  if pid then io.popen("kill -9 " .. pid) end
  error("nested.lua refused to configure: " .. reason, 0)
end

local claimed = os.getenv(MARKER)
local actual = own_pid()
if claimed == nil or claimed == "" then
  refuse("no " .. MARKER .. " in the environment, so this start did not come "
    .. "through the parked launch path")
elseif actual == nil then
  refuse("cannot read this process's own pid from /proc/self/stat, so the "
    .. MARKER .. " marker cannot be checked")
elseif claimed ~= actual then
  refuse(MARKER .. " is " .. claimed .. " but this process is " .. actual
    .. " — the marker was INHERITED from the sandbox environment, not issued "
    .. "for this start")
end

-- ============================================================================

hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })

hl.config({
  general = {
    border_size = 1,
    gaps_in = 2,
    gaps_out = 4,
  },

  decoration = {
    rounding = 0,
    blur = {
      enabled = false,
    },
  },

  animations = {
    enabled = false,
  },

  -- Omarchy's own dwindle settings (default/hypr/looknfeel.lua:94-95): every
  -- window the desktop's user opens splits to the right/bottom (force_split = 2)
  -- and a split keeps its orientation when a sibling closes (preserve_split).
  -- Without them the sandbox tiled under Hyprland defaults, which is not the
  -- tree a real Omarchy desk builds.
  dwindle = {
    force_split = 2,
    preserve_split = true,
  },

  misc = {
    -- `disable_logo` used to sit here and is gone. It is not a key
    -- this Hyprland has: `misc:disable_hyprland_logo` just below is the real
    -- spelling, and `misc:disable_logo` appears nowhere in 0.56.2's config
    -- table. What it did NOT do — measured both ways in the nested sandbox,
    -- with the key in and out — is produce the red "Your config has errors"
    -- overlay the project notes blames it for: `hyprctl configerrors` comes
    -- back blank either way, because the LUA config manager ignores an unknown
    -- table key silently (only the hyprlang parser errors on one). So this was
    -- a line that did nothing and claimed to do something, which is reason
    -- enough. tests/sandbox-nested-guard.sh now asserts configerrors is empty.
    disable_splash_rendering = true,
    disable_hyprland_logo = true,
    force_default_wallpaper = 0,
    background_color = 0x222222,
  },

  input = {
    kb_layout = "us",
    follow_mouse = 1,
  },
})

-- One escape hatch, in case the nested window is ever driven by hand.
hl.bind("SUPER + SHIFT + Q", hl.dsp.exit())

-- ============================================ OMARCHY 4.5 PER-MONITOR WORKSPACES
--
-- default/hypr/monitor-workspaces.lua, loaded in isolation. On a 4.5
-- desk every monitor owns a block of ten workspace ids (block 0 = 1..10, block 1
-- = 11..20, …), and a reconcile on every monitor add/remove and config reload
-- moves and RENUMBERS workspaces to keep it so. That is the behaviour the plugin
-- must restore against, so the sandbox runs the real module, not a model of it.
--
-- AFTER the park guard, always: nothing below may run in an unparked start.
--
-- The shim is the smallest thing the module needs that Omarchy's own
-- bootstrap.lua / helpers.lua would otherwise provide:
--   - package.path reaching $OMARCHY_PATH/?.lua, for `require("default.hypr.paths")`.
--     NOT bootstrap.lua's ~/.config and ~/.local/state entries — the user's own
--     hypr modules have no business here (HOME is the sandbox's anyway).
--   - a global `o` with shell_quote (the module's mkdir fallback) and
--     bind_expressions (its key actions register there); it sets o.workspaces.
--
-- WHERE IT WRITES: paths.lua reads XDG_STATE_HOME, which the launch wrapper in
-- tests/sandbox-lib.sh exports as the sandbox's own, so the block table lands
-- in $SBOX/home/.local/state/omarchy/. sandbox_verdict checks both sides: the
-- sandbox table exists with a row per nested monitor, and the desk's two files
-- kept their mtimes. Refused outright if the state home is not under a
-- dr-sandbox temp dir — a nested block table written over the desk's would
-- renumber the human's bar.
--
-- Module cache: Hyprland keeps one Lua state across `hyprctl reload`, so, like
-- bootstrap.lua, drop the cached default.hypr.* modules first; otherwise the
-- reload would skip the module body and register none of its handlers.
do
  local function env_or(name, fallback)
    local value = os.getenv(name)
    if value == nil or value == "" then return fallback end
    return value
  end

  local omarchy_path = env_or("OMARCHY_PATH", "/usr/share/omarchy")
  local module_file = omarchy_path .. "/default/hypr/monitor-workspaces.lua"
  local state_home = env_or("XDG_STATE_HOME", "")
  local probe = io.open(module_file, "r")

  if not state_home:match("/dr%-sandbox%.[^/]+/home/%.local/state$") then
    io.stderr:write("nested.lua: NOT loading monitor-workspaces.lua — XDG_STATE_HOME '"
      .. state_home .. "' is not a sandbox state home, and the module would write the desk's block table\n")
  elseif not probe then
    io.stderr:write("nested.lua: NOT loading monitor-workspaces.lua — " .. module_file
      .. " is missing (Omarchy older than 4.5?)\n")
  else
    probe:close()

    for name in pairs(package.loaded) do
      if name == "default.hypr" or name:sub(1, 13) == "default.hypr." then
        package.loaded[name] = nil
      end
    end

    local entry = omarchy_path .. "/?.lua"
    if not package.path:find(entry, 1, true) then
      package.path = entry .. ";" .. package.path
    end

    o = o or {}
    o.shell_quote = o.shell_quote or function(value)
      return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
    end
    o.bind_expressions = o.bind_expressions or {}

    require("default.hypr.monitor-workspaces")
  end
end
