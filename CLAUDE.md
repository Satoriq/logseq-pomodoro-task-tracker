# Pomodoro task manager Plugin — Development Context

## Overview

A Logseq plugin for tracking time on tasks with Pomodoro focus/break cycles and audio notifications.

Built for **LogseqDB** (the new database version), NOT the legacy file-based Logseq.

## Tech Stack

- TypeScript, Webpack, `@logseq/libs@0.3.2` (DB version SDK, tagged `next`)
- Single source file: `src/index.ts`
- Build: `npm run build` (production), `npm run dev` (watch mode)
- Plugin ID: `logseq-pomodoro-timer` (defined in `package.json` under `logseq.id`)

## LogseqDB API Gotchas (Critical)

### Property Access

- LogseqDB stores task status as `:logseq.property/status` (namespaced property)
- `getBlock()` returns properties as **entity refs** like `{id: 80}`, NOT resolved strings
- **Must use `getBlockProperties(uuid)`** to resolve refs to actual strings like `"Doing"`
- To update native status: `upsertBlockProperty(uuid, ":logseq.property/status", value)` — using lowercase `"status"` creates a DUPLICATE custom property
- `block.title` is the primary text field (not `content` with marker prefixes)

### DB.onChanged

- Fires with blocks but does NOT include resolved properties
- Must re-fetch via `getBlock()` + `getBlockProperties()` inside the handler

### Navigation

- `scrollToBlockInPage` does NOT work in LogseqDB
- Use `(logseq.App as any).pushState('page', { name: blockUuid })` instead
- For sidebar: `logseq.Editor.openInRightSidebar(blockUuid)`

### File Storage

- `DB.setFileContent` only works for built-in config files (`logseq/custom.css` etc), NOT arbitrary `assets/` paths — gives "Invalid path"
- `Assets.makeSandboxStorage()` — stores in `{graph}/assets/storages/{plugin-id}/`, backed up with graph but NOT visible in Assets panel
- `FileStorage` — stores in `~/.logseq/storages/{plugin-id}/`, separate from graph
- There is NO plugin API to write to the main `assets/` folder or create first-class assets

## Architecture

### Pomodoro Timer

- **Modifier-gated task tracking**: hold Alt on Windows/Linux or Option on macOS while changing a task to "Doing" to add it to the pomodoro
- Tracked tasks changed to "In Review" move from active tracking into a separate "In review" list
- Tracked/review tasks changed to Backlog, Todo, Done, Cancelled, or No Status are removed like Todo
- `pluginChangingStatus` flag prevents the plugin's own status updates from triggering task tracking
- Pause changes Logseq status to "Todo" but KEEPS task in `trackedTasks` array
- Tomato count shows only pomodoros completed since local midnight and can be reset via the "Reset today's pomodoros" settings toggle
- Timer state persisted in localStorage

## Common Issues & Solutions

| Problem                             | Solution                                             |
| ----------------------------------- | ---------------------------------------------------- |
| Properties show as `{id: N}`        | Use `getBlockProperties(uuid)` not `getBlock()`      |
| Duplicate "Status" property appears | Use `:logseq.property/status` as key, not `"status"` |
