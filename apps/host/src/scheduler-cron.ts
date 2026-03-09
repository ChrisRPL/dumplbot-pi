type CronFieldSpec = {
  max: number;
  min: number;
  normalizeValue?: (value: number) => number;
};

const MINUTE_SPEC: CronFieldSpec = { min: 0, max: 59 };
const HOUR_SPEC: CronFieldSpec = { min: 0, max: 23 };
const DAY_OF_MONTH_SPEC: CronFieldSpec = { min: 1, max: 31 };
const MONTH_SPEC: CronFieldSpec = { min: 1, max: 12 };
const DAY_OF_WEEK_SPEC: CronFieldSpec = {
  min: 0,
  max: 7,
  normalizeValue: (value) => (value === 7 ? 0 : value),
};

const normalizeCronValue = (value: number, spec: CronFieldSpec): number => {
  const normalizedValue = spec.normalizeValue ? spec.normalizeValue(value) : value;

  if (normalizedValue < spec.min || normalizedValue > spec.max) {
    throw new Error("job schedule is invalid");
  }

  return normalizedValue;
};

const parseCronFieldToken = (token: string, spec: CronFieldSpec): Set<number> | null => {
  const trimmedToken = token.trim();

  if (trimmedToken === "*") {
    return null;
  }

  const values = new Set<number>();
  const rangeSeparatorIndex = trimmedToken.indexOf("-");

  if (rangeSeparatorIndex >= 0) {
    const startToken = trimmedToken.slice(0, rangeSeparatorIndex).trim();
    const endToken = trimmedToken.slice(rangeSeparatorIndex + 1).trim();
    const start = Number.parseInt(startToken, 10);
    const end = Number.parseInt(endToken, 10);

    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new Error("job schedule is invalid");
    }

    for (let value = start; value <= end; value += 1) {
      values.add(normalizeCronValue(value, spec));
    }

    return values;
  }

  const parsedValue = Number.parseInt(trimmedToken, 10);

  if (!Number.isInteger(parsedValue)) {
    throw new Error("job schedule is invalid");
  }

  values.add(normalizeCronValue(parsedValue, spec));
  return values;
};

const parseCronField = (field: string, spec: CronFieldSpec): Set<number> | null => {
  const trimmedField = field.trim();

  if (!trimmedField) {
    throw new Error("job schedule is invalid");
  }

  const fieldTokens = trimmedField.split(",");
  let allowsAnyValue = false;
  const allowedValues = new Set<number>();

  for (const token of fieldTokens) {
    const parsedToken = parseCronFieldToken(token, spec);

    if (parsedToken === null) {
      allowsAnyValue = true;
      continue;
    }

    for (const value of parsedToken) {
      allowedValues.add(value);
    }
  }

  return allowsAnyValue ? null : allowedValues;
};

const valueMatchesField = (
  field: Set<number> | null,
  value: number,
): boolean => field === null || field.has(value);

const parseCronScheduleFields = (schedule: string): [
  Set<number> | null,
  Set<number> | null,
  Set<number> | null,
  Set<number> | null,
  Set<number> | null,
] => {
  const parts = schedule.trim().split(/\s+/u);

  if (parts.length !== 5) {
    throw new Error("job schedule is invalid");
  }

  const minuteField = parseCronField(parts[0] as string, MINUTE_SPEC);
  const hourField = parseCronField(parts[1] as string, HOUR_SPEC);
  const dayOfMonthField = parseCronField(parts[2] as string, DAY_OF_MONTH_SPEC);
  const monthField = parseCronField(parts[3] as string, MONTH_SPEC);
  const dayOfWeekField = parseCronField(parts[4] as string, DAY_OF_WEEK_SPEC);

  return [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField];
};

const DAY_OF_WEEK_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const NATURAL_LANGUAGE_DAY_ALIASES: Record<string, string> = {
  sun: "sun",
  sunday: "sun",
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tuesday: "tue",
  wed: "wed",
  wednesday: "wed",
  thu: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
};

const parseTimeOfDay = (value: string): { hour: number; minute: number } => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());

  if (!match) {
    throw new Error("job schedule is invalid");
  }

  const hour = Number.parseInt(match[1] as string, 10);
  const minute = Number.parseInt(match[2] as string, 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("job schedule is invalid");
  }

  return { hour, minute };
};

const normalizeNaturalLanguageScheduleInput = (scheduleInput: string): string | null => {
  const normalizedInput = scheduleInput.trim().toLowerCase().replace(/\s+/gu, " ");

  if (normalizedInput === "every hour") {
    return "hourly";
  }

  const dailyMatch = /^(?:daily|every day)(?: at)? (\d{1,2}:\d{2})$/u.exec(normalizedInput);

  if (dailyMatch) {
    return `daily ${dailyMatch[1]}`;
  }

  const weeklyMatch = /^(?:weekly|every) ([a-z]+)(?: at)? (\d{1,2}:\d{2})$/u.exec(normalizedInput);

  if (weeklyMatch) {
    const normalizedDay = NATURAL_LANGUAGE_DAY_ALIASES[weeklyMatch[1] as string];

    if (!normalizedDay) {
      return null;
    }

    return `weekly ${normalizedDay} ${weeklyMatch[2]}`;
  }

  return null;
};

export const normalizeScheduleInput = (scheduleInput: string): string => {
  const trimmedInput = scheduleInput.trim();
  const naturalLanguagePreset = normalizeNaturalLanguageScheduleInput(trimmedInput);
  const candidateInput = naturalLanguagePreset ?? trimmedInput;

  if (!candidateInput) {
    throw new Error("job schedule is invalid");
  }

  if (candidateInput === "hourly") {
    return "0 * * * *";
  }

  const dailyMatch = /^daily\s+(.+)$/u.exec(candidateInput);

  if (dailyMatch) {
    const { hour, minute } = parseTimeOfDay(dailyMatch[1] as string);
    return `${minute} ${hour} * * *`;
  }

  const weeklyMatch = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(.+)$/iu.exec(candidateInput);

  if (weeklyMatch) {
    const dayToken = (weeklyMatch[1] as string).toLowerCase();
    const { hour, minute } = parseTimeOfDay(weeklyMatch[2] as string);
    return `${minute} ${hour} * * ${DAY_OF_WEEK_ALIASES[dayToken]}`;
  }

  const normalizedCron = candidateInput.split(/\s+/u).join(" ");
  parseCronScheduleFields(normalizedCron);
  return normalizedCron;
};

export const matchesCronSchedule = (schedule: string, at: Date): boolean => {
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parseCronScheduleFields(schedule);

  return valueMatchesField(minuteField, at.getMinutes())
    && valueMatchesField(hourField, at.getHours())
    && valueMatchesField(dayOfMonthField, at.getDate())
    && valueMatchesField(monthField, at.getMonth() + 1)
    && valueMatchesField(dayOfWeekField, at.getDay());
};

export const getMinuteBucket = (at: Date): string => (
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
  + `T${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
);
