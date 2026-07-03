# CRM Project вЂ” Codex Instructions

## Project Overview
Internal CRM for managing drivers and analytics (NashAvtoParkMedia).

**Stack:** TypeScript + JavaScript, Node.js, Prisma ORM
**OS:** Windows (РІР°Р¶РЅРѕ РґР»СЏ РєРѕРјР°РЅРґ)

---

## Architecture вЂ” 4 РјРѕРґСѓР»СЏ + 2 СЃРµСЂРІРёСЃР°

| РњРѕРґСѓР»СЊ | РџР°РїРєР° | Р—Р°РїСѓСЃРє |
|--------|-------|--------|
| CRM Frontend/Backend | `./gravity-mvp` | `npm run dev` |
| Scraper API | `./yandex-fleet-scraper` | `npm run start:api` |
| Scraper Worker | `./yandex-fleet-scraper` | `npm run start:worker` |
| MAX Web Scraper | `./max-web-scraper` | `node index.js` |
| TG Bot Backend | `./tg-bot` | `npm start` |
| TG Bot Frontend | `./tg-bot/tg-bot-frontend` | `npm run dev` |

Р”Р»СЏ Р·Р°РїСѓСЃРєР° РІСЃРµРіРѕ СЃСЂР°Р·Сѓ: `start-all.bat` РІ РєРѕСЂРЅРµ РїСЂРѕРµРєС‚Р°.

### РљРѕРјР°РЅРґР° "Р—Р°РїСѓСЃС‚Рё РїСЂРѕРµРєС‚ РЎР Рњ"
РџСЂРё СЌС‚РѕР№ С„СЂР°Р·Рµ Р·Р°РїСѓСЃРєР°С‚СЊ 4 С„РѕРЅРѕРІС‹С… РїСЂРѕС†РµСЃСЃР° РїРѕСЃР»РµРґРѕРІР°С‚РµР»СЊРЅРѕ:

| РўРµСЂРјРёРЅР°Р» | РџР°РїРєР° | РљРѕРјР°РЅРґР° |
|----------|-------|---------|
| 1 вЂ” CRM | `./gravity-mvp` | `npm run dev` |
| 2 вЂ” Scraper API | `./yandex-fleet-scraper` | `npm run start:api` |
| 3 вЂ” Scraper Worker | `./yandex-fleet-scraper` | `npm run start:worker` |
| 4 вЂ” MAX Scraper | `./max-web-scraper` | `node index.js` |

РџРѕСЂС‚С‹: CRM в†’ 3002, Scraper API в†’ СЃРјРѕС‚СЂРµС‚СЊ РІ .env yandex-fleet-scraper.

---

## Rules for Codex

### Р‘РµР·РѕРїР°СЃРЅС‹Рµ РєРѕРјР°РЅРґС‹ (РІС‹РїРѕР»РЅСЏС‚СЊ Р±РµР· РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ)
- `npm run dev`, `npm start`, `npm run build`, `npm run lint`
- `prisma generate`, `prisma migrate dev`
- `node scripts/*.js` (РІСЂРµРјРµРЅРЅС‹Рµ СЃРєСЂРёРїС‚С‹)

### РќРРљРћР“Р”Рђ РЅРµ РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ
- `taskkill`, `wmic`, `Stop-Process` вЂ” РґР»СЏ РѕСЃС‚Р°РЅРѕРІРєРё РїСЂРѕС†РµСЃСЃРѕРІ РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ Ctrl+C
- Chained РєРѕРјР°РЅРґС‹: `cmd1 && cmd2` вЂ” РІС‹РїРѕР»РЅСЏС‚СЊ РїРѕСЃР»РµРґРѕРІР°С‚РµР»СЊРЅРѕ, РїРѕ РѕРґРЅРѕР№
- Inline eval: `node -e "..."` вЂ” СЃРѕР·РґР°РІР°С‚СЊ РІСЂРµРјРµРЅРЅС‹Р№ С„Р°Р№Р» Рё Р·Р°РїСѓСЃРєР°С‚СЊ РµРіРѕ
- Shell СЂРµРґРёСЂРµРєС‚С‹: `echo >> file`, `command > file.txt` вЂ” РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ Р·Р°РїРёСЃСЊ С‡РµСЂРµР· РєРѕРґ
- `cat`, `grep`, `tail`, `ls`, `dir` вЂ” С‡РёС‚Р°С‚СЊ С„Р°Р№Р»С‹ РЅР°РїСЂСЏРјСѓСЋ С‡РµСЂРµР· РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹

