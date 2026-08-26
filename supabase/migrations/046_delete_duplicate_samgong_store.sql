-- ============================================================
-- 산방식당 — 삼공밥상 중복 등록 1건 삭제
-- ============================================================
-- 배경:
--   2026-08-25 삼공밥상이 8분 간격으로 두 번 등록됨.
--   사업자번호를 한 번은 '5505001149'(하이픈 없음), 한 번은 '550-50-01149'로 입력해
--   stores.business_number UNIQUE 제약에 걸리지 않고 두 행이 모두 들어감.
--
--   유지(A): 56f3964a-9411-42ac-a19f-63be624eb5f3
--            사업자번호 550-50-01149 / 담당자 이윤정 / 예치금 400,000
--            로그인 계정(leerufina@nate.com) 연결됨
--   삭제(B): 698372c5-8e8c-43c0-bc1c-24ada9010700
--            사업자번호 5505001149 / 담당자 '사장님'
--            주문·예치금·입금요청·계정·화이트리스트 전부 0건인 빈 껍데기
--
-- 재발 방지:
--   신규 가맹점 등록 화면에서 사업자번호를 숫자만 비교해 중복을 막고,
--   저장 시 000-00-00000 형식으로 통일한다. (stores/page.tsx)
-- ============================================================

DO $$
DECLARE
  target UUID := '698372c5-8e8c-43c0-bc1c-24ada9010700';
  n INTEGER;
BEGIN
  -- 대상이 없으면(이미 삭제됨) 조용히 종료
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id = target) THEN
    RAISE NOTICE '대상 없음 — 이미 삭제되었습니다.';
    RETURN;
  END IF;

  -- 안전장치: 연결된 데이터가 하나라도 있으면 삭제하지 않고 중단
  SELECT COUNT(*) INTO n FROM public.orders WHERE store_id = target;
  IF n > 0 THEN RAISE EXCEPTION '주문 %건이 연결되어 있어 삭제 중단', n; END IF;

  SELECT COUNT(*) INTO n FROM public.deposit_transactions WHERE store_id = target;
  IF n > 0 THEN RAISE EXCEPTION '예치금 내역 %건이 연결되어 있어 삭제 중단', n; END IF;

  SELECT COUNT(*) INTO n FROM public.deposit_requests WHERE store_id = target;
  IF n > 0 THEN RAISE EXCEPTION '입금요청 %건이 연결되어 있어 삭제 중단', n; END IF;

  SELECT COUNT(*) INTO n FROM public.profiles WHERE store_id = target;
  IF n > 0 THEN RAISE EXCEPTION '로그인 계정 %건이 연결되어 있어 삭제 중단', n; END IF;

  SELECT COUNT(*) INTO n FROM public.store_allowed_products WHERE store_id = target;
  IF n > 0 THEN RAISE EXCEPTION '발주 화이트리스트 %건이 연결되어 있어 삭제 중단', n; END IF;

  DELETE FROM public.stores WHERE id = target;
  RAISE NOTICE '삼공밥상 중복 행 삭제 완료 (%)', target;
END $$;

-- 남은 삼공밥상 사업자번호를 하이픈 형식으로 통일 (이미 통일되어 있으면 변화 없음)
UPDATE public.stores
SET business_number = '550-50-01149'
WHERE id = '56f3964a-9411-42ac-a19f-63be624eb5f3'
  AND business_number <> '550-50-01149';
