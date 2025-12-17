# Quick Start Guide - WaddleBot Marketplace Payment Services

Get up and running with payment integration in 5 minutes!

## Prerequisites

- Node.js 18+ installed
- Stripe account (https://stripe.com)
- PayPal account (https://paypal.com) - optional

## Step 1: Install Dependencies

```bash
cd /home/penguin/code/WaddleBot/admin/marketplace_module/backend
npm install
```

## Step 2: Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your editor
nano .env
```

**Minimum required configuration for Stripe:**

```env
DEFAULT_PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_your_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_secret_here
```

**Get Stripe keys:**
1. Go to https://dashboard.stripe.com/test/apikeys
2. Copy "Secret key" (starts with `sk_test_`)
3. For webhook secret, see "Step 4: Set Up Webhooks" below

## Step 3: Start the Server

```bash
npm run dev
```

You should see:

```
╔════════════════════════════════════════════════════════════╗
║     WaddleBot Marketplace Backend Server                  ║
║     Server running on port 3001                           ║
║     Environment: development                              ║
║     Default Provider: stripe                              ║
╚════════════════════════════════════════════════════════════╝

✓ STRIPE: Configured correctly
```

## Step 4: Set Up Webhooks

### For Local Development (Stripe)

1. Install Stripe CLI:
```bash
# Download from: https://stripe.com/docs/stripe-cli
# Or on Linux:
curl -s https://packages.stripe.com/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.com/stripe-cli-debian-local stable main" | sudo tee -a /etc/apt/sources.list.d/stripe.list
sudo apt update
sudo apt install stripe
```

2. Login and forward webhooks:
```bash
stripe login
stripe listen --forward-to localhost:3001/api/webhooks/stripe
```

3. Copy the webhook signing secret (starts with `whsec_`) and add to `.env`

## Step 5: Test a Payment

### Using curl:

```bash
curl -X POST http://localhost:3001/api/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "items": [{
      "name": "Test Product",
      "description": "Test purchase",
      "price": 10.00,
      "quantity": 1,
      "currency": "usd"
    }],
    "customerEmail": "test@example.com"
  }'
```

**Response:**
```json
{
  "success": true,
  "sessionId": "cs_test_...",
  "url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

### Open the checkout URL in your browser:

1. Copy the `url` from the response
2. Paste into browser
3. Use test card: `4242 4242 4242 4242`
4. Any future expiry date (e.g., 12/34)
5. Any CVV (e.g., 123)
6. Complete payment

## Step 6: Verify Webhook Received

Check your terminal where `stripe listen` is running. You should see:

```
→ checkout.session.completed [evt_xxx]
✓ Successfully forwarded to localhost:3001/api/webhooks/stripe
```

Your server logs will show:
```
Checkout session completed: cs_test_xxx
```

## Common Endpoints

### Create Checkout
```bash
POST http://localhost:3001/api/payments/checkout
```

### Create Subscription
```bash
POST http://localhost:3001/api/payments/subscriptions
```

### Create Refund
```bash
POST http://localhost:3001/api/payments/refunds
```

### Handle Webhooks
```bash
POST http://localhost:3001/api/webhooks/stripe
POST http://localhost:3001/api/webhooks/paypal
```

## Frontend Integration

### Simple HTML Example

Create `test.html`:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Quick Test</title>
</head>
<body>
    <button onclick="checkout()">Buy Now - $10</button>

    <script>
        async function checkout() {
            const response = await fetch('http://localhost:3001/api/payments/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: 'stripe',
                    items: [{
                        name: 'Test Product',
                        price: 10.00,
                        quantity: 1,
                        currency: 'usd'
                    }],
                    customerEmail: 'test@example.com'
                })
            });

            const data = await response.json();
            if (data.url) window.location.href = data.url;
        }
    </script>
</body>
</html>
```

Open in browser: `file:///path/to/test.html`

## Production Deployment

When ready for production:

1. **Get live credentials:**
   - Stripe: https://dashboard.stripe.com/apikeys (toggle to "Live")
   - PayPal: Switch to production mode

2. **Update .env:**
   ```env
   NODE_ENV=production
   STRIPE_SECRET_KEY=sk_live_your_key_here
   PAYPAL_MODE=production
   ```

3. **Configure production webhooks:**
   - Stripe: https://dashboard.stripe.com/webhooks
   - PayPal: https://developer.paypal.com/dashboard/webhooks

4. **Set webhook URLs to your production domain:**
   ```
   https://your-domain.com/api/webhooks/stripe
   https://your-domain.com/api/webhooks/paypal
   ```

5. **Enable HTTPS** - Payment webhooks require HTTPS

6. **Test with small amounts first!**

## Troubleshooting

### Server won't start
- Check Node.js version: `node --version` (needs 18+)
- Check for port conflicts: `lsof -i :3001`
- Verify .env file exists and has correct syntax

### "Configuration errors" on startup
- Check that API keys are set in .env
- Verify no extra spaces or quotes around keys
- Make sure .env is in the correct directory

### Checkout returns error
- Check server logs for detailed error message
- Verify API keys are test keys (start with `sk_test_`)
- Ensure items array has required fields (name, price)

### Webhooks not received
- Verify `stripe listen` is running
- Check webhook secret in .env matches output from `stripe listen`
- Ensure server is running on port 3001

## Next Steps

1. **Read full documentation:**
   - `README.md` - Complete API documentation
   - `TESTING.md` - Comprehensive testing guide

2. **Customize for your needs:**
   - Add database integration in webhook handlers
   - Implement order management
   - Add email notifications
   - Create admin dashboard

3. **Explore advanced features:**
   - Subscription management
   - Customer portal
   - Refund processing
   - Multiple currencies

## Support

- **Stripe Docs:** https://stripe.com/docs
- **PayPal Docs:** https://developer.paypal.com/docs
- **GitHub Issues:** Report bugs in the WaddleBot repository

## Resources

- Stripe Dashboard: https://dashboard.stripe.com
- PayPal Dashboard: https://developer.paypal.com/dashboard
- Test Cards: See `TESTING.md`

Happy coding! 🦆
