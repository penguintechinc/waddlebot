const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

/**
 * Payment Routes
 * All routes for payment operations
 */

// Checkout and payments
router.post('/checkout', paymentController.createCheckout);
router.post('/complete', paymentController.completePayment);
router.get('/:provider/:id', paymentController.getPayment);

// Subscriptions
router.post('/subscriptions', paymentController.createSubscription);
router.get('/subscriptions/:provider/:id', paymentController.getSubscription);
router.post('/subscriptions/:provider/:id/cancel', paymentController.cancelSubscription);
router.post('/subscriptions/:provider/:id/reactivate', paymentController.reactivateSubscription);

// Refunds
router.post('/refunds', paymentController.createRefund);
router.get('/refunds/:provider/:id', paymentController.getRefund);

// Customers
router.post('/customers', paymentController.createCustomer);
router.get('/customers/:provider/:id', paymentController.getCustomer);
router.get('/customers/:provider/:id/payment-methods', paymentController.listPaymentMethods);

// Configuration
router.get('/providers', paymentController.getSupportedProviders);
router.get('/config/validate/:provider', paymentController.validateConfig);

module.exports = router;
