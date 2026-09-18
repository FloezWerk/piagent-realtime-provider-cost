# piagent-realtime-provider-cost

Pi-Extension, die in der Statusleiste die **effektiven Tokenpreise (Input/Output,
pro 1 Mio. Tokens)** des Providers/Modells des **letzten API-Calls** anzeigt –
direkt neben der Session-Kostensumme.

Format: `<in>/<out>` plus optionales Provider-Tag **hinten**. Das Tag zeigt den
von OpenRouter gewählten **Serving-/Routing-Provider** (z. B. `Fir` → Fireworks)
und erscheint **nur** bei OpenRouter.

```
↑$2/↓$12 (Fir)    # Pfeile (Unicode, volle Größe in jeder Font)
in:$2/out:$12     # ASCII-Modus (icons: ascii)
↑$2/↓$12 (⟳)      # Provider wird gerade per Generation-API ermittelt
```

> Die vorher genutzten Nerd-Font-Pfeile (`U+F090`/`U+F08B`) wurden durch `↑`/`↓`
> ersetzt, weil Private-Use-Glyphen deutlich kleiner gerendert werden.

**Farbe:** standardmäßig **weiß**; wird ein **Providerwechsel** erkannt (neu
ermittelter Provider ≠ bisher bekannter Provider), wird der Wert **fett gelb**
(`bold:#ffd700`) dargestellt – der nächste Render ist wieder weiß.

Farbangaben sind frei wählbar:

| Syntax | Beispiel | Ergebnis |
| --- | --- | --- |
| Palette | `white`, `yellow`, `red`, `green`, `cyan`, `magenta`, `blue`, `gray`, `none` | SGR 97/93/91/92/96/95/94/90 |
| Hex (truecolor) | `#ffd700`, `#fd0` | `38;2;r;g;b` |
| 256-Farben | `226` (0-255) | `38;5;n` |
| Fett | `bold:yellow`, `bold:#ffd700`, `bold:226` | `1;<farbe>` |

Es sind **keine** CSS-Namen und **keine** Theme-Namen (`warning`, `error`, …)
aus der Pi-/Powerline-Theme-Welt – die Extension färbt in ANSI selbst ein, damit
sie dynamisch umschalten kann.

Werte sind **pro 1 Mio. Tokens** in der konfigurierten Währung.

## Funktionsweise

- **Echte Abrechnung statt Katalogpreis.** Quelle der Zahlen ist OpenRouter:
  die **Generation-API** liefert `total_cost` (tatsächlich berechnet) und die
  Token-Zahlen, die **Endpoint-Preise** liefern das Verhältnis der Buckets
  (Input/Output/Cache) des tatsächlich bedienenden Providers:

  ```
  modelled = prompt*in + completion*out + cacheRead*cacheReadTokens   (aus Endpoint-Preisen)
  factor   = total_cost / modelled          # Discounts, Peak-Overrides, Preisänderungen
  in-Rate  = prompt * factor                (USD pro 1 Mio. Tokens)
  out-Rate = completion * factor
  ```

  Der `factor` sorgt dafür, dass die Anzeige der Rechnung entspricht, auch wenn
  Endpoint-Preise (noch) nicht exakt dem abgerechneten Satz entsprechen.
  Solange keine API-Daten vorliegen, wird die Näherung aus `usage.cost.*`
  (Pi-Katalog) angezeigt.

