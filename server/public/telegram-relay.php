<?php
require_once __DIR__ . '/../core/bootstrap.php';
// The only public transport endpoint. No session, cookie authentication or query-string secrets.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo '{"ok":false}'; exit; }
$relayConfig = bridge_private_dir() . '/config.php';
$config = is_file($relayConfig) ? require $relayConfig : Community::config();
$key = $_SERVER['HTTP_X_BOOK_RELAY_KEY'] ?? '';
if (empty($config['relay_key']) || !is_string($key) || !hash_equals($config['relay_key'],$key)) { http_response_code(403); echo '{"ok":false}'; exit; }
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0)>65536) { http_response_code(413); exit; }
$body = json_decode(file_get_contents('php://input',false,null,0,65537),true);
try {
    $s = new Community(null, $config);
    if (($body['action'] ?? '') === 'catalog') {
        $threads = $body['threads'] ?? null;
        if (!is_array($threads) || count($threads) > 250) { throw new InvalidArgumentException(); }
        foreach ($threads as $thread) {
            if (!is_array($thread) || !preg_match('/^[0-9a-f-]{36}$/D', $thread['id'] ?? '')
                || !is_string($thread['title'] ?? null) || mb_strlen($thread['title'], 'UTF-8') > 150) { throw new InvalidArgumentException(); }
        }
        $destination = bridge_private_dir() . '/catalog.json';
        $temporary = $destination . '.' . bin2hex(random_bytes(6));
        if (file_put_contents($temporary, json_encode($threads, JSON_UNESCAPED_UNICODE)) === false) { throw new RuntimeException(); }
        chmod($temporary, 0600);
        if (!rename($temporary, $destination)) { unlink($temporary); throw new RuntimeException(); }
        echo '{"ok":true}';
    } elseif (($body['action'] ?? '') === 'menu') {
        $telegram = new BookTelegram(null, $config);
        $oldScopes = array(
            array('type' => 'default'),
            array('type' => 'chat', 'chat_id' => (int)$config['owner_chat_id'])
        );
        foreach ($oldScopes as $scope) {
            foreach (array('', 'ru', 'en', 'be') as $language) {
                if ($scope['type'] === 'default' && $language === '') { continue; }
                $params = array('scope' => $scope);
                if ($language !== '') { $params['language_code'] = $language; }
                $telegram->api('deleteMyCommands', $params);
            }
        }
        $commands = array(
            array('command' => 'start', 'description' => 'Выбрать режим'),
            array('command' => 'mode', 'description' => 'Один чат или все чаты')
        );
        $telegram->api('setMyCommands', array('commands' => $commands));
        foreach (array('', 'ru', 'en', 'be') as $language) {
            $params = array('commands' => $commands, 'scope' => array('type' => 'chat', 'chat_id' => (int)$config['owner_chat_id']));
            if ($language !== '') { $params['language_code'] = $language; }
            $telegram->api('setMyCommands', $params);
        }
        echo '{"ok":true}';
    } elseif (($body['action'] ?? '') === 'ack') {
        $ids = $body['update_ids'] ?? null;
        if (!is_array($ids) || count($ids)>100) { throw new InvalidArgumentException(); }
        foreach ($ids as $id) { if (!is_int($id) || $id<0) { throw new InvalidArgumentException(); } }
        if ($ids) { $s->query('UPDATE book_telegram_relay SET acked_at=NOW() WHERE acked_at IS NULL AND update_id IN (' . implode(',',array_fill(0,count($ids),'?')) . ')',$ids); }
        $s->setState('relay_last_ack',date('c'));
        echo '{"ok":true}';
    } elseif (($body['action'] ?? '') === 'poll') {
        $rows = $s->query('SELECT payload FROM book_telegram_relay WHERE acked_at IS NULL ORDER BY update_id LIMIT 100')->fetchAll();
        $updates = array_map(function($row) { return json_decode($row['payload'],true); },$rows);
        $s->setState('relay_last_poll',date('c'));
        echo json_encode(array('ok'=>true,'updates'=>$updates),JSON_UNESCAPED_UNICODE);
    } else { throw new InvalidArgumentException(); }
} catch (InvalidArgumentException $e) { http_response_code(400); echo '{"ok":false}'; }
catch (Throwable $e) { http_response_code(503); echo '{"ok":false}'; error_log('book-relay-failed'); }
