/**
 * accounting.js — Command Center · Accounting & Tax tab
 *
 * ES module. Import once, after the #tab-accounting markup:
 *     <script type="module" src="accounting.js"></script>
 *
 * Responsibilities:
 *   - Open/close the Quick-Log modal (button, cancel, ESC, click-outside).
 *   - Live "deductible mileage" preview matching the backend split.
 *   - Submit to /api/create-expense as JSON.
 *   - Load existing expenses from /api/get-expenses on start/tab switch.
 *   - Delete rows via /api/delete-expense with user confirmation.
 *   - Load real-time KPI overview from /api/get-financials (Gross, Expenses, Net, Tax).
 */

// ── Mileage rate split — MUST match get_ytd_financials() in the database ──
const MILEAGE_RATE_PRE  = 0.725;         // before Jul 1, 2026
const MILEAGE_RATE_POST = 0.76;          // on/after Jul 1, 2026
const MILEAGE_CUTOFF    = '2026-07-01';  // YYYY-MM-DD compares correctly as a string

const CREATE_EXPENSE_ENDPOINT = '/api/create-expense';
const GET_EXPENSES_ENDPOINT   = '/api/get-expenses';
const DELETE_EXPENSE_ENDPOINT = '/api/delete-expense';
const GET_FINANCIALS_ENDPOINT = '/api/get-financials';
const MAX_RECEIPT_BYTES       = 4 * 1024 * 1024; // client-side cap; server backstops at 5 MB

const CATEGORY_LABELS = {
  'Line 22 - Supplies':            'Supplies',
  'Line 8 - Advertising':          'Advertising',
  'Line 20b - Rent/Lease':         'Rent/Lease',
  'Line 18 - Office/Software':     'Office/Software',
  'Line 27a - Other/Masterclasses':'Other/Masterclasses',
};

let els = {};
let wired = false;
let hasLoaded = false;

function $(id) { return document.getElementById(id); }

function rateForDate(dateStr) {
  return (dateStr && dateStr >= MILEAGE_CUTOFF) ? MILEAGE_RATE_POST : MILEAGE_RATE_PRE;
}

function fmtUSD(dollars) {
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function centsToUSD(cents) {
  return fmtUSD((Number(cents) || 0) / 100);
}
function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

// ── Modal ──
function openModal() {
  if (!els.overlay) return;
  if (els.date && !els.date.value) els.date.value = todayISO();
  updateMileagePreview();
  clearStatus();
  els.overlay.classList.add('open');
  if (els.vendor) els.vendor.focus();
}
function closeModal() {
  if (els.overlay) els.overlay.classList.remove('open');
}

// ── Live mileage preview ──
function updateMileagePreview() {
  if (!els.mileagePreview) return;
  const miles = Number(els.miles && els.miles.value) || 0;
  const rate  = rateForDate(els.date && els.date.value);
  const value = miles * rate;
  els.mileagePreview.querySelector('strong').textContent = fmtUSD(value);
  if (els.mileageRate) {
    els.mileageRate.textContent = miles > 0 ? `(${miles} mi × $${rate.toFixed(3)}/mi)` : `(rate $${rate.toFixed(3)}/mi)`;
  }
}

// ── Status line ──
function setStatus(msg, kind) {
  if (!els.status) return;
  els.status.textContent = msg || '';
  els.status.className = 'acc-status' + (kind ? ' ' + kind : '');
}
function clearStatus() { setStatus('', ''); }

// ── Receipt → base64 ──
function readReceipt(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Could not read the receipt file.'));
    reader.readAsDataURL(file);
  });
}

// ── Live Financial KPIs ──
async function loadFinancials() {
  const elGross = $('kpiGrossRev');
  const elExp   = $('kpiExpenses');
  const elNet   = $('kpiNetProfit');
  const elTax   = $('kpiTaxEst');

  if (!elGross) return;

  try {
    const res = await fetch(GET_FINANCIALS_ENDPOINT);
    if (!res.ok) throw new Error('Failed to fetch financials');
    let raw = await res.json();

    // Supabase RPC functions return an array with one row
    const data = Array.isArray(raw) ? raw[0] : (raw || {});

    // Sum service + retail revenue
    const serviceCents = Number(data.gross_exempt_service_revenue_cents) || 0;
    const retailCents  = Number(data.gross_taxable_retail_cents) || 0;
    const grossCents   = serviceCents + retailCents;

    // Total deductions = recorded business expenses + mileage write-off
    const expCents     = Number(data.total_expenses_cents) || 0;
    const mileageCents = Number(data.total_mileage_deduction_cents) || 0;
    const totalDeduct  = expCents + mileageCents;

    // Net taxable profit
    const netProfitCents = data.net_taxable_profit_cents !== undefined 
      ? Number(data.net_taxable_profit_cents) 
      : (grossCents - totalDeduct);

    // Tax reserve: 30% of profit if positive, else $0.00
    const taxReserve = Math.max(0, Math.round(netProfitCents * 0.30));

    elGross.textContent = centsToUSD(grossCents);
    elExp.textContent   = centsToUSD(totalDeduct);
    
    // Display net profit with minus sign if negative
    if (netProfitCents < 0) {
      elNet.textContent = '-' + centsToUSD(Math.abs(netProfitCents));
      elNet.style.color = '#ef4444'; // Red for net loss
    } else {
      elNet.textContent = centsToUSD(netProfitCents);
      elNet.style.color = '#10b981'; // Green for profit
    }

    elTax.textContent = centsToUSD(taxReserve);
  } catch (err) {
    console.error('accounting: load financials error:', err);
  }
}

