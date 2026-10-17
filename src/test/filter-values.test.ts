import assert from 'assert';
import { spawnSync } from 'child_process';
import { describe, it } from 'node:test';
import { compareFilterDates, compareFilterNumbers, compileFilterDateComparison, compileFilterNumberComparison, parseFilterBoolean, parseFilterDate, parseFilterNumber } from '../filter-values';

function assertDate(input: string, expected: string) {
  const value = parseFilterDate(input);
  assert.notStrictEqual(value, undefined, input);
  assert.strictEqual(new Date(value!).toISOString(), expected, input);
}

describe('Typed filter values', () => {
  it('parses whole finite decimal/scientific values without treating blanks as zero', () => {
    const cases: Array<[string, number]> = [
      ['0', 0], [' +42 ', 42], ['-.5', -0.5], ['1.', 1],
      ['6.02e23', 6.02e23], ['-1.25E-3', -0.00125], ['.25e+2', 25],
      ['1,234', 1234], ['12,345,678.90', 12345678.9], ['1,234e2', 123400],
      ['1 234.50', 1234.5], ["1'234'567.5", 1234567.5],
      ['1\u00a0234', 1234], ['1\u202f234\u202f567', 1234567]
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(parseFilterNumber(input), expected, input);
    }
    assert.ok(Object.is(parseFilterNumber('-0'), -0));
    for (const input of [
      '', ' ', '\t\n', '0x10', '0b10', '0o10', '12kg', '12%', '$12', '1_000',
      '1e', '1e+', '--1', '+ 1', '1 23', '1234,567', '1,23', '1,234,56',
      '1,234 567', '1\u00a0234\u202f567', '1,234.5.6', 'Infinity', '-Infinity', 'NaN', '1e309', '1\n2', '1,5', '-.'
    ]) {
      assert.strictEqual(parseFilterNumber(input), undefined, input);
    }
  });

  it('compares large identifiers and decimal coefficients without binary rounding', () => {
    const pairs: Array<[string, string, -1 | 0 | 1]> = [
      ['9007199254740992', '9007199254740993', -1],
      ['-9007199254740993', '-9007199254740992', -1],
      ['9007199254740993', '9.007199254740993e15', 0],
      ['9,007,199,254,740,993', '9007199254740992', 1],
      ['0.10000000000000001', '0.1', 1],
      ['-0.10000000000000001', '-0.1', -1],
      ['0001.2000', '+12e-1', 0],
      ['.00012', '12e-5', 0],
      ['999.999999999999999999', '1000', -1],
      ['-999.999999999999999999', '-1000', 1],
      ['1.000000000000000000001e-300', '1e-300', 1],
      ['-0', '+0.000e999999999999999999999999999', 0],
      ['-1e-400', '0', -1], ['1e-400', '0', 1],
      ['1e-400', '1e-401', 1], ['-1e-400', '-1e-401', -1],
      ['1e-9007199254740991', '.1e-9007199254740991', 1],
      ['1e-9007199254740990', '10e-9007199254740991', 0],
      ['.01e-9007199254740991', '.001e-9007199254740991', 1]
    ];
    for (const [first, second, expected] of pairs) {
      assert.strictEqual(compareFilterNumbers(first, second), expected, `${first} vs ${second}`);
      const reverse = expected === 0 ? 0 : -expected;
      assert.strictEqual(compareFilterNumbers(second, first), reverse, `${second} vs ${first}`);
    }
  });

  it('compiles exact numeric thresholds and rejects invalid or nonfinite comparisons', () => {
    const compare = compileFilterNumberComparison('9,007,199,254,740,993');
    assert.ok(compare);
    assert.strictEqual(compare!('9007199254740992'), -1);
    assert.strictEqual(compare!('9007199254740993'), 0);
    assert.strictEqual(compare!('9007199254740994'), 1);
    assert.strictEqual(compare!('9007199254740993suffix'), undefined);
    for (const input of ['', ' ', '1,23', '1e309', 'Infinity', 'NaN', '0x10', '1e-9007199254740992']) {
      assert.strictEqual(compileFilterNumberComparison(input), undefined, input);
      assert.strictEqual(compareFilterNumbers(input, '1'), undefined, input);
      assert.strictEqual(compareFilterNumbers('1', input), undefined, input);
    }
    assert.strictEqual(parseFilterNumber('1e-9007199254740992'), 0, 'finite conversion and exact-comparison exponent limits are distinct');
  });

  it('recognizes only the complete existing boolean vocabulary, including false', () => {
    for (const input of ['true', 't', 'yes', 'y', 'on', '1', ' TRUE ', 'YeS']) {
      assert.strictEqual(parseFilterBoolean(input), true, input);
    }
    for (const input of ['false', 'f', 'no', 'n', 'off', '0', ' FALSE ', 'oFf']) {
      assert.strictEqual(parseFilterBoolean(input), false, input);
    }
    for (const input of ['', ' ', '01', '1.0', '2', '-1', 'truth', 'falsehood', 'yes please', 'null']) {
      assert.strictEqual(parseFilterBoolean(input), undefined, input);
    }
  });

  it('validates full year-first calendar dates, leap centuries and early years', () => {
    for (const input of ['2024-02-29', '2024/02/29', '2024/2/29']) {
      assertDate(input, '2024-02-29T00:00:00.000Z');
    }
    assertDate('2000-02-29', '2000-02-29T00:00:00.000Z');
    assertDate('0099-01-02', '0099-01-02T00:00:00.000Z');
    assertDate('0000-02-29', '0000-02-29T00:00:00.000Z');
    assertDate('9999-12-31', '9999-12-31T00:00:00.000Z');
    for (const input of [
      '2023-02-29', '1900-02-29', '2100-02-29', '2024-04-31', '2024-00-01',
      '2024-13-01', '2024-01-00', '2024-01-32', '2024-1/01', '-2024-01-01', '10000-01-01'
    ]) {
      assert.strictEqual(parseFilterDate(input), undefined, input);
    }
  });

  it('supports clear US/EU numeric dates and consistently uses month-first for ambiguous dates', () => {
    for (const input of ['12/31/2024', '31/12/2024', '12-31-2024', '31.12.2024']) {
      assertDate(input, '2024-12-31T00:00:00.000Z');
    }
    assertDate('13/02/2024', '2024-02-13T00:00:00.000Z');
    assertDate('03/04/2024', '2024-03-04T00:00:00.000Z');
    assertDate('11/12/2024', '2024-11-12T00:00:00.000Z');
    for (const input of ['13/14/2024', '02/29/2023', '29/02/2023', '04/31/2024', '00/12/2024', '31/00/2024', '1/2/24']) {
      assert.strictEqual(parseFilterDate(input), undefined, input);
    }
  });

  it('parses English full/abbreviated month names and checks ordinals and explicit weekdays', () => {
    for (const input of ['February 29, 2024', '29 Feb 2024', '29-Feb-2024', 'Feb. 29th, 2024', 'Thursday, 29 February 2024', 'Thu, 29 Feb 2024']) {
      assertDate(input, '2024-02-29T00:00:00.000Z');
    }
    for (const input of ['September 21st 2024', '21 Sept 2024']) {
      assertDate(input, '2024-09-21T00:00:00.000Z');
    }
    for (const input of ['February 30, 2024', 'Frobuary 1, 2024', 'January 11st, 2024', '29st February 2024', 'Friday, 29 February 2024', 'Jan--2--2024']) {
      assert.strictEqual(parseFilterDate(input), undefined, input);
    }
  });

  it('parses seconds and fractions with deterministic UTC for naive times', () => {
    assertDate('2024-02-29T23:59:59.9', '2024-02-29T23:59:59.900Z');
    assertDate('2024/02/29 1:02:03.12', '2024-02-29T01:02:03.120Z');
    assertDate('2024-02-29t01:02:03.123456789z', '2024-02-29T01:02:03.123Z');
    assertDate('2024-02-29 01:02', '2024-02-29T01:02:00.000Z');
    assertDate('2024-02-29 UTC', '2024-02-29T00:00:00.000Z');
    assertDate('2024-02-29 GMT', '2024-02-29T00:00:00.000Z');
  });

  it('normalizes explicit Z/UTC/GMT and signed offsets across day/year boundaries', () => {
    for (const zone of ['Z', ' UTC', ' GMT', '+00:00', '-0000']) {
      assertDate(`2024-01-01T13:05:07${zone}`, '2024-01-01T13:05:07.000Z');
    }
    for (const zone of ['+02:30', '+0230', ' GMT+0230', ' UTC+02:30']) {
      assertDate(`2024-01-01T00:30:45.123456${zone}`, '2023-12-31T22:00:45.123Z');
    }
    assertDate('2024-12-31 23:30-05:30', '2025-01-01T05:00:00.000Z');
    assertDate('2024-01-01 13:05+05', '2024-01-01T08:05:00.000Z');
    assertDate('2024-01-01 00:00+23:59', '2023-12-31T00:01:00.000Z');
  });

  it('handles 12-hour AM/PM including noon, midnight and fractional seconds', () => {
    assertDate('March 4, 2024 3:05:07.12 PM UTC', '2024-03-04T15:05:07.120Z');
    assertDate('4 Mar 2024 12am', '2024-03-04T00:00:00.000Z');
    assertDate('4 Mar 2024 12:00 PM', '2024-03-04T12:00:00.000Z');
    assertDate('03/04/2024 3 PM -0500', '2024-03-04T20:00:00.000Z');
    for (const input of ['2024-01-01 0:30 AM', '2024-01-01 13:30 PM', '2024-01-01 3:60 PM', '2024-01-01 AM']) {
      assert.strictEqual(parseFilterDate(input), undefined, input);
    }
  });

  it('rejects impossible clocks/offsets and bare, incomplete or partially matched values', () => {
    for (const input of [
      '', ' ', '0', '1', '2024', '20240101', '2024-02', '02/29', 'Feb 29', 'February 2024', '1:00 PM',
      '2024-01-01T', '2024-01-01TZ', '2024-01-01T24:00', '2024-01-01T23:60', '2024-01-01T23:59:60Z',
      '2024-01-01T12:1', '2024-01-01T12:00:1', '2024-01-01T12:00.5', '2024-01-01T12',
      '2024-01-01T12:00+24:00', '2024-01-01T12:00+23:60', '2024-01-01T12:00+5:30',
      '2024-01-01T12:00+050', '2024-01-01T12:00-2500', '2024-01-01T12:00 PST',
      '2024-01-01junk', '2024-01-01 12:00Z junk', 'January 1, 2024 extra',
      'prefix 2024-01-01', '2024-01-010', '12/31/20240', 'true', '1e3'
    ]) {
      assert.strictEqual(parseFilterDate(input), undefined, input);
    }
  });

  it('compares microsecond/nanosecond fractions exactly while preserving the millisecond parser API', () => {
    const base = '2024-01-01T00:00:00';
    const pairs: Array<[string, string, -1 | 0 | 1]> = [
      [`${base}.0001Z`, `${base}.0002Z`, -1],
      [`${base}.000100Z`, `${base}.0001Z`, 0],
      [`${base}.123456789Z`, `${base}.123456788Z`, 1],
      [`${base}.1230000000000000001Z`, `${base}.123Z`, 1],
      [`${base}.00001Z`, `${base}.0001Z`, -1],
      [`${base}.100000Z`, `${base}.1Z`, 0],
      [`${base}.000000Z`, '2024-01-01', 0]
    ];
    for (const [first, second, expected] of pairs) {
      assert.strictEqual(compareFilterDates(first, second), expected, `${first} vs ${second}`);
      assert.strictEqual(compareFilterDates(second, first), expected === 0 ? 0 : -expected);
    }
    assert.strictEqual(parseFilterDate(`${base}.0001Z`), Date.UTC(2024, 0, 1));
    assert.strictEqual(parseFilterDate(`${base}.0002Z`), Date.UTC(2024, 0, 1));
  });

  it('compiles exact date thresholds across zones/formats and rejects invalid comparisons', () => {
    const compare = compileFilterDateComparison('2024-01-01T00:00:00.0001Z');
    assert.ok(compare);
    for (const input of [
      '2024-01-01 05:30:00.000100+05:30',
      'January 1, 2024 12:00:00.0001 AM GMT',
      '31/12/2023 19:00:00.000100-0500'
    ]) {
      assert.strictEqual(compare!(input), 0, input);
    }
    assert.strictEqual(compare!('2024-01-01 05:30:00.0002+05:30'), 1);
    assert.strictEqual(compare!('2024-01-01 05:30:00.00009+05:30'), -1);
    for (const input of ['', '2024', '2023-02-29T00:00:00.0001Z', '2024-01-01T00:00:00.0001Z suffix']) {
      assert.strictEqual(compileFilterDateComparison(input), undefined, input);
      assert.strictEqual(compare!(input), undefined, input);
      assert.strictEqual(compareFilterDates(input, '2024-01-01'), undefined, input);
    }
  });

  it('orders positive fractional remainders correctly before and across the Unix epoch', () => {
    const first = '1969-12-31T23:59:59.9998Z';
    const second = '1969-12-31T23:59:59.9999Z';
    assert.strictEqual(parseFilterDate(first), -1);
    assert.strictEqual(parseFilterDate(second), -1);
    assert.strictEqual(compareFilterDates(first, second), -1);
    assert.strictEqual(compareFilterDates(second, '1969-12-31 18:59:59.999900-05:00'), 0);
    assert.strictEqual(compareFilterDates(second, '1970-01-01T00:00:00Z'), -1);
    assert.strictEqual(compareFilterDates('1969-12-31T23:59:59.0001Z', '1969-12-31T23:59:59.0002Z'), -1);
    assert.strictEqual(compareFilterDates('1969-12-31T23:59:59.9999Z', '1970-01-01T00:00:00.0001Z'), -1);
  });

  it('keeps naive/date-only results identical across extension-host time zones', () => {
    const script = "const {parseFilterDate}=require(process.argv[1]); process.stdout.write(JSON.stringify(['2024-03-10','2024-03-10 02:30','2024-11-03 01:30'].map(parseFilterDate)));";
    const expected = [Date.UTC(2024, 2, 10), Date.UTC(2024, 2, 10, 2, 30), Date.UTC(2024, 10, 3, 1, 30)];
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
      const child = spawnSync(process.execPath, ['-e', script, require.resolve('../filter-values')], {
        env: { ...process.env, TZ: timezone }, encoding: 'utf8'
      });
      assert.strictEqual(child.status, 0, child.stderr);
      assert.deepStrictEqual(JSON.parse(child.stdout), expected, timezone);
    }
  });
});
