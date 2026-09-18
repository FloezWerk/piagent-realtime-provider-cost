# piagent-realtime-provider-cost

Pi-Extension, die in der Statusleiste die **effektiven Tokenpreise (Input/Output,
pro 1 Mio. Tokens)** des Providers/Modells des **letzten API-Calls** anzeigt –
direkt neben der Session-Kostensumme.

```
󰜷$2/󰜺$12        # Nerd Font: nf-fa-sign_in / nf-fa-sign_out
in:$2/out:$12    # ASCII-Fallback
```

Werte sind **pro 1 Mio. Tokens** in der konfigurierten Währung.

## Funktionsweise

- **Effektiver Preis statt Katalogpreis.** Der Preis wird aus dem gemeldeten
  `usage.cost.*` der letzten Assistant-Nachricht abgeleitet:

  ```
  Preis(USD/Mtok) = usage.cost.<bucket> / usage.<bucket> * 1e6
  ```

  Dadurch sind Preistiers, Service-Tier-Multiplikatoren und providerabhängige
  Tarife automatisch korrekt enthalten.
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
| `/provider-cost` bzw. `/provider-cost status` | Zustand, Währung, aktuelle Anzeige, letztes Modell |
| `/provider-cost on` | Anzeige einschalten (persistiert) |
| `/provider-cost off` | Anzeige ausschalten (persistiert) |
| `/provider-cost toggle` | Umschalten (persistiert) |
| `/provider-cost refresh` | Wechselkurse neu laden |
| `/provider-cost currency <CODE>` | Anzeigewährung setzen (persistiert) |

Unbekannte Optionen werden mit einem Hinweis quittiert.

## Konfiguration

In `~/.pi/agent/settings.json` unter dem Rootkey `realtime-provider-cost`
(analog zum Extension-Namen). Andere Keys bleiben unangetastet.

```jsonc
{
  "realtime-provider-cost": {
    "enabled": true,
    "currency": "EUR"
  }
}
```

| Feld | Default | Beschreibung |
| --- | --- | --- |
| `enabled` | `true` | Anzeige ein/aus (per Slash-Command änderbar) |
| `currency` | `"USD"` | Eine von: `USD`, `CNY`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `CHF`, `INR`, `KRW` |

### Umgebungsvariablen

| Variable | Wirkung |
| --- | --- |
| `PROVIDER_COST_NERD_FONTS=1` | Nerd-Font-Icons erzwingen |
| `PROVIDER_COST_NERD_FONTS=0` | ASCII-Icons erzwingen (`in:`/`out:`) |

Ohne Override wird – wie in Powerline – anhand von `GHOSTTY_RESOURCES_DIR` bzw.
`TERM_PROGRAM`/`TERM` (iterm, wezterm, kitty, ghostty, alacritty, kaku) erkannt.

### Rundung

Auf **maximal 4 Nachkommastellen** gerundet, überflüssige Nullen werden entfernt
(`$2`, `$12.5`, `$0.2896`).

## Abhängigkeiten

`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` und `@earendil-works/pi-tui`
werden von Pi gebündelt und sind daher nur als optionale `peerDependencies` deklariert.
Es gibt keine Laufzeit-Abhängigkeiten zu anderen Extensions.
