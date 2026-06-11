'use strict';

const SUPABASE_URL = 'https://snjexfohyklviarxprvm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuamV4Zm9oeWtsdmlhcnhwcnZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDgwODgsImV4cCI6MjA5MzI4NDA4OH0.jxiiBLM4hyGwoJ7U4RC_M1Laqm0z8T0jHpmU3LlVW3k';

// ── 상태 ──────────────────────────────────────────────────────────────────────
let isCapturing = false;
const tabCaptures = new Map(); // tabId → { windowId, url, title, captures[], scanning }
let prevTabId = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.storage.local.get('isCapturing').then(({ isCapturing: v }) => {
  isCapturing = !!v;
});

// ── 메시지 핸들러 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  if (msg.type === 'SCROLL_CHANGED' && tabId) {
    chrome.storage.local.get('isCapturing').then(({ isCapturing: v }) => {
      if (v) handleScrollCapture(tabId, windowId, msg);
    });
    return;
  }
  if (msg.type === 'GET_STATUS') { sendResponse({ isCapturing }); return true; }
  if (msg.type === 'SET_CAPTURING') {
    setCapturing(msg.value).then(() => sendResponse({ ok: true })); return true;
  }
  if (msg.type === 'GET_HISTORY') {
    chrome.storage.local.get('history').then(({ history = [] }) => sendResponse(history)); return true;
  }
  if (msg.type === 'CLEAR_HISTORY') {
    chrome.storage.local.set({ history: [] }).then(() => sendResponse({ ok: true })); return true;
  }
});

// ── 캡처 시작/종료 ────────────────────────────────────────────────────────────
async function setCapturing(value) {
  isCapturing = value;
  await chrome.storage.local.set({ isCapturing: value });
  if (value) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['checker.js', 'content.js'] }).catch(() => {});
    }
  } else {
    await finalizeAll();
  }
}

// ── 수동 스크롤 캡처 ──────────────────────────────────────────────────────────
async function handleScrollCapture(tabId, windowId, msg) {
  if (!tabCaptures.has(tabId)) tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });
  const state = tabCaptures.get(tabId);
  if (state.scanning) return;
  const { scrollY, scrollHeight, viewportH, viewportW, dpr } = msg;
  await doCapture(tabId, windowId || state.windowId, scrollY, scrollHeight, viewportH, viewportW, dpr);
}

// ── 페이지 전체 스캔 ──────────────────────────────────────────────────────────
// captureVisibleTab 은 초당 호출 횟수 제한이 있어 충분한 간격을 둔다.
const CAPTURE_INTERVAL = 550;

async function fullPageScan(tabId, windowId) {
  if (!tabCaptures.has(tabId)) tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });
  const state = tabCaptures.get(tabId);
  state.scanning = true;
  try {
    // 새로 열린 탭/프레임에도 점검 스크립트가 있도록 보장
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, files: ['checker.js', 'content.js'],
    }).catch(() => {});
    const frameId = await windowScan(tabId, windowId);
    await innerScan(tabId, windowId, frameId);
    await scrollFrameTo(tabId, frameId, 0);
    state.issues = await getIssues(tabId, frameId);
  } finally {
    state.scanning = false;
  }
}

async function windowScan(tabId, windowId) {
  const frames = await frameInfoAll(tabId);
  if (!frames.length) return 0;
  const top = frames.find(f => f.frameId === 0) || frames[0];
  // 실제 본문 스크롤이 일어나는 프레임 선택
  // (네이버 블로그처럼 본문이 iframe 안에 있는 페이지 대응)
  let fr = top;
  for (const f of frames) {
    if ((f.scrollHeight - f.viewportH) > (fr.scrollHeight - fr.viewportH)) fr = f;
  }
  const stepH = fr.viewportH;
  const positions = [];
  for (let y = 0; y + stepH <= fr.scrollHeight; y += stepH) positions.push(y);
  const bottom = Math.max(0, fr.scrollHeight - stepH);
  if (!positions.length || positions[positions.length - 1] < bottom) positions.push(bottom);
  // 고정 헤더가 본문을 덮어 이어붙인 이미지가 중간중간 가려지는 문제 방지:
  // 첫 조각은 그대로 찍고, 두 번째 조각부터 fixed/sticky 요소를 잠시 숨긴다.
  let hidFixed = false;
  try {
    for (let i = 0; i < positions.length; i++) {
      await scrollFrameTo(tabId, fr.frameId, positions[i]);
      if (i === 1) { await setFixedHidden(tabId, fr.frameId, true); hidFixed = true; }
      await sleep(CAPTURE_INTERVAL);
      const cur = await frameInfo(tabId, fr.frameId);
      await doCapture(tabId, windowId, cur.scrollY, fr.scrollHeight, stepH, top.viewportW, top.dpr);
    }
  } finally {
    if (hidFixed) await setFixedHidden(tabId, fr.frameId, false);
  }
  return fr.frameId;
}

