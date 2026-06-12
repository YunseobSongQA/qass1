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
  bindInspectEvents();
  if (await tryDeepLink()) return;
  showScreen('login');
});

// ── 딥링크 (확장 프로그램에서 방 바로 열기) ──────────────────────────────────
// app.html?room=<id>&name=<이름> — 확장에서 이미 비밀번호를 확인하고 연결된
// 방이므로 별도 인증 없이 바로 입장한다.
async function tryDeepLink() {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) return false;
  const name = (params.get('name') || '').trim() || '익명';
  setLoading(true);
  try {
    const { data, error } = await db
      .from('rooms')
      .select('id, room_name, created_by, created_at')
      .eq('id', roomId)
      .single();
    if (error || !data) return false;
    currentUser = name;
    currentUploaderName = name;
    document.getElementById('rooms-user-badge').textContent = `👤 ${name}`;
    enterRoom(data, name);
    return true;
  } catch (_) {
    return false;
  } finally {
    setLoading(false);
  }
}

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
  document.getElementById('inspect-screen').classList.toggle('hidden', name !== 'inspect');
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
  document.getElementById('btn-issues-close').addEventListener('click', closeIssuesModal);
  document.getElementById('btn-issues-dl').addEventListener('click', () => {
    if (issuesModalCap) downloadCapture(issuesModalCap);
  });
  document.getElementById('issues-overlay-toggle').addEventListener('change', e => {
    document.getElementById('issues-stage').classList.toggle('overlay-off', !e.target.checked);
  });
  document.getElementById('issues-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeIssuesModal();
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
  renderMembers();
  renderGrid(filtered);
}

