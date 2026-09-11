# Funnel Runtime — дизайн системы

Дата: 2026-09-11. Статус: утверждён, является контрактом для реализации.
Задание: `docs/assignment.pdf`. Конфиги: `configs/funnel-v1.json`, `configs/funnel-v3.json`.

## 1. Цель и рамки

Мини-платформа для запуска, версионирования и анализа многошаговых веб-воронок:
воронка рендерится из JSON-конфига, версии конфигов публикуются и откатываются без
деплоя, внутри версии работает A/B-эксперимент, все действия пользователя уходят в
собственный endpoint событий, дашборд считает метрики по уникальным сессиям.

Не делаем: визуальный редактор конфигов, авторизацию пользователей, мультитенантность,
сторонние сервисы (аналитика, облачные БД, auth-провайдеры).

## 2. Стек и структура

- TypeScript везде. Frontend: Vite + React 19 + react-router. Backend: Node 22 + Fastify 5.
- Хранилище: SQLite через `better-sqlite3`, файл в `DATA_DIR` (по умолчанию `./data`).
- Валидация: Zod (конфиг воронки, тела запросов, события). Тесты: Vitest.
- Один процесс: Fastify отдаёт `/api/*` и статику собранного фронта. Один Docker-образ.
- Один npm-пакет без workspaces:

```
configs/      funnel-v1.json, funnel-v3.json
shared/       types.ts, api.ts (DTO), schema.ts (zod), engine/*  — общий код клиента и сервера
server/       index.ts (запуск), app.ts (buildApp), db.ts, errors.ts, repos/, services/, routes/, seed.ts
web/          main.tsx, api.ts, tracker/ (core.ts, browser.ts), funnel/, admin/, styles.css
scripts/      generate-traffic.ts, traffic/ (генератор), iteration2-check.ts, iteration2/ (приёмка v3)
tests/        engine/, server/, analytics/, web/, helpers/
docs/         design.md, plan.md, process.md, iteration2-prod-run.md, assignment.pdf
```

Язык кода и интерфейса — английский (как конфиг), документация — русский.

## 3. Движок воронки (`shared/engine`)

Чистые функции без побочных эффектов; одинаково используются клиентом (рендер,
валидация, прогресс) и сервером (проверка состояния, расчёт результата, whitelist событий).

```ts
resolveVariant(config, variant): ResolvedFunnel
// steps: Step[] в порядке variants[variant].stepSequence, с применёнными stepOverrides (deep merge);
// results: Record<id, ResultDef> с применёнными resultOverrides (deep merge).

evaluateCondition(cond, answers): boolean
// leaf: { answer, operator, value }; composite: { any: [] } | { all: [] }.
// Операторы: eq neq in not_in contains gt gte lt lte.
//   eq/neq — строгое сравнение скаляров; in/not_in — скаляр входит в массив value;
//   contains — ответ-массив содержит value (для строкового ответа — равенство);
//   gt/gte/lt/lte — числовое сравнение.
// Отсутствующий ответ → false для любого оператора.

visibleSteps(resolved, answers): Step[]
// Идём по последовательности; visibleWhen шага вычисляется только по ответам
// РАНЕЕ видимых шагов. Ответы скрытых шагов игнорируются. Условие вправе ссылаться
// только на предыдущие шаги последовательности.

effectiveAnswers(resolved, answers): Answers   // ответы только видимых шагов
validateAnswer(step, value): { ok: true, value } | { ok: false, message }
// required; number: min/max/step, целое при step=1; multi: minSelections/maxSelections;
// значения опций должны существовать. Сообщения берём из validation.messages,
// иначе дефолтные английские.

progress(resolved, answers, currentStepId, config.progress): { index, count } | null
// countVisibleOnly + excludeTypes → «Question 2 of 6». null для info/result.

nextStepId(resolved, answers, stepId) / prevStepId(...)   // по видимым шагам
computeResult(resolved, answers): ResultDef
// первое правило resultRules, где evaluateCondition(effectiveAnswers) === true,
// иначе results[defaultResultId]. Результат берётся из resolved.results (с override варианта).

allowedEvents(config): Map<eventName, Set<propertyName>>
// имя события → разрешённые свойства (events.allowed[i].properties). Базовые поля
// (event_id, session_id, …) не являются properties.
```

