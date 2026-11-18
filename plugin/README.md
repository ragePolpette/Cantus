# Cantus plugin for Claude Code

Adds to Claude Code:

- the **Cantus MCP server** (`map`, `block_context`, `find_api`, `callers`, `trace`, `impact`, `diff`, `check`, `update_map`, `update_notes`, `review_changes`, `sketch_map`, `apply_design`, `add_block`, `edit_block`, `remove_block`, `merge_block`, `boundary_candidates`, `split_block`, `move_to_block`, `add_dependency`, `remove_dependency`, `set_layers`, `set_external_access`, `pending_requests`, `request_done`, `worktrees`, `worktree_done`, `worktree_prepare`, `specialist_prompt`);
- **hooks**: a short project map at session start (for a small map, what each block does and uses, and the groups); before an edit, which block the file belongs to and which other blocks call its exports; after an edit, a warning when an export other blocks use was removed or changed, with the call sites; the work you wrote for this session on the live map, when you send a message, after the session's next tool call if it is busy, and when it is about to stop (see below); the moment the session (or a specialist) asks you for a permission, so the map says "asking for a permission" (`PermissionRequest`; it prints nothing and decides nothing); and when a `block-<id>` or `group-<id>` specialist starts or stops, a signal to the live map, which shows a little robot and a green glow on the blocks it is working on (the map also takes it from the specialist's edits, in case a start or stop event does not come, and forgets an agent it has not heard of for 20 minutes). These two hooks add nothing to the agent's context;
- the **`/cantus:agents` command**, which writes the block specialists from the current map;
- the **`/cantus:verify` command**, which has a separate, read-only agent review your work and then hands you its findings to check (`cantus verify`);
- the **cantus skill**: how to orient with the map, reuse code, and split larger tasks across block specialists running in parallel.

The hooks and the MCP server start through `scripts/cantus.mjs` (run by `node`), which finds the `cantus` command on your PATH. This is for Windows, where npm installs `cantus.cmd` and Claude Code cannot start a `.cmd` file from a hook or an MCP entry.

Block specialists (`block-<id>` subagents) depend on your project's map, so they are generated in the project: run `cantus agents`.

## Install

The plugin runs the `cantus` command, so install it first:

```bash
npm install -g github:ragePolpette/Cantus
claude plugin marketplace add ragePolpette/Cantus
claude plugin install cantus@cantus
```

Then, in your project: `cantus analyze --write` (the map), `cantus notes` (per-block notes), `cantus agents` (block specialists). Do these before you open Claude Code in the project.

## Specialists written while a session is open

Claude Code watches `.claude/agents` and loads a specialist written during the session within a few seconds, but only if that folder existed before the session started. `cantus analyze --write` creates it, so a session opened afterwards picks up new specialists by itself: run `/cantus:agents` (it runs `cantus agents`) after you add blocks or groups to the map. If the folder is new when you run it, the open session needs a restart (`claude --continue` keeps the conversation); until then, and for any specialist the session cannot load, the `specialist_prompt` tool returns a specialist's instructions to give a general-purpose subagent.

## Writing work for your open session on the live map

The live map that `cantus mcp` serves can send a prompt to the Claude Code session that started it: select a block, a group or the whole project, write what it should do, and choose "Here, in this worktree: the lead takes it". The request is queued in the map. Your session gets it with your next message (the plugin's `UserPromptSubmit` hook adds it), after its next tool call if it is busy working (`PostToolUse`), when it is about to stop (`Stop`: the session goes on instead of stopping), or when it calls `pending_requests`, confirms it with `request_accept` (one line on what it understood), does the work with its own permissions and context, and closes it with `request_done`; its summary shows in this worktree's card of the Worktrees column on the map. When you add a block in the map's editor you can write its first piece of work in the same form, and it goes the same way. The same form can send the work to the session open in another worktree of the repository ("In <branch>: its lead takes it"), or ask for a new worktree, which gives the lines that open a session there. The map does not start a Claude Code session of its own, and does not follow one: a session you open is the lead of its worktree, with the block specialists as its subagents.

**Tried on a real session (23/10, Claude Code 2.1.304):** the request reaches the session with the next message, and `request_done` closes it. A `block-<id>` specialist written after the session started was not loaded by it: the request now tells the session to take the specialist's instructions from `specialist_prompt` when it is missing (see "Specialists written while a session is open").

**At once, without waiting for your next message:** the MCP server is also a Claude Code *channel*, which can push a nudge into a running session. Channels are a research preview, and a plugin of your own is not on Anthropic's approved list, so start the session with `claude --dangerously-load-development-channels plugin:cantus@cantus` (interactive sessions only, with a confirmation screen at each start; on Team and Enterprise plans an administrator must enable channels). The nudge only says that a request is waiting: the session then calls `pending_requests` to take it, so nothing is lost if channels are off, and without the flag everything above works the same, one message later.

On the map each request shows where it is, in the card of this worktree in the Worktrees column: *In queue*, *Delivered* (and how: with your next message, while it was working, when it was about to stop), *Taken* (the session confirmed it; the line shows what it understood), *Done*. A request delivered but never confirmed for a minute shows *no confirmation yet* with **Send again**, which queues it again with a reminder. The card also says whether the lead is working (it got in touch in the last minute and a half) or waiting for you. A session that is idle, waiting for you, with no channel, cannot be woken from outside: the request waits for your next message there (or start the session with the channel, see above). The queue lives in the memory of the process that serves the map. With several sessions open on the same project, each one serves its own map, and the hook talks to the one that wrote `.cantus/cache/serve.json` last.
