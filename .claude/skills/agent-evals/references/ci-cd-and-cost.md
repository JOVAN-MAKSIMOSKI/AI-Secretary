# CI/CD Gating and Cost as an Eval Dimension

## Golden sets

A golden set is a fixed collection of representative inputs, each with either an expected output (for deterministic tasks) or, for agents, an expected tool sequence plus a minimum acceptable score per judge dimension. It runs on every prompt, model, or code change — this is what turns "I think this change is fine" into something checked automatically.

```python
GOLDEN_CASES = load_golden_cases("evals/golden_set.yaml")

@pytest.mark.parametrize("case", GOLDEN_CASES)
async def test_agent_regression(case):
    trace = await run_agent(case.input)

    heuristics = run_heuristic_checks(trace)
    assert heuristics.passed, f"Heuristic failure: {heuristics.checks}"

    judged = await judge_trajectory(trace)
    for dimension, floor in case.min_scores.items():
        assert judged[dimension] >= floor, (
            f"{dimension} scored {judged[dimension]}, below floor {floor}: "
            f"{judged['reasoning']}"
        )
```

**Growing the golden set without overfitting to it.** Every real production failure caught by Tiers 1–3 is a candidate golden-set addition — but a golden set that only ever grows becomes slow to run and can start rewarding an agent for memorizing specific cases rather than generalizing. Periodically prune cases that no longer discriminate (everything passes them trivially and has for months) and keep the set weighted toward intent types that actually matter in production traffic, not just whatever happened to break once.

**Handling non-determinism.** LLM outputs aren't perfectly reproducible between runs. Either run each golden case more than once and require a majority pass, or accept a small amount of judged-score variance (the tolerance in the human-review agreement check is a reasonable model for this) rather than treating any single flaky run as a hard regression. A gate that's too strict about run-to-run noise trains the team to ignore it, which defeats the entire point.

**Baselines are a deliberate commit, not an automatic update.** Store current baseline scores in the repo as a checked-in file, and fail the build if the aggregate score drops below it by more than a small tolerance. Updating that baseline file should always be its own visible diff — if a regression is accepted as an intentional tradeoff (a cheaper model, a faster but slightly less accurate prompt), that trade should be reviewable, not something that silently becomes the new normal because nobody looked.

## Cost and latency are eval dimensions, not afterthoughts

An agent that's 95% accurate but costs far more or runs far slower than a viable alternative isn't actually production-ready — cost-quality tradeoffs belong in the same evaluation rubric as correctness, not in a separate spreadsheet someone checks once a quarter. Frameworks built for enterprise agent evaluation explicitly track this as a first-class dimension alongside accuracy, not an afterthought bolted on post-launch.

Five concrete cost levers worth tracking as evaluation dimensions in their own right, not just optimization tasks to revisit later:

- **Model routing** — sending simple requests to a cheaper model instead of the frontier one for everything.
- **Context compaction** — summarizing or pruning context rather than carrying the full history on every call.
- **Prompt optimization** — cutting token overhead without degrading output quality.
- **Caching** — avoiding a repeat LLM call entirely for a repeated or near-duplicate request.
- **Judge cost itself** — the distilled-evaluator option from `judge-design.md` applies here too; the eval pipeline's own cost is worth measuring, not just the agent's.

## Why the rigor is worth it

Enterprise-scale surveys consistently find a large gap between agent pilots and agents that reach real production scale, and inadequate evaluation is repeatedly cited as a primary reason for that gap — not underlying model capability. A CI gate that only checks "does this look right in the cases I thought to try" is exactly the failure mode this whole pipeline exists to close.