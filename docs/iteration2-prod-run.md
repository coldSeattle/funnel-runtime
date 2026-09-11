# Вторая итерация на проде — лог прогона

11 сентября 2026, 19:46–19:47 (UTC+5), https://funnel-runtime.onrender.com, коммит `8f29e10`
(тег `iteration-2`). Команда:

```bash
npm run iteration2 -- --url https://funnel-runtime.onrender.com --traffic 60
```

Перед этим свежий деплой сам проиграл тот же сценарий при старте (`SEED_ON_BOOT=1`): история версий
`publish –→1 | publish 1→3 | rollback 3→1`, на дашборде v1 — 122 сессии, v3 — 62. Поэтому v3 уже была
загружена, и скрипт проверил, что сохранённая v3 совпадает с `configs/funnel-v3.json`, прежде чем публиковать.

Время в логе — UTC.

```text
Iteration 2: upload v3, publish, verify, roll back to v1 (times are UTC)
✓ 14:46:05 precondition — v1 is active (stored: v1 active, v3 published); analytics baseline v1 122, v3 62 sessions started
✓ 14:46:06 old session starts on v1 — S1 8aff6d7a on v1/A: intro → team_size answered, state saved on work_mode; 5 events accepted
✓ 14:46:06 v3 uploaded — v3 is already stored from an earlier run (409 version_exists) and matches configs/funnel-v3.json (title, release note); publishing it again
✓ 14:46:06 v3 published — POST /api/admin/versions/3/publish → { activeVersion: 3, fromVersion: 1 }
✓ 14:46:07 old session continues on v1 — GET S1 → config v1; resumed on work_mode with 1 stored answer(s), finished to result async_native (a v1 result); 17 events accepted
✓ 14:46:07 new event is version-scoped — recommendation_expanded for S1 → rejected: unknown_event (v1 does not allow it)
✓ 14:46:09 new session starts on v3 (variant B) — S2 93e1bd9f on v3/B, 10 steps without tool_count; priorities with compliance → security_constraints (strict) → result regulated_scale "Your team needs a compliance-aware operating model"; result_viewed, cta_clicked, recommendation_expanded among 27 events accepted
✓ 14:46:09 v3 variant A keeps tool_count — S3 d0583db9 on v3/A: 11 steps including tool_count and meeting_hours; intro → team_size answered, left mid-funnel on work_mode; 5 events accepted
    Traffic generator: 60 sessions, seed 3
      events sent  1131 (accepted 1087, duplicates 41, rejected 3)
      noise        duplicateInBatch 6, resendBatch 5, shuffled 8, invalidEvent 2, unknownEvent 1
      behaviour    overrides 8, back 7, refresh 5, dropped off 34
                  expected          actual delta
                  start/result/cta  start/result/cta
      total       60 / 26 / 15      60 / 26 / 15      OK
      variant A   32 / 17 / 8       32 / 17 / 8       OK
      variant B   28 / 9 / 7        28 / 9 / 7        OK
    Result: OK, analytics match the simulation
✓ 14:47:19 synthetic v3 traffic — 60 sessions on v3 (seed 3), 1131 events with noise; analytics delta 60/26/15 start/result/cta matches the simulation
✓ 14:47:19 analytics sees both versions — byVersion v1 123/58/22, v3 124/55/29 (started/result/cta); since the precondition v1 +1, v3 +62 (this run: S2, S3 and 60 generated)
✓ 14:47:19 rollback — POST /api/admin/rollback → { activeVersion: 1, fromVersion: 3 }
✓ 14:47:20 v3 session keeps working after rollback — S2 (finished): GET → config v3; PUT state with v3-only answers (security_constraints, meeting_hours) → 200; recommendation_expanded still accepted. S3 (mid-funnel): GET → config v3; answered work_mode → PUT state 200, now on priorities; step_viewed, answer_submitted, step_completed accepted
✓ 14:47:20 new sessions return to v1 — S4 04d52a0f → v1
✓ 14:47:20 no analytics loss — v3 started 124 before and after the rollback, v1 123 → 124; history ends publish 1→3, rollback 3→1; v3 still stored with 124 sessions
Result: OK — 14/14 checks passed
```

Что это доказывает по пункту 8 задания:

| Требование | Проверка |
|---|---|
| Новая условная ветка | S2: `priorities` с `compliance` → появляется `security_constraints` |
| Один экран удалён для варианта B | S2 (v3/B) — 10 шагов без `tool_count`; S3 (v3/A) — `tool_count` на месте |
| Новое событие | `recommendation_expanded` принято для v3 и отклонено для v1 |
| Старые активные сессии работают без ошибок | S1 начата на v1 до публикации и закончена на v1 после; S3 начата на v3 и продолжена после отката |
| Публикация, проверка, откат без ручного изменения схемы | publish → проверки → rollback через API; схема БД не менялась |
| Без потери аналитики | у v3 124 сессии до и после отката, версия и события на месте |

Повторить на свежей БД локально: `npm run iteration2 -- --traffic 60`.
