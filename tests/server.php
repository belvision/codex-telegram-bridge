<?php
// Offline transport test: SQLite adapts the few MySQL statements used by ingest.
require __DIR__ . '/../server/core/bootstrap.php';
class TestDatabase extends PDO {
    public function __construct() {
        parent::__construct('sqlite::memory:', null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC));
        $this->exec('CREATE TABLE codex_telegram_state (state_key TEXT PRIMARY KEY, state_value TEXT); CREATE TABLE codex_telegram_relay (update_id INTEGER PRIMARY KEY, payload TEXT, created_at TEXT); CREATE TABLE codex_telegram_outbox (event_key TEXT PRIMARY KEY, method TEXT, payload TEXT, comment_id INTEGER, available_at TEXT, created_at TEXT);');
    }
    public function prepare(string $query, array $options = []): PDOStatement|false {
        $query = str_replace(array('INSERT IGNORE', 'NOW()', 'ON DUPLICATE KEY UPDATE state_value=VALUES(state_value)'), array('INSERT OR IGNORE', "datetime('now')", 'ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value'), $query);
        return parent::prepare($query, $options);
    }
}
class TestTelegram extends BookTelegram {
    public $sent = array();
    public function api($method, $payload) { $this->sent[] = array($method, $payload); return array('message_id' => count($this->sent)); }
}
function check($condition, $message) { if (!$condition) { throw new RuntimeException($message); } }
$dir = sys_get_temp_dir() . '/codex-telegram-test-' . bin2hex(random_bytes(8));
mkdir($dir, 0700);
putenv('CODEX_TELEGRAM_PRIVATE_DIR=' . $dir);
try {
    file_put_contents($dir . '/allowed-users.json', '[2]');
    $db = new TestDatabase();
    $bot = new TestTelegram($db, array('owner_user_id' => 1, 'owner_chat_id' => 1, 'bot_id' => 9, 'bot_role' => 'codex'));
    $message = function ($id, $user, $type = 'private', $text = 'hello') {
        return array('update_id' => $id, 'message' => array('message_id' => $id, 'from' => array('id' => $user), 'chat' => array('id' => $user, 'type' => $type), 'text' => $text));
    };
    $bot->ingest($message(1, 3));
    $bot->ingest($message(2, 1, 'group'));
    check((int)$db->query('SELECT COUNT(*) FROM codex_telegram_relay')->fetchColumn() === 0, 'unauthorized message entered relay');
    $bot->ingest($message(3, 1));
    $bot->ingest($message(3, 1));
    $bot->ingest($message(4, 2));
    check((int)$db->query('SELECT COUNT(*) FROM codex_telegram_relay')->fetchColumn() === 2, 'authorized messages or deduplication failed');
    $bot->ingest($message(5, 1, 'private', '/start'));
    check(count($bot->sent) === 1 && $bot->sent[0][1]['chat_id'] === '1', 'fast menu failed');
    $bot->ingest(array('update_id' => 6, 'callback_query' => array('id' => 'fixture', 'from' => array('id' => 2), 'data' => 'codex:select:all', 'message' => array('from' => array('id' => 9), 'chat' => array('id' => 2, 'type' => 'private')))));
    check((int)$db->query('SELECT COUNT(*) FROM codex_telegram_relay')->fetchColumn() === 3, 'callback route failed');
    echo "Server authorization, deduplication, fast menu and callback checks passed.\n";
} finally {
    unlink($dir . '/allowed-users.json');
    rmdir($dir);
}
