"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const el = {
  chatScroll: $("#chatScroll"),
  hero: $("#hero"),
  chatMeta: $("#chatMeta"),
  prompt: $("#prompt"),
  sendBtn: $("#sendBtn"),
  newBtn: $("#newBtn"),
  gutter: $("#gutter"),
  code: $("#code"),
  codeScroll: $("#codeScroll"),
  lineCount: $("#lineCount"),
  byteCount: $("#byteCount"),
  streamDot: $("#streamDot"),
  versions: $("#versions"),
  copyBtn: $("#copyBtn"),
  frame: $("#frame"),
  frameShell: $("#frameShell"),
  stage: $("#stage"),
  sandbox: $("#sandbox"),
  viewSeg: $("#viewSeg"),
  deviceSeg: $("#deviceSeg"),
  refreshBtn: $("#refreshBtn"),
  popoutBtn: $("#popoutBtn"),
  cover: $("#cover"),
  coverTitle: $("#coverTitle"),
  coverDetail: $("#coverDetail"),
  runtimePill: $("#runtimePill"),
  runtimeText: $("#runtimeText"),
  modelPill: $("#modelPill"),
  modelText: $("#modelText"),
  sandboxPill: $("#sandboxPill"),
  sandboxText: $("#sandboxText"),
  renderPill: $("#renderPill"),
  renderText: $("#renderText"),
  themeBtn: $("#themeBtn"),
  themeIcon: $("#themeIcon"),
  exportBtn: $("#exportBtn"),
  urlText: $("#urlText"),
  toast: $("#toast"),
};

const state = {
  code: "",
  artifactId: null,
  renderUrl: null,
  generating: false,
  versions: [],
  activeVersion: -1,
  device: "desktop",
  view: "preview",
  sessionId: `canvas-${Math.random().toString(36).slice(2, 10)}`,
  status: null,
};

/* ----------------------------------------------------------------- helpers */

const escapeHtml = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HIGHLIGHT =
  /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?)([a-zA-Z][\w:.-]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([a-zA-Z-]+)(?==)/g;

function highlight(source) {
  return escapeHtml(source).replace(HIGHLIGHT, (m, comment, open, tag, str, attr) => {
    if (comment) return `<span class="tok-comment">${comment}</span>`;
    if (open) return `<span class="tok-punct">${open}</span><span class="tok-tag">${tag}</span>`;
    if (str) return `<span class="tok-string">${str}</span>`;
    if (attr) return `<span class="tok-attr">${attr}</span>`;
    return m;
  });
}

function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("bad", bad);
  el.toast.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("on"), 3800);
}

const slugify = (t) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "artifact";

function titleize(t) {
  const clean = t.trim().replace(/\s+/g, " ");
  if (!clean) return "Untitled";
  const short = clean.length > 40 ? `${clean.slice(0, 40).trimEnd()}…` : clean;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString() : "—");

/* --------------------------------------------------------------- rendering */

let codeRaf = 0;
function renderCode(scrollToEnd = false) {
  cancelAnimationFrame(codeRaf);
  codeRaf = requestAnimationFrame(() => {
    const lines = state.code.split("\n");
    el.gutter.textContent = lines.map((_, i) => i + 1).join("\n");
    el.code.innerHTML = highlight(state.code);
    el.lineCount.textContent = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
    el.byteCount.textContent = fmtBytes(new Blob([state.code]).size);
    if (scrollToEnd) el.codeScroll.scrollTop = el.codeScroll.scrollHeight;
  });
}

function renderPreview() {
  if (!state.renderUrl) return;
  // Cache-bust so the container re-serves the artifact on refresh.
  el.frame.src = `${state.renderUrl}?r=${Date.now()}`;
}