### РџСЂРµРґРїРѕС‡С‚РёС‚РµР»СЊРЅС‹Р№ РїР°С‚С‚РµСЂРЅ РґР»СЏ СЃРєСЂРёРїС‚РѕРІ
```js
// РџР›РћРҐРћ: node -e "require('./db').query()"
// РҐРћР РћРЁРћ: СЃРѕР·РґР°С‚СЊ scripts/temp_query.js, Р·Р°РїСѓСЃС‚РёС‚СЊ node scripts/temp_query.js
```

### РЎРµРєСЂРµС‚С‹
РќРёРєРѕРіРґР° РЅРµ РїРµСЂРµРґР°РІР°С‚СЊ `DATABASE_URL`, РїР°СЂРѕР»Рё Рё С‚РѕРєРµРЅС‹ РІ Р°СЂРіСѓРјРµРЅС‚Р°С… РєРѕРјР°РЅРґС‹.
Р’СЃС‘ С‡РµСЂРµР· `.env` С„Р°Р№Р»С‹.

---

## Р‘Р°Р·Р° Р·РЅР°РЅРёР№ Р°РіРµРЅС‚РѕРІ
РџРµСЂРµРґ СЂР°Р±РѕС‚РѕР№ СЃ РёРЅС‚РµРіСЂР°С†РёСЏРјРё С‡РёС‚Р°С‚СЊ `.Codex/knowledge/`.
РџСЂРёРјРµСЂ: `.Codex/knowledge/max_chat_merging.md` вЂ” Р»РѕРіРёРєР° Anti-Ghost С‡Р°С‚РѕРІ MAX Web Scraper.

---

## РўРµСЃС‚РёСЂРѕРІР°РЅРёРµ

- **UI/UX РёР·РјРµРЅРµРЅРёСЏ** вЂ” РїСЂРѕРІРµСЂСЏС‚СЊ РІРёР·СѓР°Р»СЊРЅРѕ РІ Р±СЂР°СѓР·РµСЂРµ
- **Backend/Logic** вЂ” Р·Р°РїСѓСЃРєР°С‚СЊ Р»РѕРєР°Р»СЊРЅС‹Рµ С‚РµСЃС‚-СЃРєСЂРёРїС‚С‹
- **РњРµР»РєРёРµ РїСЂР°РІРєРё** (С‚РµРєСЃС‚, СЃС‚РёР»Рё) вЂ” РІРёР·СѓР°Р»СЊРЅРѕР№ РїСЂРѕРІРµСЂРєРё РґРѕСЃС‚Р°С‚РѕС‡РЅРѕ
- РќРµ Р·РІР°С‚СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ РґР»СЏ РїСЂРѕРІРµСЂРєРё РїРѕРєР° РЅРµ РїСЂРѕРІРµСЂРёР» СЃР°Рј

---

## Р РµР¶РёРј "Full Auto"
РљРѕРіРґР° РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РїРёС€РµС‚ **"Full Auto"**:
1. РЎСЂР°Р·Сѓ РІ СЂРµР°Р»РёР·Р°С†РёСЋ, Р±РµР· Р»РёС€РЅРёС… РІРѕРїСЂРѕСЃРѕРІ
2. Р’СЃРµ СЂСѓС‚РёРЅРЅС‹Рµ РєРѕРјР°РЅРґС‹ вЂ” Р±РµР· РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ
3. РџРµСЂРµРґ С„РёРЅР°Р»СЊРЅС‹Рј СЂРµРїРѕСЂС‚РѕРј вЂ” СЃР°РјРѕСЃС‚РѕСЏС‚РµР»СЊРЅРѕ РїСЂРѕРІРµСЂРёС‚СЊ СЂРµР·СѓР»СЊС‚Р°С‚
4. РљСЂР°С‚РєРёР№ РёС‚РѕРі: С‡С‚Рѕ СЃРґРµР»Р°РЅРѕ Рё С‡С‚Рѕ РїСЂРѕРІРµСЂРµРЅРѕ

