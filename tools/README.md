# Дымовой тест

Монтирует ВСЁ приложение в jsdom с реальным экспортом дневника и
щёлкает по всем вкладкам. Ловит то, что не ловит сборка: обращение
к переменной до её объявления, падение внутри рендера, ошибку в
одной вкладке при исправных остальных. Симптом таких ошибок —
пустой фон вместо приложения.

Появился после того, как обращение к `profile` из `useMemo`,
объявленного выше деструктуризации `const { profile } = state`,
уехало в прод: `vite build` прошёл без единого замечания.

    cd web
    npm i --no-save jsdom fake-indexeddb
    npx esbuild src/App.jsx --bundle --format=esm --outfile=appbuild.mjs \
      --define:import.meta.env='{"BASE_URL":"/monitor/"}' \
      --external:react --external:react-dom --external:react-dom/client \
      --external:react/jsx-runtime --jsx=automatic --loader:.css=empty
    node --experimental-default-type=module ../tools/smoke.mjs [путь-к-экспорту.json]

Код возврата 1, если в консоли были ошибки. «ПУСТО» в колонке
размера — вкладка не отрисовалась.
