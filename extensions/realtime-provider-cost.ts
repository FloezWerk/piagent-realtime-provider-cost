/**
 * realtime-provider-cost
 *
 * Shows the effective token prices (input/output, per 1M tokens) of the
 * provider/model of the **last** API call in the status bar.
 *
 * - Prices are derived from the amount OpenRouter actually billed (effective
 *   price, including tiers/service tier/routing), not from the static catalogue.
 *   Preferred source is the prompt/completion split that amount comes with
 *   (`usage.cost_details`, see `src/rates.ts`); the endpoint prices of the serving
 *   provider are only the fallback split basis (and weight cached prompt tokens).
 * - The provider tag shows the provider *inside* OpenRouter that served the call.
 *   Resolution order:
 *     1. the response itself: `provider_stream_event` carries `provider` on every
 *        chunk and the billed amount plus its split in the final one (no request,
 *        per response)
 *     2. routing constraint `openRouterRouting.only` from models.json (static)
 *     3. persistent provider cache (last known value)
 *     4. generation API (only for the last call of a restored session)
 * - Converted into the configured currency, mirroring pi-powerline-footer.
 * - The extension is self-contained: without pi-powerline-footer the value
 *   appears as its own footer line; with Powerline it can be placed next to the
 *   cost sum via `customItems`/`statusKey`.
 *
 * Status channel: `realtime-provider-cost` (via `ctx.ui.setStatus`).
 * Settings root key: `realtime-provider-cost` in `~/.pi/agent/settings.json`.
 *
 * Note: all user-facing output, settings and docs are English (see AGENTS.md).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";

import { COLOR_NAMES, colorize, normalizeColorSpec } from "../src/color.ts";
import { ensureRatesLoaded, getRate, refreshRates } from "../src/currency.ts";
import { composeStatus, roundToDisplay, type PriceColors } from "../src/format.ts";
import { ICON_MODES, normalizeIconMode } from "../src/icons.ts";
import {
  clearPricingCache,
  getProviderPricing,
  pricingForPromptTokens,
  type EndpointPricing,
  type ProviderPricingMap,
} from "../src/endpoint-pricing.ts";
import { certainRoutingProvider } from "../src/model-routing.ts";
import {
  deviationColorSpec,
  type DeviationThresholds,
  snapshotFromBranch,
  snapshotFromMessage,
  snapshotFromModel,
  upstreamTag,
  type ModelRegistryLike,
  type ProviderSource,
  type RateSnapshot,
} from "../src/pricing.ts";
import { providerCache } from "../src/provider-cache.ts";
import { deriveRealRates, effectiveBilledCost, ratesFromCostSplit } from "../src/rates.ts";
import {
  SESSION_COST_BASES,
  normalizeSessionCostBasis,
  patchedCost,
  sessionCostAmountFor,
  type UsageCostLike,
} from "../src/session-cost.ts";
import {
  DEFAULT_SETTINGS,
  DEVIATION_STYLES,
  STATUS_KEY,
  SUPPORTED_CURRENCIES,
  loadSettings,
  normalizeCurrency,
  normalizeDeviationStyle,
  saveSettings,
  type DeviationStyle,
  type ExtensionSettings,
} from "../src/settings.ts";
import { StreamCallBuffer, type StreamCallInfo } from "../src/stream-usage.ts";
import { lookupOpenRouterGeneration } from "../src/upstream.ts";

const COMMAND_NAME = "provider-cost";

/** Registry facade as far as this extension needs it. */
interface RegistryFacade extends ModelRegistryLike {
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export default async function realtimeProviderCost(pi: ExtensionAPI): Promise<void> {
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  let snapshot: RateSnapshot | null = null;
  let cacheLoaded = false;

  /**
   * Set when a serving-provider switch was detected. Everything rendered for the
   * current call is drawn in `switchColor` (yellow by default); the next call
   * resets it, so the highlight is a one-shot hint.
   */
  let switchHighlight = false;

  /**
   * False once the extension is torn down (quit, reload, session replacement).
   * Resolutions run asynchronously and can outlive the session - rendering then
   * uses a stale ctx, which Pi rejects (and an unhandled rejection would end a
   * non-interactive run with a stack trace).
   */
  let active = true;

  /** Serving data of the running call, filled from the provider stream. */
  const streamCalls = new StreamCallBuffer();

  function registry(ctx: ExtensionContext): RegistryFacade | undefined {
    return ctx.modelRegistry as unknown as RegistryFacade | undefined;
  }

  async function ensureCacheLoaded(): Promise<void> {
    if (cacheLoaded) return;
    cacheLoaded = true;
    await providerCache.load();
  }

  /** Current status text (coloured), or null when the item should be hidden. */
  function currentText(): string | null {
    if (!settings.enabled || !snapshot || snapshot.subscription) return null;

    const icons = settings.icons;
    const rate = getRate(settings.currency);

    // A detected provider switch overrides everything: the whole item is drawn
    // in the switch colour, so the deviation colours do not apply to that prompt.
    if (switchHighlight) {
      return colorize(composeStatus(snapshot, settings.currency, rate, icons), settings.switchColor);
    }

    // Deviation of the effective price from the catalogue price -> colour the
    // section icon (arrow); the numbers stay in the base colour. Compared at the
    // displayed precision, so an equal-looking price never colours the arrow.
    const thresholds = settings.deviationThresholds;
    const shown = (usd: number | null): number | null =>
      usd === null ? null : roundToDisplay(usd, rate);
    const colors: PriceColors = {
      base: settings.color,
      input: styleDeviation(
        deviationColorSpec(
          shown(snapshot.inputUsdPerMillion),
          shown(snapshot.catalogueInputUsdPerMillion),
          thresholds,
        ),
      ),
      output: styleDeviation(
        deviationColorSpec(
          shown(snapshot.outputUsdPerMillion),
          shown(snapshot.catalogueOutputUsdPerMillion),
          thresholds,
        ),
      ),
    };
    return composeStatus(snapshot, settings.currency, rate, icons, colors);
  }

  /** Applies the configured SGR style (`bold`/`reverse`) to a deviation colour (icon). */
  function styleDeviation(spec: string | null): string | null {
    if (!spec || settings.deviationStyle === "plain") return spec;
    return `${settings.deviationStyle}:${spec}`;
  }

  function render(ctx: ExtensionContext): void {
    if (!active) return;
    const text = currentText();
    try {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text ?? undefined);
    } catch {
      // The session ended while a resolution was in flight; nothing to render.
    }
  }

