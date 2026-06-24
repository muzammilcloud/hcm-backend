// ─────────────────────────────────────────────────────────────────────────────
// Projects & Task Management — single source of truth for permissions,
// assignment validation, input validation, the activity feed, and progress.
//
// Every route in routes/projects.js goes through the helpers here; no route
// re-implements a rule. The permission predicates (can / assert*) are PURE
// (actor + project + membership in, boolean out) so they're unit-testable
// without a database. The DB helpers take a `pool` argument (the tenant pool
// from getDB()) so they're tenant-scoped automatically and injectable in tests.
//
// Roles map to portal_users.portal_role: 'sys-admin' | 'team-lead' | 'employee'.
//
// Permission model (server-enforced):
//   - Create project:   SYS_ADMIN or TEAM_LEAD.
//   - View project:     SYS_ADMIN and TEAM_LEAD see ALL; EMPLOYEE only theirs.
//   - Manage project:   (edit, add/remove members) SYS_ADMIN, the creator, or a
//                       TEAM_LEAD who is a member. EMPLOYEE never manages.
//   - Act in project:   (create/edit/assign/delete tasks, comment) SYS_ADMIN or
//                       any member of the project.
//   - Delete project:   creator or SYS_ADMIN only.
//   - Assign a task:    every assignee must already be a member of the project.
// ─────────────────────────────────────────────────────────────────────────────

const ROLES = { SYS_ADMIN: 'sys-admin', TEAM_LEAD: 'team-lead', EMPLOYEE: 'employee' };

const TASK_STATUSES   = ['todo', 'in_progress', 'done'];
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PROJECT_STATUSES = ['active', 'archived'];

const ACTIONS = {
  PROJECT_CREATED:    'project_created',
  PROJECT_UPDATED:    'project_updated',
  MEMBER_ADDED:       'member_added',
  MEMBER_REMOVED:     'member_removed',
  TASK_CREATED:       'task_created',
  TASK_UPDATED:       'task_updated',
  TASK_STATUS_CHANGED:'task_status_changed',
  TASK_ASSIGNED:      'task_assigned',
  TASK_UNASSIGNED:    'task_unassigned',
  TASK_DELETED:       'task_deleted',
  COMMENT_ADDED:      'comment_added',
};

// Capabilities a request can need against a specific project.
const CAP = { VIEW: 'view', MANAGE: 'manage', ACT: 'act', DELETE: 'delete' };

// ── Typed error ──────────────────────────────────────────────────────────────
// Thrown by the helpers; the shared errorHandler turns it into a consistent
// JSON response: { error, code?, details? } with the right HTTP status.
class ApiError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code) this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ── Pure permission core ─────────────────────────────────────────────────────
// actor   = { id:Number, role:String }
// project = a projects row (needs at least { created_by })
// member  = boolean: is the actor a member of this project?
function can(capability, actor, project, member) {
  const sys     = actor.role === ROLES.SYS_ADMIN;
  const tl      = actor.role === ROLES.TEAM_LEAD;
  const creator = !!project && Number(project.created_by) === Number(actor.id);

  switch (capability) {
    case CAP.VIEW:   return sys || tl || member;
    case CAP.MANAGE: return sys || creator || (tl && member);
    case CAP.ACT:    return sys || member;
    case CAP.DELETE: return sys || creator;
    default:         return false;
  }
}

function canCreateProject(actor) {
  return actor.role === ROLES.SYS_ADMIN || actor.role === ROLES.TEAM_LEAD;
}

// Per-project toggle: may an employee MEMBER create + freely act on tasks?
// Defaults to true (column default 1) so existing projects are unchanged.
function allowsMemberTasks(project) {
  const v = project?.allow_member_tasks;
  return v === undefined || v === null || Number(v) === 1;
}

// "Full task control" = create tasks, edit/delete/reassign ANY task, comment
// anywhere in the project. Granted to: sys-admin; the project's managers
// (creator, or a team-lead member); and employee members ONLY when the
// project's allow_member_tasks toggle is on. When the toggle is off, employee
// members drop to a limited mode (status + comment on their assigned tasks only,
// no create) — enforced per-action in the routes via fullTaskControl + isAssignee.
function fullTaskControl(actor, project, member) {
  if (actor.role === ROLES.SYS_ADMIN) return true;
  if (!member) return false;                       // non-members never act
  if (Number(project.created_by) === Number(actor.id)) return true;  // creator
  if (actor.role === ROLES.TEAM_LEAD) return true; // team-lead member = manager
  return allowsMemberTasks(project);               // employee member: toggle
}

