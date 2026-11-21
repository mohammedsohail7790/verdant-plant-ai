"use strict";
/**
 * Engine: on-device plant recognition.
 *  - Model A "plantnet": Pl@ntNet MobileNetV4-Hybrid-M, 7,806 species (specialist, strong on European flora)
 *  - Model B "global"  : BioCLIP-2.5 distilled FastViT, 4,271 species from iNaturalist (worldwide)
 * Both run in the browser via ONNX Runtime Web (WebAssembly). Results are fused by confidence-weighted voting.
 */
const Engine = (() => {
  const HF = "https://huggingface.co/";
  const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
  const CACHE = "plant-id-models-v2";
  const SPEC = {
    plantnet: {
      id: "plantnet", name: "Pl@ntNet MobileNetV4", short: "Pl@ntNet", species: 7806, input: 512, sizeMB: 79,
      scope: "Specialist · Europe & Mediterranean", base: HF + "PlantNet/mobilenetv4-hybrid-m-plantclef2024/resolve/main/",
    },
    global: {
      id: "global", name: "BioCLIP-2.5 Mobile", short: "BioCLIP", species: 4271, input: 224, sizeMB: 24,
      scope: "Generalist · Worldwide (iNaturalist)", base: HF + "crazedcodernate/bioclip-2.5-mobile-fastvit/resolve/main/",
    },
    disease: {
      id: "disease", name: "MobileNetV2 PlantVillage", short: "LeafDoctor", species: 38, input: 224, sizeMB: 9,
      scope: "Leaf disease · 14 crops, 38 classes", base: HF + "onnx-community/mobilenet_v2_1.0_224-plant-disease-identification-ONNX/resolve/main/",
    },
  };
  const TEMP_PLANTNET = 0.7;  // distilled model is under-confident: mild sharpening (T=1 gave ~9% on correct IDs)
  const GLOBAL_SCALE = 40;    // CLIP logit scale for cosine similarities (100 saturates to 99-100%)

  const loaded = {};   // id -> model object
  const pending = {};  // id -> Promise
  const progress = {}; // id -> {got,total}
  let onProgress = () => {};

  /* ---------- utils ---------- */
  function binomial(name) {
    const w = String(name).replace(/\(.*?\)/g, "").trim().split(/\s+/);
    const rank = /^(sect|subsect|ser|subg|subsp|var|f)\.?$/;
    return (w[0] === "×" || w[1] === "×" || rank.test(w[1] || "") ? w.slice(0, 3) : w.slice(0, 2)).join(" ");
  }
  /* Model cache in IndexedDB: unlike the Cache API it also works on plain-http LAN addresses (phones) and file://. */
  const idb = {
    db: null,
    open() {
      if (this.db) return this.db;
      return (this.db = new Promise((res, rej) => {
        if (!self.indexedDB) return rej(new Error("no indexedDB"));
        const r = indexedDB.open("verdant-models", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("blobs");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }));
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("blobs").objectStore("blobs").get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); },
    async put(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("blobs", "readwrite"); t.objectStore("blobs").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
  };
  async function download(url, id) {
    try {
      const hit = await idb.get(url);
      if (hit) { if (id) { progress[id] = { got: 1, total: 1 }; onProgress(snapshot()); } return hit; }
    } catch {}
    const cache = true;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const total = +res.headers.get("content-length") || 0;
    const reader = res.body.getReader(), chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (id) { progress[id] = { got, total }; onProgress(snapshot()); }
    }
    const buf = new Uint8Array(got); let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    if (cache) { try { await idb.put(url, buf.buffer); } catch {} }
    return buf.buffer;
  }
  function snapshot() {
    let got = 0, total = 0, any = false;
    for (const k of Object.keys(progress)) { got += progress[k].got; total += progress[k].total || SPEC[k].sizeMB * 1e6; any = true; }
    return { pct: any && total ? Math.min(100, Math.round((got / total) * 100)) : 0 };
  }
  /** Download progress (0-100) over a subset of models. */
  function pctFor(ids) {
    let got = 0, total = 0;
    for (const id of ids) { if (Engine_loadedFlag(id)) { got += 1; total += 1; continue; } const p = progress[id]; got += p ? p.got : 0; total += p && p.total ? p.total : SPEC[id].sizeMB * 1e6; }
    return total ? Math.min(100, Math.round((got / total) * 100)) : 0;
  }
  const Engine_loadedFlag = (id) => !!loaded[id];
  function waitForOrt() {
    return new Promise((res, rej) => {
      let n = 0;
      (function chk() {
        if (self.ort) return res();
        if (++n > 200) return rej(new Error("Could not load the AI runtime. Check your internet connection."));
        setTimeout(chk, 100);
      })();
    });
  }
  function parseNpy(buf) {
    const dv = new DataView(buf);
    const hlen = dv.getUint16(8, true);
    const header = new TextDecoder().decode(new Uint8Array(buf, 10, hlen));
    const m = header.match(/\((\d+),\s*(\d+)\)/);
    return { rows: +m[1], cols: +m[2], data: new Float32Array(buf.slice(10 + hlen)) };
  }

  /* ---------- loading ---------- */
  async function loadPlantNet() {
    const b = SPEC.plantnet.base;
    const [meta, labels, buf] = await Promise.all([
      fetch(b + "onnx/metadata.json").then((r) => r.json()),
      fetch(b + "labels.json").then((r) => r.json()),
      download(b + "onnx/model.onnx", "plantnet"),
    ]);
    const session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return { id: "plantnet", session, meta, labels };
  }
  async function loadGlobal() {
    const b = SPEC.global.base;
    const [labels, tbuf] = await Promise.all([
      fetch(b + "taxa_labels.json").then((r) => r.json()),
      download(b + "taxa_table.npy", null),
    ]);
    let session, used = "fp16";
    try {
      session = await ort.InferenceSession.create(await download(b + "flora_student_fp16.onnx", "global"), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    } catch (e) {
      console.warn("fp16 failed, using fp32", e);
      used = "fp32";
      session = await ort.InferenceSession.create(await download(b + "flora_student_fp32.onnx", "global"), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    }
    return { id: "global", session, labels, table: parseNpy(tbuf), precision: used, inputName: session.inputNames[0] };
  }
  async function loadDisease() {
    const buf = await download(SPEC.disease.base + "onnx/model.onnx", "disease");
    const session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return { id: "disease", session, inputName: session.inputNames[0], outputName: session.outputNames[0] };
  }
  async function load(id, cb) {
    if (cb) onProgress = cb;
    if (loaded[id]) return loaded[id];
    if (pending[id]) return pending[id];
    pending[id] = (async () => {
      await waitForOrt();
      ort.env.wasm.wasmPaths = ORT_CDN;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      loaded[id] = await (id === "plantnet" ? loadPlantNet() : id === "disease" ? loadDisease() : loadGlobal());
      return loaded[id];
    })().catch((e) => { delete pending[id]; throw e; });
    return pending[id];
  }

  /* ---------- inference ---------- */
  const pixelCache = new Map();
  function pixels(img, size) {
    const key = size;
    if (pixelCache.get("img") !== img) pixelCache.clear(), pixelCache.set("img", img);
    if (pixelCache.has(key)) return pixelCache.get(key);
    const c = document.createElement("canvas"); c.width = c.height = size;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    pixelCache.set(key, d);
    return d;
  }
  function toTensor(img, size, mean, std) {
    const d = pixels(img, size), plane = size * size, out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) {
      const v = d[i * 4 + c] / 255;
      out[c * plane + i] = mean ? (v - mean[c]) / std[c] : v;
    }
    return new ort.Tensor("float32", out, [1, 3, size, size]);
  }
  function softmaxTop(scores, k, temp) {
    let max = -Infinity; for (const v of scores) if (v > max) max = v;
    const e = new Float32Array(scores.length); let sum = 0;
    for (let i = 0; i < scores.length; i++) { e[i] = Math.exp((scores[i] - max) / temp); sum += e[i]; }
    return Array.from(e.keys()).sort((a, b) => e[b] - e[a]).slice(0, k).map((i) => ({ i, p: e[i] / sum }));
  }
  async function runPlantNet(img) {
    const m = loaded.plantnet, t0 = performance.now();
    const { mean, std } = m.meta.preprocessing, [S] = m.meta.preprocessing.resize;
    const out = await m.session.run({ [m.meta.input.name]: toTensor(img, S, mean, std) });
    const top = softmaxTop(out[m.meta.output.name].data, 10, TEMP_PLANTNET);
    return {
      id: "plantnet", ms: performance.now() - t0,
      top: top.map(({ i, p }) => ({ sci: binomial(m.labels[i].species), family: m.labels[i].family, p })),
    };
  }
  async function runGlobal(img) {
    const m = loaded.global, t0 = performance.now();
    const out = await m.session.run({ [m.inputName]: toTensor(img, 224) });
    const emb = out[m.session.outputNames[0]].data, { rows, cols, data } = m.table;
    const cos = new Float32Array(rows);
    for (let r = 0; r < rows; r++) { let s = 0, o = r * cols; for (let c = 0; c < cols; c++) s += data[o + c] * emb[c]; cos[r] = s; }
    const top = softmaxTop(cos, 10, 1 / GLOBAL_SCALE);
    return { id: "global", ms: performance.now() - t0, top: top.map(({ i, p }) => ({ sci: binomial(m.labels[i].scientific), family: "", p })) };
  }

  /* ---------- fusion ---------- */
  function fuse(runs) {
    const famMap = {};
    runs.forEach((r) => r.top.forEach((t) => { if (t.family) famMap[t.sci] = t.family; }));
    if (loaded.plantnet && !fuse.famIndex) {
      fuse.famIndex = {};
      for (const l of loaded.plantnet.labels) fuse.famIndex[binomial(l.species)] = l.family;
    }
    const map = new Map();
    for (const r of runs) {
      r.top.forEach((t, rank) => {
        const e = map.get(t.sci) || { sci: t.sci, family: famMap[t.sci] || fuse.famIndex?.[t.sci] || "", score: 0, votes: {}, ranks: {} };
        e.votes[r.id] = t.p; e.ranks[r.id] = rank + 1;
        map.set(t.sci, e);
      });
    }
    // Equal-weight mean of the models' probabilities; when both models rank a species in their top 3,
    // combine as independent evidence (noisy-OR) so agreement raises confidence.
    // The worldwide model gets a slightly higher weight: the Europe specialist is over-confident outside its region.
    const W = { plantnet: 0.4, global: 0.6 }, n = runs.length;
    for (const e of map.values()) {
      e.agree = Object.values(e.ranks).filter((r) => r <= 3).length;
      const ps = runs.map((r) => e.votes[r.id] || 0);
      e.score = n === 2 && e.agree === 2 ? 1 - ps.reduce((a, p) => a * (1 - p), 1)
        : n === 2 ? runs.reduce((a, r) => a + W[r.id] * (e.votes[r.id] || 0), 0) : ps[0];
    }
    return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /** mode: "auto" (both models) | "plantnet" | "global" */
  async function identify(img, mode = "auto") {
    const ids = mode === "auto" ? ["plantnet", "global"] : [mode];
    await Promise.all(ids.map((id) => load(id)));
    await new Promise((r) => setTimeout(r, 40)); // let the UI paint before heavy compute
    const t0 = performance.now(), runs = [];
    for (const id of ids) runs.push(id === "plantnet" ? await runPlantNet(img) : await runGlobal(img));
    return {
      items: fuse(runs), runs, models: ids, totalMs: performance.now() - t0,
      consensus: runs.length === 2 && runs[0].top[0].sci === runs[1].top[0].sci,
    };
  }

  /* ---------- knowledge lookups (Wikipedia + GBIF, free, no key) ---------- */
  const infoCache = {};
  async function jget(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } }
  async function lookup(sci) {
    if (infoCache[sci]) return infoCache[sci];
    const wiki = (t) => jget("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(t.replace(/ /g, "_")) + "?redirect=true");
    const [w1, gb] = await Promise.all([wiki(sci), jget("https://api.gbif.org/v1/species/match?kingdom=Plantae&name=" + encodeURIComponent(sci))]);
    let w = w1 && w1.type !== "disambiguation" ? w1 : null;
    if (!w) { const g = await wiki(sci.split(" ")[0]); w = g && g.type !== "disambiguation" ? g : null; }
    let common = [];
    if (gb && gb.usageKey) {
      const v = await jget(`https://api.gbif.org/v1/species/${gb.usageKey}/vernacularNames?limit=200`);
      // GBIF vernacular lists contain junk; rank names by how many sources agree and whether Wikipedia uses them.
      const text = ((w && (w.extract + " " + w.description)) || "").toLowerCase(), tally = new Map();
      for (const x of v?.results || []) {
        if (x.language !== "eng") continue;
        const n = x.vernacularName.trim(), k = n.toLowerCase();
        if (!/^[a-z][a-z' -]{1,40}$/i.test(n)) continue;
        tally.set(k, { n, c: (tally.get(k)?.c || 0) + 1 });
      }
      common = [...tally.entries()]
        .map(([k, { n, c }]) => ({ n, s: c + (text.includes(k) ? 6 : 0) }))
        .sort((a, b) => b.s - a.s || a.n.length - b.n.length).slice(0, 5)
        .map(({ n }) => n.replace(/\b[a-z]/g, (m) => m.toUpperCase()));
    }
    const info = {
      wiki: w && { title: w.title, desc: w.description || "", extract: w.extract || "", img: w.thumbnail?.source ? w.thumbnail.source.replace(/\/\d+px-/, "/960px-") : "", thumb: w.thumbnail?.source || "", url: w.content_urls?.desktop?.page || "" },
      tax: gb && gb.matchType !== "NONE" ? { kingdom: gb.kingdom, phylum: gb.phylum, class: gb.class, order: gb.order, family: gb.family, genus: gb.genus, species: gb.species, status: gb.status, key: gb.usageKey, name: gb.scientificName } : null,
      common,
    };
    infoCache[sci] = info;
    return info;
  }

  /** Leaf disease diagnosis (PlantVillage MobileNetV2). Resize shortest edge to 256, centre-crop 224, normalise (x-0.5)/0.5. */
  async function diagnose(img) {
    await load("disease");
    await new Promise((r) => setTimeout(r, 40));
    const t0 = performance.now(), m = loaded.disease, S = 224;
    const c = document.createElement("canvas"); c.width = c.height = S;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    const side = Math.min(img.naturalWidth, img.naturalHeight) * (S / 256); // source px covered by the 224 centre crop
    const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data, plane = S * S, out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let ch = 0; ch < 3; ch++) out[ch * plane + i] = (d[i * 4 + ch] / 255 - 0.5) / 0.5;
    const res = await m.session.run({ [m.inputName]: new ort.Tensor("float32", out, [1, 3, S, S]) });
    const top = softmaxTop(res[m.outputName].data, 5, 1);
    return { ms: performance.now() - t0, items: top.map(({ i, p }) => ({ id: i, p })) };
  }

  /** Debug helper: raw logits / cosines for calibration experiments. */
  async function raw(img) {
    await Promise.all(["plantnet", "global"].map((id) => load(id)));
    const a = loaded.plantnet, g = loaded.global, { mean, std } = a.meta.preprocessing;
    const lo = (await a.session.run({ [a.meta.input.name]: toTensor(img, 512, mean, std) }))[a.meta.output.name].data;
    const emb = (await g.session.run({ [g.inputName]: toTensor(img, 224) }))[g.session.outputNames[0]].data;
    const { rows, cols, data } = g.table, cos = new Float32Array(rows);
    for (let r = 0; r < rows; r++) { let s = 0; for (let c = 0; c < cols; c++) s += data[r * cols + c] * emb[c]; cos[r] = s; }
    return { lo, cos };
  }

  return { SPEC, load, identify, diagnose, lookup, raw, pctFor, binomial, isLoaded: (id) => !!loaded[id], precision: () => loaded.global?.precision };
})();
