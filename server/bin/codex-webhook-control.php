<?php
require_once __DIR__ . '/../core/bootstrap.php';
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$action = $argv[1] ?? 'status';
if (!in_array($action, array('status', 'enable', 'disable', 'commands'), true)) { fwrite(STDERR, "Use status, enable, disable or commands.\n"); exit(2); }
$telegram = new BookTelegram();
if ($action === 'commands') {
    $config = Community::config();
    $scopes = array(
        'default' => array('type' => 'default'),
        'private' => array('type' => 'all_private_chats'),
        'chat' => array('type' => 'chat', 'chat_id' => (int)$config['owner_chat_id'])
    );
    $result = array();
    foreach ($scopes as $name => $scope) {
        foreach (array('', 'ru', 'en', 'be') as $language) {
            $params = array('scope' => $scope);
            if ($language !== '') { $params['language_code'] = $language; }
            $commands = $telegram->api('getMyCommands', $params);
            $result[$name . ($language !== '' ? ':' . $language : '')] = array_map(function($item) { return $item['command']; }, $commands);
        }
    }
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), "\n";
    exit;
}
if ($action === 'enable') {
    $secret = trim(file_get_contents(bridge_private_dir() . '/webhook-secret'));
    if (!preg_match('/^[a-f0-9]{64}$/D', $secret)) { throw new RuntimeException('webhook-secret-invalid'); }
    $telegram->api('setWebhook', array(
        'url' => Community::config()['webhook_url'],
        'secret_token' => $secret,
        'max_connections' => 1,
        'allowed_updates' => array('message', 'callback_query'),
        'drop_pending_updates' => false
    ));
} elseif ($action === 'disable') {
    $telegram->api('deleteWebhook', array('drop_pending_updates' => false));
}
$info = $telegram->api('getWebhookInfo', array());
echo json_encode(array(
    'url' => $info['url'] ?? '',
    'pending_update_count' => $info['pending_update_count'] ?? 0,
    'last_error_date' => $info['last_error_date'] ?? null,
    'last_error_message' => $info['last_error_message'] ?? null
), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), "\n";
