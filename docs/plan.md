# Funnel Runtime — план реализации

> Для агентов: выполнять по `superpowers:subagent-driven-development`. Спека — `docs/design.md`,
> правила — `CLAUDE.md`. Каждая задача заканчивается зелёными тестами и коммитом.

**Цель:** рабочая платформа воронок (конфиг → UI, версии + откат, A/B, события, дашборд,
генератор) с публичным URL за 48 часов, затем итерация 2 (v3) на проде.

**Архитектура:** один Node-процесс (Fastify + статика React), SQLite, общий движок `shared/engine`.

**Стек:** TypeScript, Vite, React 19, react-router, Fastify 5, better-sqlite3, Zod, Vitest, esbuild.

## Глобальные ограничения
- Node 22, один npm-пакет, никаких сторонних сервисов, данные только в SQLite (`DATA_DIR`).
- Код и UI — английский, docs — русский.
- Каждая метрика аналитики — уникальные `session_id`; события — `name + properties_json`.
- Сырые ответы не попадают в события (только `answer_kind`).

## Структура файлов и ответственность

```
shared/types.ts            типы конфига, ответов, ResolvedFunnel
shared/api.ts              DTO запросов/ответов API (общие для web и server)
shared/schema.ts           zod-схема FunnelConfig + инварианты → parseFunnelConfig()
shared/engine/conditions.ts  evaluateCondition
shared/engine/resolve.ts     resolveVariant (deep merge overrides)
shared/engine/visibility.ts  visibleSteps, effectiveAnswers, nextStepId, prevStepId
shared/engine/validate.ts    validateAnswer
shared/engine/progress.ts    progress
shared/engine/result.ts      computeResult
shared/engine/events.ts      allowedEvents
shared/engine/index.ts       реэкспорт
server/index.ts            запуск: buildApp → listen(PORT), seed on boot
server/app.ts              buildApp({ dbPath, adminToken? }) → Fastify instance
server/db.ts               openDb(path): Database, schema DDL, WAL
server/repos/versions.ts   funnels + funnel_versions + version_history
server/repos/sessions.ts   sessions
server/repos/events.ts     insertEvent (OR IGNORE), queryEvents(filters)
server/services/versions.ts  upload / publish / rollback / list / active config (кэш по версии)
server/services/sessions.ts  create (назначение варианта, session_started), get, updateState, computeResult
server/services/ingest.ts    ingestBatch(events) → IngestResponse
server/services/aggregate.ts aggregate(events, stepOrder) — чистая функция
server/services/analytics.ts фильтры → queryEvents → stepOrder → aggregate
server/routes/*.ts         health, sessions, events, admin, analytics
server/seed.ts             ensureSeed(app): загрузить+опубликовать v1, при SEED_ON_BOOT — трафик
web/main.tsx, web/App.tsx  роутер: /, /admin, /admin/analytics
web/api.ts                 fetch-обёртки с типами из shared/api.ts
web/tracker.ts             очередь событий, батчинг, sendBeacon, backoff
web/funnel/*               useSession, FunnelPage, StepView, инпуты, ResultView, ProgressBar
web/admin/*                VersionsPage, AnalyticsPage
web/styles.css
scripts/generate-traffic.ts
tests/engine/*.test.ts, tests/server/*.test.ts, tests/analytics/aggregate.test.ts
```

## Фазы и параллельность

| Фаза | Задачи | Кто |
|---|---|---|
| 0 | T1 скелет, T2 типы + схема, T3 движок с тестами, T4 db + app + health | lead |
| 1 ∥ | T5 backend (репозитории, сервисы, маршруты, тесты) ∥ T6 frontend (воронка, трекер, админка, дашборд) | backend-dev ∥ frontend-dev |
| 2 ∥ | T7 генератор трафика ∥ T8 Docker + деплой + README | agent ∥ lead |
| 3 | T9 интеграция и e2e-прогон, тег `iteration-1`; T10 итерация 2 на проде, тег `iteration-2`; T11 docs/process, шпаргалка | lead |

---

