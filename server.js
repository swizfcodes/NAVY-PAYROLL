const path   = require('path');
const dotenv = require('dotenv');
const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: path.resolve(__dirname, envFile) });
const { notificationMiddleware } = require('./middware/notifications');
const seamlessWrapper = require('./services/helpers/historicalReportWrapper');
const express = require('express');
const app = express();
const session = require('express-session');
const serveIndex = require('serve-index');
const pool = require('./config/db'); 
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const https = require('https');
//const jsreport = require('jsreport-core')();
//const multer = require("multer");
const PORT = process.env.PORT || 5500;



// Load env variables
//dotenv.config({ path: path.resolve(__dirname, envFile) });
console.log('Running in', process.env.NODE_ENV);



// security headers & logging
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdn.jsdelivr.net/npm/choices.js/public/assets/scripts/choices.min.js",
        "'unsafe-inline'",
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],   // ← allows blob: images
      frameSrc: ["'self'", "blob:", "data:"],           // ← allows blob: iframes
    },
  })
);

app.use(morgan('dev'));



// CORS appears before session middleware if cookies are used cross-origin
const corsOptions = {
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://hicad.ng',// production
  ].filter(Boolean),
  methods: ['GET','POST','PUT','DELETE'],
  credentials: true
};
app.use(cors(corsOptions));



// trust proxy when behind load balancer (set in env when needed)
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// built-in body parsers (remove body-parser dependency)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// session config (use env values in production)
app.use(session({
  secret: process.env.JWT_SECRET || 'super-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true on HTTPS
    sameSite: process.env.COOKIE_SAMESITE || 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(notificationMiddleware);

// Configuration via environment variable
// Usage: SERVER_MODE=localhost node server.js
const SERVER_MODE = process.env.SERVER_MODE || 'auto'; // Default to 'auto'

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

async function startServer() {
  await seamlessWrapper.initialize();

  // mount routes
  require('./routes')(app);

  const LOCAL_IP = process.env.LOCAL_IP || '127.0.0.1';
  const LOCAL_DOMAIN = process.env.LOCAL_DOMAIN || 'localhost';

  const options = {
    key: fs.readFileSync(path.join(__dirname, 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
  };

  switch (SERVER_MODE) {
    case 'network':
      https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
        console.log(`🔒 HTTPS server running on https://${LOCAL_IP}`);
        console.log(`🌐 LAN domain: https://${LOCAL_DOMAIN}`);
      });
      break;

    case "localhost":
      app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
      });
      break;

    case 'auto':
    default:
      const server = https.createServer(options, app);

      server.listen(PORT, '0.0.0.0', () => {
        console.log(`🔒 HTTPS server running on https://${LOCAL_IP}`);
        console.log(`🌐 LAN domain: https://${LOCAL_DOMAIN}`);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE') {
          console.warn('⚠️  Network interface unavailable, falling back to localhost');
          
          const fallbackServer = app
          
          fallbackServer.listen(PORT, 'localhost', () => {
            console.log(`🔒 HTTPS server running on http://localhost:${PORT}`);
          });

          fallbackServer.on('error', (fallbackErr) => {
            console.error('❌ Failed to start fallback server:', fallbackErr);
            process.exit(1);
          });
        } else {
          console.error('❌ Server error:', err);
          process.exit(1);
        }
      });
      break;
  }
}

// static files and directory listing
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', serveIndex(path.join(__dirname, 'public'), { icons: true }));

startServer().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

// small helper to expose credentials header for some clients
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

// centralized error handler
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  res.status(500).json({ error: 'Internal Server Error' });
});
