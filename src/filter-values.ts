export type FilterDataType = 'string' | 'number' | 'date' | 'boolean';

const decimalNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const groupedNumber = /^[+-]?\d{1,3}([, '\u00a0\u202f])\d{3}(?:\1\d{3})*(?:\.\d*)?(?:e[+-]?\d+)?$/i;

function numericText(value: string): string | undefined {
  const text = value.trim();
  return decimalNumber.test(text) || groupedNumber.test(text) ? text.replace(/[, '\u00a0\u202f]/g, '') : undefined;
}

/** Parse a complete finite decimal, optionally using consistent thousands groups. */
export function parseFilterNumber(value: string): number | undefined {
  const text = numericText(value);
  if (text === undefined) {
    return undefined;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

type NumberComparison = -1 | 0 | 1;
interface ComparableNumber {
  sign: NumberComparison;
  digits: string;
  exponent: number;
  shift: number;
}

function comparableNumber(value: string): ComparableNumber | undefined {
  const text = numericText(value);
  if (text === undefined || !Number.isFinite(Number(text))) {
    return undefined;
  }
  const [mantissa, exponentText] = text.toLowerCase().split('e');
  const [integer, fraction = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = (integer + fraction).replace(/^0+/, '');
  if (!digits) {
    return { sign: 0, digits: '', exponent: 0, shift: 0 };
  }
  const exponent = Number(exponentText || '0');
  if (!Number.isSafeInteger(exponent)) {
    return undefined;
  }
  return { sign: text.startsWith('-') ? -1 : 1, digits, exponent, shift: digits.length - fraction.length };
}

function compareNumbers(a: ComparableNumber, b: ComparableNumber): NumberComparison {
  if (a.sign !== b.sign) {
    return a.sign < b.sign ? -1 : 1;
  }
  if (a.sign === 0) {
    return 0;
  }
  const exponentDifference = a.exponent - b.exponent;
  const shiftDifference = a.shift - b.shift;
  // Do not add an input-length shift to an exponent at the safe-integer boundary.
  // Close exponents subtract exactly; distant exponents already determine order.
  const orderDifference = exponentDifference > Math.abs(shiftDifference) ? 1
    : exponentDifference < -Math.abs(shiftDifference) ? -1
      : exponentDifference + shiftDifference;
  if (orderDifference !== 0) {
    return (orderDifference < 0 ? -a.sign : a.sign) as NumberComparison;
  }
  for (let index = 0; index < Math.max(a.digits.length, b.digits.length); index++) {
    const first = index < a.digits.length ? a.digits.charCodeAt(index) : 48;
    const second = index < b.digits.length ? b.digits.charCodeAt(index) : 48;
    if (first !== second) {
      return (first < second ? -a.sign : a.sign) as NumberComparison;
    }
  }
  return 0;
}

/** Normalize the threshold once while retaining exact decimal comparison. */
export function compileFilterNumberComparison(query: string): ((cell: string) => NumberComparison | undefined) | undefined {
  const threshold = comparableNumber(query);
  if (!threshold) {
    return undefined;
  }
  return cell => {
    const value = comparableNumber(cell);
    return value ? compareNumbers(value, threshold) : undefined;
  };
}

export function compareFilterNumbers(a: string, b: string): NumberComparison | undefined {
  return compileFilterNumberComparison(b)?.(a);
}

const trueValues = new Set(['true', 't', 'yes', 'y', 'on', '1']);
const falseValues = new Set(['false', 'f', 'no', 'n', 'off', '0']);

export function parseFilterBoolean(value: string): boolean | undefined {
  const text = value.trim().toLowerCase();
  if (trueValues.has(text)) {
    return true;
  }
  if (falseValues.has(text)) {
    return false;
  }
  return undefined;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  tail: string;
  ordinal?: string;
}

interface TimeParts {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  remainder: string;
  offset: number;
}

const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function monthNumber(value: string): number {
  const name = value.toLowerCase().replace(/\.$/, '');
  return monthNames.findIndex(month => month === name || month.slice(0, 3) === name || (month === 'september' && name === 'sept')) + 1;
}

function parseDateParts(value: string): DateParts | undefined {
  let match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(.*)$/.exec(value);
  if (match) {
    return { year: Number(match[1]), month: Number(match[3]), day: Number(match[4]), tail: match[5] };
  }
  match = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(.*)$/.exec(value);
  if (match) {
    const first = Number(match[1]), second = Number(match[3]);
    // Prefer month/day when both are possible; a leading value above 12 is a day.
    const dayFirst = first > 12;
    return { year: Number(match[4]), month: dayFirst ? second : first, day: dayFirst ? first : second, tail: match[5] };
  }
  match = /^([a-z]{3,9}\.?)(?:\s+|-)(\d{1,2})(st|nd|rd|th)?(?:,\s*|\s+|-)(\d{4})(.*)$/i.exec(value);
  if (match) {
    return { year: Number(match[4]), month: monthNumber(match[1]), day: Number(match[2]), ordinal: match[3], tail: match[5] };
  }
  match = /^(\d{1,2})(st|nd|rd|th)?(?:\s+|-)([a-z]{3,9}\.?)(?:,\s*|\s+|-)(\d{4})(.*)$/i.exec(value);
  if (match) {
    return { year: Number(match[4]), month: monthNumber(match[3]), day: Number(match[1]), ordinal: match[2], tail: match[5] };
  }
  return undefined;
}

function parseOffset(value: string | undefined): number | undefined {
  if (!value || /^(?:z|utc|gmt)$/i.test(value)) {
    return 0;
  }
  const match = /^(?:utc|gmt)?([+-])(\d{2})(?::?(\d{2}))?$/i.exec(value);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[2]), minute = Number(match[3] || '0');
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return (match[1] === '-' ? -1 : 1) * (hour * 60 + minute);
}

function parseTimeParts(tail: string): TimeParts | undefined {
  const midnight = { hour: 0, minute: 0, second: 0, millisecond: 0, remainder: '', offset: 0 };
  if (!tail) {
    return midnight;
  }
  if (!/^(?:[tT]|\s)/.test(tail)) {
    return undefined;
  }
  const hasTimeSeparator = /^[tT]/.test(tail);
  const text = (hasTimeSeparator ? tail.slice(1) : tail).trim();
  if (!text) {
    return undefined;
  }
  if (!hasTimeSeparator && /^(?:z|utc|gmt)$/i.test(text)) {
    return midnight;
  }
  const match = /^(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?[ \t]*(am|pm)?[ \t]*(\S+)?$/i.exec(text);
  if (!match || (match[2] === undefined && match[5] === undefined)) {
    return undefined;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2] || '0'), second = Number(match[3] || '0');
  const meridiem = match[5]?.toLowerCase();
  if (minute > 59 || second > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) {
    return undefined;
  }
  if (meridiem) {
    hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
  }
  const offset = parseOffset(match[6]);
  if (offset === undefined) {
    return undefined;
  }
  const fraction = match[4] || '';
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const remainder = fraction.slice(3).replace(/0+$/, '');
  return { hour, minute, second, millisecond, remainder, offset };
}

function validCalendarDate({ year, month, day, ordinal }: DateParts): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) {
    return false;
  }
  if (ordinal) {
    const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] || 'th';
    if (suffix !== ordinal.toLowerCase()) {
      return false;
    }
  }
  return true;
}

interface ComparableDate {
  millisecond: number;
  remainder: string;
}

function comparableDate(value: string): ComparableDate | undefined {
  let text = value.trim();
  const prefix = /^(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?),?\s+/i.exec(text);
  const weekday = prefix ? weekdays.indexOf(prefix[1].slice(0, 3).toLowerCase()) : undefined;
  if (prefix) {
    text = text.slice(prefix[0].length);
  }
  const date = parseDateParts(text);
  if (!date || !validCalendarDate(date)) {
    return undefined;
  }
  const time = parseTimeParts(date.tail);
  if (!time) {
    return undefined;
  }
  // setUTCFullYear avoids Date.UTC's special interpretation of years 00 through 99.
  const result = new Date(0);
  result.setUTCFullYear(date.year, date.month - 1, date.day);
  if (weekday !== undefined && result.getUTCDay() !== weekday) {
    return undefined;
  }
  result.setUTCHours(time.hour, time.minute, time.second, time.millisecond);
  return { millisecond: result.getTime() - time.offset * 60000, remainder: time.remainder };
}

/** Parse explicit complete calendar formats; date-only and unzoned times use UTC. */
export function parseFilterDate(value: string): number | undefined {
  return comparableDate(value)?.millisecond;
}

/** Compare accepted timestamps without discarding microsecond/nanosecond digits. */
export function compileFilterDateComparison(query: string): ((cell: string) => NumberComparison | undefined) | undefined {
  const threshold = comparableDate(query);
  if (!threshold) {
    return undefined;
  }
  return cell => {
    const value = comparableDate(cell);
    if (!value) {
      return undefined;
    }
    if (value.millisecond !== threshold.millisecond) {
      return value.millisecond < threshold.millisecond ? -1 : 1;
    }
    // Remainders are nonnegative even before the Unix epoch. Compare their
    // decimal digits with implicit right zeros, using only the input's length.
    for (let index = 0; index < Math.max(value.remainder.length, threshold.remainder.length); index++) {
      const first = index < value.remainder.length ? value.remainder.charCodeAt(index) : 48;
      const second = index < threshold.remainder.length ? threshold.remainder.charCodeAt(index) : 48;
      if (first !== second) {
        return first < second ? -1 : 1;
      }
    }
    return 0;
  };
}

export function compareFilterDates(a: string, b: string): NumberComparison | undefined {
  return compileFilterDateComparison(b)?.(a);
}