// The actor's capabilities against a project, for the client to show/hide
// controls. The server still enforces every action independently — this is a
// UX hint derived from the same predicates, never the gate itself.
//   createTask: can create tasks + edit/delete/reassign any task + comment freely.
//   A limited employee member (createTask=false) may still change status and
//   comment on tasks ASSIGNED to them — the client checks assignment for that.
function capsFor(actor, project, member) {
  return {
    view:       can(CAP.VIEW, actor, project, member),
    manage:     can(CAP.MANAGE, actor, project, member),
    delete:     can(CAP.DELETE, actor, project, member),
    createTask: fullTaskControl(actor, project, member),
    isMember:   !!member,
    allowMemberTasks: allowsMemberTasks(project),
  };
}

const FORBIDDEN_MSG = {
  [CAP.VIEW]:   'You do not have access to this project.',
  [CAP.MANAGE]: 'You do not have permission to manage this project.',
  [CAP.ACT]:    'Only members of this project can do that.',
  [CAP.DELETE]: 'Only the project creator or a system admin can delete this project.',
};

// ── DB helpers (tenant pool injected) ────────────────────────────────────────
async function loadProject(pool, projectId) {
  const [rows] = await pool.execute('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!rows.length) throw new ApiError(404, 'Project not found.', 'NOT_FOUND');
  return rows[0];
}

async function loadTask(pool, taskId) {
  const [rows] = await pool.execute('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!rows.length) throw new ApiError(404, 'Task not found.', 'NOT_FOUND');
  return rows[0];
}

async function isAssignee(pool, taskId, userId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM task_assignees WHERE task_id = ? AND portal_user_id = ? LIMIT 1',
    [taskId, userId]
  );
  return rows.length > 0;
}

async function isMember(pool, projectId, userId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM project_members WHERE project_id = ? AND portal_user_id = ? LIMIT 1',
    [projectId, userId]
  );
  return rows.length > 0;
}

async function memberIdSet(pool, projectId) {
  const [rows] = await pool.execute(
    'SELECT portal_user_id FROM project_members WHERE project_id = ?',
    [projectId]
  );
  return new Set(rows.map((r) => Number(r.portal_user_id)));
}

// Load a project, resolve the actor's membership, and enforce a capability in
// one call so a route physically can't act without passing the gate. Returns
// { project, member } on success; throws ApiError(404|403) otherwise.
async function authorizeProject(pool, actor, projectId, capability) {
  const project = await loadProject(pool, projectId);
  const member = await isMember(pool, projectId, actor.id);
  if (!can(capability, actor, project, member)) {
    throw new ApiError(403, FORBIDDEN_MSG[capability] || 'Forbidden.', 'FORBIDDEN');
  }
  return { project, member };
}

// Validate that every id in `userIds` is a member of `projectId`. Returns the
// de-duplicated, integer-normalized list. Throws 400 with the offending ids.
async function validateAssignees(pool, projectId, userIds) {
  const ids = normalizeIdList(userIds);
  if (ids.length === 0) return [];
  const members = await memberIdSet(pool, projectId);
  const invalid = ids.filter((id) => !members.has(id));
  if (invalid.length) {
    throw new ApiError(
      400,
      'Every assignee must already be a member of the project.',
      'ASSIGNEE_NOT_MEMBER',
      { invalid }
    );
  }
  return ids;
}

// Append-only feed write. Never throws into the caller's happy path — a failed
// feed insert must not roll back the action it describes, so we log and move on.
async function logActivity(pool, { projectId, taskId = null, actorId = null, action, meta = null }) {
  try {
    await pool.execute(
      'INSERT INTO project_activity (project_id, task_id, actor_id, action, meta_json) VALUES (?,?,?,?,?)',
      [projectId, taskId, actorId, action, meta == null ? null : JSON.stringify(meta)]
    );
  } catch (e) {
    console.error('[projects] activity log failed:', e.message);
  }
}

