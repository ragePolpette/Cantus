# Compare the same coding workflow with and without Cantus

Measure the full workflow from discovery to the final verification. The L1 caller benchmark measures static reference quality and does not answer this question.

Use a pinned Cantus commit, pinned repositories, the same runtime version, model, reasoning effort, time cap and usage limits in both arms. Create fresh worktrees and sessions for every trial. Alternate which arm runs first and record the order. The only treatment is access to Cantus and the instructions needed to use it.

Start with tasks on at least two repositories. Include API changes with callers across blocks, impact questions with independently prepared answers, and a task that should fail a gate. Keep the initial prompt and evaluation criteria identical across arms. Use at least three paired repetitions per task. Record the repository commit, exact prompt and pass criteria before the first run.

For each arm, record pass/fail, independently verified defects and omissions, input tokens, cached input tokens, output tokens, elapsed time, retries and actual billed cost when available. Count every model call made by the domain and verification agents. Cached input is a subset of input. Missing usage is unknown. Use test results and review of anonymized diffs where possible. Record environment failures separately from task failures and retain unsuccessful attempts.

Evaluate both hypotheses independently.

- Token saving requires comparable quality and fewer total input plus output tokens on paired trials. Compare outcomes first. Report the paired median and spread with the number of trials that support it.
- Quality gain requires a better verified outcome within the same predetermined usage budget. Compare success rates and concrete defect counts. Post-hoc removal of long or failed runs invalidates this comparison.

Publish raw measurements and task definitions alongside any claim. Set the minimum useful effect before the scored run. This protocol has no scored agent-workflow results yet.
