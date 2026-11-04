/**********************************************************************
 *  MILK ATM  —  M-Pesa STK Push middleware
 *  ------------------------------------------------------------------
 *  Sits between your machines and Safaricom Daraja.
 *
 *    ESP32  --HTTPS-->  this server  --HTTPS-->  Daraja
 *                            ^                      |
 *                            +----- callback -------+
 *
 *  Why a server at all?
 *    - Daraja needs a PUBLIC https callback URL to deliver the result
 *    - Your consumer key / secret / passkey must never sit inside a
 *      device that a customer can physically open
 *    - The machine only ever speaks a tiny, dumb API it can parse
 *
 *  Run:   npm install && npm start
 **********************************************************************/

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ----------------------------- CONFIG ----------------------------- */
const {
  MPESA_ENV        = 'sandbox',        // 'sandbox' | 'production'
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,                            // paybill, or HO/store no. for till
  PARTY_B,                              // till number; blank = same as SHORTCODE
  PASSKEY,
  TRANSACTION_TYPE = 'CustomerPayBillOnline',  // or CustomerBuyGoodsOnline
  PUBLIC_BASE_URL,                      // https://mpesa.yourdomain.co.ke
  CALLBACK_TOKEN,                       // random string in the callback path
  DEVICE_KEYS      = '',                // "atm001:key1,atm002:key2"
  PORT             = 3000,
} = process.env;

const BASE = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const PARTYB = PARTY_B && PARTY_B.length ? PARTY_B : SHORTCODE;

const devices = new Map();
DEVICE_KEYS.split(',').filter(Boolean).forEach((pair) => {
  const [id, key] = pair.split(':');
  if (id && key) devices.set(key.trim(), id.trim());
});

for (const v of ['CONSUMER_KEY', 'CONSUMER_SECRET', 'SHORTCODE', 'PASSKEY',
                 'PUBLIC_BASE_URL', 'CALLBACK_TOKEN']) {
  if (!process.env[v]) { console.error(`FATAL: ${v} missing in .env`); process.exit(1); }
}

/* --------------------------- TRANSACTIONS -------------------------- */
/*  In memory. Fine for one or two machines; swap for SQLite if you
    ever need the history to survive a restart.                       */
const txns = new Map();          // shortId -> record
const byCheckout = new Map();    // CheckoutRequestID -> shortId

const shortId = () => crypto.randomBytes(4).toString('hex').toUpperCase();

