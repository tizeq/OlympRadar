import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  SlidersHorizontal,
  Bookmark,
  Compass,
  Sparkles,
  CalendarDays,
  Settings,
  Layers,
  Home,
  X,
  Check,
  ChevronRight,
  RefreshCw,
  Plus,
  Bell,
  Globe,
  Clock,
  ExternalLink,
  Menu,
} from "lucide-react";
import "./style.css";
type Event = {
  id: string;
  title: string;
  url: string;
  source: string;
  description: string | null;
  category: string | null;
  tags: string[];
  start: string | null;
  deadline: string | null;
  prize: string | null;
  format: string | null;
  restrictions: string | null;
  ai_policy: string | null;
  registration_url: string | null;
  country: string | null;
  age_min: number | null;
  age_max: number | null;
  free: boolean | null;
  prize_amount: number | null;
  prize_currency: string | null;
  difficulty: string | null;
  registration_open: boolean | null;
  score: number | null;
  status: string;
};
type Query = Record<string, string>;
type SettingsData = {
  enabled: boolean;
  time: string;
  timezone: string;
  min_score: number;
  filter_ids: string[];
  urgent: boolean;
};
type Saved = { id: string; name: string; query: Query };
type Me = { favorites: string[]; filters: Saved[]; settings: SettingsData };
const tg = (window as any).Telegram?.WebApp;
const sections = [
  ["home", "Обзор", Home],
  ["catalog", "Каталог", Compass],
  ["search", "Поиск", Search],
  ["recommendations", "Для вас", Sparkles],
  ["favorites", "Избранное", Bookmark],
  ["filters", "Мои фильтры", SlidersHorizontal],
  ["deadlines", "Дедлайны", CalendarDays],
  ["settings", "Настройки", Settings],
] as const;
const defaults: SettingsData = {
  enabled: false,
  time: "09:00",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  min_score: 0,
  filter_ids: [],
  urgent: false,
};
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const r = await fetch("/api/" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": tg?.initData || "",
      ...options.headers,
    },
  });
  if (!r.ok) {
    let message = "Не удалось загрузить данные";
    try {
      const e = await r.json();
      message = e.error || e.message || message;
    } catch {}
    throw Error(
      r.status === 401
        ? "Откройте приложение через Telegram, чтобы продолжить."
        : message,
    );
  }
  return r.status === 204 ? (undefined as T) : r.json();
}
const date = (s: string | null) =>
  s
    ? new Date(s).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
      })
    : "Дата уточняется";
