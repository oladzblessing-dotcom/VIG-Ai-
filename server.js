import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import Stripe from 'stripe';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';

const { JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, OPENAI_API_KEY, GOOGLE_CLIENT_ID,
  BASE_URL = 'http://localhost:3000', DB_PATH = './vigai.db', PORT = 3000 } = process.env;
if (!JWT_SECRET) throw new Error('Set JWT_SECRET in .env');

const FREE_CREDITS = 5, PRO_CREDITS = 100;
const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_missing');
const gclient = new OAuth2Client(GOOGLE_CLIENT_ID);
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, hash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0, pro INTEGER NOT NULL DEFAULT 0,
  stripe_customer TEXT, stripe_sub TEXT)`);

const app = express();
app.set('trust proxy', 1);

// Stripe webhook: needs the raw body, so it goes BEFORE express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('Bad signature'); }
  const o = ev.data.object;
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
    db.prepare('UPDATE users SET pro=1, credits=?, stripe_customer=?, stripe_sub=? WHERE id=?')
      .run(PRO_CREDITS, o.customer, o.subscription, Number(o.client_reference_id));
  } else if (ev.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
    db.prepare('UPDATE users SET credits=?, pro=1 WHERE stripe_customer=?').run(PRO_CREDITS, o.customer);
  } else if (ev.type === 'customer.subscription.deleted') {
    db.prepare('UPDATE users SET pro=0 WHERE stripe_customer=?').run(o.customer);
  }
  res.json({ received: true });
});

const smallJson = express.json({ limit: '10kb' }), bigJson = express.json({ limit: '6mb' });
app.use((req, res, next) => (req.path === '/api/generate' ? bigJson : smallJson)(req, res, next));
app.use(cookieParser());
// Serve only these site files, from /public if it exists, otherwise from the main folder
const SITE = new Set(['index.html', 'login.html', 'app.html', 'terms.html', 'privacy.html', 'site.css']);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
app.get(['/', '/:page'], (req, res, next) => {
  const n = req.params.page || 'index.html';
  if (!SITE.has(n)) return next();
  const f = [path.join(ROOT, 'public', n), path.join(ROOT, n)].find(fs.existsSync);
  f ? res.sendFile(f) : next();
});
app.get('/health', (req, res) => res.send('ok'));

const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20 });
const genLimit = rateLimit({ windowMs: 60_000, limit: 6 });

const sign = (res, id) => res.cookie('token', jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' }),
  { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'), maxAge: 30 * 864e5 });

function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.token, JWT_SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new Error('no user');
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
}

app.post('/api/signup', authLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (pw.length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters' });
  try {
    const r = db.prepare('INSERT INTO users(email,hash,credits) VALUES(?,?,?)')
      .run(email, bcrypt.hashSync(pw, 10), FREE_CREDITS);
    sign(res, r.lastInsertRowid); res.json({ ok: true });
  } catch { res.status(409).json({ error: 'That email already has an account' }); }
});

app.post('/api/login', authLimit, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash))
    return res.status(401).json({ error: 'Wrong email or password' });
  sign(res, u.id); res.json({ ok: true });
});

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID.includes('.') ? GOOGLE_CLIENT_ID : null }));

app.post('/api/google', authLimit, async (req, res) => {
  try {
    const t = await gclient.verifyIdToken({ idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID });
    const p = t.getPayload();
    if (!p.email || !p.email_verified) throw new Error('unverified email');
    const email = p.email.toLowerCase();
    let u = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (!u) {
      const r = db.prepare('INSERT INTO users(email,hash,credits) VALUES(?,?,?)')
        .run(email, bcrypt.hashSync(randomUUID(), 10), FREE_CREDITS);
      u = { id: r.lastInsertRowid };
    }
    sign(res, u.id); res.json({ ok: true });
  } catch (e) { res.status(401).json({ error: 'Google sign-in failed' }); }
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ email: req.user.email, credits: req.user.credits, pro: !!req.user.pro }));

app.post('/api/spend', auth, (req, res) => {
  const took = db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(req.user.id);
  if (!took.changes) return res.status(402).json({ error: 'Out of credits' });
  res.json({ credits: db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id).credits });
});

const STYLES = { dusk: 'warm purple and pink dusk lighting', ocean: 'cool deep blue and teal tones',
  ember: 'glowing orange and red ember tones', forest: 'lush green forest tones' };

const KINDS = {
  image: { size: '1024x1024', pre: '' },
  logo: { size: '1024x1024', pre: 'A clean, modern logo design, simple bold shapes, centered on a plain background: ' },
  poster: { size: '1024x1536', pre: 'A bold, well-composed poster or flyer design with a strong visual hierarchy: ' },
  social: { size: '1024x1024', pre: 'An eye-catching social media post graphic with a vibrant, mobile-friendly composition: ' },
};

app.post('/api/generate', auth, genLimit, async (req, res) => {
  const prompt = String(req.body.prompt || '').trim().slice(0, 500);
  const img = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
  if (req.body.image && !img) return res.status(400).json({ error: 'Unsupported image. Use JPG, PNG or WebP.' });
  if (!prompt && !img) return res.status(400).json({ error: 'Describe what you want first' });
  const k = KINDS[req.body.kind] || KINDS.image;
  // Atomic: take the credit first, refund if generation fails
  const took = db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(req.user.id);
  if (!took.changes) return res.status(402).json({ error: 'Out of credits' });
  const refund = () => db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(req.user.id);
  try {
    const model = process.env.IMAGE_MODEL || 'gpt-image-2';
    const st = STYLES[req.body.style];
    const base = img ? (prompt || 'Enhance this image: improve clarity, lighting, colour and detail, keeping the content the same') : k.pre + prompt;
    const text = st ? `${base}. Style: ${st}` : base;
    let r;
    if (img) { // imported image or design: edit / enhance it with the prompt
      const form = new FormData();
      form.append('model', model); form.append('prompt', text); form.append('quality', 'low'); form.append('size', k.size);
      form.append('image', new Blob([Buffer.from(img[3], 'base64')], { type: img[1] }), 'input.' + (img[2] === 'jpeg' ? 'jpg' : img[2]));
      r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
    } else {
      r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model, prompt: text, size: k.size, quality: 'low', n: 1 }),
      });
    }
    const data = await r.json();
    if (!r.ok) { console.error(JSON.stringify(data)); refund(); return res.status(502).json({ error: 'Image service error. Credit refunded.' }); }
    const credits = db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id).credits;
    res.json({ image: data.data[0].b64_json, credits });
  } catch (e) { console.error(e); refund(); res.status(500).json({ error: 'Server error. Credit refunded.' }); }
});

app.post('/api/checkout', auth, async (req, res) => {
  try {
    const u = req.user;
    const s = await stripe.checkout.sessions.create({
      mode: 'subscription', line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: String(u.id),
      ...(u.stripe_customer ? { customer: u.stripe_customer } : { customer_email: u.email }),
      success_url: `${BASE_URL}/app.html?upgraded=1`, cancel_url: `${BASE_URL}/app.html`,
    });
    res.json({ url: s.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Checkout unavailable' }); }
});

app.post('/api/portal', auth, async (req, res) => {
  try {
    const s = await stripe.billingPortal.sessions.create({ customer: req.user.stripe_customer, return_url: `${BASE_URL}/app.html` });
    res.json({ url: s.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Billing portal unavailable' }); }
});

app.listen(PORT, () => console.log('VIG Ai running on ' + BASE_URL));
