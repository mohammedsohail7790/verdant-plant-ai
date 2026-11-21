"use strict";
/* Verdant app: router, dashboard, workspaces (identify + diagnose), library, engine status. */

const $ = (id) => document.getElementById(id);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="ic ${cls}"><use href="#i-${n}"/></svg>`;
const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const pct = (p) => (p < 0.1 ? (p * 100).toFixed(1) : Math.round(p * 100)) + "%";
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : Math.floor(s / 86400) + " d ago";
};
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3000); }

/* ============ Theme ============ */
function isDark() { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; }
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  $$("[data-theme-toggle] use").forEach((u) => u.setAttribute("href", isDark() ? "#i-sun" : "#i-moon"));
}
applyTheme(store.get("theme", ""));
$$("[data-theme-toggle]").forEach((b) => (b.onclick = () => { const n = isDark() ? "light" : "dark"; store.set("theme", n); applyTheme(n); }));

/* ============ Engine status ============ */
let mode = store.get("mode", "auto");
const speciesIds = () => (mode === "auto" ? ["plantnet", "global"] : [mode]);
const loadingIds = new Set();
let dlPct = 0;

function loadModel(id) {
  if (Engine.isLoaded(id)) return Promise.resolve();
  loadingIds.add(id); paintEngine();
  return Engine.load(id, (s) => { dlPct = s.pct; paintEngine(); })
    .catch((e) => { setChip("err", "AI failed to load"); throw e; })
    .finally(() => { loadingIds.delete(id); paintEngine(); });
}
const ensureSpecies = () => Promise.all(speciesIds().map(loadModel));
function setChip(state, text) { $("chip").className = "chip " + state; $("chipText").textContent = text; }
function paintEngine() {
  const rows = [["plantnet", "Pl@ntNet"], ["global", "BioCLIP"], ["disease", "LeafDoctor"]];
  const used = (id) => id === "disease" || speciesIds().includes(id);
  $("ecList").innerHTML = rows.filter(([id]) => used(id)).map(([id, n]) => {
    const ready = Engine.isLoaded(id), busy = loadingIds.has(id);
    return `<div class="ec-row ${ready ? "ok" : busy ? "load" : ""}"><span class="st">${n}</span><span>${ready ? "Ready" : busy ? dlPct + "%" : "On demand"}</span></div>`;
  }).join("");
  const busy = loadingIds.size > 0, ready = !busy && speciesIds().every((i) => Engine.isLoaded(i));
  $("ecDot").className = "ec-dot" + (ready ? " ok" : "");
  $("ecTitle").textContent = busy ? "Downloading models…" : ready ? "AI engine ready" : "AI engine";
  $("ecBar").style.width = busy ? dlPct + "%" : ready ? "100%" : "0";
  if (busy) setChip("", `Downloading AI ${dlPct}%`);
  else if (ready) setChip("ready", `AI ready · ${[...document.querySelectorAll(".ec-row.ok")].length} model${document.querySelectorAll(".ec-row.ok").length > 1 ? "s" : ""}`);
  $$(".pills[data-pills]").forEach(renderPills);
}
function renderPills(el) {
  const ids = el.dataset.pills.split(",");
  el.innerHTML = ids.map((id) => { const m = Engine.SPEC[id]; return `<span class="pill ${Engine.isLoaded(id) ? "ok" : ""}"><i></i>${esc(m.short)} · ${m.species.toLocaleString()} ${id === "disease" ? "classes" : "species"} · ${m.sizeMB} MB</span>`; }).join("");
}

/* settings */
$("settingsBtn").onclick = () => { $("mode").value = mode; $("dlg").showModal(); };
$("dlg").addEventListener("close", () => {
  if ($("dlg").returnValue !== "ok" || $("mode").value === mode) return;
  mode = $("mode").value; store.set("mode", mode); toast("Engine updated"); paintEngine();
  ensureSpecies().then(() => ws.identify.cur.img && ws.identify.run()).catch((e) => toast(e.message));
});

/* ============ Image helpers ============ */
async function fetchSample(url) { const r = await fetch(url); if (!r.ok) throw new Error("download failed"); return new File([await r.blob()], "sample.jpg", { type: "image/jpeg" }); }

/* ============ Workspace ============ */
const CFG = {
  identify: {
    kind: "identify", pills: "plantnet,global", icon: "leaf",
    title: "Identify a plant", sub: "Name any plant from a photo. Two AI models cross-check each other.",
    hint: "Drop a plant photo here", tips: ["Fill the frame with one leaf, flower or fruit", "Use natural light and keep it in focus", "Try several angles for a more reliable match"],
    phTitle: "Your result will appear here", phText: "Add a photo and Verdant returns the species, confidence, taxonomy and alternatives in about a second.",
  },
  diagnose: {
    kind: "diagnose", pills: "disease", icon: "pulse",
    title: "Diagnose a leaf", sub: "Detect crop leaf diseases and get a treatment plan.",
    hint: "Drop a leaf photo here", tips: ["Photograph a single leaf, close up and in focus", "Plain background and even light work best", "Show the affected area clearly"],
    phTitle: "Your diagnosis will appear here", phText: "Upload a close-up of a crop leaf. LeafDoctor checks 38 healthy and diseased conditions across 14 crops.",
  },
};
const ws = {};

class Workspace {
  constructor(cfg, root) {
    this.cfg = cfg; this.root = root; this.cur = { img: null, url: "", blob: null }; this.runId = 0;
    this.S = { data: null, sel: 0, tab: "overview", view: "ref", animate: true, info: null, infoFor: null };
    root.innerHTML = `
      <div class="page-head"><div><h1>${cfg.title}</h1><p class="muted">${cfg.sub}</p></div></div>
      <div class="ws-grid">
        <div class="card capture">
          <div class="drop" tabindex="0" role="button" aria-label="${esc(cfg.hint)}">
            <img class="hidden" alt="Selected photo">
            <div class="scan hidden"><span></span></div>
            <div class="drop-hint"><div class="drop-ico">${icon("image")}</div><p class="drop-title">${cfg.hint}</p><p class="muted">or paste from clipboard (Ctrl+V)</p></div>
          </div>
          <div class="btn-row">
            <label class="btn primary">${icon("upload")} Upload<input type="file" accept="image/*" hidden></label>
            <button class="btn cam" type="button">${icon("camera")} Camera</button>
            <button class="btn sq retry" type="button" disabled title="Run again">${icon("refresh")}</button>
            <input class="cam-input" type="file" accept="image/*" capture="environment" hidden>
          </div>
          <div class="progress hidden"><div class="bar"><div></div></div><span class="muted"></span></div>
          <div class="samples hidden"><h4>Try a sample</h4><div class="sample-row"></div></div>
          ${cfg.kind === "diagnose" ? `<div class="crop-chips">${Knowledge.CROPS.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : ""}
          <div class="tips"><h4>For best results</h4><ul>${cfg.tips.map((t) => `<li>${icon("check")} ${t}</li>`).join("")}</ul></div>
        </div>
        <div class="results-col">
          <div class="card placeholder"><div class="ph-art">${icon(cfg.icon)}</div><h3>${cfg.phTitle}</h3><p>${cfg.phText}</p><div class="pills" data-pills="${cfg.pills}"></div></div>
          <div class="result hidden" aria-live="polite"></div>
        </div>
      </div>`;
    const q = (s) => root.querySelector(s);
    Object.assign(this, { drop: q(".drop"), preview: q(".drop img"), scan: q(".scan"), hintEl: q(".drop-hint"), file: q("input[type=file]"), retry: q(".retry"),
      progress: q(".progress"), ph: q(".placeholder"), result: q(".result"), samples: q(".samples") });
    this.file.onchange = (e) => { this.setImage(e.target.files[0]); e.target.value = ""; };
    this.retry.onclick = () => this.cur.img && this.run();
    this.drop.onclick = () => { if (!this.drop.classList.contains("has-img")) this.file.click(); };
    this.drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.file.click(); } };
    ["dragenter", "dragover"].forEach((ev) => this.drop.addEventListener(ev, (e) => { e.preventDefault(); this.drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => this.drop.addEventListener(ev, (e) => { e.preventDefault(); this.drop.classList.remove("over"); }));
    this.drop.addEventListener("drop", (e) => this.setImage(e.dataTransfer.files[0]));
    this.camInput = q(".cam-input");
    this.camInput.onchange = (e) => { this.setImage(e.target.files[0]); e.target.value = ""; };
    q(".cam").onclick = () => openCamera(this);
    this.result.addEventListener("click", (e) => this.onClick(e));
    renderPills(q(".pills"));
  }
  progressShow(p, text) {
    this.progress.classList.remove("hidden");
    const bar = this.progress.querySelector(".bar"); bar.classList.toggle("indet", p == null);
    if (p != null) bar.firstElementChild.style.width = p + "%";
    this.progress.querySelector(".muted").textContent = text || "";
  }
  progressHide() { this.progress.classList.add("hidden"); }
  setImage(file) {
    if (!file || !file.type.startsWith("image/")) return toast("Please choose an image file.");
    if (this.cur.url) URL.revokeObjectURL(this.cur.url);
    this.cur.blob = file; this.cur.url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { this.cur.img = img; this.run(); };
    img.onerror = () => toast("Could not read that image.");
    img.src = this.cur.url;
    this.showPreview(this.cur.url);
  }
  showPreview(url) { this.preview.src = url; this.preview.classList.remove("hidden"); this.hintEl.classList.add("hidden"); this.drop.classList.add("has-img"); }
  async run() {
    const my = ++this.runId, k = this.cfg.kind;
    this.retry.disabled = true; this.scan.classList.remove("hidden");
    try {
      const need = k === "identify" ? speciesIds() : ["disease"];
      if (!need.every((i) => Engine.isLoaded(i))) {
        this.progressShow(null, "Preparing AI models…");
        const t = setInterval(() => { const p = Engine.pctFor(need); this.progressShow(p, `Downloading AI model${need.length > 1 ? "s" : ""}… ${p}% (one-time, then cached)`); }, 300);
        try { await Promise.all(need.map(loadModel)); } finally { clearInterval(t); }
        if (my !== this.runId) return;
      }
      this.progressShow(null, "Analysing photo…");
      const data = k === "identify" ? await Engine.identify(this.cur.img, mode) : await Engine.diagnose(this.cur.img);
      if (my !== this.runId) return;
      this.progressHide(); data.photo = this.cur.url;
      this.show(data); addHistory(k, data, this);
    } catch (e) {
      if (my !== this.runId) return;
      console.error(e); this.progressHide(); this.ph.classList.add("hidden"); this.result.classList.remove("hidden");
      this.result.innerHTML = `<div class="card empty"><h3>Couldn't analyse that</h3><p class="err">${esc(e.message || e)}</p></div>`;
    } finally { if (my === this.runId) { this.scan.classList.add("hidden"); this.retry.disabled = false; } }
  }
  show(data) {
    Object.assign(this.S, { data, sel: 0, tab: "overview", view: "ref", animate: true });
    this.ph.classList.add("hidden"); this.result.classList.remove("hidden");
    this.paint();
    if (matchMedia("(max-width: 900px)").matches) this.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  restore(entry) {
    this.runId++; this.progressHide(); this.scan.classList.add("hidden"); this.cur.img = null; this.retry.disabled = true; this.showPreview(entry.t);
    this.show({ ...entry.payload, runs: [], totalMs: 0, photo: entry.t, restored: true });
  }
  onClick(e) {
    const t = e.target.closest("[data-tab],[data-sel],[data-view],[data-act]"); if (!t) return;
    const S = this.S;
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.animate = false; this.paint(); }
    else if (t.dataset.sel != null) { S.sel = +t.dataset.sel; S.view = "ref"; S.animate = true; S.tab = "overview"; S.infoFor = null; this.paint(); }
    else if (t.dataset.view) { S.view = t.dataset.view; S.animate = false; this.paint(); }
    else if (t.dataset.act) this.act(t.dataset.act);
  }
  async act(a) {
    const text = this.shareText();
    if (a === "copy") { try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch { toast("Copy failed"); } }
    if (a === "share") { if (navigator.share) { try { await navigator.share({ title: "Verdant", text }); } catch {} } else { try { await navigator.clipboard.writeText(text); toast("Copied text (sharing unavailable)"); } catch {} } }
    if (a === "print") print();
    if (a === "to-diagnose" || a === "to-identify") {
      const target = a === "to-diagnose" ? ws.diagnose : ws.identify;
      if (!this.cur.blob) return toast("Re-upload the photo to run another analysis.");
      go(a === "to-diagnose" ? "diagnose" : "identify"); target.setImage(this.cur.blob);
    }
  }
  tabsHTML(tabs) { return `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${this.S.tab === k ? "on" : ""}" role="tab" data-tab="${k}">${l}</button>`).join("")}</div>`; }
  pane(k, html) { return `<div class="tabpane ${this.S.tab === k ? "" : "hidden"}" data-pane="${k}">${html}</div>`; }
  animateRing(score) {
    if (!this.S.animate) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { const fg = this.result.querySelector(".ring .fg"); if (fg) fg.style.strokeDashoffset = (251.3 * (1 - score)).toFixed(1); this.S.animate = false; }));
  }
  ring(score, color) {
    const off = (251.3 * (1 - (this.S.animate ? 0 : score))).toFixed(1), [label] = verdict(score);
    return `<div class="ring" style="--ring:${color};--off:${off}"><svg viewBox="0 0 96 96"><circle class="bg" cx="48" cy="48" r="40"/><circle class="fg" cx="48" cy="48" r="40"/></svg><div class="rtx"><b>${Math.round(score * 100)}%</b><small>${label}</small></div></div>`;
  }
  paint() { return this.cfg.kind === "identify" ? paintIdentify(this) : paintDiagnose(this); }
  shareText() { return this.cfg.kind === "identify" ? identifyText(this) : diagnoseText(this); }
}
const verdict = (s) => (s >= 0.55 ? ["High", "var(--ok)"] : s >= 0.28 ? ["Medium", "#d97706"] : ["Low", "var(--red)"]);
const dxVerdict = (s) => (s >= 0.8 ? ["High", "var(--ok)"] : s >= 0.5 ? ["Medium", "#d97706"] : ["Low", "var(--red)"]);

/* ============ Identify result ============ */
function paintIdentify(w) {
  const S = w.S, d = S.data, item = d.items[S.sel], sci = item.sci;
  const info = S.infoFor === sci ? S.info : null;
  if (!info) Engine.lookup(sci).then((i) => { if (S.data === d && d.items[S.sel].sci === sci) { S.infoFor = sci; S.info = i; S.animate = false; w.paint(); } });
  const wiki = info?.wiki, tax = info?.tax;
  const common = info?.common?.[0] || (wiki && wiki.title.toLowerCase() !== sci.toLowerCase() ? wiki.title : "");
  const title = common || sci, [, vColor] = verdict(item.score);
  const agreeBadge = d.runs?.length > 1 ? (item.agree === 2 ? `<span class="badge">${icon("check")} Both AIs agree</span>` : `<span class="badge amber">${icon("alert")} Models differ</span>`) : "";
  const hasRef = !!wiki?.img, view = hasRef ? S.view : "you";
  const media = view === "ref" && hasRef
    ? `<img src="${esc(wiki.img)}" alt="${esc(title)}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${esc(wiki.thumb)}'"><span class="credit">Reference · Wikipedia</span>`
    : d.photo ? `<img src="${esc(d.photo)}" alt="Your photo">` : "";
  w.result.innerHTML = `
  <article class="card res">
    <div class="res-media">${media}${hasRef ? `<div class="seg"><button data-view="ref" class="${view === "ref" ? "on" : ""}">Reference</button><button data-view="you" class="${view === "you" ? "on" : ""}">Your photo</button></div>` : ""}</div>
    <div class="res-head">
      <div><div class="eyebrow">${S.sel === 0 ? "Best match" : "Match #" + (S.sel + 1)} ${agreeBadge}</div>
        <h2>${esc(title)}</h2><p class="sci">${esc(sci)}${item.family ? " · " + esc(item.family) : ""}</p>
        ${info?.common?.length > 1 ? `<p class="aka">Also called ${info.common.slice(1, 4).map(esc).join(", ")}</p>` : ""}</div>
      ${w.ring(item.score, vColor)}
    </div>
    <div class="actions">
      <button class="btn sm" data-act="copy">${icon("copy")} Copy</button><button class="btn sm" data-act="share">${icon("share")} Share</button><button class="btn sm" data-act="print">${icon("print")} Export PDF</button>
      <button class="btn sm" data-act="to-diagnose">${icon("pulse")} Check leaf health</button>
    </div>
    ${w.tabsHTML([["overview", "Overview"], ["taxonomy", "Taxonomy"], ["matches", "Top matches"], ["tech", "AI details"]])}
    ${w.pane("overview", idOverview(info, item, sci))}${w.pane("taxonomy", idTaxonomy(info, tax, sci))}${w.pane("matches", idMatches(w))}${w.pane("tech", idTech(d))}
  </article>`;
  w.animateRing(item.score);
}
function idOverview(info, item, sci) {
  const wiki = info?.wiki; let body;
  if (!info) body = `<div class="skel"><i></i><i></i><i></i></div>`;
  else if (!wiki) body = `<p class="muted">No encyclopedia entry was found for this species.</p>`;
  else body = `${wiki.desc ? `<p class="mini-top" style="margin-bottom:8px;text-transform:capitalize">${esc(wiki.desc)}</p>` : ""}<p class="summary">${esc(wiki.extract)}</p>`;
  const q = encodeURIComponent(sci);
  return `${body}<div class="ext-links">
    ${wiki?.url ? `<a href="${esc(wiki.url)}" target="_blank" rel="noopener">${icon("ext")} Wikipedia</a>` : ""}
    <a href="https://www.gbif.org/species/${info?.tax?.key || "search?q=" + q}" target="_blank" rel="noopener">${icon("ext")} GBIF</a>
    <a href="https://identify.plantnet.org/species?q=${q}" target="_blank" rel="noopener">${icon("ext")} Pl@ntNet</a>
    <a href="https://www.inaturalist.org/taxa/search?q=${q}" target="_blank" rel="noopener">${icon("ext")} iNaturalist</a></div>
    <div class="notice warn">${icon("alert")}<div><strong>${item.score < 0.28 ? "Low confidence. " : ""}AI can be wrong.</strong> ${item.score < 0.28 ? "Try a closer, sharper photo or another angle. " : ""}Never eat, handle or use a plant medicinally based on this result alone.</div></div>`;
}
function idTaxonomy(info, tax, sci) {
  if (!info) return `<div class="skel"><i></i><i></i><i></i></div>`;
  if (!tax) return `<p class="muted">Taxonomy is not available for <em>${esc(sci)}</em>.</p>`;
  const rows = [["Kingdom", tax.kingdom], ["Phylum", tax.phylum], ["Class", tax.class], ["Order", tax.order], ["Family", tax.family], ["Genus", tax.genus], ["Species", tax.species || sci]].filter((r) => r[1]);
  return `<ul class="kv">${rows.map(([k, v]) => `<li><span>${k}</span><b>${esc(v)}</b></li>`).join("")}</ul><p class="tech-note">Source: GBIF Backbone Taxonomy${tax.status ? " · " + esc(tax.status.toLowerCase()) : ""}.</p>`;
}
function idMatches(w) {
  const d = w.S.data;
  return `<div class="alts">${d.items.map((it, i) => `<button class="alt ${i === w.S.sel ? "sel" : ""}" data-sel="${i}"><span class="rk">${i + 1}</span>
    <span class="nm">${esc(it.sci)}${it.agree === 2 ? '<span class="agree-dot" title="Both models rank this in their top 3"></span>' : ""}<em>${esc(it.family || "")}</em></span>
    <span class="meter"><i style="width:${Math.max(2, it.score * 100).toFixed(0)}%"></i></span><span class="pc">${pct(it.score)}</span></button>`).join("")}</div>
    <p class="tech-note">Select a match to see its details. A green dot means both AI models ranked it in their top 3.</p>`;
}
function idTech(d) {
  if (!d.runs?.length) return `<p class="muted">Technical details aren't stored for past scans. Run the photo again to see them.</p>`;
  const rows = d.runs.map((r) => { const sp = Engine.SPEC[r.id]; return `<tr><td><b>${esc(sp.short)}</b><br><span class="muted small">${esc(sp.scope)}</span></td><td><em>${esc(r.top[0].sci)}</em></td><td>${pct(r.top[0].p)}</td><td>${Math.round(r.ms)} ms</td></tr>`; }).join("");
  return `<table class="tech-table"><thead><tr><th>Model</th><th>Top-1</th><th>Confidence</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="tech-note"><strong>Fusion:</strong> the models' probabilities are combined as a weighted mean (Pl@ntNet 0.4, BioCLIP 0.6). When both rank a species in their top 3 they are combined as independent evidence (noisy-OR), so agreement raises confidence. Total ${Math.round(d.totalMs)} ms on-device.</p>`;
}
function identifyText(w) { const it = w.S.data.items[w.S.sel], c = w.S.infoFor === it.sci && w.S.info?.common?.[0]; return `${c ? c + " (" + it.sci + ")" : it.sci} · ${Math.round(it.score * 100)}% confidence · identified with Verdant`; }