/* ------------------------------ DARAJA ----------------------------- */
let tokenCache = { value: null, expires: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;

  const basic = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!r.ok) throw new Error(`OAuth failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth returned no token');

  /* Daraja tokens live 1 hour; refresh at 50 min. */
  tokenCache = { value: j.access_token, expires: Date.now() + 50 * 60 * 1000 };
  return tokenCache.value;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function password(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
}

/* 0712345678 / +254712345678 / 712345678  ->  254712345678 */
function normalisePhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('254')) return d;
  if (d.length === 10 && d.startsWith('0'))   return `254${d.slice(1)}`;
  if (d.length === 9  && d.startsWith('7'))   return `254${d}`;
  if (d.length === 9  && d.startsWith('1'))   return `254${d}`;
  return null;
}

async function stkPush({ phone, amount, reference, txnId }) {
  const token = await getToken();
  const ts = stamp();

  const body = {
    BusinessShortCode: SHORTCODE,
    Password:          password(ts),
    Timestamp:         ts,
    TransactionType:   TRANSACTION_TYPE,
    Amount:            Math.round(amount),      // whole shillings only
    PartyA:            phone,
    PartyB:            PARTYB,
    PhoneNumber:       phone,
    CallBackURL:       `${PUBLIC_BASE_URL}/api/callback/${CALLBACK_TOKEN}`,
    AccountReference:  String(reference).slice(0, 12),
    TransactionDesc:   `Milk ${txnId}`.slice(0, 13),
  };

  const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { httpOk: r.ok, data: j };
}

async function stkQuery(checkoutId) {
  const token = await getToken();
  const ts = stamp();
  const r = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: SHORTCODE,
      Password:          password(ts),
      Timestamp:         ts,
      CheckoutRequestID: checkoutId,
    }),
  });
  return r.json().catch(() => ({}));
}

/* ------------------------------- AUTH ------------------------------ */
function auth(req, res, next) {
  const key = req.get('x-api-key');
  if (!key || !devices.has(key)) return res.status(401).json({ ok: false, error: 'bad key' });
  req.deviceId = devices.get(key);
  next();
}

/* ------------------------------ ROUTES ----------------------------- */
app.get('/health', (_req, res) => res.json({ ok: true, env: MPESA_ENV, pending: txns.size }));

/* --- machine asks for a payment prompt --- */
app.post('/api/stk', auth, async (req, res) => {
  const phone = normalisePhone(req.body.phone);
  const amount = parseInt(req.body.amount, 10);
  const reference = req.body.ref || 'MILK';

  if (!phone)                       return res.status(400).json({ ok: false, error: 'bad phone' });
  if (!amount || amount < 1)        return res.status(400).json({ ok: false, error: 'bad amount' });
  if (amount > 70000)               return res.status(400).json({ ok: false, error: 'amount too high' });

  const id = shortId();
  const rec = {
    id, deviceId: req.deviceId, phone, amount, reference,
    state: 'PENDING', receipt: null, paidAmount: null,
    resultCode: null, resultDesc: null,
    checkoutId: null, merchantId: null,
    created: Date.now(), lastQuery: 0,
  };
  txns.set(id, rec);

  try {
    const { data } = await stkPush({ phone, amount, reference, txnId: id });

    if (data.ResponseCode === '0' && data.CheckoutRequestID) {
      rec.checkoutId = data.CheckoutRequestID;
      rec.merchantId = data.MerchantRequestID;
      byCheckout.set(rec.checkoutId, id);
      console.log(`[${id}] STK sent -> ${phone} KSh ${amount} (${rec.checkoutId})`);
      return res.json({ ok: true, txn: id });
    }

    rec.state = 'FAILED';
    rec.resultDesc = data.errorMessage || data.ResponseDescription || 'push rejected';
    rec.resultCode = data.errorCode || 'PUSH_REJECTED';
    console.warn(`[${id}] push rejected:`, JSON.stringify(data));
    return res.status(502).json({ ok: false, error: rec.resultDesc });
  } catch (e) {
    rec.state = 'FAILED';
    rec.resultDesc = e.message;
    console.error(`[${id}] push error:`, e.message);
    return res.status(502).json({ ok: false, error: 'daraja unreachable' });
  }
});

/* --- machine polls for the result --- */
app.get('/api/status/:txn', auth, (req, res) => {
  const rec = txns.get(req.params.txn);
  if (!rec) return res.status(404).json({ ok: false, error: 'unknown txn' });
  res.json({
    ok:      true,
    state:   rec.state,                 // PENDING | SUCCESS | FAILED
    amount:  rec.paidAmount,
    receipt: rec.receipt,
    code:    rec.resultCode,
    desc:    rec.resultDesc,
  });
});

/* --- Daraja delivers the result here --- */
app.post(`/api/callback/:token`, (req, res) => {
  /* Always 200 quickly, or Safaricom will retry. */
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  if (req.params.token !== CALLBACK_TOKEN) {
    console.warn('callback with bad token from', req.ip);
    return;
  }

  const cb = req.body?.Body?.stkCallback;
  if (!cb) return;

  const id = byCheckout.get(cb.CheckoutRequestID);
  if (!id) { console.warn('callback for unknown checkout', cb.CheckoutRequestID); return; }

  const rec = txns.get(id);
  if (!rec || rec.state !== 'PENDING') return;

  rec.resultCode = String(cb.ResultCode);
  rec.resultDesc = cb.ResultDesc;

  if (String(cb.ResultCode) === '0') {
    const items = cb.CallbackMetadata?.Item || [];
    const get = (n) => items.find((i) => i.Name === n)?.Value;
    rec.paidAmount = Number(get('Amount'));
    rec.receipt    = String(get('MpesaReceiptNumber') || '');

    /* Never accept an underpayment. */
    if (rec.paidAmount + 0.001 >= rec.amount) {
      rec.state = 'SUCCESS';
      console.log(`[${id}] PAID KSh ${rec.paidAmount} receipt ${rec.receipt}`);
    } else {
      rec.state = 'FAILED';
      rec.resultDesc = `underpaid ${rec.paidAmount}/${rec.amount}`;
      console.warn(`[${id}] ${rec.resultDesc} receipt ${rec.receipt}`);
    }
  } else {
    rec.state = 'FAILED';
    console.log(`[${id}] FAILED ${cb.ResultCode} ${cb.ResultDesc}`);
  }
});

/* ----------------------- RECONCILER / CLEANUP ---------------------- */
/*  Callbacks do get lost. Anything still pending after 30 s gets
    queried directly; anything past 150 s is declared failed so the
    machine is never left hanging.                                    */
setInterval(async () => {
  const now = Date.now();

  for (const rec of txns.values()) {
    if (rec.state === 'PENDING' && rec.checkoutId &&
        now - rec.created > 30000 && now - rec.lastQuery > 12000) {
      rec.lastQuery = now;
      try {
        const q = await stkQuery(rec.checkoutId);
        const rc = q.ResultCode !== undefined ? String(q.ResultCode) : null;
        if (rc === '0') {
          rec.state      = 'SUCCESS';
          rec.paidAmount = rec.amount;      // query gives no receipt
          rec.receipt    = rec.receipt || 'QUERY-OK';
          rec.resultCode = '0';
          rec.resultDesc = q.ResultDesc;
          console.log(`[${rec.id}] reconciled as PAID`);
        } else if (rc && rc !== '1032' && rc !== '1037' && rc !== '500.001.1001') {
          /* any settled non-success code */
          if (rc !== '1' || true) {
            rec.state      = 'FAILED';
            rec.resultCode = rc;
            rec.resultDesc = q.ResultDesc;
          }
        } else if (rc === '1032' || rc === '1037') {
          rec.state      = 'FAILED';
          rec.resultCode = rc;
          rec.resultDesc = q.ResultDesc;
        }
      } catch (e) {
        /* transient; try again next tick */
      }
    }

    if (rec.state === 'PENDING' && now - rec.created > 150000) {
      rec.state = 'FAILED';
      rec.resultCode = rec.resultCode || '1037';
      rec.resultDesc = rec.resultDesc || 'no response';
      console.log(`[${rec.id}] timed out`);
    }

    /* forget records after 30 min */
    if (now - rec.created > 30 * 60 * 1000) {
      if (rec.checkoutId) byCheckout.delete(rec.checkoutId);
      txns.delete(rec.id);
    }
  }
}, 8000);

app.listen(PORT, () => {
  console.log(`Milk ATM M-Pesa middleware on :${PORT}  [${MPESA_ENV}]`);
  console.log(`Callback: ${PUBLIC_BASE_URL}/api/callback/${CALLBACK_TOKEN}`);
  console.log(`Devices : ${[...devices.values()].join(', ') || '(none configured!)'}`);
});