// ── 참여자 목록 (누가 몇 건을 언제 올렸는지) ──────────────────────────────────
function renderMembers() {
  const wrap = document.getElementById('room-members');
  if (!wrap) return;

  const map = new Map();
  allCaptures.forEach(c => {
    const name = c.uploader_name || c.user_display_name || c.user_email || '익명';
    const t = c.captured_at ? new Date(c.captured_at).getTime() : 0;
    const m = map.get(name) || { name, count: 0, last: 0 };
    m.count++;
    if (t > m.last) m.last = t;
    map.set(name, m);
  });
  const members = [...map.values()].sort((a, b) => b.last - a.last);

  if (!members.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }

  const activeUser = document.getElementById('filter-user').value;
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="room-members-head">
      <span class="room-members-title">👥 참여자 ${members.length}명</span>
      <span class="room-members-hint">이름을 누르면 그 사람의 증적만 모아 봅니다</span>
    </div>
    <div class="room-members-list">
      ${members.map(m => `
        <button class="member-chip${m.name === activeUser ? ' active' : ''}" data-name="${esc(m.name)}" title="${esc(m.name)} · ${m.count}건">
          <span class="member-avatar">${esc(memberInitial(m.name))}</span>
          <span class="member-info">
            <span class="member-name">${esc(m.name)}</span>
            <span class="member-meta">${m.count}건 · 최근 ${fmtMemberTime(m.last)}</span>
          </span>
        </button>
      `).join('')}
    </div>`;

  wrap.querySelectorAll('.member-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const select = document.getElementById('filter-user');
      select.value = chip.classList.contains('active') ? '' : chip.dataset.name;
      renderFiltered();
    });
  });
}

function memberInitial(name) {
  const s = (name || '').trim();
  return s ? [...s][0].toUpperCase() : '?';
}

function fmtMemberTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
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
    const issues = mergeIssues(cap.issues);
    card.innerHTML = `
      <div class="card-thumb" style="background-image:url('${esc(imgUrl)}')" title="클릭하면 원본 이미지 열기">
        ${issues.length ? `<span class="badge-issues" title="자동 점검 이슈 ${issues.length}건 — 클릭하면 상세 보기">⚠${issues.length}</span>` : ''}
      </div>
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
        ${issues.length ? '<button class="btn-sm btn-issues" data-action="issues">장애 보기</button>' : ''}
        <button class="btn-sm btn-primary" data-action="dl">저장</button>
        <button class="btn-sm btn-danger" data-action="del">삭제</button>
      </div>
    `;
    card.querySelector('.card-thumb').addEventListener('click', () => window.open(imgUrl, '_blank'));
    card.querySelector('[data-action="view"]').addEventListener('click', () => window.open(imgUrl, '_blank'));
    card.querySelector('[data-action="dl"]').addEventListener('click', () => downloadCapture(cap));
    card.querySelector('[data-action="del"]').addEventListener('click', () => deleteCapture(cap));
    card.querySelector('[data-action="issues"]')?.addEventListener('click', () => openIssuesModal(cap));
    card.querySelector('.badge-issues')?.addEventListener('click', e => {
      e.stopPropagation();
      openIssuesModal(cap);
    });
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

// ── 1차 자동 점검 (장애 보기) 모달 ───────────────────────────────────────────
const ISSUE_TYPE_META = {
  spacing: { label: '띄어쓰기', color: '#2563EB' },
  spell:   { label: '맞춤법',  color: '#D97706' },
  ui:      { label: 'UI장애',  color: '#E11D48' },
};

let issuesModalCap = null;

// 같은 위치(거의 동일한 rectPct)·같은 타입 이슈는 박스가 겹쳐 보이므로 한 건으로 병합
function mergeIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  const merged = [];
  for (const issue of list) {
    const r = issue.rectPct;
    const dup = r && merged.find(m => m.type === issue.type && m.rectPct &&
      Math.abs(m.rectPct.x - r.x) < 0.5 && Math.abs(m.rectPct.y - r.y) < 0.5 &&
      Math.abs(m.rectPct.w - r.w) < 1 && Math.abs(m.rectPct.h - r.h) < 1);
    if (dup) {
      if (issue.message && !(dup.message || '').includes(issue.message)) {
        dup.message = (dup.message ? dup.message + ' · ' : '') + issue.message;
      }
    } else {
      merged.push({ ...issue });
    }
  }
  return merged;
}

function openIssuesModal(cap) {
  issuesModalCap = cap;
  const issues = mergeIssues(cap.issues);
  document.getElementById('issues-modal-title').textContent =
    `1차 자동 점검 — ${cap.title || cap.url || '캡처'} (${issues.length}건)`;

  const stage = document.getElementById('issues-stage');
  stage.querySelectorAll('.issue-box').forEach(el => el.remove());
  stage.classList.remove('overlay-off');
  document.getElementById('issues-overlay-toggle').checked = true;
  document.getElementById('issues-image').src = getPublicUrl(cap.image_path);

  const list = document.getElementById('issues-list');
  list.innerHTML = '';

  issues.forEach((issue, i) => {
    const meta = ISSUE_TYPE_META[issue.type] || { label: issue.type || '기타', color: '#64748b' };
    const num = i + 1;

    // rectPct 가 없는(구버전) 캡처는 박스 없이 목록만 표시
    if (issue.rectPct) {
      const box = document.createElement('div');
      box.className = 'issue-box';
      box.dataset.idx = i;
      box.style.left = issue.rectPct.x + '%';
      box.style.top = issue.rectPct.y + '%';
      box.style.width = issue.rectPct.w + '%';
      box.style.height = issue.rectPct.h + '%';
      box.style.borderColor = meta.color;
      box.title = `${meta.label}: ${issue.message || ''}`;
      box.innerHTML = `<span class="issue-box-num" style="background:${meta.color}">${num}</span>`;
      box.addEventListener('click', () => highlightIssue(i, false));
      stage.appendChild(box);
    }

    const item = document.createElement('div');
    item.className = 'issue-item';
    item.dataset.idx = i;
    item.innerHTML = `
      <span class="issue-num" style="background:${meta.color}">${num}</span>
      <div class="issue-item-body">
        <div class="issue-item-head">
          <span class="issue-type" style="color:${meta.color}">${esc(meta.label)}</span>${esc(issue.message || '')}
        </div>
        ${issue.text ? `<div class="issue-text">${esc(issue.text)}</div>` : ''}
      </div>
    `;
    item.addEventListener('click', () => highlightIssue(i, true));
    list.appendChild(item);
  });

  if (!issues.length) {
    list.innerHTML = '<div class="issues-empty">검출된 이슈가 없습니다.</div>';
  }
  document.getElementById('issues-modal').classList.remove('hidden');
}

function highlightIssue(idx, scrollToBox) {
  document.querySelectorAll('#issues-stage .issue-box').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.idx) === idx));
  document.querySelectorAll('#issues-list .issue-item').forEach(it =>
    it.classList.toggle('active', Number(it.dataset.idx) === idx));
  if (scrollToBox) {
    const box = document.querySelector(`#issues-stage .issue-box[data-idx="${idx}"]`);
    box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function closeIssuesModal() {
  document.getElementById('issues-modal').classList.add('hidden');
  document.getElementById('issues-image').src = '';
  issuesModalCap = null;
}

// ── 1차 자동 점검 탭 ─────────────────────────────────────────────────────────
// 분석은 캡처 시점에 끝나 captures.issues(JSONB)에 저장돼 있다.
// 이 탭은 재분석 없이 저장된 issues를 모아 보여주기만 한다.
let inspectRooms = [];
let inspectCaptures = [];
let inspectSelected = new Set();
let inspectRoom = null;

function bindInspectEvents() {
  document.querySelectorAll('.main-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      if (btn.dataset.tab === 'inspect') openInspectTab();
      else { showScreen('rooms'); loadRooms(); }
    });
  });
  document.getElementById('btn-feature-tour').addEventListener('click', openInspectTab);
  document.getElementById('btn-brand-home-inspect').addEventListener('click', () => {
    showScreen('rooms');
    loadRooms();
  });
  document.getElementById('inspect-select-all').addEventListener('click', e => {
    e.preventDefault();
    const checks = document.querySelectorAll('.inspect-cap-check');
    const allChecked = inspectCaptures.length > 0 && inspectSelected.size === inspectCaptures.length;
    checks.forEach(c => {
      if (c.checked === !allChecked) return;
      c.checked = !allChecked;
      c.dispatchEvent(new Event('change'));
    });
  });
  document.getElementById('btn-inspect-results').addEventListener('click', showInspectResults);
  document.getElementById('btn-inspect-reselect').addEventListener('click', () => {
    showInspectStage('select');
    document.getElementById('inspect-preview').classList.remove('hidden');
  });
}

