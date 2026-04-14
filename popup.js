// All orchestration runs in popup.js (not background service worker)
// This avoids MV3 service worker lifetime issues during CAPTCHA waits.

// ── State ─────────────────────────────────────────────────────────────────────
let sheetData = null;
let jobTabId = null;
let captchaResolve = null;
let totalNames = 0;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('readBtn').addEventListener('click', readSheet);
  document.getElementById('backBtn').addEventListener('click', () => goStep(1));
  document.getElementById('startBtn').addEventListener('click', startJob);
  document.getElementById('skipBtn').addEventListener('click', skipCurrent);
  document.getElementById('capSubmitBtn').addEventListener('click', submitCaptcha);
  document.getElementById('resetBtn').addEventListener('click', () => location.reload());

  document.getElementById('sheetUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') readSheet();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('captchaWrap').style.display !== 'none') {
      submitCaptcha();
    }
  });
});

// ── Steps ─────────────────────────────────────────────────────────────────────
function goStep(n) {
  document.querySelectorAll('.step').forEach((s, i) => s.classList.toggle('active', i + 1 === n));
}

// ── Step 1: Read Sheet ────────────────────────────────────────────────────────
async function readSheet() {
  const url = document.getElementById('sheetUrl').value.trim();
  const errEl = document.getElementById('sheetErr');
  errEl.style.display = 'none';
  if (!url) return;

  const idMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch = url.match(/[?&#]gid=(\d+)/);
  if (!idMatch) { errEl.textContent = '無效的 Google Sheet URL'; errEl.style.display = 'block'; return; }

  const csvUrl = `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gidMatch?.[1] ?? '0'}`;
  try {
    const resp = await fetch(csvUrl);
    if (!resp.ok) {
      errEl.textContent = '無法讀取試算表，請確認已設為「知道連結的人可查看」';
      errEl.style.display = 'block'; return;
    }
    const rows = parseCSV(await resp.text());
    if (!rows.length) { errEl.textContent = '試算表為空'; errEl.style.display = 'block'; return; }

    sheetData = { headers: rows[0], data: rows.slice(1).filter(r => r.some(c => c)) };
    const nameIdx = sheetData.headers.findIndex(h => /商品名稱|保險名稱|保單名稱|名稱/.test(h));

    const sel = document.getElementById('colSel');
    sel.innerHTML = sheetData.headers.map((h, i) =>
      `<option value="${i}" ${i === nameIdx ? 'selected' : ''}>${h || '欄 ' + (i + 1)}</option>`
    ).join('');
    document.getElementById('colWrap').style.display = 'block';

    const readBtn = document.getElementById('readBtn');
    readBtn.textContent = '下一步 →';
    readBtn.removeEventListener('click', readSheet);
    readBtn.addEventListener('click', showNameList);
    if (nameIdx >= 0) showNameList();
  } catch (e) { errEl.textContent = '讀取失敗：' + e.message; errEl.style.display = 'block'; }
}

function showNameList() {
  const colIdx = parseInt(document.getElementById('colSel').value);
  const names = sheetData.data.map(r => r[colIdx] || '').filter(n => n.trim());

  document.getElementById('nameList').innerHTML = names.map((n, i) => `
    <div class="name-item">
      <input type="checkbox" id="n${i}" class="name-chk" value="${i}" checked>
      <label for="n${i}">${esc(n)}</label>
    </div>`).join('');
  document.getElementById('countText').textContent = `共 ${names.length} 筆，全部勾選`;
  goStep(2);
}

// ── Step 2: Start Job ─────────────────────────────────────────────────────────
function startJob() {
  const colIdx = parseInt(document.getElementById('colSel').value);
  const checked = [...document.querySelectorAll('.name-chk:checked')].map(c => parseInt(c.value));
  const names = sheetData.data.map(r => r[colIdx] || '').filter((_, i) => checked.includes(i)).filter(n => n.trim());
  if (!names.length) { alert('請至少勾選一筆'); return; }
  runJob(names);
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Event-based: wait for the tab to fire status=complete (register listener FIRST)
function waitTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error('頁面載入超時'));
    }, timeout);
    function fn(tid, info) {
      if (tid !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(fn);
      setTimeout(resolve, 300); // brief stabilisation
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// Navigate to URL and wait until fully loaded
async function navAndWait(tabId, url, timeout = 30000) {
  const p = waitTabComplete(tabId, timeout); // register BEFORE navigation starts
  await chrome.tabs.update(tabId, { url });
  await p;
}

async function exec(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results[0].result;
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 55);
}

// ── CAPTCHA UI ────────────────────────────────────────────────────────────────
function showCaptcha(name, dataUrl, attempt) {
  document.getElementById('capInsName').textContent = name;
  document.getElementById('capProgress').textContent = attempt > 1 ? `第 ${attempt} 次嘗試` : '請輸入驗證碼';
  document.getElementById('captchaImg').src = dataUrl || '';
  document.getElementById('captchaInput').value = '';
  document.getElementById('capErr').textContent = '';
  document.getElementById('captchaWrap').style.display = 'block';
  document.getElementById('capSubmitBtn').disabled = false;
  setTimeout(() => document.getElementById('captchaInput').focus(), 50);
}

function hideCaptcha() {
  document.getElementById('captchaWrap').style.display = 'none';
}

function submitCaptcha() {
  const val = document.getElementById('captchaInput').value.trim();
  if (!val) return;
  if (captchaResolve) {
    captchaResolve(val);
    captchaResolve = null;
    document.getElementById('capSubmitBtn').disabled = true;
  }
}

function skipCurrent() {
  if (captchaResolve) { captchaResolve(null); captchaResolve = null; }
  hideCaptcha();
}

// ── Process one insurance ─────────────────────────────────────────────────────
async function processOne(name, attempt = 1) {
  if (!jobTabId) throw new Error('查詢視窗已關閉');

  await navAndWait(jobTabId, 'https://insprod.tii.org.tw/Query.aspx');

  // Fill keyword
  await exec(jobTabId, (kw) => {
    const inputs = [...document.querySelectorAll('input[name="fQueryAll"]')];
    const vis = inputs.find(i => i.type !== 'hidden');
    if (vis) vis.value = kw;
  }, [name]);

  // Fetch CAPTCHA image (same session as the tab)
  const captchaDataUrl = await exec(jobTabId, async () => {
    try {
      const resp = await fetch('/bmp.ashx');
      const blob = await resp.blob();
      return await new Promise(res => { const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsDataURL(blob); });
    } catch { return null; }
  });

  // Show CAPTCHA in popup and wait for user
  showCaptcha(name, captchaDataUrl, attempt);
  const userInput = await new Promise(res => { captchaResolve = res; });

  if (userInput === null) return { name, status: 'skipped', files: [] };

  hideCaptcha();

  // Register navigation listener BEFORE form submit (no race condition)
  const afterSubmit = waitTabComplete(jobTabId, 30000);

  // Submit form with CAPTCHA (may throw as page navigates — that's OK)
  try {
    await exec(jobTabId, (val) => {
      document.querySelector('input[name="bmpC"]').value = val;
      document.form1.submit();
    }, [userInput]);
  } catch { /* navigation started */ }

  await afterSubmit;

  // Check for CAPTCHA error (URL still Query.aspx or Default.aspx)
  const tabAfterSubmit = await chrome.tabs.get(jobTabId).catch(() => { throw new Error('查詢視窗已關閉'); });
  const url = tabAfterSubmit.url || '';
  if (!url.includes('ResultQueryAll')) {
    if (attempt >= 4) return { name, status: 'error', message: '多次驗證碼錯誤', files: [] };
    addLog(`⚠ 驗證碼錯誤，重試第 ${attempt + 1} 次`, 'warn');
    return processOne(name, attempt + 1);
  }

  // Find the latest product link (last = most recent version)
  const productUrl = await exec(jobTabId, () => {
    const skip = ['回首頁','首頁','中心首頁','查詢','回上頁','資安及個資政策','隱私權聲明','違規記錄查詢','連結'];
    const links = [...document.querySelectorAll('a[href*="DetailList.aspx"]')]
      .filter(a => !skip.includes(a.textContent.trim()));
    return links.length ? links[links.length - 1].href : null;
  });

  if (!productUrl) return { name, status: 'not_found', message: '查無保單資料', files: [] };

  // Navigate to product detail
  await navAndWait(jobTabId, productUrl);

  // Extract section label → PDF URL mapping
  const pdfMap = await exec(jobTabId, () => {
    const result = {};
    let label = null;
    for (const row of document.querySelectorAll('tr')) {
      const cell = row.querySelector('td[bgcolor="#F9F0DF"]');
      if (cell) { label = cell.textContent.trim().replace(/\s+/g, ' '); continue; }
      if (label) {
        const links = [...row.querySelectorAll('a[href*="Open2.ashx"]')];
        if (links.length) { result[label] = result[label] || []; links.forEach(a => result[label].push(a.href)); }
      }
    }
    return result;
  });

  // Download 3 PDF types
  const SECTIONS = [
    { key: '保險商品內容說明', label: '商品內容說明' },
    { key: '保單條款',        label: '保單條款' },
    { key: '費率',            label: '費率' },
  ];

  const files = [];
  const safe = sanitize(name);

  for (const { key, label } of SECTIONS) {
    const sKey = Object.keys(pdfMap).find(k => k.includes(key));
    const urls = sKey ? pdfMap[sKey] : [];
    if (!urls.length) { files.push({ label, status: 'not_found' }); continue; }
    for (let i = 0; i < urls.length; i++) {
      const suffix = urls.length > 1 ? `_${i + 1}` : '';
      const filename = `保單PDF/${safe}/${safe}_${label}${suffix}.pdf`;
      await chrome.downloads.download({ url: urls[i], filename, conflictAction: 'overwrite' });
      files.push({ label, status: 'ok', filename: `${safe}_${label}${suffix}.pdf` });
    }
  }

  return { name, status: 'success', files };
}

// ── Run all ───────────────────────────────────────────────────────────────────
async function runJob(names) {
  goStep(3);
  totalNames = names.length;
  setProgress(0, names.length);

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  jobTabId = tab.id;

  // Handle tab closed by user
  const closeListener = (id) => {
    if (id === jobTabId) {
      jobTabId = null;
      if (captchaResolve) { captchaResolve(null); captchaResolve = null; }
    }
  };
  chrome.tabs.onRemoved.addListener(closeListener);

  const results = [];
  for (let i = 0; i < names.length; i++) {
    if (!jobTabId) { addLog('⚠ 查詢視窗被關閉，作業中止', 'warn'); break; }
    setProgress(i, names.length, `處理中：${names[i]}`);
    addLog(`→ ${names[i]}`, 'info');
    try {
      const result = await processOne(names[i]);
      results.push(result);
      if (result.status === 'success') {
        const ok = result.files.filter(f => f.status === 'ok').length;
        const miss = result.files.filter(f => f.status !== 'ok').length;
        addLog(`✓ ${result.name}（${ok} PDF${miss ? '，' + miss + ' 個未找到' : ''}）`, 'ok');
      } else if (result.status === 'not_found') {
        addLog(`✗ ${result.name}：查無資料`, 'err');
      } else if (result.status === 'skipped') {
        addLog(`→ ${result.name}：跳過`, 'info');
      } else {
        addLog(`✗ ${result.name}：${result.message}`, 'err');
      }
    } catch (e) {
      results.push({ name: names[i], status: 'error', message: e.message, files: [] });
      addLog(`✗ ${names[i]}：${e.message}`, 'err');
    }
    setProgress(i + 1, names.length);
  }

  chrome.tabs.onRemoved.removeListener(closeListener);
  if (jobTabId) { chrome.tabs.remove(jobTabId); jobTabId = null; }
  showResults(results);
}

// ── Progress & Log ────────────────────────────────────────────────────────────
function setProgress(done, total, label) {
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById('progBar').style.width = pct + '%';
  document.getElementById('progText').textContent = label || `進度：${done} / ${total}（${pct}%）`;
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

  document.getElementById('resultList').innerHTML = (results || []).map(r => {
    let badge = '';
    let files = '';
    if (r.status === 'success') {
      badge = '<span class="badge badge-ok">成功</span>';
      files = '<div class="result-files">' + (r.files || []).map(f =>
        `<span style="color:var(--${f.status === 'ok' ? 'success' : 'error'})">` +
        `${f.status === 'ok' ? '✓' : '✗'} ${f.label}</span> `
      ).join('') + '</div>';
    } else if (r.status === 'not_found') {
      badge = '<span class="badge badge-warn">查無</span>';
    } else if (r.status === 'skipped') {
      badge = '<span class="badge badge-skip">跳過</span>';
    } else {
      badge = '<span class="badge badge-err">錯誤</span>';
    }
    return `<div class="result-item">${badge} <span class="result-name">${esc(r.name)}</span>${files}</div>`;
  }).join('');
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (inQ && text[i+1] === '"') { field += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { row.push(field.trim()); field = ''; }
    else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && text[i+1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(f => f)) rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(f => f)) rows.push(row); }
  return rows;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
