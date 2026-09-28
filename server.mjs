import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");

/* ------------------------------------------------------------------ config */

function loadEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const config = {
  openAiEndpoint: (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, ""),
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.6-terra",
  fallbackDeployment: process.env.AZURE_OPENAI_FALLBACK_DEPLOYMENT || "gpt-5.5",
  reasoningEffort: process.env.AZURE_OPENAI_REASONING_EFFORT || "medium",
  sessionPoolEndpoint: (process.env.ACA_SESSION_POOL_ENDPOINT || "").replace(/\/+$/, ""),
  renderPoolEndpoint: (process.env.ACA_RENDER_POOL_ENDPOINT || "").replace(/\/+$/, ""),
  sessionApiVersion: process.env.ACA_SESSION_API_VERSION || "2025-10-02-preview",
  renderApiVersion: process.env.ACA_RENDER_API_VERSION || "2025-02-02-preview",
  port: Number(process.env.PORT || 4173),
};

const SCOPE_OPENAI = "https://cognitiveservices.azure.com";
const SCOPE_SESSIONS = "https://dynamicsessions.io";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/* -------------------------------------------------------------------- auth */

const tokenCache = new Map();

async function tokenFromImds(resource) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  const url = new URL(endpoint);
  url.searchParams.set("resource", resource);
  url.searchParams.set("api-version", "2019-08-01");
  if (process.env.AZURE_CLIENT_ID) url.searchParams.set("client_id", process.env.AZURE_CLIENT_ID);

  const response = await fetch(url, {
    headers: { "X-IDENTITY-HEADER": header },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Managed identity token request failed (${response.status}): ${await response.text()}`);
  }
  const payload = await response.json();
  return {
    value: payload.access_token,
    expiresAt: Number(payload.expires_on) * 1000 || Date.now() + 40 * 60_000,
  };
}

async function tokenFromCli(resource) {
  const isWindows = process.platform === "win32";
  const { stdout } = await execFileAsync(
    // Node blocks spawning .cmd shims without a shell on Windows; args are fixed constants.
    isWindows ? "az.cmd" : "az",
    ["account", "get-access-token", "--resource", resource, "-o", "json"],
    { maxBuffer: 4_000_000, windowsHide: true, shell: isWindows }
  );
  const parsed = JSON.parse(stdout);
  return {
    value: parsed.accessToken,
    expiresAt: parsed.expires_on
      ? Number(parsed.expires_on) * 1000
      : Date.parse(parsed.expiresOn) || Date.now() + 40 * 60_000,
  };
}

async function getToken(resource) {
  const cached = tokenCache.get(resource);
  if (cached && cached.expiresAt - Date.now() > 120_000) return cached.value;

  let token;
  try {
    token = process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER
      ? await tokenFromImds(resource)
      : await tokenFromCli(resource);
  } catch (error) {
    throw new Error(
      `Could not acquire a Microsoft Entra ID token for ${resource}. ` +
      (process.env.IDENTITY_ENDPOINT
        ? `Check the container app's managed identity and role assignments. (${error.message})`
        : "Run `az login` locally, then retry.")
    );
  }
  tokenCache.set(resource, token);
  return token.value;
}

export const authMode = () =>
  process.env.IDENTITY_ENDPOINT ? "managed-identity" : "azure-cli";

/* ------------------------------------------------------------------ helpers */

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 400_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function responsesUrl() {
  const clean = config.openAiEndpoint;
  if (clean.endsWith("/openai/v1/responses")) return clean;
  if (clean.endsWith("/openai/v1")) return `${clean}/responses`;
  return `${clean}/openai/v1/responses`;
}

function extractHtml(text) {
  const doctype = text.search(/<!doctype html>/i);
  if (doctype >= 0) {
    const end = text.toLowerCase().lastIndexOf("</html>");
    return (end > doctype ? text.slice(doctype, end + 7) : text.slice(doctype)).trim();
  }
  const marked = text.match(/<artifact_html>\s*([\s\S]*?)\s*<\/artifact_html>/i);
  if (marked) return marked[1].trim();
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const html = text.search(/<html[\s>]/i);
  if (html >= 0) return `<!DOCTYPE html>\n${text.slice(html).trim()}`;
  return null;
}

