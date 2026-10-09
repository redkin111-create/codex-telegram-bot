# Codex Remote Mini App — запуск дома без VPS

Codex Remote работает **на том же Windows-ноутбуке**, что и Telegram-бот
Codex. Отдельные серверы и открытые порты домашнего роутера не требуются.

Как это работает:

```text
Telegram Mini App на телефоне
      | HTTPS
Постоянный адрес: https://codex.example.com
      | Cloudflare Tunnel (исходящее соединение с ноутбука)
      v
127.0.0.1:3301 — Mini App + API на ноутбуке
      | локальная связь с внутренним одноразовым секретом
Codex Telegram Bot -> Codex app-server -> локальные проекты
```

**После единовременной настройки** всё запускается автоматически вместе
с существующим ботом при входе в Windows. Тот же Windows Scheduled Task
запускает бота, Mini App, локальный API и, если задан конфиг, cloudflared.
При завершении процесса бота дочерний туннель завершается. При
неожиданном выходе cloudflared автоматически перезапускается.

## 1. Обнови бота на домашнем ноутбуке

В PowerShell внутри **исходного форка**:

```powershell
git pull --ff-only origin main
npm ci
npm run service -- status
```

Если бот уже автоматически запускается при входе в Windows, новая TMA
будет запускаться той же службой. Переустанавливать автозапуск не нужно.
Если бот ещё не установлен:

```powershell
npm run service -- install
```

В Windows запуск привязан к **входу пользователя** (Scheduled Task или
папка автозагрузки), а не к моменту включения ноутбука до входа в систему.

## 2. Включи локальную TMA

Добавь в существующий конфиг бота
`%USERPROFILE%\.codex\tg\.env` (фактическое расположение можно
уточнить через диагностическую команду бота):

```dotenv
TMA_LOCAL=true
TMA_PORT=3301
TMA_PUBLIC_URL=https://codex.example.com
```

Адрес `codex.example.com` — **пример, замени на свой HTTPS-домен**.
Локальный шлюз слушает *только* `127.0.0.1`, не `0.0.0.0`.
Пользователи автоматически берутся из существующего
`ALLOWED_USERS`; для локального режима **НЕ НУЖНЫ**
`TMA_GATEWAY_URL`, `TMA_OWNER_IDS` или `TMA_AGENT_TOKEN`.
Секрет внутреннего транспорта генерируется заново при старте бота.

При отсутствии туннеля `http://127.0.0.1:3301` работает на самом
ноутбуке для диагностики, но Telegram на телефоне не может открыть его
из интернета. Telegram Mini App в обычном режиме нужен **HTTPS**.

## 3. Один раз настрой Cloudflare Tunnel

Нужен домен с DNS, управляемым Cloudflare. Подойдёт собственный поддомен,
например `codex.yourdomain.ru`. Установи `cloudflared` по официальной
инструкции:
https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/

В PowerShell:

```powershell
cloudflared tunnel login
cloudflared tunnel create codex-remote
cloudflared tunnel list
cloudflared tunnel route dns codex-remote codex.example.com
```

После `create` Cloudflare сообщит **UUID туннеля** и путь к JSON-файлу
учётных данных. Создай
`%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: UUID-ТВОЕГО-ТУННЕЛЯ
credentials-file: C:/Users/ТВОЙ-ПОЛЬЗОВАТЕЛЬ/.cloudflared/UUID-ТВОЕГО-ТУННЕЛЯ.json
ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:3301
  - service: http_status:404
```

Проверь конфиг:

```powershell
cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" ingress validate
```

Теперь добавь в `.env` бота:

```dotenv
TMA_TUNNEL_CONFIG=C:/Users/ТВОЙ-ПОЛЬЗОВАТЕЛЬ/.cloudflared/config.yml
# Только если cloudflared не находится в PATH:
# TMA_CLOUDFLARED_BIN=C:/Cloudflared/bin/cloudflared.exe
```

**Важно:** не устанавливай *дополнительно* `cloudflared service install`,
если используешь автозапуск через бота: иначе два процесса туннеля будут
стартовать одновременно. Выбирай один способ — вместе с ботом
**или** самостоятельную службу Cloudflare. Не добавляй Cloudflare
`cert.pem` и файлы `*.json` с учётными данными в Git.

Если у тебя пока нет домена на Cloudflare, TMA уже будет работать локально,
но постоянную кнопку Mini App с телефона настроить нельзя до появления
доступного HTTPS-адреса.

## 4. Запусти и привяжи Telegram

```powershell
npm run service -- restart
```

Проверь `https://codex.example.com/api/health` — поле `online: true`
появится, когда ноутбук и локальный агент подключились.
В BotFather у своего бота настрой **Menu Button** на
`https://codex.example.com`. Также можно использовать `/app`
в приватном чате с ботом: она показывает кнопку открытия Mini App.

## 5. Поведение после перезапуска

- Вход в Windows -> тот же бот запускается скрыто в фоне.
- Внутри процесса автоматически запускается локальный HTTPS-*origin* API
  (сам API — HTTP на loopback; внешний HTTPS обеспечивает Cloudflare).
- Если настроен `TMA_TUNNEL_CONFIG`, cloudflared также запускается и
  восстанавливает соединение после обрыва.
- Когда ноутбук спит, выключен или теряет интернет, TMA и Codex недоступны
  до восстановления подключения. Бот не может выполнять работу в спящем
  режиме.
- Ошибка старта TMA выводится в лог, но **не блокирует обычный Telegram-бот**.

## Безопасность и ограничения

- Telegram `initData` проверяется на сервере по HMAC на каждом запросе;
  доступа по одному знанию HTTPS-адреса недостаточно.
- Список владельцев совпадает с `ALLOWED_USERS` в локальном боте.
- Codex и все его токены остаются на ноутбуке.
- Не нужно пробрасывать порт 3301 на роутере.
- Используй длинный HTTPS-домен, защищённую Cloudflare-учётную запись,
  а главное — держи Bot API токен приватным.
- Codex Desktop может удерживать активный writer; в таком случае TMA умеет
  читать историю, но не перехватывает тот же поток принудительно.
- UI пока обновляет данные каждые ~6 секунд; WebSocket, diff viewer,
  встроенные разрешения и загрузка файлов будут отдельным этапом.

## Совместимость со старой схемой VPS

Старая схема не удалена. Если `TMA_LOCAL` **не задан или false**, то бот
по-прежнему может запускать исходящий Mini App агент через
`TMA_GATEWAY_URL` и `TMA_AGENT_TOKEN`. Отдельный gateway запускается
командой `npm run tma:gateway` на любом сервере. Для твоей домашней
установки этот режим не требуется.
