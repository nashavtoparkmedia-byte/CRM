const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');

// Patch BigInt serialization for JSON
BigInt.prototype.toJSON = function () { return this.toString() };

const app = express();
const prisma = new PrismaClient();

// Middleware to parse JSON bodies
app.use(express.json());
app.use(cors());

// Attach Prisma to the request object for easy access in routes
app.use((req, res, next) => {
    req.prisma = prisma;
    next();
});

// Import Admin, Webhook, and CRM routers
const adminRouter = require('./routes/admin/index');
const webhooksRouter = require('./routes/webhooks');
const crmRouter = require('./routes/crm');

// Mount routes
app.use('/api/admin', adminRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/bot', crmRouter);

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('[Global Error]:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

const PORT = process.env.API_PORT || 3001;
function startServer() {
    return app.listen(PORT, () => {
        console.log(`[Server] API running on port ${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };
