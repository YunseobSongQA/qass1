// 페이지 정보 반환 및 스크롤 감지 (모든 프레임에서 동작)
// 중복 주입 시 리스너가 여러 번 등록되지 않도록 가드
if (!window.__qassContentLoaded) {
  window.__qassContentLoaded = true;

  let scrollDebounceTimer = null;

  const getScrollInfo = () => ({
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    ),
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  });

  // capture: true → window 및 내부 div 등 모든 스크롤 영역 감지
  document.addEventListener('scroll', () => {
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: 'SCROLL_CHANGED', ...getScrollInfo() }).catch(() => {});
      } catch (_) {}
    }, 200);
  }, { passive: true, capture: true });

  // background의 요청에 응답
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_SCROLL_INFO') {
      sendResponse(getScrollInfo());
    }
  });
}
