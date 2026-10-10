# Чужое в репозитории

Код ядра в `src/` написан с нуля, чужих библиотек в нём нет. Чужие файлы лежат только вокруг ядра:
они нужны для страницы-примера и для проверок, в плеер и в формат не входят. Лицензия eCore на них не распространяется.

| Что | Где | Чьё и на каких условиях |
|---|---|---|
| Шрифты Seymour One и Montserrat Bold | `fonts/` | SIL Open Font License 1.1, тексты лежат рядом: `fonts/OFL-SeymourOne.txt`, `fonts/OFL-Montserrat.txt` |
| Стили HeroUI (собраны Tailwind CSS) | `site/heroui.min.css` | MIT, пакет `@heroui/styles` 3.2.6. Нужны только странице-примеру |
| rlottie в wasm | `vendor/rlottie/` | Samsung rlottie, лицензия MIT; внутри него есть части под лицензиями FreeType, Skia, pixman, RapidJSON и stb (тексты в репозитории Samsung/rlottie). Сборка та же, что в редакторе TIER; откуда она взята исходно, в проекте не записано. Нужен только командам `render`, `check` и `conform` для сверки с Telegram |
