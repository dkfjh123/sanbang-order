/**
 * 매장별 배송 스케줄 계산.
 *
 * - 서울·내륙: 매장별 delivery_days 배열에 지정된 요일마다 출고, 전일 17시 마감
 * - 제주(주1회): 매주 수요일 16시 마감 → 목요일 상차 → 금요일 도착 (region 고정)
 * - 제주(주2회 주간): 위 기존편 + 일 17시 마감 → 월 상차 → 화 도착.
 *   격주로 켜지며, 켜짐 여부·기준주는 jeju-delivery-config.ts 의 JEJU_BIWEEKLY 로 제어.
 * - deadline_override_until 이 현재 시각 이후라면 마감 판정에서 false (연장 중)
 *
 * delivery_days 가 null 이면 region 기본값 사용:
 *   - seoul: [1, 3, 5] (월·수·금)
 *   - jeju : [4] (목요일 상차 — 내부적으로만 사용. 실제 스케줄은 getJejuSchedule)
 */

import { JEJU_BIWEEKLY } from './jeju-delivery-config';

type Region = 'seoul' | 'jeju';

interface StoreScheduleInput {
  region: Region;
  delivery_days: number[] | null;
  deadline_override_until?: string | null;
}

interface JejuWeekDelivery {
  kind: 'mon' | 'thu';            // 월 상차(격주 추가편) / 목 상차(기존편)
  deadlineLabel: string;
  shipLabel: string;
  arrivalLabel: string;
  isPast: boolean;                // 이 배송편 마감이 지났는지
  isNext: boolean;                // 현재 '다음 배송'으로 선택된 편인지
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
  jejuWeeklyCount?: 1 | 2;        // 제주: 이번 배송 주간의 배송 횟수 (격주 2회 주간이면 2)
  jejuWeekDeliveries?: JejuWeekDelivery[]; // 제주 2회 주간의 두 배송편 (UI 표시용)
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

/** 주어진 날짜가 속한 주의 월요일 00:00 (일요일은 직전 월요일로). */
function getMonday(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();
  r.setDate(r.getDate() + ((day === 0 ? -6 : 1) - day));
  return r;
}

/**
 * 해당 주(월요일 기준)가 제주 '주2회 배송 주간'인지.
 * - JEJU_BIWEEKLY.enabled=false 면 항상 false (전 제주 주1회).
 * - anchorMonday 이전 주차면 false.
 * - anchorMonday 부터 격주(짝수 주차)마다 true.
 */
function isJejuTwoXWeek(weekMonday: Date): boolean {
  if (!JEJU_BIWEEKLY.enabled) return false;
  const anchor = getMonday(new Date(`${JEJU_BIWEEKLY.anchorMonday}T00:00:00`));
  if (weekMonday.getTime() < anchor.getTime()) return false;
  const weeks = Math.round(
    (weekMonday.getTime() - anchor.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  return weeks % 2 === 0;
}

interface JejuCandidate {
  kind: 'mon' | 'thu';
  deadline: Date;
  shipDate: Date;
  arrivalDate: Date;
}

/**
 * now 기준 이번 주~3주 뒤까지의 제주 배송편 후보를 마감 빠른 순으로 반환.
 * - 모든 주: 목 상차편 (수 16시 마감 → 목 상차 → 금 도착)
 * - 주2회 주간: 위 + 월 상차편 (일 17시 마감 → 월 상차 → 화 도착)
 */
function buildJejuCandidates(now: Date): JejuCandidate[] {
  const wkMon = getMonday(now);
  const candidates: JejuCandidate[] = [];
  for (let k = 0; k <= 3; k++) {
    const M = addDays(wkMon, 7 * k);
    if (isJejuTwoXWeek(M)) {
      candidates.push({
        kind: 'mon',
        deadline: setTime(addDays(M, -1), 17, 0), // 일요일 17시
        shipDate: M,                              // 월요일 상차
        arrivalDate: addDays(M, 1),               // 화요일 도착
      });
    }
    candidates.push({
      kind: 'thu',
      deadline: setTime(addDays(M, 2), 16, 0),    // 수요일 16시
      shipDate: addDays(M, 3),                    // 목요일 상차
      arrivalDate: addDays(M, 4),                 // 금요일 도착
    });
  }
  candidates.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
  return candidates;
}

/**
 * 제주 배송 스케줄.
 * - 다음 배송 = 아직 마감 전인 가장 가까운 배송편(자동 선택).
 * - 선택된 배송편의 상차일이 속한 주가 2회 주간이면 jejuWeeklyCount=2 +
 *   그 주의 두 배송편(jejuWeekDeliveries)을 표시용으로 함께 채운다.
 */
function getJejuSchedule(now: Date): DeliveryInfo {
  const candidates = buildJejuCandidates(now);
  const next =
    candidates.find((c) => now < c.deadline) ?? candidates[candidates.length - 1];

  const info = buildInfo('jeju', now, next.deadline, next.shipDate, next.arrivalDate, [4]);

  const weekMon = getMonday(next.shipDate);
  const twoX = isJejuTwoXWeek(weekMon);
  info.jejuWeeklyCount = twoX ? 2 : 1;
  info.scheduleDescription = twoX
    ? '이번 배송 주간은 주2회 — 일 17시 마감→월 상차→화 도착 · 수 16시 마감→목 상차→금 도착'
    : '매주 수요일 오후 4시 마감 → 목요일 상차 → 금요일 도착';

  if (twoX) {
    info.jejuWeekDeliveries = candidates
      .filter((c) => getMonday(c.shipDate).getTime() === weekMon.getTime())
      .map((c) => ({
        kind: c.kind,
        deadlineLabel: `${formatDate(c.deadline)} ${formatTime(c.deadline)}`,
        shipLabel: formatDate(c.shipDate),
        arrivalLabel: formatDate(c.arrivalDate),
        isPast: now >= c.deadline,
        isNext: c.shipDate.getTime() === next.shipDate.getTime(),
      }));
  }

  return info;
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

interface JejuTwoXNotice {
  monDeadlineLabel: string;   // 월 상차분 마감 (예: 6/7(일) 오후 5:00)
  monShipLabel: string;       // 월 상차일
  monArrivalLabel: string;    // 화 도착일
  daysUntilDeadline: number;  // 마감까지 남은 일수(내림)
  deadlineDate: Date;
}

/**
 * 다가오는 '주2회 주간'의 사전 안내.
 * - 다음 월 상차편(격주 추가편)의 마감이 미래이고, 그 직전 주(월요일)부터인 경우에만 반환.
 *   즉 주2회 주간이 시작되기 한 주 전부터 마감 직전까지 노출 → 그 외엔 null.
 * - JEJU_BIWEEKLY.enabled=false 면 항상 null.
 */
export function getJejuTwoXAdvanceNotice(now?: Date): JejuTwoXNotice | null {
  const currentTime = now || new Date();
  if (!JEJU_BIWEEKLY.enabled) return null;

  const mon = buildJejuCandidates(currentTime).find(
    (c) => c.kind === 'mon' && currentTime < c.deadline
  );
  if (!mon) return null;

  // 월 상차편이 속한 주의 직전 주 월요일부터 노출 (그 전엔 너무 이르므로 숨김)
  const startShow = addDays(getMonday(mon.shipDate), -7);
  if (currentTime.getTime() < startShow.getTime()) return null;

  const ms = mon.deadline.getTime() - currentTime.getTime();
  return {
    monDeadlineLabel: `${formatDate(mon.deadline)} ${formatTime(mon.deadline)}`,
    monShipLabel: formatDate(mon.shipDate),
    monArrivalLabel: formatDate(mon.arrivalDate),
    daysUntilDeadline: Math.floor(ms / (24 * 60 * 60 * 1000)),
    deadlineDate: mon.deadline,
  };
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
 * 특정 주문의 ship_date 기준으로 마감이 지났는지 판정.
 * 동일옥처럼 주문별 배송일을 고르는 매장은 "다음 배송일"이 아니라
 * 해당 주문의 배송일 전일 마감을 기준으로 수정 가능 여부를 판단해야 한다.
 */
export function isPastDeadlineForShipDate(
  store: StoreScheduleInput,
  shipDate: string | null | undefined,
  now?: Date
): boolean {
  if (!shipDate) return isPastDeadlineForStore(store, now);

  const currentTime = now || new Date();
  if (store.deadline_override_until) {
    const overrideDate = new Date(store.deadline_override_until);
    if (overrideDate.getTime() > currentTime.getTime()) return false;
  }

  const ship = new Date(`${shipDate}T00:00:00`);
  if (Number.isNaN(ship.getTime())) return isPastDeadlineForStore(store, now);

  const deadline = addDays(ship, -1);
  if (store.region === 'jeju') {
    // 월요일 상차(격주 추가편)는 전날(일) 17시, 목요일 상차(기존편)는 전날(수) 16시.
    if (ship.getDay() === 1) deadline.setHours(17, 0, 0, 0);
    else deadline.setHours(16, 0, 0, 0);
  } else {
    deadline.setHours(17, 0, 0, 0);
  }

  return currentTime >= deadline;
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
    // 제주는 점주 선택형이 아니므로 발주 UI에서 쓰이진 않지만, 방어적으로
    // 다가오는 제주 배송 상차일(주2회 주간이면 월·목 모두)을 마감 전인 것만 반환.
    return buildJejuCandidates(currentTime)
      .filter((c) => currentTime < c.deadline)
      .slice(0, count)
      .map((c) => c.shipDate);
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

export { isJejuTwoXWeek, getMonday };
export type { DeliveryInfo, Region, StoreScheduleInput, JejuWeekDelivery, JejuTwoXNotice };
