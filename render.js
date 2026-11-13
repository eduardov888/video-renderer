#!/usr/bin/env node
/**
 * video-renderer — HyperFrames-style programmatic video renderer.
 *
 * Turns an HTML/JS animation into an MP4:
 *   HTML animation (driven by a virtual clock) -> headless Chrome screenshots
 *   one frame at a time -> ffmpeg stitches the frames to MP4.
 *
 * Deterministic by design: the animation NEVER reads wall-clock time.
 * The renderer injects a virtual clock (window.__RENDER_TIME__ in seconds,
 * window.__RENDER_FRAME__ as the frame index) and advances it one frame at a
 * time. The same HTML + duration + fps always produces the same video.
 *
 * Animation contract (see README.md):
 *   - Define window.__renderFrame(t) — called with t in seconds before every
 *     screenshot. Position everything from t (GSAP timelines: tl.time(t)).
 *   - OR use plain GSAP: if no __renderFrame hook exists, the renderer pauses
 *     gsap.globalTimeline and seeks it to t each frame.
 *   - performance.now() and Date.now() are overridden to follow the virtual
 *     clock, so code that reads them is deterministic too.
 *   - Do NOT use CSS animations/transitions or setInterval/setTimeout-driven
 *     motion — those run on real time and will not be deterministic.
 *
 * Speed (measured 2026-11-13 on this VM, 10s demo @ 1080x1920/30fps):
 *   - Screenshot options are the whole game: JPEG quality 80 +
 *     optimizeForSpeed + NO rAF wait captures at ~131 ms/frame, vs ~400
 *     ms/frame for the original (quality 92, rAF wait, no optimize flag).
 *     The rAF wait was proven pixel-identical to drop (mean abs diff 0.0).
 *   - Parallel capture does NOT work on this VM: 2 concurrent pages in one
 *     browser starved each other (1.5 shared CPUs, ~1.2 GB free RAM) and a
 *     screenshot timed out after 180 s. Sequential capture is the path.
 *   - --preview renders at 540x960 / 15 fps for fast iteration; render full
 *     quality once at the end.
 *
 * Usage:
 *   node render.js --html demos/kinetic-type.html --duration 10 --fps 30 \
 *     --size 1080x1920 --out demos/kinetic-type.mp4
 *   node render.js --html demos/kinetic-type.html --preview
 *   node render.js --html demos/kinetic-type.html --duration 10 --fps 30 \
 *     --out out.mp4 --audio music.wav --keep-frames
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TOOL_DIR = __dirname;
const DEFAULT_CHROME = path.join(
  process.env.HOME || '/home/hatch',
  'workspace/channels/luminal_prism/game-builds/qa-20261112',
  'chrome-extract/opt/google/chrome/chrome'
);
const DEFAULT_PUPPETEER = path.join(
  process.env.HOME || '/home/hatch',
  'workspace/channels/luminal_prism/game-builds/qa-20261112',
  'node_modules/puppeteer-core'
);

let puppeteer;
try {
  puppeteer = require(DEFAULT_PUPPETEER);
} catch (e) {
  puppeteer = require('puppeteer-core');
}

// ---------------------------------------------------------------- args ----
function parseArgs(argv) {
  const args = {
    html: null, duration: 10, fps: 30, size: '1080x1920',
    out: null, audio: null, keepFrames: false, framesDir: null,
    chrome: process.env.CHROME_PATH || DEFAULT_CHROME,
    preview: false, quality: 80, preset: 'veryfast',
    _fpsSet: false, _sizeSet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--html') args.html = next();
    else if (a === '--duration') args.duration = parseFloat(next());
    else if (a === '--fps') { args.fps = parseInt(next(), 10); args._fpsSet = true; }
    else if (a === '--size') { args.size = next(); args._sizeSet = true; }
    else if (a === '--out') args.out = next();
    else if (a === '--audio') args.audio = next();
    else if (a === '--frames-dir') args.framesDir = next();
    else if (a === '--chrome') args.chrome = next();
    else if (a === '--quality') args.quality = parseInt(next(), 10);
    else if (a === '--preset') args.preset = next();
    else if (a === '--preview') args.preview = true;
    else if (a === '--keep-frames') args.keepFrames = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); usage(); process.exit(1); }
  }
  if (!args.html) { console.error('Missing --html'); usage(); process.exit(1); }
  if (args.preview) {
    // Fast iteration defaults; explicit --fps / --size still win.
    if (!args._sizeSet) args.size = '540x960';
    if (!args._fpsSet) args.fps = 15;
  }
  if (!args.out) {
    const base = args.html.replace(/\.html?$/i, '');
    args.out = args.preview ? `${base}-preview.mp4` : `${base}.mp4`;
  }
  return args;
}

function usage() {
  console.log(`
Usage: node render.js --html <file.html> [options]
  --duration <s>    video length in seconds (default 10)
  --fps <n>         frames per second (default 30)
  --size <WxH>      output resolution (default 1080x1920)
  --out <file.mp4>  output path (default: <html>.mp4, or <html>-preview.mp4 with --preview)
  --audio <file>    optional soundtrack (wav/mp3) muxed in, AAC 160k
  --frames-dir <d>  where to keep frame images (default: .frames/ under the tool dir, deleted after)
  --keep-frames     keep the frame JPEGs after render
  --chrome <path>   Chrome binary (default: QA Chrome in game-builds)
  --preview         fast iteration render: 540x960 @ 15 fps (explicit --fps/--size override)
  --quality <n>     JPEG capture quality 1-100 (default 80; the final encode is CRF 18 anyway)
  --preset <name>   x264 preset for the stitch (default veryfast; medium is slower, same CRF)
`);
}

// ------------------------------------------------------- static server ----
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function startServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
      // Never serve outside the root.
      if (!filePath.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------------ main --
async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();

  const htmlPath = path.resolve(args.html);
  if (!fs.existsSync(htmlPath)) { console.error(`HTML file not found: ${htmlPath}`); process.exit(1); }
  if (args.audio && !fs.existsSync(args.audio)) { console.error(`Audio file not found: ${args.audio}`); process.exit(1); }
  if (!fs.existsSync(args.chrome)) { console.error(`Chrome binary not found: ${args.chrome}`); process.exit(1); }

  const [width, height] = args.size.split('x').map(Number);
  const totalFrames = Math.round(args.duration * args.fps);
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Frames live on the workspace disk, NOT /tmp: /tmp is a 512 MB tmpfs that
  // has been observed 100% full, and frame dirs there vanished between runs.
  const framesDir = args.framesDir
    ? path.resolve(args.framesDir)
    : fs.mkdtempSync(path.join(TOOL_DIR, '.frames', `vrender-`));
  fs.mkdirSync(framesDir, { recursive: true });
  const pad = String(totalFrames).length;

  // Serve the animation over localhost so relative assets (GSAP, images)
  // load with no file:// quirks and no network dependency.
  const root = htmlPath.startsWith(TOOL_DIR) ? TOOL_DIR : path.dirname(htmlPath);
  const server = await startServer(root);
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/${path.relative(root, htmlPath).split(path.sep).join('/')}`;

  console.log(`[render] ${htmlPath}`);
  console.log(`[render] ${args.duration}s @ ${args.fps}fps = ${totalFrames} frames, ${width}x${height}${args.preview ? ' [PREVIEW]' : ''} -> ${outPath}`);
  console.log(`[render] capture: JPEG q${args.quality} + optimizeForSpeed, preset ${args.preset}`);

  const browser = await puppeteer.launch({
    executablePath: args.chrome,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--hide-scrollbars',
      '--disable-background-networking', '--no-first-run',
      '--disable-default-apps', '--force-device-scale-factor=1',
      '--mute-audio',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error') console.log(`[page:error] ${m.text()}`); });
    page.on('pageerror', (e) => console.log(`[page:error] ${e.message}`));

    // Virtual clock, installed before any page script runs.
    await page.evaluateOnNewDocument(() => {
      window.__RENDER_TIME__ = 0;
      window.__RENDER_FRAME__ = 0;
      window.__RENDER_EPOCH__ = Date.now();
      performance.now = () => (window.__RENDER_TIME__ || 0) * 1000;
      Date.now = () => (window.__RENDER_EPOCH__ || 0) + (window.__RENDER_TIME__ || 0) * 1000;
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 500)); // let fonts/layout settle

    // Freeze GSAP's real-time ticker so nothing moves on wall-clock.
    await page.evaluate(() => {
      if (window.gsap) {
        try { window.gsap.globalTimeline.pause(); } catch (e) {}
        try { window.gsap.ticker.sleep(); } catch (e) {}
      }
    });

    // ---- capture frames (sequential; parallel pages time out on this VM) ----
    // No rAF wait between seek and screenshot: the screenshot itself forces
    // a compositor commit, and dropping the wait was measured pixel-identical
    // (mean abs diff 0.0 on the same frame). optimizeForSpeed skips the
    // extra surface copy; quality 80 is plenty since the final encode is
    // CRF 18 anyway.
    const shot0 = Date.now();
    for (let i = 0; i < totalFrames; i++) {
      const t = i / args.fps;
      const frameFile = path.join(framesDir, `frame_${String(i + 1).padStart(pad, '0')}.jpg`);
      await page.evaluate((tt, ii) => {
        window.__RENDER_TIME__ = tt;
        window.__RENDER_FRAME__ = ii;
        if (typeof window.__renderFrame === 'function') {
          window.__renderFrame(tt);
        } else if (window.gsap) {
          window.gsap.globalTimeline.time(tt);
        }
      }, t, i);
      await page.screenshot({ type: 'jpeg', quality: args.quality, optimizeForSpeed: true, path: frameFile });
      if ((i + 1) % 30 === 0 || i === totalFrames - 1) {
        const el = ((Date.now() - shot0) / 1000).toFixed(1);
        console.log(`[render] frame ${i + 1}/${totalFrames} (${el}s elapsed)`);
      }
    }
    const shotSecs = (Date.now() - shot0) / 1000;
    console.log(`[render] captured ${totalFrames} frames in ${shotSecs.toFixed(1)}s (${(shotSecs / totalFrames * 1000).toFixed(0)} ms/frame)`);
  } finally {
    await browser.close();
    server.close();
  }

  // ---- stitch with ffmpeg ----
  const ffArgs = [
    '-y',
    '-framerate', String(args.fps),
    '-i', path.join(framesDir, `frame_%0${pad}d.jpg`),
  ];
  if (args.audio) ffArgs.push('-i', path.resolve(args.audio));
  ffArgs.push(
    '-c:v', 'libx264', '-preset', args.preset, '-pix_fmt', 'yuv420p', '-crf', '18',
    '-r', String(args.fps),
    '-movflags', '+faststart',
  );
  if (args.audio) {
    ffArgs.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
  } else {
    ffArgs.push('-an');
  }
  ffArgs.push(outPath);

  console.log(`[render] stitching: ffmpeg ${ffArgs.join(' ')}`);
  const ff0 = Date.now();
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        console.error(stderr.slice(-2000));
        reject(new Error(`ffmpeg exited ${code}`));
      } else resolve();
    });
  });
  console.log(`[render] stitch done in ${((Date.now() - ff0) / 1000).toFixed(1)}s`);

  if (!args.keepFrames && !args.framesDir) {
    fs.rmSync(framesDir, { recursive: true, force: true });
  } else if (args.keepFrames) {
    console.log(`[render] frames kept in ${framesDir}`);
  }

  const totalSecs = (Date.now() - t0) / 1000;
  const sizeMB = (fs.statSync(outPath).size / 1e6).toFixed(2);
  console.log(`[render] DONE ${outPath} (${sizeMB} MB) in ${totalSecs.toFixed(1)}s total`);
}

main().catch((e) => { console.error('[render] FATAL', e); process.exit(1); });
