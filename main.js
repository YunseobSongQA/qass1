'use strict';

const SUPABASE_URL = 'https://snjexfohyklviarxprvm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuamV4Zm9oeWtsdmlhcnhwcnZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDgwODgsImV4cCI6MjA5MzI4NDA4OH0.jxiiBLM4hyGwoJ7U4RC_M1Laqm0z8T0jHpmU3LlVW3k';

const TEST_ROOM_NAME = 'QASS 테스트 방';
const TEST_ROOM_PASSWORD = 'qass1234';

const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = '';       // 로그인 시 입력한 이름
let currentRoom = null;
let currentUploaderName = '익명';
let allCaptures = [];
let realtimeChannel = null;
let pendingRoom = null;

// ── 초기화 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  bindLoginEvents();
  bindRoomsScreenEvents();
  bindRoomScreenEvents();
  bindModalEvents();
  showScreen('login');
});

// ── 로그인 ────────────────────────────────────────────────────────────────────
function bindLoginEvents() {
  const btn = document.getElementById('btn-login');
  const input = document.getElementById('login-name');
  btn.addEventListener('click', onLogin);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') onLogin(); });
}

async function onLogin() {
  const name = document.getElementById('login-name').value.trim() || '익명';
  currentUser = name;
  currentUploaderName = name;
  document.getElementById('rooms-user-badge').textContent = `👤 ${name}`;
  showScreen('rooms');
  await ensureTestRoom();
  await loadRooms();
}

// ── 화면 전환 ─────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.getElementById('login-screen').classList.toggle('hidden', name !== 'login');
  document.getElementById('rooms-screen').classList.toggle('hidden', name !== 'rooms');
  document.getElementById('room-screen').classList.toggle('hidden', name !== 'room');
}

// ── 테스트 방 자동 생성 ──────────────────────────────────────────────────────
async function ensureTestRoom() {
  try {
    const { data } = await db.from('rooms').select('id').eq('room_name', TEST_ROOM_NAME);
    if (!data || data.length === 0) {
      await db.from('rooms').insert({
        room_name: TEST_ROOM_NAME,
        room_password: TEST_ROOM_PASSWORD,
        created_by: 'QASS 시스템',
      });
    }
  } catch (_) {}
}

