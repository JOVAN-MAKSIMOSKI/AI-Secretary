---
name: aws-serverless-security
description: Use whenever reviewing, hardening, implementing, or auditing security for a serverless AWS application (Lambda, API Gateway, Aurora/RDS Data API, CloudFront), especially one built with Terraform. Covers IAM least-privilege policies, JWT/JWKS authentication, API Gateway throttling, CORS lockdown, CSP/XSS headers, AWS Secrets Manager, input validation, and enterprise add-ons like WAF, VPC endpoints, and GuardDuty. Trigger this any time the user asks to review security, harden an app or infra, add auth/rate-limiting/CORS/CSP, lock down IAM permissions, set up WAF/GuardDuty/VPC endpoints, asks "is this secure" or "what am I missing", or mentions a security audit, pentest, or compliance review of a Terraform, Lambda, or API Gateway project.
---

# AWS Serverless Security Hardening

Reference for securing a serverless AWS stack (Lambda + API Gateway + a relational data layer, deployed via Terraform). Use it two ways:

1. **Reviewing a project** — work through the checklist below, grep the actual Terraform/code for each control, and report what's present, what's missing, and what to prioritize.
2. **Implementing/hardening a project** — pull the relevant snippet and adapt the placeholders (`<project>`, resource names, region) to match the repo's real naming and module structure. None of these snippets are drop-in; they're templates.

**Related:** for AI agent/LLM-level safety (output validation, prompt injection, retry logic), see `ai-agent-guardrails` instead — this skill is scoped to infrastructure. For generating a CloudWatch log/timing monitor for Lambda-backed agents, see `agent-log-watcher`.

## Quick review checklist

Work through these in order. Grep for the resource types rather than relying on memory of what a repo contains — Terraform drifts from what a README claims:

| # | Control | What to look for |
|---|---|---|
| 1 | IAM least privilege | `aws_iam_role_policy` / `aws_iam_policy` blocks — any `Resource = "*"` or `Action = "*"` is a finding |
| 2 | Auth on every endpoint | JWT/session check wired into every route (an API Gateway authorizer, or middleware applied globally) — not just some handlers |
| 3 | Rate limiting | `throttling_rate_limit` / `throttling_burst_limit` on API Gateway stages or method settings |
| 4 | CORS | `cors_configuration` / CORS middleware — flag a wildcard origin combined with credentials |
| 5 | CSP / XSS headers | `Content-Security-Policy` in a meta tag or a CloudFront response-headers policy |
| 6 | Secrets | grep for hardcoded `AKIA`, plaintext DB passwords, or API keys in `.tf`/`.env`/source — should be `aws_secretsmanager_secret` references instead |
| 7 | Input validation | Pydantic/Zod/similar validators at the API boundary, not just constraints at the DB layer |
| 8 | WAF / GuardDuty / VPC endpoints | expected on production or compliance-driven stacks; absence elsewhere isn't automatically a finding — see the cost table below |

Rank findings by severity when reporting back, not just pass/fail — an IAM wildcard or a missing auth check matters far more than a missing WAF on a low-traffic internal tool.

---

## 1. IAM least privilege

Each Lambda gets its own role, scoped to exactly the actions and resources it calls. Never a shared "do everything" execution role, never `Resource = "*"`:

```hcl
resource "aws_iam_role_policy" "planner_policy" {
  name = "planner-policy"
  role = aws_iam_role.planner_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["rds-data:ExecuteStatement", "rds-data:BatchExecuteStatement"]
        Resource = "arn:aws:rds-db:*:*:cluster:<project>-database"
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = [
          "arn:aws:lambda:*:*:function:<project>-tagger",
          "arn:aws:lambda:*:*:function:<project>-reporter"
        ]
      }
    ]
  })
}
```

Common findings on review: one IAM role shared across every function in the stack, `Action = "*"` left in from getting something working quickly, or a policy that was scoped correctly at first but never updated as new resources were added.

## 2. Authentication (JWT / JWKS)

Two properties matter more than which auth provider is in use (the pattern below matches Clerk, Auth0, Supabase Auth, Cognito, and most other JWT providers):

- **Keys rotate without a redeploy.** Verify signatures against the provider's JWKS endpoint (its published public keys), not a public key hardcoded into the app. If a signing key is ever compromised, rotation happens on the provider's side and the app picks up new keys automatically on the next request.
- **Every request is checked, not just login.** Signature, expiry, and issuer should be re-verified on every API call — an expired or tampered token gets rejected before any business logic runs, not deep inside a handler after a DB round-trip.

Reasonable defaults: short-lived tokens (an hour is typical), a 401 returned immediately on a failed check, and no business logic executed before that check passes.

## 3. API Gateway throttling

Protects against both request floods and a misbehaving client running up the Lambda bill:

```hcl
resource "aws_api_gateway_method_settings" "throttle" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = aws_api_gateway_stage.main.stage_name
  method_path = "*/*"

  settings {
    throttling_rate_limit  = 100  # sustained requests/sec
    throttling_burst_limit = 200  # short burst above that
  }
}
```

(HTTP APIs use `aws_apigatewayv2_stage` with a `default_route_settings` block instead — same two fields, different resource.)

Treat 100/200 as a starting point, not a universal default — tune it against real traffic, and consider a usage plan with API keys if different clients need different limits.

## 4. CORS

