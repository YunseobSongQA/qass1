# QASS

증적(스크린샷) 협업 도구 — 정적 사이트(HTML/CSS/JS) + Supabase 백엔드.
**Cloudflare Pages** 로 배포: https://qass1.pages.dev

---

## CI/CD 상태

[![CI Gate](https://github.com/YunseobSongQA/qass1/actions/workflows/ci-gate.yml/badge.svg)](https://github.com/YunseobSongQA/qass1/actions/workflows/ci-gate.yml)
[![Selenium](https://github.com/YunseobSongQA/qass1/actions/workflows/selenium.yml/badge.svg)](https://github.com/YunseobSongQA/qass1/actions/workflows/selenium.yml)
[![Appium](https://github.com/YunseobSongQA/qass1/actions/workflows/appium.yml/badge.svg)](https://github.com/YunseobSongQA/qass1/actions/workflows/appium.yml)

자동화 테스트는 별도 repo [**YunseobSongQA/Auto**](https://github.com/YunseobSongQA/Auto)
의 `automation-portfolio/` 에 있고(단일 진실 공급원 = `FLOW_CONTRACT.md`),
각 워크플로우가 `actions/checkout` 으로 그 repo 를 가져와 실행한다.

### 툴별 CI 전략 — 왜 API/Playwright만 게이트이고 Selenium/Appium은 분리했나

4개 자동화 툴은 **같은 QASS 플로우**를 각자의 방식으로 검증한다. 모두를 매 push 게이트에
넣으면 느리고 불안정해지므로, **"빠르고 결정적인 두 개"만 배포 게이트**로 두고 나머지는
성격에 맞게 분리했다.

- **API(Newman) + Playwright = 배포 게이트** (`ci-gate.yml`, 매 main push/PR):
  둘 다 Linux runner 에서 빠르고 안정적으로 끝나며, 백엔드(REST)와 실제 브라우저 UX 라는
  서로 다른 계층을 덮는다. 둘 다 통과해야만 배포로 넘어간다.
- **Selenium = 분리** (`selenium.yml`, 수동 + 주 1회 cron): Playwright 와 **같은 UI 플로우의
  중복 검증**이라 게이트에 또 넣을 필요가 없다. 회귀 감시용으로 주기 실행만 한다.
- **Appium = 분리** (`appium.yml`, 수동 전용): **Android 에뮬레이터(KVM)** 에 의존해 느리고
  플레이키하다. 게이트에 두면 배포가 자주 막힌다. CI 는 스모크 수준만, **정식 실행은 로컬 PC**
  전제다.

### 배포(CD) 전략과 트레이드오프

| 방식 | 게이트 가능 | 비고 |
|------|:--:|------|
| A. Cloudflare Pages **Git 자동배포** 유지 | ❌ | 가장 단순하지만 CI 통과와 무관하게 push 즉시 배포 → "게이트 후 배포" 불가 |
| B. **Actions 에서 직접 배포** (`wrangler pages deploy`) + Pages Git배포 **끄기** | ✅ | 단일 파이프라인, 게이트 통과 후에만 배포. 권장 |
| C. 새 Direct-Upload 프로젝트 분리 | ✅ | B 와 사실상 동일하나 프로젝트가 둘로 늘어 관리 부담 |

→ **B 채택.** `ci-gate.yml` 의 `deploy` job 이 API+Playwright 통과 후 `main` push 일 때만
`cloudflare/wrangler-action` 으로 루트 정적 파일을 배포한다. **이중 배포를 막으려면
Cloudflare 대시보드에서 이 프로젝트의 "Git 자동 빌드/배포"를 꺼야 한다**(아래 절차 참고).

---

## 내가 직접 해야 할 일 (1회 설정)

### 1) GitHub Secrets 등록
`qass1` repo → Settings → Secrets and variables → Actions → **New repository secret**

| Secret 이름 | 용도 | 필수 |
|------------|------|:--:|
| `CLOUDFLARE_API_TOKEN` | Pages 배포 토큰 (권한: *Account › Cloudflare Pages › Edit*) | ✅ (배포용) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 계정 ID (대시보드 우측 또는 `wrangler whoami`) | ✅ (배포용) |
| `SUPABASE_URL` | 예) `https://snjexfohyklviarxprvm.supabase.co` | 선택 |
| `SUPABASE_ANON_KEY` | Supabase anon(공개) 키 | 선택 |

> `SUPABASE_*` 는 현재 테스트가 공개 anon 키를 코드/컬렉션 기본값으로 갖고 있어 **없어도 게이트는
> 통과**한다. 등록하면 Newman 이 그 값으로 덮어쓴다(하드코딩 회피 권장).

### 2) Cloudflare Pages 설정 변경 (이중 배포 방지)
- Cloudflare 대시보드 → Workers & Pages → **qass1** → Settings →
  **Builds & deployments** 에서 **자동 Git 배포를 비활성화**(또는 Production branch 연결 해제).
- 프로젝트 이름이 `qass1` 이 아니면 `ci-gate.yml` 의 `--project-name=qass1` 을 실제 이름으로 수정.

### 3) push 후 확인 순서
1. 이 변경을 `main` 에 push → repo 의 **Actions** 탭 열기.
2. **CI Gate (deploy)** 실행 확인 → `api`, `playwright` 두 job 초록 → 이어서 `deploy` 실행.
3. `deploy` 가 초록이면 https://qass1.pages.dev 반영 확인.
4. **Selenium**: Actions → *Selenium (manual / weekly)* → **Run workflow** 로 수동 1회 검증.
5. **Appium**: Actions → *Appium (manual only · emulator)* → **Run workflow** (스모크 · 실패 가능,
   정식 실행은 로컬).
6. 각 실행의 **Artifacts** 에서 `api-newman-report`(htmlextra HTML), `playwright-report` 등 확인.

<!-- redeploy: trigger CI pipeline (no functional change) -->