// ── 방 목록 ──────────────────────────────────────────────────────────────────
async function loadRooms() {
  const grid = document.getElementById('rooms-grid');
  grid.innerHTML = '<div class="empty-state">불러오는 중…</div>';
  try {
    const { data, error } = await db
      .from('rooms')
      .select('id, room_name, created_by, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    renderRooms(data || []);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">오류: ${esc(err.message)}</div>`;
  }
}

function renderRooms(rooms) {
  const grid = document.getElementById('rooms-grid');
  grid.innerHTML = '';
  if (!rooms.length) {
    grid.innerHTML = '<div class="empty-state">아직 방이 없습니다.<br>첫 번째 방을 만들어보세요!</div>';
    return;
  }
  rooms.forEach(room => {
    const card = document.createElement('div');
    card.className = 'room-card';
    const isTest = room.room_name === TEST_ROOM_NAME;
    const date = room.created_at ? new Date(room.created_at).toLocaleDateString('ko-KR') : '';
    card.innerHTML = `
      <div class="room-card-icon">${isTest ? '🧪' : '📁'}</div>
      <div class="room-card-info">
        <div class="room-card-name">${esc(room.room_name)}${isTest ? ' <span class="test-badge">테스트</span>' : ''}</div>
        <div class="room-card-meta">만든이: ${esc(room.created_by || '익명')} · ${date}</div>
      </div>
      <div class="room-card-actions">
        <button class="btn-sm btn-primary room-enter-btn">입장 →</button>
        ${!isTest && currentUser && currentUser === room.created_by ? '<button class="btn-sm btn-danger room-delete-btn">삭제</button>' : ''}
      </div>
    `;
    card.querySelector('.room-enter-btn').addEventListener('click', () => openEnterModal(room, isTest));
    card.querySelector('.room-delete-btn')?.addEventListener('click', () => deleteRoom(room));
    grid.appendChild(card);
  });
}

// ── 방 삭제 ──────────────────────────────────────────────────────────────────
async function deleteRoom(room) {
  if (!confirm(`"${room.room_name}" 방을 삭제할까요?\n방 안의 모든 캡처도 함께 삭제됩니다.`)) return;
  setLoading(true);
  try {
    const { data: captures } = await db
      .from('captures')
      .select('image_path')
      .eq('room_id', room.id);

    const paths = (captures || []).map(c => c.image_path).filter(Boolean);
    if (paths.length > 0) {
      await db.storage.from('qa-captures').remove(paths);
    }

    const { error } = await db.from('rooms').delete().eq('id', room.id);
    if (error) throw error;

    await loadRooms();
  } catch (err) {
    alert('삭제 실패: ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ── 방 만들기 이벤트 ──────────────────────────────────────────────────────────
function bindRoomsScreenEvents() {
  document.getElementById('btn-create-room').addEventListener('click', () => {
    document.getElementById('new-room-creator').value = currentUser || '';
    document.getElementById('create-room-modal').classList.remove('hidden');
    document.getElementById('new-room-name').focus();
  });
  document.getElementById('btn-logout').addEventListener('click', () => {
    currentUser = '';
    currentUploaderName = '익명';
    document.getElementById('login-name').value = '';
    showScreen('login');
  });
}

async function onCreateRoomSubmit() {
  const name = document.getElementById('new-room-name').value.trim();
  const password = document.getElementById('new-room-password').value.trim();
  const creator = document.getElementById('new-room-creator').value.trim() || '익명';
  const errEl = document.getElementById('create-room-error');
  const btn = document.getElementById('btn-create-room-submit');

  errEl.classList.add('hidden');
  if (!name) { showErr(errEl, '방 이름을 입력하세요.'); return; }
  if (!password) { showErr(errEl, '비밀번호를 입력하세요.'); return; }

  btn.disabled = true;
  btn.textContent = '만드는 중…';
  try {
    const { data, error } = await db.from('rooms')
      .insert({ room_name: name, room_password: password, created_by: creator })
      .select('id, room_name, created_by, created_at')
      .single();
    if (error) throw error;
    closeCreateModal();
    await loadRooms();
    enterRoom(data, creator);
  } catch (err) {
    showErr(errEl, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '방 만들기';
  }
}

function closeCreateModal() {
  document.getElementById('create-room-modal').classList.add('hidden');
  ['new-room-name', 'new-room-password', 'new-room-creator'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('create-room-error').classList.add('hidden');
}

// ── 방 입장 ───────────────────────────────────────────────────────────────────
function openEnterModal(room, isTest = false) {
  pendingRoom = room;
  document.getElementById('enter-room-title').textContent = `"${room.room_name}" 입장`;
  document.getElementById('enter-room-password').value = isTest ? TEST_ROOM_PASSWORD : '';
  document.getElementById('enter-uploader-name').value = currentUser || '';
  document.getElementById('enter-room-error').classList.add('hidden');
  document.getElementById('enter-room-modal').classList.remove('hidden');
  const focusEl = isTest || currentUser
    ? document.getElementById('enter-room-password')
    : document.getElementById('enter-room-password');
  focusEl.focus();
}

async function onEnterRoomSubmit() {
  if (!pendingRoom) return;
  const password = document.getElementById('enter-room-password').value;
  const uploaderName = document.getElementById('enter-uploader-name').value.trim() || '익명';
  const errEl = document.getElementById('enter-room-error');
  errEl.classList.add('hidden');

  if (!password) { showErr(errEl, '비밀번호를 입력하세요.'); return; }

  const btn = document.getElementById('btn-enter-room-submit');
  btn.disabled = true;
  btn.textContent = '확인 중…';

  try {
    const { data: roomData, error } = await db
      .from('rooms')
      .select('id, room_name, room_password')
      .eq('id', pendingRoom.id)
      .single();
    if (error || !roomData) throw new Error('방 정보를 불러올 수 없습니다.');
    if (password !== roomData.room_password) throw new Error('비밀번호가 올바르지 않습니다.');

    const isTestRoom = pendingRoom.room_name === TEST_ROOM_NAME;
    if (!isTestRoom && uploaderName !== '익명') {
      const localKey = `qass_session_${pendingRoom.id}`;
      const localSession = JSON.parse(localStorage.getItem(localKey) || 'null');
      const isSamePerson = localSession && localSession.name === uploaderName;

      if (!isSamePerson) {
        const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
        const { data: existing } = await db
          .from('captures')
          .select('id')
          .eq('room_id', pendingRoom.id)
          .eq('uploader_name', uploaderName)
          .gte('captured_at', eightHoursAgo)
          .limit(1);
        if (existing && existing.length > 0) {
          throw new Error('이미 사용 중인 이름입니다. 다른 이름을 사용해주세요.');
        }
      }
      localStorage.setItem(localKey, JSON.stringify({ name: uploaderName, time: Date.now() }));
    }

    document.getElementById('enter-room-modal').classList.add('hidden');
    const room = pendingRoom;
    pendingRoom = null;
    enterRoom(room, uploaderName);
  } catch (err) {
    showErr(errEl, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '입장';
  }
}

function enterRoom(room, uploaderName) {
  currentRoom = room;
  currentUploaderName = uploaderName;

  document.getElementById('room-name-label').textContent = room.room_name;
  document.getElementById('uploader-badge').textContent = `👤 ${uploaderName}`;
  showScreen('room');

  allCaptures = [];
  loadRoomCaptures();
  subscribeRealtime();
}

// ── 방 내부 이벤트 ────────────────────────────────────────────────────────────
function bindRoomScreenEvents() {
  const goHome = () => {
    if (realtimeChannel) { db.removeChannel(realtimeChannel); realtimeChannel = null; }
    currentRoom = null;
    showScreen('rooms');
    loadRooms();
  };
  document.getElementById('btn-back').addEventListener('click', goHome);
  document.getElementById('btn-brand-home').addEventListener('click', goHome);
  document.getElementById('search').addEventListener('input', renderFiltered);
  document.getElementById('filter-user').addEventListener('change', renderFiltered);
  document.getElementById('btn-dl-zip').addEventListener('click', downloadRoomZip);
  document.getElementById('upload-input').addEventListener('change', onManualUpload);
}

// ── 모달 이벤트 바인딩 ────────────────────────────────────────────────────────
function bindModalEvents() {
  document.getElementById('btn-create-room-submit').addEventListener('click', onCreateRoomSubmit);
  document.getElementById('btn-create-room-cancel').addEventListener('click', closeCreateModal);
  document.getElementById('btn-enter-room-submit').addEventListener('click', onEnterRoomSubmit);
  document.getElementById('btn-enter-room-cancel').addEventListener('click', () => {
    document.getElementById('enter-room-modal').classList.add('hidden');
    pendingRoom = null;
  });
  document.getElementById('btn-test-hint').addEventListener('click', () => {
    document.getElementById('enter-room-password').value = TEST_ROOM_PASSWORD;
    if (!document.getElementById('enter-uploader-name').value) {
      document.getElementById('enter-uploader-name').value = '테스트 사용자';
    }
    document.getElementById('enter-uploader-name').focus();
  });
  document.getElementById('enter-room-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('enter-uploader-name').focus();
  });
  document.getElementById('enter-uploader-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') onEnterRoomSubmit();
  });
  document.getElementById('new-room-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('new-room-password').focus();
  });
  document.getElementById('new-room-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('new-room-creator').focus();
  });
  document.getElementById('new-room-creator').addEventListener('keydown', e => {
    if (e.key === 'Enter') onCreateRoomSubmit();
  });
}

// ── 캡처 로드 ─────────────────────────────────────────────────────────────────
async function loadRoomCaptures() {
  if (!currentRoom) return;
  setLoading(true);
  try {
    const { data, error } = await db
      .from('captures')
      .select('*')
      .eq('room_id', currentRoom.id)
      .order('captured_at', { ascending: false });
    if (error) throw error;
    allCaptures = data || [];
    buildUserFilter();
    renderFiltered();
  } catch (err) {
    console.error('[QASS]', err.message);
  } finally {
    setLoading(false);
  }
}

function buildUserFilter() {
  const names = [...new Set(
    allCaptures.map(c => c.uploader_name || c.user_display_name || c.user_email).filter(Boolean)
  )];
  const select = document.getElementById('filter-user');
  const prev = select.value;
  select.innerHTML = '<option value="">전체 업로더</option>';
  names.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    if (n === prev) opt.selected = true;
    select.appendChild(opt);
  });
}