Three things to check, roughly in order of how often they're gotten wrong:

- **Origin allowlist, not wildcard** — only the actual frontend domain(s), never `*` for any endpoint that also accepts credentials.
- **Wildcard + credentials is the dangerous combination.** Browsers block the literal wildcard-with-credentials case by spec, but a backend that echoes back whatever `Origin` header it received has the same hole in practice — check for that pattern specifically, since it looks like a working allowlist at a glance.
- **Preflight caching** (`Access-Control-Max-Age`) isn't a security control, but it's worth setting so OPTIONS overhead doesn't eat into the rate limits from the previous section.

## 5. CSP / XSS protection

A Content-Security-Policy header tells the browser which sources of scripts/styles/etc. are trusted, so an injected `<script>` tag from a stored-XSS bug simply won't execute:

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://<your-auth-provider>; style-src 'self' 'unsafe-inline';
```

Flag `'unsafe-inline'` on `script-src` specifically — it's a common shortcut that defeats most of the point of CSP against script injection. `'unsafe-inline'` on `style-src` is a much smaller risk and often unavoidable with CSS-in-JS, so it's a reasonable tradeoff to leave alone on a small app. If the frontend can move to nonce- or hash-based script sources, that's worth flagging as a real improvement.

## 6. Secrets management

Database credentials, API keys, and anything else sensitive belong in AWS Secrets Manager — not Terraform variables, `.env` files committed to the repo, or plaintext Lambda environment variables:

- Encrypted at rest with KMS by default.
- Supports automatic rotation — worth turning on specifically for database credentials.
- The Lambda's IAM role needs `secretsmanager:GetSecretValue` scoped to the specific secret ARN, not `*` — same least-privilege principle as section 1.

To find a secret while debugging: AWS Console → Secrets Manager → the project's region → look for a name following whatever convention the Terraform module uses (often `<project>-<resource>-secret`).

## 7. Input / parameter validation

Validate at the API boundary, before a request reaches business logic or the database — a passing type check ("it's a string") still lets malformed or malicious input through if there's no format check behind it:

```python
from pydantic import BaseModel, field_validator
import re

class PositionCreate(BaseModel):
    symbol: str

    @field_validator("symbol")
    @classmethod
    def validate_symbol(cls, v: str) -> str:
        if not re.match(r"^[A-Z]{1,5}$", v):
            raise ValueError("Invalid symbol format")
        return v
```

(Pydantic v1 codebases use `@validator("symbol")` without `@classmethod` instead — check which major version the project pins before pasting this in.)

The pattern generalizes past this one example: any field with a known shape — tenant IDs, phone numbers, enum-like strings, ticker symbols — deserves an explicit format check, not just a type check.

---

## 8. Enterprise add-ons — match to need, don't recommend by default

Real improvements, but all three cost money and add operational surface area. Reach for them based on what the app actually needs, not reflexively:

| Add-on | What it does | Cost | Worth it when |
|---|---|---|---|
| **AWS WAF** | Filters malicious requests (SQLi, XSS, bad bots) before they reach the app; rate-limits by IP | Priced per rule + per request | Public-facing, handles sensitive data, or has already seen abusive traffic |
| **VPC Endpoints** | Keeps Lambda-to-AWS-service traffic off the public internet | Free to create, ~$0.01/GB processed | Compliance requires no public-internet transit, or it's a regulated environment |
| **AWS GuardDuty** | ML-based threat detection over CloudTrail, VPC Flow Logs, and DNS logs — catches things like credential compromise or crypto-mining | ~$1/GB of logs analyzed | Multi-tenant, handles customer data, or is otherwise worth continuous monitoring |

WAF, with rate limiting plus the AWS-managed SQLi rule set (every `rule` block needs its own `visibility_config` — easy to forget and Terraform will reject the resource without it):

```hcl
resource "aws_wafv2_web_acl" "api_protection" {
  name  = "<project>-api-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "RateLimitRule"
    priority = 1
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    action {
      block {}
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitRule"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "SQLiRule"
    priority = 2
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesSQLiRuleSet"
      }
    }
    override_action {
      none {}
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "SQLiRule"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "<project>ApiWaf"
    sampled_requests_enabled   = true
  }
}
```

A web ACL does nothing until it's attached — add `aws_wafv2_web_acl_association` for a regional API Gateway stage, or set `web_acl_id` directly on the CloudFront distribution when `scope = "CLOUDFRONT"`.

VPC endpoint for Secrets Manager (Interface-type — S3 and DynamoDB use free Gateway-type endpoints instead, which only need a route table association rather than subnets/security groups). Assumes a `data "aws_region" "current" {}` block exists elsewhere in the module:

```hcl
resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true
}
```

GuardDuty is close to a one-block enable:

```hcl
resource "aws_guardduty_detector" "main" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}
```

---

## Writing up a review

Don't just hand the checklist back. Report:

1. **What's already solid** — briefly, don't over-explain controls that are already correctly implemented.
2. **Gaps, ranked by severity** — IAM wildcards and missing/partial auth checks outrank a missing WAF.
3. **Enterprise add-ons worth considering**, cost stated plainly, framed as "worth it if X" rather than a blanket recommendation.

Keep the tone matter-of-fact. Most of these are routine hardening steps, not five-alarm fires — treating a missing rate limit on a low-traffic side project as a crisis is its own kind of miscalibration.