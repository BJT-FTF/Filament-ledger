# Filament Ledger

A small, offline-first Progressive Web App for tracking 3D-printer filament costs and spool remainder. Amounts are in Australian dollars; weights are in grams. There is no backend and no build step — open the files in a browser, or host the folder as static files.

## What’s included

- **Spools** — price paid, net grams, automatic cost per gram, remaining weight and value, manual remainder adjustments, finished/archived spools
- **Print log** — log grams from the slicer against a spool, auto cost, deduct remainder; edit or delete (grams are credited back)
- **Calculator** — quote a slice cost without logging it
- **Summary** — total spend, grams printed, cost by material / job / part, low-spool warnings (default 15%, configurable)
- **Backup** — export or import JSON; export the print log as CSV

Data is stored in this device’s browser (`localStorage`). Export a JSON backup before clearing site data or switching phones.

## Run locally

```bash
cd filament-pwa
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/

Service workers and “Add to Home Screen” require a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). `localhost` counts; a raw `file://` open does not, and neither does plain HTTP on another hostname.

## Host it so you can install it on a phone

Upload the folder (do not add a build step) to any static HTTPS host, for example:

- **GitHub Pages** — put these files in a repo (or `/docs`) and enable Pages
- **Netlify** or **Cloudflare Pages** — drag the folder in, or point the site at the repo

Then, on your phone, open the HTTPS URL and use the browser’s *Add to Home Screen* / *Install app* option. Once installed it works offline.

## Tests

```bash
node test-logic.js
```

Expected math: a $240 / 750 g spool is $0.32/g; a 145 g print costs $46.40; a 352 g print costs $112.64.