function setFixedHidden(tabId, frameId, hide) {
  return chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (h) => {
      if (h) {
        document.querySelectorAll('body *').forEach(el => {
          const p = getComputedStyle(el).position;
          if ((p === 'fixed' || p === 'sticky') && !el.hasAttribute('data-qa-fixed-hidden')) {
            el.setAttribute('data-qa-fixed-hidden', '1');
            el.style.visibility = 'hidden';
          }
        });
      } else {
        document.querySelectorAll('[data-qa-fixed-hidden]').forEach(el => {
          el.style.visibility = '';
          el.removeAttribute('data-qa-fixed-hidden');
        });
      }
    },
    args: [hide],
  }).catch(() => {});
}

async function innerScan(tabId, windowId, frameId) {
  let elements = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        let i = 0; const list = [];
        for (const el of document.querySelectorAll('*')) {
          if (el === document.body || el === document.documentElement) continue;
          const s = getComputedStyle(el);
          const canScroll = (s.overflowY === 'scroll' || s.overflowY === 'auto')
            && el.scrollHeight > el.clientHeight + 5 && el.clientHeight > 50;
          if (canScroll) { el.setAttribute('data-qa-scan', i); list.push({ idx: i++, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }); }
        }
        return list;
      },
    });
    elements = res?.result ?? [];
  } catch (_) { return; }
  if (!elements.length) return;

  const fi = await frameInfo(tabId, frameId);
  const top = frameId === 0 ? fi : await frameInfo(tabId, 0);
  for (const { idx, scrollHeight, clientHeight } of elements) {
    const positions = [];
    for (let y = 0; y + clientHeight <= scrollHeight; y += clientHeight) positions.push(y);
    const bottom = Math.max(0, scrollHeight - clientHeight);
    if (!positions.length || positions[positions.length - 1] < bottom) positions.push(bottom);
    for (const y of positions) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: (i, top) => { const el = document.querySelector(`[data-qa-scan="${i}"]`); if (el) el.scrollTop = top; }, args: [idx, y] }).catch(() => {});
      await sleep(CAPTURE_INTERVAL);
      const actual = await frameInfo(tabId, frameId);
      await doCapture(tabId, windowId, actual.scrollY, fi.scrollHeight, fi.viewportH, top.viewportW, top.dpr);
    }
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: (i) => { const el = document.querySelector(`[data-qa-scan="${i}"]`); if (el) el.scrollTop = 0; }, args: [idx] }).catch(() => {});
  }
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => document.querySelectorAll('[data-qa-scan]').forEach(el => el.removeAttribute('data-qa-scan')) }).catch(() => {});
}

// ── 스크린샷 촬영 ─────────────────────────────────────────────────────────────
async function doCapture(tabId, windowId, scrollY, scrollHeight, viewportH, viewportW, dpr) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!activeTab || activeTab.id !== tabId) return;

    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (e) {
      // 초당 캡처 횟수 제한에 걸린 경우 잠시 후 1회 재시도 (조각 누락 방지)
      await sleep(800);
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }
    if (!tabCaptures.has(tabId)) tabCaptures.set(tabId, { windowId: tab.windowId, url: tab.url, title: tab.title, captures: [] });
    const state = tabCaptures.get(tabId);
    const last = state.captures[state.captures.length - 1];
    // 화면이 직전 조각과 완전히 같으면 중복 추가하지 않는다
    if (last && last.dataUrl === dataUrl) return;
    const stitchY = (last && scrollY === last.scrollY) ? last.stitchY + last.viewportH : scrollY;

    state.url = tab.url;
    state.title = tab.title;
    state.windowId = tab.windowId;
    state.captures.push({ scrollY, stitchY, scrollHeight, viewportH, viewportW, dpr, dataUrl });
  } catch (e) {
    console.warn('[QA] captureVisibleTab error:', e.message);
  }
}

