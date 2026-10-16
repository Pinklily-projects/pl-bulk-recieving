# PL Bulk Receiving

Receive purchase orders by scanning the **SKU printed on the vendor label** (which ShipHero's own receiving screen can't read), then push everything to ShipHero in one upload.

**Flow:** scan PO → scan SKU → *(size, if it's a separate barcode)* → scan or type qty → repeat → **Saved** tab → **Upload all to ShipHero**.

### Split labels (SKU without size + separate size barcode)

Some vendor labels print the SKU without its size and put the size on a separate barcode. The app handles both label types automatically:

- **Full SKU scanned** (e.g. `PL200-S`): the app goes straight to Qty.
- **Base SKU scanned** (e.g. `PL200`): if it matches the start of one or more SKUs on the PO, a **Size** step appears with buttons for the sizes on that PO. Scan the size barcode, or tap a button.

Size matching ignores dashes, spaces and leading zeros, and understands common spellings: `Small`/`SM` → `S`, `Medium` → `M`, `XXL` → `2XL`, `1XL` → `1X`, `One Size` → `OS`, `08` → `8`. If the size isn't on the PO, the app beeps an error and lists the sizes that are. Scanning a full SKU in the Size field also works.

## What it does in ShipHero

The upload calls `purchase_order_update` and **adds** the scanned quantities to *Quantity received* on each PO line. It does **not** add inventory (`inventory_add`) and doesn't close the PO.

## Safeguards

- **The PO must exist.** It's looked up live in ShipHero, so a bad PO number is rejected.
- **The SKU must be on that PO.** SKUs are matched case-insensitively against the line's SKU, then its barcode, then its vendor SKU. A SKU that isn't on the PO gets an error beep and isn't saved.
- **The quantity is checked.** It must be a whole number from 1 to 9999. If a SKU is scanned into the Qty field by mistake, the app catches it.
- **Over-receiving needs a second Enter** to confirm.
- **Scans are saved on the device** (localStorage), so they survive a refresh, a dropped connection, or a closed browser.
- **No double-posting.** ShipHero's `quantity_received` adds to the existing total on every call. So before each upload the app records the PO's current received quantities. If an upload's result is unknown (dropped connection, server error, app closed mid-upload), the app never resends blindly. It re-reads the PO first:
  - The numbers equal the snapshot plus the upload: the upload went through, so the app marks it done.
  - The numbers are unchanged: the upload didn't go through, so the app sends it.
  - Anything else: the app flags the PO for a manual check in ShipHero.
- **The ShipHero token never reaches the browser.** A Netlify Function holds the refresh token and only allows two actions: read a PO, and update quantity received.
- **An optional app PIN** keeps random visitors out.

## Deploy (Netlify)

1. Connect this repo to a new Netlify site. No build command is needed: `publish = public`, `functions = netlify/functions`.
2. Under **Site settings → Environment variables**, set:
   - `SHIPHERO_REFRESH_TOKEN`: a refresh token from ShipHero → *My Account → Developer → API*. You can use the same kind of token as the Reserve Manager. The account needs purchase-order edit rights.
   - `APP_PIN`: any PIN. Receivers enter it once per device under ⚙ Settings.
3. Deploy, open the site on the receiving device, and enter the PIN.

## Scanners

Any keyboard-wedge scanner that sends **Enter** (or Tab) after each scan works. Focus moves automatically: PO → SKU → (Size) → Qty → back to SKU. Tapping an empty spot on the Scan screen puts focus back in the active field.

## Files

```
public/index.html, app.js, app.css   front end
public/fx.css, fx.js                 Pink Lily brand motion (Calm-mode toggle ✨)
netlify/functions/shiphero.js        ShipHero proxy (getPO, receive)
netlify.toml                         routes /api/shiphero → function
```
