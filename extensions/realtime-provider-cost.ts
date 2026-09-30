/**
 * realtime-provider-cost
 *
 * Shows the effective token prices (input/output, per 1M tokens) of the
 * provider/model of the **last** API call in the status bar.
 *
 * - Prices are derived from the amount OpenRouter actually billed (effective
 *   price, including tiers/service tier/routing), not from the static catalogue.
 * - The provider tag shows the provider *inside* OpenRouter that served the call.
 *   Resolution order:
 *     1. the response itself: `provider_stream_event` carries `provider` on every
 *        chunk and the billed amount in the final one (no request, per response)
 *     2. routing constraint `openRouterRouting.only` from models.json (static)
 *     3. persistent provider cache (last known value)
 *     4. generation API (fallback for responses without stream data, with backoff)
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
import { deriveRealRates, effectiveBilledCost } from "../src/rates.ts";
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
   * Model of the previously handled/restored call. A change means the user
   * switched models - then provider and costs are looked up fresh instead of
   * being served from the cache.
   */
  let lastModel: string | null = null;

  /**
   * Set when a serving-provider switch was detected. Everything rendered for the
   * current call is drawn in `switchColor` (yellow by default); the next call
   * resets it, so the highlight is a one-shot hint.
   */
  let switchHighlight = false;

  /** requestModel -> in-flight generation lookup guard. */
  const lookupsInFlight = new Set<string>();

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
   * True when the newly resolved provider differs from the previously known one.
   * Compared case-insensitively: routing constraints use lower-case ids
   * (`fireworks`) while the generation API returns display names (`Fireworks`).
   */
  function providerChanged(model: string, provider: string): boolean {
    const previous = providerCache.peek(model)?.provider;
    if (!previous) return false;
    return previous.trim().toLowerCase() !== provider.trim().toLowerCase();
  }

  function applyProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    provider: string,
    source: ProviderSource,
  ): void {
    if (snapshot !== target) return;

    target.upstreamProvider = provider;
    target.providerSource = source;
    target.providerPending = false;
    render(ctx);
  }

  /**
   * Applies the provider a response reported itself (`provider_stream_event`).
   * Fully synchronous - no `await` between the switch decision and the render -
   * and records the provider before its rates are known (see `setProvider`), so
   * the next response compares against the provider of this one.
   *
   * The cache is loaded before the first message is handled: `session_start` and
   * `before_agent_start` await `ensureCacheLoaded()`.
   */
  function applyStreamProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    key: string,
    provider: string,
  ): void {
    if (providerChanged(key, provider)) switchHighlight = true;
    providerCache.setProvider(key, provider, "stream");
    applyProvider(ctx, target, provider, "stream");
  }

  /** Applies rates derived from the real billed amount. */
  function applyRates(
    ctx: ExtensionContext,
    target: RateSnapshot,
    input: number,
    output: number,
  ): void {
    if (snapshot !== target) return;

    target.inputUsdPerMillion = input;
    target.outputUsdPerMillion = output;
    target.ratesFromApi = true;
    // Real rates have arrived -> no longer a catalogue preview.
    target.cataloguePreview = false;
    render(ctx);
  }

  /**
   * Real rates of a call whose serving provider and billed amount are known. The
   * split basis comes from the endpoint prices of that provider, using the
   * long-context tier that applies to the call (see `pricingForPromptTokens`);
   * the billed amount itself stays authoritative.
   */
  async function billedRates(
    ctx: ExtensionContext,
    key: string,
    call: StreamCallInfo,
    target: RateSnapshot,
  ): Promise<{ input: number; output: number } | null> {
    if (!call.provider) return null;

    const billed = effectiveBilledCost(call.totalCost, call.upstreamCost, call.byok);
    if (billed === null) return null;

    const apiKey = await registry(ctx)?.getApiKeyForProvider?.("openrouter");
    if (!apiKey) return null;

    const pricing: EndpointPricing | null =
      (await getProviderPricing(key, apiKey))?.get(call.provider) ?? null;
    if (!pricing) return null;

    // The thresholds count the whole prompt, cached tokens included.
    const promptTokens = target.tokens.input + target.tokens.cacheRead + target.tokens.cacheWrite;
    const real = deriveRealRates(billed, target.tokens, pricingForPromptTokens(pricing, promptTokens));
    return real ? { input: real.input, output: real.output } : null;
  }

  /**
   * Resolves provider and real prices for the last call:
   *   1. the response itself (OpenRouter chunk, see `streamCalls`)
   *   2. statically certain provider (single `only` pin, fallbacks disabled)
   *   3. cached provider/rates of an earlier response
   *   4. generation API + provider price list (fallback)
   *
   * Step 1 is the normal path: `provider_stream_event` carries the provider on
   * every chunk and the billed amount in the final one, so no request and no
   * waiting is involved and a provider switch is visible per response. Steps 2-4
   * only run when a response carries nothing (session restore, aborted stream,
   * Pi without that event).
   *
   * Only the *rates* of step 1 wait for the provider price list (the billed amount
   * is one total, the in/out split needs the provider's prices). The switch
   * decision itself is made before that lookup - see `applyStreamProvider`.
   *
   * Step 4 only runs on a cache miss, after the cache entry expired (see
   * `providerCache.get` / `providerCacheRefreshPrompts`) or when the model just
   * changed (`force`). A valid cache entry covers the whole refresh window even
   * when the provider is not certain: with `allow_fallbacks` (OpenRouter
   * default) another provider may serve the request even though `only` lists
   * just one, but that is exactly what the cached result reflects.
   * An entry without rates counts as valid too: free models never bill a
   * per-token rate, so a missing rate must not turn into a request per prompt.
   * The same holds for a request that returns nothing at all: the attempt itself
   * re-arms the window (`providerCache.markAttempt`), so a failing lookup is not
   * repeated on every prompt either.
   *
   * Every outgoing generation-API request is announced via `ctx.ui.notify`,
   * including the reason (cache miss, expired entry, model switch, manual
   * refresh, ...).
   */
  async function resolveProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    options: { force?: boolean; reason?: string } = {},
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
    options: { force?: boolean; reason?: string } = {},
  ): Promise<void> {
    if (!settings.lookupUpstreamProvider || target.provider !== "openrouter") return;

    const force = options.force === true;

    const key = target.requestModel;
    await ensureCacheLoaded();

    // 1) The call itself: provider and billed amount were captured from the
    //    stream chunks. Consumed here, so it cannot be reused for a later call.
    const call = streamCalls.take(key);
    if (call?.provider) {
      // Switch detection, cache and render run *before* the price lookup below:
      // it can take a network round trip (endpoint price list), and a response
      // finishing in that window would then compare against the cache entry of
      // the previous call - the switch would be missed, and the highlight could
      // be applied to the wrong (later) call. Everything up to the render is
      // synchronous, so the decision cannot interleave with another response.
      applyStreamProvider(ctx, target, key, call.provider);

      const rates = await billedRates(ctx, key, call, target);
      if (rates) {
        providerCache.setRates(key, call.provider, rates);
        applyRates(ctx, target, rates.input, rates.output);
        return;
      }

      // No rate for this call (no endpoint prices for that provider, missing API
      // key, no billed amount, ...): the last rates of the *same* provider stay
      // displayed. After a provider switch there are none, so the catalogue-derived
      // value remains until the prices are known.
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
      if (providerChanged(key, certainName)) switchHighlight = true;
      applyProvider(ctx, target, certainName, "routing");
    }

    // 3) Valid cache entry for this model (from an earlier response).
    const cached = providerCache.get(key, settings.providerCacheRefreshPrompts);
    if (cached) {
      if (!target.upstreamProvider) applyProvider(ctx, target, cached.provider, cached.source);

      const cachedRates = cachedRatesFor(key);
      if (cachedRates) applyRates(ctx, target, cachedRates.input, cachedRates.output);

      // A still-valid entry is enough - for certain routing providers just as
      // for generation results, and with or without rates (a free model has
      // none, see above). Only a model switch (`force`) or an expired entry
      // (cached === null above) triggers a fresh lookup, so no generation
      // request is sent per prompt.
      if (!force) return;
    }

    // 4) Generation API (fallback).
    const responseId = target.responseId;
    if (!responseId || lookupsInFlight.has(key)) return;

    // A request that yielded no result (404 right after the call, timeout, ...)
    // must not be retried on every prompt: the attempt re-arms the cache window
    // just like a stored entry. `force` (model switch, manual refresh) bypasses
    // the throttle.
    const lastAttempt = providerCache.attemptPromptCount(key);
    const attemptedSince =
      lastAttempt === null ? null : providerCache.promptCount(key) - lastAttempt;
    if (
      !force
      && attemptedSince !== null
      && attemptedSince < Math.max(0, settings.providerCacheRefreshPrompts)
    ) {
      return;
    }

    const reason = options.reason ?? generationReason(key);
    lookupsInFlight.add(key);
    providerCache.markAttempt(key);

    // Show an "update in progress" marker instead of hiding the provider info.
    target.providerPending = true;
    render(ctx);

    try {
      const apiKey = await registry(ctx)?.getApiKeyForProvider?.("openrouter");
      if (!apiKey) return;

      notifyGenerationRequest(ctx, target, reason);
      const info = await lookupOpenRouterGeneration(responseId, { apiKey });
      if (!info) return;

      const provider =
        info.providerName ?? target.upstreamProvider ?? cached?.provider ?? null;

      // Same computation as in the stream path; the provider is only known once
      // the lookup returned, hence the duplication. The generation endpoint has no
      // per-bucket cost split, so the prompt/completion parts stay unknown here.
      const rates = info.providerName
        ? await billedRates(ctx, key, {
          provider: info.providerName,
          totalCost: info.totalCost,
          upstreamCost: info.upstreamCost,
          promptCost: null,
          completionsCost: null,
          byok: info.byok,
          responseId,
        }, target)
        : null;

      if (provider) {
        if (providerChanged(key, provider)) switchHighlight = true;
        providerCache.set(key, provider, "generation", rates);
        applyProvider(ctx, target, provider, "generation");
      }

      if (rates) applyRates(ctx, target, rates.input, rates.output);
    } catch {
      // Best-effort; without a provider the tag stays hidden.
    } finally {
      lookupsInFlight.delete(key);
      if (target.providerPending) {
        target.providerPending = false;
        render(ctx);
      }
    }
  }

  /** Last known real rates of a model, or null. */
  function cachedRatesFor(key: string): { input: number; output: number } | null {
    const entry = providerCache.peek(key);
    if (!entry || entry.inputRate == null || entry.outputRate == null) return null;
    return { input: entry.inputRate, output: entry.outputRate };
  }

  /** Why a fresh generation-API request is necessary, for the notify text. */
  function generationReason(key: string): string {
    const entry = providerCache.peek(key);
    if (!entry) return "cache miss";

    const age = providerCache.promptCount(key) - entry.promptCount;
    if (entry.source === "generation" && age >= settings.providerCacheRefreshPrompts) {
      return `cache expired (${age} prompts)`;
    }
    if (entry.inputRate == null || entry.outputRate == null) return "cache without rates";
    return "stale cache";
  }

  /** Announces an outgoing generation-API request including its reason. */
  function notifyGenerationRequest(ctx: ExtensionContext, target: RateSnapshot, reason: string): void {
    if (!settings.notifyGenerationLookup || !ctx.hasUI) return;
    ctx.ui.notify(
      `Generation API: resolving provider/costs for ${target.requestModel} (${reason}).`,
      "info",
    );
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

  // Prompt counter for the prompt-count based cache invalidation. Counted per
  // model: prompts on other models must not age this model's cache entry.
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    await ensureCacheLoaded();
    const model = ctx.model?.id;
    if (model) providerCache.bumpPromptCount(model);
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
    // Restoring a session is not a model switch -> no forced refresh.
    lastModel = snapshot?.requestModel ?? null;
    render(ctx);
    if (snapshot) void resolveProvider(ctx, snapshot);
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
    // `lastModel` stays untouched: the first call of the new model is still
    // detected as a model change and therefore forces a provider/cost refresh.
    render(ctx);
  });

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const next = snapshotFromMessage(event.message, registry(ctx));
    if (!next) return;

    // New call: any previous provider-switch highlight ends here.
    switchHighlight = false;
    snapshot = next;

    // Switching models must not reuse the cached provider/costs of the old one.
    const modelChanged = lastModel !== null && next.requestModel !== lastModel;
    lastModel = next.requestModel;

    render(ctx);
    void resolveProvider(ctx, next, { force: modelChanged, reason: modelChanged ? "model switch" : undefined });
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Show/toggle the effective provider token prices",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "refresh", "status", "currency", "icons", "lookup", "notify", "color", "switchColor", "style", "threshold"];
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

      if (value.startsWith("notify ")) {
        const mode = value.split(/\s+/)[1] ?? "";
        return ["on", "off"]
          .filter((entry) => entry.startsWith(mode))
          .map((entry) => ({ value: `notify ${entry}`, label: entry }));
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

        // Also re-resolve provider and costs, when a lookup is possible at all.
        const lookupPossible =
          settings.lookupUpstreamProvider &&
          snapshot !== null &&
          snapshot.provider === "openrouter" &&
          snapshot.responseId !== null;

        if (lookupPossible && snapshot) {
          void resolveProvider(ctx, snapshot, { force: true, reason: "manual refresh" });
        }

        ctx.ui.notify(
          (ok
            ? "Exchange rates reloaded."
            : "Exchange rates could not be loaded (using cached values or '?' if available).")
            + (lookupPossible ? " Provider/costs are being re-resolved." : ""),
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
      case "notify": {
        const mode = rest[0]?.toLowerCase();
        if (mode !== "on" && mode !== "off") {
          ctx.ui.notify(`Expected: /${COMMAND_NAME} notify on|off`, "warning");
          return;
        }
        settings = { ...settings, notifyGenerationLookup: mode === "on" };
        await saveSettings({ notifyGenerationLookup: settings.notifyGenerationLookup });
        ctx.ui.notify(
          `Generation-API notification ${settings.notifyGenerationLookup ? "enabled" : "disabled"}.`,
          "info",
        );
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
            void resolveProvider(ctx, snapshot, { reason: "cache cleared" });
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
        if (settings.lookupUpstreamProvider && snapshot) void resolveProvider(ctx, snapshot);
        ctx.ui.notify(
          `Provider resolution ${settings.lookupUpstreamProvider ? "enabled" : "disabled"}.`,
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
        const prompts = snapshot ? providerCache.promptCount(snapshot.requestModel) : 0;
        const cacheInfo = cached
          ? `cache:${cached.source}, age:${prompts - cached.promptCount} prompts`
            + (cached.inputRate != null ? `, rates:api` : "")
          : "cache:-";
        ctx.ui.notify(
          `Provider prices: ${state} · currency: ${settings.currency} · icons: ${settings.icons}`
          + ` · colours: ${settings.color}/${settings.switchColor}`
          + ` (deviation: ${settings.deviationStyle}, thresholds: `
          + `-${settings.deviationThresholds.green}/${settings.deviationThresholds.yellow}/`
          + `${settings.deviationThresholds.orange}%)`
          + ` · lookup: ${settings.lookupUpstreamProvider ? "on" : "off"} (refresh every ${settings.providerCacheRefreshPrompts} prompts per model)`
          + ` · notify: ${settings.notifyGenerationLookup ? "on" : "off"}`
          + ` · display: ${text ?? "-"} · model: ${active} · tag: ${tag ?? "-"} (${source})`
          + ` · rates: ${snapshot?.cataloguePreview ? "catalogue (preview)" : snapshot?.ratesFromApi ? "api" : "catalogue"} · ${cacheInfo}`
          + ` · prompts (current model): ${prompts} · cache entries: ${providerCache.size()}`,
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
      + `|threshold <green|yellow|orange> <pct>|lookup <on|off|refresh>|notify <on|off>`;
  }
}
