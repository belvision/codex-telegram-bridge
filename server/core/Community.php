<?php
class Community {
    private $db;
    private $config;
    public function __construct($db = null, $config = null)
    {
        $this->db = $db ?: Database::connection();
        $this->config = $config === null ? self::config() : $config;
    }

    public static function config()
    {
        static $config;
        if ($config === null) {
            $path = bridge_private_dir() . '/config.php';
            $config = is_file($path) ? require $path : array();
            if (empty($config['bot_token']) || empty($config['relay_key']) || empty($config['owner_user_id'])
                || (string)$config['owner_user_id'] !== (string)($config['owner_chat_id'] ?? '')) { throw new RuntimeException('invalid-private-config'); }
        }
        return $config;
    }


    public function query($sql, $params = array())
    {
        // A validated prefix keeps this bot's offsets and queues in dedicated tables.
        $prefix = $this->config['telegram_table_prefix'] ?? 'codex_telegram_';
        if (!preg_match('/^[a-z][a-z0-9_]*_$/D', $prefix)) { throw new RuntimeException('invalid-telegram-table-prefix'); }
        $sql = preg_replace('/\bbook_telegram_(state|outbox|routes|relay)\b/', $prefix . '$1', $sql);
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }


    public function state($key, $fallback = '')
    {
        $row = $this->query('SELECT state_value FROM book_telegram_state WHERE state_key=?', array($key))->fetch();
        return $row ? $row['state_value'] : $fallback;
    }

    public function setState($key, $value)
    {
        $this->query('INSERT INTO book_telegram_state VALUES (?,?) ON DUPLICATE KEY UPDATE state_value=VALUES(state_value)', array($key, (string)$value));
    }


    public function queue($key, $text, $commentId = null, $markup = null, $method = 'sendMessage')
    {
        if (empty($this->config['owner_chat_id'])) { return; }
        $payload = array('chat_id'=>$this->config['owner_chat_id'],'text'=>$text,'disable_web_page_preview'=>true);
        if ($markup) { $payload['reply_markup'] = $markup; }
        $this->queuePayload($key, $method, $payload, $commentId);
    }

    public function queuePayload($key, $method, $payload, $commentId = null)
    {
        $this->query('INSERT IGNORE INTO book_telegram_outbox (event_key,method,payload,comment_id,available_at,created_at) VALUES (?,?,?,?,NOW(),NOW())', array($key,$method,json_encode($payload,JSON_UNESCAPED_UNICODE),$commentId));
    }

}
