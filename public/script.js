/**
 * Cobranet Staff Bus Booking System — Frontend JavaScript
 * Version 2.0 — Supabase backend, test mode removed
 *
 * API endpoints consumed:
 *   POST   /api/login
 *   POST   /api/changePassword
 *   GET    /api/seats              (runs expiry + validation server-side)
 *   POST   /api/bookSeat
 *   GET    /api/staff
 *   POST   /api/staff
 *   PUT    /api/staff
 *   DELETE /api/staff
 *   GET    /api/settings
 *   POST   /api/settings
 *   GET    /api/reservations
 *   POST   /api/reservations
 *   DELETE /api/reservations
 *   POST   /api/resetBookings
 *   GET    /api/history
 *   DELETE /api/history
 */

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const API_BASE = window.location.hostname.includes('localhost')
  ? 'http://localhost:3000/api'
  : '/api';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

let currentUser      = null;
let cachedBookings   = {};
let cachedSettings   = { openTime: '16:50', closeTime: '17:00', resultsTime: '17:20', totalSeats: 30 };
let cachedReservations = [];
let cachedUsers      = [];
let cachedHistory    = [];

// ── Server time synchronisation ─────────────────────────────────────────────
// The difference between server UTC ms and local device ms.
// Applied to Date.now() so all time-sensitive logic uses server time
// regardless of device clock manipulation.
let serverTimeOffset = 0;   // ms: serverTime - clientTime at last sync
let serverLagosDay   = -1;  // server's current Lagos day-of-week (0=Sun…6=Sat), -1=unsynced

// ═══════════════════════════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════════════════════════

async function apiRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body && method !== 'GET') options.body = JSON.stringify(body);

  try {
    const res  = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`API Error (${endpoint}):`, err);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// SERVER TIME SYNC
// ═══════════════════════════════════════════════════════════════

/**
 * Returns the current time corrected to server time.
 * Device clock manipulation has no effect — the offset anchors all
 * comparisons to the server epoch regardless of local device settings.
 */
function getServerAdjustedTime() {
  return new Date(Date.now() + serverTimeOffset);
}

/**
 * Fetches /api/serverTime, computes the ms offset between server UTC and
 * local device UTC, and caches the Lagos day-of-week from the server.
 * Called once at startup then every 30 s so the offset stays fresh even
 * if the user changes their device clock mid-session.
 */
