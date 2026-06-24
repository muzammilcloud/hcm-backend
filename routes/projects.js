const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireUser } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');
const P = require('../services/projects');

// ─────────────────────────────────────────────────────────────────────────────
// Projects & Task Management routes.
//
// Mounted under /api. Two guards on EVERY route:
//   requireFeature('projects') — plan/beta gate (beta-limited to qa-starter)
//   requireUser                — any authenticated portal user + their role
//
// Authorization beyond "is logged in" is resource-level and lives entirely in
// services/projects.js (authorizeProject / can / validateAssignees). Handlers
// here only wire input → service → response, so the rules can't be bypassed by
// hitting a different endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const gate = [requireFeature('projects'), requireUser];

// Forward thrown ApiError (and any error) to the shared errorHandler, which
// renders { error, code?, details? } with the right status.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const actorOf = (req) => ({ id: Number(req.portalUserId), role: req.portalRole });

// Load a project + the actor's membership, then require FULL task control
// (create/edit/delete/reassign tasks, project comments). Limited employee
// members (allow_member_tasks off) are rejected here and handled separately for
// the status/comment-on-assigned-task path.
async function requireTaskControl(pool, actor, projectId, msg) {
  const project = await P.loadProject(pool, projectId);
  const member = await P.isMember(pool, projectId, actor.id);
  if (!P.fullTaskControl(actor, project, member)) {
    throw new P.ApiError(403, msg || 'You do not have permission to do that in this project.', 'FORBIDDEN');
  }
  return { project, member };
}

