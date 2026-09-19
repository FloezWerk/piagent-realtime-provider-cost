/**
 * realtime-provider-cost
 *
 * Shows the effective token prices (input/output, per 1M tokens) of the
 * provider/model of the **last** API call in the status bar.
 *
 * - Prices are derived from the reported `usage.cost.*` (effective price,
 *   including tiers/service tier/routing), not from the static catalogue.
 * - The provider tag shows the serving/routing provider chosen by OpenRouter.
 *   Resolution order (avoiding a REST call where possible):
 *     1. routing constraint `openRouterRouting.only` from models.json (static, 0 calls)
 *     2. persistent provider cache (TTL)
 *     3. generation API (only on cache miss/expiry, with backoff)
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
import { composeStatus, type PriceColors } from "../src/format.ts";
import { ICON_MODES, normalizeIconMode } from "../src/icons.ts";
import { clearPricingCache, getProviderPricing } from "../src/endpoint-pricing.ts";
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
import { deriveRealRates } from "../src/rates.ts";
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
    // section icon (arrow); the numbers stay in the base colour.
    const thresholds = settings.deviationThresholds;
    const colors: PriceColors = {
      base: settings.color,
      input: styleDeviation(
        deviationColorSpec(snapshot.inputUsdPerMillion, snapshot.catalogueInputUsdPerMillion, thresholds),
      ),
      output: styleDeviation(
        deviationColorSpec(snapshot.outputUsdPerMillion, snapshot.catalogueOutputUsdPerMillion, thresholds),
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
    const text = currentText();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text ?? undefined);
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
   * Resolves provider and real prices for the last call:
   *   1. statically certain provider (single `only` pin, fallbacks disabled)
   *   2. cached real rates (refreshed every N prompts)
   *   3. generation API + provider price list for the actually billed amount
   *
   * Step 3 only runs on a cache miss, after the cache entry expired (see
   * `providerCache.get` / `providerCacheRefreshPrompts`) or when the model just
   * changed (`force`). A valid cache entry covers the whole refresh window even
   * when the provider is not certain: with `allow_fallbacks` (OpenRouter
   * default) another provider may serve the request even though `only` lists
   * just one, but that is exactly what the cached generation result reflects.
   * An entry without rates counts as valid too: free models never bill a
   * per-token rate, so a missing rate must not turn into a request per prompt.
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
    if (!settings.lookupUpstreamProvider || target.provider !== "openrouter") return;

    const force = options.force === true;

    const key = target.requestModel;
    await ensureCacheLoaded();

    // 1) Provider that is guaranteed by the routing constraint (no API call).
    let certain: string | null = null;
    try {
      certain = certainRoutingProvider(registry(ctx)?.find("openrouter", key));
    } catch {
      certain = null;
    }

    // Prefer the (properly cased) name already known from the generation API.
    const knownName = providerCache.peek(key)?.provider ?? null;
    const certainName =
      certain && knownName && knownName.trim().toLowerCase() === certain.trim().toLowerCase()
        ? knownName
        : certain;

    if (certainName && target.upstreamProvider !== certainName) {
      if (providerChanged(key, certainName)) switchHighlight = true;
      applyProvider(ctx, target, certainName, "routing");
    }

    // 2) Valid cache entry for this model (from an earlier generation lookup).
    const cached = providerCache.get(key, settings.providerCacheRefreshPrompts);
    if (cached) {
      if (!target.upstreamProvider) applyProvider(ctx, target, cached.provider, cached.source);

      const cachedRates =
        cached.inputRate != null && cached.outputRate != null
          ? { input: cached.inputRate, output: cached.outputRate }
          : null;
      if (cachedRates) applyRates(ctx, target, cachedRates.input, cachedRates.output);

      // A still-valid entry is enough - for certain routing providers just as
      // for generation results, and with or without rates (a free model has
      // none, see above). Only a model switch (`force`) or an expired entry
      // (cached === null above) triggers a fresh lookup, so no generation
      // request is sent per prompt.
      if (!force) return;
    }

    // 3) Generation API.
    const responseId = target.responseId;
    if (!responseId || lookupsInFlight.has(key)) return;

    const reason = options.reason ?? generationReason(key);
    lookupsInFlight.add(key);

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

      let rates: { input: number; output: number } | null = null;
      if (info.providerName && info.totalCost != null) {
        const pricing = (await getProviderPricing(key, apiKey))?.get(info.providerName) ?? null;
        const real = deriveRealRates(info.totalCost, target.tokens, pricing);
        if (real) rates = { input: real.input, output: real.output };
      }

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

  /** Why a fresh generation-API request is necessary, for the notify text. */
  function generationReason(key: string): string {
    const entry = providerCache.peek(key);
    if (!entry) return "cache miss";

    const age = providerCache.promptCount() - entry.promptCount;
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

  // Prompt counter for the prompt-count based cache invalidation.
  pi.on("before_agent_start", async () => {
    await ensureCacheLoaded();
    providerCache.bumpPromptCount();
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
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
        const prompts = providerCache.promptCount();
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
          + ` · lookup: ${settings.lookupUpstreamProvider ? "on" : "off"} (refresh every ${settings.providerCacheRefreshPrompts} prompts)`
          + ` · notify: ${settings.notifyGenerationLookup ? "on" : "off"}`
          + ` · display: ${text ?? "-"} · model: ${active} · tag: ${tag ?? "-"} (${source})`
          + ` · rates: ${snapshot?.cataloguePreview ? "catalogue (preview)" : snapshot?.ratesFromApi ? "api" : "catalogue"} · ${cacheInfo}`
          + ` · prompts: ${prompts} · cache entries: ${providerCache.size()}`,
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
