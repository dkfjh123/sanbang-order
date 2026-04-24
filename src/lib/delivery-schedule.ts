/**
 * 매장별 배송 스케줄 계산.
 *
 * - 서울·내륙: 매장별 delivery_days 배열에 지정된 요일마다 출고, 전일 17시 마감
 * - 제주: 매주 수요일 16시 마감 → 목요일 상차 → 금요일 도착 (region 고정)
 * - deadline_override_until 이 현재 시각 이후라면 마감 판정에서 false (연장 중)
 *
 * delivery_days 가 null 이면 region 기본값 사용:
 *   - seoul: [1, 3, 5] (월·수·금)
 *   - jeju : [4] (목요일 상차 — 내부적으로만 사용. 실제 스케줄은 getJejuSchedule)
 */

type Region = 'seoul' | 'jeju';

interface StoreScheduleInput {
  region: Region;
  delivery_days: number[] | null;
  deadline_override_until?: string | null;
}

interface DeliveryInfo {
  region: Region;
  deadlineDate: Date;
  deadlineLabel: string;
  shipDate: Date;
  shipLabel: string;
  arrivalDate: Date;
  arrivalLabel: string;
  remainingMs: number;
  remainingLabel: string;
  isPastDeadline: boolean;
  scheduleDescription: string;
  deliveryDays: number[];         // 확정된 배송요일 배열 (UI 라벨용)
  isOverrideActive: boolean;      // 마감 연장 중 여부
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * Supabase int[] 값이 드물게 문자열(`"{2,3,5}"`)로 건너올 수 있어 방어적으로 정규화.
 * null / 빈 배열 / 불명 값은 null 반환 (호출부에서 region 기본값으로 fallback).
 */
function normalizeDeliveryDays(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const nums = raw
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    return nums.length > 0 ? [...new Set(nums)].sort((a, b) => a - b) : null;
  }
  if (typeof raw === 'string') {
    // "{2,3,5}" 또는 "2,3,5" 형태
    const cleaned = raw.replace(/[{}]/g, '').trim();
    if (!cleaned) return null;
    const nums = cleaned
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    return nums.length > 0 ? [...new Set(nums)].sort((a, b) => a - b) : null;
  }
  return null;
}

function formatDate(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAY_NAMES[d.getDay()];
  return `${m}/${day}(${dow})`;
}

function formatTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h > 12 ? '오후' : '오전'} ${h > 12 ? h - 12 : h}:${m}`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '마감됨';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}일 ${hours}시간 ${minutes}분`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

function setTime(d: Date, hours: number, minutes: number): Date {
  const result = new Date(d);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function describeDays(days: number[]): string {
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d])
    .join('·');
}

/**
 * 현재 시각(또는 기준 시각) 기준 다음 '출고일 후보'를 반환.
 * - 서울·내륙: 마감 전이면 해당 배송일, 마감 지났으면 다음 배송일.
 */
function getSeoulSchedule(now: Date, days: number[]): DeliveryInfo {
  const sortedDays = [...new Set(days)].sort((a, b) => a - b);
  if (sortedDays.length === 0) {
    // 방어: 비어있으면 월요일로 대체
    sortedDays.push(1);
  }

  // 오늘부터 14일 탐색
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 14; i++) {
    const candidate = addDays(today, i);
    if (!sortedDays.includes(candidate.getDay())) continue;

    const deadline = setTime(addDays(candidate, -1), 17, 0);
    if (now < deadline) {
      return buildInfo('seoul', now, deadline, candidate, candidate, sortedDays);
    }
    // 마감 지났으면 다음 후보 계속 탐색
  }

  // fallback: 14일 내에 못 찾으면 2주 뒤 첫 요일
  const fallback = addDays(today, 14);
  while (!sortedDays.includes(fallback.getDay())) {
    fallback.setDate(fallback.getDate() + 1);
  }
  const deadline = setTime(addDays(fallback, -1), 17, 0);
  return buildInfo('seoul', now, deadline, fallback, fallback, sortedDays);
}

/**
 * 제주: 매주 수요일 16시 마감 → 목요일 상차 → 금요일 도착
 */
function getJejuSchedule(now: Date): DeliveryInfo {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  const currentDay = base.getDay();
  const daysUntilWed = (3 - currentDay + 7) % 7;

  const thisWed = addDays(base, daysUntilWed);
  const deadline = setTime(thisWed, 16, 0);

  if (now < deadline) {
    const shipDate = addDays(thisWed, 1);
    const arrivalDate = addDays(thisWed, 2);
    return buildInfo('jeju', now, deadline, shipDate, arrivalDate, [4]);
  }

  const nextWed = addDays(thisWed, 7);
  const nextDeadline = setTime(nextWed, 16, 0);
  const shipDate = addDays(nextWed, 1);
  const arrivalDate = addDays(nextWed, 2);
  return buildInfo('jeju', now, nextDeadline, shipDate, arrivalDate, [4]);
}

