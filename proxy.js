const httpProxy = require('http-proxy');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const dotenv    = require('dotenv');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local';
dotenv.config({ path: path.resolve(__dirname, envFile) });

const TARGET_PORT = process.env.PORT       || 5500;
const LOCAL_IP    = process.env.LOCAL_IP   || '127.0.0.1';
const DOMAIN      = process.env.LOCAL_DOMAIN || 'localhost';

const sslOptions = {
  key:  fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};

// ── HTTPS Proxy (port 443) → Express app (port 5500) ──────
const proxy = httpProxy.createProxyServer({
  target: `https://127.0.0.1:${TARGET_PORT}`,
  ssl:    sslOptions,
  secure: false, // self-signed cert on target — skip verification
});

proxy.on('error', (err, req, res) => {
  console.error('❌ Proxy error:', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
  }
});

https.createServer(sslOptions, (req, res) => {
  proxy.web(req, res);
}).listen(443, '0.0.0.0', () => {
  console.log(`🔒 HTTPS proxy  → https://${DOMAIN}`);
  console.log(`   Forwarding   → https://127.0.0.1:${TARGET_PORT}`);
  console.log(`   Also at      → https://${LOCAL_IP}`);
});

// ── HTTP Redirect (port 80) → HTTPS ───────────────────────
http.createServer((req, res) => {
  const host = req.headers.host?.replace(/:80$/, '') || DOMAIN;
  res.writeHead(301, {
    Location: `https://${host}${req.url}`
  });
  res.end();
}).listen(80, '0.0.0.0', () => {
  console.log(`↪  HTTP redirect → http://${DOMAIN} redirects to https://`);
});