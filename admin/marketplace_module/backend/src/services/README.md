# Payment Services

This directory contains comprehensive payment integration services for the WaddleBot Marketplace.

## Services Overview

### 1. stripeService.js
Handles all Stripe payment operations including:
- Checkout sessions (one-time payments)
- Subscription sessions
- Payment intents
- Webhook handling and verification
- Refund processing
- Customer management
- Subscription management (create, update, cancel, reactivate)

### 2. paypalService.js
Handles all PayPal payment operations including:
- Order creation and capture
- Webhook handling and verification
- Refund processing
- Subscription management (with REST API placeholders)

### 3. paymentService.js
Unified payment interface that provides:
- Provider-agnostic payment methods
- Automatic provider selection
- Consistent API across Stripe and PayPal
- Configuration validation
- Amount formatting utilities

## Installation

Install required dependencies:

```bash
npm install stripe @paypal/checkout-server-sdk
```

## Environment Variables

Create a `.env` file with the following variables:

```env
# Default payment provider (stripe or paypal)
DEFAULT_PAYMENT_PROVIDER=stripe

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret

# PayPal Configuration
PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_CLIENT_SECRET=your_paypal_client_secret
PAYPAL_MODE=sandbox  # or 'production'
PAYPAL_WEBHOOK_ID=your_webhook_id  # For webhook verification
```

## Usage Examples

### One-Time Payment (Checkout)

```javascript
const paymentService = require('./services/paymentService');

// Using unified service (defaults to configured provider)
const checkout = await paymentService.createCheckout({
  provider: 'stripe', // or 'paypal'
  items: [
    {
      name: 'Premium Extension',
      description: 'Advanced bot features',
      price: 29.99,
      quantity: 1,
      currency: 'usd',
      images: ['https://example.com/image.png'],
    }
  ],
  customerEmail: 'customer@example.com',
  successUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel',
  metadata: {
    orderId: 'order_123',
    userId: 'user_456',
  },
});

console.log('Checkout URL:', checkout.url);
```

### Subscription

```javascript
// Create subscription
const subscription = await paymentService.createSubscription({
  provider: 'stripe',
  planId: 'price_xxxxx', // Stripe Price ID
  customerEmail: 'customer@example.com',
  successUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel',
  trialPeriodDays: 14,
  metadata: {
    userId: 'user_456',
  },
});

console.log('Subscription URL:', subscription.url);
```

### Manage Subscriptions

```javascript
// Cancel subscription at period end
await paymentService.cancelSubscription('stripe', 'sub_xxxxx', false);

// Cancel immediately
await paymentService.cancelSubscription('stripe', 'sub_xxxxx', true);

// Reactivate cancelled subscription
await paymentService.reactivateSubscription('stripe', 'sub_xxxxx');

// Get subscription details
const sub = await paymentService.getSubscription('stripe', 'sub_xxxxx');
```

### Process Refund

```javascript
// Full refund
const refund = await paymentService.createRefund({
  provider: 'stripe',
  paymentId: 'pi_xxxxx', // Payment Intent ID for Stripe
  reason: 'requested_by_customer',
});

// Partial refund
const partialRefund = await paymentService.createRefund({
  provider: 'stripe',
  paymentId: 'pi_xxxxx',
  amount: 15.00, // Refund $15
  reason: 'requested_by_customer',
  metadata: {
    refundReason: 'Partial service',
  },
});
```

### Webhook Handling

```javascript
// In your webhook endpoint
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await paymentService.handleWebhook({
      provider: 'stripe',
      headers: req.headers,
      payload: req.body, // Raw body for Stripe
    });

    console.log('Webhook processed:', result);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.post('/webhooks/paypal', express.json(), async (req, res) => {
  try {
    const result = await paymentService.handleWebhook({
      provider: 'paypal',
      headers: req.headers,
      payload: req.body, // Parsed JSON for PayPal
    });

    console.log('Webhook processed:', result);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});
```

### Direct Provider Usage

