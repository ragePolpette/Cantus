---
description: Write the block specialists (block-<id> subagents) from the current map, so blocks added since the session started get theirs
allowed-tools: Bash(cantus agents:*)
---

Specialists generated now:

!`cantus agents`

Tell the user in one or two lines what was written. Claude Code loads a subagent written during the session within a few seconds, as long as the `.claude/agents` folder existed before the session started (`cantus analyze --write` and `cantus agents` create it). If the output above says the folder is new, say that this session loads them only after a restart (`claude --continue` keeps the conversation). Until then, for a block whose specialist is missing from your agents, call `specialist_prompt` and give its text, followed by the task, to a general-purpose subagent.
