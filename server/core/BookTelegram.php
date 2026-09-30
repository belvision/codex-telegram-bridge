<?php

class BookTelegram
{
    private $db;
    private $community;
    private $config;

    public function __construct($db = null, $config = null)
    {
        $this->db = $db ?: Database::connection();
        $this->config = $config === null ? Community::config() : $config;
        $this->community = new Community($this->db,$this->config);
    }

    public function api($method, $payload)
    {
        $curl = curl_init('https://api.telegram.org/bot' . $this->config['bot_token'] . '/' . $method);
        curl_setopt_array($curl,array(CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($payload,JSON_UNESCAPED_UNICODE),CURLOPT_HTTPHEADER=>array('Content-Type: application/json'),CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>8,CURLOPT_TIMEOUT=>$method==='getUpdates'?20:15));
        $raw = curl_exec($curl);
        $error = curl_errno($curl);
        curl_close($curl);
        $result = $raw !== false ? json_decode($raw,true) : null;
        if ($error || !is_array($result)) { throw new RuntimeException('telegram-network',0); }
        if (empty($result['ok'])) { throw new RuntimeException('telegram-api-' . (int)($result['error_code'] ?? 0) . '-retry-' . (int)($result['parameters']['retry_after'] ?? 30),(int)($result['error_code'] ?? 0)); }
        return $result['result'];
    }

    private function codexThreadMenu($page, $chatId)
    {
        $file = bridge_private_dir() . '/catalog.json';
        $rows = is_file($file) ? json_decode(file_get_contents($file), true) : null;
        if (!is_array($rows) || !$rows) { return null; }
        $size = 7;
        $pages = (int)ceil(count($rows) / $size);
        $page = max(0, min((int)$page, $pages - 1));
        $buttons = array();
        foreach (array_slice($rows, $page * $size, $size) as $row) {
            $buttons[] = array(array('text' => mb_substr($row['title'], 0, 48, 'UTF-8'), 'callback_data' => 'codex:select:' . $row['id']));
        }
        $navigation = array();
        if ($page > 0) { $navigation[] = array('text' => '⬅️', 'callback_data' => 'codex:page:' . ($page - 1)); }
        if ($page + 1 < $pages) { $navigation[] = array('text' => '➡️', 'callback_data' => 'codex:page:' . ($page + 1)); }
        if ($navigation) { $buttons[] = $navigation; }
        $buttons[] = array(array('text' => 'Все чаты', 'callback_data' => 'codex:select:all'));
        return array(
            'chat_id' => $chatId,
            'text' => 'Выберите один чат. Страница ' . ($page + 1) . '/' . $pages . '.',
            'reply_markup' => array('inline_keyboard' => $buttons)
        );
    }

