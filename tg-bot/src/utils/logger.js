const logger = {
    info(message, ...args) {
        console.log(`[INFO] ${new Date().toISOString()}: ${message}`, ...args);
    },
    
    error(message, error) {
        console.error(`[ERROR] ${new Date().toISOString()}: ${message}`);
        if (error) {
            console.error(error.stack || error);
        }
    },
    
    warn(message, ...args) {
        console.warn(`[WARN] ${new Date().toISOString()}: ${message}`, ...args);
    },
    
    debug(message, ...args) {
        if (process.env.DEBUG === 'true') {
            console.log(`[DEBUG] ${new Date().toISOString()}: ${message}`, ...args);
        }
    }
};

module.exports = logger;
