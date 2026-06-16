---
name: skill-management
description: >
  Load this skill whenever working with Claude Code skills or instruction files in the
  AI-Secretary project. Triggers include: creating a new skill, editing an existing
  SKILL.md, expanding or updating any .md instruction file (CLAUDE.md, .claude/rules/*.md),
  completing a session where a skill was used, being asked to review a skill, auditing
  skills, or any task that touches .claude/skills/ or .claude/rules/. This skill
  encodes four mandatory protocols that must execute in their specified situations —
  do not skip any protocol step, even if it feels redundant.
---

# Skill Management — AI Secretary

This skill governs how skills and instruction files are created, tested, maintained,
and improved in this project. Four protocols are defined below. Each has a clear
trigger condition. When that condition is met, execute the full protocol — do not
summarize or skip steps.

---

## Protocol 1 — Knowledge Re-Sync After Any .md Expansion

**Trigger:** Jovan expands or edits any instruction file: `CLAUDE.md`, any file in
`.claude/rules/`, or any `SKILL.md`.

**Execute these steps in order:**

1. Read the updated file in full.
2. Identify what changed — new rules, modified rules, removed rules, or new sections.
3. Check `CLAUDE.md`'s Knowledge Architecture table:
   - If the changed file is not listed there, add it.
   - If its description in the table is now stale, update it.
4. Check whether any other instruction file contradicts the new content. If a
   contradiction exists, surface it explicitly: "Rule X in `guardrails.md` conflicts
   with the new rule in `database.md` — which takes precedence?"
5. Confirm to Jovan: "Knowledge re-synced. [List what was updated in the table or
   what contradictions were found, if any.]"

Do not proceed with unrelated work until this protocol completes.

---

## Protocol 2 — Skill Trigger Test After Creation

**Trigger:** A new Claude Code skill has just been created (a new `SKILL.md` file
was written or the skill-management skill was used to scaffold one).

**Execute these steps in order:**

1. Read the new skill's `description` field aloud as a complete sentence. Ask: does
   this sentence clearly answer "when should Claude use this skill?" If the answer
   requires interpretation, the description is too vague — rewrite it before testing.

2. Construct at least 3 test prompts that should trigger the skill:
   - One prompt that uses the exact domain terms from the description.
   - One prompt that describes the task without using the skill's name at all.
   - One edge-case prompt that is adjacent but should NOT trigger the skill.

3. Evaluate each prompt against the description as Claude would see it. Would the
   description make it unambiguous that this skill applies? Mark each: FIRES / AMBIGUOUS / DOES NOT FIRE.

4. If any "should trigger" prompt comes back AMBIGUOUS or DOES NOT FIRE:
   - Add more specific trigger phrases to the `description` field.
   - Add the exact phrasing patterns from the failing test prompts.
   - Re-evaluate until all "should trigger" prompts clearly FIRE.

5. Report to Jovan: show the test prompts, their results before and after any
   description changes, and the final description.

**Quality bar for a description:** reading it out loud should sound like a specific
answer to "when should Claude use this?" — not like a category label. "Use this when
creating or modifying MCP client setup, transport, or sampling flows" is a trigger.
"MCP architecture knowledge" is a category and will undertrigger.

---

## Protocol 3 — Post-Session Skill Enhancement Review

**Trigger:** A session that used a skill has ended, or Jovan explicitly says the task
involving a skill is complete.

**Execute these steps in order:**

1. Review the conversation that used the skill — look for:
   - Steps where Jovan corrected Claude's output or approach.
   - Steps where Claude had to ask a clarifying question that the skill should have
     pre-answered.
   - Steps where Claude produced something inconsistent with the project's patterns.
   - Any instruction Jovan gave mid-session that is not currently in the skill.

2. For each finding, propose a concrete enhancement:
   - If a correction was made — add the correct pattern to the skill with a note
     explaining why the wrong approach is tempting.
   - If a clarifying question was needed — add the missing context to the skill so
     it is pre-loaded next time.
   - If an inconsistency appeared — add an explicit rule that prevents it.

3. Present proposed additions to Jovan as a diff — show the exact text to be added
   and where in the skill it would go.

4. Only write changes to the `SKILL.md` file after Jovan approves the diff.

5. If no enhancements are warranted, say so explicitly: "Reviewed session — no skill
   gaps identified."

---

## Protocol 4 — Post-Creation Skill Audit

**Trigger:** Immediately after a new skill has been created and Protocol 2 (trigger
test) has passed.

**Execute these steps in order:**

### Step 1 — Determinism Audit
Read every step in the skill. For each step ask: is Claude being asked to interpret
something that is actually a fixed, repeatable operation?

Signs a step is non-deterministic when it should be deterministic:
- Claude is "deciding" something that has only one correct answer.
- Claude is "generating" something that is always the same format.
- A step says "check X" or "verify Y" where X and Y are computable from fixed inputs.

For each such step: propose replacing it with a script saved in the skill's `scripts/`
folder. The script handles the fixed logic; the skill step becomes "run `scripts/X.py`
and use the output."

### Step 2 — Composability Audit
Read every other skill in `.claude/skills/`. For each existing skill ask: does the
new skill duplicate logic that already exists in it?

Duplication signals:
- Same guardrail rules restated in different words.
- Same checklist items appearing in multiple skills.
- Same code patterns documented in more than one place.

For each duplication found: flag it explicitly — "This rule in `new-skill` already
exists in `mcp-architecture`. Consider: (a) removing it from `new-skill` and adding
a cross-reference, or (b) extracting it into a shared `references/` file both skills
import."

### Step 3 — Changelog
After completing Steps 1 and 2, produce a changelog:

```
## Skill Audit — [skill-name] — [date]

### Determinism findings
- [Step name]: [what was non-deterministic] — [proposed fix or "no action needed"]

### Composability findings
- [Duplicate rule]: found in [skill-a] and [skill-b] — [proposed resolution]

### Changes made (after approval)
- [Exact change] — Reason: [why]
```

Present the changelog to Jovan. Only apply changes after approval.
