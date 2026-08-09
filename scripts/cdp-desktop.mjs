#!/usr/bin/env node
// Drive the monday.com DESKTOP app (Electron) over the Chrome DevTools Protocol,
// riding the app's existing logged-in session — no API token required.
//
// Why this exists: the monday desktop app is an Electron shell hosting the web app in a
// <webview>. Its Electron fuses leave remote debugging open, so you can attach a CDP client
// and drive the real, authenticated web app. Claude-in-Chrome cannot attach here (it pairs
// with Chrome extensions only); this is a dependency-free CDP client using Node's native
// WebSocket (Node >= 22; tested on Node 26).
//
// SECURITY: `--remote-debugging-port` opens an UNAUTHENTICATED port on localhost. Any local
// process can drive the logged-in session while it is open. Quit the app when done.
//
// --- Launch the app with the debug port (quit any running instance first) ---
//   osascript -e 'quit app "monday.com"'
//   /Applications/monday.com.app/Contents/MacOS/monday.com --remote-debugging-port=9222 &
//
// --- Usage ---
//   node scripts/cdp-desktop.mjs targets                      # list debug targets, pick the webview
//   node scripts/cdp-desktop.mjs eval  '<js expression>'      # Runtime.evaluate in the webview
//   node scripts/cdp-desktop.mjs nav   '<url>'                # Page.navigate (cold deep-link OK)
//   node scripts/cdp-desktop.mjs open  <slug> <board> <item> # navigate straight to an item card
//   node scripts/cdp-desktop.mjs shot  <out.png>             # screenshot the webview
//   node scripts/cdp-desktop.mjs click <x> <y>               # real mouse click at CSS x,y (canvas)
//
// Env: PORT (default 9222), WS (override the target ws url; else the first `webview` is used).

const PORT = process.env.PORT || '9222';
const base = `http://localhost:${PORT}`;

async function listTargets() {
  const res = await fetch(`${base}/json`);
  return res.json();
}

async function webviewWs() {
  if (process.env.WS) return process.env.WS;
  const targets = await listTargets();
  const wv = targets.find((t) => t.type === 'webview' && /monday\.com/.test(t.url))
    || targets.find((t) => t.type === 'page' && /monday\.com/.test(t.url));
  if (!wv) throw new Error('No monday webview target found. Is the app running with --remote-debugging-port? Try `targets`.');
  return wv.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error(e.message || 'ws error')));
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, ready, send };
}

async function evaluate(send, expression) {
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value ?? null;
}

// Poll for an item card after a navigation (deep-links "hang" only under idle-waiting drivers).
const POLL_CARD = `(async () => {
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const t0 = Date.now();
  while (Date.now()-t0 < 18000) {
    if (location.pathname.includes('/pulses/') && document.querySelector('[data-testid="new-post-update-placeholder"],[data-testid="posts-list-container"]')) break;
    await sleep(400);
  }
  await sleep(1000);
  const all = document.body.innerText || '';
  return { url: location.href, title: document.title,
    updates: (all.match(/Updates\\s*\\/\\s*\\d+/)||[])[0] || null,
    posts: document.querySelectorAll('[data-testid="post-component"]').length,
    hasComposer: !!document.querySelector('[data-testid="new-post-update-placeholder"]') };
})()`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'targets') { console.log(JSON.stringify(await listTargets(), null, 2)); return; }

  const wsUrl = await webviewWs();
  const { ws, ready, send } = connect(wsUrl);
  await ready;
  try {
    if (cmd === 'eval') {
      console.log(JSON.stringify(await evaluate(send, args.join(' ')), null, 2));
    } else if (cmd === 'nav') {
      await send('Page.enable'); await send('Page.navigate', { url: args[0] });
      console.log(JSON.stringify(await evaluate(send, POLL_CARD), null, 2));
    } else if (cmd === 'open') {
      const [slug, board, item] = args;
      await send('Page.enable');
      await send('Page.navigate', { url: `https://${slug}.monday.com/boards/${board}/pulses/${item}` });
      console.log(JSON.stringify(await evaluate(send, POLL_CARD), null, 2));
    } else if (cmd === 'shot') {
      await send('Page.enable');
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args[0] || 'monday.png', Buffer.from(shot.result.data, 'base64'));
      console.log(JSON.stringify({ saved: args[0] || 'monday.png' }));
    } else if (cmd === 'click') {
      const x = Number(args[0]), y = Number(args[1]);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      console.log(JSON.stringify({ clicked: [x, y] }));
    } else {
      console.log('commands: targets | eval <js> | nav <url> | open <slug> <board> <item> | shot <out.png> | click <x> <y>');
    }
  } finally {
    ws.close();
  }
}

// Force a clean exit: the initial fetch keep-alive socket and the CDP WebSocket can hold the
// event loop open even after the work is done.
main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
