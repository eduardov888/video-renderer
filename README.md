# video-renderer

A HyperFrames-style programmatic video renderer: **HTML/JS animation → MP4**, $0, no accounts, no API keys, everything local on the VM.

```
HTML animation (virtual clock) → headless Chrome screenshots, one frame at a time
                            → ffmpeg stitches frames to MP4 (libx264, yuv420p)
```

Built 2026-11-13 for @utilisai tutorial videos and @luminal.prism motion content, after Eduardo chose the free route over Higgsfield. This is how Fable 5.2 "makes videos" — animation code rendered to frames — done without Fable.

## Requirements

All already on the VM, nothing to install:

| Tool | Version used | Where |
|---|---|---|
| Node | v24.22.1 | `node` |
| Chrome (headless) | QA Chrome binary | `~/workspace/channels/luminal_prism/game-builds/qa-20261112/chrome-extract/opt/google/chrome/chrome` |
| puppeteer-core | 23.11.1 | `~/workspace/channels/luminal_prism/game-builds/qa-20261112/node_modules/puppeteer-core` |
| ffmpeg | 8.1.2 | `ffmpeg` |
| GSAP (vendored) | 3.13.0 | `vendor/gsap.min.js` — local copy, no CDN dependency |

## Usage

```bash
cd ~/workspace/tools/video-renderer

# RECOMMENDED WORKFLOW: preview first, full render last
node render.js --html demos/kinetic-type.html --duration 10 --preview   # 540x960 @ 15 fps, ~15 s
node render.js --html demos/kinetic-type.html --duration 10 --fps 30 \
  --size 1080x1920 --out demos/kinetic-type.mp4                         # full quality, ~37 s

# Basic: 10s vertical video at 30fps
node render.js --html demos/kinetic-type.html --duration 10 --fps 30 \
  --size 1080x1920 --out demos/kinetic-type.mp4

# With a soundtrack
node render.js --html demos/kinetic-type.html --duration 10 --fps 30 \
  --out out.mp4 --audio music.wav

# 24fps, keep the frame images for inspection
node render.js --html demos/my-anim.html --duration 20 --fps 24 \
  --out my-anim.mp4 --keep-frames --frames-dir /tmp/my-frames
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--html` | (required) | Animation HTML file |
| `--duration` | 10 | Video length in seconds |
| `--fps` | 30 | Frames per second |
| `--size` | 1080x1920 | Output resolution `WxH` |
| `--out` | `<html>.mp4` | Output MP4 path (`<html>-preview.mp4` with `--preview`) |
| `--audio` | — | Soundtrack file (wav/mp3), muxed AAC 160k |
| `--frames-dir` | `.frames/` under tool dir | Where frame JPEGs go (auto-deleted unless kept) |
| `--keep-frames` | off | Keep frame JPEGs after render |
| `--chrome` | QA Chrome | Chrome binary path (or `CHROME_PATH` env) |
| `--preview` | off | Fast iteration: 540x960 @ 15 fps (explicit `--fps`/`--size` override) |
| `--quality` | 80 | JPEG capture quality 1–100 (final encode is CRF 18 anyway) |
| `--preset` | veryfast | x264 preset for the stitch (medium is ~2x slower, same CRF) |

Output: H.264, yuv420p, CRF 18, `+faststart`, silent unless `--audio` is given.

## How to write an animation HTML

### The virtual-clock contract

The renderer is **deterministic**: the animation never reads wall-clock time. Before every screenshot the renderer sets:

- `window.__RENDER_TIME__` — time in seconds (frame index / fps)
- `window.__RENDER_FRAME__` — frame index (0-based)

and then calls your hook if it exists:

```js
window.__renderFrame = function (t) {
  // Position EVERYTHING from t. This runs before every screenshot.
  myTimeline.time(t);
  progressBar.style.width = (t / DURATION * 100) + "%";
};
```

`performance.now()` and `Date.now()` are overridden to follow the virtual clock, so code that reads them is deterministic too.

### Two supported styles

**1. `__renderFrame` hook (recommended).** Full control. Example from the demo:

```js
const tl = gsap.timeline({ paused: true });
tl.fromTo("#w1", { scale: 2.2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4 }, 0.15)
  .fromTo("#w2", { x: -500, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4 }, 0.65);

window.__renderFrame = function (t) {
  tl.time(t);                       // seek the GSAP timeline to t
  bg.style.backgroundPosition = (t / 10 * 100) + "% 0%";   // moving gradient
  blob.style.transform = "translate(" + Math.sin(t * 0.9) * 130 + "px, 0)"; // sine path
};
```

**2. Plain GSAP, no hook.** If you don't define `__renderFrame`, the renderer pauses `gsap.globalTimeline`, sleeps GSAP's ticker, and seeks the global timeline to `t` each frame. Any GSAP tweens/timelines you create on the global timeline just work. (Useful for quick one-off animations.)

### Rules (they matter)

