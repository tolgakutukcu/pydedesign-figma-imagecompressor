// Image Optimizer: downsizes image fills to the size they are actually displayed at.
// Runs in Figma's plugin sandbox. Pixel work happens in ui.html (canvas).
//
// Only the pixel size changes: PNGs stay PNG, JPEGs stay JPEG. If the resized image isn't smaller
// than the original, it is left alone.

figma.showUI(__html__, { width: 360, height: 600, themeColors: true });

const LANG_KEY = 'pyde-optimizer-lang';
const PREFS_KEY = 'pyde-optimizer-prefs';
// Selecting one of these switches the scope to "Selection" automatically.
const CONTAINER_TYPES = ['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP'];
// An image is listed only when it is at least this much bigger than needed (factor < 0.9 = 10%+).
const MIN_REDUCTION = 0.9;

// hash -> { hash, imgW, imgH, bytes, format, factor, targetW, targetH, nodes: [{id, name, page}] }
let lastScan = new Map();
let runId = 0; // bumped on every scan / apply, so an outdated preview loop stops
const pendingResizes = new Map();  // hash -> resolve fn
const pendingPreviews = new Map(); // hash -> resolve fn
let focusedId = null; // the layer we last selected ourselves (Go to layer)

let lang = 'en';
function t(en, tr) { return lang === 'tr' ? tr : en; }

function needFactorForPaint(node, paint, imgW, imgH, scale) {
  let w = node.width;
  let h = node.height;
  if (!w || !h) return null;
  const rot = ((paint.rotation || 0) % 180 + 180) % 180;
  if (rot === 90) { const t = w; w = h; h = t; }

  let s;
  switch (paint.scaleMode) {
    case 'FILL':
      s = Math.max(w / imgW, h / imgH);
      break;
    case 'FIT':
      s = Math.min(w / imgW, h / imgH);
      break;
    case 'CROP': {
      const t = paint.imageTransform;
      if (!t) { s = Math.max(w / imgW, h / imgH); break; }
      // imageTransform maps node space (0..1) to image space (0..1).
      const sx = Math.hypot(t[0][0], t[1][0]) || 1;
      const sy = Math.hypot(t[0][1], t[1][1]) || 1;
      s = Math.max(w / (sx * imgW), h / (sy * imgH));
      break;
    }
    case 'TILE':
      s = paint.scalingFactor || 1;
      break;
    default:
      s = Math.max(w / imgW, h / imgH);
  }
  return s * scale;
}

async function collectNodes(scope) {
  const nodes = [];
  const pushTree = (root, pageName) => {
    const visit = (n) => {
      if ('fills' in n) nodes.push({ node: n, page: pageName });
      if ('children' in n) for (const c of n.children) visit(c);
    };
    visit(root);
  };

  if (scope === 'selection') {
    for (const n of figma.currentPage.selection) pushTree(n, figma.currentPage.name);
  } else if (scope === 'page') {
    for (const n of figma.currentPage.children) pushTree(n, figma.currentPage.name);
  } else {
    await figma.loadAllPagesAsync();
    for (const page of figma.root.children) {
      for (const n of page.children) pushTree(n, page.name);
    }
  }
  return nodes;
}

function formatOf(bytes) {
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'GIF';
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E) return 'PNG';
  if (bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'JPEG';
  return '';
}

async function scan(scope, scale, minBytes) {
  const id = ++runId;
  const entries = await collectNodes(scope);
  const byHash = new Map();
  const sizeCache = new Map();
  let processed = 0;

  for (const { node, page } of entries) {
    const fills = node.fills;
    if (fills === figma.mixed || !Array.isArray(fills)) continue;
    for (const paint of fills) {
      if (paint.type !== 'IMAGE' || !paint.imageHash) continue;
      const hash = paint.imageHash;
      let size = sizeCache.get(hash);
      if (!size) {
        const img = figma.getImageByHash(hash);
        if (!img) continue;
        try { size = await img.getSizeAsync(); } catch (e) { continue; }
        sizeCache.set(hash, size);
      }
      const f = needFactorForPaint(node, paint, size.width, size.height, scale);
      if (f == null) continue;
      let rec = byHash.get(hash);
      if (!rec) {
        rec = { hash, imgW: size.width, imgH: size.height, factor: 0, nodes: [] };
        byHash.set(hash, rec);
      }
      rec.factor = Math.max(rec.factor, f);
      if (!rec.nodes.some((n) => n.id === node.id)) rec.nodes.push({ id: node.id, name: node.name, page });
    }
    processed++;
    if (processed % 500 === 0) {
      figma.ui.postMessage({ type: 'progress', phase: 'scan', n: processed, total: entries.length });
    }
  }

  // Keep only images that are bigger than needed and heavy enough to be worth it.
  const items = [];
  for (const rec of byHash.values()) {
    if (rec.factor >= MIN_REDUCTION) continue;
    const img = figma.getImageByHash(rec.hash);
    const bytes = await img.getBytesAsync();
    if (bytes.length < minBytes) continue;
    rec.format = formatOf(bytes);
    if (rec.format === 'GIF') continue; // animated GIFs would lose their animation
    rec.bytes = bytes.length;
    rec.targetW = Math.max(1, Math.round(rec.imgW * rec.factor));
    rec.targetH = Math.max(1, Math.round(rec.imgH * rec.factor));
    items.push(rec);
  }
  items.sort((a, b) => b.bytes - a.bytes);

  lastScan = new Map(items.map((i) => [i.hash, i]));
  figma.ui.postMessage({
    type: 'scan-result',
    items: items.map((i) => ({
      hash: i.hash, imgW: i.imgW, imgH: i.imgH, targetW: i.targetW, targetH: i.targetH,
      bytes: i.bytes, format: i.format, nodes: i.nodes,
    })),
  });

  // Then, one by one, let the UI draw a thumbnail and measure the real size after resizing.
  for (const rec of items) {
    if (id !== runId) return;
    const img = figma.getImageByHash(rec.hash);
    if (!img) continue;
    const bytes = await img.getBytesAsync();
    if (id !== runId) return;
    await new Promise((resolve) => {
      pendingPreviews.set(rec.hash, resolve);
      figma.ui.postMessage({ type: 'preview', hash: rec.hash, bytes, targetW: rec.targetW, targetH: rec.targetH, format: rec.format });
    });
  }
}

