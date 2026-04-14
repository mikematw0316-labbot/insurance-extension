// ── Wire up buttons (no inline onclick — blocked by MV3 CSP) ─────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('readBtn').addEventListener('click', readSheet);
  document.getElementById('backBtn').addEventListener('click', () => goStep(1));
  document.getElementById('startBtn').addEventListener('click', startJob);
  document.getElementById('skipBtn').addEventListener('click', skipCurrent);
  document.getElementById('capSubmitBtn').addEventListener('click', submitCaptcha);
  document.getElementById('resetBtn').addEventListener('click', reset);
  document.getElementById('sheetUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') readSheet();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('captchaWrap').style.display !== 'none') {
      submitCaptcha();
    }
  });
});

// ── Port to background (keeps service worker alive) ───────────────────────────
const port = chrome.runtime.connect({ name: 'popup' });

port.onMessage.addListener(msg => {
  switch (msg.type) {
    case 'job_started':
      totalNames = msg.total;
      break;

    case 'item_start':
      setProgress(msg.index, msg.total, `處理中：${msg.name}`);
      addLog(`→ ${msg.name}`, 'info');
      break;

    case 'captcha_request':
      showCaptcha(msg.name, msg.captcha, msg.attempt);
      break;

    case 'captcha_error':
      document.getElementById('capErr').textContent = `第 ${msg.attempt} 次錯誤，請重新輸入`;
      document.getElementById('captchaInput').value = '';
      document.getElementById('captchaInput').focus();
      break;

    case 'item_done':
      hideCaptcha();
      const r = msg.result;
      if (r.status === 'success') {
        const ok = r.files.filter(f => f.status === 'ok').length;
        const miss = r.files.filter(f => f.status !== 'ok').length;
        addLog(`✓ ${r.name}（${ok} 個 PDF${miss ? '，' + miss + ' 個未找到' : ''}）`, 'ok');
      } else if (r.status === 'not_found') {
        addLog(`✗ ${r.name}：查無資料`, 'err');
      } else if (r.status === 'skipped') {
        addLog(`→ ${r.name}：跳過`, 'info');
      } else {
        addLog(`✗ ${r.name}：${r.message}`, 'err');
      }
      setProgress(msg.index, msg.total);
      break;

    case 'job_done':
      hideCaptcha();
      showResults(msg.results);
      break;

    case 'job_aborted':
      addLog('⚠ 視窗被關閉，作業中止', 'warn');
      break;
  }
});

// ── State ─────────────────────────────────────────────────────────────────────
let sheetData = null;
let totalNames = 0;

// ── Step helpers ──────────────────────────────────────────────────────────────
function goStep(n) {
  document.querySelectorAll('.step').forEach((s, i) => {
    s.classList.toggle('active', i + 1 === n);
  });
}