`shared/schema.ts` — Zod-схема `FunnelConfig` с инвариантами: все id в `stepSequence`
существуют в `steps`; в каждой последовательности ровно один шаг типа `result` и он последний;
`resultRules[].resultId` и `defaultResultId` существуют в `results`; веса вариантов > 0.
Неизвестные поля не отбрасываются (`passthrough`) — конфиг хранится как есть.

## 4. Модель данных (SQLite)

```sql
funnels          (funnel_id PK, active_version INTEGER NULL)
funnel_versions  (funnel_id, version, config_json, created_at, published_at NULL, PK(funnel_id, version))
version_history  (id PK AUTOINCREMENT, funnel_id, action 'publish'|'rollback', from_version NULL, to_version, at)
sessions         (id PK, funnel_id, version, variant, experiment_id, assignment_source 'server'|'override',
                  utm_source, utm_medium, utm_campaign, answers_json, current_step_id, result_id,
                  created_at, updated_at, expires_at)
events           (event_id PK, session_id, name, client_timestamp, server_timestamp,
                  funnel_id, funnel_version, experiment_id, variant, assignment_source, step_id,
                  utm_source, utm_medium, utm_campaign, properties_json)
индексы: events(session_id), events(name), events(funnel_version, variant)
```

- Версии никогда не удаляются. Активная версия — указатель `funnels.active_version`.
- Номер версии берётся из конфига (`version`), уникален в рамках воронки. Поле `status`
  конфига игнорируется: статус определяет БД (active / published / draft).
- Сессия навсегда хранит `version` и `variant`. Ответы живут в сессии, не в событиях.
- События — `name TEXT` + `properties_json`: новое событие (v3: `recommendation_expanded`)
  не требует миграции. Список разрешённых имён и свойств берётся из конфига версии сессии.
- `PRAGMA journal_mode = WAL`. Схема создаётся `CREATE TABLE IF NOT EXISTS` при старте.

## 5. API

Все ответы JSON. Ошибки: `{ error: { code, message, details? } }`.

| Метод и путь | Назначение |
|---|---|
| `GET /api/health` | `{ ok: true, activeVersion }` |
| `POST /api/sessions` | Создать сессию на активной версии. Тело `{ utm?: {source?, medium?, campaign?}, query?: Record<string,string>, variantOverride?: string, clientTimestamp?: string }`. Клиент передаёт все query-параметры страницы; сервер берёт override из `variantOverride`, иначе из `query[config.experiment.overrideQueryParam]`, а UTM — из `utm`, иначе из `query.utm_*`. Override применяется, если это ключ `experiment.variants`, иначе взвешенный random. Пишет событие `session_started` (event_id генерирует сервер). 201 `{ session, config }`. 503, если нет активной версии. |
| `GET /api/sessions/:id` | `{ session, config }` — конфиг **версии сессии**, даже если она уже не активна. 404 нет, 410 истекла. |
| `PUT /api/sessions/:id/state` | Тело `{ answers, currentStepId }`. Проверка: шаг есть в последовательности варианта; каждый ответ проходит `validateAnswer`. 200 `{ session }`, 400 с деталями. |
| `POST /api/sessions/:id/result` | Считает результат движком, сохраняет `result_id`. 200 `{ result }`. |
| `POST /api/events` | Пачка событий (см. §7). Всегда 200 с постатусным ответом, если тело — валидный объект с массивом `events` (≤ 500), иначе 400. |
| `GET /api/admin/versions` | `{ funnelId, activeVersion, rollbackTarget, versions: [{ version, title, releaseNote, status, createdAt, publishedAt, sessions }] }`; `rollbackTarget` — версия, на которую уйдёт следующий Rollback, или `null` |
| `POST /api/admin/versions` | Тело — сырой конфиг. Zod-валидация (400), дубликат номера (409). 201 `{ version }`. |
| `POST /api/admin/versions/:version/publish` | Сделать активной. 404 нет версии, 409 уже активна. Запись в history. |
| `POST /api/admin/rollback` | Отменить последнюю публикацию. Журнал `version_history` работает как стек: publish кладёт версию, rollback снимает; цель — версия под вершиной. 409 `nothing_to_rollback`, если некуда. |
| `GET /api/admin/history` | Список publish / rollback по времени. |
| `GET /api/analytics` | Query: `version`, `variant`, `utm_campaign`, `excludeOverrides=1`. См. §8. |

