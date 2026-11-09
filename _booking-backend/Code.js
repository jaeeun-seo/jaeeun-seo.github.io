/**
 * Web app entry points. The GitHub Pages frontend calls:
 *   GET  ?action=init&m=ID            (meeting + first ~2 months of slots)
 *   GET  ?action=slots&m=ID&from=yyyy-MM-dd&to=yyyy-MM-dd[&t=TOKEN]
 *   GET  ?action=booking&t=TOKEN
 *   POST {action:'book', m, date, time, email, answers}
 *   POST {action:'cancel', t, reason}
 *   POST {action:'reschedule', t, date, time}
 *   POST {action:'notify', t}         (sends deferred emails / student calendar copy)
 *   POST {action:'clientError', msg, stack, view, ua}   (script error on the page -> owner alert)
 * POST bodies are sent as text/plain JSON to avoid CORS preflight.
 */
// Built lazily so this file doesn't depend on the order Apps Script loads files in.
function getActions_() {
  return { init: apiInit_, slots: apiSlots_, booking: apiBooking_ };
}
function postActions_() {
  return { book: apiBook_, cancel: apiCancel_, reschedule: apiReschedule_, notify: apiNotify_, clientError: apiClientError_ };
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  // No action = admin page, only for the owner (owner-only deployment).
  if (!p.action && isOwner_()) return adminPage_();
  return handle_(getActions_(), p);
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'BAD_REQUEST', message: '잘못된 요청입니다.' });
  }
  return handle_(postActions_(), body);
}

function handle_(actions, p) {
  const fn = actions[p.action];
  if (!fn) return json_({ ok: false, error: 'BAD_REQUEST', message: '알 수 없는 요청입니다.' });
  try { checkHeartbeat_(); } catch (e) { /* never block a request */ }
  try {
    return json_(Object.assign({ ok: true }, fn(p)));
  } catch (err) {
    if (err.code) return json_({ ok: false, error: err.code, message: err.message });
    console.error(err && err.stack ? err.stack : err);
    recordError_('요청 ' + p.action, err);
    return json_({ ok: false, error: 'SERVER', message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
