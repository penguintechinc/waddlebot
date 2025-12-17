const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

/**
 * Webhook Routes
 * Routes for payment provider webhooks
 *
 * IMPORTANT: Stripe webhooks require raw body, PayPal webhooks use JSON
 * Configure middleware accordingly in server.js
 */

// Stripe webhook - requires raw body
router.post('/stripe', paymentController.handleStripeWebhook);

// PayPal webhook - uses parsed JSON
router.post('/paypal', paymentController.handlePayPalWebhook);

module.exports = router;
