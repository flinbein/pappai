# Файловые запросы исполнителя process

Обработчик отправляет запросы в stdout и читает ответы с тем же локальным строковым `id` из stdin. В `callId` передают системный ID назначения метода. Контроллер сверяет экземпляр исполнителя, назначение, область пути и действующие файловые права. Завершите файловые операции перед успешным ответом на назначение. [Формат выдачи](../../delegated-files.md) · [Транспорт process](process.md)

## Копирование

Для запроса работающего процесса ядро учитывает файловое представление этого экземпляра при запуске и действующие на момент открытия пермиты. Расширение прав получает следующий экземпляр. При сужении прав новые файловые операции ограничиваются сразу. Путь `/tmp` сохраняет привязку к файловой системе выдавшего его исполнителя.

```jsonl
{"id":"copy-1","method":"files.copy","params":{"callId":"call-58","from":{"self":"/tmp/photo.png"},"to":{"caller":"/tmp/photos/result.png"}}}
{"id":"copy-1","result":{"bytesCopied":2097152}}
```

Один запрос копирует один обычный файл между сторонами `self` и `caller`. Контроллер передаёт данные порциями. При выдаче `write` он заменяет содержимое файла назначения целиком. При выдаче только `create` он открывает новое имя эксклюзивно. Источник сохраняется, копирование файла поверх самого себя возвращает ошибку. На стороне `self` используются собственные права исполнителя. Путь должен быть абсолютным, нормализованным, без символических ссылок. Служебные деревья `/proc`, `/dev`, `/sys`, `/run` закрыты.

## Поток

```jsonl
{"id":"file-1","method":"files.open","params":{"callId":"call-58","path":"/tmp/photos/result.png","mode":"create"}}
{"id":"file-1","result":{"handle":"8b3915ca-bad7-40f5-9a93-c68d4b3fbd40"}}
```

В песочнице подключитесь к Unix-сокету `/run/pappai/files`. У доверенного process путь передаётся в `PAPPAI_FILES_SOCKET`. Протокол — HTTP/1.1. Для режима `read` запросите `GET /<handle>`. Для `write` и `create` отправьте `PUT /<handle>` с бинарным телом и корректным `Content-Length` либо с обычным HTTP chunked-кодированием и завершающим нулевым блоком. При успешной записи ответ имеет статус 200 и JSON вида `{"bytesWritten":25401}`. Потоковая запись начинается с нулевого смещения и сохраняет старый хвост файла, если новые данные короче.

```js
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

async function upload(handle, source) {
  const request = http.request({
    socketPath: process.env.PAPPAI_FILES_SOCKET || '/run/pappai/files',
    method: 'PUT', path: '/' + handle
  });
  const result = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', async response => {
      try {
        let text = '';
        for await (const part of response) text += part;
        if (response.statusCode !== 200) throw Error('File rejected: ' + response.statusCode);
        resolve(JSON.parse(text));
      } catch (error) { reject(error); }
    });
  });
  const [, receipt] = await Promise.all([pipeline(createReadStream(source), request), result]);
  return receipt;
}
```

Handle одноразовый и действует на сокете назначенного исполнителя. Закрытие вызова прерывает активные потоки и отзывает неиспользованные handle. Незаконченная запись блокирует успешный ответ метода. После обрыва загрузки завершите вызов ошибкой. На один вызов одновременно допускается до 32 handle и копирований суммарно.
