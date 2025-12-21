/**
 * Bearer token authentication
 */

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);

  if (token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  next();
}

function authenticateWs(token) {
  return token === process.env.API_TOKEN;
}

module.exports = { authenticate, authenticateWs };
