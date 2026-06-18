# Firmware (UF2) images for the browser flasher

This folder holds the **firmware / OS images** that the in-browser flasher
([`/flasher.html`](../flasher.html)) writes to a Warped Pinball Vector board
over USB. These are the same `.uf2` files that the desktop TrenchCoat tool
bundles.

Unlike the software `update.json` files (which are synced automatically by
`scripts/generate.py`), **these UF2 images are managed by hand.** Add or replace
them here as new firmware is released.

## Files

| File | Purpose |
| --- | --- |
| `nuke.uf2` | Legacy universal flash-erase image (a RAM program). The **browser flasher no longer uses this** — it erases the whole flash directly over PICOBOOT — but it is kept for reference / the desktop tool. |
| `vector_system_11_and_9_v4.uf2` | System 9 / 11 OS — **Pico W (RP2040)**. |
| `Vector_WPC_v5.uf2` | WPC OS — **Pico 2 W (RP2350)**. Also used by the EM series. |
| `Vector_DataEast_v1.uf2` | Data East OS — **Pico 2 W (RP2350)**. |

## Updating

1. Drop the new `.uf2` into this folder.
2. Update [`manifest.json`](./manifest.json) so the flasher points each game
   series at the right file. The `processor` field **must** match the silicon
   the UF2 targets:
   - `rp2040` → Pico W
   - `rp2350` → Pico 2 W

   The flasher reads the family ID baked into the UF2 and refuses to flash an
   image whose processor does not match the connected board, so a wrong
   `processor` value here will surface as a clear error rather than a brick.
3. Commit. GitHub Pages serves the file at
   `https://software.warpedpinball.com/firmware/<file>.uf2`.

There is no automation that prunes this folder, so delete superseded images
yourself if you want to keep the repo small.
