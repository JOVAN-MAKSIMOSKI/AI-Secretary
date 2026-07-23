# Heuristics and Trajectory Evaluation

## Tier 1 heuristic checks — categories worth covering

Heuristics are deterministic assertions, not model calls. Cover at least these four categories, not just schema validity:

- **Structural** — is the output valid JSON/whatever format is expected, do required fields exist, are types correct. If the project already validates model output before trusting it downstream, that validator *is* a Tier-1 check — just make sure its pass/fail result gets logged to the trace store, not only used for the fallback decision.
- **Performance** — latency within budget, token count within budget.
- **Tool-call correctness** — did every tool call succeed (no error field in the result), was the expected tool called for a given intent, were arguments well-formed before the call was made.
- **Safety/policy** — did the agent take an irreversible action without whatever approval gate the project requires; did it call a tool it shouldn't have access to for this tenant/user.

```python
from dataclasses import dataclass

@dataclass
class HeuristicResult:
    passed: bool
    checks: dict[str, bool]

def run_heuristic_checks(trace: "AgentTrace") -> HeuristicResult:
    checks = {
        "output_is_valid_json": is_valid_json(trace.final_output),
        "latency_within_budget": trace.duration_ms < 10_000,
        "no_tool_errors": all(
            step.tool_result.get("error") is None for step in trace.steps
        ),
        "expected_tool_called": (
            trace.intent != "refund"
            or any(step.tool_name == "process_refund" for step in trace.steps)
        ),
        "no_immediate_repeat_call": not any(
            a.tool_name == b.tool_name and a.tool_args == b.tool_args
            for a, b in zip(trace.steps, trace.steps[1:])
        ),
        "irreversible_action_had_approval": all(
            not step.tool_is_irreversible or step.had_human_approval
            for step in trace.steps
        ),
    }
    return HeuristicResult(passed=all(checks.values()), checks=checks)
```

Run this synchronously in the request path so a failure can trigger the guardrails-skill fallback immediately, and log the result regardless of outcome — the aggregate pass rate per check, over time, is itself a useful dashboard, and a check that starts failing more often than usual is often the first signal that something upstream changed (a tool's response shape, a new intent type nobody wrote a rule for).

**False positives are a real failure mode of this tier too.** A heuristic that's too strict blocks genuinely good outputs and either erodes trust in the eval system or gets quietly disabled. Treat a heuristic's own false-positive rate (cases a human later confirms were actually fine) as something to track via Tier 3, the same way you'd track a judge's accuracy.

## Trajectory representation

A trajectory is the full sequence of steps an agent took, not just its final answer — this is the data structure both the judge (in `judge-design.md`) and the heuristics above operate on:

```python
from dataclasses import dataclass, field

@dataclass
class TrajectoryStep:
    tool_name: str
    tool_args: dict
    tool_result: dict
    reasoning: str | None = None
    tool_is_irreversible: bool = False
    had_human_approval: bool = False

@dataclass
class AgentTrace:
    task: str
    intent: str
    steps: list[TrajectoryStep] = field(default_factory=list)
    final_output: str = ""
    duration_ms: float = 0.0
    heuristic_result: "HeuristicResult | None" = None
```

## The trajectory failure-mode taxonomy

An agent evaluation that only looks at the final output misses all of these — they're specific to scoring the *path*, and each one needs a distinct check or judge question, not one generic "was this good" rating:

- **Action looping** — the same tool call, or the same reasoning text, repeats without progress. A cheap heuristic catches exact repeats (see `no_immediate_repeat_call` above); a judge is needed for near-duplicate reasoning that isn't a literal string match.
- **Wrong tool selection** — a tool was called that wasn't the right one for the situation, even if the final answer happened to come out fine anyway. This is exactly the "right for the wrong reasons" case — it passes today and breaks the moment the input shifts slightly, because the agent didn't actually reason its way to the right tool.
- **Unsafe intermediate action** — something irreversible or high-consequence happened mid-trajectory that never surfaces in the final output at all (a heuristic can catch "was there approval," only a judge or human can catch "should this have needed approval that the rule didn't anticipate").
- **Non-recovery from a tool error** — the agent hit a tool failure and didn't retry, didn't fall back, and didn't surface the failure honestly — it either gave up silently or fabricated a result as if the call had succeeded.
- **Plan quality vs. plan adherence** (for agents that plan before executing) — these are two separate, independent failure surfaces. An agent can have a good plan it doesn't follow — improvising mid-execution, sometimes successfully but unpredictably — or a bad plan it follows faithfully all the way to a confidently wrong answer. Score them separately; a single "was the outcome good" number conflates two different bugs with two different fixes.

## Three levels of evaluation

Structure the whole pipeline around three levels, not just "pass or fail":

- **End-to-end** — did the task actually succeed, from the user's perspective.
- **Trajectory-level** — was the path taken efficient and sound, independent of whether it happened to arrive at a correct answer anyway.
- **Component-level** — which specific piece broke: a particular tool, a specific sub-agent in a multi-agent setup, a retriever returning bad context. This is what actually lets a failing eval turn into a specific, fixable bug report instead of a vague "the agent got worse this week."

Wiring traces through an observability/tracing layer (Langfuse, Phoenix, or whatever the project already uses) is what makes component-level attribution possible — without span-level tracing, a trajectory failure tells you *that* something broke, not *where*.