`SessionDto`: `{ id, funnelId, version, variant, experimentId, assignmentSource, utm: {source, medium, campaign}, answers, currentStepId, resultId, createdAt, expiresAt }`.

Ответы publish и rollback: `{ activeVersion, fromVersion }` (`ActivationResponse`), upload — `{ version }`.
Коды ошибок: 400 `invalid_body` / `invalid_config` (details — issues Zod) / `unknown_answer` / `invalid_answer` /
`unknown_step` / `invalid_filter` / `batch_too_large`; 401 `unauthorized`; 404 `session_not_found` /
`version_not_found`; 409 `version_exists` / `funnel_mismatch` / `already_active` / `nothing_to_rollback`;
410 `session_expired`; 503 `no_active_version`. POST с `content-type: application/json` и пустым телом допустим.
Кроме того: 404 `not_found` — неизвестный маршрут; 413 `payload_too_large`; 415 `unsupported_media_type`;
500 `internal` / `config_missing`; прочие 4xx — `bad_request`. Причины отказа отдельного события в пачке:
`invalid_shape`, `unknown_session`, `unknown_event`, `unknown_step`, `invalid_properties`.

Если задан `ADMIN_TOKEN`, маршруты `/api/admin/*` требуют заголовок `x-admin-token`. По умолчанию не задан, чтобы проверяющие могли жать Publish / Rollback.

## 6. Сессии, версии, A/B

- Новая сессия — только на активной версии. Старая сессия продолжает на своей версии
  после публикации новой и после отката: `GET /api/sessions/:id` отдаёт её конфиг.
- TTL = `config.session.ttlHours` (72 ч). Истёкшая сессия → 410 → клиент создаёт новую.
- Клиент хранит в `localStorage` только `sessionId` и очередь неотправленных событий.
  Refresh / новая вкладка → `GET` сессии → тот же шаг и ответы.
- `?variant=B` в URL → новая сессия с принудительным вариантом, `assignment_source = 'override'`.
  Если у сохранённой сессии уже этот вариант — переиспользуем её. Без параметра —
  сохранённая сессия как есть.
- Вариант меняет порядок шагов (`stepSequence`), тексты (`stepOverrides`) и результат
  (`resultOverrides`). Все события несут `funnel_version`, `experiment_id`, `variant`.

### Гипотеза эксперимента (для README)

Вариант B снижает трение на входе и делает результат конкретнее: intro обещает время
(«2-minute team check»), первым идёт лёгкий single-select `work_mode` вместо числового
`team_size`, заголовок результата сформулирован как персональный вывод, CTA —
«See the 30-day action list». Ожидание: B доводит до результата и до клика CTA большую
долю начавших. **Основная метрика:** доля сессий с `cta_clicked` среди начавших воронку.
Вторичные: intro → первый вопрос, доля дошедших до результата, CTR среди увидевших
результат. Guardrail: среднее число `back_clicked` на сессию.

## 7. События

Схема входящего события (клиент → сервер):

