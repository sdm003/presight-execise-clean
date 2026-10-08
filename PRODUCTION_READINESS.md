# Инженерный разбор: best practices и production readiness

**Дата оценки: 7 октября 2026 года.**

Документ описывает текущую локальную рабочую копию приложения, включая ещё не
закоммиченные frontend diagnostics и seed-миграцию. Это разбор конкретных решений
и их ограничений, а не сертификат безопасности, SLA или обещание выдерживать
определённую нагрузку.

## 1. Короткий вывод

У проекта хорошая инженерная база для небольшого directory-приложения:
параметризованный SQL, транзакционные записи, ограниченные очереди, согласованный
GET, обработка конкурентных запросов на фронте, настоящая виртуализация,
идемпотентный seed, диагностика и проверки аварийных сценариев.

Это заметно больше, чем минимальная реализация «Express возвращает JSON, React
рисует список». Наиболее сильные решения связаны не с количеством библиотек,
а с корректностью при ошибках, гонках и повторных действиях.

**Однако публичное приложение с ценными данными пока нельзя считать полностью
production-ready.** В самом API нет аутентификации и авторизации POST/DELETE;
не подтверждены глобальный бюджет соединений, устойчивость под целевой нагрузкой,
операционный мониторинг и восстановление из резервной копии.

Для демо с синтетическими данными приложение имеет хорошую основу. Для реальных
пользователей и данных нужен отдельный эксплуатационный контур.

### Оценка по направлениям

| Направление | Оценка | Что ограничивает вывод |
|---|---|---|
| Архитектура небольшого приложения | Хорошая, соразмерная задаче | Пока один простой домен; это не проверка архитектуры сложной системы |
| Корректность фильтров и сортировки | Хорошая | Nationality facets намеренно отличаются от исходного ТЗ |
| Работа с БД и аварийными сценариями | Хорошая | Ограничения действуют на экземпляр приложения, не на весь deployment |
| Frontend state и запросы | Хорошая | Нет собственного request deadline и универсальной защиты от изменений между страницами |
| Виртуализация и поведение UI | Хорошая для фиксированных карточек | Не измеренная поддержка миллионов загруженных записей или произвольных высот |
| Observability | Полезная базовая реализация | Наличие кода не означает настроенный collector, alerts и serverless delivery |
| Публичные операции записи | Не готово без внешнего контроля доступа | POST и DELETE не проверяют права пользователя |
| CI и воспроизводимость проверки | Есть команды и тесты | В репозитории нет workflow, который принудительно запускает их при изменениях |
| Эксплуатационная готовность | Частичная | Backups, restore, региональность и capacity planning не подтверждены |

Здесь намеренно нет оценки «8/10» или «готово на 90%»: без заданных SLO,
модели угроз и условий эксплуатации такие числа создают ложную точность.

## 2. Что именно оценивалось

Проверены исходники сервера и клиента, миграции, Docker-конфигурация, документация
и существующие проверки. Graphify использован для навигации по связям;
выводы сверены с исходниками, поскольку граф не включает автоматически каждое
новое изменение.

Последний commit на момент оценки: `040e68b`. GET optimization и серверные
operation logs входят в него. Frontend diagnostics, автоматический локальный
seed-startup и новая миграция пока находятся в рабочей копии.

Seed уже применён к используемой deployed-базе: прежние 1000 известных
синтетических записей заменены новым набором в одной транзакции. Это **не означает**,
что незакоммиченный startup-код или frontend diagnostics уже задеплоены.

В рамках этого документа production-настройки платформы не менялись, новые
нагрузочные тесты не запускались и данные не удалялись.

### Что нельзя подтвердить чтением репозитория

Нельзя автоматически подтвердить права production-роли БД, настройки gateway,
TLS фактического подключения, резервные копии, их восстановление, retention логов,
регион функций относительно БД, доставку spans и настроенные alerts.

Фраза «в коде предусмотрено» ниже не равна фразе «в production это настроено».

## 3. Архитектура: разделение ответственности без лишних слоёв

Поток серверного запроса:

```text
HTTP middleware -> users routes -> users service -> repository -> PostgreSQL
                        |
                  error mapping / logs / tracing
```

Routes отвечают за HTTP, service — за validation и orchestration,
repository — за SQL. Pool и transaction helper централизуют работу с ресурсами.
`createApp`, `createRepository` и `createDatabase` допускают подстановку
зависимостей в тестах.

Это помогает проверять бизнес- и HTTP-контракты без настоящей БД, а SQL отдельно
проверять на PostgreSQL. При этом нет ORM ради нескольких запросов, универсального
repository framework, event bus или глобального state manager.

Для текущего размера проекта это разумнее, чем архитектура с десятками
формальных интерфейсов, которые ничего не изолируют.

**Ограничение:** небольшой service layer сейчас тонкий. Его польза — общая
валидация, наблюдаемость и граница для будущей логики, а не сама по себе
«трёхслойная архитектура».

