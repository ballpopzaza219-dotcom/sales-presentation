-- SiteReq PR module schema (PostgreSQL)
-- Finance/accounting module stays in-memory in the frontend for now — not represented here.

CREATE TABLE IF NOT EXISTS company (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_conditions (
  id SERIAL PRIMARY KEY,
  min_amount NUMERIC NOT NULL,
  max_amount NUMERIC,
  flow TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_requests (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  by_user_id INTEGER REFERENCES users(id),
  by_name TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB
);

CREATE TABLE IF NOT EXISTS prs (
  id SERIAL PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  site TEXT NOT NULL,
  sub_code TEXT NOT NULL DEFAULT '',
  requester_id INTEGER REFERENCES users(id),
  requester_name TEXT NOT NULL,
  requester_role TEXT NOT NULL,
  requester_position TEXT NOT NULL DEFAULT '',
  request_date DATE NOT NULL,
  needed_date DATE,
  remark TEXT NOT NULL DEFAULT '',
  foreman_user_id INTEGER REFERENCES users(id),
  foreman_name TEXT NOT NULL DEFAULT '',
  foreman_position TEXT NOT NULL DEFAULT '',
  foreman_date DATE,
  manager_user_id INTEGER REFERENCES users(id),
  manager_name TEXT NOT NULL DEFAULT '',
  manager_position TEXT NOT NULL DEFAULT '',
  manager_date DATE,
  status TEXT NOT NULL DEFAULT 'pending_check',
  step INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pr_items (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  material TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  qty NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pr_history (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
  who TEXT NOT NULL,
  action TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_items_pr_id ON pr_items(pr_id);
CREATE INDEX IF NOT EXISTS idx_pr_history_pr_id ON pr_history(pr_id);
CREATE INDEX IF NOT EXISTS idx_prs_status ON prs(status);
CREATE INDEX IF NOT EXISTS idx_prs_requester_id ON prs(requester_id);

-- SiteReq admin/CRM module (platform staff managing the customers who subscribe to SiteReq)

CREATE TABLE IF NOT EXISTS platform_admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','staff')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE platform_admins DROP CONSTRAINT IF EXISTS platform_admins_role_check;
ALTER TABLE platform_admins ADD CONSTRAINT platform_admins_role_check CHECK (role IN ('owner','admin','staff'));

CREATE TABLE IF NOT EXISTS customer_companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tax_id TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS password_hash TEXT;
-- Default business terms for this customer (not tied to any single quotation/invoice) —
-- pre-fills future documents for them rather than being re-entered each time.
ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS fax TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS default_quote_validity_days INTEGER;
ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS default_credit_days INTEGER;
ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS code TEXT UNIQUE;
ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS logo_url TEXT;

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers(company_id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;
-- Governs what the contact can do when they log into pr-system (matches pr-system.html's ROLES keys).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'super_user';
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_role_check;
ALTER TABLE customers ADD CONSTRAINT customers_role_check CHECK (role IN ('super_user','admin_maker','admin_approver','single_auto','single_dual','maker','checker','approver'));

-- Each customer company sets its own PR approval thresholds/flow (separate from the internal
-- single-tenant approval_conditions table above), scoped by company_id since companies differ.
CREATE TABLE IF NOT EXISTS customer_approval_conditions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  min_amount NUMERIC NOT NULL,
  max_amount NUMERIC,
  flow TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_approval_conditions_company_id ON customer_approval_conditions(company_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('free','basic','pro','enterprise')),
  max_users INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_company_id ON subscriptions(company_id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS custom_price NUMERIC;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS custom_seat_price NUMERIC;
-- The renew form (admin-panel.html) computes a grand total (package cost + extra-seat cost, less
-- any duration discount) but that number was never persisted — only the per-month rates were. Store
-- it so other flows (e.g. invoice creation) can pull "the package's total" instead of just the rate.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS total_amount NUMERIC;
-- Set on every renewal: period_start = the moment this renewal happened (the period this
-- subscription row's expires_at now covers runs period_start -> expires_at). last_additional_users
-- is the additionalUsers value submitted in that same renewal, since max_users only stores the
-- combined base+additional total and can't be decomposed back out otherwise.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_additional_users INTEGER;

CREATE TABLE IF NOT EXISTS packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 1;
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_billing_cycle_check;
ALTER TABLE packages ADD CONSTRAINT packages_billing_cycle_check CHECK (billing_cycle IN ('daily','monthly','yearly'));
-- Only meaningful when billing_cycle = 'daily' — the admin-entered number of days the package covers.
ALTER TABLE packages ADD COLUMN IF NOT EXISTS billing_days INTEGER;

ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS package_id INTEGER REFERENCES packages(id);

-- General sellable catalog (สินค้า/บริการ) — separate from `packages` (SiteReq subscription
-- tiers). Used as line items on quotations/invoices going forward.
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  price NUMERIC NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id),
  amount NUMERIC NOT NULL,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','overdue','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices(company_id);

-- 'partial' added for invoices that have received some but not all of their amount (see
-- invoice_payments below) — previously an invoice could only ever be fully unpaid or fully paid.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('unpaid','partial','paid','overdue','cancelled'));

-- One row per receipt of money against an invoice (รับชำระเงิน) — supports multiple installments
-- for the same invoice. invoices.status is derived from SUM(amount) here vs. invoices.amount
-- (see recordInvoicePayment in server.js) rather than stored redundantly per payment.
CREATE TABLE IF NOT EXISTS invoice_payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES platform_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice_id ON invoice_payments(invoice_id);

CREATE TABLE IF NOT EXISTS quotations (
  id SERIAL PRIMARY KEY,
  quotation_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  note TEXT NOT NULL DEFAULT '',
  -- Set once "แปลงเป็นใบแจ้งหนี้" has run; blocks converting the same quotation twice.
  converted_invoice_id INTEGER REFERENCES invoices(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotations_company_id ON quotations(company_id);
-- Snapshot of who/where the quotation was addressed to at the time it was made — kept separate
-- from the live customer_companies/customers data (which can change later) so a printed
-- quotation stays accurate to what was actually sent. Pre-filled via the "ค้นหาจากรหัสบริษัท"
-- lookup but editable afterward. company_id (above) is still required for convert-to-invoice.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS fax TEXT NOT NULL DEFAULT '';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS quotation_items (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL DEFAULT '',
  qty NUMERIC NOT NULL DEFAULT 1,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  idx INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_quotation_id ON quotation_items(quotation_id);
-- หน่วย (e.g. "ชิ้น", "งาน") and a flat per-line ส่วนลด (currency amount, not %), matching the
-- standard ลำดับ/รายการ/จำนวน/หน่วย/ราคาต่อหน่วย/ส่วนลด/จำนวนเงิน Thai document column set.
ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT '';
ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS discount NUMERIC NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS payment_slips (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_slips_invoice_id ON payment_slips(invoice_id);

-- Chart of accounts (ผังบัญชี). parent_code lets sub-accounts (e.g. 1110) nest under a
-- header account (e.g. 1100) — both purely for grouping/display, no rollup math is done here.
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('asset','liability','equity','revenue','expense')),
  parent_code TEXT REFERENCES chart_of_accounts(code),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_category ON chart_of_accounts(category);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_parent_code ON chart_of_accounts(parent_code);

-- Seeded so the invoice→revenue-account link below has somewhere to point. The full chart is
-- meant to be filled in by the admin via the "ผังบัญชี" page (or a follow-up seed once the
-- real account list is provided) — these two rows are only the minimum needed for that link.
INSERT INTO chart_of_accounts (code, name, category) VALUES
  ('4100', 'รายได้ค่าบริการแพ็กเกจ', 'revenue'),
  ('4200', 'รายได้ค่าผู้ใช้งานเพิ่ม', 'revenue')
ON CONFLICT (code) DO NOTHING;

-- One row per revenue split recorded when an invoice is created (see POST /api/admin/invoices).
-- Not double-entry bookkeeping — just a link from an invoice to the chart-of-accounts code(s)
-- its amount should count toward, so a future P&L report can sum by account.
CREATE TABLE IF NOT EXISTS invoice_ledger_entries (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES chart_of_accounts(code),
  amount NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_ledger_entries_invoice_id ON invoice_ledger_entries(invoice_id);

-- ---------------- General journal (สมุดรายวัน) — double-entry bookkeeping core ----------------
-- One header row per business event (invoice issued, expense recorded, manual entry, ...).
-- server.js's createJournalEntry() is the only writer and validates SUM(debit_amount) =
-- SUM(credit_amount) across a header's lines before inserting anything — a per-group balance rule
-- isn't expressible as a plain column CHECK, so it's enforced in application code, not here.
CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice','payment','expense','manual')),
  source_id INTEGER,
  created_by INTEGER REFERENCES platform_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_entry_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id SERIAL PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES chart_of_accounts(code),
  debit_amount NUMERIC NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount NUMERIC NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry_id ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_account_code ON journal_entry_lines(account_code);

-- Minimum accounts the auto-posting rules below need to point to (invoice -> 1200/4100/4200,
-- expense -> 5xxx/1100/2100). Full chart still pending from the user, per
-- [[project_chart_of_accounts]] — added the same conservative way 4100/4200 were.
INSERT INTO chart_of_accounts (code, name, category) VALUES
  ('1100', 'เงินสด', 'asset'),
  ('1200', 'ลูกหนี้การค้า', 'asset'),
  ('2100', 'เจ้าหนี้การค้า', 'liability')
ON CONFLICT (code) DO NOTHING;

-- Manually-entered expense line items (รายจ่าย). category_code should point at a 5xxx
-- (category='expense') chart_of_accounts row — enforced at the API layer, not by a DB CHECK,
-- since a plain FK can't constrain by a joined column's value.
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  category_code TEXT REFERENCES chart_of_accounts(code),
  description TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  receipt_file TEXT,
  created_by INTEGER REFERENCES platform_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_category_code ON expenses(category_code);
CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date);

-- Whether this expense has actually been paid out yet. DEFAULT 'paid' (not 'unpaid') is
-- deliberate: every expense recorded before this column existed was already journaled as an
-- immediate cash payment (see postExpenseJournalEntry in server.js, pre-2026-07-24) — backfilling
-- them as 'paid' keeps their existing journal entries (credited 1100 เงินสด) consistent with this
-- new flag, with no need to touch or regenerate those old journal_entries rows.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_payment_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_status_check CHECK (payment_status IN ('paid','unpaid'));

-- Prospect companies a customer has shown interest in, before they sign up as a real
-- customer_companies row (no FK between the two — converting is a manual admin action).
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','considering','converted','lost')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Company info (part 1 of the add-lead form)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';
ALTER TABLE leads DROP COLUMN IF EXISTS phone;
ALTER TABLE leads DROP COLUMN IF EXISTS email;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_email TEXT NOT NULL DEFAULT '';
-- Contact info (part 2 of the add-lead form)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_position TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS password_hash TEXT;
-- Random 6-digit reference code, generated client-side and shown read-only in the form.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ref_code TEXT UNIQUE;
-- true = an admin has opened this lead at least once. Defaults true (staff-entered leads are
-- inherently "seen" by whoever typed them in); the public trial-signup endpoint explicitly
-- inserts false so new self-submitted leads show an unread badge until an admin views them.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS seen BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS platform_settings (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL DEFAULT 'SiteReq',
  logo_url TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT ''
);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '';
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS contact_fax TEXT NOT NULL DEFAULT '';

-- Thailand province/district/subdistrict/zipcode reference data, for cascading address
-- dropdowns. Static reference data seeded from an open dataset (see scripts/seed-geo.js) —
-- not user-editable, so no admin CRUD routes.
CREATE TABLE IF NOT EXISTS provinces (
  id INTEGER PRIMARY KEY,
  name_th TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY,
  province_id INTEGER NOT NULL REFERENCES provinces(id),
  name_th TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_districts_province_id ON districts(province_id);

CREATE TABLE IF NOT EXISTS subdistricts (
  id INTEGER PRIMARY KEY,
  district_id INTEGER NOT NULL REFERENCES districts(id),
  name_th TEXT NOT NULL,
  zipcode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subdistricts_district_id ON subdistricts(district_id);

-- ---------------- Employees module (job positions / employees / job applications) ----------------
-- Previously a purely client-side in-memory demo (DB.jobPositions/DB.employees/DB.jobApplications
-- in pr-system.html, reset on every page load). Migrated to real tables so job-application
-- approval permissions (can_approve_applications below) have something real to gate.
--
-- Scoped by company_id like customers/invoices/quotations/etc — NOT like the single-tenant
-- users/prs/approval_conditions tables above. The frontend's real login path is
-- customers + requireCustomerAuth (/api/customer-login); the users table + requireAuth's
-- /api/login is never called by any frontend page, so it has no real session to gate with.

CREATE TABLE IF NOT EXISTS job_positions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name, category)
);
CREATE INDEX IF NOT EXISTS idx_job_positions_company_id ON job_positions(company_id);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  employee_code TEXT NOT NULL,
  full_name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  employment_type TEXT NOT NULL DEFAULT 'monthly' CHECK (employment_type IN ('monthly','daily','hourly','lump','subcontractor')),
  wage_rate NUMERIC NOT NULL DEFAULT 0,
  phone TEXT NOT NULL DEFAULT '',
  id_card_number TEXT NOT NULL DEFAULT '',
  start_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  -- Optional link to a real login account (customers.id) — lets "added as an employee with
  -- position ฝ่ายธุรการ/HR" actually grant can_approve_applications to someone real.
  customer_id INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_code)
);
CREATE INDEX IF NOT EXISTS idx_employees_company_id ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_employees_customer_id ON employees(customer_id);

CREATE TABLE IF NOT EXISTS job_applications (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  employee_code TEXT NOT NULL DEFAULT '',
  title_prefix TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  position_wanted1 TEXT NOT NULL DEFAULT '',
  position_wanted2 TEXT NOT NULL DEFAULT '',
  expected_salary TEXT NOT NULL DEFAULT '',
  photo_data_url TEXT NOT NULL DEFAULT '',
  addr_no TEXT NOT NULL DEFAULT '',
  addr_moo TEXT NOT NULL DEFAULT '',
  addr_road TEXT NOT NULL DEFAULT '',
  addr_tambon TEXT NOT NULL DEFAULT '',
  addr_amphoe TEXT NOT NULL DEFAULT '',
  addr_province TEXT NOT NULL DEFAULT '',
  addr_zipcode TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  living_type TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  age TEXT NOT NULL DEFAULT '',
  ethnicity TEXT NOT NULL DEFAULT '',
  nationality TEXT NOT NULL DEFAULT '',
  religion TEXT NOT NULL DEFAULT '',
  id_card_number TEXT NOT NULL DEFAULT '',
  id_card_expiry TEXT NOT NULL DEFAULT '',
  height_cm TEXT NOT NULL DEFAULT '',
  weight_kg TEXT NOT NULL DEFAULT '',
  military_status TEXT NOT NULL DEFAULT '',
  marital_status TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  father_name TEXT NOT NULL DEFAULT '',
  father_age TEXT NOT NULL DEFAULT '',
  father_occupation TEXT NOT NULL DEFAULT '',
  mother_name TEXT NOT NULL DEFAULT '',
  mother_age TEXT NOT NULL DEFAULT '',
  mother_occupation TEXT NOT NULL DEFAULT '',
  spouse_name TEXT NOT NULL DEFAULT '',
  spouse_workplace TEXT NOT NULL DEFAULT '',
  spouse_position TEXT NOT NULL DEFAULT '',
  children_count TEXT NOT NULL DEFAULT '',
  siblings_total TEXT NOT NULL DEFAULT '',
  siblings_male TEXT NOT NULL DEFAULT '',
  siblings_female TEXT NOT NULL DEFAULT '',
  birth_order TEXT NOT NULL DEFAULT '',
  siblings JSONB NOT NULL DEFAULT '[]',
  education JSONB NOT NULL DEFAULT '{}',
  experience JSONB NOT NULL DEFAULT '[]',
  languages JSONB NOT NULL DEFAULT '{}',
  other_language_name TEXT NOT NULL DEFAULT '',
  typing_able TEXT NOT NULL DEFAULT '',
  typing_speed_thai TEXT NOT NULL DEFAULT '',
  typing_speed_english TEXT NOT NULL DEFAULT '',
  computer_able TEXT NOT NULL DEFAULT '',
  computer_programs TEXT NOT NULL DEFAULT '',
  driving_able TEXT NOT NULL DEFAULT '',
  driving_license_number TEXT NOT NULL DEFAULT '',
  office_equipment_ability TEXT NOT NULL DEFAULT '',
  hobby TEXT NOT NULL DEFAULT '',
  sports TEXT NOT NULL DEFAULT '',
  special_knowledge TEXT NOT NULL DEFAULT '',
  other_ability TEXT NOT NULL DEFAULT '',
  upcountry_able TEXT NOT NULL DEFAULT '',
  upcountry_note TEXT NOT NULL DEFAULT '',
  emergency_name TEXT NOT NULL DEFAULT '',
  emergency_relation TEXT NOT NULL DEFAULT '',
  emergency_address TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  referral_source TEXT NOT NULL DEFAULT '',
  had_illness TEXT NOT NULL DEFAULT '',
  illness_detail TEXT NOT NULL DEFAULT '',
  applied_before TEXT NOT NULL DEFAULT '',
  applied_before_when TEXT NOT NULL DEFAULT '',
  relatives_in_company TEXT NOT NULL DEFAULT '',
  ref1_name TEXT NOT NULL DEFAULT '',
  ref1_address TEXT NOT NULL DEFAULT '',
  ref1_phone TEXT NOT NULL DEFAULT '',
  ref1_occupation TEXT NOT NULL DEFAULT '',
  ref2_name TEXT NOT NULL DEFAULT '',
  ref2_address TEXT NOT NULL DEFAULT '',
  ref2_phone TEXT NOT NULL DEFAULT '',
  ref2_occupation TEXT NOT NULL DEFAULT '',
  self_introduction TEXT NOT NULL DEFAULT '',
  certify_checked BOOLEAN NOT NULL DEFAULT false,
  signature_name TEXT NOT NULL DEFAULT '',
  signature_date TEXT NOT NULL DEFAULT '',
  -- HR-only "การพิจารณาว่าจ้าง" section — writable only through routes gated by
  -- can_approve_applications (see server.js "Employees module" section).
  hr_position TEXT NOT NULL DEFAULT '',
  hr_department TEXT NOT NULL DEFAULT '',
  -- Decided by HR alongside the rest of "การพิจารณาว่าจ้าง" — nullable (not decided yet), unlike
  -- employees.employment_type which is NOT NULL because every employee record must have one.
  employment_type TEXT CHECK (employment_type IS NULL OR employment_type IN ('monthly','daily','hourly','lump','subcontractor')),
  hr_salary TEXT NOT NULL DEFAULT '',
  hr_start_date TEXT NOT NULL DEFAULT '',
  hr_special_expenses TEXT NOT NULL DEFAULT '',
  hr_signed_by TEXT NOT NULL DEFAULT '',
  hr_signed_date TEXT NOT NULL DEFAULT '',
  approver_signed_by TEXT NOT NULL DEFAULT '',
  approver_signed_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','interviewed','hired','rejected')),
  submitted_at TEXT NOT NULL DEFAULT '',
  -- Audit trail for the hired/rejected decision — set only by POST .../decision, never by the
  -- general-purpose PUT, so it always reflects who actually made the call and when.
  approved_by INTEGER REFERENCES customers(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_applications_company_id ON job_applications(company_id);

-- Governs both the "จัดการสิทธิ์ผู้พิจารณาใบสมัคร" grant/revoke page and the "การพิจารณาว่าจ้าง"
-- section's visibility/editability inside a job application.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS can_approve_applications BOOLEAN NOT NULL DEFAULT false;

-- One-time backfill: accounts created with position ฝ่ายธุรการ/HR before the POST/PUT
-- /api/customer/users routes were wired to auto-grant (see maybeAutoGrantApprovalPermission in
-- server.js) never got can_approve_applications set. Safe to re-run — no-op once caught up.
UPDATE customers SET can_approve_applications = true
WHERE position = 'ฝ่ายธุรการ/HR' AND can_approve_applications = false;

-- ---------------- Notifications (in-app bell) ----------------
-- user_id is a customers.id, not a scoped-by-company FK check at the DB level — every write path
-- (notifyNewJobApplication in server.js) only ever inserts rows for customers already filtered by
-- company_id, so cross-company leakage would be a bug in that query, not something the schema
-- needs to enforce redundantly.
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  related_id INTEGER,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);

-- ---------------- employment_type: dropped from job_positions (never had a real column there —
-- it was only a client-side CATEGORY_DEFAULT_EMPLOYMENT_TYPE suggestion, now removed entirely),
-- decided by HR per-application instead, and carried through to employees on hire. ----------------
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS employment_type TEXT;
ALTER TABLE job_applications DROP CONSTRAINT IF EXISTS job_applications_employment_type_check;
ALTER TABLE job_applications ADD CONSTRAINT job_applications_employment_type_check
  CHECK (employment_type IS NULL OR employment_type IN ('monthly','daily','hourly','lump','subcontractor'));
-- Added รายชั่วโมง (hourly) and ผู้รับเหมาช่วง (subcontractor) alongside the original 3.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_employment_type_check;
ALTER TABLE employees ADD CONSTRAINT employees_employment_type_check
  CHECK (employment_type IN ('monthly','daily','hourly','lump','subcontractor'));

-- ---------------- HR pay items: "รายได้อื่นๆ" (allowances) / "รายการหัก" (deductions) ----------------
-- Replaces the old single free-text hr_special_expenses field (column left in place, unused) with
-- structured line items so a future payroll calculation has real amounts to work with, not prose.
-- One combined table with a type column rather than two near-identical tables.
CREATE TABLE IF NOT EXISTS job_application_pay_items (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('allowance','deduction')),
  name TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_application_pay_items_app ON job_application_pay_items(application_id);

-- Copied over verbatim from job_application_pay_items when "รับเข้าเป็นพนักงาน" converts an
-- application to an employee (see POST .../convert-to-employee in server.js) — kept for future
-- payroll reference, not read/displayed by any UI yet.
CREATE TABLE IF NOT EXISTS employee_pay_items (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('allowance','deduction')),
  name TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_pay_items_employee ON employee_pay_items(employee_id);

-- ---------------- Interview scheduling ----------------
-- One row per interview; result/score/comment start blank (result='pending') at scheduling time
-- and get filled in by "บันทึกผลสัมภาษณ์" later. If an application is ever re-interviewed, the
-- newest row (highest id) is what routes/UI treat as authoritative — see getLatestInterview below.
CREATE TABLE IF NOT EXISTS job_interviews (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('onsite','online','phone')),
  location TEXT NOT NULL DEFAULT '',
  interviewer_name TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','passed','failed')),
  score INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 5)),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_interviews_application ON job_interviews(application_id);

-- 'interview_scheduled' ("นัดสัมภาษณ์แล้ว") added between 'pending' and 'interviewed' for the
-- interview-scheduling step; 'interviewed' ("สัมภาษณ์แล้ว") already existed and is now reused as
-- the post-result status regardless of pass/fail (see job_interviews.result for the actual outcome).
ALTER TABLE job_applications DROP CONSTRAINT IF EXISTS job_applications_status_check;
ALTER TABLE job_applications ADD CONSTRAINT job_applications_status_check
  CHECK (status IN ('pending','interview_scheduled','interviewed','hired','rejected'));

-- ---------------- Leave management (จัดการวันลา/วันหยุด) ----------------
-- Scoped per company_id, same pattern as job_positions — each company gets its own editable copy
-- of the 6 statutory/company-policy leave types (see DEFAULT_LEAVE_TYPES + seedDefaultLeaveTypes
-- in server.js), seeded at company creation and backfilled once below for companies that already
-- existed before this feature.
CREATE TABLE IF NOT EXISTS leave_types (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  default_days_per_year NUMERIC NOT NULL DEFAULT 0,
  is_paid BOOLEAN NOT NULL DEFAULT true,
  is_company_policy BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_leave_types_company ON leave_types(company_id);

-- year is a redundant-but-requested denormalization of holiday_date (kept in sync server-side on
-- every write) — lets "list this year's holidays" skip a date-range/EXTRACT query.
CREATE TABLE IF NOT EXISTS public_holidays (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, holiday_date)
);
CREATE INDEX IF NOT EXISTS idx_public_holidays_company_year ON public_holidays(company_id, year);

-- One row per (employee, leave type, year) — created automatically when an employee is added
-- (see seedLeaveBalanceForEmployee in server.js, called from both POST /api/customer/employees
-- and the job-application "รับเข้าเป็นพนักงาน" convert-to-employee route), seeded from that leave
-- type's default_days_per_year at the time. remaining_days is a generated column so it's always
-- consistent with total/used — never written directly.
CREATE TABLE IF NOT EXISTS employee_leave_balance (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  total_days NUMERIC NOT NULL DEFAULT 0,
  used_days NUMERIC NOT NULL DEFAULT 0,
  remaining_days NUMERIC GENERATED ALWAYS AS (total_days - used_days) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, leave_type_id, year)
);
CREATE INDEX IF NOT EXISTS idx_employee_leave_balance_employee_year ON employee_leave_balance(employee_id, year);

-- days_count is computed server-side at creation time (see calculateLeaveDaysCount in server.js —
-- counts start_date..end_date inclusive, minus Sundays and any overlapping public_holidays row)
-- and stored, not recomputed on read, so it stays fixed even if holidays are edited afterward.
CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days_count NUMERIC NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by INTEGER REFERENCES customers(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id);

-- One-time backfill: employees added before this feature existed never got balance rows seeded
-- (seedLeaveBalanceForEmployee only runs from the two employee-creation routes). Safe to re-run —
-- ON CONFLICT DO NOTHING skips anyone already seeded for the current year.
INSERT INTO employee_leave_balance (employee_id, leave_type_id, year, total_days, used_days)
SELECT e.id, lt.id, EXTRACT(YEAR FROM now())::int, lt.default_days_per_year, 0
FROM employees e
JOIN leave_types lt ON lt.company_id = e.company_id
ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING;

-- ---------------- Interview panel voting (คณะกรรมการสัมภาษณ์แบบโหวตเสียงข้างมาก) ----------------
-- One row per person on the panel for a given job_interviews row: the "main" committee (N members,
-- is_hr_tiebreaker=false, one vote each) plus exactly one HR observer/tiebreaker
-- (is_hr_tiebreaker=true) who only ever votes when the main committee ties. interviewer_id
-- references customers (i.e. "จัดการผู้ใช้งาน" login accounts), not employees — every customer row
-- can log in and vote by definition, so there's no need to cross-reference a linked employee record.
-- result/majority tallying happens on read (see tallyPanel in server.js) — this table only stores
-- the raw ballots, never a computed outcome.
CREATE TABLE IF NOT EXISTS interview_panel_votes (
  id SERIAL PRIMARY KEY,
  interview_id INTEGER NOT NULL REFERENCES job_interviews(id) ON DELETE CASCADE,
  interviewer_id INTEGER NOT NULL,
  vote TEXT NOT NULL DEFAULT 'pending' CHECK (vote IN ('pass','fail','pending')),
  is_hr_tiebreaker BOOLEAN NOT NULL DEFAULT false,
  voted_at TIMESTAMPTZ,
  UNIQUE (interview_id, interviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_interview_panel_votes_interview ON interview_panel_votes(interview_id);
-- interviewer_id originally referenced employees(id) — repointed to customers(id) so the panel is
-- drawn straight from "จัดการผู้ใช้งาน" login accounts. Table was empty in production at the time
-- of this change, so no data migration was needed; re-running this is a safe no-op once applied.
ALTER TABLE interview_panel_votes DROP CONSTRAINT IF EXISTS interview_panel_votes_interviewer_id_fkey;
ALTER TABLE interview_panel_votes ADD CONSTRAINT interview_panel_votes_interviewer_id_fkey
  FOREIGN KEY (interviewer_id) REFERENCES customers(id) ON DELETE CASCADE;

-- ---------------- Foreign worker documents (เอกสารแรงงานต่างด้าว) ----------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS nationality TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_foreign_worker BOOLEAN NOT NULL DEFAULT false;

-- status is derived server-side from expiry_date on every insert/update (see computeDocStatus in
-- server.js), never taken directly from client input — keeps the "ปกติ/ใกล้หมดอายุ" (computed from
-- expiry_date at read time) and "หมดอายุแล้ว" (this column) always consistent with each other.
-- notified_30d_at/notified_expired_at track which of the two required reminder emails (30 days
-- before expiry, and again if still unrenewed on the expiry date itself) have already gone out, so
-- the daily cron doesn't resend the same one every day in between — reset to NULL whenever
-- expiry_date is edited so a renewal gets its own fresh reminder cycle.
CREATE TABLE IF NOT EXISTS foreign_worker_documents (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('passport','work_permit','visa','border_pass','health_insurance','health_checkup')),
  document_number TEXT NOT NULL DEFAULT '',
  issue_date DATE,
  expiry_date DATE NOT NULL,
  file_attachment TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  notified_30d_at TIMESTAMPTZ,
  notified_expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_foreign_worker_documents_employee ON foreign_worker_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_foreign_worker_documents_expiry ON foreign_worker_documents(expiry_date);

-- ---------------- Client ledger (pr-system.html multi-tenant double-entry bookkeeping) ----------------
-- A completely separate double-entry ledger from chart_of_accounts/journal_entries above (which is
-- SiteReq's OWN single-tenant book — SiteReq's revenue from selling subscriptions, SiteReq's own
-- expenses). This is for pr-system.html's customers (construction companies) to record THEIR OWN
-- project accounting. Every table here is prefixed `client_` specifically to avoid any name collision
-- with the admin-panel tables of almost the same name, and every table requires company_id — there is
-- no "global" row in this section. server.js's createClientJournalEntry() is the only writer and
-- always scopes chart-of-accounts lookups by company_id, never trusting the caller's word alone.

CREATE TABLE IF NOT EXISTS client_chart_of_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('asset','liability','equity','revenue','expense')),
  parent_code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX IF NOT EXISTS idx_client_coa_company_id ON client_chart_of_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_client_coa_company_category ON client_chart_of_accounts(company_id, category);
-- parent_code self-references within the SAME company only — a composite FK (rather than a plain
-- FK on code alone) makes it impossible for one company's account to nest under another company's.
ALTER TABLE client_chart_of_accounts DROP CONSTRAINT IF EXISTS client_coa_parent_fk;
ALTER TABLE client_chart_of_accounts ADD CONSTRAINT client_coa_parent_fk
  FOREIGN KEY (company_id, parent_code) REFERENCES client_chart_of_accounts(company_id, code);

CREATE TABLE IF NOT EXISTS client_journal_entries (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL DEFAULT '',
  -- One value per SOURCE TABLE, not per broad concept — (source_type, source_id) is meant to
  -- unambiguously identify the originating row, so two different tables must never share a value
  -- (project_expense vs office_expense started as one shared 'expense' value and that broke exactly
  -- this: source_id collided across the two independently-numbered tables). Widen via ALTER like
  -- every other CHECK in this file as more modules get wired, rather than reusing a value across
  -- more than one source table.
  source_type TEXT NOT NULL CHECK (source_type IN ('revenue','project_expense','office_expense','retention','labor','manual','payment')),
  source_id INTEGER,
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Denormalized from the source row (client_project_costs/client_revenue/client_labor_costs all have
-- their own project_id) so the สมุดรายวัน page (item 5) can filter by project without a 3-way
-- UNION back to whichever table source_type points at. No FK — same "โครงการ has no real backend
-- table yet" reasoning as project_id everywhere else in this ledger. NULL for entries with no
-- natural project (office expenses, manual entries).
ALTER TABLE client_journal_entries ADD COLUMN IF NOT EXISTS project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_client_journal_entries_project ON client_journal_entries(company_id, project_id);
CREATE INDEX IF NOT EXISTS idx_client_journal_entries_company_date ON client_journal_entries(company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_client_journal_entries_source ON client_journal_entries(company_id, source_type, source_id);
-- CREATE TABLE IF NOT EXISTS is a no-op on an already-existing table, so editing the inline CHECK
-- above does nothing once this table has been created once — every widening needs this explicit
-- ALTER too, same as every other CHECK constraint in this file (learned the hard way: the very first
-- edit to this CHECK, splitting 'expense' into 'project_expense'/'office_expense', shipped without
-- this ALTER and the old constraint silently stayed in force).
ALTER TABLE client_journal_entries DROP CONSTRAINT IF EXISTS client_journal_entries_source_type_check;
ALTER TABLE client_journal_entries ADD CONSTRAINT client_journal_entries_source_type_check
  CHECK (source_type IN ('revenue','project_expense','office_expense','retention','labor','manual','payment'));

-- company_id is denormalized here (also reachable via journal_entry_id -> client_journal_entries.
-- company_id) specifically so a composite FK can pin account_code to the SAME company as the entry
-- at the database level — a deliberate belt-and-suspenders isolation guarantee beyond the
-- application-level checks in createClientJournalEntry(), given how much this feature's spec
-- emphasizes zero cross-company leakage. createClientJournalEntry() always derives this value from
-- the entry it just created, never from caller input, so the two can't drift apart.
CREATE TABLE IF NOT EXISTS client_journal_entry_lines (
  id SERIAL PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL REFERENCES client_journal_entries(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount NUMERIC NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_client_jel_entry_id ON client_journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_client_jel_company_id ON client_journal_entry_lines(company_id);
ALTER TABLE client_journal_entry_lines DROP CONSTRAINT IF EXISTS client_jel_account_fk;
ALTER TABLE client_journal_entry_lines ADD CONSTRAINT client_jel_account_fk
  FOREIGN KEY (company_id, account_code) REFERENCES client_chart_of_accounts(company_id, code);

-- Starter chart of accounts seeded for every customer_companies row — same 1xxx-5xxx category
-- structure as admin-panel's chart_of_accounts, but generic construction-project account names
-- instead of SiteReq-subscription-specific ones. 1250/2150/5400 are pre-reserved for the retention/
-- labor-cost wiring planned next (see project_journal_bookkeeping memory), matching the same codes
-- floated for the admin-panel version of this idea before that was put on hold in favor of this
-- per-company ledger. seedDefaultClientChartOfAccounts() in server.js re-runs this same set (as an
-- idempotent ON CONFLICT DO NOTHING) for any company created after this migration; this block is a
-- one-time backfill for companies that already existed before this feature shipped.
INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT c.id, x.code, x.name, x.category
FROM customer_companies c
CROSS JOIN (VALUES
  ('1100','เงินสด','asset'),
  ('1200','ลูกหนี้การค้า','asset'),
  ('1250','ลูกหนี้เงินประกันผลงาน','asset'),
  ('2100','เจ้าหนี้การค้า','liability'),
  ('2150','ค่าแรงค้างจ่าย','liability'),
  ('4100','รายได้ค่าก่อสร้าง','revenue'),
  ('5100','ต้นทุนวัสดุ','expense'),
  ('5200','ต้นทุนผู้รับเหมาช่วง','expense'),
  ('5300','ค่าใช้จ่ายสำนักงาน','expense'),
  ('5400','ค่าแรง','expense'),
  ('5900','ค่าใช้จ่ายอื่นๆ','expense')
) AS x(code, name, category)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------- Client ledger: รายจ่าย (project costs / office expenses) ----------------
-- Real, company_id-scoped replacement for pr-system.html's client-side-only DB.costs/
-- DB.officeExpenses. Kept as two separate tables (not merged) — same split the existing UI already
-- makes conceptually (ต้นทุนโครงการ vs ค่าใช้จ่ายสำนักงาน), decided explicitly rather than assumed.
-- project_id is NOT a foreign key: pr-system.html's "โครงการ" (DB.projects) is itself still
-- client-side-only mock data with no real backend table, so there is nothing real to reference yet
-- — this column is a loose grouping id matching today's client-side shape, revisit if/when projects
-- gets a real table. Only POST (create+journal) / GET (list) / DELETE exist, matching the existing
-- client-side feature's own capability exactly (no edit action exists today either).
CREATE TABLE IF NOT EXISTS client_project_costs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  project_id INTEGER,
  category TEXT NOT NULL CHECK (category IN ('material','labor','subcontractor','machinery','fuel','transport','rental')),
  description TEXT NOT NULL DEFAULT '',
  cost_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  vendor TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_project_costs_company ON client_project_costs(company_id);
CREATE INDEX IF NOT EXISTS idx_client_project_costs_project ON client_project_costs(project_id);

CREATE TABLE IF NOT EXISTS client_office_expenses (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('salary','rent','utility','phone','misc')),
  description TEXT NOT NULL DEFAULT '',
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_office_expenses_company ON client_office_expenses(company_id);

-- ---------------- Client ledger: ใบแจ้งหนี้/รายรับ (revenue) ----------------
-- Real, company_id-scoped replacement for pr-system.html's client-side-only DB.revenue. Same
-- project_id-is-not-a-FK reasoning as client_project_costs above. The journal entry posted here is
-- ONLY revenue recognition (debit 1200 ลูกหนี้การค้า / credit 4100 รายได้ค่าก่อสร้าง) for the FULL
-- amount — the retention_* columns are stored (retention_amount/retention_status computed at insert
-- time, same formula the client used: amount * retention_percent / 100) but do NOT yet post their
-- own journal entry; that's a deliberately separate follow-up (item 4c / "เงินประกันผลงาน") which
-- reclassifies the retained portion out of ordinary AR into 1250 ลูกหนี้เงินประกันผลงาน as its own
-- entry, matching real accounting practice (revenue recognition and the retention reclassification
-- are two distinct events, not one combined entry).
CREATE TABLE IF NOT EXISTS client_revenue (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  project_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('progress','deposit','variation')),
  description TEXT NOT NULL DEFAULT '',
  revenue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  ref_doc TEXT NOT NULL DEFAULT '',
  retention_percent NUMERIC,
  retention_amount NUMERIC NOT NULL DEFAULT 0,
  retention_status TEXT CHECK (retention_status IS NULL OR retention_status IN ('held','released')),
  retention_release_date DATE,
  retention_released_date DATE,
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_revenue_company ON client_revenue(company_id);
CREATE INDEX IF NOT EXISTS idx_client_revenue_project ON client_revenue(project_id);

-- ---------------- Client ledger: รับชำระเงิน (receive payment against client_revenue) ----------------
-- "Group C" of the old "เอกสารสำคัญ" split (ใบเสร็จรับเงิน/หนังสือรับรองหัก ณ ที่จ่าย) — see
-- project_client_ledger memory for the full analysis. This is the missing "clear the AR" event:
-- client_revenue creates the receivable (debit 1200) but nothing until now ever clears it (aside
-- from the narrow retention-release case, a different receivable entirely — 1250, not 1200).
-- Needed so client_revenue_payments can FK onto (company_id, id) — same idempotent
-- pg_constraint-checking pattern as client_projects/employees above.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_revenue_company_id_id_key' AND conrelid = 'client_revenue'::regclass
  ) THEN
    ALTER TABLE client_revenue ADD CONSTRAINT client_revenue_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;

-- amount = net cash received (debit 1100), wht_amount = tax withheld by the client on this payment,
-- if any (debit 1260 — see the chart-of-accounts backfill below). Both together must never exceed
-- (client_revenue.amount - client_revenue.retention_amount) minus whatever's already been paid —
-- retention is a SEPARATE receivable (1250) with its own release flow, not payable through here.
-- Partial payments are the normal case, not an edge case — a single revenue row is expected to
-- collect payment across multiple installments over time.
CREATE TABLE IF NOT EXISTS client_revenue_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  revenue_id INTEGER NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  wht_amount NUMERIC NOT NULL DEFAULT 0 CHECK (wht_amount >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_revenue_payments_company ON client_revenue_payments(company_id);
CREATE INDEX IF NOT EXISTS idx_client_revenue_payments_revenue ON client_revenue_payments(revenue_id);
ALTER TABLE client_revenue_payments DROP CONSTRAINT IF EXISTS client_revenue_payments_revenue_fk;
ALTER TABLE client_revenue_payments ADD CONSTRAINT client_revenue_payments_revenue_fk
  FOREIGN KEY (company_id, revenue_id) REFERENCES client_revenue(company_id, id) ON DELETE CASCADE;

-- New chart-of-accounts entry for WHT — same "add one code, backfill once for existing companies,
-- add to the JS seed list for new ones" pattern as when 1250 was introduced.
INSERT INTO client_chart_of_accounts (company_id, code, name, category)
SELECT c.id, '1260', 'ภาษีหัก ณ ที่จ่ายค้างรับ', 'asset'
FROM customer_companies c
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------- Client ledger: ใบวางบิล/ใบกำกับภาษี (attached to an existing client_revenue row)
-- ---------------- "Group B", the last piece of the เอกสารสำคัญ split — see project_client_ledger
-- memory. Deliberately NOT its own revenue-recognition or journal-posting event: billing/tax_invoice
-- are the physical documents issued FOR a revenue milestone that client_revenue already models
-- (debit 1200/credit 4100 happens once, at client_revenue creation) — this table only attaches a
-- doc number + optional file to that existing row, so there is exactly one place that records the
-- underlying accounting event and no risk of two parallel records disagreeing about it.
-- file_attachment is a filename (disk storage), same convention as client_documents/
-- foreign_worker_documents — not the file bytes themselves.
CREATE TABLE IF NOT EXISTS client_revenue_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  revenue_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('billing','tax_invoice')),
  doc_no TEXT NOT NULL DEFAULT '',
  doc_date DATE NOT NULL DEFAULT CURRENT_DATE,
  file_attachment TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_revenue_documents_company ON client_revenue_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_client_revenue_documents_revenue ON client_revenue_documents(revenue_id);
ALTER TABLE client_revenue_documents DROP CONSTRAINT IF EXISTS client_revenue_documents_revenue_fk;
ALTER TABLE client_revenue_documents ADD CONSTRAINT client_revenue_documents_revenue_fk
  FOREIGN KEY (company_id, revenue_id) REFERENCES client_revenue(company_id, id) ON DELETE CASCADE;

-- ---------------- Client ledger: ค่าแรงพนักงาน (labor costs) ----------------
-- Real, company_id-scoped replacement for pr-system.html's client-side-only DB.laborCosts.
-- Unlike project_id (still no real backend "โครงการ" table — see client_project_costs above),
-- employee_id DOES reference a real, already-existing, company-scoped table (employees), so this
-- is the first client-ledger table with an actual FK for its "which real entity is this about"
-- column. employees.id is already globally unique (SERIAL PK), so a composite
-- UNIQUE(company_id, id) is trivially satisfied by every existing row — added purely so
-- client_labor_costs can FK on (company_id, employee_id) and get the same DB-level "can't
-- reference another company's row" guarantee already used for client_chart_of_accounts, rather
-- than relying solely on the application-level company_id check in the route handler.
-- Can't use the usual DROP CONSTRAINT IF EXISTS + ADD idiom here — client_labor_costs_employee_fk
-- (below) depends on this constraint once created, so re-running the DROP on a second schema.sql
-- apply fails with "cannot drop constraint ... because other objects depend on it". Checking
-- pg_constraint directly (rather than a DROP+ADD or an exception-catching DO block, whose error
-- code turned out to vary — duplicate_table, not duplicate_object, for a UNIQUE constraint's
-- backing index) is the reliable idempotent form.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_company_id_id_key' AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees ADD CONSTRAINT employees_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;

-- payment_status/paid_at mirror admin-panel's expenses.payment_status pattern (see
-- project_journal_bookkeeping memory) — every labor cost starts unpaid/accrued (matching the
-- explicit ask: recording labor cost credits 2150 ค่าแรงค้างจ่าย, not cash directly) and is only
-- flipped to paid through the dedicated "จ่ายค่าแรง" settlement route, never through a general edit,
-- for the same reason admin-panel locks payment_status behind mark-paid rather than a raw PUT.
CREATE TABLE IF NOT EXISTS client_labor_costs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL,
  project_id INTEGER,
  work_date DATE NOT NULL,
  days_worked NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  paid_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_labor_costs_company ON client_labor_costs(company_id);
CREATE INDEX IF NOT EXISTS idx_client_labor_costs_employee ON client_labor_costs(employee_id);
ALTER TABLE client_labor_costs DROP CONSTRAINT IF EXISTS client_labor_costs_employee_fk;
ALTER TABLE client_labor_costs ADD CONSTRAINT client_labor_costs_employee_fk
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id);

-- ---------------- Client ledger: โครงการ (projects) ----------------
-- Real, company_id-scoped replacement for pr-system.html's client-side-only DB.projects — closes
-- the gap flagged repeatedly throughout the client-ledger build (project_id on every other
-- client_* table has had no real table to reference until now). client_name is plain free text,
-- NOT a foreign key: the request asked for "a dropdown from the existing customer table", but no
-- table represents a construction company's own external clients anywhere in this schema —
-- customer_companies is SiteReq's own tenant registry (i.e. this company itself, not its
-- customers), and customers is login accounts, not a client/CRM list. Flagged back to the user
-- rather than inventing a new CRM table unasked; free text was the safe default in the meantime.
-- project_manager_employee_id/foreman_employee_id use the same composite-FK-onto-employees pattern
-- established for client_labor_costs.employee_id (see employees_company_id_id_key above) — nullable
-- (not every project has both assigned yet), so a NULL either side simply skips the FK check.
CREATE TABLE IF NOT EXISTS client_projects (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  site_address TEXT NOT NULL DEFAULT '',
  start_date DATE,
  expected_end_date DATE,
  budget_amount NUMERIC NOT NULL DEFAULT 0,
  default_retention_percent NUMERIC,
  project_manager_employee_id INTEGER,
  foreman_employee_id INTEGER,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','on_hold','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  CHECK (expected_end_date IS NULL OR start_date IS NULL OR expected_end_date >= start_date)
);
-- "วันที่ Update ล่าสุด" on the แผนงาน print header — touched (SET now()) by every task/period mutation
-- endpoint (POST/PUT/DELETE .../tasks*, PUT .../tasks/periods), NOT a general "project record edited"
-- timestamp (project name/budget/etc. edits elsewhere don't touch this) — see the long comment above
-- touchProjectScheduleUpdatedAt() in server.js.
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS schedule_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_client_projects_company ON client_projects(company_id);
ALTER TABLE client_projects DROP CONSTRAINT IF EXISTS client_projects_pm_fk;
ALTER TABLE client_projects ADD CONSTRAINT client_projects_pm_fk
  FOREIGN KEY (company_id, project_manager_employee_id) REFERENCES employees(company_id, id);
ALTER TABLE client_projects DROP CONSTRAINT IF EXISTS client_projects_foreman_fk;
ALTER TABLE client_projects ADD CONSTRAINT client_projects_foreman_fk
  FOREIGN KEY (company_id, foreman_employee_id) REFERENCES employees(company_id, id);
-- Needed so client_purchase_orders/client_quotations below can FK onto (company_id, project_id) —
-- same idempotent pg_constraint-checking pattern as employees_company_id_id_key above, since a
-- plain DROP+ADD would break once something else depends on this constraint.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_projects_company_id_id_key' AND conrelid = 'client_projects'::regclass
  ) THEN
    ALTER TABLE client_projects ADD CONSTRAINT client_projects_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;

-- ---------------- Client ledger: ใบสั่งซื้อ (Purchase Orders) ----------------
-- Real, company_id-scoped backend for "ใบสั่งซื้อ (PO)" — previously one of the 9 generic
-- DOC_TYPES entries in pr-system.html's client-side-only "เอกสารสำคัญ" mock (DB.documents).
-- Deliberately NOT linked to the "ใบขอสั่งวัสดุ (PR)" feature (DB.prs) via a real FK — that
-- feature has zero backend of its own (confirmed same session: submit-pr only ever does
-- DB.prs.push(...), no table, no API) — so pr_reference is a free-text field (the PR's display
-- number, "PR-XXXX-NNNN"), not a real foreign key, matching how project_id itself was a loose
-- integer everywhere until client_projects existed. project_id here IS a real composite FK though,
-- since client_projects is real.
-- items is a JSONB array ({material, qty, unit, unitPrice}) rather than a child table — nothing
-- else in this codebase needs to query/report on individual PO line items independently of their
-- parent PO (unlike client_project_costs, which genuinely needed its own queryable rows), so a
-- child table would be complexity with no corresponding need.
CREATE TABLE IF NOT EXISTS client_purchase_orders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  po_no TEXT NOT NULL,
  project_id INTEGER,
  pr_reference TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL,
  supplier_contact TEXT NOT NULL DEFAULT '',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date DATE,
  payment_terms TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ordered','received','cancelled')),
  items JSONB NOT NULL DEFAULT '[]',
  amount NUMERIC NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, po_no)
);
CREATE INDEX IF NOT EXISTS idx_client_purchase_orders_company ON client_purchase_orders(company_id);
ALTER TABLE client_purchase_orders DROP CONSTRAINT IF EXISTS client_purchase_orders_project_fk;
ALTER TABLE client_purchase_orders ADD CONSTRAINT client_purchase_orders_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);

-- ---------------- Client ledger: ใบเสนอราคา (Quotations, issued BY the customer TO their own
-- client) ----------------
-- NOT the same system as the top-level `quotations` table earlier in this file — that one is
-- SiteReq's own admin-panel feature (SiteReq issuing quotations to its customer companies, the
-- opposite direction). This is a separate, company_id-scoped table for a construction company
-- quoting ITS OWN client, hence the client_ prefix like every other table in this section.
-- client_name mirrors client_projects.client_name's reasoning exactly — free text, since no real
-- client/CRM table exists anywhere in this schema.
CREATE TABLE IF NOT EXISTS client_quotations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  quotation_no TEXT NOT NULL,
  project_id INTEGER,
  client_name TEXT NOT NULL DEFAULT '',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, quotation_no)
);
CREATE INDEX IF NOT EXISTS idx_client_quotations_company ON client_quotations(company_id);
ALTER TABLE client_quotations DROP CONSTRAINT IF EXISTS client_quotations_project_fk;
ALTER TABLE client_quotations ADD CONSTRAINT client_quotations_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);

