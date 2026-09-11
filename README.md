# Funnel Runtime

Мини-платформа для запуска, версионирования и анализа многошаговых веб-воронок:
воронка рендерится из JSON-конфига, версии публикуются и откатываются без деплоя, внутри
версии работает A/B-эксперимент, все действия уходят в собственный endpoint событий,
дашборд считает метрики по уникальным сессиям.

- **Публичный URL:** _(будет добавлен после деплоя)_
- **Репозиторий:** https://github.com/coldSeattle/funnel-runtime
- Дизайн системы: [`docs/design.md`](docs/design.md) · план: [`docs/plan.md`](docs/plan.md) ·
  процесс работы с AI-агентами: [`docs/process.md`](docs/process.md) · задание: [`docs/assignment.pdf`](docs/assignment.pdf)

## Локальный запуск

```bash
npm install
npm run dev          # Vite :5173 (проксирует /api) + сервер :3000; при старте публикуется configs/funnel-v1.json
npm test             # Vitest
npm run typecheck
npm run seed -- --sessions 120 --seed 42            # синтетический трафик в локальную БД
npm run build && npm start                          # прод-сборка, http://localhost:3000
docker build -t funnel-runtime . && docker run -p 3000:3000 -e SEED_ON_BOOT=1 funnel-runtime
```

Переменные окружения: `PORT` (3000), `DATA_DIR` (`./data`, файл `funnel.db`), `SEED_ON_BOOT`
(`1` — засеять трафик, если сессий нет), `ADMIN_TOKEN` (если задан, `/api/admin/*` требует заголовок `x-admin-token`).

Страницы: `/` — воронка (`/?variant=B&utm_campaign=…` — override варианта и UTM), `/admin` — версии,
`/admin/analytics` — дашборд.

_Разделы ниже заполняются по ходу работы._

## Стек и архитектура
## Модель данных
## Event schema
## Правила агрегации
## A/B-гипотеза и основная метрика
## Таймлайн итераций
## Ограничения и допущения
