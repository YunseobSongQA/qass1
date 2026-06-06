'use strict';

const SUPABASE_URL = 'https://snjexfohyklviarxprvm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuamV4Zm9oeWtsdmlhcnhwcnZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDgwODgsImV4cCI6MjA5MzI4NDA4OH0.jxiiBLM4hyGwoJ7U4RC_M1Laqm0z8T0jHpmU3LlVW3k';

const TEST_ROOM_NAME = 'QASS 테스트 방';
const TEST_ROOM_PASSWORD = 'qass1234';

let isCapturing = false;
let cachedHistory = [];

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-toggle').addEventListener('click', onToggle);
  document.getElementById('btn-clear').addEventListener('click', onClear);
  document.getElementById('btn-dl-all').addEventListener('click', onDownloadAll);
  document.getElementById('btn-room-connect').addEventListener('click', onRoomConnect);
  document.getElementById('btn-room-disconnect').addEventListener('click', onRoomDisconnect);
  document.getElementById('btn-ext-test-hint').addEventListener('click', () => {
    document.getElementById('ext-room-name').value = TEST_ROOM_NAME;
    document.getElementById('ext-room-password').value = TEST_ROOM_PASSWORD;
    if (!document.getElementById('ext-uploader-name').value) {
      document.getElementById('ext-uploader-name').value = '테스트 사용자';
    }
    document.getElementById('ext-uploader-name').focus();
  });

  document.getElementById('ext-room-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('ext-uploader-name').focus();
  });
  document.getElementById('ext-uploader-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') onRoomConnect();
  });

  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  isCapturing = resp.isCapturing;
  updateUI();
  await loadHistory();
  await updateRoomUI();
});

// ── 방 연결 UI ────────────────────────────────────────────────────────────────
async function updateRoomUI() {
  const { roomSession } = await chrome.storage.local.get('roomSession');
  const connected = !!(roomSession?.room_id);
  document.getElementById('room-connected').classList.toggle('hidden', !connected);
  document.getElementById('room-connect-form').classList.toggle('hidden', connected);
  if (connected) {
    document.getElementById('connected-room-name').textContent = roomSession.room_name;
    document.getElementById('connected-uploader').textContent = `👤 ${roomSession.uploader_name}`;
  }
}

