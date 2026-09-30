<?php
// Copy outside the web root as config.php. Never commit real credentials.
return array(
    'bot_token' => 'REPLACE_WITH_YOUR_BOT_TOKEN',
    'bot_id' => 123456789,
    'owner_user_id' => 123456789,
    'owner_chat_id' => 123456789,
    'bot_role' => 'codex',
    'relay_key' => 'REPLACE_WITH_RANDOM_RELAY_KEY',
    'webhook_url' => 'https://example.com/codex-webhook.php',
    'telegram_table_prefix' => 'codex_telegram_',
    'database' => array(
        'driver' => 'mysql',
        'host' => '127.0.0.1',
        'port' => 3306,
        'database' => 'codex_telegram',
        'charset' => 'utf8mb4',
        'username' => 'codex_telegram',
        'password' => 'REPLACE_WITH_DATABASE_PASSWORD',
    ),
);