function showInspectStage(stage) {
  document.getElementById('inspect-select').classList.toggle('hidden', stage !== 'select');
  document.getElementById('inspect-results').classList.toggle('hidden', stage !== 'results');
}

async function openInspectTab() {
  showScreen('inspect');
  document.getElementById('inspect-user-badge').textContent = currentUser ? `👤 ${currentUser}` : '';
  showInspectStage('select');
  document.getElementById('inspect-preview').classList.remove('hidden');
  inspectRoom = null;
  inspectSelected.clear();
  document.getElementById('inspect-captures-section').classList.add('hidden');
  await loadInspectRooms();
}

async function loadInspectRooms() {
  const wrap = document.getElementById('inspect-rooms');
  wrap.innerHTML = '<div class="empty-state">폴더를 불러오는 중…</div>';
  try {
    const [roomsRes, capsRes] = await Promise.all([
      db.from('rooms').select('id, room_name, created_by, created_at').order('created_at', { ascending: false }),
      db.from('captures').select('room_id'),
    ]);
    if (roomsRes.error) throw roomsRes.error;
    if (capsRes.error) throw capsRes.error;
    const counts = {};
    (capsRes.data || []).forEach(c => { counts[c.room_id] = (counts[c.room_id] || 0) + 1; });
    inspectRooms = roomsRes.data || [];
    renderInspectRooms(counts);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">오류: ${esc(err.message)}</div>`;
  }
}

function renderInspectRooms(counts) {
  const wrap = document.getElementById('inspect-rooms');
  wrap.innerHTML = '';
  if (!inspectRooms.length) {
    wrap.innerHTML = '<div class="empty-state">아직 방이 없습니다.</div>';
    return;
  }
  inspectRooms.forEach(room => {
    const row = document.createElement('div');
    row.className = 'inspect-room-row';
    row.dataset.id = room.id;
    row.innerHTML = `
      <span class="inspect-room-icon">📁</span>
      <span class="inspect-room-name">${esc(room.room_name)}</span>
      <span class="inspect-room-count">캡처 ${counts[room.id] || 0}개</span>
    `;
    row.addEventListener('click', () => selectInspectRoom(room));
    wrap.appendChild(row);
  });
}

