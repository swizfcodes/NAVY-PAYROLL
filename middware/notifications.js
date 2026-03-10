const redisManager = require('../config/redis');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const MAX_NOTIFICATIONS = 100;         // max stored per user per class
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Redis list key — one list per user per payroll class */
function redisKey(userId, dbName) {
  return `notifications:${dbName}:${userId}`;
}

/**
 * Save a notification to Redis.
 * - Deduplicates messages that occur within 60 seconds (increments count).
 * - Keeps only the latest MAX_NOTIFICATIONS entries.
 * - Sets a rolling 30-day TTL on the list.
 */
async function saveNotificationToRedis(userId, dbName, type, message, method, url) {
  try {
    const client = redisManager.client;

    if (!redisManager.isConnected || !client) {
      console.warn('⚠️  Redis not connected — notification not saved');
      return;
    }

    const key = redisKey(userId, dbName);
    const now = Date.now();

    // ── Read existing list ──────────────────────────────────
    const raw = await client.lRange(key, 0, MAX_NOTIFICATIONS - 1);
    const notifications = raw.map(item => JSON.parse(item));

    // ── Dedup: same message within the last 60 s ────────────
    const dupIndex = notifications.findIndex(
      n => n.message === message && (now - n.timestamp) < 60_000
    );

    if (dupIndex !== -1) {
      // Update existing entry in place
      notifications[dupIndex].count     = (notifications[dupIndex].count || 1) + 1;
      notifications[dupIndex].timestamp = now;

      // Rewrite the whole list (list is small, ≤100 items)
      await client.del(key);
      if (notifications.length > 0) {
        await client.rPush(key, ...notifications.map(n => JSON.stringify(n)));
      }
    } else {
      // Prepend new notification
      const notification = {
        id:        `notif-${now}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        message,
        method,
        url,
        timestamp: now,
        count:     1,
      };

      await client.lPush(key, JSON.stringify(notification));

      // Trim to max length
      await client.lTrim(key, 0, MAX_NOTIFICATIONS - 1);
    }

    // Rolling TTL — reset on every write
    await client.expire(key, TTL_SECONDS);

  } catch (error) {
    // Never let notification errors bubble up and affect the response
    console.error('❌ Failed to save notification to Redis:', error.message);
  }
}

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

/**
 * Intercepts res.json() on POST / PUT / DELETE requests.
 * If the response body contains a `message` field and the request
 * is authenticated (req.user_id + req.current_class present),
 * a notification is saved asynchronously — the response is never blocked.
 */
function notificationMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (data) {
    const method = req.method;

    if (
      ['POST', 'PUT', 'DELETE'].includes(method) &&
      data?.message &&
      req.user_id &&
      req.current_class
    ) {
      let type = 'info';
      if (res.statusCode >= 200 && res.statusCode < 300) type = 'success';
      else if (res.statusCode >= 400 && res.statusCode < 500) type = 'warning';
      else if (res.statusCode >= 500) type = 'error';

      const url = req.originalUrl || req.url;

      // Fire-and-forget — never blocks the HTTP response
      setImmediate(() => {
        saveNotificationToRedis(
          req.user_id,
          req.current_class,
          type,
          data.message,
          method,
          url
        );
      });
    }

    return originalJson(data);
  };

  next();
}

module.exports = { notificationMiddleware };