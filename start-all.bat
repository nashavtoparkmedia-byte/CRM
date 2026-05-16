@echo off
echo ===================================================
echo Starting CRM and all background services
echo ===================================================

echo [1/7] Starting CRM (gravity-mvp)...
start cmd /k "title CRM - npm run dev && cd /d %~dp0gravity-mvp && npm run dev"

echo [2/7] Starting Scraper API...
start cmd /k "title Scraper API - npm run start:api && cd /d %~dp0yandex-fleet-scraper && npm run start:api"

echo [3/7] Starting Scraper Worker...
start cmd /k "title Scraper Worker - npm run start:worker && cd /d %~dp0yandex-fleet-scraper && npm run start:worker"

echo [4/7] Starting Max-web-scraper...
start cmd /k "title Max-web-scraper - node index.js && cd /d %~dp0max-web-scraper && node index.js"

echo [5/7] Starting TG Bot Backend...
start cmd /k "title TG Bot Backend - npm start && cd /d %~dp0tg-bot && npm start"

echo [6/7] Starting TG Bot Frontend...
start cmd /k "title TG Bot Frontend - npm run dev && cd /d %~dp0tg-bot\tg-bot-frontend && npm run dev"

echo [7/7] Starting Avito Worker (collects responses from Avito messenger)...
start cmd /k "title Avito Worker - npm run dev && cd /d %~dp0avito-worker && npm run dev"

echo All services started in separate windows!