async function selectInspectRoom(room) {
  inspectRoom = room;
  inspectSelected.clear();
  document.querySelectorAll('.inspect-room-row').forEach(r =>
    r.classList.toggle('active', r.dataset.id === String(room.id)));

  document.getElementById('inspect-captures-section').classList.remove('hidden');
  document.getElementById('inspect-room-label').textContent = room.room_name;
  const grid = document.getElementById('inspect-captures');
  grid.innerHTML = '<div class="empty-state">캡처를 불러오는 중…</div>';
  updateInspectResultBtn();
  try {
    const { data, error } = await db
      .from('captures')
      .select('*')
      .eq('room_id', room.id)
      .order('captured_at', { ascending: false });
    if (error) throw error;
    inspectCaptures = data || [];
    renderInspectCaptures();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">오류: ${esc(err.message)}</div>`;
  }
}

function renderInspectCaptures() {
  const grid = document.getElementById('inspect-captures');
  grid.innerHTML = '';
  if (!inspectCaptures.length) {
    grid.innerHTML = '<div class="empty-state">이 폴더에 캡처가 없습니다.</div>';
    return;
  }
  inspectCaptures.forEach(cap => {
    const issues = mergeIssues(cap.issues);
    const card = document.createElement('label');
    card.className = 'inspect-cap-card';
    card.innerHTML = `
      <input type="checkbox" class="inspect-cap-check" />
      <div class="inspect-cap-thumb" style="background-image:url('${esc(getPublicUrl(cap.image_path))}')">
        ${issues.length ? `<span class="badge-issues">⚠${issues.length}</span>` : ''}
      </div>
      <div class="inspect-cap-title" title="${esc(cap.title || cap.url || '')}">${esc(cap.title || cap.url || '—')}</div>
    `;
    const check = card.querySelector('.inspect-cap-check');
    check.addEventListener('change', () => {
      if (check.checked) inspectSelected.add(cap.id);
      else inspectSelected.delete(cap.id);
      card.classList.toggle('selected', check.checked);
      updateInspectResultBtn();
    });
    grid.appendChild(card);
  });
}

function updateInspectResultBtn() {
  const btn = document.getElementById('btn-inspect-results');
  btn.textContent = `선택한 ${inspectSelected.size}개 결과 보기`;
  btn.disabled = inspectSelected.size === 0;
}

function showInspectResults() {
  const caps = inspectCaptures.filter(c => inspectSelected.has(c.id));
  if (!caps.length) return;
  showInspectStage('results');

  const totals = { spacing: 0, spell: 0, ui: 0 };
  caps.forEach(c => mergeIssues(c.issues).forEach(issue => {
    if (totals[issue.type] !== undefined) totals[issue.type]++;
  }));

  document.getElementById('inspect-chips').innerHTML = ['spacing', 'spell', 'ui'].map(t => {
    const meta = ISSUE_TYPE_META[t];
    return `<span class="inspect-chip" style="border-color:${meta.color};color:${meta.color}">${meta.label} ${totals[t]}</span>`;
  }).join('');

  // 선택한 캡처 전체에 이슈가 하나도 없으면 예시 미리보기 + 안내를 유지
  const totalIssues = totals.spacing + totals.spell + totals.ui;
  document.getElementById('inspect-results-empty').classList.toggle('hidden', totalIssues !== 0);
  document.getElementById('inspect-preview').classList.toggle('hidden', totalIssues !== 0);

  const wrap = document.getElementById('inspect-result-cards');
  wrap.innerHTML = '';
  caps.forEach(cap => wrap.appendChild(buildInspectResultCard(cap)));
}