function requestResize(hash, bytes, targetW, targetH, format) {
  return new Promise((resolve) => {
    pendingResizes.set(hash, resolve);
    figma.ui.postMessage({ type: 'resize', hash, bytes, targetW, targetH, format });
  });
}

async function apply(hashes) {
  runId++;
  let done = 0, savedBytes = 0, skipped = 0, failedNodes = 0;

  for (const hash of hashes) {
    const rec = lastScan.get(hash);
    if (!rec) continue;
    const img = figma.getImageByHash(hash);
    if (!img) { skipped++; continue; }
    const bytes = await img.getBytesAsync();
    const result = await requestResize(hash, bytes, rec.targetW, rec.targetH, rec.format);

    if (!result || !result.bytes || result.bytes.length >= bytes.length) { skipped++; continue; }

    const newImage = figma.createImage(result.bytes);
    for (const ref of rec.nodes) {
      const node = await figma.getNodeByIdAsync(ref.id);
      if (!node || !('fills' in node) || node.fills === figma.mixed) continue;
      try {
        node.fills = node.fills.map((p) =>
          p.type === 'IMAGE' && p.imageHash === hash ? Object.assign({}, p, { imageHash: newImage.hash }) : p
        );
      } catch (e) {
        failedNodes++; // e.g. nodes inside a remote library component
      }
    }
    savedBytes += bytes.length - result.bytes.length;
    done++;
    figma.ui.postMessage({ type: 'progress', phase: 'apply', n: done, total: hashes.length });
  }

  figma.commitUndo();
  figma.ui.postMessage({ type: 'apply-result', done, skipped, failedNodes, savedBytes });
}

// Tells the UI what is selected, so it can switch the scope to "Selection" on its own.
function pushSelection() {
  const sel = figma.currentPage.selection;
  const focused = sel.length === 1 && sel[0].id === focusedId;
  if (!focused) focusedId = null;
  figma.ui.postMessage({
    type: 'selection',
    count: sel.length,
    container: sel.some((n) => CONTAINER_TYPES.indexOf(n.type) !== -1),
    name: sel.length === 1 ? sel[0].name : null,
    focused,
  });
}
figma.on('selectionchange', pushSelection);
figma.on('currentpagechange', pushSelection);

async function focus(id) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed) return figma.notify(t('That layer no longer exists.', 'Bu katman artık yok.'));
  let page = node.parent;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  focusedId = node.id;
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'ready') {
      const saved = await figma.clientStorage.getAsync(LANG_KEY);
      if (saved === 'en' || saved === 'tr') lang = saved;
      const prefs = (await figma.clientStorage.getAsync(PREFS_KEY)) || {};
      figma.ui.postMessage({ type: 'prefs', lang, prefs });
      return pushSelection();
    }
    if (msg.type === 'setLang') {
      if (msg.lang === 'en' || msg.lang === 'tr') {
        lang = msg.lang;
        await figma.clientStorage.setAsync(LANG_KEY, lang);
      }
      return;
    }
    if (msg.type === 'setPrefs') return figma.clientStorage.setAsync(PREFS_KEY, msg.prefs);
    if (msg.type === 'scan') return scan(msg.scope, msg.scale, msg.minBytes);
    if (msg.type === 'apply') return apply(msg.hashes);
    if (msg.type === 'resized' || msg.type === 'previewed') {
      const map = msg.type === 'resized' ? pendingResizes : pendingPreviews;
      const resolve = map.get(msg.hash);
      if (resolve) { map.delete(msg.hash); resolve(msg); }
      return;
    }
    if (msg.type === 'focus') return focus(msg.id);
  } catch (e) {
    figma.ui.postMessage({ type: 'error', text: String(e && e.message ? e.message : e) });
  }
};