```ts
{ event_id: uuid, session_id: string, name: string, client_timestamp: ISO-8601,
  step_id?: string | null, properties?: Record<string, unknown> }
```

Сервер сам проставляет `server_timestamp`, `funnel_id`, `funnel_version`, `experiment_id`,
`variant`, `assignment_source`, `utm_*` из сессии — клиенту эти поля не доверяем.

Обработка пачки `POST /api/events { events: [...] }` — каждое событие независимо:

1. Zod-проверка формы → иначе `rejected: invalid_shape`.
2. Сессия существует → иначе `rejected: unknown_session`.
3. `name` есть в `events.allowed` конфига версии сессии → иначе `rejected: unknown_event`.
4. `step_id` — `null` или шаг варианта этой сессии → иначе `rejected: unknown_step`.
5. `properties` фильтруются по whitelist свойств события; лишние ключи молча отбрасываются
   (так сырые ответы не попадают в аналитику: разрешён только `answer_kind`). Значения — только скаляры
   (строка до 200 символов, число, boolean, `null`), `answer_kind` — одно из `single | multi | number` →
   иначе `rejected: invalid_properties`.
6. `INSERT OR IGNORE` по `event_id` → `accepted` или `duplicate`.

Ответ: `{ accepted, duplicates, rejected, results: [{ event_id, status, reason? }] }`.
Повторная отправка той же пачки (retry после таймаута) даёт только `duplicate` — безопасно.

События и кто их пишет:

| Событие | Кто | Когда | properties |
|---|---|---|---|
| `session_started` | сервер | создание сессии | — |
| `step_viewed` | клиент | показ видимого шага (каждый показ) | `step_type, visible_step_index, visible_step_count` |
| `answer_submitted` | клиент | валидный ответ отправлен | `answer_kind` (`single` / `multi` / `number`) |
| `step_completed` | клиент | переход вперёд с валидного шага | `next_step_id` |
| `back_clicked` | клиент | переход назад | `destination_step_id` |
| `result_viewed` | клиент | показан результат | `result_id` |
| `cta_clicked` | клиент | клик по CTA результата | `result_id, action` |
| `recommendation_expanded` | клиент, только v3 | раскрыт список рекомендаций после CTA | `result_id, action, source` |

Клиентский трекер (`web/tracker/core.ts` — ядро без DOM, `web/tracker/browser.ts` — обвязка): очередь в `localStorage`, отправка пачкой через
800 мс после первого события или при 10 событиях; при `pagehide` — `sendBeacon`.
Событие удаляется из очереди только после ответа 200; при ошибке сети — повтор с
backoff (1, 2, 4 … 30 с) с теми же `event_id`. Трекер не отправляет события, которых нет
в `allowedEvents(config)` версии сессии.

## 8. Аналитика — правила агрегации

Единица счёта — сессия; каждая метрика — число уникальных `session_id`. Расчёт: выбрать
события по фильтрам (`funnel_version`, `variant`, `utm_campaign`, `assignment_source`),
агрегировать в памяти чистой функцией `aggregate(events, stepOrder)`.

- `started` — есть `session_started`.
- `reached(step)` — есть хотя бы один `step_viewed` со `step_id` (повторные показы и
  возвраты назад схлопываются).
- `completed(step)` — есть хотя бы один `step_completed` со `step_id`.
- `reachedResult` — есть `result_viewed`. `ctaClicked` — есть `cta_clicked`.
- `ctr = ctaClicked / reachedResult`; `primary = ctaClicked / started`.
- `exits(step)` — для сессий из `started` без `result_viewed`: шаг последнего
  `step_viewed` по `(client_timestamp, server_timestamp)`. Сессии без просмотров —
  `exitsBeforeFirstStep`. Инвариант, который показывает дашборд:
  `Σ exits + exitsBeforeFirstStep + reachedResult = started`.