function buildInspectResultCard(cap) {
  const issues = mergeIssues(cap.issues);
  const imgUrl = getPublicUrl(cap.image_path);
  const card = document.createElement('div');
  card.className = 'inspect-result-card';

  const boxesHtml = issues.map((issue, i) => {
    if (!issue.rectPct) return '';
    const meta = ISSUE_TYPE_META[issue.type] || { label: issue.type || '기타', color: '#64748b' };
    return `<div class="issue-box" data-idx="${i}" title="${esc(meta.label)}: ${esc(issue.message || '')}"
      style="left:${issue.rectPct.x}%;top:${issue.rectPct.y}%;width:${issue.rectPct.w}%;height:${issue.rectPct.h}%;border-color:${meta.color}">
      <span class="issue-box-num" style="background:${meta.color}">${i + 1}</span>
    </div>`;
  }).join('');

  const listHtml = issues.length ? issues.map((issue, i) => {
    const meta = ISSUE_TYPE_META[issue.type] || { label: issue.type || '기타', color: '#64748b' };
    const fix = (issue.type !== 'ui' && issue.wrong && issue.right)
      ? `<div class="issue-fix"><s>${esc(issue.wrong)}</s> → <b>${esc(issue.right)}</b></div>` : '';
    return `
      <div class="issue-item" data-idx="${i}">
        <span class="issue-num" style="background:${meta.color}">${i + 1}</span>
        <div class="issue-item-body">
          <div class="issue-item-head"><span class="issue-type" style="color:${meta.color}">${esc(meta.label)}</span>${esc(issue.message || '')}</div>
          ${fix}
          ${issue.text ? `<div class="issue-text">${esc(issue.text)}</div>` : ''}
        </div>
      </div>`;
  }).join('') : '<div class="issues-empty">이상 없음 — 검출된 이슈가 없습니다.</div>';

  card.innerHTML = `
    <div class="inspect-result-head">
      <div class="inspect-result-title" title="${esc(cap.title || cap.url || '')}">${esc(cap.title || cap.url || '캡처')}</div>
      ${issues.length
        ? `<span class="inspect-result-badge">이슈 ${issues.length}건</span>`
        : '<span class="inspect-result-badge ok">이상 없음</span>'}
      ${issues.length ? '<button class="btn-sm inspect-result-zoom">🔍 크게 보기</button>' : ''}
      <button class="btn-sm btn-primary inspect-result-dl">⬇ 원본 저장</button>
    </div>
    <div class="inspect-compare">
      <div class="inspect-pane">
        <div class="inspect-pane-label">검증 전 (원본)</div>
        <div class="inspect-pane-scroll"><img src="${esc(imgUrl)}" alt="원본" loading="lazy" /></div>
      </div>
      <div class="inspect-pane">
        <div class="inspect-pane-label">검증 후 (자동 점검 표시) ${issues.length ? '<span class="inspect-pane-hint">— 클릭하면 크게 보기</span>' : ''}</div>
        <div class="inspect-pane-scroll ${issues.length ? 'inspect-pane-clickable' : ''}">
          <div class="inspect-stage">
            <img src="${esc(imgUrl)}" alt="점검 결과" loading="lazy" />
            ${boxesHtml}
          </div>
        </div>
      </div>
    </div>
    <div class="inspect-issue-list">${listHtml}</div>
  `;

  card.querySelector('.inspect-result-dl').addEventListener('click', () => downloadCapture(cap));
  card.querySelector('.inspect-result-zoom')?.addEventListener('click', () => openIssuesModal(cap));
  card.querySelector('.inspect-pane-clickable')?.addEventListener('click', () => openIssuesModal(cap));
  card.querySelectorAll('.issue-item[data-idx]').forEach(item =>
    item.addEventListener('click', () => highlightInspectIssue(card, Number(item.dataset.idx))));
  card.querySelectorAll('.issue-box').forEach(box =>
    box.addEventListener('click', e => {
      e.stopPropagation();
      highlightInspectIssue(card, Number(box.dataset.idx));
    }));
  return card;
}

function highlightInspectIssue(card, idx) {
  card.querySelectorAll('.issue-box').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.idx) === idx));
  card.querySelectorAll('.issue-item').forEach(it =>
    it.classList.toggle('active', Number(it.dataset.idx) === idx));
  const box = card.querySelector(`.issue-box[data-idx="${idx}"]`);
  if (box) {
    const pane = box.closest('.inspect-pane-scroll');
    if (pane) pane.scrollTop = Math.max(0, box.offsetTop - pane.clientHeight / 2);
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
