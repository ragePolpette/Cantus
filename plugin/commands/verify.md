---
description: Have a separate reviewer agent check your work (read-only), then handle its findings
allowed-tools: Bash(cantus verify:*)
---

Start a verification of the work in this project by a separate agent: it did not see your reasoning, it can only read, and it ends with findings.

What the user typed after the command is free text, not a list of options: `$ARGUMENTS`. It can be a pull request, a branch, a description of what to check, or nothing. Do not paste it into the command. Read it and turn it into options of `cantus verify` (`cantus verify --help` lists them all):

- what the work was meant to do, in the user's words → `--about "<text>"`. If the user gave none, use what they asked you for. Do not paste your own summary of the work: the reviewer should judge the changes, not your account of them.
- a branch, tag or commit to compare with → `--base <ref>`.
- a branch that is not checked out here (a pull request's) → `--head <branch>`: Cantus checks it out in a temporary folder and removes it afterwards. No dependencies are installed there, so its tests do not run. If the work is in a worktree that already exists, run the command there instead: `cantus verify -C <folder> …`.
- the user asks to skip the tests → `--no-tests`; gives a command → `--tests "<command>"`.

Ask the user first only if it is unclear what work to verify. Run it with the Bash timeout set to 600000 (it takes a few minutes), always with `--no-deliver` (you read the report here; without it the findings would reach you a second time as a request):

`cantus verify --no-deliver <the options you worked out>`

If the command says on its first line that no test command is configured, the tests were not run: say so to the user, run them yourself if you can, and suggest setting `agent.verifyCommand` in the map (or `--tests`) so that the next verification runs them first.

Then handle the report as a reviewer's opinion, not as orders. For each finding, check it against the code yourself, including the old code it claims to compare with: the reviewer may not have read it. Fix those that are real; for the others, tell the user why you disagree. If the verdict is `incomplete`, say what the reviewer could not check. Do not run the verification again on your own after fixing: the user decides.

If the command says there is nothing to verify, say so in one line.
