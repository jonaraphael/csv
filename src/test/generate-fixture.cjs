#!/usr/bin/env node
// Generate a large, light‑hearted CSV fixture for testing.
// - Rows > CHUNK_SIZE (1000) → 1105 data rows
// - Two columns per type: string, boolean, date, integer, float, empty
// - Includes metadata rows before header
// - Sprinkles some empty cells in non-empty types

const fs = require('fs');
const path = require('path');

const ROWS = Number(process.env.ROW_COUNT || 1105);
// Write directly into the repo's test folder with the new name
const OUT = path.join(process.cwd(), 'src', 'test', 'super_example.csv');

// Wild/exotic animals for superhero theming
const animals = [
  'Tiger','Jaguar','Falcon','Eagle','Viper','Cobra','Panther','Cheetah','Lynx','Orca',
  'Manta','Komodo','Okapi','Ibex','Ocelot','Condor','Puma','Kudu','Narwhal','Gazelle',
  'Kestrel','Caracal','Serval','Hyena','Jackal','Civet','Tapir','Marmot','Otter','Heron'
];
// Short superhero codenames for variety
const codenames = [
  'Nova','Blaze','Zephyr','Titan','Aster','Vortex','Quasar','Rift','Halo','Echo',
  'Prism','Surge','Ember','Fang','Talon','Bolt','Drift','Flux','Nimbus','Raptor'
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

// Floats themed as power/speed values
function powerValue(i){
  const whole = (i % 100);
  const frac = (i % 100);
  return `${whole}.${pad2(frac)}`; // string with 2 decimals
}
function speedValue(i){
  const whole = 60 + ((i * 13) % 40);
  const frac = (i * 11) % 100;
  return `${whole}.${pad2(frac)}`; // string with 2 decimals
}

const header = [
  'Hero',       // string 1
  'Sidekick',   // string 2
  'CanFly',     // boolean 1
  'HasCape',    // boolean 2
  'FirstSeen',  // date 1
  'LastSeen',   // date 2
  'Rescues',    // integer 1
  'Disasters',  // integer 2
  'Power',      // float 1
  'Speed',      // float 2
  'Note',       // empty 1
  'Spare'       // empty 2
];

function csvEscape(s){
  if (s === null || s === undefined) return '';
  const str = String(s);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

const lines = [];

// Metadata rows (12 columns, pad with empties to keep width consistent)
lines.push(['meta','Title','Super Example CSV','', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));
lines.push(['meta','Author','The Wild Justice League','', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));
lines.push(['meta','About','Exotic animal superheroes and their feats','', '', '', '', '', '', '', '', ''].map(csvEscape).join(','));

// Header
lines.push(header.join(','));

for (let i = 1; i <= ROWS; i++){
  const animal = animals[i % animals.length];
  const code = codenames[i % codenames.length];
  const side = codenames[(i * 3) % codenames.length];

  const hero = `${code} ${animal}`; // string
  const sidekick = (i % 37 === 0) ? '' : `Kid ${side}`; // sometimes empty
  const canFly = (i % 2 === 0) ? 'true' : 'false';
  const hasCape = (i % 3 === 0) ? 'TRUE' : 'FALSE'; // case mix
  const firstSeen = date1(i);
  const lastSeen = date2(i);
  const rescues = (i % 41 === 0) ? '' : String((i * 13) % 1000); // sometimes empty
  const disasters = String(500 + i * 2);
  const power = powerValue(i);
  const speed = speedValue(i);
  const note = '';
  const spare = '';

  const row = [hero, sidekick, canFly, hasCape, firstSeen, lastSeen, rescues, disasters, power, speed, note, spare].map(csvEscape).join(',');
  lines.push(row);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${ROWS} data rows (+4 meta/header) to ${OUT}`);
