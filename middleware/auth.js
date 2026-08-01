// Auth middleware placeholder

function authMiddleware(req, res, next) {
    const secret = req.header('X-Bridge-Secret');

    if (!process.env.BRIDGE_SECRET) {
        return next();
    }

    if (secret !== process.env.BRIDGE_SECRET) {
        return res.status(401).json({
            error: 'Unauthorized'
        });
    }

    next();
}

module.exports = authMiddleware;