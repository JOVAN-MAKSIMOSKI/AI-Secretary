---
name: ai-agent-guardrails
description: Use whenever building, reviewing, or hardening guardrails for an AI agent or LLM-powered system, regardless of framework (LangGraph, OpenAI Agents SDK, CrewAI, custom). Covers validating an agent's structured output (JSON schema, required fields, safe fallbacks) before downstream code trusts it, sanitizing input against prompt injection, capping response size to control token/cost blowout, and adding retry-with-backoff for agent, tool, or Lambda invocations that hit rate limits or timeouts. Trigger this any time the user mentions guardrails, agent safety, prompt injection, an agent producing malformed or unparseable output, protecting downstream code from bad model output, agents going off the rails, or adding resilience/retry logic to agent invocations.
---

# AI Agent Guardrails

Guardrails are validation checks in code that run before or after an agent executes — no special framework required, even if the framework in use has its own version of some of these. Two moments matter: catching bad input before it reaches the agent, and catching bad output before it reaches a user or a downstream system. The four patterns below cover both.

## 1. Validating agent output before you trust it

Define the exact shape expected back — required keys, types, and per-variant fields — and check it before any downstream code (a chart renderer, a database write, a message sent to a user) touches it. An agent can return syntactically valid JSON that's still structurally wrong for what was asked, so `json.loads()` succeeding isn't the same as the output being usable.

```python
import json
import logging
from typing import Any

logger = logging.getLogger()

def validate_chart_data(chart_json: str) -> tuple[bool, str, dict[str, Any]]:
    """
    Validates that a chart-generating agent's output is well-formed JSON
    with the expected structure. Returns (is_valid, error_message, parsed_data).
    """
    try:
        data = json.loads(chart_json)

        required_keys = ["charts"]
        if not all(key in data for key in required_keys):
            return False, f"Missing required keys. Expected: {required_keys}", {}

        if not isinstance(data["charts"], list):
            return False, "Charts must be an array", {}

        for i, chart in enumerate(data["charts"]):
            if "type" not in chart:
                return False, f"Chart {i} missing 'type' field", {}
            if "data" not in chart:
                return False, f"Chart {i} missing 'data' field", {}
            if not isinstance(chart["data"], list):
                return False, f"Chart {i} data must be an array", {}

            # Per-variant validation — each chart type has its own required fields
            if chart["type"] == "pie":
                for point in chart["data"]:
                    if "name" not in point or "value" not in point:
                        return False, "Pie chart data points must have 'name' and 'value'", {}
            elif chart["type"] == "bar":
                for point in chart["data"]:
                    if "category" not in point:
                        return False, "Bar chart data points must have 'category'", {}

        return True, "", data

    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON from agent: {e}")
        return False, f"Invalid JSON: {e}", {}
    except Exception as e:
        logger.error(f"Unexpected error validating output: {e}")
        return False, f"Validation error: {e}", {}
```

Wire it in with a defined fallback, not a crash or a silent pass-through of bad data:

```python
async def run_charter_agent(job_id: str, portfolio_data: dict, db=None) -> dict:
    # ... existing agent invocation — Runner.run(), graph.ainvoke(), whatever the framework calls it ...
    result = await invoke_agent(agent, input=task)

    is_valid, error_msg, parsed_data = validate_chart_data(result.final_output)
    if not is_valid:
        logger.error(f"Agent produced invalid output for job {job_id}: {error_msg}")
        return json.dumps({"charts": [], "error": "Unable to generate charts at this time"})

    return json.dumps(parsed_data)
```

The pattern generalizes past charts: any agent whose output feeds a UI, a database, or another agent deserves this same validate-or-fallback wrapper. The schema changes; the shape of the check doesn't.

## 2. Sanitizing input against prompt injection

A keyword blocklist like the one below catches the laziest injection attempts, but treat it as a first-pass filter, not a defense. Every phrase on that list can be defeated by rephrasing, translating, encoding, or splitting across turns — and injected content doesn't only arrive through a "user input" box. Retrieved documents, tool outputs, and API responses the agent reads all carry the same risk.

```python
def sanitize_user_input(text: str) -> str:
    """Cheap first-pass filter for the most obvious injection attempts."""
    dangerous_patterns = [
        "ignore previous instructions",
        "disregard all prior",
        "forget everything",
        "new instructions:",
        "system:",
        "assistant:"
    ]
    text_lower = text.lower()
    for pattern in dangerous_patterns:
        if pattern in text_lower:
            logger.warning(f"Potential prompt injection detected: {pattern}")
            return "[INVALID INPUT DETECTED]"
    return text
```