function renderVersions() {
  el.versions.innerHTML = "";
  state.versions.forEach((version, index) => {
    const chip = document.createElement("button");
    chip.className = `vchip${index === state.activeVersion ? " active" : ""}`;
    chip.textContent = `v${index + 1} · ${version.label}`;
    chip.title = `Restore: ${version.label}`;
    chip.addEventListener("click", () => {
      state.activeVersion = index;
      state.code = version.code;
      state.artifactId = version.id;
      state.renderUrl = version.renderUrl;
      renderCode();
      renderPreview();
      renderVersions();
      renderSandbox(version.report);
      el.urlText.textContent = `container · /api/artifact/${version.id}/render`;
      toast(`Restored v${index + 1}.`);
    });
    el.versions.appendChild(chip);
  });
  el.versions.scrollLeft = el.versions.scrollWidth;
}

/* ------------------------------------------------------------- chat pieces */

function addMessage(role, text) {
  el.hero?.remove();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const who = document.createElement("div");
  who.className = "msg-who";
  const mark = document.createElement("span");
  mark.className = "who-mark";
  mark.textContent = role === "user" ? "You" : "AI";
  who.append(mark, document.createTextNode(role === "user" ? "You" : "Canvas"));

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrap.append(who, bubble);
  el.chatScroll.appendChild(wrap);
  el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  return { wrap, bubble };
}

const PHASES = [
  { id: "model", label: "Prompting the model" },
  { id: "stream", label: "Streaming source code" },
  { id: "sandbox", label: "Verifying in an isolated session" },
  { id: "render", label: "Rendering from the container" },
];

function createTimeline(parent) {
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  for (const phase of PHASES) {
    const row = document.createElement("div");
    row.className = "tl-row";
    row.dataset.phase = phase.id;
    row.dataset.state = "idle";
    row.innerHTML =
      `<span class="tl-ico">○</span><span class="tl-label"></span><span class="tl-note"></span>`;
    row.querySelector(".tl-label").textContent = phase.label;
    timeline.appendChild(row);
  }
  parent.appendChild(timeline);

  return (id, { label, state: phaseState, note } = {}) => {
    const row = timeline.querySelector(`[data-phase="${id}"]`);
    if (!row) return;
    if (label) row.querySelector(".tl-label").textContent = label;
    if (note !== undefined) row.querySelector(".tl-note").textContent = note;
    if (phaseState) {
      row.dataset.state = phaseState;
      const icon = row.querySelector(".tl-ico");
      icon.textContent =
        phaseState === "done" ? "✓" :
        phaseState === "failed" ? "✕" :
        phaseState === "skipped" ? "–" : "";
    }
    el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  };
}

function addUsage(parent, items) {
  const row = document.createElement("div");
  row.className = "usage";
  for (const item of items) {
    if (!item) continue;
    const span = document.createElement("span");
    span.textContent = item;
    row.appendChild(span);
  }
  parent.appendChild(row);
}

/* ------------------------------------------------------------- sandbox view */