- По шагу выводим: `reached`, `reached / started`, `completed / reached`, `exits`, `exits / reached`.
- Порядок шагов: для выбранной версии (или активной) — `stepSequence` варианта A, затем шаги
  из B, которых нет в A; для «все версии» — конкатенация по возрастанию номера с дедупликацией;
  шаги, встреченные только в событиях, дописываются в конец; строка(и) типа `result` всегда последние.
- Устойчивость: дубли отсекает PK `event_id`; порядок прихода не важен (множества +
  сортировка по времени клиента); возврат назад не создаёт повторного «достижения».
- Сравнения: те же итоги в разрезе `variant` и `funnel_version`. Фильтр `utm_campaign`
  и тумблер «исключить override-сессии».

Ответ `GET /api/analytics`:

```ts
{ filters, options: { versions: number[], variants: string[], campaigns: string[] },
  totals: Totals, steps: StepRow[], exitsBeforeFirstStep: number,
  byVariant: Record<string, Totals>, byVersion: Record<string, Totals>,
  byVersionVariant: Record<string, Record<string, Totals>> }   // A/B внутри каждой версии
Totals = { started, reachedResult, ctaClicked, ctr, primary }
StepRow = { stepId, type, reached, reachRate, completed, completionRate, exits, exitRate }
```

## 9. Frontend

- `/` — воронка. `/admin` — версии. `/admin/analytics` — дашборд. Без хардкода экранов:
  рендер по `step.type` (`info`, `single-select`, `multi-select`, `number`, `result`).
- Состояние: сессия с сервера (`answers`, `currentStepId`); локально только черновик текущего
  ответа. «Continue»: `validateAnswer` → `PUT state` (ответы + следующий шаг) →
  `answer_submitted` + `step_completed`. «Back» (кнопка вверху экрана или системная «назад» телефона/браузера — шаги лежат в истории браузера):
  `PUT state` с предыдущим шагом → после успеха один `back_clicked`.
  `step_viewed` — при каждом показе шага. Кнопка Back браузера — через `history` (если успеем).
- Прогресс из `progress()`. Экран результата: `POST result` со статусами loading / error /
  retry из `content` шага; CTA `expand_recommendation` раскрывает рекомендации;
  если версия разрешает `recommendation_expanded` — отправляем его с `source: 'cta'`.
- Ошибки сети — сообщение и кнопка повтора, состояние не теряется.
- Админка: список версий со статусами и числом сессий, загрузка JSON (файл или вставка),
  Publish, Rollback (с указанием целевой версии), история.
- Дашборд: фильтры, карточки итогов, таблица шагов с барами, A vs B, версии, строка-инвариант.
- Стиль: mobile-first, одна карточка по центру, крупные тап-зоны, чипы для multi-select,
  числовой ввод с единицей. Без UI-библиотек, обычный CSS.

## 10. Генератор трафика

`npm run seed -- --sessions 120 --seed 42 [--url http://host]`. Без `--url` — in-process через
`buildApp().inject`, что позволяет засеять данные при старте (`SEED_ON_BOOT=1`).

- Сессии создаются через реальный API (`POST /api/sessions`), проходят воронку движком
  (`visibleSteps`, `nextStepId`) со случайными валидными ответами → ветки честные,
  состояние сохраняется через `PUT state`, результат — через `POST result`.
- UTM: 4 кампании, 6 пар source/medium; ~8 % сессий с override-вариантом.
- Отвал: вероятность на каждом шаге (intro выше); B имеет встроенный +10 п.п. к клику CTA,
  чтобы сравнение вариантов было видно (задокументировано).
- Помехи: 10 % сессий дублируют 1–2 события внутри пачки; 5 % пачек отправляются дважды;
  10 % пачек перемешаны; 3 % содержат одно битое событие, 2 % — неизвестное событие; часть сессий делает
  `back_clicked`; первые сессии гарантированно покрывают каждый вид помех.
