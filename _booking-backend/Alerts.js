/**
 * Health alerts to the professor (at most one mail per topic per 6 hours):
 *   errors - 3+ unexpected server errors within an hour
 *   job    - the 10-minute background job hasn't run for over an hour
 *   quota  - fewer than 10 of today's mails left
 */

function alertOwner_(topic, subject, lines) {
  const key = 'alert:' + topic;
  if (cache_().get(key)) return;
  cache_().put(key, '1', 6 * 60 * 60);
  const body = lines.concat([
    '',
    '실행 기록: https://script.google.com/home/projects/' + ScriptApp.getScriptId() + '/executions',
    '(같은 문제로는 6시간에 한 번만 알려드립니다.)'
  ]).join('\n');
  try {
    MailApp.sendEmail({ to: ownerEmail_(), subject: '[예약 시스템 점검] ' + subject, body: body, name: hostName_() });
  } catch (e) {
    console.error('alert mail failed: ' + e);
  }
}

/** Counts an unexpected error; alerts once 3 happen within an hour. */
function recordError_(where, err) {
  const msg = String((err && err.message) || err).slice(0, 300);
  console.error(where + ': ' + msg);
  try {
    const now = Date.now();
    let list = [];
    try { list = JSON.parse(cache_().get('errs:v1') || '[]'); } catch (e) { list = []; }
    list = list.filter(function (x) { return now - x.at < 60 * 60 * 1000; }).slice(-19);
    list.push({ at: now, where: where, msg: msg });
    cache_().put('errs:v1', JSON.stringify(list), 2 * 60 * 60);
    if (list.length >= 3) {
      alertOwner_('errors', '오류가 반복되고 있습니다', [
        '최근 1시간 동안 예약 시스템에서 오류가 ' + list.length + '번 발생했습니다. 최근 오류:',
        ''
      ].concat(list.slice(-5).map(function (x) {
        return '- ' + Utilities.formatDate(new Date(x.at), TZ, 'M/d HH:mm') + ' [' + x.where + '] ' + x.msg;
      })).concat(['', '일시적인 Google 서비스 문제일 수 있습니다. 계속되면 알려 주세요.']));
    }
  } catch (e) {
    console.error('recordError_ failed: ' + e);
  }
}

/** Called from public requests: notices when the time-based trigger stopped running. */
function checkHeartbeat_() {
  const last = Number(prop_('LAST_JOB') || 0);
  if (!last || Date.now() - last < 60 * 60 * 1000) return;
  alertOwner_('job', '자동 작업이 멈춘 것 같습니다', [
    '10분마다 돌아야 하는 자동 작업이 ' + Utilities.formatDate(new Date(last), TZ, 'M/d HH:mm') + ' 이후 실행되지 않았습니다.',
    '이 상태에서는 리마인더, 밀린 메일 발송, 캘린더 삭제 반영, 충돌 경고가 멈춥니다. (예약 자체는 계속 됩니다)',
    '',
    '해결: Apps Script 편집기에서 Setup.gs의 setup 함수를 한 번 실행하면 자동 작업이 다시 설치됩니다.'
  ]);
}

/** Called from the periodic job. */
function checkQuota_() {
  const left = MailApp.getRemainingDailyQuota();
  if (left >= 10) return;
  alertOwner_('quota', '오늘 메일 한도가 거의 찼습니다', [
    '오늘 보낼 수 있는 메일이 ' + left + '통 남았습니다. (개인 Gmail은 하루 약 100통)',
    '한도를 넘긴 확인·변경 메일은 내일 자동으로 이어서 보냅니다. 예약 자체는 정상적으로 받습니다.'
  ]);
}
