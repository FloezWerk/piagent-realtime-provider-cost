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
} from "@earendil-works/pi-coding-agent";

import { ensureRatesLoaded, getRate, refreshRates } from "../src/currency.ts";
import { composeStatus } from "../src/format.ts";
import { ICON_MODES, normalizeIconMode } from "../src/icons.ts";
import { routingProviderFromModel } from "../src/model-routing.ts";
import {
  snapshotFromBranch,
  snapshotFromMessage,
  upstreamTag,
  type ModelRegistryLike,
  type ProviderSource,
  type RateSnapshot,
} from "../src/pricing.ts";
import { providerCache } from "../src/provider-cache.ts";
import {
  DEFAULT_SETTINGS,
  STATUS_KEY,
  SUPPORTED_CURRENCIES,
  loadSettings,
  normalizeCurrency,
  saveSettings,
  type ExtensionSettings,
} from "../src/settings.ts";
import { lookupOpenRouterProvider } from "../src/upstream.ts";

const COMMAND_NAME = "provider-cost";

/** Registry facade as far as this extension needs it. */
interface RegistryFacade extends ModelRegistryLike {
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export default async function realtimeProviderCost(pi: ExtensionAPI): Promise<void> {
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  let snapshot: RateSnapshot | null = null;
  let cacheLoaded = false;

  /** requestModel -> in-flight generation lookup guard. */
  const lookupsInFlight = new Set<string>();

  function registry(ctx: ExtensionContext): RegistryFacade | undefined {
    return ctx.modelRegistry as unknown as RegistryFacade | undefined;
  }

  function cacheTtlMs(): number {
    return Math.max(0, settings.providerCacheTtlMinutes) * 60_000;
  }

  async function ensureCacheLoaded(): Promise<void> {
    if (cacheLoaded) return;
    cacheLoaded = true;
    await providerCache.load();
  }

  /** Current status text, or null when the item should be hidden. */
  function currentText(): string | null {
    if (!settings.enabled || !snapshot || snapshot.subscription) return null;
    return composeStatus(snapshot, settings.currency, getRate(settings.currency), settings.icons);
  }

  function render(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, currentText() ?? undefined);
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
    render(ctx);
  }

  /**
   * Resolves the serving provider for the last call, preferring free sources:
   * routing constraint -> cache -> generation API (cached afterwards).
   */
  async function resolveProvider(ctx: ExtensionContext, target: RateSnapshot): Promise<void> {
    if (!settings.lookupUpstreamProvider || target.provider !== "openrouter") return;
    if (target.upstreamProvider) return;

    await ensureCacheLoaded();

    // 1) Static routing constraint (no API call).
    try {
      const model = registry(ctx)?.find("openrouter", target.requestModel);
      const routing = routingProviderFromModel(model);
      if (routing) {
        providerCache.set(target.requestModel, routing, "routing");
        applyProvider(ctx, target, routing, "routing");
        return;
      }
    } catch {
      // Ignore and fall through to the cache.
    }

    // 2) Persistent cache.
    const cached = providerCache.get(target.requestModel, cacheTtlMs());
    if (cached) {
      applyProvider(ctx, target, cached.provider, cached.source);
      return;
    }

    // 3) Generation API (cached by model, at most one in-flight per model).
    const responseId = target.responseId;
    const key = target.requestModel;
    if (!responseId || lookupsInFlight.has(key)) return;
    lookupsInFlight.add(key);

    try {
      const apiKey = await registry(ctx)?.getApiKeyForProvider?.("openrouter");
      if (!apiKey) return;

      const name = await lookupOpenRouterProvider(responseId, { apiKey });
      if (!name) return;

      providerCache.set(key, name, "generation");
      applyProvider(ctx, target, name, "generation");
    } catch {
      // Best-effort; without a provider the tag stays hidden.
    } finally {
      lookupsInFlight.delete(key);
    }
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    settings = await loadSettings();
    await ensureCacheLoaded();
    if (settings.currency !== "USD") {
      await ensureRatesLoaded();
    }
    snapshot = snapshotFromBranch(ctx.sessionManager.getBranch(), registry(ctx));
    render(ctx);
    if (snapshot) void resolveProvider(ctx, snapshot);
  });

  // Nur finalisierte Assistant-Nachrichten aktualisieren den Wert; waehrend des
  // Streamings bleibt der alte Wert stehen.
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const next = snapshotFromMessage(event.message, registry(ctx));
    if (!next) return;

    snapshot = next;
    render(ctx);
    void resolveProvider(ctx, next);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Effektive Provider-Tokenpreise anzeigen/ein-/ausschalten",
    getArgumentCompletions: (prefix: string) => {
      const options = ["on", "off", "toggle", "refresh", "status", "currency", "icons", "lookup"];
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
        ctx.ui.notify(
          ok
            ? "Wechselkurse neu geladen."
            : "Wechselkurse konnten nicht geladen werden (nutze ggf. gecachte Werte oder '?').",
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
      case "lookup": {
        const mode = rest[0]?.toLowerCase();
        if (mode === "refresh") {
          await ensureCacheLoaded();
          providerCache.clear();
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
        const cacheInfo = cached
          ? `cache:${cached.source}, ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s`
          : "cache:-";
        ctx.ui.notify(
          `Provider-Preise: ${state} · Währung: ${settings.currency} · Icons: ${settings.icons}`
          + ` · Lookup: ${settings.lookupUpstreamProvider ? "on" : "off"} (TTL ${settings.providerCacheTtlMinutes}min)`
          + ` · Anzeige: ${text ?? "-"} · Modell: ${active} · Tag: ${tag ?? "-"} (${source}) · ${cacheInfo} · Cache-Einträge: ${providerCache.size()}`,
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
      + `|icons <${ICON_MODES.join("|")}>|lookup <on|off|refresh>`;
  }
}
