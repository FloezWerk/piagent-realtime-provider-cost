/**
 * realtime-provider-cost
 *
 * Zeigt in der Statusleiste die effektiven Tokenpreise (Input/Output, pro 1 Mio.
 * Tokens) des Providers/Modells des **letzten** API-Calls an.
 *
 * - Preise werden aus dem gemeldeten `usage.cost.*` abgeleitet (effektiver Preis,
 *   inkl. Tiers/Service-Tier/Routing), nicht aus der statischen Preistabelle.
 * - Das Provider-Tag zeigt den von OpenRouter gewaehlten Serving-/Routing-Provider.
 *   Aufloesung in dieser Reihenfolge (moeglichst ohne REST-Call):
 *     1. Routing-Constraint `openRouterRouting.only` aus models.json (statisch, 0 Calls)
 *     2. persistenter Provider-Cache (TTL)
 *     3. Generation-API (nur bei Cache-Miss/-Ablauf, mit Backoff)
 * - Umrechnung in die konfigurierte Waehrung analog pi-powerline-footer.
 * - Die Extension ist eigenstaendig: ohne pi-powerline-footer erscheint der Wert
 *   als eigene Footer-Zeile; mit Powerline kann er ueber `customItems`/`statusKey`
 *   als Segment neben der Kostensumme platziert werden.
 *
 * Statuskanal: `realtime-provider-cost` (via `ctx.ui.setStatus`).
 * Settings-Rootkey: `realtime-provider-cost` in `~/.pi/agent/settings.json`.
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
  STATUS_KEY,
  SUPPORTED_CURRENCIES,
  loadSettings,
  normalizeCurrency,
  saveSettings,
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

    // Deviation of the effective price from the catalogue price -> colour per number.
    const colors: PriceColors = {
      base: settings.color,
      input: deviationColorSpec(snapshot.inputUsdPerMillion, snapshot.catalogueInputUsdPerMillion),
      output: deviationColorSpec(snapshot.outputUsdPerMillion, snapshot.catalogueOutputUsdPerMillion),
    };
    return composeStatus(snapshot, settings.currency, rate, icons, colors);
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
   */
  async function resolveProvider(
    ctx: ExtensionContext,
    target: RateSnapshot,
    options: { force?: boolean } = {},
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

    // 2) Cached real rates (from an earlier generation lookup).
    const cached = providerCache.get(key, settings.providerCacheRefreshPrompts);
    const cachedInput = cached?.inputRate;
    const cachedOutput = cached?.outputRate;
    const cachedRates =
      cachedInput != null && cachedOutput != null
        ? { input: cachedInput, output: cachedOutput }
        : null;

    if (cachedRates && cached) {
      if (!target.upstreamProvider) applyProvider(ctx, target, cached.provider, cached.source);
      applyRates(ctx, target, cachedRates.input, cachedRates.output);
      // A still-valid cache entry is enough - for certain routing providers as
      // well as for generation results. Only a model switch (`force`) or an
      // expired entry (cached === null above) triggers a fresh lookup, so the
      // "update in progress" marker is not shown on every prompt.
      if (!force) return;
    }

    // 3) Generation API.
    const responseId = target.responseId;
    if (!responseId || lookupsInFlight.has(key)) return;
    lookupsInFlight.add(key);

    // Show an "update in progress" marker instead of hiding the provider info.
    target.providerPending = true;
    render(ctx);

    try {
      const apiKey = await registry(ctx)?.getApiKeyForProvider?.("openrouter");
      if (!apiKey) return;

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

  // Nur finalisierte Assistant-Nachrichten aktualisieren den Wert; waehrend des
  // Streamings bleibt der alte Wert stehen.
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
    void resolveProvider(ctx, next, { force: modelChanged });
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Effektive Provider-Tokenpreise anzeigen/ein-/ausschalten",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "refresh", "status", "currency", "icons", "lookup", "color", "switchColor"];
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
        const presets = [...COLOR_NAMES, "bold:yellow", "bold:white"];
        return presets
          .filter((entry) => entry.startsWith(name))
          .map((entry) => ({ value: `${head} ${entry}`, label: entry }));
      }

      if (value.startsWith("lookup ")) {
        const mode = value.split(/\s+/)[1] ?? "";
        return ["on", "off", "refresh"]
          .filter((entry) => entry.startsWith(mode))
          .map((entry) => ({ value: `lookup ${entry}`, label: entry }));
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
        notifyState(ctx, enabled ? "aktiviert" : "deaktiviert");
        return;
      }
      case "toggle": {
        settings = { ...settings, enabled: !settings.enabled };
        await saveSettings({ enabled: settings.enabled });
        render(ctx);
        notifyState(ctx, settings.enabled ? "aktiviert" : "deaktiviert");
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
          void resolveProvider(ctx, snapshot, { force: true });
        }

        ctx.ui.notify(
          (ok
            ? "Wechselkurse neu geladen."
            : "Wechselkurse konnten nicht geladen werden (nutze ggf. gecachte Werte oder '?').")
            + (lookupPossible ? " Provider/Kosten werden neu ermittelt." : ""),
          ok ? "info" : "warning",
        );
        return;
      }
      case "currency": {
        const code = normalizeCurrency(rest[0]);
        if (!code) {
          ctx.ui.notify(
            `Unbekannte Währung "${rest[0] ?? ""}". Erlaubt: ${SUPPORTED_CURRENCIES.join(", ")}.`,
            "warning",
          );
          return;
        }
        settings = { ...settings, currency: code };
        await saveSettings({ currency: code });
        if (code !== "USD") await ensureRatesLoaded();
        render(ctx);
        ctx.ui.notify(`Währung auf ${code} gesetzt.`, "info");
        return;
      }
      case "icons": {
        const mode = normalizeIconMode(rest[0]);
        if (!mode) {
          ctx.ui.notify(
            `Unbekannter Icon-Modus "${rest[0] ?? ""}". Erlaubt: ${ICON_MODES.join(", ")}.`,
            "warning",
          );
          return;
        }
        settings = { ...settings, icons: mode };
        await saveSettings({ icons: mode });
        render(ctx);
        ctx.ui.notify(`Icon-Modus auf ${mode} gesetzt.`, "info");
        return;
      }
      case "color":
      case "switchcolor": {
        const name = normalizeColorSpec(rest[0]);
        if (!name) {
          ctx.ui.notify(
            `Unbekannte Farbe "${rest[0] ?? ""}". Erlaubt: ${COLOR_NAMES.join(", ")}, `
              + `Hex (#ffd700), 256-Code (226) und "bold:..." (bold:yellow).`,
            "warning",
          );
          return;
        }
        const isSwitch = action === "switchcolor";
        settings = isSwitch ? { ...settings, switchColor: name } : { ...settings, color: name };
        await saveSettings(isSwitch ? { switchColor: name } : { color: name });
        render(ctx);
        ctx.ui.notify(`${isSwitch ? "Wechselfarbe" : "Farbe"} auf ${name} gesetzt.`, "info");
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
            void resolveProvider(ctx, snapshot);
          }
          ctx.ui.notify("Provider-Cache geleert; Auflösung läuft.", "info");
          return;
        }
        if (mode !== "on" && mode !== "off") {
          ctx.ui.notify(`Erwartet: /${COMMAND_NAME} lookup on|off|refresh`, "warning");
          return;
        }
        settings = { ...settings, lookupUpstreamProvider: mode === "on" };
        await saveSettings({ lookupUpstreamProvider: settings.lookupUpstreamProvider });
        render(ctx);
        if (settings.lookupUpstreamProvider && snapshot) void resolveProvider(ctx, snapshot);
        ctx.ui.notify(
          `Provider-Auflösung ${settings.lookupUpstreamProvider ? "aktiviert" : "deaktiviert"}.`,
          "info",
        );
        return;
      }
      case "status":
      default: {
        if (action !== "status") {
          ctx.ui.notify(`Unbekannte Option "${action}". Nutze: ${commandUsage()}`, "warning");
          return;
        }
        const text = currentText();
        const state = settings.enabled ? "an" : "aus";
        const active = snapshot
          ? `${snapshot.provider}/${snapshot.requestModel}${snapshot.subscription ? " (subscription)" : ""}`
          : "noch kein API-Call";
        const tag = snapshot ? upstreamTag(snapshot) : null;
        const source = snapshot?.providerSource ?? "-";
        const cached = snapshot ? providerCache.peek(snapshot.requestModel) : null;
        const prompts = providerCache.promptCount();
        const cacheInfo = cached
          ? `cache:${cached.source}, age:${prompts - cached.promptCount} prompts`
            + (cached.inputRate != null ? `, rates:api` : "")
          : "cache:-";
        ctx.ui.notify(
          `Provider-Preise: ${state} · Währung: ${settings.currency} · Icons: ${settings.icons}`
          + ` · Farben: ${settings.color}/${settings.switchColor}`
          + ` · Lookup: ${settings.lookupUpstreamProvider ? "on" : "off"} (refresh alle ${settings.providerCacheRefreshPrompts} Prompts)`
          + ` · Anzeige: ${text ?? "-"} · Modell: ${active} · Tag: ${tag ?? "-"} (${source})`
          + ` · Preise: ${snapshot?.cataloguePreview ? "katalog (Vorschau)" : snapshot?.ratesFromApi ? "api" : "katalog"} · ${cacheInfo}`
          + ` · Prompts: ${prompts} · Cache-Einträge: ${providerCache.size()}`,
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
        ? `Provider-Preise ${state} · ${text}`
        : `Provider-Preise ${state}${snapshot ? "" : " (noch kein API-Call)"}.`,
      "info",
    );
  }

  function commandUsage(): string {
    return `/${COMMAND_NAME} on|off|toggle|refresh|status|currency <${SUPPORTED_CURRENCIES.join("|")}>`
      + `|icons <${ICON_MODES.join("|")}>|color <${COLOR_NAMES.join("|")}|#hex|0-255|bold:...>`
      + `|switchColor <...>|lookup <on|off|refresh>`;
  }
}