// ── 탭 완료 처리 ──────────────────────────────────────────────────────────────
async function finalizeTab(tabId) {
  const state = tabCaptures.get(tabId);
  tabCaptures.delete(tabId);
  if (!state || !state.captures.length) return;

  const stitchedDataUrl = await stitchCaptures(state.captures);
  if (!stitchedDataUrl) return;

  // 내부 스크롤 조각이 추가되면 이미지가 문서보다 길어지므로
  // % 좌표(문서 기준)를 이미지 기준으로 보정한다
  let issues = state.issues || [];
  const docH = state.captures[0]?.scrollHeight;
  const totalH = state.captures.reduce((m, c) => Math.max(m, c.stitchY + c.viewportH), 0);
  if (docH && totalH && Math.abs(totalH - docH) > 2) {
    const f = docH / totalH;
    issues = issues.map(i => i.rectPct ? {
      ...i,
      rectPct: { ...i.rectPct, y: +(i.rectPct.y * f).toFixed(2), h: +(i.rectPct.h * f).toFixed(2) },
    } : i);
  }

  const record = {
    id: Date.now(),
    url: state.url,
    title: state.title || extractHostname(state.url),
    dataUrl: stitchedDataUrl,
    captureCount: state.captures.length,
    issues,
    timestamp: new Date().toLocaleString('ko-KR'),
    uploaded: false, uploading: false, uploadFailed: false,
  };

  const { history = [] } = await chrome.storage.local.get('history');
  const existingIdx = history.findIndex(h => h.url === record.url);
  if (existingIdx !== -1) history.splice(existingIdx, 1);
  history.unshift(record);
  if (history.length > 30) history.splice(30);
  await chrome.storage.local.set({ history });

  uploadToRoom(record).catch(e => console.warn('[QA] upload error:', e.message));
}

async function finalizeAll() {
  for (const tabId of [...tabCaptures.keys()]) await finalizeTab(tabId);
}

// ── 방에 업로드 (같은 URL 중복 시 기존 항목 교체) ────────────────────────────
async function uploadToRoom(record) {
  const { roomSession } = await chrome.storage.local.get('roomSession');
  if (!roomSession?.room_id) return;

  const { room_id, uploader_name } = roomSession;
  await updateHistoryRecord(record.id, { uploading: true, uploaded: false, uploadFailed: false });

  try {
    const blob = await fetch(record.dataUrl).then(r => r.blob());
    const path = `rooms/${room_id}/${record.id}.png`;

    // 같은 방 + 같은 URL 기존 캡처 조회
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/captures?room_id=eq.${room_id}&url=eq.${encodeURIComponent(record.url)}&select=id,image_path`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const existing = await checkRes.json().catch(() => []);

    // 기존 항목 삭제 (Storage + DB)
    for (const old of (Array.isArray(existing) ? existing : [])) {
      if (old.image_path) {
        await fetch(`${SUPABASE_URL}/storage/v1/object/qa-captures/${old.image_path}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
        }).catch(() => {});
      }
      await fetch(`${SUPABASE_URL}/rest/v1/captures?id=eq.${old.id}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      }).catch(() => {});
    }

    // 새 이미지 Storage 업로드
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/qa-captures/${path}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'image/png',
        'x-upsert': 'true',
      },
      body: blob,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.message || `Storage upload failed: ${uploadRes.status}`);
    }

    // DB 신규 삽입
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/captures`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        room_id,
        uploader_name,
        url: record.url,
        title: record.title,
        capture_count: record.captureCount,
        image_path: path,
        issues: record.issues || [],
      }),
    });
    if (!insertRes.ok) {
      const err = await insertRes.json().catch(() => ({}));
      throw new Error(err.message || `DB insert failed: ${insertRes.status}`);
    }

    await updateHistoryRecord(record.id, { uploading: false, uploaded: true, uploadFailed: false });
    console.log(`[QA] uploaded "${record.title}" → room ${room_id} (중복 ${existing.length}건 교체)`);
  } catch (e) {
    await updateHistoryRecord(record.id, { uploading: false, uploaded: false, uploadFailed: true });
    console.warn('[QA] upload failed:', e.message);
  }
}

