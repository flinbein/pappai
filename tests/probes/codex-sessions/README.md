# История двух APP с одним профилем

Проверка запускает два настоящих процесса Codex CLI 0.170.0 с разными `CODEX_HOME`. Оба читают один сгенерированный фиктивный `auth.json`. Локальная имитация Responses API проверяет Bearer-заголовок и возвращает события SSE.

На Linux x86_64 задайте `CODEX_DIST` равным абсолютному пути к `package/vendor/x86_64-unknown-linux-musl` распакованного официального пакета `@openai/codex@0.170.0-linux-x64`. Из корня pappai запустите в POSIX shell:

```sh
(
  set -eu
  volume=$(docker volume create)
  trap 'docker volume rm "$volume" >/dev/null' EXIT
  for stage in create restore; do
    docker run --rm --network none \
      -v "$volume:/persist" -v "$CODEX_DIST:/opt/codex:ro" \
      -v "$PWD/tests/probes/codex-sessions:/probe:ro" node:24-alpine \
      node /probe/run.mjs /opt/codex/bin/codex "$stage" /persist
  done
)
```

Первый контейнер записывает по одному ходу каждой APP. В следующем контейнере `thread/list` возвращает каждой APP только её thread, попытка `thread/resume` по чужому ID завершается ошибкой, а собственный ID восстанавливает обе реплики. Фикстура также проверяет, что следующий запрос модели содержит только собственный маркер истории. Граница проверки — видимость истории по API при раздельных каталогах. Ограничение прямого доступа к файлам требует отдельной песочницы.