// ── 실시간 구독 ───────────────────────────────────────────────────────────────
function subscribeRealtime() {
  if (!currentRoom) return;
  realtimeChannel = db.channel(`room-${currentRoom.id}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'captures',
      filter: `room_id=eq.${currentRoom.id}`,
    }, payload => {
      allCaptures.unshift(payload.new);
      buildUserFilter();
      renderFiltered();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'captures' }, payload => {
      allCaptures = allCaptures.filter(c => c.id !== payload.old.id);
      renderFiltered();
    })
    .subscribe(status => {
      document.getElementById('realtime-badge').classList.toggle('hidden', status !== 'SUBSCRIBED');
    });
}

// ── 렌더링 ────────────────────────────────────────────────────────────────────
function renderFiltered() {
  const search = document.getElementById('search').value.toLowerCase();
  const filterUser = document.getElementById('filter-user').value;
  const filtered = allCaptures.filter(c => {
    const matchSearch = !search ||
      (c.title || '').toLowerCase().includes(search) ||
      (c.url || '').toLowerCase().includes(search);
    const name = c.uploader_name || c.user_display_name || c.user_email || '';
    return matchSearch && (!filterUser || name === filterUser);
  });
  document.getElementById('count-label').textContent = `${filtered.length}건`;
  renderGrid(filtered);
}

function renderGrid(captures) {
  const grid = document.getElementById('captures-grid');
  grid.innerHTML = '';
  if (!captures.length) {
    grid.innerHTML = '<div class="empty-state">캡처된 증적이 없습니다.<br><small>확장 프로그램에서 이 방에 업로드하면 여기에 표시됩니다.</small></div>';
    return;
  }
  captures.forEach(cap => {
    const card = document.createElement('div');
    card.className = 'capture-card';
    const imgUrl = getPublicUrl(cap.image_path);
    const name = cap.uploader_name || cap.user_display_name || cap.user_email || '—';
    const time = cap.captured_at ? new Date(cap.captured_at).toLocaleString('ko-KR') : '—';
    card.innerHTML = `
      <div class="card-thumb" style="background-image:url('${esc(imgUrl)}')" title="클릭하면 원본 이미지 열기"></div>
      <div class="card-body">
        <div class="card-title" title="${esc(cap.title || '')}">${esc(cap.title || '—')}</div>
        <div class="card-url" title="${esc(cap.url || '')}">${esc(cap.url || '—')}</div>
        <div class="card-meta">
          <span class="badge-user">${esc(name)}</span>
          <span class="card-time">${time}</span>
          ${(cap.capture_count || 0) > 1 ? `<span class="card-pieces">${cap.capture_count}조각</span>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-sm" data-action="view">보기</button>
        <button class="btn-sm btn-primary" data-action="dl">저장</button>
        <button class="btn-sm btn-danger" data-action="del">삭제</button>
      </div>
    `;
    card.querySelector('.card-thumb').addEventListener('click', () => window.open(imgUrl, '_blank'));
    card.querySelector('[data-action="view"]').addEventListener('click', () => window.open(imgUrl, '_blank'));
    card.querySelector('[data-action="dl"]').addEventListener('click', () => downloadCapture(cap));
    card.querySelector('[data-action="del"]').addEventListener('click', () => deleteCapture(cap));
    grid.appendChild(card);
  });
}