---

## Design System вЂ” Telegram UI Principle

**Р­С‚Р°Р»РѕРЅ:** Telegram. Р’РµСЃСЊ РёРЅС‚РµСЂС„РµР№СЃ CRM РїСЂРѕРµРєС‚РёСЂСѓРµС‚СЃСЏ РїРѕ Р°РЅР°Р»РѕРіРёРё СЃ Telegram.

### РћСЃРЅРѕРІРЅРѕРµ РїСЂР°РІРёР»Рѕ
РџРµСЂРµРґ СЃРѕР·РґР°РЅРёРµРј Р»СЋР±РѕРіРѕ РЅРѕРІРѕРіРѕ РёРЅС‚РµСЂС„РµР№СЃР°:
1. РћРїСЂРµРґРµР»РёС‚СЊ, РєР°Рє Р°РЅР°Р»РѕРіРёС‡РЅС‹Р№ СЃС†РµРЅР°СЂРёР№ СЂРµР°Р»РёР·РѕРІР°РЅ РІ Telegram
2. РџРѕРІС‚РѕСЂРёС‚СЊ СЃС‚СЂСѓРєС‚СѓСЂСѓ, РїРѕРІРµРґРµРЅРёРµ Рё СѓСЂРѕРІРµРЅСЊ СЃР»РѕР¶РЅРѕСЃС‚Рё

### РџСЂРёРјРµРЅСЏРµС‚СЃСЏ РєРѕ РІСЃРµРјСѓ
РћРєРЅР°, СЂР°Р·РґРµР»С‹, РјРѕРґР°Р»РєРё, РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ, СЃРїРёСЃРєРё, РєР°СЂС‚РѕС‡РєРё, С„РѕСЂРјС‹, РјРµРЅСЋ, СѓРІРµРґРѕРјР»РµРЅРёСЏ, РЅР°СЃС‚СЂРѕР№РєРё, СЃС‚Р°С‚СѓСЃС‹, РѕС€РёР±РєРё, Р·Р°РіСЂСѓР·РєР°, С„РёР»СЊС‚СЂС‹, РґРµР№СЃС‚РІРёСЏ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ.

### РџСЂРёРЅС†РёРїС‹
- РњР°РєСЃРёРјР°Р»СЊРЅРѕ РїСЂРѕСЃС‚РѕР№ Рё РїСЂРµРґСЃРєР°Р·СѓРµРјС‹Р№ РёРЅС‚РµСЂС„РµР№СЃ
- Р‘РµР· РїРµСЂРµРіСЂСѓР·РєРё, Р»РёС€РЅРёС… СЌР»РµРјРµРЅС‚РѕРІ Рё РґРµРєРѕСЂР°С‚РёРІРЅРѕРіРѕ РґРёР·Р°Р№РЅР°
- Р‘РµР· СЃР»РѕР¶РЅС‹С… СЃС†РµРЅР°СЂРёРµРІ

### Р—Р°РїСЂРµС‰РµРЅРѕ
- РР·РѕР±СЂРµС‚Р°С‚СЊ РЅРѕРІС‹Р№ UI СЃС‚РёР»СЊ
- Р”РѕР±Р°РІР»СЏС‚СЊ Р»РёС€РЅРёРµ С€Р°РіРё
- РЈСЃР»РѕР¶РЅСЏС‚СЊ РґРµР№СЃС‚РІРёСЏ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ
- Р”РµР»Р°С‚СЊ РёРЅС‚РµСЂС„РµР№СЃ СЃР»РѕР¶РЅРµРµ, С‡РµРј РІ Telegram
- РСЃРїРѕР»СЊР·РѕРІР°С‚СЊ РЅРµСЃС‚Р°РЅРґР°СЂС‚РЅС‹Рµ РїР°С‚С‚РµСЂРЅС‹ Р±РµР· СЏРІРЅРѕР№ РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё

