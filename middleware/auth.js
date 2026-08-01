// Auth middleware placeholder
module.exports = (req, res, next) => next();

function authMiddleware(req, res, next) {
    if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
        return res.status(403).json({ error: 'Invalid bridge secret' });
    }
    next();
}
