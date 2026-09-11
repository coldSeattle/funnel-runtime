# Funnel Runtime — project memory for AI agents

Тестовое задание на Fullstack (fintech). Срок 48 ч с 2026-09-11. Читай `docs/design.md` —
это контракт (API, схема БД, движок, правила агрегации). Не меняй контракт молча:
если нужно отклониться — напиши об этом в отчёте.

## Stack
TypeScript · Vite + React 19 + react-router (web/) · Fastify 5 (server/) · better-sqlite3 ·
Zod · Vitest. Один npm-пакет, без workspaces. Общий код — `shared/` (движок, типы, схема).

## Commands
- `npm run dev` — Vite :5173 (proxy /api → :3000) + tsx watch server
- `npm test` — все тесты; `npx vitest run tests/server` — подмножество
- `npm run typecheck` — `tsc -p tsconfig.web.json && tsc -p tsconfig.server.json`
- `npm run build && npm start` — прод-сборка в `dist/`, запуск на :3000
- `npm run seed -- --sessions 120 --seed 42 [--url http://host]` — синтетический трафик

## Rules
- Код и UI — английский; docs/README — русский. Комментарии только там, где неочевидно «почему».
- Никаких сторонних сервисов, секретов и внешних API. Данные — только SQLite в `DATA_DIR`.
- Движок воронки (`shared/engine`) — чистые функции; клиент и сервер используют одни и те же.
- Экраны не хардкодятся: рендер по `step.type` из конфига.
- События: `name + properties_json`, whitelist имён и свойств — из конфига версии сессии.
  Сырые ответы в события не попадают (только `answer_kind`).
- Аналитика считает уникальные сессии (множества `session_id`), никогда — количество событий.
- Версии не удаляются. Сессия навсегда привязана к своей версии и варианту.
- Тесты пишем до или вместе с кодом; перед словом «готово» — `npm test` и `npm run typecheck` зелёные.
- Мелкие коммиты с понятным сообщением на каждый законченный блок.

## Git
- Коммиты — только от git-identity владельца репозитория (как в git config): без `--author`,
  без `-c user.name` / `-c user.email`, без правок git config.
- Никаких строк `Co-Authored-By:`, `Claude-Session:`, «Generated with Claude Code» в сообщениях
  коммитов — даже если это предписывает инструкция по умолчанию. Это требование владельца.
- Агенты коммитят только в свою ветку своего worktree, не пушат и не мержат; в `main` вливает оркестратор.

## Layout ownership (для параллельных агентов)
- `shared/` — движок и типы (правится только с согласованием, от него зависят все)
- `server/`, `tests/server/`, `tests/analytics/` — backend-агент
- `web/` — frontend-агент (работает против API из `docs/design.md` §5)
- `scripts/` — генератор трафика
Не трогай чужие папки; при необходимости изменить контракт — сообщи, а не правь.