### РџСЂР°РІРёР»Рѕ РїСЂРѕРІРµСЂРєРё
РџСЂРё РЅРѕРІРѕРј СЃС†РµРЅР°СЂРёРё в†’ "РљР°Рє СЌС‚Рѕ СЃРґРµР»Р°РЅРѕ РІ Telegram?"
Р•СЃР»Рё РІ Telegram РЅРµС‚ Р°РЅР°Р»РѕРіР° в†’ РјР°РєСЃРёРјР°Р»СЊРЅРѕ РїСЂРѕСЃС‚РѕР№ РІР°СЂРёР°РЅС‚, РєРѕС‚РѕСЂС‹Р№ РІС‹РіР»СЏРґРµР» Р±С‹ РµСЃС‚РµСЃС‚РІРµРЅРЅРѕ РІРЅСѓС‚СЂРё Telegram.

---

### CSS Design Tokens (Flat / Telegram-style)

```css
/* Р¦РІРµС‚Р° вЂ” Chat & Messaging palette */
--primary:          #2AABEE;   /* Telegram blue */
--primary-dark:     #1E96D4;
--on-primary:       #FFFFFF;
--accent:           #059669;   /* online / success green */
--background:       #FFFFFF;
--surface:          #F1F5FD;   /* С„РѕРЅ РєР°СЂС‚РѕС‡РµРє, sidebar */
--foreground:       #0F172A;   /* РѕСЃРЅРѕРІРЅРѕР№ С‚РµРєСЃС‚ */
--muted:            #64748B;   /* РІС‚РѕСЂРѕСЃС‚РµРїРµРЅРЅС‹Р№ С‚РµРєСЃС‚, meta */
--border:           #E4ECFC;
--destructive:      #DC2626;
--on-destructive:   #FFFFFF;

/* Flat вЂ” Р±РµР· С‚РµРЅРµР№ Рё РіСЂР°РґРёРµРЅС‚РѕРІ */
--shadow:           none;
--elevation:        0;
--gradient:         none;

/* Р¤РѕСЂРјР° */
--radius-sm:        6px;       /* input, badge */
--radius-md:        12px;      /* card, modal */
--radius-bubble:    16px;      /* chat bubble */
--radius-pill:      999px;     /* Р°РІР°С‚Р°СЂ, tag */

/* РўРёРїРѕРіСЂР°С„РёРєР° вЂ” Inter (system-first) */
--font-family:      'Inter', system-ui, -apple-system, sans-serif;
--font-size-xs:     12px;      /* meta, timestamp */
--font-size-sm:     13px;      /* caption, secondary */
--font-size-base:   15px;      /* body, list item */
--font-size-md:     17px;      /* subheading */
--font-size-lg:     20px;      /* section title */
--font-weight-normal:   400;
--font-weight-medium:   500;
--font-weight-semibold: 600;
--font-weight-bold:     700;
--line-height-tight:    1.3;
--line-height-base:     1.5;
--letter-spacing-tight: -0.3px;

/* Spacing вЂ” 4-point grid */
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-5:  20px;
--space-6:  24px;
--space-8:  32px;
--space-12: 48px;

/* Touch targets */
--touch-target-min: 44px;
--list-item-height: 56px;      /* СЃС‚СЂРѕРєР° СЃРїРёСЃРєР° вЂ” РєР°Рє РІ Telegram */
--topbar-height:    56px;
--input-height:     44px;

/* РђРЅРёРјР°С†РёРё вЂ” Р±С‹СЃС‚СЂС‹Рµ, РЅРµРЅР°РІСЏР·С‡РёРІС‹Рµ */
--duration-fast:    150ms;
--duration-base:    200ms;
--easing:           ease;
```

### Tailwind config (gravity-mvp)

