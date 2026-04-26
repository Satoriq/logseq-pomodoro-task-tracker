# Pomodoro task manager for Logseq

A focus timer that tracks **how long you actually spend on each task**, not just how many pomodoros you finish. Built on top of Logseq's native task statuses so it stays out of your way and works with the blocks you already have.

> This plugin was vibe coded, only security/privacy was checked manually.

> Built for **Logseq DB version** (the new schema). Not compatible with the legacy file-based Logseq.

## Features

- **Pomodoro focus/break cycles** with audio notifications and a daily 🍅 count
- **Per-task time tracking** — every task you mark "Doing" accumulates focus time across sessions
- **Modifier-gated tracking** — hold `Alt` (Windows/Linux) or `Option` (macOS) while changing a task to _Doing_ to add it to the panel; without the modifier the task is just regular Logseq state
- **Floating panel** with active tasks, in-review, todos, backlog, done, and canceled sections
- **Drag-and-drop** to reorder active tasks
- **Status circle picker** — click the circle in front of any task in the panel to change its native Logseq status without opening the block
- **Expandable child preview** — open child blocks (text + images) right inside the panel
- **Pause / resume** — pauses both the pomodoro and any currently-tracked tasks together
- **Customizable** — panel scale, fonts, colors, current-time display, drag positioning, six notification sounds

## How it works

The plugin watches Logseq's native `:logseq.property/status` changes. When you change a block's status to **Doing** while holding `Alt` / `Option`, that block gets pulled into the panel and starts accumulating focus time. The pomodoro counts down independently; when it ends, you hear a tone and the next phase (focus/break) starts automatically.

| Action                                                     | Result                                              |
| ---------------------------------------------------------- | --------------------------------------------------- |
| Change a task to **Doing** _with_ modifier                 | Track in panel                                      |
| Change a task to **Doing** _without_ modifier              | Just a normal status change, plugin ignores it      |
| Change a tracked task to **In Review**                     | Moves to the _In review_ section but keeps tracking |
| Change a tracked task to Done / Cancelled / Backlog / Todo | Removed from the panel                              |
| Click the circle next to a task in the panel               | Status picker opens — change status from here       |
| Drag a task in the _Active tasks_ section                  | Reorders that section                               |

## Panel

The panel is fixed to the bottom-right corner by default and can be:

- **Dragged** — grab the timer area to move it anywhere on screen
- **Collapsed** — click ▲ / ▼ to hide/show the task list
- **Scaled** — set _Panel scale_ in settings (0.5–1.0) to shrink the whole thing

## Commands

Available in the command palette (Cmd/Ctrl + Shift + P):

- `Pomodoro: Reset timer`
- `Pomodoro: Pause/Resume`
- `Pomodoro: Cycle timer visibility` — full / minimal / hidden

## Settings

Open _Plugin settings → Pomodoro task manager_:

- **Timer** — focus minutes, break minutes, update interval
- **Sounds** — enable, volume, notification sound (six variants)
- **Display** — show/hide current time, tasks timer, pomodoro timer; panel scale
- **Daily reset** — toggle "Reset today's pomodoros" to clear the 🍅 count
- **Appearance** — colors and font sizes for panel background, task title, parent line, child blocks, and timer

## Tomato counter

The 🍅 row above the timers shows pomodoros completed **since local midnight only**. Use _Reset today's pomodoros_ in settings to clear it manually.

## Install

Install from the Logseq Marketplace, or load manually:

1. Download `package.zip` from [Releases](https://github.com/Satoriq/logseq-pomodoro-timer/releases)
2. Unzip and load as a local plugin in Logseq (_Plugins → Load unpacked plugin_)

## Build from source

```bash
npm install
npm run build
```

The packaged plugin lives in `dist/`. To develop with hot rebuilds:

```bash
npm run dev
```

## License

MIT
