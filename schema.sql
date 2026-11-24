-- LabSim Stage 4 Multi-Lab PostgreSQL Schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Labs (Each lab sets its own Lab Username & Lab Password)
CREATE TABLE IF NOT EXISTS labs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_username TEXT UNIQUE NOT NULL,
  lab_password_hash TEXT NOT NULL,
  lab_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users & Authentication (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  lab_username TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Researcher',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Departments (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lab_id, name)
);

-- Resources & Inventory (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  avail INTEGER NOT NULL DEFAULT 0 CHECK (avail >= 0),
  min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workflows (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  guide TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Ongoing',
  upd TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_members (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assigned_to TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending'
);

CREATE TABLE IF NOT EXISTS workflow_allocations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  resource_name TEXT NOT NULL,
  category TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  task_name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS workflow_activities (
  id SERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  display_time TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Equipment Maintenance (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS maintenance (
  id TEXT PRIMARY KEY,
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  eq TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'Calibration',
  description TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Scheduled',
  completed_at TIMESTAMPTZ,
  completed_by TEXT NOT NULL DEFAULT '',
  completion_notes TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Waste Management (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS waste_records (
  id TEXT PRIMARY KEY,
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  qty NUMERIC(12, 3) NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL DEFAULT 'kg',
  step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 3),
  cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  record_date TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Crisis & Resolution Centre (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS crises (
  id TEXT PRIMARY KEY,
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'Normal',
  workflow_id TEXT DEFAULT '',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  stage INTEGER NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 3),
  incident_date TEXT NOT NULL,
  corrective_action TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crisis_activities (
  id SERIAL PRIMARY KEY,
  crisis_id TEXT NOT NULL REFERENCES crises(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  display_time TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Multi-User Update Centre (Scoped to a Lab)
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  lab_id UUID REFERENCES labs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'All Users',
  department TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user Read State for Updates
CREATE TABLE IF NOT EXISTS update_reads (
  update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (update_id, user_id)
);

-- Per-user Acknowledgements for Updates
CREATE TABLE IF NOT EXISTS update_acknowledgements (
  update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (update_id, user_id)
);

-- Per-user Emoji Reactions for Updates
CREATE TABLE IF NOT EXISTS update_reactions (
  update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (update_id, user_id, emoji)
);

-- Comments & Queries on Updates
CREATE TABLE IF NOT EXISTS update_comments (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES update_comments(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'Comment',
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  body TEXT NOT NULL,
  display_time TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe Migrations for Existing Databases
ALTER TABLE users ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lab_username TEXT NOT NULL DEFAULT '';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS min_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'Calibration';
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS completed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE maintenance ADD COLUMN IF NOT EXISTS completion_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE waste_records ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE crises ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;
ALTER TABLE crises ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'Normal';
ALTER TABLE updates ADD COLUMN IF NOT EXISTS lab_id UUID REFERENCES labs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_users_lab_id ON users(lab_id);
CREATE INDEX IF NOT EXISTS idx_updates_lab_created ON updates(lab_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_update_comments_update_id ON update_comments(update_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_wf ON workflow_tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_crisis_activities_cid ON crisis_activities(crisis_id);