-- ---------------- Client ledger: เอกสารทั่วไป (สัญญา/ใบส่งของ/ใบรับรองผลงาน) ----------------
-- "Group A" of the old single-form "เอกสารสำคัญ" mock (DOC_TYPES) — the 3 remaining types that are
-- pure paperwork with no independent money movement, so no journal posting. The other 4 old
-- DOC_TYPES (billing/tax_invoice/receipt/wht) deliberately do NOT live here — billing/tax_invoice
-- become attachments on an existing client_revenue row ("Group B"), and receipt/wht become part of
-- a new "รับชำระเงิน" (receive payment) feature ("Group C") since both are real cash/AR events, not
-- generic documents. See project_client_ledger memory for the full analysis.
-- file_attachment stores a filename (disk storage under uploads/client-documents/), same pattern as
-- foreign_worker_documents.file_attachment — not the file bytes themselves.
CREATE TABLE IF NOT EXISTS client_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('contract','delivery','certification')),
  doc_name TEXT NOT NULL,
  project_id INTEGER,
  doc_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE,
  file_attachment TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_documents_company ON client_documents(company_id);
ALTER TABLE client_documents DROP CONSTRAINT IF EXISTS client_documents_project_fk;
ALTER TABLE client_documents ADD CONSTRAINT client_documents_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);

