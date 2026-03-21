@echo off
echo ===================================================
echo Starting CRM and Yandex Scraper Services
echo ===================================================

echo [1/5] Starting CRM (gravity-mvp)...
start cmd /k "title CRM - npm run dev && cd /d c:\Users\mixx\Documents\Github\CRM\gravity-mvp && npm run dev"

echo [2/5] Starting Scraper API...
start cmd /k "title Scraper API - npm run start:api && cd /d c:\Users\mixx\Documents\Github\CRM\yandex-fleet-scraper && npm run start:api"

echo [3/5] Starting Scraper Worker...
start cmd /k "title Scraper Worker - npm run start:worker && cd /d c:\Users\mixx\Documents\Github\CRM\yandex-fleet-scraper && npm run start:worker"

echo [4/6] Starting Max-web-scraper...
start cmd /k "title Max-web-scraper - node index.js && cd /d c:\Users\mixx\Documents\Github\CRM\max-web-scraper && node index.js"

echo [5/6] Starting TG Bot Backend...
start cmd /k "title TG Bot Backend - npm start && cd /d %~dp0tg-bot && npm start"

echo [6/6] Starting TG Bot Frontend...
start cmd /k "title TG Bot Frontend - npm run dev && cd /d %~dp0tg-bot\tg-bot-frontend && npm run dev"

echo All services started in separate windows!