function renderSandbox(report) {
  el.sandbox.innerHTML = "";

  if (!report) {
    el.sandbox.innerHTML =
      `<div class="empty">Build something first — the artifact is verified inside an isolated Azure Container Apps dynamic session.</div>`;
    return;
  }

  if (report.skipped) {
    el.sandbox.innerHTML =
      `<div class="sandbox-note">Sandbox verification is disabled. Set <code>ACA_SESSION_POOL_ENDPOINT</code> to enable it.</div>`;
    return;
  }

  if (report.failed) {
    el.sandbox.innerHTML =
      `<div class="sandbox-note" style="border-color:var(--bad);color:var(--bad)">Sandbox verification failed: ${escapeHtml(report.error || "unknown error")}</div>`;
    return;
  }

  const score = report.score ?? 0;
  const color = score >= 90 ? "var(--ok)" : score >= 70 ? "var(--warn)" : "var(--bad)";

  const card = document.createElement("div");
  card.className = "score-card";
  card.innerHTML = `
    <div class="score-ring" style="background:conic-gradient(${color} ${score * 3.6}deg, var(--border) 0)">
      <span>${score}</span>
    </div>
    <div class="score-meta">
      <h3>${report.passed ? "Verified in an isolated session" : "Issues found in the sandbox"}</h3>
      <p>
        Executed real Python ${escapeHtml(report.engine?.python || "")} inside a Hyper-V isolated
        Azure Container Apps dynamic session — ${report.errorCount || 0} error(s),
        ${report.warnCount || 0} warning(s).
      </p>
    </div>`;
  el.sandbox.appendChild(card);

  const m = report.metrics || {};
  const metrics = document.createElement("div");
  metrics.className = "metrics";
  const cells = [
    ["Elements", fmtNum(m.elements)],
    ["Interactive", fmtNum(m.interactiveControls)],
    ["ARIA", fmtNum(m.ariaAnnotations)],
    ["JS", fmtBytes(m.scriptBytes || 0)],
    ["CSS", fmtBytes(m.styleBytes || 0)],
    ["Exec", report.executionMs != null ? `${report.executionMs} ms` : "—"],
  ];
  for (const [label, value] of cells) {
    const cell = document.createElement("div");
    cell.className = "metric";
    cell.innerHTML = `<b></b><span></span>`;
    cell.querySelector("b").textContent = value;
    cell.querySelector("span").textContent = label;
    metrics.appendChild(cell);
  }
  el.sandbox.appendChild(metrics);

  const checks = document.createElement("div");
  checks.className = "checks";
  for (const check of report.checks || []) {
    const cls = check.ok ? "pass" : check.severity === "warn" ? "warn" : "fail";
    const row = document.createElement("div");
    row.className = `check ${cls}`;
    row.innerHTML = `<span class="check-ico"></span><div class="check-body"><b></b><span></span></div>`;
    row.querySelector(".check-ico").textContent = check.ok ? "✓" : cls === "warn" ? "!" : "✕";
    row.querySelector("b").textContent = check.name;
    row.querySelector(".check-body span").textContent = check.detail;
    checks.appendChild(row);
  }
  el.sandbox.appendChild(checks);

  const note = document.createElement("div");
  note.className = "sandbox-note";
  note.innerHTML =
    `Session <code>${escapeHtml(report.sessionId || "")}</code> · ` +
    `round trip ${report.wallClockMs} ms · pool <code>${escapeHtml(state.status?.sandbox?.pool || "")}</code> ` +
    `in <code>${escapeHtml(state.status?.sandbox?.region || "")}</code>. ` +
    `Each session is a Hyper-V isolated micro-VM with its own filesystem and network namespace.`;
  el.sandbox.appendChild(note);
}

function setView(view) {
  state.view = view;
  el.stage.classList.toggle("hide", view !== "preview");
  el.sandbox.classList.toggle("show", view === "sandbox");
  $$("#viewSeg button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  el.deviceSeg.style.display = view === "preview" ? "" : "none";
}

/* ------------------------------------------------------------------ status */

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    state.status = status;

    el.modelText.textContent = status.deployment || "—";
    el.modelPill.title =
      `${status.endpointHost || ""} · ${status.deployment}` +
      (status.reasoningEffort ? ` · reasoning: ${status.reasoningEffort}` : "") +
      `\nauth: ${status.authMode}`;

    const runtime = status.runtime || {};
    if (runtime.host === "Azure Container Apps") {
      el.runtimeText.textContent = runtime.revision || runtime.app;
      el.runtimePill.classList.add("live");
      el.runtimePill.title = `Azure Container Apps\napp: ${runtime.app}\nrevision: ${runtime.revision}\nreplica: ${runtime.replica}`;
    } else {
      el.runtimeText.textContent = "local dev";
      el.runtimePill.title = "Running locally";
    }

    if (status.sandbox?.enabled) {
      el.sandboxText.textContent = `${status.sandbox.pool}`;
      el.sandboxPill.classList.add("live");
      el.sandboxPill.title = `Dynamic session pool: ${status.sandbox.pool} (${status.sandbox.region})`;
    } else {
      el.sandboxText.textContent = "sandbox off";
      el.sandboxPill.classList.add("bad");
    }

    if (status.render?.enabled) {
      el.renderText.textContent = `${status.render.pool} · micro-VM`;
      el.renderPill.classList.add("live");
      el.renderPill.title =
        `Renders run inside Azure Container Apps dynamic sessions\n${status.render.endpointHost}`;
    } else {
      el.renderText.textContent = "render: container";
      el.renderPill.title = "Renders are served by the container app itself";
    }
  } catch {
    toast("Cannot reach the server.", true);
  }
}

