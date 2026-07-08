// ============================================================
// MAILROOM PLATFORM \u2014 SUPABASE ADAPTER
// Drop-in replacement for the GAS api() and apiPost() functions.
// Returns the EXACT same response shapes so zero UI code changes needed.
//
// USAGE: Replace the <script> section in client.html and staff.html:
//   1. Add <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   2. Replace the old API_URL, api(), and apiPost() with this file
//   3. Everything else stays exactly the same
// ============================================================

const SUPABASE_URL  = 'https://catpufkbjmcjmtuisdok.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhdHB1Zmtiam1jam10dWlzZG9rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjIyNDgyNSwiZXhwIjoyMDg3ODAwODI1fQ.f2lEF3S063-qlwYwXW5aU5GbIPSNwzWtXw4ZtLk7cwg';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
// Service role client must never have a user session.
// Clear any accidentally-set session so RLS bypass is always active.
sb.auth.getSession().then(function(r){
  if (r.data && r.data.session) sb.auth.signOut({ scope: 'local' }).catch(function(){});
}).catch(function(){});

// ── Multi-tenant: resolve the acting company from the user (Option 1 / server-derived) ──
// Every tenant-scoped read/write derives company_id from the authenticated user's row,
// NOT from anything the browser sends. Cached per uuid to avoid repeat lookups.
const _companyIdCache = {};
async function _companyIdFor(uuid, isClient) {
  if (!uuid) return null;
  const ck = (isClient ? 'c:' : 's:') + uuid;
  if (_companyIdCache[ck] !== undefined) return _companyIdCache[ck];
  let companyId = null;
  try {
    if (isClient) {
      // client uuid may be clients.id OR auth_id — mirror the proven two-step resolution
      let { data } = await sb.from('clients').select('company_id').eq('id', uuid).maybeSingle();
      if (!data) {
        const r = await sb.from('clients').select('company_id').eq('auth_id', uuid).maybeSingle();
        data = r.data;
      }
      companyId = data ? data.company_id : null;
    } else {
      const { data } = await sb.from('staff').select('company_id')
        .eq('staff_id', uuid).maybeSingle();
      companyId = data ? data.company_id : null;
    }
  } catch(e) { companyId = null; }
  _companyIdCache[ck] = companyId;
  return companyId;
}

// NOTE: the former "oldest company" pre-login fallback helper was removed
// (tenant-isolation hardening). Company is always resolved from the user, the
// request, or the ?company= URL param; if genuinely unknown, callers fail loud
// (money/email/secrets) or return generic defaults / empty (lists) — never a
// guessed tenant.

// ── Default config fallback ────────────────────────────────────────────────
// default_configs holds super-admin defaults. A company's own config row wins;
// if absent, we fall back to the default. Secrets (Stripe/Resend) are NOT in
// default_configs, so they never fall back — each company must set their own.
let _defaultConfigsCache = undefined;
let _defaultConfigsCacheTime = 0;
async function _getDefaultConfigs() {
  // Cache for 60s per page session
  if (_defaultConfigsCache !== undefined && Date.now() - _defaultConfigsCacheTime < 60000) return _defaultConfigsCache;
  const map = {};
  try {
    const { data } = await sb.from('default_configs').select('key, value');
    (data || []).forEach(r => { map[r.key] = r.value; });
  } catch(e) { /* table may not exist in older envs — return empty */ }
  _defaultConfigsCache = map;
  _defaultConfigsCacheTime = Date.now();
  return map;
}

// Returns a {key: value} map for the requested keys, with company values on top
// of default_configs fallbacks. If `keys` is omitted, returns the union of the
// company's keys and all default keys.
async function _mergedConfig(companyId, keys) {
  const defaults = await _getDefaultConfigs();
  // TENANT ISOLATION: never read the config table unscoped. With no company in
  // hand, an unfiltered read would pull EVERY company's config rows and blend
  // them (last-row-wins) into a cross-tenant Frankenstein — including the wrong
  // Stripe/Resend keys. When company is unknown, serve shared non-secret
  // defaults only (default_configs); never another company's data.
  const own = {};
  if (companyId) {
    let q = sb.from('config').select('key, value').eq('company_id', companyId);
    if (Array.isArray(keys) && keys.length) q = q.in('key', keys);
    const { data } = await q;
    (data || []).forEach(r => { own[r.key] = r.value; });
  }

  const out = {};
  const keyList = Array.isArray(keys) && keys.length
    ? keys
    : Array.from(new Set([...Object.keys(defaults), ...Object.keys(own)]));
  for (const k of keyList) {
    // Company's own value wins when present AND non-empty; else fall back to default.
    if (own[k] !== undefined && own[k] !== '') out[k] = own[k];
    else if (defaults[k] !== undefined) out[k] = defaults[k];
    else if (own[k] !== undefined) out[k] = own[k]; // empty own value, no default
  }
  return out;
}

// Single-key convenience: company value → default → undefined.
async function _configValue(companyId, key) {
  const merged = await _mergedConfig(companyId, [key]);
  return merged[key];
}


// \u2500\u2500 Supabase Auth Session Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Portal-aware localStorage key helper
// Each portal sets window._appPortal = 'admin' | 'staff' | 'client'
function _sbKey(base) {
  const p = window._appPortal;
  if (p === 'admin') return 'sb_admin_' + base;
  if (p === 'staff') return 'sb_staff_' + base;
  return 'sb_' + base; // client default
}

// Get stored Auth session tokens from localStorage
function _getStoredSession() {
  return {
    accessToken:  localStorage.getItem(_sbKey('access_token')),
    refreshToken: localStorage.getItem(_sbKey('refresh_token'))
  };
}

// Clear stored Auth session
function _clearSession() {
  localStorage.removeItem(_sbKey('access_token'));
  localStorage.removeItem(_sbKey('refresh_token'));
}

// Sign out — clear session and redirect to login
async function _signOut(loginPage) {
  try {
    const { accessToken } = _getStoredSession();
    if (accessToken) {
      await fetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + accessToken
        }
      });
    }
  } catch(e) {}
  _clearSession();
  // Clear sessionStorage auth cache so next login gets fresh data
  try { sessionStorage.removeItem('auth_' + (window.STATE?.uuid || '')); } catch(e) {}
  try { sessionStorage.removeItem('staff_session_start'); } catch(e) {}
  try { sessionStorage.removeItem('admin_session_start'); } catch(e) {}
  localStorage.removeItem(_sbKey('staff_id'));
  window.location.href = loginPage || 'login-client.html';
}

// Resolve identity from Auth session \u2014 returns { authId, email, role, record }
// role: 'client' | 'staff' | 'admin' | null
async function _resolveAuthSession() {
  const { accessToken } = _getStoredSession();
  if (!accessToken) return null;

  try {
    // Verify token with Supabase Auth
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + accessToken
      }
    });
    if (!res.ok) { _clearSession(); return null; }
    const user = await res.json();
    if (!user?.id) { _clearSession(); return null; }

    const authId = user.id;

    // Check staff first
    const { data: staff } = await sb.from('staff')
      .select('*').eq('auth_id', authId).eq('active', true).maybeSingle();
    if (staff) {
      return { authId, type: 'staff', role: staff.role, record: staff };
    }

    // Check client \u2014 try auth_id first, then email fallback
    let client = null;
    const { data: clientByAuth } = await sb.from('clients')
      .select('id, email, company_id').eq('auth_id', authId).maybeSingle();
    client = clientByAuth;

    if (!client) {
      // Fallback: look up by email from the Auth user record
      const userEmail = user.email;
      if (userEmail) {
        const { data: clientByEmail } = await sb.from('clients')
          .select('id, email, company_id').eq('email', userEmail).maybeSingle();
        if (clientByEmail) {
          // Link auth_id to this client for future logins
          await sb.from('clients').update({ auth_id: authId }).eq('id', clientByEmail.id);
          client = clientByEmail;
        }
      }
    }

    if (client) {
      return { authId, type: 'client', role: 'client', record: client };
    }

    return null;
  } catch(e) {
    return null;
  }
}

// \u2500\u2500 Mail Status Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Letters: pending_assignment \u2192 ready_for_pickup / confidential_pickup / forwarding_queued
//          \u2192 picked_up / forwarded / shredded / returned_to_sender / discarded
// Parcels: pending_assignment \u2192 ready_for_pickup \u2192 picked_up / returned_to_sender / discarded
const MAIL_STATUS = {
  pending_assignment:   { label: 'Pending Assignment',     icon: '\u23F3', cls: 'warning' },
  ready_for_pickup:     { label: 'Ready for Pickup',       icon: '\uD83D\uDCEC', cls: 'scanned' },
  confidential_pickup:  { label: 'Confidential Pickup',    icon: '\uD83D\uDD12', cls: 'payment_req' },
  forwarding_queued:    { label: 'Queued for Forwarding',  icon: '\uD83D\uDCE6', cls: 'stored' },
  forwarded:            { label: 'Forwarded',              icon: '\u2708\uFE0F', cls: 'scanned' },
  picked_up:            { label: 'Picked Up',              icon: '\u2705', cls: 'scanned' },
  shredded:             { label: 'Shredded',               icon: '\uD83D\uDDD1\uFE0F', cls: 'expired' },
  returned_to_sender:   { label: 'Returned to Sender',     icon: '\u21A9\uFE0F', cls: 'expired' },
  discarded:            { label: 'Discarded',              icon: '\u2715',  cls: 'expired' },
};

// \u2500\u2500 ID Generator (matches existing format) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Timezone-safe date addition: "2026-03-04" + 7 \u2192 "2026-03-11"
function _addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().split('T')[0];
}

// Today's date as 'YYYY-MM-DD' in a given zone (defaults to the company zone).
// Pass a record's location zone for place-bound dates (e.g. mail intake).
function _localToday(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz || COMPANY_DEFAULT_TZ || 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ── Timezone foundation (F1) ──────────────────────────────────────────────
// Storage stays UTC; timezone is applied only at display/comparison time.
// Company-level fallback zone. Seeded to Toronto; hydrated from the company
// `default_timezone` config row (F2) once it exists.
let COMPANY_DEFAULT_TZ = 'America/Toronto';

// Cache: location_id → IANA timezone. Filled from loaded locations (Edit 2/3)
// and by the self-healing background fill in locTz() on a miss.
const LOC_TZ_MAP = {};
let _locTzFillInFlight = false;

// One-time, company-wide fill so locTz() is reliable even if a future SELECT
// forgets the timezone column. Fire-and-forget; keeps locTz() synchronous.
async function _fillLocTzMap() {
  if (_locTzFillInFlight) return;
  _locTzFillInFlight = true;
  try {
    // Intentionally global (no company scope): LOC_TZ_MAP is a non-user-facing
    // location_id -> IANA timezone lookup that backs locTz() across all request
    // contexts, some of which have no single company in scope. It exposes only
    // an opaque location_id and its timezone string, never tenant data, and is
    // never returned to a portal. Scoping here would break the self-healing fill.
    const { data } = await sb.from('locations').select('location_id, timezone');
    (data || []).forEach(l => { if (l && l.location_id) LOC_TZ_MAP[l.location_id] = l.timezone || null; });
  } catch (e) { /* non-fatal: locTz falls back to company default */ }
}

// noon-guard: stops a date-only YYYY-MM-DD string from rolling back a day
// when parsed and re-rendered in a behind-UTC zone.
function _safeDate(str) {
  if (!str) return null;
  return new Date(String(str).includes('T') ? str : str + 'T12:00:00');
}

// location_id → IANA zone. Falls back to company default when the location's
// timezone is null/blank/unknown (case D). On a cache miss, returns the
// fallback now AND triggers a one-time background fill so the next render is
// correct — keeps this function synchronous for inline display use (case C:
// IANA only, DST handled automatically).
function locTz(locationId) {
  if (locationId && LOC_TZ_MAP[locationId]) return LOC_TZ_MAP[locationId];
  if (locationId && !(locationId in LOC_TZ_MAP)) { _fillLocTzMap(); }
  return COMPANY_DEFAULT_TZ || 'America/Toronto';
}

// IANA zone → short colloquial tag for labels. North American zones use the
// year-round colloquial tag (ET/CT/MT/PT…), NOT EST/EDT (§0d). Anything else
// degrades to a live GMT± offset derived from the zone (never a raw IANA id).
function tzLabel(tz) {
  const NA = {
    'America/Toronto': 'ET', 'America/New_York': 'ET', 'America/Detroit': 'ET',
    'America/Montreal': 'ET', 'America/Nipigon': 'ET',
    'America/Chicago': 'CT', 'America/Winnipeg': 'CT',
    'America/Denver': 'MT', 'America/Edmonton': 'MT',
    'America/Phoenix': 'MST', 'America/Regina': 'CST',
    'America/Los_Angeles': 'PT', 'America/Vancouver': 'PT',
    'America/Halifax': 'AT', 'America/Moncton': 'AT',
    'America/St_Johns': 'NT',
    'America/Anchorage': 'AKT',
    'Pacific/Honolulu': 'HT', 'America/Adak': 'HAT'
  };
  if (!tz) return '';
  if (NA[tz]) return NA[tz];
  // Non-NA fallback: compute current GMT± offset for the zone.
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date());
    const off = parts.find(p => p.type === 'timeZoneName');
    if (off && off.value) return off.value.replace(/^UTC/, 'GMT');
  } catch (e) { /* invalid zone → fall through */ }
  return 'GMT';
}

// Canonical display helpers. tz defaults to the company fallback; pass
// locTz(record.locationId) for place dates. Format is locked (§1b):
//   date      → "Jun 17, 2026"
//   datetime  → "Jun 17, 2026 · 3:42 p.m."
function fmtDate(d, tz) {
  if (!d) return '\u2014';
  const z = tz || COMPANY_DEFAULT_TZ || 'America/Toronto';
  return _safeDate(d).toLocaleDateString('en-CA',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: z });
}
function fmtDateTime(d, tz) {
  if (!d) return '\u2014';
  const z = tz || COMPANY_DEFAULT_TZ || 'America/Toronto';
  const dt = _safeDate(d);
  const datePart = dt.toLocaleDateString('en-CA',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: z });
  const timePart = dt.toLocaleTimeString('en-CA',
    { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: z });
  return datePart + ' \u00B7 ' + timePart;
}

// ── T9 zone-aware comparison helpers ──────────────────────────────────────
// A date-only column compared against a UTC timestamptz must be turned into a
// zone-anchored instant, or Postgres reads the bare 'YYYY-MM-DD' as UTC midnight
// and the window drifts hours off the location's real calendar (wrong billing
// period → wrong overage). Generalizes the correct todayStart/End pattern.

// Live DST-aware offset string (e.g. '-07:00') for a zone right now.
function _zoneOffset(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Toronto', timeZoneName: 'longOffset' })
      .formatToParts(new Date());
    const v = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT-05:00';
    const m = v.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : '-05:00';
  } catch (e) { return '-05:00'; }
}

// 'YYYY-MM-DD' (date-only) → zone-anchored start/end instants for DB comparison
// against a UTC timestamptz column. Returns ISO-ish strings Postgres accepts.
function _zoneDayBounds(dateStr, tz) {
  const off = _zoneOffset(tz);
  return { start: dateStr + 'T00:00:00' + off, end: dateStr + 'T23:59:59.999' + off };
}

// Today's calendar date 'YYYY-MM-DD' in a zone (defaults company zone).
function _todayIn(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz || COMPANY_DEFAULT_TZ || 'America/Toronto' });
}
// ──────────────────────────────────────────────────────────────────────────

// Calculate current billing period from anchor date + interval
function _getCurrentPeriod(anchorDateStr, interval, intervalCount) {
  const [aY, aM, aD] = anchorDateStr.split('-').map(Number);
  const today = _localToday();
  
  let y = aY, m = aM;
  
  for (let i = 0; i < 240; i++) { // max 20 years
    // Clamp anchor day to valid day in this month
    const maxDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(aD, maxDay);
    const periodStart = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    
    // Next period start
    let ny = y, nm = m;
    if (interval === 'year') { ny += intervalCount; }
    else { nm += intervalCount; if (nm > 12) { ny += Math.floor((nm - 1) / 12); nm = ((nm - 1) % 12) + 1; } }
    const nMaxDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const nd = Math.min(aD, nMaxDay);
    const nextStart = `${ny}-${String(nm).padStart(2,'0')}-${String(nd).padStart(2,'0')}`;
    
    // Period end = day before next period start
    const periodEnd = _addDays(nextStart, -1);
    
    // If today is within this period, return it
    if (today >= periodStart && today <= periodEnd) {
      return { periodStart, periodEnd };
    }
    
    // Advance
    y = ny; m = nm;
  }
  // Fallback
  return { periodStart: anchorDateStr, periodEnd: _addDays(anchorDateStr, 29) };
}

// Auto-refresh plan card period if stale. Returns updated period dates.
async function _ensureCurrentPeriod(pc) {
  const today = _localToday();
  
  // Fast path: if stored period contains today, no recalculation needed
  if (pc.current_period_start && pc.current_period_end && today >= pc.current_period_start && today <= pc.current_period_end) {
    return { periodStart: pc.current_period_start, periodEnd: pc.current_period_end };
  }
  
  if (!pc.subscription_id) return { periodStart: pc.current_period_start, periodEnd: pc.current_period_end };
  
  const { data: sub } = await sb.from('subscriptions')
    .select('created_at, interval, interval_count, current_period_start, current_period_end')
    .eq('id', pc.subscription_id).maybeSingle();
  if (!sub) return { periodStart: pc.current_period_start, periodEnd: pc.current_period_end };

  // Prefer Stripe's actual period dates if available
  let periodStart, periodEnd;
  if (sub.current_period_start && sub.current_period_end) {
    periodStart = sub.current_period_start;
    periodEnd   = sub.current_period_end;
  } else if (sub.created_at) {
    // Fallback: calculate from anchor
    const anchorDate = sub.created_at.split('T')[0];
    ({ periodStart, periodEnd } = _getCurrentPeriod(anchorDate, sub.interval || 'month', sub.interval_count || 1));
  } else {
    return { periodStart: pc.current_period_start, periodEnd: pc.current_period_end };
  }

  // Update plan_card if period has changed
  if (periodStart !== pc.current_period_start || periodEnd !== pc.current_period_end) {
    await sb.from('plan_cards').update({
      current_period_start: periodStart,
      current_period_end: periodEnd
    }).eq('plan_card_id', pc.plan_card_id);
  }
  
  return { periodStart, periodEnd };
}

// Live usage count from mail_log within billing period
async function _getLiveUsage(planCardId, periodStart, periodEnd) {
  if (!planCardId || !periodStart || !periodEnd) return { mailsUsed: 0, parcelsUsed: 0 };
  // Anchor the period window to the COMPANY zone (§0d case R) so a piece logged
  // near a period edge in a behind-UTC location counts in the correct period.
  // Bare date-only bounds would be read as UTC midnight → wrong overage → wrong charge.
  const _b = _zoneDayBounds(periodStart, COMPANY_DEFAULT_TZ);
  const _e = _zoneDayBounds(periodEnd, COMPANY_DEFAULT_TZ);
  const winStart = _b.start;
  const winEnd   = _e.end;

  const { count: mc } = await sb.from('mail_log')
    .select('*', { count: 'exact', head: true })
    .eq('plan_card_id', planCardId)
    .eq('type', 'letter')
    .eq('special_case', false)
    .neq('status', 'deleted')
    .gte('logged_at', winStart)
    .lte('logged_at', winEnd);
  
  const { count: pc } = await sb.from('mail_log')
    .select('*', { count: 'exact', head: true })
    .eq('plan_card_id', planCardId)
    .eq('type', 'parcel')
    .eq('special_case', false)
    .neq('status', 'deleted')
    .gte('logged_at', winStart)
    .lte('logged_at', winEnd);
  
  return { mailsUsed: mc || 0, parcelsUsed: pc || 0 };
}

function _genId(prefix) {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = prefix;
  for (let i = 0; i < 12; i++) id += c[Math.floor(Math.random() * c.length)];
  return id;
}

// \u2500\u2500 camelCase \u2194 snake_case helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function toSnake(s) { return s.replace(/([A-Z])/g, '_$1').toLowerCase(); }
function toCamel(s) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function rowToCamel(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out;
}
function rowsToCamel(rows) { return (rows || []).map(rowToCamel); }

// ============================================================
// REPLACEMENT: api(path) \u2014 handles GET-style calls
// Parses the query string and routes to the right handler
// ============================================================
// ============================================================
// AUDIT LOG
// ============================================================
async function _audit(entry) {
  try {
    // Resolve staff name if not provided
    if (entry.staffId && !entry.staffName) {
      const { data: s } = await sb.from('staff').select('name').eq('staff_id', entry.staffId).maybeSingle();
      if (s) entry.staffName = s.name;
    }
    // Resolve client name if not provided
    if (entry.clientId && !entry.clientName) {
      const { data: c } = await sb.from('clients').select('given_name, family_name, email').eq('id', entry.clientId).maybeSingle();
      if (c) entry.clientName = [c.given_name, c.family_name].filter(Boolean).join(' ') || c.email || null;
    }
    // Resolve company_id from whatever context we have (staff, client, or plan card)
    let _auditCompanyId = entry.companyId || null;
    if (!_auditCompanyId && entry.staffId) {
      const { data: cs } = await sb.from('staff').select('company_id').eq('staff_id', entry.staffId).maybeSingle();
      _auditCompanyId = cs ? cs.company_id : null;
    }
    if (!_auditCompanyId && entry.clientId) {
      const { data: cc } = await sb.from('clients').select('company_id').eq('id', entry.clientId).maybeSingle();
      _auditCompanyId = cc ? cc.company_id : null;
    }
    if (!_auditCompanyId && entry.planCardId) {
      const { data: cp } = await sb.from('plan_cards').select('company_id').eq('plan_card_id', entry.planCardId).maybeSingle();
      _auditCompanyId = cp ? cp.company_id : null;
    }
    await sb.from('audit_log').insert({
      company_id: _auditCompanyId,
      staff_id: entry.staffId || null,
      staff_name: entry.staffName || null,
      action: entry.action,
      entity_type: entry.entityType || null,
      entity_id: entry.entityId || null,
      client_id: entry.clientId || null,
      client_name: entry.clientName || null,
      plan_card_id: entry.planCardId || null,
      location_id: entry.locationId || null,
      summary: entry.summary || null,
      details: entry.details || null,
      mail_id: entry.mailId || null,
      recipient_name: entry.recipientName || null
    });
  } catch(e) { /* audit log failure is non-critical */ }
}

// ============================================================
// PIN VERIFICATION
// ============================================================
// ============================================================
// BRANDING CONFIG
// ============================================================
async function getBranding(uuid, isClient) {
  const keys = ['branding_logo_url', 'branding_logo_enabled', 'branding_company_name', 'stripe_publishable_key', 'stripe_test_publishable_key', 'stripe_mode', 'email_accent_color', 'app_client_url'];
  // Resolve company: from the user when known (post-login). Pre-login, take it
  // from the ?company= URL param if present (pages that are company-scoped pass
  // it). TENANT ISOLATION: no fallback company — if neither yields a company,
  // _mergedConfig serves generic non-secret defaults (never another tenant's
  // branding/keys). companyId stays null and callers re-resolve once identity
  // is known.
  let companyId = uuid ? await _companyIdFor(uuid, !!isClient) : null;
  if (!companyId) {
    try {
      const _urlCo = new URLSearchParams(window.location.search).get('company');
      if (_urlCo) {
        // ?company= may be an id or a slug — resolve to a real company id.
        const { data: _byId } = await sb.from('companies').select('id').eq('id', _urlCo).maybeSingle();
        if (_byId) companyId = _byId.id;
        else {
          const { data: _bySlug } = await sb.from('companies').select('id').eq('slug', _urlCo).maybeSingle();
          if (_bySlug) companyId = _bySlug.id;
        }
      }
      // Returning-session fallback: a company id this browser already resolved in
      // a prior session (client portal stores it). This is a real, previously-
      // confirmed company for THIS user — not a cross-tenant guess.
      if (!companyId) {
        try {
          const _storedCo = localStorage.getItem('app_company_id');
          if (_storedCo) {
            const { data: _byStored } = await sb.from('companies').select('id').eq('id', _storedCo).maybeSingle();
            if (_byStored) companyId = _byStored.id;
          }
        } catch(e) { /* no localStorage — skip */ }
      }
    } catch(e) { /* no URL context — fall through to generic defaults */ }
  }
  const cfg = await _mergedConfig(companyId, keys);
  return {
    logoUrl: cfg.branding_logo_url || '',
    stripePublishableKey: (cfg.stripe_mode === 'test'
      ? (cfg.stripe_test_publishable_key || null)
      : (cfg.stripe_publishable_key || null)),
    logoEnabled: cfg.branding_logo_enabled !== '0',
    companyName: cfg.branding_company_name || 'Your Company',
    accentColor: cfg.email_accent_color || '',
    clientUrl: cfg.app_client_url || '',
    companyId: companyId || null
  };
}

async function getStaffByUuid(uuid) {
  const { data, error } = await sb.from('staff').select('staff_id, name, role, active, session_timeout_minutes, can_extend_storage, can_verify_id, can_terminate, can_create_charge, can_reset_password')
    .eq('staff_id', uuid).maybeSingle();
  if (error || !data) return null;
  return data;
}


function _handleAuthExpiry() {
  try {
    localStorage.removeItem(_sbKey('access_token'));
    localStorage.removeItem(_sbKey('refresh_token'));
    localStorage.removeItem(_sbKey('staff_id'));
    sessionStorage.clear();
  } catch(e) {}
  if (typeof window !== 'undefined' && window.location &&
      !window.location.href.includes('login-')) {
    window.location.href = 'login-staff.html?error=session';
  }
}

async function api(path) {
  const _t0 = performance.now();
  const params = new URLSearchParams(path);
  const uuid   = params.get('uuid');
  const action = params.get('action');

  if (!action) {
    const r = await _resolveAccess(uuid);
    return r;
  }

  const result = await (async () => {
  switch (action) {
    case 'getTasks':            return _getTasks(uuid);
    case 'getAllTasks':          return _getAllTasks(uuid);
    case 'searchRecipients':    return _searchRecipients(uuid, params.get('q') || '');
    case 'getMailLogStaff':     return _getMailLogStaff(uuid);
    case 'getLogSuggestions':   return _getLogSuggestions(uuid);
    case 'runPaymentCheck':     return _runPaymentNotificationCheck(uuid);
    case 'getAgentsForPlanCard':return _getAgentsForPlanCard(uuid, params.get('planCardId'));
    case 'getExceptions':       return _getExceptions(uuid);
    case 'getPendingSetups':    return _getPendingSetups(uuid);
    case 'getStaffBroadcasts':  return _getStaffBroadcasts(uuid);
    case 'getPlanCardsStaff':   return _getPlanCardsStaff(uuid, params.get('locationId'));
    case 'getPendingSetupClients': return _getPendingSetupClients(uuid);
    case 'getForwardingBatches': return _getForwardingBatches({ uuid, limit: params.get('limit'), clientId: params.get('clientId') });
    case 'getOverageSummary':   return _getOverageSummary(uuid);
    default:
      return { status: 'error', message: 'Unknown action: ' + action };
  }
  })();
  // Auth guard \u2014 if session invalidated, redirect to login
  if (result && (result.message === 'JWT expired' || result.message === 'invalid JWT' ||
      result.message === 'Invalid JWT' || result.message === 'not authenticated' ||
      result.error === 'invalid_jwt' || result.code === 'PGRST301')) {
    _handleAuthExpiry();
    return result;
  }
  return result;
}

// ============================================================
// REPLACEMENT: apiPost(body) \u2014 handles write calls + complex reads
// ============================================================
async function apiPost(body) {
  return _adapterApiPostImpl(body);
}
async function _adapterApiPostImpl(body) {
  const _t0 = performance.now();
  const action = body.action;
  const uuid   = body.uuid;

  const result = await (async () => {
  switch (action) {
    // \u2500\u2500 Client reads \u2500\u2500
    case 'getMailLog':       return _getClientMailLog(uuid, body.subscriptionId);
    case 'getBroadcasts':    return _getActiveBroadcasts(uuid, body.locationId, body.planNames || body.planName);
    case 'dismissBroadcast': return _dismissBroadcast(body);
    case 'getIdVerification': return _getIdVerification(body.clientId || body.uuid, body.clientId ? body.uuid : null);
    case 'submitIdVerification': return _submitIdVerification(body);
    case 'reviewIdVerification': return _reviewIdVerification(body);
    case 'getPendingVerifications': return _getPendingVerifications(uuid);
    case 'getPlanCard':      return _getPlanCard(uuid, body.subscriptionId);
    case 'getBillingHistory': return _getBillingHistory(uuid, body.subscriptionId);
    case 'getAgents':        return _getAgents(uuid, body.subscriptionId);
    case 'getRecipients':    return _getRecipients(uuid, body.subscriptionId);
    case 'getPlanTemplate':  return _getPlanTemplate(body.productId);

    // \u2500\u2500 Client writes \u2500\u2500
    case 'submitOnboarding': return _submitOnboarding(body);
    case 'addRecipient':     return _addRecipient(body);
    case 'updateFriendlyName': return _updateFriendlyName(body);
    case 'addAgent':         return _addAgent(body);
    case 'removeAgent':      return _removeAgent(body);
    case 'updateForwardingAddress': return _updateForwardingAddress(body);
    case 'updatePhone': return _updatePhone(body);
    case 'updateBusinessDescription': return _updateBusinessDescription(body);
    case 'requestCancellation': return _requestCancellation(body);
    case 'withdrawCancellation': return _withdrawCancellation(body);
    case 'resolveCancellation': return _resolveCancellation(body);
    case 'terminateAccount':    return _terminateAccount(body);
    case 'reactivateAccount':   return _reactivateAccount(body);
    case 'reverseCancellation': return _reverseCancellation(body);

    // \u2500\u2500 Staff writes \u2500\u2500
    case 'logMail':               return _logMail(body);
    case 'uploadScanImage':       return _uploadScanImage(body);
    case 'clearExpiredScans':     return _clearExpiredScans(body);
    case 'resolveTask':           return _resolveTask(body);
    case 'snoozeTask':            return _snoozeTask(body);
    case 'unsnoozeTask':          return _unsnoozeTask(body);
    case 'stopRecurring':         return _stopRecurring(body);
    case 'deleteTask':            return _deleteTask(body);
    case 'createTask':            return _createTask(body);
    case 'updateTask':            return _updateTask(body);
    case 'claimTask':             return _claimTask(body);
    case 'getTaskComments':       return _getTaskComments(body);
    case 'addTaskComment':        return _addTaskComment(body);
    case 'releaseMail':           return _releaseMail(body);
    case 'bulkForwardMail':       return _bulkForwardMail(body);
    case 'assignMailRecipient':   return _assignMailRecipient(body);
    case 'editMailItem':          return _editMailItem(body);
    case 'markScanViewed':        return _markScanViewed(body);
    case 'sendTestEmail':          return _sendTestEmail(body);
    case 'deleteMailItem':        return _deleteMailItem(body);
    case 'updateMailStatus':      return _updateMailStatus(body);
    case 'saveForwardingBatch':   return _saveForwardingBatch(body);
    case 'recalculateOverage':    return _recalculateOverage(body);
    case 'markOverageBilled':    return _markOverageBilled(body);
    case 'addTempRecipient':      return _addTempRecipient(body);
    case 'updateRecipient':       return _updateRecipient(body);
    case 'updateRecipientStatus': return _updateRecipientStatus(body);
    case 'togglePlanLock':        return _togglePlanLock(body);
    case 'toggleAccountLock':     return _toggleAccountLock(body);
    case 'getClientAgents':       return _getClientAgents(body);
    case 'getClientMailItems':    return _getClientMailItems(body);
    case 'notifyNonPayment':      return { status: 'ok' }; // No-op: payment notifications handled by daily cron

    // Staff reads via POST
    case 'getDashboardStats':         return _getDashboardStats(uuid);

    // Reports
    case 'submitReport':              return _submitReport(body);
    case 'getReports':                return _getReports(body);
    case 'getReportComments':         return _getReportComments(body);
    case 'addReportComment':          return _addReportComment(body);
    case 'updateReportStatus':        return _updateReportStatus(body);
    case 'acknowledgeReport':         return _acknowledgeReport(body);
    case 'getSystemFeedbackEnabled':  return _getSystemFeedbackEnabled(body);
    case 'setSystemFeedbackEnabled':  return _setSystemFeedbackEnabled(body);

    // Super-admin (platform) — all gated behind platform-admin token verification
    case 'superListCompanies':        return _superListCompanies(body);
    case 'superCreateCompany':        return _superCreateCompany(body);
    case 'superUpdateCompany':        return _superUpdateCompany(body);
    case 'superGetPlatformConfig':    return _superGetPlatformConfig(body);
    case 'superSetPlatformConfig':    return _superSetPlatformConfig(body);
    case 'deleteReport':              return _deleteReport(body);

    // Notifications
    case 'getNotifications':      return _getNotifications(body);
    case 'getUnreadCount':        return _getUnreadCount(body);
    case 'markNotificationRead':  return _markNotificationRead(body);
    case 'deleteReadNotifications': return _deleteReadNotifications(body);
    case 'cleanupNotifications':  await _cleanupOldNotifications(); return { status: 'ok' };
    case 'getPlanCardsStaff':     return _getPlanCardsStaff(uuid, body.locationId);
    case 'getPendingSetupClients': return _getPendingSetupClients(uuid);
    case 'createStaffAccount':    return _createStaffAccount(body);
    case 'deleteStaffAccount':    return _deleteStaffAccount(body);
    case 'toggleStaffAuth':       return _toggleStaffAuth(body);
    case 'resetStaffPassword':    return _resetStaffPassword(body);
    case 'resetClientPassword':   return _resetClientPassword(body);
    case 'forceSignOut':          return _forceSignOut(body);
    case 'changePassword':        return _changePassword(body);
    case 'forceChangePassword':   return _forceChangePassword(body);
    case 'changeEmail':           return _changeEmail(body);
    case 'getMyDocuments':        return _getMyDocuments(body);
    case 'getDocumentDeclarations': return _getDocumentDeclarations(body);
    case 'saveDeclaration':       return _saveDeclaration(body);
    case 'deleteDeclaration':     return _deleteDeclaration(body);
    case 'toggleDeclaration':     return _toggleDeclaration(body);
    case 'reorderDeclarations':   return _reorderDeclarations(body);
    case 'getLocationsForDecl':   return _getLocationsForDecl(body);

    // ── One-time charge (Create Charge) ──────────────────────────────────
    case 'createCharge':          return _createCharge(body);

    // ── Account credit (Add / Remove credit) ─────────────────────────────
    case 'adjustCredit':          return _adjustCredit(body);

    // ── Admin billing (company-wide roll-up + per-client drill-in) ───────
    case 'getAdminBilling':       return _getAdminBilling(body);

    default:
      return { status: 'error', message: 'Unknown action: ' + action };
  }
  })();
  // Auth guard \u2014 if session invalidated, redirect to login
  if (result && (result.message === 'JWT expired' || result.message === 'invalid JWT' ||
      result.message === 'Invalid JWT' || result.message === 'not authenticated' ||
      result.error === 'invalid_jwt' || result.code === 'PGRST301')) {
    _handleAuthExpiry();
    return result;
  }
  return result;
}