function summarize(text, html) {
  const tagged = (html || text).match(/<!--\s*SUMMARY:\s*([\s\S]*?)-->/i);
  if (tagged) return tagged[1].replace(/\s+/g, " ").trim().slice(0, 420);
  const prose = text
    .replace(/<!doctype html>[\s\S]*$/i, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return prose.slice(0, 420) || "Updated your interface.";
}

/* ---------------------------------------------------- render session client */

/**
 * Custom-container session pools forward any path after the pool management
 * endpoint straight into the session's container, keyed by `identifier`. One
 * identifier == one micro-VM, allocated implicitly on first contact.
 *
 * `identifier` accepts alphanumerics plus | - & ^ % $ # ( ) { } [ ] ; < >
 * and must be 4-128 characters, so a bare UUID is already valid.
 */
function renderSessionUrl(path, identifier) {
  const url = new URL(`${config.renderPoolEndpoint}${path}`);
  url.searchParams.set("identifier", identifier);
  url.searchParams.set("api-version", config.renderApiVersion);
  return url;
}

async function renderSessionFetch(path, identifier, init = {}) {
  const token = await getToken(SCOPE_SESSIONS);
  return fetch(renderSessionUrl(path, identifier), {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
}

/** Push the generated document into its own session and confirm it landed. */
async function pushToRenderSession(identifier, html) {
  const started = Date.now();
  const response = await renderSessionFetch("/artifact", identifier, {
    method: "PUT",
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Render session rejected the artifact (${response.status}): ${raw.slice(0, 300)}`
    );
  }

  let info = {};
  try { info = JSON.parse(raw); } catch { /* diagnostics are best-effort */ }

  return {
    identifier,
    coldStartMs: Date.now() - started,
    instance: info.instance || null,
    hostname: info.hostname || null,
    kernel: info.kernel || null,
    node: info.node || null,
    cpus: info.cpus ?? null,
    memoryMb: info.memoryMb ?? null,
    bytes: info.artifactBytes ?? Buffer.byteLength(html),
  };
}

/** Best-effort teardown so an abandoned workspace does not hold a micro-VM. */
async function stopRenderSession(identifier) {
  try {
    await renderSessionFetch("/.management/stopSession", identifier, { method: "POST" });
  } catch { /* the cooldown timer will reclaim it anyway */ }
}

/* ------------------------------------------------------------- artifact store */

const artifacts = new Map();
const ARTIFACT_TTL = 6 * 60 * 60 * 1000;

// Model-authored code is untrusted: deny it network egress, keep it in an
// opaque origin, and stop it navigating or reaching this app's API surface.
const ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

function putArtifact(html, meta = {}) {
  const id = randomUUID();
  artifacts.set(id, { html, createdAt: Date.now(), ...meta });
  for (const [key, value] of artifacts) {
    if (Date.now() - value.createdAt > ARTIFACT_TTL) artifacts.delete(key);
  }
  return id;
}

/* ------------------------------------------------------------ system prompt */

const DESIGN_CONTRACT = `
DESIGN SYSTEM (follow exactly):
- Typography: "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif. Monospace: "Cascadia Code", ui-monospace, monospace.
- Support BOTH color schemes with CSS custom properties and prefers-color-scheme.
  Dark:  bg #08080c, surface #101017, surface-2 #16161f, border #23232f, text #e9ecf1, muted #9aa2b1.
  Light: bg #f4f2fb, surface #ffffff, surface-2 #faf9fe, border #e3e0ee, text #16151d, muted #5d5a6b.
- Accent: violet #a371f7 to pink #f778ba gradient. Use it sparingly for primary actions and highlights.
- 12-16px border radii, 1px hairline borders, generous whitespace, no drop shadows heavier than 0 10px 30px rgba(0,0,0,.25).
- Charts and visuals must be hand-built with inline SVG or CSS. Never use canvas-based chart libraries.
- Include hover/focus states and visible focus rings. Meet WCAG AA contrast.
- Fully responsive down to 380px.`;

const INSTRUCTIONS = `You are a principal product designer and staff frontend engineer working inside a live generative-UI studio.

Produce ONE complete, polished, production-quality HTML document per turn.

HARD REQUIREMENTS
- Self-contained: a single HTML file with inline <style> and inline <script>. No build step.
- Zero network dependencies: no external CSS, fonts, images, scripts, or API calls. Use inline SVG and deterministic in-file sample data.
- Every visible control must actually work. No dead buttons, no "coming soon" placeholders.
- Rich, realistic seeded data — enough rows/points that the UI looks like a real product, not a skeleton.
- Use semantic HTML and ARIA labels on interactive controls.
- The document is rendered inside a sandboxed iframe. Do not use alert(), and do not rely on localStorage or cookies.
${DESIGN_CONTRACT}

OUTPUT FORMAT (exact — deviating breaks the renderer)
- Reply with the complete HTML document and NOTHING else. No preamble, no explanation, no markdown fences.
- The very first characters of your reply must be "<!DOCTYPE html>".
- The second line must be an HTML comment summarising what you built or changed in one sentence, exactly:
  <!-- SUMMARY: ... -->
- The last characters of your reply must be "</html>". Never truncate or abbreviate the document.`;

/* ------------------------------------------------ azure openai (streaming) */

async function streamGeneration({ prompt, currentCode, deployment, onDelta, onPhase }) {
  const userInput = currentCode
    ? `Revise the existing artifact.\n\nRequested change:\n${prompt}\n\nCurrent artifact:\n${currentCode}`
    : `Build this artifact:\n${prompt}`;

  const body = {
    model: deployment,
    instructions: INSTRUCTIONS,
    input: userInput,
    max_output_tokens: 80_000,
    stream: true,
  };
  if (/^gpt-5/i.test(deployment)) {
    body.reasoning = { effort: config.reasoningEffort };
  }

  const token = await getToken(SCOPE_OPENAI);
  const response = await fetch(responsesUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok || !response.body) {
    const raw = await response.text();
    let detail = `Azure request failed (${response.status}).`;
    try {
      detail = JSON.parse(raw).error?.message || detail;
    } catch { /* keep default */ }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let usage = null;
  let reasoningSeen = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payloadText = line.slice(5).trim();
        if (!payloadText || payloadText === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(payloadText);
        } catch {
          continue;
        }

        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta;
          onDelta(event.delta, text);
        } else if (event.type === "response.reasoning_summary_text.delta" && !reasoningSeen) {
          reasoningSeen = true;
          onPhase("model", `${deployment} is reasoning…`);
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          usage = event.response?.usage || null;
          if (event.type === "response.incomplete") {
            const reason = event.response?.incomplete_details?.reason || "unknown";
            if (!/<\/html>/i.test(text)) {
              throw new Error(`The model stopped before finishing the artifact (${reason}).`);
            }
          }
        } else if (event.type === "error") {
          throw new Error(event.error?.message || "Azure streaming error.");
        }
      }
    }
  }

  return { text, usage };
}

/* -------------------------------------------- aca dynamic session sandbox */

const SANDBOX_SCRIPT = String.raw`
import base64, json, re, sys
from html.parser import HTMLParser

RAW = base64.b64decode("__ARTIFACT_B64__").decode("utf-8", "replace")

report = {
    "engine": {"python": sys.version.split()[0]},
    "metrics": {},
    "checks": [],
    "score": 0,
}

def check(name, ok, detail, severity="error"):
    report["checks"].append(
        {"name": name, "ok": bool(ok), "detail": detail, "severity": severity}
    )

class Scan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = {}
        self.interactive = 0
        self.aria = 0
        self.inline_handlers = 0
        self.externals = []
        self.in_script = False
        self.in_style = False
        self.script_bytes = 0
        self.style_bytes = 0
        self.title = ""
        self.in_title = False
        self.has_viewport = False
        self.headings = []

    def handle_starttag(self, tag, attrs):
        self.tags[tag] = self.tags.get(tag, 0) + 1
        a = dict(attrs)
        if tag in ("button", "a", "input", "select", "textarea", "details", "summary"):
            self.interactive += 1
        if any(k.startswith("aria-") or k == "role" or k == "alt" for k in a):
            self.aria += 1
        for k, v in a.items():
            if k.startswith("on"):
                self.inline_handlers += 1
            if k in ("src", "href", "action") and v and re.match(r"^(https?:)?//", v):
                self.externals.append(v[:120])
        if tag == "script":
            self.in_script = True
        if tag == "style":
            self.in_style = True
        if tag == "title":
            self.in_title = True
        if tag == "meta" and a.get("name") == "viewport":
            self.has_viewport = True
        if tag in ("h1", "h2", "h3"):
            self.headings.append(tag)

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False
        if tag == "style":
            self.in_style = False
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_script:
            self.script_bytes += len(data)
        if self.in_style:
            self.style_bytes += len(data)
        if self.in_title:
            self.title += data.strip()

scan = Scan()
try:
    scan.feed(RAW)
    parsed_ok = True
    parse_detail = "Document parsed cleanly."
except Exception as exc:
    parsed_ok = False
    parse_detail = "Parser error: %s" % exc

report["metrics"] = {
    "bytes": len(RAW.encode("utf-8")),
    "lines": RAW.count("\n") + 1,
    "elements": sum(scan.tags.values()),
    "distinctTags": len(scan.tags),
    "interactiveControls": scan.interactive,
    "ariaAnnotations": scan.aria,
    "scriptBytes": scan.script_bytes,
    "styleBytes": scan.style_bytes,
    "title": scan.title or "(none)",
    "topTags": sorted(scan.tags.items(), key=lambda kv: -kv[1])[:8],
}

check("Parses as HTML", parsed_ok, parse_detail)
check("Has DOCTYPE", RAW.lstrip()[:15].lower().startswith("<!doctype"), "Standards mode required.")
check("Has <title>", bool(scan.title), scan.title or "No document title found.")
check("Responsive viewport", scan.has_viewport, "meta name=viewport present." if scan.has_viewport else "Missing responsive viewport meta tag.")
check("No external network calls", not scan.externals,
      "Fully self-contained." if not scan.externals else "External refs: " + ", ".join(scan.externals[:3]))
check("Has interactive controls", scan.interactive >= 2, "%d interactive elements." % scan.interactive)
check("Ships behaviour", scan.script_bytes > 120, "%d bytes of inline JavaScript." % scan.script_bytes)
check("Ships styling", scan.style_bytes > 400, "%d bytes of inline CSS." % scan.style_bytes)
check("Supports dark and light", "prefers-color-scheme" in RAW, "prefers-color-scheme media query present.", "warn")
check("Accessibility annotations", scan.aria >= 2, "%d aria/role/alt attributes." % scan.aria, "warn")
check("Avoids inline on* handlers", scan.inline_handlers == 0,
      "No inline handlers." if scan.inline_handlers == 0 else "%d inline handlers found." % scan.inline_handlers, "warn")
check("Avoids alert()", "alert(" not in RAW, "No blocking dialogs.", "warn")

# Validate the embedded JavaScript is at least syntactically balanced.
scripts = re.findall(r"<script[^>]*>([\s\S]*?)</script>", RAW, re.I)
js = "\n".join(scripts)
balanced = js.count("{") == js.count("}") and js.count("(") == js.count(")") and js.count("[") == js.count("]")
check("JS brackets balanced", balanced, "Braces/parens/brackets balanced across %d script block(s)." % len(scripts))

errors = [c for c in report["checks"] if not c["ok"] and c["severity"] == "error"]
warns = [c for c in report["checks"] if not c["ok"] and c["severity"] == "warn"]
total = len(report["checks"])
report["score"] = int(round(100 * (total - len(errors) - 0.4 * len(warns)) / total))
report["passed"] = len(errors) == 0
report["errorCount"] = len(errors)
report["warnCount"] = len(warns)

print("__REPORT__" + json.dumps(report))
`;

async function runSandboxQa(html, sessionId) {
  if (!config.sessionPoolEndpoint) {
    return { skipped: true, reason: "No session pool configured." };
  }
  const code = SANDBOX_SCRIPT.replace(
    "__ARTIFACT_B64__",
    Buffer.from(html, "utf8").toString("base64")
  );

  const token = await getToken(SCOPE_SESSIONS);
  const url =
    `${config.sessionPoolEndpoint}/executions` +
    `?api-version=${config.sessionApiVersion}&identifier=${encodeURIComponent(sessionId)}`;

  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      codeInputType: "Inline",
      executionType: "Synchronous",
      code,
      timeoutInSeconds: 90,
    }),
    signal: AbortSignal.timeout(150_000),
  });

  const raw = await response.text();
  if (!response.ok) {
    let detail = `Session execution failed (${response.status}).`;
    try {
      detail = JSON.parse(raw).error?.message || JSON.parse(raw).message || detail;
    } catch { /* keep default */ }
    throw new Error(detail);
  }

  const payload = JSON.parse(raw);
  const stdout = payload.result?.stdout || "";
  const marker = stdout.indexOf("__REPORT__");
  if (marker < 0) {
    throw new Error(payload.result?.stderr?.slice(0, 400) || "Sandbox returned no report.");
  }

  const report = JSON.parse(stdout.slice(marker + "__REPORT__".length).trim());
  report.sessionId = sessionId;
  report.wallClockMs = Date.now() - started;
  report.executionMs = payload.result?.executionTimeInMilliseconds ?? null;
  report.status = payload.status;
  return report;
}

/* --------------------------------------------------------------- SSE plumbing */

function openStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

async function handleGenerate(req, res) {
  const body = await readJson(req);
  const prompt = String(body.prompt || "").trim();
  const currentCode = String(body.currentCode || "").trim();
  const sessionId = String(body.sessionId || "canvas-anonymous").slice(0, 120);

  if (!prompt) return json(res, 400, { error: "Describe what you want to build." });
  if (prompt.length > 12_000) return json(res, 400, { error: "Prompt is too long." });
  if (!config.openAiEndpoint) return json(res, 503, { error: "Azure OpenAI is not configured." });

  const send = openStream(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  let closed = false;
  req.on("close", () => { closed = true; });

  const t0 = Date.now();
  try {
    send("phase", { id: "model", label: `Prompting ${config.deployment}`, state: "active" });

    let attemptDeployment = config.deployment;
    let result;
    try {
      result = await streamGeneration({
        prompt,
        currentCode,
        deployment: attemptDeployment,
        onDelta: (delta, full) => { if (!closed) send("delta", { delta, length: full.length }); },
        onPhase: (id, label) => { if (!closed) send("phase", { id, label, state: "active" }); },
      });
    } catch (error) {
      if (config.fallbackDeployment && config.fallbackDeployment !== attemptDeployment) {
        attemptDeployment = config.fallbackDeployment;
        send("phase", {
          id: "model",
          label: `Retrying on ${attemptDeployment}`,
          state: "active",
          note: error.message.slice(0, 160),
        });
        result = await streamGeneration({
          prompt,
          currentCode,
          deployment: attemptDeployment,
          onDelta: (delta, full) => { if (!closed) send("delta", { delta, length: full.length }); },
          onPhase: (id, label) => { if (!closed) send("phase", { id, label, state: "active" }); },
        });
      } else {
        throw error;
      }
    }

    const html = extractHtml(result.text);
    if (!html) {
      console.error("[generate] no artifact in model output:\n", result.text.slice(0, 4000));
      throw new Error(
        `The model responded without a complete HTML artifact: ${result.text.trim().slice(0, 220) || "(empty response)"}`
      );
    }

    send("phase", { id: "model", label: `${attemptDeployment} finished`, state: "done" });

    const id = putArtifact(html, { prompt, deployment: attemptDeployment });

    // Hand the document to its own micro-VM before telling the browser to load
    // it, so the very first frame the user sees is served out of the session.
    let session = null;
    if (config.renderPoolEndpoint) {
      send("phase", { id: "render", label: "Starting a render session", state: "active" });
      try {
        session = await pushToRenderSession(id, html);
        artifacts.get(id).session = session;
        send("phase", {
          id: "render",
          label: `Rendering in ${session.hostname || "an isolated session"}`,
          state: "active",
        });
      } catch (error) {
        console.error(`[render] could not start a session: ${error.message}`);
        send("phase", {
          id: "render",
          label: "Rendering from the container (session unavailable)",
          state: "active",
        });
      }
    }

    send("artifact", {
      id,
      html,
      summary: summarize(result.text, html),
      deployment: attemptDeployment,
      usage: result.usage,
      elapsedMs: Date.now() - t0,
      renderUrl: `/api/artifact/${id}/render`,
      session,
    });

    send("phase", { id: "sandbox", label: "Verifying in an isolated session", state: "active" });
    try {
      const report = await runSandboxQa(html, sessionId);
      artifacts.get(id).report = report;
      send("sandbox", report);
      send("phase", {
        id: "sandbox",
        label: report.skipped
          ? "Sandbox skipped"
          : `Sandbox verified · ${report.score}/100`,
        state: report.skipped ? "skipped" : "done",
      });
    } catch (error) {
      send("sandbox", { failed: true, error: error.message });
      send("phase", { id: "sandbox", label: "Sandbox unavailable", state: "failed" });
    }

    send("done", { id, elapsedMs: Date.now() - t0 });
  } catch (error) {
    const message =
      error?.name === "TimeoutError"
        ? "The model timed out."
        : error?.message || "Unexpected server error.";
    send("failed", { error: message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

/* ------------------------------------------------------------ static + routes */

async function serveStatic(req, res, url) {
  const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = normalize(join(publicDir, relativePath));
  const rel = relative(publicDir, filePath);
  if (rel.startsWith("..") || rel.includes(":")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }

  try {
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, uptime: process.uptime() });
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        configured: Boolean(config.openAiEndpoint),
        deployment: config.deployment,
        fallbackDeployment: config.fallbackDeployment,
        reasoningEffort: config.reasoningEffort,
        endpointHost: config.openAiEndpoint ? new URL(config.openAiEndpoint).host : null,
        authMode: authMode(),
        sandbox: config.sessionPoolEndpoint
          ? {
              enabled: true,
              pool: config.sessionPoolEndpoint.split("/sessionPools/")[1] || "session pool",
              region: (config.sessionPoolEndpoint.match(/https:\/\/([^.]+)\./) || [])[1] || null,
            }
          : { enabled: false },
        render: config.renderPoolEndpoint
          ? {
              enabled: true,
              mode: "dynamic-session",
              pool: new URL(config.renderPoolEndpoint).host.split(".")[0],
              endpointHost: new URL(config.renderPoolEndpoint).host,
            }
          : { enabled: false, mode: "container" },
        runtime: process.env.CONTAINER_APP_NAME
          ? {
              host: "Azure Container Apps",
              app: process.env.CONTAINER_APP_NAME,
              revision: process.env.CONTAINER_APP_REVISION || null,
              replica: process.env.CONTAINER_APP_REPLICA_NAME || null,
            }
          : { host: "local", app: "dev server", revision: null, replica: null },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      return await handleGenerate(req, res);
    }

    const renderMatch = url.pathname.match(/^\/api\/artifact\/([0-9a-f-]{36})\/(render|raw)$/i);
    if (req.method === "GET" && renderMatch) {
      const entry = artifacts.get(renderMatch[1]);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Artifact not found");
      }

      if (renderMatch[2] === "raw") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(entry.html);
      }

      // The browser cannot authenticate to a session pool, so the app acts as a
      // backend-for-frontend: it holds the Entra token and streams the response
      // back out of the micro-VM that is actually serving the document.
      if (entry.session) {
        try {
          const upstream = await renderSessionFetch("/", entry.session.identifier, {
            method: "GET",
            signal: AbortSignal.timeout(45_000),
          });
          if (upstream.ok) {
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": ARTIFACT_CSP,
              "X-Rendered-By": "aca-dynamic-session",
              "X-Session-Identifier": entry.session.identifier,
              "X-Session-Instance": upstream.headers.get("x-session-instance") || "",
              "X-Session-Host": upstream.headers.get("x-session-host") || "",
            });
            const body = Buffer.from(await upstream.arrayBuffer());
            return res.end(body);
          }
          console.error(
            `[render] session ${entry.session.identifier} returned ${upstream.status}; serving locally`
          );
        } catch (error) {
          console.error(`[render] session proxy failed: ${error.message}; serving locally`);
        }
      }

      // Fallback: the pool is unreachable or not configured. Serve from the app
      // so the demo degrades gracefully instead of showing an empty pane.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": ARTIFACT_CSP,
        "X-Rendered-By": "studio-fallback",
      });
      return res.end(entry.html);
    }

    if (req.method === "GET") return serveStatic(req, res, url);
    return json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (res.headersSent) return res.end();
    return json(res, 500, { error: error?.message || "Unexpected server error." });
  }
});

server.headersTimeout = 620_000;
server.requestTimeout = 620_000;

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Code Canvas listening on :${config.port}`);
  console.log(`  auth        ${authMode()}`);
  console.log(`  model       ${config.deployment} (fallback ${config.fallbackDeployment})`);
  console.log(`  openai      ${config.openAiEndpoint || "(unset)"}`);
  console.log(`  sandbox     ${config.sessionPoolEndpoint || "(disabled)"}`);
});
