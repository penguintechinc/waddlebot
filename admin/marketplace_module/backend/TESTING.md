# Payment Services Testing Guide

This guide provides comprehensive testing instructions for the payment services.

## Setup

1. Install dependencies:
```bash
cd /home/penguin/code/WaddleBot/admin/marketplace_module/backend
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Configure your payment provider credentials in `.env`

4. Start the server:
```bash
npm run dev
```

## Testing with curl

### 1. Check Server Health

```bash
curl http://localhost:3001/health
```

### 2. Get Supported Providers

```bash
curl http://localhost:3001/api/payments/providers
```

### 3. Validate Configuration

```bash
# Validate Stripe
curl http://localhost:3001/api/payments/config/validate/stripe

# Validate PayPal
curl http://localhost:3001/api/payments/config/validate/paypal
```

### 4. Create Stripe Checkout Session

```bash
curl -X POST http://localhost:3001/api/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "items": [
      {
        "name": "Premium Bot Extension",
        "description": "Advanced features for your bot",
        "price": 29.99,
        "quantity": 1,
        "currency": "usd",
        "images": ["https://example.com/product.png"]
      }
    ],
    "customerEmail": "customer@example.com",
    "metadata": {
      "orderId": "order_123",
      "productId": "prod_456"
    }
  }'
```

### 5. Create PayPal Order

```bash
curl -X POST http://localhost:3001/api/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "paypal",
    "items": [
      {
        "name": "Premium Bot Extension",
        "description": "Advanced features for your bot",
        "price": 29.99,
        "quantity": 1
      }
    ],
    "customerEmail": "customer@example.com",
    "metadata": {
      "orderId": "order_123"
    }
  }'
```

### 6. Create Subscription

```bash
curl -X POST http://localhost:3001/api/payments/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "planId": "price_1234567890",
    "customerEmail": "customer@example.com",
    "trialPeriodDays": 14,
    "metadata": {
      "userId": "user_789"
    }
  }'
```

### 7. Cancel Subscription

```bash
# Cancel at period end
curl -X POST http://localhost:3001/api/payments/subscriptions/stripe/sub_1234567890/cancel \
  -H "Content-Type: application/json" \
  -d '{
    "immediately": false
  }'

# Cancel immediately
curl -X POST http://localhost:3001/api/payments/subscriptions/stripe/sub_1234567890/cancel \
  -H "Content-Type: application/json" \
  -d '{
    "immediately": true
  }'
```

### 8. Reactivate Subscription

```bash
curl -X POST http://localhost:3001/api/payments/subscriptions/stripe/sub_1234567890/reactivate
```

### 9. Create Refund

```bash
# Full refund
curl -X POST http://localhost:3001/api/payments/refunds \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "paymentId": "pi_1234567890",
    "reason": "requested_by_customer"
  }'

# Partial refund
curl -X POST http://localhost:3001/api/payments/refunds \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "paymentId": "pi_1234567890",
    "amount": 15.00,
    "reason": "requested_by_customer",
    "metadata": {
      "refundReason": "Partial service"
    }
  }'
```

### 10. Create Customer

```bash
curl -X POST http://localhost:3001/api/payments/customers \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "email": "customer@example.com",
    "name": "John Doe",
    "metadata": {
      "userId": "user_123"
    }
  }'
```

## Testing Webhooks

### Stripe Webhook Testing

1. Install Stripe CLI:
```bash
# Linux
curl -s https://packages.stripe.com/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.com/stripe-cli-debian-local stable main" | sudo tee -a /etc/apt/sources.list.d/stripe.list
sudo apt update
sudo apt install stripe
```

2. Login to Stripe:
```bash
stripe login
```

3. Forward webhooks to local server:
```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
```

4. Copy the webhook signing secret and add to `.env`:
```
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
```

5. Trigger test events:
```bash
# Test successful payment
stripe trigger payment_intent.succeeded

# Test checkout session completed
stripe trigger checkout.session.completed

# Test subscription created
stripe trigger customer.subscription.created
```

### PayPal Webhook Testing

1. Use PayPal's webhook simulator in the Developer Dashboard:
   - Go to: https://developer.paypal.com/dashboard/webhooks
   - Select your webhook
   - Use the "Simulator" tab to send test events

2. Or use ngrok to expose your local server:
```bash
# Install ngrok
npm install -g ngrok

# Expose local server
ngrok http 3001
```

3. Configure the ngrok URL in PayPal webhook settings:
```
https://your-ngrok-url.ngrok.io/api/webhooks/paypal
```

## Frontend Integration Examples

### JavaScript/HTML

```html
<!DOCTYPE html>
<html>
<head>
    <title>Checkout Test</title>