What actually limits the damage from injection that gets past this filter:

- **Keep untrusted text as data, never as instructions.** Don't concatenate user input, tool results, or retrieved documents into the same string as a system prompt in a way that blurs the boundary — pass them as clearly delimited content the model is told to treat as data, not commands.
- **Constrain what the agent can actually do, independent of what it's told.** An injected instruction to "transfer all funds" or "email everyone" is only dangerous if the agent can do that without a check — an approval gate or capability restriction on consequential actions matters more than catching every phrasing of an attack.
- **Log matches and watch them**, but don't treat a clean pass through the filter as "safe" — it only means this particular attempt didn't use one of the phrases on the list.

## 3. Capping response size

Protects against runaway token usage and cost, and keeps oversized payloads from hitting whatever's downstream:

```python
def truncate_response(text: str, max_length: int = 50000) -> str:
    """Ensure responses don't exceed a reasonable size."""
    if len(text) > max_length:
        logger.warning(f"Response truncated from {len(text)} to {max_length} characters")
        return text[:max_length] + "\n\n[Response truncated due to length]"
    return text
```

This is a blunt instrument — slicing a string at a character count doesn't know whether it's about to cut through the middle of a JSON structure. If the output needs to stay parseable, validate it first (section 1) rather than truncating ahead of the parse, or better, cap length upstream with `max_tokens` on the generation call so there's rarely anything to truncate after the fact. Post-hoc truncation is the right tool for free-text responses that are only ever displayed, not parsed.

## 4. Retry with backoff for transient failures

Not every agent or Lambda invocation failure is worth retrying. A rate limit or a timeout will probably succeed on the next attempt; a validation error or malformed-input error will fail identically every time, so retrying it three times just burns latency — and money, if each attempt is a billed invocation or model call — for the same result. Scope retries to the exception types that are actually transient:

```python
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
import json
import logging

logger = logging.getLogger()

class AgentTemporaryError(Exception):
    """Raised for errors worth retrying — rate limits, timeouts, transient failures."""
    pass

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_exception_type((AgentTemporaryError, TimeoutError))
)
async def invoke_agent_with_retry(agent_name: str, payload: dict) -> dict:
    """Invoke a Lambda-backed agent with automatic retry on transient failures."""
    try:
        response = await lambda_client.invoke(
            FunctionName=f"<project>-{agent_name}",
            InvocationType="RequestResponse",
            Payload=json.dumps(payload)
        )
        result = json.loads(response["Payload"].read())

        if result.get("error_type") == "RATE_LIMIT":
            raise AgentTemporaryError(f"Rate limit hit for {agent_name}")

        return result

    except Exception as e:
        logger.warning(f"Agent {agent_name} invocation failed: {e}")
        if "throttled" in str(e).lower() or "timeout" in str(e).lower():
            raise AgentTemporaryError(f"Temporary error: {e}")
        raise  # not transient — don't retry, let it propagate
```

`wait_exponential(multiplier=1, min=2, max=10)` waits 2s, then 4s, then holds at a 10s ceiling between attempts — tune the ceiling to whatever timeout budget the caller has. If tenacity is already in the project for rate-limit handling elsewhere, this is the same dependency, just a second decorator applied to agent invocations specifically.

---

## Putting it together

These four compose into one request-handling pipeline rather than four independent add-ons:

1. **Sanitize input** before it reaches the agent — cheap filter, first pass only.
2. **Invoke the agent** wrapped in retry-with-backoff, scoped to genuinely transient errors.
3. **Validate the output's shape** before anything downstream touches it.
4. **On validation failure, return a defined fallback** — never propagate a malformed payload or let an exception surface as a raw 500.
5. **Cap size** for anything free-text that could run long, ideally at generation time rather than after the fact.

None of these guarantee safety on their own — they're layers, and the goal is that a failure at any one layer doesn't reach a user or a downstream system unchecked.

**Related:** for AWS/Terraform infrastructure-level hardening (IAM, secrets, WAF, rate limiting at the API Gateway layer), see `aws-serverless-security` instead. For generating a CloudWatch log/timing monitor for Lambda-backed agents, see `agent-log-watcher`.