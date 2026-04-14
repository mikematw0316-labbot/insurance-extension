// ── Keep service worker alive via open ports ──────────────────────────────────
const ports = new Set();
let pendingCaptcha = null; // re-send to popup if it re-opens mid-job

chrome.runtime.onConnect.addListener(port => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(msg => handlePortMessage(msg));
  // Re-send pending captcha request if popup reconnects mid-job
  if (pendingCaptcha) {
    try { port.postMessage(pendingCaptcha); } catch {}
  }
});

function broadcast(msg) {
  if (msg.type === 'captcha_request') pendingCaptcha = msg;
  if (msg.type === 'item_done' || msg.type === 'job_done') pendingCaptcha = null;
  for (const p of ports) { try { p.postMessage(msg); } catch {} }
}

// ── State ─────────────────────────────────────────────────────────────────────
let jobTabId = null;
let captchaResolve = null; // called when user submits/skips captcha

// ── Helpers ───────────────────────────────────────────────────────────────────
function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error('Tab load timeout'));
    }, timeout);

    const fn = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timer);
        setTimeout(resolve, 400); // Let page scripts settle
      }
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function exec(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return results[0].result;
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 55);
}

// ── Main automation per insurance name ───────────────────────────────────────
async function processOne(name, attempt = 1) {
  if (!jobTabId) throw new Error('Tab closed');

  // Navigate to Query.aspx
  await chrome.tabs.update(jobTabId, { url: 'https://insprod.tii.org.tw/Query.aspx' });
  await waitForTabLoad(jobTabId);

  // Fill search keyword (find the visible text input, skip hidden)
  await exec(jobTabId, (kw) => {
    const inputs = [...document.querySelectorAll('input[name="fQueryAll"]')];
    const vis = inputs.find(i => i.type !== 'hidden');
    if (vis) vis.value = kw;
  }, [name]);

  // Fetch CAPTCHA image as data URL (same session as page)
  const captchaDataUrl = await exec(jobTabId, async () => {
    try {
      const resp = await fetch('/bmp.ashx');
      const blob = await resp.blob();
      return await new Promise(res => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  });

  // Ask popup for CAPTCHA
  broadcast({ type: 'captcha_request', name, captcha: captchaDataUrl, attempt });

  // Wait for user response
  const userInput = await new Promise(res => { captchaResolve = res; });

  if (userInput === null) {
    // User skipped
    return { name, status: 'skipped', files: [] };
  }

  // Fill CAPTCHA and submit
  await exec(jobTabId, (val) => {
    document.querySelector('input[name="bmpC"]').value = val;
    document.form1.submit();
  }, [userInput]);

  await waitForTabLoad(jobTabId);

  // Check if we're still on Query.aspx (= captcha error)
  const url = await exec(jobTabId, () => location.href);
  if (url.includes('Query.aspx') || !url.includes('ResultQueryAll')) {
    if (attempt >= 4) return { name, status: 'error', message: '多次驗證碼錯誤', files: [] };
    broadcast({ type: 'captcha_error', name, attempt });
    return processOne(name, attempt + 1); // Retry with new captcha
  }

  // ── Results page: find latest product link ────────────────────────────────
  const productUrl = await exec(jobTabId, () => {
    const skip = ['回首頁','首頁','中心首頁','查詢','回上頁','資安及個資政策','隱私權聲明','違規記錄查詢','連結'];
    const links = [...document.querySelectorAll('a[href*="DetailList.aspx"]')]
      .filter(a => !skip.includes(a.textContent.trim()));
    if (!links.length) return null;
    return links[links.length - 1].href; // Latest version = last
  });

  if (!productUrl) {
    return { name, status: 'not_found', message: '查無保單資料', files: [] };
  }

  // ── Navigate to product detail page ──────────────────────────────────────
  await chrome.tabs.update(jobTabId, { url: productUrl });
  await waitForTabLoad(jobTabId);

  // ── Extract PDF map: section label → [pdf urls] ───────────────────────────
  const pdfMap = await exec(jobTabId, () => {
    const result = {};
    let label = null;
    for (const row of document.querySelectorAll('tr')) {
      const labelCell = row.querySelector('td[bgcolor="#F9F0DF"]');
      if (labelCell) {
        label = labelCell.textContent.trim().replace(/\s+/g, ' ');
        continue;
      }
      if (label) {
        const pdfLinks = [...row.querySelectorAll('a[href*="Open2.ashx"]')];
        if (pdfLinks.length) {
          result[label] = result[label] || [];
          pdfLinks.forEach(a => result[label].push(a.href));
        }
      }
    }
    return result;
  });

  // ── Download 3 PDF types ──────────────────────────────────────────────────
  const SECTIONS = [
    { key: '保險商品內容說明', label: '商品內容說明' },
    { key: '保單條款',        label: '保單條款' },
    { key: '費率',            label: '費率' },
  ];

  const files = [];
  const safe = sanitize(name);

  for (const { key, label } of SECTIONS) {
    const sectionKey = Object.keys(pdfMap).find(k => k.includes(key));
    const urls = sectionKey ? pdfMap[sectionKey] : [];

    if (!urls.length) {
      files.push({ label, status: 'not_found' });
      continue;
    }

    for (let i = 0; i < urls.length; i++) {
      const suffix = urls.length > 1 ? `_${i + 1}` : '';
      const filename = `保單PDF/${safe}/${safe}_${label}${suffix}.pdf`;
      await chrome.downloads.download({ url: urls[i], filename, conflictAction: 'overwrite' });
      files.push({ label, status: 'ok', filename: `${safe}_${label}${suffix}.pdf` });
    }
  }

  return { name, status: 'success', files };
}

// ── Handle messages from popup port ──────────────────────────────────────────
function handlePortMessage(msg) {
  if (msg.type === 'captcha_submit' || msg.type === 'captcha_skip') {
    if (captchaResolve) {
      captchaResolve(msg.type === 'captcha_skip' ? null : msg.value);
      captchaResolve = null;
    }
    return;
  }

  if (msg.type === 'start_job') {
    runJob(msg.names);
  }
}

async function runJob(names) {
  chrome.storage.local.set({ jobActive: true });
  broadcast({ type: 'job_started', total: names.length });

  // Open tab in background — don't steal focus from popup
  const tab = await chrome.tabs.create({ url: 'https://insprod.tii.org.tw/Query.aspx', active: false });
  jobTabId = tab.id;
  await waitForTabLoad(jobTabId);

  // Listen for tab closed by user
  const closeListener = (id) => {
    if (id === jobTabId) {
      jobTabId = null;
      if (captchaResolve) { captchaResolve(null); captchaResolve = null; }
    }
  };
  chrome.tabs.onRemoved.addListener(closeListener);

  const results = [];
  for (let i = 0; i < names.length; i++) {
    if (!jobTabId) {
      broadcast({ type: 'job_aborted', message: '視窗已關閉' });
      break;
    }
    broadcast({ type: 'item_start', name: names[i], index: i, total: names.length });
    try {
      const result = await processOne(names[i]);
      results.push(result);
      broadcast({ type: 'item_done', result, index: i + 1, total: names.length });
    } catch (e) {
      results.push({ name: names[i], status: 'error', message: e.message, files: [] });
      broadcast({ type: 'item_done', result: results[results.length - 1], index: i + 1, total: names.length });
    }
  }

  chrome.tabs.onRemoved.removeListener(closeListener);
  if (jobTabId) { chrome.tabs.remove(jobTabId); jobTabId = null; }
  chrome.storage.local.set({ jobActive: false });
  broadcast({ type: 'job_done', results });
}
