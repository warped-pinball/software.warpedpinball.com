# Warped Pinball Software Website

This repo powers the public firmware-update endpoints for Warped Pinball.

## Generating release data

Use `scripts/generate.py` to pull release information from GitHub and build the
JSON files served by GitHub Pages. Before running the script, install the
Python dependencies:

```bash
python3 -m pip install -r requirements.txt
```

Then execute the generator with a valid `GITHUB_TOKEN` environment variable.  
The site is published from the `docs/` directory, so write all generated files
there:

```bash
GITHUB_TOKEN=<token> python3 scripts/generate.py --owner warped-pinball --repo vector --out-dir docs
```

All firmware metadata files are published under a `vector/` prefix. For example,
the System 11 metadata can be downloaded from:

```
https://software.warpedpinball.com/vector/sys11/latest.json
```
Additional files like `prod.json`, `beta.json`, and `dev.json` live in the same
`vector/<product>` directory.

GitHub Pages is configured to publish from the `docs/` directory. The
repository includes a `CNAME` file so the site is served at
`https://updates.warpedpinball.com` without extra path segments.

## Browser USB flasher

`docs/flasher.html` is a client-side, in-browser replacement for the desktop
TrenchCoat tool. It flashes a Warped Pinball Vector board over a USB cable using
**WebUSB** (PICOBOOT) and **Web Serial** (MicroPython raw REPL) — no downloads
or drivers. It:

1. Detects the board model (Pico W / RP2040 vs Pico 2 W / RP2350) and the Vector
   game series by probing it over serial.
2. Erases the board with `nuke.uf2`.
3. Flashes the matching firmware UF2 for the detected model.
4. Pushes the selected software version over serial.

It feature-detects the required APIs up front and shows a clear message on
unsupported browsers (Firefox, Safari, anything on iOS/iPadOS). Supported
browsers are Chromium-based desktop browsers (Chrome, Edge, Brave, Opera) and
Android Chrome. The page must be served over HTTPS or `localhost` (a WebUSB /
Web Serial requirement).

### Firmware images (UF2)

The firmware images live in [`docs/firmware/`](docs/firmware/) and are managed
**by hand** — see that folder's `README.md` and `manifest.json`. Add or replace
a UF2 there and point the manifest at it when new firmware is released. They are
served same-origin at `https://software.warpedpinball.com/firmware/<file>.uf2`.

### Software images (update.json)

`scripts/generate.py` mirrors the **latest production** `update.json` for each
product into `docs/vector/<product>/update.json` so the flasher can fetch it
same-origin (GitHub release downloads send no CORS headers). Only the latest
production build is kept per product, so the repository does not accumulate old
copies. Users who need a specific older build can upload their own `update.json`
in the flasher UI.

### Pointing at new firmware

- **New firmware UF2:** drop it in `docs/firmware/`, update
  `docs/firmware/manifest.json`, and commit.
- **New software:** publish the release on `warped-pinball/vector`; the next sync
  run regenerates the mirrored `update.json`.