/* ============ Diagnose result ============ */
const SEV = { Moderate: [2, "#d97706", "amber"], High: [3, "#ea580c", "amber"], Severe: [4, "#dc2626", "red"] };
function dxInfo(item) { const c = Knowledge.CLASSES[item.id]; return { c, kb: c.key ? Knowledge.KB[c.key] : null }; }
function paintDiagnose(w) {
  const S = w.S, d = S.data, item = d.items[S.sel], { c, kb } = dxInfo(item), unsure = item.p < 0.5;
  const [, color] = dxVerdict(item.p), sev = kb ? SEV[kb.severity] : null;
  const tone = unsure ? "gray" : c.healthy ? "" : sev[2], heroIcon = unsure ? "alert" : c.healthy ? "check-c" : "alert";
  const heroTitle = unsure ? "Result uncertain" : c.healthy ? "Looks healthy" : `${kb.severity} risk · ${kb.type}`;
  const heroText = unsure ? "The model isn't confident. It may not recognise this crop, or the photo may be unclear." : c.healthy ? `No signs of disease detected on this ${c.crop.toLowerCase()} leaf.` : `Treat promptly. See the Treatment tab for a step-by-step plan.`;
  const alt = d.items.map((it, i) => { const x = Knowledge.CLASSES[it.id]; return `<button class="alt ${i === S.sel ? "sel" : ""}" data-sel="${i}"><span class="rk">${i + 1}</span><span class="nm">${esc(x.healthy ? "Healthy" : x.condition)}<em>${esc(x.crop)}</em></span><span class="meter"><i style="width:${Math.max(2, it.p * 100).toFixed(0)}%"></i></span><span class="pc">${pct(it.p)}</span></button>`; }).join("");
  const lvl = sev ? sev[0] : 0;
  w.result.innerHTML = `
  <article class="card res">
    <div class="dx-hero ${tone}"><div class="dx-ic">${icon(heroIcon)}</div><div><b>${esc(heroTitle)}</b><span>${esc(heroText)}</span></div></div>
    <div class="res-media dx-photo">${d.photo ? `<img src="${esc(d.photo)}" alt="Your leaf photo">` : ""}</div>
    <div class="res-head">
      <div><div class="eyebrow">${S.sel === 0 ? "Diagnosis" : "Alternative #" + (S.sel + 1)} <span class="badge gray">${esc(c.crop)}</span>${kb ? `<span class="badge ${sev[2] === "red" ? "red" : "amber"}">${esc(kb.type)}</span>` : `<span class="badge">Healthy</span>`}</div>
        <h2>${c.healthy ? "Healthy " + esc(c.crop.toLowerCase()) + " leaf" : esc(c.condition)}</h2>
        ${kb ? `<p class="sci">${esc(kb.cause)}</p><div class="sev" style="--lvl:${sev[1]}">Severity ${[1, 2, 3, 4].map((n) => `<i class="${n <= lvl ? "on" : ""}"></i>`).join("")} <b style="margin-left:4px;color:${sev[1]}">${kb.severity}</b></div>` : `<p class="sci">No disease detected</p>`}</div>
      ${w.ring(item.p, color)}
    </div>
    <div class="actions"><button class="btn sm" data-act="copy">${icon("copy")} Copy</button><button class="btn sm" data-act="share">${icon("share")} Share</button><button class="btn sm" data-act="print">${icon("print")} Export PDF</button><button class="btn sm" data-act="to-identify">${icon("leaf")} Identify this plant</button></div>
    ${w.tabsHTML([["overview", "Overview"], ["treatment", "Treatment"], ["matches", "Other possibilities"], ["tech", "AI details"]])}
    ${w.pane("overview", dxOverview(c, kb, item, unsure))}${w.pane("treatment", dxTreatment(c, kb))}
    ${w.pane("matches", `<div class="alts">${alt}</div><p class="tech-note">Select a possibility to read about it.</p>`)}
    ${w.pane("tech", d.ms ? `<table class="tech-table"><thead><tr><th>Model</th><th>Top-1</th><th>Confidence</th><th>Time</th></tr></thead><tbody><tr><td><b>LeafDoctor</b><br><span class="muted small">${esc(Engine.SPEC.disease.scope)}</span></td><td>${esc(c.crop)} · ${esc(c.condition)}</td><td>${pct(d.items[0].p)}</td><td>${Math.round(d.ms)} ms</td></tr></tbody></table>
      <p class="tech-note">MobileNetV2 trained on PlantVillage (95% benchmark accuracy). Field photos with clutter can be less accurate than the clean lab-style images it learned from.</p>` : `<p class="muted">Technical details aren't stored for past scans.</p>`)}
  </article>`;
  w.animateRing(item.p);
}
function dxOverview(c, kb, item, unsure) {
  const warn = unsure ? `<div class="notice bad">${icon("alert")}<div><strong>Low confidence (${pct(item.p)}).</strong> This tool only recognises ${Knowledge.CROPS.length} crops (${Knowledge.CROPS.join(", ")}). For anything else, or a blurry photo, results are unreliable.</div></div>` : "";
  if (c.healthy) return `<p class="summary">No visible disease pattern was detected on this <b>${esc(c.crop.toLowerCase())}</b> leaf. Keep up good practice to stay ahead of problems:</p>
    <ul class="bul" style="margin-top:14px">${Knowledge.HEALTHY_TIPS.map((t) => `<li>${icon("check")}${t}</li>`).join("")}</ul>${warn}
    <div class="notice ok">${icon("shield")}<div>A healthy result is not a guarantee. Early infections can be invisible; keep scouting regularly.</div></div>`;
  return `<p class="summary"><b>${esc(c.condition)}</b> on <b>${esc(c.crop.toLowerCase())}</b>, a ${esc(kb.type.toLowerCase())} problem${kb.cause ? ` caused by <i>${esc(kb.cause)}</i>` : ""}.</p>
    <h4 style="margin:18px 0 10px;font-size:.74rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)">What to look for</h4>
    <ul class="bul">${kb.symptoms.map((s) => `<li>${icon("check")}${esc(s)}</li>`).join("")}</ul>${warn}
    <div class="notice warn">${icon("alert")}<div><strong>Screening aid, not a lab test.</strong> Confirm with a local agricultural extension service before spraying or removing plants.</div></div>`;
}
function dxTreatment(c, kb) {
  if (c.healthy) return `<h4 style="margin-bottom:10px;font-size:.74rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)">Keep it healthy</h4><ul class="bul">${Knowledge.HEALTHY_TIPS.map((t) => `<li>${icon("check")}${t}</li>`).join("")}</ul>`;
  return `<div class="dx-cols"><div><h4>Recommended actions</h4><ol class="num">${kb.treatment.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></div>
    <div><h4>Prevention</h4><ul class="bul">${kb.prevention.map((t) => `<li>${icon("shield")}${esc(t)}</li>`).join("")}</ul></div></div>
    <div class="notice warn">${icon("alert")}<div>Always follow product labels and local regulations for any fungicide, bactericide or pesticide. Prefer integrated, low-chemical options first.</div></div>`;
}
function diagnoseText(w) { const it = w.S.data.items[w.S.sel], c = Knowledge.CLASSES[it.id]; return `${c.crop}: ${c.healthy ? "healthy" : c.condition} · ${Math.round(it.p * 100)}% confidence · diagnosed with Verdant`; }

/* ============ History / dashboard / library ============ */
let history = [];
try { history = JSON.parse(store.get("history2", "[]")).filter((h) => h && h.t && h.payload && h.kind); } catch { history = []; }
function makeThumb(img) {
  const c = document.createElement("canvas"); c.width = 360; c.height = 240; const ctx = c.getContext("2d"), s = Math.max(360 / img.naturalWidth, 240 / img.naturalHeight);
  ctx.drawImage(img, (360 - img.naturalWidth * s) / 2, (240 - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  return c.toDataURL("image/jpeg", 0.7);
}
function entryMeta(e) {
  if (e.kind === "identify") { const it = e.payload.items[0]; return { title: e.name || it.sci, sub: it.sci, score: it.score, label: "Plant", tone: "" }; }
  const it = e.payload.items[0], c = Knowledge.CLASSES[it.id];
  return { title: c.healthy ? `Healthy ${c.crop}` : `${c.crop} · ${c.condition}`, sub: c.healthy ? "No disease detected" : (Knowledge.KB[c.key]?.type || "") , score: it.p, label: c.healthy ? "Healthy" : "Disease", tone: c.healthy ? "" : "amber" };
}
function addHistory(kind, data, w) {
  const payload = kind === "identify" ? { items: data.items.map((i) => ({ sci: i.sci, family: i.family, score: i.score, agree: i.agree })), consensus: data.consensus } : { items: data.items.map((i) => ({ id: i.id, p: i.p })) };
  const e = { id: Date.now(), kind, t: makeThumb(w.cur.img), ts: Date.now(), payload };
  history = [e, ...history].slice(0, 40); persist();
  if (kind === "identify") Engine.lookup(payload.items[0].sci).then((i) => { const h = history.find((x) => x.id === e.id); if (h && i.common[0]) { h.name = i.common[0]; persist(); } });
}
function persist() {
  try { localStorage.setItem("history2", JSON.stringify(history)); } catch { history = history.slice(0, 10); store.set("history2", JSON.stringify(history)); }
  renderDashboard(); renderLibrary();
}
function renderDashboard() {
  $("libCount").textContent = history.length;
  const ids = history.filter((h) => h.kind === "identify"), dx = history.filter((h) => h.kind === "diagnose");
  const species = new Set(ids.map((h) => h.payload.items[0].sci)).size, sick = dx.filter((h) => !Knowledge.CLASSES[h.payload.items[0].id].healthy).length;
  const avg = history.length ? Math.round((history.reduce((a, h) => a + (h.payload.items[0].score ?? h.payload.items[0].p), 0) / history.length) * 100) : 0;
  const stat = (lab, val, sub, ic) => `<div class="stat"><div class="lab">${lab}${icon(ic)}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
  $("stats").innerHTML = stat("Total scans", history.length, "identifications + diagnoses", "layers") + stat("Species found", species, "unique plants", "leaf") + stat("Diseases found", sick, `${dx.length} leaves checked`, "bug") + stat("Avg. confidence", history.length ? avg + "%" : "–", "across all scans", "bar");
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i)); return d; });
  const counts = days.map((d) => history.filter((h) => h.ts >= d.getTime() && h.ts < d.getTime() + 864e5).length), max = Math.max(1, ...counts);
  $("chart").innerHTML = days.map((d, i) => `<div class="col"><em>${counts[i] || ""}</em><b class="${counts[i] ? "" : "zero"}" style="height:${counts[i] ? Math.round(10 + (counts[i] / max) * 90) : 4}px"></b><span>${d.toLocaleDateString(undefined, { weekday: "short" })}</span></div>`).join("");
  $("recent").innerHTML = history.length ? history.slice(0, 5).map((h) => { const m = entryMeta(h); return `<button class="r-item" data-open="${h.id}"><img src="${h.t}" alt=""><div class="t"><b>${esc(m.title)}</b><small>${esc(m.label)} · ${ago(h.ts)}</small></div><span class="badge ${m.tone}">${Math.round(m.score * 100)}%</span></button>`; }).join("")
    : `<div class="empty-mini">No scans yet. Try <a href="#/app/identify">identifying a plant</a> or <a href="#/app/diagnose">diagnosing a leaf</a>.</div>`;
}
let libFilter = "all", libQuery = "";
function renderLibrary() {
  const list = history.filter((h) => (libFilter === "all" || h.kind === libFilter) && (!libQuery || (entryMeta(h).title + " " + entryMeta(h).sub).toLowerCase().includes(libQuery)));
  $("libGrid").innerHTML = list.length ? list.map((h) => { const m = entryMeta(h); return `<div class="lib-item" role="button" tabindex="0" data-open="${h.id}"><img src="${h.t}" alt="">
    <span class="kind badge ${h.kind === "identify" ? "" : m.tone || ""}">${esc(m.label)}</span><button class="del" data-del="${h.id}" aria-label="Delete">${icon("trash")}</button>
    <div class="b"><b>${esc(m.title)}</b><small>${esc(m.sub)}</small><div class="meta"><span class="badge gray">${Math.round(m.score * 100)}%</span><small>${ago(h.ts)}</small></div></div></div>`; }).join("")
    : `<div class="lib-empty"><h3>${history.length ? "No matches" : "Your library is empty"}</h3><p>${history.length ? "Try a different search or filter." : "Everything you identify or diagnose is saved here, on your device."}</p></div>`;
}
function openEntry(id) {
  const e = history.find((h) => h.id === +id); if (!e) return;
  go(e.kind === "identify" ? "identify" : "diagnose"); ws[e.kind].restore(e);
}
document.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); history = history.filter((h) => h.id !== +del.dataset.del); persist(); return toast("Removed from library"); }
  const op = e.target.closest("[data-open]"); if (op) openEntry(op.dataset.open);
});
$("libFilter").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; libFilter = b.dataset.f; $$("#libFilter button").forEach((x) => x.classList.toggle("on", x === b)); renderLibrary(); };
$("libSearch").oninput = (e) => { libQuery = e.target.value.trim().toLowerCase(); renderLibrary(); };
$("clearBtn").onclick = () => { if (!history.length) return; if (confirm("Delete all saved scans from this device?")) { history = []; persist(); toast("Library cleared"); } };
$("exportBtn").onclick = () => {
  if (!history.length) return toast("Nothing to export yet");
  const rows = [["date", "type", "result", "detail", "confidence_pct"], ...history.map((h) => { const m = entryMeta(h); return [new Date(h.ts).toISOString(), m.label, m.title, m.sub, Math.round(m.score * 100)]; })];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "verdant-library.csv"; a.click(); toast("Exported CSV");
};

