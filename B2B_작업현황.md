# B2B(아워홈) 채널 작업 현황

> 작성일: 2026-04-21
> 목적: 다른 기기(집 PC)에서 2단계 이어 작업할 때 컨텍스트 복원용

---

## 전체 흐름 요약

산방식당 발주프로그램에 **B2B(아워홈) 발주 채널**과 **박스/낱팩 이원 재고** 기능을 추가하는 작업. 가맹점 기존 구조는 건드리지 않고 별개 탭으로 추가.

### 왜 필요했나
- 아워홈은 **박스 판매가 원칙**이지만, 일부 품목(**육수간장원액·비빔전용장**)은 **팩 단위**로 발주받음
- 팩 단위 발주 시 박스를 깨뜨려야 해서 **낱팩 재고가 발생** → 그대로 두면 불용재고
- 해결: 낱팩을 **가맹점에 판매 가능**하게 해서 소진

### 확정된 설계 (사용자 합의 완료)
- 재고 구조 = **B안: 박스 재고 + 낱팩 재고 이원 관리**
- 가격 = **박스가 + 입수(pack_per_box)** 만 저장. 팩가는 `박스가 ÷ 입수` 로 자동 계산 (저장 안 함)
- 가맹점 낱팩가 = 가맹점 박스가 ÷ 입수
- 아워홈 공급가는 가맹점 판가와 **완전히 별개** (B2B 전용 가격 필드)
- 가맹점 낱팩 노출 조건 = `is_loose_pack_sellable = TRUE` AND `loose_pack_qty > 0`

---

## 1단계 — 완료·배포됨 (commit `fb23271`)

### DB (006 마이그레이션 + 007 seed, Supabase SQL Editor에서 이미 실행함)
- `products` 확장: `pack_per_box`, `b2b_price`, `b2b_price_with_tax`, `is_b2b_eligible`, `is_loose_pack_sellable` (전부 DEFAULT 있음 — 기존 로우 자동 호환)
- `inventory` 확장: `loose_pack_qty INT DEFAULT 0`
- `inventory_transactions` 확장: `unit TEXT DEFAULT 'box'`
- 신규 테이블: `b2b_customers`, `b2b_orders`, `b2b_order_items`, `b2b_order_logs`
- 신규 RPC: `apply_b2b_inventory_delta(product_id, unit, delta, desc, actor)` — 박스/낱팩 이원 재고 안전 조정(박스 깨지면 낱팩 누적, 복구 시 승격)
- 아워홈 거래처 + 5개 상품 입수·B2B가격 seed

### 코드
| 파일 | 내용 |
|------|------|
| `src/lib/menu.ts` | 관리자 전용 "B2B 발주" 메뉴 1줄 추가 |
| `src/types/index.ts` | B2bCustomer/B2bOrder/B2bOrderItem/B2bProduct 등 타입 추가 |
| `src/app/(dashboard)/b2b/page.tsx` | B2B 발주 목록 |
| `src/app/(dashboard)/b2b/new/page.tsx` | 발주 등록 (박스/팩 혼합 입력) |
| `src/app/(dashboard)/b2b/[id]/page.tsx` | 상세 + 출고 처리/취소/삭제 |
| `src/app/(dashboard)/b2b/customers/page.tsx` | 거래처 관리 |
| `src/app/api/b2b/orders/route.ts` | POST 발주 생성 |
| `src/app/api/b2b/orders/[id]/route.ts` | PATCH(ship/cancel/update), DELETE |
| `supabase/migrations/006_b2b_and_pack_inventory.sql` | 스키마 + RPC |
| `supabase/migrations/007_b2b_seed.sql` | 아워홈 + 5개 상품 seed |

### B2B 발주 흐름
1. 관리자가 이메일로 아워홈 발주 수신
2. `/b2b/new`에서 수동 입력 → `status=pending` (재고 불변)
3. 상세에서 **"출고 처리"** → `status=shipped` + 재고 차감 (박스/낱팩 자동 계산)
4. 실수 시 pending은 **삭제**, shipped는 **취소**로 재고 복구

---

## 2단계 — 미완 (집에서 이어서)

### 왜 중요한가
1단계만으론 **관리자 재고 화면에 낱팩이 안 보이고, 가맹점이 낱팩을 살 수 없음**. 낱팩이 발생해도 활용 불가 = 처음 제기한 불용재고 문제 미해결.

### 데드라인
**2026-04-24(금) 아워홈 첫 출고 예정** — 그 전에 2단계까지 마치면 첫 낱팩부터 곧장 운영 가능.

### 작업 항목
1. **`/inventory` 페이지 확장**
   - 상품별 "낱팩 N팩" 컬럼 추가 (박스 컬럼 옆)
   - `is_loose_pack_sellable` 체크박스(관리자가 상품별 ON/OFF)
   - 전용상품 변경은 기존 비밀번호 재확인 패턴(`PasswordConfirmModal`) 재사용
2. **`/orders/new` (가맹점 발주) 확장**
   - 조건: `is_loose_pack_sellable = TRUE` **AND** `loose_pack_qty > 0`
   - 위 조건 만족 상품에 "낱팩 N팩 남음 · ₩X/팩" 행 추가 (기존 박스 UI 그대로 유지)
   - 팩가 = `price_with_tax ÷ pack_per_box` 자동 계산
3. **`/api/orders` 확장**
   - POST / PUT / DELETE 모두에 `unit: 'box' | 'pack'` 분기
   - 박스 주문: 기존 로직 유지
   - 팩 주문: `apply_b2b_inventory_delta` RPC 호출 (B2B와 동일 로직 재사용)
4. **008 마이그레이션 신규**
   - `order_items.unit TEXT DEFAULT 'box' CHECK IN ('box','pack')`
   - 기존 주문 전부 자동으로 'box' 해석 (DEFAULT 덕분)

### 무영향 원칙 (계속 유지)
- 기존 박스 발주/취소 경로 로직 변경 금지, **분기로 신규 경로만 추가**
- 낱팩 플래그 OFF 상태 = 기존 가맹점 화면과 완전 동일

---

## 집 PC에서 이어서 할 때 체크리스트

```bash
cd <산방식당발주프로그램 경로>
git pull origin main          # 최신 fb23271 받기
npm install                    # 혹시 빠진 의존성
npm run dev                    # 로컬 확인용
```

그리고 Claude한테 "`B2B_작업현황.md` 읽고 2단계 이어서 진행하자" 라고 하시면 됩니다.

## 테스트 시 주의

`.env.local`이 **운영 Supabase**를 가리키므로 로컬 테스트도 실제 데이터에 반영됨.
- B2B 발주 등록(pending)까지는 재고 영향 0 → 안전
- **출고 처리** 누르면 실제 재고 차감 → 테스트할 때는 1팩/1박스 같은 최소 수량 + 즉시 취소로 복구

---

## 참고 파일

- `진행상황.md` — 프로젝트 전체 진행 상황
- `거래관계구조.md` — 본사/신화/제조사/가맹점 거래 구조
- `전용상품목록.md` — 전용상품 7종 가격 정보 (2026-05 인상분 반영됨)