// ── Step 1: Read Sheet ────────────────────────────────────────────────────────
async function readSheet() {
  const url = document.getElementById('sheetUrl').value.trim();
  const errEl = document.getElementById('sheetErr');
  errEl.style.display = 'none';

  if (!url) return;

  const idMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch = url.match(/[?&#]gid=(\d+)/);
  if (!idMatch) {
    errEl.textContent = '無效的 Google Sheet URL'; errEl.style.display = 'block'; return;
  }

  const csvUrl = `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gidMatch?.[1] ?? '0'}`;

  try {
    const resp = await fetch(csvUrl);
    if (!resp.ok) {
      errEl.textContent = '無法讀取試算表，請確認已設為「知道連結的人可查看」';
      errEl.style.display = 'block'; return;
    }
    const text = await resp.text();
    const rows = parseCSV(text);
    if (!rows.length) { errEl.textContent = '試算表為空'; errEl.style.display = 'block'; return; }

    sheetData = { headers: rows[0], data: rows.slice(1).filter(r => r.some(c => c)) };
    const nameIdx = sheetData.headers.findIndex(h => /商品名稱|保險名稱|保單名稱|名稱/.test(h));

    // Populate column selector
    const sel = document.getElementById('colSel');
    sel.innerHTML = sheetData.headers.map((h, i) =>
      `<option value="${i}" ${i === nameIdx ? 'selected' : ''}>${h || '欄 ' + (i + 1)}</option>`
    ).join('');
    document.getElementById('colWrap').style.display = 'block';
    document.getElementById('readBtn').textContent = '下一步 →';
    document.getElementById('readBtn').removeEventListener('click', readSheet);
    document.getElementById('readBtn').addEventListener('click', showNameList);
    if (nameIdx >= 0) showNameList();
  } catch (e) {
    errEl.textContent = '讀取失敗：' + e.message; errEl.style.display = 'block';
  }
}

function showNameList() {
  const colIdx = parseInt(document.getElementById('colSel').value);
  const names = sheetData.data.map(r => r[colIdx] || '').filter(n => n.trim());

  const list = document.getElementById('nameList');
  list.innerHTML = names.map((n, i) => `
    <div class="name-item">
      <input type="checkbox" id="n${i}" class="name-chk" value="${i}" checked>
      <label for="n${i}">${esc(n)}</label>
    </div>`).join('');

  document.getElementById('countText').textContent = `共 ${names.length} 筆，全部勾選`;
  goStep(2);
}

// ── Step 2: Start job ─────────────────────────────────────────────────────────
function startJob() {
  const colIdx = parseInt(document.getElementById('colSel').value);
  const checked = [...document.querySelectorAll('.name-chk:checked')].map(c => parseInt(c.value));
  const names = sheetData.data
    .map(r => r[colIdx] || '').filter((_, i) => checked.includes(i)).filter(n => n.trim());

  if (!names.length) { alert('請至少勾選一筆'); return; }

  goStep(3);
  port.postMessage({ type: 'start_job', names });
}

// ── CAPTCHA handling ──────────────────────────────────────────────────────────
function showCaptcha(name, dataUrl, attempt) {
  document.getElementById('capInsName').textContent = name;
  document.getElementById('capProgress').textContent =
    attempt > 1 ? `第 ${attempt} 次嘗試` : '請輸入驗證碼';
  document.getElementById('captchaImg').src = dataUrl || '';
  document.getElementById('captchaInput').value = '';
  document.getElementById('capErr').textContent = '';
  document.getElementById('captchaWrap').style.display = 'block';
  setTimeout(() => document.getElementById('captchaInput').focus(), 50);
}

function hideCaptcha() {
  document.getElementById('captchaWrap').style.display = 'none';
}

function submitCaptcha() {
  const val = document.getElementById('captchaInput').value.trim();
  if (!val) return;
  document.getElementById('capSubmitBtn').disabled = true;
  port.postMessage({ type: 'captcha_submit', value: val });
  setTimeout(() => { document.getElementById('capSubmitBtn').disabled = false; }, 1500);
}

function skipCurrent() {
  port.postMessage({ type: 'captcha_skip' });
  hideCaptcha();
}

// ── Progress ──────────────────────────────────────────────────────────────────
function setProgress(done, total, label) {
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById('progBar').style.width = pct + '%';
  document.getElementById('progText').textContent =
    label || `進度：${done} / ${total}（${pct}%）`;
}

function addLog(msg, type = '') {
  const box = document.getElementById('logBox');
  const line = document.createElement('div');
  line.className = 'log-line log-' + type;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── Step 4: Results ───────────────────────────────────────────────────────────
function showResults(results) {
  setProgress(totalNames, totalNames);
  addLog('── 完成 ──', 'info');
  goStep(4);

  const list = document.getElementById('resultList');
  list.innerHTML = (results || []).map(r => {
    let badge = '';
    let files = '';
    if (r.status === 'success') {
      badge = '<span class="badge badge-ok">成功</span>';
      files = '<div class="result-files">' + (r.files || []).map(f =>
        f.status === 'ok'
          ? `<span style="color:var(--success)">✓ ${f.label}</span> `
          : `<span style="color:var(--error)">✗ ${f.label}</span> `
      ).join('') + '</div>';
    } else if (r.status === 'not_found') {
      badge = '<span class="badge badge-warn">查無</span>';
    } else if (r.status === 'skipped') {
      badge = '<span class="badge badge-skip">跳過</span>';
    } else {
      badge = '<span class="badge badge-err">錯誤</span>';
    }
    return `<div class="result-item">${badge}<span class="result-name">${esc(r.name)}</span>${files}</div>`;
  }).join('');
}

function reset() { location.reload(); }

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { field += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { row.push(field.trim()); field = ''; }
    else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(f => f)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(f => f)) rows.push(row); }
  return rows;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
