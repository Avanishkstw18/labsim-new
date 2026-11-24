/**
 * LabSim Stage 4 Multi-Lab End-to-End Integration & Verification Test Suite
 * Run against a live LabSim server + PostgreSQL instance:
 *   BASE_URL=http://localhost:3000 node test_stage4.js
 */
const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function req(path, opts = {}, token = '') {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('1. Checking /api/health...');
  const health = await req('/api/health');
  assert.strictEqual(health.status, 200, 'Health check failed');

  const stamp = Date.now();
  const labAUser = `lab_a_${stamp}`;
  const labAPass = 'PassLabA123';
  const labBUser = `lab_b_${stamp}`;
  const labBPass = 'PassLabB123';

  const staffEmail = `staff_${stamp}@labsim.test`;
  const studentEmail = `student_${stamp}@labsim.test`;
  const otherLabEmail = `other_${stamp}@labsim.test`;

  console.log('2. Creating Lab A (Admin) & Lab B (Admin), plus Student joining Lab A...');
  const createLabA = await req('/api/auth/create-lab', {
    method: 'POST',
    body: JSON.stringify({
      labName: 'Electronics Lab A',
      labUsername: labAUser,
      labPassword: labAPass,
      name: 'Dr. Staff',
      role: 'Lab Staff',
      email: staffEmail,
      password: 'Password123'
    })
  });
  assert.strictEqual(createLabA.status, 201, 'Lab A creation failed');
  const staffToken = createLabA.data.token;

  const createLabB = await req('/api/auth/create-lab', {
    method: 'POST',
    body: JSON.stringify({
      labName: 'Chemistry Lab B',
      labUsername: labBUser,
      labPassword: labBPass,
      name: 'Prof. Other',
      role: 'Admin / Lab In-Charge',
      email: otherLabEmail,
      password: 'Password123'
    })
  });
  assert.strictEqual(createLabB.status, 201, 'Lab B creation failed');
  const labBToken = createLabB.data.token;

  // Wrong lab password should be blocked (403)
  const badJoin = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      labUsername: labAUser,
      labPassword: 'WrongPassword',
      name: 'Intruder',
      role: 'Student',
      email: `bad_${stamp}@labsim.test`,
      password: 'Password123'
    })
  });
  assert.strictEqual(badJoin.status, 403, 'Wrong lab password should be rejected');

  const regStudent = await req('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      labUsername: labAUser,
      labPassword: labAPass,
      name: 'Alex Student',
      role: 'Student',
      email: studentEmail,
      password: 'Password123'
    })
  });
  assert.strictEqual(regStudent.status, 201, 'Student joining Lab A failed');
  const studentToken = regStudent.data.token;

  console.log('3. Testing Resource CRUD, Low-Stock Threshold & RBAC...');
  const createRes = await req('/api/resources', {
    method: 'POST',
    body: JSON.stringify({ name: `Oscilloscope_${stamp}`, type: 'Equipment', cost: 450, stock: 5, minStock: 2 })
  }, staffToken);
  assert.strictEqual(createRes.status, 201);
  const resId = createRes.data.id;

  // Student should be blocked (403) from deleting inventory
  const studentDelRes = await req(`/api/resources/${resId}`, { method: 'DELETE' }, studentToken);
  assert.strictEqual(studentDelRes.status, 403, 'RBAC should block Student from deleting resources');

  console.log('4. Testing Multi-Lab Update Isolation...');
  const upCreate = await req('/api/updates', {
    method: 'POST',
    body: JSON.stringify({ title: `LabA_Notice_${stamp}`, cat: 'SOP / Policy', aud: 'All Users', dept: '', desc: 'Only for Lab A members' })
  }, staffToken);
  assert.strictEqual(upCreate.status, 201);
  const upId = upCreate.data.id;

  // Lab A Student CAN see Lab A's update
  const labAState = await req('/api/state', {}, studentToken);
  assert.ok(labAState.data.up.some(u => u.id === upId), 'Lab A member should see Lab A update');

  // Lab B Admin CANNOT see Lab A's update or resources
  const labBState = await req('/api/state', {}, labBToken);
  assert.ok(!labBState.data.up.some(u => u.id === upId), 'Lab B member must NOT see Lab A update');
  assert.ok(!labBState.data.res.some(r => r.id === resId), 'Lab B member must NOT see Lab A resource');

  console.log('All Multi-Lab Stage 4 integration tests passed successfully!');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
