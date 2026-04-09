import express from 'express';

import { AuthRequiredError } from './scraper/extractors.js';
import { PropertiesScraper } from './scraper/properties-scraper.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const scraper = new PropertiesScraper();

app.use(express.json());
app.use((req, _res, next) => {
  if (req.path === '/api/properties' || req.path === '/api/auth/relogin') {
    console.log(`[api] ${req.method} ${req.path} started`);
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/properties', async (req, res) => {
  const forceLogin = toBoolean(req.query.forceLogin);

  try {
    const response = await scraper.scrapeAll({ forceLogin });
    console.log(
      `[api] GET /api/properties completed: rows=${response.rows.length}, authRefreshed=${response.metadata.authRefreshed}`
    );
    res.json(response);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      res.status(401).json({
        message: 'Authentication is required. Complete Google login when prompted and retry.',
        detail: error.reason
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Unexpected scraper error.';
    res.status(500).json({ message });
  }
});

app.post('/api/auth/relogin', async (_req, res) => {
  try {
    await scraper.clearAuthState();
    const response = await scraper.scrapeAll({ forceLogin: true });
    console.log('[api] POST /api/auth/relogin completed');
    res.json({
      message: 'Authentication refreshed.',
      metadata: response.metadata
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Authentication refresh failed.';
    res.status(500).json({ message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

function toBoolean(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => toBoolean(entry));
  }
  return value === '1' || value === 'true' || value === true;
}
