import test from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder, collectScreens, insertLooseScreen } from '../src/capture/figma-api.js';

// Helper: a screen-shaped FRAME node (tall enough, not ultra-wide) at a given position.
let uid = 0;
function screen(name, x, y, { width = 800, height = 900 } = {}) {
  return { id: `s${uid++}`, name, type: 'FRAME', absoluteBoundingBox: { x, y, width, height } };
}
function label(name, x, y) {
  // A short header/label chip — filtered out by the container-height gate elsewhere,
  // but also just not screen-shaped (height < 500), so collectScreens ignores it.
  return { id: `l${uid++}`, name, type: 'FRAME', absoluteBoundingBox: { x, y, width: 200, height: 60 } };
}
function rect(name, x, y, width, height) {
  // A plain decorative background shape — not a container type at all.
  return { id: `r${uid++}`, name, type: 'RECTANGLE', absoluteBoundingBox: { x, y, width, height } };
}
function section(name, x, y, children, { width, height } = {}) {
  const box = { x, y, width: width ?? 2000, height: height ?? 1000 };
  return { id: `sec${uid++}`, name, type: 'FRAME', absoluteBoundingBox: box, children };
}

test('readingOrder: single horizontal row sorts left to right (old single-strip case)', () => {
  const nodes = [screen('C', 1700, 0), screen('A', 0, 0), screen('B', 850, 0)];
  assert.deepEqual(readingOrder(nodes).map(n => n.name), ['A', 'B', 'C']);
});

test('readingOrder: multiple stacked rows read top-to-bottom, each row left-to-right', () => {
  // Mirrors the "Business Intelligence (WEB)" storyboard: several named
  // sections stacked vertically, each its own left-to-right strip, all
  // starting at roughly the same x. A plain x-sort would interleave these;
  // reading order must not.
  const nodes = [
    screen('Health-3', 1700, 0), screen('Health-1', 0, 0), screen('Health-2', 850, 0),
    screen('Bench-2', 850, 1200), screen('Bench-1', 0, 1200),
    screen('Reminders-1', 0, 2400), screen('Reminders-2', 850, 2400), screen('Reminders-3', 1700, 2400),
    screen('Credit-1', 0, 3600), screen('Credit-2', 850, 3600),
  ];
  const order = readingOrder(nodes).map(n => n.name);
  assert.deepEqual(order, [
    'Health-1', 'Health-2', 'Health-3',
    'Bench-1', 'Bench-2',
    'Reminders-1', 'Reminders-2', 'Reminders-3',
    'Credit-1', 'Credit-2',
  ]);
});

test('collectScreens: flat multi-row storyboard (screens are direct siblings, not wrapped in section frames)', () => {
  // Decorative row backgrounds and text labels sit alongside the screens as
  // plain siblings — they must be ignored, and must not perturb row grouping.
  const children = [
    rect('bg-health', -20, -20, 3000, 1000), label('Business Health', -20, -20),
    screen('Health-1', 0, 0), screen('Health-2', 850, 0), screen('Health-3', 1700, 0),
    rect('bg-bench', -20, 1180, 2000, 900), label('Benchmarking', -20, 1180),
    screen('Bench-1', 0, 1200), screen('Bench-2', 850, 1200),
    rect('bg-credit', -20, 2380, 2000, 900), label('Pre-Qual Line of Credit', -20, 2380),
    screen('Credit-1', 0, 2400), screen('Credit-2', 850, 2400), screen('Credit-3', 1700, 2400),
  ];
  const order = collectScreens(children).map(n => n.name);
  assert.deepEqual(order, ['Health-1', 'Health-2', 'Health-3', 'Bench-1', 'Bench-2', 'Credit-1', 'Credit-2', 'Credit-3']);
});

test('collectScreens: a screen is NEVER opened, however screen-shaped its own children are', () => {
  // Regression: real geometry from the 11_IAS Agent Studio storyboard. Every
  // one of these children passes isScreen (height >= 500, w/h <= 3) on its
  // own — the icon rail is 69px wide, the texture layer is WIDER than the
  // screen that contains it. Opening the screen to look at them is what
  // turned 17 real screens into 46 fragments in production.
  const rail = screen('Group 2147237080', 20, 30, { width: 69, height: 834 });
  const content = screen('Content', 100, 10, { width: 1360, height: 1279 });
  const texture = screen('texture', -150, -70, { width: 1736, height: 1046 });
  const real = section('01 - Default: Clients (View by Agents)', 0, 0, [rail, content, texture],
    { width: 1440, height: 900 });
  assert.deepEqual(collectScreens([real]).map(n => n.name), ['01 - Default: Clients (View by Agents)']);
});

test('collectScreens: several sibling desktop screens each stay whole and in order', () => {
  // The layout that actually exists in these storyboards: screens as siblings,
  // each one a frame full of screen-shaped panels. All must survive intact.
  const mk = (name, x) => section(name, x, 0,
    [screen('rail', x + 20, 30, { width: 69, height: 834 }), screen('Content', x + 100, 10, { width: 1360, height: 1279 })],
    { width: 1440, height: 900 });
  const order = collectScreens([mk('C', 3200), mk('A', 0), mk('B', 1600)]).map(n => n.name);
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('collectScreens: drops opacity < 0.9 and invisible screens, keeps ordering for the rest', () => {
  const retired = screen('Retired', 850, 0);
  retired.opacity = 0.3;
  const children = [screen('Keep-1', 0, 0), retired, screen('Keep-2', 1700, 0)];
  assert.deepEqual(collectScreens(children).map(n => n.name), ['Keep-1', 'Keep-2']);
});

test('insertLooseScreen: slots a loose screen into its own row without touching other rows', () => {
  const ordered = [
    screen('Health-1', 0, 0), screen('Health-2', 850, 0),
    screen('Bench-1', 0, 1200), screen('Bench-2', 1700, 1200), // gap left for the loose screen
    screen('Credit-1', 0, 2400),
  ];
  const loose = screen('Bench-1.5', 850, 1200); // same row as Benchmarking, between Bench-1 and Bench-2
  insertLooseScreen(ordered, loose);
  assert.deepEqual(ordered.map(n => n.name), ['Health-1', 'Health-2', 'Bench-1', 'Bench-1.5', 'Bench-2', 'Credit-1']);
});

test('insertLooseScreen: a screen matching no existing row becomes a new row in top-to-bottom position', () => {
  const ordered = [
    screen('Health-1', 0, 0),
    screen('Credit-1', 0, 2400),
  ];
  const loose = screen('NewRow-1', 0, 1200); // sits between the two existing rows, overlaps neither
  insertLooseScreen(ordered, loose);
  assert.deepEqual(ordered.map(n => n.name), ['Health-1', 'NewRow-1', 'Credit-1']);
});
