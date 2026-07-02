# Real 3D models (all CC0 — free for commercial use)

The game loads `.glb` models from these folders and re-skins the whole city.
If a file is missing, that object falls back to a procedural mesh, so the game always runs.

## What's installed

| Folder      | Kit (Kenney, CC0)            | Used for                                  |
|-------------|------------------------------|-------------------------------------------|
| `cars/`     | Car Kit                      | traffic — 12 random vehicles              |
| `city/`     | City Kit Commercial          | buildings (small / mid / skyscraper tiers)|
| `nature/`   | Nature Kit                   | trees & bushes                            |
| `factory/`  | Factory Kit (a few props)    | spare industrial props for later          |

Cars and city buildings share a `Textures/colormap.png` atlas inside their folder —
keep that `Textures/` folder next to the `.glb` files or the models load untextured.
Nature `.glb` files are self-contained (textures embedded).

## Tier mapping (edit the `ASSETS` block in index.html to change)

- person → tiny · 1 pt   (still procedural — add a People kit to upgrade)
- streetlight → procedural lamp · 2 pts
- tree → `nature/` · 7 pts
- car → `cars/` · 4 pts
- building_small → `city/low-detail-building-*` · 7 pts
- building_mid → `city/building-*` · 18 pts
- skyscraper → `city/building-skyscraper-*` · 50 pts

To add or swap models, drop `.glb` files into the right folder and add their paths to that
kind's `variants` list in index.html. The loader auto-scales each model to the correct size.

## IMPORTANT — run over http, not file://

Browsers block loading `.glb`/`.png` over `file://`. To see real models, serve the folder:

    python3 -m http.server 8000      # from the folder containing index.html
    # then open  http://localhost:8000/

When models load, the lobby tag flips from amber (procedural) to green (real models loaded).

## New in this build
- **Endurance (count-up) mode** alongside Countdown — pick it in the lobby ("Clock").
- **Void skin picker** — choose your hole's color in the lobby before playing.

Credit "Kenney" / www.kenney.nl is appreciated (not required under CC0).
