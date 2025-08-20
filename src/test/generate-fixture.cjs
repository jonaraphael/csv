#!/usr/bin/env node
// Generate a large, light‑hearted CSV fixture for testing.
// - Rows > CHUNK_SIZE (1000) → 1105 data rows
// - Two columns per type: string, boolean, date, integer, float, empty
// - Includes metadata rows before header
// - Sprinkles some empty cells in non-empty types

const fs = require('fs');
const path = require('path');

const ROWS = Number(process.env.ROW_COUNT || 1105);
const OUT = path.join(process.cwd(), 'tests', 'animal-shenanigans.csv');

const animals = [
  'Otter','Fox','Bear','Lynx','Raccoon','Panda','Ferret','Capybara','Wombat','Badger',
  'Koala','Red Panda','Kiwi','Yak','Bison','Marten','Moose','Skunk','Hedgehog','Possum',
  'Quokka','Seal','Walrus','Gibbon','Llama','Alpaca','Caracal','Hyena','Jackal','Civet'
];
const humanish = [
  'Alex','Riley','Sam','Morgan','Jordan','Taylor','Casey','Jamie','Avery','Reese',
  'Quinn','Skyler','Cameron','Harper','Rowan','Sage','Parker','Drew','Remy','Elliot'
];

const pad2 = n => String(n).padStart(2, '0');

function date1(i){
  const y = 2010 + (i % 10);
  const m = (i % 12) + 1;
  const d = (i % 28) + 1;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function date2(i){
  const y = 2024;
  const m = ((i * 7) % 12) + 1;
  const d = ((i * 11) % 28) + 1;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function snackBudget(i){
  const dollars = (i % 50);
  const cents = (i % 100);
  return `${dollars}.${pad2(cents)}`; // string with 2 decimals
}
function agilityScore(i){
  const whole = 50 + ((i * 13) % 50);
  const frac = (i * 17) % 100;
  return `${whole}.${pad2(frac)}`; // string with 2 decimals
}

const header = [
  'AnimalName',           // string 1
  'SidekickName',         // string 2
  'IsMischievous',        // boolean 1
  'IsNocturnal',          // boolean 2
  'BirthdateISO',         // date 1
  'LastVetVisit',         // date 2
  'FavoriteNumber',       // integer 1
  'StepsToday',           // integer 2
  'SnackBudget',          // float 1
  'AgilityScore',         // float 2
  'OptionalNote',         // empty 1 (all empty to force "empty" type)
  'SpareColumn'           // empty 2 (all empty to force "empty" type)
];

function csvEscape(s){
  if (s === null || s === undefined) return '';
  const str = String(s);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

const lines = [];

// Metadata rows (12 columns, pad with empties to keep width consistent)
lines.push(['meta','Title','Animal Shenanigans CSV','', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));
lines.push(['meta','Author','The CSV Menagerie','', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));
lines.push(['meta','About','Fictional animals with quirky traits','', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));

// Header
lines.push(header.join(','));

for (let i = 1; i <= ROWS; i++){
  const animal = animals[i % animals.length];
  const who = humanish[i % humanish.length];
  const side = humanish[(i * 3) % humanish.length];

  const name1 = `${who} the ${animal}`; // string
  const name2 = (i % 37 === 0) ? '' : `Buddy ${side}`; // sometimes empty
  const bool1 = (i % 2 === 0) ? 'true' : 'false';
  const bool2 = (i % 3 === 0) ? 'TRUE' : 'FALSE'; // case mix
  const d1 = date1(i);
  const d2 = date2(i);
  const int1 = (i % 41 === 0) ? '' : String((i * 13) % 1000); // sometimes empty
  const int2 = String(1000 + i * 3);
  const f1 = snackBudget(i);
  const f2 = agilityScore(i);
  const empty1 = '';
  const empty2 = '';

  const row = [name1, name2, bool1, bool2, d1, d2, int1, int2, f1, f2, empty1, empty2].map(csvEscape).join(',');
  lines.push(row);
}

fs.mkdirSync(path.join(process.cwd(), 'tests'), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${ROWS} data rows (+4 meta/header) to ${OUT}`);
