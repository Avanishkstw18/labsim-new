const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, buildUserState } = require('../db');
const { normalizeRole, signToken, requireAuth } = require('../auth');

const router = express.Router();

// Create a brand new Lab + first Admin / Lab In-Charge member
router.post('/create-lab', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const labName = String(req.body.labName || '').trim();
    const labUsername = String(req.body.labUsername || '').trim().toLowerCase();
    const labPassword = String(req.body.labPassword || '');
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = normalizeRole(req.body.role || 'Admin / Lab In-Charge');

    if (!labName || !labUsername || !labPassword || !name || !email || !password) {
      return res.status(400).json({ error: 'All lab and member fields are required.' });
    }
    if (!/^[a-z0-9_-]{3,32}$/.test(labUsername)) {
      return res.status(400).json({ error: 'Lab Username must be 3-32 characters (letters, numbers, _ or -).' });
    }
    if (labPassword.length < 4) {
      return res.status(400).json({ error: 'Lab Password must be at least 4 characters.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Personal password must be at least 6 characters.' });
    }

    await client.query('BEGIN');
    const labExists = await client.query('SELECT id FROM labs WHERE lab_username = $1', [labUsername]);
    if (labExists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Lab Username is already taken. Choose another or join it.' });
    }

    const userExists = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userExists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const labPassHash = await bcrypt.hash(labPassword, 10);
    const labRes = await client.query(
      'INSERT INTO labs (lab_username, lab_password_hash, lab_name) VALUES ($1, $2, $3) RETURNING id, lab_username, lab_name',
      [labUsername, labPassHash, labName]
    );
    const lab = labRes.rows[0];

    const userPassHash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      'INSERT INTO users (lab_id, lab_username, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, lab_id, lab_username, email, name, role',
      [lab.id, lab.lab_username, email, userPassHash, name, role]
    );
    await client.query('COMMIT');

    const user = { ...userRes.rows[0], lab_name: lab.lab_name };
    const token = signToken(user);
    const state = await buildUserState(user.id);
    res.status(201).json({ token, user, state });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Register a new member into an existing Lab using that Lab's Username & Password
router.post('/register', async (req, res, next) => {
  try {
    const labUsername = String(req.body.labUsername || '').trim().toLowerCase();
    const labPassword = String(req.body.labPassword || '');
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const role = normalizeRole(req.body.role);

    if (!labUsername || !labPassword || !name || !email || !password) {
      return res.status(400).json({ error: 'Lab Username, Lab Password, name, email, and password are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const labRes = await pool.query('SELECT id, lab_username, lab_name, lab_password_hash FROM labs WHERE lab_username = $1', [labUsername]);
    if (!labRes.rows.length) {
      return res.status(404).json({ error: 'Lab Username not found. Create a new lab first or check spelling.' });
    }
    const lab = labRes.rows[0];
    const validLab = await bcrypt.compare(labPassword, lab.lab_password_hash);
    if (!validLab) {
      return res.status(403).json({ error: 'Incorrect Lab Password for this lab.' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (lab_id, lab_username, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, lab_id, lab_username, email, name, role',
      [lab.id, lab.lab_username, email, passwordHash, name, role]
    );
    const user = { ...rows[0], lab_name: lab.lab_name };
    const token = signToken(user);
    const state = await buildUserState(user.id);
    res.status(201).json({ token, user, state });
  } catch (err) {
    next(err);
  }
});

// Sign in to an existing member account within a Lab
router.post('/login', async (req, res, next) => {
  try {
    const labUsername = String(req.body.labUsername || '').trim().toLowerCase();
    const labPassword = String(req.body.labPassword || '');
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!labUsername || !labPassword || !email || !password) {
      return res.status(400).json({ error: 'Lab Username, Lab Password, email, and password are required.' });
    }

    const labRes = await pool.query('SELECT id, lab_username, lab_name, lab_password_hash FROM labs WHERE lab_username = $1', [labUsername]);
    if (!labRes.rows.length) {
      return res.status(403).json({ error: 'Invalid Lab Username or Lab Password.' });
    }
    const lab = labRes.rows[0];
    const validLab = await bcrypt.compare(labPassword, lab.lab_password_hash);
    if (!validLab) {
      return res.status(403).json({ error: 'Invalid Lab Username or Lab Password.' });
    }

    const { rows } = await pool.query(
      'SELECT id, lab_id, email, name, role, password_hash FROM users WHERE email = $1 AND lab_id = $2',
      [email, lab.id]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'No member with this email found in this lab.' });
    }

    const userRow = rows[0];
    const valid = await bcrypt.compare(password, userRow.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid personal password.' });
    }

    const user = { id: userRow.id, lab_id: lab.id, lab_username: lab.lab_username, lab_name: lab.lab_name, email: userRow.email, name: userRow.name, role: userRow.role };
    const token = signToken(user);
    const state = await buildUserState(user.id);
    res.json({ token, user, state });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

router.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const role = normalizeRole(req.body.role || req.user.role);
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    const { rows } = await pool.query(
      'UPDATE users SET name = $1, role = $2 WHERE id = $3 RETURNING id, lab_id, lab_username, email, name, role',
      [name, role, req.user.id]
    );
    res.json({ user: { ...rows[0], lab_name: req.user.lab_name } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