- PRNG по `--seed`, отдельный поток на каждую сессию. Вариант при этом назначает сервер
  случайно (клиент не должен его предсказывать), поэтому итоговые числа между прогонами немного
  различаются. Сверка всё равно точная: генератор считает ожидаемые числа (started,
  reachedResult, ctaClicked по вариантам) из того, что реально отправил, и сравнивает их с
  приростом `GET /api/analytics` до и после прогона. Проверка предполагает, что параллельно нет
  чужого трафика.

## 11. Тесты (Vitest)

| Файл | Проверяет |
|---|---|
| `tests/engine/*.test.ts` | условия (все операторы), видимость и игнор скрытых ответов, валидация, прогресс, правила результата, override варианта |
| `tests/server/versions.test.ts` | upload → publish → rollback; history; 400 на невалидный конфиг; 409 на дубликат номера |
| `tests/server/sessions.test.ts` | пин версии: сессия на v1 живёт после публикации v3; новая — на v3; 410 после TTL; валидация state |
| `tests/server/ab.test.ts` | стабильность варианта; override; распределение ≈ 50/50 на 400 сессиях; версия и вариант в событиях |
| `tests/server/ingest.test.ts` | повторная пачка → duplicate; битое событие не ломает пачку; `recommendation_expanded` отклоняется на v1 и принимается на v3; whitelist свойств |
| `tests/analytics/aggregate.test.ts` | фиксированный сценарий с дублями, возвратами и перемешанным порядком → точные числа и инвариант |

Серверные тесты: `buildApp({ dbPath: ':memory:' })` + `app.inject`.

## 12. Запуск и деплой

- `npm run dev` — Vite (5173, прокси `/api` → 3000) + `tsx watch server/index.ts`.
- `npm test`, `npm run typecheck`, `npm run build` (vite build + esbuild bundle сервера в `dist/`),
  `npm start` — `node dist/server.js`.
- Env: `PORT` (3000), `DATA_DIR` (`./data`), `ADMIN_TOKEN` (опц.), `SEED_ON_BOOT`. Пустая БД всегда получает
  опубликованную v1 (независимо от флага); `SEED_ON_BOOT=1` на БД без сессий — 120 сессий генератора на v1,
  затем сценарий второй итерации (публикация v3, 60 сессий на v3, откат на v1).
- Dockerfile multi-stage на `node:22-bookworm-slim`. Хостинг: Render Web Service (Docker,
  free). Диск на free-тарифе эфемерный → демо-состояние воссоздаётся на старте, реальный
  таймлайн итераций — в git-тегах `iteration-1`, `iteration-2` и README.

## 13. Вторая итерация (v3)

Изменения v3 относительно v1: новая условная ветка `security_constraints`
(`priorities contains compliance`), новый шаг `meeting_hours`, у варианта B удалён
`tool_count`, новые результаты `regulated_scale` и `meeting_heavy`, операторы `contains`
и `gte`, событие `recommendation_expanded`. Движок поддерживает всё это с первой итерации;
итерация 2 — процедура на проде: загрузить v3 → Publish → старая сессия на v1
продолжает → новая сессия на v3 → генератор по v3 → сравнение версий → Rollback → проверка.
Без изменения схемы БД, аналитика v1 и v3 сохраняется.

## 14. Допущения и ограничения

- Порядок событий — по `client_timestamp` (часы клиента), `server_timestamp` как tie-break.
- Одна воронка (`funnel_id` из конфига); схема БД допускает несколько, UI — нет.
- Условия `visibleWhen` могут ссылаться только на предыдущие шаги последовательности.
- Админка открыта, если не задан `ADMIN_TOKEN`.
- События истёкшей сессии принимаются: очередь трекера и `sendBeacon` могут досылать их позже TTL;
  TTL ограничивает продолжение воронки, а не приём аналитики.
- Пустая база на старте всегда получает опубликованную v1; синтетический трафик — только при `SEED_ON_BOOT=1`.
- Free-хостинг: холодный старт до ~1 мин, данные сбрасываются при рестарте (см. §12).