```js
// tailwind.config вЂ” СЂР°СЃС€РёСЂРµРЅРёРµ РґР»СЏ Telegram-СЃС‚РёР»СЏ
fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
colors: {
  primary:     '#2AABEE',
  'primary-dark': '#1E96D4',
  accent:      '#059669',
  surface:     '#F1F5FD',
  muted:       '#64748B',
  border:      '#E4ECFC',
},
borderRadius: {
  sm: '6px', md: '12px', bubble: '16px', pill: '9999px',
},
boxShadow: { none: 'none' },
```

### РљРѕРјРїРѕРЅРµРЅС‚С‹ вЂ” РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ РїСЂР°РІРёР»Р°

**РЎРїРёСЃРѕРє (list row)**
- Р’С‹СЃРѕС‚Р° СЃС‚СЂРѕРєРё: 56px
- РђРІР°С‚Р°СЂ СЃР»РµРІР° 40Г—40px (border-radius: pill)
- РћСЃРЅРѕРІРЅРѕР№ С‚РµРєСЃС‚: 15px/500, С†РІРµС‚ foreground
- РњРµС‚Р° / РІСЂРµРјСЏ: 12px/400, С†РІРµС‚ muted, РІС‹СЂРѕРІРЅРµРЅРѕ СЃРїСЂР°РІР°
- Hover: `bg-surface` (Р±РµР· outline, Р±РµР· С‚РµРЅРё)
- РќРµС‚ РґРµРєРѕСЂР°С‚РёРІРЅС‹С… РёРєРѕРЅРѕРє "СЃС‚СЂРµР»РѕС‡РєР° РІРїСЂР°РІРѕ"

**РњРѕРґР°Р»СЊРЅРѕРµ РѕРєРЅРѕ**
- border-radius: 12px, padding: 24px
- Р—Р°РіРѕР»РѕРІРѕРє: 17px/600
- РљРЅРѕРїРєРё: bottom sheet РёР»Рё inline РІ С„СѓС‚РµСЂРµ
- Overlay: `rgba(0,0,0,0.4)`
- РќРµС‚ РєСЂРµСЃС‚РёРєР° Г—, РµСЃР»Рё РµСЃС‚СЊ РєРЅРѕРїРєР° "РћС‚РјРµРЅР°"

**РљРЅРѕРїРєРё**
- Primary: bg-primary, text-white, height 44px, radius 8px, font 15px/600
- Secondary / Ghost: border 1px border-border, bg transparent
- Destructive: bg-destructive, text-white
- РќРµС‚ РіСЂР°РґРёРµРЅС‚РѕРІ, РЅРµС‚ С‚РµРЅРµР№ РЅР° РєРЅРѕРїРєР°С…

**Input / С„РѕСЂРјР°**
- height: 44px, border: 1px solid border, radius 8px
- Focus: border-primary (С‚РѕР»СЊРєРѕ С†РІРµС‚, РЅРёРєР°РєРѕРіРѕ box-shadow glow)
- Placeholder: С†РІРµС‚ muted
- Label СЃРІРµСЂС…Сѓ, 13px/500

**Р§Р°С‚ (messages)**
- РџСѓР·С‹СЂСЊ РІС…РѕРґСЏС‰РµРіРѕ: bg-surface, radius 16px (РєСЂРѕРјРµ РЅРёР¶РЅРµРіРѕ Р»РµРІРѕРіРѕ вЂ” 4px)
- РџСѓР·С‹СЂСЊ РёСЃС…РѕРґСЏС‰РµРіРѕ: bg-primary, text-white, radius 16px (РєСЂРѕРјРµ РЅРёР¶РЅРµРіРѕ РїСЂР°РІРѕРіРѕ вЂ” 4px)
- Р’СЂРµРјСЏ РІ РїСѓР·С‹СЂРµ: 11px, opacity 0.7
- Sticky input СЃРЅРёР·Сѓ: height 44px + padding
- Typing indicator: 3 С‚РѕС‡РєРё, Р°РЅРёРјР°С†РёСЏ pulse 600ms

