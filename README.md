# piagent-realtime-provider-cost

Pi-Extension, die in der Statusleiste die **effektiven Tokenpreise (Input/Output,
pro 1 Mio. Tokens)** des Providers/Modells des **letzten API-Calls** anzeigt –
direkt neben der Session-Kostensumme.

Format: `<in>/<out>` plus optionales Provider-Tag **hinten**.
Das Tag sind die ersten 3 Zeichen des Serving-Providers und wird **nur** bei
OpenRouter angehängt, sobald der echte Provider aufgelöst ist (z. B. `Fir` →
Fireworks). Sonst wird die Providerinfo ausgeblendet.

```
󰜷$2/󰜺$12 (Fir)    # Nerd Fonts (nf-fa-sign_in / nf-fa-sign_out), Upstream = Fireworks
in:$2/out:$12       # ASCII, kein Tag (Upstream unbekannt oder kein OpenRouter)
```

> Hinweis: Die Nerd-Font-Glyphen sind Private-Use-Codepoints (`U+F090`, `U+F08B`)
> und werden nur mit passender Font korrekt dargestellt.

Werte sind **pro 1 Mio. Tokens** in der konfigurierten Währung.

## Funktionsweise

- **Effektiver Preis statt Katalogpreis.** Der Preis wird aus dem gemeldeten
  `usage.cost.*` der letzten Assistant-Nachricht abgeleitet:

  ```
  Preis(USD/Mtok) = usage.cost.<bucket> / usage.<bucket> * 1e6
  ```

  Dadurch sind Preistiers, Service-Tier-Multiplikatoren, providerabhängige Tarife
  und OpenRouter-Routing automatisch enthalten. Das Provider-Tag macht das
  überprüfbar.
- **Upstream-Provider (OpenRouter).** Pi liefert für erfolgreiche Calls keinen
  Serving-Provider. Die Extension fragt daher best-effort
  `GET https://openrouter.ai/api/v1/generation?id=<responseId>` ab und zeigt
  `data.provider_name` (z. B. `Fireworks`). Diese Daten sind erst einige Sekunden
  nach dem Call verfügbar → Retry mit Backoff (1s/2s/4s/8s). Bis dahin und bei
  fehlgeschlagenem Lookup wird **kein** Tag angezeigt (nicht `(ope)`). Das Tag
  erscheint ausschließlich für `provider == "openrouter"`; bei allen anderen
  Providern wird die Providerinfo ausgeblendet. Abschaltbar via
  `lookupUpstreamProvider` bzw. `/provider-cost lookup off`.
- **Nur Input/Output** (kein Cache-Read/Write).
- **Während des Streamings** bleibt der zuletzt bekannte Wert stehen; aktualisiert
  wird erst bei `message_end` (abgeschlossener API-Call).
- **Failover:** Ist eine Seite nicht berechenbar (z. B. `usage.input == 0` bei reinem
  Cache-Treffer) oder fehlt der Umrechnungskurs, wird pro Seite `?` angezeigt.
- **Subscription-Provider** (OAuth-basiert bzw. `kimi-coding`) → Element wird
  komplett ausgeblendet.
- **Gratismodelle** werden als `$0/$0` angezeigt.
- **Währungsumrechnung** analog `pi-powerline-footer` (gleiche Quelle, 24h-Cache,
  eigene Cachedatei unter `~/.pi/agent/realtime-provider-cost/currency-rates.json`).
  Die Extension bleibt dabei unabhängig – es wird nichts aus Powerline importiert.

## Integration

### Ohne pi-powerline-footer

Funktioniert eigenständig. `ctx.ui.setStatus` ist eine Core-API; der Core-Footer
zeigt den Wert als eigene Zeile an. Kein Fehler, nur keine „neben `cost`“-Position.

### Mit pi-powerline-footer (empfohlen)

Der Status wird über den Key `realtime-provider-cost` veröffentlicht. In
`settings.json` als eigenes Powerline-Segment platzieren (Standard: rechts, wird an
die Preset-Gruppe angehängt, also nach `cost`):

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

Explizite Positionierung neben `cost` ist über `powerline.layout` möglich:

```jsonc
{
  "powerline": {
    "layout": {
      "left": ["model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost", "custom:provider-cost"]
    },
    "customItems": [
      { "id": "provider-cost", "statusKey": "realtime-provider-cost" }
    ]
  }
}
```

## Installation

Als Pi-Package:

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
| `/provider-cost` bzw. `/provider-cost status` | Zustand, Währung, Icon-Modus, Lookup, aktuelle Anzeige, letztes Modell/Provider |
| `/provider-cost on` | Anzeige einschalten (persistiert) |
| `/provider-cost off` | Anzeige ausschalten (persistiert) |
| `/provider-cost toggle` | Umschalten (persistiert) |
| `/provider-cost refresh` | Wechselkurse neu laden |
| `/provider-cost currency <CODE>` | Anzeigewährung setzen (persistiert) |
| `/provider-cost icons <auto\|nerd\|ascii>` | Icon-Modus setzen (persistiert) |
| `/provider-cost lookup <on\|off>` | Upstream-Provider-Auflösung für OpenRouter (persistiert) |

Unbekannte Optionen werden mit einem Hinweis quittiert.

## Konfiguration

In `~/.pi/agent/settings.json` unter dem Rootkey `realtime-provider-cost`
(analog zum Extension-Namen). Andere Keys bleiben unangetastet.

```jsonc
{
  "realtime-provider-cost": {
    "enabled": true,
    "currency": "EUR",
    "icons": "nerd",
    "lookupUpstreamProvider": true
  }
}
```

| Feld | Default | Beschreibung |
| --- | --- | --- |
| `enabled` | `true` | Anzeige ein/aus (per Slash-Command änderbar) |
| `currency` | `"USD"` | Eine von: `USD`, `CNY`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `CHF`, `INR`, `KRW` |
| `icons` | `"auto"` | `auto` (Terminal-Heuristik), `nerd`, `ascii` |
| `lookupUpstreamProvider` | `true` | OpenRouter-Serving-Provider über die Generation-API auflösen (zusätzlicher HTTP-Request mit dem Provider-Key) |

### Icons

Icon-Auswahl in dieser Reihenfolge (höchste Priorität zuerst):

1. Env `PROVIDER_COST_NERD_FONTS=1` (nerd) bzw. `=0` (ascii)
2. Config `icons`: `nerd` / `ascii`
3. `auto`: Heuristik wie Powerline (`GHOSTTY_RESOURCES_DIR` bzw.
   `TERM_PROGRAM`/`TERM` ∈ iterm, wezterm, kitty, ghostty, alacritty, kaku)

Achtung: Viele Terminals setzen nur `TERM=xterm-256color` (z. B. VS Code
Integrated Terminal). Dann liefert `auto` ASCII (`in:`/`out:`) – für echte Icons
`icons: "nerd"` setzen oder `/provider-cost icons nerd`.

### Rundung

Auf **maximal 4 Nachkommastellen** gerundet, überflüssige Nullen werden entfernt
(`$2`, `$12.5`, `$0.2896`).

## Abhängigkeiten

`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` und `@earendil-works/pi-tui`
werden von Pi gebündelt und sind daher nur als optionale `peerDependencies` deklariert.
Es gibt keine Laufzeit-Abhängigkeiten zu anderen Extensions.
