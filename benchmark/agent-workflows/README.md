# Compare the same coding workflow with and without Cantus

Measure the full workflow from discovery to the final verification. The L1 caller benchmark measures static reference quality and does not answer this question.

Use a pinned Cantus commit, pinned repositories, the same runtime version, model, reasoning effort, time cap and usage limits in both arms. Create fresh worktrees and sessions for every trial. Alternate which arm runs first and record the order. The only treatment is access to Cantus and the instructions needed to use it.

Start with tasks on at least two repositories. Include API changes with callers across blocks, impact questions with independently prepared answers, and a task that should fail a gate. Keep the initial prompt and evaluation criteria identical across arms. Use at least three paired repetitions per task. Record the repository commit, exact prompt and pass criteria before the first run.

For each arm, record pass/fail, independently verified defects and omissions, input tokens, cached input tokens, output tokens, elapsed time, retries and actual billed cost when available. Count every model call made by the domain and verification agents. Cached input is a subset of input. Missing usage is unknown. Use test results and review of anonymized diffs where possible. Record environment failures separately from task failures and retain unsuccessful attempts.

Evaluate both hypotheses independently.

- Token saving requires comparable quality and fewer total input plus output tokens on paired trials. Compare outcomes first. Report the paired median and spread with the number of trials that support it.
- Quality gain requires a better verified outcome within the same predetermined usage budget. Compare success rates and concrete defect counts. Post-hoc removal of long or failed runs invalidates this comparison.

Publish raw measurements and task definitions alongside any claim. Set the minimum useful effect before the scored run. This protocol has no scored agent-workflow results yet.

## Codex impact pilot

This executable pilot covers the impact-question subset of the protocol. It runs three matched pairs per task on two public repositories at pinned revisions. Each answer is scored against the exact production file and line list, prior to looking at usage. It keeps Codex JSON events, stderr, answer, elapsed time, Cantus tool calls and scores for every arm. It records timeouts and execution errors as separate outcomes. Codex's model and low reasoning setting are held constant. It compares the same read-only task, with a 120-second cutoff per arm.

With Cantus built and Codex authenticated in an environment that supports its read-only sandbox, use a Codex configuration without unrelated MCP servers. Clone the two repositories under the given directory, keeping the pinned commits from the manifest available locally.

```sh
git clone https://github.com/unjs/h3.git /path/to/repos/h3
git clone https://github.com/unjs/ohash.git /path/to/repos/ohash
node benchmark/agent-workflows/codex-impact.mjs /path/to/repos /path/to/new-results-dir MODEL_ID --dry-run
node benchmark/agent-workflows/codex-impact.mjs /path/to/repos /path/to/another-new-results-dir MODEL_ID
```

The dry run writes the tasks, oracle, settings and output schema. The live run uses a fresh checkout and process for every arm and alternates which arm goes first. Treat a missing usage event as unknown. Inspect treatment arms to see whether Codex actually used Cantus and keep these arms in the primary comparison regardless. Report paired token deltas only alongside exact-answer rates and disagreements. This pilot does not impose an inference-token budget and covers read-only questions. API edits and the full domain-agent and reviewer workflow need their own matched trials.

In the first live run on 19 November 2026, all 12 attempts stopped during Codex sandbox startup. Bubblewrap could not create a NETLINK_ROUTE socket. The run produced zero answers and zero usage events, so there is no scored agent performance result.