  /**
   * Case-insensitive provider comparison: routing constraints use lower-case ids
   * (`fireworks`) while the stream and the generation API return display names
   * (`Fireworks`).
   */
  function sameProvider(first: string | null, second: string | null): boolean {
    if (!first || !second) return false;
    return first.trim().toLowerCase() === second.trim().toLowerCase();
  }

  /** True when the newly resolved provider differs from the previously known one. */
  function providerChanged(model: string, provider: string): boolean {
    const previous = providerCache.peek(model)?.provider ?? null;
    if (!previous) return false;
    return !sameProvider(previous, provider);
  }

  function applyProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    provider: string,
    source: ProviderSource,
    byok?: boolean,
  ): void {
    if (snapshot !== target) return;

    target.upstreamProvider = provider;
    target.providerSource = source;
    // Undefined when the source cannot know it (e.g. a routing constraint).
    if (byok !== undefined) target.byok = byok;
    render(ctx);
  }

  /**
   * Applies the provider a response reported itself (`provider_stream_event`),
   * together with its rates when they are already known. Fully synchronous - no
   * `await` between the switch decision and the render - and records the provider
   * before its rates are known (see `setProvider`), so the next response compares
   * against the provider of this one.
   *
   * The cache is loaded before the first message is handled: `session_start` and
   * `before_agent_start` await `ensureCacheLoaded()`.
   */
  function applyStreamProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    key: string,
    provider: string,
    rates: { input: number; output: number } | null,
    byok: boolean,
  ): void {
    if (providerChanged(key, provider)) switchHighlight = true;
    providerCache.setProvider(key, provider, "stream", byok);
    if (rates) {
      providerCache.setRates(key, provider, rates);
      // Written before the render below, so provider and prices appear together
      // instead of the catalogue value flashing up first.
      writeRates(target, rates.input, rates.output);
    }
    applyProvider(ctx, target, provider, "stream", byok);
  }

  /** Writes real rates into the snapshot, without rendering. */
  function writeRates(target: RateSnapshot, input: number, output: number): void {
    target.inputUsdPerMillion = input;
    target.outputUsdPerMillion = output;
    target.ratesFromApi = true;
    // Real rates have arrived -> no longer a catalogue preview.
    target.cataloguePreview = false;
  }

  /** Applies rates derived from the real billed amount. */
  function applyRates(
    ctx: ExtensionContext,
    target: RateSnapshot,
    input: number,
    output: number,
  ): void {
    if (snapshot !== target) return;

    writeRates(target, input, output);
    render(ctx);
  }

  /**
   * Endpoint price list of a model, or null when it is unavailable. The list is
   * public, so no API key (and no credential lookup) is needed for it.
   */
  function endpointPricing(key: string): Promise<ProviderPricingMap | null> {
    return getProviderPricing(key);
  }

  /**
   * Real rates of a call, or null when they cannot be derived.
   *
   * Preferred source is the prompt/completion split the response itself reports
   * (`ratesFromCostSplit`): it is the provider-side invoice, so the rates need no
   * price list at all while nothing was cached. `pricing` is only required to
   * weight cached prompt tokens (their prices *relative* to the input price) and
   * as the split basis of the fallback `deriveRealRates`, which works from the
   * billed total alone (generation API, responses without a split).
   *
   * Pure computation: the caller decides whether the price list is needed.
   */
  function streamRates(
    call: StreamCallInfo,
    target: RateSnapshot,
    pricing: EndpointPricing | null,
  ): { input: number; output: number } | null {
    const tokens = target.tokens;
    // The endpoint thresholds count the whole prompt, cached tokens included.
    const tiered = pricing
      ? pricingForPromptTokens(pricing, tokens.input + tokens.cacheRead + tokens.cacheWrite)
      : null;

    const split = ratesFromCostSplit(call.promptCost, call.completionsCost, tokens, tiered);
    if (split) return { input: split.input, output: split.output };

    const billed = effectiveBilledCost(call.totalCost, call.upstreamCost, call.byok);
    if (billed === null) return null;

    const real = deriveRealRates(billed, tokens, tiered);
    return real ? { input: real.input, output: real.output } : null;
  }

  /**
   * True when the rates of a call can only be derived with the endpoint prices:
   * the response reported no cost split, or cached prompt tokens are billed inside
   * the prompt cost and have to be weighted against the input price.
   */
  function needsEndpointPricing(call: StreamCallInfo, target: RateSnapshot): boolean {
    if (call.promptCost === null || call.completionsCost === null) return true;
    return target.tokens.cacheRead > 0 || target.tokens.cacheWrite > 0;
  }

  /**
   * Resolves provider and real prices for the last call:
   *   1. the response itself (OpenRouter chunk, see `streamCalls`)
   *   2. statically certain provider (single `only` pin, fallbacks disabled)
   *   3. cached provider/rates of an earlier response
   *   4. generation API + provider price list (restored session only)
   *
   * Step 1 is the normal path: `provider_stream_event` carries the provider on
   * every chunk and the billed amount with its split in the final one, so no
   * request and no waiting is involved and a provider switch is visible per
   * response. Only the *rates* of step 1 may wait for the provider price list
   * (cached prompt tokens have to be weighted); the switch decision itself is made
   * before that lookup - see `applyStreamProvider`.
   *
   * Steps 2-4 run when a response carries nothing: on a restored session, whose
   * last call was served long before this Pi process started. `onDemand` marks
   * exactly those resolutions (restore, explicit re-resolve): they may ask the
   * generation API (step 4) and never raise the switch highlight, because nothing
   * switched - the values are just being filled in.
   */
  async function resolveProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    options: { onDemand?: boolean; call?: StreamCallInfo | null } = {},
  ): Promise<void> {
    // Called as fire-and-forget, so it must never reject: Pi ends a
    // non-interactive run on an unhandled rejection.
    try {
      await resolveProviderInner(ctx, target, options);
    } catch {
      // Best-effort: without a resolution the last known values stay in place.
    }
  }

  async function resolveProviderInner(
    ctx: ExtensionContext,
    target: RateSnapshot,
    options: { onDemand?: boolean; call?: StreamCallInfo | null } = {},
  ): Promise<void> {
    if (!settings.lookupUpstreamProvider || target.provider !== "openrouter") return;

    const onDemand = options.onDemand === true;

    const key = target.requestModel;
    await ensureCacheLoaded();

    // 1) The call itself: provider and billed amount were captured from the
    //    stream chunks. Consumed here, so it cannot be reused for a later call.
    //    `message_end` passes the entry it already took for the session-cost patch
    //    (`call: null` = there was none); an explicit re-resolve takes it itself.
    const call = options.call === undefined ? streamCalls.take(key) : options.call;
    if (call?.provider) {
      // Switch detection, cache and render run *before* the price lookup below:
      // it can take a network round trip (endpoint price list), and a response
      // finishing in that window would then compare against the cache entry of
      // the previous call - the switch would be missed, and the highlight could
      // be applied to the wrong (later) call. Everything up to the render is
      // synchronous, so the decision cannot interleave with another response.
      //
      // The rates of the response itself (`cost_details`) come from the same
      // place, so the common case (no cached prompt tokens) renders provider *and*
      // prices in one synchronous step, without any request.
      const sync = streamRates(call, target, null);
      applyStreamProvider(ctx, target, key, call.provider, sync, call.byok);
      if (sync) return;

      // Rates that need the endpoint prices: cached prompt tokens have to be
      // weighted against the input price, or the response carried no cost split.
      const pricing = needsEndpointPricing(call, target) ? await endpointPricing(key) : null;
      const rates = pricing ? streamRates(call, target, pricing.get(call.provider) ?? null) : null;
      if (rates) {
        providerCache.setRates(key, call.provider, rates);
        applyRates(ctx, target, rates.input, rates.output);
        return;
      }

      // No rate for this call (no endpoint prices for that provider, no billed
      // amount, ...): the last rates of the *same* provider stay displayed. After a
      // provider switch there are none, so the catalogue-derived value remains
      // until the prices are known.
      const known = cachedRatesFor(key);
      if (known) applyRates(ctx, target, known.input, known.output);
      return;
    }

    // 2) Provider that is guaranteed by the routing constraint (no API call).
    let certain: string | null = null;
    try {
      certain = certainRoutingProvider(registry(ctx)?.find("openrouter", key));
    } catch {
      certain = null;
    }

    // Prefer the (properly cased) name already known from an earlier response.
    const knownName = providerCache.peek(key)?.provider ?? null;
    const certainName =
      certain && knownName && knownName.trim().toLowerCase() === certain.trim().toLowerCase()
        ? knownName
        : certain;

    if (certainName && target.upstreamProvider !== certainName) {
      if (!onDemand && providerChanged(key, certainName)) switchHighlight = true;
      applyProvider(ctx, target, certainName, "routing");
    }

    // 3) Last known provider/rates of this model (from an earlier response). This
    //    is what a restored call is answered with; with rates the entry is complete.
    const cached = providerCache.peek(key);
    if (cached) {
      if (!target.upstreamProvider) {
        applyProvider(ctx, target, cached.provider, cached.source, cached.byok);
      } else if (cached.byok === true && sameProvider(target.upstreamProvider, cached.provider)) {
        // Provider already known (routing constraint); the cache still knows that
        // this provider billed through your own key.
        target.byok = true;
        render(ctx);
      }

      const cachedRates = cachedRatesFor(key);
      if (cachedRates) {
        applyRates(ctx, target, cachedRates.input, cachedRates.output);
        return;
      }
    }

    // A response always answers step 1, so the generation API below is only asked
    // for a target without response data (restored session, explicit re-resolve) -
    // once per resolution, single attempt, no retry and no cache window.
    if (!onDemand) return;

    // 4) Generation API (restored session only, single attempt).
    const responseId = target.responseId;
    if (!responseId) return;

    try {
      const apiKey = await registry(ctx)?.getApiKeyForProvider?.("openrouter");
      if (!apiKey) return;

      const info = await lookupOpenRouterGeneration(responseId, { apiKey });
      if (!info) return;

      const provider =
        info.providerName ?? target.upstreamProvider ?? cached?.provider ?? null;

      // Same computation as in the stream path; the provider is only known once
      // the lookup returned, hence the duplication. The generation endpoint has no
      // per-bucket cost split, so the provider price list is the split basis here.
      let rates: { input: number; output: number } | null = null;
      if (info.providerName) {
        const pricing = (await endpointPricing(key))?.get(info.providerName) ?? null;
        rates = streamRates({
          provider: info.providerName,
          totalCost: info.totalCost,
          upstreamCost: info.upstreamCost,
          promptCost: null,
          completionsCost: null,
          byok: info.byok,
          responseId,
        }, target, pricing);
      }

      if (provider) {
        providerCache.set(key, provider, "generation", rates, info.byok);
        applyProvider(ctx, target, provider, "generation", info.byok);
      }

      if (rates) applyRates(ctx, target, rates.input, rates.output);
    } catch {
      // Best-effort; without a provider the tag stays hidden.
    }
  }

  /** Last known real rates of a model, or null. */
  function cachedRatesFor(key: string): { input: number; output: number } | null {
    const entry = providerCache.peek(key);
    if (!entry || entry.inputRate == null || entry.outputRate == null) return null;
    return { input: entry.inputRate, output: entry.outputRate };
  }

  // Serving data of the running call. OpenRouter puts the provider into every
  // chunk and the billed amount into the final one; Pi drops both before the
  // message is finalized, so they are captured here, before normalization. The
  // handler runs in stream order, so it only parses and stores (see
  // `StreamCallBuffer`).
  pi.on("provider_stream_event", (event, _ctx: ExtensionContext) => {
    if (event.provider !== "openrouter") return;
    streamCalls.record(event.model, event.data);
  });

  // A new response of a model invalidates a leftover entry of a previous one
  // (aborted stream, error before any chunk), so no stale data can be applied.
  pi.on("message_start", (event, _ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role === "assistant") streamCalls.reset(message.model);
  });

  pi.on("session_shutdown", () => {
    active = false;
    streamCalls.clear();
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    active = true;
    settings = await loadSettings();
    await ensureCacheLoaded();
    if (settings.currency !== "USD") {
      await ensureRatesLoaded();
    }
    switchHighlight = false;
    snapshot = snapshotFromBranch(ctx.sessionManager.getBranch(), registry(ctx));
    render(ctx);
    // The last call of a restored session has no stream data -> provider and
    // prices come from the cache, the routing constraint or the generation API.
    if (snapshot) void resolveProvider(ctx, snapshot, { onDemand: true });
  });

  // Only finalized assistant messages update the value; while streaming the
  // previous value stays in place.
  // Switching the model immediately previews the catalogue prices of the new
  // model. There is no serving provider yet, so the tag shows "?".
  pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
    const next = snapshotFromModel(event.model, registry(ctx));
    if (!next) return;

    switchHighlight = false;
    snapshot = next;
    render(ctx);
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const next = snapshotFromMessage(event.message, registry(ctx));
    if (!next) return;

    // New call: any previous provider-switch highlight ends here.
    switchHighlight = false;
    snapshot = next;

    render(ctx);

    // The call's own stream data is taken here, once: the resolution below and the
    // session-cost patch both work from that same entry, and a later response of
    // the same model cannot reuse it.
    const call = next.provider === "openrouter" ? streamCalls.take(next.requestModel) : null;
    void resolveProvider(ctx, next, { call });

    return patchSessionCost(event.message, next, call);
  });

  /**
   * Replaces the catalogue cost of the finalized message with the amount OpenRouter
   * actually billed, so Pi's session sum (footer, `/session`, `/cost`, export,
   * pi-powerline-footer) shows the real spend. Pi applies the returned message in
   * place before persisting it and before its own listeners run, so every consumer
   * sees the corrected value; calls of earlier turns and of a restored session keep
   * the catalogue value (they are already persisted).
   *
   * Returns undefined when nothing is patched (setting off, no stream data, no
   * usable amount, non-OpenRouter model).
   */
  function patchSessionCost(
    message: MessageEndEvent["message"],
    target: RateSnapshot,
    call: StreamCallInfo | null,
  ): MessageEndEventResult | undefined {
    const billed = sessionCostAmountFor(target, call, {
      enabled: settings.patchSessionCost,
      lookup: settings.lookupUpstreamProvider,
      basis: settings.sessionCostBasis,
    });
    if (billed === null) return undefined;

    const usage = (message as { usage?: { cost?: UsageCostLike } }).usage;
    const cost = usage?.cost;
    if (!cost || typeof cost.input !== "number" || typeof cost.total !== "number") {
      return undefined;
    }

    const patched = patchedCost(cost, billed);
    if (!patched) return undefined;

    return {
      message: { ...message, usage: { ...usage, cost: patched } } as MessageEndEvent["message"],
    };
  }

  pi.registerCommand(COMMAND_NAME, {
    description: "Show/toggle the effective provider token prices",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "refresh", "status", "currency", "icons", "lookup", "color", "switchColor", "style", "threshold", "session"];
      // trimStart only: a trailing space must survive to detect sub-arguments.
      const value = prefix.trimStart().toLowerCase();

      if (value.startsWith("currency ")) {
        const code = value.split(/\s+/)[1] ?? "";
        return SUPPORTED_CURRENCIES
          .filter((currency) => currency.toLowerCase().startsWith(code))
          .map((currency) => ({ value: `currency ${currency}`, label: currency }));
      }

      if (value.startsWith("icons ")) {
        const mode = value.split(/\s+/)[1] ?? "";
        return ICON_MODES
          .filter((entry) => entry.startsWith(mode))
          .map((entry) => ({ value: `icons ${entry}`, label: entry }));
      }

      if (value.startsWith("color ") || value.startsWith("switchcolor ")) {
        const name = value.split(/\s+/)[1] ?? "";
        const head = value.startsWith("switchcolor") ? "switchColor" : "color";
        const presets = [...COLOR_NAMES, "bold:yellow", "bold:white", "reverse:red", "reverse:orange"];
        return presets
          .filter((entry) => entry.startsWith(name))
          .map((entry) => ({ value: `${head} ${entry}`, label: entry }));
      }

      if (value.startsWith("threshold ")) {
        const parts = value.split(/\s+/);
        const which = parts[1] ?? "";
        if (parts.length <= 2) {
          return ["green", "yellow", "orange"]
            .filter((entry) => entry.startsWith(which))
            .map((entry) => ({ value: `threshold ${entry} `, label: entry }));
        }
        return [];
      }

      if (value.startsWith("style ")) {
        const mode = value.split(/\s+/)[1] ?? "";
        return DEVIATION_STYLES
          .filter((entry) => entry.startsWith(mode))
          .map((entry) => ({ value: `style ${entry}`, label: entry }));
      }

      if (value.startsWith("lookup ")) {
        const mode = value.split(/\s+/)[1] ?? "";
        return ["on", "off", "refresh"]
          .filter((entry) => entry.startsWith(mode))
          .map((entry) => ({ value: `lookup ${entry}`, label: entry }));
      }

      if (value.startsWith("session ")) {
        const parts = value.split(/\s+/);
        if (parts.length <= 2) {
          return ["on", "off", "toggle", "basis"]
            .filter((entry) => entry.startsWith(parts[1] ?? ""))
            .map((entry) => ({ value: `session ${entry}`, label: entry }));
        }
        if (parts[1]?.toLowerCase() !== "basis") return [];
        return SESSION_COST_BASES
          .filter((entry) => entry.startsWith(parts[2] ?? ""))
          .map((entry) => ({ value: `session basis ${entry}`, label: entry }));
      }

      return options
        .filter((option) => option.startsWith(value))
        .map((option) => ({ value: option, label: option }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleCommand(args, ctx);
    },
  });

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const action = (sub ?? "status").toLowerCase();

    switch (action) {
      case "on":
      case "off": {
        const enabled = action === "on";
        settings = { ...settings, enabled };
        await saveSettings({ enabled });
        render(ctx);
        notifyState(ctx, enabled ? "enabled" : "disabled");
        return;
      }
      case "toggle": {
        settings = { ...settings, enabled: !settings.enabled };
        await saveSettings({ enabled: settings.enabled });
        render(ctx);
        notifyState(ctx, settings.enabled ? "enabled" : "disabled");
        return;
      }
      case "refresh": {
        const ok = await refreshRates();
        render(ctx);

        // Also re-resolve provider and costs of the last call.
        const resolvable = settings.lookupUpstreamProvider
          && snapshot !== null
          && snapshot.provider === "openrouter";

        if (resolvable && snapshot) {
          void resolveProvider(ctx, snapshot, { onDemand: true });
        }

        ctx.ui.notify(
          (ok
            ? "Exchange rates reloaded."
            : "Exchange rates could not be loaded (using cached values or '?' if available).")
            + (resolvable ? " Provider/costs are being re-resolved." : ""),
          ok ? "info" : "warning",
        );
        return;
      }
      case "currency": {
        const code = normalizeCurrency(rest[0]);
        if (!code) {
          ctx.ui.notify(
            `Unknown currency "${rest[0] ?? ""}". Allowed: ${SUPPORTED_CURRENCIES.join(", ")}.`,
            "warning",
          );
          return;
        }
        settings = { ...settings, currency: code };
        await saveSettings({ currency: code });
        if (code !== "USD") await ensureRatesLoaded();
        render(ctx);
        ctx.ui.notify(`Currency set to ${code}.`, "info");
        return;
      }
      case "threshold": {
        const keys: (keyof DeviationThresholds)[] = ["green", "yellow", "orange"];
        const which = rest[0]?.toLowerCase() as keyof DeviationThresholds | undefined;
        const value = Number(rest[1]);
        if (!which || !keys.includes(which) || rest[1] === undefined || !Number.isFinite(value) || value < 0) {
          ctx.ui.notify(
            `Expected: /${COMMAND_NAME} threshold <green|yellow|orange> <percent> (>= 0)`,
            "warning",
          );
          return;
        }
        const deviationThresholds: DeviationThresholds = { ...settings.deviationThresholds, [which]: value };
        settings = { ...settings, deviationThresholds };
        await saveSettings({ deviationThresholds });
        render(ctx);
        ctx.ui.notify(
          `Threshold ${which} set to ${value}% `
            + `(green < -${deviationThresholds.green}%, yellow <= ${deviationThresholds.yellow}%, `
            + `orange <= ${deviationThresholds.orange}%, else red).`,
          "info",
        );
        return;
      }
      case "style": {
        const mode: DeviationStyle | undefined = normalizeDeviationStyle(rest[0]);
        if (!mode) {
          ctx.ui.notify(
            `Unknown style "${rest[0] ?? ""}". Allowed: ${DEVIATION_STYLES.join(", ")}.`,
            "warning",
          );
          return;
        }
        settings = { ...settings, deviationStyle: mode };
        await saveSettings({ deviationStyle: mode });
        render(ctx);
        ctx.ui.notify(`Deviation style set to ${mode}.`, "info");
        return;
      }
      case "icons": {
        const mode = normalizeIconMode(rest[0]);
        if (!mode) {
          ctx.ui.notify(
            `Unknown icon mode "${rest[0] ?? ""}". Allowed: ${ICON_MODES.join(", ")}.`,
            "warning",
          );
          return;
        }
        settings = { ...settings, icons: mode };
        await saveSettings({ icons: mode });
        render(ctx);
        ctx.ui.notify(`Icon mode set to ${mode}.`, "info");
        return;
      }
      case "color":
      case "switchcolor": {
        const name = normalizeColorSpec(rest[0]);
        if (!name) {
          ctx.ui.notify(
            `Unknown colour "${rest[0] ?? ""}". Allowed: ${COLOR_NAMES.join(", ")}, `
              + `hex (#ffd700), 256-code (226), and "bold:..."/"reverse:..." (bold:yellow, reverse:red).`,
            "warning",
          );
          return;
        }
        const isSwitch = action === "switchcolor";
        settings = isSwitch ? { ...settings, switchColor: name } : { ...settings, color: name };
        await saveSettings(isSwitch ? { switchColor: name } : { color: name });
        render(ctx);
        ctx.ui.notify(`${isSwitch ? "Switch colour" : "Colour"} set to ${name}.`, "info");
        return;
      }
      case "lookup": {
        const mode = rest[0]?.toLowerCase();
        if (mode === "refresh") {
          await ensureCacheLoaded();
          providerCache.clear();
          clearPricingCache();
          if (snapshot) {
            snapshot.upstreamProvider = null;
            snapshot.providerSource = null;
            render(ctx);
            void resolveProvider(ctx, snapshot, { onDemand: true });
          }
          ctx.ui.notify("Provider cache cleared; resolution running.", "info");
          return;
        }
        if (mode !== "on" && mode !== "off") {
          ctx.ui.notify(`Expected: /${COMMAND_NAME} lookup on|off|refresh`, "warning");
          return;
        }
        settings = { ...settings, lookupUpstreamProvider: mode === "on" };
        await saveSettings({ lookupUpstreamProvider: settings.lookupUpstreamProvider });
        render(ctx);
        if (settings.lookupUpstreamProvider && snapshot) {
          void resolveProvider(ctx, snapshot, { onDemand: true });
        }
        ctx.ui.notify(
          `Provider resolution ${settings.lookupUpstreamProvider ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }
      case "session": {
        const mode = rest[0]?.toLowerCase();

        if (mode === "basis") {
          const basis = normalizeSessionCostBasis(rest[1]);
          if (!basis) {
            ctx.ui.notify(
              `Expected: /${COMMAND_NAME} session basis <${SESSION_COST_BASES.join("|")}>`
                + " (upstream = what the call actually cost, openrouter = what OpenRouter charged).",
              "warning",
            );
            return;
          }
          settings = { ...settings, sessionCostBasis: basis };
          await saveSettings({ sessionCostBasis: basis });
          ctx.ui.notify(
            basis === "upstream"
              ? "Session cost basis: upstream (BYOK calls count what your provider bills)."
              : "Session cost basis: openrouter (BYOK calls count as $0).",
            "info",
          );
          return;
        }

        if (mode !== "on" && mode !== "off" && mode !== "toggle") {
          ctx.ui.notify(
            `Expected: /${COMMAND_NAME} session on|off|toggle|basis <${SESSION_COST_BASES.join("|")}>`,
            "warning",
          );
          return;
        }

        const patchSessionCost = mode === "toggle" ? !settings.patchSessionCost : mode === "on";
        settings = { ...settings, patchSessionCost };
        await saveSettings({ patchSessionCost });
        ctx.ui.notify(
          `Session-cost correction ${patchSessionCost ? "enabled" : "disabled"}`
            + (patchSessionCost
              ? ". Applies to the calls from now on; already persisted calls keep Pi's catalogue value."
              : "."),
          "info",
        );
        return;
      }
      case "status":
      default: {
        if (action !== "status") {
          ctx.ui.notify(`Unknown option "${action}". Use: ${commandUsage()}`, "warning");
          return;
        }
        const text = currentText();
        const state = settings.enabled ? "on" : "off";
        const active = snapshot
          ? `${snapshot.provider}/${snapshot.requestModel}${snapshot.subscription ? " (subscription)" : ""}`
          : "no API call yet";
        const tag = snapshot ? upstreamTag(snapshot) : null;
        const source = snapshot?.providerSource ?? "-";
        const cached = snapshot ? providerCache.peek(snapshot.requestModel) : null;
        const cacheInfo = cached
          ? `cache:${cached.source}${cached.inputRate != null ? ", rates:api" : ""}`
          : "cache:-";
        ctx.ui.notify(
          `Provider prices: ${state} · currency: ${settings.currency} · icons: ${settings.icons}`
          + ` · colours: ${settings.color}/${settings.switchColor}`
          + ` (deviation: ${settings.deviationStyle}, thresholds: `
          + `-${settings.deviationThresholds.green}/${settings.deviationThresholds.yellow}/`
          + `${settings.deviationThresholds.orange}%)`
          + ` · lookup: ${settings.lookupUpstreamProvider ? "on" : "off"}`
          + ` · session cost: ${settings.patchSessionCost ? settings.sessionCostBasis : "off"}`
          + ` · display: ${text ?? "-"} · model: ${active} · tag: ${tag ?? "-"} (${source})`
          + ` · rates: ${snapshot?.cataloguePreview ? "catalogue (preview)" : snapshot?.ratesFromApi ? "api" : "catalogue"} · ${cacheInfo}`
          + ` · cache entries: ${providerCache.size()}`,
          "info",
        );
        return;
      }
    }
  }

  function notifyState(ctx: ExtensionCommandContext, state: string): void {
    const text = currentText();
    ctx.ui.notify(
      text
        ? `Provider prices ${state} · ${text}`
        : `Provider prices ${state}${snapshot ? "" : " (no API call yet)"}.`,
      "info",
    );
  }

  function commandUsage(): string {
    return `/${COMMAND_NAME} on|off|toggle|refresh|status|currency <${SUPPORTED_CURRENCIES.join("|")}>`
      + `|icons <${ICON_MODES.join("|")}>|color <${COLOR_NAMES.join("|")}|#hex|0-255|bold:...|reverse:...>`
      + `|switchColor <...>|style <${DEVIATION_STYLES.join("|")}>`
      + `|threshold <green|yellow|orange> <pct>|lookup <on|off|refresh>`
      + `|session <on|off|toggle|basis <${SESSION_COST_BASES.join("|")}>>`;
  }
}