async function onRoomConnect() {
  const roomName = document.getElementById('ext-room-name').value.trim();
  const password = document.getElementById('ext-room-password').value.trim();
  const uploaderName = document.getElementById('ext-uploader-name').value.trim() || '익명';
  const errEl = document.getElementById('ext-connect-error');
  const btn = document.getElementById('btn-room-connect');
  errEl.classList.add('hidden');

  if (!roomName) { showExtErr(errEl, '방 이름을 입력하세요.'); return; }
  if (!password) { showExtErr(errEl, '비밀번호를 입력하세요.'); return; }

  btn.textContent = '확인 중…';
  btn.disabled = true;

  try {
    // Supabase REST로 방 조회
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rooms?room_name=eq.${encodeURIComponent(roomName)}&select=id,room_name,room_password`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const rooms = await res.json();
    if (!res.ok) throw new Error(rooms.message || '방 조회 실패');
    if (!rooms || rooms.length === 0) throw new Error(`"${roomName}" 방을 찾을 수 없습니다.`);

    const room = rooms[0];
    if (password !== room.room_password) throw new Error('비밀번호가 올바르지 않습니다.');

    await chrome.storage.local.set({
      roomSession: {
        room_id: room.id,
        room_name: room.room_name,
        uploader_name: uploaderName,
      },
    });
    document.getElementById('ext-room-name').value = '';
    document.getElementById('ext-room-password').value = '';
    document.getElementById('ext-uploader-name').value = '';
    await updateRoomUI();
  } catch (e) {
    showExtErr(errEl, e.message);
  } finally {
    btn.textContent = '연결';
    btn.disabled = false;
  }
}

async function onRoomDisconnect() {
  await chrome.storage.local.remove('roomSession');
  await updateRoomUI();
}

// ── 캡처 토글 ─────────────────────────────────────────────────────────────────
async function onToggle() {
  isCapturing = !isCapturing;
  await chrome.runtime.sendMessage({ type: 'SET_CAPTURING', value: isCapturing });
  updateUI();
  if (!isCapturing) setTimeout(loadHistory, 1200);
}

async function onClear() {
  if (!confirm('캡처 기록을 모두 삭제할까요?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  cachedHistory = [];
  renderList([]);
}

async function onDownloadAll() {
  if (!cachedHistory.length) return;
  cachedHistory.forEach((rec, i) => {
    setTimeout(() => triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp)), i * 400);
  });
}

// ── UI 갱신 ───────────────────────────────────────────────────────────────────
function updateUI() {
  const btn = document.getElementById('btn-toggle');
  const bar = document.getElementById('status-bar');
  const txt = document.getElementById('status-text');
  if (isCapturing) {
    btn.textContent = '■ 종료'; btn.className = 'btn-stop';
    bar.className = 'status-bar running';
    txt.textContent = '캡처 중 — 탭 이동 및 스크롤 시 자동 캡처됩니다';
  } else {
    btn.textContent = '▶ 시작'; btn.className = 'btn-start';
    bar.className = 'status-bar stopped';
    txt.textContent = '대기 중 — 시작 버튼을 누르면 탭 이동 시 자동 캡처됩니다';
  }
}

// ── 히스토리 로드 & 렌더링 ────────────────────────────────────────────────────
async function loadHistory() {
  cachedHistory = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  renderList(cachedHistory);
}

function renderList(history) {
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!history || !history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = '캡처된 페이지가 없습니다.';
    list.appendChild(empty);
    return;
  }
  history.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'capture-item';

    const header = document.createElement('div');
    header.className = 'item-header';

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    const titleEl = document.createElement('div');
    titleEl.className = 'item-title';
    titleEl.textContent = rec.title;
    titleEl.title = rec.title;

    const urlEl = document.createElement('div');
    urlEl.className = 'item-url';
    urlEl.textContent = rec.url;
    urlEl.title = rec.url;

    const infoEl = document.createElement('div');
    infoEl.className = 'item-info';
    infoEl.textContent = rec.timestamp + ' · ' + rec.captureCount + '개 조각';

    const badge = document.createElement('span');
    badge.className = 'cloud-badge';
    if (rec.uploaded) {
      badge.className += ' uploaded'; badge.textContent = '☁ 업로드됨';
    } else if (rec.uploading) {
      badge.className += ' uploading'; badge.textContent = '↑ 업로드 중';
    } else if (rec.uploadFailed) {
      badge.className += ' failed'; badge.textContent = '✕ 업로드 실패';
    }
    if (rec.uploaded || rec.uploading || rec.uploadFailed) infoEl.appendChild(badge);

    meta.appendChild(titleEl);
    meta.appendChild(urlEl);
    meta.appendChild(infoEl);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnView = document.createElement('button');
    btnView.textContent = '전체 보기';
    btnView.addEventListener('click', () => openFullView(rec.id));

    const btnDl = document.createElement('button');
    btnDl.textContent = '저장';
    btnDl.addEventListener('click', () => onDownloadOne(rec.id));

    actions.appendChild(btnView);
    actions.appendChild(btnDl);

    header.appendChild(meta);
    header.appendChild(actions);

    const img = document.createElement('img');
    img.src = rec.dataUrl;
    img.className = 'item-thumb';
    img.alt = rec.title;
    img.title = '클릭하면 전체 이미지를 새 탭에서 봅니다';
    img.addEventListener('click', () => openFullView(rec.id));

    item.appendChild(header);
    item.appendChild(img);
    list.appendChild(item);
  });
}

function openFullView(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  fetch(rec.dataUrl).then(r => r.blob()).then(blob => {
    chrome.tabs.create({ url: URL.createObjectURL(blob) });
  });
}

function onDownloadOne(id) {
  const rec = cachedHistory.find(r => String(r.id) === String(id));
  if (!rec) return;
  triggerDownload(rec.dataUrl, makeFileName(rec.title, rec.timestamp));
}

function triggerDownload(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = (timestamp || '').replace(/[^0-9]/g, '').slice(0, 14);
  return 'QA_' + safe + '_' + ts + '.png';
}

function showExtErr(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}
