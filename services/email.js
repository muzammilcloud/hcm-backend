const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendInviteEmail({ name, email, inviteToken }) {
  const baseUrl   = process.env.FRONTEND_URL || 'http://localhost:5173';
  const inviteUrl = `${baseUrl}/set-password?token=${inviteToken}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
      <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
        <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px;text-align:center;">
          <div style="font-size:36px;margin-bottom:8px;">⏱</div>
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Welcome to Quecko-HCM</h1>
          <p style="margin:8px 0 0;color:#e0e7ff;font-size:14px;">Time Tracking System</p>
        </div>
        <div style="padding:32px;">
          <p style="color:#94a3b8;font-size:15px;margin:0 0 16px;">Hi <strong style="color:#f1f5f9;">${name}</strong>,</p>
          <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;">You've been invited to join <strong style="color:#f1f5f9;">Quecko-HCM</strong>. Click the button below to set your password and activate your account.</p>
          <div style="background:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;">
            <div style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Your Login Email</div>
            <div style="font-size:16px;color:#f1f5f9;font-weight:600;">${email}</div>
          </div>
          <a href="${inviteUrl}" style="display:block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;margin-bottom:24px;">
            🔐 Set My Password &amp; Login →
          </a>
          <p style="color:#475569;font-size:12px;margin:0 0 8px;text-align:center;">This invite link expires in <strong>7 days</strong>.</p>
          <p style="color:#334155;font-size:11px;margin:0;text-align:center;word-break:break-all;">Or copy this link: ${inviteUrl}</p>
        </div>
        <div style="background:#090e1a;padding:16px;text-align:center;border-top:1px solid #1e293b;">
          <p style="margin:0;color:#334155;font-size:12px;">Quecko-HCM · Time Tracking System</p>
        </div>
      </div>
    </body>
    </html>
  `;
  try {
    await transporter.sendMail({
      from:    `"Quecko-HCM" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: '🎉 You\'re invited to Quecko-HCM — Set your password',
      html,
    });
    console.log(`✅ Invite email sent to ${email}`);
    return true;
  } catch (e) {
    console.error(`❌ Email failed to ${email}:`, e.message);
    return false;
  }
}

async function sendLeaveRequestEmail({ employeeName, department, leaveType, startDate, endDate, duration, reason }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  const durationLabel = duration === 'full' ? 'Full Day' : duration === 'half_am' ? 'Morning (Half Day)' : 'Afternoon (Half Day)';
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;text-align:center;">
        <div style="font-size:28px;">🏖</div>
        <h2 style="margin:8px 0 0;color:#fff;font-size:20px;">New Leave Request</h2>
      </div>
      <div style="padding:28px;">
        <p style="color:#94a3b8;margin:0 0 20px;font-size:15px;"><strong style="color:#f1f5f9;">${employeeName}</strong> (${department}) has submitted a leave request.</p>
        <table style="width:100%;border-collapse:collapse;">
          ${[['Leave Type',leaveType],['Duration',durationLabel],['From',startDate],['To',endDate],['Reason',reason||'—']].map(([k,v])=>`<tr><td style="padding:10px 14px;background:#1e293b;color:#64748b;font-size:13px;font-weight:600;width:120px;">${k}</td><td style="padding:10px 14px;color:#f1f5f9;font-size:13px;">${v}</td></tr>`).join('')}
        </table>
        <p style="color:#475569;font-size:13px;margin:20px 0 0;">Login to <strong style="color:#a5b4fc;">Quecko-HCM</strong> to approve or deny this request.</p>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({ from:`"Quecko-HCM" <${process.env.SMTP_USER}>`, to:adminEmail, subject:`🏖 Leave Request — ${employeeName} (${leaveType})`, html });
  } catch(e) { console.error('Leave request email failed:', e.message); }
}

async function sendLeaveStatusEmail({ employeeEmail, employeeName, status, leaveType, startDate, endDate, adminNote }) {
  if (!employeeEmail) return;
  const isApproved = status === 'approved';
  const color = isApproved ? '#10b981' : '#ef4444';
  const icon  = isApproved ? '✅' : '❌';
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:${color};padding:24px;text-align:center;">
        <div style="font-size:28px;">${icon}</div>
        <h2 style="margin:8px 0 0;color:#fff;font-size:20px;">Leave ${isApproved?'Approved':'Denied'}</h2>
      </div>
      <div style="padding:28px;">
        <p style="color:#94a3b8;margin:0 0 20px;font-size:15px;">Hi <strong style="color:#f1f5f9;">${employeeName}</strong>, your leave request has been <strong style="color:${color};">${status}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;">
          ${[['Leave Type',leaveType],['From',startDate],['To',endDate],adminNote?['Admin Note',adminNote]:null].filter(Boolean).map(([k,v])=>`<tr><td style="padding:10px 14px;background:#1e293b;color:#64748b;font-size:13px;font-weight:600;width:120px;">${k}</td><td style="padding:10px 14px;color:#f1f5f9;font-size:13px;">${v}</td></tr>`).join('')}
        </table>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({ from:`"Quecko-HCM" <${process.env.SMTP_USER}>`, to:employeeEmail, subject:`${icon} Your leave request has been ${status}`, html });
  } catch(e) { console.error('Leave status email failed:', e.message); }
}

async function sendReportEmail({ to, subject, title, subtitle, rows, columns }) {
  if (!to) return;
  const headerRow = columns.map(c=>`<th style="padding:10px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">${c.label}</th>`).join('');
  const dataRows  = rows.map((r,i)=>`<tr style="background:${i%2===0?'transparent':'#0a1525'}">${columns.map(c=>`<td style="padding:10px 14px;color:#f1f5f9;font-size:13px;border-top:1px solid #1e293b;">${r[c.key]??'—'}</td>`).join('')}</tr>`).join('');
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:640px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;text-align:center;">
        <div style="font-size:28px;">📊</div>
        <h2 style="margin:8px 0 0;color:#fff;font-size:20px;">${title}</h2>
        <p style="margin:6px 0 0;color:#e0e7ff;font-size:13px;">${subtitle}</p>
      </div>
      <div style="padding:28px;">
        <table style="width:100%;border-collapse:collapse;"><thead><tr>${headerRow}</tr></thead><tbody>${dataRows}</tbody></table>
        <p style="color:#334155;font-size:12px;margin:20px 0 0;text-align:center;">Quecko-HCM · Time Tracking System</p>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({ from:`"Quecko-HCM" <${process.env.SMTP_USER}>`, to, subject, html });
  } catch(e) { console.error(`Report email to ${to} failed:`, e.message); }
}

async function sendPasswordResetEmail({ name, email, resetToken }) {
  const baseUrl   = process.env.FRONTEND_URL || 'http://localhost:5173';
  const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
      <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
        <div style="background:linear-gradient(135deg,#f59e0b,#f97316);padding:32px;text-align:center;">
          <div style="font-size:36px;margin-bottom:8px;">🔑</div>
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Password Reset</h1>
          <p style="margin:8px 0 0;color:#fed7aa;font-size:14px;">Quecko-HCM Time Tracking</p>
        </div>
        <div style="padding:32px;">
          <p style="color:#94a3b8;font-size:15px;margin:0 0 16px;">Hi <strong style="color:#f1f5f9;">${name}</strong>,</p>
          <p style="color:#94a3b8;font-size:15px;margin:0 0 24px;">We received a request to reset your password. Click the button below to set a new password.</p>
          <a href="${resetUrl}" style="display:block;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;margin-bottom:24px;">
            🔐 Reset My Password →
          </a>
          <p style="color:#475569;font-size:12px;margin:0 0 8px;text-align:center;">This link expires in <strong>1 hour</strong>.</p>
          <p style="color:#334155;font-size:11px;margin:0;text-align:center;word-break:break-all;">Or copy: ${resetUrl}</p>
          <div style="background:#1e293b;border-radius:8px;padding:12px;margin-top:20px;">
            <p style="color:#94a3b8;font-size:12px;margin:0;">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
          </div>
        </div>
        <div style="background:#090e1a;padding:16px;text-align:center;border-top:1px solid #1e293b;">
          <p style="margin:0;color:#334155;font-size:12px;">Quecko-HCM · Time Tracking System</p>
        </div>
      </div>
    </body>
    </html>
  `;
  try {
    await transporter.sendMail({
      from:    `"Quecko-HCM" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: '🔑 Reset Your Password — Quecko-HCM',
      html,
    });
    console.log(`✅ Password reset email sent to ${email}`);
    return true;
  } catch (e) {
    console.error(`❌ Password reset email failed to ${email}:`, e.message);
    return false;
  }
}

async function sendSalarySlipEmail(employee, slip, monthLabel) {
  const fmtRs = (n) => {
    const num = parseFloat(n) || 0;
    return `Rs. ${new Intl.NumberFormat('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num)}`;
  };

  const today = new Date();
  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const todayLabel = `${today.getDate()}-${shortMonths[today.getMonth()]}-${today.getFullYear()}`;

  const row = (label, value, labelColor = '#64748b', valueColor = '#f1f5f9') =>
    `<tr>
      <td style="padding:8px 12px;border:1px solid #334155;color:${labelColor};font-size:12px;background:#0f172a;">${label}</td>
      <td style="padding:8px 12px;border:1px solid #334155;color:${valueColor};font-size:12px;font-weight:600;text-align:right;background:#0f172a;">${value}</td>
    </tr>`;

  const html = `
  <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">

    <!-- Header -->
    <div style="background:#0f172a;padding:24px 28px 0;text-align:center;border-bottom:1px solid #1e293b;">
      <a href="https://www.quecko.com" style="color:#3b82f6;font-size:14px;font-weight:700;text-decoration:none;">www.Quecko.com</a>
      <h1 style="margin:10px 0 4px;color:#f1f5f9;font-size:22px;font-weight:800;">Quecko Inc.</h1>
      <p style="margin:0 0 0;color:#94a3b8;font-size:14px;font-weight:600;">Salary Slip</p>
    </div>

    <!-- Month row -->
    <div style="display:flex;justify-content:space-between;padding:10px 28px;background:#1e293b;border-bottom:1px solid #334155;">
      <span style="color:#f1f5f9;font-size:13px;font-weight:700;">Salary for the month of ${monthLabel}</span>
      <span style="color:#94a3b8;font-size:13px;">${todayLabel}</span>
    </div>

    <div style="padding:24px 28px;">

      <!-- Employee Details -->
      <div style="margin-bottom:20px;">
        <div style="background:#1e293b;padding:8px 12px;border-radius:6px 6px 0 0;margin-bottom:0;">
          <span style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Employee Details</span>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:8px 12px;border:1px solid #334155;color:#64748b;font-size:12px;font-weight:600;width:140px;">Name</td>
            <td style="padding:8px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;">${employee.name}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #334155;color:#64748b;font-size:12px;font-weight:600;">Designation</td>
            <td style="padding:8px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;">${employee.role}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #334155;color:#64748b;font-size:12px;font-weight:600;">Department</td>
            <td style="padding:8px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;">${employee.department}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #334155;color:#64748b;font-size:12px;font-weight:600;">Employee ID</td>
            <td style="padding:8px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;">${employee.id}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #334155;color:#64748b;font-size:12px;font-weight:600;">Days Worked</td>
            <td style="padding:8px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;">${slip.days_worked}</td>
          </tr>
        </table>
      </div>

      <!-- Salary Details — two columns side by side -->
      <div style="margin-bottom:20px;">
        <div style="background:#1e293b;padding:8px 12px;border-radius:6px 6px 0 0;">
          <span style="color:#f1f5f9;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Salary Details</span>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr>
              <th style="padding:8px 12px;background:#1e293b;color:#10b981;font-size:12px;font-weight:700;border:1px solid #334155;text-align:center;" colspan="2">Earnings</th>
              <th style="padding:8px 12px;background:#1e293b;color:#f87171;font-size:12px;font-weight:700;border:1px solid #334155;text-align:center;" colspan="2">Deductions</th>
            </tr>
            <tr>
              <th style="padding:7px 12px;background:#0a0f1e;color:#475569;font-size:11px;font-weight:700;border:1px solid #334155;text-align:left;">Salary Head</th>
              <th style="padding:7px 12px;background:#0a0f1e;color:#475569;font-size:11px;font-weight:700;border:1px solid #334155;text-align:right;">Amount</th>
              <th style="padding:7px 12px;background:#0a0f1e;color:#475569;font-size:11px;font-weight:700;border:1px solid #334155;text-align:left;">Salary Head</th>
              <th style="padding:7px 12px;background:#0a0f1e;color:#475569;font-size:11px;font-weight:700;border:1px solid #334155;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Basic</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">${fmtRs(slip.basic_salary)}</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Leaves</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">Rs.0</td>
            </tr>
            <tr>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;font-style:italic;">Allowances</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;"></td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Advance</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">Rs.0</td>
            </tr>
            <tr>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">House Rent</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">${fmtRs(slip.house_rent)}</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Withholding Tax</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f87171;font-size:12px;text-align:right;">${fmtRs(slip.withholding_tax)}</td>
            </tr>
            <tr>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Conveyance</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">${fmtRs(slip.conveyance)}</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">EOBI</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">Rs.0</td>
            </tr>
            <tr>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Medical</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">${fmtRs(slip.medical)}</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Provident Fund</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f87171;font-size:12px;text-align:right;">${fmtRs(slip.provident_fund)}</td>
            </tr>
            <tr>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;">Utilities</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;">${fmtRs(slip.utilities)}</td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#94a3b8;font-size:12px;"></td>
              <td style="padding:7px 12px;border:1px solid #334155;color:#f1f5f9;font-size:12px;text-align:right;"></td>
            </tr>
            <!-- Totals row -->
            <tr>
              <td style="padding:9px 12px;border:1px solid #334155;background:#1e293b;color:#10b981;font-size:12px;font-weight:700;">Total Allowances</td>
              <td style="padding:9px 12px;border:1px solid #334155;background:#1e293b;color:#10b981;font-size:12px;font-weight:700;text-align:right;">${fmtRs(slip.gross_salary)}</td>
              <td style="padding:9px 12px;border:1px solid #334155;background:#1e293b;color:#f87171;font-size:12px;font-weight:700;">Total Deductions</td>
              <td style="padding:9px 12px;border:1px solid #334155;background:#1e293b;color:#f87171;font-size:12px;font-weight:700;text-align:right;">${fmtRs(slip.total_deductions)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Net Salary -->
      <div style="background:linear-gradient(135deg,#064e3b,#065f46);border:1px solid #10b981;border-radius:10px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <span style="color:#6ee7b7;font-size:14px;font-weight:700;">Net Salary (Take Home)</span>
        <span style="color:#34d399;font-size:20px;font-weight:800;">${fmtRs(slip.net_salary)}</span>
      </div>

      <!-- Footer -->
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #334155;padding-top:16px;">
        <tr>
          <td style="padding:12px 0 4px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;width:50%;">Prepared By</td>
          <td style="padding:12px 0 4px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;">Received By</td>
        </tr>
        <tr>
          <td style="padding:4px 0 0;color:#f1f5f9;font-size:13px;font-weight:600;">Anoosha Noor</td>
          <td style="padding:4px 0 0;color:#f1f5f9;font-size:13px;font-weight:600;">${employee.name}</td>
        </tr>
      </table>

    </div>

    <div style="background:#0a0f1e;padding:14px 28px;text-align:center;border-top:1px solid #1e293b;">
      <p style="margin:0;color:#334155;font-size:11px;">This is a computer-generated salary slip. No signature required.</p>
    </div>
  </div>
  </body>`;

  await transporter.sendMail({
    from: `"Quecko HR" <${process.env.SMTP_USER}>`,
    to: employee.email,
    subject: `Salary Slip — ${monthLabel}`,
    html,
  });
}

async function sendBirthdayReminderEmail({ adminEmail, employees }) {
  if (!adminEmail || !employees.length) return;
  const rows = employees.map(e =>
    `<tr>
      <td style="padding:10px 14px;border-top:1px solid #1e293b;color:#f1f5f9;font-size:13px;">${e.name}</td>
      <td style="padding:10px 14px;border-top:1px solid #1e293b;color:#94a3b8;font-size:13px;">${e.department}</td>
      <td style="padding:10px 14px;border-top:1px solid #1e293b;color:#a5b4fc;font-size:13px;">${new Date(e.date_of_birth + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</td>
    </tr>`
  ).join('');
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:28px;text-align:center;">
        <div style="font-size:36px;margin-bottom:8px;">🎂</div>
        <h2 style="margin:0;color:#fff;font-size:20px;font-weight:800;">Birthday Reminder</h2>
        <p style="margin:8px 0 0;color:#e0e7ff;font-size:13px;">Tomorrow's birthdays — don't forget to wish them!</p>
      </div>
      <div style="padding:28px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>
            <th style="padding:8px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">Employee</th>
            <th style="padding:8px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">Department</th>
            <th style="padding:8px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">Birthday</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#475569;font-size:13px;margin:20px 0 0;text-align:center;">Log in to <strong style="color:#a5b4fc;">Quecko-HCM</strong> to send personal wishes!</p>
      </div>
      <div style="background:#090e1a;padding:14px;text-align:center;border-top:1px solid #1e293b;">
        <p style="margin:0;color:#334155;font-size:12px;">Quecko-HCM · Time Tracking System</p>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({
      from:    `"Quecko-HCM" <${process.env.SMTP_USER}>`,
      to:      adminEmail,
      subject: `🎂 Birthday Reminder: ${employees.length} birthday${employees.length > 1 ? 's' : ''} tomorrow`,
      html,
    });
    console.log(`✅ Birthday reminder sent to admin (${employees.length} employee(s))`);
  } catch (e) { console.error('Birthday reminder email failed:', e.message); }
}

async function sendBirthdayGreetingEmail({ name, email }) {
  if (!email) return;
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6366f1,#ec4899);padding:44px 24px;text-align:center;">
        <div style="font-size:60px;margin-bottom:12px;">🎂</div>
        <h1 style="margin:0;color:#fff;font-size:28px;font-weight:800;">Happy Birthday!</h1>
      </div>
      <div style="padding:36px;text-align:center;">
        <h2 style="color:#f1f5f9;font-size:22px;font-weight:700;margin:0 0 16px;">🎉 Happy Birthday, ${name}!</h2>
        <p style="color:#94a3b8;font-size:15px;line-height:1.7;margin:0 0 24px;">Wishing you a wonderful birthday filled with joy and happiness. Thank you for being a valued member of our team — your dedication and hard work make a real difference every day!</p>
        <div style="background:#1e293b;border-radius:12px;padding:16px 24px;margin-bottom:24px;">
          <p style="color:#a5b4fc;font-size:16px;font-weight:600;margin:0;">Have a fantastic day! 🎊🎈</p>
        </div>
        <p style="color:#64748b;font-size:13px;margin:0;">With warm wishes,<br><strong style="color:#f1f5f9;">The Quecko Team</strong></p>
      </div>
      <div style="background:#090e1a;padding:14px;text-align:center;border-top:1px solid #1e293b;">
        <p style="margin:0;color:#334155;font-size:12px;">Quecko-HCM · Time Tracking System</p>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({
      from:    `"Quecko HR" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `🎂 Happy Birthday, ${name}! 🎉`,
      html,
    });
    console.log(`✅ Birthday greeting sent to ${name} <${email}>`);
  } catch (e) { console.error(`Birthday greeting failed for ${name}:`, e.message); }
}

async function sendAnniversaryReminderEmail({ adminEmail, employees }) {
  if (!adminEmail || !employees.length) return;
  const rows = employees.map(e =>
    `<tr>
      <td style="padding:10px 14px;border-top:1px solid #1e293b;color:#f1f5f9;font-size:13px;">${e.name}</td>
      <td style="padding:10px 14px;border-top:1px solid #1e293b;color:#94a3b8;font-size:13px;">${e.department}</td>
      <td style="padding:10px 14px;border-top:1px solid #1e293b;color:#6ee7b7;font-size:13px;font-weight:700;">${e.years} year${e.years !== 1 ? 's' : ''}</td>
    </tr>`
  ).join('');
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:linear-gradient(135deg,#064e3b,#065f46);padding:28px;text-align:center;">
        <div style="font-size:36px;margin-bottom:8px;">🏆</div>
        <h2 style="margin:0;color:#fff;font-size:20px;font-weight:800;">Work Anniversary Reminder</h2>
        <p style="margin:8px 0 0;color:#a7f3d0;font-size:13px;">Tomorrow's work anniversaries — celebrate their milestone!</p>
      </div>
      <div style="padding:28px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>
            <th style="padding:8px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">Employee</th>
            <th style="padding:8px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">Department</th>
            <th style="padding:8px 14px;background:#1e293b;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;text-align:left;">Years</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#475569;font-size:13px;margin:20px 0 0;text-align:center;">Log in to <strong style="color:#6ee7b7;">Quecko-HCM</strong> to celebrate their milestone!</p>
      </div>
      <div style="background:#090e1a;padding:14px;text-align:center;border-top:1px solid #1e293b;">
        <p style="margin:0;color:#334155;font-size:12px;">Quecko-HCM · Time Tracking System</p>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({
      from:    `"Quecko-HCM" <${process.env.SMTP_USER}>`,
      to:      adminEmail,
      subject: `🏆 Work Anniversary Reminder: ${employees.length} anniversary${employees.length > 1 ? 's' : ''} tomorrow`,
      html,
    });
    console.log(`✅ Anniversary reminder sent to admin (${employees.length} employee(s))`);
  } catch (e) { console.error('Anniversary reminder email failed:', e.message); }
}

async function sendAnniversaryGreetingEmail({ name, email, years }) {
  if (!email) return;
  const ordinal = years === 1 ? '1st' : years === 2 ? '2nd' : years === 3 ? '3rd' : `${years}th`;
  const html = `
    <body style="margin:0;padding:0;background:#020617;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:520px;margin:40px auto;background:#0f172a;border-radius:16px;overflow:hidden;border:1px solid #1e293b;">
      <div style="background:linear-gradient(135deg,#064e3b,#065f46,#0f766e);padding:44px 24px;text-align:center;">
        <div style="font-size:60px;margin-bottom:12px;">🏆</div>
        <h1 style="margin:0;color:#fff;font-size:28px;font-weight:800;">Happy Work Anniversary!</h1>
      </div>
      <div style="padding:36px;text-align:center;">
        <h2 style="color:#f1f5f9;font-size:22px;font-weight:700;margin:0 0 16px;">🎉 Congratulations, ${name}!</h2>
        <div style="background:#1e293b;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
          <div style="color:#6ee7b7;font-size:36px;font-weight:800;">${ordinal} Anniversary</div>
          <div style="color:#94a3b8;font-size:14px;margin-top:4px;">${years} year${years !== 1 ? 's' : ''} of excellence</div>
        </div>
        <p style="color:#94a3b8;font-size:15px;line-height:1.7;margin:0 0 24px;">Thank you for ${years} year${years !== 1 ? 's' : ''} of dedication and hard work. Your contributions have made a real impact and we're so grateful to have you on the team!</p>
        <p style="color:#64748b;font-size:13px;margin:0;">With appreciation,<br><strong style="color:#f1f5f9;">The Quecko Team</strong></p>
      </div>
      <div style="background:#090e1a;padding:14px;text-align:center;border-top:1px solid #1e293b;">
        <p style="margin:0;color:#334155;font-size:12px;">Quecko-HCM · Time Tracking System</p>
      </div>
    </div></body>`;
  try {
    await transporter.sendMail({
      from:    `"Quecko HR" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `🏆 Happy ${ordinal} Work Anniversary, ${name}! 🎉`,
      html,
    });
    console.log(`✅ Anniversary greeting sent to ${name} <${email}> (${years} yr${years !== 1 ? 's' : ''})`);
  } catch (e) { console.error(`Anniversary greeting failed for ${name}:`, e.message); }
}

module.exports = {
  transporter,
  sendInviteEmail,
  sendLeaveRequestEmail,
  sendLeaveStatusEmail,
  sendReportEmail,
  sendPasswordResetEmail,
  sendSalarySlipEmail,
  sendBirthdayReminderEmail,
  sendBirthdayGreetingEmail,
  sendAnniversaryReminderEmail,
  sendAnniversaryGreetingEmail,
};
