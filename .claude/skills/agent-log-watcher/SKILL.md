---
name: agent-log-watcher
description: Use whenever the user wants a script to tail or watch CloudWatch Logs from several Lambda-backed agents at once in a terminal, especially one that reports per-invocation timing (how long each agent took, in ms and seconds). Trigger this for requests like a "watch_agents.py" script, a live log tailer/monitor across multiple Lambda functions, wanting to see execution duration per agent, color-coded multi-agent log output, or "simple monitoring" for a set of agents deployed as Lambda functions.
---

# Agent Log Watcher

Generates a `watch_agents.py`-style CLI script: tails CloudWatch Logs from several Lambda-backed agents at once, color-coded per agent, with per-invocation duration parsed straight from Lambda's own `REPORT` log line. No application code changes are needed to get timing — Lambda emits this automatically after every invocation.

Full template: `assets/watch_agents_template.py`. It's already syntax-checked and its regex/formatting logic is verified against sample log lines — treat it as correct and focus effort on the project-specific customization below, not on rewriting the polling/formatting internals.

## Before generating anything: find the real agent list

The `AGENTS` dict in the template is a placeholder. Work out the project's actual Lambda function names before writing the file — check `aws_lambda_function` resources in Terraform, an existing agent registry or config file, or `aws lambda list-functions` if credentials are available in the environment. Ask the user directly if none of that resolves it.

Getting this wrong is a quiet failure mode worth flagging: point the watcher at log group names that don't exist and it just reports "no invocations observed" forever, which reads like a bug rather than a naming mismatch. Confirm the names, don't guess them.

## Generating the file

1. Start from `assets/watch_agents_template.py`.
2. Replace `AGENTS` with the real `label: lambda_function_name` pairs for this project — any number of agents works, not just five. The color palette and thread pool both size themselves off the dict automatically.
3. Set `DEFAULT_REGION` to wherever those functions actually run.
4. Write the result wherever the user wants it (commonly a `scripts/` folder in the repo).

Everything else in the template — the color palette, the `REPORT`-line timing parser, the threaded polling loop, the end-of-session summary — works unchanged regardless of which agents get plugged in.

## How the timing works

Lambda automatically appends a line like this to CloudWatch Logs after every invocation:

```
REPORT RequestId: 8a1af80f-...  Duration: 842.31 ms  Billed Duration: 843 ms  Memory Size: 512 MB  Max Memory Used: 256 MB
```

`REPORT_PATTERN` pulls `Duration` off that line and prints it in both units — `0.84s (842ms)` — and flags a cold start when `Init Duration` is present (cold starts run slower than steady-state, so a duration spike that's actually just a cold start shouldn't read as a regression). This is more reliable than diffing `START`/`END` log timestamps by hand: `Duration` comes from Lambda's own internal clock, not from whenever CloudWatch happened to receive and index the log line, so it isn't affected by log-delivery lag.

On Ctrl+C, the watcher also prints a short summary — call count and average/min/max duration per agent — since a scrolling terminal is a poor place to eyeball an average by hand. This is meant to answer "which agent is slow, right now" at a glance, not to replace real metrics (CloudWatch Metrics, X-Ray, or whatever the project already uses for that).

## Where this stops applying

If some of the project's "agents" aren't actually Lambda functions (a long-running container, a Fargate task, a plain server process), `REPORT` lines won't exist for them — timing for those has to come from whatever the application logs at its own start/end instead. Flag this rather than silently pointing the Lambda-specific parser at a log group that will never produce a match.

**Related:** for guardrails on what an agent actually does with its output, see the `ai-agent-guardrails` skill. For the infrastructure those agents run on, see `aws-serverless-security`. For turning the per-invocation duration this skill parses into a proper evaluation dimension (not just a log line), see `agent-evals`.