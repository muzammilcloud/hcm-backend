// Standalone tests for the Projects & Task Management module. No test runner
// required — run with:  node tests/projects.test.js
//
// Covers the parts that must never silently regress:
//   1. The pure permission matrix (every role × capability × membership).
//   2. Input validation (clear errors, correct enums/dates).
//   3. Assignment validation (assignee must be a project member).
//   4. The qa-starter beta gate in services/features.js.

const assert = require('node:assert');
const P = require('../services/projects');
const { tenantHas, tenantFeatures } = require('../services/features');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
// Assert that fn throws an ApiError with the given code (and optional status).
function throwsApi(fn, code, status) {
  try { fn(); assert.fail(`expected throw (${code})`); }
  catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.strictEqual(e.code, code, `code: got ${e.code} want ${code}`);
    if (status) assert.strictEqual(e.status, status, `status: got ${e.status} want ${status}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const project = { id: 10, created_by: 2 };          // created by team-lead #2
const sys         = { id: 1, role: P.ROLES.SYS_ADMIN };
const tlCreator   = { id: 2, role: P.ROLES.TEAM_LEAD };
const tlMember    = { id: 3, role: P.ROLES.TEAM_LEAD };
const tlOutsider  = { id: 4, role: P.ROLES.TEAM_LEAD };
const empMember   = { id: 5, role: P.ROLES.EMPLOYEE };
const empOutsider = { id: 6, role: P.ROLES.EMPLOYEE };

// [actor, isMember, expectVIEW, expectMANAGE, expectACT, expectDELETE]
const MATRIX = [
  [sys,         false, true,  true,  true,  true ],  // sys-admin: full access regardless of membership
  [tlCreator,   true,  true,  true,  true,  true ],  // creator: manage + delete own
  [tlMember,    true,  true,  true,  true,  false],  // team-lead member of someone else's project: manage but NOT delete
  [tlOutsider,  false, true,  false, false, false],  // team-lead non-member: VIEW all, but cannot manage/act
  [empMember,   true,  true,  false, true,  false],  // employee member: act on tasks, but never manage/delete
  [empOutsider, false, false, false, false, false],  // employee non-member: nothing
];

console.log('\nPermission matrix');
for (const [actor, member, v, m, a, d] of MATRIX) {
  const label = `${actor.role}#${actor.id} member=${member}`;
  test(`${label} VIEW=${v}`,   () => assert.strictEqual(P.can(P.CAP.VIEW,   actor, project, member), v));
  test(`${label} MANAGE=${m}`, () => assert.strictEqual(P.can(P.CAP.MANAGE, actor, project, member), m));
  test(`${label} ACT=${a}`,    () => assert.strictEqual(P.can(P.CAP.ACT,    actor, project, member), a));
  test(`${label} DELETE=${d}`, () => assert.strictEqual(P.can(P.CAP.DELETE, actor, project, member), d));
}

console.log('\nProject creation');
test('sys-admin can create',  () => assert.strictEqual(P.canCreateProject(sys), true));
test('team-lead can create',  () => assert.strictEqual(P.canCreateProject(tlCreator), true));
test('employee cannot create',() => assert.strictEqual(P.canCreateProject(empMember), false));

console.log('\nInput validation');
test('project requires a name', () => throwsApi(() => P.validateProjectCreate({}), 'VALIDATION', 400));
test('project name trims',      () => assert.strictEqual(P.validateProjectCreate({ name: '  Apollo  ' }).name, 'Apollo'));
test('task requires a title',   () => throwsApi(() => P.validateTaskCreate({}), 'VALIDATION', 400));
test('task rejects bad status', () => throwsApi(() => P.validateTaskCreate({ title: 'x', status: 'doing' }), 'VALIDATION'));
test('task rejects bad priority',() => throwsApi(() => P.validateTaskCreate({ title: 'x', priority: 'meh' }), 'VALIDATION'));
test('task defaults status/priority', () => {
  const t = P.validateTaskCreate({ title: 'x' });
  assert.strictEqual(t.status, 'todo');
  assert.strictEqual(t.priority, 'medium');
  assert.strictEqual(t.due_date, null);
});
test('due_date rejects non-date', () => throwsApi(() => P.validateTaskCreate({ title: 'x', due_date: '12/01/2026' }), 'VALIDATION'));
test('due_date rejects impossible date', () => throwsApi(() => P.validateTaskCreate({ title: 'x', due_date: '2026-13-40' }), 'VALIDATION'));
test('due_date accepts YYYY-MM-DD', () => assert.strictEqual(P.validateTaskCreate({ title: 'x', due_date: '2026-07-01' }).due_date, '2026-07-01'));
test('update with no fields fails', () => throwsApi(() => P.validateTaskUpdate({}), 'VALIDATION'));
test('comment requires a body',     () => throwsApi(() => P.validateComment({ body: '   ' }), 'VALIDATION'));
test('id parser rejects junk',      () => throwsApi(() => P.parseId('abc'), 'VALIDATION'));
test('id list dedupes',             () => assert.deepStrictEqual(P.normalizeIdList([5, 5, 2]), [5, 2]));
test('id list rejects non-int',     () => throwsApi(() => P.normalizeIdList([1, -3]), 'VALIDATION'));

console.log('\nAssignment validation (assignee must be a member)');
// Fake pool: memberIdSet() runs the only query validateAssignees needs.
const fakePool = (memberIds) => ({
  execute: async (sql) => {
    if (/FROM project_members/i.test(sql)) {
      return [memberIds.map((id) => ({ portal_user_id: id })), []];
    }
    return [[], []];
  },
});
async function runAsync() {
  await test_async('accepts members and dedupes', async () => {
    const ids = await P.validateAssignees(fakePool([2, 5, 7]), 10, [5, 5, 2]);
    assert.deepStrictEqual(ids, [5, 2]);
  });
  await test_async('rejects a non-member with details.invalid', async () => {
    try {
      await P.validateAssignees(fakePool([2, 5]), 10, [5, 99]);
      assert.fail('expected throw');
    } catch (e) {
      assert.strictEqual(e.code, 'ASSIGNEE_NOT_MEMBER');
      assert.strictEqual(e.status, 400);
      assert.deepStrictEqual(e.details.invalid, [99]);
    }
  });
  await test_async('empty assignee list is allowed', async () => {
    const ids = await P.validateAssignees(fakePool([2]), 10, []);
    assert.deepStrictEqual(ids, []);
  });

  console.log('\nBeta gate (qa-starter only)');
  test('qa-starter HAS projects (beta override)', () => assert.strictEqual(tenantHas({ slug: 'qa-starter', plan: 'starter' }, 'projects'), true));
  test('a different Growth tenant does NOT yet have projects', () => assert.strictEqual(tenantHas({ slug: 'acme', plan: 'growth' }, 'projects'), false));
  test('a different Starter tenant does NOT have projects', () => assert.strictEqual(tenantHas({ slug: 'acme', plan: 'starter' }, 'projects'), false));
  test('qa-starter feature list includes projects', () => assert.ok(tenantFeatures({ slug: 'qa-starter', plan: 'starter' }).includes('projects')));
  test('other tenant feature list excludes projects', () => assert.ok(!tenantFeatures({ slug: 'acme', plan: 'growth' }).includes('projects')));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
async function test_async(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
runAsync();
