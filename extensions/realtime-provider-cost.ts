/**
 * realtime-provider-cost
 *
 * Zeigt in der Statusleiste die effektiven Tokenpreise (Input/Output, pro 1 Mio.
 * Tokens) des Providers/Modells des **letzten** API-Calls an.
 *
 * - Preise werden aus dem gemeldeten `usage.cost.*` abgeleitet (effektiver Preis,
 *   inkl. Tiers/Service-Tier/Routing), nicht aus der statischen Preistabelle.
 * - Das Provider-Kuerzel zeigt den tatsaechlich bedienenden Provider. Bei
 *   OpenRouter wird dazu best-effort der echte Upstream-Provider (z. B. Fireworks)
 *   ueber die Generation-API aufgeloest; sonst die Provider-ID.
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
import {
  displayProvider,
  snapshotFromBranch,
  snapshotFromMessage,
  type ModelRegistryLike,
  type RateSnapshot,
} from "../src/pricing.ts";
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
const UPSTREAM_CACHE_LIMIT = 200;

/** Registry facade as far as this extension needs it. */
interface RegistryFacade extends ModelRegistryLike {
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export default async function realtimeProviderCost(pi: ExtensionAPI): Promise<void> {
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
  let snapshot: RateSnapshot | null = null;

  /** generation id -> upstream provider name (or null when unknown). */
  const upstreamCache = new Map<string, string | null>();
  const upstreamInFlight = new Set<string>();

  function registry(ctx: ExtensionContext): RegistryFacade | undefined {
    return ctx.modelRegistry as unknown as RegistryFacade | undefined;
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

  /**
   * Resolves the real upstream provider for OpenRouter calls and refreshes the
   * status once known. Best-effort: failures keep the provider-id fallback.
   */
  async function enrichUpstream(ctx: ExtensionContext, target: RateSnapshot): Promise<void> {
    if (!settings.lookupUpstreamProvider || target.provider !== "openrouter") return;

    const responseId = target.responseId;
    if (!responseId) return;

    if (upstreamCache.has(responseId)) {
      const cached = upstreamCache.get(responseId) ?? null;
      if (cached && snapshot === target) {
        target.upstreamProvider = cached;
        render(ctx);
      }
      return;
    }

    if (upstreamInFlight.has(responseId)) return;
    upstreamInFlight.add(responseId);

    try {
      const facade = registry(ctx);
      const apiKey = await facade?.getApiKeyForProvider?.("openrouter");
      if (!apiKey) {
        upstreamCache.set(responseId, null);
        return;
      }

      const name = await lookupOpenRouterProvider(responseId, { apiKey });
      upstreamCache.set(responseId, name);

      if (name && snapshot === target) {
        target.upstreamProvider = name;
        render(ctx);
      }
    } catch {
      upstreamCache.set(responseId, null);
    } finally {
      upstreamInFlight.delete(responseId);
      while (upstreamCache.size > UPSTREAM_CACHE_LIMIT) {
        const oldest = upstreamCache.keys().next().value;
        if (oldest === undefined) break;
        upstreamCache.delete(oldest);
      }
    }
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    settings = await loadSettings();
    if (settings.currency !== "USD") {
      await ensureRatesLoaded();
    }
    snapshot = snapshotFromBranch(ctx.sessionManager.getBranch(), registry(ctx));
    render(ctx);
    if (snapshot) void enrichUpstream(ctx, snapshot);
  });

  // Nur finalisierte Assistant-Nachrichten aktualisieren den Wert; waehrend des
  // Streamings bleibt der alte Wert stehen.
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    const next = snapshotFromMessage(event.message, registry(ctx));
    if (!next) return;

    snapshot = next;
    render(ctx);
    void enrichUpstream(ctx, next);
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
        return ["on", "off"]
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
        if (mode !== "on" && mode !== "off") {
          ctx.ui.notify(`Erwartet: /${COMMAND_NAME} lookup on|off`, "warning");
          return;
        }
        settings = { ...settings, lookupUpstreamProvider: mode === "on" };
        await saveSettings({ lookupUpstreamProvider: settings.lookupUpstreamProvider });
        render(ctx);
        if (settings.lookupUpstreamProvider && snapshot) void enrichUpstream(ctx, snapshot);
        ctx.ui.notify(
          `Upstream-Provider-Lookup ${settings.lookupUpstreamProvider ? "aktiviert" : "deaktiviert"}.`,
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
          ? `${snapshot.provider}/${snapshot.model}${snapshot.subscription ? " (subscription)" : ""}`
          : "noch kein API-Call";
        const showProvider = snapshot
          ? displayProvider(snapshot) + (snapshot.upstreamProvider ? " (upstream)" : "")
          : "-";
        ctx.ui.notify(
          `Provider-Preise: ${state} · Währung: ${settings.currency} · Icons: ${settings.icons} · Lookup: ${settings.lookupUpstreamProvider ? "on" : "off"}`
          + ` · Anzeige: ${text ?? "-"} · Modell: ${active} · Provider: ${showProvider}`,
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
      + `|icons <${ICON_MODES.join("|")}>|lookup <on|off>`;
  }
}