/* ---------------------------------------------------------------- generate */

async function generate() {
  const prompt = el.prompt.value.trim();
  if (!prompt || state.generating) return;

  addMessage("user", prompt);
  el.prompt.value = "";
  autoGrow();

  state.generating = true;
  el.sendBtn.disabled = true;
  el.prompt.disabled = true;
  el.cover.classList.add("on");
  el.streamDot.hidden = false;
  el.coverTitle.textContent = "Building…";
  el.coverDetail.textContent = `Streaming from ${state.status?.deployment || "Azure OpenAI"}`;

  const assistant = addMessage("assistant", "");
  const setPhase = createTimeline(assistant.wrap);
  setPhase("model", { state: "active" });

  const started = Date.now();
  let streamed = "";
  let sawArtifact = false;

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, currentCode: state.code, sessionId: state.sessionId }),
    });

    if (!response.ok || !response.body) {
      let message = `Request failed (${response.status}).`;
      try { message = (await response.json()).error || message; } catch { /* ignore */ }
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;

        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        if (event === "delta") {
          streamed += payload.delta;
          if (!sawArtifact) {
            const start = streamed.search(/<!doctype html>/i);
            if (start >= 0) {
              sawArtifact = true;
              setPhase("model", { state: "done", label: "Model responded" });
              setPhase("stream", { state: "active" });
              el.coverDetail.textContent = "Writing the document…";
            }
          }
          if (sawArtifact) {
            const start = streamed.search(/<!doctype html>/i);
            const body = streamed.slice(start);
            state.code = body;
            renderCode(true);
            setPhase("stream", { note: fmtBytes(body.length) });
          }
        } else if (event === "phase") {
          setPhase(payload.id, { label: payload.label, state: payload.state });
          if (payload.note) toast(payload.note, true);
        } else if (event === "artifact") {
          setPhase("stream", { state: "done", label: "Source code complete" });
          state.code = payload.html;
          state.artifactId = payload.id;
          state.renderUrl = payload.renderUrl;
          state.session = payload.session || null;
          renderCode();

          setPhase("render", { state: "active" });
          renderPreview();

          if (payload.session) {
            el.urlText.textContent =
              `session://${payload.session.hostname || payload.session.identifier.slice(0, 8)} · micro-VM`;
            el.urlText.title =
              `Rendered inside an Azure Container Apps dynamic session\n` +
              `identifier: ${payload.session.identifier}\n` +
              `host: ${payload.session.hostname}\n` +
              `kernel: ${payload.session.kernel}\n` +
              `node: ${payload.session.node} · ${payload.session.cpus} vCPU · ${payload.session.memoryMb} MB\n` +
              `allocated in ${payload.session.coldStartMs} ms`;
            setPhase("render", {
              state: "done",
              label: "Rendered inside an isolated micro-VM",
              note: `${payload.session.coldStartMs} ms`,
            });
          } else {
            el.urlText.textContent = `container · /api/artifact/${payload.id}/render`;
            el.urlText.title = "Rendered by the container app";
            setPhase("render", { state: "done", label: "Rendered from the container" });
          }

          assistant.bubble.textContent = payload.summary;
          state.versions.push({
            label: titleize(prompt),
            code: payload.html,
            id: payload.id,
            renderUrl: payload.renderUrl,
            report: null,
          });
          state.activeVersion = state.versions.length - 1;
          renderVersions();

          const usage = payload.usage || {};
          addUsage(assistant.wrap, [
            payload.deployment,
            usage.input_tokens ? `${fmtNum(usage.input_tokens)} in` : null,
            usage.output_tokens ? `${fmtNum(usage.output_tokens)} out` : null,
            `${((Date.now() - started) / 1000).toFixed(1)}s`,
          ]);

          el.cover.classList.remove("on");
          el.coverDetail.textContent = "Verifying in an isolated session…";
        } else if (event === "sandbox") {
          renderSandbox(payload);
          if (state.versions[state.activeVersion]) {
            state.versions[state.activeVersion].report = payload;
          }
          if (!payload.failed && !payload.skipped) {
            el.chatMeta.textContent = `sandbox ${payload.score}/100`;
          }
        } else if (event === "failed") {
          throw new Error(payload.error);
        }
      }
    }

    if (!state.artifactId) throw new Error("The build finished without producing an artifact.");
    toast("Build complete.");
  } catch (error) {
    setPhase("model", { state: "failed" });
    addMessage("error", `Build failed: ${error.message}`);
    toast(error.message, true);
  } finally {
    state.generating = false;
    el.sendBtn.disabled = false;
    el.prompt.disabled = false;
    el.cover.classList.remove("on");
    el.streamDot.hidden = true;
    el.prompt.focus();
  }
}

