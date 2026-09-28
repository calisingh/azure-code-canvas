/**
 * renderd — the artifact renderer that runs INSIDE an Azure Container Apps
 * dynamic session (a Hyper-V isolated micro-VM).
 *
 * One session == one artifact. The studio app pushes the generated document in
 * over the session pool's forwarding endpoint, and the browser then reads it
 * back through the studio's proxy. The HTML therefore never executes on the
 * studio's origin and never touches the studio's filesystem — it is served by a
 * disposable VM with no network egress.
 *
 * Routes (everything after the pool management endpoint is forwarded here):
 *   PUT  /artifact   -> store the document for this session
 *   GET  /           -> serve the document
 *   GET  /_health    -> liveness/readiness
 *   GET  /_info      -> session diagnostics, proves where this ran
 *
 * Zero dependencies: Node standard library only.
 */

import { createServer } from "node:http";
import { hostname, totalmem, cpus, release, type as osType } from "node:os";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const MAX_BYTES = 8 * 1024 * 1024;
const BOOTED_AT = Date.now();
const INSTANCE = randomUUID();

/** @type {{html: string, receivedAt: number, bytes: number, title: string|null}|null} */
let artifact = null;
let served = 0;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        reject(new Error("Artifact exceeds the 8 MB session limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const diagnostics = () => ({
  instance: INSTANCE,
  hostname: hostname(),
  kernel: `${osType()} ${release()}`,
  node: process.version,
  cpus: cpus().length,
  memoryMb: Math.round(totalmem() / 1024 / 1024),
  uptimeSeconds: Number(process.uptime().toFixed(1)),
  bootedAt: new Date(BOOTED_AT).toISOString(),
  hasArtifact: Boolean(artifact),
  artifactBytes: artifact?.bytes ?? 0,
  artifactTitle: artifact?.title ?? null,
  timesServed: served,
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://session.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/_health") return json(res, 200, { ok: true, instance: INSTANCE });
    if (path === "/_info") return json(res, 200, diagnostics());

    if (req.method === "PUT" && path === "/artifact") {
      const html = await readBody(req);
      if (!html.trim()) return json(res, 400, { error: "Empty artifact." });
      artifact = {
        html,
        receivedAt: Date.now(),
        bytes: Buffer.byteLength(html),
        title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim() || null,
      };
      served = 0;
      return json(res, 200, { stored: true, ...diagnostics() });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (!artifact) {
        return json(res, 404, { error: "No artifact has been loaded into this session yet." });
      }
      served += 1;
      const body = Buffer.from(artifact.html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // Surfaced in the studio UI to prove the render came out of the micro-VM.
        "X-Rendered-By": "aca-dynamic-session",
        "X-Session-Instance": INSTANCE,
        "X-Session-Host": hostname(),
        "X-Session-Kernel": `${osType()} ${release()}`,
        "X-Session-Uptime": String(process.uptime().toFixed(1)),
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }

    return json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error?.message || "Bad request." });
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`renderd ${INSTANCE} listening on 0.0.0.0:${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