function buildInfo(
  region: Region,
  now: Date,
  deadline: Date,
  shipDate: Date,
  arrivalDate: Date,
  deliveryDays: number[]
): DeliveryInfo {
  const remainingMs = deadline.getTime() - now.getTime();

  const scheduleDescription =
    region === 'jeju'
      ? '매주 수요일 오후 4시 마감 → 목요일 상차 → 금요일 도착'
      : `${describeDays(deliveryDays)} 출고, 전일 오후 5시 마감`;

  return {
    region,
    deadlineDate: deadline,
    deadlineLabel: `${formatDate(deadline)} ${formatTime(deadline)}`,
    shipDate,
    shipLabel: formatDate(shipDate),
    arrivalDate,
    arrivalLabel: formatDate(arrivalDate),
    remainingMs: Math.max(0, remainingMs),
    remainingLabel: formatRemaining(remainingMs),
    isPastDeadline: remainingMs <= 0,
    scheduleDescription,
    deliveryDays,
    isOverrideActive: false,
  };
}

/**
 * 매장의 배송 스케줄 조회.
 * - 서울·내륙: delivery_days 기준 (null 이면 [1,3,5] 기본)
 * - 제주: region='jeju' 고정 스케줄 (delivery_days 무시)
 * - deadline_override_until 가 현재시각보다 미래면 isPastDeadline=false + isOverrideActive=true
 */
export function getStoreDeliverySchedule(
  store: StoreScheduleInput,
  now?: Date
): DeliveryInfo {
  const currentTime = now || new Date();
  const normalizedDays = normalizeDeliveryDays(store.delivery_days);

  const baseInfo =
    store.region === 'jeju'
      ? getJejuSchedule(currentTime)
      : getSeoulSchedule(currentTime, normalizedDays ?? [1, 3, 5]);

  // 마감 연장 override 적용
  if (store.deadline_override_until) {
    const overrideDate = new Date(store.deadline_override_until);
    if (overrideDate.getTime() > currentTime.getTime()) {
      const remainingMs = overrideDate.getTime() - currentTime.getTime();
      return {
        ...baseInfo,
        deadlineDate: overrideDate,
        deadlineLabel: `${formatDate(overrideDate)} ${formatTime(overrideDate)} (연장)`,
        remainingMs,
        remainingLabel: formatRemaining(remainingMs),
        isPastDeadline: false,
        isOverrideActive: true,
      };
    }
  }

  return baseInfo;
}

/**
 * 하위호환 — region만으로 스케줄 조회 (delivery_days/override 없음).
 * 기존 코드 경로가 점진적으로 getStoreDeliverySchedule 로 옮겨질 때까지 유지.
 */
export function getDeliverySchedule(region: Region, now?: Date): DeliveryInfo {
  return getStoreDeliverySchedule({ region, delivery_days: null }, now);
}

/**
 * 주어진 주문의 마감이 지났는지 — store 기준으로 판정.
 * override 가 활성이면 항상 false.
 */
export function isPastDeadlineForStore(
  store: StoreScheduleInput,
  now?: Date
): boolean {
  const schedule = getStoreDeliverySchedule(store, now);
  return schedule.isPastDeadline;
}

/**
 * 특정 매장의 다음 N개 배송일을 반환 (분할 배송 UI 드롭다운용).
 * 이미 마감이 지난 배송일은 제외.
 */
export function getUpcomingDeliveryDates(
  store: StoreScheduleInput,
  count: number = 3,
  now?: Date
): Date[] {
  const currentTime = now || new Date();
  const result: Date[] = [];

  if (store.region === 'jeju') {
    // 제주는 분할 개념이 없지만, 방어적으로 다음 상차일만 반환
    const info = getJejuSchedule(currentTime);
    result.push(info.shipDate);
    return result;
  }

  const sortedDays = normalizeDeliveryDays(store.delivery_days) ?? [1, 3, 5];

  const today = new Date(currentTime);
  today.setHours(0, 0, 0, 0);

  // override 활성이면 오늘 기준 "가장 빠른 요일" 포함 가능
  const overrideActive =
    !!store.deadline_override_until &&
    new Date(store.deadline_override_until).getTime() > currentTime.getTime();

  for (let i = 0; i < 21 && result.length < count; i++) {
    const candidate = addDays(today, i);
    if (!sortedDays.includes(candidate.getDay())) continue;

    const deadline = setTime(addDays(candidate, -1), 17, 0);
    // 마감 지났으면 제외 (override 활성이면 허용)
    if (currentTime >= deadline && !overrideActive) continue;

    result.push(candidate);
  }

  return result;
}

/**
 * Date → YYYY-MM-DD (로컬 타임존 기준).
 * toISOString() 는 UTC 기준이라 KST 자정이 전날로 밀리는 문제가 있어 직접 포맷한다.
 */
export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type { DeliveryInfo, Region, StoreScheduleInput };
