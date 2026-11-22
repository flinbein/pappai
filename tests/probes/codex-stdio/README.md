# Проверка stdio MCP под профилем pappai

Тест запускает настоящий Codex 0.170.0 с пустым `CODEX_HOME`. Временный тред передаёт `mcp_servers` через `thread/start.config`. Доверенная обёртка запускает фиксированный MCP-сервер через `sandboxArgs` из [src/sandbox.ts](../../../src/sandbox.ts), передаёт аргументы в bubblewrap через fd 3 и читает статус через fd 4. Клиент получает список инструментов через `mcpServerStatus/list` с `threadId` и вызывает `inspect` через `mcpServer/tool/call`. Тред работает без обращения к модели. Каждый контейнер имеет только loopback и отдельный временный каталог. Для работы достаточно локального пакета Codex, данные аккаунта не нужны.

## Повторный запуск

Из корня проекта в PowerShell соберите Linux-образ через `docker build -t pappai:acceptance .`, если он отсутствует. Получите архив командой `npm pack @openai/codex@0.170.0-linux-x64`, распакуйте и укажите в `$native` путь к его каталогу `package/vendor/x86_64-unknown-linux-musl`. В примере архив распакован в локальном каталоге исследований проекта.

```powershell
$native = (Resolve-Path '.dev/codex-package-probe/0.170.0/package/vendor/x86_64-unknown-linux-musl').Path
$probe = (Resolve-Path 'tests/probes/codex-stdio').Path
$policy = (Resolve-Path 'src/sandbox.ts').Path
foreach ($mode in 'online','offline','codex-eof','codex-kill','denied') {
  $flags = @()
  if ($mode -ne 'denied') { $flags = @('--cap-add','SYS_ADMIN','--security-opt','seccomp=unconfined') }
  docker run --rm --init --network none @flags `
    --mount "type=bind,source=$native,target=/codex,readonly" `
    --mount "type=bind,source=$probe,target=/fixture/tests/probes/codex-stdio,readonly" `
    --mount "type=bind,source=$policy,target=/fixture/src/sandbox.ts,readonly" `
    -e PAPPAI_CODEX_NATIVE=/codex/bin/codex --entrypoint node pappai:acceptance `
    /fixture/tests/probes/codex-stdio/run.mjs $mode
  if ($LASTEXITCODE -ne 0) { throw "Проверка $mode завершилась ошибкой" }
}
```

## Наблюдения 22 ноября 2026

Docker Engine 29.8.1, Alpine 3.24.2 x86_64, Node 24.21.0, bubblewrap 0.12.0. Согласована версия протокола MCP `2025-06-18`. Во всех четырёх успешных подключениях клиент обнаружил и вызвал единственный инструмент `inspect`.

| Режим | Что зафиксировал клиент |
|---|---|
| `online` | При `network:true` MCP прочитал контрольный текст HTTP-сервера на loopback контейнера. После SIGTERM процессу MCP появился маркер `TERM`. |
| `offline` | При `network:false` соединение с тем же адресом завершилось `ECONNREFUSED`. После SIGKILL обёртке завершились процессы в её sandbox. Маркер штатного завершения MCP отсутствовал. |
| `codex-eof` | После закрытия stdin app-server завершился с кодом 0. В этом прогоне маркер обработки EOF/TERM в MCP отсутствовал. |
| `codex-kill` | После SIGKILL app-server сервер MCP получил EOF и завершился. |
| `denied` | Стандартный профиль Docker запретил создание namespace. Bubblewrap завершился с кодом 1, список инструментов пуст, вызов отклонён, маркер запуска исполняемого файла отсутствовал. |

При успешных подключениях MCP прочитал разрешённый файл, получил `EROFS` при попытке изменить его и `ENOENT` для существующего соседнего файла. Контейнер-клиент прочитал результат в разрешённом для записи каталоге. MCP получил явный `FIXTURE_ALLOWED=yes`. Переменная `FIXTURE_OUTER_ONLY` дошла из app-server до обёртки через `env_vars` и отсутствовала внутри MCP, как и `CODEX_HOME`.

Во всех четырёх сценариях остановки тест наблюдал через `/proc` обёртку, bubblewrap, MCP (PID 1 внутри namespace) и один обычный дочерний процесс. Все четыре процесса работали до действия и завершились после него. В сценарии гибели app-server сервер MCP сам обрабатывает EOF. Проверка характеризует именно такой сервер и отдельно проверяет принудительное завершение через известный PID обёртки. Результаты относятся к тестовой обёртке, которая пока не подключена к рабочему раннеру.