// ============================================================
// RESOLVE ACCESS (boot call)
// Must return the exact shape the frontend expects
// ============================================================
async function _resolveAccess(uuid) {
  if (!uuid) return { status: 'error', message: 'No UUID provided' };

  // Check staff first \u2014 by staff_id (legacy UUID) OR by auth_id
  const staffQuery = uuid.includes('-') && uuid.length > 10
    ? sb.from('staff').select('*').eq('auth_id', uuid).eq('active', true).maybeSingle()
    : sb.from('staff').select('*').eq('staff_id', uuid).eq('active', true).maybeSingle();
  const { data: staff } = await staffQuery;
  if (staff) {
    // Location shutdown soft-block: a non-admin staff whose default location has
    // been shut down is blocked from the portal. Admins always pass through so
    // they can manage/reverse the shutdown. (Reversible — admin sets shutdown=false.)
    if (staff.role !== 'admin' && staff.default_location_id) {
      const { data: loc } = await sb.from('locations')
        .select('shutdown').eq('location_id', staff.default_location_id).maybeSingle();
      if (loc && loc.shutdown === true) {
        return {
          status:  'location_shutdown',
          message: 'This location has been shut down. Please contact your administrator.'
        };
      }
    }
    return {
      status:           'staff',
      role:             staff.role,
      name:             staff.name,
      email:            staff.email,
      staffId:          staff.staff_id,
      companyId:        staff.company_id,
      locationId:       staff.default_location_id,
      canExtendStorage:  staff.can_extend_storage !== false,
      canVerifyId:       staff.can_verify_id !== false,
      canTerminate:      staff.can_terminate === true,
      canCreateCharge:   staff.can_create_charge === true,
      canResetPassword:  staff.can_reset_password === true,
      forceLogoutAt:     staff.force_logout_at || null
    };
  }

  // Check client \u2014 try by id first, then by auth_id as fallback
  let { data: client } = await sb.from('clients').select('*').eq('id', uuid).maybeSingle();
  if (!client && uuid.includes('-') && uuid.length === 36) {
    // Try by auth_id for new Auth-based clients
    const { data: clientByAuth } = await sb.from('clients').select('*').eq('auth_id', uuid).maybeSingle();
    client = clientByAuth;
  }
  if (!client) {
    return { status: 'blocked', message: 'Account not found.' };
  }

  // Account-level lock
  if (client.access_override === 'suspended') {
    const overrideReason = client.override_reason || '';
    const isTerminated = overrideReason.toLowerCase().includes('terminat') ||
      overrideReason.toLowerCase().includes('fraud') ||
      overrideReason.toLowerCase().includes('non-payment') ||
      overrideReason.toLowerCase().includes('tos') ||
      overrideReason.toLowerCase().includes('violation');
    const message = isTerminated
      ? 'Your account has been terminated. If you believe this is an error, please contact our office.'
      : 'Your account has been temporarily suspended. Please contact our office for assistance.';
    return {
      status: 'blocked',
      message,
      reason: overrideReason || null
    };
  }

  // Get all subscriptions \u2014 always use client.id not auth_id
  const clientId = client.id;
  const { data: subs } = await sb.from('subscriptions').select('*')
    .eq('client_id', clientId).order('created_at', { ascending: false });

  // Get all plan cards for this client
  const { data: planCards } = await sb.from('plan_cards').select('*')
    .eq('client_id', clientId);

  const planCardMap = {};
  (planCards || []).forEach(pc => { planCardMap[pc.subscription_id] = pc; });

  // Location shutdown gate (client side): flag each plan whose location has been
  // shut down. Resolve location from the plan card first (plan_cards.location_id
  // is NOT NULL and reliable); fall back to subscriptions.location_id. We do NOT
  // block the client's whole login -- only the affected plan(s) are gated in the
  // portal (Slice 3). Additive only.
  const _shutdownByLoc = {};
  const _locIds = [...new Set([
    ...(planCards || []).map(pc => pc.location_id),
    ...(subs || []).map(s => s.location_id)
  ].filter(Boolean))];
  if (_locIds.length) {
    const { data: _locRows } = await sb.from('locations')
      .select('location_id, shutdown').in('location_id', _locIds);
    (_locRows || []).forEach(lr => { _shutdownByLoc[lr.location_id] = lr.shutdown === true; });
  }

  // Payment is handled via Stripe billing portal
  const paymentUrl = '__BILLING_PORTAL__';

  // Build subscription objects matching GAS response shape
  const subscriptions = (subs || []).map(s => {
    const pc = planCardMap[s.id];
    const accessStatus = s.access_status || 'ACTIVE';
    const planSuspended = pc && pc.access_override === 'suspended';
    const canAccess = !planSuspended && ['ACTIVE', 'CANCELED_WITH_ACCESS'].includes(accessStatus);
    
    // Setup is required if: no plan card, OR plan card exists but no recipients added yet
    const needsPlanCard = !pc;
    const needsRecipients = pc && (pc.recipients_added === 0 || pc.recipients_added === null);
    const setupRequired = canAccess && (needsPlanCard || needsRecipients);
    
    // Determine which setup step they're on
    let setupStep = null;
    if (setupRequired) {
      setupStep = needsPlanCard ? 'plan_setup' : 'add_recipients';
    }

    // Determine banner
    let banner = null;
    if (planSuspended) {
      banner = { type: 'suspended', title: 'Plan Suspended',
        message: 'Your plan has been temporarily suspended. Please contact our office for assistance.' };
    } else if (accessStatus === 'PAYMENT_REQUIRED') {
      banner = { type: 'payment_required', title: 'Payment Needed',
        message: 'Please complete your payment to restore access to your plan.',
        actionLabel: 'Make Payment', setupStep: 'billing' };
    }
    if (accessStatus === 'CANCELED_WITH_ACCESS') {
      const until = s.access_until_date ? new Date(s.access_until_date).toLocaleDateString('en-CA', { month:'short', day:'numeric', year:'numeric' }) : '';
      const untilMsg = until ? ' on ' + until : ' at the end of your billing period';
      banner = { type: 'canceled_with_access', title: 'Subscription Ending',
        message: 'Your subscription is ending' + untilMsg + '. You retain access until then.' };
    } else if (accessStatus === 'CANCELED') {
      banner = { type: 'canceled', title: 'Subscription Ended',
        message: 'Your subscription has ended. Please purchase a new plan to regain access.',
        actionLabel: 'Purchase a New Plan', setupStep: 'plans' };
    } else if (setupRequired) {
      banner = { type: 'setup_required', title: 'Setup Required',
        message: 'Complete your mailbox setup to start receiving mail.',
        actionLabel: 'Set Up Now', setupStep: 'plan_setup' };
    }

    return {
      subscriptionId:      s.id,
      planName:            s.plan_name,
      planAmount:          s.plan_amount,
      planAmountFormatted: s.plan_amount_formatted || null,
      interval:            s.interval,
      intervalCount:       s.interval_count || 1,
      productId:           s.product_id,
      locationId:          s.location_id || null,
      locationShutdown:    (function(){ var _lid = (pc && pc.location_id) || s.location_id; return _lid ? (_shutdownByLoc[_lid] === true) : false; })(),
      stripeSubId:         s.stripe_subscription_id || null,
      currentPeriodStart:  s.current_period_start || null,
      currentPeriodEnd:    s.current_period_end   || null,
      canceledAt:          s.canceled_at          || null,
      accessUntilDate:     s.access_until_date    || null,
      accessStatus,
      canAccess,
      setupRequired,
      setupStep,
      planCardId:          pc ? pc.plan_card_id : null,
      planCard:            pc || null,
      friendlyName:        pc ? pc.friendly_name : null,
      banner
    };
  });

  // Replace placeholder in banners
  subscriptions.forEach(s => {
    if (s.banner && s.banner.actionUrl === '__PAYMENT_URL__') s.banner.actionUrl = '__BILLING_PORTAL__';
  });

  // Auto-resolve payment failed tasks only if NO subscriptions are PAYMENT_REQUIRED
  const hasPaymentIssue = subscriptions.some(s => s.accessStatus === 'PAYMENT_REQUIRED');
  if (!hasPaymentIssue) {
    sb.from('tasks').update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: 'Payment restored automatically' })
      .eq('client_id', clientId).eq('type', 'payment_failed').in('status', ['open','in_progress','snoozed']).then(() => {}).catch(() => {});
  }

  return {
    status:           'client',
    clientId:         clientId,
    name:             [client.given_name, client.family_name].filter(Boolean).join(' '),
    givenName:        client.given_name,
    familyName:       client.family_name,
    email:            client.email,
    phone:            client.phone || '',
    stripeCustomerId: client.stripe_customer_id || null,
    mustChangePassword: client.must_change_password === true,
    subscriptions
  };
}

// ============================================================
// CLIENT READS
// ============================================================

async function _getClientMailLog(uuid, subscriptionId) {
  const { data, error } = await sb.from('mail_log')
    .select('*')
    .eq('client_id', uuid)
    .eq('subscription_id', subscriptionId)
    .neq('status', 'deleted')
    .order('logged_at', { ascending: false });
  if (error) return { status: 'error', message: error.message };

  // Get plan card for limits and period
  const { data: pc } = await sb.from('plan_cards').select('*')
    .eq('client_id', uuid).eq('subscription_id', subscriptionId).maybeSingle();

  // Dynamically calculate which items are overage across ALL periods
  let overageMailIds = new Set();
  let currentPeriodStart = null;
  let currentPeriodEnd = null;
  if (pc) {
    const { periodStart, periodEnd } = await _ensureCurrentPeriod(pc);
    currentPeriodStart = periodStart;
    currentPeriodEnd = periodEnd;
    const mailLimit   = pc.mail_limit   || 0;
    const parcelLimit = pc.parcel_limit || 0;

    // Get subscription anchor to walk all periods
    const { data: subData } = await sb.from('subscriptions')
      .select('created_at, interval, interval_count')
      .eq('id', pc.subscription_id).maybeSingle();

    if (subData && subData.created_at) {
      const anchorDate   = subData.created_at.split('T')[0];
      const interval     = subData.interval || 'month';
      const intervalCount = subData.interval_count || 1;
      const [aY, aM, aD] = anchorDate.split('-').map(Number);
      let y = aY, m = aM;
      const today = _localToday();

      // Membership uses the COMPANY-zone calendar day of each logged_at (§0d case R:
      // billing periods are company-level). Comparing the raw UTC string against
      // bare date bounds would use UTC-midnight semantics and misplace edge items.
      const _coDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';

      for (let i = 0; i < 120; i++) {
        const maxDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const d = Math.min(aD, maxDay);
        const ps = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        let ny = y, nm = m;
        if (interval === 'year') { ny += intervalCount; }
        else { nm += intervalCount; if (nm > 12) { ny += Math.floor((nm-1)/12); nm = ((nm-1)%12)+1; } }
        const nMax = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
        const nd = Math.min(aD, nMax);
        const nextStart = `${ny}-${String(nm).padStart(2,'0')}-${String(nd).padStart(2,'0')}`;
        const pe = _addDays(nextStart, -1);
        if (ps > today) break;

        const periodItems = (data || []).filter(m => {
          if (m.special_case) return false;
          const day = _coDay(m.logged_at);
          return day >= ps && day <= pe;
        }).sort((a, b) => a.logged_at.localeCompare(b.logged_at));

        const letters = periodItems.filter(m => m.type === 'letter');
        const parcels = periodItems.filter(m => m.type === 'parcel');
        if (mailLimit > 0)   letters.slice(mailLimit).forEach(m => overageMailIds.add(m.mail_id));
        if (parcelLimit > 0) parcels.slice(parcelLimit).forEach(m => overageMailIds.add(m.mail_id));

        y = ny; m = nm;
      }
    } else if (periodStart && periodEnd) {
      // Fallback: just current period if no subscription anchor
      const _coDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';
      const periodItems = (data || []).filter(m => {
        if (m.special_case) return false;
        const day = _coDay(m.logged_at);
        return day >= periodStart && day <= periodEnd;
      }).sort((a, b) => a.logged_at.localeCompare(b.logged_at));
      const letters = periodItems.filter(m => m.type === 'letter');
      const parcels = periodItems.filter(m => m.type === 'parcel');
      if (mailLimit > 0)   letters.slice(mailLimit).forEach(m => overageMailIds.add(m.mail_id));
      if (parcelLimit > 0) parcels.slice(parcelLimit).forEach(m => overageMailIds.add(m.mail_id));
    }
  }

  // Strip staff-only fields and hide expired scans
  const now = new Date().toISOString();
  const mailLog = (data || []).map(m => {
    const r = rowToCamel(m);
    delete r.noteInternal;
    delete r.physicalLocation;
    // Dynamic overage flag + billed status
    const isOverage = overageMailIds.has(m.mail_id);
    r.overageFlag = isOverage;
    // overageBilled only for past period items \u2014 use freshly calculated period, not stale DB value.
    // Compare on the COMPANY-zone calendar day (consistent with the period membership above).
    const _coDayOf = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';
    const _mDay = _coDayOf(m.logged_at);
    const itemInCurrentPeriod = currentPeriodStart && currentPeriodEnd
      && _mDay >= currentPeriodStart
      && _mDay <= currentPeriodEnd;
    r.overageBilled = isOverage && !itemInCurrentPeriod && !!(pc && pc.last_billed_at && _coDayOf(pc.last_billed_at) >= _mDay);
    // Hide scan if expired
    if (r.scanExpiresAt && r.scanExpiresAt < now) {
      r.scanImageUrl = null;
      r.scanExpired = true;
    }
    return r;
  });
  return { status: 'ok', mailLog };
}

async function _getPlanCard(uuid, subscriptionId) {
  const { data, error } = await sb.from('plan_cards').select('*')
    .eq('client_id', uuid).eq('subscription_id', subscriptionId).maybeSingle();
  if (error) return { status: 'error', message: error.message };
  if (!data) return { status: 'ok', planCard: null };
  const card = rowToCamel(data);
  // Live usage from mail_log
  // Auto-refresh billing period
  const { periodStart, periodEnd } = await _ensureCurrentPeriod(data);
  card.currentPeriodStart = periodStart;
  card.currentPeriodEnd = periodEnd;
  const usage = await _getLiveUsage(data.plan_card_id, periodStart, periodEnd);
  card.mailsUsed = usage.mailsUsed;
  card.parcelsUsed = usage.parcelsUsed;

  // Enrich with location details
  if (data.location_id) {
    const { data: loc } = await sb.from('locations').select('name, address, city, province, postal_code, phone, email, timezone, mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours, holiday_notes, special_notes, tax_name, tax_rate')
      .eq('location_id', data.location_id).eq('company_id', data.company_id).maybeSingle();
    if (loc) {
      if (loc.timezone !== undefined) LOC_TZ_MAP[data.location_id] = loc.timezone || null;
      card.locationName = loc.name;
      card.locationAddress = loc.address;
      card.locationCity = loc.city;
      card.locationProvince = loc.province;
      card.locationPostal = loc.postal_code;
      card.locationPhone = loc.phone;
      card.locationEmail = loc.email;
      card.locationHours = { mon: loc.mon_hours, tue: loc.tue_hours, wed: loc.wed_hours, thu: loc.thu_hours, fri: loc.fri_hours, sat: loc.sat_hours, sun: loc.sun_hours };
      card.locationHolidayNotes = loc.holiday_notes;
      card.locationSpecialNotes = loc.special_notes;
      card.taxName = (loc.tax_name != null) ? loc.tax_name : 'Tax';
      card.taxRate = (loc.tax_rate != null) ? parseFloat(loc.tax_rate) : 0;
    }
  }

  // Check for pending cancellation request
  const { data: cancelTask } = await sb.from('tasks').select('task_id, status')
    .eq('plan_card_id', data.plan_card_id).eq('type', 'cancellation_request')
    .in('status', ['open', 'in_progress', 'snoozed']);
  if (cancelTask && cancelTask.length > 0) {
    card.hasPendingCancellation = true;
    card.cancellationStatus = cancelTask[0].status; // 'open' or 'in_progress'
  } else {
    // Check if there's a resolved cancellation (staff processed it)
    const { data: resolvedCancel } = await sb.from('tasks').select('task_id, resolution_note')
      .eq('plan_card_id', data.plan_card_id).eq('type', 'cancellation_request')
      .eq('status', 'resolved').order('resolved_at', { ascending: false }).limit(1);
    if (resolvedCancel && resolvedCancel.length > 0 && resolvedCancel[0].resolution_note && resolvedCancel[0].resolution_note.startsWith('[PROCESSED]')) {
      // Only show cancellation processed if subscription is still ending \u2014 not if reactivated
      const subStatus = card.accessStatus || 'ACTIVE';
      card.cancellationProcessed = (subStatus === 'CANCELED_WITH_ACCESS');
    } else {
      card.hasPendingCancellation = false;
    }
  }

  return { status: 'ok', planCard: card };
}

async function _getBillingHistory(uuid, subscriptionId) {
  // Get plan card
  const { data: pc } = await sb.from('plan_cards').select('*')
    .eq('client_id', uuid).eq('subscription_id', subscriptionId).maybeSingle();
  if (!pc) return { status: 'ok', periods: [] };

  // Get subscription for anchor date
  const { data: sub } = await sb.from('subscriptions').select('created_at, interval, interval_count')
    .eq('id', subscriptionId).maybeSingle();
  if (!sub || !sub.created_at) return { status: 'ok', periods: [] };

  // Location tax (per plan-card location; no hardwired rate). Self-scoped to the
  // plan card's company_id — service role bypasses RLS, so never trust location_id alone.
  const { data: _loc } = await sb.from('locations').select('tax_name, tax_rate')
    .eq('location_id', pc.location_id).eq('company_id', pc.company_id).maybeSingle();
  const taxName = (_loc && _loc.tax_name) ? _loc.tax_name : 'Tax';
  const taxRate = (_loc && _loc.tax_rate != null) ? parseFloat(_loc.tax_rate) : 0;

  const anchorDate = sub.created_at.split('T')[0];
  const interval = sub.interval || 'month';
  const intervalCount = sub.interval_count || 1;
  const today = _localToday();
  const mailLimit = pc.mail_limit || 0;
  const parcelLimit = pc.parcel_limit || 0;
  const mailFee = parseFloat(pc.mail_overage_fee) || 0;
  const parcelFee = parseFloat(pc.parcel_overage_fee) || 0;

  // Get ALL mail items for this plan card (not deleted, not special)
  const { data: allItems } = await sb.from('mail_log').select('mail_id, type, logged_at, status')
    .eq('plan_card_id', pc.plan_card_id)
    .eq('special_case', false)
    .neq('status', 'deleted')
    .order('logged_at', { ascending: true });

  // Walk all periods from anchor to current
  const [aY, aM, aD] = anchorDate.split('-').map(Number);
  let y = aY, m = aM;
  const periods = [];

  for (let i = 0; i < 240; i++) {
    const maxDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(aD, maxDay);
    const periodStart = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // Next period start
    let ny = y, nm = m;
    if (interval === 'year') { ny += intervalCount; }
    else { nm += intervalCount; if (nm > 12) { ny += Math.floor((nm - 1) / 12); nm = ((nm - 1) % 12) + 1; } }
    const nMaxDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const nd = Math.min(aD, nMaxDay);
    const nextStart = `${ny}-${String(nm).padStart(2,'0')}-${String(nd).padStart(2,'0')}`;
    const periodEnd = _addDays(nextStart, -1);

    // Only include periods that have started
    if (periodStart > today) break;

    const isCurrent = today >= periodStart && today <= periodEnd;

    // Filter items for this period — by COMPANY-zone calendar day (§0d case R).
    const _coDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';
    const periodItems = (allItems || []).filter(item => {
      const day = _coDay(item.logged_at);
      return day >= periodStart && day <= periodEnd;
    });
    const letters = periodItems.filter(item => item.type === 'letter');
    const parcels = periodItems.filter(item => item.type === 'parcel');

    const mailOverage = Math.max(0, letters.length - mailLimit);
    const parcelOverage = Math.max(0, parcels.length - parcelLimit);
    const subtotal = (mailOverage * mailFee) + (parcelOverage * parcelFee);
    const hst = subtotal * (taxRate / 100);
    const total = subtotal + hst;

    // Current period is never billed \u2014 still running
    // Past periods: billed if last_billed_at falls on or after this period started
    const isBilled = !isCurrent && !!(pc.last_billed_at && _coDay(pc.last_billed_at) >= periodStart);

    periods.push({
      periodStart,
      periodEnd,
      isCurrent,
      mailUsed: letters.length,
      mailLimit,
      mailOverage,
      mailFee,
      parcelUsed: parcels.length,
      parcelLimit,
      parcelOverage,
      parcelFee,
      subtotal,
      hst,
      total,
      taxName,
      taxRate,
      hasOverage: mailOverage > 0 || parcelOverage > 0,
      isBilled: !!isBilled
    });

    // Advance
    y = ny; m = nm;
  }

  // Reverse so newest first
  periods.reverse();
  return { status: 'ok', periods };
}

async function _getAgents(uuid, subscriptionId) {
  const { data } = await sb.from('pickup_agents').select('*')
    .eq('client_id', uuid).in('status', ['active', 'inactive'])
    .order('added_at');
  return { status: 'ok', agents: rowsToCamel(data) };
}

async function _getRecipients(uuid, subscriptionId) {
  const { data } = await sb.from('recipients').select('*')
    .eq('client_id', uuid).eq('subscription_id', subscriptionId)
    .order('created_at');
  return { status: 'ok', recipients: rowsToCamel(data) };
}

async function _getPlanTemplate(productId) {
  if (!productId) return { status: 'error', message: 'No productId' };
  const { data: tmpl } = await sb.from('plans').select('*')
    .eq('product_id', productId).maybeSingle();
  // Scope locations to the plan's own company so a public productId can never
  // surface another tenant's locations (sb uses the service-role key = no RLS).
  let _locQ = sb.from('locations').select('*').eq('active', true);
  if (tmpl && tmpl.company_id) _locQ = _locQ.eq('company_id', tmpl.company_id);
  const { data: allLocs } = await _locQ;
  (allLocs || []).forEach(l => { if (l && l.location_id) LOC_TZ_MAP[l.location_id] = l.timezone || null; });

  // Filter locations based on plan's locations field (comma-separated IDs)
  let locs = allLocs || [];
  if (tmpl && tmpl.locations) {
    const allowedIds = tmpl.locations.split(',').map(s => s.trim());
    locs = locs.filter(l => allowedIds.includes(l.location_id));
  }

  return {
    status: 'ok',
    template: tmpl ? rowToCamel(tmpl) : null,
    locations: rowsToCamel(locs)
  };
}

// ============================================================
// EMAIL NOTIFICATIONS (Resend)
// ============================================================

// Cache config to avoid repeated DB reads per request
// Per-company caches (keyed by companyId) to prevent cross-tenant leakage.
let _resendConfigCacheByCo = {};
let _resendConfigCacheTsByCo = {};
// Module-level "current company" for email operations; set by entry points that
// know the company, read by the email helpers when no explicit id is passed.
let _emailCompanyId = null;
function _setEmailCompany(id) { _emailCompanyId = id || null; }

async function _getResendConfig(companyId) {
  const cid = companyId || _emailCompanyId;
  // TENANT ISOLATION: resend_* are per-company secrets. No fallback company, and
  // never read config unscoped (an unfiltered read blends every tenant's keys).
  // No company in hand -> return empty so the caller treats email as unconfigured.
  if (!cid) return {};
  const now = Date.now();
  if (_resendConfigCacheByCo[cid] && now - (_resendConfigCacheTsByCo[cid] || 0) < 60000) return _resendConfigCacheByCo[cid];
  const { data } = await sb.from('config').select('key, value')
    .eq('company_id', cid)
    .in('key', ['resend_api_key', 'resend_from', 'resend_from_name', 'resend_reply_to']);
  const cfg = {};
  for (const row of (data || [])) cfg[row.key] = row.value;
  _resendConfigCacheByCo[cid] = cfg;
  _resendConfigCacheTsByCo[cid] = now;
  return cfg;
}

// ── One-time charge → create-charge edge function ───────────────────────────
// Forwards the signed-in staff/admin's OWN access token so the edge function
// verifies who is asking and whether they may create charges (admins always may;
// staff need can_create_charge). The server recomputes tax from the location and
// enforces the item/total caps — the browser numbers are for display only.
async function _createCharge(body) {
  try {
    const token = localStorage.getItem(_sbKey('access_token'));
    if (!token) return { status: 'error', message: 'not authenticated' };

    const res = await fetch(SUPABASE_URL + '/functions/v1/create-charge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        clientId:   body.clientId,
        locationId: body.locationId,
        items:      body.items || [],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { status: 'error', message: data.error || 'Charge failed' };
    }

    // Audit trail — recorded from the adapter (edge fn stays Stripe-only).
    try {
      await _audit({
        staffId:    body.uuid || null,
        action:     'charge_created',
        entityType: 'client',
        entityId:   body.clientId,
        clientId:   body.clientId,
        planCardId: body.planCardId || null,
        locationId: body.locationId || null,
        summary:    'One-time charge ' + (data.status === 'paid' ? 'paid' : 'created (open invoice)')
                    + ' \u2014 $' + Number(data.total || 0).toFixed(2)
                    + (data.taxRate ? ' (incl. ' + data.taxName + ')' : ''),
      });
    } catch (_e) { /* audit is best-effort; never blocks the charge result */ }

    return { status: 'ok', outcome: data.status, invoiceId: data.invoiceId,
             total: data.total, taxAmount: data.taxAmount, subtotal: data.subtotal,
             card: data.card || null };
  } catch (e) {
    return { status: 'error', message: (e && e.message) || 'Charge failed' };
  }
}

// Account credit — admin adds or removes a client's balance credit. The edge
// function performs the Stripe balance transaction (source of truth); the audit
// row here mirrors _createCharge's pattern (best-effort, never blocks result).
async function _adjustCredit(body) {
  try {
    const token = localStorage.getItem(_sbKey('access_token'));
    if (!token) return { status: 'error', message: 'not authenticated' };

    const res = await fetch(SUPABASE_URL + '/functions/v1/adjust-credit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        clientId:  body.clientId,
        direction: body.direction,   // 'add' | 'remove'
        amount:    body.amount,      // dollars
        reason:    body.reason,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { status: 'error', message: data.error || 'Credit adjustment failed',
               creditBalanceCents: (data && data.creditBalanceCents != null) ? data.creditBalanceCents : null };
    }

    // Audit trail — recorded from the adapter (edge fn stays Stripe-only).
    try {
      var _added = (data.direction === 'add');
      await _audit({
        staffId:    body.uuid || null,
        action:     _added ? 'credit_added' : 'credit_removed',
        entityType: 'client',
        entityId:   body.clientId,
        clientId:   body.clientId,
        summary:    (_added ? 'Added ' : 'Removed ')
                    + '$' + (Number(data.amountCents || 0) / 100).toFixed(2)
                    + ' account credit'
                    + (body.reason ? ' \u2014 ' + body.reason : ''),
      });
    } catch (_e) { /* audit is best-effort; never blocks the credit result */ }

    return { status: 'ok', direction: data.direction, amountCents: data.amountCents,
             creditBalanceCents: data.creditBalanceCents, transactionId: data.transactionId };
  } catch (e) {
    return { status: 'error', message: (e && e.message) || 'Credit adjustment failed' };
  }
}

// Admin billing view. Two modes, both admin-only + company-scoped server-side:
//   mode 'rollup' (+ period) → company-wide invoice list + totals + MRR
//   mode 'client' (+ clientId) → one client's full invoice history + plans
// Read-only; passes the caller's bearer token so the edge fn resolves the
// admin's company. Returns the edge fn's JSON verbatim on success.
async function _getAdminBilling(body) {
  try {
    const token = localStorage.getItem(_sbKey('access_token'));
    if (!token) return { status: 'error', message: 'not authenticated' };

    const res = await fetch(SUPABASE_URL + '/functions/v1/get-admin-billing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        mode:            body.mode || 'rollup',
        period:          body.period || 'month',
        clientId:        body.clientId || null,
        invoiceId:       body.invoiceId || null,
        paymentMethodId: body.paymentMethodId || null,
        after:           body.after || null,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { status: 'error', message: data.error || 'Could not load billing', diag: data.diag || null };
    }
    return data;
  } catch (e) {
    return { status: 'error', message: (e && e.message) || 'Could not load billing' };
  }
}

async function _sendEmail(to, subject, html, companyId) {
  try {
    const cid = companyId || _emailCompanyId;
    // TENANT ISOLATION: no fallback company. Without a real company we cannot
    // know which Resend account / from-address to use, so we MUST NOT send
    // (sending under a guessed tenant = wrong-brand email). Skip + log loudly.
    if (!cid) { console.error('send email skipped: no company in context'); return; }
    const cfg = await _getResendConfig(cid);
    if (!cfg.resend_api_key || !cfg.resend_from) return; // not configured
    // Call edge function server-side to avoid CORS + keep API key off browser.
    // Pass company so the edge function uses the right Resend account/from address.
    const edgeUrl = SUPABASE_URL + '/functions/v1/send-email';
    const res = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_KEY
      },
      body: JSON.stringify({ to, subject, html, company_id: cid })
    });
    if (!res.ok) { const e = await res.text(); console.error('send-email edge error:', e); }
    // Log to notification_log (stamped with company)
    sb.from('notification_log').insert({
      id: 'NL' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      company_id: cid,
      recipient_type: 'email', recipient_id: Array.isArray(to) ? to[0] : to,
      type: 'email', channel: 'email', subject, message: null
    }).then(() => {}).catch(() => {});
  } catch(e) { /* email failure is non-critical */ }
}

// Check if email is enabled for this type/role combo
async function _isEmailEnabled(type, role, companyId) {
  try {
    const cid = companyId || _emailCompanyId; // no fallback company
    const prefs = await _getNotifPrefs(cid);
    const key = type + '_' + role + '_email';
    return prefs[key] !== false; // default on unless explicitly disabled
  } catch(e) { return true; }
}

// Email HTML wrapper
// Default email templates \u2014 overridable via config table (key: email_template_{type})
const _EMAIL_DEFAULTS = {
  mail_received:          { subject: 'New {type} received', body: 'Hi {name},\n\nA new {type} has arrived{recipient_line}{sender_line}.\n\nLog in to your client portal to view details.' },
  mail_picked_up:         { subject: 'Your mail has been picked up', body: 'Hi {name},\n\n{count} item{count_plural} been picked up by {agent}.' },
  forwarding_batch:       { subject: 'Your mail has been shipped', body: 'Hi {name},\n\n{count} item{count_plural} from your mailbox been shipped to your forwarding address.{tracking_line}' },
  payment_failed:         { subject: 'Action required: Payment issue with your account', body: 'Hi {name},\n\nWe were unable to process your payment. Please update your payment method to avoid interruption to your service. You can update it anytime under Manage Billing in your account.' },
  cancellation_processed: { subject: 'Your cancellation has been processed', body: 'Hi {name},\n\nYour cancellation request has been processed. Your plan will remain active until the end of your current billing period.' },
  cancellation_withdrawn: { subject: 'Your cancellation request has been closed', body: 'Hi {name},\n\nYour cancellation request has been closed and your plan remains active. Welcome back!' },
  id_reviewed:            { subject: 'Your ID has been {decision}', body: 'Hi {name},\n\n{id_reviewed_message}' },
  task_assigned:          { subject: 'New task assigned to you', body: 'Hi {name},\n\nA new task has been assigned to you: {task_title}\n\nLog in to the staff portal to view and action it.' },
  id_submitted:           { subject: 'ID submitted for review', body: 'Hi {staff_name},\n\n{client_name} has submitted their ID for verification. Please review it in the staff portal.' },
  expiry_warning:         { subject: 'Reminder: Your mail is expiring soon', body: 'Hi {name},\n\n{count} item{count_plural} expiring soon. Please log in to arrange pickup or forwarding before the storage deadline.' },
  due_today:              { subject: 'Action required: Mail due for pickup today', body: 'Hi {name},\n\n{count} item{count_plural} due for pickup today. Please arrange pickup or forwarding as soon as possible.' },
  invoice_created:        { subject: 'New invoice available \u2014 {amount}', body: 'Hi {name},\n\nA new invoice ({invoice_number}) for {amount} has been created on your account.\n\nOpen your billing page to view and pay.' },
  password_reset_client:  { subject: 'Your password has been reset', body: 'Hi {name},\n\nYour client portal password has been reset by our team.\n\nYour temporary password is: {password}\n\nPlease log in and change your password as soon as possible. If you did not request this change, contact us immediately.' },
};

// Per-company template caches
let _emailTemplateCacheByCo = {};
let _emailTemplateCacheTsByCo = {};

async function _getEmailTemplates(companyId) {
  const cid = companyId || _emailCompanyId; // no fallback company
  const ck = cid || '_none';
  const now = Date.now();
  if (_emailTemplateCacheByCo[ck] && now - (_emailTemplateCacheTsByCo[ck] || 0) < 60000) return _emailTemplateCacheByCo[ck];
  // Merge: company's own template rows on top of default_configs templates.
  const merged = await _mergedConfig(cid); // all keys merged (company over defaults)
  const templates = {};
  for (const key of Object.keys(merged)) {
    if (key.indexOf('email_template_') !== 0) continue;
    const type = key.replace('email_template_', '');
    try { templates[type] = JSON.parse(merged[key]); } catch(e) {}
  }
  _emailTemplateCacheByCo[ck] = templates;
  _emailTemplateCacheTsByCo[ck] = now;
  return templates;
}

async function _resolveTemplate(type, vars, companyId) {
  const templates = await _getEmailTemplates(companyId);
  const tpl = templates[type] || _EMAIL_DEFAULTS[type] || { subject: type, body: '' };
  let subject = tpl.subject || '';
  let body = tpl.body || '';
  let ctaLabel = tpl.cta_label || '';
  let ctaUrl = tpl.cta_url || '';
  const ctaEnabled = tpl.cta_enabled === true || tpl.cta_enabled === 'true';

  // Replace variables in subject, body, and CTA URL
  for (const [k, v] of Object.entries(vars || {})) {
    const token = '{' + k + '}';
    subject = subject.split(token).join(v || '');
    body = body.split(token).join(v || '');
    ctaUrl = ctaUrl.split(token).join(v || '');
    ctaLabel = ctaLabel.split(token).join(v || '');
  }

  // Convert newlines to <p> tags
  const bodyHtml = body.split('\n\n').map(p => p.trim()).filter(Boolean)
    .map(p => '<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">' + p + '</p>').join('');

  return { subject, bodyHtml, ctaEnabled, ctaLabel, ctaUrl };
}

async function _emailHtml(title, bodyHtml, ctaLabel, ctaUrl, companyId) {
  const cid = companyId || _emailCompanyId; // no fallback company
  const cfg = await _getResendConfig(cid); // {} when no company
  // Brandable keys fall back to shared non-secret platform defaults only.
  // With no company, _mergedConfig serves default_configs (never another
  // tenant's branding/logo/colors), so output is plain-generic — no leak.
  const brand = await _mergedConfig(cid, ['branding_company_name', 'branding_logo_url',
    'email_accent_color', 'email_footer_text', 'email_show_logo']);

  const co       = brand.branding_company_name || cfg.resend_from_name || 'Mailbox Service';
  const accent   = brand.email_accent_color || '#1a1a1a';
  const footer   = brand.email_footer_text || '';
  const showLogo = brand.email_show_logo !== '0' && !!brand.branding_logo_url;
  const logoUrl  = brand.branding_logo_url || '';
  const replyTo  = cfg.resend_reply_to || null;
  const replyLine   = replyTo ? ' &mdash; <a href="mailto:' + replyTo + '" style="color:#bbb;text-decoration:underline">' + replyTo + '</a>' : '';
  const footerExtra = footer ? '<p style="margin:6px 0 0;font-size:11px;color:#bbb;line-height:1.6">' + footer + '</p>' : '';

  const headerHtml = showLogo
    ? '<img src="' + logoUrl + '" alt="' + co + '" style="max-height:32px;max-width:160px;display:block;margin:0 auto">'
    : '<span style="font-size:14px;font-weight:600;color:#111;letter-spacing:-0.2px">' + co + '</span>';

  const ctaHtml = ctaLabel && ctaUrl
    ? '<table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:8px 0 32px"><a href="' + ctaUrl + '" target="_blank" style="display:inline-block;background:' + accent + ';color:#ffffff;font-size:14px;font-weight:600;padding:14px 36px;border-radius:50px;text-decoration:none;letter-spacing:0.1px;mso-padding-alt:14px 36px">' + ctaLabel + '</a></td></tr></table>'
    : '';

  // Gmail-safe: outer bg table, inner card table with border trick for rounded corners
  return '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    '<title>' + title + '</title>' +
    '<style>body{margin:0;padding:0;background:#f0f0f0}a{color:inherit}</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:#f0f0f0;-webkit-font-smoothing:antialiased">' +

    // Outer background
    '<table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#f0f0f0" style="background:#f0f0f0">' +
    '<tr><td align="center" style="padding:40px 16px">' +

    // Inner max-width wrapper
    '<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%">' +

    // Logo row
    '<tr><td align="center" style="padding-bottom:24px;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">' +
    headerHtml +
    '</td></tr>' +

    // Card \u2014 accent top border via table cell bgcolor
    '<tr><td style="border-radius:16px;overflow:hidden;background:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.08)">' +
    '<table width="100%" cellpadding="0" cellspacing="0" role="presentation">' +

    // Accent bar row
    '<tr><td height="4" bgcolor="' + accent + '" style="background:' + accent + ';font-size:0;line-height:0;height:4px">&nbsp;</td></tr>' +

    // Content row
    '<tr><td align="center" style="padding:40px 48px 32px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">' +

    // Divider
    '<div style="width:32px;height:1px;background:#e8e8e8;margin:0 auto 28px;font-size:0;line-height:0">&nbsp;</div>' +

    // Title
    '<h1 style="margin:0 0 20px;font-size:22px;font-weight:600;color:#111111;letter-spacing:-0.5px;line-height:1.3;text-align:center;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">' + title + '</h1>' +

    // Body
    '<div style="text-align:left;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">' + bodyHtml + '</div>' +

    // CTA
    ctaHtml +

    '</td></tr>' +

    // Footer row
    '<tr><td align="center" style="padding:16px 48px 20px;background:#f9f9f9;border-top:1px solid #eeeeee;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">' +
    '<p style="margin:0;font-size:11px;color:#bbbbbb;line-height:1.6">This is an automated notification' + replyLine + '.</p>' +
    footerExtra +
    '</td></tr>' +

    '</table>' +
    '</td></tr>' +

    // Bottom spacer
    '<tr><td height="32" style="font-size:0;line-height:0">&nbsp;</td></tr>' +

    '</table>' +
    '</td></tr></table>' +
    '</body></html>';
}

