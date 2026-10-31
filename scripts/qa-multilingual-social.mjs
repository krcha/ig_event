import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { AgendaRenderError, getAgendaFonts, measureAgendaText } from '../lib/social/agenda-layout.ts';
import { posterFont, buildPosterLayout } from '../lib/social/poster-layout.ts';
import { buildDailyStoriesPayload } from '../lib/social/daily-stories.ts';
import { buildPosterArtwork } from '../lib/social/poster-renderer.ts';
import { prepareDailyAgendaScene, renderMaterialPosterStill } from '../lib/social/material-scene.ts';
import { drawFrame } from '../lib/social/material-motion.mjs';

const date = '2026-10-20';
const cjkTitle = '\u602a\u8ac7 / Kwaidan';
const mixedTitle = '\u602a\u8ac7 / \u0402\u0409\u040a\u040b\u040f \u017d\u0111\u010d\u0107\u0161';
const fonts = getAgendaFonts();
assert.equal(posterFont(fonts.title, 'Original club programme'), fonts.title, 'existing Latin design font stays exact');
const serbian = 'Srpska \u017d\u0111\u010d\u0107\u0161 / \u0402\u0409\u040a\u040b\u040f';
const serbianFont = posterFont(fonts.title, serbian);
assert.equal(serbianFont, fonts.fallbackTitle, 'existing Serbian Cyrillic fallback stays exact');
assert.equal(posterFont(fonts.title, cjkTitle).fullName, 'IPAGothic');
assert.equal(posterFont(fonts.title, mixedTitle).fullName, 'Unifont');
assert.equal(posterFont(fonts.body, mixedTitle, true).fullName, 'Unifont');
assert.throws(() => posterFont(fonts.title, String.fromCodePoint(0x10ffff)), AgendaRenderError, 'unsupported identities still fail instead of disappearing');
for (const title of [cjkTitle, mixedTitle]) {
  const font = posterFont(fonts.title, title);
  assert.ok(font.layout(title).glyphs.every(glyph => glyph.id !== 0), 'complete identities have real glyphs');
  assert.ok(measureAgendaText(font, title, 52).width > 0);
}

const events = [
  { _id: 'j573f3pmvkw783xaxfncrqrbmd8gn0hm', title: 'Language Caf\u00e9', venue: 'KC Grad', time: '18:00' },
  { _id: 'j575x6zb9yvc9xnaqy22ktwhh58gbwv3', title: '\u0427\u0438\u0442\u0430\u043b\u0430\u0447\u043a\u0430 \u0440\u0430\u0434\u0438\u043e\u043d\u0438\u0446\u0430 \u0437\u0430 \u0434\u0435\u0446\u0443 \u201e\u0408\u0435\u0441\u0435\u043d \u043d\u0430 \u043d\u0430\u0448\u0435\u043c \u0441\u0435\u043b\u0443', venue: 'Etnografski muzej u Beogradu', time: '18:00' },
  { _id: 'j570xbzth5ycm18e3r14yqzmes8gm2z1', title: '\u0421\u043f\u043e\u0440\u0442\u0438\u0432\u043d\u0430\u044f \u043c\u0430\u0444\u0438\u044f', venue: 'NEW MONEY Belgrade', time: '18:15' },
  { _id: 'j572s12as0dv901ydkvctcz37n8gm2rm', title: cjkTitle, venue: 'Novi Bioskop Zvezda', time: '20:00' },
  { _id: 'j571jwrp9hqgfbn1wmygq8eb0h8fpyp0', title: 'Coraline (2009)', venue: 'Bife Ventil', time: '18:30' },
].map(event => ({ ...event, date, timeStatus: 'confirmed', timeSource: 'caption' }));
const context = { publishedCaptions: ['Coraline (2009)'], previouslyPublishedEventIds: [events[4]._id], excludedEventIds: [] };
const payload = buildDailyStoriesPayload({ ...context, events, publishDate: date, publicOrigin: 'https://eventzeka.com' });
assert.equal(payload.selectedCount, 4);
assert.deepEqual(new Set(payload.frames[0].eventIds), new Set(events.slice(0, 4).map(event => event._id)), 'history-aware selection preserves all four real incident identities');
assert.ok(!payload.frames[0].eventIds.includes(events[4]._id));
const selected = payload.frames[0].eventIds.map(id => events.find(event => event._id === id));
for (const format of ['feed', 'story', 'reel']) {
  const programme = format === 'feed' ? [selected[0], selected[1], selected[3]] : selected;
  const artwork = buildPosterArtwork({ date, events: programme, position: 0, format, publishDate: date });
  const cjkRow = artwork.rows.find(row => row.title.lines.join(' ') === cjkTitle);
  assert.ok(cjkRow, 'Japanese title remains complete in ' + format);
  assert.equal(cjkRow.title.font.fullName, 'IPAGothic');
  assert.ok(artwork.bounds.every(bound => bound.x >= 48 && bound.x + bound.width <= (format === 'feed' ? 1018 : 938) && bound.y >= 0 && bound.y + bound.height <= artwork.height), 'all identities stay inside the ' + format + ' canvas');
  assert.ok(!artwork.svg.includes('<text'), 'native render uses outlined glyphs rather than browser font substitution');
}
const mixedLayout = buildPosterLayout([{ title: mixedTitle, venue: serbian, time: '20:00' }], { date, position: 0, format: 'story', publishDate: date });
assert.equal(mixedLayout.rows[0].title.font.fullName, 'Unifont');
for (const format of ['story', 'reel']) {
  const { scene, assets, variant } = await prepareDailyAgendaScene({ date, events: selected, position: 0, format, publishDate: date });
  const canvas = createCanvas(1080, 1920);
  drawFrame(canvas.getContext('2d'), scene, assets, 6, variant);
  const info = await sharp(canvas.encodeSync('png')).metadata();
  assert.deepEqual([info.width, info.height], [1080, 1920], 'native ' + format + ' rasterizes multilingual outlined layers');
}
const still = await renderMaterialPosterStill({ date, events: [selected[0], selected[1], selected[3]], position: 0, format: 'feed', publishDate: date });
const stillInfo = await sharp(still).metadata();
assert.deepEqual([stillInfo.width, stillInfo.height, stillInfo.format], [1080, 1350, 'jpeg']);
console.log('PASS: real history-aware Japanese title, Serbian/Cyrillic font compatibility, mixed script, unsupported identity guard, feed/Story/Reel outlined and native rendering.');
