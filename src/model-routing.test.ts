/**
 * Unit tests for the static provider resolution from OpenRouter routing
 * constraints.
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { certainRoutingProvider, routingConstraintFromModel } from "./model-routing.ts";

const model = (routing: unknown) => ({ compat: { openRouterRouting: routing } });

test("routingConstraintFromModel: reads the single `only` pin", () => {
  assert.deepEqual(routingConstraintFromModel(model({ only: ["fireworks"] })), {
    provider: "fireworks",
    allowFallbacks: true,
  });
  assert.deepEqual(routingConstraintFromModel(model({ only: ["Fireworks"], allow_fallbacks: false })), {
    provider: "Fireworks",
    allowFallbacks: false,
  });
});

test("routingConstraintFromModel: several pins or none are not a constraint", () => {
  assert.equal(routingConstraintFromModel(model({ only: ["a", "b"] }))?.provider, null);
  assert.equal(routingConstraintFromModel(model({ only: [] }))?.provider, null);
  assert.equal(routingConstraintFromModel(model({ only: [42] }))?.provider, null);
  assert.equal(routingConstraintFromModel(model({ only: "fireworks" }))?.provider, null);
  assert.equal(routingConstraintFromModel(model({}))?.provider, null);
});

test("routingConstraintFromModel: missing routing metadata", () => {
  assert.equal(routingConstraintFromModel({}), null);
  assert.equal(routingConstraintFromModel({ compat: {} }), null);
  assert.equal(routingConstraintFromModel({ compat: { openRouterRouting: "nope" } }), null);
  assert.equal(routingConstraintFromModel(undefined), null);
  assert.equal(routingConstraintFromModel("fireworks"), null);
});

test("certainRoutingProvider: only with fallbacks disabled", () => {
  assert.equal(certainRoutingProvider(model({ only: ["fireworks"], allow_fallbacks: false })), "fireworks");
  assert.equal(certainRoutingProvider(model({ only: ["fireworks"] })), null, "fallback may serve another provider");
  assert.equal(certainRoutingProvider(model({ only: ["fireworks"], allow_fallbacks: true })), null);
  assert.equal(certainRoutingProvider(model({ only: ["a", "b"], allow_fallbacks: false })), null);
  assert.equal(certainRoutingProvider({}), null);
});