async function syncServerTime() {
  try {
    const fetchStart = Date.now();
    const data = await apiRequest('/serverTime', 'GET');
    const fetchEnd = Date.now();
    if (data && data.success && data.serverTime) {
      const halfRtt    = Math.round((fetchEnd - fetchStart) / 2);
      const serverMs   = new Date(data.serverTime).getTime();
      serverTimeOffset = (serverMs + halfRtt) - Date.now();
      serverLagosDay   = typeof data.lagosDay === 'number' ? data.lagosDay : -1;
    }
  } catch (err) {
    console.warn('[syncServerTime] fetch failed — using cached offset:', serverTimeOffset, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════

async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;

  if (!username || !password) {
    showLoginError('Please enter your username and password.');
    return;
  }

  try {
    const data = await apiRequest('/login', 'POST', { username, password });

    if (data.success) {
      currentUser = data.user;

      // Persist session so refresh does not log the user out
      localStorage.setItem('cobranet_user', JSON.stringify({
        _id:            currentUser._id,
        id:             currentUser._id,
        name:           currentUser.name,
        username:       currentUser.username,
        department:     currentUser.department || '',
        role:           currentUser.role,
        mustChangePw:   currentUser.mustChangePw || false,
        sessionVersion: currentUser.sessionVersion || 1
      }));

      document.getElementById('login-error').classList.add('hidden');
      document.getElementById('login-user').value = '';
      document.getElementById('login-pass').value = '';

      if (currentUser.mustChangePw) {
        showPage('page-change-password');
      } else {
        afterLogin();
      }
    } else {
      showLoginError(data.message || 'Invalid username or password.');
    }
  } catch {
    showLoginError('Network error. Please try again.');
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function afterLogin() {
  await loadAllData();

  if (currentUser.role === 'admin') {
    showPage('page-admin');
    refreshAdminPage();
  } else {
    showPage('page-dashboard');
    document.getElementById('dash-username').textContent = currentUser.name;
    refreshDashboard();
  }
}

function doLogout() {
  // Clear persisted session
  localStorage.removeItem('cobranet_user');
  currentUser    = null;
  cachedBookings = {};
  cachedUsers    = [];
  showPage('page-login');
}

// ═══════════════════════════════════════════════════════════════
// PASSWORD CHANGE
// ═══════════════════════════════════════════════════════════════

function checkPwStrength() {
  const pw  = document.getElementById('new-pw-1').value;
  const bar = document.getElementById('pw-strength-bar');
  const lbl = document.getElementById('pw-strength-label');

  let s = 0;
  if (pw.length >= 6)           s++;
  if (pw.length >= 10)          s++;
  if (/[A-Z]/.test(pw))        s++;
  if (/[0-9]/.test(pw))        s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;

  const cols = ['#dc2626', '#f97316', '#eab308', '#22c55e', '#16a34a'];
  const lbls = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

  bar.style.width      = (s * 20) + '%';
  bar.style.background = s ? cols[s - 1] : 'var(--gray-200)';
  lbl.textContent      = s ? lbls[s - 1] : '';
  lbl.style.color      = s ? cols[s - 1] : 'var(--gray-500)';
}

async function doChangePassword() {
  const pw1 = document.getElementById('new-pw-1').value;
  const pw2 = document.getElementById('new-pw-2').value;
  const err = document.getElementById('pw-change-error');

  if (pw1.length < 6) {
    err.textContent = 'Password must be at least 6 characters.';
    err.classList.remove('hidden');
    return;
  }
  if (pw1 !== pw2) {
    err.textContent = 'Passwords do not match.';
    err.classList.remove('hidden');
    return;
  }

  try {
    const data = await apiRequest('/changePassword', 'POST', {
      userId: currentUser._id,
      newPassword: pw1
    });

    if (data.success) {
      currentUser.mustChangePw = false;

      // Refresh stored session with cleared mustChangePw flag
      localStorage.setItem('cobranet_user', JSON.stringify({
        _id:            currentUser._id,
        id:             currentUser._id,
        name:           currentUser.name,
        username:       currentUser.username,
        department:     currentUser.department || '',
        role:           currentUser.role,
        mustChangePw:   false,
        sessionVersion: currentUser.sessionVersion || 1
      }));

      err.classList.add('hidden');
      document.getElementById('new-pw-1').value = '';
      document.getElementById('new-pw-2').value = '';
      showToast('✅ Password set! Welcome to Cobranet Bus Booking.', 'success');
      afterLogin();
    } else {
      err.textContent = data.message || 'Failed to change password.';
      err.classList.remove('hidden');
    }
  } catch {
    err.textContent = 'Network error. Please try again.';
    err.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════

async function loadAllData() {
  try {
    // Establish server time offset FIRST so all subsequent state calculations
    // use server time rather than the device clock.
    await syncServerTime();

    // GET /api/seats runs expiry + validation server-side before returning
    const seatsData = await apiRequest('/seats', 'GET');
    if (seatsData.success) {
      cachedBookings     = seatsData.bookings     || {};
      cachedReservations = seatsData.reservations || [];
      cachedSettings     = seatsData.settings     || cachedSettings;
    }

    if (currentUser?.role === 'admin') {
      const usersData = await apiRequest('/staff', 'GET');
      if (usersData.success) cachedUsers = usersData.users || [];

      const historyData = await apiRequest('/history', 'GET');
      if (historyData.success) cachedHistory = historyData.flatHistory || [];
    }
  } catch (err) {
    console.error('loadAllData error:', err);
  }
}

async function refreshBookings() {
  try {
    const seatsData = await apiRequest('/seats', 'GET');
    if (seatsData.success) {
      cachedBookings     = seatsData.bookings     || {};
      cachedReservations = seatsData.reservations || [];
      cachedSettings     = seatsData.settings     || cachedSettings;

      // ── Session version check (forced-logout detection) ──────────────
      // If an admin has called POST /api/forceLogoutAll, the server increments
      // session_version.  We compare it against the value stored at login.
      // A mismatch means this session is no longer valid → log out immediately.
      const serverVersion = seatsData.settings && seatsData.settings.sessionVersion;
      if (serverVersion && currentUser) {
        const stored = parseInt(
          (JSON.parse(localStorage.getItem('cobranet_user') || '{}').sessionVersion) || 1,
          10
        );
        if (serverVersion > stored) {
          console.warn('[session] Version mismatch — forcing logout. Server:', serverVersion, 'Stored:', stored);
          doLogout();
          showToast('⚠️ Your session has been ended by an administrator. Please log in again.', 'error');
          return;
        }
      }
    }
  } catch (err) {
    console.error('refreshBookings error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTING
// ═══════════════════════════════════════════════════════════════

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function goToDashboard() {
  showPage('page-dashboard');
  document.getElementById('dash-username').textContent = currentUser.name;
  refreshDashboard();
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM STATE  (real schedule only — no test mode)
// ═══════════════════════════════════════════════════════════════

/**
 * Returns: 'before_open' | 'open' | 'results' | 'reset' | 'weekend'
 *
 * Booking is allowed ONLY when:
 *   current_time >= booking_start_time  AND  current_time <= booking_end_time
 * (from system_settings table — admin-configurable, no simulation override)
 */
function getSystemState() {
  // Use server-adjusted time — device clock manipulation has no effect.
  const now = getServerAdjustedTime();
  // Prefer the server-provided Lagos day-of-week; fall back to local only
  // if we have never successfully synced (serverLagosDay === -1).
  const day = serverLagosDay >= 0 ? serverLagosDay : now.getDay();

  // Skip weekends
  if (day === 0 || day === 6) return 'weekend';

  const s  = cachedSettings;
  const nm = now.getHours() * 60 + now.getMinutes();

  const [oh, om] = (s.openTime    || '16:50').split(':').map(Number);
  const [ch, cm] = (s.closeTime   || '17:00').split(':').map(Number);
  const [rh, rm] = (s.resultsTime || '17:20').split(':').map(Number);

  if (nm < oh * 60 + om) return 'before_open';
  if (nm < ch * 60 + cm) return 'open';
  if (nm < rh * 60 + rm) return 'results';
  return 'reset';
}

function parseTimeStr(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return { h, m };
}

function msToNext(h, m) {
  const now = getServerAdjustedTime();
  const t   = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

/** Skips Saturday and Sunday (Friday → Monday countdown) */
function msToNextWeekdayFriday(h, m) {
  const now = getServerAdjustedTime();
  const t   = new Date(now);
  t.setHours(h, m, 0, 0);
  while (t <= now || t.getDay() === 0 || t.getDay() === 6)
    t.setDate(t.getDate() + 1);
  return t - now;
}

function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s  = Math.floor(ms / 1000);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map(v => String(v).padStart(2, '0')).join(':');
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════

async function refreshDashboard() {
  if (!currentUser) return;

  await refreshBookings();

  const state = getSystemState();
  const bk    = cachedBookings;
  const s     = cachedSettings;

  ['countdown-section', 'seat-section', 'results-section',
   'my-booking-card', 'verification-section', 'grace-section']
    .forEach(id => document.getElementById(id).classList.add('hidden'));

  const banner = document.getElementById('status-banner');
  const dot    = document.getElementById('banner-dot');
  const txt    = document.getElementById('banner-text');
  banner.className = 'status-banner';

  if (state === 'open') {
    banner.classList.add('banner-open');
    dot.className  = 'banner-dot dot-green';
    txt.textContent = '🟢 Booking is OPEN — Select your seat now! Closes at ' + s.closeTime;

    renderSeatGrid(bk, s.totalSeats, true);
    document.getElementById('seat-section').classList.remove('hidden');

    const mine = Object.entries(bk).find(([, v]) => v.username === currentUser.username);
    if (mine) {
      document.getElementById('my-booking-card').classList.remove('hidden');
      document.getElementById('my-booking-num').textContent   = mine[0];
      document.getElementById('my-booking-label').textContent =
        'Seat ' + mine[0] + ' — Booked at ' + mine[1].time;
    }

    const taken = Object.keys(bk).length;
    document.getElementById('seats-remaining').textContent =
      (s.totalSeats - taken) + ' seat' + (s.totalSeats - taken !== 1 ? 's' : '') + ' remaining';

  } else if (state === 'results') {
    banner.classList.add('banner-results');
    dot.className   = 'banner-dot dot-brand';
    txt.textContent = "📋 Booking CLOSED — Today's seat assignments are shown below.";
    renderResultsTable(bk);
    document.getElementById('results-section').classList.remove('hidden');

  } else if (state === 'weekend') {
    banner.classList.add('banner-weekend');
    dot.className   = 'banner-dot dot-amber';
    txt.textContent = '📅 Bus booking is not available on weekends. See you Monday!';
    const { h, m }  = parseTimeStr(s.openTime);
    document.getElementById('countdown-display').textContent =
      formatCountdown(msToNextWeekdayFriday(h, m));
    document.getElementById('countdown-sub').textContent =
      'Next booking window: Monday at ' + s.openTime;
    document.getElementById('countdown-section').classList.remove('hidden');

  } else {
    // before_open or reset
    banner.classList.add('banner-closed');
    dot.className   = 'banner-dot dot-red';
    txt.textContent = state === 'before_open'
      ? '🔒 Booking not yet open. Opens at ' + s.openTime + ' today.'
      : '🔒 Booking has closed for today. Resets tomorrow at ' + s.openTime + '.';

    const { h, m } = parseTimeStr(s.openTime);
    const ms = state === 'before_open' ? msToNext(h, m) : msToNextWeekdayFriday(h, m);
    document.getElementById('countdown-display').textContent = formatCountdown(ms);
    document.getElementById('countdown-sub').textContent     = 'Seat booking opens at ' + s.openTime;
    document.getElementById('countdown-section').classList.remove('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════
// SEAT GRID RENDERING
//
// Color rules (spec §6):
//   Green  — available
//   Red    — permanent reservation
//   Orange — temporary reservation, expires_at > now
//   Green  — expired temporary (treat as available)
// ═══════════════════════════════════════════════════════════════

/** Returns the active reservation for a seat number, or null */
function getReservationForSeat(seatNumber) {
  const now  = getServerAdjustedTime();
  const sNum = parseInt(seatNumber, 10);

  return cachedReservations.find(r => {
    if (r.seat !== sNum) return false;
    if (r.type === 'permanent') return true;
    if (r.type === 'temporary') {
      return r.expiresAt ? new Date(r.expiresAt) > now : false;
    }
    return false;
  }) || null;
}

/** Returns list of seat numbers (as strings) that are currently reserved */
function getActiveReservedSeats() {
  const now = getServerAdjustedTime();
  return cachedReservations
    .filter(r => {
      if (r.type === 'permanent') return true;
      if (r.type === 'temporary') return r.expiresAt && new Date(r.expiresAt) > now;
      return false;
    })
    .map(r => String(r.seat));
}

// ═══════════════════════════════════════════════════════════════
// CENTRALISED SEAT DISPLAY STATUS  (Issue 1)
//
// Returns exactly one of:  'FREE' | 'TAKEN' | 'YOURS'
//
//   FREE  — seat has no booking and no active reservation
//   TAKEN — seat is booked by another staff OR held by an admin reservation
//   YOURS — seat belongs to the currently-logged-in user
//
// All seat-rendering code must use this function. The internal
// reservation types ('permanent', 'temporary') and their DB labels
// ('RSVD', 'TEMP', 'RESERVED', etc.) must never surface in the UI.
// ═══════════════════════════════════════════════════════════════
function getSeatDisplayStatus(seatNum, bk, currentUsername) {
  const sNum         = String(seatNum);
  const reservedSeats = getActiveReservedSeats();

  // Current user's own confirmed booking
  if (bk[sNum] && bk[sNum].username === (currentUsername || '').toLowerCase()) {
    return 'YOURS';
  }

  // Booked by another staff member OR held by an admin reservation
  if (bk[sNum] || reservedSeats.includes(sNum)) {
    return 'TAKEN';
  }

  return 'FREE';
}

function renderSeatGrid(bk, total, interactive) {
  const grid = document.getElementById('seat-grid');
  grid.innerHTML = '';

  const mine          = Object.entries(bk).find(([, v]) => v.username === currentUser?.username);
  const reservedSeats = getActiveReservedSeats();
  const now           = getServerAdjustedTime();

  for (let i = 1; i <= total; i++) {
    const sNum = String(i);
    const btn  = document.createElement('button');
    btn.className = 'seat-btn';

    const reservation = getReservationForSeat(i);
    const isReserved  = reservedSeats.includes(sNum);

    if (mine && sNum === mine[0]) {
      // ── Your own booking ──────────────────────────────────────────
      btn.classList.add('seat-mine');
      btn.innerHTML = `<span class="seat-num">${i}</span><span class="seat-label">YOURS</span>`;
      btn.disabled  = true;

    } else if (isReserved) {
      // ── Reserved seat — admin-reserved, shows as TAKEN ────────────
      // Visual colour (red vs orange) distinguishes permanent vs temporary
      // for admin awareness, but the label is always TAKEN per spec.
      btn.disabled = true;

      if (reservation?.type === 'permanent') {
        btn.classList.add('seat-reserved-permanent');
        btn.innerHTML = `<span class="seat-num">${i}</span><span class="seat-label">TAKEN</span>`;
      } else {
        btn.classList.add('seat-reserved-temporary');
        btn.innerHTML = `<span class="seat-num">${i}</span><span class="seat-label">TAKEN</span>`;
      }

    } else if (bk[sNum]) {
      // ── Taken by another staff member ─────────────────────────────
      btn.classList.add('seat-taken');
      btn.innerHTML = `<span class="seat-num">${i}</span><span class="seat-label">TAKEN</span>`;
      btn.disabled  = true;

    } else if (!interactive) {
      // ── Closed / not interactive ──────────────────────────────────
      btn.classList.add('seat-disabled');
      btn.innerHTML = `<span class="seat-num">${i}</span><span class="seat-label">—</span>`;
      btn.disabled  = true;

    } else {
      // ── Available ─────────────────────────────────────────────────
      btn.classList.add('seat-available');
      btn.innerHTML = `<span class="seat-num">${i}</span><span class="seat-label">FREE</span>`;
      btn.onclick   = () => selectSeat(i);
    }

    grid.appendChild(btn);
  }
}

async function selectSeat(num) {
  if (!currentUser) return;
  // Note: client-side state check is for UX only (hides the button).
  // The real enforcement is server-side in POST /api/bookSeat.
  if (getSystemState() !== 'open') {
    showToast('Seat booking is not open right now.', 'error');
    return;
  }

  const sNum          = String(num);
  const reservedSeats = getActiveReservedSeats();

  if (reservedSeats.includes(sNum)) {
    showToast('Seat ' + num + ' is not available. Please choose another.', 'error');
    refreshDashboard();
    return;
  }

  if (cachedBookings[sNum]) {
    showToast('Seat ' + num + ' was just taken — please choose another.', 'error');
    refreshDashboard();
    return;
  }

  try {
    const data = await apiRequest('/bookSeat', 'POST', {
      seatNumber: num,
      userId:     currentUser._id,
      username:   currentUser.username,
      name:       currentUser.name
    });

    if (data.success) {
      cachedBookings = { ...cachedBookings, [sNum]: data.booking };
      showToast('✅ Seat ' + num + ' reserved!', 'success');
      refreshDashboard();
    } else {
      // Show the server's message verbatim — it may contain the authoritative
      // window time (e.g. "Booking window has not opened yet. Opens at 07:00").
      showToast(data.message || 'Failed to book seat.', 'error');
      refreshDashboard();
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  }
}

async function changeMyBooking() {
  if (getSystemState() !== 'open') {
    showToast('Booking window is closed.', 'error');
    return;
  }

  const prev = Object.entries(cachedBookings)
    .find(([, v]) => v.username === currentUser.username);

  if (prev) delete cachedBookings[prev[0]];

  showToast('Seat released — please select a new seat.', '');
  refreshDashboard();
}

// ═══════════════════════════════════════════════════════════════
// RESULTS TABLE
// ═══════════════════════════════════════════════════════════════

function formatResultsDate() {
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const d = getServerAdjustedTime();
  return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function renderResultsTable(bk) {
  const tbody  = document.getElementById('results-body');
  const dateEl = document.getElementById('results-date-text');
  if (dateEl) dateEl.textContent = formatResultsDate();

  // Sort all seats numerically
  const allEntries = Object.entries(bk).sort((a, b) => Number(a[0]) - Number(b[0]));

  // Staff count excludes reserved-seat placeholders (same logic as before)
  const staffCount = allEntries.filter(([, v]) => !v._reserved).length;
  document.getElementById('results-count').textContent = staffCount + ' staff booked';

  tbody.innerHTML = '';

  if (!allEntries.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No bookings for today.</td></tr>';
    return;
  }

  // BUG 1 FIX: render ALL seats — confirmed bookings AND reserved seats.
  // Previously .filter(([,v]) => !v._reserved) removed reserved seats so they
  // never appeared on the Home Screen results table, even though they showed
  // correctly in the admin Today's Seat Bookings tab (renderAdminBookings has
  // no such filter). Reserved seats now render with the label (staff/role name)
  // and booking start time returned by the API, matching the same data source
  // as confirmed bookings — no RESERVED badge, no dash for time.
  let rowIndex = 1;
  allEntries.forEach(([seat, info]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rowIndex++}</td>
      <td><span class="badge badge-brand">Seat ${seat}</span></td>
      <td>${info.name}</td>
      <td>${info.time}</td>`;
    tbody.appendChild(tr);
  });
}

// ═══════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════

function refreshAdminPage() {
  refreshAdminStats();
  renderUsersTable();
  renderAdminBookings();
  renderHistory();
  loadSettingsForm();
  populateResSeatSelect();
  renderReservationsList();
}

function refreshAdminStats() {
  const staffCount = cachedUsers.filter(u => u.role === 'staff').length;
  const bkCount    = Object.keys(cachedBookings).length;
  const s          = cachedSettings;
  const days       = new Set(cachedHistory.map(h => h.date)).size;

  document.getElementById('admin-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${staffCount}</div>
      <div class="stat-label">Staff Members</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${bkCount}</div>
      <div class="stat-label">Today's Bookings</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${s.totalSeats - bkCount}</div>
      <div class="stat-label">Seats Free</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${cachedReservations.length}</div>
      <div class="stat-label">Reserved Seats</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${days}</div>
      <div class="stat-label">Days Recorded</div>
    </div>`;
}

function renderUsersTable() {
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = '';

  cachedUsers.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code style="background:var(--gray-100);padding:.2rem .4rem;border-radius:4px;font-size:.82rem;">${u.username}</code></td>
      <td>${u.name}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-black' : 'badge-gray'}">${u.role}</span></td>
      <td>${u.department || '—'}</td>
      <td><span class="badge ${u.mustChangePw ? 'badge-red' : 'badge-green'}">${u.mustChangePw ? 'Temp' : 'Set'}</span></td>
      <td>${u.username !== 'admin'
        ? `<div style="display:flex;gap:.4rem;">
             <button class="btn btn-secondary btn-sm" onclick="openEditUserModal('${u._id}')">Edit</button>
             <button class="btn btn-danger btn-sm"    onclick="removeUser('${u._id}')">Remove</button>
           </div>`
        : '<span class="text-muted text-sm">Protected</span>'}</td>`;
    tbody.appendChild(tr);
  });
}

function renderAdminBookings() {
  const tbody   = document.getElementById('admin-bookings-body');
  const entries = Object.entries(cachedBookings).sort((a, b) => Number(a[0]) - Number(b[0]));

  tbody.innerHTML = '';
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No bookings today.</td></tr>';
    return;
  }

  entries.forEach(([seat, info]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="badge badge-brand">Seat ${seat}</span></td>
      <td>${info.name}</td>
      <td>${info.username}</td>
      <td>${info.department || '—'}</td>
      <td>${info.time}</td>`;
    tbody.appendChild(tr);
  });
}

function renderHistory() {
  const tbody = document.getElementById('history-body');
  tbody.innerHTML = '';

  const rows = [...cachedHistory].sort(
    (a, b) => b.date.localeCompare(a.date) || a.seat - b.seat
  );

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No history found.</td></tr>';
    return;
  }

  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.date}</td>
      <td><span class="badge badge-brand">Seat ${r.seat}</span></td>
      <td>${r.name}</td>
      <td>${r.username}</td>
      <td>${r.time}</td>`;
    tbody.appendChild(tr);
  });
}

function loadSettingsForm() {
  const s = cachedSettings;
  document.getElementById('setting-open').value    = s.openTime    || '16:50';
  document.getElementById('setting-close').value   = s.closeTime   || '17:00';
  document.getElementById('setting-results').value = s.resultsTime || '17:20';
  document.getElementById('setting-seats').value   = s.totalSeats  || 30;
}

async function saveSettings() {
  const settings = {
    openTime:    document.getElementById('setting-open').value,
    closeTime:   document.getElementById('setting-close').value,
    resultsTime: document.getElementById('setting-results').value,
    totalSeats:  parseInt(document.getElementById('setting-seats').value, 10)
  };

  try {
    const data = await apiRequest('/settings', 'POST', settings);
    if (data.success) {
      cachedSettings = settings;
      showToast('Settings saved.', 'success');
    } else {
      showToast(data.message || 'Failed to save settings.', 'error');
    }
  } catch {
    showToast('Network error. Please try again.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function openAddUserModal() {
  openModal('Add New Staff Member', `
    <div class="form-group">
      <label class="form-label">Full Name</label>
      <input class="form-input" id="m-name" type="text" placeholder="e.g. Jane Okafor"/>
    </div>
    <div class="form-group">
      <label class="form-label">Username (staff ID)</label>
      <input class="form-input" id="m-username" type="text" placeholder="e.g. jokafor"/>
    </div>
    <div class="form-group">
      <label class="form-label">Department</label>
      <input class="form-input" id="m-department" type="text" placeholder="e.g. Engineering"/>
    </div>
    <div class="form-group">
      <label class="form-label">Temporary Password</label>
      <input class="form-input" id="m-password" type="password" placeholder="Staff will change on first login"/>
    </div>
    <div class="form-group">
      <label class="form-label">Role</label>
      <select class="form-input" id="m-role">
        <option value="staff">Staff</option>
        <option value="admin">Admin</option>
      </select>
    </div>
    <p class="text-sm text-muted mt-2">Staff will be prompted to set a new password on first login.</p>
    <div id="m-error" class="form-error hidden"></div>
  `, [
    { label: 'Cancel',    cls: 'btn-secondary', fn: closeModal },
    { label: 'Add Staff', cls: 'btn-primary',   fn: doAddUser  }
  ]);
}

async function doAddUser() {
  const name       = document.getElementById('m-name').value.trim();
  const username   = document.getElementById('m-username').value.trim().toLowerCase();
  const department = document.getElementById('m-department').value.trim();
  const password   = document.getElementById('m-password').value;
  const role       = document.getElementById('m-role').value;
  const err        = document.getElementById('m-error');

  if (!name || !username || !password) {
    err.textContent = 'Name, username, and password are required.';
    err.classList.remove('hidden');
    return;
  }

  try {
    const data = await apiRequest('/staff', 'POST', { name, username, department, password, role });

    if (data.success) {
      cachedUsers.push(data.user);
      closeModal();
      renderUsersTable();
      refreshAdminStats();
      showToast('Staff member added.', 'success');
    } else {
      err.textContent = data.message || 'Failed to add staff member.';
      err.classList.remove('hidden');
    }
  } catch {
    err.textContent = 'Network error. Please try again.';
    err.classList.remove('hidden');
  }
}

function openEditUserModal(userId) {
  const u = cachedUsers.find(x => x._id === userId);
  if (!u) return;

  openModal('Edit Staff Member', `
    <div class="form-group">
      <label class="form-label">Full Name</label>
      <input class="form-input" id="m-name" type="text" value="${u.name}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Department</label>
      <input class="form-input" id="m-department" type="text" value="${u.department || ''}"/>
    </div>
    <div class="form-group">
      <label class="form-label">Reset Password (leave blank to keep current)</label>
      <input class="form-input" id="m-password" type="password" placeholder="New temporary password"/>
    </div>
    <div class="form-group">
      <label class="form-label">Role</label>
      <select class="form-input" id="m-role">
        <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
    </div>
    <div id="m-error" class="form-error hidden"></div>
  `, [
    { label: 'Cancel',       cls: 'btn-secondary', fn: closeModal },
    { label: 'Save Changes', cls: 'btn-primary',   fn: () => doEditUser(userId) }
  ]);
}

async function doEditUser(userId) {
  const name       = document.getElementById('m-name').value.trim();
  const department = document.getElementById('m-department').value.trim();
  const password   = document.getElementById('m-password').value;
  const role       = document.getElementById('m-role').value;
  const err        = document.getElementById('m-error');

  if (!name) {
    err.textContent = 'Name is required.';
    err.classList.remove('hidden');
    return;
  }

  try {
    const body = { userId, name, role, department };
    if (password) body.password = password;

    const data = await apiRequest('/staff', 'PUT', body);

    if (data.success) {
      const idx = cachedUsers.findIndex(u => u._id === userId);
      if (idx !== -1) {
        cachedUsers[idx].name       = name;
        cachedUsers[idx].department = department;
        cachedUsers[idx].role       = role;
        if (password) cachedUsers[idx].mustChangePw = true;
      }
      closeModal();
      renderUsersTable();
      showToast('Staff member updated.', 'success');
    } else {
      err.textContent = data.message || 'Failed to update.';
      err.classList.remove('hidden');
    }
  } catch {
    err.textContent = 'Network error. Please try again.';
    err.classList.remove('hidden');
  }
}

async function removeUser(userId) {
  const u = cachedUsers.find(x => x._id === userId);
  if (!u) return;

  openModal('Remove Staff Member',
    `<p class="text-sm">Are you sure you want to remove <strong>${u.username}</strong>? This cannot be undone.</p>`,
    [
      { label: 'Cancel', cls: 'btn-secondary', fn: closeModal },
      {
        label: 'Remove',
        cls:   'btn-danger',
        fn:    async () => {
          try {
            const data = await apiRequest('/staff', 'DELETE', { userId });
            if (data.success) {
              cachedUsers = cachedUsers.filter(x => x._id !== userId);
              closeModal();
              renderUsersTable();
              refreshAdminStats();
              showToast('Staff member removed.', '');
            } else {
              showToast(data.message || 'Failed to remove.', 'error');
            }
          } catch {
            showToast('Network error.', 'error');
          }
        }
      }
    ]
  );
}

// ═══════════════════════════════════════════════════════════════
// BOOKING MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function confirmResetBookings() {
  openModal("Reset Today's Bookings",
    `<p class="text-sm text-muted">This clears all seat bookings for today. Staff will need to re-select their seats.</p>`,
    [
      { label: 'Cancel', cls: 'btn-secondary', fn: closeModal },
      {
        label: 'Reset Bookings',
        cls:   'btn-danger',
        fn:    async () => {
          try {
            const data = await apiRequest('/resetBookings', 'POST');
            if (data.success) {
              cachedBookings = {};
              closeModal();
              renderAdminBookings();
              refreshAdminStats();
              showToast("Today's bookings reset.", '');
            } else {
              showToast(data.message || 'Failed to reset.', 'error');
            }
          } catch {
            showToast('Network error.', 'error');
          }
        }
      }
    ]
  );
}

function confirmForceLogoutAll() {
  openModal('Force Logout All Users',
    `<p class="text-sm">This will immediately log out <strong>all active users</strong>. They will be prompted to log in again on their next page refresh.<br><br>No data will be deleted.</p>`,
    [
      { label: 'Cancel', cls: 'btn-secondary', fn: closeModal },
      {
        label: 'Force Logout All',
        cls:   'btn-danger',
        fn:    async () => {
          try {
            const data = await apiRequest('/forceLogoutAll', 'POST');
            if (data.success) {
              closeModal();
              showToast('✅ All sessions invalidated. Users will be logged out on next poll.', 'success');
            } else {
              showToast(data.message || 'Failed to force logout.', 'error');
            }
          } catch {
            showToast('Network error.', 'error');
          }
        }
      }
    ]
  );
}

function confirmClearHistory() {
  openModal('Clear All History',
    `<p class="text-sm" style="color:var(--red);">This permanently deletes ALL booking history. This cannot be undone.</p>`,
    [
      { label: 'Cancel', cls: 'btn-secondary', fn: closeModal },
      {
        label: 'Clear All History',
        cls:   'btn-danger',
        fn:    async () => {
          try {
            const data = await apiRequest('/history', 'DELETE');
            if (data.success) {
              cachedHistory  = [];
              cachedBookings = {};
              closeModal();
              renderHistory();
              renderAdminBookings();
              refreshAdminStats();
              showToast('All history cleared.', '');
            } else {
              showToast(data.message || 'Failed to clear.', 'error');
            }
          } catch {
            showToast('Network error.', 'error');
          }
        }
      }
    ]
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════

function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF();
  const bk   = cachedBookings;
  const date = getServerAdjustedTime().toISOString().split('T')[0];
  doc.rect(0, 0, 210, 30, 'F');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.setFont(undefined, 'bold');
  doc.text('Cobranet Limited', 14, 14);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text('Staff Bus Seat Assignments — ' + date, 14, 23);

  let y = 42;
  doc.setFillColor(17, 17, 17);
  doc.rect(14, y - 5, 182, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont(undefined, 'bold');
  doc.text('#', 16, y); doc.text('Seat', 28, y);
  doc.text('Staff Name', 55, y); doc.text('Time', 148, y);

  y += 10;
  doc.setFont(undefined, 'normal');
  doc.setTextColor(30, 30, 30);

  Object.entries(bk)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([seat, info], idx) => {
      if (idx % 2 === 0) { doc.setFillColor(255, 244, 232); doc.rect(14, y - 5, 182, 8, 'F'); }
      doc.text(String(idx + 1), 16, y);
      doc.text('Seat ' + seat, 28, y);
      doc.text(info.name, 55, y);
      doc.text(info.time, 148, y);
      y += 9;
      if (y > 270) { doc.addPage(); y = 20; }
    });

  doc.setFontSize(7);
  doc.setTextColor(170);
  doc.text('Generated: ' + getServerAdjustedTime().toLocaleString() + ' | Cobranet Limited', 14, 290);
  doc.save('cobranet-seats-' + date + '.pdf');
  showToast('PDF exported!', 'success');
}

function exportExcel() {
  const bk   = cachedBookings;
  const date = getServerAdjustedTime().toISOString().split('T')[0];

  Object.entries(bk)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([seat, info], idx) =>
      rows.push([idx + 1, Number(seat), info.name, info.username, info.department || '', info.time, date])
    );

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Seat Assignments');
  XLSX.writeFile(wb, 'cobranet-seats-' + date + '.xlsx');
  showToast('Excel exported!', 'success');
}

// ═══════════════════════════════════════════════════════════════
// RESERVATIONS PANEL (Admin)
// ═══════════════════════════════════════════════════════════════

function populateResSeatSelect() {
  const sel = document.getElementById('res-seat-num');
  if (!sel) return;
  sel.innerHTML = '';
  const total = cachedSettings.totalSeats || 30;
  for (let i = 1; i <= total; i++) {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = 'Seat ' + i;
    sel.appendChild(o);
  }
}

function toggleResDays() {
  const t = document.getElementById('res-type').value;
  document.getElementById('res-days-group').style.display = t === 'temporary' ? 'block' : 'none';
}

async function addReservation() {
  const seat  = parseInt(document.getElementById('res-seat-num').value, 10);
  const label = document.getElementById('res-label').value.trim();
  const type  = document.getElementById('res-type').value;
  const days  = parseInt(document.getElementById('res-days').value, 10) || 1;
  const errEl = document.getElementById('res-error');

  if (!label) {
    errEl.textContent  = 'Please enter a label for this reservation.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const data = await apiRequest('/reservations', 'POST', { seat, label, type, days });

    if (data.success) {
      cachedReservations.push(data.reservation);
      errEl.style.display = 'none';
      document.getElementById('res-label').value = '';
      renderReservationsList();
      refreshAdminStats();
      showToast('Seat ' + seat + ' reserved (' + (type === 'permanent' ? 'Permanent' : days + ' day(s)') + ').', 'success');
    } else {
      errEl.textContent  = data.message || 'Failed to add reservation.';
      errEl.style.display = 'block';
    }
  } catch {
    errEl.textContent  = 'Network error. Please try again.';
    errEl.style.display = 'block';
  }
}

async function removeReservation(seat) {
  try {
    const data = await apiRequest('/reservations', 'DELETE', { seat });
    if (data.success) {
      cachedReservations = cachedReservations.filter(r => r.seat !== seat);
      renderReservationsList();
      refreshAdminStats();
      showToast('Reservation for Seat ' + seat + ' removed.', '');
    } else {
      showToast(data.message || 'Failed to remove reservation.', 'error');
    }
  } catch {
    showToast('Network error.', 'error');
  }
}

function renderReservationsList() {
  const list  = document.getElementById('res-list');
  const empty = document.getElementById('res-empty');
  const count = document.getElementById('res-count');
  if (!list) return;

  const now = getServerAdjustedTime();

  if (!cachedReservations.length) {
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  const sorted = [...cachedReservations].sort((a, b) => a.seat - b.seat);
  list.innerHTML = '';

  sorted.forEach(r => {
    const isExpired = r.type === 'temporary' && r.expiresAt && new Date(r.expiresAt) < now;
    const div = document.createElement('div');
    div.className = 'res-item';

    let meta = '';
    if (r.type === 'permanent') {
      meta = '<span class="res-perm-badge">Permanent</span>';
    } else if (isExpired) {
      meta = '<span class="res-expired-badge">Expired ' + (r.expiresDate || '') + '</span>';
    } else {
      meta = '<span class="res-temp-badge">Until ' + (r.expiresDate || r.expiresAt?.split('T')[0] || '?') + '</span>';
    }

    div.innerHTML = `
      <div class="res-item-info">
        <div class="res-seat-badge">${r.seat}</div>
        <div>
          <div class="res-item-name">${r.label}</div>
          <div class="res-item-meta">${meta} &nbsp;Seat ${r.seat}</div>
        </div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeReservation(${r.seat})">Remove</button>`;
    list.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════════
// MODAL & TOAST
// ═══════════════════════════════════════════════════════════════

function openModal(title, body, buttons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML    = body;

  const footer = document.getElementById('modal-footer');
  footer.innerHTML = '';
  buttons.forEach(b => {
    const btn     = document.createElement('button');
    btn.className = 'btn ' + b.cls;
    btn.textContent = b.label;
    btn.onclick   = b.fn;
    footer.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.add('hidden');
}

function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast' +
    (type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : '');
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════

function switchTab(id, btn) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');

  if (id === 'tab-bookings')     renderAdminBookings();
  if (id === 'tab-history')      renderHistory();
  if (id === 'tab-users')        renderUsersTable();
  if (id === 'tab-reservations') { populateResSeatSelect(); renderReservationsList(); }
  if (id === 'tab-settings')     loadSettingsForm();
}

// ═══════════════════════════════════════════════════════════════
// CYCLE RESET (called by mainLoop on state transition)
// ═══════════════════════════════════════════════════════════════

/**
 * Clears the frontend seat cache and resets all seat buttons to neutral.
 * Called AFTER POST /api/resetBookings has succeeded.
 * Does NOT call refreshBookings — the caller owns that.
 */
function resetSeatSelections() {
  cachedBookings = {};

  document.querySelectorAll('.seat-btn').forEach(btn => {
    btn.classList.remove(
      'seat-mine', 'seat-taken', 'seat-available', 'seat-disabled',
      'seat-reserved-permanent', 'seat-reserved-temporary'
    );
    btn.classList.add('seat-disabled');
    btn.disabled = true;
    btn.onclick  = null;
    const lbl = btn.querySelector('.seat-label');
    if (lbl) lbl.textContent = '—';
  });
}

// ═══════════════════════════════════════════════════════════════
// VERIFICATION PHASE
// ═══════════════════════════════════════════════════════════════

/**
 * Tracks the verification workflow state independently of getSystemState().
 * Values: 'BOOKING_OPEN' | 'VERIFYING' | 'GRACE_PERIOD' | 'RESULT_DISPLAYED'
 */
let systemStatus    = 'BOOKING_OPEN';
let graceTimerEnd   = null;   // Date when the 2-minute grace period expires
let graceInterval   = null;   // setInterval handle for the grace countdown display

/**
 * Calls POST /api/verifySeatAllocations, which runs duplicate-seat cleanup on
 * the server and returns the number of seats released.
 * Returns releasedCount (0 if no duplicates found).
 */
async function verifySeatAllocations() {
  try {
    const data = await apiRequest('/verifySeatAllocations', 'POST');
    return data.success ? (data.releasedCount || 0) : 0;
  } catch (err) {
    console.error('verifySeatAllocations error:', err);
    return 0;
  }
}

/** Hide every dashboard section at once (helper used by verification flow) */
function hideAllSections() {
  ['countdown-section', 'seat-section', 'results-section',
   'my-booking-card', 'verification-section', 'grace-section']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
}

/** Show the "Verifying…" loading screen */
function showVerificationScreen() {
  hideAllSections();
  const banner = document.getElementById('status-banner');
  const dot    = document.getElementById('banner-dot');
  const txt    = document.getElementById('banner-text');
  banner.className = 'status-banner banner-results';
  dot.className    = 'banner-dot dot-brand';
  txt.textContent  = '🔍 Verifying seat allocations — please wait…';
  document.getElementById('verification-section').classList.remove('hidden');
}

/** Show the grace-period seat selection screen */
function showGraceScreen() {
  hideAllSections();
  const banner = document.getElementById('status-banner');
  const dot    = document.getElementById('banner-dot');
  const txt    = document.getElementById('banner-text');
  banner.className = 'status-banner banner-open';
  dot.className    = 'banner-dot dot-green';
  txt.textContent  = '🟢 Freed seats available — select yours before the timer runs out!';

  // Only staff without a confirmed seat may pick during grace period
  const mine = Object.entries(cachedBookings)
    .find(([, v]) => !v._reserved && v.username === currentUser?.username);
  const sub = document.getElementById('grace-sub');
  if (mine) {
    if (sub) sub.textContent = 'Your seat ' + mine[0] + ' is confirmed. No action needed.';
  } else {
    if (sub) sub.textContent = 'Some seats have been freed. Select an available seat below.';
  }

  // Render the seat grid inside the grace section
  const grid = document.getElementById('grace-seat-grid');
  if (grid) {
    // Temporarily redirect seat-grid render into grace-seat-grid
    const realGrid = document.getElementById('seat-grid');
    const realGridParent = realGrid?.parentNode;
    const placeholder = document.createComment('seat-grid-placeholder');
    if (realGrid) {
      realGrid.id = 'seat-grid';
      realGridParent.replaceChild(placeholder, realGrid);
    }
    renderSeatGrid(cachedBookings, cachedSettings.totalSeats || 30,
      !mine  // interactive only if staff has no seat yet
    );
    // Move rendered grid into the grace section
    const rendered = document.getElementById('seat-grid');
    if (rendered) grid.innerHTML = rendered.innerHTML;
    // Restore original seat-grid
    if (realGrid && placeholder.parentNode) {
      placeholder.parentNode.replaceChild(realGrid, placeholder);
    }

    // Wire up click handlers on the grace grid buttons
    grid.querySelectorAll('.seat-available').forEach(btn => {
      const seatNum = parseInt(btn.querySelector('.seat-num')?.textContent, 10);
      if (!isNaN(seatNum)) {
        btn.onclick = async () => {
          if (mine) {
            showToast('You already have a seat confirmed.', 'error');
            return;
          }
          btn.disabled = true;
          await selectSeat(seatNum);
        };
      }
    });
  }

  document.getElementById('grace-section').classList.remove('hidden');
}

/** Update the grace period countdown display every second */
function tickGraceTimer() {
  const el = document.getElementById('grace-timer');
  if (!el || !graceTimerEnd) return;
  const remaining = Math.max(0, graceTimerEnd - Date.now());
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  el.textContent = m + ':' + String(s).padStart(2, '0');
}

/**
 * Full verification workflow — called once when booking closes.
 * Follows the state machine:
 *   BOOKING_OPEN → VERIFYING → (GRACE_PERIOD →) RESULT_DISPLAYED
 */
async function runVerificationFlow() {
  // ── Step 1: show verification loading screen for minimum 7 seconds ──
  systemStatus = 'VERIFYING';
  showVerificationScreen();

  const verifyStart = Date.now();

  // ── Step 2: call the server to clean up duplicate bookings ──────────
  const releasedCount = await verifySeatAllocations();

  // Ensure the loading screen is visible for at least 7 seconds so users
  // can see it rather than flashing through instantly
  const elapsed = Date.now() - verifyStart;
  const minDisplay = 7000;
  if (elapsed < minDisplay) {
    await new Promise(resolve => setTimeout(resolve, minDisplay - elapsed));
  }

  // Re-fetch fresh seat data after server-side cleanup
  await refreshBookings();

  if (releasedCount > 0) {
    // ── Step 3 & 4: seats were released — start 2-minute grace period ──
    systemStatus  = 'GRACE_PERIOD';
    graceTimerEnd = Date.now() + 2 * 60 * 1000;  // 2 minutes from now

    showGraceScreen();
    tickGraceTimer();  // set initial display immediately

    // Update grace timer display every second
    if (graceInterval) clearInterval(graceInterval);
    graceInterval = setInterval(tickGraceTimer, 1000);

    // ── Step 5: wait 2 minutes then verify again ────────────────────────
    await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));

    clearInterval(graceInterval);
    graceInterval = null;

    // Second verification pass after grace period
    systemStatus = 'VERIFYING';
    showVerificationScreen();
    await verifySeatAllocations();

    const postGraceDelay = 4000;  // brief display of verification screen
    await new Promise(resolve => setTimeout(resolve, postGraceDelay));

    await refreshBookings();
  }

  // ── Step 6: display final results ───────────────────────────────────
  systemStatus = 'RESULT_DISPLAYED';
  hideAllSections();

  const banner = document.getElementById('status-banner');
  const dot    = document.getElementById('banner-dot');
  const txt    = document.getElementById('banner-text');
  banner.className = 'status-banner banner-results';
  dot.className    = 'banner-dot dot-brand';
  txt.textContent  = "📋 Booking CLOSED — Today's seat assignments are shown below.";

  renderResultsTable(cachedBookings);
  document.getElementById('results-section').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════

let lastState       = null;
let isResettingCycle = false;

async function mainLoop() {
  const now = getServerAdjustedTime();
  const ts  = now.toLocaleTimeString('en-GB');

  const dc = document.getElementById('dash-clock');
  const ac = document.getElementById('admin-clock');
  if (dc) dc.textContent = ts;
  if (ac) ac.textContent = ts;

  const state = getSystemState();

  // ── Staff dashboard ─────────────────────────────────────────────────
  if (document.getElementById('page-dashboard').classList.contains('active') && currentUser) {

    if (state === 'before_open' || state === 'reset' || state === 'weekend') {
      const s = cachedSettings;
      const { h, m } = parseTimeStr(s.openTime || '16:50');
      const ms = state === 'before_open' ? msToNext(h, m) : msToNextWeekdayFriday(h, m);
      const el = document.getElementById('countdown-display');
      if (el) el.textContent = formatCountdown(ms);
    }

    // If runVerificationFlow is actively running, it owns the display.
    // Do not allow mainLoop to overwrite the verification or grace screens.
    if (systemStatus === 'VERIFYING' || systemStatus === 'GRACE_PERIOD') {
      return;
    }

    // Safety guard: results section still visible but state has moved on —
    // force-clear and refresh immediately (handles stuck isResettingCycle).
    const resultsVisible = !document.getElementById('results-section').classList.contains('hidden');
    if (resultsVisible && state !== 'results') {
      lastState    = state;
      isResettingCycle = false;
      systemStatus = 'BOOKING_OPEN';
      refreshDashboard();
      return;
    }

    if (state !== lastState) {
      const justStartedNewCycle =
        (state === 'before_open' || state === 'reset' || state === 'weekend') &&
        (lastState === 'results' || lastState === 'open' || lastState === 'reset');

      // Detect the exact moment booking window closes and results window begins.
      // Instead of showing results directly, enter the verification phase.
      const justEnteredResults =
        state === 'results' && (lastState === 'open' || lastState === null);

      // Commit lastState BEFORE async work so subsequent ticks skip this block
      lastState = state;

      if (justEnteredResults && systemStatus === 'BOOKING_OPEN') {
        // ── VERIFICATION PHASE: owned entirely by runVerificationFlow ──
        // It sets systemStatus = 'RESULT_DISPLAYED' when the flow completes.
        runVerificationFlow();
        return;
      }

      if (justStartedNewCycle && !isResettingCycle) {
        isResettingCycle = true;
        systemStatus     = 'BOOKING_OPEN';  // reset for next cycle

        (async () => {
          try {
            const result = await apiRequest('/resetBookings', 'POST');
            if (!result.success) {
              console.warn('resetBookings returned failure:', result.message);
            }
          } catch (err) {
            console.error('Cycle reset: backend call failed:', err);
          }

          resetSeatSelections();
          await refreshDashboard();
          isResettingCycle = false;
        })();

        return;
      }

      if (!isResettingCycle) refreshDashboard();

    } else if (state === 'open' && now.getSeconds() % 5 === 0) {
      // Ensure systemStatus is reset while booking is open so the verification
      // flow triggers cleanly when booking closes.
      if (systemStatus !== 'BOOKING_OPEN') systemStatus = 'BOOKING_OPEN';
      refreshDashboard();

    } else if (state === 'results' && now.getSeconds() % 5 === 0) {
      // Periodic safety refresh during results window (BUG 2 fix retained).
      refreshDashboard();
    }
  }

  // ── Admin dashboard ─────────────────────────────────────────────────
  if (document.getElementById('page-admin').classList.contains('active') && currentUser) {
    if (now.getSeconds() % 10 === 0) {
      refreshAdminStats();
      renderAdminBookings();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (document.getElementById('page-login').classList.contains('active'))           doLogin();
    if (document.getElementById('page-change-password').classList.contains('active')) doChangePassword();
  }
});

// ═══════════════════════════════════════════════════════════════
// SESSION RESTORE ON PAGE LOAD
// ═══════════════════════════════════════════════════════════════

async function restoreSession(user) {
  currentUser = user;
  // Ensure sessionVersion is always a number on the restored object
  if (!currentUser.sessionVersion) currentUser.sessionVersion = 1;
  if (currentUser.mustChangePw) {
    showPage('page-change-password');
    return;
  }
  await afterLogin();
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

setInterval(mainLoop, 1000);
// Re-sync server time offset every 30 s so device clock changes are corrected.
setInterval(syncServerTime, 30000);

// Perform an initial server time sync BEFORE the first mainLoop tick so that
// getSystemState() never uses a stale (device) clock on first render.
syncServerTime().then(() => mainLoop());

(function initSession() {
  try {
    const raw = localStorage.getItem('cobranet_user');
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved.name && saved.role) restoreSession(saved);
    }
  } catch {
    localStorage.removeItem('cobranet_user');
  }
}());