async function updateHistoryRecord(id, fields) {
  const { history = [] } = await chrome.storage.local.get('history');
  const idx = history.findIndex(r => r.id === id);
  if (idx !== -1) { Object.assign(history[idx], fields); await chrome.storage.local.set({ history }); }
}

// ── 이미지 이어붙이기 ─────────────────────────────────────────────────────────
async function stitchCaptures(captures) {
  if (!captures.length) return null;
  if (captures.length === 1) return captures[0].dataUrl;

  const { viewportW, dpr } = captures[0];
  const totalCssH = captures.reduce((m, c) => Math.max(m, c.stitchY + c.viewportH), 0);
  const scale = Math.min(dpr || 1, 32000 / totalCssH);
  const canvasW = Math.round(viewportW * scale);
  const canvasH = Math.round(totalCssH * scale);

  const offscreen = new OffscreenCanvas(canvasW, canvasH);
  const ctx = offscreen.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);
  const sorted = [...captures].sort((a, b) => a.stitchY - b.stitchY);
  for (const cap of sorted) {
    const resp = await fetch(cap.dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    // 비트맵은 기기 픽셀 크기이므로 캔버스 배율에 맞춰 명시적으로 축소해서 그린다
    const capDpr = cap.dpr || 1;
    const destW = Math.round((bitmap.width / capDpr) * scale) || canvasW;
    const destH = Math.round((bitmap.height / capDpr) * scale) || Math.round(cap.viewportH * scale);
    ctx.drawImage(bitmap, 0, Math.round(cap.stitchY * scale), destW, destH);
    bitmap.close();
  }
  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return 'data:image/png;base64,' + btoa(binary);
}

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// ── DOM 자동 점검 (라이브 페이지에서 실행, 좌표는 %로 정규화) ──
async function getIssues(tabId, frameId = 0) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        if (!window.QassCheck) return [];
        const issues = window.QassCheck.run(document.body);
        const W = Math.max(document.documentElement.scrollWidth, innerWidth);
        const H = Math.max(document.documentElement.scrollHeight, innerHeight);
        return issues.map(i => ({
          type: i.type, severity: i.severity, message: i.message,
          wrong: i.wrong, right: i.right, text: i.text, selector: i.selector,
          rectPct: i.rect ? {
            x: +(i.rect.x / W * 100).toFixed(2), y: +(i.rect.y / H * 100).toFixed(2),
            w: +(i.rect.w / W * 100).toFixed(2), h: +(i.rect.h / H * 100).toFixed(2),
          } : null,
        }));
      },
    });
    return res?.result ?? [];
  } catch (_) { return []; }
}

// ── 프레임별 스크롤 정보 ─────────────────────────────────────────────────────
const FRAME_FALLBACK = { scrollY: 0, scrollHeight: 0, viewportH: 900, viewportW: 1440, dpr: 1 };

function frameInfoFunc() {
  return {
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ),
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  };
}

async function frameInfoAll(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: frameInfoFunc,
    });
    return (results || [])
      .filter(r => r && r.result && r.result.viewportH > 0)
      .map(r => ({ frameId: r.frameId, ...r.result }));
  } catch (_) { return []; }
}

async function frameInfo(tabId, frameId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: frameInfoFunc,
    });
    return res?.result || FRAME_FALLBACK;
  } catch (_) { return FRAME_FALLBACK; }
}

function scrollFrameTo(tabId, frameId, y) {
  return chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    // smooth 스크롤 페이지에서 이동 중 캡처되지 않도록 즉시 이동
    func: (sy) => window.scrollTo({ top: sy, left: 0, behavior: 'instant' }),
    args: [y],
  }).catch(() => {});
}

// ── 탭 이벤트 ─────────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (prevTabId && prevTabId !== tabId && tabCaptures.has(prevTabId)) await finalizeTab(prevTabId);
  prevTabId = tabId;
  if (!isCapturing) return;
  tabCaptures.set(tabId, { windowId, url: '', title: '', captures: [] });
  await sleep(400);
  await fullPageScan(tabId, windowId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (tabCaptures.has(tabId)) await finalizeTab(tabId);
  if (!isCapturing) return;
  tabCaptures.set(tabId, { windowId: tab.windowId, url: tab.url, title: tab.title, captures: [] });
  await sleep(600);
  await fullPageScan(tabId, tab.windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabCaptures.has(tabId)) await finalizeTab(tabId);
});
