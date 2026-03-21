const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/auth');

const botsRouter = require('./bots');
const surveysRouter = require('./surveys');
const usersRouter = require('./users');
const dashboardRouter = require('./dashboard');

// Apply basic auth to all admin routes
router.use(adminAuth);

// Important: surveysRouter defines specific /bots/:botId/survey routes
// It must be mounted before botsRouter or share the exact same root path priority
router.use('/', surveysRouter);
router.use('/bots', botsRouter);
router.use('/users', usersRouter);
router.use('/dashboard', dashboardRouter);

module.exports = router;
