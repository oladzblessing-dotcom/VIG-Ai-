# VIG Ai: full app (login, payments, real AI images)

## Go live in 6 steps
(Phone tip: the 6 site files may sit in the main folder next to server.js, no `public` folder needed.)
1. Put this folder on GitHub (the .gitignore keeps your secrets out).
2. On render.com: New > Blueprint > pick the repo. It reads render.yaml (web service + 1 GB disk).
3. Fill in the env vars it asks for. Set BASE_URL to your Render address, e.g. https://vigai.onrender.com
4. Stripe: create the $5/month price, add the webhook (https://YOUR-SITE/api/webhook), and paste the keys (details below).
5. Google (optional): create the OAuth client and add your site as an Authorized JavaScript origin (details below).
6. Test with Stripe test mode, then swap in live keys. Fill in the [brackets] in terms.html and privacy.html first.

Pages: `/` landing + pricing, `/login.html`, `/app.html` (the studio).

## Run locally
1. Node 20+, then `npm install`
2. `cp .env.example .env` and fill it in (see below)
3. `npm run dev`, open http://localhost:3000

## Get paid with Stripe
1. Create an account at stripe.com, finish identity + business details, add your BANK ACCOUNT for payouts.
2. Products > Add product "VIG Ai Pro", price $5, recurring monthly. Copy the Price ID (price_...) into STRIPE_PRICE_ID.
3. Developers > API keys: copy the secret key into STRIPE_SECRET_KEY. Use test keys first.
4. Settings > Billing > Customer portal: turn it on (lets users cancel/update cards).
5. Developers > Webhooks > Add endpoint: https://YOUR-SITE/api/webhook
   Events: checkout.session.completed, invoice.paid, customer.subscription.deleted.
   Copy its signing secret into STRIPE_WEBHOOK_SECRET.
6. Test with card 4242 4242 4242 4242 (any future date, any CVC). Then switch to live keys.
Stripe sends payouts to your bank on a schedule and keeps a fee per charge (check their pricing for your country).

## Sign in with Google
1. console.cloud.google.com > create a project > APIs & Services > OAuth consent screen (fill in app name + email).
2. Credentials > Create credentials > OAuth client ID > Web application.
3. Authorized JavaScript origins: your live https address, and http://localhost:3000 for testing.
4. Copy the Client ID into GOOGLE_CLIENT_ID. If it is empty, the Google button is hidden automatically.

## Deploy (Render, Railway or Fly.io)
- Start command: `npm start`; set every .env value in the host's dashboard; set BASE_URL to your real https address.
- IMPORTANT: attach a persistent disk and point DB_PATH at it, or users and credits reset on every deploy.

## Before you take real money
- Add Terms of Service and Privacy Policy pages (Stripe expects them).
- Add email verification, otherwise people can sign up repeatedly for free images.
- Check OpenAI's current price per image so $5 / 100 images stays profitable; lower the credits if not.