- **Auflösung.** Reihenfolge:
  1. **Routing-Constraint** aus `models.json`
     (`providers.openrouter.modelOverrides.<model>.compat.openRouterRouting.only`)
     – gilt nur als *sicher*, wenn `allow_fallbacks: false` gesetzt ist. Bei
     `allow_fallbacks: true` (OpenRouter-Default) kann ein anderer Provider
     bedienen, auch wenn `only` genau einen nennt.
  2. **Persistenter Raten-Cache** (`~/.pi/agent/realtime-provider-cost/provider-cache.json`),
     Key = Request-Model. Einträge werden nach `providerCacheRefreshPrompts`
     **Prompts** (nicht nach Zeit) ungültig.
  3. **Generation-API** `GET https://openrouter.ai/api/v1/generation?id=<responseId>`
     – liefert Provider **und** echten Betrag, max. 1 Call pro Model gleichzeitig.
     Daten sind erst einige Sekunden nach dem Call verfügbar → Retry mit Backoff
     (1s/2s/4s/8s). Währenddessen wird statt des Provider-Tags ein
     **„update in progress"-Icon** (`⟳`) angezeigt.

  **Wann wird die API aufgerufen?**
  - Provider *sicher* (ein `only`-Eintrag **und** `allow_fallbacks: false`) →
    1× beim ersten Call, danach nur alle N Prompts (Raten-Cache).
  - Provider *nicht sicher* (`allow_fallbacks: true` oder kein `only`) →
    **pro Response**, weil nur der tatsächliche Provider zählt.

  Der Prompt-Zähler ist im Cache persistiert und überlebt Neustarts. Beispiel
  bei `providerCacheRefreshPrompts: 10`: Auflösung beim 1. Prompt, dann erneut
  nach dem 10. weiteren Prompt.
- **Invalidierung per Aufruf-Zähler:** Es gibt kein Signal, das einen
  Providerwechsel pro Response verrät (Model-Slug, `system_fingerprint`,
  `native_finish_reason`, `service_tier` sind provider-unabhängig). Bei sicherem
  Provider ist dieser kurzfristig stabil, daher genügt die Auflösung alle N
  Prompts; sonst wird pro Response gefragt.
- **Zwei Caches:** `provider-cache.json` (Provider + Raten pro Model) und
  `endpoint-pricing.json` (Provider-Preislisten, 24 h). `/provider-cost lookup refresh`
  leert beide.
- **Kein Batch-Endpoint:** OpenRouter bietet weder Mehrfach-IDs noch eine
  Generations-Liste; `/api/v1/activity` erfordert einen Management-Key.
- **Während des Streamings** bleibt der zuletzt bekannte Wert stehen; aktualisiert
  wird erst bei `message_end`.
- **Failover:** Ist eine Seite nicht berechenbar (z. B. `usage.input == 0`) oder
  fehlt der Umrechnungskurs, wird pro Seite `?` angezeigt.
- **Subscription-Provider** (OAuth bzw. `kimi-coding`) → Element wird ausgeblendet.
- **Gratismodelle** werden als `$0/$0` angezeigt.
- **Währungsumrechnung** analog `pi-powerline-footer` (gleiche Quelle, 24h-Cache,
  eigene Datei `…/realtime-provider-cost/currency-rates.json`); unabhängig von
  Powerline.

## Warum der Umweg über die Generation-API?