// Run a set of writes in a single transaction. The callback receives a
// connection that exposes .execute(), so the service helpers (which only need
// something with .execute) work against it unchanged.
async function tx(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function loadPortalUser(pool, userId) {
  const [rows] = await pool.execute(
    'SELECT id, name, email, portal_role FROM portal_users WHERE id = ?',
    [userId]
  );
  if (!rows.length) throw new P.ApiError(404, 'User not found.', 'NOT_FOUND');
  return rows[0];
}

// Attach an `assignees` array to each task row in-place.
async function attachAssignees(pool, tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT ta.task_id, pu.id, pu.name, pu.email
       FROM task_assignees ta
       JOIN portal_users pu ON pu.id = ta.portal_user_id
      WHERE ta.task_id IN (${placeholders})`,
    ids
  );
  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task_id)) byTask.set(r.task_id, []);
    byTask.get(r.task_id).push({ id: r.id, name: r.name, email: r.email });
  }
  for (const t of tasks) t.assignees = byTask.get(t.id) || [];
  return tasks;
}

const parseMeta = (m) => (typeof m === 'string' ? safeJson(m) : m);
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ── Projects ─────────────────────────────────────────────────────────────────

// POST /api/projects — create a project (SYS_ADMIN or TEAM_LEAD).
router.post('/projects', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  if (!P.canCreateProject(actor)) {
    throw new P.ApiError(403, 'Only team leads and system admins can create projects.', 'FORBIDDEN');
  }
  const { name, description } = P.validateProjectCreate(req.body);
  const pool = await getDB();

  const project = await tx(pool, async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO projects (name, description, created_by) VALUES (?,?,?)',
      [name, description, actor.id]
    );
    const projectId = result.insertId;
    // The creator is always a member, so "any member can act" includes them.
    await conn.execute(
      'INSERT INTO project_members (project_id, portal_user_id, added_by) VALUES (?,?,?)',
      [projectId, actor.id, actor.id]
    );
    await P.logActivity(conn, { projectId, actorId: actor.id, action: P.ACTIONS.PROJECT_CREATED, meta: { name } });
    const [rows] = await conn.execute('SELECT * FROM projects WHERE id = ?', [projectId]);
    return rows[0];
  });

  res.status(201).json(project);
}));

// GET /api/projects — list projects the actor can see.
//   SYS_ADMIN / TEAM_LEAD: all projects. EMPLOYEE: only projects they belong to.
router.get('/projects', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const seesAll = actor.role === P.ROLES.SYS_ADMIN || actor.role === P.ROLES.TEAM_LEAD;

  const base = `
    SELECT p.*,
      (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.portal_user_id = ?) AS is_member
    FROM projects p`;

  let rows;
  if (seesAll) {
    [rows] = await pool.execute(`${base} ORDER BY p.created_at DESC`, [actor.id]);
  } else {
    [rows] = await pool.execute(
      `${base}
        JOIN project_members me ON me.project_id = p.id AND me.portal_user_id = ?
       ORDER BY p.created_at DESC`,
      [actor.id, actor.id]
    );
  }

  const projects = rows.map((p) => {
    const total = Number(p.task_count);
    const done = Number(p.done_count);
    const member = !!Number(p.is_member);
    return {
      ...p,
      member_count: Number(p.member_count),
      task_count: total,
      done_count: done,
      is_member: member,
      percent_complete: total === 0 ? 0 : Math.round((done / total) * 100),
      can: P.capsFor(actor, p, member),
    };
  });
  res.json({ can_create: P.canCreateProject(actor), projects });
}));

// GET /api/projects/directory — active users that can be added as members or
// assignees. Module-scoped (any authenticated user in a projects-enabled
// tenant) so team leads can use the member picker too; adding a member is
// still separately gated by CAP.MANAGE on the target project. Declared BEFORE
// /projects/:id so 'directory' isn't captured as an :id.
router.get('/projects/directory', gate, ah(async (req, res) => {
  const pool = await getDB();
  const [rows] = await pool.execute(
    `SELECT id, name, email, portal_role
       FROM portal_users
      WHERE status = 'active'
      ORDER BY name ASC`
  );
  res.json(rows);
}));

// GET /api/projects/:id — project detail + members + progress.
router.get('/projects/:id', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  const { project, member } = await P.authorizeProject(pool, actor, projectId, P.CAP.VIEW);

  const [members] = await pool.execute(
    `SELECT pm.portal_user_id AS id, pu.name, pu.email, pu.portal_role,
            pm.created_at AS member_since
       FROM project_members pm
       JOIN portal_users pu ON pu.id = pm.portal_user_id
      WHERE pm.project_id = ?
      ORDER BY pm.created_at ASC`,
    [projectId]
  );
  const progress = await P.computeProgress(pool, projectId);

  res.json({
    ...project,
    members: members.map((m) => ({ ...m, is_creator: Number(m.id) === Number(project.created_by) })),
    progress,
    can: P.capsFor(actor, project, member),
  });
}));

// PATCH /api/projects/:id — edit project (MANAGE).
router.patch('/projects/:id', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.MANAGE);

  const fields = P.validateProjectUpdate(req.body);
  const cols = Object.keys(fields);
  const setSql = cols.map((c) => `${c} = ?`).join(', ');
  await pool.execute(`UPDATE projects SET ${setSql} WHERE id = ?`, [...cols.map((c) => fields[c]), projectId]);
  await P.logActivity(pool, { projectId, actorId: actor.id, action: P.ACTIONS.PROJECT_UPDATED, meta: { fields: cols } });

  const [rows] = await pool.execute('SELECT * FROM projects WHERE id = ?', [projectId]);
  res.json(rows[0]);
}));

// DELETE /api/projects/:id — creator or SYS_ADMIN only. Cascades to members,
// tasks, assignees, comments, and activity via FK ON DELETE CASCADE.
router.delete('/projects/:id', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.DELETE);
  await pool.execute('DELETE FROM projects WHERE id = ?', [projectId]);
  res.json({ success: true });
}));

// ── Members ──────────────────────────────────────────────────────────────────

// POST /api/projects/:id/members — add a member (MANAGE). Body: { portal_user_id }.
router.post('/projects/:id/members', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.MANAGE);

  const userId = P.parseId(req.body.portal_user_id, 'portal_user_id');
  const user = await loadPortalUser(pool, userId);

  if (await P.isMember(pool, projectId, userId)) {
    throw new P.ApiError(409, 'User is already a member of this project.', 'ALREADY_MEMBER');
  }
  await pool.execute(
    'INSERT INTO project_members (project_id, portal_user_id, added_by) VALUES (?,?,?)',
    [projectId, userId, actor.id]
  );
  await P.logActivity(pool, {
    projectId, actorId: actor.id, action: P.ACTIONS.MEMBER_ADDED,
    meta: { user_id: userId, name: user.name },
  });
  res.status(201).json({ id: user.id, name: user.name, email: user.email, portal_role: user.portal_role });
}));

// DELETE /api/projects/:id/members/:userId — remove a member (MANAGE).
// Also drops that user's task assignments within this project so no one stays
// assigned to a task in a project they're no longer part of.
router.delete('/projects/:id/members/:userId', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  const userId = P.parseId(req.params.userId, 'user id');
  const { project } = await P.authorizeProject(pool, actor, projectId, P.CAP.MANAGE);

  if (Number(userId) === Number(project.created_by)) {
    throw new P.ApiError(400, 'The project creator cannot be removed.', 'CANNOT_REMOVE_CREATOR');
  }
  if (!(await P.isMember(pool, projectId, userId))) {
    throw new P.ApiError(404, 'User is not a member of this project.', 'NOT_FOUND');
  }

  await tx(pool, async (conn) => {
    await conn.execute(
      `DELETE ta FROM task_assignees ta
         JOIN tasks t ON t.id = ta.task_id
        WHERE t.project_id = ? AND ta.portal_user_id = ?`,
      [projectId, userId]
    );
    await conn.execute(
      'DELETE FROM project_members WHERE project_id = ? AND portal_user_id = ?',
      [projectId, userId]
    );
    await P.logActivity(conn, {
      projectId, actorId: actor.id, action: P.ACTIONS.MEMBER_REMOVED, meta: { user_id: userId },
    });
  });
  res.json({ success: true });
}));

// ── Tasks ────────────────────────────────────────────────────────────────────

// GET /api/projects/:id/tasks — list tasks with assignees (VIEW).
router.get('/projects/:id/tasks', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.VIEW);

  const [tasks] = await pool.execute(
    'SELECT * FROM tasks WHERE project_id = ? ORDER BY FIELD(status,\'todo\',\'in_progress\',\'done\'), created_at DESC',
    [projectId]
  );
  await attachAssignees(pool, tasks);
  res.json(tasks);
}));

// POST /api/projects/:id/tasks — create a task (ACT = any member or sys-admin).
// Assignees, if any, must already be members of the project.
router.post('/projects/:id/tasks', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await requireTaskControl(pool, actor, projectId, 'You are not allowed to create tasks in this project.');

  const data = P.validateTaskCreate(req.body);
  const assignees = await P.validateAssignees(pool, projectId, data.assignees);

  const task = await tx(pool, async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO tasks (project_id, title, description, status, priority, due_date, created_by) VALUES (?,?,?,?,?,?,?)',
      [projectId, data.title, data.description, data.status, data.priority, data.due_date, actor.id]
    );
    const taskId = result.insertId;
    for (const uid of assignees) {
      await conn.execute(
        'INSERT INTO task_assignees (task_id, portal_user_id, assigned_by) VALUES (?,?,?)',
        [taskId, uid, actor.id]
      );
    }
    await P.logActivity(conn, {
      projectId, taskId, actorId: actor.id, action: P.ACTIONS.TASK_CREATED, meta: { title: data.title },
    });
    if (assignees.length) {
      await P.logActivity(conn, {
        projectId, taskId, actorId: actor.id, action: P.ACTIONS.TASK_ASSIGNED, meta: { added: assignees },
      });
    }
    const [rows] = await conn.execute('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return rows[0];
  });

  await attachAssignees(pool, [task]);
  res.status(201).json(task);
}));

// GET /api/tasks/:taskId — task detail + assignees + comments (VIEW).
router.get('/tasks/:taskId', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const taskId = P.parseId(req.params.taskId, 'task id');
  const task = await P.loadTask(pool, taskId);
  await P.authorizeProject(pool, actor, task.project_id, P.CAP.VIEW);

  await attachAssignees(pool, [task]);
  const [comments] = await pool.execute(
    `SELECT c.id, c.body, c.created_at, c.author_id, pu.name AS author_name, pu.email AS author_email
       FROM task_comments c JOIN portal_users pu ON pu.id = c.author_id
      WHERE c.task_id = ? ORDER BY c.created_at ASC`,
    [taskId]
  );
  res.json({ ...task, comments });
}));

// PATCH /api/tasks/:taskId — edit a task (ACT). A status change logs distinctly.
router.patch('/tasks/:taskId', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const taskId = P.parseId(req.params.taskId, 'task id');
  const task = await P.loadTask(pool, taskId);
  const project = await P.loadProject(pool, task.project_id);
  const member = await P.isMember(pool, task.project_id, actor.id);
  if (!P.can(P.CAP.VIEW, actor, project, member)) {
    throw new P.ApiError(403, 'You do not have access to this task.', 'FORBIDDEN');
  }

  const fields = P.validateTaskUpdate(req.body);
  // Limited members (allow_member_tasks off) may ONLY change the status of a
  // task assigned to them — nothing else.
  if (!P.fullTaskControl(actor, project, member)) {
    const assigned = await P.isAssignee(pool, taskId, actor.id);
    if (!assigned) {
      throw new P.ApiError(403, 'You can only update tasks assigned to you.', 'FORBIDDEN');
    }
    if (Object.keys(fields).some((k) => k !== 'status')) {
      throw new P.ApiError(403, 'You can only change the status of your assigned tasks.', 'FORBIDDEN', { allowed: ['status'] });
    }
  }
  const cols = Object.keys(fields);
  const setSql = cols.map((c) => `${c} = ?`).join(', ');
  await pool.execute(`UPDATE tasks SET ${setSql} WHERE id = ?`, [...cols.map((c) => fields[c]), taskId]);

  if ('status' in fields && fields.status !== task.status) {
    await P.logActivity(pool, {
      projectId: task.project_id, taskId, actorId: actor.id,
      action: P.ACTIONS.TASK_STATUS_CHANGED, meta: { from: task.status, to: fields.status },
    });
  }
  const nonStatus = cols.filter((c) => c !== 'status');
  if (nonStatus.length) {
    await P.logActivity(pool, {
      projectId: task.project_id, taskId, actorId: actor.id,
      action: P.ACTIONS.TASK_UPDATED, meta: { fields: nonStatus },
    });
  }

  const [rows] = await pool.execute('SELECT * FROM tasks WHERE id = ?', [taskId]);
  await attachAssignees(pool, rows);
  res.json(rows[0]);
}));

// PUT /api/tasks/:taskId/assignees — replace the assignee set (ACT).
// Body: { assignee_ids: [..] }. Every id must be a member of the project.
router.put('/tasks/:taskId/assignees', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const taskId = P.parseId(req.params.taskId, 'task id');
  const task = await P.loadTask(pool, taskId);
  await requireTaskControl(pool, actor, task.project_id, 'You are not allowed to change assignees in this project.');

  const next = await P.validateAssignees(pool, task.project_id, req.body.assignee_ids);
  const [currentRows] = await pool.execute(
    'SELECT portal_user_id FROM task_assignees WHERE task_id = ?', [taskId]
  );
  const current = new Set(currentRows.map((r) => Number(r.portal_user_id)));
  const nextSet = new Set(next);
  const toAdd = next.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !nextSet.has(id));

  await tx(pool, async (conn) => {
    for (const uid of toAdd) {
      await conn.execute(
        'INSERT INTO task_assignees (task_id, portal_user_id, assigned_by) VALUES (?,?,?)',
        [taskId, uid, actor.id]
      );
    }
    for (const uid of toRemove) {
      await conn.execute(
        'DELETE FROM task_assignees WHERE task_id = ? AND portal_user_id = ?', [taskId, uid]
      );
    }
    if (toAdd.length)    await P.logActivity(conn, { projectId: task.project_id, taskId, actorId: actor.id, action: P.ACTIONS.TASK_ASSIGNED,   meta: { added: toAdd } });
    if (toRemove.length) await P.logActivity(conn, { projectId: task.project_id, taskId, actorId: actor.id, action: P.ACTIONS.TASK_UNASSIGNED, meta: { removed: toRemove } });
  });

  const [rows] = await pool.execute('SELECT * FROM tasks WHERE id = ?', [taskId]);
  await attachAssignees(pool, rows);
  res.json(rows[0]);
}));

// DELETE /api/tasks/:taskId — delete a task (ACT). Cascades assignees/comments.
router.delete('/tasks/:taskId', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const taskId = P.parseId(req.params.taskId, 'task id');
  const task = await P.loadTask(pool, taskId);
  await requireTaskControl(pool, actor, task.project_id, 'You are not allowed to delete tasks in this project.');

  await pool.execute('DELETE FROM tasks WHERE id = ?', [taskId]);
  await P.logActivity(pool, {
    projectId: task.project_id, taskId: null, actorId: actor.id,
    action: P.ACTIONS.TASK_DELETED, meta: { task_id: taskId, title: task.title },
  });
  res.json({ success: true });
}));

// ── Comments (project-level and task-level) ──────────────────────────────────

// GET /api/projects/:id/comments — project-level comments (VIEW).
router.get('/projects/:id/comments', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.VIEW);
  const [rows] = await pool.execute(
    `SELECT c.id, c.body, c.created_at, c.author_id, pu.name AS author_name, pu.email AS author_email
       FROM task_comments c JOIN portal_users pu ON pu.id = c.author_id
      WHERE c.project_id = ? AND c.task_id IS NULL ORDER BY c.created_at ASC`,
    [projectId]
  );
  res.json(rows);
}));

// POST /api/projects/:id/comments — comment on a project (ACT).
router.post('/projects/:id/comments', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await requireTaskControl(pool, actor, projectId, 'You can only comment on tasks assigned to you in this project.');
  const { body } = P.validateComment(req.body);

  const [result] = await pool.execute(
    'INSERT INTO task_comments (project_id, task_id, author_id, body) VALUES (?,?,?,?)',
    [projectId, null, actor.id, body]
  );
  await P.logActivity(pool, {
    projectId, actorId: actor.id, action: P.ACTIONS.COMMENT_ADDED, meta: { scope: 'project', comment_id: result.insertId },
  });
  res.status(201).json({ id: result.insertId, project_id: projectId, task_id: null, body, author_id: actor.id, author_name: req.user.name });
}));

// POST /api/tasks/:taskId/comments — comment on a task (ACT).
router.post('/tasks/:taskId/comments', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const taskId = P.parseId(req.params.taskId, 'task id');
  const task = await P.loadTask(pool, taskId);
  const project = await P.loadProject(pool, task.project_id);
  const member = await P.isMember(pool, task.project_id, actor.id);
  // Full controllers can comment on any task; a limited member can comment only
  // on tasks assigned to them.
  const allowed = P.fullTaskControl(actor, project, member)
    || (member && await P.isAssignee(pool, taskId, actor.id));
  if (!allowed) {
    throw new P.ApiError(403, 'You can only comment on tasks assigned to you.', 'FORBIDDEN');
  }
  const { body } = P.validateComment(req.body);

  const [result] = await pool.execute(
    'INSERT INTO task_comments (project_id, task_id, author_id, body) VALUES (?,?,?,?)',
    [task.project_id, taskId, actor.id, body]
  );
  await P.logActivity(pool, {
    projectId: task.project_id, taskId, actorId: actor.id,
    action: P.ACTIONS.COMMENT_ADDED, meta: { scope: 'task', comment_id: result.insertId },
  });
  res.status(201).json({ id: result.insertId, project_id: task.project_id, task_id: taskId, body, author_id: actor.id, author_name: req.user.name });
}));

// ── Progress & activity ──────────────────────────────────────────────────────

// GET /api/projects/:id/progress — completion % + per-status breakdown (VIEW).
router.get('/projects/:id/progress', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.VIEW);
  res.json(await P.computeProgress(pool, projectId));
}));

// GET /api/projects/:id/activity — recent activity feed (VIEW).
router.get('/projects/:id/activity', gate, ah(async (req, res) => {
  const actor = actorOf(req);
  const pool = await getDB();
  const projectId = P.parseId(req.params.id, 'project id');
  await P.authorizeProject(pool, actor, projectId, P.CAP.VIEW);
  const [rows] = await pool.execute(
    `SELECT a.id, a.task_id, a.action, a.meta_json, a.created_at, a.actor_id,
            pu.name AS actor_name, pu.email AS actor_email
       FROM project_activity a
       LEFT JOIN portal_users pu ON pu.id = a.actor_id
      WHERE a.project_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 100`,
    [projectId]
  );
  res.json(rows.map((r) => ({ ...r, meta: parseMeta(r.meta_json), meta_json: undefined })));
}));

module.exports = router;
