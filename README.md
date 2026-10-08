# Pyde Image Optimizer

A Figma plugin that shrinks oversized images to the pixel size they are actually displayed at (2x / 3x / 4x). It only changes the pixel size: PNGs stay PNG, JPEGs stay JPEG.

## Install

1. In Figma: Plugins → Development → Import plugin from manifest… → select `manifest.json`.
2. The plugin shows up under Plugins → Development → Pyde Image Optimizer.

## Use

1. **Save a version first** (File → Save to version history).
2. Pick a **scope**: Selection, This page or Whole file. Selecting a frame or section switches the scope to Selection automatically.
3. Pick a **target resolution**. 3x is recommended; 2x can look blurry on 3x phone screens.
4. Pick a **file size** threshold (100 KB+, 500 KB+, 1 MB+). Only images at least that heavy, and at least 10% bigger than needed, are listed.
5. Click **Scan**. Results are sorted by file size, each with a thumbnail and its estimated saving. The estimate is refined to the real number as each image is measured.
6. Click a result to jump to the layer. If the image is used in several places, each click jumps to the next use.
7. Untick what you want to keep and click **Optimize**. One ⌘Z / Ctrl+Z undoes the whole run.

The interface can be switched between English and Turkish in Settings.

## How it works

- Each image's pixel size is compared with the size of the layer it fills, taking the fill mode (Fill / Fit / Crop / Tile) into account.
- When the same image is used in several places, the largest use decides the target size and every use is updated at once.
- The format is kept. PNGs stay lossless. A resized JPEG has to be saved again as JPEG; it is saved at high quality (92) so the difference isn't visible.
- If the resized image isn't smaller than the original, it is marked "No saving" and left alone.
- GIFs are skipped so their animation isn't lost.
- No network access; everything runs on your computer.

## Limits

- Images inside a published library component can't be changed from this file. Run the plugin in the library file instead.
- Figma may not shrink the file right away; old images stay in version history for a while.
