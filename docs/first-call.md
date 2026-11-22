# Первый вызов метода

Для локальной сборки нужны Docker с поддержкой Linux-контейнеров, Compose и браузер с passkey. Из корня репозитория выполните:

```sh
docker compose up --build -d
docker compose exec controller node src/admin.ts admin owner@example.org
```

Откройте `http://localhost:3000`. В форме «Зарегистрировать passkey» введите email и одноразовый код из терминала, подтвердите создание ключа. При следующих посещениях доступен вход без ввода email. [Регистрация и восстановление](passkeys.md)

В панели выберите `call`. Следующий запрос создаёт остановленную APP непосредственно в workspace. Готовый скрипт входит в образ.

```json
{
  "node": "~",
  "method": "$.app.create",
  "data": {
    "name": "extract-text",
    "permissions": [{"read": "/opt/pappai/examples/extract-text"}],
    "source": {"manifest": {
      "run": {"type":"process","settings":{
        "cwd":"/opt/pappai/examples/extract-text","command":"node","args":["extract.cjs"],
        "features":{"message.extractText":{"type":"method","description":"Убрать пробелы по краям текста","version":"1","schema":{
          "input":{"type":"object","required":["text"],"properties":{"text":{"type":"string"}},"additionalProperties":false},
          "output":{"type":"string"}
        }}}
      }},
      "executors":{"mode":"oneShot","poolSize":1}
    }}
  }
}
```

Скопируйте полученный `id` вместо `APP_ID` и выполните следующие запросы через ту же форму.

| Операция | Параметры JSON | Результат |
|---|---|---|
| `call` | `{"node":"APP_ID","method":"$.app.start"}` | APP переходит в `working` |
| `dir` | `{}` | У видимой APP указан статус |
| `help` | `{"node":"APP_ID","features":"message.**","schemas":"message.**"}` | Описание, версия и схема метода |
| `call` | `{"node":"APP_ID","method":"message.extractText","version":"1","data":{"text":"  Привет  "}}` | Строка `"Привет"` |

Создание TEAM или USER использует соответственно `$.team.create` или `$.user.create` на родителе. У USER укажите `name`, `email` и `permissions`. Запустите его через `$.app.start` и выдайте код командой `otp`. Для примера правила `[{"discover":true}]` разрешают просматривать ноды. Такой USER получит отказ на `message.extractText`. Проверьте его вход в отдельном профиле браузера.

Команда `docker compose stop` останавливает локальную установку. Настройки и учётные записи хранятся в томе `platform`, пользовательские файлы — в томе `workspace`. Профиль Compose выдаёт контейнеру `SYS_ADMIN` и отключает внешний профиль seccomp для создания вложенных пространств имён bubblewrap. Это проверенный профиль локальной сборки. Публичная эксплуатация с минимальными привилегиями требует отдельной проверки конфигурации хоста.
