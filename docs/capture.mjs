/**
 * Captures populated screenshots of the live studio by driving headless Edge
 * over the Chrome DevTools Protocol. Node 22 ships a global WebSocket, so this
 * needs no dependencies.
 *
 * Usage: node docs/capture.mjs <baseUrl> [theme] [outfile] [prompt]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const THEME = process.argv[3] || "dark";
const OUT = process.argv[4] || `docs/screenshot-${THEME}.png`;
const PROMPT =
  process.argv[5] ||
  "A revenue intelligence dashboard with KPI cards, an SVG trend chart, and a sortable pipeline table";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
].find((path) => existsSync(path));

if (!EDGE) throw new Error("Could not find a Chromium-based browser to drive.");

const PORT = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "canvas-shot-"));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=1920,1080",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* browser still booting */ }
    await sleep(500);
  }
  throw new Error("Edge did not expose a debugging target.");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const { result } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false,
});

console.log(`navigating to ${BASE}/?theme=${THEME}`);
await send("Page.navigate", { url: `${BASE}/?theme=${THEME}` });
await sleep(3500);

console.log(`building: ${PROMPT.slice(0, 60)}...`);
await evaluate(`
  (() => {
    const box = document.querySelector("#prompt");
    box.value = ${JSON.stringify(PROMPT)};
    box.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#sendBtn").click();
    return true;
  })()
`);

for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const done = await evaluate(`!!document.querySelector("#frame")?.getAttribute("src")`);
  const busy = await evaluate(`document.querySelector("#sendBtn").disabled`);
  if (done && !busy) break;
  if (i % 10 === 0) process.stdout.write(".");
}
console.log("\nbuild finished, settling");
await sleep(6000);

const { data } = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(data, "base64"));
console.log(`wrote ${OUT}`);

ws.close();
edge.kill();
process.exit(0);