-- ==================================================================================
-- Bidding system (BD: เปิด Tender + Initial Budget) + Project Budget (PM), per company_id.
-- Flow: เปิด Tender -> เปิด Project ผูกกับ Tender -> Import BOQ จาก Excel -> Initial Budget (BD,
-- scoped to the tender) -> Initial Project Budget (PM, scoped to the project) -> Control Budget ->
-- Approve -> Revise (with full version history) even after approval.
-- ==================================================================================

-- ---------------- BD: Tender (ข้อ 1) ----------------
CREATE TABLE IF NOT EXISTS client_tenders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  tender_no TEXT NOT NULL,
  name TEXT NOT NULL,                              -- ชื่อ Tender ตามชื่อโครงการที่จะเข้าประมูล
  project_owner TEXT NOT NULL DEFAULT '',           -- หน่วยงาน/เจ้าของงานที่เปิดประมูล
  submission_deadline DATE,
  estimated_value NUMERIC NOT NULL DEFAULT 0,       -- มูลค่างานโดยประมาณ ณ ตอนเปิด tender (ก่อนมี BOQ)
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','submitted','won','lost','cancelled')),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, tender_no)
);
CREATE INDEX IF NOT EXISTS idx_client_tenders_company ON client_tenders(company_id);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_tenders_company_id_id_key' AND conrelid = 'client_tenders'::regclass
  ) THEN
    ALTER TABLE client_tenders ADD CONSTRAINT client_tenders_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;

