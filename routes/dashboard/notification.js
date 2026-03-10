const express    = require('express');
const router     = express.Router();
const verifyToken = require('../../middware/authentication');
const redisManager = require('../../config/redis');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const MAX_NOTIFICATIONS = 100;
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
function redisKey(userId, dbName) {
  return `notifications:${dbName}:${userId}`;
}

// ─────────────────────────────────────────────
// GET /  — fetch notifications for current user
// ─────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  const { user_id: userId, current_class: dbName } = req;
  const client = redisManager.client;

  if (!redisManager.isConnected || !client) {
    return res.status(503).json({
      success: false,
      error: 'Notification service temporarily unavailable',
    });
  }

  try {
    const key  = redisKey(userId, dbName);
    const raw  = await client.lRange(key, 0, MAX_NOTIFICATIONS - 1);

    const notifications = raw
      .map(item => JSON.parse(item))
      .sort((a, b) => b.timestamp - a.timestamp) // newest first
      .slice(0, 50);                              // return top 50

    res.json({ success: true, notifications });
  } catch (error) {
    console.error('Failed to read notifications from Redis:', error);
    res.status(500).json({ success: false, error: 'Failed to load notifications' });
  }
});

// ─────────────────────────────────────────────
// DELETE /delete  — clear ALL notifications
// ─────────────────────────────────────────────
router.delete('/delete', verifyToken, async (req, res) => {
  const { user_id: userId, current_class: dbName } = req;
  const client = redisManager.client;

  if (!redisManager.isConnected || !client) {
    return res.status(503).json({ success: false });
  }

  try {
    await client.del(redisKey(userId, dbName));
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to clear notifications:', error);
    res.status(500).json({ success: false });
  }
});

// ─────────────────────────────────────────────
// DELETE /delete/:notificationId  — remove one notification
// ─────────────────────────────────────────────
router.delete('/delete/:notificationId', verifyToken, async (req, res) => {
  const { user_id: userId, current_class: dbName } = req;
  const { notificationId } = req.params;
  const client = redisManager.client;

  if (!redisManager.isConnected || !client) {
    return res.status(503).json({ success: false });
  }

  try {
    const key  = redisKey(userId, dbName);
    const raw  = await client.lRange(key, 0, MAX_NOTIFICATIONS - 1);

    const notifications   = raw.map(item => JSON.parse(item));
    const initialLength   = notifications.length;
    const updated         = notifications.filter(n => n.id.toString() !== notificationId.toString());

    if (updated.length === initialLength) {
      return res.status(404).json({
        success: false,
        error: `Notification ${notificationId} not found`,
      });
    }

    // Rewrite list with the item removed
    await client.del(key);
    if (updated.length > 0) {
      await client.rPush(key, ...updated.map(n => JSON.stringify(n)));
      await client.expire(key, TTL_SECONDS);
    }

    res.json({
      success: true,
      deletedCount: initialLength - updated.length,
    });
  } catch (error) {
    console.error('Failed to delete single notification:', error);
    res.status(500).json({ success: false, error: 'Failed to delete notification' });
  }
});

module.exports = router;