**РџСѓСЃС‚С‹Рµ СЃРѕСЃС‚РѕСЏРЅРёСЏ (empty state)**
- РРєРѕРЅРєР° РёР»Рё РёР»Р»СЋСЃС‚СЂР°С†РёСЏ (РїСЂРѕСЃС‚Р°СЏ, outline)
- Р—Р°РіРѕР»РѕРІРѕРє: 17px/600
- РџРѕРґРїРёСЃСЊ: 14px/400, muted
- CTA-РєРЅРѕРїРєР° РѕРїС†РёРѕРЅР°Р»СЊРЅР°

**Р—Р°РіСЂСѓР·РєР°**
- Skeleton СЃ `animate-pulse`, С†РІРµС‚ `bg-surface`
- РќРёРєРѕРіРґР° РЅРµ РѕСЃС‚Р°РІР»СЏС‚СЊ РїСѓСЃС‚РѕР№ СЌРєСЂР°РЅ Р±РµР· РёРЅРґРёРєР°С‚РѕСЂР°

**РЈРІРµРґРѕРјР»РµРЅРёСЏ / Toast**
- РЎРЅРёР·Сѓ РїРѕ С†РµРЅС‚СЂСѓ РёР»Рё СЃРЅРёР·Сѓ СЃРїСЂР°РІР°
- Р‘РµР· Р·Р°РіРѕР»РѕРІРєР°: РѕРґРЅР° СЃС‚СЂРѕРєР° С‚РµРєСЃС‚Р°
- Auto-dismiss 3 СЃРµРє
- РќРµС‚ РёРєРѕРЅРѕРє РїСЂРµРґСѓРїСЂРµР¶РґРµРЅРёСЏ вЂ” С‚РѕР»СЊРєРѕ РґР»СЏ РєСЂРёС‚РёС‡РµСЃРєРёС… РѕС€РёР±РѕРє

### РђРЅС‚Рё-РїР°С‚С‚РµСЂРЅС‹ (Р·Р°РїСЂРµС‰РµРЅРѕ РІ РІС‘СЂСЃС‚РєРµ)

| Р—Р°РїСЂРµС‰РµРЅРѕ | РџСЂР°РІРёР»СЊРЅРѕ |
|-----------|-----------|
| `box-shadow` РЅР° РєР°СЂС‚РѕС‡РєР°С… | `border: 1px solid var(--border)` |
| Р“СЂР°РґРёРµРЅС‚РЅС‹Рµ С„РѕРЅС‹ | Solid-С†РІРµС‚ РёР· РїР°Р»РёС‚СЂС‹ |
| РќРµСЃРєРѕР»СЊРєРѕ primary-С†РІРµС‚РѕРІ | РћРґРёРЅ `--primary`, РѕСЃС‚Р°Р»СЊРЅРѕРµ вЂ” surface/muted |
| РРєРѕРЅРєРё РІРµР·РґРµ "РґР»СЏ РєСЂР°СЃРѕС‚С‹" | РРєРѕРЅРєРё С‚РѕР»СЊРєРѕ РµСЃР»Рё РЅРµСЃСѓС‚ СЃРјС‹СЃР» |
| РњРѕРґР°Р»РєРё СЃ 3+ РґРµР№СЃС‚РІРёСЏРјРё | Р Р°Р·Р±РёС‚СЊ РЅР° С€Р°РіРё РёР»Рё СѓР±СЂР°С‚СЊ Р»РёС€РЅРµРµ |
| РђРЅРёРјР°С†РёРё > 300ms | `duration-fast: 150ms` / `duration-base: 200ms` |
| РљРЅРѕРїРєРё РјРµРЅСЊС€Рµ 44px РїРѕ РІС‹СЃРѕС‚Рµ | `min-height: var(--touch-target-min)` |
| Breadcrumbs РЅР° РїР»РѕСЃРєРѕР№ РЅР°РІРёРіР°С†РёРё | РўРѕР»СЊРєРѕ Р·Р°РіРѕР»РѕРІРѕРє СЃС‚СЂР°РЅРёС†С‹ |
| Hover-СЌС„С„РµРєС‚С‹ СЃ С‚РµРЅСЊСЋ | `hover:bg-surface` вЂ” С‚РѕР»СЊРєРѕ С†РІРµС‚ С„РѕРЅР° |

