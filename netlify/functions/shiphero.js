// Pink Lily Receiving — ShipHero proxy (Netlify Function)
//
// The browser never sees a ShipHero token. This function holds the refresh
// token (env SHIPHERO_REFRESH_TOKEN), mints short-lived access tokens, and
// exposes ONLY two actions:
//   getPO    — read a purchase order + its line items by PO number
//   receive  — add quantity_received to PO lines (purchase_order_update)
//
// Env vars (Netlify → Site settings → Environment variables):
//   SHIPHERO_REFRESH_TOKEN  required
//   APP_PIN                 strongly recommended; receivers enter it once per device
//   SHIPHERO_API_URL        optional override (used for testing)
//   SHIPHERO_REFRESH_URL    optional override (used for testing)

const API_URL = process.env.SHIPHERO_API_URL || "https://public-api.shiphero.com/graphql";
const REFRESH_URL = process.env.SHIPHERO_REFRESH_URL || "https://public-api.shiphero.com/auth/refresh";
const MAX_QTY_PER_LINE = 100000;
const MAX_LINES_PER_CALL = 500;

let cachedToken = null; // { token, expiresAt }

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

async function getAccessToken(force = false) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const refresh = process.env.SHIPHERO_REFRESH_TOKEN;
  if (!refresh) throw new Error("Server is missing SHIPHERO_REFRESH_TOKEN.");
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`ShipHero token refresh failed (HTTP ${res.status}).`);
  }
  const ttl = Number(body.expires_in) || 3600;
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (ttl - 300) * 1000 };
  return cachedToken.token;
}

async function gql(query, variables, retried = false) {
  const token = await getAccessToken();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && !retried) {
    cachedToken = null;
    return gql(query, variables, true);
  }
  if (res.status === 429) throw new Error("ShipHero rate limit hit. Wait a minute and try again.");
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`ShipHero returned HTTP ${res.status} with no JSON.`);
  if (body.errors && body.errors.length) {
    const e = body.errors[0];
    const code = e.code != null ? ` (code ${e.code})` : "";
    const wait = e.time_remaining ? ` Retry in ${e.time_remaining}.` : "";
    const rid = e.request_id ? ` request_id ${e.request_id}` : "";
    throw new Error(`${e.message || "ShipHero error"}${code}.${wait}${rid}`.trim());
  }
  return body.data;
}

const LINE_FIELDS = `
  pageInfo { hasNextPage endCursor }
  edges { node { sku quantity quantity_received quantity_rejected product_name option_title barcode vendor_sku fulfillment_status } }`;

const PO_QUERY = `
query GetPO($po: String, $id: String, $after: String) {
  purchase_order(po_number: $po, id: $id) {
    request_id complexity
    data {
      id po_number fulfillment_status po_date warehouse_id
      vendor { name }
      warehouse { identifier }
      line_items(first: 250, after: $after) { ${LINE_FIELDS} }
    }
  }
}`;

async function fetchPO({ po_number, id }) {
  let after = null;
  let po = null;
  const lines = [];
  for (let page = 0; page < 40; page++) {
    const data = await gql(PO_QUERY, { po: id ? null : po_number, id: id || null, after });
    const d = data && data.purchase_order && data.purchase_order.data;
    if (!d) return null;
    if (!po) po = d;
    for (const e of d.line_items.edges) lines.push(e.node);
    if (!d.line_items.pageInfo.hasNextPage) break;
    after = d.line_items.pageInfo.endCursor;
    id = d.id;
  }
  return {
    id: po.id,
    po_number: po.po_number,
    status: po.fulfillment_status,
    po_date: po.po_date,
    vendor: po.vendor && po.vendor.name,
    warehouse: po.warehouse && po.warehouse.identifier,
    lines: lines.map((l) => ({
      sku: l.sku,
      name: [l.product_name, l.option_title].filter(Boolean).join(" — "),
      option_title: l.option_title || "",
      ordered: l.quantity || 0,
      received: l.quantity_received || 0,
      rejected: l.quantity_rejected || 0,
      barcode: l.barcode || "",
      vendor_sku: l.vendor_sku || "",
    })),
  };
}

const RECEIVE_MUTATION = `
mutation Receive($data: UpdatePurchaseOrderInput!) {
  purchase_order_update(data: $data) {
    request_id complexity
    purchase_order { id po_number }
  }
}`;

function cleanStr(v, max = 120) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const pin = process.env.APP_PIN;
  if (pin && (event.headers["x-app-pin"] || "") !== pin) {
    return json(401, { error: "Wrong or missing app PIN." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Bad JSON" });
  }

  try {
    if (body.action === "ping") {
      return json(200, { ok: true });
    }

    if (body.action === "getPO") {
      const po_number = cleanStr(body.po_number);
      const id = cleanStr(body.id);
      if (!po_number && !id) return json(400, { error: "PO number required." });
      const po = await fetchPO({ po_number, id });
      if (!po) return json(404, { error: `PO ${po_number || id} not found in ShipHero.` });
      return json(200, { po });
    }

    if (body.action === "receive") {
      const po_id = cleanStr(body.po_id);
      if (!po_id) return json(400, { error: "po_id required." });
      const raw = Array.isArray(body.line_items) ? body.line_items : [];
      if (!raw.length) return json(400, { error: "No lines to receive." });
      if (raw.length > MAX_LINES_PER_CALL) return json(400, { error: "Too many lines in one call." });
      const line_items = [];
      for (const l of raw) {
        const sku = cleanStr(l.sku);
        const q = Number(l.quantity_received);
        if (!sku || !Number.isInteger(q) || q < 1 || q > MAX_QTY_PER_LINE) {
          return json(400, { error: `Invalid line: ${JSON.stringify(l).slice(0, 100)}` });
        }
        line_items.push({ sku, quantity_received: q });
      }
      // quantity_received is ADDITIVE in ShipHero — each call adds to the existing total.
      const data = await gql(RECEIVE_MUTATION, { data: { po_id, line_items } });
      const out = data && data.purchase_order_update;
      if (!out) throw new Error("ShipHero returned no result for purchase_order_update.");
      return json(200, { ok: true, request_id: out.request_id });
    }

    return json(400, { error: "Unknown action." });
  } catch (err) {
    return json(502, { error: err.message || String(err) });
  }
};