// Status breakdown + overall completion for a project.
async function computeProgress(pool, projectId) {
  const [rows] = await pool.execute(
    'SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status',
    [projectId]
  );
  const counts = { todo: 0, in_progress: 0, done: 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  const total = counts.todo + counts.in_progress + counts.done;
  const percent_complete = total === 0 ? 0 : Math.round((counts.done / total) * 100);
  return { total, by_status: counts, percent_complete };
}

// ── Input validation ─────────────────────────────────────────────────────────
function normalizeIdList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ApiError(400, 'Invalid user id in list.', 'VALIDATION', { value: v });
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function parseId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, `Invalid ${field}.`, 'VALIDATION', { field });
  }
  return n;
}

function requireString(value, field, { max, required = true } = {}) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new ApiError(400, `${field} is required.`, 'VALIDATION', { field });
    return null;
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, `${field} must be text.`, 'VALIDATION', { field });
  }
  const trimmed = value.trim();
  if (max && trimmed.length > max) {
    throw new ApiError(400, `${field} must be ${max} characters or fewer.`, 'VALIDATION', { field, max });
  }
  return trimmed;
}

function enumOr(value, allowed, field, fallback) {
  if (value == null) return fallback;
  if (!allowed.includes(value)) {
    throw new ApiError(400, `Invalid ${field}.`, 'VALIDATION', { field, allowed });
  }
  return value;
}

// Accepts null/'' (clears) or a strict YYYY-MM-DD calendar date.
function parseDueDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'due_date must be a YYYY-MM-DD date.', 'VALIDATION', { field: 'due_date' });
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ApiError(400, 'due_date is not a real calendar date.', 'VALIDATION', { field: 'due_date' });
  }
  return value;
}

function validateProjectCreate(body) {
  return {
    name: requireString(body.name, 'name', { max: 200 }),
    description: requireString(body.description, 'description', { max: 5000, required: false }),
  };
}

function validateProjectUpdate(body) {
  const out = {};
  if ('name' in body)        out.name = requireString(body.name, 'name', { max: 200 });
  if ('description' in body) out.description = requireString(body.description, 'description', { max: 5000, required: false });
  if ('status' in body)      out.status = enumOr(body.status, PROJECT_STATUSES, 'status', 'active');
  if ('allow_member_tasks' in body) out.allow_member_tasks = toBool(body.allow_member_tasks) ? 1 : 0;
  if (Object.keys(out).length === 0) {
    throw new ApiError(400, 'Nothing to update.', 'VALIDATION');
  }
  return out;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return !!v;
}

function validateTaskCreate(body) {
  return {
    title: requireString(body.title, 'title', { max: 300 }),
    description: requireString(body.description, 'description', { max: 10000, required: false }),
    status: enumOr(body.status, TASK_STATUSES, 'status', 'todo'),
    priority: enumOr(body.priority, TASK_PRIORITIES, 'priority', 'medium'),
    due_date: parseDueDate(body.due_date),
    assignees: normalizeIdList(body.assignee_ids),
  };
}

function validateTaskUpdate(body) {
  const out = {};
  if ('title' in body)       out.title = requireString(body.title, 'title', { max: 300 });
  if ('description' in body) out.description = requireString(body.description, 'description', { max: 10000, required: false });
  if ('status' in body)      out.status = enumOr(body.status, TASK_STATUSES, 'status');
  if ('priority' in body)    out.priority = enumOr(body.priority, TASK_PRIORITIES, 'priority');
  if ('due_date' in body)    out.due_date = parseDueDate(body.due_date);
  if (Object.keys(out).length === 0) {
    throw new ApiError(400, 'Nothing to update.', 'VALIDATION');
  }
  return out;
}

function validateComment(body) {
  return { body: requireString(body.body, 'body', { max: 5000 }) };
}

module.exports = {
  ROLES, CAP, ACTIONS, TASK_STATUSES, TASK_PRIORITIES, PROJECT_STATUSES,
  ApiError,
  // permissions
  can, canCreateProject, capsFor, authorizeProject,
  fullTaskControl, allowsMemberTasks,
  // db helpers
  loadProject, loadTask, isMember, isAssignee, memberIdSet, validateAssignees,
  logActivity, computeProgress,
  // validation
  parseId, normalizeIdList,
  validateProjectCreate, validateProjectUpdate,
  validateTaskCreate, validateTaskUpdate, validateComment,
};
