/**
 * Schedule helpers: parse user input, compute the next run time (local
 * timezone), and produce human-readable descriptions.
 */
import type { Schedule, ScheduleType } from "./types.js";

const DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const DAY_NAMES = ["воскресеньям", "понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам"];
const ENGLISH_DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function parseTime(s: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return { h, m: min };
}

/** Parse the free-text detail for a given schedule type into a Schedule. */
export function parseScheduleDetail(
  type: ScheduleType,
  text: string,
): { schedule?: Schedule; error?: string } {
  const t = text.trim();
  switch (type) {
    case "once": {
      const ms = Date.parse(t.replace(" ", "T"));
      if (Number.isNaN(ms)) return { error: "Укажите дату и время в формате ГГГГ-ММ-ДД ЧЧ:ММ." };
      if (ms <= Date.now()) return { error: "Указанное время уже прошло." };
      return { schedule: { type, at: new Date(ms).toISOString() } };
    }
    case "daily": {
      const time = parseTime(t);
      if (!time) return { error: "Укажите время в формате ЧЧ:ММ, например 09:30." };
      return { schedule: { type, time: fmt(time) } };
    }
    case "weekly": {
      const [dayStr, timeStr] = t.split(/\s+/);
      const day = (dayStr ?? "").slice(0, 3).toLowerCase();
      const weekday = DAYS.indexOf(day.slice(0, 2)) >= 0 ? DAYS.indexOf(day.slice(0, 2)) : ENGLISH_DAYS[day];
      const time = parseTime(timeStr ?? "");
      if (weekday === undefined || weekday < 0 || !time) return { error: "Укажите день недели и время, например пн 09:30." };
      return { schedule: { type, weekday, time: fmt(time) } };
    }
    case "monthly": {
      const [dayStr, timeStr] = t.split(/\s+/);
      const day = Number(dayStr);
      const time = parseTime(timeStr ?? "");
      if (!Number.isInteger(day) || day < 1 || day > 31 || !time) {
        return { error: "Укажите число месяца и время, например 15 09:30." };
      }
      return { schedule: { type, day, time: fmt(time) } };
    }
    case "interval": {
      const mins = Number(t);
      if (!Number.isInteger(mins) || mins < 1) return { error: "Укажите количество минут, например 90." };
      return { schedule: { type, everyMinutes: mins } };
    }
    default:
      return { error: "Неизвестный тип расписания." };
  }
}

/** Next run time in epoch ms, or undefined if the schedule will never fire. */
export function computeNextRun(schedule: Schedule, from = Date.now()): number | undefined {
  switch (schedule.type) {
    case "once": {
      const ms = schedule.at ? Date.parse(schedule.at) : NaN;
      return !Number.isNaN(ms) && ms > from ? ms : undefined;
    }
    case "interval":
      return from + (schedule.everyMinutes ?? 60) * 60_000;
    case "daily":
      return nextDaily(schedule, from);
    case "weekly":
      return nextWeekly(schedule, from);
    case "monthly":
      return nextMonthly(schedule, from);
    default:
      return undefined;
  }
}

function nextDaily(s: Schedule, from: number): number {
  const { h, m } = splitTime(s.time);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function nextWeekly(s: Schedule, from: number): number {
  const { h, m } = splitTime(s.time);
  const target = s.weekday ?? 1;
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getDay() === target && d.getTime() > from) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return d.getTime();
}

function nextMonthly(s: Schedule, from: number): number {
  const { h, m } = splitTime(s.time);
  const day = s.day ?? 1;
  const base = new Date(from);
  for (let i = 0; i < 13; i++) {
    const year = base.getFullYear();
    const month = base.getMonth() + i;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const d = new Date(year, month, Math.min(day, lastDay), h, m, 0, 0);
    if (d.getTime() > from) return d.getTime();
  }
  return from + 31 * 86_400_000;
}

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case "once":
      return `один раз: ${s.at ? new Date(s.at).toLocaleString("ru-RU") : "время не указано"}`;
    case "daily":
      return `ежедневно в ${s.time}`;
    case "weekly":
      return `еженедельно по ${DAY_NAMES[s.weekday ?? 1]} в ${s.time}`;
    case "monthly":
      return `ежемесячно, ${s.day}-го числа в ${s.time}`;
    case "interval":
      return `каждые ${s.everyMinutes} мин.`;
    default:
      return "неизвестно";
  }
}

function fmt(t: { h: number; m: number }): string {
  return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
}

function splitTime(time?: string): { h: number; m: number } {
  const p = parseTime(time ?? "09:00");
  return p ?? { h: 9, m: 0 };
}
