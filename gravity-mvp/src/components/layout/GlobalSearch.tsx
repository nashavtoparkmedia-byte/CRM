"use client";

/**
 * GlobalSearch — глобальный поиск из шапки CRM.
 *
 * Поведение:
 *   - ввод → debounce 200мс → GET /api/search?q=…
 *   - результаты группируются: Водители / Avito-аккаунты / Avito-отклики
 *   - клик по строке → router.push(href), панель закрывается, поле чистится
 *   - ↑/↓ — навигация по результатам, Enter — переход, Esc — закрыть
 *   - клик вне → закрыть
 *   - запрос < 2 символов → панель не показывается
 *
 * Сервер-side фильтр (см. /api/search/route.ts) уже отрезает короткие
 * запросы и нормализует телефоны (поиск по digits-only).
 */

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";

type ResultRow = {
  kind: "avito_account" | "avito_response";
  id: string | number;
  title: string;
  subtitle: string | null;
  href: string;
};

type GroupedResults = {
  avitoAccounts: ResultRow[];
  avitoResponses: ResultRow[];
};

const EMPTY: GroupedResults = {
  avitoAccounts: [],
  avitoResponses: [],
};

const GROUP_LABELS: Record<keyof GroupedResults, string> = {
  avitoAccounts: "Avito-аккаунты",
  avitoResponses: "Avito-отклики",
};

const KIND_ICON: Record<ResultRow["kind"], string> = {
  avito_account: "📣",
  avito_response: "💬",
};

export default function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GroupedResults>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Плоский массив всех результатов в том же порядке что отрисовка —
  // нужен для клавиатурной навигации (одно скользящее «highlight»
  // вместо отдельного по группам).
  const flat = useMemo<ResultRow[]>(
    () => [...results.avitoAccounts, ...results.avitoResponses],
    [results],
  );

  // Debounced fetch
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}`,
          { signal: ctrl.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as GroupedResults;
        setResults(data);
        setHighlight(0);
      } catch (e) {
        if ((e as any)?.name !== "AbortError") {
          // Тихо — поиск из шапки не должен ронять весь экран
          // ошибкой; покажем пустой список.
          setResults(EMPTY);
        }
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  // Click outside → close
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  function go(row: ResultRow) {
    setOpen(false);
    setQ("");
    setResults(EMPTY);
    inputRef.current?.blur();
    router.push(row.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(flat.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[highlight];
      if (row) go(row);
    }
  }

  const hasResults = flat.length > 0;
  // Панель открыта когда: пользователь активно искал (open) И запрос
  // длиннее минимума. Внутри панели сами решаем что показать —
  // «Ищу…», список, или «Ничего не найдено».
  const showPanel = open && q.trim().length >= 2;

  // Сквозной индекс highlight'а (по flat) — чтобы выделить строку
  // в нужной группе при отрисовке.
  let runningIdx = -1;

  return (
    <div className="relative w-48 md:w-72" ref={wrapRef}>
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="search"
        placeholder="Поиск по Avito (аккаунты, отклики)…"
        className="h-9 w-full rounded-full bg-secondary pl-9 text-sm focus-visible:ring-1"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (q.trim().length >= 2) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        // Chrome игнорирует обычный autoComplete="off" для search-полей.
        // Несколько слоёв защиты от autofill менеджеров паролей и браузера.
        autoComplete="off"
        name="global-search-no-autofill"
        data-form-type="other"
        data-lpignore="true"
        data-1p-ignore
      />

      {showPanel && (
        <div
          className="absolute left-0 right-0 top-full mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-gray-100 bg-white shadow-lg z-50"
          // Min-width чтобы при узком input'е (мобила) панель не была
          // слишком тесной для длинных названий.
          style={{ minWidth: 280 }}
        >
          {loading && (
            <div className="px-3 py-2 text-[12px] text-gray-400">Ищу…</div>
          )}
          {!loading && !hasResults && (
            <div className="px-3 py-3 text-[12px] text-gray-500">
              Ничего не найдено по «{q.trim()}»
            </div>
          )}
          {!loading &&
            (Object.keys(GROUP_LABELS) as Array<keyof GroupedResults>).map(
              (groupKey) => {
                const rows = results[groupKey];
                if (rows.length === 0) return null;
                return (
                  <div key={groupKey} className="py-1">
                    <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                      {GROUP_LABELS[groupKey]}
                    </div>
                    {rows.map((row) => {
                      runningIdx += 1;
                      const isActive = runningIdx === highlight;
                      return (
                        <button
                          key={`${row.kind}-${row.id}`}
                          type="button"
                          onMouseEnter={() => setHighlight(runningIdx)}
                          onMouseDown={(e) => {
                            // mousedown, а не click — иначе input
                            // успевает потерять focus и закрыть
                            // панель раньше срабатывания click'а.
                            e.preventDefault();
                            go(row);
                          }}
                          className={
                            "w-full flex items-start gap-2 px-3 py-2 text-left border-none cursor-pointer text-[12px] " +
                            (isActive
                              ? "bg-blue-50 text-blue-700"
                              : "hover:bg-gray-50 text-gray-900")
                          }
                        >
                          <span className="text-base leading-5 select-none">
                            {KIND_ICON[row.kind]}
                          </span>
                          <span className="flex flex-col min-w-0 flex-1">
                            <span className="font-medium truncate">
                              {row.title}
                            </span>
                            {row.subtitle && (
                              <span className="text-[11px] text-gray-500 truncate">
                                {row.subtitle}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              },
            )}
        </div>
      )}
    </div>
  );
}