async function _sendTestEmail(body) {
  try {
    _setEmailCompany(await _companyIdFor(body.uuid, false));
    const { data: staff } = await sb.from('staff').select('email, name').eq('staff_id', body.uuid).maybeSingle();
    const to = staff?.email;
    if (!to) return { status: 'error', message: 'No email address found for your account' };
    const _testHtml = await _emailHtml('Email Integration Test', '<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">Hi ' + (staff.name || 'there') + ',</p><p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">This is a test email. Your email integration is working correctly. \u2705</p>');
    await _sendEmail(to, 'Email Integration Test', _testHtml);
    return { status: 'ok' };
  } catch(e) { return { status: 'error', message: e.message }; }
}

// ============================================================
// CLIENT WRITES
// ============================================================

async function _submitOnboarding(body) {
  const productId = body.productId;
  const { data: tmpl } = await sb.from('plans').select('*')
    .eq('product_id', productId).maybeSingle();
  if (!tmpl) return { status: 'error', message: 'Plan template not found' };

  // Guard against double-submit creating duplicate plan cards for same subscription
  const { data: existingPc } = await sb.from('plan_cards')
    .select('plan_card_id')
    .eq('subscription_id', body.subscriptionId)
    .eq('status', 'active')
    .maybeSingle();
  if (existingPc) return { status: 'ok', planCardId: existingPc.plan_card_id };

  const planCardId = _genId('PC');
  const now = new Date().toISOString();
  const today = _localToday();

  // Pull subscription to calculate billing period from anchor date
  const { data: subData } = await sb.from('subscriptions')
    .select('created_at, interval, interval_count, location_id')
    .eq('id', body.subscriptionId).maybeSingle();

  // Authoritative location: the subscription (set at signup/taxed) wins.
  // Fall back to the form value only for legacy subs created before the column existed.
  const signupLocationId = subData?.location_id || body.locationId || null;
  if (!signupLocationId) return { status: 'error', message: 'No location on file for this plan \u2014 please contact support.' };

  // Company is determined by the authoritative location (locations are company-owned).
  let companyId = null;
  if (signupLocationId) {
    const { data: loc } = await sb.from('locations').select('company_id').eq('location_id', signupLocationId).maybeSingle();
    companyId = loc ? loc.company_id : null;
  }
  // Fallback: derive from the client's own company (set at signup by the webhook).
  if (!companyId && body.uuid) {
    const { data: cl } = await sb.from('clients').select('company_id').eq('id', body.uuid).maybeSingle();
    companyId = cl ? cl.company_id : null;
  }
  if (!companyId) return { status: 'error', message: 'Could not determine company for this plan card.' };
  // Stamp the client with this company on their first onboarding (if not already set).
  if (body.uuid) {
    await sb.from('clients').update({ company_id: companyId }).eq('id', body.uuid).is('company_id', null);
  }

  // Calculate period: anchor = subscription created date, period = interval
  // Use UTC methods to avoid timezone drift (created_at is UTC)
  const anchorRaw = subData?.created_at || new Date().toISOString();
  const periodStart = anchorRaw.split('T')[0]; // Extract YYYY-MM-DD directly from UTC string

  // Calculate period end based on interval: anchor + interval - 1 day
  const intervalCount = subData?.interval_count || 1;
  // Parse the date parts from the UTC string to avoid timezone issues
  const [aY, aM, aD] = periodStart.split('-').map(Number);
  const endDate = new Date(Date.UTC(aY, aM - 1, aD)); // construct in UTC
  const interval = subData?.interval || 'month';
  if (interval === 'year') {
    endDate.setUTCFullYear(endDate.getUTCFullYear() + intervalCount);
  } else if (interval === 'week') {
    endDate.setUTCDate(endDate.getUTCDate() + (7 * intervalCount));
  } else if (interval === 'day') {
    endDate.setUTCDate(endDate.getUTCDate() + intervalCount);
  } else {
    // month (default)
    endDate.setUTCMonth(endDate.getUTCMonth() + intervalCount);
  }
  // Subtract 1 day: period ends the day before the next cycle starts
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const periodEnd = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2,'0')}-${String(endDate.getUTCDate()).padStart(2,'0')}`;

  const { error } = await sb.from('plan_cards').insert({
    plan_card_id:       planCardId,
    company_id:         companyId,
    client_id:          body.uuid,
    subscription_id:    body.subscriptionId,
    location_id:        signupLocationId,
    plan_name:          tmpl.plan_name,
    billing_cycle:      tmpl.billing_cycle,
    status:             'active',
    mail_limit:         tmpl.mail_limit,
    parcel_limit:       tmpl.parcels_included || 0,
    max_recipients:     tmpl.max_recipients,
    recipients_added:   0,
    mail_storage_days:  tmpl.mail_storage_days,
    parcel_storage_days:tmpl.parcel_storage_days,
    mail_overage_fee:   tmpl.mail_overage_fee,
    parcel_overage_fee: tmpl.parcel_overage_fee,
    current_period_start: periodStart,
    current_period_end:   periodEnd,
    forwarding_address:   body.forwardingAddress || null,
    forwarding_city:      body.forwardingCity || null,
    forwarding_province:  body.forwardingProvince || null,
    forwarding_postal_code: body.forwardingPostalCode || null,
    forwarding_country:     body.forwardingCountry || null,
    forwarding_instructions: body.forwardingInstructions || null,
    client_timezone:     body.clientTimezone || 'America/Toronto',
    business_description: body.businessDescription || null,
    activated_at:        null,
    activated_by:        null,
    friendly_name:       body.friendlyName || null,
    auto_feature:        tmpl.auto_feature,
    product_id:          productId,
    plan_memo:           tmpl.plan_memo
  });

  if (error) {
    // Unique constraint violation — a plan card for this subscription already exists
    // (race condition: two simultaneous submits both passed the SELECT guard)
    // Gracefully return the existing plan card instead of failing
    if (error.code === '23505') {
      const { data: existing } = await sb.from('plan_cards')
        .select('plan_card_id')
        .eq('subscription_id', body.subscriptionId)
        .maybeSingle();
      if (existing) return { status: 'ok', planCardId: existing.plan_card_id };
    }
    return { status: 'error', message: error.message };
  }

  await _audit({ action: 'plan_card_created', entityType: 'plan_card', entityId: planCardId, clientId: body.uuid, planCardId, locationId: body.locationId, summary: 'Plan card created: ' + planCardId + ' (' + (tmpl.plan_name || productId) + ')' });
  return { status: 'ok', planCardId };
}

async function _addRecipient(body) {
  const planCardId = body.planCardId;
  const { data: pc } = await sb.from('plan_cards')
    .select('max_recipients, recipients_added, subscription_id, location_id, client_id, friendly_name, plan_name, company_id')
    .eq('plan_card_id', planCardId).single();
  if (!pc) return { status: 'error', message: 'Plan card not found' };

  const isTemp = body.notes && body.notes.startsWith('TEMP:');

  if (!isTemp) {
    // Count actual active non-temp recipients (source of truth)
    const { data: activeRecs } = await sb.from('recipients').select('recipient_id')
      .eq('plan_card_id', planCardId).eq('status', 'active')
      .or('notes.is.null,notes.not.like.TEMP:%');
    const activeCount = activeRecs ? activeRecs.length : 0;
    if (activeCount >= pc.max_recipients) {
      return { status: 'error', message: `Maximum active recipients reached (${pc.max_recipients}). Deactivate one first or add as a temporary recipient.` };
    }
  }

  const recipientId = _genId('RCP');
  const now = new Date().toISOString();
  // body.uuid may be a staff ID (e.g. "STF001") which isn't a valid UUID
  const actorUuid = /^[0-9a-f]{8}-/i.test(body.uuid) ? body.uuid : null;
  const { error } = await sb.from('recipients').insert({
    recipient_id:   recipientId,
    company_id:     pc.company_id,
    plan_card_id:   planCardId,
    client_id:      pc.client_id,
    subscription_id: pc.subscription_id,
    location_id:    pc.location_id,
    name:           body.name,
    type:           body.type || 'individual',
    status:         'active',
    activated_at:   now,
    activated_by:   actorUuid,
    has_mail_logged: false,
    language:       body.language || 'en',
    created_at:     now,
    created_by:     actorUuid,
    notes:          body.notes || null
  });
  if (error) return { status: 'error', message: error.message };

  if (!isTemp) {
    // Sync recipients_added counter with actual active count
    const { data: nowActive } = await sb.from('recipients').select('recipient_id')
      .eq('plan_card_id', planCardId).eq('status', 'active')
      .or('notes.is.null,notes.not.like.TEMP:%');
    const newCount = nowActive ? nowActive.length : (pc.recipients_added + 1);
    const updates = { recipients_added: newCount };
    // Activate plan card on first recipient added (completes setup)
    if (pc.recipients_added === 0) {
      updates.activated_at = now;
      updates.activated_by = actorUuid;
    }
    await sb.from('plan_cards').update(updates).eq('plan_card_id', planCardId);
  }
  const recipLabel = isTemp ? 'temp recipient' : 'recipient';
  await _audit({ staffId: body.uuid, action: isTemp ? 'temp_recipient_added' : 'recipient_added', entityType: 'plan_card', entityId: planCardId, clientId: pc.client_id, planCardId, summary: 'Added ' + recipLabel + ' "' + (body.name||'') + '" to ' + planCardId });

  // Notify client when temp recipient added by staff/admin
  if (isTemp && pc.client_id) {
    const planLabel = pc.friendly_name || pc.plan_name || planCardId;
    await _createNotification('client', pc.client_id, 'recipient_added',
      'Temporary recipient added',
      'A temporary recipient "' + (body.name||'') + '" was added to your plan (' + planLabel + ') by staff.',
      null, null, recipientId);
  }

  return { status: 'ok', recipientId };
}

async function _updateFriendlyName(body) {
  const { error } = await sb.from('plan_cards')
    .update({ friendly_name: body.friendlyName })
    .eq('plan_card_id', body.planCardId);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}

async function _addAgent(body) {
  // Check max 5 agents per client
  const { data: existing } = await sb.from('pickup_agents').select('agent_id')
    .eq('client_id', body.uuid).eq('status', 'active');
  if (existing && existing.length >= 5) {
    return { status: 'error', message: 'Maximum 5 pickup agents allowed.' };
  }

  const agentId = _genId('AGT');
  const now = new Date().toISOString();
  // company from the client (agents belong to a client)
  const { data: _agentClient } = await sb.from('clients').select('company_id').eq('id', body.uuid).maybeSingle();
  const { error } = await sb.from('pickup_agents').insert({
    agent_id:     agentId,
    company_id:   _agentClient ? _agentClient.company_id : null,
    plan_card_id: body.planCardId || null,
    client_id:    body.uuid,
    location_id:  body.locationId || null,
    name:         body.name,
    id_type:      body.idType || null,
    id_last4:     body.idLast4 || null,
    phone:        body.phone || null,
    status:       'active',
    added_at:     now,
    added_by:     body.uuid,
    notes:        body.notes || null
  });
  if (error) return { status: 'error', message: error.message };
  await _audit({ action: 'agent_added', entityType: 'client', entityId: body.uuid, clientId: body.uuid, summary: 'Added pickup agent "' + (body.name || '') + '"' });
  return { status: 'ok', agentId };
}

async function _removeAgent(body) {
  // This now toggles between active/inactive
  const { data: agent } = await sb.from('pickup_agents').select('status, client_id')
    .eq('agent_id', body.agentId).maybeSingle();
  if (!agent) return { status: 'error', message: 'Agent not found' };

  const now = new Date().toISOString();
  const newStatus = agent.status === 'active' ? 'inactive' : 'active';

  // If reactivating, check max 5 active
  if (newStatus === 'active') {
    const { data: activeAgents } = await sb.from('pickup_agents').select('agent_id')
      .eq('client_id', agent.client_id).eq('status', 'active');
    if (activeAgents && activeAgents.length >= 5) {
      return { status: 'error', message: 'Maximum 5 active agents allowed. Deactivate one first.' };
    }
  }

  const updates = { status: newStatus };
  if (newStatus === 'inactive') {
    updates.deactivated_at = now;
    updates.deactivated_by = body.uuid;
  } else {
    updates.deactivated_at = null;
    updates.deactivated_by = null;
  }

  const { error } = await sb.from('pickup_agents').update(updates).eq('agent_id', body.agentId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ action: newStatus === 'active' ? 'agent_reactivated' : 'agent_deactivated', entityType: 'client', entityId: agent.client_id, clientId: agent.client_id, summary: 'Pickup agent ' + body.agentId + ' ' + (newStatus === 'active' ? 'reactivated' : 'deactivated') });
  return { status: 'ok', newStatus };
}

async function _updatePhone(body) {
  const phone = (body.phone || '').trim();
  if (!phone) return { status: 'error', message: 'Phone number is required' };
  const { error } = await sb.from('clients').update({ phone }).eq('id', body.uuid);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}

async function _updateForwardingAddress(body) {
  const { error } = await sb.from('plan_cards').update({
    forwarding_address:      body.forwardingAddress || null,
    forwarding_city:         body.forwardingCity || null,
    forwarding_province:     body.forwardingProvince || null,
    forwarding_postal_code:  body.forwardingPostalCode || null,
    forwarding_country:      body.forwardingCountry || null,
    forwarding_instructions: body.forwardingInstructions || null
  }).eq('plan_card_id', body.planCardId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ action: 'forwarding_address_updated', entityType: 'plan_card', entityId: body.planCardId, clientId: body.uuid, planCardId: body.planCardId, summary: 'Forwarding address updated on ' + body.planCardId });
  return { status: 'ok' };
}

async function _updateBusinessDescription(body) {
  const { error } = await sb.from('plan_cards').update({
    business_description: body.businessDescription || null
  }).eq('plan_card_id', body.planCardId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ action: 'business_description_updated', entityType: 'plan_card', entityId: body.planCardId, clientId: body.uuid, planCardId: body.planCardId, summary: 'Business description updated on ' + body.planCardId });
  return { status: 'ok' };
}

async function _requestCancellation(body) {
  const { planCardId, uuid, reason, details } = body;
  if (!planCardId || !uuid) return { status: 'error', message: 'Missing planCardId or uuid' };

  // Check for existing open cancellation request
  const { data: existing } = await sb.from('tasks').select('task_id')
    .eq('plan_card_id', planCardId).eq('type', 'cancellation_request')
    .in('status', ['open', 'in_progress', 'snoozed']);
  if (existing && existing.length > 0) return { status: 'error', message: 'A cancellation request is already pending for this plan.' };

  // Get plan card + client info
  const { data: pc } = await sb.from('plan_cards').select('client_id, location_id, plan_name, friendly_name, company_id').eq('plan_card_id', planCardId).maybeSingle();
  if (!pc) return { status: 'error', message: 'Plan card not found' };
  const { data: cl } = await sb.from('clients').select('given_name, family_name, email').eq('id', pc.client_id).maybeSingle();
  const clientName = cl ? [cl.given_name, cl.family_name].filter(Boolean).join(' ') || cl.email : 'Client';
  const planLabel = pc.friendly_name || pc.plan_name || planCardId;

  // Count pending mail items (include client_id for RLS)
  const { count: pendingMail } = await sb.from('mail_log').select('mail_id', { count: 'exact', head: true })
    .eq('plan_card_id', planCardId).eq('client_id', pc.client_id).in('status', ['ready_for_pickup', 'confidential_pickup', 'received']);
  const { count: fwdQueue } = await sb.from('mail_log').select('mail_id', { count: 'exact', head: true })
    .eq('plan_card_id', planCardId).eq('client_id', pc.client_id).eq('status', 'forwarding_queued');

  // Create task
  const taskId = 'TSK' + Date.now().toString(36).toUpperCase();
  const descLines = [
    'Reason: ' + (reason || 'Not specified'),
    details ? 'Details: ' + details : null,
    'Pending pickup: ' + (pendingMail || 0) + ' items',
    'Forwarding queue: ' + (fwdQueue || 0) + ' items',
    'Plan: ' + planLabel,
    'Plan Card ID: ' + planCardId
  ].filter(Boolean).join('\n');

  // Due next day (Toronto). Mirrors the id_verification due-date pattern:
  // _localToday() is Toronto 'YYYY-MM-DD'; add one day via UTC arithmetic
  // (no TZ ambiguity for a pure date) and return as a 'YYYY-MM-DD' string.
  const _crDue = (() => {
    const [y, m, d] = _localToday().split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().split('T')[0];
  })();

  const { error: taskError } = await sb.from('tasks').insert({
    task_id: taskId,
    company_id: pc.company_id,
    type: 'cancellation_request',
    notes: 'Cancellation Request \u2014 ' + clientName + ' (' + planLabel + ')',
    description: descLines,
    priority: 'high',
    status: 'open',
    location_id: pc.location_id,
    client_id: pc.client_id,
    plan_card_id: planCardId,
    due_date: _crDue,
    created_at: new Date().toISOString()
  });
  if (taskError) return { status: 'error', message: 'Failed to create task: ' + taskError.message };

  // Notify staff at location
  if (pc.location_id) {
    const msg = clientName + ' has requested cancellation of ' + planLabel + '. Reason: ' + (reason || 'Not specified');
    await _notifyStaffAtLocation(pc.location_id, 'cancellation_request', 'Cancellation Request', msg, 'tasks', taskId, pc.client_id);
    await _notifyAdminsAtLocation(pc.location_id, 'cancellation_request', 'Cancellation Request', msg, 'tasks', taskId, pc.client_id);
  }

  // Audit log \u2014 client-initiated
  await _audit({ clientName, action: 'cancellation_requested', entityType: 'plan_card', entityId: planCardId, clientId: pc.client_id, planCardId, locationId: pc.location_id, summary: clientName + ' requested cancellation of ' + planLabel + ' \u2014 Reason: ' + (reason || 'Not specified') });

  return { status: 'ok', taskId };
}

async function _withdrawCancellation(body) {
  const { planCardId, uuid } = body;
  if (!planCardId || !uuid) return { status: 'error', message: 'Missing planCardId or uuid' };

  // Find ONLY open cancellation task (not in_progress \u2014 staff already claimed it)
  const { data: task } = await sb.from('tasks').select('task_id, location_id, client_id, status')
    .eq('plan_card_id', planCardId).eq('type', 'cancellation_request')
    .eq('status', 'open').maybeSingle();
  if (!task) return { status: 'error', message: 'Cancellation request cannot be withdrawn \u2014 it has already been assigned to staff.' };

  // Delete the task + any comments
  await sb.from('task_comments').delete().eq('task_id', task.task_id);
  await sb.from('tasks').delete().eq('task_id', task.task_id);

  // Audit log \u2014 client-initiated
  const { data: cl } = await sb.from('clients').select('given_name, family_name, email').eq('id', task.client_id).maybeSingle();
  const clientName = cl ? [cl.given_name, cl.family_name].filter(Boolean).join(' ') || cl.email : 'Client';
  await _audit({ clientName, action: 'cancellation_withdrawn', entityType: 'plan_card', entityId: planCardId, clientId: task.client_id, summary: clientName + ' withdrew cancellation request' });

  // Notify staff
  if (task.location_id) {
    const msg = clientName + ' has withdrawn their cancellation request and decided to keep the plan.';
    await _notifyStaffAtLocation(task.location_id, 'cancellation_withdrawn', 'Cancellation Withdrawn', msg, null, null, task.client_id);
  }

  return { status: 'ok' };
}

// Stripe key helper -- returns correct keys based on stripe_mode config (per company)
// TENANT ISOLATION: Stripe keys are per-company secrets. No fallback company and
// no unscoped read — a guessed/blended tenant here means charging the WRONG
// Stripe account. Caller MUST pass a real companyId; absent = loud throw.
async function _getStripeKeys(companyId) {
  const cid = companyId;
  if (!cid) throw new Error('_getStripeKeys: company is required (no fallback)');
  const { data: rows } = await sb.from('config').select('key, value')
    .eq('company_id', cid)
    .in('key', ['stripe_mode', 'stripe_secret_key', 'stripe_publishable_key', 'stripe_webhook_secret',
                'stripe_test_secret_key', 'stripe_test_publishable_key', 'stripe_test_webhook_secret']);
  const cfg = {};
  for (const r of (rows || [])) cfg[r.key] = r.value;
  const mode = cfg.stripe_mode || 'live';
  return {
    mode,
    secretKey:      mode === 'test' ? (cfg.stripe_test_secret_key     || '') : (cfg.stripe_secret_key     || ''),
    publishableKey: mode === 'test' ? (cfg.stripe_test_publishable_key || '') : (cfg.stripe_publishable_key || ''),
    webhookSecret:  mode === 'test' ? (cfg.stripe_test_webhook_secret  || '') : (cfg.stripe_webhook_secret  || ''),
  };
}

async function _reactivateAccount(body) {
  const { uuid, clientId, notes } = body;
  if (!uuid || !clientId) return { status: 'error', message: 'Missing required fields' };
  const _coId = await _companyIdFor(uuid, false);
  if (!_coId) return { status: 'error', message: 'Something went wrong, please try again.' };
  _setEmailCompany(_coId);

  // Only admins can reactivate
  const { data: staffRow } = await sb.from('staff').select('name, role').eq('staff_id', uuid).maybeSingle();
  if (staffRow?.role !== 'admin') return { status: 'error', message: 'Only admins can reactivate accounts' };
  const staffName = staffRow?.name || uuid;

  const now = new Date().toISOString();

  // Get Stripe config (company-scoped — no fallback)
  const { secretKey: stripeKey } = await _getStripeKeys(_coId);

  // Get subscription
  const { data: subRow } = await sb.from('subscriptions')
    .select('id, stripe_subscription_id, access_status')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let stripeResult = 'no_action';

  // Hard block: no Stripe subscription ID means no active billing exists
  if (!subRow?.stripe_subscription_id || !stripeKey) {
    return { status: 'error', message: 'No active Stripe subscription found. A new subscription must be created before reactivating.' };
  }

  // Fetch Stripe subscription with latest invoice expanded
  let stripeSub = null;
  try {
    const subRes = await fetch(
      'https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subRow.stripe_subscription_id) + '?expand[]=latest_invoice',
      { headers: { 'Authorization': 'Bearer ' + stripeKey } }
    );
    stripeSub = await subRes.json();
  } catch(e) {
    return { status: 'error', message: 'Could not reach Stripe to verify payment status. Please try again.' };
  }

  // Hard block: subscription deleted in Stripe
  if (!stripeSub || stripeSub.status === 'canceled' || stripeSub.error) {
    return { status: 'error', message: 'This subscription has been fully cancelled in Stripe. A new subscription must be created before reactivating.' };
  }

  // Payment check: block if latest invoice is unpaid
  const invoiceStatus = stripeSub.latest_invoice?.status;
  if (invoiceStatus === 'open' || invoiceStatus === 'uncollectible') {
    if (!body.forceReactivate) {
      return {
        status: 'payment_warning',
        message: 'This client has an unpaid invoice on their Stripe subscription. Reactivating will restore access without collecting the owed amount.',
        invoiceStatus,
        invoiceUrl: stripeSub.latest_invoice?.hosted_invoice_url || null
      };
    }
    // forceReactivate=true \u2014 admin confirmed override
    stripeResult = 'overridden_unpaid';
  }

  if (stripeSub.status === 'active' && stripeSub.cancel_at_period_end) {
    // Cancel at period end was set \u2014 remove it (un-cancel)
    await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subRow.stripe_subscription_id), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + stripeKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'cancel_at_period_end=false'
    });
    stripeResult = stripeResult || 'uncancelled';
  } else if (stripeSub.status === 'active') {
    stripeResult = stripeResult || 'still_active';
  } else if (stripeSub.status === 'past_due') {
    stripeResult = stripeResult || 'past_due';
  }

  // Update subscription status in DB
  // Update subscription - use subRow.id for reliability
  if (subRow?.id) {
    await sb.from('subscriptions')
      .update({ access_status: 'ACTIVE', access_until_date: null })
      .eq('id', String(subRow.id))
      .select();
  }

  // Clear account lock
  await sb.from('clients').update({
    access_override:  null,
    override_reason:  null,
    override_by:      null,
    override_at:      null,
    fraud_flag:       false
  }).eq('id', clientId);

  // Clear all plan card locks for this client
  await sb.from('plan_cards').update({
    access_override:  null,
    override_reason:  null,
    override_by:      null,
    override_at:      null
  }).eq('client_id', clientId);

  // Resolve any open cancellation request tasks for this client
  await sb.from('tasks')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_note: '[REACTIVATED] Account reactivated by ' + staffName + ' \u2014 cancellation withdrawn'
    })
    .eq('client_id', clientId)
    .eq('type', 'cancellation_request')
    .in('status', ['open', 'in_progress', 'snoozed']);

  // Audit log
  await _audit({
    staffId:    uuid,
    staffName,
    action:     'account_reactivated',
    entityType: 'client',
    entityId:   clientId,
    clientId,
    summary:    'Account reactivated by ' + staffName +
                (notes ? ' \u2014 Notes: ' + notes : '') +
                ' | Stripe: ' + stripeResult
  });

  // Notify client
  await _createNotification('client', clientId, 'cancellation_withdrawn',
    'Account Reactivated',
    'Your account has been reactivated. You now have full access to your portal.',
    null, null, null);

  // Email client
  if (await _isEmailEnabled('cancellation_withdrawn', 'client')) {
    const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', clientId).maybeSingle();
    if (cl?.email) {
      const name = cl.given_name || 'there';
      const _tpl = await _resolveTemplate('cancellation_withdrawn', { name });
      await _sendEmail(cl.email, _tpl.subject, await _emailHtml(_tpl.subject, _tpl.bodyHtml, _tpl.ctaEnabled ? _tpl.ctaLabel : '', _tpl.ctaEnabled ? _tpl.ctaUrl : ''));
    }
  }

  return { status: 'ok', stripeResult };
}

async function _terminateAccount(body) {
  const { uuid, clientId, planCardId, reason, notes, immediate, isFraud } = body;
  if (!uuid || !clientId) return { status: 'error', message: 'Missing required fields' };
  const _coId = await _companyIdFor(uuid, false);
  if (!_coId) return { status: 'error', message: 'Something went wrong, please try again.' };
  _setEmailCompany(_coId);

  // Get staff info
  const { data: staffRow } = await sb.from('staff').select('name, role').eq('staff_id', uuid).maybeSingle();
  const staffName = staffRow?.name || uuid;
  const isAdmin   = staffRow?.role === 'admin';

  // Fraud termination is admin-only
  if (isFraud && !isAdmin) return { status: 'error', message: 'Fraud termination requires admin role' };

  // Get subscription
  // Get most recent subscription \u2014 no status filter so we always find it
  const { data: subRow } = await sb.from('subscriptions')
    .select('id, stripe_subscription_id, access_status, plan_name')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Get Stripe key (company-scoped — no fallback)
  const { secretKey: cfgStripeKey } = await _getStripeKeys(_coId);
  const cfgRow = { value: cfgStripeKey };

  // Cancel Stripe subscription
  let stripeCancelled = false;
  let stripeAccessUntil = null;
  if (subRow?.stripe_subscription_id && cfgRow?.value) {
    try {
      if (immediate || isFraud) {
        // Immediate cancellation
        await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subRow.stripe_subscription_id), {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + cfgRow.value }
        });
      } else {
        // Cancel at period end
        const stripeRes = await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subRow.stripe_subscription_id), {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cfgRow.value, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'cancel_at_period_end=true'
        });
        const stripeSubData = await stripeRes.json();
        if (stripeSubData.current_period_end) {
          stripeAccessUntil = new Date(stripeSubData.current_period_end * 1000).toISOString().split('T')[0];
        }
      }
      stripeCancelled = true;
    } catch(e) {
      console.error('Stripe termination error:', e);
    }
  }

  // Update subscription status in DB
  const newStatus = immediate || isFraud ? 'CANCELED' : 'CANCELED_WITH_ACCESS';
  const subUpdate = { access_status: newStatus };
  if (stripeAccessUntil) subUpdate.access_until_date = stripeAccessUntil;

  if (subRow?.id) {
    // access_until_date is timestamptz \u2014 convert date string to ISO timestamp
    if (subUpdate.access_until_date) {
      subUpdate.access_until_date = subUpdate.access_until_date + 'T23:59:59.000Z';
    }
    const { error: subErr } = await sb.from('subscriptions')
      .update(subUpdate)
      .eq('id', String(subRow.id))
      .select();
    if (subErr) console.error('Sub update error:', subErr.message);
  }

  const now = new Date().toISOString();

  // Only lock the account immediately for immediate/fraud terminations
  // For period-end, client keeps access until billing period ends \u2014 no lock needed
  if (immediate || isFraud) {
    await sb.from('clients').update({
      access_override:         'suspended',
      override_reason:         reason + (notes ? ' \u2014 ' + notes : ''),
      override_by:             uuid,
      override_at:             now,
      ...(isFraud ? { fraud_flag: true } : {})
    }).eq('id', clientId);

    // Lock all active plan cards
    if (planCardId) {
      await sb.from('plan_cards').update({
        access_override:  'suspended',
        override_reason:  reason + (notes ? ' \u2014 ' + notes : ''),
        override_by:      uuid,
        override_at:      now
      }).eq('plan_card_id', planCardId);
    } else {
      await sb.from('plan_cards').update({
        access_override:  'suspended',
        override_reason:  reason + (notes ? ' \u2014 ' + notes : ''),
        override_by:      uuid,
        override_at:      now
      }).eq('client_id', clientId).eq('status', 'active');
    }
  }

  // Resolve any open payment_failed tasks \u2014 cancellation is the resolution
  await sb.from('tasks')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_note: '[TERMINATED] Account terminated by ' + staffName + ' \u2014 payment issue resolved via cancellation'
    })
    .eq('client_id', clientId)
    .eq('type', 'payment_failed')
    .in('status', ['open', 'in_progress', 'snoozed']);

  // Audit log
  await _audit({
    staffId:    uuid,
    staffName,
    action:     isFraud ? 'account_terminated_fraud' : 'account_terminated',
    entityType: 'client',
    entityId:   clientId,
    clientId,
    planCardId: planCardId || null,
    summary:    (isFraud ? '[FRAUD] ' : '') + 'Account terminated by ' + staffName +
                ' \u2014 Reason: ' + reason +
                (notes ? ' | Notes: ' + notes : '') +
                (stripeCancelled ? ' | Stripe: ' + (immediate || isFraud ? 'Cancelled immediately' : 'Cancel at period end') : ' | Stripe: manual required')
  });

  // Notify client \u2014 only if not fraud
  if (!isFraud) {
    await _createNotification('client', clientId, 'cancellation_processed',
      'Account Terminated',
      'Your account has been terminated. ' + (immediate || isFraud ? 'Access has been removed.' : 'You will retain access until the end of your current billing period.') +
      ' If you believe this is an error, please contact us.',
      null, null, null);

    // Send email
    if (await _isEmailEnabled('cancellation_processed', 'client')) {
      const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', clientId).maybeSingle();
      if (cl?.email) {
        const name = cl.given_name || 'there';
        const termBody = 'Hi ' + name + ',\n\nYour account has been terminated.' +
          (immediate ? '\n\nAccess has been removed immediately.' : '\n\nYou will retain access until the end of your current billing period.') +
          '\n\nReason: ' + reason +
          '\n\nIf you believe this is an error, please contact us directly.';
        const termHtml = termBody.split('\n\n').map(function(p){ return '<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">' + p + '</p>'; }).join('');
        await _sendEmail(cl.email, 'Important: Account Terminated', await _emailHtml('Account Terminated', termHtml, '', ''));
      }
    }
  }

  // Notify all admins if fraud
  if (isFraud) {
    const { data: admins } = await sb.from('staff').select('staff_id').eq('role', 'admin').eq('active', true);
    for (const admin of (admins || [])) {
      await _createNotification('staff', admin.staff_id, 'broadcast',
        '\u26A0\uFE0F Fraud Termination',
        'Account terminated for fraud by ' + staffName + '. Client ID: ' + clientId + (notes ? ' \u2014 ' + notes : ''),
        null, null, null);
    }
  }

  return { status: 'ok', stripeCancelled };
}

async function _resolveCancellation(body) {
  const { taskId, uuid, outcome } = body;
  // outcome: 'processed' or 'kept_plan'
  if (!taskId || !uuid || !outcome) return { status: 'error', message: 'Missing required fields' };
  const _coId = await _companyIdFor(uuid, false);
  if (!_coId) return { status: 'error', message: 'Something went wrong, please try again.' };
  _setEmailCompany(_coId);

  const { data: task } = await sb.from('tasks').select('task_id, client_id, plan_card_id, location_id, status')
    .eq('task_id', taskId).eq('type', 'cancellation_request').maybeSingle();
  if (!task) return { status: 'error', message: 'Cancellation task not found' };
  // Idempotency guard: if already resolved (e.g. a double-click / double-submit),
  // do nothing more. Prevents duplicate audit-trail entries, repeat Stripe
  // cancel calls, and duplicate client notifications/emails.
  if (task.status === 'resolved') return { status: 'ok', alreadyResolved: true };

  const resNote = outcome === 'processed'
    ? '[PROCESSED] Cancellation processed by staff'
    : '[KEPT_PLAN] Client decided to keep the plan';

  await sb.from('tasks').update({
    status: 'resolved',
    resolved_at: new Date().toISOString(),
    resolved_by: uuid,
    resolution_note: resNote
  }).eq('task_id', taskId);

  // If processed \u2014 cancel subscription in Stripe at period end
  if (outcome === 'processed') {
    try {
      // Get subscription stripe ID
      const { data: subRow } = await sb.from('subscriptions')
        .select('id, stripe_subscription_id')
        .eq('client_id', task.client_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (subRow?.id) {
        const { secretKey: _stripeKey3 } = await _getStripeKeys(_coId);
        const cfgRow = { value: _stripeKey3 };

        if (cfgRow?.value) {
          // Set cancel_at_period_end = true in Stripe
          const resolveStripeRes = await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subRow.stripe_subscription_id), {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + cfgRow.value,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'cancel_at_period_end=true'
          });
          const resolveStripeSub = await resolveStripeRes.json();
          const resolveAccessUntil = resolveStripeSub.current_period_end
            ? new Date(resolveStripeSub.current_period_end * 1000).toISOString().split('T')[0]
            : null;

          // Update subscriptions table
          const resolveSubUpdate = { access_status: 'CANCELED_WITH_ACCESS' };
          if (resolveAccessUntil) resolveSubUpdate.access_until_date = resolveAccessUntil;
          // Fix access_until_date to timestamptz format
          if (resolveSubUpdate.access_until_date) {
            resolveSubUpdate.access_until_date = resolveSubUpdate.access_until_date + 'T23:59:59.000Z';
          }
          if (subRow?.id) {
            await sb.from('subscriptions')
              .update(resolveSubUpdate)
              .eq('id', String(subRow.id))
              .select();
          }
        }
      }
    } catch(stripeErr) {
      console.error('Stripe cancel error:', stripeErr);
      // Don't fail the whole operation \u2014 task is resolved, Stripe can be done manually
    }
  }

  // Get staff name for audit
  const { data: staff } = await sb.from('staff').select('name').eq('staff_id', uuid).maybeSingle();
  const staffName = staff?.name || uuid;

  const auditSummary = outcome === 'processed'
    ? 'Cancellation processed by ' + staffName
    : 'Client kept plan \u2014 resolved by ' + staffName;
  await _audit({ staffId: uuid, staffName, action: 'cancellation_resolved', entityType: 'task', entityId: taskId, clientId: task.client_id, planCardId: task.plan_card_id, summary: auditSummary });

  // Notify client
  if (task.client_id) {
    if (outcome === 'processed') {
      await _createNotification('client', task.client_id, 'cancellation_processed',
        'Cancellation Request Processed',
        'Your cancellation request has been processed. Your plan will end at the conclusion of your current billing period.',
        'plans', null, taskId);
      // Email
      if (await _isEmailEnabled('cancellation_processed', 'client')) {
        const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', task.client_id).maybeSingle();
        if (cl?.email) {
          const name = cl.given_name || 'there';
          const _tpl5 = await _resolveTemplate('cancellation_processed', { name });
          await _sendEmail(cl.email, _tpl5.subject, await _emailHtml(_tpl5.subject, _tpl5.bodyHtml, _tpl5.ctaEnabled ? _tpl5.ctaLabel : '', _tpl5.ctaEnabled ? _tpl5.ctaUrl : ''));
        }
      }
    } else {
      await _createNotification('client', task.client_id, 'cancellation_withdrawn',
        'Cancellation Request Closed',
        'Your cancellation request has been closed. Your plan remains active.',
        null, null, taskId);
      // Email
      if (await _isEmailEnabled('cancellation_withdrawn', 'client')) {
        const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', task.client_id).maybeSingle();
        if (cl?.email) {
          const name = cl.given_name || 'there';
          const _tpl6 = await _resolveTemplate('cancellation_withdrawn', { name });
          await _sendEmail(cl.email, _tpl6.subject, await _emailHtml(_tpl6.subject, _tpl6.bodyHtml, _tpl6.ctaEnabled ? _tpl6.ctaLabel : '', _tpl6.ctaEnabled ? _tpl6.ctaUrl : ''));
        }
      }
    }
  }

  return { status: 'ok' };
}

async function _reverseCancellation(body) {
  const { taskId, uuid } = body;
  if (!taskId || !uuid) return { status: 'error', message: 'Missing required fields' };

  const { data: task } = await sb.from('tasks').select('task_id, client_id, plan_card_id, location_id, resolution_note, status')
    .eq('task_id', taskId).eq('type', 'cancellation_request').maybeSingle();
  if (!task) return { status: 'error', message: 'Cancellation task not found' };
  if (task.status !== 'resolved') return { status: 'error', message: 'Task is not resolved' };

  // Reopen the task
  await sb.from('tasks').update({
    status: 'open',
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    assigned_to: null
  }).eq('task_id', taskId);

  // Audit
  const { data: staff } = await sb.from('staff').select('name').eq('staff_id', uuid).maybeSingle();
  const staffName = staff?.name || uuid;
  await _audit({ staffId: uuid, staffName, action: 'cancellation_reversed', entityType: 'task', entityId: taskId, clientId: task.client_id, planCardId: task.plan_card_id, summary: 'Cancellation reversal \u2014 reopened by ' + staffName });

  // Notify client
  if (task.client_id) {
    await _createNotification('client', task.client_id, 'cancellation_withdrawn',
      'Cancellation Reversed',
      'Your cancellation has been reversed. Your plan remains active.',
      'plans', null, taskId);
  }

  return { status: 'ok' };
}
// ============================================================

// ============================================================
// STAFF READS
// ============================================================

async function _getTasks(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, role, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const isAdmin = staff?.role === 'admin';
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', tasks: [] };

  let tasksQ = sb.from('tasks').select('*')
    .in('status', ['open', 'in_progress', 'snoozed', 'resolved'])
    .eq('company_id', companyId);
  const { data } = await tasksQ.order('created_at', { ascending: false });

  const filtered = (data || []).filter(t => {
    if (t.location_id && t.location_id !== locId) return false;
    // Resolved tasks: only show if resolved by this user
    // Resolved: show if resolved by this user, OR assigned to this user, OR unassigned (system auto-resolved)
    if (t.status === 'resolved' && t.resolved_by !== uuid && t.assigned_to !== uuid && t.assigned_to !== null) return false;
    // Other tasks: only show unassigned or assigned to this user
    if (t.status !== 'resolved' && !isAdmin && t.assigned_to && t.assigned_to !== uuid) return false;
    return true;
  });

  // Auto-unsnoooze: if snooze period has passed, update DB and mark as open
  for (const t of filtered) {
    if (t.status === 'snoozed' && t.snoozed_until && new Date(t.snoozed_until) <= new Date()) {
      await sb.from('tasks').update({ status: 'open', snoozed_until: null }).eq('task_id', t.task_id);
      t.status = 'open';
      t.snoozed_until = null;
    }
  }

  const pOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  filtered.sort((a, b) => {
    const pa = pOrder[a.priority] ?? 2;
    const pb = pOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  // Batch fetch comment counts + views in parallel
  const taskIds = filtered.map(t => t.task_id);
  const commentCounts = {};
  const latestCommentAt = {};
  const viewedAt = {};
  if (taskIds.length) {
    const [commentsRes, viewsRes] = await Promise.all([
      sb.from('task_comments').select('task_id, created_at').in('task_id', taskIds),
      sb.from('task_views').select('task_id, viewed_at').eq('staff_id', uuid).in('task_id', taskIds)
    ]);
    (commentsRes.data || []).forEach(c => {
      commentCounts[c.task_id] = (commentCounts[c.task_id] || 0) + 1;
      if (!latestCommentAt[c.task_id] || c.created_at > latestCommentAt[c.task_id]) latestCommentAt[c.task_id] = c.created_at;
    });
    (viewsRes.data || []).forEach(v => { viewedAt[v.task_id] = v.viewed_at; });
  }
  const result = rowsToCamel(filtered);
  result.forEach(t => {
    t.commentCount = commentCounts[t.taskId] || 0;
    const lastComment = latestCommentAt[t.taskId];
    const lastView = viewedAt[t.taskId];
    t.hasUnread = !!(lastComment && (!lastView || lastComment > lastView));
  });

  // Backfill client names (tasks table has no name columns) so the UI can
  // display and search by client name without a per-task lookup.
  const _clientIds = [...new Set(result.map(t => t.clientId).filter(Boolean))];
  if (_clientIds.length) {
    const { data: _clients } = await sb.from('clients')
      .select('id, given_name, family_name').in('id', _clientIds);
    const _nameMap = {};
    for (const c of (_clients || [])) {
      _nameMap[c.id] = [c.given_name, c.family_name].filter(Boolean).join(' ');
    }
    result.forEach(t => { if (t.clientId && _nameMap[t.clientId]) t.clientName = _nameMap[t.clientId]; });
  }

  // Backfill resolver staff names so the UI shows "Resolved by <name>" rather
  // than a raw staff UUID (or nothing). Mirrors the client-name backfill above.
  const _resolverIds = [...new Set(result.map(t => t.resolvedBy).filter(Boolean))];
  if (_resolverIds.length) {
    const { data: _resolvers } = await sb.from('staff')
      .select('staff_id, name').in('staff_id', _resolverIds);
    const _resolverMap = {};
    for (const s of (_resolvers || [])) { _resolverMap[s.staff_id] = s.name; }
    result.forEach(t => { if (t.resolvedBy && _resolverMap[t.resolvedBy]) t.resolvedByName = _resolverMap[t.resolvedBy]; });
  }

  return { status: 'ok', tasks: result };
}

async function _getAllTasks(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id, role')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  const isAdmin = staff?.role === 'admin';
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', tasks: [] };
  let allQ = sb.from('tasks').select('*').eq('company_id', companyId);
  const { data } = await allQ.order('created_at', { ascending: false }).limit(500);
  const filtered = isAdmin ? (data || []) : (data || []).filter(t => !t.location_id || t.location_id === locId);
  return { status: 'ok', tasks: rowsToCamel(filtered) };
}

async function _createTask(body) {
  const { data: staff } = await sb.from('staff').select('default_location_id, name, role, company_id')
    .eq('staff_id', body.uuid).maybeSingle();
  _setEmailCompany(staff?.company_id);

  // Staff auto-assigns to themselves unless they explicitly assign to someone else
  // Admin can assign to anyone or leave unassigned
  let assignedTo = body.assignedTo || null;
  if (!assignedTo && staff?.role === 'staff') {
    assignedTo = body.uuid; // Staff tasks default to self
  }

  // Derive client_id from the attached plan card when not explicitly provided,
  // so manually-created tasks carry the owning client (used for navigation, filtering, etc).
  let resolvedClientId = body.clientId || null;
  if (!resolvedClientId && body.planCardId) {
    const { data: _pcOwner } = await sb.from('plan_cards')
      .select('client_id').eq('plan_card_id', body.planCardId).maybeSingle();
    if (_pcOwner?.client_id) resolvedClientId = _pcOwner.client_id;
  }

  const task = {
    task_id: 'TSK' + Date.now().toString(36).toUpperCase(),
    company_id: staff?.company_id || null,
    type: body.type || 'manual',
    notes: body.title,
    description: body.description || null,
    priority: body.priority || 'medium',
    status: 'open',
    location_id: body.locationId || staff?.default_location_id || null,
    client_id: resolvedClientId,
    plan_card_id: body.planCardId || null,
    mail_id: body.mailId || null,
    assigned_to: assignedTo,
    created_by: body.uuid,
    due_date: body.dueDate || null,
    checklist: body.checklist || null,
    recurring_config: body.recurringConfig || null,
    created_at: new Date().toISOString()
  };
  const { error } = await sb.from('tasks').insert(task);
  if (error) {
    let msg = error.message;
    if (msg.includes('tasks_mail_id_fkey')) msg = 'The Mail ID entered does not exist. Please check and try again.';
    else if (msg.includes('tasks_plan_card_id_fkey')) msg = 'The Plan Card ID entered does not exist. Please check and try again.';
    else if (msg.includes('tasks_client_id_fkey')) msg = 'The Client ID entered does not exist. Please check and try again.';
    else if (msg.includes('foreign key')) msg = 'One of the linked IDs (Mail, Plan Card, or Client) is invalid. Please verify and try again.';
    return { status: 'error', message: msg };
  }
  await _audit({ staffId: body.uuid, staffName: staff?.name, action: 'task_created', entityType: 'task', entityId: task.task_id, clientId: task.client_id, summary: 'Task created: ' + (body.title || '') });
  // Notify assigned staff
  if (assignedTo && assignedTo !== body.uuid) {
    await _createNotification('staff', assignedTo, 'task_assigned', 'New task assigned to you', body.title || 'A new task needs your attention', 'tasks', task.task_id);
    // Email
    if (await _isEmailEnabled('task_assigned', 'staff')) {
      const { data: st } = await sb.from('staff').select('email, name').eq('staff_id', assignedTo).maybeSingle();
      if (st?.email) {
        const _tpl3 = await _resolveTemplate('task_assigned', {
          name: st.name || 'there', task_title: body.title || 'Untitled task'
        });
        await _sendEmail(st.email, _tpl3.subject, await _emailHtml(_tpl3.subject, _tpl3.bodyHtml, _tpl3.ctaEnabled ? _tpl3.ctaLabel : '', _tpl3.ctaEnabled ? _tpl3.ctaUrl : ''));
      }
    }
  }
  return { status: 'ok', taskId: task.task_id };
}

async function _updateTask(body) {
  _setEmailCompany(await _companyIdFor(body.uuid, false));
  const updates = {};
  if (body.title !== undefined) updates.notes = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.assignedTo !== undefined) updates.assigned_to = body.assignedTo;
  if (body.dueDate !== undefined) updates.due_date = body.dueDate;
  if (body.status !== undefined) updates.status = body.status;
  if (body.checklist !== undefined) updates.checklist = body.checklist;
  if (body.mailId !== undefined) updates.mail_id = body.mailId || null;
  if (body.planCardId !== undefined) updates.plan_card_id = body.planCardId || null;
  // Notify on reassignment
  if (body.assignedTo && body.assignedTo !== body.uuid) {
    const { data: oldTask } = await sb.from('tasks').select('assigned_to, notes').eq('task_id', body.taskId).maybeSingle();
    if (oldTask && body.assignedTo !== oldTask.assigned_to) {
      await _createNotification('staff', body.assignedTo, 'task_assigned', 'Task assigned to you', oldTask.notes || 'A task has been assigned to you', 'tasks', body.taskId);
      // Email on reassignment
      if (await _isEmailEnabled('task_assigned', 'staff')) {
        const { data: st } = await sb.from('staff').select('email, name').eq('staff_id', body.assignedTo).maybeSingle();
        if (st?.email) {
          const _tplR = await _resolveTemplate('task_assigned', {
            name: st.name || 'there', task_title: oldTask.notes || 'A task'
          });
          await _sendEmail(st.email, _tplR.subject, await _emailHtml(_tplR.subject, _tplR.bodyHtml, _tplR.ctaEnabled ? _tplR.ctaLabel : '', _tplR.ctaEnabled ? _tplR.ctaUrl : ''));
        }
      }
    }
  }
  const { error } = await sb.from('tasks').update(updates).eq('task_id', body.taskId);
  if (error) {
    let msg = error.message;
    if (msg.includes('tasks_mail_id_fkey')) msg = 'The Mail ID entered does not exist. Please check and try again.';
    else if (msg.includes('tasks_plan_card_id_fkey')) msg = 'The Plan Card ID entered does not exist. Please check and try again.';
    else if (msg.includes('foreign key')) msg = 'One of the linked IDs is invalid. Please verify and try again.';
    return { status: 'error', message: msg };
  }
  await _audit({ staffId: body.uuid, action: 'task_updated', entityType: 'task', entityId: body.taskId, summary: 'Task updated: ' + body.taskId + (body.title ? ' \u2014 ' + body.title : '') });
  return { status: 'ok' };
}

async function _claimTask(body) {
  const { error } = await sb.from('tasks').update({ assigned_to: body.uuid, status: 'in_progress' }).eq('task_id', body.taskId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: 'task_claimed', entityType: 'task', entityId: body.taskId, summary: 'Task claimed by ' + body.uuid });
  return { status: 'ok' };
}

async function _getTaskComments(body) {
  // TENANT ISOLATION: resolve caller's company and confirm the task is in-company
  // before returning its comments (defense even if taskId is forged cross-tenant).
  const { data: staff } = await sb.from('staff').select('company_id')
    .eq('staff_id', body.uuid).maybeSingle();
  const companyId = staff?.company_id;
  if (!companyId) return { status: 'ok', comments: [] };
  const { data: task } = await sb.from('tasks').select('task_id')
    .eq('task_id', body.taskId).eq('company_id', companyId).maybeSingle();
  if (!task) return { status: 'ok', comments: [] };
  const { data } = await sb.from('task_comments').select('*')
    .eq('task_id', body.taskId).eq('company_id', companyId).order('created_at');
  return { status: 'ok', comments: (data || []).map(c => ({ commentId: c.comment_id, taskId: c.task_id, staffId: c.staff_id, staffName: c.staff_name, content: c.content, createdAt: c.created_at })) };
}

async function _addTaskComment(body) {
  const { data: staff } = await sb.from('staff').select('name, company_id').eq('staff_id', body.uuid).maybeSingle();
  const comment = {
    comment_id: 'TC' + Date.now().toString(36).toUpperCase(),
    company_id: staff?.company_id || null,
    task_id: body.taskId,
    staff_id: body.uuid,
    staff_name: staff?.name || body.uuid,
    content: body.content,
    created_at: new Date().toISOString()
  };
  const { error } = await sb.from('task_comments').insert(comment);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, staffName: staff?.name, action: 'task_comment', entityType: 'task', entityId: body.taskId, summary: 'Comment on task: ' + body.content.slice(0, 60) });
  // Notify assigned staff + task creator (if different from commenter)
  const { data: task } = await sb.from('tasks').select('assigned_to, created_by, notes').eq('task_id', body.taskId).maybeSingle();
  const notified = new Set();
  const commentMsg = (staff?.name || 'Someone') + ': ' + body.content.slice(0, 80);
  // Notify assigned staff
  if (task?.assigned_to && task.assigned_to !== body.uuid && !notified.has(task.assigned_to)) {
    await _createNotification('staff', task.assigned_to, 'task_comment', 'New comment on your task', commentMsg, 'tasks', body.taskId);
    notified.add(task.assigned_to);
  }
  // Notify task creator (could be admin)
  if (task?.created_by && task.created_by !== body.uuid && !notified.has(task.created_by)) {
    // Check if creator is admin or staff
    const { data: creator } = await sb.from('staff').select('role').eq('staff_id', task.created_by).maybeSingle();
    const recipType = creator?.role === 'admin' ? 'admin' : 'staff';
    await _createNotification(recipType, task.created_by, 'task_comment', 'New comment on task', commentMsg, 'tasks', body.taskId);
  }
  return { status: 'ok', comment };
}

async function _createIdVerificationTask(clientId, clientName, locationId) {
  const existing = await sb.from('tasks').select('task_id').eq('client_id', clientId).eq('type', 'id_verification').eq('status', 'open').maybeSingle();
  if (existing?.data) return;
  const { data: _ivClient } = await sb.from('clients').select('company_id').eq('id', clientId).maybeSingle();
  // Due 24 hours out (next day, Toronto time). _localToday() is Toronto
  // 'YYYY-MM-DD'; add one day using UTC arithmetic (no TZ ambiguity for a pure
  // date) and return as a 'YYYY-MM-DD' date string.
  const _ivDue = (() => {
    const [y, m, d] = _localToday().split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().split('T')[0];
  })();
  await sb.from('tasks').insert({
    task_id: 'TSK' + Date.now().toString(36).toUpperCase(),
    company_id: _ivClient ? _ivClient.company_id : null,
    type: 'id_verification', notes: 'Review ID \u2014 ' + (clientName || 'Client'),
    priority: 'high', status: 'open', location_id: locationId,
    client_id: clientId, due_date: _ivDue, created_at: new Date().toISOString()
  });
}

async function _createPaymentFailedTask(clientId, clientName, locationId, planCardId) {
  const _pfCompanyId = await _companyIdFor(clientId, true);
  _setEmailCompany(_pfCompanyId);
  // Check for ANY existing non-resolved task (open, in_progress, snoozed)
  const { data: existing } = await sb.from('tasks').select('task_id')
    .eq('client_id', clientId).eq('type', 'payment_failed')
    .in('status', ['open', 'in_progress', 'snoozed']);

  let taskId;

  if (existing && existing.length > 0) {
    // Task exists (likely from DB trigger) \u2014 check if notifications already sent
    taskId = existing[0].task_id;
    const { data: existingNotif } = await sb.from('notifications').select('id')
      .eq('type', 'payment_failed').eq('related_id', taskId).limit(1);
    if (existingNotif && existingNotif.length > 0) return; // Already notified
  } else {
    // Create the task
    taskId = 'TSK' + Date.now().toString(36).toUpperCase();
    // Due next day (UTC), mirrors the stripe-webhook _pfDue + cancellation _crDue pattern:
    // today's UTC date + 1, returned as a 'YYYY-MM-DD' string.
    const _pfDue = (() => {
      const dt = new Date();
      dt.setUTCDate(dt.getUTCDate() + 1);
      return dt.toISOString().split('T')[0];
    })();
    const { error } = await sb.from('tasks').insert({
      task_id: taskId,
      company_id: _pfCompanyId || null,
      type: 'payment_failed', notes: 'Payment Failed \u2014 ' + (clientName || 'Client'),
      priority: 'urgent', status: 'open', location_id: locationId,
      client_id: clientId, plan_card_id: planCardId, due_date: _pfDue,
      created_by: 'system', created_at: new Date().toISOString()
    });
    if (error) return;
  }

  // Resolve client name if not provided
  if (!clientName && clientId) {
    const { data: cl } = await sb.from('clients').select('given_name, family_name, email').eq('id', clientId).maybeSingle();
    if (cl) clientName = [cl.given_name, cl.family_name].filter(Boolean).join(' ') || cl.email || 'Client';
  }

  // Notify staff + admin at location
  if (locationId) {
    const msg = 'Payment failed for ' + (clientName || 'a client') + '. Task created for follow-up.';
    await _notifyStaffAtLocation(locationId, 'payment_failed', 'Payment Failed', msg, 'tasks', taskId, clientId);
    await _notifyAdminsAtLocation(locationId, 'payment_failed', 'Payment Failed', msg, 'tasks', taskId, clientId);
  } else {
  }

  // Notify client \u2014 link to their plan tab
  if (clientId) {
    // Get subscription ID from plan card for navigation
    let subId = null;
    if (planCardId) {
      const { data: pcData } = await sb.from('plan_cards').select('subscription_id').eq('plan_card_id', planCardId).maybeSingle();
      subId = pcData?.subscription_id || null;
    }
    await _createNotification('client', clientId, 'payment_failed',
      'Payment Required',
      'Your payment could not be processed. Please update your payment method to maintain access.',
      'plans', subId, taskId);
    // Email
    if (await _isEmailEnabled('payment_failed', 'client')) {
      const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', clientId).maybeSingle();
      if (cl?.email) {
        const name = cl.given_name || 'there';
        const _tpl4 = await _resolveTemplate('payment_failed', { name });
        await _sendEmail(cl.email, _tpl4.subject, await _emailHtml(_tpl4.subject, _tpl4.bodyHtml, _tpl4.ctaEnabled ? _tpl4.ctaLabel : '', _tpl4.ctaEnabled ? _tpl4.ctaUrl : ''));
      }
    }
  }
}


async function _searchRecipients(uuid, q) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read across tenants.
  if (!companyId) return { status: 'ok', recipients: [] };

  const { data } = await sb.from('recipients')
    .select('*, plan_cards!inner(*)')
    .eq('company_id', companyId)
    .eq('location_id', locId)
    .in('status', ['active', 'inactive']);

  // Batch fetch client names
  const clientIds = [...new Set((data || []).map(r => r.plan_cards?.client_id).filter(Boolean))];
  const clientMap = {};
  if (clientIds.length) {
    const { data: clients } = await sb.from('clients').select('id, given_name, family_name, email').in('id', clientIds);
    for (const c of (clients || [])) {
      clientMap[c.id] = [c.given_name, c.family_name].filter(Boolean).join(' ') || c.email || '';
    }
  }

  // Batch fetch subscription access_status
  const subIds = [...new Set((data || []).map(r => r.plan_cards?.subscription_id).filter(Boolean))];
  const subMap = {};
  if (subIds.length) {
    const { data: subs } = await sb.from('subscriptions').select('id, access_status').in('id', subIds);
    for (const s of (subs || [])) { subMap[s.id] = s.access_status; }
  }

  const enriched = [];
  for (const r of (data || [])) {
    const pc = r.plan_cards;
    const accessStatus = subMap[pc?.subscription_id] || 'ACTIVE';
    enriched.push({
      recipientId:    r.recipient_id,
      name:           r.name,
      companyName:    '',
      type:           r.type,
      planCardId:     pc?.plan_card_id,
      clientId:       pc?.client_id,
      clientName:     clientMap[pc?.client_id] || '',
      subscriptionId: pc?.subscription_id,
      planName:       pc?.plan_name,
      friendlyName:   pc?.friendly_name || null,
      autoFeature:    pc?.auto_feature,
      parcelLimit:    pc?.parcel_limit ?? 0,
      accessStatus,
      recipientStatus: r.status,
      planStatus:      pc?.status,
      notes:           r.notes || null,
      locationId:      r.location_id || null
    });
  }
  return enriched; // Note: searchRecipients GAS returns array directly, not {status:'ok',...}
}

async function _getDashboardStats(uuid) {
  // Get staff location
  const { data: staff } = await sb.from('staff')
    .select('default_location_id, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  if (!locId) return { status: 'error', message: 'No location assigned' };
  // TENANT ISOLATION: service-role bypasses RLS; no company resolved -> fail closed.
  if (!companyId) return { status: 'error', message: 'No company in context' };

  // Staff dashboard "today" window in the STAFF LOCATION zone (single-location view).
  const _dashTz = locTz(locId);
  const todayToronto = new Date().toLocaleDateString('en-CA', { timeZone: _dashTz });
  // logged_at / status_changed_at are timestamptz (UTC). Naked 'T00:00:00' strings would be
  // read as UTC, shifting "today" hours off in the location zone. Append the live offset (DST-aware).
  const _torOffset = (() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: _dashTz, timeZoneName: 'longOffset' })
      .formatToParts(new Date());
    const tz = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT-05:00';
    const m = tz.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : '-05:00';
  })();
  const todayStart   = todayToronto + 'T00:00:00' + _torOffset;
  const todayEnd     = todayToronto + 'T23:59:59' + _torOffset;

  // Run all DB queries in parallel
  const [
    tasksRes,
    excRes,
    loggedRes,
    releasedRes,
    forwardedRes,
    discardRes,
  ] = await Promise.all([
    // ALL open tasks (no location filter in DB \u2014 mirrors _getTasks which filters in JS)
    sb.from('tasks')
      .select('task_id, assigned_to, due_date, priority, type, notes, status, location_id')
      .eq('company_id', companyId)
      .in('status', ['open', 'in_progress']),

    // Exceptions = special_case mail still unassigned at this location
    sb.from('mail_log')
      .select('mail_id', { count: 'exact', head: true })
      .eq('location_id', locId)
      .eq('company_id', companyId)
      .eq('special_case', true)
      .in('status', ['pending_assignment', 'received']),

    // Mail logged today at this location
    sb.from('mail_log')
      .select('mail_id', { count: 'exact', head: true })
      .eq('location_id', locId)
      .eq('company_id', companyId)
      .gte('logged_at', todayStart)
      .lte('logged_at', todayEnd)
      .neq('status', 'deleted'),

    // Released (picked up) today at this location
    sb.from('mail_log')
      .select('mail_id', { count: 'exact', head: true })
      .eq('location_id', locId)
      .eq('company_id', companyId)
      .eq('status', 'picked_up')
      .gte('status_changed_at', todayStart)
      .lte('status_changed_at', todayEnd),

    // Forwarded today at this location
    sb.from('mail_log')
      .select('mail_id', { count: 'exact', head: true })
      .eq('location_id', locId)
      .eq('company_id', companyId)
      .eq('status', 'forwarded')
      .gte('status_changed_at', todayStart)
      .lte('status_changed_at', todayEnd),

    // Ready to discard \u2014 past storage due date, still active at this location
    sb.from('mail_log')
      .select('mail_id', { count: 'exact', head: true })
      .eq('location_id', locId)
      .eq('company_id', companyId)
      .in('status', ['ready_for_pickup', 'confidential_pickup', 'received', 'pending_assignment'])
      .lt('storage_due_date', todayToronto),

  ]);

  // \u2014\u2014\u2014 TASKS \u2014\u2014\u2014
  // Filter in JS exactly like _getTasks does (location_id null = global task, visible everywhere)
  const allTasks = tasksRes.data || [];
  const locationTasks = allTasks.filter(t => !t.location_id || t.location_id === locId);
  const openTasksRaw  = locationTasks.filter(t => t.type !== 'pending_setup');
  const tasks         = rowsToCamel(openTasksRaw);
  const openTasks     = tasks;
  const unclaimedTasks = tasks.filter(t => !t.assignedTo);
  const dueToday      = tasks.filter(t => t.dueDate && t.dueDate.split('T')[0] === todayToronto);
  const urgentTasks   = tasks.filter(t => t.priority === 'urgent' || t.priority === 'high');

  // \u2014\u2014\u2014 SETUP PENDING + ID COUNTS \u2014\u2014\u2014
  const [setupResult, pendingVerifResult, noIdRes] = await Promise.all([
    _getPendingSetups(uuid),
    _getPendingVerifications(uuid),
    // No ID = any client with an active subscription who hasn't submitted/approved ID
    // Not location-scoped \u2014 they may not have a plan card yet
    sb.from('subscriptions')
      .select('client_id')
      .eq('company_id', companyId)
      .eq('access_status', 'ACTIVE'),
  ]);

  const setups            = setupResult.setups || [];
  const setupPendingCount = setups.filter(s => s.issue === 'no_plan_card').length;
  const idPending         = (pendingVerifResult.pending || []).length;

  // idNotSubmitted: distinct clients with active subs whose ID is not approved/pending
  let idNotSubmitted = 0;
  const activeSubClientIds = [...new Set((noIdRes.data || []).map(r => r.client_id).filter(Boolean))];
  if (activeSubClientIds.length) {
    const { count } = await sb.from('clients')
      .select('id', { count: 'exact', head: true })
      .in('id', activeSubClientIds)
      .not('id_verification_status', 'in', '("approved","pending")');
    idNotSubmitted = count || 0;
  }


  // Payment due \u2014 fetch PAYMENT_REQUIRED subscription IDs first, then count plan cards
  let paymentDueCount = 0;
  try {
    const { data: paymentSubs } = await sb.from('subscriptions')
      .select('id').eq('company_id', companyId).eq('access_status', 'PAYMENT_REQUIRED');
    if (paymentSubs && paymentSubs.length) {
      const paymentSubIds = paymentSubs.map(s => s.id);
      const { count } = await sb.from('plan_cards')
        .select('plan_card_id', { count: 'exact', head: true })
        .eq('location_id', locId).eq('company_id', companyId).eq('status', 'active')
        .in('subscription_id', paymentSubIds);
      paymentDueCount = count || 0;
    }
  } catch(e) {}

  return {
    status: 'ok',
    openTasks,
    unclaimedTasks,
    dueToday,
    urgentTasks,
    exceptionsCount:  excRes.count    || 0,
    idPending,
    idNotSubmitted,
    setupPending:     setupPendingCount,
    readyToDiscard:   discardRes.count || 0,
    loggedToday:      loggedRes.count  || 0,
    releasedToday:    releasedRes.count || 0,
    forwardedToday:   forwardedRes.count || 0,
    paymentDueCount,
  };
}

async function _runPaymentNotificationCheck(uuid) {
  // Runs once at staff login - sends missing bell notifications for payment failures.
  // The stripe webhook already creates the task; this just fires the notification if not yet sent.
  try {
    const { data: staff } = await sb.from('staff').select('default_location_id')
      .eq('staff_id', uuid).maybeSingle();
    const locId = staff?.default_location_id;
    if (!locId) return { status: 'ok' };

    const { data: paymentSubs } = await sb.from('subscriptions')
      .select('id, client_id').eq('access_status', 'PAYMENT_REQUIRED');
    if (!paymentSubs || !paymentSubs.length) return { status: 'ok' };

    for (const sub of paymentSubs) {
      const { data: pc } = await sb.from('plan_cards')
        .select('plan_card_id, client_id, location_id')
        .eq('subscription_id', sub.id).eq('location_id', locId).maybeSingle();
      if (!pc) continue;
      const { data: cl } = await sb.from('clients')
        .select('given_name, family_name, email').eq('id', sub.client_id).maybeSingle();
      const name = cl ? [cl.given_name, cl.family_name].filter(Boolean).join(' ') || cl.email : null;
      await _createPaymentFailedTask(sub.client_id, name, pc.location_id, pc.plan_card_id);
    }
  } catch(e) { /* non-critical, never surface */ }
  return { status: 'ok' };
}

async function _getMailLogStaff(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', mailLog: [], _planCache: {} };

  let mlQ = sb.from('mail_log').select('*')
    .eq('location_id', locId)
    .eq('company_id', companyId);
  const { data } = await mlQ
    .order('logged_at', { ascending: false }).limit(500);

  if (!data || !data.length) return { status: 'ok', mailLog: [], _planCache: {} };

  // Collect unique IDs for batch fetching
  const subIds = [...new Set(data.map(m => m.subscription_id).filter(Boolean))];
  const pcIds = [...new Set(data.map(m => m.plan_card_id).filter(Boolean))];
  const staffIds = [...new Set(data.map(m => m.logged_by).filter(Boolean))];

  // Batch fetch all related data in parallel
  const [subsRes, pcsRes, staffRes] = await Promise.all([
    subIds.length ? sb.from('subscriptions').select('id, access_status').in('id', subIds) : { data: [] },
    pcIds.length ? sb.from('plan_cards').select('*').in('plan_card_id', pcIds) : { data: [] },
    staffIds.length ? sb.from('staff').select('staff_id, name').in('staff_id', staffIds) : { data: [] }
  ]);

  // Build lookup maps
  const subMap = {};
  (subsRes.data || []).forEach(s => { subMap[s.id] = s.access_status; });
  const planCache = {};
  (pcsRes.data || []).forEach(pc => { 
    planCache[pc.plan_card_id] = pc;
  });

  const staffMap = {};
  (staffRes.data || []).forEach(s => { staffMap[s.staff_id] = s.name; });

  // Get client IDs from plan cards + direct client_id on mail items
  const clientIdsFromPc = Object.values(planCache).map(pc => pc.client_id).filter(Boolean);
  const clientIdsFromMail = data.map(m => m.client_id).filter(Boolean);
  const allClientIds = [...new Set([...clientIdsFromPc, ...clientIdsFromMail])];

  const clientsRes = allClientIds.length
    ? await sb.from('clients').select('id, given_name, family_name, email, phone, id_verification_status').in('id', allClientIds)
    : { data: [] };
  const clientMap = {};
  (clientsRes.data || []).forEach(c => {
    clientMap[c.id] = {
      name: [c.given_name, c.family_name].filter(Boolean).join(' ') || c.email || null,
      email: c.email || null,
      phone: c.phone || null,
      idVerificationStatus: c.id_verification_status || 'not_submitted'
    };
  });

  // Enrich items
  const enriched = data.map(m => {
    const row = rowToCamel(m);
    // Access status
    row.accessStatus = m.subscription_status || subMap[m.subscription_id] || null;
    // Client name
    let cid = m.client_id;
    if (!cid && m.plan_card_id && planCache[m.plan_card_id]) cid = planCache[m.plan_card_id].client_id;
    const client = cid ? clientMap[cid] : null;
    row.clientId = cid || null;
    row.clientName = client?.name || null;
    row.clientEmail = client?.email || null;
    row.clientPhone = client?.phone || null;
    row.idVerificationStatus = client?.idVerificationStatus || 'not_submitted';
    // Plan name
    const pc = planCache[m.plan_card_id];
    row.planName = pc ? pc.plan_name : null;
    // Staff name
    row.loggedByName = staffMap[m.logged_by] || null;
    return row;
  });

  // Dynamic overage: batch fetch all period items per plan card
  const overageSet = new Set();
  const activePcIds = [...new Set(enriched.filter(m => m.planCardId && !m.specialCase).map(m => m.planCardId))];

  // Run overage queries in parallel for all plan cards
  const overagePromises = activePcIds.map(async pcId => {
    const pc = planCache[pcId];
    if (!pc) return;
    const { periodStart, periodEnd } = await _ensureCurrentPeriod(pc);
    if (!periodStart || !periodEnd) return;
    // Company-zone-anchored window (§0d case R) — see _getLiveUsage rationale.
    const winStart = _zoneDayBounds(periodStart, COMPANY_DEFAULT_TZ).start;
    const winEnd   = _zoneDayBounds(periodEnd, COMPANY_DEFAULT_TZ).end;
    const mLimit = pc.mail_limit || 0;
    const pLimit = pc.parcel_limit || 0;

    const fetches = [];
    if (mLimit > 0) fetches.push(
      sb.from('mail_log').select('mail_id').eq('plan_card_id', pcId).eq('type', 'letter')
        .eq('special_case', false).neq('status', 'deleted')
        .gte('logged_at', winStart).lte('logged_at', winEnd)
        .order('logged_at', { ascending: true }).then(r => {
          if (r.data && r.data.length > mLimit) r.data.slice(mLimit).forEach(m => overageSet.add(m.mail_id));
        })
    );
    if (pLimit > 0) fetches.push(
      sb.from('mail_log').select('mail_id').eq('plan_card_id', pcId).eq('type', 'parcel')
        .eq('special_case', false).neq('status', 'deleted')
        .gte('logged_at', winStart).lte('logged_at', winEnd)
        .order('logged_at', { ascending: true }).then(r => {
          if (r.data && r.data.length > pLimit) r.data.slice(pLimit).forEach(m => overageSet.add(m.mail_id));
        })
    );
    await Promise.all(fetches);
  });
  await Promise.all(overagePromises);

  for (const m of enriched) {
    const isOv = overageSet.has(m.mailId) || !!m.overageFlag;
    m.overageFlag = isOv;
    // Check if this overage item is in a billed past period
    // planCache is keyed by snake_case plan_card_id
    const pcId = m.planCardId;
    if (isOv && pcId) {
      const pc = planCache[pcId] || Object.values(planCache).find(p => p.plan_card_id === pcId);
      const pStart = pc?.current_period_start;
      const pEnd = pc?.current_period_end;
      const _coDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';
      const _mDay = _coDay(m.loggedAt);
      const inCurrentPeriod = pStart && pEnd && _mDay >= pStart && _mDay <= pEnd;
      m.overageBilled = !inCurrentPeriod && !!(pc && pc.last_billed_at && _coDay(pc.last_billed_at) >= _mDay);
    } else {
      m.overageBilled = false;
    }
  }

  return { status: 'ok', mailLog: enriched, _planCache: planCache };
}

async function _getLogSuggestions(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;

  // Get unique sender names and physical locations from recent logs
  const { data } = await sb.from('mail_log')
    .select('sender_name, physical_location')
    .eq('location_id', locId).neq('status', 'deleted')
    .order('logged_at', { ascending: false }).limit(500);

  const senders = {};
  const locations = {};
  for (const m of (data || [])) {
    if (m.sender_name && m.sender_name.trim()) {
      const s = m.sender_name.trim();
      senders[s] = (senders[s] || 0) + 1;
    }
    if (m.physical_location && m.physical_location.trim()) {
      const l = m.physical_location.trim();
      locations[l] = (locations[l] || 0) + 1;
    }
  }

  // Sort by frequency, return top entries
  const sortByFreq = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  return {
    status: 'ok',
    senders: sortByFreq(senders).slice(0, 50),
    locations: sortByFreq(locations).slice(0, 20)
  };
}

async function _getAgentsForPlanCard(uuid, planCardId) {
  // Agents are per-client, not per plan card \u2014 look up client_id first
  let clientId = null;
  if (planCardId) {
    const { data: pc } = await sb.from('plan_cards').select('client_id')
      .eq('plan_card_id', planCardId).maybeSingle();
    clientId = pc?.client_id;
  }
  if (!clientId) return { status: 'ok', agents: [] };
  const { data } = await sb.from('pickup_agents').select('*')
    .eq('client_id', clientId).eq('status', 'active');
  return { status: 'ok', agents: rowsToCamel(data) };
}

async function _getExceptions(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', exceptions: [] };

  let excQ = sb.from('mail_log').select('*')
    .eq('location_id', locId).eq('special_case', true)
    .in('status', ['pending_assignment', 'received'])
    .eq('company_id', companyId);
  const { data } = await excQ
    .order('logged_at', { ascending: false }).limit(200);

  if (!data || !data.length) return { status: 'ok', exceptions: [] };

  // Build staff name map from unique logged_by IDs
  const staffIds = [...new Set(data.map(m => m.logged_by).filter(Boolean))];
  const staffMap = {};
  if (staffIds.length) {
    const { data: staffRows } = await sb.from('staff')
      .select('staff_id, name').in('staff_id', staffIds);
    (staffRows || []).forEach(s => { staffMap[s.staff_id] = s.name; });
  }

  const enriched = data.map(m => {
    const row = rowToCamel(m);
    row.loggedByName = staffMap[m.logged_by] || null;
    return row;
  });

  return { status: 'ok', exceptions: enriched };
}

async function _getPendingSetups(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id, role').eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  const isAdmin = staff?.role === 'admin';
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', setups: [] };

  // Fetch subscriptions and plan cards in parallel — all scoped to this company
  // Category 1 location scope: non-admin staff see only their own location's
  // pre-setup subscriptions; admins see all locations (app-wide convention).
  // A subscription with no location_id is hidden from scoped staff (fail-closed).
  let subsQ = sb.from('subscriptions').select('id, client_id, plan_name, product_id, access_status, created_at, location_id').eq('access_status', 'ACTIVE').eq('company_id', companyId);
  if (!isAdmin) subsQ = subsQ.eq('location_id', locId);
  let pcsQ  = sb.from('plan_cards').select('*').eq('location_id', locId).eq('status', 'active').eq('company_id', companyId);
  let allPcsQ = sb.from('plan_cards').select('subscription_id').eq('status', 'active').eq('company_id', companyId);
  const [subsRes, pcsRes, allPcsRes] = await Promise.all([subsQ, pcsQ, allPcsQ]);
  const subs = subsRes.data;
  const pcs = pcsRes.data;

  // Map ALL subscription_ids that have ANY plan card (at any location, within this company)
  const subIdsWithCards = new Set((allPcsRes.data||[]).map(p => p.subscription_id).filter(Boolean));

  // Get all clients in one query
  const allClientIds = [...new Set([...(subs||[]).map(s=>s.client_id), ...(pcs||[]).map(p=>p.client_id)].filter(Boolean))];
  const { data: clients } = allClientIds.length ? await sb.from('clients').select('id, given_name, family_name, email, phone, id_verification_status').in('id', allClientIds) : { data: [] };
  const cMap = {};
  (clients||[]).forEach(c => { cMap[c.id] = { name: [c.given_name, c.family_name].filter(Boolean).join(' ') || c.email || c.id, email: c.email, phone: c.phone || '', idStatus: c.id_verification_status || 'not_submitted' }; });

  const setups = [];

  // Category 1: Active subscriptions with NO plan card (hasn't set up yet)
  for (const s of (subs||[])) {
    if (subIdsWithCards.has(s.id)) continue; // already has a plan card
    const cl = cMap[s.client_id] || {};
    setups.push({
      planCardId: null, clientId: s.client_id, subscriptionId: s.id,
      clientName: cl.name || s.client_id, clientEmail: cl.email || '', clientPhone: cl.phone || '',
      idStatus: cl.idStatus || 'not_submitted',
      planName: s.plan_name || null, createdAt: s.created_at || null, status: 'no_plan_card', issue: 'no_plan_card'
    });
  }

  // Category 2: Plan cards with 0 recipients
  for (const p of (pcs||[])) {
    if (p.recipients_added !== null && p.recipients_added !== 0) continue;
    const cl = cMap[p.client_id] || {};
    setups.push({
      planCardId: p.plan_card_id, clientId: p.client_id, subscriptionId: null,
      clientName: cl.name || p.client_id, clientEmail: cl.email || '', clientPhone: cl.phone || '',
      idStatus: cl.idStatus || 'not_submitted',
      planName: p.plan_name, createdAt: p.created_at || null, status: 'no_recipients', issue: 'no_recipients'
    });
  }

  // Category 3: Clients at location with unverified ID (have plan card + recipients but no ID)
  const alreadyListed = new Set(setups.map(s => s.clientId));
  for (const p of (pcs||[])) {
    if (alreadyListed.has(p.client_id)) continue;
    const cl = cMap[p.client_id] || {};
    if (cl.idStatus === 'approved' || cl.idStatus === 'pending') continue;
    setups.push({
      planCardId: p.plan_card_id, clientId: p.client_id, subscriptionId: null,
      clientName: cl.name || p.client_id, clientEmail: cl.email || '', clientPhone: cl.phone || '',
      idStatus: cl.idStatus || 'not_submitted',
      planName: p.plan_name, createdAt: p.created_at || null, status: 'active', issue: 'no_id'
    });
    alreadyListed.add(p.client_id);
  }

  return { status: 'ok', setups };
}

async function _getPlanCardsStaff(uuid, locationId) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id, role')
    .eq('staff_id', uuid).maybeSingle();
  const isAdmin = staff?.role === 'admin';
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', planCards: [] };
  // STAFF MUST be location-scoped: a non-admin with no default location sees NOTHING,
  // never all-company. (scopeLoc would be null below -> location filter skipped -> leak.)
  if (!isAdmin && !staff?.default_location_id) return { status: 'ok', planCards: [] };
  // Admin may pass an explicit branch (locationId) to scope to that branch; admin with NO
  // branch goes all-company (no location filter). Staff are always pinned to their own.
  const scopeLoc = isAdmin ? (locationId || null) : staff?.default_location_id;

  let cardsQ = sb.from('plan_cards').select('*')
    .eq('status', 'active')
    .eq('company_id', companyId)
    .order('activated_at', { ascending: true, nullsFirst: false })
    .order('plan_card_id', { ascending: true });
  if (scopeLoc) cardsQ = cardsQ.eq('location_id', scopeLoc);
  const { data: cards } = await cardsQ;
  if (!cards || !cards.length) return { status: 'ok', planCards: [] };

  // Batch: per-location tax (name + rate) for every location these cards sit in.
  // Self-scoped to this company (service role bypasses RLS). Used to stamp
  // taxName/taxRate onto each card so the Create Charge modal shows the right
  // rate without a per-card round-trip. Mirrors _getPlanCard's single lookup.
  const _taxByLoc = {};
  const _locIdsForTax = [...new Set(cards.map(pc => pc.location_id).filter(Boolean))];
  if (_locIdsForTax.length) {
    const { data: _taxRows } = await sb.from('locations')
      .select('location_id, tax_name, tax_rate')
      .eq('company_id', companyId)
      .in('location_id', _locIdsForTax);
    (_taxRows || []).forEach(l => {
      _taxByLoc[l.location_id] = {
        taxName: (l.tax_name != null) ? l.tax_name : 'Tax',
        taxRate: (l.tax_rate != null) ? parseFloat(l.tax_rate) : 0,
      };
    });
  }

  // Batch: collect all unique IDs
  const clientIds = [...new Set(cards.map(pc => pc.client_id).filter(Boolean))];
  const subIds = [...new Set(cards.map(pc => pc.subscription_id).filter(Boolean))];
  const pcIds = cards.map(pc => pc.plan_card_id);

  // Batch fetch all related data in parallel
  const [clientsRes, subsRes, recsRes, usageRes] = await Promise.all([
    clientIds.length ? sb.from('clients').select('id, given_name, family_name, email, phone, access_override, override_reason, override_by, id_verification_status, created_at, referral_source, customer_type').in('id', clientIds) : { data: [] },
    subIds.length ? sb.from('subscriptions').select('id, stripe_subscription_id, access_status, plan_name, plan_amount_formatted').in('id', subIds) : { data: [] },
    sb.from('recipients').select('*').in('plan_card_id', pcIds).order('created_at'),
    // Batch usage: get all items with logged_at and type for period filtering
    sb.from('mail_log').select('plan_card_id, type, logged_at, status, storage_due_date, recipient_id').eq('special_case', false).in('plan_card_id', pcIds)
  ]);

  // Build lookup maps
  const clientMap = {};
  (clientsRes.data || []).forEach(c => { clientMap[c.id] = c; });
  const subMap = {};
  (subsRes.data || []).forEach(s => {
    subMap[s.id] = s; // keyed by UUID
    if (s.stripe_subscription_id) subMap[s.stripe_subscription_id] = s; // fallback by Stripe ID
  });
  const recMap = {};
  (recsRes.data || []).forEach(r => {
    if (!recMap[r.plan_card_id]) recMap[r.plan_card_id] = [];
    recMap[r.plan_card_id].push(r);
  });

  // Group mail items by plan_card_id for fast lookup
  const itemsByPc = {};
  (usageRes.data || []).forEach(m => {
    if (!itemsByPc[m.plan_card_id]) itemsByPc[m.plan_card_id] = [];
    itemsByPc[m.plan_card_id].push(m);
  });

  // Run _ensureCurrentPeriod in parallel for all cards (fast path skips DB if period is current)
  const periods = await Promise.all(cards.map(pc => _ensureCurrentPeriod(pc)));

  const enriched = [];
  for (let i = 0; i < cards.length; i++) {
    const pc = cards[i];
    const { periodStart, periodEnd } = periods[i];

    // Count usage from batch data filtered by period (COMPANY-zone calendar day, §0d case R).
    let mailsUsed = 0, parcelsUsed = 0;
    if (periodStart && periodEnd) {
      const _coDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';
      const pcItems = (itemsByPc[pc.plan_card_id] || []).filter(m => { const day = _coDay(m.logged_at); return day >= periodStart && day <= periodEnd; });
      mailsUsed = pcItems.filter(m => m.type === 'letter').length;
      parcelsUsed = pcItems.filter(m => m.type === 'parcel').length;
    }

    const client = clientMap[pc.client_id];
    const sub = subMap[pc.subscription_id];
    const card = rowToCamel(pc);
    card.currentPeriodStart = periodStart;
    card.currentPeriodEnd = periodEnd;
    card.mailsUsed = mailsUsed;
    card.parcelsUsed = parcelsUsed;
    card.clientName = client ? [client.given_name, client.family_name].filter(Boolean).join(' ') : '';
    card.clientEmail = client?.email || '';
    card.clientPhone = client?.phone || '';
    card.clientAccessOverride = client?.access_override || null;
    card.clientOverrideReason = client?.override_reason || null;
    card.clientOverrideBy = client?.override_by || null;
    card.idVerificationStatus = client?.id_verification_status || 'not_submitted';
    card.referralSource = client?.referral_source || null;
    card.customerType = client?.customer_type || 'canadian';
    card.accessStatus = sub?.access_status || 'ACTIVE';
    card.subscriptionPlanName = sub?.plan_name || '';
    card.planAmountFormatted = sub?.plan_amount_formatted || '';
    card.recipients = rowsToCamel(recMap[pc.plan_card_id] || []);
    card.memberSince = client?.created_at || null;
    // Per-location tax for the Create Charge modal (read from this card's location).
    const _tx = _taxByLoc[pc.location_id] || { taxName: 'Tax', taxRate: 0 };
    card.taxName = _tx.taxName;
    card.taxRate = _tx.taxRate;
    const _pcItems = itemsByPc[pc.plan_card_id] || [];
    const _pcActive = _pcItems.filter(m => m.status !== 'deleted');
    card.lastMailDate = _pcActive.length ? _pcActive.reduce((mx, m) => m.logged_at > mx ? m.logged_at : mx, _pcActive[0].logged_at) : null;
    const _activeS = ['pending_assignment','ready_for_pickup','confidential_pickup','received'];
    const _todayI = new Date().toLocaleDateString('en-CA', { timeZone: locTz(pc.location_id) });
    card.mailInStorage  = _pcActive.filter(m => _activeS.includes(m.status)).length;
    card.mailOverdue    = _pcActive.filter(m => _activeS.includes(m.status) && m.storage_due_date && m.storage_due_date < _todayI).length;
    card.mailFwdQueue   = _pcActive.filter(m => m.status === 'forwarding_queued').length;
    card.usedRecipients = [...new Set(_pcItems.filter(m => m.recipient_id).map(m => m.recipient_id))];
    enriched.push(card);
  }

  // Auto-resolve payment failed tasks ONLY if client has ZERO PAYMENT_REQUIRED subscriptions
  const clientsWithPaymentIssue = new Set(enriched.filter(c => c.accessStatus === 'PAYMENT_REQUIRED').map(c => c.clientId));
  const clientsToResolve = [...new Set(enriched.map(c => c.clientId))].filter(cid => !clientsWithPaymentIssue.has(cid));
  for (const cid of clientsToResolve) {
    sb.from('tasks').update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: 'Payment restored automatically' })
      .eq('client_id', cid).eq('type', 'payment_failed').in('status', ['open','in_progress','snoozed']).then(() => {}).catch(() => {});
  }

  return { status: 'ok', planCards: enriched };
}

// Pending-setup clients: paid but onboarding not finished (open pending_setup
// task at this staff member's location/company AND zero plan cards of any kind).
// Scoped exactly like _getPlanCardsStaff (location_id + optional company_id).
async function _getPendingSetupClients(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, allowed_location_ids, role, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const companyId = staff?.company_id;
  const locId = staff?.default_location_id;
  const isAdmin = staff?.role === 'admin';
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', pendingClients: [] };

  // Identify pending-setup clients the SAME WAY the working Exceptions feature
  // (_getPendingSetups, Category 1) does: an ACTIVE subscription in this company
  // that has no plan card yet. This is the app's real source of truth for
  // "paid but not set up" — it does NOT depend on a pending_setup task existing
  // (that task is best-effort created by the Stripe webhook and can be missing).
  let subsQ = sb.from('subscriptions')
    .select('id, client_id, plan_name, plan_amount_formatted, interval, interval_count, product_id, location_id, current_period_start, current_period_end, access_status, created_at')
    .eq('access_status', 'ACTIVE')
    .eq('company_id', companyId);
  const { data: subs } = await subsQ;
  if (!subs || !subs.length) return { status: 'ok', pendingClients: [] };

  // All client_ids and subscription_ids on active subs in this company
  const subClientIds = [...new Set(subs.map(s => s.client_id).filter(Boolean))];

  // Plan cards (ANY status) for those clients — "no plan cards at all" rule.
  let cardsQ = sb.from('plan_cards').select('client_id, subscription_id, status').eq('company_id', companyId);
  cardsQ = cardsQ.in('client_id', subClientIds);
  const { data: allCards } = await cardsQ;
  const clientsWithAnyCard = new Set((allCards || []).map(c => c.client_id).filter(Boolean));
  const subIdsWithCard     = new Set((allCards || []).map(c => c.subscription_id).filter(Boolean));

  // A client is pending if they have an active sub with no plan card AND no plan
  // card exists for that client under any subscription/status.
  const pendingMap = {}; // clientId -> subscription row (earliest)
  for (const s of subs) {
    if (!s.client_id) continue;
    if (subIdsWithCard.has(s.id)) continue;        // this sub already set up
    if (clientsWithAnyCard.has(s.client_id)) continue; // client has some card already
    const prev = pendingMap[s.client_id];
    if (!prev || (s.created_at && s.created_at < (prev.created_at || ''))) {
      pendingMap[s.client_id] = s;
    }
  }
  let pendingIds = Object.keys(pendingMap);

  // Location scope: pending-setup clients have NO plan_card yet (that's what makes
  // them "pending setup"), so plan_cards.location_id can't resolve their location.
  // The only available signal is the subscription's location_id (already in
  // pendingMap, set at signup and the same value used for their setup notifications).
  // Non-admin staff see only their own location; admins see all. A pending client
  // with a null subscription location is hidden from scoped staff.
  if (!isAdmin) {
    for (const cid of pendingIds) {
      const subLoc = pendingMap[cid] && pendingMap[cid].location_id;
      if (!locId || subLoc !== locId) delete pendingMap[cid];
    }
    pendingIds = Object.keys(pendingMap);
  }
  if (!pendingIds.length) return { status: 'ok', pendingClients: [] };

  // Fetch plan templates for the signed-up plans (limits/features shown on the
  // skeleton card). Keyed by product_id, same source onboarding copies into the
  // real plan card.
  const productIds = [...new Set(Object.values(pendingMap).map(s => s.product_id).filter(Boolean))];
  let planMap = {};
  if (productIds.length) {
    const { data: plans } = await sb.from('plans')
      .select('product_id, mail_limit, parcels_included, max_recipients, auto_feature, mail_storage_days, parcel_storage_days, price_display, mail_overage_fee, parcel_overage_fee')
      .in('product_id', productIds);
    (plans || []).forEach(p => { planMap[p.product_id] = p; });
  }

  // Fetch client details
  const { data: clients } = await sb.from('clients')
    .select('id, given_name, family_name, email, phone, id_verification_status, created_at, access_override, override_reason, override_by')
    .in('id', pendingIds);
  const cMap = {};
  (clients || []).forEach(c => { cMap[c.id] = c; });

  // Human billing-cycle label from interval + interval_count
  const cycleLabel = (s) => {
    const n = s.interval_count || 1;
    const unit = (s.interval || 'month');
    if (n === 1) return ({ month: 'Monthly', year: 'Yearly', week: 'Weekly', day: 'Daily' })[unit] || ('Every ' + unit);
    return 'Every ' + n + ' ' + unit + 's';
  };

  const pendingClients = pendingIds.map(cid => {
    const c = cMap[cid] || {};
    const s = pendingMap[cid] || {};
    const tmpl = planMap[s.product_id] || {};
    return {
      clientId: cid,
      clientName: [c.given_name, c.family_name].filter(Boolean).join(' ').trim(),
      clientEmail: c.email || '',
      clientPhone: c.phone || '',
      idVerificationStatus: c.id_verification_status || 'not_submitted',
      memberSince: c.created_at || s.created_at || null,
      locationId: s.location_id || null,
      clientAccessOverride: c.access_override || null,
      clientOverrideReason: c.override_reason || null,
      clientOverrideBy: c.override_by || null,
      pendingSetup: true,
      accessStatus: 'PENDING_SETUP',
      planName: s.plan_name || null,
      recipients: [],
      // Signup details for the skeleton plan card
      pendingPlanName: s.plan_name || null,
      pendingPlanAmount: s.plan_amount_formatted || tmpl.price_display || null,
      pendingBillingCycle: cycleLabel(s),
      pendingPeriodStart: s.current_period_start || null,
      pendingPeriodEnd: s.current_period_end || null,
      pendingMailLimit: (tmpl.mail_limit != null ? tmpl.mail_limit : null),
      pendingParcelLimit: (tmpl.parcels_included != null ? tmpl.parcels_included : null),
      pendingMaxRecipients: (tmpl.max_recipients != null ? tmpl.max_recipients : null),
      pendingAutoFeature: tmpl.auto_feature || 'none',
      pendingMailStorageDays: (tmpl.mail_storage_days != null ? tmpl.mail_storage_days : null),
      pendingParcelStorageDays: (tmpl.parcel_storage_days != null ? tmpl.parcel_storage_days : null),
      pendingMailOverageFee: (tmpl.mail_overage_fee != null ? tmpl.mail_overage_fee : null),
      pendingParcelOverageFee: (tmpl.parcel_overage_fee != null ? tmpl.parcel_overage_fee : null)
    };
  });

  return { status: 'ok', pendingClients };
}

// ============================================================
// ACCOUNT MANAGEMENT (Admin only)
// ============================================================

async function _createStaffAccount(body) {
  // Only admins can create staff/admin accounts
  const { data: caller } = await sb.from('staff').select('role, company_id').eq('staff_id', body.uuid).maybeSingle();
  if (!caller || caller.role !== 'admin') return { status: 'error', message: 'Only admins can create staff accounts.' };

  const { name, email, password, role, locationId, canVerifyId, canExtendStorage, canTerminate, canCreateCharge, canResetPassword } = body;
  if (!name || !email || !password) return { status: 'error', message: 'Name, email and password are required.' };
  if (!['staff', 'admin'].includes(role)) return { status: 'error', message: 'Role must be staff or admin.' };
  if (password.length < 8) return { status: 'error', message: 'Password must be at least 8 characters.' };

  // Step 1: Create Supabase Auth user using Admin API (service role)
  const authRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    },
    body: JSON.stringify({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true  // skip email confirmation
    })
  });
  const authData = await authRes.json();
  if (!authRes.ok) {
    const msg = authData.message || authData.msg || 'Failed to create auth user.';
    return { status: 'error', message: msg };
  }

  const authId = authData.id;
  if (!authId) return { status: 'error', message: 'Auth user created but no ID returned.' };

  // Step 2: Insert staff row linked to the new auth user
  const staffId = 'STF' + Date.now().toString().slice(-8);
  const { error: insertError } = await sb.from('staff').insert({
    staff_id:            staffId,
    company_id:          caller.company_id,
    auth_id:             authId,
    name:                name.trim(),
    email:               email.toLowerCase().trim(),
    role:                role,
    active:              true,
    default_location_id: locationId || null,
    can_verify_id:       canVerifyId !== false,
    can_extend_storage:  canExtendStorage === true,
    can_terminate:       canTerminate === true,
    can_create_charge:   canCreateCharge === true,
    can_reset_password:  canResetPassword === true,
  });

  if (insertError) {
    // Rollback: delete the auth user so we don't leave orphans
    await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + authId, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    return { status: 'error', message: 'Staff row insert failed: ' + insertError.message };
  }

  await _audit({
    action: 'staff_account_created', entityType: 'staff', entityId: staffId,
    staffId: body.uuid, summary: role + ' account created: ' + name + ' (' + email + ')'
  });

  return { status: 'ok', staffId, authId };
}

// ============================================================
// SUPER-ADMIN (PLATFORM) FUNCTIONS
// All gated behind _isPlatformAdmin(authId). Operate across all companies.
// ============================================================
async function _isPlatformAdmin(authId) {
  if (!authId) return false;
  const { data } = await sb.from('platform_admins').select('id, active').eq('auth_id', authId).maybeSingle();
  return !!(data && data.active);
}

// Verify the bearer token belongs to an active platform admin. Returns authId or null.
async function _verifyPlatformToken(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + accessToken }
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id) return null;
    const ok = await _isPlatformAdmin(user.id);
    return ok ? user.id : null;
  } catch(e) { return null; }
}

// List all companies with live usage counts (admins, locations, clients) vs limits.
async function _superListCompanies(body) {
  const authId = await _verifyPlatformToken(body.accessToken);
  if (!authId) return { status: 'error', message: 'Not authorized (platform admin only).' };

  const { data: companies } = await sb.from('companies').select('*').neq('slug', '__platform__').order('created_at', { ascending: true });
  const result = [];
  for (const c of (companies || [])) {
    // Usage counts scoped to this company
    const [admins, locations, clients] = await Promise.all([
      sb.from('staff').select('staff_id', { count: 'exact', head: true }).eq('company_id', c.id).eq('role', 'admin').eq('active', true),
      sb.from('locations').select('location_id', { count: 'exact', head: true }).eq('company_id', c.id),
      sb.from('clients').select('id', { count: 'exact', head: true }).eq('company_id', c.id)
    ]);
    result.push({
      ...rowToCamel(c),
      usage: {
        admins: admins.count || 0,
        locations: locations.count || 0,
        clients: clients.count || 0
      }
    });
  }
  return { status: 'ok', companies: result };
}

// Create a company + its first admin (Auth user + staff row). Returns a temp password once.
async function _superCreateCompany(body) {
  const authId = await _verifyPlatformToken(body.accessToken);
  if (!authId) return { status: 'error', message: 'Not authorized (platform admin only).' };

  const { name, slug, adminEmail, adminName } = body;
  if (!name || !slug || !adminEmail) return { status: 'error', message: 'Company name, slug, and admin email are required.' };

  const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, '');
  if (!cleanSlug) return { status: 'error', message: 'Slug must contain letters/numbers.' };

  // Unique slug check
  const { data: slugTaken } = await sb.from('companies').select('id').eq('slug', cleanSlug).maybeSingle();
  if (slugTaken) return { status: 'error', message: 'That slug is already in use.' };

  // 1. Create the company row (with optional limits/rate/keys from body)
  const { data: company, error: coErr } = await sb.from('companies').insert({
    name: name.trim(),
    slug: cleanSlug,
    custom_domain: body.customDomain || null,
    logo_url: body.logoUrl || null,
    max_admins: body.maxAdmins != null ? parseInt(body.maxAdmins) : 2,
    max_locations: body.maxLocations != null ? parseInt(body.maxLocations) : 1,
    max_clients: body.maxClients != null ? parseInt(body.maxClients) : 100,
    client_warn_threshold: body.clientWarnThreshold != null ? parseInt(body.clientWarnThreshold) : 25,
    monthly_rate: body.monthlyRate != null ? parseFloat(body.monthlyRate) : 0,
    billing_notes: body.billingNotes || null,
    powered_by_enabled: body.poweredByEnabled !== false
  }).select().single();
  if (coErr) return { status: 'error', message: 'Company create failed: ' + coErr.message };

  // 1b. Seed a starter set of config rows so the new tenant opens on sensible
  //     defaults instead of blank fields. All stamped with the new company_id.
  // Validate the requested company default zone against the supported Canada/US
  // IANA set (same zones tzLabel/the location dropdown use). Bad/missing → Toronto.
  const _SUPPORTED_TZ = [
    'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg',
    'America/Halifax', 'America/St_Johns', 'America/Regina', 'America/Phoenix',
    'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York',
    'America/Anchorage', 'Pacific/Honolulu'
  ];
  const _tz = _SUPPORTED_TZ.includes(body.defaultTimezone) ? body.defaultTimezone : 'America/Toronto';
  const _starterConfig = [
    { key: 'branding_company_name',  value: name.trim(),  description: 'Company name shown in portals and emails' },
    { key: 'email_accent_color',     value: '#1a1a1a',    description: 'Accent color for portals and email headers' },
    { key: 'stripe_mode',            value: 'test',        description: 'Stripe mode: test or live' },
    { key: 'branding_logo_enabled',  value: '1',           description: 'Show logo in portals' },
    { key: 'signup_headline',        value: 'Your Business Address Starts Here', description: 'Signup page headline' },
    { key: 'signup_subtext',         value: 'Choose a plan to get started.',      description: 'Signup page subtext' },
    { key: 'notification_retention_days', value: '30',     description: 'Days to keep in-app bell notifications before auto-deleting them (does not affect the notification log)' },
    { key: 'default_timezone',       value: _tz,           description: 'Company default timezone (billing, broadcasts, invoices)' }
  ].map(r => ({ ...r, company_id: company.id }));
  // Best-effort: don't fail company creation if seeding hiccups (rows are optional defaults)
  await sb.from('config').insert(_starterConfig);

  // 2. Generate a temp password for the first admin
  const tempPassword = 'Yz' + Math.random().toString(36).slice(2, 10) + Math.floor(Math.random()*90+10) + '!';

  // 3. Create the admin Auth user
  const authRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
    body: JSON.stringify({ email: adminEmail.toLowerCase().trim(), password: tempPassword, email_confirm: true })
  });
  const authData = await authRes.json();
  if (!authRes.ok || !authData.id) {
    // Roll back the company so we don't leave an admin-less tenant
    await sb.from('companies').delete().eq('id', company.id);
    return { status: 'error', message: 'Admin auth user failed: ' + (authData.message || authData.msg || 'unknown') };
  }

  // 4. Insert the admin staff row, stamped with the new company_id
  const staffId = 'STF' + Date.now().toString().slice(-8);
  const { error: staffErr } = await sb.from('staff').insert({
    staff_id: staffId,
    company_id: company.id,
    auth_id: authData.id,
    name: (adminName || 'Admin').trim(),
    email: adminEmail.toLowerCase().trim(),
    role: 'admin',
    active: true,
    can_verify_id: true, can_extend_storage: true, can_terminate: true,
    can_create_charge: true, can_reset_password: true
  });
  if (staffErr) {
    // Roll back auth user + company
    await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + authData.id, { method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } });
    await sb.from('companies').delete().eq('id', company.id);
    return { status: 'error', message: 'Admin staff row failed: ' + staffErr.message };
  }

  return { status: 'ok', companyId: company.id, slug: cleanSlug, adminEmail: adminEmail.toLowerCase().trim(), tempPassword };
}

// Update a company's settings (limits, rate, branding, gateway toggles, archive).
async function _superUpdateCompany(body) {
  const authId = await _verifyPlatformToken(body.accessToken);
  if (!authId) return { status: 'error', message: 'Not authorized (platform admin only).' };
  if (!body.companyId) return { status: 'error', message: 'companyId required.' };

  const updates = {};
  if (body.name != null) updates.name = body.name.trim();
  if (body.customDomain !== undefined) updates.custom_domain = body.customDomain || null;
  if (body.logoUrl !== undefined) updates.logo_url = body.logoUrl || null;
  if (body.maxAdmins != null) updates.max_admins = parseInt(body.maxAdmins);
  if (body.maxLocations != null) updates.max_locations = parseInt(body.maxLocations);
  if (body.maxClients != null) updates.max_clients = parseInt(body.maxClients);
  if (body.clientWarnThreshold != null) updates.client_warn_threshold = parseInt(body.clientWarnThreshold);
  if (body.monthlyRate != null) updates.monthly_rate = parseFloat(body.monthlyRate);
  if (body.billingNotes !== undefined) updates.billing_notes = body.billingNotes || null;
  if (body.paidThrough !== undefined) updates.paid_through = body.paidThrough || null;
  if (body.poweredByEnabled != null) updates.powered_by_enabled = !!body.poweredByEnabled;
  if (body.staffAccessEnabled != null) updates.staff_access_enabled = !!body.staffAccessEnabled;
  if (body.clientAccessEnabled != null) updates.client_access_enabled = !!body.clientAccessEnabled;
  if (body.archived != null) {
    updates.archived = !!body.archived;
    updates.archived_at = body.archived ? new Date().toISOString() : null;
  }

  const { error } = await sb.from('companies').update(updates).eq('id', body.companyId);
  if (error) return { status: 'error', message: 'Update failed: ' + error.message };
  return { status: 'ok' };
}

// Reserved platform company id — holds platform-level config (login branding + defaults).
const PLATFORM_COMPANY_ID = '1db5b8c6-030c-461f-8179-f35146fca15e';

// Read platform-level config (login branding + the defaults that flow to all tenants).
// Platform-login branding keys live under the reserved PLATFORM company (read by
// the logged-out login page). Everything else is a tenant default in default_configs.
const _PLATFORM_LOGIN_KEYS = ['platform_login_logo_url', 'platform_login_name'];

async function _superGetPlatformConfig(body) {
  const authId = await _verifyPlatformToken(body.accessToken);
  if (!authId) return { status: 'error', message: 'Not authorized (platform admin only).' };
  const cfg = {};
  // Login branding from the PLATFORM company
  const { data: loginRows } = await sb.from('config').select('key, value').eq('company_id', PLATFORM_COMPANY_ID);
  for (const r of (loginRows || [])) cfg[r.key] = r.value;
  // Tenant defaults from default_configs
  const { data: defRows } = await sb.from('default_configs').select('key, value');
  for (const r of (defRows || [])) cfg[r.key] = r.value;
  return { status: 'ok', config: cfg };
}

// Write platform-level settings. Login-branding keys → PLATFORM company config.
// All other keys → default_configs (the tenant fallback table).
async function _superSetPlatformConfig(body) {
  const authId = await _verifyPlatformToken(body.accessToken);
  if (!authId) return { status: 'error', message: 'Not authorized (platform admin only).' };
  const updates = body.config || {};
  for (const key of Object.keys(updates)) {
    const value = updates[key];
    if (_PLATFORM_LOGIN_KEYS.includes(key)) {
      // Login branding under the PLATFORM company (empty value deletes the row)
      if (value === '' || value == null) {
        await sb.from('config').delete().eq('company_id', PLATFORM_COMPANY_ID).eq('key', key);
      } else {
        const { data: existing } = await sb.from('config').select('key')
          .eq('company_id', PLATFORM_COMPANY_ID).eq('key', key).maybeSingle();
        if (existing) await sb.from('config').update({ value: String(value) }).eq('company_id', PLATFORM_COMPANY_ID).eq('key', key);
        else await sb.from('config').insert({ company_id: PLATFORM_COMPANY_ID, key, value: String(value), description: 'Platform login branding' });
      }
    } else {
      // Tenant default → default_configs (upsert; never delete a default)
      const { data: existing } = await sb.from('default_configs').select('key').eq('key', key).maybeSingle();
      if (existing) await sb.from('default_configs').update({ value: String(value ?? ''), updated_at: new Date().toISOString() }).eq('key', key);
      else await sb.from('default_configs').insert({ key, value: String(value ?? ''), description: 'Platform default' });
    }
  }
  // Invalidate the cached defaults so changes take effect immediately
  _defaultConfigsCache = undefined;
  return { status: 'ok' };
}

async function _forceSignOut(body) {
  // Admin-only: invalidate session without changing active status
  const { data: caller } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
  if (!caller || caller.role !== 'admin') return { status: 'error', message: 'Admin only.' };

  const { staffId } = body;
  if (!staffId) return { status: 'error', message: 'staffId required.' };

  const { data: staffRow } = await sb.from('staff').select('auth_id, name').eq('staff_id', staffId).maybeSingle();
  if (!staffRow) return { status: 'error', message: 'Staff member not found.' };

  // Force sign out ejects the user's OPEN tab but must let them log back in right
  // away. The staff portal authenticates data calls with the SERVICE-ROLE key and
  // identifies the user by staff_id in localStorage \u2014 it does NOT use the Auth
  // session for queries \u2014 so an Auth ban does nothing to an open tab and only
  // blocks re-login (which we do NOT want here). Instead we stamp force_logout_at;
  // the portal's periodic re-check compares it to the tab's session-start time and
  // ejects if newer. On next login the new session-start is later, so they're in.
  await sb.from('staff').update({ force_logout_at: new Date().toISOString() }).eq('staff_id', staffId);

  await _audit({
    action: 'staff_force_signout', entityType: 'staff', entityId: staffId,
    staffId: body.uuid, summary: 'Session force signed out: ' + staffRow.name
  });

  return { status: 'ok' };
}


async function _deleteStaffAccount(body) {
  // Only admins can delete staff accounts
  const { data: caller } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
  if (!caller || caller.role !== 'admin') return { status: 'error', message: 'Only admins can delete staff accounts.' };

  const { staffId } = body;
  if (!staffId) return { status: 'error', message: 'staffId required.' };

  // Get the auth_id before deleting
  const { data: staffRow } = await sb.from('staff').select('auth_id, name, email, role').eq('staff_id', staffId).maybeSingle();
  if (!staffRow) return { status: 'error', message: 'Staff account not found.' };

  // Deactivate the staff row first
  await sb.from('staff').update({ active: false }).eq('staff_id', staffId);

  // Delete the Supabase Auth user if we have their auth_id
  if (staffRow.auth_id) {
    await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + staffRow.auth_id, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
  }

  await _audit({
    action: 'staff_account_deleted', entityType: 'staff', entityId: staffId,
    staffId: body.uuid, summary: 'Account deleted: ' + staffRow.name + ' (' + staffRow.email + ')'
  });

  return { status: 'ok' };
}


async function _toggleStaffAuth(body) {
  // Admin-only: ban or unban a staff member's Supabase Auth account immediately
  const { data: caller } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
  if (!caller || caller.role !== 'admin') return { status: 'error', message: 'Admin only.' };

  const { staffId, active } = body; // active = what we're setting it TO
  if (!staffId) return { status: 'error', message: 'staffId required.' };

  // Get auth_id
  const { data: staffRow } = await sb.from('staff').select('auth_id, name').eq('staff_id', staffId).maybeSingle();
  if (!staffRow?.auth_id) return { status: 'ok', message: 'No auth_id on record \u2014 DB only updated.' };

  // Ban = set ban_duration to a very long time; unban = set to "none"
  const banDuration = active ? 'none' : '876000h';
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + staffRow.auth_id, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ban_duration: banDuration })
  });

  const resData = await res.json().catch(() => ({}));
  console.log('[toggleStaffAuth] status:', res.status, 'response:', resData);

  if (!res.ok) {
    return { status: 'error', message: 'Auth ban failed (' + res.status + '): ' + (resData.message || resData.msg || JSON.stringify(resData)) };
  }

  // The ban above gates the user's next login/refresh. The open tab is ejected by
  // the staff portal's periodic active re-check (_resolveAccess returns non-'staff'
  // once active=false). No session-subpath call \u2014 those 404 on this GoTrue version.

  await _audit({
    action: active ? 'staff_account_activated' : 'staff_account_deactivated',
    entityType: 'staff', entityId: staffId,
    staffId: body.uuid,
    summary: (active ? 'Activated' : 'Deactivated') + ' account: ' + staffRow.name
  });

  return { status: 'ok' };
}

async function _resetStaffPassword(body) {
  // Admin-only: set a new password for a staff member
  const { data: caller } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
  if (!caller || caller.role !== 'admin') return { status: 'error', message: 'Admin only.' };

  const { staffId, newPassword } = body;
  if (!staffId || !newPassword) return { status: 'error', message: 'staffId and newPassword required.' };
  if (newPassword.length < 8) return { status: 'error', message: 'Password must be at least 8 characters.' };

  const { data: staffRow } = await sb.from('staff').select('auth_id, name, email').eq('staff_id', staffId).maybeSingle();
  if (!staffRow?.auth_id) return { status: 'error', message: 'No auth account linked to this staff member.' };

  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + staffRow.auth_id, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    },
    body: JSON.stringify({ password: newPassword })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { status: 'error', message: 'Password reset failed: ' + (err.message || res.status) };
  }

  await _audit({
    action: 'staff_password_reset', entityType: 'staff', entityId: staffId,
    staffId: body.uuid, summary: 'Password reset for: ' + staffRow.name + ' (' + staffRow.email + ')'
  });

  return { status: 'ok' };
}

async function _resetClientPassword(body) {
  const { uuid, clientId, newPassword, notifyEmail } = body;
  if (!uuid || !clientId || !newPassword) return { status: 'error', message: 'Missing required fields.' };
  if (newPassword.length < 8) return { status: 'error', message: 'Password must be at least 8 characters.' };
  _setEmailCompany(await _companyIdFor(uuid, false));

  // Get staff info for audit
  const { data: staffRow } = await sb.from('staff').select('name, role').eq('staff_id', uuid).maybeSingle();
  const staffName = staffRow?.name || uuid;

  // Get client auth_id + contact details
  const { data: client } = await sb.from('clients')
    .select('auth_id, email, given_name')
    .eq('id', clientId)
    .maybeSingle();
  if (!client) return { status: 'error', message: 'Client not found.' };
  if (!client.auth_id) return { status: 'error', message: 'This client has no linked auth account. They may not have completed sign-up.' };

  // Force-set password via Supabase Admin API (same pattern as _resetStaffPassword)
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + client.auth_id, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    },
    body: JSON.stringify({ password: newPassword })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { status: 'error', message: 'Password reset failed: ' + (err.message || res.status) };
  }

  // Audit
  await _audit({
    staffId: uuid, staffName,
    action: 'client_password_reset',
    entityType: 'client',
    entityId: clientId,
    clientId,
    summary: 'Password reset for client: ' + (client.email || clientId) + ' by ' + staffName
  });

  // Send email if requested
  if (notifyEmail && client.email) {
    if (await _isEmailEnabled('password_reset_client', 'client')) {
      const name = client.given_name || 'there';
      // Build email body directly — avoids _resolveTemplate collapsing {password} to plain text
      const _pwBox = '<div style="background:#F7F6F4;border:1px solid #E2E0DB;border-radius:8px;padding:14px 18px;font-family:monospace;font-size:18px;font-weight:700;letter-spacing:.08em;color:#1A1A1F;margin:14px 0;text-align:center">' + newPassword + '</div>';
      const _bodyHtml =
        '<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">Hi ' + name + ',</p>' +
        '<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">Your client portal password has been reset by our team. Your temporary password is:</p>' +
        _pwBox +
        '<p style="margin:0 0 14px;color:#444;font-size:15px;line-height:1.7">Please log in and change your password as soon as possible. If you did not request this change, contact us immediately.</p>';
      await _sendEmail(
        client.email,
        'Your password has been reset',
        await _emailHtml('Password Reset', _bodyHtml, 'Log In Now', '')
      );
    }
  }

  // Mark client must-change-password on next login
  const { error: flagErr } = await sb.from('clients').update({ must_change_password: true }).eq('id', clientId);
  if (flagErr) console.error('[resetClientPassword] Failed to set must_change_password flag:', flagErr.message);

  return { status: 'ok' };
}


async function _changePassword(body) {
  // userEmail is passed from the frontend (STATE.access.email) to avoid
  // calling sb.auth.getUser() which fails because sb uses service role key
  const { currentPassword, newPassword, userEmail } = body;
  if (!currentPassword || !newPassword) return { status: 'error', message: 'Current and new password are required.' };
  if (!userEmail) return { status: 'error', message: 'Could not verify current session.' };
  if (newPassword.length < 8) return { status: 'error', message: 'New password must be at least 8 characters.' };
  if (currentPassword === newPassword) return { status: 'error', message: 'New password must be different from current password.' };

  // Re-authenticate with current password using a throwaway client (no stored session)
  const sbCheck = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { error: authErr } = await sbCheck.auth.signInWithPassword({ email: userEmail, password: currentPassword });
  if (authErr) return { status: 'error', message: 'Current password is incorrect.' };

  // Re-auth succeeded -- update password via the throwaway client (same verified session)
  const { error: updateErr } = await sbCheck.auth.updateUser({ password: newPassword });
  if (updateErr) return { status: 'error', message: updateErr.message };

  return { status: 'ok' };
}

async function _forceChangePassword(body) {
  const { uuid, newPassword } = body;
  if (!uuid || !newPassword) return { status: 'error', message: 'Missing required fields.' };
  if (newPassword.length < 8) return { status: 'error', message: 'Password must be at least 8 characters.' };

  // Look up client auth_id
  const { data: client } = await sb.from('clients')
    .select('auth_id, email')
    .eq('id', uuid)
    .maybeSingle();
  if (!client) return { status: 'error', message: 'Client not found.' };
  if (!client.auth_id) return { status: 'error', message: 'No linked auth account found.' };

  // Force-set password via Supabase Admin API (no current password needed)
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + client.auth_id, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    },
    body: JSON.stringify({ password: newPassword })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { status: 'error', message: 'Password update failed: ' + (err.message || res.status) };
  }

  // Clear the force-change flag
  await sb.from('clients').update({ must_change_password: false }).eq('id', uuid);

  return { status: 'ok' };
}

async function _changeEmail(body) {
  // Request email change -- uses the client's stored JWT directly since
  // sb uses service role key and has no user session
  const { newEmail, accessToken } = body;
  if (!newEmail) return { status: 'error', message: 'New email is required.' };
  if (!newEmail.includes('@')) return { status: 'error', message: 'Please enter a valid email address.' };
  if (!accessToken) return { status: 'error', message: 'Session not found. Please sign in again.' };

  // PATCH /auth/v1/user with the user's own JWT -- Supabase sends verification to new address
  const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + accessToken
    },
    body: JSON.stringify({ email: newEmail })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: 'error', message: data.message || data.msg || data.error_description || 'Failed to update email.' };

  return { status: 'ok' };
}


// ── My Documents — client portal ──────────────────────────────────────────────

async function _getMyDocuments(body) {
  // Get all non-cancelled plan cards for this client
  const { data: planCards, error: pcErr } = await sb.from('plan_cards')
    .select('plan_card_id, plan_name, friendly_name, billing_cycle, status, current_period_start, current_period_end, activated_at, mail_limit, parcel_limit, auto_feature, location_id, plan_memo')
    .eq('client_id', body.uuid)
    .is('canceled_at', null)
    .order('activated_at', { ascending: false });

  if (pcErr) return { status: 'error', message: pcErr.message };

  const results = [];
  for (const pc of (planCards || [])) {
    // Get location address
    const { data: loc } = await sb.from('locations')
      .select('name, address, city, province, postal_code, phone, email, timezone')
      .eq('location_id', pc.location_id).maybeSingle();
    if (loc && loc.timezone !== undefined) LOC_TZ_MAP[pc.location_id] = loc.timezone || null;

    // Get active recipients for this plan card
    const { data: recs } = await sb.from('recipients')
      .select('recipient_id, name, status, notes')
      .eq('plan_card_id', pc.plan_card_id)
      .eq('status', 'active')
      .order('created_at', { ascending: true });

    // Filter out temp recipients (prefixed with TEMP: in notes)
    const permRecs = (recs || []).filter(r => !(r.notes && r.notes.startsWith('TEMP:')));

    results.push({ ...pc, location: loc || null, recipients: permRecs });
  }

  // Get this company's declarations (scoped to the client's company)
  const _docCompanyId = await _companyIdFor(body.uuid, true);
  // TENANT ISOLATION: no company -> no declarations (never read across tenants).
  let declarations = [];
  if (_docCompanyId) {
    // Defense-in-depth: limit declarations to global + the client's own plan-card
    // locations (payload hygiene; per-card filtering still happens client-side).
    const _clientLocIds = [...new Set((planCards || []).map(pc => pc.location_id).filter(Boolean))];
    const { data: _decl } = await sb.from('document_declarations')
      .select('*')
      .eq('type', 'proof_of_address')
      .eq('enabled', true)
      .eq('company_id', _docCompanyId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    declarations = (_decl || []).filter(d =>
      d.scope === 'global' || _clientLocIds.includes(d.scope)
    );
  }

  // Get company branding from config (scoped to the client's company).
  // Brandable keys fall back to platform defaults; resend_* stay per-company (secrets).
  const cfg = await _mergedConfig(_docCompanyId, ['branding_company_name', 'branding_logo_url',
    'branding_logo_enabled', 'email_accent_color', 'email_footer_text']);
  // TENANT ISOLATION: resend_* are per-company secrets — only read them scoped to
  // a real company. With no company, skip (never read secrets across all tenants).
  if (_docCompanyId) {
    const { data: _resendRows } = await sb.from('config').select('key, value')
      .eq('company_id', _docCompanyId)
      .in('key', ['resend_from', 'resend_reply_to', 'resend_from_name']);
    for (const r of (_resendRows || [])) cfg[r.key] = r.value;
  }

  return {
    status: 'ok',
    planCards: results,
    declarations: declarations || [],
    branding: cfg
  };
}

async function _getDocumentDeclarations(body) {
  const _ddCompanyId = body.uuid ? await _companyIdFor(body.uuid, false) : null;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!_ddCompanyId) return { status: 'ok', declarations: [] };
  const { data, error } = await sb.from('document_declarations').select('*')
    .eq('company_id', _ddCompanyId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok', declarations: data || [] };
}

async function _saveDeclaration(body) {
  const { id, type, scope, text, sort_order } = body;
  if (!text?.trim()) return { status: 'error', message: 'Declaration text is required.' };
  if (id) {
    const { error } = await sb.from('document_declarations')
      .update({ text: text.trim(), type: type || 'proof_of_address', scope: scope || 'global', sort_order: sort_order || 0 })
      .eq('id', id);
    if (error) return { status: 'error', message: error.message };
  } else {
    const _ddCompanyId = body.uuid ? await _companyIdFor(body.uuid, false) : null;
    if (!_ddCompanyId) return { status: 'error', message: 'Could not determine company for this declaration.' };
    const { error } = await sb.from('document_declarations')
      .insert({ company_id: _ddCompanyId, text: text.trim(), type: type || 'proof_of_address', scope: scope || 'global', sort_order: sort_order || 0, enabled: true });
    if (error) return { status: 'error', message: error.message };
  }
  return { status: 'ok' };
}

async function _deleteDeclaration(body) {
  const { id } = body;
  if (!id) return { status: 'error', message: 'ID required.' };
  const { error } = await sb.from('document_declarations').delete().eq('id', id);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}

async function _reorderDeclarations(body) {
  const { order } = body; // array of {id, sort_order}
  if (!Array.isArray(order)) return { status: 'error', message: 'Invalid order array.' };
  for (const item of order) {
    const { error } = await sb.from('document_declarations')
      .update({ sort_order: item.sort_order })
      .eq('id', item.id);
    if (error) return { status: 'error', message: error.message };
  }
  return { status: 'ok' };
}

async function _getLocationsForDecl(body) {
  // Scope to the caller's company (admin-only action; body.uuid is the staff_id).
  const _cid = await _companyIdFor(body.uuid, false);
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!_cid) return { status: 'ok', locations: [] };
  let _q = sb.from('locations')
    .select('location_id, name')
    .eq('active', true)
    .eq('company_id', _cid);
  const { data, error } = await _q.order('name');
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok', locations: data || [] };
}


async function _toggleDeclaration(body) {
  const { id, enabled } = body;
  if (!id) return { status: 'error', message: 'ID required.' };
  const enabledBool = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
  const { error } = await sb.from('document_declarations').update({ enabled: enabledBool }).eq('id', id);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}


// ============================================================
// STAFF WRITES
// ============================================================

async function _clearExpiredScans(body) {
  // Must be called by an admin \u2014 scoped company-wide (all locations).
  const { data: staff } = await sb.from('staff')
    .select('company_id, role')
    .eq('staff_id', body.uuid).maybeSingle();

  if (!staff || staff.role !== 'admin') {
    return { status: 'error', message: 'Unauthorised' };
  }
  const companyId = staff.company_id;
  if (!companyId) return { status: 'error', message: 'No company assigned to this admin' };

  const now = new Date().toISOString();

  // Find all expired scan rows for this company (every location)
  const { data: rows, error: fetchErr } = await sb.from('mail_log')
    .select('mail_id, scan_image_url')
    .eq('company_id', companyId)
    .lt('scan_expires_at', now)
    .not('scan_image_url', 'is', null)
    .neq('scan_image_url', '');

  if (fetchErr) return { status: 'error', message: fetchErr.message };
  if (!rows || rows.length === 0) return { status: 'ok', deleted: 0 };

  // Extract storage paths from public URLs
  // Format: https://{ref}.supabase.co/storage/v1/object/public/scan-images/{path}
  const paths = [];
  const mailIds = [];
  for (const row of rows) {
    const match = row.scan_image_url.match(/\/object\/public\/scan-images\/(.+)$/);
    if (match) {
      paths.push(decodeURIComponent(match[1]));
      mailIds.push(row.mail_id);
    }
  }

  // Delete files from storage bucket
  if (paths.length > 0) {
    await sb.storage.from('scan-images').remove(paths);
    // Non-fatal \u2014 even if some files are already gone, continue to clean DB
  }

  // Null out scan columns on all matched rows for this company
  const { error: updateErr } = await sb.from('mail_log')
    .update({ scan_image_url: null, scan_expires_at: null })
    .eq('company_id', companyId)
    .lt('scan_expires_at', now)
    .not('scan_image_url', 'is', null);

  if (updateErr) return { status: 'error', message: updateErr.message };

  await _audit({ staffId: body.uuid, action: 'scans_cleared', entityType: 'company', summary: 'Cleared ' + paths.length + ' expired scan' + (paths.length !== 1 ? 's' : '') + ' company-wide' });
  return { status: 'ok', deleted: paths.length };
}

async function _uploadScanImage(body) {
  // body.fileData = base64 string, body.fileName, body.mimeType, body.staffId
  if (!body.fileData || !body.fileName || !body.mimeType) {
    return { status: 'error', message: 'Missing file data' };
  }

  // Decode base64 to binary
  const byteChars = atob(body.fileData);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: body.mimeType });

  // Build a unique path: scans/{staffId}/{timestamp}_{sanitized filename}
  const ts = Date.now();
  const safe = body.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `scans/${body.staffId || 'staff'}/${ts}_${safe}`;

  const { data, error } = await sb.storage.from('scan-images').upload(path, blob, {
    contentType: body.mimeType,
    upsert: false
  });

  if (error) return { status: 'error', message: error.message };

  const { data: urlData } = sb.storage.from('scan-images').getPublicUrl(path);
  return { status: 'ok', url: urlData.publicUrl, path };
}

async function _logMail(body) {
  const mailId = _genId('ML');
  const now = new Date().toISOString();
  // Storage dates are PLACE dates — compute "today" in the mail's location zone so
  // a late-evening intake in a behind-UTC location doesn't stamp tomorrow's date.
  let _mailTz = locTz(body.locationId);
  if (body.locationId && (!LOC_TZ_MAP[body.locationId])) {
    try {
      const { data: _lz } = await sb.from('locations').select('timezone').eq('location_id', body.locationId).maybeSingle();
      if (_lz && _lz.timezone) { LOC_TZ_MAP[body.locationId] = _lz.timezone; _mailTz = _lz.timezone; }
    } catch (e) { /* fall back to company default already in _mailTz */ }
  }
  const today = _localToday(_mailTz);
  const companyId = await _companyIdFor(body.uuid, false);
  _setEmailCompany(companyId);

  let storageDays = 30;
  let autoFeature = null;
  if (body.planCardId) {
    const { data: pc } = await sb.from('plan_cards')
      .select('mail_storage_days, parcel_storage_days, auto_feature')
      .eq('plan_card_id', body.planCardId).maybeSingle();
    if (pc) {
      storageDays = body.type === 'parcel' ? pc.parcel_storage_days : pc.mail_storage_days;
      autoFeature = pc.auto_feature;
    }
  }
  const dueDate = _addDays(today, storageDays);

  // Get subscription access_status
  let subStatus = null;
  if (body.subscriptionId) {
    const { data: s } = await sb.from('subscriptions').select('access_status')
      .eq('id', body.subscriptionId).maybeSingle();
    subStatus = s?.access_status || null;
  }

    // \u2500\u2500 Auto-status based on plan type & flags \u2500\u2500
    const isSpecial      = body.specialCase === true || body.specialCase === 'true';
    const isConfidential = body.confidential === true || body.confidential === 'true';
    const isParcel       = (body.type || 'letter') === 'parcel';
    let autoStatus = 'ready_for_pickup';
    if (isSpecial) {
      autoStatus = 'pending_assignment';
    } else if (isConfidential) {
      autoStatus = 'confidential_pickup';
    } else if (autoFeature === 'ship' && !isParcel) {
      autoStatus = 'forwarding_queued';
    }

    const { error } = await sb.from('mail_log').insert({
    mail_id:              mailId,
    company_id:           companyId,
    logged_at:            now,
    logged_by:            body.uuid,
    location_id:          body.locationId,
    recipient_id:         body.recipientId || null,
    recipient_name:       body.recipientName || null,
    plan_card_id:         body.planCardId || null,
    client_id:            body.clientId || null,
    subscription_id:      body.subscriptionId || null,
    subscription_status:  subStatus,
    special_case:         isSpecial,
    special_case_reason:  body.specialCaseReason || null,
    type:                 body.type || 'letter',
    confidential:         isConfidential,
    sender_name:          body.senderName || null,
    physical_location:    body.physicalLocation || null,
    scan_image_url:       body.scanImageUrl || null,
    scan_expires_at:      body.scanExpiresAt || null,
    note_to_client:       body.noteToClient || null,
    note_internal:        body.noteInternal || null,
    piece_count:          parseInt(body.pieceCount) || 1,
    status:               autoStatus,
    status_changed_at:    now,
    status_changed_by:    body.uuid,
    storage_start_date:   today,
    storage_due_date:     dueDate
  });
  if (error) return { status: 'error', message: error.message };

  // Usage is now computed live from mail_log \u2014 no counter increment needed
  // Mark recipient has_mail_logged
  if (body.recipientId) {
    await sb.from('recipients').update({ has_mail_logged: true }).eq('recipient_id', body.recipientId);
  }

  await _audit({
    staffId: body.uuid, action: 'mail_logged', entityType: 'mail', entityId: mailId,
    clientId: body.clientId, planCardId: body.planCardId, locationId: body.locationId,
    mailId, recipientName: body.recipientName,
    summary: `Logged ${body.type || 'letter'} for ${body.recipientName || '\u2014'} from ${body.senderName || '\u2014'}`,
    details: { type: body.type, senderName: body.senderName, recipientName: body.recipientName, specialCase: body.specialCase, confidential: body.confidential, pieceCount: body.pieceCount }
  });

  // Notify client
  if (body.clientId) {
    const typeLabel = (body.type || 'letter') === 'parcel' ? 'parcel' : 'mail';
    await _createNotification('client', body.clientId, 'mail_received', 'New ' + typeLabel + ' received', 'From ' + (body.senderName || 'unknown sender') + (body.recipientName ? ' for ' + body.recipientName : ''), 'mail', body.subscriptionId || mailId, mailId);
    // Email
    if (await _isEmailEnabled('mail_received', 'client')) {
      const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', body.clientId).maybeSingle();
      if (cl?.email) {
        const name = cl.given_name || 'there';
        const _tpl1 = await _resolveTemplate('mail_received', {
          name, type: typeLabel,
          sender: body.senderName || '',
          recipient: body.recipientName || '',
          recipient_line: body.recipientName ? ' for ' + body.recipientName : '',
          sender_line: body.senderName ? ' from ' + body.senderName : ''
        });
        await _sendEmail(cl.email, _tpl1.subject, await _emailHtml(_tpl1.subject, _tpl1.bodyHtml, _tpl1.ctaEnabled ? _tpl1.ctaLabel : '', _tpl1.ctaEnabled ? _tpl1.ctaUrl : ''));
      }
    }
  }

  return { status: 'ok', mailId };
}

async function _resolveTask(body) {
  // Get task first to check if recurring
  const { data: task } = await sb.from('tasks').select('*').eq('task_id', body.taskId).maybeSingle();
  if (!task) return { status: 'error', message: 'Task not found' };
  if (task.type === 'payment_failed') return { status: 'error', message: 'Payment failed tasks auto-resolve when payment succeeds. They cannot be manually completed.' };
  if (task.type === 'cancellation_request') return { status: 'error', message: 'Cancellation tasks must be resolved using the Cancellation Processed or Client Kept Plan buttons.' };
  if (task.type === 'id_verification') return { status: 'error', message: 'ID verification tasks resolve automatically when you approve or reject the ID in the ID Verify screen. They cannot be manually completed.' };

  const now = new Date().toISOString();
  const { error, data: updated } = await sb.from('tasks').update({
    status: 'resolved',
    resolved_at: now,
    resolved_by: body.uuid,
    resolution_note: body.resolutionNote || null,
    checklist: body.checklist || task.checklist
  }).eq('task_id', body.taskId).select();
  if (error) return { status: 'error', message: error.message };

  // If recurring AND recurring is still active, create next instance
  if (task.type === 'recurring' && task.recurring_config && task.recurring_config.active !== false) {
    const cfg = task.recurring_config;
    const freq = cfg.frequency;
    // Case L: advance on the COMPANY calendar (tasks are company-level), not the
    // server/browser clock — otherwise due_date can land a day off near midnight.
    const _tz = COMPANY_DEFAULT_TZ || 'America/Toronto';
    const [_cy, _cm, _cd] = new Date().toLocaleDateString('en-CA', { timeZone: _tz, year: 'numeric', month: '2-digit', day: '2-digit' }).split('-').map(Number);
    let _ny = _cy, _nm0 = _cm - 1, _nd = _cd; // _nm0 zero-based
    if (freq === 'daily') _nd += 1;
    else if (freq === 'weekly') _nd += 7;
    else if (freq === 'biweekly') _nd += 14;
    else if (freq === 'monthly') _nm0 += 1;
    const next = new Date(Date.UTC(_ny, _nm0, _nd, 12, 0, 0)); // noon-UTC guard against any tz slip

    // Check if next instance would be past the end date
    const nextDateStr = next.toISOString().split('T')[0];
    if (cfg.end_date && nextDateStr > cfg.end_date) {
      // Past end date \u2014 don't create next instance, mark config as stopped
      await sb.from('tasks').update({ recurring_config: { ...cfg, active: false } }).eq('task_id', body.taskId);
    } else {
      await sb.from('tasks').insert({
        task_id: 'TSK' + Date.now().toString(36).toUpperCase(),
        company_id: task.company_id,
        type: 'recurring', notes: task.notes, description: task.description,
        priority: task.priority || 'medium', status: 'open',
        location_id: task.location_id, assigned_to: task.assigned_to,
        created_by: task.created_by, due_date: nextDateStr,
        recurring_config: { ...cfg, active: true, next_run: next.toISOString(), parent_id: task.task_id },
        created_at: now
      });
    }
  }

  await _audit({ staffId: body.uuid, action: 'task_resolved', entityType: 'task', entityId: body.taskId, summary: 'Task resolved: ' + (task.notes || body.taskId) });
  return { status: 'ok' };
}

async function _snoozeTask(body) {
  const { error } = await sb.from('tasks').update({
    status: 'snoozed',
    snoozed_until: body.snoozeUntil
  }).eq('task_id', body.taskId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: 'task_snoozed', entityType: 'task', entityId: body.taskId, summary: 'Task snoozed until ' + (body.snoozeUntil || '').split('T')[0] });
  return { status: 'ok' };
}

async function _unsnoozeTask(body) {
  // Check permissions: staff can only unsnooze own tasks, admin can unsnooze any
  const { data: staff } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
  const isAdmin = staff?.role === 'admin';
  if (!isAdmin) {
    const { data: task } = await sb.from('tasks').select('assigned_to').eq('task_id', body.taskId).maybeSingle();
    if (task && task.assigned_to && task.assigned_to !== body.uuid) {
      return { status: 'error', message: 'Only admin can unsnooze tasks assigned to other staff' };
    }
  }
  const { error } = await sb.from('tasks').update({ status: 'open', snoozed_until: null }).eq('task_id', body.taskId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: 'task_unsnoozed', entityType: 'task', entityId: body.taskId, summary: 'Task unsnoozed manually' });
  return { status: 'ok' };
}

async function _stopRecurring(body) {
  const { data: task } = await sb.from('tasks').select('recurring_config').eq('task_id', body.taskId).maybeSingle();
  if (!task) return { status: 'error', message: 'Task not found' };
  const cfg = task.recurring_config || {};
  cfg.active = false;
  const { error } = await sb.from('tasks').update({ recurring_config: cfg }).eq('task_id', body.taskId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: 'task_recurring_stopped', entityType: 'task', entityId: body.taskId, summary: 'Recurring task stopped' });
  return { status: 'ok' };
}

async function _deleteTask(body) {
  // Delete comments first
  await sb.from('task_comments').delete().eq('task_id', body.taskId);
  const { error } = await sb.from('tasks').delete().eq('task_id', body.taskId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: 'task_deleted', entityType: 'task', entityId: body.taskId, summary: 'Task deleted: ' + body.taskId });
  return { status: 'ok' };
}

async function _releaseMail(body) {
  _setEmailCompany(await _companyIdFor(body.uuid, false));
  const now = new Date().toISOString();
  const mailIds = body.mailIds ? JSON.parse(body.mailIds) : [body.mailId];

  // Block release if client ID is not verified
  // Look up client from mail item if not provided in body
  let releaseClientId = body.clientId;
  if (!releaseClientId && mailIds.length) {
    const { data: firstItem } = await sb.from('mail_log').select('client_id')
      .eq('mail_id', mailIds[0]).maybeSingle();
    if (firstItem) releaseClientId = firstItem.client_id;
  }
  if (releaseClientId) {
    const { data: client } = await sb.from('clients').select('id_verification_status')
      .eq('id', releaseClientId).maybeSingle();
    if (client && client.id_verification_status !== 'approved') {
      return { status: 'error', message: 'Mail release blocked \u2014 client ID verification is ' + (client.id_verification_status || 'not submitted') + '. ID must be verified before mail can be released.' };
    }
  }
  
  // Determine who's picking up
  let pickedUpByName = 'Account Holder';
  let pickedUpBy = body.clientId || 'account_holder';
  if (body.agentId && body.agentId !== 'account_holder') {
    const { data: agent } = await sb.from('pickup_agents').select('name')
      .eq('agent_id', body.agentId).maybeSingle();
    if (agent) pickedUpByName = agent.name;
    pickedUpBy = body.agentId;
  }

  const results = [];
  // If release notes provided, fetch existing note_internal per item so we can append, not overwrite
  const releaseNotes = (body.releaseNotes || '').trim();
  let existingNotes = {};
  if (releaseNotes && mailIds.length) {
    const { data: noteRows } = await sb.from('mail_log')
      .select('mail_id, note_internal')
      .in('mail_id', mailIds);
    (noteRows || []).forEach(r => { existingNotes[r.mail_id] = r.note_internal || ''; });
  }

  for (const mailId of mailIds) {
    const updateFields = {
      status: 'picked_up',
      picked_up_by: pickedUpBy,
      picked_up_by_name: pickedUpByName,
      picked_up_at: now,
      status_changed_at: now,
      status_changed_by: body.uuid
    };
    if (body.uuid) updateFields.action_performed_by = body.uuid;
    if (body.staffName) updateFields.action_performed_by_name = body.staffName;
    if (releaseNotes) {
      const existing = existingNotes[mailId] || '';
      updateFields.note_internal = existing
        ? existing + '\n\u2014 Release: ' + releaseNotes
        : 'Release: ' + releaseNotes;
    }
    const { error } = await sb.from('mail_log').update(updateFields).eq('mail_id', mailId);
    results.push({ mailId, status: error ? 'error' : 'ok', message: error?.message });
  }
  await _audit({
    staffId: body.uuid, action: 'mail_released', entityType: 'mail',
    summary: `Released ${mailIds.length} item${mailIds.length>1?'s':''} to ${pickedUpByName}`,
    details: { mailIds, agentId: body.agentId, agentName: pickedUpByName, releaseNotes }
  });

  // Notify client of pickup
  if (releaseClientId) {
    await _createNotification("client", releaseClientId, "mail_picked_up", "Mail picked up", mailIds.length + " item" + (mailIds.length > 1 ? "s" : "") + " picked up by " + pickedUpByName, "mail", mailIds[0]);
    // Email
    if (await _isEmailEnabled('mail_picked_up', 'client')) {
      const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', releaseClientId).maybeSingle();
      if (cl?.email) {
        const name = cl.given_name || 'there';
        const cnt = mailIds.length;
        const _tpl2 = await _resolveTemplate('mail_picked_up', {
          name, count: String(cnt), agent: pickedUpByName || '',
          count_plural: cnt > 1 ? 's have' : ' has'
        });
        await _sendEmail(cl.email, _tpl2.subject, await _emailHtml(_tpl2.subject, _tpl2.bodyHtml, _tpl2.ctaEnabled ? _tpl2.ctaLabel : '', _tpl2.ctaEnabled ? _tpl2.ctaUrl : ''));
      }
    }
  }
  return { status: 'ok', results, count: mailIds.length };
}

async function _bulkForwardMail(body) {
  const now = new Date().toISOString();
  const mailIds = JSON.parse(body.mailIds || '[]');

  // Block forwarding if client not verified
  if (mailIds.length) {
    const { data: firstItem } = await sb.from('mail_log').select('client_id').eq('mail_id', mailIds[0]).maybeSingle();
    if (firstItem?.client_id) {
      const { data: client } = await sb.from('clients').select('id_verification_status').eq('id', firstItem.client_id).maybeSingle();
      if (client && client.id_verification_status !== 'approved') {
        return { status: 'error', message: 'Forwarding blocked \u2014 client ID verification is ' + (client.id_verification_status || 'not submitted') + '.' };
      }
    }
  }

  const trackingNumber = body.trackingNumber || null;
  const noteToClient = body.noteToClient || null;
  const noteInternal = body.noteInternal || null;
  const results = [];
  for (const mailId of mailIds) {
    const itemTracking = body.trackingNumbers
      ? (JSON.parse(body.trackingNumbers)[mailId] || trackingNumber)
      : trackingNumber;
    const updateFields = {
      status: 'forwarded',
      forwarded_at: now,
      tracking_number: itemTracking,
      status_changed_at: now,
      status_changed_by: body.uuid
    };
    if (noteToClient) updateFields.note_to_client = noteToClient;
    if (noteInternal) updateFields.note_internal = noteInternal;
    if (body.uuid) updateFields.action_performed_by = body.uuid;
    if (body.staffName) updateFields.action_performed_by_name = body.staffName;
    const { error } = await sb.from('mail_log').update(updateFields).eq('mail_id', mailId);
    results.push({ mailId, status: error ? 'error' : 'ok', message: error?.message });
  }
  await _audit({
    staffId: body.uuid, action: 'mail_forwarded', entityType: 'mail',
    summary: `Forwarded ${mailIds.length} item${mailIds.length>1?'s':''}`,
    details: { mailIds, trackingNumber: body.trackingNumber, noteToClient: body.noteToClient }
  });

  return { status: 'ok', results, count: mailIds.length };
}

async function _assignMailRecipient(body) {
  _setEmailCompany(await _companyIdFor(body.uuid, false));
  const now = new Date().toISOString();
  const today = _localToday();

  // Check subscription status \u2014 block assignment to cancelled plans
  if (body.subscriptionId) {
    const { data: sub } = await sb.from('subscriptions').select('access_status')
      .eq('id', body.subscriptionId).maybeSingle();
    if (sub && sub.access_status === 'CANCELED') {
      return { status: 'error', message: 'Cannot assign \u2014 this plan is cancelled.' };
    }
  }

  // Get the mail item to check type/confidential FIRST
  const { data: item } = await sb.from('mail_log')
    .select('type, confidential')
    .eq('mail_id', body.mailId).maybeSingle();

  const isParcel = item?.type === 'parcel';
  const isConf = item?.confidential;

  let storageDays = 30;
  let autoFeature = null;
  if (body.planCardId) {
    const { data: pc } = await sb.from('plan_cards').select('mail_storage_days, parcel_storage_days, auto_feature')
      .eq('plan_card_id', body.planCardId).maybeSingle();
    if (pc) {
      storageDays = isParcel ? (pc.parcel_storage_days || 14) : (pc.mail_storage_days || 30);
      autoFeature = pc.auto_feature;
    }
  }
  const dueDate = _addDays(today, storageDays);

  // Determine new status
  let newStatus = 'ready_for_pickup';
  if (isConf) {
    newStatus = 'confidential_pickup';
  } else if (autoFeature === 'ship' && !isParcel) {
    newStatus = 'forwarding_queued';
  }

  // Check if plan uses scan feature
  let needsScan = autoFeature === 'scan' && !isParcel && !isConf;

  // If scan plan and no scan URL provided, block assignment
  if (needsScan && !body.scanImageUrl) {
    return { status: 'error', message: 'Scan URL is required for this plan. Please provide a scanned file URL.', needsScan: true };
  }

  const updateFields = {
    recipient_id: body.recipientId,
    recipient_name: body.recipientName,
    plan_card_id: body.planCardId || null,
    client_id: body.clientId || null,
    subscription_id: body.subscriptionId || null,
    special_case: false,
    special_case_reason: null,
    status: newStatus,
    status_changed_at: now,
    status_changed_by: body.uuid,
    storage_start_date: today,
    storage_due_date: dueDate
  };
  // Clear old scan URL, set new one if provided
  updateFields.scan_image_url = body.scanImageUrl || null;
  updateFields.scan_expires_at = body.scanExpiresAt || null;

  const { error } = await sb.from('mail_log').update(updateFields).eq('mail_id', body.mailId);
  if (error) return { status: 'error', message: error.message };

  // Usage is now computed live from mail_log \u2014 no counter increment needed
  if (body.planCardId) {
    if (body.recipientId) {
      await sb.from('recipients').update({ has_mail_logged: true }).eq('recipient_id', body.recipientId);
    }
  }

  await _audit({
    staffId: body.uuid, action: 'mail_assigned', entityType: 'mail', entityId: body.mailId,
    clientId: body.clientId, planCardId: body.planCardId, mailId: body.mailId,
    recipientName: body.recipientName,
    summary: `Assigned ${body.mailId} to ${body.recipientName || '\u2014'} on ${body.planCardId}`,
    details: { recipientId: body.recipientId, recipientName: body.recipientName, planCardId: body.planCardId }
  });

  // Remove old notification for this mail and notify new client
  await _deleteNotificationsByRelated(body.mailId);
  if (body.clientId) {
    await _createNotification(
      'client', body.clientId, 'mail_reassigned',
      'Mail item assigned to your account',
      'A mail item has been assigned to your plan.',
      'mail', body.subscriptionId || body.mailId, body.mailId
    );
    // Email \u2014 reuse mail_received template
    if (await _isEmailEnabled('mail_received', 'client')) {
      const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', body.clientId).maybeSingle();
      if (cl?.email) {
        const name = cl.given_name || 'there';
        const typeLabel = (body.type || 'letter') === 'parcel' ? 'parcel' : 'mail';
        const _tplA = await _resolveTemplate('mail_received', {
          name, type: typeLabel,
          sender: body.senderName || '',
          recipient: body.recipientName || '',
          recipient_line: body.recipientName ? ' for ' + body.recipientName : '',
          sender_line: body.senderName ? ' from ' + body.senderName : ''
        });
        await _sendEmail(cl.email, _tplA.subject, await _emailHtml(_tplA.subject, _tplA.bodyHtml, _tplA.ctaEnabled ? _tplA.ctaLabel : '', _tplA.ctaEnabled ? _tplA.ctaUrl : ''));
      }
    }
  }
  return { status: 'ok', needsScan, newStatus };
}

async function _editMailItem(body) {
  // Fetch current item first
  const { data: current } = await sb.from('mail_log')
    .select('*')
    .eq('mail_id', body.mailId).maybeSingle();
  if (!current) return { status: 'error', message: 'Mail item not found' };

  // Block editing released/completed items
  const LOCKED = ['picked_up','forwarded','shredded','returned_to_sender','discarded'];
  if (LOCKED.includes(current.status)) {
    return { status: 'error', message: 'Cannot edit \u2014 item has already been ' + current.status.replace(/_/g,' ') };
  }

  // Check can_extend_storage permission upfront \u2014 needed for both the period guard and field guard below
  const { data: staffCheck } = await sb.from('staff').select('can_extend_storage, role').eq('staff_id', body.uuid).maybeSingle();
  const canExtendStorage = !!(staffCheck?.can_extend_storage);
  const isStorageOnlyEdit = body.storageDueDate !== undefined && Object.keys(body).filter(k =>
    !['action','uuid','mailId','storageDueDate'].includes(k)
  ).length === 0;

  // Block editing items in billed past periods UNLESS it's purely a storage extension by permitted staff
  if (current.plan_card_id && !isStorageOnlyEdit) {
    const { data: pcCheck } = await sb.from('plan_cards').select('last_billed_at, current_period_start, current_period_end')
      .eq('plan_card_id', current.plan_card_id).maybeSingle();
    if (pcCheck && pcCheck.last_billed_at && current.logged_at) {
      const loggedDate = current.logged_at.split('T')[0];
      const periodStart = pcCheck.current_period_start;
      // Only block if item is BEFORE the current period (i.e. in a past period)
      if (periodStart && loggedDate < periodStart) {
        return { status: 'error', message: 'Cannot edit \u2014 this item is in a billed period. Contact admin to adjust.' };
      }
    }
  }

  const updates = {};
  const now = new Date().toISOString();
  const fieldMap = {
    senderName: 'sender_name', type: 'type', confidential: 'confidential',
    physicalLocation: 'physical_location', scanImageUrl: 'scan_image_url',
    scanExpiresAt: 'scan_expires_at',
    noteToClient: 'note_to_client', noteInternal: 'note_internal',
    pieceCount: 'piece_count',
    recipientId: 'recipient_id', recipientName: 'recipient_name',
    planCardId: 'plan_card_id', clientId: 'client_id', subscriptionId: 'subscription_id',
    specialCase: 'special_case', specialCaseReason: 'special_case_reason',
    storageDueDate: 'storage_due_date'
  };

  // Enforce can_extend_storage permission
  if (body.storageDueDate !== undefined && !canExtendStorage) {
    return { status: 'error', message: 'Your account does not have permission to extend storage. Please contact your branch manager.' };
  }

  for (const [camel, snake] of Object.entries(fieldMap)) {
    if (body[camel] !== undefined) {
      let val = body[camel];
      if (val === 'TRUE' || val === 'true') val = true;
      if (val === 'FALSE' || val === 'false') val = false;
      // Convert empty strings to null for UUID/reference fields
      if (val === '' && ['recipient_id','plan_card_id','client_id','subscription_id'].includes(snake)) val = null;
      updates[snake] = val;
    }
  }
  if (Object.keys(updates).length === 0) return { status: 'ok' };

  // If type changed, recalculate storage_due_date from storage_start_date
  if (updates.type && updates.type !== current.type && current.plan_card_id) {
    const { data: pcInfo } = await sb.from('plan_cards')
      .select('mail_storage_days, parcel_storage_days')
      .eq('plan_card_id', current.plan_card_id).maybeSingle();
    if (pcInfo && current.storage_start_date) {
      const storageDays = updates.type === 'parcel'
        ? (pcInfo.parcel_storage_days || 14)
        : (pcInfo.mail_storage_days || 30);
      updates.storage_due_date = _addDays(current.storage_start_date, storageDays);
    }
  }

  // If converting to special case, clear recipient fields and set status
  if (updates.special_case === true && !current.special_case) {
    updates.recipient_id = null;
    updates.recipient_name = updates.recipient_name || current.recipient_name;
    updates.plan_card_id = null;
    updates.client_id = null;
    updates.subscription_id = null;
    updates.status = 'pending_assignment';
    updates.status_changed_at = now;
    updates.status_changed_by = body.uuid;
    // Usage is now computed live from mail_log \u2014 no counter decrement needed
    // Clear scan URL \u2014 special cases have no plan context
    updates.scan_image_url = null;
    updates.scan_expires_at = null;
  }

  // If making confidential, clear scan URL and set status
  if (updates.confidential === true) {
    // Parcels cannot be confidential
    if ((updates.type || current.type) === 'parcel') {
      updates.confidential = false;
    } else {
      updates.scan_image_url = null;
      updates.scan_expires_at = null;
      if (current.status !== 'pending_assignment') {
        updates.status = 'confidential_pickup';
        updates.status_changed_at = now;
        updates.status_changed_by = body.uuid;
      }
    }
  }

  // If removing confidential, revert status back to ready_for_pickup
  if (updates.confidential === false && current.confidential === true) {
    if (current.status === 'confidential_pickup') {
      updates.status = 'ready_for_pickup';
      updates.status_changed_at = now;
      updates.status_changed_by = body.uuid;
    }
  }

  // Prevent removing scan URL on scan plans (unless going confidential)
  if (updates.scan_image_url === null || updates.scan_image_url === '') {
    if (updates.confidential !== true && updates.special_case !== true) {
      const pcId = updates.plan_card_id || current.plan_card_id;
      if (pcId) {
        const { data: pc } = await sb.from('plan_cards').select('auto_feature').eq('plan_card_id', pcId).maybeSingle();
        const isParcel = (updates.type || current.type) === 'parcel';
        if (pc?.auto_feature === 'scan' && !isParcel) {
          return { status: 'error', message: 'Scan URL is required for scan plans. Cannot remove it.' };
        }
      }
    }
  }

  // Usage is now computed live from mail_log \u2014 no counter adjustment needed
  if (updates.recipient_id) {
    await sb.from('recipients').update({ has_mail_logged: true }).eq('recipient_id', updates.recipient_id);
  }

  // If scan URL is being set but no expiry provided, default to 30 days
  if (updates.scan_image_url && updates.scan_image_url !== '' && !updates.scan_expires_at) {
    const exp = new Date();
    exp.setDate(exp.getDate() + 30);
    updates.scan_expires_at = exp.toISOString();
  }

  const { error } = await sb.from('mail_log').update(updates).eq('mail_id', body.mailId);
  if (error) return { status: 'error', message: error.message };

  // Notification handling \u2014 only when recipient/plan actually changed
  const clientChanged     = updates.client_id     !== undefined && updates.client_id     !== current.client_id;
  const subChanged        = updates.subscription_id !== undefined && updates.subscription_id !== current.subscription_id;
  const becameSpecial     = updates.special_case === true && !current.special_case;

  if (clientChanged || subChanged) {
    // Delete old notification tied to this mail item
    await _deleteNotificationsByRelated(body.mailId);
    // Notify new client \u2014 only if actually assigned to someone (not becoming special case)
    const newClientId = updates.client_id;
    const newSubId    = updates.subscription_id || body.mailId;
    if (newClientId && !becameSpecial) {
      await _createNotification(
        'client', newClientId, 'mail_reassigned',
        'Mail item assigned to your account',
        'A mail item has been assigned to your plan.',
        'mail', newSubId, body.mailId
      );
    }
  } else if (becameSpecial) {
    // Item moved back to special case \u2014 just delete any existing notification
    await _deleteNotificationsByRelated(body.mailId);
  }

  // Audit: build summary of what changed
  const changedFields = Object.keys(updates).filter(k => k !== 'updated_at');
  await _audit({
    staffId: body.uuid, action: 'mail_edited', entityType: 'mail', entityId: body.mailId,
    mailId: body.mailId, recipientName: current.recipient_name,
    summary: `Edited ${body.mailId} \u2014 changed: ${changedFields.join(', ')}`,
    details: { fieldsChanged: changedFields, updates }
  });

  return { status: 'ok' };
}
async function _getOverageSummary(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', readyToBill: [], currentOverage: [] };

  const { data: cards } = await sb.from('plan_cards').select('*')
    .eq('location_id', locId).eq('status', 'active').eq('company_id', companyId);
  if (!cards || !cards.length) return { status: 'ok', readyToBill: [], currentOverage: [] };

  // Location tax (single location for this staffer's view; no hardwired rate).
  // Self-scoped to company_id — service role bypasses RLS, never trust location_id alone.
  const { data: _loc } = await sb.from('locations').select('tax_name, tax_rate')
    .eq('location_id', locId).eq('company_id', companyId).maybeSingle();
  const _taxName = (_loc && _loc.tax_name) ? _loc.tax_name : 'Tax';
  const _taxRate = (_loc && _loc.tax_rate != null) ? parseFloat(_loc.tax_rate) : 0;

  const today = _localToday();

  // Batch fetch clients, subscriptions, and ALL mail items for these plan cards
  const clientIds = [...new Set(cards.map(pc => pc.client_id).filter(Boolean))];
  const subIds = [...new Set(cards.map(pc => pc.subscription_id).filter(Boolean))];
  const pcIds = cards.map(pc => pc.plan_card_id);

  const [clientsRes, subsRes, allItemsRes] = await Promise.all([
    clientIds.length ? sb.from('clients').select('id, given_name, family_name, email').in('id', clientIds) : { data: [] },
    subIds.length ? sb.from('subscriptions').select('id, plan_name, plan_amount_formatted, created_at, interval, interval_count').in('id', subIds) : { data: [] },
    sb.from('mail_log').select('mail_id, plan_card_id, type, logged_at, recipient_name, sender_name, status, overage_flag, special_case')
      .in('plan_card_id', pcIds).eq('special_case', false).neq('status', 'deleted')
      .order('logged_at', { ascending: true })
  ]);

  const clientMap = {};
  (clientsRes.data || []).forEach(c => {
    clientMap[c.id] = { name: [c.given_name, c.family_name].filter(Boolean).join(' '), email: c.email || '' };
  });
  const subMap = {};
  (subsRes.data || []).forEach(s => { subMap[s.id] = s; });

  // Group mail items by plan_card_id
  const itemsByPc = {};
  (allItemsRes.data || []).forEach(m => {
    if (!itemsByPc[m.plan_card_id]) itemsByPc[m.plan_card_id] = [];
    itemsByPc[m.plan_card_id].push(m);
  });

  const readyToBill = [];
  const currentOverage = [];
  const billedHistory = [];

  function calcOverageFromItems(items, pc, sub, periodStart, periodEnd) {
    const _coDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: COMPANY_DEFAULT_TZ || 'America/Toronto' }) : '';
    const periodItems = items.filter(m => { const day = _coDay(m.logged_at); return day >= periodStart && day <= periodEnd; });
    const letters = periodItems.filter(m => m.type === 'letter');
    const parcels = periodItems.filter(m => m.type === 'parcel');
    const mOv = Math.max(0, letters.length - (pc.mail_limit || 0));
    const pOv = Math.max(0, parcels.length - (pc.parcel_limit || 0));
    const mFee = parseFloat(pc.mail_overage_fee) || 0;
    const pFee = parseFloat(pc.parcel_overage_fee) || 0;
    const mTotal = mOv * mFee;
    const pTotal = pOv * pFee;
    const subtotal = mTotal + pTotal;
    const hst = subtotal * (_taxRate / 100);
    const isCurrent = today >= periodStart && today <= periodEnd;
    // isBilled: last_billed_at was set on or after this period started (billing happens after period ends, so no upper bound needed)
    const isBilled = !!(pc.last_billed_at && _coDay(pc.last_billed_at) >= periodStart);
    const client = clientMap[pc.client_id] || { name: '', email: '' };

    return {
      planCardId: pc.plan_card_id, planName: pc.plan_name,
      subscriptionName: sub?.plan_name || '', planAmount: sub?.plan_amount_formatted || '',
      billingCycle: pc.billing_cycle || '', friendlyName: pc.friendly_name || '',
      clientId: pc.client_id, clientName: client.name, clientEmail: client.email,
      periodStart, periodEnd, isCurrent, isPastPeriod: today > periodEnd,
      mailUsed: letters.length, mailLimit: pc.mail_limit || 0,
      mailOverageCount: mOv, mailOverageFee: mFee, mailOverageTotal: mTotal,
      mailOverageItems: (mOv > 0 ? letters.slice(pc.mail_limit || 0) : []).map(m => rowToCamel(m)),
      parcelUsed: parcels.length, parcelLimit: pc.parcel_limit || 0,
      parcelOverageCount: pOv, parcelOverageFee: pFee, parcelOverageTotal: pTotal,
      parcelOverageItems: (pOv > 0 ? parcels.slice(pc.parcel_limit || 0) : []).map(m => rowToCamel(m)),
      subtotal, hst, total: subtotal + hst,
      taxName: _taxName, taxRate: _taxRate,
      hasOverage: mOv > 0 || pOv > 0,
      lastBilledAt: pc.last_billed_at || null, isBilled
    };
  }

  for (const pc of cards) {
    const { periodStart, periodEnd } = await _ensureCurrentPeriod(pc);
    if (!periodStart || !periodEnd) continue;
    const sub = subMap[pc.subscription_id];
    const allItems = itemsByPc[pc.plan_card_id] || [];

    // Current period
    const currentResult = calcOverageFromItems(allItems, pc, sub, periodStart, periodEnd);
    // Current period is never "billed" \u2014 it's still running
    currentResult.isBilled = false;
    if (currentResult.hasOverage) currentOverage.push(currentResult);

    // Past periods
    if (sub && sub.created_at) {
      const anchorDate = sub.created_at.split('T')[0];
      const interval = sub.interval || 'month';
      const intervalCount = sub.interval_count || 1;
      const [aY, aM, aD] = anchorDate.split('-').map(Number);
      let y = aY, m = aM;

      for (let i = 0; i < 120; i++) {
        const maxDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const d = Math.min(aD, maxDay);
        const ps = y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        let ny = y, nm = m;
        if (interval === 'year') { ny += intervalCount; }
        else { nm += intervalCount; if (nm > 12) { ny += Math.floor((nm-1)/12); nm = ((nm-1)%12)+1; } }
        const nMax = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
        const nd = Math.min(aD, nMax);
        const nextStart = ny + '-' + String(nm).padStart(2,'0') + '-' + String(nd).padStart(2,'0');
        const pe = _addDays(nextStart, -1);

        if (ps >= periodStart) break;
        if (today > pe) {
          const pastResult = calcOverageFromItems(allItems, pc, sub, ps, pe);
          if (pastResult.hasOverage && !pastResult.isBilled) readyToBill.push(pastResult);
          if (pastResult.hasOverage && pastResult.isBilled) billedHistory.push(pastResult);
        }

        if (interval === 'year') { y += intervalCount; }
        else { m += intervalCount; if (m > 12) { y += Math.floor((m-1)/12); m = ((m-1)%12)+1; } }
      }
    }
  }

  return { status: 'ok', readyToBill, currentOverage, billedHistory };
}

// Calculate current billing period from subscription anchor + interval

async function _recalculateOverage(body) {
  // Recalculate and snapshot overage flags for all plan cards (or a specific one)
  // TENANT ISOLATION: the "all" branch must be scoped to the caller's company,
  // never all tenants' plan cards (this drives billing-flag writes).
  let cards;
  if (body.planCardId) {
    const { data } = await sb.from('plan_cards').select('*').eq('plan_card_id', body.planCardId);
    cards = data;
  } else {
    const _coId = body.uuid ? await _companyIdFor(body.uuid, false) : null;
    if (!_coId) return { status: 'error', message: 'Something went wrong, please try again.' };
    const { data } = await sb.from('plan_cards').select('*').eq('status', 'active').eq('company_id', _coId);
    cards = data;
  }

  let totalFlagged = 0;
  let totalUnflagged = 0;

  for (const pc of (cards || [])) {
    const { periodStart, periodEnd } = await _ensureCurrentPeriod(pc);
    if (!periodStart || !periodEnd) continue;
    const endPlusOne = _addDays(periodEnd, 1);

    const { data: items } = await sb.from('mail_log').select('mail_id, type, logged_at')
      .eq('plan_card_id', pc.plan_card_id)
      .eq('special_case', false)
      .neq('status', 'deleted')
      .gte('logged_at', periodStart)
      .lt('logged_at', endPlusOne)
      .order('logged_at', { ascending: true });

    const letters = (items || []).filter(m => m.type === 'letter');
    const parcels = (items || []).filter(m => m.type === 'parcel');

    // Items within limit = not overage; items beyond limit = overage
    const includedMailIds = letters.slice(0, pc.mail_limit || 0).map(m => m.mail_id);
    const overageMailIds = letters.slice(pc.mail_limit || 0).map(m => m.mail_id);
    const includedParcelIds = parcels.slice(0, pc.parcel_limit || 0).map(m => m.mail_id);
    const overageParcelIds = parcels.slice(pc.parcel_limit || 0).map(m => m.mail_id);

    // Unflag included items
    const toUnflag = [...includedMailIds, ...includedParcelIds];
    if (toUnflag.length > 0) {
      const { count } = await sb.from('mail_log').update({ overage_flag: false })
        .in('mail_id', toUnflag).eq('overage_flag', true);
      totalUnflagged += count || 0;
    }

    // Flag overage items
    const toFlag = [...overageMailIds, ...overageParcelIds];
    if (toFlag.length > 0) {
      const { count } = await sb.from('mail_log').update({ overage_flag: true })
        .in('mail_id', toFlag).eq('overage_flag', false);
      totalFlagged += count || 0;
    }

  }

  await _audit({
    staffId: body.uuid, action: 'overage_recalculated', entityType: 'billing',
    summary: `Recalculated overage: ${totalFlagged} flagged, ${totalUnflagged} unflagged`,
    details: { flagged: totalFlagged, unflagged: totalUnflagged, planCardId: body.planCardId || 'all' }
  });

  return { status: 'ok', flagged: totalFlagged, unflagged: totalUnflagged };
}

// Mark a plan card's overage as billed for the current period
async function _markOverageBilled(body) {
  const now = new Date().toISOString();
  const { error } = await sb.from('plan_cards').update({
    last_billed_at: now
  }).eq('plan_card_id', body.planCardId);
  if (error) return { status: 'error', message: error.message };

  await _audit({
    staffId: body.uuid, action: 'overage_billed', entityType: 'billing', entityId: body.planCardId,
    planCardId: body.planCardId,
    summary: `Marked ${body.planCardId} as billed`,
    details: { planCardId: body.planCardId, billedAt: now }
  });

  return { status: 'ok' };
}

async function _markScanViewed(body) {
  const now = new Date().toISOString();
  const { error } = await sb.from('mail_log').update({
    scan_viewed_at: now,
    scan_viewed_by: body.uuid
  }).eq('mail_id', body.mailId);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}

// \u2500\u2500 Broadcasts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function _getActiveBroadcasts(clientId, locationId, planNames) {
  const now = new Date().toISOString();
  // Tenant-scope the fetch. getBroadcasts serves both client and staff uuids,
  // so resolve as client first, then fall back to staff. Fail-closed: if no
  // company resolves, return empty rather than leaking all-company broadcasts.
  const companyId = (await _companyIdFor(clientId, true)) || (await _companyIdFor(clientId, false));
  if (!companyId) return { status: 'ok', broadcasts: [] };
  const { data } = await sb.from('broadcasts').select('*')
    .eq('company_id', companyId)
    .eq('active', true)
    .lte('starts_at', now)
    .order('created_at', { ascending: false });

  if (!data) return { status: 'ok', broadcasts: [] };

  // planNames can be a string or array
  const planList = Array.isArray(planNames) ? planNames : (planNames ? [planNames] : []);

  const results = data.filter(b => {
    // Check expiry
    if (b.expires_at && b.expires_at < now) return false;
    // Check targeting
    if (b.target_scope === 'all') return true;
    if (b.target_scope === 'location' && b.target_value === locationId) return true;
    if (b.target_scope === 'plan_type' && planList.includes(b.target_value)) return true;
    // location_plan: target_value is "LOC_ID|PlanName" — client must have a plan
    // card at that location AND on that plan. Mirrors the location + plan_type
    // checks combined (same locationId / planList the other branches use).
    if (b.target_scope === 'location_plan') {
      const sep = (b.target_value || '').indexOf('|');
      if (sep === -1) return false;
      const wantLoc = b.target_value.slice(0, sep);
      const wantPlan = b.target_value.slice(sep + 1);
      return wantLoc === locationId && planList.includes(wantPlan);
    }
    return false;
  }).map(b => {
    const dismissed = b.dismissed_by || [];
    return {
      broadcastId: b.broadcast_id,
      title: b.title,
      message: b.message,
      bannerType: b.banner_type,
      startsAt: b.starts_at,
      expiresAt: b.expires_at,
      isDismissible: ['info', 'success'].includes(b.banner_type),
      isDismissed: Array.isArray(dismissed) && dismissed.includes(clientId)
    };
  });

  return { status: 'ok', broadcasts: results };
}

async function _getStaffBroadcasts(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id').eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const now = new Date().toISOString();
  // Tenant-scope the fetch (staff-only caller). Fail-closed: no company → empty,
  // never leak all-company broadcasts.
  const companyId = await _companyIdFor(uuid, false);
  if (!companyId) return { status: 'ok', broadcasts: [] };
  const { data } = await sb.from('broadcasts').select('*')
    .eq('company_id', companyId)
    .eq('active', true).lte('starts_at', now).order('created_at', { ascending: false });
  if (!data) return { status: 'ok', broadcasts: [] };
  const results = data.filter(b => {
    if (b.expires_at && b.expires_at < now) return false;
    if (b.target_scope === 'staff_all') return true;
    if (b.target_scope === 'staff_location' && b.target_value === locId) return true;
    return false;
  }).map(b => {
    const dismissed = b.dismissed_by || [];
    return {
      broadcastId: b.broadcast_id, title: b.title, message: b.message,
      bannerType: b.banner_type, startsAt: b.starts_at, expiresAt: b.expires_at,
      isDismissible: ['info', 'success'].includes(b.banner_type),
      isDismissed: Array.isArray(dismissed) && dismissed.includes(uuid)
    };
  });
  return { status: 'ok', broadcasts: results };
}

async function _dismissBroadcast(body) {
  // Add client UUID to dismissed_by array. Scope by the caller's company so a
  // forged broadcastId from another tenant can't be mutated. Caller may be a
  // client or staff uuid (same dual audience as getBroadcasts). Fail-closed.
  const companyId = (await _companyIdFor(body.uuid, true)) || (await _companyIdFor(body.uuid, false));
  if (!companyId) return { status: 'error', message: 'Broadcast not found' };
  const { data: bc } = await sb.from('broadcasts').select('dismissed_by')
    .eq('broadcast_id', body.broadcastId).eq('company_id', companyId).maybeSingle();
  if (!bc) return { status: 'error', message: 'Broadcast not found' };
  const dismissed = Array.isArray(bc.dismissed_by) ? bc.dismissed_by : [];
  if (!dismissed.includes(body.uuid)) {
    dismissed.push(body.uuid);
    await sb.from('broadcasts').update({ dismissed_by: dismissed }).eq('broadcast_id', body.broadcastId).eq('company_id', companyId);
  }
  return { status: 'ok' };
}

// \u2500\u2500 ID Verification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Generate a signed URL for a private storage file (expires in 1 hour)
async function _getSignedUrl(path) {
  if (!path) return null;
  // If it's already a base64 or full URL (legacy), return as-is
  if (path.startsWith('data:') || path.startsWith('http')) return path;
  const { data, error } = await sb.storage.from('id-documents').createSignedUrl(path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}

async function _getIdVerification(clientId, guardStaffUuid) {
  let { data } = await sb.from('clients').select('id, id_verification_status, id_type, id_front_url, id_back_url, id_submitted_at, id_reviewed_at, id_reviewed_by, id_rejection_reason')
    .eq('id', clientId).maybeSingle();
  // uuid may be clients.id OR auth_id — fall back to auth_id like other client lookups.
  if (!data) {
    const r = await sb.from('clients').select('id, id_verification_status, id_type, id_front_url, id_back_url, id_submitted_at, id_reviewed_at, id_reviewed_by, id_rejection_reason')
      .eq('auth_id', clientId).maybeSingle();
    data = r.data;
  }
  if (!data) return { status: 'error', message: 'Client not found' };

  // Server-side location guard (staff context only). A non-admin staffer may only
  // view a client who has a plan_card at their location. Enforced here because the
  // adapter uses the service-role key, so UI-only filtering can be bypassed.
  if (guardStaffUuid) {
    const ok = await _staffCanAccessClientLocation(guardStaffUuid, data.id);
    if (!ok) return { status: 'error', message: 'Not authorized for this client.' };
  }

  const [frontUrl, backUrl] = await Promise.all([
    _getSignedUrl(data.id_front_url),
    _getSignedUrl(data.id_back_url)
  ]);

  // Resolve reviewer staff name (for "Approved/Reviewed by <name>")
  let reviewedByName = null;
  if (data.id_reviewed_by) {
    const { data: rs } = await sb.from('staff').select('name').eq('staff_id', data.id_reviewed_by).maybeSingle();
    if (rs) reviewedByName = rs.name;
  }

  return { status: 'ok', verification: {
    verificationStatus: data.id_verification_status || 'not_submitted',
    idType: data.id_type,
    frontUrl,
    backUrl,
    submittedAt: data.id_submitted_at,
    reviewedAt: data.id_reviewed_at,
    reviewedBy: data.id_reviewed_by,
    reviewedByName,
    rejectionReason: data.id_rejection_reason
  }};
}

async function _submitIdVerification(body) {
  const clientId = body.uuid;
  _setEmailCompany(await _companyIdFor(clientId, true));
  const timestamp = Date.now();

  // Upload images to Supabase Storage
  async function uploadIdImage(base64Data, side) {
    // Convert base64 to blob
    const base64 = base64Data.split(',')[1];
    const byteChars = atob(base64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArray], { type: 'image/jpeg' });

    const filePath = `${clientId}/${side}_${timestamp}.jpg`;
    const { data, error } = await sb.storage.from('id-documents').upload(filePath, blob, {
      contentType: 'image/jpeg',
      upsert: true
    });
    if (error) throw new Error('Upload failed: ' + error.message);
    return filePath;
  }

  try {
    const frontPath = await uploadIdImage(body.frontImage, 'front');
    let backPath = null;
    if (body.backImage) {
      backPath = await uploadIdImage(body.backImage, 'back');
    }

    const updates = {
      id_verification_status: 'pending',
      id_type: body.idType,
      id_front_url: frontPath,
      id_back_url: backPath,
      id_submitted_at: new Date().toISOString(),
      id_reviewed_at: null,
      id_reviewed_by: null,
      id_rejection_reason: null
    };
    if (body.phone) updates.phone = body.phone;
    const { error } = await sb.from('clients').update(updates).eq('id', clientId);
    if (error) return { status: 'error', message: error.message };

    // Auto-create ID verification task
    const { data: clientData } = await sb.from('clients').select('given_name, family_name').eq('id', clientId).maybeSingle();
    const clientName = clientData ? [clientData.given_name, clientData.family_name].filter(Boolean).join(' ') : clientId;
    const { data: pc } = await sb.from('plan_cards').select('location_id').eq('client_id', clientId).limit(1).maybeSingle();
    // Resolve the notification location. ID is now submitted BEFORE onboarding, so a
    // plan_card usually doesn't exist yet — fall back to the subscription's location
    // (set at signup) so staff/admin notifications still fire.
    let idLocationId = pc?.location_id || null;
    if (!idLocationId) {
      const { data: subLoc } = await sb.from('subscriptions').select('location_id').eq('client_id', clientId).not('location_id', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
      idLocationId = subLoc?.location_id || null;
    }
    await _createIdVerificationTask(clientId, clientName, idLocationId);

    // Notify staff + admin at location
    if (idLocationId) {
      // ID verify access is controlled per-staff via can_verify_id; only notify
      // staff/admins who actually hold the permission (others can't open the tab).
      await _notifyVerifyStaffAtLocation(idLocationId, 'id_submitted', 'ID submitted for review', clientName + ' has submitted their ID for verification', 'idverify', clientId, clientId);
      // Email staff + admins
      if (await _isEmailEnabled('id_submitted', 'staff')) {
        const { data: staffList } = await sb.from('staff').select('email, name').eq('default_location_id', idLocationId).eq('active', true).in('role', ['staff', 'admin']).eq('can_verify_id', true);
        for (const st of (staffList || [])) {
          if (st.email) {
            const _tpl9 = await _resolveTemplate('id_submitted', { staff_name: st.name || 'there', client_name: clientName });
            await _sendEmail(st.email, _tpl9.subject, await _emailHtml(_tpl9.subject, _tpl9.bodyHtml, _tpl9.ctaEnabled ? _tpl9.ctaLabel : '', _tpl9.ctaEnabled ? _tpl9.ctaUrl : ''));
          }
        }
      }
      await _notifyVerifyAdminsAtLocation(idLocationId, 'id_submitted', 'ID submitted for review', clientName + ' has submitted their ID for verification', 'idverify', clientId, clientId);
    }

    return { status: 'ok' };
  } catch(e) {
    return { status: 'error', message: e.message };
  }
}

async function _reviewIdVerification(body) {
  // Server-side location guard: a non-admin staffer may only review a client who
  // has a plan_card at their location. Enforced here (service-role key) so the
  // list filter can't be bypassed by calling the action directly. Admins bypass.
  const _guardOk = await _staffCanAccessClientLocation(body.uuid, body.clientId);
  if (!_guardOk) return { status: 'error', message: 'Not authorized for this client.' };
  const _revCompanyId = await _companyIdFor(body.uuid, false);
  _setEmailCompany(_revCompanyId);
  const { data: staffInfo } = await sb.from('staff').select('name').eq('staff_id', body.uuid).maybeSingle();
  const updates = {
    id_verification_status: body.decision,
    id_reviewed_at: new Date().toISOString(),
    id_reviewed_by: body.uuid
  };
  if (body.decision === 'rejected') {
    updates.id_rejection_reason = body.reason || 'ID could not be verified';
  }
  const { error } = await sb.from('clients').update(updates).eq('id', body.clientId);
  if (error) return { status: 'error', message: error.message };

  await _audit({
    staffId: body.uuid, staffName: staffInfo?.name, action: body.decision === 'approved' ? 'id_approved' : 'id_rejected',
    entityType: 'client', entityId: body.clientId, clientId: body.clientId,
    summary: `ID ${body.decision} by ${staffInfo?.name || body.uuid} for ${body.clientId}`,
    details: { decision: body.decision, reason: body.reason || null, idType: body.idType }
  });

  // Auto-resolve ID verification task(s) for this client. Catches any non-resolved
  // state (open / in_progress / snoozed), not just 'open', so a verified ID always
  // closes its task. Assignee stamp = Option B: if the task was never claimed, the
  // person who actually verified becomes the assignee (handles the walk-up case where
  // a staffer verifies the ID without first claiming the task); an existing claim is
  // left intact. resolved_by always records who finished it.
  const now = new Date().toISOString();
  const _resNote = 'ID ' + body.decision + (body.reason ? ': ' + body.reason : '');
  const { data: _idTasks } = await sb.from('tasks')
    .select('task_id, assigned_to')
    .eq('client_id', body.clientId).eq('type', 'id_verification')
    .eq('company_id', _revCompanyId)
    .neq('status', 'resolved');
  for (const _t of (_idTasks || [])) {
    const _patch = { status: 'resolved', resolved_at: now, resolved_by: body.uuid, resolution_note: _resNote, snoozed_until: null };
    if (!_t.assigned_to) _patch.assigned_to = body.uuid; // Option B: only fill if unclaimed
    await sb.from('tasks').update(_patch).eq('task_id', _t.task_id);
  }

  // Notify client
  const title = body.decision === 'approved' ? 'ID Verified' : 'ID Verification Issue';
  const msg = body.decision === 'approved' ? 'Your identity has been verified successfully.' : 'Your ID could not be verified' + (body.reason ? ': ' + body.reason : '. Please resubmit.');
  await _createNotification('client', body.clientId, 'id_reviewed', title, msg, 'idverify', body.clientId);
  // Email
  if (await _isEmailEnabled('id_reviewed', 'client')) {
    const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', body.clientId).maybeSingle();
    if (cl?.email) {
      const name = cl.given_name || 'there';
      const approved = body.decision === 'approved';
      const _rejReason = body.reason
        ? '\n\n<span style="display:block;border:1px solid #C62828;border-left:4px solid #C62828;border-radius:6px;background:#fdf2f2;padding:10px 12px;margin-top:4px"><span style="display:block;font-size:11px;font-weight:700;color:#C62828;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">Reason</span><span style="display:block;font-size:14px;color:#8a1f1f;line-height:1.5">' + body.reason + '</span></span>'
        : '';
      const _tpl7 = await _resolveTemplate('id_reviewed', {
        name, decision: body.decision || '',
        reason: body.reason || '',
        id_reviewed_message: body.decision === 'approved'
          ? 'Your identity has been verified successfully. You now have full access to your account.'
          : 'Unfortunately we were unable to verify your ID. Please resubmit your identification through the client portal.' + _rejReason
      });
      await _sendEmail(cl.email, _tpl7.subject, await _emailHtml(_tpl7.subject, _tpl7.bodyHtml, _tpl7.ctaEnabled ? _tpl7.ctaLabel : '', _tpl7.ctaEnabled ? _tpl7.ctaUrl : ''));
    }
  }

  return { status: 'ok' };
}

// Build client_id -> Set(location_ids) from plan_cards (the reliable per-location
// source used everywhere). One fetch, mapped in memory (avoids N+1). Used to
// location-scope ID verification for non-admin staff. Clients with NO plan_card
// are simply absent from the map (no resolvable location).
async function _clientLocationIds(companyId, clientIds) {
  const map = {}; // client_id -> Set(location_id)
  if (!clientIds || !clientIds.length) return map;
  // TENANT ISOLATION: no company -> empty map, never read plan_cards across tenants.
  if (!companyId) return map;
  const { data: cards } = await sb.from('plan_cards').select('client_id, location_id')
    .in('client_id', clientIds)
    .eq('company_id', companyId);
  (cards || []).forEach(pc => {
    if (!pc.client_id || !pc.location_id) return;
    (map[pc.client_id] || (map[pc.client_id] = new Set())).add(pc.location_id);
  });
  // Fallback location source: subscriptions.location_id (set at signup). A client
  // who submits ID BEFORE onboarding has no plan_card yet, so plan_cards alone
  // can't resolve their location and scoped staff would never see them (admins
  // would). Union in the subscription location (same pattern as _submitIdVerification)
  // so the correct-location staffer can see/verify pre-onboarding clients. Still
  // company-scoped; a client with no plan_card AND no located subscription stays
  // absent from the map (hidden from scoped staff, admin-only — fail-closed).
  const { data: subs } = await sb.from('subscriptions').select('client_id, location_id')
    .in('client_id', clientIds)
    .eq('company_id', companyId);
  (subs || []).forEach(s => {
    if (!s.client_id || !s.location_id) return;
    (map[s.client_id] || (map[s.client_id] = new Set())).add(s.location_id);
  });
  return map;
}

// Server-side location guard for single-client ID actions. Returns true if the
// caller (staff uuid) may act on clientId. Admins always pass. Non-admins pass
// only if the client resolves to the staffer's default_location_id via a
// plan_card OR a signup subscription (see _clientLocationIds — the subscription
// fallback lets staff verify pre-onboarding clients with no plan_card yet).
// A null/absent staffUuid means non-staff context (client self-view) -> allow.
async function _staffCanAccessClientLocation(staffUuid, clientId) {
  if (!staffUuid) return true;
  const { data: staff } = await sb.from('staff').select('role, default_location_id, company_id')
    .eq('staff_id', staffUuid).maybeSingle();
  if (!staff) return false;
  if (staff.role === 'admin') return true;
  const locId = staff.default_location_id;
  if (!locId) return false;
  const map = await _clientLocationIds(staff.company_id, [clientId]);
  const set = map[clientId];
  return !!(set && set.has(locId));
}

async function _getPendingVerifications(uuid) {
  const { data: staff } = await sb.from('staff').select('default_location_id, role, company_id')
    .eq('staff_id', uuid).maybeSingle();
  const locId = staff?.default_location_id;
  const isAdmin = staff?.role === 'admin';
  const companyId = staff?.company_id;
  // TENANT ISOLATION: no company resolved -> return empty, never read all tenants.
  if (!companyId) return { status: 'ok', pending: [], history: [] };

  // Get all clients with ID verification data (scoped to this company)
  let _verQ = sb.from('clients').select('id, given_name, family_name, email, phone, id_verification_status, id_type, id_front_url, id_back_url, id_submitted_at, id_reviewed_at, id_reviewed_by, id_rejection_reason')
    .in('id_verification_status', ['pending', 'approved', 'rejected'])
    .eq('company_id', companyId);
  const { data: allClients } = await _verQ;

  async function mapClient(c) {
    const [frontUrl, backUrl] = await Promise.all([
      _getSignedUrl(c.id_front_url),
      _getSignedUrl(c.id_back_url)
    ]);
    return {
      clientId: c.id,
      name: [c.given_name, c.family_name].filter(Boolean).join(' '),
      email: c.email,
      phone: c.phone || '',
      status: c.id_verification_status,
      idType: c.id_type,
      frontUrl,
      backUrl,
      submittedAt: c.id_submitted_at,
      reviewedAt: c.id_reviewed_at,
      reviewedBy: c.id_reviewed_by,
      rejectionReason: c.id_rejection_reason
    };
  }

  let all = allClients || [];

  // Location scope: a non-admin staffer only sees clients with a plan_card at
  // their own location. Admins see all locations (app-wide convention). Clients
  // with no plan_card (no resolvable location) are hidden from scoped staff.
  if (!isAdmin) {
    if (!locId) {
      all = [];
    } else {
      const locMap = await _clientLocationIds(companyId, all.map(c => c.id));
      all = all.filter(c => { const s = locMap[c.id]; return s && s.has(locId); });
    }
  }

  const pending = await Promise.all(all.filter(c => c.id_verification_status === 'pending').map(mapClient));
  const history = await Promise.all(
    all.filter(c => c.id_verification_status === 'approved' || c.id_verification_status === 'rejected')
      .sort((a, b) => (b.id_reviewed_at || '').localeCompare(a.id_reviewed_at || ''))
      .map(mapClient)
  );

  // Resolve reviewer staff names (batch) so the UI can show "by <name>" instead of the raw staff id
  const reviewerIds = [...new Set(history.map(h => h.reviewedBy).filter(Boolean))];
  if (reviewerIds.length) {
    const { data: revStaff } = await sb.from('staff').select('staff_id, name').in('staff_id', reviewerIds);
    const nameMap = {};
    (revStaff || []).forEach(s => { nameMap[s.staff_id] = s.name; });
    history.forEach(h => { if (h.reviewedBy && nameMap[h.reviewedBy]) h.reviewedByName = nameMap[h.reviewedBy]; });
  }

  return { status: 'ok', pending, history };
}


async function _deleteMailItem(body) {
  const { data: item } = await sb.from('mail_log')
    .select('plan_card_id, type, special_case, logged_at')
    .eq('mail_id', body.mailId).maybeSingle();

  // Block deleting items in billed past periods (current period items are always deletable)
  if (item && item.plan_card_id) {
    const { data: pcCheck } = await sb.from('plan_cards').select('last_billed_at, current_period_start')
      .eq('plan_card_id', item.plan_card_id).maybeSingle();
    if (pcCheck && pcCheck.last_billed_at && item.logged_at) {
      const loggedDate = item.logged_at.split('T')[0];
      const periodStart = pcCheck.current_period_start;
      // Only block if item is BEFORE the current period (i.e. in a past period)
      if (periodStart && loggedDate < periodStart) {
        return { status: 'error', message: 'Cannot delete \u2014 this item is in a billed period.' };
      }
    }
  }

  // Soft delete
  const { error } = await sb.from('mail_log')
    .update({ status: 'deleted' })
    .eq('mail_id', body.mailId);
  if (error) return { status: 'error', message: error.message };

  // Usage is now computed live from mail_log \u2014 no counter decrement needed on delete

  await _audit({
    staffId: body.uuid, action: 'mail_deleted', entityType: 'mail', entityId: body.mailId,
    mailId: body.mailId, planCardId: item?.plan_card_id,
    summary: `Deleted ${body.mailId} (${item?.type || 'item'})`,
    details: { type: item?.type, planCardId: item?.plan_card_id }
  });

  // Remove client notification for this mail
  await _deleteNotificationsByRelated(body.mailId);

  return { status: 'ok' };
}

async function _updateMailStatus(body) {
  const now = new Date().toISOString();
  const validStatuses = [
    'ready_for_pickup', 'confidential_pickup', 'forwarding_queued',
    'forwarded', 'picked_up', 'shredded', 'returned_to_sender',
    'discarded', 'pending_assignment'
  ];
  // 'deleted' is intentionally excluded \u2014 use deleteMailItem which enforces billed period protection
  const targetStatus = body.newStatus || body.status;
  if (!validStatuses.includes(targetStatus)) {
    return { status: 'error', message: 'Invalid status: ' + targetStatus };
  }

  const mailIds = body.mailIds ? JSON.parse(body.mailIds) : [body.mailId];
  const updates = {
    status: targetStatus,
    status_changed_at: now,
    status_changed_by: body.uuid
  };
  const noteVal = body.noteInternal || body.note;
  if (noteVal) updates.note_internal = noteVal;

  // Write dedicated timestamp columns for terminal actions
  if (['discarded', 'shredded'].includes(targetStatus)) updates.discarded_at = now;
  if (targetStatus === 'returned_to_sender') updates.returned_at = now;

  // Write who performed the action
  if (body.uuid) updates.action_performed_by = body.uuid;
  if (body.staffName) updates.action_performed_by_name = body.staffName;

  const results = [];
  for (const mailId of mailIds) {
    const { error } = await sb.from('mail_log').update(updates).eq('mail_id', mailId);
    results.push({ mailId, status: error ? 'error' : 'ok', message: error?.message });
  }

  const actionMap = { forwarded:'mail_forwarded', shredded:'mail_shredded', discarded:'mail_discarded', returned_to_sender:'mail_returned' };
  await _audit({
    staffId: body.uuid, action: actionMap[targetStatus] || 'status_changed', entityType: 'mail',
    summary: `${targetStatus.replace(/_/g,' ')} ${mailIds.length} item${mailIds.length>1?'s':''}`,
    details: { mailIds, newStatus: targetStatus, note: noteVal || null }
  });

  return { status: 'ok', results, count: mailIds.length };
}

async function _addTempRecipient(body) {
  return _addRecipient({
    ...body,
    action: 'addRecipient',
    notes: 'TEMP: ' + (body.notes || '')
  });
}

async function _updateRecipient(body) {
  const updates = { name: body.name };
  if (body.type) updates.type = body.type;
  const { error } = await sb.from('recipients').update(updates)
    .eq('recipient_id', body.recipientId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: 'recipient_updated', entityType: 'recipient', entityId: body.recipientId, summary: 'Updated recipient ' + body.recipientId + (body.name ? ' \u2014 ' + body.name : '') });
  return { status: 'ok' };
}

async function _updateRecipientStatus(body) {
  // Get recipient details
  const { data: rec } = await sb.from('recipients').select('plan_card_id, notes, status')
    .eq('recipient_id', body.recipientId).maybeSingle();
  if (!rec) return { status: 'error', message: 'Recipient not found' };

  const isTemp = rec.notes && rec.notes.startsWith('TEMP:');
  const isReactivating = rec.status !== 'active' && body.status === 'active';

  // If reactivating a non-temp recipient, check max limit
  if (isReactivating && !isTemp && rec.plan_card_id) {
    const { data: pc } = await sb.from('plan_cards').select('max_recipients')
      .eq('plan_card_id', rec.plan_card_id).maybeSingle();
    if (pc) {
      const { data: activeRecs } = await sb.from('recipients').select('recipient_id')
        .eq('plan_card_id', rec.plan_card_id).eq('status', 'active')
        .or('notes.is.null,notes.not.like.TEMP:%');
      const activeCount = activeRecs ? activeRecs.length : 0;
      if (activeCount >= pc.max_recipients) {
        return { status: 'error', message: `Cannot reactivate \u2014 maximum active recipients reached (${pc.max_recipients}). Deactivate another first, or add as a temporary recipient.` };
      }
    }
  }

  const { error } = await sb.from('recipients')
    .update({ status: body.status })
    .eq('recipient_id', body.recipientId);
  if (error) return { status: 'error', message: error.message };

  // Sync recipients_added counter on plan card for non-temp recipients
  if (!isTemp && rec.plan_card_id) {
    const { data: activeRecs } = await sb.from('recipients').select('recipient_id')
      .eq('plan_card_id', rec.plan_card_id).eq('status', 'active')
      .or('notes.is.null,notes.not.like.TEMP:%');
    const count = activeRecs ? activeRecs.length : 0;
    await sb.from('plan_cards').update({ recipients_added: count })
      .eq('plan_card_id', rec.plan_card_id);
  }

  const statusLabel = body.status === 'active' ? 'reactivated' : body.status === 'inactive' ? 'deactivated' : body.status;
  await _audit({ staffId: body.uuid, action: 'recipient_status_changed', entityType: 'recipient', entityId: body.recipientId, summary: 'Recipient ' + body.recipientId + ' ' + statusLabel + (isTemp ? ' (temp)' : '') });
  return { status: 'ok' };
}

async function _togglePlanLock(body) {
  const { data: pc } = await sb.from('plan_cards').select('access_override, override_by')
    .eq('plan_card_id', body.planCardId).maybeSingle();
  if (!pc) return { status: 'error', message: 'Plan card not found' };

  const now = new Date().toISOString();
  const isSuspended = pc.access_override === 'suspended';

  // If trying to unsuspend, check if an admin locked it
  if (isSuspended && pc.override_by && pc.override_by !== body.uuid) {
    const { data: locker } = await sb.from('staff').select('role').eq('staff_id', pc.override_by).maybeSingle();
    const { data: caller } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
    if (locker?.role === 'admin' && caller?.role !== 'admin') {
      return { status: 'error', message: 'This plan was suspended by an admin. Only an admin can unsuspend it.' };
    }
  }

  const updates = {
    access_override: isSuspended ? null : 'suspended',
    override_reason: isSuspended ? null : (body.reason || null),
    override_at:     isSuspended ? null : now,
    override_by:     isSuspended ? null : body.uuid
  };
  if (!isSuspended) {
    const { data: me } = await sb.from('staff').select('role, name').eq('staff_id', body.uuid).maybeSingle();
    const byLabel = (me?.role === 'admin' ? 'admin' : 'staff') + (me?.name ? ' (' + me.name + ')' : '');
    updates.override_reason = updates.override_reason ? updates.override_reason + ' \u2014 by ' + byLabel : 'Suspended by ' + byLabel;
  }

  const { error } = await sb.from('plan_cards').update(updates).eq('plan_card_id', body.planCardId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: isSuspended ? 'plan_unsuspended' : 'plan_suspended', entityType: 'plan_card', entityId: body.planCardId, summary: (isSuspended ? 'Plan unsuspended' : 'Plan suspended') + ': ' + body.planCardId + (body.reason ? ' \u2014 ' + body.reason : '') });
  return { status: 'ok', locked: !isSuspended };
}

async function _toggleAccountLock(body) {
  const { data: client } = await sb.from('clients').select('access_override, override_by')
    .eq('id', body.clientId).maybeSingle();
  if (!client) return { status: 'error', message: 'Client not found' };

  const now = new Date().toISOString();
  const isSuspended = client.access_override === 'suspended';

  // If trying to unsuspend, check if an admin locked it
  if (isSuspended && client.override_by && client.override_by !== body.uuid) {
    const { data: locker } = await sb.from('staff').select('role').eq('staff_id', client.override_by).maybeSingle();
    const { data: caller } = await sb.from('staff').select('role').eq('staff_id', body.uuid).maybeSingle();
    if (locker?.role === 'admin' && caller?.role !== 'admin') {
      return { status: 'error', message: 'This account was suspended by an admin. Only an admin can unsuspend it.' };
    }
  }

  const updates = {
    access_override: isSuspended ? null : 'suspended',
    override_reason: isSuspended ? null : (body.reason || null),
    override_at:     isSuspended ? null : now,
    override_by:     isSuspended ? null : body.uuid
  };
  if (!isSuspended) {
    const { data: me } = await sb.from('staff').select('role, name').eq('staff_id', body.uuid).maybeSingle();
    const byLabel = (me?.role === 'admin' ? 'admin' : 'staff') + (me?.name ? ' (' + me.name + ')' : '');
    updates.override_reason = updates.override_reason ? updates.override_reason + ' \u2014 by ' + byLabel : 'Suspended by ' + byLabel;
  }

  const { error } = await sb.from('clients').update(updates).eq('id', body.clientId);
  if (error) return { status: 'error', message: error.message };
  await _audit({ staffId: body.uuid, action: isSuspended ? 'account_unsuspended' : 'account_suspended', entityType: 'client', entityId: body.clientId, clientId: body.clientId, summary: (isSuspended ? 'Account unsuspended' : 'Account suspended') + ': ' + body.clientId + (body.reason ? ' \u2014 ' + body.reason : '') });
  return { status: 'ok', locked: !isSuspended };
}

// \u2500\u2500 Get agents for a client (staff release flow) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function _getClientAgents(body) {
  // TENANT ISOLATION: derive company from the client record, then scope the
  // pickup_agents read to that company (defense against a cross-tenant clientId).
  const { data: client } = await sb.from('clients')
    .select('given_name, family_name, company_id')
    .eq('id', body.clientId).maybeSingle();
  if (!client?.company_id) return { status: 'ok', clientName: 'Account Holder', agents: [] };
  const companyId = client.company_id;

  const { data, error } = await sb.from('pickup_agents')
    .select('agent_id, name, status, id_type, id_last4, phone')
    .eq('client_id', body.clientId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .order('name');
  if (error) return { status: 'error', message: error.message };

  const clientName = [client.given_name, client.family_name].filter(Boolean).join(' ') || 'Account Holder';

  return {
    status: 'ok',
    clientName,
    agents: (data || []).map(a => ({
      agentId: a.agent_id, name: a.name, status: a.status,
      idType: a.id_type, idLast4: a.id_last4, phone: a.phone
    }))
  };
}

// \u2500\u2500 Get all active mail items for a client (staff detail panel) \u2500\u2500
async function _getClientMailItems(body) {
  // TENANT ISOLATION: derive company from the client record, then scope the
  // mail_log read to that company (defense against a cross-tenant clientId).
  const { data: client } = await sb.from('clients').select('company_id')
    .eq('id', body.clientId).maybeSingle();
  if (!client?.company_id) return { status: 'ok', items: [] };

  let query = sb.from('mail_log')
    .select('*')
    .eq('client_id', body.clientId)
    .eq('company_id', client.company_id)
    .not('status', 'in', '("deleted")')
    .order('logged_at', { ascending: false });
  if (body.limit) query = query.limit(parseInt(body.limit));

  const { data, error } = await query;
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok', items: (data || []).map(rowToCamel) };
}

async function _saveForwardingBatch(body) {
  const _fbCompanyId = await _companyIdFor(body.uuid, false);
  _setEmailCompany(_fbCompanyId);
  const { error } = await sb.from('forwarding_batches').insert({
    company_id: _fbCompanyId,
    created_by: body.uuid,
    batch_period: body.batchPeriod || null,
    client_id: body.clientId || null,
    client_name: body.clientName || null,
    tracking_url: body.trackingUrl || null,
    shipping_cost: body.shippingCost || null,
    note_to_client: body.noteToClient || null,
    mail_ids: JSON.parse(body.mailIds || '[]'),
    item_count: parseInt(body.itemCount) || 0,
    total_pieces: parseInt(body.totalPieces) || 0,
    forwarding_address: body.forwardingAddress || null,
    packing_slip_html: body.packingSlipHtml || null
  });
  if (error) return { status: 'error', message: error.message };

  await _audit({
    staffId: body.uuid, action: 'forwarding_batch_sent', entityType: 'client',
    entityId: body.clientId || null, clientId: body.clientId || null,
    summary: 'Forwarding batch sent to ' + (body.clientName || body.clientId || 'client') +
      ' \u2014 ' + (parseInt(body.itemCount) || 0) + ' item(s)' +
      (body.trackingUrl ? ' \u00B7 tracking: ' + body.trackingUrl : '')
  });

  // Notify client
  if (body.clientId) {
    const itemCount = parseInt(body.itemCount) || 0;
    await _createNotification('client', body.clientId, 'forwarding_batch', 'Mail forwarded', itemCount + ' item' + (itemCount > 1 ? 's' : '') + ' shipped' + (body.trackingUrl ? ' \u2014 tracking available' : ''), 'mail', null);
    // Email
    if (await _isEmailEnabled('forwarding_batch', 'client')) {
      const { data: cl } = await sb.from('clients').select('email, given_name').eq('id', body.clientId).maybeSingle();
      if (cl?.email) {
        const name = cl.given_name || 'there';
        const _tpl8 = await _resolveTemplate('forwarding_batch', {
          name, count: String(itemCount),
          count_plural: itemCount > 1 ? 's have' : ' has',
          tracking_number: body.trackingNumber || '',
          tracking_url: body.trackingUrl || '',
          tracking_line: ''
        });
        await _sendEmail(cl.email, _tpl8.subject, await _emailHtml(_tpl8.subject, _tpl8.bodyHtml, body.trackingUrl ? 'Track Shipment' : '', body.trackingUrl ? body.trackingUrl : ''));
      }
    }
  }
  return { status: 'ok' };
}

async function _getForwardingBatches(body) {
  const { data: staff } = await sb.from('staff').select('default_location_id, company_id, role')
    .eq('staff_id', body.uuid).maybeSingle();
  const companyId = staff?.company_id;
  const locId = staff?.default_location_id;
  const isAdmin = staff?.role === 'admin';
  // TENANT ISOLATION: no company resolved -> return empty, never read across tenants.
  if (!companyId) return { status: 'ok', batches: [] };

  let query = sb.from('forwarding_batches')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (body.clientId) query = query.eq('client_id', body.clientId);
  query = query.limit(body.limit ? parseInt(body.limit) : 200); // default 200 if no limit specified
  const { data, error } = await query;
  if (error) return { status: 'error', message: error.message };

  let rows = data || [];

  // LOCATION SCOPE (non-admin): forwarding_batches has no location_id column, so
  // resolve each batch's client -> location via plan_cards/subscriptions (company-scoped)
  // and keep only batches whose client is at this staffer's location. A batch with no
  // client_id, or a client not at this location, is hidden from scoped staff (fail-closed).
  // Admins see all locations within the company.
  if (!isAdmin) {
    if (!locId) return { status: 'ok', batches: [] };
    const clientIds = [...new Set(rows.map(b => b.client_id).filter(Boolean))];
    const locMap = await _clientLocationIds(companyId, clientIds);
    rows = rows.filter(b => { const s = b.client_id && locMap[b.client_id]; return s && s.has(locId); });
  }

  return { status: 'ok', batches: rows.map(rowToCamel) };
}

// \u2550\u2550\u2550 NOTIFICATIONS \u2550\u2550\u2550
async function _getNotifications(body) {
  // TENANT ISOLATION: recipient_id already pins to the caller's own id, but also
  // scope by the recipient's company so a row can never surface cross-tenant.
  const companyId = await _recipientCompanyId(body.recipientType, body.recipientId);
  if (!companyId) return { status: 'ok', notifications: [] };
  const { data } = await sb.from('notifications').select('*')
    .eq('company_id', companyId)
    .eq('recipient_type', body.recipientType)
    .eq('recipient_id', body.recipientId)
    .order('created_at', { ascending: false })
    .limit(body.limit || 50);
  return { status: 'ok', notifications: (data || []).map(rowToCamel) };
}

// Resolve the company_id for a notification recipient (staff or client).
async function _recipientCompanyId(recipientType, recipientId) {
  if (!recipientId) return null;
  if (recipientType === 'staff') {
    const { data } = await sb.from('staff').select('company_id').eq('staff_id', recipientId).maybeSingle();
    return data?.company_id || null;
  }
  if (recipientType === 'client') {
    const { data } = await sb.from('clients').select('company_id').eq('id', recipientId).maybeSingle();
    return data?.company_id || null;
  }
  return null;
}

async function _getUnreadCount(body) {
  const companyId = await _recipientCompanyId(body.recipientType, body.recipientId);
  if (!companyId) return { status: 'ok', count: 0 };
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('recipient_type', body.recipientType)
    .eq('recipient_id', body.recipientId)
    .eq('read', false);
  return { status: 'ok', count: count || 0 };
}

async function _markNotificationRead(body) {
  if (body.notificationId === 'all') {
    await sb.from('notifications').update({ read: true })
      .eq('recipient_type', body.recipientType)
      .eq('recipient_id', body.recipientId)
      .eq('read', false);
  } else {
    await sb.from('notifications').update({ read: true }).eq('id', body.notificationId);
  }
  _cleanupOldNotifications(); // fire and forget
  return { status: 'ok' };
}

async function _deleteReadNotifications(body) {
  await sb.from('notifications').delete()
    .eq('recipient_type', body.recipientType)
    .eq('recipient_id', body.recipientId)
    .eq('read', true);
  return { status: 'ok' };
}

// Notification preferences cache (per company, per page load)
let _notifPrefsCache = {};
let _notifPrefsCacheTime = {};
async function _getNotifPrefs(companyId) {
  const cid = companyId; // no fallback company; null -> default prefs ({})
  const ck = cid || '_none';
  // Cache for 5 seconds per company
  if (_notifPrefsCache[ck] && Date.now() - (_notifPrefsCacheTime[ck] || 0) < 5000) return _notifPrefsCache[ck];
  try {
    const _np = await _configValue(cid, 'notification_preferences');
    _notifPrefsCache[ck] = _np ? JSON.parse(_np) : {};
  } catch(e) { _notifPrefsCache[ck] = {}; }
  _notifPrefsCacheTime[ck] = Date.now();
  return _notifPrefsCache[ck];
}

// \u2500\u2500 Reports \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

async function _submitReport(body) {
  const { staffId, staffName, locationId, category, title, description } = body;
  if (!title || !staffId) return { status: 'error', message: 'Missing required fields' };

  const reportId = 'RPT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
  const _rptCompanyId = await _companyIdFor(staffId, false);
  const { error } = await sb.from('reports').insert({
    report_id: reportId,
    company_id: _rptCompanyId,
    staff_id: staffId,
    staff_name: staffName || null,
    location_id: locationId || null,
    category: category || 'bug',
    priority: 'normal',
    title,
    description: description || null,
    status: 'open',
  });
  if (error) return { status: 'error', message: error.message };

  // Notify all admins at this location (non-blocking failures ok)
  try {
    if (locationId) {
      await _notifyAdminsAtLocation(
        locationId,
        'new_report',
        'New report filed',
        (staffName || 'Staff') + ' filed a ' + (category || 'bug') + ': ' + title,
        'reports',
        reportId,
        reportId
      );
    }
  } catch(e) { /* non-critical */ }

  return { status: 'ok', reportId };
}

async function _getReports(body) {
  const { locationId, uuid } = body;
  let q = sb.from('reports').select('*').order('created_at', { ascending: false });
  const _grCompanyId = uuid ? await _companyIdFor(uuid, false) : null;
  if (_grCompanyId) q = q.eq('company_id', _grCompanyId);
  if (locationId) q = q.eq('location_id', locationId);
  const { data, error } = await q;
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok', reports: data || [] };
}

async function _getReportComments(body) {
  const { reportId } = body;
  if (!reportId) return { status: 'error', message: 'Missing reportId' };
  const { data, error } = await sb.from('report_comments').select('*').eq('report_id', reportId).order('created_at');
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok', comments: data || [] };
}

async function _addReportComment(body) {
  const { reportId, authorId, authorName, authorRole, content } = body;
  if (!reportId || !content) return { status: 'error', message: 'Missing fields' };
  const commentId = 'RC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
  // company from the parent report
  const { data: _parentRpt } = await sb.from('reports').select('company_id').eq('report_id', reportId).maybeSingle();
  const { error } = await sb.from('report_comments').insert({
    comment_id: commentId,
    company_id: _parentRpt ? _parentRpt.company_id : null,
    report_id: reportId,
    author_id: authorId,
    author_name: authorName || null,
    author_role: authorRole || 'staff',
    content,
  });
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok', commentId };
}

async function _updateReportStatus(body) {
  const { reportId, status, priority, staffName } = body;
  if (!reportId) return { status: 'error', message: 'Missing reportId' };
  const upd = {};
  if (status)   upd.status   = status;
  if (priority) upd.priority = priority;
  if (status === 'resolved' || status === 'closed') {
    upd.resolved_at = new Date().toISOString();
    upd.resolved_by = staffName || null;
  }
  const { error } = await sb.from('reports').update(upd).eq('report_id', reportId);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}

async function _acknowledgeReport(body) {
  const { reportId } = body;
  if (!reportId) return { status: 'error', message: 'Missing reportId' };
  // Only update if currently open \u2014 idempotent
  await sb.from('reports').update({ status: 'acknowledged' }).eq('report_id', reportId).eq('status', 'open');
  return { status: 'ok' };
}

async function _getSystemFeedbackEnabled(body) {
  const companyId = (body && body.uuid) ? await _companyIdFor(body.uuid, false) : null; // no fallback
  const _val = await _configValue(companyId, 'system_feedback_staff_enabled');
  // Disabled if value is explicitly '0', 'false', or 'no' — absent = enabled by default
  const enabled = (_val === undefined || _val === null) ? true : !['0','false','no'].includes(_val);
  return { status: 'ok', enabled };
}

async function _setSystemFeedbackEnabled(body) {
  const companyId = (body && body.uuid) ? await _companyIdFor(body.uuid, false) : null; // no fallback (write)
  if (!companyId) return { status: 'error', message: 'Something went wrong, please try again.' };
  const val = body.enabled ? 'true' : 'false';
  const { data: existing } = await sb.from('config').select('key').eq('key', 'system_feedback_staff_enabled').eq('company_id', companyId).maybeSingle();
  if (existing) {
    await sb.from('config').update({ value: val }).eq('key', 'system_feedback_staff_enabled').eq('company_id', companyId);
  } else {
    await sb.from('config').insert({ key: 'system_feedback_staff_enabled', value: val, company_id: companyId, description: 'Allow staff to access System Feedback page' });
  }
  return { status: 'ok' };
}

async function _deleteReport(body) {
  const { reportId } = body;
  if (!reportId) return { status: 'error', message: 'Missing reportId' };
  // Comments cascade on delete via FK constraint
  const { error } = await sb.from('reports').delete().eq('report_id', reportId);
  if (error) return { status: 'error', message: error.message };
  return { status: 'ok' };
}

async function _createNotification(recipientType, recipientId, type, title, message, linkAction, linkId, relatedId) {
  // Resolve company from the recipient (client or staff) first — needed for prefs + stamping
  let _notifCompanyId = null;
  try {
    if (recipientType === 'client') {
      const { data: rc } = await sb.from('clients').select('company_id').eq('id', recipientId).maybeSingle();
      _notifCompanyId = rc ? rc.company_id : null;
    } else {
      const { data: rs } = await sb.from('staff').select('company_id').eq('staff_id', recipientId).maybeSingle();
      _notifCompanyId = rs ? rs.company_id : null;
    }
  } catch(e) { /* leave null on failure */ }

  // Check notification preferences (scoped to this company)
  try {
    const prefs = await _getNotifPrefs(_notifCompanyId);
    const key = type + '_' + recipientType + '_inapp';
    if (prefs[key] === false) return null;
  } catch(e) { /* if prefs check fails, send anyway */ }

  const id = 'NTF' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { error } = await sb.from('notifications').insert({
    id, company_id: _notifCompanyId, recipient_type: recipientType, recipient_id: recipientId,
    type, title, message: message || null,
    link_action: linkAction || null, link_id: linkId || null,
    related_id: relatedId || null, read: false
  });
  if (error) { return null; }
  // Log to notification_log (non-blocking)
  sb.from('notification_log').insert({
    id: 'NL' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    company_id: _notifCompanyId,
    notification_id: id, recipient_type: recipientType, recipient_id: recipientId,
    type, channel: 'in_app', subject: title, message: message || null,
    related_id: relatedId || null
  }).then(() => {}).catch(() => {});
  return id;
}

async function _deleteNotificationsByRelated(relatedId) {
  if (!relatedId) return;
  await sb.from('notifications').delete().eq('related_id', relatedId);
}

// Cleanup: delete in-app bell notifications older than each company's retention
// window. Deletes ALL aged-out rows in the `notifications` table (read AND
// unread) — there is no read filter. Does NOT touch `notification_log`, which is
// kept as a permanent audit trail (see HANDOFF — log retention is intentionally
// not wired to this setting).
// TENANT ISOLATION: a single-company sweep would only ever clean the picked
// company and let every other tenant's notifications grow forever. Process all
// companies, each scoped to its own company_id with its own retention setting.
async function _cleanupOldNotifications() {
  try {
    const { data: companies } = await sb.from('companies').select('id').neq('slug', '__platform__');
    for (const _co of (companies || [])) {
      const _cid = _co.id;
      if (!_cid) continue;
      const _rd = await _configValue(_cid, 'notification_retention_days');
      const days = parseInt(_rd) || 30;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      await sb.from('notifications').delete().eq('company_id', _cid).lt('created_at', cutoff);
    }
  } catch(e) { /* silent \u2014 cleanup is non-critical */ }
}

// Notify all staff at a location
async function _notifyStaffAtLocation(locId, type, title, message, linkAction, linkId, relatedId) {
  const { data: staff } = await sb.from('staff').select('staff_id').eq('default_location_id', locId).eq('active', true).eq('role', 'staff');
  for (const s of (staff || [])) {
    await _createNotification('staff', s.staff_id, type, title, message, linkAction, linkId, relatedId);
  }
}

// Notify all admins at a location
async function _notifyAdminsAtLocation(locId, type, title, message, linkAction, linkId, relatedId) {
  const { data: loc } = await sb.from('locations').select('company_id').eq('location_id', locId).maybeSingle();
  const companyId = loc?.company_id;
  if (!companyId) return;
  const { data: admins } = await sb.from('staff').select('staff_id').eq('company_id', companyId).eq('active', true).eq('role', 'admin');
  for (const a of (admins || [])) {
    await _createNotification('admin', a.staff_id, type, title, message, linkAction, linkId, relatedId);
  }
}

// Notify staff at a location who hold the can_verify_id permission (id_submitted only)
async function _notifyVerifyStaffAtLocation(locId, type, title, message, linkAction, linkId, relatedId) {
  const { data: staff } = await sb.from('staff').select('staff_id').eq('default_location_id', locId).eq('active', true).eq('role', 'staff').eq('can_verify_id', true);
  for (const s of (staff || [])) {
    await _createNotification('staff', s.staff_id, type, title, message, linkAction, linkId, relatedId);
  }
}

// Notify admins at a location who hold the can_verify_id permission (id_submitted only)
async function _notifyVerifyAdminsAtLocation(locId, type, title, message, linkAction, linkId, relatedId) {
  const { data: loc } = await sb.from('locations').select('company_id').eq('location_id', locId).maybeSingle();
  const companyId = loc?.company_id;
  if (!companyId) return;
  const { data: admins } = await sb.from('staff').select('staff_id').eq('company_id', companyId).eq('active', true).eq('role', 'admin').eq('can_verify_id', true);
  for (const a of (admins || [])) {
    await _createNotification('admin', a.staff_id, type, title, message, linkAction, linkId, relatedId);
  }
}