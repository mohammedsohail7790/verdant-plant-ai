# Plantifi.ai · AI Plant Identification & Leaf Disease Detection

**Built by Abdul Basit Khan** · B.Tech final-year project. A SaaS-style web app that **identifies plants worldwide** and **detects crop leaf diseases**
(with treatment advice) using neural networks that run **privately in the browser**. Free, no account, no API key.

## Run
Double-click **`start.bat`** (tiny built-in server, no Python/Node needed). It opens http://localhost:8080.
First launch downloads the models once (~112 MB total) and caches them in IndexedDB; afterwards identification works offline.

## Use it with a real phone camera
1. Run `start.bat` on your PC and connect the phone to the **same Wi-Fi**.
2. Open the app on the PC, go to **Dashboard**, and scan the **QR code** (or type the `http://192.168.x.x:8080` address the window prints).
3. Allow "powershell" through Windows Firewall the first time it asks (needed so the phone can reach the PC).
4. In **Identify** or **Diagnose**, tap **Camera**: your phone's native camera opens (full resolution, autofocus), then the photo is analysed on the phone itself.

Why native camera: phones only allow a live in-page camera on HTTPS, and a LAN address is plain HTTP. The app detects touch devices / non-secure
pages and uses `<input capture>` instead; desktop on localhost keeps the live viewfinder. For a permanent link with live camera and PWA-style
caching, upload the folder to any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages).

## UX highlights
- Command palette (**Ctrl/Cmd + K**, or **/**) to jump anywhere, run samples, toggle theme, export
- Live analysis stepper that shows the real pipeline stages while the models run
- Drop a photo anywhere in the app; paste with Ctrl+V; one-click sample deep links (`#/app/identify?s=0`)
- First-run welcome, dashboard with sparkline, leaf-health donut and top plants, thumbnails on top matches
- Light and dark themes, fully responsive with a mobile bottom navigation

## Product
- **Landing page** + **app shell** (sidebar, dashboard, light/dark theme, mobile bottom-nav)
- **Dashboard:** scan statistics, 7-day activity chart, recent scans, engine status
- **Identify plant:** dual-AI consensus, confidence ring, taxonomy (GBIF), common names, Wikipedia reference photo, top-5 matches, AI-details tab
- **Diagnose leaf:** 38 classes / 14 crops, severity rating, symptoms, step-by-step treatment and prevention, healthy-leaf guidance, "other possibilities"
- **Library:** every scan saved on-device, filter / search / delete / restore, CSV export
- Upload, drag-drop, paste, live camera, bundled sample photos, Export-to-PDF, copy/share

## Models (all open, run via ONNX Runtime Web / WebAssembly)
| Task | Model | Classes | Size |
|---|---|---|---|
| Species (Europe specialist) | Pl@ntNet MobileNetV4-Hybrid-M | 7,806 | 79 MB |
| Species (worldwide) | BioCLIP-2.5 Mobile (FastViT student) | 4,271 | 24 MB |
| Leaf disease | MobileNetV2 on PlantVillage | 38 (14 crops) | 9 MB |

Species fusion (`engine.js`): calibrated probabilities, weighted mean (0.4 Pl@ntNet / 0.6 BioCLIP); species both models rank in
their top 3 are combined as independent evidence (noisy-OR). Disease inference: resize 256 → centre-crop 224 → normalise (x-0.5)/0.5.

Verified in-browser: 6/6 bundled leaf samples and 6/6 bundled plant samples classified correctly; on a wider 14-image
PlantVillage check 13/14 were correct (a corn gray-leaf-spot image was confused with northern leaf blight).

## Files
`index.html` landing + app shell · `style.css` design system · `app.js` router, dashboard, workspaces, library · `engine.js` models,
fusion, GBIF/Wikipedia lookups · `knowledge.js` disease knowledge base · `samples/` demo photos · `start.ps1/.bat` local server

## Honest limits
- Disease model was trained on clean PlantVillage lab photos; field photos with clutter can be less accurate. It only knows 14 crops.
- Species absent from both species models cannot be recognised (low confidence is shown).
- Treatment text is general guidance, not a lab diagnosis. Always follow local regulations and consult an agricultural extension service.
- AI can be wrong. Never eat or use a plant medicinally based on a result alone.

## Credits
Pl@ntNet (Apache-2.0) · BioCLIP-2.5 Mobile by N. Hamilton (MIT) · MobileNetV2 plant-disease by linkanjarad (ONNX by onnx-community) ·
PlantVillage dataset (sample leaves) · Wikimedia Commons (sample plant photos) · GBIF · Wikipedia.

---
Designed and built by **Abdul Basit Khan**.
