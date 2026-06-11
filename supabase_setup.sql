-- ================================================================
-- QASS v3 — Supabase 설정 SQL
-- Supabase 대시보드 → SQL Editor → 아래 내용 붙여넣고 실행
-- ================================================================

-- 1. rooms 테이블 생성
CREATE TABLE IF NOT EXISTS public.rooms (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_name    TEXT        NOT NULL,
  room_password TEXT       NOT NULL,
  created_by   TEXT        DEFAULT '익명',
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 2. captures 테이블에 컬럼 추가
--    (기존 captures 테이블이 없으면 아래 CREATE도 함께 실행)
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS room_id       UUID REFERENCES public.rooms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS uploader_name TEXT DEFAULT '익명';

-- 기존 user_id, user_email NOT NULL 제약이 있다면 해제
ALTER TABLE public.captures ALTER COLUMN user_id    DROP NOT NULL;
ALTER TABLE public.captures ALTER COLUMN user_email DROP NOT NULL;

-- 3. RLS 비활성화 (팀 내부 도구이므로 단순화)
ALTER TABLE public.rooms    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.captures DISABLE ROW LEVEL SECURITY;

-- 4. captures 테이블이 아예 없는 경우 새로 생성
-- (위 ALTER가 오류나면 이 블록으로 대체)
/*
CREATE TABLE IF NOT EXISTS public.captures (
  id                 BIGSERIAL    PRIMARY KEY,
  room_id            UUID         REFERENCES public.rooms(id) ON DELETE CASCADE,
  uploader_name      TEXT         DEFAULT '익명',
  url                TEXT,
  title              TEXT,
  capture_count      INT          DEFAULT 1,
  image_path         TEXT,
  captured_at        TIMESTAMPTZ  DEFAULT now()
);
ALTER TABLE public.captures DISABLE ROW LEVEL SECURITY;
*/

-- 5. Storage: qa-captures 버킷을 Public으로 설정
--    Supabase 대시보드 → Storage → qa-captures → Make Public 클릭
--    또는 아래 SQL:
INSERT INTO storage.buckets (id, name, public)
VALUES ('qa-captures', 'qa-captures', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 6. Storage 익명 업로드 허용 정책
DROP POLICY IF EXISTS "anon upload" ON storage.objects;
CREATE POLICY "anon upload" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (bucket_id = 'qa-captures');

DROP POLICY IF EXISTS "anon read" ON storage.objects;
CREATE POLICY "anon read" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'qa-captures');

DROP POLICY IF EXISTS "anon delete" ON storage.objects;
CREATE POLICY "anon delete" ON storage.objects
  FOR DELETE TO anon
  USING (bucket_id = 'qa-captures');

-- 자동 점검 결과 저장용 컬럼
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS issues JSONB DEFAULT '[]'::jsonb;
