---
name: cantus
description: Work on a codebase with the Cantus tools, with or without a saved map (.cantus/model.json). Use it to understand the project structure, reuse existing code instead of rewriting it, change exported APIs without breaking callers, and split larger tasks across block specialists that run in parallel. Also use it to start a new project from a description.
---

# Working with a Cantus map

The project is split into **blocks** (modules). The Cantus MCP server knows each block's public API, its dependencies, and every call site of its exports. Each block folder has notes (AGENTS.md or CLAUDE.md) that load when you open files there, and each block may have a specialist subagent named `block-<id>`.

## Without a saved map

If `map` says the blocks are inferred from folders (no `.cantus/model.json`), the blocks are folders, not an architecture: do not read them as layers or owners, and do not delegate to `block-<id>` specialists (there are none). The rest works on files and symbols: `find_api` before writing a helper, `callers` before changing or removing an export (it lists every other file that uses it, same block or not), `review_changes` and `diff` after, `check` for problems, `block_context` to brief a folder. Suggest `cantus analyze --write` to the user when the work would benefit from a map they can edit.

## Orient

- `map` gives the blocks, what they do, and how they depend on each other. Start there instead of reading the tree.
- `block_context` (by block id or by any file path) gives the briefing for one block. Read it before changing that block.
- `trace` answers "where does this call come from / where does it go": give a route, a handler or a page and get the chain page → HTTP call → handler, without a whole briefing. Use it before grepping for an endpoint.

## Small change, one block

Do it yourself, or delegate to that block's `block-<id>` specialist. Either way:

- The briefing lists the block's tests: run them after the change and update them with it.
- Before writing a helper, call `find_api`: it may already exist in another block.
- Before changing or removing an export, call `callers` and update those call sites in the same change, or keep the old form working. When several blocks may depend on it, `impact` shows which ones a change reaches, directly and through others.

## Groups of blocks

Some work naturally spans a few blocks (one feature, one flow). The map can save such scopes as **groups**; `map` lists them.

- `block_context` with `group` (or with `blocks` for a one-off set) briefs them as one scope: dependencies inside the group are internal, only outside blocks count as neighbors and callers.
- Delegate group work to its `group-<id>` specialist, or to `cantus-scope` with the block ids in the task when no saved group fits.
- When a scope comes back often, keep it with `save_group`.

Briefings also carry the team's documents: the common ones and those assigned to the block or group. They state what the code cannot (rules, decisions, pitfalls): follow them over what the code alone suggests. When you had to discover something a future agent on that block would otherwise rediscover, add it to the block's (or group's) domain note, `.cantus/domain/<id>.md`, registered with `assign_doc` (path given, `create`): at most three lines per piece of work, each under `Invariants`, `Decisions`, `Pitfalls` or `How to test here`, with the files it rests on. "Nothing to add" is a valid answer, and a block with nothing peculiar gets no note.

## Larger task across blocks

You coordinate; block specialists do the work. Don't edit those blocks yourself: each piece goes to its block's specialist, which works with the block's briefing and rules. The exception is a minimal change: a few lines you already know how to write in each block (about 20 in total), with nothing to read or understand first. Make it yourself, a specialist costs far more than it adds. If any piece needs you to explore a block, delegate.

1. Plan with `map` and `block_context`; check what exists with `find_api`. Split the task into one piece per block, and write the acceptance criteria and the pieces down before delegating, as the task file of a prepared worktree says (`.cantus/cache/session-plan.md`).
2. When block B needs a new or changed API from block A, give A's piece first, with the exact signature, and start B only after A reports back.
3. Start independent pieces in parallel: several `block-<id>` (or `group-<id>`) subagents in the same message. Give each the overall goal, its own part, and the exact signatures it provides or relies on.
4. Run the specialists in the project folder, without `isolation: "worktree"`: the work of a specialist in a worktree stays uncommitted there, and `map`, `block_context` and `review_changes` read the project folder, so they would not see it. Keep the pieces disjoint instead (one block each). For an isolated run, the person asks the map for a new worktree: it makes it and gives the lines that open a session there, and that session is the lead of that worktree (you, in your own worktree).
5. After each round, read the reports. A specialist that needs something from another block tells you: schedule that as a new piece for the owning block, then let the first one finish.
6. At the end, run the project's tests, call `check` and `review_changes` (it lists exports changed with the call sites still to update, and files that usually change with the ones you touched), and if the structure changed (new folders, new dependencies) call `update_map` and `update_notes`.

### When the work needs a plan, not subagents

For a piece of work across several blocks that the person wants checked independently (a cancello that Cantus runs, a separate reviewer, each task in its own worktree and merged one at a time), do not launch the specialists yourself: write the work down with `plan_propose`. One task per block or group, each with a self-contained prompt (the exact signatures it provides or relies on), the check to pass **by name** (`agent.checks`, never a command), `dependsOn` only where the map's order is not enough, and `"verify": true` when the person asked for a review. Cantus validates it against the map and stores it **not approved**: tell the person its id and that `cantus plan run <id>` approves and runs it. Then follow it with `plan_status`; if a task stops, read why and, if more words would help, add them with `task_retry`. You cannot run, approve, merge or discard a plan, change a check, or accept a reviewer's findings: that is the person's. The plan is optional. Small work, and anything the person asked you to do yourself, stays as above; a plan costs sessions and time.

If the `block-<id>` subagents are missing, run `cantus agents` (or `/cantus:agents`) to generate them from the map. When a specialist is still not among your agents (written after the session started, in a folder Claude Code was not watching), call `specialist_prompt` with its id and give the returned text, followed by the task, to a general-purpose subagent.

## New project from a description

Sketch the structure following the guide in the `sketch_map` tool description: layers, blocks (name, folder, one line) and arrows, no APIs. Show the sketch to the user, adjust it with them, then call `sketch_map`: the blocks appear as planned on the live map, where the user can still edit them. Then build the blocks starting from those that use nothing (the bottom layers), then the ones that use them, each through its block specialist; each block's agent decides its API.

The same works to extend an existing project: sketch only what is new; blocks already on the map are kept.

To change the map itself one step at a time, use `add_block`, `edit_block` (name, layer, description; the folder only while the block has no code), `remove_block` (only planned blocks), `merge_block` (fold a block, even with code, into a neighbour), `boundary_candidates` (read-only: where the blocks' borders look wrong, judged on the project's own git history; apply only with the user's yes), `split_block` (a new block out of some files or a subfolder of a block), `move_to_block` (files to another block), `add_dependency`, `remove_dependency` and `set_layers`. They check the change the way the live map's editor does; don't edit `.cantus/model.json` by hand. Restructure the user's map when they ask or when the work needs it, and say what you changed.

When a briefing or `map` says code points to a folder outside the map, that folder has not been read and you must not read it on your own account through Cantus. If the task depends on it, ask the user whether Cantus may analyse it, then record their answer with `set_external_access` (`allow` or `deny`). Allowed folders are read-only: their exports appear in `find_api` and the briefing, they are never edited from a block. A declined folder stays a pointer, and you do not ask again.

`apply_design` is the heavier alternative for a new TypeScript project: it also writes one `index.ts` contract per block up front. For any other language, use `sketch_map`.

## The map is a guide

When the code moves past the map (a new dependency, a new folder), that is information, not an error: `update_map` brings the map up to date.
