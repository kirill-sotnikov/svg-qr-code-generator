# QR Code Batch Generator

CLI-программа на TypeScript пакетно создаёт стилизованные SVG QR-коды из CSV, выполняет Clip Release и Path Union через Inkscape, а затем проверяет каждый результат декодированием ZXing.

Файл считается успешным только тогда, когда PNG, растеризованный **из итогового Plain SVG** в размере `--size × --size`, декодируется в строку, точно равную ожидаемому URL. Для URL без HTTP(S)-схемы ожидаемое значение получает префикс `http://`. Для устойчивости ZXing сначала анализирует нативные пиксели, а для очень крупного изображения при необходимости — его уменьшенные sharp-представления без изменения пропорций. PNG служит только для проверки; производственный результат — SVG.

## Требования

- Node.js 20 или новее;
- Yarn Classic 1.22;
- Inkscape 1.2 или новее, доступный как `inkscape` или через `INKSCAPE_BIN`.

Установка Node-зависимостей:

```bash
yarn install
```

### Установка Inkscape

macOS с Homebrew:

```bash
brew install --cask inkscape
inkscape --version
```

Windows с winget (PowerShell):

```powershell
winget install Inkscape.Inkscape
inkscape --version
```

Если каталог Inkscape не добавлен в `PATH`, укажите полный путь:

```powershell
$env:INKSCAPE_BIN = "C:\Program Files\Inkscape\bin\inkscape.exe"
```

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install inkscape
inkscape --version
```

Для нестандартного расположения бинарного файла:

```bash
export INKSCAPE_BIN=/Applications/Inkscape.app/Contents/MacOS/inkscape
"$INKSCAPE_BIN" --version
```

## CSV

Обязательны заголовки `id,url`:

```csv
id,url
product-001,https://example.com/products/001
product-002,https://example.com/products/002?source=qr
product-003,https://example.com/catalog/%D1%82%D0%B5%D1%81%D1%82
```

`id` не может быть пустым или повторяться. Для безопасного и однозначного имени файла разрешены 1–128 ASCII-символов: буквы, цифры, `.`, `_`, `-`; первый символ должен быть буквой или цифрой. Коллизии имён без учёта регистра также запрещены.

Если значение `url` не начинается с `http://` или `https://`, генератор автоматически добавляет `http://`. Уже указанная HTTP(S)-схема сохраняется без изменений.

## Запуск

```bash
yarn gen links.csv
```

По умолчанию рядом с CSV создаётся каталог вида `products-20260720...`. Его имя — имя CSV без `.csv` плюс timestamp.

```bash
yarn gen input.csv --concurrency 3
yarn gen input.csv --size 420
yarn gen input.csv --size=512
yarn gen input.csv --output-dir ./result
yarn gen input.csv --output-dir ./result --overwrite
yarn gen input.csv --diagnostic
```

Параметры:

- `--concurrency N` — число одновременно обрабатываемых записей и процессов Inkscape, по умолчанию 2, максимум 32;
- `--size N` или `--size=N` — одинаковые `width` и `height` исходного SVG QR-кода, по умолчанию 300, допустимо 64–4096;
- `--output-dir DIR` — фиксированный каталог результата вместо автоматически сформированного;
- `--overwrite` — разрешить атомарную замену существующих `final/{id}.svg`;
- `--diagnostic` — сохранить временные каталоги и PNG также для успешных записей.

Если хотя бы одна запись завершилась ошибкой, остальные продолжают обрабатываться, отчёты всё равно создаются, а exit code программы будет ненулевым.

## Каталоги результата

```text
products-<timestamp>/
  raw/
    product-001.svg
  final/
    product-001.svg
  failed/
    product-002/
      source.svg
      released.svg
      converted.svg
      preview-{size}.png
      error.json
  tmp/
  report.json
  report.csv
```

- `raw/{id}.svg` — оригинал от `qr-code-styling`, содержащий clipping paths;
- `final/{id}.svg` — проверенный Plain SVG. Файл появляется здесь только после структурной проверки и точного декодирования PNG размера `--size × --size`;
- `failed/{id}/` — доступные на момент ошибки диагностические артефакты и `error.json` со стадией, stderr/exit code Inkscape и декодированными значениями;
- `tmp/` — уникальные рабочие каталоги записей. После успеха удаляются, кроме режима `--diagnostic`.

Публикация выполняется `rename` внутри одного выходного каталога, поэтому частично записанный SVG не появляется в `final`.

## Обработка SVG

Сразу после `qr-code-styling` исходный SVG без XML-раскрытия clipping paths передаётся в Inkscape. Первый проход выполняет:

```text
select-all:all → object-release-clip → export Plain SVG
```

В освобождённом SVG минимальный квадрат считается размером QR-модуля. Программа находит ID всех служебных квадратов больше модуля, включая прозрачный носитель фона. Второй проход Inkscape выполняет:

```text
select-by-id:<service-square-ids> → delete-selection →
select-all:all → path-union → export Plain SVG
```

После экспорта программа повторно разбирает XML и запрещает clip paths, masks, filters, images, `use`, непреобразованные фигуры, stroke и незамкнутые производственные subpaths. Декодирование итогового SVG дополнительно проверяет сохранность finder patterns, их отверстий и зазоров.

## Отчёты

`report.json` и `report.csv` содержат по каждой записи:

```text
id, expectedUrl, decodedPayload, verificationSize, status,
sourceFile, outputFile, outputFileName, pathCount,
containsClipPath, containsMask, allPathsClosed,
inkscapeVersion, durationMs, errorStage, errorMessage
```

Для успеха `outputFileName` строго равен `{id}.svg`, а `outputFile` — `final/{id}.svg`. `pathCount` показывает количество производственных `<path>` в итоговом SVG.

## Разработка и тесты

```bash
yarn build
yarn lint
yarn test
yarn test:unit
INKSCAPE_BIN=/path/to/inkscape yarn test:integration
```

Интеграционные тесты требуют Inkscape и завершаются ошибкой, если бинарный файл недоступен или не запускается. Они проверяют Clip Release, удаление служебных квадратов, Path Union, Plain SVG, растеризацию, точное декодирование, публикацию только после проверки, несовпадение URL и защиту от перезаписи.

## Вставка SVG в template

Отдельный скрипт заменяет единственный тег `<REPLACE/>` в SVG template на каждый SVG-файл из указанной папки:

```bash
yarn tsx src/insert ./template.svg ./insert-svg-folder/
```

Поддерживаются файлы с расширением `.svg` без учёта регистра. Результаты сохраняются под исходными именами в новом каталоге `rendered-{timestamp}/`, расположенном рядом с переданной папкой SVG. Например, для `./release/final/` результат будет создан как `./release/rendered-{timestamp}/`. Template и исходные SVG не изменяются. Template должен быть корректным SVG/XML и содержать ровно один `<REPLACE/>`; каждый вставляемый файл также должен быть корректным SVG с корневым элементом `<svg>`.
