// Bridge configuration placeholder
module.exports = {

    VERSION: '2.0.0-alpha1',

    PORT: process.env.PORT || 3001,

    BRIDGE_SECRET: process.env.BRIDGE_SECRET || '',

    LARAVEL_WEBHOOK_URL: process.env.LARAVEL_WEBHOOK_URL || '',

    SESSION_DIR: 'sessions',

    LOG_DIR: 'logs',

    NODE_ENV: process.env.NODE_ENV || 'development'

};
