import test from 'node:test';
import assert from 'node:assert/strict';

import { getChainRegistry } from './chainRegistry.js';
import { resolveChainWithLlm } from './llmResolver.js';

test('resolver selects invoice extraction from invoice prompt', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const decision = await resolveChainWithLlm(
    'Please create an invoice for client ACME with 10 units and tax 18%',
    getChainRegistry(),
  );

  if (previous) {
    process.env.ANTHROPIC_API_KEY = previous;
  }

  assert.equal(decision.chainId, 'invoice_extraction');
});

test('resolver selects offer extraction from offer prompt', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const decision = await resolveChainWithLlm(
    'Prepare an offer proposal for a yearly maintenance package',
    getChainRegistry(),
  );

  if (previous) {
    process.env.ANTHROPIC_API_KEY = previous;
  }

  assert.equal(decision.chainId, 'offer_extraction');
});

test('resolver selects calendar event extraction from scheduling prompt', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const decision = await resolveChainWithLlm(
    'Schedule a meeting with Tom tomorrow at 14:00 for 45 minutes',
    getChainRegistry(),
  );

  if (previous) {
    process.env.ANTHROPIC_API_KEY = previous;
  }

  assert.equal(decision.chainId, 'calendar_event_extraction');
});