function App() {
  const initial = new URLSearchParams(location.search).get("view") || "home";
  const [view, setView] = useState(
      sections.some((s) => s[0] === initial) ? initial : "home",
    ),
    [query, setQuery] = useState<Query>({ sort: "new" }),
    [events, setEvents] = useState<Event[]>([]),
    [total, setTotal] = useState(0),
    [me, setMe] = useState<Me>({
      favorites: [],
      filters: [],
      settings: defaults,
    }),
    [settings, setSettings] = useState(defaults),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [filterOpen, setFilterOpen] = useState(false),
    [selected, setSelected] = useState<Event | null>(null),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [menu, setMenu] = useState(false),
    [saving, setSaving] = useState(false),
    [filterName, setFilterName] = useState(""),
    [calendarDate, setCalendarDate] = useState(""),
    [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [recommendationIds, setRecommendationIds] = useState<string[]>([]),
    [meLoaded, setMeLoaded] = useState(false);
  useEffect(() => {
    tg?.ready();
    tg?.expand();
    const update = () => {
      document.documentElement.dataset.theme = tg?.colorScheme || "light";
    };
    update();
    tg?.onEvent("themeChanged", update);
    return () => tg?.offEvent("themeChanged", update);
  }, []);
  useEffect(() => {
    api<Me>("me")
      .then((m) => {
        setMe(m);
        setSettings({ ...defaults, ...m.settings });
        setRecommendationIds(m.settings.filter_ids || []);
        setMeLoaded(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (["settings", "filters"].includes(view)) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    const q: Query = { ...query, page: String(page) };
    if (view === "favorites") q.favorites = "true";
    if (view === "recommendations") {
      q.min_score = String(me.settings.min_score || 0);
      q.sort = "score";
    }
    if (view === "deadlines") q.sort = "deadline";
    if (q.sort === "prize" && !q.currency) q.currency = "RUB";
    const loadPage = (params: Query) =>
      api<{ items: Event[]; total: number }>(
        "events?" + new URLSearchParams(params),
      );
    const loadAll = async (params: Query) => {
      const first = await loadPage({ ...params, page: "1" });
      const items = [...first.items];
      for (let p = 2; items.length < first.total; p++) {
        if (!active) return [];
        const next = await loadPage({ ...params, page: String(p) });
        if (!next.items.length) break;
        items.push(...next.items);
      }
      return items;
    };
    const run = async () => {
      if (view === "deadlines") {
        const last = new Date(
          Number(month.slice(0, 4)),
          Number(month.slice(5)),
          0,
        ).getDate();
        const items = await loadAll({
          ...q,
          deadline_from: month + "-01",
          deadline_to: month + "-" + last,
          sort: "deadline",
        });
        return { items, total: items.length };
      }
      if (view === "recommendations") {
        if (!meLoaded || !recommendationIds.length)
          return { items: [], total: 0 };
        const results = await Promise.all(
          recommendationIds.map((id) => {
            const saved = me.filters.find((f) => f.id === id);
            return saved
              ? loadAll({
                  ...query,
                  ...saved.query,
                  min_score: String(me.settings.min_score || 0),
                  sort: "score",
                })
              : Promise.resolve([]);
          }),
        );
        const items = Array.from(
          new Map(results.flat().map((e) => [e.id, e])).values(),
        ).sort((a, b) => (b.score || 0) - (a.score || 0));
        return { items, total: items.length };
      }
      return loadPage(q);
    };
    run()
      .then((r) => {
        if (active) {
          setEvents(r.items);
          setTotal(r.total);
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [
    view,
    query,
    page,
    refresh,
    me.settings.min_score,
    me.filters,
    meLoaded,
    recommendationIds,
    month,
  ]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  const navigate = (v: string) => {
    setView(v);
    setPage(1);
    setMenu(false);
    history.replaceState(null, "", "?view=" + v);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const change = (key: string, value: string) => {
    setQuery((q) => {
      const n = { ...q };
      value ? (n[key] = value) : delete n[key];
      return n;
    });
    setPage(1);
  };
  const favorite = async (e: Event) => {
    const has = me.favorites.includes(e.id);
    try {
      await api("favorites/" + encodeURIComponent(e.id), {
        method: has ? "DELETE" : "PUT",
      });
      setMe((m) => ({
        ...m,
        favorites: has
          ? m.favorites.filter((i) => i !== e.id)
          : [...m.favorites, e.id],
      }));
      tg?.HapticFeedback?.impactOccurred("light");
      if (view === "favorites") setRefresh((x) => x + 1);
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const saveSettings = async () => {
    setSaving(true);
    try {
      await api("settings", { method: "PUT", body: JSON.stringify(settings) });
      setMe((m) => ({ ...m, settings }));
      setToast("Настройки сохранены");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveFilter = async () => {
    if (!filterName.trim()) return;
    setSaving(true);
    try {
      await api("filters", {
        method: "POST",
        body: JSON.stringify({ name: filterName.trim(), query }),
      });
      const m = await api<Me>("me");
      setMe(m);
      setFilterName("");
      setToast("Фильтр сохранён");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const removeFilter = async (id: string) => {
    try {
      await api("filters/" + encodeURIComponent(id), { method: "DELETE" });
      setMe((m) => ({ ...m, filters: m.filters.filter((f) => f.id !== id) }));
      setSettings((s) => ({
        ...s,
        filter_ids: s.filter_ids.filter((i) => i !== id),
      }));
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const openLink = (url: string) => {
    try {
      const u = new URL(url);
      if (!["http:", "https:"].includes(u.protocol)) return;
      tg?.openLink
        ? tg.openLink(u.href)
        : window.open(u.href, "_blank", "noopener,noreferrer");
    } catch {
      setToast("Ссылка недоступна");
    }
  };
  const count = Object.keys(query).filter(
    (k) => k !== "sort" && query[k],
  ).length;
  const card = (e: Event, i: number) => (
    <article className="event-card" key={e.id}>
      <div className={"card-art art-" + (i % 4)}>
        <span className="art-grid" />
        <span className="art-symbol">
          {e.category?.toLowerCase().includes("диз")
            ? "✳"
            : e.category?.toLowerCase().includes("хак")
              ? "{ }"
              : i % 2
                ? "↗"
                : "✦"}
        </span>
        <span className="art-label">{e.category || "ВОЗМОЖНОСТЬ"}</span>
        <button
          className={
            "bookmark " + (me.favorites.includes(e.id) ? "marked" : "")
          }
          aria-label="В избранное"
          onClick={() => favorite(e)}
        >
          <Bookmark
            size={18}
            fill={me.favorites.includes(e.id) ? "currentColor" : "none"}
          />
        </button>
      </div>
      <div className="card-content">
        <div className="card-meta">
          <span>{e.format || "Формат уточняется"}</span>
          {e.free === true && <span>Бесплатно</span>}
          {e.status === "ended" && <span>Завершено</span>}
        </div>
        <button className="title-button" onClick={() => setSelected(e)}>
          <h3>{e.title}</h3>
        </button>
        <p>
          {e.description ||
            "Подробности и условия участия — на странице организатора."}
        </p>
        <div className="tags">
          {(e.tags || []).slice(0, 3).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="card-bottom">
          <div>
            <small>Дедлайн</small>
            <strong>{date(e.deadline)}</strong>
          </div>
          <button
            className="round-link"
            onClick={() => setSelected(e)}
            aria-label="Подробнее"
          >
            <ArrowUpRight size={20} />
          </button>
        </div>
      </div>
    </article>
  );
  return (
    <div className="app">
      <aside className={menu ? "sidebar show" : "sidebar"}>
        <a
          className="brand"
          href="?view=home"
          onClick={(e) => {
            e.preventDefault();
            navigate("home");
          }}
        >
          <span className="brand-icon">
            o<span>↗</span>
          </span>
          OlympRadar<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">КОНКУРСЫ · ХАКАТОНЫ · ГРАНТЫ</div>
        <nav>
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? "nav-item active" : "nav-item"}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "favorites" && me.favorites.length > 0 && (
                <em>{me.favorites.length}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="live-dot" />
          Персональные подборки<p>Хакатоны, конкурсы и гранты</p>
          <div className="profile">
            <span>{tg?.initDataUnsafe?.user?.first_name?.[0] || "S"}</span>
            <div>
              <strong>
                {tg?.initDataUnsafe?.user?.first_name || "Исследователь"}
              </strong>
              <small>Твоя персональная подборка</small>
            </div>
            <Settings size={16} onClick={() => navigate("settings")} />
          </div>
        </div>
      </aside>
      {menu && <div className="menu-scrim" onClick={() => setMenu(false)} />}
      <main>
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setMenu(!menu)}
            aria-label="Меню"
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            Пространство возможностей <ChevronRight size={14} />
            <strong>{sections.find((s) => s[0] === view)?.[1]}</strong>
          </div>
          <div className="top-actions">
            <span className="today">
              {new Date().toLocaleDateString("ru-RU", {
                day: "numeric",
                month: "long",
              })}
            </span>
            <button
              className="icon-button"
              onClick={() => navigate("settings")}
              aria-label="Уведомления"
            >
              <Bell size={19} />
              {me.settings.enabled && <i />}
            </button>
            <div className="avatar">
              {tg?.initDataUnsafe?.user?.first_name?.[0] || "S"}
            </div>
          </div>
        </header>
        <div className="main-body">
          {view === "home" && (
            <section className="hero">
              <div className="hero-copy">
                <div className="eyebrow">
                  <span />
                  КАТАЛОГ ВОЗМОЖНОСТЕЙ
                </div>
                <h1>
                  Конкурсы и хакатоны.
                  <br />
                  Возможности <span>для тебя.</span>
                </h1>
                <p>
                  Хакатоны, конкурсы и гранты, которые подходят именно тебе.
                  Найди повод сделать следующий шаг.
                </p>
                <button className="primary" onClick={() => navigate("catalog")}>
                  Найти своё <ArrowUpRight size={18} />
                </button>
              </div>
              <div className="hero-visual" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="asterisk">✳</div>
                <span className="tiny-star">✦</span>
              </div>
            </section>
          )}
          {!["settings", "filters"].includes(view) && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    {
                      (
                        {
                          home: "Открыто для тебя",
                          catalog: "Каталог возможностей",
                          search: "Найди свой следующий шаг",
                          recommendations: "Подобрано для тебя",
                          favorites: "Сохранено на потом",
                          deadlines: "Успеть самое важное",
                        } as Record<string, string>
                      )[view]
                    }
                    <span className="result-count">{total}</span>
                  </h2>
                </div>
                {view === "home" && (
                  <button
                    className="text-link"
                    onClick={() => navigate("catalog")}
                  >
                    Весь каталог <ArrowRight size={17} />
                  </button>
                )}
              </div>
              <div className="search-row">
                <div className="search-field">
                  <Search size={19} />
                  <input
                    aria-label="Поиск возможностей"
                    placeholder="Название, тема или ключевое слово"
                    value={query.q || ""}
                    onChange={(e) => change("q", e.target.value)}
                  />
                  {query.q && (
                    <button
                      onClick={() => change("q", "")}
                      aria-label="Очистить поиск"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                <button
                  className={"filter-button " + (count ? "has-filters" : "")}
                  onClick={() => setFilterOpen(true)}
                >
                  <SlidersHorizontal size={18} />
                  <span>Фильтры</span>
                  {count > 0 && <b>{count}</b>}
                </button>
              </div>
              <div className="catalog-toolbar">
                <div className="category-tabs">
                  {[
                    ["", "Все возможности"],
                    ["hackathon", "Хакатоны"],
                    ["ctf", "CTF"],
                    ["grant", "Гранты"],
                    ["olympiad", "Олимпиады"],
                    ["programming", "Программирование"],
                    ["ai", "ИИ"],
                    ["ml", "ML"],
                  ].map(([value, label]) => (
                    <button
                      key={label}
                      className={
                        (query.category || "") === value ? "selected" : ""
                      }
                      onClick={() => change("category", value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="Сортировка"
                  disabled={["deadlines", "recommendations"].includes(view)}
                  value={
                    view === "deadlines"
                      ? "deadline"
                      : view === "recommendations"
                        ? "score"
                        : query.sort || "new"
                  }
                  onChange={(e) => change("sort", e.target.value)}
                >
                  <option value="new">Сначала новые</option>
                  <option value="deadline">Ближайший дедлайн</option>
                  <option value="score">По соответствию</option>
                  <option value="prize">По призовому фонду</option>
                </select>
              </div>
              {view === "recommendations" && (
                <section className="settings-panel">
                  <h3>Твои интересы</h3>
                  <p>
                    Подборка объединяет возможности по выбранным сохранённым
                    фильтрам. Минимальная оценка: {me.settings.min_score}.
                  </p>
                  <div className="filter-checks">
                    {me.filters.map((f) => (
                      <label key={f.id}>
                        <input
                          type="checkbox"
                          checked={recommendationIds.includes(f.id)}
                          onChange={(e) =>
                            setRecommendationIds((ids) =>
                              e.target.checked
                                ? [...ids, f.id]
                                : ids.filter((id) => id !== f.id),
                            )
                          }
                        />
                        {f.name}
                      </label>
                    ))}
                  </div>
                  {!recommendationIds.length && (
                    <p>
                      Выбери хотя бы один фильтр, чтобы получить персональную
                      подборку.
                    </p>
                  )}
                  <button
                    className="text-link"
                    onClick={() =>
                      navigate(me.filters.length ? "settings" : "filters")
                    }
                  >
                    {me.filters.length ? "Настроить порог" : "Создать фильтр"}{" "}
                    <ArrowRight size={15} />
                  </button>
                </section>
              )}
              {view === "deadlines" && (
                <section className="calendar-panel">
                  <div className="calendar-header">
                    <button
                      className="secondary"
                      aria-label="Предыдущий месяц"
                      onClick={() => {
                        const d = new Date(month + "-15T12:00:00");
                        d.setMonth(d.getMonth() - 1);
                        setMonth(
                          d.getFullYear() +
                            "-" +
                            String(d.getMonth() + 1).padStart(2, "0"),
                        );
                        setCalendarDate("");
                      }}
                    >
                      ←
                    </button>
                    <h3>
                      {new Date(month + "-15T12:00:00").toLocaleDateString(
                        "ru-RU",
                        { month: "long", year: "numeric" },
                      )}
                    </h3>
                    <button
                      className="secondary"
                      aria-label="Следующий месяц"
                      onClick={() => {
                        const d = new Date(month + "-15T12:00:00");
                        d.setMonth(d.getMonth() + 1);
                        setMonth(
                          d.getFullYear() +
                            "-" +
                            String(d.getMonth() + 1).padStart(2, "0"),
                        );
                        setCalendarDate("");
                      }}
                    >
                      →
                    </button>
                  </div>
                  <p>
                    Все дедлайны выбранного месяца. Выбери день, чтобы увидеть
                    события.
                  </p>
                  <div className="month-grid">
                    {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
                      <span className="weekday" key={d}>
                        {d}
                      </span>
                    ))}
                    {Array.from({
                      length:
                        (new Date(month + "-01T12:00:00").getDay() + 6) % 7,
                    }).map((_, i) => (
                      <span key={"blank" + i} />
                    ))}
                    {Array.from({
                      length: new Date(
                        Number(month.slice(0, 4)),
                        Number(month.slice(5)),
                        0,
                      ).getDate(),
                    }).map((_, i) => {
                      const day = month + "-" + String(i + 1).padStart(2, "0");
                      const n = events.filter(
                        (e) => e.deadline?.slice(0, 10) === day,
                      ).length;
                      return (
                        <button
                          key={day}
                          aria-label={day + ", событий: " + n}
                          className={
                            (calendarDate === day ? "selected " : "") +
                            (n ? "has-events" : "")
                          }
                          onClick={() =>
                            setCalendarDate(calendarDate === day ? "" : day)
                          }
                        >
                          <strong>{i + 1}</strong>
                          <small>{n ? n + " событий" : "·"}</small>
                        </button>
                      );
                    })}
                  </div>
                  {calendarDate && (
                    <button
                      className="text-link"
                      onClick={() => setCalendarDate("")}
                    >
                      Все даты месяца <X size={14} />
                    </button>
                  )}
                </section>
              )}
              {error ? (
                <div className="empty">
                  <Globe size={32} />
                  <h3>Пока не удалось подключиться</h3>
                  <p>{error}</p>
                  <button
                    className="secondary"
                    onClick={() => setRefresh((x) => x + 1)}
                  >
                    <RefreshCw size={16} />
                    Попробовать снова
                  </button>
                </div>
              ) : loading ? (
                <div className="card-grid">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="skeleton">
                      <div />
                      <span />
                      <span />
                      <span />
                    </div>
                  ))}
                </div>
              ) : events.length ? (
                <>
                  {view === "deadlines" &&
                    calendarDate &&
                    !events.some((e) =>
                      e.deadline?.startsWith(calendarDate),
                    ) && (
                      <div className="empty">
                        <CalendarDays size={30} />
                        <h3>В этот день нет дедлайнов</h3>
                        <button
                          className="text-link"
                          onClick={() => setCalendarDate("")}
                        >
                          Показать весь месяц
                        </button>
                      </div>
                    )}
                  <div className="card-grid">
                    {events
                      .filter(
                        (e) =>
                          view !== "deadlines" ||
                          !calendarDate ||
                          e.deadline?.startsWith(calendarDate),
                      )
                      .map(card)}
                  </div>
                  {!["deadlines", "recommendations"].includes(view) && (
                    <div className="pagination">
                      <button
                        disabled={page === 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        Назад
                      </button>
                      <span>
                        Страница {page} · {total} возможностей
                      </span>
                      <button
                        disabled={events.length === 0 || page * 40 >= total}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Дальше <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty">
                  <Compass size={36} />
                  <h3>
                    {view === "favorites"
                      ? "Твои находки будут здесь"
                      : "Пока нет подходящих возможностей"}
                  </h3>
                  <p>
                    {view === "favorites"
                      ? "Нажми на закладку в карточке, чтобы сохранить возможность."
                      : "Попробуй изменить фильтры или зайди позже — каталог пополняется."}
                  </p>
                  <button
                    className="secondary"
                    onClick={() => {
                      setQuery({ sort: "new" });
                      navigate("catalog");
                    }}
                  >
                    Открыть каталог <ArrowUpRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
          {view === "filters" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    Мои фильтры{" "}
                    <span className="result-count">{me.filters.length}</span>
                  </h2>
                  <p className="subtitle">
                    Сохрани любимые условия поиска и возвращайся к ним в один
                    клик.
                  </p>
                </div>
              </div>
              <div className="settings-panel">
                <h3>Сохранить текущий поиск</h3>
                <p>В фильтр войдут все выбранные параметры каталога.</p>
                <div className="save-filter">
                  <input
                    placeholder="Например: онлайн-хакатоны"
                    value={filterName}
                    onChange={(e) => setFilterName(e.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={!filterName.trim() || saving}
                    onClick={saveFilter}
                  >
                    <Plus size={17} />
                    Сохранить
                  </button>
                </div>
                <button
                  className="text-link"
                  onClick={() => setFilterOpen(true)}
                >
                  Настроить параметры <SlidersHorizontal size={16} />
                </button>
              </div>
              <div className="saved-list">
                {me.filters.map((f) => (
                  <div className="saved-filter" key={f.id}>
                    <div className="saved-icon">
                      <SlidersHorizontal />
                    </div>
                    <div>
                      <h3>{f.name}</h3>
                      <p>
                        {Object.entries(f.query)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ") || "Все возможности"}
                      </p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => {
                        setQuery(f.query);
                        navigate("catalog");
                      }}
                    >
                      Открыть <ArrowUpRight size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Удалить фильтр"
                      onClick={() => removeFilter(f.id)}
                    >
                      <X size={18} />
                    </button>
                  </div>
                ))}
              </div>
              {!me.filters.length && (
                <div className="empty">
                  <Layers size={32} />
                  <h3>У каждого свой маршрут</h3>
                  <p>
                    Сохрани первый фильтр, чтобы быстрее находить подходящие
                    события.
                  </p>
                </div>
              )}
            </>
          )}
          {view === "settings" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>Настройки</h2>
                  <p className="subtitle">
                    Ты выбираешь, какие возможности и когда получать.
                  </p>
                </div>
              </div>
              <div className="settings-panel">
                <div className="setting-title">
                  <div className="saved-icon">
                    <Bell />
                  </div>
                  <div>
                    <h3>Ежедневная персональная сводка</h3>
                    <p>Одна подборка в день в твоём Telegram.</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={settings.enabled}
                    className={"toggle " + (settings.enabled ? "on" : "")}
                    onClick={() =>
                      setSettings((s) => ({ ...s, enabled: !s.enabled }))
                    }
                  >
                    <span />
                  </button>
                </div>
                <div className="settings-grid">
                  <label>
                    Время отправки
                    <input
                      type="time"
                      value={settings.time}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, time: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Часовой пояс
                    <input
                      value={settings.timezone}
                      placeholder="Europe/Moscow"
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, timezone: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Минимальная оценка соответствия
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={settings.min_score}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          min_score: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                </div>
                <h4>Фильтры для сводки</h4>
                <p>Если ничего не выбрано, сводка учитывает все возможности.</p>
                <div className="filter-checks">
                  {me.filters.length ? (
                    me.filters.map((f) => (
                      <label key={f.id}>
                        <input
                          type="checkbox"
                          checked={settings.filter_ids.includes(f.id)}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              filter_ids: e.target.checked
                                ? [...s.filter_ids, f.id]
                                : s.filter_ids.filter((i) => i !== f.id),
                            }))
                          }
                        />
                        {f.name}
                      </label>
                    ))
                  ) : (
                    <button
                      className="text-link"
                      onClick={() => navigate("filters")}
                    >
                      Создать первый фильтр <ArrowRight size={16} />
                    </button>
                  )}
                </div>
              </div>
              <div className="settings-panel setting-title">
                <div className="saved-icon">
                  <Clock />
                </div>
                <div>
                  <h3>Напоминания о дедлайнах</h3>
                  <p>Включи, если хочешь получать срочные напоминания.</p>
                </div>
                <button
                  role="switch"
                  aria-checked={settings.urgent}
                  className={"toggle " + (settings.urgent ? "on" : "")}
                  onClick={() =>
                    setSettings((s) => ({ ...s, urgent: !s.urgent }))
                  }
                >
                  <span />
                </button>
              </div>
              <button
                className="primary"
                disabled={saving}
                onClick={saveSettings}
              >
                {saving ? "Сохраняем…" : "Сохранить настройки"}
                <Check size={18} />
              </button>
            </>
          )}
        </div>
      </main>
      {filterOpen && (
        <div className="modal-backdrop" onClick={() => setFilterOpen(false)}>
          <section
            className="filter-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <h2>Фильтры</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setFilterOpen(false)}
                aria-label="Закрыть"
              >
                <X />
              </button>
            </div>
            <div className="filter-fields">
              {[
                ["category", "Категория", "Хакатон, конкурс, грант"],
                ["tag", "Тег", "Python, дизайн, наука"],
                ["country", "Страна", "Название или код страны"],
                ["age", "Твой возраст", "18"],
                ["currency", "Валюта приза", "RUB, USD, EUR"],
              ].map(([key, label, placeholder]) => (
                <label key={key}>
                  {label}
                  <input
                    type={key === "age" ? "number" : "text"}
                    value={query[key] || ""}
                    placeholder={placeholder}
                    onChange={(e) => change(key, e.target.value)}
                  />
                </label>
              ))}
              {[
                ["start_from", "Начало от"],
                ["deadline_to", "Дедлайн до"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="date"
                    value={query[key] || ""}
                    onChange={(e) => change(key, e.target.value)}
                  />
                </label>
              ))}
              {[
                [
                  "format",
                  "Формат",
                  [
                    ["online", "Онлайн"],
                    ["onsite", "Офлайн"],
                    ["hybrid", "Гибрид"],
                  ],
                ],
                [
                  "ai_policy",
                  "Использование ИИ",
                  [
                    ["allowed", "Разрешено"],
                    ["prohibited", "Запрещено"],
                    ["unknown", "Неизвестно"],
                  ],
                ],
                [
                  "difficulty",
                  "Сложность",
                  [
                    ["beginner", "Начинающий"],
                    ["intermediate", "Средняя"],
                    ["advanced", "Продвинутая"],
                  ],
                ],
                [
                  "registration_open",
                  "Регистрация",
                  [
                    ["true", "Открыта"],
                    ["false", "Закрыта"],
                  ],
                ],
                [
                  "free",
                  "Стоимость",
                  [
                    ["true", "Бесплатно"],
                    ["false", "Платно"],
                  ],
                ],
                [
                  "cash",
                  "Денежный приз",
                  [
                    ["true", "Есть"],
                    ["false", "Без денежного приза"],
                  ],
                ],
              ].map(([key, label, opts]) => (
                <label key={key as string}>
                  {label as string}
                  <select
                    value={query[key as string] || ""}
                    onChange={(e) => change(key as string, e.target.value)}
                  >
                    <option value="">Неважно</option>
                    {(opts as string[][]).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                Минимальная оценка
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={query.min_score || ""}
                  onChange={(e) => change("min_score", e.target.value)}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="text-link"
                onClick={() => setQuery({ sort: "new" })}
              >
                Сбросить всё
              </button>
              <button
                className="primary"
                onClick={() => {
                  setFilterOpen(false);
                  if (view === "filters") navigate("catalog");
                }}
              >
                Показать возможности <ArrowRight size={17} />
              </button>
            </div>
          </section>
        </div>
      )}
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section
            className="detail-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="detail-top">
              <span className="eyebrow muted">
                {selected.category || "ВОЗМОЖНОСТЬ"}
              </span>
              <button
                className="icon-button"
                onClick={() => setSelected(null)}
                aria-label="Закрыть"
              >
                <X />
              </button>
            </div>
            <h2>{selected.title}</h2>
            <div className="tags">
              {(selected.tags || []).map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <p className="detail-description">
              {selected.description || "Описание пока не опубликовано."}
            </p>
            <div className="detail-facts">
              {[
                ["Начало", date(selected.start)],
                ["Дедлайн", date(selected.deadline)],
                ["Формат", selected.format],
                ["Страна", selected.country],
                ["Приз", selected.prize],
                ["Сложность", selected.difficulty],
                ["Использование ИИ", selected.ai_policy],
                ["Ограничения", selected.restrictions],
                [
                  "Возраст",
                  selected.age_min || selected.age_max
                    ? `${selected.age_min ?? "—"} – ${selected.age_max ?? "—"}`
                    : null,
                ],
                [
                  "Участие",
                  selected.free === null
                    ? null
                    : selected.free
                      ? "Бесплатно"
                      : "Платно",
                ],
                ["Источник", selected.source],
              ].map(([k, v]) => (
                <div key={k}>
                  <small>{k}</small>
                  <strong>{v || "Не указано"}</strong>
                </div>
              ))}
            </div>
            <div className="detail-actions">
              <button
                className="primary"
                onClick={() =>
                  openLink(selected.registration_url || selected.url)
                }
              >
                Перейти к организатору <ExternalLink size={17} />
              </button>
              <button className="secondary" onClick={() => favorite(selected)}>
                <Bookmark size={17} />
                {me.favorites.includes(selected.id) ? "Сохранено" : "Сохранить"}
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
