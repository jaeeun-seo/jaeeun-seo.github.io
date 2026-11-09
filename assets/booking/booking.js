/* Student booking page.  ?m=<meetingId> books, ?t=<token> manages a booking. */
(function () {
  'use strict';

  var API = window.BOOKING_API;
  var app = document.getElementById('booking-app');
  var params = new URLSearchParams(location.search);
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var HEAD = ['일', '월', '화', '수', '목', '금', '토'];   // weeks start on Sunday

  var S = {
    mid: params.get('m'),
    token: params.get('t'),
    meeting: null,
    booking: null,
    view: 'loading',     // pick | form | done | manage | cancel | message
    rescheduling: false,
    month: null,         // {y, m} with m 0-based
    slots: {},           // 'yyyy-mm-dd' -> ['14:00', ...]
    loaded: {},          // 'yyyy-mm' -> true | 'loading'
    gen: 0,              // bumps on resetSlots(); stale slot responses are ignored
    date: null,
    time: null,
    busy: false,
    error: '',
    result: null,
    message: null,
    form: { email: '', answers: {} },
    reason: ''
  };

  /* ---------- helpers ---------- */

  var ICONS = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6"/>',
    calx: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M10 13l4 4M14 13l-4 4"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
  };
  function icon(name, cls) {
    return '<svg class="bk-ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function linkify(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function todayKST() {
    var p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var g = function (t) { return p.filter(function (x) { return x.type === t; })[0].value; };
    return g('year') + '-' + g('month') + '-' + g('day');
  }
  function parseYmd(s) { var p = s.split('-'); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }
  function dateLabel(s) {
    var p = parseYmd(s);
    return p.y + '년 ' + (p.m + 1) + '월 ' + p.d + '일 (' + DOW[new Date(p.y, p.m, p.d).getDay()] + ')';
  }
  function addMin(hhmm, min) {
    var t = +hhmm.slice(0, 2) * 60 + +hhmm.slice(3) + min;
    return pad(Math.floor(t / 60) % 24) + ':' + pad(t % 60);
  }
  function monthKey(mo) { return mo.y + '-' + pad(mo.m + 1); }
  function monthOf(s) { var p = parseYmd(s); return { y: p.y, m: p.m }; }
  function nextMonth(mo, n) { var t = mo.y * 12 + mo.m + n; return { y: Math.floor(t / 12), m: t % 12 }; }
  function monthLast(mo) { return ymd(mo.y, mo.m, new Date(mo.y, mo.m + 1, 0).getDate()); }

  var CONN_ERR = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.';

  function parseReply(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { throw new Error(CONN_ERR); } // e.g. a Google error page
    if (!j.ok) { var err = new Error(j.message || '오류가 발생했습니다.'); err.code = j.error; throw err; }
    return j;
  }

  function api(action, data, post) {
    var payload = Object.assign({ action: action }, data || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;   // never hang forever
    var opts = ctrl ? { signal: ctrl.signal } : {};
    var req = post
      ? fetch(API, Object.assign(opts, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }))
      : fetch(API + '?' + new URLSearchParams(payload).toString(), opts);
    return req
      .then(function (r) { clearTimeout(timer); return r.text(); }, function () { clearTimeout(timer); throw new Error(CONN_ERR); })
      .then(parseReply);
  }

  /** Uses the request the page head already started (window.BK_BOOT), if any. */
  function boot(action, data) {
    if (window.BK_BOOT) {
      var p = window.BK_BOOT;
      window.BK_BOOT = null;
      return p.then(function (text) { if (text == null) throw new Error(CONN_ERR); return parseReply(text); });
    }
    return api(action, data);
  }

  // Sends the work owed by the last write action (emails, student calendar copy).
  // Fire-and-forget; keepalive lets it finish even if the tab is closed, and the
  // server has a fallback job as well.
  function notify(token) {
    try {
      fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'notify', t: token }) }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  /* ---------- data ---------- */

  function markLoaded(from, to) {
    var last = S.meeting.lastDate;
    for (var mo = monthOf(from); monthKey(mo) <= to.slice(0, 7); mo = nextMonth(mo, 1)) {
      if (monthLast(mo) <= to || to >= last) S.loaded[monthKey(mo)] = true;
    }
  }

  function loadMonth(mo, quiet) {
    var key = monthKey(mo);
    if (S.loaded[key]) return;
    var from = ymd(mo.y, mo.m, 1), to = monthLast(mo), today = todayKST();
    if (from < today) from = today;
    if (to > S.meeting.lastDate) to = S.meeting.lastDate;
    if (from > to) { S.loaded[key] = true; return; }

    S.loaded[key] = 'loading';
    var gen = S.gen;
    var q = { m: S.meeting.id, from: from, to: to };
    if (S.rescheduling) q.t = S.token;
    api('slots', q).then(function (j) {
      if (gen !== S.gen) return;                    // slots were reset meanwhile
      Object.keys(S.slots).forEach(function (d) { if (d.slice(0, 7) === key) delete S.slots[d]; });
      Object.assign(S.slots, j.slots);
      S.loaded[key] = true;
      if (S.date && !S.slots[S.date]) { S.date = null; S.time = null; }
      if (S.view === 'pick') render();             // never redraw the form while someone types
      if (!quiet) loadMonth(nextMonth(mo, 1), true); // prefetch so the next click is instant
    }, function (e) {
      if (gen !== S.gen) return;
      S.loaded[key] = false;
      var visible = S.month && monthKey(S.month) === key;
      if (!quiet || visible) { S.error = e.message; if (S.view === 'pick') render(); }
    });
  }

  function resetSlots() { S.slots = {}; S.loaded = {}; S.gen++; }

  /* ---------- views ---------- */

  function infoPanel() {
    var m = S.meeting;
    var desc = (m.description || '').split('\n').filter(function (l) { return l.trim(); });
    var html =
      '<div class="bk-host">' + esc(m.host) + '</div>' +
      '<h1 class="bk-title">' + esc(m.name) + '</h1>' +
      '<ul class="bk-meta">' +
      '<li>' + icon('clock') + m.duration + '분</li>' +
      (m.location ? '<li>' + icon('pin') + esc(m.location) + '</li>' : '') +
      '</ul>';
    if (S.date && S.time && (S.view === 'form' || S.view === 'done')) {
      html += '<div class="bk-chosen">' + icon('calendar') + '<span>' +
        esc(dateLabel(S.date)) + '<br>' + S.time + ' - ' + addMin(S.time, m.duration) + '</span></div>';
    }
    if (desc.length) {
      html += '<ul class="bk-desc">' + desc.map(function (l) { return '<li>' + linkify(l) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  function errorBox() {
    return S.error ? '<div class="bk-error" role="alert">' + esc(S.error) + '</div>' : '';
  }

  function calendarView() {
    var mo = S.month;
    var key = monthKey(mo);
    var loading = S.loaded[key] === 'loading';
    var today = todayKST();
    var firstMo = monthOf(today);
    var lastMo = monthOf(S.meeting.lastDate);
    var canPrev = mo.y * 12 + mo.m > firstMo.y * 12 + firstMo.m;
    var canNext = mo.y * 12 + mo.m < lastMo.y * 12 + lastMo.m;

    var offset = new Date(mo.y, mo.m, 1).getDay();
    var days = new Date(mo.y, mo.m + 1, 0).getDate();
    var cells = '';
    for (var i = 0; i < offset; i++) cells += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var ds = ymd(mo.y, mo.m, d);
      var avail = !!S.slots[ds];
      var cls = ['bk-day'];
      if (avail) cls.push('avail');
      if (ds === S.date) cls.push('selected');
      if (ds === today) cls.push('today');
      cells += avail
        ? '<button type="button" class="' + cls.join(' ') + '" data-act="date" data-date="' + ds + '" aria-label="' +
          esc(dateLabel(ds)) + (ds === today ? ' (오늘)' : '') + ', 예약 가능" aria-pressed="' + (ds === S.date) + '">' + d + '</button>'
        : '<span class="' + cls.join(' ') + '" aria-hidden="true">' + d + '</span>';
    }

    return '<div class="bk-cal' + (loading ? ' is-loading' : '') + '" aria-busy="' + loading + '">' +
      '<div class="bk-cal-head">' +
      '<button type="button" class="bk-nav" data-act="prev" ' + (canPrev ? '' : 'disabled') + ' aria-label="이전 달">' + icon('left') + '</button>' +
      '<span class="bk-month" aria-live="polite">' + mo.y + '년 ' + (mo.m + 1) + '월</span>' +
      '<button type="button" class="bk-nav" data-act="next" ' + (canNext ? '' : 'disabled') + ' aria-label="다음 달">' + icon('right') + '</button>' +
      '</div>' +
      '<div class="bk-grid bk-dow" aria-hidden="true">' + HEAD.map(function (h) { return '<span>' + h + '</span>'; }).join('') + '</div>' +
      '<div class="bk-grid">' + cells + '</div>' +
      (loading ? '<div class="bk-cal-loading"><div class="bk-spinner"></div></div>' : '') +
      '</div>';
  }

  function timesView() {
    var key = monthKey(S.month);
    if (!S.date || S.date.slice(0, 7) !== key) {
      var any = Object.keys(S.slots).some(function (d) { return d.slice(0, 7) === key; });
      var note = S.loaded[key] === true && !any ? '이 달에는 예약 가능한 시간이 없습니다.' : '날짜를 선택하세요.';
      return '<div class="bk-times bk-times-empty">' + note + '</div>';
    }
    var nextLabel = S.rescheduling ? '변경' : '다음';
    var dur = S.meeting.duration;
    var list = (S.slots[S.date] || []).map(function (t) {
      var label = t + ' - ' + addMin(t, dur);
      if (t === S.time) {
        return '<div class="bk-time-row">' +
          '<span class="bk-time chosen">' + label + '</span>' +
          '<button type="button" class="bk-btn" data-act="next-step"' + (S.busy ? ' disabled' : '') + '>' +
          (S.busy ? '변경 중…' : nextLabel) + '</button></div>';
      }
      return '<button type="button" class="bk-time" data-act="time" data-time="' + t + '">' + label + '</button>';
    }).join('');
    return '<div class="bk-times"><div class="bk-times-date">' + esc(dateLabel(S.date)) + '</div>' + list + '</div>';
  }

  function pickView() {
    var title = S.rescheduling ? '변경할 날짜와 시간을 선택하세요' : '날짜와 시간을 선택하세요';
    return (S.rescheduling ? '<button type="button" class="bk-back" data-act="manage">' + icon('back') + ' 돌아가기</button>' : '') +
      '<h2 class="bk-h2">' + title + '</h2>' + errorBox() +
      '<div class="bk-pick">' + calendarView() + timesView() + '</div>' +
      '<p class="bk-tz">' + icon('globe') + ' 한국 시간(KST) 기준</p>';
  }

  function formView() {
    var m = S.meeting, f = S.form;
    var fields =
      '<label class="bk-field"><span>이메일 <b>*</b></span>' +
      '<input type="email" name="email" data-form="email" required autocomplete="email" maxlength="200" value="' + esc(f.email) + '"></label>' +
      m.questions.map(function (q) {
        var val = f.answers[q.key] || '';
        var attrs = ' name="q_' + esc(q.key) + '" data-form="q:' + esc(q.key) + '"' + (q.required ? ' required' : '');
        var input = q.type === 'textarea'
          ? '<textarea' + attrs + ' rows="4" maxlength="2000">' + esc(val) + '</textarea>'
          : '<input type="text"' + attrs + ' maxlength="' + (q.key === 'name' ? 20 : 200) + '"' + (q.key === 'name' ? ' autocomplete="name"' : '') + ' value="' + esc(val) + '">';
        return '<label class="bk-field"><span>' + esc(q.label) + (q.required ? ' <b>*</b>' : '') + '</span>' +
          (q.help ? '<small>' + esc(q.help) + '</small>' : '') + input + '</label>';
      }).join('');
    return '<button type="button" class="bk-back" data-act="back">' + icon('back') + ' 시간 다시 선택</button>' +
      '<h2 class="bk-h2">정보 입력</h2>' + errorBox() +
      '<form class="bk-form" id="bk-form" novalidate>' + fields +
      '<button type="submit" class="bk-btn bk-btn-lg"' + (S.busy ? ' disabled' : '') + '>' +
      (S.busy ? '예약 중…' : '예약하기') + '</button></form>';
  }

  function icsUrl(c) {
    var stamp = function (iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    var e = function (s) { return String(s || '').replace(/([\\;,])/g, '\\$1').replace(/\r\n|\r|\n/g, '\\n'); };
    var text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//jaeeun-seo.github.io//booking//KO', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', 'UID:' + c.uid + '@jaeeun-seo.github.io', 'DTSTAMP:' + stamp(new Date().toISOString()),
      'DTSTART:' + stamp(c.start), 'DTEND:' + stamp(c.end), 'SUMMARY:' + e(c.title), 'LOCATION:' + e(c.location),
      'DESCRIPTION:' + e('변경/취소: ' + c.manageLink), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  }

  function doneView() {
    var r = S.result, c = r.calendar;
    if (c && !r.icsHref) r.icsHref = icsUrl(c);
    return '<div class="bk-done">' +
      '<div class="bk-check">' + icon('check') + '</div>' +
      '<h2 class="bk-h2">예약이 확정되었습니다</h2>' +
      '<p class="bk-done-when">' + esc(r.booking.dateLabel) + '<br>' + r.booking.start + ' - ' + r.booking.end + '</p>' +
      '<p class="bk-muted">확인 메일을 <b>' + esc(r.booking.email) + '</b>(으)로 보냈습니다.<br>일정 변경·취소는 메일의 링크에서 할 수 있습니다.</p>' +
      (c ? '<div class="bk-actions bk-center">' +
        '<a class="bk-btn bk-btn-ghost" href="' + esc(c.google) + '" target="_blank" rel="noopener">' + icon('calendar') + ' Google 캘린더에 추가</a>' +
        '<a class="bk-btn bk-btn-ghost" href="' + r.icsHref + '" download="meeting.ics">' + icon('download') + ' 다른 캘린더 (.ics)</a></div>' : '') +
      (r.confirmationMessage ? '<div class="bk-note">' + linkify(r.confirmationMessage).replace(/\n/g, '<br>') + '</div>' : '') +
      '</div>';
  }

  function bookingSummary(b) {
    return '<dl class="bk-summary">' +
      '<dt>일시</dt><dd>' + esc(b.dateLabel) + ' ' + b.start + ' - ' + b.end + '</dd>' +
      '<dt>이메일</dt><dd>' + esc(b.email) + '</dd>' +
      (b.name ? '<dt>이름</dt><dd>' + esc(b.name) + '</dd>' : '') +
      '</dl>';
  }

  function manageView() {
    var b = S.booking;
    var status = '', actions = '', note = '';
    if (b.status === 'cancelled') {
      status = '<div class="bk-badge cancelled">취소된 예약입니다</div>';
      actions = b.meeting.paused ? '' : '<a class="bk-btn" href="?m=' + encodeURIComponent(b.meeting.id) + '">새로 예약하기</a>';
    } else if (b.past) {
      status = '<div class="bk-badge">지난 미팅입니다</div>';
    } else {
      status = '<div class="bk-badge ok">예약 확정</div>';
      var canMove = !b.meeting.paused && b.canReschedule !== false;
      if (b.meeting.paused) note = '현재 이 미팅은 일정 변경을 받지 않습니다. 취소는 할 수 있습니다.';
      else if (b.canReschedule === false) note = '일정 변경 가능 횟수를 모두 사용했습니다. 취소 후 다시 예약해 주세요.';
      actions = (canMove ? '<button type="button" class="bk-btn" data-act="reschedule">시간 변경</button>' : '') +
        '<button type="button" class="bk-btn bk-btn-ghost" data-act="cancel-start">예약 취소</button>';
    }
    return '<h2 class="bk-h2">내 예약</h2>' + errorBox() + status + bookingSummary(b) +
      (S.message ? '<div class="bk-note" role="status">' + esc(S.message) + '</div>' : '') +
      (note ? '<p class="bk-muted">' + esc(note) + '</p>' : '') +
      '<div class="bk-actions">' + actions + '</div>';
  }

  function cancelView() {
    return '<button type="button" class="bk-back" data-act="manage">' + icon('back') + ' 돌아가기</button>' +
      '<h2 class="bk-h2">예약을 취소할까요?</h2>' + errorBox() + bookingSummary(S.booking) +
      '<label class="bk-field"><span>취소 사유 (선택)</span><textarea id="bk-reason" data-form="reason" rows="3" maxlength="500">' + esc(S.reason) + '</textarea></label>' +
      '<div class="bk-actions"><button type="button" class="bk-btn bk-btn-danger" data-act="cancel-confirm"' + (S.busy ? ' disabled' : '') + '>' +
      (S.busy ? '취소 중…' : '예약 취소하기') + '</button></div>';
  }

  function messageView() {
    return '<div class="bk-message">' + icon('calx', 'bk-ic-lg') + '<p>' + esc(S.message) + '</p></div>';
  }

  // Re-render while keeping keyboard focus on the "same" control.
  function focusKey(el) {
    if (!el || !app.contains(el)) return null;
    var keys = ['data-act', 'data-date', 'data-time', 'data-form'];
    var sel = keys.filter(function (k) { return el.hasAttribute(k); })
      .map(function (k) {
        var v = el.getAttribute(k);
        return '[' + k + '="' + (window.CSS && CSS.escape ? CSS.escape(v) : v) + '"]';
      }).join('');
    return sel || null;
  }

  function render(focusSel) {
    var fk = focusSel || focusKey(document.activeElement);
    var timesEl = app.querySelector('.bk-times');
    var scroll = timesEl ? timesEl.scrollTop : 0;      // keep the time list where the student scrolled
    if (S.view === 'message') {
      app.className = 'bk-card bk-card-narrow';
      app.innerHTML = messageView();
      return;
    }
    var main = {
      pick: pickView, form: formView, done: doneView, manage: manageView, cancel: cancelView
    }[S.view]();
    var paused = S.meeting.paused && !S.token
      ? '<div class="bk-error" role="alert">현재 예약을 받지 않는 미팅입니다.</div>' : '';
    app.className = 'bk-card';
    app.innerHTML = '<aside class="bk-info">' + infoPanel() + '</aside>' +
      '<section class="bk-main">' + paused + main + '</section>';
    var newTimes = app.querySelector('.bk-times');
    if (newTimes && S.view === 'pick') newTimes.scrollTop = scroll;
    // A new error must be visible (on phones it is often above the screen).
    if (S.error && S.error !== S.shownError) {
      var eb = app.querySelector('.bk-error[role=alert]');
      if (eb && eb.getBoundingClientRect().top < 0 && eb.scrollIntoView) eb.scrollIntoView({ block: 'center' });
    }
    S.shownError = S.error;
    if (fk) {
      var el = null;
      try { el = app.querySelector(fk); } catch (err) { el = null; }
      if (el && !el.disabled) el.focus({ preventScroll: true });
      else if (/data-act="(prev|next)"/.test(fk)) {
        var other = app.querySelector('.bk-nav:not([disabled])');
        if (other) other.focus({ preventScroll: true });
      }
    }
  }

  /* ---------- actions ---------- */

  function setMonth(mo) {
    S.month = mo;
    S.error = '';
    loadMonth(mo);
    render();
  }

  function goPick() {
    S.view = 'pick';
    S.error = '';
    if (!S.month) S.month = monthOf(S.meeting.firstDate);
    loadMonth(S.month);
    render();
  }

  function onSlotTaken(e) {
    S.error = e.message;
    if (e.code === 'SLOT_TAKEN') {
      resetSlots();
      S.time = null;
      S.view = 'pick';
      loadMonth(S.month);
    }
  }

  function submitBooking() {
    var f = S.form;
    var data = { m: S.meeting.id, date: S.date, time: S.time, email: f.email.trim(), answers: {} };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { S.error = '이메일 주소를 확인해 주세요.'; render(); return; }
    var missing = null;
    S.meeting.questions.forEach(function (q) {
      var v = String(f.answers[q.key] || '').trim();
      if (q.required && !v && !missing) missing = q.label;
      data.answers[q.key] = v;
    });
    if (missing) { S.error = '"' + missing + '" 항목을 입력해 주세요.'; render(); return; }

    S.busy = true; S.error = ''; render();
    api('book', data, true).then(function (j) {
      S.busy = false;
      S.result = j;
      notify(j.token);
      S.view = 'done';
      render();
    }, function (e) {
      S.busy = false;
      onSlotTaken(e);
      render();
    });
  }

  function submitReschedule() {
    S.busy = true; S.error = ''; render();
    api('reschedule', { t: S.token, date: S.date, time: S.time }, true).then(function (j) {
      S.busy = false;
      S.booking = j.booking;
      notify(S.token);
      S.rescheduling = false;
      S.message = '일정이 변경되었습니다. 확인 메일을 보냈습니다.';
      S.view = 'manage';
      S.date = null; S.time = null;
      resetSlots();
      render();
    }, function (e) {
      S.busy = false;
      if (e.code === 'LIMIT' || e.code === 'NOT_ACTIVE' || e.code === 'PAST' || e.code === 'PAUSED' || e.code === 'NOT_FOUND') {
        S.rescheduling = false; S.date = null; S.time = null; resetSlots();
        api('booking', { t: S.token }).then(function (j) { S.booking = j.booking; }, function () {})
          .then(function () { S.view = 'manage'; S.error = e.message; render(); });
        return;
      }
      onSlotTaken(e);
      render();
    });
  }

  function submitCancel() {
    S.busy = true; S.error = ''; render();
    api('cancel', { t: S.token, reason: S.reason }, true).then(function (j) {
      S.busy = false;
      S.booking = j.booking;
      notify(S.token);
      S.message = '예약이 취소되었습니다. 확인 메일을 보냈습니다.';
      S.view = 'manage';
      render();
    }, function (e) {
      S.busy = false;
      S.error = e.message;
      render();
    });
  }

  app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el || el.disabled || S.busy) return;     // nothing else may run while a request is in flight
    var act = el.getAttribute('data-act');
    if (act === 'prev' || act === 'next') {
      setMonth(nextMonth(S.month, act === 'prev' ? -1 : 1));
    } else if (act === 'date') {
      S.date = el.getAttribute('data-date'); S.time = null; S.error = ''; render();
      // Phones: the times appear below the calendar - show them.
      var tl = app.querySelector('.bk-times');
      if (tl && window.matchMedia && matchMedia('(max-width: 820px)').matches && tl.scrollIntoView) {
        tl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    } else if (act === 'time') {
      S.time = el.getAttribute('data-time'); render('[data-act="next-step"]');
    } else if (act === 'next-step') {
      if (S.rescheduling) submitReschedule();
      else { S.view = 'form'; S.error = ''; render('[data-form="email"]'); }
    } else if (act === 'back') {
      goPick();
    } else if (act === 'manage') {
      S.view = 'manage'; S.rescheduling = false; S.error = ''; S.date = null; S.time = null; render();
    } else if (act === 'reschedule') {
      S.rescheduling = true; S.message = null; S.date = null; S.time = null; resetSlots();
      S.month = monthOf(S.booking.date < todayKST() ? todayKST() : S.booking.date);
      goPick();
    } else if (act === 'cancel-start') {
      S.view = 'cancel'; S.message = null; S.error = ''; render();
    } else if (act === 'cancel-confirm') {
      submitCancel();
    }
  });

  // Typed values live in state, so re-renders (errors, busy) never wipe them.
  app.addEventListener('input', function (ev) {
    var k = ev.target.getAttribute('data-form');
    if (!k) return;
    if (k === 'email') S.form.email = ev.target.value;
    else if (k === 'reason') S.reason = ev.target.value;
    else if (k.indexOf('q:') === 0) S.form.answers[k.slice(2)] = ev.target.value;
  });

  app.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!S.busy) submitBooking();
  });

  /* ---------- boot ---------- */

  function fail(msg) { S.view = 'message'; S.message = msg; render(); }

  if (!API || API.indexOf('http') !== 0) {
    fail('예약 시스템이 아직 설정되지 않았습니다.');
  } else if (S.token) {
    boot('booking', { t: S.token }).then(function (j) {
      S.booking = j.booking;
      S.meeting = j.booking.meeting;
      S.view = 'manage';
      render();
    }, function (e) { fail(e.message); });
  } else if (S.mid) {
    // One round trip: meeting info + the first ~2 months of slots.
    boot('init', { m: S.mid }).then(function (j) {
      S.meeting = j.meeting;
      Object.assign(S.slots, j.slots);
      markLoaded(j.slotsFrom, j.slotsTo);
      var first = Object.keys(j.slots).sort()[0];      // open on the first month that has slots
      S.month = monthOf(first || j.meeting.firstDate);
      goPick();
      loadMonth(nextMonth(monthOf(j.slotsTo), S.loaded[j.slotsTo.slice(0, 7)] ? 1 : 0), true); // quietly fetch past the init range
    }, function (e) { fail(e.message); });
  } else {
    fail('예약 링크가 올바르지 않습니다. 받은 링크를 다시 확인해 주세요.');
  }
})();
