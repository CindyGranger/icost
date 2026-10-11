import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const key = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL || 'gpt-4o-mini';

const endpoint = (() => {
  const u = process.env.LLM_API_URL || 'https://api.openai.com/v1';
  return u.endsWith('/chat/completions') ? u : u.replace(/\/$/, '') + '/chat/completions';
})();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const categories = {
  '餐饮': ['正餐', '饮料', '咖啡', '零食', '外卖'],
  '购物': ['服饰', '美妆', '日用品', '数码', '其他'],
  '交通': ['公交地铁', '打车', '火车', '飞机'],
  '娱乐': ['电影', '游戏', '演出', '旅游'],
  '教育': ['书籍', '课程', '软件', 'AI服务'],
  '居住': ['房租', '水电', '生活服务'],
  '医疗': ['药品', '医疗服务'],
  '其他': ['待确认', '其他'],
};

const prompt = `你是谨慎的个人账单分类器。只输出 JSON 对象 {"results":[...]}，每项字段 index, category, subcategory, confidence(0到1), needsReview(boolean), reason(简短中文)。类别只能从这些值选：${JSON.stringify(categories)}。只能根据交易对方、商品、交易类型和备注判断；仅有平台名或订单号时不要猜具体商品类别，设为 category="其他",subcategory="待确认",confidence<=0.6,needsReview=true。转账、红包、退款和收入也设为待确认。 请把握审慎但不要过度保守：商户/商品/交易描述能支持一个常见类别时，给出有用的分类；confidence 用 0.0-1.0 表示把握，判断足够合理时通常可给 0.65-0.9。只有商品信息缺失且商户无法识别、或存在多个明显不同用途时才 needsReview=true。置信度低于 0.60 时 needsReview=true。不要因为缺少个人偏好而要求确认。不要输出 markdown。`;

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    const remote = String(req.socket.remoteAddress || '');
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote.endsWith('127.0.0.1');
    const sameHost = origin && origin !== 'null' && (() => {
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    })();
    const fileOrigin = origin === 'null' && loopback;
    const allowOrigin = fileOrigin ? 'null' : sameHost ? origin : null;

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', model, endpoint }));
    }

    if (req.url === '/api/classify' && req.method === 'OPTIONS') {
      if (!allowOrigin) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(204, {
        'access-control-allow-origin': allowOrigin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        'vary': 'Origin',
      });
      return res.end();
    }

    if (req.method === 'POST' && req.url === '/api/classify') {
      if (origin && !allowOrigin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Origin not allowed' }));
      }
      if (allowOrigin) {
        res.setHeader('access-control-allow-origin', allowOrigin);
        res.setHeader('vary', 'Origin');
      }
      if (!key) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Server model key is not configured' }));
      }

      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) {
          res.writeHead(413);
          return res.end('Too large');
        }
      }

      let input;
      try {
        input = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const tx = input.transactions;
      if (!Array.isArray(tx) || tx.length === 0 || tx.length > 30) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'transactions must contain 1 to 30 records' }));
      }

      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: JSON.stringify(tx) },
          ],
        }),
      });

      if (!upstream.ok) {
        const t = await upstream.text();
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `LLM upstream ${upstream.status}`, detail: t.slice(0, 500) }));
      }

      const data = await upstream.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { results: [] };
      }

      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(parsed));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method not allowed');
    }

    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = path.resolve(root, '.' + urlPath);

    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (urlPath === '/') filePath = path.join(root, 'index.html');
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }

    res.writeHead(200, {
      'content-type': mime[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': (['/', '/index.html', '/app.js', '/style.css', '/sw.js'].includes(urlPath) || urlPath.includes('?v='))
        ? 'no-store'
        : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error' }));
    console.error(e);
  }
});

server.listen(port, host, () => console.log(`Bill organizer listening on ${host}:${port}`));