---
name: agent-evals
description: Use whenever building, reviewing, or hardening an evaluation pipeline for an AI agent or LLM-powered system — writing heuristic checks, designing an LLM-as-judge rubric, scoring agent trajectories (not just final outputs), running human calibration review, or wiring evals into CI/CD so a regression blocks deployment. Trigger this when the user mentions evals, evaluation suites, LLM-as-judge, scoring agent trajectories, judge bias, human annotation/calibration, golden sets, regression testing for prompts or agents, or asks how to know if a change to an agent made it better or worse.
---

# Agent Evaluation Pipeline

The three-tier architecture most teams converge on: cheap heuristic checks on every trace, an LLM judge sampled on a slice of traffic, and periodic human review that exists purely to catch the judge itself being wrong — wired into CI so a regression blocks deployment instead of shipping quietly.

Each tier trades cost for depth, and none of them substitutes for the others: heuristics alone will ship confidently broken reasoning, judging everything makes the eval bill rival the product bill, and skipping human review lets a biased judge quietly become the ground truth.

```
every trace ──► Tier 1: heuristics (100%, milliseconds, free)
                    │
                    ├─ failed? ──► always escalate to Tier 2
                    │
sampled 10-20% ──► Tier 2: LLM-as-judge (seconds, real cost)
                    │
small weekly slice ──► Tier 3: human review (calibrates Tier 2)
```

## Where the depth lives

This file stays high-level on purpose — pull the reference file for whichever tier is actually being worked on:

- **`references/heuristics-and-trajectories.md`** — Tier 1 check patterns, the full trajectory-representation and failure-mode taxonomy (looping, wrong tool, unsafe action, plan quality vs. adherence), and end-to-end / trajectory-level / component-level evaluation.
- **`references/judge-design.md`** — rubric and scoring-scale design, trajectory scoring dimensions, pointwise vs. pairwise judging, the five documented LLM-judge biases and their mitigations, and where off-the-shelf tooling (DeepEval, distilled judge models) saves you from hand-rolling this.
- **`references/human-review-and-calibration.md`** — Tier 3: what to sample, how to track human/judge agreement, and the feedback loop back into Tiers 1 and 2.
- **`references/ci-cd-and-cost.md`** — golden-set construction, the pytest-style gating pattern, handling non-determinism, and treating cost/latency as first-class eval dimensions rather than an afterthought.

## Build order

Don't build all three tiers at once:

1. **Tier 1 first.** Cheapest, catches the most obvious breakage, and produces the trace store Tier 2 samples from.
2. **Wire Tier 1 into CI immediately** — a golden set that only checks schema/tool-call correctness still catches real regressions before any judge exists.
3. **Add the judge once real production traces exist to sample.** Start the sample rate low (5–10%) and widen it once the rubric is trusted.
4. **Add human review last**, once judge scores exist to disagree with — calibrating a judge against nothing is just guessing.

## Why this matters more than it looks like it should

Enterprise surveys keep finding a large gap between AI pilots and things that actually reach production scale, and inadequate evaluation is consistently cited as a leading reason — not model quality itself. An agent that looks fine in a demo can still fail in ways a demo never exercises: wrong tool, a silent loop, a plan it doesn't actually follow. The eval pipeline is what turns "looked fine when I tried it" into something you can actually trust across thousands of unseen inputs.