// ── Submit (Create) ──
async function handleSubmit(e) {
  e.preventDefault();
  clearStatus();

  const expense_date   = els.date && els.date.value;
  const vendor         = (els.vendor && els.vendor.value || '').trim();
  const amount         = Number(els.amount && els.amount.value);
  const category       = els.category && els.category.value;
  const payment_source = els.payment && els.payment.value;
  const business_miles = Number(els.miles && els.miles.value) || 0;
  const notes          = (els.notes && els.notes.value || '').trim();

  if (!expense_date)                           return setStatus('Please choose a date.', 'err');
  if (!vendor)                                 return setStatus('Please enter a vendor.', 'err');
  if (!Number.isFinite(amount) || amount <= 0) return setStatus('Please enter an amount greater than 0.', 'err');
  if (!category)                               return setStatus('Please select a category.', 'err');
  if (!payment_source)                         return setStatus('Please select a payment source.', 'err');

  let receipt = null;
  const file = els.receipt && els.receipt.files && els.receipt.files[0];
  if (file) {
    if (file.size > MAX_RECEIPT_BYTES) {
      return setStatus('Receipt is larger than 4 MB. Please attach a smaller file.', 'err');
    }
    try {
      const dataBase64 = await readReceipt(file);
      receipt = { filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64 };
    } catch (err) {
      console.warn('accounting: receipt read failed, submitting without it:', err.message);
      receipt = null;
    }
  }

  els.submitBtn.disabled = true;
  setStatus('Saving…', '');

  try {
    const res = await fetch(CREATE_EXPENSE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expense_date, vendor, amount, category, payment_source, business_miles, notes, receipt }),
    });

    const payload = await res.json().catch(() => ({}));

    if (!res.ok || !payload.success) {
      setStatus(payload.error || 'Could not save the expense. Please try again.', 'err');
      els.submitBtn.disabled = false;
      return;
    }

    if (payload.expense) prependExpenseRow(payload.expense, true);

    // Refresh KPI totals immediately
    loadFinancials();

    els.form.reset();
    els.date.value = todayISO();
    updateMileagePreview();
    els.submitBtn.disabled = false;
    closeModal();
  } catch (err) {
    console.error('accounting: submit error:', err);
    setStatus('Network error. Please check your connection and try again.', 'err');
    els.submitBtn.disabled = false;
  }
}

// ── HTML Row Builder ──
function buildRowHTML(exp) {
  const capex = exp.is_capex_review
    ? '<span class="acc-badge capex" title="Amount over $2,500 — flagged for Section 179 / De Minimis review">CapEx review</span>'
    : '<span class="acc-muted">—</span>';

  // Make the receipt a clickable, opening link in a new tab
  const receipt = exp.receipt_url
    ? `<a href="${escapeHtml(exp.receipt_url)}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: underline;" title="View attached receipt">📎 View</a>`
    : '<span class="acc-muted">—</span>';

  const catLabel = CATEGORY_LABELS[exp.category] || exp.category || '';
  const miles = Number(exp.business_miles) || 0;

  // Calculate dynamic per-item deduction: Out-of-pocket + (miles * dynamic rate)
  const rate = rateForDate(exp.expense_date);
  const mileageDeductionCents = Math.round(miles * rate * 100);
  const totalDeductionCents = (Number(exp.amount_cents) || 0) + mileageDeductionCents;

  return (
    `<td>${escapeHtml(exp.expense_date)}</td>` +
    `<td>${escapeHtml(exp.vendor)}</td>` +
    `<td>${escapeHtml(catLabel)}</td>` +
    `<td class="acc-amount">${centsToUSD(exp.amount_cents)}</td>` +
    `<td class="acc-amount" style="font-weight: 600; color: #38bdf8;" title="Calculated tax write-off (${centsToUSD(exp.amount_cents)} direct + ${centsToUSD(mileageDeductionCents)} mileage)">${centsToUSD(totalDeductionCents)}</td>` +
    `<td>${miles ? miles : '<span class="acc-muted">—</span>'}</td>` +
    `<td>${escapeHtml(exp.payment_source || '')}</td>` +
    `<td>${capex}</td>` +
    `<td>${receipt}</td>` +
    `<td><button type="button" class="acc-del-btn" data-id="${exp.id}" title="Delete expense">Delete</button></td>`
  );
}