/* ============ Camera ============ */
let stream, camTarget;
/* Phones (touch) and non-secure origins such as http://192.168.x.x use the native camera app via
   <input capture>, which works everywhere and gives full-resolution, auto-focused photos.
   Desktop on localhost/https gets the live viewfinder. */
const useNativeCamera = () => matchMedia("(pointer: coarse)").matches || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia;
function openCamera(target) {
  if (useNativeCamera()) return target.camInput.click();
  camTarget = target;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, audio: false })
    .then((s) => { stream = s; $("video").srcObject = s; $("camDlg").showModal(); }).catch(() => toast("Camera permission denied. Use Upload instead."));
}
const stopCam = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
$("camClose").onclick = () => $("camDlg").close(); $("camDlg").addEventListener("close", stopCam);
$("camShot").onclick = () => {
  const v = $("video"), c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob((b) => { $("camDlg").close(); camTarget.setImage(new File([b], "capture.jpg", { type: "image/jpeg" })); }, "image/jpeg", 0.92);
};

/* ============ Samples ============ */
/* Bundled sample photos (./samples). Plants: Wikimedia Commons thumbnails; leaves: PlantVillage test split (CC0). */
const SAMPLES = {
  identify: [["Monstera", "plant-monstera"], ["Hibiscus", "plant-hibiscus"], ["Dog rose", "plant-dog-rose"], ["Aloe", "plant-aloe"], ["Lavender", "plant-lavender"], ["Mango", "plant-mango"]],
  diagnose: [["Tomato virus", "dx-tomato-yellow-leaf-curl"], ["Tomato mites", "dx-tomato-spider-mites"], ["Squash", "dx-squash-powdery-mildew"], ["Peach", "dx-peach-bacterial-spot"], ["Grape", "dx-grape-leaf-spot"], ["Healthy corn", "dx-corn-healthy"]],
};
function loadSamples(w) {
  if (w.samplesLoaded) return; w.samplesLoaded = true;
  const items = SAMPLES[w.cfg.kind].map(([name, f]) => ({ name, src: `samples/${f}.jpg` }));
  w.samples.classList.remove("hidden");
  const row = w.samples.querySelector(".sample-row");
  row.innerHTML = items.map((s, i) => `<button class="sample" data-i="${i}" title="${esc(s.name)}"><img src="${esc(s.src)}" alt="${esc(s.name)}" loading="lazy"><span>${esc(s.name)}</span></button>`).join("");
  row.onclick = async (e) => { const b = e.target.closest(".sample"); if (!b) return; try { w.setImage(await fetchSample(items[+b.dataset.i].src)); } catch { toast("Could not load that sample (offline?)"); } };
}