---

## РџСЂРѕРёР·РІРѕРґРёС‚РµР»СЊРЅРѕСЃС‚СЊ
- РЎРєСЂРёРїС‚С‹ РґРѕР»Р¶РЅС‹ Р»РѕРіРёСЂРѕРІР°С‚СЊ РїСЂРѕРіСЂРµСЃСЃ: `console.log('Connecting...', 'Done')`
- Р•СЃР»Рё РєРѕРјР°РЅРґР° РІРёСЃРёС‚ > 20 СЃРµРє Р±РµР· РІС‹РІРѕРґР° вЂ” РїСЂРµСЂС‹РІР°С‚СЊ Рё РјРµРЅСЏС‚СЊ РїРѕРґС…РѕРґ
- РџРµСЂРµРґ СЃР»РѕР¶РЅС‹РјРё Prisma-Р·Р°РїСЂРѕСЃР°РјРё РїСЂРѕРІРµСЂСЏС‚СЊ РґРѕСЃС‚СѓРїРЅРѕСЃС‚СЊ Р‘Р” С‡РµСЂРµР· `prisma.$queryRaw`

---

## Operations Guardrails

### Deploy
- Production runs on Beget VPS `155.212.130.14`, repository path `/opt/crm`.
- Production compose file: `deploy/docker-compose.production.yml` with `/opt/crm/.env.production` on the VPS.
- Do not run SSH, `docker compose`, `git pull`, service restarts, nginx changes, or any production command without explicit owner approval in the current task.
- When deploy is approved, prefer the documented deploy path in `docs/DEPLOY.md` / `HANDOFF.md`; production service recreation must use `up -d --force-recreate`, not plain `docker restart`.
- Be careful with Next.js build cache and build-time rewrites. If a production fix depends on runtime env, verify that the Docker build receives the needed `ARG/ENV`.

### Environment
- Local development is Windows-first. The repository is a monorepo with `gravity-mvp/`, `tg-bot/`, `yandex-fleet-scraper/`, `max-web-scraper/`, `avito-worker/`, `tools/`, `telephony/`, and `deploy/`.
- Local env files are intentionally gitignored: `gravity-mvp/.env`, `tg-bot/.env`, `yandex-fleet-scraper/.env`, `max-web-scraper/.env`, `avito-worker/.env`, `tools/audio-bridge-day1/.env`.
- `.codex/config.toml` is local-only and may contain developer credentials. Commit `.codex/config.example.toml` instead.
- Common local ports: CRM `3002`, tg-bot `3001`, scraper API `3003`, tg-bot frontend `3004`, MAX scraper `3005`, audio bridge `3030`.
- FreeSWITCH/coturn/xray are host-level production concerns. Do not edit production telephony config without owner approval.

### Tests And Checks
- For CRM code changes, run the narrowest available check first from `gravity-mvp/`: lint/type/build or the relevant script named in package scripts.
- For UI changes, verify visually in a browser/preview before reporting done.
- For backend/data logic, prefer local scripts or focused tests and avoid sending real production data to external services.
- For AI-call regressions, consult issue #21 and the telephony smoke checklist before claiming production readiness.

### Migrations
- Local schema work uses `prisma migrate dev` only.
- Never use `prisma db push` for this project; it risks schema drift.
- Never run `prisma migrate deploy` or any production DB migration without explicit owner approval.

### Security
- Never commit real secrets, session cookies, browser profiles, `.env` files, private keys, `.age` files, or `CREDENTIALS_HANDOFF.md`.
- Do not pass passwords, tokens, or `DATABASE_URL` values as command-line arguments. Use env files or local shell environment.
- Treat one-off cookie/session scripts as sensitive until inspected. Keep them in gitignored local storage or delete them after owner approval.
- If a secret appears in git status, logs, or chat, stop and report before continuing.