-- ---------------- BD: Tender detail fields (added 2026-07-24, "เปิด Tender ใหม่" form expansion) ----------------
-- sector_type ('government'/'private') decides which of the government-only fields below actually
-- apply. budget_amount/reference_price are government-only (วงเงินงบประมาณ / ราคากลาง — two genuinely
-- distinct figures, not duplicates of anything existing). For 'private', there is no separate
-- contract_value column: the already-existing estimated_value column IS the private-sector "มูลค่างาน"
-- figure (a private tender's contract value and its estimated value are the same number under two
-- names — the request explicitly asked not to carry two columns for one meaning). The server keeps
-- estimated_value in sync at save time (= budget_amount when sector_type='government', otherwise the
-- user's own input), so every pre-existing reader of estimated_value (the tender list, etc.) keeps
-- working unchanged regardless of sector.
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS project_no TEXT NOT NULL DEFAULT '';
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS bidding_method TEXT NOT NULL DEFAULT '';
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS sector_type TEXT;
ALTER TABLE client_tenders DROP CONSTRAINT IF EXISTS client_tenders_sector_type_check;
ALTER TABLE client_tenders ADD CONSTRAINT client_tenders_sector_type_check
  CHECK (sector_type IS NULL OR sector_type IN ('government', 'private'));
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS budget_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS reference_price NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS phone_number TEXT NOT NULL DEFAULT '';
-- Free-text "lat,lng" — deliberately not a PostGIS point type, per the request (no need for real
-- geo-queries here, just display/copy-paste).
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS site_coordinates TEXT NOT NULL DEFAULT '';
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS submission_open_date DATE;
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS submission_conditions TEXT NOT NULL DEFAULT '';
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS installment_count INTEGER NOT NULL DEFAULT 0;
-- เปอร์เซ็นต์เงินประกันผลงานเริ่มต้น (added 2026-07-28, revised same day). Deliberately no companion
-- "amount" column: the บาท figure is total (approved PM project budget) × initial_retention_percent /
-- 100 — NOT this tender's own estimated_value (a pre-bid estimate, a different meaning entirely from
-- an approved execution budget) — derived at query time in GET /api/customer/tenders/:id from the
-- linked project's client_budgets/client_budget_revisions (see that route's comment), so it can't go
-- stale if the PM budget is later revised/re-approved.
ALTER TABLE client_tenders ADD COLUMN IF NOT EXISTS initial_retention_percent NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_tenders DROP CONSTRAINT IF EXISTS client_tenders_initial_retention_percent_check;
ALTER TABLE client_tenders ADD CONSTRAINT client_tenders_initial_retention_percent_check
  CHECK (initial_retention_percent >= 0 AND initial_retention_percent <= 100);