### T1. Скелет проекта
**Файлы:** `package.json`, `tsconfig.base.json`, `tsconfig.web.json`, `tsconfig.server.json`,
`vite.config.ts`, `vitest.config.ts`, `index.html`, `web/main.tsx`, `server/index.ts`.
- deps: fastify, @fastify/static, better-sqlite3, zod, react, react-dom, react-router-dom.
- devDeps: typescript, vite, @vitejs/plugin-react, vitest, tsx, esbuild, concurrently, @types/*.
- scripts: `dev`, `dev:server`, `dev:web`, `build`, `build:web`, `build:server`, `start`,
  `test`, `typecheck`, `seed`.
- Проверка: `npm run typecheck` и `npm test` (0 тестов) проходят. Коммит `chore: project skeleton`.

### T2. Типы, DTO, zod-схема
**Файлы:** `shared/types.ts`, `shared/api.ts`, `shared/schema.ts`, `tests/engine/schema.test.ts`.
- `parseFunnelConfig(raw: unknown): FunnelConfig` — бросает `ZodError`; инварианты §3 спеки
  через `superRefine`.
- Тесты: оба конфига из `configs/` парсятся; конфиг с несуществующим шагом в `stepSequence`
  отклоняется; без `result` в конце последовательности отклоняется.

### T3. Движок
**Файлы:** `shared/engine/*.ts`, `tests/engine/{conditions,visibility,validate,progress,result,events}.test.ts`.
Сигнатуры — §3 спеки. Ключевые тесты:
- conditions: каждый оператор; `any`/`all`; отсутствующий ответ → false; `contains` на массиве и строке; `gte` с числом.
- visibility (v1, вариант A): `office_days` скрыт при `work_mode = remote`, виден при `hybrid`;
  при смене `work_mode` с `hybrid` на `remote` ответ `office_days` не попадает в `effectiveAnswers`.
- visibility (v3, вариант B): `security_constraints` виден только при `priorities ⊇ compliance`; `tool_count` отсутствует в B.
- validate: number required/min/max/integer; single: значение из опций; multi: min/max selections; сообщения из конфига.
- progress: v1 A при `work_mode = remote` — 6 вопросов, `team_size` → `{index:1,count:6}`; `intro` → null.
- result: v1 `remote + wide` → `async_native`; `hybrid` → `hybrid_structured`; `same + low + remote` → `balanced`;
  v3 `compliance + strict` → `regulated_scale` раньше `meeting_hours ≥ 15`; вариант B даёт override заголовка.
- events: v1 не содержит `recommendation_expanded`, v3 содержит с `{result_id, action, source}`.
Коммит `feat(engine): config-driven funnel engine with tests`.

### T4. БД и приложение
**Файлы:** `server/db.ts`, `server/app.ts`, `server/routes/health.ts`, `tests/server/health.test.ts`.
- `openDb(path)` — DDL из §4, `journal_mode=WAL` (для `:memory:` — пропустить).
- `buildApp({ dbPath, adminToken })` — регистрирует маршруты, в проде отдаёт `dist/web` со
  SPA-fallback на `index.html` для не-`/api` путей.
- Тест: `GET /api/health` → `{ ok: true, activeVersion: null }`.
Коммит `feat(server): sqlite schema and app factory`.

---

### T5. Backend (backend-dev)
**Файлы:** `server/repos/*`, `server/services/*`, `server/routes/{sessions,events,admin,analytics}.ts`,
`server/seed.ts`, `tests/server/{versions,sessions,ab,ingest,analytics-route}.test.ts`, `tests/analytics/aggregate.test.ts`.
**Потребляет:** `shared/engine`, `shared/schema.parseFunnelConfig`, `shared/api` DTO, `openDb`, `buildApp`.
**Производит:** маршруты §5 спеки ровно с такими путями, кодами и телами; `ensureSeed`; `aggregate`.

Порядок внутри задачи (каждый пункт — тест → код → зелёный прогон):
1. versions: repo + service + admin routes. Тесты: upload v1 → список со статусом draft;
   publish → active; upload v3 + publish → v1 published, v3 active; rollback → v1 active, history
   `[publish 1, publish 3, rollback→1]`; невалидный JSON → 400 с `details`; дубликат → 409.
2. sessions: create/get/state/result. Тесты: без активной версии → 503; сессия на v1 живёт после
   publish v3 (`GET` отдаёт config.version = 1), новая → 3; `PUT state` с невалидным ответом → 400;
   `POST result` для `hybrid` → `hybrid_structured`; TTL: сессия с `expires_at` в прошлом → 410.
3. A/B: назначение и override. Тесты: 400 сессий → доля A в [0.4, 0.6]; `variantOverride: 'B'` →
   B и `assignmentSource = 'override'`; неизвестный override → серверное назначение; повторный `GET` —
   тот же вариант; событие `session_started` несёт `funnel_version` и `variant` сессии.
4. ingest: `ingestBatch`. Тесты: пачка из 3 → 3 accepted; та же пачка ещё раз → 3 duplicate;
   пачка с событием без `name` → 1 rejected + остальные accepted; `unknown_session`;
   `recommendation_expanded` → rejected на сессии v1, accepted на сессии v3; `properties.answer`
   отбрасывается, `answer_kind` сохраняется; `events` > 500 → 400; версия/вариант берутся из сессии,
   а не из тела.
5. aggregate (чистая функция) + analytics route. Фикстура: 6 сессий — A: полный проход с CTA;
   A: отвал на `work_mode` с дублем `step_viewed`; B: результат без CTA, события в обратном порядке;
   B: `back_clicked` с повторным просмотром `intro`; A: только `session_started`; override-сессия B.
   Проверить: `started=6`, `reached(intro)=5`, `exits(work_mode)=1`, `exitsBeforeFirstStep=1`,
   `reachedResult=2` (+override), `ctr`, инвариант суммы; фильтр `variant=B`; `excludeOverrides`.
6. `ensureSeed(app, { trafficSessions })`: если версий нет — `parseFunnelConfig(configs/funnel-v1.json)`,
   upload + publish; генератор трафика подключается в T7 (экспортировать хук `runSeedTraffic?`).
Отчёт: вывод `npx vitest run tests/server tests/analytics` и `npx tsc -p tsconfig.server.json`.

### T6. Frontend (frontend-dev)
**Файлы:** `web/api.ts`, `web/tracker.ts`, `web/funnel/*`, `web/admin/*`, `web/App.tsx`, `web/styles.css`.
**Потребляет:** `shared/engine`, `shared/api` DTO, API §5.
1. `api.ts`: `createSession`, `getSession`, `updateState`, `computeResult`, `sendEvents`,
   admin: `listVersions`, `uploadVersion`, `publishVersion`, `rollback`, `history`, `getAnalytics`.
2. `tracker.ts`: `createTracker({ sessionId, allowed: Map<string, Set<string>>, endpoint })` →
   `track(name, { stepId?, properties? })`, `flush()`; очередь в `localStorage['fr.queue.' + sessionId]`;
   батч 800 мс / 10 событий; `pagehide` → `sendBeacon`; backoff 1–30 с; фильтрация свойств по whitelist.
3. `useSession`: bootstrap по §6 (localStorage `fr.sessionId`, `?variant=`, `utm_*` из URL, 404/410 → новая).
4. `FunnelPage`: `resolveVariant` → `visibleSteps` → текущий шаг; `StepView` по типу:
   `InfoStep`, `SingleSelectStep`, `MultiSelectStep` (чипы), `NumberStep` (unit, min/max), `ResultStep`.
   Continue/Back по §9; `step_viewed` при каждом показе; ошибки валидации из движка под инпутом.
   `ProgressBar` из `progress()`. Ошибка сети — баннер с Retry.
5. `ResultStep`: `POST result` → loading/error/retry из `content`; заголовок/CTA с override варианта;
   CTA раскрывает рекомендации, шлёт `cta_clicked`, и `recommendation_expanded` если разрешено.
6. `VersionsPage`: таблица версий (status pill, sessions), загрузка JSON (file input + textarea),
   Publish, Rollback (показывает целевую версию), history.
7. `AnalyticsPage`: фильтры (version, variant, campaign, exclude overrides), карточки totals,
   таблица шагов с барами `reachRate`, таблицы byVariant / byVersion, строка инварианта.
Отчёт: `npx tsc -p tsconfig.web.json` и `npx vite build`.

### T7. Генератор трафика
**Файл:** `scripts/generate-traffic.ts`, экспорт `generateTraffic(opts)` + CLI. Использует `shared/engine`
для честного прохода веток; транспорт — `app.inject` (in-process) или `fetch(url)`.
Параметры и помехи — §10 спеки. Печатает ожидаемые итоги и сравнивает с `GET /api/analytics`
(различие → ненулевой exit code). Подключить к `ensureSeed` при `SEED_ON_BOOT=1`.
Тест: `tests/server/generator.test.ts` — 30 сессий in-memory → `started = 30`, инвариант суммы выполняется,
есть сессии обоих вариантов и ≥ 2 кампаний.

### T8. Docker, деплой, README
`Dockerfile` (multi-stage, `node:22-bookworm-slim`), `.dockerignore`, `render.yaml` (web service, docker,
free, env `SEED_ON_BOOT=1`, `DATA_DIR=/app/data`, health `/api/health`). README: запуск, модель данных,
event schema, правила агрегации, гипотеза A/B, таймлайн, ограничения. Деплой на Render, проверка URL.

### T9. Интеграция
`npm run build && npm start`, ручной прогон: воронка A и B (`?variant=B`), refresh на середине,
back, результат, CTA; админка; дашборд после `npm run seed`. Исправления. `git tag iteration-1`.

### T10. Итерация 2
На проде: загрузить `configs/funnel-v3.json` → Publish → старая сессия (открытая до публикации)
продолжается на v1 → новая на v3: ветка compliance, B без `tool_count`, `recommendation_expanded`
принимается → `npm run seed -- --url <prod>` по v3 → дашборд «версии» → Rollback → новые сессии на v1,
сессии v3 продолжают. Зафиксировать время шагов в README. `git tag iteration-2`.

### T11. Документация процесса
`docs/process.md` — декомпозиция, агенты, ревью, отклонения, таймлайн. `docs/interview-notes.md`
(шпаргалка) — вне репозитория, отдельным файлом пользователю.
