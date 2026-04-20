# Nigerian Navy Payroll Management System

> A full-stack payroll management platform for the Nigerian Navy, handling multi-class payroll processing, salary computations, tax calculations, pension management, and comprehensive reporting.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Scripts](#scripts)
- [Deployment](#deployment)
- [Performance & Capacity](#performance--capacity)
- [Known Bottlenecks](#known-bottlenecks)
- [Security](#security)
- [Changelog](#changelog)

---

## Overview

The Nigerian Navy Payroll Management System is a centralised, database-driven platform that automates the complete payroll lifecycle — from personnel onboarding through monthly processing, report generation, and bank payment file export. It supports multiple payroll classes (Officers, Warrant Officers, Senior NCOs, Ratings, Civilians) each backed by its own database, with a unified frontend SPA for all user roles.

Designed for up to **250 concurrent operators** with room to scale. Test system currently deployed on cPanel shared hosting with PM2 cluster mode (4 instances). Full deployment on Local Server.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express 5 |
| Primary Database | MySQL 8 (mysql2) |
| Secondary Database | Microsoft SQL Server (mssql adapter) |
| Authentication | JWT (jsonwebtoken) |
| PDF Generation | Puppeteer / Chromium + jsreport fallback |
| Frontend | Vanilla JS SPA — Over 84 dynamically loaded HTML sections |
| Styling | Tailwind CSS v3 (self-hosted static build, 56KB) ||
| Hosting | Local server (Windows) | 
| Hosting Setup | Shelll Script |

---

## Features

- **Multi-payroll-class management** — each payroll class isolated in its own database
- **Full monthly and yearly processing cycle** — open/close periods, carry-forwards
- **Salary scale management** — automatic grade progression
- **Variable payments and deductions** — one-off and recurring
- **Pension Fund Administrator (PFA) management**
- **Tax computation** — with state-level breakdowns and PAYE tables
- **Bank payment file generation** — per-bank payment listings
- **IPPIS integration** — government payment validation
- **Comprehensive reports** — pay slips, payroll register, salary summary, control sheet, reconciliation, ...
- **Role-based access control** — granular per-menu permissions
- **Database backup and restore** — full SQL dump via the UI
- **Real-time notifications** — json file based
- **Audit trail** — all system actions recorded

---

## Architecture

### Multi-Database Setup

Each payroll class maps to its own MySQL database. A custom pool manager using `AsyncLocalStorage` handles per-request DB context switching automatically.

```
*********a    → Officers
**********1   → Warrant Officers
**********2   → Rate A
**********3   → Rate B
**********4   → Rate C
**********5   → Trainees
```

Master/reference tables (salary scales, banks, personnel, etc.) live in `********a` and are automatically prefixed when queries run in other class contexts.

### Request Flow

```
Browser → JWT Auth middleware
       → Payroll class resolution (AsyncLocalStorage)
       → Route handler (DB context auto-set)
       → Response
       → Notification interceptor (Json)
```

### Frontend SPA

The frontend is a vanilla JS SPA. `NavigationSystem` in `navigation.js` fetches HTML section fragments from `public/sections/` and injects them into the `<main>` element on navigation. Inline scripts are isolated in IIFEs to prevent variable conflicts across sections.

### Directory Structure

```
├── server.js                  # Entry point — dotenv must load here FIRST
├── config/
│   ├── db.js                  # Multi-DB pool with AsyncLocalStorage
│   ├── redis.js               # RedisTokenManager singleton
│   ├── sockets.js             # Socket.IO service
│   └── db-config.js           # DB connection config
├── middware/
│   ├── authentication.js      # JWT verify + DB context middleware
│   ├── notifications.js       # Response interceptor
│   └── attachPayrollClass.js
├── routes/                    # Express routers by domain
│   ├── administration/
│   ├── dashboard/
│   ├── payroll-calculations/
│   ├── reports/
│   └── ...
├── controllers/               # Business logic (reports, calculations)
├── services/
│   └── helpers/
│       └── historicalReportWrapper.js  # SQL interceptor for historical reports
├── public/
│   ├── sections/              # 84 SPA section HTML fragments
│   ├── script/
│   │   ├── auth.js            # AuthService — login, logout, token refresh
│   │   ├── navigation.js      # NavigationSystem — SPA routing
│   │   └── dashboard.js       # Sidebar + Tailwind config
│   └── styles/
│       ├── dashboard.css      # Custom CSS
│       └── output.css         # Compiled Tailwind (generated — do not edit)
└── tailwind.config.js
```

---

## Getting Started

### Prerequisites

- Node.js v18+
- MySQL 8+
- JS Report
- npm v8+

### Installation

```bash
# Clone the repo
git clone https://github.com/hicadsystems/NAVY-PAYROLL.git
cd NAVY-PAYROLL

# Install dependencies
npm install

# Build Tailwind CSS
npm run build:css

# Create environment file
cp .env.example .env.local  # then fill in your values

# Start development server
npm run dev
```

### Development Workflow

Run these in two separate terminals:

```bash
# Terminal 1 — backend with auto-restart
npm run dev

# Terminal 2 — CSS rebuild on changes
npm run watch:css
```

---

## Environment Variables

Create `.env.local` for development and `.env.production` for production in the project root.

> ⚠️ **Critical:** `dotenv.config()` must be called at the very top of `server.js` before any `require()` calls. Modules like `redis.js` and `db.js` read `process.env` at load time.

```env
# ── App ──────────────────────────────────────
NODE_ENV=development
PORT=5500

# ── JWT ──────────────────────────────────────
JWT_SECRET=your_long_random_secret_here
JWT_REFRESH_SECRET=another_long_random_secret

# ── MySQL ────────────────────────────────────
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_OFFICERS=********a

# ── Redis ────────────────────────────────────
REDIS_ENABLED=false              # set true when Redis is running
REDIS_HOST=127.0.0.1             # always use 127.0.0.1, NOT localhost (IPv6 issue on Windows)
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_SOCKET=                    # cPanel only: /home/username/tmp/redis.sock

# ── Session ──────────────────────────────────
SESSION_SECRET=your_session_secret
```

### Redis on cPanel

cPanel hosting provides Redis via a Unix socket rather than TCP:

1. Go to **cPanel → Redis → ON → Submit**
2. Copy the socket path shown (e.g. `/home/hicadng/tmp/redis.sock`)
3. Set in `.env.production`:
```env
REDIS_ENABLED=true
REDIS_SOCKET=/home/hicadng/tmp/redis.sock
REDIS_HOST=
REDIS_PORT=
```

---

## Scripts

```bash
npm start              # Production server (node server.js)
npm run dev            # Development server (nodemon)
npm run build:css      # Build and minify Tailwind CSS → public/styles/output.css
npm run watch:css      # Watch and rebuild CSS on changes
npm run migrate:make   # Create a new DB migration
npm run migrate:up     # Run pending migrations
npm run migrate:down   # Rollback last migration
npm run migrate:status # Show migration status
```

---

## Deployment

### -- Local Server Deployment --

1. Clone the repo:
   ```bash
   git clone https://github.com/hicadsystems/NAVY-PAYROLL.git
   ```
   
2. Create a Projects folder in `C:/` and extract into it.

3. using powershell: 
   ```bash
   cd C:/Projects/NAVY-PAYROLL
   ```

4. Install dependencies: 
   Ensure you have already installed the prerequisites needed into your system as listed above
   ```bash
   npm install
   ```

5. Set up both `.env.local` and `.env.production` then Run;
   ```bash
   .\setup.bat.
   ```


### -- cPanel Deployment --

1. Build CSS locally before zipping:
   ```bash
   npm run build:css
   ```

2. Zip the project — **exclude** the following:
   ```
   node_modules/
   .env.local
   .env.production
   ```

3. Upload and extract via cPanel File Manager.

4. Create `.env.production` directly on the server via File Manager.

5. Install production dependencies:
   ```bash
   npm install --production
   ```

6. Start with PM2 if cPanel:
   ```bash
   pm2 start server.js -i 4 --name navy-payroll
   pm2 save
   pm2 startup
   ```

### PM2 Commands if cPanel

```bash
pm2 logs navy-payroll            # Live logs
pm2 monit                        # Real-time CPU/RAM monitor
pm2 reload navy-payroll          # Zero-downtime reload (use for deployments)
pm2 restart navy-payroll         # Hard restart all instances
pm2 stop navy-payroll            # Stop
```

> Use `pm2 reload` for deployments — restarts instances one at a time so users are never without a server.

---

## Performance & Capacity

Current production configuration:

| Metric | Value |
|---|---|
| RAM per instance | ~48MB |
| Total RAM used | ~200MB |
| Target concurrent users | 250 operators |
| Hardware | Core i7 12th gen / 32GB DDR4 |

The hardware significantly exceeds the requirements for 250 concurrent users. The primary bottleneck at scale is MySQL query performance on large datasets, not Node.js throughput.

---

## Known Bottlenecks

Issues to address as the system and dataset grow:

| Priority | Bottleneck | Impact | Recommended Fix |
|---|---|---|---|
| 🔴 High | **Puppeteer PDF generation** | Each PDF request spawns a full Chromium instance — unbounded concurrency will exhaust RAM | Implement a PDF queue with max 3–4 concurrent Chromium instances |
| 🟡 Medium | **Heavy report queries** | Some report endpoints fetch entire datasets without pagination | Add server-side pagination and date range limits to large queries |
| 🟠 Monitor | **MySQL connection pool** |Each db connection instance has its own pool — simultaneous saturation possible under heavy load | Cap `connectionLimit: 10` per instance in `db.js` |
| 🟢 Future | **MySQL read replica** | Report queries compete with write operations on the same DB instance | Route report queries to a read replica |

---

## Security

### Current Implementation
- JWT authentication with access + refresh token pattern
- Token blacklisting in Redis on logout
- Role-based access control with per-menu permissions
- Login rate limiting — 10 attempts per 15 minutes per IP
- HTTP security headers via Helmet (CSP, HSTS, XSS protection)
- SRI hashes on all CDN resources
- Request body size limit — 1MB global, 200MB on backup/restore routes only
- `eval()` removed from frontend script loading

---

## Changelog

### v1.0.0 — March 2026

**Security**
- Fixed dotenv load order — env vars guaranteed available before any module reads them
- Redis `REDIS_ENABLED` guard moved to constructor — eliminates module-level timing issue
- Replaced `eval()` in `NavigationSystem` with IIFE-wrapped script injection
- Added login rate limiting (express-rate-limit)
- Choices.js, Box-Icons and Font Awesome CDN resources now fully offline
- Reduced global request body limit from 50MB to 1MB
- Added Content Security Policy via Helmet

**Performance**
- Self-hosted Tailwind CSS — 56KB static file replaces 400KB Play CDN runtime
- Fixed main content wrapper transition lag on sidebar toggle


---

*Developed and maintained by [HICAD Systems](https://github.com/hicadsystems)*