/* ============ Phone hand-off (QR) ============ */
async function initPhoneCard() {
  if (!/^https?:$/.test(location.protocol) || matchMedia("(pointer: coarse)").matches) return;
  try {
    const info = await (await fetch("__info")).json();
    const url = (info.urls || [])[0]; if (!url) return;
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    $("phoneUrl").textContent = url; $("phoneCard").classList.remove("hidden");
  } catch {}
}

/* ============ Router ============ */
const TITLES = { dashboard: "Dashboard", identify: "Identify plant", diagnose: "Diagnose leaf", library: "Library", about: "How it works" };
let appStarted = false, activeView = "dashboard";
function go(view) { location.hash = view === "dashboard" ? "#/app" : "#/app/" + view; }
function startApp() {
  if (appStarted) return; appStarted = true;
  ws.identify = new Workspace(CFG.identify, document.querySelector('[data-view="identify"]'));
  ws.diagnose = new Workspace(CFG.diagnose, document.querySelector('[data-view="diagnose"]'));
  renderDashboard(); renderLibrary(); paintEngine(); initPhoneCard();
  if (matchMedia("(pointer: coarse)").matches && !localStorage.getItem("seenDl")) { store.set("seenDl", "1"); toast("First launch downloads AI models (~100 MB). Wi-Fi recommended."); }
  ensureSpecies().catch((e) => toast("AI failed to load: " + (e.message || e)));
}
function route() {
  const h = location.hash;
  const m = h.match(/^#\/app(?:\/(\w+))?/);
  if (h && !m && !h.startsWith("#/")) return; // in-page anchor
  const inApp = !!m;
  $("landing").classList.toggle("hidden", inApp); $("app").classList.toggle("hidden", !inApp);
  document.body.classList.toggle("in-app", inApp);
  if (!inApp) { scrollTo(0, 0); return; }
  startApp();
  let v = m[1] || "dashboard"; if (!TITLES[v]) v = "dashboard"; activeView = v;
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.dataset.view !== v));
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === v));
  $("pageTitle").textContent = TITLES[v];
  closeDrawer(); scrollTo(0, 0);
  if (v === "identify" || v === "diagnose") { loadSamples(ws[v]); if (v === "diagnose") loadModel("disease").catch(() => {}); }
  if (v === "dashboard") renderDashboard();
}
addEventListener("hashchange", route);
$$("[data-scroll]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); document.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: "smooth" }); }));
addEventListener("scroll", () => $("lpNav").classList.toggle("scrolled", scrollY > 8), { passive: true });
document.addEventListener("paste", (e) => {
  if (!appStarted || $("app").classList.contains("hidden")) return;
  const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/")); if (!it) return;
  const target = activeView === "diagnose" ? ws.diagnose : ws.identify; if (activeView !== "identify" && activeView !== "diagnose") go("identify");
  target.setImage(it.getAsFile());
});
/* mobile drawer */
const closeDrawer = () => { $("side").classList.remove("open"); $("scrim").classList.add("hidden"); };
$("menuBtn").onclick = () => { $("side").classList.add("open"); $("scrim").classList.remove("hidden"); };
$("scrim").onclick = closeDrawer;

route();