- **Position everything from `t`.** Use `tl.time(t)`, `gsap.set`, or direct `style` writes computed from `t` (e.g. `Math.sin(t * speed)`).
- **Never use CSS animations or transitions** for motion — they run on real time and will freeze or drift between frames.
- **Never use `setInterval`/`setTimeout` for motion** — same reason.
- **GSAP is available locally**: `<script src="../vendor/gsap.min.js"></script>` (relative to your HTML file under this tool dir). The renderer serves the whole tool directory over localhost, so relative paths to `vendor/`, images, and fonts all resolve. No CDN, no network.
- **Fonts**: use system font stacks (`Arial Black`, `Helvetica Neue`, Arial, sans-serif) unless you vendor a font file locally — no webfont downloads at render time.
- **Sizing**: the page viewport is exactly `--size`. Set `html, body { width: 1080px; height: 1920px; overflow: hidden; }` to match.
- Keep the page self-contained: one HTML file + local assets. External URLs will fail or hang (no network guarantee in headless Chrome here).

### What the renderer does per frame

1. Sets `window.__RENDER_TIME__` / `window.__RENDER_FRAME__`.
2. Calls `__renderFrame(t)` (or seeks the GSAP global timeline).
3. Waits one `requestAnimationFrame` tick so the compositor applies the state.
4. Screenshots the viewport to JPEG (quality 92).

Then ffmpeg stitches: `ffmpeg -framerate <fps> -i frame_%04d.jpg -c:v libx264 -preset veryfast -pix_fmt yuv420p -crf 18 -r <fps> -movflags +faststart <out.mp4>` (plus `-i <audio> -c:a aac -b:a 160k -shortest` when `--audio` is given).

## Render cost (measured)

Demo: 10s @ 30fps, 1080x1920, 300 frames.

| | Before (v1, 2026-11-13) | Before (re-measured) | After (optimized) |
|---|---|---|---|
| Capture | 196.1 s (654 ms/frame) | 118.5 s (395 ms/frame) | **24.7 s (82 ms/frame)** |
| ffmpeg stitch | 39.3 s (preset medium) | 47.4 s (preset medium) | **9.9 s (preset veryfast)** |
| **Total** | **249.1 s** | **178.2 s** | **36.6 s** |

**Speedup: 4.9x vs the re-measured baseline (6.8x vs the original 249.1 s).** A 90 s @utilisai video now costs roughly 5 minutes instead of 35–40.

Preview mode (`--preview`, 540x960 @ 15 fps): the same 10 s demo renders in **15.0 s total** (150 frames @ 64 ms/frame + 1.7 s stitch). Use it to iterate on motion, then run one full-quality render at the end.

### What made it faster (each measured, not guessed)

1. **Screenshot options (the big one, ~3x on capture).** JPEG quality 80 + `optimizeForSpeed: true` captures at ~131 ms/frame vs ~400 ms/frame for the original (quality 92, no optimize flag) on identical sequential frames. The final encode is CRF 18 anyway, so the lower capture quality is invisible in the output (new vs old demo: PSNR 39 dB, mean abs diff 0.3/255).
2. **Dropping the rAF wait.** The screenshot itself forces a compositor commit, so waiting one `requestAnimationFrame` tick before each capture was pure overhead. Proven pixel-identical: same frame with/without the wait, mean abs diff 0.0.
3. **ffmpeg preset veryfast.** Same 300 frames: 9.9 s vs 19.6 s for medium, output 3.02 MB vs 3.08 MB, PSNR 44–45 dB between the two encodes (visually indistinguishable). Default is now veryfast.
4. **Frames live on workspace disk, not /tmp.** `/tmp` is a 512 MB tmpfs that was observed 100% full, and frame dirs there vanished between runs. Default is now `.frames/` under the tool dir (auto-deleted after render).

### What did NOT work: parallel capture

Tried and measured, then dropped. Two Chrome pages in one browser capturing concurrently starved each other (1.5 shared CPUs, ~1.2 GB free RAM) and a screenshot timed out after 180 s, while a single sequential page captures at 72–82 ms/frame. On this VM, sequential capture is the path; do not re-add workers without re-measuring.

### Practical consequences

- **Render at 24 fps when you can** (20% fewer frames).
- **Preview first, full render last** — `--preview` is ~12x cheaper than a full render for the same 10 s of video.
- **Keep scenes simple** is no longer the main lever: the cost is per screenshot, and screenshots are now cheap. A busy scene costs about the same as a plain one.
- The demo HTML now includes `<link rel="icon" href="data:,">`, which silences the harmless favicon 404 that used to appear as a `[page:error]` line.

## Demo

`demos/kinetic-type.html` → `demos/kinetic-type.mp4` (10 s, 1080x1920, 30 fps).

Proves the pipeline: kinetic type (words slam/slide in with GSAP easing), a moving gradient background, floating blobs on sine paths, an animated bar diagram (bars grow), a progress bar filling over the full 10 s, and the UTILIS AI logo/CTA reveal. Bright, bold, full-bleed utilisai style.

## Files

```
~/workspace/tools/video-renderer/
  render.js                  the renderer (Node + puppeteer-core + ffmpeg)
  README.md                  this file
  vendor/gsap.min.js         GSAP 3.13.0 (local, no CDN)
  demos/kinetic-type.html    demo animation
  demos/kinetic-type.mp4     demo output (full quality, 10 s, 1080x1920, 30 fps)
  demos/kinetic-type-preview.mp4   demo output (preview, 10 s, 540x960, 15 fps)
  .frames/                   temp frame storage (auto-created, auto-deleted)
```