OpenRouter liefert den Serving-Provider im Stream-Chunk als `provider`-Feld, Pi
(`pi-ai`) verwirft es jedoch (liest nur `chunk.id` und `chunk.model`). Ebenso
verwirft Pi den tatsächlichen Kostenbetrag (`usage.cost`) und berechnet Kosten aus
der Preistabelle (`models-store.json`) – die den **Modell-Basispreis**, nicht den
Preis des gerouteten Providers abbildet. Ein Provider-Header existiert nicht
(`X-Provider-Name` ist nur als „exposed" gelistet, wird aber nicht gesendet).

## Integration

### Ohne pi-powerline-footer

Funktioniert eigenständig. `ctx.ui.setStatus` ist eine Core-API; der Core-Footer
zeigt den Wert als eigene Zeile.

### Mit pi-powerline-footer (empfohlen)

```jsonc
{
  "powerline": {
    "preset": "default",
    "customItems": [
      {
        "id": "provider-cost",
        "statusKey": "realtime-provider-cost",
        "position": "right",
        "color": "warning",
        "hideWhenMissing": true,
        "excludeFromExtensionStatuses": true
      }
    ]
  }
}
```

Explizite Positionierung neben `cost` via `powerline.layout`:

```jsonc
{
  "powerline": {
    "layout": {
      "left": ["model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost", "custom:provider-cost"]
    },
    "customItems": [
      { "id": "provider-cost", "statusKey": "realtime-provider-cost", "selfColorize": true }
    ]
  }
}
```

> **Wichtig:** `selfColorize: true` setzen, sonst entfernt Powerline die
> ANSI-Farbcodes des Items und färbt selbst ein – die dynamische Weiß/Gelb-Umschaltung
> ginge verloren.

## Installation

```bash
pi install ssh://git@gitea/FloezWerk/piagent-realtime-provider-cost.git
```

Lokal (Entwicklung):

```bash
pi -e ./extensions/realtime-provider-cost.ts
```

Nach Änderungen in einer laufenden Session: `/reload`.

## Befehle

| Befehl | Wirkung |
| --- | --- |
| `/provider-cost` bzw. `/provider-cost status` | Zustand, Währung, Icons, Lookup+Refresh-Intervall, Anzeige, Tag/Quelle, Cache-Alter in Prompts |
| `/provider-cost on` | Anzeige einschalten (persistiert) |
| `/provider-cost off` | Anzeige ausschalten (persistiert) |
| `/provider-cost toggle` | Umschalten (persistiert) |
| `/provider-cost refresh` | Wechselkurse neu laden |
| `/provider-cost currency <CODE>` | Anzeigewährung setzen (persistiert) |
| `/provider-cost icons <auto\|nerd\|ascii>` | Icon-Modus setzen (persistiert) |
| `/provider-cost color <spec>` | Standardfarbe setzen, z. B. `white`, `#ffd700`, `226`, `bold:yellow` (persistiert) |
| `/provider-cost switchColor <spec>` | Wechselfarbe (Providerwechsel) setzen (persistiert) |
| `/provider-cost lookup <on\|off\|refresh>` | Provider-Auflösung; `refresh` leert Provider- **und** Preis-Cache und löst neu auf |

## Konfiguration

In `~/.pi/agent/settings.json` unter dem Rootkey `realtime-provider-cost`
(analog zum Extension-Namen). Andere Keys bleiben unangetastet.

```jsonc
{
  "realtime-provider-cost": {
    "enabled": true,
    "currency": "EUR",
    "icons": "nerd",
    "color": "white",
    "switchColor": "bold:#ffd700",
    "lookupUpstreamProvider": true,
    "providerCacheRefreshPrompts": 10
  }
}
```

| Feld | Default | Beschreibung |
| --- | --- | --- |
| `enabled` | `true` | Anzeige ein/aus |
| `currency` | `"USD"` | `USD`, `CNY`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `CHF`, `INR`, `KRW` |
| `icons` | `"auto"` | `auto` (Terminal-Heuristik), `nerd`, `ascii` – `nerd`/`auto` nutzen `↑`/`↓`, `ascii` `in:`/`out:` |
| `color` | `"white"` | Standardfarbe: Palettenname, `#rrggbb` oder `0-255`, optional mit `bold:` |
| `switchColor` | `"bold:#ffd700"` | Farbe direkt nach erkanntem Providerwechsel |
| `lookupUpstreamProvider` | `true` | Provider-Auflösung aktiv (Routing-Constraint + Cache + Generation-API) |
| `providerCacheRefreshPrompts` | `10` | Nach so vielen **Prompts** (User-Turns) wird ein `generation`-Cacheeintrag erneuert (Routing-Einträge nie); `0` = immer neu auflösen |

### Icons

1. Env `PROVIDER_COST_NERD_FONTS=1` (nerd) / `=0` (ascii)
2. Config `icons`
3. `auto`: Heuristik wie Powerline (`GHOSTTY_RESOURCES_DIR` bzw.
   `TERM_PROGRAM`/`TERM` ∈ iterm, wezterm, kitty, ghostty, alacritty, kaku);

Viele Terminals setzen nur `TERM=xterm-256color` → `auto` liefert ASCII
(`in:`/`out:`); für Icons `icons: "nerd"` bzw. `/provider-cost icons nerd`.

### Rundung

Auf **maximal 4 Nachkommastellen** gerundet, überflüssige Nullen entfernt
(`$2`, `$12.5`, `$0.2896`).

## Abhängigkeiten

`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` und `@earendil-works/pi-tui`
werden von Pi gebündelt und sind daher nur als optionale `peerDependencies` deklariert.
Keine Laufzeit-Abhängigkeiten zu anderen Extensions.
