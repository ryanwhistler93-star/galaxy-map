# Galaxy Map (Foundry VTT v14)

An Elite: Dangerous-style galaxy map scene. Close up it is fully 3D; as you zoom out the camera tilts until the map becomes a flat top-down chart.

## Install
**Recommended:** in Foundry go to *Add-on Modules → Install Module* and paste this manifest URL:

```
https://github.com/ryanwhistler93-star/galaxy-map/releases/latest/download/module.json
```

Foundry will then offer updates whenever a new release is published.

**Manual:** download `module.zip` from the [latest release](https://github.com/ryanwhistler93-star/galaxy-map/releases/latest) and unzip it so you have `Data/modules/galaxy-map/module.json`.

Then:
1. Enable **Galaxy Map** in your world's Manage Modules.
2. Create (or pick) a Scene, then in the Scenes sidebar **right-click → Toggle Galaxy Map**. A sample sector is generated the first time.
3. Activate / view the scene as normal. Players see it when they view that scene.

### three.js
The module loads three.js from `lib/three.module.js` if present, otherwise from the jsDelivr CDN.
For offline games, download `three.module.js` (v0.170.0) from
https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js and save it as `galaxy-map/lib/three.module.js`.

## Controls
- **W / A / S / D**: move forwards / left / backwards / right relative to the way the camera faces (hold **Shift** to move faster). Speed scales with zoom.
- Left-drag: pan · Right-drag: rotate / tilt. Keep dragging down to go below the galactic plane and look up at systems.
- Scroll: zoom (toward cursor). Zooming out flattens to a top-down chart (or bottom-up if you're below the plane). **Whole galaxy** resets the tilt.
- **Faction names** are written across their territory when you zoom out to the galaxy view, sized as large as possible while staying inside that faction's borders (wrapping onto 2–3 lines if that fits better). They update automatically when you paint, erase, rename or recolour a faction.
- **Names** only appear near your cursor, so crowded areas stay readable; overlapping names are thinned out (nearest to the cursor wins). The hovered/selected point and the party's location are always labelled. Hold **Alt** to show every name. Change the radius in Configure Settings → Galaxy Map: label radius (per player).
- Click a star system or fast-travel point for its info panel.

## GM tools (toolbar at top)
The editing tools are tucked away behind **Edit map** (pen-and-ruler button). Click it to show them and **Close editor** to hide them again; the toolbar remembers which you last used. Faction/brush controls only appear while Paint or Erase is selected, and the level controls only while adding systems or fast-travel points.

- **Paint / Erase**: pick a faction and brush size, then drag to claim territory. Borders glow, and are strongest in the top-down view.
- **Faction + / pen**: create, rename, recolour or delete factions.
- **Add system / Add fast-travel**: click empty space to place one (name, colour, size, height, notes, journal, hidden).
- **Levels**: in Add system / Add fast-travel mode a glowing level grid and a ghost preview follow your cursor. Press **↑ / ↓** (or the chevrons in the toolbar) to move the placement level up or down. While placing, the view is locked to the top-down whole-galaxy chart (no zoom, pan, rotate or WASD); switching back to another tool returns you to where you were. Each level is 20 units (2 ly), from -12 to +12.
- **Generate galaxy** (dice): random map from a seed. Choose shape (spiral, elliptical, irregular clusters, ring), arm count, number of systems, fast-travel points and factions, and vertical spread in levels. Same seed + settings = same galaxy. Replaces the current map.
- **Scatter systems** (wand): drag a box over part of the map, then enter how many systems to add and the lowest/highest level. They get random names and star colours, are spread out so they don't overlap existing systems or fast-travel points, and can be hidden from players. **Undo last scatter** removes the most recent batch.
- **Link routes**: click one fast-travel point then another to toggle a jump route between them.
- **Shift-drag** a point to move it. **Drag a Journal** from the sidebar onto a point to link it.
- **Info panel**: Edit, Hide/Reveal, Delete, *Party here*, and for fast-travel points a list of linked destinations:
  - eye: jump your own view there
  - rocket: move the party marker and jump everyone's view (warp effect)
- **Export / Import**: save the whole map (systems, fast-travel routes, factions, territory, galaxy shape, party location) as a `.json` file, or load one, replacing the current map. Also available by right-clicking a scene in the Scenes sidebar; importing into a normal scene turns it into a galaxy map. Journal and scene links only work in the world they were made in; scene links that don't exist in the new world are removed on import.
- **Show players my view**: pushes your camera to every player on the map.

## Linked scenes (system & station maps)
- Give any star system or fast-travel point a **Linked scene** in its Edit dialog, or drag a Scene from the sidebar onto the point. Linked points show an orange ▾ after their name.
- Info panel: **Enter** views the scene yourself; **Take party there** (GM) activates it for everyone and moves the party marker.
- **Double-click** a linked point: the GM takes the party there, players view it (if they have permission). **Alt+double-click** just flies the camera.
- Everyone sees a zoom-in and flash before the scene changes.
- **Shift+G** returns to the galaxy map from any linked scene (GM: for everyone). Rebind it in Configure Controls.

Distances: each map can set its own scale with `galaxy.lyPerUnit` in the JSON (light years per world unit). Without it, 10 units = 1 ly.

Hidden points and routes to hidden points are invisible to players.

## Macro API
```js
const gm = game.modules.get("galaxy-map").api;
gm.toggle();                         // toggle current scene
const json = gm.exportData();        // map data as an object
await gm.importData(json);           // load map data (object)
gm.exportFile();                     // download .json
gm.importFile();                     // pick a .json to load
await gm.resetSampleData();          // regenerate the demo sector
await gm.generate({ seed: "grudge", shape: "spiral", arms: 3, systems: 120, gates: 12, factions: 5, spread: 3 });
gm.returnToGalaxy();                 // back to the galaxy map (handy as a hotbar macro)
```

## Releasing a new version (maintainers)
1. Update `version` in `module.json` and commit.
2. On GitHub open **Actions → Release → Run workflow** (leave the version blank to use module.json's), *or* push a tag: `git tag v0.5.4 && git push origin v0.5.4`.
3. The **Release** GitHub Action builds `module.zip`, stamps the version and download link into `module.json`, and publishes both on a GitHub release. Foundry picks up the update from the manifest URL.
