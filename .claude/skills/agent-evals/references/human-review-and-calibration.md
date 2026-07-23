# Human Review and Calibration

## The point of this tier

Tier 3 isn't meant to catch more bugs than the judge does — it exists to catch the judge being wrong, and to keep the whole pipeline honest as the agent, the traffic mix, and the judge model itself all drift over time. Skip this tier and there's no way to tell the difference between "the agent got better" and "the judge got more lenient."

## What to sample

Don't sample purely at random — a fixed weekly quota (even 20–30 traces) covers baseline drift, but layer on top of it:

- Every case where a heuristic and the judge disagreed (heuristic passed, judge scored low, or vice versa).
- Every borderline judge score — near a CI gate's pass/fail threshold is exactly where a wrong judge call has the most consequence.
- A stratified sample across intent types, not just overall volume — a high-volume, easy intent will otherwise dominate the sample and a rare-but-important one (refunds, anything irreversible) will never get reviewed at all.

## Tooling — start minimal

This doesn't need dedicated software to begin. A spreadsheet with the trace ID, the judge's score and its stated reasoning, and a column for a human score is a completely legitimate v1. Build a real review queue only once volume makes the spreadsheet the bottleneck, not before.

## Tracking agreement

Track human/judge agreement the same way a model's accuracy would be tracked — as a number that moves over time, not a one-off spot check:

```python
def agreement_rate(reviewed: list[dict], tolerance: float = 1.0) -> float:
    """Fraction of reviewed cases where human and judge scores are within `tolerance`."""
    agreements = sum(
        1 for r in reviewed
        if abs(r["human_score"] - r["judge_score"]) <= tolerance
    )
    return agreements / len(reviewed) if reviewed else 0.0
```

A dropping agreement rate is a signal to recalibrate the judge prompt or rubric — it is *not*, on its own, evidence that production quality suddenly got worse. Those two things are easy to conflate, and conflating them is exactly how a team ends up debugging the wrong system.

## The feedback loop

Human review is only worth the cost if it actually changes something downstream:

- A failure pattern a human catches repeatedly, that neither the heuristics nor the judge is reliably flagging, becomes a new Tier-1 heuristic — the cheapest possible fix, since it now runs on 100% of traffic for free instead of relying on a 10–20% sample catching it by chance.
- A systematic judge blind spot (the judge consistently missing a specific kind of error, not just occasional noise) becomes a rubric edit or an added explicit scoring dimension — and per the calibration-drift point in `judge-design.md`, any such edit should bump the rubric version, not silently overwrite the same prompt string.
- If disagreement clusters around one intent type or one tool specifically, that's a signal the judge's context for that case is insufficient — it may need more of the trajectory, or a different scoring dimension entirely, not just "try again with a stronger model."

## When to escalate beyond periodic sampling

If irreversible or high-consequence actions are involved (financial transactions, anything the project's own guardrails flag as requiring human approval), consider reviewing 100% of those specific cases rather than sampling — the cost of a human review is small relative to the cost of an unreviewed mistake in that category, even if the overall sampling rate elsewhere stays low.