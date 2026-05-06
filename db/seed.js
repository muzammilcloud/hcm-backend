const { hashPassword } = require('../db');

async function seedDummyData(pool) {
  const [{ 0: { c } }] = await pool.execute('SELECT COUNT(*) as c FROM employees');
  if (c > 0) return;

  console.log('🌱 Seeding dummy data...');

  const pw = hashPassword('password123');

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION A — 6 supporting employees (for admin to manage)
  // ─────────────────────────────────────────────────────────────────────────
  const supportDefs = [
    { name: 'Ali Hassan',   email: 'ali@quecko.com',    department: 'Frontend' },
    { name: 'Sara Ahmed',   email: 'sara@quecko.com',   department: 'Backend'  },
    { name: 'Omar Sheikh',  email: 'omar@quecko.com',   department: 'DevOps'   },
    { name: 'Fatima Khan',  email: 'fatima@quecko.com', department: 'UI/UX'    },
    { name: 'Bilal Raza',   email: 'bilal@quecko.com',  department: 'QA'       },
    { name: 'Zara Malik',   email: 'zara@quecko.com',   department: 'HR'       },
  ];
  const supportIds = [];
  for (const e of supportDefs) {
    const [r] = await pool.execute(
      'INSERT INTO employees (name, email, password_hash, role, department, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [e.name, e.email, pw, 'Employee', e.department]
    );
    supportIds.push(r.insertId);
  }

  // Basic salaries for supporting cast
  const supportSalaries = [
    [85000,34000,6000,5000,4000],
    [90000,36000,6000,5000,4000],
    [95000,38000,6000,5000,4000],
    [80000,32000,6000,5000,4000],
    [75000,30000,6000,5000,4000],
    [70000,28000,6000,5000,4000],
  ];
  for (let i = 0; i < supportIds.length; i++) {
    const [b,hr,cv,md,ut] = supportSalaries[i];
    await pool.execute(
      'INSERT INTO employee_salaries (employee_id, basic_salary, house_rent, conveyance, medical, utilities) VALUES (?,?,?,?,?,?)',
      [supportIds[i], b, hr, cv, md, ut]
    );
  }

  // Minimal time entries for supporting employees (admin views)
  const supportPattern = [
    [1,9],[2,10.5],[3,8.5],[4,9.5],[5,9],[7,8.5],[8,10],[9,9],[10,9.5],[11,8],
    [13,9],[14,10.5],[15,9],[16,8.5],[17,9.5],[18,9],[20,10],[21,9],[22,8.5],[24,9.5],
  ];
  for (const sid of supportIds) {
    for (const [da, hrs] of supportPattern) {
      const ci = daysAgoAt9(da);
      const co = new Date(ci.getTime() + hrs * 3600000);
      const [r] = await pool.execute(
        'INSERT INTO time_entries (employee_id, clock_in, clock_out, notes, ot_decision) VALUES (?,?,?,?,?)',
        [sid, ci, co, 'Seed', hrs > 9 ? 'continue' : null]
      );
      if (hrs > 9) {
        const d = fmtDate(ci);
        await pool.execute(
          `INSERT INTO ot_requests (time_entry_id, employee_id, date, total_hours, ot_hours, status, admin_note)
           VALUES (?,?,?,?,?,?,?)`,
          [r.insertId, sid, d, +hrs.toFixed(2), +(hrs-9).toFixed(2), 'approved', 'Approved']
        );
      }
    }
    // Basic leave request per supporting employee
    const lv = daysAgoAt9(10);
    await pool.execute(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, status) VALUES (?,?,?,?,?,?)',
      [sid, 'Annual Leave', fmtDate(lv), fmtDate(lv), 'Personal day', 'approved']
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SECTION B — PRIMARY TEST USER: muzammilquecko@gmail.com
  // All possible employee use cases covered
  // ─────────────────────────────────────────────────────────────────────────
  const [mainRes] = await pool.execute(
    'INSERT INTO employees (name, email, password_hash, role, department, is_active) VALUES (?,?,?,?,?,1)',
    ['Muzammil', 'muzammilquecko@gmail.com', pw, 'Employee', 'Frontend']
  );
  const uid = mainRes.insertId;

  // ── Salary package ────────────────────────────────────────────────────────
  // basic=100k, hr=40k, conv=8k, med=6k, util=5k → gross=159k
  await pool.execute(
    'INSERT INTO employee_salaries (employee_id, basic_salary, house_rent, conveyance, medical, utilities) VALUES (?,?,?,?,?,?)',
    [uid, 100000, 40000, 8000, 6000, 5000]
  );

  // ── Salary history (Jan + Feb 2026) ───────────────────────────────────────
  // gross=159000, pf=8000 (5% basic rounded), tax=11350, net=139650
  const salaryRows = [
    ['2026-01-01', 27], // Jan — 27 days worked
    ['2026-02-01', 24], // Feb — 24 days worked
  ];
  for (const [month, days] of salaryRows) {
    await pool.execute(
      `INSERT INTO salary_history
         (employee_id, month, basic_salary, house_rent, conveyance, medical, utilities,
          gross_salary, provident_fund, withholding_tax, total_deductions, net_salary, days_worked)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, month, 100000, 40000, 8000, 6000, 5000, 159000, 8000, 11350, 19350, 139650, days]
    );
  }

  // ── Time entries — comprehensive history ─────────────────────────────────
  //
  // Scenarios covered:
  //  A) Active session right now   → can test clock-out
  //  B) Normal day (8-9h)          → regular attendance
  //  C) Short day (<8h)            → under-hours
  //  D) OT day, decision=continue  → shows in OT report, creates OT request
  //  E) OT day, decision=stopped   → capped at 9h exactly (no OT request)
  //  F) Multiple sessions same day → history shows separate entries
  //
  // OT request states:
  //  G) pending  — admin hasn't reviewed yet
  //  H) approved — admin approved with note
  //  I) denied   — admin denied with note

  // Helper: insert a time entry and return its id
  const insertEntry = async (daysAgo, hoursWorked, decision = null, notesText = '') => {
    const ci = daysAgoAt9(daysAgo);
    const co = new Date(ci.getTime() + hoursWorked * 3600000);
    const [r] = await pool.execute(
      'INSERT INTO time_entries (employee_id, clock_in, clock_out, notes, ot_decision) VALUES (?,?,?,?,?)',
      [uid, ci, co, notesText || 'Seed data', decision]
    );
    return { id: r.insertId, ci, co, hours: hoursWorked };
  };

  // ── A) Active session (currently clocked in — no clock_out) ──────────────
  // Clocked in 2.5h ago today → employee can test clock-out right now
  const activeCI = new Date(Date.now() - 2.5 * 3600000);
  await pool.execute(
    'INSERT INTO time_entries (employee_id, clock_in, notes) VALUES (?,?,?)',
    [uid, activeCI, 'Active session — test clock-out here']
  );

  // ── B) Normal days — March 2026 ───────────────────────────────────────────
  const normalMarch = await insertEntry(1,  9.0,  null,       'Normal day');   // Mar 14
  const nm2         = await insertEntry(3,  8.5,  null,       'Normal day');   // Mar 12
  const nm3         = await insertEntry(5,  8.0,  null,       'Short day');    // Mar 10 — C) short
  const nm4         = await insertEntry(6,  9.0,  null,       'Normal day');   // Mar 9
  const nm5         = await insertEntry(8,  8.5,  null,       'Normal day');   // Mar 7
  const nm6         = await insertEntry(10, 9.0,  null,       'Normal day');   // Mar 5
  const nm7         = await insertEntry(11, 8.5,  null,       'Normal day');   // Mar 4

  // ── C) Short day ──────────────────────────────────────────────────────────
  const short1 = await insertEntry(13, 6.5, null, 'Left early — appointment'); // Mar 2
  const short2 = await insertEntry(20, 7.0, null, 'Half day');                 // Feb 23

  // ── D) OT days — decision: continue (creates OT requests) ────────────────
  const otCont1 = await insertEntry(2,  10.5, 'continue', 'Sprint deadline');  // Mar 13 → PENDING
  const otCont2 = await insertEntry(4,  11.0, 'continue', 'Release prep');     // Mar 11 → APPROVED
  const otCont3 = await insertEntry(7,  9.5,  'continue', 'Bug fixes');        // Mar 8  → APPROVED
  const otCont4 = await insertEntry(9,  10.0, 'continue', 'Code review');      // Mar 6  → DENIED
  const otCont5 = await insertEntry(14, 10.5, 'continue', 'Feature work');     // Mar 1  → PENDING
  const otCont6 = await insertEntry(16, 9.5,  'continue', 'Client demo prep'); // Feb 27 → APPROVED
  const otCont7 = await insertEntry(18, 11.5, 'continue', 'Hotfix deployment');// Feb 25 → APPROVED
  const otCont8 = await insertEntry(21, 10.0, 'continue', 'Sprint planning');  // Feb 22 → DENIED
  const otCont9 = await insertEntry(23, 9.5,  'continue', 'QA support');       // Feb 20 → PENDING
  const otCont10= await insertEntry(28, 10.5, 'continue', 'Month-end tasks');  // Feb 15 → APPROVED

  // ── E) OT day — decision: stopped (capped at 9h, NO OT request) ──────────
  // clock_in at 9 AM, we manually set clock_out to exactly 9h later
  const stoppedCI = daysAgoAt9(12); // Mar 3
  const stoppedCO = new Date(stoppedCI.getTime() + 9 * 3600000);
  await pool.execute(
    'INSERT INTO time_entries (employee_id, clock_in, clock_out, notes, ot_decision) VALUES (?,?,?,?,?)',
    [uid, stoppedCI, stoppedCO, 'Chose to cap at 9h (no OT recorded)', 'stopped']
  );

  // ── F) Multiple sessions in one day ───────────────────────────────────────
  // Feb 18 — two separate sessions (morning + afternoon re-login)
  const ms1CI = daysAgoAt9(25);                                       // 9:00 AM
  const ms1CO = new Date(ms1CI.getTime() + 4 * 3600000);              // 1:00 PM
  const ms2CI = new Date(ms1CI.getTime() + 5 * 3600000);              // 2:00 PM
  const ms2CO = new Date(ms2CI.getTime() + 4 * 3600000);              // 6:00 PM
  await pool.execute(
    'INSERT INTO time_entries (employee_id, clock_in, clock_out, notes) VALUES (?,?,?,?)',
    [uid, ms1CI, ms1CO, 'Morning session (multi-session day)']
  );
  await pool.execute(
    'INSERT INTO time_entries (employee_id, clock_in, clock_out, notes) VALUES (?,?,?,?)',
    [uid, ms2CI, ms2CO, 'Afternoon session (multi-session day)']
  );

  // ── Insert OT Requests for D) entries ─────────────────────────────────────
  const otEntries = [
    { e: otCont1,  status: 'pending',  note: null,                                   },
    { e: otCont2,  status: 'approved', note: 'Approved — release was critical'        },
    { e: otCont3,  status: 'approved', note: 'Approved — production bug fix'          },
    { e: otCont4,  status: 'denied',   note: 'Code review should be done in hours'    },
    { e: otCont5,  status: 'pending',  note: null,                                   },
    { e: otCont6,  status: 'approved', note: 'Approved — client demo preparation'     },
    { e: otCont7,  status: 'approved', note: 'Approved — hotfix was production P0'    },
    { e: otCont8,  status: 'denied',   note: 'Sprint planning should fit work hours'  },
    { e: otCont9,  status: 'pending',  note: null,                                   },
    { e: otCont10, status: 'approved', note: 'Approved — month-end reporting deadline'},
  ];
  for (const { e, status, note } of otEntries) {
    await pool.execute(
      `INSERT INTO ot_requests (time_entry_id, employee_id, date, total_hours, ot_hours, status, admin_note)
       VALUES (?,?,?,?,?,?,?)`,
      [e.id, uid, fmtDate(e.ci), +e.hours.toFixed(2), +(e.hours-9).toFixed(2), status, note]
    );
  }

  // ── Leave Requests — ALL types, ALL statuses ──────────────────────────────
  //
  // Types:    Annual Leave, Sick Leave, Casual Leave, Work From Home, Unpaid Leave
  // Statuses: approved, pending, denied
  // Extras:   past, current week, future; single day, multi-day, half-day

  const leaveRows = [
    // ── APPROVED ──
    // Annual Leave — multi-day past (Feb 16-17, approved)
    { type:'Annual Leave',  sDA:27, eDA:26, reason:'Family gathering',                status:'approved', note:null                              },
    // Sick Leave — single day past (Feb 9, approved)
    { type:'Sick Leave',    sDA:34, eDA:34, reason:'Fever and flu, visited doctor',   status:'approved', note:null                              },
    // Casual Leave — single day past (Feb 26, approved)
    { type:'Casual Leave',  sDA:17, eDA:17, reason:'Personal errand',                 status:'approved', note:null                              },
    // Work From Home — single day past (Mar 5, approved)
    { type:'Work From Home',sDA:10, eDA:10, reason:'ISP maintenance at office',       status:'approved', note:null                              },
    // Annual Leave — multi-day future (Mar 20-23, approved — booked in advance)
    { type:'Annual Leave',  sDA:-5, eDA:-8, reason:'Pre-approved Eid leave',          status:'approved', note:null                              },
    // Sick Leave — past (Jan 20, approved)
    { type:'Sick Leave',    sDA:54, eDA:54, reason:'Food poisoning',                  status:'approved', note:null                              },
    // Unpaid Leave — past (Jan 15, approved)
    { type:'Unpaid Leave',  sDA:59, eDA:59, reason:'Emergency family matter',         status:'approved', note:null                              },

    // ── PENDING ──
    // Casual Leave — upcoming (Mar 18, pending review)
    { type:'Casual Leave',  sDA:-3, eDA:-3, reason:'Driving licence renewal',         status:'pending',  note:null                              },
    // Annual Leave — far future (Apr 5-7, pending)
    { type:'Annual Leave',  sDA:-21,eDA:-23,reason:'Short trip planned with family',  status:'pending',  note:null                              },
    // Work From Home — tomorrow (Mar 16, pending)
    { type:'Work From Home',sDA:-1, eDA:-1, reason:'Plumber visit at home 10-12 AM',  status:'pending',  note:null                              },
    // Sick Leave — today (Mar 15, pending — submitted this morning)
    { type:'Sick Leave',    sDA:0,  eDA:0,  reason:'Not feeling well, may WFH',       status:'pending',  note:null                              },

    // ── DENIED ──
    // Unpaid Leave — denied (Feb 5, denied)
    { type:'Unpaid Leave',  sDA:38, eDA:38, reason:'Personal travel',                 status:'denied',   note:'Unpaid leave not approved during sprint week'  },
    // Annual Leave — denied (overlapped with another team member, Jan 25)
    { type:'Annual Leave',  sDA:49, eDA:51, reason:'Planned vacation',                status:'denied',   note:'Two team members already on leave same dates'   },
    // Casual Leave — denied (Mar 2, denied — too short notice)
    { type:'Casual Leave',  sDA:13, eDA:13, reason:'Personal work',                   status:'denied',   note:'Less than 24h notice for casual leave'          },
  ];

  for (const lr of leaveRows) {
    const s = futureSafeDate(lr.sDA);
    const e = futureSafeDate(lr.eDA);
    // Ensure start <= end
    const [startDate, endDate] = s <= e ? [s, e] : [e, s];
    await pool.execute(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason, status, admin_note) VALUES (?,?,?,?,?,?,?)',
      [uid, lr.type, startDate, endDate, lr.reason, lr.status, lr.note || null]
    );
  }

  // ── Public Holidays ───────────────────────────────────────────────────────
  const holidays = [
    ['Pakistan Day',        '2026-03-23'],
    ['Eid ul-Fitr (est)',   '2026-04-01'],
    ['Eid ul-Fitr (est)',   '2026-04-02'],
    ['Labour Day',          '2026-05-01'],
    ['Eid ul-Adha (est)',   '2026-06-17'],
    ['Eid ul-Adha (est)',   '2026-06-18'],
    ['Independence Day',    '2026-08-14'],
    ['Eid Milad-un-Nabi',   '2026-09-05'],
    ['Christmas / Quaid Day','2026-12-25'],
  ];
  for (const [name, date] of holidays) {
    await pool.execute('INSERT IGNORE INTO public_holidays (name, date) VALUES (?,?)', [name, date]);
  }

  console.log(`✅ Dummy data seeded successfully!

  ── Support employees (for admin views) ──────────────────────
  Ali Hassan      ali@quecko.com       Frontend
  Sara Ahmed      sara@quecko.com      Backend
  Omar Sheikh     omar@quecko.com      DevOps
  Fatima Khan     fatima@quecko.com    UI/UX
  Bilal Raza      bilal@quecko.com     QA
  Zara Malik      zara@quecko.com      HR

  ── Primary test user ─────────────────────────────────────────
  Muzammil        muzammilquecko@gmail.com   Frontend
  Password:       password123

  Covers every employee flow:
  ✓ Active clock-in (2.5h ago) — test clock-out right now
  ✓ Normal days, short days, OT days, capped OT (stopped)
  ✓ Multi-session day (2 entries same day)
  ✓ OT requests: 3 pending, 5 approved, 2 denied
  ✓ Leave: 7 approved, 4 pending, 3 denied — all 5 leave types
  ✓ Upcoming approved leave (Mar 20-23) + future pending
  ✓ Salary package (PKR 159k gross) + 2 months history (Jan & Feb)
  ✓ Public holidays seeded for calendar view
  `);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function daysAgoAt9(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(9, 0, 0, 0);
  return d;
}

// negative daysAgo = future date
function futureSafeDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

module.exports = { seedDummyData };
