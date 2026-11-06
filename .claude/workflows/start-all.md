---
description: Запустить все сервисы (CRM, Scraper API, Scraper Worker, MAX, TG Bot)
---

// turbo-all
1. Запустить CRM (gravity-mvp)
```bash
cd gravity-mvp && npm run dev
```

2. Запустить Scraper API
```bash
cd yandex-fleet-scraper && npm run start:api
```

3. Запустить Scraper Worker
```bash
cd yandex-fleet-scraper && npm run start:worker
```

4. Запустить Max-web-scraper
```bash
cd max-web-scraper && node index.js
```

5. Запустить TG Bot Backend
```bash
cd tg-bot && npm start
```

6. Запустить TG Bot Frontend
```bash
cd tg-bot/tg-bot-frontend && npm run dev
```
