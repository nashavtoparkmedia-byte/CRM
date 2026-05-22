@echo off
REM PR-Н: еженедельный backfill всех каналов (TG MTProto + WA sibling-dedup + linked).
REM Регистрируется в Windows Task Scheduler — раз в неделю автоматически
REM подтягивает имена для всех новых placeholder-чатов, появившихся за неделю.
REM
REM Setup в Task Scheduler:
REM   schtasks /create /tn "CRM Backfill Names Weekly" /tr "D:\Github\CRM\gravity-mvp\scripts\backfill_all_weekly.bat" /sc weekly /d SUN /st 03:00
REM Запуск вручную:
REM   D:\Github\CRM\gravity-mvp\scripts\backfill_all_weekly.bat

cd /d "%~dp0\.."
echo [%date% %time%] Starting weekly backfill...

echo.
echo === 1/3 TG MTProto resolve (новые placeholder + потенциально удалённые users) ===
node scripts\backfill_tg_names.js

echo.
echo === 2/3 WA sibling-dedup (новые @lid дубликаты) ===
node scripts\backfill_null_names_from_sibling.js

echo.
echo === 3/3 Linked Driver/Contact (новые placeholder с привязкой) ===
node scripts\backfill_from_linked.js

echo.
echo [%date% %time%] Weekly backfill done.
