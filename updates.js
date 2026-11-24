const express = require('express');
const { pool, uid } = require('../db');
const { requireAuth, isPrivilegedRole } = require('../auth');

module.exports = function createUpdatesRouter(broadcastEvent) {
  const router = express.Router();

  router.post('/', requireAuth, async (req, res, next) => {
    const client = await pool.connect();
    try {
      const title = String(req.body.title || '').trim();
      const cat = String(req.body.cat || '').trim();
      const aud = String(req.body.aud || 'All Users').trim() || 'All Users';
      const dept = String(req.body.dept || '').trim();
      const desc = String(req.body.desc || '').trim();

      if (!title || !cat || !desc) {
        return res.status(400).json({ error: 'Title, category, and description are required.' });
      }

      const id = uid();
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO updates (id, lab_id, title, category, audience, department, description, author_id, author_name, author_role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [id, req.user.lab_id, title, cat, aud, dept, desc, req.user.id, req.user.name, req.user.role || '']
      );
      await client.query(
        'INSERT INTO update_reads (update_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, req.user.id]
      );
      await client.query('COMMIT');

      broadcastEvent('update_published', { id, authorId: req.user.id, labId: req.user.lab_id });
      res.status(201).json({ id });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  });

  router.put('/:id', requireAuth, async (req, res, next) => {
    try {
      const title = String(req.body.title || '').trim();
      const cat = String(req.body.cat || '').trim();
      const aud = String(req.body.aud || 'All Users').trim();
      const dept = String(req.body.dept || '').trim();
      const desc = String(req.body.desc || '').trim();

      if (!title || !cat || !desc) {
        return res.status(400).json({ error: 'Title, category, and description are required.' });
      }

      const existing = await pool.query('SELECT author_id FROM updates WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Update not found.' });
      if (existing.rows[0].author_id && existing.rows[0].author_id !== req.user.id && !isPrivilegedRole(req.user.role)) {
        return res.status(403).json({ error: 'Only the author or Lab Staff/Admin can edit this update.' });
      }
      await pool.query(
        'UPDATE updates SET title = $1, category = $2, audience = $3, department = $4, description = $5 WHERE id = $6 AND lab_id = $7',
        [title, cat, aud, dept, desc, req.params.id, req.user.lab_id]
      );

      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requireAuth, async (req, res, next) => {
    try {
      const existing = await pool.query('SELECT author_id FROM updates WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Update not found.' });
      if (existing.rows[0].author_id && existing.rows[0].author_id !== req.user.id && !isPrivilegedRole(req.user.role)) {
        return res.status(403).json({ error: 'Only the author or Lab Staff/Admin can delete this update.' });
      }
      await pool.query('DELETE FROM updates WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/pin', requireAuth, async (req, res, next) => {
    try {
      await pool.query('UPDATE updates SET pinned = NOT pinned WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/read', requireAuth, async (req, res, next) => {
    try {
      const read = Boolean(req.body.read);
      if (read) {
        await pool.query(
          'INSERT INTO update_reads (update_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.params.id, req.user.id]
        );
      } else {
        await pool.query('DELETE FROM update_reads WHERE update_id = $1 AND user_id = $2', [
          req.params.id,
          req.user.id
        ]);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/ack', requireAuth, async (req, res, next) => {
    try {
      const existing = await pool.query(
        'SELECT 1 FROM update_acknowledgements WHERE update_id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      );
      if (existing.rows.length) {
        await pool.query('DELETE FROM update_acknowledgements WHERE update_id = $1 AND user_id = $2', [
          req.params.id,
          req.user.id
        ]);
      } else {
        await pool.query(
          'INSERT INTO update_acknowledgements (update_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.params.id, req.user.id]
        );
      }
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/react', requireAuth, async (req, res, next) => {
    try {
      const emoji = String(req.body.emoji || '').trim();
      if (!emoji) return res.status(400).json({ error: 'Emoji is required.' });

      const existing = await pool.query(
        'SELECT 1 FROM update_reactions WHERE update_id = $1 AND user_id = $2 AND emoji = $3',
        [req.params.id, req.user.id, emoji]
      );
      if (existing.rows.length) {
        await pool.query(
          'DELETE FROM update_reactions WHERE update_id = $1 AND user_id = $2 AND emoji = $3',
          [req.params.id, req.user.id, emoji]
        );
      } else {
        await pool.query(
          'INSERT INTO update_reactions (update_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [req.params.id, req.user.id, emoji]
        );
      }
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/comments', requireAuth, async (req, res, next) => {
    try {
      const body = String(req.body.t || '').trim();
      const kind = req.body.kind === 'Query' ? 'Query' : 'Comment';
      const parentId = req.body.parentId ? String(req.body.parentId).trim() : null;

      if (!body) return res.status(400).json({ error: 'Message text is required.' });

      const cid = uid();
      await pool.query(
        'INSERT INTO update_comments (id, update_id, parent_id, author_id, author_name, author_role, kind, resolved, body, display_time) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9)',
        [
          cid,
          req.params.id,
          parentId,
          req.user.id,
          req.user.name,
          req.user.role || '',
          kind,
          body,
          new Date().toLocaleString()
        ]
      );
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.status(201).json({ id: cid });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/comments/:cid', requireAuth, async (req, res, next) => {
    try {
      if (typeof req.body.t === 'string') {
        const text = req.body.t.trim();
        if (!text) return res.status(400).json({ error: 'Message cannot be empty.' });
        await pool.query('UPDATE update_comments SET body = $1 WHERE id = $2 AND update_id = $3', [
          text,
          req.params.cid,
          req.params.id
        ]);
      }
      if (typeof req.body.toggleResolve === 'boolean' && req.body.toggleResolve) {
        await pool.query(
          'UPDATE update_comments SET resolved = NOT resolved WHERE id = $1 AND update_id = $2',
          [req.params.cid, req.params.id]
        );
      }
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id/comments/:cid', requireAuth, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM update_comments WHERE id = $1 AND update_id = $2', [
        req.params.cid,
        req.params.id
      ]);
      broadcastEvent('update_changed', { id: req.params.id, labId: req.user.lab_id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