```javascript
const stripeService = require('./services/stripeService');
const paypalService = require('./services/paypalService');

// Use Stripe directly
const stripeCheckout = await stripeService.createCheckoutSession({
  items: [...],
  customerEmail: 'customer@example.com',
  successUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel',
});

// Use PayPal directly
const paypalOrder = await paypalService.createOrder({
  items: [...],
  totalAmount: 29.99,
  currency: 'USD',
  returnUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel',
});
```

### Customer Management

```javascript
// Create customer
const customer = await paymentService.createCustomer({
  provider: 'stripe',
  email: 'customer@example.com',
  name: 'John Doe',
  metadata: {
    userId: 'user_456',
  },
});

// Get customer details
const customerData = await paymentService.getCustomer('stripe', customer.customerId);

// List payment methods
const methods = await paymentService.listPaymentMethods('stripe', customer.customerId);
```

### Configuration Validation

```javascript
// Validate provider configuration
const validation = paymentService.validateProviderConfig('stripe');
if (!validation.valid) {
  console.error('Configuration errors:', validation.errors);
}

// Get supported providers
const providers = paymentService.getSupportedProviders();
console.log('Supported providers:', providers); // ['stripe', 'paypal']
```

## Webhook Events

### Stripe Events
- `checkout.session.completed` - Checkout session completed
- `payment_intent.succeeded` - Payment succeeded
- `payment_intent.payment_failed` - Payment failed
- `customer.subscription.created` - Subscription created
- `customer.subscription.updated` - Subscription updated
- `customer.subscription.deleted` - Subscription cancelled
- `invoice.payment_succeeded` - Invoice paid (subscription)
- `invoice.payment_failed` - Invoice payment failed

### PayPal Events
- `CHECKOUT.ORDER.APPROVED` - Order approved
- `CHECKOUT.ORDER.COMPLETED` - Order completed
- `PAYMENT.CAPTURE.COMPLETED` - Payment captured
- `PAYMENT.CAPTURE.DENIED` - Payment denied
- `PAYMENT.CAPTURE.REFUNDED` - Payment refunded
- `BILLING.SUBSCRIPTION.CREATED` - Subscription created
- `BILLING.SUBSCRIPTION.ACTIVATED` - Subscription activated
- `BILLING.SUBSCRIPTION.UPDATED` - Subscription updated
- `BILLING.SUBSCRIPTION.CANCELLED` - Subscription cancelled
- `BILLING.SUBSCRIPTION.EXPIRED` - Subscription expired
- `BILLING.SUBSCRIPTION.SUSPENDED` - Subscription suspended
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED` - Subscription payment failed

## Testing

### Stripe Test Cards
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`
- Requires Authentication: `4000 0025 0000 3155`

### PayPal Sandbox
Use PayPal sandbox accounts for testing:
- Buyer account: Create in PayPal Developer Dashboard
- Seller account: Your sandbox business account

## Security Best Practices

1. **Never expose secret keys** - Keep them in environment variables
2. **Validate webhooks** - Always verify webhook signatures
3. **Use HTTPS** - All payment endpoints must use HTTPS
4. **Store minimal data** - Don't store full card details
5. **Log securely** - Never log sensitive payment information
6. **Handle errors gracefully** - Provide user-friendly error messages
7. **Implement idempotency** - Prevent duplicate charges
8. **Set up webhook monitoring** - Monitor webhook delivery and failures

## Error Handling

All services throw descriptive errors. Always wrap calls in try-catch:

```javascript
try {
  const result = await paymentService.createCheckout({...});
} catch (error) {
  console.error('Payment error:', error.message);
  // Handle error appropriately
  // - Show user-friendly message
  // - Log for debugging
  // - Retry if appropriate
}
```

## Integration Notes

### Database Integration
The webhook handlers include TODO comments where you should:
- Store transaction records
- Update order status
- Send confirmation emails
- Fulfill orders
- Update user subscriptions

### Frontend Integration
For Stripe:
```javascript
// Redirect to checkout
window.location.href = checkout.url;
```

For PayPal:
```javascript
// Redirect to approval URL
window.location.href = order.approvalUrl;
```

## Support

For issues or questions:
- Stripe: https://stripe.com/docs
- PayPal: https://developer.paypal.com/docs
- WaddleBot: See main project documentation
