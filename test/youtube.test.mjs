import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaUrl, resolveYouTube } from '../src/youtube.mjs';
test('resolved media rejects internal hosts, non-HTTPS and credentials before DNS', async () => {
  for (const url of ['http://a.googlevideo.com/x','https://127.0.0.1/x','https://googlevideo.com.evil.test/x',
    'https://user:pass@a.googlevideo.com/x','https://a.googlevideo.com:8443/x'])
    await assert.rejects(validateMediaUrl(url), /Unapproved/);
});
test('resolver requires an approved concrete YouTube ID', async () => {
  await assert.rejects(resolveYouTube({}, {page_url:'https://www.youtube.com/@jejucouncillive',approved:true}), /Approved/);
});