// ── 이미지 URL ────────────────────────────────────────────────────────────────
function getPublicUrl(path) {
  if (!path) return '';
  const { data } = db.storage.from('qa-captures').getPublicUrl(path);
  return data.publicUrl;
}

// ── 액션 ─────────────────────────────────────────────────────────────────────
async function downloadCapture(cap) {
  const url = getPublicUrl(cap.image_path);
  const res = await fetch(url);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = makeFileName(cap.title, cap.captured_at);
  a.click();
  URL.revokeObjectURL(a.href);
}

async function onManualUpload(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !currentRoom) return;

  setLoading(true);
  let successCount = 0;
  try {
    for (const file of files) {
      const id = Date.now() + Math.random();
      const ext = file.name.split('.').pop() || 'png';
      const path = `rooms/${currentRoom.id}/${id}.${ext}`;

      const { error: upErr } = await db.storage
        .from('qa-captures')
        .upload(path, file, { upsert: true });
      if (upErr) throw upErr;

      const title = file.name.replace(/\.[^.]+$/, '');
      const { error: dbErr } = await db.from('captures').insert({
        room_id: currentRoom.id,
        uploader_name: currentUploaderName,
        url: '',
        title,
        capture_count: 1,
        image_path: path,
      });
      if (dbErr) throw dbErr;
      successCount++;
    }
    if (successCount > 0) await loadRoomCaptures();
  } catch (err) {
    alert(`업로드 실패: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

async function downloadRoomZip() {
  const search = document.getElementById('search').value.toLowerCase();
  const filterUser = document.getElementById('filter-user').value;
  const filtered = allCaptures.filter(c => {
    const matchSearch = !search ||
      (c.title || '').toLowerCase().includes(search) ||
      (c.url || '').toLowerCase().includes(search);
    const name = c.uploader_name || c.user_display_name || c.user_email || '';
    return matchSearch && (!filterUser || name === filterUser);
  });

  if (!filtered.length) return;
  setLoading(true);
  try {
    const zip = new JSZip();
    for (const cap of filtered) {
      const res = await fetch(getPublicUrl(cap.image_path));
      const blob = await res.blob();
      zip.file(makeFileName(cap.title, cap.captured_at), blob);
    }
    const content = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content);
    const roomName = (currentRoom?.room_name || 'QASS').replace(/[\\/:*?"<>|]/g, '_');
    a.download = `QASS_${roomName}_${new Date().toLocaleDateString('ko-KR').replace(/\.\s*/g, '-').replace(/-$/, '')}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert('ZIP 생성 실패: ' + err.message);
  } finally {
    setLoading(false);
  }
}

async function deleteCapture(cap) {
  if (!confirm(`"${cap.title || cap.url}" 캡처를 삭제할까요?`)) return;
  setLoading(true);
  try {
    if (cap.image_path) {
      await db.storage.from('qa-captures').remove([cap.image_path]);
    }
    const { error } = await db.from('captures').delete().eq('id', cap.id);
    if (error) throw error;
    allCaptures = allCaptures.filter(c => c.id !== cap.id);
    renderFiltered();
  } catch (err) {
    alert('삭제 실패: ' + err.message);
  } finally {
    setLoading(false);
  }
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function setLoading(v) {
  document.getElementById('loading').classList.toggle('hidden', !v);
}

function showErr(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeFileName(title, timestamp) {
  const safe = (title || 'capture').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const ts = new Date(timestamp || Date.now()).toLocaleString('ko-KR').replace(/[^0-9]/g, '').slice(0, 14);
  return `QA_${safe}_${ts}.png`;
}
