# Digital Väntelista

PWA för hovmästare att hantera kö till bord. Ren frontend, all data lokalt i IndexedDB, fungerar offline.

## Köra lokalt
Service workers kräver `http(s)` (inte `file://`). Starta en enkel server i mappen:

```bash
cd vantelista
python3 -m http.server 8000
```

Öppna `http://<din-dator-ip>:8000` på iPaden (samma wifi).

## Installera på iPaden
1. Öppna sidan i **Safari**.
2. Dela-knappen → **Lägg till på hemskärmen**.
3. Starta från hemskärmsikonen → körs i helskärm, offline.

För skarp drift: lägg filerna på valfri statisk webbhost (HTTPS) så fungerar
installation och offline överallt. Allt sköts klient­sidan – ingen server­logik behövs.

## Funktioner
- Inmatning av telefon, namn, PAX, kommentar, bord, est. väntetid, Skugga/Brygga (alla valfria).
- **Ankomsttid** stämplas automatiskt när du börjar skriva telefonnummer.
- **Väntat**-kolumn räknar löpande och blir **röd** vid övertid mot estimatet.
- **Klick på telefonnummer** kopierar till urklipp (Handoff → klistra in/ring på iPhone).
- Bord ifyllt ⇒ raden blir **gul** tills Klart bockas.
- **Klart**: swipa raden åt vänster (eller tryck ✓) → flyttas direkt till Historik.
- **Gick utan bord** (rött ✕): kräver bekräftelse, flyttas sedan till Historik.
- Live-räknare: antal sällskap och antal personer i kö.
- **Spara** sparar direkt lokalt; autospar sker kontinuerligt.
- **Summera dagen**: totaler, snittväntetid, högsta samtidiga kö, snittstorlek,
  skugga/brygga-fördelning, antal som gick utan bord.
- **Exportera JSON/CSV** som backup. **Rensa dagen** efter export.

## Filer
- `index.html`, `styles.css` – gränssnitt (iPad-optimerat).
- `app.js` – all logik. `db.js` – IndexedDB-lager.
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA (hemskärm + offline).