function showEmptyPlaceholder() {
  if (!els.rows) return;
  els.rows.innerHTML = '<tr id="accEmptyRow"><td class="acc-empty" colspan="10">No expenses logged yet. Click “+ Quick-Log Expense” to add your first one.</td></tr>';
}

function attachRowDeleteHandler(row, id) {
  const btn = row.querySelector('.acc-del-btn');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const expenseId = id || btn.getAttribute('data-id');
    if (!expenseId) return;
    if (!confirm('Are you sure you want to delete this expense?')) return;

    try {
      btn.disabled = true;
      const res = await fetch('/.netlify/functions/delete-expense', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: expenseId }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete expense');
      }

      row.remove();
      state.expenses = state.expenses.filter((x) => x.id !== expenseId);
      recalculateTotals();
      if (!state.expenses.length) showEmptyPlaceholder();
    } catch (err) {
      console.error('Delete error:', err);
      alert('Could not delete expense: ' + err.message);
      btn.disabled = false;
    }
  });
}
function prependExpenseRow(exp, isNew) {
  if (!els.rows) return;
  const emptyRow = $('accEmptyRow');
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');
  tr.id = `expense-row-${exp.id}`;
  if (isNew) tr.className = 'acc-new';
  tr.innerHTML = buildRowHTML(exp);

  attachRowDeleteHandler(tr, exp.id);
  els.rows.insertBefore(tr, els.rows.firstChild);
}

// ── Fetch Existing Expenses (Read) ──
async function loadExpenses() {
  if (!els.rows) return;

  try {
    const res = await fetch(GET_EXPENSES_ENDPOINT);
    if (!res.ok) throw new Error('Failed to load expenses');
    const expenses = await res.json();

    els.rows.innerHTML = '';
    if (!Array.isArray(expenses) || expenses.length === 0) {
      showEmptyPlaceholder();
      return;
    }

    expenses.forEach((exp) => {
      const tr = document.createElement('tr');
      tr.id = `expense-row-${exp.id}`;
      tr.innerHTML = buildRowHTML(exp);
      attachRowDeleteHandler(tr, exp.id);
      els.rows.appendChild(tr);
    });
  } catch (err) {
    console.error('accounting: load error:', err);
  }
}

// ── Delete Expense (Delete) ──
async function deleteExpense(id) {
  if (!id) return;
  if (!confirm('Are you sure you want to delete this expense record?')) return;

  try {
    const res = await fetch(DELETE_EXPENSE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.success) {
      alert(payload.error || 'Could not delete the expense. Please try again.');
      return;
    }

    const row = document.getElementById(`expense-row-${id}`);
    if (row) row.remove();

    if (els.rows && els.rows.children.length === 0) {
      showEmptyPlaceholder();
    }

    // Refresh KPI totals immediately
    loadFinancials();
  } catch (err) {
    console.error('accounting: delete error:', err);
    alert('Network error while deleting expense.');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Wiring / lifecycle ──
function wire() {
  if (wired) return;
  const section = $('tab-accounting');
  if (!section) return;

  els = {
    overlay:         $('accModalOverlay'),
    form:            $('accExpenseForm'),
    openBtn:         $('accOpenModal'),
    cancelBtn:       $('accCancelBtn'),
    submitBtn:       $('accSubmitBtn'),
    date:            $('accDate'),
    amount:          $('accAmount'),
    vendor:          $('accVendor'),
    category:        $('accCategory'),
    payment:         $('accPayment'),
    miles:           $('accMiles'),
    receipt:         $('accReceipt'),
    notes:           $('accNotes'),
    status:          $('accStatus'),
    mileagePreview:  $('accMileagePreview'),
    mileageRate:     $('accMileageRate'),
    rows:            $('accExpenseRows'),
    emptyRow:        $('accEmptyRow'),
  };

  if (els.openBtn)   els.openBtn.addEventListener('click', openModal);
  if (els.cancelBtn) els.cancelBtn.addEventListener('click', closeModal);
  if (els.form)      els.form.addEventListener('submit', handleSubmit);
  if (els.miles)     els.miles.addEventListener('input', updateMileagePreview);
  if (els.date)      els.date.addEventListener('change', updateMileagePreview);

  if (els.overlay) {
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) closeModal(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.overlay && els.overlay.classList.contains('open')) closeModal();
  });

  if (els.date && !els.date.value) els.date.value = todayISO();
  updateMileagePreview();
  wired = true;

  if (!hasLoaded) {
    hasLoaded = true;
    loadExpenses();
    loadFinancials();
  }
}

function activate() {
  wire();
  loadExpenses();
  loadFinancials();
}

window.AccountingTab = { activate };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}

export { activate };