/* ------------------------------------------------------------------ actions */

function autoGrow() {
  el.prompt.style.height = "auto";
  el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 180)}px`;
}

function setDevice(device) {
  state.device = device;
  el.frameShell.className = `frame-shell${device === "desktop" ? "" : ` ${device}`}`;
  $$("#deviceSeg button").forEach((b) => b.classList.toggle("active", b.dataset.device === device));
}

function exportArtifact() {
  if (!state.code) return toast("Nothing to export yet.", true);
  const blob = new Blob([state.code], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(state.versions[state.activeVersion]?.label || "artifact")}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Artifact exported.");
}

async function copyCode() {
  if (!state.code) return toast("Nothing to copy yet.", true);
  try {
    await navigator.clipboard.writeText(state.code);
  } catch {
    const area = document.createElement("textarea");
    area.value = state.code;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("Code copied.");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("canvas-theme", theme);
  el.themeIcon.setAttribute(
    "d",
    theme === "dark"
      ? "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
      : "M12 4v2m0 12v2M4 12H2m20 0h-2M6.3 6.3 4.9 4.9m14.2 1.4 1.4-1.4M6.3 17.7l-1.4 1.4m14.2-1.4 1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
  );
}

/* ------------------------------------------------------------------ wiring */

el.sendBtn.addEventListener("click", generate);
el.prompt.addEventListener("input", autoGrow);
el.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    generate();
  }
});

$$(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    el.prompt.value = chip.textContent.trim();
    autoGrow();
    generate();
  })
);

el.newBtn.addEventListener("click", () => {
  state.code = "";
  state.artifactId = null;
  state.renderUrl = null;
  state.versions = [];
  state.activeVersion = -1;
  state.sessionId = `canvas-${Math.random().toString(36).slice(2, 10)}`;
  el.chatScroll.innerHTML = "";
  el.chatScroll.appendChild(el.hero);
  el.frame.removeAttribute("src");
  el.urlText.textContent = "served by the container · awaiting first build";
  el.chatMeta.textContent = "";
  renderCode();
  renderVersions();
  renderSandbox(null);
  setView("preview");
  toast("New session started.");
});

el.copyBtn.addEventListener("click", copyCode);
el.exportBtn.addEventListener("click", exportArtifact);
el.refreshBtn.addEventListener("click", () => {
  if (!state.renderUrl) return toast("Nothing to render yet.", true);
  renderPreview();
  toast("Preview reloaded from the container.");
});
el.popoutBtn.addEventListener("click", () => {
  if (!state.renderUrl) return toast("Nothing to open yet.", true);
  window.open(state.renderUrl, "_blank", "noopener");
});

el.viewSeg.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) setView(button.dataset.view);
});
el.deviceSeg.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-device]");
  if (button) setDevice(button.dataset.device);
});

el.themeBtn.addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

/* -------------------------------------------------------------------- boot */

applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
setDevice("desktop");
setView("preview");
renderCode();
renderSandbox(null);
autoGrow();
loadStatus();
el.prompt.focus();
