-- Minimal Hyprland config for the nested sandbox (Layer 4 of the build-test
-- loop). Launched as `Hyprland -c tests/nested.lua` from inside the real
-- session, it opens as a WINDOW with its own instance signature, so
-- destructive monitor experiments cannot wedge the real desktop.
--
-- WHY LUA AND NOT A .conf: a hyprlang config leaves the `hl` Lua environment
-- unloaded, and every `hyprctl dispatch 'hl.dsp.…'` in that instance answers
-- "Invalid dispatcher" — measured, see tests/nested-notes.md. Since the whole
-- point of the sandbox is to exercise the Quattro Lua dispatch verbs this
-- plugin uses, the nested config has to be Lua too.
--
-- It deliberately inherits NOTHING from Omarchy: sourcing the real config drags
-- in the exec-once storm (bar, shell, agents) and a second omarchy-shell
-- fighting over the same state files. No exec-once at all — the test drives
-- everything through hyprctl.

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

  misc = {
    disable_logo = true,
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
