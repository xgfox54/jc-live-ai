import { HttpError } from './validate.mjs';

// page: the copy the minutes page reads (web/lib/model.mjs minutesPage); the .json and .md downloads keep the whole document.
export function minutesRequest(registry, req, res, url, prefix, page = value => value) {
  if (!url.pathname.startsWith(prefix)) return false;
  if (req.method !== 'GET') throw new HttpError(405, 'Read-only endpoint');
  const suffix = url.pathname.slice(prefix.length);
  let result;
  if (!suffix || suffix === '/') result = { items: registry.minuteList() };
  else {
    const match = suffix.match(/^\/([a-f0-9]{64})(?:\.(md|json))?$/);
    if (!match) throw new HttpError(404, '회의록을 찾지 못했습니다.');
    result = registry.minutes(match[1]);
    if (!result) throw new HttpError(404, '회의록을 찾지 못했습니다.');
    if (match[2]) {
      res.setHeader('Content-Disposition', 'attachment; filename="minutes-' + match[1].slice(0, 12) + '.' + match[2] + '"');
      res.setHeader('Content-Type', match[2] === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8');
      res.end(match[2] === 'md' ? result.markdown : JSON.stringify(result, null, 2)); return true;
    }
    result = page(result);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result)); return true;
}
