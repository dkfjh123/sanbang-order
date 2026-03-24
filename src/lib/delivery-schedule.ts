type Region = 'seoul' | 'jeju';

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
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

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

/**
 * 서울·내륙: 월/수/금 출고, 전일 17시 마감
 *
 * 현재 시점 기준 다음 마감~출고 쌍을 구한다.
 */
function getSeoulSchedule(now: Date): DeliveryInfo {
  const shipDays = [1, 3, 5]; // 월, 수, 금

  let shipDate = new Date(now);
  shipDate.setHours(0, 0, 0, 0);

  for (let i = 0; i < 8; i++) {
    const candidate = addDays(shipDate, i);
    if (!shipDays.includes(candidate.getDay())) continue;

    const deadline = setTime(addDays(candidate, -1), 17, 0);
    if (now < deadline) {
      return buildInfo('seoul', now, deadline, candidate, candidate);
    }

    if (now >= deadline && candidate.getDay() === shipDays[shipDays.length - 1]) {
      continue;
    }
    if (now >= deadline) {
      continue;
    }
  }

  // fallback: 다음 주 월요일
  let nextMon = new Date(now);
  nextMon.setHours(0, 0, 0, 0);
  while (nextMon.getDay() !== 1) {
    nextMon = addDays(nextMon, 1);
  }
  const deadline = setTime(addDays(nextMon, -1), 17, 0);
  return buildInfo('seoul', now, deadline, nextMon, nextMon);
}

/**
 * 제주: 매주 수요일 오후 4시 마감 → 목요일 상차 → 금요일 도착
 */
function getJejuSchedule(now: Date): DeliveryInfo {
  let base = new Date(now);
  base.setHours(0, 0, 0, 0);

  // 이번 주 수요일 찾기
  const currentDay = base.getDay();
  let daysUntilWed = (3 - currentDay + 7) % 7;
  if (daysUntilWed === 0) daysUntilWed = 0; // 오늘이 수요일

  const thisWed = addDays(base, daysUntilWed);
  const deadline = setTime(thisWed, 16, 0);

  if (now < deadline) {
    const shipDate = addDays(thisWed, 1); // 목요일
    const arrivalDate = addDays(thisWed, 2); // 금요일
    return buildInfo('jeju', now, deadline, shipDate, arrivalDate);
  }

  // 마감 지남 → 다음 주 수요일
  const nextWed = addDays(thisWed, 7);
  const nextDeadline = setTime(nextWed, 16, 0);
  const shipDate = addDays(nextWed, 1);
  const arrivalDate = addDays(nextWed, 2);
  return buildInfo('jeju', now, nextDeadline, shipDate, arrivalDate);
}

function buildInfo(
  region: Region,
  now: Date,
  deadline: Date,
  shipDate: Date,
  arrivalDate: Date
): DeliveryInfo {
  const remainingMs = deadline.getTime() - now.getTime();
  const isPast = remainingMs <= 0;

  const scheduleDescription =
    region === 'jeju'
      ? '매주 수요일 오후 4시 마감 → 목요일 상차 → 금요일 도착'
      : '월·수·금 출고, 전일 오후 5시 마감';

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
    isPastDeadline: isPast,
    scheduleDescription,
  };
}

export function getDeliverySchedule(region: Region, now?: Date): DeliveryInfo {
  const currentTime = now || new Date();
  return region === 'jeju'
    ? getJejuSchedule(currentTime)
    : getSeoulSchedule(currentTime);
}

export type { DeliveryInfo, Region };