    /** Persists the route/result before advancing Telegram's offset. One worker holds the process lock. */
    public function ingest($update)
    {
        $s = $this->community;
        $updateId = (int)$update['update_id'];
        $this->db->beginTransaction();
        try {
            if ($updateId < (int)$s->state('telegram_offset','0')) { $this->db->commit(); return; }
            $callback = $update['callback_query'] ?? null;
            $message = $update['message'] ?? ($callback['message'] ?? null);
            $from = $callback['from'] ?? ($message['from'] ?? null);
            $chatId = (string)($message['chat']['id'] ?? '');
            $userId = (string)($from['id'] ?? '');
            $owner = $chatId === (string)$this->config['owner_chat_id'] && $userId === (string)$this->config['owner_user_id'];
            $additionalFile = bridge_private_dir() . '/allowed-users.json';
            $additionalUsers = is_file($additionalFile) ? json_decode(file_get_contents($additionalFile), true) : array();
            if (!is_array($additionalUsers)) { $additionalUsers = array(); }
            $additional = ($this->config['bot_role'] ?? 'codex') === 'codex' && $chatId === $userId
                && in_array($userId, array_map('strval', $additionalUsers), true);
            $allowed = $message && ($message['chat']['type'] ?? '') === 'private' && ($owner || $additional);
            if ($allowed) {
                $role = $this->config['bot_role'] ?? 'codex';
                if ($role === 'codex') {
                    $callbackData = $callback['data'] ?? '';
                    $fastMenu = null;
                    if ($callback && preg_match('/^codex:(?:mode:single|page:([0-9]+))$/D', $callbackData, $menuMatch)) {
                        $fastMenu = $this->codexThreadMenu(isset($menuMatch[1]) ? (int)$menuMatch[1] : 0, $chatId);
                    }
                    if (!$callback && preg_match('/^\/(?:start|mode)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i', $message['text'] ?? '')) {
                        // Answer the blue Telegram menu button on the webhook request itself.
                        // The desktop is private and may be busy scanning Codex history.
                        $this->api('sendMessage', array(
                            'chat_id' => $chatId,
                            'text' => 'Выберите режим. Уведомления приходят только о результатах работы и ошибках.',
                            'reply_markup' => array('inline_keyboard' => array(
                                array(array('text' => 'Один чат', 'callback_data' => 'codex:mode:single')),
                                array(array('text' => 'Все чаты', 'callback_data' => 'codex:select:all'))
                            ))
                        ));
                    } elseif ($fastMenu) {
                        $this->api('sendMessage', $fastMenu);
                        $s->queuePayload('callback:' . $updateId, 'answerCallbackQuery', array('callback_query_id' => $callback['id']));
                    } elseif (!$callback || (preg_match('/^codex:(?:reply|mode:single|select:(?:all|[0-9a-f-]{36})|page:[0-9]+)$/D', $callback['data'] ?? '') && (string)($message['from']['id'] ?? '') === (string)$this->config['bot_id'])) {
                        $s->query('INSERT IGNORE INTO book_telegram_relay (update_id,payload,created_at) VALUES (?,?,NOW())',array($updateId,json_encode($update,JSON_UNESCAPED_UNICODE)));
                        if ($callback) { $s->queuePayload('callback:' . $updateId,'answerCallbackQuery',array('callback_query_id'=>$callback['id'],'text'=>'Открываю ответ в задачу…')); }
                    }
                }
            }
            $s->setState('telegram_offset',$updateId+1);
            $this->db->commit();
        } catch (Throwable $e) { $this->db->rollBack(); throw $e; }
    }

    public function flush($limit = 5)
    {
        $s = $this->community;
        for ($i=0; $i<$limit; $i++) {
            $row = $s->query("SELECT * FROM book_telegram_outbox WHERE status='pending' AND available_at<=NOW() ORDER BY id LIMIT 1")->fetch();
            if (!$row) { return; }
            $s->query("UPDATE book_telegram_outbox SET status='sending',attempts=attempts+1 WHERE id=?",array($row['id']));
            try {
                $sent = $this->api($row['method'],json_decode($row['payload'],true));
                $messageId = is_array($sent) ? ($sent['message_id'] ?? null) : null;
                $this->db->beginTransaction();
                if ($messageId && $row['comment_id']) { $s->query('INSERT IGNORE INTO book_telegram_routes VALUES (?,?)',array($messageId,$row['comment_id'])); }
                $s->query("UPDATE book_telegram_outbox SET status='sent',telegram_id=?,last_error=NULL WHERE id=?",array($messageId,$row['id']));
                $this->db->commit();
            } catch (Throwable $e) {
                if ($this->db->inTransaction()) { $this->db->rollBack(); }
                $retry = !$e->getCode() || $e->getCode() === 429 || $e->getCode() >= 500;
                $delay = min(3600,max(10,pow(2,min(10,(int)$row['attempts']))*10));
                if (preg_match('/retry-([0-9]+)/',$e->getMessage(),$match)) { $delay = max($delay,(int)$match[1]); }
                $s->query('UPDATE book_telegram_outbox SET status=?,available_at=?,last_error=? WHERE id=?',array($retry?'pending':'failed',date('Y-m-d H:i:s',time()+$delay),'telegram-' . (int)$e->getCode(),$row['id']));
                $s->setState('last_send_error',date('c') . ' telegram-' . (int)$e->getCode());
                if ($retry) { return; }
            }
        }
    }
}