-- รายการงวดงาน (installment plan) — one row per งวด, always rewritten as a whole set on save (see
-- POST/PUT tenders in server.js: delete-then-reinsert within the same transaction, same pattern as
-- insertFreshBoqItems for BOQ items) rather than diffed row-by-row, since the form itself only ever
-- edits the full in-progress list before a single submit. Company-scoped composite FK matching every
-- other child-of-a-company-scoped-parent table in this file (client_budget_revisions -> client_budgets
-- is the closest analog) — ON DELETE CASCADE since an installment plan has no meaning once its tender
-- is gone.
CREATE TABLE IF NOT EXISTS client_tender_installments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  tender_id INTEGER NOT NULL,
  installment_no INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  days_to_complete INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_tender_installments_tender ON client_tender_installments(tender_id);
ALTER TABLE client_tender_installments DROP CONSTRAINT IF EXISTS client_tender_installments_tender_fk;
ALTER TABLE client_tender_installments ADD CONSTRAINT client_tender_installments_tender_fk
  FOREIGN KEY (company_id, tender_id) REFERENCES client_tenders(company_id, id) ON DELETE CASCADE;

-- Per-company, per-document-type "next number to issue" counters — fixes a real bug found
-- 2026-07-24: generateTenderNo (server.js) used to derive the next tender_no from
-- COUNT(*) FROM client_tenders, which is the count of CURRENTLY-EXISTING rows, not "how many have
-- ever been issued." Deleting old tenders shrinks that count, so the next one created reused a
-- tender_no that had already been issued (and deleted) before — a real collision was reproduced:
-- deleting TDR-2569-0001..0010 then creating a new tender issued "TDR-2569-0003" again. next_seq only
-- ever increases (see nextDocumentSeq in server.js) — deleting rows never lowers it. doc_type lets
-- this same table back tender/PO/quotation/project numbering later without a new table each time,
-- though only 'tender' is wired up as of this migration (see the same COUNT(*) pattern in
-- generateClientPoNo/generateClientQuotationNo if those ever need the same fix).
CREATE TABLE IF NOT EXISTS company_document_counters (
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, doc_type)
);