</head>
<body>
    <h1>Payment Test</h1>
    <button id="checkout-btn">Purchase - $29.99</button>

    <script>
        document.getElementById('checkout-btn').addEventListener('click', async () => {
            try {
                const response = await fetch('http://localhost:3001/api/payments/checkout', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        provider: 'stripe',
                        items: [{
                            name: 'Premium Bot Extension',
                            description: 'Advanced features',
                            price: 29.99,
                            quantity: 1,
                            currency: 'usd',
                        }],
                        customerEmail: 'customer@example.com',
                    }),
                });

                const data = await response.json();

                if (data.success && data.url) {
                    // Redirect to checkout
                    window.location.href = data.url;
                } else {
                    alert('Error creating checkout: ' + (data.error || 'Unknown error'));
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        });
    </script>
</body>
</html>
```

### React Example

```jsx
import { useState } from 'react';

function CheckoutButton() {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async () => {
    setLoading(true);

    try {
      const response = await fetch('http://localhost:3001/api/payments/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'stripe',
          items: [{
            name: 'Premium Bot Extension',
            description: 'Advanced features',
            price: 29.99,
            quantity: 1,
            currency: 'usd',
          }],
          customerEmail: 'customer@example.com',
        }),
      });

      const data = await response.json();

      if (data.success && data.url) {
        window.location.href = data.url;
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Checkout error:', error);
      alert('Failed to create checkout');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleCheckout} disabled={loading}>
      {loading ? 'Processing...' : 'Purchase - $29.99'}
    </button>
  );
}

export default CheckoutButton;
```

## Test Credit Cards (Stripe)

Use these test cards in Stripe test mode:

| Card Number         | Description                  |
|---------------------|------------------------------|
| 4242 4242 4242 4242 | Successful payment           |
| 4000 0000 0000 0002 | Card declined                |
| 4000 0025 0000 3155 | Requires authentication      |
| 4000 0000 0000 9995 | Insufficient funds           |
| 4000 0000 0000 0069 | Expired card                 |

- Use any future expiry date (e.g., 12/34)
- Use any 3-digit CVV (e.g., 123)
- Use any postal code

## PayPal Sandbox Testing

1. Create sandbox accounts:
   - Go to: https://developer.paypal.com/dashboard/accounts
   - Create a Personal account (buyer)
   - Create a Business account (seller)

2. Use sandbox accounts for testing:
   - Login with sandbox credentials during checkout
   - Complete test transactions

## Common Issues and Solutions

### Issue: "STRIPE_SECRET_KEY is not configured"
**Solution:** Add your Stripe secret key to `.env` file

### Issue: "Webhook signature verification failed"
**Solution:**
- For Stripe: Ensure `STRIPE_WEBHOOK_SECRET` matches the secret from Stripe CLI or Dashboard
- For PayPal: Ensure `PAYPAL_WEBHOOK_ID` is set correctly

### Issue: "Cannot access '/api/webhooks/stripe'"
**Solution:** Ensure webhook route is registered BEFORE `express.json()` middleware

### Issue: PayPal order creation fails
**Solution:** Check `PAYPAL_MODE` is set to `sandbox` and credentials are correct

### Issue: CORS errors in browser
**Solution:** Add your frontend URL to `ALLOWED_ORIGINS` in `.env`

## Monitoring and Debugging

### Enable detailed logging

```bash
# In .env
LOG_LEVEL=debug
NODE_ENV=development
```

### Check webhook deliveries

**Stripe:**
- Dashboard → Developers → Webhooks → Select webhook → Logs

**PayPal:**
- Dashboard → Webhooks → Select webhook → Events

### Test in production

1. Never use test keys in production
2. Replace all test credentials with live credentials
3. Update webhook URLs to production URLs
4. Test with small amounts first
5. Monitor error rates and logs

## Security Checklist

- [ ] Environment variables are not committed to git
- [ ] Webhook signatures are verified
- [ ] HTTPS is enabled in production
- [ ] Rate limiting is configured
- [ ] Error messages don't leak sensitive data
- [ ] Payment provider credentials are secure
- [ ] Customer data is handled according to PCI compliance
- [ ] Logs don't contain sensitive payment information

## Performance Testing

```bash
# Install Apache Bench
sudo apt-get install apache2-utils

# Test checkout endpoint (100 requests, 10 concurrent)
ab -n 100 -c 10 -p checkout-data.json -T application/json http://localhost:3001/api/payments/checkout
```

## Next Steps

1. Implement order management system
2. Add email notifications
3. Create admin dashboard for viewing transactions
4. Implement subscription management UI
5. Add analytics and reporting
6. Set up monitoring and alerting
7. Implement retry logic for failed webhooks
8. Add support for additional payment methods
