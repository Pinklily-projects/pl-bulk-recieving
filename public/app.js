/* Pink Lily Receiving — scan PO → SKU → Qty, save locally, bulk upload to ShipHero.
 *
 * Upload safety: ShipHero's purchase_order_update ADDS quantity_received on every call.
 * So each upload is a "batch" with a before-snapshot of quantity_received. If the result
 * of a call is unknown (dropped connection, server error), the batch is locked and we
 * re-read the PO before ever sending it again:
 *   all lines == before + qty  → it went through, mark done
 *   all lines == before        → it did not go through, safe to resend
 *   anything else              → flag for manual review in ShipHero (never auto-resend)
 */
(function () {
  "use strict";

  const STORE_KEY = "plr.v1";
  const API = "/api/shiphero";
  const MAX_QTY = 9999;
  const HISTORY_DAYS = 30;

  // ---------------------------------------------------------------- storage
  const blank = () => ({ pos: {}, scans: [], batches: [], settings: { pin: "", receiver: "", sound: true } });
  let S = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return blank();
      const s = Object.assign(blank(), JSON.parse(raw));
      s.settings = Object.assign(blank().settings, s.settings || {});
      return s;
    } catch (e) { return blank(); }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { say("err", "Could not save on this device (storage full or blocked). Upload now."); }
  }
  function prune() {
    const cutoff = Date.now() - HISTORY_DAYS * 864e5;
    S.batches = S.batches.filter((b) => b.state !== "done" || b.ts > cutoff);
    const live = new Set(S.scans.map((x) => x.po).concat(S.batches.filter((b) => b.state !== "done").map((b) => b.po)));
    for (const k of Object.keys(S.pos)) if (!live.has(k) && S.pos[k].fetchedAt < cutoff) delete S.pos[k];
  }

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const norm = (v) => String(v || "").trim().toUpperCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  let audioCtx = null;
  function beep(kind) {
    if (!S.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === "ok" ? [880] : kind === "save" ? [880, 1320] : [220, 180];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = kind === "err" ? "square" : "sine"; o.frequency.value = f;
        g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
        const t = audioCtx.currentTime + i * 0.11;
        o.start(t); o.stop(t + (kind === "err" ? 0.22 : 0.09));
      });
    } catch (e) {}
    if (kind === "err" && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }

  function say(kind, text) {
    const m = $("msg");
    m.className = "msg" + (kind ? " " + kind : "");
    m.textContent = text;
  }

  class ApiError extends Error {
    constructor(msg, status, network) { super(msg); this.status = status; this.network = !!network; }
  }
  async function api(action, payload) {
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-pin": S.settings.pin || "" },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      });
    } catch (e) {
      throw new ApiError("No connection to the server.", 0, true);
    }
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (res.status === 401) { openSettings("Enter the app PIN to connect."); throw new ApiError("App PIN needed.", 401); }
    if (!res.ok) throw new ApiError((body && body.error) || `Server error (HTTP ${res.status}).`, res.status);
    return body;
  }

  // ---------------------------------------------------------------- PO data
  function lineFor(po, code) {
    const c = norm(code);
    if (!po || !c) return null;
    return po.lines.find((l) => norm(l.sku) === c)
      || po.lines.find((l) => l.barcode && norm(l.barcode) === c)
      || po.lines.find((l) => l.vendor_sku && norm(l.vendor_sku) === c)
      || null;
  }
  // ---- split labels: base SKU barcode + separate size barcode
  const compact = (v) => norm(v).replace(/[\s\-_.\/]/g, "");
  const SIZE_ALIASES = {
    XXSMALL: "XXS", "2XS": "XXS", XSMALL: "XS", EXTRASMALL: "XS", XSM: "XS",
    SMALL: "S", SM: "S", SML: "S", MEDIUM: "M", MED: "M", MD: "M", LARGE: "L", LG: "L", LRG: "L",
    XLARGE: "XL", EXTRALARGE: "XL", XLG: "XL", XXL: "2XL", XXLARGE: "2XL", XXXL: "3XL",
    "1XL": "1X", ONESIZE: "OS", OSFA: "OS", ONE: "OS",
  };
  function canonSize(v) {
    let s = compact(v);
    if (/^\d+$/.test(s)) s = String(parseInt(s, 10)); // "08" → "8"
    return SIZE_ALIASES[s] || s;
  }
  // PO lines whose SKU starts with the scanned base (and is longer than it)
  function baseCandidates(po, code) {
    const b = compact(code);
    if (!po || b.length < 2) return [];
    return po.lines.filter((l) => { const c = compact(l.sku); return c.length > b.length && c.startsWith(b); });
  }
  const sizeOf = (line, base) => compact(line.sku).slice(compact(base).length);
  function resolveSize(base, cands, sizeRaw) {
    const want = canonSize(sizeRaw);
    if (!want) return [];
    let hits = cands.filter((l) => canonSize(sizeOf(l, base)) === want);
    if (!hits.length) hits = cands.filter((l) => l.option_title && canonSize(l.option_title) === want);
    if (!hits.length) hits = cands.filter((l) => { const t = String(l.name || "").split("—").pop(); return t && canonSize(t) === want; });
    return hits;
  }

  function pendingQty(poKey, sku) {
    const s = norm(sku);
    let n = 0;
    for (const x of S.scans) if (x.po === poKey && norm(x.sku) === s) n += x.qty;
    for (const b of S.batches) if (b.po === poKey && (b.state === "unknown" || b.state === "sending" || b.state === "review"))
      for (const l of b.lines) if (norm(l.sku) === s) n += l.qty;
    return n;
  }
  function applyPO(po) {
    const key = norm(po.po_number);
    S.pos[key] = Object.assign({}, po, { fetchedAt: Date.now() });
    return key;
  }

  // ---------------------------------------------------------------- scan flow
  const cur = { po: null, line: null, overConfirm: null, base: null, cands: null, step: "po" };

  function setStep(step) {
    cur.step = step;
    const order = ["po", "sku", "size", "qty"];
    const sizeUsed = !!cur.base;
    document.querySelectorAll(".steps li").forEach((li) => {
      const i = order.indexOf(li.dataset.step), j = order.indexOf(step);
      li.classList.toggle("active", i === j);
      li.classList.toggle("done", i < j && (li.dataset.step !== "size" || sizeUsed));
      li.classList.toggle("skipped", li.dataset.step === "size" && j > i && !sizeUsed);
    });
    $("in-sku").disabled = step === "po";
    $("in-size").disabled = step !== "size";
    $("size-wrap").hidden = !(step === "size" || (step === "qty" && sizeUsed));
    $("in-qty").disabled = step !== "qty";
    $("btn-save").disabled = step !== "qty";
    const target = { po: "in-po", sku: "in-sku", size: "in-size", qty: "in-qty" }[step];
    // focus synchronously: a scanner can send the next code within milliseconds
    $(target).focus(); $(target).select();
  }

  async function loadPO(raw) {
    const num = String(raw || "").trim();
    if (!num) return;
    const key = norm(num);
    say("", `Looking up PO ${num}…`);
    $("btn-po").disabled = true;
    try {
      const { po } = await api("getPO", { po_number: num });
      cur.po = applyPO(po); save();
      onPOReady(false);
    } catch (e) {
      if (e.network && S.pos[key]) {
        cur.po = key;
        onPOReady(true);
      } else {
        cur.po = null; beep("err");
        say("err", e.network ? `Offline and PO ${num} hasn't been loaded on this device before. Reconnect and rescan.` : e.message);
        $("po-card").hidden = true;
        setStep("po");
      }
    } finally { $("btn-po").disabled = false; }
  }

  function onPOReady(offline) {
    const po = S.pos[cur.po];
    const closed = /closed|cancel/i.test(po.status || "");
    beep(closed ? "err" : "ok");
    renderPOCard();
    if (closed) say("warn", `PO ${po.po_number} is ${po.status} in ShipHero. Scans will be saved but the upload may be rejected.`);
    else say(offline ? "warn" : "ok", offline ? `Offline — using saved copy of PO ${po.po_number}. Scan a SKU.` : `PO ${po.po_number} loaded. Scan a SKU.`);
    $("in-po").value = po.po_number;
    cur.line = null; cur.base = null; cur.cands = null; $("line-card").hidden = true; $("in-sku").value = ""; $("in-size").value = ""; $("in-qty").value = "";
    renderRecent();
    setStep("sku");
  }

  function renderPOCard() {
    const po = S.pos[cur.po];
    if (!po) { $("po-card").hidden = true; return; }
    const ordered = po.lines.reduce((a, l) => a + l.ordered, 0);
    const received = po.lines.reduce((a, l) => a + l.received, 0);
    $("po-card").innerHTML = `<b>PO ${esc(po.po_number)}</b>
      <div class="kv"><span>${esc(po.vendor || "Vendor —")}</span><span>${esc(po.warehouse || "")}</span>
      <span>Status: ${esc(po.status || "—")}</span><span>${po.lines.length} SKUs</span>
      <span>Received ${received} / ${ordered}</span></div>
      <button class="link" id="btn-change-po">Change PO</button>`;
    $("po-card").hidden = false;
    $("btn-change-po").onclick = () => { cur.po = null; cur.line = null; cur.base = null; cur.cands = null; $("in-po").value = ""; $("po-card").hidden = true; $("line-card").hidden = true; $("recent-wrap").hidden = true; say("", "Scan a PO number to start."); setStep("po"); };
  }

  function onSku(raw) {
    const code = String(raw || "").trim();
    if (!code) return;
    const po = S.pos[cur.po];
    if (!po) { setStep("po"); return; }
    cur.base = null; cur.cands = null; $("in-size").value = "";
    const line = lineFor(po, code);
    if (!line) {
      // Split label? base SKU here, size on its own barcode
      const cands = baseCandidates(po, code);
      if (cands.length) {
        cur.base = code; cur.cands = cands; cur.line = null;
        $("in-sku").value = norm(code);
        $("line-card").hidden = true;
        renderSizeOpts();
        beep("ok");
        say("ok", `Base SKU ${norm(code)} — now scan the size barcode.`);
        setStep("size");
        return;
      }
      beep("err");
      say("err", `${code} is not on PO ${po.po_number}. Set it aside and check with a lead.`);
      $("in-sku").select();
      return;
    }
    pickLine(line);
  }

  function pickLine(line) {
    cur.line = line; cur.overConfirm = null;
    if (!cur.base) $("in-sku").value = line.sku;
    renderLineCard();
    beep("ok");
    say("ok", `${line.sku} — scan or type the quantity.`);
    $("in-qty").value = "";
    setStep("qty");
  }

  function renderSizeOpts() {
    const base = cur.base;
    $("size-opts").innerHTML = (cur.cands || []).map((l, i) => {
      const left = l.ordered - l.received - pendingQty(cur.po, l.sku);
      return `<button type="button" data-cand="${i}" title="${esc(l.sku)}">${esc(sizeOf(l, base) || l.option_title || l.sku)}<small>${left > 0 ? left + " left" : "full"}</small></button>`;
    }).join("");
  }

  function onSize(raw) {
    const v = String(raw || "").trim();
    if (!v || !cur.cands) return;
    const po = S.pos[cur.po];
    // a full SKU scanned here still works
    const exact = lineFor(po, v);
    if (exact) { cur.base = null; cur.cands = null; $("in-sku").value = exact.sku; pickLine(exact); return; }
    const hits = resolveSize(cur.base, cur.cands, v);
    if (hits.length === 1) {
      $("in-size").value = canonSize(v);
      pickLine(hits[0]);
      return;
    }
    beep("err");
    const sizes = cur.cands.map((l) => sizeOf(l, cur.base) || l.option_title).join(", ");
    say("err", hits.length > 1
      ? `Size ${v} matches more than one SKU (${hits.map((h) => h.sku).join(", ")}). Tap the right size below.`
      : `Size "${v}" isn't on this PO for ${norm(cur.base)}. Sizes on PO: ${sizes}.`);
    $("in-size").select();
  }

  function renderLineCard(extra) {
    const po = S.pos[cur.po], l = cur.line;
    if (!l) { $("line-card").hidden = true; return; }
    const pend = pendingQty(cur.po, l.sku) + (extra || 0);
    const remaining = l.ordered - l.received - pend;
    $("line-card").innerHTML = `<b class="mono">${esc(l.sku)}</b><div>${esc(l.name || "")}</div>
      <div class="nums">
        <div><span>Ordered</span><strong>${l.ordered}</strong></div>
        <div><span>In ShipHero</span><strong>${l.received}</strong></div>
        <div><span>Scanned</span><strong>${pend}</strong></div>
        <div class="${remaining < 0 ? "over" : ""}"><span>${remaining < 0 ? "Over" : "Left"}</span><strong>${Math.abs(remaining)}</strong></div>
      </div>`;
    $("line-card").hidden = false;
  }

  function onQty(raw) {
    const v = String(raw || "").trim();
    const po = S.pos[cur.po], l = cur.line;
    if (!po || !l) { setStep("sku"); return; }
    if (!v) return;
    if (lineFor(po, v)) { beep("err"); say("err", `That's a SKU (${v}), not a quantity. Scan or type the quantity.`); $("in-qty").select(); return; }
    if (!/^\d+$/.test(v)) { beep("err"); say("err", `"${v}" isn't a quantity. Use whole numbers only.`); $("in-qty").select(); return; }
    const qty = parseInt(v, 10);
    if (qty < 1 || qty > MAX_QTY) { beep("err"); say("err", `Quantity must be 1–${MAX_QTY}. Got ${qty}.`); $("in-qty").select(); return; }

    const remaining = l.ordered - l.received - pendingQty(cur.po, l.sku);
    if (qty > remaining && cur.overConfirm !== qty) {
      cur.overConfirm = qty;
      beep("err");
      renderLineCard(qty);
      say("warn", `That's ${qty - Math.max(remaining, 0)} over the PO. Press Enter again to save anyway, or fix the qty.`);
      return;
    }
    S.scans.push({ id: uid(), po: cur.po, sku: l.sku, qty, ts: Date.now(), by: S.settings.receiver || "" });
    save();
    beep("save");
    say("ok", `Saved ${qty} × ${l.sku}. Scan the next SKU.`);
    cur.overConfirm = null;
    renderLineCard();
    renderRecent(); renderBadge();
    cur.base = null; cur.cands = null;
    $("in-qty").value = ""; $("in-sku").value = ""; $("in-size").value = "";
    setStep("sku");
  }

  function renderRecent() {
    const list = S.scans.filter((x) => x.po === cur.po).slice(-5).reverse();
    $("recent-wrap").hidden = !list.length;
    $("recent").innerHTML = list.map((x) => `<li><span class="mono">${esc(x.sku)}</span><span><b>${x.qty}</b> · ${fmtTime(x.ts)}</span></li>`).join("");
  }

  function undoLast() {
    for (let i = S.scans.length - 1; i >= 0; i--) {
      if (S.scans[i].po === cur.po) {
        const x = S.scans.splice(i, 1)[0];
        save(); renderRecent(); renderBadge();
        if (cur.line && norm(cur.line.sku) === norm(x.sku)) renderLineCard();
        say("warn", `Removed ${x.qty} × ${x.sku}.`);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- saved view
  function groupPending() {
    const groups = {};
    for (const x of S.scans) {
      const g = groups[x.po] || (groups[x.po] = { po: x.po, lines: {}, units: 0 });
      const k = norm(x.sku);
      const ln = g.lines[k] || (g.lines[k] = { sku: x.sku, qty: 0, scans: 0 });
      ln.qty += x.qty; ln.scans++; g.units += x.qty;
    }
    return groups;
  }

  function renderBadge() {
    const n = S.scans.length;
    $("saved-badge").hidden = !n;
    $("saved-badge").textContent = n;
    $("btn-upload").disabled = !n || uploading;
  }

  function renderSaved() {
    const groups = groupPending();
    const keys = Object.keys(groups);
    const alerts = S.batches.filter((b) => b.state === "unknown" || b.state === "review");
    $("batch-alerts").innerHTML = alerts.map((b) => `
      <div class="alert ${b.state === "review" ? "err" : "warn"}">
        <b>PO ${esc(b.po_number)} — ${b.state === "review" ? "needs a manual check" : "upload result unknown"}</b>
        <div>${esc(b.error || "")}</div>
        <div>${b.lines.map((l) => `${esc(l.sku)} × ${l.qty}`).join(", ")}</div>
        <div class="acts">
          ${b.state === "unknown" ? `<button class="btn sm primary" data-verify="${b.id}">Check ShipHero &amp; finish</button>` : ""}
          ${b.state === "review" ? `<button class="btn sm" data-resolve="${b.id}">I fixed it in ShipHero</button>` : ""}
        </div>
      </div>`).join("");

    if (!keys.length) {
      $("saved-list").innerHTML = `<div class="empty">No saved scans waiting to upload.</div>`;
    } else {
      $("saved-list").innerHTML = keys.map((k) => {
        const g = groups[k], po = S.pos[k] || { po_number: k, lines: [] };
        const rows = Object.values(g.lines).map((ln) => {
          const pl = lineFor(po, ln.sku) || { ordered: 0, received: 0, name: "" };
          const after = pl.received + pendingQty(k, ln.sku);
          const over = after - pl.ordered;
          return `<tr><td><span class="mono">${esc(ln.sku)}</span>${over > 0 ? `<span class="over-tag">+${over} over</span>` : ""}<div class="sub">${esc(pl.name || "")}</div></td>
            <td class="num"><b>${ln.qty}</b><div class="sub">${ln.scans} scan${ln.scans > 1 ? "s" : ""}</div></td>
            <td class="num">${pl.received} → ${after}<div class="sub">of ${pl.ordered}</div></td>
            <td class="num"><button class="link" data-del-sku="${esc(k)}|${esc(ln.sku)}" aria-label="Remove">✕</button></td></tr>`;
        }).join("");
        return `<div class="card po-block">
          <div class="card-head"><div><h3>PO ${esc(po.po_number)}</h3><div class="meta">${esc(po.vendor || "")} · ${Object.keys(g.lines).length} SKUs · ${g.units} units</div></div>
          <button class="btn sm danger" data-del-po="${esc(k)}">Remove PO</button></div>
          <table><thead><tr><th>SKU</th><th class="num">Qty</th><th class="num">Received</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        </div>`;
      }).join("");
    }
    renderBadge();
  }

  function onSavedClick(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.delSku) {
      const [po, sku] = t.dataset.delSku.split("|");
      S.scans = S.scans.filter((x) => !(x.po === po && norm(x.sku) === norm(sku)));
      save(); renderSaved();
    } else if (t.dataset.delPo) {
      const po = t.dataset.delPo;
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "Tap again to remove"; return; }
      S.scans = S.scans.filter((x) => x.po !== po);
      save(); renderSaved();
    } else if (t.dataset.verify) {
      runBatches([S.batches.find((b) => b.id === t.dataset.verify)]);
    } else if (t.dataset.resolve) {
      const b = S.batches.find((x) => x.id === t.dataset.resolve);
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "Confirm: fixed in ShipHero"; return; }
      b.state = "done"; b.error = "Marked fixed manually."; b.request_id = b.request_id || "manual";
      save(); renderSaved();
    }
  }

  // ---------------------------------------------------------------- upload
  let uploading = false;

  function openUpload() {
    const groups = groupPending();
    const keys = Object.keys(groups);
    if (!keys.length) return;
    const units = keys.reduce((a, k) => a + groups[k].units, 0);
    $("upload-summary").innerHTML = `<p><b>${keys.length}</b> PO${keys.length > 1 ? "s" : ""} · <b>${keys.reduce((a, k) => a + Object.keys(groups[k].lines).length, 0)}</b> lines · <b>${units}</b> units</p>
      <ul>${keys.map((k) => `<li>PO ${esc((S.pos[k] || {}).po_number || k)} — ${groups[k].units} units</li>`).join("")}</ul>`;
    $("dlg-upload").showModal();
  }

  async function startUpload() {
    $("dlg-upload").close();
    const groups = groupPending();
    const batches = [];
    for (const k of Object.keys(groups)) {
      const po = S.pos[k];
      const b = {
        id: uid(), po: k, po_id: po && po.id, po_number: (po && po.po_number) || k,
        lines: Object.values(groups[k].lines).map((l) => ({ sku: l.sku, qty: l.qty })),
        scans: S.scans.filter((x) => x.po === k),
        before: null, state: "queued", ts: Date.now(), by: S.settings.receiver || "",
      };
      S.scans = S.scans.filter((x) => x.po !== k);
      S.batches.push(b); batches.push(b);
    }
    save(); renderSaved();
    await runBatches(batches);
  }

  function releaseBatch(b, msg) {
    // definitely NOT applied in ShipHero → put scans back in the queue
    S.scans = S.scans.concat(b.scans || []);
    b.state = "failed"; b.error = msg; b.ts = Date.now();
  }

  async function runBatches(list) {
    if (uploading) return;
    uploading = true; renderBadge();
    const results = { done: 0, failed: 0, unknown: 0, review: 0 };
    try {
      for (const b of list) {
        if (!b) continue;
        say("", `Uploading PO ${b.po_number}…`);
        await runOne(b);
        results[b.state] = (results[b.state] || 0) + 1;
        save(); renderSaved();
      }
    } finally {
      uploading = false; renderSaved(); renderHistory();
    }
    const parts = [];
    if (results.done) parts.push(`${results.done} uploaded`);
    if (results.failed) parts.push(`${results.failed} failed (scans kept)`);
    if (results.unknown) parts.push(`${results.unknown} unconfirmed`);
    if (results.review) parts.push(`${results.review} need review`);
    const bad = results.failed || results.unknown || results.review;
    beep(bad ? "err" : "save");
    say(bad ? "warn" : "ok", `Upload finished: ${parts.join(", ") || "nothing to do"}.`);
    toast(bad ? "warn" : "ok", `Upload finished: ${parts.join(", ")}.`);
  }

  async function runOne(b) {
    // 1. Fresh read of the PO (also gives us the before-snapshot / verification data)
    let po;
    try {
      po = (await api("getPO", b.po_id ? { id: b.po_id } : { po_number: b.po_number })).po;
      applyPO(po);
      b.po_id = po.id;
    } catch (e) {
      if (b.state === "unknown") { b.error = `Couldn't check ShipHero: ${e.message}`; return; }
      return releaseBatch(b, `Couldn't read PO before upload: ${e.message}`);
    }

    // 2. A previous attempt with unknown result → verify instead of blindly resending
    if (b.state === "unknown" && b.before) {
      let applied = true, untouched = true;
      for (const l of b.lines) {
        const pl = lineFor(po, l.sku); const now = pl ? pl.received : -1;
        const was = b.before[norm(l.sku)];
        if (now !== was + l.qty) applied = false;
        if (now !== was) untouched = false;
      }
      if (applied) { b.state = "done"; b.error = "Confirmed in ShipHero after a dropped connection."; b.ts = Date.now(); return; }
      if (!untouched) { b.state = "review"; b.error = "Received quantities changed but don't match this upload. Check the PO in ShipHero, then mark it fixed."; return; }
      // untouched → fall through and send
    }

    // 3. Validate every SKU is on the PO
    const missing = b.lines.filter((l) => !lineFor(po, l.sku));
    if (missing.length) return releaseBatch(b, `Not on PO ${po.po_number}: ${missing.map((m) => m.sku).join(", ")}. Remove them and upload again.`);

    // canonicalize SKUs to ShipHero's spelling + snapshot
    b.before = {};
    b.lines = b.lines.map((l) => { const pl = lineFor(po, l.sku); b.before[norm(pl.sku)] = pl.received; return { sku: pl.sku, qty: l.qty }; });
    b.state = "sending"; save();

    // 4. Send
    try {
      const r = await api("receive", { po_id: b.po_id, line_items: b.lines.map((l) => ({ sku: l.sku, quantity_received: l.qty })) });
      b.state = "done"; b.request_id = r.request_id; b.ts = Date.now(); b.error = "";
      // reflect locally so the line cards are right without a reload
      for (const l of b.lines) { const pl = lineFor(S.pos[b.po], l.sku); if (pl) pl.received += l.qty; }
    } catch (e) {
      if (e.status === 400 || e.status === 401 || e.status === 404) return releaseBatch(b, e.message); // rejected before ShipHero
      b.state = "unknown"; b.error = e.message;
    }
  }

  // ---------------------------------------------------------------- history
  function renderHistory() {
    const list = S.batches.filter((b) => b.state !== "queued").slice().reverse();
    $("history-list").innerHTML = list.length ? list.map((b) => `
      <div class="card hist">
        <div class="top"><b>PO ${esc(b.po_number)}</b><span class="pill ${b.state}">${{ done: "Uploaded", failed: "Not sent", unknown: "Unconfirmed", review: "Needs review", sending: "Sending" }[b.state] || b.state}</span></div>
        <div class="hint">${fmtTime(b.ts)}${b.by ? " · " + esc(b.by) : ""}${b.request_id ? " · req " + esc(b.request_id) : ""}</div>
        <div>${b.lines.map((l) => `<span class="mono">${esc(l.sku)}</span> × ${l.qty}`).join(" · ")}</div>
        ${b.error ? `<div class="hint">${esc(b.error)}</div>` : ""}
      </div>`).join("") : `<div class="empty">No uploads yet.</div>`;
  }

  // ---------------------------------------------------------------- CSV export
  function exportCSV() {
    const rows = [["status", "po_number", "sku", "qty", "scanned_at", "receiver", "request_id"]];
    for (const x of S.scans) rows.push(["pending", (S.pos[x.po] || {}).po_number || x.po, x.sku, x.qty, new Date(x.ts).toISOString(), x.by || "", ""]);
    for (const b of S.batches) for (const l of b.lines) rows.push([b.state, b.po_number, l.sku, l.qty, new Date(b.ts).toISOString(), b.by || "", b.request_id || ""]);
    const csv = rows.map((r) => r.map((c) => { const s = String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `receiving-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------- settings / misc UI
  function openSettings(note) {
    $("in-pin").value = S.settings.pin || "";
    $("in-receiver").value = S.settings.receiver || "";
    $("in-sound").checked = S.settings.sound !== false;
    if (note) say("warn", note);
    if (!$("dlg-settings").open) $("dlg-settings").showModal();
  }
  function saveSettings() {
    S.settings.pin = $("in-pin").value.trim();
    S.settings.receiver = $("in-receiver").value.trim().toUpperCase();
    S.settings.sound = $("in-sound").checked;
    save(); $("dlg-settings").close();
    ping();
  }

  function toast(kind, text) { if (activeTab !== "scan") say(kind, text); }

  let activeTab = "scan";
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    ["scan", "saved", "history"].forEach((v) => { $("view-" + v).hidden = v !== name; });
    if (name === "saved") renderSaved();
    if (name === "history") renderHistory();
    if (name === "scan") setStep(cur.po ? cur.step === "po" ? "sku" : cur.step : "po");
  }

  function setNet() { $("net").classList.toggle("off", !navigator.onLine); $("net").title = navigator.onLine ? "Online" : "Offline — scans still save"; }
  async function ping() { try { await api("ping"); } catch (e) {} }

  function onEnter(el, fn) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") { if (e.key === "Tab" && !el.value) return; e.preventDefault(); fn(el.value); }
    });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    prune(); save();
    onEnter($("in-po"), loadPO);
    onEnter($("in-sku"), onSku);
    onEnter($("in-size"), onSize);
    onEnter($("in-qty"), onQty);
    $("size-opts").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-cand]");
      if (b && cur.cands) pickLine(cur.cands[+b.dataset.cand]);
    });
    $("btn-po").onclick = () => loadPO($("in-po").value);
    $("btn-save").onclick = () => onQty($("in-qty").value);
    $("btn-undo").onclick = undoLast;
    $("in-sku").addEventListener("input", () => { if (cur.step !== "sku") { cur.line = null; cur.base = null; cur.cands = null; setStep("sku"); } });
    $("saved-list").addEventListener("click", onSavedClick);
    $("batch-alerts").addEventListener("click", onSavedClick);
    $("btn-upload").onclick = openUpload;
    $("dlg-upload-go").onclick = startUpload;
    $("dlg-upload-cancel").onclick = () => $("dlg-upload").close();
    $("btn-export").onclick = exportCSV;
    $("btn-settings").onclick = () => openSettings();
    $("dlg-settings-save").onclick = saveSettings;
    $("dlg-settings-cancel").onclick = () => $("dlg-settings").close();
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
    window.addEventListener("online", setNet); window.addEventListener("offline", setNet);
    // tap anywhere empty on scan view → refocus the active field (scanner guns need focus)
    $("view-scan").addEventListener("click", (e) => {
      if (e.target.closest("input,button,a")) return;
      const f = ["in-qty", "in-size", "in-sku", "in-po"].map($).find((x) => !x.disabled);
      f && f.focus();
    });
    // any batch left mid-send from a crash/reload is unknown → must be verified
    let stuck = 0;
    S.batches.forEach((b) => { if (b.state === "sending" || b.state === "queued") { b.state = "unknown"; b.error = "App closed during upload."; stuck++; } });
    if (stuck) save();
    setNet(); renderBadge(); setStep("po");
    if (S.batches.some((b) => b.state === "unknown" || b.state === "review")) say("warn", "An earlier upload needs checking — open the Saved tab.");
    ping();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
