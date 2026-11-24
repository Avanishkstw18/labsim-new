const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const uid = () => crypto.randomBytes(6).toString('hex');
const todayISO = () => new Date().toISOString().slice(0, 10);

async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
}

async function buildUserState(userId) {
  const userRes = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.lab_id, COALESCE(l.lab_username, u.lab_username) AS lab_username, COALESCE(l.lab_name, '') AS lab_name
     FROM users u
     LEFT JOIN labs l ON u.lab_id = l.id
     WHERE u.id = $1`,
    [userId]
  );
  const user = userRes.rows[0];
  const labId = user.lab_id;

  const [
    deptsRes,
    resRes,
    wfRes,
    wfMemRes,
    wfTaskRes,
    wfAllocRes,
    wfActRes,
    mtRes,
    wsRes,
    crRes,
    crActRes,
    allUsersRes,
    upRes,
    upReadRes,
    upAckRes,
    upReactRes,
    upCommRes
  ] = await Promise.all([
    pool.query('SELECT name FROM departments WHERE lab_id = $1 ORDER BY name ASC', [labId]),
    pool.query('SELECT id, name, type, cost, stock, avail, min_stock FROM resources WHERE lab_id = $1 ORDER BY updated_at DESC, name ASC', [labId]),
    pool.query('SELECT id, name, purpose, start_date, end_date, guide, status, upd FROM workflows WHERE lab_id = $1 ORDER BY created_at DESC', [labId]),
    pool.query('SELECT wm.id, wm.workflow_id, wm.name, wm.role FROM workflow_members wm JOIN workflows w ON wm.workflow_id = w.id WHERE w.lab_id = $1', [labId]),
    pool.query('SELECT wt.id, wt.workflow_id, wt.name, wt.assigned_to, wt.due_date, wt.status FROM workflow_tasks wt JOIN workflows w ON wt.workflow_id = w.id WHERE w.lab_id = $1', [labId]),
    pool.query('SELECT wa.id, wa.workflow_id, wa.resource_id, wa.resource_name, wa.category, wa.qty, wa.task_name FROM workflow_allocations wa JOIN workflows w ON wa.workflow_id = w.id WHERE w.lab_id = $1', [labId]),
    pool.query('SELECT act.workflow_id, act.text, act.display_time FROM workflow_activities act JOIN workflows w ON act.workflow_id = w.id WHERE w.lab_id = $1 ORDER BY act.id DESC', [labId]),
    pool.query('SELECT id, resource_id, eq, task_type, description, due_date, status, completed_at, completed_by, completion_notes FROM maintenance WHERE lab_id = $1 ORDER BY due_date ASC, created_at DESC', [labId]),
    pool.query('SELECT id, name, category, qty, unit, step, cost, record_date FROM waste_records WHERE lab_id = $1 ORDER BY created_at DESC', [labId]),
    pool.query('SELECT id, title, severity, priority, workflow_id, description, status, stage, incident_date, corrective_action, owner_name, evidence FROM crises WHERE lab_id = $1 ORDER BY created_at DESC', [labId]),
    pool.query('SELECT ca.crisis_id, ca.text, ca.display_time FROM crisis_activities ca JOIN crises c ON ca.crisis_id = c.id WHERE c.lab_id = $1 ORDER BY ca.id DESC', [labId]),
    pool.query('SELECT id, name, role FROM users WHERE lab_id = $1 ORDER BY name ASC', [labId]),
    pool.query('SELECT id, title, category, audience, department, description, author_name, author_role, pinned, EXTRACT(EPOCH FROM created_at) * 1000 AS at FROM updates WHERE lab_id = $1 ORDER BY pinned DESC, created_at DESC', [labId]),
    pool.query('SELECT update_id FROM update_reads WHERE user_id = $1', [userId]),
    pool.query('SELECT ua.update_id, ua.user_id FROM update_acknowledgements ua JOIN updates u ON ua.update_id = u.id WHERE u.lab_id = $1', [labId]),
    pool.query('SELECT ur.update_id, ur.user_id, ur.emoji FROM update_reactions ur JOIN updates u ON ur.update_id = u.id WHERE u.lab_id = $1', [labId]),
    pool.query('SELECT uc.id, uc.update_id, uc.parent_id, uc.author_name, uc.author_role, uc.kind, uc.resolved, uc.body, uc.display_time FROM update_comments uc JOIN updates u ON uc.update_id = u.id WHERE u.lab_id = $1 ORDER BY uc.created_at ASC', [labId])
  ]);

  const membersByWf = {};
  for (const m of wfMemRes.rows) {
    (membersByWf[m.workflow_id] ||= []).push({ id: m.id, name: m.name, role: m.role });
  }

  const tasksByWf = {};
  for (const t of wfTaskRes.rows) {
    (tasksByWf[t.workflow_id] ||= []).push({
      id: t.id,
      name: t.name,
      to: t.assigned_to,
      due: t.due_date,
      status: t.status
    });
  }

  const wfNameById = {};
  for (const w of wfRes.rows) wfNameById[w.id] = w.name;

  const allocByWf = {};
  const allocByRes = {};
  for (const a of wfAllocRes.rows) {
    (allocByWf[a.workflow_id] ||= []).push({
      id: a.id,
      rid: a.resource_id,
      res: a.resource_name,
      cat: a.category,
      qty: Number(a.qty),
      task: a.task_name
    });
    (allocByRes[a.resource_id] ||= []).push({
      id: a.id,
      wid: a.workflow_id,
      wf: wfNameById[a.workflow_id] || 'Workflow',
      qty: Number(a.qty),
      task: a.task_name
    });
  }

  const actsByWf = {};
  for (const a of wfActRes.rows) {
    (actsByWf[a.workflow_id] ||= []).push({ t: a.text, d: a.display_time });
  }

  const wf = wfRes.rows.map(w => ({
    id: w.id,
    name: w.name,
    purpose: w.purpose,
    start: w.start_date,
    end: w.end_date,
    guide: w.guide,
    status: w.status,
    upd: w.upd,
    members: membersByWf[w.id] || [],
    tasks: tasksByWf[w.id] || [],
    alloc: allocByWf[w.id] || [],
    acts: actsByWf[w.id] || []
  }));

  const readSet = new Set(upReadRes.rows.map(r => r.update_id));

  const ackCounts = {};
  const myAcks = new Set();
  for (const a of upAckRes.rows) {
    ackCounts[a.update_id] = (ackCounts[a.update_id] || 0) + 1;
    if (a.user_id === userId) myAcks.add(a.update_id);
  }

  const rxByUp = {};
  const myRxByUp = {};
  for (const r of upReactRes.rows) {
    rxByUp[r.update_id] ||= {};
    rxByUp[r.update_id][r.emoji] = (rxByUp[r.update_id][r.emoji] || 0) + 1;
    if (r.user_id === userId) {
      (myRxByUp[r.update_id] ||= []).push(r.emoji);
    }
  }

  const topCommentsByUp = {};
  const repliesByParent = {};
  for (const c of upCommRes.rows) {
    if (!c.parent_id) {
      (topCommentsByUp[c.update_id] ||= []).push({
        id: c.id,
        by: c.author_name,
        role: c.author_role,
        kind: c.kind,
        res: c.resolved,
        t: c.body,
        at: c.display_time,
        rep: []
      });
    } else {
      (repliesByParent[c.parent_id] ||= []).push({
        id: c.id,
        by: c.author_name,
        role: c.author_role,
        t: c.body,
        at: c.display_time
      });
    }
  }

  for (const upId of Object.keys(topCommentsByUp)) {
    for (const c of topCommentsByUp[upId]) {
      c.rep = repliesByParent[c.id] || [];
    }
  }

  const up = upRes.rows.map(u => ({
    id: u.id,
    title: u.title,
    cat: u.category,
    aud: u.audience,
    dept: u.department,
    desc: u.description,
    by: u.author_name,
    role: u.author_role,
    at: Math.round(Number(u.at)),
    read: readSet.has(u.id),
    pin: u.pinned ? 1 : 0,
    rx: rxByUp[u.id] || {},
    my: myRxByUp[u.id] || [],
    acks: ackCounts[u.id] || 0,
    ack: myAcks.has(u.id) ? 1 : 0,
    cm: topCommentsByUp[u.id] || []
  }));

  return {
    user,
    depts: deptsRes.rows.map(d => d.name),
    res: resRes.rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      cost: Number(r.cost),
      stock: Number(r.stock),
      avail: Number(r.avail),
      minStock: Number(r.min_stock || 0),
      allocs: allocByRes[r.id] || []
    })),
    wf,
    mt: mtRes.rows.map(m => ({
      id: m.id,
      rid: m.resource_id,
      eq: m.eq,
      type: m.task_type || 'Calibration',
      desc: m.description,
      due: m.due_date,
      status: m.status,
      completedAt: m.completed_at ? new Date(m.completed_at).toLocaleString() : '',
      completedBy: m.completed_by || '',
      notes: m.completion_notes || ''
    })),
    ws: wsRes.rows.map(w => ({
      id: w.id,
      name: w.name,
      cat: w.category,
      qty: Number(w.qty),
      unit: w.unit,
      step: Number(w.step),
      cost: Number(w.cost),
      date: w.record_date
    })),
    users: allUsersRes.rows.map(u => ({ id: u.id, name: u.name, role: u.role })),
    cr: crRes.rows.map(c => ({
      id: c.id,
      title: c.title,
      sev: c.severity,
      prio: c.priority || 'Normal',
      wf: c.workflow_id,
      desc: c.description,
      status: c.status,
      stage: Number(c.stage),
      date: c.incident_date,
      ca: c.corrective_action,
      own: c.owner_name,
      ev: c.evidence,
      acts: crActRes.rows.filter(a => a.crisis_id === c.id).map(a => ({ t: a.text, d: a.display_time }))
    })),
    up
  };
}

module.exports = {
  pool,
  uid,
  todayISO,
  initSchema,
  buildUserState
};