-- ---------------- PM: Project <-> Tender link (ข้อ 2) ----------------
-- Nullable: a project can still be opened without ever having gone through a tender (matches
-- client_projects' existing unrestricted use), but when it does come from a won tender, this ties
-- the two together so BD's initial budget (below) can be pulled forward into PM's project budget.
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS tender_id INTEGER;
ALTER TABLE client_projects DROP CONSTRAINT IF EXISTS client_projects_tender_fk;
ALTER TABLE client_projects ADD CONSTRAINT client_projects_tender_fk
  FOREIGN KEY (company_id, tender_id) REFERENCES client_tenders(company_id, id);
CREATE INDEX IF NOT EXISTS idx_client_projects_tender ON client_projects(tender_id);

-- ---------------- PM: Project detail fields (mirrors "BD: Tender detail fields" 2026-07-24 migration
-- exactly, added for the "เพิ่มโครงการ" form expansion, 2026-07-25) ----------------
-- sector_type decides which of budget_amount/reference_price actually apply, same as client_tenders.
-- No new location or project_no column here: client_projects.site_address already means the same thing
-- as client_tenders.location (the physical work-site address), and client_projects.code already plays
-- project_no's role — both confirmed overlaps, reused rather than duplicated. budget_amount (already
-- existing, the "งบประมาณที่ตั้งไว้" field) plays the SAME dual role client_tenders.estimated_value
-- plays: it directly IS the government-sector "วงเงินงบประมาณ" figure, and remains the general
-- contract-value figure for private projects — no new estimated_value/contract_value column.
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS bidding_method TEXT NOT NULL DEFAULT '';
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS sector_type TEXT;
ALTER TABLE client_projects DROP CONSTRAINT IF EXISTS client_projects_sector_type_check;
ALTER TABLE client_projects ADD CONSTRAINT client_projects_sector_type_check
  CHECK (sector_type IS NULL OR sector_type IN ('government', 'private'));
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS reference_price NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS phone_number TEXT NOT NULL DEFAULT '';
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS site_coordinates TEXT NOT NULL DEFAULT '';
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS submission_open_date DATE;
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS submission_conditions TEXT NOT NULL DEFAULT '';
ALTER TABLE client_projects ADD COLUMN IF NOT EXISTS installment_count INTEGER NOT NULL DEFAULT 0;

-- รายการงวดงาน for a project — identical shape/FK pattern to client_tender_installments.
CREATE TABLE IF NOT EXISTS client_project_installments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  installment_no INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  days_to_complete INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_project_installments_project ON client_project_installments(project_id);
ALTER TABLE client_project_installments DROP CONSTRAINT IF EXISTS client_project_installments_project_fk;
ALTER TABLE client_project_installments ADD CONSTRAINT client_project_installments_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id) ON DELETE CASCADE;

-- ---------------- แผนงาน (Gantt) — Phase 1: WBS/Task list + dependencies + baseline
-- (2026-07-25). Accessible from any existing project's Project Detail page regardless of whether
-- it came from a won tender or was created manually — no tender.status gate anywhere here or in
-- the API layer, per explicit confirmation. Phase 1 only: no CPM/auto-schedule yet (that's Phase 2
-- — see the "TODO Phase 2" markers below for exactly what's deliberately deferred). ----------------
-- wbs_code is SERVER-COMPUTED (recomputed for the whole project tree on every create/reorder/
-- delete/reparent — see recomputeProjectTaskWbs in server.js), never accepted from the client, so
-- it can never drift out of sync with the actual parent_task_id/sort_order structure. is_summary is
-- deliberately NOT a column — a task is a summary iff another task's parent_task_id points at it,
-- computed at query time (EXISTS subquery) rather than stored/kept in sync.
CREATE TABLE IF NOT EXISTS client_project_tasks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  parent_task_id INTEGER,
  wbs_code TEXT NOT NULL DEFAULT '',
  task_name TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 1,
  start_date DATE,
  end_date DATE,
  percent_complete INTEGER NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  is_milestone BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_project_tasks_company_id_id_key' AND conrelid = 'client_project_tasks'::regclass
  ) THEN
    ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;
