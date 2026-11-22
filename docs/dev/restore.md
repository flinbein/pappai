# Восстановление двух томов

Том `platform` содержит базу SQLite и данные платформы. В `workspace` лежат пользовательские файлы. Снимайте оба тома после остановки контроллера. Храните архив в закрытом каталоге оператора: в базе есть учётные записи и действующие веб-сессии.

Пример для Linux с Compose из этого репозитория. В каталоге проекта создайте архив.

```sh
umask 077
mkdir -p backups
docker compose stop controller
docker compose run --rm --no-deps -v "$PWD/backups:/backup" controller \
  tar czf /backup/workspace.tgz -C / var/lib/pappai workspace
docker compose start controller
```

Для проверки разверните ту же версию на отдельной тестовой установке с **двумя новыми пустыми томами**. Поместите архив в её каталог `backups` и распакуйте до запуска контроллера.

```sh
docker compose run --rm --no-deps -v "$PWD/backups:/backup:ro" controller \
  tar xzf /backup/workspace.tgz -C /
docker compose up -d controller
```

Проверьте файл с известным содержимым в `/workspace`, дерево нод, действующий манифест и вызов метода. Для проверки прежнего passkey браузеру нужен исходный RP ID и допустимый origin. Автоматический тест использует временные тома и тестовый passkey. Он останавливает один контейнер и открывает второй с восстановленными данными по прежнему адресу. [Браузерная проверка](../../tests/browser-acceptance.mjs)

Чтобы связать образ с версией, в чистой копии репозитория выполните `docker build --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" -t "pappai:$(git rev-parse --short HEAD)" .`. Для точного восстановления сохраняйте выпущенный образ или digest в реестре вместе с архивом: базовый образ Alpine и его пакеты могут обновиться.