Источники: [HTTP app](server/src/http/app.js#L15-L54),
[routes](server/src/modules/users/routes.js#L4-L34),
[service](server/src/modules/users/service.js#L5-L27),
[repository](server/src/modules/users/repository.js#L6-L96).

## 4. Backend: какие best practices действительно соблюдены

### 4.1. Валидация находится на серверной границе

Создание пользователя проверяет все шесть полей, длины строк, возраст,
массив из 0–10 различных хобби, control characters и протокол avatar URL.
Разрешены HTTP(S)-адреса без встроенных credentials.

Сервер не полагается на то, что UI отправит правильные данные. Можно заменить
клиент, отправить запрос вручную или получить ошибку в frontend-коде — правила
останутся на стороне API.

Дополнительно ограничен JSON body до 32 KiB, проверяется Content-Type,
а malformed JSON и неподдерживаемые encoding получают явные HTTP-ошибки.
Admission расположен до разбора тела API-запроса, поэтому уже перегруженный
экземпляр не обязан сначала парсить новый большой payload.

**Боль простой реализации:** validation только в форме, отсутствие лимита body,
принятие отрицательного возраста, дубликатов hobbies или произвольных URL-схем.

**Граница защиты:** это validation данных, не проверка прав. Для query-параметров
часть некорректных значений нормализуется или заменяется defaults; не каждый
невалидный параметр обязан возвращать 400.

Источники: [validation](server/src/modules/users/validation.js#L3-L58),
[HTTP boundaries](server/src/http/app.js#L25-L38),
[error mapping](server/src/http/middleware/errors.js#L6-L40).

### 4.2. SQL injection и расширение поиска — разные проблемы

Значения фильтров передаются SQL-параметрами. Поле сортировки выбирается из
allowlist, а направление преобразуется только в ASC или DESC.

Отдельно экранируются `%`, `_` и backslash в LIKE-поиске. Это важно:
параметризация защищает структуру SQL, но сама по себе не запрещает пользователю
непреднамеренно расширить поиск через wildcard.

Повторные `hobby` и `nationality` параметры не разбиваются по запятым.
Значение `Arts, crafts` остаётся одним hobby, а не двумя фильтрами.

**Боль простой реализации:** безопасно параметризовать WHERE, но подставить
произвольный sort; считать, что SQL-параметры решают семантику LIKE; использовать
CSV без поддержки запятых внутри значения.

Источники: [query builder](server/src/modules/users/query.js#L9-L59),
[regression checks](server/test/api.test.js#L68-L148).

### 4.3. Модель данных сохраняет целостность

Пользователи и хобби находятся в отдельных связанных таблицах. Foreign key
не позволяет создать hobby для несуществующего пользователя.
Составной primary key запрещает повтор одного hobby у одного пользователя.
Удаление пользователя каскадно удаляет его хобби.

Возраст дополнительно ограничен CHECK на уровне БД. Серверная validation и
ограничения БД дополняют друг друга: первое даёт понятную ошибку API,
второе защищает данные от других способов записи.

**Ограничение:** максимум 10 hobbies и ограничения текстовых полей полностью
не дублируются database constraints. Прямая запись в БД может обойти эти правила.
Это следует учитывать при выдаче прав внешним writer-процессам.

Источник: [initial schema](server/src/database/migrations/001-initial.sql#L1-L13).

### 4.4. Фильтры и сортировка имеют явную семантику

Nationalities объединяются через OR, hobbies — через AND. Search и обе группы
фильтров применяются совместно. Сортировка всегда заканчивается `id ASC`.

Без tie-breaker пользователи одного возраста или с одинаковой фамилией могут
менять порядок между запросами даже без изменений данных. Это приводит к
повторам и пропускам на границах страниц.

Здесь проблема нестабильной сортировки закрыта. API также возвращает page,
limit, total и hasMore, чтобы UI не пытался угадать конец списка по своей логике.

**Граница гарантии:** детерминированный ORDER BY не замораживает всю выборку между
разными HTTP-запросами. При concurrent writes OFFSET остаётся подвижным.

Источники: [filter semantics](server/src/modules/users/query.js#L20-L45),
[tie-breaker](server/src/modules/users/query.js#L55-L59),
[pagination](server/src/modules/users/repository.js#L52-L59).

### 4.5. GET — один round trip и один согласованный snapshot

Страница, total и facets вычисляются одним SQL statement с CTE. Вместо семи
последовательных команд с BEGIN/COMMIT и отдельными SELECT сервер отправляет
один запрос, а PostgreSQL использует один statement snapshot.

Это сокращает сетевые round trips и не удерживает соединение между несколькими
отдельными командами. Особенно полезно, когда функции и БД находятся далеко
друг от друга.

Хобби собираются внутри SQL для возвращаемых пользователей: нет N+1 отдельных
запросов из JavaScript на каждую карточку.

**Боль простой реализации:** COUNT уже видит новую запись, page ещё нет;
facets рассчитаны в другой момент; 40 карточек создают 40 дополнительных queries.

**Важно:** один запрос не равен дешёвому запросу. Exact COUNT, facets, JOIN,
materialization и deep OFFSET всё ещё требуют работы БД. Реальное улучшение
latency нужно измерять, а не выводить только из количества statements.

Источники: [single-statement GET](server/src/modules/users/repository.js#L7-L63),
[one-query check](server/test/operations.test.js#L140-L185).

### 4.6. Transaction helper учитывает ошибки самого cleanup

Создание user и hobbies выполняется атомарно. При ошибке есть rollback,
а соединение освобождается в finally.

Более тонкая защита: ошибка rollback или release не подменяет исходную ошибку
операции. Соединение после определённых отказов discard-ится, чтобы его
не получил следующий запрос.

Pool wrapper также слушает ошибки уже выданного client: обработчик idle pool
не покрывает весь жизненный цикл leased connection.

**Боль простой реализации:** пользователь создан без hobbies; connection leak
постепенно останавливает приложение; вторичная ошибка cleanup скрывает причину;
сломанный client возвращается в pool.

Источники: [transaction](server/src/database/transaction.js#L6-L38),
[leased clients](server/src/database/pool.js#L53-L101),
[failure tests](server/test/operations.test.js#L958-L1072).

### 4.7. Backpressure вместо неограниченного накопления работы

Есть два разных ограничения: HTTP admission и bounded database acquisition.
По defaults HTTP допускает до 64 in-flight API-запросов, а pool — 5 соединений
и 20 дополнительных операций acquisition. При превышении capacity возвращается
503 вместо бесконечной очереди.

Указаны connection, statement, lock и idle-in-transaction timeouts.
Ошибки перегрузки получают `Retry-After: 1`.

Неочевидная деталь: закрытый браузерный socket не освобождает admission token,
пока repository продолжает работу. Иначе клиентские отмены позволили бы
накопить больше активных SQL-операций, чем предполагает лимит.

**Это не distributed rate limiter.** Все счётчики локальны экземпляру.
При N экземплярах потенциальный бюджет соединений растёт вместе с N.
Увеличить `PG_POOL_MAX` без расчёта общего бюджета — не универсальное решение.

Также отмена fetch в браузере не гарантирует cancellation уже выполняющегося SQL.

Источники: [configuration](server/src/config/index.js#L31-L83),
[bounded pool](server/src/database/pool.js#L19-L51),
[admission lifetime](server/src/http/middleware/admission.js#L1-L36),
[aborted request check](server/test/operations.test.js#L796-L838).

### 4.8. Startup, readiness и shutdown продуманы отдельно

`/api/live` показывает, что HTTP-процесс отвечает, без обращения к БД.
`/api/ready` и `/api/health` проверяют доступность БД через SELECT 1.
При draining readiness-запросы проходят через admission и могут быть отклонены,
а liveness остаётся доступной.

Standalone server проверяет БД до начала listening. Graceful shutdown переводит
приложение в draining, перестаёт принимать новую работу, закрывает сервер,
pool и telemetry. Есть deadline, уничтожение зависших connections и ненулевой
exit code при аварии. Повторные сигналы не запускают несколько shutdown-процедур.

**Боль простой реализации:** контейнер выглядит healthy при недоступной БД;
SIGTERM обрывает записи; shutdown бесконечно ждёт pool.end; приложение продолжает
работать после uncaughtException в потенциально повреждённом состоянии.

**Ограничения:** readiness проверяет соединение, не полную пригодность схемы.
HTTP listener timeouts не являются deadline всей business-операции.
Lifecycle собственного Node-сервера не следует приписывать serverless-функциям.

Источники: [health routes](server/src/http/app.js#L26-L50),
[runtime lifecycle](server/src/runtime/lifecycle.js#L15-L101),
[side-effect-free import](server/src/index.js#L1-L15).

## 5. Миграции и seed: важные защиты от потери данных

Setup использует ledger `schema_migrations` и schema-scoped advisory lock.
Миграции выполняются в транзакции, поэтому неуспешная операция не отмечается
как успешно применённая.

Seed создаёт 1000 различных комбинаций имени и фамилии, 32 nationalities
и 0–10 разных hobbies из 32 значений. Набор детерминированный:
он полезен для повторяемых демонстраций и проверок, но не моделирует реальную
статистику населения.

Миграция заполняет только пустую таблицу users. Дополнительный table lock
согласует эту проверку с обычными API writes, а не только с другими миграциями.
Попытка второго запуска не создаёт ещё 1000 человек.

Если users уже содержит данные, seed пропускается, а версия фиксируется.
Если после этого удалить записи, рестарт не восстановит их автоматически.
Это намеренно: seed — начальная загрузка, а не механизм отмены пользовательских
удалений.

`npm start` использует npm prestart; Docker запускает setup, затем `exec` Node.
Прямой запуск `node server/src/index.js` и импорт приложения Vercel не выполняют
миграции. Для Vercel нужен deployment/release step `npm run setup`.

**Почему это зрелее простого seed:** нет truncate при каждом старте, нет
дублирования при параллельных стартах, нет зависимости от внешнего API,
нет полузаполненной базы после ошибки insert hobbies.

**Ограничение:** это seed для exercise/demo. В продукте с реальными клиентами
демо-данные обычно отдельно включают для нужных окружений. Новые тяжёлые DDL
нельзя без анализа продолжать добавлять в startup; особенно это касается
операций, требующих долгих блокировок или выполнения вне transaction.

Источники: [migration runner](server/src/database/migrate.js#L6-L34),
[seed](server/src/database/migrations/003-demo-seed.sql#L1-L42),
[prestart](server/package.json#L10-L16),
[Docker startup](Dockerfile#L20-L22),
[seed safety checks](server/test/database.test.js#L93-L238).

## 6. Frontend: корректность важнее количества useMemo

### 6.1. Search работает с реальным вводом, а не только с ASCII-печатанием

Raw input отделён от применённого search. Нормализованное значение отправляется
после debounce 300 ms. Во время IME composition промежуточные символы не
превращаются в запросы.

Эквивалентное нормализованное значение не создаёт новую применённую фильтрацию.
Это полезнее, чем просто поставить таймер вокруг каждого onChange.

**Боль простой реализации:** запрос на каждый символ; результаты по промежуточному
IME-вводу; новая загрузка после добавления пробелов без изменения смысла поиска.

Источники: [search hook](client/src/hooks.js#L9-L19),
[composition events](client/src/components/Hero.jsx#L14-L23).

### 6.2. Abort дополняется проверкой актуальности ответа

При смене query используется AbortController. Но одного abort недостаточно:
ответ может уже прийти или продолжить обработку на границе render/effect.

Поэтому проверяются active effect и текущий request key. Старый ответ не должен
переписать результаты нового фильтра. Busy flag синхронно ограничивает загрузку
одной страницы, не полагаясь только на асинхронный React state.

Это закрывает типичный сценарий: медленный запрос «Ava» приходит после более
быстрого запроса «Zoe» и возвращает UI назад к старым данным.

**Оставшаяся боль:** у fetch нет собственного deadline. Если ответ долго не
приходит и фильтр не меняется, loading может затянуться. Нужен согласованный
request timeout с понятной пользовательской ошибкой, а не blanket catch.

Источник: [request lifecycle](client/src/hooks.js#L33-L147).

### 6.3. JSON проверяется до использования в интерфейсе

`validatePage` проверяет structure, id, дубликаты внутри страницы, ожидаемый page,
limit, total, hasMore, длину страницы и форму facets.

HTTP 200 с неправильным JSON не считается успешным directory response.
Это полезно при несовпадении версий client/server, malformed responses и ошибках
самого API. Такая проверка также делает ошибки понятнее, чем случайное падение
на `user.hobbies.map`.

**Граница:** это не исчерпывающая JSON Schema validation и не TypeScript.
Например, API имеет более строгие правила avatar URL и hobbies, чем текущий
response validator клиента. Нельзя заявлять полностью идентичную validation
с обеих сторон.

Источник: [response validator](client/src/users.js#L1-L55).

### 6.4. Infinite scroll учитывает изменение dataset

Клиент сохраняет seen IDs. Если следующая OFFSET-страница пересекается с уже
показанными данными или total изменился, загрузка начинается заново со страницы 1.
Некорректная первая страница уже приводит к error, а не к бесконечному restart.

Retry возобновляет неуспешную страницу. Ошибка второй страницы не заставляет
пользователя терять весь ранее загруженный список.

**Боль простой реализации:** двойной запрос из IntersectionObserver;
append дубликатов; бесконечный restart; retry с неправильного offset.

**Но это эвристика, не snapshot между страницами.** Изменения без overlap и
изменения total могут остаться незамеченными. Cursor pagination или versioned
snapshot нужны, если продукт требует строгой стабильности при concurrent edits.
Сам cursor тоже не замораживает меняющиеся значения sort-полей.

Источник: [pagination recovery](client/src/hooks.js#L80-L140).

### 6.5. Виртуализация действительно ограничивает DOM

В DOM попадает только видимое окно users с overscan. Общая высота контейнера
сохраняет корректную геометрию scroll, а положение окна рассчитывается отдельно.

Scroll listener passive; несколько событий объединяются через
requestAnimationFrame. Layout geometry читается при изменении layout, а не
безусловно на каждом scroll. ResizeObserver обновляет расчёт при изменении
размера. Если окно осталось прежним, новое React state не устанавливается.

Точечные memo и стабильные ссылки дополнительно уменьшают лишние render-операции,
но здесь основной выигрыш — не memo сам по себе, а bounded DOM и разумный
measurement lifecycle.

**Границы реализации:** высота карточки фиксирована — 142 px; произвольный
wrapping потребует measured rows. Загруженные users и seen IDs остаются в памяти:
виртуализация ограничивает DOM, не весь JavaScript heap.

Виртуальный список также требует отдельной проверки screen reader,
keyboard navigation и поведения browser Find: отсутствующие в DOM карточки
не становятся автоматически доступными этим механизмам.

Источники: [row window](client/src/virtual.js#L1-L22),
[virtual cards](client/src/components/Results.jsx#L5-L78).

### 6.6. State updates и URL не создают лишнюю работу

Фильтры обновляются функционально, поэтому последовательные действия используют
актуальное состояние. `changeState` сохраняет identity для эквивалентного patch.
Request key основан на сериализованном query, а не на новом object в каждом render.

Search, hobbies, nationalities, sort и direction кодируются через
URLSearchParams. Повторные ключи совпадают с форматом API. Reload/shared URL
восстанавливают состояние.

**Ограничения:** используется replaceState, а не история каждого изменения
фильтра; полноценного восстановления через popstate нет. Нормализация выбранных
строк не полностью идентична server trim для неканонических URL.

Источники: [state helpers](client/src/state.js#L6-L48),
[functional toggles](client/src/App.jsx#L16-L51).

### 6.7. UX и accessibility имеют полезную базу

Есть initial loading skeleton, loading следующей страницы, empty state,
явная ошибка с retry и отдельное состояние reloading. Старые данные намеренно
остаются видны во время обновления, а результаты помечаются busy.

Используются native controls, fieldset/legend, labels, aria-expanded,
aria-controls, role=alert и role=status. На mobile sidebar раскрывается кнопкой;
сетка становится одноколоночной. Есть reduced-motion styling.

Карточка показывает максимум два hobbies и `+n`. Images имеют размеры,
lazy loading, async decoding и no-referrer.

**Граница:** семантическая разметка — не полный accessibility audit. Нужны
ручные проверки keyboard/focus, screen reader и контраста. Нет fallback для
сломанных avatars; внешний image host остаётся зависимостью, а no-referrer
не отменяет сам запрос браузера к этому host.

Источники: [results states](client/src/components/Results.jsx#L111-L137),
[filters](client/src/components/Facet.jsx#L3-L35),
[mobile controls](client/src/App.jsx#L82-L109),
[cards](client/src/components/UserCard.jsx#L3-L43),
[responsive CSS](client/src/style.css#L518-L585).

## 7. Observability: что видно и что пока не видно

### Сервер

Есть server-generated request UUID, final HTTP status/duration и контекст
AsyncLocalStorage для промежуточных logs даже без включённого tracing.

GET spans имеют понятную цепочку:

```text
GET /api/users
  users.service.list
    users.repository.list
      db.acquire
      db.query
```

Это не автоматическая запись каждого вызова функции. Инструментируются важные
границы; `code.function.name` помогает соотнести операцию с методом.
Spans вложены, поэтому их durations нельзя просто складывать.

`http.failed` включает method, route, status и локальные pool counters.
Коды `DB_QUEUE_FULL`, `DB_POOL_CLOSED`, `DB_ACQUIRE_FAILED` и sanitized causeCode
дают больше информации, чем одно `{ type: "AppError" }`.

SQL, query values, body и произвольные error messages/stacks не сериализуются
в эти диагностические записи. Это снижает риск перенести секреты и персональные
данные из БД в отдельную logging-систему.

### Клиент

API failures имеют page, HTTP status, duration и допустимые server request/trace
IDs. ErrorBoundary, uncaught errors и unhandled rejections дают именованные
события. Обычные cancellations и stale responses не объявляются ошибками.

Успешные запросы, retry и dataset restart логируются через debug в development
или production build с `VITE_DEBUG_LOGS=true`. Никаких дополнительных HTTP
запросов для доставки этих событий сейчас нет.

### Что нельзя считать закрытым

Browser Console не является Vercel Runtime Logs или централизованным RUM.
Response trace ID позволяет найти серверный запрос, но это ещё не полноценный
distributed trace с browser spans.

OpenTelemetry по умолчанию выключен. При enabled без exporter endpoint spans
не уходят во внешнюю систему. Batch exporter ограничивает очередь и timeout,
но его delivery при serverless freeze нужно отдельно подтверждать.

Trace sampling не уменьшает число Pino operation logs: они сейчас пишутся
на info. При большом RPS надо оценить объём, стоимость и retention.
HTTP admission возвращает 503 напрямую и не имеет такого же отдельного reason
code, как ошибки pool — диагностика отказов пока не абсолютно одинаковая.

Источники: [request context](server/src/http/middleware/request-log.js#L4-L29),
[safe logger](server/src/observability/logger.js#L6-L66),
[tracing/export](server/src/observability/tracing.js#L25-L128),
[client diagnostics](client/src/diagnostics.js#L1-L69),
[admission rejection](server/src/http/middleware/admission.js#L3-L7).

## 8. Проверки: сильная сторона, но не замена CI и production monitoring

В последних выполненных проверках этой рабочей копии:

| Проверка | Результат | Что это доказывает |
|---|---|---|
| Server tests с изолированным PostgreSQL | 45 passed, без skipped | Проверенные HTTP, SQL, lifecycle и seed-сценарии работают в тестовом окружении |
| Client unit tests | 7 passed | URL/state, window math, response validation и diagnostics выдерживают указанные проверки |
| Локальный k6 test suite | 4 passed | Конфигурация, contract checks, cleanup и threshold failures работают на тестовом HTTP-сервере |
| Browser suite, обычный production build | Passed | Проверяемые scrolling, states, URL, recovery и error diagnostics работают в Chrome |
| Browser suite, development StrictMode | Passed | В том числе cleanup/cancellation и verbose diagnostics |
| Browser suite, opt-in production debug | Passed | Build-time debug flag действительно меняет diagnostic output |
| Frontend production build | Passed | Клиент собирается |
| Локальный npm startup с новой БД | GET вернул total=1000 | prestart действительно применяет schema и seed до обслуживания запросов |

Это результаты предыдущих проверок в этой сессии, а не новый benchmark при
написании документа. Подсчёт server tests включает integration subtests.

Особенно полезны тесты, которые не ограничиваются happy path: connection failure,
rollback/release failure, aborted clients, shutdown deadline, секреты в errors,
повторные миграции, ошибочный seed, устаревший search и changing dataset.

**Недостающие гарантии:** без `TEST_DATABASE_URL` PostgreSQL integration
пропускается; нет настроенного repository workflow в `.github/workflows`.
Browser suite использует mock API и существующий Chrome, а не доказывает
работоспособность всей deployed-системы на всех браузерах.

Команды для воспроизведения и prerequisites находятся в README. Изолированный
тестовый schema не повод запускать тесты на production database: использовать
следует отдельную disposable БД.

Источники: [server operations tests](server/test/operations.test.js),
[real DB tests](server/test/database.test.js#L25-L76),
[client units](client/test/units.test.mjs),
[client diagnostics checks](client/test/diagnostics.test.mjs),
[browser checks](client/test/browser.mjs),
[validation commands](README.md#validation).

## 9. Производительность: что измерено, а что только предполагается

Есть локальный k6 runner с arrival-rate сценариями, response contracts, p95/p99,
error thresholds и проверкой dropped workload iterations.
Это лучше, чем сравнивать только average latency или считать удачным любой run,
который «дошёл до конца».

Однако `load-test/` целиком исключён из Git по принятому решению.
Свежий clone не содержит этот runner, binary и исторические reports.
Нагрузочную часть нельзя называть полностью воспроизводимым deliverable
репозитория без отдельной передачи инструментов.

### Исторические measurements до текущей GET optimization

| Run | Workload | Workload errors | Read p95 | Dropped workload iterations |
|---|---|---|---|---|
| `2026-10-07T13-40-59-528Z` | Baseline до 5 iterations/s, hold 240 s | 26.27% | 7545 ms | 9 |
| `2026-10-07T14-15-18-843Z` | Baseline до 1 iteration/s, hold 20 s | 0% | 1767 ms | 0 |

Во втором run было только 24 workload requests. В первом — 1340 workload
requests; 1355 total HTTP requests включали также setup/warmup.
Числа здесь относятся к tagged workload metrics, а не ко всем scenarios.
В k6 rate metric `http_req_failed` положительный event означает failure:
названия `passes`/`fails` его счётчиков не следует читать как обычные HTTP successes.

Источники measurements — локальные `summary.json` с этими run IDs в
`load-test/reports/`; эти artifacts не входят в Git. Оба отчёта имеют
`revision: null`, поэтому они не обеспечивают воспроизводимую привязку к commit.

**Нельзя утверждать, что новая версия выдерживает 4 requests/s без ошибок.**
Default RATE=4 — настройка генератора, не результат capacity test.
Новый GET и новый seed требуют повторного baseline на актуальном deployment.
Короткий успешный run на 1 RPS также не доказывает длительную устойчивость.

### Что продолжает ограничивать масштаб

Contains search использует ILIKE по составному имени. Текущие B-tree indexes
не заменяют trigram index для этого выражения. Exact counts и facets требуют
обработки активной выборки; LIMIT 20 ограничивает output facets, не работу
агрегации. Deep OFFSET дорожает с ростом пропускаемой части.

Проверять нужно query plans на реалистичном dataset, DB/network latency,
pool queue и суммарные connection limits всех экземпляров. Frontend performance
отдельно требует measurements на более слабом устройстве: HTTP k6 не измеряет
React rendering, layout и память браузера.

Источники: [search SQL](server/src/modules/users/query.js#L32-L41),
[GET query](server/src/modules/users/repository.js#L23-L49),
[current indexes](server/src/database/migrations/002-query-indexes.sql#L1-L6),
[local tooling exclusion](.gitignore#L40-L43).

## 10. Docker и deployment

Dockerfile использует multi-stage build, `npm ci`, production dependency pruning
и non-root user. В runtime image копируются server source и собранный frontend.
Setup завершается до HTTP startup; `exec` передаёт termination signals Node.

Compose ждёт readiness PostgreSQL через healthcheck и использует named volume.
Обычный `docker compose down` не удаляет persisted data. `down -v` удаляет volume
и потому не является командой обычного restart.

**Что остаётся вне этой конфигурации:** API container healthcheck/restart policy
в Compose не заданы; base images указаны tags, не digest; restore practice,
resource budgets и cloud rollout strategy не подтверждены.
Последняя правка CMD проверена через startup-семантику и Compose configuration,
но свежий end-to-end build/run Docker image в последних проверках не выполнялся.

`.dockerignore` исключает основной `.env`, но не все возможные секретные
файлы окружения. Также local-only load-test artifacts не исключены из build
context этим файлом. Runtime COPY сужает набор итоговых файлов, однако это
не отменяет необходимости контролировать содержимое build context.

На Vercel приложение экспортируется без listen и runtime signal handlers.
Значит, самостоятельный graceful shutdown и local prestart нельзя автоматически
считать свойствами serverless deployment. Нужен отдельно организованный
release/setup step и подтверждённая стратегия telemetry delivery.

Источники: [Dockerfile](Dockerfile#L1-L22),
[Compose](docker-compose.yml#L1-L27),
[build context exclusions](.dockerignore),
[server entrypoint](server/src/index.js#L1-L15),
[Vercel routing](vercel.json#L3-L26).

## 11. Какие «боли новичковой реализации» здесь закрыты

Это не оценка людей по должности. Таблица сравнивает распространённый
happy-path вариант с защитами конкретного приложения.

| Типичная проблема | Что сделано здесь | Оставшаяся граница |
|---|---|---|
| Старый search response перезаписывает новый | Abort + current query + active effect | Нет собственного fetch deadline |
| Observer одновременно грузит одну страницу дважды | Синхронный busy guard | Отдельные UI-сессии всё равно создают отдельные запросы |
| Нестабильный порядок одинакового возраста | Финальный `id ASC` | Concurrent writes могут сдвинуть OFFSET |
| COUNT, page и facets относятся к разным моментам | Один SQL statement snapshot | Между страницами общего snapshot нет |
| Hobbies на карточках порождают N+1 queries | Сбор hobbies внутри SQL | Общая стоимость SQL всё равно зависит от dataset |
| Хобби созданы частично | Общая transaction с user insert | Прямые внешние writers должны соблюдать ограничения |
| Ошибка cleanup скрывает исходную причину | Сохранение primary error, отдельные cleanup logs | Нужна настроенная эксплуатационная доставка logs |
| Закрытый socket «освободил capacity», но SQL ещё работает | Admission держит token до завершения repository | Браузерный abort не отменяет SQL |
| Длинная очередь съедает память | Bounded acquisition и HTTP admission | Лимиты не глобальны |
| Десятки тысяч DOM nodes | Настоящее virtual window | Загруженные records остаются в JS memory |
| Layout читается на каждом scroll | Cached geometry + rAF + passive listener | Fixed-height ceiling и устройство пользователя |
| IME создаёт запросы по незавершённым символам | Composition-aware debounce | Нужны дальнейшие usability checks для целевой аудитории |
| 200 с неправильным payload ломает render | Runtime page validation | Не полная schema validation |
| При изменении dataset появляется бесконечный restart | Recovery только для следующих страниц, первая может fail | Не обнаруживаются абсолютно все изменения |
| Фильтр пропал из top-20 и его нельзя снять | Выбранные значения сохраняются в controls | Sidebar может включать выбранные значения сверх top-20 |
| Seed дублируется или стирает реальные записи | Ledger, locks, empty-table guard | Demo data следует отделять от реального продуктового окружения |
| SIGTERM убивает активный процесс без cleanup | Drain, bounded shutdown, close pool/telemetry | Работает для standalone lifecycle, не автоматически для Vercel |
| Error logs содержат SQL, пароль и search | Sanitized metadata и allowlists | Не заменяет policies всех внешних collectors |
| Console и server logs невозможно связать | Server requestId и response traceId | Browser tracing/centralized error collection пока отсутствуют |

## 12. Намеренные компромиссы и соответствие исходному упражнению

Технически хорошее решение может не соответствовать конкретному контракту.
Production readiness и exercise compliance — разные оси оценки.

**PostgreSQL вместо SQLite.** Persisted source of truth есть, но исходное ТЗ
требует SQLite. Сам факт большей привычности PostgreSQL в deployment не
делает эту замену соблюдением задания.

**Статичные nationality choices.** Их counts учитывают search и hobbies,
но игнорируют selected nationalities и могут включать глобальные нулевые values.
Это сознательно сохраняет доступность чекбоксов. Исходное ТЗ требует top-20
именно текущего result set по всем фильтрам. Для строгого соответствия нужны
другие facets, независимо от качества общей архитектуры.

**Seed теперь есть.** Он находится в миграции проекта, пока не закоммиченной,
не зависит от наличия ранее вручную заполненной deployed-базы и рассчитан
на свежий запуск. При этом база всё ещё PostgreSQL.

**Фиксированные карточки и replaceState.** Это разумные ограничения небольшого
directory. Они должны оставаться явно описанными, а не выдаваться за
универсальную виртуализацию и полноценную browser history navigation.

Источники: [database choice](server/package.json#L19-L28),
[nationality scope](server/src/modules/users/repository.js#L10-L14),
[global values](server/src/modules/users/repository.js#L38-L44),
[selected choices](client/src/components/Facet.jsx#L16-L21).

## 13. Что блокирует production с реальными данными

### P0: перед публичной эксплуатацией

**Контроль операций записи.** Routes POST и DELETE не проверяют identity или
permissions. CORS ограничивает часть browser-сценариев, но не является
аутентификацией. При отсутствии отдельного gateway-контроля публичные данные
можно изменять без проверки прав.

Это сознательное текущее поведение; в рамках документа token обратно не
добавлялся. Подход для production нужно выбрать явно: gateway identity,
application authorization либо отключённые публичные writes для read-only demo.

**Backup и restore.** Недостаточно иметь volume или managed database.
Нужен подтверждённый backup, проверенный restore и понятные RPO/RTO.
Таких доказательств в исходниках нет.

**Release и реальное состояние deployment.** Незакоммиченные diagnostics и
startup changes ещё не равны deployed features. Миграции должны выполняться
контролируемым deployment step, а runtime credentials — иметь только нужные права.
TLS фактического production connection также нужно подтвердить: проверка
certificate включается при TLS-конфигурации, но сам `PG_SSL=true` не обязателен
по defaults.

Источники: [write routes](server/src/modules/users/routes.js#L14-L34),
[CORS](server/src/http/middleware/cors.js#L5-L27),
[TLS configuration](server/src/config/index.js#L50-L82).

### P1: устойчивость и эксплуатация

Нужно определить целевой read/write workload, выполнить повторный baseline
актуального deployment, stress/recovery и достаточно длительный run.
Одновременно наблюдать pool, DB connections, SQL latency и HTTP errors.

Нужны общий connection budget всех serverless instances, regional alignment,
alerts по availability/error/latency, централизованный frontend error reporting
и проверенная доставка OTLP spans.

Client request deadline должен завершать loading понятной ошибкой.
SQL optimization нужна по измеренному plan и cost, а не добавлением indexes
«на всякий случай». CI должен выполнять тесты с реальным disposable PostgreSQL,
чтобы интеграционный skip не создавал ложное ощущение проверки SQL.

При необходимости cross-origin DELETE следует согласовать CORS allow-methods:
сейчас объявлены GET, POST и OPTIONS. Это отдельный API consistency пункт,
не средство ограничения прав на удаление.

### P2: качество по мере роста продукта

Следующие улучшения оправданы требованиями и measurements, а не количеством
«best practice» библиотек: measured rows, memory/page retention, avatar fallback,
keyboard/screen-reader audit, shared runtime schemas, browser performance
telemetry, CSP для принятой модели внешних ресурсов.

Cursor или snapshot strategy нужны только при требовании более строгой
pagination consistency. Polling/SSE нужны, если требуется видеть внешние writes
без refresh. Сейчас live-update механизма в клиенте нет.

## 14. Как принять решение «готово к запуску»

Production gate должен быть конкретным, а не «все тесты зелёные».

| Критерий | Проверяемое доказательство |
|---|---|
| Права на writes определены | Проверки, что запрещённые операции отклоняются, а разрешённые проходят |
| Потеря данных контролируется | Выполненный restore exercise с согласованными RPO/RTO |
| Deployment воспроизводим | Новый environment разворачивается по документации; миграции не дублируются |
| Capacity известна | Repeatable measurements актуального commit с rate, mix, duration и dataset |
| Перегрузка не превращается в неконтролируемый отказ | Ограниченные queues, предсказуемые errors и измеренное восстановление после пика |
| Ошибку можно расследовать | Browser requestId приводит к server operation и DB stage в настроенных системах |
| UI не зависает бесконечно | Проверяемый client deadline, visible retry и отсутствие retry storm |
| Регрессия не попадает в main незаметно | Автоматизированный pipeline с unit, SQL integration и browser checks |
| Контракт согласован | Явно приняты PostgreSQL/nationality-facet deviations либо исправлено исходное ТЗ |

Если команда выбирает p95 < 2 s, p99 < 4 s и errors <= 1%, это сначала
предлагаемые acceptance thresholds. Текущие настройки k6 не превращают их
в уже обеспеченный SLA.

## 15. Что не стоит строить прямо сейчас

Для маленького directory не нужны микросервисы, собственный ORM, универсальная
event-driven платформа, Redis-кеш без измерений или логирование каждого render.
Дополнительный слой способен добавить больше отказов и состояния, чем решить.

Разумный порядок: согласовать контракт и права, сделать deployment/restore
воспроизводимыми, измерить реальные bottlenecks, настроить диагностику, затем
менять только тот механизм, потолок которого достигнут.

В этом смысле сильная сторона текущей реализации — использование native
AbortController, observers, rAF, URLSearchParams, Node AsyncLocalStorage,
PostgreSQL transactions и обычных npm lifecycle scripts вместо самописных
заменителей.

## 16. Как честно представить проект

> Это небольшое full-stack приложение с хорошей защитой от типичных ошибок:
> stale responses, повторных page requests, нестабильной сортировки, частичных
> записей, connection leaks, неконтролируемых очередей и неидемпотентного seed.
> Frontend использует настоящую виртуализацию, а backend — согласованный SQL GET,
> structured diagnostics и проверяемый lifecycle. При этом для production
> с реальными данными ещё нужны контроль writes, эксплуатационный мониторинг,
> restore practice и подтверждённая capacity. PostgreSQL и nationality facets
> являются явными отклонениями от исходного exercise.

Это сильнее и полезнее, чем утверждение «полностью production-ready»:
оно показывает не только использованные приёмы, но и понимание того,
какую гарантию каждый из них даёт — и какую не даёт.
