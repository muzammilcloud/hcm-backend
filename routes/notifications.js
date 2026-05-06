const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireEmployee } = require('../middleware/auth');

// GET /api/notifications?limit=50
router.get('/notifications', requireEmployee, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT id, type, title, body, link, read_at, created_at
       FROM notifications
       WHERE recipient_user_id = ?
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      [req.portalUserId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/unread-count
router.get('/notifications/unread-count', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM notifications
       WHERE recipient_user_id = ? AND read_at IS NULL`,
      [req.portalUserId]
    );
    res.json({ count: rows[0].c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/:id/read
router.post('/notifications/:id/read', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    await pool.execute(
      `UPDATE notifications SET read_at = NOW()
       WHERE id = ? AND recipient_user_id = ? AND read_at IS NULL`,
      [req.params.id, req.portalUserId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/read-all
router.post('/notifications/read-all', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    await pool.execute(
      `UPDATE notifications SET read_at = NOW()
       WHERE recipient_user_id = ? AND read_at IS NULL`,
      [req.portalUserId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
