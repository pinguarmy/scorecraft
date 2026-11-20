import type { RequestHandler } from 'express';

/** The development front end (Vite) runs on this port and proxies /api to the local server. */
const DEV_SERVER_PORT = '4380';

export function loopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

/**
 * First middleware on every request: baseline security headers, then the loopback-only Host check
 * (DNS rebinding) and, for /api, the Origin / Sec-Fetch-Site check that keeps other websites from
 * driving the local service. API responses are never cached.
 */
export function requestGuard(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    let host: URL;
    try {
      host = new URL(`http://${req.headers.host ?? ''}`);
    } catch {
      res.status(403).json({ message: '仅允许本机访问。' });
      return;
    }
    if (!loopback(host.hostname)) {
      res.status(403).json({ message: '仅允许本机访问。' });
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          const parsed = new URL(origin);
          allowed = parsed.protocol === 'http:'
            && loopback(parsed.hostname)
            && (parsed.host === host.host || parsed.port === DEV_SERVER_PORT);
        } catch {
          /* reject malformed origin */
        }
        if (!allowed) {
          res.status(403).json({ message: '拒绝其他网站访问本机识谱服务。' });
          return;
        }
      } else if (req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ message: '拒绝跨站请求。' });
        return;
      }
    }
    next();
  };
}
