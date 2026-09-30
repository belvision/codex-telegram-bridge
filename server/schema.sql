CREATE TABLE IF NOT EXISTS codex_telegram_state (
 state_key VARCHAR(80) PRIMARY KEY,
 state_value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS codex_telegram_outbox (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_key VARCHAR(120) NOT NULL,
 method VARCHAR(40) NOT NULL DEFAULT 'sendMessage',
 payload MEDIUMTEXT NOT NULL,
 comment_id BIGINT UNSIGNED NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'pending',
 attempts INT NOT NULL DEFAULT 0,
 available_at DATETIME NOT NULL,
 created_at DATETIME NOT NULL,
 telegram_id BIGINT NULL,
 last_error VARCHAR(80) NULL,
 UNIQUE KEY event_key (event_key),
 KEY pending (status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS codex_telegram_routes (
 message_id BIGINT PRIMARY KEY,
 comment_id BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS codex_telegram_relay (
 update_id BIGINT PRIMARY KEY,
 payload MEDIUMTEXT NOT NULL,
 created_at DATETIME NOT NULL,
 acked_at DATETIME NULL,
 KEY pending (acked_at, update_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