ALTER TABLE client_project_tasks DROP CONSTRAINT IF EXISTS client_project_tasks_project_fk;
ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id) ON DELETE CASCADE;
-- ON DELETE CASCADE here is what makes "delete a summary task" delete its whole subtree for free —
-- no application-level recursive delete needed.
ALTER TABLE client_project_tasks DROP CONSTRAINT IF EXISTS client_project_tasks_parent_fk;
ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_parent_fk
  FOREIGN KEY (company_id, parent_task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_client_project_tasks_project ON client_project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_client_project_tasks_parent ON client_project_tasks(parent_task_id);

-- source_boq_item_id: traceability back to the approved BOQ line item a task was created from, when
-- created via the "เพิ่ม Task" batch table (see server.js's
-- GET .../available-boq-items-for-task + POST .../tasks/batch). NULL for tasks added the old way
-- (free-text name, no BOQ link) or for summary tasks. ON DELETE SET NULL rather than CASCADE — a
-- deleted/re-imported BOQ item shouldn't take the task with it, just sever the link. No composite
-- (company_id, id) FK here (unlike parent_task_id/project_id above) because client_budget_items has
-- no such unique constraint to reference; company scoping for "is this item mine" is instead enforced
-- in the endpoint query (joins through revision -> budget -> company_id).
ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS source_boq_item_id INTEGER;
ALTER TABLE client_project_tasks DROP CONSTRAINT IF EXISTS client_project_tasks_source_boq_item_fk;
ALTER TABLE client_project_tasks ADD CONSTRAINT client_project_tasks_source_boq_item_fk
  FOREIGN KEY (source_boq_item_id) REFERENCES client_budget_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_client_project_tasks_source_boq_item ON client_project_tasks(source_boq_item_id);

-- budget_amount: SNAPSHOT (not live-synced) of the source BOQ item's amount
-- (material_amount + labor_amount) at the moment the task was pulled in via POST .../tasks/batch —
-- see the long comment above that endpoint in server.js for why snapshot was chosen over a live join.
-- 0 for legacy free-text tasks with no source_boq_item_id.
ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS budget_amount NUMERIC NOT NULL DEFAULT 0;

-- ผลงาน (actual) task-level fields — a manually-entered "real-world" counterpart to the existing
-- แผนงาน task-master columns above (duration_days/start_date/end_date/budget_amount), NOT the same
-- thing as client_project_task_periods' per-day planned_percent/actual_percent grid below: those are
-- fine-grained daily entries used to build the time-grid/S-curve; these four are a single per-task
-- snapshot ("when did this task actually start/finish, how much did it actually cost, what's its
-- overall % done") shown alongside the planned columns in renderProjectScheduleTable()'s Task table.
-- actual_duration_days is deliberately NOT a column here — always derived at query/render time as
-- actual_end_date - actual_start_date + 1 (same day-count convention duration_days already uses), so
-- it can never drift out of sync with the two dates it's computed from.
ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_start_date DATE;
ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_end_date DATE;
ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_project_tasks ADD COLUMN IF NOT EXISTS actual_percent NUMERIC NOT NULL DEFAULT 0 CHECK (actual_percent >= 0 AND actual_percent <= 100);

-- แผนงาน Phase 2: one row per (task, calendar day) that actually has a nonzero แผนงาน/ผลงาน % entered
-- — DAY is the only granularity ever stored, regardless of the UI's current zoom (วัน/สัปดาห์/เดือน).
-- สัปดาห์ zoom just groups these same day-columns under a week header; เดือน zoom groups them into
-- 7-day display buckets and spreads a bucket-cell edit evenly back across its underlying days — see
-- the long comment above PUT .../tasks/periods in server.js. Full-replace on every save (this app's
-- established pattern for "spreadsheet-like" editable data — see insertFreshBoqItems), so a day with
-- 0/0 is simply absent, not stored.
CREATE TABLE IF NOT EXISTS client_project_task_periods (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL,
  period_date DATE NOT NULL,
  planned_percent NUMERIC NOT NULL DEFAULT 0 CHECK (planned_percent >= 0 AND planned_percent <= 100),
  actual_percent NUMERIC NOT NULL DEFAULT 0 CHECK (actual_percent >= 0 AND actual_percent <= 100),
  UNIQUE (task_id, period_date)
);
ALTER TABLE client_project_task_periods DROP CONSTRAINT IF EXISTS cptp_task_fk;
ALTER TABLE client_project_task_periods ADD CONSTRAINT cptp_task_fk
  FOREIGN KEY (company_id, task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_cptp_task ON client_project_task_periods(task_id);

-- FS/SS/FF/SF per the standard CPM dependency types — only FS is actually used by anything before
-- Phase 2 (no scheduling engine reads dependency_type yet), the other 3 are accepted/stored now so
-- Phase 2's forward/backward pass doesn't need a data migration later.
CREATE TABLE IF NOT EXISTS client_project_task_dependencies (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL,
  depends_on_task_id INTEGER NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'FS' CHECK (dependency_type IN ('FS','SS','FF','SF')),
  lag_days INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (task_id <> depends_on_task_id),
  UNIQUE (task_id, depends_on_task_id)
);
-- Self-reference and duplicate-edge checks are enforced above at the DB level (CHECK/UNIQUE); full
-- graph-wide circular-dependency detection (A->B->C->A) is NOT done here — TODO Phase 2, per spec.
ALTER TABLE client_project_task_dependencies DROP CONSTRAINT IF EXISTS cptd_task_fk;
ALTER TABLE client_project_task_dependencies ADD CONSTRAINT cptd_task_fk
  FOREIGN KEY (company_id, task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE;
ALTER TABLE client_project_task_dependencies DROP CONSTRAINT IF EXISTS cptd_depends_on_fk;
ALTER TABLE client_project_task_dependencies ADD CONSTRAINT cptd_depends_on_fk
  FOREIGN KEY (company_id, depends_on_task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_cptd_task ON client_project_task_dependencies(task_id);
-- Phase 2 (CPM): backward-pass/cycle-check both need the reverse lookup ("which tasks depend on
-- this one") just as often as the forward one above.
CREATE INDEX IF NOT EXISTS idx_cptd_depends_on ON client_project_task_dependencies(depends_on_task_id);

-- One row per task, UPSERTed on every "ตั้ง Baseline" — a later baseline always overwrites the
-- earlier one (current-vs-baseline Gantt comparison only ever needs the latest), not an append-only
-- history table.
CREATE TABLE IF NOT EXISTS client_project_task_baseline (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL UNIQUE,
  baseline_start DATE,
  baseline_end DATE,
  baseline_set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  set_by INTEGER REFERENCES customers(id)
);
ALTER TABLE client_project_task_baseline DROP CONSTRAINT IF EXISTS cptb_task_fk;
ALTER TABLE client_project_task_baseline ADD CONSTRAINT cptb_task_fk
  FOREIGN KEY (company_id, task_id) REFERENCES client_project_tasks(company_id, id) ON DELETE CASCADE;

-- ---------------- BD/PM: Budget header (ข้อ 5/6/7) ----------------
-- One row per logical budget — exactly one per tender (budget_scope='bidding', the BD module's
-- Initial Budget) or per project (budget_scope='project', PM's Initial Project Budget). The actual
-- amounts/status/approval never live here — only on client_budget_revisions below — so this row is
-- just a stable anchor plus the control-budget settings (ข้อ 7), which apply regardless of how many
-- times the budget underneath gets revised.
CREATE TABLE IF NOT EXISTS client_budgets (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  budget_scope TEXT NOT NULL CHECK (budget_scope IN ('bidding','project')),
  tender_id INTEGER,
  project_id INTEGER,
  current_revision_id INTEGER,  -- FK added below, once client_budget_revisions exists
  control_enabled BOOLEAN NOT NULL DEFAULT true,          -- ห้ามเบิก/บันทึกค่าใช้จ่ายเกินงบที่อนุมัติ
  warning_threshold_percent NUMERIC NOT NULL DEFAULT 90,  -- แจ้งเตือนเมื่อใช้ไปถึง % นี้ของงบอนุมัติ
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (budget_scope = 'bidding' AND tender_id IS NOT NULL AND project_id IS NULL) OR
    (budget_scope = 'project' AND project_id IS NOT NULL AND tender_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_client_budgets_company ON client_budgets(company_id);
-- At most one budget per tender, and at most one per project — "revise" creates a new revision
-- under the SAME budget row, never a second client_budgets row for the same tender/project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_budgets_tender ON client_budgets(tender_id) WHERE tender_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_budgets_project ON client_budgets(project_id) WHERE project_id IS NOT NULL;
ALTER TABLE client_budgets DROP CONSTRAINT IF EXISTS client_budgets_tender_fk;
ALTER TABLE client_budgets ADD CONSTRAINT client_budgets_tender_fk
  FOREIGN KEY (company_id, tender_id) REFERENCES client_tenders(company_id, id);
ALTER TABLE client_budgets DROP CONSTRAINT IF EXISTS client_budgets_project_fk;
ALTER TABLE client_budgets ADD CONSTRAINT client_budgets_project_fk
  FOREIGN KEY (company_id, project_id) REFERENCES client_projects(company_id, id);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_budgets_company_id_id_key' AND conrelid = 'client_budgets'::regclass
  ) THEN
    ALTER TABLE client_budgets ADD CONSTRAINT client_budgets_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;

-- ---------------- Budget revision/version history (ข้อ 8/9) ----------------
-- One row per version of a budget. Approving a revision does NOT lock the budget from further
-- changes — revising after approval always inserts a brand-new revision_no (status back to
-- 'draft'/'pending_approval'), leaving the previously-approved row untouched as permanent,
-- queryable history. Control-budget checks (spending vs. approved amount) always read
-- client_budgets.current_revision_id, which the API only ever repoints at a revision once it's
-- approved — so an in-progress re-approval never affects live spending control until it clears.
CREATE TABLE IF NOT EXISTS client_budget_revisions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  budget_id INTEGER NOT NULL,
  revision_no INTEGER NOT NULL,  -- 1, 2, 3... per budget_id
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected')),
  total_amount NUMERIC NOT NULL DEFAULT 0,  -- cached SUM(client_budget_items.amount) for this revision
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('boq_import','manual','revision')),
  revision_reason TEXT NOT NULL DEFAULT '',  -- required by the API for every revision_no > 1
  submitted_by INTEGER REFERENCES customers(id),
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES customers(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (budget_id, revision_no)
);
CREATE INDEX IF NOT EXISTS idx_client_budget_revisions_company ON client_budget_revisions(company_id);
CREATE INDEX IF NOT EXISTS idx_client_budget_revisions_budget ON client_budget_revisions(budget_id);
ALTER TABLE client_budget_revisions DROP CONSTRAINT IF EXISTS client_budget_revisions_budget_fk;
ALTER TABLE client_budget_revisions ADD CONSTRAINT client_budget_revisions_budget_fk
  FOREIGN KEY (company_id, budget_id) REFERENCES client_budgets(company_id, id) ON DELETE CASCADE;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_budget_revisions_company_id_id_key' AND conrelid = 'client_budget_revisions'::regclass
  ) THEN
    ALTER TABLE client_budget_revisions ADD CONSTRAINT client_budget_revisions_company_id_id_key UNIQUE (company_id, id);
  END IF;
END $$;

ALTER TABLE client_budgets DROP CONSTRAINT IF EXISTS client_budgets_current_revision_fk;
ALTER TABLE client_budgets ADD CONSTRAINT client_budgets_current_revision_fk
  FOREIGN KEY (company_id, current_revision_id) REFERENCES client_budget_revisions(company_id, id);

-- ---------------- Tender Overview dashboard (2026-07-25) ----------------
-- Supports GET /api/customer/tender-overview's 3 shaped queries: recent-tenders feed,
-- upcoming-submission-deadline list (partial index — only rows that could ever appear in that list),
-- and pending-approval budget revisions (also partial, same reasoning). Per-company row counts are
-- small already (idx_client_tenders_company/idx_client_budget_revisions_company scope every query
-- down first), so these are precautionary, not a response to an observed slowdown.
CREATE INDEX IF NOT EXISTS idx_client_tenders_company_created ON client_tenders(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_tenders_upcoming_deadline
  ON client_tenders(company_id, submission_deadline)
  WHERE status IN ('preparing','submitted');
CREATE INDEX IF NOT EXISTS idx_client_budget_revisions_pending
  ON client_budget_revisions(company_id, submitted_at)
  WHERE status='pending_approval';
CREATE INDEX IF NOT EXISTS idx_client_budget_revisions_company_approved
  ON client_budget_revisions(company_id, approved_at DESC);

-- ---------------- BOQ / budget line items (ข้อ 3/4: Excel import) ----------------
-- Expected Excel columns (ตาม template BOQ): รหัสงาน, รายการงาน, หน่วย, ปริมาณ, ราคาวัสดุ/หน่วย,
-- ราคาแรงงาน/หน่วย, รวมค่าวัสดุ, รวมค่าแรงงาน, รวมเงิน — mapped 1:1 to
-- work_code/description/unit/qty/material_unit_price/labor_unit_price/material_amount/labor_amount/
-- amount below. `amount` is always material_amount+labor_amount (kept as this column's original name
-- rather than renaming to total_amount, since nothing else about "amount = this row's total" changed
-- when the price itself split into two components). One set of rows per revision (not per budget) —
-- revising copies the prior revision's items into the new revision_id before the user edits them, so
-- every past revision keeps its own untouched snapshot.
CREATE TABLE IF NOT EXISTS client_budget_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  work_code TEXT NOT NULL DEFAULT '',       -- รหัสงาน
  description TEXT NOT NULL,                -- รายการงาน
  unit TEXT NOT NULL DEFAULT '',            -- หน่วย
  qty NUMERIC NOT NULL DEFAULT 0,           -- ปริมาณ
  material_unit_price NUMERIC NOT NULL DEFAULT 0,  -- ราคาวัสดุ/หน่วย
  labor_unit_price NUMERIC NOT NULL DEFAULT 0,     -- ราคาแรงงาน/หน่วย
  material_amount NUMERIC NOT NULL DEFAULT 0,      -- รวมค่าวัสดุ (qty * material_unit_price)
  labor_amount NUMERIC NOT NULL DEFAULT 0,         -- รวมค่าแรงงาน (qty * labor_unit_price)
  amount NUMERIC NOT NULL DEFAULT 0,        -- รวมเงิน (material_amount + labor_amount)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_budget_items_company ON client_budget_items(company_id);
CREATE INDEX IF NOT EXISTS idx_client_budget_items_revision ON client_budget_items(revision_id);
ALTER TABLE client_budget_items DROP CONSTRAINT IF EXISTS client_budget_items_revision_fk;
ALTER TABLE client_budget_items ADD CONSTRAINT client_budget_items_revision_fk
  FOREIGN KEY (company_id, revision_id) REFERENCES client_budget_revisions(company_id, id) ON DELETE CASCADE;

-- Governs who can approve a budget revision (ข้อ 8: "ใครอนุมัติได้") — same
-- grant/revoke-by-permission-flag pattern as can_approve_applications above, rather than a
-- multi-step approval_conditions chain, since the request describes a single pending->approved/
-- rejected decision, not a sequential multi-approver flow.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS can_approve_budget BOOLEAN NOT NULL DEFAULT false;

-- ---------------- Budget flow business rules addendum (2026-07-24) ----------------
-- source_budget_id: set when a project budget (budget_scope='project') is auto-created by copying
-- an approved bidding budget's current revision after client_tenders.status -> 'won' (rule #1: BD
-- Initial Budget carries forward into PM's Initial Project Budget without re-importing the BOQ).
-- Preserves the audit trail back to which bidding budget a project budget came from. Nullable
-- because budgets created directly in PM without ever going through a tender have no such origin.
-- Self-referencing composite FK onto client_budgets(company_id, id), same pattern as every other
-- composite FK in this file — a project budget can only trace back to a bidding budget in the SAME
-- company.
ALTER TABLE client_budgets ADD COLUMN IF NOT EXISTS source_budget_id INTEGER;
ALTER TABLE client_budgets DROP CONSTRAINT IF EXISTS client_budgets_source_budget_fk;
ALTER TABLE client_budgets ADD CONSTRAINT client_budgets_source_budget_fk
  FOREIGN KEY (company_id, source_budget_id) REFERENCES client_budgets(company_id, id);
CREATE INDEX IF NOT EXISTS idx_client_budgets_source_budget ON client_budgets(source_budget_id);

-- strict_control: per-line-item override for control-budget checks (rule #3 — control is checked at
-- BOTH the total-revision level via client_budgets.control_enabled/warning_threshold_percent AND
-- independently per work_code here). When true, spending against this specific work_code that would
-- exceed its own `amount` is hard-blocked; when false (default), exceeding just this line only ever
-- warns. A project can be within its total budget while a single strict_control work_code is already
-- over — the two checks are independent, not one derived from the other.
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS strict_control BOOLEAN NOT NULL DEFAULT false;

-- work_code: lets a cost/labor entry declare which BOQ line item (client_budget_items.work_code)
-- it should be checked and counted against for rule #3's per-line control-budget check. Nullable —
-- entries with no work_code (or on a project with no client_budgets row at all) simply skip the
-- line-item check and only ever participate in the total-level one. Plain TEXT, not a FK: work_code
-- lives on client_budget_items scoped by revision_id, not by project_id directly, so validating
-- "this work_code exists on the project's CURRENT revision" is API-layer logic (resolve
-- client_budgets by project_id -> current_revision_id -> match work_code), not something a single
-- column-level FK could express. client_purchase_orders is deliberately not touched here — its line
-- items already live in a JSONB blob (see client_purchase_orders.items), and per-item budget
-- checking there is deferred, not part of this pass.
ALTER TABLE client_project_costs ADD COLUMN IF NOT EXISTS work_code TEXT;
ALTER TABLE client_labor_costs ADD COLUMN IF NOT EXISTS work_code TEXT;
CREATE INDEX IF NOT EXISTS idx_client_project_costs_work_code ON client_project_costs(project_id, work_code);
CREATE INDEX IF NOT EXISTS idx_client_labor_costs_work_code ON client_labor_costs(project_id, work_code);

-- ---------------- BOQ two-mode import addendum (2026-07-24) ----------------
-- is_group: marks a row as a category/header line (e.g. "หมวดงานโครงสร้าง") rather than a real
-- costed item — carries a description but no meaningful qty/unit_price/amount (left at their
-- NOT NULL DEFAULT 0). Both import modes (standard template's explicit "เป็นหมวดหมู่? (Y/N)" column
-- and the mapping mode's auto-detection of description-only rows) resolve to this same flag; nothing
-- downstream needs to know which mode produced it.
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false;
-- note: freeform per-row remark, only ever populated by the standard template's "หมายเหตุ" column
-- (the mapping mode has no equivalent field in this pass) or manual editing.
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
-- Deliberately NOT adding a separate sort_order column: `idx` (above, present since this table was
-- first created) already is "display order within a revision" — every read path already does
-- ORDER BY idx, and every write path (import, manual save, revise-copy) already assigns it
-- sequentially from array position. Drag-reorder just needs the frontend to reorder its in-memory
-- array before saving; a second column tracking the identical thing would just be two sources of
-- truth for one fact.

-- ---------------- BOQ material/labor split addendum (2026-07-24) ----------------
-- Splits the old single unit_price/amount pricing into separate material/labor components (BD/PM
-- budgeting needs to reason about the two independently). `amount` keeps its original name/meaning
-- (this row's total = material_amount + labor_amount) — nothing downstream that already reads
-- `amount` (checkBudgetControl, client_budget_revisions.total_amount) needs to change.
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS material_unit_price NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS labor_unit_price NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS material_amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS labor_amount NUMERIC NOT NULL DEFAULT 0;
-- Lossless migration for any pre-existing rows from before the split: old unit_price/amount had no
-- labor component, so it all becomes material. Guarded so re-running schema.sql after the column is
-- already gone is a no-op, not an error.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_budget_items' AND column_name='unit_price') THEN
    UPDATE client_budget_items SET material_unit_price = unit_price, material_amount = amount;
    ALTER TABLE client_budget_items DROP COLUMN unit_price;
  END IF;
END $$;

-- group_id: links a non-group row to the category/header row (is_group=true) it belongs under, so a
-- group's subtotal can be computed from its children at read time instead of being a second, staleable
-- source of truth. Single-level only (a group's own group_id is always NULL — no nested subgroups):
-- matches every real BOQ numbering scheme seen so far ("1" / "1.1" / "1.2" / "2" / "2.1"). Assignment
-- is never user-edited directly — it's derived once at write time from final saved row order (parent
-- group row always precedes its children in `idx`), by every one of the 4 places that insert items
-- (import-boq, the manual items PUT, /revise, and the tender-won bidding->project copy).
ALTER TABLE client_budget_items ADD COLUMN IF NOT EXISTS group_id INTEGER;
ALTER TABLE client_budget_items DROP CONSTRAINT IF EXISTS client_budget_items_group_fk;
ALTER TABLE client_budget_items ADD CONSTRAINT client_budget_items_group_fk
  FOREIGN KEY (group_id) REFERENCES client_budget_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_client_budget_items_group ON client_budget_items(group_id);

-- One row per saved column-mapping "profile" for the mapping-mode BOQ import (ข้อ 4-5 ของ Tab B) —
-- lets a company that always receives BOQs in the same non-standard layout (e.g. from one regular
-- subcontractor) skip re-mapping every time. column_mapping mirrors the shape POSTed to
-- boq-preview-mapped: {description, qty, unit, workCode, note, sequenceNo, materialUnitPriceColumn,
-- laborUnitPriceColumn, materialAmountColumn, laborAmountColumn, totalAmountColumn,
-- deletedColumnLabels:[...], summaryRowKeywords:[...]} — the latter is unioned with
-- BOQ_DEFAULT_SUMMARY_KEYWORDS (server.js) when auto-detecting "แถวสรุปยอด" rows on a later import
-- through this same profile. Stored as opaque JSONB since it's only ever read back verbatim to
-- pre-fill the mapping form, never queried by field.
CREATE TABLE IF NOT EXISTS client_boq_import_profiles (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES customer_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  column_mapping JSONB NOT NULL,
  created_by INTEGER REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_client_boq_import_profiles_company ON client_boq_import_profiles(company_id);

