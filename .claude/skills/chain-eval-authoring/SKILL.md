---
name: chain-eval-authoring
description: Use whenever a chain is added to or renamed in apps/agent/src/agent/nodes/chainRegistry.ts, or whenever golden routing eval cases need to be written, expanded, or reviewed for the AI-Secretary agent. Trigger this when the user adds a new chain, asks to write or generate evals or golden cases for a chain, hits a Gate A failure reading "Chains without enough golden cases", sees one chain's per-chain routing accuracy drop below its floor, or asks how to test that a new chain routes correctly without breaking the existing ones.
---

# Authoring Golden Routing Cases

Every chain in `chainRegistry.ts` needs at least `MIN_GOLDEN_CASES_PER_CHAIN` cases in
`apps/agent/src/evals/golden/routing.jsonl` or the offline eval fails the build. This
skill covers writing those cases well — the coverage arithmetic is already handled by a
script, so spend the effort on case quality instead.

## Step 1 — Run the coverage script, do not eyeball the file

```bash
pnpm --filter agent eval:coverage
```

It prints per-chain counts, which chains are short and by how many, every sibling chain's
description (needed for step 3), and the existing case ids so a new one does not collide.
Exit code 1 when any chain is short. Do not count cases by hand.

## Step 2 — The four-case shape

Four is the minimum because it is the smallest count where the `perChainAccuracy` floor
of 0.75 means "one miss tolerated, two misses fails the build." Three cases would make a
single miss (0.667) fail; two would make the floor meaningless. **If `perChainAccuracy`
in `baseline.json` changes, `MIN_GOLDEN_CASES_PER_CHAIN` has to be reconsidered with it —
they are one decision, not two.**

Fill these four slots, in this order:

1. **Canonical Macedonian** — the plainest way a real user states this intent. This is
   the smoke test; if it fails, the chain is broken for most traffic.
2. **Canonical English** — same intent, other language. Chain descriptions are written in
   English, so a chain can route English well and Macedonian poorly. Without this pair the
   regression is invisible.
3. **Boundary against a sibling** — a message that plausibly belongs to a *neighbouring*
   chain, that must land here. Use the sibling descriptions the script printed. This is the
   only slot that reliably catches anything; the canonical cases pass almost always.
4. **No-keyword phrasing** — states the intent without the obvious trigger word ("bill
   Nikola for three days" rather than "create an invoice"). `keywords[]` is dead under the
   keyword-fallback-disabled policy, so routing must work from meaning alone. This slot is
   what proves it does.

Beyond the four, add a **prompt-injection case** for any chain reachable from user-typed
input: the intent of one chain plus an embedded instruction to pick a different one.
`llmResolver.ts` wraps user input in `<<<USER_INPUT>>>` delimiters specifically to defeat
this, and nothing else tests that guard.

## Step 3 — The circularity trap

**A case drafted from a chain's own description can only prove the router agrees with
whoever wrote the description.** It cannot detect that the description misdescribes what
users actually type. That gap is real: `invoice_extraction` reads as "extract invoice
fields," while a user writes "I need to bill for the waste transport we did last week" —
and the router followed the topic (waste) instead of the intent (bill someone).

So when drafting:

- Write boundary cases against the **sibling** descriptions, not the target's own.
- Phrase from the user's situation, not from the description's vocabulary.
- Never let generated cases be the only cases for a chain.

Mark provenance with the `source` field — `"human"`, `"generated"`, or `"production"`:

```jsonc
{"id": "law-mk-permit", "message": "…", "expect": "waste_law_query", "minConfidence": 0.6, "source": "human"}
```

`"production"` cases — derived from a real mis-route someone hit — are the highest-value
kind. Every real failure is a candidate case. Add it as one.

## Step 4 — Confidence floors

Set `minConfidence` to 0.6 for canonical cases and 0.5 for boundary and injection cases,
where genuine ambiguity should not be punished. A floor above the model's honest
confidence turns a correct route into a failure and teaches everyone to ignore the gate.

## Step 5 — Human review is required, not optional

Generated cases are a scaffold. Before committing, the user reads every new case and
confirms it is something a real customer would plausibly type. A case nobody would ever
send tests nothing and still costs an API call on every CI run.

## Step 6 — Verify, then decide about the baseline

```bash
pnpm --filter agent eval:offline    # coverage now satisfied
pnpm --filter agent eval:routing    # live routing, real API calls
```

Read the **per-chain** numbers, not just the total. Adding a chain most often breaks a
*neighbouring* chain by stealing its traffic, and the overall average hides that.

Raising `overallAccuracy` in `baseline.json` after a green run is how gains get locked in
— but it is a deliberate, separately reviewable commit, never a silent edit bundled with
the cases that caused it. Lowering it is accepting a regression and needs the same
visibility.

## Where this stops applying

This skill covers **routing only** — which chain a message is sent to. It does not cover
whether the chain then extracts the right fields, renders the right document, or returns a
correct answer. A chain can route perfectly and still produce a wrong invoice total. Say so
plainly rather than implying a green routing eval means the chain works.
