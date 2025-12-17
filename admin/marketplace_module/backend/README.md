# WaddleBot Marketplace Payment Services

Complete payment integration for the WaddleBot marketplace, supporting both Stripe and PayPal payment providers.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [API Endpoints](#api-endpoints)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Testing](#testing)
- [Security](#security)
- [Production Deployment](#production-deployment)

## Features

### Payment Providers
- **Stripe** - Full integration with checkout sessions, payment intents, and webhooks
- **PayPal** - Order creation, capture, and webhook handling
- **Unified Interface** - Switch between providers seamlessly

### Payment Types
- One-time payments (checkout sessions)
- Recurring subscriptions
- Custom payment intents
- Payment links

### Operations
- Create checkout sessions
- Process payments
- Handle webhooks
- Issue refunds (full and partial)
- Manage subscriptions (create, update, cancel, reactivate)
- Customer management
- Payment method management

### Security
- Webhook signature verification (Stripe & PayPal)
- Rate limiting
- CORS protection
- Helmet security headers
- Environment variable configuration
- Input validation

## Architecture

```
marketplace_module/backend/
├── src/
│   ├── services/
│   │   ├── stripeService.js      # Stripe payment integration
│   │   ├── paypalService.js      # PayPal payment integration
│   │   ├── paymentService.js     # Unified payment interface
│   │   ├── orderService.js       # Order management example
│   │   └── README.md             # Service documentation
│   ├── controllers/
│   │   └── paymentController.js  # HTTP request handlers
│   ├── routes/
│   │   ├── payments.js           # Payment endpoints
│   │   └── webhooks.js           # Webhook endpoints
│   └── server.js                 # Express server setup
├── .env.example                  # Environment configuration template
├── package.json                  # Dependencies
├── README.md                     # This file
├── QUICKSTART.md                 # 5-minute setup guide
└── TESTING.md                    # Comprehensive testing guide
```

## Installation

1. **Install dependencies:**
```bash
cd /home/penguin/code/WaddleBot/admin/marketplace_module/backend
npm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your payment provider credentials
```

3. **Start the server:**
```bash
npm run dev
```

## Quick Start

See [QUICKSTART.md](./QUICKSTART.md) for a 5-minute getting started guide.

## Documentation

- **[QUICKSTART.md](./QUICKSTART.md)** - Get up and running in 5 minutes
- **[TESTING.md](./TESTING.md)** - Comprehensive testing guide with examples
- **[src/services/README.md](./src/services/README.md)** - Service API documentation

## API Endpoints

### Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/checkout` | Create checkout session |
| POST | `/api/payments/complete` | Complete payment |
| GET | `/api/payments/:provider/:id` | Get payment details |

### Subscriptions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/subscriptions` | Create subscription |
| GET | `/api/payments/subscriptions/:provider/:id` | Get subscription |
| POST | `/api/payments/subscriptions/:provider/:id/cancel` | Cancel subscription |
| POST | `/api/payments/subscriptions/:provider/:id/reactivate` | Reactivate subscription |

### Refunds

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/refunds` | Create refund |
| GET | `/api/payments/refunds/:provider/:id` | Get refund details |

### Customers

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/customers` | Create customer |
| GET | `/api/payments/customers/:provider/:id` | Get customer |
| GET | `/api/payments/customers/:provider/:id/payment-methods` | List payment methods |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/stripe` | Stripe webhook handler |
| POST | `/api/webhooks/paypal` | PayPal webhook handler |

### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payments/providers` | Get supported providers |
| GET | `/api/payments/config/validate/:provider` | Validate provider config |

## Project Structure

### Core Services

**stripeService.js**
- Stripe SDK integration
- Checkout sessions
- Payment intents
- Subscriptions
- Webhooks
- Refunds
- Customer management

**paypalService.js**
- PayPal SDK integration
- Order creation and capture
- Webhooks
- Refunds
- Subscription placeholders (requires REST API)

**paymentService.js**
- Unified interface for both providers
- Provider selection and switching
- Consistent API across providers
- Configuration validation
- Amount formatting utilities

**orderService.js**
- Example order management integration
- Payment success/failure handling
- Order fulfillment
- Email notifications
- Refund processing

### Controllers and Routes

**paymentController.js**
- HTTP request handlers
- Input validation
- Error handling
- Response formatting

**routes/payments.js**
- Payment endpoint routing

**routes/webhooks.js**
- Webhook endpoint routing
- Raw body handling for Stripe

### Server

**server.js**
- Express server setup
- Middleware configuration
- Security headers
- Rate limiting
- Error handling
- Graceful shutdown

## Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
# Required
DEFAULT_PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Optional
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_MODE=sandbox
PAYPAL_WEBHOOK_ID=...

# Server
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

### Getting API Keys

**Stripe:**
1. Go to https://dashboard.stripe.com/test/apikeys
2. Copy "Secret key" to `STRIPE_SECRET_KEY`
3. Set up webhook at https://dashboard.stripe.com/webhooks
4. Copy webhook secret to `STRIPE_WEBHOOK_SECRET`

**PayPal:**
1. Go to https://developer.paypal.com/dashboard/applications
2. Create an app
3. Copy Client ID and Secret
4. Set mode to `sandbox` for testing

## Testing

### Run Tests

```bash
# Install dependencies
npm install

# Run test server
npm run dev

# In another terminal, run tests
curl http://localhost:3001/health
```

### Test Payment Flow

See [TESTING.md](./TESTING.md) for:
- curl examples
- Frontend integration
- Webhook testing
- Test cards
- Common issues

### Quick Test

```bash
# Create checkout
curl -X POST http://localhost:3001/api/payments/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "items": [{"name": "Test", "price": 10, "quantity": 1, "currency": "usd"}],
    "customerEmail": "test@example.com"
  }'

# Use test card: 4242 4242 4242 4242
```

## Security

### Best Practices Implemented

- Environment variable secrets
- Webhook signature verification
- HTTPS enforcement (production)
- Rate limiting
- CORS protection
- Helmet security headers
- Input validation
- Secure error messages
- No sensitive data in logs

### Security Checklist

- [ ] API keys stored in environment variables
- [ ] Webhook signatures verified
- [ ] HTTPS enabled in production
- [ ] Rate limiting configured
- [ ] CORS origins restricted
- [ ] Error messages don't leak data
- [ ] Logs don't contain sensitive info
- [ ] Dependencies kept up to date

## Production Deployment

### Pre-deployment Checklist

1. **Get live credentials:**
   - Stripe live keys
   - PayPal production credentials

2. **Update environment:**
   ```env
   NODE_ENV=production
   STRIPE_SECRET_KEY=sk_live_...
   PAYPAL_MODE=production
   ```

3. **Configure webhooks:**
   - Point to production URLs
   - Use HTTPS
   - Verify signatures

4. **Security:**
   - Enable HTTPS
   - Restrict CORS origins
   - Configure firewall
   - Set up monitoring

5. **Testing:**
   - Test with small amounts
   - Verify webhooks work
   - Check error handling
   - Monitor logs

### Deployment Steps

1. Build and deploy application
2. Set environment variables
3. Configure webhooks in Stripe/PayPal dashboards
4. Test with small transaction
5. Monitor webhook deliveries
6. Set up error alerting

### Monitoring

Monitor these metrics:
- Payment success rate
- Webhook delivery rate
- Error rates
- Response times
- Refund rate

### Support

- **Stripe:** https://stripe.com/docs
- **PayPal:** https://developer.paypal.com/docs
- **Issues:** GitHub repository

## Usage Examples

### Basic Checkout

```javascript
const paymentService = require('./services/paymentService');

const checkout = await paymentService.createCheckout({
  provider: 'stripe',
  items: [{
    name: 'Premium Extension',
    price: 29.99,
    quantity: 1,
    currency: 'usd',
  }],
  customerEmail: 'customer@example.com',
});

// Redirect user to: checkout.url
```

### Subscription

```javascript
const subscription = await paymentService.createSubscription({
  provider: 'stripe',
  planId: 'price_xxxxx',
  customerEmail: 'customer@example.com',
  trialPeriodDays: 14,
});
```

### Refund

```javascript
const refund = await paymentService.createRefund({
  provider: 'stripe',
  paymentId: 'pi_xxxxx',
  amount: 15.00, // Partial refund
  reason: 'requested_by_customer',
});
```

### Webhook Handling

```javascript
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const result = await paymentService.handleWebhook({
    provider: 'stripe',
    headers: req.headers,
    payload: req.body,
  });
  res.json({ received: true });
});
```

## Integration with WaddleBot

To integrate with the main WaddleBot application:

1. **Update webhook handlers** in `stripeService.js` and `paypalService.js` to:
   - Store transactions in database
   - Update user accounts
   - Activate purchased features
   - Send confirmation emails

2. **Implement order management:**
   - See `orderService.js` for example
   - Connect to your database
   - Add fulfillment logic

3. **Add authentication:**
   - Protect endpoints with auth middleware
   - Verify user ownership
   - Add admin-only endpoints

4. **Create admin dashboard:**
   - View all transactions
   - Process refunds
   - Manage subscriptions
   - Export reports

## Contributing

When contributing to payment services:

1. Never commit API keys or secrets
2. Test with sandbox/test credentials
3. Verify webhook signature handling
4. Add error handling
5. Update documentation
6. Test refund flows
7. Verify subscription cancellation

## License

See main WaddleBot repository for license information.

## Support

For help with:
- **Payment integration:** See documentation above
- **Stripe issues:** https://stripe.com/docs
- **PayPal issues:** https://developer.paypal.com/docs
- **WaddleBot issues:** GitHub repository

---

Built with care for the WaddleBot community 🦆
