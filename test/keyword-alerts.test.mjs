import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeywords, matchKeywords, KEYWORD_LIMIT } from '../public/keyword-alerts.mjs';

test('keyword settings enforce count, length and minimum size and drop spacing duplicates', () => {
  assert.deepEqual(parseKeywords(' 제2공항, 제2 공항\n버스 준공영제,, '), { keywords: ['제2공항', '버스 준공영제'] });
  assert.match(parseKeywords('가').error, /2자 이상/);
  assert.match(parseKeywords('가'.repeat(41)).error, /40자 이내/);
  assert.match(parseKeywords(Array.from({ length: KEYWORD_LIMIT + 1 }, (_, i) => '키워드' + i).join(',')).error, /20개까지/);
  assert.deepEqual(parseKeywords(''), { keywords: [] });
});

test('matching ignores spacing and letter case but not different words', () => {
  const keywords = ['제2공항', 'CCTV', '애월'];
  assert.deepEqual(matchKeywords('제2 공항 건설과 cctv 설치 예산', keywords), ['제2공항', 'CCTV']);
  assert.deepEqual(matchKeywords('공항 이용객 통계', keywords), []);
});
