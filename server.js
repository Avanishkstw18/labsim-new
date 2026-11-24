require('dotenv').config();
const path = require('path');
const express = require('express');
const { pool, uid, todayISO, initSchema, buildUserState } = require('./db');
const { requireAuth, requireStaffOrAdmin } = require('./auth');
const authRoutes = require('./routes/auth');
const createUpdatesRouter = require('./routes/updates');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Multi-Lab Real-Time SSE Client Registry ---
const sseClients = new Set();

function broadcastEvent(type, payload = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify({ ...payload, ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    if (payload.labId && client.labId !== payload.labId) continue;
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// --- Modular Route Mounting ---
app.use('/api/auth', authRoutes);
app.use('/api/updates', createUpdatesRouter(broadcastEvent));

// --- Real-Time SSE Stream & Full Lab State Sync ---
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user.id, labId: req.user.lab_id })}\n\n`);
  const clientEntry = { res, labId: req.user.lab_id };
  sseClients.add(clientEntry);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(clientEntry);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientEntry);
  });
});

app.get('/api/state', requireAuth, async (req, res, next) => {
  try {
    const state = await buildUserState(req.user.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// DEPARTMENTS & RESOURCES (LAB-SCOPED)
// ============================================================================

app.post('/api/departments', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required.' });
    await pool.query(
      'INSERT INTO departments (lab_id, name, created_by) VALUES ($1, $2, $3) ON CONFLICT (lab_id, name) DO NOTHING',
      [req.user.lab_id, name, req.user.id]
    );
    broadcastEvent('workspace_sync', { entity: 'departments', labId: req.user.lab_id });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/resources', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const type = String(req.body.type || '').trim();
    const cost = Number(req.body.cost);
    const stock = Math.floor(Number(req.body.stock));
    const minStock = Math.max(0, Math.floor(Number(req.body.minStock || 0)));

    if (!name || !type) return res.status(400).json({ error: 'Resource name and type are required.' });
    if (Number.isNaN(cost) || cost < 0 || Number.isNaN(stock) || stock < 0 || Number.isNaN(minStock)) {
      return res.status(400).json({ error: 'Cost, stock, and low-stock threshold cannot be negative.' });
    }

    const id = uid();
    await pool.query(
      'INSERT INTO resources (id, lab_id, name, type, cost, stock, avail, min_stock, created_by) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)',
      [id, req.user.lab_id, name, type, cost, stock, minStock, req.user.id]
    );
    broadcastEvent('workspace_sync', { entity: 'resources', labId: req.user.lab_id });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

app.put('/api/resources/:id', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const type = String(req.body.type || '').trim();
    const cost = Number(req.body.cost);
    const minStock = Math.max(0, Math.floor(Number(req.body.minStock || 0)));

    if (!name || !type) return res.status(400).json({ error: 'Resource name and type are required.' });
    if (Number.isNaN(cost) || cost < 0 || Number.isNaN(minStock)) {
      return res.status(400).json({ error: 'Cost and threshold cannot be negative.' });
    }

    const { rowCount } = await pool.query(
      'UPDATE resources SET name = $1, type = $2, cost = $3, min_stock = $4, updated_at = NOW() WHERE id = $5 AND lab_id = $6',
      [name, type, cost, minStock, req.params.id, req.user.lab_id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Resource not found.' });
    broadcastEvent('workspace_sync', { entity: 'resources', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/resources/:id/restock', requireAuth, async (req, res, next) => {
  try {
    const qty = Math.floor(Number(req.body.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Enter a positive quantity.' });
    }
    const { rowCount } = await pool.query(
      'UPDATE resources SET stock = stock + $1, avail = avail + $1, updated_at = NOW() WHERE id = $2 AND lab_id = $3',
      [qty, req.params.id, req.user.lab_id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Resource not found.' });
    broadcastEvent('workspace_sync', { entity: 'resources', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/resources/:id', requireAuth, requireStaffOrAdmin, async (req, res, next) => {
  try {
    const allocCheck = await pool.query(
      'SELECT 1 FROM workflow_allocations WHERE resource_id = $1 LIMIT 1',
      [req.params.id]
    );
    if (allocCheck.rows.length) {
      return res.status(409).json({ error: 'Cannot delete resource currently allocated to an active workflow.' });
    }
    await pool.query('DELETE FROM resources WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    broadcastEvent('workspace_sync', { entity: 'resources', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// WORKFLOWS, MEMBERS, TASKS & ALLOCATIONS (LAB-SCOPED)
// ============================================================================

app.post('/api/workflows', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || '').trim();
    const purpose = String(req.body.purpose || '').trim();
    const start = String(req.body.start || '').trim();
    const end = String(req.body.end || '').trim();
    const guide = String(req.body.guide || '').trim();

    if (!name || !purpose || !start || !end) {
      return res.status(400).json({ error: 'Name, purpose, start date, and deadline are required.' });
    }
    if (end < start) {
      return res.status(400).json({ error: 'Deadline must be after start date.' });
    }

    const id = uid();
    const status = start > todayISO() ? 'Upcoming' : 'Ongoing';
    const upd = todayISO();

    await client.query('BEGIN');
    await client.query(
      'INSERT INTO workflows (id, lab_id, name, purpose, start_date, end_date, guide, status, upd, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, req.user.lab_id, name, purpose, start, end, guide, status, upd, req.user.id]
    );
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [id, `Workflow created by ${req.user.name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');

    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.status(201).json({ id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.patch('/api/workflows/:id/status', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const status = String(req.body.status || '').trim();
    if (!['Ongoing', 'Upcoming', 'Completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid workflow status.' });
    }
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'UPDATE workflows SET status = $1, upd = $2 WHERE id = $3 AND lab_id = $4',
      [status, todayISO(), req.params.id, req.user.lab_id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Workflow not found.' });
    }
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Marked ${status} by ${req.user.name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/workflows/:id', requireAuth, requireStaffOrAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wfCheck = await client.query('SELECT 1 FROM workflows WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    if (!wfCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Workflow not found.' });
    }
    const allocs = await client.query(
      'SELECT resource_id, qty FROM workflow_allocations WHERE workflow_id = $1',
      [req.params.id]
    );
    for (const a of allocs.rows) {
      await client.query(
        'UPDATE resources SET avail = LEAST(stock, avail + $1), updated_at = NOW() WHERE id = $2 AND lab_id = $3',
        [a.qty, a.resource_id, req.user.lab_id]
      );
    }
    await client.query('DELETE FROM workflows WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.post('/api/workflows/:id/members', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || '').trim();
    const role = String(req.body.role || '').trim();
    if (!name || !role) return res.status(400).json({ error: 'Member name and role are required.' });

    const mid = uid();
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO workflow_members (id, workflow_id, name, role) VALUES ($1, $2, $3, $4)',
      [mid, req.params.id, name, role]
    );
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Added member ${name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.status(201).json({ id: mid });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/workflows/:id/members/:mid', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM workflow_members WHERE id = $1 AND workflow_id = $2', [
      req.params.mid,
      req.params.id
    ]);
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, 'Removed member', new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.post('/api/workflows/:id/tasks', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || '').trim();
    const to = String(req.body.to || '').trim();
    const due = String(req.body.due || '').trim();
    if (!name || !due) return res.status(400).json({ error: 'Task name and due date are required.' });

    const tid = uid();
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO workflow_tasks (id, workflow_id, name, assigned_to, due_date, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [tid, req.params.id, name, to, due, 'Pending']
    );
    await client.query('UPDATE workflows SET upd = $1 WHERE id = $2 AND lab_id = $3', [todayISO(), req.params.id, req.user.lab_id]);
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Created task ${name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.status(201).json({ id: tid });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.post('/api/workflows/:id/tasks/:tid/advance', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT name, status FROM workflow_tasks WHERE id = $1 AND workflow_id = $2',
      [req.params.tid, req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found.' });
    }
    const nextStatus = { Pending: 'Ongoing', Ongoing: 'Done', Done: 'Pending' }[rows[0].status] || 'Ongoing';
    await client.query('UPDATE workflow_tasks SET status = $1 WHERE id = $2', [nextStatus, req.params.tid]);
    await client.query('UPDATE workflows SET upd = $1 WHERE id = $2 AND lab_id = $3', [todayISO(), req.params.id, req.user.lab_id]);
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Task "${rows[0].name}" → ${nextStatus}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/workflows/:id/tasks/:tid', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM workflow_tasks WHERE id = $1 AND workflow_id = $2', [
      req.params.tid,
      req.params.id
    ]);
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, 'Removed task', new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.post('/api/workflows/:id/allocations', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const resourceId = String(req.body.res || '').trim();
    const qty = Math.floor(Number(req.body.qty));
    const taskName = String(req.body.task || '').trim();
    const explicitCat = String(req.body.cat || '').trim();

    if (!resourceId || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Valid resource and positive quantity are required.' });
    }

    await client.query('BEGIN');
    const rRes = await client.query(
      'SELECT id, name, type, avail FROM resources WHERE id = $1 AND lab_id = $2 FOR UPDATE',
      [resourceId, req.user.lab_id]
    );
    if (!rRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Resource not found.' });
    }
    const resource = rRes.rows[0];
    if (qty > Number(resource.avail)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Quantity must be 1 to ${resource.avail}` });
    }

    const category =
      explicitCat ||
      (resource.type === 'Equipment'
        ? 'Equipment'
        : resource.type === 'Personnel'
        ? 'People'
        : 'Others');

    await client.query('UPDATE resources SET avail = avail - $1, updated_at = NOW() WHERE id = $2', [
      qty,
      resource.id
    ]);
    await client.query(
      'INSERT INTO workflow_allocations (id, workflow_id, resource_id, resource_name, category, qty, task_name) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [uid(), req.params.id, resource.id, resource.name, category, qty, taskName]
    );
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Allocated ${qty} × ${resource.name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/workflows/:id/allocations/:aid', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const aRes = await client.query(
      'SELECT resource_id, resource_name, qty FROM workflow_allocations WHERE id = $1 AND workflow_id = $2 FOR UPDATE',
      [req.params.aid, req.params.id]
    );
    if (!aRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Allocation record not found.' });
    }
    const alloc = aRes.rows[0];
    await client.query(
      'UPDATE resources SET avail = LEAST(stock, avail + $1), updated_at = NOW() WHERE id = $2 AND lab_id = $3',
      [alloc.qty, alloc.resource_id, req.user.lab_id]
    );
    await client.query('DELETE FROM workflow_allocations WHERE id = $1', [req.params.aid]);
    await client.query(
      'INSERT INTO workflow_activities (workflow_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Released ${alloc.qty} × ${alloc.resource_name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'workflows', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ============================================================================
// MAINTENANCE (LAB-SCOPED)
// ============================================================================

app.post('/api/maintenance', requireAuth, async (req, res, next) => {
  try {
    const rid = String(req.body.rid || '').trim();
    const type = String(req.body.type || 'Calibration').trim() || 'Calibration';
    const due = String(req.body.due || '').trim();
    const desc = String(req.body.desc || '').trim();

    if (!rid || !due || !desc) {
      return res.status(400).json({ error: 'Select a resource, due date and description.' });
    }
    const rRes = await pool.query('SELECT name FROM resources WHERE id = $1 AND lab_id = $2', [rid, req.user.lab_id]);
    if (!rRes.rows.length) {
      return res.status(404).json({ error: 'Selected resource not found.' });
    }

    const id = uid();
    await pool.query(
      'INSERT INTO maintenance (id, lab_id, resource_id, eq, task_type, description, due_date, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, req.user.lab_id, rid, rRes.rows[0].name, type, desc, due, 'Scheduled', req.user.id]
    );
    broadcastEvent('workspace_sync', { entity: 'maintenance', labId: req.user.lab_id });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/maintenance/:id/complete', requireAuth, async (req, res, next) => {
  try {
    const notes = String(req.body.notes || '').trim();
    await pool.query(
      "UPDATE maintenance SET status = 'Completed', completed_at = NOW(), completed_by = $1, completion_notes = $2 WHERE id = $3 AND lab_id = $4",
      [req.user.name, notes, req.params.id, req.user.lab_id]
    );
    broadcastEvent('workspace_sync', { entity: 'maintenance', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/maintenance/:id', requireAuth, requireStaffOrAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM maintenance WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    broadcastEvent('workspace_sync', { entity: 'maintenance', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// WASTE MANAGEMENT (LAB-SCOPED)
// ============================================================================

app.post('/api/waste', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const cat = String(req.body.cat || '').trim();
    const qty = Number(req.body.qty);
    const unit = String(req.body.unit || 'kg').trim() || 'kg';

    if (!name || !cat || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Name, category, and positive quantity are required.' });
    }

    const id = uid();
    await pool.query(
      'INSERT INTO waste_records (id, lab_id, name, category, qty, unit, step, cost, record_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8)',
      [id, req.user.lab_id, name, cat, qty, unit, todayISO(), req.user.id]
    );
    broadcastEvent('workspace_sync', { entity: 'waste', labId: req.user.lab_id });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/waste/:id/advance', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT step FROM waste_records WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    if (!rows.length) return res.status(404).json({ error: 'Waste record not found.' });

    const currentStep = Number(rows[0].step);
    if (currentStep >= 3) {
      return res.status(400).json({ error: 'Waste is already disposed.' });
    }

    const nextStep = currentStep + 1;
    let cost = 0;
    if (nextStep === 3) {
      cost = Number(req.body.cost);
      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(400).json({ error: 'Disposal cost cannot be negative.' });
      }
    }

    await pool.query('UPDATE waste_records SET step = $1, cost = $2 WHERE id = $3 AND lab_id = $4', [
      nextStep,
      cost,
      req.params.id,
      req.user.lab_id
    ]);
    broadcastEvent('workspace_sync', { entity: 'waste', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/waste/:id', requireAuth, requireStaffOrAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM waste_records WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    broadcastEvent('workspace_sync', { entity: 'waste', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// CRISIS & RESOLUTION CENTRE (LAB-SCOPED)
// ============================================================================

app.post('/api/crises', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const title = String(req.body.title || '').trim();
    const sev = String(req.body.sev || '').trim();
    const prio = String(req.body.prio || (sev === 'Critical' ? 'Immediate' : sev === 'High' ? 'Urgent' : 'Normal')).trim();
    const wf = String(req.body.wf || '').trim();
    const desc = String(req.body.desc || '').trim();

    if (!title || !sev || !desc) {
      return res.status(400).json({ error: 'Title, severity and description are required.' });
    }

    const id = uid();
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO crises (id, lab_id, title, severity, priority, workflow_id, description, status, stage, incident_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10)',
      [id, req.user.lab_id, title, sev, prio, wf, desc, 'Open', todayISO(), req.user.id]
    );
    await client.query(
      'INSERT INTO crisis_activities (crisis_id, text, display_time) VALUES ($1, $2, $3)',
      [id, `Incident reported (${sev} severity, ${prio} priority) by ${req.user.name}`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'crises', labId: req.user.lab_id });
    res.status(201).json({ id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.put('/api/crises/:id', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const stage = Number(req.body.stage);
    const status = String(req.body.status || 'Open').trim();
    const prio = String(req.body.prio || 'Normal').trim();
    const ca = String(req.body.ca || '').trim();
    const own = String(req.body.own || '').trim();
    const ev = String(req.body.ev || '').trim();

    if (!Number.isInteger(stage) || stage < 0 || stage > 3) {
      return res.status(400).json({ error: 'Invalid resolution stage.' });
    }

    await client.query('BEGIN');
    const prev = await client.query('SELECT status, stage, owner_name FROM crises WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    if (!prev.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Incident not found.' });
    }

    await client.query(
      'UPDATE crises SET stage = $1, status = $2, priority = $3, corrective_action = $4, owner_name = $5, evidence = $6 WHERE id = $7 AND lab_id = $8',
      [stage, status, prio, ca, own, ev, req.params.id, req.user.lab_id]
    );

    const stageNames = ['Detect', 'Assess', 'Resolve', 'Review'];
    const summaryParts = [`Stage: ${stageNames[stage]}`, `Status: ${status}`, `Priority: ${prio}`];
    if (own) summaryParts.push(`Owner: ${own}`);
    await client.query(
      'INSERT INTO crisis_activities (crisis_id, text, display_time) VALUES ($1, $2, $3)',
      [req.params.id, `Updated by ${req.user.name} (${summaryParts.join(' · ')})`, new Date().toLocaleString()]
    );
    await client.query('COMMIT');
    broadcastEvent('workspace_sync', { entity: 'crises', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/crises/:id', requireAuth, requireStaffOrAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM crises WHERE id = $1 AND lab_id = $2', [req.params.id, req.user.lab_id]);
    broadcastEvent('workspace_sync', { entity: 'crises', labId: req.user.lab_id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Central Error Handler ---
app.use((err, req, res, _next) => {
  console.error('[API Error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error.'
  });
});

// --- Database Initialization & Server Start ---
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`LabSim Multi-Lab server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize PostgreSQL schema or start server:', err);
    process.exit(1);
  });
