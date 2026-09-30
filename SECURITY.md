# Security / Безопасность

## English

Keep all real credentials and runtime data outside this checkout. The setup script stores the bot token and relay key with Windows DPAPI. On the server, keep configuration, webhook secrets, the private catalog and locks outside the public document root. Limit database and filesystem access to the service account. HTTPS is required for the relay.

An authorized Telegram user can see local chat titles/results and send instructions to Codex with that chat's existing permissions. Additional users share the same chat catalog. Only authorize trusted users. Telegram receives messages, images and audio; local recognition does not make Telegram transport private from Telegram.

Never attach tokens, configuration files, DPAPI blobs, databases, logs, chat transcripts or downloaded media to a public issue. Describe a problem with synthetic examples. For a security flaw, use GitHub's private vulnerability reporting on this repository when available. If credentials have been exposed, revoke/rotate them at the provider; removing a file from the latest commit does not remove it from Git history.

The notification redactor is limited, and this community bridge relies on internal desktop APIs. It is not a security boundary between Telegram users or a substitute for Codex permissions.

## Русский

Храните настоящие секреты и рабочие данные вне репозитория. Скрипт установки защищает токен бота и ключ релея через Windows DPAPI. На сервере настройки, секрет webhook, каталог чатов и блокировки должны находиться вне публичного корня сайта. Ограничьте доступ к базе и файлам учётной записью сервиса. Релей требует HTTPS.

Разрешённый пользователь Telegram видит названия и результаты локальных чатов и отправляет в Codex инструкции с разрешениями соответствующего чата. Дополнительные пользователи используют общий каталог. Добавляйте только доверенных людей. Сообщения, изображения и аудио проходят через Telegram; локальное распознавание не скрывает их от Telegram.

Не прикладывайте к публичным issues токены, настройки, DPAPI-файлы, базы, журналы, переписку и вложения. Используйте вымышленные примеры. Об уязвимостях сообщайте через приватный механизм GitHub этого репозитория, если он доступен. При утечке отзовите или замените секрет у провайдера: удаление файла из последнего коммита не удаляет его из истории Git.

Фильтр секретов в уведомлениях ограничен, а мост использует внутренние API приложения. Он не обеспечивает изоляцию пользователей Telegram и не заменяет разрешения Codex.
